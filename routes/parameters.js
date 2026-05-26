/**
 * routes/parameters.js — Oracle init parameters on-demand endpoint.
 *
 * Owns: fetching Oracle V$PARAMETER with recommended-value evaluation
 *       for a completed health check.
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * POST /api/health-checks/:id/parameters
 *   Returns parameter list with current values, recommended values, and
 *   traffic-light status per parameter.
 *
 * Data sources:
 *   V$PARAMETER, V$OSSTAT, V$LICENSE, V$DATAFILE
 *   (hardware context drives most recommendations)
 *
 * Both direct TCP and proxy connections are supported.
 */

'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');

const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getDemoOracleParameters } = require('../demo-data');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Oracle client (lazy-loaded) ──────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Proxy helper: call proxy /api/parameters endpoint ────────────────────────

function fetchParametersFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password }) {
  const url = new URL('/api/parameters', proxyUrl);
  const body = JSON.stringify({ service_name: serviceName, username, password });

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key': proxyApiKey
      },
      timeout: 60000
    };

    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode !== 200 || !parsed.success) {
            reject(new Error(parsed.error || `Proxy returned HTTP ${resp.statusCode}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON from proxy: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(new Error('Proxy parameters request timed out after 60s')); });
    req.on('error',  (err) => { reject(new Error(`Could not reach proxy at ${proxyUrl}: ${err.message}`)); });

    req.write(body);
    req.end();
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/parameters
 *
 * Reconnects to the Oracle DB that produced this health check and fetches
 * init.ora parameters with recommended values from V$PARAMETER + context views.
 *
 * Returns:
 *   {
 *     parameters: ParamRow[],
 *     hardware:   { ram_gb: number, cpu_count: number },
 *     sessions_highwater: number,
 *     datafile_count: number,
 *     edition: 'EE'|'SE'|'unknown'
 *   }
 */
router.post('/health-checks/:id/parameters', requireAuth, async (req, res) => {
  try {
    const hcResult = await pool.query(
      `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
              oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
       FROM health_checks hc
       LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
       WHERE hc.id = $1`,
      [req.params.id]
    );

    if (hcResult.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = hcResult.rows[0];

    // Demo health check — return deterministic fixture
    if (hc.is_demo) {
      return res.json(getDemoOracleParameters());
    }

    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    if (!hc.connection_id) {
      return res.status(400).json({ error: 'Health check has no saved connection — cannot query parameters' });
    }

    // Proxy connection — route through proxy /api/parameters endpoint
    if (hc.connection_type === 'proxy') {
      if (!hc.proxy_url || !hc.proxy_api_key_enc) {
        return res.status(400).json({ error: 'Proxy connection is missing URL or API key' });
      }
      const proxyApiKey = decrypt(hc.proxy_api_key_enc);
      const result = await fetchParametersFromProxy({
        proxyUrl: hc.proxy_url,
        proxyApiKey,
        serviceName: hc.service_name,
        username: hc.username,
        password: decrypt(hc.encrypted_password)
      });
      return res.json(result);
    }

    // Direct TCP connection — use oracle-client locally
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

    const result = await oracle.queryOracleParameters(connParams);
    res.json(result);
  } catch (err) {
    console.error('[parameters] Error fetching Oracle parameters:', err);
    res.status(500).json({ error: 'Failed to fetch Oracle parameters' });
  }
});

module.exports = router;
