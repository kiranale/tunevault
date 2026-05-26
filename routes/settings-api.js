/**
 * routes/settings-api.js — API key management UI + CRUD.
 * Owns: /settings/api page, /api/keys/* CRUD for authenticated users.
 * Does NOT own: key authentication middleware (middleware/api-auth.js), v1 endpoints (routes/v1-api.js).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { createApiKey, listApiKeys, revokeApiKey, revokeAllApiKeys } = require('../db/api-keys');
const pool = require('../db/index');
const { resolveTier } = require('../services/tier-limits');
const { ADMIN_EMAILS } = require('../middleware/auth');

// GET /settings/api — API key management page
router.get('/api', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings-api.html'));
});

// GET /api/keys — list current user's API keys
router.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);

    // Also return tier info so UI can show access level
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
    let tier = 'individual';
    if (!isAdmin) {
      const { rows } = await pool.query(
        `SELECT uc.plan_tier, t.plan_tier AS team_plan_tier
         FROM users u
         LEFT JOIN user_credits uc ON uc.user_id = u.id
         LEFT JOIN teams t ON t.id = u.team_id
         WHERE u.id = $1`,
        [req.user.id]
      );
      if (rows[0]) {
        tier = resolveTier(rows[0].plan_tier || rows[0].team_plan_tier, false);
      }
    } else {
      tier = 'enterprise';
    }

    const TIER_RATE_LIMITS = {
      enterprise: 100,
      business: 60,
      team: 30,
      individual: 0,
    };

    const TIER_ACCESS = {
      enterprise: 'Full API access (health, TuneOps, activity, team)',
      business: 'Health data + TuneOps endpoints',
      team: 'Health data endpoints only',
      individual: 'No API access — upgrade to Team plan or higher',
    };

    res.json({
      keys,
      tier,
      rate_limit_per_min: TIER_RATE_LIMITS[tier] || 0,
      access_description: TIER_ACCESS[tier] || 'No access',
      has_access: tier !== 'individual',
    });
  } catch (err) {
    console.error('[settings-api] GET /api/keys error:', err.message);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// POST /api/keys — create a new API key
router.post('/api/keys', requireAuth, async (req, res) => {
  try {
    // Check tier access
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
    let tier = 'individual';
    if (!isAdmin) {
      const { rows } = await pool.query(
        `SELECT uc.plan_tier, t.plan_tier AS team_plan_tier
         FROM users u
         LEFT JOIN user_credits uc ON uc.user_id = u.id
         LEFT JOIN teams t ON t.id = u.team_id
         WHERE u.id = $1`,
        [req.user.id]
      );
      if (rows[0]) {
        tier = resolveTier(rows[0].plan_tier || rows[0].team_plan_tier, false);
      }
    } else {
      tier = 'enterprise';
    }

    if (tier === 'individual') {
      return res.status(403).json({
        error: 'API access requires Team plan or higher',
        upgrade_url: '/pricing',
      });
    }

    // Max 5 active keys per user
    const existing = await listApiKeys(req.user.id);
    if (existing.length >= 5) {
      return res.status(400).json({ error: 'Maximum 5 API keys allowed. Revoke an existing key first.' });
    }

    const name = (req.body.name || '').trim().substring(0, 100) || null;
    const result = await createApiKey(req.user.id, name);

    res.status(201).json({
      key: result,
      // raw_key shown ONCE — never stored unmasked
      raw_key: result.raw_key,
      message: 'Save this key now — it will not be shown again.',
    });
  } catch (err) {
    console.error('[settings-api] POST /api/keys error:', err.message);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// DELETE /api/keys/:id — revoke a specific key
router.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const keyId = parseInt(req.params.id, 10);
    const revoked = await revokeApiKey(keyId, req.user.id);
    if (!revoked) {
      return res.status(404).json({ error: 'Key not found or already revoked' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[settings-api] DELETE /api/keys/:id error:', err.message);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// POST /api/keys/regenerate — revoke all keys and create a fresh one
router.post('/api/keys/regenerate', requireAuth, async (req, res) => {
  try {
    const isAdmin = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
    let tier = 'individual';
    if (!isAdmin) {
      const { rows } = await pool.query(
        `SELECT uc.plan_tier, t.plan_tier AS team_plan_tier
         FROM users u
         LEFT JOIN user_credits uc ON uc.user_id = u.id
         LEFT JOIN teams t ON t.id = u.team_id
         WHERE u.id = $1`,
        [req.user.id]
      );
      if (rows[0]) {
        tier = resolveTier(rows[0].plan_tier || rows[0].team_plan_tier, false);
      }
    } else {
      tier = 'enterprise';
    }

    if (tier === 'individual') {
      return res.status(403).json({ error: 'API access requires Team plan or higher', upgrade_url: '/pricing' });
    }

    await revokeAllApiKeys(req.user.id);
    const name = (req.body.name || '').trim().substring(0, 100) || 'Default';
    const result = await createApiKey(req.user.id, name);

    res.json({
      key: result,
      raw_key: result.raw_key,
      message: 'All previous keys revoked. Save this new key — it will not be shown again.',
    });
  } catch (err) {
    console.error('[settings-api] POST /api/keys/regenerate error:', err.message);
    res.status(500).json({ error: 'Failed to regenerate API key' });
  }
});

module.exports = router;
