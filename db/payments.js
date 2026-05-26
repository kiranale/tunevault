/**
 * db/payments.js — payment, subscription, and user_credits queries.
 *
 * Owns: payments, subscriptions, user_credits tables.
 * Does NOT own: user auth, oracle connections, health check logic.
 */

const pool = require('./index');

// Pricing constants and calculation logic live in a single config module.
// Import from there — never define prices here directly.
const pricing = require('../config/pricing');

// Re-export for callers that reach db/payments.js for these functions
const { calcPerConnAmount, getPricingSummary } = pricing;
const CONN_PRICES_USD = pricing.CONN_PRICES; // backward-compat alias

// ─── PLAN CONFIGURATION ────────────────────────────────────────────────────

// Checks quota per plan tier (monthly). -1 = unlimited.
const PLAN_CHECKS = {
  free: 5,
  starter: 50,
  growth: 200,
  scale: -1,    // unlimited
  custom: -1,   // unlimited + priority
  // Per-connection tiers: unlimited checks, capped by connection/seat count
  individual: -1,
  team: -1,
  business: -1,
  enterprise: -1
};

// Annual multiplier for legacy flat tiers (10 months price = 2 months free)
const ANNUAL_MULTIPLIER = 10;

// Named getPlanPricePaise for backwards-compat; now returns USD cents
function getPlanPricePaise(tier, billing = 'monthly') {
  const monthly = pricing.LEGACY_PRICES[tier];
  if (!monthly) return null;
  return billing === 'annual' ? monthly * ANNUAL_MULTIPLIER : monthly;
}

function getPlanChecks(tier) {
  const val = PLAN_CHECKS[tier];
  return (val === undefined) ? 0 : val;
}

// Returns true when the plan has unlimited checks (scale, custom)
function isUnlimitedPlan(tier) {
  return PLAN_CHECKS[tier] === -1;
}

// ─── PAYMENTS ──────────────────────────────────────────────────────────────

async function createPaymentRecord({ userId, razorpayOrderId, amountPaise, currency, planTier, paymentType, billingPeriod }) {
  const result = await pool.query(
    `INSERT INTO payments
       (user_id, razorpay_order_id, amount_paise, currency, plan_tier, payment_type, billing_period, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'created')
     RETURNING *`,
    [userId, razorpayOrderId, amountPaise, currency || 'USD', planTier, paymentType, billingPeriod || 'monthly']
  );
  return result.rows[0];
}

