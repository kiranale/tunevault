'use strict';

/**
 * pdf-generator-ebs.js — PDF generator for Deep EBS Health Reports.
 *
 * Produces a "Deep EBS Report" branded PDF with 6 diagnostic sections.
 * Footer reads: "Whitelisted command set verified against ADMIN_SCRIPTS_HOME on Oracle EBS 12.2"
 *
 * Owns: generateEbsDeepPDF(reportData)
 * Does NOT own: Oracle queries, AI analysis, auth, or report storage.
 */

const PDFDocument = require('pdfkit');

const COLORS = {
  bg:          '#FFFFFF',
  bgAlt:       '#F8F9FC',
  text:        '#1A1A2E',
  textDim:     '#6B6B8A',
  textLight:   '#FFFFFF',
  border:      '#E2E4EE',
  accent:      '#D4871A',
  accentLight: '#FDF3E3',
  headerBg:    '#0A0A14',
  green:       '#059669',
  greenBg:     '#D1FAE5',
  yellow:      '#B45309',
  yellowBg:    '#FEF3C7',
  red:         '#DC2626',
  redBg:       '#FEE2E2',
  blue:        '#2563EB',
  tableHeader: '#1E1E2E',
  tableHeaderText: '#FFFFFF',
  tableRowAlt: '#F4F5FA',
  orange:      '#C2410C',
  orangeBg:    '#FFF7ED',
};

const PAGE_WIDTH  = 595;
const PAGE_HEIGHT = 842;
const MARGIN      = 44;
const CONTENT_W   = PAGE_WIDTH - MARGIN * 2;

/**
 * generateEbsDeepPDF — build a PDFKit document for a Deep EBS report.
 *
 * @param {object} reportData  { id, connection_name, created_at, findings_json, ai_analysis, is_demo }
 * @returns {PDFDocument}  Pipe to response: doc.pipe(res); doc.end();
 */
function generateEbsDeepPDF(reportData) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + 20, left: MARGIN, right: MARGIN },
    info: {
      Title:    `Deep EBS Health Report — ${reportData.connection_name}`,
      Author:   'TuneVault',
      Subject:  'Oracle E-Business Suite Deep Health Check',
      Creator:  'TuneVault',
      Producer: 'TuneVault',
    },
    compress: true,
    autoFirstPage: true,
  });

  const f = reportData.findings_json || {};
  const ai = reportData.ai_analysis || {};

  // ── Page 1: Header + Overview ──────────────────────────────────────────────
  let y = drawEbsHeader(doc, reportData);
  y = drawOverviewSummary(doc, y + 20, f, ai);

  // ── Sections ──────────────────────────────────────────────────────────────
  y = drawSection(doc, y + 24, 'Concurrent Processing',
    f.concurrent_processing, ai.concurrent_processing, renderConcurrentProcessing);
  y = drawSection(doc, y + 16, 'Workflow Mailer',
    f.workflow_mailer, ai.workflow_mailer, renderWorkflowMailer);
  y = drawSection(doc, y + 16, 'Managed Servers',
    { servers: f.managed_servers, opp: f.opp }, ai.managed_servers, renderManagedServers);
  y = drawSection(doc, y + 16, 'Apps Listener',
    f.listener, ai.listener, renderListener);
  y = drawSection(doc, y + 16, 'ADOP State',
    f.adop_state, ai.adop_state, renderAdopState);
  y = drawSection(doc, y + 16, 'Error Log Tail',
    f.error_log_tail, ai.error_log_tail, renderErrorLog);

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    drawFooter(doc, i + 1, range.count, reportData.connection_name);
  }

  return doc;
}

// ─── Header ───────────────────────────────────────────────────────────────────

function drawEbsHeader(doc, reportData) {
  // Dark band
  doc.rect(0, 0, PAGE_WIDTH, 90).fill(COLORS.headerBg);

  // Orange accent strip
  doc.rect(0, 90, PAGE_WIDTH, 4).fill(COLORS.accent);

  // Title
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.textLight)
    .text('Deep EBS Health Report', MARGIN, 22, { width: CONTENT_W });

  // Connection name
  doc.font('Helvetica').fontSize(11).fillColor('#AAA8CC')
    .text(reportData.connection_name, MARGIN, 46, { width: CONTENT_W - 100 });

  // Date stamp
  const dateStr = new Date(reportData.created_at).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  doc.font('Helvetica').fontSize(9).fillColor('#AAA8CC')
    .text(`Generated: ${dateStr}`, MARGIN, 62, { width: CONTENT_W });

  if (reportData.is_demo) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.accent)
      .text('DEMO DATA', PAGE_WIDTH - MARGIN - 60, 66, { width: 60, align: 'right' });
  }

  return 106;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

