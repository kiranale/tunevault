'use strict';

/**
 * routes/compliance-reports.js — Compliance report generation and download.
 *
 * Owns: GET /settings/compliance (page), POST /api/compliance/generate (generate report),
 *       GET /api/compliance/reports (list), GET /api/compliance/reports/:id/pdf (PDF download),
 *       GET /api/compliance/reports/:id/csv (CSV download), DELETE /api/compliance/reports/:id.
 * Does NOT own: auth, tier enforcement, report data sources (db/compliance-reports.js).
 *
 * Access: Business + Enterprise tiers only. Individual/Team tiers see upgrade prompt.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth } = require('../middleware/auth');
const { ADMIN_EMAILS } = require('../middleware/auth');
const { resolveTier } = require('../services/tier-limits');
const dbTierUsage = require('../db/tier-usage');
const db = require('../db/compliance-reports');

const router = express.Router();

// ── Tier gate helper ──────────────────────────────────────────────────────────

/**
 * Returns true if user has business or enterprise tier access.
 */
async function hasComplianceAccess(userId, userEmail) {
  const isAdmin = ADMIN_EMAILS.has((userEmail || '').toLowerCase());
  if (isAdmin) return true;
  const planTier = await dbTierUsage.getUserPlanTier(userId);
  const tier = resolveTier(planTier, isAdmin);
  return tier === 'business' || tier === 'enterprise';
}

// ── Page route ────────────────────────────────────────────────────────────────

router.get('/compliance', requireAuth, (req, res) => {
  res.sendFile(require('path').join(__dirname, '../public/settings-compliance.html'));
});

// ── API: list reports ─────────────────────────────────────────────────────────

