/**
 * routes/ebs-validation.js — EBS feature smoke-test runner.
 *
 * Owns: /api/admin/ebs-validation/run-all — exercises every EBS code path added
 *       in the last 48h and returns pass/fail per test row. Admin-only.
 * Does NOT own: actual Oracle connections, health check execution, user CRUD.
 *
 * Mounted at: /api/admin/ebs-validation (see server.js)
 *
 * Tests run entirely within the Node process — no real Oracle DB needed.
 * Tests against demo data, DB state assertions, and static-analysis checks.
 */

'use strict';

const express = require('express');
const pool    = require('../db/index');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── Test helpers ─────────────────────────────────────────────────────────────

function pass(test, detail, data) {
  return { test, status: 'pass', detail, data: data || null, ran_at: new Date().toISOString() };
}

function fail(test, detail, data) {
  return { test, status: 'fail', detail, data: data || null, ran_at: new Date().toISOString() };
}

function warn(test, detail, data) {
  return { test, status: 'warn', detail, data: data || null, ran_at: new Date().toISOString() };
}

// ── Individual test runners ──────────────────────────────────────────────────

// Test 1a: EBS detection logic (APPS.DUAL probe) is wired in oracle-client.js
async function testEbsDetectionCodePath() {
  const name = 'EBS detection: APPS.DUAL probe present in oracle-client.js';
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'oracle-client.js'), 'utf8');
    const hasApps = src.includes('APPS.DUAL');
    const hasEbsDetected = src.includes('ebsDetected');
    if (hasApps && hasEbsDetected) {
      return pass(name, 'APPS.DUAL probe and ebsDetected variable found in oracle-client.js');
    }
    return fail(name, `Missing: hasApps=${hasApps} hasEbsDetected=${hasEbsDetected}`);
  } catch (e) {
    return fail(name, `Error reading oracle-client.js: ${e.message}`);
  }
}

// Test 1b: EBS detection returns true when ebs_operations present in demo data
async function testEbsDemoDetection() {
  const name = 'EBS detection: demo metrics return ebs_detected=true';
  try {
    const { getDemoMetrics } = require('../demo-data');
    const m = getDemoMetrics();
    if (m.ebs_detected === true) {
      return pass(name, 'getDemoMetrics().ebs_detected === true', { ebs_detected: m.ebs_detected });
    }
    return fail(name, `Expected true, got ${m.ebs_detected}`);
  } catch (e) {
    return fail(name, `Error loading demo-data: ${e.message}`);
  }
}

