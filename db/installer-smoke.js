/**
 * db/installer-smoke.js — installer_smoke_runs + installer_smoke_tokens persistence.
 *
 * Owns: installer_smoke_runs (read/write), installer_smoke_tokens (read/write).
 * Does NOT own: triggering smoke tests, Docker orchestration, HTTP polling
 *               (those live in scripts/smoke-test-installer.sh and routes/admin-agents.js).
 */

'use strict';

const pool = require('./index');
const crypto = require('crypto');

// ── Tokens ────────────────────────────────────────────────────────────────────

/**
 * Issue a one-shot 15-min smoke install token.
 * Returns { token, expiresAt }.
 */
async function issueToken({ createdBy = null } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO installer_smoke_tokens (token, created_by)
     VALUES ($1, $2)
     RETURNING token, expires_at`,
    [token, createdBy]
  );
  return { token: rows[0].token, expiresAt: rows[0].expires_at };
}

/**
 * Validate + redeem a smoke token. Returns the token row or null on invalid/expired.
 * Marks used_at = NOW() and records run_id so each token is truly one-shot.
 */
async function redeemToken(token, runId) {
  const { rows } = await pool.query(
    `UPDATE installer_smoke_tokens
     SET used_at = NOW(), run_id = $2
     WHERE token = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [token, runId]
  );
  return rows[0] || null;
}

/**
 * Delete expired/used tokens older than 2h (called by purge cron or startup).
 */
async function purgeStaleTokens() {
  await pool.query(`
    DELETE FROM installer_smoke_tokens
    WHERE expires_at < NOW() - INTERVAL '2 hours'
  `);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

/**
 * Insert a pending smoke run row. Returns the created row.
 * @param {object} p
 * @param {string} p.run_id  - UUID shared across all OS containers in one orchestrator run
 * @param {string} p.os      - 'ubuntu22' | 'ol8'
 * @param {string} [p.trigger_source] - 'manual' | 'github_actions' | 'post_deploy'
 */
async function insertRun({ run_id, os, trigger_source = 'manual' }) {
  const { rows } = await pool.query(
    `INSERT INTO installer_smoke_runs (run_id, os, trigger_source)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [run_id, os, trigger_source]
  );
  return rows[0];
}

/**
 * Update a run row with step results and overall outcome.
 * @param {number} id
 * @param {object} data - any subset of run columns
 */
async function updateRun(id, data) {
  const allowed = [
    'finished_at', 'overall',
    'step_install_ms', 'step_install_ok', 'step_install_err',
    'step_register_ms', 'step_register_ok', 'step_register_err',
    'step_heartbeat_ms', 'step_heartbeat_ok', 'step_heartbeat_err',
    'step_systemd_ms', 'step_systemd_ok', 'step_systemd_err',
    'step_command_ms', 'step_command_ok', 'step_command_err',
    'failure_log', 'results_json', 'agent_version', 'install_sha',
    'duration_total_ms',
  ];

  const updates = [];
  const values  = [];
  let   idx     = 1;

  for (const key of allowed) {
    if (key in data) {
      updates.push(`${key} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (updates.length === 0) return null;

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE installer_smoke_runs
     SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Get the last N smoke runs, newest first. Used by the Installer Health card.
 * @param {number} [limit=20]
 */
async function getRecentRuns(limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, run_id, os, trigger_source, started_at, finished_at,
            overall, duration_total_ms,
            step_install_ok, step_register_ok, step_heartbeat_ok,
            step_systemd_ok, step_command_ok,
            step_install_err, step_register_err, step_heartbeat_err,
            step_systemd_err, step_command_err,
            agent_version, install_sha
     FROM installer_smoke_runs
     WHERE overall != 'pending'
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Find a pending run by id (used by the report-back endpoint).
 */
async function getRunById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM installer_smoke_runs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Mark stale pending runs (started > 15 min ago) as error. Called at startup.
 */
async function markStaleRunsAsError() {
  await pool.query(`
    UPDATE installer_smoke_runs
    SET overall = 'error',
        step_install_err = 'Run timed out — no result received',
        finished_at = NOW()
    WHERE overall = 'pending'
      AND started_at < NOW() - INTERVAL '15 minutes'
  `);
}

module.exports = {
  issueToken,
  redeemToken,
  purgeStaleTokens,
  insertRun,
  updateRun,
  getRecentRuns,
  getRunById,
  markStaleRunsAsError,
};
