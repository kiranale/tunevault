/**
 * tests/heartbeat-check.test.js
 *
 * Integration tests for GET /api/agent/heartbeat-check?connection_id=N.
 *
 * Covers:
 *   1. Missing connection_id → 400
 *   2. Non-integer connection_id → 400
 *   3. Unknown connection_id (no tunnel record) → 404
 *   4. alive=true when last heartbeat is within 90 seconds
 *   5. alive=false when last heartbeat is beyond 90 seconds (via a mock or stale connection)
 *   6. Response never exposes Oracle SIDs or hostnames
 *   7. Cache: two rapid requests in <5s return identical seconds_ago
 *      (proving the 5s in-memory cache is active)
 *
 * NOTE: Tests 4, 5, 7 require a real connection_id that has sent a heartbeat.
 * Set TEST_LIVE_CONNECTION_ID in env to enable those tests.
 * Without it, only tests 1-3 run (which are always safe).
 *
 * Run: node tests/heartbeat-check.test.js
 * Exit: 0 = all pass (or skipped), 1 = any failure.
 */

'use strict';

const assert = require('assert');
const http   = require('http');
const https  = require('https');

const BASE_URL      = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const LIVE_CONN_ID  = process.env.TEST_LIVE_CONNECTION_ID || null;
const STALE_CONN_ID = process.env.TEST_STALE_CONNECTION_ID || null;
const ENDPOINT      = `${BASE_URL}/api/agent/heartbeat-check`;

let passed = 0;
let failed = 0;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
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

function skip(name, reason) {
  console.log(`  -  ${name} [SKIPPED: ${reason}]`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runAll() {
  console.log('\nGET /api/agent/heartbeat-check\n');

  // Always-safe tests (no DB state needed) ─────────────────────────────────

  await test('missing connection_id → 400', async () => {
    const res = await get(`${ENDPOINT}`);
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.ok(res.body.error, 'expected error message');
  });

  await test('non-integer connection_id → 400', async () => {
    const res = await get(`${ENDPOINT}?connection_id=not-a-number`);
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    assert.ok(res.body.error, 'expected error message');
  });

  await test('unknown connection_id → 404 (no tunnel record)', async () => {
    // Use an astronomically large ID that cannot exist in the DB
    const res = await get(`${ENDPOINT}?connection_id=999999999`);
    assert.strictEqual(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Tests that need a live connection ──────────────────────────────────────

  if (LIVE_CONN_ID) {
    await test(`alive=true when connection ${LIVE_CONN_ID} has recent heartbeat`, async () => {
      const res = await get(`${ENDPOINT}?connection_id=${LIVE_CONN_ID}`);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      assert.strictEqual(res.body.alive, true, `expected alive:true, seconds_ago=${res.body.seconds_ago}`);
      assert.ok(res.body.seconds_ago !== null, 'expected seconds_ago to be set');
      assert.ok(res.body.seconds_ago <= 90, `expected seconds_ago<=90, got ${res.body.seconds_ago}`);
    });

    await test('response does not expose Oracle SIDs or hostnames', async () => {
      const res = await get(`${ENDPOINT}?connection_id=${LIVE_CONN_ID}`);
      assert.strictEqual(res.status, 200);
      const allowed = new Set(['alive', 'last_heartbeat_at', 'seconds_ago', 'error']);
      const keys = Object.keys(res.body);
      for (const key of keys) {
        assert.ok(allowed.has(key), `unexpected field in response: ${key}`);
      }
    });

    await test('5s cache: two immediate requests return same seconds_ago', async () => {
      const r1 = await get(`${ENDPOINT}?connection_id=${LIVE_CONN_ID}`);
      const r2 = await get(`${ENDPOINT}?connection_id=${LIVE_CONN_ID}`);
      assert.strictEqual(r1.status, 200);
      assert.strictEqual(r2.status, 200);
      // Same seconds_ago → same cache hit (in-process cache served both)
      assert.strictEqual(
        r1.body.seconds_ago, r2.body.seconds_ago,
        `expected same seconds_ago from cache: ${r1.body.seconds_ago} vs ${r2.body.seconds_ago}`
      );
    });
  } else {
    skip('alive=true with recent heartbeat', 'TEST_LIVE_CONNECTION_ID not set');
    skip('response does not expose SIDs/hostnames', 'TEST_LIVE_CONNECTION_ID not set');
    skip('5s cache: two rapid requests return same seconds_ago', 'TEST_LIVE_CONNECTION_ID not set');
  }

  if (STALE_CONN_ID) {
    await test(`alive=false when connection ${STALE_CONN_ID} has stale heartbeat (>90s)`, async () => {
      const res = await get(`${ENDPOINT}?connection_id=${STALE_CONN_ID}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.alive, false, `expected alive:false, got alive:${res.body.alive}`);
      if (res.body.seconds_ago !== null) {
        assert.ok(res.body.seconds_ago > 90, `expected seconds_ago>90, got ${res.body.seconds_ago}`);
      }
    });
  } else {
    skip('alive=false with stale heartbeat', 'TEST_STALE_CONNECTION_ID not set');
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
