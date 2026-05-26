/**
 * routes/ssh-targets.js — SSH credential vault API + admin UI routes.
 *
 * Owns: /admin/ssh-targets page, /admin/ssh-audit page,
 *       /api/ssh/targets CRUD (admin-only), /api/ssh/run, /api/ssh/audit endpoints.
 * Does NOT own: user-facing SSH management (routes/user-ssh-targets.js),
 *               SSH execution logic (services/ssh-executor.js),
 *               credential encryption storage (db/ssh-targets.js),
 *               Oracle connection management.
 *
 * Security:
 *   - All write endpoints are admin-only.
 *   - Encrypted credentials are accepted as plaintext on write; this route
 *     encrypts before persisting. Decrypted values never appear in responses.
 *   - /api/ssh/run accepts command_key only — raw shell input from callers
 *     is rejected at the executor layer.
 *   - /api/ssh/run verifies the caller owns the target OR target is admin-managed (user_id=NULL).
 */

'use strict';

const express  = require('express');
const path     = require('path');
const { encrypt } = require('../crypto-utils');
const db       = require('../db/ssh-targets');
const executor = require('../services/ssh-executor');
const { requireAuth, requireAdmin, requireRole, ADMIN_EMAILS } = require('../middleware/auth');

const router = express.Router();

// ─── API: Target CRUD ─────────────────────────────────────────────────────────

// GET /api/ssh/targets — list all targets (no credentials)
router.get('/targets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targets = await db.listTargets();
    res.json({ targets });
  } catch (err) {
    console.error('[ssh] list targets error:', err.message);
    res.status(500).json({ error: 'Failed to load targets' });
  }
});

// POST /api/ssh/targets — create a target
// Body: { label, host, port, os_user, auth_method, private_key?, passphrase?, role, connection_id? }
router.post('/targets', requireAuth, requireAdmin, async (req, res) => {
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

  // Key-auth requires a private key; password-auth requires a passphrase.
  if (auth_method === 'key' && !private_key) {
    return res.status(400).json({ error: 'private_key required for key auth' });
  }
  if (auth_method === 'password' && !passphrase) {
    return res.status(400).json({ error: 'passphrase (SSH password) required for password auth' });
  }

  try {
    const encrypted_private_key = private_key ? encrypt(private_key) : null;
    const encrypted_passphrase  = passphrase   ? encrypt(passphrase)  : null;

    const target = await db.createTarget({
      label, host, port: parseInt(port, 10) || 22, os_user,
      auth_method, encrypted_private_key, encrypted_passphrase,
      role, connection_id: connection_id || null,
    });
    res.status(201).json({ target });
  } catch (err) {
    console.error('[ssh] create target error:', err.message);
    res.status(500).json({ error: 'Failed to create target' });
  }
});

// PATCH /api/ssh/targets/:id — update metadata (no credential change)
router.patch('/targets/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { label, host, port, os_user, role, connection_id } = req.body || {};
  try {
    const target = await db.updateTargetMeta(id, { label, host, port: parseInt(port, 10) || undefined, os_user, role, connection_id });
    if (!target) return res.status(404).json({ error: 'Target not found' });
    res.json({ target });
  } catch (err) {
    console.error('[ssh] update target meta error:', err.message);
    res.status(500).json({ error: 'Failed to update target' });
  }
});

// PUT /api/ssh/targets/:id/credentials — replace credential fields
router.put('/targets/:id/credentials', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { auth_method, private_key, passphrase } = req.body || {};
  if (!auth_method || !['key', 'password'].includes(auth_method)) {
    return res.status(400).json({ error: 'auth_method required: key or password' });
  }

  try {
    const encrypted_private_key = private_key ? encrypt(private_key) : null;
    const encrypted_passphrase  = passphrase   ? encrypt(passphrase)  : null;
    const target = await db.updateTargetCredentials(id, { auth_method, encrypted_private_key, encrypted_passphrase });
    if (!target) return res.status(404).json({ error: 'Target not found' });
    res.json({ target });
  } catch (err) {
    console.error('[ssh] update credentials error:', err.message);
    res.status(500).json({ error: 'Failed to update credentials' });
  }
});

// DELETE /api/ssh/targets/:id
router.delete('/targets/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const deleted = await db.deleteTarget(id);
    if (!deleted) return res.status(404).json({ error: 'Target not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ssh] delete target error:', err.message);
    res.status(500).json({ error: 'Failed to delete target' });
  }
});

// ─── API: Test connection ─────────────────────────────────────────────────────

// POST /api/ssh/targets/:id/test
// Runs test.identity command and stamps last_connected_at on success.
router.post('/targets/:id/test', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

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

// ─── API: Run a whitelisted command ──────────────────────────────────────────

// POST /api/ssh/run — senior_dba+ only
// Body: { target_id, command_key }
// Returns structured output — backend never exposes raw shell to callers.
// Verifies the caller owns the target (user_id match) OR target is admin-managed (user_id = NULL).
router.post('/run', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { target_id, command_key } = req.body || {};
  if (!target_id || !command_key) {
    return res.status(400).json({ error: 'target_id and command_key are required' });
  }

  // Ownership check: target must belong to caller or be admin-managed (user_id IS NULL)
  const targetIdInt = parseInt(target_id, 10);
  const target = await db.getTargetById(targetIdInt);
  if (!target) {
    return res.status(404).json({ error: 'SSH target not found' });
  }
  // Allow if target is admin-managed (user_id = NULL) OR owned by caller
  const isAdminManaged = target.user_id == null;
  const isOwned = target.user_id === req.user.id;
  if (!isAdminManaged && !isOwned && !ADMIN_EMAILS.has(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'You do not have access to this SSH target' });
  }

  const result = await executor.runCommand({
    targetId: targetIdInt,
    commandKey: command_key,
    initiatedBy: req.user.email,
  });

  res.json(result);
});

// ─── API: Command whitelist ───────────────────────────────────────────────────

// GET /api/ssh/whitelist
router.get('/whitelist', requireAuth, (req, res) => {
  res.json({ whitelist: executor.getWhitelist() });
});

// ─── API: Audit log ───────────────────────────────────────────────────────────

// GET /api/ssh/audit?target_id=&limit=&offset=
router.get('/audit', requireAuth, requireAdmin, async (req, res) => {
  const target_id = req.query.target_id ? parseInt(req.query.target_id, 10) : null;
  const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const { rows, total } = await db.listAudit({ target_id, limit, offset });
    res.json({ rows, total, limit, offset });
  } catch (err) {
    console.error('[ssh] audit list error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
