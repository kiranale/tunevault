'use strict';

/**
 * routes/reports.js — Split DB / EBS / Combined report downloads.
 *
 * Owns: GET /api/reports/:connectionId/db   (pdf|xlsx)
 *       GET /api/reports/:connectionId/ebs  (pdf|xlsx)
 *       GET /api/reports/:connectionId/combined (pdf|xlsx)
 * Does NOT own: Oracle queries, health check execution, auth middleware.
 *
 * Each endpoint resolves the latest completed health_check for the
 * connection, then streams the requested artifact directly to the response.
 *
 * Filename convention:
 *   tunevault-db-{instance}-{YYYYMMDD}.{ext}
 *   tunevault-ebs-{instance}-{YYYYMMDD}.{ext}
 *   tunevault-full-{instance}-{YYYYMMDD}.{ext}
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const pool = require('../db/index');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Brand colours (shared across all PDF generators here) ─────────────────────
const C = {
  bg:          '#FFFFFF',
  bgAlt:       '#F8F9FC',
  text:        '#1A1A2E',
  textDim:     '#6B6B8A',
  textLight:   '#FFFFFF',
  border:      '#E2E4EE',
  accent:      '#D4871A',        // TuneVault gold
  accentLight: '#FDF3E3',
  headerBg:    '#0A0A14',        // near-black header
  green:       '#059669',
  greenBg:     '#D1FAE5',
  yellow:      '#B45309',
  yellowBg:    '#FEF3C7',
  red:         '#DC2626',
  redBg:       '#FEE2E2',
  blue:        '#2563EB',
  tableHeader: '#1E1E2E',
  tableHdrTxt: '#FFFFFF',
  tableRowAlt: '#F4F5FA',
};
const PW = 595;   // A4 width
const PH = 842;   // A4 height
const MG = 44;    // page margin
const CW = PW - MG * 2;

// ── ExcelJS style helpers ──────────────────────────────────────────────────────
const XL_HDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1E2E' } };
const XL_HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const XL_WARN_FONT = { color: { argb: 'FFB45309' } };
const XL_CRIT_FONT = { color: { argb: 'FFDC2626' } };
const XL_OK_FONT   = { color: { argb: 'FF059669' } };

function xlAddHeaders(sheet, headers) {
  const row = sheet.addRow(headers);
  row.eachCell(cell => {
    cell.fill = XL_HDR_FILL;
    cell.font = XL_HDR_FONT;
    cell.alignment = { horizontal: 'center' };
  });
}

function xlStatusFont(v, critThresh, warnThresh) {
  if (v > critThresh) return XL_CRIT_FONT;
  if (v > warnThresh) return XL_WARN_FONT;
  return XL_OK_FONT;
}

// ── DB category check ids (used to filter check_results) ──────────────────────
// EBS category checks have category = 'ebs_operations' or check_id starts with ebs_/cm/wf/etc.
// We split at the metrics level — m.ebs_detected flag + m.ebs_operations vs core DB metrics.

// ── Helpers: filename + date ───────────────────────────────────────────────────
function safeName(s) {
  return (s || 'oracle').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 40);
}

function yyyymmdd(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

function scoreLabel(s) {
  if (s >= 90) return 'Excellent';
  if (s >= 75) return 'Good';
  if (s >= 50) return 'Fair';
  return 'Critical';
}

// ── DB PDF helpers ─────────────────────────────────────────────────────────────

function drawDbCoverPage(doc, data) {
  const m = data.metrics || {};
  const instance = m.instance || {};

  // Dark header band
  doc.rect(0, 0, PW, 100).fill(C.headerBg);
  // Gold accent strip
  doc.rect(0, 100, PW, 5).fill(C.accent);

  // Logo badge
  doc.rect(MG, 18, 38, 38).fillAndStroke(C.accent, C.accent);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.headerBg)
    .text('TV', MG, 29, { width: 38, align: 'center' });

  // Wordmark
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.textLight)
    .text('TuneVault', MG + 50, 22);
  doc.font('Helvetica').fontSize(10).fillColor(C.accent)
    .text('Oracle Database Health Report', MG + 50, 46);

  // Edition badges: SE / EE / RAC / ASM
  const badges = [];
  if (instance.edition) badges.push(instance.edition.includes('Enterprise') ? 'EE' : 'SE');
  if (m.rac_nodes || instance.rac) badges.push('RAC');
  if (m.asm_diskgroups || instance.asm) badges.push('ASM');
  if (data.is_demo) badges.push('DEMO');
  let bx = MG + 50;
  const by = 64;
  for (const badge of badges) {
    const bw = badge.length * 7 + 10;
    doc.rect(bx, by, bw, 14).fill('#2A2A4A');
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.accent)
      .text(badge, bx + 5, by + 3);
    bx += bw + 5;
  }

  // Date stamp top-right
  const dateStr = new Date(data.created_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  doc.font('Helvetica').fontSize(9).fillColor(C.textDim)
    .text(dateStr, 0, 36, { width: PW - MG, align: 'right' });

  // Below header: instance name + meta
  const subY = 120;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.text)
    .text(data.connection_name || 'Health Check', MG, subY);

  const meta = [];
  if (instance.db_name) meta.push(instance.db_name);
  if (instance.version) meta.push(`Oracle ${instance.version}`);
  if (instance.host_name) meta.push(instance.host_name);
  else if (data.host) meta.push(data.host);
  if (data.username) meta.push(`User: ${data.username}`);

  doc.font('Helvetica').fontSize(11).fillColor(C.textDim)
    .text(meta.join('  ·  '), MG, subY + 24);

  doc.moveTo(MG, subY + 48).lineTo(PW - MG, subY + 48)
    .strokeColor(C.border).lineWidth(1).stroke();

  return subY + 68;
}

function drawEbsCoverPage(doc, data) {
  const m = data.metrics || {};
  const ebs = m.ebs_operations || {};

  // Dark header band — same frame, different accent colour strip
  doc.rect(0, 0, PW, 100).fill(C.headerBg);
  doc.rect(0, 100, PW, 5).fill('#C2410C');  // orange-700 for EBS differentiation

  // Logo badge (orange accent)
  doc.rect(MG, 18, 38, 38).fillAndStroke('#C2410C', '#C2410C');
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.textLight)
    .text('EBS', MG, 29, { width: 38, align: 'center' });

  // Wordmark
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.textLight)
    .text('TuneVault', MG + 50, 22);
  doc.font('Helvetica').fontSize(10).fillColor('#F97316')  // orange-500
    .text('Oracle E-Business Suite Operations Report', MG + 50, 46);

  // Module badges: CM / OPP / WF / ADOP
  const modules = [];
  if (ebs.concurrent_managers) modules.push('CM');
  if (ebs.concurrent_managers?.cm_opp || m.opp_status) modules.push('OPP');
  if (ebs.workflow) modules.push('WF');
  if (ebs.adop_state || m.adop_sessions) modules.push('ADOP');
  if (data.is_demo) modules.push('DEMO');
  let bx = MG + 50;
  const by = 64;
  for (const mod of modules) {
    const bw = mod.length * 7 + 10;
    doc.rect(bx, by, bw, 14).fill('#2A1A0A');
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#F97316')
      .text(mod, bx + 5, by + 3);
    bx += bw + 5;
  }

  // EBS version + date
  const ebsVersion = m.ebs_version || 'EBS 12.2.x';
  const dateStr = new Date(data.created_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  doc.font('Helvetica').fontSize(9).fillColor(C.textDim)
    .text(dateStr, 0, 36, { width: PW - MG, align: 'right' });

  const subY = 120;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.text)
    .text(data.connection_name || 'EBS Health Check', MG, subY);
  doc.font('Helvetica').fontSize(11).fillColor(C.textDim)
    .text(`${ebsVersion}  ·  ${data.host || ''}`, MG, subY + 24);

  doc.moveTo(MG, subY + 48).lineTo(PW - MG, subY + 48)
    .strokeColor(C.border).lineWidth(1).stroke();

  return subY + 68;
}

function drawCombinedCoverPage(doc, data) {
  const m = data.metrics || {};
  const instance = m.instance || {};

  doc.rect(0, 0, PW, 100).fill(C.headerBg);
  // Two-tone accent strip: gold + orange
  doc.rect(0, 100, PW / 2, 5).fill(C.accent);
  doc.rect(PW / 2, 100, PW / 2, 5).fill('#C2410C');

  doc.rect(MG, 18, 38, 38).fillAndStroke(C.accent, C.accent);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.headerBg)
    .text('TV', MG, 29, { width: 38, align: 'center' });

  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.textLight)
    .text('TuneVault', MG + 50, 22);
  doc.font('Helvetica').fontSize(10).fillColor(C.accent)
    .text('TuneVault Full Stack Report', MG + 50, 46);

  // DB + EBS badge rows
  const dbBadges = [];
  if (instance.edition) dbBadges.push(instance.edition.includes('Enterprise') ? 'EE' : 'SE');
  if (m.rac_nodes || instance.rac) dbBadges.push('RAC');
  if (m.asm_diskgroups || instance.asm) dbBadges.push('ASM');
  const ebsOps = m.ebs_operations || {};
  const ebsBadges = ['CM', 'WF', 'ADOP'].filter(b =>
    (b === 'CM' && ebsOps.concurrent_managers) ||
    (b === 'WF' && ebsOps.workflow) ||
    (b === 'ADOP' && ebsOps.adop_state)
  );
  if (data.is_demo) dbBadges.push('DEMO');

  let bx = MG + 50;
  const by = 64;
  for (const badge of [...dbBadges, ...ebsBadges]) {
    const bw = badge.length * 7 + 10;
    const isEbs = ebsBadges.includes(badge);
    doc.rect(bx, by, bw, 14).fill(isEbs ? '#2A1A0A' : '#2A2A4A');
    doc.font('Helvetica-Bold').fontSize(7).fillColor(isEbs ? '#F97316' : C.accent)
      .text(badge, bx + 5, by + 3);
    bx += bw + 5;
  }

  const dateStr = new Date(data.created_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  doc.font('Helvetica').fontSize(9).fillColor(C.textDim)
    .text(dateStr, 0, 36, { width: PW - MG, align: 'right' });

  const subY = 120;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.text)
    .text(data.connection_name || 'Full Stack Report', MG, subY);

  const meta = [];
  if (instance.db_name) meta.push(instance.db_name);
  if (instance.version) meta.push(`Oracle ${instance.version}`);
  if (m.ebs_version) meta.push(m.ebs_version);
  if (instance.host_name) meta.push(instance.host_name);
  doc.font('Helvetica').fontSize(11).fillColor(C.textDim)
    .text(meta.join('  ·  '), MG, subY + 24);

  doc.moveTo(MG, subY + 48).lineTo(PW - MG, subY + 48)
    .strokeColor(C.border).lineWidth(1).stroke();

  return subY + 68;
}

// ── PDF drawing primitives ─────────────────────────────────────────────────────

function pdfSectionTitle(doc, y, title, accent) {
  const color = accent || C.accent;
  if (y > PH - MG - 80) { doc.addPage(); y = MG; }
  doc.rect(MG, y, CW, 22).fill('#F4F5FA');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(color)
    .text(title.toUpperCase(), MG + 8, y + 6, { width: CW - 16 });
  return y + 26;
}

function pdfPageCheck(doc, y, needed) {
  if (y > PH - MG - (needed || 80)) { doc.addPage(); y = MG; }
  return y;
}

function pdfKVRow(doc, y, label, value, alt) {
  doc.rect(MG, y, CW, 18).fill(alt ? C.bgAlt || '#F8F9FC' : C.bg);
  doc.font('Helvetica').fontSize(9).fillColor(C.textDim).text(label, MG + 6, y + 4);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.text)
    .text(String(value || '—').substring(0, 60), MG + 220, y + 4, { width: CW - 230 });
  return y + 18;
}

function pdfTableHeader(doc, y, cols, widths) {
  doc.rect(MG, y, CW, 18).fill(C.tableHeader);
  let x = MG;
  for (let i = 0; i < cols.length; i++) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.tableHdrTxt)
      .text(cols[i], x + 4, y + 4, { width: widths[i] - 8, ellipsis: true });
    x += widths[i];
  }
  return y + 18;
}

function pdfTableRow(doc, y, cells, widths, alt) {
  doc.rect(MG, y, CW, 18).fill(alt ? C.tableRowAlt : C.bg);
  let x = MG;
  for (let i = 0; i < cells.length; i++) {
    doc.font('Helvetica').fontSize(8).fillColor(C.text)
      .text(String(cells[i] || '').substring(0, 80), x + 4, y + 4, { width: widths[i] - 8, ellipsis: true });
    x += widths[i];
  }
  return y + 18;
}

function pdfFooter(doc, connectionName) {
  const fy = PH - MG;
  doc.rect(MG, fy - 12, CW, 1).fill(C.border);
  doc.font('Helvetica').fontSize(7).fillColor(C.textDim)
    .text(`TuneVault  |  ${connectionName || 'Oracle Health Report'}`, MG, fy - 6, { width: CW - 60 });
  doc.font('Helvetica').fontSize(7).fillColor(C.textDim)
    .text('tunevault.app', MG, fy - 6, { width: CW, align: 'right' });
}

// ── DB-only PDF sections ───────────────────────────────────────────────────────

function drawDbSummaryKV(doc, y, data) {
  const m = data.metrics || {};
  const s = data.scores || {};
  const instance = m.instance || {};

  y = pdfSectionTitle(doc, y, 'Database Summary');

  const rows = [
    ['Overall Score', `${data.overall_score || 0} / 100 (${scoreLabel(data.overall_score || 0)})`],
    ['Database', instance.db_name || '—'],
    ['Oracle Version', instance.version || '—'],
    ['Host', instance.host_name || data.host || '—'],
    ['Uptime', instance.uptime_days != null ? instance.uptime_days + ' days' : '—'],
    ['CPUs', instance.cpus || '—'],
    ['SGA Target', instance.sga_target_gb != null ? instance.sga_target_gb + ' GB' : '—'],
    ['Storage Score', (s.tablespace || 0) + ' / 100'],
    ['Performance Score', (s.wait_events || 0) + ' / 100'],
    ['Memory Score', (s.memory || 0) + ' / 100'],
    ['Security Score', (s.security || 0) + ' / 100'],
    ['Backup Score', (s.backup || 0) + ' / 100'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawDbTablespaces(doc, y, tablespaces) {
  if (!tablespaces || tablespaces.length === 0) return y;
  y = pdfPageCheck(doc, y, 120);
  y = pdfSectionTitle(doc, y, 'Storage — Tablespaces');
  const cols = ['Tablespace', 'Used GB', 'Total GB', 'Usage %', 'Autoextend', 'Status'];
  const widths = [140, 70, 70, 65, 80, 82];
  y = pdfTableHeader(doc, y, cols, widths);
  tablespaces.forEach((t, i) => {
    y = pdfPageCheck(doc, y, 22);
    const status = t.pct_used > 90 ? 'CRITICAL' : t.pct_used > 80 ? 'WARNING' : 'OK';
    y = pdfTableRow(doc, y, [
      t.name, t.used_gb, t.total_gb, t.pct_used + '%',
      t.autoextend ? 'ON' : 'OFF', status,
    ], widths, i % 2 === 1);
  });
  return y + 12;
}

function drawDbWaitEvents(doc, y, waitEvents) {
  if (!waitEvents || waitEvents.length === 0) return y;
  y = pdfPageCheck(doc, y, 100);
  y = pdfSectionTitle(doc, y, 'Performance — Top Wait Events');
  const cols = ['Event', 'Wait Class', '% DB Time', 'Avg Wait ms'];
  const widths = [210, 120, 90, 87];
  y = pdfTableHeader(doc, y, cols, widths);
  waitEvents.filter(w => w.pct_db_time > 0).slice(0, 15).forEach((w, i) => {
    y = pdfPageCheck(doc, y, 22);
    y = pdfTableRow(doc, y, [
      w.event, w.wait_class, w.pct_db_time + '%', w.avg_wait_ms,
    ], widths, i % 2 === 1);
  });
  return y + 12;
}

function drawDbTopSql(doc, y, topSql) {
  if (!topSql || topSql.length === 0) return y;
  y = pdfPageCheck(doc, y, 100);
  y = pdfSectionTitle(doc, y, 'Performance — Top SQL by Elapsed Time');
  const cols = ['SQL ID', 'ms/exec', 'Executions', 'Issue', 'SQL (truncated)'];
  const widths = [90, 65, 80, 100, 172];
  y = pdfTableHeader(doc, y, cols, widths);
  topSql.slice(0, 15).forEach((s, i) => {
    y = pdfPageCheck(doc, y, 22);
    y = pdfTableRow(doc, y, [
      s.sql_id, s.elapsed_per_exec_ms, s.executions,
      (s.issue || '').substring(0, 25), (s.sql_text || '').substring(0, 50),
    ], widths, i % 2 === 1);
  });
  return y + 12;
}

function drawDbSecurity(doc, y, m) {
  y = pdfPageCheck(doc, y, 80);
  y = pdfSectionTitle(doc, y, 'Security');
  const sec = m.security || {};
  const rows = [
    ['Audit Trail', sec.audit_trail || '—'],
    ['Failed Logins (24h)', sec.failed_logins_24h ?? '—'],
    ['Default Passwords', sec.default_passwords ?? '—'],
    ['Open Public Synonyms', sec.open_public_synonyms ?? '—'],
    ['DB Vault Enabled', sec.db_vault_enabled ? 'YES' : (sec.db_vault_enabled === false ? 'NO' : '—')],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawDbBackup(doc, y, backup) {
  if (!backup) return y;
  y = pdfPageCheck(doc, y, 100);
  y = pdfSectionTitle(doc, y, 'Backup & Recovery');
  const bk = backup;
  const rows = [
    ['Overall Backup Status', (bk.overall_status || 'unknown').toUpperCase()],
    ['RMAN Configured', bk.rman_backup?.rman_available ? 'YES' : 'NO'],
    ['Last Full Backup', bk.rman_backup?.full_backup_hours_ago != null ? bk.rman_backup.full_backup_hours_ago + 'h ago' : 'NONE'],
    ['Archive Mode', bk.archivelog_rate?.log_mode || '—'],
    ['Log Switches/Hour', bk.archivelog_rate?.switches_per_hour ?? '—'],
    ['FRA Usage', bk.fra_usage?.pct_used != null ? bk.fra_usage.pct_used + '%' : '—'],
    ['Backup Corruptions', bk.backup_validation?.total_corruptions ?? '—'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawDbMemory(doc, y, sga, pga) {
  y = pdfPageCheck(doc, y, 100);
  y = pdfSectionTitle(doc, y, 'Memory — SGA / PGA');
  const rows = [
    ['SGA Size', (sga?.sga_size_gb || 0) + ' GB'],
    ['Buffer Cache', (sga?.buffer_cache_gb || 0) + ' GB'],
    ['Buffer Cache Hit Ratio', (sga?.buffer_cache_hit_ratio || 0) + '%'],
    ['Library Cache Hit Ratio', (sga?.library_cache_hit_ratio || 0) + '%'],
    ['Shared Pool Free', (sga?.shared_pool_free_pct || 0) + '%'],
    ['Hard Parses/sec', sga?.hard_parses_per_sec || 0],
    ['PGA Target', (pga?.pga_target_gb || 0) + ' GB'],
    ['PGA Allocated', (pga?.pga_allocated_gb || 0) + ' GB'],
    ['PGA Optimal %', (pga?.optimal_executions_pct || 0) + '%'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawDbRacAsm(doc, y, m) {
  const rac = m.rac_nodes;
  const asm = m.asm_diskgroups;
  if (!rac && !asm) return y;

  if (rac && rac.length > 0) {
    y = pdfPageCheck(doc, y, 80);
    y = pdfSectionTitle(doc, y, 'RAC Nodes');
    const cols = ['Node', 'Status', 'Open Mode'];
    const widths = [170, 120, 217];
    y = pdfTableHeader(doc, y, cols, widths);
    rac.forEach((n, i) => {
      y = pdfPageCheck(doc, y, 22);
      y = pdfTableRow(doc, y, [n.instance_name || n.node, n.status, n.open_mode || '—'], widths, i % 2 === 1);
    });
    y += 12;
  }

  if (asm && asm.length > 0) {
    y = pdfPageCheck(doc, y, 80);
    y = pdfSectionTitle(doc, y, 'ASM Disk Groups');
    const cols = ['Disk Group', 'State', 'Total GB', 'Free GB', 'Usable GB'];
    const widths = [130, 80, 80, 80, 137];
    y = pdfTableHeader(doc, y, cols, widths);
    asm.forEach((g, i) => {
      y = pdfPageCheck(doc, y, 22);
      y = pdfTableRow(doc, y, [g.name, g.state, g.total_gb, g.free_gb, g.usable_gb], widths, i % 2 === 1);
    });
    y += 12;
  }

  return y;
}

// ── EBS-only PDF sections ──────────────────────────────────────────────────────

function drawEbsSummary(doc, y, data) {
  const m = data.metrics || {};
  const ebs = m.ebs_operations || {};

  y = pdfSectionTitle(doc, y, 'EBS Operations Summary', '#C2410C');
  const cm = ebs.concurrent_managers || {};
  const wf = ebs.workflow || {};
  const rows = [
    ['Connection', data.connection_name || '—'],
    ['EBS Version', m.ebs_version || 'EBS 12.2.x'],
    ['EBS Detected', m.ebs_detected ? 'YES' : 'NO'],
    ['ICM Running / Target', cm.cm01 ? `${cm.cm01.running_processes} / ${cm.cm01.max_processes}` : '—'],
    ['Pending CM Requests', cm.cm02?.pending_requests ?? '—'],
    ['CM Error Requests (24h)', cm.cm10?.error_requests_24h ?? '—'],
    ['WF Errors', wf.wf02?.error_count ?? '—'],
    ['WF Deferred Queue', wf.wf03?.deferred_ready ?? '—'],
    ['WF Notifications >2h', wf.wf08?.pending_over_2h ?? '—'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawEbsConcurrentManagers(doc, y, cm) {
  if (!cm) return y;
  y = pdfPageCheck(doc, y, 100);
  y = pdfSectionTitle(doc, y, 'Concurrent Managers', '#C2410C');
  const rows = [
    ['ICM Running / Target', cm.cm01 ? `${cm.cm01.running_processes} / ${cm.cm01.max_processes}` : '—'],
    ['ICM Control Code', cm.cm01?.control_code || '—'],
    ['Pending Requests (P/I)', cm.cm02?.pending_requests ?? '—'],
    ['Avg Runtime (24h)', cm.cm05?.avg_runtime_secs != null ? cm.cm05.avg_runtime_secs + 's' : '—'],
    ['Completed (24h)', cm.cm05?.completed_24h ?? '—'],
    ['Error Requests (24h)', cm.cm10?.error_requests_24h ?? '—'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });

  if (cm.cm09 && cm.cm09.length > 0) {
    y += 8;
    const cols = ['Program', 'Runtime (min)', 'Started'];
    const widths = [260, 110, 137];
    y = pdfTableHeader(doc, y, cols, widths);
    cm.cm09.slice(0, 10).forEach((r, i) => {
      y = pdfPageCheck(doc, y, 22);
      y = pdfTableRow(doc, y, [
        r.program, Math.round((r.runtime_secs || 0) / 60), r.start_time,
      ], widths, i % 2 === 1);
    });
  }
  return y + 12;
}

function drawEbsWorkflow(doc, y, wf) {
  if (!wf) return y;
  y = pdfPageCheck(doc, y, 80);
  y = pdfSectionTitle(doc, y, 'Workflow', '#C2410C');
  const rows = [
    ['Error Items', wf.wf02?.error_count ?? '—'],
    ['Deferred Queue (state=0)', wf.wf03?.deferred_ready ?? '—'],
    ['Notifications Pending >2h', wf.wf08?.pending_over_2h ?? '—'],
    ['Notifications Pending >8h', wf.wf08?.pending_over_8h ?? '—'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawEbsOaCore(doc, y, ebs) {
  // OACore / OPP data lives in managed_servers / opp
  const servers = ebs.managed_servers || [];
  const opp = ebs.opp_status || ebs.opp || null;
  if (!servers.length && !opp) return y;
  y = pdfPageCheck(doc, y, 80);
  y = pdfSectionTitle(doc, y, 'OACore / OPP / Managed Servers', '#C2410C');
  if (servers.length > 0) {
    const cols = ['Server', 'Status'];
    const widths = [350, 157];
    y = pdfTableHeader(doc, y, cols, widths);
    servers.forEach((s, i) => {
      y = pdfPageCheck(doc, y, 22);
      y = pdfTableRow(doc, y, [s.label || s.name, s.status || '—'], widths, i % 2 === 1);
    });
    y += 8;
  }
  if (opp) {
    const rows = [
      ['OPP Status', opp.status || '—'],
      ['OPP Queue Depth', opp.queue_depth ?? '—'],
    ];
    rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  }
  return y + 12;
}

function drawEbsSecurity(doc, y, sec) {
  if (!sec) return y;
  y = pdfPageCheck(doc, y, 80);
  y = pdfSectionTitle(doc, y, 'EBS Security', '#C2410C');
  const rows = [
    ['Signon Audit Level', sec.sc12?.signon_audit_level || '—'],
    ['Sysadmin User Count', sec.sc14?.length ?? '—'],
  ];
  rows.forEach(([k, v], i) => { y = pdfKVRow(doc, y, k, v, i % 2 === 1); });
  return y + 12;
}

function drawEbsAdop(doc, y, ebs) {
  const adop = ebs.adop_state || ebs.adop;
  if (!adop || !adop.sessions || adop.sessions.length === 0) return y;
  y = pdfPageCheck(doc, y, 80);
  y = pdfSectionTitle(doc, y, 'ADOP Sessions', '#C2410C');
  const cols = ['Session ID', 'Phase', 'Status', 'Started', 'Patch'];
  const widths = [80, 80, 80, 100, 167];
  y = pdfTableHeader(doc, y, cols, widths);
  adop.sessions.slice(0, 10).forEach((s, i) => {
    y = pdfPageCheck(doc, y, 22);
    y = pdfTableRow(doc, y, [
      s.session_id, s.phase, s.status,
      String(s.start_date || '—').substring(0, 10), s.patch_name || '—',
    ], widths, i % 2 === 1);
  });
  return y + 12;
}

// ── Full PDF renderers (DB-only, EBS-only, Combined) ──────────────────────────

function generateDbPDF(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MG, bottom: MG, left: MG, right: MG },
    info: {
      Title: `Oracle Database Health Report — ${data.connection_name}`,
      Author: 'TuneVault', Subject: 'Oracle Database Health Check',
      Creator: 'TuneVault', Producer: 'TuneVault',
    },
    compress: true,
    bufferPages: true,
    autoFirstPage: true,
  });

  const m = data.metrics || {};
  let y = drawDbCoverPage(doc, data);
  y = drawDbSummaryKV(doc, y, data);
  doc.addPage(); y = MG;
  y = drawDbTablespaces(doc, y, m.tablespaces || []);
  y = drawDbWaitEvents(doc, y, m.wait_events || []);
  y = drawDbTopSql(doc, y, m.top_sql || []);
  y = drawDbSecurity(doc, y, m);
  y = drawDbBackup(doc, y, m.backup_stats || null);
  y = drawDbMemory(doc, y, m.sga_stats || {}, m.pga_stats || {});
  drawDbRacAsm(doc, y, m);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    pdfFooter(doc, data.connection_name);
  }

  doc.end();
  return doc;
}

function generateEbsPDF(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MG, bottom: MG, left: MG, right: MG },
    info: {
      Title: `Oracle E-Business Suite Operations Report — ${data.connection_name}`,
      Author: 'TuneVault', Subject: 'Oracle EBS Operations Health Check',
      Creator: 'TuneVault', Producer: 'TuneVault',
    },
    compress: true,
    bufferPages: true,
    autoFirstPage: true,
  });

  const m = data.metrics || {};
  const ebs = m.ebs_operations || {};

  let y = drawEbsCoverPage(doc, data);
  y = drawEbsSummary(doc, y, data);
  doc.addPage(); y = MG;
  y = drawEbsConcurrentManagers(doc, y, ebs.concurrent_managers);
  y = drawEbsWorkflow(doc, y, ebs.workflow);
  y = drawEbsOaCore(doc, y, ebs);
  y = drawEbsSecurity(doc, y, ebs.security);
  drawEbsAdop(doc, y, ebs);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    pdfFooter(doc, data.connection_name);
  }

  doc.end();
  return doc;
}

function generateCombinedPDF(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MG, bottom: MG, left: MG, right: MG },
    info: {
      Title: `TuneVault Full Stack Report — ${data.connection_name}`,
      Author: 'TuneVault', Subject: 'Oracle Database + EBS Full Stack Health Report',
      Creator: 'TuneVault', Producer: 'TuneVault',
    },
    compress: true,
    bufferPages: true,
    autoFirstPage: true,
  });

  const m = data.metrics || {};
  const ebs = m.ebs_operations || {};

  let y = drawCombinedCoverPage(doc, data);

  // ─ DB sections ─
  y = pdfSectionTitle(doc, y, '━━━  PART 1: DATABASE  ━━━');
  y = drawDbSummaryKV(doc, y, data);
  doc.addPage(); y = MG;
  y = drawDbTablespaces(doc, y, m.tablespaces || []);
  y = drawDbWaitEvents(doc, y, m.wait_events || []);
  y = drawDbTopSql(doc, y, m.top_sql || []);
  y = drawDbSecurity(doc, y, m);
  y = drawDbBackup(doc, y, m.backup_stats || null);
  y = drawDbMemory(doc, y, m.sga_stats || {}, m.pga_stats || {});
  y = drawDbRacAsm(doc, y, m);

  // ─ EBS sections — only when EBS was detected on this instance ─
  if (m.ebs_detected) {
    doc.addPage(); y = MG;
    y = pdfSectionTitle(doc, y, '━━━  PART 2: EBS OPERATIONS  ━━━', '#C2410C');
    y = drawEbsSummary(doc, y, data);
    y = drawEbsConcurrentManagers(doc, y, ebs.concurrent_managers);
    y = drawEbsWorkflow(doc, y, ebs.workflow);
    y = drawEbsOaCore(doc, y, ebs);
    y = drawEbsSecurity(doc, y, ebs.security);
    drawEbsAdop(doc, y, ebs);
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    pdfFooter(doc, data.connection_name);
  }

  doc.end();
  return doc;
}

// ── XLSX generators ────────────────────────────────────────────────────────────

async function generateDbXLSX(data, res, filename) {
  const m = data.metrics || {};
  const s = data.scores || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TuneVault';
  wb.created = new Date();

  // Summary sheet
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 24 }];
  xlAddHeaders(sum, ['Metric', 'Value']);
  const instance = m.instance || {};
  [
    ['Connection', data.connection_name],
    ['Database', instance.db_name || '—'],
    ['Oracle Version', instance.version || '—'],
    ['Host', instance.host_name || data.host || '—'],
    ['Overall Score', data.overall_score],
    ['Storage Score', s.tablespace || 0],
    ['Performance Score', s.wait_events || 0],
    ['SQL Score', s.sql_performance || 0],
    ['Memory Score', s.memory || 0],
    ['Security Score', s.security || 0],
    ['Backup Score', s.backup || 0],
    ['Generated', new Date(data.created_at).toLocaleString()],
  ].forEach(([k, v]) => sum.addRow({ k, v }));

  // Storage sheet
  if (m.tablespaces && m.tablespaces.length > 0) {
    const ts = wb.addWorksheet('Storage');
    ts.columns = [
      { header: 'Name', key: 'name', width: 24 }, { header: 'Used GB', key: 'used_gb', width: 12 },
      { header: 'Total GB', key: 'total_gb', width: 12 }, { header: 'Usage %', key: 'pct', width: 10 },
      { header: 'Autoextend', key: 'ae', width: 12 }, { header: 'Status', key: 'st', width: 12 },
    ];
    xlAddHeaders(ts, ['Name', 'Used GB', 'Total GB', 'Usage %', 'Autoextend', 'Status']);
    m.tablespaces.forEach(t => {
      const row = ts.addRow({ name: t.name, used_gb: t.used_gb, total_gb: t.total_gb, pct: t.pct_used, ae: t.autoextend ? 'ON' : 'OFF', st: t.pct_used > 90 ? 'CRITICAL' : t.pct_used > 80 ? 'WARNING' : 'OK' });
      row.getCell('pct').font = xlStatusFont(t.pct_used, 90, 80);
    });
  }

  // Performance sheet (wait events)
  if (m.wait_events && m.wait_events.length > 0) {
    const we = wb.addWorksheet('Performance');
    we.columns = [
      { header: 'Event', key: 'event', width: 36 }, { header: 'Wait Class', key: 'wc', width: 20 },
      { header: '% DB Time', key: 'pct', width: 12 }, { header: 'Avg Wait ms', key: 'avg', width: 14 },
    ];
    xlAddHeaders(we, ['Event', 'Wait Class', '% DB Time', 'Avg Wait ms']);
    m.wait_events.filter(w => w.pct_db_time > 0).forEach(w => {
      const row = we.addRow({ event: w.event, wc: w.wait_class, pct: w.pct_db_time, avg: w.avg_wait_ms });
      row.getCell('pct').font = xlStatusFont(w.pct_db_time, 10, 5);
    });
  }

  // Security sheet
  {
    const sec = wb.addWorksheet('Security');
    sec.columns = [{ header: 'Metric', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 24 }];
    xlAddHeaders(sec, ['Metric', 'Value']);
    const secData = m.security || {};
    [
      ['Audit Trail', secData.audit_trail || '—'],
      ['Failed Logins (24h)', secData.failed_logins_24h ?? '—'],
      ['Default Passwords', secData.default_passwords ?? '—'],
      ['DB Vault Enabled', secData.db_vault_enabled ? 'YES' : (secData.db_vault_enabled === false ? 'NO' : '—')],
    ].forEach(([k, v]) => sec.addRow({ k, v: String(v) }));
  }

  // Backup sheet
  if (m.backup_stats) {
    const bk = wb.addWorksheet('Backup');
    bk.columns = [{ header: 'Check', key: 'c', width: 30 }, { header: 'Status', key: 's', width: 14 }, { header: 'Detail', key: 'd', width: 44 }];
    xlAddHeaders(bk, ['Check', 'Status', 'Detail']);
    const b = m.backup_stats;
    bk.addRow({ c: 'Overall', s: (b.overall_status || 'unknown').toUpperCase(), d: '' });
    if (b.rman_backup) {
      const r = b.rman_backup;
      bk.addRow({ c: 'RMAN Configured', s: r.rman_available ? 'YES' : 'NO', d: '' });
      bk.addRow({ c: 'Last Full Backup', s: (r.status || 'unknown').toUpperCase(), d: r.full_backup_hours_ago != null ? r.full_backup_hours_ago + 'h ago' : 'NONE' });
    }
    if (b.archivelog_rate) {
      bk.addRow({ c: 'Archive Mode', s: b.archivelog_rate.log_mode || 'UNKNOWN', d: '' });
      bk.addRow({ c: 'Log Switches/Hour', s: '', d: String(b.archivelog_rate.switches_per_hour || 0) });
    }
  }

  // RAC sheet
  if (m.rac_nodes && m.rac_nodes.length > 0) {
    const rac = wb.addWorksheet('RAC');
    rac.columns = [{ header: 'Node', key: 'n', width: 28 }, { header: 'Status', key: 's', width: 16 }, { header: 'Open Mode', key: 'o', width: 18 }];
    xlAddHeaders(rac, ['Node', 'Status', 'Open Mode']);
    m.rac_nodes.forEach(n => rac.addRow({ n: n.instance_name || n.node, s: n.status, o: n.open_mode || '—' }));
  }

  // ASM sheet
  if (m.asm_diskgroups && m.asm_diskgroups.length > 0) {
    const asm = wb.addWorksheet('ASM');
    asm.columns = [
      { header: 'Disk Group', key: 'n', width: 24 }, { header: 'State', key: 's', width: 14 },
      { header: 'Total GB', key: 'tg', width: 12 }, { header: 'Free GB', key: 'fg', width: 12 },
      { header: 'Usable GB', key: 'ug', width: 12 },
    ];
    xlAddHeaders(asm, ['Disk Group', 'State', 'Total GB', 'Free GB', 'Usable GB']);
    m.asm_diskgroups.forEach(g => asm.addRow({ n: g.name, s: g.state, tg: g.total_gb, fg: g.free_gb, ug: g.usable_gb }));
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

async function generateEbsXLSX(data, res, filename) {
  const m = data.metrics || {};
  const ebs = m.ebs_operations || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TuneVault';
  wb.created = new Date();

  // Summary sheet
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Metric', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 24 }];
  xlAddHeaders(sum, ['Metric', 'Value']);
  const cm = ebs.concurrent_managers || {};
  const wf = ebs.workflow || {};
  [
    ['Connection', data.connection_name],
    ['EBS Version', m.ebs_version || 'EBS 12.2.x'],
    ['Generated', new Date(data.created_at).toLocaleString()],
    ['ICM Running / Target', cm.cm01 ? `${cm.cm01.running_processes} / ${cm.cm01.max_processes}` : '—'],
    ['Pending CM Requests', cm.cm02?.pending_requests ?? '—'],
    ['CM Error Requests (24h)', cm.cm10?.error_requests_24h ?? '—'],
    ['WF Error Items', wf.wf02?.error_count ?? '—'],
    ['WF Deferred Queue', wf.wf03?.deferred_ready ?? '—'],
    ['WF Notifications >2h', wf.wf08?.pending_over_2h ?? '—'],
  ].forEach(([k, v]) => sum.addRow({ k, v: String(v ?? '—') }));

  // Concurrent Managers sheet
  {
    const cmSheet = wb.addWorksheet('Concurrent Managers');
    cmSheet.columns = [
      { header: 'Check', key: 'c', width: 30 }, { header: 'Status', key: 's', width: 12 }, { header: 'Value', key: 'v', width: 20 }, { header: 'Notes', key: 'n', width: 36 },
    ];
    xlAddHeaders(cmSheet, ['Check', 'Status', 'Value', 'Notes']);
    if (cm.cm01) cmSheet.addRow({ c: 'Internal Manager', s: cm.cm01.running_processes === 0 ? 'FAIL' : 'OK', v: `${cm.cm01.running_processes}/${cm.cm01.max_processes} proc`, n: `Control: ${cm.cm01.control_code}` });
    if (cm.cm02) cmSheet.addRow({ c: 'Pending Requests', s: cm.cm02.pending_requests > 200 ? 'FAIL' : cm.cm02.pending_requests > 50 ? 'WARN' : 'OK', v: String(cm.cm02.pending_requests), n: 'Phase=P Status=I' });
    if (cm.cm05) cmSheet.addRow({ c: 'Avg Runtime (24h)', s: cm.cm05.avg_runtime_secs > 3600 ? 'WARN' : 'OK', v: `${cm.cm05.avg_runtime_secs}s`, n: `${cm.cm05.completed_24h} completed` });
    if (cm.cm10) cmSheet.addRow({ c: 'Error Requests (24h)', s: cm.cm10.error_requests_24h > 20 ? 'FAIL' : cm.cm10.error_requests_24h > 5 ? 'WARN' : 'OK', v: String(cm.cm10.error_requests_24h), n: 'Status IN (E,X,D)' });
    if (cm.cm09 && cm.cm09.length) {
      cmSheet.addRow({});
      cmSheet.addRow({ c: 'Long-Running Requests (>7d)', s: '', v: '', n: '' });
      cm.cm09.forEach(r => cmSheet.addRow({ c: r.program, s: `${Math.round((r.runtime_secs || 0) / 60)} min`, v: r.start_time, n: '' }));
    }
  }

  // OPP sheet
  {
    const oppSheet = wb.addWorksheet('OPP');
    oppSheet.columns = [{ header: 'Metric', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 20 }];
    xlAddHeaders(oppSheet, ['Metric', 'Value']);
    const opp = ebs.opp_status || ebs.opp;
    if (opp) {
      oppSheet.addRow({ k: 'OPP Status', v: opp.status || '—' });
      oppSheet.addRow({ k: 'OPP Queue Depth', v: String(opp.queue_depth ?? '—') });
    }
    const servers = ebs.managed_servers || [];
    if (servers.length) {
      oppSheet.addRow({});
      oppSheet.addRow({ k: 'Managed Server', v: 'Status' });
      servers.forEach(s => oppSheet.addRow({ k: s.label || s.name, v: s.status || '—' }));
    }
  }

  // OACore is covered by OPP sheet above (same managed servers data)

  // Workflow sheet
  {
    const wfSheet = wb.addWorksheet('Workflow');
    wfSheet.columns = [{ header: 'Metric', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 20 }];
    xlAddHeaders(wfSheet, ['Metric', 'Value']);
    [
      ['WF Error Items', wf.wf02?.error_count ?? '—'],
      ['WF Deferred Queue (state=0)', wf.wf03?.deferred_ready ?? '—'],
      ['WF Notifications Pending >2h', wf.wf08?.pending_over_2h ?? '—'],
      ['WF Notifications Pending >8h', wf.wf08?.pending_over_8h ?? '—'],
    ].forEach(([k, v]) => wfSheet.addRow({ k, v: String(v) }));
  }

  // ADOP Sessions sheet
  {
    const adopSheet = wb.addWorksheet('ADOP Sessions');
    adopSheet.columns = [
      { header: 'Session ID', key: 'sid', width: 14 }, { header: 'Phase', key: 'phase', width: 14 },
      { header: 'Status', key: 'st', width: 14 }, { header: 'Started', key: 'sd', width: 18 }, { header: 'Patch', key: 'p', width: 30 },
    ];
    xlAddHeaders(adopSheet, ['Session ID', 'Phase', 'Status', 'Started', 'Patch']);
    const adop = ebs.adop_state || ebs.adop;
    if (adop && adop.sessions) {
      adop.sessions.forEach(s => adopSheet.addRow({ sid: s.session_id, phase: s.phase, st: s.status, sd: String(s.start_date || '—').substring(0, 10), p: s.patch_name || '—' }));
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

async function generateCombinedXLSX(data, res, filename) {
  const m = data.metrics || {};
  const s = data.scores || {};
  const ebs = m.ebs_operations || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TuneVault';
  wb.created = new Date();

  // Master summary
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Metric', key: 'k', width: 30 }, { header: 'Value', key: 'v', width: 24 }];
  xlAddHeaders(sum, ['Metric', 'Value']);
  const instance = m.instance || {};
  const cm = ebs.concurrent_managers || {};
  const wf = ebs.workflow || {};
  [
    ['Connection', data.connection_name],
    ['Database', instance.db_name || '—'],
    ['Oracle Version', instance.version || '—'],
    ['EBS Version', m.ebs_version || (m.ebs_detected ? 'EBS 12.2.x' : 'Not detected')],
    ['Host', instance.host_name || data.host || '—'],
    ['Overall DB Score', data.overall_score],
    ['Storage Score', s.tablespace || 0],
    ['Performance Score', s.wait_events || 0],
    ['Memory Score', s.memory || 0],
    ['ICM Running / Target', cm.cm01 ? `${cm.cm01.running_processes} / ${cm.cm01.max_processes}` : '—'],
    ['Pending CM Requests', cm.cm02?.pending_requests ?? '—'],
    ['WF Error Items', wf.wf02?.error_count ?? '—'],
    ['Generated', new Date(data.created_at).toLocaleString()],
  ].forEach(([k, v]) => sum.addRow({ k, v: String(v ?? '—') }));

  // Re-use the individual generators' sheet-building patterns inline:
  // DB sheets
  if (m.tablespaces && m.tablespaces.length > 0) {
    const ts = wb.addWorksheet('DB - Storage');
    ts.columns = [{ header: 'Name', key: 'n', width: 24 }, { header: 'Used GB', key: 'u', width: 12 }, { header: 'Total GB', key: 't', width: 12 }, { header: 'Usage %', key: 'p', width: 10 }, { header: 'Status', key: 's', width: 12 }];
    xlAddHeaders(ts, ['Name', 'Used GB', 'Total GB', 'Usage %', 'Status']);
    m.tablespaces.forEach(t => ts.addRow({ n: t.name, u: t.used_gb, t: t.total_gb, p: t.pct_used, s: t.pct_used > 90 ? 'CRITICAL' : t.pct_used > 80 ? 'WARNING' : 'OK' }));
  }
  if (m.wait_events && m.wait_events.length > 0) {
    const we = wb.addWorksheet('DB - Performance');
    we.columns = [{ header: 'Event', key: 'e', width: 36 }, { header: 'Wait Class', key: 'wc', width: 20 }, { header: '% DB Time', key: 'p', width: 12 }, { header: 'Avg Wait ms', key: 'a', width: 14 }];
    xlAddHeaders(we, ['Event', 'Wait Class', '% DB Time', 'Avg Wait ms']);
    m.wait_events.filter(w => w.pct_db_time > 0).forEach(w => we.addRow({ e: w.event, wc: w.wait_class, p: w.pct_db_time, a: w.avg_wait_ms }));
  }
  if (m.backup_stats) {
    const bk = wb.addWorksheet('DB - Backup');
    bk.columns = [{ header: 'Check', key: 'c', width: 28 }, { header: 'Status', key: 's', width: 12 }, { header: 'Detail', key: 'd', width: 40 }];
    xlAddHeaders(bk, ['Check', 'Status', 'Detail']);
    const b = m.backup_stats;
    bk.addRow({ c: 'Overall', s: (b.overall_status || 'unknown').toUpperCase(), d: '' });
    if (b.rman_backup) bk.addRow({ c: 'Last Full Backup', s: (b.rman_backup.status || 'unknown').toUpperCase(), d: b.rman_backup.full_backup_hours_ago != null ? b.rman_backup.full_backup_hours_ago + 'h ago' : 'NONE' });
  }

  // EBS sheets
  if (m.ebs_detected) {
    const cmSheet = wb.addWorksheet('EBS - Concurrent Managers');
    cmSheet.columns = [{ header: 'Check', key: 'c', width: 28 }, { header: 'Status', key: 's', width: 12 }, { header: 'Value', key: 'v', width: 20 }, { header: 'Notes', key: 'n', width: 36 }];
    xlAddHeaders(cmSheet, ['Check', 'Status', 'Value', 'Notes']);
    if (cm.cm01) cmSheet.addRow({ c: 'Internal Manager', s: cm.cm01.running_processes === 0 ? 'FAIL' : 'OK', v: `${cm.cm01.running_processes}/${cm.cm01.max_processes}`, n: `Control: ${cm.cm01.control_code}` });
    if (cm.cm02) cmSheet.addRow({ c: 'Pending Requests', s: cm.cm02.pending_requests > 200 ? 'FAIL' : 'OK', v: String(cm.cm02.pending_requests), n: '' });
    if (cm.cm10) cmSheet.addRow({ c: 'Error Requests (24h)', s: cm.cm10.error_requests_24h > 20 ? 'FAIL' : 'OK', v: String(cm.cm10.error_requests_24h), n: '' });

    const wfSheet = wb.addWorksheet('EBS - Workflow');
    wfSheet.columns = [{ header: 'Metric', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 20 }];
    xlAddHeaders(wfSheet, ['Metric', 'Value']);
    [
      ['WF Error Items', wf.wf02?.error_count ?? '—'],
      ['WF Deferred Queue', wf.wf03?.deferred_ready ?? '—'],
      ['WF Notifications >2h', wf.wf08?.pending_over_2h ?? '—'],
    ].forEach(([k, v]) => wfSheet.addRow({ k, v: String(v) }));

    const adopSheet = wb.addWorksheet('EBS - ADOP Sessions');
    adopSheet.columns = [{ header: 'Session ID', key: 'sid', width: 14 }, { header: 'Phase', key: 'ph', width: 14 }, { header: 'Status', key: 'st', width: 14 }, { header: 'Patch', key: 'p', width: 30 }];
    xlAddHeaders(adopSheet, ['Session ID', 'Phase', 'Status', 'Patch']);
    const adop = ebs.adop_state || ebs.adop;
    if (adop && adop.sessions) {
      adop.sessions.forEach(s => adopSheet.addRow({ sid: s.session_id, ph: s.phase, st: s.status, p: s.patch_name || '—' }));
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ── DB health check lookup ─────────────────────────────────────────────────────

async function resolveHealthCheck(connectionId) {
  // Get oracle_connections row for display name + EBS flag
  const connResult = await pool.query(
    'SELECT id, name, host FROM oracle_connections WHERE id = $1',
    [connectionId]
  );
  if (connResult.rows.length === 0) return null;
  const conn = connResult.rows[0];

  // Latest completed health check for this connection
  const hcResult = await pool.query(
    `SELECT * FROM health_checks
     WHERE connection_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 1`,
    [connectionId]
  );
  if (hcResult.rows.length === 0) return null;
  const hc = hcResult.rows[0];

  return { conn, hc };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/reports/demo/db?format=pdf|xlsx — demo health check export (no connection required)
// MUST be defined before /:connectionId/db to avoid 'demo' being captured as a connectionId param.
router.get('/demo/db', requireAuth, async (req, res) => {
  try {
    const format = (req.query.format || 'pdf').toLowerCase();
    const hcResult = await pool.query(
      `SELECT * FROM health_checks
       WHERE user_id = $1 AND is_demo = true AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (hcResult.rows.length === 0) {
      return res.status(404).json({ error: 'No demo health check found. Run a demo first.' });
    }
    const hc = hcResult.rows[0];
    const m = hc.metrics || {};
    const { getSummaryScores } = require('../demo-data');
    const scores = getSummaryScores(m);
    const data = {
      id: hc.id,
      connection_name: 'PRODDB01 Demo',
      host: 'ora-prod-01.corp.internal',
      is_demo: true,
      overall_score: hc.overall_score || 61,
      scores,
      metrics: m,
      ai_analysis: hc.ai_analysis,
      summary_text: hc.summary_text,
      top_action: hc.top_action,
      ebs_summary: hc.ebs_summary,
      ebs_action: hc.ebs_action,
      created_at: hc.created_at,
    };
    const date = yyyymmdd(hc.completed_at || hc.created_at);
    if (format === 'xlsx') {
      return generateDbXLSX(data, res, `tunevault-demo-db-${date}.xlsx`);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tunevault-demo-db-${date}.pdf"`);
    generateDbPDF(data).pipe(res);
  } catch (err) {
    console.error('[reports] demo db error', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate demo report' });
  }
});

// GET /api/reports/:connectionId/db?format=pdf|xlsx — junior_dba+ can export
router.get('/:connectionId/db', requireAuth, requireRole('junior_dba'), async (req, res) => {
  try {
    const { connectionId } = req.params;
    const format = (req.query.format || 'pdf').toLowerCase();

    const row = await resolveHealthCheck(connectionId);
    if (!row) return res.status(404).json({ error: 'No completed health check found for this connection' });
    const { conn, hc } = row;

    const { getSummaryScores } = require('../demo-data');
    const m = hc.metrics || {};
    const scores = m && Object.keys(m).length > 0 ? getSummaryScores(m) : {};
    const data = {
      id: hc.id, connection_name: conn.name || hc.connection_name,
      username: hc.username, host: conn.host || hc.host,
      service_name: hc.service_name, is_demo: hc.is_demo,
      overall_score: hc.overall_score, scores, metrics: m,
      ai_analysis: hc.ai_analysis, summary_text: hc.summary_text,
      top_action: hc.top_action, created_at: hc.created_at,
    };

    const instance = safeName(m.instance?.db_name || conn.name || 'oracle');
    const date = yyyymmdd(hc.completed_at || hc.created_at);

    if (format === 'xlsx') {
      return generateDbXLSX(data, res, `tunevault-db-${instance}-${date}.xlsx`);
    }
    const filename = `tunevault-db-${instance}-${date}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    generateDbPDF(data).pipe(res);
  } catch (err) {
    console.error('[reports] db error', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate DB report' });
  }
});

// GET /api/reports/:connectionId/ebs?format=pdf|xlsx — junior_dba+
router.get('/:connectionId/ebs', requireAuth, requireRole('junior_dba'), async (req, res) => {
  try {
    const { connectionId } = req.params;
    const format = (req.query.format || 'pdf').toLowerCase();

    const row = await resolveHealthCheck(connectionId);
    if (!row) return res.status(404).json({ error: 'No completed health check found for this connection' });
    const { conn, hc } = row;

    const m = hc.metrics || {};
    if (!m.ebs_detected) {
      return res.status(404).json({ error: 'EBS not detected on this instance' });
    }

    const { getSummaryScores } = require('../demo-data');
    const scores = m && Object.keys(m).length > 0 ? getSummaryScores(m) : {};
    const data = {
      id: hc.id, connection_name: conn.name || hc.connection_name,
      username: hc.username, host: conn.host || hc.host,
      service_name: hc.service_name, is_demo: hc.is_demo,
      overall_score: hc.overall_score, scores, metrics: m,
      ai_analysis: hc.ai_analysis, ebs_summary: hc.ebs_summary,
      ebs_action: hc.ebs_action, created_at: hc.created_at,
    };

    const instance = safeName(m.instance?.db_name || conn.name || 'oracle');
    const date = yyyymmdd(hc.completed_at || hc.created_at);

    if (format === 'xlsx') {
      return generateEbsXLSX(data, res, `tunevault-ebs-${instance}-${date}.xlsx`);
    }
    const filename = `tunevault-ebs-${instance}-${date}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    generateEbsPDF(data).pipe(res);
  } catch (err) {
    console.error('[reports] ebs error', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate EBS report' });
  }
});

// GET /api/reports/:connectionId/combined?format=pdf|xlsx — junior_dba+
router.get('/:connectionId/combined', requireAuth, requireRole('junior_dba'), async (req, res) => {
  try {
    const { connectionId } = req.params;
    const format = (req.query.format || 'pdf').toLowerCase();

    const row = await resolveHealthCheck(connectionId);
    if (!row) return res.status(404).json({ error: 'No completed health check found for this connection' });
    const { conn, hc } = row;

    const { getSummaryScores } = require('../demo-data');
    const m = hc.metrics || {};
    const scores = m && Object.keys(m).length > 0 ? getSummaryScores(m) : {};
    const data = {
      id: hc.id, connection_name: conn.name || hc.connection_name,
      username: hc.username, host: conn.host || hc.host,
      service_name: hc.service_name, is_demo: hc.is_demo,
      overall_score: hc.overall_score, scores, metrics: m,
      ai_analysis: hc.ai_analysis, summary_text: hc.summary_text,
      ebs_summary: hc.ebs_summary, ebs_action: hc.ebs_action,
      created_at: hc.created_at,
    };

    const instance = safeName(m.instance?.db_name || conn.name || 'oracle');
    const date = yyyymmdd(hc.completed_at || hc.created_at);

    if (format === 'xlsx') {
      return generateCombinedXLSX(data, res, `tunevault-full-${instance}-${date}.xlsx`);
    }
    const filename = `tunevault-full-${instance}-${date}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    generateCombinedPDF(data).pipe(res);
  } catch (err) {
    console.error('[reports] combined error', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate combined report' });
  }
});

module.exports = router;
