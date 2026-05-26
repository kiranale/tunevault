/**
 * routes/install-failures.js — Admin triage page for agent install failures.
 *
 * Owns: GET /admin/install-failures (HTML), GET /api/admin/install-failures (paginated JSON),
 *       POST /api/admin/install-failures/:id/resolve (mark resolved),
 *       POST /api/admin/install-failures/ignore-similar (24h mute by class+version),
 *       GET /api/admin/install-failures/export.csv,
 *       POST /api/admin/install-failures/seed-dev (dev-only seed).
 *
 * Does NOT own: failure ingestion (routes/agent.js POST /api/agent/install-failures),
 *               alert gate thresholds (services/install-failure-alerter.js),
 *               agent_tunnels or oracle_connections.
 *
 * Alert rule: when a new (error_class + installer_version) pair hits > 3 distinct
 *             hosts in any 10-minute window, fire one email to OPS_ALERT_EMAIL.
 *             Re-uses mute map to avoid repeat emails within 30 minutes.
 */

'use strict';

const express    = require('express');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');
const db         = require('../db/agent-install-failures');

const router = express.Router();

const APP_URL        = process.env.APP_URL        || 'https://tunevault.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM     || 'TuneVault <noreply@tunevault.app>';
const OPS_EMAIL      = process.env.OPS_ALERT_EMAIL || 'ops@tunevault.app';

// In-memory mute map: key = `${error_class}:${installer_version}`, value = Date expiry.
// v1 — acceptable because this is advisory ops email, not billing-critical.
const mutedPairs = new Map();

// Track last alert-check timestamp per pair to avoid hammering DB.
const alertCheckWindow = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(date) {
  if (!date) return '—';
  const ageMs  = Date.now() - new Date(date).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1)  return 'just now';
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageH   = Math.floor(ageMin / 60);
  if (ageH < 24)   return `${ageH}h ago`;
  return `${Math.floor(ageH / 24)}d ago`;
}

