/**
 * routes/ssh-tail.js — Live log tailing via SSH, streamed as SSE.
 *
 * Owns: GET /api/ssh-tail/logs/:connectionId/:logKey (SSE stream)
 *       GET /api/ssh-tail/catalog (available log keys for a connection)
 * Does NOT own: credential storage (db/ssh-targets.js), Oracle DB queries,
 *               command execution for non-tail ops (services/ssh-executor.js).
 *
 * Security model:
 *   - logKey is validated against LOG_WHITELIST before any SSH attempt.
 *   - connectionId ownership is verified against the authenticated user.
 *   - tail command is constructed server-side — no user-supplied shell fragments.
 *   - Hard timeout 30 min per stream; client disconnect kills the SSH channel.
 *   - Each tail session writes one ssh_audit row on close.
 *
 * Proxy mode note: oracle proxy /api/ssh/exec does not stream; for proxy connections
 *   the endpoint returns a snapshot (last N lines) every PROXY_POLL_INTERVAL_MS,
 *   deduplicating lines by tracking the last emitted line count.
 */

'use strict';

const express  = require('express');
const { Client } = require('ssh2');
const https    = require('https');
const http     = require('http');

const pool    = require('../db/index');
const sshDb   = require('../db/ssh-targets');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const HARD_TIMEOUT_MS      = 30 * 60 * 1000; // 30 min max per stream
const PROXY_POLL_INTERVAL  = 8_000;           // ms between proxy snapshot polls
const PROXY_TAIL_LINES     = 100;             // lines per proxy poll fetch

// ─── Log whitelist ────────────────────────────────────────────────────────────
// key → { label, tailCmd, roles, category }
// tailCmd is a complete shell string; no user input is substituted into it.
// All paths use EBS environment variables — the apps tier user's shell sets them.

