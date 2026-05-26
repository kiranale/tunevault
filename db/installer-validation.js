/**
 * db/installer-validation.js — installer_validation_runs persistence.
 *
 * Owns: installer_validation_runs table (read + write).
 * Does NOT own: triggering runs (routes/installer-validation.js),
 *               GitHub Actions workflow (CI layer).
 *
 * Supports two row types:
 *   greenfield  — os='ol7'|'ol8', topology='greenfield-OL7'|'greenfield-OL8'
 *   EBS live    — os='ebs12210',  topology='live-EBS-12.2.10-db-dev',
 *                 checks_passed/checks_total/ssh_runbook_executed populated
 */

'use strict';

const pool = require('./index');

/**
 * Insert a new run row. Returns the created row.
 * @param {object} run
 * @param {string} run.run_id        - UUID for this run batch
 * @param {string} run.os            - 'ol7' | 'ol8' | 'ebs12210'
 * @param {string} run.trigger_source - 'cron' | 'deploy_webhook' | 'manual'
 * @param {string} [run.topology]    - topology label (optional, set on insert for EBS rows)
 */
async function insertRun({ run_id, os, trigger_source = 'cron', topology = null }) {
  const result = await pool.query(
    `INSERT INTO installer_validation_runs (run_id, os, trigger_source, topology)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [run_id, os, trigger_source, topology]
  );
  return result.rows[0];
}

/**
 * Update a run row with probe results and final outcome.
 * @param {number} id - row id
 * @param {object} data - fields to update
 */
async function updateRun(id, data) {
  const allowed = [
    'finished_at', 'install_sha', 'agent_version', 'kernel_version',
    'probe_1_status', 'probe_1_ms', 'probe_1_error',
    'probe_2_status', 'probe_2_ms', 'probe_2_error',
    'probe_3_status', 'probe_3_ms', 'probe_3_error',
    'probe_4_status', 'probe_4_ms', 'probe_4_error',
    'probe_5_status', 'probe_5_ms', 'probe_5_error',
    'probe_6_status', 'probe_6_ms', 'probe_6_error',
    'probe_7_status', 'probe_7_ms', 'probe_7_error',
    'overall', 'duration_total_ms', 'error_message',
    // EBS topology fields
    'topology', 'checks_passed', 'checks_total', 'ssh_runbook_executed',
  ];

  const updates = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (key in data) {
      updates.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (updates.length === 0) return null;

  values.push(id);
  const result = await pool.query(
    `UPDATE installer_validation_runs
     SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values
  );
  return result.rows[0];
}

/**
 * Get the latest run for each OS (OL7 + OL8 greenfield only).
 * Returns { ol7: row|null, ol8: row|null }
 */
async function getLatestRuns() {
  const result = await pool.query(`
    SELECT DISTINCT ON (os) *
    FROM installer_validation_runs
    WHERE overall != 'pending'
      AND os IN ('ol7', 'ol8')
    ORDER BY os, started_at DESC
  `);
  const out = { ol7: null, ol8: null };
  for (const row of result.rows) {
    out[row.os] = row;
  }
  return out;
}

/**
 * Get the latest EBS live-topology validation run.
 * Returns the most recent row with os='ebs12210', or null.
 */
async function getLatestEbsRun() {
  const result = await pool.query(`
    SELECT *
    FROM installer_validation_runs
    WHERE os = 'ebs12210'
      AND overall != 'pending'
    ORDER BY started_at DESC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

/**
 * Get 30-day history for EBS topology runs.
 */
async function getEbsHistory() {
  const result = await pool.query(`
    SELECT id, run_id, started_at, overall, duration_total_ms, install_sha,
           trigger_source, agent_version, checks_passed, checks_total, ssh_runbook_executed
    FROM installer_validation_runs
    WHERE os = 'ebs12210'
      AND overall != 'pending'
      AND started_at > NOW() - INTERVAL '30 days'
    ORDER BY started_at DESC
    LIMIT 120
  `);
  return result.rows;
}

/**
 * Get 30-day history for a given OS (one row per run, newest first).
 * Returns up to 120 runs (4 per day × 30 days).
 */
async function getHistory(os) {
  const result = await pool.query(
    `SELECT id, run_id, started_at, overall, duration_total_ms, install_sha, trigger_source
     FROM installer_validation_runs
     WHERE os = $1
       AND overall != 'pending'
       AND started_at > NOW() - INTERVAL '30 days'
     ORDER BY started_at DESC
     LIMIT 120`,
    [os]
  );
  return result.rows;
}

/**
 * Get a single run by id.
 */
async function getRunById(id) {
  const result = await pool.query(
    `SELECT * FROM installer_validation_runs WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get all pending runs (started_at > 30min ago means stale — mark as error).
 * Used by cleanup job on startup.
 */
async function getStaleRuns() {
  const result = await pool.query(`
    SELECT id FROM installer_validation_runs
    WHERE overall = 'pending'
      AND started_at < NOW() - INTERVAL '30 minutes'
  `);
  return result.rows;
}

/**
 * Mark stale pending runs as error (cleanup on startup).
 */
async function markStaleRunsAsError() {
  await pool.query(`
    UPDATE installer_validation_runs
    SET overall = 'error',
        error_message = 'Run timed out — no result received',
        finished_at = NOW()
    WHERE overall = 'pending'
      AND started_at < NOW() - INTERVAL '30 minutes'
  `);
}

/**
 * Find an existing run row by run_id + os. Returns null if not found.
 */
async function findRunByRunId(run_id, os) {
  const result = await pool.query(
    `SELECT id FROM installer_validation_runs WHERE run_id = $1 AND os = $2 LIMIT 1`,
    [run_id, os]
  );
  return result.rows[0] || null;
}

module.exports = {
  insertRun,
  updateRun,
  getLatestRuns,
  getLatestEbsRun,
  getEbsHistory,
  getHistory,
  getRunById,
  getStaleRuns,
  markStaleRunsAsError,
  findRunByRunId,
};
