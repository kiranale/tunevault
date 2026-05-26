'use strict';

/**
 * TuneVault PDF Report Generator
 * Generates professional Oracle health check reports using PDFKit.
 * Designed to be a reusable function — call generateHealthCheckPDF(data) and pipe the result.
 */

const PDFDocument = require('pdfkit');

// Brand colors (light theme for printing)
const COLORS = {
  bg: '#FFFFFF',
  bgAlt: '#F8F9FC',
  text: '#1A1A2E',
  textDim: '#6B6B8A',
  textLight: '#FFFFFF',
  border: '#E2E4EE',
  accent: '#D4871A',       // TuneVault amber (slightly darker for print)
  accentLight: '#FDF3E3',
  headerBg: '#0A0A14',
  green: '#059669',
  greenBg: '#D1FAE5',
  yellow: '#B45309',
  yellowBg: '#FEF3C7',
  red: '#DC2626',
  redBg: '#FEE2E2',
  blue: '#2563EB',
  tableHeader: '#1E1E2E',
  tableHeaderText: '#FFFFFF',
  tableRowAlt: '#F4F5FA',
};

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 44;
const CONTENT_W = PAGE_WIDTH - MARGIN * 2;

/**
 * Generate a PDF for a completed health check.
 * @param {object} data  Health check object with metrics, scores, ai_analysis, etc.
 * @returns {PDFDocument}  A PDFKit document (pipe to response stream)
 */
function generateHealthCheckPDF(data) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: `TuneVault Health Report — ${data.connection_name}`,
      Author: 'TuneVault',
      Subject: 'Oracle Database Health Check',
      Creator: 'TuneVault',
      Producer: 'TuneVault',
    },
    compress: true,
  });

  const m = data.metrics || {};
  const s = data.scores || {};
  const instance = m.instance || {};

  // ── Page 1: Header + Executive Summary + Score Cards + AI Analysis ─────

  drawHeader(doc, data, instance);
  let y = drawSummarySection(doc, data, s);
  y = drawScoreCards(doc, y + 24, s);

  // AI Executive Summary block — rendered before the full AI analysis
  // so it's the first thing a CTO sees when opening the PDF.
  if (data.summary_text) {
    y = drawExecutiveSummary(doc, y + 20, data.summary_text, data.top_action);
  }

  // Structured recommendations with confidence badges + evidence (when available)
  if (data.ai_recommendations && data.ai_recommendations.length > 0) {
    y = drawStructuredRecommendations(doc, y + 16, data.ai_recommendations);
  }

  y = drawAIAnalysis(doc, y + 16, data.ai_analysis);

  // ── Page 2+: Detail sections ─────────────────────────────────────────────
  doc.addPage();
  y = MARGIN;

  y = drawSectionTitle(doc, y, 'Tablespace Usage');
  y = drawTablespaceTable(doc, y + 8, m.tablespaces || []);

  y = drawSectionTitle(doc, y + 20, 'Top Wait Events');
  y = drawWaitEventsTable(doc, y + 8, m.wait_events || []);

  y = drawSectionTitle(doc, y + 20, 'Top SQL by Elapsed Time');
  y = drawSQLSection(doc, y + 8, m.top_sql || []);

  // Start new page if not enough space for next sections
  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Index Analysis');
  y = drawIndexTable(doc, y + 8, m.index_analysis || []);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Memory — SGA / PGA');
  y = drawMemorySection(doc, y + 8, m.sga_stats || {}, m.pga_stats || {});

  if (y > PAGE_HEIGHT - 180) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'OS / Host Statistics');
  y = drawOSSection(doc, y + 8, m.os_stats || {});

  // ── Wave A / B sections ──────────────────────────────────────────────────

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Undo Tablespace');
  y = drawUndoSection(doc, y + 8, m.undo_stats || null);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Temp Tablespace');
  y = drawTempSection(doc, y + 8, m.temp_stats || null);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Alert Log');
  y = drawAlertLogSection(doc, y + 8, m.alert_log || null);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Resource Limits');
  y = drawResourceLimitsTable(doc, y + 8, m.resource_limits || null);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'SGA / PGA History');
  y = drawSgaPgaHistorySection(doc, y + 8, m.sga_pga_history || null);

  if (y > PAGE_HEIGHT - 200) {
    doc.addPage();
    y = MARGIN;
  }

  y = drawSectionTitle(doc, y + 20, 'Backup & Recovery');
  y = drawBackupSection(doc, y + 8, m.backup_stats || null);

  // EBS Operations section — only when ebs_operations data is present
  if (m.ebs_detected && m.ebs_operations) {
    doc.addPage();
    y = MARGIN;
    y = drawSectionTitle(doc, y + 20, 'EBS Operations');
    y = drawEbsOpsSection(doc, y + 8, m.ebs_operations);
  }

  drawFooter(doc, data);

  doc.end();
  return doc;
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

function drawHeader(doc, data, instance) {
  // Dark header bar
  doc.rect(0, 0, PAGE_WIDTH, 80).fill(COLORS.headerBg);

  // Logo badge
  doc
    .rect(MARGIN, 18, 36, 36)
    .fillAndStroke(COLORS.accent, COLORS.accent);
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(COLORS.headerBg)
    .text('TV', MARGIN, 28, { width: 36, align: 'center' });

  // TuneVault wordmark
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(COLORS.textLight)
    .text('TuneVault', MARGIN + 46, 22);

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(COLORS.accent)
    .text('Oracle Database Health Report', MARGIN + 46, 44);

  // Report date — top right
  const dateStr = new Date(data.created_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLORS.textDim)
    .text(dateStr, 0, 34, { width: PAGE_WIDTH - MARGIN, align: 'right' });

  // Sub-header: connection info
  const subY = 96;
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(COLORS.text)
    .text(data.connection_name || 'Health Check', MARGIN, subY);

  const metaParts = [];
  if (instance.db_name) metaParts.push(instance.db_name);
  if (instance.version) metaParts.push(`Oracle ${instance.version}`);
  if (instance.host_name) metaParts.push(instance.host_name);
  else if (data.host) metaParts.push(data.host);
  if (data.username) metaParts.push(`User: ${data.username}`);
  if (data.is_demo) metaParts.push('Demo Mode');

  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(COLORS.textDim)
    .text(metaParts.join('  ·  '), MARGIN, subY + 22);

  // Divider
  doc.moveTo(MARGIN, subY + 44).lineTo(PAGE_WIDTH - MARGIN, subY + 44)
    .strokeColor(COLORS.border).lineWidth(1).stroke();
}

