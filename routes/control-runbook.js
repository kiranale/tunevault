/**
 * routes/control-runbook.js — EBS Recovery Runbook Generator API.
 *
 * Owns: POST /api/control/runbook/:scenario — 4 deterministic runbook generators
 *   backed by live instance state from Oracle via connection proxy.
 *   No AI in the loop — templates only. Safety whitelist enforced server-side.
 *
 * Does NOT own: auth state, oracle connections, EBS catalog commands (ebs-control.js),
 *               sanity checks, live status monitor — those are in ebs-deep.js / ebs-control.js.
 *
 * Scenarios:
 *   cm-stuck        — Concurrent Manager stuck/dead-locked runbook
 *   opp-zero        — OPP zero-throughput runbook
 *   wfmailer-stall  — WF Mailer outbound stall runbook
 *   adop-cleanup    — ADOP failed cutover cleanup runbook
 *
 * Safety rail: every command in the emitted runbook is validated against ALLOWED_COMMAND_PATTERNS.
 * Any command matching BLOCKED_PATTERNS is rejected — runbook generation fails, 400 returned.
 */

'use strict';

const express = require('express');

const pool        = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getConnectionById } = require('../db/ebs-deep');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Safety whitelist ────────────────────────────────────────────────────────
//
// Commands emitted in runbooks must match at least one ALLOWED_COMMAND_PATTERNS
// entry AND must not match any BLOCKED_PATTERNS entry.
// Checked per-command before the runbook is returned to the client.

const ALLOWED_COMMAND_PATTERNS = [
  /^adcmctl\.sh\s+(start|stop|status)/,
  /^adopmnctl\.sh\s+(start|stop|status)/,
  /^adop\s+phase=(abort|cleanup|prepare|apply)/,
  /^wfmlrdbg/,
  /^kill\s+-9\s+\d+$/,
  // SQL statements allowed in runbooks (SELECT, UPDATE on specific WF tables only)
  /^SELECT\s+/i,
  /^UPDATE\s+apps\.wf_notifications\s+SET\s+mail_status/i,
  // Advisory runbook: adop-patch-active uses SELECT-only commands (already covered by SELECT above)
  // V$ACTIVE_SERVICES / AD_ADOP_SESSIONS monitoring queries
];

const BLOCKED_PATTERNS = [
  /\brm\b/,
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\b/i,
  />+/,            // output redirection
  /\|\s*rm/,       // pipe to rm
];

/**
 * Validate a single command string against safety rules.
 * Returns null if safe, or an error string describing the violation.
 */
function validateCommand(cmd) {
  const trimmed = cmd.trim();
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.test(trimmed)) {
      return `Blocked pattern in command: "${trimmed.slice(0, 60)}"`;
    }
  }
  const allowed = ALLOWED_COMMAND_PATTERNS.some(p => p.test(trimmed));
  if (!allowed) {
    return `Command not in allowlist: "${trimmed.slice(0, 60)}"`;
  }
  return null;
}

/**
 * Validate all commands across all steps in a runbook.
 * Returns array of violation strings (empty = all clean).
 */
function validateRunbook(steps) {
  const violations = [];
  for (const step of steps) {
    if (!step.commands) continue;
    for (const cmd of step.commands) {
      const err = validateCommand(cmd);
      if (err) violations.push(err);
    }
  }
  return violations;
}

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Detection queries ────────────────────────────────────────────────────────
//
// Each scenario runs detection queries on the user's Oracle connection.
// Returns { detected: bool, liveData: {…}, detectionQuery: string }

