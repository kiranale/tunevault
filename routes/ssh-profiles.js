/**
 * routes/ssh-profiles.js — SSH connection profiles for Oracle agent connections.
 *
 * Owns: CRUD for connection_ssh_profiles (per-role SSH config per connection),
 *       SSH connectivity test dispatched through agent channel.
 * Does NOT own: agent long-poll channel (services/agent-channel.js),
 *               general connection CRUD (routes/connections-list.js),
 *               SSH command execution (routes/ssh-execute.js).
 *
 * Key security rules:
 *   - Private keys are encrypted (AES-256-GCM) before storage, never logged.
 *   - API responses never include ciphertext — only the fingerprint.
 *   - Test endpoint decrypts keys in memory, forwards to agent, does not log.
 *   - All endpoints require ownership of the parent oracle_connection.
 */

'use strict';

const express = require('express');
const pool = require('../db/index');
const sshProfilesDb = require('../db/ssh-profiles');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');

const router = express.Router();

const VALID_ROLES = ['db_host', 'apps_tier', 'concurrent_tier', 'web_tier'];

// ── Ownership helper ──────────────────────────────────────────────────────────
// Confirms the connection exists and belongs to this user.
// Returns the connection row or null.
async function getOwnedConnection(connectionId, userId) {
  const result = await pool.query(
    `SELECT id, connection_type, user_id FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  const conn = result.rows[0];
  if (!conn) return null;
  // NULL user_id = legacy shared connection accessible to any authenticated user
  if (conn.user_id && conn.user_id !== userId) return null;
  return conn;
}

// ── GET /api/connections/:id/ssh-profiles ─────────────────────────────────────
// List all SSH profiles for a connection (no key material).
router.get('/connections/:id/ssh-profiles', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const profiles = await sshProfilesDb.getProfilesForConnection(connectionId);
    res.json(profiles);
  } catch (err) {
    console.error('[ssh-profiles] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch SSH profiles' });
  }
});

// ── POST /api/connections/:id/ssh-profiles ────────────────────────────────────
// Create a new SSH profile for a specific role.
// Body: { role, ssh_host, ssh_port, ssh_user, auth_method, ssh_key, key_passphrase,
//         bastion_host, bastion_port, bastion_user, bastion_key, bastion_passphrase }
// Private key (ssh_key) is encrypted before storage; fingerprint derived from key material.
router.post('/connections/:id/ssh-profiles', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const {
      role, ssh_host, ssh_port, ssh_user, auth_method,
      ssh_key, key_passphrase,
      bastion_host, bastion_port, bastion_user, bastion_key, bastion_passphrase,
    } = req.body;

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!ssh_host || !ssh_host.trim()) {
      return res.status(400).json({ error: 'ssh_host is required' });
    }
    if (!['agent_forward', 'key_upload', 'password'].includes(auth_method)) {
      return res.status(400).json({ error: 'auth_method must be agent_forward, key_upload, or password' });
    }

    // Encrypt key material — never store plaintext
    let ssh_key_encrypted = null;
    let ssh_key_fingerprint = null;
    if (auth_method === 'key_upload' && ssh_key) {
      // Encrypt the whole key+passphrase as a JSON bundle
      const bundle = JSON.stringify({ key: ssh_key.trim(), passphrase: key_passphrase || '' });
      ssh_key_encrypted = encrypt(bundle);
      ssh_key_fingerprint = _deriveFingerprint(ssh_key.trim());
    }

    let bastion_key_encrypted = null;
    if (bastion_host && bastion_key) {
      const bundle = JSON.stringify({ key: bastion_key.trim(), passphrase: bastion_passphrase || '' });
      bastion_key_encrypted = encrypt(bundle);
    }

    // For password auth: encrypt the password into ssh_key_encrypted slot
    if (auth_method === 'password' && req.body.password) {
      ssh_key_encrypted = encrypt(JSON.stringify({ password: req.body.password }));
    }

    const profile = await sshProfilesDb.upsertProfile({
      connection_id: connectionId,
      role,
      ssh_host: ssh_host.trim(),
      ssh_port: parseInt(ssh_port, 10) || 22,
      ssh_user: (ssh_user || 'oracle').trim(),
      auth_method,
      ssh_key_encrypted,
      ssh_key_fingerprint,
      bastion_host: bastion_host ? bastion_host.trim() : null,
      bastion_port: parseInt(bastion_port, 10) || 22,
      bastion_user: bastion_user ? bastion_user.trim() : null,
      bastion_key_encrypted,
    });

    res.json({ ok: true, profile });
  } catch (err) {
    console.error('[ssh-profiles] create error:', err.message);
    res.status(500).json({ error: 'Failed to save SSH profile' });
  }
});

// ── PUT /api/connections/:id/ssh-profiles/:role ───────────────────────────────
// Update an existing SSH profile (same field set as POST).
router.put('/connections/:id/ssh-profiles/:role', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  const role = req.params.role;
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const existing = await sshProfilesDb.getProfile(connectionId, role);
    if (!existing) return res.status(404).json({ error: 'SSH profile not found' });

    const {
      ssh_host, ssh_port, ssh_user, auth_method,
      ssh_key, key_passphrase,
      bastion_host, bastion_port, bastion_user, bastion_key, bastion_passphrase,
    } = req.body;

    if (auth_method && !['agent_forward', 'key_upload', 'password'].includes(auth_method)) {
      return res.status(400).json({ error: 'auth_method must be agent_forward, key_upload, or password' });
    }

    let ssh_key_encrypted = null;
    let ssh_key_fingerprint = null;
    const effectiveAuthMethod = auth_method || existing.auth_method;

    if (effectiveAuthMethod === 'key_upload' && ssh_key) {
      const bundle = JSON.stringify({ key: ssh_key.trim(), passphrase: key_passphrase || '' });
      ssh_key_encrypted = encrypt(bundle);
      ssh_key_fingerprint = _deriveFingerprint(ssh_key.trim());
    }
    if (effectiveAuthMethod === 'password' && req.body.password) {
      ssh_key_encrypted = encrypt(JSON.stringify({ password: req.body.password }));
    }

    let bastion_key_encrypted = null;
    if (bastion_key) {
      const bundle = JSON.stringify({ key: bastion_key.trim(), passphrase: bastion_passphrase || '' });
      bastion_key_encrypted = encrypt(bundle);
    }

    const profile = await sshProfilesDb.upsertProfile({
      connection_id: connectionId,
      role,
      ssh_host: ssh_host ? ssh_host.trim() : existing.ssh_host,
      ssh_port: ssh_port ? (parseInt(ssh_port, 10) || 22) : existing.ssh_port,
      ssh_user: ssh_user ? ssh_user.trim() : existing.ssh_user,
      auth_method: effectiveAuthMethod,
      ssh_key_encrypted,
      ssh_key_fingerprint,
      bastion_host: bastion_host !== undefined ? (bastion_host ? bastion_host.trim() : null) : existing.bastion_host,
      bastion_port: bastion_port ? (parseInt(bastion_port, 10) || 22) : existing.bastion_port,
      bastion_user: bastion_user !== undefined ? (bastion_user ? bastion_user.trim() : null) : existing.bastion_user,
      bastion_key_encrypted,
    });

    res.json({ ok: true, profile });
  } catch (err) {
    console.error('[ssh-profiles] update error:', err.message);
    res.status(500).json({ error: 'Failed to update SSH profile' });
  }
});

// ── DELETE /api/connections/:id/ssh-profiles/:role ────────────────────────────
// Remove a profile. Safe to call on non-existent profile.
router.delete('/connections/:id/ssh-profiles/:role', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  const role = req.params.role;
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const deleted = await sshProfilesDb.deleteProfile(connectionId, role);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('[ssh-profiles] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete SSH profile' });
  }
});

// ── POST /api/connections/:id/ssh-test ────────────────────────────────────────
// Test SSH connectivity for a specific role profile.
// Dispatches via agent channel → paramiko.SSHClient.connect() → returns result.
// Decrypted key material is held in memory only, never written to a response body.
// On success: stores known_hosts_pin (SHA256 of remote host key) and stamps last_test_status=pass.
router.post('/connections/:id/ssh-test', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  const role = req.query.role || 'db_host';
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    const conn = await getOwnedConnection(connectionId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'SSH test only supported for agent connections' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.json({ ok: false, state: 'agent_offline', message: 'Agent not connected — check systemctl status tunevault-agent' });
    }

    // Fetch profile with encrypted key material (for agent dispatch)
    const profile = await sshProfilesDb.getProfileWithKeys(connectionId, role);
    if (!profile) {
      return res.status(404).json({ error: `No SSH profile configured for role '${role}'` });
    }

    // Decrypt key material in memory only — never logged, never included in response
    const sshBody = _buildSshTestBody(profile);

    let agentResp;
    try {
      agentResp = await channel.sendToAgent(connectionId, {
        method: 'POST',
        path: '/api/ssh-test',
        body: sshBody,
      }, 20000); // 20s — SSH connect + uname
    } catch (_) {
      await sshProfilesDb.updateTestResult(connectionId, role, 'fail', null);
      return res.json({ ok: false, state: 'timeout', message: 'SSH test timed out after 20s' });
    }

    const body = agentResp?.body || {};
    const passed = body.ok === true;

    // Stamp test result and capture host key pin if provided by agent
    await sshProfilesDb.updateTestResult(
      connectionId, role,
      passed ? 'pass' : 'fail',
      body.host_key_pin || null
    );

    if (!passed) {
      return res.json({
        ok: false,
        state: 'ssh_failed',
        message: body.error || 'SSH connection failed',
        details: body.details || null,
      });
    }

    res.json({
      ok: true,
      hostname: body.hostname || null,
      uname: body.uname || null,
      host_key_pin: body.host_key_pin || null,
      latency_ms: body.latency_ms || null,
    });
  } catch (err) {
    console.error('[ssh-profiles] ssh-test error:', err.message);
    res.status(500).json({ error: 'SSH test failed: ' + err.message });
  }
});

// ── Private helpers ───────────────────────────────────────────────────────────

// Build the body for the agent /api/ssh-test work item.
// Decrypts key material in memory — caller must not log or serialize this object.
function _buildSshTestBody(profile) {
  const body = {
    host: profile.ssh_host,
    port: profile.ssh_port,
    username: profile.ssh_user,
    auth_method: profile.auth_method,
    known_hosts_pin: profile.known_hosts_pin || null,
  };

  if (profile.auth_method === 'key_upload' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      body.key_content = bundle.key;
      body.key_passphrase = bundle.passphrase || null;
    } catch (_) {
      // Key decrypt failed — agent will report auth error
    }
  }

  if (profile.auth_method === 'password' && profile.ssh_key_encrypted) {
    try {
      const bundle = JSON.parse(decrypt(profile.ssh_key_encrypted));
      body.password = bundle.password;
    } catch (_) {}
  }

  if (profile.bastion_host) {
    body.bastion = {
      host: profile.bastion_host,
      port: profile.bastion_port || 22,
      username: profile.bastion_user || body.username,
    };
    if (profile.bastion_key_encrypted) {
      try {
        const bundle = JSON.parse(decrypt(profile.bastion_key_encrypted));
        body.bastion.key_content = bundle.key;
        body.bastion.key_passphrase = bundle.passphrase || null;
      } catch (_) {}
    }
  }

  return body;
}

// Derive a display fingerprint from PEM key content.
// Returns a short SHA256 prefix suitable for UI display (not cryptographic identity).
function _deriveFingerprint(keyPem) {
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(keyPem.trim()).digest('base64');
    return 'SHA256:' + hash.substring(0, 43); // standard OpenSSH fingerprint length
  } catch (_) {
    return null;
  }
}

module.exports = router;
