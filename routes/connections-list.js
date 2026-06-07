/**
 * routes/connections-list.js — list endpoints for saved connections and health check history.
 *
 * Owns: GET /connections (→ /api/connections: user-scoped connection list with health sub-object),
 *       GET /health-checks (→ /api/health-checks: recent health check runs),
 *       GET /connections/:id/agent-status (→ live agent heartbeat + SID status),
 *       GET /connections/:id/diagnostics  (→ state-aware diagnostics for offline agent modal),
 *       POST /connections/:id/ping        (→ lightweight 10s smoke test via agent channel),
 *       POST /connections/:id/run-diagnostics (→ 6-probe diagnostic run, stores result),
 *       POST /connections/run-diagnostics-bulk (→ dispatch probes to all user connections),
 *       POST /connections/:id/self-upgrade     (→ trigger remote agent self-upgrade, SSE stream),
 *       POST /connections/bulk-upgrade         (→ trigger self-upgrade on all stale agents),
 *       PUT /connections/:id              (→ edit connection name/host/port/service_name/username/
 *                                            password/privilege_model; re-triggers diagnostics).
 *       PATCH /connections/:id           (→ edit connection name/username/password only;
 *                                            host/port/service immutable; 409 on duplicate name).
 * Does NOT own: connection creation (server.js inline), individual health check reads (server.js inline),
 *               health check execution (server.js inline), tier enforcement (middleware/tier-enforce.js),
 *               agent tunnel lifecycle (routes/agent.js), sweeper cron (server.js).
 *
 * These were moved from inline app.get() in server.js to a Router because
 * inline bare-path routes in the latter half of server.js were unreachable
 * due to Express middleware ordering (60+ app.use mounts before them).
 * Router-mounted routes are registered at mount time and bypass this issue.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/index');
const agentDb = require('../db/agent');
const healthDb = require('../db/connection-health');
const diagnoseDb = require('../db/agent-diagnose');
const restartEventsDb = require('../db/agent-restart-events');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');
const { decrypt, encrypt } = require('../crypto-utils');
const { validateBody, updateConnectionSchema, editConnectionSchema } = require('../middleware/security');
const { logActivity } = require('../db/activity-log');

const APP_URL = process.env.APP_URL || 'https://tunevault.app';

// Minimum agent version required for full functionality.
// Agents below this version report an outdated warning.
const MIN_AGENT_VERSION = '3.5.5';

// Latest proxy installer version (legacy v3/v4/v5 python-with-oracle-client agents).
// Connections running older versions show a yellow "Upgrade available" badge.
const LATEST_PROXY_VERSION = '3.20.30';

// Latest agent version (v7 series). Bump alongside install.sh VERSION on each release.
// Used to compute agent_upgrade_available for the /connections Version column.
const LATEST_AGENT_VERSION = '7.5.0';

const router = express.Router();

// ── Batch restart-count helper ────────────────────────────────────────────────
// Fetches restart counts (1h + 24h) for a list of connection IDs in one query.
// Returns a map: { connectionId → { count_1h, count_24h } }
async function getBatchRestartCounts(connIds) {
  if (!connIds || connIds.length === 0) return {};
  try {
    const result = await require('../db/index').query(
      `SELECT
         connection_id,
         COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '1 hour')::int  AS count_1h,
         COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '24 hours')::int AS count_24h
       FROM agent_restart_events
       WHERE connection_id = ANY($1::int[])
       GROUP BY connection_id`,
      [connIds]
    );
    const map = {};
    result.rows.forEach(r => { map[r.connection_id] = { count_1h: r.count_1h, count_24h: r.count_24h }; });
    return map;
  } catch (_) {
    // Table may not exist yet during migration — return empty map
    return {};
  }
}

// GET /api/connections — list saved connections (passwords never returned)
// Scoped to authenticated user: returns connections owned by the user + legacy NULL-owner connections.
// Includes a `health` sub-object per row derived from the most recent connection_health_runs row.
// Uninstalled connections are returned separately in `removed` array (30-day window, then hidden).
router.get('/connections', requireAuth, async (req, res) => {
  try {
    const _connQuery = async (withNewCols) => pool.query(
      `SELECT oc.id, oc.name, oc.host, oc.port, oc.service_name, oc.username, oc.oracle_version,
              oc.last_tested_at, oc.last_test_success, oc.last_test_message, oc.created_at,
              oc.connection_type, oc.proxy_url, oc.proxy_version, oc.server_type,
              oc.is_ebs, oc.ebs_opt_in, oc.ebs_checks_enabled,
              oc.schedule_enabled, oc.schedule_cron, oc.last_scheduled_run_at, oc.next_scheduled_run_at,
              oc.gi_os_user, oc.gi_oracle_home, oc.asm_sid,
              oc.ebs_login_url, oc.weblogic_console_url,
              ${withNewCols ? 'oc.ebs_instance_name' : 'NULL::text AS ebs_instance_name'},
              oc.proxy_key_last_used_at, oc.proxy_key_created_at,
              oc.privilege_model,
              oc.installed_at, oc.last_upgrade_at,
              oc.python_version, oc.cx_oracle_version, oc.os_id, oc.kernel_version,
              oc.install_token_issued_at,
              oc.first_heartbeat_at,
              -- install_stalled: token was issued after this deploy (column non-null),
              -- agent never phoned home, and >5 min have elapsed.
              -- Pre-deploy rows have NULL install_token_issued_at → never flagged.
              (oc.install_token_issued_at IS NOT NULL
               AND oc.first_heartbeat_at IS NULL
               AND (NOW() - oc.install_token_issued_at) > INTERVAL '5 minutes'
              ) AS install_stalled,
              oc.agent_in_restart_loop,
              oc.agent_restart_loop_reason,
              oc.agent_restart_loop_at,
              at.oracle_sids AS agent_sids,
              at.status AS agent_status,
              at.last_heartbeat AS agent_last_heartbeat,
              at.agent_version,
              at.uninstalled_at,
              EXISTS (
                SELECT 1 FROM ssh_targets st
                WHERE st.connection_id = oc.id
              ) AS has_ssh,
              ${withNewCols
                ? '(oc.apps_pwd_enc IS NOT NULL) AS has_apps_pwd, (oc.weblogic_pwd_enc IS NOT NULL) AS has_weblogic_pwd'
                : 'false AS has_apps_pwd, false AS has_weblogic_pwd'}
       FROM oracle_connections oc
       LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
       WHERE oc.user_id = $1 OR oc.user_id IS NULL
       ORDER BY oc.created_at DESC`,
      [req.user.id]
    );

    let result;
    try {
      result = await _connQuery(true);
    } catch (qErr) {
      if (qErr.code === '42703' || /column/.test(qErr.message)) {
        result = await _connQuery(false);
      } else {
        throw qErr;
      }
    }

    // Attach latest health run and latest diagnose run to each connection (single batch queries)
    const latestRunsMap = await healthDb.getLatestRunsForUser(req.user.id);
    const connIds = result.rows.map(r => r.id);
    const [diagnoseMap, restartCountsMap] = await Promise.all([
      diagnoseDb.getLatestDiagnoseRunsForConnections(connIds),
      getBatchRestartCounts(connIds),
    ]);

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const active = [];
    const removed = [];

    result.rows.forEach(row => {
      const run = latestRunsMap[row.id] || null;
      const diagnoseRun = diagnoseMap[row.id] || null;
      const isAgentV6 = row.agent_version && row.agent_version.startsWith('6');
      const agentUpgradeAvailable = isAgentV6
        ? versionLessThan(row.agent_version, LATEST_AGENT_VERSION)
        : false;
      const proxyUpgradeAvailable = row.connection_type === 'proxy'
        ? versionLessThan(row.proxy_version, LATEST_PROXY_VERSION)
        : false;
      const tokenIssuedMinutesAgo = row.install_token_issued_at
        ? Math.floor((Date.now() - new Date(row.install_token_issued_at).getTime()) / 60000)
        : null;

      const restartCounts = restartCountsMap[row.id] || { count_1h: 0, count_24h: 0 };
      const enriched = {
        ...row,
        health: healthDb.deriveHealthStatus(run),
        proxy_upgrade_available: proxyUpgradeAvailable,
        latest_proxy_version: LATEST_PROXY_VERSION,
        agent_upgrade_available: agentUpgradeAvailable,
        latest_agent_version: LATEST_AGENT_VERSION,
        latest_diagnose: diagnoseRun,
        install_stalled: row.install_stalled || false,
        install_token_issued_minutes_ago: tokenIssuedMinutesAgo,
        restart_count_1h: restartCounts.count_1h,
        restart_count_24h: restartCounts.count_24h,
      };

      // Route to removed[] if tunnel is uninstalled and within 30-day window.
      // Expired removals (>30d) are silently dropped from both lists.
      if (row.agent_status === 'uninstalled') {
        const uninstalledAt = row.uninstalled_at ? new Date(row.uninstalled_at) : null;
        const expiredWindow = uninstalledAt && (Date.now() - uninstalledAt.getTime()) > THIRTY_DAYS_MS;
        if (!expiredWindow) {
          removed.push(enriched);
        }
      } else {
        active.push(enriched);
      }
    });

    // Legacy flat response for existing callers: active rows first, removed appended with flag.
    // New callers can filter by removed_connection: true.
    const rows = [
      ...active,
      ...removed.map(r => ({ ...r, removed_connection: true })),
    ];

    res.json(rows);
  } catch (err) {
    console.error('Error listing connections:', err);
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

// GET /api/health-checks — list recent health check runs
// Scoped to authenticated user: returns checks owned by the user + legacy NULL-owner checks.
router.get('/health-checks', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, connection_name, username, is_demo, status, overall_score, created_at, completed_at, connection_id
       FROM health_checks WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing health checks:', err);
    res.status(500).json({ error: 'Failed to list health checks' });
  }
});

// GET /api/connections/check-name?name=X — lightweight duplicate name check for wizard UX.
// Returns { available: true } if the name is free for this user, or { available: false } with
// the existing connection id if a duplicate exists.
router.get('/connections/check-name', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name query parameter is required' });
  }
  try {
    const result = await pool.query(
      `SELECT id FROM oracle_connections WHERE user_id = $1 AND name = $2 LIMIT 1`,
      [req.user.id, name.trim()]
    );
    if (result.rows.length > 0) {
      res.json({ available: false, existing_id: result.rows[0].id });
    } else {
      res.json({ available: true });
    }
  } catch (err) {
    console.error('[connections-list] check-name error:', err.message);
    res.status(500).json({ error: 'Failed to check connection name' });
  }
});

// GET /api/connections/:id/agent-status
// Returns live registration + heartbeat status for an agent (proxy) connection.
// Polled every 15s from the connection list card.
// status: "healthy" | "pending" | "stale" | "unregistered"
// stale = last heartbeat > 5 minutes ago.
router.get('/connections/:id/agent-status', requireAuth, async (req, res) => {
  try {
    const row = await agentDb.getAgentStatus(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (row.connection_type !== 'proxy') {
      return res.json({ registered: false, status: 'unregistered', detected_sids: [], proxy_url: null, last_heartbeat_at: null, heartbeat_age_seconds: null });
    }

    const fiveMinMs = 5 * 60 * 1000;
    const hasHeartbeat = !!(row.last_heartbeat);
    const heartbeatAge = hasHeartbeat
      ? Math.round((Date.now() - new Date(row.last_heartbeat).getTime()) / 1000)
      : null;
    const heartbeatRecent = hasHeartbeat && heartbeatAge <= 300;

    // Legacy fallback: proxy_key_last_used_at from older proxy pings (pre-tunnel)
    const proxyPingRecent = row.proxy_key_last_used_at &&
      (Date.now() - new Date(row.proxy_key_last_used_at).getTime()) <= fiveMinMs;

    const registered = !!(row.tunnel_uuid || row.tunnel_status);
    const tunnelDead = row.tunnel_status === 'uninstalled';
    const alive = heartbeatRecent || proxyPingRecent;

    let status;
    if (!registered && !hasHeartbeat && !proxyPingRecent) {
      status = 'unregistered';
    } else if (tunnelDead) {
      status = 'unregistered';
    } else if (alive) {
      status = 'healthy';
    } else if (registered && !hasHeartbeat) {
      // Agent registered (confirmed/provisioned) but no heartbeat ever received —
      // still in initial startup, not yet stale
      status = 'pending';
    } else if (registered || hasHeartbeat) {
      status = 'stale';
    } else {
      status = 'pending';
    }

    res.json({
      registered,
      last_heartbeat_at: row.last_heartbeat || null,
      heartbeat_age_seconds: heartbeatAge,
      detected_sids: row.detected_sids || [],
      proxy_url: row.proxy_url || null,
      status,
    });
  } catch (err) {
    console.error('[connections-list] agent-status error:', err.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ── Version comparison helper (semver major.minor.patch only) ────────────────
function versionLessThan(a, b) {
  // Returns true if version string a is strictly older than b.
  // Handles undefined/null by treating them as infinitely old.
  if (!a) return true;
  const parse = v => (v || '0.0.0').replace(/[^0-9.]/g, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM < bM;
  if (am !== bm) return am < bm;
  return ap < bp;
}

// GET /api/connections/:id/diagnostics
// Returns structured diagnostic state for the agent modal.
// state: "never_registered" | "registered_no_heartbeat" | "stale_heartbeat" |
//        "job_error" | "healthy_no_jobs" | "version_outdated"
// Access control: must own the connection (or NULL-owner legacy row).
router.get('/connections/:id/diagnostics', requireAuth, async (req, res) => {
  try {
    const row = await agentDb.getDiagnostics(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Ownership check: user_id is included in getDiagnostics result.
    // NULL user_id = legacy shared connection, accessible to all authed users.
    if (row.user_id && row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const fiveMinMs = 5 * 60 * 1000;
    const hasHeartbeat = !!(row.last_heartbeat);
    const heartbeatAge = hasHeartbeat
      ? Math.round((Date.now() - new Date(row.last_heartbeat).getTime()) / 1000)
      : null;
    const heartbeatRecent = hasHeartbeat && heartbeatAge <= 300;
    const proxyPingRecent = row.proxy_key_last_used_at &&
      (Date.now() - new Date(row.proxy_key_last_used_at).getTime()) <= fiveMinMs;
    const alive = heartbeatRecent || proxyPingRecent;
    const registered = !!(row.tunnel_uuid || row.tunnel_status);
    const channelConnected = await channel.isAgentConnected(parseInt(req.params.id, 10));

    // Determine diagnostic state (first matching wins — order matters)
    let state;
    if (!registered || row.tunnel_status === 'uninstalled') {
      state = 'never_registered';
    } else if (registered && !hasHeartbeat) {
      state = 'registered_no_heartbeat';
    } else if (!alive && hasHeartbeat) {
      state = 'stale_heartbeat';
    } else if (alive && versionLessThan(row.agent_version, MIN_AGENT_VERSION)) {
      state = 'version_outdated';
    } else if (alive && row.last_hc_status === 'error') {
      state = 'job_error';
    } else {
      state = 'healthy_no_jobs';
    }

    res.json({
      state,
      connection_name: row.connection_name || null,
      registered,
      channel_connected: channelConnected,
      last_heartbeat_at: row.last_heartbeat || null,
      heartbeat_age_seconds: heartbeatAge,
      agent_version: row.agent_version || null,
      min_agent_version: MIN_AGENT_VERSION,
      last_job_at: row.last_hc_at || null,
      last_job_status: row.last_hc_status || null,
      last_job_error: row.last_hc_error || null,
      detected_sids: row.detected_sids || [],
    });
  } catch (err) {
    console.error('[connections-list] diagnostics error:', err.message);
    res.status(500).json({ error: 'Diagnostics check failed' });
  }
});

// POST /api/connections/:id/ping
// Lightweight smoke test: sends a 'ping' job to the agent and returns within 10s.
// For agent connections: routes via sendToAgent → proxy /api/ping endpoint.
// Returns: { ok, agent_version, hostname, detected_sids, oracle_listener_up, sample_query_ms, roundtrip_ms }
// On timeout or agent offline: returns { ok: false, state: 'agent_unreachable' }.
router.post('/connections/:id/ping', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Fetch connection row — includes credentials and owner for access check
    const conn = await agentDb.getConnectionForPing(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    // Ownership check (NULL user_id = legacy shared row, accessible to any authed user)
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (conn.connection_type !== 'proxy') {
      // Direct connections: quick test via existing /api/connections/test endpoint logic
      // is handled client-side — ping only applies to agent (proxy) connections.
      return res.status(400).json({ error: 'Ping only supported for agent connections' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      return res.json({ ok: false, state: 'agent_unreachable', message: 'Agent not connected' });
    }

    // Decrypt password for passing to agent proxy
    let password = '';
    if (conn.encrypted_password) {
      try { password = decrypt(conn.encrypted_password); } catch (_) { /* credential not yet set */ }
    }

    const t0 = Date.now();
    let agentResp;
    try {
      agentResp = await channel.sendToAgent(connectionId, {
        method: 'POST',
        path: '/api/ping',
        body: {
          service_name: conn.service_name || '',
          username: conn.username || '',
          password,
          host: conn.host || 'localhost',
          port: conn.port || 1521,
          os_auth: !conn.username, // fall back to OS auth if no credentials yet
        },
      }, 10000); // 10s timeout
    } catch (_) {
      // Timeout or channel failure
      return res.json({ ok: false, state: 'agent_unreachable', message: 'Ping timed out after 10s' });
    }

    const roundtrip_ms = Date.now() - t0;
    const body = agentResp?.body || {};

    if (!body.ok) {
      return res.json({ ok: false, state: 'agent_unreachable', message: body.error || 'Agent returned error' });
    }

    // Agent's live detection may return stale/truncated SIDs from a cached proxy
    // process. Fall back to the tunnel record (populated by the installer's confirm
    // call) which is the authoritative source for detected SIDs.
    let sids = body.detected_sids || [];
    if (!sids.length) {
      const tunnel = await agentDb.getTunnel(connectionId);
      sids = (tunnel && tunnel.oracle_sids) || [];
    }

    res.json({
      ok: true,
      agent_version: body.agent_version,
      hostname: body.hostname,
      detected_sids: sids,
      oracle_listener_up: body.oracle_listener_up,
      sample_query_ms: body.sample_query_ms,
      roundtrip_ms,
    });
  } catch (err) {
    console.error('[connections-list] ping error:', err.message);
    res.status(500).json({ ok: false, state: 'error', message: 'Ping failed' });
  }
});

