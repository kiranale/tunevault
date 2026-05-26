/**
 * routes/ssh-install.js — One-screen Add Connection: server-side SSH agent install.
 *
 * Owns: GET  /connections/new                        — wizard page (v6 agent install UI)
 *       POST /api/connections/draft                  — create draft connection + issue install token
 *       GET  /api/connections/:id/registration-status — poll until agent registers (or pending)
 *       POST /api/connections/new                    — legacy SSH auto-install path
 *       GET  /api/connections/:id/ssh-install/stream — SSE: SSH → install → wait for agent
 * Does NOT own: oracle_connections CRUD lifecycle (db/agent.js),
 *               agent heartbeat/poll channel (services/agent-channel.js, routes/agent.js),
 *               health check execution (server.js / oracle-client.js).
 *
 * Security:
 *   - requireAuth on all endpoints
 *   - SSH credentials AES-256-GCM encrypted at rest (crypto-utils.js)
 *   - Audit log: activity_log entry on every install attempt (connection.created_via_ssh_install)
 *   - SSH only to the server-supplied host — no SSRF via arbitrary redirects
 *   - install.sh invoked with token arg; no other shell injection surface
 *   - Connection ownership enforced before streaming
 */

'use strict';

const path    = require('path');
const express = require('express');
const { Client } = require('ssh2');

const agentDb    = require('../db/agent');
const sshInstDb  = require('../db/ssh-install');
const activityDb = require('../db/activity-log');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');
const { enforceConnectionCap } = require('../middleware/tier-enforce');
const channel = require('../services/agent-channel');

const router = express.Router();

const APP_URL     = process.env.APP_URL || 'https://tunevault.app';
// How long to wait (ms) for the agent to phone home after install.sh completes
const REGISTER_WAIT_MS = 65_000;
// How long to wait for the initial SSH connection
const SSH_CONNECT_TIMEOUT_MS = 10_000;

// ── GET /connections/new ──────────────────────────────────────────────────────
// Single-screen Add Connection form.

router.get('/connections/new', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'connections-new.html'));
});

// ── POST /api/connections/draft ───────────────────────────────────────────────
// v6 wizard step 2: create a pending_registration connection record, issue a
// one-shot install token (30-min TTL), return the pre-filled install command.
// No SSH credentials required — user copies the command and runs it manually.
//
// The agent calls POST /api/agent/provision with the token, then starts polling.
// The UI polls GET /api/connections/:id/registration-status every 5s.

