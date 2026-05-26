/**
 * routes/proxy-self-test.js — Proxy self-test: ingest synthetic EBS payload through
 * the full parse → score → persist → AI summary pipeline without a live Oracle box.
 *
 * Owns: GET /admin/proxy-self-test (admin UI page)
 *       POST /api/admin/proxy/self-test (trigger a scenario run)
 *       GET  /api/admin/proxy/self-test/runs (last 10 runs)
 * Does NOT own: actual Oracle connections, proxy HTTP logic, user CRUD.
 *
 * Admin-only. Same auth pattern as ebs-validation.js + test-harness.js.
 *
 * Regression guide:
 *   healthy      — baseline; verify all EBS sections render, score ≥ 85
 *   warning      — tablespace 85%, OPP below target, WF backlog; verify amber rows
 *   critical     — ICM/OPP down, WF Mailer stopped, ADOP failed; verify red Critical Issues
 *   ebs_patching — ADOP cutover in progress; verify amber ADOP row, not critical
 *
 * curl example (replace TOKEN):
 *   curl -X POST https://tunevault.app/api/admin/proxy/self-test \
 *        -H "Authorization: Bearer TOKEN" \
 *        -H "Content-Type: application/json" \
 *        -d '{"scenario":"critical"}'
 */

'use strict';

const express  = require('express');
const crypto   = require('crypto');
const OpenAI   = require('openai');
const path     = require('path');
const pool     = require('../db/index');
const { getSummaryScores } = require('../demo-data');

const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// ── OpenAI client (same config as server.js) ─────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  timeout: 55000,
  maxRetries: 0
});

// ── Fixture loader ─────────────────────────────────────────────────────────────

const FIXTURE_PATH = path.join(__dirname, '../proxy/fixtures/synthetic-ebs-payload.json');
let _fixtureCache = null;

function loadFixtures() {
  if (_fixtureCache) return _fixtureCache;
  try {
    _fixtureCache = JSON.parse(require('fs').readFileSync(FIXTURE_PATH, 'utf8'));
    return _fixtureCache;
  } catch (err) {
    throw new Error(`Failed to load fixture file at ${FIXTURE_PATH}: ${err.message}`);
  }
}

const VALID_SCENARIOS = ['healthy', 'warning', 'critical', 'ebs_patching'];

// ── Score-to-status helper ─────────────────────────────────────────────────────

function scoreToStatus(score) {
  if (score == null) return 'error';
  if (score >= 80) return 'green';
  if (score >= 60) return 'amber';
  return 'red';
}

// ── persistCheckResults (self-contained replica for self-test) ─────────────────
// Mirrors the logic in server.js persistCheckResults but scoped to self-test runs.
// connectionId is the sentinel self-test connection ID so rows are queryable by runId.

