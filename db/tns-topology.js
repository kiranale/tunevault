/**
 * db/tns-topology.js — TNS topology snapshot persistence.
 *
 * Owns: tns_topology_snapshots table CRUD — insert snapshots,
 *       query history, issue/validate share tokens.
 * Does NOT own: executing Oracle queries, classifying services,
 *               HTTP endpoints (routes/tns-topology.js).
 */

'use strict';

const pool   = require('./index');
const crypto = require('crypto');

/**
 * Insert a new TNS topology snapshot for a connection.
 *
 * @param {object} params
 * @param {number} params.connectionId
 * @param {object} params.snapshotData   — full topology payload (JSON)
 * @param {string[]} params.serviceNames — flat list of network_names
 * @param {string[]} params.patchServices — any *_ebs_patch services
 * @param {string|null} params.recommendedSvc
 * @param {number} params.pdbCount
 * @param {string|null} params.instanceName
 * @param {string|null} params.dbVersion
 * @returns {Promise<number>} inserted row id
 */
async function insertSnapshot({
  connectionId,
  snapshotData,
  serviceNames = [],
  patchServices = [],
  recommendedSvc = null,
  pdbCount = 0,
  instanceName = null,
  dbVersion = null,
}) {
  const { rows } = await pool.query(
    `INSERT INTO tns_topology_snapshots
       (connection_id, snapshot_data, service_names, patch_services,
        recommended_svc, pdb_count, instance_name, db_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      connectionId,
      JSON.stringify(snapshotData),
      serviceNames,
      patchServices,
      recommendedSvc,
      pdbCount,
      instanceName,
      dbVersion,
    ]
  );
  return rows[0].id;
}

/**
 * Get the latest N snapshots for a connection (for diff/alert detection).
 *
 * @param {number} connectionId
 * @param {number} [limit=30]
 * @returns {Promise<Array>}
 */
async function getSnapshots(connectionId, limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, snapshot_data, service_names, patch_services,
            recommended_svc, pdb_count, instance_name, db_version, created_at
     FROM tns_topology_snapshots
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return rows;
}

/**
 * Get a single snapshot by id (ownership verified via connection_id + user check in route).
 */
async function getSnapshotById(snapshotId) {
  const { rows } = await pool.query(
    `SELECT id, connection_id, snapshot_data, service_names, patch_services,
            recommended_svc, pdb_count, instance_name, db_version,
            share_token, share_expires_at, created_at
     FROM tns_topology_snapshots
     WHERE id = $1`,
    [snapshotId]
  );
  return rows[0] || null;
}

/**
 * Issue a 7-day share token for a snapshot.
 * Idempotent — returns existing token if still valid.
 *
 * @param {number} snapshotId
 * @returns {Promise<{token: string, expires_at: Date}>}
 */
async function issueShareToken(snapshotId) {
  // Check if existing non-expired token exists
  const existing = await getSnapshotById(snapshotId);
  if (
    existing &&
    existing.share_token &&
    existing.share_expires_at &&
    new Date(existing.share_expires_at) > new Date()
  ) {
    return { token: existing.share_token, expires_at: existing.share_expires_at };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    `UPDATE tns_topology_snapshots
     SET share_token = $1, share_expires_at = $2
     WHERE id = $3`,
    [token, expiresAt, snapshotId]
  );
  return { token, expires_at: expiresAt };
}

/**
 * Resolve a share token to a snapshot (validates expiry).
 *
 * @param {string} token
 * @returns {Promise<object|null>}
 */
async function resolveShareToken(token) {
  const { rows } = await pool.query(
    `SELECT id, connection_id, snapshot_data, service_names, patch_services,
            recommended_svc, pdb_count, instance_name, db_version,
            share_token, share_expires_at, created_at
     FROM tns_topology_snapshots
     WHERE share_token = $1
       AND share_expires_at > NOW()`,
    [token]
  );
  return rows[0] || null;
}

/**
 * Purge snapshots older than 30 days for a connection (or all connections).
 * Called from nightly cron.
 *
 * @param {number|null} connectionId — null purges all
 * @returns {Promise<number>} rows deleted
 */
async function purgeOldSnapshots(connectionId = null) {
  let query;
  let params;
  if (connectionId) {
    query = `DELETE FROM tns_topology_snapshots
             WHERE connection_id = $1 AND created_at < NOW() - INTERVAL '30 days'`;
    params = [connectionId];
  } else {
    query = `DELETE FROM tns_topology_snapshots WHERE created_at < NOW() - INTERVAL '30 days'`;
    params = [];
  }
  const { rowCount } = await pool.query(query, params);
  return rowCount;
}

/**
 * Get connection owner_id for access control checks.
 * Returns null if connection does not exist.
 *
 * @param {number} connectionId
 * @returns {Promise<number|null>}
 */
async function getConnectionOwnerId(connectionId) {
  const { rows } = await pool.query(
    `SELECT user_id FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return rows.length ? rows[0].user_id : null;
}

/**
 * Get full connection row needed for topology analysis.
 *
 * @param {number} connectionId
 * @returns {Promise<object|null>}
 */
async function getConnectionForTopology(connectionId) {
  const { rows } = await pool.query(
    `SELECT id, name, host, port, service_name, username, encrypted_password,
            proxy_url, proxy_api_key_enc, connection_type, connectivity_mode,
            ssh_db_host, ssh_db_user, ssh_db_key_enc, ssh_oracle_home, ssh_oracle_sid,
            user_id
     FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return rows[0] || null;
}

module.exports = {
  insertSnapshot,
  getSnapshots,
  getSnapshotById,
  issueShareToken,
  resolveShareToken,
  purgeOldSnapshots,
  getConnectionOwnerId,
  getConnectionForTopology,
};
