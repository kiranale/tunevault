/**
 * routes/ebs-credentials.js
 * Owns: EBS credential vault API — store, list metadata, revoke.
 * Does NOT own: decryption at rest (crypto-utils.js), auth (middleware/auth.js),
 *               credential usage during command execution (ebs-middleware, ebs-concurrent, etc.).
 *
 * Routes:
 *   POST   /api/connections/:id/credentials          — upsert encrypted credential
 *   GET    /api/connections/:id/credentials          — list metadata (type, username, rotated_at)
 *   DELETE /api/connections/:id/credentials/:type    — revoke a credential
 *   GET    /api/connections/:id/credentials/log      — audit log (admin only)
 *
 * SECURITY CONTRACT:
 *   - Plaintext passwords are NEVER returned, stored unencrypted, or logged.
 *   - Encryption happens server-side in this route before calling db/ebs-credentials.js.
 *   - The encryption key lives in ENCRYPTION_KEY (Render secret manager). No fallback in prod.
 */

'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireAuth, requireAdmin, requireConnectionOwner } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');
const ebsCredsDb = require('../db/ebs-credentials');

// POST /api/connections/:id/credentials
// Accepts { credential_type, username, value } — encrypts and stores value.
// Response: { credential_type, username, rotated_at } — no plaintext.
router.post('/', requireAuth, requireConnectionOwner, async (req, res) => {
  const connectionId = req.params.id;
  const { credential_type, username, value } = req.body;

  if (!credential_type || !username || !value) {
    return res.status(400).json({ error: 'credential_type, username, and value are required' });
  }

  if (!ebsCredsDb.VALID_TYPES.includes(credential_type)) {
    return res.status(400).json({
      error: `Invalid credential_type. Must be one of: ${ebsCredsDb.VALID_TYPES.join(', ')}`
    });
  }

  try {
    // encrypt() returns "iv:authTag:ciphertext" (all hex) — split for column storage
    const encStr = encrypt(value);
    const [iv, authTag, encryptedValue] = encStr.split(':');

    const row = await ebsCredsDb.upsertCredential(
      connectionId, credential_type, username, encryptedValue, iv, authTag
    );

    return res.json({
      credential_type: row.credential_type,
      username: row.username,
      rotated_at: row.rotated_at,
      created_at: row.created_at,
    });
  } catch (err) {
    console.error('[ebs-credentials] upsert error:', err.message);
    return res.status(500).json({ error: 'Failed to store credential' });
  }
});

// GET /api/connections/:id/credentials
// Returns metadata only — never the encrypted value.
router.get('/', requireAuth, requireConnectionOwner, async (req, res) => {
  const connectionId = req.params.id;
  try {
    const rows = await ebsCredsDb.listCredentials(connectionId);
    return res.json({ credentials: rows });
  } catch (err) {
    console.error('[ebs-credentials] list error:', err.message);
    return res.status(500).json({ error: 'Failed to list credentials' });
  }
});

// DELETE /api/connections/:id/credentials/:type
// Revoke a stored credential.
router.delete('/:type', requireAuth, requireConnectionOwner, async (req, res) => {
  const connectionId = req.params.id;
  const credentialType = req.params.type;

  if (!ebsCredsDb.VALID_TYPES.includes(credentialType)) {
    return res.status(400).json({ error: 'Invalid credential_type' });
  }

  try {
    const deleted = await ebsCredsDb.deleteCredential(connectionId, credentialType);
    if (!deleted) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    return res.json({ deleted: true, credential_type: credentialType });
  } catch (err) {
    console.error('[ebs-credentials] delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// GET /api/connections/:id/credentials/log — admin-only audit view
router.get('/log', requireAuth, requireAdmin, async (req, res) => {
  const connectionId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const rows = await ebsCredsDb.getAccessLog(connectionId, limit);
    return res.json({ log: rows });
  } catch (err) {
    console.error('[ebs-credentials] log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch access log' });
  }
});

/**
 * Helper exported for use by command-execution modules (adop, WLS bounce, CM bounce).
 * Decrypts a credential in-memory and logs the access. Value MUST NOT be stored, returned
 * in API responses, or written to any log file.
 *
 * @param {string} connectionId
 * @param {string} credentialType
 * @param {string} action — describes the operation using the credential (e.g. 'adop_run')
 * @param {number|null} userId
 * @returns {Promise<{username: string, plaintext: string}|null>}
 */
async function resolveCredential(connectionId, credentialType, action, userId) {
  const row = await ebsCredsDb.getDecryptedValue(connectionId, credentialType);
  if (!row) return null;

  // Reconstruct the "iv:authTag:ciphertext" string that crypto-utils.decrypt() expects
  const encStr = `${row.iv}:${row.auth_tag}:${row.encrypted_value}`;
  const plaintext = decrypt(encStr);

  // Log BEFORE returning — if the caller crashes, the access is still recorded
  await ebsCredsDb.logAccess(connectionId, credentialType, action, userId).catch(err => {
    console.error('[ebs-credentials] logAccess error (non-fatal):', err.message);
  });

  return { username: row.username, plaintext };
}

module.exports = router;
module.exports.resolveCredential = resolveCredential;
