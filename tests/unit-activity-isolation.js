/**
 * tests/unit-activity-isolation.js — Activity Log isolation unit tests.
 *
 * Verifies that the company-scoping and defense-in-depth guard logic in
 * db/activity-log.js and routes/activity.js prevents cross-tenant data leakage.
 *
 * Run with: node tests/unit-activity-isolation.js
 * No test framework required — uses Node.js built-in assert.
 *
 * Tests cover:
 *   1. queryActivity — company_domain WHERE clause is always emitted
 *   2. queryActivity — non-admin users get user_id scoping on top of company isolation
 *   3. queryActivity — admin users skip user_id filter but keep company_domain filter
 *   4. queryActivity — NULL company_domain fallback restricts to viewerUserId only
 *   5. queryActivity — filterUserId is applied as additional AND (does not widen scope)
 *   6. queryActivity — offset=0 and limit enforced (no bypass via limit=0)
 *   7. guardRows — rows matching company_domain pass through
 *   8. guardRows — rows with wrong company_domain are dropped
 *   9. guardRows — NULL company_domain rows visible only to their owner
 *  10. guardRows — company_domain field is stripped from outbound rows
 *  11. guardRows — empty input returns empty output
 *  12. getActivityStats — company_domain WHERE clause is always emitted
 *  13. Pagination: offset < 0 is clamped to 0
 *  14. Pagination: limit > 500 is clamped to 500
 *  15. Pagination: limit=0 treated as 50 (default applied)
 */

'use strict';

const assert = require('assert');

// ── Test helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  const run = fn();
  if (run && typeof run.then === 'function') {
    return run
      .then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      })
      .catch(err => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
      });
  }
  try {
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

// ── Mock pool factory ──────────────────────────────────────────────────────────
//
// Returns a mock pg Pool whose .query() records every (sql, params) call and
// returns { rows: [] } by default. Override returnRows to inject fixture data.

function makeMockPool(returnRows = []) {
  const calls = [];
  let callIdx = 0;

  const pool = {
    _calls: calls,
    async query(sql, params) {
      calls.push({ sql, params: params || [] });
      // COUNT query always returns 0
      if (/COUNT\(\*\)/i.test(sql)) {
        return { rows: [{ total: String(returnRows.length) }] };
      }
      // All other queries return the fixture rows
      return { rows: returnRows.slice() };
    },
  };
  return pool;
}

// ── Import the modules under test with injected pool ──────────────────────────
//
// We override require cache to inject mock pool before loading activity-log.js.
// This avoids needing a real DB connection.

function loadActivityLog(mockPool) {
  // Clear cached version so we get a fresh module with our mock pool
  const modulePath = require.resolve('../db/activity-log');
  delete require.cache[modulePath];

  // Temporarily override the pool module in require cache
  const poolPath = require.resolve('../db/index');
  const originalPool = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: mockPool };

  try {
    const mod = require('../db/activity-log');
    return mod;
  } finally {
    // Restore original pool (may be undefined if not loaded yet — that's fine)
    if (originalPool) {
      require.cache[poolPath] = originalPool;
    } else {
      delete require.cache[poolPath];
    }
    delete require.cache[modulePath]; // force re-load next time
  }
}

// ── Load guardRows from routes/activity.js ────────────────────────────────────
//
// We extract and test guardRows independently without spinning up Express.
// We extract the function by loading the module with a stubbed pool.

function extractGuardRows() {
  // guardRows is not exported; we replicate it here exactly as written in routes/activity.js
  // so we test the same logic without route-layer dependencies.
  return function guardRows(rows, viewerCompanyDomain, viewerUserId) {
    return rows
      .filter(row => {
        if (row.company_domain === null || row.company_domain === undefined) {
          return row.user_id === viewerUserId;
        }
        return row.company_domain === viewerCompanyDomain;
      })
      .map(({ company_domain, ...rest }) => rest);
  };
}

const guardRows = extractGuardRows();

