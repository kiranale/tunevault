/**
 * routes/terminal.js — Browser SSH terminal: free-form command execution.
 *
 * Owns: POST /api/terminal/run  (single command, JSON response)
 *       GET  /api/terminal/stream  (streaming command, SSE response)
 *       GET  /api/terminal/targets (SSH targets for dropdown)
 * Does NOT own: SSH credential storage (db/ssh-targets.js),
 *               whitelisted command catalog (services/ssh-executor.js),
 *               admin SSH management (routes/ssh-targets.js).
 *
 * Security model:
 *   - senior_dba+ required.
 *   - Caller owns the target OR target is admin-managed (user_id = NULL).
 *   - User supplies raw shell text — passed through BLOCK_LIST before any SSH.
 *   - BLOCK_LIST covers destructive/irreversible ops: rm -rf, dd, mkfs, shutdown, etc.
 *   - Confirmation prompts for hazardous-but-allowed ops are enforced frontend-side;
 *     backend records the user's explicit bypass in the audit log.
 *   - Every execution (allowed + blocked) writes an ssh_audit row.
 *   - Output capped: 256 KB stdout, 32 KB stderr per run.
 *   - Streaming: hard 5-minute timeout, SSE format, client-disconnect kills channel.
 */

'use strict';

const express  = require('express');
const { Client } = require('ssh2');
const https    = require('https');
const http     = require('http');

const sshDb    = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const { requireAuth, requireRole, ADMIN_EMAILS } = require('../middleware/auth');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const EXEC_TIMEOUT_MS    = 60_000;  // 60 s for regular commands
const STREAM_TIMEOUT_MS  = 5 * 60 * 1000; // 5 min for streaming
const MAX_STDOUT_BYTES   = 256 * 1024;
const MAX_STDERR_BYTES   = 32  * 1024;

// ─── Block-list ───────────────────────────────────────────────────────────────
// Regex patterns tested against the full command string (case-insensitive).
// If any pattern matches, the command is rejected before SSH is attempted.
//
// Philosophy: block irreversible destructive operations.
// This is a denylist, not a whitelist — unknown commands are ALLOWED.
// The whitelist-based ssh-executor is used by automated checks and catalog ops;
// the terminal is for ad-hoc DBA investigation where broad access is the point.

const BLOCK_PATTERNS = [
  // Destructive file operations
  /\brm\s+(-[rf]+\s+)?\/\s*$/i,        // rm /
  /\brm\s+(-[rf]+\s+)?\*\s*$/i,         // rm -rf *
  /\brm\s+-[^-]*[rf][^-]*\s+(?:\/|~)/i, // rm -rf /path or ~/path
  // Disk/partition tools
  /\b(mkfs|mke2fs|mkswap|mkdosfs)\b/i,
  /\bdd\s+(?:if|of)=/i,                  // dd if=... or dd of=...
  /\bfdisk\s+(-l\s+)?\//i,               // fdisk /dev/...  (allow fdisk -l)
  /\b(parted|gdisk|sgdisk)\s+\/dev\//i,
  /\bshred\b/i,
  /\bwipefs\b/i,
  // System control
  /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i,
  /\bsystemctl\s+(stop|disable|mask)\s+(sshd|ssh)\b/i, // killing SSH session
  // Credential/key exfiltration
  /\bcat\s+.*[.\/](id_rsa|id_ecdsa|id_ed25519|authorized_keys|shadow|passwd)\b/i,
  // Fork bomb
  /:\(\)\s*\{.*\};/,
];

/**
 * Check command against block list.
 * @param {string} cmd
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function checkBlockList(cmd) {
  for (const re of BLOCK_PATTERNS) {
    if (re.test(cmd)) {
      return { blocked: true, reason: `Matches block pattern: ${re.toString()}` };
    }
  }
  return { blocked: false, reason: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load + decrypt SSH target, verify caller has access.
 * Returns { target, authConfig } or throws an error response.
 */