// POST /api/connections/:id/run-diagnostics
// Dispatches 6 diagnostic probes to the agent via the outbound channel.
// Returns { probes, passed, total, ran_at } for immediate rendering.
// Also stamps oracle_connections.last_diagnostics_at.
// Agent connections only. Ownership-enforced.
router.post('/connections/:id/run-diagnostics', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionForDiagnostics(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Diagnostics only supported for agent connections' });
    }

    if (!await channel.isAgentConnected(connectionId)) {
      // Probe 1 fails immediately — agent offline, rest skipped
      return res.json({
        ok: false,
        probes: [
          {
            id: 1, name: 'Agent online',
            status: 'fail',
            detail: 'Agent not connected — no active long-poll.',
            fix: 'Check `systemctl status tunevault-agent` on the host. Restart if stopped.',
          },
          { id: 2, name: 'SSH bastion hop',            status: 'skip', detail: 'Waiting for agent.', fix: null },
          { id: 3, name: 'TNS listener responds',      status: 'skip', detail: 'Waiting for agent.', fix: null },
          { id: 4, name: 'Auth + SELECT_CATALOG_ROLE', status: 'skip', detail: 'Waiting for agent.', fix: null },
          { id: 5, name: 'Sample query latency',       status: 'skip', detail: 'Waiting for agent.', fix: null },
          { id: 6, name: 'End-to-end health check',    status: 'skip', detail: 'Waiting for agent.', fix: null },
          { id: 7, name: 'Proxy version current',      status: 'skip', detail: 'Waiting for agent.', fix: null },
        ],
        passed: 0,
        total: 7,
        ran_at: new Date().toISOString(),
      });
    }

    // Decrypt credentials to forward to agent for Oracle probes
    let password = '';
    if (conn.encrypted_password) {
      try { password = decrypt(conn.encrypted_password); } catch (_) { /* credential not set */ }
    }

    // Pass empty host/port when not stored — proxy auto-detects from lsnrctl
    // instead of blindly using localhost:1521 (which fails on non-loopback listeners)
    const agentBody = {
      service_name: conn.service_name || '',
      username:     conn.username || '',
      password,
      host:         conn.host || '',
      port:         conn.port || '',
      os_auth:      !conn.username,
    };

    let agentResp;
    try {
      agentResp = await channel.sendToAgent(
        connectionId,
        { method: 'POST', path: '/api/run-diagnostics', body: agentBody },
        60000 // 60s — 7 probes, each up to ~10s
      );
    } catch (_) {
      return res.json({ ok: false, error: 'Diagnostics timed out (60s)', probes: [], passed: 0, total: 7, ran_at: new Date().toISOString() });
    }

    const result = agentResp?.body || {};

    // Stamp last_diagnostics_at and persist run for fleet health column
    agentDb.touchDiagnosticsAt(connectionId).catch(() => {});
    if (result.probes && result.probes.length) {
      healthDb.insertHealthRun({
        connectionId,
        probes: result.probes,
        passed: result.passed ?? 0,
        total:  result.total  ?? 7,
        agentVersion:  null,
        agentUptimeS:  null,
        trigger: 'manual',
      }).catch(() => {});
    }

    res.json({
      ok:     true,
      probes: result.probes  || [],
      passed: result.passed  ?? 0,
      total:  result.total   ?? 7,
      ran_at: result.ran_at  || new Date().toISOString(),
    });
  } catch (err) {
    console.error('[connections-list] run-diagnostics error:', err.message);
    res.status(500).json({ ok: false, error: 'Diagnostics failed: ' + err.message });
  }
});

