/**
 * routes/sessions.js — Blocking Sessions and Long Operations on-demand endpoints.
 *
 * Owns: live Oracle session diagnostics (who's blocking whom, long-running ops).
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * POST /api/health-checks/:id/blocking-sessions
 *   Returns blocking session chains from V$SESSION (all Oracle editions).
 *   Severity: green=no chains, yellow=any chain, red=chain>300s or >5 blocked.
 *
 * POST /api/health-checks/:id/long-operations
 *   Returns active long operations from V$SESSION_LONGOPS (all editions).
 *   Flags any operation with >60 min remaining as yellow.
 *
 * Both endpoints support demo health checks and reject proxy connections
 * (no direct TCP = cannot run live Oracle queries).
 */

'use strict';

const express = require('express');

const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getDemoBlockingSessions, getDemoLongOperations } = require('../demo-data');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Shared: load health check row + run guards ───────────────────────────────

async function loadHcAndGuard(req, res) {
  const hcResult = await pool.query(
    `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
            oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
     FROM health_checks hc
     LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
     WHERE hc.id = $1`,
    [req.params.id]
  );

  if (hcResult.rows.length === 0) {
    res.status(404).json({ error: 'Health check not found' });
    return null;
  }

  const hc = hcResult.rows[0];

  if (!hc.is_demo) {
    if (hc.status !== 'completed') {
      res.status(400).json({ error: 'Health check is not yet complete' });
      return null;
    }
    if (!hc.connection_id) {
      res.status(400).json({ error: 'Health check has no saved connection' });
      return null;
    }
    if (hc.connection_type === 'proxy') {
      res.status(400).json({ error: 'This panel requires a direct TCP connection, not a proxy connection' });
      return null;
    }
  }

  return hc;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/blocking-sessions
 *
 * Returns blocking session chains: who is blocking whom, how long they've been waiting.
 * Queries V$SESSION self-join + V$SQL for blocker SQL text.
 * Available on all Oracle editions — no license gating.
 */
router.post('/health-checks/:id/blocking-sessions', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json(getDemoBlockingSessions());
    }

    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({ error: 'Oracle client not available' });
    }

    const connParams = {
      host: hc.host,
      port: hc.port || 1521,
      serviceName: hc.service_name,
      username: hc.username,
      password: decrypt(hc.encrypted_password)
    };

    const result = await oracle.queryBlockingSessions(connParams);
    res.json(result);
  } catch (err) {
    console.error('[sessions] Error fetching blocking sessions:', err);
    res.status(500).json({ error: 'Failed to fetch blocking sessions' });
  }
});

/**
 * POST /api/health-checks/:id/long-operations
 *
 * Returns currently running long operations from V$SESSION_LONGOPS.
 * Shows progress %, time remaining, elapsed time. Available on all editions.
 */
router.post('/health-checks/:id/long-operations', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json(getDemoLongOperations());
    }

    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({ error: 'Oracle client not available' });
    }

    const connParams = {
      host: hc.host,
      port: hc.port || 1521,
      serviceName: hc.service_name,
      username: hc.username,
      password: decrypt(hc.encrypted_password)
    };

    const result = await oracle.queryLongOperations(connParams);
    res.json(result);
  } catch (err) {
    console.error('[sessions] Error fetching long operations:', err);
    res.status(500).json({ error: 'Failed to fetch long operations' });
  }
});

module.exports = router;
