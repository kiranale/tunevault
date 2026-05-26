/**
 * db/user-preferences.js — per-user notification preferences + HC email lookup helpers.
 *
 * Owns: user_preferences table CRUD; helper query to resolve user+connection for HC emails.
 * Does NOT own: email sending logic (see services/hc-completion-email.js).
 */

'use strict';

const pool = require('./index');

/**
 * Get preferences for a user. Returns defaults if no row exists yet.
 * @param {number} userId
 * @returns {Promise<{hc_completion_email: boolean, last_hc_email_sent_at: Date|null}>}
 */
async function getPreferences(userId) {
  const result = await pool.query(
    `SELECT hc_completion_email, last_hc_email_sent_at FROM user_preferences WHERE user_id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { hc_completion_email: true, last_hc_email_sent_at: null };
  }
  return result.rows[0];
}

/**
 * Upsert hc_completion_email preference for a user.
 * @param {number} userId
 * @param {boolean} enabled
 */
async function setHcCompletionEmail(userId, enabled) {
  await pool.query(
    `INSERT INTO user_preferences (user_id, hc_completion_email, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET hc_completion_email = $2, updated_at = NOW()`,
    [userId, enabled]
  );
}

/**
 * Stamp last_hc_email_sent_at to NOW() for throttle tracking.
 * @param {number} userId
 */
async function stampHcEmailSent(userId) {
  await pool.query(
    `INSERT INTO user_preferences (user_id, last_hc_email_sent_at, updated_at)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET last_hc_email_sent_at = NOW(), updated_at = NOW()`,
    [userId]
  );
}

/**
 * Resolve the owning user for a connection, returning email/name for email sending.
 * @param {number} connectionId
 * @returns {Promise<{user_id, email, name, connection_name}|null>}
 */
async function getUserForConnection(connectionId) {
  const result = await pool.query(
    `SELECT oc.user_id, u.email, u.name, oc.connection_name
     FROM oracle_connections oc
     JOIN users u ON u.id = oc.user_id
     WHERE oc.id = $1`,
    [connectionId]
  );
  return result.rows[0] || null;
}

/**
 * Get a completed health check row for email purposes.
 * @param {number} hcId
 * @returns {Promise<{overall_score, is_demo, completed_at, connection_name, metrics}|null>}
 */
async function getHealthCheckForEmail(hcId) {
  const result = await pool.query(
    `SELECT overall_score, is_demo, completed_at, connection_name, metrics FROM health_checks WHERE id = $1`,
    [hcId]
  );
  return result.rows[0] || null;
}

module.exports = { getPreferences, setHcCompletionEmail, stampHcEmailSent, getUserForConnection, getHealthCheckForEmail };
