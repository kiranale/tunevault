/**
 * routes/install-jobs.js — SSH push-install job API.
 *
 * Owns: POST /api/install-jobs         — create job, kick off SSH worker
 *       GET  /api/install-jobs/:id/stream — SSE live log stream
 *       GET  /api/install-jobs/:id      — job status poll
 * Does NOT own: oracle_connections lifecycle (db/agent.js),
 *               agent heartbeat channel (services/agent-channel.js),
 *               SSH target vault (routes/ssh-targets.js, routes/user-ssh-targets.js),
 *               existing ssh-install.js credential persistence (db/ssh-install.js).
 *
 * Security notes:
 *   - SSH credentials are NEVER written to DB. Held in module-level Map keyed by
 *     job id. Evicted automatically 30s after job finishes.
 *   - Rate limits: 3 concurrent active jobs per user, 20 jobs per 24h per user.
 *   - Refuses to install if target host already has a healthy heartbeat within 5 min.
 *   - Audit log: every job recorded in install_jobs (host, user, exit_code, duration).
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const express = require('express');
const { Client } = require('ssh2');

const jobsDb  = require('../db/install-jobs');
const agentDb = require('../db/agent');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── In-memory transient credential store ─────────────────────────────────────
// Keyed by job id (string). Each entry: { host, port, username, auth, credential, sudo_password }
// Evicted 30s after job reaches terminal state.
const _credStore = new Map();

function _storeCred(jobId, cred) {
  _credStore.set(String(jobId), cred);
}
function _getCred(jobId) {
  return _credStore.get(String(jobId)) || null;
}
function _evictCred(jobId) {
  _credStore.delete(String(jobId));
}
// Schedule eviction 30s after terminal state
function _scheduleEvict(jobId) {
  setTimeout(() => _evictCred(jobId), 30_000);
}

// ── SSE broadcaster per job ───────────────────────────────────────────────────
// Multiple clients may connect (e.g. tab refresh). Keyed by job id.
const _sseClients = new Map(); // jobId → Set<res>

function _addSseClient(jobId, res) {
  const key = String(jobId);
  if (!_sseClients.has(key)) _sseClients.set(key, new Set());
  _sseClients.get(key).add(res);
}
function _removeSseClient(jobId, res) {
  const key = String(jobId);
  const set = _sseClients.get(key);
  if (set) { set.delete(res); if (!set.size) _sseClients.delete(key); }
}
function _broadcast(jobId, payload) {
  const key = String(jobId);
  const set = _sseClients.get(key);
  if (!set || !set.size) return;
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { if (!res.writableEnded) res.write(chunk); } catch (_) {}
  }
}

// ── In-memory log buffer per job (for replay on reconnect) ───────────────────
const _logBuf = new Map(); // jobId → Array<{seq, stream, line}>
const MAX_LOG_BUF = 2000;

function _bufferLine(jobId, entry) {
  const key = String(jobId);
  if (!_logBuf.has(key)) _logBuf.set(key, []);
  const arr = _logBuf.get(key);
  arr.push(entry);
  if (arr.length > MAX_LOG_BUF) arr.splice(0, arr.length - MAX_LOG_BUF);
}
function _getBuffered(jobId, afterSeq = -1) {
  const arr = _logBuf.get(String(jobId)) || [];
  return arr.filter(e => e.seq > afterSeq);
}
function _clearLogBuf(jobId) {
  setTimeout(() => _logBuf.delete(String(jobId)), 120_000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _friendlySSHError(msg, host, port) {
  if (/ECONNREFUSED/.test(msg)) return `Connection refused at ${host}:${port}. Is SSH running on that port?`;
  if (/EHOSTUNREACH|ENOTFOUND/.test(msg)) return `Cannot reach ${host}. Check the hostname/IP.`;
  if (/ETIMEDOUT|TIMEOUT/i.test(msg)) return `SSH connect timed out (10s). Is ${host}:${port} reachable?`;
  if (/Authentication|auth/i.test(msg)) return `SSH authentication failed. Check your private key or password.`;
  if (/ECONNRESET/.test(msg)) return `SSH connection reset. The server rejected the connection.`;
  if (/passphrase/i.test(msg)) return `Private key requires a passphrase — pass it in sudo_password field or use an unencrypted key.`;
  return `SSH error: ${msg}`;
}

/**
 * Check if target host already has a healthy heartbeat in the last 5 minutes.
 * We check oracle_connections by host match (all connections for this user).
 */
