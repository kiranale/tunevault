/**
 * routes/v1-api.js — REST API v1 read-only endpoints.
 * Owns: /api/v1/* — health data, TuneOps tickets, activity log, team endpoints.
 * Does NOT own: API key management (routes/settings-api.js), auth middleware (middleware/api-auth.js).
 *
 * All endpoints require a valid API key via Authorization: Bearer tv_api_XXXX.
 * Access is tier-gated: enterprise=all, business=health+tuneops, team=health only.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/index');
const { requireApiKey } = require('../middleware/api-auth');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a standard paginated response envelope.
 */
function paginate(rows, total, page, perPage) {
  return {
    data: rows,
    meta: {
      total,
      page,
      per_page: perPage,
      has_more: page * perPage < total,
    },
  };
}

/**
 * Parse ?page and ?per_page query params with sane defaults and maximums.
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page, 10) || 50));
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
}

// ── Health: Connections ───────────────────────────────────────────────────────

// GET /api/v1/health/connections — list all connections with latest health score
router.get('/health/connections', requireApiKey('health'), async (req, res) => {
  try {
    const { page, perPage, offset } = parsePagination(req.query);
    const userId = req.apiUser.id;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM oracle_connections WHERE user_id = $1`,
      [userId]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const { rows } = await pool.query(
      `SELECT oc.id, oc.name, oc.host, oc.port, oc.service_name,
              oc.connection_type, oc.created_at, oc.updated_at,
              hc.id AS latest_check_id, hc.score, hc.created_at AS last_checked_at,
              hc.summary_text, hc.analysis_stage
       FROM oracle_connections oc
       LEFT JOIN LATERAL (
         SELECT id, score, created_at, summary_text, analysis_stage
         FROM health_checks
         WHERE connection_id = oc.id
         ORDER BY created_at DESC
         LIMIT 1
       ) hc ON true
       WHERE oc.user_id = $1
       ORDER BY oc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, perPage, offset]
    );

    res.json(paginate(rows, total, page, perPage));
  } catch (err) {
    console.error('[v1-api] GET /health/connections error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch connections' } });
  }
});

// GET /api/v1/health/connections/:id — single connection health summary
router.get('/health/connections/:id', requireApiKey('health'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const connId = parseInt(req.params.id, 10);

    const { rows } = await pool.query(
      `SELECT oc.id, oc.name, oc.host, oc.port, oc.service_name,
              oc.connection_type, oc.created_at, oc.updated_at,
              hc.id AS latest_check_id, hc.score, hc.created_at AS last_checked_at,
              hc.summary_text, hc.top_action, hc.analysis_stage,
              hc.ebs_summary, hc.ebs_action
       FROM oracle_connections oc
       LEFT JOIN LATERAL (
         SELECT id, score, created_at, summary_text, top_action, analysis_stage, ebs_summary, ebs_action
         FROM health_checks
         WHERE connection_id = oc.id
         ORDER BY created_at DESC
         LIMIT 1
       ) hc ON true
       WHERE oc.id = $1 AND oc.user_id = $2`,
      [connId, userId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Connection not found' } });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[v1-api] GET /health/connections/:id error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch connection' } });
  }
});

// GET /api/v1/health/connections/:id/checks — health check history
router.get('/health/connections/:id/checks', requireApiKey('health'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const connId = parseInt(req.params.id, 10);
    const { page, perPage, offset } = parsePagination(req.query);

    // Verify ownership
    const ownerCheck = await pool.query(
      `SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2`,
      [connId, userId]
    );
    if (!ownerCheck.rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Connection not found' } });
    }

    // Date range filter
    let dateClause = '';
    const params = [connId];
    if (req.query.from) {
      params.push(req.query.from);
      dateClause += ` AND created_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      dateClause += ` AND created_at <= $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM health_checks WHERE connection_id = $1${dateClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(perPage, offset);
    const { rows } = await pool.query(
      `SELECT id, score, analysis_stage, summary_text, top_action,
              ebs_summary, ebs_action, created_at
       FROM health_checks
       WHERE connection_id = $1${dateClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginate(rows, total, page, perPage));
  } catch (err) {
    console.error('[v1-api] GET /health/connections/:id/checks error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch checks' } });
  }
});

// GET /api/v1/health/connections/:id/checks/latest — most recent check results
router.get('/health/connections/:id/checks/latest', requireApiKey('health'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const connId = parseInt(req.params.id, 10);

    // Verify ownership
    const ownerCheck = await pool.query(
      `SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2`,
      [connId, userId]
    );
    if (!ownerCheck.rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Connection not found' } });
    }

    // Get latest health check
    const hcResult = await pool.query(
      `SELECT id, score, analysis_stage, summary_text, top_action,
              ebs_summary, ebs_action, created_at
       FROM health_checks
       WHERE connection_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [connId]
    );
    if (!hcResult.rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'No health checks found for this connection' } });
    }

    const hc = hcResult.rows[0];

    // Get individual check results
    const { rows: checkRows } = await pool.query(
      `SELECT check_id, category, status, title, metric_line, remediation, severity
       FROM check_results
       WHERE health_check_id = $1
       ORDER BY category, check_id`,
      [hc.id]
    );

    res.json({
      data: {
        ...hc,
        checks: checkRows,
      }
    });
  } catch (err) {
    console.error('[v1-api] GET /health/connections/:id/checks/latest error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch latest check' } });
  }
});

// GET /api/v1/health/connections/:id/checks/:checkId — single check detail
router.get('/health/connections/:id/checks/:checkId', requireApiKey('health'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const connId = parseInt(req.params.id, 10);
    const checkId = parseInt(req.params.checkId, 10);

    // Verify ownership
    const ownerCheck = await pool.query(
      `SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2`,
      [connId, userId]
    );
    if (!ownerCheck.rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Connection not found' } });
    }

    const { rows } = await pool.query(
      `SELECT hc.id, hc.score, hc.analysis_stage, hc.summary_text, hc.top_action,
              hc.ebs_summary, hc.ebs_action, hc.created_at,
              json_agg(
                json_build_object(
                  'check_id', cr.check_id,
                  'category', cr.category,
                  'status', cr.status,
                  'title', cr.title,
                  'metric_line', cr.metric_line,
                  'remediation', cr.remediation,
                  'severity', cr.severity
                ) ORDER BY cr.category, cr.check_id
              ) AS checks
       FROM health_checks hc
       LEFT JOIN check_results cr ON cr.health_check_id = hc.id
       WHERE hc.id = $1 AND hc.connection_id = $2
       GROUP BY hc.id`,
      [checkId, connId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Health check not found' } });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[v1-api] GET /health/connections/:id/checks/:checkId error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch check detail' } });
  }
});

// GET /api/v1/health/fleet — fleet dashboard (all connections, scores, alerts)
router.get('/health/fleet', requireApiKey('health'), async (req, res) => {
  try {
    const userId = req.apiUser.id;

    const { rows } = await pool.query(
      `SELECT oc.id, oc.name, oc.host, oc.connection_type,
              hc.score, hc.created_at AS last_checked_at, hc.summary_text,
              hc.analysis_stage,
              CASE
                WHEN hc.score IS NULL THEN 'never_run'
                WHEN hc.score >= 80 THEN 'healthy'
                WHEN hc.score >= 60 THEN 'warning'
                ELSE 'critical'
              END AS status
       FROM oracle_connections oc
       LEFT JOIN LATERAL (
         SELECT score, created_at, summary_text, analysis_stage
         FROM health_checks
         WHERE connection_id = oc.id
         ORDER BY created_at DESC
         LIMIT 1
       ) hc ON true
       WHERE oc.user_id = $1
       ORDER BY oc.name`,
      [userId]
    );

    const summary = {
      total: rows.length,
      healthy: rows.filter(r => r.status === 'healthy').length,
      warning: rows.filter(r => r.status === 'warning').length,
      critical: rows.filter(r => r.status === 'critical').length,
      never_run: rows.filter(r => r.status === 'never_run').length,
    };

    res.json({ data: rows, summary });
  } catch (err) {
    console.error('[v1-api] GET /health/fleet error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch fleet data' } });
  }
});

// ── TuneOps Tickets ───────────────────────────────────────────────────────────

// GET /api/v1/tuneops/tickets — list tickets
router.get('/tuneops/tickets', requireApiKey('tuneops'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const { page, perPage, offset } = parsePagination(req.query);

    // Build filter clauses
    const params = [userId];
    const filters = [];

    if (req.query.status) {
      params.push(req.query.status);
      filters.push(`f.status = $${params.length}`);
    }
    if (req.query.severity) {
      params.push(req.query.severity);
      filters.push(`f.severity = $${params.length}`);
    }
    if (req.query.connection_id) {
      params.push(parseInt(req.query.connection_id, 10));
      filters.push(`f.connection_id = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      filters.push(`f.first_seen_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      filters.push(`f.first_seen_at <= $${params.length}`);
    }

    const whereExtra = filters.length ? ' AND ' + filters.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)
       FROM finding_history f
       JOIN oracle_connections oc ON oc.id = f.connection_id
       WHERE oc.user_id = $1${whereExtra}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(perPage, offset);
    const { rows } = await pool.query(
      `SELECT f.id, f.connection_id, oc.name AS connection_name,
              f.check_id, f.finding_key, f.title, f.metric_line,
              f.remediation, f.severity,
              f.first_seen_at, f.last_seen_at, f.resolved_at,
              CASE WHEN f.resolved_at IS NOT NULL THEN 'resolved' ELSE 'open' END AS status
       FROM finding_history f
       JOIN oracle_connections oc ON oc.id = f.connection_id
       WHERE oc.user_id = $1${whereExtra}
       ORDER BY f.last_seen_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginate(rows, total, page, perPage));
  } catch (err) {
    console.error('[v1-api] GET /tuneops/tickets error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch tickets' } });
  }
});

// GET /api/v1/tuneops/tickets/:ticketNumber — single ticket detail
router.get('/tuneops/tickets/:ticketNumber', requireApiKey('tuneops'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const ticketId = parseInt(req.params.ticketNumber, 10);

    const { rows } = await pool.query(
      `SELECT f.id, f.connection_id, oc.name AS connection_name,
              f.check_id, f.finding_key, f.title, f.metric_line,
              f.remediation, f.severity,
              f.first_seen_at, f.last_seen_at, f.resolved_at,
              CASE WHEN f.resolved_at IS NOT NULL THEN 'resolved' ELSE 'open' END AS status
       FROM finding_history f
       JOIN oracle_connections oc ON oc.id = f.connection_id
       WHERE f.id = $1 AND oc.user_id = $2`,
      [ticketId, userId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Ticket not found' } });
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[v1-api] GET /tuneops/tickets/:id error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch ticket' } });
  }
});

// GET /api/v1/tuneops/stats — aggregate ticket stats
router.get('/tuneops/stats', requireApiKey('tuneops'), async (req, res) => {
  try {
    const userId = req.apiUser.id;

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE f.resolved_at IS NULL) AS open_count,
         COUNT(*) FILTER (WHERE f.resolved_at >= NOW() - INTERVAL '7 days') AS resolved_this_week,
         COUNT(*) FILTER (WHERE f.severity = 'critical' AND f.resolved_at IS NULL) AS critical_open,
         COUNT(*) FILTER (WHERE f.severity = 'warning' AND f.resolved_at IS NULL) AS warning_open,
         ROUND(AVG(
           EXTRACT(EPOCH FROM (f.resolved_at - f.first_seen_at)) / 3600
         ) FILTER (WHERE f.resolved_at IS NOT NULL), 1) AS avg_resolution_hours
       FROM finding_history f
       JOIN oracle_connections oc ON oc.id = f.connection_id
       WHERE oc.user_id = $1`,
      [userId]
    );

    res.json({ data: rows[0] || {} });
  } catch (err) {
    console.error('[v1-api] GET /tuneops/stats error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch stats' } });
  }
});

// ── Activity Log ──────────────────────────────────────────────────────────────

// GET /api/v1/activity — activity/audit log (enterprise only)
router.get('/activity', requireApiKey('activity'), async (req, res) => {
  try {
    const userId = req.apiUser.id;
    const { page, perPage, offset } = parsePagination(req.query);

    const params = [userId];
    const filters = [];

    if (req.query.action_type) {
      params.push(req.query.action_type);
      filters.push(`ae.event_name = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      filters.push(`ae.occurred_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      filters.push(`ae.occurred_at <= $${params.length}`);
    }

    const whereExtra = filters.length ? ' AND ' + filters.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id = $1${whereExtra}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(perPage, offset);
    const { rows } = await pool.query(
      `SELECT ae.id, ae.event_name AS action_type, ae.page_path,
              ae.session_id, ae.properties, ae.occurred_at
       FROM analytics_events ae
       WHERE ae.user_id = $1${whereExtra}
       ORDER BY ae.occurred_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginate(rows, total, page, perPage));
  } catch (err) {
    console.error('[v1-api] GET /activity error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch activity' } });
  }
});

// GET /api/v1/activity/summary — aggregate activity counts
router.get('/activity/summary', requireApiKey('activity'), async (req, res) => {
  try {
    const userId = req.apiUser.id;

    const params = [userId];
    let dateClause = '';
    if (req.query.from) {
      params.push(req.query.from);
      dateClause += ` AND occurred_at >= $${params.length}`;
    }
    if (req.query.to) {
      params.push(req.query.to);
      dateClause += ` AND occurred_at <= $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT event_name AS action_type, COUNT(*) AS count
       FROM analytics_events
       WHERE user_id = $1${dateClause}
       GROUP BY event_name
       ORDER BY count DESC`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('[v1-api] GET /activity/summary error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch activity summary' } });
  }
});

// ── Team ──────────────────────────────────────────────────────────────────────

// GET /api/v1/team/members — list team members with roles
router.get('/team/members', requireApiKey('team'), async (req, res) => {
  try {
    const userId = req.apiUser.id;

    // Find the team this user belongs to or owns
    const teamResult = await pool.query(
      `SELECT t.id FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE tm.user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (!teamResult.rows[0]) {
      return res.json({ data: [], meta: { total: 0, page: 1, per_page: 50, has_more: false } });
    }

    const teamId = teamResult.rows[0].id;

    const { rows } = await pool.query(
      `SELECT tm.id, tm.user_id, tm.role, tm.joined_at,
              u.email, u.name
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.joined_at ASC`,
      [teamId]
    );

    res.json({ data: rows, meta: { total: rows.length, page: 1, per_page: rows.length, has_more: false } });
  } catch (err) {
    console.error('[v1-api] GET /team/members error:', err.message);
    res.status(500).json({ error: { code: 'internal_error', message: 'Failed to fetch team members' } });
  }
});

// GET /api/v1/team/roles — list roles and their permissions
router.get('/team/roles', requireApiKey('team'), async (req, res) => {
  const roles = [
    {
      role: 'admin',
      label: 'Admin',
      description: 'Full access — manage team, connections, run checks, view all data',
      permissions: ['connections.manage', 'checks.run', 'reports.view', 'team.manage'],
    },
    {
      role: 'senior_dba',
      label: 'Senior DBA',
      description: 'Run checks, view all data, manage connections',
      permissions: ['connections.manage', 'checks.run', 'reports.view'],
    },
    {
      role: 'junior_dba',
      label: 'Junior DBA',
      description: 'Run checks, view reports — no connection management',
      permissions: ['checks.run', 'reports.view'],
    },
    {
      role: 'viewer',
      label: 'Viewer',
      description: 'Read-only access to reports and check results',
      permissions: ['reports.view'],
    },
  ];

  res.json({ data: roles });
});

module.exports = router;
