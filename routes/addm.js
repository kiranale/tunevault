/**
 * routes/addm.js — ADDM Findings on-demand endpoint.
 *
 * Owns: fetching Oracle ADDM findings for a completed health check; triggering
 *       a fresh AWR snapshot + ADDM analysis (Run Now); connection-scoped
 *       snapshot picker, ADDM execution with persist, and run history.
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * Legacy (health-check-scoped):
 *   POST /api/health-checks/:id/addm
 *   POST /api/health-checks/:id/addm-run
 *
 * New (connection-scoped — used by /addm page):
 *   GET  /api/connections/:connId/addm/snapshots
 *     Returns last 48 AWR snapshots for the snap range picker.
 *   POST /api/connections/:connId/addm/run
 *     Execute ADDM for a given snap range + container; persists to addm_runs;
 *     returns findings + AI commentary.
 *   GET  /api/connections/:connId/addm/runs
 *     List the 20 most recent addm_runs for this connection.
 *   GET  /api/connections/:connId/addm/runs/:runId
 *     Full run detail including raw_report_text and findings.
 *
 * License gating: EE + Diagnostics Pack required.
 * Both direct TCP and proxy connections are supported.
 */

'use strict';

const express = require('express');
const http    = require('http');
const https   = require('https');
const OpenAI  = require('openai');

const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getDemoAddmFindings } = require('../demo-data');
const { decrypt } = require('../crypto-utils');
const {
  insertAddmRun,
  getAddmRuns,
  getAddmRun,
  getConnectionForAddm,
} = require('../db/addm-runs');

const router = express.Router();

// ─── OpenAI ───────────────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey:   process.env.OPENAI_API_KEY,
  baseURL:  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  timeout:  45000,
  maxRetries: 0,
});

// ─── Oracle client (lazy-loaded) ──────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Proxy helpers ────────────────────────────────────────────────────────

function proxyPost(proxyUrl, proxyApiKey, path, body, timeoutMs) {
  const url = new URL(path, proxyUrl);
  const bodyStr = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'X-API-Key': proxyApiKey,
      },
      timeout: timeoutMs,
    };

    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode === 404) {
            const err = new Error('PROXY_OUTDATED');
            err.statusCode = 404;
            return reject(err);
          }
          if (resp.statusCode !== 200 || !parsed.success) {
            reject(new Error(parsed.error || `Proxy returned HTTP ${resp.statusCode}`));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON from proxy: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(new Error(`Proxy request timed out after ${timeoutMs}ms`)); });
    req.on('error', (err) => { reject(new Error(`Could not reach proxy at ${proxyUrl}: ${err.message}`)); });
    req.write(bodyStr);
    req.end();
  });
}

function fetchAddmFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password, lookbackHours }) {
  return proxyPost(proxyUrl, proxyApiKey, '/api/addm',
    { service_name: serviceName, username, password, lookback_hours: lookbackHours },
    60000
  );
}

function runAddmFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password }) {
  return proxyPost(proxyUrl, proxyApiKey, '/api/addm-run',
    { service_name: serviceName, username, password },
    120000
  );
}

function listSnapshotsFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password }) {
  return proxyPost(proxyUrl, proxyApiKey, '/api/addm/snapshots',
    { service_name: serviceName, username, password },
    30000
  );
}

function runAddmRangeFromProxy({ proxyUrl, proxyApiKey, serviceName, username, password, beginSnap, endSnap, container }) {
  return proxyPost(proxyUrl, proxyApiKey, '/api/addm/run-range',
    { service_name: serviceName, username, password, begin_snap: beginSnap, end_snap: endSnap, container },
    120000
  );
}

// ─── AI commentary ────────────────────────────────────────────────────────

