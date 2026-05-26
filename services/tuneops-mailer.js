/**
 * services/tuneops-mailer.js — TuneOps ticket lifecycle email notifications.
 *
 * Owns: building and sending all 10 TuneOps notification types, dedup/rate-limit
 *       enforcement, and contact registration.
 * Does NOT own: ticket data persistence, user preference storage (db/tuneops-notifications.js),
 *               role/approval logic, or deciding WHO should receive a notification.
 *
 * Callers pass the recipient list + event context. This module handles rendering
 * and sending only.
 *
 * Rate limits:
 *   - Max 10 emails per ticket per hour (prevents notification storms).
 *   - Same event + same recipient within 1 hour → skip (dedup window configurable).
 *
 * All sends are fire-and-forget safe: errors are logged but never thrown.
 */

'use strict';

const db = require('../db/tuneops-notifications');

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const EMAIL_API_URL  = 'https://polsia.com/api/proxy/email';

const RATE_LIMIT_PER_TICKET_PER_HOUR = 10;

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_META = {
  critical: { emoji: '🔴', label: 'CRITICAL', headerBg: 'linear-gradient(135deg,#f87171 0%,#dc2626 100%)', chip: '#dc2626' },
  warning:  { emoji: '⚠️',  label: 'WARNING',  headerBg: 'linear-gradient(135deg,#f0a830 0%,#d97706 100%)', chip: '#d97706' },
  info:     { emoji: '🔵', label: 'INFO',     headerBg: 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)', chip: '#3b82f6' },
};

