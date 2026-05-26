/**
 * routes/page-events.js — landing page CTA click tracking.
 *
 * Owns: POST /api/events (landing page CTA click/page_view ingest, no auth);
 *       GET /api/admin/analytics/events (admin daily counts by event_name).
 * Does NOT own: funnel analytics (analytics_events), billing, health checks.
 *
 * GDPR: DNT header respected. IP stored as SHA-256 hash only (no raw IP).
 *
 * Mounted at: /api (see server.js)
 */

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const router     = express.Router();

const pageDb = require('../db/page-events');

// ─── Rate limiter: 100 events/min per IP ────────────────────────────────────
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false }),
  skip: () => process.env.NODE_ENV === 'test',
});

// Valid event types
const VALID_EVENT_TYPES = new Set(['cta_click', 'page_view']);

// Valid event names (allowlist — client-supplied, non-PII)
const VALID_EVENT_NAMES = new Set([
  'hero_cta',
  'hero_cta_ebs',
  'hero_compare',
  'pricing_cta',
  'pricing_cta_individual',
  'pricing_cta_team',
  'pricing_cta_business',
  'pricing_cta_contact',
  'nav_signup',
  'nav_signin',
  'pillars_sample_report',
  'pillars_ebs_signup',
  'pillars_compare',
  'cta_start_free',
  'cta_try_demo',
  'cta_connect_db',
  'cta_ebs_report',
  'cta_sample_report',
  'cta_compare',
  'cta_health_check',
  'cta_explore_ebs',
  'cta_ebs_signup',
  'cta_pillars_compare',
  'cta_view_plan_team',
  'cta_view_plan_business',
  'cta_contact_us',
  'cta_see_full_pricing',
  'cta_security_audit',
  'cta_trust_center',
  'form_submit_health_check',
  'form_submit_contact',
]);

// ─── POST /api/events — landing page CTA tracking ────────────────────────────
router.post('/events', eventsLimiter, async (req, res) => {
  if (req.headers.dnt === '1') {
    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });

  try {
    const { event_type, event_name, page_url, referrer } = req.body || {};

    if (!event_type || !VALID_EVENT_TYPES.has(event_type)) return;
    if (!event_name || !VALID_EVENT_NAMES.has(event_name)) return;

    const rawIp    = req.ip || '';
    const ipHash   = rawIp ? crypto.createHash('sha256').update(rawIp).digest('hex') : null;
    const sessionId = req.cookies?.tv_sid || null;

    await pageDb.trackPageEvent({
      eventType : event_type,
      eventName : event_name,
      pageUrl   : page_url || null,
      referrer  : referrer || null,
      userAgent : (req.headers['user-agent'] || '').slice(0, 500) || null,
      ipHash,
      sessionId,
    });
  } catch { /* swallow — analytics never breaks UI */ }
});

const { requireAdmin } = require('../middleware/auth');

// ─── GET /api/admin/analytics/events — admin daily counts ───────────────────
router.get('/admin/analytics/events', requireAdmin, async (req, res) => {
  try {
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59Z') : new Date();
    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00Z')
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totals, daily] = await Promise.all([
      pageDb.getTotals({ from, to }),
      pageDb.getDailyCounts({ from, to }),
    ]);

    // Pivot daily: { date: { event_name: count, ... }, ... }
    const byDate = {};
    for (const row of daily) {
      const key = String(row.date);
      if (!byDate[key]) byDate[key] = {};
      byDate[key][row.event_name] = Number(row.count);
    }

    res.json({
      totals,
      daily      : byDate,
      date_range : { from: from.toISOString(), to: to.toISOString() },
    });
  } catch (err) {
    console.error('[page-events] admin endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to load event data' });
  }
});

module.exports = router;