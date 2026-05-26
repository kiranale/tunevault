/**
 * db/email-log.js — append-only audit log of every outbound email.
 *
 * Owns: email_log table writes and reads.
 * Does NOT own: sending emails (see services/hc-completion-email.js).
 */

'use strict';

const pool = require('./index');

/**
 * Append an email send record.
 * @param {object} params
 * @param {number|null} params.userId
 * @param {string}      params.userEmail
 * @param {string}      params.template  — e.g. 'hc_completion'
 * @param {number|null} params.hcId      — health_check id if applicable
 * @param {string}      params.status    — 'sent' | 'failed' | 'suppressed'
 * @param {string|null} params.errorMessage
 * @param {string|null} params.postmarkMessageId — response message_id if any
 * @returns {Promise<number>} inserted row id
 */
async function logEmail({ userId, userEmail, template, hcId, status, errorMessage, postmarkMessageId }) {
  const result = await pool.query(
    `INSERT INTO email_log (user_id, user_email, template, hc_id, status, error_message, postmark_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId ?? null, userEmail, template, hcId ?? null, status, errorMessage ?? null, postmarkMessageId ?? null]
  );
  return result.rows[0].id;
}

/**
 * Get recent email log rows for a user (admin view).
 * @param {number} userId
 * @param {number} [limit=50]
 */
async function getEmailLogForUser(userId, limit = 50) {
  const result = await pool.query(
    `SELECT id, user_email, template, hc_id, status, error_message, postmark_message_id, sent_at
     FROM email_log
     WHERE user_id = $1
     ORDER BY sent_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = { logEmail, getEmailLogForUser };
