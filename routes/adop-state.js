/**
 * routes/adop-state.js — ADOP patch-cycle state API.
 *
 * Owns: GET /api/connections/:id/adop-state (banner poll endpoint),
 *       POST /api/connections/:id/adop-state/refresh (on-demand re-detect),
 *       GET /api/adop-state/fleet (batch flag for fleet banner).
 * Does NOT own: detection logic (lib/ebs/adop-state.js), Oracle query execution,
 *               or DB Ops / EBS Ops action routing.
 *
 * The banner JS on connections/ebs-deep/fleet/ebs-ops polls GET :id/adop-state
 * every 60s and shows/hides the red banner.
 * DB Ops / EBS Ops action handlers call isOpBlockedDuringAdop() before running.
 */

'use strict';

const express  = require('express');
const pool     = require('../db/index');
const adopDb   = require('../db/ebs-adop-state');
const { formatBannerMessage, isOpBlockedDuringAdop } = require('../lib/ebs/adop-state');
const { detectAndPersistAdopState } = require('../services/adop-detector');
const { requireAuth, requireConnectionOwner } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/connections/:id/adop-state ──────────────────────────────────────
// Lightweight poll: returns { patching, phase, session_id, started_at,
// banner_message, checked_at } or 404 if no state row yet.
// Used by the banner JS to show/hide the red banner.

router.get('/:id/adop-state', requireAuth, requireConnectionOwner, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  try {
    const state = await adopDb.getAdopState(connectionId);
    if (!state) {
      return res.json({ patching: false, phase: null, checked_at: null });
    }

    res.json({
      patching:               state.patching,
      phase:                  state.phase,
      session_id:             state.session_id,
      started_at:             state.started_at,
      services_in_patch_mode: state.services_in_patch_mode || [],
      banner_message:         formatBannerMessage(state),
      checked_at:             state.checked_at,
    });
  } catch (err) {
    console.error(`[adop-state] GET conn=${connectionId} err=${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/adop-state/refresh ─────────────────────────────
// On-demand re-detect (called when operator wants to re-check without running
// a full health pack). Rate-limited to once per 60s per connection.

router.post('/:id/adop-state/refresh', requireAuth, requireConnectionOwner, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  try {
    // Check last checked_at — throttle to once per 60s
    const current = await adopDb.getAdopPatchingFlag(connectionId);
    if (current && current.checked_at) {
      const ageMs = Date.now() - new Date(current.checked_at).getTime();
      if (ageMs < 60_000) {
        return res.json({
          ok:      true,
          fresh:   false,
          reason:  'Rate limited — checked less than 60s ago',
          patching: current.patching,
          phase:   current.phase,
        });
      }
    }

    // Fire off detection (async, fire-and-forget from caller's perspective,
    // but we await here so the response reflects the latest state)
    await detectAndPersistAdopState(connectionId);

    const updated = await adopDb.getAdopState(connectionId);
    res.json({
      ok:             true,
      fresh:          true,
      patching:       updated ? updated.patching  : false,
      phase:          updated ? updated.phase      : null,
      banner_message: updated ? formatBannerMessage(updated) : '',
      checked_at:     updated ? updated.checked_at : null,
    });
  } catch (err) {
    console.error(`[adop-state] POST refresh conn=${connectionId} err=${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/adop-state/fleet ─────────────────────────────────────────────────
// Returns ADOP state for ALL connections owned by the requesting user.
// Used by the fleet page to show a summary count + per-connection flag.

router.get('/fleet', requireAuth, async (req, res) => {
  try {
    // Load all connection IDs for this user
    const { rows: conns } = await pool.query(
      `SELECT id FROM oracle_connections WHERE user_id = $1`,
      [req.user.id]
    );
    const ids = conns.map(r => r.id);
    if (ids.length === 0) return res.json({ states: [], patching_count: 0 });

    const states = await adopDb.getAdopStateForConnections(ids);

    res.json({
      states:         states.map(s => ({
        connection_id:          s.connection_id,
        patching:               s.patching,
        phase:                  s.phase,
        session_id:             s.session_id,
        started_at:             s.started_at,
        services_in_patch_mode: s.services_in_patch_mode || [],
        banner_message:         formatBannerMessage(s),
        checked_at:             s.checked_at,
      })),
      patching_count: states.filter(s => s.patching).length,
    });
  } catch (err) {
    console.error(`[adop-state] fleet error=${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/adop-state/check-op ─────────────────────────────────────────────
// Used by DB Ops + EBS Ops action routes to check if an op should be blocked.
// Body: { connection_id, op_key, adop_session_id? }
// Returns: { blocked, reason, override_required }

router.post('/check-op', requireAuth, async (req, res) => {
  const { connection_id, op_key, adop_session_id } = req.body;
  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  try {
    const state = await adopDb.getAdopPatchingFlag(parseInt(connection_id, 10));
    const activelyPatching = state && state.patching;

    if (!activelyPatching) {
      return res.json({ blocked: false });
    }

    const shouldBlock = isOpBlockedDuringAdop(op_key);
    if (!shouldBlock) {
      return res.json({ blocked: false });
    }

    // Check if override provided: operator must type the adop session id
    if (adop_session_id && state.session_id && String(adop_session_id) === String(state.session_id)) {
      return res.json({
        blocked:  false,
        override: true,
        warning:  'Override accepted — this action runs during an active ADOP patch session.',
      });
    }

    return res.json({
      blocked:             true,
      reason:              `Blocked during ADOP patch cycle (phase: ${state.phase || 'unknown'}). Finalize the patch session first.`,
      override_hint:       state.session_id
        ? `To override, enter ADOP session ID: ${state.session_id}`
        : 'Override requires the ADOP session ID.',
      override_required:   true,
      adop_session_id:     state.session_id,
    });
  } catch (err) {
    console.error(`[adop-state] check-op error=${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
