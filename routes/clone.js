/**
 * routes/clone.js — Unified Clone Wizard hub page and combined history API.
 *
 * Owns: /clone page (type + mode selection portal), /api/clone/history (combined DB+EBS history).
 * Does NOT own: DB clone execution (routes/db-clone.js), EBS clone execution (routes/ebs-clone.js),
 *               SSH execution (services/ssh-executor.js), recipe storage (db/clone-recipes.js).
 *
 * Routes:
 *   GET /clone                    — unified Clone Wizard hub page (requireAuth)
 *   GET /api/clone/history        — combined clone history (DB + EBS), last 100 runs
 *   GET /api/clone/connections    — all connections for current user (type + EBS detection)
 *   GET /api/clone/role           — returns { role, canInitiate } for the current user
 */

'use strict';

const express  = require('express');
const path     = require('path');
const pool     = require('../db/index');
const { requireAuth, requireRole, ROLE_HIERARCHY } = require('../middleware/auth');

const router = express.Router();

// ── Helper: company scope from user ──────────────────────────────────────────

function companyId(user) {
  return user.company_domain || user.email.split('@')[1] || `user_${user.id}`;
}

// ── GET /clone ────────────────────────────────────────────────────────────────

router.get('/clone', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'clone.html'));
});

// ── GET /api/clone/role ───────────────────────────────────────────────────────
// Returns the user's effective role and whether they can initiate clones.
// DBA roles (senior_dba+, admin) can initiate. junior_dba can view only.
// Individual accounts (no team) always get full access.

router.get('/api/clone/role', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.role
       FROM team_members tm
       JOIN users u ON u.team_id = tm.team_id
       WHERE u.id = $1 AND tm.user_id = $1
       LIMIT 1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      // Individual account — full access
      return res.json({ role: 'admin', canInitiate: true, isIndividual: true });
    }

    const role = rows[0].role;
    // senior_dba and above can initiate clones; junior_dba and viewer can only view
    const initiatorRoles = new Set(['senior_dba', 'admin']);
    const canInitiate = initiatorRoles.has(role);

    res.json({ role, canInitiate, isIndividual: false });
  } catch (err) {
    console.error('[clone] role error:', err.message);
    res.status(500).json({ error: 'Failed to check role' });
  }
});

// ── GET /api/clone/connections ────────────────────────────────────────────────
// Returns all saved Oracle connections for this user with EBS detection flag.

router.get('/api/clone/connections', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, display_name, host, port, service_name, connection_type,
              ebs_detected, is_demo
       FROM oracle_connections
       WHERE user_id = $1
       ORDER BY display_name`,
      [req.user.id]
    );
    res.json({ success: true, connections: rows });
  } catch (err) {
    console.error('[clone] connections error:', err.message);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// ── GET /api/clone/history ────────────────────────────────────────────────────
// Returns combined clone history (DB + EBS runs), newest first, last 100.
// Adds clone_type = 'db' | 'ebs' to each row.

router.get('/api/clone/history', requireAuth, async (req, res) => {
  try {
    const cid = companyId(req.user);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

    const { rows } = await pool.query(
      `SELECT
         h.id,
         h.recipe_id,
         h.status,
         h.started_at,
         h.duration_ms,
         h.error_message,
         u.email       AS started_by_email,
         s.display_name AS source_display_name,
         t.display_name AS target_display_name,
         r.recipe_name,
         r.company_id  AS recipe_company_id,
         'unknown'     AS clone_type
       FROM clone_history h
       LEFT JOIN clone_recipes r     ON r.id = h.recipe_id
       LEFT JOIN oracle_connections s ON s.id = h.source_connection_id
       LEFT JOIN oracle_connections t ON t.id = h.target_connection_id
       LEFT JOIN users u             ON u.id  = h.started_by
       WHERE r.company_id = $1
          OR (r.company_id IS NULL AND h.started_by = $2)
       ORDER BY h.started_at DESC
       LIMIT $3`,
      [cid, req.user.id, limit]
    );

    // The recipe's pre_checks_config carries a "mode" field we can use to infer type
    // For now we can't reliably distinguish DB vs EBS from clone_history alone, so
    // we'll include recipe metadata and let the frontend display it.
    res.json({ success: true, history: rows, total: rows.length });
  } catch (err) {
    console.error('[clone] history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch clone history' });
  }
});

module.exports = router;
