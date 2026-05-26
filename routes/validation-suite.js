/**
 * routes/validation-suite.js — One-click full validation suite API + page.
 *
 * Owns: POST /api/connections/:id/validation-suite/run   — kick off async run
 *       GET  /api/connections/:id/validation-suite/runs  — poll run by id (?run_id=)
 *       GET  /api/connections/:id/validation-suite/history — last 10 runs
 *       POST /api/connections/:id/validation-suite/:run_id/share — issue share link
 *       GET  /connections/:id/validation-suite/:run_id   — serve UI page (via '/' mount)
 *       GET  /connections/:id/validation-suite/run       — serve UI page (new run)
 *       GET  /share/validation/:token                    — public share view (no auth)
 *       GET  /api/validation/share/:token                — public share data (no auth)
 *
 * Does NOT own: suite execution logic (services/validation-suite.js),
 *               DB persistence (db/validation-runs.js),
 *               connection CRUD (server.js / db/agent.js).
 *
 * Mount points in server.js:
 *   app.use('/api/connections', require('./routes/validation-suite'));
 *   app.use('/', require('./routes/validation-suite'));
 * The route file guards against double-matching via path-specific prefixes.
 */

'use strict';

const path    = require('path');
const express = require('express');
const router  = express.Router({ mergeParams: true });

const runDb   = require('../db/validation-runs');
const suite   = require('../services/validation-suite');
const pool    = require('../db/index');
const { requireAuth } = require('../middleware/auth');

// ── Helper: verify connection belongs to this user ────────────────────────────

async function ownsConnection(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  return rows.length > 0;
}

// ── POST /:id/validation-suite/run ────────────────────────────────────────────
// Mounted at /api/connections → full path: POST /api/connections/:id/validation-suite/run
// Kicks off an async run. Returns { run_id }.

router.post('/:id/validation-suite/run', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  const userId = req.user.id;
  if (!(await ownsConnection(connId, userId))) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  // Concurrency guard: one run at a time per connection
  const active = await runDb.getActiveRun(connId);
  if (active) {
    return res.status(409).json({
      error:  'A validation run is already in progress for this connection',
      run_id: active.id,
    });
  }

  const run = await runDb.createRun(connId, userId);

  // Fire-and-forget: suite runs async, client polls for progress
  const runHealthCheck = req.app.locals.runHealthCheckForConnection;
  suite.runSuite(run.id, connId, userId, runHealthCheck).catch(err => {
    console.error(`[validation-suite] runSuite error for run #${run.id}:`, err.message);
  });

  res.json({ run_id: run.id });
});

// ── GET /:id/validation-suite/runs?run_id= ───────────────────────────────────
// Mounted at /api/connections → full path: GET /api/connections/:id/validation-suite/runs

router.get('/:id/validation-suite/runs', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const runId  = parseInt(req.query.run_id, 10);
  if (!connId || !runId) return res.status(400).json({ error: 'connection id and run_id required' });

  const userId = req.user.id;
  if (!(await ownsConnection(connId, userId))) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const run = await runDb.getRun(runId);
  if (!run || run.connection_id !== connId) {
    return res.status(404).json({ error: 'Run not found' });
  }

  const durationMs = run.finished_at
    ? new Date(run.finished_at) - new Date(run.started_at)
    : Date.now() - new Date(run.started_at);

  res.json({
    id:              run.id,
    status:          run.status,
    connection_id:   run.connection_id,
    connection_name: run.connection_name,
    started_at:      run.started_at,
    finished_at:     run.finished_at,
    duration_ms:     Math.round(durationMs),
    summary:         run.summary_json,
    results:         run.full_results_json || [],
    share_token:     run.share_token,
    share_expires_at:run.share_expires_at,
  });
});

// ── GET /:id/validation-suite/history ────────────────────────────────────────
// Mounted at /api/connections

router.get('/:id/validation-suite/history', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  const userId = req.user.id;
  if (!(await ownsConnection(connId, userId))) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const runs = await runDb.getRunHistory(connId);
  res.json(runs);
});

// ── POST /:id/validation-suite/:run_id/share ─────────────────────────────────
// Mounted at /api/connections → POST /api/connections/:id/validation-suite/:run_id/share

router.post('/:id/validation-suite/:run_id/share', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const runId  = parseInt(req.params.run_id, 10);
  if (!connId || !runId) return res.status(400).json({ error: 'Invalid ids' });

  const userId = req.user.id;
  if (!(await ownsConnection(connId, userId))) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const run = await runDb.getRun(runId);
  if (!run || run.connection_id !== connId) {
    return res.status(404).json({ error: 'Run not found' });
  }
  if (run.status === 'running') {
    return res.status(400).json({ error: 'Run still in progress — share after completion' });
  }

  const token    = await runDb.issueShareToken(runId);
  const baseUrl  = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const shareUrl = `${baseUrl}/share/validation/${token}`;

  res.json({ share_url: shareUrl, token, expires_in_days: 7 });
});

// ── GET /connections/:id/validation-suite/:run_id — serve page ───────────────
// Mounted at '/' — handles both /connections/:id/validation-suite/:run_id
// and /connections/:id/validation-suite/run (new run trigger)

router.get('/connections/:id/validation-suite/:run_id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'validation-suite.html'));
});

// ── GET /share/validation/:token — public share page ─────────────────────────

router.get('/share/validation/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'validation-suite.html'));
});

// ── GET /api/validation/share/:token — public share data ─────────────────────

router.get('/api/validation/share/:token', async (req, res) => {
  try {
    const run = await runDb.getRunByToken(req.params.token);
    if (!run) return res.status(404).json({ error: 'Share link not found or expired' });

    const durationMs = run.finished_at
      ? new Date(run.finished_at) - new Date(run.started_at)
      : null;

    res.json({
      id:              run.id,
      status:          run.status,
      connection_name: run.connection_name,
      started_at:      run.started_at,
      finished_at:     run.finished_at,
      duration_ms:     durationMs ? Math.round(durationMs) : null,
      summary:         run.summary_json,
      results:         run.full_results_json || [],
      is_shared:       true,
    });
  } catch (err) {
    console.error('[validation-suite] share data error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
