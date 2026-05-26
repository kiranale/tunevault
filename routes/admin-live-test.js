/**
 * routes/admin-live-test.js — Admin live payment validation via real ₹1 charge + auto-refund.
 *
 * Owns: creating a live ₹1 Razorpay order, verifying the payment signature, and
 *       immediately refunding the payment via the Razorpay Refunds API.
 * Does NOT own: production checkout flow, user plan activation, subscription handling,
 *               or anything that involves test-mode credentials.
 *
 * Mounted at: /api/admin/live-test (see server.js)
 *
 * Access is restricted to ADMIN_EMAILS. Uses LIVE Razorpay keys only — no purpose
 * in test mode. Amount is always server-enforced to 100 paise (₹1); client-supplied
 * amounts are ignored.
 */

'use strict';

const express  = require('express');
const crypto   = require('crypto');
const https    = require('https');
const Razorpay = require('razorpay');

const pool = require('../db/index');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// Server-enforced amount — never trust client-supplied amount for this endpoint.
// 100 paise = ₹1. Currency fixed to INR (live keys may be INR-configured).
const LIVE_TEST_AMOUNT_PAISE = 100;
const LIVE_TEST_CURRENCY     = 'INR';

// In-memory log of live test orders — keyed by order_id.
// Lightweight audit for the current server process; not persisted across restarts.
// This avoids creating a new DB table per spec.
const liveTestOrders = new Map(); // orderId → { adminUserId, adminEmail, createdAt }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getRazorpayClient() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
}

/**
 * Call Razorpay Refunds API to refund a captured payment.
 * Uses HTTP Basic Auth with live key credentials.
 * Returns { ok: true, refund } or { ok: false, error, statusCode, raw }.
 */
async function callRazorpayRefund(paymentId) {
  const body  = JSON.stringify({ amount: LIVE_TEST_AMOUNT_PAISE, speed: 'optimum' });
  const basic = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.razorpay.com',
      port    : 443,
      path    : `/v1/payments/${paymentId}/refund`,
      method  : 'POST',
      headers : {
        'Authorization' : `Basic ${basic}`,
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, refund: parsed });
          } else {
            const desc  = parsed?.error?.description || parsed?.description || data.slice(0, 300);
            const code  = parsed?.error?.code        || parsed?.code        || 'unknown';
            resolve({ ok: false, statusCode: res.statusCode, error: desc, code, raw: data.slice(0, 500) });
          }
        } catch (parseErr) {
          resolve({ ok: false, statusCode: res.statusCode, error: `JSON parse error: ${parseErr.message}`, raw: data.slice(0, 200) });
        }
      });
    });

    req.on('error', (netErr) => {
      resolve({ ok: false, statusCode: 0, error: `Network error: ${netErr.message}` });
    });

    req.write(body);
    req.end();
  });
}

// ─── POST /api/admin/live-test/create-order ───────────────────────────────────
// Creates a ₹1 Razorpay order using LIVE credentials.
// Amount is server-enforced to 100 paise — client cannot override this.
// Returns { order_id, amount, currency, key_id }.

