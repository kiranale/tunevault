/**
 * routes/ebs-security-performance.js — EBS Security + Performance checks API.
 *
 * Owns: /api/ebs-security/* and /api/ebs-performance/* endpoints.
 * Does NOT own: Oracle connection storage (server.js), SSH vault (routes/ssh-targets.js),
 *               core health checks (server.js), EBS 12.2 deep checks (routes/ebs-12-2-checks.js).
 *
 * Routes:
 *   GET  /api/ebs-security/catalog     — ES01–ES08 catalog metadata
 *   POST /api/ebs-security/run         — run security checks for a connection
 *   GET  /api/ebs-performance/catalog  — EP01–EP06 catalog metadata
 *   POST /api/ebs-performance/run      — run performance checks for a connection
 *   POST /api/ebs-sp/run               — run all 14 security + performance checks together
 *
 * Body for run endpoints: { connection_id, ssh_target_id? }
 */

'use strict';

const express = require('express');

const pool        = require('../db/index');
const { decrypt } = require('../crypto-utils');
const sshDb       = require('../db/ssh-targets');
const { requireAuth } = require('../middleware/auth');
const {
  runEbsSecurityChecks,
  getCheckCatalog: getSecurityCatalog,
  EBS_SECURITY_CHECKS,
} = require('../services/ebs-security-checks');
const {
  runEbsPerformanceChecks,
  getCheckCatalog: getPerformanceCatalog,
  EBS_PERFORMANCE_CHECKS,
} = require('../services/ebs-performance-checks');

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

// ─── Helper: build oracle connection ─────────────────────────────────────────

async function buildOracleConn(connParams) {
  if (connParams.connectionType === 'proxy' && connParams.proxyUrl) {
    return null; // TNS checks not available in proxy mode
  }
  try {
    const oracledb = require('oracledb');
    return await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port}/${connParams.serviceName}`,
    });
  } catch (err) {
    console.warn('ebs-security-performance: oracle connect failed:', err.message);
    return null;
  }
}

// ─── Helper: resolve SSH target ───────────────────────────────────────────────

async function resolveSshTarget(userId, sshTargetId) {
  if (!sshTargetId) return null;
  const targets = await sshDb.listTargetsByUser(userId);
  return targets.find(t => t.id === parseInt(sshTargetId, 10)) || null;
}

// ─── GET /api/ebs-security/catalog ────────────────────────────────────────────

router.get('/api/ebs-security/catalog', requireAuth, (req, res) => {
  res.json({ catalog: getSecurityCatalog() });
});

// ─── GET /api/ebs-performance/catalog ─────────────────────────────────────────

router.get('/api/ebs-performance/catalog', requireAuth, (req, res) => {
  res.json({ catalog: getPerformanceCatalog() });
});

// ─── POST /api/ebs-security/run ───────────────────────────────────────────────

router.post('/api/ebs-security/run', requireAuth, async (req, res) => {
  const { connection_id, ssh_target_id } = req.body || {};
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });

  const connParams = await getConnParams(connection_id, req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  const sshTarget = await resolveSshTarget(req.user.id, ssh_target_id);
  if (ssh_target_id && !sshTarget) return res.status(404).json({ error: 'SSH target not found' });

  const oracleConn = await buildOracleConn(connParams);
  try {
    const results = await runEbsSecurityChecks({
      oracleConn,
      targetId: sshTarget ? sshTarget.id : null,
      role: sshTarget ? sshTarget.role : null,
      initiatedBy: req.user.email,
      timeoutMs: 20_000,
    });
    res.json({ connection_id, ssh_target_id: sshTarget ? sshTarget.id : null, ...results });
  } finally {
    if (oracleConn) { try { await oracleConn.close(); } catch {} }
  }
});

// ─── POST /api/ebs-performance/run ────────────────────────────────────────────

router.post('/api/ebs-performance/run', requireAuth, async (req, res) => {
  const { connection_id, ssh_target_id } = req.body || {};
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });

  const connParams = await getConnParams(connection_id, req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  const sshTarget = await resolveSshTarget(req.user.id, ssh_target_id);
  if (ssh_target_id && !sshTarget) return res.status(404).json({ error: 'SSH target not found' });

  const oracleConn = await buildOracleConn(connParams);
  try {
    const results = await runEbsPerformanceChecks({
      oracleConn,
      targetId: sshTarget ? sshTarget.id : null,
      role: sshTarget ? sshTarget.role : null,
      initiatedBy: req.user.email,
      timeoutMs: 20_000,
    });
    res.json({ connection_id, ssh_target_id: sshTarget ? sshTarget.id : null, ...results });
  } finally {
    if (oracleConn) { try { await oracleConn.close(); } catch {} }
  }
});

// ─── POST /api/ebs-sp/run — run all 14 security + performance checks together ──

router.post('/api/ebs-sp/run', requireAuth, async (req, res) => {
  const { connection_id, ssh_target_id } = req.body || {};
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });

  const connParams = await getConnParams(connection_id, req.user.id);
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  const sshTarget = await resolveSshTarget(req.user.id, ssh_target_id);
  if (ssh_target_id && !sshTarget) return res.status(404).json({ error: 'SSH target not found' });

  const oracleConn = await buildOracleConn(connParams);
  try {
    const runOpts = {
      oracleConn,
      targetId: sshTarget ? sshTarget.id : null,
      role: sshTarget ? sshTarget.role : null,
      initiatedBy: req.user.email,
      timeoutMs: 20_000,
    };
    const [securityResult, performanceResult] = await Promise.all([
      runEbsSecurityChecks(runOpts),
      runEbsPerformanceChecks(runOpts),
    ]);

    const combined = {
      security: securityResult,
      performance: performanceResult,
      summary: {
        ok:    (securityResult.summary.ok    || 0) + (performanceResult.summary.ok    || 0),
        warn:  (securityResult.summary.warn  || 0) + (performanceResult.summary.warn  || 0),
        crit:  (securityResult.summary.crit  || 0) + (performanceResult.summary.crit  || 0),
        info:  (securityResult.summary.info  || 0) + (performanceResult.summary.info  || 0),
        error: (securityResult.summary.error || 0) + (performanceResult.summary.error || 0),
      },
      ranAt: new Date().toISOString(),
    };
    res.json({ connection_id, ssh_target_id: sshTarget ? sshTarget.id : null, ...combined });
  } finally {
    if (oracleConn) { try { await oracleConn.close(); } catch {} }
  }
});

module.exports = router;
