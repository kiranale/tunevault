/**
 * routes/ebs-deep.js — Deep EBS Mode page and API endpoints.
 *
 * Owns: /ebs-deep page + /api/ebs-deep/* endpoints.
 *   Panel 1: EBS Live Status — read-only health view via queryEbsDeepStatus
 *   Panel 2: SSH Command Control — whitelist-only dry-run (Phase 1: display only)
 *
 * Does NOT own: auth state, Oracle connection storage, health check execution.
 *
 * Mounted at: / (see server.js: app.use('/', require('./routes/ebs-deep')))
 *
 * Routes:
 *   GET  /ebs-deep                  — serve the page (redirects to /signin if not authed)
 *   GET  /api/ebs-deep/connections  — list EBS-detected connections for this user
 *   POST /api/ebs-deep/status       — run queryEbsDeepStatus against a connection
 *   POST /api/ebs-deep/dry-run      — return the exact shell command string (no execution)
 */

'use strict';

const express = require('express');
const path    = require('path');

const pool               = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { getEbsConnections, getConnectionById, insertSanityRun, getLatestSanityRun } = require('../db/ebs-deep');
const { decrypt }        = require('../crypto-utils');

const router = express.Router();

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── SSH Command Whitelist ────────────────────────────────────────────────────
//
// Hard-coded EBS 12.2.x command whitelist. All paths use $ADMIN_SCRIPTS_HOME.
// $FND_TOP/bin/wfmlrctl.sh is NOT in this list — operator confirmed it does
// not exist in their EBS 12.2.12 install. Use admanagedsrvctl.sh wfmlrsvc instead.
// Phase 1: dry-run only. No SSH execution occurs in this route.

const EBS_COMMANDS = [
  {
    id: 'alln-status',
    category: 'Apps Listener',
    label: 'Apps Listener — Status',
    description: 'Check the current status of the Oracle Applications TNS Listener. Required for client connectivity to EBS application tier.',
    script: '$ADMIN_SCRIPTS_HOME/adalnctl.sh',
    args: 'status',
    action: 'status',
    safe: true
  },
  {
    id: 'alln-start',
    category: 'Apps Listener',
    label: 'Apps Listener — Start',
    description: 'Start the Oracle Applications TNS Listener. Run this if the listener is down and EBS clients cannot connect.',
    script: '$ADMIN_SCRIPTS_HOME/adalnctl.sh',
    args: 'start',
    action: 'start',
    safe: false
  },
  {
    id: 'alln-stop',
    category: 'Apps Listener',
    label: 'Apps Listener — Stop',
    description: 'Stop the Oracle Applications TNS Listener. This disconnects all active EBS sessions.',
    script: '$ADMIN_SCRIPTS_HOME/adalnctl.sh',
    args: 'stop',
    action: 'stop',
    safe: false
  },
  {
    id: 'oacore-start',
    category: 'Managed Servers',
    label: 'OACore — Start',
    description: 'Start the OACore managed server. Required for OA Framework self-service pages and most EBS modules.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'start oacore_server1',
    action: 'start',
    safe: false
  },
  {
    id: 'oacore-stop',
    category: 'Managed Servers',
    label: 'OACore — Stop',
    description: 'Stop the OACore managed server. Disconnects all active OA Framework sessions.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'stop oacore_server1',
    action: 'stop',
    safe: false
  },
  {
    id: 'forms-start',
    category: 'Managed Servers',
    label: 'Forms Server — Start',
    description: 'Start the Forms managed server. Required for all Oracle Forms-based EBS screens.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'start forms_server1',
    action: 'start',
    safe: false
  },
  {
    id: 'forms-stop',
    category: 'Managed Servers',
    label: 'Forms Server — Stop',
    description: 'Stop the Forms managed server. Disconnects all active Forms sessions.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'stop forms_server1',
    action: 'stop',
    safe: false
  },
  {
    id: 'oafm-start',
    category: 'Managed Servers',
    label: 'OAFM — Start',
    description: 'Start the OA Framework Mobile (OAFM) managed server.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'start oafm_server1',
    action: 'start',
    safe: false
  },
  {
    id: 'oafm-stop',
    category: 'Managed Servers',
    label: 'OAFM — Stop',
    description: 'Stop the OA Framework Mobile (OAFM) managed server.',
    script: '$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh',
    args: 'stop oafm_server1',
    action: 'stop',
    safe: false
  },
  {
    id: 'cm-start',
    category: 'Concurrent Manager',
    label: 'Concurrent Manager — Start',
    description: 'Start the Internal Concurrent Manager. This starts all other Concurrent Managers and resumes background job processing.',
    script: '$ADMIN_SCRIPTS_HOME/adcmctl.sh',
    args: 'start',
    action: 'start',
    safe: false
  },
  {
    id: 'cm-stop',
    category: 'Concurrent Manager',
    label: 'Concurrent Manager — Stop',
    description: 'Stop the Internal Concurrent Manager. In-flight requests complete before shutdown.',
    script: '$ADMIN_SCRIPTS_HOME/adcmctl.sh',
    args: 'stop',
    action: 'stop',
    safe: false
  },
  {
    id: 'opmn-status',
    category: 'OPMN',
    label: 'OPMN — Status',
    description: 'Check OPMN (Oracle Process Manager) status. Shows state of all OPMN-managed processes including HTTP Server.',
    script: '$ADMIN_SCRIPTS_HOME/adopmnctl.sh',
    args: 'status',
    action: 'status',
    safe: true
  },
  {
    id: 'opmn-start',
    category: 'OPMN',
    label: 'OPMN — Start',
    description: 'Start OPMN and all OPMN-managed services.',
    script: '$ADMIN_SCRIPTS_HOME/adopmnctl.sh',
    args: 'start',
    action: 'start',
    safe: false
  },
  {
    id: 'opmn-stop',
    category: 'OPMN',
    label: 'OPMN — Stop',
    description: 'Stop OPMN. This shuts down Oracle HTTP Server and other OPMN-managed processes.',
    script: '$ADMIN_SCRIPTS_HOME/adopmnctl.sh',
    args: 'stop',
    action: 'stop',
    safe: false
  },
  {
    id: 'startup-all',
    category: 'Full Tier',
    label: 'Full Application Tier Startup',
    description: 'Start all application-tier components in correct dependency order. Requires apps schema password. Password is masked in all logs and never stored.',
    script: '$ADMIN_SCRIPTS_HOME/adstrtal.sh',
    args: 'apps/<pw>',
    action: 'start',
    safe: false,
    requiresPassword: true
  },
  {
    id: 'shutdown-all',
    category: 'Full Tier',
    label: 'Full Application Tier Shutdown',
    description: 'Gracefully stop all application-tier components in correct order. Requires apps schema password. Password is masked in all logs and never stored.',
    script: '$ADMIN_SCRIPTS_HOME/adstpall.sh',
    args: 'apps/<pw>',
    action: 'stop',
    safe: false,
    requiresPassword: true
  }
];

// Build a quick lookup map by id for validation
const COMMAND_MAP = {};
for (const cmd of EBS_COMMANDS) {
  COMMAND_MAP[cmd.id] = cmd;
}

// ─── Demo fixture data for EBS Live Status ────────────────────────────────────
//
// Demo shows realistic mixed states (not all green).
// ebs_only services (wf_mailer, opp) are included here since demo implies EBS context.
// source field: db_only | tcp_probe | db_plus_tcp | shell_required
//   db_only     — queried from Oracle metadata; app tier may be down
//   tcp_probe   — TCP port reachability via proxy
//   db_plus_tcp — composite: DB metadata cross-checked with TCP probe
//   shell_required — Phase 3 SSH-verified only (not yet implemented)

function getDemoEbsStatus() {
  return {
    is_demo: true,
    ebs_detected: true,
    fetched_at: new Date().toISOString(),
    services: [
      { key: 'opmn',          label: 'OPMN',                  status: 'not_applicable', detail: 'Legacy Oracle AS (10g/11g) — not present on EBS 12.2+ WebLogic stack', source: 'tcp_probe',    ebs_only: false },
      { key: 'node_manager',  label: 'NodeManager',           status: 'UP',             detail: 'Port 5556 reachable',                                                    source: 'tcp_probe',    ebs_only: false },
      { key: 'wls_admin',     label: 'WebLogic Admin Server', status: 'UP',             detail: 'DB: ACTIVE | TCP port 7001 reachable',                                   source: 'db_plus_tcp',  ebs_only: false },
      { key: 'apps_listener', label: 'Apps Listener',         status: 'UP',             detail: 'Port 1521',                                                              source: 'db_only',      ebs_only: false },
      { key: 'apache',        label: 'Apache',                status: 'UP',             detail: 'adapcctl.sh',                                                            source: 'db_only',      ebs_only: false },
      { key: 'oacore',        label: 'OACore',                status: 'RUNNING',        detail: 'admanagedsrvctl.sh',                                                     source: 'db_only',      ebs_only: false },
      { key: 'forms',         label: 'Forms',                 status: 'RUNNING',        detail: 'admanagedsrvctl.sh',                                                     source: 'db_only',      ebs_only: false },
      { key: 'oafm',          label: 'OAFM',                  status: 'DOWN',           detail: 'admanagedsrvctl.sh',                                                     source: 'db_only',      ebs_only: false },
      { key: 'cm',            label: 'Concurrent Managers',   status: 'UP',             detail: '12 / 15 processes',                                                      source: 'db_only',      ebs_only: false },
      { key: 'wf_mailer',     label: 'Workflow Mailer',       status: 'UP',             detail: '1 pending > 2h',                                                         source: 'db_only',      ebs_only: true  },
      { key: 'opp',           label: 'OPP',                   status: 'UP',             detail: 'Queue: 0',                                                               source: 'db_only',      ebs_only: true  }
    ],
    concurrent_manager: {
      status: 'UP',
      running_processes: 12,
      target_processes: 15,
      pending_requests: 3,
      error_requests_24h: 0
    },
    workflow_mailer: {
      status: 'UP',
      stuck_count: 0,
      error_count: 0,
      pending_over_2h: 1
    },
    opp: {
      status: 'UP',
      queue_depth: 0
    }
  };
}

