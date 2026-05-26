/**
 * routes/ebs-runbooks.js — Live EBS SSH runbooks using connection_ssh_profiles.
 *
 * Owns: Three interactive EBS runbooks dispatched via agent channel:
 *   POST /api/ebs-runbooks/cm-status/:connectionId   — CM status query
 *   POST /api/ebs-runbooks/cm-bounce/:connectionId   — SSE: stop → start Concurrent Manager
 *   GET  /api/ebs-runbooks/alert-log/:connectionId   — SSE: live tail Oracle alert log (db_host)
 *   GET  /api/ebs-runbooks/adop-status/:connectionId — ADOP phase status (apps_tier + DB fallback)
 *   GET  /api/ebs-runbooks/telemetry                 — emit runbook_executed event
 *   GET  /ebs-runbooks/cm-status-bounce              — serve UI page
 *   GET  /ebs-runbooks/alert-log-tail                — serve UI page
 *   GET  /ebs-runbooks/adop-phase-status             — serve UI page
 *
 * Does NOT own: credential storage (db/ssh-profiles.js), Oracle DB queries (oracle-client.js),
 *               general connection CRUD, SSH command execution for non-runbook ops.
 *
 * Security model:
 *   - Credentials decrypted in memory only, passed to agent, never logged.
 *   - All SSH commands are server-defined constants, no user input substituted.
 *   - Ownership of oracle_connection verified per request.
 *   - Falls back gracefully when no SSH profile is configured for a role.
 */

'use strict';

const express = require('express');
const path    = require('path');
const sshProfilesDb = require('../db/ssh-profiles');
const runbooksDb    = require('../db/ebs-runbooks');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────

// Agent-side SSH command keys — agent dispatches these via paramiko
const SSH_COMMANDS = {
  // Concurrent Manager
  CM_STATUS:  '/api/ssh-run',  // body: { command: 'adcmctl.sh status apps/<pw>', env_file: ... }
  CM_STOP:    '/api/ssh-run',
  CM_START:   '/api/ssh-run',
  // Alert log tail (db_host)
  ALERT_LOG_TAIL: '/api/ssh-run',
  ALERT_LOG_PATH: '/api/ssh-run',
  // ADOP status
  ADOP_STATUS: '/api/ssh-run',
};

// Hard timeouts per operation
const TIMEOUT_CM_STATUS   = 30_000;   // 30s
const TIMEOUT_CM_STOP     = 120_000;  // 2 min
const TIMEOUT_CM_START    = 180_000;  // 3 min
const TIMEOUT_ADOP_STATUS = 30_000;   // 30s
const TIMEOUT_ALERT_PATH  = 15_000;   // 15s for discovering alert log path
const SSE_HARD_TIMEOUT    = 10 * 60 * 1000; // 10 min SSE hard-limit

// ── Page routes ───────────────────────────────────────────────────────────────

router.get('/ebs-runbooks/cm-status-bounce', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'runbooks', 'cm-status-bounce.html'));
});

router.get('/ebs-runbooks/alert-log-tail', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'runbooks', 'alert-log-tail.html'));
});

router.get('/ebs-runbooks/adop-phase-status', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'runbooks', 'adop-phase-status.html'));
});

// ── Shared helpers ────────────────────────────────────────────────────────────

// Ownership check delegated to db layer
const getOwnedConnection = runbooksDb.getOwnedConnection;

/**
 * Build the credential body to send to the agent for SSH command execution.
 * Credentials are decrypted in memory only — never logged.
 */
