/**
 * routes/ebs-ops.js — EBS Ops page + SQL execution endpoint.
 *
 * Routes:
 *   GET  /ebs-ops              — serve the EBS Ops page (auth required)
 *   POST /api/ebs-ops/run      — execute a whitelisted EBS SQL op via agent channel
 */

'use strict';

const express = require('express');
const path    = require('path');

const pool    = require('../db/index');
const { decrypt } = require('../crypto-utils');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Server-side EBS SQL catalog ───────────────────────────────────────────────
// Keyed by op_key so the client never sends raw SQL.
// FND_CONCURRENT_REQUESTS does not have CONCURRENT_PROGRAM_NAME — join to
// FND_CONCURRENT_PROGRAMS_VL via CONCURRENT_PROGRAM_ID + PROGRAM_APPLICATION_ID.
const EBS_OPS_CATALOG = {
  running_requests: {
    label: 'Running Requests',
    sql: `SELECT r.REQUEST_ID,
               p.USER_CONCURRENT_PROGRAM_NAME AS program_name,
               r.REQUESTED_BY,
               r.ACTUAL_START_DATE,
               r.PHASE_CODE,
               r.STATUS_CODE
        FROM FND_CONCURRENT_REQUESTS r
        JOIN FND_CONCURRENT_PROGRAMS_VL p
            ON r.CONCURRENT_PROGRAM_ID = p.CONCURRENT_PROGRAM_ID
            AND p.APPLICATION_ID = r.PROGRAM_APPLICATION_ID
        WHERE r.PHASE_CODE = 'R'
        ORDER BY r.ACTUAL_START_DATE`,
  },
  long_running: {
    label: 'Long Running (>30 min)',
    sql: `SELECT r.REQUEST_ID,
               p.USER_CONCURRENT_PROGRAM_NAME AS program_name,
               r.REQUESTED_BY,
               ROUND((SYSDATE - r.ACTUAL_START_DATE) * 24 * 60, 1) AS running_minutes
        FROM FND_CONCURRENT_REQUESTS r
        JOIN FND_CONCURRENT_PROGRAMS_VL p
            ON r.CONCURRENT_PROGRAM_ID = p.CONCURRENT_PROGRAM_ID
            AND p.APPLICATION_ID = r.PROGRAM_APPLICATION_ID
        WHERE r.PHASE_CODE = 'R'
        AND r.ACTUAL_START_DATE < SYSDATE - 30/1440
        ORDER BY r.ACTUAL_START_DATE`,
  },
  pending_requests: {
    label: 'Pending Requests',
    sql: `SELECT r.REQUEST_ID,
               p.USER_CONCURRENT_PROGRAM_NAME AS program_name,
               r.REQUESTED_BY,
               r.REQUESTED_START_DATE,
               r.PRIORITY
        FROM FND_CONCURRENT_REQUESTS r
        JOIN FND_CONCURRENT_PROGRAMS_VL p
            ON r.CONCURRENT_PROGRAM_ID = p.CONCURRENT_PROGRAM_ID
            AND p.APPLICATION_ID = r.PROGRAM_APPLICATION_ID
        WHERE r.PHASE_CODE = 'P'
        ORDER BY r.PRIORITY, r.REQUESTED_START_DATE
        FETCH FIRST 50 ROWS ONLY`,
  },
  failed_requests: {
    label: 'Failed Requests (24h)',
    sql: `SELECT r.REQUEST_ID,
               p.USER_CONCURRENT_PROGRAM_NAME AS program_name,
               r.REQUESTED_BY,
               r.ACTUAL_COMPLETION_DATE,
               r.COMPLETION_TEXT
        FROM FND_CONCURRENT_REQUESTS r
        JOIN FND_CONCURRENT_PROGRAMS_VL p
            ON r.CONCURRENT_PROGRAM_ID = p.CONCURRENT_PROGRAM_ID
            AND p.APPLICATION_ID = r.PROGRAM_APPLICATION_ID
        WHERE r.PHASE_CODE = 'C'
        AND r.STATUS_CODE = 'E'
        AND r.ACTUAL_COMPLETION_DATE > SYSDATE - 1
        ORDER BY r.ACTUAL_COMPLETION_DATE DESC
        FETCH FIRST 50 ROWS ONLY`,
  },
  cm_managers: {
    label: 'CM Manager Status',
    sql: `SELECT USER_CONCURRENT_QUEUE_NAME AS manager_name,
               CONCURRENT_QUEUE_NAME,
               MANAGER_TYPE,
               RUNNING_PROCESSES,
               TARGET_PROCESSES,
               MAX_PROCESSES
        FROM FND_CONCURRENT_QUEUES_VL
        WHERE ENABLED_FLAG = 'Y'
        ORDER BY RUNNING_PROCESSES DESC`,
  },
  opp_queue: {
    label: 'OPP Queue Depth',
    sql: `SELECT COUNT(*) AS pending_opp_requests
        FROM FND_CONCURRENT_REQUESTS
        WHERE REQUEST_ID IN (
            SELECT CONCURRENT_REQUEST_ID
            FROM FND_CONC_PP_ACTIONS
            WHERE ACTION_TYPE >= 6
            AND PROCESSOR_ID IS NULL
        ) AND PHASE_CODE != 'C'`,
  },
  opp_programs: {
    label: 'OPP Pending Programs',
    sql: `SELECT DISTINCT b.USER_CONCURRENT_PROGRAM_NAME AS program_name
        FROM FND_CONCURRENT_REQUESTS a
        JOIN FND_CONCURRENT_PROGRAMS_TL b
            ON a.CONCURRENT_PROGRAM_ID = b.CONCURRENT_PROGRAM_ID
        WHERE a.REQUEST_ID IN (
            SELECT CONCURRENT_REQUEST_ID
            FROM FND_CONC_PP_ACTIONS
            WHERE ACTION_TYPE >= 6
            AND PROCESSOR_ID IS NULL
        ) ORDER BY 1`,
  },
  opp_heap_size: {
    label: 'OPP Heap Size',
    sql: `SELECT DEVELOPER_PARAMETERS
        FROM FND_CP_SERVICES
        WHERE SERVICE_ID = (
            SELECT MANAGER_TYPE
            FROM FND_CONCURRENT_QUEUES
            WHERE CONCURRENT_QUEUE_NAME = 'FNDCPOPP'
        )`,
  },
  adop_status: {
    label: 'ADOP Session Status',
    sql: `SELECT ADOP_SESSION_ID, NODE_NAME, NODE_TYPE, STATUS,
               PREPARE_STATUS, APPLY_STATUS, FINALIZE_STATUS,
               CUTOVER_STATUS, CLEANUP_STATUS, ABORT_STATUS,
               PREPARE_START_DATE, APPLY_START_DATE, CUTOVER_START_DATE,
               CLEANUP_START_DATE
        FROM AD_ADOP_SESSIONS
        ORDER BY ADOP_SESSION_ID DESC
        FETCH FIRST 10 ROWS ONLY`,
  },
  applied_patches: {
    label: 'Recent Patches (90 days)',
    sql: `SELECT s.ADOP_SESSION_ID, p.BUG_NUMBER, p.STATUS,
               p.NODE_NAME, p.START_DATE, p.END_DATE,
               p.APPLIED_FILE_SYSTEM_BASE
        FROM AD_ADOP_SESSION_PATCHES p
        JOIN AD_ADOP_SESSIONS s ON s.ADOP_SESSION_ID = p.ADOP_SESSION_ID
        WHERE p.START_DATE > SYSDATE - 90
        ORDER BY p.START_DATE DESC
        FETCH FIRST 50 ROWS ONLY`,
  },
  invalid_objects: {
    label: 'APPS Invalid Objects',
    sql: `SELECT owner, object_type, COUNT(*) AS invalid_count
        FROM DBA_OBJECTS
        WHERE STATUS = 'INVALID'
        AND OWNER IN (
            SELECT ORACLE_USERNAME FROM FND_ORACLE_USERID
            WHERE READ_ONLY_FLAG = 'U'
        )
        GROUP BY OWNER, OBJECT_TYPE
        ORDER BY invalid_count DESC`,
  },
};

