#!/usr/bin/env node
// tests/e2e/stub-cloud-server.js
//
// Owns: minimal HTTPS stub that impersonates the TuneVault cloud API for CI.
// Does NOT own: any real business logic, database access, or auth validation.
//
// Endpoints implemented (4):
//   GET  /api/health         — liveness probe used by oracle-proxy.py milestone 5
//   GET  /api/agent/release  — installer version banner (non-fatal if absent)
//   POST /api/agent/provision — install.sh: get API key + connection ID
//   POST /api/agent/poll     — oracle-proxy.py long-poll heartbeat (milestone 6+8)
//   POST /api/agent/register — tunevault-agent doctor --deep dry-run (milestone: register)
//   POST /api/agent/heartbeat — direct heartbeat (doctor --deep milestone)
//   POST /api/agent/confirm  — install.sh post-start registration
//   POST /api/agent/install-telemetry  — non-blocking telemetry (install.sh)
//   POST /api/agent/install-failures   — non-blocking failure report (install.sh)
//
// Usage (from workflow):
//   node tests/e2e/stub-cloud-server.js --port 8443 --tls-cert /tmp/stub.crt --tls-key /tmp/stub.key
//   # Writes received-register and received-heartbeat flags to /tmp/stub-audit/
//   # Writes PID to /tmp/stub-cloud.pid for cleanup

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let PORT    = 8443;
let TLS_CERT = null;
let TLS_KEY  = null;
let USE_HTTP = false;  // fallback for containers without openssl

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port')     PORT     = parseInt(args[i+1], 10);
  if (args[i] === '--tls-cert') TLS_CERT = args[i+1];
  if (args[i] === '--tls-key')  TLS_KEY  = args[i+1];
  if (args[i] === '--http')     USE_HTTP = true;
}

// ── Audit directory ───────────────────────────────────────────────────────────
// CI assertions read these flag files to verify the agent called home.
const AUDIT_DIR = '/tmp/stub-audit';
fs.mkdirSync(AUDIT_DIR, { recursive: true });

let registerCount = 0;
let heartbeatCount = 0;

function markReceived(name) {
  const p = path.join(AUDIT_DIR, name);
  fs.writeFileSync(p, String(Date.now()));
}

// ── Request handler ───────────────────────────────────────────────────────────
function handler(req, res) {
  const method = req.method;
  const url    = req.url.split('?')[0];  // strip query string

  // Collect body for POST requests
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      respond(method, url, body, res);
    } catch (err) {
      console.error('[stub] Handler error:', err.message);
      res.writeHead(500); res.end('Internal error');
    }
  });
}

function json(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function respond(method, url, body, res) {
  console.log('[stub] %s %s', method, url);

  // ── GET /api/health ──────────────────────────────────────────────────────
  if (method === 'GET' && url === '/api/health') {
    return json(res, 200, { status: 'ok', version: '0.0.0-stub' });
  }

  // ── GET /api/agent/release ───────────────────────────────────────────────
  if (method === 'GET' && url === '/api/agent/release') {
    return json(res, 200, {
      version:    '7.2.0',
      build_time: '2026-05-23T00:00:00Z',
      sha256:     'stubstubstubstubstubstubstubstubstubstubstubstubstubstubstubstub',
      python_min: '3.6',
    });
  }

  // ── POST /api/agent/provision ────────────────────────────────────────────
  // install.sh sends TUNEVAULT_TOKEN here; we return dummy credentials.
  if (method === 'POST' && url === '/api/agent/provision') {
    markReceived('received-provision');
    return json(res, 200, {
      api_key:       'tvp_stubkey_ci_0000000000000000',
      connection_id: 9999,
      api_url:       'https://tunevault.app',
    });
  }

  // ── POST /api/agent/poll ─────────────────────────────────────────────────
  // oracle-proxy.py long-poll heartbeat. Returns {work: null} → agent loops.
  // First call = "register" (milestone 6), subsequent = heartbeat (milestone 8).
  if (method === 'POST' && (url === '/api/agent/poll' || url === '/api/agent/heartbeat')) {
    if (registerCount === 0) {
      markReceived('received-register');
      registerCount++;
      console.log('[stub] First poll → register milestone');
    }
    heartbeatCount++;
    markReceived('received-heartbeat');
    if (heartbeatCount % 5 === 0) {
      console.log('[stub] Heartbeat count: %d', heartbeatCount);
    }
    return json(res, 200, { work: null });
  }

  // ── POST /api/agent/register (doctor --deep dry-run) ─────────────────────
  if (method === 'POST' && url === '/api/agent/register') {
    markReceived('received-register-dryrun');
    const isDryRun = req.headers['x-tunevault-doctor'] === 'dry-run';
    console.log('[stub] /api/agent/register dry-run=%s', isDryRun);
    return json(res, 200, {
      ok: true,
      dry_run: isDryRun,
      message: 'stub: registration accepted',
    });
  }

  // ── POST /api/agent/confirm ──────────────────────────────────────────────
  // install.sh sends OS/Oracle metadata after proxy starts.
  if (method === 'POST' && url === '/api/agent/confirm') {
    markReceived('received-confirm');
    return json(res, 200, { ok: true });
  }

  // ── POST /api/agent/install-telemetry ────────────────────────────────────
  // Non-blocking — just ack it.
  if (method === 'POST' && url === '/api/agent/install-telemetry') {
    return json(res, 200, { ok: true });
  }

  // ── POST /api/agent/install-failures ─────────────────────────────────────
  if (method === 'POST' && url === '/api/agent/install-failures') {
    return json(res, 200, { ok: true });
  }

  // ── GET /api/agent/heartbeat-check ──────────────────────────────────────
  // install.sh polls this to confirm heartbeat received.
  if (method === 'GET' && url === '/api/agent/heartbeat-check') {
    const received = heartbeatCount > 0;
    return json(res, 200, { heartbeat_received: received });
  }

  // ── Catch-all: 200 for everything else ───────────────────────────────────
  // WHY: install.sh makes additional calls (SID detect, etc) — don't block them.
  console.log('[stub] Unhandled %s %s — returning 200 {}', method, url);
  return json(res, 200, {});
}

// ── Start server ──────────────────────────────────────────────────────────────
function startServer() {
  let server;
  if (!USE_HTTP && TLS_CERT && TLS_KEY) {
    try {
      const opts = {
        cert: fs.readFileSync(TLS_CERT),
        key:  fs.readFileSync(TLS_KEY),
      };
      server = https.createServer(opts, handler);
      server.listen(PORT, '0.0.0.0', () => {
        console.log('[stub] HTTPS stub server listening on port %d', PORT);
        writePid();
      });
    } catch (err) {
      console.error('[stub] TLS setup failed, falling back to HTTP:', err.message);
      startHttp();
      return;
    }
  } else {
    startHttp();
    return;
  }
  server.on('error', err => {
    console.error('[stub] Server error:', err.message);
    process.exit(1);
  });
}

function startHttp() {
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('[stub] HTTP stub server listening on port %d', PORT);
    writePid();
  });
  server.on('error', err => {
    console.error('[stub] Server error:', err.message);
    process.exit(1);
  });
}

function writePid() {
  fs.writeFileSync('/tmp/stub-cloud.pid', String(process.pid));
}

// Audit summary on exit
process.on('SIGTERM', () => {
  console.log('[stub] Shutting down. register=%d heartbeat=%d', registerCount, heartbeatCount);
  process.exit(0);
});

startServer();
