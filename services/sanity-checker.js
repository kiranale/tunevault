/**
 * services/sanity-checker.js — Post-bounce service validation engine.
 *
 * Owns: runEbsSanityCheck() + runDbSanityCheck() — read-only validation suites.
 * Does NOT own: SSH session lifecycle (ssh-executor.js), Oracle connections (oracle-client.js),
 *               credential storage (db/ssh-targets.js), HTTP routing.
 *
 * Each check returns: { id, label, status: 'ok'|'warn'|'crit'|'error'|'skip', value, evidence }
 * Suite result: { ok, tier, checks[], summary: { ok, warn, crit, error, skip }, elapsed_ms, ran_at }
 */

'use strict';

const sshExec = require('./ssh-executor');

// ─── EBS (Application Tier) checks ───────────────────────────────────────────
// Uses existing SSH command keys already in the COMMAND_WHITELIST.

const EBS_SANITY_CHECKS = [
  {
    id: 'ebs.san.fndcrm',
    label: 'ICM (FNDCRM) process',
    type: 'ssh',
    commandKey: 'ebs.cm.fndcrm',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_RUNNING') || !stdout.trim()) {
        return { status: 'crit', value: 'Down', evidence: 'FNDCRM process not found' };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.includes('NOT_RUNNING'));
      if (!lines.length) return { status: 'crit', value: 'Down', evidence: 'No FNDCRM process found' };
      return { status: 'ok', value: 'Running', evidence: lines[0].slice(0, 100) };
    },
  },
  {
    id: 'ebs.san.fndlibr',
    label: 'CM worker processes (FNDLIBR)',
    type: 'ssh',
    commandKey: 'ebs.cm.fndlibr_count',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) return { status: 'error', value: 'No output', evidence: 'SSH error or no output' };
      const count = parseInt(stdout.trim().split('\n')[0], 10);
      if (isNaN(count)) return { status: 'warn', value: 'Unknown', evidence: stdout.slice(0, 80) };
      if (count === 0) return { status: 'crit', value: '0 workers', evidence: 'No FNDLIBR worker processes running' };
      if (count < 3) return { status: 'warn', value: `${count} worker${count > 1 ? 's' : ''}`, evidence: `Only ${count} FNDLIBR worker(s) running` };
      return { status: 'ok', value: `${count} workers`, evidence: `${count} FNDLIBR processes active` };
    },
  },
  {
    id: 'ebs.san.opp',
    label: 'Output Post Processor (OPP)',
    type: 'ssh',
    commandKey: 'ebs.cm.opp',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) return { status: 'warn', value: 'Unknown', evidence: 'No output from OPP check' };
      const countMatch = stdout.match(/---\s*OPP Processes\s*---\s*\n(\d+)/i);
      const count = countMatch ? parseInt(countMatch[1], 10) : null;
      if (count === 0) return { status: 'crit', value: 'Down', evidence: 'No OPP processes running' };
      if (count !== null) return { status: 'ok', value: `${count} OPP process${count > 1 ? 'es' : ''}`, evidence: 'OPP running' };
      return { status: 'warn', value: 'Uncertain', evidence: stdout.slice(0, 100) };
    },
  },
  {
    id: 'ebs.san.wls.adminserver',
    label: 'WLS AdminServer',
    type: 'ssh',
    commandKey: 'wls.adminserver.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      return parseAdmanagedSanity(stdout, stderr, exitCode);
    },
  },
  {
    id: 'ebs.san.wls.oacore',
    label: 'WLS OACore managed server',
    type: 'ssh',
    commandKey: 'wls.oacore.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      return parseAdmanagedSanity(stdout, stderr, exitCode);
    },
  },
  {
    id: 'ebs.san.wls.oafm',
    label: 'WLS OAFM managed server',
    type: 'ssh',
    commandKey: 'wls.oafm.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      return parseAdmanagedSanity(stdout, stderr, exitCode);
    },
  },
  {
    id: 'ebs.san.wls.forms',
    label: 'WLS Forms managed server',
    type: 'ssh',
    commandKey: 'wls.forms.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      return parseAdmanagedSanity(stdout, stderr, exitCode);
    },
  },
  {
    id: 'ebs.san.apache',
    label: 'Apache / OHS listener',
    type: 'ssh',
    commandKey: 'ebs.apache.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) return { status: 'error', value: 'No output', evidence: 'SSH error or empty response' };
      const lower = stdout.toLowerCase();
      if (lower.includes('running') || lower.includes('alive') || lower.includes('started') || exitCode === 0) {
        return { status: 'ok', value: 'Running', evidence: stdout.slice(0, 120) };
      }
      if (lower.includes('stopped') || lower.includes('not running') || lower.includes('dead')) {
        return { status: 'crit', value: 'Down', evidence: stdout.slice(0, 120) };
      }
      return { status: 'warn', value: 'Uncertain', evidence: stdout.slice(0, 120) };
    },
  },
  {
    id: 'ebs.san.appslistener',
    label: 'Apps Listener (FNDFS/FNDSM)',
    type: 'ssh',
    commandKey: 'ebs.appslistener.status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) return { status: 'error', value: 'No output', evidence: 'SSH error or empty response' };
      const lower = stdout.toLowerCase();
      if (lower.includes('fndfs') && lower.includes('fndsm')) {
        return { status: 'ok', value: 'Running', evidence: 'FNDFS and FNDSM services registered' };
      }
      if (lower.includes('no services') || lower.includes('status failed') || exitCode !== 0) {
        return { status: 'crit', value: 'Down', evidence: stdout.slice(0, 120) };
      }
      if (lower.includes('ready') || lower.includes('up')) {
        return { status: 'ok', value: 'Running', evidence: stdout.slice(0, 100) };
      }
      return { status: 'warn', value: 'Uncertain', evidence: stdout.slice(0, 120) };
    },
  },
];

