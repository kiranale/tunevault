/**
 * routes/ebs-ssh-checks.js — EBS SSH check catalog API.
 *
 * Owns: /api/ebs-ssh-checks/* endpoints (run checks, catalog, target lookup).
 * Does NOT own: SSH execution (services/ssh-executor.js),
 *               check parsing (services/ebs-ssh-checks.js),
 *               EBS Oracle queries (routes/ebs-deep.js).
 *
 * Routes:
 *   GET  /api/ebs-ssh-checks/catalog          — check catalog metadata
 *   GET  /api/ebs-ssh-checks/target/:connId   — SSH target(s) for a connection
 *   POST /api/ebs-ssh-checks/run              — run checks on a target
 *     Body: { connection_id, target_id }
 */

'use strict';

const express  = require('express');
const pool     = require('../db/index');
const sshDb    = require('../db/ssh-targets');
const checks   = require('../services/ebs-ssh-checks');

const { requireAuth } = require('../middleware/auth');
const router   = express.Router();

// ─── GET /api/ebs-ssh-checks/catalog ─────────────────────────────────────────

router.get('/catalog', requireAuth, (req, res) => {
  res.json({ catalog: checks.getCheckCatalog() });
});

// ─── GET /api/ebs-ssh-checks/target/:connId ──────────────────────────────────
// Returns SSH targets linked to this oracle connection (if any).

router.get('/target/:connId', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.connId, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection_id' });

  // Verify the connection belongs to this user
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [connId, req.user.id]
  );
  if (!connRows.length) return res.status(404).json({ error: 'Connection not found' });

  const targets = await sshDb.listTargets();
  const linked  = targets.filter(t => t.connection_id === connId);

  res.json({ targets: linked });
});

// ─── POST /api/ebs-ssh-checks/run ────────────────────────────────────────────
// Run SSH checks against a specific target.
// Body: { connection_id: number, target_id: number }

router.post('/run', requireAuth, async (req, res) => {
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

  // Load SSH target (must be linked to this oracle connection OR be a utility target)
  const target = await sshDb.getTargetById(parseInt(target_id, 10));
  if (!target) return res.status(404).json({ error: 'SSH target not found' });

  // Target must be associated with this connection or be a utility target
  if (target.connection_id && target.connection_id !== parseInt(connection_id, 10)) {
    return res.status(403).json({ error: 'SSH target is not associated with this connection' });
  }

  try {
    const result = await checks.runSshChecks({
      targetId: target.id,
      role: target.role,
      initiatedBy: req.user.email,
    });
    res.json(result);
  } catch (err) {
    console.error('[ebs-ssh-checks] run error:', err.message);
    res.status(500).json({ error: 'Failed to run SSH checks', detail: err.message });
  }
});

module.exports = router;