function drawSummarySection(doc, data, s) {
  const y = 164;

  // Overall score circle (manual arc using SVG-like approach in PDFKit)
  const cx = PAGE_WIDTH - MARGIN - 55;
  const cy = y + 55;
  const r = 44;
  const score = data.overall_score || 0;
  const scoreColor = score >= 75 ? COLORS.green : score >= 50 ? COLORS.yellow : COLORS.red;

  // Background circle
  doc.circle(cx, cy, r).lineWidth(8).strokeColor(COLORS.border).stroke();

  // Foreground arc (approximated with PDFKit path)
  drawArc(doc, cx, cy, r, score, scoreColor);

  // Score number
  doc
    .font('Helvetica-Bold')
    .fontSize(28)
    .fillColor(scoreColor)
    .text(score.toString(), cx - 25, cy - 18, { width: 50, align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(COLORS.textDim)
    .text(scoreLabel(score), cx - 35, cy + 14, { width: 70, align: 'center' });

  // Left: quick stats grid
  const gridY = y + 4;
  const cols = [
    { label: 'Database', value: (data.metrics?.instance?.db_name) || '—' },
    { label: 'Oracle Version', value: (data.metrics?.instance?.version) || '—' },
    { label: 'Host', value: (data.metrics?.instance?.host_name) || '—' },
    { label: 'Uptime', value: data.metrics?.instance?.uptime_days != null ? data.metrics.instance.uptime_days + ' days' : '—' },
    { label: 'CPUs', value: data.metrics?.instance?.cpus || '—' },
    { label: 'SGA Target', value: data.metrics?.instance?.sga_target_gb != null ? data.metrics.instance.sga_target_gb + ' GB' : '—' },
  ];

  const colW = 150;
  const colGap = 10;
  cols.forEach((item, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const ix = MARGIN + col * (colW + colGap);
    const iy = gridY + row * 36;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim).text(item.label.toUpperCase(), ix, iy);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text).text(String(item.value).substring(0, 30), ix, iy + 12);
  });

  return y + 110;
}

function drawArc(doc, cx, cy, r, score, color) {
  // Draw arc by approximating with line segments
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + (score / 100) * 2 * Math.PI;
  const steps = Math.max(2, Math.floor(score * 0.6));

  doc.save();
  doc.lineWidth(8);
  doc.strokeColor(color);
  doc.lineCap('round');

  let started = false;
  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (i / steps) * (endAngle - startAngle);
    const x = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    if (!started) {
      doc.moveTo(x, y2);
      started = true;
    } else {
      doc.lineTo(x, y2);
    }
  }
  doc.stroke();
  doc.restore();
}

function drawScoreCards(doc, y, s) {
  const cards = [
    { label: 'Tablespace', value: s.tablespace || 0 },
    { label: 'Wait Events', value: s.wait_events || 0 },
    { label: 'SQL Perf', value: s.sql_performance || 0 },
    { label: 'Active Sessions', value: s.active_sessions || 0 },
    { label: 'Memory', value: s.memory || 0 },
  ];

  const cardW = (CONTENT_W - 16) / 5;
  const cardH = 60;

  cards.forEach((card, i) => {
    const x = MARGIN + i * (cardW + 4);
    const color = card.value >= 75 ? COLORS.green : card.value >= 50 ? COLORS.yellow : COLORS.red;
    const bgColor = card.value >= 75 ? COLORS.greenBg : card.value >= 50 ? COLORS.yellowBg : COLORS.redBg;

    // Card background
    doc.roundedRect(x, y, cardW, cardH, 6).fill(bgColor);
    doc.roundedRect(x, y, cardW, cardH, 6).lineWidth(1).stroke(COLORS.border);

    // Score
    doc.font('Helvetica-Bold').fontSize(22).fillColor(color)
      .text(card.value.toString(), x, y + 8, { width: cardW, align: 'center' });

    // Label
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.textDim)
      .text(card.label.toUpperCase(), x, y + 36, { width: cardW, align: 'center' });

    // Status label
    doc.font('Helvetica-Bold').fontSize(7).fillColor(color)
      .text(scoreLabel(card.value).toUpperCase(), x, y + 46, { width: cardW, align: 'center' });
  });

  return y + cardH;
}