function drawOverviewSummary(doc, y, findings, ai) {
  if (ai?.overall_summary) {
    doc.rect(MARGIN, y, CONTENT_W, 1).fill(COLORS.border);
    y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.accent)
      .text('AI ASSESSMENT', MARGIN, y);
    y += 16;
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.text)
      .text(ai.overall_summary, MARGIN, y, { width: CONTENT_W });
    y += doc.heightOfString(ai.overall_summary, { width: CONTENT_W }) + 8;
    doc.rect(MARGIN, y, CONTENT_W, 1).fill(COLORS.border);
    y += 12;
  }
  return y;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function drawSection(doc, y, title, data, aiSection, renderFn) {
  // Page break check — need at least 80px
  if (y > PAGE_HEIGHT - MARGIN - 80) {
    doc.addPage();
    y = MARGIN;
  }

  const status = (aiSection?.status || 'ok').toLowerCase();
  const statusColor = status === 'crit' ? COLORS.red : status === 'warn' ? COLORS.yellow : COLORS.green;
  const statusBg    = status === 'crit' ? COLORS.redBg : status === 'warn' ? COLORS.yellowBg : COLORS.greenBg;

  // Section header row
  doc.rect(MARGIN, y, CONTENT_W, 26).fill(statusBg);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text)
    .text(title, MARGIN + 10, y + 7, { width: CONTENT_W - 80 });

  const badge = status === 'crit' ? '● CRITICAL' : status === 'warn' ? '● WARNING' : '● OK';
  doc.font('Helvetica-Bold').fontSize(9).fillColor(statusColor)
    .text(badge, MARGIN, y + 9, { width: CONTENT_W - 8, align: 'right' });

  y += 30;

  // AI one-liner
  if (aiSection?.summary) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.textDim)
      .text(aiSection.summary, MARGIN, y, { width: CONTENT_W });
    y += doc.heightOfString(aiSection.summary, { width: CONTENT_W }) + 6;
  }

  // Section data
  y = renderFn(doc, y, data);

  // Fix commands
  if (aiSection?.fix_keys && aiSection.fix_keys.length > 0) {
    y = drawFixCommands(doc, y + 6, aiSection.fix_keys);
  }

  return y;
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderConcurrentProcessing(doc, y, data) {
  if (!data) return y;

  const rows = [
    ['ICM Running / Target',    `${data.icm_running || 0} / ${data.icm_target || 0}`],
    ['Pending Requests',         String(data.pending_requests || 0)],
    ['Error Requests (24h)',     String(data.error_requests_24h || 0)],
  ];

  y = drawKVTable(doc, y, rows);

  if (data.long_running && data.long_running.length > 0) {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.textDim)
      .text('Long-Running Requests (>60 min)', MARGIN, y);
    y += 14;
    const cols = ['Request ID', 'Program', 'Run (min)'];
    const colW  = [100, 280, 80];
    y = drawTableHeader(doc, y, cols, colW);
    for (const r of data.long_running) {
      y = drawTableRow(doc, y, [String(r.request_id), r.program || '-', String(r.run_mins)], colW, false);
    }
  }

  return y + 4;
}

function renderWorkflowMailer(doc, y, data) {
  if (!data) return y;
  const rows = [
    ['Service Status',       data.status || 'UNKNOWN'],
    ['Stuck Notifications',  String(data.stuck_count || 0)],
    ['Error Queue',          String(data.error_count || 0)],
    ['Pending > 2h',         String(data.pending_over_2h || 0)],
  ];
  return drawKVTable(doc, y, rows) + 4;
}

function renderManagedServers(doc, y, data) {
  if (!data) return y;
  const servers = data.servers || [];
  const opp     = data.opp;

  if (servers.length > 0) {
    const cols = ['Server', 'Status'];
    const colW  = [300, 160];
    y = drawTableHeader(doc, y, cols, colW);
    for (const s of servers) {
      y = drawTableRow(doc, y, [s.label || s.name, s.status || 'UNKNOWN'], colW, false);
    }
    y += 6;
  }

  if (opp) {
    const rows = [
      ['OPP Status',    opp.status || 'UNKNOWN'],
      ['OPP Queue Depth', String(opp.queue_depth || 0)],
    ];
    y = drawKVTable(doc, y, rows) + 4;
  }

  return y;
}

function renderListener(doc, y, data) {
  if (!data) return y;
  const rows = [
    ['Status', data.status || 'UNKNOWN'],
    ['Port',   data.port ? String(data.port) : '-'],
  ];
  return drawKVTable(doc, y, rows) + 4;
}

