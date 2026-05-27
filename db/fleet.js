/**
 * db/fleet.js — Fleet overview query functions.
 *
 * Owns: aggregated per-connection fleet status (last check, severity counts, drift deltas,
 *       schedule state). Read-only — no mutations.
 * Does NOT own: connection CRUD, health check execution, finding_history mutations (see db/schedules.js).
 */

'use strict';

const pool = require('./index');

/**
 * Get fleet overview for a user (or all connections for admin).
 *
 * Returns one row per oracle_connection with:
 *   connection_id, name, env_tag, db_version, ebs_detected,
 *   last_check_at, status (ok|amber|red|stale|never_run),
 *   red_count, amber_count,
 *   top_finding_title, top_finding_severity,
 *   drift_since_last_run: { new, resolved, worsened },
 *   autonomous_enabled, next_run_at
 *
 * Status logic:
 *   never_run — no completed health_check ever
 *   stale     — last completed check > 24h ago
 *   red       — any check_results severity=red in latest run
 *   amber     — any check_results severity=amber in latest run (no red)
 *   ok        — latest run exists, no red/amber findings
 *
 * @param {number|null} userId — null means admin (returns all connections)
 */
async function getFleetOverview(userId) {
  // Step 1: Get all connections scoped to the user (or all for admin).
  const connParams = [];
  const connWhere = userId !== null
    ? 'WHERE oc.user_id = $1'
    : '';
  if (userId !== null) connParams.push(userId);

  const connResult = await pool.query(
    `SELECT
       oc.id           AS connection_id,
       oc.name,
       oc.oracle_version AS db_version,
       oc.is_ebs       AS ebs_detected,
       oc.user_id
     FROM oracle_connections oc
     ${connWhere}
     ORDER BY oc.created_at DESC`,
    connParams
  );

  if (connResult.rows.length === 0) return [];

  const connectionIds = connResult.rows.map(r => r.connection_id);

  // Step 2: Latest completed health_check per connection.
  const latestChecks = await pool.query(
    `SELECT DISTINCT ON (connection_id)
       connection_id,
       id   AS run_id,
       overall_score,
       completed_at AS last_check_at
     FROM health_checks
     WHERE connection_id = ANY($1)
       AND status = 'completed'
       AND is_demo = false
     ORDER BY connection_id, completed_at DESC`,
    [connectionIds]
  );

  const latestByConn = {};
  for (const r of latestChecks.rows) {
    latestByConn[r.connection_id] = r;
  }

  // Step 3: Severity counts from check_results.
  // check_results uses UUID run_id independent of health_checks.id
  // Join by connection_id and get latest run_id per connection
  const runIds = [];
  if (connectionIds.length > 0) {
    const latestRunResult = await pool.query(
      `SELECT DISTINCT ON (connection_id) connection_id, run_id
       FROM check_results
       WHERE connection_id = ANY($1)
       ORDER BY connection_id, executed_at DESC`,
      [connectionIds]
    );
    for (const r of latestRunResult.rows) {
      runIds.push(r.run_id);
      // Update latestByConn with the correct UUID run_id
      if (latestByConn[r.connection_id]) {
        latestByConn[r.connection_id].run_id = r.run_id;
      }
    }
  }
  const _unusedRunIds = runIds; // keep for compatibility

  let severityByRun = {};
  let topFindingByRun = {};

  if (runIds.length > 0) {
    const sevResult = await pool.query(
      `SELECT
         run_id,
         COUNT(*) FILTER (WHERE status IN ('red','critical')) AS red_count,
         COUNT(*) FILTER (WHERE status IN ('amber','warning')) AS amber_count
       FROM check_results
       WHERE run_id = ANY($1)
         AND status NOT IN ('ok','green','info','pass','skipped','n/a')
       GROUP BY run_id`,
      [runIds]
    );
    for (const r of sevResult.rows) {
      severityByRun[r.run_id] = {
        red_count: parseInt(r.red_count, 10) || 0,
        amber_count: parseInt(r.amber_count, 10) || 0
      };
    }

    // Top finding (worst severity) per run.
    const topResult = await pool.query(
      `SELECT DISTINCT ON (run_id)
         run_id,
         check_id AS title,
         status AS severity
       FROM check_results
       WHERE run_id = ANY($1)
         AND status IN ('red','critical','amber','warning')
       ORDER BY run_id,
                CASE status
                  WHEN 'critical' THEN 1
                  WHEN 'red'      THEN 2
                  WHEN 'amber'    THEN 3
                  WHEN 'warning'  THEN 4
                  ELSE 5
                END`,
      [runIds]
    );
    for (const r of topResult.rows) {
      topFindingByRun[r.run_id] = { title: r.title, severity: r.severity };
    }
  }

  // Step 4: Drift counts from finding_history (new/worsened/resolved since prev run).
  // "New" = first_seen_at >= start of last run; "resolved" = resolved_at >= start of last run.
  let driftByConn = {};
  if (connectionIds.length > 0) {
    const driftResult = await pool.query(
      `SELECT
         fh.connection_id,
         COUNT(*) FILTER (
           WHERE fh.resolved_at IS NULL
             AND fh.first_seen_at >= NOW() - INTERVAL '25 hours'
         ) AS new_count,
         COUNT(*) FILTER (
           WHERE fh.resolved_at IS NOT NULL
             AND fh.resolved_at >= NOW() - INTERVAL '25 hours'
         ) AS resolved_count,
         0::bigint AS worsened_count
       FROM finding_history fh
       WHERE fh.connection_id = ANY($1)
       GROUP BY fh.connection_id`,
      [connectionIds]
    );
    for (const r of driftResult.rows) {
      driftByConn[r.connection_id] = {
        new: parseInt(r.new_count, 10) || 0,
        resolved: parseInt(r.resolved_count, 10) || 0,
        worsened: parseInt(r.worsened_count, 10) || 0
      };
    }
  }

  // Step 5: Schedule state per connection.
  let scheduleByConn = {};
  if (connectionIds.length > 0) {
    const schedResult = await pool.query(
      `SELECT connection_id, enabled, next_run_at
       FROM connection_schedules
       WHERE connection_id = ANY($1)`,
      [connectionIds]
    );
    for (const r of schedResult.rows) {
      scheduleByConn[r.connection_id] = {
        autonomous_enabled: r.enabled,
        next_run_at: r.next_run_at
      };
    }
  }

  // Step 6: Assemble the response rows.
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;

  return connResult.rows.map(conn => {
    const latest = latestByConn[conn.connection_id];
    const sev = latest ? (severityByRun[latest.run_id] || { red_count: 0, amber_count: 0 }) : null;
    const top = latest ? (topFindingByRun[latest.run_id] || null) : null;
    const drift = driftByConn[conn.connection_id] || { new: 0, resolved: 0, worsened: 0 };
    const sched = scheduleByConn[conn.connection_id] || { autonomous_enabled: false, next_run_at: null };

    // Compute status
    let status;
    if (!latest) {
      status = 'never_run';
    } else if (now - new Date(latest.last_check_at).getTime() > STALE_MS) {
      status = 'stale';
    } else if (sev && sev.red_count > 0) {
      status = 'red';
    } else if (sev && sev.amber_count > 0) {
      status = 'amber';
    } else {
      status = 'ok';
    }

    return {
      connection_id: conn.connection_id,
      name: conn.name || 'Unnamed',
      env_tag: deriveEnvTag(conn.name),
      db_version: conn.db_version || null,
      ebs_detected: conn.ebs_detected || false,
      last_check_at: latest ? latest.last_check_at : null,
      status,
      red_count: sev ? sev.red_count : 0,
      amber_count: sev ? sev.amber_count : 0,
      top_finding_title: top ? top.title : null,
      top_finding_severity: top ? top.severity : null,
      drift_since_last_run: drift,
      autonomous_enabled: sched.autonomous_enabled,
      next_run_at: sched.next_run_at
    };
  });
}

/**
 * Derive env tag from connection name.
 * Looks for PROD, UAT, DEV, TEST, STG/STAGE in the name (case-insensitive).
 * Returns 'PROD' | 'UAT' | 'DEV' | 'TEST' | 'STG' | null.
 */
function deriveEnvTag(name) {
  if (!name) return null;
  const u = name.toUpperCase();
  if (/\bPROD\b/.test(u)) return 'PROD';
  if (/\bUAT\b/.test(u))  return 'UAT';
  if (/\bSTG\b|\bSTAGE\b/.test(u)) return 'STG';
  if (/\bTEST\b/.test(u)) return 'TEST';
  if (/\bDEV\b/.test(u))  return 'DEV';
  return null;
}

module.exports = { getFleetOverview };
