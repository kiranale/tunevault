/**
 * routes/fleet.js — Fleet overview dashboard API + HTML page.
 *
 * Owns: GET /fleet — serves fleet.html page (auth-required, redirects to /login).
 *       GET /api/fleet/overview — aggregated status across all user connections.
 * Does NOT own: connection CRUD, health check execution, finding_history mutations.
 *
 * Mounted at / (for GET /fleet page) and /api/fleet (for API endpoints).
 */

'use strict';

const express = require('express');
const path    = require('path');
const pool    = require('../db/index');
const fleetDb = require('../db/fleet');

const { requireAuth, ADMIN_EMAILS } = require('../middleware/auth');
const router = express.Router();

// ── GET /fleet ────────────────────────────────────────────────────────────────

router.get('/fleet', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'fleet.html'));
});

// ── GET /api/fleet/overview ───────────────────────────────────────────────────
//
// Returns fleet status for all connections belonging to the current user.
// Admin sees all connections (userId = null → no user_id filter).

router.get('/overview', requireAuth, async (req, res) => {
  const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
  try {
    const userId = isAdmin ? null : req.user.id;
    const connections = await fleetDb.getFleetOverview(userId);

    // Append demo connection if user has a demo health check
    try {
      const demoHcResult = await pool.query(
        `SELECT hc.id, hc.overall_score, hc.completed_at, hc.metrics
         FROM health_checks hc
         WHERE hc.user_id = $1 AND hc.is_demo = true AND hc.status = 'completed'
         ORDER BY hc.completed_at DESC LIMIT 1`,
        [req.user.id]
      );
      if (demoHcResult.rows.length > 0) {
        const dh = demoHcResult.rows[0];
        const dm = dh.metrics || {};
        connections.push({
          connection_id: null,
          name: 'PRODDB01 (Demo)',
          db_version: (dm.instance && dm.instance.version) || '19.21.0.0.0',
          ebs_detected: true,
          last_check_at: dh.completed_at,
          status: 'amber',
          red_count: 2,
          amber_count: 4,
          top_finding_title: 'APP_DATA Tablespace at 95.2% — critical',
          top_finding_severity: 'critical',
          drift_since_last_run: { new: 0, resolved: 0, worsened: 0 },
          autonomous_enabled: false,
          next_run_at: null,
          overall_score: dh.overall_score || 61,
          is_demo: true,
          demo_report_id: dh.id,
        });
      }
    } catch (e) {
      // demo row is best-effort — don't fail the whole request
    }

    res.json({ connections });
  } catch (err) {
    console.error('[fleet] overview error:', err.message);
    res.status(500).json({ error: 'Failed to load fleet overview' });
  }
});

module.exports = router;
