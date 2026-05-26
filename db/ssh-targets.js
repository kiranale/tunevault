/**
 * db/ssh-targets.js — Database access for SSH credential vault + audit log.
 *
 * Owns: ssh_targets CRUD (admin-scope and user-scope), ssh_audit writes + reads,
 *       oracle_connections proxy lookup for SSH routing (getConnectionProxyById).
 * Does NOT own: SSH execution, encryption/decryption, auth.
 *
 * Scoping convention:
 *   - Admin functions operate on ALL targets (user_id = NULL or any user_id).
 *   - User functions operate on targets WHERE user_id = $userId only.
 *   - Admin-created targets (user_id = NULL) are never visible to regular users.
 */

'use strict';

const pool = require('./index');

// ─── ssh_targets ─────────────────────────────────────────────────────────────

/**
 * List all SSH targets (no secrets — encrypted values are NOT returned).
 * @returns {Promise<Array>}
 */
async function listTargets() {
  const { rows } = await pool.query(`
    SELECT id, label, host, port, os_user, auth_method, role,
           connection_id, last_connected_at, created_at, updated_at
    FROM ssh_targets
    ORDER BY label
  `);
  return rows;
}

/**
 * Return a single target by ID, including encrypted credential fields.
 * Only the executor and key-rotation code should call this.
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function getTargetById(id) {
  const { rows } = await pool.query(`
    SELECT id, label, host, port, os_user, auth_method, role,
           encrypted_private_key, encrypted_passphrase,
           user_id, connection_id, last_connected_at, created_at, updated_at
    FROM ssh_targets
    WHERE id = $1
  `, [id]);
  return rows[0] || null;
}

/**
 * Insert a new SSH target.
 * @param {Object} p
 * @param {string} p.label
 * @param {string} p.host
 * @param {number} p.port
 * @param {string} p.os_user
 * @param {string} p.auth_method  'key' | 'password'
 * @param {string|null} p.encrypted_private_key  Pre-encrypted by caller
 * @param {string|null} p.encrypted_passphrase   Pre-encrypted by caller
 * @param {string} p.role  'apps_tier' | 'db_tier' | 'utility'
 * @param {number|null} p.connection_id
 * @returns {Promise<Object>}
 */
async function createTarget({ label, host, port, os_user, auth_method, encrypted_private_key, encrypted_passphrase, role, connection_id }) {
  const { rows } = await pool.query(`
    INSERT INTO ssh_targets
      (label, host, port, os_user, auth_method, encrypted_private_key,
       encrypted_passphrase, role, connection_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [label, host, port || 22, os_user, auth_method, encrypted_private_key || null,
      encrypted_passphrase || null, role || 'db_tier', connection_id || null]);
  return rows[0];
}

/**
 * Update metadata fields only (host, label, port, os_user, role, connection_id).
 * Credential updates go through updateTargetCredentials().
 * @param {number} id
 * @param {Object} p
 * @returns {Promise<Object|null>}
 */
async function updateTargetMeta(id, { label, host, port, os_user, role, connection_id }) {
  const { rows } = await pool.query(`
    UPDATE ssh_targets
    SET label = COALESCE($2, label),
        host  = COALESCE($3, host),
        port  = COALESCE($4, port),
        os_user = COALESCE($5, os_user),
        role  = COALESCE($6, role),
        connection_id = $7,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [id, label, host, port, os_user, role, connection_id || null]);
  return rows[0] || null;
}

/**
 * Update credential fields (call only when re-uploading a key or changing password).
 * @param {number} id
 * @param {Object} p
 * @param {string} p.auth_method
 * @param {string|null} p.encrypted_private_key
 * @param {string|null} p.encrypted_passphrase
 * @returns {Promise<Object|null>}
 */
