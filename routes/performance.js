/**
 * routes/performance.js — Performance tab: Top SQL + Wait Events + Blocking Sessions + Segment Hotspots.
 *
 * Owns: /api/performance/* endpoints — all deep performance analysis (top-sql,
 *       wait-events, blocking-sessions, segment-hotspots).
 * Does NOT own: auth state, Oracle connection storage, health check execution,
 *               or any other tab's data.
 *
 * Mounted at: /api/performance (see server.js)
 *
 * Routes:
 *   GET /api/performance/:connectionId/top-sql
 *     Top 25 SQL statements by elapsed_time/executions (24h). AI fix per statement.
 *   GET /api/performance/:connectionId/wait-events
 *     ASH wait class distribution + top 10 wait events (1h or 24h window).
 *   GET /api/performance/:connectionId/blocking-sessions
 *     Real-time blocking tree: blocker→waiter(s) with SQL, lock type, wait time.
 *   GET /api/performance/:connectionId/segment-hotspots
 *     Top 20 segments by logical reads from V$SEGMENT_STATISTICS.
 */

'use strict';

const express = require('express');
const OpenAI  = require('openai');

const { requireAuth } = require('../middleware/auth');
const { getCachedFix, upsertFixCache, purgeStaleFixes, getConnectionForPerf, getUserForPerf } = require('../db/performance');
const { decrypt }                       = require('../crypto-utils');

const router = express.Router();

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function getDemoTopSql() {
  const now = Date.now();
  return {
    sql_statements: [
      {
        sql_id: 'abc1234xyz01',
        plan_hash_value: 2847361920,
        executions: 1523,
        elapsed_per_exec_ms: 4850,
        buffer_gets_per_exec: 182400,
        disk_reads_per_exec: 12300,
        cpu_per_exec_ms: 3200,
        parsing_schema_name: 'APPS',
        sql_text: 'SELECT o.order_id, o.customer_id, ol.line_id, p.product_name, p.unit_price FROM oe_order_headers_all o, oe_order_lines_all ol, mtl_system_items_b p WHERE o.header_id = ol.header_id AND ol.inventory_item_id = p.inventory_item_id AND o.creation_date > :date1',
        plan: [
          { operation: 'SELECT STATEMENT',   options: '',              object_name: null,                cost: 98450, cardinality: 1    },
          { operation: 'HASH JOIN',           options: '',              object_name: null,                cost: 98450, cardinality: 8423 },
          { operation: 'TABLE ACCESS',        options: 'FULL',          object_name: 'OE_ORDER_LINES_ALL', cost: 45200, cardinality: 98230 },
          { operation: 'TABLE ACCESS',        options: 'FULL',          object_name: 'OE_ORDER_HEADERS_ALL', cost: 22100, cardinality: 45100 },
          { operation: 'TABLE ACCESS',        options: 'BY INDEX ROWID', object_name: 'MTL_SYSTEM_ITEMS_B', cost: 3,     cardinality: 1    },
        ],
        ai_fix: {
          fix_type: 'index',
          fix_sql: 'CREATE INDEX idx_oola_hdr_item ON oe_order_lines_all (header_id, inventory_item_id) TABLESPACE APPS_TS_TX_IDX;',
          rationale: 'Eliminates full table scan on OE_ORDER_LINES_ALL — join column header_id has no usable index',
        },
        from_cache: false,
      },
      {
        sql_id: 'def5678uvw02',
        plan_hash_value: 1938472650,
        executions: 8920,
        elapsed_per_exec_ms: 1240,
        buffer_gets_per_exec: 43200,
        disk_reads_per_exec: 0,
        cpu_per_exec_ms: 980,
        parsing_schema_name: 'APPS',
        sql_text: 'SELECT /*+ NO_INDEX */ wf.notification_id, wf.status, wf.from_user, wf.to_user FROM wf_notifications wf WHERE wf.status = :status AND wf.begin_date < :cutoff ORDER BY wf.begin_date',
        plan: [
          { operation: 'SELECT STATEMENT', options: '',     object_name: null,             cost: 31200, cardinality: 1 },
          { operation: 'SORT',            options: 'ORDER BY', object_name: null,           cost: 31200, cardinality: 4500 },
          { operation: 'TABLE ACCESS',    options: 'FULL', object_name: 'WF_NOTIFICATIONS', cost: 22400, cardinality: 4500 },
        ],
        ai_fix: {
          fix_type: 'hint',
          fix_sql: 'SELECT /*+ INDEX(wf WF_NOTIFICATIONS_N1) */ wf.notification_id, wf.status, wf.from_user, wf.to_user FROM wf_notifications wf WHERE wf.status = :status AND wf.begin_date < :cutoff ORDER BY wf.begin_date',
          rationale: 'Force WF_NOTIFICATIONS_N1 (status, begin_date) — NO_INDEX hint is suppressing a highly selective index',
        },
        from_cache: false,
      },
      {
        sql_id: 'ghi9012rst03',
        plan_hash_value: 3719283640,
        executions: 342,
        elapsed_per_exec_ms: 18700,
        buffer_gets_per_exec: 892000,
        disk_reads_per_exec: 48200,
        cpu_per_exec_ms: 11200,
        parsing_schema_name: 'APPS',
        sql_text: 'SELECT gl.segment1, gl.segment2, gl.segment3, SUM(jl.entered_dr - jl.entered_cr) balance FROM gl_je_headers gl, gl_je_lines jl WHERE gl.je_header_id = jl.je_header_id AND gl.period_name = :period AND gl.ledger_id = :ledger GROUP BY gl.segment1, gl.segment2, gl.segment3',
        plan: [
          { operation: 'SELECT STATEMENT', options: '',        object_name: null,          cost: 212000, cardinality: 1 },
          { operation: 'SORT',             options: 'GROUP BY', object_name: null,          cost: 212000, cardinality: 82000 },
          { operation: 'HASH JOIN',        options: '',         object_name: null,          cost: 187000, cardinality: 82000 },
          { operation: 'TABLE ACCESS',     options: 'FULL',     object_name: 'GL_JE_HEADERS', cost: 42000, cardinality: 18000 },
          { operation: 'TABLE ACCESS',     options: 'FULL',     object_name: 'GL_JE_LINES',   cost: 98000, cardinality: 420000 },
        ],
        ai_fix: {
          fix_type: 'index',
          fix_sql: 'CREATE INDEX idx_glh_period_ledger ON gl_je_headers (ledger_id, period_name, je_header_id) TABLESPACE APPS_TS_TX_IDX;\nCREATE INDEX idx_gll_header ON gl_je_lines (je_header_id) TABLESPACE APPS_TS_TX_IDX;',
          rationale: 'Both tables full-scanned on high-cardinality join; composite index on ledger_id+period_name converts to range scan',
        },
        from_cache: false,
      },
    ],
    fetched_at: new Date(now).toISOString(),
    is_demo: true,
  };
}