// ── Helper: dispatch a single diagnostics run and store result ────────────────
// Exported for the sweeper cron to reuse.
async function runDiagnosticsForConnection(conn, triggerSource) {
  const connectionId = conn.id || conn.connection_id;
  if (!await channel.isAgentConnected(connectionId)) {
    // Probe 1 fails — agent offline; store minimal result
    await healthDb.insertHealthRun({
      connectionId,
      probes: [
        { id: 1, name: 'Agent online', status: 'fail', detail: 'Agent not connected.', ms: null },
        { id: 2, name: 'SSH bastion hop',            status: 'skip', detail: null, ms: null },
        { id: 3, name: 'TNS listener responds',      status: 'skip', detail: null, ms: null },
        { id: 4, name: 'Auth + SELECT_CATALOG_ROLE', status: 'skip', detail: null, ms: null },
        { id: 5, name: 'Sample query latency',       status: 'skip', detail: null, ms: null },
        { id: 6, name: 'End-to-end health check',    status: 'skip', detail: null, ms: null },
        { id: 7, name: 'Proxy version current',      status: 'skip', detail: null, ms: null },
      ],
      passed: 0, total: 7,
      agentVersion: null, agentUptimeS: null,
      trigger: triggerSource || 'sweeper',
    });
    return { ok: false, passed: 0, total: 7 };
  }

  let password = '';
  if (conn.encrypted_password) {
    try { password = decrypt(conn.encrypted_password); } catch (_) { /* cred missing */ }
  }

  let agentResp;
  try {
    agentResp = await channel.sendToAgent(
      connectionId,
      { method: 'POST', path: '/api/run-diagnostics', body: {
        service_name: conn.service_name || '',
        username:     conn.username || '',
        password,
        host:         conn.host || '',
        port:         conn.port || '',
        os_auth:      !conn.username,
      }},
      60000
    );
  } catch (_) {
    return { ok: false, passed: 0, total: 7, error: 'timeout' };
  }

  const result = agentResp?.body || {};
  if (result.probes && result.probes.length) {
    await healthDb.insertHealthRun({
      connectionId,
      probes: result.probes,
      passed: result.passed ?? 0,
      total:  result.total  ?? 7,
      agentVersion: null,
      agentUptimeS: null,
      trigger: triggerSource || 'sweeper',
    }).catch(() => {});
  }
  return { ok: true, passed: result.passed ?? 0, total: result.total ?? 7 };
}

