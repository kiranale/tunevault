'use strict';

/**
 * db/manager.js — Manager / SDM executive dashboard queries.
 *
 * Owns: fleet-summary aggregation, MTTR trend series, change-calendar events,
 *       audit-log summary, per-instance breakdown, weekly-status data assembly.
 * Does NOT own: health check execution, finding mutations, PDF rendering
 *               (those live in pdf-generator.js + routes/manager.js).
 */

const pool = require('./index');

// ─── Manager roles allowed to view this dashboard ────────────────────────────
const MANAGER_ROLES = new Set(['manager', 'sdm', 'admin']);

/**
 * Resolve the set of oracle_connection IDs visible to a user.
 * Admins see everything; everyone else sees their own + team connections.
 *
 * @param {number} userId
 * @param {boolean} isAdmin
 * @returns {Promise<number[]>}
 */
async function resolveConnectionIds(userId, isAdmin) {
  if (isAdmin) {
    const { rows } = await pool.query(
      `SELECT id FROM oracle_connections ORDER BY created_at DESC`
    );
    return rows.map(r => r.id);
  }

  // User's own connections + connections belonging to teammates in the same team
  const { rows } = await pool.query(
    `SELECT DISTINCT oc.id
     FROM oracle_connections oc
     WHERE oc.user_id = $1
        OR oc.user_id IN (
          SELECT tm.user_id
          FROM team_members tm
          WHERE tm.team_id IN (
            SELECT team_id FROM team_members WHERE user_id = $1
          )
        )
     ORDER BY oc.id DESC`,
    [userId]
  );
  return rows.map(r => r.id);
}

/**
 * Fleet-wide health summary.
 *
 * Returns:
 *   fleet_score       — weighted average overall_score across latest runs (null if no data)
 *   total_instances   — number of oracle_connections visible
 *   instances_with_data — how many have ≥1 completed health check
 *   critical_count    — open findings with severity in (red,critical)
 *   high_count        — open findings with severity in (amber,warning,high)
 *   medium_count      — open findings with severity in (info,medium)
 *   low_count         — open findings with severity = low
 *   stale_count       — instances where last check > 24 h ago
 *
 * @param {number} userId
 * @param {boolean} isAdmin
 */
async function getFleetSummary(userId, isAdmin) {
  const connectionIds = await resolveConnectionIds(userId, isAdmin);
  if (connectionIds.length === 0) {
    return {
      fleet_score: null,
      total_instances: 0,
      instances_with_data: 0,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      low_count: 0,
      stale_count: 0,
      per_instance: [],
    };
  }

  // Latest completed run per connection
  const { rows: latestRuns } = await pool.query(
    `SELECT DISTINCT ON (connection_id)
       connection_id,
       id            AS run_id,
       overall_score,
       completed_at
     FROM health_checks
     WHERE connection_id = ANY($1)
       AND status = 'completed'
       AND is_demo = false
     ORDER BY connection_id, completed_at DESC`,
    [connectionIds]
  );

  const runIds     = latestRuns.map(r => r.run_id).filter(Boolean);
  const latestMap  = {};
  for (const r of latestRuns) latestMap[r.connection_id] = r;

  // Severity counts from check_results
  let severityMap = {};
  if (runIds.length > 0) {
    const { rows: sevRows } = await pool.query(
      `SELECT
         run_id,
         COUNT(*) FILTER (WHERE status IN ('red','critical'))          AS critical,
         COUNT(*) FILTER (WHERE status IN ('amber','warning','high'))   AS high,
         COUNT(*) FILTER (WHERE status IN ('info','medium'))            AS medium,
         COUNT(*) FILTER (WHERE status = 'low')                        AS low
       FROM check_results
       WHERE run_id = ANY($1)
       GROUP BY run_id`,
      [runIds]
    );
    for (const r of sevRows) {
      severityMap[r.run_id] = {
        critical: parseInt(r.critical, 10) || 0,
        high:     parseInt(r.high,     10) || 0,
        medium:   parseInt(r.medium,   10) || 0,
        low:      parseInt(r.low,      10) || 0,
      };
    }
  }

  // Connection names
  const { rows: connRows } = await pool.query(
    `SELECT id, name FROM oracle_connections WHERE id = ANY($1)`,
    [connectionIds]
  );
  const nameMap = {};
  for (const r of connRows) nameMap[r.id] = r.name || 'Unnamed';

  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;

  let totalScore = 0;
  let scoreCount = 0;
  let staleCount = 0;
  let criticalTotal = 0, highTotal = 0, mediumTotal = 0, lowTotal = 0;

  const perInstance = connectionIds.map(cid => {
    const latest = latestMap[cid];
    const sev    = latest ? (severityMap[latest.run_id] || { critical: 0, high: 0, medium: 0, low: 0 }) : null;
    const stale  = latest ? (now - new Date(latest.completed_at).getTime() > STALE_MS) : true;

    if (stale) staleCount++;
    if (sev) {
      criticalTotal += sev.critical;
      highTotal     += sev.high;
      mediumTotal   += sev.medium;
      lowTotal      += sev.low;
    }
    if (latest && latest.overall_score != null) {
      totalScore += latest.overall_score;
      scoreCount++;
    }

    let status = 'never_run';
    if (latest) {
      if (stale) status = 'stale';
      else if (sev && sev.critical > 0) status = 'red';
      else if (sev && sev.high > 0)     status = 'amber';
      else status = 'ok';
    }

    return {
      connection_id:   cid,
      name:            nameMap[cid] || 'Unnamed',
      last_check_at:   latest ? latest.completed_at : null,
      score:           latest ? latest.overall_score : null,
      status,
      critical_count:  sev ? sev.critical : 0,
      high_count:      sev ? sev.high     : 0,
    };
  });

  return {
    fleet_score:         scoreCount > 0 ? Math.round(totalScore / scoreCount) : null,
    total_instances:     connectionIds.length,
    instances_with_data: latestRuns.length,
    critical_count:      criticalTotal,
    high_count:          highTotal,
    medium_count:        mediumTotal,
    low_count:           lowTotal,
    stale_count:         staleCount,
    per_instance:        perInstance,
  };
}

