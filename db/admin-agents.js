/**
 * db/admin-agents.js — Admin Agents Fleet read queries + log-tail store.
 *
 * Owns: agents_log_buffer CRUD; fleet-level JOIN across agent_tunnels +
 *   oracle_connections + users for the /admin/agents dashboard.
 * Does NOT own: heartbeat writes (db/agent.js), upgrade audit (db/agent-upgrade-audit.js).
 */

'use strict';

const pool = require('./index');

// ── Fleet list ────────────────────────────────────────────────────────────────

/**
 * Return all active agent rows joined with connection + owner info.
 * Excludes connections where agent_tunnels row is missing (never installed).
 */
async function listAgents() {
  const result = await pool.query(`
    SELECT
      at.id                   AS tunnel_id,
      at.connection_id,
      oc.name                 AS connection_name,
      oc.host                 AS db_host,
      oc.user_id,
      u.email                 AS owner_email,
      u.company_domain,
      oc.os_id,
      oc.kernel_version,
      oc.python_version,
      oc.proxy_version,
      oc.install_id,
      oc.installed_at,
      at.agent_version,
      at.agent_status,
      at.os_info,
      at.status               AS tunnel_status,
      at.last_heartbeat,
      at.uptime_seconds,
      at.oracle_mode,
      at.uninstalled_at,
      at.confirmed_at,
      at.created_at           AS tunnel_created_at,
      -- latest hostname from diagnose runs (if available)
      (
        SELECT adr.host
        FROM agent_diagnose_runs adr
        WHERE adr.connection_id = at.connection_id
        ORDER BY adr.created_at DESC
        LIMIT 1
      )                       AS last_diagnosed_host,
      -- connection count per owner (how many connections this user has)
      (
        SELECT COUNT(*)::int
        FROM oracle_connections oc2
        WHERE oc2.user_id = oc.user_id
      )                       AS owner_connection_count
    FROM agent_tunnels at
    JOIN oracle_connections oc ON oc.id = at.connection_id
    LEFT JOIN users u ON u.id = oc.user_id
    ORDER BY
      CASE
        WHEN at.last_heartbeat IS NULL THEN 0
        WHEN at.last_heartbeat < NOW() - INTERVAL '15 minutes' THEN 1
        WHEN at.last_heartbeat < NOW() - INTERVAL '2 minutes' THEN 2
        ELSE 3
      END ASC,
      at.last_heartbeat DESC NULLS LAST
  `);
  return result.rows;
}

// ── Stats summary ─────────────────────────────────────────────────────────────

/**
 * Return aggregate counts for the stat bar.
 * Uses the same status thresholds as the frontend pill logic.
 */
async function getAgentStats({ onlineSeconds = 120, staleSeconds = 900 } = {}) {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE last_heartbeat >= NOW() - ($1 || ' seconds')::INTERVAL
      )::int AS online,
      COUNT(*) FILTER (
        WHERE last_heartbeat >= NOW() - ($2 || ' seconds')::INTERVAL
          AND last_heartbeat < NOW() - ($1 || ' seconds')::INTERVAL
      )::int AS stale,
      COUNT(*) FILTER (
        WHERE last_heartbeat IS NULL
          OR last_heartbeat < NOW() - ($2 || ' seconds')::INTERVAL
      )::int AS offline
    FROM agent_tunnels
    WHERE status != 'uninstalled'
  `, [String(onlineSeconds), String(staleSeconds)]);
  return result.rows[0];
}

// ── Log-tail store ────────────────────────────────────────────────────────────

/**
 * Upsert last N lines of agent log for a connection.
 * Cap enforced at 500 lines by the route before calling here.
 */
async function upsertLogTail(connectionId, logLines) {
  const lineCount = (logLines || '').split('\n').filter(Boolean).length;
  await pool.query(`
    INSERT INTO agents_log_buffer (connection_id, log_lines, line_count, flushed_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (connection_id) DO UPDATE SET
      log_lines  = EXCLUDED.log_lines,
      line_count = EXCLUDED.line_count,
      flushed_at = NOW()
  `, [connectionId, logLines || '', lineCount]);
}

/**
 * Fetch log tail for a single connection.
 * Returns { log_lines, line_count, flushed_at } or null if not present.
 */
async function getLogTail(connectionId) {
  const result = await pool.query(`
    SELECT log_lines, line_count, flushed_at
    FROM agents_log_buffer
    WHERE connection_id = $1
  `, [connectionId]);
  return result.rows[0] || null;
}

module.exports = {
  listAgents,
  getAgentStats,
  upsertLogTail,
  getLogTail,
};
