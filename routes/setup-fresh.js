/**
 * routes/setup-fresh.js — /setup/fresh onboarding wizard.
 *
 * Owns: GET /setup/fresh (wizard page), POST /api/setup/connection (create + generate key),
 *       GET /api/setup/install-token/:id (one-time key reveal, 30-min expiry),
 *       GET /api/setup/proxy-status/:id (heartbeat polling for live status),
 *       PATCH /api/setup/connection/:id/hostname (store CF hostname after Phase 2).
 * Does NOT own: connection CRUD (server.js), health check execution (server.js),
 *               tier enforcement (middleware/tier-enforce.js).
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');
const { enforceConnectionCap } = require('../middleware/tier-enforce');

const router = express.Router();

// In-memory one-time token store: tokenHex → { connectionId, userId, expiresAt }
// Tokens are single-use and expire after 30 minutes.
const ONE_TIME_TOKENS = new Map();

// Clean expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of ONE_TIME_TOKENS) {
    if (entry.expiresAt < now) ONE_TIME_TOKENS.delete(token);
  }
}, 5 * 60 * 1000);

// ── GET /setup/fresh ─────────────────────────────────────────────────────────
// 301 permanent redirect to canonical /connections/new (Task #1789425 + #1795782 consolidation).
// All Add Connection links in the app MUST point to /connections/new — the single canonical wizard.
// /setup/fresh is kept here as a permanent redirect only; never link to it directly.
router.get('/setup/fresh', requireAuth, (req, res) => {
  res.redirect(301, '/connections/new');
});

// ── POST /api/setup/connection ──────────────────────────────────────────────
// Phase 1: Create connection + generate fresh API key.
// Returns: { connection: {...}, api_key_masked: "tvp_xxxx...xxxx", token_url: "/api/setup/install-token/ID/TOKEN" }
router.post('/api/setup/connection', requireAuth, enforceConnectionCap, async (req, res) => {
  try {
    const {
      name, host, port, service_name, username, password
    } = req.body;

    if (!service_name || !username || !password) {
      return res.status(400).json({ error: 'service_name, username, and password are required' });
    }
    if (!host) {
      return res.status(400).json({ error: 'host is required' });
    }

    // Generate a fresh proxy API key for this connection
    const rawKey = 'tvp_' + crypto.randomBytes(24).toString('hex');
    const encryptedPassword = encrypt(password);
    const encryptedKey = encrypt(rawKey);

    // Placeholder proxy_url — we'll know the real hostname after Phase 2.
    // Use a sentinel so the connection record is identifiable as setup-in-progress.
    const dbPort = parseInt(port, 10) || 1521;
    const displayName = (name || '').trim() || `${host}/${service_name}`;
    const placeholderProxyUrl = `https://pending.tunevault.setup`;

    const result = await pool.query(
      `INSERT INTO oracle_connections
         (name, host, port, service_name, username, encrypted_password,
          connection_type, proxy_url, proxy_api_key_enc, user_id, proxy_key_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'proxy', $7, $8, $9, NOW())
       RETURNING id, name, host, port, service_name, username, connection_type, proxy_url, created_at`,
      [displayName, host, dbPort, service_name, username, encryptedPassword,
       placeholderProxyUrl, encryptedKey, req.user.id]
    );

    const conn = result.rows[0];

    // Issue a one-time token for Phase 3 install command (30-min TTL)
    const ott = crypto.randomBytes(32).toString('hex');
    ONE_TIME_TOKENS.set(ott, {
      connectionId: conn.id,
      userId: req.user.id,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    // Mask key: show first 8 and last 4 chars
    const masked = rawKey.substring(0, 8) + '...' + rawKey.slice(-4);

    res.json({
      connection: conn,
      api_key_masked: masked,
      token_url: `/api/setup/install-token/${conn.id}/${ott}`,
    });
  } catch (err) {
    console.error('[setup-fresh] create connection error:', err.message);
    res.status(500).json({ error: 'Failed to create connection' });
  }
});

// ── GET /api/setup/install-token/:id/:token ──────────────────────────────────
// One-time token endpoint — returns the full API key for embedding in the install command.
// Tokens are single-use and expire after 30 minutes.
// No auth cookie required (link is embedded directly in the bash command).
router.get('/api/setup/install-token/:id/:token', async (req, res) => {
  const { id, token } = req.params;
  const entry = ONE_TIME_TOKENS.get(token);

  if (!entry) {
    return res.status(410).json({ error: 'Token expired or already used' });
  }
  if (String(entry.connectionId) !== String(id)) {
    return res.status(403).json({ error: 'Token mismatch' });
  }
  if (entry.expiresAt < Date.now()) {
    ONE_TIME_TOKENS.delete(token);
    return res.status(410).json({ error: 'Token expired' });
  }

  // Fetch the encrypted key
  try {
    const result = await pool.query(
      'SELECT proxy_api_key_enc FROM oracle_connections WHERE id = $1',
      [id]
    );
    if (!result.rows.length || !result.rows[0].proxy_api_key_enc) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Single-use: delete token immediately after read
    ONE_TIME_TOKENS.delete(token);

    const apiKey = decrypt(result.rows[0].proxy_api_key_enc);
    res.json({ api_key: apiKey });
  } catch (err) {
    console.error('[setup-fresh] install-token error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve key' });
  }
});

// ── PATCH /api/setup/connection/:id/hostname ─────────────────────────────────
// Phase 2 → Phase 3 bridge: store the Cloudflare public hostname on the connection record.
router.patch('/api/setup/connection/:id/hostname', requireAuth, async (req, res) => {
  const { hostname } = req.body;
  if (!hostname || !/^[a-zA-Z0-9.-]+$/.test(hostname)) {
    return res.status(400).json({ error: 'Invalid hostname' });
  }

  try {
    const result = await pool.query(
      `UPDATE oracle_connections
       SET proxy_url = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, proxy_url`,
      [`https://${hostname}`, req.params.id, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Connection not found or not owned by you' });
    }
    res.json({ ok: true, proxy_url: result.rows[0].proxy_url });
  } catch (err) {
    console.error('[setup-fresh] hostname patch error:', err.message);
    res.status(500).json({ error: 'Failed to update hostname' });
  }
});

// ── GET /api/setup/proxy-status/:id ──────────────────────────────────────────
// Phase 3 polling: returns whether the proxy has checked in recently.
// "Live" = proxy phoned home within the last 5 minutes (proxy_key_last_used_at set by /api/proxy/health).
router.get('/api/setup/proxy-status/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, last_test_success, last_tested_at,
              proxy_key_last_used_at, proxy_url, proxy_version,
              connection_type
       FROM oracle_connections
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    const conn = result.rows[0];
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const heartbeat = conn.proxy_key_last_used_at && new Date(conn.proxy_key_last_used_at) > fiveMinutesAgo;
    const tested = conn.last_test_success === true;

    res.json({
      id: conn.id,
      name: conn.name,
      proxy_url: conn.proxy_url,
      proxy_version: conn.proxy_version,
      last_used_at: conn.proxy_key_last_used_at,
      last_tested_at: conn.last_tested_at,
      last_test_success: conn.last_test_success,
      heartbeat,
      live: heartbeat || tested,
    });
  } catch (err) {
    console.error('[setup-fresh] proxy-status error:', err.message);
    res.status(500).json({ error: 'Failed to check proxy status' });
  }
});

module.exports = router;