/**
 * MTTR trend — daily average time-to-resolution for the past N days.
 *
 * A "resolution event" is a finding_history row where resolved_at IS NOT NULL
 * and resolved_at falls within the requested window.
 * MTTR for a day = avg(resolved_at - first_seen_at) for findings resolved on that day.
 *
 * @param {number} userId
 * @param {boolean} isAdmin
 * @param {number} days   — lookback window (default 30)
 * @returns {{ series: Array<{date, mttr_hours, count}>, tracking_since: Date|null }}
 */
async function getMttrTrend(userId, isAdmin, days = 30) {
  const connectionIds = await resolveConnectionIds(userId, isAdmin);
  if (connectionIds.length === 0) {
    return { series: [], tracking_since: null };
  }

  // Earliest resolved_at across all visible connections — used for "insufficient data" UI
  const { rows: trackingRows } = await pool.query(
    `SELECT MIN(resolved_at) AS tracking_since
     FROM finding_history
     WHERE connection_id = ANY($1)
       AND resolved_at IS NOT NULL`,
    [connectionIds]
  );
  const trackingSince = trackingRows[0]?.tracking_since || null;

  const { rows } = await pool.query(
    `SELECT
       DATE_TRUNC('day', resolved_at AT TIME ZONE 'UTC') AS day,
       COUNT(*)                                           AS count,
       AVG(
         EXTRACT(EPOCH FROM (resolved_at - first_seen_at)) / 3600.0
       )                                                  AS mttr_hours
     FROM finding_history
     WHERE connection_id = ANY($1)
       AND resolved_at IS NOT NULL
       AND resolved_at >= NOW() - ($2 || ' days')::INTERVAL
     GROUP BY 1
     ORDER BY 1 ASC`,
    [connectionIds, days]
  );

  const series = rows.map(r => ({
    date:       r.day,
    mttr_hours: parseFloat(r.mttr_hours || 0).toFixed(1),
    count:      parseInt(r.count, 10),
  }));

  return { series, tracking_since: trackingSince };
}

/**
 * Change calendar — all scheduled + completed events for a calendar month.
 *
 * Sources:
 *   clone_history  → clone_completed / clone_failed / clone_running events
 *   connection_schedules → scheduled health check events (next_run_at)
 *   health_checks where completed_at in month → health_check_completed events
 *
 * @param {number} userId
 * @param {boolean} isAdmin
 * @param {string} month   — 'YYYY-MM'
 */
