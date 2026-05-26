/**
 * db/proxy-exec-audit.js — Proxy exec audit log + connection lookup helpers.
 *
 * Owns: proxy_exec_audit table reads and writes; oracle_connections
 *       lookups needed by the proxy-exec route (proxy_url, api_key, ownership).
 * Does NOT own: connection CRUD, auth middleware, proxy HTTP transport.
 */

'use strict';

const pool = require('./index');

/**
 * Append one audit record for a proxy /exec call.
 */
async function logExec({
  connectionId,
  userId,
  commandId,
  args,
  exitCode,
  durationMs,
  stdout,
  stderr,
  error,
}) {
  const succeeded = !error && exitCode === 0;
  await pool.query(
    `INSERT INTO proxy_exec_audit
       (connection_id, user_id, command_id, args, exit_code, duration_ms,
        stdout_bytes, stderr_bytes, succeeded, error_message, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      connectionId,
      userId,
      commandId,
      JSON.stringify(args || {}),
      exitCode ?? -1,
      durationMs ?? 0,
      stdout ? Buffer.byteLength(stdout, 'utf8') : 0,
      stderr ? Buffer.byteLength(stderr, 'utf8') : 0,
      succeeded,
      error || null,
    ]
  );
}

/**
 * Return recent audit rows for a connection.
 */
async function getAuditLog({ connectionId, limit = 50, offset = 0 }) {
  const { rows } = await pool.query(
    `SELECT id, connection_id, user_id, command_id, args, exit_code,
            duration_ms, stdout_bytes, stderr_bytes, succeeded,
            error_message, executed_at
       FROM proxy_exec_audit
      WHERE connection_id = $1
      ORDER BY executed_at DESC
      LIMIT $2 OFFSET $3`,
    [connectionId, Math.min(limit, 200), offset]
  );
  return rows;
}

/**
 * Fetch proxy connection fields for a given connection id.
 * Returns null if not found.
 */
async function getProxyConnection(connectionId) {
  const { rows } = await pool.query(
    `SELECT id, connection_type, proxy_url, proxy_api_key_enc
       FROM oracle_connections
      WHERE id = $1`,
    [connectionId]
  );
  return rows[0] || null;
}

/**
 * Check whether a given user owns a connection.
 * Returns the connection row if owned, null otherwise.
 */
async function getOwnedConnection(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id FROM oracle_connections
      WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  return rows[0] || null;
}

module.exports = { logExec, getAuditLog, getProxyConnection, getOwnedConnection };
