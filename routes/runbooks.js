/**
 * routes/runbooks.js — Oracle DBA Runbooks public content pages.
 *
 * Owns: GET /resources/runbooks (index), GET /resources/runbooks/:slug (individual runbooks).
 * Does NOT own: user auth, health checks, payments, database connections, blog articles.
 *
 * Serves static HTML files from public/runbooks/. All pages are public (no auth required).
 * The 8 runbooks are SEO-targeted content for high-intent Oracle DBA search queries.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const RUNBOOKS_DIR = path.join(__dirname, '..', 'public', 'runbooks');

// Valid runbook slugs — explicit allowlist prevents directory traversal
const VALID_SLUGS = new Set([
  'tablespace-full-recovery',
  'archive-log-destination-full',
  'opp-tuning-ebs',
  'workflow-mailer-smtp-recovery',
  'rman-backup-failure-triage',
  'adop-cutover-rollback',
  'oracle-db-upgrade-triage',
  'ebs-upgrade-triage',
  'agent-connection-failure',
  // Live SSH runbooks (authenticated — use connection_ssh_profiles)
  'cm-status-bounce',
  'alert-log-tail',
  'adop-phase-status',
]);

// GET /resources/runbooks — runbook index page
router.get('/', (req, res) => {
  const indexPath = path.join(RUNBOOKS_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send('Runbooks index not found');
  }
  res.sendFile(indexPath);
});

// GET /resources/runbooks/:slug — individual runbook page
router.get('/:slug', (req, res) => {
  const slug = req.params.slug;

  if (!VALID_SLUGS.has(slug)) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }

  const filePath = path.join(RUNBOOKS_DIR, `${slug}.html`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }

  res.sendFile(filePath);
});

module.exports = router;