router.get('/api/compliance/reports', requireAuth, async (req, res) => {
  try {
    const reports = await db.listReports(req.user.id, req.user.company_domain);
    res.json({ data: reports });
  } catch (err) {
    console.error('[compliance] list reports error:', err.message);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// ── API: generate report ──────────────────────────────────────────────────────

router.post('/api/compliance/generate', requireAuth, async (req, res) => {
  try {
    const access = await hasComplianceAccess(req.user.id, req.user.email);
    if (!access) {
      return res.status(402).json({
        error: 'Compliance reports require Business or Enterprise plan',
        upgrade_required: true,
      });
    }

    const { report_type, date_from, date_to } = req.body;
    if (!report_type || !date_from || !date_to) {
      return res.status(400).json({ error: 'report_type, date_from, and date_to are required' });
    }
    if (!['sox_change', 'access_audit', 'activity_summary'].includes(report_type)) {
      return res.status(400).json({ error: 'Invalid report_type' });
    }

    const from = new Date(date_from);
    const to = new Date(date_to);
    to.setHours(23, 59, 59, 999); // End of day

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'date_from must be before date_to' });
    }

    // Assemble report data from source tables
    let generatedData = {};
    let rowCounts = {};

    if (report_type === 'sox_change') {
      const data = await db.getSoxData(req.user.id, req.user.company_domain, from, to);
      generatedData = data;
      rowCounts = {
        health_checks: data.hcRuns.length,
        ssh_operations: data.sshOps.length,
        db_operations: data.opEvents.length,
        total: data.hcRuns.length + data.sshOps.length + data.opEvents.length,
      };
    } else if (report_type === 'access_audit') {
      const data = await db.getAccessData(req.user.id, req.user.company_domain, from, to);
      generatedData = data;
      rowCounts = {
        logins: data.logins.length,
        team_members: data.teamMembers.length,
        invites: data.invites.length,
        rbac_denials: data.rbacDenials.length,
        connections: data.connAccess.length,
      };
    } else if (report_type === 'activity_summary') {
      const data = await db.getActivityData(req.user.id, req.user.company_domain, from, to);
      generatedData = data;
      rowCounts = {
        users: data.userActivity.length,
        connections: data.connActivity.length,
        event_types: data.eventSummary.length,
      };
    }

    const TITLES = {
      sox_change: 'SOX Change Report',
      access_audit: 'Access Audit Report',
      activity_summary: 'Activity Summary Report',
    };

    const report = await db.saveReport({
      userId: req.user.id,
      companyDomain: req.user.company_domain,
      reportType: report_type,
      title: TITLES[report_type],
      dateFrom: from,
      dateTo: to,
      generatedBy: req.user.name || req.user.email,
      generatedData,
      rowCounts,
    });

    res.json({ data: report });
  } catch (err) {
    console.error('[compliance] generate report error:', err.message);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ── API: delete report ────────────────────────────────────────────────────────

router.delete('/api/compliance/reports/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await db.deleteReport(parseInt(req.params.id, 10), req.user.id, req.user.company_domain);
    if (!deleted) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[compliance] delete report error:', err.message);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// ── API: download CSV ─────────────────────────────────────────────────────────

router.get('/api/compliance/reports/:id/csv', requireAuth, async (req, res) => {
  try {
    const report = await db.getReport(parseInt(req.params.id, 10), req.user.id, req.user.company_domain);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const filename = `tunevault-${report.report_type}-${report.date_from}-to-${report.date_to}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');

    const csv = buildCsv(report);
    res.send(csv);
  } catch (err) {
    console.error('[compliance] csv download error:', err.message);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// ── API: download PDF ─────────────────────────────────────────────────────────

router.get('/api/compliance/reports/:id/pdf', requireAuth, async (req, res) => {
  try {
    const report = await db.getReport(parseInt(req.params.id, 10), req.user.id, req.user.company_domain);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const filename = `tunevault-${report.report_type}-${report.date_from}-to-${report.date_to}.pdf`;
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');

    const doc = buildPDF(report);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('[compliance] pdf download error:', err.message);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ── CSV builder ───────────────────────────────────────────────────────────────

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cols) {
  return cols.map(escapeCsv).join(',') + '\n';
}

function buildCsv(report) {
  const data = report.generated_data;
  let out = '';

  if (report.report_type === 'sox_change') {
    out += csvRow(['Section', 'Timestamp', 'Type', 'Connection/Target', 'Action/Operation', 'Executed By', 'Result']);
    (data.hcRuns || []).forEach(r => {
      out += csvRow(['Health Checks', r.executed_at, 'health_check', r.connection_name, 'Health Check Run', r.executed_by, r.status]);
    });
    (data.sshOps || []).forEach(r => {
      out += csvRow(['SSH Operations', r.executed_at, 'ssh_operation', r.host, r.command_key, r.initiated_by, r.was_rejected ? 'rejected' : `exit ${r.exit_code}`]);
    });
    (data.opEvents || []).forEach(r => {
      const props = r.properties || {};
      out += csvRow(['DB/EBS Operations', r.executed_at, r.change_type, props.connection_name || '', r.event_name, r.executed_by, 'completed']);
    });

  } else if (report.report_type === 'access_audit') {
    out += '=== Logins ===\n';
    out += csvRow(['Timestamp', 'User Email', 'User Name', 'Method', 'Session ID']);
    (data.logins || []).forEach(r => {
      out += csvRow([r.occurred_at, r.email, r.name, r.login_method, r.session_id]);
    });
    out += '\n=== Team Members ===\n';
    out += csvRow(['User Email', 'User Name', 'Role', 'Team', 'Joined At']);
    (data.teamMembers || []).forEach(r => {
      out += csvRow([r.email, r.name, r.role, r.team_name, r.joined_at]);
    });
    out += '\n=== Invites ===\n';
    out += csvRow(['Email', 'Role', 'Status', 'Created At', 'Accepted At']);
    (data.invites || []).forEach(r => {
      out += csvRow([r.email, r.role, r.status, r.created_at, r.accepted_at]);
    });
    out += '\n=== Permission Denials ===\n';
    out += csvRow(['Timestamp', 'User Email', 'Method', 'Path', 'Required Role', 'Actual Role']);
    (data.rbacDenials || []).forEach(r => {
      out += csvRow([r.denied_at, r.email, r.method, r.path, r.required_role, r.actual_role]);
    });
    out += '\n=== Connection Access ===\n';
    out += csvRow(['Connection Name', 'Host/ID', 'Access Count', 'Last Accessed']);
    (data.connAccess || []).forEach(r => {
      out += csvRow([r.connection_name, r.connection_id, r.access_count, r.last_accessed]);
    });

  } else if (report.report_type === 'activity_summary') {
    out += '=== Per-User Activity ===\n';
    out += csvRow(['User Email', 'User Name', 'Total Logins', 'Total Executions', 'Total Health Checks', 'First Active', 'Last Active']);
    (data.userActivity || []).forEach(r => {
      out += csvRow([r.email, r.name, r.total_logins, r.total_executions, r.total_health_checks, r.first_active, r.last_active]);
    });
    out += '\n=== Per-Connection Activity ===\n';
    out += csvRow(['Connection Name', 'Host', 'Health Check Count', 'First Checked', 'Last Checked']);
    (data.connActivity || []).forEach(r => {
      out += csvRow([r.connection_name, r.host, r.health_check_count, r.first_checked, r.last_checked]);
    });
    out += '\n=== Event Type Breakdown ===\n';
    out += csvRow(['Event Name', 'Count']);
    (data.eventSummary || []).forEach(r => {
      out += csvRow([r.event_name, r.count]);
    });
  }

  return out;
}

// ── PDF builder ───────────────────────────────────────────────────────────────

// Brand palette (print-safe white background)
const C = {
  bg: '#FFFFFF',
  text: '#1A1A2E',
  textDim: '#5A5A7A',
  headerBg: '#0A0A14',
  headerText: '#FFFFFF',
  accent: '#D4871A',
  accentLight: '#FDF3E3',
  tableHeader: '#1E1E2E',
  tableHeaderText: '#FFFFFF',
  tableRowAlt: '#F4F6FA',
  border: '#E2E4EE',
  red: '#DC2626',
  green: '#059669',
  yellow: '#B45309',
};

const PAGE_W = 595;
const PAGE_H = 842;
const M = 44;
const CONTENT_W = PAGE_W - M * 2;

function fmt(val) {
  if (!val) return '—';
  if (val instanceof Date || (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}T/))) {
    return new Date(val).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  return String(val);
}

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toISOString().slice(0, 10);
}

function buildPDF(report) {
  const data = report.generated_data;
  const dateFrom = fmtDate(report.date_from);
  const dateTo = fmtDate(report.date_to);

  const TITLES = {
    sox_change: 'SOX Change Report',
    access_audit: 'Access Audit Report',
    activity_summary: 'Activity Summary Report',
  };

  const SUBTITLES = {
    sox_change: 'Production Change Control Audit',
    access_audit: 'Database Access & Permission Audit',
    activity_summary: 'Privileged User Activity Review',
  };

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: M, bottom: M, left: M, right: M },
    info: {
      Title: TITLES[report.report_type],
      Author: 'TuneVault',
      Subject: SUBTITLES[report.report_type],
      Creator: 'TuneVault',
      Producer: 'TuneVault — tunevault.app',
    },
    compress: true,
    bufferPages: true,
  });

  // ── Cover page ──────────────────────────────────────────────────────────────
  // Dark header band
  doc.rect(0, 0, PAGE_W, 120).fill(C.headerBg);
  doc.fontSize(22).fillColor(C.accent).font('Helvetica-Bold')
    .text('TuneVault', M, 34);
  doc.fontSize(10).fillColor(C.headerText).font('Helvetica')
    .text('Oracle Database Health & Compliance', M, 60);

  // Report title block
  doc.fillColor(C.text).font('Helvetica-Bold').fontSize(20)
    .text(TITLES[report.report_type], M, 142);
  doc.fillColor(C.textDim).font('Helvetica').fontSize(11)
    .text(SUBTITLES[report.report_type], M, 168);

  // Date range & metadata box
  const boxY = 196;
  doc.rect(M, boxY, CONTENT_W, 72).fill(C.accentLight).stroke(C.border);
  doc.fillColor(C.text).font('Helvetica-Bold').fontSize(9).text('REPORT PERIOD', M + 14, boxY + 12);
  doc.font('Helvetica').fontSize(11).fillColor(C.text)
    .text(`${dateFrom}  →  ${dateTo}`, M + 14, boxY + 26);
  doc.fontSize(9).fillColor(C.textDim)
    .text(`Generated by: ${report.generated_by}`, M + 14, boxY + 48)
    .text(`Generated at: ${fmt(report.generated_at)}  ·  TuneVault — tunevault.app`, M + 14, boxY + 60);

  // Summary stats row
  let y = boxY + 90;
  const counts = report.row_counts || {};
  const summaryItems = Object.entries(counts).map(([k, v]) => ({
    label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    value: v,
  }));

  if (summaryItems.length > 0) {
    doc.rect(M, y, CONTENT_W, 64).fill(C.tableRowAlt).stroke(C.border);
    const colW = CONTENT_W / summaryItems.length;
    summaryItems.forEach((item, i) => {
      const cx = M + i * colW + colW / 2;
      doc.font('Helvetica-Bold').fontSize(18).fillColor(C.accent)
        .text(String(item.value), M + i * colW, y + 10, { width: colW, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(C.textDim)
        .text(item.label, M + i * colW, y + 40, { width: colW, align: 'center' });
    });
    y += 82;
  }

  // ── Table of contents ───────────────────────────────────────────────────────
  y += 16;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.text).text('Contents', M, y);
  y += 18;

  const sections = getReportSections(report.report_type);
  sections.forEach((sec, i) => {
    doc.font('Helvetica').fontSize(10).fillColor(C.text)
      .text(`${i + 1}.  ${sec}`, M + 8, y);
    y += 16;
  });

  // ── Report sections — new page ──────────────────────────────────────────────
  doc.addPage();
  y = M;

  if (report.report_type === 'sox_change') {
    y = renderSoxSections(doc, y, data, dateFrom, dateTo);
  } else if (report.report_type === 'access_audit') {
    y = renderAccessSections(doc, y, data);
  } else if (report.report_type === 'activity_summary') {
    y = renderActivitySections(doc, y, data);
  }

  // ── Footer on all pages ─────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.rect(0, PAGE_H - 36, PAGE_W, 36).fill(C.headerBg);
    doc.font('Helvetica').fontSize(8).fillColor(C.headerText)
      .text('TuneVault — tunevault.app', M, PAGE_H - 22, { align: 'left' })
      .text(`Page ${i + 1} of ${range.count}`, M, PAGE_H - 22, { align: 'right', width: CONTENT_W });
  }
  doc.flushPages();

  return doc;
}

function getReportSections(reportType) {
  if (reportType === 'sox_change') return ['Health Check Runs', 'SSH / DB Operations', 'Analytics Events', 'Change Summary'];
  if (reportType === 'access_audit') return ['Login Activity', 'Team Members & Roles', 'Invitations', 'Permission Denials', 'Connection Access Summary'];
  if (reportType === 'activity_summary') return ['Per-User Activity Breakdown', 'Connection Activity', 'Event Type Summary'];
  return [];
}

// ── Section renderers ─────────────────────────────────────────────────────────

function sectionTitle(doc, y, title) {
  if (y > PAGE_H - 120) { doc.addPage(); y = M; }
  doc.rect(M, y, CONTENT_W, 26).fill(C.tableHeader);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.tableHeaderText)
    .text(title, M + 10, y + 7);
  return y + 34;
}

function tableRow(doc, y, cols, widths, isHeader = false, isAlt = false) {
  const rowH = 18;
  if (y + rowH > PAGE_H - M - 40) { doc.addPage(); y = M; }

  const bg = isHeader ? C.tableHeader : isAlt ? C.tableRowAlt : C.bg;
  const textColor = isHeader ? C.tableHeaderText : C.text;
  doc.rect(M, y, CONTENT_W, rowH).fill(bg);

  let x = M + 4;
  cols.forEach((col, i) => {
    const w = widths[i] - 4;
    doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
      .fillColor(textColor)
      .text(fmt(col), x, y + 4, { width: w, ellipsis: true, lineBreak: false });
    x += widths[i];
  });

  // Row border
  doc.rect(M, y, CONTENT_W, rowH).stroke(C.border);
  return y + rowH;
}

function emptyNote(doc, y, msg) {
  doc.font('Helvetica').fontSize(9).fillColor(C.textDim)
    .text(msg, M + 8, y + 4);
  return y + 20;
}

// SOX Change Report
function renderSoxSections(doc, y, data, dateFrom, dateTo) {
  // Health Check Runs
  y = sectionTitle(doc, y, '1. Health Check Runs');
  if (!data.hcRuns || data.hcRuns.length === 0) {
    y = emptyNote(doc, y, 'No health check runs in this period.');
  } else {
    const cols = ['Timestamp', 'Connection', 'Status', 'Score', 'Executed By'];
    const widths = [120, 150, 70, 50, 117];
    y = tableRow(doc, y, cols, widths, true);
    data.hcRuns.forEach((r, i) => {
      y = tableRow(doc, y, [r.executed_at, r.connection_name, r.status, r.score, r.executed_by], widths, false, i % 2 === 1);
    });
  }

  // SSH / DB Operations
  y += 12;
  y = sectionTitle(doc, y, '2. SSH / DB Operations');
  if (!data.sshOps || data.sshOps.length === 0) {
    y = emptyNote(doc, y, 'No SSH operations recorded in this period.');
  } else {
    const cols = ['Timestamp', 'Target Host', 'Command', 'Initiated By', 'Result'];
    const widths = [110, 100, 130, 110, 57];
    y = tableRow(doc, y, cols, widths, true);
    data.sshOps.forEach((r, i) => {
      const result = r.was_rejected ? 'REJECTED' : `exit ${r.exit_code}`;
      y = tableRow(doc, y, [r.executed_at, r.host, r.command_key, r.initiated_by, result], widths, false, i % 2 === 1);
    });
  }

  // Analytics Events (DB Ops)
  y += 12;
  y = sectionTitle(doc, y, '3. DB/EBS Operation Events');
  if (!data.opEvents || data.opEvents.length === 0) {
    y = emptyNote(doc, y, 'No DB/EBS operation events in this period.');
  } else {
    const cols = ['Timestamp', 'Event Type', 'Executed By', 'Details'];
    const widths = [110, 130, 120, 147];
    y = tableRow(doc, y, cols, widths, true);
    data.opEvents.forEach((r, i) => {
      const props = r.properties || {};
      y = tableRow(doc, y, [r.executed_at, r.event_name, r.executed_by, props.operation || '—'], widths, false, i % 2 === 1);
    });
  }

  // Change Summary
  y += 12;
  y = sectionTitle(doc, y, '4. Change Summary');
  const total = (data.hcRuns?.length || 0) + (data.sshOps?.length || 0) + (data.opEvents?.length || 0);
  doc.font('Helvetica').fontSize(10).fillColor(C.text).text(
    `Period: ${dateFrom} to ${dateTo}  ·  Total changes recorded: ${total}`, M + 8, y + 4
  );
  return y + 30;
}

// Access Audit Report
function renderAccessSections(doc, y, data) {
  // Logins
  y = sectionTitle(doc, y, '1. Login Activity');
  if (!data.logins || data.logins.length === 0) {
    y = emptyNote(doc, y, 'No logins recorded in this period.');
  } else {
    const cols = ['Timestamp', 'User Email', 'Name', 'Method', 'Session'];
    const widths = [110, 140, 90, 100, 67];
    y = tableRow(doc, y, cols, widths, true);
    data.logins.forEach((r, i) => {
      y = tableRow(doc, y, [r.occurred_at, r.email, r.name, r.login_method, r.session_id?.slice(0, 12)], widths, false, i % 2 === 1);
    });
  }

  // Team Members
  y += 12;
  y = sectionTitle(doc, y, '2. Team Members & Roles');
  if (!data.teamMembers || data.teamMembers.length === 0) {
    y = emptyNote(doc, y, 'No team members found.');
  } else {
    const cols = ['Email', 'Name', 'Role', 'Team', 'Joined'];
    const widths = [140, 90, 80, 100, 97];
    y = tableRow(doc, y, cols, widths, true);
    data.teamMembers.forEach((r, i) => {
      y = tableRow(doc, y, [r.email, r.name, r.role, r.team_name, r.joined_at], widths, false, i % 2 === 1);
    });
  }

  // Invites
  y += 12;
  y = sectionTitle(doc, y, '3. Invitations');
  if (!data.invites || data.invites.length === 0) {
    y = emptyNote(doc, y, 'No invitations in this period.');
  } else {
    const cols = ['Email', 'Role', 'Status', 'Sent', 'Accepted'];
    const widths = [150, 80, 80, 110, 87];
    y = tableRow(doc, y, cols, widths, true);
    data.invites.forEach((r, i) => {
      y = tableRow(doc, y, [r.email, r.role, r.status, r.created_at, r.accepted_at], widths, false, i % 2 === 1);
    });
  }

  // RBAC Denials
  y += 12;
  y = sectionTitle(doc, y, '4. Permission Denials');
  if (!data.rbacDenials || data.rbacDenials.length === 0) {
    y = emptyNote(doc, y, 'No permission denials recorded in this period.');
  } else {
    const cols = ['Timestamp', 'User', 'Method', 'Path', 'Required Role', 'Actual Role'];
    const widths = [100, 100, 40, 130, 90, 47];
    y = tableRow(doc, y, cols, widths, true);
    data.rbacDenials.forEach((r, i) => {
      y = tableRow(doc, y, [r.denied_at, r.email, r.method, r.path, r.required_role, r.actual_role], widths, false, i % 2 === 1);
    });
  }

  // Connection Access
  y += 12;
  y = sectionTitle(doc, y, '5. Connection Access Summary');
  if (!data.connAccess || data.connAccess.length === 0) {
    y = emptyNote(doc, y, 'No connection access data in this period.');
  } else {
    const cols = ['Connection Name', 'ID', 'Access Count', 'Last Accessed'];
    const widths = [200, 50, 90, 167];
    y = tableRow(doc, y, cols, widths, true);
    data.connAccess.forEach((r, i) => {
      y = tableRow(doc, y, [r.connection_name, r.connection_id, r.access_count, r.last_accessed], widths, false, i % 2 === 1);
    });
  }

  return y;
}

// Activity Summary Report
function renderActivitySections(doc, y, data) {
  // Per-User Activity
  y = sectionTitle(doc, y, '1. Per-User Activity Breakdown');
  if (!data.userActivity || data.userActivity.length === 0) {
    y = emptyNote(doc, y, 'No user activity in this period.');
  } else {
    const cols = ['Email', 'Name', 'Logins', 'Executions', 'Health Checks', 'Last Active'];
    const widths = [130, 80, 50, 60, 80, 107];
    y = tableRow(doc, y, cols, widths, true);
    data.userActivity.forEach((r, i) => {
      y = tableRow(doc, y, [r.email, r.name, r.total_logins, r.total_executions, r.total_health_checks, r.last_active], widths, false, i % 2 === 1);
    });
  }

  // Connection Activity
  y += 12;
  y = sectionTitle(doc, y, '2. Connection Activity');
  if (!data.connActivity || data.connActivity.length === 0) {
    y = emptyNote(doc, y, 'No connection activity in this period.');
  } else {
    const cols = ['Connection Name', 'Host', 'Health Checks', 'First Checked', 'Last Checked'];
    const widths = [140, 100, 80, 110, 77];
    y = tableRow(doc, y, cols, widths, true);
    data.connActivity.forEach((r, i) => {
      y = tableRow(doc, y, [r.connection_name, r.host, r.health_check_count, r.first_checked, r.last_checked], widths, false, i % 2 === 1);
    });
  }

  // Event Summary
  y += 12;
  y = sectionTitle(doc, y, '3. Event Type Summary');
  if (!data.eventSummary || data.eventSummary.length === 0) {
    y = emptyNote(doc, y, 'No events recorded in this period.');
  } else {
    const cols = ['Event Name', 'Count'];
    const widths = [400, 107];
    y = tableRow(doc, y, cols, widths, true);
    data.eventSummary.forEach((r, i) => {
      y = tableRow(doc, y, [r.event_name, r.count], widths, false, i % 2 === 1);
    });
  }

  return y;
}

module.exports = router;