// POST /api/connections/run-diagnostics-bulk
// Dispatches diagnostics to all online agent connections for this user, in parallel.
// Returns a summary: { dispatched, results: [{ connection_id, ok, passed, total }] }
// Fire-and-forget per connection — does not wait longer than 90s total.
router.post('/connections/run-diagnostics-bulk', requireAuth, async (req, res) => {
  try {
    const connsResult = await pool.query(
      `SELECT oc.id AS connection_id, oc.connection_type, oc.service_name, oc.username,
              oc.encrypted_password, oc.host, oc.port
       FROM oracle_connections oc
       WHERE (oc.user_id = $1 OR oc.user_id IS NULL)
         AND oc.connection_type = 'proxy'
       ORDER BY oc.id`,
      [req.user.id]
    );
    const conns = connsResult.rows;

    // Cap: dispatch all but don't block response beyond 90s
    const settled = await Promise.allSettled(
      conns.map(conn => runDiagnosticsForConnection(conn, 'manual'))
    );

    const results = conns.map((conn, i) => {
      const r = settled[i];
      if (r.status === 'fulfilled') {
        return { connection_id: conn.connection_id, ...r.value };
      }
      return { connection_id: conn.connection_id, ok: false, error: r.reason?.message || 'failed' };
    });

    res.json({ dispatched: conns.length, results });
  } catch (err) {
    console.error('[connections-list] bulk diagnostics error:', err.message);
    res.status(500).json({ error: 'Bulk diagnostics failed' });
  }
});

