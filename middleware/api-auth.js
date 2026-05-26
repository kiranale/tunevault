/**
 * middleware/api-auth.js — API key authentication for REST API v1.
 * Owns: Bearer token extraction, API key lookup, tier resolution, rate limiting.
 * Does NOT own: session cookie auth (middleware/auth.js), key generation (routes/settings-api.js).
 *
 * Rate limits per tier (per minute):
 *   enterprise: 100  business: 60  team: 30  individual: no API access
 */

const { getUserByApiKey } = require('../db/api-keys');
const pool = require('../db/index');
const { resolveTier } = require('../services/tier-limits');
const { ADMIN_EMAILS } = require('./auth');

// In-memory rate limit windows. Per-key sliding window (resets per minute bucket).
// Simple Map; adequate for single-process. Replace with Redis if multi-instance.
const rateLimitWindows = new Map();

const RATE_LIMITS = {
  enterprise: 100,
  business: 60,
  team: 30,
  individual: 0, // no API access
};

function getRateLimitForTier(tier) {
  return RATE_LIMITS[tier] ?? 0;
}

/**
 * Get or create a rate limit bucket for a key prefix.
 * Uses 1-minute fixed windows.
 */
function checkRateLimit(apiKeyId, tier) {
  const limit = getRateLimitForTier(tier);
  if (limit === 0) return { allowed: false, limit: 0, remaining: 0, resetIn: 60 };

  const now = Date.now();
  const windowMs = 60 * 1000;
  const windowKey = `${apiKeyId}:${Math.floor(now / windowMs)}`;

  // Clean stale entries occasionally (every ~100 checks)
  if (Math.random() < 0.01) {
    const cutoff = Math.floor(now / windowMs) - 1;
    for (const k of rateLimitWindows.keys()) {
      const parts = k.split(':');
      if (parseInt(parts[parts.length - 1], 10) < cutoff) {
        rateLimitWindows.delete(k);
      }
    }
  }

  const current = rateLimitWindows.get(windowKey) || 0;
  if (current >= limit) {
    const resetIn = Math.ceil((Math.floor(now / windowMs + 1) * windowMs - now) / 1000);
    return { allowed: false, limit, remaining: 0, resetIn };
  }

  rateLimitWindows.set(windowKey, current + 1);
  return { allowed: true, limit, remaining: limit - current - 1, resetIn: 60 };
}

/**
 * Resolve the effective tier for an API user.
 * Checks user_credits first, then team plan, then admin bypass.
 */
async function resolveUserTier(user) {
  const isAdmin = ADMIN_EMAILS.has((user.email || '').toLowerCase());
  if (isAdmin) return 'enterprise';

  try {
    // Check user_credits for plan tier
    const { rows } = await pool.query(
      `SELECT uc.plan_tier, t.plan_tier AS team_plan_tier
       FROM users u
       LEFT JOIN user_credits uc ON uc.user_id = u.id
       LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.id = $1`,
      [user.id]
    );
    if (rows[0]) {
      const planTier = rows[0].plan_tier || rows[0].team_plan_tier;
      return resolveTier(planTier, false);
    }
  } catch {
    // Fail open — don't block on DB error
  }
  return 'individual';
}

/**
 * Tier access gates per endpoint group:
 *   enterprise: all
 *   business: health + tuneops
 *   team: health only
 *   individual: none
 */
function tierHasAccess(tier, group) {
  const ACCESS = {
    enterprise: ['health', 'tuneops', 'activity', 'team'],
    business: ['health', 'tuneops'],
    team: ['health'],
    individual: [],
  };
  return (ACCESS[tier] || []).includes(group);
}

/**
 * requireApiKey(group) — factory middleware.
 * Verifies Authorization: Bearer tv_api_XXXX header.
 * Checks tier access for the given endpoint group.
 * Enforces rate limit.
 * Attaches req.apiUser, req.apiTier to request.
 */
function requireApiKey(group) {
  return async function apiKeyMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer tv_api_')) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'API key required. Include Authorization: Bearer tv_api_XXXX header.',
        }
      });
    }

    const rawKey = authHeader.slice(7); // Remove "Bearer "
    let user;
    try {
      user = await getUserByApiKey(rawKey);
    } catch (err) {
      console.error('[api-auth] key lookup error:', err.message);
      return res.status(500).json({ error: { code: 'internal_error', message: 'Authentication error' } });
    }

    if (!user) {
      return res.status(401).json({
        error: { code: 'invalid_api_key', message: 'Invalid or revoked API key' }
      });
    }

    // Resolve tier
    let tier;
    try {
      tier = await resolveUserTier(user);
    } catch {
      tier = 'individual';
    }

    // Check tier access
    if (!tierHasAccess(tier, group)) {
      const upgradeMessage = tier === 'individual'
        ? 'API access requires Team plan or higher. Upgrade at /pricing.'
        : `This endpoint requires ${group === 'activity' || group === 'team' ? 'Enterprise' : 'Business'} plan.`;
      return res.status(403).json({
        error: {
          code: 'tier_insufficient',
          message: upgradeMessage,
          required_tier: group === 'activity' || group === 'team' ? 'enterprise' : 'business',
          current_tier: tier,
        }
      });
    }

    // Rate limiting
    const rl = checkRateLimit(user.api_key_id, tier);
    res.setHeader('X-RateLimit-Limit', rl.limit);
    res.setHeader('X-RateLimit-Remaining', rl.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + rl.resetIn);

    if (!rl.allowed) {
      res.setHeader('Retry-After', rl.resetIn);
      return res.status(429).json({
        error: {
          code: 'rate_limited',
          message: `Rate limit exceeded. ${rl.limit} requests per minute for ${tier} tier.`,
          retry_after: rl.resetIn,
        }
      });
    }

    req.apiUser = user;
    req.apiTier = tier;
    next();
  };
}

module.exports = { requireApiKey, tierHasAccess };
