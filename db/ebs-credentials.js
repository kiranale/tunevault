/**
 * db/ebs-credentials.js
 * Owns: ebs_credentials table CRUD + credential_access_log writes.
 * Does NOT own: encryption/decryption (see crypto-utils.js), route auth (see middleware/auth.js).
 *
 * SECURITY CONTRACT:
 *   - upsertCredential() accepts pre-encrypted fields — never stores plaintext.
 *   - getDecryptedValue() is the ONLY function that returns the encrypted blob;
 *     callers must decrypt in-memory, never log the result, never return it over API.
 *   - logAccess() must be called by every caller of getDecryptedValue().
 */

'use strict';

const pool = require('./index');

// ssh_private_key: stores the SSH private key for the oracle/applmgr OS user
// alongside DB/EBS credentials — same vault, same AES-256-GCM threat model.
const VALID_TYPES = ['apps', 'system', 'sys', 'weblogic_admin', 'sysadmin_user', 'xml_gateway', 'ssh_private_key'];

/**
 * Upsert an encrypted credential row.
 * @param {number} connectionId — oracle_connections.id (INTEGER, not UUID)
 * @param {string} credentialType — one of VALID_TYPES
 * @param {string} username
 * @param {string} encryptedValue — hex ciphertext
 * @param {string} iv — hex
 * @param {string} authTag — hex
 * @returns {Promise<object>} the upserted row (metadata only, no plaintext)
 */
async function upsertCredential(connectionId, credentialType, username, encryptedValue, iv, authTag) {
  if (!VALID_TYPES.includes(credentialType)) {
    throw new Error(`Invalid credential_type: ${credentialType}`);
  }

  const result = await pool.query(
    `INSERT INTO ebs_credentials
       (connection_id, credential_type, username, encrypted_value, iv, auth_tag, rotated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (connection_id, credential_type)
     DO UPDATE SET
       username = EXCLUDED.username,
       encrypted_value = EXCLUDED.encrypted_value,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       rotated_at = NOW()
     RETURNING id, connection_id, credential_type, username, rotated_at, created_at`,
    [connectionId, credentialType, username, encryptedValue, iv, authTag]
  );

  return result.rows[0];
}

/**
 * List credential metadata for a connection — never includes plaintext.
 * @param {string} connectionId
 * @returns {Promise<Array>} [{credential_type, username, rotated_at, created_at}]
 */
async function listCredentials(connectionId) {
  const result = await pool.query(
    `SELECT credential_type, username, rotated_at, created_at
     FROM ebs_credentials
     WHERE connection_id = $1
     ORDER BY credential_type`,
    [connectionId]
  );
  return result.rows;
}

/**
 * Fetch the encrypted blob for a single credential — for in-memory decryption only.
 * Caller MUST call logAccess() immediately after.
 * @param {string} connectionId
 * @param {string} credentialType
 * @returns {Promise<object|null>} {encrypted_value, iv, auth_tag} or null if not set
 */
async function getDecryptedValue(connectionId, credentialType) {
  const result = await pool.query(
    `SELECT encrypted_value, iv, auth_tag
     FROM ebs_credentials
     WHERE connection_id = $1 AND credential_type = $2`,
    [connectionId, credentialType]
  );
  return result.rows[0] || null;
}

/**
 * Delete a credential (revoke).
 * @param {string} connectionId
 * @param {string} credentialType
 * @returns {Promise<boolean>} true if a row was deleted
 */
async function deleteCredential(connectionId, credentialType) {
  const result = await pool.query(
    `DELETE FROM ebs_credentials
     WHERE connection_id = $1 AND credential_type = $2`,
    [connectionId, credentialType]
  );
  return result.rowCount > 0;
}

/**
 * Append an audit log entry for every decryption event.
 * @param {string} connectionId
 * @param {string} credentialType
 * @param {string} action — e.g. 'adop_run', 'wls_bounce', 'cm_bounce'
 * @param {number|null} userId
 */
async function logAccess(connectionId, credentialType, action, userId) {
  await pool.query(
    `INSERT INTO credential_access_log
       (connection_id, credential_type, action, user_id)
     VALUES ($1, $2, $3, $4)`,
    [connectionId, credentialType, action, userId || null]
  );
}

/**
 * Get recent access log entries for a connection (admin audit view).
 * @param {string} connectionId
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function getAccessLog(connectionId, limit = 50) {
  const result = await pool.query(
    `SELECT credential_type, action, user_id, accessed_at
     FROM credential_access_log
     WHERE connection_id = $1
     ORDER BY accessed_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return result.rows;
}

module.exports = {
  upsertCredential,
  listCredentials,
  getDecryptedValue,
  deleteCredential,
  logAccess,
  getAccessLog,
  VALID_TYPES,
};
