/**
 * routes/sso.js — SAML 2.0 SSO endpoints and SSO configuration API.
 * Owns: SP metadata, SAML login initiation, ACS callback, SSO settings CRUD,
 *       /settings/sso page, login page SSO check.
 * Does NOT own: session token creation (server.js createToken/finishAuth),
 *               user upsert (server.js upsertUser), MFA gate (server.js finishAuth).
 *
 * SAML endpoints:
 *   GET  /saml/metadata           — SP metadata XML (public)
 *   GET  /saml/login              — initiate SAML flow (?domain=example.com)
 *   POST /saml/callback           — ACS endpoint (receives SAMLResponse from IdP)
 *
 * Settings API (enterprise only):
 *   GET  /settings/sso            — SSO settings page
 *   GET  /api/sso/config          — get current user's SSO config
 *   PUT  /api/sso/config          — upsert SSO config for company domain
 *   DELETE /api/sso/config        — delete SSO config
 *   POST /api/sso/test            — initiate test flow (returns redirect URL)
 *   GET  /api/auth/sso-check      — whether any SSO is active (for login page)
 */

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/sso');
const dbTierUsage = require('../db/tier-usage');
const samlSvc = require('../services/saml');

const router = express.Router();

// Admin email set — enterprise bypass (mirrors server.js pattern)
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

// ─── Tier gate: SSO is Enterprise only ────────────────────────────────────────
// Uses db/tier-usage helpers — no direct Pool() construction in routes.
async function requireEnterpriseTier(req, res, next) {
  try {
    // Admin bypass
    if (ADMIN_EMAILS.has((req.user.email || '').toLowerCase())) return next();

    // Check team tier first
    const teamCtx = await dbTierUsage.getUserTeamContext(req.user.id);
    if (teamCtx) {
      if (teamCtx.planTier === 'enterprise') return next();
      return res.status(402).json({
        error: 'tier_limit_reached',
        limit_type: 'sso',
        message: 'SSO is available on the Enterprise plan.',
        upgrade_to: 'enterprise',
      });
    }

    // Individual user plan
    const planTier = await dbTierUsage.getUserPlanTier(req.user.id);
    if (planTier === 'enterprise') return next();

    return res.status(402).json({
      error: 'tier_limit_reached',
      limit_type: 'sso',
      message: 'SSO is available on the Enterprise plan.',
      upgrade_to: 'enterprise',
    });
  } catch (err) {
    console.error('[sso] requireEnterpriseTier error:', err.message);
    return res.status(500).json({ error: 'Auth error checking tier' });
  }
}

// ─── Public SAML endpoints ─────────────────────────────────────────────────────