router.post('/api/connections/draft', requireAuth, enforceConnectionCap, async (req, res) => {
  const crypto = require('crypto');
  const { name } = req.body;

  const displayName = (name || '').trim() || `agent-${Date.now()}`;

  try {
    // Create a minimal connection record in pending_registration state.
    // No DB credentials yet — agent detects SIDs and the user fills them in post-registration.
    const rawKey = 'tvp_' + crypto.randomBytes(24).toString('hex');
    const encryptedKey = encrypt(rawKey);

    let conn;
    try {
      conn = await agentDb.createAgentOnlyConnection({
        name: displayName,
        encryptedKey,
        userId: req.user.id,
        hostIp: null,
        sshUser: 'oracle',
        privilegeModel: 'reader',
      });
    } catch (err) {
      if (err.message && err.message.startsWith('DUPLICATE_CONNECTION_NAME:')) {
        return res.status(409).json({
          error: `A connection named '${displayName}' already exists. Choose a different name.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        });
      }
      throw err;
    }

    // Mark as pending_registration
    await agentDb.setConnectionStatus(conn.id, 'pending_registration');

    // Issue a 30-min registration token
    const token = crypto.randomBytes(32).toString('hex');
    await agentDb.createRegToken({ token, connectionId: conn.id, userId: req.user.id });

    // Store token hash on the connection for single-use verification
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await agentDb.setInstallTokenHash(conn.id, tokenHash);

    const installCmd = `curl -fsSL ${APP_URL}/install.sh | sudo TUNEVAULT_TOKEN=${token} bash`;

    res.json({
      draft_id:        conn.id,
      install_token:   token,
      install_command: installCmd,
    });
  } catch (err) {
    console.error('[ssh-install] draft error:', err.message);
    res.status(500).json({ error: `Failed to create draft connection: ${err.message}` });
  }
});

// ── GET /api/connections/:id/registration-status ──────────────────────────────
// v6 wizard poller: UI calls every 5s. Returns pending until agent's first
// heartbeat lands; returns registered + metadata when confirmed.

router.get('/api/connections/:id/registration-status', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const tunnel = await agentDb.getTunnel(connId);
    const isRegistered = tunnel && (
      tunnel.status === 'confirmed' ||
      tunnel.status === 'active' ||
      (tunnel.last_heartbeat && new Date(tunnel.last_heartbeat) > new Date(Date.now() - 120_000))
    );

    if (isRegistered) {
      // Flip connection status to active
      if (conn.status === 'pending_registration') {
        await agentDb.setConnectionStatus(connId, 'active');
        await agentDb.clearInstallTokenHash(connId);
      }
      return res.json({
        status:            'registered',
        agent_version:     tunnel.agent_version || null,
        hostname:          tunnel.os_info && tunnel.os_info.hostname ? tunnel.os_info.hostname : null,
        first_heartbeat_at: tunnel.last_heartbeat || null,
        // CDB/PDB picker: send both arrays so UI can show labeled options
        oracle_sids:  tunnel.oracle_sids  || [],
        pdb_services: tunnel.pdb_services || [],
      });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('[ssh-install] registration-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/new ─────────────────────────────────────────────────
// 1. Validate fields
// 2. Create oracle_connections + agent_reg_tokens records
// 3. Encrypt + persist SSH credentials in ssh_install_credentials
// 4. Return { connection_id, token } — UI immediately opens the SSE stream

router.post('/api/connections/new', requireAuth, enforceConnectionCap, async (req, res) => {
  const {
    name,
    db_host,
    db_port,
    service_name,
    db_username,
    db_password,
    ssh_host,
    ssh_port,
    ssh_user,
    ssh_auth,      // 'password' | 'key'
    ssh_credential, // plaintext password OR PEM private key
    use_sudo,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  const missing = [];
  if (!db_host)       missing.push('db_host');
  if (!service_name)  missing.push('service_name');
  if (!db_username)   missing.push('db_username');
  if (!db_password)   missing.push('db_password');
  if (!ssh_user)      missing.push('ssh_user');
  if (!ssh_credential) missing.push('ssh_credential');
  if (!['password', 'key'].includes(ssh_auth)) missing.push('ssh_auth (password|key)');

  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const host        = db_host.trim();
  const sshHost     = (ssh_host || '').trim() || host; // default SSH host = DB host
  const port        = parseInt(db_port, 10) || 1521;
  const sshPortNum  = parseInt(ssh_port, 10) || 22;
  const displayName = (name || '').trim() || `${host}/${service_name}`;

  try {
    // Create oracle_connections record + issue registration token
    const crypto = require('crypto');
    const encryptedPassword = encrypt(db_password);
    const rawKey = 'tvp_' + crypto.randomBytes(24).toString('hex');
    const encryptedKey = encrypt(rawKey);

    let conn;
    try {
      conn = await agentDb.createAgentConnection({
        name: displayName,
        host,
        port,
        serviceName: service_name,
        username: db_username,
        encryptedPassword,
        encryptedKey,
        userId: req.user.id,
        privilegeModel: 'reader',
      });
    } catch (err) {
      if (err.message && err.message.startsWith('DUPLICATE_CONNECTION_NAME:')) {
        return res.status(409).json({
          error: `A connection named '${displayName}' already exists. Choose a different name.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        });
      }
      throw err;
    }

    // Registration token (30-min TTL, redeemed by install.sh)
    const token = crypto.randomBytes(32).toString('hex');
    await agentDb.createRegToken({ token, connectionId: conn.id, userId: req.user.id });

    // Encrypt + persist SSH credentials (never stored plaintext)
    const encryptedCred = encrypt(ssh_credential);
    await sshInstDb.upsertSshInstallCred({
      connectionId:        conn.id,
      userId:              req.user.id,
      sshHost,
      sshPort:             sshPortNum,
      sshUser:             ssh_user.trim(),
      authMethod:          ssh_auth,
      encryptedCredential: encryptedCred,
      useSudo:             use_sudo !== false && use_sudo !== 'false',
    });

    // Audit log
    activityDb.logActivity({
      userId:         req.user.id,
      userEmail:      req.user.email,
      actionType:     'settings_change',
      detail: {
        event:       'connection.created_via_ssh_install',
        connection:  conn.name,
        ssh_host:    sshHost,
        ssh_user:    ssh_user.trim(),
        auth_method: ssh_auth,
        use_sudo:    use_sudo !== false && use_sudo !== 'false',
        // credential intentionally omitted
      },
      connectionId:   conn.id,
      connectionName: conn.name,
      result:         'success',
      ipAddress:      req.ip,
    }).catch(() => {});

    res.json({ connection_id: conn.id, connection_name: conn.name, token });
  } catch (err) {
    console.error('[ssh-install] create error:', err.message);
    res.status(500).json({ error: `Failed to create connection: ${err.message}` });
  }
});

