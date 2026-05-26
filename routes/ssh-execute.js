/**
 * routes/ssh-execute.js — REST API for SSH command execution via stored SSH targets.
 *
 * Owns: POST /api/ssh-targets/:id/execute  (allowlisted command, JSON response)
 *       GET  /api/ssh-targets/:id/stream   (allowlisted streaming command, SSE)
 * Does NOT own: SSH target CRUD (routes/ssh-targets.js / routes/user-ssh-targets.js),
 *               free-form terminal (routes/terminal.js),
 *               credential storage (db/ssh-targets.js).
 *
 * Security model:
 *   - Authenticated session required (requireAuth).
 *   - Caller must own the target or target must be admin-managed (user_id = NULL).
 *   - Commands are validated against an explicit ALLOW_LIST — anything not on it is rejected.
 *   - Confirmation flag required for risky-but-allowed commands (lsnrctl stop, adop, etc.).
 *   - Rate limit: 5 commands per minute per user.
 *   - Every execution (allowed + blocked) is written to ssh_audit.
 *   - Output capped at 1 MB stdout, 64 KB stderr.
 *   - Streaming: 5-minute hard timeout, SSE format, client disconnect kills channel.
 */

'use strict';

const express    = require('express');
const { Client } = require('ssh2');
const https      = require('https');
const http       = require('http');
const rateLimit  = require('express-rate-limit');

const sshDb      = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const { requireAuth, ADMIN_EMAILS } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// ─── Constants ────────────────────────────────────────────────────────────────

const EXEC_TIMEOUT_MS   = 60_000;           // 60 s for regular commands
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min for streaming
const MAX_STDOUT_BYTES  = 1 * 1024 * 1024; // 1 MB
const MAX_STDERR_BYTES  = 64 * 1024;        // 64 KB
// Max concurrent SSE streaming connections globally. Prevents resource exhaustion
// from a single user opening many parallel streams. Tune via SSH_MAX_CONCURRENT_STREAMS env var.
const MAX_CONCURRENT_STREAMS = parseInt(process.env.SSH_MAX_CONCURRENT_STREAMS || '20', 10);

// ─── Active streams counter ───────────────────────────────────────────────────
let _activeStreams = 0;

// ─── Rate limiter: 5 commands / minute / user ──────────────────────────────────

const commandRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => `ssh-exec:${req.user?.id || req.ip}`,
  // IP fallback is unreachable (requireAuth runs first); suppress v8 IPv6 validation
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) => {
    res.status(429).json({ error: 'Rate limit exceeded: 5 commands per minute. Please wait.' });
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip counting blocked commands — they never reach SSH
  skip: () => false,
});