async function markPaymentCaptured({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const result = await pool.query(
    `UPDATE payments
     SET razorpay_payment_id = $1,
         razorpay_signature  = $2,
         status              = 'captured',
         updated_at          = NOW()
     WHERE razorpay_order_id = $3
     RETURNING *`,
    [razorpayPaymentId, razorpaySignature, razorpayOrderId]
  );
  return result.rows[0] || null;
}

async function markPaymentFailed({ razorpayOrderId }) {
  await pool.query(
    `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE razorpay_order_id = $1`,
    [razorpayOrderId]
  );
}

async function getPaymentByOrderId(razorpayOrderId) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE razorpay_order_id = $1`,
    [razorpayOrderId]
  );
  return result.rows[0] || null;
}

async function getPaymentsByUserId(userId, limit = 20) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// ─── SUBSCRIPTIONS ─────────────────────────────────────────────────────────

async function createSubscriptionRecord({ userId, razorpaySubscriptionId, razorpayPlanId, planTier, billingPeriod }) {
  const result = await pool.query(
    `INSERT INTO subscriptions
       (user_id, razorpay_subscription_id, razorpay_plan_id, plan_tier, billing_period, status)
     VALUES ($1, $2, $3, $4, $5, 'created')
     ON CONFLICT (razorpay_subscription_id) DO UPDATE
       SET status = EXCLUDED.status, updated_at = NOW()
     RETURNING *`,
    [userId, razorpaySubscriptionId, razorpayPlanId, planTier, billingPeriod || 'monthly']
  );
  return result.rows[0];
}

async function updateSubscriptionStatus({ razorpaySubscriptionId, status, periodStart, periodEnd, cancelledAt }) {
  const result = await pool.query(
    `UPDATE subscriptions
     SET status               = $1,
         current_period_start = COALESCE($2, current_period_start),
         current_period_end   = COALESCE($3, current_period_end),
         cancelled_at         = COALESCE($4, cancelled_at),
         updated_at           = NOW()
     WHERE razorpay_subscription_id = $5
     RETURNING *`,
    [status, periodStart || null, periodEnd || null, cancelledAt || null, razorpaySubscriptionId]
  );
  return result.rows[0] || null;
}

async function getSubscriptionByRazorpayId(razorpaySubscriptionId) {
  const result = await pool.query(
    `SELECT * FROM subscriptions WHERE razorpay_subscription_id = $1`,
    [razorpaySubscriptionId]
  );
  return result.rows[0] || null;
}

async function getActiveSubscriptionByUserId(userId) {
  const result = await pool.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status IN ('authenticated','active','pending')
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ─── USER CREDITS ──────────────────────────────────────────────────────────

async function getUserCredits(userId) {
  const result = await pool.query(
    `SELECT * FROM user_credits WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// UNLIMITED_SENTINEL: stored in DB for unlimited plans (scale/custom) so that
// checks_remaining > 0 comparisons work without special-casing everywhere.
const UNLIMITED_SENTINEL = 999999999;

async function upsertUserCredits({ userId, planTier, checksTotal, subscriptionId, periodStart, periodEnd }) {
  // Use sentinel for unlimited plans so DB comparisons remain simple
  const effectiveTotal = checksTotal === -1 ? UNLIMITED_SENTINEL : checksTotal;
  // Reset checks_remaining to full quota on new payment
  const result = await pool.query(
    `INSERT INTO user_credits
       (user_id, plan_tier, checks_remaining, checks_total, subscription_id, period_start, period_end)
     VALUES ($1, $2, $3, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE
       SET plan_tier         = EXCLUDED.plan_tier,
           checks_remaining  = EXCLUDED.checks_remaining,
           checks_total      = EXCLUDED.checks_total,
           subscription_id   = COALESCE(EXCLUDED.subscription_id, user_credits.subscription_id),
           period_start      = COALESCE(EXCLUDED.period_start, user_credits.period_start),
           period_end        = COALESCE(EXCLUDED.period_end, user_credits.period_end),
           updated_at        = NOW()
     RETURNING *`,
    [userId, planTier, effectiveTotal, subscriptionId || null, periodStart || null, periodEnd || null]
  );
  return result.rows[0];
}

// Reset a user's credits to zero. Used by the admin test harness to ensure
// each test run starts from a clean baseline so the 0 → planChecks transition
// is validated on every run. Not used in production payment flows.
async function resetUserCredits(userId) {
  await pool.query(
    `DELETE FROM user_credits WHERE user_id = $1`,
    [userId]
  );
}

// ─── USER LOOKUP (for post-payment notifications) ──────────────────────────

// Returns { id, email, name } for a user — used by welcome email sender
// to get the email address after a webhook-triggered plan unlock.
async function getUserById(userId) {
  const result = await pool.query(
    `SELECT id, email, name FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ─── RECONCILIATION LOG ─────────────────────────────────────────────────────

// Append-only error log for payment events that could not be fully processed.
// Called when plan unlock or welcome email fails — provides a record for
// manual review without blocking the webhook 200 response.
async function logReconciliation({ eventType, razorpayPaymentId, razorpayOrderId, userId, userEmail, planTier, failureStage, errorMessage, metadata }) {
  try {
    await pool.query(
      `INSERT INTO payment_reconciliation
         (event_type, razorpay_payment_id, razorpay_order_id, user_id, user_email, plan_tier, failure_stage, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        eventType,
        razorpayPaymentId || null,
        razorpayOrderId   || null,
        userId            || null,
        userEmail         || null,
        planTier          || null,
        failureStage,
        errorMessage      || null,
        JSON.stringify(metadata || {})
      ]
    );
  } catch (logErr) {
    // Last-resort: if even the reconciliation log fails, emit to stdout
    // so it reaches Render logs / Datadog
    console.error('[payments] CRITICAL: reconciliation log write failed:', logErr.message);
  }
}