// ── Executive Summary block ───────────────────────────────────────────────
// Renders a gold-accented card with the 3-sentence summary and top action.
// Shown before the detailed AI analysis so it's visible at the top of page 1.
function drawExecutiveSummary(doc, y, summaryText, topAction) {
  if (!summaryText) return y;

  // Check for page overflow
  const estimatedHeight = 90 + (topAction ? 40 : 0);
  if (y + estimatedHeight > PAGE_HEIGHT - MARGIN) {
    doc.addPage();
    y = MARGIN;
  }

  const boxH = estimatedHeight;

  // Outer card — light amber background + gold border
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 8).fillAndStroke(COLORS.accentLight, COLORS.accent);

  // Gold left accent stripe
  doc.rect(MARGIN, y, 4, boxH).fill(COLORS.accent);

  // Sparkle icon + label
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.accent)
    .text('✦  TUNEVAULT AI SUMMARY', MARGIN + 14, y + 12, { width: CONTENT_W - 20, align: 'left' });

  // Summary text
  const charsPerLine = Math.floor((CONTENT_W - 28) / (9.5 * 0.55));
  const lines = wrapText(summaryText, charsPerLine);
  const maxSummaryLines = 5;
  const displayLines = lines.slice(0, maxSummaryLines);

  doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text).lineGap(2);
  doc.text(displayLines.join('\n'), MARGIN + 14, y + 26, {
    width: CONTENT_W - 28,
    lineGap: 2,
  });

  const afterSummary = doc.y + 6;

  // Top action row
  if (topAction && afterSummary + 32 < y + boxH + 8) {
    const actionY = afterSummary;
    doc.rect(MARGIN + 14, actionY, CONTENT_W - 28, 1).fill(COLORS.accent);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.accent)
      .text('⚡ TOP ACTION NOW', MARGIN + 14, actionY + 5);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.text)
      .text(topAction.substring(0, 200), MARGIN + 14, actionY + 16, { width: CONTENT_W - 28 });
  }

  return y + boxH + 8;
}

// ── Structured Recommendations block ─────────────────────────────────────
// Renders each recommendation as a card: severity + confidence badge, title,
// evidence block, and optional fix SQL command.
// Called when ai_recommendations JSONB array is present on the health check.
function drawStructuredRecommendations(doc, y, recommendations) {
  if (!recommendations || recommendations.length === 0) return y;

  y = drawSectionTitle(doc, y, 'AI Recommendations — Confidence & Evidence');
  y += 10;

  const confLabel = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW — Verify First' };
  const confColor = { high: COLORS.green, medium: COLORS.yellow, low: '#D97706' };
  const sevColor  = { critical: COLORS.red, warning: COLORS.yellow, info: COLORS.blue };
  const sevLabel  = { critical: 'CRITICAL', warning: 'WARNING', info: 'INFO' };

  for (const rec of recommendations) {
    // Page overflow check — each card needs at least 80px
    if (y > PAGE_HEIGHT - MARGIN - 90) {
      doc.addPage();
      y = MARGIN;
    }

    const cColor = confColor[rec.confidence] || confColor.low;
    const sColor = sevColor[rec.severity]    || COLORS.text;

    // Card background
    const cardTopY = y;
    const evidenceLines = wrapText(rec.evidence || '', Math.floor(CONTENT_W / (9 * 0.55)));
    // Use fix_sql if present, else diagnostic_sql for the action block
    const actionSql = rec.fix_sql || rec.diagnostic_sql || null;
    const isFixSql = !!rec.fix_sql;
    const actionLines = actionSql
      ? wrapText(actionSql, Math.floor(CONTENT_W / (8.5 * 0.55))).slice(0, 10)
      : [];
    const cardH = 14 + 22 + (evidenceLines.slice(0, 5).length * 12) + (actionSql ? 14 + (actionLines.length * 12) + 14 : 0) + 12;

    doc.roundedRect(MARGIN, y, CONTENT_W, cardH, 6)
      .fillAndStroke(COLORS.bgAlt, COLORS.border);

    // Severity + Confidence badges — inline on first row
    const badgeY = y + 10;

    // Severity badge
    doc.roundedRect(MARGIN + 10, badgeY, 58, 14, 3).fill(sColor + '22');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(sColor)
      .text(sevLabel[rec.severity] || rec.severity.toUpperCase(), MARGIN + 13, badgeY + 3, { width: 52 });

    // Confidence badge
    const confBadgeX = MARGIN + 74;
    const confBadgeW = 90;
    doc.roundedRect(confBadgeX, badgeY, confBadgeW, 14, 3).fill(cColor + '22');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(cColor)
      .text(`${rec.confidence === 'high' ? '● ' : rec.confidence === 'medium' ? '◐ ' : '○ '}${confLabel[rec.confidence] || rec.confidence.toUpperCase()}`, confBadgeX + 4, badgeY + 3, { width: confBadgeW - 8 });

    // Title
    const titleY = badgeY + 20;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text(rec.title || 'Recommendation', MARGIN + 10, titleY, { width: CONTENT_W - 20 });

    let contentY = doc.y + 6;

    // Evidence block
    if (rec.evidence) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.textDim)
        .text('EVIDENCE', MARGIN + 10, contentY);
      contentY = doc.y + 3;

      const dispEvidLines = evidenceLines.slice(0, 5);
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.textDim).lineGap(1)
        .text(dispEvidLines.join('\n'), MARGIN + 10, contentY, { width: CONTENT_W - 20 });
      contentY = doc.y + 6;
    }

    // Action SQL block (fix or diagnostic)
    if (actionSql && actionLines.length > 0) {
      const actionLabel = isFixSql ? '⚡ EXACT REMEDIATION SQL' : '🔍 DIAGNOSTIC SQL — RUN THIS NEXT';
      const sqlColor = isFixSql ? '#86efac' : '#93c5fd';
      doc.font('Helvetica-Bold').fontSize(8).fillColor(isFixSql ? COLORS.accent : '#63b3ed')
        .text(actionLabel, MARGIN + 10, contentY);
      contentY = doc.y + 3;

      doc.roundedRect(MARGIN + 10, contentY, CONTENT_W - 20, actionLines.length * 12 + 8, 4)
        .fill('#0A0A14');
      doc.font('Helvetica').fontSize(8).fillColor(sqlColor).lineGap(1)
        .text(actionLines.join('\n'), MARGIN + 14, contentY + 4, { width: CONTENT_W - 28 });
      contentY = doc.y + 8;
    }

    y = cardTopY + cardH + 8;
  }

  return y;
}

