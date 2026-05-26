/**
 * routes/os-exec.js — OS command execution via oracle-proxy /api/os/exec endpoint.
 *
 * Owns: POST /api/connections/:id/os/exec — runs a whitelisted OS command on the
 *       Oracle server through the existing outbound-only proxy agent (no SSH needed).
 * Does NOT own: SSH execution (routes/ssh-execute.js), Oracle queries (oracle-client.js),
 *               connection storage (db/connections or pool queries).
 *
 * Only proxy connections are supported — direct TCP connections return 400.
 * The command whitelist lives on the proxy; this route passes the key through.
 * Auth: session cookie or Bearer token (same as all TuneVault API routes).
 */

'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const pool    = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Proxy call helper ────────────────────────────────────────────────────────

function callProxyOsExec({ proxyUrl, proxyApiKey, command }) {
  const url  = new URL('/api/os/exec', proxyUrl);
  const body = JSON.stringify({ command });

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Key':      proxyApiKey,
      },
      timeout: 20000, // 10s exec + network round-trip headroom
    };

    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode === 404) {
            const err = new Error('PROXY_OUTDATED');
            err.statusCode = 404;
            return reject(err);
          }
          if (resp.statusCode === 403) {
            return reject(new Error(parsed.error || 'Command not allowed by proxy whitelist'));
          }
          if (resp.statusCode !== 200) {
            return reject(new Error(parsed.error || `Proxy returned HTTP ${resp.statusCode}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Invalid JSON from proxy: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(new Error('Proxy OS exec request timed out')); });
    req.on('error',   (err) => { reject(new Error(`Could not reach proxy at ${proxyUrl}: ${err.message}`)); });

    req.write(body);
    req.end();
  });
}

// ─── POST /api/connections/:id/os/exec ───────────────────────────────────────

router.post('/:id/os/exec', requireAuth, async (req, res) => {
  const connId  = parseInt(req.params.id, 10);
  const command = (req.body?.command || '').trim();

  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });
  if (!command) return res.status(400).json({ error: '"command" is required in request body' });

  // Load connection — enforce ownership
  const { rows } = await pool.query(
    `SELECT id, connection_type, proxy_url, proxy_api_key_enc
       FROM oracle_connections
      WHERE id = $1 AND user_id = $2`,
    [connId, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Connection not found' });

  const conn = rows[0];
  if (conn.connection_type !== 'proxy') {
    return res.status(400).json({
      error: 'OS exec is only available for proxy connections',
      hint:  'Direct TCP connections cannot run OS commands without SSH.',
    });
  }

  if (!conn.proxy_url || !conn.proxy_api_key_enc) {
    return res.status(400).json({ error: 'Proxy URL or API key not configured for this connection' });
  }

  let proxyApiKey;
  try {
    proxyApiKey = decrypt(conn.proxy_api_key_enc);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to decrypt proxy API key' });
  }

  try {
    const result = await callProxyOsExec({
      proxyUrl:    conn.proxy_url,
      proxyApiKey,
      command,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err.message === 'PROXY_OUTDATED') {
      return res.status(400).json({
        error:   'Proxy version too old — upgrade to v3.5.5+ for OS exec support',
        code:    'PROXY_OUTDATED',
        upgrade: true,
      });
    }
    return res.status(502).json({ error: err.message });
  }
});

module.exports = router;
