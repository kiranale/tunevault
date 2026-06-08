'use strict';

/**
 * routes/health-check-export.js — Per-check-row PDF + CSV export for health check runs.
 *
 * Owns: GET /api/health-checks/:run_id/export?format=pdf|csv
 * Does NOT own: health_checks CRUD, ai_analysis, connection management, auth.
 *
 * Export is DBA-first: concrete metrics, severity-sorted Critical→Warning→Info→OK,
 * no abstract 0-100 scores. Rows derived from health_checks.metrics blob, same source
 * used by persistCheckResults(). Audited to audit_log on every export.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Brand colours ──────────────────────────────────────────────────────────────
const C = {
  headerBg:  '#0A0A14',
  accent:    '#D4871A',
  text:      '#1A1A2E',
  textDim:   '#6B6B8A',
  textLight: '#FFFFFF',
  border:    '#E2E4EE',
  bgAlt:     '#F8F9FC',
  red:       '#DC2626',
  redBg:     '#FEE2E2',
  yellow:    '#B45309',
  yellowBg:  '#FEF3C7',
  blue:      '#2563EB',
  blueBg:    '#DBEAFE',
  green:     '#059669',
  greenBg:   '#D1FAE5',
};

const PW = 595;   // A4 width pts
const PH = 842;   // A4 height pts
const MG = 40;    // margin
const CW = PW - MG * 2;

// ── Severity helpers ───────────────────────────────────────────────────────────

// Map check_results status → severity label for export
function statusToSeverity(status) {
  if (status === 'red')   return 'Critical';
  if (status === 'amber') return 'Warning';
  if (status === 'green') return 'OK';
  if (status === 'error') return 'Error';
  return 'Info';
}

const SEVERITY_ORDER = { Critical: 0, Warning: 1, Info: 2, OK: 3, Error: 4 };

function severityColor(sev) {
  if (sev === 'Critical') return C.red;
  if (sev === 'Warning')  return C.yellow;
  if (sev === 'OK')       return C.green;
  return C.blue;
}

function severityBg(sev) {
  if (sev === 'Critical') return C.redBg;
  if (sev === 'Warning')  return C.yellowBg;
  if (sev === 'OK')       return C.greenBg;
  return C.blueBg;
}

// ── Derive per-check rows from health_checks.metrics ──────────────────────────
// Mirrors persistCheckResults() but returns plain objects for export use.
// check_results.status: red|amber|green — we map to Critical|Warning|OK.

function deriveCheckRows(metrics, scores) {
  const rows = [];

  function scoreToStatus(score) {
    if (score == null) return 'amber';
    if (score >= 80) return 'green';
    if (score >= 60) return 'amber';
    return 'red';
  }

  // --- Storage: tablespaces ---
  for (const ts of (metrics.tablespaces || [])) {
    const threshold = ts.pct_used > 90 ? '90%' : ts.pct_used > 80 ? '80%' : '—';
    rows.push({
      check_id: 'ST01_TABLESPACE_USAGE',
      category: 'Storage',
      check_name: `Tablespace: ${ts.name}`,
      observed_value: `${ts.pct_used}% used — ${ts.used_gb} GB used of ${ts.total_gb} GB`,
      threshold,
      status: ts.pct_used > 90 ? 'red' : ts.pct_used > 80 ? 'amber' : 'green',
      remediation: ts.pct_used > 90
        ? `ALTER DATABASE DATAFILE '...' RESIZE <newsize>M; -- or add datafile to ${ts.name}`
        : ts.pct_used > 80
        ? `ALTER TABLESPACE ${ts.name} ADD DATAFILE '<path>/<name>.dbf' SIZE 1G AUTOEXTEND ON;`
        : null,
      doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/admin/managing-tablespaces.html',
    });
  }

  // --- Storage: undo ---
  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    rows.push({
      check_id: 'ST02_UNDO_USAGE',
      category: 'Storage',
      check_name: `Undo Tablespace: ${u.tablespace_name || 'UNDOTBS1'}`,
      observed_value: `${u.pct_used || 0}% used`,
      threshold: '90%',
      status: (u.pct_used || 0) > 90 ? 'red' : (u.pct_used || 0) > 70 ? 'amber' : 'green',
      remediation: (u.pct_used || 0) > 90 ? `ALTER TABLESPACE ${u.tablespace_name || 'UNDOTBS1'} ADD DATAFILE SIZE 2G AUTOEXTEND ON;` : null,
      doc_link: null,
    });
  }

  // --- Storage: temp ---
  if (metrics.temp_stats && metrics.temp_stats.current) {
    const t = metrics.temp_stats.current;
    rows.push({
      check_id: 'ST03_TEMP_USAGE',
      category: 'Storage',
      check_name: `Temp Tablespace: ${t.tablespace_name || 'TEMP'}`,
      observed_value: `${t.pct_used || 0}% used`,
      threshold: '90%',
      status: (t.pct_used || 0) > 90 ? 'red' : (t.pct_used || 0) > 70 ? 'amber' : 'green',
      remediation: (t.pct_used || 0) > 90 ? `ALTER TABLESPACE ${t.tablespace_name || 'TEMP'} ADD TEMPFILE SIZE 2G AUTOEXTEND ON;` : null,
      doc_link: null,
    });
  }

  // --- Performance: wait events ---
  const waitSt = scoreToStatus(scores && scores.wait_events);
  const topWait = (metrics.wait_events || []).filter(w => w.pct_db_time > 5).map(w => `${w.event} (${w.pct_db_time}%)`).slice(0, 3).join('; ') || 'None above 5%';
  rows.push({
    check_id: 'PF01_WAIT_EVENTS',
    category: 'Performance',
    check_name: 'Wait Events',
    observed_value: topWait,
    threshold: '<5% DB time per event',
    status: waitSt,
    remediation: waitSt === 'red' ? 'SELECT event, total_waits, time_waited FROM v$system_event ORDER BY time_waited DESC FETCH FIRST 10 ROWS ONLY;' : null,
    doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/tgdba/instance-tuning-using-performance-views.html',
  });

  // --- Performance: top SQL ---
  const sqlSt = scoreToStatus(scores && scores.sql_performance);
  const topSql = (metrics.top_sql || []).filter(s => s.elapsed_per_exec_ms > 1000).map(s => `SQL ${s.sql_id} (${s.elapsed_per_exec_ms}ms/exec)`).slice(0, 3).join('; ') || 'No SQL >1s/exec';
  rows.push({
    check_id: 'PF02_SQL_PERFORMANCE',
    category: 'Performance',
    check_name: 'Top SQL Performance',
    observed_value: topSql,
    threshold: '<1000ms/exec',
    status: sqlSt,
    remediation: sqlSt === 'red' ? "SELECT sql_id, elapsed_time/executions/1000 ms_per_exec FROM v$sql WHERE executions > 0 ORDER BY elapsed_time/executions DESC FETCH FIRST 20 ROWS ONLY;" : null,
    doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/index.html',
  });

  // --- Performance: active sessions ---
  const sessSt = scoreToStatus(scores && scores.active_sessions);
  const sessionResource = ((metrics.resource_limits && metrics.resource_limits.current) || []).find(r => r.resource === 'sessions');
  rows.push({
    check_id: 'PF03_ACTIVE_SESSIONS',
    category: 'Performance',
    check_name: 'Active Sessions',
    observed_value: sessionResource ? `${sessionResource.pct_max_used}% of limit (${sessionResource.current_utilization}/${sessionResource.max_utilization})` : 'N/A',
    threshold: '<80% of session limit',
    status: sessSt,
    remediation: sessSt === 'red' ? 'SELECT sid, status, machine, program FROM v$session WHERE status=\'ACTIVE\' ORDER BY last_call_et DESC;' : null,
    doc_link: null,
  });

  // --- Memory: SGA/PGA ---
  const memSt = scoreToStatus(scores && scores.memory);
  const bufHit = metrics.sga_stats ? metrics.sga_stats.buffer_cache_hit_ratio : null;
  const freeRam = metrics.os_stats && metrics.os_stats.free_memory_gb != null ? `${metrics.os_stats.free_memory_gb} GB OS free` : null;
  rows.push({
    check_id: 'MEM01_SGA_PGA',
    category: 'Memory',
    check_name: 'SGA / PGA Memory',
    observed_value: [bufHit != null ? `Buffer hit: ${bufHit}%` : null, freeRam].filter(Boolean).join(' | ') || 'N/A',
    threshold: 'Buffer hit >95%, OS free >10%',
    status: memSt,
    remediation: memSt === 'red' ? "ALTER SYSTEM SET sga_target=<newsize>M SCOPE=SPFILE; ALTER SYSTEM SET pga_aggregate_target=<newsize>M SCOPE=SPFILE;" : null,
    doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/tgdba/memory-configuration-and-use.html',
  });

  // --- Backup: RMAN freshness ---
  if (metrics.backup_stats && metrics.backup_stats.rman_backup) {
    const b = metrics.backup_stats.rman_backup;
    rows.push({
      check_id: 'BK01_RMAN_FRESHNESS',
      category: 'Backup',
      check_name: 'RMAN Last Full Backup',
      observed_value: b.last_full_backup ? `${b.full_backup_hours_ago}h ago (${b.last_full_backup.end_time || 'unknown'})` : 'No full backup found',
      threshold: '<24h (daily), <48h (critical)',
      status: b.status === 'critical' ? 'red' : b.status === 'warning' ? 'amber' : 'green',
      remediation: (b.full_backup_hours_ago || 999) > 48 ? 'RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG;' : null,
      doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/getting-started-rman.html',
    });
  }

  // --- Backup: FRA usage ---
  if (metrics.backup_stats && metrics.backup_stats.fra_usage) {
    const f = metrics.backup_stats.fra_usage;
    rows.push({
      check_id: 'BK02_FRA_USAGE',
      category: 'Backup',
      check_name: 'Flash Recovery Area Usage',
      observed_value: `${f.pct_used || 0}% used`,
      threshold: '<80% warning, <90% critical',
      status: (f.pct_used || 0) > 90 ? 'red' : (f.pct_used || 0) > 80 ? 'amber' : 'green',
      remediation: (f.pct_used || 0) > 80 ? 'RMAN> DELETE NOPROMPT OBSOLETE; -- or increase db_recovery_file_dest_size' : null,
      doc_link: null,
    });
  }

  // --- Backup: archivelog mode ---
  if (metrics.backup_stats && metrics.backup_stats.archivelog_rate) {
    const a = metrics.backup_stats.archivelog_rate;
    rows.push({
      check_id: 'BK03_ARCHIVELOG_RATE',
      category: 'Backup',
      check_name: 'Archivelog Mode',
      observed_value: a.archivelog_mode === false ? 'NOT in ARCHIVELOG mode' : `${a.switches_per_hour || 0} switches/hr`,
      threshold: 'ARCHIVELOG mode required',
      status: a.archivelog_mode === false ? 'red' : a.status === 'warning' ? 'amber' : 'green',
      remediation: a.archivelog_mode === false ? 'SHUTDOWN IMMEDIATE; STARTUP MOUNT; ALTER DATABASE ARCHIVELOG; ALTER DATABASE OPEN;' : null,
      doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/starting-configuring-recovery-manager.html',
    });
  }

  // --- Config: alert log ---
  if (metrics.alert_log) {
    const al = metrics.alert_log;
    const criticals = (al.critical || []).length;
    const warnings  = (al.warning  || []).length;
    rows.push({
      check_id: 'CF01_ALERT_LOG',
      category: 'Config',
      check_name: 'Alert Log (24h)',
      observed_value: `${criticals} critical, ${warnings} warning events`,
      threshold: '0 critical events',
      status: criticals > 0 ? 'red' : warnings > 0 ? 'amber' : 'green',
      remediation: criticals > 0 ? 'tail -500 $ORACLE_BASE/diag/rdbms/*/*/trace/alert_*.log | grep -E "ORA-|Error"' : null,
      doc_link: null,
    });
  }

  // --- Config: resource limits ---
  if (metrics.resource_limits && metrics.resource_limits.current) {
    const limits = metrics.resource_limits.current || [];
    for (const lim of limits) {
      const pct = lim.pct_max_used || 0;
      rows.push({
        check_id: `CF02_RESOURCE_${(lim.resource || 'unknown').toUpperCase()}`,
        category: 'Config',
        check_name: `Resource Limit: ${lim.resource || 'unknown'}`,
        observed_value: `${lim.current_utilization || 0}/${lim.max_utilization || 0} (${pct}%)`,
        threshold: '<80%',
        status: pct > 90 ? 'red' : pct > 80 ? 'amber' : 'green',
        remediation: pct > 90 ? `ALTER SYSTEM SET ${lim.resource || 'sessions'}=<newvalue>;` : null,
        doc_link: null,
      });
    }
  }

  // --- Security: index analysis ---
  const idxSt = scoreToStatus(scores && scores.index_health);
  if (metrics.index_analysis) {
    const ia = metrics.index_analysis;
    const unusedCount = (ia.unused_indexes || []).length;
    const invalCount  = (ia.invalid_indexes || []).length;
    rows.push({
      check_id: 'SEC01_INDEX_HEALTH',
      category: 'Security',
      check_name: 'Index Health',
      observed_value: `${unusedCount} unused, ${invalCount} invalid indexes`,
      threshold: '0 invalid, <10 unused',
      status: idxSt,
      remediation: invalCount > 0 ? 'ALTER INDEX <schema>.<index_name> REBUILD;' : null,
      doc_link: 'https://docs.oracle.com/en/database/oracle/oracle-database/19/admin/managing-indexes.html',
    });
  }

  // --- EBS: ebs_operations checks ---
  if (metrics.ebs_operations) {
    const ebs = metrics.ebs_operations;

    if (ebs.concurrent_managers != null) {
      const down = (ebs.concurrent_managers || []).filter(c => c.status !== 'Active').length;
      rows.push({
        check_id: 'EBS_CM_STATUS',
        category: 'EBS',
        check_name: 'EBS Concurrent Managers',
        observed_value: `${down} of ${(ebs.concurrent_managers || []).length} managers down`,
        threshold: '0 managers down',
        status: down > 0 ? 'red' : 'green',
        remediation: down > 0 ? 'su - applmgr -c "adcmctl.sh start apps/<apps_pwd>"' : null,
        doc_link: null,
      });
    }

    if (ebs.workflow_mailer != null) {
      const wfStatus = ebs.workflow_mailer && ebs.workflow_mailer.status;
      rows.push({
        check_id: 'EBS_WF_MAILER',
        category: 'EBS',
        check_name: 'EBS Workflow Mailer',
        observed_value: wfStatus || 'Unknown',
        threshold: 'Running',
        status: wfStatus === 'Running' ? 'green' : wfStatus ? 'amber' : 'amber',
        remediation: wfStatus !== 'Running' ? 'SELECT COMPONENT_STATUS FROM WF_MAILER_PARAMETERS; -- check OAM/Workflow admin for mailer restart' : null,
        doc_link: null,
      });
    }
  }

  return rows;
}

