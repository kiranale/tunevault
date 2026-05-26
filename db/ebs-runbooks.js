/**
 * db/ebs-runbooks.js — Database helpers for EBS SSH runbooks.
 *
 * Owns: connection ownership verification for runbook routes,
 *       telemetry event writes (analytics_events).
 * Does NOT own: SSH execution, credential handling, agent channel,
 *               general oracle_connections CRUD (db/agent.js, routes layer).
 */

'use strict';

const pool = require('./index');

/**
 * Return the oracle_connection row if it exists and belongs to userId.
 * Connections with a NULL user_id are legacy shared connections accessible to any authenticated user.
 * Returns null if not found or not owned.
 */
async function getOwnedConnection(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, connection_type, service_name
       FROM oracle_connections
      WHERE id = $1`,
    [connectionId]
  );
  const conn = rows[0];
  if (!conn) return null;

  // Check ownership separately so we don't expose other columns
  const { rows: ownerRows } = await pool.query(
    `SELECT user_id FROM oracle_connections WHERE id = $1`,
    [connectionId]
  );
  const ownerId = ownerRows[0]?.user_id;
  // NULL user_id = legacy shared connection
  if (ownerId && ownerId !== userId) return null;
  return conn;
}

/**
 * Fire-and-forget telemetry for runbook executions.
 * Emits to analytics_events; never throws.
 */
function emitRunbookTelemetry({ runbookId, connectionId, role, durationMs, exitCode, userId }) {
  pool.query(
    `INSERT INTO analytics_events
       (event_name, user_id, properties, occurred_at)
     VALUES ('runbook_executed', $1, $2::jsonb, NOW())`,
    [
      userId,
      JSON.stringify({
        runbook_id:    runbookId,
        connection_id: connectionId,
        role,
        duration_ms:   durationMs,
        exit_code:     exitCode,
      }),
    ]
  ).catch(() => {}); // non-critical
}

module.exports = { getOwnedConnection, emitRunbookTelemetry };
