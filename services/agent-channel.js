/**
 * services/agent-channel.js — Postgres-backed bidirectional channel between
 * TuneVault cloud and on-prem proxy agents.
 *
 * Owns: command enqueue, long-poll delivery, result routing, observability metrics.
 * Does NOT own: authentication (routes/agent.js), Oracle queries (oracle-proxy.py).
 *
 * Architecture (post-durability migration):
 *   sendToAgent(id, req)   → INSERT into agent_command_queue
 *                          → NOTIFY 'agent_cmd:<id>'
 *                          → LISTEN on result channel 'agent_result:<requestId>'
 *                          → resolves when deliverResult() fires NOTIFY
 *
 *   waitForWork(id)        → expireStaleClaims + SELECT FOR UPDATE SKIP LOCKED
 *                          → if empty: LISTEN 'agent_cmd:<id>' for up to 25s
 *                          → re-checks on NOTIFY or timeout
 *
 *   deliverResult()        → UPDATE agent_command_queue (status=completed, result)
 *                          → NOTIFY 'agent_result:<requestId>' so sendToAgent resolves
 *
 * Why LISTEN/NOTIFY over polling:
 *   Sub-millisecond wakeup, zero CPU burn, works on single Neon connection.
 *   Postgres is already required — zero new infra dependency.
 *
 * Durability guarantee:
 *   Every command row survives Node restarts. Agents re-poll and pick up
 *   unclaimed rows automatically. Claimed rows revert after 60s (expireStaleClaims).
 */

'use strict';

const db = require('../db/agent-command-queue');

// ── Dedicated LISTEN/NOTIFY connection ───────────────────────────────────────
// We use a separate long-lived pg client (not the pool) for LISTEN because
// a pool connection in LISTEN mode can't be returned mid-notification.

let _listenClient = null;

// Map<channel, Set<callback>> — in-process wakeup registry for LISTEN channels.
// This is not durable state — it only lives as long as the current poll is held.
// The durable state is always in Postgres.
const _listeners = new Map();

async function getListenClient() {
  if (_listenClient && !_listenClient._ending) return _listenClient;

  // Use a raw pg.Client (not Pool) for persistent LISTEN — pool connections
  // cannot stay in LISTEN mode while being returned to the pool between events.
  const { Client } = require('pg');
  _listenClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : false,
  });

  await _listenClient.connect();

  _listenClient.on('notification', (msg) => {
    const cbs = _listeners.get(msg.channel);
    if (cbs) {
      for (const cb of cbs) cb(msg.payload);
    }
  });

  _listenClient.on('error', (err) => {
    console.error('[agent-channel] LISTEN client error:', err.message);
    _listenClient = null; // will reconnect on next call
  });

  return _listenClient;
}

/**
 * Subscribe to a Postgres NOTIFY channel. Returns an unsubscribe function.
 * Ensures the underlying client is LISTENing on that channel.
 *
 * @param {string} channel
 * @param {function} cb
 * @returns {Promise<function>} unsubscribe
 */
