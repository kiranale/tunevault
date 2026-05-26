/**
 * db/agent-command-results.js — agent_command_results + agent_crash_alerts_sent CRUD.
 *
 * Owns: one-shot command dispatch records (journalctl pulls), crash alert dedup state.
 * Does NOT own: agent tunnels, heartbeat recording, install failure logs (agent-install-failures.js).
 */

'use strict';

const pool = require('./index');

// ── agent_command_results ─────────────────────────────────────────────────────

/**
 * Create a pending command result row. Returns row with id.
 */
async function createCommandResult({ connectionId, command, requestedBy }) {
  const res = await pool.query(
    `INSERT INTO agent_command_results (connection_id, command, status, requested_by)
     VALUES ($1, $2, 'pending', $3)
     RETURNING *`,
    [connectionId, command, requestedBy || null]
  );
  return res.rows[0];
}

/**
 * Mark a command result as completed (agent responded or fallback used).
 */
async function completeCommandResult({ id, output, exitCode, errorMessage }) {
  const res = await pool.query(
    `UPDATE agent_command_results
     SET status       = CASE WHEN $2 IS NOT NULL THEN 'completed' ELSE 'error' END,
         output       = $2,
         exit_code    = $3,
         error_message = $4,
         completed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, output || null, exitCode || null, errorMessage || null]
  );
  return res.rows[0] || null;
}

/**
 * Get the latest command result for a connection (any command).
 */
async function getLatestCommandResult(connectionId) {
  const res = await pool.query(
    `SELECT * FROM agent_command_results
     WHERE connection_id = $1
     ORDER BY requested_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return res.rows[0] || null;
}

/**
 * Get the latest journalctl pull result for a connection.
 */
async function getLatestJournalctlResult(connectionId) {
  const res = await pool.query(
    `SELECT * FROM agent_command_results
     WHERE connection_id = $1
       AND command LIKE 'journalctl%'
     ORDER BY requested_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return res.rows[0] || null;
}

// ── agent_crash_alerts_sent — dedup so we only email once per incident ────────

/**
 * Returns true if a crash-loop alert was already sent for this connection
 * within the last 24 hours.
 */
async function crashAlertAlreadySent(connectionId) {
  const res = await pool.query(
    `SELECT 1 FROM agent_crash_alerts_sent
     WHERE connection_id = $1
       AND sent_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [connectionId]
  );
  return res.rows.length > 0;
}

/**
 * Upsert: record that a crash-loop alert was sent for this connection.
 */
async function recordCrashAlertSent({ connectionId, recipient, agentHealth }) {
  await pool.query(
    `INSERT INTO agent_crash_alerts_sent (connection_id, recipient, agent_health, sent_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (connection_id) DO UPDATE
       SET sent_at     = NOW(),
           recipient   = EXCLUDED.recipient,
           agent_health = EXCLUDED.agent_health`,
    [connectionId, recipient || null, agentHealth || null]
  );
}

/**
 * Clear the alert-sent flag when the agent recovers (starts heartbeating again).
 * Called from the heartbeat handler.
 */
async function clearCrashAlert(connectionId) {
  await pool.query(
    `DELETE FROM agent_crash_alerts_sent WHERE connection_id = $1`,
    [connectionId]
  );
}

module.exports = {
  createCommandResult,
  completeCommandResult,
  getLatestCommandResult,
  getLatestJournalctlResult,
  crashAlertAlreadySent,
  recordCrashAlertSent,
  clearCrashAlert,
};
