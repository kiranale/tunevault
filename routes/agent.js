/**
 * routes/agent.js — One-line installer: agent provisioning + lifecycle.
 *
 * Owns: registration token issuance, agent confirm + heartbeat + uninstall
 *       lifecycle, install status polling, long-poll work channel.
 * Does NOT own: oracle_connections CRUD, API key generation/encryption (setup-fresh.js),
 *               proxy health checks (server.js /api/proxy/health), tunnel infrastructure.
 *
 * Architecture: agent uses outbound HTTPS long-poll only. Zero inbound ports,
 * zero DNS, zero Cloudflare. Provision just returns API key + connection ID.
 *
 * Endpoints:
 *   POST /api/agent/mint-token          — UI: create connection + issue install token (auth required)
 *   POST /api/agent/provision           — installer: redeem token → return API key + connection ID
 *   POST /api/agent/register            — doctor --deep: validate-only dry-run (X-TuneVault-Doctor: dry-run)
 *   POST /api/agent/confirm             — installer: report OS/Oracle info → flip status active
 *   POST /api/agent/heartbeat           — proxy: 60s keepalive ping (uses API key auth); {doctor:true} = short-circuit ping
 *   POST /api/agent/uninstall           — agent: deregister host (idempotent; sets uninstalled_at)
 *   POST /api/agent/restore             — UI: restore uninstalled connection within 30-day window
 *   GET  /api/agent/status/:id          — UI: poll install progress
 *   GET  /api/agent/status              — installer: confirm cloud-side registration
 *   POST /api/agent/poll                — proxy: long-poll for work items
 *   POST /api/agent/respond             — proxy: deliver work result
 *   GET  /api/agent/channel-status/:id  — UI: check if agent is connected
 *   POST /api/agent/diagnose            — agent: store full 8-probe diagnose run (API key auth)
 *   GET  /api/agent/diagnose/latest     — UI: fetch latest diagnose run for a connection
 *   GET  /api/agent/heartbeat-check     — install.sh: did this connection heartbeat in last 15s?
 *   POST /api/agent/install-failures    — install.sh: report a failed install attempt (no auth needed)
 *   POST /api/agent/install-telemetry   — install.sh: report install path (thin_ok/ic_installed/…) for Wave 1 analytics
 *   POST /api/agent/log-tail            — agent: flush last 500 log lines (API key auth); stored in agents_log_buffer
 *   POST /api/agent/restart-reason     — agent: persist structured restart-reason before exit; drives restart-loop detection
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const agentDb = require('../db/agent');
const upgradeAuditDb = require('../db/agent-upgrade-audit');
const diagnoseDb = require('../db/agent-diagnose');
const installFailuresDb = require('../db/agent-install-failures');
const cmdResultsDb = require('../db/agent-command-results');
const { requireAuth } = require('../middleware/auth');
const { encrypt, decrypt } = require('../crypto-utils');
const { enforceConnectionCap } = require('../middleware/tier-enforce');
const channel = require('../services/agent-channel');
const agentCmdQueueDb = require('../db/agent-command-queue');
const ebsJobsDb = require('../db/ebs-jobs');

const adminAgentsDb = require('../db/admin-agents');
const restartEventsDb = require('../db/agent-restart-events');

const router = express.Router();

// ── Auto-upgrade policy constants ─────────────────────────────────────────────

// Agents below this version are automatically upgraded when auto_upgrade_enabled=true.
// Keep in sync with LATEST_AGENT_VERSION below and the version string in install.sh.
const AUTO_UPGRADE_TARGET = '7.5.0';
// Current canonical oracle-proxy.py version — used to signal proxy_upgrade_available in poll response.
// Keep in sync with server.js LATEST_PROXY_VERSION and routes/connections-list.js.
const LATEST_PROXY_VERSION = '3.20.62';
// Configurable via PROXY_UPGRADE_COOLDOWN_MS env var. Default 5 min; set higher in prod (e.g. 3600000).
const PROXY_UPGRADE_COOLDOWN_MS = parseInt(process.env.PROXY_UPGRADE_COOLDOWN_MS || '300000');
// Number of recent failures (24h) that suppress further auto-upgrade attempts.
const AUTO_UPGRADE_MAX_FAILURES = 2;

// In-memory rate limit for proxy upgrade work items: one per connection per hour.
// Prevents flooding agent_command_queue on every 25s poll.
const _proxyUpgradeSentAt = new Map();   // connId → Date.now() ms of last send
const _proxyUpgradeBackoff = new Map();  // connId → current backoff ms (doubles on failure, max 6h)

// ── Config ─────────────────────────────────────────────────────────────────

const APP_URL = process.env.APP_URL || 'https://tunevault.app';

// ── Token cleanup cron (every 10 minutes) ──────────────────────────────────

setInterval(() => {
  agentDb.cleanExpiredTokens().catch(err => console.warn('[agent] token cleanup error:', err.message));
  // Also expire pending_registration draft connections older than 24h
  agentDb.expirePendingDrafts().catch(err => console.warn('[agent] draft expiry error:', err.message));
  // Expire auto-upgrade audit rows that have been in_progress/queued for >10 minutes
  upgradeAuditDb.expireTimedOutUpgrades().catch(err => console.warn('[agent] upgrade audit expiry error:', err.message));
}, 10 * 60 * 1000);

// ── Verify API key against connection (shared by confirm/heartbeat/uninstall) ─
//
// Grace window: after a key rotation the old (previous) key is accepted for
// GRACE_WINDOW_MS (5 minutes) so in-flight agent requests don't 401 while
// the agent writes the new key and restarts. Once the window expires, only
// the current key is accepted.

const GRACE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

async function verifyApiKey(apiKey, connectionId) {
  // Use getConnectionKeyState to also fetch the previous key for grace-window checks
  const conn = await agentDb.getConnectionKeyState(connectionId);
  if (!conn) return null;

  // Primary check: current key
  const currentKey = decrypt(conn.proxy_api_key_enc);
  if (currentKey === apiKey) return conn;

  // Grace window: accept previous key within 5 minutes of rotation
  if (conn.proxy_api_key_enc_previous && conn.key_rotated_at) {
    const elapsed = Date.now() - new Date(conn.key_rotated_at).getTime();
    if (elapsed < GRACE_WINDOW_MS) {
      const previousKey = decrypt(conn.proxy_api_key_enc_previous);
      if (previousKey === apiKey) return conn;
    }
  }

  return null;
}

// ── POST /api/agent/mint-token ──────────────────────────────────────────────
// UI calls this to get a fresh install token after creating the connection record.
// Returns { token, connection_id, install_cmd } for display in the UI.

router.post('/mint-token', requireAuth, enforceConnectionCap, async (req, res) => {
  try {
    const {
      name, host, port, service_name, username, password,
      host_ip, ssh_user, privilege_model
    } = req.body;

    // Agent Installer flow: only a name + host_ip are needed — the agent auto-detects Oracle SIDs.
    // Direct Connection flow: requires full DB credentials (host, service_name, username, password).
    const isDirectFlow = !!(service_name || username || password);

    if (isDirectFlow && (!host || !service_name || !username || !password)) {
      return res.status(400).json({ error: 'host, service_name, username, and password are required for direct connections' });
    }

    // Create the connection record (proxy type, pending URL)
    const rawKey = 'tvp_' + crypto.randomBytes(24).toString('hex');
    const encryptedKey = encrypt(rawKey);
    const displayName = (name || '').trim() || (isDirectFlow ? `${host}/${service_name}` : `agent-${Date.now()}`);

    let conn;
    if (isDirectFlow) {
      const encryptedPassword = encrypt(password);
      const dbPort = parseInt(port, 10) || 1521;
      conn = await agentDb.createAgentConnection({
        name: displayName,
        host,
        port: dbPort,
        serviceName: service_name,
        username,
        encryptedPassword,
        encryptedKey,
        userId: req.user.id,
        privilegeModel: privilege_model || 'reader',
      });
    } else {
      // Agent-only: no DB credentials — agent detects Oracle SIDs after install
      conn = await agentDb.createAgentOnlyConnection({
        name: displayName,
        encryptedKey,
        userId: req.user.id,
        hostIp: (host_ip || '').trim() || null,
        sshUser: (ssh_user || '').trim() || 'oracle',
        privilegeModel: privilege_model || 'reader',
      });
    }

    // Issue registration token (DB-persisted, 30-min TTL)
    const token = crypto.randomBytes(32).toString('hex');
    await agentDb.createRegToken({ token, connectionId: conn.id, userId: req.user.id });

    // Stamp install_token_issued_at on first issuance (COALESCE guard — never overwritten).
    // This starts the 5-min stall clock. Re-issues do not reset the timestamp.
    agentDb.stampInstallTokenIssuedAt(conn.id).catch(() => {});

    // Build install command
    const installCmd = `curl -fsSL ${APP_URL}/install.sh | sudo TUNEVAULT_TOKEN=${token} bash`;

    res.json({
      connection_id: conn.id,
      connection_name: conn.name,
      token,
      install_cmd: installCmd,
      api_key_masked: rawKey.substring(0, 8) + '...' + rawKey.slice(-4),
    });
  } catch (err) {
    // 409: connection name already exists for this user
    if (err.message && err.message.startsWith('DUPLICATE_CONNECTION_NAME:')) {
      const dupName = err.message.replace('DUPLICATE_CONNECTION_NAME:', '').trim();
      return res.status(409).json({
        error: `A connection named '${dupName}' already exists. Choose a different name, or edit the existing one.`,
        code: 'DUPLICATE_CONNECTION_NAME',
        duplicate_name: dupName,
      });
    }
    console.error('[agent] mint-token error:', err.message, err.stack);
    // Surface the actual DB/validation error so the UI can show something useful
    const detail = err.message || 'Unknown error';
    const isDbConstraint = detail.includes('null value') || detail.includes('violates');
    res.status(500).json({
      error: isDbConstraint
        ? 'Database schema error — a required column is missing. Please contact support.'
        : `Failed to create connection: ${detail}`,
    });
  }
});

// ── POST /api/agent/provision ───────────────────────────────────────────────
// Called by install.sh on the Oracle server. Redeems the registration token
// and returns the API key + connection ID. No tunnel creation, no DNS, no CF.
// The agent connects back via outbound HTTPS long-poll — nothing inbound needed.
// No user auth cookie — token IS the auth.

router.post('/provision', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  // Redeem the token (atomic mark-used)
  const tokenRow = await agentDb.redeemRegToken(token).catch(() => null);
  if (!tokenRow) {
    return res.status(410).json({ error: 'Token expired, already used, or invalid' });
  }

  const connectionId = tokenRow.connection_id;

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    const apiKey = decrypt(conn.proxy_api_key_enc);

    // Create tunnel record in pending state (no CF provisioning)
    await agentDb.upsertTunnel({
      connectionId,
      tunnelUuid: null,
      tunnelName: `tunevault-${connectionId}`,
      dnsHostname: null,
      status: 'pending',
    });

    res.json({
      connection_id: connectionId,
      api_key: apiKey,
      api_url: APP_URL,
    });
  } catch (err) {
    console.error('[agent] provision error:', err.message);
    res.status(500).json({ error: 'Provisioning failed' });
  }
});

// ── POST /api/agent/register ───────────────────────────────────────────────
// Doctor --deep dry-run endpoint. Validates the API key and classifies the
// connection type without writing any DB rows.
// Header: X-TuneVault-Doctor: dry-run  (required — prevents accidental real registrations)
// Body:   { connection_id, agent_version? }
// Returns 200 { doctor_dry_run: true, would_register: true, host_classified_as, connection_status }
// or appropriate 4xx if the key is invalid.
// Why separate endpoint: keeps the register wire path isolated for synthetic probing
// without polluting provision/confirm which have side-effects (token redemption, tunnel flips).

router.post('/register', async (req, res) => {
  // Must be a dry-run probe — reject anything else to prevent misuse.
  if (req.headers['x-tunevault-doctor'] !== 'dry-run') {
    return res.status(400).json({
      error: 'This endpoint only accepts doctor dry-run probes. Use /api/agent/provision for real installs.',
      hint: 'Set header X-TuneVault-Doctor: dry-run',
    });
  }

  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const { connection_id, agent_version } = req.body || {};
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (isNaN(parsedConnId)) return res.status(400).json({ error: 'connection_id must be a valid integer' });

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(401).json({ error: 'Invalid API key or connection not found', hint: '401 → token invalid or revoked' });

    // Classify without writing anything
    const tunnel = await agentDb.getTunnel(parsedConnId);
    const tunnelStatus = tunnel ? tunnel.status : 'no_tunnel';
    // Classify host type from connection record fields
    let hostClassifiedAs = 'agent';
    if (conn.connection_type === 'direct') hostClassifiedAs = 'direct_tcp';
    else if (conn.connectivity_mode === 'ssh_sqlplus') hostClassifiedAs = 'ssh_sqlplus';
    else if (conn.connectivity_mode === 'both') hostClassifiedAs = 'agent_ssh';

    res.json({
      doctor_dry_run: true,
      would_register: true,
      host_classified_as: hostClassifiedAs,
      connection_status: tunnelStatus,
      agent_version: agent_version || null,
    });
  } catch (err) {
    console.error('[agent] register dry-run error:', err.message);
    res.status(500).json({ error: 'Dry-run probe failed' });
  }
});

// ── POST /api/agent/confirm ─────────────────────────────────────────────────
// install.sh calls this after proxy is up. Reports OS info, Oracle home,
// SIDs from /etc/oratab (v5) or service_names from lsnrctl (v6 pure-Python).
// Auth: X-TuneVault-Key header (written to /etc/tunevault/agent.yaml in v6).

router.post('/confirm', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const {
    connection_id, os_info, oracle_home, oracle_sids,
    // v6 pure-Python: service names from lsnrctl (replaces PMON/oratab SID hunting)
    service_names, machine_hostname,
    // CDB/PDB picker (v4.5+): PDB service names from lsnrctl, separate from CDB instance SIDs
    pdb_services,
    // v8: server type and EBS context info from installer
    server_type, ebs_service, ebs_db_host, ebs_context_file,
    // v8.1+: explicit instance name (or auto-derived from db host)
    ebs_instance_name,
  } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  // Accept service_names (v6) or oracle_sids (v5) — both stored in oracle_sids column
  const sidsOrServices = service_names || oracle_sids;

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid API key or connection not found' });

    // Update tunnel record with OS/Oracle info
    await agentDb.confirmTunnel({
      connectionId: parsedConnId,
      osInfo: os_info,
      // v6 agents don't have ORACLE_HOME — store empty string gracefully
      oracleHome: oracle_home || '',
      oracleSids: sidsOrServices,
      // PDB service names — distinct from CDB instance SIDs, used by the picker UI
      pdbServices: Array.isArray(pdb_services) ? pdb_services : [],
    });

    // proxy_url is not used — all communication goes through the outbound agent channel.
    await agentDb.touchConnectionKeyUsage(parsedConnId);
    // Save server_type, ebs_service, and ebs_instance_name detected by installer.
    // Auto-derive instance name from DB hostname when not explicitly set:
    //   ebs12212-db-dev.example.com → EBS12212
    let resolvedInstanceName = ebs_instance_name || null;
    if (!resolvedInstanceName && ebs_db_host) {
      const raw = ebs_db_host.split('.')[0].toLowerCase();
      const stripped = raw.replace(/-(db|app|apps|both)([-_].*)?$/, '');
      if (stripped && stripped !== raw) resolvedInstanceName = stripped.toUpperCase();
    }
    // Only store recognised server_type values; install.sh falls back to 'unknown'
    // when TUNEVAULT_SERVER_TYPE env var is dropped by sudo — storing 'unknown' would
    // break badge rendering and hide APPS/WebLogic password fields in the UI.
    const VALID_SERVER_TYPES = new Set(['db', 'apps', 'both']);
    const cleanServerType = VALID_SERVER_TYPES.has(server_type) ? server_type : null;
    if (cleanServerType || ebs_service || resolvedInstanceName || ebs_context_file) {
      await agentDb.updateConnectionInstallerInfo(parsedConnId, {
        serverType:       cleanServerType,
        ebsService:       ebs_service       || null,
        ebsInstanceName:  resolvedInstanceName,
        ebsContextFile:   ebs_context_file  || null,
      });
    }

    // Flip oracle_connections.status pending_registration → active here, not just when
    // the UI wizard polls /ssh-install/stream. If the user closed the browser during
    // install the status would otherwise stay pending_registration indefinitely.
    if (conn.status === 'pending_registration') {
      await agentDb.setConnectionStatus(parsedConnId, 'active');
      await agentDb.clearInstallTokenHash(parsedConnId);
    }

    // Return stored ebs_context_file so install.sh can backfill agent.env on reinstall
    // when TUNEVAULT_EBS_CONTEXT_FILE wasn't passed explicitly in the command.
    const storedCtxFile = ebs_context_file || await agentDb.getConnectionContextFile(parsedConnId);
    res.json({ ok: true, status: 'confirmed', ...(storedCtxFile ? { ebs_context_file: storedCtxFile } : {}) });
  } catch (err) {
    console.error('[agent] confirm error:', err.message);
    res.status(500).json({ error: 'Confirm failed' });
  }
});

// ── POST /api/agent/heartbeat ───────────────────────────────────────────────
// Proxy pings every 60s. Updates last_heartbeat + proxy_key_last_used_at.
// Auth: X-TuneVault-Key header.

router.post('/heartbeat', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const {
    connection_id, agent_version,
    proxy_version, installed_at, last_upgrade_at,
    python_version, cx_oracle_version, os_id, kernel,
    in_active_runbook,
    // oracle_worker status fields (v6.2+)
    agent_status, last_oracle_error, oracle_retry_count, uptime_seconds,
    // thick-mode fallback fields (v6.2+, Task #1728054)
    oracle_mode, instant_client_path, verifier_workaround_active,
    // doctor --deep probe: short-circuit ping — validate key + return queue stats, no side-effects
    doctor: isDoctorProbe,
  } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (isNaN(parsedConnId)) return res.status(400).json({ error: 'connection_id must be a valid integer' });

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid key or connection not found' });

    // Doctor --deep short-circuit: validate key, return queue stats, do NOT update last_seen.
    // This lets tunevault-agent doctor --deep confirm the heartbeat path without side-effects.
    if (isDoctorProbe === true) {
      const { rows } = await require('../db/index').query(
        `SELECT
           (SELECT COUNT(*) FROM agent_command_results WHERE status = 'pending') AS pending_commands,
           (SELECT COUNT(*) FROM agent_tunnels WHERE last_heartbeat > NOW() - INTERVAL '90 seconds') AS agents_online`
      ).catch(() => ({ rows: [{ pending_commands: 0, agents_online: 0 }] }));
      return res.json({
        ok: true,
        doctor_probe: true,
        queue: {
          pending_commands: parseInt(rows[0].pending_commands, 10),
          agents_online: parseInt(rows[0].agents_online, 10),
        },
      });
    }

    const meta = {
      proxy_version, installed_at, last_upgrade_at, python_version, cx_oracle_version, os_id, kernel,
      // oracle worker status fields — stored in agent_tunnels
      agent_status: agent_status || null,
      last_oracle_error: last_oracle_error || null,
      oracle_retry_count: oracle_retry_count !== undefined ? oracle_retry_count : null,
      uptime_seconds: uptime_seconds !== undefined ? uptime_seconds : null,
      // thick-mode fallback fields — let cloud dashboard show 'thin' | 'thick' per connection
      oracle_mode: oracle_mode || null,
      instant_client_path: instant_client_path || null,
      verifier_workaround_active: verifier_workaround_active != null ? verifier_workaround_active : null,
    };
    await agentDb.recordHeartbeat(parsedConnId, agent_version || null, meta);
    await agentDb.touchConnectionKeyUsage(parsedConnId);

    // Stamp first_heartbeat_at on the very first successful heartbeat (COALESCE guard).
    // Clears the install_stalled state permanently — once an agent phones home it's no longer stalled.
    agentDb.stampFirstHeartbeatAt(parsedConnId).catch(() => {});

    // Clear any crash-loop alert dedup row so a future incident triggers a fresh alert.
    // Fire-and-forget — never blocks heartbeat response.
    setImmediate(() => cmdResultsDb.clearCrashAlert(parsedConnId).catch(() => {}));

    // Clear restart-loop flag if set — agent is alive, loop is over.
    // Fire-and-forget — never blocks heartbeat response.
    setImmediate(() => restartEventsDb.clearRestartLoopIfSet(parsedConnId).catch(() => {}));

    // ── Auto-upgrade policy (fire-and-forget, never blocks heartbeat response) ──
    // Run after responding so agent gets its ACK immediately.
    setImmediate(() => evaluateAutoUpgrade(parsedConnId, agent_version, !!in_active_runbook).catch(() => {}));

    res.json({ ok: true });
  } catch (err) {
    console.error('[agent] heartbeat error:', err.message);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

/**
 * Evaluate whether this connection should be auto-upgraded.
 * Called fire-and-forget from the heartbeat handler.
 *
 * Steps:
 *   1. If agent version has reached AUTO_UPGRADE_TARGET → close any in-flight audit rows.
 *   2. If version is below target → check policy (enabled, safety rails) → enqueue upgrade.
 */