function drawAIAnalysis(doc, y, aiAnalysis) {
  if (!aiAnalysis) return y;

  // Section title
  y = drawSectionTitle(doc, y, 'AI Analysis & Recommendations');
  y += 8;

  // Strip markdown to plain text
  const plainText = stripMarkdown(aiAnalysis);

  // Render text, checking for page overflow
  const available = PAGE_HEIGHT - MARGIN - y;
  const fontSize = 10;
  const lineHeight = 14;

  // Estimate lines that fit
  const charsPerLine = Math.floor(CONTENT_W / (fontSize * 0.55));
  const lines = wrapText(plainText, charsPerLine);
  const maxLines = Math.floor(available / lineHeight) - 2;
  const displayLines = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;

  doc.font('Helvetica').fontSize(fontSize).fillColor(COLORS.text).lineGap(4);
  doc.text(displayLines.join('\n'), MARGIN, y, {
    width: CONTENT_W,
    lineGap: 2,
    paragraphGap: 4,
  });

  if (truncated) {
    const truncY = doc.y + 4;
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim)
      .text('(continued on detailed report pages...)', MARGIN, truncY);
  }

  return doc.y + 8;
}

function drawSectionTitle(doc, y, title) {
  // Ensure we won't overflow — add new page if close to bottom
  if (y > PAGE_HEIGHT - 80) {
    doc.addPage();
    y = MARGIN;
  }

  doc.rect(MARGIN, y, CONTENT_W, 28).fill(COLORS.tableHeader);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.textLight)
    .text(title, MARGIN + 12, y + 8);

  return y + 28;
}

function drawTablespaceTable(doc, y, tablespaces) {
  if (!tablespaces.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No tablespace data collected.', MARGIN, y);
    return y + 20;
  }

  const cols = [
    { header: 'Tablespace', width: 140 },
    { header: 'Used (GB)', width: 70 },
    { header: 'Total (GB)', width: 75 },
    { header: 'Usage %', width: 70 },
    { header: 'Autoextend', width: 80 },
    { header: 'Status', width: 72 },
  ];

  y = drawTableHeader(doc, y, cols);

  tablespaces.forEach((t, i) => {
    const cls = t.pct_used > 90 ? 'crit' : t.pct_used > 80 ? 'warn' : 'ok';
    const color = cls === 'crit' ? COLORS.red : cls === 'warn' ? COLORS.yellow : COLORS.green;
    const bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

    if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

    y = drawTableRow(doc, y, bg, cols, [
      t.name,
      t.used_gb.toString(),
      t.total_gb.toString(),
      { text: t.pct_used + '%', color },
      { text: t.autoextend ? 'ON' : 'OFF', color: t.autoextend ? COLORS.green : COLORS.red },
      { text: cls === 'crit' ? 'CRITICAL' : cls === 'warn' ? 'WARNING' : 'OK', color },
    ]);
  });

  return y;
}

function drawWaitEventsTable(doc, y, waitEvents) {
  const filtered = (waitEvents || []).filter(w => w.pct_db_time > 0);
  if (!filtered.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No wait event data collected.', MARGIN, y);
    return y + 20;
  }

  const cols = [
    { header: 'Event', width: 175 },
    { header: 'Wait Class', width: 90 },
    { header: '% DB Time', width: 70 },
    { header: 'Total Waits', width: 80 },
    { header: 'Avg Wait (ms)', width: 92 },
  ];

  y = drawTableHeader(doc, y, cols);

  filtered.slice(0, 12).forEach((w, i) => {
    const cls = w.pct_db_time > 10 ? 'crit' : w.pct_db_time > 5 ? 'warn' : 'ok';
    const color = cls === 'crit' ? COLORS.red : cls === 'warn' ? COLORS.yellow : COLORS.text;
    const bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

    if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

    y = drawTableRow(doc, y, bg, cols, [
      w.event,
      w.wait_class,
      { text: w.pct_db_time + '%', color },
      formatNum(w.total_waits),
      w.avg_wait_ms.toString(),
    ]);
  });

  return y;
}

function drawSQLSection(doc, y, topSQL) {
  if (!topSQL.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No SQL data collected.', MARGIN, y);
    return y + 20;
  }

  topSQL.slice(0, 5).forEach((sq, i) => {
    if (y > PAGE_HEIGHT - 100) { doc.addPage(); y = MARGIN; }

    const cls = sq.elapsed_per_exec_ms > 5 ? 'crit' : sq.elapsed_per_exec_ms > 1 ? 'warn' : 'ok';
    const color = cls === 'crit' ? COLORS.red : cls === 'warn' ? COLORS.yellow : COLORS.green;

    // SQL header row
    doc.rect(MARGIN, y, CONTENT_W, 22).fill(cls === 'crit' ? COLORS.redBg : cls === 'warn' ? COLORS.yellowBg : COLORS.greenBg);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(color)
      .text(sq.sql_id, MARGIN + 8, y + 6);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim)
      .text(`${sq.elapsed_per_exec_ms}ms/exec · ${formatNum(sq.executions)} execs · ${sq.buffer_gets_per_exec} gets/exec`, MARGIN + 80, y + 7);
    y += 22;

    // SQL text box
    const sqlText = (sq.sql_text || '').substring(0, 300);
    doc.rect(MARGIN, y, CONTENT_W, 1).fill(COLORS.border);
    doc.rect(MARGIN, y + 1, CONTENT_W, 32).fill('#F0F2FA');
    doc.font('Courier').fontSize(8).fillColor(COLORS.textDim)
      .text(sqlText, MARGIN + 8, y + 6, { width: CONTENT_W - 16, height: 26, ellipsis: true });
    y += 33;

    // Issue
    if (sq.issue) {
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.red).text('⚠ ' + sq.issue, MARGIN + 8, y + 2);
      y += 14;
    }

    // Divider
    doc.rect(MARGIN, y + 4, CONTENT_W, 1).fill(COLORS.border);
    y += 12;
  });

  return y;
}

