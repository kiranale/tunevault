/**
 * routes/installer-validation.js — Installer validation status page + run API.
 *
 * Owns: /status/installer (public status page), /api/status/installer (JSON status),
 *       /api/admin/installer-validation/run (trigger manual GitHub Actions run, admin-only),
 *       POST /api/installer-validation/report (receive probe results from CI),
 *       POST /api/admin/installer-validation/ebs-result (record live EBS validation, admin-only).
 * Does NOT own: GitHub Actions workflow execution, Oracle test instance credentials,
 *               email dispatch (services/installer-validation-mailer.js),
 *               health check execution (oracle-client.js) or SSH profile management (routes/ssh-profiles.js).
 *
 * Mounted at: '/' + '/api' in server.js
 */

'use strict';

const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const db       = require('../db/installer-validation');

const router   = express.Router();

const APP_URL        = process.env.APP_URL || 'https://tunevault.app';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;
const EMAIL_API_URL  = 'https://polsia.com/api/proxy/email';

// Alert recipient — owner email for FAIL notifications
const ALERT_EMAIL    = process.env.INSTALLER_ALERT_EMAIL || process.env.ADMIN_EMAILS?.split(',')[0]?.trim();

// Shared secret between this server and CI (GitHub Actions) to authenticate result POSTs.
// Set CI_REPORT_TOKEN in Render env vars + in CI secrets.
const CI_REPORT_TOKEN = process.env.CI_REPORT_TOKEN || '';

// ─── Public status page ──────────────────────────────────────────────────────

// GET /status/installer — public installer health status page (no auth)
router.get('/status/installer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'status-installer.html'));
});

// ─── Public JSON API ─────────────────────────────────────────────────────────

// GET /api/status/installer — public JSON: latest run per OS + 30-day history + EBS live row
router.get('/api/status/installer', async (req, res) => {
  try {
    const [latest, ol7History, ol8History, ebsLatest, ebsHistory] = await Promise.all([
      db.getLatestRuns(),
      db.getHistory('ol7'),
      db.getHistory('ol8'),
      db.getLatestEbsRun(),
      db.getEbsHistory(),
    ]);

    // Compute overall health (greenfield only for banner)
    const ol7Pass  = latest.ol7?.overall === 'pass';
    const ol8Pass  = latest.ol8?.overall === 'pass';
    const allGreen = ol7Pass && ol8Pass;

    // Age of last verified run
    const lastVerifiedAt = [latest.ol7?.finished_at, latest.ol8?.finished_at]
      .filter(Boolean)
      .map(d => new Date(d).getTime())
      .sort((a, b) => b - a)[0] || null;

    const ageMinutes = lastVerifiedAt
      ? Math.floor((Date.now() - lastVerifiedAt) / 60000)
      : null;

    res.json({
      status: allGreen ? 'healthy' : 'degraded',
      age_minutes: ageMinutes,
      os: {
        ol7: formatRunForApi(latest.ol7),
        ol8: formatRunForApi(latest.ol8),
      },
      ebs: formatEbsRunForApi(ebsLatest),
      history: {
        ol7: ol7History.map(r => ({
          id: r.id,
          run_id: r.run_id,
          started_at: r.started_at,
          overall: r.overall,
          duration_total_ms: r.duration_total_ms,
          install_sha: r.install_sha,
          trigger_source: r.trigger_source,
        })),
        ol8: ol8History.map(r => ({
          id: r.id,
          run_id: r.run_id,
          started_at: r.started_at,
          overall: r.overall,
          duration_total_ms: r.duration_total_ms,
          install_sha: r.install_sha,
          trigger_source: r.trigger_source,
        })),
        ebs: ebsHistory.map(r => ({
          id: r.id,
          run_id: r.run_id,
          started_at: r.started_at,
          overall: r.overall,
          duration_total_ms: r.duration_total_ms,
          install_sha: r.install_sha,
          trigger_source: r.trigger_source,
          agent_version: r.agent_version,
          checks_passed: r.checks_passed,
          checks_total: r.checks_total,
          ssh_runbook_executed: r.ssh_runbook_executed,
        })),
      },
    });
  } catch (err) {
    console.error('[installer-validation] GET /api/status/installer error:', err.message);
    res.status(500).json({ error: 'Failed to load installer status' });
  }
});

function formatRunForApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    os: row.os,
    install_sha: row.install_sha,
    agent_version: row.agent_version,
    kernel_version: row.kernel_version,
    overall: row.overall,
    duration_total_ms: row.duration_total_ms,
    trigger_source: row.trigger_source,
    probes: [1,2,3,4,5,6,7].map(n => ({
      n,
      status: row[`probe_${n}_status`],
      ms:     row[`probe_${n}_ms`],
      error:  row[`probe_${n}_error`],
    })),
  };
}

/**
 * Format a live EBS validation row for the API response.
 * Includes health-check summary + SSH runbook flag alongside standard probe data.
 */
function formatEbsRunForApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    os: row.os,
    topology: row.topology,
    install_sha: row.install_sha,
    agent_version: row.agent_version,
    kernel_version: row.kernel_version,
    overall: row.overall,
    duration_total_ms: row.duration_total_ms,
    trigger_source: row.trigger_source,
    checks_passed: row.checks_passed,
    checks_total: row.checks_total,
    ssh_runbook_executed: row.ssh_runbook_executed,
    probes: [1,2,3,4,5,6,7].map(n => ({
      n,
      status: row[`probe_${n}_status`],
      ms:     row[`probe_${n}_ms`],
      error:  row[`probe_${n}_error`],
    })),
  };
}

// ─── CI result ingestion ─────────────────────────────────────────────────────

/**
 * POST /api/installer-validation/report
 * Called by GitHub Actions at the end of each validation run.
 * Body: { token, run_id, os, install_sha, agent_version, kernel_version,
 *         probes: [{n, status, ms, error}], overall, duration_total_ms }
 *
 * Token auth — CI_REPORT_TOKEN env var must match body.token.
 * No session auth; this is an internal CI → server callback.
 */
router.post('/api/installer-validation/report', async (req, res) => {
  const {
    token, run_id, os, install_sha, agent_version, kernel_version,
    probes, overall, duration_total_ms, error_message,
    topology, checks_passed, checks_total, ssh_runbook_executed,
  } = req.body;

  // Auth: constant-time token compare
  if (!CI_REPORT_TOKEN) {
    // If no token configured, deny with 503 (misconfiguration, not auth failure)
    console.error('[installer-validation] CI_REPORT_TOKEN not configured — rejecting report');
    return res.status(503).json({ error: 'CI_REPORT_TOKEN not configured on server' });
  }

  const provided = Buffer.from(String(token || ''));
  const expected = Buffer.from(CI_REPORT_TOKEN);
  if (provided.length !== expected.length) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!run_id || !os || !['ol7','ol8','ebs12210'].includes(os)) {
    return res.status(400).json({ error: 'run_id and os (ol7|ol8|ebs12210) required' });
  }

  try {
    // Find or create the run row
    let run = null;
    // CI inserts a pending row at start of run; this endpoint receives the final result.
    // If no pending row exists (cold start), create now.
    const update = {
      finished_at: new Date(),
      install_sha:       install_sha || null,
      agent_version:     agent_version || null,
      kernel_version:    kernel_version || null,
      overall:           overall || 'error',
      duration_total_ms: duration_total_ms || null,
      error_message:     error_message || null,
      // EBS topology fields (null for greenfield runs)
      topology:              topology || null,
      checks_passed:         checks_passed != null ? Number(checks_passed) : null,
      checks_total:          checks_total  != null ? Number(checks_total)  : null,
      ssh_runbook_executed:  ssh_runbook_executed === true || ssh_runbook_executed === 'true',
    };

    // Map probe array to flat columns
    if (Array.isArray(probes)) {
      for (const p of probes) {
        if (p.n >= 1 && p.n <= 7) {
          update[`probe_${p.n}_status`] = p.status || null;
          update[`probe_${p.n}_ms`]     = p.ms     || null;
          update[`probe_${p.n}_error`]  = p.error  || null;
        }
      }
    }

    // Upsert: look for a pending run with same run_id + os, else create new row
    const existing = await db.findRunByRunId(run_id, os);

    if (existing) {
      run = await db.updateRun(existing.id, update);
    } else {
      // Derive topology from OS if not provided
      const resolvedTopology = topology || (os === 'ebs12210' ? 'live-EBS-12.2.10-db-dev' : null);
      const inserted = await db.insertRun({ run_id, os, trigger_source: 'cron', topology: resolvedTopology });
      run = await db.updateRun(inserted.id, update);
    }

    // Send FAIL alert if run failed (fire-and-forget)
    if (overall === 'fail' || overall === 'error') {
      sendFailAlert(run, probes || []).catch(err => {
        console.error('[installer-validation] alert email failed:', err.message);
      });
    }

    res.json({ ok: true, id: run?.id });
  } catch (err) {
    console.error('[installer-validation] report ingestion error:', err.message);
    res.status(500).json({ error: 'Failed to save validation result' });
  }
});