function absTime(date) {
  if (!date) return '';
  return new Date(date).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function errorClassBadge(ec) {
  const badges = {
    systemd_failed:     { label: 'systemd failed',    color: 'red'    },
    no_heartbeat:       { label: 'no heartbeat',       color: 'yellow' },
    module_import_error:{ label: 'module import error',color: 'red'    },
  };
  const b = badges[ec] || { label: ec || '—', color: 'gray' };
  const colorMap = {
    red:    ['#f87171', 'rgba(248,113,113,0.12)'],
    yellow: ['#fbbf24', 'rgba(251,191,36,0.12)'],
    gray:   ['#9898a8', 'rgba(152,152,168,0.12)'],
  };
  const [fg, bg] = colorMap[b.color] || colorMap.gray;
  return `<span class="badge" style="color:${fg};background:${bg}">${escHtml(b.label)}</span>`;
}

/** Fire-and-forget alert email via Resend. Never throws. */
async function maybeSendAlertEmail(errorClass, installerVersion) {
  if (!RESEND_API_KEY) return;

  const muteKey = `${errorClass}:${installerVersion}`;

  // Skip if muted.
  const muteExpiry = mutedPairs.get(muteKey);
  if (muteExpiry && Date.now() < muteExpiry) return;

  // Throttle check to once per 2 minutes per pair.
  const lastCheck = alertCheckWindow.get(muteKey) || 0;
  if (Date.now() - lastCheck < 120_000) return;
  alertCheckWindow.set(muteKey, Date.now());

  // Count distinct hosts in the last 10 minutes for this exact pair.
  let count = 0;
  try {
    count = await db.countDistinctHostsForPair(errorClass, installerVersion, 10);
  } catch (_) { return; }

  if (count <= 3) return;

  // Mute for 30 minutes to avoid email storms.
  mutedPairs.set(muteKey, Date.now() + 30 * 60 * 1000);

  const deepLink = `${APP_URL}/admin/install-failures?error_class=${encodeURIComponent(errorClass)}&installer_version=${encodeURIComponent(installerVersion)}&since=24h`;
  const subject  = `[install-failures] ${errorClass} × ${count} on v${installerVersion}`;
  const html     = `
<div style="font-family:system-ui,sans-serif;color:#1a1a2e;max-width:600px;margin:0 auto">
  <h2 style="color:#dc2626">⚠ Install Failure Spike Detected</h2>
  <p><strong>${count} distinct hosts</strong> reported <code>${escHtml(errorClass)}</code>
     on installer v${escHtml(installerVersion)} in the last 10 minutes.</p>
  <p style="margin:16px 0">
    <a href="${escHtml(deepLink)}"
       style="background:#f0a830;color:#0a0a0c;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block">
      Triage Now →
    </a>
  </p>
  <p style="color:#6b7280;font-size:12px">TuneVault ops alert · ${new Date().toUTCString()}</p>
</div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body   : JSON.stringify({ from: FROM_ADDRESS, to: OPS_EMAIL, subject, html, text: `${count} hosts hit ${errorClass} on v${installerVersion}. Triage: ${deepLink}` }),
    });
  } catch (_) { /* soft-fail — ops email is advisory */ }
}

// ── GET /admin/install-failures — full page ────────────────────────────────

router.get('/install-failures', requireAdminPage, async (req, res) => {
  try {
    const [stats, errorClasses, versions] = await Promise.all([
      db.getStats(),
      db.getDistinctErrorClasses(),
      db.getDistinctVersions(),
    ]);

    // Seed dev rows in non-prod so page is testable before real failures land.
    if (process.env.NODE_ENV !== 'production') {
      db.seedDevRows().catch(() => {});
    }

    const ecOptions  = errorClasses.map(ec => `<option value="${escHtml(ec)}">${escHtml(ec)}</option>`).join('');
    const verOptions = versions.map(v   => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');

    const stats24h    = parseInt(stats.failures_24h    || 0, 10);
    const stats7d     = parseInt(stats.failures_7d     || 0, 10);
    const statsHosts  = parseInt(stats.unique_hosts_24h|| 0, 10);
    const topClass    = stats.top_error_class || 'none';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Install Failures — TuneVault Admin</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
    :root {
      --bg:#0a0a0c; --surface:#111114; --surface-2:#1a1a1f; --border:#2a2a30;
      --text:#e8e8ed; --text-dim:#9898a8; --accent:#f0a830; --accent-dim:rgba(240,168,48,.12);
      --green:#34d399; --green-dim:rgba(52,211,153,.12); --red:#f87171; --red-dim:rgba(248,113,113,.12);
      --yellow:#fbbf24; --yellow-dim:rgba(251,191,36,.12); --blue:#60a5fa; --gray:#6b7280;
    }
    body { font-family:'Space Grotesk',-apple-system,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; line-height:1.6; }
    .grain { position:fixed; top:0;left:0;right:0;bottom:0; background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E"); pointer-events:none; z-index:999; }
    nav { display:flex; justify-content:space-between; align-items:center; padding:16px 48px; border-bottom:1px solid var(--border); }
    .logo { font-size:16px;font-weight:700;letter-spacing:-.5px;display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text); }
    .logo-icon { width:26px;height:26px;background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:var(--bg); }
    .nav-right { display:flex;align-items:center;gap:20px; }
    .nav-link { font-size:13px;color:var(--text-dim);text-decoration:none;font-family:'JetBrains Mono',monospace;transition:color .2s; }
    .nav-link:hover { color:var(--accent); }
    .container { max-width:1400px;margin:0 auto;padding:40px 48px 80px; }
    .page-header { display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;gap:20px; }
    .page-header h1 { font-size:26px;font-weight:700;letter-spacing:-1px; }
    .header-sub { font-size:13px;color:var(--text-dim);margin-top:4px; }
    .header-actions { display:flex;align-items:center;gap:10px;flex-shrink:0; }
    .btn { font-size:12px;color:var(--text-dim);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 14px;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all .2s;display:inline-flex;align-items:center;gap:6px;text-decoration:none; }
    .btn:hover { border-color:var(--accent);color:var(--accent); }
    .btn.export { color:var(--green);border-color:rgba(52,211,153,.3); }
    .btn.export:hover { border-color:var(--green);background:var(--green-dim); }
    /* Stats */
    .stats-row { display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px; }
    .stat-card { background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 20px; }
    .stat-label { font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-dim);margin-bottom:8px; }
    .stat-count { font-size:28px;font-weight:700;letter-spacing:-1px; }
    .stat-count.red { color:var(--red); } .stat-count.yellow { color:var(--yellow); }
    .stat-count.green { color:var(--green); } .stat-count.accent { color:var(--accent); }
    .stat-count.gray { color:var(--text-dim); }
    .stat-sub { font-size:11px;color:var(--text-dim);margin-top:4px; }
    /* Filters */
    .filters-bar { display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;align-items:center; }
    .filter-input { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 14px;font-size:13px;font-family:'Space Grotesk',sans-serif;color:var(--text);outline:none;transition:border-color .2s;min-width:200px; }
    .filter-input:focus { border-color:var(--accent); }
    .filter-input::placeholder { color:var(--text-dim); }
    .filter-select { background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 14px;font-size:13px;font-family:'Space Grotesk',sans-serif;color:var(--text);outline:none;cursor:pointer;transition:border-color .2s; }
    .filter-select:focus { border-color:var(--accent); }
    .filter-clear { font-size:12px;color:var(--text-dim);background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:4px;transition:color .2s;font-family:'Space Grotesk',sans-serif; }
    .filter-clear:hover { color:var(--red); }
    /* Table */
    .table-wrap { background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;overflow-x:auto; }
    table { width:100%;border-collapse:collapse;min-width:1100px; }
    thead th { text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-dim);padding:12px 16px;border-bottom:1px solid var(--border);font-weight:500;background:var(--surface-2);white-space:nowrap; }
    tbody tr { border-bottom:1px solid rgba(42,42,48,.5);transition:background .15s; }
    tbody tr:last-child { border-bottom:none; }
    tbody tr:hover { background:rgba(26,26,31,.7); }
    tbody tr.resolved { opacity:.45; }
    td { padding:12px 16px;font-size:13px;vertical-align:middle; }
    td.mono { font-family:'JetBrains Mono',monospace;font-size:12px; }
    .badge { font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:3px 10px;border-radius:100px;display:inline-block;white-space:nowrap; }
    .action-btn { font-size:11px;color:var(--text-dim);background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:4px 10px;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all .2s; }
    .action-btn:hover { border-color:var(--accent);color:var(--accent); }
    .action-btn.resolve { color:var(--green); border-color:rgba(52,211,153,.3); }
    .action-btn.resolve:hover { background:var(--green-dim); border-color:var(--green); }
    .action-btn.mute { color:var(--yellow); border-color:rgba(251,191,36,.3); }
    .action-btn.mute:hover { background:var(--yellow-dim); border-color:var(--yellow); }
    .action-btn.view { color:var(--blue); border-color:rgba(96,165,250,.3); }
    .action-btn.view:hover { background:rgba(96,165,250,.1); border-color:var(--blue); }
    .actions-cell { display:flex;gap:6px;align-items:center;flex-wrap:wrap; }
    .pagination { display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;color:var(--text-dim); }
    .pag-btns { display:flex;gap:8px; }
    .empty { padding:60px;text-align:center;color:var(--text-dim);font-size:14px; }
    /* Modal */
    .modal-overlay { display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center; }
    .modal-overlay.open { display:flex; }
    .modal { background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(820px,95vw);max-height:85vh;display:flex;flex-direction:column; }
    .modal-header { display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border); }
    .modal-header h3 { font-size:15px;font-weight:600; }
    .modal-close { background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:20px;line-height:1;padding:4px; }
    .modal-close:hover { color:var(--text); }
    .modal-body { padding:16px 20px;overflow-y:auto;flex:1; }
    .modal-footer { display:flex;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border);gap:10px; }
    .log-pre { font-family:'JetBrains Mono',monospace;font-size:11px;background:#0d0d0f;border:1px solid var(--border);border-radius:6px;padding:14px;max-height:400px;overflow:auto;color:#d1fae5;white-space:pre-wrap;word-break:break-all; }
    .toast { position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 18px;font-size:13px;z-index:9999;opacity:0;transform:translateY(8px);transition:all .3s;pointer-events:none; }
    .toast.show { opacity:1;transform:translateY(0); }
    .toast.success { border-color:rgba(52,211,153,.5);color:var(--green); }
    .toast.error   { border-color:rgba(248,113,113,.5);color:var(--red); }
    a { color:var(--blue);text-decoration:none; } a:hover { text-decoration:underline; }
    .rel-time { cursor:default;border-bottom:1px dashed var(--border); }
  </style>
</head>
<body>
<div class="grain"></div>
<nav>
  <a href="/admin" class="logo">
    <div class="logo-icon">TV</div>
    Admin
  </a>
  <div class="nav-right">
    <a href="/admin/agents" class="nav-link">Agents</a>
    <a href="/admin/users" class="nav-link">Users</a>
    <a href="/admin/install-failures" class="nav-link active">Install Failures</a>
  </div>
</nav>

<div class="container">
  <div class="page-header">
    <div>
      <h1>Install Failures</h1>
      <div class="header-sub">Failed agent installs reported by install.sh after post-install verify fails.</div>
    </div>
    <div class="header-actions">
      <a href="/api/admin/install-failures/export.csv" class="btn export" id="exportBtn">
        <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 15V3m0 12l-4-4m4 4l4-4M3 21h18"/></svg>
        Export CSV
      </a>
    </div>
  </div>

  <!-- Stats strip -->
  <div class="stats-row">
    <div class="stat-card">
      <div class="stat-label">Failures (24h)</div>
      <div class="stat-count ${stats24h > 0 ? 'red' : 'green'}" id="stat24h">${stats24h}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Failures (7d)</div>
      <div class="stat-count ${stats7d > 5 ? 'yellow' : stats7d > 0 ? 'accent' : 'green'}" id="stat7d">${stats7d}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Unique Hosts (24h)</div>
      <div class="stat-count ${statsHosts > 2 ? 'red' : statsHosts > 0 ? 'yellow' : 'green'}" id="statHosts">${statsHosts}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Most Common Error (24h)</div>
      <div class="stat-count accent" id="statTopClass" style="font-size:16px;letter-spacing:-.5px">${escHtml(topClass)}</div>
    </div>
  </div>

  <!-- Filters -->
  <div class="filters-bar">
    <input type="text" class="filter-input" id="qInput" placeholder="Search host or IP…" value="">
    <select class="filter-select" id="ecFilter">
      <option value="">All error classes</option>
      ${ecOptions}
    </select>
    <select class="filter-select" id="verFilter">
      <option value="">All versions</option>
      ${verOptions}
    </select>
    <select class="filter-select" id="sinceFilter">
      <option value="24h">Last 24h</option>
      <option value="7d">Last 7d</option>
      <option value="30d">Last 30d</option>
      <option value="all">All time</option>
    </select>
    <button class="filter-clear" id="clearFilters">Clear filters</button>
  </div>

  <!-- Table -->
  <div class="table-wrap">
    <table id="failuresTable">
      <thead>
        <tr>
          <th>Created</th>
          <th>Host</th>
          <th>IP</th>
          <th>OS</th>
          <th>Error Class</th>
          <th>Version</th>
          <th>Connection</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="8" class="empty">Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  <div class="pagination" id="pagination">
    <span id="pagInfo"></span>
    <div class="pag-btns">
      <button class="btn" id="prevBtn" disabled>← Prev</button>
      <button class="btn" id="nextBtn" disabled>Next →</button>
    </div>
  </div>
</div>

<!-- journalctl Modal -->
<div class="modal-overlay" id="logModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="logModalTitle">journalctl output</h3>
      <button class="modal-close" id="logModalClose">×</button>
    </div>
    <div class="modal-body">
      <pre class="log-pre" id="logModalContent"></pre>
    </div>
    <div class="modal-footer">
      <button class="btn" id="logCopyBtn">Copy to clipboard</button>
      <button class="btn" id="logModalCloseBtn">Close</button>
    </div>
  </div>
</div>

<!-- Toast notification -->
<div class="toast" id="toast"></div>

<script>
const PAGE_SIZE = 50;
let page        = 0;
let totalCount  = 0;
let currentRows = [];

function qp(k) { return new URLSearchParams(location.search).get(k) || ''; }

const qInput      = document.getElementById('qInput');
const ecFilter    = document.getElementById('ecFilter');
const verFilter   = document.getElementById('verFilter');
const sinceFilter = document.getElementById('sinceFilter');

// Pre-fill filters from URL params (allows deep-linking from alert emails)
const initEc   = qp('error_class');
const initVer  = qp('installer_version');
const initSince= qp('since');
if (initEc   ) ecFilter.value    = initEc;
if (initVer  ) verFilter.value   = initVer;
if (initSince) sinceFilter.value = initSince;

function buildQuery() {
  const p = new URLSearchParams();
  if (qInput.value.trim())    p.set('q',                 qInput.value.trim());
  if (ecFilter.value)         p.set('error_class',       ecFilter.value);
  if (verFilter.value)        p.set('installer_version', verFilter.value);
  if (sinceFilter.value)      p.set('since',             sinceFilter.value);
  p.set('limit',  PAGE_SIZE);
  p.set('offset', page * PAGE_SIZE);
  return p.toString();
}

async function loadRows() {
  document.getElementById('tableBody').innerHTML = '<tr><td colspan="8" class="empty">Loading…</td></tr>';
  try {
    const resp = await fetch('/api/admin/install-failures?' + buildQuery());
    const data = await resp.json();
    totalCount  = data.total || 0;
    currentRows = data.failures || [];
    renderTable(currentRows);
    renderPagination();
  } catch (e) {
    document.getElementById('tableBody').innerHTML = '<tr><td colspan="8" class="empty" style="color:var(--red)">Failed to load data.</td></tr>';
  }
}

function renderTable(rows) {
  if (!rows.length) {
    document.getElementById('tableBody').innerHTML = '<tr><td colspan="8" class="empty">No failures match the current filters. 🎉</td></tr>';
    return;
  }
  document.getElementById('tableBody').innerHTML = rows.map(r => {
    const isResolved = !!r.resolved_at;
    const connLink   = r.connection_id
      ? '<a href="/connections/' + r.connection_id + '">' + esc(r.connection_name || '#' + r.connection_id) + '</a>'
      : '<span style="color:var(--text-dim)">—</span>';
    const ipText     = r.ip_address || '—';
    const relT       = relativeTime(r.created_at);
    const absT       = absTime(r.created_at);
    const errorBadge = errorClassBadge(r.error_class);
    return \`<tr class="\${isResolved ? 'resolved' : ''}" data-id="\${r.id}">
      <td class="mono"><span class="rel-time" title="\${esc(absT)}">\${esc(relT)}</span></td>
      <td class="mono">\${esc(r.host || '—')}</td>
      <td class="mono" style="color:var(--text-dim)">\${esc(ipText)}</td>
      <td style="color:var(--text-dim);font-size:12px">\${esc(r.os_info || '—')}</td>
      <td>\${errorBadge}</td>
      <td class="mono" style="color:var(--text-dim)">\${esc(r.installer_version || '—')}</td>
      <td>\${connLink}</td>
      <td>
        <div class="actions-cell">
          \${r.journalctl_tail ? '<button class="action-btn view" onclick="openLog(' + r.id + ')">View journalctl</button>' : ''}
          \${!isResolved ? '<button class="action-btn resolve" onclick="resolveRow(' + r.id + ')">Resolved</button>' : '<span style="color:var(--green);font-size:11px">✓ Resolved</span>'}
          \${r.error_class && r.installer_version ? '<button class="action-btn mute" onclick="ignoreSimilar(\`' + esc(r.error_class) + '\`,\`' + esc(r.installer_version) + '\`)">Ignore similar</button>' : ''}
        </div>
      </td>
    </tr>\`;
  }).join('');
}

function renderPagination() {
  const start = page * PAGE_SIZE + 1;
  const end   = Math.min((page + 1) * PAGE_SIZE, totalCount);
  document.getElementById('pagInfo').textContent = totalCount > 0
    ? \`Showing \${start}–\${end} of \${totalCount}\`
    : 'No results';
  document.getElementById('prevBtn').disabled = page === 0;
  document.getElementById('nextBtn').disabled = end >= totalCount;
}

function relativeTime(d) {
  if (!d) return '—';
  const ageMs  = Date.now() - new Date(d).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1)  return 'just now';
  if (ageMin < 60) return ageMin + 'm ago';
  const ageH   = Math.floor(ageMin / 60);
  if (ageH < 24)   return ageH + 'h ago';
  return Math.floor(ageH / 24) + 'd ago';
}

function absTime(d) {
  if (!d) return '';
  return new Date(d).toISOString().replace('T',' ').replace(/\\.\\d{3}Z$/,' UTC');
}

function errorClassBadge(ec) {
  const map = {
    systemd_failed:     ['#f87171','rgba(248,113,113,0.12)','systemd failed'],
    no_heartbeat:       ['#fbbf24','rgba(251,191,36,0.12)','no heartbeat'],
    module_import_error:['#f87171','rgba(248,113,113,0.12)','module import error'],
  };
  const [fg,bg,label] = map[ec] || ['#9898a8','rgba(152,152,168,0.12)', ec || '—'];
  return \`<span class="badge" style="color:\${fg};background:\${bg}">\${esc(label)}</span>\`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Log modal ─────────────────────────────────────────────────────────────────

function openLog(id) {
  const row = currentRows.find(r => r.id === id);
  if (!row) return;
  document.getElementById('logModalTitle').textContent = 'journalctl — ' + (row.host || 'unknown');
  document.getElementById('logModalContent').textContent = row.journalctl_tail || '(no output)';
  document.getElementById('logModal').classList.add('open');
}

document.getElementById('logModalClose').onclick    = () => document.getElementById('logModal').classList.remove('open');
document.getElementById('logModalCloseBtn').onclick = () => document.getElementById('logModal').classList.remove('open');
document.getElementById('logModal').onclick = (e) => { if (e.target === document.getElementById('logModal')) e.target.classList.remove('open'); };

document.getElementById('logCopyBtn').onclick = async () => {
  const text = document.getElementById('logModalContent').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch (_) { showToast('Copy failed', 'error'); }
};

// ── Row actions ───────────────────────────────────────────────────────────────

async function resolveRow(id) {
  try {
    const r = await fetch(\`/api/admin/install-failures/\${id}/resolve\`, { method:'POST' });
    if (!r.ok) throw new Error(await r.text());
    showToast('Marked resolved', 'success');
    const row = currentRows.find(x => x.id === id);
    if (row) row.resolved_at = new Date().toISOString();
    renderTable(currentRows);
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function ignoreSimilar(errorClass, installerVersion) {
  try {
    const r = await fetch('/api/admin/install-failures/ignore-similar', {
      method: 'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ error_class: errorClass, installer_version: installerVersion }),
    });
    if (!r.ok) throw new Error(await r.text());
    showToast(\`Muted \${errorClass} × v\${installerVersion} for 24h\`, 'success');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + (type || '');
  setTimeout(() => { t.className = 'toast'; }, 3000);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

let debounceTimer;
qInput.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => { page=0; loadRows(); }, 350); });
ecFilter.addEventListener('change',    () => { page=0; loadRows(); });
verFilter.addEventListener('change',   () => { page=0; loadRows(); });
sinceFilter.addEventListener('change', () => { page=0; loadRows(); });

document.getElementById('clearFilters').onclick = () => {
  qInput.value=''; ecFilter.value=''; verFilter.value=''; sinceFilter.value='24h';
  page=0; loadRows();
};

document.getElementById('prevBtn').onclick = () => { if (page>0){ page--; loadRows(); } };
document.getElementById('nextBtn').onclick = () => { page++; loadRows(); };

// CSV export — just navigate, server streams the file
document.getElementById('exportBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const qs = new URLSearchParams();
  if (qInput.value.trim())  qs.set('q',                 qInput.value.trim());
  if (ecFilter.value)       qs.set('error_class',       ecFilter.value);
  if (verFilter.value)      qs.set('installer_version', verFilter.value);
  if (sinceFilter.value)    qs.set('since',             sinceFilter.value);
  window.location.href = '/api/admin/install-failures/export.csv?' + qs.toString();
});

// Initial load
loadRows();
</script>
</body>
</html>`);
  } catch (err) {
    console.error('[install-failures] page error:', err.message);
    res.status(500).send('Error loading install failures page');
  }
});

