/**
 * Team management routes.
 * Owns: /settings/team page, /api/team/* CRUD, /invite/accept flow.
 * Does NOT own: user auth, billing, connection ownership.
 */

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { enforceMemberCap } = require('../middleware/tier-enforce');
const db = require('../db/teams');

const router = express.Router();

const ROLE_LABELS = {
  admin: 'Admin',
  senior_dba: 'Senior DBA',
  junior_dba: 'Junior DBA',
  viewer: 'Viewer',
};

const MAX_TEAM_MEMBERS = 10;

// --- Pages ---

// GET /settings/team — team management UI (auth required)
// no-store prevents browsers from caching authenticated HTML after session expiry
router.get('/settings/team', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('settings/team.html', { root: 'public' });
});

// GET /invite/accept — accept invite flow
router.get('/invite/accept', (req, res) => {
  res.sendFile('invite-accept.html', { root: 'public' });
});

// --- API: Get current user's team context ---

// GET /api/team/me — returns team + member info for current user
router.get('/api/team/me', requireAuth, async (req, res) => {
  try {
    const team = await db.getTeamForUser(req.user.id);
    if (!team) {
      return res.json({ team: null, role: null });
    }
    return res.json({ team, role: team.user_role });
  } catch (err) {
    console.error('[team] GET /api/team/me error:', err.message);
    return res.status(500).json({ error: 'Failed to load team' });
  }
});

// --- API: Team CRUD ---

// POST /api/team — create a new team (current user becomes admin)
router.post('/api/team', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Team name is required' });
    }

    // Check user doesn't already have a team
    const existing = await db.getTeamForUser(req.user.id);
    if (existing) {
      return res.status(409).json({ error: 'You are already on a team' });
    }

    const team = await db.createTeam({ name: name.trim(), ownerId: req.user.id });
    // Owner is auto-added as admin member
    await db.addTeamMember({ teamId: team.id, userId: req.user.id, role: 'admin' });

    return res.json({ team });
  } catch (err) {
    console.error('[team] POST /api/team error:', err.message);
    return res.status(500).json({ error: 'Failed to create team' });
  }
});

// GET /api/team/:teamId — team details + members + pending invites
router.get('/api/team/:teamId', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const role = await db.getMemberRole(teamId, req.user.id);
    if (!role) {
      return res.status(403).json({ error: 'Not a member of this team' });
    }

    const [team, members, invites] = await Promise.all([
      db.getTeamById(teamId),
      db.getTeamMembers(teamId),
      db.getPendingInvitesForTeam(teamId),
    ]);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    return res.json({ team, members, invites, currentUserRole: role });
  } catch (err) {
    console.error('[team] GET /api/team/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to load team' });
  }
});

// PATCH /api/team/:teamId/name — rename team (admin only)
router.patch('/api/team/:teamId/name', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const role = await db.getMemberRole(teamId, req.user.id);
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Team name is required' });
    }

    const team = await db.updateTeamName(teamId, name.trim());
    return res.json({ team });
  } catch (err) {
    console.error('[team] PATCH /api/team/:id/name error:', err.message);
    return res.status(500).json({ error: 'Failed to update team name' });
  }
});

// --- API: Member Management (admin only) ---

// PATCH /api/team/:teamId/members/:userId/role — change a member's role
router.patch('/api/team/:teamId/members/:userId/role', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const actorRole = await db.getMemberRole(teamId, req.user.id);
    if (actorRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { role } = req.body;
    const validRoles = ['admin', 'senior_dba', 'junior_dba', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Prevent removing the only admin
    if (req.user.id === targetUserId && role !== 'admin') {
      const members = await db.getTeamMembers(teamId);
      const adminCount = members.filter(m => m.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last admin' });
      }
    }

    const member = await db.updateMemberRole(teamId, targetUserId, role);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }
    return res.json({ member });
  } catch (err) {
    console.error('[team] PATCH role error:', err.message);
    return res.status(500).json({ error: 'Failed to update role' });
  }
});

