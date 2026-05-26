/**
 * services/alert-notifier.js — multi-channel alert notification dispatcher.
 *
 * Owns: sending notifications via Email, PagerDuty, Slack, Teams, OpsGenie, Webhook.
 * Does NOT own: policy storage (db/alert-policies.js), policy evaluation logic
 *               (services/alert-policy-evaluator.js), or email template rendering
 *               beyond what's built here.
 *
 * Each channel sends independently — failures in one do not block others.
 * Returns array of { channel, sent, error? } results.
 */

'use strict';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';
const APP_URL        = process.env.APP_URL || 'https://tunevault.app';

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_COLOR = { warning: '#f0a830', critical: '#f87171', info: '#60a5fa' };
const PD_SEV    = { critical: 'critical', warning: 'warning', info: 'info' };

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Email ─────────────────────────────────────────────────────────────────────

function buildAlertEmailHtml({ policyName, connectionName, connectionId, severity, currentValue, eventId, checkType }) {
  const color  = SEV_COLOR[severity] || '#8888a0';
  const sevLabel = severity.toUpperCase();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>TuneVault Alert — ${escHtml(policyName)}</title></head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0c;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#111114;border-radius:12px;border:1px solid rgba(240,168,48,0.18);">
      <tr><td style="background:linear-gradient(135deg,${color} 0%,${color}aa 100%);padding:4px;border-radius:12px 12px 0 0;"></td></tr>
      <tr><td style="padding:32px 40px 0;">
        <span style="font-size:22px;font-weight:700;color:#f0a830;">TuneVault</span>
        <span style="font-size:13px;color:#8888a0;margin-left:8px;">Alert Policy Triggered</span>
      </td></tr>
      <tr><td style="padding:24px 40px 0;">
        <span style="background:${color};color:#0a0a0c;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;">${sevLabel}</span>
        <h1 style="margin:12px 0 0;font-size:20px;font-weight:700;color:#e8e8ed;">${escHtml(policyName)}</h1>
        <p style="margin:8px 0 0;font-size:14px;color:#8888a0;">Connection: <strong style="color:#e8e8ed;">${escHtml(connectionName)}</strong></p>
        ${currentValue ? `<p style="margin:6px 0 0;font-size:13px;color:#8888a0;">Value: <strong style="color:#e8e8ed;">${escHtml(currentValue)}</strong></p>` : ''}
      </td></tr>
      <tr><td style="padding:24px 40px;">
        <a href="${APP_URL}/dashboard?connection=${connectionId}"
           style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;">
          View Dashboard →
        </a>
        &nbsp;&nbsp;
        <a href="${APP_URL}/settings/alerts"
           style="display:inline-block;color:#8888a0;font-size:13px;text-decoration:none;padding:12px 0;">
          Manage alert policies
        </a>
      </td></tr>
      <tr><td style="padding:0 40px 28px;border-top:1px solid rgba(255,255,255,0.06);">
        <p style="margin:20px 0 0;font-size:12px;color:#555568;">
          TuneVault · Oracle Database Health Intelligence
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendEmailChannel({ config, policyName, connectionName, connectionId, severity, currentValue, checkType, eventId }) {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };

  const emails = config.emails || [];
  if (emails.length === 0) return { sent: false, error: 'no email recipients configured' };

  const results = [];
  for (const to of emails) {
    try {
      const subject = `[TuneVault] ${severity.toUpperCase()}: ${policyName} — ${connectionName}`;
      const html    = buildAlertEmailHtml({ policyName, connectionName, connectionId, severity, currentValue, eventId, checkType });
      const body    = `TuneVault Alert Policy Triggered\n\nPolicy: ${policyName}\nConnection: ${connectionName}\nSeverity: ${severity.toUpperCase()}\n${currentValue ? `Value: ${currentValue}\n` : ''}\nView dashboard: ${APP_URL}/dashboard?connection=${connectionId}`;

      const res = await fetch(`${RESEND_API_URL}/emails`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body   : JSON.stringify({ from: FROM_ADDRESS, to, subject, text: body, html }),
      });
      results.push({ to, sent: res.ok, status: res.status });
    } catch (err) {
      results.push({ to, sent: false, error: err.message });
    }
  }
  const allSent = results.every(r => r.sent);
  return { sent: allSent, results };
}

// ── PagerDuty ─────────────────────────────────────────────────────────────────