function drawIndexTable(doc, y, indexAnalysis) {
  if (!indexAnalysis.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No index data collected.', MARGIN, y);
    return y + 20;
  }

  const cols = [
    { header: 'Index', width: 150 },
    { header: 'Table', width: 110 },
    { header: 'Size', width: 60 },
    { header: 'B-Level', width: 55 },
    { header: 'Deleted %', width: 70 },
    { header: 'Status', width: 62 },
  ];

  y = drawTableHeader(doc, y, cols);

  indexAnalysis.forEach((idx, i) => {
    const cls = idx.pct_deleted > 50 ? 'crit' : idx.pct_deleted > 30 ? 'warn' : 'ok';
    const color = cls === 'crit' ? COLORS.red : cls === 'warn' ? COLORS.yellow : COLORS.green;
    const bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

    if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

    y = drawTableRow(doc, y, bg, cols, [
      idx.index_name,
      idx.table_name,
      formatSize(idx.size_mb),
      idx.blevel.toString(),
      { text: idx.pct_deleted + '%', color },
      { text: cls === 'crit' ? 'CRITICAL' : cls === 'warn' ? 'FRAGMENTED' : 'OK', color },
    ]);
  });

  return y;
}

function drawMemorySection(doc, y, sga, pga) {
  const items = [
    ['Buffer Cache Hit Ratio', (sga.buffer_cache_hit_ratio || 0) + '%'],
    ['Library Cache Hit Ratio', (sga.library_cache_hit_ratio || 0) + '%'],
    ['Shared Pool Free', (sga.shared_pool_free_pct || 0) + '%'],
    ['Hard Parses/sec', String(sga.hard_parses_per_sec || 0)],
    ['PGA Allocated', (pga.pga_allocated_gb || 0) + ' GB'],
    ['PGA Target', (pga.pga_target_gb || 0) + ' GB'],
    ['PGA Optimal', (pga.optimal_executions_pct || 0) + '%'],
    ['PGA One-pass', (pga.onepass_executions_pct || 0) + '%'],
    ['PGA Multi-pass', (pga.multipass_executions_pct || 0) + '%'],
  ];

  return drawKeyValueGrid(doc, y, items, 3);
}

function drawOSSection(doc, y, os) {
  const items = [
    ['CPU Count', String(os.cpu_count || '—')],
    ['Avg CPU Utilization', (os.avg_cpu_utilization_pct || 0) + '%'],
    ['Max CPU Utilization', (os.max_cpu_utilization_pct || 0) + '%'],
    ['I/O Wait', (os.avg_io_wait_pct || 0) + '%'],
    ['Physical RAM', (os.physical_memory_gb || 0) + ' GB'],
    ['Free Memory', (os.free_memory_gb || 0) + ' GB'],
    ['Avg Disk Read', (os.avg_disk_read_ms || 0) + 'ms'],
    ['Avg Disk Write', (os.avg_disk_write_ms || 0) + 'ms'],
  ];

  return drawKeyValueGrid(doc, y, items, 4);
}

function drawKeyValueGrid(doc, y, items, cols) {
  const itemW = CONTENT_W / cols;
  const rowH = 38;

  items.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ix = MARGIN + col * itemW;
    const iy = y + row * rowH;

    if (col === 0 && row > 0) {
      // Check page overflow at start of each new row
      if (iy > PAGE_HEIGHT - 60) {
        // This is best-effort; we accept minor overflow for simplicity
      }
    }

    doc.rect(ix + 2, iy + 2, itemW - 4, rowH - 4).lineWidth(1)
      .fillAndStroke(COLORS.bgAlt, COLORS.border);
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.textDim)
      .text(item[0].toUpperCase(), ix + 10, iy + 8, { width: itemW - 20 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.text)
      .text(item[1], ix + 10, iy + 18, { width: itemW - 20 });
  });

  const rows = Math.ceil(items.length / cols);
  return y + rows * rowH + 4;
}

function drawTableHeader(doc, y, cols) {
  let x = MARGIN;
  const rowH = 22;

  doc.rect(MARGIN, y, CONTENT_W, rowH).fill(COLORS.tableHeader);

  cols.forEach(col => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.textLight)
      .text(col.header.toUpperCase(), x + 6, y + 6, { width: col.width - 8 });
    x += col.width;
  });

  return y + rowH;
}

function drawTableRow(doc, y, bg, cols, values) {
  const rowH = 20;
  doc.rect(MARGIN, y, CONTENT_W, rowH).fill(bg);

  let x = MARGIN;
  cols.forEach((col, i) => {
    const val = values[i];
    const text = typeof val === 'object' ? val.text : val;
    const color = typeof val === 'object' ? val.color : COLORS.text;
    const displayText = String(text || '—').substring(0, 40);

    doc.font('Helvetica').fontSize(9).fillColor(color)
      .text(displayText, x + 6, y + 5, { width: col.width - 10, lineBreak: false });
    x += col.width;
  });

  // Bottom border
  doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH)
    .strokeColor(COLORS.border).lineWidth(0.5).stroke();

  return y + rowH;
}

function drawFooter(doc, data) {
  const range = doc.bufferedPageRange();

  // Build identity string for footer
  const connName = (data && data.connection_name) ? data.connection_name : 'TuneVault';
  const userStr = (data && data.username) ? ` (${data.username})` : '';
  const hostStr = (data && data.host) ? ` @ ${data.host}` : '';
  const genTime = new Date((data && data.created_at) || Date.now()).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const footerY = PAGE_HEIGHT - 34;
    doc.moveTo(MARGIN, footerY).lineTo(PAGE_WIDTH - MARGIN, footerY)
      .strokeColor(COLORS.border).lineWidth(0.5).stroke();

    // Left: connection identity
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.textDim)
      .text(`${connName}${userStr}${hostStr}`, MARGIN, footerY + 5, { width: PAGE_WIDTH * 0.6 });

    // Right: generation timestamp + page
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.textDim)
      .text(`Generated ${genTime}  ·  Page ${i - range.start + 1} of ${range.count}`,
        0, footerY + 5, { width: PAGE_WIDTH - MARGIN, align: 'right' });
  }
}