function buildSshRunBody(profile, command) {
  const body = {
    host:        profile.ssh_host,
    port:        profile.ssh_port || 22,
    username:    profile.ssh_user,
    auth_method: profile.auth_method,
    command,
    known_hosts_pin: profile.known_hosts_pin || null,
  };

  if (profile.auth_method === 'key_upload' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      body.key_content    = bundle.key;
      body.key_passphrase = bundle.passphrase || null;
    } catch (_) { /* agent will report auth error */ }
  }

  if (profile.auth_method === 'password' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      body.password = bundle.password;
    } catch (_) {}
  }

  if (profile.bastion_host) {
    body.bastion = {
      host:     profile.bastion_host,
      port:     profile.bastion_port || 22,
      username: profile.bastion_user || body.username,
    };
    if (profile.bastion_key_encrypted) {
      try {
        const bundle = JSON.parse(decrypt(profile.bastion_key_encrypted));
        body.bastion.key_content    = bundle.key;
        body.bastion.key_passphrase = bundle.passphrase || null;
      } catch (_) {}
    }
  }

  return body;
}

/**
 * Emit a SSE event. No-ops if the response stream is already closed.
 */
function sse(res, payload) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// Telemetry delegated to db layer
const emitTelemetry = runbooksDb.emitRunbookTelemetry;

// ── Runbook 1: Concurrent Manager status ─────────────────────────────────────

/**
 * POST /api/ebs-runbooks/cm-status/:connectionId
 * Body: {} (no params needed)
 *
 * Resolves apps_tier SSH profile (falls back to concurrent_tier).
 * Runs adcmctl.sh status via agent → returns parsed CM table.
 */
router.post('/cm-status/:connectionId', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.connectionId, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connectionId' });

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'CM runbook requires an agent connection', code: 'NOT_AGENT' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.json({ ok: false, state: 'agent_offline', message: 'Agent offline — check systemctl status tunevault-agent' });
    }

    // Resolve profile: apps_tier first, fall back to concurrent_tier
    let profile = await sshProfilesDb.getProfileWithKeys(connectionId, 'apps_tier');
    let roleUsed = 'apps_tier';
    if (!profile) {
      profile = await sshProfilesDb.getProfileWithKeys(connectionId, 'concurrent_tier');
      roleUsed = 'concurrent_tier';
    }

    if (!profile) {
      return res.json({
        ok: false,
        state: 'no_profile',
        message: 'No apps_tier or concurrent_tier SSH profile configured.',
        setup_url: `/connections/${connectionId}/ssh`,
      });
    }

    // adcmctl.sh status — password substitution is done on the agent side from the EBS env
    const command = 'adcmctl.sh status apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS)';
    const body = buildSshRunBody(profile, command);

    const t0 = Date.now();
    let agentResp;
    try {
      agentResp = await channel.sendToAgent(connectionId, {
        method: 'POST',
        path: '/api/ssh-run',
        body,
      }, TIMEOUT_CM_STATUS);
    } catch (_) {
      return res.json({ ok: false, state: 'timeout', message: 'CM status timed out after 30s' });
    }

    const durationMs = Date.now() - t0;
    const respBody = agentResp?.body || {};
    emitTelemetry({ runbookId: 'cm-status', connectionId, role: roleUsed, durationMs, exitCode: respBody.exit_code, userId: req.user.id });

    if (agentResp.statusCode !== 200 || !respBody.ok) {
      return res.json({ ok: false, state: 'ssh_failed', message: respBody.error || 'SSH command failed', stdout: respBody.stdout, stderr: respBody.stderr });
    }

    // Parse adcmctl.sh output → table rows
    const parsed = parseCmStatusOutput(respBody.stdout || '');
    res.json({ ok: true, parsed, raw: respBody.stdout, role_used: roleUsed, duration_ms: durationMs });

  } catch (err) {
    console.error('[ebs-runbooks] cm-status error:', err.message);
    res.status(500).json({ error: 'CM status failed: ' + err.message });
  }
});

/**
 * Parse adcmctl.sh status output into structured rows.
 * Output lines look like:
 *   Concurrent Processing Tier is Active: <SID>
 *   Internal Concurrent Manager is Active with PID <pid>
 *   <Queue Manager Name>    Target=<n>  Actual=<n>  ...
 */
