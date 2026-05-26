/**
 * db/sso.js — SSO configuration and login audit persistence.
 * Owns: sso_configs CRUD, sso_login_log writes, domain-to-config lookup.
 * Does NOT own: SAML validation, session creation, user upsert — those live in services/saml.js and server.js.
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

/**
 * Get the active SSO config for a company domain.
 * Returns null if not found or not active.
 * @param {string} domain
 * @returns {Promise<object|null>}
 */
async function getSsoConfigByDomain(domain) {
  const res = await pool.query(
    `SELECT * FROM sso_configs WHERE company_domain = $1 AND is_active = TRUE LIMIT 1`,
    [domain.toLowerCase().trim()]
  );
  return res.rows[0] || null;
}

/**
 * Get SSO config by ID (for settings management).
 * @param {number} id
 * @returns {Promise<object|null>}
 */
async function getSsoConfigById(id) {
  const res = await pool.query(`SELECT * FROM sso_configs WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

/**
 * Get SSO config for the authenticated user's company domain.
 * @param {string} userEmail
 * @returns {Promise<object|null>}
 */
async function getSsoConfigForUser(userEmail) {
  const domain = userEmail.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  return getSsoConfigByDomain(domain);
}

/**
 * Upsert SSO config for a company domain. Creates or fully replaces.
 * @param {object} cfg
 * @returns {Promise<object>}
 */
async function upsertSsoConfig({
  company_domain,
  provider_type,
  sso_url,
  entity_id,
  certificate,
  attribute_mapping,
  group_role_mapping,
  default_role,
  is_active,
  require_sso,
}) {
  const res = await pool.query(
    `INSERT INTO sso_configs
       (company_domain, provider_type, sso_url, entity_id, certificate,
        attribute_mapping, group_role_mapping, default_role, is_active, require_sso,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
     ON CONFLICT (company_domain) DO UPDATE SET
       provider_type      = EXCLUDED.provider_type,
       sso_url            = EXCLUDED.sso_url,
       entity_id          = EXCLUDED.entity_id,
       certificate        = EXCLUDED.certificate,
       attribute_mapping  = EXCLUDED.attribute_mapping,
       group_role_mapping = EXCLUDED.group_role_mapping,
       default_role       = EXCLUDED.default_role,
       is_active          = EXCLUDED.is_active,
       require_sso        = EXCLUDED.require_sso,
       updated_at         = NOW()
     RETURNING *`,
    [
      company_domain.toLowerCase().trim(),
      provider_type || 'custom',
      sso_url,
      entity_id,
      certificate,
      JSON.stringify(attribute_mapping || { email: 'nameID', name: 'displayName' }),
      JSON.stringify(group_role_mapping || {}),
      default_role || 'junior_dba',
      is_active !== false,
      require_sso === true,
    ]
  );
  return res.rows[0];
}

/**
 * Delete SSO config for a domain.
 * @param {string} domain
 */
async function deleteSsoConfig(domain) {
  await pool.query(
    `DELETE FROM sso_configs WHERE company_domain = $1`,
    [domain.toLowerCase().trim()]
  );
}

/**
 * Toggle require_sso for a domain.
 * @param {string} domain
 * @param {boolean} required
 */
async function setRequireSso(domain, required) {
  await pool.query(
    `UPDATE sso_configs SET require_sso = $2, updated_at = NOW() WHERE company_domain = $1`,
    [domain.toLowerCase().trim(), required]
  );
}

/**
 * Log an SSO login attempt (audit trail).
 * @param {object} entry
 */
async function logSsoAttempt({ company_domain, email, succeeded, failure_reason, ip, user_agent }) {
  await pool.query(
    `INSERT INTO sso_login_log (company_domain, email, succeeded, failure_reason, ip, user_agent, attempted_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [company_domain, email || null, succeeded, failure_reason || null, ip || null, user_agent || null]
  ).catch(() => {}); // audit failures are non-fatal
}

/**
 * Check if any company has SSO configured (for login page button visibility).
 * @returns {Promise<boolean>}
 */
async function hasSsoConfigured() {
  const res = await pool.query(
    `SELECT 1 FROM sso_configs WHERE is_active = TRUE LIMIT 1`
  );
  return res.rows.length > 0;
}

module.exports = {
  getSsoConfigByDomain,
  getSsoConfigById,
  getSsoConfigForUser,
  upsertSsoConfig,
  deleteSsoConfig,
  setRequireSso,
  logSsoAttempt,
  hasSsoConfigured,
};
