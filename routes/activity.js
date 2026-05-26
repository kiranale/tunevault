'use strict';

/**
 * routes/activity.js — Activity Dashboard & Audit Log.
 *
 * Owns: GET /activity (page), GET /api/activity (log query + pagination),
 *       GET /api/activity/stats (summary cards), GET /api/activity/users (team member list),
 *       GET /api/activity/connections (connection list for filter dropdown),
 *       GET /api/activity/export/csv, GET /api/activity/export/pdf.
 * Does NOT own: auth, DB queries (db/activity-log.js), tier enforcement.
 *
 * ISOLATION CONTRACT: every API response is company-scoped to req.user.company_domain.
 * Platform admins (ADMIN_EMAILS) see their own company on this route; cross-company
 * visibility is restricted to /admin/... routes only, never here.
 * A defense-in-depth serializer strips any row whose company_domain differs from the
 * viewer's before the response body is written.
 */

const path = require('path');
const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth } = require('../middleware/auth');
const { ADMIN_EMAILS } = require('../middleware/auth');
const db = require('../db/activity-log');
const pool = require('../db/index');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve visibility context for the current user:
 * - team admins: all team members (within company)
 * - individuals: own rows only
 * Note: platform admins are NOT given cross-company visibility here;
 *       their isAdmin=true only suppresses the user_id filter within their company.
 */
async function resolveVisibility(userId, userEmail) {
  // Platform admins see all rows within their company (no user_id filter),
  // but are still scoped to company_domain — same as regular users otherwise.
  const isPlatformAdmin = ADMIN_EMAILS.has((userEmail || '').toLowerCase());

  // Check if user owns or belongs to a team
  const roleRes = await pool.query(
    `SELECT tm.role, t.owner_id, t.id AS team_id
     FROM teams t
     LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
     WHERE t.owner_id = $1 OR tm.user_id = $1
     LIMIT 1`,
    [userId]
  );

  if (roleRes.rows.length === 0) {
    // Individual account — own rows only (or all rows within company if platform admin)
    return { isAdmin: isPlatformAdmin, isTeamAdmin: false, teamMemberIds: [] };
  }

  const isOwner = roleRes.rows.some(r => r.owner_id === userId);
  const teamRole = roleRes.rows[0]?.role;
  const isTeamAdmin = isPlatformAdmin || isOwner || teamRole === 'admin' || teamRole === 'senior_dba';

  let teamMemberIds = [];
  if (isTeamAdmin) {
    // Fetch member IDs scoped to the team the user is an admin of.
    // Uses the specific team_id from above so we never bleed into other teams.
    const teamId = roleRes.rows[0].team_id;
    const membersRes = await pool.query(
      `SELECT tm.user_id FROM team_members tm WHERE tm.team_id = $1`,
      [teamId]
    );
    teamMemberIds = membersRes.rows.map(r => r.user_id);
    // Always include the owner themselves
    if (!teamMemberIds.includes(userId)) teamMemberIds.push(userId);
  }

  return { isAdmin: isPlatformAdmin, isTeamAdmin, teamMemberIds };
}

/**
 * Defense-in-depth serializer guard.
 * Drops any row whose company_domain doesn't match the viewer's before the
 * response is written. This is the last line of defense against query bugs.
 *
 * Also strips company_domain from outbound rows (internal isolation field).
 *
 * @param {Array} rows
 * @param {string|null} viewerCompanyDomain
 * @param {number} viewerUserId
 * @returns {Array}
 */
function guardRows(rows, viewerCompanyDomain, viewerUserId) {
  return rows
    .filter(row => {
      // Legacy rows (NULL company_domain) are only visible to their owner
      if (row.company_domain === null || row.company_domain === undefined) {
        return row.user_id === viewerUserId;
      }
      // Normal rows must belong to viewer's company
      return row.company_domain === viewerCompanyDomain;
    })
    .map(({ company_domain, ...rest }) => rest); // strip internal field
}

