/**
 * routes/first-run.js — First-run wow-moment: auto-trigger + Top 5 Tonight panel.
 *
 * Owns: GET  /connections/:id/first-run              — progress + findings page
 *       POST /api/connections/:id/first-run/trigger  — idempotent: kick off HC pack (fire-and-forget)
 *       GET  /api/connections/:id/first-run/status   — poll HC job status + top findings
 *       POST /api/connections/:id/first-run/resolve  — mark finding resolved
 *       POST /api/connections/:id/first-run/snooze   — snooze finding 24h
 * Does NOT own: health check execution (app.locals.runHealthCheckForConnection),
 *               finding weights (config/finding_weights.json loaded by db/first-run.js),
 *               AI inference (lib/polsia-ai.js),
 *               connection CRUD (routes/ssh-install.js, db/agent.js).
 */

'use strict';

const path    = require('path');
const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const firstRunDb = require('../db/first-run');
const { chat }   = require('../lib/polsia-ai');

// ── GET /connections/:id/first-run ───────────────────────────────────────────
// Serves the first-run page (progress bar + Top 5 Tonight panel).

router.get('/connections/:id/first-run', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'connections-first-run.html'));
});

// ── POST /api/connections/:id/first-run/trigger ───────────────────────────────
// Idempotent: fires the full health pack exactly once per connection.
// Uses app.locals.runHealthCheckForConnection injected by server.js.
// Returns { triggered: true, health_check_id } or { triggered: false, reason }.