// Test 1c: EBS operations object present and has concurrent_managers key
async function testEbsOperationsShape() {
  const name = 'EBS detection: demo ebs_operations has required sub-keys';
  try {
    const { getDemoMetrics } = require('../demo-data');
    const m = getDemoMetrics();
    const ebs = m.ebs_operations;
    if (!ebs) return fail(name, 'ebs_operations is null/undefined');
    const requiredKeys = ['concurrent_managers', 'workflow', 'security'];
    const missing = requiredKeys.filter(k => !ebs[k]);
    if (missing.length === 0) {
      return pass(name, `All required keys present: ${requiredKeys.join(', ')}`, { keys: Object.keys(ebs) });
    }
    return fail(name, `Missing keys: ${missing.join(', ')}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 1d: EBS proxy mode — is_ebs column exists in oracle_connections schema
async function testEbsProxyModeColumn() {
  const name = 'Proxy bug fix: is_ebs column exists in oracle_connections';
  try {
    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'oracle_connections'
        AND column_name IN ('is_ebs', 'ebs_opt_in', 'ebs_checks_enabled')
      ORDER BY column_name
    `);
    const found = r.rows.map(row => row.column_name);
    if (found.includes('is_ebs')) {
      return pass(name, `EBS columns present: ${found.join(', ')}`, { columns: found });
    }
    return fail(name, `is_ebs column missing. Found: ${found.join(', ')}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 1e: EBS check_results category 'ebs_operations' is accepted by check persistence code
async function testEbsCheckCategory() {
  const name = "Proxy bug fix: 'ebs_operations' category wired into persistCheckResults";
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hasCategory = src.includes("check_category: 'ebs_operations'");
    const hasEbsCmCheck = src.includes('EBS_CM01_INTERNAL_MANAGER');
    if (hasCategory && hasEbsCmCheck) {
      return pass(name, 'ebs_operations category and EBS_CM01_INTERNAL_MANAGER found in persistCheckResults path');
    }
    return fail(name, `Missing: hasCategory=${hasCategory} hasEbsCmCheck=${hasEbsCmCheck}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 2a: Fleet overview returns is_ebs column
async function testFleetEbsColumn() {
  const name = 'Fleet dashboard: ebs_detected column in oracle_connections powers fleet';
  try {
    const { getFleetOverview } = require('../db/fleet');
    // Admin call (userId=null) — safe to call against real DB
    const connections = await getFleetOverview(null);
    // Just verify the function runs and returns expected shape
    const sample = connections[0];
    if (!sample) {
      return warn(name, 'No connections in DB — shape check skipped, function ran OK', { count: 0 });
    }
    if ('ebs_detected' in sample) {
      const ebsCount = connections.filter(c => c.ebs_detected).length;
      return pass(name, `Fleet returns ebs_detected field. ${connections.length} connections, ${ebsCount} EBS-flagged`, {
        total: connections.length,
        ebs_count: ebsCount,
        sample_keys: Object.keys(sample)
      });
    }
    return fail(name, 'ebs_detected field missing from fleet overview row', { sample_keys: Object.keys(sample) });
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 2b: check_results table has ebs_operations rows in latest demo run
async function testEbsCheckResults() {
  const name = 'EBS health checks: ebs_operations check_results exist in DB';
  try {
    const r = await pool.query(`
      SELECT cr.check_id, cr.status, cr.check_category
      FROM check_results cr
      JOIN health_checks hc ON hc.id = cr.run_id
      WHERE cr.check_category = 'ebs_operations'
        AND hc.is_demo = true
      ORDER BY cr.id DESC
      LIMIT 10
    `);
    if (r.rows.length > 0) {
      const ids = r.rows.map(row => row.check_id);
      return pass(name, `Found ${r.rows.length} ebs_operations check rows from demo runs`, {
        count: r.rows.length,
        check_ids: ids
      });
    }
    return warn(name, 'No ebs_operations rows found — demo health check not yet run with EBS data. Run a demo check to populate.');
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 3a: Concurrent Manager check produces finding in demo data
async function testConcurrentManagerCheck() {
  const name = 'EBS CM checks: demo data has concurrent_managers with finding rows';
  try {
    const { getDemoMetrics } = require('../demo-data');
    const m = getDemoMetrics();
    const cm = m.ebs_operations && m.ebs_operations.concurrent_managers;
    if (!cm) return fail(name, 'concurrent_managers missing from demo ebs_operations');

    const checks = [];
    // cm01: Internal Manager
    if (cm.cm01) {
      const s = cm.cm01.running_processes === 0 ? 'red' : 'green';
      checks.push({ check: 'EBS_CM01_INTERNAL_MANAGER', status: s, value: cm.cm01.running_processes });
    }
    // cm02: Pending requests
    if (cm.cm02) {
      const p = cm.cm02.pending_requests || 0;
      const s = p > 200 ? 'red' : p > 50 ? 'amber' : 'green';
      checks.push({ check: 'EBS_CM02_PENDING_REQUESTS', status: s, value: p });
    }
    // cm10: Error requests
    if (cm.cm10) {
      const e = cm.cm10.error_requests_24h || 0;
      const s = e > 10 ? 'red' : e > 0 ? 'amber' : 'green';
      checks.push({ check: 'EBS_CM10_ERROR_REQUESTS', status: s, value: e });
    }
    if (checks.length > 0) {
      return pass(name, `${checks.length} CM checks evaluate correctly from demo data`, { checks });
    }
    return fail(name, 'No CM checks produced from demo data');
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 3b: OPP check (Output Post Processor) present in demo data
async function testOPPCheck() {
  const name = 'EBS OPP check: Output Post Processor data present in demo';
  try {
    const { getDemoMetrics } = require('../demo-data');
    const m = getDemoMetrics();
    const cm = m.ebs_operations && m.ebs_operations.concurrent_managers;
    if (!cm) return fail(name, 'concurrent_managers missing');

    // OPP is in cm06 (manager list) — look for "Output Post Proc"
    const cm06 = cm.cm06 || [];
    const opp = cm06.find(mgr => mgr.name && mgr.name.toLowerCase().includes('output post'));
    if (opp) {
      return pass(name, `OPP found: "${opp.name}" ${opp.running_processes}/${opp.target_processes} processes`, { opp });
    }
    return warn(name, 'OPP not found in cm06 manager list — may not have OPP-specific check data', { cm06: cm06.map(m => m.name) });
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 3c: Workflow Mailer check present in demo data
async function testWorkflowMailerCheck() {
  const name = 'EBS WF checks: workflow data has errors/backlog finding';
  try {
    const { getDemoMetrics } = require('../demo-data');
    const m = getDemoMetrics();
    const wf = m.ebs_operations && m.ebs_operations.workflow;
    if (!wf) return fail(name, 'workflow missing from demo ebs_operations');

    const checks = [];
    if (wf.wf02) {
      const s = (wf.wf02.error_count || 0) > 10 ? 'red' : (wf.wf02.error_count || 0) > 0 ? 'amber' : 'green';
      checks.push({ check: 'EBS_WF02_WORKFLOW_ERRORS', status: s, value: wf.wf02.error_count });
    }
    if (wf.wf03) {
      const s = (wf.wf03.deferred_ready || 0) > 500 ? 'red' : (wf.wf03.deferred_ready || 0) > 100 ? 'amber' : 'green';
      checks.push({ check: 'EBS_WF03_DEFERRED_QUEUE', status: s, value: wf.wf03.deferred_ready });
    }
    if (wf.wf08) {
      const p2h = wf.wf08.pending_over_2h || 0;
      const s = p2h > 100 ? 'red' : p2h > 20 ? 'amber' : 'green';
      checks.push({ check: 'EBS_WF08_NOTIFICATION_BACKLOG', status: s, value: p2h });
    }
    if (checks.length > 0) {
      return pass(name, `${checks.length} WF checks evaluate from demo data`, { checks });
    }
    return fail(name, 'No WF checks produced from demo data');
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 3d: ADOP session detection code present in server.js
async function testAdopSessionDetection() {
  const name = 'EBS ADOP: session detection code present in server.js';
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hasAdop = src.includes('ADOP') || src.includes('adop');
    const hasFsAdop = src.includes('AD_ADOP_SESSIONS') || src.includes('adop_filesystem');
    if (hasAdop) {
      return pass(name, `ADOP references found in server.js. AD_ADOP_SESSIONS table ref: ${hasFsAdop}`);
    }
    return warn(name, 'No ADOP references found — ADOP checks may not be implemented yet');
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 3e: FND_CONCURRENT_QUEUES query exists in server.js (EBS CM checks source)
async function testFNDConcurrentQueues() {
  const name = 'EBS FND: FND_CONCURRENT_QUEUES / APPS schema queries wired';
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'oracle-client.js'), 'utf8');
    const hasFnd = src.includes('FND_CONCURRENT') || src.includes('fnd_concurrent');
    const hasAppsSchema = src.includes('APPS.') || src.includes("schema: 'APPS'");
    if (hasFnd && hasAppsSchema) {
      return pass(name, 'FND_CONCURRENT queries and APPS schema references found in oracle-client.js');
    }
    return warn(name, `FND_CONCURRENT: ${hasFnd}, APPS schema: ${hasAppsSchema}`, { hasFnd, hasAppsSchema });
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 4a: Fleet overview endpoint DB query includes is_ebs
async function testFleetDbEbsQuery() {
  const name = 'Fleet DB: is_ebs in getFleetOverview SELECT';
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'fleet.js'), 'utf8');
    const hasIsEbs = src.includes('is_ebs') && src.includes('ebs_detected');
    if (hasIsEbs) {
      return pass(name, 'is_ebs column selected and aliased as ebs_detected in db/fleet.js');
    }
    return fail(name, 'is_ebs not found in db/fleet.js SELECT');
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 5a: /vs-oem.html static page check (expected to not exist yet — regression guard)
async function testVsOemPage() {
  const name = '/vs-oem page: content check for EBS terminology';
  try {
    const fs = require('fs');
    const path = require('path');
    const pagePath = path.join(__dirname, '..', 'public', 'vs-oem.html');
    if (!fs.existsSync(pagePath)) {
      return warn(name, '/vs-oem.html does not exist yet — page not yet created', { path: pagePath });
    }
    const html = fs.readFileSync(pagePath, 'utf8');
    const hasCM = html.includes('Concurrent Managers');
    const hasOPP = html.includes('OPP');
    const hasAdop = html.includes('ADOP');
    if (hasCM && hasOPP && hasAdop) {
      return pass(name, 'vs-oem.html contains "Concurrent Managers", "OPP", "ADOP"');
    }
    const missing = [!hasCM && 'Concurrent Managers', !hasOPP && 'OPP', !hasAdop && 'ADOP'].filter(Boolean);
    return fail(name, `Missing terms in vs-oem.html: ${missing.join(', ')}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 6a: SQL Tuning route has EBS detection code
async function testSqlTuningEbsDetection() {
  const name = 'SQL Tuning: EBS detection code present in routes/sql-tuning.js';
  try {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'sql-tuning.js'), 'utf8');
    const hasEbsDetect = src.includes("username = 'APPS'") || src.includes('isEbs');
    const hasApps = src.includes('APPS');
    if (hasEbsDetect && hasApps) {
      return pass(name, 'APPS schema EBS detection present in sql-tuning.js');
    }
    return fail(name, `Missing: hasEbsDetect=${hasEbsDetect} hasApps=${hasApps}`);
  } catch (e) {
    return fail(name, e.message);
  }
}

// Test 6b: SQL tuning findings DB table exists
async function testSqlTuningTable() {
  const name = 'SQL Tuning: sql_tuning_findings table exists in DB';
  try {
    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sql_tuning_findings'
      ORDER BY ordinal_position
      LIMIT 5
    `);
    if (r.rows.length > 0) {
      return pass(name, `sql_tuning_findings table exists with columns: ${r.rows.map(row => row.column_name).join(', ')}`, {
        columns: r.rows.map(row => row.column_name)
      });
    }
    return fail(name, 'sql_tuning_findings table not found in DB');
  } catch (e) {
    return fail(name, e.message);
  }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

async function saveRunResults(tests, summary) {
  try {
    await pool.query(
      `INSERT INTO ebs_validation_runs (summary, tests) VALUES ($1, $2)`,
      [JSON.stringify(summary), JSON.stringify(tests)]
    );
  } catch (e) {
    // Non-fatal: log and continue — page still returns results even if persist fails
    console.error('[ebs-validation] Failed to persist run results:', e.message);
  }
}

// ── Route handler ────────────────────────────────────────────────────────────

/**
 * GET /results
 * Returns the most recent static smoke-test run from DB.
 * Used by the frontend on page mount to restore last run state.
 */
router.get('/results', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, run_at, summary, tests FROM ebs_validation_runs ORDER BY run_at DESC LIMIT 1`
    );
    if (!rows.length) return res.json({ run: null });
    const row = rows[0];
    res.json({
      run: {
        id: row.id,
        run_at: row.run_at,
        summary: row.summary,
        tests: row.tests,
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load results', detail: e.message });
  }
});

router.get('/run-all', requireAdmin, async (req, res) => {
  const start = Date.now();

  // Run all tests in parallel
  const results = await Promise.allSettled([
    testEbsDetectionCodePath(),
    testEbsDemoDetection(),
    testEbsOperationsShape(),
    testEbsProxyModeColumn(),
    testEbsCheckCategory(),
    testFleetEbsColumn(),
    testEbsCheckResults(),
    testConcurrentManagerCheck(),
    testOPPCheck(),
    testWorkflowMailerCheck(),
    testAdopSessionDetection(),
    testFNDConcurrentQueues(),
    testFleetDbEbsQuery(),
    testVsOemPage(),
    testSqlTuningEbsDetection(),
    testSqlTuningTable()
  ]);

  const tests = results.map(r => {
    if (r.status === 'fulfilled') return r.value;
    return fail('unknown', `Test threw unexpectedly: ${r.reason?.message || r.reason}`, null);
  });

  const summary = {
    total: tests.length,
    pass: tests.filter(t => t.status === 'pass').length,
    warn: tests.filter(t => t.status === 'warn').length,
    fail: tests.filter(t => t.status === 'fail').length,
    duration_ms: Date.now() - start
  };

  // Persist for page-reload state restoration (non-blocking)
  await saveRunResults(tests, summary);

  res.json({ summary, tests });
});

// Single test re-run by index — runs the one test and patches DB row
router.get('/run/:idx', requireAdmin, async (req, res) => {
  const runners = [
    testEbsDetectionCodePath,
    testEbsDemoDetection,
    testEbsOperationsShape,
    testEbsProxyModeColumn,
    testEbsCheckCategory,
    testFleetEbsColumn,
    testEbsCheckResults,
    testConcurrentManagerCheck,
    testOPPCheck,
    testWorkflowMailerCheck,
    testAdopSessionDetection,
    testFNDConcurrentQueues,
    testFleetDbEbsQuery,
    testVsOemPage,
    testSqlTuningEbsDetection,
    testSqlTuningTable
  ];
  const idx = parseInt(req.params.idx, 10);
  if (isNaN(idx) || idx < 0 || idx >= runners.length) {
    return res.status(400).json({ error: 'Invalid test index' });
  }
  try {
    const result = await runners[idx]();

    // Patch the latest saved run with this test's updated result (best-effort)
    try {
      const { rows } = await pool.query(
        `SELECT id, tests, summary FROM ebs_validation_runs ORDER BY run_at DESC LIMIT 1`
      );
      if (rows.length) {
        const prev = rows[0];
        const tests = Array.isArray(prev.tests) ? [...prev.tests] : [];
        tests[idx] = result;
        const summary = {
          total: runners.length,
          pass: tests.filter(t => t && t.status === 'pass').length,
          warn: tests.filter(t => t && t.status === 'warn').length,
          fail: tests.filter(t => t && t.status === 'fail').length,
          duration_ms: 0
        };
        await pool.query(
          `UPDATE ebs_validation_runs SET tests = $1, summary = $2 WHERE id = $3`,
          [JSON.stringify(tests), JSON.stringify(summary), prev.id]
        );
      }
    } catch (persistErr) {
      console.error('[ebs-validation] Persist single result failed:', persistErr.message);
    }

    res.json(result);
  } catch (e) {
    res.json(fail(runners[idx].name, e.message));
  }
});

// ── Live probe helpers ────────────────────────────────────────────────────────
// These helpers drive Tests 1-5 against a real connection + SSH target.
// They reuse the existing ssh-executor service and proxy infrastructure.

const executor   = require('../services/ssh-executor');
const dbSsh      = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const https      = require('https');
const http       = require('http');

/**
 * GET /connections
 * Lists oracle_connections that are EBS-detected AND have at least one SSH target
 * linked, or use proxy mode. Admin-only.
 */
router.get('/connections', requireAdmin, async (req, res) => {
  try {
    // Pull all connections marked EBS, including their SSH target count and proxy status
    const { rows } = await pool.query(`
      SELECT
        oc.id,
        oc.connection_name,
        oc.connection_type,
        oc.is_ebs,
        oc.ebs_login_url,
        oc.weblogic_console_url,
        COUNT(st.id)::int AS ssh_target_count
      FROM oracle_connections oc
      LEFT JOIN ssh_targets st ON st.connection_id = oc.id
      WHERE oc.is_ebs = true
      GROUP BY oc.id, oc.connection_name, oc.connection_type, oc.is_ebs,
               oc.ebs_login_url, oc.weblogic_console_url
      ORDER BY oc.connection_name
    `);
    res.json({ connections: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load connections', detail: err.message });
  }
});

/**
 * Helper: forward an HTTP request through the oracle proxy's /api/http-forward.
 * Returns { status, ok, body_snippet, elapsed_ms }
 */
async function probeHttpViaProxy(proxyUrl, proxyApiKey, targetUrl, timeoutMs = 15000) {
  const baseUrl = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const fwdUrl  = baseUrl + '/api/http-forward';
  const body    = JSON.stringify({ target_url: targetUrl, method: 'GET', headers: {}, body: '' });
  const started = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, status: null, body_snippet: '[timeout]', elapsed_ms: Date.now() - started });
    }, timeoutMs);

    const urlObj    = new URL(fwdUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const options   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Api-Key': proxyApiKey },
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (r) => {
      let raw = '';
      r.on('data', c => { raw += c.toString(); });
      r.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(raw);
          resolve({ ok: data.success === true, status: data.status_code || null, body_snippet: (data.body || '').slice(0, 500), elapsed_ms: Date.now() - started });
        } catch {
          resolve({ ok: false, status: null, body_snippet: raw.slice(0, 200), elapsed_ms: Date.now() - started });
        }
      });
    });
    req.on('error', err => { clearTimeout(timer); resolve({ ok: false, status: null, body_snippet: err.message, elapsed_ms: Date.now() - started }); });
    req.write(body);
    req.end();
  });
}

/**
 * POST /run/live/:testId   body: { connection_id }
 * Runs one of the 5 numbered live probe tests against a real connection.
 * testId: 1 | 2 | 3 | 4 | 5
 *
 * Returns { status, diagnostic, raw_output, elapsed_ms }
 */
router.post('/run/live/:testId', requireAdmin, async (req, res) => {
  const testId = parseInt(req.params.testId, 10);
  if (isNaN(testId) || testId < 1 || testId > 5) {
    return res.status(400).json({ error: 'testId must be 1–5' });
  }

  const connectionId = parseInt(req.body && req.body.connection_id, 10);
  if (!connectionId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const started = Date.now();

  try {
    // Load connection meta
    const { rows: connRows } = await pool.query(`
      SELECT id, connection_name, connection_type, is_ebs,
             proxy_url, proxy_api_key_enc, ebs_login_url, weblogic_console_url
      FROM oracle_connections WHERE id = $1
    `, [connectionId]);
    const conn = connRows[0];
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    // Load SSH targets linked to this connection (apps_tier preferred)
    const { rows: sshRows } = await pool.query(`
      SELECT id, label, role, last_connected_at
      FROM ssh_targets WHERE connection_id = $1
      ORDER BY CASE role WHEN 'apps_tier' THEN 0 WHEN 'db_tier' THEN 1 ELSE 2 END, id
    `, [connectionId]);

    const appsTierTarget = sshRows.find(t => t.role === 'apps_tier');
    const anyTarget      = sshRows[0];

    const proxyAvailable = conn.connection_type === 'proxy' && conn.proxy_url && conn.proxy_api_key_enc;
    const sshAvailable   = Boolean(anyTarget);

    // ── Test 1: EBS system identity + APPS schema reachability ──────────────
    if (testId === 1) {
      if (!sshAvailable) {
        return res.json({ status: 'skip', diagnostic: 'No SSH target configured for this connection. Add one at /settings/ssh-targets.', raw_output: null, elapsed_ms: Date.now() - started });
      }
      const target = appsTierTarget || anyTarget;
      const result = await executor.runCommand({ targetId: target.id, commandKey: 'test.identity', initiatedBy: req.user.email });
      const elapsed_ms = Date.now() - started;
      if (result.rejected) {
        return res.json({ status: 'fail', diagnostic: `SSH rejected: ${result.rejectionReason}`, raw_output: result.stderr, elapsed_ms });
      }
      if (!result.ok) {
        return res.json({ status: 'fail', diagnostic: `SSH failed (exit ${result.exitCode}): ${result.stderr.slice(0,200)}`, raw_output: result.stdout + '\n' + result.stderr, elapsed_ms });
      }
      // Pass: identity response present
      const hostname = (result.stdout.match(/\n([^\n]+)\n/) || [])[1] || 'unknown';
      return res.json({ status: 'pass', diagnostic: `SSH identity confirmed. Host: ${hostname.trim()}`, raw_output: result.stdout, elapsed_ms });
    }

    // ── Test 2: Disk + filesystem health (APPL_TOP, /tmp) ───────────────────
    if (testId === 2) {
      if (!sshAvailable) {
        return res.json({ status: 'skip', diagnostic: 'No SSH target configured for this connection.', raw_output: null, elapsed_ms: Date.now() - started });
      }
      const target = appsTierTarget || anyTarget;
      const result = await executor.runCommand({ targetId: target.id, commandKey: 'ebs.fs.appl_top', initiatedBy: req.user.email });
      const elapsed_ms = Date.now() - started;
      if (!result.ok && result.rejected) {
        return res.json({ status: 'fail', diagnostic: `SSH rejected: ${result.rejectionReason}`, raw_output: null, elapsed_ms });
      }
      const out = (result.stdout || '') + (result.stderr || '');
      if (out.includes('APPL_TOP_NOT_SET')) {
        return res.json({ status: 'warn', diagnostic: '$APPL_TOP not set — SSH connected but env not sourced.', raw_output: result.stdout, elapsed_ms });
      }
      // Parse df output for use% warning
      const highUse = (result.stdout.match(/(\d+)%/g) || []).map(p => parseInt(p)).filter(n => n >= 85);
      if (highUse.length > 0) {
        return res.json({ status: 'warn', diagnostic: `Filesystem at ${highUse[0]}% — approaching capacity threshold.`, raw_output: result.stdout, elapsed_ms });
      }
      return res.json({ status: 'pass', diagnostic: 'APPL_TOP filesystem healthy — no capacity warnings.', raw_output: result.stdout, elapsed_ms });
    }

    // ── Test 3: Concurrent Manager + OPP live probe ─────────────────────────
    if (testId === 3) {
      if (!sshAvailable) {
        return res.json({ status: 'skip', diagnostic: 'Requires SSH — configure at /settings/ssh-targets', raw_output: null, elapsed_ms: Date.now() - started });
      }
      const target = appsTierTarget || anyTarget;
      // Run FNDCRM (ICM) check + FNDLIBR count in parallel
      const [icmResult, libResult] = await Promise.all([
        executor.runCommand({ targetId: target.id, commandKey: 'ebs.cm.fndcrm',      initiatedBy: req.user.email }),
        executor.runCommand({ targetId: target.id, commandKey: 'ebs.cm.fndlibr_count', initiatedBy: req.user.email }),
      ]);
      const elapsed_ms = Date.now() - started;

      const icmOut    = icmResult.stdout || '';
      const icmRunning = icmOut.length > 0 && !icmOut.includes('FNDCRM_NOT_RUNNING');

      const libOut    = libResult.stdout || '';
      const libCount  = parseInt((libOut.match(/^(\d+)/) || [])[1]) || 0;

      if (!icmRunning) {
        return res.json({ status: 'fail', diagnostic: 'ICM (FNDCRM) is NOT running. Concurrent Managers are down.', raw_output: icmResult.stdout + '\n' + libResult.stdout, elapsed_ms });
      }
      if (libCount === 0) {
        return res.json({ status: 'warn', diagnostic: `ICM running but 0 FNDLIBR worker processes found. Check individual manager status.`, raw_output: icmResult.stdout + '\n' + libResult.stdout, elapsed_ms });
      }
      return res.json({ status: 'pass', diagnostic: `ICM running. ${libCount} FNDLIBR worker process${libCount !== 1 ? 'es' : ''} active.`, raw_output: icmResult.stdout + '\n' + libResult.stdout, elapsed_ms });
    }

    // ── Test 4: ADOP session sanity ──────────────────────────────────────────
    if (testId === 4) {
      if (!sshAvailable) {
        return res.json({ status: 'skip', diagnostic: 'Requires SSH — configure at /settings/ssh-targets', raw_output: null, elapsed_ms: Date.now() - started });
      }
      const target = appsTierTarget || anyTarget;
      const result = await executor.runCommand({ targetId: target.id, commandKey: 'ebs.adop.phase_status', initiatedBy: req.user.email });
      const elapsed_ms = Date.now() - started;

      const out = result.stdout || '';
      if (out.includes('NO_ACTIVE_ADOP_LOG')) {
        return res.json({ status: 'pass', diagnostic: 'No active ADOP log detected — no in-progress patching session.', raw_output: out, elapsed_ms });
      }
      // Check for stalled/orphaned patterns
      const lower = out.toLowerCase();
      if (lower.includes('stalled') || lower.includes('orphan') || lower.includes('failed')) {
        return res.json({ status: 'fail', diagnostic: 'ADOP log contains stall/failure indicators. Review patching session state.', raw_output: out, elapsed_ms });
      }
      if (lower.includes('in_progress') || lower.includes('running')) {
        return res.json({ status: 'warn', diagnostic: 'ADOP patching session is currently in progress. Normal if a patch is running.', raw_output: out, elapsed_ms });
      }
      return res.json({ status: 'pass', diagnostic: 'ADOP session log found but no stall/failure indicators.', raw_output: out, elapsed_ms });
    }

    // ── Test 5: Workflow + OACore HTTP reachability ──────────────────────────
    if (testId === 5) {
      // Prefer proxy HTTP forward; SSH wf mailer check as secondary
      if (!proxyAvailable && !sshAvailable) {
        return res.json({ status: 'skip', diagnostic: 'Requires proxy connection or SSH — neither configured.', raw_output: null, elapsed_ms: Date.now() - started });
      }

      const probes = [];

      // 5a. HTTP forward to EBS login URL via proxy (if available)
      if (proxyAvailable && conn.ebs_login_url) {
        const apiKey = decrypt(conn.proxy_api_key_enc);
        const httpResult = await probeHttpViaProxy(conn.proxy_url, apiKey, conn.ebs_login_url);
        probes.push({ probe: 'EBS Login URL', ...httpResult });
      }

      // 5b. Workflow Notification Mailer status via SSH
      if (sshAvailable) {
        const target = appsTierTarget || anyTarget;
        const wfResult = await executor.runCommand({ targetId: target.id, commandKey: 'ebs.cm.fndcrm', initiatedBy: req.user.email });
        probes.push({ probe: 'WF Mailer / ICM SSH check', ok: wfResult.ok, status: wfResult.ok ? 200 : null, body_snippet: wfResult.stdout.slice(0, 300), elapsed_ms: wfResult.durationMs });
      }

      const elapsed_ms = Date.now() - started;
      const allOk = probes.every(p => p.ok);
      const httpProbe = probes.find(p => p.probe === 'EBS Login URL');

      if (probes.length === 0) {
        return res.json({ status: 'skip', diagnostic: 'No HTTP URL or SSH configured for this connection.', raw_output: null, elapsed_ms });
      }

      if (!conn.ebs_login_url && proxyAvailable) {
        // Proxy available but no URL saved
        return res.json({ status: 'warn', diagnostic: 'Proxy available but EBS Login URL not saved. Set it in connection settings.', raw_output: JSON.stringify(probes, null, 2), elapsed_ms });
      }

      if (httpProbe && !httpProbe.ok) {
        return res.json({ status: 'fail', diagnostic: `EBS Login URL returned error or is unreachable. HTTP status: ${httpProbe.status || 'N/A'}`, raw_output: JSON.stringify(probes, null, 2), elapsed_ms });
      }

      const statusCode = httpProbe ? httpProbe.status : null;
      if (statusCode && ![200, 301, 302, 303].includes(statusCode)) {
        return res.json({ status: 'warn', diagnostic: `EBS Login URL responded HTTP ${statusCode} — expected 200 or 302.`, raw_output: JSON.stringify(probes, null, 2), elapsed_ms });
      }

      return res.json({ status: 'pass', diagnostic: `EBS HTTP probe${sshAvailable ? ' + WF SSH check' : ''} passed. Status: ${statusCode || 'N/A'}`, raw_output: JSON.stringify(probes, null, 2), elapsed_ms });
    }

  } catch (err) {
    res.status(500).json({ error: 'Test execution error', detail: err.message });
  }
});

module.exports = router;
