/**
 * routes/ebs-middleware.js — EBS Application Tier middleware operations.
 *
 * Owns: /ebs-middleware page, /api/ebs-middleware/* endpoints (catalog, run op,
 *       context-servers, rolling-bounce).
 * Does NOT own: credential storage (db/ssh-targets.js), SSH execution (services/ssh-executor.js),
 *               Oracle DB queries, EBS Oracle checks (routes/ebs-deep.js).
 *
 * Routes:
 *   GET  /ebs-middleware                              — serve the middleware ops page
 *   GET  /api/ebs-middleware/catalog                  — EBS middleware op catalog
 *   POST /api/ebs-middleware/run                      — execute a middleware op via SSH
 *     Body: { connection_id, op_key, target_id, confirmed? }
 *   GET  /api/ebs-middleware/context-servers          — detect OACore/Forms server count from context file
 *     Query: connection_id, target_id
 *   POST /api/ebs-middleware/rolling-bounce           — SSE stream: rolling bounce for OACore or Forms
 *     Body: { connection_id, target_id, server_type: 'oacore'|'forms', servers: string[] }
 *
 * Only SSH ops (apps_tier role). Only visible/useful for EBS connections.
 */

'use strict';

const express  = require('express');
const pathM    = require('path');

const pool     = require('../db/index');
const sshDb    = require('../db/ssh-targets');
const executor = require('../services/db-ops-executor');
const sshExec  = require('../services/ssh-executor');

const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ─── Catalog: only EBS middleware categories ──────────────────────────────────

const EBS_MIDDLEWARE_CATEGORIES = new Set(['wls', 'apache', 'apps_listener']);

function getMiddlewareCatalog() {
  return executor.getOpCatalog().filter(op => EBS_MIDDLEWARE_CATEGORIES.has(op.category));
}

// ─── GET /ebs-middleware ──────────────────────────────────────────────────────

router.get('/ebs-middleware', requireAuth, (req, res) => {
  res.sendFile(pathM.join(__dirname, '..', 'public', 'ebs-middleware.html'));
});

// ─── GET /api/ebs-middleware/catalog ─────────────────────────────────────────

router.get('/api/ebs-middleware/catalog', requireAuth, (req, res) => {
  res.json({ catalog: getMiddlewareCatalog() });
});

// ─── POST /api/ebs-middleware/run ─────────────────────────────────────────────
// Body: { connection_id, op_key, target_id, confirmed? }

router.post('/api/ebs-middleware/run', requireAuth, async (req, res) => {
  const { connection_id, op_key, target_id, confirmed } = req.body || {};

  if (!connection_id || !op_key) {
    return res.status(400).json({ error: 'connection_id and op_key required' });
  }

  // Verify op is in the middleware catalog (not arbitrary op_key)
  const catalog = getMiddlewareCatalog();
  if (!catalog.find(o => o.key === op_key)) {
    return res.status(400).json({ error: 'Unknown or disallowed op_key for EBS middleware' });
  }

  // Verify oracle connection belongs to this user
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [parseInt(connection_id, 10), req.user.id]
  );
  if (!connRows.length) return res.status(404).json({ error: 'Connection not found' });

  if (!target_id) {
    return res.status(400).json({ error: 'SSH target required for EBS middleware operations' });
  }

  const resolvedTargetId = parseInt(target_id, 10);
  const target = await sshDb.getTargetById(resolvedTargetId);
  if (!target) return res.status(404).json({ error: 'SSH target not found' });
  if (target.connection_id && target.connection_id !== parseInt(connection_id, 10)) {
    return res.status(403).json({ error: 'SSH target not associated with this connection' });
  }

  // SSH-only ops don't need connParams; pass a minimal object
  const connParams = { id: parseInt(connection_id, 10), connectionType: 'direct' };

  try {
    const result = await executor.runOp({
      opKey: op_key,
      connParams,
      targetId: resolvedTargetId,
      initiatedBy: req.user.email,
      confirmed: !!confirmed,
      params: {},
    });

    if (!result.ok && result.commandPreview) {
      return res.status(428).json({
        requiresConfirmation: true,
        commandPreview: result.commandPreview,
        opKey: op_key,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[ebs-middleware] run error:', err.message);
    res.status(500).json({ error: 'Operation failed', detail: err.message });
  }
});

// ─── GET /api/ebs-middleware/context-servers ──────────────────────────────────
// Parses EBS context file to discover OACore and Forms managed server instances.
// Returns { oacore: string[], forms: string[] }
router.get('/api/ebs-middleware/context-servers', requireAuth, async (req, res) => {
  const { connection_id, target_id } = req.query;
  if (!connection_id || !target_id) {
    return res.status(400).json({ error: 'connection_id and target_id required' });
  }

  // Verify ownership
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [parseInt(connection_id, 10), req.user.id]
  );
  if (!connRows.length) return res.status(404).json({ error: 'Connection not found' });

  const target = await sshDb.getTargetById(parseInt(target_id, 10));
  if (!target) return res.status(404).json({ error: 'SSH target not found' });

  try {
    const [oacoreRes, formsRes] = await Promise.all([
      sshExec.runCommand({ targetId: parseInt(target_id, 10), commandKey: 'ebs.context.parse.oacore', initiatedBy: req.user.email }),
      sshExec.runCommand({ targetId: parseInt(target_id, 10), commandKey: 'ebs.context.parse.forms',  initiatedBy: req.user.email }),
    ]);

    // Parse output: each line is a server name like "oacore_server1"
    function parseServerList(stdout) {
      if (!stdout) return [];
      return stdout.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('CONTEXT_FILE_NOT_FOUND') && !l.startsWith('STATUS_') && /^(oacore|forms)_server\d+$/.test(l));
    }

    const oacoreServers = parseServerList(oacoreRes.stdout);
    const formsServers  = parseServerList(formsRes.stdout);

    // Fallback: if XML parsing failed, try to infer from admanagedsrvctl status output
    // (grep stdout for server names that show up)
    if (oacoreServers.length === 0 && !oacoreRes.ok) {
      // Default to single server assumption
      oacoreServers.push('oacore_server1');
    }
    if (formsServers.length === 0 && !formsRes.ok) {
      formsServers.push('forms_server1');
    }

    res.json({ oacore: oacoreServers, forms: formsServers, parseOk: oacoreRes.ok && formsRes.ok });
  } catch (err) {
    res.status(500).json({ error: 'Context file parse failed', detail: err.message });
  }
});

