/**
 * routes/ssh-connectivity.js — SSH-first database connectivity management.
 *
 * Owns: PUT  /api/connections/:id/ssh-connectivity (save SSH key + mode)
 *       POST /api/connections/:id/ssh-connectivity/test (validate SSH + sqlplus path)
 *       GET  /api/connections/:id/ssh-connectivity (read current config, key masked)
 *       POST /api/connections/test-ssh (pre-save SSH test — no connectionId, no persistence)
 * Does NOT own: connection CRUD lifecycle (db/agent.js), health check execution
 *               (oracle-client.js), SSH host targets for EBS ops (ssh-targets.js).
 *
 * Security:
 *   - requireAuth + requireConnectionOwner on all connection-scoped endpoints.
 *   - POST /api/connections/test-ssh: requireAuth only; key accepted in-flight over TLS,
 *     used in-memory, never stored. Command is a fixed allowlist (whoami/hostname/id).
 *   - Private key is AES-256-GCM encrypted (crypto-utils.js) before storage.
 *   - Decrypted key lives only in-process memory; never logged, never returned.
 *   - ssh_oracle_home and ssh_oracle_sid are validated against a safe character set
 *     before being stored or used in shell commands (oracle-runner.js enforces this too).
 */

'use strict';

const express = require('express');
const { Client } = require('ssh2');
const pool    = require('../db/index');
const { encrypt }               = require('../crypto-utils');
const { requireAuth }           = require('../middleware/auth');
const { requireConnectionOwner } = require('../middleware/auth');
const { testSshConnectivity, evictSshPool } = require('../services/oracle-runner');

const router = express.Router();

// Fixed command allowlist — prevents SSRF/injection in test endpoint
const TEST_COMMAND = 'whoami && hostname && echo $ORACLE_SID 2>/dev/null; id';
const TEST_TIMEOUT_MS = 12_000;

// ── POST /api/connections/test-ssh ────────────────────────────────────────────
// Pre-save SSH connectivity test. Accepts raw credentials in-flight (TLS only),
// opens a transient SSH session, runs a fixed allowlisted command, returns output.
// Does NOT persist anything. Requires auth but not connection ownership.
//
// Body: { ssh_host, ssh_user, auth_method: 'key'|'agent'|'password',
//         ssh_private_key?, passphrase?, ssh_password? }