const LOG_WHITELIST = {
  // ── oacore ────────────────────────────────────────────────────────────────
  'oacore.out': {
    label: 'oacore_server1.out',
    tailCmd: "find $DOMAIN_HOME/servers/oacore_server1/logs -name '*.out' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || find $INST_TOP -name 'oacore_server1.out' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'OACore',
  },
  'oacore.err': {
    label: 'oacore_server1.err',
    tailCmd: "find $DOMAIN_HOME/servers/oacore_server1/logs -name '*.err' -o -name 'oacore_server1.err' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'OACore',
  },
  // ── Apache / OHS ──────────────────────────────────────────────────────────
  'apache.error': {
    label: 'Apache error_log',
    tailCmd: "find $INST_TOP/apps/logs -name 'error_log' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || find $ORACLE_HOME/Apache/Apache/logs -name 'error_log' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'Apache / OHS',
  },
  'apache.access': {
    label: 'Apache access_log',
    tailCmd: "find $INST_TOP/apps/logs -name 'access_log' 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || find $ORACLE_HOME/Apache/Apache/logs -name 'access_log' 2>/dev/null | head -1 | xargs tail -n 200 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'Apache / OHS',
  },
  // ── OPMN ──────────────────────────────────────────────────────────────────
  'opmn.log': {
    label: 'opmn.log',
    tailCmd: "find $INST_TOP -name 'opmn.log' 2>/dev/null | head -1 | xargs tail -n 500 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'OPMN',
  },
  'oc4j.oafm': {
    label: 'OC4J~oafm~default_island log',
    tailCmd: "find $DOMAIN_HOME/servers -name 'OC4J~oafm~*.log' 2>/dev/null | head -1 | xargs tail -n 300 -F 2>/dev/null || find $INST_TOP -name 'OC4J~oafm~*.log' 2>/dev/null | head -1 | xargs tail -n 300 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'OPMN',
  },
  // ── Forms ─────────────────────────────────────────────────────────────────
  'forms.out': {
    label: 'FormsServer.out',
    tailCmd: "find $DOMAIN_HOME/servers -name 'FormsServer-*.out' -o -name 'FormsServer.out' 2>/dev/null | head -1 | xargs tail -n 300 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'Forms',
  },
  // ── Workflow Mailer ───────────────────────────────────────────────────────
  'wf.mailer': {
    label: 'Workflow Mailer log',
    tailCmd: "find $APPLCSF/log -name '*WFMLRSVC*.log' -o -name '*WFMAILER*.txt' 2>/dev/null | sort -t_ -k1 | tail -1 | xargs tail -n 300 -F 2>/dev/null || find $APPL_TOP/fnd/12.0.0/secure -name 'mailer*.log' 2>/dev/null | head -1 | xargs tail -n 300 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'Workflow',
  },
  // ── Concurrent Manager ────────────────────────────────────────────────────
  'cm.manager': {
    label: 'Concurrent Manager log (<SID>_<MMDD>.mgr)',
    tailCmd: "find ${APPLCSF}/${APPLLOG} -name '*.mgr' 2>/dev/null | sort | tail -1 | xargs tail -n 300 -F 2>/dev/null || find $APPLCSF/log -name '*.mgr' 2>/dev/null | sort | tail -1 | xargs tail -n 300 -F 2>/dev/null || echo 'LOG_NOT_FOUND'",
    roles: ['apps_tier'],
    category: 'Concurrent Managers',
  },
  // ── ADOP log ──────────────────────────────────────────────────────────────
  'adop.log': {
    label: 'Active ADOP session log',
    tailCmd: "find $APPL_TOP/../fs_ne/EBSapps/log/adop -name 'adop_*.log' 2>/dev/null | sort -t_ -k2 | tail -1 | xargs tail -n 200 -F 2>/dev/null || echo 'NO_ACTIVE_ADOP_LOG'",
    roles: ['apps_tier'],
    category: 'ADOP / Patching',
  },
  'adop.apply': {
    label: 'ADOP apply phase log',
    tailCmd: "find $APPL_TOP/../fs_ne/EBSapps/log/adop -path '*/apply/adop_*.log' 2>/dev/null | sort | tail -1 | xargs tail -n 200 -F 2>/dev/null || echo 'NO_ADOP_APPLY_LOG'",
    roles: ['apps_tier'],
    category: 'ADOP / Patching',
  },
  // ── AutoConfig ────────────────────────────────────────────────────────────
  'autoconfig.log': {
    label: 'AutoConfig (adconfig.log)',
    tailCmd: "find $INST_TOP/admin/log -name 'adconfig.log' 2>/dev/null | sort -t/ -k7 | tail -1 | xargs tail -n 300 -F 2>/dev/null || echo 'NO_AUTOCONFIG_LOG'",
    roles: ['apps_tier'],
    category: 'AutoConfig',
  },
  'autoconfig.nsh': {
    label: 'AutoConfig NetServiceHandler.log',
    tailCmd: "find $INST_TOP/admin/log -name 'NetServiceHandler.log' 2>/dev/null | sort -t/ -k7 | tail -1 | xargs tail -n 200 -F 2>/dev/null || echo 'NO_NETSERVICEHANDLER_LOG'",
    roles: ['apps_tier'],
    category: 'AutoConfig',
  },
  // ── adadmin ───────────────────────────────────────────────────────────────
  'adadmin.log': {
    label: 'adadmin.log',
    tailCmd: "tail -n 300 -F $APPL_TOP/admin/${TWO_TASK}/log/adadmin.log 2>/dev/null || find $APPL_TOP/admin -name 'adadmin.log' 2>/dev/null | sort | tail -1 | xargs tail -n 300 -F 2>/dev/null || echo 'NO_ADADMIN_LOG'",
    roles: ['apps_tier'],
    category: 'adadmin',
  },
  // ── adctrl ────────────────────────────────────────────────────────────────
  'adctrl.log': {
    label: 'adctrl.log',
    tailCmd: "tail -n 300 -F $APPL_TOP/admin/${TWO_TASK}/log/adctrl.log 2>/dev/null || find $APPL_TOP/admin -name 'adctrl.log' 2>/dev/null | sort | tail -1 | xargs tail -n 300 -F 2>/dev/null || echo 'NO_ADCTRL_LOG'",
    roles: ['apps_tier'],
    category: 'adctrl',
  },
};

// ─── Catalog ──────────────────────────────────────────────────────────────────

/**
 * GET /api/ssh-tail/catalog
 * Returns the log key catalog grouped by category.
 */
router.get('/catalog', requireAuth, (req, res) => {
  const entries = Object.entries(LOG_WHITELIST).map(([key, def]) => ({
    key,
    label: def.label,
    category: def.category,
    roles: def.roles,
  }));

  // Group by category for UI rendering
  const grouped = {};
  for (const entry of entries) {
    if (!grouped[entry.category]) grouped[entry.category] = [];
    grouped[entry.category].push(entry);
  }

  res.json({ catalog: entries, grouped });
});

// ─── SSE tail stream ──────────────────────────────────────────────────────────

