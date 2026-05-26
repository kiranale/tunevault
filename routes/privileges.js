/**
 * routes/privileges.js — Privilege model docs + role setup script.
 *
 * Owns: GET /setup/role-script (serve canonical tunevault_reader SQL, plain text),
 *       GET /docs/privileges (privilege model documentation page).
 * Does NOT own: connection creation (agent.js), health check execution (server.js).
 */

'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Path to the canonical SQL script
const ROLE_SCRIPT_PATH = path.join(__dirname, '..', 'db', 'setup', 'tunevault_reader.sql');

// ── GET /setup/role-script ───────────────────────────────────────────────────
// Returns the canonical tunevault_reader SQL as plain text.
// Used by the Add Connection wizard "View the exact SQL" panel (copy-paste).
// Public — no auth required (SQL itself contains no secrets).
router.get('/setup/role-script', (req, res) => {
  try {
    const sql = fs.readFileSync(ROLE_SCRIPT_PATH, 'utf8');
    res.type('text/plain').send(sql);
  } catch (err) {
    res.status(500).type('text/plain').send('-- Script unavailable. Contact support@tunevault.app');
  }
});

// ── GET /docs/privileges ─────────────────────────────────────────────────────
// Privilege model documentation page (public, no auth).
router.get('/docs/privileges', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'docs', 'privileges.html'));
});

module.exports = router;
