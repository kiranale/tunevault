/**
 * middleware/tier-enforce.js — enforcement middleware for tier-based caps.
 *
 * Owns: 402 rejections for connection_count, member_count, health_check_count caps.
 * Does NOT own: tier definitions (services/tier-limits.js), usage queries (db/tier-usage.js),
 *               session auth (middleware/auth.js).
 *
 * All middlewares assume requireAuth has already run (req.user is populated).
 * Admin users (in ADMIN_EMAILS) bypass all caps.
 *
 * On cap hit, response shape is:
 *   { error: 'tier_limit_reached', limit_type, current, max, upgrade_to, tier }
 * with HTTP 402.
 */

const { ADMIN_EMAILS } = require('./auth');
const { resolveTier, getCaps, isAtCap } = require('../services/tier-limits');
const dbTierUsage = require('../db/tier-usage');

/**
 * Build a standardized 402 cap-hit response body.
 */
function capHitResponse(limitType, current, max, tier, upgradeTo) {
  return {
    error: 'tier_limit_reached',
    limit_type: limitType,
    current,
    max,
    tier,
    upgrade_to: upgradeTo,
  };
}

/**
 * Resolve the effective tier for req.user.
 * Admins get 'enterprise'. Other users: resolve from their plan_tier.
 */
async function resolveUserTier(user) {
  const isAdmin = ADMIN_EMAILS.has((user.email || '').toLowerCase());
  if (isAdmin) return { tier: 'enterprise', isAdmin: true };

  const planTier = await dbTierUsage.getUserPlanTier(user.id);
  const tier = resolveTier(planTier, false);
  return { tier, isAdmin: false, planTier };
}

// ─── enforceConnectionCap ───────────────────────────────────────────────────
//
// Usage: app.post('/api/connections', requireAuth, enforceConnectionCap, ...)
// Checks: user's active connection count vs tier max_connections cap.

async function enforceConnectionCap(req, res, next) {
  try {
    const { tier, isAdmin } = await resolveUserTier(req.user);
    if (isAdmin) return next();

    const caps = getCaps(tier);

    // Unlimited on this tier
    if (caps.max_connections === -1) return next();

    const current = await dbTierUsage.countUserConnections(req.user.id);
    if (isAtCap(current, caps.max_connections)) {
      return res.status(402).json(
        capHitResponse('connections', current, caps.max_connections, tier, caps.upgrade_to)
      );
    }

    next();
  } catch (err) {
    console.error('[tier-enforce] enforceConnectionCap error:', err.message);
    next(); // fail-open: don't block on quota check errors
  }
}

// ─── enforceMemberCap ────────────────────────────────────────────────────────
//
// Usage: router.post('/api/team/:teamId/invites', requireAuth, enforceMemberCap, ...)
// Checks: team's current member count vs tier max_members cap.
// req.params.teamId must be set.

async function enforceMemberCap(req, res, next) {
  try {
    const { tier, isAdmin } = await resolveUserTier(req.user);
    if (isAdmin) return next();

    const caps = getCaps(tier);

    if (caps.max_members === -1) return next();

    const teamId = parseInt(req.params.teamId, 10);
    if (!teamId) return next(); // no team context — skip

    const current = await dbTierUsage.countTeamMembers(teamId);
    if (isAtCap(current, caps.max_members)) {
      return res.status(402).json(
        capHitResponse('team_members', current, caps.max_members, tier, caps.upgrade_to)
      );
    }

    next();
  } catch (err) {
    console.error('[tier-enforce] enforceMemberCap error:', err.message);
    next(); // fail-open
  }
}

// ─── enforceHealthCheckCap ───────────────────────────────────────────────────
//
// Usage: app.post('/api/health-checks', requireAuth, enforceHealthCheckCap, ...)
// Checks: monthly health check count vs tier max_health_checks_per_month.
// This supplements (not replaces) the existing user_credits quota logic.
// For users with a paid plan_tier, the existing checkUserHCLimit handles debits.
// This middleware adds a hard structural cap for new tier names.

async function enforceHealthCheckCap(req, res, next) {
  try {
    // Skip for demo runs — demo quota is handled separately
    if (req.body && req.body.is_demo) return next();

    const { tier, isAdmin } = await resolveUserTier(req.user);
    if (isAdmin) return next();

    const caps = getCaps(tier);

    if (caps.max_health_checks_per_month === -1) return next();

    const current = await dbTierUsage.countMonthlyHealthChecks(req.user.id);
    if (isAtCap(current, caps.max_health_checks_per_month)) {
      return res.status(402).json(
        capHitResponse(
          'health_checks_monthly',
          current,
          caps.max_health_checks_per_month,
          tier,
          caps.upgrade_to
        )
      );
    }

    next();
  } catch (err) {
    console.error('[tier-enforce] enforceHealthCheckCap error:', err.message);
    next(); // fail-open
  }
}

module.exports = {
  enforceConnectionCap,
  enforceMemberCap,
  enforceHealthCheckCap,
};