async function generateAddmCommentary({ findings, isIdle, beginSnapTime, endSnapTime, dbTimeSeconds, avgActiveSessions }) {
  try {
    const idlePart = isIdle
      ? `The analysis window showed idle/no significant database workload — ADDM returned zero findings.
         DB Time for the window: ${dbTimeSeconds != null ? dbTimeSeconds.toFixed(1) + 's' : 'unknown'}.
         Average Active Sessions: ${avgActiveSessions != null ? avgActiveSessions.toFixed(2) : 'unknown'}.`
      : '';

    const findingsSummary = findings.length > 0
      ? findings.slice(0, 10).map((f, i) =>
          `${i + 1}. [${f.severity?.toUpperCase() || 'INFO'}] ${f.name}: ${f.message} (impact: ${f.impact_pct?.toFixed(1) || 0}% DB time)`
        ).join('\n')
      : 'No findings.';

    const systemPrompt = `You are a senior Oracle DBA analyst helping a DBA understand ADDM results.
Be concise and direct. Focus on business impact and actionable next steps.
Use plain English — no marketing language, no filler phrases.
Format: 2-4 short paragraphs maximum. No bullet lists.`;

    const userMsg = isIdle
      ? `ADDM analysis period: ${beginSnapTime || 'unknown'} → ${endSnapTime || 'unknown'}.
${idlePart}
Explain in plain English why ADDM returned no findings, what DB time of ${dbTimeSeconds != null ? dbTimeSeconds.toFixed(1) + 's' : 'unknown'} tells us about workload,
and what the DBA should do next (suggest checking DBA_HIST_SYSMETRIC_SUMMARY for peak hours, widening the snapshot range, or re-running during a workload period).`
      : `ADDM analysis period: ${beginSnapTime || 'unknown'} → ${endSnapTime || 'unknown'}.
DB Time: ${dbTimeSeconds != null ? dbTimeSeconds.toFixed(1) + 's' : 'unknown'}. Average Active Sessions: ${avgActiveSessions != null ? avgActiveSessions.toFixed(2) : 'unknown'}.

ADDM Findings (sorted by impact):
${findingsSummary}

Rank by business impact, explain each significant finding in plain English, and flag any that have well-known Oracle remediation steps the DBA should apply immediately.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMsg },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    return completion.choices[0]?.message?.content?.trim() || null;
  } catch (e) {
    // Non-fatal — return null; UI shows findings without commentary
    return null;
  }
}

// ─── LEGACY ROUTES (health-check-scoped) ──────────────────────────────────

router.post('/health-checks/:id/addm', requireAuth, async (req, res) => {
  try {
    const lookbackHours = Math.min(parseInt(req.body.lookback_hours) || 24, 168);

    const hcResult = await pool.query(
      `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
              oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
       FROM health_checks hc
       LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
       WHERE hc.id = $1`,
      [req.params.id]
    );

    if (hcResult.rows.length === 0) return res.status(404).json({ error: 'Health check not found' });
    const hc = hcResult.rows[0];

    if (hc.is_demo) return res.json(getDemoAddmFindings(lookbackHours));
    if (hc.status !== 'completed') return res.status(400).json({ error: 'Health check is not yet complete' });
    if (!hc.connection_id) return res.status(400).json({ error: 'Health check has no saved connection' });

    if (hc.connection_type === 'proxy') {
      if (!hc.proxy_url || !hc.proxy_api_key_enc) return res.status(400).json({ error: 'Proxy connection missing URL or API key' });
      const proxyApiKey = decrypt(hc.proxy_api_key_enc);
      try {
        return res.json(await fetchAddmFromProxy({ proxyUrl: hc.proxy_url, proxyApiKey, serviceName: hc.service_name, username: hc.username, password: decrypt(hc.encrypted_password), lookbackHours }));
      } catch (e) {
        if (e.message === 'PROXY_OUTDATED') return res.status(426).json({ error: 'Proxy agent needs updating to support ADDM. Restart it or wait for auto-update (6h).', code: 'PROXY_OUTDATED' });
        throw e;
      }
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });
    res.json(await oracle.queryAddmFindings({ host: hc.host, port: hc.port || 1521, serviceName: hc.service_name, username: hc.username, password: decrypt(hc.encrypted_password) }, { lookbackHours }));
  } catch (err) {
    console.error('[addm] Error fetching ADDM findings:', err);
    res.status(500).json({ error: 'Failed to fetch ADDM findings' });
  }
});

router.post('/health-checks/:id/addm-run', requireAuth, async (req, res) => {
  try {
    const hcResult = await pool.query(
      `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
              oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
       FROM health_checks hc
       LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
       WHERE hc.id = $1`,
      [req.params.id]
    );

    if (hcResult.rows.length === 0) return res.status(404).json({ error: 'Health check not found' });
    const hc = hcResult.rows[0];

    if (hc.is_demo) return res.json({ ...getDemoAddmFindings(24), run_info: { demo: true } });
    if (hc.status !== 'completed') return res.status(400).json({ error: 'Health check is not yet complete' });
    if (!hc.connection_id) return res.status(400).json({ error: 'Health check has no saved connection' });

    if (hc.connection_type === 'proxy') {
      if (!hc.proxy_url || !hc.proxy_api_key_enc) return res.status(400).json({ error: 'Proxy connection missing URL or API key' });
      const proxyApiKey = decrypt(hc.proxy_api_key_enc);
      try {
        return res.json(await runAddmFromProxy({ proxyUrl: hc.proxy_url, proxyApiKey, serviceName: hc.service_name, username: hc.username, password: decrypt(hc.encrypted_password) }));
      } catch (e) {
        if (e.message === 'PROXY_OUTDATED') return res.status(426).json({ error: 'Proxy agent needs updating to support ADDM Run Now. Restart or wait for auto-update.', code: 'PROXY_OUTDATED' });
        throw e;
      }
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });
    res.json(await oracle.runAddmNow({ host: hc.host, port: hc.port || 1521, serviceName: hc.service_name, username: hc.username, password: decrypt(hc.encrypted_password) }));
  } catch (err) {
    console.error('[addm] Error running ADDM now:', err);
    res.status(500).json({ error: 'Failed to run ADDM analysis' });
  }
});

// ─── NEW: CONNECTION-SCOPED ROUTES ────────────────────────────────────────

/**
 * GET /api/connections/:connId/addm/snapshots
 *
 * Returns the last 48 AWR snapshots so the UI can render a snapshot picker.
 * Also returns the list of available containers (for multitenant DBs).
 *
 * Response: { snapshots: [{snap_id, begin_interval_time, end_interval_time}],
 *             containers: [{con_id, name}] }
 */
router.get('/connections/:connId/addm/snapshots', requireAuth, async (req, res) => {
  try {
    const connId = parseInt(req.params.connId, 10);
    const conn = await getConnectionForAddm(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type === 'proxy') {
      if (!conn.proxy_url || !conn.proxy_api_key_enc) return res.status(400).json({ error: 'Proxy connection missing URL or API key' });
      const proxyApiKey = decrypt(conn.proxy_api_key_enc);
      try {
        const result = await listSnapshotsFromProxy({ proxyUrl: conn.proxy_url, proxyApiKey, serviceName: conn.service_name, username: conn.username, password: decrypt(conn.encrypted_password) });
        return res.json(result);
      } catch (e) {
        if (e.message === 'PROXY_OUTDATED') {
          // Proxy doesn't support /api/addm/snapshots yet — return empty list with note
          return res.json({ snapshots: [], containers: [], proxy_outdated: true });
        }
        throw e;
      }
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const connParams = { host: conn.host, port: conn.port || 1521, serviceName: conn.service_name, username: conn.username, password: decrypt(conn.encrypted_password) };
    const result = await oracle.listAWRSnapshots(connParams);
    return res.json(result);
  } catch (err) {
    console.error('[addm] Error listing snapshots:', err);
    res.status(500).json({ error: 'Failed to list AWR snapshots' });
  }
});

/**
 * POST /api/connections/:connId/addm/run
 *
 * Execute ADDM for the given snap range (or quick preset) + optional container.
 * Persists the result to addm_runs. Returns findings + AI commentary.
 *
 * Body:
 *   { preset?: 'last_1h'|'last_4h'|'last_24h'|'last_bounce'|null,
 *     begin_snap?: number,
 *     end_snap?: number,
 *     container?: string }
 */
router.post('/connections/:connId/addm/run', requireAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const connId = parseInt(req.params.connId, 10);
    const conn = await getConnectionForAddm(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const { preset, begin_snap, end_snap, container } = req.body || {};

    let oracleResult;

    if (conn.connection_type === 'proxy') {
      if (!conn.proxy_url || !conn.proxy_api_key_enc) return res.status(400).json({ error: 'Proxy connection missing URL or API key' });
      const proxyApiKey = decrypt(conn.proxy_api_key_enc);
      try {
        if (begin_snap && end_snap) {
          oracleResult = await runAddmRangeFromProxy({ proxyUrl: conn.proxy_url, proxyApiKey, serviceName: conn.service_name, username: conn.username, password: decrypt(conn.encrypted_password), beginSnap: begin_snap, endSnap: end_snap, container });
        } else {
          // Fallback to run-now (takes new snapshot + latest 2)
          oracleResult = await runAddmFromProxy({ proxyUrl: conn.proxy_url, proxyApiKey, serviceName: conn.service_name, username: conn.username, password: decrypt(conn.encrypted_password) });
        }
      } catch (e) {
        if (e.message === 'PROXY_OUTDATED') {
          return res.status(426).json({ error: 'Proxy agent needs updating. Restart or wait for auto-update (6h).', code: 'PROXY_OUTDATED' });
        }
        throw e;
      }
    } else {
      const oracle = getOracleClient();
      if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

      const connParams = { host: conn.host, port: conn.port || 1521, serviceName: conn.service_name, username: conn.username, password: decrypt(conn.encrypted_password) };

      if (begin_snap && end_snap) {
        oracleResult = await oracle.runAddmBySnapRange(connParams, { beginSnap: begin_snap, endSnap: end_snap, container, preset });
      } else {
        // Quick preset or no snap range — use preset lookup or default run-now
        oracleResult = await oracle.runAddmWithPreset(connParams, { preset: preset || 'last_1h', container });
      }
    }

    if (!oracleResult.licensed) {
      return res.json({ ...oracleResult, run_id: null });
    }

    const findings = oracleResult.findings || [];
    const isIdle = findings.length === 0 && oracleResult.licensed;

    // Generate AI commentary (non-blocking — if it times out we persist without it)
    const aiCommentary = await generateAddmCommentary({
      findings,
      isIdle,
      beginSnapTime: oracleResult.begin_snap_time,
      endSnapTime:   oracleResult.end_snap_time,
      dbTimeSeconds: oracleResult.db_time_seconds,
      avgActiveSessions: oracleResult.avg_active_sessions,
    });

    const runInfo = oracleResult.run_info || {};
    const saved = await insertAddmRun({
      connectionId:      connId,
      createdBy:         req.user.id,
      taskName:          oracleResult.task_name,
      taskId:            oracleResult.task_id,
      dbId:              oracleResult.db_id,
      container:         oracleResult.container || container || null,
      beginSnapId:       oracleResult.begin_snap || oracleResult.begin_snap_id,
      endSnapId:         oracleResult.end_snap   || oracleResult.end_snap_id,
      beginSnapTime:     oracleResult.begin_snap_time,
      endSnapTime:       oracleResult.end_snap_time,
      dbTimeSeconds:     oracleResult.db_time_seconds,
      avgActiveSessions: oracleResult.avg_active_sessions,
      findings,
      rawReportText:     oracleResult.raw_report_text,
      aiCommentary,
      isIdle,
      runError:          oracleResult.run_error || null,
      snapshotMs:        runInfo.snapshot_ms,
      analysisMs:        runInfo.analysis_ms,
      totalMs:           Date.now() - t0,
    });

    return res.json({
      ...oracleResult,
      ai_commentary: aiCommentary,
      run_id: saved.id,
      is_idle: isIdle,
    });
  } catch (err) {
    console.error('[addm] Error running ADDM by range:', err);
    res.status(500).json({ error: err.message || 'Failed to run ADDM analysis' });
  }
});

/**
 * GET /api/connections/:connId/addm/runs
 *
 * List the 20 most recent ADDM run records for this connection.
 */
router.get('/connections/:connId/addm/runs', requireAuth, async (req, res) => {
  try {
    const connId = parseInt(req.params.connId, 10);
    const conn = await getConnectionForAddm(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const runs = await getAddmRuns(connId, 20);
    res.json({ runs });
  } catch (err) {
    console.error('[addm] Error listing runs:', err);
    res.status(500).json({ error: 'Failed to list ADDM runs' });
  }
});

/**
 * GET /api/connections/:connId/addm/runs/:runId
 *
 * Full run detail — includes findings, raw_report_text, ai_commentary.
 */
router.get('/connections/:connId/addm/runs/:runId', requireAuth, async (req, res) => {
  try {
    const runId = parseInt(req.params.runId, 10);
    const run = await getAddmRun(runId, req.user.id);
    if (!run) return res.status(404).json({ error: 'ADDM run not found' });
    res.json({ run });
  } catch (err) {
    console.error('[addm] Error loading run:', err);
    res.status(500).json({ error: 'Failed to load ADDM run' });
  }
});

module.exports = router;
