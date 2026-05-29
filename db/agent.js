/**
 * db/agent.js — Agent tunnel + registration token persistence.
 *
 * Owns: agent_tunnels (one per connection), agent_reg_tokens (short-lived install tokens).
 * Does NOT own: oracle_connections CRUD (server.js), API key generation/encryption (setup-fresh.js).
 */

'use strict';

const pool = require('./index');

// ── Connection name uniqueness ─────────────────────────────────────────────

class DuplicateConnectionNameError extends Error {
  constructor(name) {
    super(`DUPLICATE_CONNECTION_NAME:${name}`);
    this.name = 'DuplicateConnectionNameError';
  }
}

async function connectionNameExists(userId, name) {
  if (!userId || !name) return false;
  const result = await pool.query(
    `SELECT id FROM oracle_connections WHERE user_id = $1 AND name = $2 LIMIT 1`,
    [userId, name.trim()]
  );
  return result.rows.length > 0;
}

// ── Registration tokens ─────────────────────────────────────────────────────

async function createRegToken({ token, connectionId, userId }) {
  const result = await pool.query(
    `INSERT INTO agent_reg_tokens (token, connection_id, user_id)
     VALUES ($1, $2, $3)
     RETURNING id, token, connection_id, user_id, expires_at`,
    [token, connectionId, userId]
  );
  return result.rows[0];
}

async function redeemRegToken(token) {
  // Atomic: find valid unused token, mark used, return connection_id
  const result = await pool.query(
    `UPDATE agent_reg_tokens
     SET used = TRUE
     WHERE token = $1
       AND used = FALSE
       AND expires_at > NOW()
     RETURNING id, connection_id, user_id`,
    [token]
  );
  return result.rows[0] || null;
}

async function cleanExpiredTokens() {
  await pool.query(
    `DELETE FROM agent_reg_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'`
  );
}

// ── Agent tunnels ───────────────────────────────────────────────────────────

async function upsertTunnel({ connectionId, tunnelUuid, tunnelName, dnsHostname, status }) {
  const result = await pool.query(
    `INSERT INTO agent_tunnels (connection_id, tunnel_uuid, tunnel_name, dns_hostname, status, provisioned_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (connection_id) DO UPDATE SET
       tunnel_uuid    = EXCLUDED.tunnel_uuid,
       tunnel_name    = EXCLUDED.tunnel_name,
       dns_hostname   = EXCLUDED.dns_hostname,
       status         = EXCLUDED.status,
       oracle_sids    = '{}',
       provisioned_at = COALESCE(agent_tunnels.provisioned_at, NOW()),
       updated_at     = NOW()
     RETURNING *`,
    [connectionId, tunnelUuid, tunnelName, dnsHostname, status]
  );
  return result.rows[0];
}

async function confirmTunnel({ connectionId, osInfo, oracleHome, oracleSids, pdbServices }) {
  // Always overwrite oracle_sids + pdb_services — installer is ground truth.
  // On re-registration the old values must be replaced, never merged/appended.
  const result = await pool.query(
    `UPDATE agent_tunnels
     SET status        = 'confirmed',
         os_info       = $2,
         oracle_home   = $3,
         oracle_sids   = $4,
         pdb_services  = $5,
         confirmed_at  = NOW(),
         updated_at    = NOW()
     WHERE connection_id = $1
     RETURNING *`,
    [connectionId, osInfo, oracleHome, oracleSids || [], pdbServices || []]
  );
  if (!result.rows[0]) {
    console.warn(`[agent-db] confirmTunnel: no tunnel row for connection_id=${connectionId} — confirm had no effect`);
  }
  return result.rows[0] || null;
}

/**
 * Update oracle_sids + pdb_services after a re-detect-sids probe.
 * Called from the re-detect-sids route — always overwrites both arrays.
 */
async function updateTunnelSids({ connectionId, oracleSids, pdbServices }) {
  await pool.query(
    `UPDATE agent_tunnels
     SET oracle_sids  = $2,
         pdb_services = $3,
         updated_at   = NOW()
     WHERE connection_id = $1`,
    [connectionId, oracleSids || [], pdbServices || []]
  );
}