function sevMeta(severity) {
  return SEV_META[severity?.toLowerCase()] || SEV_META.info;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ticketUrl(ticketNumber) {
  return `${APP_URL}/tuneops/${ticketNumber}`;
}

// ── Shared email shell ────────────────────────────────────────────────────────

/**
 * Wraps any inner HTML in the branded TuneVault dark-theme email shell.
 * headerBg: CSS gradient string (severity-specific color).
 */
function emailShell({ title, headerBg, innerHtml, ticketNumber, footerNote = '' }) {
  const viewLink = ticketNumber ? ticketUrl(ticketNumber) : `${APP_URL}/tuneops`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0c;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="580" style="max-width:580px;width:100%;background:#111114;border-radius:12px;border:1px solid rgba(240,168,48,0.18);">

        <!-- Severity colour bar -->
        <tr>
          <td style="background:${headerBg};height:4px;border-radius:12px 12px 0 0;"></td>
        </tr>

        <!-- Logo -->
        <tr>
          <td style="padding:28px 40px 0;">
            <span style="font-size:20px;font-weight:700;color:#f0a830;letter-spacing:-0.5px;">TuneVault</span>
            <span style="font-size:12px;color:#8888a0;margin-left:8px;">TuneOps</span>
          </td>
        </tr>

        <!-- Inner content -->
        ${innerHtml}

        <!-- CTA -->
        <tr>
          <td style="padding:24px 40px;">
            <a href="${escHtml(viewLink)}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:13px;font-weight:700;text-decoration:none;padding:11px 24px;border-radius:7px;letter-spacing:0.2px;">
              View Ticket →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:0 40px 32px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:20px 0 0;font-size:12px;color:#555568;line-height:1.7;">
              TuneVault · Oracle Operational Intelligence<br>
              <a href="mailto:support@tunevault.app" style="color:#555568;">support@tunevault.app</a>
              ${footerNote ? `<br>${footerNote}` : ''}
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

// ── Ticket header block (reused in every email) ───────────────────────────────

function ticketHeader({ ticketNumber, severity, title, connectionName }) {
  const meta = sevMeta(severity);
  return `
  <tr>
    <td style="padding:20px 40px 0;">
      <p style="margin:0;font-size:12px;color:#8888a0;font-family:monospace;letter-spacing:0.5px;">${escHtml(ticketNumber)}</p>
      <h1 style="margin:6px 0 0;font-size:19px;font-weight:700;color:#e8e8ed;line-height:1.35;">
        <span style="background:${escHtml(meta.chip)};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;vertical-align:middle;letter-spacing:0.5px;margin-right:8px;">${meta.label}</span>
        ${escHtml(title)}
      </h1>
      <p style="margin:8px 0 0;font-size:13px;color:#8888a0;">
        Connection: <strong style="color:#e8e8ed;">${escHtml(connectionName)}</strong>
      </p>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 40px 0;">
      <div style="height:1px;background:rgba(255,255,255,0.07);"></div>
    </td>
  </tr>`;
}

// ── Recommended fix block (optional) ─────────────────────────────────────────

function fixBlock(recommendedFix) {
  if (!recommendedFix) return '';
  return `
  <tr>
    <td style="padding:0 40px 0;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#f0a830;text-transform:uppercase;letter-spacing:1px;">Recommended Fix</p>
      <div style="background:#0a0a0c;border-radius:7px;border:1px solid rgba(255,255,255,0.08);padding:14px 16px;margin-bottom:4px;">
        <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;white-space:pre-wrap;word-break:break-all;">${escHtml(recommendedFix)}</code>
      </div>
    </td>
  </tr>`;
}

// ── Body text block ───────────────────────────────────────────────────────────

function bodyBlock(lines) {
  const paras = Array.isArray(lines) ? lines : [lines];
  return paras.map(line =>
    `<tr><td style="padding:16px 40px 0;font-size:14px;color:#c8c8d8;line-height:1.6;">${escHtml(String(line))}</td></tr>`
  ).join('');
}

// ── Plain-text fallback ───────────────────────────────────────────────────────

function plainText(subject, lines, ticketNumber, recommendedFix) {
  const parts = [subject, '', ...lines];
  if (recommendedFix) {
    parts.push('', 'Recommended Fix:', recommendedFix);
  }
  parts.push('', `View ticket: ${ticketUrl(ticketNumber)}`);
  parts.push('', 'TuneVault · support@tunevault.app');
  return parts.join('\n');
}

// ── Low-level send ────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, html }) {
  if (!POLSIA_API_KEY) {
    console.warn('[tuneops-mailer] POLSIA_API_KEY not set — skipping email to', to);
    return { sent: false, error: 'POLSIA_API_KEY not configured' };
  }
  try {
    const res = await fetch(`${EMAIL_API_URL}/send`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${POLSIA_API_KEY}` },
      body   : JSON.stringify({ to, subject, body, html }),
    });
    if (res.ok) return { sent: true };
    const errText = await res.text().catch(() => '');
    console.warn(`[tuneops-mailer] send failed for ${to}: HTTP ${res.status}: ${errText}`);
    return { sent: false, error: `HTTP ${res.status}` };
  } catch (err) {
    console.warn(`[tuneops-mailer] send threw for ${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

async function registerContact(email) {
  if (!POLSIA_API_KEY) return;
  try {
    await fetch(`${EMAIL_API_URL}/contacts`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${POLSIA_API_KEY}` },
      body   : JSON.stringify({ email, source: 'other' }),
    });
  } catch { /* non-fatal */ }
}

// ── Core dispatch ─────────────────────────────────────────────────────────────

/**
 * Send one notification to one recipient, enforcing dedup + rate-limit.
 *
 * @param {object} opts
 * @param {string} opts.to              — recipient email
 * @param {string} opts.subject         — email subject
 * @param {string} opts.body            — plain-text fallback
 * @param {string} opts.html            — HTML version
 * @param {string} opts.ticketNumber    — e.g. 'TO-0042'
 * @param {string} opts.eventType       — e.g. 'created_critical'
 * @param {object} [opts.metadata]      — extra data for the log
 * @param {number} [opts.connectionId]  — for mute check
 * @param {number} [opts.userId]        — for preference check
 */
async function dispatchOne({ to, subject, body, html, ticketNumber, eventType, metadata, connectionId, userId }) {
  try {
    // Preference check (if userId provided)
    if (userId) {
      const prefs = await db.getPrefs(userId);
      if (!prefs.notifications_enabled) return { sent: false, reason: 'notifications_disabled' };

      // Severity gate: map threshold to numeric rank
      const sevRank = { info: 0, warning: 1, critical: 2 };
      const threshold = sevRank[prefs.severity_threshold] ?? 1;
      // eventType encodes severity: created_critical → critical, created_warning → warning
      const eventSev = eventType.includes('critical') ? 2 : eventType.includes('warning') ? 1 : 0;
      // For non-creation events (assigned, approved, etc.) always send regardless of threshold
      const isCreation = eventType.startsWith('created_');
      if (isCreation && eventSev < threshold) return { sent: false, reason: 'below_threshold' };
    }

    // Connection mute check
    if (userId && connectionId) {
      const muted = await db.isConnectionMuted(userId, connectionId);
      if (muted) return { sent: false, reason: 'connection_muted' };
    }

    // Rate limit: max 10 per ticket per hour
    const recentCount = await db.countRecentForTicket(ticketNumber);
    if (recentCount >= RATE_LIMIT_PER_TICKET_PER_HOUR) {
      console.warn(`[tuneops-mailer] rate limit hit for ${ticketNumber} (${recentCount} in last hour)`);
      return { sent: false, reason: 'rate_limit' };
    }

    // Dedup: skip if same (ticket, event, recipient) within 1 hour
    const dup = await db.isDuplicate(ticketNumber, eventType, to);
    if (dup) return { sent: false, reason: 'duplicate' };

    // Register contact (best-effort, ensures deliverability)
    await registerContact(to);

    const result = await sendEmail({ to, subject, body, html });

    if (result.sent) {
      await db.logSend(ticketNumber, eventType, to, metadata);
    }

    return result;
  } catch (err) {
    console.warn(`[tuneops-mailer] dispatchOne threw for ${to} / ${ticketNumber}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/**
 * Dispatch to multiple recipients in parallel.
 * Returns array of { to, ...result }.
 */
async function dispatchMany(recipients, opts) {
  return Promise.all(
    recipients.map(r => dispatchOne({ ...opts, to: r.email, userId: r.userId, connectionId: opts.connectionId })
      .then(result => ({ to: r.email, ...result }))
    )
  );
}

// ── Event-specific senders ────────────────────────────────────────────────────

/**
 * Notify on ticket creation.
 * recipients: array of { email, userId }
 * severity: 'critical' | 'warning'
 */
async function notifyCreated({ ticketNumber, title, severity, connectionName, recommendedFix, recipients }) {
  const meta   = sevMeta(severity);
  const evType = severity === 'critical' ? 'created_critical' : 'created_warning';
  const subject = `[TuneOps] ${ticketNumber} ${meta.emoji} ${meta.label}: ${title} — ${connectionName}`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock(`A new ${meta.label.toLowerCase()} issue was detected on ${connectionName}.`)}
    ${fixBlock(recommendedFix)}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({
    title: subject,
    headerBg: meta.headerBg,
    innerHtml,
    ticketNumber,
  });

  const bodyTxt = plainText(subject, [`${meta.label}: ${title}`, `Connection: ${connectionName}`], ticketNumber, recommendedFix);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: evType, connectionName });
}

/**
 * Notify assignee when a ticket is assigned to them.
 */
async function notifyAssigned({ ticketNumber, title, severity, connectionName, assigneeName, recommendedFix, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} assigned to you — ${title}`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock(`This ticket has been assigned to you, ${escHtml(assigneeName)}. Please review and confirm a fix plan.`)}
    ${fixBlock(recommendedFix)}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Assigned to: ${assigneeName}`, `Connection: ${connectionName}`], ticketNumber, recommendedFix);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'assigned', connectionName });
}

/**
 * Notify approver that a fix is awaiting their approval.
 */
async function notifyApprovalRequested({ ticketNumber, title, severity, connectionName, requesterName, recommendedFix, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} awaiting your approval — ${requesterName} wants to execute fix`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock([
      `${escHtml(requesterName)} has confirmed and wants to execute the fix for this ticket.`,
      'Please review and approve or reject.',
    ])}
    ${fixBlock(recommendedFix)}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Requested by: ${requesterName}`, `Connection: ${connectionName}`], ticketNumber, recommendedFix);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'approval_requested', connectionName });
}

