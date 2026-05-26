/**
 * routes/agent-crash-detect.js — Agent crash-loop detection and recovery UI.
 *
 * Owns: derived agent_health state endpoint, journalctl pull dispatch, crash-loop email,
 *       oracle_unreachable state propagation + Re-run probe 5 command dispatch.
 * Does NOT own: heartbeat recording (routes/agent.js), tunnel lifecycle (routes/agent.js),
 *               install failure ingestion (routes/agent.js POST /api/agent/install-failures),
 *               health check runs (routes/connections-list.js).
 *
 * agent_health states:
 *   never_registered        — tunnel row exists but never reached 'confirmed'
 *   registered_no_heartbeat — confirmed ≥2min ago, zero heartbeats ever
 *   crash_loop              — heartbeat came in once but stopped + ≥3 confirms in 5min window
 *   oracle_unreachable      — agent running + heartbeating, Oracle connect failing (new v6.2)
 *   healthy                 — last_heartbeat within 90s AND agent_status=healthy
 *   stale                   — last_heartbeat 90s–30min ago
 *   offline                 — last_heartbeat > 30min ago (or never)
 */

'use strict';

const express = require('express');
const pool    = require('../db/index');
const agentDb = require('../db/agent');
const cmdDb   = require('../db/agent-command-results');
const installFailuresDb = require('../db/agent-install-failures');
const channel = require('../services/agent-channel');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const APP_URL        = process.env.APP_URL        || 'https://tunevault.app';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const EMAIL_API_URL  = 'https://polsia.com/api/proxy/email';

