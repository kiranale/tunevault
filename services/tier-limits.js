/**
 * services/tier-limits.js — per-tier capability caps for TuneVault.
 *
 * Owns: tier definitions, cap constants, tier resolution from user state.
 * Does NOT own: quota enforcement (middleware/tier-enforce.js), usage tracking (db/tier-usage.js).
 *
 * Tier mapping:
 *   individual → free / starter / growth (individual paying plans)
 *   team       → team plan
 *   business   → scale plan
 *   enterprise → custom plan (+ admin bypass)
 *
 * The "plan_tier" stored in user_credits / teams maps to these tiers.
 */

// Per-tier caps. -1 = unlimited.
const TIER_LIMITS = {
  individual: {
    max_connections: 5,
    max_members: 1,
    max_health_checks_per_month: 100,
    upgrade_to: 'team',
  },
  team: {
    max_connections: 25,
    max_members: 5,
    max_health_checks_per_month: 500,
    upgrade_to: 'business',
  },
  business: {
    max_connections: 50,
    max_members: 25,
    max_health_checks_per_month: -1, // unlimited
    upgrade_to: 'enterprise',
  },
  enterprise: {
    max_connections: -1,
    max_members: -1,
    max_health_checks_per_month: -1,
    upgrade_to: null,
  },
};

// Maps legacy plan_tier values → new tier names.
// A user with no plan_tier (free) maps to 'individual' caps.
const PLAN_TO_TIER = {
  free: 'individual',
  starter: 'individual',
  growth: 'individual',
  scale: 'business',
  custom: 'enterprise',
  team: 'team',
  business: 'business',
  enterprise: 'enterprise',
};

/**
 * Resolve the effective tier name for a user given their plan_tier string.
 * @param {string|null} planTier - plan_tier from user_credits or teams table
 * @param {boolean} isAdmin - whether the user is in ADMIN_EMAILS
 * @returns {string} tier name ('individual'|'team'|'business'|'enterprise')
 */
function resolveTier(planTier, isAdmin = false) {
  if (isAdmin) return 'enterprise';
  return PLAN_TO_TIER[planTier] || 'individual';
}

/**
 * Get the cap object for a tier.
 * @param {string} tier
 * @returns {{ max_connections, max_members, max_health_checks_per_month, upgrade_to }}
 */
function getCaps(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.individual;
}

/**
 * Check if a value exceeds a cap. Returns true if at or over limit.
 * cap of -1 means unlimited.
 */
function isAtCap(current, max) {
  if (max === -1) return false;
  return current >= max;
}

module.exports = {
  TIER_LIMITS,
  PLAN_TO_TIER,
  resolveTier,
  getCaps,
  isAtCap,
};
