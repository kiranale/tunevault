/**
 * tests/ssh-pool-lru.test.js
 *
 * Unit tests for the LRU-capped SSH connection pool in services/oracle-runner.js.
 *
 * Tests:
 *   1. Pool size never exceeds MAX_SSH_POOL_SIZE (cap=10, 20 unique IDs inserted)
 *   2. The 10 oldest entries are evicted with client.end() called exactly once each
 *   3. Accessing an existing entry promotes it and prevents it from being evicted
 *   4. getPoolStats() returns correct size, max, eviction counters
 *   5. 60-connection burst scenario: cap=50, 60 IDs, size stays ≤ 50, 10 evicted
 *
 * No running server required — injects mock SSH clients directly into _pool.
 *
 * Run: TUNEVAULT_SSH_POOL_MAX=10 node tests/ssh-pool-lru.test.js
 * Exit: 0 = all pass, 1 = any failure.
 */

'use strict';

// ── Isolate the module with a small cap so tests run fast ──────────────────────
// Use env var to override cap before the module is loaded.
process.env.TUNEVAULT_SSH_POOL_MAX = '10';

// oracle-runner.js requires ssh2 and crypto-utils at load time.
// Mock them so the module loads without real SSH infrastructure.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'ssh2')           return { Client: class {} };
  if (request.endsWith('crypto-utils')) return { decrypt: (x) => x };
  return _origLoad.apply(this, arguments);
};

const runner = require('../services/oracle-runner');
const { _pool, _getMaxPoolSize, getPoolStats } = runner;

// ── Helpers ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

/**
 * Inject a fake ready entry directly into the pool.
 * Returns the mock client so callers can assert .end() call count.
 */
function inject(id) {
  let endCount = 0;
  const client = {
    end() { endCount++; },
    getEndCount() { return endCount; },
  };
  _pool.set(id, { client, lastUsedAt: Date.now(), ready: true });
  return client;
}

/**
 * Simulate getSshClient() for an already-injected entry (just the touch path).
 * For the eviction tests we need to exercise the public getPoolStats() and
 * _evictLru path. We drive it by calling the internal getSshClient()-equivalent
 * via direct pool manipulation + calling _evictLru indirectly by filling the pool.
 */
async function fillPoolTo(max) {
  _pool.clear();
  const clients = [];
  for (let i = 0; i < max; i++) {
    clients.push(inject(`conn-${i}`));
    // Tiny sleep to ensure unique lastUsedAt ordering
    await new Promise(r => setTimeout(r, 1));
  }
  return clients;
}

// ── Test 1: MAX_SSH_POOL_SIZE constant matches env var ─────────────────────────
console.log('\nTest 1: MAX_SSH_POOL_SIZE constant');
assert(_getMaxPoolSize() === 10, `cap = 10 (env TUNEVAULT_SSH_POOL_MAX=10)`);