// ─── queryEbsDeepStatus — scoped to this page only, not regular reports ───────
//
// This function re-adds EBS status queries removed in task #1512871.
// Scope: /ebs-deep page only. NOT used in collectMetrics() or report generation.
//
// Service source attribution:
//   db_only     — Oracle metadata only; valid even when app tier is down
//   tcp_probe   — TCP reachability check via proxy agent
//   db_plus_tcp — DB metadata cross-checked with TCP probe (composite signal)
//   shell_required — Needs SSH execution (Phase 3); currently not implemented
//
// Node Manager vs OPMN distinction:
//   Node Manager = WebLogic 12c daemon on port 5556. Separate from OPMN.
//   OPMN = legacy Oracle AS 10g/11g on port 6200. Not present on EBS 12.2+ WebLogic stacks.
//
// WLS Admin Server: We do NOT shell out to adadminsrvctl.sh — it requires APPS+WLS
// passwords which we have no vault for. Instead we use fnd_nodes + fnd_oam_managed_types
// for DB-side state, plus TCP probe on the admin port. Documented on the card tooltip.

async function queryEbsDeepStatus(oracleClient, connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 20
    });

    async function safeExec(sql) {
      try {
        return await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      } catch (e) {
        return null;
      }
    }

    // ── Concurrent Manager (FNDICM) — source: db_only ───────────────────────
    let cm = { status: 'UNKNOWN', running_processes: 0, target_processes: 0, pending_requests: 0, error_requests_24h: 0 };
    const cmR = await safeExec(`SELECT running_processes, max_processes, target_processes, control_code
      FROM apps.fnd_concurrent_queues_vl WHERE concurrent_queue_name = 'FNDICM' AND enabled_flag = 'Y'`);
    if (cmR && cmR.rows && cmR.rows[0]) {
      const r = cmR.rows[0];
      const running = Number(r[0]) || 0;
      const target  = Number(r[2]) || Number(r[1]) || 0;
      cm.running_processes = running;
      cm.target_processes  = target;
      cm.status = running > 0 ? 'UP' : 'DOWN';
    }
    const pendR = await safeExec(`SELECT COUNT(*) FROM apps.fnd_concurrent_requests WHERE phase_code = 'P' AND status_code = 'I'`);
    if (pendR && pendR.rows) cm.pending_requests = Number(pendR.rows[0]?.[0]) || 0;
    const errR = await safeExec(`SELECT COUNT(*) FROM apps.fnd_concurrent_requests WHERE status_code IN ('E','X','D') AND actual_completion_date > SYSDATE - 1`);
    if (errR && errR.rows) cm.error_requests_24h = Number(errR.rows[0]?.[0]) || 0;

    // ── Workflow Mailer — source: db_only (EBS-only service) ─────────────────
    // Valid even when app tier is down — WF_NOTIFICATION_MAILER is DB-resident.
    let wf = { status: 'UNKNOWN', stuck_count: 0, error_count: 0, pending_over_2h: 0 };
    const wfR = await safeExec(`SELECT component_status FROM apps.fnd_svc_components
      WHERE component_type LIKE 'WF_MAILER%' AND ROWNUM = 1`);
    if (wfR && wfR.rows && wfR.rows[0]) {
      wf.status = String(wfR.rows[0][0] || 'UNKNOWN').toUpperCase() === 'RUNNING' ? 'UP' : 'DOWN';
    }
    const stuckR = await safeExec(`SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = 'MAIL' AND status = 'OPEN' AND begin_date < SYSDATE - 1/24`);
    if (stuckR && stuckR.rows) wf.stuck_count = Number(stuckR.rows[0]?.[0]) || 0;
    const wfErrR = await safeExec(`SELECT COUNT(*) FROM apps.wf_error`);
    if (wfErrR && wfErrR.rows) wf.error_count = Number(wfErrR.rows[0]?.[0]) || 0;
    const pendMailR = await safeExec(`SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = 'MAIL' AND status = 'OPEN' AND begin_date < SYSDATE - 2/24`);
    if (pendMailR && pendMailR.rows) wf.pending_over_2h = Number(pendMailR.rows[0]?.[0]) || 0;

    // ── OPP — source: db_only (EBS-only service) ─────────────────────────────
    // Output Post Processor queried via FND_SVC_COMPONENTS and request queue.
    let opp = { status: 'UNKNOWN', queue_depth: 0 };
    const oppR = await safeExec(`SELECT component_status FROM apps.fnd_svc_components
      WHERE component_name LIKE '%Output Post%' AND ROWNUM = 1`);
    if (oppR && oppR.rows && oppR.rows[0]) {
      opp.status = String(oppR.rows[0][0] || 'UNKNOWN').toUpperCase() === 'RUNNING' ? 'UP' : 'DOWN';
    }
    const oppQR = await safeExec(`SELECT COUNT(*) FROM apps.fnd_concurrent_requests WHERE phase_code = 'P' AND concurrent_program_name = 'FNDCPOPP'`);
    if (oppQR && oppQR.rows) opp.queue_depth = Number(oppQR.rows[0]?.[0]) || 0;

    // ── Helper: query fnd_svc_components by search term — source: db_only ────
    async function queryComponentStatus(searchTerm) {
      const r = await safeExec(`SELECT component_status FROM apps.fnd_svc_components
        WHERE (LOWER(component_type) LIKE '%${searchTerm}%' OR LOWER(component_name) LIKE '%${searchTerm}%') AND ROWNUM = 1`);
      if (!r || !r.rows || !r.rows[0]) return 'UNKNOWN';
      const s = String(r.rows[0][0] || 'UNKNOWN').toUpperCase();
      return (s === 'RUNNING' || s === 'UP') ? 'RUNNING' : 'DOWN';
    }

    // ── OPMN — Oracle Process Manager 10g/11g, port 6200 — source: tcp_probe ─
    // OPMN is the legacy process manager for Oracle AS / Forms 11g.
    // On EBS 12.2+ (WebLogic stack) OPMN is typically absent.
    // Probe: TCP check on port 6200. If absent, report not_applicable rather than DOWN.
    // We do NOT read fnd_svc_components for OPMN — that table doesn't differentiate
    // it from WebLogic services.
    let opmnStatus = 'not_applicable';
    let opmnDetail = 'Legacy Oracle AS process manager — not present on EBS 12.2+ WebLogic stack';
    try {
      const net = require('net');
      const opmnReachable = await new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(4000);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.connect(6200, connParams.host);
      });
      if (opmnReachable) {
        opmnStatus = 'UP';
        opmnDetail = 'Port 6200 reachable (Oracle AS 10g/11g OPMN)';
      }
      // If not reachable and we already know this is 12.2 stack, keep not_applicable.
      // If OPMN was expected but port closed, that's ambiguous — keep not_applicable
      // unless we have positive evidence it should be there. Conservative choice here.
    } catch (_e) { /* TCP probe failure — keep not_applicable */ }

    // ── Node Manager — WebLogic 12c, port 5556 — source: tcp_probe ───────────
    // Node Manager is the WebLogic daemon that starts/stops managed servers.
    // Distinct from OPMN — do NOT share logic.
    // Probe: TCP check on port 5556. If reachable, the NM process is accepting connections.
    let nmStatus = 'UNKNOWN';
    let nmDetail = 'Port 5556 — WLS NodeManager';
    try {
      const net = require('net');
      const nmReachable = await new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(4000);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.connect(5556, connParams.host);
      });
      nmStatus = nmReachable ? 'UP' : 'DOWN';
      nmDetail = nmReachable ? 'Port 5556 reachable' : 'Port 5556 unreachable';
    } catch (_e) { nmStatus = 'UNKNOWN'; }

    // ── WebLogic Admin Server — source: db_plus_tcp ───────────────────────────
    // We do NOT use adadminsrvctl.sh — it requires APPS+WLS passwords (no vault yet).
    // Instead: query fnd_nodes for the admin server node + fnd_oam_managed_types for
    // declared admin server state, then TCP-probe the admin port (default 7001).
    // If both align → running. If TCP fails → down. If state mismatch → warn.
    // Phase 3 SSH control will add adadminsrvctl.sh status once secrets vault ships.
    let wlsStatus = 'UNKNOWN';
    let wlsDetail = 'DB metadata + TCP probe — not shell-verified';
    try {
      // 1. DB: look up admin server state via fnd_oam_managed_types if available
      let dbState = null;
      const wlsDbR = await safeExec(`SELECT target_status FROM apps.fnd_oam_managed_types
        WHERE LOWER(type_name) LIKE '%adminserver%' AND ROWNUM = 1`);
      if (wlsDbR && wlsDbR.rows && wlsDbR.rows[0]) {
        const raw = String(wlsDbR.rows[0][0] || '').toUpperCase();
        dbState = (raw === 'RUNNING' || raw === 'ACTIVE') ? 'UP' : 'DOWN';
      }

      // 2. Try to read the WLS admin port from context-style profile
      let wlsPort = 7001;
      const wlsPortR = await safeExec(`SELECT profile_option_value FROM apps.fnd_profile_option_values
        WHERE profile_option_name = 'S_WLS_ADMINPORT' AND level_id = 10001 AND ROWNUM = 1`);
      if (wlsPortR && wlsPortR.rows && wlsPortR.rows[0]) {
        const p = Number(wlsPortR.rows[0][0]);
        if (p > 0 && p < 65536) wlsPort = p;
      }

      // 3. TCP probe
      const net = require('net');
      const wlsTcpUp = await new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(4000);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.connect(wlsPort, connParams.host);
      });

      // Composite decision
      if (dbState === 'UP' && wlsTcpUp) {
        wlsStatus = 'UP';
        wlsDetail = `DB: ACTIVE | TCP port ${wlsPort} reachable`;
      } else if (dbState === 'DOWN' || !wlsTcpUp) {
        wlsStatus = 'DOWN';
        wlsDetail = `${dbState === 'DOWN' ? 'DB: not-ACTIVE' : 'DB: n/a'} | TCP port ${wlsPort} ${wlsTcpUp ? 'reachable' : 'unreachable'}`;
      } else {
        // dbState null (table absent) — rely on TCP only
        wlsStatus = wlsTcpUp ? 'UP' : 'DOWN';
        wlsDetail = `TCP port ${wlsPort} ${wlsTcpUp ? 'reachable' : 'unreachable'} (no DB metadata)`;
      }
    } catch (_e) { wlsStatus = 'UNKNOWN'; }

    // ── Apache (Oracle HTTP Server) — source: db_only ─────────────────────────
    const apacheStatus = await queryComponentStatus('http');

    // ── Managed servers: oacore, forms, oafm — source: db_only ───────────────
    const oacoreStatus = await queryComponentStatus('oacore');
    const formsStatus  = await queryComponentStatus('forms');
    const oafmStatus   = await queryComponentStatus('oafm');

    // ── Apps Listener — source: db_only ───────────────────────────────────────
    let listenerPort = 1521;
    let listenerStatus = 'UNKNOWN';
    const lisR = await safeExec(`SELECT metval_clob FROM apps.fnd_oam_metval WHERE metname = 'APPS_JDBC_URL' AND ROWNUM = 1`);
    if (lisR && lisR.rows && lisR.rows[0]) {
      const url = String(lisR.rows[0][0] || '');
      const portMatch = url.match(/:(\d+)\//);
      listenerPort = portMatch ? Number(portMatch[1]) : 1521;
      listenerStatus = 'UP';
    }

    // ── Build 11 service cards ────────────────────────────────────────────────
    const services = [
      { key: 'opmn',          label: 'OPMN',                  status: opmnStatus,     detail: opmnDetail,                                                                  source: 'tcp_probe',    ebs_only: false },
      { key: 'node_manager',  label: 'NodeManager',           status: nmStatus,       detail: nmDetail,                                                                    source: 'tcp_probe',    ebs_only: false },
      { key: 'wls_admin',     label: 'WebLogic Admin Server', status: wlsStatus,      detail: wlsDetail,                                                                   source: 'db_plus_tcp',  ebs_only: false },
      { key: 'apps_listener', label: 'Apps Listener',         status: listenerStatus, detail: `Port ${listenerPort}`,                                                       source: 'db_only',      ebs_only: false },
      { key: 'apache',        label: 'Apache',                status: apacheStatus,   detail: 'Oracle HTTP Server (adapcctl.sh)',                                           source: 'db_only',      ebs_only: false },
      { key: 'oacore',        label: 'OACore',                status: oacoreStatus,   detail: 'OA Framework managed server',                                               source: 'db_only',      ebs_only: false },
      { key: 'forms',         label: 'Forms',                 status: formsStatus,    detail: 'Oracle Forms managed server',                                               source: 'db_only',      ebs_only: false },
      { key: 'oafm',          label: 'OAFM',                  status: oafmStatus,     detail: 'OA Framework Mobile managed server',                                        source: 'db_only',      ebs_only: false },
      { key: 'cm',            label: 'Concurrent Managers',   status: cm.status,      detail: `${cm.running_processes} / ${cm.target_processes} processes`,                source: 'db_only',      ebs_only: false },
      { key: 'wf_mailer',     label: 'Workflow Mailer',       status: wf.status,      detail: wf.pending_over_2h > 0 ? `${wf.pending_over_2h} pending > 2h` : 'OK',       source: 'db_only',      ebs_only: true  },
      { key: 'opp',           label: 'OPP',                   status: opp.status,     detail: `Queue: ${opp.queue_depth}`,                                                 source: 'db_only',      ebs_only: true  }
    ];

    return {
      is_demo: false,
      ebs_detected: true,
      fetched_at: new Date().toISOString(),
      services,
      concurrent_manager: cm,
      workflow_mailer: wf,
      opp
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * GET /ebs-deep — serve the page; redirect to /signin if unauthenticated.
 */
router.get('/ebs-deep', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-deep.html'));
});

/**
 * GET /ebs-status-sources — public help page: how each EBS Live Status card is sourced.
 * No auth required — informational reference page linked from Monitor tab.
 */
router.get('/ebs-status-sources', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-status-sources.html'));
});

