/**
 * db/advisor-findings.js — PostgreSQL queries for the Performance Advisor panel.
 *
 * Owns: advisor_findings table CRUD — upsert and read per-connection
 *       Oracle advisor snapshots (ADDM tasks, findings, recommendations,
 *       SQL Tuning Advisor tasks, AI summary).
 * Does NOT own: Oracle query execution (routes/performance-advisor.js),
 *               oracle_connections storage, auth, Pool construction.
 */

'use strict';

const pool = require('./index');

/**
 * upsertAdvisorFindings — replace all advisor data for a connection.
 * One row per connection (UNIQUE on connection_id); fetch overwrites prior result.
 *
 * @param {object} params
 * @param {number}   params.connectionId
 * @param {Array}    params.addmTasks
 * @param {Array}    params.findings
 * @param {Array}    params.recommendations
 * @param {Array}    params.sqlTuningTasks
 * @param {string|null} params.aiSummary
 * @param {boolean}  params.licensed
 * @param {string|null} params.notLicensedReason
 * @param {string|null} params.fetchError
 * @returns {Promise<object>} the upserted row
 */
async function upsertAdvisorFindings({
  connectionId,
  addmTasks,
  findings,
  recommendations,
  sqlTuningTasks,
  aiSummary,
  licensed,
  notLicensedReason,
  fetchError,
}) {
  const result = await pool.query(
    `INSERT INTO advisor_findings
       (connection_id, fetched_at, addm_tasks, findings, recommendations,
        sql_tuning_tasks, ai_summary, licensed, not_licensed_reason, fetch_error)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (connection_id)
     DO UPDATE SET
       fetched_at          = NOW(),
       addm_tasks          = EXCLUDED.addm_tasks,
       findings            = EXCLUDED.findings,
       recommendations     = EXCLUDED.recommendations,
       sql_tuning_tasks    = EXCLUDED.sql_tuning_tasks,
       ai_summary          = EXCLUDED.ai_summary,
       licensed            = EXCLUDED.licensed,
       not_licensed_reason = EXCLUDED.not_licensed_reason,
       fetch_error         = EXCLUDED.fetch_error
     RETURNING *`,
    [
      connectionId,
      JSON.stringify(addmTasks || []),
      JSON.stringify(findings || []),
      JSON.stringify(recommendations || []),
      JSON.stringify(sqlTuningTasks || []),
      aiSummary || null,
      licensed !== false,
      notLicensedReason || null,
      fetchError || null,
    ]
  );
  return result.rows[0];
}

/**
 * getAdvisorFindings — load cached advisor findings for a connection.
 * Returns null if no row exists yet.
 *
 * @param {number} connectionId
 * @returns {Promise<object|null>}
 */
async function getAdvisorFindings(connectionId) {
  const result = await pool.query(
    `SELECT * FROM advisor_findings WHERE connection_id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * getConnectionForAdvisor — load an oracle_connection (ownership-checked).
 * Returns null if not found or not owned by userId.
 *
 * @param {number} connId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getConnectionForAdvisor(connId, userId) {
  const result = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connId, userId]
  );
  return result.rows[0] || null;
}

/**
 * getUserForAdvisor — load a user row by id (used by auth middleware).
 *
 * @param {number} userId
 * @returns {Promise<{id, email}|null>}
 */
async function getUserForAdvisor(userId) {
  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

module.exports = {
  upsertAdvisorFindings,
  getAdvisorFindings,
  getConnectionForAdvisor,
  getUserForAdvisor,
};
