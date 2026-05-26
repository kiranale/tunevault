/**
 * routes/key-rotation.js — Cloud-managed API key rotation for agent connections.
 *
 * Owns: POST /api/connections/:id/rotate-key  (trigger rotation, return new key once),
 *       GET  /api/connections/:id/rotate-key/status  (poll rotation status + history).
 * Does NOT own: API key generation on first install (routes/agent.js),
 *               key encryption/decryption (crypto-utils.js),
 *               agent long-poll channel (services/agent-channel.js).
 *
 * Flow:
 *   1. POST rotate-key  → generate new 64-hex key, rotate in DB (old→previous),
 *                          push work item {path:'/api/rotate-key', body:{new_key}} to agent,
 *                          return new key ONCE to caller. Agent picks it up via long-poll.
 *   2. Agent handles    → writes /etc/tunevault/agent.env atomically, restarts service.
 *   3. Agent's next poll arrives with new key → cloud's verifyApiKey accepts it,
 *                          POST /api/connections/:id/rotate-key/ack flips status→acknowledged.
 *   4. UI polls GET status → shows Pending → Acknowledged at HH:MM:SS.
 *
 * Grace window: verifyApiKey in routes/agent.js accepts EITHER current OR previous key
 * for 5 minutes after rotation so in-flight requests don't 401 during the transition.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const agentDb = require('../db/agent');
const activityLog = require('../db/activity-log');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');
const { encrypt } = require('../crypto-utils');

const router = express.Router();

// How long the cloud waits for the agent to ACK the rotation (30s)
const AGENT_ROTATION_TIMEOUT_MS = 30_000;

// ── POST /api/connections/:id/rotate-key ─────────────────────────────────────

router.post('/:id/rotate-key', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection ID' });

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Key rotation is only supported for agent connections' });
    }

    // Generate new 64-char hex key
    const newRawKey = crypto.randomBytes(32).toString('hex');
    const newEncryptedKey = encrypt(newRawKey);

    // Write to DB: current→previous, new→current, status→pending
    await agentDb.rotateConnectionKey(connectionId, newEncryptedKey, req.user.email);

    // Emit audit trail
    await activityLog.logActivity({
      userId: req.user.id,
      userEmail: req.user.email,
      actionType: 'settings_change',
      detail: {
        event: 'connection_key_rotated',
        connection_id: connectionId,
        actor: req.user.email,
      },
      connectionId,
      connectionName: conn.name,
      result: 'success',
      ipAddress: req.ip,
    });

    // Push rotation work item to agent (fire-and-forget via the long-poll channel).
    // We do NOT await this — the agent may not be connected right now and will pick
    // it up on next poll. The DB already has the new key; the agent just needs to
    // write it locally and restart.
    channel.sendToAgent(
      connectionId,
      {
        method: 'POST',
        path: '/api/rotate-key',
        body: { new_key: newRawKey },
      },
      AGENT_ROTATION_TIMEOUT_MS,
    ).then(result => {
      if (result && result.statusCode === 200) {
        agentDb.ackKeyRotation(connectionId).catch(e =>
          console.error('[key-rotation] ack error:', e.message)
        );
      }
    }).catch(err => {
      // Agent offline or timed out — not fatal. The agent will pick up the new
      // key on its next poll via a queued work item. Status stays 'pending'.
      console.warn('[key-rotation] agent delivery warning:', err.message);
    });

    // Return the new key ONCE — never stored in plaintext, never shown again.
    return res.json({
      ok: true,
      new_key: newRawKey,
      rotation_status: 'pending',
      message: 'New key generated. Agent will pick it up on next poll.',
    });

  } catch (err) {
    console.error('[key-rotation] rotate error:', err.message);
    return res.status(500).json({ error: 'Key rotation failed' });
  }
});

// ── GET /api/connections/:id/rotate-key/status ────────────────────────────────

router.get('/:id/rotate-key/status', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection ID' });

  try {
    const state = await agentDb.getConnectionKeyState(connectionId);
    if (!state) return res.status(404).json({ error: 'Connection not found' });
    if (state.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const history = await agentDb.getKeyRotationHistory(connectionId);

    return res.json({
      rotation_status: state.key_rotation_status || 'idle',
      key_rotated_at: state.key_rotated_at || null,
      key_rotation_actor: state.key_rotation_actor || null,
      history: history.map(h => ({
        actor: h.user_email,
        rotated_at: h.created_at,
      })),
    });

  } catch (err) {
    console.error('[key-rotation] status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch rotation status' });
  }
});

module.exports = router;