router.post('/api/connections/:id/first-run/trigger', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await firstRunDb.getConnectionForFirstRun(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    // Idempotency guard: only trigger once per connection
    if (conn.first_run_completed_at) {
      // Already triggered — find the latest HC and return it
      const latestRun = await firstRunDb.getLatestHealthRun(connId);
      return res.json({
        triggered: false,
        reason:    'already_triggered',
        health_check_id: latestRun ? latestRun.id : null,
      });
    }

    // Race guard: mark first_run_completed_at NOW so concurrent requests lose the race.
    // If another request already won, return the existing run.
    const won = await firstRunDb.markFirstRunTriggered(connId);
    if (!won) {
      const latestRun = await firstRunDb.getLatestHealthRun(connId);
      return res.json({
        triggered: false,
        reason:    'already_triggered',
        health_check_id: latestRun ? latestRun.id : null,
      });
    }

    // Delegate execution to the shared trigger injected by server.js
    const trigger = req.app.locals.runHealthCheckForConnection;
    if (typeof trigger !== 'function') {
      console.error('[first-run] app.locals.runHealthCheckForConnection not set');
      return res.status(503).json({ error: 'Health check runner not available' });
    }

    // Fire-and-forget: do NOT await — this takes 30–120s
    trigger(conn).catch(err => {
      console.error(`[first-run] trigger error for conn ${connId}:`, err.message);
    });

    res.json({ triggered: true });
  } catch (err) {
    console.error('[first-run] trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/connections/:id/first-run/status ─────────────────────────────────
// Polls the latest HC run status. When completed, returns the ranked Top 5 findings
// with AI summaries (generated on demand, cached on the check_results row).

router.get('/api/connections/:id/first-run/status', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await firstRunDb.getConnectionForFirstRun(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const latestRun = await firstRunDb.getLatestHealthRun(connId);

    if (!latestRun) {
      return res.json({ phase: 'pending', message: 'Health pack not yet started' });
    }

    const { id: runId, status, overall_score: overallScore } = latestRun;

    // Still running: return progress phase
    if (status !== 'completed' && status !== 'error') {
      const phaseLabel = {
        connecting: 'Connecting to Oracle…',
        collecting: 'Running 54+ health checks…',
        analyzing:  'AI is ranking findings…',
      }[status] || 'Running…';
      return res.json({ phase: status, message: phaseLabel, health_check_id: runId });
    }

    if (status === 'error') {
      return res.json({ phase: 'error', message: 'Health pack encountered an error', health_check_id: runId });
    }

    // Completed: retrieve + score findings
    const findings = await firstRunDb.getTopFindings(runId, 5);

    // Generate AI summaries for any findings that don't have one cached yet
    const enriched = await Promise.all(findings.map(async (f) => {
      let summary = f.ai_summary;

      if (!summary) {
        summary = await _generateFindingSummary(f).catch(() => null);
        if (summary) {
          // Cache for next render — fire-and-forget
          firstRunDb.cacheAiSummary(f.id, summary).catch(() => {});
        }
      }

      return {
        id:           f.id,
        check_id:     f.check_id,
        check_category: f.check_category,
        status:       f.status,
        metric_name:  f.metric_name,
        metric_value: f.metric_value,
        metric_unit:  f.metric_unit,
        raw_payload:  f.raw_payload,
        ai_summary:   summary,
        recommendation: f.recommendation,
        score:        f._score,
      };
    }));

    const isClean = findings.length === 0;

    res.json({
      phase:           'completed',
      health_check_id: runId,
      overall_score:   overallScore,
      is_clean:        isClean,
      findings:        enriched,
    });
  } catch (err) {
    console.error('[first-run] status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/first-run/resolve ───────────────────────────────
// Mark a finding (check_results row) as resolved (sets status = 'ok').

router.post('/api/connections/:id/first-run/resolve', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const { finding_id } = req.body;
  if (!connId || !finding_id) return res.status(400).json({ error: 'connection id and finding_id required' });

  try {
    // Verify ownership through connection
    const conn = await firstRunDb.getConnectionForFirstRun(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    await firstRunDb.resolveCheckResult(parseInt(finding_id, 10), connId);
    res.json({ success: true });
  } catch (err) {
    console.error('[first-run] resolve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/first-run/snooze ────────────────────────────────
// Snooze a finding for 24h by tagging the raw_payload with a snooze timestamp.

router.post('/api/connections/:id/first-run/snooze', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const { finding_id } = req.body;
  if (!connId || !finding_id) return res.status(400).json({ error: 'connection id and finding_id required' });

  try {
    const conn = await firstRunDb.getConnectionForFirstRun(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const snoozedUntil = await firstRunDb.snoozeCheckResult(parseInt(finding_id, 10), connId);
    res.json({ success: true, snoozed_until: snoozedUntil });
  } catch (err) {
    console.error('[first-run] snooze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a 2-sentence AI explanation for why a finding matters tonight.
 * Returns null on error so callers can gracefully degrade.
 */
async function _generateFindingSummary(finding) {
  const metricLine = _buildMetricLine(finding);
  const prompt = [
    `You are a senior Oracle DBA. A customer's production database just showed this finding:`,
    `Check: ${finding.check_id} (${finding.check_category})`,
    `Severity: ${finding.status}`,
    `Metric: ${metricLine}`,
    finding.recommendation ? `Known fix: ${finding.recommendation}` : '',
    ``,
    `In exactly 2 sentences, explain why this matters TONIGHT for a production Oracle database.`,
    `Be concrete and urgent. No hedging. No "it may" or "could potentially."`,
    `First sentence: what is actually happening right now.`,
    `Second sentence: what bad thing happens if left unfixed for 24 hours.`,
  ].filter(Boolean).join('\n');

  const text = await chat(prompt, {
    system:    'You are a terse, direct Oracle DBA. Respond in exactly 2 sentences.',
    maxTokens: 120,
  });

  // Sanity: strip anything over 2 sentences to keep UI cards compact
  return text.trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
}

/**
 * Build a human-readable metric line from a check_results row.
 * Mirrors the logic in services/schedule-runner.js but without DB access.
 */
function _buildMetricLine(row) {
  const p = row.raw_payload || {};
  if (row.metric_value !== null && row.metric_value !== undefined) {
    const val = parseFloat(row.metric_value);
    const unit = row.metric_unit || '';
    if (!isNaN(val)) {
      return `${row.metric_name || row.check_id}: ${val}${unit ? ' ' + unit : ''}`;
    }
  }
  if (p.pct_used !== undefined) return `${p.name || row.check_id}: ${p.pct_used}% used`;
  if (p.free_gb !== undefined)  return `${p.name || row.check_id}: ${p.free_gb} GB free`;
  return row.metric_name || row.check_id;
}

module.exports = router;