async function persistSelfTestCheckResults(connectionId, runId, metrics) {
  const scores = getSummaryScores(metrics);
  const now = new Date();
  const rows = [];

  // Storage: tablespaces
  for (const ts of (metrics.tablespaces || [])) {
    rows.push({
      check_id: 'ST01_TABLESPACE_USAGE',
      check_category: 'storage',
      status: ts.pct_used > 90 ? 'red' : ts.pct_used > 80 ? 'amber' : 'green',
      metric_name: 'pct_used', metric_value: ts.pct_used, metric_unit: '%',
      raw_payload: ts,
      ai_summary: `${ts.name}: ${ts.pct_used}% used (${ts.used_gb}GB / ${ts.total_gb}GB)`,
      recommendation: ts.pct_used > 90 ? 'CRITICAL: Add datafile or extend tablespace immediately' : null
    });
  }

  // Performance: wait events
  rows.push({
    check_id: 'PF01_WAIT_EVENTS', check_category: 'performance',
    status: scoreToStatus(scores.wait_events),
    metric_name: 'score', metric_value: scores.wait_events, metric_unit: 'score',
    raw_payload: { wait_events: metrics.wait_events || [], score: scores.wait_events },
    ai_summary: `Wait events score: ${scores.wait_events}/100`,
    recommendation: scores.wait_events < 60 ? 'High wait event contention detected — review top wait classes' : null
  });

  // Observability: DB uptime
  if (metrics.instance) {
    const uptimeDays = metrics.instance.uptime_days || 0;
    rows.push({
      check_id: 'OB01_DB_UPTIME', check_category: 'observability',
      status: uptimeDays < 1 ? 'red' : uptimeDays < 7 ? 'amber' : 'green',
      metric_name: 'uptime_days', metric_value: uptimeDays, metric_unit: 'days',
      raw_payload: { uptime_days: uptimeDays, version: metrics.instance.version },
      ai_summary: `DB uptime: ${uptimeDays} days`,
      recommendation: uptimeDays < 1 ? 'Database restarted recently — verify if planned' : null
    });
  }

  // Backup: RMAN freshness
  const rman = metrics.backup_stats && metrics.backup_stats.rman_backup;
  if (rman) {
    rows.push({
      check_id: 'BK01_RMAN_FRESHNESS', check_category: 'backup',
      status: rman.status === 'critical' ? 'red' : rman.status === 'warning' ? 'amber' : 'green',
      metric_name: 'full_backup_hours_ago', metric_value: rman.full_backup_hours_ago, metric_unit: 'hours',
      raw_payload: rman,
      ai_summary: rman.last_full_backup ? `Last full backup: ${rman.last_full_backup.end_time} (${rman.full_backup_hours_ago}h ago)` : 'No RMAN full backup found',
      recommendation: rman.full_backup_hours_ago > 48 ? 'CRITICAL: No backup in 48h — verify RMAN schedule immediately' : null
    });
  }

  // EBS checks
  const ebs = metrics.ebs_detected && metrics.ebs_operations;
  if (ebs) {
    const cm  = ebs.concurrent_managers || {};
    const wf  = ebs.workflow || {};
    const sec = ebs.security || {};
    const fb  = ebs.functional || {};

    if (cm.cm01) {
      const icm = cm.cm01;
      const running = icm.running_processes || 0;
      const max     = icm.max_processes || 1;
      rows.push({
        check_id: 'EBS_CM01_INTERNAL_MANAGER', check_category: 'ebs_operations',
        status: running === 0 ? 'red' : running < max ? 'amber' : 'green',
        metric_name: 'running_processes', metric_value: running, metric_unit: 'processes',
        raw_payload: icm,
        ai_summary: `Internal Manager: ${running}/${max} processes running`,
        recommendation: running === 0 ? 'CRITICAL: Internal Manager is down — restart via FNDSM or adcmctl.sh start' : null
      });
    }

    if (cm.cm02) {
      const pending = cm.cm02.pending_requests || 0;
      rows.push({
        check_id: 'EBS_CM02_PENDING_REQUESTS', check_category: 'ebs_operations',
        status: pending > 200 ? 'red' : pending > 50 ? 'amber' : 'green',
        metric_name: 'pending_requests', metric_value: pending, metric_unit: 'requests',
        raw_payload: cm.cm02,
        ai_summary: `Standard Manager pending queue: ${pending} requests`,
        recommendation: pending > 200 ? 'CRITICAL: Request backlog exceeds 200 — check manager capacity or stuck requests' : pending > 50 ? 'Pending queue elevated — monitor for growing backlog' : null
      });
    }

    if (cm.cm03) {
      const opp     = cm.cm03;
      const running = opp.running_processes || 0;
      const max     = opp.max_processes || 0;
      rows.push({
        check_id: 'EBS_CM03_OPP_STATUS', check_category: 'ebs_operations',
        status: running === 0 && max > 0 ? 'red' : running < max ? 'amber' : 'green',
        metric_name: 'running_processes', metric_value: running, metric_unit: 'processes',
        raw_payload: opp,
        ai_summary: `Output Post Processor (OPP): ${running}/${max} process(es) running`,
        recommendation: running === 0 && max > 0
          ? 'CRITICAL: OPP is down — PDF/output generation will fail. Restart via adcmctl.sh or check FNDCPOPP manager status.'
          : running < max ? `OPP running below target (${running}/${max}) — monitor for output delivery delays` : null
      });
    }

    if (cm.cm10) {
      const errs = cm.cm10.error_requests_24h || 0;
      rows.push({
        check_id: 'EBS_CM10_ERROR_REQUESTS', check_category: 'ebs_operations',
        status: errs > 20 ? 'red' : errs > 5 ? 'amber' : 'green',
        metric_name: 'error_requests_24h', metric_value: errs, metric_unit: 'requests',
        raw_payload: cm.cm10,
        ai_summary: `${errs} concurrent request(s) errored in last 24h`,
        recommendation: errs > 5 ? "Review errored requests: SELECT concurrent_program_name, logfile_name FROM fnd_concurrent_requests WHERE status_code IN ('E','X') AND actual_completion_date > SYSDATE-1" : null
      });
    }

    if (wf.wf03) {
      const deferred = wf.wf03.deferred_ready || 0;
      rows.push({
        check_id: 'EBS_WF03_DEFERRED_QUEUE', check_category: 'ebs_operations',
        status: deferred > 500 ? 'red' : deferred > 100 ? 'amber' : 'green',
        metric_name: 'deferred_ready', metric_value: deferred, metric_unit: 'items',
        raw_payload: wf.wf03,
        ai_summary: `${deferred} Workflow deferred item(s) ready to process`,
        recommendation: deferred > 100 ? 'High deferred queue — verify WF Background Agent is running' : null
      });
    }

    if (wf.wf08) {
      const over2h = wf.wf08.pending_over_2h || 0;
      const over8h = wf.wf08.pending_over_8h || 0;
      rows.push({
        check_id: 'EBS_WF08_NOTIFICATION_BACKLOG', check_category: 'ebs_operations',
        status: over8h > 100 ? 'red' : over2h > 100 ? 'amber' : 'green',
        metric_name: 'pending_over_2h', metric_value: over2h, metric_unit: 'notifications',
        raw_payload: wf.wf08,
        ai_summary: `Workflow notification backlog: ${over2h} pending >2h, ${over8h} pending >8h`,
        recommendation: over8h > 100 ? 'CRITICAL: Notification backlog >8h exceeds threshold — check Workflow Mailer service and SMTP connectivity' : over2h > 100 ? 'Notification backlog growing — verify Workflow Mailer is processing outbound mail' : null
      });
    }

    if (wf.wf09 && wf.wf09.length > 0) {
      const services = wf.wf09;
      const down = services.filter(s => !s.enabled && s.status !== 'NOT_CONFIGURED');
      rows.push({
        check_id: 'EBS_WF09_SERVICE_COMPONENTS', check_category: 'ebs_operations',
        status: down.length > 0 ? 'red' : 'green',
        metric_name: 'services_down', metric_value: down.length, metric_unit: 'services',
        raw_payload: { services },
        ai_summary: down.length > 0
          ? `${down.length} Workflow service(s) not running: ${down.map(s => s.name || s.type).join(', ')}`
          : `All ${services.length} Workflow service component(s) running`,
        recommendation: down.length > 0 ? 'Start stopped Workflow services in Oracle Applications Manager (OAM) → Service Components or via svcctl.sh' : null
      });
    }

    if (ebs._adop_status && ebs._adop_status.status !== 'skip') {
      const adop   = ebs._adop_status;
      const failed = adop.failed_sessions || 0;
      const active = adop.active_sessions || 0;
      rows.push({
        check_id: 'EBS_ADOP_SESSIONS', check_category: 'ebs_operations',
        status: failed > 0 ? 'red' : active > 0 ? 'amber' : 'green',
        metric_name: 'adop_failed_sessions', metric_value: failed, metric_unit: 'sessions',
        raw_payload: adop,
        ai_summary: failed > 0
          ? `${failed} ADOP session(s) in FAILED state — patching cycle may be stalled`
          : active > 0 ? `${active} active ADOP patching session(s) in progress` : 'No active or failed ADOP sessions',
        recommendation: failed > 0
          ? "Investigate failed ADOP sessions: SELECT session_id, prepare_status, apply_status, cutover_status FROM ad_adop_sessions WHERE status='F'"
          : active > 0 ? 'ADOP patching cycle in progress — do not start another patching cycle until cutover/cleanup is complete' : null
      });
    }

    if (sec.sc12) {
      rows.push({
        check_id: 'EBS_SC12_SIGNON_AUDIT', check_category: 'ebs_operations',
        status: sec.sc12.audit_enabled ? 'green' : 'amber',
        metric_name: 'signon_audit_level', metric_value: null, metric_unit: null,
        raw_payload: sec.sc12,
        ai_summary: `EBS sign-on audit level: ${sec.sc12.signon_audit_level}`,
        recommendation: !sec.sc12.audit_enabled ? 'Enable sign-on audit: set SIGNONAUDIT:LEVEL to FORM or USER in FND_PROFILE_OPTIONS' : null
      });
    }

    if (sec.sc14) {
      const count = sec.sc14.length;
      rows.push({
        check_id: 'EBS_SC14_SYSADMIN_USERS', check_category: 'ebs_operations',
        status: count > 5 ? 'amber' : 'green',
        metric_name: 'sysadmin_user_count', metric_value: count, metric_unit: 'users',
        raw_payload: { users: sec.sc14 },
        ai_summary: `${count} user(s) with System Administrator responsibility`,
        recommendation: count > 5 ? 'Review System Administrator grants — minimize to essential staff only' : null
      });
    }

    if (fb.fb04) {
      rows.push({
        check_id: 'EBS_FB04_ACTIVE_USERS', check_category: 'ebs_operations',
        status: 'green',
        metric_name: 'active_users_24h', metric_value: fb.fb04.active_users_24h || 0, metric_unit: 'users',
        raw_payload: fb.fb04,
        ai_summary: `${fb.fb04.active_users_24h || 0} distinct EBS user(s) active in last 24h`,
        recommendation: null
      });
    }
  }

  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO check_results
           (connection_id, run_id, check_id, check_category, status,
            metric_name, metric_value, metric_unit, raw_payload, ai_summary, recommendation, executed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          connectionId, runId, row.check_id, row.check_category, row.status,
          row.metric_name || null,
          row.metric_value != null ? row.metric_value : null,
          row.metric_unit || null,
          JSON.stringify(row.raw_payload),
          row.ai_summary || null,
          row.recommendation || null,
          now
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[self-test] persistSelfTestCheckResults failed:', err.message);
  } finally {
    client.release();
  }
}