async function recordHeartbeat(connectionId, agentVersion, meta) {
  // Transition any non-terminal state to 'active' on heartbeat.
  // agentVersion is optional — sent by oracle-proxy.py since v3.5.5+.
  // meta: { proxy_version, installed_at, last_upgrade_at, python_version, cx_oracle_version,
  //         os_id, kernel, agent_status, last_oracle_error, oracle_retry_count, uptime_seconds,
  //         oracle_mode, instant_client_path, verifier_workaround_active }
  const m = (meta && typeof meta === 'object') ? meta : {};

  // agent_status from oracle_worker: 'starting' | 'healthy' | 'oracle_unreachable'
  // Null-safe — older agents that don't send this field leave the column unchanged.
  const agentStatus = m.agent_status || null;
  const lastOracleError = m.last_oracle_error !== undefined ? m.last_oracle_error : undefined;

  // Guard against NaN strings from Python agents (e.g., str(NaN) → "NaN").
  // parseInt("NaN", 10) returns NaN, not null — PostgreSQL rejects NaN for integer columns.
  const safeInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  const oracleRetryCount = m.oracle_retry_count !== undefined ? safeInt(m.oracle_retry_count) : null;
  const uptimeSeconds = m.uptime_seconds !== undefined ? safeInt(m.uptime_seconds) : null;

  // Thick-mode fallback fields (v6.2+ agent, Task #1728054).
  // Null-safe — older agents that omit these leave the columns unchanged via COALESCE.
  const oracleMode = m.oracle_mode || null;                 // 'thin' | 'thick'
  const instantClientPath = m.instant_client_path || null;
  const verifierWorkaroundActive = m.verifier_workaround_active != null
    ? Boolean(m.verifier_workaround_active) : null;

  const result = await pool.query(
    `UPDATE agent_tunnels
     SET last_heartbeat              = NOW(),
         status                      = CASE WHEN status != 'uninstalled' THEN 'active' ELSE status END,
         agent_version               = COALESCE($2, agent_version),
         agent_status                = COALESCE($3, agent_status),
         last_oracle_error           = CASE WHEN $4::jsonb IS NOT NULL THEN $4::jsonb ELSE last_oracle_error END,
         oracle_retry_count          = COALESCE($5, oracle_retry_count),
         uptime_seconds              = COALESCE($6, uptime_seconds),
         oracle_status_at            = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE oracle_status_at END,
         oracle_mode                 = COALESCE($7, oracle_mode),
         instant_client_path         = COALESCE($8, instant_client_path),
         verifier_workaround_active  = COALESCE($9, verifier_workaround_active),
         updated_at                  = NOW()
     WHERE connection_id = $1
     RETURNING id, connection_id, status, last_heartbeat, agent_version, agent_status,
               oracle_mode, instant_client_path, verifier_workaround_active`,
    [
      connectionId,
      agentVersion || null,
      agentStatus,
      lastOracleError !== undefined ? JSON.stringify(lastOracleError) : null,
      oracleRetryCount,
      uptimeSeconds,
      oracleMode,
      instantClientPath,
      verifierWorkaroundActive,
    ]
  );

  // Persist extended proxy metadata to oracle_connections (backward-compatible — all nullable)
  if (m.proxy_version || m.installed_at || m.python_version || m.cx_oracle_version || m.os_id || m.kernel) {
    await pool.query(
      `UPDATE oracle_connections SET
         proxy_version      = COALESCE($2, proxy_version),
         installed_at       = COALESCE($3, installed_at),
         last_upgrade_at    = COALESCE($4, last_upgrade_at),
         python_version     = COALESCE($5, python_version),
         cx_oracle_version  = COALESCE($6, cx_oracle_version),
         os_id              = COALESCE($7, os_id),
         kernel_version     = COALESCE($8, kernel_version),
         updated_at         = NOW()
       WHERE id = $1`,
      [
        connectionId,
        m.proxy_version    || null,
        m.installed_at     || null,
        m.last_upgrade_at  || null,
        m.python_version   || null,
        m.cx_oracle_version|| null,
        m.os_id            || null,
        m.kernel           || null,
      ]
    );
  }

  return result.rows[0] || null;
}