// ─── Admin: manual trigger ───────────────────────────────────────────────────

/**
 * POST /api/admin/installer-validation/run
 * Admin-only: trigger a manual validation run by dispatching a GitHub Actions workflow.
 * Requires GITHUB_TOKEN + GITHUB_REPO env vars.
 */
router.post('/api/admin/installer-validation/run', requireAdmin, async (req, res) => {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO; // e.g. "Polsia-Inc/tunevault"

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(503).json({
      error: 'GITHUB_TOKEN and GITHUB_REPO env vars required for manual trigger',
    });
  }

  try {
    const dispatchUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/installer-validation.yml/dispatches`;
    const response = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { trigger_source: 'manual' } }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[installer-validation] GitHub dispatch failed:', response.status, body);
      return res.status(502).json({ error: `GitHub dispatch failed: ${response.status}` });
    }

    res.json({ ok: true, message: 'Workflow dispatch sent to GitHub Actions' });
  } catch (err) {
    console.error('[installer-validation] manual trigger error:', err.message);
    res.status(500).json({ error: 'Failed to trigger workflow' });
  }
});

// ─── Admin: record EBS live-validation result ─────────────────────────────────

/**
 * POST /api/admin/installer-validation/ebs-result
 * Admin-only: manually record a live EBS 12.2.10 validation result.
 * Used when running the v6-agent end-to-end walk on ebs12210-db-dev.
 *
 * Body: { run_id, install_sha, agent_version, kernel_version, overall,
 *         checks_passed, checks_total, ssh_runbook_executed,
 *         probes: [{n, status, ms, error}], duration_total_ms, notes }
 */
router.post('/api/admin/installer-validation/ebs-result', requireAdmin, async (req, res) => {
  const {
    run_id, install_sha, agent_version, kernel_version, overall,
    checks_passed, checks_total, ssh_runbook_executed,
    probes, duration_total_ms, notes,
  } = req.body;

  if (!run_id) {
    return res.status(400).json({ error: 'run_id required' });
  }

  try {
    const topology = 'live-EBS-12.2.10-db-dev';
    const os       = 'ebs12210';

    const existing = await db.findRunByRunId(run_id, os);
    let inserted;
    if (!existing) {
      inserted = await db.insertRun({ run_id, os, trigger_source: 'manual', topology });
    }

    const rowId = existing?.id || inserted?.id;

    const update = {
      finished_at:          new Date(),
      install_sha:          install_sha   || null,
      agent_version:        agent_version || null,
      kernel_version:       kernel_version || null,
      overall:              overall        || 'pass',
      duration_total_ms:    duration_total_ms || null,
      topology,
      checks_passed:        checks_passed != null ? Number(checks_passed) : null,
      checks_total:         checks_total  != null ? Number(checks_total)  : null,
      ssh_runbook_executed: ssh_runbook_executed === true || ssh_runbook_executed === 'true',
      error_message:        notes || null,
    };

    if (Array.isArray(probes)) {
      for (const p of probes) {
        if (p.n >= 1 && p.n <= 7) {
          update[`probe_${p.n}_status`] = p.status || null;
          update[`probe_${p.n}_ms`]     = p.ms     || null;
          update[`probe_${p.n}_error`]  = p.error  || null;
        }
      }
    }

    const run = await db.updateRun(rowId, update);
    res.json({ ok: true, id: run?.id, topology });
  } catch (err) {
    console.error('[installer-validation] EBS result record error:', err.message);
    res.status(500).json({ error: 'Failed to record EBS validation result' });
  }
});

// ─── Alert email ─────────────────────────────────────────────────────────────

async function sendFailAlert(run, probes) {
  if (!POLSIA_API_KEY || !ALERT_EMAIL) {
    console.warn('[installer-validation] alert skipped: POLSIA_API_KEY or ALERT_EMAIL not set');
    return;
  }

  const failedProbes = probes.filter(p => p.status === 'fail');
  const probeNames = [
    '', // index 0 unused
    'Python env (cx_Oracle + oracledb)',
    'Agent connectivity',
    'TNS/listener resolution',
    'Oracle credentials',
    'SSH bastion',
    'End-to-end query',
    'Proxy version current',
  ];

  const probeRows = failedProbes.map(p => `
    <tr style="border-bottom:1px solid #2a2a30">
      <td style="padding:10px 12px;color:#ff6b6b;font-weight:600">Probe ${p.n}</td>
      <td style="padding:10px 12px;color:#e8e8ed">${probeNames[p.n] || `Probe ${p.n}`}</td>
      <td style="padding:10px 12px;color:#8888a0;font-family:monospace;font-size:12px">${p.error || '(no detail)'}</td>
    </tr>`).join('');

  const subject = `🔴 Installer FAIL on ${run.os.toUpperCase()} — SHA ${run.install_sha?.slice(0,7) || 'unknown'}`;

  const htmlBody = `
    <div style="font-family:'Space Grotesk',-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0c;color:#e8e8ed;padding:24px;border-radius:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px">
        <div style="background:#f0a830;width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0a0a0c">TV</div>
        <span style="font-size:20px;font-weight:700;letter-spacing:-.5px">TuneVault Installer Monitor</span>
      </div>

      <div style="background:#2d0a0a;border:1px solid #7b0000;border-radius:10px;padding:20px;margin-bottom:20px">
        <div style="font-size:20px;font-weight:700;color:#ff6b6b;margin-bottom:8px">🔴 Installer validation FAILED</div>
        <div style="color:#8888a0;font-size:14px">
          OS: <strong style="color:#e8e8ed">${run.os.toUpperCase()}</strong> &nbsp;·&nbsp;
          SHA: <code style="background:#1a1a1e;padding:2px 6px;border-radius:4px">${run.install_sha?.slice(0,7) || 'unknown'}</code> &nbsp;·&nbsp;
          Duration: <strong style="color:#e8e8ed">${run.duration_total_ms ? Math.round(run.duration_total_ms/1000) + 's' : 'unknown'}</strong>
        </div>
      </div>

      ${failedProbes.length > 0 ? `
      <div style="margin-bottom:20px">
        <div style="font-size:15px;font-weight:600;margin-bottom:12px">Failed probes</div>
        <table style="width:100%;border-collapse:collapse;background:#111114;border:1px solid #2a2a30;border-radius:8px;overflow:hidden">
          <thead>
            <tr style="background:#1a1a1e;color:#8888a0;font-size:12px;text-transform:uppercase">
              <th style="padding:8px 12px;text-align:left">Probe</th>
              <th style="padding:8px 12px;text-align:left">Name</th>
              <th style="padding:8px 12px;text-align:left">Error</th>
            </tr>
          </thead>
          <tbody>${probeRows}</tbody>
        </table>
      </div>` : ''}

      <a href="${APP_URL}/status/installer" style="display:inline-block;padding:12px 24px;background:#f0a830;color:#0a0a0c;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">
        View status page →
      </a>

      <div style="margin-top:20px;font-size:12px;color:#444455">
        Triggered by: ${run.trigger_source} &nbsp;·&nbsp; Run ID: ${run.run_id}
      </div>
    </div>
  `;

  const textBody = `TuneVault installer FAILED on ${run.os.toUpperCase()}.\n\nSHA: ${run.install_sha || 'unknown'}\nFailed probes: ${failedProbes.map(p => `Probe ${p.n} — ${p.error || 'no detail'}`).join(', ')}\n\nStatus page: ${APP_URL}/status/installer`;

  await fetch(`${EMAIL_API_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${POLSIA_API_KEY}` },
    body: JSON.stringify({
      to: ALERT_EMAIL,
      subject,
      body: textBody,
      html: htmlBody,
    }),
  });

  console.log(`[installer-validation] alert sent to ${ALERT_EMAIL} for ${run.os} FAIL`);
}

module.exports = router;
