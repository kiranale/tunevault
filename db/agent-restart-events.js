/**
 * db/agent-restart-events.js — Agent restart-event persistence.
 *
 * Owns: agent_restart_events (append-only restart log) + agent_in_restart_loop flag on oracle_connections.
 * Does NOT own: heartbeat, poll, registration — those stay in db/agent.js.
 */

'use strict';

const pool = require('./index');

// ── Insert a restart event ────────────────────────────────────────────────────

async function insertRestartEvent({ connectionId, reasonCode, lastStageReached, lastError, uptimeSeconds, restartSequenceId }) {
  const result = await pool.query(
    `INSERT INTO agent_restart_events
       (connection_id, reason_code, last_stage_reached, last_error, uptime_seconds, restart_sequence_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, recorded_at`,
    [connectionId, reasonCode, lastStageReached || null, lastError || null,
     uptimeSeconds != null ? parseInt(uptimeSeconds, 10) : null, restartSequenceId || null]
  );
  return result.rows[0];
}

// ── Count restarts in a time window ─────────────────────────────────────────

async function countRestarts(connectionId, windowMinutes) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM agent_restart_events
     WHERE connection_id = $1
       AND recorded_at > NOW() - ($2 || ' minutes')::interval`,
    [connectionId, windowMinutes]
  );
  return result.rows[0].cnt;
}

// ── Count restarts for a specific reason_code in window ─────────────────────
// Used for loop detection: ≥5 restarts with same reason in 10 min.

async function countRestartsByReason(connectionId, reasonCode, windowMinutes) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM agent_restart_events
     WHERE connection_id = $1
       AND reason_code = $2
       AND recorded_at > NOW() - ($3 || ' minutes')::interval`,
    [connectionId, reasonCode, windowMinutes]
  );
  return result.rows[0].cnt;
}

// ── Restart counts for agent list (1h and 24h) ───────────────────────────────

async function getRestartCounts(connectionId) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '1 hour')::int  AS count_1h,
       COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::int AS count_24h
     FROM agent_restart_events
     WHERE connection_id = $1`,
    [connectionId]
  );
  return result.rows[0];
}

// ── Flip / clear restart-loop flag on oracle_connections ────────────────────

async function setRestartLoopFlag(connectionId, inLoop, reasonCode) {
  if (inLoop) {
    await pool.query(
      `UPDATE oracle_connections
       SET agent_in_restart_loop     = TRUE,
           agent_restart_loop_reason = $2,
           agent_restart_loop_at     = NOW()
       WHERE id = $1`,
      [connectionId, reasonCode]
    );
  } else {
    await pool.query(
      `UPDATE oracle_connections
       SET agent_in_restart_loop     = FALSE,
           agent_restart_loop_reason = NULL,
           agent_restart_loop_at     = NULL
       WHERE id = $1`,
      [connectionId]
    );
  }
}

// ── Clear loop flag on successful heartbeat ───────────────────────────────────

async function clearRestartLoopIfSet(connectionId) {
  await pool.query(
    `UPDATE oracle_connections
     SET agent_in_restart_loop     = FALSE,
         agent_restart_loop_reason = NULL,
         agent_restart_loop_at     = NULL
     WHERE id = $1 AND agent_in_restart_loop = TRUE`,
    [connectionId]
  );
}

module.exports = {
  insertRestartEvent,
  countRestarts,
  countRestartsByReason,
  getRestartCounts,
  setRestartLoopFlag,
  clearRestartLoopIfSet,
};