// ── GET /api/admin/install-failures — paginated JSON ──────────────────────────

router.get('/install-failures', requireAdmin, async (req, res) => {
  try {
    const errorClass        = sanitize(req.query.error_class);
    const installerVersion  = sanitize(req.query.installer_version);
    const since             = ['24h','7d','30d','all'].includes(req.query.since) ? req.query.since : '24h';
    const q                 = sanitize(req.query.q);
    const limit             = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset            = Math.max(parseInt(req.query.offset || '0',  10), 0);

    const filter = { errorClass, installerVersion, since, q, limit, offset };
    const [failures, total] = await Promise.all([
      db.getFilteredFailures(filter),
      db.countFilteredFailures(filter),
    ]);

    // Fire alert check in background — never block the response.
    if (failures.length) {
      const ec  = failures[0].error_class;
      const ver = failures[0].installer_version;
      if (ec && ver) maybeSendAlertEmail(ec, ver).catch(() => {});
    }

    res.json({ failures, total, limit, offset });
  } catch (err) {
    console.error('[install-failures] API error:', err.message);
    res.status(500).json({ error: 'Failed to load install failures' });
  }
});

// ── POST /api/admin/install-failures/:id/resolve ──────────────────────────────

router.post('/install-failures/:id/resolve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await db.resolveFailure(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[install-failures] resolve error:', err.message);
    res.status(500).json({ error: 'Failed to resolve' });
  }
});

