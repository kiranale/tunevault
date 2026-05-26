/**
 * tests/unit-adop-state.js — Unit tests for lib/ebs/adop-state.js
 *
 * Run with: node tests/unit-adop-state.js
 * No test framework required — uses Node.js built-in assert.
 *
 * Fixture: the operator's exact V$ACTIVE_SERVICES output that triggered the task.
 *   EBSDEV_ebs_patch (CON_ID=3)  — ADOP patch-mode service for EBSDEV PDB
 *   EBSDB_ebs_patch  (CON_ID=5)  — ADOP patch-mode service for EBSDB PDB
 *
 * Cases covered:
 *   1. Patching=true when _ebs_patch services active + AD_ADOP_SESSIONS accessible
 *   2. Patching=true, phase=unknown when AD_ADOP_SESSIONS unavailable (non-APPS connect)
 *   3. Patching=false when no _ebs_patch services
 *   4. Phase derivation: prepare < apply < finalize < cutover < cleanup < abort
 *   5. Banner message formatting
 *   6. Op-gating: bounce_cm blocked, read-only ops allowed
 *   7. V$ACTIVE_SERVICES query failure → not-patching fallback
 */

'use strict';

const assert  = require('assert');
const {
  detectAdopState,
  formatBannerMessage,
  isOpBlockedDuringAdop,
  SQL_ACTIVE_PATCH_SERVICES,
  SQL_ADOP_SESSION,
} = require('../lib/ebs/adop-state');

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  const run = fn();
  if (run && typeof run.then === 'function') {
    return run.then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    }).catch(err => {
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Operator's exact V$ACTIVE_SERVICES output (2 patch-mode services, both active)
const PATCH_SERVICES_ROWS = [
  { name: 'EBSDEV_ebs_patch', NETWORK_NAME: 'EBSDEV_ebs_patch' },
  { name: 'EBSDB_ebs_patch',  NETWORK_NAME: 'EBSDB_ebs_patch' },
];

// V$ACTIVE_SERVICES with no patch-mode services
const NO_PATCH_SERVICES_ROWS = [
  { name: 'ebs_EBSDEV',  NETWORK_NAME: 'ebs_EBSDEV' },
  { name: 'EBSDEVDB',    NETWORK_NAME: 'EBSDEVDB' },
];

// AD_ADOP_SESSIONS row: APPLY phase started 2h ago
const ADOP_SESSION_APPLY = {
  adop_session_id: 1051,
  ADOP_SESSION_ID: 1051,
  status: 'R',
  prepare_date: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
  PREPARE_DATE:  new Date(Date.now() - 3 * 60 * 60 * 1000),
  apply_date:    new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
  APPLY_DATE:    new Date(Date.now() - 2 * 60 * 60 * 1000),
  finalize_date: null, FINALIZE_DATE: null,
  cutover_date:  null, CUTOVER_DATE:  null,
  cleanup_date:  null, CLEANUP_DATE:  null,
  abandon_date:  null, ABANDON_DATE:  null,
};

// AD_ADOP_SESSIONS row: CUTOVER phase
const ADOP_SESSION_CUTOVER = {
  adop_session_id: 1051, ADOP_SESSION_ID: 1051, status: 'R',
  prepare_date:  new Date(), PREPARE_DATE:  new Date(),
  apply_date:    new Date(), APPLY_DATE:    new Date(),
  finalize_date: new Date(), FINALIZE_DATE: new Date(),
  cutover_date:  new Date(), CUTOVER_DATE:  new Date(),
  cleanup_date:  null, CLEANUP_DATE: null,
  abandon_date:  null, ABANDON_DATE: null,
};

// Helper: build queryFn from pre-programmed responses
function mockQueryFn(responses) {
  let callIndex = 0;
  return async (sql) => {
    const key = callIndex++;
    if (responses[key] && responses[key].error) throw new Error(responses[key].error);
    return { rows: (responses[key] || { rows: [] }).rows };
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

const tests = [];

tests.push(test('patching=true with exact operator fixture (EBSDEV_ebs_patch + EBSDB_ebs_patch)', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },         // V$ACTIVE_SERVICES
    { rows: [ADOP_SESSION_APPLY] },        // AD_ADOP_SESSIONS
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.patching, true, 'patching should be true');
  assert.deepStrictEqual(
    state.services_in_patch_mode.sort(),
    ['EBSDB_ebs_patch', 'EBSDEV_ebs_patch'],
    'services_in_patch_mode should match fixture'
  );
  assert.strictEqual(state.source, 'vactive_services+adop_sessions');
  assert.strictEqual(state.session_id, 1051);
}));

tests.push(test('phase=apply derived from ADOP_SESSION_APPLY fixture', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },
    { rows: [ADOP_SESSION_APPLY] },
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.phase, 'apply', `Expected phase=apply, got ${state.phase}`);
}));

tests.push(test('phase=cutover derived from ADOP_SESSION_CUTOVER fixture', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },
    { rows: [ADOP_SESSION_CUTOVER] },
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.phase, 'cutover', `Expected phase=cutover, got ${state.phase}`);
}));