async function evaluateAutoUpgrade(connectionId, agentVersion, inActiveRunbook) {
  if (!agentVersion) return; // Legacy proxy without version reporting — skip

  const connId = parseInt(connectionId, 10);

  // Path gate: the install.sh agent (v6/v7) reports versions in the 6.x/7.x range.
  // oracle-proxy.py reports its own VERSION (currently 3.x). Agent-style upgrades
  // (/api/self-upgrade work items, install.sh) don't apply to oracle-proxy.py
  // connections — they self-update independently via auto_update_loop. Skip entirely
  // when the reported version is not a v6+ agent. This covers both app servers
  // (server_type='apps') AND DB-tier connections still running oracle-proxy.py
  // (where server_type may be null but agent_version is '3.x').
  const agentMajor = parseInt((agentVersion || '0').split('.')[0], 10);
  if (agentMajor < 6) return;

  // Close out any in-flight upgrades for this connection if version now matches target
  if (!versionLessThan(agentVersion, AUTO_UPGRADE_TARGET)) {
    await upgradeAuditDb.completeUpgradeOnHeartbeat(connId, AUTO_UPGRADE_TARGET);
    return; // Already at or above target — nothing to do
  }

  // Agent is below target. Check policy before enqueueing.
  const policy = await upgradeAuditDb.getUpgradePolicy(connId);
  if (!policy) return;
  if (!policy.auto_upgrade_enabled) return; // Operator opted out for this connection

  // Additional guard: skip for app/both server types even if they somehow report a v6+ version.
  if (policy.server_type === 'apps' || policy.server_type === 'both') return;

  // Safety rail: skip if a runbook is actively running (don't yank the rug)
  if (inActiveRunbook) {
    console.log(`[auto-upgrade] conn ${connId}: skipped — in_active_runbook=true`);
    return;
  }

  // Safety rail: skip if ≥2 failures in last 24h (manual intervention required)
  const failures = await upgradeAuditDb.recentFailureCount(connId);
  if (failures >= AUTO_UPGRADE_MAX_FAILURES) {
    console.log(`[auto-upgrade] conn ${connId}: suppressed — ${failures} failures in 24h, manual intervention required`);
    return;
  }

  // Dedup: skip if there's already an active audit row in the last 6h
  const active = await upgradeAuditDb.getActiveUpgrade(connId);
  if (active) return;

  // All gates passed — enqueue the upgrade
  const auditId = await upgradeAuditDb.insertUpgradeAudit({
    connectionId: connId,
    fromVersion: agentVersion,
    toVersion: AUTO_UPGRADE_TARGET,
    triggeredBy: 'auto-stale-policy',
  });

  console.log(`[auto-upgrade] conn ${connId}: enqueuing upgrade ${agentVersion} → ${AUTO_UPGRADE_TARGET} (audit #${auditId})`);

  // Push work item to agent long-poll channel (same path as manual one-click upgrade)
  channel.sendToAgent(
    connId,
    {
      method: 'POST',
      path: '/api/self-upgrade',
      body: { target_version: AUTO_UPGRADE_TARGET, triggered_by: 'auto-stale-policy' },
    },
    320000 // 320s — upgrade can take ~5min
  ).then(async (result) => {
    const body = result?.body || {};
    if (body.ok) {
      await upgradeAuditDb.markUpgradeCompleted(auditId);
      console.log(`[auto-upgrade] conn ${connId}: agent reported success (audit #${auditId})`);
    } else {
      await upgradeAuditDb.markUpgradeFailed(auditId, body.error || body.stderr || 'upgrade returned ok=false');
      console.warn(`[auto-upgrade] conn ${connId}: agent reported failure (audit #${auditId}): ${body.error}`);
    }
  }).catch(async (err) => {
    // Agent offline or timed out — mark failed; next heartbeat will re-evaluate
    await upgradeAuditDb.markUpgradeFailed(auditId, err.message || 'timed out').catch(() => {});
    console.warn(`[auto-upgrade] conn ${connId}: channel error (audit #${auditId}): ${err.message}`);
  });

  // Mark in_progress now that the work item has been dispatched to the channel
  await upgradeAuditDb.markUpgradeInProgress(auditId).catch(() => {});
}

