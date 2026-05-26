/**
 * db/mfa.js — CRUD for user_mfa and mfa_attempts tables.
 * Owns: MFA record reads/writes, failed-attempt tracking for lockout.
 * Does NOT own: TOTP generation, QR code rendering, recovery code hashing — those live in services/mfa.js.
 */

const pool = require('./index');

// --- user_mfa ---

async function getMfaRecord(userId) {
  const r = await pool.query(
    `SELECT id, user_id, totp_secret, is_enabled, recovery_codes,
            verified_at, last_used_at, created_at, updated_at
     FROM user_mfa WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function upsertMfaRecord({ userId, totpSecret, isEnabled = false, recoveryCodes = [] }) {
  const r = await pool.query(
    `INSERT INTO user_mfa (user_id, totp_secret, is_enabled, recovery_codes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       totp_secret    = EXCLUDED.totp_secret,
       is_enabled     = EXCLUDED.is_enabled,
       recovery_codes = EXCLUDED.recovery_codes,
       updated_at     = NOW()
     RETURNING *`,
    [userId, totpSecret, isEnabled, JSON.stringify(recoveryCodes)]
  );
  return r.rows[0];
}

async function enableMfa(userId) {
  const r = await pool.query(
    `UPDATE user_mfa
     SET is_enabled = TRUE, verified_at = NOW(), updated_at = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId]
  );
  return r.rows[0] || null;
}

async function disableMfa(userId) {
  await pool.query(
    `UPDATE user_mfa
     SET is_enabled = FALSE, totp_secret = '', recovery_codes = '[]',
         verified_at = NULL, last_used_at = NULL, updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

async function deleteMfaRecord(userId) {
  await pool.query(`DELETE FROM user_mfa WHERE user_id = $1`, [userId]);
}

async function updateRecoveryCodes(userId, recoveryCodes) {
  await pool.query(
    `UPDATE user_mfa SET recovery_codes = $2, updated_at = NOW() WHERE user_id = $1`,
    [userId, JSON.stringify(recoveryCodes)]
  );
}

async function updateLastUsedAt(userId) {
  await pool.query(
    `UPDATE user_mfa SET last_used_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );
}

// --- mfa_attempts (lockout tracking) ---

// Returns count of failed TOTP attempts in the last 15 minutes
async function recentFailedAttempts(userId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM mfa_attempts
     WHERE user_id = $1 AND succeeded = FALSE AND attempted_at > NOW() - INTERVAL '15 minutes'`,
    [userId]
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function logAttempt({ userId, succeeded, method = 'totp', ip = null }) {
  await pool.query(
    `INSERT INTO mfa_attempts (user_id, succeeded, method, ip, attempted_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, succeeded, method, ip]
  );
}

// --- team mfa_required ---

async function getTeamMfaRequired(teamId) {
  const r = await pool.query(
    `SELECT mfa_required FROM teams WHERE id = $1`,
    [teamId]
  );
  return r.rows[0]?.mfa_required ?? false;
}

async function setTeamMfaRequired(teamId, required) {
  await pool.query(
    `UPDATE teams SET mfa_required = $2 WHERE id = $1`,
    [teamId, required]
  );
}

// Returns { team, members } for team admin MFA status view
async function getTeamMfaStatus(userId) {
  const teamResult = await pool.query(
    `SELECT t.id, t.name, t.mfa_required, t.owner_id
     FROM teams t
     JOIN users u ON u.team_id = t.id
     WHERE u.id = $1`,
    [userId]
  );
  if (!teamResult.rows.length) return null;
  const team = teamResult.rows[0];

  const membersResult = await pool.query(
    `SELECT u.id, u.email, u.name,
            COALESCE(m.is_enabled, false) AS mfa_enabled,
            m.verified_at, m.last_used_at
     FROM team_members tm
     JOIN users u ON tm.user_id = u.id
     LEFT JOIN user_mfa m ON m.user_id = u.id
     WHERE tm.team_id = $1
     ORDER BY u.email`,
    [team.id]
  );
  return { team, members: membersResult.rows };
}

// Returns team for user (to check owner)
async function getTeamForOwnerCheck(userId) {
  const r = await pool.query(
    `SELECT t.id, t.owner_id, t.mfa_required
     FROM teams t JOIN users u ON u.team_id = t.id WHERE u.id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

module.exports = {
  getMfaRecord,
  upsertMfaRecord,
  enableMfa,
  disableMfa,
  deleteMfaRecord,
  updateRecoveryCodes,
  updateLastUsedAt,
  recentFailedAttempts,
  logAttempt,
  getTeamMfaRequired,
  setTeamMfaRequired,
  getTeamMfaStatus,
  getTeamForOwnerCheck,
};
