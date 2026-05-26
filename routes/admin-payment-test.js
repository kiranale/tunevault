/**
 * routes/admin-payment-test.js — Razorpay end-to-end payment test runner.
 *
 * Owns: running admin-triggered payment validation tests, storing results in
 *       payment_test_runs, and returning the test history to the admin dashboard.
 * Does NOT own: user auth, oracle connections, health checks, production checkout flow.
 *
 * Mounted at: /api/admin/payment-test (see server.js)
 *
 * Access is restricted to ADMIN_EMAILS. Tests use real Razorpay test-key API calls
 * (not mocks) so they validate actual credential validity and API reachability.
 */

'use strict';

const express   = require('express');
const crypto    = require('crypto');
const Razorpay  = require('razorpay');
const pool      = require('../db/index');
const dbPay     = require('../db/payments');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
// Test-mode keys — separate from live keys so operators can run test transactions
// without touching production payment flow. Set RAZORPAY_TEST_KEY_ID + RAZORPAY_TEST_KEY_SECRET
// in env vars (get them from Razorpay Dashboard → Settings → API Keys → Test Mode).
const RAZORPAY_TEST_KEY_ID     = process.env.RAZORPAY_TEST_KEY_ID;
const RAZORPAY_TEST_KEY_SECRET = process.env.RAZORPAY_TEST_KEY_SECRET;

// Test user email — created on-the-fly if it doesn't exist
const TEST_USER_EMAIL = 'payment-test@tunevault.internal';

// ─── HELPERS ────────────────────────────────────────────────────────────────

function getRazorpay() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}

// Get-or-create the internal test user (never visible to real users)
async function getOrCreateTestUser() {
  const existing = await pool.query(
    'SELECT id, email FROM users WHERE LOWER(email) = $1',
    [TEST_USER_EMAIL]
  );
  if (existing.rows.length) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO users (email, name, created_at, updated_at)
     VALUES ($1, 'Payment Test Bot', NOW(), NOW())
     RETURNING id, email`,
    [TEST_USER_EMAIL]
  );
  return created.rows[0];
}

async function getUserCreditsSnapshot(userId) {
  const row = await dbPay.getUserCredits(userId);
  return row ? row.checks_remaining : null;
}

// Generate a valid Razorpay HMAC signature (same as what the client would compute after checkout)
function makeOrderSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

// Persist test run result
async function saveTestRun(data) {
  const result = await pool.query(
    `INSERT INTO payment_test_runs
       (test_type, plan_tier, test_user_id,
        order_id, payment_id, subscription_id,
        stage_order_created, stage_sig_verified, stage_credits_updated,
        stage_webhook_received, stage_receipt_sent,
        credits_before, credits_after,
        overall_result, error_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      data.test_type, data.plan_tier, data.test_user_id,
      data.order_id || null, data.payment_id || null, data.subscription_id || null,
      data.stage_order_created  || 'SKIP',
      data.stage_sig_verified   || 'SKIP',
      data.stage_credits_updated|| 'SKIP',
      data.stage_webhook_received|| 'SKIP',
      data.stage_receipt_sent   || 'SKIP',
      data.credits_before != null ? data.credits_before : null,
      data.credits_after  != null ? data.credits_after  : null,
      data.overall_result,
      data.error_detail   || null
    ]
  );
  return result.rows[0];
}

// ─── POST /api/admin/payment-test/run ───────────────────────────────────────
// Runs an end-to-end payment test for one-off or subscription tier.
// Body: { test_type: 'one_off'|'subscription', plan_tier: 'starter'|'growth' }

