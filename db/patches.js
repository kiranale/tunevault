/**
 * db/patches.js — PostgreSQL queries for the Patch Advisor tab.
 *
 * Owns: oracle_connections lookup for patch advisor (credentials, connection type).
 * Does NOT own: Oracle patch query execution (routes/patches.js via oracle-client),
 *               auth, Pool construction, health check data, or other tabs' queries.
 */

'use strict';

const pool = require('./index');

/**
 * getConnectionForPatches — load a connection row for a given user + connection ID.
 * Returns null when no matching row exists (wrong owner or missing row).
 *
 * @param {number} userId
 * @param {number|string} connectionId
 * @returns {Promise<object|null>}
 */
async function getConnectionForPatches(userId, connectionId) {
  const result = await pool.query(
    `SELECT id, name, host, port, service_name, username,
            encrypted_password, connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  return result.rows[0] || null;
}

/**
 * getUserForPatches — minimal user row needed for auth.
 *
 * @param {number} userId
 * @returns {Promise<{id, email}|null>}
 */
async function getUserForPatches(userId) {
  const result = await pool.query(
    `SELECT id, email FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = { getConnectionForPatches, getUserForPatches };