async function getChangeCalendar(userId, isAdmin, month) {
  const connectionIds = await resolveConnectionIds(userId, isAdmin);
  if (connectionIds.length === 0) return [];

  // Parse month → start/end
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end   = new Date(y, m, 1);

  const events = [];

  // Connection name lookup
  const { rows: connRows } = await pool.query(
    `SELECT id, name FROM oracle_connections WHERE id = ANY($1)`,
    [connectionIds]
  );
  const nameMap = {};
  for (const r of connRows) nameMap[r.id] = r.name || 'Unnamed';

  // 1. Clone history events
  const { rows: cloneRows } = await pool.query(
    `SELECT
       ch.id, ch.recipe_id, ch.source_connection_id, ch.target_connection_id,
       ch.started_by, ch.status, ch.started_at, ch.completed_at, ch.error_message,
       ch.duration_ms,
       cr.recipe_name
     FROM clone_history ch
     LEFT JOIN clone_recipes cr ON cr.id = ch.recipe_id
     WHERE ch.source_connection_id = ANY($1)
        OR ch.target_connection_id = ANY($1)
     AND ch.started_at >= $2
       AND ch.started_at < $3
     ORDER BY ch.started_at DESC`,
    [connectionIds, start, end]
  );
  for (const r of cloneRows) {
    events.push({
      id:          `clone-${r.id}`,
      type:        'clone',
      status:      r.status,
      title:       r.recipe_name ? `Clone: ${r.recipe_name}` : 'EBS Clone',
      instance:    nameMap[r.source_connection_id] || 'Unknown',
      target:      nameMap[r.target_connection_id] || null,
      date:        r.started_at,
      completed_at: r.completed_at,
      duration_ms: r.duration_ms,
      owner:       r.started_by || null,
      error:       r.error_message || null,
    });
  }

  // 2. Completed health checks in this month
  const { rows: hcRows } = await pool.query(
    `SELECT
       hc.id, hc.connection_id, hc.overall_score, hc.completed_at, hc.status
     FROM health_checks hc
     WHERE hc.connection_id = ANY($1)
       AND hc.completed_at >= $2
       AND hc.completed_at < $3
       AND hc.status = 'completed'
       AND hc.is_demo = false
     ORDER BY hc.completed_at DESC`,
    [connectionIds, start, end]
  );
  for (const r of hcRows) {
    events.push({
      id:       `hc-${r.id}`,
      type:     'health_check',
      status:   'completed',
      title:    `Health Check — score ${r.overall_score ?? '?'}`,
      instance: nameMap[r.connection_id] || 'Unknown',
      date:     r.completed_at,
    });
  }

  // 3. Upcoming scheduled runs falling in this month
  const { rows: schedRows } = await pool.query(
    `SELECT cs.connection_id, cs.next_run_at
     FROM connection_schedules cs
     WHERE cs.connection_id = ANY($1)
       AND cs.enabled = true
       AND cs.next_run_at >= $2
       AND cs.next_run_at < $3`,
    [connectionIds, start, end]
  );
  for (const r of schedRows) {
    events.push({
      id:       `sched-${r.connection_id}`,
      type:     'scheduled_check',
      status:   'scheduled',
      title:    'Scheduled Health Check',
      instance: nameMap[r.connection_id] || 'Unknown',
      date:     r.next_run_at,
    });
  }

  // Sort by date ascending
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

/**
 * Audit log summary — last N events with optional filters.
 * Thin wrapper over db/activity-log.js query, scoped to visible connections.
 *
 * @param {number}  userId
 * @param {boolean} isAdmin
 * @param {object}  opts  — { limit, offset, filterUserId, actionTypes, result, search }
 */
async function getAuditSummary(userId, isAdmin, opts = {}) {
  const { queryActivity } = require('./activity-log');
  const teamMemberIds = isAdmin ? [] : await resolveTeamMemberIds(userId);

  return queryActivity({
    viewerUserId:  userId,
    isAdmin,
    isTeamAdmin:   !isAdmin,
    teamMemberIds,
    limit:         opts.limit  || 50,
    offset:        opts.offset || 0,
    filterUserId:  opts.filterUserId || null,
    actionTypes:   opts.actionTypes  || [],
    result:        opts.result       || null,
    search:        opts.search       || null,
  });
}

/** Helper: get all user IDs in the same team as userId */
async function resolveTeamMemberIds(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT tm2.user_id
     FROM team_members tm1
     JOIN team_members tm2 ON tm2.team_id = tm1.team_id
     WHERE tm1.user_id = $1`,
    [userId]
  );
  return rows.map(r => r.user_id);
}

/**
 * Weekly status data — assembles all data needed for the weekly PDF.
 *
 * Returns:
 *   fleet_summary        — from getFleetSummary()
 *   incidents_resolved   — finding_history rows resolved in last 7 days
 *   incidents_open       — open critical/high finding_history rows
 *   changes_deployed     — clone + health check events in last 7 days
 *   top_risk_findings    — top 3 open critical findings across fleet
 *   report_date          — ISO string
 *   week_start           — ISO string
 */
async function getWeeklyStatusData(userId, isAdmin) {
  const connectionIds = await resolveConnectionIds(userId, isAdmin);

  const [fleetSummary, resolvedRows, openRows, changeRows, topRiskRows] = await Promise.all([
    getFleetSummary(userId, isAdmin),

    // Resolved this week
    connectionIds.length > 0
      ? pool.query(
          `SELECT fh.connection_id, fh.check_id, fh.title, fh.severity,
                  fh.first_seen_at, fh.resolved_at,
                  EXTRACT(EPOCH FROM (fh.resolved_at - fh.first_seen_at)) / 3600.0 AS hours_to_resolve
           FROM finding_history fh
           WHERE fh.connection_id = ANY($1)
             AND fh.resolved_at >= NOW() - INTERVAL '7 days'
           ORDER BY fh.resolved_at DESC
           LIMIT 50`,
          [connectionIds]
        )
      : Promise.resolve({ rows: [] }),

    // Open critical/high
    connectionIds.length > 0
      ? pool.query(
          `SELECT fh.connection_id, fh.check_id, fh.title, fh.severity, fh.first_seen_at
           FROM finding_history fh
           WHERE fh.connection_id = ANY($1)
             AND fh.resolved_at IS NULL
             AND fh.severity IN ('red','critical','amber','warning','high')
           ORDER BY
             CASE fh.severity WHEN 'red' THEN 1 WHEN 'critical' THEN 1
                              WHEN 'amber' THEN 2 WHEN 'warning' THEN 2
                              WHEN 'high' THEN 2 ELSE 3 END,
             fh.first_seen_at ASC
           LIMIT 100`,
          [connectionIds]
        )
      : Promise.resolve({ rows: [] }),

    // Changes in last 7 days
    connectionIds.length > 0
      ? pool.query(
          `SELECT 'clone' AS type, ch.status, ch.started_at AS date, cr.recipe_name AS label
           FROM clone_history ch
           LEFT JOIN clone_recipes cr ON cr.id = ch.recipe_id
           WHERE (ch.source_connection_id = ANY($1) OR ch.target_connection_id = ANY($1))
             AND ch.started_at >= NOW() - INTERVAL '7 days'
           ORDER BY ch.started_at DESC
           LIMIT 20`,
          [connectionIds]
        )
      : Promise.resolve({ rows: [] }),

    // Top 3 risk findings
    connectionIds.length > 0
      ? pool.query(
          `SELECT fh.title, fh.severity, fh.remediation, oc.name AS instance_name, fh.first_seen_at
           FROM finding_history fh
           JOIN oracle_connections oc ON oc.id = fh.connection_id
           WHERE fh.connection_id = ANY($1)
             AND fh.resolved_at IS NULL
             AND fh.severity IN ('red','critical')
           ORDER BY fh.first_seen_at ASC
           LIMIT 3`,
          [connectionIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);

  return {
    fleet_summary:       fleetSummary,
    incidents_resolved:  resolvedRows.rows,
    incidents_open:      openRows.rows,
    changes_deployed:    changeRows.rows,
    top_risk_findings:   topRiskRows.rows,
    report_date:         new Date().toISOString(),
    week_start:          weekStart.toISOString(),
  };
}

module.exports = {
  MANAGER_ROLES,
  resolveConnectionIds,
  getFleetSummary,
  getMttrTrend,
  getChangeCalendar,
  getAuditSummary,
  getWeeklyStatusData,
};
