/**
 * db/sql-console-history.js — SQL Console query history persistence.
 *
 * Owns: sql_console_history table reads and writes.
 * Does NOT own: SQL execution logic (routes/console.js),
 *               Oracle connections (oracle-client.js).
 *
 * All rows are append-only. Purge handled by housekeeping cron.
 */

'use strict';

const pool = require('./index');

/**
 * Log a SQL console execution.
 * Called after every execute/explain attempt from the SQL Console.
 *
 * @param {object} entry
 * @returns {Promise<object>} inserted row
 */
async function insertHistory(entry) {
  const {
    connection_id,
    user_id,
    sql_text,
    elapsed_ms = null,
    rows_returned = null,
    error_message = null,
    success = true,
    source_ip = null,
    user_agent = null,
    session_id = null,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO sql_console_history
       (connection_id, user_id, sql_text, elapsed_ms, rows_returned,
        error_message, success, source_ip, user_agent, session_id, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [connection_id, user_id, sql_text, elapsed_ms, rows_returned,
     error_message, success, source_ip, user_agent, session_id]
  );
  return rows[0];
}

/**
 * Get recent query history for a user+connection pair.
 *
 * @param {object} opts
 * @param {number} opts.user_id
 * @param {number} opts.connection_id
 * @param {number} [opts.limit=50]
 * @returns {Promise<object[]>}
 */
async function getHistory({ user_id, connection_id, limit = 50 }) {
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
  const { rows } = await pool.query(
    `SELECT id, sql_text, elapsed_ms, rows_returned, success, error_message, executed_at
     FROM sql_console_history
     WHERE user_id = $1 AND connection_id = $2
     ORDER BY executed_at DESC
     LIMIT $3`,
    [user_id, connection_id, safeLimit]
  );
  return rows;
}

/**
 * Get full audit history for admin review. Supports date range filtering.
 *
 * @param {object} opts
 * @param {number} opts.connection_id
 * @param {number} [opts.user_id]
 * @param {string} [opts.from_date] - ISO date string
 * @param {string} [opts.to_date]   - ISO date string
 * @param {number} [opts.limit=500]
 * @returns {Promise<object[]>}
 */
async function getAuditHistory({ connection_id, user_id, from_date, to_date, limit = 500 }) {
  const conditions = ['connection_id = $1'];
  const params = [connection_id];

  if (user_id) {
    params.push(user_id);
    conditions.push(`user_id = $${params.length}`);
  }
  if (from_date) {
    params.push(from_date);
    conditions.push(`executed_at >= $${params.length}::timestamptz`);
  }
  if (to_date) {
    params.push(to_date);
    conditions.push(`executed_at <= $${params.length}::timestamptz`);
  }

  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 500), 2000);
  params.push(safeLimit);

  const { rows } = await pool.query(
    `SELECT h.id, h.user_id, u.email AS user_email, h.sql_text,
            h.elapsed_ms, h.rows_returned, h.success, h.error_message,
            h.source_ip, h.executed_at
     FROM sql_console_history h
     LEFT JOIN users u ON u.id = h.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY h.executed_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Purge entries older than a given number of days.
 * Called by housekeeping cron.
 *
 * @param {number} [retentionDays=90]
 * @returns {Promise<number>} rows deleted
 */
async function purgeOldHistory(retentionDays = 90) {
  const { rowCount } = await pool.query(
    `DELETE FROM sql_console_history
     WHERE executed_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(retentionDays)]
  );
  return rowCount;
}

module.exports = { insertHistory, getHistory, getAuditHistory, purgeOldHistory };
