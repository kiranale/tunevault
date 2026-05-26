/**
 * db/ebs-control.js — Database access for EBS Control Command catalog + audit log.
 *
 * Owns: ebs_control_commands reads, audit_log writes.
 * Does NOT own: command execution, SSH, auth, oracle connections.
 */

'use strict';

const pool = require('./index');

/**
 * Return all commands from ebs_control_commands, ordered by category then label.
 * Never returns user-supplied data — catalog rows are seeded by migration only.
 *
 * @returns {Promise<Array>}
 */
async function getCatalog() {
  const { rows } = await pool.query(`
    SELECT id, slug, label, category, shell_template,
           requires_context_file, requires_apps_password,
           risk_level, dry_run_only, description,
           expected_effect, rollback_steps
    FROM ebs_control_commands
    ORDER BY category, label
  `);
  return rows;
}

/**
 * Return a single command by slug, or null if not found.
 * Used by preview endpoint for whitelist validation.
 *
 * @param {string} slug
 * @returns {Promise<Object|null>}
 */
async function getCommandBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, label, category, shell_template,
            requires_context_file, requires_apps_password,
            risk_level, dry_run_only, description,
            expected_effect, rollback_steps
     FROM ebs_control_commands
     WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

/**
 * Write an audit log entry for a preview attempt.
 * Call this for EVERY attempt — allowed and rejected alike.
 *
 * @param {Object} params
 * @param {number|null} params.userId
 * @param {string} params.action      - e.g. 'ebs_control.preview'
 * @param {string|null} params.slug   - the slug attempted
 * @param {boolean} params.allowed
 * @param {string|null} params.rejectionReason
 * @param {Object} params.metadata    - any extra context (ip, userAgent, etc.)
 */
async function writeAuditLog({ userId, action, slug, allowed, rejectionReason, metadata = {} }) {
  await pool.query(
    `INSERT INTO audit_log (user_id, action, slug, allowed, rejection_reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId || null,
      action,
      slug || null,
      allowed,
      rejectionReason || null,
      JSON.stringify(metadata)
    ]
  );
}

/**
 * Look up a user by ID for auth middleware.
 * Kept here to avoid raw pool.query in routes.
 *
 * @param {number} userId
 * @returns {Promise<{id: number, email: string}|null>}
 */
async function getUserById(userId) {
  const { rows } = await pool.query(
    'SELECT id, email FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

module.exports = { getCatalog, getCommandBySlug, writeAuditLog, getUserById };