// PUT /api/connections/:id
// Updates editable connection fields: name, host, port, service_name, username,
// password (re-encrypted), privilege_model.
// Ownership-enforced. Duplicate name check excludes current connection.
// After update, triggers diagnostics in the background (non-blocking).
router.put('/connections/:id', requireAuth, validateBody(updateConnectionSchema), async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Fetch current row — ownership + existence check
    const current = await pool.query(
      `SELECT id, name, host, port, service_name, username, encrypted_password,
              privilege_model, user_id, connection_type
         FROM oracle_connections
        WHERE id = $1`,
      [connectionId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Connection not found' });
    const conn = current.rows[0];

    // NULL user_id = legacy shared row accessible to any authenticated user
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const body = req.body;

    // Duplicate name check: reject if another connection has the same name for this user
    if (body.name && body.name.trim() !== conn.name) {
      const dupe = await pool.query(
        `SELECT id FROM oracle_connections
          WHERE user_id = $1 AND name = $2 AND id != $3
          LIMIT 1`,
        [req.user.id, body.name.trim(), connectionId]
      );
      if (dupe.rows.length) {
        return res.status(409).json({ error: 'A connection with that name already exists' });
      }
    }

    // Build update fields — only update what was sent
    const updates = [];
    const params = [];
    let p = 1;

    const addField = (col, val) => { updates.push(`${col} = $${p++}`); params.push(val); };

    if (body.name        !== undefined) addField('name',            body.name.trim());
    if (body.host        !== undefined) addField('host',            body.host.trim());
    if (body.port        !== undefined) addField('port',            body.port);
    if (body.service_name !== undefined) addField('service_name',   body.service_name.trim());
    if (body.username    !== undefined) addField('username',        body.username.trim());
    if (body.password    !== undefined) addField('encrypted_password', encrypt(body.password));
    if (body.privilege_model !== undefined) addField('privilege_model', body.privilege_model);
    // EBS app-tier passwords — stored encrypted; sent to agent on each health check
    if (body.apps_pwd     !== undefined) addField('apps_pwd_enc',     body.apps_pwd     ? encrypt(body.apps_pwd)     : null);
    if (body.weblogic_pwd !== undefined) addField('weblogic_pwd_enc', body.weblogic_pwd ? encrypt(body.weblogic_pwd) : null);
    if ('ebs_instance_name' in body)     addField('ebs_instance_name', body.ebs_instance_name || null);
    addField('updated_at', new Date());

    if (updates.length <= 1) {
      // Only updated_at — no real changes sent
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(connectionId);
    await pool.query(
      `UPDATE oracle_connections SET ${updates.join(', ')} WHERE id = $${p}`,
      params
    );

    // Audit trail: before/after snapshot (passwords never logged)
    const before = {};
    const after  = {};
    ['name','host','port','service_name','username','privilege_model'].forEach(f => {
      if (body[f] !== undefined) {
        before[f] = conn[f];
        after[f]  = f === 'name' ? body[f].trim() : body[f];
      }
    });
    if (body.password !== undefined) { before.password = '***'; after.password = '***'; }

    await logActivity({
      userId:         req.user.id,
      userEmail:      req.user.email || null,
      actionType:     'settings_change',
      detail:         { action: 'connection_edit', connection_id: connectionId, before, after },
      connectionId,
      connectionName: body.name?.trim() || conn.name,
      result:         'success',
      ipAddress:      req.ip || null,
    });

    // Fire-and-forget diagnostics for agent connections after field change
    if (conn.connection_type === 'proxy') {
      setImmediate(async () => {
        try {
          const fresh = await pool.query(
            `SELECT id, connection_type, service_name, username, encrypted_password, host, port
               FROM oracle_connections WHERE id = $1`,
            [connectionId]
          );
          if (fresh.rows.length) {
            await runDiagnosticsForConnection({ ...fresh.rows[0], connection_id: connectionId }, 'edit');
          }
        } catch (_) { /* non-blocking — ignore */ }
      });
    }

    // Return updated row (no password)
    const updated = await pool.query(
      `SELECT id, name, host, port, service_name, username, privilege_model,
              connection_type, proxy_url, created_at, updated_at
         FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    res.json({ ok: true, connection: updated.rows[0] });
  } catch (err) {
    console.error('[connections-list] PUT /:id error:', err.message);
    res.status(500).json({ error: 'Failed to update connection' });
  }
});

// PATCH /api/connections/:id
// Lightweight edit: connection name + Oracle credentials (username/password).
// host/port/service_name are intentionally excluded — those define the connection
// identity and require delete + recreate to change.
// Ownership-enforced. 409 on duplicate name (excludes self). Audit trail with
// changed-field names (never values). Password is re-encrypted only when provided.
router.patch('/connections/:id', requireAuth, validateBody(editConnectionSchema), async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const current = await pool.query(
      `SELECT id, name, username, encrypted_password, user_id, connection_type
         FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Connection not found' });
    const conn = current.rows[0];

    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const body = req.body;
    const changedFields = [];

    // Duplicate name check
    if (body.name !== undefined && body.name.trim() !== conn.name) {
      const dupe = await pool.query(
        `SELECT id FROM oracle_connections WHERE user_id = $1 AND name = $2 AND id != $3 LIMIT 1`,
        [req.user.id, body.name.trim(), connectionId]
      );
      if (dupe.rows.length) {
        return res.status(409).json({ error: 'A connection with that name already exists' });
      }
      changedFields.push('name');
    }

    if (body.username !== undefined && body.username.trim() !== conn.username) {
      changedFields.push('username');
    }
    if (body.password !== undefined) {
      changedFields.push('password');
    }

    if (changedFields.length === 0 && (body.name === undefined || body.name.trim() === conn.name)) {
      return res.status(400).json({ error: 'No changes to save' });
    }

    // Build update
    const updates = ['updated_at = $1'];
    const params = [new Date()];
    let p = 2;

    if (body.name     !== undefined) { updates.push(`name = $${p++}`); params.push(body.name.trim()); }
    if (body.username !== undefined) { updates.push(`username = $${p++}`); params.push(body.username.trim()); }
    if (body.password !== undefined) { updates.push(`encrypted_password = $${p++}`); params.push(encrypt(body.password)); }

    params.push(connectionId);
    await pool.query(
      `UPDATE oracle_connections SET ${updates.join(', ')} WHERE id = $${p}`,
      params
    );

    // Audit: log which fields changed (not the values)
    await logActivity({
      userId:         req.user.id,
      userEmail:      req.user.email || null,
      actionType:     'settings_change',
      detail:         { action: 'connection_edit', connection_id: connectionId, changed_fields: changedFields },
      connectionId,
      connectionName: (body.name && body.name.trim()) || conn.name,
      result:         'success',
      ipAddress:      req.ip || null,
    });

    // Return updated row (no encrypted_password)
    const updated = await pool.query(
      `SELECT id, name, host, port, service_name, username, privilege_model,
              connection_type, created_at, updated_at
         FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    res.json({ ok: true, connection: updated.rows[0] });
  } catch (err) {
    console.error('[connections-list] PATCH /:id error:', err.message);
    res.status(500).json({ error: 'Failed to update connection' });
  }
});

// POST /api/connections/:id/self-upgrade
// Triggers a remote `tunevault-agent upgrade` via the outbound agent channel.
// Streams progress back to the browser via Server-Sent Events (SSE).
// Connection must be online. Ownership-enforced.
router.post('/connections/:id/self-upgrade', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionForDiagnostics(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Self-upgrade only supported for agent connections' });
    }
    if (!await channel.isAgentConnected(connectionId)) {
      return res.status(503).json({ ok: false, error: 'Agent not connected — cannot trigger upgrade' });
    }

    // SSE headers: flush immediately so the browser sees the stream start
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: 'start', message: 'Sending upgrade command to agent...' });

    let agentResp;
    try {
      agentResp = await channel.sendToAgent(
        connectionId,
        { method: 'POST', path: '/api/self-upgrade', body: {} },
        320000 // 320s — upgrade can take ~5min (pip download + install)
      );
    } catch (_) {
      send({ type: 'error', message: 'Upgrade timed out or agent disconnected. Check the host.' });
      return res.end();
    }

    const body = agentResp?.body || {};
    if (body.ok) {
      send({ type: 'stdout', message: body.stdout || '' });
      send({ type: 'done', ok: true, message: 'Upgrade complete. Agent restarting — wait ~15s then reload.' });
    } else {
      send({ type: 'stdout', message: body.stdout || '' });
      send({ type: 'error', message: body.error || body.stderr || 'Upgrade failed — see stdout above.' });
    }
    res.end();
  } catch (err) {
    console.error('[connections-list] self-upgrade error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Self-upgrade failed: ' + err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// POST /api/connections/bulk-upgrade
// Triggers self-upgrade on all online v6 agents that are behind LATEST_AGENT_VERSION.
// Fire-and-forget per agent (non-blocking). Returns list of dispatched connection IDs.
router.post('/connections/bulk-upgrade', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT oc.id, oc.connection_type,
              at.agent_version
       FROM oracle_connections oc
       LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
       WHERE (oc.user_id = $1 OR oc.user_id IS NULL)
         AND oc.connection_type = 'proxy'
       ORDER BY oc.id`,
      [req.user.id]
    );

    const staleAgents = result.rows.filter(row => {
      const isV6 = row.agent_version && row.agent_version.startsWith('6');
      return isV6 && versionLessThan(row.agent_version, LATEST_AGENT_VERSION);
    });

    const dispatched = [];
    const skipped = [];

    for (const row of staleAgents) {
      if (!await channel.isAgentConnected(row.id)) {
        skipped.push({ id: row.id, reason: 'offline' });
        continue;
      }
      // Fire-and-forget — don't await
      channel.sendToAgent(
        row.id,
        { method: 'POST', path: '/api/self-upgrade', body: {} },
        320000
      ).then(resp => {
        const ok = resp?.body?.ok;
        console.log(`[bulk-upgrade] conn ${row.id}: ok=${ok}`);
      }).catch(err => {
        console.warn(`[bulk-upgrade] conn ${row.id} error: ${err.message}`);
      });
      dispatched.push(row.id);
    }

    res.json({
      ok: true,
      dispatched: dispatched.length,
      dispatched_ids: dispatched,
      skipped: skipped.length,
      skipped_ids: skipped,
      latest_version: LATEST_AGENT_VERSION,
    });
  } catch (err) {
    console.error('[connections-list] bulk-upgrade error:', err.message);
    res.status(500).json({ error: 'Bulk upgrade failed' });
  }
});

// GET /api/connections/:id/diagnose/latest — latest diagnose run for a connection card
// Lets the UI poll on demand without reloading the full connections list.
router.get('/connections/:id/diagnose/latest', requireAuth, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);
    if (!connId) return res.status(400).json({ error: 'invalid connection id' });
    const run = await diagnoseDb.getLatestDiagnoseRun(connId);
    res.json({ run: run || null });
  } catch (err) {
    console.error('[connections-list] diagnose/latest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch diagnose run' });
  }
});

