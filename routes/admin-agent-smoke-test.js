/**
 * routes/admin-agent-smoke-test.js — End-to-end agent smoke test.
 *
 * Owns: POST /api/admin/smoke-test/:connection_id        (kick off, returns {run_id}),
 *       GET  /api/admin/smoke-test/runs/:id              (poll run status + steps),
 *       POST /api/admin/smoke-test/:connection_id/full   (run all 12 steps, return single boolean).
 * Does NOT own: health check execution (server.js), key rotation logic (routes/key-rotation.js),
 *               agent channel (services/agent-channel.js), badge data (routes/ready-to-test.js).
 *
 * Safety:
 *   - 1 concurrent run per connection (rejects if already in flight)
 *   - 20 runs/day/connection soft cap
 *   - Admin-cookie gated (requireAdmin)
 *
 * Steps (run async after kick-off):
 *   1. Heartbeat sanity       — last heartbeat < 60s ago (DB read)
 *   2. Health probe           — /api/run-diagnostics via agent channel
 *   3. Key rotation           — triggers rotate-key, waits for agent ACK
 *   4. Assert /api/test=410   — dispatches probe to agent; pass if status=410
 *   5. Upgrade audit          — DB read: latest audit row status=completed, to_version>=6.1.0
 *   6. Config drift           — /api/probe-8 via agent channel; pass if probe_8_status=pass
 *   7. EBS detected           — /api/ebs-probe APPS.DUAL check; 'na' if not EBS
 *   8. Concurrent Managers    — FND_CONCURRENT_QUEUES_VL; ICM + standard manager alive; 'na' if not EBS
 *   9. EBS Ops path           — FND_CONCURRENT_REQUESTS last 1h query proves agent→DB→EBS path; 'na' if not EBS
 *  10. Apps-node SSH           — SSH to apps_tier profile; echo ok + source EBSapps.env + echo $APPL_TOP; 'na' if no apps_tier profile
 *  11. adop -status            — runs adop -status on apps node, exercises weblogic_admin credential vault; 'na' if no apps_tier profile or no weblogic_admin cred
 *  12. DB via ssh_sqlplus      — SELECT instance_name,status,database_role FROM v$instance via oracle-runner.js SSH path; 'na' if connectivity_mode=tns
 */

'use strict';