async function _hasRecentHeartbeat(userId, host) {
  try {
    const tunnels = await agentDb.getTunnelsByUserAndHost(userId, host);
    if (!tunnels || !tunnels.length) return false;
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    return tunnels.some(t => t.last_heartbeat && new Date(t.last_heartbeat) > cutoff);
  } catch (_) {
    return false; // don't block on lookup failure
  }
}

// ── POST /api/install-jobs ────────────────────────────────────────────────────
// Creates a job row and kicks off the SSH worker asynchronously.
// Credentials are NOT written to DB — held only in _credStore for the job lifetime.

router.post('/install-jobs', requireAuth, async (req, res) => {
  const {
    host,
    port,
    username,
    auth,           // 'key' | 'password'
    credential,     // PEM private key OR password
    sudo_password,  // optional sudo password (if sudo requires password)
    connection_name, // optional friendly name for the draft connection
    install_token,  // optional pre-issued token; if omitted, a draft is created
  } = req.body;

  // ── Basic validation ────────────────────────────────────────────────────────
  if (!host || !host.trim()) return res.status(400).json({ error: 'host is required' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'username is required' });
  if (!auth || !['key','password'].includes(auth)) return res.status(400).json({ error: 'auth must be key or password' });
  if (!credential || !credential.trim()) return res.status(400).json({ error: 'credential is required' });

  const sshHost = host.trim();
  const sshPort = parseInt(port, 10) || 22;
  const sshUser = username.trim();

  // ── Rate limits ─────────────────────────────────────────────────────────────
  const [active, today] = await Promise.all([
    jobsDb.countActiveForUser(req.user.id),
    jobsDb.countTodayForUser(req.user.id),
  ]);
  if (active >= 3) {
    return res.status(429).json({ error: 'Max 3 concurrent SSH install jobs. Wait for one to finish first.' });
  }
  if (today >= 20) {
    return res.status(429).json({ error: 'Max 20 SSH installs per 24 hours reached. Try again tomorrow.' });
  }

  // ── Double-install guard ─────────────────────────────────────────────────────
  const alreadyOnline = await _hasRecentHeartbeat(req.user.id, sshHost);
  if (alreadyOnline) {
    return res.status(409).json({
      error: `${sshHost} already has a healthy agent heartbeat within the last 5 minutes. Skipping install to prevent double-install.`,
      code: 'AGENT_ALREADY_ONLINE',
    });
  }

  // ── Create job row ──────────────────────────────────────────────────────────
  const job = await jobsDb.createJob({
    userId: req.user.id,
    connectionId: null, // filled in after agent registers
    host: sshHost,
    sshPort,
    sshUser,
  });

  // ── Store creds in transient store (never DB) ───────────────────────────────
  _storeCred(job.id, {
    host: sshHost,
    port: sshPort,
    username: sshUser,
    auth,
    credential: credential.trim(),
    sudo_password: (sudo_password || '').trim() || null,
    connection_name: (connection_name || '').trim() || sshHost,
    install_token: (install_token || '').trim() || null,
  });

  // ── Return job id immediately; worker runs async ────────────────────────────
  res.json({ job_id: job.id, status: 'queued' });

  // Kick off async — do not await
  _runInstallWorker(job.id, req.user).catch(err => {
    console.error(`[install-jobs] unhandled worker error job=${job.id}:`, err.message);
  });
});

// ── GET /api/install-jobs/:id ─────────────────────────────────────────────────