router.post('/create-order', requireAdmin, async (req, res) => {
  const rzp = getRazorpayClient();

  if (!rzp) {
    return res.status(503).json({ error: 'Live Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
  }

  // Confirm this is a live key — test keys have no purpose here
  const isLive = RAZORPAY_KEY_ID.startsWith('rzp_live_');
  if (!isLive) {
    console.warn(`[live-test] create-order called with non-live key (${RAZORPAY_KEY_ID.slice(0, 16)}…) by ${req.user.email}`);
    return res.status(400).json({ error: 'RAZORPAY_KEY_ID is not a live key (must start with rzp_live_). This endpoint only works with live credentials.' });
  }

  const receipt = `live-test-${Date.now()}`;

  try {
    console.log(`[live-test] create-order — admin ${req.user.email} initiating ₹1 live charge`);

    const order = await rzp.orders.create({
      amount  : LIVE_TEST_AMOUNT_PAISE,
      currency: LIVE_TEST_CURRENCY,
      receipt,
    });

    // Log to in-memory map for audit — no DB table needed
    liveTestOrders.set(order.id, {
      adminUserId: req.user.id,
      adminEmail : req.user.email,
      createdAt  : new Date().toISOString(),
      receipt,
    });

    console.log(`[live-test] order created — id=${order.id} amount=${order.amount} currency=${order.currency} admin=${req.user.email}`);

    res.json({
      order_id: order.id,
      amount  : order.amount,
      currency: order.currency,
      key_id  : RAZORPAY_KEY_ID,
    });
  } catch (err) {
    const desc = err?.error?.description || err.message || String(err);
    console.error(`[live-test] create-order failed for ${req.user.email}:`, desc);
    res.status(500).json({ error: `Razorpay order creation failed: ${desc}` });
  }
});

// ─── POST /api/admin/live-test/verify-and-refund ─────────────────────────────
// Verifies the Razorpay payment signature (HMAC-SHA256 with LIVE secret).
// On valid signature: immediately calls Razorpay Refunds API for full refund.
// On invalid signature: returns 400 — no refund initiated.
// Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
// Returns { verified, refund_id, refund_status, refund_amount, note }.

router.post('/verify-and-refund', requireAdmin, async (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(503).json({ error: 'Live Razorpay credentials not configured.' });
  }

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields: razorpay_payment_id, razorpay_order_id, razorpay_signature' });
  }

  console.log(`[live-test] verify-and-refund — payment=${razorpay_payment_id} order=${razorpay_order_id} admin=${req.user.email}`);

  // ── Step 1: Verify signature ──────────────────────────────────────────────
  // HMAC-SHA256 over "order_id|payment_id" using the LIVE secret
  const signatureBody = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSig   = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(signatureBody)
    .digest('hex');

  const signatureValid = expectedSig === razorpay_signature;

  if (!signatureValid) {
    console.warn(`[live-test] signature mismatch for order=${razorpay_order_id} payment=${razorpay_payment_id} — NOT refunding`);
    return res.status(400).json({
      verified: false,
      error   : 'Signature verification failed — payment not refunded. Do not retry with a manipulated payload.',
    });
  }

  console.log(`[live-test] signature verified ✓ — initiating refund for payment=${razorpay_payment_id}`);

  // ── Step 2: Issue refund via Razorpay Refunds API ─────────────────────────
  const refundResult = await callRazorpayRefund(razorpay_payment_id);

  if (!refundResult.ok) {
    // Refund failed — payment was real, surface the error clearly so admin can
    // manually refund via Razorpay dashboard. Do NOT mask payment success.
    console.error(`[live-test] refund FAILED for payment=${razorpay_payment_id} — HTTP ${refundResult.statusCode}: ${refundResult.error}`);
    return res.status(207).json({
      verified       : true,
      refund_initiated: false,
      refund_error   : refundResult.error,
      refund_http    : refundResult.statusCode,
      payment_id     : razorpay_payment_id,
      order_id       : razorpay_order_id,
      action_required: 'Refund failed. Please manually refund ₹1 via the Razorpay Dashboard → Payments → find this payment ID → Refund.',
      note           : 'Razorpay may retain paise-level platform fees on some plans — verify the final refunded amount in your Razorpay dashboard.',
    });
  }

  const refund = refundResult.refund;
  console.log(`[live-test] refund SUCCESS — refund_id=${refund.id} status=${refund.status} amount=${refund.amount} payment=${razorpay_payment_id}`);

  res.json({
    verified       : true,
    refund_initiated: true,
    refund_id      : refund.id,
    refund_status  : refund.status,
    refund_amount  : refund.amount,
    payment_id     : razorpay_payment_id,
    order_id       : razorpay_order_id,
    note           : 'Razorpay may retain paise-level platform fees on some plans — verify the final refunded amount in your Razorpay dashboard.',
  });
});

module.exports = router;
