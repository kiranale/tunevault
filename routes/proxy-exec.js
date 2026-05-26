/**
 * routes/proxy-exec.js — Proxy-based shell command execution.
 *
 * Owns: POST /api/connections/:id/exec — runs a whitelisted command on the
 *       Oracle server through the existing secure tunnel-based HTTPS proxy,
 *       with no SSH required (no port 22, no SSH credentials stored).
 *       GET  /api/connections/:id/exec/audit — recent exec history per connection.
 *
 * Does NOT own: SSH execution (legacy routes/ssh-execute.js, routes/ssh-targets.js),
 *               Oracle queries (oracle-client.js), connection credential storage.
 *
 * Only proxy connections are supported. Direct TCP connections return 400.
 * The command whitelist is enforced by the proxy; this route validates
 * command_id against a local copy of allowed IDs to provide fast 400s.
 *
 * Auth: requireAuth (session cookie or Bearer token).
 * Role: requireRole('junior_dba') minimum — same bar as other exec surfaces.
 */

'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const audit    = require('../db/proxy-exec-audit');
const { decrypt } = require('../crypto-utils');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Allowed command_ids (mirrors oracle-proxy.py _EXEC_WHITELIST keys) ────

const ALLOWED_COMMAND_IDS = new Set([
  'adcmctl_status',
  'adcmctl_start',
  'adcmctl_stop',
  'opmnctl_status',
  'adop_status',
  'tail_log',
  'ps_oracle',
  'df_h',
  'free_m',
  'oratab_read',
  'listener_status',
  'tnsping',
  'crsctl_stat',
  'sqlplus_query',
]);

// ─── Proxy call helper ────────────────────────────────────────────────────────

/**
 * runOnConnection — POST to a connection's proxy /exec endpoint.
 *
 * @param {object} opts
 * @param {number}  opts.connectionId
 * @param {string}  opts.commandId
 * @param {object}  opts.args          — validated arg map (e.g. { path: '/u01/...' })
 * @param {string}  opts.requestorUserId
 * @param {number}  [opts.timeoutS=30]
 * @returns {Promise<{stdout, stderr, exit_code, duration_ms, command_id}>}
 */