// ─── Oracle: query V$SQL + DBA_HIST_SQLSTAT ───────────────────────────────────
//
// Prefers AWR data (DBA_HIST_SQLSTAT) when available.  Falls back to V$SQL
// in-memory data for SE/SE2 editions that lack Diagnostics Pack.

const TOP_SQL_QUERY = `
SELECT
  s.sql_id,
  s.plan_hash_value,
  s.executions,
  ROUND(s.elapsed_time / NULLIF(s.executions, 0) / 1000, 2)  AS elapsed_per_exec_ms,
  ROUND(s.buffer_gets / NULLIF(s.executions, 0))              AS buffer_gets_per_exec,
  ROUND(s.disk_reads  / NULLIF(s.executions, 0))              AS disk_reads_per_exec,
  ROUND(s.cpu_time    / NULLIF(s.executions, 0) / 1000, 2)   AS cpu_per_exec_ms,
  s.parsing_schema_name,
  SUBSTR(s.sql_text, 1, 200)                                  AS sql_text,
  s.elapsed_time / NULLIF(s.executions, 0)                    AS sort_key
FROM v$sql s
WHERE s.executions > 0
  AND s.parsing_schema_name NOT IN ('SYS','SYSTEM','DBSNMP','ORACLE_OCM')
ORDER BY sort_key DESC NULLS LAST
FETCH FIRST 25 ROWS ONLY
`;

// AWR-based query (requires Diagnostics Pack; 24h window)
const TOP_SQL_AWR_QUERY = `
SELECT
  h.sql_id,
  h.plan_hash_value,
  SUM(h.executions_delta)                                                          AS executions,
  ROUND(SUM(h.elapsed_time_delta) / NULLIF(SUM(h.executions_delta), 0) / 1000, 2) AS elapsed_per_exec_ms,
  ROUND(SUM(h.buffer_gets_delta)  / NULLIF(SUM(h.executions_delta), 0))            AS buffer_gets_per_exec,
  ROUND(SUM(h.disk_reads_delta)   / NULLIF(SUM(h.executions_delta), 0))            AS disk_reads_per_exec,
  ROUND(SUM(h.cpu_time_delta)     / NULLIF(SUM(h.executions_delta), 0) / 1000, 2)  AS cpu_per_exec_ms,
  MAX(s.parsing_schema_name)                                                        AS parsing_schema_name,
  MAX(SUBSTR(s.sql_text, 1, 200))                                                   AS sql_text,
  SUM(h.elapsed_time_delta) / NULLIF(SUM(h.executions_delta), 0)                   AS sort_key
FROM dba_hist_sqlstat h
JOIN v$sql s ON s.sql_id = h.sql_id AND s.plan_hash_value = h.plan_hash_value
JOIN dba_hist_snapshot sn ON sn.snap_id = h.snap_id AND sn.dbid = h.dbid
WHERE sn.end_interval_time >= SYSTIMESTAMP - INTERVAL '24' HOUR
  AND h.executions_delta > 0
  AND s.parsing_schema_name NOT IN ('SYS','SYSTEM','DBSNMP','ORACLE_OCM')
GROUP BY h.sql_id, h.plan_hash_value
ORDER BY sort_key DESC NULLS LAST
FETCH FIRST 25 ROWS ONLY
`;

// Fetch execution plan steps from DBA_HIST_SQL_PLAN
const PLAN_QUERY = `
SELECT operation, options, object_name, cost, cardinality
FROM dba_hist_sql_plan
WHERE sql_id = :sqlId
  AND plan_hash_value = :planHash
ORDER BY id
FETCH FIRST 20 ROWS ONLY
`;

// Fallback plan from V$SQL_PLAN (always available)
const PLAN_QUERY_LIVE = `
SELECT operation, options, object_name, cost, cardinality
FROM v$sql_plan
WHERE sql_id = :sqlId
  AND plan_hash_value = :planHash
ORDER BY id
FETCH FIRST 20 ROWS ONLY
`;

