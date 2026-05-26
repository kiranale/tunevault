/**
 * routes/settings.js — User settings hub pages.
 * Owns: GET /settings (hub page), GET /settings/billing (billing page).
 * Does NOT own: SSH target CRUD (routes/user-ssh-targets.js),
 *               team management (routes/team.js), billing API (routes/billing.js).
 */

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /settings — settings hub (auth required)
router.get('/', requireAuth, (req, res) => {
  res.sendFile('settings.html', { root: 'public' });
});

// GET /settings/billing — self-serve billing page (auth required)
router.get('/billing', requireAuth, (req, res) => {
  res.sendFile('settings-billing.html', { root: 'public' });
});

module.exports = router;