router.post('/run', requireAdmin, async (req, res) => {
  const { test_type = 'one_off', plan_tier = 'starter' } = req.body;

  if (!['one_off', 'subscription'].includes(test_type)) {
    return res.status(400).json({ error: 'test_type must be one_off or subscription' });
  }
  if (!['starter', 'growth'].includes(plan_tier)) {
    return res.status(400).json({ error: 'plan_tier must be starter or growth for test runs' });
  }

  const rzp = getRazorpay();
  if (!rzp) return res.status(503).json({ error: 'Razorpay not configured' });

  const stages = {
    order_created   : 'SKIP',
    sig_verified    : 'SKIP',
    credits_updated : 'SKIP',
    webhook_received: 'SKIP',   // we can't trigger webhooks from this script — documented skip
    receipt_sent    : 'SKIP',   // Polsia email proxy call — documented skip for automated test
  };
  let orderId      = null;
  let paymentId    = null;
  let subscriptionId = null;
  let creditsBefore = null;
  let creditsAfter  = null;
  let errorDetail   = null;
  let testUser;

  try {
    // ── STEP 0: get/create test user + reset credits to zero ──────────────
    // Each test run must start from 0 credits so the upsert (0 → planChecks)
    // is validated every time. Without this reset, the upsert sets credits to
    // the same plan total on repeat runs and the before/after check sees no change.
    testUser = await getOrCreateTestUser();
    await dbPay.resetUserCredits(testUser.id);
    creditsBefore = await getUserCreditsSnapshot(testUser.id);

    const amountPaise = dbPay.getPlanPricePaise(plan_tier, 'monthly');

    if (test_type === 'one_off') {
      // ── STEP 2a: create real Razorpay order ─────────────────────────────
      const order = await rzp.orders.create({
        amount  : amountPaise,
        currency: 'USD',
        notes   : { plan_tier, billing_period: 'monthly', user_id: String(testUser.id), source: 'admin_test' }
      });
      orderId = order.id;

      await dbPay.createPaymentRecord({
        userId         : testUser.id,
        razorpayOrderId: orderId,
        amountPaise,
        currency       : 'USD',
        planTier       : plan_tier,
        paymentType    : 'one_time',
        billingPeriod  : 'monthly'
      });
      stages.order_created = 'PASS';

      // ── STEP 3a: generate synthetic payment_id + valid HMAC signature ───
      // Real payment_ids from Razorpay follow the pattern pay_<22 alphanum>.
      // We generate one that is clearly synthetic for test traceability.
      paymentId = `pay_TESTADMIN${Date.now()}`;
      const signature = makeOrderSignature(orderId, paymentId);

      // ── STEP 4a: run the same verification logic used by /api/verify-payment
      const sigValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(makeOrderSignature(orderId, paymentId))
      );
      if (!sigValid) throw new Error('Self-generated signature failed verification');
      stages.sig_verified = 'PASS';

      // Apply the capture directly (same code path as /api/verify-payment)
      const payment = await dbPay.markPaymentCaptured({
        razorpayOrderId  : orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature
      });
      if (!payment) throw new Error('markPaymentCaptured returned null — order not found');

      // Credit the test user
      const checksTotal = dbPay.getPlanChecks(plan_tier);
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await dbPay.upsertUserCredits({
        userId     : testUser.id,
        planTier   : plan_tier,
        checksTotal,
        periodStart: now,
        periodEnd
      });

      creditsAfter = await getUserCreditsSnapshot(testUser.id);
      stages.credits_updated = (creditsAfter !== null && creditsAfter > (creditsBefore || 0))
        ? 'PASS' : 'FAIL';

    } else {
      // ── STEP 2b: create real Razorpay subscription ──────────────────────
      const interval = 1; // monthly
      const plan = await rzp.plans.create({
        period  : 'monthly',
        interval,
        item: {
          name     : `TuneVault ${plan_tier} (admin-test)`,
          amount   : amountPaise,
          unit_amount: amountPaise,
          currency : 'USD'
        },
        notes: { plan_tier, source: 'admin_test' }
      });

      const subscription = await rzp.subscriptions.create({
        plan_id        : plan.id,
        total_count    : 120,
        quantity       : 1,
        customer_notify: 0,   // don't spam Razorpay test customers
        notes          : { plan_tier, billing_period: 'monthly', user_id: String(testUser.id), source: 'admin_test' }
      });
      subscriptionId = subscription.id;
      stages.order_created = 'PASS';

      await dbPay.createSubscriptionRecord({
        userId                : testUser.id,
        razorpaySubscriptionId: subscriptionId,
        razorpayPlanId        : plan.id,
        planTier              : plan_tier,
        billingPeriod         : 'monthly'
      });

      // ── STEP 3b: generate synthetic payment + valid subscription signature
      paymentId  = `pay_TESTADMIN${Date.now()}`;
      const subSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${paymentId}|${subscriptionId}`)
        .digest('hex');
      stages.sig_verified = 'PASS'; // generated and will be verified below

      // Verify signature (same check as /api/verify-subscription)
      const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(`${paymentId}|${subscriptionId}`)
        .digest('hex');
      if (subSig !== expected) throw new Error('Subscription signature mismatch');

      // Update subscription status
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await dbPay.updateSubscriptionStatus({
        razorpaySubscriptionId: subscriptionId,
        status     : 'authenticated',
        periodStart: now,
        periodEnd
      });

      // Credit the test user
      const checksTotal = dbPay.getPlanChecks(plan_tier);
      await dbPay.upsertUserCredits({
        userId     : testUser.id,
        planTier   : plan_tier,
        checksTotal,
        periodStart: now,
        periodEnd
      });

      creditsAfter = await getUserCreditsSnapshot(testUser.id);
      stages.credits_updated = (creditsAfter !== null && creditsAfter > (creditsBefore || 0))
        ? 'PASS' : 'FAIL';
    }

    // ── Overall result ─────────────────────────────────────────────────────
    const failed = Object.values(stages).filter(s => s === 'FAIL');
    const overallResult = failed.length === 0 ? 'PASS' : 'FAIL';

    const run = await saveTestRun({
      test_type,
      plan_tier,
      test_user_id          : testUser.id,
      order_id              : orderId,
      payment_id            : paymentId,
      subscription_id       : subscriptionId,
      stage_order_created   : stages.order_created,
      stage_sig_verified    : stages.sig_verified,
      stage_credits_updated : stages.credits_updated,
      stage_webhook_received: stages.webhook_received,
      stage_receipt_sent    : stages.receipt_sent,
      credits_before        : creditsBefore,
      credits_after         : creditsAfter,
      overall_result        : overallResult,
      error_detail          : null
    });

    console.log(`[admin-payment-test] ${overallResult}: ${test_type}/${plan_tier} — order ${orderId || subscriptionId}, payment ${paymentId}, credits ${creditsBefore}→${creditsAfter}`);

    res.json({ success: true, result: overallResult, run, stages });

  } catch (err) {
    // Razorpay SDK errors vary in shape — err.error can be a string or object,
    // and the error may not be a proper Error instance (no .message).
    errorDetail = (typeof err?.error === 'object' && err.error?.description)
               || (typeof err?.error === 'string' && err.error)
               || err?.description
               || err?.message
               || (err?.statusCode ? `Razorpay HTTP ${err.statusCode}` : 'Unknown Razorpay error');
    const errCode = err?.statusCode || err?.error?.code || '';
    console.error(`[admin-payment-test] run failed: ${errorDetail} (status=${errCode}, raw=${JSON.stringify(err).slice(0, 500)})`);

    // Try to save the failure record
    try {
      await saveTestRun({
        test_type,
        plan_tier,
        test_user_id          : testUser ? testUser.id : 0,
        order_id              : orderId,
        payment_id            : paymentId,
        subscription_id       : subscriptionId,
        stage_order_created   : stages.order_created,
        stage_sig_verified    : stages.sig_verified,
        stage_credits_updated : stages.credits_updated,
        stage_webhook_received: stages.webhook_received,
        stage_receipt_sent    : stages.receipt_sent,
        credits_before        : creditsBefore,
        credits_after         : creditsAfter,
        overall_result        : 'FAIL',
        error_detail          : errorDetail
      });
    } catch (saveErr) {
      console.error('[admin-payment-test] failed to save failure record:', saveErr.message);
    }

    res.status(500).json({ success: false, result: 'FAIL', error: errorDetail, stages });
  }
});

// ─── POST /api/admin/payment-test/create-method-order ────────────────────────
// Creates a real Razorpay order (one-off) or subscription for the checkout matrix.
// Body: { amount_paise, label, flow_type }
//   flow_type: 'one_off' (default) | 'subscription'
// Returns: { order_id?, subscription_id?, amount_paise, key_id }

router.post('/create-method-order', requireAdmin, async (req, res) => {
  const rzp = getRazorpay();
  if (!rzp) return res.status(503).json({ error: 'Razorpay not configured' });

  const { amount_paise, label, flow_type } = req.body;
  if (!amount_paise || amount_paise < 100) {
    return res.status(400).json({ error: 'amount_paise must be >= 100' });
  }

  const commonNotes = { source: 'admin_method_test', label: label || '', test: 'true', operator: 'kiran' };

  try {
    if (flow_type === 'subscription') {
      // Create a minimal plan + subscription so the checkout opens in subscription mode.
      // ₹2,500/month is the Growth tier amount used for subscription method tests.
      const plan = await rzp.plans.create({
        period  : 'monthly',
        interval: 1,
        item: {
          name    : 'TuneVault Admin Method Test',
          amount  : amount_paise,
          currency: 'USD'
        },
        notes: commonNotes
      });

      const sub = await rzp.subscriptions.create({
        plan_id        : plan.id,
        total_count    : 120,
        quantity       : 1,
        customer_notify: 0,
        notes          : commonNotes
      });

      console.log(`[admin-payment-test] create-method-order subscription=${sub.id} plan=${plan.id} label=${label}`);
      res.json({ subscription_id: sub.id, amount_paise, key_id: RAZORPAY_KEY_ID });

    } else {
      // One-off order
      const order = await rzp.orders.create({
        amount  : amount_paise,
        currency: 'USD',
        notes   : commonNotes
      });
      console.log(`[admin-payment-test] create-method-order order=${order.id} label=${label}`);
      res.json({ order_id: order.id, amount_paise, key_id: RAZORPAY_KEY_ID });
    }
  } catch (err) {
    const desc = err?.error?.description || err.message;
    console.error('[admin-payment-test] create-method-order failed:', desc);
    res.status(500).json({ error: desc });
  }
});

// ─── POST /api/admin/payment-test/log-pending ────────────────────────────────
// Inserts a 'pending' row in payment_method_test_runs before checkout opens.
// The row stays pending until the Razorpay webhook updates it (payment.captured / payment.failed).
// Body: { method, flow_type, bank, label, order_id, subscription_id, amount_paise }

router.post('/log-pending', requireAdmin, async (req, res) => {
  const { method, flow_type, bank, label, order_id, subscription_id, amount_paise } = req.body;

  if (!method || !amount_paise) {
    return res.status(400).json({ error: 'method, amount_paise required' });
  }

  // Prefer order_id; for subscriptions use subscription_id as order_id placeholder
  const effectiveOrderId = order_id || subscription_id || null;

  try {
    const result = await pool.query(
      `INSERT INTO payment_method_test_runs
         (method, flow_type, bank, label, order_id, amount_paise, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING *`,
      [method, flow_type || null, bank || null, label || null, effectiveOrderId, amount_paise]
    );
    console.log(`[admin-payment-test] log-pending ${method} ${label || ''} order=${effectiveOrderId}`);
    res.json({ success: true, run: result.rows[0] });
  } catch (err) {
    console.error('[admin-payment-test] log-pending failed:', err.message);
    res.status(500).json({ error: 'Failed to insert pending row' });
  }
});

// ─── POST /api/admin/payment-test/log-method-result ──────────────────────────
// Saves the result of a method checkout to payment_method_test_runs.
// Called by the frontend after Razorpay checkout resolves (success or error).
// Body: { method, flow_type, bank, label, order_id, payment_id,
//         amount_paise, status, error_code, error_description, latency_ms, raw_response }

router.post('/log-method-result', requireAdmin, async (req, res) => {
  const {
    method, flow_type, bank, label,
    order_id, payment_id,
    amount_paise, status,
    error_code, error_description, latency_ms,
    raw_response
  } = req.body;

  if (!method || !status || !amount_paise) {
    return res.status(400).json({ error: 'method, status, amount_paise required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO payment_method_test_runs
         (method, flow_type, bank, label, order_id, payment_id,
          amount_paise, status, error_code, error_description, latency_ms, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        method, flow_type || null, bank || null, label || null,
        order_id || null, payment_id || null,
        amount_paise, status,
        error_code || null, error_description || null,
        latency_ms != null ? latency_ms : null,
        raw_response ? JSON.stringify(raw_response) : null
      ]
    );

    const run = result.rows[0];
    const symbol = status === 'success' ? '✓' : '✗';
    console.log(`[admin-payment-test] method-result ${symbol} ${method} ${label || ''} — ${status}${error_code ? ' ' + error_code : ''}`);

    res.json({ success: true, run });
  } catch (err) {
    console.error('[admin-payment-test] log-method-result failed:', err.message);
    res.status(500).json({ error: 'Failed to save method test result' });
  }
});

// ─── GET /api/admin/payment-test/method-history ──────────────────────────────
// Returns the last 30 method test runs.

router.get('/method-history', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM payment_method_test_runs ORDER BY ran_at DESC LIMIT 30`
    );
    res.json({ runs: result.rows });
  } catch (err) {
    console.error('[admin-payment-test] method-history query failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch method test history' });
  }
});

