/**
 * services/welcome-email.js — post-payment welcome email sender.
 *
 * Owns: sending the branded welcome email immediately after plan unlock.
 * Does NOT own: payment processing, plan credit logic, or user auth.
 *
 * Fires via Resend (RESEND_API_KEY). Dark theme + gold accent
 * matching the TuneVault dashboard. Called from routes/payments.js after
 * a confirmed plan upgrade — wrapped in try/catch so email failure never
 * blocks the plan unlock.
 */

'use strict';

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';

// ─── PLAN META ─────────────────────────────────────────────────────────────

const PLAN_DISPLAY = {
  starter: { label: 'Starter', checks: '50' },
  growth:  { label: 'Growth',  checks: '200' },
  scale:   { label: 'Scale',   checks: 'Unlimited' },
  custom:  { label: 'Custom',  checks: 'Unlimited' }
};

// ─── HTML TEMPLATE ─────────────────────────────────────────────────────────

function buildHtml({ userName, planLabel, checksPerMonth, paymentId, amountPaise, date, isEbs }) {
  const amountDisplay = amountPaise ? `₹${(amountPaise / 100).toLocaleString('en-IN')}` : '';
  const dateDisplay   = date ? new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const firstName     = userName ? userName.split(' ')[0] : 'there';
  const ebsLink       = isEbs
    ? `<tr><td style="padding:8px 0;">
         <a href="${APP_URL}/ebs-deep" style="color:#f0a830;text-decoration:none;">→ Open EBS Agent dashboard</a>
       </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to TuneVault ${planLabel}</title>
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
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <span style="font-size:22px;font-weight:700;color:#f0a830;letter-spacing:-0.5px;">TuneVault</span>
                  <span style="font-size:13px;color:#8888a0;margin-left:8px;font-weight:400;">Oracle Health Intelligence</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Headline -->
        <tr>
          <td style="padding:28px 40px 0;">
            <h1 style="margin:0;font-size:24px;font-weight:700;color:#e8e8ed;line-height:1.3;">
              Welcome to <span style="color:#f0a830;">${planLabel}</span>, ${firstName}.
            </h1>
            <p style="margin:12px 0 0;font-size:15px;color:#8888a0;line-height:1.6;">
              Your Oracle agent is ready. You have
              <strong style="color:#e8e8ed;">${checksPerMonth} health check${checksPerMonth === 'Unlimited' ? 's' : ' checks'}</strong>
              per month.
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr>
          <td style="padding:24px 40px 0;">
            <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
          </td>
        </tr>

        <!-- Next steps -->
        <tr>
          <td style="padding:24px 40px 0;">
            <p style="margin:0 0 16px;font-size:13px;font-weight:600;color:#f0a830;text-transform:uppercase;letter-spacing:1px;">
              Get started in 3 steps
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td style="padding:0 0 16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:28px;height:28px;background:#f0a830;border-radius:50%;text-align:center;vertical-align:middle;">
                        <span style="color:#0a0a0c;font-size:13px;font-weight:700;">1</span>
                      </td>
                      <td style="padding-left:14px;vertical-align:middle;">
                        <span style="color:#e8e8ed;font-size:14px;">
                          <a href="${APP_URL}/connections" style="color:#f0a830;text-decoration:none;font-weight:600;">Download your proxy agent</a>
                          <span style="color:#8888a0;"> from /connections — install it on your Oracle server for no-firewall access.</span>
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 0 16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:28px;height:28px;background:#f0a830;border-radius:50%;text-align:center;vertical-align:middle;">
                        <span style="color:#0a0a0c;font-size:13px;font-weight:700;">2</span>
                      </td>
                      <td style="padding-left:14px;vertical-align:middle;">
                        <span style="color:#e8e8ed;font-size:14px;">
                          <a href="${APP_URL}/docs" style="color:#f0a830;text-decoration:none;font-weight:600;">Follow the setup guide</a>
                          <span style="color:#8888a0;"> — takes about 5 minutes. Configure your connection, test the probe.</span>
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 0 8px;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:28px;height:28px;background:#f0a830;border-radius:50%;text-align:center;vertical-align:middle;">
                        <span style="color:#0a0a0c;font-size:13px;font-weight:700;">3</span>
                      </td>
                      <td style="padding-left:14px;vertical-align:middle;">
                        <span style="color:#e8e8ed;font-size:14px;">
                          <a href="${APP_URL}/dashboard" style="color:#f0a830;text-decoration:none;font-weight:600;">Start your first health check</a>
                          <span style="color:#8888a0;"> — 200+ checks across 15 categories, results in under 60 seconds.</span>
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Quick links -->
        ${isEbs ? `
        <tr>
          <td style="padding:16px 40px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
              ${ebsLink}
            </table>
          </td>
        </tr>` : ''}

        <!-- Divider -->
        <tr>
          <td style="padding:24px 40px 0;">
            <div style="height:1px;background:rgba(255,255,255,0.08);"></div>
          </td>
        </tr>

        <!-- Receipt -->
        <tr>
          <td style="padding:20px 40px 0;">
            <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#8888a0;text-transform:uppercase;letter-spacing:1px;">Payment reference</p>
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0d0d10;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                    ${paymentId ? `<tr>
                      <td style="font-size:13px;color:#8888a0;padding-bottom:8px;">Payment ID</td>
                      <td style="font-size:13px;color:#e8e8ed;text-align:right;padding-bottom:8px;font-family:monospace;">${paymentId}</td>
                    </tr>` : ''}
                    ${amountDisplay ? `<tr>
                      <td style="font-size:13px;color:#8888a0;padding-bottom:8px;">Amount</td>
                      <td style="font-size:13px;color:#e8e8ed;text-align:right;padding-bottom:8px;">${amountDisplay}</td>
                    </tr>` : ''}
                    ${dateDisplay ? `<tr>
                      <td style="font-size:13px;color:#8888a0;">Date</td>
                      <td style="font-size:13px;color:#e8e8ed;text-align:right;">${dateDisplay}</td>
                    </tr>` : ''}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:10px 0 0;font-size:12px;color:#555568;">
              Razorpay handles your tax invoice separately. Keep this payment ID for your records.
            </p>
          </td>
        </tr>

        <!-- CTA button -->
        <tr>
          <td style="padding:28px 40px;">
            <a href="${APP_URL}/dashboard"
               style="display:inline-block;background:linear-gradient(135deg,#f0a830,#d4891f);color:#0a0a0c;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;letter-spacing:0.3px;">
              Open Dashboard →
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:0 40px 36px;border-top:1px solid rgba(255,255,255,0.06);">
            <p style="margin:20px 0 0;font-size:12px;color:#555568;line-height:1.7;">
              Questions? Reply to this email or write to
              <a href="mailto:hello@tunevault.app" style="color:#f0a830;text-decoration:none;">hello@tunevault.app</a>.
              <br>
              TuneVault · Oracle Database Health Intelligence
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

// ─── REGISTER CONTACT ──────────────────────────────────────────────────────

async function registerContact(_email, _name) {
  // Resend audiences managed in dashboard; wire RESEND_AUDIENCE_ID here if needed.
}

// ─── SEND ──────────────────────────────────────────────────────────────────

/**
 * sendWelcomeEmail({ userEmail, userName, planTier, paymentId, amountPaise, date })
 *
 * Sends the post-payment welcome email. Retries once on failure.
 * Returns { sent: true } on success, { sent: false, error } on double failure.
 * Never throws — callers wrap in try/catch anyway but this is belt-and-suspenders.
 */
async function sendWelcomeEmail({ userEmail, userName, planTier, paymentId, amountPaise, date }) {
  if (!RESEND_API_KEY) {
    console.warn('[welcome-email] RESEND_API_KEY not set — skipping welcome email for', userEmail);
    return { sent: false, error: 'RESEND_API_KEY not configured' };
  }

  const plan      = PLAN_DISPLAY[planTier] || { label: planTier, checks: '?' };
  const subject   = `Welcome to TuneVault ${plan.label} — your Oracle agent is ready`;
  const plainText = `Hi ${userName || 'there'},\n\nYour TuneVault ${plan.label} plan is now active. You have ${plan.checks} health checks per month.\n\nNext steps:\n1. Download your proxy agent: ${APP_URL}/connections\n2. Follow the setup guide: ${APP_URL}/docs\n3. Start your first health check: ${APP_URL}/dashboard\n\nPayment ID: ${paymentId || '—'}\n\nQuestions? Reply to this email or write to hello@tunevault.app.\n\nTuneVault`;
  const html      = buildHtml({
    userName     : userName,
    planLabel    : plan.label,
    checksPerMonth: plan.checks,
    paymentId,
    amountPaise,
    date,
    isEbs        : planTier === 'scale' || planTier === 'custom' // EBS link for top-tier
  });

  // Register contact first (best-effort, non-blocking)
  await registerContact(userEmail, userName);

  // Attempt send with one retry
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${RESEND_API_URL}/emails`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({ from: FROM_ADDRESS, to: userEmail, subject, text: plainText, html })
      });

      if (res.ok) {
        console.log(`[welcome-email] sent to ${userEmail} (plan: ${planTier}, attempt: ${attempt})`);
        return { sent: true };
      }

      const errBody = await res.text().catch(() => '');
      const errMsg  = `HTTP ${res.status}: ${errBody}`;
      console.warn(`[welcome-email] attempt ${attempt} failed for ${userEmail}: ${errMsg}`);

      if (attempt === 2) {
        return { sent: false, error: errMsg };
      }

      // Brief pause before retry
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn(`[welcome-email] attempt ${attempt} threw for ${userEmail}: ${err.message}`);
      if (attempt === 2) {
        return { sent: false, error: err.message };
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Should not reach here
  return { sent: false, error: 'Unknown failure' };
}

module.exports = { sendWelcomeEmail };
