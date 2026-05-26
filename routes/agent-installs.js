/**
 * routes/agent-installs.js — Admin view of install failures reported by install.sh.
 *
 * Owns: /admin/agent-installs (HTML page), /api/admin/agent-installs (JSON list).
 * Does NOT own: install failure ingestion (routes/agent.js POST /api/agent/install-failures),
 *               agent_tunnels, oracle_connections, or any health check logic.
 *
 * Mounted at: '/admin' + '/api/admin' in server.js (admin-only).
 */

'use strict';

const express = require('express');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');
const db = require('../db/agent-install-failures');

const router = express.Router();

// ── GET /admin/agent-installs ─────────────────────────────────────────────
// Server-rendered admin page: table of recent install failures with journalctl tails.

router.get('/agent-installs', requireAdminPage, async (req, res) => {
  try {
    const failures = await db.getRecentFailures(200);
    const rows = failures.map(f => {
      const ageMin = Math.floor((Date.now() - new Date(f.created_at).getTime()) / 60000);
      const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-family:monospace;font-size:12px;white-space:nowrap">${escHtml(ageStr)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-family:monospace;font-size:12px">${escHtml(f.host || '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-size:12px">
            ${f.error_class === 'systemd_failed'   ? '<span style="color:#f87171">systemd failed</span>'
            : f.error_class === 'no_heartbeat'      ? '<span style="color:#fbbf24">no heartbeat</span>'
            : f.error_class === 'module_import_error' ? '<span style="color:#f87171">ModuleNotFoundError</span>'
            : escHtml(f.error_class || '—')}
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-size:12px;color:#9ca3af">${escHtml(f.connection_name || String(f.connection_id || '—'))}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-size:12px;color:#9ca3af">${escHtml(f.os_info || '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-size:12px;color:#9ca3af">${escHtml(f.installer_version || '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a">
            ${f.journalctl_tail ? `<details><summary style="cursor:pointer;font-size:11px;color:#60a5fa">journalctl (${f.journalctl_tail.split('\\n').length} lines)</summary><pre style="font-size:10px;max-height:200px;overflow:auto;background:#0d0d0d;padding:8px;border-radius:4px;color:#d1fae5">${escHtml(f.journalctl_tail)}</pre></details>` : '<span style="color:#4b5563;font-size:11px">—</span>'}
          </td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Agent Install Failures — TuneVault Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { background:#111; color:#e5e7eb; font-family:system-ui,sans-serif; margin:0; padding:24px; }
    h1 { font-size:20px; font-weight:700; margin:0 0 4px; }
    .sub { color:#9ca3af; font-size:13px; margin-bottom:24px; }
    table { width:100%; border-collapse:collapse; background:#1a1a1a; border-radius:8px; overflow:hidden; }
    th { text-align:left; padding:10px 12px; background:#222; font-size:11px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.05em; border-bottom:1px solid #333; }
    tr:hover td { background:#1f1f1f; }
    .empty { padding:40px; text-align:center; color:#6b7280; font-size:14px; }
    a { color:#60a5fa; text-decoration:none; }
    .back { display:inline-block; margin-bottom:16px; font-size:13px; }
  </style>
</head>
<body>
  <a href="/admin" class="back">← Admin</a>
  <h1>Agent Install Failures</h1>
  <p class="sub">Reported by install.sh when post-install verify fails (systemd crash or no heartbeat). Last 200 rows.</p>
  <table>
    <thead>
      <tr>
        <th>When</th>
        <th>Host</th>
        <th>Failure mode</th>
        <th>Connection</th>
        <th>OS</th>
        <th>Installer</th>
        <th>journalctl</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="7" class="empty">No install failures recorded yet. 🎉</td></tr>`}
    </tbody>
  </table>
</body>
</html>`);
  } catch (err) {
    console.error('[agent-installs] admin page error:', err.message);
    res.status(500).send('Error loading install failures');
  }
});

// ── GET /api/admin/agent-installs ─────────────────────────────────────────
// JSON list for programmatic access / future dashboard widgets.

router.get('/agent-installs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const failures = await db.getRecentFailures(limit);
    res.json({ failures, count: failures.length });
  } catch (err) {
    console.error('[agent-installs] API error:', err.message);
    res.status(500).json({ error: 'Failed to load install failures' });
  }
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
