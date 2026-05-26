/**
 * routes/sql-tuning.js — SQL Tuning module: V$SQL top consumers + AI rewrite/index hints.
 *
 * Owns: /api/sql-tuning/* — collecting top-10 SQL by composite score from V$SQL/GV$SQL,
 *       fetching execution plans + bind captures, running AI analysis (gpt-4o-mini),
 *       heuristic fallback for full-table-scan patterns, persisting to sql_tuning_findings.
 * Does NOT own: auth state, Oracle connection storage, health check execution,
 *               or any other performance/tuning tab's data.
 *
 * Mounted at: /api/sql-tuning (see server.js)
 *
 * Routes:
 *   POST /api/sql-tuning/:connectionId/analyze
 *     Collects top-10 SQL from Oracle, runs AI analysis, persists findings.
 *   GET  /api/sql-tuning/:connectionId/findings
 *     Returns the latest persisted findings for the connection (fast, no Oracle trip).
 */

'use strict';

const express = require('express');
const OpenAI  = require('openai');

const {
  upsertTuningFindings,
  getTuningFindings,
  getConnectionForTuning,
} = require('../db/sql-tuning');
const { decrypt } = require('../crypto-utils');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Oracle: collect top-10 SQL ───────────────────────────────────────────────
//
// Composite score = normalized(elapsed) + normalized(cpu) + normalized(buffer_gets).
// Queries V$SQL (always available) since V$SQL + GV$SQL requires RAC detection first.
// SELECT_CATALOG_ROLE is sufficient — no extra grants.

const VSQL_QUERY = `
SELECT
  s.sql_id,
  s.plan_hash_value,
  s.parsing_schema_name,
  s.executions,
  s.rows_processed,
  s.last_active_time,
  ROUND(s.elapsed_time  / NULLIF(s.executions, 0) / 1000, 2) AS elapsed_per_exec_ms,
  ROUND(s.cpu_time      / NULLIF(s.executions, 0) / 1000, 2) AS cpu_per_exec_ms,
  ROUND(s.buffer_gets   / NULLIF(s.executions, 0))            AS buffer_gets_per_exec,
  ROUND(s.disk_reads    / NULLIF(s.executions, 0))            AS disk_reads_per_exec,
  ROUND(s.rows_processed / NULLIF(s.executions, 0), 2)        AS rows_per_exec,
  SUBSTR(s.sql_fulltext, 1, 4000)                              AS sql_fulltext,
  (
    (s.elapsed_time / NULLIF(s.executions, 0)) +
    (s.cpu_time     / NULLIF(s.executions, 0)) * 0.8 +
    (s.buffer_gets  / NULLIF(s.executions, 0)) * 10
  ) AS composite_score
FROM v$sql s
WHERE s.executions > 0
  AND s.command_type IN (1, 2, 3, 6, 7)
  AND s.parsing_schema_name NOT IN (
    'SYS','SYSTEM','DBSNMP','ORACLE_OCM','OUTLN','XDB','CTXSYS',
    'EXFSYS','MDSYS','ORDSYS','WMSYS','OJVMSYS','LBACSYS','DVSYS',
    'AUDSYS','GSMADMIN_INTERNAL','ORDPLUGINS','APPS_NE'
  )
ORDER BY composite_score DESC NULLS LAST
FETCH FIRST 10 ROWS ONLY
`;

// Execution plan from V$SQL_PLAN — always available, no Diagnostics Pack needed
const PLAN_QUERY = `
SELECT
  id,
  parent_id,
  operation,
  options,
  object_owner,
  object_name,
  cost,
  cardinality,
  access_predicates,
  filter_predicates
FROM v$sql_plan
WHERE sql_id = :sqlId
  AND plan_hash_value = :planHash
  AND child_number = 0
ORDER BY id
FETCH FIRST 30 ROWS ONLY
`;

// Bind variable capture (peek values)
const BIND_QUERY = `
SELECT
  name,
  position,
  datatype_string,
  value_string,
  was_captured
FROM v$sql_bind_capture
WHERE sql_id = :sqlId
  AND child_number = 0
ORDER BY position
FETCH FIRST 20 ROWS ONLY
`;