// ─── Parser shared by WLS managed server checks ───────────────────────────────

function parseAdmanagedSanity(stdout, stderr, exitCode) {
  if (!stdout || !stdout.trim()) return { status: 'error', value: 'No output', evidence: 'SSH error or no output from admanagedsrvctl' };
  const lower = stdout.toLowerCase();
  if (lower.includes('running')) return { status: 'ok', value: 'Running', evidence: stdout.slice(0, 100) };
  if (lower.includes('stopped') || lower.includes('not running') || lower.includes('failed') || lower.includes('shutdown')) {
    return { status: 'crit', value: 'Down', evidence: stdout.slice(0, 100) };
  }
  if (lower.includes('starting') || lower.includes('pending')) {
    return { status: 'warn', value: 'Starting…', evidence: stdout.slice(0, 100) };
  }
  return { status: 'warn', value: 'Uncertain', evidence: stdout.slice(0, 100) };
}

// ─── DB (Database Tier) checks — SQL-based ────────────────────────────────────
// These run via the Oracle thin client (withOracleConnection pattern from db-ops-executor).

const DB_SANITY_CHECKS_SQL = [
  {
    id: 'db.san.instance',
    label: 'Database instance status',
    sql: `SELECT instance_name, host_name, status, database_status, logins,
               TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI') AS startup_time
          FROM v$instance`,
    parse(rows) {
      if (!rows || !rows.length) return { status: 'crit', value: 'No data', evidence: 'v$instance returned no rows' };
      const [instName, hostName, status, dbStatus, logins, startupTime] = rows[0];
      if (status !== 'OPEN') return { status: 'crit', value: status, evidence: `Instance ${instName} is ${status}, not OPEN` };
      if (dbStatus !== 'ACTIVE') return { status: 'warn', value: dbStatus, evidence: `DB status: ${dbStatus} (expected ACTIVE)` };
      if (logins === 'RESTRICTED') return { status: 'warn', value: 'RESTRICTED MODE', evidence: 'Database is in restricted mode — only admin logins allowed' };
      return { status: 'ok', value: 'OPEN / ACTIVE', evidence: `${instName} on ${hostName}, started ${startupTime || 'N/A'}` };
    },
  },
  {
    id: 'db.san.archivelog',
    label: 'Archive log mode',
    sql: `SELECT log_mode FROM v$database`,
    parse(rows) {
      if (!rows || !rows.length) return { status: 'error', value: 'No data', evidence: 'v$database returned no rows' };
      const mode = rows[0][0];
      if (mode === 'ARCHIVELOG') return { status: 'ok', value: 'ARCHIVELOG', evidence: 'Archive log mode enabled' };
      return { status: 'warn', value: mode || 'NOARCHIVELOG', evidence: 'Database not in ARCHIVELOG mode — point-in-time recovery not possible' };
    },
  },
  {
    id: 'db.san.pdbs',
    label: 'PDB open status (12c+)',
    sql: `SELECT con_id, name, open_mode FROM v$pdbs WHERE con_id > 2 ORDER BY con_id FETCH FIRST 10 ROWS ONLY`,
    parse(rows) {
      if (!rows || !rows.length) return { status: 'skip', value: 'No PDBs', evidence: 'No pluggable databases detected (non-CDB or no PDBs > con_id 2)' };
      const closed = rows.filter(r => r[2] !== 'READ WRITE');
      if (closed.length === 0) return { status: 'ok', value: `${rows.length} PDB${rows.length > 1 ? 's' : ''} open`, evidence: rows.map(r => `${r[1]}:${r[2]}`).join(', ') };
      return { status: 'crit', value: `${closed.length} PDB(s) not READ WRITE`, evidence: closed.map(r => `${r[1]}:${r[2]}`).join(', ') };
    },
  },
  {
    id: 'db.san.alertlog_ora',
    label: 'Alert log — recent ORA- errors',
    sql: `SELECT message_text, originating_timestamp
          FROM v$diag_alert_ext
          WHERE message_text LIKE 'ORA-%'
            AND originating_timestamp > SYSDATE - 1/24
          ORDER BY originating_timestamp DESC
          FETCH FIRST 5 ROWS ONLY`,
    parse(rows) {
      if (!rows || !rows.length) return { status: 'ok', value: 'No ORA- errors', evidence: 'No ORA- errors in alert log in the past 1 hour' };
      // Filter out ORA-01403 (no data found) which is informational
      const real = rows.filter(r => !String(r[0] || '').startsWith('ORA-01403'));
      if (!real.length) return { status: 'ok', value: 'No critical ORA- errors', evidence: 'Only ORA-01403 (informational) found' };
      return { status: 'warn', value: `${real.length} ORA- error${real.length > 1 ? 's' : ''} in last hour`, evidence: real.map(r => String(r[0] || '').slice(0, 60)).join(' | ') };
    },
  },
];

