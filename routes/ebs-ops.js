/**
 * routes/ebs-ops.js — EBS Ops hub page.
 *
 * Owns: /ebs-ops hub page (categorized card grid linking to all EBS operation pages).
 * Does NOT own: individual EBS operation execution (ebs-deep.js, ebs-middleware.js,
 *               ebs-concurrent.js, ebs-ssh-checks.js, ebs-12-2-checks.js).
 *
 * Routes:
 *   GET /ebs-ops   — serve the EBS Ops hub page (auth required)
 */

'use strict';

const express = require('express');
const path    = require('path');

const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /ebs-ops — hub page
router.get('/ebs-ops', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-ops.html'));
});

module.exports = router;