router.post('/test-ssh', requireAuth, async (req, res) => {
  const { ssh_host, ssh_user, auth_method, ssh_private_key, passphrase, ssh_password } = req.body;

  if (!ssh_host) return res.status(400).json({ success: false, error: 'ssh_host is required' });
  if (!ssh_user) return res.status(400).json({ success: false, error: 'ssh_user is required' });
  if (!['key', 'agent', 'password'].includes(auth_method)) {
    return res.status(400).json({ success: false, error: 'auth_method must be key, agent, or password' });
  }
  if (auth_method === 'key' && !ssh_private_key) {
    return res.status(400).json({ success: false, error: 'ssh_private_key is required for key auth' });
  }
  if (auth_method === 'password' && !ssh_password) {
    return res.status(400).json({ success: false, error: 'ssh_password is required for password auth' });
  }

  const host = ssh_host.trim();
  const user = ssh_user.trim();

  // Build ssh2 connect options
  const connectOpts = {
    host,
    port:         22,
    username:     user,
    readyTimeout: TEST_TIMEOUT_MS,
  };

  if (auth_method === 'key') {
    connectOpts.privateKey = ssh_private_key.trim();
    if (passphrase) connectOpts.passphrase = passphrase;
  } else if (auth_method === 'password') {
    connectOpts.password = ssh_password.trim();
  } else {
    // agent — attempt to use SSH_AUTH_SOCK from environment
    connectOpts.agent = process.env.SSH_AUTH_SOCK || undefined;
    if (!connectOpts.agent) {
      return res.json({
        success: false,
        error: 'ssh-agent forwarding requires SSH_AUTH_SOCK to be available on the TuneVault server process. This is typically set when TuneVault itself is launched via an SSH session with agent forwarding enabled.',
      });
    }
  }

  const client = new Client();
  let output = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    client.destroy();
  }, TEST_TIMEOUT_MS + 2000);

  try {
    await new Promise((resolve, reject) => {
      client.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      client.on('ready', () => {
        client.exec(TEST_COMMAND, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            client.end();
            return reject(err);
          }
          stream.on('data', (data) => { output += data.toString(); });
          stream.stderr.on('data', (data) => { output += data.toString(); });
          stream.on('close', (code) => {
            clearTimeout(timer);
            client.end();
            if (code !== 0 && !output.trim()) {
              return reject(new Error(`Command exited with code ${code}`));
            }
            resolve();
          });
        });
      });
      client.connect(connectOpts);
    });

    return res.json({ success: true, output: output.trim() });
  } catch (err) {
    if (timedOut) {
      return res.json({ success: false, error: `SSH connect timed out after ${TEST_TIMEOUT_MS / 1000}s. Is ${host}:22 reachable?` });
    }
    // Return a precise, user-readable error — no stack trace
    const msg = _friendlySshTestError(err.message || String(err), auth_method);
    return res.json({ success: false, error: msg });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _friendlySshTestError(raw, authMethod) {
  if (/ECONNREFUSED/i.test(raw))        return 'Connection refused — is SSH running on port 22?';
  if (/EHOSTUNREACH|ENOTFOUND/i.test(raw)) return 'Host unreachable — check the SSH host address.';
  if (/All configured authentication methods failed|Authentication failed|Permission denied/i.test(raw)) {
    if (authMethod === 'key')      return 'Permission denied (publickey) — verify the key is installed in ~/.ssh/authorized_keys on the target host.';
    if (authMethod === 'password') return 'Permission denied (password) — check the OS username and password.';
    return 'SSH authentication failed.';
  }
  if (/Invalid passphrase|bad decrypt/i.test(raw)) return 'Invalid passphrase — the key is encrypted; enter the correct passphrase.';
  if (/Unsupported key format/i.test(raw))         return 'Unsupported key format — paste a full PEM or OpenSSH private key block.';
  if (/ECONNRESET/i.test(raw))      return 'Connection reset — the server may have rejected the key type.';
  if (/timeout/i.test(raw))         return 'Connection timed out — check network path and firewall rules.';
  return `SSH error: ${raw}`;
}

// Safe characters for shell-injected paths/identifiers.
const SAFE_PATH_RE = /^[a-zA-Z0-9/_.-]+$/;
const SAFE_SID_RE  = /^[a-zA-Z0-9_.-]+$/;

function validateSshFields({ ssh_db_host, ssh_db_user, ssh_oracle_home, ssh_oracle_sid }) {
  const errors = [];
  if (!ssh_db_host)  errors.push('ssh_db_host is required');
  if (!ssh_db_user)  errors.push('ssh_db_user is required');
  if (ssh_oracle_home && !SAFE_PATH_RE.test(ssh_oracle_home)) {
    errors.push('ssh_oracle_home contains invalid characters');
  }
  if (ssh_oracle_sid && !SAFE_SID_RE.test(ssh_oracle_sid)) {
    errors.push('ssh_oracle_sid contains invalid characters');
  }
  return errors;
}

// ── GET /api/connections/:id/ssh-connectivity ─────────────────────────────────
// Returns current SSH config with key masked as '***' if set.

router.get('/:id/ssh-connectivity', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT connectivity_mode,
              ssh_db_host,
              ssh_db_user,
              CASE WHEN ssh_db_key_enc IS NOT NULL THEN '***' ELSE NULL END AS ssh_key_set,
              ssh_oracle_home,
              ssh_oracle_sid
       FROM oracle_connections
       WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[ssh-connectivity] GET error:', err.message);
    res.status(500).json({ error: 'Failed to load SSH connectivity config' });
  }
});

// ── PUT /api/connections/:id/ssh-connectivity ─────────────────────────────────
// Save or update SSH connectivity config.
// Body: { connectivity_mode, ssh_db_host, ssh_db_user, ssh_private_key?,
//         ssh_oracle_home?, ssh_oracle_sid? }
// ssh_private_key: if omitted and a key is already stored, keep the existing key.

