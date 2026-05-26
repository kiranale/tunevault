/**
 * services/validation-suite.js — Full-coverage validation suite orchestrator.
 *
 * Owns: Running all validation checks sequentially, appending results to DB,
 *       computing summary, finishing the run.
 * Does NOT own: DB persistence (db/validation-runs.js), HTTP endpoints
 *               (routes/validation-suite.js), health check execution (server.js).
 *
 * Design:
 *   - Each check is a named async function returning { status, detail, duration_ms }.
 *   - status: 'pass' | 'fail' | 'skip' | 'error'
 *   - All checks run sequentially (not parallel) to avoid overwhelming the DB/agent.
 *   - Errors in individual checks are caught and recorded as 'error' status — the
 *     suite always completes and finishes the run.
 *   - On fail/error: captureFailure() fires async so a debug bundle is always available.
 */

'use strict';

const pool    = require('../db/index');
const runDb   = require('../db/validation-runs');
const { decrypt } = require('../crypto-utils');
const { captureFailure } = require('./failure-capture');

// ── Timing helper ────────────────────────────────────────────────────────────

async function timed(fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, duration_ms: Date.now() - start };
  } catch (err) {
    return { status: 'error', detail: err.message, duration_ms: Date.now() - start };
  }
}

// ── Connection loader ─────────────────────────────────────────────────────────

async function loadConnection(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT oc.id, oc.name, oc.host, oc.port, oc.service_name,
            oc.username, oc.encrypted_password, oc.connection_type,
            oc.proxy_url, oc.proxy_api_key_enc, oc.connectivity_mode,
            oc.ssh_db_host, oc.ssh_db_user, oc.ssh_db_key_enc,
            oc.ssh_oracle_home, oc.ssh_oracle_sid,
            at.last_heartbeat, at.agent_version, at.tunnel_status
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE oc.id = $1 AND oc.user_id = $2`,
    [connectionId, userId]
  );
  return rows[0] || null;
}

// ── Category: Agent Connectivity ──────────────────────────────────────────────

async function checkHeartbeat(conn) {
  if (conn.connection_type !== 'proxy') {
    return { status: 'skip', detail: 'Non-agent connection — heartbeat not applicable' };
  }
  if (!conn.last_heartbeat) {
    return { status: 'fail', detail: 'No heartbeat recorded — agent has never connected' };
  }
  const ageMs = Date.now() - new Date(conn.last_heartbeat).getTime();
  if (ageMs > 120_000) {
    return { status: 'fail', detail: `Last heartbeat was ${Math.round(ageMs / 1000)}s ago (threshold: 120s)` };
  }
  return { status: 'pass', detail: `Agent online — heartbeat ${Math.round(ageMs / 1000)}s ago, v${conn.agent_version || '?'}` };
}

async function checkAgentVersion(conn) {
  if (conn.connection_type !== 'proxy') {
    return { status: 'skip', detail: 'Non-agent connection' };
  }
  if (!conn.agent_version) {
    return { status: 'fail', detail: 'Agent version unknown' };
  }
  // Minimum version for full feature set
  const MIN_VER = '6.1.0';
  const parse = v => (v || '0').replace(/[^0-9.]/g, '').split('.').map(Number);
  const [am, ami, ap] = parse(conn.agent_version);
  const [bm, bmi, bp] = parse(MIN_VER);
  const ok = am > bm || (am === bm && (ami > bmi || (ami === bmi && ap >= bp)));
  if (!ok) {
    return { status: 'fail', detail: `Agent v${conn.agent_version} below minimum v${MIN_VER} — upgrade recommended` };
  }
  return { status: 'pass', detail: `Agent v${conn.agent_version} ≥ minimum v${MIN_VER}` };
}

async function checkTunnelStatus(conn) {
  if (conn.connection_type !== 'proxy') {
    return { status: 'skip', detail: 'Non-agent connection' };
  }
  const s = conn.tunnel_status;
  if (!s || s === 'pending') {
    return { status: 'fail', detail: `Tunnel status: ${s || 'none'} — agent not yet registered` };
  }
  if (s === 'active' || s === 'confirmed' || s === 'provisioned') {
    return { status: 'pass', detail: `Tunnel status: ${s}` };
  }
  return { status: 'fail', detail: `Tunnel status: ${s}` };
}

// ── Category: Oracle DB Connectivity ─────────────────────────────────────────

async function checkDbViaProxy(conn) {
  if (conn.connection_type !== 'proxy' || !conn.proxy_url) {
    return { status: 'skip', detail: 'Non-proxy connection — skip proxy DB check' };
  }
  try {
    const apiKey = conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null;
    if (!apiKey) return { status: 'skip', detail: 'No proxy API key configured' };

    const proxyUrl = conn.proxy_url.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let resp;
    try {
      resp = await fetch(`${proxyUrl}/api/test`, {
        headers: { 'X-Api-Key': apiKey },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (resp.status === 410) {
      return { status: 'pass', detail: `Proxy agent reachable (HTTP 410 expected test response)` };
    }
    return { status: 'fail', detail: `Proxy returned unexpected HTTP ${resp.status}` };
  } catch (err) {
    return { status: 'fail', detail: `Proxy unreachable: ${err.message}` };
  }
}

async function checkDbHealthPack(conn, runHealthCheck) {
  if (typeof runHealthCheck !== 'function') {
    return { status: 'skip', detail: 'Health check runner not available in this context' };
  }
  // We use the existing HC results rather than re-triggering a full run
  // (which takes 30–120s). Pull latest health_check row.
  const { rows } = await pool.query(
    `SELECT id, overall_score, status, created_at
     FROM health_checks
     WHERE connection_id = $1
       AND is_demo = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [conn.id]
  );
  if (!rows.length) {
    return { status: 'skip', detail: 'No health check runs found for this connection — run a health check first' };
  }
  const hc = rows[0];
  const ageMin = Math.round((Date.now() - new Date(hc.created_at).getTime()) / 60_000);
  if (hc.status === 'error') {
    return { status: 'fail', detail: `Latest health check failed (run #${hc.id}, ${ageMin}m ago)` };
  }
  const score = hc.overall_score;
  const detail = `Health score ${score}/100 · run #${hc.id} · ${ageMin}m ago`;
  return { status: score >= 50 ? 'pass' : 'fail', detail };
}

