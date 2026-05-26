/**
 * routes/apps-tunnel.js — EBS / WebLogic Quick Access tunnel.
 *
 * Owns: apps URL config per connection, signed tunnel tokens, HTTP forward through proxy.
 * Does NOT own: auth (middleware/auth.js), encryption (crypto-utils.js), Pool (db/index.js).
 *
 * Endpoints:
 *   PATCH /api/connections/:id/apps-urls          — save ebs_login_url / weblogic_console_url
 *   GET   /api/connections/:id/apps-urls          — read stored apps URLs (no credentials)
 *   GET   /api/connections/:id/open/ebs           — issue token → redirect through tunnel
 *   GET   /api/connections/:id/open/weblogic      — issue token → redirect through tunnel
 *   GET   /api/tunnel                             — resolve token, forward request via proxy
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const router = express.Router();
const pool   = require('../db/index');
const { decrypt } = require('../crypto-utils');
const { requireAuth, requireConnectionOwner } = require('../middleware/auth');

// In-memory token store: token → { connectionId, userId, targetUrl, expiresAt }
// Short-lived: 5 minutes. Tokens are one-time-use redirect aids, not persistent sessions.
const _tokens = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

// Prune expired tokens on each request (cheap — tokens are rare)
function pruneTokens() {
  const now = Date.now();
  for (const [k, v] of _tokens) {
    if (v.expiresAt < now) _tokens.delete(k);
  }
}

// ── GET /api/connections/:id/apps-urls ──────────────────────────────────────

router.get('/api/connections/:id/apps-urls',
  requireAuth, requireConnectionOwner,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ebs_login_url, weblogic_console_url, connection_type
         FROM oracle_connections WHERE id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const conn = rows[0];
      res.json({
        ebs_login_url:        conn.ebs_login_url        || null,
        weblogic_console_url: conn.weblogic_console_url || null,
        // tunnel only available on proxy connections
        tunnel_available: conn.connection_type === 'proxy',
      });
    } catch (err) {
      console.error('[apps-tunnel] GET apps-urls error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ── PATCH /api/connections/:id/apps-urls ────────────────────────────────────

router.patch('/api/connections/:id/apps-urls',
  requireAuth, requireConnectionOwner,
  async (req, res) => {
    const { ebs_login_url, weblogic_console_url } = req.body;

    // Validate: must be http/https or empty
    function validUrl(v) {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch { return false; }
    }
    if (!validUrl(ebs_login_url) || !validUrl(weblogic_console_url)) {
      return res.status(400).json({ error: 'URLs must be http:// or https://' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE oracle_connections
         SET ebs_login_url        = $1,
             weblogic_console_url = $2
         WHERE id = $3
         RETURNING id, ebs_login_url, weblogic_console_url`,
        [
          ebs_login_url        || null,
          weblogic_console_url || null,
          req.params.id,
        ]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true, connection: rows[0] });
    } catch (err) {
      console.error('[apps-tunnel] PATCH apps-urls error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ── Helper: issue a signed tunnel token for a connection + target URL ────────

async function issueTunnelToken(connId, userId, targetUrl) {
  pruneTokens();
  const token = crypto.randomBytes(32).toString('hex');
  _tokens.set(token, {
    connectionId: connId,
    userId,
    targetUrl,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

// ── GET /api/connections/:id/open/ebs ───────────────────────────────────────

router.get('/api/connections/:id/open/ebs',
  requireAuth, requireConnectionOwner,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ebs_login_url, connection_type FROM oracle_connections WHERE id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const conn = rows[0];
      if (!conn.ebs_login_url) {
        return res.status(400).json({ error: 'No EBS login URL configured for this connection' });
      }
      if (conn.connection_type !== 'proxy') {
        // Direct TCP — can't tunnel; just redirect to the URL directly
        return res.redirect(conn.ebs_login_url);
      }
      const token = await issueTunnelToken(req.params.id, req.user.id, conn.ebs_login_url);
      res.redirect(`/api/tunnel?t=${token}`);
    } catch (err) {
      console.error('[apps-tunnel] open/ebs error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ── GET /api/connections/:id/open/weblogic ──────────────────────────────────

router.get('/api/connections/:id/open/weblogic',
  requireAuth, requireConnectionOwner,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT weblogic_console_url, connection_type FROM oracle_connections WHERE id = $1`,
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      const conn = rows[0];
      if (!conn.weblogic_console_url) {
        return res.status(400).json({ error: 'No WebLogic console URL configured for this connection' });
      }
      if (conn.connection_type !== 'proxy') {
        return res.redirect(conn.weblogic_console_url);
      }
      const token = await issueTunnelToken(req.params.id, req.user.id, conn.weblogic_console_url);
      res.redirect(`/api/tunnel?t=${token}`);
    } catch (err) {
      console.error('[apps-tunnel] open/weblogic error:', err.message);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

// ── GET /api/tunnel?t=<token> ────────────────────────────────────────────────
// Resolves the token, fetches the target URL via the connection's proxy,
// and streams the response back to the browser.

router.get('/api/tunnel', requireAuth, async (req, res) => {
  pruneTokens();
  const { t } = req.query;
  if (!t) return res.status(400).send('Missing token');

  const entry = _tokens.get(t);
  if (!entry) return res.status(400).send('Invalid or expired tunnel token');
  if (entry.expiresAt < Date.now()) {
    _tokens.delete(t);
    return res.status(400).send('Tunnel token expired');
  }
  // Tokens are single-use for the redirect flow
  _tokens.delete(t);

  // Ownership re-check — ensure the authed user matches the token's userId
  if (entry.userId !== req.user.id) {
    return res.status(403).send('Forbidden');
  }

  const { connectionId, targetUrl } = entry;

  try {
    // Fetch proxy credentials for this connection
    const { rows } = await pool.query(
      `SELECT proxy_url, proxy_api_key_enc, connection_type
       FROM oracle_connections WHERE id = $1`,
      [connectionId]
    );
    if (!rows[0]) return res.status(404).send('Connection not found');
    const conn = rows[0];

    if (conn.connection_type !== 'proxy' || !conn.proxy_url || !conn.proxy_api_key_enc) {
      // No proxy — stream the URL directly through TuneVault server (best-effort)
      return streamDirect(res, targetUrl);
    }

    const apiKey = decrypt(conn.proxy_api_key_enc);
    const proxyBase = conn.proxy_url.replace(/\/+$/, '');

    // Ask the proxy to forward the request
    const fwdBody = JSON.stringify({
      target_url: targetUrl,
      method: 'GET',
      headers: { 'User-Agent': 'TuneVault-Tunnel/1.0' },
      body: '',
    });

    const proxyEndpoint = `${proxyBase}/api/http-forward`;
    const proxyRes = await postJson(proxyEndpoint, apiKey, fwdBody);

    if (!proxyRes.success) {
      const msg = proxyRes.error || 'Proxy returned an error';
      return res.status(502).send(tunnelErrorPage(targetUrl, msg));
    }

    // Decode base64 body from proxy
    const bodyBuf = Buffer.from(proxyRes.body || '', 'base64');
    const contentType = (proxyRes.headers || {})['Content-Type']
                      || (proxyRes.headers || {})['content-type']
                      || 'text/html';

    // Rewrite relative links to go through the tunnel (simple host-prefix rewrite)
    let responseBody;
    if (contentType.includes('text/html')) {
      responseBody = rewriteHtml(bodyBuf.toString('utf8'), targetUrl, connectionId);
    } else {
      responseBody = bodyBuf;
    }

    res.status(proxyRes.status || 200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-TuneVault-Tunnel', '1');
    // Strip dangerous headers
    res.removeHeader('X-Frame-Options');
    res.send(responseBody);
  } catch (err) {
    console.error('[apps-tunnel] tunnel error:', err.message);
    res.status(502).send(tunnelErrorPage(targetUrl, err.message));
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * POST JSON to the proxy's /api/http-forward endpoint.
 * Returns parsed JSON body (or throws on network error).
 */
