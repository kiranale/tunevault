/**
 * routes/performance-advisor.js — Performance Advisor panel: ADDM + SQL Tuning Advisor.
 *
 * Owns: /api/advisor/:connectionId/* endpoints — fetching and caching Oracle
 *       built-in advisor output (ADDM tasks, findings, recommendations, SQL Tuning Advisor).
 *       Also owns: /api/advisor/checks/source — SQL registry for "Show SQL" transparency.
 * Does NOT own: auth state, Oracle connection storage, health check execution,
 *               other performance tabs (top-sql, wait-events, blocking-sessions).
 *
 * Mounted at: /api/advisor (see server.js)
 *
 * Routes:
 *   GET /api/advisor/:connectionId/findings
 *     Returns cached advisor findings (from last fetch). Never triggers Oracle query.
 *
 *   POST /api/advisor/:connectionId/fetch
 *     Connects to Oracle, runs all 4 advisor queries, generates AI summary,
 *     stores result in advisor_findings, returns the full payload.
 *
 *   GET /api/advisor/checks/source (or ?check_id=xxx)
 *     Returns the SQL registry for "Show SQL" transparency on every check.
 *
 *   POST /api/advisor/:connectionId/empty-state-probes
 *     Runs 4 diagnostic probes when ADDM returns no results, to explain why.
 *
 * Oracle views required:
 *   DBA_ADDM_TASKS, DBA_ADVISOR_FINDINGS, DBA_ADVISOR_RECOMMENDATIONS,
 *   DBA_ADVISOR_ACTIONS, DBA_ADVISOR_TASKS — all require SELECT_CATALOG_ROLE.
 *
 * License gating: EE + Oracle Diagnostics Pack required for ADDM views.
 * SE/SE2 editions return licensed=false with a clear explanation.
 *
 * Empty-state handling: If findings contain only INFORMATION-type items with
 * "no significant database activity" messages, the API sets empty_state=true
 * and returns an informative context block rather than a blank card.
 */

'use strict';

const express = require('express');
const OpenAI  = require('openai');

const { requireAuth } = require('../middleware/auth');
const {
  upsertAdvisorFindings,
  getAdvisorFindings,
  getConnectionForAdvisor,
  getUserForAdvisor,
} = require('../db/advisor-findings');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── SQL Registry for "Show SQL" transparency ────────────────────────────────
// One record per Performance Advisor check. Exposed via GET /api/advisor/checks/source.
// The DBA can copy these and run them verbatim in SQL Developer to verify TuneVault's output.