async function fetchTopSqlFromOracle(connParams) {
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

    // Try AWR first (Diagnostics Pack required)
    let rows;
    let usedAwr = false;
    try {
      const r = await connection.execute(TOP_SQL_AWR_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      rows = r.rows;
      usedAwr = true;
    } catch {
      // Falls back to V$SQL in-memory stats
      const r = await connection.execute(TOP_SQL_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      rows = r.rows;
    }

    // For each top-SQL row, fetch the execution plan
    const results = [];
    for (const row of (rows || [])) {
      let plan = [];
      // Try AWR plan, then live V$SQL_PLAN
      const planSource = usedAwr ? PLAN_QUERY : PLAN_QUERY_LIVE;
      try {
        const pr = await connection.execute(
          planSource,
          { sqlId: row.SQL_ID || row.sql_id, planHash: row.PLAN_HASH_VALUE || row.plan_hash_value },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        plan = (pr.rows || []).map(p => ({
          operation:   p.OPERATION   || p.operation   || '',
          options:     p.OPTIONS     || p.options     || '',
          object_name: p.OBJECT_NAME || p.object_name || null,
          cost:        p.COST        || p.cost        || null,
          cardinality: p.CARDINALITY || p.cardinality || null,
        }));
      } catch { /* plan unavailable — use empty */ }

      results.push({
        sql_id:              row.SQL_ID              || row.sql_id,
        plan_hash_value:     row.PLAN_HASH_VALUE     || row.plan_hash_value,
        executions:          Number(row.EXECUTIONS   || row.executions   || 0),
        elapsed_per_exec_ms: Number(row.ELAPSED_PER_EXEC_MS || row.elapsed_per_exec_ms || 0),
        buffer_gets_per_exec: Number(row.BUFFER_GETS_PER_EXEC || row.buffer_gets_per_exec || 0),
        disk_reads_per_exec:  Number(row.DISK_READS_PER_EXEC  || row.disk_reads_per_exec  || 0),
        cpu_per_exec_ms:      Number(row.CPU_PER_EXEC_MS      || row.cpu_per_exec_ms      || 0),
        parsing_schema_name:  row.PARSING_SCHEMA_NAME || row.parsing_schema_name || '',
        sql_text:             row.SQL_TEXT            || row.sql_text            || '',
        plan,
        ai_fix: null,
        from_cache: false,
      });
    }

    return results;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── AI fix generation ────────────────────────────────────────────────────────

const AI_SYSTEM = `You are a senior Oracle DBA. Your ONLY job is to output JSON — no prose, no markdown, no explanation.

For each SQL + plan + runtime stats given, output exactly:
{
  "fix_type": "index" | "hint" | "rewrite",
  "fix_sql": "<the complete CREATE INDEX statement, hint block, or rewrite snippet>",
  "rationale_one_line": "<15 words max: what the fix does and why>"
}

Rules:
1. fix_sql must be copy-pasteable into sqlplus immediately — no placeholders.
2. Prefer CREATE INDEX for full-table-scan or index-range-scan inefficiencies (the dominant case).
3. Use /*+ hint */ block for join-order or access-path problems where a new index is inappropriate.
4. Use rewrite only when the SQL itself is algorithmically wrong (cartesian join, missing GROUP BY, etc.).
5. NEVER return "check the execution plan", "review statistics", or any vague advice.
6. If you cannot produce a concrete fix, output fix_type="hint" and fix_sql="-- No deterministic fix: insufficient plan detail" and a one-line rationale.`;

async function generateAiFix(sqlText, plan, stats) {
  let openai;
  try {
    openai = new OpenAI();
  } catch {
    return null;
  }

  const prompt = `SQL TEXT (first 200 chars):
${sqlText}

RUNTIME STATS:
  Executions:        ${stats.executions}
  Elapsed/exec (ms): ${stats.elapsed_per_exec_ms}
  Buffer gets/exec:  ${stats.buffer_gets_per_exec}
  Disk reads/exec:   ${stats.disk_reads_per_exec}
  CPU/exec (ms):     ${stats.cpu_per_exec_ms}
  Schema:            ${stats.parsing_schema_name}

EXECUTION PLAN (${plan.length} steps):
${plan.map((p, i) => `  ${i}. ${p.operation} ${p.options || ''} ${p.object_name ? `ON ${p.object_name}` : ''} cost=${p.cost ?? '?'} card=${p.cardinality ?? '?'}`).join('\n')}

Return JSON only.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 400,
    });

    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate: reject vague outputs that slip through
    const vague = ['check the execution plan', 'review statistics', 'gather statistics', 'consult a dba'];
    const fixLower = (parsed.fix_sql || '').toLowerCase();
    if (vague.some(v => fixLower.includes(v))) {
      return null; // Force re-prompt or skip
    }

    return {
      fix_type: parsed.fix_type || 'hint',
      fix_sql:  parsed.fix_sql  || '',
      rationale: parsed.rationale_one_line || '',
    };
  } catch (e) {
    console.error('[performance] AI fix generation failed:', e.message);
    return null;
  }
}

// ─── ROUTE ───────────────────────────────────────────────────────────────────

/**
 * GET /api/performance/:connectionId/top-sql
 *
 * Returns top 25 SQL statements for the connection, each with:
 *   - runtime stats (elapsed, buffer gets, disk reads, CPU)
 *   - execution plan steps
 *   - AI-generated fix (CREATE INDEX / hint / rewrite) — cached 24h
 *
 * connectionId = 'demo' returns demo data without Oracle access.
 */
router.get('/:connectionId/top-sql', requireAuth, async (req, res) => {
  try {
    // Demo mode
    if (req.params.connectionId === 'demo') {
      return res.json(getDemoTopSql());
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) {
      return res.status(400).json({ error: 'Invalid connection ID' });
    }

    // Load connection (verify ownership)
    const conn = await getConnectionForPerf(connId, req.user.id);
    if (!conn) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    if (conn.connection_type === 'proxy') {
      return res.status(400).json({ error: 'Performance tab requires a direct TCP connection, not a proxy connection.' });
    }

    const connParams = {
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: conn.service_name,
      username:    conn.username,
      password:    decrypt(conn.encrypted_password),
    };

    // Purge stale cache rows opportunistically (fire-and-forget)
    purgeStaleFixes().catch(() => {});

    // Fetch live Oracle data
    const statements = await fetchTopSqlFromOracle(connParams);

    // Attach AI fixes (check cache first, generate if missing)
    const CONCURRENCY = 3; // limit parallel AI calls
    for (let i = 0; i < statements.length; i += CONCURRENCY) {
      const batch = statements.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (stmt) => {
        const cached = await getCachedFix(stmt.sql_id, stmt.plan_hash_value);
        if (cached) {
          stmt.ai_fix = cached;
          stmt.from_cache = true;
          return;
        }

        const fix = await generateAiFix(stmt.sql_text, stmt.plan, stmt);
        if (fix) {
          stmt.ai_fix = fix;
          stmt.from_cache = false;
          // Persist to cache (non-blocking)
          upsertFixCache({
            sqlId:          stmt.sql_id,
            planHashValue:  String(stmt.plan_hash_value),
            fixType:        fix.fix_type,
            fixSql:         fix.fix_sql,
            rationale:      fix.rationale,
            sqlTextPrefix:  stmt.sql_text,
          }).catch(() => {});
        }
      }));
    }

    res.json({
      sql_statements: statements,
      fetched_at: new Date().toISOString(),
      is_demo: false,
    });
  } catch (err) {
    console.error('[performance] Error fetching top SQL:', err);
    res.status(500).json({ error: 'Failed to fetch performance data' });
  }
});

// ─── Demo data: Wait Events ───────────────────────────────────────────────────

function getDemoWaitEvents(window_h) {
  return {
    window_hours: window_h || 1,
    is_demo: true,
    wait_classes: [
      { wait_class: 'CPU', pct_db_time: 38.4 },
      { wait_class: 'User I/O', pct_db_time: 27.1 },
      { wait_class: 'Concurrency', pct_db_time: 14.6 },
      { wait_class: 'System I/O', pct_db_time: 8.3 },
      { wait_class: 'Commit', pct_db_time: 5.2 },
      { wait_class: 'Application', pct_db_time: 3.9 },
      { wait_class: 'Network', pct_db_time: 1.8 },
      { wait_class: 'Configuration', pct_db_time: 0.7 },
    ],
    top_events: [
      {
        event: 'db file sequential read',
        wait_class: 'User I/O',
        count: 142834,
        avg_wait_ms: 4.2,
        total_wait_ms: 600103,
        top_sql_id: 'abc1234xyz01',
        playbook: {
          title: 'Index I/O — single-block reads',
          steps: [
            "Identify top indexes by logical reads: SELECT * FROM V$SEGMENT_STATISTICS WHERE STATISTIC_NAME='logical reads' ORDER BY VALUE DESC FETCH FIRST 10 ROWS ONLY",
            "Check for range scan on high-clustering-factor index: SELECT INDEX_NAME, CLUSTERING_FACTOR, NUM_ROWS FROM DBA_INDEXES WHERE TABLE_NAME='<table>'",
            "Consider IOT (Index-Organized Table) or rebuilding the index with COMPRESS to reduce I/O per row",
            "Pinpoint contributing SQL: SELECT SQL_ID, COUNT(*) FROM V$ACTIVE_SESSION_HISTORY WHERE EVENT='db file sequential read' AND SAMPLE_TIME > SYSDATE-1/24 GROUP BY SQL_ID ORDER BY COUNT(*) DESC"
          ]
        }
      },
      {
        event: 'enq: TX - row lock contention',
        wait_class: 'Application',
        count: 8941,
        avg_wait_ms: 182.4,
        total_wait_ms: 1629874,
        top_sql_id: 'def5678uvw02',
        playbook: {
          title: 'TX row lock — find and kill blocker',
          steps: [
            "Find blocking session: SELECT s.sid, s.serial#, s.username, q.sql_text FROM v$session s JOIN v$sql q ON q.sql_id=s.sql_id WHERE s.blocking_session IS NOT NULL",
            "Kill blocker (DBA only): ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE;",
            "Review commit frequency — batch DML operations should commit every N rows to release locks sooner",
            "Add SELECT … FOR UPDATE SKIP LOCKED pattern in APEX/Forms code if optimistic locking is acceptable"
          ]
        }
      },
      {
        event: 'log file sync',
        wait_class: 'Commit',
        count: 49233,
        avg_wait_ms: 3.1,
        total_wait_ms: 152622,
        top_sql_id: null,
        playbook: {
          title: 'Redo sync — commit batching and redo sizing',
          steps: [
            "Check redo log size: SELECT GROUP#, MEMBERS, BYTES/1048576 MB FROM V$LOG",
            "Logs under 500MB on busy systems? Resize: ALTER DATABASE ADD LOGFILE GROUP 4 SIZE 1G",
            "Check redo write latency: SELECT METRIC_NAME, VALUE FROM V$SYSMETRIC WHERE METRIC_NAME='Redo Writes Per Sec'",
            "Batch commits: wrap DML loops in BULK COLLECT / FORALL and commit every 500–1000 rows instead of per-row"
          ]
        }
      },
      {
        event: 'library cache: mutex X',
        wait_class: 'Concurrency',
        count: 31200,
        avg_wait_ms: 8.7,
        total_wait_ms: 271440,
        top_sql_id: 'ghi9012rst03',
        playbook: {
          title: 'Library cache mutex — bind variable & cursor sharing',
          steps: [
            "Check bind variable peeking status: SELECT NAME, VALUE FROM V$PARAMETER WHERE NAME IN ('cursor_sharing','_optim_peek_user_binds')",
            "Find hard-parsing culprits: SELECT SQL_ID, PARSE_CALLS, EXECUTIONS, SQL_TEXT FROM V$SQL WHERE PARSE_CALLS > EXECUTIONS * 0.9 ORDER BY PARSE_CALLS DESC FETCH FIRST 10 ROWS ONLY",
            "Set CURSOR_SHARING=FORCE as a temporary fix (test in staging first): ALTER SYSTEM SET CURSOR_SHARING=FORCE SCOPE=BOTH",
            "Long-term: fix application to use bind variables. Check for literals using: SELECT COUNT(*) FROM V$SQL WHERE FORCE_MATCHING_SIGNATURE != 0 AND FORCE_MATCHING_SIGNATURE IN (SELECT FORCE_MATCHING_SIGNATURE FROM V$SQL GROUP BY FORCE_MATCHING_SIGNATURE HAVING COUNT(*)>10)"
          ]
        }
      },
      {
        event: 'db file scattered read',
        wait_class: 'User I/O',
        count: 22180,
        avg_wait_ms: 6.8,
        total_wait_ms: 150824,
        top_sql_id: 'abc1234xyz01',
        playbook: {
          title: 'Multi-block reads — full table scan optimization',
          steps: [
            "Confirm which SQL drives FTS: SELECT SQL_ID, COUNT(*) FROM V$ACTIVE_SESSION_HISTORY WHERE EVENT='db file scattered read' AND SAMPLE_TIME > SYSDATE-1/24 GROUP BY SQL_ID ORDER BY 2 DESC",
            "Check if FTS is intentional (bulk loads, analytics) or accidental (missing index)",
            "Increase DB_FILE_MULTIBLOCK_READ_COUNT for intentional scans: ALTER SYSTEM SET DB_FILE_MULTIBLOCK_READ_COUNT=128",
            "For accidental FTS: add a covering index on the WHERE column. Use execution plan to confirm index range scan."
          ]
        }
      },
    ],
    fetched_at: new Date().toISOString(),
  };
}

// ─── Demo data: Blocking Sessions ─────────────────────────────────────────────

function getDemoBlockingSessions() {
  return {
    is_demo: true,
    fetched_at: new Date().toISOString(),
    blocking_tree: [
      {
        blocker: {
          sid: 142,
          serial_num: 8831,
          username: 'APPS',
          status: 'ACTIVE',
          sql_id: 'abc1234xyz01',
          sql_text: 'UPDATE oe_order_headers_all SET flow_status_code = :1 WHERE header_id = :2',
          wait_event: 'SQL*Net message from client',
          object_name: 'OE_ORDER_HEADERS_ALL',
          lock_mode: 'Exclusive',
        },
        waiters: [
          {
            sid: 201,
            serial_num: 3441,
            username: 'APPS',
            sql_id: 'def5678uvw02',
            sql_text: 'UPDATE oe_order_headers_all SET booked_flag = :1 WHERE header_id = :2',
            object_name: 'OE_ORDER_HEADERS_ALL',
            lock_mode: 'Share',
            wait_seconds: 184,
            sev1: false,
          },
          {
            sid: 219,
            serial_num: 5512,
            username: 'SYSADMIN',
            sql_id: 'ghi9012rst03',
            sql_text: 'SELECT * FROM oe_order_headers_all WHERE header_id = :1 FOR UPDATE',
            object_name: 'OE_ORDER_HEADERS_ALL',
            lock_mode: 'Share',
            wait_seconds: 172,
            sev1: false,
            sub_waiters: [
              {
                sid: 305,
                serial_num: 9921,
                username: 'APPS',
                sql_id: 'jkl3456pqr04',
                sql_text: 'UPDATE oe_order_lines_all SET shipped_quantity = :1 WHERE header_id = :2',
                object_name: 'OE_ORDER_LINES_ALL',
                lock_mode: 'Share',
                wait_seconds: 165,
                sev1: true,
              }
            ]
          }
        ]
      }
    ],
  };
}

// ─── Demo data: Segment Hotspots ──────────────────────────────────────────────

function getDemoSegmentHotspots() {
  return {
    is_demo: true,
    fetched_at: new Date().toISOString(),
    segments: [
      { owner: 'APPS', segment_name: 'OE_ORDER_LINES_ALL', segment_type: 'TABLE', logical_reads: 8423921, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'GL_JE_LINES', segment_type: 'TABLE', logical_reads: 6821034, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'WF_NOTIFICATIONS', segment_type: 'TABLE', logical_reads: 5194820, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'MTL_TRANSACTION_ACCOUNTS', segment_type: 'TABLE', logical_reads: 4872310, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'OE_ORDER_HEADERS_ALL', segment_type: 'TABLE', logical_reads: 3941820, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'MTL_SYSTEM_ITEMS_B', segment_type: 'TABLE', logical_reads: 2814330, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'OE_ORDER_LINES_ALL_N1', segment_type: 'INDEX', logical_reads: 2341290, ai_recommendation: null },
      { owner: 'APPS', segment_name: 'PO_REQUISITION_LINES_ALL', segment_type: 'TABLE', logical_reads: 1982440, ai_recommendation: null },
    ],
  };
}

// ─── Oracle: wait events query (ASH) ─────────────────────────────────────────

const WAIT_CLASS_QUERY = `
SELECT
  CASE WHEN wait_class = 'CPU' OR session_state = 'ON CPU' THEN 'CPU' ELSE wait_class END AS wait_class,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct_db_time
FROM v$active_session_history
WHERE sample_time >= SYSDATE - :windowH / 24
  AND session_type = 'FOREGROUND'
GROUP BY CASE WHEN wait_class = 'CPU' OR session_state = 'ON CPU' THEN 'CPU' ELSE wait_class END
ORDER BY COUNT(*) DESC
FETCH FIRST 10 ROWS ONLY
`;

const TOP_EVENTS_QUERY = `
SELECT
  event,
  wait_class,
  COUNT(*)                                  AS evt_count,
  ROUND(AVG(time_waited) / 1000, 2)         AS avg_wait_ms,
  ROUND(SUM(time_waited) / 1000)            AS total_wait_ms,
  MAX(sql_id)                               AS top_sql_id
FROM v$active_session_history
WHERE sample_time >= SYSDATE - :windowH / 24
  AND session_state = 'WAITING'
  AND event IS NOT NULL
  AND event NOT IN ('SQL*Net message from client','SQL*Net message to client','rdbms ipc message','virtual circuit status')
GROUP BY event, wait_class
ORDER BY SUM(time_waited) DESC NULLS LAST
FETCH FIRST 10 ROWS ONLY
`;

// ─── Oracle: blocking sessions query ─────────────────────────────────────────

const BLOCKERS_QUERY = `
SELECT
  blocker.sid                   AS blocker_sid,
  blocker.serial#               AS blocker_serial,
  blocker.username              AS blocker_user,
  blocker.status                AS blocker_status,
  blocker.sql_id                AS blocker_sql_id,
  SUBSTR(bsql.sql_text,1,150)   AS blocker_sql_text,
  blocker.event                 AS blocker_event,
  lo.object_name                AS blocked_object,
  DECODE(l.lmode, 1,'None', 2,'Row Share', 3,'Row Exclusive', 4,'Share Update', 5,'Share', 6,'Share Row Exclusive', 7,'Exclusive', TO_CHAR(l.lmode)) AS lock_mode,
  waiter.sid                    AS waiter_sid,
  waiter.serial#                AS waiter_serial,
  waiter.username               AS waiter_user,
  waiter.sql_id                 AS waiter_sql_id,
  SUBSTR(wsql.sql_text,1,150)   AS waiter_sql_text,
  ROUND(waiter.seconds_in_wait) AS wait_seconds,
  waiter.blocking_session       AS waiter_blocking_sid
FROM v$session waiter
JOIN v$session blocker ON blocker.sid = waiter.blocking_session
LEFT JOIN v$sql bsql ON bsql.sql_id = blocker.sql_id AND bsql.child_number = 0
LEFT JOIN v$sql wsql ON wsql.sql_id = waiter.sql_id AND wsql.child_number = 0
LEFT JOIN v$lock l ON l.sid = blocker.sid AND l.block = 1
LEFT JOIN dba_objects lo ON lo.object_id = l.id1
WHERE waiter.blocking_session IS NOT NULL
ORDER BY blocker.sid, wait_seconds DESC
FETCH FIRST 50 ROWS ONLY
`;

// ─── Oracle: segment hotspots query ──────────────────────────────────────────

const SEGMENT_HOTSPOTS_QUERY = `
SELECT
  owner,
  segment_name,
  segment_type,
  SUM(value) AS logical_reads
FROM v$segment_statistics
WHERE statistic_name = 'logical reads'
  AND owner NOT IN ('SYS','SYSTEM','DBSNMP','ORACLE_OCM','OUTLN','XDB','CTXSYS','EXFSYS','MDSYS','ORDSYS')
GROUP BY owner, segment_name, segment_type
ORDER BY logical_reads DESC
FETCH FIRST 20 ROWS ONLY
`;

// ─── AI: wait event playbook generation ──────────────────────────────────────

const PLAYBOOK_SYSTEM = `You are a senior Oracle DBA. Output only JSON. For a given wait event name and stats, generate a concrete tuning playbook.

Output exactly:
{
  "title": "<8 words max: what this wait means>",
  "steps": ["<exact SQL or ALTER SYSTEM command>", "<second step>", "<third step>", "<optional fourth step>"]
}

Rules:
- Each step must be a concrete, copy-pasteable SQL query or DBA command. No vague advice.
- Use real Oracle V$ views, DBA_ views, AWR queries, or ALTER SYSTEM statements.
- Focus on the specific event name provided. Do not generalize.
- Steps array: 3 to 4 entries max.`;

async function generatePlaybook(event, waitClass, avgWaitMs, totalWaitMs) {
  let openai;
  try { openai = new OpenAI(); } catch { return null; }

  const prompt = `Oracle wait event: "${event}"
Wait class: ${waitClass}
Avg wait: ${avgWaitMs} ms
Total time waited (last window): ${totalWaitMs} ms

Generate a concrete DBA tuning playbook. JSON only.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: PLAYBOOK_SYSTEM },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 600,
    });
    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[performance] playbook generation failed:', e.message);
    return null;
  }
}

