/**
 * db/email-drip.js — query functions for the email drip sequence.
 *
 * Owns: email_drip_state reads and writes.
 * Does NOT own: sending emails, cron scheduling, or suppression business logic.
 */

const pool = require('./index');

/**
 * Returns users eligible for step 1 (signup +0h immediate):
 * - Signed up but have no step-1 drip record yet
 * - Not suppressed
 */
async function getUsersForStep1() {
  const result = await pool.query(`
    SELECT u.id, u.email, u.name, u.created_at
    FROM users u
    WHERE u.email IS NOT NULL
      AND u.email NOT LIKE '%@example.com'
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state eds
        WHERE eds.user_id = u.id AND eds.sequence_step = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state eds2
        WHERE eds2.user_id = u.id AND eds2.suppressed_at IS NOT NULL
      )
    ORDER BY u.created_at DESC
    LIMIT 100
  `);
  return result.rows;
}

/**
 * Returns users eligible for step 2 (signup +24h, no DB connected):
 * - Signed up > 24h ago
 * - Step 1 was sent
 * - No DB connection ever created
 * - No step-2 drip record yet
 * - Not suppressed
 */
async function getUsersForStep2() {
  const result = await pool.query(`
    SELECT u.id, u.email, u.name, u.created_at
    FROM users u
    INNER JOIN email_drip_state eds1
      ON eds1.user_id = u.id AND eds1.sequence_step = 1 AND eds1.sent_at IS NOT NULL
    WHERE u.created_at < NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM oracle_connections oc WHERE oc.user_id = u.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state eds2
        WHERE eds2.user_id = u.id AND eds2.sequence_step = 2
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state sup
        WHERE sup.user_id = u.id AND sup.suppressed_at IS NOT NULL
      )
    ORDER BY u.created_at DESC
    LIMIT 100
  `);
  return result.rows;
}

/**
 * Returns users eligible for step 3 (signup +72h, no check ever run):
 * - Signed up > 72h ago
 * - Step 2 was sent
 * - No real (non-demo) health check ever completed
 * - No step-3 drip record yet
 * - Not suppressed
 */
async function getUsersForStep3() {
  const result = await pool.query(`
    SELECT u.id, u.email, u.name, u.created_at
    FROM users u
    INNER JOIN email_drip_state eds2
      ON eds2.user_id = u.id AND eds2.sequence_step = 2 AND eds2.sent_at IS NOT NULL
    WHERE u.created_at < NOW() - INTERVAL '72 hours'
      AND NOT EXISTS (
        SELECT 1 FROM health_checks hc
        WHERE hc.user_id = u.id
          AND hc.is_demo = false
          AND hc.status = 'completed'
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state eds3
        WHERE eds3.user_id = u.id AND eds3.sequence_step = 3
      )
      AND NOT EXISTS (
        SELECT 1 FROM email_drip_state sup
        WHERE sup.user_id = u.id AND sup.suppressed_at IS NOT NULL
      )
    ORDER BY u.created_at DESC
    LIMIT 100
  `);
  return result.rows;
}

/**
 * Records that a drip step was sent for a user (upsert).
 */
async function markStepSent(userId, step) {
  await pool.query(`
    INSERT INTO email_drip_state (user_id, sequence_step, sent_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (user_id, sequence_step)
    DO UPDATE SET sent_at = NOW(), updated_at = NOW()
  `, [userId, step]);
}

/**
 * Suppresses all remaining drip emails for a user (e.g. after a real check runs).
 * Reason: 'check_completed' | 'unsubscribed'
 */
async function suppressUser(userId, reason) {
  // Upsert suppressions for all 3 steps (only inserts for unsent/existing)
  for (const step of [1, 2, 3]) {
    await pool.query(`
      INSERT INTO email_drip_state (user_id, sequence_step, suppressed_at, suppressed_reason, updated_at)
      VALUES ($1, $2, NOW(), $3, NOW())
      ON CONFLICT (user_id, sequence_step)
      DO UPDATE SET
        suppressed_at = COALESCE(email_drip_state.suppressed_at, NOW()),
        suppressed_reason = COALESCE(email_drip_state.suppressed_reason, $3),
        updated_at = NOW()
    `, [userId, step, reason]);
  }
}

/**
 * Checks if a user is already suppressed from all drip mail.
 */
async function isUserSuppressed(userId) {
  const result = await pool.query(`
    SELECT 1 FROM email_drip_state
    WHERE user_id = $1 AND suppressed_at IS NOT NULL
    LIMIT 1
  `, [userId]);
  return result.rows.length > 0;
}

/**
 * Returns a user by ID (for unsubscribe flow).
 */
async function getUserById(userId) {
  const result = await pool.query(
    'SELECT id, email, name FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  getUsersForStep1,
  getUsersForStep2,
  getUsersForStep3,
  markStepSent,
  suppressUser,
  isUserSuppressed,
  getUserById,
};