const CHECK_SQL_REGISTRY = [
  {
    check_id: 'addm_tasks',
    title: 'ADDM Tasks (last 7 days)',
    description: 'Retrieves all ADDM analysis tasks created in the last 7 days, ordered newest first.',
    source_objects: ['DBA_ADDM_TASKS'],
    sql: `SELECT task_id, task_name, status, begin_snap_id, end_snap_id,
       TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created_str
FROM DBA_ADDM_TASKS
WHERE created > SYSDATE - 7
ORDER BY created DESC
FETCH FIRST 20 ROWS ONLY`,
  },
  {
    check_id: 'advisor_findings',
    title: 'ADDM Advisor Findings',
    description: 'Retrieves findings for a set of ADDM task IDs, sorted by performance impact.',
    source_objects: ['DBA_ADVISOR_FINDINGS'],
    sql: `SELECT f.task_id, f.finding_id, f.type, ROUND(f.impact, 2) AS impact_pct,
       SUBSTR(f.message, 1, 500) AS message
FROM DBA_ADVISOR_FINDINGS f
WHERE f.task_id IN (<task_ids>)
ORDER BY f.impact DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY`,
  },
  {
    check_id: 'advisor_recommendations',
    title: 'ADDM Recommendations & Actions',
    description: 'Retrieves recommendations and associated actions for ADDM findings, sorted by benefit.',
    source_objects: ['DBA_ADVISOR_RECOMMENDATIONS', 'DBA_ADVISOR_ACTIONS'],
    sql: `SELECT r.task_id, r.finding_id, r.rec_id, r.type, ROUND(r.benefit, 2) AS benefit,
       SUBSTR(a.message, 1, 500) AS action_message
FROM DBA_ADVISOR_RECOMMENDATIONS r
JOIN DBA_ADVISOR_ACTIONS a ON a.task_id = r.task_id AND a.rec_id = r.rec_id
WHERE r.task_id IN (<task_ids>)
ORDER BY r.benefit DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY`,
  },
  {
    check_id: 'sql_tuning_advisor_tasks',
    title: 'SQL Tuning Advisor Tasks (last 7 days)',
    description: 'Lists all automatic SQL Tuning Advisor tasks from the last 7 days.',
    source_objects: ['DBA_ADVISOR_TASKS'],
    sql: `SELECT task_id, task_name, status, TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created_str
FROM DBA_ADVISOR_TASKS
WHERE advisor_name = 'SQL Tuning Advisor'
  AND created > SYSDATE - 7
ORDER BY created DESC
FETCH FIRST 20 ROWS ONLY`,
  },
  {
    check_id: 'awr_snapshot_availability',
    title: 'AWR Snapshot Availability (empty-state probe)',
    description: 'Checks whether AWR snapshots exist in the last 24 hours. No snapshots = STATISTICS_LEVEL may be BASIC or MMON is not running.',
    source_objects: ['DBA_HIST_SNAPSHOT'],
    sql: `SELECT MIN(BEGIN_INTERVAL_TIME) AS oldest_snap,
       MAX(END_INTERVAL_TIME) AS newest_snap,
       COUNT(*) AS snap_count
FROM DBA_HIST_SNAPSHOT
WHERE END_INTERVAL_TIME > SYSDATE - 1`,
  },
  {
    check_id: 'diagnostic_pack_license',
    title: 'Diagnostic Pack License Check (empty-state probe)',
    description: 'Reads the control_management_pack_access parameter to determine whether the Diagnostics Pack or Tuning Pack is licensed.',
    source_objects: ['V$PARAMETER'],
    sql: `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'control_management_pack_access'`,
  },
  {
    check_id: 'last_addm_task',
    title: 'Last Completed ADDM Task (empty-state probe)',
    description: 'Finds the most recently completed ADDM task regardless of time window, so DBAs can see when ADDM last ran even if outside the 24h window.',
    source_objects: ['DBA_ADVISOR_TASKS'],
    sql: `SELECT MAX(EXECUTION_END) AS last_completion, COUNT(*) AS total_completed
FROM DBA_ADVISOR_TASKS
WHERE ADVISOR_NAME = 'ADDM'
  AND STATUS = 'COMPLETED'`,
  },
  {
    check_id: 'db_edition',
    title: 'Database Edition Check (empty-state probe)',
    description: 'Reads V$VERSION to determine whether the database is Enterprise Edition (required for ADDM) or Standard Edition.',
    source_objects: ['V$VERSION'],
    sql: `SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`,
  },
];

// ─── Oracle queries ───────────────────────────────────────────────────────────

// Recent ADDM tasks (last 7 days)
const ADDM_TASKS_QUERY = `
SELECT task_id, task_name, status, begin_snap_id, end_snap_id,
       TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created_str
FROM DBA_ADDM_TASKS
WHERE created > SYSDATE - 7
ORDER BY created DESC
FETCH FIRST 20 ROWS ONLY
`;

// Advisor findings for a list of task IDs (injected as string)
const FINDINGS_QUERY = `
SELECT f.task_id, f.finding_id, f.type, ROUND(f.impact, 2) AS impact_pct, SUBSTR(f.message, 1, 500) AS message
FROM DBA_ADVISOR_FINDINGS f
WHERE f.task_id IN (:taskIds)
ORDER BY f.impact DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY
`;

// Recommendations + actions (injected task IDs)
const RECS_QUERY = `
SELECT r.task_id, r.finding_id, r.rec_id, r.type, ROUND(r.benefit, 2) AS benefit,
       SUBSTR(a.message, 1, 500) AS action_message
FROM DBA_ADVISOR_RECOMMENDATIONS r
JOIN DBA_ADVISOR_ACTIONS a ON a.task_id = r.task_id AND a.rec_id = r.rec_id
WHERE r.task_id IN (:taskIds)
ORDER BY r.benefit DESC NULLS LAST
FETCH FIRST 100 ROWS ONLY
`;

