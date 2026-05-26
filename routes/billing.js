/**
 * routes/billing.js — tier usage, billing summary, and enterprise inquiry endpoints.
 *
 * Owns: GET /usage (→ /api/billing/usage: current tier + live counters + caps),
 *       GET /free-usage (→ /api/billing/free-usage: free-tier HC remaining count for UI counters),
 *       GET /summary (→ /api/billing/summary: current plan card data for account hub),
 *       GET /payment-history (→ /api/billing/payment-history: last 12 payments for account hub),
 *       POST /cancel (→ /api/billing/cancel: schedule subscription cancellation at period end),
 *       POST /enterprise-inquiry (→ /api/billing/enterprise-inquiry: enterprise contact form).
 * Does NOT own: payment processing / checkout (routes/payments.js),
 *               billing page HTML (routes/settings.js), tier enforcement (middleware/tier-enforce.js).
 *
 * Mounted at: /api/billing (see server.js)
 */

'use strict';

const express = require('express');
const { requireAuth, ADMIN_EMAILS } = require('../middleware/auth');
const { resolveTier, getCaps } = require('../services/tier-limits');
const dbTierUsage = require('../db/tier-usage');
const dbPayments  = require('../db/payments');

const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

const router = express.Router();

// GET /api/billing/usage
// Returns the authenticated user's current tier, live usage counters, and per-cap limits.
// Consumed by /settings/billing to render usage bars and upgrade prompts.
//
// Response: { tier, plan_tier, is_admin, usage, caps, at_cap }
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
    const planTier = isAdmin ? 'custom' : await dbTierUsage.getUserPlanTier(req.user.id);
    const tier = resolveTier(planTier, isAdmin);
    const caps = getCaps(tier);

    const usage = await dbTierUsage.getUserUsageCounters(req.user.id);

    const atCap = {
      connections: caps.max_connections !== -1 && usage.connections >= caps.max_connections,
      team_members: caps.max_members !== -1 && usage.team_members >= caps.max_members,
      health_checks: caps.max_health_checks_per_month !== -1 &&
        usage.health_checks_this_month >= caps.max_health_checks_per_month,
    };

    return res.json({ tier, plan_tier: planTier, is_admin: isAdmin, usage, caps, at_cap: atCap });
  } catch (err) {
    console.error('[billing] GET /usage error:', err.message);
    return res.status(500).json({ error: 'Failed to load usage data' });
  }
});

// GET /api/billing/free-usage
// Returns free-tier health check usage for the authenticated user.
// Admins and paid users get { is_free_tier: false } — no counter shown.
// Free users get { hc_used, hc_limit: 5, hc_remaining, is_free_tier: true }.
// Read-only — does NOT consume quota. Used by UI to render the usage counter on Run buttons.
router.get('/free-usage', requireAuth, async (req, res) => {
  try {
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
    if (isAdmin) {
      return res.json({ is_free_tier: false });
    }
    const data = await dbTierUsage.getFreeHCUsage(req.user.email, req.user.id, req.user.company_domain);
    return res.json(data);
  } catch (err) {
    console.error('[billing] GET /free-usage error:', err.message);
    return res.status(500).json({ error: 'Failed to load free usage data' });
  }
});

// POST /api/billing/enterprise-inquiry
// Sends enterprise contact inquiry to support via Polsia email proxy.
// Body: { team_size: string, connections: string, notes?: string }
router.post('/enterprise-inquiry', requireAuth, async (req, res) => {
  try {
    const { team_size, connections, notes } = req.body;
    if (!team_size || !connections) {
      return res.status(400).json({ error: 'team_size and connections are required' });
    }

    const user = req.user;
    const emailBody = [
      `Enterprise inquiry from ${user.email}`,
      `Team size: ${team_size}`,
      `Oracle connections: ${connections}`,
      notes ? `Notes: ${notes}` : null,
    ].filter(Boolean).join('\n');

    if (POLSIA_API_KEY) {
      await fetch('https://api.polsia.com/v1/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${POLSIA_API_KEY}`,
        },
        body: JSON.stringify({
          to: 'support@tunevault.app',
          subject: `Enterprise inquiry — ${user.email}`,
          text: emailBody,
        }),
      });
    } else {
      // No proxy configured — log to Render stdout so ops can see the inquiry
      console.log('[billing] Enterprise inquiry (POLSIA_API_KEY not set):\n' + emailBody);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[billing] POST /enterprise-inquiry error:', err.message);
    return res.status(500).json({ error: 'Failed to send inquiry' });
  }
});

// ─── ACCOUNT HUB ENDPOINTS ─────────────────────────────────────────────────
// These power /settings/billing as a post-purchase account management page.

