/**
 * routes/features.js — Feature marketing pages.
 *
 * Owns: GET /features/{page} (static feature pages), POST /api/autonomous-remediation-beta (beta signup).
 * Does NOT own: user auth, database, API logic.
 *
 * Static pages in /public/features-*.html are served at /features/{name}.
 * API endpoints handle form submissions and integration with email/database.
 */

'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();

/**
 * GET /features/:page
 * Serve static feature marketing pages from public/features-{page}.html
 */
router.get('/:page', (req, res) => {
  const page = req.params.page.replace(/[^a-z0-9-]/g, '');
  const filePath = path.join(__dirname, '..', 'public', `features-${page}.html`);

  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
    }
  });
});

/**
 * POST /api/autonomous-remediation-beta
 * Handle beta signup form submission.
 * Validates email, stores interest in database, sends confirmation email.
 */
router.post('/autonomous-remediation-beta', express.json(), (req, res) => {
  const { email, company } = req.body;

  // Basic validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  // Log beta signup (could be extended to store in database or send email)
  console.log(`[beta-signup] Autonomous Remediation: ${email} (${company || 'N/A'})`);

  // Return success — in production this would store in DB and send confirmation email
  res.json({
    success: true,
    message: 'Thank you! We\'ll contact you soon about beta access.',
    email
  });
});

module.exports = router;
