/**
 * Role management queries.
 * Owns: roles table (per-team role definitions), approval_requests table.
 * Does NOT own: team membership, user auth, billing/subscriptions.
 */

const pool = require('./index');

// ─── Default role seed definitions (applied when a team is created) ───────────

const DEFAULT_ROLES = [
  // DBA branch
  {
    name: 'Lead DBA', slug: 'lead_dba', branch: 'dba', sort_order: 10,
    permissions: {
      can_diagnose: true, can_recommend: true, can_execute: true, can_approve: true,
      can_view_sql_console: true, can_view_cm_dashboard: true, can_view_perf_impact: true,
      can_view_patch_status: true, can_view_adop_internals: true,
      can_view_audit: 'team', can_export_compliance: false, report_visibility: 'team',
    },
  },
  {
    name: 'Senior DBA', slug: 'senior_dba', branch: 'dba', sort_order: 20,
    permissions: {
      can_diagnose: true, can_recommend: true, can_execute: true, can_approve: false,
      can_view_sql_console: true, can_view_cm_dashboard: true, can_view_perf_impact: true,
      can_view_patch_status: true, can_view_adop_internals: true,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
    },
  },
  {
    name: 'Junior DBA', slug: 'junior_dba', branch: 'dba', sort_order: 30,
    permissions: {
      can_diagnose: true, can_recommend: true, can_execute: false, can_approve: false,
      can_view_sql_console: true, can_view_cm_dashboard: true, can_view_perf_impact: true,
      can_view_patch_status: true, can_view_adop_internals: true,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
      requires_approval_to_execute: true,
    },
  },
  // Functional branch
  {
    name: 'Lead Functional', slug: 'lead_functional', branch: 'functional', sort_order: 40,
    permissions: {
      can_diagnose: false, can_recommend: false, can_execute: false, can_approve: false,
      can_view_sql_console: false, can_view_cm_dashboard: true, can_view_perf_impact: false,
      can_view_patch_status: true, can_view_adop_internals: false,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
      can_assign_tuneops: true,
    },
  },
  {
    name: 'Functional Analyst', slug: 'functional_analyst', branch: 'functional', sort_order: 50,
    permissions: {
      can_diagnose: false, can_recommend: false, can_execute: false, can_approve: false,
      can_view_sql_console: false, can_view_cm_dashboard: true, can_view_perf_impact: false,
      can_view_patch_status: true, can_view_adop_internals: false,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
    },
  },
  // Dev branch
  {
    name: 'Dev Lead', slug: 'dev_lead', branch: 'dev', sort_order: 60,
    permissions: {
      can_diagnose: false, can_recommend: false, can_execute: false, can_approve: false,
      can_view_sql_console: true, can_view_cm_dashboard: false, can_view_perf_impact: true,
      can_view_patch_status: true, can_view_adop_internals: false,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
      can_assign_tuneops: true, sql_console_readonly: false,
    },
  },
  {
    name: 'Developer', slug: 'developer', branch: 'dev', sort_order: 70,
    permissions: {
      can_diagnose: false, can_recommend: false, can_execute: false, can_approve: false,
      can_view_sql_console: true, can_view_cm_dashboard: false, can_view_perf_impact: true,
      can_view_patch_status: true, can_view_adop_internals: false,
      can_view_audit: 'own', can_export_compliance: false, report_visibility: 'own',
      sql_console_readonly: true,
    },
  },
  // Management branch
  {
    name: 'Manager / SDM', slug: 'manager', branch: 'management', sort_order: 80,
    permissions: {
      can_diagnose: false, can_recommend: false, can_execute: false, can_approve: true,
      can_view_sql_console: false, can_view_cm_dashboard: true, can_view_perf_impact: false,
      can_view_patch_status: true, can_view_adop_internals: false,
      can_view_audit: 'full', can_export_compliance: true, report_visibility: 'full',
      is_final_approver: true,
    },
  },
];

// ─── Role CRUD ─────────────────────────────────────────────────────────────────

