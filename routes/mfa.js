/**
 * routes/mfa.js — TOTP-based multi-factor authentication.
 * Owns: MFA setup, verification challenge, disable, recovery code management,
 *       admin reset of a user's MFA, team mfa_required toggle.
 * Does NOT own: primary auth (magic link / Google OAuth), session token creation,
 *               user CRUD — all in server.js auth routes.
 *
 * Flow after primary auth:
 *   1. Primary auth sets a short-lived "pending_mfa" cookie (mfa_pending=<userId>)
 *      instead of the full session cookie.
 *   2. Client redirected to /mfa-challenge.
 *   3. POST /api/mfa/verify exchanges pending_mfa + 6-digit code for full session.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const db = require('../db/mfa');
const mfaSvc = require('../services/mfa');

const router = express.Router();

// Pending-MFA cookie: short-lived, proves primary auth passed, awaits TOTP
const PENDING_COOKIE = 'tv_mfa_pending';
const PENDING_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 10 * 60 * 1000, // 10 minutes to complete MFA
  path: '/',
};

// Rate limiter: max 5 MFA attempts per 15 min window (enforced via mfa_attempts table)
const LOCKOUT_WINDOW_MINUTES = 15;

// ============================================================
// Setup flow — /settings/security page
// ============================================================

// GET /settings/security — MFA settings page (auth required)
router.get('/settings/security', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('settings-security.html', { root: 'public' });
});

// GET /mfa-challenge — TOTP challenge page (no auth required — pending cookie gates it)
router.get('/mfa-challenge', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile('mfa-challenge.html', { root: 'public' });
});

// ============================================================
// API: MFA status for current user
// ============================================================

// GET /api/mfa/status
router.get('/api/mfa/status', requireAuth, async (req, res) => {
  try {
    const record = await db.getMfaRecord(req.user.id);
    res.json({
      enabled: record?.is_enabled ?? false,
      verified_at: record?.verified_at ?? null,
      last_used_at: record?.last_used_at ?? null,
      recovery_codes_remaining: record ? mfaSvc.unusedRecoveryCodeCount(record.recovery_codes) : 0,
    });
  } catch (err) {
    console.error('[mfa] GET /api/mfa/status error:', err.message);
    res.status(500).json({ error: 'Failed to load MFA status' });
  }
});

// ============================================================
// API: Setup — generate TOTP secret + QR code
// ============================================================

// POST /api/mfa/setup/begin — generates secret, returns QR and manual key
// Does NOT enable MFA yet — user must confirm with a valid code first
router.post('/api/mfa/setup/begin', requireAuth, async (req, res) => {
  try {
    const existing = await db.getMfaRecord(req.user.id);
    if (existing?.is_enabled) {
      return res.status(409).json({ error: 'MFA is already enabled. Disable it first.' });
    }

    const secret = mfaSvc.generateSecret();
    const encryptedSecret = mfaSvc.encryptSecret(secret);
    const otpauthUri = mfaSvc.generateOtpauthUri(req.user.email, secret);
    const qrDataUrl = await mfaSvc.generateQrDataUrl(otpauthUri);

    // Persist pending (not yet enabled) record
    await db.upsertMfaRecord({
      userId: req.user.id,
      totpSecret: encryptedSecret,
      isEnabled: false,
      recoveryCodes: [],
    });

    res.json({
      qr_data_url: qrDataUrl,
      manual_key: secret, // formatted in groups of 4 for readability
      manual_key_formatted: secret.match(/.{1,4}/g).join(' '),
    });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/setup/begin error:', err.message);
    res.status(500).json({ error: 'Failed to begin MFA setup' });
  }
});

// POST /api/mfa/setup/confirm — verifies the setup code, generates recovery codes, enables MFA
router.post('/api/mfa/setup/confirm', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    const record = await db.getMfaRecord(req.user.id);
    if (!record) return res.status(400).json({ error: 'Start setup first (POST /api/mfa/setup/begin)' });
    if (record.is_enabled) return res.status(409).json({ error: 'MFA already enabled' });

    const valid = mfaSvc.verifyTotp(code, record.totp_secret);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code. Check your authenticator app and try again.' });
    }

    // Generate recovery codes — plaintext returned once, hashed stored
    const plainCodes = mfaSvc.generateRecoveryCodes();
    const hashedCodes = await mfaSvc.hashRecoveryCodes(plainCodes);

    await db.upsertMfaRecord({
      userId: req.user.id,
      totpSecret: record.totp_secret,
      isEnabled: false,
      recoveryCodes: hashedCodes,
    });
    await db.enableMfa(req.user.id);

    res.json({
      success: true,
      recovery_codes: plainCodes, // shown exactly once — user must save
    });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/setup/confirm error:', err.message);
    res.status(500).json({ error: 'Failed to confirm MFA setup' });
  }
});

// ============================================================
// API: Challenge — verify TOTP on login
// ============================================================

// POST /api/mfa/verify — validates pending_mfa cookie + TOTP code → issues full session
// body: { code } | { recovery_code }
router.post('/api/mfa/verify', async (req, res) => {
  const pendingToken = req.cookies?.[PENDING_COOKIE];
  if (!pendingToken) {
    return res.status(401).json({ error: 'No pending MFA session. Please log in again.' });
  }

  // Validate pending token (HMAC-signed userId)
  const SESSION_SECRET = process.env.SESSION_SECRET;
  const parsedPending = verifyPendingToken(pendingToken, SESSION_SECRET);
  if (!parsedPending) {
    res.clearCookie(PENDING_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'MFA session expired. Please log in again.' });
  }

  const userId = parsedPending.userId;
  const { code, recovery_code } = req.body;
  const ip = req.ip;

  try {
    // Check lockout
    const failures = await db.recentFailedAttempts(userId);
    if (mfaSvc.isLockedOut(failures)) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MINUTES} minutes.`,
        locked_out: true,
      });
    }

    const record = await db.getMfaRecord(userId);
    if (!record || !record.is_enabled) {
      // MFA not enabled — this shouldn't happen, but clear pending and let through
      res.clearCookie(PENDING_COOKIE, { path: '/' });
      return res.status(400).json({ error: 'MFA not enabled for this account' });
    }

    let verified = false;

    if (recovery_code) {
      // Recovery code path
      const result = await mfaSvc.verifyRecoveryCode(recovery_code, record.recovery_codes);
      if (result.matched) {
        const updated = [...record.recovery_codes];
        updated[result.index] = { ...updated[result.index], used: true, used_at: new Date().toISOString() };
        await db.updateRecoveryCodes(userId, updated);
        await db.logAttempt({ userId, succeeded: true, method: 'recovery_code', ip });
        verified = true;
      }
    } else if (code) {
      verified = mfaSvc.verifyTotp(code, record.totp_secret);
    } else {
      return res.status(400).json({ error: 'code or recovery_code required' });
    }

    if (!verified) {
      await db.logAttempt({ userId, succeeded: false, method: recovery_code ? 'recovery_code' : 'totp', ip });
      const remaining = Math.max(0, mfaSvc.LOCKOUT_THRESHOLD - (failures + 1));
      return res.status(400).json({
        error: 'Invalid code. Try again.',
        attempts_remaining: remaining,
      });
    }

    // Success — issue full session
    await db.updateLastUsedAt(userId);
    await db.logAttempt({ userId, succeeded: true, method: code ? 'totp' : 'recovery_code', ip });

    // Clear pending cookie
    res.clearCookie(PENDING_COOKIE, { path: '/' });

    // Issue full session token (reuse server.js createToken pattern)
    const fullToken = createSessionToken(userId, SESSION_SECRET);
    res.cookie('tv_session', fullToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    const redirect = parsedPending.redirect || '/dashboard';
    res.json({ success: true, redirect });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/verify error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ============================================================
// API: Disable MFA (user self-service, requires current TOTP)
// ============================================================

// POST /api/mfa/disable — disables MFA after confirming current code
router.post('/api/mfa/disable', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Current TOTP code required to disable MFA' });

  try {
    const record = await db.getMfaRecord(req.user.id);
    if (!record || !record.is_enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    const valid = mfaSvc.verifyTotp(code, record.totp_secret);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code' });
    }

    await db.disableMfa(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/disable error:', err.message);
    res.status(500).json({ error: 'Failed to disable MFA' });
  }
});

// ============================================================
// API: Recovery codes — regenerate
// ============================================================

// POST /api/mfa/recovery-codes/regenerate — invalidates old set, generates new 10
router.post('/api/mfa/recovery-codes/regenerate', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Current TOTP code required' });

  try {
    const record = await db.getMfaRecord(req.user.id);
    if (!record || !record.is_enabled) {
      return res.status(400).json({ error: 'MFA is not enabled' });
    }

    const valid = mfaSvc.verifyTotp(code, record.totp_secret);
    if (!valid) return res.status(400).json({ error: 'Invalid code' });

    const plainCodes = mfaSvc.generateRecoveryCodes();
    const hashedCodes = await mfaSvc.hashRecoveryCodes(plainCodes);
    await db.updateRecoveryCodes(req.user.id, hashedCodes);

    res.json({ success: true, recovery_codes: plainCodes });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/recovery-codes/regenerate error:', err.message);
    res.status(500).json({ error: 'Failed to regenerate recovery codes' });
  }
});

// ============================================================
// API: Admin — reset a user's MFA (for lost phone scenarios)
// ============================================================

// POST /api/mfa/admin/reset/:userId — clears TOTP secret, forces re-setup on next login
router.post('/api/mfa/admin/reset/:userId', requireAdmin, async (req, res) => {
  const targetUserId = parseInt(req.params.userId, 10);
  if (!targetUserId) return res.status(400).json({ error: 'Invalid userId' });

  try {
    await db.disableMfa(targetUserId);
    console.log(`[mfa] Admin ${req.user.email} reset MFA for user ${targetUserId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[mfa] POST /api/mfa/admin/reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset MFA' });
  }
});

// GET /api/mfa/admin/team-status — MFA status for all team members (team admin only)
router.get('/api/mfa/admin/team-status', requireAuth, async (req, res) => {
  try {
    const data = await db.getTeamMfaStatus(req.user.id);
    if (!data) return res.status(404).json({ error: 'No team found' });
    if (data.team.owner_id !== req.user.id) return res.status(403).json({ error: 'Team admin access required' });
    res.json({
      team: { id: data.team.id, name: data.team.name, mfa_required: data.team.mfa_required },
      members: data.members,
    });
  } catch (err) {
    console.error('[mfa] GET /api/mfa/admin/team-status error:', err.message);
    res.status(500).json({ error: 'Failed to load team MFA status' });
  }
});

// PUT /api/mfa/admin/team-mfa-required — toggle mfa_required for a team
router.put('/api/mfa/admin/team-mfa-required', requireAuth, async (req, res) => {
  const { required } = req.body;
  if (typeof required !== 'boolean') return res.status(400).json({ error: 'required must be boolean' });

  try {
    const team = await db.getTeamForOwnerCheck(req.user.id);
    if (!team) return res.status(404).json({ error: 'No team found' });
    if (team.owner_id !== req.user.id) return res.status(403).json({ error: 'Team admin access required' });
    await db.setTeamMfaRequired(team.id, required);
    res.json({ success: true, mfa_required: required });
  } catch (err) {
    console.error('[mfa] PUT /api/mfa/admin/team-mfa-required error:', err.message);
    res.status(500).json({ error: 'Failed to update MFA requirement' });
  }
});

// ============================================================
// Helper: create/verify pending-MFA token
// ============================================================

function createPendingToken(userId, redirect, secret) {
  const payload = JSON.stringify({ userId, redirect, iat: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyPendingToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch { return null; }
}

function createSessionToken(userId, secret) {
  const payload = JSON.stringify({ userId, iat: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

// Expose helper so server.js auth routes can set pending cookie after primary auth
router.createPendingToken = createPendingToken;
router.PENDING_COOKIE = PENDING_COOKIE;
router.PENDING_OPTS = PENDING_OPTS;

module.exports = router;
