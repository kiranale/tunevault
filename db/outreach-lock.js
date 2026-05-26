/**
 * db/outreach-lock.js
 *
 * Owns: All DB queries for outreach_attempts (hard-lock audit log).
 * Does NOT own: outreach_batches, outreach_recipients, outreach_send_log — those live in db/outreach.js.
 */

const pool = require('./index');

/**
 * Log every outreach send attempt — blocked or allowed.
 * Called by the hard-lock guard in services/outreach-mailer BEFORE Postmark is touched.
 */
async function logOutreachAttempt({
  attemptedTo,
  attemptedSubject,
  attemptedBy,
  blocked,
  unlockTokenPresent,
  blockedReason,
  metadata,
}) {
  const r = await pool.query(
    `INSERT INTO outreach_attempts
       (attempted_to, attempted_subject, attempted_by, blocked, unlock_token_present, blocked_reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      attemptedTo || null,
      attemptedSubject || null,
      attemptedBy || 'unknown',
      blocked,
      unlockTokenPresent || false,
      blockedReason || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
  return r.rows[0].id;
}

/**
 * Get the most recent N outreach attempts (newest first).
 */
async function getRecentAttempts(limit = 50) {
  const r = await pool.query(
    `SELECT * FROM outreach_attempts ORDER BY attempted_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/**
 * Count attempts in the last 24 hours (blocked vs allowed).
 */
async function getAttemptStats() {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE blocked = true)  AS blocked_count,
       COUNT(*) FILTER (WHERE blocked = false) AS allowed_count,
       COUNT(*) AS total_count,
       MAX(attempted_at) AS last_attempt_at
     FROM outreach_attempts
     WHERE attempted_at > NOW() - INTERVAL '24 hours'`
  );
  return r.rows[0];
}

module.exports = {
  logOutreachAttempt,
  getRecentAttempts,
  getAttemptStats,
};