function parseCmStatusOutput(stdout) {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const managers = [];
  let tierStatus = 'unknown';
  let icmPid = null;

  for (const line of lines) {
    // Tier active line
    if (/Concurrent Processing Tier is (Active|Inactive)/i.test(line)) {
      tierStatus = /Active/i.test(line) ? 'active' : 'inactive';
      continue;
    }
    // ICM PID line
    const icmMatch = line.match(/Internal Concurrent Manager is (\w+)(?: with PID (\d+))?/i);
    if (icmMatch) {
      icmPid = icmMatch[2] || null;
      managers.push({ name: 'Internal Concurrent Manager', status: icmMatch[1], pid: icmPid, target: null, actual: null });
      continue;
    }
    // Queue manager line — format varies by EBS version, try best-effort
    const qmMatch = line.match(/^(.+?)\s+(?:Target=(\d+))?\s*(?:Actual=(\d+))?/i);
    if (qmMatch && qmMatch[1] && (qmMatch[2] || qmMatch[3])) {
      managers.push({
        name:   qmMatch[1].trim(),
        status: 'listed',
        pid:    null,
        target: qmMatch[2] ? parseInt(qmMatch[2], 10) : null,
        actual: qmMatch[3] ? parseInt(qmMatch[3], 10) : null,
      });
    }
  }

  return { tier_status: tierStatus, icm_pid: icmPid, managers, raw_line_count: lines.length };
}

// ── Runbook 1b: Concurrent Manager bounce (SSE) ───────────────────────────────

/**
 * POST /api/ebs-runbooks/cm-bounce/:connectionId   (SSE stream)
 * Body: { confirmed: true }
 *
 * Requires confirmed=true — prevents accidental bounce.
 * Stream events:
 *   { type: 'step', phase: 'stopping'|'status_check'|'starting'|'done', message, data }
 *   { type: 'error', message }
 *   { type: 'complete', duration_ms }
 */