// ─── AI: segment recommendation ──────────────────────────────────────────────

const SEG_SYSTEM = `You are a senior Oracle DBA. Output only JSON. For a given hot segment, give a single concrete recommendation.

Output exactly:
{
  "recommendation": "<one concrete action — CREATE INDEX, partition the table, convert to IOT, or specific SQL to run>",
  "rationale": "<10 words max: why>"
}

Rules:
- recommendation must be copy-pasteable SQL or a specific DBA action.
- If segment_type is INDEX, focus on rebuild, compress, or covering index.
- If segment_type is TABLE, focus on partitioning, IOT, or result cache.
- Never say "review" or "analyze" without giving the exact query to run.`;

async function generateSegmentRec(owner, segmentName, segmentType, logicalReads) {
  let openai;
  try { openai = new OpenAI(); } catch { return null; }

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SEG_SYSTEM },
        { role: 'user',   content: `Segment: ${owner}.${segmentName} (${segmentType})\nLogical reads: ${logicalReads.toLocaleString()}\nJSON only.` },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });
    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('[performance] segment rec failed:', e.message);
    return null;
  }
}

// ─── Helper: get connection params ───────────────────────────────────────────

async function resolveConnParams(connId, userId) {
  const conn = await getConnectionForPerf(connId, userId);
  if (!conn) return null;
  if (conn.connection_type === 'proxy') return { error: 'proxy' };
  return {
    host:        conn.host,
    port:        conn.port || 1521,
    serviceName: conn.service_name,
    username:    conn.username,
    password:    decrypt(conn.encrypted_password),
  };
}

