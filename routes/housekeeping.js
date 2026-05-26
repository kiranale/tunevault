/**
 * routes/housekeeping.js — Auto-Housekeeping Window status endpoint.
 *
 * Owns: fetching Oracle automatic housekeeping job status (autotask clients,
 *       scheduler windows, stale stats summary) for a completed health check.
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * POST /api/health-checks/:id/housekeeping
 *   Returns housekeeping status or a graceful error card.
 *
 * Checks returned:
 *   1. DBA_AUTOTASK_CLIENT — auto optimizer stats collection, sql tuning advisor,
 *      auto space advisor (status + last 7-day run history)
 *   2. DBA_SCHEDULER_WINDOWS — all *_WINDOW entries (enabled, duration)
 *   3. DBA_TAB_STATISTICS — stale-stats count + top-10 stalest user tables
 *
 * Both direct TCP and proxy connections are supported.
 */

'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');

const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getDemoHousekeepingStatus } = require('../demo-data');
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

// ─── Proxy helper: call proxy /api/maintenance endpoint ──────────────────────
// The proxy exposes /api/maintenance (not /api/housekeeping) for maintenance window queries.

function fetchHousekeepingFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password }) {
  const url = new URL('/api/maintenance', proxyUrl);
  const body = JSON.stringify({
    service_name: serviceName,
    username,
    password
  });

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
          if (resp.statusCode === 404) {
            // Proxy too old — /api/maintenance endpoint doesn't exist
            const err = new Error('PROXY_OUTDATED');
            err.statusCode = 404;
            return reject(err);
          }
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

    req.on('timeout', () => { req.destroy(new Error('Proxy housekeeping request timed out after 60s')); });
    req.on('error', (err) => { reject(new Error(`Could not reach proxy at ${proxyUrl}: ${err.message}`)); });

    req.write(body);
    req.end();
  });
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/housekeeping
 *
 * Reconnects to the Oracle DB that produced this health check and fetches
 * auto-housekeeping window status (DBA_AUTOTASK_CLIENT, DBA_SCHEDULER_WINDOWS,
 * DBA_TAB_STATISTICS). Works for demo health checks too.
 *
 * Returns:
 *   {
 *     autotask_clients: [...],
 *     windows:          [...],
 *     stale_tables_count: number,
 *     stale_tables_top10: [...],
 *     disabled_clients: string[],
 *     disabled_windows: string[]
 *   }
 */
router.post('/health-checks/:id/housekeeping', requireAuth, async (req, res) => {
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
      return res.json(getDemoHousekeepingStatus());
    }

    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    if (!hc.connection_id) {
      return res.status(400).json({ error: 'Health check has no saved connection — cannot query housekeeping status' });
    }

    // Proxy connection — route through proxy /api/housekeeping endpoint
    if (hc.connection_type === 'proxy') {
      if (!hc.proxy_url || !hc.proxy_api_key_enc) {
        return res.status(400).json({ error: 'Proxy connection is missing URL or API key' });
      }
      const proxyApiKey = decrypt(hc.proxy_api_key_enc);
      try {
        const result = await fetchHousekeepingFromProxy({
          proxyUrl: hc.proxy_url,
          proxyApiKey,
          serviceName: hc.service_name,
          username: hc.username,
          password: decrypt(hc.encrypted_password)
        });
        return res.json(result);
      } catch (proxyErr) {
        if (proxyErr.message === 'PROXY_OUTDATED') {
          // Proxy agent is running a version before /api/housekeeping was added (v3.2.0).
          // Auto-update checks every 6 hours; prompt user to restart their proxy.
          return res.status(426).json({
            error: 'Your proxy agent needs to be updated to support the Housekeeping tab. ' +
              'It will auto-update within 6 hours, or you can restart it now: ' +
              'pm2 restart tunevault-proxy (or re-run python3 oracle-proxy.py). ' +
              'If the problem persists, re-download from Settings → Proxy Setup.',
            code: 'PROXY_OUTDATED'
          });
        }
        throw proxyErr; // re-throw non-version errors to outer catch
      }
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

    const result = await oracle.queryHousekeepingWindows(connParams);
    res.json(result);
  } catch (err) {
    console.error('[housekeeping] Error fetching housekeeping status:', err);
    res.status(500).json({ error: 'Failed to fetch housekeeping status' });
  }
});

module.exports = router;