// ── Wave A / B Detail Sections ───────────────────────────────────────────────

function drawUndoSection(doc, y, undoStats) {
  if (!undoStats) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No undo tablespace data collected.', MARGIN, y);
    return y + 20;
  }

  const cur = undoStats.current || {};
  const hist = undoStats.historical || {};

  const items = [
    ['Tablespace Name', cur.tablespace_name || '—'],
    ['Total Size', cur.total_gb != null ? cur.total_gb + ' GB' : '—'],
    ['Used', cur.used_gb != null ? cur.used_gb + ' GB' : '—'],
    ['Usage %', cur.pct_used != null ? cur.pct_used + '%' : '—'],
    ['Tuned Retention', cur.tuned_undo_retention_s != null ? cur.tuned_undo_retention_s + 's' : '—'],
    ['Max Query Length', cur.max_query_length_s != null ? cur.max_query_length_s + 's' : '—'],
    ['Retention Mode', cur.retention_mode || '—'],
    ['Peak Usage %', hist.peak_pct_used != null ? hist.peak_pct_used + '%' : '—'],
    ['Peak Time', hist.peak_time || '—'],
  ];

  return drawKeyValueGrid(doc, y, items, 3);
}

function drawTempSection(doc, y, tempStats) {
  if (!tempStats) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No temp tablespace data collected.', MARGIN, y);
    return y + 20;
  }

  const cur = tempStats.current || {};
  const hist = tempStats.historical || {};

  const items = [
    ['Tablespace Name', cur.tablespace_name || '—'],
    ['Total Size', cur.total_gb != null ? cur.total_gb + ' GB' : '—'],
    ['Used', cur.used_gb != null ? cur.used_gb + ' GB' : '—'],
    ['Usage %', cur.pct_used != null ? cur.pct_used + '%' : '—'],
    ['Peak GB', hist.peak_gb != null ? hist.peak_gb + ' GB' : '—'],
    ['Peak %', hist.peak_pct != null ? hist.peak_pct + '%' : '—'],
    ['Peak Time', hist.peak_time || '—'],
  ];

  y = drawKeyValueGrid(doc, y, items, 4);

  // Top sessions sub-table
  const sessions = cur.top_sessions || [];
  if (sessions.length > 0) {
    if (y > PAGE_HEIGHT - 120) { doc.addPage(); y = MARGIN; }

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text('Top Temp-Consuming Sessions', MARGIN, y + 4);
    y += 20;

    const cols = [
      { header: 'SID', width: 60 },
      { header: 'Username', width: 110 },
      { header: 'Program', width: 160 },
      { header: 'Temp (MB)', width: 80 },
      { header: 'SQL ID', width: 97 },
    ];

    y = drawTableHeader(doc, y, cols);

    sessions.slice(0, 10).forEach(function (sess, i) {
      var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;
      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }
      y = drawTableRow(doc, y, bg, cols, [
        String(sess.sid || '—'),
        sess.username || '—',
        sess.program || '—',
        String(sess.temp_mb || 0),
        sess.sql_id || '—',
      ]);
    });
  }

  return y;
}

function drawAlertLogSection(doc, y, alertLog) {
  if (!alertLog) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No alert log data collected.', MARGIN, y);
    return y + 20;
  }

  var summary = alertLog.summary || {};

  // Summary grid
  var items = [
    ['Total Entries', String(summary.total || 0)],
    ['Critical', String(summary.critical || 0)],
    ['Warning', String(summary.warning || 0)],
    ['Info', String(summary.info || 0)],
    ['Noise', String(summary.noise || 0)],
  ];

  y = drawKeyValueGrid(doc, y, items, 5);

  // Recent entries table
  var entries = alertLog.entries || [];
  if (entries.length > 0) {
    if (y > PAGE_HEIGHT - 120) { doc.addPage(); y = MARGIN; }

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text('Recent Alert Log Entries', MARGIN, y + 4);
    y += 20;

    var cols = [
      { header: 'Timestamp', width: 130 },
      { header: 'Severity', width: 80 },
      { header: 'Message', width: 297 },
    ];

    y = drawTableHeader(doc, y, cols);

    entries.slice(0, 20).forEach(function (entry, i) {
      var sevColor = entry.severity === 'CRITICAL' ? COLORS.red
        : entry.severity === 'WARNING' ? COLORS.yellow
        : COLORS.text;
      var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

      y = drawTableRow(doc, y, bg, cols, [
        entry.ts || '—',
        { text: entry.severity || '—', color: sevColor },
        (entry.message || '—').substring(0, 80),
      ]);
    });
  }

  return y;
}

function drawResourceLimitsTable(doc, y, resourceLimits) {
  var items = (resourceLimits && resourceLimits.current) || [];
  if (!items.length) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No resource limits data collected.', MARGIN, y);
    return y + 20;
  }

  var cols = [
    { header: 'Resource', width: 140 },
    { header: 'Current', width: 75 },
    { header: 'Max Used', width: 75 },
    { header: 'Limit', width: 80 },
    { header: '% Max Used', width: 75 },
    { header: 'Status', width: 62 },
  ];

  y = drawTableHeader(doc, y, cols);

  items.forEach(function (item, i) {
    var pct = item.pct_max_used || 0;
    var statusColor = item.status === 'CRITICAL' ? COLORS.red
      : item.status === 'WARNING' ? COLORS.yellow
      : COLORS.green;
    var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

    if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

    y = drawTableRow(doc, y, bg, cols, [
      item.resource || '—',
      String(item.current_utilization != null ? item.current_utilization : '—'),
      String(item.max_utilization != null ? item.max_utilization : '—'),
      item.limit_display || String(item.limit_value || '—'),
      { text: pct + '%', color: pct > 90 ? COLORS.red : pct > 75 ? COLORS.yellow : COLORS.text },
      { text: item.status || 'OK', color: statusColor },
    ]);
  });

  return y;
}

