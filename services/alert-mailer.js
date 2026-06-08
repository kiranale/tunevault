/**
 * services/alert-mailer.js — delta-aware autonomous monitoring alert emails.
 *
 * Owns: building and sending alert emails for new/worsened findings.
 * Does NOT own: finding_history persistence (db/schedules.js), schedule state,
 *               or health check execution.
 *
 * Alert fires only when at least one finding is `new` or `worsened` at or above
 * the user's severity_threshold. Idempotency is enforced by the caller (6h window).
 */

'use strict';

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';

// ── Snooze token ─────────────────────────────────────────────────────────────

function snoozeLink(scheduleId) {
  const token = Buffer.from(String(scheduleId)).toString('base64url');
  return `${APP_URL}/api/schedules/snooze?t=${token}`;
}

function settingsLink(connectionId) {
  return `${APP_URL}/dashboard?connection=${connectionId}&tab=monitoring`;
}

// ── Severity helpers ─────────────────────────────────────────────────────────

const SEV_COLOR = {
  red:   '#f87171',
  amber: '#f0a830',
  green: '#4ade80',
};

function sevChip(severity) {
  const color = SEV_COLOR[severity?.toLowerCase()] || '#8888a0';
  const label = severity?.toUpperCase() || 'UNKNOWN';
  return `<span style="background:${color};color:#0a0a0c;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:0.5px;display:inline-block;">${label}</span>`;
}

function deltaChip(deltaType) {
  if (deltaType === 'new') {
    return `<span style="background:#3b82f6;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px;">NEW</span>`;
  }
  if (deltaType === 'worsened') {
    return `<span style="background:#f87171;color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px;">WORSENED</span>`;
  }
  return '';
}

// ── Email subject ─────────────────────────────────────────────────────────────

/**
 * Build subject line.
 * If any new finding is RED → "[TuneVault] {name} — RED: {top_finding_title}"
 * Otherwise → "[TuneVault] {name} — {N} new finding(s), {M} worsened"
 */
function buildSubject(connectionName, deltas) {
  const newFindings      = deltas.filter(d => d.deltaType === 'new');
  const worsenedFindings = deltas.filter(d => d.deltaType === 'worsened');
  const newRedFinding    = newFindings.find(d => d.severity?.toLowerCase() === 'red');

  if (newRedFinding) {
    return `[TuneVault] ${connectionName} — RED: ${newRedFinding.title}`;
  }

  const parts = [];
  if (newFindings.length > 0) parts.push(`${newFindings.length} new finding${newFindings.length > 1 ? 's' : ''}`);
  if (worsenedFindings.length > 0) parts.push(`${worsenedFindings.length} worsened`);
  return `[TuneVault] ${connectionName} — ${parts.join(', ')}`;
}

// ── HTML email body ───────────────────────────────────────────────────────────

