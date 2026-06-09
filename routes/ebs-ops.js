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
const EBS_OPS_CATALOG = {
  running_requests: {
    label: 'Running Requests',
    sql: `SELECT request_id, concurrent_program_name, requested_by,
               actual_start_date, phase_code, status_code
        FROM fnd_concurrent_requests
        WHERE phase_code='R' ORDER BY actual_start_date`,
  },
  long_running: {
    label: 'Long Running (>30 min)',
    sql: `SELECT request_id, concurrent_program_name, requested_by,
               ROUND((SYSDATE-actual_start_date)*24*60,1) AS running_minutes
        FROM fnd_concurrent_requests
        WHERE phase_code='R' AND actual_start_date < SYSDATE-30/1440
        ORDER BY actual_start_date`,
  },
  pending_requests: {
    label: 'Pending Requests',
    sql: `SELECT request_id, concurrent_program_name, requested_by,
               requested_start_date, priority
        FROM fnd_concurrent_requests
        WHERE phase_code='P' ORDER BY priority, requested_start_date
        FETCH FIRST 50 ROWS ONLY`,
  },
  failed_requests: {
    label: 'Failed Requests (24h)',
    sql: `SELECT request_id, concurrent_program_name, requested_by,
               actual_completion_date, completion_text
        FROM fnd_concurrent_requests
        WHERE phase_code='C' AND status_code='E'
        AND actual_completion_date > SYSDATE-1
        ORDER BY actual_completion_date DESC
        FETCH FIRST 50 ROWS ONLY`,
  },
  cm_managers: {
    label: 'CM Manager Status',
    sql: `SELECT concurrent_queue_name, manager_type,
               running_processes, target_processes, max_processes
        FROM fnd_concurrent_queues_vl
        WHERE enabled_flag='Y'
        ORDER BY running_processes DESC`,
  },
  opp_queue: {
    label: 'OPP Queue Depth',
    sql: `SELECT COUNT(*) AS pending_count,
               MIN(actual_completion_date) AS oldest_request
        FROM fnd_concurrent_requests
        WHERE phase_code='P' AND concurrent_program_name LIKE '%OPP%'`,
  },
  adop_status: {
    label: 'ADOP Session Status',
    sql: `SELECT session_id, phase, status, start_date, end_date,
               applied_on_node
        FROM ad_adop_sessions
        ORDER BY start_date DESC FETCH FIRST 10 ROWS ONLY`,
  },
  applied_patches: {
    label: 'Recent Patches (90 days)',
    sql: `SELECT patch_name, patch_type, creation_date, last_update_date
        FROM ad_applied_patches
        WHERE creation_date > SYSDATE-90
        ORDER BY creation_date DESC
        FETCH FIRST 50 ROWS ONLY`,
  },
  invalid_objects: {
    label: 'APPS Invalid Objects',
    sql: `SELECT owner, object_type, COUNT(*) AS invalid_count
        FROM dba_objects
        WHERE status='INVALID' AND owner IN (
          SELECT oracle_username FROM fnd_oracle_userid
          WHERE read_only_flag='U'
        )
        GROUP BY owner, object_type
        ORDER BY invalid_count DESC`,
  },
};

// ── Helper: load + decrypt connection ────────────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type
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
    password: decrypt(c.encrypted_password),
    connectionType: c.connection_type,
  };
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

  if (connParams.connectionType !== 'proxy') {
    return res.status(400).json({ error: 'Direct TCP connections are not yet supported for EBS SQL ops. Use a proxy (agent) connection.' });
  }

  let agentOnline = false;
  try {
    agentOnline = await Promise.race([
      channel.isAgentConnected(connParams.id),
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
  } catch (err) {
    console.error('[ebs-ops/run] isAgentConnected error:', err.message);
    return res.status(500).json({ error: 'Agent check failed: ' + err.message });
  }

  if (!agentOnline) {
    return res.status(503).json({ error: 'Agent is not connected. Wait for the agent to check in, then retry.' });
  }

  try {
    const proxyResp = await channel.sendToAgent(connParams.id, {
      method: 'POST',
      path: '/api/run_sql',
      body: {
        sql: opDef.sql,
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
      durationMs: body.duration_ms,
    });
  } catch (err) {
    console.error('[ebs-ops/run] proxy error:', err.message);
    return res.status(500).json({ error: 'Proxy SQL execution failed', detail: err.message });
  }
});

module.exports = router;