/**
 * Parse and validate filter query params from req.query.
 */
function parseFilters(query) {
  const {
    date_from, date_to,
    user_id, action_types, connection_id,
    result, search,
    limit = '50', offset = '0',
  } = query;

  const actionTypes = action_types
    ? (Array.isArray(action_types) ? action_types : action_types.split(',').map(s => s.trim()).filter(Boolean))
    : [];

  return {
    dateFrom: date_from || null,
    dateTo: date_to || null,
    filterUserId: user_id ? parseInt(user_id, 10) : null,
    actionTypes,
    connectionId: connection_id ? parseInt(connection_id, 10) : null,
    result: result || null,
    search: search || null,
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
  };
}

// ── Page route ────────────────────────────────────────────────────────────────

router.get('/activity', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/activity.html'));
});

// ── API: summary stats ────────────────────────────────────────────────────────

router.get('/api/activity/stats', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);
    const { date_from, date_to } = req.query;

    const stats = await db.getActivityStats({
      viewerUserId: req.user.id,
      viewerCompanyDomain: req.user.company_domain || null,
      isAdmin: vis.isAdmin,
      teamMemberIds: vis.teamMemberIds,
      dateFrom: date_from || null,
      dateTo: date_to || null,
    });

    res.json({ data: stats });
  } catch (err) {
    console.error('[activity] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── API: team users (for filter dropdown) ────────────────────────────────────

router.get('/api/activity/users', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);

    let rows = [];
    if (vis.isAdmin && req.user.company_domain) {
      // Platform admin: all users in same company domain
      const r = await pool.query(
        `SELECT DISTINCT al.user_id AS id, al.user_email AS email, al.user_name AS name
         FROM activity_log al
         WHERE al.user_id IS NOT NULL
           AND al.company_domain = $1
         ORDER BY al.user_email
         LIMIT 200`,
        [req.user.company_domain]
      );
      rows = r.rows;
    } else if (vis.isTeamAdmin && vis.teamMemberIds.length > 0) {
      const r = await pool.query(
        `SELECT id, email, name FROM users
         WHERE id = ANY($1)
         ORDER BY email`,
        [vis.teamMemberIds]
      );
      rows = r.rows;
    } else {
      rows = [{ id: req.user.id, email: req.user.email, name: req.user.name }];
    }

    res.json({ data: rows });
  } catch (err) {
    console.error('[activity] users error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── API: connections (for filter dropdown) ────────────────────────────────────

router.get('/api/activity/connections', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);
    let rows = [];

    if (vis.isAdmin && req.user.company_domain) {
      const r = await pool.query(
        `SELECT DISTINCT connection_id AS id, connection_name AS name
         FROM activity_log
         WHERE connection_id IS NOT NULL
           AND company_domain = $1
         ORDER BY connection_name
         LIMIT 200`,
        [req.user.company_domain]
      );
      rows = r.rows;
    } else {
      const visibleIds = [req.user.id, ...vis.teamMemberIds];
      const r = await pool.query(
        `SELECT DISTINCT al.connection_id AS id, al.connection_name AS name
         FROM activity_log al
         WHERE al.user_id = ANY($1) AND al.connection_id IS NOT NULL
           AND (al.company_domain = $2 OR (al.company_domain IS NULL AND al.user_id = $3))
         ORDER BY al.connection_name
         LIMIT 200`,
        [visibleIds, req.user.company_domain || '', req.user.id]
      );
      rows = r.rows;
    }

    res.json({ data: rows });
  } catch (err) {
    console.error('[activity] connections error:', err.message);
    res.status(500).json({ error: 'Failed to load connections' });
  }
});

// ── API: query activity log ───────────────────────────────────────────────────