// DELETE /api/team/:teamId/members/:userId — remove a member
router.delete('/api/team/:teamId/members/:userId', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const targetUserId = parseInt(req.params.userId, 10);
    const actorRole = await db.getMemberRole(teamId, req.user.id);
    if (actorRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Prevent removing the last admin
    const members = await db.getTeamMembers(teamId);
    const target = members.find(m => m.user_id === targetUserId);
    if (!target) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if (target.role === 'admin') {
      const adminCount = members.filter(m => m.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last admin' });
      }
    }

    await db.removeTeamMember(teamId, targetUserId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[team] DELETE member error:', err.message);
    return res.status(500).json({ error: 'Failed to remove member' });
  }
});

// --- API: Invites ---

// POST /api/team/:teamId/invites — send an invite
router.post('/api/team/:teamId/invites', requireAuth, enforceMemberCap, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const actorRole = await db.getMemberRole(teamId, req.user.id);
    if (actorRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { email, role = 'viewer' } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const validRoles = ['admin', 'senior_dba', 'junior_dba', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check member count limit
    const memberCount = await db.getTeamMemberCount(teamId);
    const pendingInvites = await db.getPendingInvitesForTeam(teamId);
    if (memberCount + pendingInvites.length >= MAX_TEAM_MEMBERS) {
      return res.status(400).json({ error: `Team is at the ${MAX_TEAM_MEMBERS}-member limit` });
    }

    // Check not already a member (by email lookup)
    const members = await db.getTeamMembers(teamId);
    const already = members.find(m => m.email.toLowerCase() === email.toLowerCase());
    if (already) {
      return res.status(409).json({ error: 'This person is already on the team' });
    }

    // Check for existing pending invite
    const existingInvite = await db.getPendingInviteForEmail(teamId, email);
    if (existingInvite) {
      return res.status(409).json({ error: 'An invite is already pending for this email' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const invite = await db.createInvite({
      teamId,
      invitedBy: req.user.id,
      email,
      role,
      token,
    });

    // Send invite email
    const team = await db.getTeamById(teamId);
    await sendInviteEmail({
      to: email,
      inviterName: req.user.name || req.user.email,
      teamName: team.name,
      role,
      token,
    });

    return res.json({ invite });
  } catch (err) {
    console.error('[team] POST invite error:', err.message);
    return res.status(500).json({ error: 'Failed to send invite' });
  }
});

// DELETE /api/team/:teamId/invites/:inviteId — revoke an invite
router.delete('/api/team/:teamId/invites/:inviteId', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const inviteId = parseInt(req.params.inviteId, 10);
    const actorRole = await db.getMemberRole(teamId, req.user.id);
    if (actorRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const invite = await db.revokeInviteById(inviteId, teamId);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[team] DELETE invite error:', err.message);
    return res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// POST /api/team/:teamId/invites/:inviteId/resend — resend invite
router.post('/api/team/:teamId/invites/:inviteId/resend', requireAuth, async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId, 10);
    const inviteId = parseInt(req.params.inviteId, 10);
    const actorRole = await db.getMemberRole(teamId, req.user.id);
    if (actorRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const newToken = crypto.randomBytes(32).toString('hex');
    const invite = await db.resendInvite(inviteId, teamId, newToken);
    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    // Resend email
    const team = await db.getTeamById(teamId);
    await sendInviteEmail({
      to: invite.email,
      inviterName: req.user.name || req.user.email,
      teamName: team.name,
      role: invite.role,
      token: newToken,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[team] POST resend invite error:', err.message);
    return res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// --- API: Accept Invite ---

// GET /api/invite/accept?token=xxx — validate token (pre-check, no auth required)
router.get('/api/invite/accept', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invite = await db.getInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(410).json({ error: 'Invite already used or revoked' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });

    return res.json({
      valid: true,
      teamName: invite.team_name,
      role: invite.role,
      roleLabel: ROLE_LABELS[invite.role] || invite.role,
      inviterName: invite.inviter_name,
      email: invite.email,
    });
  } catch (err) {
    console.error('[team] GET /api/invite/accept error:', err.message);
    return res.status(500).json({ error: 'Failed to validate invite' });
  }
});

// POST /api/invite/accept — accept invite (auth required)
router.post('/api/invite/accept', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invite = await db.getInviteByToken(token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(410).json({ error: 'Invite already used or revoked' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });

    // Check not already on a team
    const existingTeam = await db.getTeamForUser(req.user.id);
    if (existingTeam) {
      if (existingTeam.id === invite.team_id) {
        return res.status(409).json({ error: 'already_member', teamId: existingTeam.id });
      }
      return res.status(409).json({ error: 'You are already on another team' });
    }

    // Check member count
    const memberCount = await db.getTeamMemberCount(invite.team_id);
    if (memberCount >= MAX_TEAM_MEMBERS) {
      return res.status(400).json({ error: 'Team is full' });
    }

    await db.addTeamMember({ teamId: invite.team_id, userId: req.user.id, role: invite.role });
    await db.updateInviteStatus(token, 'accepted');

    return res.json({ ok: true, teamId: invite.team_id });
  } catch (err) {
    console.error('[team] POST /api/invite/accept error:', err.message);
    return res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// --- Email helper ---

async function sendInviteEmail({ to, inviterName, teamName, role, token }) {
  const roleLabel = ROLE_LABELS[role] || role;
  const acceptUrl = `${process.env.APP_URL || 'https://tunevault.app'}/invite/accept?token=${token}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #0a0a0c; font-family: 'Helvetica Neue', Arial, sans-serif; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 40px 24px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; }
    .logo-icon { width: 36px; height: 36px; background: #f0a830; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: monospace; font-size: 14px; color: #0a0a0c; font-weight: 700; }
    .logo-name { color: #e8e8ed; font-size: 18px; font-weight: 700; }
    .card { background: #111114; border: 1px solid #2a2a30; border-radius: 16px; padding: 40px 32px; }
    h1 { color: #e8e8ed; font-size: 22px; font-weight: 700; margin: 0 0 12px; }
    p { color: #8888a0; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
    .role-badge { display: inline-block; background: rgba(96,165,250,0.12); color: #60a5fa; border: 1px solid rgba(96,165,250,0.25); border-radius: 6px; padding: 4px 12px; font-size: 13px; font-weight: 600; margin-bottom: 28px; }
    .cta { display: block; background: #f0a830; color: #0a0a0c; text-align: center; padding: 14px 28px; border-radius: 8px; font-size: 15px; font-weight: 700; text-decoration: none; margin-bottom: 24px; }
    .expiry { color: #555568; font-size: 12px; margin: 0; }
    .footer { color: #555568; font-size: 12px; margin-top: 32px; text-align: center; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="logo">
      <div class="logo-icon">TV</div>
      <span class="logo-name">TuneVault</span>
    </div>
    <div class="card">
      <h1>You're invited to join ${escHtml(teamName)}</h1>
      <p><strong style="color:#e8e8ed;">${escHtml(inviterName)}</strong> has invited you to join the <strong style="color:#e8e8ed;">${escHtml(teamName)}</strong> team on TuneVault — the Oracle DBA platform for health checks, EBS operations, and SQL tuning.</p>
      <div class="role-badge">Role: ${escHtml(roleLabel)}</div>
      <a href="${acceptUrl}" class="cta">Accept Invite →</a>
      <p class="expiry">This invite expires in 7 days. If you weren't expecting this, you can safely ignore it.</p>
    </div>
    <div class="footer">TuneVault · Oracle DBA Platform</div>
  </div>
</body>
</html>`;

  const body = `${inviterName} has invited you to join the ${teamName} team on TuneVault as ${roleLabel}.\n\nAccept your invite: ${acceptUrl}\n\nThis invite expires in 7 days.`;

  try {
    await fetch('https://polsia.com/api/proxy/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
      },
      body: JSON.stringify({ to, subject: `You're invited to join ${teamName} on TuneVault`, body, html }),
    });
  } catch (err) {
    // Non-fatal — invite is already stored, user can resend
    console.error('[team] Failed to send invite email:', err.message);
  }
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