async function updateTargetCredentials(id, { auth_method, encrypted_private_key, encrypted_passphrase }) {
  const { rows } = await pool.query(`
    UPDATE ssh_targets
    SET auth_method = $2,
        encrypted_private_key = $3,
        encrypted_passphrase  = $4,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [id, auth_method, encrypted_private_key || null, encrypted_passphrase || null]);
  return rows[0] || null;
}

/**
 * Delete an SSH target (cascades to ssh_audit rows).
 * @param {number} id
 * @returns {Promise<boolean>}
 */
async function deleteTarget(id) {
  const { rowCount } = await pool.query('DELETE FROM ssh_targets WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Stamp last_connected_at to now (called after a successful test-connection).
 * @param {number} id
 * @returns {Promise<void>}
 */
async function markConnected(id) {
  await pool.query(
    'UPDATE ssh_targets SET last_connected_at = NOW(), updated_at = NOW() WHERE id = $1',
    [id]
  );
}

// ─── User-scoped ssh_targets ──────────────────────────────────────────────────

/**
 * List SSH targets owned by a specific user (no secrets returned).
 * @param {number} userId
 * @returns {Promise<Array>}
 */
async function listTargetsByUser(userId) {
  const { rows } = await pool.query(`
    SELECT id, label, host, port, os_user, auth_method, role,
           connection_id, last_connected_at, created_at, updated_at
    FROM ssh_targets
    WHERE user_id = $1
    ORDER BY label
  `, [userId]);
  return rows;
}

/**
 * Verify that a target belongs to a specific user.
 * Returns the target row (no secrets) or null if not found / not owned.
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<Object|null>}
 */
async function getTargetByIdForUser(id, userId) {
  const { rows } = await pool.query(`
    SELECT id, label, host, port, os_user, auth_method, role,
           connection_id, last_connected_at, created_at, updated_at
    FROM ssh_targets
    WHERE id = $1 AND user_id = $2
  `, [id, userId]);
  return rows[0] || null;
}

/**
 * Return a single target with encrypted credentials, only if owned by userId.
 * Only the executor should call this after verifying user ownership.
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<Object|null>}
 */
async function getTargetByIdForUserWithCreds(id, userId) {
  const { rows } = await pool.query(`
    SELECT id, label, host, port, os_user, auth_method, role,
           encrypted_private_key, encrypted_passphrase,
           connection_id, last_connected_at, created_at, updated_at
    FROM ssh_targets
    WHERE id = $1 AND user_id = $2
  `, [id, userId]);
  return rows[0] || null;
}

/**
 * Insert a new SSH target owned by userId.
 * @param {Object} p  Same fields as createTarget() plus user_id
 * @returns {Promise<Object>}
 */
async function createTargetForUser({ user_id, label, host, port, os_user, auth_method, encrypted_private_key, encrypted_passphrase, role, connection_id }) {
  const { rows } = await pool.query(`
    INSERT INTO ssh_targets
      (user_id, label, host, port, os_user, auth_method, encrypted_private_key,
       encrypted_passphrase, role, connection_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [user_id, label, host, port || 22, os_user, auth_method,
      encrypted_private_key || null, encrypted_passphrase || null,
      role || 'db_tier', connection_id || null]);
  return rows[0];
}

/**
 * Update metadata for a user-owned target.
 * @param {number} id
 * @param {number} userId
 * @param {Object} p
 * @returns {Promise<Object|null>}
 */
async function updateTargetMetaForUser(id, userId, { label, host, port, os_user, role, connection_id }) {
  const { rows } = await pool.query(`
    UPDATE ssh_targets
    SET label = COALESCE($3, label),
        host  = COALESCE($4, host),
        port  = COALESCE($5, port),
        os_user = COALESCE($6, os_user),
        role  = COALESCE($7, role),
        connection_id = $8,
        updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [id, userId, label, host, port, os_user, role, connection_id || null]);
  return rows[0] || null;
}

/**
 * Update credentials for a user-owned target.
 * @param {number} id
 * @param {number} userId
 * @param {Object} p
 * @returns {Promise<Object|null>}
 */
async function updateTargetCredentialsForUser(id, userId, { auth_method, encrypted_private_key, encrypted_passphrase }) {
  const { rows } = await pool.query(`
    UPDATE ssh_targets
    SET auth_method = $3,
        encrypted_private_key = $4,
        encrypted_passphrase  = $5,
        updated_at = NOW()
    WHERE id = $1 AND user_id = $2
    RETURNING id, label, host, port, os_user, auth_method, role,
              connection_id, last_connected_at, created_at, updated_at
  `, [id, userId, auth_method, encrypted_private_key || null, encrypted_passphrase || null]);
  return rows[0] || null;
}

/**
 * Delete a user-owned target (cascades to ssh_audit rows).
 * @param {number} id
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function deleteTargetForUser(id, userId) {
  const { rowCount } = await pool.query(
    'DELETE FROM ssh_targets WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rowCount > 0;
}

/**
 * Return proxy_url + proxy_api_key_enc for an oracle_connection by ID.
 * Used by ssh-executor to route SSH commands through the proxy when connection_id is set.
 * Returns null if the connection doesn't exist or has no proxy configured.
 * @param {number} connectionId
 * @returns {Promise<{proxy_url: string, proxy_api_key_enc: string}|null>}
 */
async function getConnectionProxyById(connectionId) {
  const { rows } = await pool.query(`
    SELECT proxy_url, proxy_api_key_enc
    FROM oracle_connections
    WHERE id = $1
      AND connection_type = 'proxy'
      AND proxy_url IS NOT NULL
      AND proxy_api_key_enc IS NOT NULL
  `, [connectionId]);
  return rows[0] || null;
}

/**
 * Fetch oracle_connections owned by userId for the connection dropdown.
 * Returns id + connection_name + connection_type (safe for display — no credentials).
 * connection_type is included so the UI can show "via proxy" badge on linked targets.
 * @param {number} userId
 * @returns {Promise<Array>}
 */
async function getConnectionsForUser(userId) {
  const { rows } = await pool.query(`
    SELECT id, connection_name, connection_type
    FROM oracle_connections
    WHERE user_id = $1
    ORDER BY connection_name
  `, [userId]);
  return rows;
}

// ─── ssh_audit ────────────────────────────────────────────────────────────────

/**
 * Write an SSH audit row.
 * @param {Object} p
 * @param {number}  p.target_id
 * @param {string}  p.command_key
 * @param {string}  p.rendered_command
 * @param {number|null}  p.exit_code
 * @param {number|null}  p.stdout_bytes
 * @param {number|null}  p.stderr_bytes
 * @param {number|null}  p.duration_ms
 * @param {boolean} p.was_rejected
 * @param {string|null}  p.rejection_reason
 * @param {string|null}  p.initiated_by
 * @returns {Promise<void>}
 */
async function writeAudit({ target_id, command_key, rendered_command, exit_code, stdout_bytes, stderr_bytes, duration_ms, was_rejected, rejection_reason, initiated_by }) {
  await pool.query(`
    INSERT INTO ssh_audit
      (target_id, command_key, rendered_command, exit_code, stdout_bytes,
       stderr_bytes, duration_ms, was_rejected, rejection_reason, initiated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [target_id, command_key, rendered_command, exit_code ?? null,
      stdout_bytes ?? null, stderr_bytes ?? null, duration_ms ?? null,
      was_rejected, rejection_reason || null, initiated_by || null]);
}

/**
 * Return audit rows for the admin UI.
 * @param {Object} opts
 * @param {number|null} opts.target_id  Filter by target (null = all)
 * @param {number}      opts.limit
 * @param {number}      opts.offset
 * @returns {Promise<{rows: Array, total: number}>}
 */
async function listAudit({ target_id = null, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (target_id) {
    params.push(target_id);
    conditions.push(`a.target_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit, offset);
  const { rows } = await pool.query(`
    SELECT a.id, a.target_id, t.label AS target_label, t.host,
           a.command_key, a.exit_code, a.stdout_bytes, a.stderr_bytes,
           a.duration_ms, a.was_rejected, a.rejection_reason,
           a.initiated_by, a.ts
    FROM ssh_audit a
    JOIN ssh_targets t ON t.id = a.target_id
    ${where}
    ORDER BY a.ts DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const countParams = target_id ? [target_id] : [];
  const { rows: countRows } = await pool.query(`
    SELECT COUNT(*) AS total FROM ssh_audit a ${where}
  `, countParams);

  return { rows, total: parseInt(countRows[0].total, 10) };
}

module.exports = {
  // Admin-scope (all users)
  listTargets,
  getTargetById,
  createTarget,
  updateTargetMeta,
  updateTargetCredentials,
  deleteTarget,
  markConnected,
  writeAudit,
  listAudit,
  // User-scope (ownership-enforced)
  listTargetsByUser,
  getTargetByIdForUser,
  getTargetByIdForUserWithCreds,
  createTargetForUser,
  updateTargetMetaForUser,
  updateTargetCredentialsForUser,
  deleteTargetForUser,
  getConnectionsForUser,
  // Cross-entity: oracle_connections proxy lookup
  getConnectionProxyById,
};
