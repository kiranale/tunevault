/**
 * routes/outreach-lock.js
 *
 * Owns: /admin/outreach-lock — hard-lock control panel and audit log for cold outreach.
 *       /api/admin/outreach-lock/* — JSON API for lock state queries.
 *
 * Does NOT own: email sending logic (routes through services/outreach-mailer),
 *               batch/recipient management, outreach_batches or outreach_send_log.
 *
 * The lock state is determined by OUTREACH_UNLOCK_TOKEN env var (absent = locked).
 * There is no "unlock" button here — operator must set OUTREACH_UNLOCK_TOKEN in Render env vars.
 * This page shows the current state and last 50 attempts.
 */

const express = require('express');
const router = express.Router();
const lockDb = require('../db/outreach-lock');
const { isOutreachLocked } = require('../services/outreach-mailer');

const { requireAdmin, requireAdminPage } = require('../middleware/auth');

// ─── GET /admin/outreach-lock — main lock control page ────────────────────────
router.get('/', requireAdminPage, async (req, res) => {
  const locked = isOutreachLocked();
  const tokenValue = (process.env.OUTREACH_UNLOCK_TOKEN || '').trim();

  let attempts = [];
  let stats = { blocked_count: '0', allowed_count: '0', total_count: '0', last_attempt_at: null };
  let dbError = null;

  try {
    [attempts, stats] = await Promise.all([
      lockDb.getRecentAttempts(50),
      lockDb.getAttemptStats(),
    ]);
  } catch (err) {
    dbError = err.message;
  }

  const fmtTime = (ts) => ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';

  const lockBannerClass = locked ? 'banner-locked' : 'banner-unlocked';
  const lockIcon = locked ? '🔴' : '🟢';
  const lockLabel = locked
    ? 'OUTREACH LOCKED — no external emails will send'
    : `OUTREACH UNLOCKED — token present (${tokenValue.slice(0, 8)}…)`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Outreach Lock — TuneVault Admin</title>
  <script src="/nav-component.js"></script>
  <style>
    :root {
      --accent: #f0a830; --bg: #0a0a0a; --surface: #111; --border: #222;
      --text: #e8e8e8; --muted: #888; --danger: #e53e3e;
      --success: #38a169; --warn: #d69e2e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', -apple-system, sans-serif; font-size: 14px; }
    .page { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 28px; }

    /* Lock state banner */
    .lock-banner { border-radius: 10px; padding: 20px 24px; margin-bottom: 28px; display: flex; align-items: flex-start; gap: 16px; }
    .banner-locked { background: #1a0000; border: 2px solid #7b0000; color: #fc8181; }
    .banner-unlocked { background: #1a2d1a; border: 2px solid #276127; color: #68d391; }
    .lock-banner .lock-icon { font-size: 28px; flex-shrink: 0; line-height: 1; }
    .lock-banner .lock-body { flex: 1; }
    .lock-banner .lock-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
    .lock-banner .lock-detail { font-size: 13px; opacity: 0.85; line-height: 1.5; }
    .lock-banner .lock-action { margin-top: 14px; font-size: 12px; background: rgba(0,0,0,.3); border-radius: 6px; padding: 10px 14px; line-height: 1.7; }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; background: rgba(0,0,0,.4); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

    /* Stats strip */
    .stats-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .stat-card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
    .stat-card .value { font-size: 26px; font-weight: 700; }
    .stat-card.red .value { color: #fc8181; }
    .stat-card.green .value { color: #68d391; }

    /* Attempt log table */
    section { margin-bottom: 40px; }
    section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .log-wrap { max-height: 600px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 10px 12px; background: #161616; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #161616; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .row-blocked td { background: rgba(229,62,62,.04); }
    .row-allowed td { background: rgba(56,161,105,.04); }
    .chip { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
    .chip.blocked { background: #2d1b1b; color: #fc8181; border: 1px solid #7b2020; }
    .chip.allowed { background: #1a2d1a; color: #68d391; border: 1px solid #276127; }

    .empty-state { color: var(--muted); font-size: 13px; padding: 24px; text-align: center; border: 1px dashed #222; border-radius: 8px; }
    .db-error { background: #2d1b1b; border: 1px solid #7b2020; border-radius: 8px; padding: 14px 18px; color: #fc8181; font-size: 13px; margin-bottom: 20px; }

    /* Unlock instructions */
    .unlock-steps { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
    .unlock-steps h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
    .step { display: flex; gap: 12px; margin-bottom: 14px; }
    .step-num { width: 24px; height: 24px; background: #f0a830; color: #0a0a0a; border-radius: 50%; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
    .step-body { font-size: 13px; color: var(--muted); line-height: 1.6; flex: 1; }
    .step-body strong { color: var(--text); }
    .warn-box { background: #1a1200; border: 1px solid #4a3800; border-radius: 8px; padding: 14px 18px; color: #f6ad55; font-size: 13px; margin-top: 16px; line-height: 1.6; }
  </style>
</head>
<body>
<div id="nav-placeholder"></div>
<script>document.addEventListener('DOMContentLoaded', () => { if (window.tvNav) tvNav.init('admin'); });</script>

<div class="page">
  <h1>🔐 Outreach Hard Lock</h1>
  <p class="subtitle">Every cold outreach send attempt is logged here — blocked or allowed. The lock is set by <code>OUTREACH_UNLOCK_TOKEN</code> env var.</p>

  <!-- ── Lock state banner ────────────────────────────────────────────── -->
  <div class="lock-banner ${lockBannerClass}">
    <div class="lock-icon">${lockIcon}</div>
    <div class="lock-body">
      <div class="lock-title">${lockLabel}</div>
      <div class="lock-detail">
        ${locked
          ? 'OUTREACH_UNLOCK_TOKEN is not set. No cold outreach email can leave this system, regardless of batch approval or OUTREACH_SEND_ENABLED.'
          : `OUTREACH_UNLOCK_TOKEN is present. Cold outreach is physically enabled. If you did not intend this, remove the env var in Render immediately.`}
      </div>
      <div class="lock-action">
        ${locked
          ? `<strong>To unlock:</strong> Set <code>OUTREACH_UNLOCK_TOKEN=&lt;any-non-empty-value&gt;</code> in Render → Environment → Add environment variable → Deploy. The lock re-engages the moment you remove the var.<br>
             <strong>To keep locked:</strong> No action needed. This is the default state.`
          : `<strong>To lock immediately:</strong> Remove <code>OUTREACH_UNLOCK_TOKEN</code> from Render → Environment → Deploy. All subsequent outreach attempts will return HTTP 403.`}
      </div>
    </div>
  </div>

  ${dbError ? `<div class="db-error">⚠️ Database error loading attempt log: ${dbError}</div>` : ''}

  <!-- ── Stats strip (last 24h) ───────────────────────────────────────── -->
  <div class="stats-strip">
    <div class="stat-card red">
      <div class="label">Blocked (24h)</div>
      <div class="value">${stats.blocked_count}</div>
    </div>
    <div class="stat-card green">
      <div class="label">Allowed (24h)</div>
      <div class="value">${stats.allowed_count}</div>
    </div>
    <div class="stat-card">
      <div class="label">Total attempts (24h)</div>
      <div class="value">${stats.total_count}</div>
    </div>
    <div class="stat-card">
      <div class="label">Last attempt</div>
      <div class="value" style="font-size:13px;margin-top:4px;color:var(--muted)">${fmtTime(stats.last_attempt_at)}</div>
    </div>
  </div>

  <!-- ── Attempt log ──────────────────────────────────────────────────── -->
  <section>
    <h2>📋 Last 50 Outreach Attempts</h2>
    ${attempts.length === 0
      ? '<div class="empty-state">No outreach attempts recorded. The table will populate on the first attempt (blocked or allowed).</div>'
      : `<div class="log-wrap">
          <table>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>To</th>
                <th>Subject</th>
                <th>Called By</th>
                <th>Result</th>
                <th>Reason</th>
                <th>Token?</th>
              </tr>
            </thead>
            <tbody>
              ${attempts.map(a => {
                const ts = fmtTime(a.attempted_at);
                const blocked = a.blocked;
                const rowClass = blocked ? 'row-blocked' : 'row-allowed';
                const icon = blocked ? '🚫' : '✅';
                return `<tr class="${rowClass}">
                  <td class="mono">${ts}</td>
                  <td>${esc(a.attempted_to || '—')}</td>
                  <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.attempted_subject || '—')}</td>
                  <td class="mono">${esc(a.attempted_by || '—')}</td>
                  <td><span class="chip ${blocked ? 'blocked' : 'allowed'}">${icon} ${blocked ? 'BLOCKED' : 'ALLOWED'}</span></td>
                  <td class="mono">${esc(a.blocked_reason || '—')}</td>
                  <td style="text-align:center">${a.unlock_token_present ? '✅' : '🔴'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`}
  </section>

  <!-- ── Unlock procedure ─────────────────────────────────────────────── -->
  <section>
    <div class="unlock-steps">
      <h3>🔑 Unlock Procedure (Operator Only)</h3>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <strong>Generate a token.</strong> Use any random string: <code>openssl rand -hex 16</code>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <strong>Set it in Render.</strong> Go to your TuneVault service → Environment → add <code>OUTREACH_UNLOCK_TOKEN=&lt;your-value&gt;</code> → Save Changes → Deploy.
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <strong>Verify here.</strong> Reload this page. The banner should turn green. Outreach can now be triggered through the approval gate.
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-body">
          <strong>Re-lock when done.</strong> Remove <code>OUTREACH_UNLOCK_TOKEN</code> from Render env vars → Deploy. Lock re-engages immediately on next request.
        </div>
      </div>
      <div class="warn-box">
        ⚠️ <strong>The lock is the default.</strong> If <code>OUTREACH_UNLOCK_TOKEN</code> is not set, outreach is hard-blocked — no code path can bypass this. Every blocked attempt is logged in the table above.
      </div>
    </div>
  </section>
</div>

</body>
</html>`);

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});

// ─── API: GET /api/admin/outreach-lock/status ──────────────────────────────────
router.get('/api/status', requireAdmin, async (req, res) => {
  const locked = isOutreachLocked();
  let stats = null;
  try {
    stats = await lockDb.getAttemptStats();
  } catch (_) {}

  res.json({
    locked,
    unlock_token_present: !locked,
    stats,
  });
});

// ─── API: GET /api/admin/outreach-lock/attempts ────────────────────────────────
router.get('/api/attempts', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const attempts = await lockDb.getRecentAttempts(limit);
    res.json({ attempts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