/**
 * Notify requester that their fix was approved.
 */
async function notifyApproved({ ticketNumber, title, severity, connectionName, approverName, recommendedFix, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} approved by ${approverName} — ready to execute`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock([
      `${escHtml(approverName)} has approved the fix. You can now execute.`,
    ])}
    ${fixBlock(recommendedFix)}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Approved by: ${approverName}`, `Connection: ${connectionName}`], ticketNumber, recommendedFix);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'approved', connectionName });
}

/**
 * Notify requester that their fix was rejected.
 */
async function notifyRejected({ ticketNumber, title, severity, connectionName, approverName, rejectionReason, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} rejected by ${approverName} — ${rejectionReason || 'see ticket for details'}`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock([
      `${escHtml(approverName)} has rejected the fix.`,
      rejectionReason ? `Reason: ${rejectionReason}` : 'See the ticket for details.',
    ])}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Rejected by: ${approverName}`, rejectionReason ? `Reason: ${rejectionReason}` : '', `Connection: ${connectionName}`], ticketNumber, null);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'rejected', connectionName });
}

/**
 * Notify on successful execution/resolution.
 */
async function notifyExecutedSuccess({ ticketNumber, title, severity, connectionName, executorName, durationMs, recipients }) {
  const meta    = sevMeta(severity);
  const durationStr = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : '';
  const subject = `[TuneOps] ${ticketNumber} ✅ RESOLVED — ${title} fixed by ${executorName}`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity: 'info', title, connectionName })}
    ${bodyBlock([
      `${escHtml(executorName)} successfully executed the fix${durationStr}.`,
      'The issue has been resolved.',
    ])}
    <tr><td style="padding:8px 0;"></td></tr>`;

  // Use green header for success
  const successHeaderBg = 'linear-gradient(135deg,#4ade80 0%,#16a34a 100%)';
  const html = emailShell({ title: subject, headerBg: successHeaderBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Executor: ${executorName}`, `Connection: ${connectionName}`, durationMs ? `Duration: ${(durationMs / 1000).toFixed(1)}s` : ''], ticketNumber, null);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'executed_success', connectionName });
}

