/**
 * db/agent-upgrade-audit.js — Persistence for auto-upgrade lifecycle events.
 *
 * Owns: agent_upgrade_audit CRUD, auto_upgrade_enabled toggle on oracle_connections.
 * Does NOT own: upgrade work-item dispatch (routes/agent.js), agent channel (services/agent-channel.js).
 */

'use strict';

const pool = require('./index');

// ── Auto-upgrade policy ───────────────────────────────────────────────────────

/**
 * Return auto_upgrade_enabled for a connection.
 * Also returns connection_type, plan_tier, and any in-flight audit row.
 */
async function getUpgradePolicy(connectionId) {
  const result = await pool.query(
    `SELECT id, auto_upgrade_enabled, connection_type, server_type, proxy_version
     FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Set auto_upgrade_enabled for a connection.
 */
async function setAutoUpgradeEnabled(connectionId, enabled) {
  await pool.query(
    `UPDATE oracle_connections SET auto_upgrade_enabled = $1 WHERE id = $2`,
    [!!enabled, connectionId]
  );
}

// ── Safety rails ──────────────────────────────────────────────────────────────

/**
 * Count failed auto-upgrades for this connection in the last 24h.
 * If ≥ 2, auto-upgrade is suppressed until a human intervenes.
 */
async function recentFailureCount(connectionId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM agent_upgrade_audit
     WHERE connection_id = $1
       AND status = 'failed'
       AND triggered_at > NOW() - INTERVAL '24 hours'`,
    [connectionId]
  );
  return parseInt(result.rows[0]?.cnt || '0', 10);
}

/**
 * Return the most recent queued-or-in-progress audit row for a connection.
 * Used to enforce the 6h dedup window — don't re-enqueue if one is already running.
 */
async function getActiveUpgrade(connectionId) {
  const result = await pool.query(
    `SELECT id, status, triggered_at
     FROM agent_upgrade_audit
     WHERE connection_id = $1
       AND status IN ('queued', 'in_progress')
       AND triggered_at > NOW() - INTERVAL '6 hours'
     ORDER BY triggered_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// ── Audit row lifecycle ───────────────────────────────────────────────────────

/**
 * Insert a new audit row with status='queued'.
 * Returns the new row id.
 */
async function insertUpgradeAudit({ connectionId, fromVersion, toVersion, triggeredBy }) {
  const result = await pool.query(
    `INSERT INTO agent_upgrade_audit
       (connection_id, from_version, to_version, triggered_by, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING id`,
    [connectionId, fromVersion || null, toVersion, triggeredBy || 'auto-stale-policy']
  );
  return result.rows[0]?.id || null;
}

/**
 * Transition an audit row to 'in_progress'.
 */
async function markUpgradeInProgress(auditId) {
  await pool.query(
    `UPDATE agent_upgrade_audit SET status = 'in_progress' WHERE id = $1`,
    [auditId]
  );
}

/**
 * Transition an audit row to 'completed', stamp completed_at.
 */
async function markUpgradeCompleted(auditId) {
  await pool.query(
    `UPDATE agent_upgrade_audit
     SET status = 'completed', completed_at = NOW()
     WHERE id = $1`,
    [auditId]
  );
}

/**
 * Transition an audit row to 'failed', record reason.
 */
async function markUpgradeFailed(auditId, error) {
  await pool.query(
    `UPDATE agent_upgrade_audit
     SET status = 'failed', completed_at = NOW(), error = $2
     WHERE id = $1`,
    [auditId, error || 'unknown']
  );
}

/**
 * After a successful heartbeat where the version now matches to_version,
 * complete any in-flight queued/in_progress audit rows for this connection.
 * Used by the heartbeat handler to close the loop when the agent checks back in.
 */
async function completeUpgradeOnHeartbeat(connectionId, newVersion) {
  const result = await pool.query(
    `UPDATE agent_upgrade_audit
     SET status = 'completed', completed_at = NOW()
     WHERE connection_id = $1
       AND status IN ('queued', 'in_progress')
       AND to_version = $2
     RETURNING id`,
    [connectionId, newVersion]
  );
  return result.rows.length;
}

/**
 * Fail timed-out in-progress upgrades (>10 minutes without completion).
 * Called periodically by the cron in routes/agent.js.
 */
async function expireTimedOutUpgrades() {
  const result = await pool.query(
    `UPDATE agent_upgrade_audit
     SET status = 'failed', completed_at = NOW(), error = 'timed out — no version confirmation after 10 min'
     WHERE status IN ('queued', 'in_progress')
       AND triggered_at < NOW() - INTERVAL '10 minutes'
     RETURNING id`
  );
  return result.rows.length;
}

// ── Manual reset ─────────────────────────────────────────────────────────────

/**
 * Push recent failed rows for a connection outside the 24h suppression window
 * by back-dating their triggered_at to 25h ago. Preserves audit history;
 * only removes the time-window suppression so auto-upgrade can retry.
 * Returns the number of rows affected.
 */
async function resetRecentFailures(connectionId) {
  const result = await pool.query(
    `UPDATE agent_upgrade_audit
     SET triggered_at = NOW() - INTERVAL '25 hours'
     WHERE connection_id = $1
       AND status = 'failed'
       AND triggered_at > NOW() - INTERVAL '24 hours'
     RETURNING id`,
    [connectionId]
  );
  return result.rows.length;
}

// ── Audit list queries ────────────────────────────────────────────────────────

/**
 * Return the most recent audit row per connection for status badges on /connections.
 * Returns a Map<connectionId, auditRow>.
 */
async function getLatestAuditsForConnections(connectionIds) {
  if (!connectionIds || connectionIds.length === 0) return {};
  const result = await pool.query(
    `SELECT DISTINCT ON (connection_id)
       id, connection_id, from_version, to_version, triggered_by,
       triggered_at, completed_at, status, error
     FROM agent_upgrade_audit
     WHERE connection_id = ANY($1::int[])
     ORDER BY connection_id, triggered_at DESC`,
    [connectionIds]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.connection_id] = row;
  }
  return map;
}

/**
 * Return last 100 audit rows for the admin page, newest first.
 * Joins oracle_connections for connection name display.
 */
async function listRecentAudits({ limit = 100 } = {}) {
  const result = await pool.query(
    `SELECT a.id, a.connection_id, oc.name AS connection_name,
            a.from_version, a.to_version, a.triggered_by,
            a.triggered_at, a.completed_at, a.status, a.error,
            EXTRACT(EPOCH FROM (a.completed_at - a.triggered_at))::int AS duration_s
     FROM agent_upgrade_audit a
     LEFT JOIN oracle_connections oc ON oc.id = a.connection_id
     ORDER BY a.triggered_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  getUpgradePolicy,
  setAutoUpgradeEnabled,
  recentFailureCount,
  resetRecentFailures,
  getActiveUpgrade,
  insertUpgradeAudit,
  markUpgradeInProgress,
  markUpgradeCompleted,
  markUpgradeFailed,
  completeUpgradeOnHeartbeat,
  expireTimedOutUpgrades,
  getLatestAuditsForConnections,
  listRecentAudits,
};