/**
 * GET /api/ssh-tail/logs/:connectionId/:logKey
 * Query: target_id (required — SSH target to use for the tail session)
 *
 * Streams log lines as SSE events:
 *   { type: 'line',    text: string }
 *   { type: 'info',    text: string }   — status messages
 *   { type: 'error',   text: string }   — SSH/auth errors
 *   { type: 'done',    reason: string } — stream ended (timeout, disconnect)
 */
router.get('/logs/:connectionId/:logKey', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.connectionId, 10);
  const logKey       = req.params.logKey;
  const targetId     = parseInt(req.query.target_id, 10);

  // ── 1. Validate log key ────────────────────────────────────────────────────
  const logDef = LOG_WHITELIST[logKey];
  if (!logDef) {
    return res.status(403).json({ error: 'Log key not in whitelist', logKey });
  }

  // ── 2. Verify connection ownership ────────────────────────────────────────
  if (isNaN(connectionId)) {
    return res.status(400).json({ error: 'Invalid connectionId' });
  }
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [connectionId, req.user.id]
  );
  if (!connRows.length) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  // ── 3. Load SSH target + credential check ─────────────────────────────────
  if (isNaN(targetId)) {
    return res.status(400).json({ error: 'target_id query param required' });
  }

  // Allow admin-managed targets (user_id = NULL) or user-owned targets
  const target = await sshDb.getTargetById(targetId);
  if (!target) {
    return res.status(404).json({ error: 'SSH target not found' });
  }

  // Must be an apps_tier target (all log tail keys require apps_tier)
  if (!logDef.roles.includes(target.role)) {
    return res.status(403).json({ error: `Log '${logKey}' requires role: ${logDef.roles.join(', ')}; target role is '${target.role}'` });
  }

  // Decrypt credentials
  let authConfig;
  try {
    if (target.auth_method === 'key') {
      const privateKey = decrypt(target.encrypted_private_key);
      const passphrase = target.encrypted_passphrase ? decrypt(target.encrypted_passphrase) : undefined;
      authConfig = { type: 'key', privateKey, passphrase };
    } else {
      const password = decrypt(target.encrypted_passphrase);
      authConfig = { type: 'password', password };
    }
  } catch (_) {
    return res.status(500).json({ error: 'Credential decrypt failed' });
  }

  // ── 4. Set up SSE ─────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx proxy buffering
  res.flushHeaders();

  let closed = false;
  const sessionStart = Date.now();

  function send(payload) {
    if (!closed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function close(reason) {
    if (closed) return;
    closed = true;
    send({ type: 'done', reason });
    try { res.end(); } catch (_) {}
  }

  req.on('close', () => { closed = true; });

  // Hard timeout: kill after 30 min
  const hardTimer = setTimeout(() => close('timeout_30min'), HARD_TIMEOUT_MS);

  // ── 5. Check proxy mode ───────────────────────────────────────────────────
  let proxyInfo = null;
  if (target.connection_id) {
    const conn = await sshDb.getConnectionProxyById(target.connection_id).catch(() => null);
    if (conn) {
      try {
        const proxyApiKey = decrypt(conn.proxy_api_key_enc);
        proxyInfo = { proxyUrl: conn.proxy_url, proxyApiKey };
      } catch (_) {}
    }
  }

  // Audit write helper (fire-and-forget, non-blocking)
  const auditEntry = {
    target_id: targetId,
    command_key: `log.tail.${logKey}`,
    rendered_command: logDef.tailCmd,
    exit_code: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    duration_ms: 0,
    was_rejected: false,
    rejection_reason: null,
    initiated_by: req.user.email,
  };

  function writeAudit(extra = {}) {
    sshDb.writeAudit({ ...auditEntry, ...extra, duration_ms: Date.now() - sessionStart })
      .catch(() => {});
  }

  // ── 6a. Proxy mode — poll snapshot ────────────────────────────────────────
  if (proxyInfo) {
    send({ type: 'info', text: `[tail] Proxy mode — snapshot polling every ${PROXY_POLL_INTERVAL / 1000}s for ${logDef.label}` });

    let lastLineCount = 0;
    let pollCount     = 0;

    const doProxyPoll = async () => {
      if (closed) return;

      const rendered = `tail -n ${PROXY_TAIL_LINES} ${logDef.tailCmd.replace(/tail -n \d+ -F/g, `tail -n ${PROXY_TAIL_LINES}`).replace(' -F', '')}`;

      try {
        const result = await _runProxySnapshot(
          proxyInfo.proxyUrl, proxyInfo.proxyApiKey, target, authConfig, rendered
        );

        if (closed) return;

        const lines = result.split('\n').filter(l => l.length > 0);
        const newLines = lines.slice(lastLineCount);
        lastLineCount = lines.length;

        for (const line of newLines) {
          send({ type: 'line', text: line });
        }

        if (pollCount === 0 && lines.length === 0) {
          send({ type: 'info', text: '[tail] Log file empty or not found yet' });
        }
      } catch (err) {
        send({ type: 'error', text: `[tail] Proxy poll error: ${err.message}` });
      }

      pollCount++;
    };

    // Initial fetch then poll
    await doProxyPoll();
    const pollTimer = setInterval(doProxyPoll, PROXY_POLL_INTERVAL);

    req.on('close', () => {
      clearInterval(pollTimer);
      clearTimeout(hardTimer);
      writeAudit({ exit_code: 0 });
    });

    return;
  }

  // ── 6b. Direct SSH — streaming tail -F ────────────────────────────────────
  send({ type: 'info', text: `[tail] Connecting via SSH to ${target.host}:${target.port || 22}…` });

  const conn = new Client();
  let sshReady = false;
  let bytesStreamed = 0;

  const cleanup = (reason) => {
    try { conn.end(); } catch (_) {}
    clearTimeout(hardTimer);
    writeAudit({ exit_code: 0, stdout_bytes: bytesStreamed });
    close(reason || 'done');
  };

  req.on('close', () => cleanup('client_disconnect'));

  conn.on('error', (err) => {
    send({ type: 'error', text: `[ssh] Connection error: ${err.message}` });
    cleanup('ssh_error');
  });

  conn.on('ready', () => {
    sshReady = true;
    send({ type: 'info', text: `[tail] Connected — tailing ${logDef.label}` });

    conn.exec(logDef.tailCmd, (err, stream) => {
      if (err) {
        send({ type: 'error', text: `[ssh] exec error: ${err.message}` });
        cleanup('exec_error');
        return;
      }

      // Buffer partial lines so we emit complete lines
      let lineBuffer = '';

      const processChunk = (data) => {
        if (closed) return;
        const chunk = data.toString();
        bytesStreamed += Buffer.byteLength(chunk);
        lineBuffer += chunk;

        const lines = lineBuffer.split('\n');
        // Keep the last (possibly incomplete) fragment in the buffer
        lineBuffer = lines.pop();

        for (const line of lines) {
          send({ type: 'line', text: line });
        }
      };

      stream.on('data', processChunk);
      stream.stderr.on('data', (data) => {
        if (!closed) {
          send({ type: 'error', text: data.toString().trim() });
        }
      });

      stream.on('close', () => {
        // Flush any remaining partial line
        if (lineBuffer) send({ type: 'line', text: lineBuffer });
        cleanup('stream_closed');
      });

      // If client disconnects, signal SSH channel to close
      req.on('close', () => {
        try { stream.close(); } catch (_) {}
      });
    });
  });

  // Connect with appropriate auth
  const connectOpts = {
    host:     target.host,
    port:     target.port || 22,
    username: target.os_user,
    readyTimeout: 15_000,
  };

  if (authConfig.type === 'key') {
    connectOpts.privateKey = authConfig.privateKey;
    if (authConfig.passphrase) connectOpts.passphrase = authConfig.passphrase;
  } else {
    connectOpts.password = authConfig.password;
  }

  try {
    conn.connect(connectOpts);
  } catch (err) {
    send({ type: 'error', text: `[ssh] Connect failed: ${err.message}` });
    cleanup('connect_error');
  }
});

// ─── Proxy snapshot helper ───────────────────────────────────────────────────

async function _runProxySnapshot(proxyUrl, proxyApiKey, target, authConfig, rendered) {
  const baseUrl = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl = baseUrl + '/api/ssh/exec';

  const body = JSON.stringify({
    host:        target.host,
    port:        target.port || 22,
    username:    target.os_user,
    auth_method: authConfig.type,
    password:    authConfig.type === 'password' ? (authConfig.password || '') : '',
    private_key: authConfig.type === 'key'      ? (authConfig.privateKey || '') : '',
    command:     rendered,
    timeout:     15,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proxy request timed out')), 20_000);

    const urlObj    = new URL(execUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + (urlObj.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key':      proxyApiKey,
      },
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.stdout || '');
        } catch (_) {
          resolve(data);
        }
      });
    });

    proxyReq.on('error', (err) => { clearTimeout(timer); reject(err); });
    proxyReq.write(body);
    proxyReq.end();
  });
}

module.exports = router;
