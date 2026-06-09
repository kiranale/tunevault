/**
 * db/ebs-deep.js — PostgreSQL queries for Deep EBS Mode page.
 *
 * Owns: queries against oracle_connections, health_checks, and ebs_sanity_runs.
 * Does NOT own: Oracle query execution (that lives in routes/ebs-deep.js via oracle-client),
 *               user auth, or Pool construction.
 */

'use strict';

const pool = require('./index');

/**
 * getEbsConnections — returns all oracle_connections that have an EBS-detected
 * health check run. Used to gate /ebs-deep access and populate the connection list.
 *
 * @param {number} userId
 * @returns {Promise<Array<{id, name, host, connection_type}>>}
 */
async function getEbsConnections(userId) {
  const result = await pool.query(
    `SELECT id, name, host, connection_type
     FROM oracle_connections
     WHERE user_id = $1
       AND (is_ebs = true OR server_type IN ('apps', 'both'))
     ORDER BY name`,
    [userId]
  );
  return result.rows;
}

/**
 * getConnectionById — fetch a single oracle_connection row for decryption
 * by the route handler.
 *
 * @param {number} connId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getConnectionById(connId, userId) {
  const result = await pool.query(
    `SELECT id, name, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connId, userId]
  );
  return result.rows[0] || null;
}

/**
 * insertSanityRun — persist a completed sanity run.
 *
 * @param {object} params
 * @param {number}  params.connectionId
 * @param {string}  params.overallStatus  'pass' | 'warn' | 'fail' | 'unknown'
 * @param {Array}   params.findings       Array of category result objects
 * @param {boolean} params.isDemo
 * @returns {Promise<{id: number, run_at: string}>}
 */
async function insertSanityRun({ connectionId, overallStatus, findings, isDemo = false }) {
  const result = await pool.query(
    `INSERT INTO ebs_sanity_runs (connection_id, overall_status, findings_json, is_demo)
     VALUES ($1, $2, $3, $4)
     RETURNING id, run_at`,
    [connectionId, overallStatus, JSON.stringify(findings), isDemo]
  );
  return result.rows[0];
}

/**
 * getLatestSanityRun — return the most recent sanity run for a connection.
 * Returns null if no runs exist.
 *
 * @param {number} connectionId
 * @param {number} userId  Used to scope to connections owned by this user.
 * @returns {Promise<object|null>}
 */
async function getLatestSanityRun(connectionId, userId) {
  const result = await pool.query(
    `SELECT sr.id, sr.connection_id, sr.run_at, sr.overall_status,
            sr.findings_json, sr.is_demo
     FROM ebs_sanity_runs sr
     JOIN oracle_connections oc ON oc.id = sr.connection_id
     WHERE sr.connection_id = $1 AND oc.user_id = $2
     ORDER BY sr.run_at DESC
     LIMIT 1`,
    [connectionId, userId]
  );
  return result.rows[0] || null;
}

module.exports = { getEbsConnections, getConnectionById, insertSanityRun, getLatestSanityRun };