// ── Inline summary helpers (mirrors server.js logic) ──────────────────────────

function buildSelfTestSummary(scores, metrics) {
  const ebs = metrics.ebs_detected && metrics.ebs_operations;
  let txt;
  if (scores.overall < 50) {
    txt = 'This database is in critical condition and requires immediate DBA intervention.';
  } else if (scores.overall < 75) {
    txt = 'This database is in a degraded state with several issues that need prompt attention.';
  } else {
    txt = 'This database is in acceptable health with minor items to monitor.';
  }

  const ebsStatus = ebs && ebs._overall_status;
  if (ebsStatus === 'critical') txt += ' EBS application tier has critical failures — concurrent manager or workflow services are down.';
  else if (ebsStatus === 'warning') txt += ' EBS application tier shows degraded performance — review concurrent manager queue depth and workflow services.';

  const adopStatus = ebs && ebs._adop_status;
  if (adopStatus && adopStatus.failed_sessions > 0) {
    txt += ` ${adopStatus.failed_sessions} ADOP patching session(s) in FAILED state — patching cycle is stalled and requires immediate attention.`;
  } else if (adopStatus && adopStatus.active_sessions > 0) {
    txt += ' ADOP patching cycle is currently in progress. Do not start another patch window until the current cycle completes.';
  }

  return txt;
}

