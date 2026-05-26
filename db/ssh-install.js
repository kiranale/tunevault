/**
 * db/ssh-install.js — SSH install credential persistence.
 *
 * Owns: ssh_install_credentials rows (one per connection, upserted on each install attempt).
 *       Audit trail of install status, logs, timestamps.
 * Does NOT own: oracle_connections CRUD (db/agent.js), agent tunnels (db/agent.js),
 *               SSH target vault (db/ssh-targets.js).
 */

'use strict';

const pool = require('./index');

/**
 * Upsert SSH install credential record.
 * Called when the user submits the /connections/new form.
 * Idempotent — re-running overwrites to allow retry with updated creds.
 */
async function upsertSshInstallCred({
  connectionId,
  userId,
  sshHost,
  sshPort,
  sshUser,
  authMethod,
  encryptedCredential,
  useSudo,
}) {
  const result = await pool.query(
    `INSERT INTO ssh_install_credentials
       (connection_id, user_id, ssh_host, ssh_port, ssh_user,
        auth_method, encrypted_credential, use_sudo,
        install_status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW(),NOW())
     ON CONFLICT (connection_id) DO UPDATE SET
       user_id              = EXCLUDED.user_id,
       ssh_host             = EXCLUDED.ssh_host,
       ssh_port             = EXCLUDED.ssh_port,
       ssh_user             = EXCLUDED.ssh_user,
       auth_method          = EXCLUDED.auth_method,
       encrypted_credential = EXCLUDED.encrypted_credential,
       use_sudo             = EXCLUDED.use_sudo,
       install_status       = 'pending',
       install_log          = NULL,
       error_message        = NULL,
       installed_at         = NULL,
       updated_at           = NOW()
     RETURNING id, connection_id`,
    [connectionId, userId, sshHost, sshPort || 22, sshUser,
     authMethod, encryptedCredential, useSudo !== false]
  );
  return result.rows[0];
}

/**
 * Mark install as running — prevents concurrent retry while one is in flight.
 */
async function markRunning(connectionId) {
  await pool.query(
    `UPDATE ssh_install_credentials
     SET install_status = 'running', updated_at = NOW()
     WHERE connection_id = $1`,
    [connectionId]
  );
}

/**
 * Append a chunk to the install log (truncated at 32 KB total).
 * Called repeatedly as install.sh streams output.
 */
async function appendLog(connectionId, chunk) {
  await pool.query(
    `UPDATE ssh_install_credentials
     SET install_log  = LEFT(COALESCE(install_log,'') || $2, 32768),
         updated_at   = NOW()
     WHERE connection_id = $1`,
    [connectionId, chunk]
  );
}

/**
 * Mark install as succeeded.
 */
async function markSuccess(connectionId) {
  await pool.query(
    `UPDATE ssh_install_credentials
     SET install_status = 'success',
         installed_at   = NOW(),
         updated_at     = NOW()
     WHERE connection_id = $1`,
    [connectionId]
  );
}

/**
 * Mark install as failed with an error message.
 */
async function markFailed(connectionId, errorMessage) {
  await pool.query(
    `UPDATE ssh_install_credentials
     SET install_status  = 'failed',
         error_message   = $2,
         updated_at      = NOW()
     WHERE connection_id = $1`,
    [connectionId, (errorMessage || 'Unknown error').slice(0, 1024)]
  );
}

/**
 * Fetch the install credential row for a connection.
 * Returns encrypted_credential — caller decrypts.
 */
async function getByConnectionId(connectionId) {
  const result = await pool.query(
    `SELECT id, connection_id, user_id, ssh_host, ssh_port, ssh_user,
            auth_method, encrypted_credential, use_sudo, install_status
     FROM ssh_install_credentials WHERE connection_id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  upsertSshInstallCred,
  markRunning,
  appendLog,
  markSuccess,
  markFailed,
  getByConnectionId,
};
