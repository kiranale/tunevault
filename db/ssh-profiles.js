/**
 * db/ssh-profiles.js — connection_ssh_profiles CRUD.
 * Owns: read/write of SSH connection profiles, key fingerprint extraction.
 * Does NOT own: encryption/decryption (crypto-utils.js), ownership checks (routes layer),
 *               SSH execution (agent-side only), agent-channel dispatch.
 *
 * Key material (ssh_key_encrypted, bastion_key_encrypted) is always encrypted
 * before being handed to this module. This module stores and retrieves the
 * ciphertext only — never the plaintext key.
 */

'use strict';

const pool = require('./index');

// Columns safe to return to API callers. Key ciphertext is excluded.
const PUBLIC_COLUMNS = `
  id, connection_id, role, ssh_host, ssh_port, ssh_user, auth_method,
  ssh_key_fingerprint,
  bastion_host, bastion_port, bastion_user,
  known_hosts_pin,
  created_at, updated_at, last_tested_at, last_test_status
`;

/**
 * Return all SSH profiles for a connection (safe, no key material).
 */
async function getProfilesForConnection(connectionId) {
  const result = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}
       FROM connection_ssh_profiles
      WHERE connection_id = $1
      ORDER BY role`,
    [connectionId]
  );
  return result.rows;
}

/**
 * Return a single profile by connection + role (safe, no key material).
 */
async function getProfile(connectionId, role) {
  const result = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}
       FROM connection_ssh_profiles
      WHERE connection_id = $1 AND role = $2`,
    [connectionId, role]
  );
  return result.rows[0] || null;
}

/**
 * Return a profile including encrypted key material (for agent dispatch only).
 * Do not expose this to API response bodies.
 */
async function getProfileWithKeys(connectionId, role) {
  const result = await pool.query(
    `SELECT *, ssh_key_encrypted, bastion_key_encrypted
       FROM connection_ssh_profiles
      WHERE connection_id = $1 AND role = $2`,
    [connectionId, role]
  );
  return result.rows[0] || null;
}

/**
 * Upsert a profile (create if not exists, update if role already exists).
 * Returns the saved profile (no key material).
 *
 * @param {object} params
 *   connection_id, role, ssh_host, ssh_port, ssh_user, auth_method,
 *   ssh_key_encrypted (optional), ssh_key_fingerprint (optional),
 *   bastion_host (optional), bastion_port (optional), bastion_user (optional),
 *   bastion_key_encrypted (optional)
 */
async function upsertProfile(params) {
  const {
    connection_id, role, ssh_host, ssh_port, ssh_user, auth_method,
    ssh_key_encrypted, ssh_key_fingerprint,
    bastion_host, bastion_port, bastion_user, bastion_key_encrypted,
  } = params;

  const result = await pool.query(
    `INSERT INTO connection_ssh_profiles
       (connection_id, role, ssh_host, ssh_port, ssh_user, auth_method,
        ssh_key_encrypted, ssh_key_fingerprint,
        bastion_host, bastion_port, bastion_user, bastion_key_encrypted,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT (connection_id, role)
     DO UPDATE SET
       ssh_host              = EXCLUDED.ssh_host,
       ssh_port              = EXCLUDED.ssh_port,
       ssh_user              = EXCLUDED.ssh_user,
       auth_method           = EXCLUDED.auth_method,
       ssh_key_encrypted     = COALESCE(EXCLUDED.ssh_key_encrypted, connection_ssh_profiles.ssh_key_encrypted),
       ssh_key_fingerprint   = COALESCE(EXCLUDED.ssh_key_fingerprint, connection_ssh_profiles.ssh_key_fingerprint),
       bastion_host          = EXCLUDED.bastion_host,
       bastion_port          = EXCLUDED.bastion_port,
       bastion_user          = EXCLUDED.bastion_user,
       bastion_key_encrypted = COALESCE(EXCLUDED.bastion_key_encrypted, connection_ssh_profiles.bastion_key_encrypted),
       updated_at            = NOW()
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      connection_id, role, ssh_host, ssh_port || 22, ssh_user || 'oracle', auth_method || 'agent_forward',
      ssh_key_encrypted || null, ssh_key_fingerprint || null,
      bastion_host || null, bastion_port || 22, bastion_user || null, bastion_key_encrypted || null,
    ]
  );
  return result.rows[0];
}

/**
 * Update last_tested_at and last_test_status after a test attempt.
 * Also stores known_hosts_pin if provided (captured on first successful connect).
 */
async function updateTestResult(connectionId, role, status, knownHostsPin) {
  await pool.query(
    `UPDATE connection_ssh_profiles
        SET last_tested_at  = NOW(),
            last_test_status = $3,
            known_hosts_pin  = COALESCE($4, known_hosts_pin),
            updated_at       = NOW()
      WHERE connection_id = $1 AND role = $2`,
    [connectionId, role, status, knownHostsPin || null]
  );
}

/**
 * Delete a profile by connection + role.
 * Returns true if a row was deleted.
 */
async function deleteProfile(connectionId, role) {
  const result = await pool.query(
    `DELETE FROM connection_ssh_profiles
      WHERE connection_id = $1 AND role = $2`,
    [connectionId, role]
  );
  return result.rowCount > 0;
}

module.exports = {
  getProfilesForConnection,
  getProfile,
  getProfileWithKeys,
  upsertProfile,
  updateTestResult,
  deleteProfile,
};
