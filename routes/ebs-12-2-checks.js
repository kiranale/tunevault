/**
 * routes/ebs-12-2-checks.js — EBS 12.2 deep checks API + page.
 *
 * Owns: /ebs-12-2-checks page, /api/ebs-12-2/* endpoints.
 * Does NOT own: Oracle connection storage (server.js), SSH vault (routes/ssh-targets.js),
 *               core health checks (server.js), EBS SSH checks (routes/ebs-ssh-checks.js).
 *
 * Routes:
 *   GET  /ebs-12-2-checks              — serve the deep checks page
 *   GET  /api/ebs-12-2/catalog         — check catalog metadata (no SQL/parsers)
 *   GET  /api/ebs-12-2/counts          — CHECK_COUNTS constant (marketing single source of truth)
 *   POST /api/ebs-12-2/run             — run checks for a connection
 *     Body: { connection_id, ssh_target_id? }
 */

'use strict';

const express = require('express');
const path    = require('path');

const pool         = require('../db/index');
const { decrypt }  = require('../crypto-utils');
const sshDb        = require('../db/ssh-targets');
const { requireAuth } = require('../middleware/auth');
const {
  runEbs122Checks,
  getCheckCatalog,
  CHECK_COUNTS,
} = require('../services/ebs-12-2-checks');

const router = express.Router();

// ─── Helper: load + decrypt oracle connection ─────────────────────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password, connection_type, proxy_url, proxy_api_key_enc
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
    proxyUrl: conn.proxy_url || null,
    proxyApiKey: conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null,
  };
}

// ─── GET /ebs-12-2-checks ─────────────────────────────────────────────────────

router.get('/ebs-12-2-checks', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-12-2-checks.html'));
});

// ─── GET /api/ebs-12-2/catalog ───────────────────────────────────────────────

router.get('/api/ebs-12-2/catalog', requireAuth, (req, res) => {
  res.json({ catalog: getCheckCatalog() });
});

// ─── GET /api/ebs-12-2/counts ────────────────────────────────────────────────
// Single source of truth for check counts used in marketing copy.

router.get('/api/ebs-12-2/counts', (req, res) => {
  res.json({
    db_core: CHECK_COUNTS.db_core,
    ebs_native: CHECK_COUNTS.ebs_native,
    ebs_ssh_legacy: CHECK_COUNTS.ebs_ssh_legacy,
    ebs_12_2: CHECK_COUNTS.ebs_12_2,
    ebs_security: CHECK_COUNTS.ebs_security,
    ebs_performance: CHECK_COUNTS.ebs_performance,
    db_ops: CHECK_COUNTS.db_ops,
    db_total: CHECK_COUNTS.db_total,
    ebs_total: CHECK_COUNTS.ebs_total,
    health_checks_total: CHECK_COUNTS.health_checks_total,
    grand_total_with_ops: CHECK_COUNTS.grand_total_with_ops,
  });
});

// ─── POST /api/ebs-12-2/run ──────────────────────────────────────────────────

router.post('/api/ebs-12-2/run', requireAuth, async (req, res) => {
  const { connection_id, ssh_target_id } = req.body || {};
  if (!connection_id) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const connParams = await getConnParams(connection_id, req.user.id);
  if (!connParams) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  // Resolve SSH target if provided
  let sshTarget = null;
  if (ssh_target_id) {
    const targets = await sshDb.listTargetsByUser(req.user.id);
    sshTarget = targets.find(t => t.id === parseInt(ssh_target_id, 10)) || null;
    if (!sshTarget) {
      return res.status(404).json({ error: 'SSH target not found' });
    }
  }

  // Oracle client lazy-load
  let oracleConn = null;
  let oracleClient = null;
  try {
    oracleClient = require('../oracle-client');
    if (connParams.connectionType === 'proxy' && connParams.proxyUrl) {
      // Proxy mode: TNS checks not available — surface as info
      oracleConn = null;
    } else {
      const oracledb = require('oracledb');
      oracleConn = await oracledb.getConnection({
        user: connParams.username,
        password: connParams.password,
        connectString: `${connParams.host}:${connParams.port}/${connParams.serviceName}`,
      });
    }
  } catch (err) {
    // Non-fatal: run with null conn (TNS checks will be stubbed)
    console.warn('ebs-12-2-checks: oracle connect failed:', err.message);
    oracleConn = null;
  }

  try {
    const results = await runEbs122Checks({
      oracleConn,
      targetId: sshTarget ? sshTarget.id : null,
      role: sshTarget ? sshTarget.role : null,
      initiatedBy: req.user.email,
      timeoutMs: 20_000,
    });

    res.json({
      connection_id,
      ssh_target_id: sshTarget ? sshTarget.id : null,
      ...results,
    });
  } finally {
    if (oracleConn) {
      try { await oracleConn.close(); } catch {}
    }
  }
});

module.exports = router;
