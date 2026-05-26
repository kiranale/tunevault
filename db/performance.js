/**
 * db/performance.js — PostgreSQL queries for the Performance tab.
 *
 * Owns: sql_fix_cache reads/writes (AI-generated SQL fix recommendations),
 *       oracle_connections lookup for the performance route.
 * Does NOT own: Oracle query execution (routes/performance.js via oracle-client),
 *               auth, Pool construction, other health-check data.
 */

'use strict';

const pool = require('./index');

/**
 * getCachedFix — look up a cached AI fix by (sql_id, plan_hash_value).
 * Returns the cached row if found and not expired, null otherwise.
 *
 * @param {string} sqlId
 * @param {number|string} planHashValue
 * @returns {Promise<{fix_type, fix_sql, rationale}|null>}
 */
async function getCachedFix(sqlId, planHashValue) {
  const result = await pool.query(
    `SELECT fix_type, fix_sql, rationale
     FROM sql_fix_cache
     WHERE sql_id = $1
       AND plan_hash_value = $2
       AND expires_at > now()`,
    [sqlId, String(planHashValue)]
  );
  return result.rows[0] || null;
}

/**
 * upsertFixCache — insert or update a cached AI fix.
 * TTL is 24 hours from the time of insert/update.
 *
 * @param {object} params
 * @param {string}  params.sqlId
 * @param {string}  params.planHashValue
 * @param {string}  params.fixType        'index' | 'hint' | 'rewrite'
 * @param {string}  params.fixSql
 * @param {string}  params.rationale
 * @param {string}  [params.sqlTextPrefix]
 * @returns {Promise<void>}
 */
async function upsertFixCache({ sqlId, planHashValue, fixType, fixSql, rationale, sqlTextPrefix }) {
  await pool.query(
    `INSERT INTO sql_fix_cache (sql_id, plan_hash_value, fix_type, fix_sql, rationale, sql_text_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '24 hours')
     ON CONFLICT (sql_id, plan_hash_value)
     DO UPDATE SET
       fix_type        = EXCLUDED.fix_type,
       fix_sql         = EXCLUDED.fix_sql,
       rationale       = EXCLUDED.rationale,
       sql_text_prefix = EXCLUDED.sql_text_prefix,
       created_at      = now(),
       expires_at      = now() + interval '24 hours'`,
    [sqlId, String(planHashValue), fixType, fixSql, rationale, sqlTextPrefix || null]
  );
}

/**
 * purgeStaleFixes — delete expired cache rows. Called opportunistically on
 * each top-SQL fetch; keeps the table small without a dedicated cron.
 *
 * @returns {Promise<void>}
 */
async function purgeStaleFixes() {
  await pool.query(`DELETE FROM sql_fix_cache WHERE expires_at <= now()`);
}

/**
 * getConnectionForPerf — load an oracle_connection row (ownership-checked).
 * Returns null if not found or not owned by userId.
 *
 * @param {number} connId
 * @param {number} userId
 * @returns {Promise<{id, host, port, service_name, username, encrypted_password, connection_type}|null>}
 */
async function getConnectionForPerf(connId, userId) {
  const result = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connId, userId]
  );
  return result.rows[0] || null;
}

/**
 * getUserForPerf — load a user row by id (used by auth middleware).
 *
 * @param {number} userId
 * @returns {Promise<{id, email}|null>}
 */
async function getUserForPerf(userId) {
  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

module.exports = { getCachedFix, upsertFixCache, purgeStaleFixes, getConnectionForPerf, getUserForPerf };