router.get('/install-jobs/:id', requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId) return res.status(400).json({ error: 'Invalid job id' });
  const job = await jobsDb.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(job);
});

// ── GET /api/install-jobs/:id/stream ─────────────────────────────────────────
// SSE stream. Replays buffered lines from memory, then pushes live events.

router.get('/install-jobs/:id/stream', requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId) return res.status(400).json({ error: 'Invalid job id' });

  const job = await jobsDb.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Replay buffered lines (in case client reconnected)
  const afterSeq = parseInt(req.query.after_seq || '-1', 10);
  const buffered = _getBuffered(jobId, afterSeq);
  for (const entry of buffered) {
    try {
      res.write(`data: ${JSON.stringify({ type: entry.stream === 'system' ? 'step' : ('install_' + entry.stream), text: entry.line, seq: entry.seq })}\n\n`);
    } catch (_) { break; }
  }

  // If already finished, send terminal event and close
  if (['success','failed'].includes(job.status)) {
    try {
      res.write(`data: ${JSON.stringify({ type: job.status === 'success' ? 'success' : 'error', text: job.error_message || '', code: 'TERMINAL', connection_id: job.connection_id })}\n\n`);
      res.end();
    } catch (_) {}
    return;
  }

  // Register for live events
  _addSseClient(jobId, res);

  // Heartbeat every 25s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { if (!res.writableEnded) res.write(': ping\n\n'); } catch (_) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    _removeSseClient(jobId, res);
  });
});

// ── SSH install worker ────────────────────────────────────────────────────────

