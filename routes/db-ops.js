/**
 * routes/db-ops.js — DB Operations catalog page + API.
 *
 * Owns: /db-ops page, /api/db-ops/* endpoints (catalog, capabilities, run op, preview).
 * Does NOT own: Oracle connection storage (server.js), SSH vault (routes/ssh-targets.js),
 *               EBS operations (routes/ebs-deep.js), SQL tuning (routes/sql-tuning.js).
 *
 * Routes:
 *   GET  /db-ops                          — serve the operations page
 *   GET  /api/db-ops/catalog              — operation catalog (filtered by capability)
 *   POST /api/db-ops/capabilities         — detect ASM/RAC/PDB for a connection
 *   POST /api/db-ops/preview              — dry-run: returns command preview without executing
 *     Body: { op_key, params? }
 *   POST /api/db-ops/run                  — execute an operation
 *     Body: { connection_id, op_key, target_id?, confirmed?, params? }
 */

'use strict';

const express  = require('express');
const pathM    = require('path');

const pool     = require('../db/index');
const sshDb    = require('../db/ssh-targets');
const { decrypt } = require('../crypto-utils');
const executor = require('../services/db-ops-executor');
const channel  = require('../services/agent-channel');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Helper: load + decrypt oracle connection ─────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type,
            is_asm, is_rac, gi_os_user, gi_oracle_home, asm_sid, cx_oracle_version
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  if (!rows.length) return null;
  const conn = rows[0];
  return {
    id: conn.id,
    host: conn.host,
    port: conn.port || 1521,
    serviceName: conn.service_name,
    username: conn.username,
    password: decrypt(conn.encrypted_password),
    connectionType: conn.connection_type,
    isAsm: !!conn.is_asm,
    isRac: !!conn.is_rac,
    // Grid Infrastructure credentials (optional — null when not configured)
    giOsUser: conn.gi_os_user || null,
    giOracleHome: conn.gi_oracle_home || null,
    asmSid: conn.asm_sid || null,
    // Oracle driver version reported by the agent on last heartbeat — non-null means
    // oracledb/cx_Oracle is installed on the proxy and can execute SQL via /api/run_sql
    cxOracleVersion: conn.cx_oracle_version || null,
  };
}

// ─── GET /db-ops ──────────────────────────────────────────────────────────────

router.get('/db-ops', requireAuth, (req, res) => {
  res.sendFile(pathM.join(__dirname, '..', 'public', 'db-ops.html'));
});

// ─── GET /api/db-ops/catalog ──────────────────────────────────────────────────
// junior_dba+ can view the catalog (read-only list of ops)

router.get('/api/db-ops/catalog', requireAuth, requireRole('junior_dba'), (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ catalog: executor.getOpCatalog() });
});

// ─── POST /api/db-ops/capabilities ───────────────────────────────────────────
// Body: { connection_id }
// junior_dba+ can detect capabilities

router.post('/api/db-ops/capabilities', requireAuth, requireRole('junior_dba'), async (req, res) => {
  console.log('[db-ops/capabilities] called connId=%s', req.body?.connection_id);
  const connId = parseInt(req.body.connection_id, 10);
  if (!connId) return res.status(400).json({ error: 'connection_id required' });

  const connParams = await getConnParams(connId, req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  // hasGi is true when all three GI credential fields are populated
  const hasGi = !!(connParams.giOsUser && connParams.giOracleHome && connParams.asmSid);

  if (connParams.connectionType === 'proxy') {
    const agentOnline = await Promise.race([
      channel.isAgentConnected(connId),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    const hasSqlOps = agentOnline;
    console.log('[db-ops/capabilities] conn=%d agentOnline=%s hasSqlOps=%s cxOracleVersion=%s', connId, agentOnline, hasSqlOps, connParams.cxOracleVersion);
    return res.json({
      hasAsm: connParams.isAsm,
      hasRac: connParams.isRac,
      hasPdb: false,
      hasGi,
      hasSqlOps,
    });
  }

  try {
    const caps = await executor.detectCapabilities(connParams);
    res.json({ ...caps, hasGi });
  } catch (err) {
    console.error('[db-ops] capabilities error:', err.message);
    res.status(500).json({ error: 'Failed to detect capabilities', detail: err.message });
  }
});

// ─── POST /api/db-ops/preview ─────────────────────────────────────────────────
// Dry-run: returns the exact SQL/SSH command that WOULD execute, without running it.
// No Oracle connection required — validates form → command generation pipeline only.
// Body: { op_key, params? }
// All authenticated users can call preview (read-only, no execution).

router.post('/api/db-ops/preview', requireAuth, (req, res) => {
  const { op_key, params } = req.body || {};
  if (!op_key) return res.status(400).json({ error: 'op_key required' });

  const catalog = executor.getOpCatalog();
  const op = catalog.find(o => o.key === op_key);
  if (!op) return res.status(404).json({ error: `Unknown op_key: ${op_key}` });

  // Render template placeholders with caller-supplied params (or show markers)
  let preview = op.commandPreview || '[No command preview available for this operation]';
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      preview = preview.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v || `[${k}]`);
    }
  }

  res.json({
    op_key,
    label:       op.label,
    category:    op.category,
    type:        op.type,
    destructive: op.destructive,
    command_preview: preview,
    preview_note: op.type === 'sql'
      ? 'SQL query — executes against Oracle via Direct TCP connection'
      : 'Shell command — executes via ssh-executor whitelist on the DB server',
    is_dry_run: true,
  });
});

