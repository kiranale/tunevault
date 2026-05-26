/**
 * routes/agent-upgrades.js — Auto-upgrade audit and per-connection toggle.
 *
 * Owns: GET  /admin/agent-upgrades       — audit page HTML (admin-only)
 *       GET  /api/admin/agent-upgrades   — last 100 audit rows JSON (admin-only)
 *       GET  /api/admin/agent-upgrades/csv — CSV export (admin-only)
 *       GET  /api/connections/:id/auto-upgrade-status  — current audit status for a connection (auth)
 *       PATCH /api/connections/:id/auto-upgrade        — toggle auto_upgrade_enabled (auth)
 * Does NOT own: upgrade dispatch (routes/agent.js), agent channel (services/agent-channel.js).
 */

'use strict';

const express = require('express');
const path = require('path');
const upgradeAuditDb = require('../db/agent-upgrade-audit');
const agentDb = require('../db/agent');
const { requireAuth, requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// ── GET /admin/agent-upgrades ─────────────────────────────────────────────────
// Serves the static HTML audit page.

router.get('/agent-upgrades', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/agent-upgrades.html'));
});

// ── GET /api/admin/agent-upgrades ─────────────────────────────────────────────
// Returns last 100 audit rows, newest first.

router.get('/agent-upgrades', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const rows = await upgradeAuditDb.listRecentAudits({ limit });
    res.json({ rows, total: rows.length });
  } catch (err) {
    console.error('[agent-upgrades] list error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ── GET /api/admin/agent-upgrades/csv ─────────────────────────────────────────

router.get('/agent-upgrades/csv', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await upgradeAuditDb.listRecentAudits({ limit: 500 });
    const header = 'id,connection_id,connection_name,from_version,to_version,triggered_by,triggered_at,completed_at,status,duration_s,error\n';
    const csvRows = rows.map(r => [
      r.id, r.connection_id,
      `"${(r.connection_name || '').replace(/"/g, '""')}"`,
      r.from_version || '',
      r.to_version,
      r.triggered_by,
      r.triggered_at ? new Date(r.triggered_at).toISOString() : '',
      r.completed_at ? new Date(r.completed_at).toISOString() : '',
      r.status,
      r.duration_s !== null ? r.duration_s : '',
      `"${(r.error || '').replace(/"/g, '""')}"`,
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="agent-upgrades-${Date.now()}.csv"`);
    res.send(header + csvRows.join('\n'));
  } catch (err) {
    console.error('[agent-upgrades] csv error:', err.message);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// ── GET /api/connections/:id/auto-upgrade-status ──────────────────────────────
// Returns the most-recent audit row + current auto_upgrade_enabled flag.
// Used by the /connections page to render the live badge.

router.get('/:id/auto-upgrade-status', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const policy = await upgradeAuditDb.getUpgradePolicy(connectionId);
    const map = await upgradeAuditDb.getLatestAuditsForConnections([connectionId]);
    const latest = map[connectionId] || null;

    res.json({
      auto_upgrade_enabled: policy?.auto_upgrade_enabled ?? true,
      latest_audit: latest,
    });
  } catch (err) {
    console.error('[agent-upgrades] status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch auto-upgrade status' });
  }
});

// ── PATCH /api/connections/:id/auto-upgrade ───────────────────────────────────
// Toggle auto_upgrade_enabled for a connection. Body: { enabled: true|false }

router.patch('/:id/auto-upgrade', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (isNaN(connectionId)) return res.status(400).json({ error: 'Invalid connection id' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` (boolean) is required' });
  }

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await upgradeAuditDb.setAutoUpgradeEnabled(connectionId, enabled);
    res.json({ ok: true, auto_upgrade_enabled: enabled });
  } catch (err) {
    console.error('[agent-upgrades] patch error:', err.message);
    res.status(500).json({ error: 'Failed to update auto-upgrade setting' });
  }
});

module.exports = router;
