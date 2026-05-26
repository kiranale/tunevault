/**
 * routes/agent-release.js — Agent release manifest endpoint + admin page.
 *
 * Owns: GET /api/agent/release (manifest + live served_sha256 comparison),
 *       GET /admin/agent-release (admin UI page).
 * Does NOT own: tarball serving (routes/downloads.js), agent lifecycle (routes/agent.js).
 *
 * Key behavior: re-hashes the agent tarball on disk at request time and compares against
 * the committed release.json sha256. A mismatch means the deploy pipeline served stale bytes.
 * served_sha256 is cached for 60s to avoid CPU cost on every curl.
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

const ROOT = path.join(__dirname, '..');
const RELEASE_JSON_PATH = path.join(ROOT, 'agent', 'release.json');

// served_sha256 cache — recompute at most once per 60s
let _servedSha256 = null;
let _servedSha256At = 0;
const SERVED_SHA_TTL_MS = 60_000;

function computeServedSha256() {
  const now = Date.now();
  if (_servedSha256 && now - _servedSha256At < SERVED_SHA_TTL_MS) {
    return _servedSha256;
  }

  const agentDir = path.join(ROOT, 'agent');
  if (!fs.existsSync(agentDir)) {
    return null;
  }

  try {
    // Reproduce exactly what downloads.js serves: tar -czf - -C ROOT agent
    const tarball = execSync(`tar -czf - -C "${ROOT}" agent`, {
      maxBuffer: 10 * 1024 * 1024,
    });
    _servedSha256 = crypto.createHash('sha256').update(tarball).digest('hex');
    _servedSha256At = now;
    return _servedSha256;
  } catch (err) {
    console.error('[agent-release] Failed to hash agent tarball:', err.message);
    return null;
  }
}

function readRelease() {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_JSON_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

// ── GET /api/agent/release ────────────────────────────────────────────────────
// Returns the committed release manifest plus a live served_sha256 field.
// If served_sha256 !== release.sha256, includes a warning field — the smoking gun
// for "install.sh is handing out stale bytes".
router.get('/api/agent/release', (req, res) => {
  const release = readRelease();
  if (!release) {
    return res.status(503).json({
      error: 'agent/release.json not found — run node scripts/build-agent-release.js',
    });
  }

  const servedSha256 = computeServedSha256();
  const response = { ...release, served_sha256: servedSha256 };

  if (servedSha256 && servedSha256 !== release.sha256) {
    response.warning =
      'served tarball does not match committed release manifest — deployment pipeline may be stale';
    response.match = false;
  } else if (!servedSha256) {
    response.warning = 'could not compute served_sha256 — agent/ directory missing or tar failed';
    response.match = null;
  } else {
    response.match = true;
  }

  res.json(response);
});

// ── GET /admin/agent-release ──────────────────────────────────────────────────
// Admin page: manifest vs served_sha256 side by side with a red badge on mismatch.
router.get('/admin/agent-release', requireAdminPage, (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin', 'agent-release.html'));
});

module.exports = router;
