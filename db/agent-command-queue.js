/**
 * db/agent-command-queue.js — Postgres-backed agent command queue + channel state.
 *
 * Owns: CRUD for agent_command_queue and agent_channel_state tables.
 * Does NOT own: HTTP long-poll mechanics, response resolution (services/agent-channel.js).
 *
 * Design invariants:
 *  - enqueueCommand()      INSERT a row, returns the row id + generated request_id payload field.
 *  - claimNextCommand()    SELECT FOR UPDATE SKIP LOCKED — at-most-one delivery per poll.
 *  - completeCommand()     UPDATE status → completed|failed, writes result JSONB.
 *  - expireStaleClaimsSync() — reverts claimed rows with claim_expires_at < NOW() back to pending.
 *    Call this at the top of every poll handler so crashed workers never orphan commands.
 *  - upsertChannelState()  — records last_poll_at for observability.
 *  - getQueueDepth()       — scalar metric for Datadog observability.
 *  - getOldestPendingAgeSec() — scalar metric for Datadog 30s alert threshold.
 */

'use strict';

const pool = require('./index');
const crypto = require('crypto');

const CLAIM_TTL_MS = 60_000; // 60s — matches task spec

// ── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Enqueue a proxy-request command for an agent.
 * Returns { id, requestId } where requestId is embedded in payload for
 * round-trip correlation when the agent calls /api/agent/respond.
 *
 * @param {number} agentId
 * @param {object} requestPayload — { method, path, body, headers }
 * @returns {Promise<{ id: bigint, requestId: string }>}
 */
async function enqueueCommand(agentId, requestPayload) {
  const requestId = crypto.randomBytes(8).toString('hex');
  const payload = { ...requestPayload, request_id: requestId };

  const { rows } = await pool.query(
    `INSERT INTO agent_command_queue (agent_id, command_type, payload)
     VALUES ($1, 'proxy_request', $2)
     RETURNING id`,
    [agentId, JSON.stringify(payload)]
  );

  return { id: rows[0].id, requestId };
}

// ── Claim ─────────────────────────────────────────────────────────────────────

/**
 * Claim the next pending command for an agent.
 * Uses SELECT FOR UPDATE SKIP LOCKED so concurrent polls on multi-worker
 * deployments never double-deliver.
 *
 * Returns the row (with parsed payload) or null if queue is empty.
 *
 * @param {number} agentId
 * @param {string} claimHolder — unique label for this worker (e.g. process.pid)
 * @returns {Promise<object|null>}
 */
async function claimNextCommand(agentId, claimHolder) {
  const claimExpiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();

  const { rows } = await pool.query(
    `UPDATE agent_command_queue
     SET status = 'claimed',
         claimed_at = NOW(),
         claim_holder = $2,
         claim_expires_at = $3
     WHERE id = (
       SELECT id FROM agent_command_queue
       WHERE agent_id = $1 AND status = 'pending'
       ORDER BY enqueued_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, payload, enqueued_at`,
    [agentId, claimHolder, claimExpiresAt]
  );

  if (rows.length === 0) return null;
  return rows[0];
}

// ── Complete / Fail ───────────────────────────────────────────────────────────

/**
 * Mark a command as completed and store the result.
 *
 * @param {bigint|string} commandId
 * @param {object} result — { status_code, body }
 * @returns {Promise<void>}
 */
async function completeCommand(commandId, result) {
  await pool.query(
    `UPDATE agent_command_queue
     SET status = 'completed',
         completed_at = NOW(),
         result = $2,
         claim_expires_at = NULL
     WHERE id = $1`,
    [commandId, JSON.stringify(result)]
  );
}

/**
 * Mark a command as failed.
 *
 * @param {bigint|string} commandId
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function failCommand(commandId, reason) {
  await pool.query(
    `UPDATE agent_command_queue
     SET status = 'failed',
         completed_at = NOW(),
         result = $2,
         claim_expires_at = NULL
     WHERE id = $1`,
    [commandId, JSON.stringify({ error: reason })]
  );
}

// ── Claim expiry ──────────────────────────────────────────────────────────────

/**
 * Revert stale claimed rows (claim_expires_at < NOW()) back to 'pending'.
 * Must be called at the top of every poll handler.
 * Never throws — failures are logged and swallowed so they don't break polls.
 *
 * @param {number} agentId  — scoped per-agent to minimise lock surface
 * @returns {Promise<number>} count of reverted rows
 */