/**
 * GET /api/ebs-deep/connections — list EBS-detected connections for the current user.
 * Returns [] if no EBS connections exist (page shows empty state).
 */
router.get('/api/ebs-deep/connections', requireAuth, async (req, res) => {
  try {
    const connections = await getEbsConnections(req.user.id);
    res.json({ connections });
  } catch (err) {
    console.error('[ebs-deep] Error fetching connections:', err);
    res.status(500).json({ error: 'Failed to fetch EBS connections' });
  }
});

/**
 * GET /api/ebs-deep/commands — return the full command whitelist (no execution).
 * Used by the UI to render command cards.
 */
router.get('/api/ebs-deep/commands', requireAuth, (req, res) => {
  // Strip requiresPassword details from client-facing list (keep label + shell string)
  const safe = EBS_COMMANDS.map(({ id, category, label, description, script, args, action, safe: isSafe, requiresPassword }) => ({
    id, category, label, description,
    shell: `${script} ${args}`,
    action,
    safe: isSafe,
    requiresPassword: !!requiresPassword
  }));
  res.json({ commands: safe });
});

/**
 * POST /api/ebs-deep/status — run queryEbsDeepStatus against a saved connection.
 * Falls back to demo fixture if connection_id is missing or connection is proxy-only.
 *
 * Body: { connection_id: number }
 */
router.post('/api/ebs-deep/status', requireAuth, async (req, res) => {
  try {
    const { connection_id } = req.body;

    // No connection_id → return demo data
    if (!connection_id) {
      return res.json(getDemoEbsStatus());
    }

    const conn = await getConnectionById(Number(connection_id), req.user.id);
    if (!conn) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Proxy connections cannot run direct Oracle queries from the server side
    if (conn.connection_type === 'proxy') {
      return res.json(getDemoEbsStatus());
    }

    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({ error: 'Oracle client unavailable' });
    }

    const connParams = {
      host: conn.host,
      port: conn.port || 1521,
      serviceName: conn.service_name,
      username: conn.username,
      password: decrypt(conn.encrypted_password)
    };

    const status = await queryEbsDeepStatus(oracle, connParams);
    res.json(status);
  } catch (err) {
    console.error('[ebs-deep] Error fetching EBS status:', err);
    res.status(500).json({ error: 'Failed to fetch EBS status' });
  }
});

/**
 * POST /api/ebs-deep/dry-run — return the exact shell command string.
 * Phase 1: display only. No SSH execution.
 * Rejects any command_id not in the hard-coded whitelist.
 *
 * Body: { command_id: string }
 */
router.post('/api/ebs-deep/dry-run', requireAuth, async (req, res) => {
  try {
    const { command_id } = req.body;

    if (!command_id || typeof command_id !== 'string') {
      return res.status(400).json({ error: 'command_id is required' });
    }

    const cmd = COMMAND_MAP[command_id];
    if (!cmd) {
      return res.status(400).json({ error: 'Command not in whitelist', command_id });
    }

    // Phase 1 — dry-run only
    const shell = `${cmd.script} ${cmd.args}`;
    res.json({
      command_id: cmd.id,
      label: cmd.label,
      shell,
      phase: 'dry_run',
      note: 'Dry-run mode — this command was NOT executed. SSH execution coming in Phase 3.'
    });
  } catch (err) {
    console.error('[ebs-deep] Error in dry-run:', err);
    res.status(500).json({ error: 'Dry-run failed' });
  }
});


// ─── EBS Sanity Check Engine ──────────────────────────────────────────────────
//
// 5 categories: FND_NODES, ADOP Filesystem, Profile Options,
//               Concurrent Manager Config, Workflow Mailer Config.
// Each category returns: { id, title, status, findings: [{level, message, hint}] }

/**
 * Demo fixture — deterministic, includes warn + fail badges.
 * Only fnd_nodes and profile_options are live; other 3 are Phase 2 placeholders.
 */