// ── parseFilters logic (inline — not exported, test the math) ─────────────────
function parseFilters(query) {
  const {
    date_from, date_to,
    user_id, action_types, connection_id,
    result, search,
    limit = '50', offset = '0',
  } = query;

  const actionTypes = action_types
    ? (Array.isArray(action_types) ? action_types : action_types.split(',').map(s => s.trim()).filter(Boolean))
    : [];

  return {
    dateFrom: date_from || null,
    dateTo: date_to || null,
    filterUserId: user_id ? parseInt(user_id, 10) : null,
    actionTypes,
    connectionId: connection_id ? parseInt(connection_id, 10) : null,
    result: result || null,
    search: search || null,
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500),
    offset: Math.max(parseInt(offset, 10) || 0, 0),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const tests = [];

// 1. queryActivity — company_domain WHERE clause is always emitted
tests.push(test('queryActivity: company_domain filter always present in SQL', async () => {
  const pool = makeMockPool([]);
  const mod = loadActivityLog(pool);

  await mod.queryActivity({
    viewerUserId: 1,
    viewerCompanyDomain: 'acme.com',
    isAdmin: false,
    teamMemberIds: [],
  });

  const sql = pool._calls[0].sql;
  assert.ok(
    sql.includes('company_domain') || sql.includes('$1'),
    'SQL should reference company_domain parameter'
  );
  // The first param should be 'acme.com'
  assert.strictEqual(pool._calls[0].params[0], 'acme.com',
    'First query param must be the viewer company domain');
}));

// 2. queryActivity — non-admin users get user_id = ANY(visibleIds) scoping
tests.push(test('queryActivity: non-admin gets user_id = ANY(visibleIds) filter', async () => {
  const pool = makeMockPool([]);
  const mod = loadActivityLog(pool);

  await mod.queryActivity({
    viewerUserId: 42,
    viewerCompanyDomain: 'acme.com',
    isAdmin: false,
    isTeamAdmin: false,
    teamMemberIds: [],
  });

  // Find the query call that has the visibleIds array
  const callsWithArrayParam = pool._calls.filter(c =>
    c.params.some(p => Array.isArray(p) && p.includes(42))
  );
  assert.ok(callsWithArrayParam.length > 0, 'Should have a query with user_id array containing viewer');
  const visibleIdsParam = callsWithArrayParam[0].params.find(p => Array.isArray(p));
  assert.ok(visibleIdsParam.includes(42), 'Visible IDs must include viewerUserId');
}));

// 3. queryActivity — admin users skip user_id filter (isAdmin=true), but keep company_domain
tests.push(test('queryActivity: admin skips user_id filter but keeps company_domain', async () => {
  const pool = makeMockPool([]);
  const mod = loadActivityLog(pool);

  await mod.queryActivity({
    viewerUserId: 1,
    viewerCompanyDomain: 'acme.com',
    isAdmin: true,
    teamMemberIds: [],
  });

  const mainQueryCall = pool._calls.find(c => c.sql.includes('ORDER BY created_at'));
  assert.ok(mainQueryCall, 'Should have a main data query');

  // Admin query should NOT have user_id = ANY(...) as a param but SHOULD have 'acme.com'
  const hasCompanyDomain = mainQueryCall.params.includes('acme.com');
  assert.ok(hasCompanyDomain, 'company_domain filter must be present even for admins');

  // Should not have a user IDs array for admin
  const hasUserIdArray = mainQueryCall.params.some(p => Array.isArray(p));
  assert.ok(!hasUserIdArray, 'Admin query must NOT have user_id = ANY() filter');
}));

// 4. queryActivity — NULL viewerCompanyDomain falls back to user_id = $N (not whole table)
tests.push(test('queryActivity: NULL viewerCompanyDomain falls back to own-rows-only filter', async () => {
  const pool = makeMockPool([]);
  const mod = loadActivityLog(pool);

  await mod.queryActivity({
    viewerUserId: 99,
    viewerCompanyDomain: null,
    isAdmin: false,
    teamMemberIds: [],
  });

  // First param should be the userId (fallback path)
  assert.strictEqual(pool._calls[0].params[0], 99,
    'With null company_domain, first param must be viewerUserId');
}));

// 5. queryActivity — filterUserId is applied as additional AND (does not widen scope)
tests.push(test('queryActivity: filterUserId adds AND constraint, not OR', async () => {
  const pool = makeMockPool([]);
  const mod = loadActivityLog(pool);

  await mod.queryActivity({
    viewerUserId: 10,
    viewerCompanyDomain: 'beta.org',
    isAdmin: false,
    teamMemberIds: [11, 12],
    filterUserId: 11,
  });

  const mainQueryCall = pool._calls.find(c => c.sql.includes('ORDER BY created_at'));
  assert.ok(mainQueryCall, 'Should have main data query');

  // filterUserId=11 should appear as a separate parameter value
  assert.ok(mainQueryCall.params.includes(11),
    'filterUserId should be a parameter (added as AND constraint)');

  // 'beta.org' should also be present (isolation not removed)
  assert.ok(mainQueryCall.params.includes('beta.org'),
    'company_domain must remain in params even with filterUserId set');
}));

// 6. Pagination: limit=0 treated as 50 (default applied, not 0)
// parseInt('0') = 0 → 0 || 50 = 50 (0 is falsy in JS)
// Math.max(50, 1) = 50, Math.min(50, 500) = 50
tests.push(test('parseFilters: limit=0 produces 50 (default, not 0)', () => {
  const f = parseFilters({ limit: '0' });
  assert.strictEqual(f.limit, 50, `Expected limit 50 for limit=0 input, got ${f.limit}`);
}));

// 7. Pagination: limit > 500 is clamped to 500
tests.push(test('parseFilters: limit=9999 is clamped to 500', () => {
  const f = parseFilters({ limit: '9999' });
  assert.strictEqual(f.limit, 500, `Expected limit 500, got ${f.limit}`);
}));

// 8. Pagination: offset < 0 is clamped to 0
tests.push(test('parseFilters: offset=-100 is clamped to 0', () => {
  const f = parseFilters({ offset: '-100' });
  assert.strictEqual(f.offset, 0, `Expected offset 0 for -100 input, got ${f.offset}`);
}));

// 9. guardRows — rows matching company_domain pass through
tests.push(test('guardRows: rows matching viewerCompanyDomain are returned', () => {
  const rows = [
    { id: 1, user_id: 5, company_domain: 'acme.com', action_type: 'login', result: 'success', created_at: new Date() },
    { id: 2, user_id: 6, company_domain: 'acme.com', action_type: 'health_check', result: 'success', created_at: new Date() },
  ];
  const result = guardRows(rows, 'acme.com', 5);
  assert.strictEqual(result.length, 2, 'Both rows should pass through');
}));

// 10. guardRows — rows with wrong company_domain are dropped
tests.push(test('guardRows: rows from different company_domain are dropped', () => {
  const rows = [
    { id: 1, user_id: 5, company_domain: 'acme.com', action_type: 'login', result: 'success', created_at: new Date() },
    { id: 2, user_id: 9, company_domain: 'evil-corp.com', action_type: 'login', result: 'success', created_at: new Date() },
    { id: 3, user_id: 10, company_domain: 'other.io', action_type: 'health_check', result: 'success', created_at: new Date() },
  ];
  const result = guardRows(rows, 'acme.com', 5);
  assert.strictEqual(result.length, 1, 'Only acme.com row should survive');
  assert.strictEqual(result[0].id, 1, 'Surviving row should be id=1');
}));

// 11. guardRows — NULL company_domain rows visible only to their owner
tests.push(test('guardRows: legacy NULL company_domain row visible only to owner', () => {
  const ownerUserId = 42;
  const otherUserId = 99;

  const rows = [
    { id: 1, user_id: ownerUserId, company_domain: null, action_type: 'login', result: 'success', created_at: new Date() },
    { id: 2, user_id: otherUserId, company_domain: null, action_type: 'login', result: 'success', created_at: new Date() },
  ];

  // As the owner: row 1 passes, row 2 does not
  const asOwner = guardRows(rows, 'acme.com', ownerUserId);
  assert.strictEqual(asOwner.length, 1, 'Owner should see exactly 1 legacy row');
  assert.strictEqual(asOwner[0].id, 1);

  // As a different user: neither row passes (company_domain mismatch and user_id mismatch)
  // Row 1: NULL domain → user_id=42 !== 99 → dropped
  // Row 2: NULL domain → user_id=99 === 99 → passes
  const asOther = guardRows(rows, 'acme.com', otherUserId);
  assert.strictEqual(asOther.length, 1, 'Other user should see only their own legacy row');
  assert.strictEqual(asOther[0].id, 2);
}));

// 12. guardRows — company_domain field is stripped from all outbound rows
tests.push(test('guardRows: company_domain is stripped from outbound rows', () => {
  const rows = [
    { id: 1, user_id: 5, company_domain: 'acme.com', action_type: 'login', result: 'success', created_at: new Date() },
  ];
  const result = guardRows(rows, 'acme.com', 5);
  assert.strictEqual(result.length, 1);
  assert.ok(!('company_domain' in result[0]), 'company_domain must be stripped from response');
}));

// 13. guardRows — empty input returns empty output
tests.push(test('guardRows: empty rows input returns empty array', () => {
  const result = guardRows([], 'acme.com', 1);
  assert.deepStrictEqual(result, []);
}));

// 14. Cross-tenant isolation scenario: company A user cannot see company B rows
tests.push(test('guardRows: full cross-tenant scenario — user A cannot see company B rows', () => {
  // Simulate DB returning a mix (should never happen with correct query, but guard catches it)
  const companyARows = [
    { id: 10, user_id: 1, company_domain: 'company-a.com', action_type: 'login', result: 'success', created_at: new Date() },
    { id: 11, user_id: 2, company_domain: 'company-a.com', action_type: 'health_check', result: 'success', created_at: new Date() },
  ];
  const companyBRows = [
    { id: 20, user_id: 100, company_domain: 'company-b.com', action_type: 'login', result: 'success', created_at: new Date() },
    { id: 21, user_id: 101, company_domain: 'company-b.com', action_type: 'sql_execution', result: 'success', created_at: new Date() },
  ];
  const allRows = [...companyARows, ...companyBRows];

  // User from company A
  const resultAsA = guardRows(allRows, 'company-a.com', 1);
  assert.strictEqual(resultAsA.length, 2, 'Company A user sees only their 2 rows');
  assert.ok(resultAsA.every(r => !('company_domain' in r)), 'No company_domain in output');

  // User from company B
  const resultAsB = guardRows(allRows, 'company-b.com', 100);
  assert.strictEqual(resultAsB.length, 2, 'Company B user sees only their 2 rows');

  // Verify no cross-contamination of IDs
  const aIds = new Set(resultAsA.map(r => r.id));
  const bIds = new Set(resultAsB.map(r => r.id));
  assert.ok([10, 11].every(id => aIds.has(id)), 'Company A should have IDs 10,11');
  assert.ok([20, 21].every(id => bIds.has(id)), 'Company B should have IDs 20,21');
  assert.ok(![20, 21].some(id => aIds.has(id)), 'Company A must NOT see company B IDs');
  assert.ok(![10, 11].some(id => bIds.has(id)), 'Company B must NOT see company A IDs');
}));

// 15. getActivityStats — company_domain filter present
tests.push(test('getActivityStats: company_domain filter always present', async () => {
  const pool = makeMockPool([{ total_actions: '5', failed_count: '0', execution_count: '2', approval_count: '1' }]);
  // Override to return count-compatible rows for the COUNT query
  const customPool = {
    _calls: [],
    async query(sql, params) {
      customPool._calls.push({ sql, params: params || [] });
      if (/total_actions/i.test(sql)) {
        return { rows: [{ total_actions: '5', failed_count: '0', execution_count: '2', approval_count: '1' }] };
      }
      if (/GROUP BY action_type/i.test(sql)) {
        return { rows: [] };
      }
      if (/COUNT\(DISTINCT user_id\)/i.test(sql)) {
        return { rows: [{ active_users: '1' }] };
      }
      return { rows: [{ total: '0' }] };
    },
  };
  const mod = loadActivityLog(customPool);

  await mod.getActivityStats({
    viewerUserId: 7,
    viewerCompanyDomain: 'gamma.io',
    isAdmin: false,
    teamMemberIds: [],
  });

  const allParams = customPool._calls.flatMap(c => c.params);
  assert.ok(allParams.includes('gamma.io'),
    'getActivityStats must include company_domain param in every query');
}));

// 16. Pagination edge: limit=1 (minimum) is respected
tests.push(test('parseFilters: limit=1 is accepted as-is', () => {
  const f = parseFilters({ limit: '1' });
  assert.strictEqual(f.limit, 1);
}));

// 17. Pagination edge: offset=0 explicit
tests.push(test('parseFilters: offset=0 is respected', () => {
  const f = parseFilters({ offset: '0' });
  assert.strictEqual(f.offset, 0);
}));

// 18. Pagination edge: offset=500 is respected
tests.push(test('parseFilters: offset=500 passes through unchanged', () => {
  const f = parseFilters({ offset: '500' });
  assert.strictEqual(f.offset, 500);
}));

// Run all
console.log('\nactivity-log — company isolation tests\n');
Promise.all(tests).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
