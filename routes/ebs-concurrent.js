/**
 * routes/ebs-concurrent.js — EBS Concurrent Requests view + All-Nodes start/stop.
 *
 * Owns: /ebs-concurrent page, /api/ebs-concurrent/* endpoints (catalog, run op).
 * Does NOT own: credential storage (db/ssh-targets.js), SSH execution (services/ssh-executor.js),
 *               other EBS checks (routes/ebs-deep.js, routes/ebs-middleware.js).
 *
 * Routes:
 *   GET  /ebs-concurrent                        — serve the concurrent ops page
 *   GET  /api/ebs-concurrent/catalog            — ops catalog for this module
 *   POST /api/ebs-concurrent/run                — run an op
 *     Body: { connection_id, op_key, target_id?, confirmed? }
 *
 * SQL ops (ebs.concurrent.running) need Oracle credentials; decrypted here.
 * SSH ops (ebs.allnodes.*) need an apps_tier SSH target.
 * All ops are EBS-only.
 */

'use strict';

const express  = require('express');
const pathM    = require('path');

const pool     = require('../db/index');
const sshDb    = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const executor = require('../services/db-ops-executor');

const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ─── Catalog ─────────────────────────────────────────────────────────────────

const EBS_CONCURRENT_KEYS = new Set([
  'ebs.concurrent.running',
  'ebs.allnodes.start',
  'ebs.allnodes.stop',
]);

function getConcurrentCatalog() {
  return executor.getOpCatalog().filter(op => EBS_CONCURRENT_KEYS.has(op.key));
}

// ─── Helper: load + decrypt oracle connection ─────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type, is_ebs
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
    isEbs: !!conn.is_ebs,
  };
}

// ─── GET /ebs-concurrent ──────────────────────────────────────────────────────

router.get('/ebs-concurrent', requireAuth, (req, res) => {
  res.sendFile(pathM.join(__dirname, '..', 'public', 'ebs-concurrent.html'));
});

// ─── GET /api/ebs-concurrent/catalog ─────────────────────────────────────────

router.get('/api/ebs-concurrent/catalog', requireAuth, (req, res) => {
  res.json({ catalog: getConcurrentCatalog() });
});

// ─── POST /api/ebs-concurrent/run ────────────────────────────────────────────
// Body: { connection_id, op_key, target_id?, confirmed? }

router.post('/api/ebs-concurrent/run', requireAuth, async (req, res) => {
  const { connection_id, op_key, target_id, confirmed } = req.body || {};

  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  if (!EBS_CONCURRENT_KEYS.has(op_key)) {
    return res.status(400).json({ error: 'Unknown or disallowed op_key for EBS concurrent ops' });
  }

  const connParams = await getConnParams(parseInt(connection_id, 10), req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  // All ops here are EBS-only
  if (!connParams.isEbs) {
    return res.status(400).json({ error: 'EBS not detected on this connection' });
  }

  const catalog = getConcurrentCatalog();
  const op = catalog.find(o => o.key === op_key);

  // SSH ops require an apps_tier target
  let resolvedTargetId = null;
  if (op && op.type === 'ssh') {
    if (!target_id) {
      return res.status(400).json({ error: 'SSH target required for this operation' });
    }
    resolvedTargetId = parseInt(target_id, 10);
    const target = await sshDb.getTargetById(resolvedTargetId);
    if (!target) return res.status(404).json({ error: 'SSH target not found' });
    if (target.connection_id && target.connection_id !== parseInt(connection_id, 10)) {
      return res.status(403).json({ error: 'SSH target not associated with this connection' });
    }
  }

  try {
    const result = await executor.runOp({
      opKey: op_key,
      connParams,
      targetId: resolvedTargetId,
      initiatedBy: req.user.email,
      confirmed: !!confirmed,
      params: {},
    });

    if (!result.ok && result.commandPreview) {
      return res.status(428).json({
        requiresConfirmation: true,
        commandPreview: result.commandPreview,
        opKey: op_key,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[ebs-concurrent] run error:', err.message);
    res.status(500).json({ error: 'Operation failed', detail: err.message });
  }
});

module.exports = router;