/**
 * Notify on failed execution.
 */
async function notifyExecutedFailed({ ticketNumber, title, severity, connectionName, executorName, errorMessage, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} ❌ FIX FAILED — manual intervention required`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity: 'critical', title, connectionName })}
    ${bodyBlock([
      `The fix executed by ${escHtml(executorName)} failed. Manual intervention is required.`,
      errorMessage ? `Error: ${errorMessage}` : '',
    ].filter(Boolean))}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Executor: ${executorName}`, `Connection: ${connectionName}`, errorMessage ? `Error: ${errorMessage}` : ''], ticketNumber, null);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'executed_failed', connectionName });
}

/**
 * Notify when a previously-resolved ticket is reopened.
 */
async function notifyReopened({ ticketNumber, title, severity, connectionName, reopenedCount, healthCheckId, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} 🔄 REOPENED — issue recurred on health check`;

  const countNote = reopenedCount > 1 ? ` (recurrence #${reopenedCount})` : '';

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock([
      `This issue has recurred${countNote} and the ticket has been reopened automatically.`,
      healthCheckId ? `Detected on health check run #${healthCheckId}.` : 'Detected on the latest health check.',
    ])}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Recurrence: #${reopenedCount}`, `Connection: ${connectionName}`], ticketNumber, null);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'reopened', connectionName });
}

/**
 * Notify leads/managers when a ticket is acknowledged (accepted risk, no action).
 */
async function notifyAcknowledged({ ticketNumber, title, severity, connectionName, acknowledgedByName, recipients }) {
  const meta    = sevMeta(severity);
  const subject = `[TuneOps] ${ticketNumber} acknowledged by ${acknowledgedByName} — no action taken`;

  const innerHtml = `
    ${ticketHeader({ ticketNumber, severity, title, connectionName })}
    ${bodyBlock([
      `${escHtml(acknowledgedByName)} has acknowledged this ticket — accepting the risk with no immediate fix.`,
      'The ticket remains open but no notifications will fire for 24 hours unless the severity worsens.',
    ])}
    <tr><td style="padding:8px 0;"></td></tr>`;

  const html = emailShell({ title: subject, headerBg: meta.headerBg, innerHtml, ticketNumber });
  const bodyTxt = plainText(subject, [`Acknowledged by: ${acknowledgedByName}`, `Connection: ${connectionName}`], ticketNumber, null);

  return dispatchMany(recipients, { subject, body: bodyTxt, html, ticketNumber, eventType: 'acknowledged', connectionName });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Per-event senders
  notifyCreated,
  notifyAssigned,
  notifyApprovalRequested,
  notifyApproved,
  notifyRejected,
  notifyExecutedSuccess,
  notifyExecutedFailed,
  notifyReopened,
  notifyAcknowledged,

  // Low-level dispatch (for callers that build their own email content)
  dispatchOne,
  dispatchMany,
};
