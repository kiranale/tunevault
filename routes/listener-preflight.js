/**
 * routes/listener-preflight.js — SSH-driven listener pre-flight check engine.
 *
 * Owns: POST /api/connections/:id/listener-preflight/run   — kick off 5-step run
 *       GET  /api/connections/:id/listener-preflight/runs  — list last 10 runs
 *       GET  /api/connections/:id/listener-preflight/:runId — get single run detail
 *       GET  /connections/:id/listener-preflight           — HTML page
 *
 * Does NOT own: SSH connection pooling (services/oracle-runner.js),
 *               connection CRUD (db/agent.js), failure bundle capture (services/failure-capture.js).
 *
 * Security: requireAuth + requireConnectionOwner on all endpoints.
 *   All shell commands are fixed strings (no user input injected) except
 *   ORACLE_HOME and ORACLE_SID, which are run through SAFE_RE before use.
 *
 * Steps:
 *   1 — lsnrctl status:   listener endpoint + uptime + registered services
 *   2 — lsnrctl services: handler counts + service health
 *   3 — TNS reachability: tnsping from DB host (port probe from server side)
 *   4 — DB instance:      sqlplus / as sysdba — V$INSTANCE sanity
 *   5 — APPS connectivity (EBS only, if context.xml detected)
 */

'use strict';

const express     = require('express');
const path        = require('path');
const preflightDb = require('../db/listener-preflight');
const { runRawSsh }      = require('../services/oracle-runner');
const { captureFailure } = require('../services/failure-capture');
const { requireAuth }            = require('../middleware/auth');
const { requireConnectionOwner } = require('../middleware/auth');

const router = express.Router();

// Safe characters for ORACLE_HOME and ORACLE_SID before shell injection
const SAFE_PATH_RE = /^[a-zA-Z0-9/_.-]+$/;
const SAFE_SID_RE  = /^[a-zA-Z0-9_.-]+$/;

// ── HTML page ─────────────────────────────────────────────────────────────────

router.get('/connections/:id/listener-preflight', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, '../public/listener-preflight.html'));
});

// ── GET runs list ─────────────────────────────────────────────────────────────

router.get('/:id/listener-preflight/runs', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const runs = await preflightDb.getRunsForConnection(req.params.id, 10);
    res.json({ runs });
  } catch (err) {
    console.error('[listener-preflight] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pre-flight history' });
  }
});

// ── GET single run ────────────────────────────────────────────────────────────

router.get('/:id/listener-preflight/:runId', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const belongs = await preflightDb.runBelongsToConnection(req.params.runId, req.params.id);
    if (!belongs) return res.status(404).json({ error: 'Run not found' });

    const run = await preflightDb.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    console.error('[listener-preflight] get-run error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pre-flight run' });
  }
});

// ── POST /api/connections/:id/listener-preflight/run ─────────────────────────
// Kick off a 5-step listener pre-flight. Synchronous — returns full results.
// Max 90s total timeout.

