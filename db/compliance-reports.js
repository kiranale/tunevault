'use strict';

/**
 * db/compliance-reports.js — compliance_reports table CRUD.
 *
 * Owns: reading and writing compliance_reports records (SOX, Access Audit, Activity Summary).
 * Does NOT own: report data assembly (routes/compliance-reports.js), PDF rendering (same).
 */

const pool = require('./index');

/**
 * Save a generated compliance report record.
 * @param {Object} opts
 * @param {number}  opts.userId
 * @param {string}  opts.companyDomain — mandatory for isolation
 * @param {string}  opts.reportType    — 'sox_change'|'access_audit'|'activity_summary'
 * @param {string}  opts.title
 * @param {Date}    opts.dateFrom
 * @param {Date}    opts.dateTo
 * @param {string}  opts.generatedBy   — user name / email
 * @param {Object}  opts.generatedData — full data blob for CSV re-export
 * @param {Object}  opts.rowCounts     — { section: count } summary for list view
 * @returns {Promise<Object>} inserted row
 */
async function saveReport({ userId, companyDomain, reportType, title, dateFrom, dateTo, generatedBy, generatedData, rowCounts }) {
  const { rows } = await pool.query(
    `INSERT INTO compliance_reports
       (user_id, company_domain, report_type, title, date_from, date_to, generated_by, generated_data, row_counts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [userId, companyDomain, reportType, title, dateFrom, dateTo, generatedBy, JSON.stringify(generatedData), JSON.stringify(rowCounts)]
  );
  return rows[0];
}

/**
 * List compliance reports for a user (newest first).
 * Scoped to company_domain — a user never sees reports from other companies.
 * @param {number} userId
 * @param {string} companyDomain
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function listReports(userId, companyDomain, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, report_type, title, date_from, date_to, generated_at, generated_by, row_counts, status
     FROM compliance_reports
     WHERE user_id = $1 AND company_domain = $2
     ORDER BY generated_at DESC
     LIMIT $3`,
    [userId, companyDomain, limit]
  );
  return rows;
}

/**
 * Get a single report by ID (ownership-checked + company-scoped).
 * @param {number} reportId
 * @param {number} userId
 * @param {string} companyDomain
 * @returns {Promise<Object|null>}
 */
async function getReport(reportId, userId, companyDomain) {
  const { rows } = await pool.query(
    `SELECT * FROM compliance_reports WHERE id = $1 AND user_id = $2 AND company_domain = $3`,
    [reportId, userId, companyDomain]
  );
  return rows[0] || null;
}

/**
 * Delete a report (ownership-checked + company-scoped).
 * @param {number} reportId
 * @param {number} userId
 * @param {string} companyDomain
 * @returns {Promise<boolean>} true if deleted
 */
async function deleteReport(reportId, userId, companyDomain) {
  const result = await pool.query(
    `DELETE FROM compliance_reports WHERE id = $1 AND user_id = $2 AND company_domain = $3`,
    [reportId, userId, companyDomain]
  );
  return result.rowCount > 0;
}

// ── Data assembly queries ─────────────────────────────────────────────────────
// These are used by the route to fetch source data for each report type.
// Ownership is enforced via user_id on oracle_connections / users.

/**
 * SOX Change Report data: health check runs + ssh_audit + db ops via analytics_events.
 * Returns operations sorted by executed_at DESC within date range.
 * ISOLATION: companyDomain is applied to all source table joins.
 *
 * @param {number} userId
 * @param {string} companyDomain — mandatory for isolation
 * @param {Date} dateFrom
 * @param {Date} dateTo
 */
