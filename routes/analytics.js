/**
 * routes/analytics.js — funnel event tracking + admin funnel dashboard.
 *
 * Owns: POST /api/ec (client-side event ingest, ad-blocker-safe path);
 *       POST /api/events (landing page CTA tracking — task #1619466);
 *       POST /api/analytics/event (legacy alias);
 *       GET /api/analytics/funnel-data (admin aggregation + UTM breakdown);
 *       GET /admin/funnel (serve HTML dashboard).
 * Does NOT own: billing, health check execution, user auth decisions.
 *
 * NOTE: /api/ec avoids ad-blocker EasyList patterns that block URLs containing
 *       "analytics", "track", or "capture". Both paths write identical records.
 *
 * GDPR: DNT header respected (skip DB write). IP truncated to /24 before storage.
 *
 * Mounted at: /api (see server.js)
 */

'use strict';

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const db = require('../db/analytics');

// ─── Rate limiter: 60 events/min per IP (generous for page_view + app events) ─
// Using default keyGenerator (express-rate-limit v8 handles IPv6 normalization internally).
// Previous custom `keyGenerator: (req) => req.ip` triggered ERR_ERL_KEY_GEN_IPV6 on every startup.
const ecLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false }),
  skip: () => process.env.NODE_ENV === 'test',
});

// All valid event names. Client-side posts are gated by this allowlist.
const ALLOWED_EVENTS = new Set([
  'page_view',
  'cta_click',
  'demo_started',
  'demo_completed',
  'signup_started',
  'signup_completed',
  'ai_analysis_viewed',
  'upgrade_modal_shown',
  'upgrade_modal_clicked',
  'pricing_roi_calculator_interact',
  'connection_added',
  'health_check_started',
  'health_check_completed',
  'first_check_started',
  'first_check_completed',
  'free_tier_limit_hit',
  'checkout_started',
  'checkout_succeeded',   // alias used by client; stored identically to checkout_completed
  'checkout_completed',
  'checkout_failed',
  'tunebot_query',
  'trial_drip_email_sent',
  'trial_drip_email_clicked',
  // Landing page CTA click events (DB-primary positioning rollout)
  'cta_try_demo',
  'cta_connect_db',
  'cta_ebs_report',
  'cta_sample_report',
  'cta_compare',
  'cta_health_check',
  'cta_explore_ebs',
  'cta_ebs_signup',
  'cta_pillars_compare',
  'cta_start_free',
  'cta_view_plan_team',
  'cta_view_plan_business',
  'cta_contact_us',
  'cta_see_full_pricing',
  'form_submit_health_check',
]);

// PII scrub: strip these keys from properties before storage
const PII_KEYS = new Set(['email', 'password', 'name', 'phone', 'address', 'ssn', 'cc', 'card']);

function scrubProps(props) {
  if (!props || typeof props !== 'object') return null;
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (!PII_KEYS.has(k.toLowerCase())) clean[k] = v;
  }
  return Object.keys(clean).length ? clean : null;
}

// Truncate IPv4 to /24, IPv6 to /48 for anonymisation
function truncateIp(ip) {
  if (!ip) return null;
  if (ip.includes(':')) {
    // IPv6 — keep first 3 groups (48 bits)
    return ip.split(':').slice(0, 3).join(':') + '::';
  }
  // IPv4
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.') + '.0';
}

// ─── POST /api/ec — client-side event ingest (ad-blocker-safe) ──────────────
// Responds 200 immediately; DB write is fire-and-forget.
// Body: { event, properties?, page_path?, referrer? }
async function handleEventPost(req, res) {
  // Honour Do Not Track
  if (req.headers.dnt === '1') {
    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });

  try {
    const { event, properties, page_path, referrer, plan, check_id, session_id: bodySessionId } = req.body || {};
    if (!event || !ALLOWED_EVENTS.has(event)) return;

    // session_id: prefer body (set via sessionStorage on public pages), fallback to cookie
    const sessionId = bodySessionId || req.cookies?.tv_sid || null;
    const userId    = req.user?.id || null;

    // Merge legacy plan/check_id fields into properties JSONB for backward compat
    const mergedProps = { ...(properties || {}) };
    if (plan) mergedProps.plan = plan;
    if (check_id) mergedProps.check_id = parseInt(check_id, 10) || null;

    // Normalise checkout_succeeded → checkout_completed (same funnel step)
    const eventName = event === 'checkout_succeeded' ? 'checkout_completed' : event;

    // SHA-256 hash of full IP — enables dedup without PII storage
    const rawIp = req.ip || '';
    const ipHash = rawIp ? crypto.createHash('sha256').update(rawIp).digest('hex') : null;

    await db.trackEvent({
      eventName,
      userId,
      sessionId,
      pagePath   : page_path || null,
      referrer   : referrer  || null,
      ip         : truncateIp(req.ip),
      ipHash,
      userAgent  : (req.headers['user-agent'] || '').slice(0, 500) || null,
      properties : scrubProps(mergedProps),
    });
  } catch { /* swallow — analytics never breaks UI */ }
}