// Patterns that indicate a well-known root cause in journalctl output
const CRASH_PATTERNS = [
  {
    pattern: /ModuleNotFoundError|No module named/i,
    cause: 'Python package missing — install.sh did not place the agent package or systemd unit is missing PYTHONPATH.',
    fix: 'Re-run the installer. Bug was fixed in v6.1.0 — the current installer bundles agent-pkg.tar.gz.',
  },
  {
    pattern: /ORA-12541/i,
    cause: 'TNS: no listener — Oracle listener is not running or firewall is blocking port 1521.',
    fix: 'Start the Oracle listener: `lsnrctl start`. Check firewall rules for port 1521.',
  },
  {
    pattern: /ORA-01017/i,
    cause: 'Invalid credentials — the username/password in the connection config is wrong.',
    fix: 'Edit this connection and verify the username and password are correct.',
  },
  {
    pattern: /Permission denied/i,
    cause: 'Filesystem or socket permission error — the agent OS user lacks access to a required path.',
    fix: 'Check the systemd unit User= field and ensure the agent user owns /opt/tunevault.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive agent_health state from tunnel row + install failure log.
 * Returns { state, last_heartbeat_at, confirmed_at, host, install_failure, registration_count }
 */
async function deriveAgentHealth(connectionId) {
  const connId = parseInt(connectionId, 10);

  // Grab tunnel + latest install failure in parallel
  const [tunnel, latestFailure] = await Promise.all([
    agentDb.getTunnel(connId),
    installFailuresDb.getRecentFailures(1).then(rows =>
      rows.find(r => r.connection_id === connId) || null
    ).catch(() => null),
  ]);

  if (!tunnel) {
    return { state: 'never_registered', tunnel: null, install_failure: latestFailure };
  }

  const now = Date.now();
  const confirmedAt = tunnel.confirmed_at ? new Date(tunnel.confirmed_at) : null;
  const lastHb = tunnel.last_heartbeat ? new Date(tunnel.last_heartbeat) : null;
  const hbAgeMs = lastHb ? now - lastHb.getTime() : null;

  // ── Healthy: heartbeat within 90s ────────────────────────────────────────
  if (lastHb && hbAgeMs !== null && hbAgeMs < 90_000) {
    // Check oracle_worker status stored in agent_tunnels (v6.2+).
    // If agent is alive but Oracle is unreachable, return oracle_unreachable instead
    // of healthy — this is the key state introduced by this task.
    const agentStatus = tunnel.agent_status;
    if (agentStatus === 'oracle_unreachable') {
      return {
        state: 'oracle_unreachable',
        tunnel,
        last_heartbeat_at: tunnel.last_heartbeat,
        oracle_error: tunnel.last_oracle_error || null,
        oracle_retry_count: tunnel.oracle_retry_count || 0,
        install_failure: null,
      };
    }
    return {
      state: 'healthy',
      tunnel,
      last_heartbeat_at: tunnel.last_heartbeat,
      install_failure: null,
    };
  }

  // ── Stale: last heartbeat 90s-30min ──────────────────────────────────────
  if (lastHb && hbAgeMs !== null && hbAgeMs < 30 * 60_000) {
    return {
      state: 'stale',
      tunnel,
      last_heartbeat_at: tunnel.last_heartbeat,
      install_failure: null,
    };
  }

  // ── Registered but never heartbeated ─────────────────────────────────────
  // confirmed ≥2min ago, zero heartbeats ever
  if (!lastHb && confirmedAt && (now - confirmedAt.getTime()) >= 2 * 60_000) {
    return {
      state: 'registered_no_heartbeat',
      tunnel,
      confirmed_at: tunnel.confirmed_at,
      install_failure: latestFailure,
    };
  }

  // ── Crash-loop detection ──────────────────────────────────────────────────
  // Last heartbeat is old (or never) AND there are recent confirm events.
  // We detect this by counting how many times the tunnel has been confirmed
  // recently, which corresponds to systemd restart cycles rerunning install steps.
  //
  // Proxy: check if install failure was filed (agent reported its own crash).
  const isLikelyCrashLoop = latestFailure &&
    (latestFailure.error_class === 'systemd_failed' ||
     latestFailure.error_class === 'module_import_error' ||
     latestFailure.error_class === 'no_heartbeat');

  if (isLikelyCrashLoop) {
    return {
      state: 'crash_loop',
      tunnel,
      last_heartbeat_at: tunnel.last_heartbeat,
      confirmed_at: tunnel.confirmed_at,
      install_failure: latestFailure,
    };
  }

  // ── Offline (stale/long-dead) ─────────────────────────────────────────────
  const state = lastHb ? 'offline' : 'registered_no_heartbeat';
  return {
    state,
    tunnel,
    last_heartbeat_at: tunnel.last_heartbeat,
    confirmed_at: tunnel.confirmed_at,
    install_failure: latestFailure,
  };
}

// ── GET /api/connections/:id/agent-health ─────────────────────────────────────
// Returns derived agent_health state for a connection.
// Used by connections.html to decide whether to show the crash-loop card.

router.get('/connections/:id/agent-health', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (isNaN(connId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Ownership check via existing agent helper
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const health = await deriveAgentHealth(connId);

    // Fetch latest journalctl result (may be null)
    const journalctlResult = await cmdDb.getLatestJournalctlResult(connId).catch(() => null);

    // Attach pattern-matched diagnosis if journalctl output available
    let diagnosis = null;
    const output = journalctlResult?.output || health.install_failure?.journalctl_tail;
    if (output) {
      for (const p of CRASH_PATTERNS) {
        if (p.pattern.test(output)) {
          diagnosis = { cause: p.cause, fix: p.fix };
          break;
        }
      }
    }

    res.json({
      connection_id: connId,
      agent_health: health.state,
      last_heartbeat_at: health.last_heartbeat_at || null,
      confirmed_at: health.confirmed_at || null,
      host: conn.host || health.tunnel?.os_info || null,
      installed_at: conn.installed_at || null,
      // Oracle worker status (v6.2+) — populated when agent_health='oracle_unreachable'
      oracle_error: health.oracle_error || null,
      oracle_retry_count: health.oracle_retry_count || 0,
      oracle_service_name: health.tunnel?.chosen_service || conn.service_name || null,
      install_failure: health.install_failure ? {
        id: health.install_failure.id,
        error_class: health.install_failure.error_class,
        host: health.install_failure.host,
        journalctl_tail: health.install_failure.journalctl_tail,
        installer_version: health.install_failure.installer_version,
        created_at: health.install_failure.created_at,
      } : null,
      journalctl_result: journalctlResult ? {
        id: journalctlResult.id,
        status: journalctlResult.status,
        output: journalctlResult.output,
        exit_code: journalctlResult.exit_code,
        requested_at: journalctlResult.requested_at,
        completed_at: journalctlResult.completed_at,
      } : null,
      diagnosis,
    });
  } catch (err) {
    console.error('[agent-crash-detect] agent-health error:', err.message);
    res.status(500).json({ error: 'Failed to compute agent health' });
  }
});

// ── POST /api/connections/:id/pull-journalctl ─────────────────────────────────
// Queue a one-shot journalctl command to the agent. If the agent is unreachable
// (crash-loop, no long-poll), fall back immediately to the latest install_failure
// journalctl_tail that was captured by install.sh.

router.post('/connections/:id/pull-journalctl', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (isNaN(connId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const JOURNALCTL_CMD = 'journalctl -u tunevault-agent -n 50 --no-pager -l';

    // Create a result record immediately (shows "pending" in UI)
    const resultRow = await cmdDb.createCommandResult({
      connectionId: connId,
      command: JOURNALCTL_CMD,
      requestedBy: req.user.id,
    });

    // Try live agent first (only if channel is open)
    if (await channel.isAgentConnected(connId)) {
      // Fire async — UI polls the result row until completed
      setImmediate(async () => {
        try {
          const agentResp = await channel.sendToAgent(connId, {
            method: 'POST',
            path: '/api/exec-command',
            body: { command: JOURNALCTL_CMD, timeout_s: 20 },
          }, 25_000);

          const body = agentResp?.body || {};
          await cmdDb.completeCommandResult({
            id: resultRow.id,
            output: body.stdout || body.output || null,
            exitCode: body.exit_code !== undefined ? body.exit_code : null,
            errorMessage: body.ok === false ? (body.error || 'Agent error') : null,
          });
        } catch (err) {
          // Agent went offline mid-request; fall back to install_failure capture
          await useFallbackOutput(resultRow.id, connId, err.message);
        }
      });

      return res.json({
        ok: true,
        result_id: resultRow.id,
        source: 'agent_channel',
        message: 'Journalctl pull queued. Poll /api/connections/:id/agent-health for output.',
      });
    }

    // Agent unreachable — fall back to install_failure journalctl_tail immediately
    const failures = await installFailuresDb.getRecentFailures(1);
    const failure = failures.find(f => f.connection_id === connId) || null;

    if (failure?.journalctl_tail) {
      await cmdDb.completeCommandResult({
        id: resultRow.id,
        output: `[Captured by install.sh — agent unreachable]\n\n${failure.journalctl_tail}`,
        exitCode: 1,
      });
      return res.json({
        ok: true,
        result_id: resultRow.id,
        source: 'install_failure_fallback',
        output: failure.journalctl_tail,
        message: 'Agent is unreachable. Showing journalctl captured by install.sh.',
      });
    }

    // Nothing to show
    await cmdDb.completeCommandResult({
      id: resultRow.id,
      output: null,
      exitCode: null,
      errorMessage: 'Agent unreachable and no install failure log found.',
    });

    return res.json({
      ok: false,
      result_id: resultRow.id,
      source: 'none',
      message: 'Agent is unreachable and no captured log was found. Try re-running the installer.',
    });
  } catch (err) {
    console.error('[agent-crash-detect] pull-journalctl error:', err.message);
    res.status(500).json({ error: 'Failed to pull journalctl' });
  }
});

async function useFallbackOutput(resultRowId, connId, errorMsg) {
  try {
    const failures = await installFailuresDb.getRecentFailures(1);
    const failure = failures.find(f => f.connection_id === connId) || null;
    const fallback = failure?.journalctl_tail
      ? `[Agent offline — fallback from install.sh capture]\n\n${failure.journalctl_tail}`
      : null;
    await cmdDb.completeCommandResult({
      id: resultRowId,
      output: fallback,
      exitCode: fallback ? 1 : null,
      errorMessage: fallback ? null : `Agent timed out: ${errorMsg}`,
    });
  } catch (e) {
    console.warn('[agent-crash-detect] fallback error:', e.message);
  }
}

// ── Crash-loop email alert ────────────────────────────────────────────────────
// Called from heartbeat clear path in routes/agent.js when status flips.
// Also callable by the cron sweeper.

/**
 * Send a one-time crash-loop alert email for a connection.
 * Dedupped via agent_crash_alerts_sent (one per 24h per connection).
 * Fire-and-forget safe — never throws.
 *
 * @param {object} params
 * @param {number} params.connectionId
 * @param {string} params.connectionName
 * @param {string} params.agentHealth   — the specific failure state
 * @param {string} params.recipientEmail
 * @param {string} [params.host]
 * @param {string} [params.installFailureClass]  — error_class from install_failure
 */
async function sendCrashLoopAlert({
  connectionId,
  connectionName,
  agentHealth,
  recipientEmail,
  host,
  installFailureClass,
}) {
  if (!POLSIA_API_KEY || !recipientEmail) return;

  try {
    const alreadySent = await cmdDb.crashAlertAlreadySent(connectionId);
    if (alreadySent) return;

    const stateLabel = {
      crash_loop: 'Agent crash-loop detected',
      registered_no_heartbeat: 'Agent installed but not heartbeating',
    }[agentHealth] || 'Agent offline after install';

    const errorLabel = {
      systemd_failed: 'systemd service failed to stay running',
      module_import_error: 'Python ModuleNotFoundError (install.sh package issue)',
      no_heartbeat: 'No heartbeat received after install',
    }[installFailureClass] || installFailureClass || 'Unknown failure';

    const subject = `[TuneVault] ${stateLabel} — ${connectionName}`;
    const htmlBody = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;background:#111;color:#e8e8ed;padding:24px;border-radius:8px">
        <div style="background:#dc2626;color:#fff;padding:14px 18px;border-radius:6px;margin-bottom:20px">
          <strong style="font-size:16px">⚠ ${stateLabel}</strong>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr>
            <td style="padding:6px 0;color:#9ca3af;width:140px">Connection</td>
            <td style="padding:6px 0;font-weight:600">${escHtml(connectionName)}</td>
          </tr>
          ${host ? `<tr><td style="padding:6px 0;color:#9ca3af">Host</td><td style="padding:6px 0">${escHtml(host)}</td></tr>` : ''}
          <tr>
            <td style="padding:6px 0;color:#9ca3af">Failure type</td>
            <td style="padding:6px 0;color:#f87171">${escHtml(errorLabel)}</td>
          </tr>
        </table>
        <div style="background:#1a1a1f;border-radius:6px;padding:14px;margin:20px 0;font-size:13px;color:#9ca3af">
          The agent installed successfully but is not able to maintain a connection to TuneVault Cloud.
          Open the connection in TuneVault to pull the live journalctl log and get a one-line fix.
        </div>
        <a href="${APP_URL}/connections" style="display:inline-block;background:#f0a830;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px">
          View Connections →
        </a>
      </div>
    `;

    await fetch(`${EMAIL_API_URL}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLSIA_API_KEY}`,
      },
      body: JSON.stringify({
        to: recipientEmail,
        subject,
        body: `${stateLabel} on connection "${connectionName}". Open TuneVault to pull the journalctl log and get a fix: ${APP_URL}/connections`,
        html: htmlBody,
      }),
    });

    await cmdDb.recordCrashAlertSent({ connectionId, recipient: recipientEmail, agentHealth });
    console.log(`[agent-crash-detect] crash-loop alert sent to ${recipientEmail} for conn ${connectionId}`);
  } catch (err) {
    console.warn('[agent-crash-detect] crash alert email error:', err.message);
  }
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── GET /api/connections/:id/pull-journalctl/result/:resultId ─────────────────
// Poll endpoint — returns the current state of a command result row.

router.get('/connections/:id/pull-journalctl/result/:resultId', requireAuth, async (req, res) => {
  const connId   = parseInt(req.params.id, 10);
  const resultId = parseInt(req.params.resultId, 10);
  if (isNaN(connId) || isNaN(resultId)) return res.status(400).json({ error: 'Invalid ids' });

  try {
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Not found' });
    if (conn.user_id && conn.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const row = await cmdDb.getLatestJournalctlResult(connId);
    if (!row || row.id !== resultId) return res.status(404).json({ error: 'Result not found' });

    res.json({
      id: row.id,
      status: row.status,
      output: row.output,
      exit_code: row.exit_code,
      requested_at: row.requested_at,
      completed_at: row.completed_at,
    });
  } catch (err) {
    console.error('[agent-crash-detect] poll result error:', err.message);
    res.status(500).json({ error: 'Failed to fetch result' });
  }
});

// ── POST /api/connections/:id/rerun-probe5 ────────────────────────────────────
// Dispatches a /api/run-probe5 command to the agent via the long-poll channel.
// The agent re-runs probe 5 (service discovery) and writes the winning service
// name back to agent.env + restarts itself. The UI button shows this for
// oracle_unreachable state — clicking it lets the agent self-heal without SSH.

router.post('/connections/:id/rerun-probe5', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (isNaN(connId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionById(connId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!await channel.isAgentConnected(connId)) {
      return res.status(503).json({
        error: 'Agent is not currently connected via long-poll. Wait for next heartbeat or reinstall.',
        code: 'AGENT_OFFLINE',
      });
    }

    // Dispatch re-probe command — agent runs probe 5 logic, writes new service to agent.env
    let result;
    try {
      result = await channel.sendToAgent(connId, {
        method: 'POST',
        path: '/api/run-probe5',
        body: {},
      }, 45_000); // probe 5 has up to 30s timeout internally
    } catch (err) {
      return res.status(504).json({
        error: `Agent did not respond within 45s: ${err.message}`,
        code: 'AGENT_TIMEOUT',
      });
    }

    const ok = result?.ok === true || result?.status_code === 200;
    res.json({
      ok,
      oracle_service_name: result?.oracle_service_name || null,
      message: ok
        ? `Probe 5 re-run complete. New service: ${result?.oracle_service_name || 'unknown'}. Oracle worker will retry in 60s.`
        : `Probe 5 re-run returned an error: ${result?.error || 'unknown'}`,
      raw: result || null,
    });
  } catch (err) {
    console.error('[agent-crash-detect] rerun-probe5 error:', err.message);
    res.status(500).json({ error: 'Failed to dispatch probe 5 re-run' });
  }
});

module.exports = router;
module.exports.sendCrashLoopAlert = sendCrashLoopAlert;
module.exports.deriveAgentHealth  = deriveAgentHealth;