router.post('/:id/listener-preflight/run', requireAuth, requireConnectionOwner, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const startTotal = Date.now();

  // ── Load connection record ────────────────────────────────────────────────

  let conn;
  try {
    conn = await preflightDb.getConnectionForPreflight(connId);
  } catch (err) {
    return res.status(500).json({ error: 'DB error loading connection' });
  }

  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  // ── Gate: SSH credentials required ───────────────────────────────────────

  if (!conn.ssh_db_key_enc || !conn.ssh_db_host || !conn.ssh_db_user) {
    return res.status(400).json({
      error: 'no_ssh',
      message: 'SSH credentials are not configured for this connection. Configure SSH access first.',
      configureUrl: `/connections/${connId}#ssh-connectivity`,
    });
  }

  // Validate and sanitize ORACLE_HOME + ORACLE_SID
  const oracleHome = conn.ssh_oracle_home || '/u01/app/oracle/product/19.0.0/db_1';
  const oracleSid  = conn.ssh_oracle_sid  || conn.service_name || '';

  if (!SAFE_PATH_RE.test(oracleHome)) {
    return res.status(400).json({ error: 'ssh_oracle_home contains unsafe characters' });
  }
  if (oracleSid && !SAFE_SID_RE.test(oracleSid)) {
    return res.status(400).json({ error: 'ssh_oracle_sid contains unsafe characters' });
  }

  // ── Insert run record ─────────────────────────────────────────────────────

  const runId = await preflightDb.insertRun({
    connectionId: connId,
    userId: req.user.id,
    oracleHome,
    oracleSid,
    sshHost: conn.ssh_db_host,
    triggeredBy: 'manual',
  });

  // ── Execute steps ─────────────────────────────────────────────────────────

  const steps = [];

  // Helper: run a step, catch errors, push result
  async function runStep(stepNum, label, executor) {
    const t0 = Date.now();
    let status = 'pass', summary = '', rawOutput = '', remediation = null;
    try {
      const result = await executor();
      status    = result.status    || 'pass';
      summary   = result.summary   || '';
      rawOutput = result.rawOutput || '';
      remediation = result.remediation || null;
    } catch (err) {
      status    = 'error';
      summary   = err.message;
      rawOutput = err.message;
      remediation = {
        text: 'SSH command failed. Verify SSH credentials and Oracle environment.',
        copyCommand: null,
      };
      // Fire-and-forget failure bundle capture
      captureFailure({
        error: err,
        checkId: `listener_preflight_step_${stepNum}`,
        connectionId: connId,
        userId: req.user.id,
        source: 'ssh_command',
        contextJson: { step: stepNum, label, oracle_home: oracleHome, oracle_sid: oracleSid },
      }).catch(() => {});
    }
    steps.push({
      step: stepNum,
      label,
      status,
      summary,
      rawOutput,
      remediation,
      duration_ms: Date.now() - t0,
    });
    return status;
  }

  // ── Step 1: lsnrctl status ────────────────────────────────────────────────

  let listenerDown = false;
  let listenerHost = conn.host || conn.ssh_db_host;
  let listenerPort = String(conn.port || 1521);

  await runStep(1, 'Listener status (lsnrctl status)', async () => {
    // Source oracle env and run lsnrctl status — use SID as listener alias if set
    const sidArg = oracleSid ? oracleSid : '';
    const cmd = [
      `export ORACLE_HOME='${oracleHome}'`,
      `export ORACLE_SID='${oracleSid || ''}'`,
      `export PATH="$ORACLE_HOME/bin:$PATH"`,
      `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
      `$ORACLE_HOME/bin/lsnrctl status ${sidArg} 2>&1`,
    ].join(' && ');

    const { stdout, stderr, exitCode } = await runRawSsh(conn, cmd, 20000);
    const raw = (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim();

    // Parse: is listener UP?
    const isDown = /TNS-\d{5}|no listener|LISTENER.*not running|failed to contact/i.test(raw);
    if (isDown) {
      listenerDown = true;
      return {
        status: 'fail',
        summary: 'Listener appears DOWN — no active listener found',
        rawOutput: raw,
        remediation: {
          text: `Start the listener: lsnrctl start ${sidArg || 'LISTENER'}`,
          copyCommand: `lsnrctl start ${sidArg || 'LISTENER'}`,
        },
      };
    }

    // Extract uptime
    const uptimeMatch = raw.match(/Uptime\s+(\d+ days? \d+ hr\. \d+ min\. \d+ sec\.|\S+)/i);
    const uptime = uptimeMatch ? uptimeMatch[1] : 'unknown';

    // Extract port from endpoints
    const portMatch = raw.match(/HOST=[\w.-]+\).*?PORT=(\d+)/i);
    if (portMatch) listenerPort = portMatch[1];

    // Count services registered
    const svcMatch = raw.match(/Services Summary\.{3}\s*([\s\S]*?)(?:\n\n|The command completed|$)/i);
    const serviceBlock = svcMatch ? svcMatch[1].trim() : '';
    const svcCount = (serviceBlock.match(/^".*?" has/gm) || []).length;

    return {
      status: 'pass',
      summary: `Listener UP · Uptime: ${uptime} · Port: ${listenerPort} · Services: ${svcCount}`,
      rawOutput: raw,
    };
  });

  // If listener is down, skip remaining steps
  if (listenerDown) {
    const zeroHandlerWarning = {
      step: 2,
      label: 'Listener services detail (lsnrctl services)',
      status: 'skip',
      summary: 'Skipped — listener is DOWN',
      rawOutput: '',
      remediation: null,
      duration_ms: 0,
    };
    steps.push(zeroHandlerWarning);
    steps.push({ step: 3, label: 'TNS reachability (tnsping)', status: 'skip', summary: 'Skipped — listener is DOWN', rawOutput: '', remediation: null, duration_ms: 0 });
    steps.push({ step: 4, label: 'DB instance check (sqlplus / as sysdba)', status: 'skip', summary: 'Skipped — listener is DOWN', rawOutput: '', remediation: null, duration_ms: 0 });
    steps.push({ step: 5, label: 'APPS connectivity (EBS only)', status: 'skip', summary: 'Skipped — listener is DOWN', rawOutput: '', remediation: null, duration_ms: 0 });
  } else {
    // ── Step 2: lsnrctl services ────────────────────────────────────────────

    await runStep(2, 'Listener services detail (lsnrctl services)', async () => {
      const sidArg = oracleSid ? oracleSid : '';
      const cmd = [
        `export ORACLE_HOME='${oracleHome}'`,
        `export ORACLE_SID='${oracleSid || ''}'`,
        `export PATH="$ORACLE_HOME/bin:$PATH"`,
        `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
        `$ORACLE_HOME/bin/lsnrctl services ${sidArg} 2>&1`,
      ].join(' && ');

      const { stdout, stderr } = await runRawSsh(conn, cmd, 25000);
      const raw = (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim();

      // Check for zero handlers — indicates a sick service
      const zeroHandlerMatches = raw.match(/Established:\s*\d+\s+Refused:\s*\d+\s+Current:\s*0/gi) || [];
      const warnings = [];
      if (zeroHandlerMatches.length > 0) {
        // Count services with 0 current connections AND find service name
        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/Current:\s+0\b/.test(lines[i])) {
            // Look back for the service name
            for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
              const svcMatch = lines[j].match(/^"([^"]+)"/);
              if (svcMatch) { warnings.push(svcMatch[1]); break; }
            }
          }
        }
      }

      // Count total services registered
      const svcNames = (raw.match(/^"[^"]+"(?: has \d+ instance| has \d+ handler)/gm) || []).map(s => s.match(/^"([^"]+)"/)[1]);
      const uniqueSvcs = [...new Set(svcNames)];

      if (warnings.length > 0) {
        return {
          status: 'warn',
          summary: `${uniqueSvcs.length} service(s) registered — ⚠ ${warnings.length} service(s) with 0 active handlers: ${warnings.slice(0, 3).join(', ')}`,
          rawOutput: raw,
          remediation: {
            text: 'Services with 0 handlers may be registered but not actively serving connections. Check if the instance is fully started.',
            copyCommand: null,
          },
        };
      }

      return {
        status: 'pass',
        summary: `${uniqueSvcs.length} service(s) registered with active handlers`,
        rawOutput: raw,
      };
    });

    // ── Step 3: TNS reachability ─────────────────────────────────────────────

    await runStep(3, 'TNS reachability (tnsping / port probe)', async () => {
      // tnsping from the DB host itself (proves local listener reachability)
      const targetHost = listenerHost;
      const targetPort = listenerPort;
      const svcOrSid   = oracleSid || conn.service_name || 'ORCL';

      // Build a minimal TNS descriptor for tnsping
      const tnsDesc = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${targetHost})(PORT=${targetPort}))(CONNECT_DATA=(SERVICE_NAME=${svcOrSid})))`;

      const cmd = [
        `export ORACLE_HOME='${oracleHome}'`,
        `export PATH="$ORACLE_HOME/bin:$PATH"`,
        `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
        // tnsping from the DB host itself
        `$ORACLE_HOME/bin/tnsping '${tnsDesc}' 3 2>&1`,
      ].join(' && ');

      const { stdout, stderr } = await runRawSsh(conn, cmd, 20000);
      const raw = (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim();

      // Also probe the port using nc/bash from the server side (TuneVault → DB host)
      // This catches firewall blocking TuneVault but not the DB host itself
      let serverSideResult = 'not attempted';
      try {
        const net  = require('net');
        const probeStart = Date.now();
        await new Promise((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(5000);
          socket.connect(parseInt(targetPort, 10), targetHost, () => {
            socket.destroy();
            resolve();
          });
          socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
          socket.on('error', reject);
        });
        const ms = Date.now() - probeStart;
        serverSideResult = `open (${ms}ms)`;
      } catch (e) {
        serverSideResult = `BLOCKED: ${e.message}`;
      }

      // Parse tnsping result
      const tnspingOk = /OK \(\d+ msec\)/.test(raw);
      const serverBlocked = serverSideResult.startsWith('BLOCKED');

      if (!tnspingOk && serverBlocked) {
        return {
          status: 'fail',
          summary: `TNS reachability FAILED — tnsping: failed, TuneVault→${targetHost}:${targetPort}: ${serverSideResult}`,
          rawOutput: `tnsping output:\n${raw}\n\nTuneVault server-side port probe: ${serverSideResult}`,
          remediation: {
            text: `TCP port ${targetPort} is blocked from TuneVault's server to ${targetHost}. Open firewall rule for TuneVault's egress IP on port ${targetPort}.`,
            copyCommand: `iptables -A INPUT -p tcp --dport ${targetPort} -j ACCEPT`,
          },
        };
      }

      if (!tnspingOk) {
        return {
          status: 'fail',
          summary: `tnsping from DB host failed — port ${targetPort} on ${targetHost}`,
          rawOutput: `tnsping output:\n${raw}\n\nTuneVault server-side port probe: ${serverSideResult}`,
          remediation: {
            text: `Listener may not be bound to ${targetHost}:${targetPort}. Check 'lsnrctl status' listener endpoints.`,
            copyCommand: `lsnrctl status`,
          },
        };
      }

      const msMatch = raw.match(/OK \((\d+) msec\)/);
      const ms = msMatch ? msMatch[1] : '?';

      return {
        status: 'pass',
        summary: `tnsping OK in ${ms}ms · TuneVault→${targetHost}:${targetPort}: ${serverSideResult}`,
        rawOutput: `tnsping output:\n${raw}\n\nTuneVault server-side port probe: ${serverSideResult}`,
      };
    });

    // ── Step 4: DB instance check ────────────────────────────────────────────

    await runStep(4, 'DB instance check (sqlplus / as sysdba)', async () => {
      const sqlScript = [
        'SET PAGESIZE 0',
        'SET FEEDBACK OFF',
        'SET HEADING OFF',
        'SELECT INSTANCE_NAME||\'|\' ||STATUS||\'|\'||DATABASE_STATUS||\'|\'||VERSION FROM V$INSTANCE;',
        'SELECT COUNT(*) FROM V$PDBS;',
        'EXIT;',
      ].join('\n');

      const cmd = [
        `export ORACLE_HOME='${oracleHome}'`,
        `export ORACLE_SID='${oracleSid || ''}'`,
        `export PATH="$ORACLE_HOME/bin:$PATH"`,
        `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
        `$ORACLE_HOME/bin/sqlplus -s / as sysdba <<'SQLEOF'\n${sqlScript}\nSQLEOF`,
      ].join(' && ');

      const { stdout, stderr } = await runRawSsh(conn, cmd, 30000);
      const raw = (stdout + (stderr ? '\nSTDERR: ' + stderr : '')).trim();

      // Check for connection errors
      if (/ORA-\d{4,5}|SP2-\d{4}|cannot connect|privilege not granted/i.test(raw) && !raw.includes('|')) {
        const oraCode = (raw.match(/ORA-\d{4,5}/i) || [])[0] || 'error';
        return {
          status: 'fail',
          summary: `sqlplus connect failed: ${oraCode}`,
          rawOutput: raw,
          remediation: {
            text: `Verify oracle OS user (${conn.ssh_db_user}) has SYSDBA privilege. Check ORACLE_SID=${oracleSid} is correct.`,
            copyCommand: `export ORACLE_SID=${oracleSid}; sqlplus / as sysdba`,
          },
        };
      }

      // Parse instance row: INSTANCE_NAME|STATUS|DATABASE_STATUS|VERSION
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const instanceLine = lines.find(l => l.includes('|'));
      const pdbLine      = lines.find(l => /^\d+$/.test(l));

      if (!instanceLine) {
        return {
          status: 'warn',
          summary: 'sqlplus ran but output was unexpected — check ORACLE_SID/HOME',
          rawOutput: raw,
          remediation: {
            text: `Confirm ORACLE_SID and ORACLE_HOME are correct for this instance.`,
            copyCommand: `echo $ORACLE_SID && echo $ORACLE_HOME`,
          },
        };
      }

      const [instanceName, status, dbStatus, version] = instanceLine.split('|').map(s => s.trim());
      const pdbCount = pdbLine ? parseInt(pdbLine, 10) : 0;
      const cdbLabel = pdbCount > 0 ? ` · CDB with ${pdbCount} PDB(s)` : '';

      if (status !== 'OPEN' || dbStatus !== 'ACTIVE') {
        return {
          status: 'fail',
          summary: `Instance ${instanceName} is ${status}/${dbStatus} (expected OPEN/ACTIVE)`,
          rawOutput: raw,
          remediation: {
            text: `Open the database: ALTER DATABASE OPEN; — then verify with: SELECT STATUS FROM V$INSTANCE;`,
            copyCommand: `sqlplus / as sysdba <<< "ALTER DATABASE OPEN; EXIT;"`,
          },
        };
      }

      return {
        status: 'pass',
        summary: `${instanceName} · ${status}/${dbStatus} · Oracle ${version}${cdbLabel}`,
        rawOutput: raw,
      };
    });

    // ── Step 5: APPS connectivity (EBS only) ─────────────────────────────────

    // Detect EBS: context.xml or ebs_login_url set
    const isEbs = !!(conn.ebs_login_url || conn.proxy_url);

    if (!isEbs) {
      steps.push({
        step: 5,
        label: 'APPS connectivity (EBS only)',
        status: 'skip',
        summary: 'Not an EBS connection — step skipped',
        rawOutput: '',
        remediation: null,
        duration_ms: 0,
      });
    } else {
      await runStep(5, 'APPS connectivity (EBS only)', async () => {
        // Try to detect APPS password from ebs_credentials table
        let appsPassword = null;
        try {
          const { decrypt } = require('../crypto-utils');
          const cred = await preflightDb.getEbsCredential(connId, 'apps');
          if (cred) {
            // Decrypt — iv+auth_tag stored as separate columns in ebs_credentials
            const encObj = { encryptedData: cred.encrypted_value, iv: cred.iv, authTag: cred.auth_tag };
            appsPassword = decrypt(encObj);
          }
        } catch (_) { /* no APPS cred stored — skip */ }

        if (!appsPassword) {
          return {
            status: 'skip',
            summary: 'APPS credentials not stored in vault — step skipped',
            rawOutput: '',
            remediation: {
              text: 'Store APPS password in the credential vault (Connections → EBS Credentials) to enable this check.',
              copyCommand: null,
            },
          };
        }

        // Use the recommended service (best-guess: first EBS service or SID)
        const svcForApps = conn.service_name || oracleSid;
        const targetHost = listenerHost;
        const targetPort = listenerPort;

        // Build a safe tnsping-style connect string test via sqlplus
        const safeAppsUser = 'apps';  // always 'apps' for EBS APPS user
        const sqlScript = [
          'SET PAGESIZE 0',
          'SET FEEDBACK OFF',
          'SET HEADING OFF',
          'SELECT \'APPS_OK:\'||INSTANCE_NAME FROM V$INSTANCE;',
          'EXIT;',
        ].join('\n');

        // We pass the password via process substitution / heredoc in a way that
        // doesn't expose it in ps output — pipe credentials via stdin
        // Format: apps/<password>@<host>:<port>/<service>
        const connectString = `${safeAppsUser}/"${appsPassword.replace(/"/g, '\\"')}"@${targetHost}:${targetPort}/${svcForApps}`;

        const cmd = [
          `export ORACLE_HOME='${oracleHome}'`,
          `export PATH="$ORACLE_HOME/bin:$PATH"`,
          `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
          `$ORACLE_HOME/bin/sqlplus -s '${connectString}' <<'SQLEOF'\n${sqlScript}\nSQLEOF`,
        ].join(' && ');

        const { stdout, stderr } = await runRawSsh(conn, cmd, 25000);
        // IMPORTANT: scrub password from raw output before storing
        const rawUnsafe = stdout + (stderr ? '\nSTDERR: ' + stderr : '');
        const raw = rawUnsafe.replace(new RegExp(appsPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***').trim();

        if (/APPS_OK:/.test(raw)) {
          const instanceName = (raw.match(/APPS_OK:(\S+)/i) || [])[1] || 'connected';
          return {
            status: 'pass',
            summary: `APPS connected to ${instanceName} via ${targetHost}:${targetPort}/${svcForApps}`,
            rawOutput: raw,
          };
        }

        const oraCode = (raw.match(/ORA-\d{4,5}/i) || [])[0] || 'connect failed';
        return {
          status: 'fail',
          summary: `APPS connect failed: ${oraCode} to ${svcForApps}`,
          rawOutput: raw,
          remediation: {
            text: `Verify APPS password in the credential vault, and that service ${svcForApps} is registered with the listener.`,
            copyCommand: null,
          },
        };
      });
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────────────

  const totalMs   = Date.now() - startTotal;
  const passed    = steps.filter(s => s.status === 'pass').length;
  const failed    = steps.filter(s => s.status === 'fail' || s.status === 'error').length;
  const skipped   = steps.filter(s => s.status === 'skip').length;
  const warned    = steps.filter(s => s.status === 'warn').length;

  // Overall: pass only if no failures/errors; warn if warnings; fail otherwise
  let overallStatus = 'pass';
  if (failed > 0)  overallStatus = 'fail';
  else if (warned > 0) overallStatus = 'warn';

  await preflightDb.finalizeRun({
    runId,
    overallStatus,
    steps,
    stepsPassed:  passed,
    stepsFailed:  failed + warned,
    stepsSkipped: skipped,
    totalDurationMs: totalMs,
    errorMessage: failed > 0 ? `${failed} step(s) failed` : null,
  }).catch(err => console.error('[listener-preflight] finalize error:', err.message));

  res.json({
    runId,
    overallStatus,
    steps,
    stepsPassed:  passed,
    stepsFailed:  failed,
    stepsWarned:  warned,
    stepsSkipped: skipped,
    totalDurationMs: totalMs,
  });
});

module.exports = router;