async function checkCheckResults(conn) {
  // Verify check_results were written for the latest run
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM check_results cr
     JOIN health_checks hc ON hc.id = cr.health_check_id
     WHERE hc.connection_id = $1 AND hc.is_demo = false
     ORDER BY hc.created_at DESC
     LIMIT 1`,
    [conn.id]
  );
  // Subquery to get latest run's check count
  const { rows: r2 } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM check_results
     WHERE health_check_id = (
       SELECT id FROM health_checks WHERE connection_id = $1 AND is_demo = false
       ORDER BY created_at DESC LIMIT 1
     )`,
    [conn.id]
  );
  const cnt = parseInt(r2[0]?.cnt || 0, 10);
  if (cnt === 0) {
    return { status: 'skip', detail: 'No check_results rows — run a health check first' };
  }
  return { status: 'pass', detail: `${cnt} check_result rows in latest run` };
}

// ── Category: DB Ops read-only endpoints ─────────────────────────────────────

async function checkDbOpsSQL(conn, opKey, opLabel) {
  try {
    const { runOp, getOpCatalog } = require('./db-ops-executor');
    const catalog = getOpCatalog();
    const op = catalog[opKey];
    if (!op) return { status: 'skip', detail: `Op ${opKey} not in catalog` };
    if (op.type !== 'sql' || op.destructive) {
      return { status: 'skip', detail: `Skipping ${opKey} — not a safe read-only SQL op` };
    }

    const password = conn.encrypted_password ? decrypt(conn.encrypted_password) : null;

    const connParams = {
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: conn.service_name,
      username:    conn.username,
      password,
      proxyUrl:    conn.proxy_url,
      proxyApiKey: conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null,
      connectionType: conn.connection_type,
    };

    const result = await runOp({ opKey, connParams, confirmed: false, params: {}, initiatedBy: 'validation_suite' });

    if (!result.ok) {
      // 'Oracle client not available' is a skip, not a failure
      if (result.error && result.error.includes('Oracle client')) {
        return { status: 'skip', detail: `${opLabel}: Oracle client not loaded in this environment` };
      }
      return { status: 'fail', detail: `${opLabel}: ${result.error || 'unknown error'}` };
    }

    const rowCount = Array.isArray(result.rows) ? result.rows.length : '?';
    return { status: 'pass', detail: `${opLabel}: ${rowCount} row(s) returned` };
  } catch (err) {
    return { status: 'error', detail: `${opLabel} failed: ${err.message}` };
  }
}