async function runOnConnection({ connectionId, commandId, args = {}, requestorUserId, timeoutS = 30 }) {
  const conn = await audit.getProxyConnection(connectionId);

  if (!conn) {
    const err = new Error('Connection not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (conn.connection_type !== 'proxy') {
    const err = new Error('proxy exec requires a proxy connection (not direct TCP)');
    err.code = 'PROXY_REQUIRED';
    throw err;
  }

  if (!conn.proxy_url || !conn.proxy_api_key_enc) {
    const err = new Error('Proxy URL or API key not configured for this connection');
    err.code = 'PROXY_NOT_CONFIGURED';
    throw err;
  }

  let proxyApiKey;
  try {
    proxyApiKey = decrypt(conn.proxy_api_key_enc);
  } catch (e) {
    const err = new Error('Failed to decrypt proxy API key');
    err.code = 'DECRYPT_ERROR';
    throw err;
  }

  return _callProxyExec({
    proxyUrl: conn.proxy_url,
    proxyApiKey,
    commandId,
    args,
    requestorUserId,
    timeoutS,
  });
}

function _callProxyExec({ proxyUrl, proxyApiKey, commandId, args, requestorUserId, timeoutS }) {
  const url  = new URL('/exec', proxyUrl);
  const body = JSON.stringify({
    command_id: commandId,
    args,
    timeout_s:  timeoutS,
    requestor_user_id: String(requestorUserId),
  });

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Key':      proxyApiKey,
      },
      timeout: (timeoutS + 10) * 1000, // extra headroom for network
    };

    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode === 404) {
            const err = new Error('PROXY_OUTDATED: upgrade proxy to v3.5.6+ for /exec support');
            err.code = 'PROXY_OUTDATED';
            return reject(err);
          }
          if (resp.statusCode === 403) {
            const err = new Error(parsed.error || 'command_id not allowed by proxy whitelist');
            err.code = 'PROXY_FORBIDDEN';
            return reject(err);
          }
          if (resp.statusCode === 400) {
            const err = new Error(parsed.error || 'Bad request to proxy');
            err.code = 'PROXY_BAD_REQUEST';
            return reject(err);
          }
          if (resp.statusCode !== 200) {
            const err = new Error(parsed.error || 'Proxy returned HTTP ' + resp.statusCode);
            err.code = 'PROXY_ERROR';
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('Invalid JSON from proxy: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('timeout', () => { req.destroy(new Error('Proxy exec request timed out')); });
    req.on('error',   err => { reject(new Error('Could not reach proxy: ' + err.message)); });

    req.write(body);
    req.end();
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/connections/:id/exec
 *
 * Body: { command_id: string, args?: object, timeout_s?: number }
 * Returns: { success, command_id, stdout, stderr, exit_code, duration_ms }
 */
router.post('/:id/exec', requireAuth, requireRole('junior_dba'), async (req, res) => {
  const connId    = parseInt(req.params.id, 10);
  const commandId = (req.body?.command_id || '').trim();
  const args      = req.body?.args || {};
  const timeoutS  = Math.min(parseInt(req.body?.timeout_s, 10) || 30, 120);

  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });
  if (!commandId) return res.status(400).json({ error: 'command_id is required' });
  if (!ALLOWED_COMMAND_IDS.has(commandId)) {
    return res.status(400).json({
      error: 'Unknown command_id',
      allowed: Array.from(ALLOWED_COMMAND_IDS),
    });
  }

  // Ownership: user must own this connection
  const owned = await audit.getOwnedConnection(connId, req.user.id);
  if (!owned) {
    return res.status(404).json({ error: 'Connection not found or not owned by you' });
  }

  let result;
  let execError = null;

  try {
    result = await runOnConnection({
      connectionId:    connId,
      commandId,
      args,
      requestorUserId: req.user.id,
      timeoutS,
    });
  } catch (err) {
    execError = err;

    // Persist failed attempt to audit log
    await audit.logExec({
      connectionId: connId,
      userId:       req.user.id,
      commandId,
      args,
      exitCode:     -1,
      durationMs:   0,
      error:        err.message,
    }).catch(() => {});

    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'PROXY_REQUIRED') return res.status(400).json({ error: err.message, hint: 'Switch this connection to proxy type and install the agent.' });
    if (err.code === 'PROXY_NOT_CONFIGURED') return res.status(400).json({ error: err.message });
    if (err.code === 'DECRYPT_ERROR') return res.status(500).json({ error: err.message });
    if (err.code === 'PROXY_OUTDATED') return res.status(400).json({ error: err.message, code: 'PROXY_OUTDATED', upgrade: true });
    if (err.code === 'PROXY_FORBIDDEN') return res.status(403).json({ error: err.message });
    if (err.code === 'PROXY_BAD_REQUEST') return res.status(400).json({ error: err.message });
    return res.status(502).json({ error: err.message });
  }

  // Persist successful result to audit log
  await audit.logExec({
    connectionId: connId,
    userId:       req.user.id,
    commandId,
    args,
    exitCode:     result.exit_code,
    durationMs:   result.duration_ms,
    stdout:       result.stdout,
    stderr:       result.stderr,
  }).catch(() => {});

  return res.json({ success: true, ...result });
});

/**
 * GET /api/connections/:id/exec/audit
 *
 * Returns recent exec audit rows for the connection (owner-scoped).
 */
router.get('/:id/exec/audit', requireAuth, requireRole('junior_dba'), async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  // Ownership check
  const owned2 = await audit.getOwnedConnection(connId, req.user.id);
  if (!owned2) {
    return res.status(404).json({ error: 'Connection not found or not owned by you' });
  }

  try {
    const rows = await audit.getAuditLog({ connectionId: connId, limit, offset });
    return res.json({ rows, limit, offset });
  } catch (err) {
    console.error('[proxy-exec] audit log error:', err.message);
    return res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
module.exports.runOnConnection = runOnConnection;
