'use strict';

/**
 * db/activity-log.js — activity_log table CRUD + query helpers.
 *
 * Owns: reading and writing activity_log records (all DBA actions, logins,
 *       health checks, executions, approvals, settings changes).
 * Does NOT own: business logic, auth, tier enforcement, PDF/CSV rendering.
 *
 * ISOLATION GUARANTEE: every read is scoped to a single company_domain.
 * No query returns rows whose company_domain differs from the viewer's.
 * Admin cross-company visibility is restricted to /admin/... endpoints only
 * (not enforced here — the route layer is responsible for that separation).
 */

const pool = require('./index');

// Valid action types — kept in sync with the route and the UI filter list
const ACTION_TYPES = [
  'login',
  'health_check',
  'sql_execution',
  'ssh_execution',
  'db_op',
  'ebs_op',
  'tuneops',
  'approval',
  'settings_change',
  'export',
];

const RESULT_VALUES = ['success', 'failed', 'pending'];

/**
 * Write a single activity log entry.
 * Silently no-ops on error so logging never breaks the calling operation.
 *
 * @param {Object} opts
 * @param {number|null}  opts.userId
 * @param {string|null}  opts.userEmail
 * @param {string|null}  opts.userName
 * @param {string|null}  opts.userRole
 * @param {string|null}  opts.companyDomain  — required for isolation; callers pass req.user.company_domain
 * @param {string}       opts.actionType   — one of ACTION_TYPES
 * @param {Object}       opts.detail       — freeform JSONB payload
 * @param {number|null}  opts.connectionId
 * @param {string|null}  opts.connectionName
 * @param {string}       opts.result       — 'success'|'failed'|'pending'
 * @param {number|null}  opts.durationMs
 * @param {string|null}  opts.ipAddress
 * @param {string|null}  opts.userAgent
 * @returns {Promise<void>}
 */
