/**
 * routes/alert-policies.js — Alert Policies + Events REST API.
 *
 * Owns: GET/POST/PUT/DELETE /api/alerts/policies, GET /api/alerts/events,
 *       POST /api/alerts/policies/:id/test, POST /api/alerts/events/:id/acknowledge,
 *       GET /settings/alerts (UI page).
 * Does NOT own: alert evaluation (services/alert-policy-evaluator.js),
 *               notification dispatch (services/alert-notifier.js), or tier enforcement
 *               beyond the inline checks here.
 */

'use strict';

const express  = require('express');
const path     = require('path');
const router   = express.Router();

const { requireAuth } = require('../middleware/auth');
const alertDb  = require('../db/alert-policies');
const notifier = require('../services/alert-notifier');

// ── Tier-gating constants ─────────────────────────────────────────────────────

const PLAN_TO_TIER = {
  free: 'individual', starter: 'individual', growth: 'individual',
  scale: 'business', custom: 'enterprise', team: 'team',
  business: 'business', enterprise: 'enterprise',
};

function resolveTier(planTier, isAdmin = false) {
  if (isAdmin) return 'enterprise';
  return PLAN_TO_TIER[planTier] || 'individual';
}

const TIER_MAX_POLICIES   = { individual: 5, team: 20, business: 100, enterprise: -1 };
const TIER_MAX_ESC_STEPS  = { individual: 0, team: 2,  business: 10,  enterprise: -1 };
const TIER_ALLOWED_CHANNELS = {
  individual: ['email'],
  team      : ['email','slack','teams','webhook'],
  business  : ['email','slack','teams','pagerduty','opsgenie','webhook'],
  enterprise: ['email','slack','teams','pagerduty','opsgenie','webhook'],
};

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

async function getUserPlan(req) {
  const isAdmin   = ADMIN_EMAILS.has((req.user.email || '').toLowerCase());
  const planTier  = await alertDb.getUserPlanTier(req.user.id).catch(() => 'free');
  return { tier: resolveTier(planTier, isAdmin), isAdmin };
}

// ── UI page ───────────────────────────────────────────────────────────────────

// GET /settings/alerts — alert policies settings page
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings-alerts.html'));
});

// ── Policies CRUD ─────────────────────────────────────────────────────────────

// GET /api/alerts/policies
router.get('/policies', requireAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId, 10) : undefined;
    const policies = await alertDb.listPolicies(req.user.id, { connectionId });
    res.json({ success: true, policies });
  } catch (err) {
    console.warn('[alert-policies] GET policies error:', err.message);
    res.status(500).json({ error: 'Failed to load alert policies' });
  }
});

// POST /api/alerts/policies
router.post('/policies', requireAuth, async (req, res) => {
  try {
    const { tier } = await getUserPlan(req);
    const existing = await alertDb.listPolicies(req.user.id);
    const max = TIER_MAX_POLICIES[tier];
    if (max !== -1 && existing.length >= max) {
      return res.status(402).json({
        error: `Your ${tier} plan supports up to ${max} alert policies. Upgrade to add more.`,
        upgrade_required: true,
      });
    }

    const { name, checkType, connectionId, conditions, sustainedMinutes, notificationChannels, escalationChain } = req.body;
    if (!name || !checkType) return res.status(400).json({ error: 'name and checkType are required' });

    // Validate channel types for tier
    const allowedChannels = TIER_ALLOWED_CHANNELS[tier];
    for (const ch of (notificationChannels || [])) {
      if (!allowedChannels.includes(ch.type)) {
        return res.status(402).json({
          error: `Channel type '${ch.type}' requires a higher plan tier.`,
          upgrade_required: true,
        });
      }
    }

    // Validate escalation chain length
    const esc    = Array.isArray(escalationChain) ? escalationChain : [];
    const maxEsc = TIER_MAX_ESC_STEPS[tier];
    if (maxEsc !== -1 && esc.length > maxEsc) {
      return res.status(402).json({
        error: `Your ${tier} plan supports up to ${maxEsc} escalation step(s). Upgrade for more.`,
        upgrade_required: true,
      });
    }

    const policy = await alertDb.createPolicy({
      userId: req.user.id, name, checkType, connectionId,
      conditions, sustainedMinutes, notificationChannels: notificationChannels || [], escalationChain: esc,
    });
    res.status(201).json({ success: true, policy });
  } catch (err) {
    console.warn('[alert-policies] POST policies error:', err.message);
    res.status(500).json({ error: 'Failed to create alert policy' });
  }
});

