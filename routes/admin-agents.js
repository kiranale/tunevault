/**
 * routes/admin-agents.js — Admin fleet view for deployed TuneVault agents.
 *
 * Owns: GET /admin/agents (UI), GET /api/admin/agents (fleet list),
 *       GET /api/admin/agents/:id/log-tail (log drill-in),
 *       POST /api/agent/log-tail (agent push endpoint),
 *       POST /api/admin/smoke-token (issue one-shot install token),
 *       POST /api/admin/smoke-runs  (report back smoke run result),
 *       GET  /api/admin/smoke-runs  (last 20 runs for Installer Health card).
 *
 * Does NOT own: agent heartbeat/registration (routes/agent.js),
 *               connection CRUD (server.js), user management (server.js),
 *               Docker orchestration (scripts/smoke-test-installer.sh).
 *
 * RBAC: All /admin/agents and /api/admin/agents routes require requireAdmin.
 *       POST /api/agent/log-tail uses the same X-TuneVault-Key API key auth
 *       as the rest of the agent endpoints (in routes/agent.js).
 *       POST /api/admin/smoke-runs is authenticated by SMOKE_REPORT_SECRET env var.
 *
 * Status thresholds configurable via env:
 *   AGENT_ONLINE_S  — seconds since heartbeat = online  (default 120)
 *   AGENT_STALE_S   — seconds since heartbeat = stale   (default 900)
 *   Beyond AGENT_STALE_S = offline.
 */

'use strict';

const express = require('express');
const path    = require('path');
const pool    = require('../db/index');
const smoke   = require('../db/installer-smoke');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// Threshold constants — configurable via env
const ONLINE_S = parseInt(process.env.AGENT_ONLINE_S  || '120',  10);
const STALE_S  = parseInt(process.env.AGENT_STALE_S   || '900',  10);

// Max lines retained per agent in agents_log_buffer
const LOG_BUFFER_MAX = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveStatus(lastHeartbeat) {
  if (!lastHeartbeat) return 'offline';
  const ageS = (Date.now() - new Date(lastHeartbeat).getTime()) / 1000;
  if (ageS <= ONLINE_S) return 'online';
  if (ageS <= STALE_S)  return 'stale';
  return 'offline';
}

// ── GET /admin/agents — serve UI page ────────────────────────────────────────

router.get('/', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'agents.html'));
});

// ── GET /api/admin/agents — fleet list ───────────────────────────────────────
//
// Returns all active (not uninstalled) agents joined to their connection +
// owning user. Sorted: offline first, then by last_heartbeat DESC.

