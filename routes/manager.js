'use strict';

/**
 * routes/manager.js — SDM / Manager executive dashboard.
 *
 * Owns: GET /manager (HTML page), all /api/manager/* endpoints,
 *       weekly PDF generation, manager_role RBAC enforcement.
 * Does NOT own: health check execution, finding mutations, team CRUD,
 *               underlying fleet/clone/audit DB queries (db/manager.js).
 */

const path    = require('path');
const express = require('express');
const PDFDocument = require('pdfkit');

const { requireAuth, ADMIN_EMAILS } = require('../middleware/auth');
const db  = require('../db/manager');
const pool = require('../db/index');

const router = express.Router();

// ─── RBAC helper ─────────────────────────────────────────────────────────────
// Allowed roles: manager, sdm, admin, or the user is in ADMIN_EMAILS.
// Individuals with no manager_role assigned are blocked (managers must be explicit).
// Exception: system ADMIN_EMAILS bypass the role check.

async function requireManagerRole(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const email = (req.user.email || '').toLowerCase();
  if (ADMIN_EMAILS.has(email)) return next(); // system admins always through

  try {
    const { rows } = await pool.query(
      `SELECT manager_role FROM users WHERE id = $1`,
      [req.user.id]
    );
    const role = rows[0]?.manager_role;
    if (db.MANAGER_ROLES.has(role)) return next();

    return res.status(403).json({
      error: 'Manager dashboard requires role: manager, sdm, or admin',
      your_role: role || null,
    });
  } catch (err) {
    console.error('[manager] requireManagerRole error:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

// ─── Convenience: is the current user a system admin? ────────────────────────
function isSystemAdmin(user) {
  return ADMIN_EMAILS.has((user?.email || '').toLowerCase());
}

// ─── GET /manager — HTML page ─────────────────────────────────────────────────
router.get('/manager', requireAuth, requireManagerRole, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'manager.html'));
});

// ─── GET /api/manager/fleet-summary ──────────────────────────────────────────
router.get('/api/manager/fleet-summary', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const isAdmin = isSystemAdmin(req.user);
    const data    = await db.getFleetSummary(req.user.id, isAdmin);
    res.json(data);
  } catch (err) {
    console.error('[manager] fleet-summary error:', err.message);
    res.status(500).json({ error: 'Failed to load fleet summary' });
  }
});

// ─── GET /api/manager/mttr ───────────────────────────────────────────────────
// Query params: days (default 30)
router.get('/api/manager/mttr', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const days    = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const isAdmin = isSystemAdmin(req.user);
    const data    = await db.getMttrTrend(req.user.id, isAdmin, days);
    res.json(data);
  } catch (err) {
    console.error('[manager] mttr error:', err.message);
    res.status(500).json({ error: 'Failed to load MTTR data' });
  }
});

// ─── GET /api/manager/change-calendar ────────────────────────────────────────
// Query params: month (YYYY-MM, defaults to current month)
router.get('/api/manager/change-calendar', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const month   = req.query.month || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const isAdmin = isSystemAdmin(req.user);
    const events  = await db.getChangeCalendar(req.user.id, isAdmin, month);
    res.json({ month, events });
  } catch (err) {
    console.error('[manager] change-calendar error:', err.message);
    res.status(500).json({ error: 'Failed to load change calendar' });
  }
});