// ── AI prompt builder (self-test variant) ─────────────────────────────────────
// Produces a concise focused prompt covering EBS and DB highlights.
// Not identical to server.js buildAnalysisPrompt — that function relies on
// legacy field shapes; this version is purpose-built for fixture data shapes.

function buildSelfTestPrompt(metrics, scores) {
  const inst = metrics.instance || {};
  const ebs  = metrics.ebs_detected && metrics.ebs_operations;
  const cm   = ebs && (ebs.concurrent_managers || {});
  const wf   = ebs && (ebs.workflow || {});
  const adop = ebs && ebs._adop_status;

  const tsLines = (metrics.tablespaces || [])
    .map(t => `  - ${t.name}: ${t.pct_used}% used (${t.used_gb}GB/${t.total_gb}GB) autoextend=${t.autoextend}`)
    .join('\n') || '  - No tablespace data';

  const waitLines = (metrics.wait_events || [])
    .filter(w => w.pct_db_time > 1)
    .map(w => `  - ${w.event} [${w.wait_class}]: ${w.pct_db_time}% DB time, avg ${w.avg_wait_ms}ms`)
    .join('\n') || '  - No significant waits';

  const ebsSection = !ebs ? '- EBS not detected' : [
    `- Internal Manager: ${cm.cm01 ? `${cm.cm01.running_processes}/${cm.cm01.max_processes} running` : 'unknown'}`,
    `- OPP: ${cm.cm03 ? `${cm.cm03.running_processes}/${cm.cm03.max_processes} running` : 'unknown'}`,
    `- Pending requests: ${cm.cm02 ? cm.cm02.pending_requests : 'unknown'}`,
    `- WF Mailer: ${wf.wf03 ? wf.wf03.status : 'unknown'}, deferred queue: ${wf.wf03 ? wf.wf03.deferred_ready : 'unknown'}`,
    `- WF service components: ${wf.wf09 ? wf.wf09.map(s => `${s.name} [${s.status}]`).join(', ') : 'none'}`,
    `- ADOP: ${adop ? adop.message : 'not detected'}`,
    `- Overall EBS status: ${ebs._overall_status}`
  ].join('\n');

  return `ORACLE E-BUSINESS SUITE HEALTH CHECK — ${inst.db_name || 'EBSPROD'} (Oracle ${inst.version || 'unknown'}, EBS 12.2)
Uptime: ${inst.uptime_days || 0} days | Overall score: ${scores.overall}/100

SCORES:
  storage=${scores.storage}/100 | performance=${scores.performance}/100 | memory=${scores.memory}/100
  backup=${scores.backup}/100 | index_health=${scores.index_health}/100 | overall=${scores.overall}/100

TABLESPACES:
${tsLines}

TOP WAIT EVENTS:
${waitLines}

EBS APPLICATION TIER:
${ebsSection}

BACKUP:
  RMAN last full: ${metrics.backup_stats && metrics.backup_stats.rman_backup ? metrics.backup_stats.rman_backup.full_backup_hours_ago + 'h ago' : 'unknown'}
  FRA: ${metrics.backup_stats && metrics.backup_stats.fra_usage ? metrics.backup_stats.fra_usage.pct_used + '% used' : 'unknown'}

Produce a DBA-grade health assessment with:
1. Executive summary (2-3 sentences)
2. Critical findings with SQL remediation commands
3. EBS-specific findings with Oracle Applications Manager steps
4. Top 3 priority actions in order of urgency

Be specific and concise. Use SQL commands. Focus on what needs to happen NOW.`;
}