function buildHtml({ connectionName, connectionId, scheduleId, deltas, healthCheckId }) {
  const topDeltas = deltas.slice(0, 3);

  const findingRows = topDeltas.map(d => {
    const checkAnchor = healthCheckId
      ? `${APP_URL}/report/${healthCheckId}`
      : `${APP_URL}/connections`;

    return `
    <tr>
      <td style="padding:0 0 14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <tr>
            <td style="padding:14px 20px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td>${sevChip(d.severity)}${deltaChip(d.deltaType)}</td>
                  <td style="padding-left:10px;font-size:13px;font-weight:600;color:#e8e8ed;">${escHtml(d.title || d.checkId)}</td>
                </tr>
              </table>
            </td>
          </tr>
          ${d.metricLine ? `
          <tr>
            <td style="padding:0 20px 6px;font-size:13px;color:#8888a0;line-height:1.5;">${escHtml(d.metricLine)}</td>
          </tr>` : ''}
          ${d.remediation ? `
          <tr>
            <td style="padding:0 20px 0;">
              <div style="background:#0a0a0c;border-radius:6px;border:1px solid rgba(255,255,255,0.06);padding:10px 14px;margin-bottom:8px;">
                <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;white-space:pre-wrap;word-break:break-all;">${escHtml(d.remediation)}</code>
              </div>
            </td>
          </tr>` : ''}
          <tr>
            <td style="padding:4px 20px 14px;">
              <a href="${checkAnchor}" style="font-size:12px;color:#f0a830;text-decoration:none;">View in report →</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  const moreCount = deltas.length - topDeltas.length;
  const moreRow = moreCount > 0
    ? `<tr><td style="padding:0 0 16px;font-size:13px;color:#8888a0;">…and ${moreCount} more finding${moreCount > 1 ? 's' : ''} in the full report.</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TuneVault Alert — ${escHtml(connectionName)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0c;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#111114;border-radius:12px;border:1px solid rgba(240,168,48,0.18);">
        <tr>
          <td style="background:linear-gradient(135deg,#f87171 0%,#dc2626 100%);padding:4px;border-radius:12px 12px 0 0;"></td>
        </tr>
        <tr>
          <td style="padding:32px 40px 0;">
            <span style="font-size:22px;font-weight:700;color:#f0a830;letter-spacing:-0.5px;">TuneVault</span>
            <span style="font-size:13px;color:#8888a0;margin-left:8px;font-weight:400;">Autonomous Monitoring Alert</span>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0;">
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              ${deltas.length} new issue${deltas.length !== 1 ? 's' : ''} detected<br>
              <span style="color:#f0a830;">${escHtml(connectionName)}</span>
            </h1>
            <p style="margin:10px 0 0;font-size:14px;color:#8888a0;line-height:1.6;">
              Autonomous monitoring found the following issues since the last scan.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0;">
            <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${findingRows}
              ${moreRow}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 24px;">
            <a href="${healthCheckId ? `${APP_URL}/report/${healthCheckId}` : `${APP_URL}/connections`}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;">
              View full report →
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 36px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:20px 0 0;font-size:12px;color:#555568;line-height:1.7;">
              TuneVault · Oracle Database Health Intelligence<br>
              <a href="${snoozeLink(scheduleId)}" style="color:#555568;text-decoration:underline;">Snooze this connection for 24h</a>
              &nbsp;—&nbsp;
              <a href="${settingsLink(connectionId)}" style="color:#555568;text-decoration:underline;">Adjust schedule</a>
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildText({ connectionName, connectionId, scheduleId, deltas, healthCheckId }) {
  const topDeltas = deltas.slice(0, 3);
  const lines = [
    `TuneVault Autonomous Alert — ${connectionName}`,
    `${deltas.length} new/worsened finding(s) detected:`,
    '',
  ];
  for (const d of topDeltas) {
    lines.push(`[${(d.severity || '?').toUpperCase()}] [${d.deltaType.toUpperCase()}] ${d.title || d.checkId}`);
    if (d.metricLine) lines.push(`  ${d.metricLine}`);
    if (d.remediation) lines.push(`  Remediation: ${d.remediation}`);
    lines.push('');
  }
  if (deltas.length > 3) lines.push(`…and ${deltas.length - 3} more. See full report.`);
  lines.push(`Full report: ${healthCheckId ? `${APP_URL}/report/${healthCheckId}` : `${APP_URL}/connections`}`);
  lines.push('');
  lines.push(`Snooze 24h: ${snoozeLink(scheduleId)}`);
  lines.push(`Adjust schedule: ${settingsLink(connectionId)}`);
  return lines.join('\n');
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Send ─────────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[alert-mailer] RESEND_API_KEY not set — skipping alert to', to);
    return { sent: false, error: 'RESEND_API_KEY not configured' };
  }
  try {
    const res = await fetch(`${RESEND_API_URL}/emails`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body   : JSON.stringify({ from: FROM_ADDRESS, to, subject, text: body, html }),
    });
    if (res.ok) return { sent: true };
    const errText = await res.text().catch(() => '');
    console.warn(`[alert-mailer] send failed for ${to}: HTTP ${res.status}: ${errText}`);
    return { sent: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.warn(`[alert-mailer] send threw for ${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * sendAlert({ to, connectionName, connectionId, scheduleId, deltas, healthCheckId })
 *
 * deltas: array of { deltaType: 'new'|'worsened', checkId, findingKey, title,
 *                    metricLine, remediation, severity }
 *
 * Returns { sent: boolean, subject: string, error?: string }.
 * Never throws.
 */
async function sendAlert({ to, connectionName, connectionId, scheduleId, deltas, healthCheckId }) {
  if (!to || deltas.length === 0) return { sent: false, error: 'no recipient or no deltas' };

  const subject = buildSubject(connectionName, deltas);
  const html    = buildHtml({ connectionName, connectionId, scheduleId, deltas, healthCheckId });
  const body    = buildText({ connectionName, connectionId, scheduleId, deltas, healthCheckId });

  const result = await sendEmail({ to, subject, body, html });
  return { ...result, subject };
}

module.exports = { sendAlert };