function drawSgaPgaHistorySection(doc, y, sgaPgaHistory) {
  if (!sgaPgaHistory) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No SGA/PGA history data collected.', MARGIN, y);
    return y + 20;
  }

  var cur = sgaPgaHistory.current || {};
  var pgaHist = sgaPgaHistory.pga_history || {};

  var items = [
    ['SGA Target', cur.sga_target_gb != null ? cur.sga_target_gb + ' GB' : '—'],
    ['PGA Target', cur.pga_target_gb != null ? cur.pga_target_gb + ' GB' : '—'],
    ['PGA Peak Allocated', pgaHist.peak_allocated_gb != null ? pgaHist.peak_allocated_gb + ' GB' : '—'],
    ['PGA Peak Time', pgaHist.peak_time || '—'],
  ];

  y = drawKeyValueGrid(doc, y, items, 4);

  // Resize operations table
  var resizeOps = sgaPgaHistory.resize_ops || [];
  if (resizeOps.length > 0) {
    if (y > PAGE_HEIGHT - 120) { doc.addPage(); y = MARGIN; }

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text('Recent Resize Operations', MARGIN, y + 4);
    y += 20;

    var cols = [
      { header: 'Component', width: 175 },
      { header: 'Operation', width: 100 },
      { header: 'From (GB)', width: 80 },
      { header: 'To (GB)', width: 80 },
      { header: 'Change', width: 72 },
    ];

    y = drawTableHeader(doc, y, cols);

    resizeOps.slice(0, 15).forEach(function (op, i) {
      var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;
      var changeGb = (op.to_gb != null && op.from_gb != null) ? (op.to_gb - op.from_gb).toFixed(2) : '—';
      var changeColor = parseFloat(changeGb) > 0 ? COLORS.green : parseFloat(changeGb) < 0 ? COLORS.red : COLORS.text;

      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

      y = drawTableRow(doc, y, bg, cols, [
        op.component || '—',
        op.oper_type || '—',
        op.from_gb != null ? String(op.from_gb) : '—',
        op.to_gb != null ? String(op.to_gb) : '—',
        { text: changeGb !== '—' ? (parseFloat(changeGb) > 0 ? '+' : '') + changeGb : '—', color: changeColor },
      ]);
    });
  }

  return y;
}

function drawBackupSection(doc, y, backupStats) {
  if (!backupStats) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('No backup & recovery data collected.', MARGIN, y);
    return y + 20;
  }

  var rman = backupStats.rman_backup || {};
  var fra = backupStats.fra_usage || {};
  var archLog = backupStats.archivelog_rate || {};
  var validation = backupStats.backup_validation || {};

  // Overall status badge
  var overallStatus = backupStats.overall_status || 'UNKNOWN';
  var overallColor = overallStatus === 'OK' ? COLORS.green
    : overallStatus === 'WARNING' ? COLORS.yellow : COLORS.red;

  doc.font('Helvetica-Bold').fontSize(10).fillColor(overallColor)
    .text('Overall Backup Status: ' + overallStatus, MARGIN, y + 2);
  y += 18;

  // RMAN summary grid
  var items = [
    ['RMAN Available', rman.rman_available ? 'Yes' : 'No'],
    ['RMAN Status', rman.status || '—'],
    ['Last Full Backup', rman.last_full_backup || '—'],
    ['Hours Since Full', rman.full_backup_hours_ago != null ? String(rman.full_backup_hours_ago) : '—'],
    ['FRA Configured', fra.fra_configured ? 'Yes' : 'No'],
    ['FRA Used', fra.pct_used != null ? fra.pct_used + '%' : '—'],
    ['FRA Used GB', fra.used_gb != null ? fra.used_gb + ' GB' : '—'],
    ['FRA Limit GB', fra.limit_gb != null ? fra.limit_gb + ' GB' : '—'],
    ['Hours Until Full', fra.hours_until_full != null ? String(fra.hours_until_full) : '—'],
    ['Log Mode', archLog.log_mode || '—'],
    ['Switches/Hour', archLog.switches_per_hour != null ? String(archLog.switches_per_hour) : '—'],
    ['Switches (24h)', archLog.switches_24h != null ? String(archLog.switches_24h) : '—'],
    ['Total Corruptions', String(validation.total_corruptions || 0)],
    ['Backup Corruptions', String(validation.backup_corruptions || 0)],
    ['Last 3 Backups Failed', String(validation.last_3_backups_failed || 0)],
  ];

  y = drawKeyValueGrid(doc, y, items, 3);

  // RMAN recent jobs table
  var recentJobs = rman.recent_jobs || [];
  if (recentJobs.length > 0) {
    if (y > PAGE_HEIGHT - 120) { doc.addPage(); y = MARGIN; }

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text('Recent RMAN Jobs', MARGIN, y + 4);
    y += 20;

    var cols = [
      { header: 'Type', width: 120 },
      { header: 'Status', width: 100 },
      { header: 'Start Time', width: 140 },
      { header: 'Duration', width: 80 },
      { header: 'Size', width: 67 },
    ];

    y = drawTableHeader(doc, y, cols);

    recentJobs.slice(0, 10).forEach(function (job, i) {
      var jobColor = job.status === 'COMPLETED' ? COLORS.green
        : job.status === 'FAILED' ? COLORS.red
        : COLORS.yellow;
      var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, cols); }

      y = drawTableRow(doc, y, bg, cols, [
        job.type || job.input_type || '—',
        { text: job.status || '—', color: jobColor },
        job.start_time || '—',
        job.duration || '—',
        job.output_size || '—',
      ]);
    });
  }

  // Last by type sub-table
  var lastByType = rman.last_by_type || [];
  if (lastByType.length > 0) {
    if (y > PAGE_HEIGHT - 120) { doc.addPage(); y = MARGIN; }

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text('Last Backup by Type', MARGIN, y + 4);
    y += 20;

    var typeCols = [
      { header: 'Backup Type', width: 160 },
      { header: 'Status', width: 100 },
      { header: 'Completed', width: 160 },
      { header: 'Hours Ago', width: 87 },
    ];

    y = drawTableHeader(doc, y, typeCols);

    lastByType.forEach(function (bt, i) {
      var btColor = bt.status === 'COMPLETED' ? COLORS.green
        : bt.status === 'FAILED' ? COLORS.red
        : COLORS.yellow;
      var bg = i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt;

      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, typeCols); }

      y = drawTableRow(doc, y, bg, typeCols, [
        bt.type || bt.input_type || '—',
        { text: bt.status || '—', color: btColor },
        bt.completed || bt.completion_time || '—',
        bt.hours_ago != null ? String(bt.hours_ago) : '—',
      ]);
    });
  }

  return y;
}