// ── Proxy version upgrade via work item ─────────────────────────────────────────
// Separate from evaluateAutoUpgrade. For oracle-proxy.py connections (reporting 3.x
// agent_version), the poll-response proxy_upgrade_available field is ignored by old
// proxy versions. This function enqueues a work item so the proxy handles the
// upgrade directly in its poll loop (oracle-proxy.py 3.20.6+). Rate-limited 1h/conn.

async function evaluateProxyUpgrade(connectionId, proxyVersion) {
  if (!proxyVersion || !versionLessThan(proxyVersion, LATEST_PROXY_VERSION)) return;

  const connId = parseInt(connectionId, 10);

  // Pre-3.20.6 proxies don't have the poll-loop work-item intercept — the work
  // item would arrive as a local /api/self-upgrade 404 and fail immediately.
  // Their auto_update_loop (30m cycle) will pick up proxy_upgrade_available from
  // the poll response instead.
  if (versionLessThan(proxyVersion, '3.20.6')) {
    console.log(`[proxy-upgrade] conn ${connId}: proxy ${proxyVersion} < 3.20.6 — skipping work item, poll response only`);
    return;
  }

  const lastSent = _proxyUpgradeSentAt.get(connId) || 0;
  const cooldown = _proxyUpgradeBackoff.get(connId) || PROXY_UPGRADE_COOLDOWN_MS;
  if (Date.now() - lastSent < cooldown) return;

  _proxyUpgradeSentAt.set(connId, Date.now());
  console.log(`[proxy-upgrade] conn ${connId}: proxy ${proxyVersion} < ${LATEST_PROXY_VERSION} — enqueuing upgrade work item`);

  channel.sendToAgent(connId, {
    method: 'POST',
    path: '/api/self-upgrade',
    body: {
      proxy_upgrade: true,
      latest_proxy_url: `${APP_URL}/oracle-proxy.py`,
      target_version: LATEST_PROXY_VERSION,
      triggered_by: 'auto-stale-proxy',
    },
  }, 300000).then((result) => {
    const body = result?.body || {};
    if (body.ok) {
      console.log(`[proxy-upgrade] conn ${connId}: proxy acknowledged upgrade`);
      _proxyUpgradeBackoff.delete(connId); // success — reset backoff
    } else {
      console.warn(`[proxy-upgrade] conn ${connId}: proxy returned failure: ${body.error || body.message || 'unknown'}`);
      const backoff = Math.min((_proxyUpgradeBackoff.get(connId) || 300000) * 2, 21600000);
      _proxyUpgradeBackoff.set(connId, backoff);
      _proxyUpgradeSentAt.set(connId, Date.now()); // cooldown = backoff from now
    }
  }).catch((err) => {
    console.warn(`[proxy-upgrade] conn ${connId}: channel error: ${err.message}`);
    const backoff = Math.min((_proxyUpgradeBackoff.get(connId) || 300000) * 2, 21600000);
    _proxyUpgradeBackoff.set(connId, backoff);
    _proxyUpgradeSentAt.set(connId, Date.now()); // cooldown = backoff from now
  });
}