async function logActivity({
  userId = null,
  userEmail = null,
  userName = null,
  userRole = null,
  companyDomain = null,
  actionType,
  detail = {},
  connectionId = null,
  connectionName = null,
  result = 'success',
  durationMs = null,
  ipAddress = null,
  userAgent = null,
}) {
  try {
    await pool.query(
      `INSERT INTO activity_log
         (user_id, user_email, user_name, user_role, company_domain,
          action_type, detail, connection_id, connection_name,
          result, duration_ms, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        userId, userEmail, userName, userRole, companyDomain || null,
        actionType, JSON.stringify(detail),
        connectionId, connectionName,
        result, durationMs,
        ipAddress, userAgent,
      ]
    );
  } catch (err) {
    // Never surface logging errors to callers
    console.error('[activity-log] write error:', err.message);
  }
}

/**
 * Query activity log with filters, pagination, and text search.
 *
 * ISOLATION: viewerCompanyDomain is ALWAYS applied as a WHERE condition.
 * When isAdmin=true the user still only sees their own company; cross-company
 * visibility belongs exclusively on /admin routes, not here.
 *
 * @param {Object} opts
 * @param {number}        opts.viewerUserId      — user performing the query
 * @param {string|null}   opts.viewerCompanyDomain — mandatory for isolation
 * @param {boolean}       opts.isAdmin           — platform admin (still company-scoped here)
 * @param {boolean}       opts.isTeamAdmin       — team admin sees all team members
 * @param {number[]}      opts.teamMemberIds     — user IDs in the viewer's team
 * @param {string|null}   opts.dateFrom          — ISO string
 * @param {string|null}   opts.dateTo            — ISO string
 * @param {number|null}   opts.filterUserId
 * @param {string[]}      opts.actionTypes       — empty = all
 * @param {number|null}   opts.connectionId
 * @param {string|null}   opts.result            — 'success'|'failed'|'pending'|null
 * @param {string|null}   opts.search            — text search on detail::text
 * @param {number}        opts.limit
 * @param {number}        opts.offset
 * @returns {Promise<{rows: Array, total: number}>}
 */
async function queryActivity({
  viewerUserId,
  viewerCompanyDomain = null,
  isAdmin = false,
  isTeamAdmin = false,
  teamMemberIds = [],
  dateFrom = null,
  dateTo = null,
  filterUserId = null,
  actionTypes = [],
  connectionId = null,
  result = null,
  search = null,
  limit = 50,
  offset = 0,
}) {
  const conditions = [];
  const params = [];
  let p = 1;

  // ── Company-domain isolation (defense layer 1) ─────────────────────────────
  // Always scope to the viewer's company. NULL company_domain rows are only
  // visible to the user who created them (legacy rows before migration).
  if (viewerCompanyDomain) {
    conditions.push(`(company_domain = $${p++} OR (company_domain IS NULL AND user_id = $${p++}))`);
    params.push(viewerCompanyDomain, viewerUserId);
  } else {
    // No company domain on record — restrict to own rows only (safest fallback)
    conditions.push(`user_id = $${p++}`);
    params.push(viewerUserId);
  }

  // ── User-ID ownership scoping (defense layer 2) ────────────────────────────
  // Non-admins and non-team-admins may only see their own rows, even within
  // their company. Team admins see all team members within the company.
  if (!isAdmin) {
    const visibleIds = [viewerUserId, ...teamMemberIds].filter(Boolean);
    conditions.push(`user_id = ANY($${p++})`);
    params.push(visibleIds);
  }

  if (dateFrom) {
    conditions.push(`created_at >= $${p++}`);
    params.push(new Date(dateFrom));
  }
  if (dateTo) {
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(`created_at <= $${p++}`);
    params.push(to);
  }
  if (filterUserId) {
    conditions.push(`user_id = $${p++}`);
    params.push(filterUserId);
  }
  if (actionTypes && actionTypes.length > 0) {
    conditions.push(`action_type = ANY($${p++})`);
    params.push(actionTypes);
  }
  if (connectionId) {
    conditions.push(`connection_id = $${p++}`);
    params.push(connectionId);
  }
  if (result) {
    conditions.push(`result = $${p++}`);
    params.push(result);
  }
  if (search && search.trim()) {
    conditions.push(`(detail::text ILIKE $${p} OR user_email ILIKE $${p} OR user_name ILIKE $${p} OR connection_name ILIKE $${p})`);
    params.push(`%${search.trim()}%`);
    p++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total (for pagination)
  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM activity_log ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0].total, 10);

  // Paginated rows — always include company_domain in SELECT so the
  // route-layer serializer can run a final per-row guard
  const { rows } = await pool.query(
    `SELECT id, user_id, user_email, user_name, user_role, action_type,
            detail, connection_id, connection_name, result, duration_ms,
            ip_address, created_at, company_domain
     FROM activity_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    [...params, limit, offset]
  );

  return { rows, total };
}

/**
 * Summary stats: counts grouped by action type and result within a date range,
 * scoped to visible user IDs AND company domain.
 */
async function getActivityStats({
  viewerUserId,
  viewerCompanyDomain = null,
  isAdmin = false,
  teamMemberIds = [],
  dateFrom,
  dateTo,
}) {
  const params = [];
  let p = 1;
  const conditions = [];

  // Company-domain isolation always applied
  if (viewerCompanyDomain) {
    conditions.push(`(company_domain = $${p++} OR (company_domain IS NULL AND user_id = $${p++}))`);
    params.push(viewerCompanyDomain, viewerUserId);
  } else {
    conditions.push(`user_id = $${p++}`);
    params.push(viewerUserId);
  }

  if (!isAdmin) {
    const visibleIds = [viewerUserId, ...teamMemberIds].filter(Boolean);
    conditions.push(`user_id = ANY($${p++})`);
    params.push(visibleIds);
  }
  if (dateFrom) {
    conditions.push(`created_at >= $${p++}`);
    params.push(new Date(dateFrom));
  }
  if (dateTo) {
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(`created_at <= $${p++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [totalsRes, typeRes, activeUsersRes] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) AS total_actions,
         COUNT(*) FILTER (WHERE result = 'failed') AS failed_count,
         COUNT(*) FILTER (WHERE action_type IN ('sql_execution','ssh_execution','db_op','ebs_op')) AS execution_count,
         COUNT(*) FILTER (WHERE action_type = 'approval') AS approval_count
       FROM activity_log ${where}`,
      params
    ),
    pool.query(
      `SELECT action_type, COUNT(*) AS cnt
       FROM activity_log ${where}
       GROUP BY action_type ORDER BY cnt DESC`,
      params
    ),
    pool.query(
      `SELECT COUNT(DISTINCT user_id) AS active_users
       FROM activity_log ${where}`,
      params
    ),
  ]);

  return {
    totals: totalsRes.rows[0],
    byType: typeRes.rows,
    activeUsers: activeUsersRes.rows[0].active_users,
  };
}

/**
 * Fetch all rows (no pagination) for CSV/PDF export respecting same filters.
 * Hard-capped at 10,000 rows for safety.
 */
async function exportActivity(queryOpts) {
  const extended = { ...queryOpts, limit: 10000, offset: 0 };
  const { rows } = await queryActivity(extended);
  return rows;
}

module.exports = {
  logActivity,
  queryActivity,
  getActivityStats,
  exportActivity,
  ACTION_TYPES,
};
