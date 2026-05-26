/**
 * routes/drip.js — drip email unsubscribe endpoint.
 *
 * Owns: GET /drip/unsubscribe — marks user as suppressed from all future drip mail.
 * Does NOT own: email sending, cron scheduling, or transactional emails (those always fire).
 *
 * Token format: base64url(userId) — simple, no HMAC needed (worst abuse = unsub someone else).
 */

'use strict';

const express = require('express');
const router  = express.Router();
const emailDripDb = require('../db/email-drip');
const dbAnalytics = require('../db/analytics');

// GET /drip/click?t=<userId_base64url>&step=<1-3>&dest=<url>
// Records a drip email click and redirects to the destination.
// Used to instrument link clicks from drip email body CTAs.
router.get('/click', async (req, res) => {
  const { t, step, dest } = req.query;
  const safeDest = dest && dest.startsWith('/') ? dest : '/dashboard';

  // Fire-and-forget analytics — never block the redirect
  if (t) {
    try {
      const userId = parseInt(Buffer.from(t, 'base64url').toString(), 10);
      if (userId && !isNaN(userId)) {
        dbAnalytics.trackEvent({
          eventName: 'trial_drip_email_clicked',
          userId,
          properties: { step: step ? parseInt(step, 10) : null, dest: safeDest },
        }).catch(() => {});
      }
    } catch { /* ignore bad token */ }
  }

  res.redirect(safeDest);
});

// GET /drip/unsubscribe?t=<token>
router.get('/unsubscribe', async (req, res) => {
  const { t } = req.query;

  if (!t) {
    return res.status(400).send(unsubPage('Invalid link', 'Missing unsubscribe token. Check your email for the correct link.'));
  }

  let userId;
  try {
    userId = parseInt(Buffer.from(t, 'base64url').toString(), 10);
    if (!userId || isNaN(userId)) throw new Error('bad userId');
  } catch {
    return res.status(400).send(unsubPage('Invalid link', 'This unsubscribe link is malformed. Reply to the email to opt out manually.'));
  }

  try {
    const user = await emailDripDb.getUserById(userId);
    if (!user) {
      // Don't leak whether a user exists — just confirm suppression
      return res.send(unsubPage('Unsubscribed', 'You\'ve been removed from TuneVault setup emails.'));
    }

    await emailDripDb.suppressUser(userId, 'unsubscribed');

    return res.send(unsubPage('Unsubscribed', `${user.email} has been removed from TuneVault setup emails. You'll still receive receipts and security alerts.`));
  } catch (err) {
    console.error('[drip-unsub] error suppressing user', userId, err.message);
    return res.status(500).send(unsubPage('Error', 'Something went wrong. Reply to any TuneVault email to opt out manually.'));
  }
});

// ─── PAGE TEMPLATE ────────────────────────────────────────────────────────────

function unsubPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — TuneVault</title>
<style>
  body { margin:0; padding:0; background:#0a0a0c; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#e8e8ed; }
  .wrap { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:24px; }
  .card { background:#111114; border:1px solid rgba(240,168,48,0.18); border-radius:12px; padding:48px 40px; max-width:480px; text-align:center; }
  .logo { font-size:22px; font-weight:700; color:#f0a830; letter-spacing:-0.5px; margin-bottom:24px; }
  h1 { font-size:20px; font-weight:700; color:#e8e8ed; margin:0 0 12px; }
  p { font-size:14px; color:#8888a0; line-height:1.7; margin:0 0 24px; }
  a { color:#f0a830; text-decoration:none; font-size:13px; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="logo">TuneVault</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <a href="/">← Back to TuneVault</a>
    </div>
  </div>
</body>
</html>`;
}

module.exports = router;
