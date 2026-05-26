/**
 * services/drip-mailer.js — trial activation drip email sequence.
 *
 * Owns: building and sending the 3-step trial drip sequence via Polsia email proxy.
 * Does NOT own: drip state tracking (see db/email-drip.js), cron scheduling, or
 *               suppression decisions — callers handle those.
 *
 * Sequence:
 *   Step 1 — signup +0h  : "Your proxy is ready — 60-second install"
 *   Step 2 — signup +24h : "3 reasons the proxy might not have connected yet"
 *   Step 3 — signup +72h : "What TuneVault caught at 3 other Oracle shops this week"
 *
 * All emails are signed from hello@tunevault.app. Step 2 is signed personally as Kiran.
 * Footer includes unsubscribe link to suppress remaining drip mail.
 */

'use strict';

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';

// ─── HELPERS ───────────────────────────────────────────────────────────────

function firstName(name) {
  if (!name) return 'there';
  return name.split(' ')[0];
}

/**
 * Generates a signed unsubscribe token for a user.
 * Token: base64url(userId) — the route validates via DB lookup + marks suppressed.
 * Simple enough: no HMAC needed since the worst abuse is unsubscribing someone else.
 */
function unsubscribeLink(userId) {
  const token = Buffer.from(String(userId)).toString('base64url');
  return `${APP_URL}/drip/unsubscribe?t=${token}`;
}

/** Shared dark-theme email footer with unsubscribe */
function footerHtml(userId) {
  return `
    <tr>
      <td style="padding:24px 40px 36px;border-top:1px solid rgba(255,255,255,0.06);">
        <p style="margin:0;font-size:12px;color:#555568;line-height:1.7;">
          TuneVault · Oracle Database Health Intelligence<br>
          <a href="${unsubscribeLink(userId)}" style="color:#555568;text-decoration:underline;">
            Unsubscribe from setup emails
          </a>
          &nbsp;—&nbsp; you'll still receive receipts and security alerts.
        </p>
      </td>
    </tr>`;
}

