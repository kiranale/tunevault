/**
 * routes/connection-targets.js — Connection Targets (replaces SSH Targets).
 *
 * Owns: /settings/connection-targets page, /admin/connection-targets page,
 *       GET /api/connection-targets — list proxy agent registrations scoped to user,
 *       POST /api/connection-targets/:id/health-check — proxy /exec ping_db via existing executor.
 *       Also owns 410 tombstones for retired /api/ssh/targets/* and /api/user/ssh/* CRUD.
 *
 * Does NOT own: oracle_connections CRUD, SSH credential vault (ssh_targets table),
 *               proxy /exec execution (routes/proxy-exec.js).
 *
 * Heartbeat freshness thresholds:
 *   green  = last_heartbeat < 120s ago
 *   amber  = 120s–10min
 *   red    = > 10min or no heartbeat
 */

'use strict';

const express = require('express');
const path    = require('path');
const pool    = require('../db/index');
const { requireAuth, requireAdmin, requireAdminPage } = require('../middleware/auth');
const { decrypt } = require('../crypto-utils');
const https   = require('https');
const http    = require('http');

const channel = require('../services/agent-channel');

const router = express.Router();

// ─── Heartbeat thresholds ────────────────────────────────────────────────────

const GREEN_MS = 2 * 60 * 1000;      // 2 min
const AMBER_MS = 10 * 60 * 1000;     // 10 min

function heartbeatStatus(lastHeartbeat) {
  if (!lastHeartbeat) return 'none';
  const age = Date.now() - new Date(lastHeartbeat).getTime();
  if (age < GREEN_MS)  return 'green';
  if (age < AMBER_MS)  return 'amber';
  return 'red';
}

// ─── DB query helpers ─────────────────────────────────────────────────────────

/**
 * List all proxy connections + their tunnel rows, scoped to a user.
 * Admin view returns all rows.
 */
async function listConnectionTargets(userId, isAdmin) {
  const whereClause = isAdmin ? '' : 'AND oc.user_id = $1';
  const params      = isAdmin ? [] : [userId];

  const { rows } = await pool.query(`
    SELECT
      oc.id            AS connection_id,
      oc.name          AS label,
      oc.host,
      oc.proxy_url,
      oc.proxy_key_last_used_at,
      at.tunnel_uuid,
      at.tunnel_name,
      at.dns_hostname,
      at.status        AS tunnel_status,
      at.os_info,
      at.oracle_sids,
      at.last_heartbeat,
      at.provisioned_at,
      at.confirmed_at,
      at.updated_at    AS tunnel_updated_at
    FROM oracle_connections oc
    LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
    WHERE oc.connection_type = 'proxy'
      AND oc.proxy_url IS NOT NULL
      AND oc.proxy_url NOT LIKE '%pending%'
      ${whereClause}
    ORDER BY oc.name
  `, params);

  return rows.map(r => ({
    ...r,
    heartbeat_status: heartbeatStatus(r.last_heartbeat),
  }));
}

/**
 * Fetch a single proxy connection row (for health-check ownership guard).
 */
async function getProxyConnectionForUser(connectionId, userId, isAdmin) {
  const where = isAdmin ? 'WHERE id = $1' : 'WHERE id = $1 AND user_id = $2';
  const params = isAdmin ? [connectionId] : [connectionId, userId];
  const { rows } = await pool.query(
    `SELECT id, name, proxy_url, proxy_api_key_enc, connection_type FROM oracle_connections ${where}`,
    params
  );
  return rows[0] || null;
}

// ─── Proxy call helper ────────────────────────────────────────────────────────

function callProxyExec({ proxyUrl, proxyApiKey, commandId, requestorUserId }) {
  const url  = new URL('/exec', proxyUrl);
  const body = JSON.stringify({
    command_id: commandId,
    args: {},
    timeout_s: 15,
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
      timeout: 25000,
    };

    const req = transport.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: resp.statusCode, parsed });
        } catch (e) {
          reject(new Error('Invalid JSON from proxy'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxy request timed out')));
    req.on('error',   err => reject(err));
    req.write(body);
    req.end();
  });
}

// ─── UI pages ─────────────────────────────────────────────────────────────────

router.get('/settings/connection-targets', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings/connection-targets.html'));
});

router.get('/admin/connection-targets', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/connection-targets.html'));
});

// ─── 301 redirects from legacy SSH Targets URLs ───────────────────────────────

router.get('/settings/ssh-targets', (req, res) => {
  res.redirect(301, '/settings/connection-targets');
});

router.get('/admin/ssh-targets', (req, res) => {
  res.redirect(301, '/admin/connection-targets');
});

// ─── API: List connection targets ─────────────────────────────────────────────

