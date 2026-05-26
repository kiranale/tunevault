/**
 * db/fndload.js — FNDLOAD migration audit log queries.
 *
 * Owns: fndload_history table — append-only audit of all FNDLOAD operations.
 * Does NOT own: Oracle proxy execution, AI diff calls, connection lookups.
 */

'use strict';

const pool = require('./index');

/**
 * Append a new FNDLOAD history row.
 * @param {object} row
 * @returns {Promise<object>} inserted row with id
 */
async function logFndloadAction(row) {
  const {
    user_id, user_email, action,
    source_conn_id, source_conn_name,
    target_conn_id, target_conn_name,
    object_type, lct_file, object_names,
    diff_summary, upload_result, pre_state_ldt,
    success, error_message,
  } = row;

  const { rows } = await pool.query(
    `INSERT INTO fndload_history
       (user_id, user_email, action,
        source_conn_id, source_conn_name,
        target_conn_id, target_conn_name,
        object_type, lct_file, object_names,
        diff_summary, upload_result, pre_state_ldt,
        success, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, executed_at`,
    [
      user_id || null, user_email, action,
      source_conn_id || null, source_conn_name || null,
      target_conn_id || null, target_conn_name || null,
      object_type, lct_file, object_names || [],
      diff_summary || null, upload_result ? JSON.stringify(upload_result) : null,
      pre_state_ldt || null,
      success !== undefined ? success : null, error_message || null,
    ],
  );
  return rows[0];
}

/**
 * Fetch recent history for a user, optionally filtered by connection.
 * @param {number} userId
 * @param {object} opts  { limit, source_conn_id, target_conn_id }
 */
async function getHistory(userId, opts = {}) {
  const { limit = 50, source_conn_id, target_conn_id } = opts;
  const params = [userId, limit];
  let where = 'WHERE user_id = $1';
  if (source_conn_id) { params.push(source_conn_id); where += ` AND source_conn_id = $${params.length}`; }
  if (target_conn_id) { params.push(target_conn_id); where += ` AND target_conn_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, action, object_type, lct_file, object_names,
            source_conn_name, target_conn_name,
            diff_summary, upload_result, success, error_message, executed_at
     FROM fndload_history
     ${where}
     ORDER BY executed_at DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

module.exports = { logFndloadAction, getHistory };