// ─── POST /api/ebs-middleware/rolling-bounce (SSE) ───────────────────────────
// Streams rolling bounce progress via Server-Sent Events.
// Body: { connection_id, target_id, server_type: 'oacore'|'forms', servers: string[] }
// Events: { type: 'start'|'step'|'complete'|'error'|'abort', ... }
router.post('/api/ebs-middleware/rolling-bounce', requireAuth, async (req, res) => {
  const { connection_id, target_id, server_type, servers } = req.body || {};

  if (!connection_id || !target_id || !server_type || !Array.isArray(servers) || !servers.length) {
    return res.status(400).json({ error: 'connection_id, target_id, server_type and servers[] required' });
  }
  if (!['oacore', 'forms'].includes(server_type)) {
    return res.status(400).json({ error: 'server_type must be oacore or forms' });
  }

  // Validate server names — only allow oacore_serverN and forms_serverN (prevent injection)
  const validName = /^(oacore|forms)_server\d{1,3}$/;
  if (!servers.every(s => validName.test(s))) {
    return res.status(400).json({ error: 'Invalid server name format' });
  }

  // Verify ownership
  const { rows: connRows } = await pool.query(
    'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2',
    [parseInt(connection_id, 10), req.user.id]
  );
  if (!connRows.length) return res.status(404).json({ error: 'Connection not found' });

  const target = await sshDb.getTargetById(parseInt(target_id, 10));
  if (!target) return res.status(404).json({ error: 'SSH target not found' });

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Abort flag — client disconnect sets this
  let aborted = false;
  req.on('close', () => { aborted = true; });

  function send(payload) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  const targetId = parseInt(target_id, 10);
  const total    = servers.length;

  send({ type: 'start', serverType: server_type, servers, total });

  // Track which servers are up throughout (all start as UP)
  const serverState = Object.fromEntries(servers.map(s => [s, 'UP']));

  for (let i = 0; i < servers.length; i++) {
    if (aborted) {
      send({ type: 'abort', message: 'Client disconnected — remaining servers left untouched', index: i });
      res.end();
      return;
    }

    const serverName = servers[i];
    const remaining  = servers.slice(i + 1);
    const done       = servers.slice(0, i);

    send({ type: 'step', phase: 'stopping', serverName, index: i, total, done, remaining, serverState });

    // ── Step 1: Stop this server ──────────────────────────────────────────────
    const stopResult = await sshExec.runCommand({
      targetId,
      commandKey: 'wls.managed.stop.byname',
      initiatedBy: req.user.email,
      extraVars: { WLS_SERVER_NAME: serverName },
      timeoutMs: 120_000, // 2 min for WLS stop
    });

    if (aborted) { send({ type: 'abort', message: 'Aborted after stop', index: i }); res.end(); return; }

    if (!stopResult.ok) {
      // Check if it's already stopped (not a real failure)
      const alreadyDown = /STOPPED|not running|already|STANDBY/i.test(stopResult.stdout + stopResult.stderr);
      if (!alreadyDown) {
        send({
          type: 'error',
          message: `Failed to stop ${serverName}. Rolling bounce halted to prevent cascading outage.`,
          serverName,
          index: i,
          stdout: stopResult.stdout,
          stderr: stopResult.stderr,
        });
        res.end();
        return;
      }
    }

    serverState[serverName] = 'DOWN';

    send({ type: 'step', phase: 'verifying_down', serverName, index: i, total, done, remaining, serverState });

    // ── Step 2: Poll for confirmed shutdown (up to 60s) ────────────────────
    let isDown = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (aborted) { send({ type: 'abort', message: 'Aborted during shutdown wait', index: i }); res.end(); return; }
      await sleep(10_000);
      const statusResult = await sshExec.runCommand({
        targetId,
        commandKey: 'wls.managed.status.byname',
        initiatedBy: req.user.email,
        extraVars: { WLS_SERVER_NAME: serverName },
        timeoutMs: 30_000,
      });
      const out = (statusResult.stdout + statusResult.stderr).toLowerCase();
      if (/stopped|not running|shutdown/i.test(out) || !/running/i.test(out)) {
        isDown = true;
        break;
      }
      send({ type: 'step', phase: 'waiting_down', serverName, index: i, total, attempt: attempt + 1, serverState });
    }

    if (!isDown) {
      send({
        type: 'error',
        message: `${serverName} did not confirm shutdown within 60s. Rolling bounce halted.`,
        serverName,
        index: i,
      });
      res.end();
      return;
    }

    send({ type: 'step', phase: 'starting', serverName, index: i, total, done, remaining, serverState });

    // ── Step 3: Start this server ─────────────────────────────────────────────
    const startResult = await sshExec.runCommand({
      targetId,
      commandKey: 'wls.managed.start.byname',
      initiatedBy: req.user.email,
      extraVars: { WLS_SERVER_NAME: serverName },
      timeoutMs: 180_000, // 3 min for WLS start
    });

    if (aborted) { send({ type: 'abort', message: 'Aborted after start', index: i }); res.end(); return; }

    if (!startResult.ok) {
      send({
        type: 'error',
        message: `Failed to start ${serverName}. Rolling bounce halted.`,
        serverName,
        index: i,
        stdout: startResult.stdout,
        stderr: startResult.stderr,
      });
      res.end();
      return;
    }

    send({ type: 'step', phase: 'verifying_up', serverName, index: i, total, done, remaining, serverState });

    // ── Step 4: Poll for confirmed startup (up to 90s) ────────────────────
    let isUp = false;
    for (let attempt = 0; attempt < 9; attempt++) {
      if (aborted) { send({ type: 'abort', message: 'Aborted during startup wait', index: i }); res.end(); return; }
      await sleep(10_000);
      const statusResult = await sshExec.runCommand({
        targetId,
        commandKey: 'wls.managed.status.byname',
        initiatedBy: req.user.email,
        extraVars: { WLS_SERVER_NAME: serverName },
        timeoutMs: 30_000,
      });
      const out = statusResult.stdout + statusResult.stderr;
      if (/RUNNING/i.test(out)) {
        isUp = true;
        break;
      }
      // Warn on timeout
      if (attempt >= 5) {
        send({ type: 'step', phase: 'startup_slow', serverName, index: i, total, attempt: attempt + 1, serverState });
      } else {
        send({ type: 'step', phase: 'waiting_up', serverName, index: i, total, attempt: attempt + 1, serverState });
      }
    }

    if (!isUp) {
      send({
        type: 'error',
        message: `${serverName} did not reach RUNNING state within 90s. Rolling bounce halted.`,
        serverName,
        index: i,
      });
      res.end();
      return;
    }

    serverState[serverName] = 'UP';
    send({ type: 'step', phase: 'done', serverName, index: i, total, done: servers.slice(0, i + 1), remaining: servers.slice(i + 1), serverState });
  }

  send({ type: 'complete', serverType: server_type, servers, message: `Rolling bounce complete — all ${total} servers restarted without downtime.` });
  res.end();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = router;