// PATCH /api/connections/:id/set-service — set ORACLE_SERVICE_NAME on a connection
// Triggered when user clicks a green service chip on the connection card.
// Also fires probe 5 remotely via the agent command channel.
router.patch('/connections/:id/set-service', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const { service_name } = req.body;
  if (!connId) return res.status(400).json({ error: 'invalid connection id' });
  if (!service_name || typeof service_name !== 'string') {
    return res.status(400).json({ error: 'service_name required' });
  }
  try {
    const ownerRes = await pool.query(
      'SELECT id, user_id, connection_type FROM oracle_connections WHERE id = $1',
      [connId]
    );
    if (!ownerRes.rows.length) return res.status(404).json({ error: 'Connection not found' });
    const conn = ownerRes.rows[0];
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Persist choice to oracle_connections.service_name (the canonical column)
    await pool.query(
      'UPDATE oracle_connections SET service_name = $1 WHERE id = $2',
      [service_name.trim(), connId]
    );

    // Fire a remote probe-5 re-run via the agent channel (best-effort)
    if (conn.connection_type === 'proxy' && await channel.isAgentConnected(connId)) {
      channel.sendToAgent(
        connId,
        { method: 'POST', path: '/api/set-service', body: { service_name: service_name.trim() } },
        10_000
      ).catch(() => {});  // fire-and-forget, don't block response
    }

    res.json({ ok: true, service_name: service_name.trim() });
  } catch (err) {
    console.error('[connections-list] set-service error:', err.message);
    res.status(500).json({ error: 'Failed to update service name' });
  }
});