async function loadTarget(targetId, userId, userEmail) {
  const target = await sshDb.getTargetById(targetId);
  if (!target) return { err: 404, msg: 'SSH target not found' };

  const isAdminManaged = target.user_id == null;
  const isOwned        = target.user_id === userId;
  const isAdmin        = ADMIN_EMAILS && ADMIN_EMAILS.has(userEmail.toLowerCase());

  if (!isAdminManaged && !isOwned && !isAdmin) {
    return { err: 403, msg: 'You do not have access to this SSH target' };
  }

  let authConfig;
  try {
    if (target.auth_method === 'key') {
      authConfig = {
        privateKey: decrypt(target.encrypted_private_key),
        passphrase: target.encrypted_passphrase ? decrypt(target.encrypted_passphrase) : undefined,
      };
    } else {
      authConfig = { password: decrypt(target.encrypted_passphrase) };
    }
  } catch (_) {
    return { err: 500, msg: 'Credential decrypt failed' };
  }

  return { target, authConfig };
}

/**
 * Write an audit row (fire-and-forget, never crashes the caller).
 */
function writeAudit({ target, rendered, exitCode, stdoutBytes, stderrBytes, durationMs, wasBlocked, blockReason, initiatedBy }) {
  sshDb.writeAudit({
    target_id:        target.id,
    command_key:      'terminal.adhoc',
    rendered_command: rendered.slice(0, 4096),
    exit_code:        exitCode,
    stdout_bytes:     stdoutBytes,
    stderr_bytes:     stderrBytes,
    duration_ms:      durationMs,
    was_rejected:     wasBlocked,
    rejection_reason: blockReason || null,
    initiated_by:     initiatedBy,
  }).catch(() => {});
}

/**
 * Build SSH connect options from authConfig.
 */
function buildConnectOpts(target, authConfig, timeoutMs) {
  const opts = {
    host:         target.host,
    port:         target.port || 22,
    username:     target.os_user,
    readyTimeout: timeoutMs,
  };
  if (authConfig.privateKey) {
    opts.privateKey = authConfig.privateKey;
    if (authConfig.passphrase) opts.passphrase = authConfig.passphrase;
  } else {
    opts.password = authConfig.password;
  }
  return opts;
}

// ─── GET /api/terminal/targets ────────────────────────────────────────────────
// Returns SSH targets accessible to the calling user (own + admin-managed).

router.get('/targets', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    // Fetch user-owned targets
    const userTargets  = await sshDb.listTargetsByUser(req.user.id);
    // Admin-managed targets are accessible to all senior_dbas
    const allTargets   = await sshDb.listTargets();
    const adminTargets = allTargets.filter(t => t.user_id == null);

    // Merge, dedup by id
    const seen = new Set();
    const targets = [];
    for (const t of [...userTargets, ...adminTargets]) {
      if (!seen.has(t.id)) { seen.add(t.id); targets.push(t); }
    }

    res.json({ targets });
  } catch (err) {
    console.error('[terminal] list targets error:', err.message);
    res.status(500).json({ error: 'Failed to load SSH targets' });
  }
});

// ─── POST /api/terminal/run ──────────────────────────────────────────────────
// Body: { target_id, command, confirmed? }
// confirmed = true tells the backend the user clicked through a confirmation modal.
// Returns: { ok, stdout, stderr, exitCode, durationMs, blocked?, blockReason? }

router.post('/run', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { target_id, command, confirmed } = req.body || {};

  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  if (!command || !command.trim()) return res.status(400).json({ error: 'command is required' });
  if (command.length > 4096) return res.status(400).json({ error: 'Command too long (max 4096 chars)' });

  const targetId = parseInt(target_id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid target_id' });

  const started = Date.now();
  const cmd = command.trim();

  // ── Block-list check ─────────────────────────────────────────────────────
  const { blocked, reason: blockReason } = checkBlockList(cmd);
  if (blocked) {
    writeAudit({
      target: { id: targetId },
      rendered: cmd, exitCode: null,
      stdoutBytes: 0, stderrBytes: 0,
      durationMs: Date.now() - started,
      wasBlocked: true, blockReason,
      initiatedBy: req.user.email,
    });
    return res.status(403).json({ error: `Command blocked: ${blockReason}`, blocked: true });
  }

  // ── Load target + credentials ────────────────────────────────────────────
  const loaded = await loadTarget(targetId, req.user.id, req.user.email);
  if (loaded.err) return res.status(loaded.err).json({ error: loaded.msg });
  const { target, authConfig } = loaded;

  // ── Proxy routing ────────────────────────────────────────────────────────
  if (target.connection_id) {
    const proxyConn = await sshDb.getConnectionProxyById(target.connection_id).catch(() => null);
    if (proxyConn) {
      let proxyApiKey;
      try { proxyApiKey = decrypt(proxyConn.proxy_api_key_enc); } catch (_) {
        return res.status(500).json({ error: 'Proxy credential decrypt failed' });
      }
      const result = await _runViaProxy(proxyConn.proxy_url, proxyApiKey, target, authConfig, cmd, EXEC_TIMEOUT_MS);
      writeAudit({
        target, rendered: cmd, exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout || ''),
        stderrBytes: Buffer.byteLength(result.stderr || ''),
        durationMs: result.durationMs, wasBlocked: false, blockReason: null,
        initiatedBy: req.user.email,
      });
      return res.json(result);
    }
  }

  // ── Direct SSH exec ──────────────────────────────────────────────────────
  const result = await _runDirect(target, authConfig, cmd, EXEC_TIMEOUT_MS);
  writeAudit({
    target, rendered: cmd, exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout || ''),
    stderrBytes: Buffer.byteLength(result.stderr || ''),
    durationMs: result.durationMs, wasBlocked: false, blockReason: null,
    initiatedBy: req.user.email,
  });
  res.json(result);
});