function getDemoSanityFindings() {
  return [
    {
      id: 'fnd_nodes',
      title: 'FND_NODES Consistency',
      status: 'warn',
      phase: 'live',
      sql_detail: [
        {
          label: 'All nodes (base query)',
          sql: `SELECT node_name, node_id, support_cp, support_forms, support_web, support_admin, status\nFROM apps.fnd_nodes\nORDER BY node_name`,
          rows: [
            { NODE_NAME: 'EBSAPP01', NODE_ID: 1, SUPPORT_CP: 'Y', SUPPORT_FORMS: 'Y', SUPPORT_WEB: 'Y', SUPPORT_ADMIN: 'Y', STATUS: 'Y' },
            { NODE_NAME: 'EBSAPP02', NODE_ID: 2, SUPPORT_CP: 'Y', SUPPORT_FORMS: 'N', SUPPORT_WEB: 'N', SUPPORT_ADMIN: 'N', STATUS: 'N' }
          ]
        },
        {
          label: 'Inactive nodes still referenced by concurrent queues',
          sql: `SELECT fn.node_name, fn.node_id, fn.status,\n       fn.support_cp, fn.support_forms, fn.support_web, fn.support_admin,\n       COUNT(fcq.concurrent_queue_id) AS queue_refs\nFROM apps.fnd_nodes fn\nJOIN apps.fnd_concurrent_queues fcq ON fcq.node_name = fn.node_name\nWHERE fn.status = 'N'\nGROUP BY fn.node_name, fn.node_id, fn.status,\n         fn.support_cp, fn.support_forms, fn.support_web, fn.support_admin`,
          rows: [{ NODE_NAME: 'EBSAPP02', STATUS: 'N', QUEUE_REFS: 3 }]
        }
      ],
      findings: [
        { level: 'warn', message: 'Node EBSAPP02 has STATUS=N but is still referenced by 3 concurrent queues.', hint: 'Decommission properly via adadmin, or re-activate the node if still in use.' },
        { level: 'pass', message: 'AUTHENTICATION node found — required system node is present.' },
        { level: 'pass', message: 'All active nodes have matching SERVER_ADDRESS entries.' },
        { level: 'pass', message: 'No orphaned node records found (active nodes not referenced by any queue or service).' },
        { level: 'pass', message: 'Admin node EBSAPP01 has SUPPORT_ADMIN=Y — role flag aligned.' }
      ]
    },
    {
      id: 'profile_options',
      title: 'Profile Options',
      status: 'warn',
      phase: 'live',
      sql_detail: [
        {
          label: 'Critical profile options at SITE level',
          sql: `SELECT fpo.profile_option_name, fpov.profile_option_value,\n       fpov.level_id, fpov.level_value\nFROM apps.fnd_profile_option_values fpov\nJOIN apps.fnd_profile_options fpo\n  ON fpo.application_id = fpov.application_id\n AND fpo.profile_option_id = fpov.profile_option_id\nWHERE fpo.profile_option_name IN (\n  'APPS_FRAMEWORK_AGENT','APPS_WEB_AGENT','APPS_SERVLET_AGENT',\n  'FND_DIAGNOSTICS','FND_SECURE_INTERNAL_AUTHENTICATION',\n  'ICX_SESSION_TIMEOUT','GUEST_USER_PWD','SITENAME',\n  'RRA_SERVICE_PREFIX','FND_SSO_URL'\n)\nAND fpov.level_id = 10001  -- SITE level`,
          rows: [
            { PROFILE_OPTION_NAME: 'APPS_FRAMEWORK_AGENT', PROFILE_OPTION_VALUE: 'https://ebs.company.internal:8443/OA_HTML', LEVEL_ID: 10001 },
            { PROFILE_OPTION_NAME: 'APPS_WEB_AGENT', PROFILE_OPTION_VALUE: 'https://ebs.company.internal:8443', LEVEL_ID: 10001 },
            { PROFILE_OPTION_NAME: 'ICX_SESSION_TIMEOUT', PROFILE_OPTION_VALUE: '30', LEVEL_ID: 10001 },
            { PROFILE_OPTION_NAME: 'FND_DIAGNOSTICS', PROFILE_OPTION_VALUE: 'Y', LEVEL_ID: 10001 },
            { PROFILE_OPTION_NAME: 'GUEST_USER_PWD', PROFILE_OPTION_VALUE: 'GUEST/ORACLE', LEVEL_ID: 10001 }
          ]
        }
      ],
      findings: [
        { level: 'pass', message: 'APPS_FRAMEWORK_AGENT is set at SITE level: https://ebs.company.internal:8443/OA_HTML' },
        { level: 'pass', message: 'APPS_WEB_AGENT is set at SITE level: https://ebs.company.internal:8443' },
        { level: 'warn', message: 'APPS_SERVLET_AGENT is not set at site level.', hint: "Set via: fnd_profile.save('APPS_SERVLET_AGENT', '<value>', 'SITE');" },
        { level: 'warn', message: 'FND_DIAGNOSTICS is set to Y at site level — this enables debug output and may expose internal data.', hint: "Set to N in non-dev environments: fnd_profile.save('FND_DIAGNOSTICS', 'N', 'SITE');" },
        { level: 'warn', message: 'FND_SECURE_INTERNAL_AUTHENTICATION is not set at site level.', hint: "Set via: fnd_profile.save('FND_SECURE_INTERNAL_AUTHENTICATION', 'SSWA', 'SITE');" },
        { level: 'pass', message: 'ICX_SESSION_TIMEOUT is set at SITE level: 30' },
        { level: 'pass', message: 'GUEST_USER_PWD is configured (non-default).' },
        { level: 'warn', message: 'SITENAME is not set at site level.', hint: "Set via: fnd_profile.save('SITENAME', '<your-site-name>', 'SITE');" },
        { level: 'warn', message: 'RRA_SERVICE_PREFIX is not set at site level.', hint: "Required for Report Manager. Set via: fnd_profile.save('RRA_SERVICE_PREFIX', '<prefix>', 'SITE');" },
        { level: 'warn', message: 'FND_SSO_URL is not set at site level.', hint: "Set only if Oracle SSO is in use. Otherwise leave unset." }
      ]
    },
    {
      id: 'adop_filesystem',
      title: 'ADOP Filesystem Sanity',
      status: 'pass',
      phase: 'live',
      sql_detail: [
        {
          label: 'Active ADOP sessions (ad_adop_sessions)',
          sql: `SELECT session_id, prepare_start_date, apply_start_date,\n       finalize_start_date, cutover_start_date, cleanup_start_date, session_status\nFROM apps.ad_adop_sessions\nWHERE session_status NOT IN ('X','F','C')\nORDER BY prepare_start_date DESC`,
          rows: []
        },
        {
          label: 'Stuck sessions (>7 days in PREPARE/APPLY/FINALIZE/CUTOVER with no cutover)',
          sql: `SELECT session_id, prepare_start_date, session_status\nFROM apps.ad_adop_sessions\nWHERE session_status IN ('P','A','F1','C1')\n  AND prepare_start_date < SYSDATE - 7\n  AND cutover_start_date IS NULL`,
          rows: []
        },
        {
          label: 'Failed sessions not yet cleaned up (last 30 days)',
          sql: `SELECT session_id, session_status, prepare_start_date\nFROM apps.ad_adop_sessions\nWHERE session_status = 'F'\n  AND cleanup_start_date IS NULL\n  AND prepare_start_date > SYSDATE - 30`,
          rows: []
        }
      ],
      findings: [
        { level: 'pass', message: 'No stuck or failed ADOP patch cycles found — filesystem sanity OK.' }
      ]
    },
    {
      id: 'cm_config',
      title: 'Concurrent Manager Config',
      status: 'warn',
      phase: 'live',
      sql_detail: [
        {
          label: 'All enabled concurrent queues (target vs running)',
          sql: `SELECT concurrent_queue_name, target_processes, running_processes,\n       enabled_flag, cache_size\nFROM apps.fnd_concurrent_queues\nWHERE enabled_flag = 'Y'\nORDER BY concurrent_queue_name`,
          rows: [
            { CONCURRENT_QUEUE_NAME: 'FNDICM', TARGET_PROCESSES: 1, RUNNING_PROCESSES: 1, ENABLED_FLAG: 'Y', CACHE_SIZE: 0 },
            { CONCURRENT_QUEUE_NAME: 'STANDARD', TARGET_PROCESSES: 10, RUNNING_PROCESSES: 10, ENABLED_FLAG: 'Y', CACHE_SIZE: 3 },
            { CONCURRENT_QUEUE_NAME: 'WFMLRSVC', TARGET_PROCESSES: 1, RUNNING_PROCESSES: 1, ENABLED_FLAG: 'Y', CACHE_SIZE: 0 }
          ]
        },
        {
          label: 'Enabled queues with target_processes=0',
          sql: `SELECT concurrent_queue_name, target_processes\nFROM apps.fnd_concurrent_queues\nWHERE enabled_flag = 'Y'\n  AND target_processes = 0\n  AND concurrent_queue_name NOT LIKE 'FNDI%'`,
          rows: [{ CONCURRENT_QUEUE_NAME: 'REPORTS_MANAGER', TARGET_PROCESSES: 0 }]
        },
        {
          label: 'Standard Manager (cache_size, target_processes)',
          sql: `SELECT concurrent_queue_name, target_processes, cache_size\nFROM apps.fnd_concurrent_queues\nWHERE concurrent_queue_name = 'STANDARD' AND enabled_flag = 'Y'`,
          rows: [{ CONCURRENT_QUEUE_NAME: 'STANDARD', TARGET_PROCESSES: 10, CACHE_SIZE: 3 }]
        }
      ],
      findings: [
        { level: 'warn', message: 'Queue REPORTS_MANAGER is enabled but target_processes=0 — no workers will run.', hint: 'Increase target_processes via Sysadmin > Concurrent > Manager > Define, or disable if unused.' },
        { level: 'pass', message: 'Standard Manager enabled — target_processes=10, cache_size=3.' },
        { level: 'pass', message: 'ICM assigned to active node EBSAPP01 (STATUS=Y).' },
        { level: 'pass', message: 'No enabled queues with target_processes=0 (excluding REPORTS_MANAGER finding above).' }
      ]
    },
    {
      id: 'wf_mailer',
      title: 'Workflow Mailer Config',
      status: 'warn',
      phase: 'live',
      sql_detail: [
        {
          label: 'WF Mailer component status (fnd_svc_components)',
          sql: `SELECT sc.component_id, sc.component_status, sc.component_name, sc.component_type\nFROM apps.fnd_svc_components sc\nWHERE sc.component_type LIKE 'WF_MAILER%' AND ROWNUM = 1`,
          rows: [{ COMPONENT_ID: 101, COMPONENT_STATUS: 'RUNNING', COMPONENT_NAME: 'WF_NOTIFICATION_MAILER', COMPONENT_TYPE: 'WF_MAILER' }]
        },
        {
          label: 'WF Mailer configuration parameters (fnd_svc_comp_param_vals_v)',
          sql: `SELECT parameter_name, parameter_value\nFROM apps.fnd_svc_comp_param_vals_v\nWHERE component_id = 101\n  AND parameter_name IN (\n    'OUTBOUND_SERVER','INBOUND_SERVER','INBOUND_ACCOUNT',\n    'REPLY_TO','DISCARD_FOLDER','TEST_ADDRESS',\n    'SMTP_HOST','IMAP_HOST','SEND_ACCESS_KEY','INBOX_REPLYTO'\n  )`,
          rows: [
            { PARAMETER_NAME: 'OUTBOUND_SERVER', PARAMETER_VALUE: 'smtp.company.internal' },
            { PARAMETER_NAME: 'INBOUND_SERVER', PARAMETER_VALUE: 'imap.company.internal' },
            { PARAMETER_NAME: 'TEST_ADDRESS', PARAMETER_VALUE: 'ebs-test@company.internal' },
            { PARAMETER_NAME: 'REPLY_TO', PARAMETER_VALUE: 'wf-notify@company.internal' }
          ]
        },
        {
          label: 'Pending MAIL notifications (wf_notifications)',
          sql: `SELECT COUNT(*) AS pending_count\nFROM apps.wf_notifications\nWHERE mail_status = 'MAIL'\n  AND status = 'OPEN'`,
          rows: [{ PENDING_COUNT: 4 }]
        }
      ],
      findings: [
        { level: 'pass', message: 'Workflow Mailer component is RUNNING (component_id=101).' },
        { level: 'pass', message: 'Outbound mail server configured: smtp.company.internal' },
        { level: 'pass', message: 'Inbound mail server configured: imap.company.internal' },
        { level: 'pass', message: 'Reply-to configured: wf-notify@company.internal' },
        { level: 'warn', message: 'TEST_ADDRESS is set to "ebs-test@company.internal" — all outgoing notifications are redirected to this address (production smell).', hint: "Clear TEST_ADDRESS: fnd_svc_components_pkg.set_config_param_value(p_component_id => <id>, p_param_name => 'TEST_ADDRESS', p_param_value => ''); then restart the mailer." },
        { level: 'pass', message: 'Notification queue depth: 4 pending mail notifications.' }
      ]
    }
  ];
}