async function seedDefaultRoles(teamId) {
  // Insert default roles for a new team, setting approval_required_from afterward
  const inserted = {};
  for (const r of DEFAULT_ROLES) {
    const { rows } = await pool.query(
      `INSERT INTO roles (team_id, name, slug, branch, permissions, is_default, sort_order)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (team_id, slug) DO NOTHING
       RETURNING id, slug`,
      [teamId, r.name, r.slug, r.branch, JSON.stringify(r.permissions), r.sort_order]
    );
    if (rows[0]) inserted[r.slug] = rows[0].id;
  }
  // junior_dba requires approval from lead_dba
  if (inserted['junior_dba'] && inserted['lead_dba']) {
    await pool.query(
      `UPDATE roles SET approval_required_from = $1 WHERE id = $2`,
      [inserted['lead_dba'], inserted['junior_dba']]
    );
  }
  return inserted;
}

async function getRolesForTeam(teamId) {
  const { rows } = await pool.query(
    `SELECT r.*, ar.name AS approver_role_name
     FROM roles r
     LEFT JOIN roles ar ON ar.id = r.approval_required_from
     WHERE r.team_id = $1
     ORDER BY r.sort_order ASC, r.name ASC`,
    [teamId]
  );
  return rows;
}

async function getRoleById(roleId) {
  const { rows } = await pool.query(`SELECT * FROM roles WHERE id = $1`, [roleId]);
  return rows[0] || null;
}

async function getRoleByTeamAndSlug(teamId, slug) {
  const { rows } = await pool.query(
    `SELECT * FROM roles WHERE team_id = $1 AND slug = $2`,
    [teamId, slug]
  );
  return rows[0] || null;
}

async function createRole({ teamId, name, slug, branch, permissions, approvalRequiredFrom, sortOrder }) {
  const { rows } = await pool.query(
    `INSERT INTO roles (team_id, name, slug, branch, permissions, approval_required_from, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [teamId, name, slug, branch, JSON.stringify(permissions || {}), approvalRequiredFrom || null, sortOrder || 100]
  );
  return rows[0];
}

async function updateRole(roleId, teamId, { name, permissions, approvalRequiredFrom, sortOrder }) {
  const { rows } = await pool.query(
    `UPDATE roles
     SET name = COALESCE($1, name),
         permissions = COALESCE($2, permissions),
         approval_required_from = $3,
         sort_order = COALESCE($4, sort_order),
         updated_at = NOW()
     WHERE id = $5 AND team_id = $6
     RETURNING *`,
    [name || null, permissions ? JSON.stringify(permissions) : null, approvalRequiredFrom ?? null, sortOrder || null, roleId, teamId]
  );
  return rows[0] || null;
}

async function deleteRole(roleId, teamId) {
  // Only non-default roles can be deleted
  const { rows } = await pool.query(
    `DELETE FROM roles WHERE id = $1 AND team_id = $2 AND is_default = false RETURNING id`,
    [roleId, teamId]
  );
  return rows[0] || null;
}

// ─── Member role assignment ────────────────────────────────────────────────────

async function assignRoleToMember(teamId, userId, roleId) {
  // Sets both the new role_id and updates legacy role string to branch-based value
  const role = await getRoleById(roleId);
  if (!role || role.team_id !== teamId) throw new Error('Role not found or wrong team');

  const { rows } = await pool.query(
    `UPDATE team_members SET role_id = $1, updated_at = NOW()
     WHERE team_id = $2 AND user_id = $3
     RETURNING *`,
    [roleId, teamId, userId]
  );
  return rows[0] || null;
}

async function getMemberRoleDetails(teamId, userId) {
  const { rows } = await pool.query(
    `SELECT tm.role, tm.role_id, r.name AS role_name, r.branch, r.permissions,
            r.approval_required_from, ar.name AS approver_role_name, ar.id AS approver_role_id
     FROM team_members tm
     LEFT JOIN roles r ON r.id = tm.role_id
     LEFT JOIN roles ar ON ar.id = r.approval_required_from
     WHERE tm.team_id = $1 AND tm.user_id = $2`,
    [teamId, userId]
  );
  return rows[0] || null;
}

// ─── Approval requests ─────────────────────────────────────────────────────────

async function createApprovalRequest({ ticketId, requesterId, approverRoleId, context }) {
  const { rows } = await pool.query(
    `INSERT INTO approval_requests (ticket_id, requester_id, approver_role_id, context)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [ticketId || null, requesterId, approverRoleId, JSON.stringify(context || {})]
  );
  return rows[0];
}