// GET /api/billing/summary
// Single-call hydration for the Current Plan card on /settings/billing.
// Response: { tier, plan_label, price_display, status, renews_at, scheduled_change,
//             scheduled_change_date, cancel_at_period_end, last_invoice, seats_used, seats_included }
// Returns { is_free: true } when the user has never paid — frontend redirects to /pricing.
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());

    // Apply any due scheduled changes lazily before reading state
    await dbPayments.applyDueScheduledChanges();

    const credits = await dbPayments.getUserCredits(req.user.id);

    // Free/no-credits users get bounced to /pricing by the frontend
    if (!isAdmin && (!credits || credits.plan_tier === 'free')) {
      return res.json({ is_free: true });
    }

    const planTier = isAdmin ? 'custom' : (credits.plan_tier || 'free');

    // Subscription gives renewal date; may be null for one-time-payment customers
    const sub = await dbPayments.getActiveSubscriptionByUserId(req.user.id);
    const renewsAt = sub && sub.current_period_end
      ? sub.current_period_end
      : (credits && credits.period_end ? credits.period_end : null);

    // Last invoice = most recent captured payment
    const payments = await dbPayments.getPaymentsByUserId(req.user.id, 1);
    const lastInvoice = payments.length > 0 && payments[0].status === 'captured'
      ? { amount_cents: payments[0].amount_paise, date: payments[0].created_at, plan_tier: payments[0].plan_tier }
      : null;

    // Seats: use tier usage counters
    const usage = await dbTierUsage.getUserUsageCounters(req.user.id);
    const tier  = resolveTier(planTier, isAdmin);
    const caps  = getCaps(tier);

    // Human-readable price line
    const PRICE_DISPLAY = {
      individual: '$49/conn/mo',
      team:       '$39/conn/mo + $29/seat/mo',
      business:   '$29/conn/mo + $19/seat/mo',
      enterprise: '$19/conn/mo — unlimited users',
      custom:     'Custom'
    };

    // Status string: Active | Cancels on <date> | Downgrades to X on <date>
    let status = 'Active';
    if (credits && credits.cancel_at_period_end && renewsAt) {
      status = 'Cancels on ' + new Date(renewsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } else if (credits && credits.scheduled_plan_change && credits.scheduled_plan_change_date) {
      const d = new Date(credits.scheduled_plan_change_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const changeLabel = credits.scheduled_plan_change.charAt(0).toUpperCase() + credits.scheduled_plan_change.slice(1);
      status = 'Downgrades to ' + changeLabel + ' on ' + d;
    }

    return res.json({
      is_free              : false,
      tier                 : planTier,
      plan_label           : planTier.charAt(0).toUpperCase() + planTier.slice(1),
      price_display        : PRICE_DISPLAY[planTier] || planTier,
      status,
      renews_at            : renewsAt,
      scheduled_change     : (credits && credits.scheduled_plan_change) || null,
      scheduled_change_date: (credits && credits.scheduled_plan_change_date) || null,
      cancel_at_period_end : !!(credits && credits.cancel_at_period_end),
      last_invoice         : lastInvoice,
      seats_used           : usage.connections || 0,
      seats_included       : caps.max_connections === -1 ? null : caps.max_connections,
      members_used         : usage.team_members || 0,
      members_included     : caps.max_members === -1 ? null : caps.max_members,
    });
  } catch (err) {
    console.error('[billing] GET /summary error:', err.message);
    return res.status(500).json({ error: 'Failed to load billing summary' });
  }
});

// GET /api/billing/payment-history
// Last 12 captured payments for the account hub payment history table.
// Response: [ { date, description, amount_cents, status, razorpay_payment_id } ]
router.get('/payment-history', requireAuth, async (req, res) => {
  try {
    const payments = await dbPayments.getPaymentsByUserId(req.user.id, 12);
    const rows = payments.map(function(p) {
      const tierLabel = p.plan_tier
        ? (p.plan_tier.charAt(0).toUpperCase() + p.plan_tier.slice(1))
        : 'Unknown';
      const period = p.billing_period === 'annual' ? 'annual' : 'monthly';
      return {
        date              : p.created_at,
        description       : tierLabel + ' plan — ' + period,
        amount_cents      : p.amount_paise || 0,
        status            : p.status,
        razorpay_payment_id: p.razorpay_payment_id || null,
        // Razorpay does not expose hosted invoice URLs through our checkout-mode
        // integration; link to Razorpay payment page for operators if payment_id is available.
        receipt_url       : p.razorpay_payment_id
          ? 'https://dashboard.razorpay.com/app/payments/' + p.razorpay_payment_id
          : null,
      };
    });
    return res.json(rows);
  } catch (err) {
    console.error('[billing] GET /payment-history error:', err.message);
    return res.status(500).json({ error: 'Failed to load payment history' });
  }
});

// POST /api/billing/cancel
// Schedules cancellation at end of current billing period.
// No Razorpay call needed — sets cancel_at_period_end via scheduleDowngrade().
// Response: { ok: true, effective_date }
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const credits = await dbPayments.getUserCredits(req.user.id);
    if (!credits || credits.plan_tier === 'free') {
      return res.status(400).json({ error: 'No active paid plan to cancel' });
    }
    if (credits.cancel_at_period_end) {
      return res.status(400).json({ error: 'Subscription is already scheduled for cancellation' });
    }

    const effectiveDate = credits.period_end
      ? new Date(credits.period_end)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await dbPayments.scheduleDowngrade({
      userId           : req.user.id,
      targetTier       : 'free',
      effectiveDate,
      cancelAtPeriodEnd: true
    });

    await dbPayments.logReconciliation({
      eventType   : 'cancel_scheduled_via_billing',
      userId      : req.user.id,
      planTier    : 'free',
      failureStage: null,
      errorMessage: null,
      metadata    : { current_tier: credits.plan_tier, effective_date: effectiveDate.toISOString() }
    });

    return res.json({ ok: true, effective_date: effectiveDate.toISOString() });
  } catch (err) {
    console.error('[billing] POST /cancel error:', err.message);
    return res.status(500).json({ error: 'Failed to schedule cancellation' });
  }
});

module.exports = router;