router.post('/cm-bounce/:connectionId', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.connectionId, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connectionId' });

  if (!req.body?.confirmed) {
    return res.status(400).json({ error: 'confirmed: true required for CM bounce' });
  }

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'CM bounce requires an agent connection', code: 'NOT_AGENT' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.status(503).json({ error: 'Agent offline — cannot execute CM bounce' });
    }

    let profile = await sshProfilesDb.getProfileWithKeys(connectionId, 'apps_tier');
    let roleUsed = 'apps_tier';
    if (!profile) {
      profile = await sshProfilesDb.getProfileWithKeys(connectionId, 'concurrent_tier');
      roleUsed = 'concurrent_tier';
    }
    if (!profile) {
      return res.status(400).json({ error: 'No apps_tier or concurrent_tier SSH profile configured.', setup_url: `/connections/${connectionId}/ssh` });
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const t0 = Date.now();

    req.on('close', () => { closed = true; });

    const hardTimer = setTimeout(() => {
      sse(res, { type: 'error', message: 'Hard timeout reached (10 min)' });
      if (!res.writableEnded) res.end();
    }, SSE_HARD_TIMEOUT);

    const send = (payload) => { if (!closed) sse(res, payload); };

    const runCmd = async (command, timeoutMs) => {
      const body = buildSshRunBody(profile, command);
      try {
        const resp = await channel.sendToAgent(connectionId, {
          method: 'POST',
          path: '/api/ssh-run',
          body,
        }, timeoutMs);
        return resp?.body || { ok: false, error: 'No response from agent' };
      } catch (_) {
        return { ok: false, error: `Timed out after ${timeoutMs / 1000}s` };
      }
    };

    try {
      // Phase 1: Stop
      if (closed) return res.end();
      send({ type: 'step', phase: 'stopping', message: 'Stopping Concurrent Manager (adcmctl.sh stop)…' });
      const stopResult = await runCmd('adcmctl.sh stop apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS)', TIMEOUT_CM_STOP);
      send({ type: 'step', phase: 'stop_result', message: stopResult.ok ? 'Stop command sent.' : `Stop returned: ${stopResult.error || 'unknown error'}`, data: { stdout: stopResult.stdout, stderr: stopResult.stderr, exit_code: stopResult.exit_code } });

      if (closed) return res.end();

      // Phase 2: Verify stopped (status check)
      send({ type: 'step', phase: 'status_check', message: 'Checking CM status…' });
      const statusResult = await runCmd('adcmctl.sh status apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS)', TIMEOUT_CM_STATUS);
      const parsed = parseCmStatusOutput(statusResult.stdout || '');
      send({ type: 'step', phase: 'status_after_stop', message: `Tier status after stop: ${parsed.tier_status}`, data: parsed });

      if (closed) return res.end();

      // Phase 3: Start
      send({ type: 'step', phase: 'starting', message: 'Starting Concurrent Manager (adcmctl.sh start)…' });
      const startResult = await runCmd('adcmctl.sh start apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS)', TIMEOUT_CM_START);
      send({ type: 'step', phase: 'start_result', message: startResult.ok ? 'Start command sent.' : `Start returned: ${startResult.error || 'unknown error'}`, data: { stdout: startResult.stdout, stderr: startResult.stderr, exit_code: startResult.exit_code } });

      if (closed) return res.end();

      // Phase 4: Final status
      send({ type: 'step', phase: 'final_status', message: 'Checking final CM status…' });
      const finalStatus = await runCmd('adcmctl.sh status apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS)', TIMEOUT_CM_STATUS);
      const finalParsed = parseCmStatusOutput(finalStatus.stdout || '');
      send({ type: 'step', phase: 'final_status_result', message: `Final tier status: ${finalParsed.tier_status}`, data: finalParsed });

      const durationMs = Date.now() - t0;
      emitTelemetry({ runbookId: 'cm-bounce', connectionId, role: roleUsed, durationMs, exitCode: startResult.exit_code, userId: req.user.id });

      send({ type: 'complete', duration_ms: durationMs, tier_status: finalParsed.tier_status });
    } catch (err) {
      send({ type: 'error', message: 'Bounce failed: ' + err.message });
    } finally {
      clearTimeout(hardTimer);
      if (!res.writableEnded) res.end();
    }

  } catch (err) {
    console.error('[ebs-runbooks] cm-bounce error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// ── Runbook 2: Alert log live tail (SSE) ─────────────────────────────────────

/**
 * GET /api/ebs-runbooks/alert-log/:connectionId   (SSE stream)
 * Query: filter (optional ORA- code filter)
 *
 * Resolves db_host SSH profile.
 * Discovers alert log path via v$diag_info query sent through agent, then tails it.
 * Stream events:
 *   { type: 'info',    text }
 *   { type: 'line',    text, is_error: bool, ora_code: string|null }
 *   { type: 'error',   message }
 *   { type: 'done',    reason }
 */
router.get('/alert-log/:connectionId', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.connectionId, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connectionId' });

  const filterCode = (req.query.filter || '').replace(/[^A-Z0-9\-]/gi, '').substring(0, 20); // sanitize ORA- filter

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Alert log tail requires an agent connection', code: 'NOT_AGENT' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.status(503).json({ error: 'Agent offline' });
    }

    // db_host profile required for alert log
    const profile = await sshProfilesDb.getProfileWithKeys(connectionId, 'db_host');
    if (!profile) {
      return res.json({
        ok: false,
        state: 'no_profile',
        message: 'No db_host SSH profile configured.',
        setup_url: `/connections/${connectionId}/ssh`,
      });
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const t0 = Date.now();
    req.on('close', () => { closed = true; });

    const hardTimer = setTimeout(() => {
      sse(res, { type: 'done', reason: 'timeout_10min' });
      if (!res.writableEnded) res.end();
    }, SSE_HARD_TIMEOUT);

    const send = (payload) => { if (!closed) sse(res, payload); };

    try {
      // Step 1: Discover alert log path from v$diag_info via agent Oracle query
      send({ type: 'info', text: '[alert-log] Discovering alert log path from v$diag_info…' });

      const discoverBody = buildSshRunBody(profile,
        // Use sqlplus to query v$diag_info — fallback to env-based discovery
        "sqlplus -s / as sysdba <<'EOF'\nSET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON\nSELECT value FROM v\\$diag_info WHERE name='Diag Trace';\nEXIT;\nEOF"
      );
      let alertLogPath = null;

      try {
        const discoverResp = await channel.sendToAgent(connectionId, {
          method: 'POST',
          path: '/api/ssh-run',
          body: discoverBody,
        }, TIMEOUT_ALERT_PATH);

        const discoverOut = (discoverResp?.body?.stdout || '').trim();
        // Output should be a filesystem path like /u01/app/oracle/diag/rdbms/prod/prod/trace
        const pathMatch = discoverOut.match(/^(\/[^\s]+)/m);
        if (pathMatch) {
          // Construct alert log path: <Diag Trace>/../alert/log.xml or alert_<SID>.log
          const traceDir = pathMatch[1].trim();
          alertLogPath = `${traceDir}/../alert`;
          send({ type: 'info', text: `[alert-log] Diag Trace dir: ${traceDir}` });
        }
      } catch (_) {
        send({ type: 'info', text: '[alert-log] v$diag_info query timed out — using env-based discovery' });
      }

      if (closed) return res.end();

      // Step 2: Tail the alert log. Use flexible discovery if path unknown.
      const SID_PLACEHOLDER = '$(echo $ORACLE_SID)';
      let tailCmd;
      if (alertLogPath) {
        // Try XML alert log first (12c+), fall back to classic .log
        tailCmd = `tail -n 200 -F "${alertLogPath}/log.xml" 2>/dev/null || ` +
                  `find "${alertLogPath}/.." -name "alert_${SID_PLACEHOLDER}.log" 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || ` +
                  `find $ORACLE_BASE/diag -name "alert_${SID_PLACEHOLDER}.log" 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || echo 'ALERT_LOG_NOT_FOUND'`;
      } else {
        tailCmd = `find $ORACLE_BASE/diag -name "alert_${SID_PLACEHOLDER}.log" 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || ` +
                  `find /u01/app/oracle/diag -name "alert_*.log" 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || echo 'ALERT_LOG_NOT_FOUND'`;
      }

      send({ type: 'info', text: '[alert-log] Starting alert log tail (tail -F)…' });

      // Use a streaming approach via repeated agent polls (agent sends chunks back)
      // Since agent channel is request/response (not streaming), we poll every 8s
      let lastLineCount = 0;
      let pollCount = 0;

      const POLL_INTERVAL = 8_000;
      const snapshotCmd = tailCmd.replace(/-F/g, '').trim();

      const doPoll = async () => {
        if (closed) return;
        const body = buildSshRunBody(profile, snapshotCmd);
        try {
          const resp = await channel.sendToAgent(connectionId, {
            method: 'POST',
            path: '/api/ssh-run',
            body,
          }, 20_000);

          if (closed) return;

          const stdout = resp?.body?.stdout || '';
          if (stdout === 'ALERT_LOG_NOT_FOUND' || stdout.includes('ALERT_LOG_NOT_FOUND')) {
            send({ type: 'error', message: 'Alert log not found. Ensure ORACLE_BASE/ORACLE_SID env vars are set for the oracle OS user.' });
            clearTimeout(hardTimer);
            if (!res.writableEnded) res.end();
            return;
          }

          const allLines = stdout.split('\n');
          const newLines = allLines.slice(lastLineCount);
          lastLineCount = allLines.length;

          for (const line of newLines) {
            if (!line.trim()) continue;
            const isError = /ORA-\d+|TNS-\d+|Error/i.test(line);
            const oraMatch = line.match(/(ORA-\d+|TNS-\d+)/i);
            const oraCode = oraMatch ? oraMatch[1].toUpperCase() : null;

            // Apply optional ORA- filter
            if (filterCode && oraCode && !oraCode.includes(filterCode.toUpperCase())) continue;
            if (filterCode && !isError) continue;

            if (!closed) send({ type: 'line', text: line, is_error: isError, ora_code: oraCode });
          }

          if (pollCount === 0 && allLines.filter(l => l.trim()).length === 0) {
            send({ type: 'info', text: '[alert-log] Log appears empty or not yet populated' });
          }
        } catch (_) {
          if (!closed) send({ type: 'info', text: '[alert-log] Poll timed out — retrying…' });
        }

        pollCount++;
      };

      // Initial fetch then interval
      await doPoll();
      const pollTimer = setInterval(doPoll, POLL_INTERVAL);

      req.on('close', () => {
        clearInterval(pollTimer);
        clearTimeout(hardTimer);
        const durationMs = Date.now() - t0;
        emitTelemetry({ runbookId: 'alert-log-tail', connectionId, role: 'db_host', durationMs, exitCode: 0, userId: req.user.id });
        if (!res.writableEnded) res.end();
      });

    } catch (err) {
      send({ type: 'error', message: 'Alert log tail failed: ' + err.message });
      clearTimeout(hardTimer);
      if (!res.writableEnded) res.end();
    }

  } catch (err) {
    console.error('[ebs-runbooks] alert-log error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else if (!res.writableEnded) res.end();
  }
});

// ── Runbook 3: ADOP phase status ──────────────────────────────────────────────

/**
 * GET /api/ebs-runbooks/adop-status/:connectionId
 * Returns ADOP session status via SSH (apps_tier primary) with DB fallback.
 *
 * Response:
 *   { ok, source: 'ssh'|'db'|'none', session: {...}, nodes: [...], raw }
 */
router.get('/adop-status/:connectionId', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.connectionId, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connectionId' });

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'ADOP status requires an agent connection', code: 'NOT_AGENT' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.json({ ok: false, state: 'agent_offline', message: 'Agent offline' });
    }

    const t0 = Date.now();
    let source = 'none';
    let sessionData = null;

    // Primary path: SSH → adop -status on apps_tier
    const sshProfile = await sshProfilesDb.getProfileWithKeys(connectionId, 'apps_tier');

    if (sshProfile) {
      // adop -status outputs a structured table
      const body = buildSshRunBody(sshProfile, 'adop -status 2>&1');
      try {
        const resp = await channel.sendToAgent(connectionId, {
          method: 'POST',
          path: '/api/ssh-run',
          body,
        }, TIMEOUT_ADOP_STATUS);

        const stdout = resp?.body?.stdout || '';
        const exitCode = resp?.body?.exit_code;

        if (resp?.body?.ok !== false || exitCode === 0 || stdout.length > 10) {
          sessionData = parseAdopStatusOutput(stdout);
          sessionData.raw = stdout;
          source = 'ssh';
        }
      } catch (_) {
        // SSH timed out — fall through to DB path
      }
    }

    // Fallback path: query AD_ADOP_SESSIONS + AD_ADOP_SESSION_PATCHES via agent Oracle query
    if (source === 'none') {
      const dbQuery = `
SELECT s.session_id, s.prepare_status, s.apply_status, s.finalize_status,
       s.cutover_status, s.cleanup_status, s.abandon_status,
       s.start_date, s.end_date, s.bug_number,
       n.node_name, n.prepare_status as node_prepare, n.apply_status as node_apply,
       n.finalize_status as node_finalize, n.cutover_status as node_cutover,
       n.cleanup_status as node_cleanup
FROM   AD_ADOP_SESSIONS s
       LEFT JOIN AD_ADOP_SESSION_PATCHES n ON n.session_id = s.session_id
WHERE  s.session_id = (SELECT MAX(session_id) FROM AD_ADOP_SESSIONS)
ORDER  BY n.node_name`;

      try {
        const dbBody = buildSshRunBody(
          sshProfile || await sshProfilesDb.getProfileWithKeys(connectionId, 'concurrent_tier'),
          `sqlplus -s apps/$(cat $APPL_TOP/../fs_ne/inst/apps/*/appl/admin/*.txt 2>/dev/null | head -1 || echo APPS) <<'EOF'\nSET PAGESIZE 100 LINESIZE 300 FEEDBACK OFF HEADING ON TRIMSPOOL ON\n${dbQuery};\nEXIT;\nEOF`
        );
        if (dbBody) {
          const dbResp = await channel.sendToAgent(connectionId, {
            method: 'POST',
            path: '/api/ssh-run',
            body: dbBody,
          }, 30_000);
          const dbOut = dbResp?.body?.stdout || '';
          if (dbOut.trim().length > 0) {
            sessionData = { raw: dbOut, source: 'db_query', nodes: [], session: null };
            source = 'db';
          }
        }
      } catch (_) { /* DB path also failed */ }
    }

    const durationMs = Date.now() - t0;
    emitTelemetry({ runbookId: 'adop-phase-status', connectionId, role: 'apps_tier', durationMs, exitCode: 0, userId: req.user.id });

    if (!sessionData) {
      const hasProfile = !!sshProfile;
      return res.json({
        ok: false,
        state: hasProfile ? 'no_data' : 'no_profile',
        message: hasProfile
          ? 'adop -status returned no output. EBS may not be configured or no active ADOP session.'
          : 'No apps_tier SSH profile configured.',
        setup_url: hasProfile ? null : `/connections/${connectionId}/ssh`,
      });
    }

    res.json({ ok: true, source, ...sessionData, duration_ms: durationMs });

  } catch (err) {
    console.error('[ebs-runbooks] adop-status error:', err.message);
    res.status(500).json({ error: 'ADOP status failed: ' + err.message });
  }
});