// GET /saml/metadata — SP metadata XML (used by IdP admin to configure TuneVault as SP)
router.get('/saml/metadata', (req, res) => {
  const xml = samlSvc.generateSpMetadata();
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// GET /saml/login?domain=example.com — initiate SAML AuthnRequest
// Redirects user to IdP login page. Domain identifies which SSO config to use.
router.get('/saml/login', async (req, res) => {
  const domain = (req.query.domain || '').toLowerCase().trim();
  if (!domain) {
    return res.redirect('/login?error=sso_no_domain');
  }

  try {
    const config = await db.getSsoConfigByDomain(domain);
    if (!config) {
      await db.logSsoAttempt({
        company_domain: domain,
        succeeded: false,
        failure_reason: 'no_config',
        ip: req.ip,
        user_agent: req.headers['user-agent'],
      });
      return res.redirect('/login?error=sso_not_configured');
    }

    // RelayState = base64url of { domain, redirect }
    const redirect = (req.query.redirect || '/dashboard');
    const relayState = Buffer.from(JSON.stringify({ domain, redirect })).toString('base64url');

    const authnUrl = await samlSvc.generateAuthnRequestUrl(config, relayState);
    res.redirect(authnUrl);
  } catch (err) {
    console.error('[sso] /saml/login error:', err.message);
    res.redirect('/login?error=sso_error');
  }
});

// POST /saml/callback — ACS endpoint (receives SAMLResponse from IdP via HTTP POST)
// This route must be accessible without auth (user isn't logged in yet).
// express.urlencoded() body parser needed — mount it inline.
router.post('/saml/callback', express.urlencoded({ extended: false }), async (req, res) => {
  const samlResponse = req.body?.SAMLResponse;
  const relayStateRaw = req.body?.RelayState || '';

  // Parse relay state for domain + post-auth redirect
  let domain = '';
  let redirect = '/dashboard';
  try {
    const parsed = JSON.parse(Buffer.from(relayStateRaw, 'base64url').toString());
    domain = parsed.domain || '';
    if (parsed.redirect && parsed.redirect.startsWith('/')) redirect = parsed.redirect;
  } catch {
    // malformed relay state — domain will be empty, we'll error below
  }

  if (!samlResponse || !domain) {
    await db.logSsoAttempt({ company_domain: domain || 'unknown', succeeded: false, failure_reason: 'missing_response', ip: req.ip }).catch(() => {});
    return res.redirect('/login?error=sso_error');
  }

  try {
    const config = await db.getSsoConfigByDomain(domain);
    if (!config) {
      await db.logSsoAttempt({ company_domain: domain, succeeded: false, failure_reason: 'no_config', ip: req.ip }).catch(() => {});
      return res.redirect('/login?error=sso_not_configured');
    }

    // Validate SAML assertion (signature, timestamps, audience)
    const profile = await samlSvc.validateSamlResponse(config, samlResponse);

    // Extract email + name + groups from assertion
    const { email, name, groups } = samlSvc.extractUserAttributes(profile, config.attribute_mapping);
    if (!email) {
      await db.logSsoAttempt({ company_domain: domain, succeeded: false, failure_reason: 'no_email', ip: req.ip }).catch(() => {});
      return res.redirect('/login?error=sso_no_email');
    }

    // Resolve role from IdP groups
    const role = samlSvc.resolveRoleFromGroups(groups, config.group_role_mapping, config.default_role);

    // Upsert user — JIT provisioning for first SSO login
    // Uses the server.js pool via a lazy require (avoids circular dep)
    const { pool, upsertUser, finishAuth } = req.app.locals.authHelpers;
    const user = await upsertUser({ email, name, sso_provider: config.provider_type, company_domain: domain });

    // If team exists for this domain, ensure membership
    if (user.team_id) {
      await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.team_id, user.id, role]
      ).catch(() => {}); // non-fatal if team doesn't use SSO role mapping
    }

    await db.logSsoAttempt({ company_domain: domain, email, succeeded: true, ip: req.ip }).catch(() => {});

    // Create session (respects MFA gate)
    const authResult = await finishAuth(res, user.id, redirect);
    res.redirect(authResult.needsMfa ? '/mfa-challenge' : redirect);
  } catch (err) {
    console.error('[sso] /saml/callback error:', err.message);
    await db.logSsoAttempt({ company_domain: domain, succeeded: false, failure_reason: err.message?.substring(0, 200), ip: req.ip }).catch(() => {});
    res.redirect('/login?error=sso_error');
  }
});

// ─── Settings page ─────────────────────────────────────────────────────────────

// GET /settings/sso — SSO settings page (enterprise only)
router.get('/settings/sso', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('settings-sso.html', { root: 'public' });
});

// ─── SSO config API ────────────────────────────────────────────────────────────

// GET /api/sso/config — fetch current SSO config for user's company domain
router.get('/api/sso/config', requireAuth, requireEnterpriseTier, async (req, res) => {
  try {
    const config = await db.getSsoConfigForUser(req.user.email);
    if (!config) {
      return res.json({ configured: false });
    }
    // Never expose the full certificate in API response — return first/last 20 chars for verification
    const certPreview = config.certificate
      ? config.certificate.substring(0, 40) + '...' + config.certificate.slice(-20)
      : null;
    res.json({
      configured: true,
      id: config.id,
      company_domain: config.company_domain,
      provider_type: config.provider_type,
      sso_url: config.sso_url,
      entity_id: config.entity_id,
      certificate_preview: certPreview,
      attribute_mapping: config.attribute_mapping,
      group_role_mapping: config.group_role_mapping,
      default_role: config.default_role,
      is_active: config.is_active,
      require_sso: config.require_sso,
      sp_entity_id: samlSvc.SP_ENTITY_ID,
      acs_url: samlSvc.ACS_URL,
    });
  } catch (err) {
    console.error('[sso] GET /api/sso/config error:', err.message);
    res.status(500).json({ error: 'Failed to load SSO config' });
  }
});