async function getSoxData(userId, companyDomain, dateFrom, dateTo) {
  // Health check runs (change events) — scoped to company via users (via connection owner)
  const { rows: hcRuns } = await pool.query(
    `SELECT hc.id, hc.connection_id, oc.name AS connection_name,
            hc.status, hc.score, hc.created_at AS executed_at,
            u.email AS executed_by, u.name AS executed_by_name,
            'health_check' AS change_type
     FROM health_checks hc
     JOIN oracle_connections oc ON oc.id = hc.connection_id
     JOIN users u ON u.id = hc.user_id
     JOIN users ou ON ou.id = oc.user_id
     WHERE oc.user_id = $1
       AND ou.company_domain = $2
       AND hc.created_at >= $3
       AND hc.created_at <= $4
       AND hc.is_demo = false
     ORDER BY hc.created_at DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // SSH executions (DB ops / EBS ops) — scoped to company via user ownership
  const { rows: sshOps } = await pool.query(
    `SELECT sa.id, sa.target_id, sa.command_key, sa.rendered_command,
            sa.exit_code, sa.duration_ms, sa.was_rejected, sa.rejection_reason,
            sa.initiated_by, st.host, st.role,
            sa.created_at AS executed_at,
            'ssh_operation' AS change_type
     FROM ssh_audit sa
     JOIN ssh_targets st ON st.id = sa.target_id
     WHERE (
       -- User's own targets
       (st.user_id = $1)
       OR
       -- Admin targets (NULL user_id) where the initiator is in the same company
       (st.user_id IS NULL AND sa.initiated_by IN (
         SELECT email FROM users WHERE company_domain = $2
       ))
     )
     AND sa.created_at >= $3
     AND sa.created_at <= $4
     ORDER BY sa.created_at DESC
     LIMIT 500`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // Analytics events as proxy for DB ops / EBS ops executions — scoped to company via users
  const { rows: opEvents } = await pool.query(
    `SELECT ae.id, ae.event_name, ae.properties, ae.occurred_at AS executed_at,
            u.email AS executed_by, u.name AS executed_by_name,
            'db_operation' AS change_type
     FROM analytics_events ae
     JOIN users u ON u.id = ae.user_id
     WHERE u.id = $1
       AND u.company_domain = $2
       AND ae.event_name IN ('db_op_executed', 'ebs_op_executed', 'sql_executed', 'ebs_ssh_executed')
       AND ae.occurred_at >= $3
       AND ae.occurred_at <= $4
     ORDER BY ae.occurred_at DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  return { hcRuns, sshOps, opEvents };
}

/**
 * Access Audit Report data: logins, role changes, team member activity.
 * ISOLATION: companyDomain applied to all source table joins.
 *
 * @param {number} userId
 * @param {string} companyDomain — mandatory for isolation
 * @param {Date} dateFrom
 * @param {Date} dateTo
 */
async function getAccessData(userId, companyDomain, dateFrom, dateTo) {
  // Login events from analytics_events — scoped to company via users
  const { rows: logins } = await pool.query(
    `SELECT ae.id, ae.event_name AS login_method, ae.properties,
            ae.occurred_at, ae.session_id,
            u.email, u.name
     FROM analytics_events ae
     JOIN users u ON u.id = ae.user_id
     WHERE u.id = $1
       AND u.company_domain = $2
       AND ae.event_name IN ('login_completed', 'signup_completed', 'google_login', 'magic_link_login', 'sso_login')
       AND ae.occurred_at >= $3
       AND ae.occurred_at <= $4
     ORDER BY ae.occurred_at DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // Team members with roles (current state) — scoped to company via users
  const { rows: teamMembers } = await pool.query(
    `SELECT tm.user_id, u.email, u.name, tm.role, tm.created_at AS joined_at,
            t.name AS team_name
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     JOIN teams t ON t.id = tm.team_id
     WHERE t.owner_id = $1
       AND u.company_domain = $2
     ORDER BY tm.created_at DESC`,
    [userId, companyDomain]
  );

  // Team invites (pending / accepted) — scoped to company via team ownership
  const { rows: invites } = await pool.query(
    `SELECT ti.email, ti.role, ti.status, ti.created_at, ti.expires_at, ti.accepted_at
     FROM team_invites ti
     JOIN teams t ON t.id = ti.team_id
     WHERE t.owner_id = $1
       AND t.id IN (
         SELECT tm.team_id FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE u.company_domain = $2
       )
       AND ti.created_at >= $3
       AND ti.created_at <= $4
     ORDER BY ti.created_at DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // RBAC denials log — scoped to company via users
  const { rows: rbacDenials } = await pool.query(
    `SELECT ral.user_id, u.email, u.name, ral.method, ral.path,
            ral.required_role, ral.actual_role, ral.denied_at
     FROM rbac_audit_log ral
     JOIN users u ON u.id = ral.user_id
     WHERE u.company_domain = $2
       AND (u.id = $1
         OR u.id IN (
           SELECT tm.user_id FROM team_members tm
           JOIN users u2 ON u2.id = tm.user_id
           WHERE u2.company_domain = $2
         ))
     AND ral.denied_at >= $3
     AND ral.denied_at <= $4
     ORDER BY ral.denied_at DESC
     LIMIT 200`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // Connection access (health check runs show who accessed which connections) — scoped via users join
  const { rows: connAccess } = await pool.query(
    `SELECT oc.id AS connection_id, oc.name AS connection_name,
            COUNT(hc.id) AS access_count,
            MAX(hc.created_at) AS last_accessed
     FROM oracle_connections oc
     LEFT JOIN health_checks hc ON hc.connection_id = oc.id
       AND hc.created_at >= $3 AND hc.created_at <= $4
     JOIN users ou ON ou.id = oc.user_id
     WHERE oc.user_id = $1
       AND ou.company_domain = $2
     GROUP BY oc.id, oc.name
     ORDER BY access_count DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  return { logins, teamMembers, invites, rbacDenials, connAccess };
}

/**
 * Activity Summary Report data: per-user breakdown over date range.
 * ISOLATION: companyDomain applied to all source table joins.
 *
 * @param {number} userId
 * @param {string} companyDomain — mandatory for isolation
 * @param {Date} dateFrom
 * @param {Date} dateTo
 */
async function getActivityData(userId, companyDomain, dateFrom, dateTo) {
  // Per-user event counts (for team members in same company)
  const { rows: userActivity } = await pool.query(
    `SELECT u.id AS user_id, u.email, u.name,
            COUNT(ae.id) FILTER (WHERE ae.event_name IN ('login_completed','google_login','magic_link_login','sso_login')) AS total_logins,
            COUNT(ae.id) FILTER (WHERE ae.event_name IN ('db_op_executed','ebs_op_executed','sql_executed','ebs_ssh_executed')) AS total_executions,
            COUNT(ae.id) FILTER (WHERE ae.event_name = 'health_check_completed') AS total_health_checks,
            MIN(ae.occurred_at) AS first_active,
            MAX(ae.occurred_at) AS last_active
     FROM users u
     LEFT JOIN analytics_events ae ON ae.user_id = u.id
       AND ae.occurred_at >= $3 AND ae.occurred_at <= $4
     WHERE u.company_domain = $2
       AND (u.id = $1
         OR u.id IN (
           SELECT tm.user_id FROM team_members tm
           JOIN users u2 ON u2.id = tm.user_id
           WHERE u2.company_domain = $2
         ))
     GROUP BY u.id, u.email, u.name
     ORDER BY total_logins DESC NULLS LAST`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // Per-connection execution summary — scoped via users join on connection owner
  const { rows: connActivity } = await pool.query(
    `SELECT oc.id AS connection_id, oc.name AS connection_name, oc.host,
            COUNT(hc.id) AS health_check_count,
            MAX(hc.created_at) AS last_checked,
            MIN(hc.created_at) AS first_checked
     FROM oracle_connections oc
     LEFT JOIN health_checks hc ON hc.connection_id = oc.id
       AND hc.created_at >= $3 AND hc.created_at <= $4
       AND hc.is_demo = false
     JOIN users ou ON ou.id = oc.user_id
     WHERE oc.user_id = $1
       AND ou.company_domain = $2
     GROUP BY oc.id, oc.name, oc.host
     ORDER BY health_check_count DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  // Aggregate event breakdown — scoped to company via users
  const { rows: eventSummary } = await pool.query(
    `SELECT event_name, COUNT(*) AS count
     FROM analytics_events ae
     JOIN users u ON u.id = ae.user_id
     WHERE u.id = $1
       AND u.company_domain = $2
       AND ae.occurred_at >= $3 AND ae.occurred_at <= $4
     GROUP BY ae.event_name
     ORDER BY count DESC`,
    [userId, companyDomain, dateFrom, dateTo]
  );

  return { userActivity, connActivity, eventSummary };
}

module.exports = {
  saveReport,
  listReports,
  getReport,
  deleteReport,
  getSoxData,
  getAccessData,
  getActivityData,
};
