/**
 * routes/service-discovery.js — CDB/PDB-aware service classifier for the connection wizard.
 *
 * Owns: GET  /api/connections/discover-services          — run classifier (agent-channel based)
 *       POST /api/connections/:id/save-service-classification — persist snapshot at save-time
 *       POST /api/agent/select-service                   — extended version of select-sid with
 *                                                           classification snapshot write
 * Does NOT own: oracle_connections CRUD (db/agent.js), agent channel lifecycle (routes/agent.js),
 *               UI page serving (routes/ssh-install.js).
 */

'use strict';

const express  = require('express');
const pool     = require('../db/index');
const agentDb  = require('../db/agent');
const channel  = require('../services/agent-channel');
const { requireAuth }  = require('../middleware/auth');
const classifier = require('../lib/oracle/service-classifier');

const router = express.Router();

// ── GET /api/connections/discover-services ────────────────────────────────────
// Called by the wizard service-picker step after the agent registers.
// Fetches CDB SIDs + PDB services from the agent (via detect-sids or tunnel data),
// optionally enriches with V$SERVICES con_id data if the agent supports it,
// then runs the classifier and returns a ranked+annotated list.
//
// Query params:
//   connection_id — the draft connection ID (required)
//
// The endpoint constructs synthetic service rows when V$SERVICES isn't available:
//   - CDB SIDs → { con_id: 1, name: sid } (CDB root, always blocked)
//   - PDB services → { con_id: 3, name: svc, pdb_name: null } (con_id is approximate)
//   V$SERVICES query path: if the agent supports /api/query-services it returns full rows.

router.get('/discover-services', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.query.connection_id, 10);
  if (!connectionId) {
    return res.status(400).json({ error: 'connection_id query param required' });
  }

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── Try to get rich V$SERVICES data via agent channel ─────────────────────
    let services = [];
    let pdbs     = [];
    let source   = 'tunnel_cache'; // 'vservices' | 'detect_sids' | 'tunnel_cache'

    if (await channel.isAgentConnected(connectionId)) {
      // First try the new /api/query-services path (v3.7+) which returns V$SERVICES rows
      try {
        const result = await channel.sendToAgent(
          connectionId,
          { method: 'POST', path: '/api/query-services', body: {} },
          12_000
        );
        if (result && result.ok && Array.isArray(result.services)) {
          services = result.services;
          pdbs     = Array.isArray(result.pdbs) ? result.pdbs : [];
          source   = 'vservices';
        }
      } catch (_) { /* fall through to detect-sids */ }

      // Fall back to /api/detect-sids if query-services isn't supported
      if (source !== 'vservices') {
        try {
          const result = await channel.sendToAgent(
            connectionId,
            { method: 'POST', path: '/api/detect-sids', body: {} },
            12_000
          );
          if (result && result.ok) {
            const cdbSids = Array.isArray(result.cdb_sids) ? result.cdb_sids : [];
            const pdbSvcs = Array.isArray(result.pdb_services) ? result.pdb_services : [];
            services = _buildServiceRows(cdbSids, pdbSvcs);
            source   = 'detect_sids';
          }
        } catch (_) { /* fall through to cached tunnel data */ }
      }
    }

    // Last resort: use cached oracle_sids + pdb_services from agent_tunnels
    if (source === 'tunnel_cache' || services.length === 0) {
      const tunnel = await agentDb.getTunnel(connectionId);
      if (tunnel) {
        const cdbSids = Array.isArray(tunnel.oracle_sids)  ? tunnel.oracle_sids  : [];
        const pdbSvcs = Array.isArray(tunnel.pdb_services) ? tunnel.pdb_services : [];
        services = _buildServiceRows(cdbSids, pdbSvcs);
        source   = 'tunnel_cache';
      }
    }

    // ── Run the classifier ────────────────────────────────────────────────────
    const classified = classifier.classifyServices(services, pdbs);

    // Annotate each result with a human-readable label + color
    const annotated = classified.map(svc => ({
      ...svc,
      label: classifier.classificationLabel(svc.classification),
      color: classifier.classificationColor(svc.classification),
    }));

    res.json({
      ok: true,
      source,
      services: annotated,
      recommended: annotated.find(s => s.recommended) || null,
    });
  } catch (err) {
    console.error('[service-discovery] discover-services error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/save-service-classification ──────────────────────
// Persists the classification snapshot on the connection record so the
// connections list can render the badge without re-querying.
// Called client-side immediately after the user confirms a service selection.

router.post('/:id/save-service-classification', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });

  const { classification_snapshot, selected_service } = req.body;
  if (!classification_snapshot || !selected_service) {
    return res.status(400).json({ error: 'classification_snapshot and selected_service required' });
  }

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query(
      `UPDATE oracle_connections
       SET service_classification = $1,
           service_name           = COALESCE(service_name, $2),
           updated_at             = NOW()
       WHERE id = $3`,
      [JSON.stringify(classification_snapshot), selected_service, connectionId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[service-discovery] save-service-classification error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/log-blocked-service-override ────────────────────
// Advanced users can override a blocked service. This endpoint logs the override
// to the activity_log for audit purposes before the client proceeds.

router.post('/:id/log-blocked-service-override', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });

  const { service_name, classification, reason } = req.body;
  if (!service_name) return res.status(400).json({ error: 'service_name required' });

  try {
    const conn = await agentDb.getConnectionById(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id && conn.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Log to activity_log (fire-and-forget — don't block the response)
    pool.query(
      `INSERT INTO activity_log
         (user_id, action_type, detail, connection_id, result, created_at)
       VALUES ($1, 'settings_change', $2, $3, 'warning', NOW())`,
      [
        req.user.id,
        JSON.stringify({
          event: 'blocked_service_override',
          service_name,
          classification,
          reason,
          warning: 'User explicitly selected a blocked service despite classifier warning.',
        }),
        connectionId,
      ]
    ).catch(err => console.warn('[service-discovery] activity log error:', err.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[service-discovery] log-blocked-service-override error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build synthetic V$SERVICES-shaped rows from plain lsnrctl strings.
 * CDB instance SIDs get con_id=1 (CDB root).
 * PDB service names get con_id=3 (approximate — real con_ids vary).
 * The classifier infers PDB_DEFAULT from the ebs_ prefix, not from a DB query.
 */
function _buildServiceRows(cdbSids, pdbSvcs) {
  const rows = [];
  for (const sid of cdbSids) {
    rows.push({ con_id: 1, name: sid, network_name: sid });
  }
  // Assign incrementing con_ids starting at 3 (2=PDB$SEED, 3+ are user PDBs)
  let nextConId = 3;
  for (const svc of pdbSvcs) {
    rows.push({ con_id: nextConId, name: svc, network_name: svc });
    nextConId++;
  }
  return rows;
}

module.exports = router;