/**
 * deriveOverallStatus — worst-case roll-up across all category statuses.
 *
 * @param {Array} categories
 * @returns {'pass'|'warn'|'fail'|'unknown'}
 */
function deriveOverallStatus(categories) {
  if (!categories || categories.length === 0) return 'unknown';
  if (categories.some(c => c.status === 'fail'))   return 'fail';
  if (categories.some(c => c.status === 'warn'))   return 'warn';
  if (categories.every(c => c.status === 'pass'))  return 'pass';
  return 'unknown';
}

// ── 5-minute in-memory result cache (per connection_id) ──────────────────────
const _sanityCacheTTL = 5 * 60 * 1000; // 5 minutes
const _sanityCache    = new Map(); // connection_id -> { ts, data }

function getSanityCache(connectionId) {
  const entry = _sanityCache.get(connectionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _sanityCacheTTL) {
    _sanityCache.delete(connectionId);
    return null;
  }
  return entry.data;
}

function setSanityCache(connectionId, data) {
  _sanityCache.set(connectionId, { ts: Date.now(), data });
}

/**
 * runOracleSanityChecks — execute all 5 sanity categories against a live Oracle
 * connection: FND_NODES, Profile Options, ADOP Filesystem, CM Config, WF Mailer.
 *
 * @param {object} connParams  { host, port, serviceName, username, password }
 * @returns {Promise<Array>}   Array of category result objects
 */