async function sendPagerDutyChannel({ config, policyName, connectionName, severity, currentValue }) {
  const { integration_key } = config;
  if (!integration_key) return { sent: false, error: 'PagerDuty integration_key missing' };

  try {
    const payload = {
      routing_key  : integration_key,
      event_action : 'trigger',
      payload: {
        summary  : `[TuneVault] ${policyName} — ${connectionName}`,
        severity : PD_SEV[severity] || 'warning',
        source   : connectionName,
        custom_details: { value: currentValue, policy: policyName },
      },
    };
    const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { sent: true, dedup_key: body.dedup_key };
    return { sent: false, error: `PD HTTP ${res.status}: ${body.message || ''}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function sendSlackChannel({ config, policyName, connectionName, connectionId, severity, currentValue }) {
  const { webhook_url } = config;
  if (!webhook_url) return { sent: false, error: 'Slack webhook_url missing' };

  const color = SEV_COLOR[severity] || '#8888a0';
  try {
    const body = {
      attachments: [{
        color,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `⚠ TuneVault Alert: ${policyName}` }
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Connection*\n${connectionName}` },
              { type: 'mrkdwn', text: `*Severity*\n${severity.toUpperCase()}` },
              ...(currentValue ? [{ type: 'mrkdwn', text: `*Value*\n${currentValue}` }] : []),
            ]
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: 'View Dashboard' },
              url : `${APP_URL}/dashboard?connection=${connectionId}`,
            }]
          }
        ]
      }]
    };
    const res = await fetch(webhook_url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });
    if (res.ok) return { sent: true };
    const text = await res.text().catch(() => '');
    return { sent: false, error: `Slack HTTP ${res.status}: ${text}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ── Microsoft Teams ───────────────────────────────────────────────────────────

async function sendTeamsChannel({ config, policyName, connectionName, connectionId, severity, currentValue }) {
  const { webhook_url } = config;
  if (!webhook_url) return { sent: false, error: 'Teams webhook_url missing' };

  const color  = severity === 'critical' ? 'attention' : 'warning';
  try {
    const body = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: `⚠ TuneVault Alert Policy Triggered`, weight: 'Bolder', size: 'Medium', color },
            { type: 'FactSet', facts: [
              { title: 'Policy',     value: policyName },
              { title: 'Connection', value: connectionName },
              { title: 'Severity',   value: severity.toUpperCase() },
              ...(currentValue ? [{ title: 'Value', value: currentValue }] : []),
            ]},
          ],
          actions: [{
            type: 'Action.OpenUrl',
            title: 'View Dashboard',
            url  : `${APP_URL}/dashboard?connection=${connectionId}`,
          }],
        }
      }]
    };
    const res = await fetch(webhook_url, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });
    if (res.ok) return { sent: true };
    const text = await res.text().catch(() => '');
    return { sent: false, error: `Teams HTTP ${res.status}: ${text}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ── OpsGenie ─────────────────────────────────────────────────────────────────

async function sendOpsGenieChannel({ config, policyName, connectionName, severity, currentValue }) {
  const { api_key } = config;
  if (!api_key) return { sent: false, error: 'OpsGenie api_key missing' };

  try {
    const body = {
      message  : `[TuneVault] ${policyName} — ${connectionName}`,
      priority : severity === 'critical' ? 'P1' : 'P3',
      details  : { value: currentValue || '', policy: policyName, connection: connectionName },
      source   : 'TuneVault',
    };
    const res = await fetch('https://api.opsgenie.com/v2/alerts', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `GenieKey ${api_key}` },
      body   : JSON.stringify(body),
    });
    if (res.ok) return { sent: true };
    const text = await res.text().catch(() => '');
    return { sent: false, error: `OpsGenie HTTP ${res.status}: ${text}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ── Generic Webhook ───────────────────────────────────────────────────────────

async function sendWebhookChannel({ config, policyName, connectionName, connectionId, severity, currentValue, eventId }) {
  const { url, headers: extraHeaders, auth } = config;
  if (!url) return { sent: false, error: 'Webhook url missing' };

  try {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (auth?.type === 'bearer') headers['Authorization'] = `Bearer ${auth.token}`;
    if (auth?.type === 'basic')  headers['Authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;

    const body = {
      source    : 'tunevault',
      event     : 'alert.triggered',
      event_id  : eventId,
      policy    : policyName,
      connection: connectionName,
      connection_id: connectionId,
      severity,
      current_value: currentValue,
      dashboard_url: `${APP_URL}/dashboard?connection=${connectionId}`,
      triggered_at : new Date().toISOString(),
    };
    const res = await fetch(url, {
      method : 'POST',
      headers,
      body   : JSON.stringify(body),
    });
    if (res.ok) return { sent: true };
    const text = await res.text().catch(() => '');
    return { sent: false, error: `Webhook HTTP ${res.status}: ${text.substring(0, 200)}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * sendNotifications(channels, context)
 *
 * channels: array of { type, config, is_active }
 * context : { policyName, connectionName, connectionId, severity, currentValue, checkType, eventId }
 *
 * Returns array of { channel_type, sent, error? }
 * Never throws.
 */
async function sendNotifications(channels, context) {
  const results = [];

  for (const ch of channels) {
    if (!ch.is_active) continue;

    let result;
    try {
      switch (ch.type) {
        case 'email':
          result = await sendEmailChannel({ config: ch.config, ...context });
          break;
        case 'pagerduty':
          result = await sendPagerDutyChannel({ config: ch.config, ...context });
          break;
        case 'slack':
          result = await sendSlackChannel({ config: ch.config, ...context });
          break;
        case 'teams':
          result = await sendTeamsChannel({ config: ch.config, ...context });
          break;
        case 'opsgenie':
          result = await sendOpsGenieChannel({ config: ch.config, ...context });
          break;
        case 'webhook':
          result = await sendWebhookChannel({ config: ch.config, ...context });
          break;
        default:
          result = { sent: false, error: `unknown channel type: ${ch.type}` };
      }
    } catch (err) {
      result = { sent: false, error: err.message };
    }

    results.push({ channel_type: ch.type, ...result, sent_at: new Date().toISOString() });
  }

  return results;
}

/**
 * sendTestNotification(channel, context)
 * Single channel, returns { sent, error? }.
 */
async function sendTestNotification(channel, context) {
  const testContext = {
    ...context,
    policyName    : 'Test Alert — TuneVault',
    currentValue  : 'test value (91.2%)',
    severity      : 'warning',
    eventId       : 0,
  };
  const [result] = await sendNotifications([{ ...channel, is_active: true }], testContext);
  return result;
}

module.exports = { sendNotifications, sendTestNotification };
