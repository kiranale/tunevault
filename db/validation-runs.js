/**
 * db/validation-runs.js — Persistence for validation_runs table.
 *
 * Owns: CRUD on validation_runs (create, read, update results, share token).
 * Does NOT own: suite orchestration (services/validation-suite.js),
 *               API endpoints (routes/validation-suite.js).
 */

'use strict';

const pool   = require('./index');
const crypto = require('crypto');

/**
 * Create a new validation run in 'running' state.
 * Returns { id, started_at }.
 */
async function createRun(connectionId, userId) {
  const result = await pool.query(
    `INSERT INTO validation_runs (connection_id, user_id, status, full_results_json)
     VALUES ($1, $2, 'running', '[]')
     RETURNING id, started_at`,
    [connectionId, userId || null]
  );
  return result.rows[0];
}

/**
 * Append a single result row to full_results_json.
 * row: { category, name, status, duration_ms, detail }
 */
async function appendResult(runId, row) {
  await pool.query(
    `UPDATE validation_runs
     SET full_results_json = full_results_json || $1::jsonb
     WHERE id = $2`,
    [JSON.stringify([row]), runId]
  );
}

/**
 * Finish a run: set status, finished_at, summary_json.
 */
async function finishRun(runId, status, summaryJson) {
  await pool.query(
    `UPDATE validation_runs
     SET status       = $1,
         finished_at  = NOW(),
         summary_json = $2
     WHERE id = $3`,
    [status, JSON.stringify(summaryJson), runId]
  );
}

/**
 * Fetch a single run by id (for polling + report view).
 */
async function getRun(runId) {
  const result = await pool.query(
    `SELECT vr.id, vr.connection_id, vr.user_id, vr.started_at, vr.finished_at,
            vr.status, vr.share_token, vr.share_expires_at,
            vr.summary_json, vr.full_results_json,
            oc.name AS connection_name
     FROM validation_runs vr
     LEFT JOIN oracle_connections oc ON oc.id = vr.connection_id
     WHERE vr.id = $1`,
    [runId]
  );
  return result.rows[0] || null;
}

/**
 * Fetch run by share_token (public access, no auth required).
 * Returns null if token expired.
 */
async function getRunByToken(token) {
  const result = await pool.query(
    `SELECT vr.id, vr.connection_id, vr.started_at, vr.finished_at,
            vr.status, vr.share_token, vr.share_expires_at,
            vr.summary_json, vr.full_results_json,
            oc.name AS connection_name
     FROM validation_runs vr
     LEFT JOIN oracle_connections oc ON oc.id = vr.connection_id
     WHERE vr.share_token = $1
       AND vr.share_expires_at > NOW()`,
    [token]
  );
  return result.rows[0] || null;
}

/**
 * Get last 10 runs for a connection (history list).
 */
async function getRunHistory(connectionId, limit = 10) {
  const result = await pool.query(
    `SELECT id, started_at, finished_at, status, summary_json
     FROM validation_runs
     WHERE connection_id = $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return result.rows;
}

/**
 * Issue or re-issue a 7-day share token for a finished run.
 * Returns the token string.
 */
async function issueShareToken(runId) {
  // HMAC-based token: run ID + random nonce, keyed by SESSION_SECRET so forgeable only server-side
  const secret = process.env.SESSION_SECRET || 'tunevault-dev-secret';
  const nonce  = crypto.randomBytes(16).toString('hex');
  const token  = crypto.createHmac('sha256', secret)
                       .update(`vrun:${runId}:${nonce}`)
                       .digest('hex') + nonce;

  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    `UPDATE validation_runs
     SET share_token = $1, share_expires_at = $2
     WHERE id = $3`,
    [token, expires.toISOString(), runId]
  );
  return token;
}

/**
 * Check if a run is currently in flight for this connection.
 * Stale 'running' rows older than 30 min are ignored.
 */
async function getActiveRun(connectionId) {
  const result = await pool.query(
    `SELECT id, started_at
     FROM validation_runs
     WHERE connection_id = $1
       AND status = 'running'
       AND started_at > NOW() - INTERVAL '30 minutes'
     ORDER BY started_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  createRun,
  appendResult,
  finishRun,
  getRun,
  getRunByToken,
  getRunHistory,
  issueShareToken,
  getActiveRun,
};