// ── Sort check rows: Critical→Warning→Info→OK, then by category ───────────────
function sortCheckRows(rows) {
  return [...rows].sort((a, b) => {
    const sa = SEVERITY_ORDER[statusToSeverity(a.status)] ?? 5;
    const sb = SEVERITY_ORDER[statusToSeverity(b.status)] ?? 5;
    if (sa !== sb) return sa - sb;
    return (a.category || '').localeCompare(b.category || '');
  });
}

// ── CSV generation ────────────────────────────────────────────────────────────

function buildCSV(hc, checks) {
  const CSV_COLS = ['severity', 'category', 'check_name', 'observed_value', 'threshold', 'status', 'remediation_command', 'doc_link'];
  const lines = [CSV_COLS.join(',')];
  for (const c of checks) {
    const sev = statusToSeverity(c.status);
    const row = [
      csvField(sev),
      csvField(c.category),
      csvField(c.check_name),
      csvField(c.observed_value),
      csvField(c.threshold),
      csvField(c.status === 'red' ? 'FAIL' : c.status === 'amber' ? 'WARN' : 'OK'),
      csvField(c.remediation),
      csvField(c.doc_link),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

function csvField(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  // Quote if contains comma, newline, or double-quote
  if (/[,"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ── PDF generation ────────────────────────────────────────────────────────────

function buildExportPDF(hc, checks, opts) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: MG, bottom: MG, left: MG, right: MG }, autoFirstPage: false });
  doc.addPage();

  let y = MG;

  // ── COVER / HEADER BAND ──────────────────────────────────────────────────────
  doc.rect(0, 0, PW, 90).fill(C.headerBg);
  doc.rect(0, 90, PW, 4).fill(C.accent);

  // Logo badge
  doc.rect(MG, 18, 34, 34).fillAndStroke(C.accent, C.accent);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.headerBg).text('TV', MG, 28, { width: 34, align: 'center' });

  // Wordmark
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.textLight).text('TuneVault', MG + 46, 20);
  doc.font('Helvetica').fontSize(9).fillColor(C.accent).text('Oracle Database Health Check Report', MG + 46, 42);

  // Connection info (right side)
  const connInfo = [
    opts.connection_name || hc.connection_name || 'Unknown',
    `${hc.host || '—'}:${hc.port || 1521}/${hc.service_name || '—'}`,
  ].join('  |  ');
  doc.font('Helvetica').fontSize(8).fillColor('#aaaacc').text(connInfo, 0, 22, { width: PW - MG - 8, align: 'right' });

  const genAt = new Date(hc.completed_at || hc.created_at || Date.now());
  const genAtUTC = genAt.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  const agentVer = opts.agent_version || hc.agent_version || '—';
  doc.font('Helvetica').fontSize(8).fillColor('#aaaacc').text(`Generated: ${genAtUTC}  |  Agent: ${agentVer}`, 0, 36, { width: PW - MG - 8, align: 'right' });

  y = 108;

  // ── SEVERITY SUMMARY BAR ─────────────────────────────────────────────────────
  const critCount = checks.filter(c => c.status === 'red').length;
  const warnCount = checks.filter(c => c.status === 'amber').length;
  const okCount   = checks.filter(c => c.status === 'green').length;
  const totalCount = checks.length;

  const summaryItems = [
    { label: 'Critical',  count: critCount,  color: C.red,   bg: C.redBg   },
    { label: 'Warning',   count: warnCount,  color: C.yellow, bg: C.yellowBg },
    { label: 'OK',        count: okCount,    color: C.green,  bg: C.greenBg  },
    { label: 'Total',     count: totalCount, color: C.text,   bg: C.bgAlt    },
  ];

  const barH = 52;
  doc.rect(MG, y, CW, barH).fill(C.bgAlt);
  doc.rect(MG, y, CW, barH).stroke(C.border);

  const itemW = CW / summaryItems.length;
  summaryItems.forEach((item, i) => {
    const ix = MG + i * itemW;
    doc.rect(ix, y, itemW, barH).stroke(C.border);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(item.color).text(String(item.count), ix, y + 7, { width: itemW, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(C.textDim).text(item.label, ix, y + 34, { width: itemW, align: 'center' });
  });

  y += barH + 14;

  // ── SECTION DRAWING ───────────────────────────────────────────────────────────
  const PAGE_BOTTOM = PH - MG - 24; // reserve space for footer

  function ensureSpace(needed) {
    if (y + needed > PAGE_BOTTOM) {
      drawFooter(doc, hc, agentVer, genAtUTC);
      doc.addPage();
      y = MG;
    }
  }

  function drawSectionHeader(label, color) {
    ensureSpace(28);
    doc.rect(MG, y, CW, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.textLight).text(label, MG + 8, y + 6, { width: CW - 16 });
    y += 22 + 4;
  }

  function drawCheckRow(c, altRow) {
    const sev = statusToSeverity(c.status);
    const sevColor = severityColor(sev);
    const rowH = estimateRowHeight(c);
    ensureSpace(rowH);

    // Alt row background
    if (altRow) doc.rect(MG, y, CW, rowH).fill(C.bgAlt);

    // Severity pill
    doc.rect(MG + 2, y + 3, 58, 14).fill(severityBg(sev));
    doc.font('Helvetica-Bold').fontSize(8).fillColor(sevColor).text(sev, MG + 2, y + 6, { width: 58, align: 'center' });

    // Category
    doc.font('Helvetica').fontSize(7.5).fillColor(C.textDim).text(c.category || '', MG + 66, y + 6, { width: 64 });

    // Check name
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.text).text(c.check_name || '', MG + 136, y + 4, { width: 230 });

    // Observed value
    doc.font('Helvetica').fontSize(8).fillColor(C.text).text(c.observed_value || '—', MG + 136, y + 16, { width: 230 });

    // Threshold (right-aligned area)
    doc.font('Helvetica').fontSize(7.5).fillColor(C.textDim).text(`Threshold: ${c.threshold || '—'}`, MG + 372, y + 4, { width: 148 });

    let remY = y + 28;
    // Remediation command in monospace box
    if (c.remediation) {
      const remLines = c.remediation.length > 90 ? Math.ceil(c.remediation.length / 80) : 1;
      const remH = remLines * 11 + 8;
      doc.rect(MG + 136, remY, CW - 136, remH).fill('#1E1E2E').stroke('#444');
      doc.font('Courier').fontSize(7).fillColor('#A8F0A0').text(c.remediation, MG + 140, remY + 4, { width: CW - 144 });
      remY += remH + 4;
    }

    const rowBottomPad = 4;
    y = remY + rowBottomPad;

    // Row separator
    doc.moveTo(MG, y - rowBottomPad / 2).lineTo(MG + CW, y - rowBottomPad / 2).stroke(C.border);
  }

  function estimateRowHeight(c) {
    let h = 32;
    if (c.remediation) {
      const remLines = c.remediation.length > 90 ? Math.ceil(c.remediation.length / 80) : 1;
      h += remLines * 11 + 12;
    }
    return h;
  }

  // Group checks by severity section
  const sections = [
    { label: '⚠ Critical Issues', severity: 'Critical', bg: C.red    },
    { label: '▲ Warnings',        severity: 'Warning',  bg: C.yellow },
    { label: '✓ OK',              severity: 'OK',        bg: C.green  },
    { label: '  Info / Other',    severity: 'Info',      bg: C.blue   },
  ];

  for (const sec of sections) {
    const secChecks = checks.filter(c => statusToSeverity(c.status) === sec.severity);
    if (secChecks.length === 0) continue;
    drawSectionHeader(`${sec.label}  (${secChecks.length})`, sec.bg);
    secChecks.forEach((c, i) => drawCheckRow(c, i % 2 === 1));
    y += 6;
  }

  // ── FINAL PAGE FOOTER ─────────────────────────────────────────────────────────
  drawFooter(doc, hc, agentVer, genAtUTC);
  return doc;
}

function drawFooter(doc, hc, agentVer, genAtUTC) {
  const footerY = PH - MG - 14;
  doc.rect(0, footerY - 4, PW, 1).fill(C.border);
  const footerText = `Generated by TuneVault — connection ${hc.connection_id || hc.id} — agent ${agentVer} — ${genAtUTC}`;
  doc.font('Helvetica').fontSize(7).fillColor(C.textDim).text(footerText, MG, footerY, { width: CW - 60, align: 'left' });
  // Page n of N — PDFKit doesn't natively support "of N" without two-pass; show page number only
  const range = doc.bufferedPageRange();
  const pageNum = range ? range.start + range.count : '?';
  doc.font('Helvetica').fontSize(7).fillColor(C.textDim).text(`Page ${pageNum}`, MG, footerY, { width: CW, align: 'right' });
}

// ── Filename helpers ──────────────────────────────────────────────────────────
function safeName(s) {
  return (s || 'oracle').replace(/[^a-z0-9_\-]/gi, '_').substring(0, 40);
}

function yyyymmddhhmi(d) {
  const dt = d ? new Date(d) : new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}-${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}`;
}

// ── Audit log helper ──────────────────────────────────────────────────────────
async function logExport({ userId, runId, format, connectionName }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, slug, allowed, rejection_reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        'export_health_check',
        `health_check:${runId}`,
        true,
        null,
        JSON.stringify({ run_id: runId, format, connection_name: connectionName }),
      ]
    );
  } catch (e) {
    // Non-blocking — audit failures must not break the export
    console.error('[hc-export] audit_log write failed:', e.message);
  }
}

// ── GET /api/health-checks/:run_id/export?format=pdf|csv ─────────────────────
// Any user who can view the health check run can export it.
// Auth: requireAuth — ownership enforced by user_id / user_id IS NULL check.

router.get('/:run_id/export', requireAuth, async (req, res) => {
  try {
    const runId = req.params.run_id;
    const format = (req.query.format || 'pdf').toLowerCase();

    if (!['pdf', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format — use pdf or csv' });
    }

    // Fetch health check + connection details (owner check built into WHERE)
    const result = await pool.query(
      `SELECT hc.*, oc.name AS conn_name_saved, oc.host AS conn_host,
              oc.port AS conn_port, oc.service_name AS conn_service,
              at.agent_version AS tunnel_agent_version
       FROM health_checks hc
       LEFT JOIN oracle_connections oc ON oc.id = hc.connection_id
       LEFT JOIN agent_tunnels at ON at.connection_id = hc.connection_id AND at.status = 'active'
       WHERE hc.id = $1 AND (hc.user_id = $2 OR hc.user_id IS NULL)
       LIMIT 1`,
      [runId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = result.rows[0];

    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    // Enrich hc with connection fields
    hc.host        = hc.conn_host        || hc.host;
    hc.port        = hc.conn_port        || hc.port;
    hc.service_name = hc.conn_service    || hc.service_name;
    hc.agent_version = hc.tunnel_agent_version || null;

    const m      = hc.metrics  || {};
    const scores = m.scores    || {};   // some metric blobs embed scores
    // If scores not embedded, reconstruct via demo-data path (graceful degradation)
    let effectiveScores = scores;
    if (!effectiveScores || Object.keys(effectiveScores).length === 0) {
      try {
        const { getSummaryScores } = require('../demo-data');
        effectiveScores = getSummaryScores(m);
      } catch { effectiveScores = {}; }
    }

    const checks = sortCheckRows(deriveCheckRows(m, effectiveScores));

    const connectionName = hc.conn_name_saved || hc.connection_name || 'oracle';
    const slug = safeName(connectionName);
    const ts   = yyyymmddhhmi(hc.completed_at || hc.created_at);
    const agentVer = hc.agent_version || '—';

    // Audit (non-blocking)
    logExport({ userId: req.user.id, runId, format, connectionName });

    if (format === 'csv') {
      const csv = buildCSV(hc, checks);
      const filename = `tunevault-healthcheck-${slug}-${ts}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    // PDF
    const filename = `tunevault-healthcheck-${slug}-${ts}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const pdfDoc = buildExportPDF(hc, checks, { connection_name: connectionName, agent_version: agentVer });
    pdfDoc.pipe(res);
    pdfDoc.end();
  } catch (err) {
    console.error('[hc-export] error:', err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate export' });
    }
  }
});

module.exports = router;