async function expireStaleClaims(agentId) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE agent_command_queue
       SET status = 'pending',
           claimed_at = NULL,
           claim_holder = NULL,
           claim_expires_at = NULL
       WHERE agent_id = $1
         AND status = 'claimed'
         AND claim_expires_at < NOW()`,
      [agentId]
    );
    return rowCount || 0;
  } catch (err) {
    console.error('[agent-command-queue] expireStaleClaims error:', err.message);
    return 0;
  }
}

// ── Channel state (observability) ─────────────────────────────────────────────

/**
 * Upsert the channel state row for an agent — records last_poll_at.
 * Fire-and-forget; never throws.
 *
 * @param {number} agentId
 */
async function upsertChannelState(agentId) {
  try {
    await pool.query(
      `INSERT INTO agent_channel_state (agent_id, last_poll_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (agent_id) DO UPDATE
         SET last_poll_at = NOW(),
             updated_at   = NOW()`,
      [agentId]
    );
  } catch (err) {
    console.error('[agent-command-queue] upsertChannelState error:', err.message);
  }
}

// ── Observability metrics ─────────────────────────────────────────────────────

/**
 * Total pending commands across all agents.
 * Used by Datadog metric pg_agent_queue_depth.
 *
 * @returns {Promise<number>}
 */
async function getQueueDepth() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM agent_command_queue WHERE status = 'pending'`
  );
  return parseInt(rows[0].n, 10);
}

/**
 * Age in seconds of the oldest pending command, or 0 if queue is empty.
 * Used by Datadog metric pg_agent_queue_oldest_pending_seconds (alert >30s).
 *
 * @returns {Promise<number>}
 */
async function getOldestPendingAgeSec() {
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(enqueued_at))) AS age_sec
     FROM agent_command_queue
     WHERE status = 'pending'`
  );
  const age = parseFloat(rows[0].age_sec);
  return isNaN(age) ? 0 : Math.round(age);
}

// ── Lookup by request_id ──────────────────────────────────────────────────────

/**
 * Find a completed/failed command by its embedded request_id (for deliverResult).
 * The request_id is stored inside the payload JSONB field.
 *
 * @param {string} requestId
 * @param {number} agentId
 * @returns {Promise<object|null>}
 */
async function findByRequestId(requestId, agentId) {
  const { rows } = await pool.query(
    `SELECT id, status, result FROM agent_command_queue
     WHERE agent_id = $1
       AND payload->>'request_id' = $2
     ORDER BY enqueued_at DESC
     LIMIT 1`,
    [agentId, requestId]
  );
  return rows[0] || null;
}

// ── NOTIFY helpers (pg LISTEN/NOTIFY signaling, not business SQL) ─────────────

/**
 * Fire pg_notify on the agent's command channel so a waiting poll wakes up.
 *
 * @param {number} agentId
 * @param {string} payload
 */
async function notifyAgentCmd(agentId, payload) {
  await pool.query('SELECT pg_notify($1, $2)', [
    `agent_cmd:${agentId}`,
    payload,
  ]);
}

/**
 * Fire pg_notify on the result channel so a waiting sendToAgent() resolves.
 *
 * @param {string} requestId
 * @param {string} payload  — JSON-stringified result
 */
async function notifyAgentResult(requestId, payload) {
  // pg_notify has 8KB limit — only send requestId as signal, result is in DB
  const notifyPayload = JSON.stringify({ request_id: requestId, ok: true });
  await pool.query('SELECT pg_notify($1, $2)', [
    `agent_result:${requestId}`,
    notifyPayload,
  ]);
}

/**
 * Check if an agent polled recently (last_poll_at within last 30s).
 *
 * @param {number} agentId
 * @returns {Promise<boolean>}
 */
async function isRecentlyPolled(agentId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM agent_channel_state
     WHERE agent_id = $1 AND last_poll_at > NOW() - INTERVAL '30 seconds'
     LIMIT 1`,
    [agentId]
  );
  return rows.length > 0;
}

module.exports = {
  enqueueCommand,
  claimNextCommand,
  completeCommand,
  failCommand,
  expireStaleClaims,
  upsertChannelState,
  getQueueDepth,
  getOldestPendingAgeSec,
  findByRequestId,
  notifyAgentCmd,
  notifyAgentResult,
  getCompletedResult,
  isRecentlyPolled,
};

async function getCompletedResult(requestId) {
  const r = await pool.query(
    `SELECT result FROM agent_command_queue 
     WHERE payload->>'request_id' = $1 
     AND status = 'completed' 
     ORDER BY completed_at DESC LIMIT 1`,
    [requestId]
  );
  return r.rows[0]?.result || null;
}
