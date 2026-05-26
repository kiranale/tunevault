/**
 * db/sql-audit-log.js — SQL audit log persistence.
 *
 * Owns: sql_audit_log table reads and writes.
 * Does NOT own: SQL whitelisting logic (routes/sql-execute.js),
 *               Oracle execution (oracle-proxy calls in routes/sql-execute.js).
 *
 * All rows are append-only. No updates or deletes.
 */

'use strict';

const pool = require('./index');

/**
 * Log a SQL execution attempt.
 * Called for every request to POST /api/connections/:id/execute-sql,
 * whether allowed or blocked, succeeded or failed.
 *
 * @param {object} entry
 * @param {number}  entry.user_id
 * @param {string}  entry.user_email
 * @param {number}  entry.connection_id
 * @param {string}  [entry.connection_name]
 * @param {string}  entry.sql_text
 * @param {boolean} entry.allowed
 * @param {string}  [entry.block_reason]     — set when allowed=false
 * @param {boolean} [entry.success]           — set when allowed=true
 * @param {number}  [entry.row_count]         — set on successful SELECT
 * @param {string}  [entry.error_message]     — set on Oracle error
 * @param {number}  [entry.duration_ms]       — execution wall-clock ms
 * @returns {Promise<object>} inserted row
 */
async function logSqlExecution(entry) {
  const {
    user_id,
    user_email,
    connection_id,
    connection_name = null,
    sql_text,
    allowed,
    block_reason = null,
    success = null,
    row_count = null,
    error_message = null,
    duration_ms = null,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO sql_audit_log
       (user_id, user_email, connection_id, connection_name, sql_text,
        allowed, block_reason, success, row_count, error_message, duration_ms, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     RETURNING *`,
    [user_id, user_email, connection_id, connection_name, sql_text,
     allowed, block_reason, success, row_count, error_message, duration_ms]
  );
  return rows[0];
}

/**
 * Retrieve recent SQL audit log entries for admin review.
 * Returns the most recent rows first, capped at 500.
 *
 * @param {object} [filters]
 * @param {number} [filters.user_id]
 * @param {number} [filters.connection_id]
 * @param {boolean} [filters.blocked_only]
 * @param {number} [filters.limit]
 * @returns {Promise<object[]>}
 */
async function getAuditLog({ user_id, connection_id, blocked_only, limit = 100 } = {}) {
  const conditions = [];
  const params = [];

  if (user_id) {
    params.push(user_id);
    conditions.push(`user_id = $${params.length}`);
  }
  if (connection_id) {
    params.push(connection_id);
    conditions.push(`connection_id = $${params.length}`);
  }
  if (blocked_only) {
    conditions.push(`allowed = FALSE`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 500);
  params.push(safeLimit);

  const { rows } = await pool.query(
    `SELECT * FROM sql_audit_log
     ${where}
     ORDER BY executed_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { logSqlExecution, getAuditLog };
