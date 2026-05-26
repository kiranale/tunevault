/**
 * test/health-smoke.js — Post-deploy smoke test for GET /api/health + GET /api/agent/health.
 *
 * Run: node test/health-smoke.js [base_url]
 * Default base URL: https://tunevault-wney.polsia.app
 *
 * Exits 0 on pass, 1 on any failure. Designed to run in CI post-deploy.
 * Timeout per request: 10s. No external deps — pure Node.js stdlib.
 */

'use strict';

const https = require('https');
const http = require('http');

const BASE_URL = process.argv[2] || process.env.SMOKE_BASE_URL || 'https://tunevault-wney.polsia.app';
const TIMEOUT_MS = 10_000;

let failed = false;

function assert(cond, msg) {
  if (!cond) {
    console.error('  FAIL:', msg);
    failed = true;
  } else {
    console.log('  PASS:', msg);
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);
  });
}

async function runTests() {
  console.log(`\nSmoke test: ${BASE_URL}\n`);

  // ── GET /api/health ─────────────────────────────────────────────────────────
  console.log('--- GET /api/health ---');
  let r;
  try {
    r = await get(`${BASE_URL}/api/health`);
  } catch (err) {
    console.error('FAIL: Could not connect:', err.message);
    process.exit(1);
  }

  assert(r.status === 200 || r.status === 503, `status is 200 or 503 (got ${r.status})`);
  assert(r.status === 200, `status is 200 — DB reachable (got ${r.status})`);
  assert(r.headers['content-type']?.includes('application/json'), 'Content-Type is application/json');
  assert(r.headers['cache-control'] === 'no-store', 'Cache-Control is no-store');
  assert(r.headers['access-control-allow-origin'] === '*', 'CORS header is *');

  const b = r.body;
  assert(typeof b === 'object' && b !== null, 'body is JSON object');
  assert(['ok', 'degraded'].includes(b.status), `status field is ok|degraded (got ${b.status})`);
  assert(typeof b.version === 'string', `version is string (got ${typeof b.version})`);
  assert(typeof b.build_sha === 'string', `build_sha is string (got ${typeof b.build_sha})`);
  assert(typeof b.uptime_seconds === 'number', `uptime_seconds is number`);
  assert(typeof b.timestamp === 'string' && b.timestamp.endsWith('Z'), `timestamp is ISO8601 UTC`);
  assert(typeof b.db === 'object', 'db field present');
  assert(typeof b.db.connected === 'boolean', 'db.connected is boolean');
  assert(typeof b.db.latency_ms === 'number', 'db.latency_ms is number');
  assert(typeof b.queue === 'object', 'queue field present');

  // ── GET /api/agent/health ───────────────────────────────────────────────────
  console.log('\n--- GET /api/agent/health ---');
  let r2;
  try {
    r2 = await get(`${BASE_URL}/api/agent/health`);
  } catch (err) {
    console.error('FAIL: Could not connect to /api/agent/health:', err.message);
    process.exit(1);
  }

  assert(r2.status === 200, `status is 200 (got ${r2.status})`);
  const b2 = r2.body;
  assert(typeof b2 === 'object' && b2 !== null, 'body is JSON object');
  assert(b2.status === 'ok', `status is ok (got ${b2.status})`);
  assert(typeof b2.build_sha === 'string', `build_sha is string (got ${typeof b2.build_sha})`);
  assert(typeof b2.min_agent_version === 'string', `min_agent_version is string (got ${typeof b2.min_agent_version})`);
  assert(/^\d+\.\d+\.\d+/.test(b2.min_agent_version), `min_agent_version looks like semver (got ${b2.min_agent_version})`);

  // ── GET /health — legacy alias ──────────────────────────────────────────────
  console.log('\n--- GET /health (legacy alias) ---');
  let r3;
  try {
    r3 = await get(`${BASE_URL}/health`);
  } catch (err) {
    console.error('FAIL: Could not connect to /health:', err.message);
    process.exit(1);
  }
  assert(r3.status === 200, `legacy /health returns 200 (got ${r3.status})`);

  console.log('\n' + (failed ? '❌  SMOKE TEST FAILED' : '✅  SMOKE TEST PASSED'));
  process.exit(failed ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