// PUT /api/sso/config — create or update SSO config for user's company domain
router.put('/api/sso/config', requireAuth, requireEnterpriseTier, async (req, res) => {
  const {
    provider_type,
    sso_url,
    entity_id,
    certificate,
    attribute_mapping,
    group_role_mapping,
    default_role,
    is_active,
    require_sso,
  } = req.body;

  // Basic validation
  if (!sso_url || !entity_id || !certificate) {
    return res.status(400).json({ error: 'sso_url, entity_id, and certificate are required' });
  }

  // Derive company domain from authenticated user's email
  const domain = req.user.email?.split('@')[1]?.toLowerCase();
  if (!domain) {
    return res.status(400).json({ error: 'Cannot determine company domain from your email' });
  }

  try {
    const config = await db.upsertSsoConfig({
      company_domain: domain,
      provider_type: provider_type || 'custom',
      sso_url: sso_url.trim(),
      entity_id: entity_id.trim(),
      certificate: certificate.trim(),
      attribute_mapping,
      group_role_mapping,
      default_role: default_role || 'junior_dba',
      is_active: is_active !== false,
      require_sso: require_sso === true,
    });
    res.json({ success: true, config: { id: config.id, company_domain: config.company_domain } });
  } catch (err) {
    console.error('[sso] PUT /api/sso/config error:', err.message);
    res.status(500).json({ error: 'Failed to save SSO config' });
  }
});

// DELETE /api/sso/config — remove SSO config for user's company domain
router.delete('/api/sso/config', requireAuth, requireEnterpriseTier, async (req, res) => {
  const domain = req.user.email?.split('@')[1]?.toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Cannot determine company domain' });

  try {
    await db.deleteSsoConfig(domain);
    res.json({ success: true });
  } catch (err) {
    console.error('[sso] DELETE /api/sso/config error:', err.message);
    res.status(500).json({ error: 'Failed to delete SSO config' });
  }
});

// POST /api/sso/require — toggle require_sso for company domain
router.post('/api/sso/require', requireAuth, requireEnterpriseTier, async (req, res) => {
  const domain = req.user.email?.split('@')[1]?.toLowerCase();
  if (!domain) return res.status(400).json({ error: 'Cannot determine company domain' });

  const { required } = req.body;
  try {
    await db.setRequireSso(domain, required === true);
    res.json({ success: true, require_sso: required === true });
  } catch (err) {
    console.error('[sso] POST /api/sso/require error:', err.message);
    res.status(500).json({ error: 'Failed to update require_sso' });
  }
});

// GET /api/auth/sso-check?domain=example.com — whether SSO is configured for a domain
// Used by login page to show/hide SSO option and route to correct IdP.
router.get('/api/auth/sso-check', async (req, res) => {
  try {
    const { domain } = req.query;
    if (domain) {
      const config = await db.getSsoConfigByDomain(domain);
      return res.json({
        configured: !!config,
        require_sso: config?.require_sso || false,
        provider_type: config?.provider_type || null,
      });
    }
    // No domain — just check if any SSO exists
    const any = await db.hasSsoConfigured();
    res.json({ any_configured: any });
  } catch (err) {
    console.error('[sso] GET /api/auth/sso-check error:', err.message);
    res.json({ configured: false, any_configured: false });
  }
});

// GET /api/sso/sp-info — public SP info for IdP setup (no auth required)
router.get('/api/sso/sp-info', (req, res) => {
  res.json({
    sp_entity_id: samlSvc.SP_ENTITY_ID,
    acs_url: samlSvc.ACS_URL,
    metadata_url: `${process.env.APP_URL || 'https://tunevault.app'}/saml/metadata`,
  });
});

module.exports = router;
