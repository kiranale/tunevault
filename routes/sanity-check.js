/**
 * routes/sanity-check.js — Service Sanity Check API.
 *
 * Owns: /sanity-check page, /api/sanity-check/* endpoints.
 *   POST /api/sanity-check/ebs  — EBS Application Tier post-bounce validation
 *   POST /api/sanity-check/db   — DB Tier post-bounce validation
 *
 * Does NOT own: SSH execution (ssh-executor.js), Oracle connection storage (server.js),
 *               check logic (services/sanity-checker.js).
 *
 * Both checks are read-only — no confirmation modal required.
 * EBS check requires an apps_tier SSH target. DB check requires a Direct TCP connection;
 * SSH (db_tier) target is optional — used only for the listener check.
 */

'use strict';

const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');

const pool       = require('../db/index');
const sshDb      = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const { requireAuth } = require('../middleware/auth');
const { runEbsSanityCheck, runDbSanityCheck } = require('../services/sanity-checker');

const router = express.Router();

// ─── Helper: load + decrypt oracle connection ─────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  if (!rows.length) return null;
  const conn = rows[0];
  return {
    id: conn.id,
    host: conn.host,
    port: conn.port || 1521,
    serviceName: conn.service_name,
    username: conn.username,
    password: decrypt(conn.encrypted_password),
    connectionType: conn.connection_type,
  };
}

// ─── GET /sanity-check ────────────────────────────────────────────────────────

router.get('/sanity-check', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sanity-check.html'));
});

// ─── POST /api/sanity-check/ebs ───────────────────────────────────────────────
// Body: { connection_id, target_id }
// Runs the EBS Application Tier sanity check suite via SSH (apps_tier target).

router.post('/api/sanity-check/ebs', requireAuth, async (req, res) => {
  const { connection_id, target_id } = req.body || {};
  if (!connection_id || !target_id) {
    return res.status(400).json({ error: 'connection_id and target_id required' });
  }

  // Verify oracle connection belongs to this user
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [parseInt(connection_id, 10), req.user.id]
  );
  if (!connRows.length) return res.status(404).json({ error: 'Connection not found' });

  // Verify SSH target
  const target = await sshDb.getTargetById(parseInt(target_id, 10));
  if (!target) return res.status(404).json({ error: 'SSH target not found' });
  if (target.connection_id && target.connection_id !== parseInt(connection_id, 10)) {
    return res.status(403).json({ error: 'SSH target is not associated with this connection' });
  }

  try {
    const result = await runEbsSanityCheck({
      targetId: target.id,
      initiatedBy: req.user.email,
    });
    res.json(result);
  } catch (err) {
    console.error('[sanity-check] EBS run error:', err.message);
    res.status(500).json({ error: 'Sanity check failed', detail: err.message });
  }
});

// ─── POST /api/sanity-check/db ────────────────────────────────────────────────
// Body: { connection_id, target_id? }
// SQL checks: requires Direct TCP connection.
// Listener check: optional db_tier SSH target (skipped if not provided).

router.post('/api/sanity-check/db', requireAuth, async (req, res) => {
  const { connection_id, target_id } = req.body || {};
  if (!connection_id) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const connParams = await getConnParams(parseInt(connection_id, 10), req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  if (connParams.connectionType === 'proxy') {
    return res.status(400).json({
      error: 'DB sanity check requires a Direct TCP connection. Proxy connections cannot run server-side SQL.',
    });
  }

  // Validate SSH target if provided
  let resolvedTargetId = target_id ? parseInt(target_id, 10) : null;
  if (resolvedTargetId) {
    const target = await sshDb.getTargetById(resolvedTargetId);
    if (!target) return res.status(404).json({ error: 'SSH target not found' });
    if (target.connection_id && target.connection_id !== connParams.id) {
      return res.status(403).json({ error: 'SSH target is not associated with this connection' });
    }
  }

  try {
    const result = await runDbSanityCheck({
      connParams,
      targetId: resolvedTargetId,
      initiatedBy: req.user.email,
    });
    res.json(result);
  } catch (err) {
    console.error('[sanity-check] DB run error:', err.message);
    res.status(500).json({ error: 'Sanity check failed', detail: err.message });
  }
});

module.exports = router;