// ─── ROUTE: wait-events ────────────────────────────────────────────────────────

/**
 * GET /api/performance/:connectionId/wait-events?window=1
 *
 * Returns ASH wait class distribution + top 10 wait events with AI playbooks.
 * window query param: 1 (1h, default) or 24 (24h).
 */
router.get('/:connectionId/wait-events', requireAuth, async (req, res) => {
  try {
    const windowH = Number(req.query.window) === 24 ? 24 : 1;

    if (req.params.connectionId === 'demo') {
      return res.json(getDemoWaitEvents(windowH));
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const params = await resolveConnParams(connId, req.user.id);
    if (!params) return res.status(404).json({ error: 'Connection not found' });
    if (params.error === 'proxy') return res.status(400).json({ error: 'Performance tab requires a direct TCP connection.' });

    const oracledb = require('oracledb');
    const connectString = `${params.host}:${params.port}/${params.serviceName}`;
    let connection;
    try {
      connection = await oracledb.getConnection({ user: params.username, password: params.password, connectString, connectTimeout: 30 });

      // Wait class distribution
      let waitClasses = [];
      try {
        const r = await connection.execute(WAIT_CLASS_QUERY, { windowH }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        waitClasses = (r.rows || []).map(row => ({
          wait_class: row.WAIT_CLASS || row.wait_class,
          pct_db_time: Number(row.PCT_DB_TIME || row.pct_db_time || 0),
        }));
      } catch (e) {
        console.error('[performance] wait class query failed:', e.message);
      }

      // Top 10 wait events
      let topEvents = [];
      try {
        const r = await connection.execute(TOP_EVENTS_QUERY, { windowH }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        topEvents = (r.rows || []).map(row => ({
          event:          row.EVENT || row.event || '',
          wait_class:     row.WAIT_CLASS || row.wait_class || '',
          count:          Number(row.EVT_COUNT || row.evt_count || 0),
          avg_wait_ms:    Number(row.AVG_WAIT_MS || row.avg_wait_ms || 0),
          total_wait_ms:  Number(row.TOTAL_WAIT_MS || row.total_wait_ms || 0),
          top_sql_id:     row.TOP_SQL_ID || row.top_sql_id || null,
          playbook:       null,
        }));
      } catch (e) {
        console.error('[performance] top events query failed:', e.message);
      }

      // Generate AI playbooks for top 5 events (concurrency limited)
      const CONCURRENCY = 3;
      for (let i = 0; i < Math.min(topEvents.length, 5); i += CONCURRENCY) {
        const batch = topEvents.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (ev) => {
          ev.playbook = await generatePlaybook(ev.event, ev.wait_class, ev.avg_wait_ms, ev.total_wait_ms);
        }));
      }

      res.json({
        window_hours: windowH,
        is_demo: false,
        wait_classes: waitClasses,
        top_events: topEvents,
        fetched_at: new Date().toISOString(),
      });
    } finally {
      if (connection) try { await connection.close(); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error('[performance] Error fetching wait events:', err);
    res.status(500).json({ error: 'Failed to fetch wait event data' });
  }
});

// ─── ROUTE: blocking-sessions ──────────────────────────────────────────────────

/**
 * GET /api/performance/:connectionId/blocking-sessions
 *
 * Returns real-time blocking tree. Sev-1 flagged when chain depth >= 3.
 */
router.get('/:connectionId/blocking-sessions', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      return res.json(getDemoBlockingSessions());
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const params = await resolveConnParams(connId, req.user.id);
    if (!params) return res.status(404).json({ error: 'Connection not found' });
    if (params.error === 'proxy') return res.status(400).json({ error: 'Performance tab requires a direct TCP connection.' });

    const oracledb = require('oracledb');
    const connectString = `${params.host}:${params.port}/${params.serviceName}`;
    let connection;
    try {
      connection = await oracledb.getConnection({ user: params.username, password: params.password, connectString, connectTimeout: 30 });

      let rows = [];
      try {
        const r = await connection.execute(BLOCKERS_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        rows = r.rows || [];
      } catch (e) {
        console.error('[performance] blocking query failed:', e.message);
      }

      // Build blocking tree from flat rows
      const blockerMap = new Map();
      for (const row of rows) {
        const bSid = Number(row.BLOCKER_SID || row.blocker_sid);
        if (!blockerMap.has(bSid)) {
          blockerMap.set(bSid, {
            blocker: {
              sid:          bSid,
              serial_num:   Number(row.BLOCKER_SERIAL || row.blocker_serial || 0),
              username:     row.BLOCKER_USER || row.blocker_user || '',
              status:       row.BLOCKER_STATUS || row.blocker_status || '',
              sql_id:       row.BLOCKER_SQL_ID || row.blocker_sql_id || null,
              sql_text:     row.BLOCKER_SQL_TEXT || row.blocker_sql_text || '',
              wait_event:   row.BLOCKER_EVENT || row.blocker_event || '',
              object_name:  row.BLOCKED_OBJECT || row.blocked_object || null,
              lock_mode:    row.LOCK_MODE || row.lock_mode || '',
            },
            waiters: [],
          });
        }
        const wSid = Number(row.WAITER_SID || row.waiter_sid);
        const waitSeconds = Number(row.WAIT_SECONDS || row.wait_seconds || 0);
        blockerMap.get(bSid).waiters.push({
          sid:          wSid,
          serial_num:   Number(row.WAITER_SERIAL || row.waiter_serial || 0),
          username:     row.WAITER_USER || row.waiter_user || '',
          sql_id:       row.WAITER_SQL_ID || row.waiter_sql_id || null,
          sql_text:     row.WAITER_SQL_TEXT || row.waiter_sql_text || '',
          object_name:  row.BLOCKED_OBJECT || row.blocked_object || null,
          lock_mode:    row.LOCK_MODE || row.lock_mode || '',
          wait_seconds: waitSeconds,
          sev1:         false,
          sub_waiters:  [],
        });
      }

      // Flag sev1 for chains >2 levels (waiter is also a blocker)
      for (const [, entry] of blockerMap) {
        for (const waiter of entry.waiters) {
          if (blockerMap.has(waiter.sid)) {
            waiter.sev1 = true;
            waiter.sub_waiters = blockerMap.get(waiter.sid).waiters;
          }
        }
      }

      // Only return top-level blockers (not those who are also waiters)
      const waiterSids = new Set();
      for (const [, entry] of blockerMap) {
        for (const w of entry.waiters) waiterSids.add(w.sid);
      }
      const tree = [];
      for (const [sid, entry] of blockerMap) {
        if (!waiterSids.has(sid)) tree.push(entry);
      }

      res.json({
        is_demo: false,
        fetched_at: new Date().toISOString(),
        blocking_tree: tree,
      });
    } finally {
      if (connection) try { await connection.close(); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error('[performance] Error fetching blocking sessions:', err);
    res.status(500).json({ error: 'Failed to fetch blocking sessions' });
  }
});

// ─── ROUTE: segment-hotspots ───────────────────────────────────────────────────

/**
 * GET /api/performance/:connectionId/segment-hotspots
 *
 * Top 20 segments by logical reads (V$SEGMENT_STATISTICS).
 * Each row gets an AI recommendation (partitioning, index review, IOT candidate).
 */
router.get('/:connectionId/segment-hotspots', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      const demo = getDemoSegmentHotspots();
      // Generate AI recommendations for demo segments
      const CONCURRENCY = 3;
      for (let i = 0; i < Math.min(demo.segments.length, 6); i += CONCURRENCY) {
        const batch = demo.segments.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (seg) => {
          seg.ai_recommendation = await generateSegmentRec(seg.owner, seg.segment_name, seg.segment_type, seg.logical_reads);
        }));
      }
      return res.json(demo);
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const params = await resolveConnParams(connId, req.user.id);
    if (!params) return res.status(404).json({ error: 'Connection not found' });
    if (params.error === 'proxy') return res.status(400).json({ error: 'Performance tab requires a direct TCP connection.' });

    const oracledb = require('oracledb');
    const connectString = `${params.host}:${params.port}/${params.serviceName}`;
    let connection;
    try {
      connection = await oracledb.getConnection({ user: params.username, password: params.password, connectString, connectTimeout: 30 });

      let segments = [];
      try {
        const r = await connection.execute(SEGMENT_HOTSPOTS_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        segments = (r.rows || []).map(row => ({
          owner:          row.OWNER || row.owner || '',
          segment_name:   row.SEGMENT_NAME || row.segment_name || '',
          segment_type:   row.SEGMENT_TYPE || row.segment_type || '',
          logical_reads:  Number(row.LOGICAL_READS || row.logical_reads || 0),
          ai_recommendation: null,
        }));
      } catch (e) {
        console.error('[performance] segment hotspots query failed:', e.message);
      }

      // AI recommendation for top 6 segments
      const CONCURRENCY = 3;
      for (let i = 0; i < Math.min(segments.length, 6); i += CONCURRENCY) {
        const batch = segments.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (seg) => {
          seg.ai_recommendation = await generateSegmentRec(seg.owner, seg.segment_name, seg.segment_type, seg.logical_reads);
        }));
      }

      res.json({
        is_demo: false,
        fetched_at: new Date().toISOString(),
        segments,
      });
    } finally {
      if (connection) try { await connection.close(); } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error('[performance] Error fetching segment hotspots:', err);
    res.status(500).json({ error: 'Failed to fetch segment hotspot data' });
  }
});

module.exports = router;