router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        at.id               AS tunnel_id,
        oc.id               AS connection_id,
        oc.name             AS connection_name,
        at.tunnel_name      AS hostname,
        at.os_info,
        oc.kernel_version,
        oc.python_version,
        at.agent_version,
        oc.installed_at,
        oc.proxy_version,
        oc.os_id,
        at.last_heartbeat,
        at.status           AS tunnel_status,
        at.agent_status,
        at.uptime_seconds,
        at.oracle_mode,
        at.oracle_retry_count,
        at.last_oracle_error,
        at.uninstalled_at,
        u.email             AS user_email,
        u.company_domain,
        (SELECT COUNT(*) FROM oracle_connections oc2 WHERE oc2.user_id = u.id) AS connection_count
      FROM agent_tunnels at
      JOIN oracle_connections oc ON oc.id = at.connection_id
      JOIN users u ON u.id = oc.user_id
      WHERE at.uninstalled_at IS NULL
      ORDER BY
        CASE WHEN at.last_heartbeat IS NULL THEN 0
             WHEN EXTRACT(EPOCH FROM (NOW() - at.last_heartbeat)) > $1 THEN 0
             WHEN EXTRACT(EPOCH FROM (NOW() - at.last_heartbeat)) > $2 THEN 1
             ELSE 2
        END DESC,
        at.last_heartbeat DESC NULLS LAST
    `, [STALE_S, ONLINE_S]);

    const agents = rows.map(r => ({
      tunnelId:        r.tunnel_id,
      connectionId:    r.connection_id,
      connectionName:  r.connection_name,
      hostname:        r.hostname || r.tunnel_name || null,
      osInfo:          r.os_info,
      osId:            r.os_id,
      kernelVersion:   r.kernel_version,
      pythonVersion:   r.python_version,
      agentVersion:    r.agent_version,
      proxyVersion:    r.proxy_version,
      installedAt:     r.installed_at,
      lastHeartbeat:   r.last_heartbeat,
      tunnelStatus:    r.tunnel_status,
      agentStatus:     r.agent_status,
      uptimeSeconds:   r.uptime_seconds,
      oracleMode:      r.oracle_mode,
      oracleRetryCount: r.oracle_retry_count,
      lastOracleError: r.last_oracle_error,
      userEmail:       r.user_email,
      companyDomain:   r.company_domain,
      connectionCount: parseInt(r.connection_count) || 1,
      status:          deriveStatus(r.last_heartbeat),
    }));

    res.json(agents);
  } catch (err) {
    console.error('[admin-agents] fleet query failed:', err.message);
    res.status(500).json({ error: 'Failed to load agents' });
  }
});

// ── GET /api/admin/agents/:id/log-tail — last 200 lines for drill-in modal ───
//
// :id is connection_id.

router.get('/:id/log-tail', requireAdmin, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection ID' });

  try {
    const { rows } = await pool.query(
      `SELECT lines, updated_at FROM agents_log_buffer WHERE connection_id = $1`,
      [connectionId]
    );

    if (rows.length === 0) {
      return res.json({ lines: [], updatedAt: null, note: 'No log buffer yet. Waiting for next heartbeat.' });
    }

    const allLines = rows[0].lines || [];
    // Return last 200 lines
    const tail = allLines.slice(-200);
    res.json({ lines: tail, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('[admin-agents] log-tail query failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch log tail' });
  }
});

// ── GET /api/admin/agents/export.csv — CSV export of current fleet ───────────

router.get('/export.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        at.tunnel_name      AS hostname,
        u.company_domain,
        u.email             AS user_email,
        oc.name             AS connection_name,
        oc.os_id,
        oc.kernel_version,
        oc.python_version,
        at.agent_version,
        oc.proxy_version,
        oc.installed_at,
        at.last_heartbeat,
        at.agent_status,
        at.oracle_mode
      FROM agent_tunnels at
      JOIN oracle_connections oc ON oc.id = at.connection_id
      JOIN users u ON u.id = oc.user_id
      WHERE at.uninstalled_at IS NULL
      ORDER BY at.last_heartbeat DESC NULLS LAST
    `);

    const header = [
      'hostname', 'company_domain', 'user_email', 'connection_name',
      'os_id', 'kernel_version', 'python_version', 'agent_version',
      'proxy_version', 'installed_at', 'last_heartbeat',
      'agent_status', 'oracle_mode', 'status'
    ].join(',');

    const csvRows = rows.map(r => {
      const status = deriveStatus(r.last_heartbeat);
      const fields = [
        r.hostname || '',
        r.company_domain || '',
        r.user_email || '',
        r.connection_name || '',
        r.os_id || '',
        r.kernel_version || '',
        r.python_version || '',
        r.agent_version || '',
        r.proxy_version || '',
        r.installed_at ? new Date(r.installed_at).toISOString() : '',
        r.last_heartbeat ? new Date(r.last_heartbeat).toISOString() : '',
        r.agent_status || '',
        r.oracle_mode || '',
        status,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`);
      return fields.join(',');
    });

    const csv = [header, ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tunevault-agents-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[admin-agents] CSV export failed:', err.message);
    res.status(500).send('Export failed');
  }
});

// ── POST /api/agent/log-tail — agent pushes its last N log lines ─────────────
//
// Called by the agent on heartbeat to flush its recent stdout/stderr buffer.
// Auth: X-TuneVault-Key (same as other agent endpoints — validated here
//       inline since this route is mounted separately from routes/agent.js).
// Body: { connection_id: number, lines: string[] }
//
// Upserts into agents_log_buffer, capping at LOG_BUFFER_MAX lines.

router.post('/log-tail', async (req, res) => {
  // API key auth — mirrors routes/agent.js verifyApiKey pattern
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required' });

  const { connection_id, lines } = req.body || {};
  if (!connection_id || !Array.isArray(lines)) {
    return res.status(400).json({ error: 'connection_id and lines[] required' });
  }

  const connId = parseInt(connection_id, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection_id' });

  try {
    // Verify the API key belongs to this connection (check proxy_api_key_enc)
    const { rows: connRows } = await pool.query(
      `SELECT id, proxy_api_key_enc FROM oracle_connections WHERE id = $1`,
      [connId]
    );
    if (connRows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Verify key — use same approach as agent.js: decrypt and compare
    const { decrypt } = require('../crypto-utils');
    let keyMatched = false;
    try {
      const decrypted = decrypt(connRows[0].proxy_api_key_enc);
      keyMatched = decrypted === apiKey;
    } catch (_) {
      // Decryption failed — key mismatch
    }

    if (!keyMatched) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    // Cap lines at LOG_BUFFER_MAX — keep the most recent lines
    const incoming = (lines || []).map(l => String(l)).slice(-LOG_BUFFER_MAX);

    // Upsert: replace buffer with latest incoming (already capped)
    await pool.query(`
      INSERT INTO agents_log_buffer (connection_id, lines, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (connection_id) DO UPDATE
        SET lines = $2, updated_at = NOW()
    `, [connId, incoming]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[agent/log-tail] upsert failed:', err.message);
    res.status(500).json({ error: 'Failed to store log buffer' });
  }
});

// ── POST /api/admin/smoke-token — issue one-shot 15-min install token ────────
//
// Called by scripts/smoke-test-installer.sh before spinning containers.
// Returns { token, expiresAt } — the token is passed as INSTALL_TOKEN env var
// to the container's install.sh invocation.
//
// Tokens are single-use and automatically purged after 2h by startup cleanup.

router.post('/smoke-token', requireAdmin, async (req, res) => {
  try {
    const { token, expiresAt } = await smoke.issueToken({
      createdBy: req.user?.email || 'admin',
    });
    res.json({ ok: true, token, expiresAt });
  } catch (err) {
    console.error('[admin-agents] smoke-token issue failed:', err.message);
    res.status(500).json({ error: 'Failed to issue smoke token' });
  }
});

// ── GET /api/admin/smoke-runs — last 20 smoke run results ────────────────────
//
// Powers the Installer Health card on the /admin/agents page.

router.get('/smoke-runs', requireAdmin, async (req, res) => {
  try {
    const runs = await smoke.getRecentRuns(20);
    res.json(runs);
  } catch (err) {
    console.error('[admin-agents] smoke-runs fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to load smoke runs' });
  }
});

// ── POST /api/admin/smoke-runs — report back a smoke run result ───────────────
//
// Called by scripts/smoke-test-installer.sh after each container finishes.
// Auth: X-Smoke-Secret header matched against SMOKE_REPORT_SECRET env var.
// Body: { run_id, os, trigger_source, ...step results, overall, failure_log,
//         results_json, agent_version, install_sha, duration_total_ms }
//
// Creates or updates the row for this (run_id, os) pair.

router.post('/smoke-runs', async (req, res) => {
  const secret = process.env.SMOKE_REPORT_SECRET;
  const provided = req.headers['x-smoke-secret'];

  // Secret required when set; allows unauthenticated only in dev with no secret configured
  if (secret && provided !== secret) {
    return res.status(403).json({ error: 'Invalid smoke secret' });
  }

  const {
    run_id, os, trigger_source,
    overall, failure_log, results_json,
    agent_version, install_sha, duration_total_ms,
    step_install_ms, step_install_ok, step_install_err,
    step_register_ms, step_register_ok, step_register_err,
    step_heartbeat_ms, step_heartbeat_ok, step_heartbeat_err,
    step_systemd_ms, step_systemd_ok, step_systemd_err,
    step_command_ms, step_command_ok, step_command_err,
  } = req.body || {};

  if (!run_id || !os) {
    return res.status(400).json({ error: 'run_id and os required' });
  }

  const validOs = ['ubuntu22', 'ol8'];
  if (!validOs.includes(os)) {
    return res.status(400).json({ error: `os must be one of: ${validOs.join(', ')}` });
  }

  try {
    const row = await smoke.insertRun({ run_id, os, trigger_source: trigger_source || 'manual' });
    await smoke.updateRun(row.id, {
      finished_at: new Date(),
      overall: overall || 'error',
      failure_log, results_json, agent_version, install_sha, duration_total_ms,
      step_install_ms, step_install_ok, step_install_err,
      step_register_ms, step_register_ok, step_register_err,
      step_heartbeat_ms, step_heartbeat_ok, step_heartbeat_err,
      step_systemd_ms, step_systemd_ok, step_systemd_err,
      step_command_ms, step_command_ok, step_command_err,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-agents] smoke-runs report failed:', err.message);
    res.status(500).json({ error: 'Failed to record smoke run' });
  }
});

module.exports = router;
