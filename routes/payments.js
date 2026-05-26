/**
 * routes/payments.js — Razorpay payment and subscription endpoints.
 *
 * Owns: order creation, payment verification, subscription creation,
 *       webhook handling, user credit queries.
 * Does NOT own: Oracle connections, health check execution, user auth.
 *
 * Mounted at: /api (see server.js)
 */

'use strict';

const express  = require('express');
const crypto   = require('crypto');
const Razorpay = require('razorpay');

const db                 = require('../db/payments');
const dbAnalytics        = require('../db/analytics');
const { sendWelcomeEmail } = require('../services/welcome-email');
// Canonical pricing config — single source of truth for all plan prices
const pricingConfig      = require('../config/pricing');

const { requireAuth } = require('../middleware/auth');
// Admin alert address — receives reconciliation failure alerts
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'hello@tunevault.app';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

const router = express.Router();

// ─── CONFIG ────────────────────────────────────────────────────────────────

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const ADMIN_EMAIL         = 'kirankumar.ale@gmail.com';

// Razorpay INR-only accounts reject orders with currency: 'USD' (HTTP 406).
// Convert USD cents → INR paise using a fixed rate. Override via env var when
// the RBI reference rate drifts. Customers see INR at checkout; international
// cards auto-convert back at their bank's rate.
const USD_TO_INR_RATE = parseFloat(process.env.USD_TO_INR_RATE) || 85;

/**
 * Convert USD cents to INR paise for Razorpay order creation.
 * 1 USD cent = (USD_TO_INR_RATE) INR paise. E.g. 4900 cents ($49) × 85 = 416500 paise (₹4,165).
 */
function usdCentsToInrPaise(usdCents) {
  return Math.round(usdCents * USD_TO_INR_RATE);
}

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('[payments] RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set — payment routes will return 503');
} else {
  // Log key prefix on startup — lets operators confirm which credentials are loaded without exposing the secret
  console.log(`[payments] Razorpay key loaded: ${RAZORPAY_KEY_ID.slice(0, 16)}... (${RAZORPAY_KEY_ID.startsWith('rzp_live') ? 'LIVE' : 'TEST'} mode, INR rate=${USD_TO_INR_RATE})`);
}

function getRazorpayClient() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}


// ─── HELPERS ───────────────────────────────────────────────────────────────

function verifyRazorpaySignature({ orderId, paymentId, signature }) {
  const body   = `${orderId}|${paymentId}`;
  const digest = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
  return digest === signature;
}

function verifyWebhookSignature(rawBody, signature) {
  const digest = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(rawBody).digest('hex');
  return digest === signature;
}

// Credit a user after confirmed payment.
// For unlimited plans (scale/custom) getPlanChecks returns -1; upsertUserCredits stores UNLIMITED_SENTINEL.
async function creditUser({ userId, planTier, billingPeriod, subscriptionId }) {
  const checks    = db.getPlanChecks(planTier);
  const now       = new Date();
  const periodEnd = new Date(now);
  billingPeriod === 'annual'
    ? periodEnd.setFullYear(periodEnd.getFullYear() + 1)
    : periodEnd.setMonth(periodEnd.getMonth() + 1);

  return db.upsertUserCredits({
    userId,
    planTier,
    checksTotal : checks,   // -1 for unlimited; upsertUserCredits converts to sentinel
    subscriptionId,
    periodStart : now,
    periodEnd
  });
}