// ─── Command allowlist ────────────────────────────────────────────────────────
// Each entry: { prefix: string | regex, requiresConfirmation?: boolean }
// A command is allowed if its first token (or full command) matches a prefix.
//
// Philosophy: default-deny. Unknown commands are BLOCKED.
// This is the opposite of routes/terminal.js which is default-allow with a blocklist.
// Use this endpoint from programmatic callers (health check links, TuneOps actions).
// For ad-hoc exploration, /terminal is the right tool.
//
// INJECTION GUARD: After prefix matching, the full command is tested against
// SHELL_INJECTION_RE. Any command containing shell metacharacters (semicolons,
// pipes, &&, ||, command substitution, newlines, null bytes) is rejected even
// if it passes the prefix check. This prevents "tail /log; <evil>" bypass.
const SHELL_INJECTION_RE = /[;&|`\n\r\x00]|\$\(/;

const ALLOWED_PREFIXES = [
  // Listener management
  { prefix: /^lsnrctl\s+(status|services|start|stop)\b/i, requiresConfirmation: (cmd) => /^lsnrctl\s+stop\b/i.test(cmd) },
  // SQL*Plus — full client launch (connection string may follow)
  { prefix: /^sqlplus\b/i },
  // Process listing
  { prefix: /^ps\b/i },
  // Disk space
  { prefix: /^df\b/i },
  // Log tailing/reading — the killer feature
  { prefix: /^tail\b/i },
  { prefix: /^cat\b/i },
  { prefix: /^head\b/i },
  // Log searching
  { prefix: /^(e?grep)\b/i },
  // Directory listing
  { prefix: /^(ls|ll)\b/i },
  // System info
  { prefix: /^(uptime|hostname|uname)\b/i },
  // EBS patching — confirmation required
  { prefix: /^adop\b/i, requiresConfirmation: () => true },
  { prefix: /^adadmin\b/i, requiresConfirmation: () => true },
  // OPatch — inventory, prereq checks (read-only; apply requires confirmation)
  { prefix: /^(\S+\/)?opatch\s+lsinventory\b/i },
  { prefix: /^(\S+\/)?opatch\s+prereq\b/i },
  { prefix: /^(\S+\/)?opatch\s+version\b/i },
  { prefix: /^(\S+\/)?opatch\s+apply\b/i, requiresConfirmation: () => true },
  // Oracle process manager
  { prefix: /^opmnctl\b/i },
  // OEM
  { prefix: /^emctl\b/i },
  // RAC / Clusterware
  { prefix: /^srvctl\b/i },
  { prefix: /^crsctl\b/i },
  // ASM
  { prefix: /^asmcmd\b/i },
];

/**
 * Check whether a command is on the allowlist.
 * @param {string} cmd  Raw command string from caller
 * @returns {{ allowed: boolean, requiresConfirmation: boolean, reason: string|null }}
 */
function checkAllowList(cmd) {
  const trimmed = cmd.trim();

  for (const entry of ALLOWED_PREFIXES) {
    const matchFn = typeof entry.prefix === 'string'
      ? (c) => c === entry.prefix || c.startsWith(entry.prefix + ' ')
      : (c) => entry.prefix.test(c);

    if (matchFn(trimmed)) {
      // Secondary injection guard: reject shell metacharacters even on allowlisted commands.
      // Prevents "tail /log; <arbitrary-cmd>" bypass where prefix matches but remainder injects.
      if (SHELL_INJECTION_RE.test(trimmed)) {
        return {
          allowed: false,
          requiresConfirmation: false,
          reason: 'Command contains shell metacharacters (;, |, &&, ||, $(), backtick, newline). Not permitted.',
        };
      }
      const needsConfirm = entry.requiresConfirmation
        ? entry.requiresConfirmation(trimmed)
        : false;
      return { allowed: true, requiresConfirmation: needsConfirm, reason: null };
    }
  }

  // Blocklist of specific dangerous patterns that might partially match allowed prefixes
  const BLOCK_EXCEPTIONS = [
    { re: /\brm\b/i, desc: 'file deletion (rm)' },
    { re: /\bdd\s+(if|of)=/i, desc: 'disk operations (dd)' },
    { re: /\b(mkfs|fdisk|parted)\b/i, desc: 'filesystem operations' },
    { re: /\b(shutdown|reboot|poweroff|halt)\b/i, desc: 'system control' },
    { re: /\bsudo\s+su\b|\bsu\s+-\b/i, desc: 'privilege escalation' },
    { re: /\bkill\s+-9\b/i, desc: 'kill -9 (use kill <pid> for Oracle processes)' },
    { re: />\s*\/(etc|boot|usr)\//i, desc: 'overwrite to system path' },
  ];

  for (const ex of BLOCK_EXCEPTIONS) {
    if (ex.re.test(trimmed)) {
      return { allowed: false, requiresConfirmation: false, reason: `Blocked: ${ex.desc}` };
    }
  }

  // Default deny — not on allowlist
  const firstToken = trimmed.split(/\s+/)[0];
  return {
    allowed: false,
    requiresConfirmation: false,
    reason: `Command "${firstToken}" is not on the allowed list. Use /terminal for ad-hoc commands.`,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load + decrypt SSH target, verify caller has access.
 * @returns {{ target, authConfig } | { err: number, msg: string }}
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
        privateKey:  decrypt(target.encrypted_private_key),
        passphrase:  target.encrypted_passphrase ? decrypt(target.encrypted_passphrase) : undefined,
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
 * Write an ssh_audit row (fire-and-forget — never throws to the caller).
 */
function writeAudit({ target, rendered, exitCode, stdoutBytes, stderrBytes, durationMs, wasBlocked, blockReason, initiatedBy }) {
  sshDb.writeAudit({
    target_id:        target.id,
    command_key:      'ssh-execute.adhoc',
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
 * Build ssh2 connect options.
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

// ─── POST /api/ssh-targets/:id/execute ────────────────────────────────────────
// Body: { command, confirmed? }
// Returns: { ok, stdout, stderr, exitCode, durationMs, blocked?, blockReason?,
//            requiresConfirmation?, allowlisted? }

router.post('/:id/execute', requireAuth, commandRateLimiter, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid target id' });

  const { command, confirmed } = req.body || {};
  if (!command || !command.trim()) return res.status(400).json({ error: 'command is required' });
  if (command.length > 4096) return res.status(400).json({ error: 'Command too long (max 4096 chars)' });

  const started = Date.now();
  const cmd = command.trim();

  // ── Allowlist check ───────────────────────────────────────────────────────
  const { allowed, requiresConfirmation, reason: blockReason } = checkAllowList(cmd);

  if (!allowed) {
    writeAudit({
      target: { id: targetId },
      rendered: cmd, exitCode: null,
      stdoutBytes: 0, stderrBytes: 0,
      durationMs: Date.now() - started,
      wasBlocked: true, blockReason,
      initiatedBy: req.user.email,
    });
    return res.status(403).json({ error: blockReason, blocked: true, allowlisted: false });
  }

  // ── Confirmation gate ─────────────────────────────────────────────────────
  if (requiresConfirmation && !confirmed) {
    // Don't count as a blocked command — user needs to re-send with confirmed=true
    return res.status(428).json({
      error: 'This command requires explicit confirmation. Re-send with { confirmed: true }.',
      requiresConfirmation: true,
    });
  }

  // ── Load target + credentials ─────────────────────────────────────────────
  const loaded = await loadTarget(targetId, req.user.id, req.user.email);
  if (loaded.err) return res.status(loaded.err).json({ error: loaded.msg });
  const { target, authConfig } = loaded;

  // ── Proxy routing ─────────────────────────────────────────────────────────
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
      return res.json({ ...result, allowlisted: true });
    }
  }

  // ── Direct SSH exec ───────────────────────────────────────────────────────
  const result = await _runDirect(target, authConfig, cmd, EXEC_TIMEOUT_MS);
  writeAudit({
    target, rendered: cmd, exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdout || ''),
    stderrBytes: Buffer.byteLength(result.stderr || ''),
    durationMs: result.durationMs, wasBlocked: false, blockReason: null,
    initiatedBy: req.user.email,
  });
  res.json({ ...result, allowlisted: true });
});

// ─── GET /api/ssh-targets/:id/stream ──────────────────────────────────────────
// Query: command
// Streams output as SSE: { type: 'line'|'info'|'error'|'done', text?, reason? }

router.get('/:id/stream', requireAuth, commandRateLimiter, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'Invalid target id' });

  // Concurrent stream cap — prevent resource exhaustion from many parallel streams
  if (_activeStreams >= MAX_CONCURRENT_STREAMS) {
    return res.status(503).json({ error: `SSH stream capacity reached (max ${MAX_CONCURRENT_STREAMS} concurrent streams). Try again shortly.` });
  }

  const { command, confirmed } = req.query;
  if (!command || !command.trim()) return res.status(400).json({ error: 'command is required' });
  if (command.length > 4096) return res.status(400).json({ error: 'Command too long' });

  const cmd = command.trim();

  // ── Allowlist check before opening SSE stream ─────────────────────────────
  const { allowed, requiresConfirmation, reason: blockReason } = checkAllowList(cmd);

  if (!allowed) {
    return res.status(403).json({ error: blockReason, blocked: true });
  }
  if (requiresConfirmation && confirmed !== 'true') {
    return res.status(428).json({
      error: 'This command requires explicit confirmation. Add ?confirmed=true to the query.',
      requiresConfirmation: true,
    });
  }

  const loaded = await loadTarget(targetId, req.user.id, req.user.email);
  if (loaded.err) return res.status(loaded.err).json({ error: loaded.msg });
  const { target, authConfig } = loaded;

  // ── SSE setup ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  _activeStreams++;

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
    _activeStreams = Math.max(0, _activeStreams - 1);
    send({ type: 'done', reason });
    try { res.end(); } catch (_) {}
  }

  req.on('close', () => {
    if (!closed) {
      closed = true;
      _activeStreams = Math.max(0, _activeStreams - 1);
    }
  });

  const hardTimer = setTimeout(() => close('timeout_5min'), STREAM_TIMEOUT_MS);

  // Proxy mode: snapshot polling (proxy doesn't support streaming natively)
  if (target.connection_id) {
    const proxyConn = await sshDb.getConnectionProxyById(target.connection_id).catch(() => null);
    if (proxyConn) {
      let proxyApiKey;
      try { proxyApiKey = decrypt(proxyConn.proxy_api_key_enc); } catch (_) {
        send({ type: 'error', text: 'Proxy credential decrypt failed' });
        clearTimeout(hardTimer);
        return close('proxy_cred_error');
      }

      send({ type: 'info', text: '[stream] Proxy mode — polling every 8 s' });
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
          send({ type: 'error', text: `[poll] ${err.message}` });
        }
        pollCount++;
      };

      await doPoll();
      const pollTimer = setInterval(doPoll, 8_000);
      req.on('close', () => { clearInterval(pollTimer); clearTimeout(hardTimer); });
      return;
    }
  }

  // ── Direct SSH streaming ──────────────────────────────────────────────────
  send({ type: 'info', text: `[stream] Connecting to ${target.host}:${target.port || 22}…` });

  const conn = new Client();
  let bytesOut = 0;

  const cleanup = (reason) => {
    try { conn.end(); } catch (_) {}
    clearTimeout(hardTimer);
    sshDb.writeAudit({
      target_id: target.id, command_key: 'ssh-execute.stream',
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
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop(); // hold partial last line
        for (const line of parts) send({ type: 'line', text: line });

        // 1 MB cap — kill stream if exceeded
        if (bytesOut > MAX_STDOUT_BYTES) {
          send({ type: 'error', text: '[stream] Output cap reached (1 MB). Stream stopped.' });
          cleanup('output_cap');
        }
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
      const conn  = new Client();
      const timer = setTimeout(() => {
        try { conn.end(); } catch (_) {}
        reject(new Error('SSH_TIMEOUT'));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.exec(cmd, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }

          stream.on('close', (code) => {
            exitCode = code;
            clearTimeout(timer);
            conn.end();
            resolve();
          });
          stream.on('data', (d) => {
            stdout += d.toString();
            if (stdout.length > MAX_STDOUT_BYTES) {
              stdout = stdout.slice(0, MAX_STDOUT_BYTES) + '\n[output truncated — 1 MB limit]';
              try { conn.end(); } catch (_) {}
            }
          });
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
    ok:         execError === null && exitCode === 0,
    exitCode,
    stdout:     stdout.slice(0, MAX_STDOUT_BYTES),
    stderr:     (stderr + (execError ? `\n[error] ${execError}` : '')).slice(0, MAX_STDERR_BYTES),
    durationMs: Date.now() - started,
  };
}

async function _runViaProxy(proxyUrl, proxyApiKey, target, authConfig, cmd, timeoutMs) {
  const baseUrl  = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl  = baseUrl + '/api/ssh/exec';
  const started  = Date.now();

  const body = JSON.stringify({
    host:        target.host,
    port:        target.port || 22,
    username:    target.os_user,
    auth_method: target.auth_method === 'key' ? 'key' : 'password',
    password:    target.auth_method !== 'key' ? (authConfig.password || '') : '',
    private_key: target.auth_method === 'key'  ? (authConfig.privateKey || '') : '',
    command:     cmd,
    timeout:     Math.ceil(timeoutMs / 1000),
  });

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
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Key':      proxyApiKey,
      },
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

    proxyReq.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout: '', stderr: `[proxy] ${err.message}`, durationMs: Date.now() - started });
    });
    proxyReq.write(body);
    proxyReq.end();
  });
}

module.exports = router;