function postJson(proxyEndpoint, apiKey, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(proxyEndpoint); } catch (e) { return reject(e); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuf = Buffer.from(body, 'utf8');

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': bodyBuf.length,
        'X-Api-Key':      apiKey,
      },
      rejectUnauthorized: false, // proxy may use self-signed cert
    };

    const req = lib.request(options, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Proxy returned invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Proxy request timed out')); });
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Stream a URL directly (no proxy) — used for non-proxy connections.
 */
function streamDirect(res, targetUrl) {
  const lib = targetUrl.startsWith('https') ? https : http;
  const options = { rejectUnauthorized: false };
  const req = lib.get(targetUrl, options, (resp) => {
    res.status(resp.statusCode || 200);
    const ct = resp.headers['content-type'] || 'text/html';
    res.setHeader('Content-Type', ct);
    res.setHeader('X-TuneVault-Tunnel', '1');
    resp.pipe(res);
  });
  req.on('error', (err) => {
    res.status(502).send(tunnelErrorPage(targetUrl, err.message));
  });
  req.setTimeout(20000, () => { req.destroy(new Error('Request timed out')); });
}

/**
 * Rewrite absolute and relative URLs in HTML so links go through /api/tunnel.
 * This is best-effort — handles the most common hrefs/actions/src patterns.
 */
function rewriteHtml(html, targetUrl, connectionId) {
  // For simplicity, inject a <base> tag if not present, pointing to target origin.
  // This makes relative links resolve against the real origin, which the proxy fetches.
  const baseTag = `<base href="${escapeAttr(targetUrl)}">`;
  if (!html.includes('<base ') && !html.includes('<base>')) {
    html = html.replace(/<head[^>]*>/i, (m) => m + baseTag);
  }
  return html;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function tunnelErrorPage(targetUrl, msg) {
  return `<!DOCTYPE html>
<html>
<head><title>Tunnel Error</title>
<style>body{font-family:system-ui,sans-serif;padding:40px;background:#0f0f11;color:#e2e8f0;}
.box{max-width:600px;margin:auto;background:#1a1a2e;padding:32px;border-radius:12px;border:1px solid #334155;}
h2{color:#f87171;margin:0 0 16px}
code{background:#0f172a;padding:4px 8px;border-radius:4px;font-size:13px;word-break:break-all;display:block;margin:8px 0;color:#94a3b8;}
a.back{display:inline-block;margin-top:24px;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;}
</style></head>
<body>
<div class="box">
  <h2>Tunnel Error</h2>
  <p>Could not reach the target URL through your proxy.</p>
  <p><strong>Target:</strong><code>${escapeAttr(targetUrl)}</code></p>
  <p><strong>Error:</strong><code>${escapeAttr(msg)}</code></p>
  <p style="color:#94a3b8;font-size:13px;">Make sure <code>APPS_URL_WHITELIST</code> is set in your <code>proxy.env</code> and includes this host:port.</p>
  <a class="back" href="/dashboard">← Back to Dashboard</a>
</div>
</body></html>`;
}

module.exports = router;