// POST /api/connections/:id/reissue-install-token
// Invalidates all pending (unused) tokens for this connection and issues a fresh one.
// Returns { token, install_cmd } so the UI can show the updated one-liner immediately.
// Ownership-enforced. Agent connections only.
router.post('/connections/:id/reissue-install-token', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Fetch connection to verify ownership and type
    const connRes = await pool.query(
      `SELECT id, name, user_id, connection_type, proxy_api_key_enc, server_type, ebs_context_file
         FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    if (!connRes.rows.length) return res.status(404).json({ error: 'Connection not found' });
    const conn = connRes.rows[0];

    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Re-issue only supported for agent connections' });
    }

    // Invalidate all unused pending tokens for this connection
    await pool.query(
      `UPDATE agent_reg_tokens
       SET expires_at = NOW() - INTERVAL '1 second'
       WHERE connection_id = $1 AND used = FALSE`,
      [connectionId]
    );

    // Issue fresh token (30-min TTL)
    const newToken = crypto.randomBytes(32).toString('hex');
    await agentDb.createRegToken({ token: newToken, connectionId, userId: req.user.id });

    const isAppsServer = conn.server_type === 'apps' || conn.server_type === 'both';
    const ctxFile = conn.ebs_context_file || '';
    let installCmd;
    if (isAppsServer) {
      installCmd = `curl -fsSL ${APP_URL}/install.sh | sudo` +
        ` TUNEVAULT_TOKEN=${newToken}` +
        ` TUNEVAULT_API=${APP_URL}` +
        ` TUNEVAULT_SERVER_TYPE=${conn.server_type}` +
        (ctxFile ? ` TUNEVAULT_EBS_CONTEXT_FILE=${ctxFile}` : '') +
        ` bash`;
    } else {
      installCmd = `curl -fsSL ${APP_URL}/install.sh | sudo TUNEVAULT_TOKEN=${newToken} TUNEVAULT_API=${APP_URL} bash`;
    }
    res.json({ ok: true, token: newToken, install_cmd: installCmd });
  } catch (err) {
    console.error('[connections-list] reissue-install-token error:', err.message);
    res.status(500).json({ error: 'Failed to re-issue install token' });
  }
});

module.exports = router;
module.exports.runDiagnosticsForConnection = runDiagnosticsForConnection;
