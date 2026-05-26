/**
 * tests/unit-service-classifier.js — Unit tests for lib/oracle/service-classifier.js
 *
 * Run with: node tests/unit-service-classifier.js
 * No test framework required — uses Node.js built-in assert.
 *
 * Topology under test: EBSDEV CDB with 9 services as surfaced by the operator's V$SERVICES query.
 *
 * Services in EBSDEV topology:
 *   EBSDEVDB      CON_ID=1  — CDB root instance SID (dedicated server)
 *   EBSCDBXDB     CON_ID=1  — CDB XDB endpoint
 *   ebsdev        CON_ID=3  — PDB default service (short name of EBSDEV PDB)
 *   ebs_EBSDEV    CON_ID=3  — EBS default service (ebs_ prefix + READ WRITE PDB) ← target
 *   ebs_EBSDB     CON_ID=5  — EBS default service on a second PDB (EBSDB)
 *   EBSDEV_ebs_patch CON_ID=3 — ADOP patch-mode service for EBSDEV (BLOCKED)
 *   EBSDB_ebs_patch  CON_ID=5 — ADOP patch-mode service for EBSDB (BLOCKED)
 *   SYS$BACKGROUND   CON_ID=1 — Oracle internal (BACKGROUND)
 *   SYS$USERS        CON_ID=1 — Oracle internal (BACKGROUND)
 */

'use strict';

const assert = require('assert');
const { classifyServices, CLASSIFICATIONS } = require('../lib/oracle/service-classifier');

// ── Test helper ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── EBSDEV fixture ────────────────────────────────────────────────────────────

const SERVICES = [
  { con_id: 1, name: 'EBSDEVDB',          network_name: 'EBSDEVDB' },
  { con_id: 1, name: 'EBSCDBXDB',         network_name: 'EBSCDBXDB' },
  { con_id: 3, name: 'ebsdev',            network_name: 'ebsdev' },
  { con_id: 3, name: 'ebs_EBSDEV',        network_name: 'ebs_EBSDEV' },
  { con_id: 5, name: 'ebs_EBSDB',         network_name: 'ebs_EBSDB' },
  { con_id: 3, name: 'EBSDEV_ebs_patch',  network_name: 'EBSDEV_ebs_patch' },
  { con_id: 5, name: 'EBSDB_ebs_patch',   network_name: 'EBSDB_ebs_patch' },
  { con_id: 1, name: 'SYS$BACKGROUND',    network_name: 'SYS$BACKGROUND' },
  { con_id: 1, name: 'SYS$USERS',         network_name: 'SYS$USERS' },
];

const PDBS = [
  { con_id: 3, name: 'EBSDEV', open_mode: 'READ WRITE' },
  { con_id: 5, name: 'EBSDB',  open_mode: 'READ WRITE' },
];

// ── Test suite ────────────────────────────────────────────────────────────────

console.log('\nservice-classifier — EBSDEV topology\n');

test('classifies CDB root SID as CDB_ROOT and blocked', () => {
  const result = classifyServices(SERVICES, PDBS);
  const ebsdevdb = result.find(s => s.name === 'EBSDEVDB');
  assert.ok(ebsdevdb, 'EBSDEVDB should be in results');
  assert.strictEqual(ebsdevdb.classification, CLASSIFICATIONS.CDB_ROOT);
  assert.strictEqual(ebsdevdb.blocked, true);
  assert.ok(ebsdevdb.reason && ebsdevdb.reason.length > 10, 'reason should explain why CDB is blocked');
});

test('classifies EBSCDBXDB as XDB', () => {
  const result = classifyServices(SERVICES, PDBS);
  const xdb = result.find(s => s.name === 'EBSCDBXDB');
  assert.ok(xdb, 'EBSCDBXDB should be in results');
  assert.strictEqual(xdb.classification, CLASSIFICATIONS.XDB);
  assert.strictEqual(xdb.blocked, false);  // XDB is not blocked, just not recommended
});

test('classifies ebs_EBSDEV as EBS_DEFAULT (recommended)', () => {
  const result = classifyServices(SERVICES, PDBS);
  const ebsSvc = result.find(s => s.name === 'ebs_EBSDEV');
  assert.ok(ebsSvc, 'ebs_EBSDEV should be in results');
  assert.strictEqual(ebsSvc.classification, CLASSIFICATIONS.EBS_DEFAULT);
  assert.strictEqual(ebsSvc.blocked, false);
});

test('classifies ebs_EBSDB as EBS_DEFAULT', () => {
  const result = classifyServices(SERVICES, PDBS);
  const ebsSvc = result.find(s => s.name === 'ebs_EBSDB');
  assert.ok(ebsSvc, 'ebs_EBSDB should be in results');
  assert.strictEqual(ebsSvc.classification, CLASSIFICATIONS.EBS_DEFAULT);
  assert.strictEqual(ebsSvc.blocked, false);
});

test('classifies ebsdev (short PDB name) as PDB_DEFAULT', () => {
  const result = classifyServices(SERVICES, PDBS);
  const pdbSvc = result.find(s => s.name === 'ebsdev');
  assert.ok(pdbSvc, 'ebsdev should be in results');
  assert.strictEqual(pdbSvc.classification, CLASSIFICATIONS.PDB_DEFAULT);
  assert.strictEqual(pdbSvc.blocked, false);
});