async function runOracleSanityChecks(connParams) {
  const oracledb = require('oracledb');
  const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
  let connection;
  try {
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 25
    });

    async function safeQuery(sql, binds) {
      try {
        return await connection.execute(sql, binds || [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      } catch (e) {
        return null;
      }
    }

    // All 5 categories run live Oracle queries in parallel.
    const [fndNodes, profileOptions, adopFilesystem, cmConfig, wfMailer] = await Promise.all([
      checkFndNodes(safeQuery),
      checkProfileOptions(safeQuery),
      checkAdopFilesystem(safeQuery),
      checkCmConfig(safeQuery),
      checkWfMailer(safeQuery)
    ]);

    return [fndNodes, profileOptions, adopFilesystem, cmConfig, wfMailer];
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function checkFndNodes(safeQuery) {
  const cat = { id: 'fnd_nodes', title: 'FND_NODES Consistency', status: 'unknown', phase: 'live', findings: [], sql_detail: [] };

  const SQL_ALL_NODES = `SELECT node_name, node_id, support_cp, support_forms, support_web, support_admin, status
FROM apps.fnd_nodes
ORDER BY node_name`;

  const SQL_INACTIVE_REFS = `SELECT fn.node_name, fn.node_id, fn.status,
       fn.support_cp, fn.support_forms, fn.support_web, fn.support_admin,
       COUNT(fcq.concurrent_queue_id) AS queue_refs
FROM apps.fnd_nodes fn
JOIN apps.fnd_concurrent_queues fcq ON fcq.node_name = fn.node_name
WHERE fn.status = 'N'
GROUP BY fn.node_name, fn.node_id, fn.status,
         fn.support_cp, fn.support_forms, fn.support_web, fn.support_admin`;

  const SQL_ORPHANED = `SELECT fn.node_name, fn.node_id, fn.support_cp, fn.support_forms, fn.support_web, fn.support_admin
FROM apps.fnd_nodes fn
WHERE fn.status = 'Y'
  AND NOT EXISTS (SELECT 1 FROM apps.fnd_concurrent_queues fcq WHERE fcq.node_name = fn.node_name)
  AND NOT EXISTS (SELECT 1 FROM apps.fnd_svc_components fsc WHERE fsc.node_name = fn.node_name)`;

  const SQL_NO_ADDR = `SELECT node_name, server_address FROM apps.fnd_nodes WHERE status = 'Y' AND server_address IS NULL`;

  const SQL_AUTH_NODE = `SELECT node_name, status FROM apps.fnd_nodes WHERE node_name = 'AUTHENTICATION'`;

  const SQL_SUPPORT_FLAGS = `SELECT fn.node_name, fn.support_admin
FROM apps.fnd_nodes fn
WHERE fn.status = 'Y' AND fn.support_admin = 'N'
  AND EXISTS (
    SELECT 1 FROM apps.fnd_concurrent_queues fcq
    WHERE fcq.node_name = fn.node_name AND fcq.concurrent_queue_name LIKE '%ADMIN%'
  )`;

  try {
    // Base query — stored for DBA reference
    const allNodes = await safeQuery(SQL_ALL_NODES);
    cat.sql_detail.push({
      label: 'All nodes (base query)',
      sql: SQL_ALL_NODES,
      rows: (allNodes && allNodes.rows) ? allNodes.rows : []
    });

    let hasIssue = false;

    // (a) Every node has a non-null node_name (checked via base query)
    if (allNodes && allNodes.rows) {
      const unnamed = allNodes.rows.filter(r => !(r.NODE_NAME || r.node_name));
      if (unnamed.length > 0) {
        hasIssue = true;
        cat.findings.push({ level: 'fail', message: `${unnamed.length} node(s) found with null NODE_NAME — this is a data integrity error.`, hint: 'Investigate apps.fnd_nodes for rows with null node_name.' });
      }
    }

    // (b) AUTHENTICATION node must exist
    const authNode = await safeQuery(SQL_AUTH_NODE);
    cat.sql_detail.push({ label: 'AUTHENTICATION node check', sql: SQL_AUTH_NODE, rows: (authNode && authNode.rows) ? authNode.rows : [] });
    if (!authNode || !authNode.rows || authNode.rows.length === 0) {
      hasIssue = true;
      cat.findings.push({ level: 'fail', message: 'AUTHENTICATION node is missing from apps.fnd_nodes — this is always required.', hint: 'Re-run autoconfig or restore fnd_nodes from backup. The AUTHENTICATION node is seeded by Oracle.' });
    } else {
      cat.findings.push({ level: 'pass', message: 'AUTHENTICATION node found — required system node is present.' });
    }

    // (c) Orphaned nodes with STATUS=N still referenced by concurrent_processes
    const inactiveRef = await safeQuery(SQL_INACTIVE_REFS);
    cat.sql_detail.push({ label: 'Inactive nodes still referenced by concurrent queues', sql: SQL_INACTIVE_REFS, rows: (inactiveRef && inactiveRef.rows) ? inactiveRef.rows : [] });
    if (inactiveRef && inactiveRef.rows) {
      for (const r of inactiveRef.rows) {
        hasIssue = true;
        cat.findings.push({
          level: 'warn',
          message: `Node ${r.NODE_NAME || r.node_name} has STATUS=N but is still referenced by ${r.QUEUE_REFS || r.queue_refs} concurrent queue(s).`,
          hint: 'Decommission properly via adadmin, or re-activate the node if still in use.'
        });
      }
    }

    // Orphaned active nodes not referenced anywhere
    const orphaned = await safeQuery(SQL_ORPHANED);
    cat.sql_detail.push({ label: 'Active nodes not referenced by any queue or service', sql: SQL_ORPHANED, rows: (orphaned && orphaned.rows) ? orphaned.rows : [] });
    if (orphaned && orphaned.rows && orphaned.rows.length > 0) {
      for (const r of orphaned.rows) {
        hasIssue = true;
        cat.findings.push({
          level: 'warn',
          message: `Node ${r.NODE_NAME || r.node_name} is active (STATUS=Y) but not referenced by any queue or service component.`,
          hint: "If this node was decommissioned, set STATUS=N in fnd_nodes."
        });
      }
    }

    // Missing SERVER_ADDRESS
    const addrCheck = await safeQuery(SQL_NO_ADDR);
    cat.sql_detail.push({ label: 'Active nodes missing SERVER_ADDRESS', sql: SQL_NO_ADDR, rows: (addrCheck && addrCheck.rows) ? addrCheck.rows : [] });
    if (addrCheck && addrCheck.rows && addrCheck.rows.length > 0) {
      for (const r of addrCheck.rows) {
        hasIssue = true;
        cat.findings.push({
          level: 'warn',
          message: `Active node ${r.NODE_NAME || r.node_name} has no SERVER_ADDRESS configured.`,
          hint: 'Update SERVER_ADDRESS in apps.fnd_nodes to match the actual IP or hostname.'
        });
      }
    }

    // (c) Support flags alignment — admin node must have SUPPORT_ADMIN='Y'
    const flagMismatch = await safeQuery(SQL_SUPPORT_FLAGS);
    cat.sql_detail.push({ label: 'Admin-role nodes with SUPPORT_ADMIN=N', sql: SQL_SUPPORT_FLAGS, rows: (flagMismatch && flagMismatch.rows) ? flagMismatch.rows : [] });
    if (flagMismatch && flagMismatch.rows && flagMismatch.rows.length > 0) {
      for (const r of flagMismatch.rows) {
        hasIssue = true;
        cat.findings.push({
          level: 'warn',
          message: `Node ${r.NODE_NAME || r.node_name} serves admin queues but has SUPPORT_ADMIN=N — role flag misaligned.`,
          hint: "Update SUPPORT_ADMIN='Y' for this node via autoconfig or directly in apps.fnd_nodes."
        });
      }
    } else if (flagMismatch !== null) {
      cat.findings.push({ level: 'pass', message: 'Support flag alignment check passed — no admin-role nodes with SUPPORT_ADMIN=N.' });
    }

    if (!hasIssue) {
      cat.findings.push({ level: 'pass', message: 'All FND_NODES checks passed — no issues found.' });
    }

    cat.status = cat.findings.some(f => f.level === 'fail') ? 'fail'
               : cat.findings.some(f => f.level === 'warn') ? 'warn' : 'pass';
  } catch (e) {
    cat.findings.push({ level: 'warn', message: `FND_NODES check could not run: ${e.message}`, hint: 'Ensure APPS schema access is granted.' });
    cat.status = 'unknown';
  }
  return cat;
}

async function checkAdopFilesystem(safeQuery) {
  const cat = { id: 'adop_filesystem', title: 'ADOP Filesystem Sanity', status: 'unknown', phase: 'live', findings: [], sql_detail: [] };

  const SQL_ACTIVE_SESSIONS = `SELECT session_id, prepare_start_date, apply_start_date,
       finalize_start_date, cutover_start_date, cleanup_start_date, session_status
FROM apps.ad_adop_sessions
WHERE session_status NOT IN ('X','F','C')
ORDER BY prepare_start_date DESC`;

  const SQL_STUCK_SESSIONS = `SELECT session_id, prepare_start_date, session_status
FROM apps.ad_adop_sessions
WHERE session_status IN ('P','A','F1','C1')
  AND prepare_start_date < SYSDATE - 7
  AND cutover_start_date IS NULL`;

  const SQL_FAILED_UNCLEANED = `SELECT session_id, session_status, prepare_start_date
FROM apps.ad_adop_sessions
WHERE session_status = 'F'
  AND cleanup_start_date IS NULL
  AND prepare_start_date > SYSDATE - 30`;

  const SQL_IN_PROGRESS_PATCHES = `SELECT session_id, patch_top, prepare_start_date, cutover_start_date,
       cleanup_start_date, session_status
FROM apps.ad_adop_session_patches
WHERE session_status NOT IN ('X','F') AND ROWNUM <= 5
ORDER BY prepare_start_date DESC`;

  try {
    // Active sessions from ad_adop_sessions (task spec primary table)
    const activeR = await safeQuery(SQL_ACTIVE_SESSIONS);
    cat.sql_detail.push({
      label: 'Active ADOP sessions (ad_adop_sessions)',
      sql: SQL_ACTIVE_SESSIONS,
      rows: (activeR && activeR.rows) ? activeR.rows.slice(0, 5) : []
    });

    // Stuck sessions: in-progress phases but no activity for > 7 days
    const stuckR = await safeQuery(SQL_STUCK_SESSIONS);
    cat.sql_detail.push({
      label: 'Stuck sessions (>7 days in PREPARE/APPLY/FINALIZE/CUTOVER with no cutover)',
      sql: SQL_STUCK_SESSIONS,
      rows: (stuckR && stuckR.rows) ? stuckR.rows : []
    });

    if (stuckR && stuckR.rows && stuckR.rows.length > 0) {
      for (const r of stuckR.rows) {
        const sid = r.SESSION_ID || r.session_id;
        const phase = r.SESSION_STATUS || r.session_status;
        cat.findings.push({
          level: 'fail',
          message: `ADOP session ${sid} has been in phase ${phase} for over 7 days with no cutover — likely a stuck patch cycle.`,
          hint: 'Review $ADOP_LOG/adop.log for errors. To recover: adop phase=abort, then adop phase=cleanup cleanup_mode=full'
        });
      }
    }

    // Failed sessions not cleaned up
    const failedR = await safeQuery(SQL_FAILED_UNCLEANED);
    cat.sql_detail.push({
      label: 'Failed sessions not yet cleaned up (last 30 days)',
      sql: SQL_FAILED_UNCLEANED,
      rows: (failedR && failedR.rows) ? failedR.rows : []
    });

    if (failedR && failedR.rows && failedR.rows.length > 0) {
      for (const r of failedR.rows) {
        cat.findings.push({
          level: 'warn',
          message: `ADOP session ${r.SESSION_ID || r.session_id} failed and has not been cleaned up.`,
          hint: 'Run: adop phase=cleanup cleanup_mode=full to remove stale patch filesystem artifacts.'
        });
      }
    }

    // In-progress patch-level records from ad_adop_session_patches (secondary check)
    const patchR = await safeQuery(SQL_IN_PROGRESS_PATCHES);
    cat.sql_detail.push({
      label: 'In-progress patch records (ad_adop_session_patches)',
      sql: SQL_IN_PROGRESS_PATCHES,
      rows: (patchR && patchR.rows) ? patchR.rows.slice(0, 5) : []
    });

    if (cat.findings.length === 0) {
      cat.findings.push({ level: 'pass', message: 'No stuck or failed ADOP patch cycles found — filesystem sanity OK.' });
    }

    cat.status = cat.findings.some(f => f.level === 'fail') ? 'fail'
               : cat.findings.some(f => f.level === 'warn') ? 'warn' : 'pass';
  } catch (e) {
    cat.findings.push({ level: 'warn', message: `ADOP filesystem check could not run: ${e.message}`, hint: 'Ensure AD_ADOP_SESSIONS is accessible under APPS schema.' });
    cat.status = 'unknown';
  }
  return cat;
}

async function checkProfileOptions(safeQuery) {
  const cat = { id: 'profile_options', title: 'Profile Options', status: 'unknown', phase: 'live', findings: [], sql_detail: [] };

  // The 10 critical profiles mandated by task spec
  const CRITICAL_PROFILES = [
    'APPS_FRAMEWORK_AGENT', 'APPS_WEB_AGENT', 'APPS_SERVLET_AGENT',
    'FND_DIAGNOSTICS', 'FND_SECURE_INTERNAL_AUTHENTICATION',
    'ICX_SESSION_TIMEOUT', 'GUEST_USER_PWD', 'SITENAME',
    'RRA_SERVICE_PREFIX', 'FND_SSO_URL'
  ];

  // Query: SITE-level (level_id=10001) via fnd_profile_option_values + fnd_profile_options JOIN
  const SQL_PROFILES = `SELECT fpo.profile_option_name,
       fpov.profile_option_value,
       fpov.level_id,
       fpov.level_value
FROM apps.fnd_profile_option_values fpov
JOIN apps.fnd_profile_options fpo
  ON fpo.application_id = fpov.application_id
 AND fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name IN (${CRITICAL_PROFILES.map((_, i) => `:${i + 1}`).join(',')})
  AND fpov.level_id = 10001`;

  try {
    const profR = await safeQuery(SQL_PROFILES, CRITICAL_PROFILES);
    cat.sql_detail.push({
      label: 'Critical profile options at SITE level (level_id=10001)',
      sql: SQL_PROFILES.replace(CRITICAL_PROFILES.map((_, i) => `:${i + 1}`).join(','), "'" + CRITICAL_PROFILES.join("','") + "'"),
      rows: (profR && profR.rows) ? profR.rows : []
    });

    const found = {};
    if (profR && profR.rows) {
      for (const r of profR.rows) {
        const name = r.PROFILE_OPTION_NAME || r.profile_option_name;
        const val  = r.PROFILE_OPTION_VALUE || r.profile_option_value;
        // Only capture SITE-level (already filtered in SQL but guard defensively)
        found[name] = val;
      }
    }

    for (const p of CRITICAL_PROFILES) {
      if (!(p in found) || found[p] === null || found[p] === '') {
        cat.findings.push({
          level: 'warn',
          message: `${p} is not set at site level.`,
          hint: `Set via: fnd_profile.save('${p}', '<value>', 'SITE');`
        });
        continue;
      }
      const val = String(found[p] || '');

      // Pattern checks
      if (p === 'APPS_FRAMEWORK_AGENT' && !/^https:\/\//i.test(val)) {
        cat.findings.push({
          level: 'warn',
          message: `APPS_FRAMEWORK_AGENT is set but uses HTTP (not HTTPS): ${val.length > 60 ? val.slice(0, 57) + '...' : val}`,
          hint: 'Modern EBS deployments require HTTPS for APPS_FRAMEWORK_AGENT. Update the URL scheme.'
        });
        continue;
      }
      if (p === 'APPS_WEB_AGENT' && !/^https:\/\//i.test(val)) {
        cat.findings.push({
          level: 'warn',
          message: `APPS_WEB_AGENT is set but uses HTTP (not HTTPS): ${val.length > 60 ? val.slice(0, 57) + '...' : val}`,
          hint: 'Ensure APPS_WEB_AGENT uses HTTPS for secure access.'
        });
        continue;
      }
      if (p === 'FND_DIAGNOSTICS' && val === 'Y') {
        cat.findings.push({
          level: 'warn',
          message: `FND_DIAGNOSTICS is set to Y at site level — this enables debug output and may expose internal data.`,
          hint: `Set to N in non-dev environments: fnd_profile.save('FND_DIAGNOSTICS', 'N', 'SITE');`
        });
        continue;
      }
      if (p === 'GUEST_USER_PWD' && /^guest(\/guest)?$/i.test(val)) {
        cat.findings.push({
          level: 'fail',
          message: `GUEST_USER_PWD is set to the default value — this is a security risk.`,
          hint: `Change the guest user password immediately via EBS User Management or fnd_profile.save.`
        });
        continue;
      }
      cat.findings.push({ level: 'pass', message: `${p} is set at SITE level: ${val.length > 70 ? val.slice(0, 67) + '...' : val}` });
    }

    cat.status = cat.findings.some(f => f.level === 'fail') ? 'fail'
               : cat.findings.some(f => f.level === 'warn') ? 'warn' : 'pass';
  } catch (e) {
    cat.findings.push({ level: 'warn', message: `Profile options check could not run: ${e.message}`, hint: 'Ensure FND_PROFILE_OPTION_VALUES and FND_PROFILE_OPTIONS are accessible under APPS schema.' });
    cat.status = 'unknown';
  }
  return cat;
}

async function checkCmConfig(safeQuery) {
  const cat = { id: 'cm_config', title: 'Concurrent Manager Config', status: 'unknown', phase: 'live', findings: [], sql_detail: [] };

  const SQL_ALL_QUEUES = `SELECT concurrent_queue_name, target_processes, running_processes,
       enabled_flag, cache_size
FROM apps.fnd_concurrent_queues
WHERE enabled_flag = 'Y'
ORDER BY concurrent_queue_name`;

  const SQL_ZERO_TARGET = `SELECT concurrent_queue_name, target_processes
FROM apps.fnd_concurrent_queues
WHERE enabled_flag = 'Y'
  AND target_processes = 0
  AND concurrent_queue_name NOT LIKE 'FNDI%'`;

  const SQL_STANDARD = `SELECT concurrent_queue_name, target_processes, cache_size
FROM apps.fnd_concurrent_queues
WHERE concurrent_queue_name = 'STANDARD' AND enabled_flag = 'Y'`;

  const SQL_ICM_NODE = `SELECT fcq.concurrent_queue_name, fcq.node_name, fn.status AS node_status
FROM apps.fnd_concurrent_queues fcq
LEFT JOIN apps.fnd_nodes fn ON fn.node_name = fcq.node_name
WHERE fcq.concurrent_queue_name = 'FNDICM'`;

  const SQL_WORKSHIFTS = `SELECT fcq.concurrent_queue_name, COUNT(fcqs.work_shift_id) AS active_workshifts
FROM apps.fnd_concurrent_queues fcq
LEFT JOIN apps.fnd_concurrent_queue_size fcqs ON fcqs.concurrent_queue_id = fcq.concurrent_queue_id
WHERE fcq.enabled_flag = 'Y'
GROUP BY fcq.concurrent_queue_name
HAVING COUNT(fcqs.work_shift_id) = 0
  AND fcq.concurrent_queue_name NOT LIKE 'FNDI%'`;

  try {
    // All enabled queues — reference data for DBA
    const allR = await safeQuery(SQL_ALL_QUEUES);
    cat.sql_detail.push({
      label: 'All enabled concurrent queues (target vs running)',
      sql: SQL_ALL_QUEUES,
      rows: (allR && allR.rows) ? allR.rows.slice(0, 10) : []
    });

    // Zero-target queues
    const zeroR = await safeQuery(SQL_ZERO_TARGET);
    cat.sql_detail.push({
      label: 'Enabled queues with target_processes=0',
      sql: SQL_ZERO_TARGET,
      rows: (zeroR && zeroR.rows) ? zeroR.rows : []
    });

    if (zeroR && zeroR.rows && zeroR.rows.length > 0) {
      for (const r of zeroR.rows) {
        cat.findings.push({
          level: 'warn',
          message: `Queue ${r.CONCURRENT_QUEUE_NAME || r.concurrent_queue_name} is enabled but target_processes=0 — no workers will run.`,
          hint: 'Increase target_processes via Sysadmin > Concurrent > Manager > Define, or disable if unused.'
        });
      }
    } else if (zeroR !== null) {
      cat.findings.push({ level: 'pass', message: 'No enabled queues with target_processes=0.' });
    }

    // Standard Manager
    const stdR = await safeQuery(SQL_STANDARD);
    cat.sql_detail.push({
      label: 'Standard Manager (cache_size, target_processes)',
      sql: SQL_STANDARD,
      rows: (stdR && stdR.rows) ? stdR.rows : []
    });

    if (!stdR || !stdR.rows || stdR.rows.length === 0) {
      cat.findings.push({
        level: 'fail',
        message: 'Standard Manager (STANDARD) not found or not enabled.',
        hint: 'Ensure the Standard Manager is defined and enabled. Fix: adcmctl.sh restart apps/<pw>'
      });
    } else {
      const std = stdR.rows[0];
      const cacheSize = Number(std.CACHE_SIZE || std.cache_size) || 0;
      cat.findings.push({ level: 'pass', message: `Standard Manager enabled — target_processes=${std.TARGET_PROCESSES || std.target_processes}, cache_size=${cacheSize}.` });
      if (cacheSize < 1 || cacheSize > 5) {
        cat.findings.push({
          level: 'warn',
          message: `Standard Manager cache_size=${cacheSize} is outside recommended range (1–5).`,
          hint: 'Adjust cache_size in System Administrator > Concurrent > Manager > Define or run cmclean.sql then restart.'
        });
      }
    }

    // ICM on active node
    const icmR = await safeQuery(SQL_ICM_NODE);
    cat.sql_detail.push({
      label: 'ICM (FNDICM) node assignment',
      sql: SQL_ICM_NODE,
      rows: (icmR && icmR.rows) ? icmR.rows : []
    });

    if (!icmR || !icmR.rows || icmR.rows.length === 0) {
      cat.findings.push({ level: 'warn', message: 'ICM (FNDICM) queue definition not found.', hint: 'Run adadmin to verify manager configuration.' });
    } else {
      const r = icmR.rows[0];
      const nodeStatus = r.NODE_STATUS || r.node_status;
      if (nodeStatus === 'N' || nodeStatus === null) {
        cat.findings.push({
          level: 'warn',
          message: `ICM is assigned to node ${r.NODE_NAME || r.node_name} but that node has STATUS=N or is not registered.`,
          hint: 'Reassign ICM to an active node via Sysadmin > Concurrent > Manager > Define, then restart: adcmctl.sh restart apps/<pw>'
        });
      } else {
        cat.findings.push({ level: 'pass', message: `ICM assigned to active node ${r.NODE_NAME || r.node_name} (STATUS=Y).` });
      }
    }

    // Queues with no workshifts
    const wsR = await safeQuery(SQL_WORKSHIFTS);
    cat.sql_detail.push({
      label: 'Enabled queues with no active workshifts',
      sql: SQL_WORKSHIFTS,
      rows: (wsR && wsR.rows) ? wsR.rows : []
    });

    if (wsR && wsR.rows && wsR.rows.length > 0) {
      for (const r of wsR.rows) {
        cat.findings.push({
          level: 'warn',
          message: `Queue ${r.CONCURRENT_QUEUE_NAME || r.concurrent_queue_name} has no active workshifts — it will never process requests.`,
          hint: 'Add at least one workshift in System Administrator > Concurrent > Manager > Work Shifts.'
        });
      }
    }

    cat.status = cat.findings.some(f => f.level === 'fail') ? 'fail'
               : cat.findings.some(f => f.level === 'warn') ? 'warn' : 'pass';
  } catch (e) {
    cat.findings.push({ level: 'warn', message: `CM config check could not run: ${e.message}`, hint: 'Ensure FND_CONCURRENT_QUEUES is accessible under APPS schema.' });
    cat.status = 'unknown';
  }
  return cat;
}

async function checkWfMailer(safeQuery) {
  const cat = { id: 'wf_mailer', title: 'Workflow Mailer Config', status: 'unknown', phase: 'live', findings: [], sql_detail: [] };

  const SQL_COMPONENT = `SELECT sc.component_id, sc.component_status, sc.component_name, sc.component_type
FROM apps.fnd_svc_components sc
WHERE sc.component_type LIKE 'WF_MAILER%' AND ROWNUM = 1`;

  const SQL_PARAMS = `SELECT parameter_name, parameter_value
FROM apps.fnd_svc_comp_param_vals_v
WHERE component_id = :1
  AND parameter_name IN (
    'OUTBOUND_SERVER','INBOUND_SERVER','INBOUND_ACCOUNT',
    'REPLY_TO','DISCARD_FOLDER','TEST_ADDRESS',
    'SMTP_HOST','IMAP_HOST','SEND_ACCESS_KEY','INBOX_REPLYTO'
  )`;

  const SQL_PENDING_MAIL = `SELECT COUNT(*) AS pending_count
FROM apps.wf_notifications
WHERE mail_status = 'MAIL'
  AND status = 'OPEN'`;

  try {
    // Component status
    const compR = await safeQuery(SQL_COMPONENT);
    cat.sql_detail.push({
      label: 'WF Mailer component status (fnd_svc_components)',
      sql: SQL_COMPONENT,
      rows: (compR && compR.rows) ? compR.rows : []
    });

    if (!compR || !compR.rows || compR.rows.length === 0) {
      cat.findings.push({
        level: 'fail',
        message: 'No Workflow Notification Mailer component found in FND_SVC_COMPONENTS.',
        hint: 'Verify WF_NOTIFICATION_MAILER is registered. Re-register via: adadmin > Maintain Applications Files > Regenerate Message Catalog.'
      });
      cat.status = 'fail';
      return cat;
    }

    const comp = compR.rows[0];
    const compId = comp.COMPONENT_ID || comp.component_id;
    const compStatus = String(comp.COMPONENT_STATUS || comp.component_status || '').toUpperCase();

    if (compStatus !== 'RUNNING') {
      cat.findings.push({
        level: 'warn',
        message: `Workflow Mailer component status is ${compStatus} (expected RUNNING).`,
        hint: 'Start via Workflow Administrator Web Applications > Notification Mailer, or: admanagedsrvctl.sh start wfmlrsvc'
      });
    } else {
      cat.findings.push({ level: 'pass', message: `Workflow Mailer component is RUNNING (component_id=${compId}).` });
    }

    // Parameters
    const paramsR = await safeQuery(SQL_PARAMS, [compId]);
    cat.sql_detail.push({
      label: 'WF Mailer configuration parameters (fnd_svc_comp_param_vals_v)',
      sql: SQL_PARAMS.replace(':1', compId),
      rows: (paramsR && paramsR.rows) ? paramsR.rows : []
    });

    const params = {};
    if (paramsR && paramsR.rows) {
      for (const r of paramsR.rows) {
        const pname = r.PARAMETER_NAME || r.parameter_name;
        params[pname] = r.PARAMETER_VALUE || r.parameter_value;
      }
    }

    // Outbound server — check OUTBOUND_SERVER first, fall back to SMTP_HOST
    const outboundServer = params['OUTBOUND_SERVER'] || params['SMTP_HOST'];
    if (!outboundServer || String(outboundServer).trim() === '') {
      cat.findings.push({
        level: 'fail',
        message: 'Outbound mail server (OUTBOUND_SERVER/SMTP_HOST) is not configured — the mailer cannot send notifications.',
        hint: "Set via: fnd_svc_components_pkg.set_config_param_value(p_component_id => <id>, p_param_name => 'OUTBOUND_SERVER', p_param_value => '<smtp-host>'); then restart the mailer."
      });
    } else {
      cat.findings.push({ level: 'pass', message: `Outbound mail server configured: ${outboundServer}` });
    }

    // Inbound server — check INBOUND_SERVER first, fall back to IMAP_HOST
    const inboundServer = params['INBOUND_SERVER'] || params['IMAP_HOST'];
    if (!inboundServer || String(inboundServer).trim() === '') {
      cat.findings.push({
        level: 'warn',
        message: 'Inbound mail server (INBOUND_SERVER/IMAP_HOST) is not configured — notification responses will not be processed.',
        hint: "Set via: fnd_svc_components_pkg.set_config_param_value(p_component_id => <id>, p_param_name => 'INBOUND_SERVER', p_param_value => '<imap-host>'); then restart the mailer."
      });
    } else {
      cat.findings.push({ level: 'pass', message: `Inbound mail server configured: ${inboundServer}` });
    }

    // Reply-to
    const replyTo = params['REPLY_TO'] || params['INBOX_REPLYTO'];
    if (!replyTo || String(replyTo).trim() === '') {
      cat.findings.push({
        level: 'warn',
        message: 'Reply-to address is not configured — workflow notifications will have no valid reply address.',
        hint: "Set REPLY_TO via fnd_svc_components_pkg.set_config_param_value."
      });
    } else {
      cat.findings.push({ level: 'pass', message: `Reply-to configured: ${replyTo}` });
    }

    // Test address — production smell
    const testAddr = params['TEST_ADDRESS'] || '';
    if (testAddr && testAddr.trim() !== '') {
      cat.findings.push({
        level: 'warn',
        message: `TEST_ADDRESS is set to "${testAddr}" — all outgoing notifications are redirected to this address (production smell).`,
        hint: "Clear TEST_ADDRESS: fnd_svc_components_pkg.set_config_param_value(p_component_id => <id>, p_param_name => 'TEST_ADDRESS', p_param_value => ''); then restart the mailer."
      });
    } else {
      cat.findings.push({ level: 'pass', message: 'TEST_ADDRESS is not set — notifications route to actual recipients.' });
    }

    // SEND_ACCESS_KEY
    if (!params['SEND_ACCESS_KEY'] || params['SEND_ACCESS_KEY'].trim() === '') {
      cat.findings.push({ level: 'warn', message: 'SEND_ACCESS_KEY is not set — notification authentication key missing.', hint: "Set SEND_ACCESS_KEY via fnd_svc_components_pkg.set_config_param_value." });
    } else {
      cat.findings.push({ level: 'pass', message: 'SEND_ACCESS_KEY is configured.' });
    }

    // Pending mail queue depth
    const pendR = await safeQuery(SQL_PENDING_MAIL);
    cat.sql_detail.push({
      label: 'Pending MAIL notifications (wf_notifications)',
      sql: SQL_PENDING_MAIL,
      rows: (pendR && pendR.rows) ? pendR.rows : []
    });

    if (pendR && pendR.rows && pendR.rows.length > 0) {
      const pendCount = Number(pendR.rows[0].PENDING_COUNT || pendR.rows[0].pending_count) || 0;
      if (pendCount > 100) {
        cat.findings.push({
          level: 'fail',
          message: `${pendCount} notifications are queued with mail_status='MAIL' — mailer appears backed up.`,
          hint: 'Investigate WF Notification Mailer log. Restart mailer: admanagedsrvctl.sh start wfmlrsvc'
        });
      } else if (pendCount > 20) {
        cat.findings.push({
          level: 'warn',
          message: `${pendCount} notifications pending — mailer may be slow.`,
          hint: 'Monitor WF Notification Mailer in Workflow Administrator Web Applications.'
        });
      } else {
        cat.findings.push({ level: 'pass', message: `Notification queue depth: ${pendCount} pending mail notifications.` });
      }
    }

    cat.status = cat.findings.some(f => f.level === 'fail') ? 'fail'
               : cat.findings.some(f => f.level === 'warn') ? 'warn' : 'pass';
  } catch (e) {
    cat.findings.push({ level: 'warn', message: `Workflow Mailer check could not run: ${e.message}`, hint: 'Ensure FND_SVC_COMPONENTS and FND_SVC_COMP_PARAM_VALS_V are accessible under APPS schema.' });
    cat.status = 'unknown';
  }
  return cat;
}

// ─── Sanity Routes ────────────────────────────────────────────────────────────

/**
 * POST /api/ebs-deep/sanity/run
 * Runs all 5 sanity check categories against a saved connection.
 * Use connection_id=0 or ?demo=1 for demo fixture data.
 *
 * Body: { connection_id: number }
 */
router.post('/api/ebs-deep/sanity/run', requireAuth, async (req, res) => {
  try {
    const { connection_id } = req.body;
    const forceRefresh = req.query.refresh === '1';
    const isDemo = req.query.demo === '1' || !connection_id || Number(connection_id) === 0;

    if (isDemo) {
      const findings = getDemoSanityFindings();
      const overall  = deriveOverallStatus(findings);
      return res.json({
        is_demo: true,
        overall_status: overall,
        run_at: new Date().toISOString(),
        findings,
        from_cache: false
      });
    }

    const conn = await getConnectionById(Number(connection_id), req.user.id);
    if (!conn) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Proxy connections cannot run direct Oracle queries from the server side
    if (conn.connection_type === 'proxy') {
      const findings = getDemoSanityFindings();
      const overall  = deriveOverallStatus(findings.filter(f => f.phase !== 'phase2'));
      return res.json({
        is_demo: true,
        overall_status: overall,
        run_at: new Date().toISOString(),
        findings,
        from_cache: false,
        note: 'Proxy connections run demo data — direct Oracle access required for live sanity checks.'
      });
    }

    // 5-minute cache per connection
    if (!forceRefresh) {
      const cached = getSanityCache(Number(connection_id));
      if (cached) {
        return res.json({ ...cached, from_cache: true });
      }
    }

    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({ error: 'Oracle client unavailable' });
    }

    const connParams = {
      host: conn.host,
      port: conn.port || 1521,
      serviceName: conn.service_name,
      username: conn.username,
      password: decrypt(conn.encrypted_password)
    };

    const findings = await runOracleSanityChecks(connParams);
    const overall  = deriveOverallStatus(findings);

    const row = await insertSanityRun({
      connectionId: Number(connection_id),
      overallStatus: overall,
      findings,
      isDemo: false
    });

    const responseData = {
      is_demo: false,
      overall_status: overall,
      run_id: row.id,
      run_at: row.run_at,
      findings,
      from_cache: false
    };
    setSanityCache(Number(connection_id), responseData);

    res.json(responseData);
  } catch (err) {
    console.error('[ebs-deep/sanity] Error running sanity checks:', err);
    res.status(500).json({ error: 'Sanity check run failed' });
  }
});

/**
 * GET /api/ebs-deep/sanity/latest/:connection_id
 * Returns the most recent sanity run for a connection.
 * Returns 404 with { no_run: true } if no runs exist yet.
 */
router.get('/api/ebs-deep/sanity/latest/:connection_id', requireAuth, async (req, res) => {
  try {
    const connId = Number(req.params.connection_id);
    if (!connId || isNaN(connId)) {
      return res.status(400).json({ error: 'Invalid connection_id' });
    }
    const run = await getLatestSanityRun(connId, req.user.id);
    if (!run) {
      return res.status(404).json({ no_run: true });
    }
    res.json({
      run_id: run.id,
      connection_id: run.connection_id,
      run_at: run.run_at,
      overall_status: run.overall_status,
      findings: run.findings_json,
      is_demo: run.is_demo
    });
  } catch (err) {
    console.error('[ebs-deep/sanity] Error fetching latest sanity run:', err);
    res.status(500).json({ error: 'Failed to fetch latest sanity run' });
  }
});

module.exports = router;