async function detectCmStuck(connection) {
  const detectionQuery = `
SELECT q.concurrent_queue_name, q.running_processes, q.max_processes,
       q.control_code, q.enabled_flag
FROM apps.fnd_concurrent_queues q
WHERE q.enabled_flag = 'Y'
  AND (
    (q.running_processes < q.max_processes AND q.max_processes > 0)
    OR q.control_code IN ('R','X','D','T')
  )
ORDER BY q.concurrent_queue_name`.trim();

  const result = await connection.execute(
    `SELECT q.concurrent_queue_name, q.running_processes, q.max_processes,
            q.control_code, q.enabled_flag
     FROM apps.fnd_concurrent_queues q
     WHERE q.enabled_flag = 'Y'
       AND (
         (q.running_processes < q.max_processes AND q.max_processes > 0)
         OR q.control_code IN ('R','X','D','T')
       )
     ORDER BY q.concurrent_queue_name`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  // Also get stuck processes with OS PIDs for kill commands
  const procResult = await connection.execute(
    `SELECT p.os_process_id, p.concurrent_queue_name, p.process_status_code
     FROM apps.fnd_concurrent_processes p
     WHERE p.process_status_code NOT IN ('K','S','U')
     ORDER BY p.os_process_id`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  const queues = (result.rows || []).map(r => ({
    name: r[0], running: Number(r[1]) || 0, max: Number(r[2]) || 0,
    controlCode: r[3] || null, enabled: r[4]
  }));
  const processes = (procResult.rows || []).map(r => ({
    osPid: String(r[0] || ''), queueName: r[1], statusCode: r[2]
  }));

  return {
    detected: queues.length > 0 || processes.length > 0,
    liveData: { queues, processes },
    detectionQuery,
    verificationQuery: `SELECT COUNT(*) stuck_count FROM apps.fnd_concurrent_queues q
WHERE q.enabled_flag = 'Y'
  AND (
    (q.running_processes < q.max_processes AND q.max_processes > 0)
    OR q.control_code IN ('R','X','D','T')
  )
-- Expected: 0`
  };
}

async function detectOppZero(connection) {
  const detectionQuery = `
SELECT p.os_process_id, p.process_status_code, p.concurrent_queue_name,
       (SELECT COUNT(*) FROM apps.fnd_concurrent_requests r
        WHERE r.concurrent_program_name = 'FNDCPOPP'
          AND r.phase_code = 'P') AS backlog
FROM apps.fnd_concurrent_processes p
WHERE p.concurrent_queue_name = 'FNDCPOPP'
  AND p.process_status_code = 'A'`.trim();

  const result = await connection.execute(
    `SELECT p.os_process_id, p.process_status_code,
            (SELECT COUNT(*) FROM apps.fnd_concurrent_requests r
             WHERE r.concurrent_program_name = 'FNDCPOPP'
               AND r.phase_code = 'P') AS backlog
     FROM apps.fnd_concurrent_processes p
     WHERE p.concurrent_queue_name = 'FNDCPOPP'
       AND p.process_status_code = 'A'`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  const processes = (result.rows || []).map(r => ({
    osPid: String(r[0] || ''), statusCode: r[1], backlog: Number(r[2]) || 0
  }));
  const totalBacklog = processes.reduce((s, p) => s + p.backlog, 0);

  return {
    detected: processes.length > 0 && totalBacklog > 0,
    liveData: { processes, totalBacklog },
    detectionQuery,
    verificationQuery: `SELECT COUNT(*) opp_backlog FROM apps.fnd_concurrent_requests r
WHERE r.concurrent_program_name = 'FNDCPOPP'
  AND r.phase_code = 'P'
-- Expected: 0`
  };
}

async function detectWfMailerStall(connection) {
  const detectionQuery = `
SELECT COUNT(*) stuck_count
FROM apps.wf_notifications
WHERE mail_status = 'MAIL'
  AND status = 'OPEN'
  AND begin_date < SYSDATE - 1/24`.trim();

  const result = await connection.execute(
    `SELECT COUNT(*) FROM apps.wf_notifications
     WHERE mail_status = 'MAIL'
       AND status = 'OPEN'
       AND begin_date < SYSDATE - 1/24`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  const stuckCount = Number(result.rows?.[0]?.[0]) || 0;

  // Also get Mailer component status
  const mailerResult = await connection.execute(
    `SELECT component_name, component_status
     FROM apps.fnd_svc_components
     WHERE component_type LIKE 'WF_MAILER%'
       AND ROWNUM = 1`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );
  const mailerStatus = mailerResult.rows?.[0]
    ? { name: mailerResult.rows[0][0], status: mailerResult.rows[0][1] }
    : null;

  return {
    detected: stuckCount > 0,
    liveData: { stuckCount, mailerStatus },
    detectionQuery,
    verificationQuery: `SELECT COUNT(*) stuck_after_fix FROM apps.wf_notifications
WHERE mail_status = 'MAIL'
  AND status = 'OPEN'
  AND begin_date < SYSDATE - 1/24
-- Expected: 0 (queue draining)`
  };
}

async function detectAdopCleanup(connection) {
  const detectionQuery = `
SELECT s.adop_session_id, s.status, s.node_status,
       s.applied_fs_base_dir, s.patch_fs_base_dir
FROM apps.ad_adop_sessions s
WHERE s.status = 'F'
  AND NVL(s.node_status, 'X') != 'C'
ORDER BY s.adop_session_id DESC`.trim();

  const result = await connection.execute(
    `SELECT s.adop_session_id, s.status, s.node_status,
            s.applied_fs_base_dir, s.patch_fs_base_dir
     FROM apps.ad_adop_sessions s
     WHERE s.status = 'F'
       AND NVL(s.node_status, 'X') != 'C'
     ORDER BY s.adop_session_id DESC`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  const sessions = (result.rows || []).map(r => ({
    sessionId: String(r[0] || ''), status: r[1], nodeStatus: r[2] || null,
    appliedFsDir: r[3] || '/u01/fs1', patchFsDir: r[4] || '/u01/fs2'
  }));

  return {
    detected: sessions.length > 0,
    liveData: { sessions },
    detectionQuery,
    verificationQuery: `SELECT COUNT(*) failed_sessions FROM apps.ad_adop_sessions s
WHERE s.status = 'F'
  AND NVL(s.node_status, 'X') != 'C'
-- Expected: 0 (all cleaned up)`
  };
}

// ─── Runbook builders ────────────────────────────────────────────────────────
//
// Each builder returns { title, disclaimer, steps: [{label, type, commands, notes}] }
// type: 'shell' | 'sql' | 'verify' | 'wait'
// commands: string[] — exact commands to display (real values substituted in)

function buildCmRunbook(liveData) {
  const { queues, processes } = liveData;

  const queueList = queues.length > 0
    ? queues.map(q => `  ${q.name} (running=${q.running}, max=${q.max}, control=${q.controlCode || 'none'})`).join('\n')
    : '  (all queues within target range)';

  const stragglersBlock = processes.length > 0
    ? processes.map(p => `kill -9 ${p.osPid}   # ${p.queueName} status=${p.statusCode}`).join('\n')
    : null;

  const steps = [
    {
      label: 'Stop Concurrent Managers',
      type: 'shell',
      commands: ['adcmctl.sh stop apps/<apps_password>'],
      notes: 'Run as applmgr from $ADMIN_SCRIPTS_HOME. Graceful stop — in-flight requests drain before shutdown.'
    },
    {
      label: 'Wait for processes to reach Killed state',
      type: 'sql',
      commands: [
        `SELECT COUNT(*) active_procs FROM apps.fnd_concurrent_processes\nWHERE process_status_code NOT IN ('K','S','U')`
      ],
      notes: 'Re-run until count = 0. Allow up to 3 minutes for graceful drain. If count stays > 0, proceed to next step.'
    }
  ];

  if (stragglersBlock) {
    steps.push({
      label: 'Kill stragglers by OS PID (if previous query still shows > 0)',
      type: 'shell',
      commands: stragglersBlock.split('\n').filter(Boolean),
      notes: `PIDs from live FND_CONCURRENT_PROCESSES query. Run on the EBS app tier as root or applmgr (if sudo configured).\n\nDetected stuck processes:\n${processes.map(p => `  PID ${p.osPid} — ${p.queueName}`).join('\n')}`
    });
  }

  steps.push(
    {
      label: 'Start Concurrent Managers',
      type: 'shell',
      commands: ['adcmctl.sh start apps/<apps_password>'],
      notes: 'Allow 60–90 seconds for Internal Concurrent Manager to initialize and activate service queues.'
    },
    {
      label: 'Verification — confirm queues are running',
      type: 'verify',
      commands: [
        `SELECT q.concurrent_queue_name, q.running_processes, q.max_processes, q.control_code\nFROM apps.fnd_concurrent_queues q\nWHERE q.enabled_flag = 'Y'\n  AND (\n    (q.running_processes < q.max_processes AND q.max_processes > 0)\n    OR q.control_code IN ('R','X','D','T')\n  )\nORDER BY q.concurrent_queue_name\n-- Expected: 0 rows`
      ],
      notes: 'Run against the APPS schema. Zero rows = healthy. If queues still show stuck, check CM log at $APPLCSF/$APPLLOG/ADCM_*.mgr.'
    }
  );

  return {
    title: 'Concurrent Manager — Stuck / Dead-locked Recovery',
    scenario: 'cm-stuck',
    detected: queues.length > 0 || processes.length > 0,
    detectedSummary: queues.length > 0
      ? `${queues.length} queue(s) below target or with stuck control code:\n${queueList}`
      : 'Stuck OS processes detected in FND_CONCURRENT_PROCESSES.',
    steps
  };
}

function buildOppRunbook(liveData) {
  const { processes, totalBacklog } = liveData;

  const steps = [
    {
      label: 'Graceful OPP shutdown via fnd_svc_components',
      type: 'sql',
      commands: [
        `SELECT component_name, component_status, component_id\nFROM apps.fnd_svc_components\nWHERE component_name LIKE '%Output Post%'\n-- Confirm component_id before stopping`
      ],
      notes: 'Note the component_id for the OPP component. You will use it in the next step.'
    },
    {
      label: 'Stop OPP via Service Manager',
      type: 'shell',
      commands: ['adopmnctl.sh stop'],
      notes: 'This stops Oracle Process Manager and managed components including OPP. On EBS 12.2 WebLogic stacks, use admanagedsrvctl.sh opp stop if adopmnctl.sh is absent.'
    },
    {
      label: 'Flush OPP pending request cache',
      type: 'sql',
      commands: [
        `SELECT COUNT(*) backlog\nFROM apps.fnd_concurrent_requests\nWHERE concurrent_program_name = 'FNDCPOPP'\n  AND phase_code = 'P'\n-- Note current backlog count: ${totalBacklog}`
      ],
      notes: `Current backlog detected: ${totalBacklog} pending OPP requests. These will be reprocessed after restart.`
    },
    {
      label: 'Start OPP',
      type: 'shell',
      commands: ['adopmnctl.sh start'],
      notes: 'Allow 60 seconds for OPP to initialize and begin processing the backlog queue.'
    },
    {
      label: 'Verification — confirm OPP resumed processing',
      type: 'verify',
      commands: [
        `SELECT COUNT(*) opp_backlog\nFROM apps.fnd_concurrent_requests r\nWHERE r.concurrent_program_name = 'FNDCPOPP'\n  AND r.phase_code = 'P'\n-- Expected: 0 (all processed) or count decreasing`
      ],
      notes: 'Re-run every 30 seconds. Count should decrease to 0 as OPP drains the queue. If backlog stays flat, check OPP log at $APPLCSF/$APPLLOG.'
    }
  ];

  return {
    title: 'OPP — Zero-Throughput Recovery',
    scenario: 'opp-zero',
    detected: processes.length > 0 && totalBacklog > 0,
    detectedSummary: `${processes.length} OPP process(es) active but ${totalBacklog} requests pending in queue.`,
    steps
  };
}

function buildWfMailerRunbook(liveData) {
  const { stuckCount, mailerStatus } = liveData;

  const mailerLine = mailerStatus
    ? `Mailer component "${mailerStatus.name}" current status: ${mailerStatus.status}`
    : 'Mailer component not found in FND_SVC_COMPONENTS';

  const steps = [
    {
      label: 'Stop Workflow Mailer via OAM (or wfmlrdbg)',
      type: 'shell',
      commands: [`wfmlrdbg status`],
      notes: `Run as applmgr. Alternatively stop via Oracle Application Manager: Workflow → Service Components.\n${mailerLine}`
    },
    {
      label: 'Bounce stuck WF_NOTIFICATIONS rows from FAILED back to MAIL',
      type: 'sql',
      commands: [
        `UPDATE apps.wf_notifications\nSET mail_status = 'MAIL'\nWHERE mail_status IN ('FAILED','ERROR')\n  AND status = 'OPEN'\n  AND begin_date < SYSDATE - 1/24\n-- Rows to fix: ${stuckCount} detected`
      ],
      notes: `Current stuck count: ${stuckCount} notifications older than 1h with mail_status='MAIL' and not delivered.\nThis UPDATE re-queues failed rows so the Mailer picks them up on restart. COMMIT after reviewing.`
    },
    {
      label: 'COMMIT the fix',
      type: 'sql',
      commands: ['SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = \'MAIL\' AND status = \'OPEN\''],
      notes: 'Verify the count before committing. If count is as expected, issue COMMIT in your SQL tool.'
    },
    {
      label: 'Start Workflow Mailer',
      type: 'shell',
      commands: [`wfmlrdbg start`],
      notes: 'Alternatively restart via OAM: Workflow → Service Components → Start. Allow 30 seconds for initialization.'
    },
    {
      label: 'Verification — confirm queue is draining',
      type: 'verify',
      commands: [
        `SELECT COUNT(*) stuck_after_fix\nFROM apps.wf_notifications\nWHERE mail_status = 'MAIL'\n  AND status = 'OPEN'\n  AND begin_date < SYSDATE - 1/24\n-- Expected: 0 or decreasing`
      ],
      notes: 'Re-run every 2 minutes. Count should approach 0 as Mailer processes the queue. If count stays flat, check Mailer log in Workflow Dashboard.'
    }
  ];

  return {
    title: 'Workflow Mailer — Outbound Stall Recovery',
    scenario: 'wfmailer-stall',
    detected: stuckCount > 0,
    detectedSummary: `${stuckCount} WF_NOTIFICATIONS row(s) stuck with mail_status='MAIL' older than 1 hour.`,
    steps
  };
}

function buildAdopRunbook(liveData) {
  const { sessions } = liveData;

  const session = sessions[0] || {
    sessionId: 'unknown', status: 'F', nodeStatus: null,
    appliedFsDir: '/u01/fs1', patchFsDir: '/u01/fs2'
  };

  const sessionSummary = sessions.length > 0
    ? sessions.map(s => `  Session ${s.sessionId}: status=${s.status}, node_status=${s.nodeStatus || 'null'}`).join('\n')
    : '  No failed sessions found';

  const steps = [
    {
      label: 'Abort the failed ADOP session',
      type: 'shell',
      commands: [`adop phase=abort`],
      notes: `Run as applmgr from $ADMIN_SCRIPTS_HOME. This aborts any in-progress ADOP session.\n\nFailed sessions detected:\n${sessionSummary}`
    },
    {
      label: 'Full cleanup of patch filesystem',
      type: 'shell',
      commands: [`adop phase=cleanup cleanup_mode=full`],
      notes: 'cleanup_mode=full removes all patch cycle artifacts including applied but not yet cutover patches. This prepares the system for a fresh patch cycle.\n\nExpected patch FS directory: ' + session.patchFsDir
    },
    {
      label: 'Verify patch filesystem is unmounted',
      type: 'shell',
      commands: [`adop phase=abort`],
      notes: `Confirms ADOP session is fully cleared. Then verify:\n  - Patch FS directory ${session.patchFsDir} is clean\n  - AD_ADOP_SESSIONS shows no in-progress sessions`
    },
    {
      label: 'Verify no failed sessions remain',
      type: 'sql',
      commands: [
        `SELECT adop_session_id, status, node_status, start_date\nFROM apps.ad_adop_sessions\nWHERE status IN ('F','G')\nORDER BY adop_session_id DESC\n-- Expected: 0 rows with status F`
      ],
      notes: 'If rows remain with status=F, re-run cleanup with cleanup_mode=full. If sessions cannot be cleaned, engage Oracle Support (SR on EBS Patching).'
    },
    {
      label: 'Verification — confirm ready for new patch cycle',
      type: 'verify',
      commands: [
        `SELECT COUNT(*) failed_sessions\nFROM apps.ad_adop_sessions s\nWHERE s.status = 'F'\n  AND NVL(s.node_status, 'X') != 'C'\n-- Expected: 0`
      ],
      notes: 'Zero rows = system is clean and ready for a new adop phase=prepare run. If count > 0, check ADOP logs at $APPL_TOP/admin/adop_logs/.'
    }
  ];

  return {
    title: 'ADOP — Failed Cutover Cleanup',
    scenario: 'adop-cleanup',
    detected: sessions.length > 0,
    detectedSummary: sessions.length > 0
      ? `${sessions.length} ADOP session(s) in FAILED state with incomplete cleanup.`
      : 'No failed ADOP sessions detected (running runbook preventively).',
    steps
  };
}

// ─── Demo fixtures ────────────────────────────────────────────────────────────

function getDemoRunbook(scenario) {
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const disclaimer = `Generated from live state at ${now}. Validate against your change window.`;

  const runbooks = {
    'cm-stuck': buildCmRunbook({
      queues: [
        { name: 'STANDARD', running: 2, max: 5, controlCode: 'R' },
        { name: 'SHORT', running: 0, max: 2, controlCode: null }
      ],
      processes: [
        { osPid: '28741', queueName: 'STANDARD', statusCode: 'A' },
        { osPid: '28742', queueName: 'STANDARD', statusCode: 'A' }
      ]
    }),
    'opp-zero': buildOppRunbook({
      processes: [{ osPid: '31105', statusCode: 'A', backlog: 14 }],
      totalBacklog: 14
    }),
    'wfmailer-stall': buildWfMailerRunbook({
      stuckCount: 47,
      mailerStatus: { name: 'Workflow Mailer - Internal', status: 'RUNNING' }
    }),
    'adop-cleanup': buildAdopRunbook({
      sessions: [
        { sessionId: '1042', status: 'F', nodeStatus: null, appliedFsDir: '/u01/fs1', patchFsDir: '/u01/fs2' }
      ]
    }),
    'adop-patch-active': buildAdopPatchActiveRunbook({
      patchServices: ['EBSDEV_ebs_patch', 'EBSDB_ebs_patch'],
      phase: 'apply',
      sessionRow: { ADOP_SESSION_ID: '1051', STATUS: 'R', APPLY_DATE: new Date().toISOString() }
    })
  };

  const runbook = runbooks[scenario];
  if (!runbook) return null;
  return { ...runbook, is_demo: true, generated_at: new Date().toISOString(), disclaimer };
}

// ─── adop-patch-active runbook ────────────────────────────────────────────────
//
// Runbook #5: ADOP patch in progress — what to do and not do.
// This is an advisory runbook — no destructive commands. Detection reads
// V$ACTIVE_SERVICES + AD_ADOP_SESSIONS to surface current phase.
// Safe to call at any ADOP phase.

async function detectAdopPatchActive(connection) {
  const detectionQuery = `
SELECT name, network_name
FROM   V$ACTIVE_SERVICES
WHERE  LOWER(name) LIKE '%_ebs_patch'
ORDER  BY name`.trim();

  const servicesResult = await connection.execute(
    `SELECT name FROM V$ACTIVE_SERVICES WHERE LOWER(name) LIKE '%_ebs_patch' ORDER BY name`,
    [],
    { outFormat: require('oracledb').OUT_FORMAT_ARRAY }
  );

  const patchServices = (servicesResult.rows || []).map(r => r[0]);

  let sessionRow = null;
  try {
    const sessResult = await connection.execute(
      `SELECT s.adop_session_id, s.status, s.node_status,
              s.prepare_date, s.apply_date, s.finalize_date, s.cutover_date,
              s.cleanup_date, s.abandon_date
       FROM   AD_ADOP_SESSIONS s
       WHERE  s.status NOT IN ('C','A')
       ORDER  BY s.adop_session_id DESC
       FETCH  FIRST 1 ROWS ONLY`,
      [],
      { outFormat: require('oracledb').OUT_FORMAT_OBJECT }
    );
    sessionRow = sessResult.rows[0] || null;
  } catch (_) { /* APPS views not accessible — service-based detection only */ }

  // Derive phase from which date columns are populated
  const PHASE_MAP = [
    { col: 'ABANDON_DATE',  phase: 'abort'    },
    { col: 'CLEANUP_DATE',  phase: 'cleanup'  },
    { col: 'CUTOVER_DATE',  phase: 'cutover'  },
    { col: 'FINALIZE_DATE', phase: 'finalize' },
    { col: 'APPLY_DATE',    phase: 'apply'    },
    { col: 'PREPARE_DATE',  phase: 'prepare'  },
  ];
  let phase = null;
  if (sessionRow) {
    for (const { col, phase: p } of [...PHASE_MAP].reverse()) {
      if (sessionRow[col] != null) { phase = p; break; }
    }
  }

  return {
    detected: patchServices.length > 0,
    liveData: { patchServices, phase, sessionRow },
    detectionQuery,
    verificationQuery: `SELECT COUNT(*) patch_svc_count FROM V$ACTIVE_SERVICES WHERE LOWER(name) LIKE '%_ebs_patch'`
  };
}

function buildAdopPatchActiveRunbook(liveData) {
  const { patchServices, phase, sessionRow } = liveData;
  const phaseLabel = phase ? phase.toUpperCase() : 'UNKNOWN';
  const sessionId  = sessionRow ? sessionRow.ADOP_SESSION_ID : null;

  const steps = [
    {
      title: '1. Confirm the current ADOP phase',
      description: `The following patch-mode services are registered in V$ACTIVE_SERVICES: ${patchServices.length > 0 ? patchServices.join(', ') : '(check live — none fetched in demo)'}.`,
      commands: [
        `SELECT name, network_name FROM V$ACTIVE_SERVICES WHERE LOWER(name) LIKE '%_ebs_patch'`,
        `SELECT adop_session_id, status, node_status, prepare_date, apply_date, cutover_date FROM AD_ADOP_SESSIONS WHERE status NOT IN ('C','A') ORDER BY adop_session_id DESC`,
      ],
      notes: `Current phase: ${phaseLabel}${sessionId ? ` (session ${sessionId})` : ''}. The phase determines what is safe.`,
    },
    {
      title: '2. Do NOT bounce Concurrent Managers',
      description: 'ICM and CM bounces are managed by ADOP during cutover. Manual bounces will abort the patch cycle.',
      commands: [
        `SELECT q.concurrent_queue_name, q.running_processes, q.max_processes, q.control_code FROM apps.fnd_concurrent_queues q WHERE q.enabled_flag = 'Y' ORDER BY q.concurrent_queue_name`,
      ],
      notes: 'READ-ONLY check. If CM appears stopped, this is expected during CUTOVER phase. Do not start it manually.',
    },
    {
      title: '3. Do NOT restart Workflow Mailer',
      description: 'WF Mailer is intentionally suspended during APPLY/CUTOVER phases.',
      commands: [
        `SELECT node_name, status, component_type FROM apps.fnd_svc_components WHERE component_type LIKE '%MAILER%'`,
      ],
      notes: 'READ-ONLY check. MAILER_STOP during APPLY is ADOP-managed. Restarting it mid-apply corrupts WF state.',
    },
    {
      title: '4. Monitor tablespace growth (safe)',
      description: 'ADOP APPLY generates significant redo and can grow UNDO and TEMP tablespaces. Monitor these.',
      commands: [
        `SELECT tablespace_name, ROUND(used_space*8192/1073741824,2) used_gb, ROUND(tablespace_size*8192/1073741824,2) total_gb, ROUND(used_percent,1) pct_used FROM dba_tablespace_usage_metrics WHERE used_percent > 70 ORDER BY used_percent DESC`,
      ],
      notes: 'If UNDO or TEMP exceeds 85%, notify the patching DBA. Do not auto-extend without approval.',
    },
    {
      title: '5. After cleanup — re-run health check',
      description: 'Once ADOP reaches CLEANUP (or FINALIZE on older versions), the system is back to steady state. Run a full TuneVault health check to get a clean baseline.',
      commands: [
        `SELECT adop_session_id, status, node_status, cleanup_date FROM AD_ADOP_SESSIONS WHERE adop_session_id = ${sessionId || '<SESSION_ID>'}`,
      ],
      notes: `Zero patch-mode services in V$ACTIVE_SERVICES confirms the patch cycle is complete. The TuneVault ADOP banner will clear automatically on the next health check.`,
    },
  ];

  return {
    title: 'ADOP Patch In Progress — Guidance & Monitoring',
    scenario: 'adop-patch-active',
    detected: patchServices.length > 0,
    detectedSummary: patchServices.length > 0
      ? `ADOP patch cycle active — phase: ${phaseLabel}${sessionId ? `, session ${sessionId}` : ''}. ${patchServices.length} patch-mode service(s) in V$ACTIVE_SERVICES.`
      : 'No active patch-mode services detected (running runbook preventively).',
    steps,
  };
}

// ─── Scenario map ─────────────────────────────────────────────────────────────

const VALID_SCENARIOS = ['cm-stuck', 'opp-zero', 'wfmailer-stall', 'adop-cleanup', 'adop-patch-active'];

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/control/runbook/:scenario
 *
 * Body: { connection_id?: number }  — optional; omit for demo data
 *
 * Runs detection queries against the user's Oracle connection, substitutes
 * real PIDs/queue names into deterministic command templates, and returns
 * a structured runbook with safety-validated command blocks.
 *
 * Safety: every command is validated against ALLOWED_COMMAND_PATTERNS +
 *         BLOCKED_PATTERNS before the response is sent. If validation fails,
 *         400 is returned — no partial runbook is emitted.
 */
router.post('/runbook/:scenario', requireAuth, async (req, res) => {
  const { scenario } = req.params;
  const { connection_id } = req.body || {};

  if (!VALID_SCENARIOS.includes(scenario)) {
    return res.status(400).json({
      error: `Unknown scenario "${scenario}". Valid: ${VALID_SCENARIOS.join(', ')}`
    });
  }

  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const disclaimer = `Generated from live state at ${now}. Validate against your change window.`;

  // No connection_id → return demo runbook
  if (!connection_id) {
    const demo = getDemoRunbook(scenario);
    if (!demo) return res.status(400).json({ error: 'Scenario not found' });
    return res.json(demo);
  }

  const conn = await getConnectionById(Number(connection_id), req.user.id).catch(() => null);
  if (!conn) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  // Proxy connections cannot run Oracle queries server-side — fall back to demo
  if (conn.connection_type === 'proxy') {
    const demo = getDemoRunbook(scenario);
    if (!demo) return res.status(400).json({ error: 'Scenario not found' });
    return res.json({ ...demo, is_proxy_fallback: true });
  }

  const oracle = getOracleClient();
  if (!oracle) {
    return res.status(503).json({ error: 'Oracle client unavailable' });
  }

  let oracleConn;
  try {
    const oracledb = require('oracledb');
    oracleConn = await oracledb.getConnection({
      user: conn.username,
      password: decrypt(conn.encrypted_password),
      connectString: `${conn.host}:${conn.port || 1521}/${conn.service_name}`
    });

    // Run detection for the requested scenario
    let detection;
    if (scenario === 'cm-stuck') {
      detection = await detectCmStuck(oracleConn);
    } else if (scenario === 'opp-zero') {
      detection = await detectOppZero(oracleConn);
    } else if (scenario === 'wfmailer-stall') {
      detection = await detectWfMailerStall(oracleConn);
    } else if (scenario === 'adop-cleanup') {
      detection = await detectAdopCleanup(oracleConn);
    } else if (scenario === 'adop-patch-active') {
      detection = await detectAdopPatchActive(oracleConn);
    }

    // Build the runbook from live data
    let runbook;
    if (scenario === 'cm-stuck') {
      runbook = buildCmRunbook(detection.liveData);
    } else if (scenario === 'opp-zero') {
      runbook = buildOppRunbook(detection.liveData);
    } else if (scenario === 'wfmailer-stall') {
      runbook = buildWfMailerRunbook(detection.liveData);
    } else if (scenario === 'adop-cleanup') {
      runbook = buildAdopRunbook(detection.liveData);
    } else if (scenario === 'adop-patch-active') {
      runbook = buildAdopPatchActiveRunbook(detection.liveData);
    }

    // Safety validation — reject if any command fails the whitelist check
    const violations = validateRunbook(runbook.steps);
    if (violations.length > 0) {
      console.error('[control-runbook] SAFETY VIOLATION in runbook:', violations);
      return res.status(400).json({
        error: 'Runbook blocked by safety validator',
        violations
      });
    }

    return res.json({
      ...runbook,
      is_demo: false,
      is_live: true,
      generated_at: new Date().toISOString(),
      disclaimer,
      detection_query: detection.detectionQuery,
      verification_query: detection.verificationQuery
    });

  } catch (err) {
    console.error(`[control-runbook] Error generating runbook for scenario=${scenario}:`, err);
    return res.status(500).json({ error: 'Runbook generation failed', detail: err.message });
  } finally {
    if (oracleConn) {
      try { await oracleConn.close(); } catch (_) { /* ignore */ }
    }
  }
});

module.exports = router;