// ── Self-test pipeline ─────────────────────────────────────────────────────────
// Creates a real health_check record and runs the full parse+score+AI pipeline
// using the synthetic fixture payload. Creates a sentinel oracle_connection row
// for selftest@tunevault.app if one doesn't already exist.

async function runSelfTestPipeline(metrics, scenario, triggeredBy) {
  // 1. Ensure sentinel user + connection exist
  let selftestUserId;
  const SELFTEST_EMAIL = 'selftest@tunevault.app';

  const userRes = await pool.query(
    `INSERT INTO users (email, name, company_domain, last_login, created_at, updated_at)
     VALUES ($1, 'Self-Test Runner', 'tunevault.app', NOW(), NOW(), NOW())
     ON CONFLICT ((LOWER(email))) DO UPDATE SET last_login = NOW()
     RETURNING id`,
    [SELFTEST_EMAIL]
  );
  selftestUserId = userRes.rows[0].id;

  const connRes = await pool.query(
    `INSERT INTO oracle_connections
       (user_id, name, host, port, service_name, username, encrypted_password, connection_type, created_at, updated_at)
     VALUES ($1, 'Self-Test Sentinel (synthetic)', 'selftest.internal', 1521, 'SELFTEST', 'SELFTEST',
             'selftest-placeholder', 'proxy', NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [selftestUserId]
  );

  // If ON CONFLICT fired, fetch the existing row
  let connectionId;
  if (connRes.rows.length > 0) {
    connectionId = connRes.rows[0].id;
  } else {
    const existing = await pool.query(
      `SELECT id FROM oracle_connections WHERE user_id = $1 AND name = 'Self-Test Sentinel (synthetic)' LIMIT 1`,
      [selftestUserId]
    );
    connectionId = existing.rows[0]?.id;
  }

  // 2. Create health_check record
  const hcRes = await pool.query(
    `INSERT INTO health_checks
       (connection_name, host, port, service_name, is_demo, connection_id, status, metrics, overall_score, username)
     VALUES ($1, 'selftest.internal', 1521, 'SELFTEST', false, $2, 'collecting', '{}', 0, 'SELFTEST')
     RETURNING *`,
    [`[Self-Test: ${scenario}] Oracle EBS 12.2`, connectionId]
  );
  const hc = hcRes.rows[0];
  const healthCheckId = hc.id;
  const runId         = crypto.randomUUID();
  const t0            = Date.now();

  try {
    const scores = getSummaryScores(metrics);
    const t1     = Date.now();

    // 3. Write metrics + score
    await pool.query(
      `UPDATE health_checks SET metrics = $1, overall_score = $2, status = 'analyzing', analysis_stage = 'ai_pending' WHERE id = $3`,
      [JSON.stringify(metrics), scores.overall, healthCheckId]
    );

    // 4. Persist individual check_results rows
    await persistSelfTestCheckResults(connectionId, runId, metrics);

    // 5. Build inline (rule-based) summary — written atomically with status=completed
    //    so the report page never shows NULL fields.
    const inlineSummary = buildSelfTestSummary(scores, metrics);
    const inlineAction  = 'Review the EBS Operations tab first, then address any Critical Issues shown below.';

    // 6. AI analysis via OpenAI proxy
    let aiAnalysis   = null;
    let aiOutcome    = 'inline';
    const prompt     = buildSelfTestPrompt(metrics, scores);
    const t2         = Date.now();

    try {
      await pool.query(
        `UPDATE health_checks SET analysis_stage = 'gpt_running', analysis_progress_ms = 0 WHERE id = $1`,
        [healthCheckId]
      );

      const controller  = new AbortController();
      const abortTimer  = setTimeout(() => controller.abort(), 55000);
      const t3          = Date.now();

      let completion;
      try {
        completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are TuneVault, an expert Oracle DBA AI agent providing concise, actionable analysis with runnable SQL commands.' },
            { role: 'user',   content: prompt }
          ],
          temperature: 0.3,
          max_tokens:  2000
        }, { signal: controller.signal });
      } finally {
        clearTimeout(abortTimer);
      }

      aiAnalysis = completion.choices[0]?.message?.content || null;
      aiOutcome  = 'ai';
      const t4   = Date.now();

      console.log(`[self-test] scenario=${scenario} report=${healthCheckId} dur_gpt_ms=${t4 - t3} tokens=${completion.usage?.total_tokens || 0}`);
    } catch (aiErr) {
      // AI failure is non-fatal — write inline summary as fallback
      console.warn(`[self-test] AI analysis failed (non-fatal): ${aiErr.message}`);
      aiAnalysis = `## Self-Test Health Check — ${scenario} scenario\n\n*(AI analysis unavailable — ${aiErr.message})*\n\n${inlineSummary}`;
    }

    // 7. Write final result atomically (never leaves report with NULL summary_text)
    await pool.query(
      `UPDATE health_checks
         SET ai_analysis = $1, summary_text = $2, top_action = $3,
             status = 'completed', completed_at = NOW(),
             analysis_stage = 'completed', analysis_progress_ms = $4
       WHERE id = $5`,
      [aiAnalysis, inlineSummary, inlineAction, Date.now() - t2, healthCheckId]
    );

    const totalMs = Date.now() - t0;
    console.log(`[self-test] scenario=${scenario} report=${healthCheckId} outcome=${aiOutcome} total_ms=${totalMs} score=${scores.overall} triggered_by=${triggeredBy}`);

    return {
      health_check_id:    healthCheckId,
      run_id:             runId,
      scenario,
      overall_score:      scores.overall,
      ebs_detected:       !!metrics.ebs_detected,
      ebs_status:         (metrics.ebs_operations && metrics.ebs_operations._overall_status) || null,
      ai_outcome:         aiOutcome,
      total_ms:           totalMs,
      report_url:         `/report/${healthCheckId}`
    };

  } catch (err) {
    console.error(`[self-test] pipeline failed for report=${healthCheckId}:`, err.message);
    await pool.query(
      `UPDATE health_checks SET status = 'error', ai_analysis = $1, completed_at = NOW() WHERE id = $2`,
      [`## Self-Test Error\n\nScenario: ${scenario}\nError: ${err.message}`, healthCheckId]
    );
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /admin/proxy-self-test — serve the admin UI page
router.get('/proxy-self-test', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/proxy-self-test.html'));
});