// ── semver helper (reuse logic from connections-list.js — no external dep) ─────
function versionLessThan(a, b) {
  if (!a) return true;
  const parse = v => (v || '0.0.0').replace(/[^0-9.]/g, '').split('.').map(Number);
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return aM < bM;
  if (am !== bm) return am < bm;
  return ap < bp;
}

// ── POST /api/agent/uninstall ───────────────────────────────────────────────
// Called by `tunevault-agent uninstall`. Marks connection as uninstalled,
// nulls heartbeat fields. Idempotent: second call returns already_uninstalled:true.
// Auth: X-TuneVault-Key header (agent API key).

router.post('/uninstall', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid key or connection not found' });

    const tunnel = await agentDb.getTunnel(parsedConnId);
    if (tunnel && tunnel.status === 'uninstalled') {
      return res.json({ ok: true, already_uninstalled: true, message: 'Already marked as uninstalled' });
    }

    await agentDb.markUninstalled(parsedConnId);

    console.log(`[agent] deregistered connection ${parsedConnId}`);
    res.json({ ok: true, already_uninstalled: false, message: 'Agent deregistered — connection moved to Removed' });
  } catch (err) {
    console.error('[agent] uninstall error:', err.message);
    res.status(500).json({ error: 'Uninstall failed' });
  }
});

