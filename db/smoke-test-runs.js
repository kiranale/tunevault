/**
 * db/smoke-test-runs.js — Smoke test run persistence for smoke_test_runs table.
 *
 * Owns: CRUD on smoke_test_runs (create, read, update steps/status).
 * Does NOT own: smoke test execution logic (routes/admin-agent-smoke-test.js),
 *               agent channel communication (services/agent-channel.js).
 */

'use strict';

const pool = require('./index');

/**
 * Create a new smoke test run row with status='running'.
 * Returns the new run's id and started_at.
 */
async function createRun(connectionId, triggeredByUserId) {
  const result = await pool.query(
    `INSERT INTO smoke_test_runs (connection_id, triggered_by_user_id, steps_jsonb, overall_status)
     VALUES ($1, $2, '[]', 'running')
     RETURNING id, started_at`,
    [connectionId, triggeredByUserId || null]
  );
  return result.rows[0];
}

/**
 * Append a completed step to steps_jsonb and persist.
 * step: { step, label, status, duration_ms, detail, error_msg }
 */
async function appendStep(runId, step) {
  await pool.query(
    `UPDATE smoke_test_runs
     SET steps_jsonb = steps_jsonb || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify([step]), runId]
  );
}

/**
 * Mark the run finished with overall_status and record finished_at.
 */
async function finishRun(runId, overallStatus) {
  await pool.query(
    `UPDATE smoke_test_runs
     SET overall_status = $1, finished_at = NOW()
     WHERE id = $2`,
    [overallStatus, runId]
  );
}

/**
 * Fetch a run by id (for polling).
 */
async function getRun(runId) {
  const result = await pool.query(
    `SELECT id, connection_id, started_at, finished_at, overall_status,
            steps_jsonb, triggered_by_user_id
     FROM smoke_test_runs
     WHERE id = $1`,
    [runId]
  );
  return result.rows[0] || null;
}

/**
 * Get the most recent run for a connection (for UI display).
 */
async function getLatestRun(connectionId) {
  const result = await pool.query(
    `SELECT id, connection_id, started_at, finished_at, overall_status, steps_jsonb
     FROM smoke_test_runs
     WHERE connection_id = $1
     ORDER BY started_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Count runs today for this connection (for daily soft cap enforcement).
 */
async function countRunsToday(connectionId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM smoke_test_runs
     WHERE connection_id = $1
       AND started_at >= NOW() - INTERVAL '24 hours'`,
    [connectionId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Check if a run is currently in flight (status='running') for this connection.
 */
async function getActiveRun(connectionId) {
  const result = await pool.query(
    `SELECT id, started_at
     FROM smoke_test_runs
     WHERE connection_id = $1
       AND overall_status = 'running'
       AND started_at > NOW() - INTERVAL '5 minutes'
     ORDER BY started_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  createRun,
  appendStep,
  finishRun,
  getRun,
  getLatestRun,
  countRunsToday,
  getActiveRun,
};