// GET /api/admin/proxy/self-test/runs — last 10 self-test runs
router.get('/proxy/self-test/runs', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT hc.id, hc.connection_name, hc.overall_score, hc.status, hc.completed_at, hc.analysis_stage
       FROM health_checks hc
       JOIN oracle_connections oc ON hc.connection_id = oc.id
       JOIN users u ON oc.user_id = u.id
       WHERE u.email = 'selftest@tunevault.app'
       ORDER BY hc.created_at DESC
       LIMIT 10`
    );
    res.json({ success: true, runs: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/proxy/self-test — trigger a scenario
router.post('/proxy/self-test', requireAdmin, async (req, res) => {
  const scenario = (req.body && req.body.scenario) || 'healthy';

  if (!VALID_SCENARIOS.includes(scenario)) {
    return res.status(400).json({
      success: false,
      error: `Invalid scenario '${scenario}'. Valid: ${VALID_SCENARIOS.join(', ')}`
    });
  }

  let fixtures;
  try {
    fixtures = loadFixtures();
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  const metrics = fixtures.scenarios[scenario];
  if (!metrics) {
    return res.status(400).json({ success: false, error: `Scenario '${scenario}' not found in fixture file` });
  }

  // Strip _description/_comment keys (not part of the metrics payload)
  const cleanMetrics = Object.fromEntries(
    Object.entries(metrics).filter(([k]) => !k.startsWith('_'))
  );

  try {
    const result = await runSelfTestPipeline(cleanMetrics, scenario, req.user.email);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