// PUT /api/alerts/policies/:id
router.put('/policies/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid policy id' });

    const existing = await alertDb.getPolicy(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Policy not found' });

    const { tier } = await getUserPlan(req);

    if (req.body.escalationChain) {
      const esc    = Array.isArray(req.body.escalationChain) ? req.body.escalationChain : [];
      const maxEsc = TIER_MAX_ESC_STEPS[tier];
      if (maxEsc !== -1 && esc.length > maxEsc) {
        return res.status(402).json({
          error: `Your ${tier} plan supports up to ${maxEsc} escalation step(s).`,
          upgrade_required: true,
        });
      }
    }

    const updated = await alertDb.updatePolicy(id, req.user.id, {
      name                  : req.body.name,
      check_type            : req.body.checkType,
      connection_id         : req.body.connectionId !== undefined ? (req.body.connectionId || null) : undefined,
      conditions            : req.body.conditions,
      sustained_minutes     : req.body.sustainedMinutes,
      notification_channels : req.body.notificationChannels,
      escalation_chain      : req.body.escalationChain,
      is_active             : req.body.isActive,
    });
    if (!updated) return res.status(404).json({ error: 'Policy not found' });
    res.json({ success: true, policy: updated });
  } catch (err) {
    console.warn('[alert-policies] PUT policies error:', err.message);
    res.status(500).json({ error: 'Failed to update alert policy' });
  }
});

// DELETE /api/alerts/policies/:id
router.delete('/policies/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid policy id' });
    const deleted = await alertDb.deletePolicy(id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Policy not found' });
    res.json({ success: true });
  } catch (err) {
    console.warn('[alert-policies] DELETE policies error:', err.message);
    res.status(500).json({ error: 'Failed to delete alert policy' });
  }
});

// PATCH /api/alerts/policies/:id/toggle
router.patch('/policies/:id/toggle', requireAuth, async (req, res) => {
  try {
    const id       = parseInt(req.params.id, 10);
    const isActive = req.body.isActive;
    if (!id || typeof isActive !== 'boolean') return res.status(400).json({ error: 'id and isActive (boolean) required' });
    const policy = await alertDb.togglePolicy(id, req.user.id, isActive);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json({ success: true, policy });
  } catch (err) {
    console.warn('[alert-policies] PATCH toggle error:', err.message);
    res.status(500).json({ error: 'Failed to toggle policy' });
  }
});

// POST /api/alerts/policies/:id/test — fire a test notification to all channels
router.post('/policies/:id/test', requireAuth, async (req, res) => {
  try {
    const id     = parseInt(req.params.id, 10);
    const policy = await alertDb.getPolicy(id, req.user.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    const userEmail = await alertDb.getUserEmail(req.user.id);

    const context = {
      connectionName : req.body.connectionName || 'Test Connection',
      connectionId   : policy.connection_id || 0,
      severity       : 'warning',
      currentValue   : 'test value (91.2%)',
      checkType      : policy.check_type,
      eventId        : 0,
    };

    const channels = (policy.notification_channels || []).map(ch => {
      if (ch.type === 'email' && Array.isArray(ch.config?.emails) && ch.config.emails.length === 0) {
        return { ...ch, config: { ...ch.config, emails: [userEmail] } };
      }
      return ch;
    });

    const results = await notifier.sendNotifications(channels, context);
    res.json({ success: true, results });
  } catch (err) {
    console.warn('[alert-policies] POST test error:', err.message);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// POST /api/alerts/channels/test — test a single channel config
router.post('/channels/test', requireAuth, async (req, res) => {
  try {
    const conn = await alertDb.getFirstUserConnection(req.user.id);
    const context = { connectionName: conn?.name || 'Your Connection', connectionId: 0 };
    const result  = await notifier.sendTestNotification(req.body, context);
    res.json({ success: result.sent, ...result });
  } catch (err) {
    console.warn('[alert-policies] POST channel test error:', err.message);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// ── Events ────────────────────────────────────────────────────────────────────

// GET /api/alerts/events
router.get('/events', requireAuth, async (req, res) => {
  try {
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId, 10) : undefined;
    const status       = req.query.status;
    const limit        = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const events = await alertDb.listEvents(req.user.id, { connectionId, status, limit });
    res.json({ success: true, events });
  } catch (err) {
    console.warn('[alert-policies] GET events error:', err.message);
    res.status(500).json({ error: 'Failed to load alert events' });
  }
});

// POST /api/alerts/events/:id/acknowledge
router.post('/events/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const event = await alertDb.acknowledgeEvent(id, req.user.id);
    if (!event) return res.status(404).json({ error: 'Event not found or already resolved' });
    res.json({ success: true, event });
  } catch (err) {
    console.warn('[alert-policies] POST acknowledge error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge event' });
  }
});

// GET /api/alerts/tier — return tier capabilities for the UI
router.get('/tier', requireAuth, async (req, res) => {
  try {
    const { tier } = await getUserPlan(req);
    res.json({
      success         : true,
      tier,
      max_policies    : TIER_MAX_POLICIES[tier],
      max_esc_steps   : TIER_MAX_ESC_STEPS[tier],
      allowed_channels: TIER_ALLOWED_CHANNELS[tier],
    });
  } catch (err) {
    console.warn('[alert-policies] GET tier error:', err.message);
    res.status(500).json({ error: 'Failed to load tier info' });
  }
});

module.exports = router;
