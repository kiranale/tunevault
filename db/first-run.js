/**
 * db/first-run.js — First-run health pack queries.
 *
 * Owns: queries for the first-run wow-moment feature:
 *       connection data for triggering, HC status polling,
 *       finding retrieval + ranking, AI summary caching,
 *       first_run_completed_at lifecycle management.
 * Does NOT own: health check execution (server.js via app.locals),
 *               AI inference (lib/polsia-ai.js),
 *               finding weights (config/finding_weights.json).
 */

'use strict';

const pool = require('./index');
const path = require('path');
const fs   = require('fs');

// Load finding weights once at startup (file-based, no redeploy needed).
let _weights = null;
function getWeights() {
  if (!_weights) {
    try {
      const weightsPath = path.join(__dirname, '..', 'config', 'finding_weights.json');
      _weights = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
    } catch (err) {
      console.error('[first-run] Could not load finding_weights.json:', err.message);
      _weights = { severity_score: {}, blast_radius: {}, time_to_fix_inverse: {} };
    }
  }
  return _weights;
}

// ── Connection data ───────────────────────────────────────────────────────────

/**
 * Fetch all columns needed to trigger a health check + check first_run state.
 * Returns null if not found or not owned by userId.
 */
async function getConnectionForFirstRun(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc, user_id,
            first_run_completed_at, server_type, apps_pwd_enc, weblogic_pwd_enc
     FROM oracle_connections
     WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
    [connectionId, userId]
  );
  return rows[0] || null;
}

/**
 * Mark the first-run health pack as triggered. Idempotent via WHERE clause.
 * Returns true if the row was actually updated (i.e. we won the race).
 */
async function markFirstRunTriggered(connectionId) {
  const { rowCount } = await pool.query(
    `UPDATE oracle_connections
     SET first_run_completed_at = NOW()
     WHERE id = $1 AND first_run_completed_at IS NULL`,
    [connectionId]
  );
  return rowCount > 0;
}

// ── Health check status ───────────────────────────────────────────────────────

/**
 * Count prior completed health check runs for this connection.
 * Used to gate auto-trigger (only fires when count = 0 before the first pack).
 */
async function countPriorRuns(connectionId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM health_checks
     WHERE connection_id = $1 AND is_demo = false AND status = 'completed'`,
    [connectionId]
  );
  return rows[0].cnt;
}

/**
 * Fetch the most recent health check run for a connection.
 * Returns { id, status, overall_score, created_at, completed_at } or null.
 */
async function getLatestHealthRun(connectionId) {
  const { rows } = await pool.query(
    `SELECT id, status, overall_score, created_at, completed_at
     FROM health_checks
     WHERE connection_id = $1 AND is_demo = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return rows[0] || null;
}

// ── Findings retrieval + ranking ──────────────────────────────────────────────

/**
 * Score a single check_results row using data-driven weights.
 * Formula: severity_score × blast_radius × time_to_fix_inverse
 * Higher = more urgent. Easy to tune by editing finding_weights.json.
 */
function scoreRow(row) {
  const w = getWeights();
  const sev   = (w.severity_score[row.status]                     ?? w.severity_score['info']  ?? 1);
  const blast = (w.blast_radius[row.check_id]                     ?? w.blast_radius['default']  ?? 1);
  const ttfi  = (w.time_to_fix_inverse[row.check_id]              ?? w.time_to_fix_inverse['default'] ?? 1);
  return sev * blast * ttfi;
}

/**
 * Return the top N ranked findings from a completed health check run.
 * Only returns non-green findings (status red/amber/warning/critical/info).
 * Each row is augmented with `score` and `ai_summary` (may be null, caller generates it).
 */
async function getTopFindings(healthCheckId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, check_id, check_category, status,
            metric_name, metric_value, metric_unit,
            raw_payload, ai_summary, recommendation
     FROM check_results
     WHERE run_id = $1
       AND status NOT IN ('green','ok')
       AND check_category != 'error'
     ORDER BY
       CASE status
         WHEN 'red'      THEN 1
         WHEN 'critical' THEN 1
         WHEN 'amber'    THEN 2
         WHEN 'warning'  THEN 2
         WHEN 'info'     THEN 3
         ELSE 4
       END,
       check_id`,
    [healthCheckId]
  );

  // Apply data-driven weights and sort descending
  const scored = rows
    .map(r => ({ ...r, _score: scoreRow(r), raw_payload: r.raw_payload || {} }))
    .sort((a, b) => b._score - a._score);

  return scored.slice(0, limit);
}

/**
 * Persist an AI-generated summary back to the check_results row.
 * Fire-and-forget safe — caller should not await if non-blocking preferred.
 */
async function cacheAiSummary(checkResultId, aiSummary) {
  await pool.query(
    `UPDATE check_results SET ai_summary = $1 WHERE id = $2 AND ai_summary IS NULL`,
    [aiSummary, checkResultId]
  );
}

/**
 * Mark a check_results row as operator-resolved.
 * Ownership enforced via connection_id join.
 */
async function resolveCheckResult(checkResultId, connectionId) {
  await pool.query(
    `UPDATE check_results
     SET status = 'ok',
         ai_summary = COALESCE(ai_summary, 'Marked resolved by operator.')
     WHERE id = $1
       AND run_id IN (
         SELECT id FROM health_checks WHERE connection_id = $2 AND is_demo = false
       )`,
    [checkResultId, connectionId]
  );
}

/**
 * Snooze a check_results row for 24 hours (writes snoozed_until to raw_payload JSONB).
 * Returns the snoozed_until ISO timestamp.
 */
async function snoozeCheckResult(checkResultId, connectionId) {
  const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `UPDATE check_results
     SET raw_payload = raw_payload || jsonb_build_object('snoozed_until', $1::text)
     WHERE id = $2
       AND run_id IN (
         SELECT id FROM health_checks WHERE connection_id = $3 AND is_demo = false
       )`,
    [snoozedUntil, checkResultId, connectionId]
  );
  return snoozedUntil;
}

module.exports = {
  getConnectionForFirstRun,
  markFirstRunTriggered,
  countPriorRuns,
  getLatestHealthRun,
  getTopFindings,
  cacheAiSummary,
  resolveCheckResult,
  snoozeCheckResult,
};
