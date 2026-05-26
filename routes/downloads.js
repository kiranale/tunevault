/**
 * routes/downloads.js — Static binary + package downloads for the TuneVault agent installer.
 *
 * Owns: GET /downloads/oracle-proxy.py, GET /downloads/agent-pkg.tar.gz,
 *       GET /install.sh, GET /uninstall.sh,
 *       GET /downloads/instantclient/:arch/:filename (IC mirror proxy for DPY-3015 self-healing)
 * Does NOT own: agent provisioning / token lifecycle (routes/agent.js),
 *               SSH install automation (routes/ssh-install.js).
 *
 * Security: all endpoints are public (no auth) — the files contain no secrets.
 * The API key is injected at install time via TUNEVAULT_TOKEN env var, not baked in.
 */

'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const { execSync } = require('child_process');

const router = express.Router();

const ROOT = path.join(__dirname, '..');

// ── GET /downloads/oracle-proxy.py ───────────────────────────────────────────
// Legacy proxy script — still shipped alongside agent/ for backward compat.
router.get('/downloads/oracle-proxy.py', (req, res) => {
  const file = path.join(ROOT, 'oracle-proxy.py');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain').send('oracle-proxy.py not found');
  }
  res.setHeader('Content-Type', 'text/x-python');
  res.setHeader('Content-Disposition', 'attachment; filename="oracle-proxy.py"');
  res.sendFile(file);
});

// ── GET /downloads/agent-pkg.tar.gz ──────────────────────────────────────────
// The agent/ Python package, streamed as a gzipped tar.
// install.sh unpacks this into /opt/tunevault/agent/ so `python3 -m agent.cli` works.
//
// Built on-demand from the agent/ directory at repo root — no build step required.
// Cached for 60s to avoid re-tarring on every installer invocation.
let _agentTarCache = null;
let _agentTarCachedAt = 0;
const AGENT_TAR_TTL_MS = 60_000;

