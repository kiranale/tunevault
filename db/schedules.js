/**
 * db/schedules.js — connection_schedules and finding_history query functions.
 *
 * Owns: connection_schedules CRUD, finding_history delta reads/writes.
 * Does NOT own: schedule execution logic, email sending (see services/alert-mailer.js),
 *               or health check results (see check_results table queries in server.js).
 */

'use strict';

const pool = require('./index');

// ── connection_schedules ──────────────────────────────────────────────────────

/**
 * Get schedule for a connection (returns null if not yet configured).
 */
async function getSchedule(connectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM connection_schedules WHERE connection_id = $1`,
    [connectionId]
  );
  return rows[0] || null;
}

/**
 * Upsert schedule config for a connection.
 * Returns the saved schedule row.
 */
async function upsertSchedule({ connectionId, userId, cadenceMinutes, enabled, alertEmail, severityThreshold }) {
  const nextRunAt = enabled
    ? new Date(Date.now() + cadenceMinutes * 60 * 1000)
    : null;

  const { rows } = await pool.query(
    `INSERT INTO connection_schedules
       (connection_id, user_id, cadence_minutes, enabled, next_run_at, alert_email, severity_threshold, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (connection_id) DO UPDATE
       SET cadence_minutes     = EXCLUDED.cadence_minutes,
           enabled             = EXCLUDED.enabled,
           next_run_at         = CASE
                                   WHEN EXCLUDED.enabled = true THEN EXCLUDED.next_run_at
                                   ELSE NULL
                                 END,
           alert_email         = EXCLUDED.alert_email,
           severity_threshold  = EXCLUDED.severity_threshold,
           updated_at          = NOW()
     RETURNING *`,
    [connectionId, userId, cadenceMinutes, enabled, nextRunAt, alertEmail, severityThreshold]
  );
  return rows[0];
}

/**
 * Find all schedule rows that are due (enabled, not snoozed, next_run_at <= now).
 */
async function getDueSchedules() {
  const { rows } = await pool.query(
    `SELECT cs.*, oc.name AS connection_name, oc.host, oc.port, oc.service_name,
            oc.username, oc.encrypted_password, oc.connection_type, oc.proxy_url,
            oc.proxy_api_key_enc, oc.user_id, oc.server_type,
            oc.apps_pwd_enc, oc.weblogic_pwd_enc
     FROM connection_schedules cs
     JOIN oracle_connections oc ON oc.id = cs.connection_id
     WHERE cs.enabled = true
       AND cs.next_run_at <= NOW()
       AND (cs.snoozed_until IS NULL OR cs.snoozed_until < NOW())`
  );
  return rows;
}

/**
 * Advance next_run_at after a successful tick.
 * Sets last_run_at = NOW() and next_run_at = NOW() + cadence.
 */
async function advanceSchedule(scheduleId, cadenceMinutes) {
  await pool.query(
    `UPDATE connection_schedules
     SET last_run_at = NOW(),
         next_run_at = NOW() + ($1 * INTERVAL '1 minute'),
         updated_at  = NOW()
     WHERE id = $2`,
    [cadenceMinutes, scheduleId]
  );
}

/**
 * Record that an alert email was sent.
 */
async function recordAlertSent(scheduleId, subject) {
  await pool.query(
    `UPDATE connection_schedules
     SET last_alert_sent_at = NOW(),
         last_alert_subject  = $1,
         updated_at          = NOW()
     WHERE id = $2`,
    [subject, scheduleId]
  );
}

/**
 * Snooze a schedule for N hours (sets enabled=false + snoozed_until).
 * Used by the "snooze" link in alert emails.
 */
async function snoozeSchedule(scheduleId, hours = 24) {
  await pool.query(
    `UPDATE connection_schedules
     SET snoozed_until = NOW() + ($1 * INTERVAL '1 hour'),
         updated_at    = NOW()
     WHERE id = $2`,
    [hours, scheduleId]
  );
}

/**
 * Snooze by signed token (token is base64url of scheduleId).
 * Returns { ok: boolean, scheduleId }.
 */
async function snoozeByToken(token, hours = 24) {
  try {
    const id = parseInt(Buffer.from(token, 'base64url').toString(), 10);
    if (!id || isNaN(id)) return { ok: false };
    await snoozeSchedule(id, hours);
    return { ok: true, scheduleId: id };
  } catch {
    return { ok: false };
  }
}

/**
 * Get all schedules with connection info — for admin page.
 */
async function getAllSchedulesAdmin() {
  const { rows } = await pool.query(
    `SELECT cs.*, oc.name AS connection_name, oc.host, u.email AS user_email
     FROM connection_schedules cs
     JOIN oracle_connections oc ON oc.id = cs.connection_id
     JOIN users u ON u.id = cs.user_id
     ORDER BY cs.updated_at DESC`
  );
  return rows;
}

// ── finding_history ───────────────────────────────────────────────────────────

/**
 * Get all open (unresolved) findings for a connection.
 * Returns map: finding_key → row
 */
async function getOpenFindings(connectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM finding_history
     WHERE connection_id = $1 AND resolved_at IS NULL`,
    [connectionId]
  );
  const map = {};
  for (const row of rows) map[row.finding_key] = row;
  return map;
}

