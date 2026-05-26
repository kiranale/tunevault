/**
 * db/tuneops-notifications.js — TuneOps email notification storage.
 *
 * Owns: tuneops_notification_prefs, tuneops_notification_mutes,
 *       tuneops_notification_log tables.
 * Does NOT own: ticket data, user auth, sending the emails.
 */

'use strict';

const pool = require('./index');

// ── Preferences ──────────────────────────────────────────────────────────────

/**
 * Get prefs for a user. Returns default values if no row exists.
 */
async function getPrefs(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM tuneops_notification_prefs WHERE user_id = $1`,
    [userId]
  );
  if (rows[0]) return rows[0];
  // Default: all enabled, threshold = 'warning'
  return {
    user_id: userId,
    notifications_enabled: true,
    severity_threshold: 'warning',
  };
}

/**
 * Upsert notification prefs for a user.
 * notificationsEnabled: boolean
 * severityThreshold: 'info' | 'warning' | 'critical'
 */
async function upsertPrefs(userId, { notificationsEnabled, severityThreshold }) {
  const { rows } = await pool.query(
    `INSERT INTO tuneops_notification_prefs (user_id, notifications_enabled, severity_threshold, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET notifications_enabled = EXCLUDED.notifications_enabled,
           severity_threshold    = EXCLUDED.severity_threshold,
           updated_at            = NOW()
     RETURNING *`,
    [userId, notificationsEnabled, severityThreshold]
  );
  return rows[0];
}

// ── Mutes ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a user has an active mute on a connection.
 */
async function isConnectionMuted(userId, connectionId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tuneops_notification_mutes
     WHERE user_id = $1
       AND connection_id = $2
       AND muted_until > NOW()
     LIMIT 1`,
    [userId, connectionId]
  );
  return rows.length > 0;
}

/**
 * Mute notifications for a connection for the given number of hours (default 24).
 */
async function muteConnection(userId, connectionId, hours = 24) {
  await pool.query(
    `INSERT INTO tuneops_notification_mutes (user_id, connection_id, muted_until)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
     ON CONFLICT DO NOTHING`,
    [userId, connectionId, String(hours)]
  );
}

// ── Notification log ──────────────────────────────────────────────────────────

/**
 * Count emails sent for a specific ticket in the last hour.
 * Used for rate-limiting (max 10 per ticket per hour).
 */
async function countRecentForTicket(ticketNumber) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM tuneops_notification_log
     WHERE ticket_number = $1
       AND sent_at > NOW() - INTERVAL '1 hour'`,
    [ticketNumber]
  );
  return rows[0]?.cnt || 0;
}

/**
 * Check whether this exact (ticket, event, recipient) was already sent within
 * the dedup window (default 1 hour).
 */
async function isDuplicate(ticketNumber, eventType, recipientEmail, windowMinutes = 60) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tuneops_notification_log
     WHERE ticket_number    = $1
       AND event_type       = $2
       AND recipient_email  = $3
       AND sent_at > NOW() - ($4 || ' minutes')::interval
     LIMIT 1`,
    [ticketNumber, eventType, recipientEmail, String(windowMinutes)]
  );
  return rows.length > 0;
}

/**
 * Record a sent notification.
 */
async function logSend(ticketNumber, eventType, recipientEmail, metadata = null) {
  await pool.query(
    `INSERT INTO tuneops_notification_log (ticket_number, event_type, recipient_email, metadata)
     VALUES ($1, $2, $3, $4)`,
    [ticketNumber, eventType, recipientEmail, metadata ? JSON.stringify(metadata) : null]
  );
}

module.exports = {
  getPrefs,
  upsertPrefs,
  isConnectionMuted,
  muteConnection,
  countRecentForTicket,
  isDuplicate,
  logSend,
};
