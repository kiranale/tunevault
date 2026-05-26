/**
 * Team management queries.
 * Owns: teams, team_members, team_invites tables.
 * Does NOT own: user auth, session management, billing/subscriptions.
 */

const pool = require('./index');

// --- Teams ---

async function createTeam({ name, ownerId, planTier = 'team' }) {
  const { rows } = await pool.query(
    `INSERT INTO teams (name, owner_id, plan_tier) VALUES ($1, $2, $3) RETURNING *`,
    [name, ownerId, planTier]
  );
  return rows[0];
}

async function getTeamById(teamId) {
  const { rows } = await pool.query(`SELECT * FROM teams WHERE id = $1`, [teamId]);
  return rows[0] || null;
}

async function getTeamByOwnerId(ownerId) {
  const { rows } = await pool.query(`SELECT * FROM teams WHERE owner_id = $1 LIMIT 1`, [ownerId]);
  return rows[0] || null;
}

async function getTeamForUser(userId) {
  // Returns team + the member's role for this user
  const { rows } = await pool.query(
    `SELECT t.*, tm.role AS user_role
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function updateTeamName(teamId, name) {
  const { rows } = await pool.query(
    `UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [name, teamId]
  );
  return rows[0] || null;
}

// --- Team Members ---

async function addTeamMember({ teamId, userId, role = 'viewer' }) {
  const { rows } = await pool.query(
    `INSERT INTO team_members (team_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [teamId, userId, role]
  );
  // Also update users.team_id for quick lookup
  await pool.query(`UPDATE users SET team_id = $1 WHERE id = $2`, [teamId, userId]);
  return rows[0];
}

async function getTeamMembers(teamId) {
  const { rows } = await pool.query(
    `SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.joined_at,
            u.email, u.name
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1
     ORDER BY tm.joined_at ASC`,
    [teamId]
  );
  return rows;
}

async function getMemberRole(teamId, userId) {
  const { rows } = await pool.query(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  return rows[0]?.role || null;
}

async function updateMemberRole(teamId, userId, role) {
  const { rows } = await pool.query(
    `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3 RETURNING *`,
    [role, teamId, userId]
  );
  return rows[0] || null;
}

async function removeTeamMember(teamId, userId) {
  await pool.query(
    `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  // Clear team_id from users table
  await pool.query(
    `UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2`,
    [userId, teamId]
  );
}

async function getTeamMemberCount(teamId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`,
    [teamId]
  );
  return parseInt(rows[0].count, 10);
}

// --- Team Invites ---

async function createInvite({ teamId, invitedBy, email, role, token }) {
  const { rows } = await pool.query(
    `INSERT INTO team_invites (team_id, invited_by, email, role, token)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [teamId, invitedBy, email.toLowerCase(), role, token]
  );
  return rows[0];
}

async function getInviteByToken(token) {
  const { rows } = await pool.query(
    `SELECT ti.*, t.name AS team_name, u.name AS inviter_name, u.email AS inviter_email
     FROM team_invites ti
     JOIN teams t ON t.id = ti.team_id
     JOIN users u ON u.id = ti.invited_by
     WHERE ti.token = $1`,
    [token]
  );
  return rows[0] || null;
}

async function getPendingInvitesForTeam(teamId) {
  const { rows } = await pool.query(
    `SELECT ti.*, u.name AS inviter_name
     FROM team_invites ti
     JOIN users u ON u.id = ti.invited_by
     WHERE ti.team_id = $1 AND ti.status = 'pending' AND ti.expires_at > NOW()
     ORDER BY ti.created_at DESC`,
    [teamId]
  );
  return rows;
}

async function getPendingInviteForEmail(teamId, email) {
  const { rows } = await pool.query(
    `SELECT * FROM team_invites
     WHERE team_id = $1 AND email = $2 AND status = 'pending' AND expires_at > NOW()`,
    [teamId, email.toLowerCase()]
  );
  return rows[0] || null;
}

async function updateInviteStatus(token, status) {
  const { rows } = await pool.query(
    `UPDATE team_invites SET status = $1 WHERE token = $2 RETURNING *`,
    [status, token]
  );
  return rows[0] || null;
}

async function revokeInviteById(inviteId, teamId) {
  const { rows } = await pool.query(
    `UPDATE team_invites SET status = 'revoked'
     WHERE id = $1 AND team_id = $2 RETURNING *`,
    [inviteId, teamId]
  );
  return rows[0] || null;
}

async function resendInvite(inviteId, teamId, newToken) {
  // Extend expiry and issue fresh token
  const { rows } = await pool.query(
    `UPDATE team_invites
     SET token = $1, status = 'pending', expires_at = NOW() + INTERVAL '7 days', created_at = NOW()
     WHERE id = $2 AND team_id = $3
     RETURNING *`,
    [newToken, inviteId, teamId]
  );
  return rows[0] || null;
}

module.exports = {
  createTeam,
  getTeamById,
  getTeamByOwnerId,
  getTeamForUser,
  updateTeamName,
  addTeamMember,
  getTeamMembers,
  getMemberRole,
  updateMemberRole,
  removeTeamMember,
  getTeamMemberCount,
  createInvite,
  getInviteByToken,
  getPendingInvitesForTeam,
  getPendingInviteForEmail,
  updateInviteStatus,
  revokeInviteById,
  resendInvite,
};
