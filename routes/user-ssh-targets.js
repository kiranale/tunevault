/**
 * routes/user-ssh-targets.js — User-facing SSH target management.
 *
 * Owns: /settings/ssh-targets page, /api/user/ssh/* CRUD endpoints,
 *       /api/user/ssh/test-inline (raw-credential test before saving).
 * Does NOT own: admin SSH target management (routes/ssh-targets.js),
 *               SSH execution (services/ssh-executor.js),
 *               admin audit log (/admin/ssh-audit).
 *
 * All CRUD endpoints are scoped to req.user.id — users can only
 * see and manage their own targets. Admin-managed targets (user_id=NULL)
 * are never visible here; they're managed via /admin/ssh-targets.
 */

'use strict';

const express    = require('express');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const { Client: SshClient } = require('ssh2');
const { encrypt, decrypt } = require('../crypto-utils');
const db       = require('../db/ssh-targets');
const executor = require('../services/ssh-executor');
const { requireAuth, requireRole } = require('../middleware/auth');

// Rate limiter for test-inline: 3 attempts per 5 minutes per user.
// WHY: test-inline accepts raw SSH credentials and makes outbound SSH connections.
// Without a rate limit it could be used to brute-force SSH passwords or probe
// arbitrary hosts (SSRF). This limit is intentionally tight — legitimate use is
// "verify credentials before saving", not repeated bulk testing.
const testInlineRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  keyGenerator: (req) => `ssh-test-inline:${req.user?.id || req.ip}`,
  // IP fallback is unreachable (requireAuth runs first); suppress v8 IPv6 validation
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) => {
    res.status(429).json({ error: 'Rate limit exceeded: max 3 credential tests per 5 minutes. Please wait.' });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();

// ─── User-facing UI page ──────────────────────────────────────────────────────

// GET /settings/ssh-targets — DEPRECATED 2026-05-15
// SSH Targets have been replaced by the proxy /exec endpoint.
// No port 22, no SSH passwords stored. Commands run through the existing
// outbound-only proxy agent already installed on your Oracle server.
router.get('/ssh-targets', requireAuth, (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Targets — Deprecated — TuneVault</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { background: var(--bg, #0f1117); color: var(--text, #e2e8f0); font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: var(--card, #1a1d2e); border: 1px solid var(--border, #2d3148); border-radius: 12px; padding: 40px; max-width: 540px; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0 0 12px; color: #f59e0b; }
    p { font-size: 14px; line-height: 1.7; color: var(--text-dim, #8b92b0); margin: 0 0 20px; }
    .badge { display: inline-block; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); color: #f59e0b; border-radius: 6px; padding: 4px 10px; font-size: 12px; margin-bottom: 24px; }
    .btn { display: inline-block; background: var(--accent, #6366f1); color: #fff; border-radius: 8px; padding: 10px 22px; text-decoration: none; font-size: 14px; font-weight: 600; }
    .btn:hover { opacity: 0.88; }
    ul { text-align: left; font-size: 13px; line-height: 1.9; color: var(--text-dim, #8b92b0); padding-left: 20px; margin: 0 0 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <span class="badge">DEPRECATED</span>
    <h1>SSH Targets replaced by Agent Exec</h1>
    <p>SSH Targets required port 22 exposure and storing SSH credentials in TuneVault. That flow has been replaced by the proxy <code>/exec</code> endpoint — whitelisted commands run through your existing TuneVault Agent tunnel (HTTPS).</p>
    <ul>
      <li>No port 22 required</li>
      <li>No SSH passwords stored</li>
      <li>Runs through the agent you already have installed</li>
      <li>Full audit trail per connection</li>
    </ul>
    <p>Use the <strong>Control</strong> and <strong>DB Ops</strong> tabs on your connection — they now call the agent directly.</p>
    <a href="/connections" class="btn">Go to Connections →</a>
  </div>
</body>
</html>`);
});

// ─── User-facing API: SSH target CRUD (user-scoped) ───────────────────────────
// Mounted at /api/user/ssh in server.js.
// Every query is scoped to req.user.id — users can only see/manage their own targets.

// GET /api/user/ssh/targets — list caller's targets (no credentials) — senior_dba+
router.get('/targets', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const targets = await db.listTargetsByUser(req.user.id);
    res.json({ targets });
  } catch (err) {
    console.error('[user-ssh] list targets error:', err.message);
    res.status(500).json({ error: 'Failed to load targets' });
  }
});

// GET /api/user/ssh/connections — oracle_connections owned by caller (for dropdown) — senior_dba+
router.get('/connections', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const connections = await db.getConnectionsForUser(req.user.id);
    res.json({ connections });
  } catch (err) {
    console.error('[user-ssh] connections error:', err.message);
    res.status(500).json({ error: 'Failed to load connections' });
  }
});

// POST /api/user/ssh/targets — create a target owned by caller — senior_dba+
router.post('/targets', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { label, host, port, os_user, auth_method, private_key, passphrase, role, connection_id } = req.body || {};

  if (!label || !host || !os_user || !auth_method) {
    return res.status(400).json({ error: 'label, host, os_user, and auth_method are required' });
  }
  if (!['key', 'password'].includes(auth_method)) {
    return res.status(400).json({ error: 'auth_method must be key or password' });
  }
  if (!['apps_tier', 'db_tier', 'utility'].includes(role)) {
    return res.status(400).json({ error: 'role must be apps_tier, db_tier, or utility' });
  }
  if (auth_method === 'key' && !private_key) {
    return res.status(400).json({ error: 'private_key required for key auth' });
  }
  if (auth_method === 'password' && !passphrase) {
    return res.status(400).json({ error: 'passphrase (SSH password) required for password auth' });
  }

  try {
    const encrypted_private_key = private_key ? encrypt(private_key) : null;
    const encrypted_passphrase  = passphrase   ? encrypt(passphrase)  : null;

    const target = await db.createTargetForUser({
      user_id: req.user.id,
      label, host, port: parseInt(port, 10) || 22, os_user,
      auth_method, encrypted_private_key, encrypted_passphrase,
      role, connection_id: connection_id || null,
    });
    res.status(201).json({ target });
  } catch (err) {
    console.error('[user-ssh] create target error:', err.message);
    res.status(500).json({ error: 'Failed to create target' });
  }
});

// PATCH /api/user/ssh/targets/:id — update metadata (ownership enforced) — senior_dba+
router.patch('/targets/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { label, host, port, os_user, role, connection_id } = req.body || {};
  try {
    const target = await db.updateTargetMetaForUser(id, req.user.id, {
      label, host, port: parseInt(port, 10) || undefined, os_user, role, connection_id,
    });
    if (!target) return res.status(404).json({ error: 'Target not found or not owned by you' });
    res.json({ target });
  } catch (err) {
    console.error('[user-ssh] update target meta error:', err.message);
    res.status(500).json({ error: 'Failed to update target' });
  }
});

// PUT /api/user/ssh/targets/:id/credentials — replace credentials (ownership enforced) — senior_dba+
router.put('/targets/:id/credentials', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { auth_method, private_key, passphrase } = req.body || {};
  if (!auth_method || !['key', 'password'].includes(auth_method)) {
    return res.status(400).json({ error: 'auth_method required: key or password' });
  }

  try {
    const encrypted_private_key = private_key ? encrypt(private_key) : null;
    const encrypted_passphrase  = passphrase   ? encrypt(passphrase)  : null;
    const target = await db.updateTargetCredentialsForUser(id, req.user.id, {
      auth_method, encrypted_private_key, encrypted_passphrase,
    });
    if (!target) return res.status(404).json({ error: 'Target not found or not owned by you' });
    res.json({ target });
  } catch (err) {
    console.error('[user-ssh] update credentials error:', err.message);
    res.status(500).json({ error: 'Failed to update credentials' });
  }
});

// DELETE /api/user/ssh/targets/:id (ownership enforced) — senior_dba+
router.delete('/targets/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const deleted = await db.deleteTargetForUser(id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Target not found or not owned by you' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[user-ssh] delete target error:', err.message);
    res.status(500).json({ error: 'Failed to delete target' });
  }
});

// POST /api/user/ssh/targets/:id/test — test connection (ownership enforced) — senior_dba+
router.post('/targets/:id/test', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  // Verify ownership before running test
  const owned = await db.getTargetByIdForUser(id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Target not found or not owned by you' });

  const result = await executor.runCommand({
    targetId: id,
    commandKey: 'test.identity',
    initiatedBy: req.user.email,
  });

  if (result.ok) {
    await db.markConnected(id).catch(() => {});
  }

  res.json({
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rejected: result.rejected,
    rejectionReason: result.rejectionReason,
  });
});

// POST /api/user/ssh/test-inline — test raw SSH credentials before saving a target — senior_dba+
// Runs `whoami && hostname && uname -a`. Does NOT write to ssh_targets or ssh_audit.
// WHY: users need to verify credentials work before committing them to the vault.
// Rate-limited: 3/5min per user — prevents SSH password brute-force and SSRF probing.
router.post('/test-inline', requireAuth, requireRole('senior_dba'), testInlineRateLimiter, async (req, res) => {
  const { host, port, os_user, auth_method, private_key, passphrase } = req.body || {};

  if (!host || !os_user || !auth_method) {
    return res.status(400).json({ error: 'host, os_user, and auth_method are required' });
  }
  if (!['key', 'password'].includes(auth_method)) {
    return res.status(400).json({ error: 'auth_method must be key or password' });
  }
  if (auth_method === 'key' && !private_key) {
    return res.status(400).json({ error: 'private_key required for key auth' });
  }
  if (auth_method === 'password' && !passphrase) {
    return res.status(400).json({ error: 'passphrase (SSH password) required for password auth' });
  }

  const sshPort = parseInt(port, 10) || 22;
  const timeout = 15000; // 15 s hard limit for inline tests

  try {
    const result = await _testSshInline({ host, port: sshPort, os_user, auth_method, private_key, passphrase, timeout });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Test SSH credentials inline (no DB row required).
 * Returns { ok, stdout, stderr, durationMs }.
 */
function _testSshInline({ host, port, os_user, auth_method, private_key, passphrase, timeout = 15000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const conn = new SshClient();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve({ ...result, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      done({ ok: false, stdout: '', stderr: 'Connection timed out after 15 s' });
    }, timeout);

    conn.on('ready', () => {
      conn.exec('whoami && hostname && uname -a', (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return done({ ok: false, stdout: '', stderr: err.message });
        }
        let stdout = '';
        let stderr = '';
        stream
          .on('data', (d) => { stdout += d.toString(); })
          .stderr.on('data', (d) => { stderr += d.toString(); });
        stream.on('close', () => {
          clearTimeout(timer);
          done({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, stdout: '', stderr: err.message });
    });

    const sshOpts = {
      host,
      port,
      username: os_user,
      readyTimeout: timeout,
    };

    if (auth_method === 'key') {
      sshOpts.privateKey = private_key;
      if (passphrase) sshOpts.passphrase = passphrase;
    } else {
      sshOpts.password = passphrase;
    }

    conn.connect(sshOpts);
  });
}

module.exports = router;