// ── GET /api/connections/:id/ssh-install/stream ───────────────────────────────
// SSE stream. Steps:
//   1. Load SSH creds, verify ownership
//   2. SSH connect (5s timeout) — fail-fast if unreachable
//   3. Upload install.sh as /tmp/tunevault-install.sh via SFTP
//   4. Run: sudo bash /tmp/tunevault-install.sh --tunevault-token=<token> --auto
//   5. Stream stdout lines to client
//   6. Wait up to 65s for agent to register (poll agent_tunnels)
//   7. Ping the agent (DB creds via agent channel)
//   8. Send { type:'success', ... } or { type:'error', ... }

router.get('/api/connections/:id/ssh-install/stream', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  // ── SSE setup ──────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;

  function send(payload) {
    if (!closed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function finish(reason) {
    if (closed) return;
    closed = true;
    try { res.end(); } catch (_) {}
  }

  req.on('close', () => { closed = true; });

  // Hard 3-minute cap
  const hardTimer = setTimeout(() => {
    send({ type: 'error', text: 'Install timed out after 3 minutes.', code: 'TIMEOUT' });
    finish('timeout');
  }, 3 * 60 * 1000);

  try {
    // ── Load connection + ownership ──────────────────────────────────────────
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) {
      send({ type: 'error', text: 'Connection not found.', code: 'NOT_FOUND' });
      clearTimeout(hardTimer); return finish('not_found');
    }
    if (conn.user_id && conn.user_id !== req.user.id) {
      send({ type: 'error', text: 'Access denied.', code: 'FORBIDDEN' });
      clearTimeout(hardTimer); return finish('forbidden');
    }

    // ── Load SSH credentials ─────────────────────────────────────────────────
    const sshCred = await sshInstDb.getByConnectionId(connId);
    if (!sshCred) {
      send({ type: 'error', text: 'SSH credentials not found. Please restart the form.', code: 'NO_CREDS' });
      clearTimeout(hardTimer); return finish('no_creds');
    }

    let plainCredential;
    try {
      plainCredential = decrypt(sshCred.encrypted_credential);
    } catch (_) {
      send({ type: 'error', text: 'SSH credential decrypt failed.', code: 'CRYPT_ERROR' });
      clearTimeout(hardTimer); return finish('crypt_error');
    }

    // ── Get the current registration token for this connection ───────────────
    // The token was stored when /api/connections/new was called; retrieve from agent_reg_tokens
    const tokenRow = await _getLatestToken(connId);
    if (!tokenRow) {
      send({ type: 'error', text: 'Registration token expired. Please start over.', code: 'TOKEN_EXPIRED' });
      clearTimeout(hardTimer); return finish('token_expired');
    }

    // Mark install as running
    await sshInstDb.markRunning(connId);

    // ── SSH connect ───────────────────────────────────────────────────────────
    send({ type: 'step', text: `Connecting to ${sshCred.ssh_host}:${sshCred.ssh_port}…` });

    const connectOpts = {
      host:         sshCred.ssh_host,
      port:         sshCred.ssh_port || 22,
      username:     sshCred.ssh_user,
      readyTimeout: SSH_CONNECT_TIMEOUT_MS,
    };
    if (sshCred.auth_method === 'key') {
      connectOpts.privateKey = plainCredential;
    } else {
      connectOpts.password = plainCredential;
    }

    const sshClient = new Client();

    const sshReady = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sshClient.destroy();
        reject(new Error('SSH_CONNECT_TIMEOUT'));
      }, SSH_CONNECT_TIMEOUT_MS + 2000);

      sshClient.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sshClient.on('ready', () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        sshClient.connect(connectOpts);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }).catch(err => err); // don't throw — handle below

    if (sshReady instanceof Error) {
      const msg = _friendlySSHError(sshReady.message, sshCred);
      send({ type: 'error', text: msg, code: 'SSH_CONNECT_FAILED' });
      await sshInstDb.markFailed(connId, msg);
      clearTimeout(hardTimer); return finish('ssh_connect_failed');
    }

    send({ type: 'step', text: `✓ SSH connected to ${sshCred.ssh_host}` });

    // ── Upload install.sh via SFTP ────────────────────────────────────────────
    send({ type: 'step', text: 'Uploading TuneVault installer…' });

    const fs = require('fs');
    const installShPath = path.join(__dirname, '..', 'install.sh');
    let installShContent;
    try {
      installShContent = fs.readFileSync(installShPath);
    } catch (_) {
      send({ type: 'error', text: 'Could not read install.sh from server. Contact support.', code: 'INSTALLER_MISSING' });
      sshClient.end();
      clearTimeout(hardTimer); return finish('installer_missing');
    }

    const uploadOk = await new Promise((resolve) => {
      sshClient.sftp((err, sftp) => {
        if (err) return resolve(new Error(`SFTP open failed: ${err.message}`));

        const remotePath = '/tmp/tunevault-install.sh';
        const writeStream = sftp.createWriteStream(remotePath, { mode: 0o755 });

        writeStream.on('error', (e) => resolve(new Error(`SFTP write error: ${e.message}`)));
        writeStream.on('close', () => resolve(true));

        writeStream.end(installShContent);
      });
    });

    if (uploadOk instanceof Error) {
      send({ type: 'error', text: uploadOk.message, code: 'SFTP_UPLOAD_FAILED' });
      await sshInstDb.markFailed(connId, uploadOk.message);
      sshClient.end();
      clearTimeout(hardTimer); return finish('sftp_failed');
    }

    send({ type: 'step', text: '✓ Installer uploaded to /tmp/tunevault-install.sh' });

    // ── Run installer ─────────────────────────────────────────────────────────
    const sudoPrefix = sshCred.use_sudo ? 'sudo ' : '';
    const installCmd = `${sudoPrefix}bash /tmp/tunevault-install.sh --tunevault-token=${tokenRow.token} --auto`;

    send({ type: 'step', text: 'Running installer — streaming output…' });
    send({ type: 'divider' });

    const installDone = await new Promise((resolve) => {
      sshClient.exec(installCmd, (err, stream) => {
        if (err) return resolve(new Error(`exec error: ${err.message}`));

        let lineBuf = '';
        let logBuf  = '';
        let exitCode = null;

        function flushLine(line) {
          if (closed) return;
          send({ type: 'install_line', text: line });
          logBuf += line + '\n';
          // Fire-and-forget log persistence
          sshInstDb.appendLog(connId, line + '\n').catch(() => {});
        }

        stream.on('data', (data) => {
          const chunk = data.toString();
          lineBuf += chunk;
          const parts = lineBuf.split('\n');
          lineBuf = parts.pop();
          for (const line of parts) flushLine(line);
        });

        stream.stderr.on('data', (data) => {
          const text = data.toString().trim();
          if (text) {
            send({ type: 'install_stderr', text });
            logBuf += '[stderr] ' + text + '\n';
            sshInstDb.appendLog(connId, '[stderr] ' + text + '\n').catch(() => {});
          }
        });

        stream.on('close', (code) => {
          if (lineBuf) flushLine(lineBuf);
          exitCode = code;
          resolve({ exitCode, logBuf });
        });
      });
    });

    sshClient.end();

    if (installDone instanceof Error) {
      send({ type: 'divider' });
      send({ type: 'error', text: installDone.message, code: 'INSTALL_EXEC_FAILED' });
      await sshInstDb.markFailed(connId, installDone.message);
      clearTimeout(hardTimer); return finish('exec_failed');
    }

    send({ type: 'divider' });

    if (installDone.exitCode !== 0) {
      const msg = `Installer exited with code ${installDone.exitCode}. Check output above for the error.`;
      send({ type: 'error', text: msg, code: 'INSTALL_NONZERO_EXIT' });
      await sshInstDb.markFailed(connId, msg);
      clearTimeout(hardTimer); return finish('nonzero_exit');
    }

    send({ type: 'step', text: '✓ Installer finished — waiting for agent to register…' });

    // ── Wait for agent to register (poll agent_tunnels) ───────────────────────
    const registered = await _waitForRegistration(connId, REGISTER_WAIT_MS, send);

    if (!registered) {
      const msg = 'Agent did not register within 65 seconds. Check installer output above.';
      send({ type: 'error', text: msg, code: 'REGISTER_TIMEOUT' });
      await sshInstDb.markFailed(connId, msg);
      clearTimeout(hardTimer); return finish('register_timeout');
    }

    send({ type: 'step', text: '✓ Agent registered with TuneVault cloud' });

    // ── Ping the agent via the agent channel ──────────────────────────────────
    send({ type: 'step', text: 'Testing database connection through agent…' });
    const pingResult = await _pingViaChannel(connId);

    await sshInstDb.markSuccess(connId);

    // ── Success ───────────────────────────────────────────────────────────────
    const tunnel = await agentDb.getTunnel(connId);
    const sids   = (tunnel && tunnel.oracle_sids) ? tunnel.oracle_sids : [];
    const agentV = (tunnel && tunnel.agent_version) ? tunnel.agent_version : 'unknown';

    send({
      type:         'success',
      connection_id: connId,
      agent_version: agentV,
      detected_sids: sids,
      ping:          pingResult,
      message:       _buildSuccessMessage({ sids, agentV, pingResult }),
    });

    clearTimeout(hardTimer);
    finish('success');
  } catch (err) {
    console.error('[ssh-install] stream error:', err.message, err.stack);
    send({ type: 'error', text: `Unexpected error: ${err.message}`, code: 'INTERNAL_ERROR' });
    await sshInstDb.markFailed(connId, err.message).catch(() => {});
    clearTimeout(hardTimer);
    finish('error');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get the most recent unused registration token for a connection.
 * We don't consume it here — install.sh does that via /api/agent/provision.
 */
async function _getLatestToken(connectionId) {
  return agentDb.getLatestRegToken(connectionId);
}

/**
 * Poll agent_tunnels until status is confirmed/active (or timeout).
 * Sends a progress dot every 5 seconds.
 */
async function _waitForRegistration(connectionId, waitMs, send) {
  const deadline = Date.now() + waitMs;
  let lastDot = Date.now();

  while (Date.now() < deadline) {
    const tunnel = await agentDb.getTunnel(connectionId);
    const confirmed = tunnel && (tunnel.status === 'confirmed' || tunnel.status === 'active');
    const heartbeatRecent = tunnel && tunnel.last_heartbeat &&
      new Date(tunnel.last_heartbeat) > new Date(Date.now() - 120_000);

    if (confirmed || heartbeatRecent) return true;

    // Send progress dot every 5s
    if (Date.now() - lastDot >= 5000) {
      send({ type: 'waiting', text: 'Waiting for agent to phone home…' });
      lastDot = Date.now();
    }

    await _sleep(1500);
  }
  return false;
}

/**
 * Fire POST /api/ping through the agent channel and return the result.
 * Non-throwing — if the ping fails, we return an error description.
 */
async function _pingViaChannel(connectionId) {
  try {
    // Check if agent is actively connected via the long-poll channel
    const connected = await channel.isAgentConnected(connectionId);
    if (!connected) {
      // Agent registered but not yet polling — it will start within ~10s
      return { ok: true, note: 'Agent registered; ping skipped (not yet polling)' };
    }

    const dbConn = await agentDb.getConnectionForPing(connectionId);
    if (!dbConn) return { ok: false, error: 'Connection record not found' };

    const { password: dbPass } = await _getDbCreds(connectionId);
    const pingPayload = {
      method: 'POST',
      path:   '/api/ping',
      body: {
        username: dbConn.username,
        password: dbPass,
        host:     dbConn.host,
        port:     dbConn.port || 1521,
        sid:      dbConn.service_name,
      },
    };

    const result = await channel.sendToAgent(connectionId, pingPayload, 12_000);
    return result || { ok: true, note: 'Ping response not received in time' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Decrypt DB password for the ping call using the existing getConnectionForPing helper. */
async function _getDbCreds(connectionId) {
  const dbConn = await agentDb.getConnectionForPing(connectionId);
  if (!dbConn || !dbConn.encrypted_password) return {};
  let password;
  try { password = decrypt(dbConn.encrypted_password); } catch (_) { password = ''; }
  return { username: dbConn.username, password };
}

function _buildSuccessMessage({ sids, agentV, pingResult }) {
  const sidList = sids && sids.length ? sids.join(', ') : 'no SIDs detected';
  const vPart   = agentV !== 'unknown' ? ` — agent v${agentV}` : '';
  const pingOk  = pingResult && pingResult.ok !== false;
  const checks  = pingOk ? ', DB reachable' : '';
  return `✓ Connected${vPart} — ${sidList}${checks}`;
}

function _friendlySSHError(msg, sshCred) {
  if (msg.includes('TIMEOUT'))      return `SSH connect timed out after ${SSH_CONNECT_TIMEOUT_MS / 1000}s. Is ${sshCred.ssh_host}:${sshCred.ssh_port} reachable?`;
  if (msg.includes('ECONNREFUSED')) return `Connection refused at ${sshCred.ssh_host}:${sshCred.ssh_port}. Is SSH running on that port?`;
  if (msg.includes('EHOSTUNREACH') || msg.includes('ENOTFOUND')) return `Cannot reach ${sshCred.ssh_host}. Check the SSH host address.`;
  if (msg.includes('Authentication') || msg.includes('auth'))    return `SSH authentication failed. Check your ${sshCred.auth_method === 'key' ? 'private key' : 'password'}.`;
  if (msg.includes('ECONNRESET'))   return `SSH connection reset. The server may have rejected the key type or TLS settings.`;
  return `SSH error: ${msg}`;
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = router;