tests.push(test('patching=true with phase=null when AD_ADOP_SESSIONS throws (non-APPS connect)', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },         // V$ACTIVE_SERVICES — ok
    { error: 'ORA-00942: table or view does not exist' }, // AD_ADOP_SESSIONS — no APPS access
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.patching, true, 'patching should be true (service-based detection)');
  assert.strictEqual(state.phase, null, 'phase should be null when ADOP views not accessible');
  assert.strictEqual(state.source, 'vactive_services_only');
  assert.ok(state.services_in_patch_mode.length > 0, 'services should still be listed');
}));

tests.push(test('patching=false when no _ebs_patch services', async () => {
  // The SQL WHERE clause filters for %_ebs_patch — so if no patch services exist,
  // V$ACTIVE_SERVICES returns zero rows matching that filter.
  const queryFn = mockQueryFn([
    { rows: [] },      // V$ACTIVE_SERVICES returns 0 rows (SQL filters out non-patch services)
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.patching, false);
  assert.strictEqual(state.phase, null);
  assert.deepStrictEqual(state.services_in_patch_mode, []);
}));

tests.push(test('patching=false when V$ACTIVE_SERVICES returns empty', async () => {
  const queryFn = mockQueryFn([{ rows: [] }]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.patching, false);
}));

tests.push(test('returns not-patching fallback when V$ACTIVE_SERVICES query throws', async () => {
  const queryFn = mockQueryFn([
    { error: 'ORA-01031: insufficient privileges' },
  ]);
  const state = await detectAdopState(queryFn);
  assert.strictEqual(state.patching, false, 'should be false when V$ACTIVE_SERVICES is inaccessible');
  assert.ok(state.source.includes('error'), 'source should indicate error');
}));

tests.push(test('banner message contains phase when phase is known', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },
    { rows: [ADOP_SESSION_APPLY] },
  ]);
  const state = await detectAdopState(queryFn);
  const msg = formatBannerMessage(state);
  assert.ok(msg.includes('APPLY') || msg.includes('apply'), `Banner should mention phase: "${msg}"`);
  assert.ok(msg.includes('ADOP'), `Banner should say ADOP: "${msg}"`);
}));

tests.push(test('banner message is empty string when not patching', () => {
  const state = { patching: false, phase: null, started_at: null, session_id: null, services_in_patch_mode: [] };
  const msg = formatBannerMessage(state);
  assert.strictEqual(msg, '');
}));

tests.push(test('bounce_cm is blocked during ADOP', () => {
  assert.strictEqual(isOpBlockedDuringAdop('bounce_cm'), true);
  assert.strictEqual(isOpBlockedDuringAdop('BOUNCE_CM'), true);
  assert.strictEqual(isOpBlockedDuringAdop('cm_bounce'), true);
}));

tests.push(test('restart_wf_mailer is blocked during ADOP', () => {
  assert.strictEqual(isOpBlockedDuringAdop('restart_wf_mailer'), true);
}));

tests.push(test('kill_session is blocked during ADOP', () => {
  assert.strictEqual(isOpBlockedDuringAdop('kill_session'), true);
  assert.strictEqual(isOpBlockedDuringAdop('kill_blocking_session'), true);
}));

tests.push(test('rolling_bounce is blocked during ADOP', () => {
  assert.strictEqual(isOpBlockedDuringAdop('rolling_bounce'), true);
}));

tests.push(test('read-only ops are NOT blocked', () => {
  assert.strictEqual(isOpBlockedDuringAdop('get_tablespace_usage'), false);
  assert.strictEqual(isOpBlockedDuringAdop('list_sessions'), false);
  assert.strictEqual(isOpBlockedDuringAdop('view_wait_events'), false);
  assert.strictEqual(isOpBlockedDuringAdop(null), false);
  assert.strictEqual(isOpBlockedDuringAdop(''), false);
}));

tests.push(test('SQL_ACTIVE_PATCH_SERVICES queries V$ACTIVE_SERVICES for _ebs_patch suffix', () => {
  assert.ok(SQL_ACTIVE_PATCH_SERVICES.includes('V$ACTIVE_SERVICES'), 'should query V$ACTIVE_SERVICES');
  assert.ok(SQL_ACTIVE_PATCH_SERVICES.includes('_ebs_patch'), 'should filter on _ebs_patch suffix');
}));

tests.push(test('SQL_ADOP_SESSION queries AD_ADOP_SESSIONS for active sessions', () => {
  assert.ok(SQL_ADOP_SESSION.includes('AD_ADOP_SESSIONS'), 'should query AD_ADOP_SESSIONS');
}));

tests.push(test('started_at populated from prepare_date when ADOP sessions accessible', async () => {
  const queryFn = mockQueryFn([
    { rows: PATCH_SERVICES_ROWS },
    { rows: [ADOP_SESSION_APPLY] },
  ]);
  const state = await detectAdopState(queryFn);
  assert.ok(state.started_at !== null, 'started_at should be set');
}));

tests.push(test('checked_at is always a Date', async () => {
  const queryFn = mockQueryFn([{ rows: [] }]);
  const state = await detectAdopState(queryFn);
  assert.ok(state.checked_at instanceof Date, 'checked_at should be a Date');
}));

// Run all tests
console.log('\nadop-state detector — EBSDEV fixture\n');
Promise.all(tests).then(() => {
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
