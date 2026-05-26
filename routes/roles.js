/**
 * Role hierarchy + approval engine routes.
 * Owns: /api/roles/* (CRUD), /api/approvals/* (approval workflow), /api/patches/status.
 * Does NOT own: team membership CRUD, user auth, billing/subscriptions.
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/roles');
const teamsDb = require('../db/teams');

const router = express.Router();

// ─── Utility: slugify a role name ─────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);
}

// ─── Helper: resolve team context for current user ────────────────────────────

async function resolveTeam(userId) {
  return teamsDb.getTeamForUser(userId);
}

// ─── Roles API ────────────────────────────────────────────────────────────────

// GET /api/roles — list all roles for current user's team
router.get('/api/roles', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.json({ roles: [] });
    const roles = await db.getRolesForTeam(team.id);
    return res.json({ roles });
  } catch (err) {
    console.error('[roles] GET /api/roles error:', err.message);
    return res.status(500).json({ error: 'Failed to load roles' });
  }
});

// POST /api/roles — create a custom role (enterprise tier: plan_tier='enterprise')
router.post('/api/roles', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    // Only admins can manage roles
    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    if (memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to manage roles' });
    }

    // Enterprise check for custom roles
    if (team.plan_tier !== 'enterprise') {
      return res.status(402).json({ error: 'Custom roles require enterprise tier' });
    }

    const { name, branch, permissions, approvalRequiredFrom, sortOrder } = req.body;
    if (!name || !branch) {
      return res.status(400).json({ error: 'name and branch are required' });
    }
    if (!['dba', 'functional', 'dev', 'management'].includes(branch)) {
      return res.status(400).json({ error: 'Invalid branch. Must be: dba, functional, dev, management' });
    }

    const slug = slugify(name);
    const existing = await db.getRoleByTeamAndSlug(team.id, slug);
    if (existing) {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }

    const role = await db.createRole({
      teamId: team.id,
      name: name.trim(),
      slug,
      branch,
      permissions: permissions || {},
      approvalRequiredFrom: approvalRequiredFrom || null,
      sortOrder: sortOrder || 100,
    });

    return res.status(201).json({ role });
  } catch (err) {
    console.error('[roles] POST /api/roles error:', err.message);
    return res.status(500).json({ error: 'Failed to create role' });
  }
});

// PUT /api/roles/:id — update a role (name, permissions, approval chain, sort_order)
router.put('/api/roles/:id', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    if (memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to manage roles' });
    }

    const { name, permissions, approvalRequiredFrom, sortOrder } = req.body;
    const updated = await db.updateRole(parseInt(req.params.id), team.id, {
      name, permissions, approvalRequiredFrom, sortOrder,
    });
    if (!updated) return res.status(404).json({ error: 'Role not found' });

    return res.json({ role: updated });
  } catch (err) {
    console.error('[roles] PUT /api/roles/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to update role' });
  }
});

// DELETE /api/roles/:id — delete a custom role (non-default only)
router.delete('/api/roles/:id', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    if (memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to manage roles' });
    }

    const deleted = await db.deleteRole(parseInt(req.params.id), team.id);
    if (!deleted) return res.status(400).json({ error: 'Role not found or is a default role (cannot delete)' });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[roles] DELETE /api/roles/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to delete role' });
  }
});

// POST /api/roles/seed — seed default roles for team (idempotent, admin only)
router.post('/api/roles/seed', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    if (memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    await db.seedDefaultRoles(team.id);
    const roles = await db.getRolesForTeam(team.id);
    return res.json({ roles });
  } catch (err) {
    console.error('[roles] POST /api/roles/seed error:', err.message);
    return res.status(500).json({ error: 'Failed to seed roles' });
  }
});

// POST /api/roles/assign — assign a role to a team member
router.post('/api/roles/assign', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    if (memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to assign roles' });
    }

    const { userId, roleId } = req.body;
    if (!userId || !roleId) {
      return res.status(400).json({ error: 'userId and roleId are required' });
    }

    const result = await db.assignRoleToMember(team.id, parseInt(userId), parseInt(roleId));
    if (!result) return res.status(404).json({ error: 'Member not found' });

    return res.json({ ok: true, member: result });
  } catch (err) {
    console.error('[roles] POST /api/roles/assign error:', err.message);
    return res.status(500).json({ error: 'Failed to assign role' });
  }
});

// GET /api/roles/me — get current user's role details (permissions, branch, approval chain)
router.get('/api/roles/me', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.json({ role: null, permissions: null });

    const details = await db.getMemberRoleDetails(team.id, req.user.id);
    return res.json({ role: details });
  } catch (err) {
    console.error('[roles] GET /api/roles/me error:', err.message);
    return res.status(500).json({ error: 'Failed to load role' });
  }
});

// ─── Approval Workflow API ─────────────────────────────────────────────────────

// POST /api/approvals — request approval for an action
router.post('/api/approvals', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    // Determine which role needs to approve — from requester's role definition
    const memberRole = await db.getMemberRoleDetails(team.id, req.user.id);
    if (!memberRole || !memberRole.approver_role_id) {
      return res.status(400).json({ error: 'Your role does not require approval' });
    }

    const { ticketId, context } = req.body;

    const request = await db.createApprovalRequest({
      ticketId: ticketId || null,
      requesterId: req.user.id,
      approverRoleId: memberRole.approver_role_id,
      context: context || {},
    });

    return res.status(201).json({ request });
  } catch (err) {
    console.error('[roles] POST /api/approvals error:', err.message);
    return res.status(500).json({ error: 'Failed to create approval request' });
  }
});

// GET /api/approvals — list pending approvals (team-scoped, must be approver role)
router.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.json({ approvals: [] });

    // Team admins and managers see all pending approvals for their team
    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);
    const memberDetails = await db.getMemberRoleDetails(team.id, req.user.id);

    let approvals;
    if (memberRole === 'admin' || (memberDetails && memberDetails.permissions && memberDetails.permissions.can_approve)) {
      approvals = await db.getPendingApprovalRequestsForTeam(team.id);
    } else {
      // Regular users see only their own requests
      approvals = await db.getApprovalRequestsForRequester(req.user.id);
    }

    return res.json({ approvals });
  } catch (err) {
    console.error('[roles] GET /api/approvals error:', err.message);
    return res.status(500).json({ error: 'Failed to load approvals' });
  }
});

// POST /api/approvals/:id/approve — approve a pending request
router.post('/api/approvals/:id/approve', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    // Verify approver has permission
    const memberDetails = await db.getMemberRoleDetails(team.id, req.user.id);
    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);

    const canApprove = memberRole === 'admin' ||
      (memberDetails && memberDetails.permissions && memberDetails.permissions.can_approve);

    if (!canApprove) {
      return res.status(403).json({ error: 'You do not have permission to approve requests' });
    }

    // Ensure the request belongs to this team
    const request = await db.getApprovalRequestById(parseInt(req.params.id));
    if (!request || request.team_id !== team.id) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    const approved = await db.approveRequest(parseInt(req.params.id), req.user.id);
    if (!approved) return res.status(400).json({ error: 'Request is not pending' });

    return res.json({ request: approved });
  } catch (err) {
    console.error('[roles] POST /api/approvals/:id/approve error:', err.message);
    return res.status(500).json({ error: 'Failed to approve request' });
  }
});

// POST /api/approvals/:id/reject — reject a pending request
router.post('/api/approvals/:id/reject', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    if (!team) return res.status(400).json({ error: 'No team found' });

    const memberDetails = await db.getMemberRoleDetails(team.id, req.user.id);
    const memberRole = await teamsDb.getMemberRole(team.id, req.user.id);

    const canApprove = memberRole === 'admin' ||
      (memberDetails && memberDetails.permissions && memberDetails.permissions.can_approve);

    if (!canApprove) {
      return res.status(403).json({ error: 'You do not have permission to reject requests' });
    }

    const request = await db.getApprovalRequestById(parseInt(req.params.id));
    if (!request || request.team_id !== team.id) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    const { reason } = req.body;
    const rejected = await db.rejectRequest(parseInt(req.params.id), req.user.id, reason);
    if (!rejected) return res.status(400).json({ error: 'Request is not pending' });

    return res.json({ request: rejected });
  } catch (err) {
    console.error('[roles] POST /api/approvals/:id/reject error:', err.message);
    return res.status(500).json({ error: 'Failed to reject request' });
  }
});

// GET /api/approvals/my — requests submitted by current user
router.get('/api/approvals/my', requireAuth, async (req, res) => {
  try {
    const requests = await db.getApprovalRequestsForRequester(req.user.id);
    return res.json({ requests });
  } catch (err) {
    console.error('[roles] GET /api/approvals/my error:', err.message);
    return res.status(500).json({ error: 'Failed to load requests' });
  }
});

// ─── Patch Status Widget ──────────────────────────────────────────────────────

// GET /api/patches/status — role-filtered simplified patch status list
// DBA branch → full patch advisor data
// Functional/Dev/Management → simplified status only (no ADOP internals)
router.get('/api/patches/status', requireAuth, async (req, res) => {
  try {
    const team = await resolveTeam(req.user.id);
    let branch = 'dba'; // Default: individual users get full DBA view
    let canViewAdopInternals = true;

    if (team) {
      const memberDetails = await db.getMemberRoleDetails(team.id, req.user.id);
      if (memberDetails) {
        branch = memberDetails.branch || 'dba';
        canViewAdopInternals = Boolean(memberDetails.permissions && memberDetails.permissions.can_view_adop_internals);
      }
    }

    const { connectionId } = req.query;

    if (!connectionId) {
      return res.status(400).json({ error: 'connectionId is required' });
    }

    // Query via db layer (db/roles.js owns this query)
    const patchRows = await db.getPatchStatusForConnection(connectionId);

    // Filter internals based on branch
    const patches = patchRows.map(row => {
      const base = {
        check_id: row.check_id,
        result: row.result,
        severity: row.severity,
        run_at: row.run_at,
      };

      if (!canViewAdopInternals) {
        // Simplified view: only show pass/warn/fail status + timestamp
        return {
          ...base,
          // Strip any ADOP phase details, worker counts, filesystem paths
          result: row.result === 'pass' ? 'Applied ✅' :
                  row.result === 'warn' ? 'Pending ⏳' : 'Failed 🔴',
          details: null, // No drill-down for non-DBA
        };
      }

      // DBA view: full details
      return { ...base, details: row.details };
    });

    return res.json({
      patches,
      branch,
      can_view_adop_internals: canViewAdopInternals,
    });
  } catch (err) {
    console.error('[roles] GET /api/patches/status error:', err.message);
    return res.status(500).json({ error: 'Failed to load patch status' });
  }
});

module.exports = router;