// ─── POST /api/db-ops/run ─────────────────────────────────────────────────────
// Body: { connection_id, op_key, target_id?, confirmed?, params? }
// junior_dba+ for read-only ops; senior_dba+ for destructive ops (enforced after op lookup)

router.post('/api/db-ops/run', requireAuth, requireRole('junior_dba'), async (req, res) => {
  const { connection_id, op_key, target_id, confirmed, params } = req.body || {};

  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  // Destructive ops require senior_dba+. Check op catalog before hitting DB.
  // getOpCatalog() returns an array — use .find() not object key lookup.
  const catalog = executor.getOpCatalog();
  const opDef = catalog.find(o => o.key === op_key);
  if (!opDef) {
    return res.status(400).json({ error: `Unknown op_key: ${op_key}` });
  }
  if (opDef.destructive) {
    // Re-check role for destructive ops — junior_dba gate already passed above,
    // so only deny if user is explicitly junior_dba (not senior_dba/admin, not individual).
    const { ROLE_HIERARCHY } = require('../middleware/auth');
    const userRole = req.userTeamRole; // set by requireRole, undefined = individual account
    if (userRole !== undefined) {
      const rank = ROLE_HIERARCHY.indexOf(userRole);
      const seniorRank = ROLE_HIERARCHY.indexOf('senior_dba');
      if (rank < seniorRank) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          required_role: 'senior_dba',
          your_role: userRole,
        });
      }
    }
  }

  // Demo mode: return sample output for read-only ops
  if (req.body.demo === true || req.query.demo === '1') {
    const demoOutputs = {
      'session_count':        'USERNAME         COUNT\n---------------- -----\nAPPS             42\nSYSTEM           8\nSCOTT            3\nTotal Sessions: 53',
      'tablespace_usage':     'TABLESPACE_NAME  USED_GB  TOTAL_GB  PCT_USED\n---------------- -------- --------- --------\nAPP_DATA         487.3    512.0     95.2%  ← CRITICAL\nARCHIVE_DATA     1021.7   1200.0    85.1%  ← WARNING\nUSERS            142.6    160.0     89.1%  ← WARNING\nAPP_INDEX        198.4    256.0     77.5%  OK\nSYSTEM           2.1      4.0       52.5%  OK',
      'long_running_queries':  'SID  SERIAL  USERNAME  ELAPSED_S  SQL_TEXT\n---  ------  --------  ---------  --------\n142  2341    APPS      4872       SELECT /*+ NO_INDEX */ o.order_id...\n89   1122    SCOTT     1203       UPDATE inventory SET quantity...',
      'invalid_objects':      'OWNER  OBJECT_NAME              OBJECT_TYPE  STATUS\n-----  -----------------------  -----------  -------\nAPPS   WF_ENGINE_CUSTOM         PACKAGE      INVALID\nAPPS   PO_REQAPPROVAL_INIT1     PROCEDURE    INVALID\nSCOTT  DEPT_SALARY_RPT          VIEW         INVALID\n3 invalid objects found.',
      'redo_log_status':      'GROUP  MEMBERS  STATUS      SIZE_MB  ARCHIVED\n-----  -------  ----------  -------  --------\n1      2        ACTIVE      512      NO\n2      2        CURRENT     512      NO\n3      2        INACTIVE    512      YES\n4      2        INACTIVE    512      YES',
      'blocking_sessions':    'BLOCKER_SID  BLOCKER_USER  WAITER_SID  WAITER_USER  WAIT_SECONDS\n-----------  ------------  ----------  -----------  ------------\n142          APPS          89          SCOTT        423\n1 blocking chain detected.',
      'fra_usage':            'SPACE_LIMIT_GB  SPACE_USED_GB  PCT_USED  RECLAIMABLE_GB\n--------------  -------------  --------  --------------\n2048.0          1720.5         84.0%     312.4\nWARNING: FRA at 84% — archivelog pruning may slow down.',
      'pga_target':           'PGA_AGGREGATE_TARGET:  8 GB\nPGA_AGGREGATE_LIMIT:   16 GB\nPGA_USED_MEM:          6.7 GB\nCACHE_HIT_PCT:         94.2%\nOPTIMAL_EXEC_PCT:      97.1%\nONEPASS_EXEC_PCT:      2.4%\nMULTIPASS_EXEC_PCT:    0.5%',
      'sga_components':       'COMPONENT              CURRENT_MB  MIN_MB  MAX_MB\n--------------------- ----------  ------  ------\nBuffer Cache           16384       2048    18432\nShared Pool            4096        512     8192\nLarge Pool             512         128     1024\nJava Pool              128         0       512\nStreams Pool           0           0       256',
    };
    const opKey = (op_key || '').toLowerCase().replace(/-/g, '_');
    const demoOut = demoOutputs[opKey] || `Demo output for: ${opDef.label || op_key}\n\nThis operation would query:\n${opDef.commandPreview || 'Oracle V$ views and DBA_* dictionary tables'}\n\nConnect your real Oracle database to see live data.`;
    return res.json({ success: true, output: demoOut, is_demo: true });
  }

  const connParams = await getConnParams(parseInt(connection_id, 10), req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  // Proxy connections: route SQL ops through the agent channel → /api/run_sql on the proxy
  if (connParams.connectionType === 'proxy') {
    const catalog = executor.getOpCatalog();
    const opEntry = catalog.find(o => o.key === op_key);
    if (!opEntry || opEntry.type !== 'sql') {
      return res.status(400).json({ error: 'Only SQL operations are supported on proxy connections (SSH ops require a direct connection).' });
    }
    if (!await channel.isAgentConnected(connParams.id)) {
      return res.status(503).json({ error: 'Agent is not connected. Wait up to 30 seconds for the agent to check in, then retry.' });
    }
    // Build SQL from the op — render template substitutions
    const renderedSql = executor.renderOpSql(op_key, params || {});
    if (!renderedSql) {
      return res.status(400).json({ error: `Cannot render SQL for op: ${op_key}` });
    }
    if (renderedSql.includes('{{')) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    try {
      const proxyResp = await channel.sendToAgent(connParams.id, {
        method: 'POST',
        path: '/api/run_sql',
        body: {
          sql: renderedSql,
          service_name: connParams.serviceName || '',
          username: connParams.username || '',
          password: connParams.password || '',
          host: connParams.host || 'localhost',
          port: connParams.port || 1521,
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
        text: null,
        durationMs: body.duration_ms,
      });
    } catch (err) {
      console.error('[db-ops] proxy run_sql error:', err.message);
      return res.status(500).json({ error: 'Proxy SQL execution failed', detail: err.message });
    }
  }

  // If SSH op: validate target belongs to this user's connection
  let resolvedTargetId = target_id ? parseInt(target_id, 10) : null;
  if (resolvedTargetId) {
    const target = await sshDb.getTargetById(resolvedTargetId);
    if (!target) return res.status(404).json({ error: 'SSH target not found' });
    if (target.connection_id && target.connection_id !== connParams.id) {
      return res.status(403).json({ error: 'SSH target not associated with this connection' });
    }
  }

  try {
    const result = await executor.runOp({
      opKey: op_key,
      connParams,
      targetId: resolvedTargetId,
      initiatedBy: req.user.email,
      confirmed: !!confirmed,
      params: params || {},
    });

    // If confirmation needed, return 428 so frontend shows modal
    if (!result.ok && result.commandPreview) {
      return res.status(428).json({
        requiresConfirmation: true,
        commandPreview: result.commandPreview,
        opKey: op_key,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[db-ops] run error:', err.message);
    res.status(500).json({ error: 'Operation failed', detail: err.message });
  }
});

module.exports = router;
