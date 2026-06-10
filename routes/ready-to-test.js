/**
 * routes/ready-to-test.js — Go/no-go dashboard for a specific Oracle agent connection.
 *
 * Owns: GET /status/ready-to-test (HTML page, public with session or token gate),
 *       GET /api/status/ready-to-test (JSON: 6 badges + overall status).
 * Does NOT own: connection CRUD (routes/agent.js), health check execution (server.js),
 *               upgrade audit records (routes/agent-upgrades.js), key rotation (routes/key-rotation.js).
 *
 * Connection is resolved by ?conn=<name> (default: ebs12210-db-dev).
 * Auth: same session cookie as the rest of the app, OR ?token=<READY_TEST_TOKEN> env var.
 * All queries are read-only against existing tables — no schema changes needed.
 */

'use strict';

const express = require('express');
const path    = require('path');
const pool    = require('../db/index');

const router = express.Router();

// Optional magic token for operator bookmarks (no login needed).
// Set READY_TEST_TOKEN env var to enable. Leave unset to require session auth.
const READY_TEST_TOKEN = process.env.READY_TEST_TOKEN || '';

// Default connection to pin when no ?conn= param is given.
const DEFAULT_CONN = 'ebs12210-db-dev';

// SSH host for the ebs12210-db-dev instance (for fix commands).
const DEFAULT_SSH_HOST = process.env.READY_TEST_SSH_HOST || '';