router.get('/downloads/agent-pkg.tar.gz', (req, res) => {
  const agentDir = path.join(ROOT, 'agent');
  if (!fs.existsSync(agentDir)) {
    return res.status(404).type('text/plain').send('agent package not found');
  }

  try {
    const now = Date.now();
    if (!_agentTarCache || now - _agentTarCachedAt > AGENT_TAR_TTL_MS) {
      // tar -czf - -C /repo/root agent/  → streams agent/ subtree
      _agentTarCache = execSync(`tar -czf - -C "${ROOT}" agent`, {
        maxBuffer: 10 * 1024 * 1024, // 10 MB — agent package is tiny
      });
      _agentTarCachedAt = now;
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="agent-pkg.tar.gz"');
    res.setHeader('Content-Length', _agentTarCache.length);
    res.send(_agentTarCache);
  } catch (err) {
    console.error('[downloads] Failed to build agent-pkg.tar.gz:', err.message);
    res.status(500).type('text/plain').send('Failed to build agent package');
  }
});

// ── GET /install.sh ───────────────────────────────────────────────────────────
router.get('/install.sh', (req, res) => {
  const file = path.join(ROOT, 'install.sh');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="install.sh"');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

// ── GET /uninstall.sh ─────────────────────────────────────────────────────────
router.get('/uninstall.sh', (req, res) => {
  const file = path.join(ROOT, 'uninstall.sh');
  if (!fs.existsSync(file)) {
    return res.status(404).type('text/plain').send('uninstall.sh not found');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="uninstall.sh"');
  res.sendFile(file);
});

// ── GET /downloads/instantclient/:arch/:filename ──────────────────────────────
// Mirror proxy for Oracle Instant Client RPMs. install.sh calls this during the
// DPY-3015 self-healing path so customers never need direct access to oracle.com.
//
// WHY proxy instead of cache: RPMs are ~80 MB — too large for in-process RAM cache
// on a 512 MB Render dyno. We stream the oracle.com response through directly.
// Latency is the same as a direct download; the benefit is one outbound URL to
// whitelist instead of requiring *.oracle.com access on customer networks.
//
// Supported arches: x86_64, aarch64
// Expected filenames: oracle-instantclient21-basic.rpm, oracle-instantclient21-sqlplus.rpm
//                     oracle-instantclient19.1-basic-19.1.0.0.0-1.aarch64.rpm (aarch64 fallback)
//
// Security: filename is validated against an allowlist — no path traversal possible.

const IC_ALLOWLIST = new Set([
  'oracle-instantclient21-basic.rpm',
  'oracle-instantclient21-sqlplus.rpm',
  'oracle-instantclient19.1-basic-19.1.0.0.0-1.aarch64.rpm',
  'oracle-instantclient19.1-sqlplus-19.1.0.0.0-1.aarch64.rpm',
]);

const IC_ARCH_ORIGINS = {
  x86_64:  'https://download.oracle.com/otn_software/linux/instantclient/2110000',
  aarch64: 'https://download.oracle.com/otn_software/linux/instantclient/191000',
};

router.get('/downloads/instantclient/:arch/:filename', (req, res) => {
  const { arch, filename } = req.params;

  // Validate arch
  if (!IC_ARCH_ORIGINS[arch]) {
    return res.status(400).type('text/plain').send(`Unsupported arch: ${arch}. Supported: x86_64, aarch64`);
  }

  // Validate filename against allowlist — prevents path traversal / arbitrary oracle.com fetches
  if (!IC_ALLOWLIST.has(filename)) {
    return res.status(400).type('text/plain').send(`File not in allowlist: ${filename}`);
  }

  const upstreamUrl = `${IC_ARCH_ORIGINS[arch]}/${filename}`;

  console.log(`[downloads] IC mirror proxy: ${arch}/${filename} → ${upstreamUrl}`);

  // Stream oracle.com response through to client
  const proto = upstreamUrl.startsWith('https') ? https : http;
  const upstreamReq = proto.get(upstreamUrl, { timeout: 300_000 }, (upstreamRes) => {
    const { statusCode, headers } = upstreamRes;

    if (statusCode === 301 || statusCode === 302) {
      // Follow one redirect (oracle.com sometimes redirects CDN)
      const location = headers.location;
      if (!location) {
        return res.status(502).type('text/plain').send('IC mirror: upstream redirect with no Location');
      }
      const redirProto = location.startsWith('https') ? https : http;
      const redirReq = redirProto.get(location, { timeout: 300_000 }, (redirRes) => {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (redirRes.headers['content-length']) {
          res.setHeader('Content-Length', redirRes.headers['content-length']);
        }
        res.status(200);
        redirRes.pipe(res);
        redirRes.on('error', (err) => {
          console.error('[downloads] IC redirect stream error:', err.message);
          if (!res.headersSent) res.status(502).end();
        });
      });
      redirReq.on('error', (err) => {
        console.error('[downloads] IC redirect request error:', err.message);
        if (!res.headersSent) res.status(502).type('text/plain').send(`IC mirror redirect error: ${err.message}`);
      });
      redirReq.on('timeout', () => {
        redirReq.destroy();
        if (!res.headersSent) res.status(504).type('text/plain').send('IC mirror redirect timeout');
      });
      return;
    }

    if (statusCode !== 200) {
      console.warn(`[downloads] IC mirror upstream returned ${statusCode} for ${filename}`);
      return res.status(502).type('text/plain').send(`IC mirror upstream returned ${statusCode}`);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (headers['content-length']) {
      res.setHeader('Content-Length', headers['content-length']);
    }
    res.status(200);
    upstreamRes.pipe(res);
    upstreamRes.on('error', (err) => {
      console.error('[downloads] IC upstream stream error:', err.message);
      if (!res.headersSent) res.status(502).end();
    });
  });

  upstreamReq.on('error', (err) => {
    console.error('[downloads] IC mirror request error:', err.message);
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(`IC mirror unavailable: ${err.message}`);
    }
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy();
    if (!res.headersSent) res.status(504).type('text/plain').send('IC mirror timeout (300s)');
  });
});

module.exports = router;