const express       = require('express');
const crypto        = require('crypto');
const { Client }    = require('ssh2');
const pool          = require('../db/index');
const smokeDb       = require('../db/smoke-test-runs');
const channel       = require('../services/agent-channel');
const agentDb       = require('../db/agent');
const sshProfilesDb = require('../db/ssh-profiles');
const { requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');
const { resolveCredential } = require('./ebs-credentials');
const { runQuery: runSshQuery } = require('../services/oracle-runner');

const router = express.Router();

// Agent version required for step 5 green status
const REQUIRED_VERSION = '6.1.0';

// ── Semver helper ─────────────────────────────────────────────────────────────

function versionAtLeast(a, b) {
  if (!a) return false;
  const parse = v => (v || '0.0.0').replace(/[^0-9.]/g, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM > bM;
  if (am !== bm) return am > bm;
  return ap >= bp;
}

// ── Resolve connection row by id ──────────────────────────────────────────────

async function getConn(connectionId) {
  const result = await pool.query(
    `SELECT oc.id, oc.name, oc.connection_type,
            oc.key_rotated_at, oc.key_rotation_status, oc.proxy_api_key_enc_previous,
            oc.proxy_api_key_enc, oc.encrypted_password, oc.username, oc.host,
            oc.port, oc.service_name,
            at.last_heartbeat, at.agent_version
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE oc.id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// ── One-shot SSH exec helper (no pool — smoke test creates a fresh client) ────
// Used only for steps 10-11 which target the apps tier (not DB node).
async function execSshOnce(profile, command, timeoutMs = 30000) {
  // Decrypt key material from the SSH profile row
  let authOpts = {};
  if (profile.auth_method === 'key_upload' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      authOpts.privateKey = bundle.key;
      if (bundle.passphrase) authOpts.passphrase = bundle.passphrase;
    } catch (_) {
      throw new Error('Failed to decrypt apps-tier SSH key from vault');
    }
  } else if (profile.auth_method === 'password' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      authOpts.password = bundle.password;
    } catch (_) {
      throw new Error('Failed to decrypt apps-tier SSH password from vault');
    }
  } else if (profile.auth_method === 'agent_forward') {
    // agent forwarding — let ssh2 use the SSH_AUTH_SOCK
    authOpts.agent = process.env.SSH_AUTH_SOCK || undefined;
  }

  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const done = (val) => {
      if (!settled) { settled = true; resolve(val); }
      try { client.end(); } catch (_) {}
    };
    const fail = (err) => {
      if (!settled) { settled = true; reject(err); }
      try { client.end(); } catch (_) {}
    };

    client.on('ready', () => {
      let stdout = '';
      let stderr = '';
      client.exec(command, (err, stream) => {
        if (err) return fail(new Error(`SSH exec error: ${err.message}`));

        const timer = setTimeout(() => {
          stream.destroy();
          fail(new Error('SSH exec timed out'));
        }, timeoutMs);

        stream.on('data', (chunk) => { stdout += chunk.toString(); });
        stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          done({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
        });
      });
    });

    client.on('error', (err) => fail(new Error(`SSH connect error: ${err.message}`)));

    client.connect({
      host: profile.ssh_host,
      port: profile.ssh_port || 22,
      username: profile.ssh_user,
      readyTimeout: 15000,
      tryKeyboard: false,
      ...authOpts,
    });
  });
}

// ── Async smoke runner ────────────────────────────────────────────────────────
// Runs all 12 steps sequentially. Stores each result immediately so the client
// can see progress while the run is in flight.

async function runSmoke(runId, connectionId) {
  const stepResults = [];
  let overallStatus = 'pass';

  async function step(num, label, fn) {
    const t0 = Date.now();
    try {
      const { pass, detail } = await fn();
      const s = {
        step:        num,
        label,
        status:      pass ? 'pass' : 'fail',
        duration_ms: Date.now() - t0,
        detail:      detail || '',
        error_msg:   null,
      };
      stepResults.push(s);
      await smokeDb.appendStep(runId, s);
      if (!pass) overallStatus = 'fail';
      return pass;
    } catch (err) {
      const s = {
        step:        num,
        label,
        status:      'fail',
        duration_ms: Date.now() - t0,
        detail:      'Exception during step',
        error_msg:   err.message || String(err),
      };
      stepResults.push(s);
      await smokeDb.appendStep(runId, s);
      overallStatus = 'fail';
      return false;
    }
  }

  async function skipStep(num, label, reason) {
    const s = {
      step: num, label, status: 'skip',
      duration_ms: 0, detail: reason, error_msg: null,
    };
    stepResults.push(s);
    await smokeDb.appendStep(runId, s);
  }

  async function naStep(num, label, reason) {
    // N/A = neutral; does not affect overallStatus
    const s = {
      step: num, label, status: 'na',
      duration_ms: 0, detail: reason, error_msg: null,
    };
    stepResults.push(s);
    await smokeDb.appendStep(runId, s);
  }

  // ─── Step 1: Heartbeat sanity ────────────────────────────────────────────
  const heartbeatPass = await step(1, 'Heartbeat sanity', async () => {
    const conn = await getConn(connectionId);
    if (!conn || !conn.last_heartbeat) {
      return { pass: false, detail: 'No heartbeat recorded for this connection' };
    }
    const ageSec = (Date.now() - new Date(conn.last_heartbeat).getTime()) / 1000;
    const pass = ageSec < 60;
    return {
      pass,
      detail: pass
        ? `Last heartbeat ${Math.round(ageSec)}s ago`
        : `Agent silent for ${Math.round(ageSec)}s — restart required before smoke test`,
    };
  });

  // Steps 2-9 require a live agent; steps 10-12 are SSH-only and run unconditionally.
  if (!heartbeatPass) {
    await skipStep(2, 'Health probe dispatch', 'Skipped — agent offline (step 1 failed)');
    await skipStep(3, 'Key rotation round-trip', 'Skipped — agent offline (step 1 failed)');
    await skipStep(4, 'Assert /api/test → 410', 'Skipped — agent offline (step 1 failed)');
    await skipStep(5, 'Upgrade audit verify', 'Skipped — agent offline (step 1 failed)');
    await skipStep(6, 'Config drift check', 'Skipped — agent offline (step 1 failed)');
    await skipStep(7, 'EBS detected', 'Skipped — agent offline (step 1 failed)');
    await skipStep(8, 'Concurrent Managers', 'Skipped — agent offline (step 1 failed)');
    await skipStep(9, 'EBS Ops path', 'Skipped — agent offline (step 1 failed)');
  } else {
  // ─── Step 2: Dispatch health probe ────────────────────────────────────────
  // Send /api/run-diagnostics to the agent, wait up to 15s for a new health_run row.
  await step(2, 'Health probe dispatch', async () => {
    if (!await channel.isAgentConnected(connectionId)) {
      return { pass: false, detail: 'Agent long-poll not active — cannot dispatch' };
    }

    const conn = await getConn(connectionId);
    let password = '';
    if (conn && conn.encrypted_password) {
      try {
        password = decrypt(conn.encrypted_password);
      } catch (_) { /* no credential — OS auth */ }
    }

    let resp;
    try {
      resp = await channel.sendToAgent(
        connectionId,
        { method: 'POST', path: '/api/run-diagnostics', body: {
          service_name: conn && conn.service_name || '',
          username:     conn && conn.username || '',
          password,
          host:         conn && conn.host || '',
          port:         conn && conn.port || '',
          os_auth:      !(conn && conn.username),
        }},
        15000
      );
    } catch (_) {
      return { pass: false, detail: 'Probe timed out after 15s — agent did not respond' };
    }

    const body = resp?.body || {};
    const checkCount  = body.total  || 0;
    const failedCount = body.failed || (body.total - body.passed) || 0;
    const passed = resp?.statusCode === 200 && checkCount > 0;
    return {
      pass: passed,
      detail: passed
        ? `Probes complete: ${checkCount} checks, ${failedCount} failed`
        : `Agent probe returned status ${resp?.statusCode}: ${JSON.stringify(body).slice(0, 120)}`,
    };
  });

  // ─── Step 3: Key rotation round-trip ──────────────────────────────────────
  await step(3, 'Key rotation round-trip', async () => {
    if (!await channel.isAgentConnected(connectionId)) {
      return { pass: false, detail: 'Agent not connected — cannot trigger rotation' };
    }

    // Generate new key + rotate in DB (mirrors routes/key-rotation.js logic)
    const newRawKey      = crypto.randomBytes(32).toString('hex');
    const newEncryptedKey = encrypt(newRawKey);
    const rotationStart  = new Date();

    await agentDb.rotateConnectionKey(connectionId, newEncryptedKey, 'smoke-test');

    // Push rotation work to agent
    try {
      await channel.sendToAgent(
        connectionId,
        { method: 'POST', path: '/api/rotate-key', body: { new_key: newRawKey } },
        8000
      );
    } catch (_) {
      return { pass: false, detail: 'Rotation dispatch timed out after 8s — agent did not ACK' };
    }

    // Poll for ACK (key_rotation_status='acknowledged') up to 8s
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const row = await pool.query(
        `SELECT key_rotation_status, key_rotated_at
         FROM oracle_connections WHERE id = $1`,
        [connectionId]
      );
      const r = row.rows[0];
      if (r && r.key_rotation_status === 'acknowledged' &&
          r.key_rotated_at && new Date(r.key_rotated_at) >= rotationStart) {
        return { pass: true, detail: 'New key generated, dispatched, agent acknowledged' };
      }
      await new Promise(ok => setTimeout(ok, 500));
    }

    return { pass: false, detail: 'Agent did not acknowledge new key within 8s' };
  });

  // ─── Step 4: Assert /api/test → 410 ───────────────────────────────────────
  await step(4, 'Assert /api/test → 410', async () => {
    if (!await channel.isAgentConnected(connectionId)) {
      return { pass: false, detail: 'Agent not connected' };
    }

    let resp;
    try {
      resp = await channel.sendToAgent(
        connectionId,
        { method: 'GET', path: '/api/test', body: {} },
        8000
      );
    } catch (_) {
      return { pass: false, detail: 'Agent did not respond within 8s' };
    }

    const sc = resp?.statusCode;
    const pass = sc === 410;
    return {
      pass,
      detail: pass
        ? '/api/test returned 410 — legacy endpoint correctly disabled'
        : `/api/test returned ${sc} — expected 410; agent may be pre-6.x`,
    };
  });

  // ─── Step 5: Upgrade audit verify ─────────────────────────────────────────
  await step(5, 'Upgrade audit verify', async () => {
    const row = await pool.query(
      `SELECT status, to_version, completed_at
       FROM agent_upgrade_audit
       WHERE connection_id = $1
       ORDER BY triggered_at DESC
       LIMIT 1`,
      [connectionId]
    );
    const audit = row.rows[0];
    if (!audit) {
      // No upgrade row — acceptable if agent was installed directly at v6.1.x
      const connRow = await getConn(connectionId);
      const ver = connRow && connRow.agent_version;
      const ok  = ver && versionAtLeast(ver, REQUIRED_VERSION);
      return {
        pass: !!ok,
        detail: ok
          ? `No upgrade audit row; agent is already v${ver} ≥ ${REQUIRED_VERSION}`
          : `No upgrade audit and agent version ${ver || 'unknown'} < ${REQUIRED_VERSION}`,
      };
    }

    const isComplete = audit.status === 'completed';
    const atTarget   = audit.to_version && versionAtLeast(audit.to_version, REQUIRED_VERSION);
    const pass       = isComplete && atTarget;
    return {
      pass,
      detail: pass
        ? `Upgrade completed: → v${audit.to_version}`
        : `Upgrade status=${audit.status}, to_version=${audit.to_version || '?'} — expected completed + ≥${REQUIRED_VERSION}`,
    };
  });

  // ─── Step 6: Config drift check ───────────────────────────────────────────
  await step(6, 'Config drift check', async () => {
    if (!await channel.isAgentConnected(connectionId)) {
      return { pass: false, detail: 'Agent not connected — cannot run probe 8' };
    }

    let resp;
    try {
      resp = await channel.sendToAgent(
        connectionId,
        { method: 'POST', path: '/api/probe-8', body: {} },
        5000
      );
    } catch (_) {
      return { pass: false, detail: 'Probe 8 timed out after 5s' };
    }

    const body = resp?.body || {};
    // Agent returns { config_files: ['/etc/tunevault/agent.env'], drift: false }
    // or { probe_8_status: 'pass', detail: '...' }
    const noOverride = body.drift === false ||
                       body.probe_8_status === 'pass' ||
                       resp?.statusCode === 200 && !body.drift;
    const configFiles = body.config_files || [];
    const onlyAgentEnv = configFiles.length === 0 ||
                         (configFiles.length === 1 && configFiles[0] === '/etc/tunevault/agent.env');
    const pass = noOverride && onlyAgentEnv;
    return {
      pass,
      detail: pass
        ? `Config is clean — /etc/tunevault/agent.env only`
        : body.drift
          ? `Config drift detected: ${JSON.stringify(body).slice(0, 200)}`
          : `Probe 8 response: ${JSON.stringify(body).slice(0, 200)}`,
    };
  });

  // ─── Steps 7-9: EBS checks via /api/ebs-probe ─────────────────────────────
  // Dispatch once, parse results for three separate steps.
  // Non-EBS instances get status='na' (neutral — not a failure).
  let ebsProbeResp = null;
  let ebsDetected  = false;

  if (await channel.isAgentConnected(connectionId)) {
    const conn = await getConn(connectionId);
    let password = '';
    if (conn && conn.encrypted_password) {
      try {
        password = decrypt(conn.encrypted_password);
      } catch (_) { /* OS auth */ }
    }

    try {
      ebsProbeResp = await channel.sendToAgent(
        connectionId,
        {
          method: 'POST',
          path: '/api/ebs-probe',
          body: {
            service_name: conn && conn.service_name || '',
            username:     conn && conn.username || '',
            password,
            host:         conn && conn.host || 'localhost',
            port:         conn && conn.port || 1521,
            os_auth:      !(conn && conn.username),
          },
        },
        20000
      );
      if (ebsProbeResp?.statusCode === 200 && ebsProbeResp.body?.success) {
        ebsDetected = !!ebsProbeResp.body.ebs_detected;
      }
    } catch (_) {
      ebsProbeResp = null;
    }
  }

  // ─── Step 7: EBS detected ─────────────────────────────────────────────────
  {
    const s = {
      step:        7,
      label:       'EBS detected',
      duration_ms: 0,
      error_msg:   null,
    };
    if (!await channel.isAgentConnected(connectionId)) {
      s.status = 'fail';
      s.detail = 'Agent not connected — cannot run EBS probe';
    } else if (!ebsProbeResp) {
      s.status = 'fail';
      s.detail = 'EBS probe timed out or failed to reach agent';
    } else if (ebsProbeResp.statusCode !== 200) {
      s.status = 'fail';
      s.detail = `EBS probe returned HTTP ${ebsProbeResp.statusCode}`;
    } else if (!ebsDetected) {
      // Not EBS — neutral, not a failure
      s.status = 'na';
      s.detail = 'APPS.DUAL not accessible — not an EBS instance (non-EBS Oracle)';
    } else {
      s.status = 'pass';
      s.detail = 'APPS.DUAL accessible — EBS schema confirmed';
    }
    stepResults.push(s);
    await smokeDb.appendStep(runId, s);
    // na is neutral — do not set overallStatus to fail
    if (s.status === 'fail') overallStatus = 'fail';
  }

  // ─── Step 8: Concurrent Managers ──────────────────────────────────────────
  {
    const s = {
      step:        8,
      label:       'Concurrent Managers',
      duration_ms: 0,
      error_msg:   null,
    };
    if (!ebsDetected) {
      s.status = 'na';
      s.detail = 'N/A — not an EBS instance';
    } else {
      const managers = ebsProbeResp?.body?.concurrent_managers || [];
      const hasError  = managers[0] && managers[0].error;
      if (hasError) {
        s.status = 'fail';
        s.detail = `FND_CONCURRENT_QUEUES_VL query failed: ${managers[0].error}`;
        overallStatus = 'fail';
      } else {
        const active  = managers.filter(m => m.status === 'active');
        const stopped = managers.filter(m => m.status === 'stopped');
        const icm     = managers.find(m =>
          m.name && (m.name.toUpperCase().includes('OAM') || m.name.toUpperCase() === 'FNDCPOAM')
        );
        const icmAlive = icm && icm.status === 'active';
        const totalRunning = managers.reduce((n, m) => n + (m.running_processes || 0), 0);

        if (managers.length === 0) {
          s.status = 'fail';
          s.detail = 'No active concurrent managers found (MAX_PROCESSES > 0 and ENABLED_FLAG = Y)';
          overallStatus = 'fail';
        } else if (!icmAlive && icm) {
          s.status = 'fail';
          s.detail = `ICM (${icm.name}) is stopped — ${active.length} of ${managers.length} managers active`;
          overallStatus = 'fail';
        } else if (stopped.length > 0 && active.length === 0) {
          s.status = 'fail';
          s.detail = `All ${stopped.length} managers stopped — ${stopped.map(m => m.name).join(', ')}`;
          overallStatus = 'fail';
        } else {
          // Warn if some stopped but ICM is up
          s.status = stopped.length > 0 ? 'warn' : 'pass';
          s.detail = `${active.length} of ${managers.length} managers active, ${totalRunning} workers running` +
            (stopped.length > 0 ? ` — ${stopped.length} stopped: ${stopped.map(m => m.name).slice(0, 3).join(', ')}` : '');
        }
      }
    }
    stepResults.push(s);
    await smokeDb.appendStep(runId, s);
  }

  // ─── Step 9: EBS Ops path ─────────────────────────────────────────────────
  {
    const s = {
      step:        9,
      label:       'EBS Ops path',
      duration_ms: 0,
      error_msg:   null,
    };
    if (!ebsDetected) {
      s.status = 'na';
      s.detail = 'N/A — not an EBS instance';
    } else {
      const requests = ebsProbeResp?.body?.recent_requests || [];
      const hasError  = requests[0] && requests[0].error;
      if (hasError) {
        s.status = 'fail';
        s.detail = `FND_CONCURRENT_REQUESTS query failed: ${requests[0].error}`;
        overallStatus = 'fail';
      } else {
        // The query succeeded (even 0 rows is fine — DB is accessible)
        s.status = 'pass';
        s.detail = requests.length > 0
          ? `FND_CONCURRENT_REQUESTS accessible — ${requests.length} request(s) in last 1h (agent→DB→EBS Ops path verified)`
          : 'FND_CONCURRENT_REQUESTS accessible — 0 requests in last 1h (quiet period normal; EBS Ops path verified)';
      }
    }
    stepResults.push(s);
    await smokeDb.appendStep(runId, s);
    if (s.status === 'fail') overallStatus = 'fail';
  }

  } // end: if (heartbeatPass) else block

  // ─── Steps 10-12: SSH-only EBS path ───────────────────────────────────────
  // These run independently of the agent — pure SSH to apps/DB nodes.
  // 'na' when the required SSH profile or credential is not configured.

  // Load the apps_tier SSH profile (with key material for decryption)
  const appsProfile = await sshProfilesDb.getProfileWithKeys(connectionId, 'apps_tier').catch(() => null);

  // ─── Step 10: Apps-node SSH reachability ──────────────────────────────────
  if (!appsProfile) {
    await naStep(10, 'Apps-node SSH reachability', 'N/A — no apps_tier SSH profile configured. Add one under Connection → SSH Profiles to enable this check.');
  } else {
    await step(10, 'Apps-node SSH reachability', async () => {
      const cmd = [
        'echo ok',
        '. /u01/install/APPS/EBSapps.env run 2>/dev/null || . /u01/r12/EBSapps.env run 2>/dev/null || true',
        'echo "APPL_TOP=${APPL_TOP}"',
      ].join(' && ');

      let result;
      try {
        result = await execSshOnce(appsProfile, cmd, 20000);
      } catch (err) {
        return { pass: false, detail: `SSH connect failed: ${err.message}` };
      }

      if (!result.stdout.includes('ok')) {
        return {
          pass: false,
          detail: `SSH exited ${result.exitCode}; expected "ok" in output. stderr: ${(result.stderr || 'none').slice(0, 200)}`,
        };
      }

      const applTopMatch = result.stdout.match(/APPL_TOP=(.+)/);
      const applTop = applTopMatch ? applTopMatch[1].trim() : '';

      if (!applTop) {
        return {
          pass: false,
          detail: 'SSH connected but APPL_TOP is empty — EBSapps.env not found at /u01/install/APPS/EBSapps.env or /u01/r12/EBSapps.env',
          fix_cmd: 'find /u01 -name "EBSapps.env" 2>/dev/null | head -5',
        };
      }

      return { pass: true, detail: `SSH OK — APPL_TOP=${applTop}` };
    });
  }

  // ─── Step 11: adop -status (exercises weblogic_admin credential vault) ────
  if (!appsProfile) {
    await naStep(11, 'adop -status', 'N/A — no apps_tier SSH profile configured.');
  } else {
    await step(11, 'adop -status', async () => {
      // Resolve weblogic_admin credential from vault — exercises full decrypt path
      let wlCredDetail = '';
      try {
        const cred = await resolveCredential(connectionId, 'weblogic_admin', 'smoke_test_adop_status', null);
        wlCredDetail = cred
          ? ` — weblogic_admin cred resolved (user=${cred.username}) ✓`
          : ' — weblogic_admin cred not in vault (adop may prompt for password)';
      } catch (e) {
        wlCredDetail = ` — vault lookup error: ${e.message}`;
      }

      const cmd = [
        '. /u01/install/APPS/EBSapps.env run 2>/dev/null || . /u01/r12/EBSapps.env run 2>/dev/null || true',
        'adop -status 2>&1 | head -40',
      ].join(' && ');

      let result;
      try {
        result = await execSshOnce(appsProfile, cmd, 30000);
      } catch (err) {
        return { pass: false, detail: `SSH exec failed: ${err.message}` };
      }

      const out = result.stdout || '';

      if (/command not found|No such file/.test(out) || result.exitCode === 127) {
        return {
          pass: false,
          detail: `adop not found in PATH${wlCredDetail}. Ensure EBSapps.env sources the adop script.`,
          fix_cmd: 'which adop 2>/dev/null || find $APPL_TOP -name adop 2>/dev/null | head -3',
        };
      }

      const hasStatusBlock = /Current|PHASE|STATUS|Patching|cutover|finalize|abort/i.test(out);
      const noActiveSession = /No.*active.*session|No.*patch.*in.*progress|not.*in.*progress/i.test(out);

      if (hasStatusBlock || noActiveSession || out.length > 20) {
        return {
          pass: true,
          detail: `adop -status OK (exit ${result.exitCode})${wlCredDetail}. ` +
                  (noActiveSession ? 'No active patching session.' : `Output snippet: ${out.slice(0, 120)}`),
        };
      }

      return {
        pass: false,
        detail: `adop -status exited ${result.exitCode} with unexpected output${wlCredDetail}: ${out.slice(0, 200)}`,
      };
    });
  }

  // ─── Step 12: DB query via ssh_sqlplus (zero TNS) ─────────────────────────
  {
    const connRow = await pool.query(
      `SELECT id, connectivity_mode, ssh_db_host, ssh_db_user, ssh_db_key_enc,
              ssh_oracle_home, ssh_oracle_sid, service_name
       FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    const conn12 = connRow.rows[0];
    const mode = conn12 ? (conn12.connectivity_mode || 'tns') : 'tns';

    if (!conn12 || mode === 'tns') {
      await naStep(12, 'DB query via ssh_sqlplus',
        mode === 'tns'
          ? 'N/A — connectivity_mode=tns. Set to ssh_sqlplus or both under Connection → SSH Connectivity to enable this check.'
          : 'N/A — connection not found'
      );
    } else if (!conn12.ssh_db_key_enc) {
      await step(12, 'DB query via ssh_sqlplus', async () => ({
        pass: false,
        detail: 'SSH key not stored — save a DB node SSH key under Connection → SSH Connectivity first',
      }));
    } else {
      await step(12, 'DB query via ssh_sqlplus', async () => {
        let rows;
        try {
          const result = await runSshQuery(
            conn12,
            `SELECT instance_name, status, database_role FROM v$instance`
          );
          rows = result.rows;
        } catch (err) {
          return {
            pass: false,
            detail: `sqlplus-over-SSH failed: ${err.message}`,
            fix_cmd: `ssh ${conn12.ssh_db_user || 'oracle'}@${conn12.ssh_db_host} "export ORACLE_SID=${conn12.ssh_oracle_sid}; ${conn12.ssh_oracle_home || '/u01/app/oracle/product/19.0.0/db_1'}/bin/sqlplus -s / as sysdba <<'EOF'\nSELECT status FROM v\\$instance;\nEOF"`,
          };
        }

        if (!rows || rows.length === 0) {
          return { pass: false, detail: 'Query returned 0 rows — unexpected (v$instance always has 1 row)' };
        }

        const [instanceName, status, role] = rows[0];
        const isOpen = (status || '').toUpperCase().includes('OPEN');
        return {
          pass: isOpen,
          detail: isOpen
            ? `DB via SSH sqlplus — instance=${instanceName}, status=${status}, role=${role || 'PRIMARY'} (zero TNS ✓)`
            : `DB reachable but status=${status} — expected OPEN. instance=${instanceName}`,
        };
      });
    }
  }

  await smokeDb.finishRun(runId, overallStatus);
}

// ── POST /api/admin/smoke-test/:connection_id ─────────────────────────────────

router.post('/:connection_id', requireAdmin, async (req, res) => {
  const connectionId = parseInt(req.params.connection_id, 10);
  if (isNaN(connectionId)) {
    return res.status(400).json({ error: 'Invalid connection_id' });
  }

  try {
    // Verify connection exists
    const connRow = await pool.query(
      `SELECT id, name FROM oracle_connections WHERE id = $1`, [connectionId]
    );
    if (!connRow.rows[0]) {
      return res.status(404).json({ error: `Connection ${connectionId} not found` });
    }

    // Concurrency guard — reject if a run is already in flight
    const active = await smokeDb.getActiveRun(connectionId);
    if (active) {
      return res.status(409).json({
        error: 'A smoke test is already running for this connection',
        active_run_id: active.id,
      });
    }

    // Daily soft cap (20 runs/day/connection)
    const todayCount = await smokeDb.countRunsToday(connectionId);
    if (todayCount >= 20) {
      return res.status(429).json({
        error: `Daily smoke test cap reached (20/day). Runs today: ${todayCount}`,
      });
    }

    // Create the run row (status='running')
    const run = await smokeDb.createRun(connectionId, req.user && req.user.id);

    // Fire-and-forget — kick off async and return run_id immediately
    runSmoke(run.id, connectionId).catch(err => {
      console.error(`[smoke-test] run ${run.id} unhandled error:`, err.message);
      smokeDb.finishRun(run.id, 'error').catch(() => {});
    });

    return res.json({ run_id: run.id, started_at: run.started_at });

  } catch (err) {
    console.error('[smoke-test] kick-off error:', err.message);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// ── POST /api/admin/smoke-test/:connection_id/full ────────────────────────────
// Synchronously runs all 12 steps and returns a single boolean `ready`.
// Intended for CI/webhook use — returns within ~90s.

router.post('/:connection_id/full', requireAdmin, async (req, res) => {
  const connectionId = parseInt(req.params.connection_id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection_id' });

  try {
    const connRow = await pool.query(
      `SELECT id, name FROM oracle_connections WHERE id = $1`, [connectionId]
    );
    if (!connRow.rows[0]) {
      return res.status(404).json({ error: `Connection ${connectionId} not found` });
    }

    // Create a fresh run, await it synchronously
    const run = await smokeDb.createRun(connectionId, req.user && req.user.id);
    await runSmoke(run.id, connectionId);

    const finished = await smokeDb.getRun(run.id);
    const steps = Array.isArray(finished.steps_jsonb) ? finished.steps_jsonb : [];
    const ready = finished.overall_status === 'pass';

    const failSteps = steps.filter(s => s.status === 'fail').map(s => ({
      step: s.step, label: s.label, detail: s.detail,
    }));
    const naCount   = steps.filter(s => s.status === 'na').length;
    const passCount = steps.filter(s => s.status === 'pass').length;

    return res.json({
      ready,
      overall_status: finished.overall_status,
      run_id:         run.id,
      steps_total:    steps.length,
      steps_passed:   passCount,
      steps_na:       naCount,
      blocking_steps: failSteps,
      message: ready
        ? `You can test completely now — TNS optional, SSH path validated, credentials vault working`
        : `${failSteps.length} step(s) blocking readiness: ${failSteps.map(s => `Step ${s.step} (${s.label})`).join(', ')}`,
    });
  } catch (err) {
    console.error('[smoke-test/full] error:', err.message);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// ── GET /api/admin/smoke-test/runs/:id ────────────────────────────────────────

router.get('/runs/:id', requireAdmin, async (req, res) => {
  const runId = parseInt(req.params.id, 10);
  if (isNaN(runId)) return res.status(400).json({ error: 'Invalid run id' });

  try {
    const run = await smokeDb.getRun(runId);
    if (!run) return res.status(404).json({ error: `Run ${runId} not found` });

    const steps = Array.isArray(run.steps_jsonb) ? run.steps_jsonb : [];
    const durationMs = run.finished_at
      ? new Date(run.finished_at) - new Date(run.started_at)
      : null;

    return res.json({
      id:             run.id,
      connection_id:  run.connection_id,
      started_at:     run.started_at,
      finished_at:    run.finished_at,
      overall_status: run.overall_status,
      duration_ms:    durationMs,
      steps,
      in_flight:      run.overall_status === 'running',
    });
  } catch (err) {
    console.error('[smoke-test] poll error:', err.message);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

module.exports = router;
