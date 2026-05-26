/**
 * db/listener-preflight.js — Listener pre-flight run persistence.
 *
 * Owns: CRUD for listener_preflight_runs (insert, update, get, list).
 *       Convenience read functions for oracle_connections and ebs_credentials
 *       used by the pre-flight route (avoids raw pool.query in routes/).
 * Does NOT own: SSH execution logic (routes/listener-preflight.js),
 *               connection record mutations (db/agent.js).
 */

'use strict';

const pool = require('./index');

/**
 * Insert a new run record at start-of-run (status=running).
 * Returns the new run id.
 */
async function insertRun({ connectionId, userId, oracleHome, oracleSid, sshHost, triggeredBy = 'manual' }) {
  const result = await pool.query(
    `INSERT INTO listener_preflight_runs
       (connection_id, user_id, overall_status, oracle_home, oracle_sid, ssh_host, triggered_by)
     VALUES ($1, $2, 'running', $3, $4, $5, $6)
     RETURNING id`,
    [connectionId, userId || null, oracleHome || null, oracleSid || null, sshHost || null, triggeredBy]
  );
  return result.rows[0].id;
}

/**
 * Update a run record once all steps have completed.
 */
async function finalizeRun({ runId, overallStatus, steps, stepsPassed, stepsFailed, stepsSkipped, totalDurationMs, errorMessage }) {
  await pool.query(
    `UPDATE listener_preflight_runs SET
       overall_status    = $1,
       steps             = $2,
       steps_passed      = $3,
       steps_failed      = $4,
       steps_skipped     = $5,
       total_duration_ms = $6,
       error_message     = $7,
       finished_at       = NOW()
     WHERE id = $8`,
    [
      overallStatus,
      JSON.stringify(steps),
      stepsPassed,
      stepsFailed,
      stepsSkipped,
      totalDurationMs,
      errorMessage || null,
      runId,
    ]
  );
}

/**
 * Get a single run by id. Returns null if not found.
 */
async function getRun(runId) {
  const result = await pool.query(
    `SELECT r.*,
            oc.name AS connection_name,
            oc.ssh_db_host, oc.ssh_db_user, oc.ssh_oracle_home, oc.ssh_oracle_sid,
            oc.connectivity_mode
     FROM listener_preflight_runs r
     JOIN oracle_connections oc ON oc.id = r.connection_id
     WHERE r.id = $1`,
    [runId]
  );
  return result.rows[0] || null;
}

/**
 * Get the last N runs for a connection (most recent first).
 * Default limit = 10.
 */
async function getRunsForConnection(connectionId, limit = 10) {
  const result = await pool.query(
    `SELECT id, overall_status, steps_passed, steps_failed, steps_skipped,
            total_duration_ms, oracle_sid, ssh_host, triggered_by,
            created_at, finished_at
     FROM listener_preflight_runs
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return result.rows;
}

/**
 * Check if a run belongs to a given connection (ownership guard).
 */
async function runBelongsToConnection(runId, connectionId) {
  const result = await pool.query(
    `SELECT 1 FROM listener_preflight_runs WHERE id = $1 AND connection_id = $2`,
    [runId, connectionId]
  );
  return result.rows.length > 0;
}

/**
 * Load the connection row needed to run a pre-flight (SSH creds + host/port).
 * Returns null if not found.
 */
async function getConnectionForPreflight(connectionId) {
  const result = await pool.query(
    `SELECT id, user_id, name, connectivity_mode,
            host, port, service_name,
            ssh_db_host, ssh_db_user, ssh_db_key_enc,
            ssh_oracle_home, ssh_oracle_sid,
            ebs_login_url, proxy_url
     FROM oracle_connections
     WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Load an encrypted EBS credential by type for a connection.
 * Returns null if not found.
 */
async function getEbsCredential(connectionId, credentialType) {
  const result = await pool.query(
    `SELECT username, encrypted_value, iv, auth_tag
     FROM ebs_credentials
     WHERE connection_id = $1 AND credential_type = $2`,
    [connectionId, credentialType]
  );
  return result.rows[0] || null;
}

module.exports = {
  insertRun, finalizeRun, getRun, getRunsForConnection, runBelongsToConnection,
  getConnectionForPreflight, getEbsCredential,
};
