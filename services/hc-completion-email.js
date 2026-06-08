/**
 * services/hc-completion-email.js — health check completion email sender.
 *
 * Owns: sending the "your health check is done" email when a non-demo run
 *       transitions to status='completed'.
 * Does NOT own: user preferences persistence (see db/user-preferences.js),
 *              email_log writes (see db/email-log.js), general email sending.
 *
 * Called from runAIAnalysis() (server.js) after DB is updated to completed.
 * Always fire-and-forget — never throws, never blocks the caller.
 *
 * Suppression rules (all must pass before sending):
 *  1. run is not demo (is_demo=false)
 *  2. user has hc_completion_email preference enabled (default: true)
 *  3. TV_HC_EMAIL_SUPPRESS_USERS env var does not contain user email
 *  4. throttle: no email sent to this user in last 10 minutes
 *     (coalesces burst testing into one digest send)
 */

'use strict';

const { getPreferences, stampHcEmailSent, getUserForConnection, getHealthCheckForEmail } = require('../db/user-preferences');
const { logEmail } = require('../db/email-log');

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';

// Comma-separated list of emails to never send HC completion emails to.
// Useful for admin test accounts.
const SUPPRESS_EMAILS = new Set(
  (process.env.TV_HC_EMAIL_SUPPRESS_USERS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);

// Throttle window: if a user ran 5 checks in 10 min, coalesce into 1 send.
const THROTTLE_MS = 10 * 60 * 1000;

// ─── HTML TEMPLATE ──────────────────────────────────────────────────────────

function buildHtml({ connectionName, score, criticalCount, amberCount, isEbs, completedAt, topFindings, hcId }) {
  const reportUrl   = `${APP_URL}/healthcheck/report/${hcId}`;
  const settingsUrl = `${APP_URL}/settings/notifications`;
  const dateStr     = completedAt
    ? new Date(completedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : 'just now';

  const scoreColor = score >= 75 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';

  const findingsRows = topFindings.slice(0, 3).map(f => `
    <tr>
      <td style="padding:8px 10px;font-size:12px;color:#8888a0;font-family:monospace;border-bottom:1px solid rgba(255,255,255,0.06);">${escHtml(f.check_id || f.category || '—')}</td>
      <td style="padding:8px 10px;font-size:13px;color:#e8e8ed;border-bottom:1px solid rgba(255,255,255,0.06);">${escHtml(f.title || f.metric || '—')}</td>
      <td style="padding:8px 10px;font-size:12px;color:#8888a0;border-bottom:1px solid rgba(255,255,255,0.06);">${escHtml(f.impact || f.value || '—')}</td>
    </tr>`).join('');

  const findingsTable = topFindings.length > 0 ? `
    <!-- Top findings -->
    <tr>
      <td style="padding:24px 40px 0;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#f0a830;text-transform:uppercase;letter-spacing:1px;">Top critical findings</p>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.08);border-collapse:collapse;">
          <thead>
            <tr>
              <th style="padding:8px 10px;font-size:11px;color:#555568;text-align:left;text-transform:uppercase;letter-spacing:0.8px;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);">Check</th>
              <th style="padding:8px 10px;font-size:11px;color:#555568;text-align:left;text-transform:uppercase;letter-spacing:0.8px;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);">Finding</th>
              <th style="padding:8px 10px;font-size:11px;color:#555568;text-align:left;text-transform:uppercase;letter-spacing:0.8px;font-weight:600;border-bottom:1px solid rgba(255,255,255,0.08);">Impact</th>
            </tr>
          </thead>
          <tbody>
            ${findingsRows}
          </tbody>
        </table>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health check complete — ${escHtml(connectionName)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0c;">
  <tr>
    <td align="center" style="padding:40px 16px;">

      <!-- Card -->
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#111114;border-radius:12px;border:1px solid rgba(240,168,48,0.18);">

        <!-- Header bar -->
        <tr>
          <td style="background:linear-gradient(135deg,#f0a830 0%,#d4891f 100%);padding:4px;border-radius:12px 12px 0 0;"></td>
        </tr>

        <!-- Logo + wordmark -->
        <tr>
          <td style="padding:36px 40px 0;">
            <span style="font-size:22px;font-weight:700;color:#f0a830;letter-spacing:-0.5px;">TuneVault</span>
            <span style="font-size:13px;color:#8888a0;margin-left:8px;font-weight:400;">Oracle Health Intelligence</span>
          </td>
        </tr>

        <!-- Headline -->
        <tr>
          <td style="padding:24px 40px 0;">
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              Health check complete
            </h1>
            <p style="margin:8px 0 0;font-size:14px;color:#8888a0;">
              ${escHtml(connectionName)} &nbsp;·&nbsp; ${dateStr}
            </p>
          </td>
        </tr>

        <!-- Score + counts row -->
        <tr>
          <td style="padding:24px 40px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <!-- Score -->
                <td style="width:33%;text-align:center;background:#0d0d10;border-radius:8px;padding:16px;border:1px solid rgba(255,255,255,0.08);">
                  <div style="font-size:36px;font-weight:800;color:${scoreColor};line-height:1;">${score}</div>
                  <div style="font-size:11px;color:#555568;margin-top:4px;text-transform:uppercase;letter-spacing:0.8px;">/100 score</div>
                </td>
                <td style="width:8px;"></td>
                <!-- Critical -->
                <td style="width:28%;text-align:center;background:#0d0d10;border-radius:8px;padding:16px;border:1px solid rgba(255,255,255,0.08);">
                  <div style="font-size:28px;font-weight:700;color:${criticalCount > 0 ? '#ef4444' : '#22c55e'};line-height:1;">${criticalCount}</div>
                  <div style="font-size:11px;color:#555568;margin-top:4px;text-transform:uppercase;letter-spacing:0.8px;">Critical</div>
                </td>
                <td style="width:8px;"></td>
                <!-- Amber -->
                <td style="width:28%;text-align:center;background:#0d0d10;border-radius:8px;padding:16px;border:1px solid rgba(255,255,255,0.08);">
                  <div style="font-size:28px;font-weight:700;color:${amberCount > 0 ? '#f59e0b' : '#22c55e'};line-height:1;">${amberCount}</div>
                  <div style="font-size:11px;color:#555568;margin-top:4px;text-transform:uppercase;letter-spacing:0.8px;">Warnings</div>
                </td>
              </tr>
            </table>
            ${isEbs ? `<p style="margin:10px 0 0;font-size:12px;color:#f0a830;">✓ EBS application layer detected</p>` : ''}
          </td>
        </tr>

        ${findingsTable}

        <!-- Divider -->
        <tr>
          <td style="padding:24px 40px 0;">
            <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:24px 40px;">
            <a href="${reportUrl}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;">
              View full report →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:0 40px 32px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:20px 0 0;font-size:12px;color:#555568;line-height:1.7;">
              <a href="${settingsUrl}" style="color:#8888a0;text-decoration:none;">Manage email preferences</a>
              &nbsp;·&nbsp; TuneVault · Oracle Health Intelligence
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

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── REGISTER CONTACT ───────────────────────────────────────────────────────

async function registerContact(_email) {
  // Resend audiences managed in dashboard; wire RESEND_AUDIENCE_ID here if needed.
}

// ─── MAIN ENTRY POINT ───────────────────────────────────────────────────────

/**
 * sendHcCompletionEmail({ healthCheckId, connectionId, metrics, scores })
 *
 * Called fire-and-forget from runAIAnalysis() after health check completes.
 * Resolves undefined — never throws.
 */
async function sendHcCompletionEmail({ healthCheckId, connectionId, metrics, scores }) {
  if (!RESEND_API_KEY) {
    console.warn('[hc-email] RESEND_API_KEY not set — skipping HC completion email');
    return;
  }

  try {
    // Resolve user from connection ownership
    if (!connectionId) return; // no user to email for anonymous/demo paths

    const connRow = await getUserForConnection(connectionId);
    if (!connRow) return; // connection or user not found

    const { user_id, email: userEmail, name: userName, connection_name, server_type: serverType } = connRow;

    // Get the completed health check details for score + timestamp
    const hc = await getHealthCheckForEmail(healthCheckId);
    if (!hc) return;

    // Never send for demo runs
    if (hc.is_demo) return;

    // Suppress list check
    if (SUPPRESS_EMAILS.has((userEmail || '').toLowerCase())) {
      console.log(`[hc-email] suppressed for ${userEmail} (TV_HC_EMAIL_SUPPRESS_USERS)`);
      return;
    }

    // Preference check (default on)
    const prefs = await getPreferences(user_id);
    if (!prefs.hc_completion_email) {
      console.log(`[hc-email] disabled for user ${user_id}`);
      return;
    }

    // Throttle: if sent in last 10 min, skip
    if (prefs.last_hc_email_sent_at) {
      const age = Date.now() - new Date(prefs.last_hc_email_sent_at).getTime();
      if (age < THROTTLE_MS) {
        console.log(`[hc-email] throttled for user ${user_id} — last sent ${Math.round(age / 1000)}s ago`);
        return;
      }
    }

    // Build findings for the top-3 critical table
    // Use metrics from the HC row (most reliable post-completion source)
    const hcMetrics = typeof hc.metrics === 'string' ? JSON.parse(hc.metrics) : (hc.metrics || {});
    const hcResults = typeof hc.results === 'string' ? JSON.parse(hc.results) : (hc.results || {});
    const usableMetrics = (metrics && Object.keys(metrics).length > 0) ? metrics : hcMetrics;

    const isEbs      = !!(usableMetrics && usableMetrics.ebs_detected);
    const finalScore = hc.overall_score ?? (scores && scores.overall) ?? 0;

    let criticalCount, amberCount, topCritical;
    if (serverType === 'apps') {
      // EBS app tier: findings stored in health_checks.results.findings[], not DB metrics
      const appFindings = hcResults?.findings || [];
      criticalCount = appFindings.filter(f => f.severity === 'critical').length;
      amberCount    = appFindings.filter(f => f.severity === 'warning').length;
      topCritical   = appFindings
        .filter(f => f.severity === 'critical')
        .slice(0, 3)
        .map(f => ({ check_id: f.check_id || '', title: f.title || f.label || '', impact: f.detail || f.status || '' }));
    } else {
      const findings = buildTopFindings(usableMetrics, scores);
      criticalCount = findings.filter(f => f.severity === 'critical').length;
      amberCount    = findings.filter(f => f.severity === 'warning').length;
      topCritical   = findings
        .filter(f => f.severity === 'critical')
        .slice(0, 3)
        .map(f => ({ check_id: f.category, title: f.metric, impact: f.value }));
    }

    const connName = connection_name || hc.connection_name || 'Oracle';
    const flagEmoji = finalScore < 50 ? '🚨 ' : '';
    const subject = `${flagEmoji}Health check complete — ${connName} scored ${finalScore}/100`;

    const plainText = [
      `Health check complete: ${connName}`,
      `Score: ${finalScore}/100 · Critical: ${criticalCount} · Warnings: ${amberCount}${isEbs ? ' · EBS detected' : ''}`,
      `Completed: ${hc.completed_at ? new Date(hc.completed_at).toUTCString() : 'just now'}`,
      '',
      topCritical.length > 0
        ? `Top critical findings:\n${topCritical.map(f => `  • ${f.title}: ${f.impact}`).join('\n')}`
        : 'No critical findings.',
      '',
      `View full report: ${APP_URL}/healthcheck/report/${healthCheckId}`,
      '',
      `Manage email preferences: ${APP_URL}/settings/notifications`
    ].join('\n');

    const html = buildHtml({
      connectionName: connName,
      score         : finalScore,
      criticalCount,
      amberCount,
      isEbs,
      completedAt   : hc.completed_at,
      topFindings   : topCritical,
      hcId          : healthCheckId
    });

    // Register contact before send (ensures transactional classification)
    await registerContact(userEmail);

    // Send
    const sendRes = await fetch(`${RESEND_API_URL}/emails`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body   : JSON.stringify({ from: FROM_ADDRESS, to: userEmail, subject, text: plainText, html })
    });

    const sendOk = sendRes.ok;
    const sendBody = await sendRes.json().catch(() => ({}));
    const messageId = sendBody?.message_id || null;

    // Log the send
    await logEmail({
      userId          : user_id,
      userEmail,
      template        : 'hc_completion',
      hcId            : healthCheckId,
      status          : sendOk ? 'sent' : 'failed',
      errorMessage    : sendOk ? null : `HTTP ${sendRes.status}`,
      postmarkMessageId: messageId
    });

    if (sendOk) {
      await stampHcEmailSent(user_id);
      console.log(`[hc-email] sent to ${userEmail} hc=${healthCheckId} score=${finalScore}`);
    } else {
      console.warn(`[hc-email] send failed for ${userEmail} hc=${healthCheckId}: HTTP ${sendRes.status}`);
    }

  } catch (err) {
    // Never let email errors bubble up to the HC pipeline
    console.error(`[hc-email] unexpected error for hc=${healthCheckId}: ${err.message}`);
    try {
      await logEmail({
        userId   : null,
        userEmail: '(unknown)',
        template : 'hc_completion',
        hcId     : healthCheckId,
        status   : 'failed',
        errorMessage: err.message,
        postmarkMessageId: null
      });
    } catch { /* log failure is non-fatal */ }
  }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Extract top findings from metrics (mirrors buildFindingsForSummary in server.js).
 * Kept local to this service — no dependency on server.js internals.
 */
function buildTopFindings(metrics, scores) {
  if (!metrics) return [];
  const findings = [];

  (metrics.tablespaces || []).forEach(t => {
    if (t.pct_used > 90)
      findings.push({ severity: 'critical', category: 'Storage', metric: `${t.name} tablespace`, value: `${t.pct_used}% used (${t.used_gb}GB/${t.total_gb}GB)` });
    else if (t.pct_used > 80)
      findings.push({ severity: 'warning', category: 'Storage', metric: `${t.name} tablespace`, value: `${t.pct_used}% used` });
  });

  (metrics.wait_events || []).filter(w => w.pct_db_time > 10).forEach(w => {
    findings.push({ severity: 'critical', category: 'Performance', metric: `Wait: ${w.event}`, value: `${w.pct_db_time}% DB time (${w.wait_class})` });
  });
  (metrics.wait_events || []).filter(w => w.pct_db_time > 5 && w.pct_db_time <= 10).forEach(w => {
    findings.push({ severity: 'warning', category: 'Performance', metric: `Wait: ${w.event}`, value: `${w.pct_db_time}% DB time` });
  });

  (metrics.top_sql || []).filter(sq => sq.elapsed_per_exec_ms > 5).forEach(sq => {
    findings.push({ severity: 'warning', category: 'SQL', metric: `SQL ${sq.sql_id}`, value: `${sq.elapsed_per_exec_ms}ms/exec — ${sq.issue}` });
  });

  (metrics.index_analysis || []).filter(i => i.pct_deleted > 50).forEach(i => {
    findings.push({ severity: 'critical', category: 'Indexes', metric: `${i.index_name} on ${i.table_name}`, value: `${i.pct_deleted}% deleted blocks` });
  });
  (metrics.index_analysis || []).filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).forEach(i => {
    findings.push({ severity: 'warning', category: 'Indexes', metric: i.index_name, value: `${i.pct_deleted}% fragmented` });
  });

  if (metrics.backup_stats) {
    const b = metrics.backup_stats;
    const rman = b.rman_backup || {};
    if (b.overall_status === 'critical')
      findings.push({ severity: 'critical', category: 'Backup', metric: 'RMAN backup', value: rman.last_full_backup ? `Last full ${rman.full_backup_hours_ago}h ago` : 'No full backup found' });
    else if (b.overall_status === 'warning')
      findings.push({ severity: 'warning', category: 'Backup', metric: 'RMAN backup', value: rman.last_full_backup ? `Last full ${rman.full_backup_hours_ago}h ago` : 'Backup status degraded' });
  }

  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    const hist = metrics.undo_stats.historical || {};
    if (hist.peak_query_length_s && u.tuned_undo_retention_s && hist.peak_query_length_s > u.tuned_undo_retention_s)
      findings.push({ severity: 'critical', category: 'Config', metric: 'Undo retention', value: `ORA-01555 risk — query ${hist.peak_query_length_s}s > retention ${u.tuned_undo_retention_s}s` });
    else if ((u.pct_used || 0) > 90)
      findings.push({ severity: 'critical', category: 'Storage', metric: 'Undo tablespace', value: `${u.pct_used}% used` });
  }

  (metrics.resource_limits && metrics.resource_limits.current || []).filter(r => r.status === 'critical').forEach(r => {
    findings.push({ severity: 'critical', category: 'Config', metric: `Resource limit: ${r.resource}`, value: `${r.pct_max_used}% of limit` });
  });

  findings.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1));
  return findings;
}

module.exports = { sendHcCompletionEmail };