// ── Helper: load + decrypt connection ────────────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type,
            server_type, ebs_instance_name, apps_pwd_enc, weblogic_pwd_enc
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  if (!rows.length) return null;
  const c = rows[0];
  return {
    id: c.id,
    host: c.host,
    port: c.port || 1521,
    serviceName: c.service_name,
    username: c.username,
    password: c.encrypted_password ? decrypt(c.encrypted_password) : null,
    connectionType: c.connection_type,
    serverType: c.server_type,
    ebsInstanceName: c.ebs_instance_name,
    appsPwd: c.apps_pwd_enc ? decrypt(c.apps_pwd_enc) : null,
    weblogicPwd: c.weblogic_pwd_enc ? decrypt(c.weblogic_pwd_enc) : null,
  };
}

// ── Helper: find paired DB connection for an apps-tier connection ─────────────
// Returns { id, host, port, serviceName } or null.

async function findPairedDbConn(ebsInstanceName, userId) {
  if (!ebsInstanceName) return null;
  console.log('[ebs-ops/pair] userId=%s instanceName=%s', userId, ebsInstanceName);
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name
     FROM oracle_connections
     WHERE ebs_instance_name = $1
       AND user_id = $2
       AND server_type IN ('db', 'both')
       AND connection_type = 'proxy'
     ORDER BY server_type   -- 'both' sorts after 'db'; prefer plain 'db'
     LIMIT 1`,
    [ebsInstanceName, userId]
  );
  console.log('[ebs-ops/pair] result:', rows);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, host: r.host, port: r.port || 1521, serviceName: r.service_name };
}

// ── GET /ebs-ops ─────────────────────────────────────────────────────────────

router.get('/ebs-ops', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-ops.html'));
});

// ── POST /api/ebs-ops/run ─────────────────────────────────────────────────────
// Body: { connection_id, op_key }

router.post('/api/ebs-ops/run', requireAuth, async (req, res) => {
  const { connection_id, op_key } = req.body || {};
  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  const opDef = EBS_OPS_CATALOG[op_key];
  if (!opDef) {
    return res.status(400).json({ error: `Unknown op_key: ${op_key}` });
  }

  let connParams;
  try {
    connParams = await getConnParams(parseInt(connection_id, 10), req.user.id);
  } catch (err) {
    console.error('[ebs-ops/run] getConnParams error:', err.message);
    return res.status(500).json({ error: 'Failed to load connection', detail: err.message });
  }
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });
  console.log('[ebs-ops/run] connId=%d serverType=%s ebsInstanceName=%s', connParams.id, connParams.serverType, connParams.ebsInstanceName);

  if (connParams.connectionType !== 'proxy') {
    return res.status(400).json({ error: 'Direct TCP connections are not yet supported for EBS SQL ops. Use a proxy (agent) connection.' });
  }

  // ── Resolve target agent: for apps-tier connections, route SQL to the paired DB agent ──
  let targetConnId   = connParams.id;
  let sqlUsername    = connParams.username || '';
  let sqlPassword    = connParams.password || '';
  let sqlServiceName = connParams.serviceName || '';
  let sqlHost        = connParams.host || 'localhost';
  let sqlPort        = connParams.port || 1521;

  if (connParams.serverType === 'apps') {
    const paired = await findPairedDbConn(connParams.ebsInstanceName, req.user.id).catch(() => null);
    if (!paired) {
      return res.status(503).json({
        error: connParams.ebsInstanceName
          ? `No paired DB agent found for EBS instance "${connParams.ebsInstanceName}". Make sure a DB-type connection with the same EBS Instance Name is added and its agent is installed.`
          : 'This connection has no EBS Instance Name set. Edit the connection and set an EBS Instance Name that matches a DB-type connection so SQL can be routed to the DB agent.',
      });
    }
    targetConnId   = paired.id;
    sqlUsername    = 'APPS';
    sqlPassword    = connParams.appsPwd || '';
    sqlServiceName = paired.serviceName || '';
    sqlHost        = paired.host || 'localhost';
    sqlPort        = paired.port || 1521;

    if (!sqlPassword) {
      return res.status(503).json({
        error: 'APPS password not set. Edit the connection and enter the APPS schema password to enable EBS SQL queries.',
      });
    }
  }

  console.log('[ebs-ops/run] targetConnId=%d sqlUsername=%s hasPwd=%s', targetConnId, sqlUsername, !!sqlPassword);

  let agentOnline = false;
  try {
    agentOnline = await Promise.race([
      channel.isAgentConnected(targetConnId),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
  } catch (err) {
    console.error('[ebs-ops/run] isAgentConnected error:', err.message);
    return res.status(500).json({ error: 'Agent check failed: ' + err.message });
  }

  if (!agentOnline) {
    const hint = connParams.serverType === 'apps'
      ? 'The paired DB agent (same EBS instance) is not connected. Start the DB server agent and retry.'
      : 'Agent is not connected. Wait for the agent to check in, then retry.';
    return res.status(503).json({ error: hint });
  }

  try {
    const proxyResp = await channel.sendToAgent(targetConnId, {
      method: 'POST',
      path: '/api/run_sql',
      body: {
        sql: opDef.sql,
        service_name: sqlServiceName,
        username: sqlUsername,
        password: sqlPassword,
        host: sqlHost,
        port: sqlPort,
      },
    }, 30000);
    const body = proxyResp.body || {};
    if (proxyResp.statusCode !== 200 || !body.success) {
      return res.json({ ok: false, error: body.error || `Proxy returned HTTP ${proxyResp.statusCode}` });
    }
    return res.json({
      ok: true,
      rows: body.rows || [],
      columns: body.columns || [],
      durationMs: body.duration_ms,
    });
  } catch (err) {
    console.error('[ebs-ops/run] proxy error:', err.message);
    return res.status(500).json({ error: 'Proxy SQL execution failed', detail: err.message });
  }
});

// ── Middleware op catalog (maps op_key → proxy op string) ─────────────────────
const MIDDLEWARE_OPS_CATALOG = {
  adapcctl_status:        { label: 'Apache / OHS Status',     proxyOp: 'adapcctl_status'        },
  adopmnctl_status:       { label: 'OPMN Status',             proxyOp: 'adopmnctl_status'       },
  adalnctl_status:        { label: 'Apps Listener Status',    proxyOp: 'adalnctl_status'        },
  adnodemgrctl_status:    { label: 'Node Manager Status',     proxyOp: 'adnodemgrctl_status'    },
  wls_admin_status:       { label: 'WLS Admin Server',        proxyOp: 'wls_admin_status'       },
  oacore_status:          { label: 'OACore Servers',          proxyOp: 'oacore_status'          },
  forms_status:           { label: 'Forms Servers',           proxyOp: 'forms_status'           },
  oafm_status:            { label: 'OAFM Servers',            proxyOp: 'oafm_status'            },
  managed_servers_status: { label: 'All Managed Servers',     proxyOp: 'managed_servers_status' },
};

// ── POST /api/ebs-ops/middleware-run ──────────────────────────────────────────
// Body: { connection_id, op_key }
// Routes to the app-tier agent's /api/ebs-ctrl endpoint.

router.post('/api/ebs-ops/middleware-run', requireAuth, async (req, res) => {
  const { connection_id, op_key } = req.body || {};
  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  const opDef = MIDDLEWARE_OPS_CATALOG[op_key];
  if (!opDef) {
    return res.status(400).json({ error: `Unknown middleware op_key: ${op_key}` });
  }

  let conn;
  try {
    conn = await getConnParams(parseInt(connection_id, 10), req.user.id);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load connection', detail: err.message });
  }
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  if (conn.connectionType !== 'proxy') {
    return res.status(400).json({ error: 'Middleware ops require a proxy (agent) connection.' });
  }

  let agentOnline = false;
  try {
    agentOnline = await Promise.race([
      channel.isAgentConnected(conn.id),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
  } catch (_) { /* falls through to offline check */ }

  if (!agentOnline) {
    return res.status(503).json({ error: 'App-tier agent is not connected. Wait for the agent to check in, then retry.' });
  }

  try {
    const managedServerOps = new Set(['oacore_status', 'forms_status', 'oafm_status', 'managed_servers_status']);
    const ctrlTimeout = managedServerOps.has(op_key) ? 130000 : op_key === 'wls_admin_status' ? 75000 : 35000;
    const proxyResp = await channel.sendToAgent(conn.id, {
      method: 'POST',
      path: '/api/ebs-ctrl',
      body: { op: opDef.proxyOp, weblogic_pwd: conn.weblogicPwd || '', apps_pwd: conn.appsPwd || '' },
    }, ctrlTimeout);
    const body = proxyResp.body || {};
    if (proxyResp.statusCode !== 200 || !body.success) {
      return res.json({ ok: false, error: body.error || `Proxy returned HTTP ${proxyResp.statusCode}` });
    }
    return res.json({
      ok:         body.ok,
      stdout:     body.stdout || '',
      exit_code:  body.exit_code,
      durationMs: body.duration_ms,
    });
  } catch (err) {
    console.error('[ebs-ops/middleware-run] error:', err.message);
    return res.status(500).json({ error: 'Middleware run failed', detail: err.message });
  }
});

module.exports = router;