// ── Category: EBS Checks ──────────────────────────────────────────────────────

async function checkEbsDetected(conn) {
  // Check if latest HC detected EBS (ebs_summary present)
  const { rows } = await pool.query(
    `SELECT ebs_summary, check_results.category
     FROM health_checks hc
     LEFT JOIN check_results ON check_results.health_check_id = hc.id
       AND check_results.category = 'ebs_operations'
     WHERE hc.connection_id = $1 AND hc.is_demo = false
     ORDER BY hc.created_at DESC
     LIMIT 1`,
    [conn.id]
  );
  if (!rows.length) return { status: 'skip', detail: 'No health check data available' };
  const ebsSummary = rows[0].ebs_summary;
  if (!ebsSummary) return { status: 'skip', detail: 'EBS not detected on this connection — EBS checks N/A' };
  return { status: 'pass', detail: 'EBS detected on this connection' };
}

async function checkEbsChecksExist(conn) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM check_results cr
     JOIN health_checks hc ON hc.id = cr.health_check_id
     WHERE hc.connection_id = $1 AND hc.is_demo = false
       AND cr.category = 'ebs_operations'
     ORDER BY hc.created_at DESC LIMIT 1`,
    [conn.id]
  );
  // proper subquery
  const { rows: r2 } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM check_results
     WHERE health_check_id = (
       SELECT id FROM health_checks WHERE connection_id = $1 AND is_demo = false
       ORDER BY created_at DESC LIMIT 1
     ) AND category = 'ebs_operations'`,
    [conn.id]
  );
  const cnt = parseInt(r2[0]?.cnt || 0, 10);
  if (cnt === 0) return { status: 'skip', detail: 'No EBS check results — EBS not detected or not yet run' };
  return { status: 'pass', detail: `${cnt} EBS check result rows in latest run` };
}

// ── Category: Credential Vault ────────────────────────────────────────────────

async function checkCredentialVault(conn, credType) {
  try {
    const { rows } = await pool.query(
      `SELECT credential_type, username, encrypted_value, iv, auth_tag
       FROM ebs_credentials
       WHERE connection_id = $1 AND credential_type = $2
       LIMIT 1`,
      [conn.id, credType]
    );
    if (!rows.length) {
      return { status: 'skip', detail: `${credType} credential not stored — vault empty for this type` };
    }
    const row = rows[0];
    // Verify decrypt succeeds without logging plaintext
    const encStr = `${row.iv}:${row.auth_tag}:${row.encrypted_value}`;
    const decrypted = decrypt(encStr);
    if (!decrypted || decrypted.length === 0) {
      return { status: 'fail', detail: `${credType} credential decrypt produced empty result` };
    }
    // Log access to credential_access_log
    await pool.query(
      `INSERT INTO credential_access_log (connection_id, credential_type, action, user_id)
       VALUES ($1, $2, 'validation_suite_verify', NULL)`,
      [conn.id, credType]
    );
    return { status: 'pass', detail: `${credType} credential decrypts successfully (${row.username})` };
  } catch (err) {
    return { status: 'error', detail: `${credType} vault verify error: ${err.message}` };
  }
}