// EBS concurrent program lookup — maps sql_id back to a program name
const EBS_PROG_QUERY = `
SELECT DISTINCT
  r.concurrent_program_name,
  p.user_concurrent_program_name
FROM fnd_concurrent_requests r
JOIN fnd_concurrent_programs_vl p
  ON p.concurrent_program_id = r.concurrent_program_id
WHERE r.oracle_session_id IN (
  SELECT audsid FROM v$session WHERE sql_id = :sqlId
)
  AND ROWNUM <= 3
`;

// ─── Oracle: RAC detection ────────────────────────────────────────────────────

const RAC_QUERY = `
SELECT COUNT(*) AS node_count
FROM gv$instance
`;

async function isRacInstance(connection, oracledb) {
  try {
    const r = await connection.execute(RAC_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return Number((r.rows[0] || {}).NODE_COUNT || 1) > 1;
  } catch {
    return false;
  }
}

// ─── Oracle data collection ────────────────────────────────────────────────────

async function collectFromOracle(connParams) {
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

    // Detect RAC (affects query scope note, not actual query)
    const isRac = await isRacInstance(connection, oracledb);

    // Detect EBS (APPS schema presence)
    let isEbs = false;
    try {
      const r = await connection.execute(
        `SELECT 1 FROM all_users WHERE username = 'APPS' AND ROWNUM = 1`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      isEbs = (r.rows || []).length > 0;
    } catch { /* ignore */ }

    // Fetch top-10 SQL
    const sqlResult = await connection.execute(VSQL_QUERY, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const sqlRows = sqlResult.rows || [];

    const findings = [];

    for (let i = 0; i < sqlRows.length; i++) {
      const row = sqlRows[i];
      const sqlId      = row.SQL_ID          || row.sql_id         || '';
      const planHash   = Number(row.PLAN_HASH_VALUE || row.plan_hash_value || 0);
      const schema     = row.PARSING_SCHEMA_NAME || row.parsing_schema_name || '';
      const sqlFullText = row.SQL_FULLTEXT    || row.sql_fulltext  || '';

      // Fetch execution plan
      let plan = [];
      try {
        const pr = await connection.execute(
          PLAN_QUERY,
          { sqlId, planHash },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        plan = (pr.rows || []).map(p => ({
          id:                p.ID                || p.id                || 0,
          parent_id:         p.PARENT_ID         || p.parent_id         || null,
          operation:         p.OPERATION         || p.operation         || '',
          options:           p.OPTIONS           || p.options           || '',
          object_owner:      p.OBJECT_OWNER      || p.object_owner      || null,
          object_name:       p.OBJECT_NAME       || p.object_name       || null,
          cost:              p.COST              || p.cost              || null,
          cardinality:       p.CARDINALITY       || p.cardinality       || null,
          access_predicates: p.ACCESS_PREDICATES || p.access_predicates || null,
          filter_predicates: p.FILTER_PREDICATES || p.filter_predicates || null,
        }));
      } catch { /* plan unavailable */ }

      // Fetch bind captures
      let binds = [];
      try {
        const br = await connection.execute(
          BIND_QUERY,
          { sqlId },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        binds = (br.rows || []).map(b => ({
          name:            b.NAME            || b.name            || '',
          position:        b.POSITION        || b.position        || 0,
          datatype_string: b.DATATYPE_STRING || b.datatype_string || '',
          value_string:    b.VALUE_STRING    || b.value_string    || null,
          was_captured:    b.WAS_CAPTURED    || b.was_captured    || 'NO',
        }));
      } catch { /* bind capture unavailable (SE/SE2) */ }

      // EBS concurrent program lookup
      let ebsProgram = null;
      if (isEbs && schema === 'APPS') {
        try {
          const er = await connection.execute(
            EBS_PROG_QUERY,
            { sqlId },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );
          const epRow = (er.rows || [])[0];
          if (epRow) {
            ebsProgram = epRow.USER_CONCURRENT_PROGRAM_NAME || epRow.user_concurrent_program_name || null;
          }
        } catch { /* FND views not accessible */ }
      }

      findings.push({
        rank:                 i + 1,
        sql_id:               sqlId,
        plan_hash:            planHash,
        parsing_schema_name:  schema,
        executions:           Number(row.EXECUTIONS         || row.executions         || 0),
        elapsed_per_exec_ms:  Number(row.ELAPSED_PER_EXEC_MS || row.elapsed_per_exec_ms || 0),
        cpu_per_exec_ms:      Number(row.CPU_PER_EXEC_MS     || row.cpu_per_exec_ms     || 0),
        buffer_gets_per_exec: Number(row.BUFFER_GETS_PER_EXEC || row.buffer_gets_per_exec || 0),
        disk_reads_per_exec:  Number(row.DISK_READS_PER_EXEC  || row.disk_reads_per_exec  || 0),
        rows_processed_per_exec: Number(row.ROWS_PER_EXEC    || row.rows_per_exec       || 0),
        sql_text:             sqlFullText,
        plan_summary_json:    plan,
        metrics_json: {
          composite_score:   Number(row.COMPOSITE_SCORE || row.composite_score || 0),
          last_active_time:  row.LAST_ACTIVE_TIME || row.last_active_time || null,
          ebs_program:       ebsProgram,
          binds,
          is_rac:            isRac,
          is_ebs:            isEbs,
        },
      });
    }

    return { findings, isEbs, isRac };
  } finally {
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }
}

// ─── AI: generate recommendation per SQL ─────────────────────────────────────

const AI_SYSTEM = `You are a senior Oracle DBA. Analyze the SQL statement, execution plan, and runtime statistics provided, then output exactly this JSON (no markdown, no prose, no extra keys):

{
  "diagnosis_tag": "<one of: full_table_scan | missing_index | bad_join_order | cardinality_misestimate | bind_peeking | cursor_sharing | redundant_sort | unnecessary_distinct | subquery_unnesting | other>",
  "fix_type": "<one of: index | hint | rewrite>",
  "recommended_sql": "<complete, copy-paste-ready CREATE INDEX statement, hint block, or rewritten SQL>",
  "rationale": "<15 words max: what the fix does and why>"
}

HARD RULES:
1. recommended_sql must be copy-pasteable into sqlplus/SQLcl immediately — no placeholders, no TODOs.
2. For full_table_scan on tables > 50k rows with a WHERE predicate: recommend a CREATE INDEX on the predicate columns.
3. For bad_join_order or cardinality_misestimate: use a /*+ hint */ block.
4. For algorithmically wrong SQL (cartesian, unnecessary DISTINCT, etc.): rewrite the SQL.
5. NEVER output "check the execution plan", "review statistics", "gather statistics", or any vague phrasing.
6. NEVER use the phrase "check the execution plan" in any field.
7. If you cannot determine a concrete fix, set fix_type="index" and recommended_sql="-- Insufficient plan detail: run EXPLAIN PLAN FOR <sql_id> and check DBA_HIST_SQL_PLAN" with rationale explaining what additional info is needed.`;

async function generateAiRecommendation(finding) {
  let openai;
  try { openai = new OpenAI(); } catch { return null; }

  const planLines = (finding.plan_summary_json || []).map((p, i) =>
    `  ${i}. ${p.operation} ${p.options || ''} ${p.object_name ? `ON ${p.object_owner ? p.object_owner + '.' : ''}${p.object_name}` : ''} ` +
    `[cost=${p.cost ?? '?'} card=${p.cardinality ?? '?'}]` +
    (p.access_predicates ? ` ACCESS: ${p.access_predicates}` : '') +
    (p.filter_predicates ? ` FILTER: ${p.filter_predicates}` : '')
  ).join('\n');

  const prompt = `SQL ID: ${finding.sql_id}
Schema: ${finding.parsing_schema_name}
Executions: ${finding.executions}
Elapsed/exec (ms): ${finding.elapsed_per_exec_ms}
CPU/exec (ms): ${finding.cpu_per_exec_ms}
Buffer gets/exec: ${finding.buffer_gets_per_exec}
Disk reads/exec: ${finding.disk_reads_per_exec}
Rows/exec: ${finding.rows_processed_per_exec}

SQL TEXT (first 4000 chars):
${(finding.sql_text || '').slice(0, 4000)}

EXECUTION PLAN (${(finding.plan_summary_json || []).length} steps):
${planLines || '  (no plan available)'}

Return JSON only.`;

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_SYSTEM },
        { role: 'user',   content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 600,
    });

    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    // Hard reject vague outputs
    const vague = ['check the execution plan', 'review statistics', 'gather statistics', 'consult a dba'];
    const recLower = (parsed.recommended_sql || '').toLowerCase();
    const ratLower  = (parsed.rationale || '').toLowerCase();
    if (vague.some(v => recLower.includes(v) || ratLower.includes(v))) {
      return null;
    }

    return {
      diagnosis_tag:        parsed.diagnosis_tag   || 'other',
      fix_type:             parsed.fix_type         || 'index',
      ai_recommendation_text: parsed.rationale       || '',
      recommended_sql_text:   parsed.recommended_sql || '',
      is_heuristic:           false,
    };
  } catch (e) {
    console.error('[sql-tuning] AI recommendation failed:', e.message);
    return null;
  }
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────
//
// Fires when AI returns null. Detects FULL TABLE SCAN on tables > 100k rows
// (based on plan cardinality) with an access predicate, and suggests an index.

const HIGH_CARDINALITY_THRESHOLD = 100000;
const NOISE_SCHEMAS = new Set(['SYS','SYSTEM','DBSNMP','ORACLE_OCM','OUTLN','XDB']);

function heuristicRecommendation(finding) {
  const plan = finding.plan_summary_json || [];
  const schema = finding.parsing_schema_name || '';

  if (NOISE_SCHEMAS.has(schema)) return null;

  // Find the worst full table scan step
  let worstFts = null;
  for (const step of plan) {
    if (
      step.operation === 'TABLE ACCESS' &&
      step.options === 'FULL' &&
      step.object_name &&
      Number(step.cardinality || 0) > HIGH_CARDINALITY_THRESHOLD
    ) {
      if (!worstFts || Number(step.cardinality) > Number(worstFts.cardinality)) {
        worstFts = step;
      }
    }
  }

  if (!worstFts) return null;

  const owner = worstFts.object_owner || schema;
  const table = worstFts.object_name;

  // Extract predicate column names heuristically
  const filterPred = worstFts.filter_predicates || '';
  const accessPred = worstFts.access_predicates || '';
  const allPreds = (accessPred + ' ' + filterPred).trim();

  // Extract column names: look for patterns like "COLUMN_NAME" = or "COLUMN_NAME" IS or "COLUMN_NAME" between
  const colMatches = allPreds.match(/"([A-Z_][A-Z0-9_]*)"/g) || [];
  const cols = [...new Set(colMatches.map(m => m.replace(/"/g, '')))].slice(0, 3);

  const tablespaceHint = owner === 'APPS' ? ' TABLESPACE APPS_TS_TX_IDX' : '';

  let recommended_sql;
  const safeTable = `${owner}.${table}`;
  const safeIdx = `idx_${table.toLowerCase().slice(0, 20)}_heuristic`;

  if (cols.length > 0) {
    recommended_sql = `CREATE INDEX ${safeIdx} ON ${safeTable} (${cols.join(', ')})${tablespaceHint};`;
  } else {
    recommended_sql = `-- Identify predicate columns for ${safeTable} and create an index:\n` +
      `-- SELECT COLUMN_NAME, NUM_DISTINCT, LAST_ANALYZED FROM DBA_TAB_COLUMNS WHERE TABLE_NAME = '${table}' AND OWNER = '${owner}' ORDER BY NUM_DISTINCT DESC;\n` +
      `-- Then: CREATE INDEX ${safeIdx} ON ${safeTable} (<predicate_columns>)${tablespaceHint};`;
  }

  const card = Number(worstFts.cardinality || 0).toLocaleString();
  return {
    diagnosis_tag:          'full_table_scan',
    fix_type:               'index',
    ai_recommendation_text: `Full table scan on ${table} (~${card} rows)${cols.length > 0 ? ` — no index on ${cols.join(', ')}` : ''}`,
    recommended_sql_text:   recommended_sql,
    is_heuristic:           true,
  };
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function getDemoFindings() {
  return [
    {
      id: 1, rank: 1,
      sql_id: 'abc1234xyz01', plan_hash: 2847361920,
      parsing_schema_name: 'APPS',
      executions: 1523, elapsed_per_exec_ms: 4850, cpu_per_exec_ms: 3200,
      buffer_gets_per_exec: 182400, disk_reads_per_exec: 12300, rows_processed_per_exec: 84,
      sql_text: 'SELECT o.order_id, o.customer_id, ol.line_id, p.product_name, p.unit_price\nFROM oe_order_headers_all o, oe_order_lines_all ol, mtl_system_items_b p\nWHERE o.header_id = ol.header_id\n  AND ol.inventory_item_id = p.inventory_item_id\n  AND o.creation_date > :date1',
      plan_summary_json: [
        { id:0, parent_id:null, operation:'SELECT STATEMENT', options:'', object_owner:null, object_name:null, cost:98450, cardinality:1, access_predicates:null, filter_predicates:null },
        { id:1, parent_id:0,    operation:'HASH JOIN',        options:'', object_owner:null, object_name:null, cost:98450, cardinality:8423, access_predicates:null, filter_predicates:null },
        { id:2, parent_id:1,    operation:'TABLE ACCESS',     options:'FULL', object_owner:'APPS', object_name:'OE_ORDER_LINES_ALL', cost:45200, cardinality:98230, access_predicates:null, filter_predicates:'"HEADER_ID">0' },
        { id:3, parent_id:1,    operation:'TABLE ACCESS',     options:'FULL', object_owner:'APPS', object_name:'OE_ORDER_HEADERS_ALL', cost:22100, cardinality:45100, access_predicates:null, filter_predicates:'"CREATION_DATE">:date1' },
        { id:4, parent_id:1,    operation:'TABLE ACCESS',     options:'BY INDEX ROWID', object_owner:'APPS', object_name:'MTL_SYSTEM_ITEMS_B', cost:3, cardinality:1, access_predicates:'"INVENTORY_ITEM_ID"=:1', filter_predicates:null },
      ],
      ai_recommendation_text: 'Eliminates full table scan on OE_ORDER_LINES_ALL — join column header_id has no usable index',
      recommended_sql_text: 'CREATE INDEX idx_oola_hdr_item ON oe_order_lines_all (header_id, inventory_item_id) TABLESPACE APPS_TS_TX_IDX;',
      fix_type: 'index', diagnosis_tag: 'full_table_scan', is_heuristic: false,
      metrics_json: { composite_score: 9842000, ebs_program: 'OM Order Fulfillment', is_ebs: true, is_rac: false, binds: [{ name: ':date1', position: 1, datatype_string: 'DATE', value_string: '2024-01-01', was_captured: 'YES' }] },
      created_at: new Date().toISOString(),
    },
    {
      id: 2, rank: 2,
      sql_id: 'def5678uvw02', plan_hash: 1938472650,
      parsing_schema_name: 'APPS',
      executions: 8920, elapsed_per_exec_ms: 1240, cpu_per_exec_ms: 980,
      buffer_gets_per_exec: 43200, disk_reads_per_exec: 0, rows_processed_per_exec: 4500,
      sql_text: 'SELECT /*+ NO_INDEX */ wf.notification_id, wf.status, wf.from_user, wf.to_user\nFROM wf_notifications wf\nWHERE wf.status = :status AND wf.begin_date < :cutoff\nORDER BY wf.begin_date',
      plan_summary_json: [
        { id:0, parent_id:null, operation:'SELECT STATEMENT', options:'', object_owner:null, object_name:null, cost:31200, cardinality:1, access_predicates:null, filter_predicates:null },
        { id:1, parent_id:0,    operation:'SORT', options:'ORDER BY', object_owner:null, object_name:null, cost:31200, cardinality:4500, access_predicates:null, filter_predicates:null },
        { id:2, parent_id:1,    operation:'TABLE ACCESS', options:'FULL', object_owner:'APPS', object_name:'WF_NOTIFICATIONS', cost:22400, cardinality:4500, access_predicates:null, filter_predicates:'"STATUS"=:status AND "BEGIN_DATE"<:cutoff' },
      ],
      ai_recommendation_text: 'Force WF_NOTIFICATIONS_N1 (status, begin_date) — NO_INDEX hint suppressing a selective index',
      recommended_sql_text: 'SELECT /*+ INDEX(wf WF_NOTIFICATIONS_N1) */ wf.notification_id, wf.status, wf.from_user, wf.to_user\nFROM wf_notifications wf\nWHERE wf.status = :status AND wf.begin_date < :cutoff\nORDER BY wf.begin_date',
      fix_type: 'hint', diagnosis_tag: 'missing_index', is_heuristic: false,
      metrics_json: { composite_score: 5280000, ebs_program: 'WF Background Process', is_ebs: true, is_rac: false, binds: [] },
      created_at: new Date().toISOString(),
    },
    {
      id: 3, rank: 3,
      sql_id: 'ghi9012rst03', plan_hash: 3719283640,
      parsing_schema_name: 'APPS',
      executions: 342, elapsed_per_exec_ms: 18700, cpu_per_exec_ms: 11200,
      buffer_gets_per_exec: 892000, disk_reads_per_exec: 48200, rows_processed_per_exec: 82000,
      sql_text: 'SELECT gl.segment1, gl.segment2, gl.segment3,\n       SUM(jl.entered_dr - jl.entered_cr) balance\nFROM gl_je_headers gl, gl_je_lines jl\nWHERE gl.je_header_id = jl.je_header_id\n  AND gl.period_name = :period\n  AND gl.ledger_id = :ledger\nGROUP BY gl.segment1, gl.segment2, gl.segment3',
      plan_summary_json: [
        { id:0, parent_id:null, operation:'SELECT STATEMENT', options:'', object_owner:null, object_name:null, cost:212000, cardinality:1, access_predicates:null, filter_predicates:null },
        { id:1, parent_id:0,    operation:'SORT', options:'GROUP BY', object_owner:null, object_name:null, cost:212000, cardinality:82000, access_predicates:null, filter_predicates:null },
        { id:2, parent_id:1,    operation:'HASH JOIN', options:'', object_owner:null, object_name:null, cost:187000, cardinality:82000, access_predicates:null, filter_predicates:null },
        { id:3, parent_id:2,    operation:'TABLE ACCESS', options:'FULL', object_owner:'APPS', object_name:'GL_JE_HEADERS', cost:42000, cardinality:18000, access_predicates:null, filter_predicates:'"LEDGER_ID"=:ledger AND "PERIOD_NAME"=:period' },
        { id:4, parent_id:2,    operation:'TABLE ACCESS', options:'FULL', object_owner:'APPS', object_name:'GL_JE_LINES', cost:98000, cardinality:420000, access_predicates:null, filter_predicates:null },
      ],
      ai_recommendation_text: 'Both tables full-scanned; composite index on ledger_id+period_name converts GL_JE_HEADERS to range scan',
      recommended_sql_text: 'CREATE INDEX idx_glh_period_ledger ON gl_je_headers (ledger_id, period_name, je_header_id) TABLESPACE APPS_TS_TX_IDX;\nCREATE INDEX idx_gll_header ON gl_je_lines (je_header_id) TABLESPACE APPS_TS_TX_IDX;',
      fix_type: 'index', diagnosis_tag: 'full_table_scan', is_heuristic: false,
      metrics_json: { composite_score: 3940000, ebs_program: 'General Ledger Reporting', is_ebs: true, is_rac: false, binds: [] },
      created_at: new Date().toISOString(),
    },
    {
      id: 4, rank: 4,
      sql_id: 'jkl3456pqr04', plan_hash: 1029384756,
      parsing_schema_name: 'SCOTT',
      executions: 25410, elapsed_per_exec_ms: 340, cpu_per_exec_ms: 290,
      buffer_gets_per_exec: 18200, disk_reads_per_exec: 0, rows_processed_per_exec: 1,
      sql_text: "SELECT emp_id, dept_id, salary FROM employees WHERE dept_id = 42 AND hire_date > '2020-01-01'",
      plan_summary_json: [
        { id:0, parent_id:null, operation:'SELECT STATEMENT', options:'', object_owner:null, object_name:null, cost:8400, cardinality:1, access_predicates:null, filter_predicates:null },
        { id:1, parent_id:0,    operation:'TABLE ACCESS', options:'FULL', object_owner:'SCOTT', object_name:'EMPLOYEES', cost:8400, cardinality:124000, access_predicates:null, filter_predicates:'"DEPT_ID"=42 AND "HIRE_DATE">DATE\'2020-01-01\'' },
      ],
      ai_recommendation_text: 'Full table scan on 124k-row EMPLOYEES table — add composite index on dept_id, hire_date',
      recommended_sql_text: "CREATE INDEX idx_emp_dept_hire ON scott.employees (dept_id, hire_date);",
      fix_type: 'index', diagnosis_tag: 'full_table_scan', is_heuristic: true,
      metrics_json: { composite_score: 2940000, ebs_program: null, is_ebs: false, is_rac: false, binds: [] },
      created_at: new Date().toISOString(),
    },
  ];
}

// ─── ROUTE: POST /api/sql-tuning/:connectionId/analyze ───────────────────────

/**
 * POST /api/sql-tuning/:connectionId/analyze
 *
 * Connects to the Oracle DB, collects top-10 SQL from V$SQL, fetches plans + binds,
 * runs AI analysis (with heuristic fallback), persists to sql_tuning_findings, returns results.
 * connectionId = 'demo' returns demo data without Oracle access.
 */
// Run SQL tuning analysis — junior_dba+
router.post('/:connectionId/analyze', requireAuth, requireRole('junior_dba'), async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      return res.json({ findings: getDemoFindings(), is_demo: true, analyzed_at: new Date().toISOString() });
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) {
      return res.status(400).json({ error: 'Invalid connection ID' });
    }

    const conn = await getConnectionForTuning(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.connection_type === 'proxy') {
      return res.status(400).json({ error: 'SQL Tuning requires a direct TCP connection, not a proxy connection.' });
    }

    const connParams = {
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: conn.service_name,
      username:    conn.username,
      password:    decrypt(conn.encrypted_password),
    };

    // Collect data from Oracle (V$SQL + plans + binds)
    const { findings } = await collectFromOracle(connParams);

    // Attach AI/heuristic recommendations (limited concurrency)
    const CONCURRENCY = 3;
    for (let i = 0; i < findings.length; i += CONCURRENCY) {
      const batch = findings.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (f) => {
        const ai = await generateAiRecommendation(f);
        if (ai) {
          f.diagnosis_tag          = ai.diagnosis_tag;
          f.fix_type               = ai.fix_type;
          f.ai_recommendation_text = ai.ai_recommendation_text;
          f.recommended_sql_text   = ai.recommended_sql_text;
          f.is_heuristic           = false;
        } else {
          // Heuristic fallback
          const heuristic = heuristicRecommendation(f);
          if (heuristic) {
            f.diagnosis_tag          = heuristic.diagnosis_tag;
            f.fix_type               = heuristic.fix_type;
            f.ai_recommendation_text = heuristic.ai_recommendation_text;
            f.recommended_sql_text   = heuristic.recommended_sql_text;
            f.is_heuristic           = true;
          }
        }
      }));
    }

    // Persist to DB (replaces previous run for this connection)
    await upsertTuningFindings(connId, findings);

    res.json({ findings, is_demo: false, analyzed_at: new Date().toISOString() });
  } catch (err) {
    console.error('[sql-tuning] analyze error:', err);
    res.status(500).json({ error: 'Failed to run SQL tuning analysis' });
  }
});

// ─── ROUTE: GET /api/sql-tuning/:connectionId/findings ───────────────────────

/**
 * GET /api/sql-tuning/:connectionId/findings
 *
 * Returns cached findings from the last analyze run. No Oracle trip.
 * Used by the /sql-tuning page on load to show previous results without re-analyzing.
 */
router.get('/:connectionId/findings', requireAuth, async (req, res) => {
  try {
    if (req.params.connectionId === 'demo') {
      return res.json({ findings: getDemoFindings(), is_demo: true });
    }

    const connId = Number(req.params.connectionId);
    if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection ID' });

    const conn = await getConnectionForTuning(connId, req.user.id);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });

    const findings = await getTuningFindings(connId);
    res.json({ findings, is_demo: false });
  } catch (err) {
    console.error('[sql-tuning] findings fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch SQL tuning findings' });
  }
});

module.exports = router;