// SQL Tuning Advisor tasks (last 7 days)
const STA_TASKS_QUERY = `
SELECT task_id, task_name, status, TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created_str
FROM DBA_ADVISOR_TASKS
WHERE advisor_name = 'SQL Tuning Advisor'
  AND created > SYSDATE - 7
ORDER BY created DESC
FETCH FIRST 20 ROWS ONLY
`;

// ─── Oracle fetch ─────────────────────────────────────────────────────────────

async function fetchAdvisorFromOracle(connParams) {
  const oracledb = require('oracledb');
  const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
  let connection;

  try {
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30,
    });

    // Step 1: Fetch ADDM tasks
    let addmTasks = [];
    let licensed = true;
    let notLicensedReason = null;

    try {
      const r = await connection.execute(ADDM_TASKS_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      addmTasks = (r.rows || []).map(row => ({
        task_id:       Number(row.TASK_ID || row.task_id || 0),
        task_name:     row.TASK_NAME || row.task_name || '',
        status:        row.STATUS || row.status || '',
        begin_snap_id: Number(row.BEGIN_SNAP_ID || row.begin_snap_id || 0),
        end_snap_id:   Number(row.END_SNAP_ID || row.end_snap_id || 0),
        created:       row.CREATED_STR || row.created_str || null,
      }));
    } catch (err) {
      // ORA-00942 or ORA-00904 → view doesn't exist (SE or no Diagnostics Pack)
      if (err.message && (err.message.includes('ORA-00942') || err.message.includes('ORA-00904') || err.message.includes('insufficient privileges'))) {
        licensed = false;
        notLicensedReason = 'Oracle Diagnostics Pack license required to access DBA_ADDM_TASKS. This view is only available in Enterprise Edition with the Diagnostics Pack option.';
        return { licensed, notLicensedReason, addmTasks: [], findings: [], recommendations: [], sqlTuningTasks: [] };
      }
      throw err;
    }

    // Step 2: Fetch findings for those tasks
    let findings = [];
    const taskIds = addmTasks.map(t => t.task_id).filter(Boolean);

    if (taskIds.length > 0) {
      // Oracle doesn't support bind arrays in IN clauses cleanly; build a safe literal list
      const safeIds = taskIds.map(id => Number(id)).filter(n => !isNaN(n)).join(',');
      try {
        const findingsQ = FINDINGS_QUERY.replace(':taskIds', safeIds);
        const r = await connection.execute(findingsQ, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        findings = (r.rows || []).map(row => ({
          task_id:    Number(row.TASK_ID || row.task_id || 0),
          finding_id: Number(row.FINDING_ID || row.finding_id || 0),
          type:       row.TYPE || row.type || '',
          impact_pct: Number(row.IMPACT_PCT || row.impact_pct || 0),
          message:    row.MESSAGE || row.message || '',
        }));
      } catch (e) {
        console.error('[advisor] findings query failed:', e.message);
      }

      // Step 3: Fetch recommendations + actions
      let recommendations = [];
      try {
        const recsQ = RECS_QUERY.replace(':taskIds', safeIds);
        const r = await connection.execute(recsQ, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        recommendations = (r.rows || []).map(row => ({
          task_id:        Number(row.TASK_ID || row.task_id || 0),
          finding_id:     Number(row.FINDING_ID || row.finding_id || 0),
          rec_id:         Number(row.REC_ID || row.rec_id || 0),
          type:           row.TYPE || row.type || '',
          benefit:        Number(row.BENEFIT || row.benefit || 0),
          action_message: row.ACTION_MESSAGE || row.action_message || '',
        }));
      } catch (e) {
        console.error('[advisor] recommendations query failed:', e.message);
      }

      // Step 4: SQL Tuning Advisor tasks
      let sqlTuningTasks = [];
      try {
        const r = await connection.execute(STA_TASKS_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        sqlTuningTasks = (r.rows || []).map(row => ({
          task_id:   Number(row.TASK_ID || row.task_id || 0),
          task_name: row.TASK_NAME || row.task_name || '',
          status:    row.STATUS || row.status || '',
          created:   row.CREATED_STR || row.created_str || null,
        }));
      } catch (e) {
        console.error('[advisor] SQL Tuning Advisor tasks query failed:', e.message);
      }

      return { licensed: true, notLicensedReason: null, addmTasks, findings, recommendations: recommendations || [], sqlTuningTasks };
    }

    return { licensed: true, notLicensedReason: null, addmTasks, findings: [], recommendations: [], sqlTuningTasks: [] };

  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Empty-state detection ────────────────────────────────────────────────────

// ADDM returns INFORMATION-only findings with "no significant database activity"
// when the workload was genuinely low. Detect this so the UI can show
// a helpful context card instead of a confusing blank panel.
function detectEmptyState(findings) {
  if (!findings || findings.length === 0) return false;
  const nonInfo = findings.filter(f => f.type && f.type.toUpperCase() !== 'INFORMATION');
  if (nonInfo.length > 0) return false;
  return findings.some(f =>
    f.message && f.message.toLowerCase().includes('no significant database activity')
  );
}

// ─── AI summary ───────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM = `You are a senior Oracle DBA. Your job is to write a single clear paragraph (4–6 sentences) summarising Oracle ADDM + SQL Tuning Advisor output for a database administrator.

Rules:
- Write in plain English. No bullet points, no headers, no markdown.
- Lead with the most impactful finding. If there are no actionable findings, say so clearly and explain why.
- Quantify where possible (e.g. "ADDM found 3 findings averaging 12% DB time impact").
- If the only finding is INFORMATION/"no significant database activity", explain the three likely causes: (1) light workload in the window, (2) AWR snapshot interval may be too short, (3) genuinely healthy idle period.
- End with one concrete next step the DBA should take.
- 120 words maximum.`;

async function generateAdvisorSummary(addmTasks, findings, recommendations, sqlTuningTasks) {
  let openai;
  try { openai = new OpenAI(); } catch { return null; }

  const findingsSummary = findings.slice(0, 10).map(f =>
    `  [${f.type}] impact=${f.impact_pct}% — ${f.message.substring(0, 100)}`
  ).join('\n') || '  (none)';

  const recsSummary = recommendations.slice(0, 5).map(r =>
    `  benefit=${r.benefit}% — ${r.action_message.substring(0, 100)}`
  ).join('\n') || '  (none)';

  const prompt = `ADDM tasks (last 7 days): ${addmTasks.length}
SQL Tuning Advisor tasks (last 7 days): ${sqlTuningTasks.length}
Findings (top 10 by impact):
${findingsSummary}
Recommendations (top 5 by benefit):
${recsSummary}

Write the summary paragraph. Plain text only.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 200,
    });
    return (resp.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e) {
    console.error('[advisor] AI summary failed:', e.message);
    return null;
  }
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function getDemoAdvisorData() {
  return {
    licensed: true,
    is_demo: true,
    empty_state: false,
    fetched_at: new Date().toISOString(),
    ai_summary: 'ADDM ran 6 tasks across the last 7 days and identified 3 actionable findings with a combined impact of 24% DB time. The dominant issue is excessive SQL parsing — 14% of DB time is lost to hard parses caused by missing bind variables in APPS-schema reports. A secondary finding flags a large number of buffer-busy waits on OE_ORDER_LINES_ALL during peak hours. Two SQL Tuning Advisor tasks completed with index recommendations. Immediate next step: review the top hard-parsing SQL identified in Task 4 and introduce bind variables or enable CURSOR_SHARING=FORCE in a staging environment.',
    addm_tasks: [
      { task_id: 101, task_name: 'TASK_00101', status: 'COMPLETED', begin_snap_id: 4820, end_snap_id: 4824, created: '2026-05-14 22:00:01' },
      { task_id: 98,  task_name: 'TASK_00098', status: 'COMPLETED', begin_snap_id: 4816, end_snap_id: 4820, created: '2026-05-14 20:00:01' },
      { task_id: 95,  task_name: 'TASK_00095', status: 'COMPLETED', begin_snap_id: 4812, end_snap_id: 4816, created: '2026-05-14 18:00:01' },
      { task_id: 92,  task_name: 'TASK_00092', status: 'COMPLETED', begin_snap_id: 4808, end_snap_id: 4812, created: '2026-05-14 16:00:01' },
      { task_id: 89,  task_name: 'TASK_00089', status: 'COMPLETED', begin_snap_id: 4804, end_snap_id: 4808, created: '2026-05-14 14:00:01' },
      { task_id: 86,  task_name: 'TASK_00086', status: 'COMPLETED', begin_snap_id: 4800, end_snap_id: 4804, created: '2026-05-14 12:00:01' },
    ],
    findings: [
      { task_id: 101, finding_id: 1, type: 'PROBLEM', impact_pct: 14.2, message: 'Hard parsing of SQL statements is consuming significant DB time. 8,420 hard parses occurred in the analysis window, primarily in the APPS schema. Many statements differ only in literal values — bind variables would eliminate this overhead.' },
      { task_id: 101, finding_id: 2, type: 'PROBLEM', impact_pct: 6.8, message: 'Buffer busy waits on segment OE_ORDER_LINES_ALL indicate hot block contention. Peak contention occurs during order entry. Consider increasing FREELISTS or using ASSM tablespace for this table.' },
      { task_id: 98,  finding_id: 1, type: 'PROBLEM', impact_pct: 3.1, message: 'Checkpoint not complete waits indicate redo log files are too small. Increasing redo log size from 200MB to 1GB would eliminate these waits during peak DML.' },
      { task_id: 95,  finding_id: 1, type: 'INFORMATION', impact_pct: 0, message: 'SQL Tuning Advisor found 2 statements that would benefit from new indexes. See recommendations for details.' },
      { task_id: 92,  finding_id: 1, type: 'INFORMATION', impact_pct: 0, message: 'No significant database activity was detected during this analysis period.' },
    ],
    recommendations: [
      { task_id: 101, finding_id: 1, rec_id: 1, type: 'SQL PROFILE', benefit: 14.2, action_message: 'Enable CURSOR_SHARING=FORCE at system level or rewrite the top-20 hard-parsing statements to use bind variables. Immediate impact: eliminate 8,000+ hard parses per hour.' },
      { task_id: 101, finding_id: 2, rec_id: 1, type: 'SEGMENT TUNING', benefit: 6.8, action_message: 'Move OE_ORDER_LINES_ALL to an ASSM-managed tablespace: ALTER TABLE oe_order_lines_all MOVE TABLESPACE apps_ts_tx_data; then rebuild all indexes on the table.' },
      { task_id: 98,  finding_id: 1, rec_id: 1, type: 'DB CONFIGURATION', benefit: 3.1, action_message: 'Add redo log groups sized at 1GB: ALTER DATABASE ADD LOGFILE GROUP 5 (\'/u01/oradata/prod/redo05a.log\',\'/u02/oradata/prod/redo05b.log\') SIZE 1G; After adding 3–4 new groups, drop the existing small ones.' },
    ],
    sql_tuning_tasks: [
      { task_id: 201, task_name: 'STA_SCHED_SA_01$', status: 'COMPLETED', created: '2026-05-14 02:00:00' },
      { task_id: 198, task_name: 'STA_SCHED_SA_01$', status: 'COMPLETED', created: '2026-05-13 02:00:00' },
    ],
  };
}

// ─── Empty-state diagnostic probes ────────────────────────────────────────────
// Runs 4 Oracle queries to explain WHY ADDM has no results.
// Called by the frontend when empty_state=true is received.

async function runEmptyStateProbes(connParams) {
  const oracledb = require('oracledb');
  const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
  let connection;

  const result = {
    awr: null,        // AWR snapshot availability
    license: null,    // Diagnostic pack license parameter
    lastTask: null,   // Last completed ADDM task (any time)
    edition: null,    // DB edition (Enterprise vs Standard)
    errors: {},       // per-probe error messages if any
  };

  try {
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30,
    });

    // Probe 1: AWR snapshot availability (last 24h)
    try {
      const r = await connection.execute(
        `SELECT MIN(BEGIN_INTERVAL_TIME) AS oldest_snap,
                MAX(END_INTERVAL_TIME) AS newest_snap,
                COUNT(*) AS snap_count
         FROM DBA_HIST_SNAPSHOT
         WHERE END_INTERVAL_TIME > SYSDATE - 1`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = r.rows && r.rows[0];
      result.awr = {
        snap_count: row ? Number(row.SNAP_COUNT || 0) : 0,
        oldest_snap: row && row.OLDEST_SNAP ? String(row.OLDEST_SNAP) : null,
        newest_snap: row && row.NEWEST_SNAP ? String(row.NEWEST_SNAP) : null,
      };
    } catch (e) {
      result.errors.awr = e.message;
    }

    // Probe 2: Diagnostic Pack license parameter
    try {
      const r = await connection.execute(
        `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'control_management_pack_access'`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = r.rows && r.rows[0];
      result.license = {
        value: row ? (row.VALUE || row.value || '') : '',
      };
    } catch (e) {
      result.errors.license = e.message;
    }

    // Probe 3: Last completed ADDM task (any time window)
    try {
      const r = await connection.execute(
        `SELECT MAX(EXECUTION_END) AS last_completion, COUNT(*) AS total_completed
         FROM DBA_ADVISOR_TASKS
         WHERE ADVISOR_NAME = 'ADDM'
           AND STATUS = 'COMPLETED'`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = r.rows && r.rows[0];
      result.lastTask = {
        last_completion: row && row.LAST_COMPLETION ? String(row.LAST_COMPLETION) : null,
        total_completed: row ? Number(row.TOTAL_COMPLETED || 0) : 0,
      };
    } catch (e) {
      result.errors.lastTask = e.message;
    }

    // Probe 4: DB edition
    try {
      const r = await connection.execute(
        `SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const row = r.rows && r.rows[0];
      result.edition = {
        banner: row ? (row.BANNER || row.banner || '') : '',
      };
    } catch (e) {
      result.errors.edition = e.message;
    }

    return result;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * GET /api/advisor/checks/source
 * GET /api/advisor/checks/source?check_id=awr_snapshot_availability
 *
 * Returns the SQL registry for "Show SQL" transparency.
 * Auth required. Returns all checks or a single check if check_id is provided.
 *
 * IMPORTANT: Must be defined before /:connectionId routes to avoid being
 * swallowed by the /:connectionId parameter match.
 */
router.get('/checks/source', requireAuth, (req, res) => {
  const { check_id } = req.query;
  if (check_id) {
    const check = CHECK_SQL_REGISTRY.find(c => c.check_id === check_id);
    if (!check) return res.status(404).json({ error: 'Check not found', check_id });
    return res.json(check);
  }
  res.json({ checks: CHECK_SQL_REGISTRY });
});

/**
 * GET /api/advisor/:connectionId/findings
 *
 * Returns the cached advisor findings for this connection without hitting Oracle.
 * Returns 404 with { needs_fetch: true } if no data exists yet.
 *
 * connectionId = 'demo' returns deterministic demo data.
 */
router.get('/:connectionId/findings', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      return res.json(getDemoAdvisorData());
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const conn = await getConnectionForAdvisor(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const cached = await getAdvisorFindings(connId);
    if (!cached) {
      return res.status(404).json({ needs_fetch: true, message: 'No advisor data yet — click Refresh to fetch from Oracle.' });
    }

    const findings = Array.isArray(cached.findings) ? cached.findings : JSON.parse(cached.findings || '[]');
    const addmTasks = Array.isArray(cached.addm_tasks) ? cached.addm_tasks : JSON.parse(cached.addm_tasks || '[]');
    const recommendations = Array.isArray(cached.recommendations) ? cached.recommendations : JSON.parse(cached.recommendations || '[]');
    const sqlTuningTasks = Array.isArray(cached.sql_tuning_tasks) ? cached.sql_tuning_tasks : JSON.parse(cached.sql_tuning_tasks || '[]');

    res.json({
      licensed:            cached.licensed,
      not_licensed_reason: cached.not_licensed_reason,
      fetch_error:         cached.fetch_error,
      fetched_at:          cached.fetched_at,
      is_demo:             false,
      empty_state:         detectEmptyState(findings),
      ai_summary:          cached.ai_summary,
      addm_tasks:          addmTasks,
      findings,
      recommendations,
      sql_tuning_tasks:    sqlTuningTasks,
    });
  } catch (err) {
    console.error('[advisor] Error reading cached findings:', err);
    res.status(500).json({ error: 'Failed to read advisor findings' });
  }
});

/**
 * POST /api/advisor/:connectionId/fetch
 *
 * Connects to Oracle, runs all 4 advisor queries, generates AI summary,
 * stores in advisor_findings, returns the full payload.
 *
 * Requires direct TCP connection (proxy connections not supported for this feature).
 * connectionId = 'demo' returns demo data without Oracle access.
 */
router.post('/:connectionId/fetch', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      return res.json(getDemoAdvisorData());
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const conn = await getConnectionForAdvisor(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type === 'proxy') {
      return res.status(400).json({
        error: 'Performance Advisor requires a direct TCP connection. Proxy connections are not supported for this feature. Switch to Direct TCP in connection settings.',
        code: 'PROXY_NOT_SUPPORTED'
      });
    }

    const connParams = {
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: conn.service_name,
      username:    conn.username,
      password:    decrypt(conn.encrypted_password),
    };

    // Run advisor queries against Oracle
    let oracleResult;
    let fetchError = null;
    try {
      oracleResult = await fetchAdvisorFromOracle(connParams);
    } catch (err) {
      console.error('[advisor] Oracle fetch failed:', err);
      fetchError = err.message || 'Oracle connection failed';
      oracleResult = {
        licensed: true,
        notLicensedReason: null,
        addmTasks: [],
        findings: [],
        recommendations: [],
        sqlTuningTasks: [],
      };
    }

    const { licensed, notLicensedReason, addmTasks, findings, recommendations, sqlTuningTasks } = oracleResult;

    // Generate AI summary (non-blocking on failure)
    let aiSummary = null;
    if (licensed && !fetchError && (addmTasks.length > 0 || findings.length > 0)) {
      aiSummary = await generateAdvisorSummary(addmTasks, findings, recommendations, sqlTuningTasks);
    }

    // Persist to database
    await upsertAdvisorFindings({
      connectionId: connId,
      addmTasks,
      findings,
      recommendations,
      sqlTuningTasks,
      aiSummary,
      licensed,
      notLicensedReason,
      fetchError,
    });

    const emptyState = detectEmptyState(findings);

    res.json({
      licensed,
      not_licensed_reason: notLicensedReason,
      fetch_error:         fetchError,
      fetched_at:          new Date().toISOString(),
      is_demo:             false,
      empty_state:         emptyState,
      ai_summary:          aiSummary,
      addm_tasks:          addmTasks,
      findings,
      recommendations,
      sql_tuning_tasks:    sqlTuningTasks,
    });
  } catch (err) {
    console.error('[advisor] Error fetching advisor data:', err);
    res.status(500).json({ error: 'Failed to fetch advisor data' });
  }
});

/**
 * POST /api/advisor/:connectionId/empty-state-probes
 *
 * Runs 4 Oracle diagnostic probes when the ADDM panel is empty.
 * Returns structured data the UI uses to explain WHY there are no ADDM results.
 *
 * connectionId = 'demo' returns mock probe data.
 */
router.post('/:connectionId/empty-state-probes', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      // Demo: simulate a healthy SE2 instance with AWR disabled
      return res.json({
        awr: { snap_count: 0, oldest_snap: null, newest_snap: null },
        license: { value: 'DIAGNOSTIC+TUNING' },
        lastTask: { last_completion: null, total_completed: 0 },
        edition: { banner: 'Oracle Database 19c Standard Edition 2 Release 19.0.0.0.0' },
        errors: {},
      });
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const conn = await getConnectionForAdvisor(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    if (conn.connection_type === 'proxy') {
      return res.status(400).json({ error: 'Empty-state probes require a direct TCP connection.', code: 'PROXY_NOT_SUPPORTED' });
    }

    const connParams = {
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: conn.service_name,
      username:    conn.username,
      password:    decrypt(conn.encrypted_password),
    };

    const probeResult = await runEmptyStateProbes(connParams);
    res.json(probeResult);
  } catch (err) {
    console.error('[advisor] empty-state probes failed:', err);
    res.status(500).json({ error: 'Failed to run empty-state probes' });
  }
});

module.exports = router;
