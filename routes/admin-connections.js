/**
 * routes/admin-connections.js — Admin bulk-delete tool for oracle_connections.
 *
 * Owns: GET /admin/connections (UI page), POST /api/admin/connections/bulk-delete.
 * Does NOT own: individual connection CRUD (server.js), connection auth/ownership checks,
 *               audit_log schema (db/ebs-control.js writes the shared table).
 *
 * Gated by: requireAdmin (ADMIN_EMAILS) + feature flag ADMIN_BULK_DELETE=1.
 * Rate limit: 1 bulk-delete per company_domain per 5 minutes (in-process map).
 */

'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const pool    = require('../db/index');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// ─── Feature flag check ───────────────────────────────────────────────────────
// All routes in this file are disabled unless ADMIN_BULK_DELETE=1.
function featureEnabled() {
  return process.env.ADMIN_BULK_DELETE === '1';
}

// ─── In-process rate limit: 1 bulk-delete per company_domain per 5 minutes ───
const RATE_WINDOW_MS = 5 * 60 * 1000;
const lastBulkDelete = new Map(); // company_domain → timestamp

function checkRateLimit(companyDomain) {
  const key  = companyDomain || '__unknown__';
  const last = lastBulkDelete.get(key);
  if (last && Date.now() - last < RATE_WINDOW_MS) {
    const waitSec = Math.ceil((RATE_WINDOW_MS - (Date.now() - last)) / 1000);
    return { allowed: false, waitSec };
  }
  return { allowed: true };
}

function setRateLimit(companyDomain) {
  lastBulkDelete.set(companyDomain || '__unknown__', Date.now());
}

// ─── Core cascade-delete for a single connection (mirrors server.js logic) ───
// Runs inside the caller's transaction client — caller must COMMIT/ROLLBACK.
async function cascadeDeleteConnection(client, connId) {
  // No-FK tables: explicit delete to avoid orphans.
  const noFkTables = [
    'credential_access_log',
    'finding_history',
    'sql_audit_log',
    'sql_console_history',
    'tuneops_notification_mutes',
  ];
  for (const tbl of noFkTables) {
    await client.query(`DELETE FROM ${tbl} WHERE connection_id = $1`, [connId]);
  }
  // health_checks FK is NO ACTION — null it to preserve history.
  await client.query(
    'UPDATE health_checks SET connection_id = NULL WHERE connection_id = $1',
    [connId]
  );
  // Delete the connection — DB-level CASCADE cleans all remaining FK tables.
  await client.query('DELETE FROM oracle_connections WHERE id = $1', [connId]);
}

// ─── GET /admin/connections — serve the UI page ───────────────────────────────

router.get('/', requireAdminPage, (req, res) => {
  if (!featureEnabled()) {
    return res.status(404).send('Not enabled. Set ADMIN_BULK_DELETE=1.');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'connections.html'));
});

// ─── POST /api/admin/connections/bulk-delete ─────────────────────────────────
//
// Body: { namePattern: string, confirmCount?: number, dryRun: boolean }
//
// dryRun=true  → returns { count, sampleNames: string[] } (no changes)
// dryRun=false → requires confirmCount === server-counted matches (409 on mismatch)
//                → deletes each connection via full cascade, one at a time
//                → returns { deleted, failed: [{ id, name, error }] }
//
// Each deletion is logged to audit_log with actor info + bulk_operation_id.

router.post('/bulk-delete', requireAdmin, async (req, res) => {
  if (!featureEnabled()) {
    return res.status(404).json({ error: 'Feature not enabled' });
  }

  const { namePattern, confirmCount, dryRun } = req.body || {};
  const userId        = req.user && req.user.id;
  const companyDomain = req.user && req.user.company_domain;
  const userEmail     = req.user && req.user.email;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!namePattern || typeof namePattern !== 'string' || !namePattern.trim()) {
    return res.status(400).json({ error: 'namePattern is required' });
  }
  if (typeof dryRun !== 'boolean') {
    return res.status(400).json({ error: 'dryRun must be a boolean' });
  }
  if (!dryRun && typeof confirmCount !== 'number') {
    return res.status(400).json({ error: 'confirmCount is required for live delete' });
  }

  // ── Rate limit (live deletes only — dry-run is free) ─────────────────────
  if (!dryRun) {
    const rl = checkRateLimit(companyDomain);
    if (!rl.allowed) {
      return res.status(429).json({
        error: `Rate limited. Try again in ${rl.waitSec}s (1 bulk-delete per 5 minutes per company).`,
      });
    }
  }

  // ── Resolve matching connections ──────────────────────────────────────────
  // Scoped to company_domain via user ownership. Admin can see all connections
  // owned by users in the same company_domain.
  let matchRows;
  try {
    const q = await pool.query(
      `SELECT oc.id, oc.name
         FROM oracle_connections oc
         JOIN users u ON u.id = oc.user_id
        WHERE oc.name ILIKE $1
          AND ($2::text IS NULL OR u.company_domain = $2)
        ORDER BY oc.created_at DESC`,
      [namePattern.trim(), companyDomain || null]
    );
    matchRows = q.rows; // [{ id, name }]
  } catch (err) {
    console.error('[bulk-delete] pattern query failed:', err.message);
    return res.status(500).json({ error: 'Failed to query connections' });
  }

  // ── Dry-run path ──────────────────────────────────────────────────────────
  if (dryRun) {
    return res.json({
      count: matchRows.length,
      sampleNames: matchRows.slice(0, 10).map(r => r.name),
    });
  }

  // ── Live-delete path ──────────────────────────────────────────────────────
  const serverCount = matchRows.length;
  if (serverCount !== confirmCount) {
    return res.status(409).json({
      error: `Confirm count mismatch. You said ${confirmCount} but server found ${serverCount}. Refresh and confirm again.`,
      serverCount,
    });
  }

  if (serverCount === 0) {
    return res.json({ deleted: 0, failed: [] });
  }

  // Consume rate-limit slot now (before deletes start).
  setRateLimit(companyDomain);

  const bulkOperationId = crypto.randomUUID();
  const tag = `[bulk-delete op=${bulkOperationId} user=${userEmail}]`;
  console.log(`${tag} starting bulk delete of ${serverCount} connections`);

  let deleted = 0;
  const failed = [];

  for (const { id: connId, name: connName } of matchRows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await cascadeDeleteConnection(client, connId);
      // Audit log entry for this deletion.
      await client.query(
        `INSERT INTO audit_log (user_id, action, slug, allowed, rejection_reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          'bulk_delete_connection',
          `connection:${connId}`,
          true,
          null,
          JSON.stringify({
            connection_name:   connName,
            actor_email:       userEmail,
            actor_role:        'admin',
            bulk_operation_id: bulkOperationId,
            pattern:           namePattern.trim(),
          }),
        ]
      );
      await client.query('COMMIT');
      deleted++;
      console.log(`${tag} deleted connection "${connName}" (id=${connId})`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${tag} FAILED to delete "${connName}" (id=${connId}):`, err.message);
      failed.push({ id: connId, name: connName, error: err.message });
    } finally {
      client.release();
    }
  }

  console.log(`${tag} done — deleted=${deleted}, failed=${failed.length}`);
  res.json({ deleted, failed, bulkOperationId });
});

module.exports = router;