// ─── SCHEDULED PLAN CHANGES ────────────────────────────────────────────────

// Set a scheduled downgrade/cancel on the user_credits row.
// Does NOT immediately change plan_tier — takes effect on scheduled_plan_change_date.
async function scheduleDowngrade({ userId, targetTier, effectiveDate, cancelAtPeriodEnd }) {
  const result = await pool.query(
    `UPDATE user_credits
     SET scheduled_plan_change      = $1,
         scheduled_plan_change_date = $2,
         cancel_at_period_end       = $3,
         updated_at                 = NOW()
     WHERE user_id = $4
     RETURNING *`,
    [targetTier || null, effectiveDate || null, cancelAtPeriodEnd || false, userId]
  );
  return result.rows[0] || null;
}

// Clear a pending scheduled change (e.g., user re-upgrades before period end).
async function clearScheduledChange(userId) {
  const result = await pool.query(
    `UPDATE user_credits
     SET scheduled_plan_change      = NULL,
         scheduled_plan_change_date = NULL,
         cancel_at_period_end       = FALSE,
         updated_at                 = NOW()
     WHERE user_id = $1
     RETURNING *`,
    [userId]
  );
  return result.rows[0] || null;
}

// Apply any due scheduled changes for users whose change_date has passed.
// Called lazily on login / plan-state fetch; also safe to run on a cron.
async function applyDueScheduledChanges() {
  const result = await pool.query(
    `UPDATE user_credits
     SET plan_tier                  = CASE
           WHEN cancel_at_period_end OR scheduled_plan_change = 'free' THEN 'free'
           WHEN scheduled_plan_change IS NOT NULL THEN scheduled_plan_change
           ELSE plan_tier
         END,
         checks_remaining           = CASE
           WHEN cancel_at_period_end OR scheduled_plan_change = 'free' THEN 5
           ELSE checks_remaining
         END,
         checks_total               = CASE
           WHEN cancel_at_period_end OR scheduled_plan_change = 'free' THEN 5
           ELSE checks_total
         END,
         scheduled_plan_change      = NULL,
         scheduled_plan_change_date = NULL,
         cancel_at_period_end       = FALSE,
         updated_at                 = NOW()
     WHERE (scheduled_plan_change IS NOT NULL OR cancel_at_period_end = TRUE)
       AND scheduled_plan_change_date <= NOW()
     RETURNING user_id, plan_tier`,
    []
  );
  return result.rows;
}

async function decrementUserCredit(userId) {
  // Returns updated credits row; caller checks checks_remaining before running a health check.
  // Unlimited plans use UNLIMITED_SENTINEL — we never decrement them past 0.
  const result = await pool.query(
    `UPDATE user_credits
     SET checks_remaining = CASE
           WHEN checks_remaining >= $2 THEN checks_remaining  -- unlimited sentinel: don't decrement
           ELSE GREATEST(checks_remaining - 1, 0)
         END,
         updated_at = NOW()
     WHERE user_id = $1 AND checks_remaining > 0
     RETURNING *`,
    [userId, UNLIMITED_SENTINEL]
  );
  return result.rows[0] || null;
}

module.exports = {
  getPlanPricePaise,
  calcPerConnAmount,
  getPricingSummary,
  getPlanChecks,
  isUnlimitedPlan,
  PLAN_PRICES_USD: pricing.LEGACY_PRICES,  // backward-compat alias
  CONN_PRICES_USD,
  PLAN_CHECKS,
  UNLIMITED_SENTINEL,
  // payments
  createPaymentRecord,
  markPaymentCaptured,
  markPaymentFailed,
  getPaymentByOrderId,
  getPaymentsByUserId,
  // subscriptions
  createSubscriptionRecord,
  updateSubscriptionStatus,
  getSubscriptionByRazorpayId,
  getActiveSubscriptionByUserId,
  // user credits
  getUserCredits,
  upsertUserCredits,
  decrementUserCredit,
  resetUserCredits,
  // scheduled plan changes
  scheduleDowngrade,
  clearScheduledChange,
  applyDueScheduledChanges,
  // post-payment helpers
  getUserById,
  logReconciliation
};