async function _runInstallWorker(jobId, user) {
  const cred = _getCred(jobId);
  if (!cred) {
    await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: 'Credentials not found in memory (evicted too early).' });
    _broadcast(jobId, { type: 'error', text: 'Internal error: credentials evicted before worker started.', code: 'CRED_EVICTED' });
    return;
  }

  let seq = 0;
  let sshClient = null;

  function emit(type, text, extra = {}) {
    const entry = { type, text, seq: seq++, ...extra };
    _broadcast(jobId, entry);
    const stream = type.startsWith('install_') ? type.replace('install_','') : 'system';
    _bufferLine(jobId, { seq: entry.seq, stream, line: text });
    jobsDb.appendLine(jobId, { seq: entry.seq, stream, line: text }).catch(() => {});
  }

  async function transition(status) {
    await jobsDb.setStatus(jobId, status);
    _broadcast(jobId, { type: 'status', status });
  }

  try {
    // ── Connect ───────────────────────────────────────────────────────────────
    await transition('connecting');
    emit('step', `Connecting to ${cred.host}:${cred.port} as ${cred.username}…`);

    const connectOpts = {
      host:         cred.host,
      port:         cred.port,
      username:     cred.username,
      readyTimeout: 10_000,
    };

    if (cred.auth === 'key') {
      connectOpts.privateKey = cred.credential;
      if (cred.sudo_password) connectOpts.passphrase = cred.sudo_password;
    } else {
      connectOpts.password = cred.credential;
      // Allow keyboard-interactive as fallback for password auth
      connectOpts.tryKeyboard = true;
    }

    sshClient = new Client();

    const sshResult = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        sshClient.destroy();
        resolve(new Error('SSH_CONNECT_TIMEOUT'));
      }, 12_000);

      sshClient.on('error', (err) => { clearTimeout(timer); resolve(err); });
      sshClient.on('ready', () => { clearTimeout(timer); resolve(true); });
      sshClient.on('keyboard-interactive', (_n, _i, _il, _prompts, finish) => {
        // Provide password for keyboard-interactive auth
        finish([cred.credential]);
      });
      try { sshClient.connect(connectOpts); } catch (e) { clearTimeout(timer); resolve(e); }
    });

    if (sshResult instanceof Error) {
      const msg = _friendlySSHError(sshResult.message, cred.host, cred.port);
      emit('error', msg, { code: 'SSH_CONNECT_FAILED' });
      await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: msg });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    emit('step', `✓ SSH connected to ${cred.host}`);

    // ── Pre-flight ────────────────────────────────────────────────────────────
    await transition('preflight');
    emit('step', 'Running pre-flight checks…');
    emit('divider', '');

    const preflightCmds = [
      { label: 'OS',          cmd: 'uname -a' },
      { label: 'Python',      cmd: 'python3 --version 2>&1 || echo "MISSING: python3 not found"' },
      { label: 'User',        cmd: 'id' },
      { label: 'systemctl',   cmd: 'command -v systemctl && echo OK || echo "MISSING: systemctl not found"' },
      { label: 'curl',        cmd: 'command -v curl && echo OK || echo "MISSING: curl not found"' },
      { label: 'sudo -n',     cmd: 'sudo -n true 2>&1 && echo SUDO_OK || echo SUDO_NEEDS_PASSWORD' },
    ];

    let preflightFailed = null;

    for (const pf of preflightCmds) {
      const out = await _execSimple(sshClient, pf.cmd, 8000);
      const text = (out || '').trim();
      emit('install_stdout', `[${pf.label}] ${text}`);

      if (text.startsWith('MISSING:')) {
        preflightFailed = text;
        break;
      }
      if (pf.label === 'sudo -n' && text === 'SUDO_NEEDS_PASSWORD') {
        if (!cred.sudo_password) {
          preflightFailed = 'sudo requires a password. Provide it in the sudo_password field, or grant passwordless sudo for this user.';
          break;
        }
        // Will pass -S flag with password to sudo below — note it
        emit('install_stdout', '[sudo] Will use provided sudo password.');
      }
    }

    emit('divider', '');

    if (preflightFailed) {
      emit('error', `Pre-flight failed: ${preflightFailed}`, { code: 'PREFLIGHT_FAILED' });
      sshClient.end();
      await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: preflightFailed });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    emit('step', '✓ Pre-flight passed');

    // ── Create draft connection + issue install token ──────────────────────────
    await transition('installing');
    emit('step', 'Creating connection record…');

    let installToken = cred.install_token;
    let connectionId = null;

    if (!installToken) {
      try {
        const appUrl = process.env.APP_URL || 'https://tunevault.app';
        const rawKey = 'tvp_' + crypto.randomBytes(24).toString('hex');
        const { encrypt } = require('../crypto-utils');
        const encryptedKey = encrypt(rawKey);
        const displayName = cred.connection_name || cred.host;

        const conn = await agentDb.createAgentOnlyConnection({
          name: displayName,
          encryptedKey,
          userId: user.id,
          hostIp: cred.host,
          sshUser: cred.username,
          privilegeModel: 'reader',
        });

        await agentDb.setConnectionStatus(conn.id, 'pending_registration');

        const token = crypto.randomBytes(32).toString('hex');
        await agentDb.createRegToken({ token, connectionId: conn.id, userId: user.id });

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await agentDb.setInstallTokenHash(conn.id, tokenHash);

        installToken = token;
        connectionId = conn.id;

        // Also stamp install token issued timestamp
        await agentDb.stampInstallTokenIssuedAt(conn.id).catch(() => {});

        // Update job with connection_id without changing terminal status
        await jobsDb.setConnectionId(jobId, conn.id);
        emit('step', `✓ Connection "${displayName}" created (id=${conn.id})`);
      } catch (err) {
        const msg = `Failed to create connection record: ${err.message}`;
        emit('error', msg, { code: 'DRAFT_CREATE_FAILED' });
        sshClient.end();
        await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: msg });
        _scheduleEvict(jobId); _clearLogBuf(jobId);
        _closeSseClients(jobId);
        return;
      }
    }

    // ── Upload install.sh ─────────────────────────────────────────────────────
    emit('step', 'Uploading TuneVault installer via SFTP…');

    const installShPath = path.join(__dirname, '..', 'install.sh');
    let installShContent;
    try {
      installShContent = fs.readFileSync(installShPath);
    } catch (_) {
      const msg = 'install.sh not found on server. Contact support.';
      emit('error', msg, { code: 'INSTALLER_MISSING' });
      sshClient.end();
      await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: msg });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    const remoteTmpPath = `/tmp/tunevault-install-${jobId}.sh`;

    const uploadResult = await new Promise((resolve) => {
      sshClient.sftp((err, sftp) => {
        if (err) return resolve(new Error(`SFTP session failed: ${err.message}`));
        const ws = sftp.createWriteStream(remoteTmpPath, { mode: 0o700 });
        ws.on('error', e => resolve(new Error(`SFTP write error: ${e.message}`)));
        ws.on('close', () => resolve(true));
        ws.end(installShContent);
      });
    });

    if (uploadResult instanceof Error) {
      emit('error', uploadResult.message, { code: 'SFTP_UPLOAD_FAILED' });
      sshClient.end();
      await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: uploadResult.message });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    emit('step', `✓ Installer uploaded to ${remoteTmpPath}`);

    // ── Run installer ─────────────────────────────────────────────────────────
    emit('step', `Executing installer with token… (this takes ~60-90s)`);
    emit('divider', '');

    // Use sudo -n (or sudo -S with password if needed)
    const sudoNeedsPassword = cred.sudo_password ? true : false;
    let installCmd;
    if (sudoNeedsPassword) {
      // echo password | sudo -S ...
      const escapedPwd = cred.sudo_password.replace(/'/g, "'\\''");
      installCmd = `echo '${escapedPwd}' | sudo -S bash ${remoteTmpPath} --tunevault-token=${installToken} --auto 2>&1`;
    } else {
      installCmd = `sudo -n bash ${remoteTmpPath} --tunevault-token=${installToken} --auto 2>&1`;
    }

    const installResult = await new Promise((resolve) => {
      sshClient.exec(installCmd, (err, stream) => {
        if (err) return resolve(new Error(`exec error: ${err.message}`));

        let lineBuf = '';
        let exitCode = null;

        stream.on('data', (data) => {
          lineBuf += data.toString();
          const parts = lineBuf.split('\n');
          lineBuf = parts.pop();
          for (const line of parts) {
            emit('install_stdout', line);
          }
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString().trim();
          if (text) emit('install_stderr', text);
        });

        stream.on('close', (code) => {
          if (lineBuf.trim()) emit('install_stdout', lineBuf);
          exitCode = code;
          resolve({ exitCode });
        });
      });
    });

    emit('divider', '');

    if (installResult instanceof Error) {
      const msg = `Installer execution failed: ${installResult.message}`;
      emit('error', msg, { code: 'INSTALL_EXEC_FAILED' });
      sshClient.end();
      await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: msg });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    if (installResult.exitCode !== 0) {
      const msg = `Installer exited with code ${installResult.exitCode}. Check log above for the specific error.`;
      emit('error', msg, { code: 'INSTALL_NONZERO_EXIT', exit_code: installResult.exitCode });
      // Cleanup temp file
      _execSimple(sshClient, `rm -f ${remoteTmpPath}`, 5000).catch(() => {});
      sshClient.end();
      await jobsDb.finishJob(jobId, { status: 'failed', exitCode: installResult.exitCode, errorMessage: msg });
      _scheduleEvict(jobId); _clearLogBuf(jobId);
      _closeSseClients(jobId);
      return;
    }

    emit('step', '✓ Installer finished — waiting for agent to register…');

    // ── Cleanup temp script ───────────────────────────────────────────────────
    _execSimple(sshClient, `rm -f ${remoteTmpPath}`, 5000).catch(() => {});

    // ── Run doctor --deep over SSH ────────────────────────────────────────────
    emit('step', 'Running `tunevault-agent doctor --deep` to verify…');
    emit('divider', '');
    await transition('verifying');

    const doctorOut = await _execSimple(sshClient, 'tunevault-agent doctor --deep 2>&1', 30_000);
    if (doctorOut) {
      for (const line of doctorOut.split('\n')) {
        if (line.trim()) emit('install_stdout', line);
      }
    }

    emit('divider', '');
    sshClient.end();
    sshClient = null;

    // ── Wait for agent to register ────────────────────────────────────────────
    if (connectionId) {
      emit('step', 'Waiting for agent to phone home (up to 90s)…');

      const registered = await _waitForRegistration(connectionId, 90_000, (msg) => {
        emit('install_stdout', msg);
      });

      if (registered) {
        emit('step', '✓ Agent registered with TuneVault cloud');
        const tunnel = await agentDb.getTunnel(connectionId).catch(() => null);
        const sids   = tunnel && tunnel.oracle_sids ? tunnel.oracle_sids : [];
        const agentV = tunnel && tunnel.agent_version ? tunnel.agent_version : null;

        const successMsg = [
          '✓ Agent is online',
          agentV ? `Agent v${agentV}` : '',
          sids.length ? `Detected SIDs: ${sids.join(', ')}` : 'No SIDs detected yet',
        ].filter(Boolean).join(' — ');

        emit('step', successMsg);
        emit('success', successMsg, { connection_id: connectionId, agent_version: agentV, detected_sids: sids });
        await jobsDb.finishJob(jobId, { status: 'success', exitCode: 0, connectionId });
      } else {
        const msg = 'Agent did not register within 90s. It may still be starting — check /connections in a minute.';
        emit('step', msg);
        emit('success', msg, { connection_id: connectionId, warning: true });
        // Still mark success — installer ran clean
        await jobsDb.finishJob(jobId, { status: 'success', exitCode: 0, connectionId });
      }
    } else {
      emit('step', '✓ Installer finished. Token provided externally — no connection record to poll.');
      emit('success', 'Installer completed.', { connection_id: null });
      await jobsDb.finishJob(jobId, { status: 'success', exitCode: 0 });
    }

  } catch (err) {
    console.error(`[install-jobs] worker error job=${jobId}:`, err.message);
    const msg = `Unexpected error: ${err.message}`;
    try { emit('error', msg, { code: 'INTERNAL_ERROR' }); } catch (_) {}
    try { await jobsDb.finishJob(jobId, { status: 'failed', errorMessage: msg }); } catch (_) {}
    if (sshClient) { try { sshClient.end(); } catch (_) {} }
  } finally {
    _scheduleEvict(jobId);
    _clearLogBuf(jobId);
    _closeSseClients(jobId);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run a single command over SSH and return stdout+stderr as string.
 * Times out after timeoutMs.
 */
function _execSimple(sshClient, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(''), timeoutMs);

    sshClient.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return resolve(''); }

      let out = '';
      stream.on('data', d => { out += d.toString(); });
      stream.stderr.on('data', d => { out += d.toString(); });
      stream.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    });
  });
}

/**
 * Poll agent_tunnels until the agent phones home or timeout.
 */
async function _waitForRegistration(connectionId, waitMs, onDot) {
  const deadline = Date.now() + waitMs;
  let lastDot = Date.now();

  while (Date.now() < deadline) {
    try {
      const tunnel = await agentDb.getTunnel(connectionId);
      const confirmed = tunnel && (tunnel.status === 'confirmed' || tunnel.status === 'active');
      const heartbeatRecent = tunnel && tunnel.last_heartbeat &&
        new Date(tunnel.last_heartbeat) > new Date(Date.now() - 120_000);

      if (confirmed || heartbeatRecent) return true;
    } catch (_) { /* poll anyway */ }

    if (Date.now() - lastDot >= 5000) {
      onDot && onDot('  ⋯ still waiting…');
      lastDot = Date.now();
    }

    await _sleep(2000);
  }
  return false;
}

/**
 * Close and evict all SSE clients for a finished job.
 */
function _closeSseClients(jobId) {
  const key = String(jobId);
  const set = _sseClients.get(key);
  if (!set) return;
  for (const res of set) {
    try { if (!res.writableEnded) res.end(); } catch (_) {}
  }
  _sseClients.delete(key);
}

module.exports = router;
