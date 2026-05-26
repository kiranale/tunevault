/**
 * db/addm-runs.js — PostgreSQL queries for the ADDM run history.
 *
 * Owns: addm_runs table CRUD — inserting new run records, reading history
 *       per-connection, and loading a single run for detail view.
 * Does NOT own: Oracle query execution, auth, Pool construction,
 *               connection credential storage.
 */

'use strict';

const pool = require('./index');

/**
 * insertAddmRun — persist a completed ADDM execution result.
 *
 * @param {object} p
 * @param {number}   p.connectionId
 * @param {number}   p.createdBy       — user id
 * @param {string|null} p.taskName
 * @param {number|null} p.taskId
 * @param {string|null} p.dbId
 * @param {string|null} p.container
 * @param {number|null} p.beginSnapId
 * @param {number|null} p.endSnapId
 * @param {string|null} p.beginSnapTime
 * @param {string|null} p.endSnapTime
 * @param {number|null} p.dbTimeSeconds
 * @param {number|null} p.avgActiveSessions
 * @param {Array}    p.findings
 * @param {string|null} p.rawReportText
 * @param {string|null} p.aiCommentary
 * @param {boolean}  p.isIdle
 * @param {string|null} p.runError
 * @param {number|null} p.snapshotMs
 * @param {number|null} p.analysisMs
 * @param {number|null} p.totalMs
 * @returns {Promise<object>} inserted row
 */
async function insertAddmRun(p) {
  const result = await pool.query(
    `INSERT INTO addm_runs
       (connection_id, created_by, task_name, task_id, db_id, container,
        begin_snap_id, end_snap_id, begin_snap_time, end_snap_time,
        db_time_seconds, avg_active_sessions, findings, raw_report_text,
        ai_commentary, is_idle, run_error, snapshot_ms, analysis_ms, total_ms)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      p.connectionId,
      p.createdBy,
      p.taskName       || null,
      p.taskId         || null,
      p.dbId           || null,
      p.container      || null,
      p.beginSnapId    || null,
      p.endSnapId      || null,
      p.beginSnapTime  || null,
      p.endSnapTime    || null,
      p.dbTimeSeconds  != null ? p.dbTimeSeconds : null,
      p.avgActiveSessions != null ? p.avgActiveSessions : null,
      JSON.stringify(p.findings || []),
      p.rawReportText  || null,
      p.aiCommentary   || null,
      p.isIdle         ? true : false,
      p.runError       || null,
      p.snapshotMs     || null,
      p.analysisMs     || null,
      p.totalMs        || null,
    ]
  );
  return result.rows[0];
}

/**
 * getAddmRuns — most recent N runs for a connection.
 *
 * @param {number} connectionId
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
async function getAddmRuns(connectionId, limit = 20) {
  const result = await pool.query(
    `SELECT id, created_at, task_name, task_id, container,
            begin_snap_id, end_snap_id, begin_snap_time, end_snap_time,
            db_time_seconds, avg_active_sessions, is_idle, run_error,
            total_ms,
            jsonb_array_length(findings) AS finding_count
     FROM addm_runs
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return result.rows;
}

/**
 * getAddmRun — single run by id (ownership-enforced via connection join).
 *
 * @param {number} runId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getAddmRun(runId, userId) {
  const result = await pool.query(
    `SELECT r.*
     FROM addm_runs r
     JOIN oracle_connections c ON c.id = r.connection_id
     WHERE r.id = $1 AND c.user_id = $2`,
    [runId, userId]
  );
  return result.rows[0] || null;
}

/**
 * getConnectionForAddm — load an oracle_connection (ownership-checked).
 *
 * @param {number} connId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getConnectionForAddm(connId, userId) {
  const result = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connId, userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  insertAddmRun,
  getAddmRuns,
  getAddmRun,
  getConnectionForAddm,
};