// ─── DB SSH checks (listener) ─────────────────────────────────────────────────
// Run via SSH, uses db_tier targets.

const DB_SANITY_CHECKS_SSH = [
  {
    id: 'db.san.listener',
    label: 'TNS Listener',
    type: 'ssh',
    commandKey: 'oracle.listener.status',
    requires: 'db_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) return { status: 'error', value: 'No output', evidence: 'SSH error or no output from lsnrctl' };
      const lower = stdout.toLowerCase();
      if (lower.includes('ready to accept connections') || lower.includes('services summary')) {
        return { status: 'ok', value: 'Running', evidence: stdout.slice(0, 120) };
      }
      if (lower.includes('no listener') || lower.includes('connect error') || exitCode !== 0) {
        return { status: 'crit', value: 'Down', evidence: stdout.slice(0, 120) };
      }
      return { status: 'warn', value: 'Uncertain', evidence: stdout.slice(0, 120) };
    },
  },
];

// ─── Oracle connection helper (mirrors db-ops-executor pattern) ───────────────

let _oracledb = null;
function getOracledb() {
  if (!_oracledb) {
    try { _oracledb = require('oracledb'); } catch (_) { return null; }
  }
  return _oracledb;
}

async function withOracleConnection(connParams, fn) {
  const oracledb = getOracledb();
  if (!oracledb) throw new Error('Oracle client not available');
  const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
  const conn = await oracledb.getConnection({
    user: connParams.username,
    password: connParams.password,
    connectString,
    connectTimeout: 20,
  });
  try {
    return await fn(conn, oracledb);
  } finally {
    try { await conn.close(); } catch (_) {}
  }
}

// ─── EBS sanity check runner ──────────────────────────────────────────────────

/**
 * Run the EBS Application Tier sanity check suite.
 * @param {object} opts
 * @param {number} opts.targetId      — SSH target id (apps_tier role)
 * @param {string} opts.initiatedBy   — user email
 * @returns {Promise<SanityResult>}
 */