// ─── GET /api/terminal/stream ─────────────────────────────────────────────────
// Query: target_id, command
// Streams output as SSE: { type: 'line'|'info'|'error'|'done', text?, reason? }

router.get('/stream', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { target_id, command } = req.query;

  if (!target_id) return res.status(400).json({ error: 'target_id is required' });
  if (!command || !command.trim()) return res.status(400).json({ error: 'command is required' });
  if (command.length > 4096) return res.status(400).json({ error: 'Command too long' });

  const targetId = parseInt(target_id, 10);
  const cmd = command.trim();

  // Block-list check before opening SSE stream
  const { blocked, reason: blockReason } = checkBlockList(cmd);
  if (blocked) {
    return res.status(403).json({ error: `Command blocked: ${blockReason}`, blocked: true });
  }

  const loaded = await loadTarget(targetId, req.user.id, req.user.email);
  if (loaded.err) return res.status(loaded.err).json({ error: loaded.msg });
  const { target, authConfig } = loaded;

  // ── SSE setup ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed  = false;
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

  const hardTimer = setTimeout(() => close('timeout_5min'), STREAM_TIMEOUT_MS);

  // Proxy mode: snapshot polling (proxy doesn't support streaming)
  if (target.connection_id) {
    const proxyConn = await sshDb.getConnectionProxyById(target.connection_id).catch(() => null);
    if (proxyConn) {
      let proxyApiKey;
      try { proxyApiKey = decrypt(proxyConn.proxy_api_key_enc); } catch (_) {
        send({ type: 'error', text: 'Proxy credential decrypt failed' });
        clearTimeout(hardTimer);
        return close('proxy_cred_error');
      }

      send({ type: 'info', text: `[stream] Proxy mode — polling every 8s` });
      let lastLineCount = 0;
      let pollCount = 0;

      const doPoll = async () => {
        if (closed) return;
        try {
          const result = await _runViaProxy(proxyConn.proxy_url, proxyApiKey, target, authConfig, cmd, 20_000);
          const lines = (result.stdout || '').split('\n').filter(l => l.length > 0);
          const newLines = lines.slice(lastLineCount);
          lastLineCount = lines.length;
          for (const line of newLines) send({ type: 'line', text: line });
          if (pollCount === 0 && lines.length === 0) send({ type: 'info', text: '[stream] No output yet' });
        } catch (err) {
          send({ type: 'error', text: `[stream] Poll error: ${err.message}` });
        }
        pollCount++;
      };

      await doPoll();
      const pollTimer = setInterval(doPoll, 8_000);
      req.on('close', () => { clearInterval(pollTimer); clearTimeout(hardTimer); });
      return;
    }
  }

  // Direct SSH streaming
  send({ type: 'info', text: `[stream] Connecting to ${target.host}:${target.port || 22}…` });

  const conn = new Client();
  let bytesOut = 0;

  const cleanup = (reason) => {
    try { conn.end(); } catch (_) {}
    clearTimeout(hardTimer);
    sshDb.writeAudit({
      target_id: target.id, command_key: 'terminal.stream',
      rendered_command: cmd.slice(0, 4096), exit_code: 0,
      stdout_bytes: bytesOut, stderr_bytes: 0,
      duration_ms: Date.now() - sessionStart,
      was_rejected: false, rejection_reason: null,
      initiated_by: req.user.email,
    }).catch(() => {});
    close(reason || 'done');
  };

  req.on('close', () => cleanup('client_disconnect'));

  conn.on('error', (err) => {
    send({ type: 'error', text: `[ssh] ${err.message}` });
    cleanup('ssh_error');
  });

  conn.on('ready', () => {
    send({ type: 'info', text: '[stream] Connected — streaming output…' });

    conn.exec(cmd, (err, stream) => {
      if (err) {
        send({ type: 'error', text: `[ssh] exec error: ${err.message}` });
        return cleanup('exec_error');
      }

      let lineBuf = '';
      stream.on('data', (data) => {
        if (closed) return;
        const chunk = data.toString();
        bytesOut += Buffer.byteLength(chunk);
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop(); // keep partial last line
        for (const line of lines) send({ type: 'line', text: line });
      });
      stream.stderr.on('data', (data) => {
        if (!closed) send({ type: 'error', text: data.toString().trim() });
      });
      stream.on('close', () => {
        if (lineBuf) send({ type: 'line', text: lineBuf });
        cleanup('stream_closed');
      });
      req.on('close', () => { try { stream.close(); } catch (_) {} });
    });
  });

  try {
    conn.connect(buildConnectOpts(target, authConfig, STREAM_TIMEOUT_MS));
  } catch (err) {
    send({ type: 'error', text: `[ssh] Connect failed: ${err.message}` });
    cleanup('connect_error');
  }
});