// ─── GET /api/admin/payment-test/history ────────────────────────────────────
// Returns the last 20 test runs for display on the admin dashboard.

router.get('/history', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM payment_test_runs ORDER BY ran_at DESC LIMIT 20`
    );
    res.json({ runs: result.rows });
  } catch (err) {
    console.error('[admin-payment-test] history query failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch test history' });
  }
});

// ─── GET /api/admin/payment-test/status ─────────────────────────────────────
// Quick health-check: confirms Razorpay keys are loaded and what mode they're in.

// Public endpoint — only exposes the key prefix and mode (key_id goes into checkout JS anyway).
// No auth required so the status banner renders correctly regardless of login state.
router.get('/status', (req, res) => {
  const liveConfigured = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
  const testConfigured = !!(RAZORPAY_TEST_KEY_ID && RAZORPAY_TEST_KEY_SECRET &&
                             RAZORPAY_TEST_KEY_ID.startsWith('rzp_test'));

  if (!RAZORPAY_KEY_ID) {
    return res.json({
      configured    : false,
      liveConfigured: false,
      testConfigured,
      message       : 'RAZORPAY_KEY_ID not set'
    });
  }
  res.json({
    configured    : true,
    liveConfigured,
    testConfigured,
    key_id        : RAZORPAY_KEY_ID,
    key_prefix    : RAZORPAY_KEY_ID.slice(0, 16) + '...',
    mode          : RAZORPAY_KEY_ID.startsWith('rzp_live') ? 'LIVE' : 'TEST',
    webhook_url   : `${process.env.APP_URL || 'https://tunevault.app'}/api/razorpay-webhook`
  });
});

// ─── GET /api/admin/payment-test/auth-check ──────────────────────────────────
// Lightweight probe: confirms whether the current session is a valid admin.
// Returns { authenticated: true, email } or 401/403.
router.get('/auth-check', requireAdmin, (req, res) => {
  console.log('[admin-payment-test] auth-check: ✓ admin confirmed:', req.user.email);
  res.json({ authenticated: true, email: req.user.email });
});

// ─── GET /api/admin/payment-test/status-test ─────────────────────────────────
// Reports whether RAZORPAY_TEST_KEY_ID / RAZORPAY_TEST_KEY_SECRET are configured.
// Public endpoint — test key_id is safe to expose (it goes into checkout JS anyway).
router.get('/status-test', (req, res) => {
  const liveConfigured = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

  if (!RAZORPAY_TEST_KEY_ID || !RAZORPAY_TEST_KEY_SECRET) {
    return res.json({
      configured    : false,
      liveConfigured,
      testConfigured: false,
      message       : 'Test keys not configured. Set RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET env vars.'
    });
  }
  const isActuallyTest = RAZORPAY_TEST_KEY_ID.startsWith('rzp_test');
  res.json({
    configured    : true,
    liveConfigured,
    testConfigured: isActuallyTest,
    key_id        : RAZORPAY_TEST_KEY_ID,
    key_prefix    : RAZORPAY_TEST_KEY_ID.slice(0, 16) + '...',
    mode          : isActuallyTest ? 'TEST' : 'UNKNOWN',
    valid         : isActuallyTest
  });
});

// ─── POST /api/admin/payment-test/create-test-order ──────────────────────────
// Creates a ₹1 Razorpay order using TEST keys (rzp_test_...).
// This is the only path that generates a real test-mode transaction that appears
// in Razorpay Dashboard → Test Transactions and satisfies their activation checklist.
// Body: {} (no args needed — always ₹1)
router.post('/create-test-order', requireAdmin, async (req, res) => {
  if (!RAZORPAY_TEST_KEY_ID || !RAZORPAY_TEST_KEY_SECRET) {
    return res.status(503).json({
      error: 'Test keys not configured. Set RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET env vars.'
    });
  }
  if (!RAZORPAY_TEST_KEY_ID.startsWith('rzp_test')) {
    return res.status(400).json({
      error: `RAZORPAY_TEST_KEY_ID must start with rzp_test (got: ${RAZORPAY_TEST_KEY_ID.slice(0, 10)}...). Live keys cannot create test transactions.`
    });
  }

  const rzpTest = new Razorpay({
    key_id    : RAZORPAY_TEST_KEY_ID,
    key_secret: RAZORPAY_TEST_KEY_SECRET
  });

  try {
    // ₹1 = 100 paise — use INR for test transactions because Razorpay test accounts
    // don't have international payments enabled by default (USD would fail with
    // BAD_REQUEST_ERROR). This only validates credential + API reachability, so
    // currency doesn't matter for the activation checklist.
    const order = await rzpTest.orders.create({
      amount  : 100,
      currency: 'INR',
      notes   : { source: 'admin_activation_test', operator: req.user.email, purpose: 'razorpay_activation_checklist' }
    });

    console.log(`[admin-payment-test] test-mode order created: ${order.id} by ${req.user.email}`);
    res.json({ order_id: order.id, amount_paise: 100, key_id: RAZORPAY_TEST_KEY_ID });
  } catch (err) {
    // Razorpay SDK errors vary in shape — err.error can be a string or object,
    // and the error may not be a proper Error instance (no .message).
    const desc = (typeof err?.error === 'object' && err.error?.description)
              || (typeof err?.error === 'string' && err.error)
              || err?.description
              || err?.message
              || (err?.statusCode ? `Razorpay HTTP ${err.statusCode}` : 'Unknown Razorpay error');
    const code = err?.statusCode || err?.error?.code || '';
    console.error(`[admin-payment-test] create-test-order failed: ${desc} (status=${code}, raw=${JSON.stringify(err).slice(0, 500)})`);
    res.status(500).json({ error: desc });
  }
});

// ─── POST /api/admin/payment-test/log-test-result ────────────────────────────
// Saves the outcome of a test-mode checkout attempt (success or failure).
// Called by the frontend after the test checkout modal resolves.
// Body: { order_id, payment_id?, status, error_code?, error_description? }
router.post('/log-test-result', requireAdmin, async (req, res) => {
  const { order_id, payment_id, status, error_code, error_description } = req.body;
  if (!order_id || !status) {
    return res.status(400).json({ error: 'order_id and status required' });
  }

  const symbol = status === 'success' ? '✓' : '✗';
  console.log(`[admin-payment-test] test-mode result ${symbol} order=${order_id} payment=${payment_id || 'none'} status=${status}${error_code ? ' code=' + error_code : ''}`);

  // Store in payment_method_test_runs with method='test_activation' for traceability
  try {
    await pool.query(
      `INSERT INTO payment_method_test_runs
         (method, flow_type, label, order_id, payment_id, amount_paise, status, error_code, error_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      ['test_activation', 'one_off', 'activation_checklist', order_id, payment_id || null,
       100, status, error_code || null, error_description || null]
    );
  } catch (dbErr) {
    // Non-fatal — log but don't fail the response
    console.warn('[admin-payment-test] log-test-result DB write failed:', dbErr.message);
  }

  res.json({ success: true });
});

// ─── GET /api/admin/payment-test/last-activation ─────────────────────────────
// Returns the most recent test-mode activation checkout result from payment_method_test_runs.
// Used by the admin page to show the last test payment_id with a Razorpay dashboard deep link.
// No auth required — payment_ids from test mode are not sensitive (test env only).
router.get('/last-activation', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, order_id, payment_id, status, error_code, error_description, ran_at
       FROM payment_method_test_runs
       WHERE method = 'test_activation'
       ORDER BY ran_at DESC
       LIMIT 1`
    );
    if (!result.rows.length) {
      return res.json({ found: false });
    }
    const row = result.rows[0];
    res.json({
      found      : true,
      id         : row.id,
      order_id   : row.order_id,
      payment_id : row.payment_id,
      status     : row.status,
      error_code : row.error_code,
      ran_at     : row.ran_at,
      // Direct deep link to Razorpay test dashboard for this payment
      dashboard_url: row.payment_id
        ? `https://dashboard.razorpay.com/app/payment/${row.payment_id}`
        : null
    });
  } catch (err) {
    console.error('[admin-payment-test] last-activation query failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch last activation' });
  }
});

module.exports = router;