function drawEbsOpsSection(doc, y, ebsOps) {
  if (!ebsOps) {
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.textDim).text('EBS Operations data not collected for this run.', MARGIN, y);
    return y + 20;
  }

  var cm = ebsOps.concurrent_managers || {};
  var wf = ebsOps.workflow || {};
  var sec = ebsOps.security || {};
  var fb = ebsOps.functional || {};

  // Key metrics grid
  var kvItems = [];
  if (cm.cm01) kvItems.push(['Internal Manager', cm.cm01.running_processes + '/' + cm.cm01.max_processes + ' proc']);
  if (cm.cm02) kvItems.push(['CM Pending Requests', String(cm.cm02.pending_requests)]);
  if (cm.cm10) kvItems.push(['CM Errors (24h)', String(cm.cm10.error_requests_24h)]);
  if (wf.wf02) kvItems.push(['WF Errors', String(wf.wf02.error_count)]);
  if (wf.wf03) kvItems.push(['WF Deferred Queue', String(wf.wf03.deferred_ready)]);
  if (wf.wf08) kvItems.push(['Notif Backlog >2h', String(wf.wf08.pending_over_2h)]);
  if (sec.sc12) kvItems.push(['Sign-on Audit Level', sec.sc12.signon_audit_level || 'NONE']);
  if (sec.sc14) kvItems.push(['SysAdmin Users', String(sec.sc14.length)]);
  if (fb.fb04) kvItems.push(['Active EBS Users (24h)', String(fb.fb04.active_users_24h)]);

  y = drawKeyValueGrid(doc, y, kvItems, 3);

  // Manager Load table
  if (cm.cm06 && cm.cm06.length > 0) {
    if (y > PAGE_HEIGHT - 150) { doc.addPage(); y = MARGIN; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('Concurrent Manager Load', MARGIN, y + 10);
    y += 28;
    var mgCols = [
      { header: 'Manager', width: 200 },
      { header: 'Running', width: 70 },
      { header: 'Target', width: 70 },
      { header: 'Max', width: 70 },
      { header: 'Status', width: 97 },
    ];
    y = drawTableHeader(doc, y, mgCols);
    cm.cm06.forEach(function(mgr, i) {
      var cls = mgr.running_processes === 0 ? COLORS.red : mgr.running_processes < mgr.target_processes ? COLORS.yellow : COLORS.green;
      var label = mgr.running_processes === 0 ? 'DOWN' : mgr.running_processes < mgr.target_processes ? 'Under' : 'OK';
      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, mgCols); }
      y = drawTableRow(doc, y, i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt, mgCols, [
        mgr.name || '—',
        String(mgr.running_processes),
        String(mgr.target_processes),
        String(mgr.max_processes),
        { text: label, color: cls },
      ]);
    });
  }

  // Top long requests
  if (cm.cm09 && cm.cm09.length > 0) {
    if (y > PAGE_HEIGHT - 150) { doc.addPage(); y = MARGIN; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('Top Long-Running Requests (7d)', MARGIN, y + 10);
    y += 28;
    var reqCols = [
      { header: 'Program', width: 260 },
      { header: 'Started', width: 120 },
      { header: 'Runtime', width: 127 },
    ];
    y = drawTableHeader(doc, y, reqCols);
    cm.cm09.forEach(function(req, i) {
      var mins = Math.round((req.runtime_secs || 0) / 60);
      var cls = req.runtime_secs > 7200 ? COLORS.red : req.runtime_secs > 1800 ? COLORS.yellow : COLORS.text;
      if (y > PAGE_HEIGHT - 80) { doc.addPage(); y = MARGIN; y = drawTableHeader(doc, y, reqCols); }
      y = drawTableRow(doc, y, i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt, reqCols, [
        (req.program || '—').substring(0, 55),
        req.start_time || '—',
        { text: mins + ' min', color: cls },
      ]);
    });
  }

  return y + 10;
}

// ── Utility functions ────────────────────────────────────────────────────────

function scoreLabel(v) {
  if (v >= 75) return 'Healthy';
  if (v >= 50) return 'Needs Attention';
  return 'Critical';
}

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatSize(mb) {
  if (!mb) return '0 MB';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb + ' MB';
}

function stripMarkdown(md) {
  if (!md) return '';
  return md
    .replace(/```[\s\S]*?```/g, '[code block omitted]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '  ')
    .trim();
}

function wrapText(text, maxChars) {
  const paragraphs = text.split('\n');
  const result = [];
  for (const para of paragraphs) {
    if (para.trim() === '') {
      result.push('');
      continue;
    }
    if (para.length <= maxChars) {
      result.push(para);
    } else {
      // Word-wrap
      const words = para.split(' ');
      let line = '';
      for (const word of words) {
        if ((line + ' ' + word).trim().length > maxChars) {
          if (line) result.push(line);
          line = word;
        } else {
          line = line ? line + ' ' + word : word;
        }
      }
      if (line) result.push(line);
    }
  }
  return result;
}

module.exports = { generateHealthCheckPDF };