async function subscribe(channel, cb) {
  const client = await getListenClient();
  if (!_listeners.has(channel)) {
    _listeners.set(channel, new Set());
    await client.query(`LISTEN "${channel}"`);
  }
  _listeners.get(channel).add(cb);

  return async function unsubscribe() {
    const cbs = _listeners.get(channel);
    if (!cbs) return;
    cbs.delete(cb);
    if (cbs.size === 0) {
      _listeners.delete(channel);
      try { await client.query(`UNLISTEN "${channel}"`); } catch (_) { /* ignore */ }
    }
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether an agent polled recently (within last 30s).
 * Uses agent_channel_state.last_poll_at from Postgres.
 *
 * @param {number} connectionId
 * @returns {Promise<boolean>}
 */
async function isAgentConnected(connectionId) {
  return db.isRecentlyPolled(connectionId);
}

/**
 * Send a request to a proxy agent and wait for the response.
 * Enqueues a durable command and resolves when the agent delivers the result.
 *
 * @param {number} connectionId
 * @param {object} request  — { method, path, body, headers }
 * @param {number} timeoutMs — max wait (default 120s)
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
async function sendToAgent(connectionId, request, timeoutMs = 120_000) {
  console.log('[agent-channel] sendToAgent conn=%d path=%s timeout=%d', connectionId, request.path, timeoutMs);
  // 1. Enqueue the command in Postgres and get a stable requestId
  const { requestId } = await db.enqueueCommand(connectionId, {
    method: request.method || 'POST',
    path: request.path || '/',
    body: request.body || {},
    headers: request.headers || {},
  });

  // 2. NOTIFY the agent's poll channel so waitForWork() wakes immediately
  await db.notifyAgentCmd(connectionId, requestId);

  // 3. LISTEN for the result notification, with timeout
  return new Promise(async (resolve, reject) => {
    const resultChannel = `agent_result:${requestId}`;
    let timer;
    let unsub;

    const cleanup = async (fn, arg) => {
      clearTimeout(timer);
      if (unsub) await unsub().catch(() => {});
      fn(arg);
    };

    timer = setTimeout(() => {
      cleanup(reject, new Error('Agent request timed out'));
    }, timeoutMs);

    unsub = await subscribe(resultChannel, async (payload) => {
      try {
        // pg_notify payload is just a signal — fetch actual result from DB
        const row = await db.getCompletedResult(requestId);
        if (row) {
          await cleanup(resolve, {
            statusCode: row.status_code || 200,
            body: row.body || {},
          });
        } else {
          // Fallback: try parsing payload directly (legacy path)
          const result = JSON.parse(payload);
          await cleanup(resolve, {
            statusCode: result.status_code || 200,
            body: result.body || {},
          });
        }
      } catch (e) {
        await cleanup(reject, e);
      }
    });
  });
}

/**
 * Called when a proxy agent long-polls for work.
 * Returns a work item (or null after holdSeconds).
 *
 * @param {number} connectionId
 * @param {number} holdSeconds — max hold before returning empty (default 25s)
 * @returns {Promise<object|null>}
 */
async function waitForWork(connectionId, holdSeconds = 25) {
  const workerId = `worker-${process.pid}`;

  // Revert any stale claimed rows before we try to claim one
  await db.expireStaleClaims(connectionId);

  // Record the poll time for isAgentConnected()
  await db.upsertChannelState(connectionId);

  // Emit Datadog metrics (fire-and-forget)
  emitQueueMetrics().catch(() => {});

  // Try to claim a pending command immediately
  const row = await db.claimNextCommand(connectionId, workerId);
  if (row) return row.payload; // payload already is the work item JSON

  // Nothing pending — LISTEN for up to holdSeconds
  return new Promise(async (resolve) => {
    const cmdChannel = `agent_cmd:${connectionId}`;
    let timer;
    let unsub;

    const finish = async (workItem) => {
      clearTimeout(timer);
      if (unsub) await unsub().catch(() => {});
      resolve(workItem);
    };

    timer = setTimeout(async () => {
      await finish(null);
    }, holdSeconds * 1000);

    unsub = await subscribe(cmdChannel, async (_payload) => {
      // A command was enqueued — try to claim it
      const claimed = await db.claimNextCommand(connectionId, workerId).catch(() => null);
      if (claimed) {
        await finish(claimed.payload);
      }
      // If another worker beat us (SKIP LOCKED), we stay waiting
    });
  });
}

/**
 * Called when a proxy agent submits the result for a previous request.
 * Persists the result and fires a NOTIFY so sendToAgent() resolves.
 *
 * @param {string} requestId
 * @param {number} connectionId
 * @param {object} result — { status_code, body }
 * @returns {Promise<boolean>} true if the command was found and updated
 */
async function deliverResult(requestId, connectionId, result) {
  const row = await db.findByRequestId(requestId, connectionId);
  if (!row) return false;

  await db.completeCommand(row.id, result);

  // Notify the waiting sendToAgent() in whatever worker holds the LISTEN
  await db.notifyAgentResult(requestId, JSON.stringify(result));

  return true;
}

/**
 * Cleanup when a connection is deleted or agent uninstalls.
 * No-op in the Postgres model — queued rows are cascade-deleted via FK.
 * Kept for API compatibility with callers.
 *
 * @param {number} connectionId
 */
function removeChannel(connectionId) {
  // The agent_command_queue FK ON DELETE CASCADE handles physical cleanup.
  // Nothing to do in-process — no Map to purge.
}

// ── Datadog observability metrics ─────────────────────────────────────────────

let _lastMetricEmit = 0;
const METRIC_INTERVAL_MS = 30_000;

async function emitQueueMetrics() {
  const now = Date.now();
  if (now - _lastMetricEmit < METRIC_INTERVAL_MS) return;
  _lastMetricEmit = now;

  const [depth, oldestSec] = await Promise.all([
    db.getQueueDepth(),
    db.getOldestPendingAgeSec(),
  ]);

  // Structured Datadog-compatible log lines (parsed by the log shipper)
  console.log(JSON.stringify({
    metric: 'pg_agent_queue_depth',
    value: depth,
    tags: ['service:tunevault'],
  }));
  console.log(JSON.stringify({
    metric: 'pg_agent_queue_oldest_pending_seconds',
    value: oldestSec,
    tags: ['service:tunevault'],
    alert: oldestSec > 30 ? 'warn' : 'ok',
  }));

  if (oldestSec > 30) {
    console.warn(`[agent-channel] ALERT: oldest pending command is ${oldestSec}s old`);
  }
}

module.exports = {
  isAgentConnected,
  sendToAgent,
  waitForWork,
  deliverResult,
  removeChannel,
};