async function getTunnel(connectionId) {
  const result = await pool.query(
    `SELECT * FROM agent_tunnels WHERE connection_id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

async function markUninstalled(connectionId) {
  // Sets uninstalled_at for the 30-day restore window; nulls heartbeat so fleet
  // status reads as offline immediately.
  await pool.query(
    `UPDATE agent_tunnels
     SET status         = 'uninstalled',
         uninstalled_at = NOW(),
         last_heartbeat = NULL,
         updated_at     = NOW()
     WHERE connection_id = $1`,
    [connectionId]
  );
}

async function restoreConnection(connectionId) {
  // Flip status back to 'pending' (agent needs re-install to become active again).
  // Clears uninstalled_at so the row no longer shows in the Removed section.
  await pool.query(
    `UPDATE agent_tunnels
     SET status         = 'pending',
         uninstalled_at = NULL,
         updated_at     = NOW()
     WHERE connection_id = $1`,
    [connectionId]
  );
}

// ── Connection helpers (agent-scoped reads/writes on oracle_connections) ────

async function createAgentConnection({ name, host, port, serviceName, username, encryptedPassword, encryptedKey, userId, privilegeModel }) {
  const displayName = (name || '').trim();
  if (!displayName) throw new Error('Connection name is required');
  if (await connectionNameExists(userId, displayName)) {
    throw new DuplicateConnectionNameError(displayName);
  }
  const model = (privilegeModel === 'sysdba') ? 'sysdba' : 'reader';
  const result = await pool.query(
    `INSERT INTO oracle_connections
       (name, host, port, service_name, username, encrypted_password,
        connection_type, proxy_url, proxy_api_key_enc, user_id, proxy_key_created_at, privilege_model)
     VALUES ($1, $2, $3, $4, $5, $6, 'proxy', $7, $8, $9, NOW(), $10)
     RETURNING id, name`,
    [name, host, port, serviceName, username, encryptedPassword,
     'https://pending.tunevault.agent', encryptedKey, userId, model]
  );
  return result.rows[0];
}

/**
 * Agent-only connection — no DB credentials needed upfront.
 * The agent auto-detects Oracle SIDs after install and updates the record.
 * hostIp/sshUser are collected from the UI; proxy_url is built from hostIp
 * so health checks can reach the proxy before a tunnel is provisioned.
 */
async function createAgentOnlyConnection({ name, encryptedKey, userId, hostIp, sshUser, privilegeModel }) {
  const displayName = (name || '').trim();
  if (!displayName) throw new Error('Connection name is required');
  if (await connectionNameExists(userId, displayName)) {
    throw new DuplicateConnectionNameError(displayName);
  }
  // Build proxy_url from hostIp if provided; placeholder only as last resort
  const proxyUrl = hostIp ? `http://${hostIp}:3100` : 'https://pending.tunevault.agent';
  const model = (privilegeModel === 'sysdba') ? 'sysdba' : 'reader';
  const result = await pool.query(
    `INSERT INTO oracle_connections
       (name, host, connection_type, proxy_url, proxy_api_key_enc, user_id, proxy_key_created_at, privilege_model)
     VALUES ($1, $2, 'proxy', $3, $4, $5, NOW(), $6)
     RETURNING id, name`,
    [name, hostIp || null, proxyUrl, encryptedKey, userId, model]
  );
  return result.rows[0];
}

async function getConnectionById(connectionId) {
  const result = await pool.query(
    `SELECT id, name, user_id, proxy_api_key_enc, proxy_key_last_used_at, last_test_success
     FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

async function updateConnectionProxyUrl(connectionId, proxyUrl) {
  await pool.query(
    `UPDATE oracle_connections SET proxy_url = $1, updated_at = NOW() WHERE id = $2`,
    [proxyUrl, connectionId]
  );
}

async function touchConnectionKeyUsage(connectionId) {
  await pool.query(
    `UPDATE oracle_connections SET proxy_key_last_used_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [connectionId]
  );
}

async function updateConnectionSid(connectionId, serviceName) {
  await pool.query(
    `UPDATE oracle_connections SET service_name = $1, updated_at = NOW() WHERE id = $2`,
    [serviceName, connectionId]
  );
}

async function updateConnectionInstallerInfo(connectionId, { serverType, ebsService }) {
  await pool.query(
    `UPDATE oracle_connections SET
      server_type = COALESCE($1, server_type),
      ebs_service = COALESCE($2, ebs_service),
      updated_at = NOW()
     WHERE id = $3`,
    [serverType || null, ebsService || null, connectionId]
  );
}
async function clearConnectionProxy(connectionId) {
  await pool.query(
    `UPDATE oracle_connections SET proxy_url = NULL, updated_at = NOW() WHERE id = $1`,
    [connectionId]
  );
}

// Returns a status summary for a single agent connection.
// Used by GET /api/connections/:id/agent-status.
// Pulls from agent_tunnels + oracle_connections — no new schema needed.
async function getAgentStatus(connectionId) {
  const result = await pool.query(
    `SELECT
       oc.id,
       oc.connection_type,
       oc.proxy_url,
       oc.proxy_key_last_used_at,
       at.tunnel_uuid,
       at.dns_hostname,
       at.status        AS tunnel_status,
       at.last_heartbeat,
       at.oracle_sids   AS detected_sids,
       at.os_info,
       at.agent_version
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE oc.id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// Returns enriched diagnostics for a single agent connection.
// Extends getAgentStatus with the most recent health check status/error
// and the connection owner user_id for access control.
// Used by GET /api/connections/:id/diagnostics.
async function getDiagnostics(connectionId) {
  const result = await pool.query(
    `SELECT
       oc.id,
       oc.user_id,
       oc.name          AS connection_name,
       oc.connection_type,
       oc.proxy_url,
       oc.proxy_key_last_used_at,
       at.tunnel_uuid,
       at.dns_hostname,
       at.status        AS tunnel_status,
       at.last_heartbeat,
       at.oracle_sids   AS detected_sids,
       at.os_info,
       at.agent_version,
       hc.id            AS last_hc_id,
       hc.status        AS last_hc_status,
       hc.created_at    AS last_hc_at,
       hc.summary_text  AS last_hc_error
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     LEFT JOIN LATERAL (
       SELECT id, status, created_at, summary_text
       FROM health_checks
       WHERE connection_id = oc.id
       ORDER BY created_at DESC
       LIMIT 1
     ) hc ON TRUE
     WHERE oc.id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// Returns all agent connections for a user that are stale or unregistered.
// Used by dashboard banner: "N agent connections need attention".
async function getStaleAgentConnections(userId) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const result = await pool.query(
    `SELECT oc.id, oc.name, at.last_heartbeat, at.status AS tunnel_status
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE (oc.user_id = $1 OR oc.user_id IS NULL)
       AND oc.connection_type = 'proxy'
       AND (
         at.id IS NULL
         OR at.status = 'uninstalled'
         OR at.last_heartbeat IS NULL
         OR at.last_heartbeat < $2
       )`,
    [userId, fiveMinAgo.toISOString()]
  );
  return result.rows;
}

/**
 * Return the most recent unused, non-expired registration token for a connection.
 * Used by the SSH-install route to retrieve the token issued at form-submit time.
 */
async function getLatestRegToken(connectionId) {
  const result = await pool.query(
    `SELECT token FROM agent_reg_tokens
     WHERE connection_id = $1
       AND used = FALSE
       AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// Returns minimal connection row needed for the ping endpoint.
// Includes encrypted_password so the caller can decrypt and forward to the agent.
async function getConnectionForPing(connectionId) {
  const result = await pool.query(
    `SELECT id, user_id, connection_type, host, port, service_name, username, encrypted_password
     FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// Returns connection row with credentials for the run-diagnostics endpoint.
// Also fetches detected_sids from agent_tunnels for SID auto-selection.
async function getConnectionForDiagnostics(connectionId) {
  const result = await pool.query(
    `SELECT oc.id, oc.user_id, oc.connection_type, oc.host, oc.port,
            oc.service_name, oc.username, oc.encrypted_password,
            at.oracle_sids AS detected_sids
     FROM oracle_connections oc
     LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE oc.id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// Stamp last_diagnostics_at = NOW() after a successful diagnostics run.
async function touchDiagnosticsAt(connectionId) {
  await pool.query(
    `UPDATE oracle_connections SET last_diagnostics_at = NOW() WHERE id = $1`,
    [connectionId]
  );
}

// ── Key rotation helpers ──────────────────────────────────────────────────────

/**
 * Atomically rotate the API key for a connection.
 *
 * - Moves current proxy_api_key_enc → proxy_api_key_enc_previous (5-min grace)
 * - Sets proxy_api_key_enc = newEncryptedKey
 * - Sets key_rotation_status = 'pending' (agent hasn't ACKed yet)
 * - Records rotated_at + actor email
 *
 * The grace window lets in-flight poll/respond requests that carry the OLD key
 * still succeed for 5 minutes while the agent picks up the new key.
 */
async function rotateConnectionKey(connectionId, newEncryptedKey, actorEmail) {
  await pool.query(
    `UPDATE oracle_connections
     SET proxy_api_key_enc_previous = proxy_api_key_enc,
         proxy_api_key_enc          = $1,
         key_rotated_at             = NOW(),
         key_rotation_status        = 'pending',
         key_rotation_actor         = $2,
         updated_at                 = NOW()
     WHERE id = $3`,
    [newEncryptedKey, actorEmail || null, connectionId]
  );
}

/**
 * Mark a rotation as acknowledged (agent confirmed it received the new key).
 */
async function ackKeyRotation(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET key_rotation_status = 'acknowledged',
         updated_at           = NOW()
     WHERE id = $1`,
    [connectionId]
  );
}

/**
 * Return current rotation state for a connection.
 * Also returns proxy_api_key_enc_previous so the grace-window check in
 * verifyApiKey can decrypt and compare without a second query.
 */
async function getConnectionKeyState(connectionId) {
  const result = await pool.query(
    `SELECT id, user_id, proxy_api_key_enc, proxy_api_key_enc_previous,
            key_rotated_at, key_rotation_status, key_rotation_actor
     FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Return last 5 key rotation events for the history list in the UI.
 * We read from activity_log (action_type = 'settings_change', detail.event = 'connection_key_rotated').
 */
async function getKeyRotationHistory(connectionId) {
  const result = await pool.query(
    `SELECT user_email, detail, created_at
     FROM activity_log
     WHERE connection_id = $1
       AND action_type   = 'settings_change'
       AND detail->>'event' = 'connection_key_rotated'
     ORDER BY created_at DESC
     LIMIT 5`,
    [connectionId]
  );
  return result.rows;
}

// ── Connection status + install token hash (v6 wizard) ──────────────────────

async function setConnectionStatus(connectionId, status) {
  await pool.query(
    `UPDATE oracle_connections SET status = $1 WHERE id = $2`,
    [status, connectionId]
  );
}

async function setInstallTokenHash(connectionId, tokenHash) {
  await pool.query(
    `UPDATE oracle_connections SET install_token_hash = $1 WHERE id = $2`,
    [tokenHash, connectionId]
  );
}

async function clearInstallTokenHash(connectionId) {
  await pool.query(
    `UPDATE oracle_connections SET install_token_hash = NULL WHERE id = $1`,
    [connectionId]
  );
}

// ── Install timing stamps ────────────────────────────────────────────────────

/**
 * Stamp install_token_issued_at = NOW() the first time a token is minted.
 * Uses COALESCE so re-issues don't overwrite the original timestamp —
 * the original issuance time is the start of the stall clock.
 */
async function stampInstallTokenIssuedAt(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET install_token_issued_at = COALESCE(install_token_issued_at, NOW()),
         updated_at               = NOW()
     WHERE id = $1`,
    [connectionId]
  );
}

/**
 * Stamp first_heartbeat_at = NOW() on the first successful heartbeat.
 * No-op if already set (COALESCE guard).
 * Clears the stalled state permanently — once an agent phones home the row
 * is no longer stalled regardless of subsequent silences.
 */
async function stampFirstHeartbeatAt(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET first_heartbeat_at = COALESCE(first_heartbeat_at, NOW()),
         updated_at          = NOW()
     WHERE id = $1`,
    [connectionId]
  );
}

/**
 * Return agent tunnels for a user's connections that match a given SSH host.
 * Used by install-jobs to detect an already-online agent (double-install guard).
 */
async function getTunnelsByUserAndHost(userId, host) {
  const result = await pool.query(
    `SELECT at.connection_id, at.status, at.last_heartbeat, at.agent_version
     FROM agent_tunnels at
     JOIN oracle_connections oc ON oc.id = at.connection_id
     WHERE oc.user_id = $1
       AND (oc.host = $2 OR oc.ssh_db_host = $2)`,
    [userId, host]
  );
  return result.rows;
}

// ── Expire pending_registration drafts older than 24h ───────────────────────
// Called by the cleanup cron in routes/agent.js cleanup interval.

async function expirePendingDrafts() {
  const result = await pool.query(
    `DELETE FROM oracle_connections
     WHERE status = 'pending_registration'
       AND created_at < NOW() - INTERVAL '24 hours'
     RETURNING id`
  );
  return result.rows.map(r => r.id);
}

module.exports = {
  createRegToken,
  redeemRegToken,
  cleanExpiredTokens,
  getLatestRegToken,
  upsertTunnel,
  confirmTunnel,
  recordHeartbeat,
  getTunnel,
  markUninstalled,
  restoreConnection,
  createAgentConnection,
  createAgentOnlyConnection,
  getConnectionById,
  updateConnectionProxyUrl,
  updateConnectionSid,
  updateConnectionInstallerInfo,
  touchConnectionKeyUsage,
  clearConnectionProxy,
  getAgentStatus,
  getStaleAgentConnections,
  getDiagnostics,
  getConnectionForPing,
  getConnectionForDiagnostics,
  touchDiagnosticsAt,
  rotateConnectionKey,
  ackKeyRotation,
  getConnectionKeyState,
  getKeyRotationHistory,
  setConnectionStatus,
  setInstallTokenHash,
  clearInstallTokenHash,
  expirePendingDrafts,
  updateTunnelSids,
  stampInstallTokenIssuedAt,
  stampFirstHeartbeatAt,
  getTunnelsByUserAndHost,
};
