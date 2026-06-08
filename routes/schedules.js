/**
 * routes/schedules.js — Autonomous monitoring schedule management.
 *
 * Owns: CRUD for connection_schedules (cadence, alert_email, severity_threshold),
 *       snooze endpoint (token-based, no auth required), and admin overview table.
 * Does NOT own: health check execution, delta logic (services/schedule-runner.js),
 *               finding_history persistence (db/schedules.js).
 *
 * Mounted at:
 *   /api/schedules        — authenticated user endpoints
 *   /api/schedules/snooze — public snooze link (signed token)
 *   /admin/schedules      — admin-only overview page + API
 */

'use strict';

const express = require('express');
const path    = require('path');
const pool    = require('../db/index');
const schedulesDb = require('../db/schedules');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Validate cadence ──────────────────────────────────────────────────────────

const ALLOWED_CADENCES = new Set([15, 30, 60, 120, 240, 480, 1440]); // 15m, 30m, 1h, 2h, 4h, 8h, 24h

// ── User endpoints ────────────────────────────────────────────────────────────

// GET /api/schedules/connection/:id — get schedule for a connection
router.get('/connection/:id', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Ownership check
    const { rows: connRows } = await pool.query(
      'SELECT id, user_id, name FROM oracle_connections WHERE id = $1',
      [connId]
    );
    if (!connRows[0]) return res.status(404).json({ error: 'Connection not found' });
    if (connRows[0].user_id && connRows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const schedule = await schedulesDb.getSchedule(connId);
    res.json({ schedule: schedule || null, connection_name: connRows[0].name });
  } catch (err) {
    console.error('[schedules] GET error:', err.message);
    res.status(500).json({ error: 'Failed to load schedule' });
  }
});

// PUT /api/schedules/connection/:id — upsert schedule config
// Body: { cadence_minutes, enabled, alert_email, severity_threshold }
router.put('/connection/:id', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  const { cadence_minutes, enabled, alert_email, severity_threshold } = req.body || {};

  // Validation
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  if (!ALLOWED_CADENCES.has(Number(cadence_minutes))) {
    return res.status(400).json({ error: 'cadence_minutes must be one of: 60, 240, 720, 1440' });
  }
  if (!alert_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alert_email)) {
    return res.status(400).json({ error: 'alert_email must be a valid email address' });
  }
  const threshold = severity_threshold || 'amber';
  if (!['amber', 'red', 'info'].includes(threshold)) {
    return res.status(400).json({ error: 'severity_threshold must be red, amber, or info' });
  }

  try {
    // Ownership check
    const { rows: connRows } = await pool.query(
      'SELECT id, user_id, name FROM oracle_connections WHERE id = $1',
      [connId]
    );
    if (!connRows[0]) return res.status(404).json({ error: 'Connection not found' });
    if (connRows[0].user_id && connRows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const schedule = await schedulesDb.upsertSchedule({
      connectionId      : connId,
      userId            : req.user.id,
      cadenceMinutes    : Number(cadence_minutes),
      enabled,
      alertEmail        : alert_email.trim().toLowerCase(),
      severityThreshold : threshold,
    });

    res.json({ schedule });
  } catch (err) {
    console.error('[schedules] PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save schedule' });
  }
});

// POST /api/schedules/connection/:id/snooze — snooze alerts for N hours (UI-triggered, auth required)
router.post('/connection/:id/snooze', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });
  const hours = Math.min(Math.max(parseInt((req.body || {}).hours, 10) || 1, 1), 168);

  try {
    const { rows: connRows } = await pool.query(
      'SELECT id, user_id FROM oracle_connections WHERE id = $1',
      [connId]
    );
    if (!connRows[0]) return res.status(404).json({ error: 'Connection not found' });
    if (connRows[0].user_id && connRows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { rows } = await pool.query(
      `UPDATE connection_schedules
       SET snoozed_until = NOW() + ($1 * INTERVAL '1 hour'), updated_at = NOW()
       WHERE connection_id = $2
       RETURNING snoozed_until`,
      [hours, connId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No schedule configured for this connection' });
    console.log(`[schedules] conn ${connId} snoozed ${hours}h by user ${req.user.id}`);
    res.json({ snoozed_until: rows[0].snoozed_until });
  } catch (err) {
    console.error('[schedules] snooze error:', err.message);
    res.status(500).json({ error: 'Failed to snooze alerts' });
  }
});

// ── Snooze endpoint (no auth — token-authenticated via signed scheduleId) ─────

// GET /api/schedules/snooze?t=<token>
// Snoozes the schedule identified by the token for 24 hours.
router.get('/snooze', async (req, res) => {
  const { t, h } = req.query;
  if (!t) {
    return res.status(400).send(simplePage('Invalid Link', 'Missing snooze token.'));
  }

  const hours = Math.min(parseInt(h, 10) || 24, 168); // max 1 week
  const result = await schedulesDb.snoozeByToken(t, hours);

  if (!result.ok) {
    return res.status(400).send(simplePage('Invalid Link', 'This snooze link is invalid or has already been used.'));
  }

  return res.send(simplePage(
    'Monitoring Snoozed',
    `Autonomous monitoring alerts for this connection have been paused for ${hours} hours. You can re-enable them from your dashboard.`
  ));
});

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GET /api/schedules/admin/all — all schedules with connection + user info
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const schedules = await schedulesDb.getAllSchedulesAdmin();
    res.json({ schedules });
  } catch (err) {
    console.error('[schedules] admin/all error:', err.message);
    res.status(500).json({ error: 'Failed to load schedules' });
  }
});

// GET /admin/schedules — admin HTML page
router.get('/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-schedules.html'));
});

// /admin/schedules/page — legacy redirect kept for backward compat
router.get('/page', requireAdmin, (req, res) => {
  res.redirect('/admin/schedules');
});

// ── Simple HTML page helper ───────────────────────────────────────────────────

function simplePage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} — TuneVault</title>
<style>
  body { margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e8e8ed; }
  .wrap { display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px; }
  .card { background:#111114;border:1px solid rgba(240,168,48,.18);border-radius:12px;padding:48px 40px;max-width:480px;text-align:center; }
  .logo { font-size:22px;font-weight:700;color:#f0a830;letter-spacing:-.5px;margin-bottom:24px; }
  h1 { font-size:20px;font-weight:700;color:#e8e8ed;margin:0 0 12px; }
  p { font-size:14px;color:#8888a0;line-height:1.7;margin:0 0 24px; }
  a { color:#f0a830;text-decoration:none;font-size:13px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="logo">TuneVault</div>
      <h1>${escHtml(title)}</h1>
      <p>${escHtml(message)}</p>
      <a href="/dashboard">← Back to dashboard</a>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = router;
