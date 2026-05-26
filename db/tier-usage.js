/**
 * db/tier-usage.js — live usage counters for tier enforcement.
 *
 * Owns: queries that count active resources against tier caps.
 * Does NOT own: tier cap definitions (services/tier-limits.js), enforcement logic (middleware/tier-enforce.js).
 *
 * All counts are live from the DB — no caching. Acceptable for low-frequency write paths
 * (add connection, add member, start health check) where stale reads would defeat the cap.
 */

const pool = require('./index');
const dbPayments = require('./payments');
const dbTeams = require('./teams');

/**
 * Count active connections owned by a user.
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function countUserConnections(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM oracle_connections WHERE user_id = $1`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

/**
 * Count active team members (current members, not pending invites).
 * @param {number} teamId
 * @returns {Promise<number>}
 */
async function countTeamMembers(teamId) {
  return dbTeams.getTeamMemberCount(teamId);
}

/**
 * Count health checks run by a user in the current calendar month.
 * Uses health_checks table scoped by connection ownership.
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function countMonthlyHealthChecks(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count
     FROM health_checks hc
     JOIN oracle_connections oc ON oc.id = hc.connection_id
     WHERE oc.user_id = $1
       AND hc.is_demo = false
       AND hc.created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

/**
 * Get the effective plan tier for a user.
 * Returns plan_tier from user_credits if present, else 'free'.
 * Admins are handled by the caller (ADMIN_EMAILS set).
 * @param {number} userId
 * @returns {Promise<string>} plan_tier string
 */
async function getUserPlanTier(userId) {
  const credits = await dbPayments.getUserCredits(userId);
  return credits?.plan_tier || 'free';
}

/**
 * Get the team plan tier for the team the user belongs to.
 * Returns plan_tier from teams table if user is on a team, else null.
 * @param {number} userId
 * @returns {Promise<{teamId: number, planTier: string}|null>}
 */
async function getUserTeamContext(userId) {
  const team = await dbTeams.getTeamForUser(userId);
  if (!team) return null;
  return { teamId: team.id, planTier: team.plan_tier || 'team' };
}

/**
 * Aggregate all live usage counters for a user, for the billing/usage endpoint.
 * @param {number} userId
 * @returns {Promise<{connections: number, team_members: number, health_checks_this_month: number}>}
 */
async function getUserUsageCounters(userId) {
  const [connections, healthChecks] = await Promise.all([
    countUserConnections(userId),
    countMonthlyHealthChecks(userId),
  ]);

  // Get team member count if user is on a team
  const teamCtx = await getUserTeamContext(userId);
  const teamMembers = teamCtx ? await countTeamMembers(teamCtx.teamId) : 1; // solo = 1

  return {
    connections,
    team_members: teamMembers,
    health_checks_this_month: healthChecks,
  };
}

// Personal email domains that fall back to per-email usage tracking (not company-shared).
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'aol.com', 'yandex.com', 'yandex.ru', 'mail.com', 'zoho.com',
  'tutanota.com', 'fastmail.com', 'hey.com',
]);

/**
 * Read-only lookup of free-tier health check usage for a user.
 * Business email users: quota is shared across the company domain (company_hc_usage).
 * Personal email users: quota is per individual email (user_hc_usage).
 * Does NOT increment — call only for display purposes.
 * Returns { hc_used, hc_limit, hc_remaining, is_free_tier }.
 * @param {string} email — user email
 * @param {number|null} userId — if provided, checks whether user is on a paid plan
 * @param {string|null} companyDomain — from users.company_domain (may differ from email domain)
 * @returns {Promise<{hc_used: number, hc_limit: number, hc_remaining: number, is_free_tier: boolean}>}
 */
async function getFreeHCUsage(email, userId, companyDomain) {
  const HC_FREE_LIMIT = 5;

  // Check if user has a paid plan — if so, not free tier
  if (userId) {
    const credits = await dbPayments.getUserCredits(userId);
    if (credits && ['starter', 'growth', 'scale', 'custom', 'team', 'business', 'enterprise'].includes(credits.plan_tier)) {
      return { hc_used: 0, hc_limit: null, hc_remaining: null, is_free_tier: false };
    }
  }

  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail) return { hc_used: 0, hc_limit: HC_FREE_LIMIT, hc_remaining: HC_FREE_LIMIT, is_free_tier: true };

  const emailDomain = normalizedEmail.split('@')[1] || '';
  const effectiveDomain = companyDomain || emailDomain;
  const isPersonalDomain = PERSONAL_EMAIL_DOMAINS.has(emailDomain);

  let hc_used = 0;
  if (!isPersonalDomain && effectiveDomain) {
    // Business domain: read shared company quota
    const { rows } = await pool.query(
      `SELECT hc_count FROM company_hc_usage WHERE company_domain = $1`,
      [effectiveDomain]
    );
    hc_used = rows.length > 0 ? parseInt(rows[0].hc_count, 10) : 0;
  } else {
    // Personal domain: read individual email quota
    const { rows } = await pool.query(
      `SELECT hc_count FROM user_hc_usage WHERE user_email = $1`,
      [normalizedEmail]
    );
    hc_used = rows.length > 0 ? parseInt(rows[0].hc_count, 10) : 0;
  }

  const hc_remaining = Math.max(0, HC_FREE_LIMIT - hc_used);
  return { hc_used, hc_limit: HC_FREE_LIMIT, hc_remaining, is_free_tier: true };
}

module.exports = {
  countUserConnections,
  countTeamMembers,
  countMonthlyHealthChecks,
  getUserPlanTier,
  getUserTeamContext,
  getUserUsageCounters,
  getFreeHCUsage,
};