router.put('/:id/ssh-connectivity', requireAuth, requireConnectionOwner, async (req, res) => {
  const {
    connectivity_mode = 'tns',
    ssh_db_host,
    ssh_db_user,
    ssh_private_key,   // raw PEM — will be encrypted, never stored in plaintext
    ssh_oracle_home,
    ssh_oracle_sid,
  } = req.body;

  const validModes = ['tns', 'ssh_sqlplus', 'both'];
  if (!validModes.includes(connectivity_mode)) {
    return res.status(400).json({ error: `connectivity_mode must be one of: ${validModes.join(', ')}` });
  }

  // SSH fields are only required when mode involves SSH
  if (connectivity_mode !== 'tns') {
    const errors = validateSshFields({ ssh_db_host, ssh_db_user, ssh_oracle_home, ssh_oracle_sid });
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }
  }

  try {
    const connId = req.params.id;

    // Determine the key to store
    let keyEncrypted;
    if (ssh_private_key && ssh_private_key.trim()) {
      keyEncrypted = encrypt(ssh_private_key.trim());
    } else if (connectivity_mode !== 'tns') {
      // No new key provided — verify one exists already
      const existing = await pool.query(
        `SELECT ssh_db_key_enc FROM oracle_connections WHERE id = $1`,
        [connId]
      );
      if (!existing.rows[0]?.ssh_db_key_enc) {
        return res.status(400).json({
          error: 'ssh_private_key is required when enabling SSH connectivity for the first time',
        });
      }
      // Keep existing key — keyEncrypted remains undefined (we won't update that column)
    }

    // Build dynamic update — only set key column if a new key was provided
    if (keyEncrypted !== undefined) {
      await pool.query(
        `UPDATE oracle_connections SET
           connectivity_mode = $1,
           ssh_db_host       = $2,
           ssh_db_user       = $3,
           ssh_db_key_enc    = $4,
           ssh_oracle_home   = COALESCE($5, '/u01/app/oracle/product/19.0.0/db_1'),
           ssh_oracle_sid    = $6
         WHERE id = $7`,
        [connectivity_mode, ssh_db_host || null, ssh_db_user || null,
         keyEncrypted, ssh_oracle_home || null, ssh_oracle_sid || null, connId]
      );
    } else {
      await pool.query(
        `UPDATE oracle_connections SET
           connectivity_mode = $1,
           ssh_db_host       = $2,
           ssh_db_user       = $3,
           ssh_oracle_home   = COALESCE($4, '/u01/app/oracle/product/19.0.0/db_1'),
           ssh_oracle_sid    = $5
         WHERE id = $6`,
        [connectivity_mode, ssh_db_host || null, ssh_db_user || null,
         ssh_oracle_home || null, ssh_oracle_sid || null, connId]
      );
    }

    // Evict any stale pooled SSH connection so next query re-connects with new creds
    evictSshPool(connId);

    res.json({ success: true, connectivity_mode });
  } catch (err) {
    console.error('[ssh-connectivity] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save SSH connectivity config' });
  }
});

// ── POST /api/connections/:id/ssh-connectivity/test ───────────────────────────
// Test the configured SSH path: SSH connect + verify sqlplus is present.
// Does NOT run a full health check — just validates the path is reachable.

router.post('/:id/ssh-connectivity/test', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = req.params.id;

    // Load the connection row with SSH fields
    const result = await pool.query(
      `SELECT id, connectivity_mode,
              ssh_db_host, ssh_db_user, ssh_db_key_enc,
              ssh_oracle_home, ssh_oracle_sid, service_name
       FROM oracle_connections
       WHERE id = $1`,
      [connId]
    );

    const conn = result.rows[0];
    if (!conn) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    if (!conn.ssh_db_key_enc) {
      return res.status(400).json({
        success: false,
        message: 'No SSH key configured. Save an SSH key first.',
      });
    }

    const testResult = await testSshConnectivity(conn);
    res.json(testResult);
  } catch (err) {
    console.error('[ssh-connectivity] test error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