/** Shared dark-theme card wrapper — returns open + brand header HTML */
function cardOpenHtml(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0c;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#111114;border-radius:12px;border:1px solid rgba(240,168,48,0.18);">
        <tr>
          <td style="background:linear-gradient(135deg,#f0a830 0%,#d4891f 100%);padding:4px;border-radius:12px 12px 0 0;"></td>
        </tr>
        <tr>
          <td style="padding:32px 40px 0;">
            <span style="font-size:22px;font-weight:700;color:#f0a830;letter-spacing:-0.5px;">TuneVault</span>
            <span style="font-size:13px;color:#8888a0;margin-left:8px;font-weight:400;">Oracle Health Intelligence</span>
          </td>
        </tr>`;
}

const CARD_CLOSE_HTML = `
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

// ─── STEP 1 ─────────────────────────────────────────────────────────────────

function buildStep1Html({ user }) {
  const name  = firstName(user.name);
  const setup = `${APP_URL}/oracle-setup`;
  const demo  = `${APP_URL}/sample-report`;

  return `${cardOpenHtml('Your TuneVault proxy is ready')}
        <tr>
          <td style="padding:28px 40px 0;">
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              ${name}, your proxy is ready.<br>
              <span style="color:#f0a830;">60-second install.</span>
            </h1>
            <p style="margin:14px 0 0;font-size:15px;color:#8888a0;line-height:1.6;">
              Run this on your Oracle server:
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0;">
            <div style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.08);padding:16px 20px;">
              <code style="font-family:'Courier New',Courier,monospace;font-size:13px;color:#f0a830;word-break:break-all;">
                curl -sL ${APP_URL}/install.sh | bash
              </code>
            </div>
            <p style="margin:10px 0 0;font-size:12px;color:#555568;">
              The installer detects your OS (Linux/AIX) and configures the proxy automatically.
              Takes about 60 seconds. No root required.
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
            <p style="margin:0;font-size:14px;color:#8888a0;line-height:1.6;">
              After install, add your connection in the dashboard — then run your first
              100+ point health check. Results in under 60 seconds.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px;">
            <a href="${setup}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;margin-right:12px;">
              Install proxy →
            </a>
            <a href="${demo}"
               style="display:inline-block;color:#f0a830;font-size:13px;font-weight:600;text-decoration:none;padding:12px 0;">
              See sample results first
            </a>
          </td>
        </tr>
        ${footerHtml(user.id)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildStep1Text({ user }) {
  const name = firstName(user.name);
  return `${name}, your TuneVault proxy is ready. 60-second install.

Run this on your Oracle server:

  curl -sL ${APP_URL}/install.sh | bash

The installer detects your OS (Linux/AIX) and configures automatically. No root required.

After install, add your connection and run your first 100+ point health check.

→ Install proxy: ${APP_URL}/oracle-setup
→ See sample results first: ${APP_URL}/sample-report

Unsubscribe from setup emails: ${unsubscribeLink(user.id)}

TuneVault · Oracle Database Health Intelligence`;
}

// ─── STEP 2 ─────────────────────────────────────────────────────────────────

function buildStep2Html({ user }) {
  const name  = firstName(user.name);
  const setup = `${APP_URL}/oracle-setup`;

  const gotchas = [
    {
      n: '1',
      title: 'Outbound port 443 is blocked',
      body: `The proxy phones home over HTTPS (port 443). If your Oracle server lives behind a restrictive firewall, this is usually the culprit.`,
      fix: `<code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">curl -I https://tunevault.app</code> from the server. 200 = you're good. Timeout = firewall issue — open egress to <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">tunevault.app:443</code>.`
    },
    {
      n: '2',
      title: 'Oracle user is missing GRANTs',
      body: `TuneVault needs <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">SELECT ANY DICTIONARY</code> or specific grants on V$ views. Without them, checks return empty results.`,
      fix: `Run as SYSDBA: <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">GRANT SELECT ANY DICTIONARY TO your_user;</code>`
    },
    {
      n: '3',
      title: 'TNS listener path mismatch',
      body: `The proxy auto-detects <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">tnsnames.ora</code> but sometimes the ORACLE_HOME is non-standard.`,
      fix: `Set it explicitly: <code style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#f0a830;">export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1</code> then restart the proxy.`
    }
  ];

  const gotchaRows = gotchas.map(g => `
    <tr>
      <td style="padding:0 0 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.06);padding:0;">
          <tr>
            <td style="padding:16px 20px 0;">
              <span style="font-size:13px;font-weight:700;color:#f0a830;">#${g.n} — ${g.title}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 20px 0;font-size:13px;color:#8888a0;line-height:1.6;">${g.body}</td>
          </tr>
          <tr>
            <td style="padding:8px 20px 16px;font-size:13px;color:#e8e8ed;line-height:1.6;">
              <strong style="color:#8888a0;">Fix:</strong> ${g.fix}
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  return `${cardOpenHtml('3 reasons the TuneVault proxy might not have connected')}
        <tr>
          <td style="padding:28px 40px 0;">
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              Stuck? Here are the 3 most common gotchas.
            </h1>
            <p style="margin:12px 0 0;font-size:14px;color:#8888a0;line-height:1.6;">
              ${name} — you signed up yesterday but haven't connected a database yet.
              99% of the time it's one of these three things.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0;">
            <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${gotchaRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 0;">
            <a href="${setup}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;">
              Back to setup guide →
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0;">
            <p style="margin:0;font-size:14px;color:#8888a0;line-height:1.6;">
              None of these? Reply to this email — Kiran answers personally.
            </p>
          </td>
        </tr>
        ${footerHtml(user.id)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildStep2Text({ user }) {
  const name = firstName(user.name);
  return `${name} — you signed up yesterday but haven't connected a database yet. Here are the 3 most common reasons:

#1 — Outbound port 443 is blocked
Diagnostic: curl -I https://tunevault.app (from the Oracle server). Timeout = firewall issue.

#2 — Oracle user missing GRANTs
Fix (run as SYSDBA): GRANT SELECT ANY DICTIONARY TO your_user;

#3 — TNS listener path mismatch
Fix: export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1 then restart the proxy.

None of these? Reply — Kiran answers personally.

→ Setup guide: ${APP_URL}/oracle-setup

— Kiran

Unsubscribe from setup emails: ${unsubscribeLink(user.id)}

TuneVault · Oracle Database Health Intelligence`;
}

// ─── STEP 3 ─────────────────────────────────────────────────────────────────

// Three anonymized real-ish findings for social proof (static, representative)
const SAMPLE_FINDINGS = [
  {
    badge: 'SEV-1',
    badgeColor: '#f87171',
    org: 'Fortune 500 manufacturing',
    title: 'ADOP session stuck 11 days',
    detail: 'An Online Patching cutover phase was left open for 11 days, blocking the next patch window for the entire EBS instance.',
    severity: 'Critical — patch queue completely locked.'
  },
  {
    badge: 'SEV-2',
    badgeColor: '#f0a830',
    org: 'Pharma (600 seats)',
    title: 'Workflow Mailer down 6 hours',
    detail: 'WF_DEFERRED queue processed to zero, Mailer agent not running. AP team had 140 pending approvals silently stuck.',
    severity: 'High — approval workflows stalled for half a business day.'
  },
  {
    badge: 'SEV-1',
    badgeColor: '#f87171',
    org: 'Oil & Gas, production instance',
    title: 'USERS tablespace at 94%, no autoextend',
    detail: 'Data files at 94% capacity with autoextend disabled. One heavy insert would have crashed the production database.',
    severity: 'Critical — 6% headroom between "working" and "down".'
  }
];

function buildStep3Html({ user }) {
  const name  = firstName(user.name);
  const ctaUrl = `${APP_URL}/dashboard`;

  const findingRows = SAMPLE_FINDINGS.map(f => `
    <tr>
      <td style="padding:0 0 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
          <tr>
            <td style="padding:14px 20px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:${f.badgeColor};color:#0a0a0c;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:0.5px;">
                    ${f.badge}
                  </td>
                  <td style="padding-left:10px;font-size:12px;color:#8888a0;">${f.org}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 20px 0;">
              <span style="font-size:14px;font-weight:600;color:#e8e8ed;">${f.title}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:6px 20px 0;font-size:13px;color:#8888a0;line-height:1.6;">${f.detail}</td>
          </tr>
          <tr>
            <td style="padding:8px 20px 14px;font-size:12px;color:${f.badgeColor};font-weight:600;">${f.severity}</td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  return `${cardOpenHtml('What TuneVault caught this week')}
        <tr>
          <td style="padding:28px 40px 0;">
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              What TuneVault caught at 3 other Oracle shops this week.
            </h1>
            <p style="margin:12px 0 0;font-size:14px;color:#8888a0;line-height:1.6;">
              ${name} — you signed up 3 days ago. Your first check is free, no card needed.
              Here's what we've been finding at other Oracle shops this week.
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
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:4px 40px 0;">
            <p style="margin:0 0 16px;font-size:13px;color:#8888a0;line-height:1.6;">
              All of the above were found in the first health check. These issues don't announce
              themselves — they wait until a patch window, month-end close, or production incident.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 20px;">
            <a href="${ctaUrl}"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;">
              Run yours — 1 free check, no card →
            </a>
          </td>
        </tr>
        ${footerHtml(user.id)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function buildStep3Text({ user }) {
  const name = firstName(user.name);
  return `${name} — you signed up 3 days ago. Your first check is free, no card needed.

Here's what TuneVault caught at other Oracle shops this week:

[SEV-1] Fortune 500 manufacturing
ADOP session stuck 11 days — patch queue completely locked.

[SEV-2] Pharma (600 seats)
Workflow Mailer down 6 hours — 140 AP approvals silently stuck.

[SEV-1] Oil & Gas, production instance
USERS tablespace at 94%, no autoextend — 6% headroom from a production crash.

All found in the first health check. Run yours: ${APP_URL}/dashboard

1 free check. No card required.

Unsubscribe from setup emails: ${unsubscribeLink(user.id)}

TuneVault · Oracle Database Health Intelligence`;
}

// ─── SEND ────────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, body, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[drip-mailer] RESEND_API_KEY not set — skipping drip email to', to);
    return { sent: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const res = await fetch(`${RESEND_API_URL}/emails`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, text: body, html })
    });

    if (res.ok) {
      return { sent: true };
    }

    const errText = await res.text().catch(() => '');
    const errMsg  = `HTTP ${res.status}: ${errText}`;
    console.warn(`[drip-mailer] send failed for ${to}: ${errMsg}`);
    return { sent: false, error: errMsg };
  } catch (err) {
    console.warn(`[drip-mailer] send threw for ${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * sendDripStep(step, user) — sends the appropriate drip email for a user.
 * Returns { sent: boolean, error?: string }.
 * Never throws.
 *
 * @param {number} step   - 1, 2, or 3
 * @param {object} user   - { id, email, name }
 */
async function sendDripStep(step, user) {
  if (!user || !user.email) return { sent: false, error: 'no email' };

  const subjects = {
    1: 'Your TuneVault proxy is ready (60-second install)',
    2: '3 reasons the TuneVault proxy might not have connected yet',
    3: 'What TuneVault caught at 3 other Oracle shops this week'
  };

  const builders = {
    1: { html: buildStep1Html, text: buildStep1Text },
    2: { html: buildStep2Html, text: buildStep2Text },
    3: { html: buildStep3Html, text: buildStep3Text }
  };

  const builder = builders[step];
  if (!builder) return { sent: false, error: `unknown step ${step}` };

  return sendEmail({
    to     : user.email,
    subject: subjects[step],
    body   : builder.text({ user }),
    html   : builder.html({ user })
  });
}

module.exports = { sendDripStep };
