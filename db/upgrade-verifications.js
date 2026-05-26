/**
 * db/upgrade-verifications.js — Post-upgrade verification persistence.
 *
 * Owns: verification_payload / verification_status / verified_at on agent_upgrade_audit;
 *       post-upgrade rows in installer_validation_runs.
 * Does NOT own: upgrade dispatch logic (routes/agent.js), audit lifecycle (db/agent-upgrade-audit.js),
 *               operator email (called from routes/upgrade-verifications.js).
 */

'use strict';

const pool = require('./index');

/**
 * Attach a verification payload to the most-recent completed audit row for a connection.
 *
 * The agent sends: { verification_id, checks_passed, checks_total,
 *                    api_test_status, probe_7, probe_8, timestamp }
 *
 * Returns the audit row id that was updated, or null if none found.
 */
async function saveVerification({ connectionId, auditId, payload, status }) {
  // If caller knows the audit id, use it directly. Otherwise find the latest completed row.
  let targetId = auditId || null;

  if (!targetId) {
    const find = await pool.query(
      `SELECT id FROM agent_upgrade_audit
       WHERE connection_id = $1
         AND status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
      [connectionId]
    );
    targetId = find.rows[0]?.id || null;
  }

  if (!targetId) return null;

  const result = await pool.query(
    `UPDATE agent_upgrade_audit
     SET verification_payload = $2,
         verification_status  = $3,
         verified_at          = NOW()
     WHERE id = $1
     RETURNING id, connection_id, to_version, verification_status, verified_at`,
    [targetId, JSON.stringify(payload), status]
  );
  return result.rows[0] || null;
}

/**
 * Insert a post-upgrade validation run into installer_validation_runs.
 *
 * topology = 'post-upgrade-v3-to-v6'
 * os       = 'post-upgrade'
 *
 * Uses the same schema as EBS live rows (checks_passed, checks_total, topology).
 */
async function insertPostUpgradeValidationRun({
  connectionId,
  connectionName,
  fromVersion,
  toVersion,
  runId,
  agentVersion,
  checksPassed,
  checksTotal,
  probe7Status,
  probe8Status,
  overallOutcome,
  durationMs,
}) {
  // Insert into installer_validation_runs
  const insertResult = await pool.query(
    `INSERT INTO installer_validation_runs
       (run_id, os, trigger_source, topology, started_at, finished_at,
        agent_version, overall, duration_total_ms,
        checks_passed, checks_total, ssh_runbook_executed,
        probe_7_status, probe_8_status,
        error_message)
     VALUES ($1, 'post-upgrade', 'post-upgrade-agent', 'post-upgrade-v3-to-v6',
             NOW(), NOW(),
             $2, $3, $4,
             $5, $6, false,
             $7, $8,
             $9)
     RETURNING id`,
    [
      runId,
      agentVersion || toVersion,
      overallOutcome,
      durationMs || null,
      checksPassed,
      checksTotal,
      probe7Status,
      probe8Status,
      // Store from→to version + connection info in error_message for context
      `connection:${connectionName || connectionId} from:${fromVersion} to:${toVersion}`,
    ]
  );

  return insertResult.rows[0]?.id || null;
}

/**
 * Get the latest verification payload for a connection.
 * Used by /connections Version badge tooltip.
 */
async function getLatestVerificationForConnection(connectionId) {
  const result = await pool.query(
    `SELECT a.id, a.connection_id, a.from_version, a.to_version,
            a.verification_payload, a.verification_status, a.verified_at,
            a.completed_at, a.status
     FROM agent_upgrade_audit a
     WHERE a.connection_id = $1
       AND a.verified_at IS NOT NULL
     ORDER BY a.verified_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Get latest verification payloads for multiple connections.
 * Returns Map<connectionId, row>.
 */
async function getLatestVerificationsForConnections(connectionIds) {
  if (!connectionIds || connectionIds.length === 0) return {};
  const result = await pool.query(
    `SELECT DISTINCT ON (connection_id)
       id, connection_id, from_version, to_version,
       verification_payload, verification_status, verified_at
     FROM agent_upgrade_audit
     WHERE connection_id = ANY($1::int[])
       AND verified_at IS NOT NULL
     ORDER BY connection_id, verified_at DESC`,
    [connectionIds]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.connection_id] = row;
  }
  return map;
}

/**
 * Get the last 20 post-upgrade validation runs for /status/installer display.
 * Joins oracle_connections for connection name.
 */
async function getRecentUpgradeVerifications({ limit = 20 } = {}) {
  const result = await pool.query(
    `SELECT a.id, a.connection_id, oc.name AS connection_name,
            a.from_version, a.to_version,
            a.verification_payload, a.verification_status, a.verified_at,
            a.triggered_at, a.completed_at, a.status AS upgrade_status
     FROM agent_upgrade_audit a
     LEFT JOIN oracle_connections oc ON oc.id = a.connection_id
     WHERE a.verified_at IS NOT NULL
     ORDER BY a.verified_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Mark a connection as upgrade-degraded when verification fails.
 * Sets oracle_connections.status = 'upgrade-degraded'.
 */
async function markConnectionUpgradeDegraded(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET status = 'upgrade-degraded'
     WHERE id = $1`,
    [connectionId]
  );
}

/**
 * Clear upgrade-degraded status after a successful re-verification.
 */
async function clearUpgradeDegradedStatus(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET status = NULL
     WHERE id = $1
       AND status = 'upgrade-degraded'`,
    [connectionId]
  );
}

module.exports = {
  saveVerification,
  insertPostUpgradeValidationRun,
  getLatestVerificationForConnection,
  getLatestVerificationsForConnections,
  getRecentUpgradeVerifications,
  markConnectionUpgradeDegraded,
  clearUpgradeDegradedStatus,
};
