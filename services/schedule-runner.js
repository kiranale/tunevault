/**
 * services/schedule-runner.js — delta logic for autonomous monitoring.
 *
 * Owns: comparing current check_results against finding_history, emitting deltas,
 *       deciding whether to send an alert, and invoking alert-mailer.
 * Does NOT own: health check execution, schedule tick timing (server.js cron),
 *               or email transport (services/alert-mailer.js).
 *
 * Called after each health check completes when the connection has an enabled schedule.
 */

'use strict';

const pool        = require('../db/index');
const schedulesDb = require('../db/schedules');
const { sendAlert } = require('./alert-mailer');
const { evaluatePoliciesForConnection } = require('./alert-policy-evaluator');

// Severity rank for worsening detection
const SEV_RANK = { ok: 0, green: 0, info: 1, amber: 2, warning: 2, red: 3, critical: 3 };
const rankOf = s => SEV_RANK[s?.toLowerCase()] ?? 0;

// Threshold: findings at or above this rank trigger alerts
const THRESHOLD_RANK = { amber: 2, red: 3 };

/**
 * Builds a stable finding_key for a check_results row.
 * For per-row checks (tablespace, etc) we use check_id + dimension.
 * For aggregate checks we just use check_id.
 */
function buildFindingKey(row) {
  const payload = row.raw_payload || {};
  // Tablespace — include the tablespace name
  if (row.check_id === 'ST01_TABLESPACE_USAGE' && payload.name) {
    return `${row.check_id}:${payload.name.toUpperCase()}`;
  }
  // Undo / Temp — include tablespace name if present
  if ((row.check_id === 'ST02_UNDO_USAGE' || row.check_id === 'ST03_TEMP_USAGE') && payload.current?.tablespace_name) {
    return `${row.check_id}:${payload.current.tablespace_name.toUpperCase()}`;
  }
  // Default: just the check_id
  return row.check_id;
}

/**
 * Derives a human-readable metric line from a check_results row.
 */
function buildMetricLine(row) {
  const payload = row.raw_payload || {};
  if (row.check_id === 'ST01_TABLESPACE_USAGE') {
    return payload.name
      ? `${payload.name} tablespace ${payload.pct_used}% full (${payload.used_gb}GB / ${payload.total_gb}GB)`
      : row.ai_summary || '';
  }
  return row.ai_summary || (row.metric_name ? `${row.metric_name}: ${row.metric_value} ${row.metric_unit || ''}`.trim() : '');
}

/**
 * runDeltaForConnection(connectionId, healthCheckId)
 *
 * Runs after a health check completes. Loads the latest check_results, compares
 * against finding_history, and sends an alert if warranted.
 *
 * Never throws — errors are logged and swallowed so HC completion isn't blocked.
 */
async function runDeltaForConnection(connectionId, healthCheckId) {
  if (!connectionId) return;

  try {
    // Check if this connection has an enabled schedule
    const schedule = await schedulesDb.getSchedule(connectionId);
    if (!schedule || !schedule.enabled) return;

    // Load current non-ok findings from this health check run
    const { rows: currentResults } = await pool.query(
      `SELECT check_id, check_category, status, metric_name, metric_value, metric_unit,
              raw_payload, ai_summary, recommendation
       FROM check_results
       WHERE connection_id = $1
         AND status IN ('amber', 'red')
       ORDER BY executed_at DESC
       LIMIT 200`,
      [connectionId]
    );

    // Deduplicate — keep the latest row per finding_key
    const latestByKey = {};
    for (const row of currentResults) {
      const key = buildFindingKey(row);
      if (!latestByKey[key]) latestByKey[key] = row;
    }

    const thresholdRank = THRESHOLD_RANK[schedule.severity_threshold] ?? THRESHOLD_RANK.amber;

    // Get existing open findings
    const existingFindings = await schedulesDb.getOpenFindings(connectionId);
    const currentKeys = Object.keys(latestByKey);

    // Process current findings — detect new / worsened
    const deltas = [];
    for (const [findingKey, row] of Object.entries(latestByKey)) {
      const severity = row.status;
      // Only process findings at or above the threshold
      if (rankOf(severity) < thresholdRank) continue;

      const { isNew, isWorsened } = await schedulesDb.upsertFinding({
        connectionId,
        scheduleId  : schedule.id,
        checkId     : row.check_id,
        findingKey,
        title       : row.ai_summary || row.check_id,
        metricLine  : buildMetricLine(row),
        remediation : row.recommendation || null,
        severity,
      });

      if (isNew) {
        deltas.push({
          deltaType  : 'new',
          checkId    : row.check_id,
          findingKey,
          title      : row.ai_summary || row.check_id,
          metricLine : buildMetricLine(row),
          remediation: row.recommendation || null,
          severity,
        });
      } else if (isWorsened) {
        deltas.push({
          deltaType  : 'worsened',
          checkId    : row.check_id,
          findingKey,
          title      : row.ai_summary || row.check_id,
          metricLine : buildMetricLine(row),
          remediation: row.recommendation || null,
          severity,
        });
      }
    }

    // Resolve findings that disappeared from this run
    await schedulesDb.resolveStaleFindings(connectionId, currentKeys);

    // No alertable deltas — done
    if (deltas.length === 0) {
      console.log(`[schedule-runner] conn ${connectionId}: no new/worsened findings above threshold`);
      return;
    }

    // Idempotency: don't re-alert within 6h window
    const recentlySent = await schedulesDb.wasAlertRecentlySent(schedule.id, 6);
    if (recentlySent) {
      console.log(`[schedule-runner] conn ${connectionId}: alert suppressed (sent within 6h window)`);
      return;
    }

    // Get connection name
    const { rows: connRows } = await pool.query(
      'SELECT name FROM oracle_connections WHERE id = $1',
      [connectionId]
    );
    const connectionName = connRows[0]?.name || `Connection ${connectionId}`;

    // Send alert
    const result = await sendAlert({
      to            : schedule.alert_email,
      connectionName,
      connectionId,
      scheduleId    : schedule.id,
      deltas,
      healthCheckId,
    });

    if (result.sent) {
      await schedulesDb.recordAlertSent(schedule.id, result.subject);
      console.log(`[schedule-runner] conn ${connectionId}: alert sent to ${schedule.alert_email} — "${result.subject}"`);
    } else {
      console.warn(`[schedule-runner] conn ${connectionId}: alert send failed — ${result.error}`);
    }

  } catch (err) {
    console.error(`[schedule-runner] delta error for conn ${connectionId}:`, err.message);
  }

  // Run alert policy evaluation — fires configured policies (email/Slack/PagerDuty/etc.)
  // This runs independently of the schedule's own alert_email logic above.
  try {
    const { rows: connRows } = await pool.query(
      'SELECT user_id FROM oracle_connections WHERE id = $1',
      [connectionId]
    );
    const userId = connRows[0]?.user_id;
    if (userId) {
      await evaluatePoliciesForConnection(userId, connectionId, healthCheckId);
    }
  } catch (err) {
    console.warn(`[schedule-runner] alert-policy evaluation error for conn ${connectionId}:`, err.message);
  }
}

module.exports = { runDeltaForConnection };