// ── POST /api/agent/restore ─────────────────────────────────────────────────
// UI-facing: restores an uninstalled connection within the 30-day window.
// Auth: user session (requireAuth). Ownership-enforced.

router.post('/restore', requireAuth, async (req, res) => {
  const { connection_id } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (isNaN(parsedConnId)) return res.status(400).json({ error: 'connection_id must be a valid integer' });

  try {
    const tunnel = await agentDb.getTunnel(parsedConnId);
    if (!tunnel) return res.status(404).json({ error: 'Connection tunnel not found' });

    // Ownership check via oracle_connections
    const connRow = await agentDb.getConnectionById(parsedConnId);
    if (!connRow) return res.status(404).json({ error: 'Connection not found' });
    if (connRow.user_id && connRow.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (tunnel.status !== 'uninstalled') {
      return res.status(409).json({ error: 'Connection is not in uninstalled state' });
    }

    // 30-day restore window
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (tunnel.uninstalled_at && (Date.now() - new Date(tunnel.uninstalled_at).getTime()) > thirtyDaysMs) {
      return res.status(410).json({ error: 'Restore window expired (30 days)' });
    }

    await agentDb.restoreConnection(parsedConnId);

    console.log(`[agent] restored connection ${parsedConnId} by user ${req.user.id}`);
    res.json({ ok: true, message: 'Connection restored — re-install the agent to reconnect' });
  } catch (err) {
    console.error('[agent] restore error:', err.message);
    res.status(500).json({ error: 'Restore failed' });
  }
});

// ── GET /api/agent/status/:id ───────────────────────────────────────────────
// UI polls this every 3s to show live install progress.
// Returns { status, last_heartbeat, live }.
// Auth: user session (requireAuth).

router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const conn = await agentDb.getConnectionById(req.params.id);
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const tunnel = await agentDb.getTunnel(req.params.id);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const heartbeatRecent = tunnel && tunnel.last_heartbeat && new Date(tunnel.last_heartbeat) > fiveMinAgo;

    // Also check legacy proxy_key_last_used_at (set by existing python proxy)
    const proxyRecent = conn.proxy_key_last_used_at && new Date(conn.proxy_key_last_used_at) > fiveMinAgo;
    const live = heartbeatRecent || proxyRecent || conn.last_test_success === true;

    res.json({
      connection_id: parseInt(req.params.id, 10),
      status: tunnel ? tunnel.status : 'pending',
      last_heartbeat: tunnel ? tunnel.last_heartbeat : null,
      os_info: tunnel ? tunnel.os_info : null,
      oracle_sids: tunnel ? (tunnel.oracle_sids || []) : [],
      pdb_services: tunnel ? (tunnel.pdb_services || []) : [],
      live,
    });
  } catch (err) {
    console.error('[agent] status error:', err.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ── GET /api/agent/status (installer variant) ─────────────────────────────
// install.sh self-test check 3: confirm cloud side sees this agent.
// Auth: X-TuneVault-Key header (same key written to /etc/tunevault/proxy.env).
// Returns { registered: true } when the tunnel record is confirmed/active.

router.get('/status', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const connectionId = req.query.connection_id;
  if (!connectionId) return res.status(400).json({ error: 'connection_id query param required' });
  const parsedConnId = parseInt(connectionId, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid API key or connection not found' });

    const tunnel = await agentDb.getTunnel(parsedConnId);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const heartbeatRecent = tunnel && tunnel.last_heartbeat && new Date(tunnel.last_heartbeat) > fiveMinAgo;
    const confirmedStatus = tunnel && (tunnel.status === 'confirmed' || tunnel.status === 'active');
    const registered = confirmedStatus || heartbeatRecent;

    res.json({
      registered: !!registered,
      status: tunnel ? tunnel.status : 'pending',
      last_heartbeat: tunnel ? tunnel.last_heartbeat : null,
    });
  } catch (err) {
    console.error('[agent] status (installer) error:', err.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ── POST /api/agent/select-sid ───────────────────────────────────────────────
// UI calls this after the user picks which Oracle SID to use from the detected
// list. Saves service_name on the connection record so health checks know which
// database to target.

router.post('/select-sid', requireAuth, async (req, res) => {
  const { connection_id, sid } = req.body;
  if (!connection_id || !sid) {
    return res.status(400).json({ error: 'connection_id and sid are required' });
  }
  const parsedConnId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const conn = await agentDb.getConnectionById(parsedConnId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await agentDb.updateConnectionSid(parsedConnId, sid);
    res.json({ ok: true, service_name: sid });
  } catch (err) {
    console.error('[agent] select-sid error:', err.message);
    res.status(500).json({ error: 'Failed to save SID selection' });
  }
});

// ── POST /api/agent/poll ──────────────────────────────────────────────────
// Proxy agent long-polls for work. Held open ≤25s. Returns a work item
// or { work: null } if nothing arrived. Each successful poll also serves
// as a heartbeat — no separate heartbeat call needed when polling.
// Auth: X-TuneVault-Key header.

router.post('/poll', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const {
    connection_id, agent_version,
    proxy_version, installed_at, last_upgrade_at,
    python_version, cx_oracle_version, os_id, kernel,
    // oracle_worker status fields (v6.2+)
    agent_status, last_oracle_error, oracle_retry_count, uptime_seconds,
    // thick-mode fallback fields (v6.2+, Task #1728054)
    oracle_mode, instant_client_path, verifier_workaround_active,
    // EBS fleet grouping — sent when INSTANCE_NAME is set in agent.env
    ebs_instance_name,
  } = req.body;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnectionId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnectionId) || parsedConnectionId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const conn = await verifyApiKey(apiKey, parsedConnectionId);
    if (!conn) return res.status(403).json({ error: 'Invalid key or connection not found' });

    // Record heartbeat (polling = alive); agent_version + metadata optional (v3.6.0+)
    const meta = {
      proxy_version, installed_at, last_upgrade_at, python_version, cx_oracle_version, os_id, kernel,
      agent_status: agent_status || null,
      last_oracle_error: last_oracle_error || null,
      oracle_retry_count: oracle_retry_count !== undefined ? oracle_retry_count : null,
      uptime_seconds: uptime_seconds !== undefined ? uptime_seconds : null,
      // thick-mode fallback fields — let cloud dashboard show 'thin' | 'thick' per connection
      oracle_mode: oracle_mode || null,
      instant_client_path: instant_client_path || null,
      verifier_workaround_active: verifier_workaround_active != null ? verifier_workaround_active : null,
    };
    await agentDb.recordHeartbeat(parsedConnectionId, agent_version || null, meta);
    await agentDb.touchConnectionKeyUsage(parsedConnectionId);

    // Clear restart-loop flag on successful heartbeat (fire-and-forget)
    setImmediate(() => restartEventsDb.clearRestartLoopIfSet(parsedConnectionId).catch(() => {}));

    // Evaluate auto-upgrade policy on every poll (fire-and-forget)
    setImmediate(() => evaluateAutoUpgrade(parsedConnectionId, agent_version, false).catch(() => {}));

    // Enqueue proxy upgrade work item when proxy_version is stale (fire-and-forget, 1h dedup)
    if (proxy_version) {
      const proxyStale = versionLessThan(proxy_version, LATEST_PROXY_VERSION);
      if (proxyStale) {
        console.log(`[poll] conn ${parsedConnectionId} proxy ${proxy_version} latest ${LATEST_PROXY_VERSION} upgrade: true`);
      }
      setImmediate(() => evaluateProxyUpgrade(parsedConnectionId, proxy_version).catch(() => {}));
    }

    // Sync ebs_instance_name from agent.env → DB when agent sends it (fire-and-forget)
    if (ebs_instance_name) {
      setImmediate(() => agentDb.updateConnectionInstallerInfo(parsedConnectionId, {
        serverType: null, ebsService: null, ebsInstanceName: ebs_instance_name,
      }).catch(() => {}));
    }

    // Wait for work (holds connection up to 25s)
    const work = await channel.waitForWork(parsedConnectionId, 25);

    // Mark ebs_job as running when agent first claims it (fire-and-forget)
    if (work && work.job_id) {
      ebsJobsDb.startJob(work.job_id).catch(err =>
        console.error('[agent/poll] ebs_jobs startJob:', err.message)
      );
    }

    // Include proxy_upgrade_available in poll response so 3.20.6+ proxies can also
    // react immediately without waiting for the work item to be dequeued.
    const proxyUpgradeAvailable = proxy_version
      ? versionLessThan(proxy_version, LATEST_PROXY_VERSION)
      : false;

    const pollResp = { work: work || null };
    if (proxyUpgradeAvailable) {
      pollResp.proxy_upgrade_available = true;
      pollResp.latest_proxy_version = LATEST_PROXY_VERSION;
    }
    res.json(pollResp);
  } catch (err) {
    console.error('[agent] poll error:', err.message);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// ── POST /api/agent/respond ──────────────────────────────────────────────
// Proxy agent submits the result of a previously received work item.
// Auth: X-TuneVault-Key header.

router.post('/respond', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const { connection_id, request_id, status_code, body } = req.body;
  if (!connection_id || !request_id) {
    return res.status(400).json({ error: 'connection_id and request_id required' });
  }
  const parsedConnId = parseInt(connection_id, 10);
  if (isNaN(parsedConnId)) return res.status(400).json({ error: 'connection_id must be a valid integer' });

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid key or connection not found' });

    // await required — deliverResult is async: it writes to DB and fires pg_notify
    const delivered = await channel.deliverResult(request_id, parsedConnId, {
      status_code: status_code || 200,
      body: body || {},
    });

    res.json({ ok: delivered });

    // Write result to ebs_jobs if this was a fire-and-forget long op (job_id in payload)
    setImmediate(async () => {
      try {
        const cmdRow = await agentCmdQueueDb.findByRequestIdOnly(request_id);
        const rawPayload = cmdRow?.payload;
        const parsedPayload = typeof rawPayload === 'string'
          ? JSON.parse(rawPayload) : (rawPayload || {});
        const jobId = parsedPayload?.job_id;
        console.log('[agent/respond] ebs_jobs jobId=%s req=%s',
          jobId || 'null', (request_id||'').slice(0,8));
        if (!jobId) return;
        console.log('[agent/respond] body type:', typeof body,
          'keys:', body ? Object.keys(body) : 'null');
        const proxyBody = body || {};
        console.log('[agent/respond] proxyBody keys:',
          Object.keys(proxyBody), 'ok:', proxyBody.ok,
          'exit_code:', proxyBody.exit_code,
          'stdout_len:', (proxyBody.stdout||'').length);
        const isOk = (status_code === 200) && (proxyBody.success !== false) && (proxyBody.ok !== false);
        await ebsJobsDb.completeJob(jobId, {
          ok: isOk,
          stdout: proxyBody.stdout || '',
          exit_code: proxyBody.exit_code ?? null,
          duration_ms: proxyBody.duration_ms ?? null,
        });
      } catch (err) {
        console.error('[agent/respond] ebs_jobs completeJob error:', err.message);
      }
    });
  } catch (err) {
    console.error('[agent] respond error:', err.message);
    res.status(500).json({ error: 'Respond failed' });
  }
});

// ── GET /api/agent/channel-status/:id ────────────────────────────────────
// Returns whether an agent is actively connected via the polling channel.
// Used by test-connection and health-check to decide routing.

router.get('/channel-status/:id', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  // await required — isAgentConnected queries Postgres (was previously in-memory)
  res.json({ connected: await channel.isAgentConnected(connectionId) });
});

// ── GET /api/agent/latest-version ────────────────────────────────────────
// Public endpoint — v6 agents probe this to check if they are current.
// Returns the latest stable agent version string.

const LATEST_AGENT_VERSION = '7.5.0';

router.get('/latest-version', (req, res) => {
  res.json({ version: LATEST_AGENT_VERSION });
});

// ── POST /api/connections/:id/re-detect-sids ──────────────────────────────
// Re-detect SIDs button on connection-detail page. Dispatches /api/detect-sids
// through the agent channel, updates agent_tunnels with fresh CDB/PDB data,
// and returns the updated lists.

router.post('/re-detect-sids/:connectionId', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.connectionId, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Agent must be connected via the long-poll channel
    if (!await channel.isAgentConnected(connId)) {
      return res.status(503).json({
        error: 'Agent is not currently connected. Make sure the agent service is running.',
        code: 'AGENT_OFFLINE',
      });
    }

    // Dispatch /api/detect-sids to the agent (15s timeout)
    let result;
    try {
      result = await channel.sendToAgent(connId, {
        method: 'POST',
        path: '/api/detect-sids',
        body: {},
      }, 15_000);
    } catch (err) {
      return res.status(504).json({ error: `Agent request timed out: ${err.message}`, code: 'AGENT_TIMEOUT' });
    }

    if (!result || !result.ok) {
      // Fallback: older agent without /api/detect-sids — try /api/ping for CDB SIDs only
      try {
        const ping = await channel.sendToAgent(connId, { method: 'POST', path: '/api/ping', body: {} }, 12_000);
        if (ping && ping.detected_sids) {
          result = { ok: true, cdb_sids: ping.detected_sids, pdb_services: [] };
        }
      } catch (_) { /* ignore */ }
    }

    if (!result || !result.ok) {
      return res.status(502).json({ error: 'Agent returned an error from detect-sids', code: 'AGENT_ERROR' });
    }

    const cdbSids = Array.isArray(result.cdb_sids) ? result.cdb_sids : [];
    const pdbSvcs = Array.isArray(result.pdb_services) ? result.pdb_services : [];

    // Persist fresh data to agent_tunnels
    await agentDb.updateTunnelSids({ connectionId: connId, oracleSids: cdbSids, pdbServices: pdbSvcs });

    res.json({
      ok: true,
      cdb_sids: cdbSids,
      pdb_services: pdbSvcs,
    });
  } catch (err) {
    console.error('[agent] re-detect-sids error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agent/confirm — v6 extension ────────────────────────────────
// v6 agents send service_names (from lsnrctl) instead of oracle_sids/oracle_home.
// The confirm endpoint above already accepts oracle_sids generically; the field is
// now also accepted as service_names for the v6 agent so the UI picker works with
// both v5 (sid-based) and v6 (service_name-based) agents simultaneously.
// pdb_services (v4.5+): PDB service names from lsnrctl, stored separately from CDB oracle_sids.

// ── POST /api/agent/diagnose ───────────────────────────────────────────────
// Accepts a full diagnose JSON payload from tunevault-diagnose.sh immediately
// after the 8-probe run completes. Stored in agent_diagnose_runs — the connection
// card reads from here as the authoritative source of probe truth.
// Auth: X-TuneVault-Key header (same pattern as heartbeat).
// Failure to reach this endpoint must be a soft warning on the agent side (not a hard fail).

router.post('/diagnose', async (req, res) => {
  const apiKey = req.headers['x-tunevault-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-TuneVault-Key header required' });

  const {
    connection_id,
    agent_version,
    host,
    detected_sids,
    listener_services,
    chosen_service,
    probes,
    roundtrip_ms,
    timestamp: _ts, // stored in created_at automatically
  } = req.body;

  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  if (!Array.isArray(probes)) return res.status(400).json({ error: 'probes must be an array' });
  const parsedConnId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const conn = await verifyApiKey(apiKey, parsedConnId);
    if (!conn) return res.status(403).json({ error: 'Invalid key or connection not found' });

    const run = await diagnoseDb.insertDiagnoseRun({
      connectionId: parsedConnId,
      agentVersion: agent_version || null,
      host: host || null,
      detectedSids: Array.isArray(detected_sids) ? detected_sids : [],
      listenerServices: Array.isArray(listener_services) ? listener_services : [],
      chosenService: chosen_service || null,
      probes,
      roundtripMs: roundtrip_ms ? parseInt(roundtrip_ms, 10) : null,
    });

    res.json({ ok: true, run_id: run.id, overall_status: run.overall_status });
  } catch (err) {
    console.error('[agent] diagnose POST error:', err.message);
    res.status(500).json({ error: 'Failed to store diagnose run' });
  }
});

// ── GET /api/agent/diagnose/latest?connection_id=X ────────────────────────
// Returns latest diagnose run for a connection (auth required — UI polling).

router.get('/diagnose/latest', requireAuth, async (req, res) => {
  const { connection_id } = req.query;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedConnId = parseInt(connection_id, 10);
  if (!Number.isInteger(parsedConnId) || parsedConnId === null) {
    return res.status(400).json({ error: 'connection_id must be a valid integer' });
  }

  try {
    const run = await diagnoseDb.getLatestDiagnoseRun(parsedConnId);
    if (!run) return res.json({ run: null });
    res.json({ run });
  } catch (err) {
    console.error('[agent] diagnose GET error:', err.message);
    res.status(500).json({ error: 'Failed to fetch diagnose run' });
  }
});

// ── GET /api/agent/heartbeat-check?connection_id=X ────────────────────────
// Called by install.sh post-install verify loop (tight 2s poll). No API key
// required — install.sh may not have received the key yet when proxy first boots.
// Returns { alive, last_heartbeat_at, seconds_ago }.
// alive=true iff seconds_ago <= 90.
// 404 when connection_id is unknown (tunnel record never created).
// 5s in-memory cache absorbs the installer's tight polling loop.
// Soft-fail on DB error: always returns { alive: false } — never 500.

const _hbCache = new Map(); // connection_id → { result, expiresAt }
const HB_CACHE_TTL_MS = 5000;

router.get('/heartbeat-check', async (req, res) => {
  const { connection_id } = req.query;
  if (!connection_id) return res.status(400).json({ error: 'connection_id required' });
  const parsedId = parseInt(connection_id, 10);
  if (isNaN(parsedId)) return res.status(400).json({ error: 'connection_id must be a valid integer' });

  // Serve from 5s cache to handle installer 2s poll loop without hammering DB
  const cached = _hbCache.get(parsedId);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json(cached.result);
  }

  try {
    const tunnel = await agentDb.getTunnel(parsedId);

    // 404 when the connection_id has never been seen (no tunnel record)
    if (!tunnel) {
      return res.status(404).json({ error: 'connection_id not found' });
    }

    if (!tunnel.last_heartbeat) {
      const result = { alive: false, last_heartbeat_at: null, seconds_ago: null };
      _hbCache.set(parsedId, { result, expiresAt: Date.now() + HB_CACHE_TTL_MS });
      return res.json(result);
    }

    const lastHb = new Date(tunnel.last_heartbeat);
    const secondsAgo = Math.floor((Date.now() - lastHb.getTime()) / 1000);
    const alive = secondsAgo <= 90;

    const result = { alive, last_heartbeat_at: tunnel.last_heartbeat, seconds_ago: secondsAgo };
    _hbCache.set(parsedId, { result, expiresAt: Date.now() + HB_CACHE_TTL_MS });
    res.json(result);
  } catch (err) {
    console.error('[agent] heartbeat-check error:', err.message);
    res.json({ alive: false, last_heartbeat_at: null, seconds_ago: null, error: 'db_error' });
  }
});

// ── POST /api/agent/install-failures ─────────────────────────────────────
// Called by install.sh when the post-install verify loop fails. Completely
// unauthenticated — the agent may have failed to provision at all.
// Body: { connection_id?, host, error_class, journalctl_tail, install_log_tail,
//         installer_version, os_info }
// Rate-limited 20/hr/IP; returns 200 silently on breach (installer must not block).
// Alert: if error_class=systemd_failed AND ≥3 distinct hosts in last 10min,
// logs a structured alert (Datadog alert picks it up).

const VALID_ERROR_CLASSES = new Set([
  'systemd_failed', 'oracledb_import', 'provision_failed', 'venv_failed',
  'no_heartbeat', 'module_import_error', 'other',
]);

// In-process rate limiter keyed by IP: Map<ip, { count, windowStart }>
// express-rate-limit would return 429; we need silent 200 on breach, so roll our own.
const _installFailuresRateMap = new Map();
const INSTALL_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const INSTALL_FAIL_MAX = 20;

function checkInstallFailuresRateLimit(ip) {
  const now = Date.now();
  const entry = _installFailuresRateMap.get(ip);
  if (!entry || (now - entry.windowStart) > INSTALL_FAIL_WINDOW_MS) {
    _installFailuresRateMap.set(ip, { count: 1, windowStart: now });
    return false; // not rate-limited
  }
  entry.count += 1;
  return entry.count > INSTALL_FAIL_MAX;
}

router.post('/install-failures', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  // Rate limit: silent 200 on breach — installer must never block on telemetry
  if (checkInstallFailuresRateLimit(ip)) {
    return res.json({ ok: true, rate_limited: true });
  }

  const {
    connection_id,
    host,
    error_class,
    journalctl_tail,
    install_log_tail,
    installer_version,
    os_info,
  } = req.body || {};

  // Validate error_class enum; fall back to 'other' rather than 400 (installer must succeed)
  const safeErrorClass = VALID_ERROR_CLASSES.has(error_class) ? error_class : 'other';

  // Validate sizes — truncation handled in db layer but reject obviously bad payloads
  if (host && String(host).length > 16384) {
    return res.json({ ok: false, error: 'host too large' });
  }
  if (journalctl_tail && String(journalctl_tail).length > 16384) {
    return res.json({ ok: false, error: 'journalctl_tail too large' });
  }

  // Validate installer_version format: only digits and dots allowed
  const safeInstallerVersion = installer_version && /^[0-9.]+$/.test(installer_version)
    ? installer_version
    : null;

  // Guard: garbage connection_id → null
  let parsedConnId = null;
  if (connection_id !== undefined && connection_id !== null) {
    const n = parseInt(connection_id, 10);
    if (Number.isInteger(n)) parsedConnId = n;
  }

  try {
    const row = await installFailuresDb.insertInstallFailure({
      connectionId: parsedConnId,
      host,
      errorClass: safeErrorClass,
      journalctlTail: journalctl_tail,
      installLogTail: install_log_tail,
      installerVersion: safeInstallerVersion,
      osInfo: os_info,
      ipAddress: ip !== 'unknown' ? ip : null,
      userAgent: req.headers['user-agent'] || null,
    });

    console.log(`[agent] install failure recorded: id=${row.id} host=${host || '?'} error_class=${safeErrorClass}`);

    // Alert gate: ≥3 distinct hosts with systemd_failed in last 10min is an early
    // signal that a deploy broke something. Log structured event for Datadog alert.
    if (safeErrorClass === 'systemd_failed') {
      installFailuresDb.countRecentSystemdFailed(10).then(distinctHosts => {
        if (distinctHosts >= 3) {
          console.log(JSON.stringify({
            event: 'install_failure_spike',
            alert: true,
            error_class: 'systemd_failed',
            distinct_hosts_10min: distinctHosts,
            threshold: 3,
            latest_host: host || '?',
            latest_failure_id: row.id,
          }));
        }
      }).catch(() => {});
    }

    res.json({ ok: true, failure_id: row.id });
  } catch (err) {
    console.error('[agent] install-failures POST error:', err.message);
    // Always return 200 — install.sh must not block on this call failing
    res.json({ ok: false, error: 'failed to record' });
  }
});