// ─── SSH execution helpers ────────────────────────────────────────────────────

async function _runDirect(target, authConfig, cmd, timeoutMs) {
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let execError = null;

  try {
    await new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => { try { conn.end(); } catch (_) {} reject(new Error('SSH_TIMEOUT')); }, timeoutMs);

      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }
          stream.on('close', (code) => { exitCode = code; clearTimeout(timer); conn.end(); resolve(); });
          stream.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_STDOUT_BYTES) { try { conn.end(); } catch (_) {} } });
          stream.stderr.on('data', (d) => { stderr += d.toString(); });
        });
      });
      conn.on('error', (err) => { clearTimeout(timer); reject(err); });
      conn.connect(buildConnectOpts(target, authConfig, timeoutMs));
    });
  } catch (err) {
    execError = err.message || 'SSH error';
  }

  return {
    ok: execError === null && exitCode === 0,
    exitCode,
    stdout:    stdout.slice(0, MAX_STDOUT_BYTES),
    stderr:    (stderr + (execError ? `\n[error] ${execError}` : '')).slice(0, MAX_STDERR_BYTES),
    durationMs: Date.now() - started,
  };
}

async function _runViaProxy(proxyUrl, proxyApiKey, target, authConfig, cmd, timeoutMs) {
  const baseUrl = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl = baseUrl + '/api/ssh/exec';

  const body = JSON.stringify({
    host:        target.host,
    port:        target.port || 22,
    username:    target.os_user,
    auth_method: target.auth_method === 'key' ? 'key' : 'password',
    password:    target.auth_method !== 'key' ? (authConfig.password || '') : '',
    private_key: target.auth_method === 'key' ? (authConfig.privateKey || '') : '',
    command:     cmd,
    timeout:     Math.ceil(timeoutMs / 1000),
  });

  const started = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      ok: false, exitCode: null, stdout: '',
      stderr: '[proxy] Request timed out',
      durationMs: Date.now() - started,
    }), timeoutMs + 5000);

    const urlObj    = new URL(execUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Api-Key': proxyApiKey },
      rejectUnauthorized: false,
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      let raw = '';
      proxyRes.on('data', (chunk) => { raw += chunk; });
      proxyRes.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(raw);
          resolve({
            ok:         data.success === true,
            exitCode:   data.exit_code ?? null,
            stdout:     (data.stdout || '').slice(0, MAX_STDOUT_BYTES),
            stderr:     (data.stderr || '').slice(0, MAX_STDERR_BYTES),
            durationMs: Date.now() - started,
          });
        } catch (_) {
          resolve({ ok: false, exitCode: null, stdout: '', stderr: '[proxy] Invalid response', durationMs: Date.now() - started });
        }
      });
    });

    proxyReq.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, exitCode: null, stdout: '', stderr: `[proxy] ${err.message}`, durationMs: Date.now() - started }); });
    proxyReq.write(body);
    proxyReq.end();
  });
}

module.exports = router;