// ── Category: SSH Connectivity ────────────────────────────────────────────────

async function checkSshProfiles(conn) {
  const { rows } = await pool.query(
    `SELECT role, ssh_host, last_test_status
     FROM connection_ssh_profiles
     WHERE connection_id = $1
     ORDER BY role`,
    [conn.id]
  );
  if (!rows.length) return { status: 'skip', detail: 'No SSH profiles configured for this connection' };
  const roles = rows.map(r => `${r.role}(${r.last_test_status || 'untested'})`).join(', ');
  const failing = rows.filter(r => r.last_test_status === 'fail');
  if (failing.length) {
    return { status: 'fail', detail: `SSH profiles: ${roles} — ${failing.length} failing` };
  }
  return { status: 'pass', detail: `SSH profiles configured: ${roles}` };
}

async function checkSshSqlplusPath(conn) {
  if (!['ssh_sqlplus', 'both'].includes(conn.connectivity_mode)) {
    return { status: 'skip', detail: `SSH sqlplus not configured (mode: ${conn.connectivity_mode || 'tns'})` };
  }
  if (!conn.ssh_db_host || !conn.ssh_db_user) {
    return { status: 'fail', detail: 'SSH sqlplus mode set but ssh_db_host/ssh_db_user not configured' };
  }
  // Verify we can run a trivial query via oracle-runner SSH path
  try {
    const oracleRunner = require('./oracle-runner');
    const connParams = {
      id: conn.id,
      connectivity_mode: conn.connectivity_mode,
      ssh_db_host: conn.ssh_db_host,
      ssh_db_user: conn.ssh_db_user,
      ssh_db_key_enc: conn.ssh_db_key_enc,
      ssh_oracle_home: conn.ssh_oracle_home,
      ssh_oracle_sid: conn.ssh_oracle_sid,
    };
    const rows = await oracleRunner.runQuery(connParams, "SELECT 'ssh_ok' AS chk FROM dual");
    if (rows && rows.length && rows[0].CHK === 'ssh_ok') {
      return { status: 'pass', detail: `SSH sqlplus path verified (${conn.ssh_db_host} as ${conn.ssh_db_user})` };
    }
    return { status: 'fail', detail: 'SSH sqlplus query returned unexpected result' };
  } catch (err) {
    return { status: 'fail', detail: `SSH sqlplus path error: ${err.message}` };
  }
}

// ── Category: TNS Topology ────────────────────────────────────────────────────

/**
 * TNS topology consistency check.
 * Passes if every registered service has a corresponding V$ACTIVE_SERVICES entry
 * and no patch-mode services are active.
 * Failure links to /connections/:id/tns-topology for live analysis.
 *
 * Uses the most recent snapshot if available (no live Oracle query here —
 * the live query path is on-demand from the topology page itself).
 */
