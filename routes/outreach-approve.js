/**
 * routes/outreach-approve.js
 *
 * Owns: /admin/outreach/approve — operator approval UI and send-trigger API.
 *       /admin/outreach/approve/api/* — JSON endpoints for the approve page.
 *
 * Does NOT own: email sending logic (routes through services/outreach-mailer),
 *               batch/recipient creation, audit log display (/admin/outreach/audit).
 *
 * All routes require admin session. No cron or auto-trigger here.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/outreach');
const { sendOutreachEmail } = require('../services/outreach-mailer');
const { requireAdmin, requireAdminPage } = require("../middleware/auth");

// ─── GET /admin/outreach/approve — main approval UI ───────────────────────────
router.get('/', requireAdminPage, async (req, res) => {
  const outreachEnabled = process.env.OUTREACH_SEND_ENABLED === 'true';

  let batches = [];
  let recentLog = [];
  let fetchError = null;

  try {
    [batches, recentLog] = await Promise.all([
      db.listBatches(),
      db.getRecentSendLog(100),
    ]);
  } catch (err) {
    fetchError = err.message;
  }

  const pendingBatches = batches.filter(b => b.approval_status === 'PENDING');
  const approvedBatches = batches.filter(b => b.approval_status === 'APPROVED');
  const otherBatches = batches.filter(b => !['PENDING', 'APPROVED'].includes(b.approval_status));

  // Format send log for display
  const logRows = recentLog.map(row => {
    const ts = new Date(row.attempted_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const allowed = row.gate_result === 'ALLOWED';
    return {
      ...row,
      ts,
      allowed,
      css: allowed ? 'log-allowed' : 'log-blocked',
      icon: allowed ? '✅' : '🚫',
    };
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Outreach Approval — TuneVault Admin</title>
  <script src="/nav-component.js"></script>
  <style>
    :root {
      --accent: #f0a830; --bg: #0a0a0a; --surface: #111; --border: #222;
      --text: #e8e8e8; --muted: #888; --danger: #e53e3e; --warn: #d69e2e;
      --success: #38a169; --blocked: #fc8181;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', -apple-system, sans-serif; font-size: 14px; }
    .page { max-width: 1100px; margin: 0 auto; padding: 40px 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
    .flag-banner { border-radius: 8px; padding: 14px 20px; margin-bottom: 28px; display: flex; align-items: center; gap: 14px; font-size: 13px; }
    .flag-banner.disabled { background: #1a0000; border: 2px solid #7b0000; color: #fc8181; }
    .flag-banner.enabled { background: #1a2d1a; border: 2px solid #276127; color: #68d391; }
    .flag-banner strong { font-size: 15px; }
    .flag-banner .flag-code { font-family: monospace; font-size: 12px; background: rgba(0,0,0,.4); padding: 2px 8px; border-radius: 4px; }
    section { margin-bottom: 40px; }
    section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
    .badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; font-weight: 600; }
    .badge.pending { background: #2d2000; color: #f6ad55; border: 1px solid #7b5000; }
    .badge.approved { background: #1a2d1a; color: #68d391; border: 1px solid #276127; }
    .badge.rejected { background: #2d1b1b; color: #fc8181; border: 1px solid #7b2020; }
    .badge.sent { background: #1a1a2d; color: #90cdf4; border: 1px solid #2a4080; }
    .badge.cancelled { background: #1a1a1a; color: #888; border: 1px solid #333; }
    .batch-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .batch-card.approved { border-color: #276127; }
    .batch-card .batch-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .batch-card .batch-name { font-size: 16px; font-weight: 600; flex: 1; }
    .batch-card .meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
    .batch-card .template-preview { background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 6px; padding: 12px; font-size: 12px; color: #ccc; margin-bottom: 14px; }
    .batch-card .template-preview strong { color: var(--text); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; display: block; margin-bottom: 4px; color: var(--muted); }
    .batch-card .recipients-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-bottom: 14px; }
    .recipient-pill { background: #141414; border: 1px solid #222; border-radius: 6px; padding: 8px 10px; font-size: 12px; }
    .recipient-pill .r-email { font-weight: 500; color: var(--text); }
    .recipient-pill .r-name { color: var(--muted); font-size: 11px; }
    .recipient-pill.auth { border-color: #276127; }
    .recipient-pill.sent { border-color: #2a4080; opacity: .7; }
    .approve-form { border-top: 1px solid #1e1e1e; padding-top: 16px; }
    .approve-form label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 6px; }
    .approve-form input[type="text"] {
      width: 100%; background: #0d0d0d; border: 1px solid #333; color: var(--text);
      padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 10px;
    }
    .approve-form input[type="text"]:focus { outline: none; border-color: var(--danger); }
    .btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; border: none; cursor: pointer; transition: opacity 0.15s; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-approve { background: var(--danger); color: white; }
    .btn-approve:hover:not(:disabled) { opacity: 0.88; }
    .btn-reject { background: #1e1e1e; color: var(--muted); border: 1px solid #333; margin-left: 8px; }
    .btn-reject:hover { border-color: var(--danger); color: var(--danger); }
    .btn-send { background: var(--success); color: white; }
    .btn-send:hover:not(:disabled) { opacity: 0.88; }
    .countdown { font-size: 12px; color: var(--warn); margin-left: 8px; }
    .empty-state { color: var(--muted); font-size: 13px; padding: 20px; border: 1px dashed #222; border-radius: 8px; text-align: center; }
    /* Log table */
    .log-table-wrap { max-height: 500px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 10px 12px; background: #161616; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #161616; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .log-allowed td { background: rgba(56,161,105,.04); }
    .log-blocked td { background: rgba(229,62,62,.04); }
    .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--muted); }
    .toast { position: fixed; bottom: 24px; right: 24px; background: #1a2d1a; border: 1px solid #276127; color: #68d391; padding: 12px 18px; border-radius: 8px; font-size: 13px; display: none; z-index: 9999; }
    .toast.error { background: #2d1b1b; border-color: #7b2020; color: #fc8181; }
    .approval-info { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
    .approval-info .ai { color: var(--warn); }
    .stats-row { display: flex; gap: 12px; margin-bottom: 16px; }
    .stat-chip { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 14px; font-size: 12px; }
    .stat-chip span { font-weight: 700; color: var(--text); margin-right: 4px; }
  </style>
</head>
<body>
<div id="nav-placeholder"></div>
<script>document.addEventListener('DOMContentLoaded', () => { if (window.tvNav) tvNav.init('admin'); });</script>

<div class="page">
  <h1>🔐 Outreach Approval</h1>
  <p class="subtitle">Every outbound prospect email must pass through here. No batch is sent without operator approval.</p>

  <!-- Global flag state -->
  <div class="flag-banner ${outreachEnabled ? 'enabled' : 'disabled'}">
    <div style="flex:1">
      <strong>${outreachEnabled ? '🟢 OUTREACH_SEND_ENABLED = true' : '🔴 OUTREACH_SEND_ENABLED = false (kill-switch active)'}</strong><br>
      <span style="font-size:12px;margin-top:4px;display:block">
        ${outreachEnabled
          ? 'The global kill-switch is OFF — approved batches can send. To disable: set OUTREACH_SEND_ENABLED=false in Render env vars.'
          : 'No email can leave while this flag is false, regardless of batch approval status. Set OUTREACH_SEND_ENABLED=true in Render env vars to enable.'}
      </span>
    </div>
    <span class="flag-code">process.env.OUTREACH_SEND_ENABLED = "${process.env.OUTREACH_SEND_ENABLED ?? '(unset)'}"</span>
  </div>

  ${fetchError ? `<div style="background:#2d1b1b;border:1px solid #7b2020;border-radius:8px;padding:16px;margin-bottom:24px;color:#fc8181;font-size:13px">⚠️ DB error: ${fetchError}</div>` : ''}

  <!-- ── Pending batches ─────────────────────────────────────────────── -->
  <section>
    <h2>⏳ Pending Approval <span class="badge pending">${pendingBatches.length}</span></h2>
    ${pendingBatches.length === 0
      ? '<div class="empty-state">No batches awaiting approval.</div>'
      : pendingBatches.map(b => renderBatchCard(b, 'pending', req.session.user)).join('')}
  </section>

  <!-- ── Approved batches (ready to send) ───────────────────────────── -->
  <section>
    <h2>✅ Approved — Ready to Send <span class="badge approved">${approvedBatches.length}</span></h2>
    ${approvedBatches.length === 0
      ? '<div class="empty-state">No currently approved batches.</div>'
      : approvedBatches.map(b => renderBatchCard(b, 'approved', req.session.user)).join('')}
  </section>

  <!-- ── Other batches ──────────────────────────────────────────────── -->
  ${otherBatches.length > 0 ? `
  <section>
    <h2>📁 Past Batches</h2>
    ${otherBatches.map(b => renderBatchCard(b, 'other', req.session.user)).join('')}
  </section>` : ''}

  <!-- ── Send log ───────────────────────────────────────────────────── -->
  <section>
    <h2>📋 Send Attempt Log <span style="font-size:12px;color:var(--muted);font-weight:400">(last 100)</span></h2>
    ${logRows.length === 0
      ? '<div class="empty-state">No send attempts recorded yet.</div>'
      : `<div class="log-table-wrap">
        <table>
          <thead>
            <tr><th>Time (UTC)</th><th>Batch</th><th>Recipient</th><th>Result</th><th>Reason</th><th>Gate</th><th>Message ID</th></tr>
          </thead>
          <tbody>
            ${logRows.map(r => `
            <tr class="${r.css}">
              <td class="mono">${r.ts}</td>
              <td>${r.batch_name || (r.batch_id ? '#' + r.batch_id : '—')}</td>
              <td>${r.recipient_email || '—'}</td>
              <td>${r.icon} ${r.gate_result}</td>
              <td><span style="font-family:monospace;font-size:11px">${r.blocked_reason || '—'}</span></td>
              <td class="mono">${r.gate_failed || '—'}</td>
              <td class="mono">${r.postmark_message_id || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
  </section>
</div>

<div id="toast" class="toast"></div>

<script>
// ─── Approve batch ────────────────────────────────────────────────────────────
function setupApprove(batchId, batchName) {
  const form = document.getElementById('approve-form-' + batchId);
  if (!form) return;
  const input = form.querySelector('.confirm-input');
  const btn = form.querySelector('.btn-approve');

  input.addEventListener('input', () => {
    btn.disabled = input.value.trim() !== batchName;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim() !== batchName) return;
    btn.disabled = true;
    btn.textContent = '⏳ Approving…';

    try {
      const r = await fetch('/admin/outreach/approve/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ batchId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Unknown error');
      showToast('✅ Batch approved — 60-minute send window open.', false);
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      showToast('❌ ' + err.message, true);
      btn.disabled = false;
      btn.textContent = '🔴 Approve & Open Send Window';
    }
  });
}

// ─── Reject batch ─────────────────────────────────────────────────────────────
async function rejectBatch(batchId) {
  if (!confirm('Reject this batch? It cannot be sent.')) return;
  try {
    const r = await fetch('/admin/outreach/approve/api/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ batchId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');
    showToast('Batch rejected.', false);
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    showToast('❌ ' + err.message, true);
  }
}

// ─── Send next N ─────────────────────────────────────────────────────────────
async function sendNextN(batchId, n) {
  if (!confirm('Send next ' + n + ' email(s) from this batch?')) return;
  const btn = document.getElementById('send-btn-' + batchId);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sending…'; }

  try {
    const r = await fetch('/admin/outreach/approve/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ batchId, count: n }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');
    showToast('✅ Sent ' + (data.sent || 0) + ' email(s). ' + (data.blocked > 0 ? data.blocked + ' blocked.' : ''), false);
    setTimeout(() => location.reload(), 1800);
  } catch (err) {
    showToast('❌ ' + err.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '🔴 Send Next N'; }
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4000);
}

// Init all approve forms
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-batch-id]').forEach(el => {
    setupApprove(el.dataset.batchId, el.dataset.batchName);
  });

  // Countdown timers for approved batches
  document.querySelectorAll('[data-approved-at]').forEach(el => {
    const approvedAt = new Date(el.dataset.approvedAt);
    const expiresAt = new Date(approvedAt.getTime() + 60 * 60 * 1000);
    function tick() {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        el.textContent = '⚠️ Approval expired — refresh to update';
        el.style.color = 'var(--danger)';
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      el.textContent = '⏱ Window expires in ' + m + 'm ' + s + 's';
    }
    tick();
    setInterval(tick, 1000);
  });
});
</script>
</body>
</html>`);

  // ─── Helper: render a batch card ──────────────────────────────────────────
  function renderBatchCard(batch, phase, user) {
    const recCount = parseInt(batch.recipient_count) || 0;
    const authCount = parseInt(batch.authorized_count) || 0;
    const sentCount = parseInt(batch.sent_count) || 0;
    const pendingCount = authCount - sentCount;

    const approvedAt = batch.approved_at ? new Date(batch.approved_at) : null;
    const ageMin = approvedAt ? Math.floor((Date.now() - approvedAt.getTime()) / 60000) : null;
    const approvalValid = approvedAt && ageMin < 60;

    return `<div class="batch-card ${phase === 'approved' ? 'approved' : ''}">
  <div class="batch-header">
    <div>
      <div class="batch-name">${esc(batch.name)}</div>
      <div class="meta">Created ${new Date(batch.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC
        ${batch.send_window_start ? ` · Window: ${new Date(batch.send_window_start).toISOString().slice(0,16).replace('T',' ')} → ${new Date(batch.send_window_end).toISOString().slice(0,16).replace('T',' ')}` : ''}
      </div>
    </div>
    <span class="badge ${batch.approval_status.toLowerCase()}">${batch.approval_status}</span>
  </div>

  <div class="stats-row">
    <div class="stat-chip"><span>${recCount}</span>recipients</div>
    <div class="stat-chip"><span>${authCount}</span>authorized</div>
    <div class="stat-chip"><span>${sentCount}</span>sent</div>
    <div class="stat-chip"><span>${recCount - sentCount}</span>remaining</div>
  </div>

  <div class="template-preview">
    <strong>Subject</strong>${esc(batch.template_subject)}
    <strong style="margin-top:8px">Body preview</strong>${esc(batch.template_body.slice(0, 200))}${batch.template_body.length > 200 ? '…' : ''}
  </div>

  ${phase === 'approved' && approvalValid ? `
  <div class="approval-info">
    <span class="ai" data-approved-at="${batch.approved_at}">⏱ Computing…</span>
    · Approved by: ${esc(batch.approved_by_email || 'operator')}
  </div>
  ${pendingCount > 0 ? `
  <button class="btn btn-send" id="send-btn-${batch.id}" onclick="sendNextN(${batch.id}, ${Math.min(pendingCount, 10)})">
    🔴 Send Next ${Math.min(pendingCount, 10)} Email${Math.min(pendingCount, 10) === 1 ? '' : 's'}
  </button>` : '<p style="color:var(--success);font-size:12px">All authorized recipients sent.</p>'}
  ` : ''}

  ${phase === 'pending' ? `
  <div class="approve-form" data-batch-id="${batch.id}" data-batch-name="${esc(batch.name)}">
    <form id="approve-form-${batch.id}" onsubmit="return false">
      <label>Type the batch name to confirm: <strong>${esc(batch.name)}</strong></label>
      <input class="confirm-input" type="text" placeholder="Type batch name exactly…" autocomplete="off"/>
      <button class="btn btn-approve" type="submit" disabled>🔴 Approve &amp; Open 60-min Send Window</button>
      <button class="btn btn-reject" type="button" onclick="rejectBatch(${batch.id})">Reject</button>
    </form>
  </div>` : ''}
</div>`;
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
});

// ─── API: POST /admin/outreach/approve/api/approve ────────────────────────────
router.post('/api/approve', requireAdmin, async (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });

  const userId = req.session.user.id;
  const updated = await db.approveBatch(batchId, userId);
  if (!updated) {
    return res.status(409).json({ error: 'Batch not found or not in PENDING state' });
  }

  console.log(`[outreach-approve] Batch ${batchId} approved by user ${userId} (${req.session.user.email})`);
  res.json({ ok: true, batch: updated });
});

// ─── API: POST /admin/outreach/approve/api/reject ─────────────────────────────
router.post('/api/reject', requireAdmin, async (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });

  const updated = await db.rejectBatch(batchId);
  if (!updated) return res.status(404).json({ error: 'Batch not found' });

  console.log(`[outreach-approve] Batch ${batchId} rejected by user ${req.session.user.email}`);
  res.json({ ok: true, batch: updated });
});

// ─── API: POST /admin/outreach/approve/api/send ───────────────────────────────
// Sends next N authorized+unsent recipients in the batch (max 50 per call).
// The gate logic lives in services/outreach-mailer — this just calls it.
router.post('/api/send', requireAdmin, async (req, res) => {
  const { batchId, count } = req.body;
  if (!batchId) return res.status(400).json({ error: 'batchId required' });

  const limit = Math.min(parseInt(count) || 10, 50); // safety cap

  // Fetch pending recipients (authorized but not yet sent)
  const allRecipients = await db.getRecipientsForBatch(batchId);
  const targets = allRecipients.filter(r => r.send_authorized && r.status !== 'SENT').slice(0, limit);

  if (targets.length === 0) {
    return res.json({ ok: true, sent: 0, blocked: 0, message: 'No authorized unsent recipients' });
  }

  let sentCount = 0;
  let blockedCount = 0;
  const errors = [];

  for (const recipient of targets) {
    try {
      await sendOutreachEmail({
        batchId,
        recipientId: recipient.id,
      });
      sentCount++;
    } catch (err) {
      blockedCount++;
      errors.push({ recipientId: recipient.id, email: recipient.email, error: err.message });
      console.error(`[outreach-approve] Send blocked for ${recipient.email}: ${err.message}`);
    }
  }

  console.log(`[outreach-approve] Batch ${batchId} send run: ${sentCount} sent, ${blockedCount} blocked`);
  res.json({ ok: true, sent: sentCount, blocked: blockedCount, errors });
});

// ─── API: GET /admin/outreach/approve/api/batches ────────────────────────────
router.get('/api/batches', requireAdmin, async (req, res) => {
  const batches = await db.listBatches();
  res.json({ batches });
});

// ─── API: GET /admin/outreach/approve/api/log ────────────────────────────────
router.get('/api/log', requireAdmin, async (req, res) => {
  const log = await db.getRecentSendLog(100);
  res.json({ log });
});

// ─── API: POST /admin/outreach/approve/api/batches — create batch (operator only) ──
router.post('/api/batches', requireAdmin, async (req, res) => {
  const { name, templateSubject, templateBody, sendWindowStart, sendWindowEnd, notes } = req.body;
  if (!name || !templateSubject || !templateBody) {
    return res.status(400).json({ error: 'name, templateSubject, templateBody required' });
  }
  try {
    const batch = await db.createBatch({ name, templateSubject, templateBody, sendWindowStart, sendWindowEnd, notes });
    res.json({ ok: true, batch });
  } catch (err) {
    if (err.message.includes('unique')) {
      return res.status(409).json({ error: 'Batch name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── API: POST /admin/outreach/approve/api/recipients — add recipient to batch ──
router.post('/api/recipients', requireAdmin, async (req, res) => {
  const { batchId, email, name, company, authorize } = req.body;
  if (!batchId || !email) {
    return res.status(400).json({ error: 'batchId, email required' });
  }
  const rec = await db.addRecipient(batchId, { email, name, company });
  if (!rec) return res.status(409).json({ error: 'Recipient already exists in this batch' });
  if (authorize) await db.authorizeRecipient(rec.id);
  res.json({ ok: true, recipient: rec });
});

module.exports = router;
