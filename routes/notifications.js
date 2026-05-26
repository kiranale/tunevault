/**
 * routes/notifications.js — user notification preferences.
 *
 * Owns: GET /settings/notifications (page), GET/POST /api/notifications/preferences.
 * Does NOT own: email sending, user auth, or HC pipeline.
 */

'use strict';

const express      = require('express');
const router       = express.Router();
const path         = require('path');
const { requireAuth } = require('../middleware/auth');
const { getPreferences, setHcCompletionEmail } = require('../db/user-preferences');

// ── Page ────────────────────────────────────────────────────────────────────

router.get('/settings/notifications', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings-notifications.html'));
});

// ── API ─────────────────────────────────────────────────────────────────────

router.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const prefs = await getPreferences(req.user.id);
    res.json({ hc_completion_email: prefs.hc_completion_email });
  } catch (err) {
    console.error('[notifications] GET preferences error:', err.message);
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

router.post('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const { hc_completion_email } = req.body;
    if (typeof hc_completion_email !== 'boolean') {
      return res.status(400).json({ error: 'hc_completion_email must be a boolean' });
    }
    await setHcCompletionEmail(req.user.id, hc_completion_email);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] POST preferences error:', err.message);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

module.exports = router;