async function checkTnsTopologyConsistency(conn) {
  try {
    // Pull latest snapshot for this connection
    const { rows } = await pool.query(
      `SELECT id, snapshot_data, service_names, patch_services,
              recommended_svc, pdb_count, created_at
       FROM tns_topology_snapshots
       WHERE connection_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [conn.id]
    );

    if (!rows.length) {
      return {
        status: 'skip',
        detail: `No TNS topology snapshot — visit /connections/${conn.id}/tns-topology to run analysis`,
      };
    }

    const snap = rows[0];
    const patchSvcs = snap.patch_services || [];
    const serviceNames = snap.service_names || [];
    const ageMin = Math.round((Date.now() - new Date(snap.created_at).getTime()) / 60_000);

    // Fail: patch-mode services are active
    if (patchSvcs.length > 0) {
      return {
        status: 'fail',
        detail: `ADOP patch-mode services active: ${patchSvcs.join(', ')} — do not connect until cutover completes. See /connections/${conn.id}/tns-topology`,
      };
    }

    // Warn: snapshot stale (>60 min old)
    if (ageMin > 60) {
      return {
        status: 'skip',
        detail: `Topology snapshot is ${ageMin}m old — refresh at /connections/${conn.id}/tns-topology`,
      };
    }

    // No recommended service
    if (!snap.recommended_svc) {
      return {
        status: 'fail',
        detail: `No recommended service found in topology — all services blocked or unavailable. See /connections/${conn.id}/tns-topology`,
      };
    }

    return {
      status: 'pass',
      detail: `TNS topology consistent — ${serviceNames.length} service(s), recommended: ${snap.recommended_svc} (snapshot ${ageMin}m old)`,
    };
  } catch (err) {
    return { status: 'error', detail: `TNS topology check error: ${err.message}` };
  }
}

// ── Category: Scheduler & Monitoring ─────────────────────────────────────────

async function checkScheduler(conn) {
  const { rows } = await pool.query(
    `SELECT enabled, cadence_minutes, next_run_at, alert_email
     FROM connection_schedules
     WHERE connection_id = $1`,
    [conn.id]
  );
  if (!rows.length) return { status: 'skip', detail: 'No monitoring schedule configured' };
  const s = rows[0];
  if (!s.enabled) return { status: 'skip', detail: `Schedule exists but is disabled (${s.cadence_minutes}m cadence)` };
  return { status: 'pass', detail: `Schedule active: every ${s.cadence_minutes}m, alerts to ${s.alert_email || 'none'}` };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the full validation suite for a connection.
 *
 * @param {number} runId         - validation_runs row id (already created in 'running' state)
 * @param {number} connectionId
 * @param {number} userId
 * @param {Function} [runHealthCheck] - optional: app.locals.runHealthCheckForConnection
 */
async function runSuite(runId, connectionId, userId, runHealthCheck) {
  const conn = await loadConnection(connectionId, userId);
  if (!conn) {
    await runDb.finishRun(runId, 'error', { error: 'Connection not found or not owned by user' });
    return;
  }

  // Defines the full set of checks.
  // Each entry: { category, name, fn }
  const checks = [
    // ── Agent Connectivity
    { category: 'Agent Connectivity', name: 'Heartbeat sanity',    fn: () => checkHeartbeat(conn) },
    { category: 'Agent Connectivity', name: 'Agent version',       fn: () => checkAgentVersion(conn) },
    { category: 'Agent Connectivity', name: 'Tunnel status',       fn: () => checkTunnelStatus(conn) },
    { category: 'Agent Connectivity', name: 'Proxy /api/test',    fn: () => checkDbViaProxy(conn) },

    // ── Oracle DB — Health Pack
    { category: 'Health Pack',        name: 'Latest HC run status',    fn: () => checkDbHealthPack(conn, runHealthCheck) },
    { category: 'Health Pack',        name: 'Check results written',   fn: () => checkCheckResults(conn) },

    // ── DB Ops — read-only SQL probes (keys match OP_CATALOG in db-ops-executor.js)
    { category: 'DB Ops',             name: 'Instance status',         fn: () => checkDbOpsSQL(conn, 'instance.status',    'Instance status') },
    { category: 'DB Ops',             name: 'Tablespace usage',        fn: () => checkDbOpsSQL(conn, 'tablespace.usage',   'Tablespace usage') },
    { category: 'DB Ops',             name: 'Active sessions',         fn: () => checkDbOpsSQL(conn, 'sessions.active',    'Active sessions') },
    { category: 'DB Ops',             name: 'Memory SGA/PGA',          fn: () => checkDbOpsSQL(conn, 'memory.sga_pga',     'Memory SGA/PGA') },
    { category: 'DB Ops',             name: 'UNDO statistics',         fn: () => checkDbOpsSQL(conn, 'undo.status',        'UNDO status') },
    { category: 'DB Ops',             name: 'Invalid objects',         fn: () => checkDbOpsSQL(conn, 'objects.invalid',    'Invalid objects') },
    { category: 'DB Ops',             name: 'Scheduler jobs',          fn: () => checkDbOpsSQL(conn, 'scheduler.running',  'Scheduler jobs') },

    // ── EBS Checks
    { category: 'EBS',                name: 'EBS detected',            fn: () => checkEbsDetected(conn) },
    { category: 'EBS',                name: 'EBS check results',       fn: () => checkEbsChecksExist(conn) },

    // ── Credential Vault
    { category: 'Credential Vault',   name: 'APPS credential',         fn: () => checkCredentialVault(conn, 'apps') },
    { category: 'Credential Vault',   name: 'SYSTEM credential',       fn: () => checkCredentialVault(conn, 'system') },
    { category: 'Credential Vault',   name: 'WebLogic Admin credential',fn: () => checkCredentialVault(conn, 'weblogic_admin') },
    { category: 'Credential Vault',   name: 'SYSADMIN credential',     fn: () => checkCredentialVault(conn, 'sysadmin_user') },

    // ── SSH Paths
    { category: 'SSH Paths',          name: 'SSH profiles configured', fn: () => checkSshProfiles(conn) },
    { category: 'SSH Paths',          name: 'SSH sqlplus path',        fn: () => checkSshSqlplusPath(conn) },

    // ── TNS Topology
    { category: 'TNS Topology',       name: 'TNS topology consistent',  fn: () => checkTnsTopologyConsistency(conn) },

    // ── Monitoring
    { category: 'Monitoring',         name: 'Monitoring schedule',     fn: () => checkScheduler(conn) },
  ];

  let passed  = 0;
  let failed  = 0;
  let skipped = 0;
  let errors  = 0;
  const suiteStart = Date.now();

  for (const check of checks) {
    let result;
    try {
      result = await timed(check.fn);
    } catch (err) {
      result = { status: 'error', detail: err.message, duration_ms: 0 };
    }

    const row = {
      category:    check.category,
      name:        check.name,
      status:      result.status,
      duration_ms: result.duration_ms || 0,
      detail:      result.detail || '',
      bundle_id:   null, // populated below for fail/error
    };

    // Capture debug bundle for every failure — fire-and-forget, never blocks the suite
    if (result.status === 'fail' || result.status === 'error') {
      captureFailure({
        error:        new Error(result.detail || result.status),
        checkId:      `validation:${check.name.replace(/\s+/g, '_')}`,
        connectionId: conn.id,
        source:       'validation_suite',
        contextJson:  { category: check.category, run_id: runId },
      }).then(bundleId => {
        // Stitch bundle_id into the row for the UI (best-effort, non-blocking)
        if (bundleId) {
          row.bundle_id = bundleId;
        }
      }).catch(() => {});
    }

    // Persist each result as we go — UI polls and shows live progress
    await runDb.appendResult(runId, row);

    if (result.status === 'pass')  passed++;
    else if (result.status === 'fail' || result.status === 'error') { failed++; if (result.status === 'error') errors++; }
    else skipped++;
  }

  const totalMs = Date.now() - suiteStart;
  const overallStatus = failed > 0 ? (passed > 0 ? 'partial' : 'fail') : 'pass';

  const summary = {
    passed,
    failed,
    skipped,
    errors,
    total:       checks.length,
    duration_ms: totalMs,
  };

  await runDb.finishRun(runId, overallStatus, summary);
  console.log(`[validation-suite] run #${runId} finished: ${overallStatus} (${passed}p/${failed}f/${skipped}s) in ${totalMs}ms`);
}

module.exports = { runSuite };