// ── POST /api/admin/install-failures/ignore-similar ───────────────────────────
// Adds error_class + installer_version to 24h server-side mute list.

router.post('/install-failures/ignore-similar', requireAdmin, (req, res) => {
  const { error_class, installer_version } = req.body || {};
  if (!error_class || typeof error_class !== 'string') {
    return res.status(400).json({ error: 'error_class required' });
  }
  const key = `${sanitize(error_class)}:${sanitize(installer_version || '')}`;
  mutedPairs.set(key, Date.now() + 24 * 60 * 60 * 1000);
  res.json({ ok: true, muted_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
});

// ── GET /api/admin/install-failures/export.csv ────────────────────────────────

router.get('/install-failures/export.csv', requireAdmin, async (req, res) => {
  try {
    const errorClass       = sanitize(req.query.error_class);
    const installerVersion = sanitize(req.query.installer_version);
    const since            = ['24h','7d','30d','all'].includes(req.query.since) ? req.query.since : 'all';
    const q                = sanitize(req.query.q);

    // Export up to 10 000 rows.
    const failures = await db.getFilteredFailures({ errorClass, installerVersion, since, q, limit: 10000, offset: 0 });

    const csvEsc = (s) => {
      if (s === null || s === undefined) return '';
      const str = String(s).replace(/"/g, '""');
      return /[,"\n\r]/.test(str) ? `"${str}"` : str;
    };

    const header = ['id','created_at','resolved_at','host','ip_address','os_info','error_class','installer_version','connection_id','connection_name'];
    const lines  = [
      header.join(','),
      ...failures.map(r =>
        header.map(k => csvEsc(r[k])).join(',')
      ),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="install-failures-${Date.now()}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('[install-failures] CSV error:', err.message);
    res.status(500).send('Export failed');
  }
});

// ── POST /api/admin/install-failures/seed-dev (dev only) ─────────────────────

router.post('/install-failures/seed-dev', requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Seed disabled in production' });
  }
  try {
    await db.seedDevRows();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip non-printable chars to prevent injection into parameterised queries. */
function sanitize(val) {
  if (!val || typeof val !== 'string') return '';
  return val.replace(/[^\x20-\x7E]/g, '').slice(0, 256);
}

module.exports = router;
