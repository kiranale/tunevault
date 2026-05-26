/**
 * routes/health.js — Public health probes; no auth, no rate limit.
 *
 * Owns: GET /api/health (liveness + DB latency + queue counters),
 *       GET /api/agent/health (build SHA + minimum supported agent version).
 * Does NOT own: authentication, agent long-poll, or any business logic.
 *
 * Mounted BEFORE the generalApiLimiter in server.js so health probes are
 * never throttled — agent installs and Render health checks must always pass.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/index');

const PKG_VERSION = (() => {
  try { return require('../package.json').version; } catch { return 'unknown'; }
})();

// Build SHA from Render env (set automatically on deploy) or git fallback.
const BUILD_SHA = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || 'unknown';

// Minimum agent version that the cloud currently supports.
// Bump this when a new agent release drops compatibility with old poll protocol.
const MIN_AGENT_VERSION = '6.0.0';

const HEALTH_HEADERS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

// GET /api/health — public liveness probe.
// Returns 200 { status:'ok', ... } or 503 { status:'degraded', ... } if DB unreachable.
// Called by: agent CLI on startup, Render health checker, external uptime monitors.
router.get('/health', async (req, res) => {
  res.set(HEALTH_HEADERS);

  const start = Date.now();
  let dbConnected = false;
  let dbLatencyMs = null;
  let pendingCommands = 0;
  let agentsOnline = 0;

  try {
    // Single round-trip; also fetches queue counters to save a second query.
    const queueResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM agent_command_results WHERE status = 'pending') AS pending_commands,
        (SELECT COUNT(*) FROM agent_tunnels WHERE last_heartbeat > NOW() - INTERVAL '90 seconds') AS agents_online
    `);
    dbLatencyMs = Date.now() - start;
    dbConnected = true;
    pendingCommands = parseInt(queueResult.rows[0].pending_commands, 10);
    agentsOnline = parseInt(queueResult.rows[0].agents_online, 10);
  } catch {
    dbLatencyMs = Date.now() - start;
  }

  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    version: PKG_VERSION,
    build_sha: BUILD_SHA,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    db: { connected: dbConnected, latency_ms: dbLatencyMs },
    queue: { pending_commands: pendingCommands, agents_online: agentsOnline },
    region: process.env.RENDER_REGION || 'unknown',
  });
});

// GET /api/agent/health — extended probe for agent self-upgrade gate.
// Returns build SHA + minimum supported agent version so agents can decide
// whether they need to upgrade before connecting.
// Called by: agent CLI upgrade-check path.
router.get('/agent/health', (req, res) => {
  res.set(HEALTH_HEADERS);
  res.json({
    status: 'ok',
    version: PKG_VERSION,
    build_sha: BUILD_SHA,
    min_agent_version: MIN_AGENT_VERSION,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