// ── POST /api/agent/install-telemetry ────────────────────────────────────
// Called by install.sh at the end of the install flow to report which path
// the installer took: thin_ok | ic_installed | thin_fail_no_ic | skipped.
// Unauthenticated — install.sh may not have a stable API key at call time.
// Body: { connection_id, path, error, os_info, os_major, glibc_ver, oracle_driver, installer_version, host }
// Returns { ok: true } always — install.sh must not block on this failing.

router.post('/install-telemetry', async (req, res) => {
  const {
    connection_id,
    path: installPath,
    error,
    os_info,
    os_major,
    glibc_ver,
    oracle_driver,
    installer_version,
    host,
  } = req.body || {};

  try {
    // Log to structured output for Datadog dashboards / Wave 1 analytics.
    // No dedicated table needed — structured console.log is queryable in Datadog.
    console.log(JSON.stringify({
      event: 'install_telemetry',
      connection_id: connection_id ? parseInt(connection_id, 10) : null,
      install_path: installPath || 'unknown',
      error: error || null,
      os_info: os_info || null,
      os_major: os_major || null,
      glibc_ver: glibc_ver || null,
      oracle_driver: oracle_driver || null,
      installer_version: installer_version || null,
      host: host || null,
      received_at: new Date().toISOString(),
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent] install-telemetry POST error:', err.message);
    res.json({ ok: false });
  }
});

// ── POST /api/agent/log-tail ──────────────────────────────────────────────
// Agent flushes last 500 lines of its log on every heartbeat cycle.
// Body: { connection_id, log_lines: "line1\nline2\n..." }
// Auth: same X-TuneVault-Key API key used by /heartbeat.
// Returns { ok: true } always — agent must not block on this failing.

router.post('/log-tail', async (req, res) => {
  const { connection_id, log_lines } = req.body || {};
  const apiKey = req.headers['x-tunevault-key'];

  if (!connection_id || !apiKey) {
    return res.status(401).json({ error: 'Missing connection_id or API key' });
  }

  const connectionId = parseInt(connection_id, 10);
  if (isNaN(connectionId)) {
    return res.status(400).json({ error: 'Invalid connection_id' });
  }

  try {
    const conn = await verifyApiKey(apiKey, connectionId);
    if (!conn) return res.status(401).json({ error: 'Invalid API key' });

    // Cap at 500 lines
    const lines = (log_lines || '').split('\n');
    const capped = lines.slice(-500).join('\n');
    await adminAgentsDb.upsertLogTail(connectionId, capped);
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent] log-tail POST error:', err.message);
    res.json({ ok: false });
  }
});

// ── POST /api/agent/restart-reason ───────────────────────────────────────────
// Agent calls this before any sys.exit so the cloud knows why the restart happened.
// Body: { connection_id, reason_code, last_stage_reached, last_error, uptime_seconds, restart_sequence_id }
// Auth: X-TuneVault-Key (same API key used for /poll).
// Returns { ok: true } always — agent must not block on this failing.
//
// Loop detection: if ≥5 restarts with same reason_code in 10 min, flip agent_in_restart_loop.

const VALID_REASON_CODES = new Set([
  'watchdog_timeout', 'auth_failure', 'tls_error',
  'oracle_unreachable_sustained', 'manual_systemd', 'install_upgrade',
]);
const LOOP_THRESHOLD = 5;
const LOOP_WINDOW_MINUTES = 10;

router.post('/restart-reason', async (req, res) => {
  const { connection_id, reason_code, last_stage_reached, last_error, uptime_seconds, restart_sequence_id } = req.body || {};
  const apiKey = req.headers['x-tunevault-key'];

  // Respond immediately — agent is about to exit and can't wait
  res.json({ ok: true });

  if (!connection_id || !apiKey || !reason_code) return;
  const connectionId = parseInt(connection_id, 10);
  if (isNaN(connectionId)) return;

  // Sanitise reason_code — accept unknown codes but cap length
  const safeReasonCode = VALID_REASON_CODES.has(reason_code) ? reason_code : String(reason_code).slice(0, 64);

  try {
    const conn = await verifyApiKey(apiKey, connectionId);
    if (!conn) return; // silently drop — agent is exiting anyway

    await restartEventsDb.insertRestartEvent({
      connectionId,
      reasonCode: safeReasonCode,
      lastStageReached: last_stage_reached || null,
      lastError: last_error ? String(last_error).slice(0, 500) : null,
      uptimeSeconds: uptime_seconds != null ? parseInt(uptime_seconds, 10) : null,
      restartSequenceId: restart_sequence_id ? String(restart_sequence_id).slice(0, 64) : null,
    });

    // Loop detection — ≥5 restarts with same reason_code in 10 min
    const loopCount = await restartEventsDb.countRestartsByReason(connectionId, safeReasonCode, LOOP_WINDOW_MINUTES);
    if (loopCount >= LOOP_THRESHOLD) {
      await restartEventsDb.setRestartLoopFlag(connectionId, true, safeReasonCode);
      console.log(JSON.stringify({
        event: 'agent_restart_loop_detected',
        connection_id: connectionId,
        reason_code: safeReasonCode,
        count_in_window: loopCount,
        window_minutes: LOOP_WINDOW_MINUTES,
      }));
    }
  } catch (err) {
    console.error('[agent] restart-reason POST error:', err.message);
  }
});

module.exports = router;