function renderAdopState(doc, y, data) {
  if (!data || !data.sessions || data.sessions.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.textDim)
      .text('No ADOP sessions found or ADOP not in use.', MARGIN, y);
    return y + 20;
  }
  const cols = ['Session ID', 'Phase', 'Status', 'Started', 'Patch'];
  const colW  = [70, 80, 70, 90, 137];
  y = drawTableHeader(doc, y, cols, colW);
  for (const s of data.sessions) {
    const date = s.start_date ? String(s.start_date).substring(0, 10) : '-';
    y = drawTableRow(doc, y, [
      String(s.session_id || '-'),
      s.phase  || '-',
      s.status || '-',
      date,
      s.patch_name || '-',
    ], colW, false);
  }
  return y + 4;
}

function renderErrorLog(doc, y, data) {
  if (!data || !data.entries || data.entries.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.textDim)
      .text('No error log entries in the last hour.', MARGIN, y);
    return y + 20;
  }
  const cols = ['Module', 'Message (truncated)'];
  const colW  = [100, 357];
  y = drawTableHeader(doc, y, cols, colW);
  for (const e of data.entries) {
    const msg = String(e.message || '').substring(0, 120);
    y = drawTableRow(doc, y, [e.module || '-', msg], colW, false);
  }
  return y + 4;
}

// ─── Fix commands block ───────────────────────────────────────────────────────

function drawFixCommands(doc, y, fixItems) {
  if (!fixItems || fixItems.length === 0) return y;

  if (y > PAGE_HEIGHT - MARGIN - 60) { doc.addPage(); y = MARGIN; }

  doc.rect(MARGIN, y, CONTENT_W, 1).fill(COLORS.border);
  y += 8;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.accent)
    .text('WHITELISTED FIX COMMANDS', MARGIN, y);
  y += 14;

  for (const item of fixItems) {
    if (y > PAGE_HEIGHT - MARGIN - 40) { doc.addPage(); y = MARGIN; }

    if (item.label) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.text)
        .text(item.label, MARGIN, y);
      y += 13;
    }

    for (const cmd of (item.commands || [])) {
      if (y > PAGE_HEIGHT - MARGIN - 20) { doc.addPage(); y = MARGIN; }
      const bg = COLORS.bgAlt;
      const lineH = 16;
      doc.rect(MARGIN, y, CONTENT_W, lineH).fill(bg);
      doc.font('Courier').fontSize(8).fillColor(COLORS.text)
        .text(cmd, MARGIN + 6, y + 4, { width: CONTENT_W - 12 });
      y += lineH + 2;
    }
    y += 6;
  }

  return y;
}

// ─── Shared drawing helpers ───────────────────────────────────────────────────

function drawKVTable(doc, y, rows) {
  const valX = MARGIN + 200;
  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    const bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;
    doc.rect(MARGIN, y, CONTENT_W, 18).fill(bg);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim).text(k, MARGIN + 6, y + 4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.text).text(v, valX, y + 4, { width: CONTENT_W - 210 });
    y += 18;
  }
  return y;
}

function drawTableHeader(doc, y, cols, colW) {
  let x = MARGIN;
  doc.rect(MARGIN, y, CONTENT_W, 18).fill(COLORS.tableHeader);
  for (let i = 0; i < cols.length; i++) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.tableHeaderText)
      .text(cols[i], x + 4, y + 4, { width: colW[i] - 8, ellipsis: true });
    x += colW[i];
  }
  return y + 18;
}

function drawTableRow(doc, y, cells, colW, isAlt) {
  let x = MARGIN;
  const bg = isAlt ? COLORS.tableRowAlt : COLORS.bg;
  doc.rect(MARGIN, y, CONTENT_W, 18).fill(bg);
  for (let i = 0; i < cells.length; i++) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.text)
      .text(String(cells[i] || ''), x + 4, y + 4, { width: colW[i] - 8, ellipsis: true });
    x += colW[i];
  }
  return y + 18;
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function drawFooter(doc, pageNum, totalPages, connectionName) {
  const fy = PAGE_HEIGHT - MARGIN;
  doc.rect(MARGIN, fy - 12, CONTENT_W, 1).fill(COLORS.border);
  doc.font('Helvetica').fontSize(7).fillColor(COLORS.textDim)
    .text(
      'Whitelisted command set verified against ADMIN_SCRIPTS_HOME on Oracle EBS 12.2  |  TuneVault Deep EBS Report',
      MARGIN, fy - 6, { width: CONTENT_W - 50 }
    );
  doc.font('Helvetica').fontSize(7).fillColor(COLORS.textDim)
    .text(`Page ${pageNum} / ${totalPages}`, MARGIN, fy - 6, { width: CONTENT_W, align: 'right' });
}

module.exports = { generateEbsDeepPDF };