// ─── activatePlan ──────────────────────────────────────────────────────────
// Single entry point for: creditUser → welcome email → reconciliation on error.
// Call this from every confirmed-payment path (verify-payment, verify-subscription,
// webhook handlers). Reconciliation and email failures are caught internally —
// this function throws only if creditUser itself fails (DB error), because the
// plan unlock is the critical step that must surface to the caller.
async function activatePlan({ userId, planTier, billingPeriod, subscriptionId, razorpayPaymentId, razorpayOrderId, amountPaise, eventType }) {
  // Step 1: plan unlock — this can throw, let it propagate so caller can log + reconcile
  await creditUser({ userId, planTier, billingPeriod, subscriptionId });

  // Step 2: fire welcome email (after DB commit, non-blocking on failure)
  try {
    const user   = await db.getUserById(userId);
    const result = user
      ? await sendWelcomeEmail({
          userEmail  : user.email,
          userName   : user.name,
          planTier,
          paymentId  : razorpayPaymentId,
          amountPaise: amountPaise || null,
          date       : new Date()
        })
      : { sent: false, error: 'User not found for welcome email' };

    if (!result.sent) {
      // Log email failure for manual review — plan is already unlocked
      console.error(`[payments] welcome email failed for user ${userId} (${user?.email || 'unknown'}): ${result.error}`);
      await db.logReconciliation({
        eventType,
        razorpayPaymentId,
        razorpayOrderId,
        userId,
        userEmail  : user?.email,
        planTier,
        failureStage: 'welcome_email',
        errorMessage: result.error
      });

      // Best-effort admin alert via email proxy
      if (POLSIA_API_KEY) {
        fetch('https://polsia.com/api/proxy/email/send', {
          method : 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POLSIA_API_KEY}` },
          body   : JSON.stringify({
            to     : ALERT_EMAIL,
            subject: `[TuneVault] Welcome email failed — ${user?.email || userId}`,
            body   : `Welcome email failed for user ${userId} (${user?.email || 'unknown'}) on plan ${planTier}.\n\nPayment: ${razorpayPaymentId || razorpayOrderId || '—'}\nError: ${result.error}\n\nPlan was unlocked successfully. Check payment_reconciliation table.`
          })
        }).catch(() => {}); // fire-and-forget
      }
    }
  } catch (emailErr) {
    // Email step must never block the plan unlock confirmation
    console.error(`[payments] welcome email step threw for user ${userId}:`, emailErr.message);
    await db.logReconciliation({
      eventType,
      razorpayPaymentId,
      razorpayOrderId,
      userId,
      planTier,
      failureStage: 'welcome_email_threw',
      errorMessage: emailErr.message
    });
  }
}

// ─── PUBLIC: GET /api/razorpay-key ─────────────────────────────────────────
// Frontend needs the key ID to init Razorpay checkout; never expose secret.

router.get('/razorpay-key', (req, res) => {
  if (!RAZORPAY_KEY_ID) return res.status(503).json({ error: 'Payments not configured' });
  res.json({ key_id: RAZORPAY_KEY_ID });
});

// ─── PUBLIC: GET /api/payments/pricing ─────────────────────────────────────
// Returns canonical pricing data for all tiers × billing periods.
// Frontend fetches this to display prices and pre-validate checkout amounts.
// No auth required — prices are public.

router.get('/payments/pricing', (req, res) => {
  res.json(pricingConfig.getPricingSummary());
});

// ─── PUBLIC: GET /api/user-credits ─────────────────────────────────────────

router.get('/user-credits', requireAuth, async (req, res) => {
  try {
    const credits = await db.getUserCredits(req.user.id);
    // Admin bypass: unlimited
    if (req.user.email === ADMIN_EMAIL) {
      return res.json({ plan_tier: 'custom', checks_remaining: 999999, checks_total: 999999 });
    }
    if (!credits) {
      return res.json({ plan_tier: 'free', checks_remaining: db.PLAN_CHECKS.free, checks_total: db.PLAN_CHECKS.free });
    }
    res.json(credits);
  } catch (err) {
    console.error('[payments] GET /user-credits error:', err.message);
    res.status(500).json({ error: 'Failed to fetch credits' });
  }
});

// ─── POST /api/create-order ────────────────────────────────────────────────
// Creates a Razorpay order for one-time payment.
// Body: { plan_tier, billing_period?, connection_count?, seat_count? }
// Supports legacy flat tiers (starter/growth/scale/custom) and
// new per-connection tiers (individual/team/business).

// Razorpay USD accounts have a per-transaction ceiling; guard against orders
// that would breach it. $49,900 is a conservative safe cap well below limits.
const MAX_ORDER_CENTS = 4990000; // $49,900 in cents

router.post('/create-order', requireAuth, async (req, res) => {
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Payments not configured' });

  const { plan_tier, billing_period = 'monthly', connection_count, seat_count } = req.body;

  const PER_CONN_TIERS   = ['individual', 'team', 'business', 'enterprise'];
  const LEGACY_TIERS     = ['starter', 'growth', 'scale', 'custom'];
  const isPerConn        = PER_CONN_TIERS.includes(plan_tier);
  const isLegacy         = LEGACY_TIERS.includes(plan_tier);

  if (!isPerConn && !isLegacy) {
    return res.status(400).json({ error: 'Invalid plan_tier' });
  }

  // Guard: already on a paid plan — prevent double-charge
  const existing = await db.getUserCredits(req.user.id);
  if (existing && existing.plan_tier !== 'free' && existing.checks_remaining > 0) {
    const paidTiers = ['starter','growth','scale','custom','individual','team','business','enterprise'];
    if (paidTiers.includes(existing.plan_tier)) {
      return res.status(400).json({ error: 'You already have an active plan. To change plans, contact hello@tunevault.app.' });
    }
  }

  let amountCents, orderDescription;

  if (isPerConn) {
    // New per-connection pricing
    const result = db.calcPerConnAmount(plan_tier, billing_period, connection_count, seat_count);
    if (!result || result.amount < 100) {
      return res.status(400).json({ error: 'Invalid amount — check connection_count and seat_count' });
    }
    amountCents = result.amount;
    orderDescription = result.description;
  } else {
    // Legacy flat pricing
    amountCents = db.getPlanPricePaise(plan_tier, billing_period);
    if (!amountCents || amountCents < 100) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    orderDescription = `TuneVault ${plan_tier} — ${billing_period}`;
  }

  // Guard: amount ceiling — prevents "Amount exceeds maximum" from Razorpay
  // (triggered by high connection counts on annual billing)
  if (amountCents > MAX_ORDER_CENTS) {
    return res.status(400).json({
      error: `Order total ($${(amountCents / 100).toFixed(0)}) exceeds the per-transaction limit. For large fleet orders please contact hello@tunevault.app.`
    });
  }

  // Guard: cross-check computed amount against canonical pricing config.
  // The backend owns the price; this rejects any scenario where an internal
  // misconfiguration causes the computed amount to deviate from the canonical rate.
  // For per-conn tiers: verify amount equals calcPerConnAmount result (idempotent — same function).
  // For multi-connection orders: verify per-connection rate matches config.
  if (isPerConn) {
    const canonicalRates = pricingConfig.CONN_PRICES[plan_tier];
    if (!canonicalRates) {
      return res.status(400).json({ error: 'Unrecognised plan tier — contact support.' });
    }
    // Verify the computed per-connection rate matches the canonical config.
    // This catches drift between calcPerConnAmount and CONN_PRICES (should never happen
    // since they now share config/pricing.js, but this guard stays as belt-and-suspenders).
    const connCount  = Math.max(1, Math.min(200, parseInt(connection_count) || 1));
    const seatCount_ = Math.max(0, Math.min(100, parseInt(seat_count) || 0));
    const volDisc = (plan_tier === 'enterprise') ? pricingConfig.enterpriseVolumeDiscount(connCount) : 0;
    const baseMonthly = (canonicalRates.conn * connCount) + (canonicalRates.seat * seatCount_);
    // Round to nearest whole dollar (×100) to match frontend which rounds in dollar space
    const expectedMonthly = volDisc > 0
      ? Math.round(baseMonthly * (1 - volDisc) / 100) * 100
      : baseMonthly;
    const expectedAmount  = billing_period === 'annual'
      ? Math.round(expectedMonthly * 12 * pricingConfig.ANNUAL_DISCOUNT)
      : expectedMonthly;
    if (Math.abs(amountCents - expectedAmount) > 1) {
      console.error(`[payments] create-order amount mismatch: computed=${amountCents}, expected=${expectedAmount}, tier=${plan_tier}, billing=${billing_period}`);
      return res.status(400).json({ error: 'Order amount does not match the canonical price. Please refresh the page and try again.' });
    }
  }

  try {
    // Razorpay live account is INR-only — convert USD cents to INR paise
    const amountInrPaise = usdCentsToInrPaise(amountCents);

    const order = await rzp.orders.create({
      amount  : amountInrPaise,
      currency: 'INR',
      notes   : {
        plan_tier,
        billing_period,
        user_id         : String(req.user.id),
        connection_count: String(connection_count || 1),
        seat_count      : String(seat_count || 0),
        usd_amount_cents: String(amountCents)  // preserve USD amount for reconciliation
      }
    });

    await db.createPaymentRecord({
      userId         : req.user.id,
      razorpayOrderId: order.id,
      amountPaise    : amountInrPaise,
      currency       : 'INR',
      planTier       : plan_tier,
      paymentType    : 'one_time',
      billingPeriod  : billing_period
    });

    dbAnalytics.trackEvent({
      eventName: 'checkout_started',
      userId: req.user.id,
      sessionId: req.cookies?.tv_sid || null,
      properties: { plan_tier, billing_period, amount_cents: amountCents, amount_inr_paise: amountInrPaise },
    }).catch(() => {});

    res.json({ order_id: order.id, amount: amountInrPaise, currency: 'INR', usd_amount_cents: amountCents, description: orderDescription });
  } catch (err) {
    // Razorpay SDK errors use err.error.description, not err.message
    const razorpayDesc = err?.error?.description;
    const errMsg = razorpayDesc || err.message || 'Unknown error';
    const httpCode = err?.statusCode;
    console.error('[payments] create-order error:', errMsg, httpCode ? `(HTTP ${httpCode})` : '');

    // Return specific user-facing messages based on the failure type
    let userMsg = 'Failed to create order. Please try again.';
    if (httpCode === 401 || razorpayDesc === 'Authentication failed') {
      userMsg = 'Payment service is temporarily unavailable (configuration issue). Our team has been notified — please try again shortly.';
    } else if (razorpayDesc && /amount.*exceeds.*maximum/i.test(razorpayDesc)) {
      // Razorpay per-transaction ceiling hit — guide user to contact sales for large orders
      userMsg = 'This order amount exceeds the online payment limit. For large fleet orders, please contact hello@tunevault.app and we\'ll set up invoiced billing.';
    } else if (httpCode === 400) {
      userMsg = 'Invalid payment request. Please refresh and try again.';
    } else if (httpCode === 406) {
      // Razorpay INR-only account rejecting unsupported currency
      userMsg = 'Payment service configuration error. Our team has been notified — please try again shortly.';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      userMsg = 'Cannot reach payment service. Please check your connection and try again.';
    }
    res.status(500).json({ error: userMsg });
  }
});

// ─── POST /api/verify-payment ──────────────────────────────────────────────
// Verifies Razorpay HMAC signature after checkout success.
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }

router.post('/verify-payment', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!verifyRazorpaySignature({
    orderId   : razorpay_order_id,
    paymentId : razorpay_payment_id,
    signature : razorpay_signature
  })) {
    return res.status(400).json({ error: 'Signature mismatch — payment not verified' });
  }

  try {
    const payment = await db.markPaymentCaptured({
      razorpayOrderId   : razorpay_order_id,
      razorpayPaymentId : razorpay_payment_id,
      razorpaySignature : razorpay_signature
    });

    if (!payment) return res.status(404).json({ error: 'Order not found' });

    try {
      await activatePlan({
        userId             : payment.user_id,
        planTier           : payment.plan_tier,
        billingPeriod      : payment.billing_period,
        razorpayPaymentId  : razorpay_payment_id,
        razorpayOrderId    : razorpay_order_id,
        amountPaise        : payment.amount_paise,
        eventType          : 'verify_payment'
      });
    } catch (activateErr) {
      // creditUser failed — log to reconciliation, respond 500 so frontend can retry
      console.error('[payments] verify-payment activate error:', activateErr.message);
      await db.logReconciliation({
        eventType         : 'verify_payment',
        razorpayPaymentId : razorpay_payment_id,
        razorpayOrderId   : razorpay_order_id,
        userId            : payment.user_id,
        planTier          : payment.plan_tier,
        failureStage      : 'credit_user',
        errorMessage      : activateErr.message
      });
      return res.status(500).json({ error: 'Plan activation failed — our team has been notified. Please contact hello@tunevault.app.' });
    }

    dbAnalytics.trackEvent({
      eventName: 'checkout_completed',
      userId: payment.user_id,
      sessionId: req.cookies?.tv_sid || null,
      properties: { plan_tier: payment.plan_tier, billing_period: payment.billing_period, amount_cents: payment.amount_paise },
    }).catch(() => {});

    res.json({ success: true, plan_tier: payment.plan_tier });
  } catch (err) {
    console.error('[payments] verify-payment error:', err.message);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// ─── POST /api/create-subscription ────────────────────────────────────────
// Creates a Razorpay plan + subscription for recurring billing.
// Body: { plan_tier, billing_period? }

router.post('/create-subscription', requireAuth, async (req, res) => {
  const rzp = getRazorpayClient();
  if (!rzp) return res.status(503).json({ error: 'Payments not configured' });

  const { plan_tier, billing_period = 'monthly' } = req.body;
  if (!['starter', 'growth', 'scale', 'custom'].includes(plan_tier)) {
    return res.status(400).json({ error: 'Invalid plan_tier' });
  }

  const amountCents = db.getPlanPricePaise(plan_tier, billing_period);
  if (!amountCents) return res.status(400).json({ error: 'Invalid plan amount' });

  try {
    // Create a plan (idempotent: Razorpay deduplicates by interval+amount within account)
    // Razorpay live account is INR-only — convert USD cents to INR paise
    const amountInrPaise = usdCentsToInrPaise(amountCents);
    const interval = billing_period === 'annual' ? 12 : 1;
    const plan = await rzp.plans.create({
      period   : 'monthly',
      interval,
      item: {
        name  : `TuneVault ${plan_tier} (${billing_period})`,
        amount: amountInrPaise,
        unit_amount: amountInrPaise,
        currency: 'INR'
      },
      notes: { plan_tier, billing_period, usd_amount_cents: String(amountCents) }
    });

    const subscription = await rzp.subscriptions.create({
      plan_id           : plan.id,
      total_count       : billing_period === 'annual' ? 10 : 120, // up to 10 years
      quantity          : 1,
      customer_notify   : 1,
      notes             : { plan_tier, billing_period, user_id: String(req.user.id) }
    });

    await db.createSubscriptionRecord({
      userId                 : req.user.id,
      razorpaySubscriptionId : subscription.id,
      razorpayPlanId         : plan.id,
      planTier               : plan_tier,
      billingPeriod          : billing_period
    });

    res.json({ subscription_id: subscription.id, plan_tier });
  } catch (err) {
    // Razorpay SDK errors use err.error.description, not err.message
    const razorpayDesc = err?.error?.description;
    const errMsg = razorpayDesc || err.message || 'Unknown error';
    const httpCode = err?.statusCode;
    console.error('[payments] create-subscription error:', errMsg, httpCode ? `(HTTP ${httpCode})` : '');

    // Return specific user-facing messages based on the failure type
    let userMsg = 'Failed to create subscription. Please try again.';
    if (httpCode === 401 || razorpayDesc === 'Authentication failed') {
      userMsg = 'Payment service is temporarily unavailable (configuration issue). Our team has been notified — please try again shortly.';
    } else if (httpCode === 400) {
      userMsg = 'Invalid subscription request. Please refresh and try again.';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      userMsg = 'Cannot reach payment service. Please check your connection and try again.';
    }
    res.status(500).json({ error: userMsg });
  }
});

// ─── POST /api/verify-subscription ────────────────────────────────────────
// Called after Razorpay subscription checkout completes.
// Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }

router.post('/verify-subscription', requireAuth, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Razorpay subscription signature: payment_id|subscription_id
  const body   = `${razorpay_payment_id}|${razorpay_subscription_id}`;
  const digest = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
  if (digest !== razorpay_signature) {
    return res.status(400).json({ error: 'Signature mismatch' });
  }

  try {
    const sub = await db.getSubscriptionByRazorpayId(razorpay_subscription_id);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    await db.updateSubscriptionStatus({
      razorpaySubscriptionId: razorpay_subscription_id,
      status: 'authenticated',
      periodStart: new Date(),
    });

    try {
      await activatePlan({
        userId             : sub.user_id,
        planTier           : sub.plan_tier,
        billingPeriod      : sub.billing_period,
        subscriptionId     : sub.id,
        razorpayPaymentId  : razorpay_payment_id,
        eventType          : 'verify_subscription'
      });
    } catch (activateErr) {
      console.error('[payments] verify-subscription activate error:', activateErr.message);
      await db.logReconciliation({
        eventType          : 'verify_subscription',
        razorpayPaymentId  : razorpay_payment_id,
        userId             : sub.user_id,
        planTier           : sub.plan_tier,
        failureStage       : 'credit_user',
        errorMessage       : activateErr.message
      });
      return res.status(500).json({ error: 'Plan activation failed — our team has been notified. Please contact hello@tunevault.app.' });
    }

    res.json({ success: true, plan_tier: sub.plan_tier });
  } catch (err) {
    console.error('[payments] verify-subscription error:', err.message);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
});

// ─── POST /api/razorpay-webhook ────────────────────────────────────────────
// Handles async Razorpay events. Raw body required for HMAC verification.
// Events handled: payment.captured, subscription.charged, subscription.cancelled

router.post('/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return res.status(400).json({ error: 'Missing signature header' });

  if (!verifyWebhookSignature(req.body, signature)) {
    return res.status(400).json({ error: 'Webhook signature mismatch' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event.event;
  const payload   = event.payload;

  try {
    // payment.captured — idempotent via payment_id dedup key
    if (eventType === 'payment.captured') {
      const payment = payload?.payment?.entity;
      if (payment?.order_id) {
        const existingPayment = await db.getPaymentByOrderId(payment.order_id);
        // Dedup: only process if not already captured (payment_id is the dedup key)
        if (existingPayment && existingPayment.status !== 'captured') {
          await db.markPaymentCaptured({
            razorpayOrderId  : payment.order_id,
            razorpayPaymentId: payment.id,
            razorpaySignature: '' // webhook-sourced — no client signature
          });
          await activatePlan({
            userId            : existingPayment.user_id,
            planTier          : existingPayment.plan_tier,
            billingPeriod     : existingPayment.billing_period,
            razorpayPaymentId : payment.id,
            razorpayOrderId   : payment.order_id,
            amountPaise       : existingPayment.amount_paise,
            eventType         : 'webhook_payment_captured'
          });
        }
      }
    }

    // subscription.charged — renewal cycle crediting
    if (eventType === 'subscription.charged') {
      const sub     = payload?.subscription?.entity;
      const payment = payload?.payment?.entity;
      if (sub?.id) {
        const subRecord = await db.getSubscriptionByRazorpayId(sub.id);
        if (subRecord) {
          const periodStart = sub.current_start ? new Date(sub.current_start * 1000) : new Date();
          const periodEnd   = sub.current_end   ? new Date(sub.current_end   * 1000) : null;
          await db.updateSubscriptionStatus({
            razorpaySubscriptionId: sub.id,
            status: 'active',
            periodStart,
            periodEnd
          });
          await activatePlan({
            userId            : subRecord.user_id,
            planTier          : subRecord.plan_tier,
            billingPeriod     : subRecord.billing_period,
            subscriptionId    : subRecord.id,
            razorpayPaymentId : payment?.id,
            eventType         : 'webhook_subscription_charged'
          });
        }
      }
    }

    if (eventType === 'subscription.cancelled') {
      const sub = payload?.subscription?.entity;
      if (sub?.id) {
        await db.updateSubscriptionStatus({
          razorpaySubscriptionId: sub.id,
          status     : 'cancelled',
          cancelledAt: new Date()
        });
      }
    }

    // subscription.activated — first activation, credit + welcome email
    if (eventType === 'subscription.activated') {
      const sub = payload?.subscription?.entity;
      if (sub?.id) {
        const subRecord = await db.getSubscriptionByRazorpayId(sub.id);
        if (subRecord) {
          const periodStart = sub.current_start ? new Date(sub.current_start * 1000) : new Date();
          const periodEnd   = sub.current_end   ? new Date(sub.current_end   * 1000) : null;
          await db.updateSubscriptionStatus({
            razorpaySubscriptionId: sub.id,
            status: 'active',
            periodStart,
            periodEnd
          });
          await activatePlan({
            userId         : subRecord.user_id,
            planTier       : subRecord.plan_tier,
            billingPeriod  : subRecord.billing_period,
            subscriptionId : subRecord.id,
            eventType      : 'webhook_subscription_activated'
          });
        }
      }
    }

    if (eventType === 'subscription.paused') {
      const sub = payload?.subscription?.entity;
      if (sub?.id) {
        await db.updateSubscriptionStatus({
          razorpaySubscriptionId: sub.id,
          status: 'paused'
        });
      }
    }

    // subscription.resumed — re-credit on resume
    if (eventType === 'subscription.resumed') {
      const sub = payload?.subscription?.entity;
      if (sub?.id) {
        const subRecord = await db.getSubscriptionByRazorpayId(sub.id);
        if (subRecord) {
          const periodStart = sub.current_start ? new Date(sub.current_start * 1000) : new Date();
          const periodEnd   = sub.current_end   ? new Date(sub.current_end   * 1000) : null;
          await db.updateSubscriptionStatus({
            razorpaySubscriptionId: sub.id,
            status: 'active',
            periodStart,
            periodEnd
          });
          await activatePlan({
            userId        : subRecord.user_id,
            planTier      : subRecord.plan_tier,
            billingPeriod : subRecord.billing_period,
            subscriptionId: subRecord.id,
            eventType     : 'webhook_subscription_resumed'
          });
        }
      }
    }

    if (eventType === 'subscription.halted') {
      const sub = payload?.subscription?.entity;
      if (sub?.id) {
        await db.updateSubscriptionStatus({
          razorpaySubscriptionId: sub.id,
          status: 'halted'
        });
      }
    }
  } catch (err) {
    // Log but always return 200 to prevent Razorpay retries on transient DB errors
    console.error(`[payments] webhook handler error (${eventType}):`, err.message);
    // Attempt reconciliation log for webhook-level failures
    await db.logReconciliation({
      eventType,
      failureStage : 'webhook_handler',
      errorMessage : err.message,
      metadata     : { event: eventType }
    }).catch(() => {});
  }

  res.json({ received: true });
});

// ─── BILLING PAGE SUPPORT ──────────────────────────────────────────────────
// Read-only endpoints consumed by /settings/billing.
// These are payment-adjacent reads (no mutations beyond downgrade intent logging).

// GET /api/payments/history — last 12 payments for the authenticated user
router.get('/payments/history', requireAuth, async (req, res) => {
  try {
    const payments = await db.getPaymentsByUserId(req.user.id, 12);
    return res.json(payments);
  } catch (err) {
    console.error('[payments] GET /payments/history error:', err.message);
    return res.status(500).json({ error: 'Failed to load payment history' });
  }
});

// GET /api/payments/subscription — active subscription (or null) for the authenticated user
router.get('/payments/subscription', requireAuth, async (req, res) => {
  try {
    const sub = await db.getActiveSubscriptionByUserId(req.user.id);
    return res.json(sub || null);
  } catch (err) {
    console.error('[payments] GET /payments/subscription error:', err.message);
    return res.status(500).json({ error: 'Failed to load subscription' });
  }
});

// POST /api/payments/downgrade — logs downgrade intent; actual cancellation via Razorpay webhook
// Body: { target_tier: 'individual' }
router.post('/payments/downgrade', requireAuth, async (req, res) => {
  try {
    const { target_tier } = req.body;
    if (!['individual'].includes(target_tier)) {
      return res.status(400).json({ error: 'Invalid target_tier' });
    }

    const sub = await db.getActiveSubscriptionByUserId(req.user.id);
    if (!sub) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Record downgrade intent for ops review; actual tier change follows Razorpay cancel webhook.
    await db.logReconciliation({
      eventType    : 'downgrade_requested',
      userId       : req.user.id,
      planTier     : target_tier,
      failureStage : null,
      errorMessage : null,
      metadata     : { target_tier, subscription_id: sub.razorpay_subscription_id, requested_at: new Date().toISOString() }
    });

    return res.json({ ok: true, message: 'Downgrade scheduled for end of billing period' });
  } catch (err) {
    console.error('[payments] POST /payments/downgrade error:', err.message);
    return res.status(500).json({ error: 'Failed to schedule downgrade' });
  }
});

// ─── GET /api/payments/plan-state ──────────────────────────────────────────
// Returns the full plan state for the pricing page:
//   { tier, renews_at, scheduled_change, scheduled_change_date, cancel_at_period_end }
// Also applies any due scheduled changes lazily on fetch.

router.get('/payments/plan-state', requireAuth, async (req, res) => {
  try {
    // Apply any scheduled changes that became due (lazy execution)
    await db.applyDueScheduledChanges();

    const credits = await db.getUserCredits(req.user.id);
    if (!credits) {
      return res.json({ tier: 'free', renews_at: null, scheduled_change: null, scheduled_change_date: null, cancel_at_period_end: false });
    }

    // Subscription gives us the period end for "renews on" display
    const sub = await db.getActiveSubscriptionByUserId(req.user.id);
    const renewsAt = sub && sub.current_period_end ? sub.current_period_end : (credits.period_end || null);

    res.json({
      tier                  : credits.plan_tier || 'free',
      renews_at             : renewsAt,
      scheduled_change      : credits.scheduled_plan_change || null,
      scheduled_change_date : credits.scheduled_plan_change_date || null,
      cancel_at_period_end  : credits.cancel_at_period_end || false
    });
  } catch (err) {
    console.error('[payments] GET /payments/plan-state error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plan state' });
  }
});

// ─── POST /api/payments/change-plan ────────────────────────────────────────
// Central plan-change endpoint consumed by /pricing CTA buttons.
// Body: { target_plan, action: 'upgrade' | 'downgrade' | 'cancel' }
//
// Upgrade path: computes proration server-side, creates a Razorpay order for the
//   delta only. Frontend completes checkout and calls /api/verify-payment as normal.
//   On verify, activatePlan() updates plan_tier and also clears any scheduled change.
//
// Downgrade/cancel path: no Razorpay call. Writes scheduled_plan_change + date
//   to user_credits. Frontend shows confirmation. Change applies on period end.

const VALID_PAID_TIERS    = ['individual', 'team', 'business', 'enterprise'];
const TIER_ORDER          = ['individual', 'team', 'business', 'enterprise'];
// Monthly base prices in USD cents per tier (1 connection, 0 seats) — sourced from config/pricing.js
const TIER_BASE_PRICE_USD = Object.fromEntries(
  VALID_PAID_TIERS.map(t => [t, pricingConfig.CONN_PRICES[t].conn])
);

router.post('/payments/change-plan', requireAuth, async (req, res) => {
  const rzp = getRazorpayClient();
  const { target_plan, action } = req.body;

  if (!['upgrade', 'downgrade', 'cancel'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Must be upgrade, downgrade, or cancel.' });
  }

  try {
    // Apply any due scheduled changes first (belt-and-suspenders)
    await db.applyDueScheduledChanges();

    const credits = await db.getUserCredits(req.user.id);
    const currentTier = credits ? credits.plan_tier : 'free';

    // ── UPGRADE ──────────────────────────────────────────────────────────────
    if (action === 'upgrade') {
      if (!rzp) return res.status(503).json({ error: 'Payments not configured' });

      // Guard: free users must use /api/create-order (new purchase), not this endpoint.
      // change-plan is for prorated upgrades between paid tiers only.
      if (!credits || currentTier === 'free') {
        return res.status(400).json({
          error: 'No active subscription to upgrade from. Use create-order for new purchases.',
          redirect_to: 'create-order'
        });
      }
      if (!VALID_PAID_TIERS.includes(target_plan)) {
        return res.status(400).json({ error: 'Invalid target_plan for upgrade' });
      }

      const currentIdx = TIER_ORDER.indexOf(currentTier);
      const targetIdx  = TIER_ORDER.indexOf(target_plan);

      if (targetIdx <= currentIdx && currentTier !== 'free') {
        return res.status(400).json({ error: 'target_plan must be higher than current tier for an upgrade' });
      }

      // Compute prorated delta:
      // Full price of new tier minus unused credit from remaining days of current period.
      // If user has no paid plan, charge full monthly price.
      const newPriceCents = TIER_BASE_PRICE_USD[target_plan];

      let proratedDelta = newPriceCents;
      if (credits && credits.period_end && currentTier !== 'free' && TIER_BASE_PRICE_USD[currentTier]) {
        const now       = Date.now();
        const periodEnd = new Date(credits.period_end).getTime();
        const periodStart = credits.period_start ? new Date(credits.period_start).getTime() : (periodEnd - 30 * 24 * 60 * 60 * 1000);
        const totalMs   = periodEnd - periodStart;
        const remainMs  = Math.max(0, periodEnd - now);
        // Unused credit = current plan monthly price × fraction remaining
        const unusedCredit = totalMs > 0
          ? Math.round((TIER_BASE_PRICE_USD[currentTier] || 0) * (remainMs / totalMs))
          : 0;
        proratedDelta = Math.max(100, newPriceCents - unusedCredit); // floor at $1
      }

      // Clear any pending scheduled change on upgrade
      if (credits && credits.scheduled_plan_change) {
        await db.clearScheduledChange(req.user.id);
      }

      // Razorpay live account is INR-only — convert USD cents to INR paise
      const proratedDeltaInr = usdCentsToInrPaise(proratedDelta);

      const order = await rzp.orders.create({
        amount  : proratedDeltaInr,
        currency: 'INR',
        notes   : {
          plan_tier       : target_plan,
          billing_period  : 'monthly',
          user_id         : String(req.user.id),
          change_type     : 'upgrade',
          connection_count: '1',
          seat_count      : '0',
          usd_amount_cents: String(proratedDelta)
        }
      });

      await db.createPaymentRecord({
        userId         : req.user.id,
        razorpayOrderId: order.id,
        amountPaise    : proratedDeltaInr,
        currency       : 'INR',
        planTier       : target_plan,
        paymentType    : 'one_time',
        billingPeriod  : 'monthly'
      });

      return res.json({
        action      : 'upgrade',
        order_id    : order.id,
        amount      : proratedDeltaInr,
        currency    : 'INR',
        target_plan,
        description : `Upgrade to ${target_plan} — prorated`,
        is_prorated : proratedDelta < newPriceCents
      });
    }

    // ── DOWNGRADE ────────────────────────────────────────────────────────────
    if (action === 'downgrade') {
      if (!VALID_PAID_TIERS.includes(target_plan)) {
        return res.status(400).json({ error: 'Invalid target_plan for downgrade' });
      }
      if (!credits || currentTier === 'free') {
        return res.status(400).json({ error: 'No active paid plan to downgrade from' });
      }

      // Effective date = current period end (or 30 days from now as fallback)
      const effectiveDate = credits.period_end
        ? new Date(credits.period_end)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await db.scheduleDowngrade({
        userId           : req.user.id,
        targetTier       : target_plan,
        effectiveDate,
        cancelAtPeriodEnd: false
      });

      await db.logReconciliation({
        eventType    : 'downgrade_scheduled',
        userId       : req.user.id,
        planTier     : target_plan,
        failureStage : null,
        errorMessage : null,
        metadata     : { current_tier: currentTier, target_tier: target_plan, effective_date: effectiveDate.toISOString() }
      });

      return res.json({
        action         : 'downgrade',
        target_plan,
        effective_date : effectiveDate.toISOString(),
        message        : `You'll switch to ${target_plan} on ${effectiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
      });
    }

    // ── CANCEL (move to free) ────────────────────────────────────────────────
    if (action === 'cancel') {
      if (!credits || currentTier === 'free') {
        return res.status(400).json({ error: 'No active paid plan to cancel' });
      }

      const effectiveDate = credits.period_end
        ? new Date(credits.period_end)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await db.scheduleDowngrade({
        userId           : req.user.id,
        targetTier       : 'free',
        effectiveDate,
        cancelAtPeriodEnd: true
      });

      await db.logReconciliation({
        eventType    : 'cancel_scheduled',
        userId       : req.user.id,
        planTier     : 'free',
        failureStage : null,
        errorMessage : null,
        metadata     : { current_tier: currentTier, effective_date: effectiveDate.toISOString() }
      });

      return res.json({
        action         : 'cancel',
        effective_date : effectiveDate.toISOString(),
        message        : `Your plan will revert to Free on ${effectiveDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`
      });
    }

  } catch (err) {
    // Razorpay SDK throws plain objects with err.error.description, not Error instances.
    // Extracting the description prevents "undefined" in logs and surfaces the real cause.
    const razorpayDesc = err?.error?.description;
    const errMsg = razorpayDesc || err?.message || JSON.stringify(err) || 'Unknown error';
    const httpCode = err?.statusCode;
    console.error('[payments] POST /payments/change-plan error:', errMsg, httpCode ? `(HTTP ${httpCode})` : '');

    let userMsg = 'Failed to process plan change. Please try again.';
    if (httpCode === 401 || razorpayDesc === 'Authentication failed') {
      userMsg = 'Payment service is temporarily unavailable. Please try again shortly.';
    } else if (httpCode === 400) {
      userMsg = 'Invalid plan change request. Please refresh and try again.';
    }
    res.status(500).json({ error: userMsg });
  }
});

module.exports = router;