router.get('/api/activity', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);
    const filters = parseFilters(req.query);

    const { rows: rawRows, total } = await db.queryActivity({
      viewerUserId: req.user.id,
      viewerCompanyDomain: req.user.company_domain || null,
      isAdmin: vis.isAdmin,
      isTeamAdmin: vis.isTeamAdmin,
      teamMemberIds: vis.teamMemberIds,
      ...filters,
    });

    // Defense-in-depth: strip any row that escaped the DB filter
    const rows = guardRows(rawRows, req.user.company_domain || null, req.user.id);

    // Adjust total if guard dropped rows (rare — indicates a query bug worth logging)
    if (rows.length !== rawRows.length) {
      console.error(
        `[activity] ISOLATION GUARD dropped ${rawRows.length - rows.length} rows ` +
        `for user ${req.user.id} (company: ${req.user.company_domain})`
      );
    }

    res.json({
      data: rows,
      total,
      limit: filters.limit,
      offset: filters.offset,
    });
  } catch (err) {
    console.error('[activity] query error:', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// ── API: CSV export ───────────────────────────────────────────────────────────

router.get('/api/activity/export/csv', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);
    const filters = parseFilters(req.query);

    const rawRows = await db.exportActivity({
      viewerUserId: req.user.id,
      viewerCompanyDomain: req.user.company_domain || null,
      isAdmin: vis.isAdmin,
      isTeamAdmin: vis.isTeamAdmin,
      teamMemberIds: vis.teamMemberIds,
      ...filters,
    });

    // Defense-in-depth guard before writing CSV bytes
    const rows = guardRows(rawRows, req.user.company_domain || null, req.user.id);

    const csvLines = [
      'Timestamp,User,Email,Role,Action Type,Connection,Result,Duration (ms),Detail',
    ];

    for (const row of rows) {
      const detail = row.detail ? JSON.stringify(row.detail).replace(/"/g, '""') : '';
      csvLines.push([
        `"${new Date(row.created_at).toISOString()}"`,
        `"${(row.user_name || '').replace(/"/g, '""')}"`,
        `"${(row.user_email || '').replace(/"/g, '""')}"`,
        `"${(row.user_role || '').replace(/"/g, '""')}"`,
        `"${row.action_type}"`,
        `"${(row.connection_name || '').replace(/"/g, '""')}"`,
        `"${row.result}"`,
        `"${row.duration_ms != null ? row.duration_ms : ''}"`,
        `"${detail}"`,
      ].join(','));
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tunevault-activity-${dateStr}.csv"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    console.error('[activity] csv export error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── API: PDF export ───────────────────────────────────────────────────────────

router.get('/api/activity/export/pdf', requireAuth, async (req, res) => {
  try {
    const vis = await resolveVisibility(req.user.id, req.user.email);
    const filters = parseFilters(req.query);

    const [rawRows, statsData] = await Promise.all([
      db.exportActivity({
        viewerUserId: req.user.id,
        viewerCompanyDomain: req.user.company_domain || null,
        isAdmin: vis.isAdmin,
        isTeamAdmin: vis.isTeamAdmin,
        teamMemberIds: vis.teamMemberIds,
        ...filters,
      }),
      db.getActivityStats({
        viewerUserId: req.user.id,
        viewerCompanyDomain: req.user.company_domain || null,
        isAdmin: vis.isAdmin,
        teamMemberIds: vis.teamMemberIds,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
    ]);

    // Defense-in-depth guard before writing PDF bytes
    const rows = guardRows(rawRows, req.user.company_domain || null, req.user.id);

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tunevault-activity-${dateStr}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    // ── Cover page ──
    doc.rect(0, 0, doc.page.width, 140).fill('#0a0a0c');
    doc.fill('#f0a830').fontSize(22).font('Helvetica-Bold').text('TuneVault', 50, 50);
    doc.fill('#e8e8ed').fontSize(14).font('Helvetica').text('Activity & Audit Report', 50, 80);

    const fromLabel = filters.dateFrom ? new Date(filters.dateFrom).toLocaleDateString() : 'All time';
    const toLabel = filters.dateTo ? new Date(filters.dateTo).toLocaleDateString() : 'Today';
    doc.fill('#8888a0').fontSize(10).text(`Period: ${fromLabel} – ${toLabel}   |   Generated: ${new Date().toLocaleString()}   |   By: ${req.user.email}`, 50, 108);

    doc.fill('#0a0a0c');
    doc.moveDown(3);

    // ── Summary stats ──
    doc.fill('#1a1a1f').rect(50, doc.y, doc.page.width - 100, 80).fill();
    const sy = doc.y;
    doc.fill('#e8e8ed').fontSize(11).font('Helvetica-Bold').text('Summary', 66, sy + 12);

    const totals = statsData.totals || {};
    const summaryLines = [
      `Total Actions: ${totals.total_actions || 0}`,
      `Executions: ${totals.execution_count || 0}`,
      `Approvals: ${totals.approval_count || 0}`,
      `Failed: ${totals.failed_count || 0}`,
      `Active Users: ${statsData.activeUsers || 0}`,
    ];
    doc.fill('#8888a0').fontSize(9).font('Helvetica');
    summaryLines.forEach((line, i) => {
      doc.text(line, 66 + (i * 100), sy + 30);
    });
    doc.moveDown(5);

    // ── Activity table ──
    doc.fill('#e8e8ed').fontSize(12).font('Helvetica-Bold').text('Activity Log', 50);
    doc.moveDown(0.5);

    // Table headers
    const cols = [
      { label: 'Timestamp',   x: 50,  w: 110 },
      { label: 'User',        x: 160, w: 100 },
      { label: 'Action',      x: 260, w: 80  },
      { label: 'Connection',  x: 340, w: 90  },
      { label: 'Result',      x: 430, w: 55  },
      { label: 'Duration',    x: 485, w: 60  },
    ];

    const drawHeader = () => {
      const hy = doc.y;
      doc.rect(50, hy, doc.page.width - 100, 18).fill('#1a1a1f');
      doc.fill('#f0a830').fontSize(8).font('Helvetica-Bold');
      cols.forEach(c => doc.text(c.label, c.x + 2, hy + 4, { width: c.w - 4 }));
      doc.moveDown(0.1);
    };

    drawHeader();
    let rowIdx = 0;

    for (const row of rows) {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
        drawHeader();
      }

      const ry = doc.y;
      const bg = rowIdx % 2 === 0 ? '#111114' : '#0e0e11';
      doc.rect(50, ry, doc.page.width - 100, 16).fill(bg);

      const ts = new Date(row.created_at).toLocaleString();
      const user = row.user_name || row.user_email || '—';
      const action = row.action_type.replace(/_/g, ' ');
      const conn = row.connection_name || '—';
      const res = row.result || '—';
      const dur = row.duration_ms != null ? `${row.duration_ms}ms` : '—';

      doc.fill('#e8e8ed').fontSize(7.5).font('Helvetica');
      doc.text(ts, cols[0].x + 2, ry + 4, { width: cols[0].w - 4 });
      doc.text(user, cols[1].x + 2, ry + 4, { width: cols[1].w - 4 });

      const resultColor = res === 'success' ? '#34d399' : res === 'failed' ? '#f87171' : '#8888a0';
      doc.fill('#a78bfa').text(action, cols[2].x + 2, ry + 4, { width: cols[2].w - 4 });
      doc.fill('#e8e8ed').text(conn, cols[3].x + 2, ry + 4, { width: cols[3].w - 4 });
      doc.fill(resultColor).text(res, cols[4].x + 2, ry + 4, { width: cols[4].w - 4 });
      doc.fill('#8888a0').text(dur, cols[5].x + 2, ry + 4, { width: cols[5].w - 4 });

      doc.moveDown(0.05);
      rowIdx++;
    }

    // ── Footer ──
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fill('#8888a0').fontSize(8).font('Helvetica')
        .text(`Generated by TuneVault  ·  Page ${i + 1} of ${pageCount}`, 50, doc.page.height - 30, { align: 'center' });
    }

    doc.end();
  } catch (err) {
    console.error('[activity] pdf export error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