// ─── GET /api/manager/audit ───────────────────────────────────────────────────
// Query params: limit, offset, user_id, action_types (comma-sep), result, search
router.get('/api/manager/audit', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const isAdmin = isSystemAdmin(req.user);
    const opts = {
      limit:        Math.min(200, parseInt(req.query.limit, 10)  || 50),
      offset:       parseInt(req.query.offset, 10) || 0,
      filterUserId: req.query.user_id ? parseInt(req.query.user_id, 10) : null,
      actionTypes:  req.query.action_types ? req.query.action_types.split(',').map(s => s.trim()).filter(Boolean) : [],
      result:       req.query.result || null,
      search:       req.query.search || null,
    };
    const data = await db.getAuditSummary(req.user.id, isAdmin, opts);
    res.json(data);
  } catch (err) {
    console.error('[manager] audit error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ─── GET /api/manager/audit/export/csv ───────────────────────────────────────
router.get('/api/manager/audit/export/csv', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const isAdmin = isSystemAdmin(req.user);
    const { rows } = await db.getAuditSummary(req.user.id, isAdmin, { limit: 5000, offset: 0 });

    const headers = ['Timestamp', 'User', 'Role', 'Action', 'Connection', 'Result', 'Duration(ms)'];
    const lines   = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        JSON.stringify(r.created_at || ''),
        JSON.stringify(r.user_email || r.user_name || ''),
        JSON.stringify(r.user_role || ''),
        JSON.stringify(r.action_type || ''),
        JSON.stringify(r.connection_name || ''),
        JSON.stringify(r.result || ''),
        r.duration_ms || '',
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-export-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[manager] audit CSV error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─── POST /api/manager/weekly-pdf ────────────────────────────────────────────
// Body: { email? }  — if email provided, PDF is also sent via Postmark
router.post('/api/manager/weekly-pdf', requireAuth, requireManagerRole, async (req, res) => {
  try {
    const isAdmin = isSystemAdmin(req.user);
    const data    = await db.getWeeklyStatusData(req.user.id, isAdmin);

    const doc = buildWeeklyPdf(data, req.user);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tunevault-weekly-${data.report_date.slice(0,10)}.pdf"`);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('[manager] weekly-pdf error:', err.message);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// ─── GET /api/manager/users — list users with manager_role for admin UI ──────
router.get('/api/manager/users', requireAuth, async (req, res) => {
  if (!isSystemAdmin(req.user)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, manager_role, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[manager] users list error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ─── PATCH /api/manager/users/:id/role — admin sets manager_role ──────────────
router.patch('/api/manager/users/:id/role', requireAuth, async (req, res) => {
  if (!isSystemAdmin(req.user)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { role } = req.body;
  const validRoles = [...db.MANAGER_ROLES, 'dba', 'apps_dba', 'functional', 'developer', null];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Valid: ${[...db.MANAGER_ROLES].join(', ')}, dba, apps_dba, functional, developer, or null` });
  }
  try {
    await pool.query(
      `UPDATE users SET manager_role = $1, updated_at = NOW() WHERE id = $2`,
      [role || null, req.params.id]
    );
    res.json({ ok: true, user_id: req.params.id, manager_role: role });
  } catch (err) {
    console.error('[manager] role update error:', err.message);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ─── Weekly PDF builder ───────────────────────────────────────────────────────

const COLORS = {
  bg:         '#FFFFFF',
  text:       '#1A1A2E',
  textDim:    '#6B6B8A',
  accent:     '#D4871A',
  headerBg:   '#0A0A14',
  headerText: '#FFFFFF',
  green:      '#059669',
  red:        '#DC2626',
  amber:      '#B45309',
  border:     '#E2E4EE',
  rowAlt:     '#F8F9FC',
};

const PAGE_W  = 595;
const PAGE_H  = 842;
const MARGIN  = 44;
const CONTENT = PAGE_W - MARGIN * 2;

function buildWeeklyPdf(data, user) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title:   `TuneVault Weekly Status Report`,
      Author:  user?.name || user?.email || 'TuneVault',
      Subject: 'Oracle Fleet Weekly Status',
      Creator: 'TuneVault',
    },
    compress: true,
  });

  const { fleet_summary: fs, incidents_resolved, incidents_open, changes_deployed, top_risk_findings, report_date, week_start } = data;
  const weekStr  = new Date(week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const todayStr = new Date(report_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let y = MARGIN;

  // ── Cover header ────────────────────────────────────────────────────────────
  doc.rect(0, 0, PAGE_W, 72).fill(COLORS.headerBg);

  // Logo icon
  doc.save();
  doc.rect(MARGIN, 20, 32, 32).fill(COLORS.accent);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.headerBg);
  doc.text('TV', MARGIN, 29, { width: 32, align: 'center' });
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.headerText);
  doc.text('TuneVault', MARGIN + 40, 24);
  doc.font('Helvetica').fontSize(10).fillColor('#9999b0');
  doc.text('Oracle Fleet Weekly Status Report', MARGIN + 40, 43);

  doc.font('Helvetica').fontSize(10).fillColor('#9999b0');
  doc.text(todayStr, PAGE_W - MARGIN - 140, 30, { width: 140, align: 'right' });
  doc.text(`Week of ${weekStr}`, PAGE_W - MARGIN - 140, 46, { width: 140, align: 'right' });

  y = 100;

  // ── Section: Fleet Health ────────────────────────────────────────────────────
  y = sectionHeader(doc, y, 'Fleet Health Summary');

  const scoreColor = !fs.fleet_score ? COLORS.textDim
    : fs.fleet_score >= 85 ? COLORS.green
    : fs.fleet_score >= 70 ? COLORS.amber
    : COLORS.red;

  // KPI row
  const kpiW = CONTENT / 4;
  const kpis = [
    { label: 'Fleet Score', value: fs.fleet_score != null ? fs.fleet_score : 'N/A', color: scoreColor },
    { label: 'Instances',   value: fs.total_instances,  color: COLORS.text },
    { label: 'Critical',    value: fs.critical_count,   color: fs.critical_count > 0 ? COLORS.red : COLORS.green },
    { label: 'High',        value: fs.high_count,       color: fs.high_count > 0 ? COLORS.amber : COLORS.green },
  ];
  for (let i = 0; i < kpis.length; i++) {
    const kx = MARGIN + i * kpiW;
    doc.rect(kx, y, kpiW - 8, 60).lineWidth(1).stroke(COLORS.border);
    doc.font('Helvetica-Bold').fontSize(28).fillColor(kpis[i].color);
    doc.text(String(kpis[i].value), kx + 4, y + 8, { width: kpiW - 16, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim);
    doc.text(kpis[i].label, kx + 4, y + 42, { width: kpiW - 16, align: 'center' });
  }
  y += 76;

  // ── Section: Open Incidents ──────────────────────────────────────────────────
  y = sectionHeader(doc, y, `Open Incidents (${incidents_open.length} total)`);
  if (incidents_open.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.green);
    doc.text('✓ No open critical or high incidents this week.', MARGIN, y);
    y += 20;
  } else {
    y = drawTable(doc, y, ['Instance', 'Finding', 'Severity', 'Open Since'], incidents_open.slice(0, 10).map(r => [
      r.instance_name || r.connection_id,
      r.title,
      r.severity,
      new Date(r.first_seen_at).toLocaleDateString(),
    ]));
    if (incidents_open.length > 10) {
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim);
      doc.text(`… and ${incidents_open.length - 10} more. See full dashboard for details.`, MARGIN, y + 4);
      y += 18;
    }
  }

  // ── Section: Incidents Resolved This Week ────────────────────────────────────
  y = sectionHeader(doc, y, `Incidents Resolved This Week (${incidents_resolved.length})`);
  if (incidents_resolved.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim);
    doc.text('No incidents resolved in the past 7 days.', MARGIN, y);
    y += 20;
  } else {
    y = drawTable(doc, y, ['Finding', 'Severity', 'Resolved At', 'MTTR (hrs)'], incidents_resolved.slice(0, 8).map(r => [
      r.title,
      r.severity,
      new Date(r.resolved_at).toLocaleDateString(),
      r.hours_to_resolve != null ? parseFloat(r.hours_to_resolve).toFixed(1) : '—',
    ]));
  }

  // ── Page 2: Changes + Top Risks + Signature ───────────────────────────────────
  if (y > PAGE_H - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = sectionHeader(doc, y, `Changes Deployed This Week (${changes_deployed.length})`);
  if (changes_deployed.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim);
    doc.text('No clones or major changes recorded.', MARGIN, y);
    y += 20;
  } else {
    y = drawTable(doc, y, ['Type', 'Label', 'Status', 'Date'], changes_deployed.map(r => [
      r.type,
      r.label || '—',
      r.status,
      new Date(r.date).toLocaleDateString(),
    ]));
  }

  // ── Top 3 Risk Findings ───────────────────────────────────────────────────────
  y = sectionHeader(doc, y, 'Top Risk Findings');
  if (top_risk_findings.length === 0) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.green);
    doc.text('✓ No critical findings detected.', MARGIN, y);
    y += 20;
  } else {
    for (let i = 0; i < top_risk_findings.length; i++) {
      const f = top_risk_findings[i];
      const bx = MARGIN, by = y, bw = CONTENT, bh = 48;
      doc.rect(bx, by, bw, bh).fill('#FEF2E6');
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text);
      doc.text(`${i + 1}. ${f.title}`, bx + 8, by + 6, { width: bw - 16 });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim);
      const sub = [f.instance_name, f.severity, `Open since ${new Date(f.first_seen_at).toLocaleDateString()}`].filter(Boolean).join('  ·  ');
      doc.text(sub, bx + 8, by + 22, { width: bw - 16 });
      if (f.remediation) {
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.text);
        doc.text(f.remediation.slice(0, 120), bx + 8, by + 35, { width: bw - 16 });
      }
      y += bh + 6;
    }
  }

  // ── Signature block ───────────────────────────────────────────────────────────
  y += 20;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT / 3, y).lineWidth(1).stroke(COLORS.border);
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim);
  doc.text('Reviewed by', MARGIN, y + 4);
  doc.text('Signature / Date', MARGIN, y + 20);
  doc.text(`Generated by TuneVault · ${todayStr}`, MARGIN, y + 40, { color: COLORS.textDim });

  return doc;
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function sectionHeader(doc, y, title) {
  y += 8;
  doc.rect(MARGIN, y, CONTENT, 22).fill('#F0F1F6');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text);
  doc.text(title, MARGIN + 8, y + 6);
  return y + 30;
}

function drawTable(doc, y, headers, rows) {
  const colW = CONTENT / headers.length;

  // Header row
  doc.rect(MARGIN, y, CONTENT, 20).fill('#1E1E2E');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  headers.forEach((h, i) => {
    doc.text(h, MARGIN + i * colW + 4, y + 6, { width: colW - 8, ellipsis: true });
  });
  y += 20;

  for (let ri = 0; ri < rows.length; ri++) {
    const rowH = 18;
    if (ri % 2 === 1) doc.rect(MARGIN, y, CONTENT, rowH).fill('#F4F5FA');
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text);
    rows[ri].forEach((cell, ci) => {
      doc.text(String(cell || '—'), MARGIN + ci * colW + 4, y + 5, { width: colW - 8, ellipsis: true });
    });
    y += rowH;
  }

  return y + 6;
}

module.exports = router;
