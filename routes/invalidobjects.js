/**
 * routes/invalidobjects.js — Invalid Objects on-demand endpoint.
 *
 * Owns: fetching counts of INVALID Oracle objects by owner and type.
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * POST /api/health-checks/:id/invalid-objects
 *   Returns per-owner/type counts of INVALID objects from DBA_OBJECTS.
 *   Available on all Oracle editions — no license gating.
 *   Proxy connections are rejected (no direct TCP = cannot run live Oracle queries).
 */

'use strict';

const express = require('express');

const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getDemoInvalidObjects } = require('../demo-data');
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
 * POST /api/health-checks/:id/invalid-objects
 *
 * Returns counts of INVALID objects from DBA_OBJECTS grouped by owner and type.
 * Available on all Oracle editions — no license gating.
 */
router.post('/health-checks/:id/invalid-objects', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json(getDemoInvalidObjects());
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

    const result = await oracle.queryInvalidObjects(connParams);
    res.json(result);
  } catch (err) {
    console.error('[invalidobjects] Error fetching invalid objects:', err);
    res.status(500).json({ error: 'Failed to fetch invalid objects' });
  }
});

module.exports = router;
