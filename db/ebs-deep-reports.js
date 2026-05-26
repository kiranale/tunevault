/**
 * db/ebs-deep-reports.js — PostgreSQL queries for Deep EBS Health Reports.
 *
 * Owns: CRUD on the ebs_deep_reports table.
 * Does NOT own: Oracle query execution, AI analysis, auth, or Pool construction.
 */

'use strict';

const pool = require('./index');

/**
 * createEbsDeepReport — insert a new Deep EBS report row.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.connectionId
 * @param {string} params.connectionName
 * @param {object} params.findingsJson
 * @param {string|null} params.aiAnalysis
 * @param {boolean} [params.isDemo]
 * @returns {Promise<{id: number}>}
 */
async function createEbsDeepReport({ userId, connectionId, connectionName, findingsJson, aiAnalysis = null, isDemo = false }) {
  const result = await pool.query(
    `INSERT INTO ebs_deep_reports (user_id, connection_id, connection_name, findings_json, ai_analysis, is_demo)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [userId, connectionId, connectionName, JSON.stringify(findingsJson), aiAnalysis, isDemo]
  );
  return result.rows[0];
}

/**
 * getEbsDeepReport — fetch a single Deep EBS report by id.
 * Returns null if not found.
 *
 * @param {number} reportId
 * @param {number|null} userId  Pass null to skip ownership check (admin / demo access).
 * @returns {Promise<object|null>}
 */
async function getEbsDeepReport(reportId, userId = null) {
  let query, params;
  if (userId !== null) {
    query = `SELECT r.*, oc.name AS connection_name_live
             FROM ebs_deep_reports r
             LEFT JOIN oracle_connections oc ON oc.id = r.connection_id
             WHERE r.id = $1 AND (r.user_id = $2 OR r.is_demo = TRUE)`;
    params = [reportId, userId];
  } else {
    query = `SELECT r.*, oc.name AS connection_name_live
             FROM ebs_deep_reports r
             LEFT JOIN oracle_connections oc ON oc.id = r.connection_id
             WHERE r.id = $1`;
    params = [reportId];
  }
  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

/**
 * getDemoEbsDeepReport — find the most recent demo report row.
 * Used to serve /report/ebs/demo without requiring auth.
 *
 * @returns {Promise<object|null>}
 */
async function getDemoEbsDeepReport() {
  const result = await pool.query(
    `SELECT * FROM ebs_deep_reports WHERE is_demo = TRUE ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * updateEbsDeepReportAi — patch ai_analysis on an existing row once the AI call completes.
 *
 * @param {number} reportId
 * @param {string} aiAnalysis
 */
async function updateEbsDeepReportAi(reportId, aiAnalysis) {
  await pool.query(
    `UPDATE ebs_deep_reports SET ai_analysis = $2 WHERE id = $1`,
    [reportId, aiAnalysis]
  );
}

module.exports = { createEbsDeepReport, getEbsDeepReport, getDemoEbsDeepReport, updateEbsDeepReportAi };