router.post('/ec',              ecLimiter, handleEventPost);
router.post('/analytics/event', ecLimiter, handleEventPost); // backward compat alias
router.post('/events',          ecLimiter, handleEventPost); // task #1619466 — landing page CTA tracking

const { requireAdmin } = require('../middleware/auth');

// Ordered funnel steps for the dashboard visualisation
const FUNNEL_STEPS = [
  { key: 'page_view',                label: 'Page View' },
  { key: 'demo_started',             label: 'Demo Started' },
  { key: 'demo_completed',           label: 'Demo Completed' },
  { key: 'signup_started',           label: 'Signup Started' },
  { key: 'signup_completed',         label: 'Signup Completed' },
  { key: 'connection_added',         label: 'Connection Added' },
  { key: 'health_check_started',     label: 'Health Check Started' },
  { key: 'health_check_completed',   label: 'Health Check Completed' },
  { key: 'free_tier_limit_hit',      label: 'Free Tier Limit Hit' },
  { key: 'upgrade_modal_shown',      label: 'Upgrade Modal Shown' },
  { key: 'upgrade_modal_clicked',    label: 'Upgrade Modal Clicked' },
  { key: 'checkout_started',         label: 'Checkout Started' },
  { key: 'checkout_completed',       label: 'Paid' },
  { key: 'checkout_failed',          label: 'Checkout Failed' },
  { key: 'trial_drip_email_sent',    label: 'Drip Email Sent' },
  { key: 'trial_drip_email_clicked', label: 'Drip Email Clicked' },
];

// ─── GET /api/analytics/funnel-data — admin funnel aggregation ──────────────
router.get('/analytics/funnel-data', requireAdmin, async (req, res) => {
  try {
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59Z') : new Date();
    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00Z')
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default last 7 days per spec

    const [counts, recent, utmBreakdown, dailyVolume] = await Promise.all([
      db.getFunnelCounts({ from, to }),
      db.getRecentEvents(30),
      db.getUtmBreakdown({ from, to }),
      db.getDailyVolume({ from, to }),
    ]);

    const byKey  = Object.fromEntries(counts.map(r => [r.event_name, r]));

    const steps = FUNNEL_STEPS.map((step, idx) => {
      const row  = byKey[step.key] || { count: 0, unique_users: 0, unique_sessions: 0 };
      // Drop % computed against previous step only within core funnel (skip side metrics)
      const coreFunnel = ['page_view','signup_started','signup_completed','connection_added','health_check_started','health_check_completed','checkout_started','checkout_completed'];
      const prevKey = coreFunnel[coreFunnel.indexOf(step.key) - 1] || null;
      const prev = prevKey ? Number(byKey[prevKey]?.count || 0) : null;
      const curr = Number(row.count);
      return {
        key           : step.key,
        label         : step.label,
        count         : curr,
        unique_users  : Number(row.unique_users),
        unique_sessions: Number(row.unique_sessions),
        drop_pct      : prev && prev > 0 ? Math.round((1 - curr / prev) * 100) : null,
      };
    });

    res.json({ steps, recent, utmBreakdown, dailyVolume, from: from.toISOString(), to: to.toISOString() });
  } catch (err) {
    console.error('[analytics] funnel-data error:', err.message);
    res.status(500).json({ error: 'Failed to load funnel data' });
  }
});

module.exports = router;
