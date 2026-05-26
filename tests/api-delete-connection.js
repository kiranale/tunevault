/**
 * tests/api-delete-connection.js — Synthetic integration test for DELETE /api/connections/:id
 *
 * Verifies the full delete lifecycle:
 *   1. POST /api/admin/test/connections  → create a synthetic connection (admin endpoint)
 *   2. GET  /api/connections             → confirm it appears in the list
 *   3. DELETE /api/connections/:id       → delete it
 *   4. GET  /api/connections             → assert it is gone (not in list)
 *
 * Requires:
 *   - APP_URL env var (e.g. http://localhost:3000 or https://tunevault-wney.polsia.app)
 *   - TEST_ADMIN_TOKEN env var — a valid admin session cookie value (tv_session=...)
 *
 * Run with: node tests/api-delete-connection.js
 * Exit code: 0 = all pass, 1 = any failure
 */

'use strict';

const assert = require('assert');

const BASE_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.TEST_ADMIN_TOKEN;

if (!TOKEN) {
  console.error('[delete-connection-test] FATAL: TEST_ADMIN_TOKEN env var not set. Skipping.');
  // Exit 0 — test infrastructure not ready is not a code failure.
  process.exit(0);
}

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  ✗  ${label}`);
  console.error(`     ${err && err.message ? err.message : String(err)}`);
  failed++;
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: {
      'Cookie': `tv_session=${TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

// ── Test: create → confirm → delete → confirm gone ─────────────────────────

async function run() {
  console.log(`\n[delete-connection-test] Running against ${BASE_URL}\n`);

  // ── Step 1: Create a synthetic test connection via the admin test API ──────
  let connId = null;
  try {
    const { status, json } = await request('POST', '/api/admin/test/connections', {
      name: '__ci-delete-test__',
      host: 'test.invalid',
      port: 1521,
      service_name: 'TESTSVC',
      username: 'ci_test',
      password: 'ci_test_pw',
    });
    assert.strictEqual(status, 201, `Expected 201, got ${status}: ${JSON.stringify(json)}`);
    assert.ok(json && json.id, 'Response must include id');
    connId = json.id;
    ok(`POST /api/admin/test/connections → 201, id=${connId}`);
  } catch (err) {
    fail('POST /api/admin/test/connections', err);
    // Without a connection to delete the rest of the test can't run.
    summarize();
    return;
  }

  // ── Step 2: Confirm the connection appears in GET /api/connections ─────────
  try {
    const { status, json } = await request('GET', '/api/connections');
    assert.ok([200].includes(status), `Expected 200, got ${status}`);
    const found = Array.isArray(json) ? json.some(c => c.id === connId) : false;
    assert.ok(found, `Connection id=${connId} not found in GET /api/connections response`);
    ok(`GET /api/connections → 200, connection id=${connId} present`);
  } catch (err) {
    fail('GET /api/connections (pre-delete)', err);
  }

  // ── Step 3: Delete the connection ─────────────────────────────────────────
  try {
    const { status, json } = await request('DELETE', `/api/connections/${connId}`);
    assert.ok([200, 204].includes(status), `Expected 200/204, got ${status}: ${JSON.stringify(json)}`);
    // 200 returns { deleted: true }; 204 returns no body
    if (status === 200) {
      assert.ok(json && json.deleted === true, `Response should have deleted:true, got: ${JSON.stringify(json)}`);
    }
    ok(`DELETE /api/connections/${connId} → ${status}`);
  } catch (err) {
    fail(`DELETE /api/connections/${connId}`, err);
    // Cleanup attempt: don't leave test data behind
    await request('DELETE', `/api/connections/${connId}`).catch(() => {});
    summarize();
    return;
  }

  // ── Step 4: Confirm connection is gone from GET /api/connections ───────────
  try {
    const { status, json } = await request('GET', '/api/connections');
    assert.ok([200].includes(status), `Expected 200, got ${status}`);
    const found = Array.isArray(json) ? json.some(c => c.id === connId) : false;
    assert.ok(!found, `Connection id=${connId} still present after DELETE — cascade failed`);
    ok(`GET /api/connections → 200, connection id=${connId} absent (cascade confirmed)`);
  } catch (err) {
    fail('GET /api/connections (post-delete)', err);
  }

  // ── Step 5: GET by direct ID should 404 ───────────────────────────────────
  try {
    const { status } = await request('GET', `/api/connections/${connId}`);
    assert.ok([404].includes(status), `Expected 404, got ${status} — connection still exists`);
    ok(`GET /api/connections/${connId} → 404 (connection fully deleted)`);
  } catch (err) {
    fail(`GET /api/connections/${connId} (expect 404)`, err);
  }

  summarize();
}

function summarize() {
  const total = passed + failed;
  console.log(`\n[delete-connection-test] ${passed}/${total} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[delete-connection-test] Unexpected error:', err);
  process.exit(1);
});