async function runEbsSanityCheck({ targetId, initiatedBy }) {
  const t0 = Date.now();
  const results = [];

  for (const check of EBS_SANITY_CHECKS) {
    let result;
    try {
      const exec = await sshExec.runCommand({
        targetId,
        commandKey: check.commandKey,
        initiatedBy,
        extraVars: {},
      });
      const parsed = check.parse(exec.stdout || '', exec.stderr || '', exec.exitCode || 0);
      result = {
        id: check.id,
        label: check.label,
        status: parsed.status,
        value: parsed.value,
        evidence: parsed.evidence || null,
      };
    } catch (err) {
      result = {
        id: check.id,
        label: check.label,
        status: 'error',
        value: 'Error',
        evidence: err.message,
      };
    }
    results.push(result);
  }

  return buildSuiteResult('ebs', results, Date.now() - t0);
}

// ─── DB sanity check runner ───────────────────────────────────────────────────

/**
 * Run the DB sanity check suite.
 * @param {object} opts
 * @param {object}      opts.connParams   — { host, port, serviceName, username, password }
 * @param {number|null} opts.targetId     — SSH target id (db_tier role); null = skip SSH checks
 * @param {string}      opts.initiatedBy
 * @returns {Promise<SanityResult>}
 */
async function runDbSanityCheck({ connParams, targetId, initiatedBy }) {
  const t0 = Date.now();
  const results = [];

  // SQL-based checks
  const oracledb = getOracledb();
  if (!oracledb) {
    // No Oracle client — mark all SQL checks as skip
    for (const check of DB_SANITY_CHECKS_SQL) {
      results.push({ id: check.id, label: check.label, status: 'skip', value: 'Oracle client unavailable', evidence: null });
    }
  } else {
    try {
      await withOracleConnection(connParams, async (conn) => {
        for (const check of DB_SANITY_CHECKS_SQL) {
          let result;
          try {
            const res = await conn.execute(check.sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
            const parsed = check.parse(res.rows || []);
            result = { id: check.id, label: check.label, status: parsed.status, value: parsed.value, evidence: parsed.evidence || null };
          } catch (sqlErr) {
            // Some views may not exist (e.g. v$pdbs on non-CDB) — degrade gracefully
            const msg = sqlErr.message || String(sqlErr);
            if (msg.includes('ORA-00942') || msg.includes('table or view does not exist')) {
              result = { id: check.id, label: check.label, status: 'skip', value: 'View not available', evidence: msg.slice(0, 100) };
            } else {
              result = { id: check.id, label: check.label, status: 'error', value: 'Query error', evidence: msg.slice(0, 150) };
            }
          }
          results.push(result);
        }
      });
    } catch (connErr) {
      // Can't connect at all — all SQL checks fail
      for (const check of DB_SANITY_CHECKS_SQL) {
        results.push({ id: check.id, label: check.label, status: 'error', value: 'Connection failed', evidence: connErr.message });
      }
    }
  }

  // SSH-based checks (listener) — only if a db_tier target is provided
  for (const check of DB_SANITY_CHECKS_SSH) {
    if (!targetId) {
      results.push({ id: check.id, label: check.label, status: 'skip', value: 'No SSH target', evidence: 'Add a db_tier SSH target to this connection to check the listener' });
      continue;
    }
    let result;
    try {
      const exec = await sshExec.runCommand({ targetId, commandKey: check.commandKey, initiatedBy, extraVars: {} });
      const parsed = check.parse(exec.stdout || '', exec.stderr || '', exec.exitCode || 0);
      result = { id: check.id, label: check.label, status: parsed.status, value: parsed.value, evidence: parsed.evidence || null };
    } catch (err) {
      result = { id: check.id, label: check.label, status: 'error', value: 'Error', evidence: err.message };
    }
    results.push(result);
  }

  return buildSuiteResult('db', results, Date.now() - t0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSuiteResult(tier, checks, elapsedMs) {
  const summary = { ok: 0, warn: 0, crit: 0, error: 0, skip: 0 };
  for (const c of checks) {
    summary[c.status] = (summary[c.status] || 0) + 1;
  }

  // Overall status: worst non-skip result drives the headline
  let overall = 'ok';
  if (summary.error > 0) overall = 'error';
  if (summary.warn > 0 && overall !== 'error') overall = 'warn';
  if (summary.crit > 0) overall = 'crit';

  return {
    ok: overall !== 'error',
    tier,
    overall,
    checks,
    summary,
    elapsed_ms: elapsedMs,
    ran_at: new Date().toISOString(),
  };
}

module.exports = { runEbsSanityCheck, runDbSanityCheck };