/**
 * Upsert a finding. Returns { isNew: bool, isWorsened: bool, row }.
 * - isNew: finding_key not previously seen (or was resolved before).
 * - isWorsened: same key, severity escalated (green/amber → red).
 */
async function upsertFinding({ connectionId, scheduleId, checkId, findingKey, title, metricLine, remediation, severity }) {
  // Try to find existing open finding
  const existing = await pool.query(
    `SELECT * FROM finding_history
     WHERE connection_id = $1 AND finding_key = $2 AND resolved_at IS NULL`,
    [connectionId, findingKey]
  );

  const severityRank = { ok: 0, green: 0, info: 1, amber: 2, warning: 2, red: 3, critical: 3 };
  const rankOf = s => severityRank[s?.toLowerCase()] ?? 0;

  if (existing.rows.length === 0) {
    // New finding (or previously resolved, re-opened)
    const { rows } = await pool.query(
      `INSERT INTO finding_history
         (connection_id, schedule_id, check_id, finding_key, title, metric_line,
          remediation, severity, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (connection_id, finding_key) DO UPDATE
         SET resolved_at  = NULL,
             severity     = EXCLUDED.severity,
             title        = EXCLUDED.title,
             metric_line  = EXCLUDED.metric_line,
             remediation  = EXCLUDED.remediation,
             last_seen_at = NOW()
       RETURNING *`,
      [connectionId, scheduleId, checkId, findingKey, title, metricLine, remediation, severity]
    );
    return { isNew: true, isWorsened: false, row: rows[0] };
  }

  const prev = existing.rows[0];
  const isWorsened = rankOf(severity) > rankOf(prev.severity);

  const { rows } = await pool.query(
    `UPDATE finding_history
     SET severity     = $1,
         title        = $2,
         metric_line  = $3,
         remediation  = $4,
         last_seen_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [severity, title, metricLine, remediation, prev.id]
  );
  return { isNew: false, isWorsened, row: rows[0] };
}

/**
 * Mark findings as resolved if their finding_key is NOT in currentKeys.
 * Called at end of each delta run to clean up disappeared findings.
 */
async function resolveStaleFindings(connectionId, currentKeys) {
  if (currentKeys.length === 0) {
    // All findings resolved
    await pool.query(
      `UPDATE finding_history
       SET resolved_at = NOW()
       WHERE connection_id = $1 AND resolved_at IS NULL`,
      [connectionId]
    );
    return;
  }
  await pool.query(
    `UPDATE finding_history
     SET resolved_at = NOW()
     WHERE connection_id = $1
       AND resolved_at IS NULL
       AND finding_key NOT IN (${currentKeys.map((_, i) => `$${i + 2}`).join(',')})`,
    [connectionId, ...currentKeys]
  );
}

/**
 * Check if an alert was already sent for this (connection_id, finding_key, severity) within 6h.
 * Used for idempotency / flap suppression.
 */
async function wasAlertRecentlySent(scheduleId, windowHours = 6) {
  const { rows } = await pool.query(
    `SELECT 1 FROM connection_schedules
     WHERE id = $1
       AND last_alert_sent_at > NOW() - ($2 * INTERVAL '1 hour')`,
    [scheduleId, windowHours]
  );
  return rows.length > 0;
}

module.exports = {
  getSchedule,
  upsertSchedule,
  getDueSchedules,
  advanceSchedule,
  recordAlertSent,
  snoozeSchedule,
  snoozeByToken,
  getAllSchedulesAdmin,
  getOpenFindings,
  upsertFinding,
  resolveStaleFindings,
  wasAlertRecentlySent,
};