async function getPendingApprovalRequestsForRole(approverRoleId) {
  const { rows } = await pool.query(
    `SELECT ar.*, u.email AS requester_email, u.name AS requester_name
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requester_id
     WHERE ar.approver_role_id = $1 AND ar.status = 'pending'
     ORDER BY ar.created_at ASC`,
    [approverRoleId]
  );
  return rows;
}

async function getPendingApprovalRequestsForTeam(teamId) {
  // Returns pending approvals where the approver_role belongs to this team
  const { rows } = await pool.query(
    `SELECT ar.*, u.email AS requester_email, u.name AS requester_name,
            r.name AS approver_role_name, r.branch
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requester_id
     JOIN roles r ON r.id = ar.approver_role_id
     WHERE r.team_id = $1 AND ar.status = 'pending'
     ORDER BY ar.created_at ASC`,
    [teamId]
  );
  return rows;
}

async function getApprovalRequestById(id) {
  const { rows } = await pool.query(
    `SELECT ar.*, u.email AS requester_email, u.name AS requester_name,
            r.name AS approver_role_name, r.branch, r.team_id
     FROM approval_requests ar
     JOIN users u ON u.id = ar.requester_id
     JOIN roles r ON r.id = ar.approver_role_id
     WHERE ar.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function approveRequest(id, approverId) {
  const { rows } = await pool.query(
    `UPDATE approval_requests
     SET status = 'approved', approved_by = $1, approved_at = NOW()
     WHERE id = $2 AND status = 'pending'
     RETURNING *`,
    [approverId, id]
  );
  return rows[0] || null;
}

async function rejectRequest(id, approverId, reason) {
  const { rows } = await pool.query(
    `UPDATE approval_requests
     SET status = 'rejected', approved_by = $1, rejected_at = NOW(), rejection_reason = $2
     WHERE id = $3 AND status = 'pending'
     RETURNING *`,
    [approverId, reason || null, id]
  );
  return rows[0] || null;
}

async function getApprovalRequestsForRequester(requesterId) {
  const { rows } = await pool.query(
    `SELECT ar.*, r.name AS approver_role_name, au.email AS approver_email
     FROM approval_requests ar
     JOIN roles r ON r.id = ar.approver_role_id
     LEFT JOIN users au ON au.id = ar.approved_by
     WHERE ar.requester_id = $1
     ORDER BY ar.created_at DESC
     LIMIT 50`,
    [requesterId]
  );
  return rows;
}

// ─── Permission check helper ───────────────────────────────────────────────────

/**
 * Check if a user has a specific permission key.
 * Falls back gracefully to legacy role string if role_id not yet assigned.
 */
async function userHasPermission(userId, teamId, permissionKey) {
  const memberRole = await getMemberRoleDetails(teamId, userId);
  if (!memberRole) return true; // Not on team → individual account → full access

  if (memberRole.permissions) {
    const perm = memberRole.permissions[permissionKey];
    if (perm === undefined) return false;
    return Boolean(perm);
  }
  return false;
}

// ─── Patch status query (role-filtered) ───────────────────────────────────────

/**
 * Returns patch-related check results from the latest completed health check run.
 * Route filters the result set based on branch permissions.
 */
async function getPatchStatusForConnection(connectionId) {
  const { rows } = await pool.query(
    `SELECT cr.check_id, cr.result, cr.severity, cr.category, cr.details,
            hc.run_at, hc.id AS health_check_id
     FROM check_results cr
     JOIN health_checks hc ON hc.id = cr.health_check_id
     WHERE hc.connection_id = $1
       AND (cr.category = 'patching' OR cr.check_id ILIKE '%patch%' OR cr.check_id ILIKE '%adop%')
       AND hc.run_at = (
         SELECT MAX(run_at) FROM health_checks WHERE connection_id = $1 AND status = 'completed'
       )
     ORDER BY cr.severity DESC`,
    [connectionId]
  );
  return rows;
}

module.exports = {
  DEFAULT_ROLES,
  seedDefaultRoles,
  getRolesForTeam,
  getRoleById,
  getRoleByTeamAndSlug,
  createRole,
  updateRole,
  deleteRole,
  assignRoleToMember,
  getMemberRoleDetails,
  createApprovalRequest,
  getPendingApprovalRequestsForRole,
  getPendingApprovalRequestsForTeam,
  getApprovalRequestById,
  approveRequest,
  rejectRequest,
  getApprovalRequestsForRequester,
  userHasPermission,
  getPatchStatusForConnection,
};
