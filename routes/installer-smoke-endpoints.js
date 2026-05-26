/**
 * routes/installer-smoke-endpoints.js — Canonical smoke API paths.
 *
 * Owns: POST /api/admin/smoke-token  (issue one-shot install token),
 *       GET  /api/admin/smoke-runs   (last 20 runs for Installer Health card),
 *       POST /api/admin/smoke-runs   (report back a container result).
 * Does NOT own: smoke orchestration (scripts/smoke-test-installer.sh),
 *               agent fleet UI (routes/admin-agents.js).
 *
 * Auth: smoke-token POST + smoke-runs GET require requireAdmin session.
 *       smoke-runs POST authenticated by X-Smoke-Secret header
 *       (SMOKE_REPORT_SECRET env var) — no session needed so GitHub Actions
 *       can POST without a browser cookie.
 *
 * Export: { tokenRouter, runsRouter }
 * Mounted in server.js:
 *   app.use('/api/admin/smoke-token', tokenRouter)
 *   app.use('/api/admin/smoke-runs',  runsRouter)
 */

'use strict';

const express = require('express');
const smoke   = require('../db/installer-smoke');
const { requireAdmin } = require('../middleware/auth');

// ── /api/admin/smoke-token ────────────────────────────────────────────────────

const tokenRouter = express.Router();

// POST /api/admin/smoke-token — issue one-shot 15-min install token
tokenRouter.post('/', requireAdmin, async (req, res) => {
  try {
    const { token, expiresAt } = await smoke.issueToken({
      createdBy: req.user?.email || 'admin',
    });
    res.json({ ok: true, token, expiresAt });
  } catch (err) {
    console.error('[installer-smoke] smoke-token issue failed:', err.message);
    res.status(500).json({ error: 'Failed to issue smoke token' });
  }
});

// ── /api/admin/smoke-runs ─────────────────────────────────────────────────────

const runsRouter = express.Router();

// GET /api/admin/smoke-runs — last 20 runs for Installer Health card
runsRouter.get('/', requireAdmin, async (req, res) => {
  try {
    const runs = await smoke.getRecentRuns(20);
    res.json(runs);
  } catch (err) {
    console.error('[installer-smoke] smoke-runs fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to load smoke runs' });
  }
});

// POST /api/admin/smoke-runs — report back a container smoke result
// Auth: X-Smoke-Secret header matched against SMOKE_REPORT_SECRET env var.
// No session required — called from GitHub Actions / shell scripts.
runsRouter.post('/', async (req, res) => {
  const secret   = process.env.SMOKE_REPORT_SECRET;
  const provided = req.headers['x-smoke-secret'];

  if (secret && provided !== secret) {
    return res.status(403).json({ error: 'Invalid smoke secret' });
  }

  const {
    run_id, os, trigger_source,
    overall, failure_log, results_json,
    agent_version, install_sha, duration_total_ms,
    step_install_ms, step_install_ok, step_install_err,
    step_register_ms, step_register_ok, step_register_err,
    step_heartbeat_ms, step_heartbeat_ok, step_heartbeat_err,
    step_systemd_ms, step_systemd_ok, step_systemd_err,
    step_command_ms, step_command_ok, step_command_err,
  } = req.body || {};

  if (!run_id || !os) {
    return res.status(400).json({ error: 'run_id and os required' });
  }

  const validOs = ['ubuntu22', 'ol8'];
  if (!validOs.includes(os)) {
    return res.status(400).json({ error: `os must be one of: ${validOs.join(', ')}` });
  }

  try {
    const row = await smoke.insertRun({ run_id, os, trigger_source: trigger_source || 'manual' });
    await smoke.updateRun(row.id, {
      finished_at: new Date(),
      overall: overall || 'error',
      failure_log, results_json, agent_version, install_sha, duration_total_ms,
      step_install_ms, step_install_ok, step_install_err,
      step_register_ms, step_register_ok, step_register_err,
      step_heartbeat_ms, step_heartbeat_ok, step_heartbeat_err,
      step_systemd_ms, step_systemd_ok, step_systemd_err,
      step_command_ms, step_command_ok, step_command_err,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[installer-smoke] smoke-runs report failed:', err.message);
    res.status(500).json({ error: 'Failed to record smoke run' });
  }
});

module.exports = { tokenRouter, runsRouter };
