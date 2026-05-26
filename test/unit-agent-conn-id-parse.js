/**
 * test/unit-agent-conn-id-parse.js — NaN connection_id guard regression test.
 *
 * Run: node test/unit-agent-conn-id-parse.js
 * No external test runner required — exits 0 on pass, 1 on fail.
 *
 * Motivation: parseInt("NaN") returns NaN in JS, not null. PostgreSQL's
 * integer columns reject "NaN" with: invalid input syntax for type integer: "NaN".
 * Every agent poll cycle (~30s) would trigger this if the guard were absent.
 *
 * Covered endpoints: /api/agent/poll (POST), /api/agent/respond (POST),
 *                   /api/agent/channel-status (GET), /api/agent/heartbeat-check (GET).
 */

'use strict';

const http = require('http');

const PORT = process.env.PORT || 10000;
const BASE = `http://localhost:${PORT}`;

// ── helpers ─────────────────────────────────────────────────────────────────

function post(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('\n=== NaN Connection ID Guard Tests ===\n');

  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log('  PASS:', msg);
      passed++;
    } else {
      console.error('  FAIL:', msg);
      failed++;
    }
  }

  // ── POST /api/agent/poll with NaN ───────────────────────────────────────
  {
    const r = await post('/api/agent/poll', { connection_id: 'NaN' });
    assert(r.status === 400, 'POST /api/agent/poll + NaN → 400');
    assert(
      typeof r.body === 'object' && (r.body.error || '').toLowerCase().includes('nan'),
      'response error mentions NaN/invalid integer'
    );
  }

  // ── POST /api/agent/poll with undefined ─────────────────────────────────
  {
    const r = await post('/api/agent/poll', { connection_id: undefined });
    assert(r.status === 400, 'POST /api/agent/poll + undefined → 400');
  }

  // ── POST /api/agent/poll with null ──────────────────────────────────────
  {
    const r = await post('/api/agent/poll', { connection_id: null });
    assert(r.status === 400, 'POST /api/agent/poll + null → 400');
  }

  // ── POST /api/agent/poll with empty string ───────────────────────────────
  {
    const r = await post('/api/agent/poll', { connection_id: '' });
    assert(r.status === 400, 'POST /api/agent/poll + empty string → 400');
  }

  // ── POST /api/agent/poll with float (1.5) ───────────────────────────────
  {
    const r = await post('/api/agent/poll', { connection_id: '1.5' });
    assert(r.status === 400, 'POST /api/agent/poll + "1.5" (float) → 400');
  }

  // ── POST /api/agent/respond with NaN ────────────────────────────────────
  {
    const r = await post('/api/agent/respond', {
      connection_id: 'NaN',
      request_id: 'test-req-123',
      status_code: 200,
      body: {},
    });
    assert(r.status === 400, 'POST /api/agent/respond + NaN → 400');
  }

  // ── GET /api/agent/channel-status with NaN ──────────────────────────────
  {
    const r = await get('/api/agent/channel-status?connection_id=NaN');
    assert(r.status === 400, 'GET /api/agent/channel-status?connection_id=NaN → 400');
  }

  // ── GET /api/agent/heartbeat-check with NaN ────────────────────────────
  {
    const r = await get('/api/agent/heartbeat-check?connection_id=NaN');
    assert(r.status === 400, 'GET /api/agent/heartbeat-check?connection_id=NaN → 400');
  }

  // ── Sanity: valid integer still gets auth challenge, not 400 ───────────
  {
    const r = await post('/api/agent/poll', { connection_id: '9999999' });
    // 401 = auth error (key invalid), NOT 400 (validation error)
    assert(
      r.status === 401,
      'POST /api/agent/poll + valid-looking int "9999999" → 401 (auth, not 400)'
    );
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.log('exit code:', failed > 0 ? 1 : 0);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});