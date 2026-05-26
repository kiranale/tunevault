/**
 * db/api-keys.js — API key CRUD for REST API v1.
 * Owns: api_keys table reads and writes.
 * Does NOT own: key generation (routes), authentication middleware (middleware/api-auth.js).
 */

const pool = require('./index');
const crypto = require('crypto');

/**
 * Hash a raw API key for storage.
 * @param {string} rawKey
 * @returns {string} SHA-256 hex digest
 */
function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Create a new API key for a user.
 * Returns the full raw key (only time it's ever visible) plus the DB record.
 */
async function createApiKey(userId, name = null) {
  // Generate: tv_api_ + 32 random hex bytes
  const rawKey = 'tv_api_' + crypto.randomBytes(32).toString('hex');
  const prefix = rawKey.substring(0, 16);
  const hash = hashKey(rawKey);

  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, key_prefix, key_hash, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, key_prefix, name, created_at`,
    [userId, prefix, hash, name]
  );
  return { ...rows[0], raw_key: rawKey };
}

/**
 * Look up a user by raw API key. Returns user row or null.
 * Also updates last_used_at on hit.
 */
async function getUserByApiKey(rawKey) {
  const hash = hashKey(rawKey);
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.company_domain, u.team_id,
            ak.id AS api_key_id, ak.key_prefix, ak.user_id AS key_owner_id
     FROM api_keys ak
     JOIN users u ON u.id = ak.user_id
     WHERE ak.key_hash = $1
       AND ak.revoked_at IS NULL`,
    [hash]
  );
  if (!rows[0]) return null;

  // Update last_used_at in background (non-blocking)
  pool.query(
    `UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1`,
    [hash]
  ).catch(() => {});

  return rows[0];
}

/**
 * List all active (non-revoked) API keys for a user.
 * Never returns key_hash.
 */
async function listApiKeys(userId) {
  const { rows } = await pool.query(
    `SELECT id, key_prefix, name, last_used_at, created_at
     FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Revoke an API key (soft delete). Verifies ownership.
 */
async function revokeApiKey(keyId, userId) {
  const { rows } = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [keyId, userId]
  );
  return rows[0] || null;
}

/**
 * Revoke all active keys for a user (regenerate flow).
 */
async function revokeAllApiKeys(userId) {
  await pool.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

module.exports = {
  createApiKey,
  getUserByApiKey,
  listApiKeys,
  revokeApiKey,
  revokeAllApiKeys,
};