/**
 * Parse `adop -status` output into structured data.
 * adop -status output format (EBS 12.2):
 *
 *   Session ID: 123
 *   Status    : IN PROGRESS
 *   Phase     : APPLY
 *   ...
 *   Node Status:
 *   Node          Prepare   Apply   Finalize  Cutover  Cleanup
 *   ----------    -------   -----   --------  -------  -------
 *   hostname      N/A       RUNNING N/A       N/A      N/A
 */
function parseAdopStatusOutput(stdout) {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const session = {
    session_id:    null,
    status:        null,
    current_phase: null,
    bug_number:    null,
    start_date:    null,
    abandoned:     false,
  };
  const nodes = [];

  let inNodeTable = false;
  let nodeHeaderParsed = false;

  for (const line of lines) {
    if (/^Session\s+ID\s*:/i.test(line))     { session.session_id = line.split(':').slice(1).join(':').trim(); continue; }
    if (/^Status\s*:/i.test(line))            { session.status = line.split(':').slice(1).join(':').trim(); continue; }
    if (/^Phase\s*:/i.test(line))             { session.current_phase = line.split(':').slice(1).join(':').trim(); continue; }
    if (/^Bug\s+Number\s*:/i.test(line))      { session.bug_number = line.split(':').slice(1).join(':').trim(); continue; }
    if (/^Start\s+Date\s*:/i.test(line))      { session.start_date = line.split(':').slice(1).join(':').trim(); continue; }
    if (/abandon/i.test(line))                { session.abandoned = true; }

    if (/Node\s+Status/i.test(line)) { inNodeTable = true; continue; }
    if (inNodeTable && /^-{3,}/.test(line))   { nodeHeaderParsed = true; continue; }
    if (inNodeTable && nodeHeaderParsed && line.length > 5 && !/^Node\s+Prepare/i.test(line)) {
      const parts = line.split(/\s{2,}/);
      if (parts.length >= 2) {
        nodes.push({
          node_name:      parts[0] || '',
          prepare_status: parts[1] || 'N/A',
          apply_status:   parts[2] || 'N/A',
          finalize_status: parts[3] || 'N/A',
          cutover_status:  parts[4] || 'N/A',
          cleanup_status:  parts[5] || 'N/A',
        });
      }
    }
  }

  return { session, nodes };
}

module.exports = router;
