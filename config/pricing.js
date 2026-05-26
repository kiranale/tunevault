/**
 * config/pricing.js — Single source of truth for all TuneVault plan pricing.
 *
 * Owns: canonical price constants for every tier × billing-period combo.
 * Does NOT own: Razorpay order creation, user credits, quota limits.
 *
 * To add a new plan: add an entry to CONN_PRICES and ANNUAL_DISCOUNT handles
 * the rest automatically. Update CLAUDE.md with the new tier name and price.
 */

'use strict';

// Per-connection pricing in USD cents per connection per month (monthly rate).
// Enterprise has no per-seat fee — unlimited users are included.
const CONN_PRICES = {
  individual: { conn: 4900, seat:    0 },  // $49/conn/mo
  team:       { conn: 3900, seat: 2900 },  // $39/conn/mo + $29/seat/mo
  business:   { conn: 2900, seat: 1900 },  // $29/conn/mo + $19/seat/mo
  enterprise: { conn: 1900, seat:    0 }   // $19/conn/mo, unlimited users
};

// Annual billing: 20% off the monthly rate, charged upfront for 12 months.
const ANNUAL_DISCOUNT = 0.8;

// Enterprise volume discounts by connection count.
// Mirrors the frontend entVolumeDiscount() in pricing.html.
const ENTERPRISE_VOLUME_THRESHOLDS = [
  { min: 150, discount: 0.15 },
  { min: 100, discount: 0.10 }
];

/**
 * Returns the enterprise volume discount multiplier (0–1) for a given connection count.
 * 150+ connections → 15% off, 100+ → 10% off, below 100 → 0%.
 */
function enterpriseVolumeDiscount(connectionCount) {
  for (const t of ENTERPRISE_VOLUME_THRESHOLDS) {
    if (connectionCount >= t.min) return t.discount;
  }
  return 0;
}

// List of tiers that use per-connection pricing (vs legacy flat tiers).
const PER_CONN_TIERS = ['individual', 'team', 'business', 'enterprise'];

// Legacy flat-rate tiers kept for backwards compatibility with old subscriptions.
const LEGACY_PRICES = {
  starter: 2900,   // $29/mo
  growth:  7900,   // $79/mo
  scale:   19900,  // $199/mo
  custom:  49900   // $499/mo
};

/**
 * Calculate the Razorpay order amount in USD cents for a per-connection order.
 *
 * Monthly:  (conn_rate × conns) + (seat_rate × seats)
 * Annual:   monthly_total × 12 × 0.8, billed upfront (20% off)
 *
 * Returns null if tier is unrecognised.
 * connection_count is clamped to [1, 200]; seat_count to [0, 100].
 */
function calcPerConnAmount(tier, billing, connectionCount, seatCount) {
  const rates = CONN_PRICES[tier];
  if (!rates) return null;

  const conns = Math.max(1, Math.min(200, parseInt(connectionCount) || 1));
  const seats = Math.max(0, Math.min(100, parseInt(seatCount) || 0));

  const baseMonthly = (rates.conn * conns) + (rates.seat * seats);

  // Apply enterprise volume discount (100+ conns → 10%, 150+ → 15%).
  // Round to nearest whole dollar (×100) to match the frontend which rounds in dollar space.
  const volDisc = (tier === 'enterprise') ? enterpriseVolumeDiscount(conns) : 0;
  const monthlyTotal = volDisc > 0
    ? Math.round(baseMonthly * (1 - volDisc) / 100) * 100
    : baseMonthly;

  let amount, description;
  if (billing === 'annual') {
    amount = Math.round(monthlyTotal * 12 * ANNUAL_DISCOUNT);
    const connMonthly = Math.round(rates.conn * (1 - volDisc) * ANNUAL_DISCOUNT / 100);
    const seatMonthly = rates.seat ? Math.round(rates.seat * ANNUAL_DISCOUNT / 100) : 0;
    description = `TuneVault ${tier} — ${conns} conn${conns > 1 ? 's' : ''} × $${connMonthly}/mo`
      + (seats > 0 ? ` + ${seats} seat${seats > 1 ? 's' : ''} × $${seatMonthly}/mo` : '')
      + (volDisc > 0 ? ` (${Math.round(volDisc * 100)}% vol. discount, ` : ' (')
      + `annual, 20% off)`;
  } else {
    amount = monthlyTotal;
    const effectiveRate = Math.round(rates.conn * (1 - volDisc));
    const connDollars = effectiveRate / 100;
    const seatDollars = rates.seat / 100;
    description = `TuneVault ${tier} — ${conns} conn${conns > 1 ? 's' : ''} × $${connDollars}/mo`
      + (seats > 0 ? ` + ${seats} seat${seats > 1 ? 's' : ''} × $${seatDollars}/mo` : '')
      + (volDisc > 0 ? ` (${Math.round(volDisc * 100)}% vol. discount)` : '');
  }

  return { amount, description, connectionCount: conns, seatCount: seats };
}

/**
 * Returns the legacy flat-tier price in USD cents.
 * Annual billing uses a 10-month rate (2 months free) for legacy tiers only.
 */
function getLegacyPrice(tier, billing) {
  const monthly = LEGACY_PRICES[tier];
  if (!monthly) return null;
  return billing === 'annual' ? monthly * 10 : monthly;
}

/**
 * Returns a public-safe pricing summary suitable for the GET /api/payments/pricing
 * endpoint. No secrets — just the numbers the frontend needs to display prices
 * and pre-fill checkout amounts for validation.
 */
function getPricingSummary() {
  return {
    tiers: {
      individual: {
        monthly: { conn: CONN_PRICES.individual.conn, seat: 0 },
        annual:   {
          conn: Math.round(CONN_PRICES.individual.conn * ANNUAL_DISCOUNT),
          seat: 0,
          note: '20% off, billed upfront × 12'
        }
      },
      team: {
        monthly: { conn: CONN_PRICES.team.conn, seat: CONN_PRICES.team.seat },
        annual:   {
          conn: Math.round(CONN_PRICES.team.conn * ANNUAL_DISCOUNT),
          seat: Math.round(CONN_PRICES.team.seat * ANNUAL_DISCOUNT),
          note: '20% off, billed upfront × 12'
        }
      },
      business: {
        monthly: { conn: CONN_PRICES.business.conn, seat: CONN_PRICES.business.seat },
        annual:   {
          conn: Math.round(CONN_PRICES.business.conn * ANNUAL_DISCOUNT),
          seat: Math.round(CONN_PRICES.business.seat * ANNUAL_DISCOUNT),
          note: '20% off, billed upfront × 12'
        }
      },
      enterprise: {
        monthly: { conn: CONN_PRICES.enterprise.conn, seat: 0 },
        annual:   {
          conn: Math.round(CONN_PRICES.enterprise.conn * ANNUAL_DISCOUNT),
          seat: 0,
          note: '20% off, billed upfront × 12'
        }
      }
    },
    currency: 'USD',
    annual_discount_pct: 20
  };
}

module.exports = {
  CONN_PRICES,
  ANNUAL_DISCOUNT,
  ENTERPRISE_VOLUME_THRESHOLDS,
  PER_CONN_TIERS,
  LEGACY_PRICES,
  calcPerConnAmount,
  enterpriseVolumeDiscount,
  getLegacyPrice,
  getPricingSummary
};