test('classifies EBSDEV_ebs_patch as EBS_PATCH_MODE and blocked', () => {
  const result = classifyServices(SERVICES, PDBS);
  const patch = result.find(s => s.name === 'EBSDEV_ebs_patch');
  assert.ok(patch, 'EBSDEV_ebs_patch should be in results');
  assert.strictEqual(patch.classification, CLASSIFICATIONS.EBS_PATCH_MODE);
  assert.strictEqual(patch.blocked, true);
  assert.ok(patch.reason && patch.reason.includes('ADOP'), 'reason should mention ADOP');
});

test('classifies EBSDB_ebs_patch as EBS_PATCH_MODE and blocked', () => {
  const result = classifyServices(SERVICES, PDBS);
  const patch = result.find(s => s.name === 'EBSDB_ebs_patch');
  assert.ok(patch, 'EBSDB_ebs_patch should be in results');
  assert.strictEqual(patch.classification, CLASSIFICATIONS.EBS_PATCH_MODE);
  assert.strictEqual(patch.blocked, true);
});

test('classifies SYS$BACKGROUND as BACKGROUND', () => {
  const result = classifyServices(SERVICES, PDBS);
  const bg = result.find(s => s.name === 'SYS$BACKGROUND');
  assert.ok(bg, 'SYS$BACKGROUND should be in results');
  assert.strictEqual(bg.classification, CLASSIFICATIONS.BACKGROUND);
  assert.strictEqual(bg.blocked, false);
});

test('recommends exactly one service', () => {
  const result = classifyServices(SERVICES, PDBS);
  const recommended = result.filter(s => s.recommended);
  assert.strictEqual(recommended.length, 1, `Expected 1 recommended service, got ${recommended.length}`);
});

test('recommended service is ebs_EBSDEV (highest-ranked EBS_DEFAULT)', () => {
  const result = classifyServices(SERVICES, PDBS);
  const recommended = result.find(s => s.recommended);
  assert.ok(recommended, 'should have a recommended service');
  assert.strictEqual(recommended.classification, CLASSIFICATIONS.EBS_DEFAULT,
    `Expected EBS_DEFAULT to be recommended, got ${recommended.classification}`);
  // ebs_EBSDEV comes before ebs_EBSDB alphabetically and by order in fixture
  assert.ok(
    recommended.name === 'ebs_EBSDEV' || recommended.name === 'ebs_EBSDB',
    `Expected an ebs_ service to be recommended, got ${recommended.name}`
  );
});

test('recommended service is not blocked', () => {
  const result = classifyServices(SERVICES, PDBS);
  const recommended = result.find(s => s.recommended);
  assert.ok(recommended, 'should have a recommended service');
  assert.strictEqual(recommended.blocked, false);
});

test('EBS_DEFAULT services appear before PDB_DEFAULT in sorted order', () => {
  const result = classifyServices(SERVICES, PDBS);
  const ebsIdx = result.findIndex(s => s.classification === CLASSIFICATIONS.EBS_DEFAULT);
  const pdbIdx = result.findIndex(s => s.classification === CLASSIFICATIONS.PDB_DEFAULT);
  assert.ok(ebsIdx >= 0, 'should have EBS_DEFAULT service');
  assert.ok(pdbIdx >= 0, 'should have PDB_DEFAULT service');
  assert.ok(ebsIdx < pdbIdx, `EBS_DEFAULT (index ${ebsIdx}) should come before PDB_DEFAULT (index ${pdbIdx})`);
});

test('PDB_DEFAULT appears before blocked services', () => {
  const result = classifyServices(SERVICES, PDBS);
  const pdbIdx = result.findIndex(s => s.classification === CLASSIFICATIONS.PDB_DEFAULT);
  const patchIdx = result.findIndex(s => s.classification === CLASSIFICATIONS.EBS_PATCH_MODE);
  assert.ok(pdbIdx >= 0);
  assert.ok(patchIdx >= 0);
  assert.ok(pdbIdx < patchIdx, 'PDB_DEFAULT should appear before EBS_PATCH_MODE');
});

test('returns 9 distinct services (no duplicates)', () => {
  const result = classifyServices(SERVICES, PDBS);
  assert.strictEqual(result.length, 9, `Expected 9 services, got ${result.length}`);
});

test('PDB name correctly resolved for ebs_EBSDEV', () => {
  const result = classifyServices(SERVICES, PDBS);
  const ebsSvc = result.find(s => s.name === 'ebs_EBSDEV');
  assert.strictEqual(ebsSvc.pdb_name, 'EBSDEV');
});

test('handles empty services array', () => {
  const result = classifyServices([], []);
  assert.deepStrictEqual(result, []);
});

test('handles null/undefined gracefully', () => {
  const result = classifyServices(null, null);
  assert.deepStrictEqual(result, []);
});

test('non-CDB instance (con_id=0): single SID with no PDB table', () => {
  const nonCdb = [{ con_id: 0, name: 'ORCL', network_name: 'ORCL' }];
  const result = classifyServices(nonCdb, []);
  // con_id=0 is not 1, so not CDB_ROOT — should be OTHER
  const svc = result[0];
  assert.ok(svc, 'should have one service');
  assert.notStrictEqual(svc.classification, CLASSIFICATIONS.CDB_ROOT, 'con_id=0 is not CDB root');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
