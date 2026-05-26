/**
 * db/failure-bundles.js — Persistence for check_failure_bundles table.
 *
 * Owns: INSERT, SELECT, and purge on check_failure_bundles.
 * Does NOT own: redaction logic (services/failure-capture.js),
 *               HTTP endpoints (routes/failure-bundles.js).
 */

'use strict';

const pool = require('./index');

// ── Redaction helpers ────────────────────────────────────────────────────────
// Applied before DB write so sensitive values never reach disk.

const EMAIL_RE   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// Match standalone IPv4 addresses that are NOT part of the connection profile
const IP_RE      = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function redactText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(EMAIL_RE, '[EMAIL]')
    // Keep Oracle error codes like ORA-12541 intact — only redact lone IPs
    .replace(IP_RE, '[IP]');
}

/**
 * Redact bind values: truncate VARCHAR2 values longer than 32 chars to
 * "prefix..." + length note. Removes password-like keys entirely.
 */
function redactBindValues(bindValues) {
  if (!bindValues || typeof bindValues !== 'object') return null;
  const PASSWORD_KEYS = /passw(ord)?|secret|token|key|credential|auth/i;
  const redacted = {};
  for (const [k, v] of Object.entries(bindValues)) {
    if (PASSWORD_KEYS.test(k)) {
      redacted[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 32) {
      redacted[k] = `${v.slice(0, 12)}... (${v.length} chars)`;
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

/**
 * Build redacted connection profile (host+port+service_name only — no passwords or keys).
 */
function redactConnectionProfile(conn) {
  if (!conn) return null;
  return {
    host: conn.host,
    port: conn.port,
    service_name: conn.service_name,
    connection_type: conn.connection_type,
    connectivity_mode: conn.connectivity_mode,
    proxy_url: conn.proxy_url ? conn.proxy_url.replace(/:[^:@]+@/, ':***@') : null,
  };
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert a failure bundle row.
 * Returns the new bundle id.
 *
 * @param {object} opts
 *   checkId, connectionId, userId, source,
 *   sqlText, bindValues, oraErrorCode, oraErrorMessage,
 *   pythonTraceback, proxyLogTail, nodeStack,
 *   connectionProfile, agentVersion, oracleVersion,
 *   cxOracleVersion, osRelease, contextJson
 */
async function insertBundle(opts) {
  const {
    checkId, connectionId, userId, source = 'health_check',
    sqlText, bindValues, oraErrorCode, oraErrorMessage,
    pythonTraceback, proxyLogTail, nodeStack,
    connectionProfile, agentVersion, oracleVersion,
    cxOracleVersion, osRelease, contextJson,
  } = opts;

  const result = await pool.query(
    `INSERT INTO check_failure_bundles (
       check_id, connection_id, user_id, source,
       sql_text, bind_values_redacted_json,
       ora_error_code, ora_error_message,
       python_traceback, proxy_log_tail, node_stack,
       connection_profile_redacted_json,
       agent_version, oracle_version, cx_oracle_version, os_release,
       context_json
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,
       $7,$8,
       $9,$10,$11,
       $12,
       $13,$14,$15,$16,
       $17
     )
     RETURNING id, created_at`,
    [
      checkId || null,
      connectionId || null,
      userId || null,
      source,
      sqlText ? redactText(sqlText) : null,
      bindValues ? JSON.stringify(redactBindValues(bindValues)) : null,
      oraErrorCode || null,
      oraErrorMessage ? redactText(oraErrorMessage) : null,
      pythonTraceback ? redactText(pythonTraceback) : null,
      proxyLogTail   ? redactText(proxyLogTail)    : null,
      nodeStack      ? redactText(nodeStack)        : null,
      connectionProfile ? JSON.stringify(redactConnectionProfile(connectionProfile)) : null,
      agentVersion   || null,
      oracleVersion  || null,
      cxOracleVersion || null,
      osRelease      || null,
      contextJson    ? JSON.stringify(contextJson) : null,
    ]
  );
  return result.rows[0];
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a single bundle by id.
 */
async function getBundle(bundleId) {
  const result = await pool.query(
    `SELECT b.*, oc.name AS connection_name
     FROM check_failure_bundles b
     LEFT JOIN oracle_connections oc ON oc.id = b.connection_id
     WHERE b.id = $1`,
    [bundleId]
  );
  return result.rows[0] || null;
}

/**
 * Count failures captured in the last 24h for a connection.
 * Returns { count }.
 */
async function getBadgeCount(connectionId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM check_failure_bundles
     WHERE connection_id = $1
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [connectionId]
  );
  return result.rows[0] || { count: 0 };
}

/**
 * Recent bundles for a connection (last 50).
 */
async function getRecentForConnection(connectionId, limit = 50) {
  const result = await pool.query(
    `SELECT id, check_id, source, created_at,
            ora_error_code, ora_error_message,
            LEFT(node_stack, 200) AS node_stack_preview
     FROM check_failure_bundles
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return result.rows;
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Delete bundles older than 30 days.
 * Called by daily cron in server.js.
 * Returns the number of deleted rows.
 */
async function purgeOldBundles() {
  const result = await pool.query(
    `DELETE FROM check_failure_bundles
     WHERE created_at < NOW() - INTERVAL '30 days'`
  );
  return result.rowCount;
}

/**
 * Ownership gate: returns true if userId can access the bundle.
 * Passes if: bundle has no connection, or userId owns the connection,
 * or userId === bundle.user_id (the user who triggered the check).
 */
async function userCanAccessBundle(bundleId, userId) {
  const result = await pool.query(
    `SELECT b.connection_id, b.user_id,
            oc.user_id AS conn_owner_id
     FROM check_failure_bundles b
     LEFT JOIN oracle_connections oc ON oc.id = b.connection_id
     WHERE b.id = $1`,
    [bundleId]
  );
  if (!result.rows.length) return false;
  const { connection_id, user_id, conn_owner_id } = result.rows[0];
  if (!connection_id) return true;
  return conn_owner_id === userId || user_id === userId;
}

module.exports = {
  insertBundle,
  getBundle,
  getBadgeCount,
  getRecentForConnection,
  purgeOldBundles,
  userCanAccessBundle,
};
