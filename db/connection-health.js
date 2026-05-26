/**
 * db/connection-health.js — connection_health_runs persistence.
 *
 * Owns: connection_health_runs (one row per diagnostic run per connection).
 * Does NOT own: oracle_connections CRUD, agent_tunnels, probe execution logic.
 *
 * Health status is derived at read time from the most recent run:
 *   green  = ran_at within 15 min AND passed === total
 *   yellow = ran_at within 60 min OR only probe 5–7 failing (non-critical)
 *   red    = ran_at > 60 min ago OR probe 1–4 failing
 *   unknown= no run recorded
 */

'use strict';

const pool = require('./index');

// ── Probe names (for tooltip labels in the UI) ────────────────────────────────

const PROBE_NAMES = [
  'Agent online',
  'SSH bastion hop',
  'TNS listener responds',
  'Auth + SELECT_CATALOG_ROLE',
  'Sample query latency',
  'End-to-end health check',
  'Proxy version current',
  'Key matches cloud',
];

// ── Insert a completed diagnostic run ─────────────────────────────────────────

async function insertHealthRun({ connectionId, probes, passed, total, agentVersion, agentUptimeS, trigger }) {
  // probes = array of { id, name, status, detail, ms } (indices 1–8)
  const findProbe = (id) => probes.find(p => p.id === id) || {};
  const p1 = findProbe(1), p2 = findProbe(2), p3 = findProbe(3);
  const p4 = findProbe(4), p5 = findProbe(5), p6 = findProbe(6);
  const p7 = findProbe(7), p8 = findProbe(8);

  const result = await pool.query(
    `INSERT INTO connection_health_runs
       (connection_id, ran_at,
        probe_1_status, probe_1_ms, probe_1_detail,
        probe_2_status, probe_2_ms, probe_2_detail,
        probe_3_status, probe_3_ms, probe_3_detail,
        probe_4_status, probe_4_ms, probe_4_detail,
        probe_5_status, probe_5_ms, probe_5_detail,
        probe_6_status, probe_6_ms, probe_6_detail,
        probe_7_status, probe_7_ms, probe_7_detail,
        probe_8_status, probe_8_ms, probe_8_detail,
        passed, total, agent_version, agent_uptime_s, trigger)
     VALUES
       ($1, NOW(),
        $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22,
        $23, $24, $25,
        $26, $27, $28, $29, $30)
     RETURNING id, ran_at`,
    [
      connectionId,
      p1.status || null, p1.ms || null, p1.detail || null,
      p2.status || null, p2.ms || null, p2.detail || null,
      p3.status || null, p3.ms || null, p3.detail || null,
      p4.status || null, p4.ms || null, p4.detail || null,
      p5.status || null, p5.ms || null, p5.detail || null,
      p6.status || null, p6.ms || null, p6.detail || null,
      p7.status || null, p7.ms || null, p7.detail || null,
      p8.status || null, p8.ms || null, p8.detail || null,
      passed || 0, total || 8,
      agentVersion || null, agentUptimeS || null,
      trigger || 'manual',
    ]
  );
  return result.rows[0];
}

// ── Fetch the latest run for a single connection ──────────────────────────────

async function getLatestRunForConnection(connectionId) {
  const result = await pool.query(
    `SELECT * FROM connection_health_runs
     WHERE connection_id = $1
     ORDER BY ran_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

// ── Fetch latest run for every connection owned by a user ─────────────────────
// Returns a map: connectionId → run row (or null if never run)

async function getLatestRunsForUser(userId) {
  const result = await pool.query(
    `SELECT DISTINCT ON (chr.connection_id)
       chr.*
     FROM connection_health_runs chr
     JOIN oracle_connections oc ON oc.id = chr.connection_id
     WHERE oc.user_id = $1 OR oc.user_id IS NULL
     ORDER BY chr.connection_id, chr.ran_at DESC`,
    [userId]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.connection_id] = row;
  }
  return map;
}

// ── Derive health status from a run row ───────────────────────────────────────
// Returns: { status, score, last_checked_at, agent_uptime_s, agent_version, failing_probes }

function deriveHealthStatus(run) {
  if (!run) {
    return { status: 'unknown', score: null, last_checked_at: null, agent_uptime_s: null, agent_version: null, failing_probes: [] };
  }

  const ranAt = new Date(run.ran_at);
  const ageMs = Date.now() - ranAt.getTime();
  const fifteenMin = 15 * 60 * 1000;
  const oneHour    = 60 * 60 * 1000;

  const probes = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({
    id: i,
    name: PROBE_NAMES[i - 1],
    status: run[`probe_${i}_status`] || 'skip',
    ms: run[`probe_${i}_ms`] || null,
    detail: run[`probe_${i}_detail`] || null,
  }));

  const failing = probes.filter(p => p.status === 'fail');
  const failIds = new Set(failing.map(p => p.id));

  // Critical probes 1–4: any failure → red
  const criticalFail = [1, 2, 3, 4].some(id => failIds.has(id));

  let status;
  if (ageMs > oneHour || criticalFail) {
    status = 'red';
  } else if (ageMs <= fifteenMin && run.passed === run.total) {
    status = 'green';
  } else {
    // Within 1h, no critical failures — yellow
    status = 'yellow';
  }

  return {
    status,
    score: run.passed,
    total: run.total,
    last_checked_at: run.ran_at,
    agent_uptime_s: run.agent_uptime_s || null,
    agent_version: run.agent_version || null,
    failing_probes: failing.map(p => p.name),
    probes,
  };
}

// ── Fetch connection IDs eligible for the background sweeper ─────────────────
// Returns agent (proxy) connections that:
//   - have an active agent channel heartbeat in agent_tunnels
//   - have NOT been run in the last 4 minutes (avoid stampede on 5min cron)

async function getConnectionsForSweep() {
  const result = await pool.query(
    `SELECT oc.id AS connection_id, oc.user_id,
            oc.service_name, oc.username, oc.encrypted_password,
            oc.host, oc.port
     FROM oracle_connections oc
     JOIN agent_tunnels at ON at.connection_id = oc.id
     WHERE oc.connection_type = 'proxy'
       AND at.status = 'active'
       AND at.last_heartbeat > NOW() - INTERVAL '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM connection_health_runs chr
         WHERE chr.connection_id = oc.id
           AND chr.ran_at > NOW() - INTERVAL '4 minutes'
       )
     ORDER BY oc.id`
  );
  return result.rows;
}

// ── Prune old runs (keep last 50 per connection) ──────────────────────────────

async function pruneOldRuns() {
  await pool.query(`
    DELETE FROM connection_health_runs
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY connection_id ORDER BY ran_at DESC) AS rn
        FROM connection_health_runs
      ) ranked
      WHERE rn <= 50
    )
  `);
}

module.exports = {
  PROBE_NAMES,
  insertHealthRun,
  getLatestRunForConnection,
  getLatestRunsForUser,
  deriveHealthStatus,
  getConnectionsForSweep,
  pruneOldRuns,
};
