/**
 * db/roadmap-reminders.js — Query helpers for roadmap_reminders table.
 *
 * Owns: all reads and writes to roadmap_reminders.
 * Does NOT own: trigger evaluation logic (that lives in routes/roadmap-reminders.js),
 *               user auth, or any other table.
 */

'use strict';

const pool = require('./index');

/**
 * Returns all roadmap reminders ordered by creation date (oldest first).
 * @returns {Promise<Array>}
 */
async function listReminders() {
  const result = await pool.query(
    `SELECT * FROM roadmap_reminders ORDER BY created_at ASC`
  );
  return result.rows;
}

/**
 * Sets the manual_flag on a reminder (force-visible override).
 * @param {number} id
 * @param {boolean} enabled
 * @returns {Promise<Object|null>}
 */
async function setManualFlag(id, enabled) {
  const result = await pool.query(
    `UPDATE roadmap_reminders SET manual_flag = $1 WHERE id = $2 RETURNING *`,
    [!!enabled, id]
  );
  return result.rows[0] ?? null;
}

/**
 * Records surfaced_at timestamp when trigger first fires (idempotent).
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function markSurfaced(id) {
  const result = await pool.query(
    `UPDATE roadmap_reminders
     SET surfaced_at = COALESCE(surfaced_at, NOW())
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Dismisses a reminder (sets dismissed_at = now).
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function dismissReminder(id) {
  const result = await pool.query(
    `UPDATE roadmap_reminders SET dismissed_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Resurfaced a previously dismissed reminder (clears dismissed_at).
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function resurfaceReminder(id) {
  const result = await pool.query(
    `UPDATE roadmap_reminders SET dismissed_at = NULL WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

module.exports = {
  listReminders,
  setManualFlag,
  markSurfaced,
  dismissReminder,
  resurfaceReminder,
};