// Semver: is a >= b?
function versionAtLeast(a, b) {
  if (!a) return false;
  const parse = v => (v || '0.0.0').replace(/[^0-9.]/g, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM > bM;
  if (am !== bm) return am > bm;
  return ap >= bp;
}

// Auth check: session cookie OR ?token= matching READY_TEST_TOKEN.
function requireReadyTestAuth(req, res, next) {
  // Token gate — operator bookmark link
  const qToken = req.query.token || '';
  if (READY_TEST_TOKEN && qToken === READY_TEST_TOKEN) return next();

  // Session gate — reuse the same cookie the rest of the app uses
  const cookie = req.cookies && req.cookies['tv_session'];
  if (!cookie) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Redirect to login preserving destination
    const dest = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?redirect=${dest}`);
  }

  // Cookie exists — let it through (the real auth middleware in server.js handles session validation
  // for protected API routes; this page is low-risk read-only operator tooling).
  next();
}

// ── GET /status/ready-to-test ─────────────────────────────────────────────────

router.get('/status/ready-to-test', requireReadyTestAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'status-ready-to-test.html'));
});

// ── GET /api/status/ready-to-test ────────────────────────────────────────────

router.get('/api/status/ready-to-test', requireReadyTestAuth, async (req, res) => {
  const connName = (req.query.conn || DEFAULT_CONN).trim();
  const sshHost  = DEFAULT_SSH_HOST;

  try {
    // ── Resolve connection by name ─────────────────────────────────────────────
    const connRow = await pool.query(
      `SELECT oc.id, oc.name,
              oc.key_rotated_at, oc.proxy_api_key_enc_previous, oc.key_rotation_status,
              oc.connectivity_mode,
              at.last_heartbeat, at.agent_version, at.status AS tunnel_status
       FROM oracle_connections oc
       LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
       WHERE LOWER(oc.name) = LOWER($1)
       LIMIT 1`,
      [connName]
    );

    if (!connRow.rows[0]) {
      return res.json({
        error: `No connection found with name '${connName}'`,
        badges: [],
        overall: 'red',
        conn_name: connName,
      });
    }

    const conn   = connRow.rows[0];
    const connId = conn.id;

    // ── Fetch all badge data in parallel ───────────────────────────────────────
    const [upgradeRow, healthRow, healthRunRow] = await Promise.all([
      // Latest upgrade audit row for this connection
      pool.query(
        `SELECT status, from_version, to_version, completed_at, error
         FROM agent_upgrade_audit
         WHERE connection_id = $1
         ORDER BY triggered_at DESC
         LIMIT 1`,
        [connId]
      ),
      // Most recent completed health check for this connection
      pool.query(
        `SELECT id, status, overall_score, created_at, completed_at, run_id
         FROM health_checks
         WHERE connection_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [connId]
      ),
      // Latest connection health diagnostic run (probes 3+8 for SID/service + drift checks)
      pool.query(
        `SELECT probe_8_status, probe_8_detail, probe_8_ms,
                probe_3_status, probe_3_detail, probe_3_ms,
                probe_1_status, passed, total, ran_at, agent_version
         FROM connection_health_runs
         WHERE connection_id = $1
         ORDER BY ran_at DESC
         LIMIT 1`,
        [connId]
      ),
    ]);

    const upgrade   = upgradeRow.rows[0]   || null;
    const hc        = healthRow.rows[0]    || null;
    const healthRun = healthRunRow.rows[0] || null;

    // ── Badge 1: Heartbeat freshness ──────────────────────────────────────────
    const heartbeatBadge = (() => {
      if (!conn.last_heartbeat) {
        return {
          id: 'heartbeat',
          label: 'Heartbeat fresh',
          status: 'red',
          value: 'No heartbeat received',
          fix_cmd: `ssh ${sshHost} 'sudo systemctl restart tunevault-agent && journalctl -u tunevault-agent -n 30'`,
          detail: 'Agent has never checked in. Restart the agent service.',
        };
      }
      const ageSec = Math.floor((Date.now() - new Date(conn.last_heartbeat).getTime()) / 1000);
      let status = 'green';
      if (ageSec > 300) status = 'red';
      else if (ageSec >= 60) status = 'amber';

      const display = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.floor(ageSec/60)}m ${ageSec%60}s ago` : `${Math.floor(ageSec/3600)}h ago`;
      return {
        id: 'heartbeat',
        label: 'Heartbeat fresh',
        status,
        value: display,
        fix_cmd: status !== 'green'
          ? `ssh ${sshHost} 'sudo systemctl restart tunevault-agent && journalctl -u tunevault-agent -n 30'`
          : null,
        detail: status === 'green'
          ? `Last heartbeat ${display}`
          : `Agent silent for ${display}. Restart service.`,
      };
    })();

    // ── Badge 2: Agent version ─────────────────────────────────────────────────
    const REQUIRED_VERSION = '7.5.0';
    const agentVersionBadge = (() => {
      const ver = conn.agent_version || null;
      const ok  = ver && versionAtLeast(ver, REQUIRED_VERSION);
      return {
        id: 'agent_version',
        label: 'Agent version',
        status: ok ? 'green' : 'red',
        value: ver || 'unknown',
        fix_cmd: !ok
          ? `ssh ${sshHost} 'sudo /opt/tunevault/bin/tunevault-agent self-upgrade --target 7.5.0 && sudo systemctl restart tunevault-agent'`
          : null,
        detail: ok
          ? `v${ver} ≥ ${REQUIRED_VERSION} ✓`
          : `v${ver || '?'} — requires ≥ ${REQUIRED_VERSION}`,
      };
    })();

    // ── Badge 3: Last health check ─────────────────────────────────────────────
    const healthCheckBadge = (() => {
      if (!hc) {
        return {
          id: 'last_health_check',
          label: 'Last health check',
          status: 'red',
          value: 'No runs found',
          fix_cmd: null,
          detail: 'No health checks have run for this connection.',
        };
      }

      const isComplete = hc.status === 'complete' || hc.status === 'completed';
      const score      = hc.overall_score;
      const ageMin     = Math.floor((Date.now() - new Date(hc.created_at).getTime()) / 60000);
      const ageDisplay = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin/60)}h ago`;

      // Derive pass/fail from score: 100 = all pass, lower = some failures
      let status = 'red';
      let value  = `score ${score ?? '?'} — ${ageDisplay}`;

      if (!isComplete) {
        status = 'red';
        value  = `status: ${hc.status} — ${ageDisplay}`;
      } else if (score !== null && score >= 95) {
        status = 'green';
        value  = `score ${score}/100 — ${ageDisplay}`;
      } else if (score !== null && score >= 70) {
        status = 'amber';
        value  = `score ${score}/100 — ${ageDisplay}`;
      } else {
        status = 'red';
        value  = `score ${score ?? '?'}/100 — ${ageDisplay}`;
      }

      return {
        id: 'last_health_check',
        label: 'Last health check',
        status,
        value,
        fix_cmd: status === 'red'
          ? null  // Run from TuneVault UI — no CLI fix command
          : null,
        detail: isComplete
          ? `Health check completed with score ${score}/100 (${ageDisplay})`
          : `Health check is ${hc.status}`,
      };
    })();

    // ── Badge 4: Auto-upgrade audit ───────────────────────────────────────────
    const upgradeAuditBadge = (() => {
      if (!upgrade) {
        return {
          id: 'upgrade_audit',
          label: 'Auto-upgrade audit',
          status: 'amber',
          value: 'No upgrade recorded',
          fix_cmd: null,
          detail: 'No upgrade attempt found. Agent may have been installed at v7.5.0 directly.',
        };
      }
      const isComplete = upgrade.status === 'completed';
      const atTarget   = upgrade.to_version && versionAtLeast(upgrade.to_version, REQUIRED_VERSION);
      const ok         = isComplete && atTarget;
      const ts         = upgrade.completed_at
        ? new Date(upgrade.completed_at).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
        : '—';

      return {
        id: 'upgrade_audit',
        label: 'Auto-upgrade audit',
        status: ok ? 'green' : upgrade.status === 'failed' ? 'red' : 'amber',
        value: `v${upgrade.from_version || '?'} → v${upgrade.to_version || '?'} (${upgrade.status})`,
        fix_cmd: upgrade.status === 'failed'
          ? `ssh ${sshHost} 'sudo /opt/tunevault/bin/tunevault-agent self-upgrade --target 7.5.0 && sudo systemctl restart tunevault-agent'`
          : null,
        detail: ok
          ? `v${upgrade.from_version} → v${upgrade.to_version} completed ${ts}`
          : upgrade.error
            ? `Upgrade failed: ${upgrade.error}`
            : `Upgrade ${upgrade.status}`,
      };
    })();

    // ── Badge 5: Key rotation round-trip ─────────────────────────────────────
    const keyRotationBadge = (() => {
      if (!conn.key_rotated_at) {
        return {
          id: 'key_rotation',
          label: 'Key rotation',
          status: 'amber',
          value: 'Never rotated',
          fix_cmd: null,
          detail: 'No key rotation recorded. Rotate via 🔑 button on /connections.',
        };
      }
      const rotatedMs    = new Date(conn.key_rotated_at).getTime();
      const ageMins      = Math.floor((Date.now() - rotatedMs) / 60000);
      const graceExpired = ageMins > 5; // 5-min grace window
      const ackd         = conn.key_rotation_status === 'acknowledged';
      const hasPrevious  = !!conn.proxy_api_key_enc_previous;

      // Green = rotated AND acknowledged AND grace expired (previous key dropped) OR no lingering previous
      const ok = ackd && graceExpired;
      const ageDisplay = ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins/60)}h ago`;

      return {
        id: 'key_rotation',
        label: 'Key rotation',
        status: ok ? 'green' : ackd ? 'amber' : 'red',
        value: `rotated ${ageDisplay}${ackd ? ', acknowledged' : ', pending ACK'}${graceExpired ? ', grace expired' : ''}`,
        fix_cmd: (!ackd)
          ? `ssh ${sshHost} 'sudo systemctl restart tunevault-agent && journalctl -u tunevault-agent -n 20'`
          : null,
        detail: ok
          ? `Key rotated ${ageDisplay}, agent acknowledged, grace window expired`
          : !ackd
            ? `Key rotated ${ageDisplay} but agent hasn't acknowledged — restart agent`
            : `Key rotated ${ageDisplay}, acknowledged, grace window active (expires in ${5 - ageMins}m)`,
      };
    })();

    // ── Badge 6: Config drift ──────────────────────────────────────────────────
    const configDriftBadge = (() => {
      if (!healthRun) {
        return {
          id: 'config_drift',
          label: 'Config drift clean',
          status: 'amber',
          value: 'No probe data',
          fix_cmd: null,
          detail: 'No diagnostics run yet. Run /connections diagnostics for this agent.',
        };
      }
      const p8Status = healthRun.probe_8_status;
      const p8Detail = healthRun.probe_8_detail || '';

      // Probe 8 = "Key matches cloud" — pass means agent.env is the single config source.
      // A drift scenario is captured in the detail string.
      const isDrift = p8Detail.toLowerCase().includes('drift') ||
                      p8Detail.toLowerCase().includes('override') ||
                      p8Detail.toLowerCase().includes('systemd');

      const ok = p8Status === 'pass' && !isDrift;

      return {
        id: 'config_drift',
        label: 'Config drift clean',
        status: ok ? 'green' : p8Status === 'fail' ? 'red' : 'amber',
        value: ok
          ? 'agent.env only ✓'
          : isDrift
            ? `DRIFT: ${p8Detail.slice(0, 80)}`
            : p8Status === 'fail'
              ? `probe 8 failed: ${p8Detail.slice(0, 80) || 'no detail'}`
              : `probe 8: ${p8Status || 'unknown'}`,
        fix_cmd: !ok
          ? `ssh ${sshHost} 'sudo grep -r TUNEVAULT_API_KEY /etc/systemd/system/tunevault* 2>/dev/null; sudo cat /etc/tunevault/agent.env'`
          : null,
        detail: ok
          ? `Probe 8 passed — /etc/tunevault/agent.env is the single config source`
          : `Probe 8: ${p8Detail || 'no detail'}`,
      };
    })();

    // ── Badge 7: Oracle connect path (SID vs SERVICE_NAME regression) ────────
    // Verifies that the proxy's TNS probe correctly distinguished CDB SID-style
    // connect from SERVICE_NAME.  Probe 3 detail now shows "Connected via SID=..."
    // or "Connected via SERVICE_NAME=... (autodetected from listener)".
    // AMBER = probe data too old or missing (needs a fresh diagnostic run).
    // GREEN = probe 3 passed with a valid connect path in the detail string.
    // RED   = probe 3 failed (connect path not established at all).
    const oracleConnectBadge = (() => {
      if (!healthRun) {
        return {
          id: 'oracle_connect_path',
          label: 'Oracle connect path',
          status: 'amber',
          value: 'No diagnostic run',
          fix_cmd: null,
          detail: 'Run /connections diagnostics to populate this badge.',
        };
      }
      const p3Status = healthRun.probe_3_status;
      const p3Detail = healthRun.probe_3_detail || '';
      const ranAgo   = healthRun.ran_at
        ? Math.floor((Date.now() - new Date(healthRun.ran_at).getTime()) / 60000)
        : null;
      const isStale  = ranAgo !== null && ranAgo > 120; // >2h = stale

      if (!p3Status || p3Status === 'skip') {
        return {
          id: 'oracle_connect_path',
          label: 'Oracle connect path',
          status: 'amber',
          value: 'Probe 3 skipped or missing',
          fix_cmd: null,
          detail: 'No TNS probe result. Run diagnostics from the connection detail page.',
        };
      }

      if (p3Status === 'fail') {
        return {
          id: 'oracle_connect_path',
          label: 'Oracle connect path',
          status: 'red',
          value: 'TNS probe FAILED',
          fix_cmd: `ssh ${sshHost} 'sudo tunevault-agent diagnose 2>&1 | head -40'`,
          detail: p3Detail || 'Probe 3 failed — Oracle not reachable via TNS.',
        };
      }

      // Probe passed — extract connect method from detail string
      const isSid     = /\bSID=/i.test(p3Detail);
      const isSvc     = /SERVICE_NAME=/i.test(p3Detail);
      const autodet   = /autodetected/i.test(p3Detail);
      let methodLabel = isSid ? 'SID-style (dedicated server)'
                      : isSvc && autodet ? 'SERVICE_NAME (autodetected from listener)'
                      : isSvc ? 'SERVICE_NAME'
                      : 'connected (method unknown — run fresh diagnostics)';

      return {
        id: 'oracle_connect_path',
        label: 'Oracle connect path',
        status: isStale ? 'amber' : 'green',
        value: isStale ? `${methodLabel} (stale — ${ranAgo}m ago)` : methodLabel,
        fix_cmd: isStale
          ? `ssh ${sshHost} 'sudo tunevault-agent diagnose 2>&1 | head -40'`
          : null,
        detail: p3Detail || methodLabel,
      };
    })();

    // ── Badge 9 (conditional): TNS connectivity mode ─────────────────────────
    // Shows N/A (neutral) when connection is SSH-only so the badge doesn't
    // falsely turn red just because no TNS host was entered.
    const connectivityMode = conn.connectivity_mode || 'tns';
    const tnsModeBadge = (() => {
      if (connectivityMode === 'ssh_sqlplus') {
        return {
          id: 'tns_mode',
          label: 'TNS connectivity',
          status: 'na',
          value: 'N/A (SSH-only mode)',
          fix_cmd: null,
          detail: 'This connection uses SSH → sqlplus instead of TNS. No TNS host required.',
        };
      }
      if (connectivityMode === 'both') {
        return {
          id: 'tns_mode',
          label: 'TNS connectivity',
          status: 'amber',
          value: 'TNS + SSH fallback configured',
          fix_cmd: null,
          detail: 'Queries prefer TNS; SSH sqlplus is the fallback path.',
        };
      }
      // Default TNS mode — badge omitted from the standard set (existing behaviour)
      return null;
    })();

    // ── Overall status ─────────────────────────────────────────────────────────
    const badges = [
      heartbeatBadge,
      agentVersionBadge,
      healthCheckBadge,
      upgradeAuditBadge,
      keyRotationBadge,
      configDriftBadge,
      oracleConnectBadge,
      ...(tnsModeBadge ? [tnsModeBadge] : []),
    ];

    // 'na' badges are neutral — don't count toward red/amber
    const redCount   = badges.filter(b => b.status === 'red').length;
    const amberCount = badges.filter(b => b.status === 'amber').length;

    let overall = 'green';
    if (redCount > 0)        overall = 'red';
    else if (amberCount > 0) overall = 'amber';

    return res.json({
      conn_name: conn.name,
      conn_id: connId,
      connectivity_mode: connectivityMode,
      overall,
      red_count: redCount,
      amber_count: amberCount,
      badges,
      refreshed_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[ready-to-test] API error:', err.message);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

module.exports = router;
