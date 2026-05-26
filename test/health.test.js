/**
 * test/health.test.js — smoke tests for GET /api/health
 *
 * Run: node test/health.test.js
 * No external test runner required — exits 0 on pass, 1 on fail.
 */

'use strict';

const http = require('http');

// Minimal assert helper
function assert(cond, msg) {
  if (!cond) {
    console.error('  FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('  PASS:', msg);
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  const PORT = process.env.PORT || 3000;
  const url = `http://localhost:${PORT}/api/health`;

  console.log(`\nGET ${url}\n`);

  let res;
  try {
    res = await get(url);
  } catch (err) {
    console.error('Could not connect to server:', err.message);
    console.error('Start the server first: node server.js');
    process.exit(1);
  }

  // Status code
  assert([200, 503].includes(res.status), `status is 200 or 503 (got ${res.status})`);

  // Headers
  assert(res.headers['content-type']?.includes('application/json'), 'Content-Type is application/json');
  assert(res.headers['cache-control'] === 'no-store', 'Cache-Control is no-store');
  assert(res.headers['access-control-allow-origin'] === '*', 'CORS header is *');

  const b = res.body;
  assert(typeof b === 'object' && b !== null, 'body is JSON object');
  assert(typeof b.status === 'string' && ['ok', 'degraded'].includes(b.status), `status field is ok|degraded (got ${b.status})`);
  assert(typeof b.version === 'string', `version is string (got ${typeof b.version})`);
  assert(typeof b.uptime_seconds === 'number', `uptime_seconds is number (got ${typeof b.uptime_seconds})`);
  assert(typeof b.timestamp === 'string' && b.timestamp.endsWith('Z'), `timestamp is ISO8601 UTC (got ${b.timestamp})`);
  assert(typeof b.db === 'object', 'db field is object');
  assert(typeof b.db.connected === 'boolean', `db.connected is boolean (got ${typeof b.db.connected})`);
  assert(typeof b.db.latency_ms === 'number', `db.latency_ms is number (got ${typeof b.db.latency_ms})`);
  assert(typeof b.queue === 'object', 'queue field is object');
  assert(typeof b.queue.pending_commands === 'number', `queue.pending_commands is number (got ${typeof b.queue.pending_commands})`);
  assert(typeof b.queue.agents_online === 'number', `queue.agents_online is number (got ${typeof b.queue.agents_online})`);
  assert(typeof b.region === 'string', `region is string (got ${typeof b.region})`);

  console.log('\nDone. exit code:', process.exitCode || 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