router.get('/api/connection-targets', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.isAdmin === true;
    const targets = await listConnectionTargets(req.user.id, isAdmin);
    res.json({ targets });
  } catch (err) {
    console.error('[connection-targets] list error:', err.message);
    res.status(500).json({ error: 'Failed to load connection targets' });
  }
});

// ─── API: Health check (proxy /exec ping_db) ──────────────────────────────────

router.post('/api/connection-targets/:id/health-check', requireAuth, async (req, res) => {
  const connId  = parseInt(req.params.id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  const isAdmin = req.user?.isAdmin === true;
  const started = Date.now();

  try {
    const conn = await getProxyConnectionForUser(connId, req.user.id, isAdmin);
    if (!conn) return res.status(404).json({ error: 'Connection not found or not accessible' });
    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'Health check requires a proxy connection' });
    }

    if (!conn.proxy_url || !conn.proxy_api_key_enc) {
      return res.status(400).json({ error: 'Proxy not configured for this connection' });
    }

    // Try agent channel first — the proxy long-polls for work
    const useChannel = await channel.isAgentConnected(connId);

    if (!useChannel) {
      // Check heartbeat staleness only when channel is down
      const { rows: [tunnelRow] } = await pool.query(
        'SELECT last_heartbeat FROM agent_tunnels WHERE connection_id = $1',
        [connId]
      );
      if (tunnelRow && tunnelRow.last_heartbeat) {
        const ageMs = Date.now() - new Date(tunnelRow.last_heartbeat).getTime();
        if (ageMs > AMBER_MS) {
          return res.status(503).json({
            ok: false,
            error: 'Agent not connected. Install or restart the TuneVault Agent on the Oracle server.',
            stale_heartbeat: tunnelRow.last_heartbeat,
          });
        }
      }
      // No active channel and no recent heartbeat — agent isn't reachable
      if (!conn.proxy_url || !conn.proxy_api_key_enc) {
        return res.status(503).json({
          ok: false,
          error: 'Agent not connected. Wait for the agent to establish a connection (usually under 30 seconds after install).',
        });
      }
    }

    let statusCode, parsed;

    if (useChannel) {
      // Route through agent's outbound polling channel
      try {
        const chResp = await channel.sendToAgent(connId, {
          method: 'POST',
          path: '/exec',
          body: { command_id: 'sqlplus_query', args: {}, timeout_s: 15, requestor_user_id: String(req.user.id) },
        }, 25000);
        statusCode = chResp.statusCode;
        parsed = chResp.body;
      } catch (chErr) {
        const durationMs = Date.now() - started;
        return res.json({ ok: false, label: `✗ Agent channel error: ${chErr.message}`, duration_ms: durationMs, error: chErr.message });
      }
    } else {
      // Fall back to direct HTTP
      let proxyApiKey;
      try {
        proxyApiKey = decrypt(conn.proxy_api_key_enc);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to decrypt proxy API key' });
      }
      const httpResp = await callProxyExec({
        proxyUrl:        conn.proxy_url,
        proxyApiKey,
        commandId:       'sqlplus_query',
        requestorUserId: req.user.id,
      });
      statusCode = httpResp.statusCode;
      parsed = httpResp.parsed;
    }

    const durationMs = Date.now() - started;

    if (statusCode === 200) {
      return res.json({
        ok: true,
        label: `✓ Reachable (${durationMs}ms)`,
        duration_ms: durationMs,
        exit_code: parsed.exit_code,
        stdout: parsed.stdout || '',
      });
    }

    return res.json({
      ok: false,
      label: `✗ Failed (${parsed.error || 'proxy error'})`,
      duration_ms: durationMs,
      error: parsed.error || `Proxy returned HTTP ${statusCode}`,
    });

  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err.message || 'Connection failed';
    return res.status(200).json({   // 200 so browser JS can parse body
      ok: false,
      label: `✗ Failed (${msg})`,
      duration_ms: durationMs,
      error: msg,
    });
  }
});

// ─── 410 tombstones — retired SSH CRUD endpoints ──────────────────────────────
// Prevents silent failures if any client still calls the old API paths.

const RETIRED_MSG = { error: 'SSH targets retired; use /api/connection-targets' };

// Express 5 (path-to-regexp v8) requires {*name} for wildcards — bare * is invalid.
router.all('/api/ssh/targets{*path}',      (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/ssh/run',                 (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/ssh/whitelist',           (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/ssh/audit{*path}',        (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/user/ssh/targets{*path}', (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/user/ssh/connections',    (_req, res) => res.status(410).json(RETIRED_MSG));
router.all('/api/user/ssh/test-inline',    (_req, res) => res.status(410).json(RETIRED_MSG));

module.exports = router;
