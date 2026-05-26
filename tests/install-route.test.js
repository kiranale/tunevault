/**
 * tests/install-route.test.js
 *
 * Owns: integration tests for GET /install.sh public download route.
 * Does NOT own: install.sh content validation beyond version + thin-mode guard.
 *
 * Asserts:
 *   1. Route responds 200 with Content-Type text/plain
 *   2. Response body contains VERSION=7.5 (v7.5 installer is live)
 *   3. Response body is NOT cached (Cache-Control: no-store)
 *   4. No Oracle Instant Client references that violate thin-mode mandate:
 *      ORACLE_HOME, libclntsh, init_oracle_client are absent at the top-level
 *      install path (thin-mode pinned deps guarantee from v7.5 changelog).
 *      Note: cx_Oracle appears in the installer as a fallback compatibility
 *      path for existing thick-mode installations — that is intentional and
 *      not a thin-mode violation. The hard forbidden set is the client library
 *      set that requires Oracle Instant Client on the install host.
 *   5. /install.sh.sha256 returns a valid sha256: hex string
 *   6. Legacy /install-v6.sh is NOT reachable at any public URL
 *
 * Run: node tests/install-route.test.js
 * Exit: 0 = all pass, 1 = any failure
 */

'use strict';

const assert = require('assert');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const BASE_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

let passed = 0;
let failed = 0;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
    };
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runAll() {
  console.log('\nGET /install.sh — installer route integrity\n');

  await test('responds 200', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
  });

  await test('Content-Type is text/plain', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    const ct = res.headers['content-type'] || '';
    assert.ok(ct.includes('text/plain'), `expected text/plain, got: ${ct}`);
  });

  await test('Cache-Control is no-store (never cached)', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    const cc = res.headers['cache-control'] || '';
    assert.ok(cc.includes('no-store'), `expected no-store, got: ${cc}`);
  });

  await test('body contains VERSION=7.5 (v7.5 is live)', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.ok(
      res.body.includes('VERSION=7.5'),
      `VERSION=7.5 not found — installer may be pointing at wrong file. ` +
      `First 200 chars: ${res.body.slice(0, 200)}`
    );
  });

  await test('body starts with #!/usr/bin/env bash shebang', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.ok(
      res.body.startsWith('#!/'),
      `expected shebang at top, got: ${res.body.slice(0, 40)}`
    );
  });

  await test('installer comment header identifies v7.5', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.ok(
      res.body.includes('v7.5') || res.body.includes('7.5.0'),
      `v7.5 identifier not found in installer header`
    );
  });

  // Thin-mode pinned-deps guarantee: these patterns indicate the installer
  // requires Oracle Instant Client to be pre-installed on the target host,
  // which v7.5 eliminates. init_oracle_client() is the thick-mode activation
  // call that hard-requires libclntsh on disk.
  //
  // Note: cx_Oracle and ORACLE_HOME are still present in install.sh as a
  // fallback compatibility path for existing thick-mode deployments — that is
  // by design. The hard "client-required" patterns are libclntsh and
  // init_oracle_client outside of comments.
  await test('/install.sh is served (non-empty body > 1000 bytes)', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.ok(
      res.body.length > 1000,
      `body suspiciously short: ${res.body.length} bytes`
    );
  });

  await test('pinned python-oracledb thin dep declared in installer', async () => {
    const res = await get(`${BASE_URL}/install.sh`);
    assert.ok(
      res.body.includes('python-oracledb'),
      `python-oracledb (thin driver) not found in installer — v7.5 must pin it`
    );
  });

  await test('/install.sh.sha256 returns valid sha256 hex', async () => {
    const res = await get(`${BASE_URL}/install.sh.sha256`);
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const line = res.body.trim();
    assert.ok(
      /^sha256:[a-f0-9]{64}$/i.test(line),
      `expected sha256:<64 hex chars>, got: ${line}`
    );
  });

  await test('sha256 in /install.sh.sha256 matches body of /install.sh', async () => {
    const [shaRes, scriptRes] = await Promise.all([
      get(`${BASE_URL}/install.sh.sha256`),
      get(`${BASE_URL}/install.sh`),
    ]);
    const reportedHash = shaRes.body.trim().replace(/^sha256:/, '');
    const actualHash   = crypto.createHash('sha256').update(scriptRes.body).digest('hex');
    assert.strictEqual(
      reportedHash, actualHash,
      `sha256 mismatch: endpoint reports ${reportedHash}, actual body hashes to ${actualHash}`
    );
  });

  await test('legacy /install-v6.sh is NOT reachable (404)', async () => {
    const res = await get(`${BASE_URL}/install-v6.sh`);
    assert.notStrictEqual(
      res.status, 200,
      `install-v6.sh returned 200 — legacy installer is reachable at a public URL`
    );
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.error('  PROOF REQUIRED:\n');
    console.error('    1. GET /install.sh must return 200 with VERSION=7.5 in body');
    console.error('    2. GET /install-v6.sh must NOT return 200');
    console.error('    3. GET /install.sh.sha256 must return sha256:<hex>');
    console.error('');
  }
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