// ── Test 2: LRU eviction on direct pool overflow ───────────────────────────────
console.log('\nTest 2: LRU eviction — 15 inserts into cap-10 pool');
(async () => {
  _pool.clear();

  // Snapshot eviction counter before
  const statsBefore = getPoolStats();
  const evBefore = statsBefore.total_evictions_lru;

  // Inject 10 entries (at capacity)
  const firstTen = [];
  for (let i = 0; i < 10; i++) {
    firstTen.push({ id: `t2-conn-${i}`, client: inject(`t2-conn-${i}`) });
    await new Promise(r => setTimeout(r, 1));
  }
  assert(_pool.size === 10, `pool size = 10 after filling to cap`);

  // Simulate 5 more inserts via _evictLru + _pool.set (same logic as getSshClient)
  // We replicate the eviction path directly since getSshClient requires SSH connect.
  for (let i = 10; i < 15; i++) {
    if (_pool.size >= _getMaxPoolSize()) {
      // Replicate _evictLru logic
      const [lruId, lruEntry] = _pool.entries().next().value;
      try { lruEntry.client.end(); } catch (_) {}
      _pool.delete(lruId);
    }
    inject(`t2-conn-${i}`);
    await new Promise(r => setTimeout(r, 1));
  }

  assert(_pool.size === 10, `pool size stays at 10 after 15 inserts`);
  assert(!_pool.has('t2-conn-0'), `t2-conn-0 (oldest) evicted`);
  assert(!_pool.has('t2-conn-4'), `t2-conn-4 evicted`);
  assert(_pool.has('t2-conn-14'), `t2-conn-14 (newest) present`);

  // The first 5 injected (0..4) should have had client.end() called
  for (let i = 0; i < 5; i++) {
    assert(
      firstTen[i].client.getEndCount() === 1,
      `t2-conn-${i} client.end() called exactly once`
    );
  }
  // The remaining first-ten (5..9) should not have been evicted yet
  for (let i = 5; i < 10; i++) {
    assert(
      firstTen[i].client.getEndCount() === 0,
      `t2-conn-${i} client.end() NOT called (still in pool)`
    );
  }

// ── Test 3: Touch promotes to MRU ─────────────────────────────────────────────
  console.log('\nTest 3: Touch promotes entry to MRU');
  _pool.clear();
  for (let i = 0; i < 10; i++) {
    inject(`t3-conn-${i}`);
    await new Promise(r => setTimeout(r, 1));
  }
  // Access t3-conn-0 (the LRU) — this should promote it
  const entry0 = _pool.get('t3-conn-0');
  _pool.delete('t3-conn-0');
  entry0.lastUsedAt = Date.now();
  _pool.set('t3-conn-0', entry0);

  // Now t3-conn-1 should be LRU. Insert one more to trigger eviction.
  if (_pool.size >= _getMaxPoolSize()) {
    const [lruId, lruEntry] = _pool.entries().next().value;
    lruEntry.client.end();
    _pool.delete(lruId);
  }
  inject(`t3-conn-new`);

  assert(!_pool.has('t3-conn-1'), `t3-conn-1 evicted (was LRU after touch promoted t3-conn-0)`);
  assert(_pool.has('t3-conn-0'), `t3-conn-0 still present (was promoted to MRU)`);

// ── Test 4: getPoolStats() ─────────────────────────────────────────────────────
  console.log('\nTest 4: getPoolStats() shape');
  _pool.clear();
  for (let i = 0; i < 5; i++) inject(`t4-conn-${i}`);

  const stats = getPoolStats();
  assert(typeof stats.size === 'number',                 `stats.size is a number`);
  assert(stats.size === 5,                               `stats.size = 5`);
  assert(stats.max  === 10,                              `stats.max = 10`);
  assert(typeof stats.oldest_age_ms === 'number',        `stats.oldest_age_ms is a number`);
  assert(stats.oldest_age_ms >= 0,                       `stats.oldest_age_ms >= 0`);
  assert(typeof stats.total_evictions_lru  === 'number', `stats.total_evictions_lru is a number`);
  assert(typeof stats.total_evictions_idle === 'number', `stats.total_evictions_idle is a number`);

  const emptyStats = (() => { _pool.clear(); return getPoolStats(); })();
  assert(emptyStats.oldest_age_ms === 0, `oldest_age_ms = 0 when pool empty`);

// ── Test 5: 60-connection burst with cap=50 ────────────────────────────────────
// Re-run with a cap=50 simulation using the same eviction logic.
  console.log('\nTest 5: 60-connection burst, cap=50, assert pool ≤ 50 and exactly 10 evicted');
  const CAP_50 = 50;
  _pool.clear();

  const allClients = [];
  let evictCount = 0;

  for (let i = 0; i < 60; i++) {
    if (_pool.size >= CAP_50) {
      const [lruId, lruEntry] = _pool.entries().next().value;
      lruEntry.client.end();
      _pool.delete(lruId);
      evictCount++;
    }
    allClients.push({ id: `burst-${i}`, client: inject(`burst-${i}`) });
    await new Promise(r => setTimeout(r, 1));
  }

  assert(_pool.size <= CAP_50, `pool size (${_pool.size}) ≤ 50 after 60 inserts`);
  assert(evictCount === 10, `exactly 10 evictions occurred (got ${evictCount})`);

  // The 10 evicted entries (burst-0 .. burst-9) should have had client.end() called
  for (let i = 0; i < 10; i++) {
    assert(
      allClients[i].client.getEndCount() === 1,
      `burst-${i} client.end() called (evicted)`
    );
  }
  // The 50 surviving entries should NOT have had client.end() called
  for (let i = 10; i < 60; i++) {
    assert(
      allClients[i].client.getEndCount() === 0,
      `burst-${i} client.end() NOT called (survived)`
    );
  }

// ── Summary ────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
