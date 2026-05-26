/**
 * routes/tns-topology.js — TNS Topology Inspector: listener/service reconciliation.
 *
 * Owns: GET  /connections/:id/tns-topology                 — HTML page
 *       GET  /api/connections/:id/tns-topology              — run full topology analysis
 *       POST /api/connections/:id/tns-topology/snapshot     — persist snapshot + return id
 *       POST /api/connections/:id/tns-topology/share        — issue 7-day share token
 *       GET  /share/tns-topology/:token                     — public share view (no auth)
 * Does NOT own: service classification logic (lib/oracle/service-classifier.js),
 *               snapshot DB CRUD (db/tns-topology.js), agent channel (services/agent-channel.js).
 */

'use strict';

const express      = require('express');
const path         = require('path');
const topoDb       = require('../db/tns-topology');
const channel      = require('../services/agent-channel');
const classifier   = require('../lib/oracle/service-classifier');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── HTML page ─────────────────────────────────────────────────────────────────

router.get('/connections/:id/tns-topology', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, '../public/connections-tns-topology.html'));
});

// ── Public share view ─────────────────────────────────────────────────────────

router.get('/share/tns-topology/:token', async (req, res) => {
  const snapshot = await topoDb.resolveShareToken(req.params.token).catch(() => null);
  if (!snapshot) {
    return res.status(404).send('<h2>This link has expired or does not exist.</h2>');
  }
  // Serve the same page; the frontend will detect ?share=<token> and fetch JSON
  res.sendFile(path.join(__dirname, '../public/connections-tns-topology.html'));
});

// ── GET /api/connections/:id/tns-topology — run live topology analysis ────────
//
// Queries (all read-only, routed via agent channel or SSH sqlplus):
//   1. V$SERVICES         — registered service list (CDB + PDB)
//   2. V$ACTIVE_SERVICES  — currently active services
//   3. V$PDBS             — PDB topology (empty for non-CDB)
//   4. V$INSTANCE         — instance name, host, version
//   5. V$SERVICEMETRIC    — recent traffic per service (active service activity)
//   6. DBA_SERVICES       — catalog-level services (catches defined-but-not-registered)
//   7. lsnrctl services   — via OS exec or existing agent endpoint
//
// Returns a unified topology object including recommended connect string.

router.get('/api/connections/:id/tns-topology', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    // Ownership check + connection fetch (via db/tns-topology.js)
    const conn = await topoDb.getConnectionForTopology(connectionId);
    if (!conn) return res.status(404).json({ error: 'Connection not found' });
    if (conn.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    // ── Execute query bundle via agent channel ────────────────────────────────
    const agentConnected = await channel.isAgentConnected(connectionId);

    let vServices = [], vActiveServices = [], vPdbs = [], vInstance = null;
    let vServiceMetric = [], dbaServices = [], lsnrctlOutput = null;
    let queryErrors = [];

    // Helper: send a query to agent with timeout, gracefully handle failures
    async function agentQuery(sql, label) {
      if (!agentConnected) {
        queryErrors.push(`${label}: agent not connected`);
        return null;
      }
      try {
        const result = await channel.sendToAgent(
          connectionId,
          { method: 'POST', path: '/api/query', body: { sql, label } },
          20_000
        );
        if (result && result.ok && Array.isArray(result.rows)) return result.rows;
        if (result && result.error) queryErrors.push(`${label}: ${result.error}`);
        return null;
      } catch (err) {
        queryErrors.push(`${label}: ${err.message}`);
        return null;
      }
    }

    // Helper: try SSH sqlplus path
    async function sshQuery(sql, label) {
      try {
        const oracleRunner = require('../services/oracle-runner');
        if (!['ssh_sqlplus', 'both'].includes(conn.connectivity_mode)) return null;
        const rows = await oracleRunner.runQuery(conn, sql);
        return rows || null;
      } catch (err) {
        queryErrors.push(`${label} (SSH): ${err.message}`);
        return null;
      }
    }

    // Route queries to agent or SSH
    async function runQuery(sql, label) {
      if (agentConnected) return agentQuery(sql, label);
      return sshQuery(sql, label);
    }

    // 1. V$SERVICES
    const svcsRows = await runQuery(
      `SELECT NAME, NETWORK_NAME, CON_ID, PDB FROM V$SERVICES ORDER BY CON_ID, NAME`,
      'V$SERVICES'
    );
    if (svcsRows) vServices = svcsRows;

    // 2. V$ACTIVE_SERVICES
    const activeSvcsRows = await runQuery(
      `SELECT NAME, NETWORK_NAME, CREATION_DATE FROM V$ACTIVE_SERVICES`,
      'V$ACTIVE_SERVICES'
    );
    if (activeSvcsRows) vActiveServices = activeSvcsRows;

    // 3. V$PDBS
    const pdbRows = await runQuery(
      `SELECT CON_ID, NAME, OPEN_MODE, RESTRICTED FROM V$PDBS`,
      'V$PDBS'
    );
    if (pdbRows) vPdbs = pdbRows;

    // 4. V$INSTANCE
    const instRows = await runQuery(
      `SELECT INSTANCE_NAME, HOST_NAME, VERSION, STATUS, DATABASE_STATUS, INSTANCE_ROLE FROM V$INSTANCE`,
      'V$INSTANCE'
    );
    if (instRows && instRows.length) vInstance = instRows[0];

    // 5. V$SERVICEMETRIC (recent call volume per service, GROUP_ID=10 = 1-min window)
    const metricRows = await runQuery(
      `SELECT SERVICE_NAME, ELAPSEDPERCALL, CALLSPERSEC FROM V$SERVICEMETRIC WHERE GROUP_ID=10`,
      'V$SERVICEMETRIC'
    );
    if (metricRows) vServiceMetric = metricRows;

    // 6. DBA_SERVICES — catalog-level (catches defined-but-not-registered services)
    const dbaSvcsRows = await runQuery(
      `SELECT NAME, NETWORK_NAME, CREATION_DATE, FAILOVER_TYPE, GOAL FROM DBA_SERVICES`,
      'DBA_SERVICES'
    );
    if (dbaSvcsRows) dbaServices = dbaSvcsRows;

    // 7. lsnrctl services — via OS exec endpoint if available
    if (agentConnected) {
      try {
        const lsnrResult = await channel.sendToAgent(
          connectionId,
          { method: 'POST', path: '/api/os/exec', body: { command_id: 'lsnrctl_services', args: {} } },
          15_000
        );
        if (lsnrResult && lsnrResult.ok && lsnrResult.stdout) {
          lsnrctlOutput = lsnrResult.stdout;
        }
      } catch (_) { /* lsnrctl optional — agent may not support */ }
    }

    // ── Build topology ────────────────────────────────────────────────────────

    // Normalize column names (Oracle returns UPPERCASE, proxy may normalize)
    function norm(obj) {
      if (!obj) return obj;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
    }
    vServices      = (vServices      || []).map(norm);
    vActiveServices= (vActiveServices|| []).map(norm);
    vPdbs          = (vPdbs          || []).map(norm);
    dbaServices    = (dbaServices    || []).map(norm);
    vServiceMetric = (vServiceMetric || []).map(norm);
    if (vInstance) vInstance = norm(vInstance);

    // Build active service name set for reconciliation
    const activeNames = new Set((vActiveServices || []).map(s => (s.network_name || s.name || '').toLowerCase()));

    // Build metric map: service_name → callspersec
    const metricMap = {};
    for (const m of vServiceMetric) {
      if (m.service_name) metricMap[(m.service_name || '').toLowerCase()] = m;
    }

    // Run the classifier (reuse lib/oracle/service-classifier.js from task #2)
    const classified = classifier.classifyServices(vServices, vPdbs);

    // Annotate each classified service with: active/inactive, traffic, aliases
    const registeredServices = classified.map(svc => {
      const networkLower = (svc.network_name || '').toLowerCase();
      const nameLower    = (svc.name || '').toLowerCase();
      const isActive     = activeNames.has(networkLower) || activeNames.has(nameLower);
      const metric       = metricMap[networkLower] || metricMap[nameLower] || null;

      // Find aliases: services with different name but same network_name root
      // e.g. EBSDEV ↔ ebs_EBSDEV ↔ ebsdev
      const aliases = [];
      const base = networkLower.replace(/^ebs_/, '').replace(/xdb$/, '').toLowerCase();
      for (const other of classified) {
        if (other.network_name === svc.network_name) continue;
        const otherBase = (other.network_name || '').replace(/^ebs_/, '').replace(/xdb$/, '').toLowerCase();
        if (base && otherBase === base) {
          aliases.push(other.network_name);
        }
      }

      // Check if this service is in DBA_SERVICES but NOT in V$SERVICES (defined-only, not registered)
      const inDba = dbaServices.some(d =>
        (d.network_name || d.name || '').toLowerCase() === networkLower
      );
      const definedOnly = inDba && vServices.every(v =>
        (v.network_name || v.name || '').toLowerCase() !== networkLower
      );

      // Flag: registered in V$SERVICES but not active in V$ACTIVE_SERVICES
      const registeredNotActive = !isActive;

      return {
        ...svc,
        label:                 classifier.classificationLabel(svc.classification),
        color:                 classifier.classificationColor(svc.classification),
        active:                isActive,
        registered_not_active: registeredNotActive,
        calls_per_sec:         metric ? parseFloat(metric.callspersec) : null,
        elapsed_per_call_ms:   metric ? parseFloat(metric.elapsedpercall) : null,
        aliases:               [...new Set(aliases)],
        defined_only:          definedOnly, // in DBA_SERVICES but not V$SERVICES
      };
    });

    // Also include DBA_SERVICES entries that are NOT in V$SERVICES at all (orphaned)
    const registeredNetNames = new Set(registeredServices.map(s => (s.network_name || '').toLowerCase()));
    const orphanedDbaServices = dbaServices.filter(d => {
      const n = (d.network_name || d.name || '').toLowerCase();
      return !registeredNetNames.has(n);
    }).map(d => ({
      name:         d.name || d.network_name,
      network_name: d.network_name || d.name,
      classification: 'OTHER',
      label:        'Defined (not registered)',
      color:        'orange',
      active:       activeNames.has((d.network_name || d.name || '').toLowerCase()),
      orphaned_dba: true,
      failover_type: d.failover_type || null,
      goal:          d.goal || null,
    }));

    // PDB topology for non-CDB is empty
    const pdbTopology = (vPdbs || []).map(p => ({
      con_id:     p.con_id,
      name:       p.name,
      open_mode:  p.open_mode,
      restricted: p.restricted,
    }));
    const isCdb = pdbTopology.length > 0;

    // Parse lsnrctl output for listener endpoints
    const listenerEndpoints = parseLsnrctlEndpoints(lsnrctlOutput, conn.host, conn.port);

    // ── Build recommended connect string ─────────────────────────────────────
    const recommended = registeredServices.find(s => s.recommended);
    const connectString = buildConnectString({
      host:        conn.host,
      port:        conn.port || 1521,
      serviceName: recommended ? recommended.network_name : (conn.service_name || 'YOUR_SERVICE'),
      instanceName: vInstance ? vInstance.instance_name : null,
    });

    // ── Consistency check: flag anomalies ─────────────────────────────────────
    const anomalies = [];
    const patchServices = registeredServices.filter(s => s.classification === 'EBS_PATCH_MODE');
    if (patchServices.length > 0) {
      anomalies.push({
        severity: 'critical',
        message:  `ADOP patch cycle active: ${patchServices.map(s => s.network_name).join(', ')} — do not connect to patch-mode services`,
      });
    }
    const inactiveRegistered = registeredServices.filter(s => s.registered_not_active && !s.blocked);
    if (inactiveRegistered.length > 0) {
      anomalies.push({
        severity: 'warning',
        message:  `${inactiveRegistered.length} service(s) registered in V$SERVICES but not active in V$ACTIVE_SERVICES: ${inactiveRegistered.map(s => s.network_name).join(', ')}`,
      });
    }
    if (orphanedDbaServices.length > 0) {
      anomalies.push({
        severity: 'info',
        message:  `${orphanedDbaServices.length} service(s) in DBA_SERVICES not registered with listener: ${orphanedDbaServices.map(s => s.network_name).join(', ')}`,
      });
    }
    if (!recommended) {
      anomalies.push({
        severity: 'warning',
        message:  'No recommended service found — all services are blocked or empty',
      });
    }

    const topology = {
      connection_id:         connectionId,
      connection_name:       conn.name,
      instance:              vInstance,
      is_cdb:                isCdb,
      listener_endpoints:    listenerEndpoints,
      registered_services:   registeredServices,
      orphaned_dba_services: orphanedDbaServices,
      pdb_topology:          pdbTopology,
      recommended_service:   recommended || null,
      connect_string:        connectString,
      anomalies,
      query_errors:          queryErrors,
      agent_connected:       agentConnected,
      generated_at:          new Date().toISOString(),
    };

    res.json({ ok: true, topology });
  } catch (err) {
    console.error('[tns-topology] analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/tns-topology/snapshot — persist snapshot ────────

router.post('/api/connections/:id/tns-topology/snapshot', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });

  const { topology } = req.body;
  if (!topology) return res.status(400).json({ error: 'topology payload required' });

  try {
    // Ownership check
    const ownerId = await topoDb.getConnectionOwnerId(connectionId);
    if (ownerId === null) return res.status(404).json({ error: 'Connection not found' });
    if (ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const serviceNames  = (topology.registered_services || []).map(s => s.network_name).filter(Boolean);
    const patchSvcs     = (topology.registered_services || [])
      .filter(s => s.classification === 'EBS_PATCH_MODE')
      .map(s => s.network_name);
    const recommended   = topology.recommended_service ? topology.recommended_service.network_name : null;
    const pdbCount      = (topology.pdb_topology || []).length;
    const instanceName  = topology.instance ? topology.instance.instance_name : null;
    const dbVersion     = topology.instance ? topology.instance.version : null;

    const snapshotId = await topoDb.insertSnapshot({
      connectionId,
      snapshotData:    topology,
      serviceNames,
      patchServices:   patchSvcs,
      recommendedSvc:  recommended,
      pdbCount,
      instanceName,
      dbVersion,
    });

    res.json({ ok: true, snapshot_id: snapshotId });
  } catch (err) {
    console.error('[tns-topology] snapshot error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/connections/:id/tns-topology/share — issue share token ──────────

router.post('/api/connections/:id/tns-topology/share', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  const { snapshot_id } = req.body;
  if (!connectionId || !snapshot_id) {
    return res.status(400).json({ error: 'connection_id and snapshot_id required' });
  }

  try {
    const snapshot = await topoDb.getSnapshotById(snapshot_id);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
    if (snapshot.connection_id !== connectionId) {
      return res.status(400).json({ error: 'Snapshot does not belong to this connection' });
    }

    // Ownership check via connection
    const ownerId = await topoDb.getConnectionOwnerId(connectionId);
    if (ownerId === null) return res.status(404).json({ error: 'Connection not found' });
    if (ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const { token, expires_at } = await topoDb.issueShareToken(snapshot_id);
    const shareUrl = `/share/tns-topology/${token}`;

    res.json({ ok: true, share_url: shareUrl, token, expires_at });
  } catch (err) {
    console.error('[tns-topology] share error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/connections/:id/tns-topology/history — last 30 snapshots ─────────

router.get('/api/connections/:id/tns-topology/history', requireAuth, async (req, res) => {
  const connectionId = parseInt(req.params.id, 10);
  if (!connectionId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const ownerId = await topoDb.getConnectionOwnerId(connectionId);
    if (ownerId === null) return res.status(404).json({ error: 'Connection not found' });
    if (ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const snapshots = await topoDb.getSnapshots(connectionId, 30);
    res.json({ ok: true, snapshots });
  } catch (err) {
    console.error('[tns-topology] history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/share/tns-topology/:token — public share JSON ────────────────────

router.get('/api/share/tns-topology/:token', async (req, res) => {
  try {
    const snapshot = await topoDb.resolveShareToken(req.params.token);
    if (!snapshot) {
      return res.status(404).json({ error: 'Share link expired or not found' });
    }
    // Return topology data without PII (no connection credentials)
    res.json({
      ok: true,
      topology: snapshot.snapshot_data,
      created_at: snapshot.created_at,
      expires_at: snapshot.share_expires_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse lsnrctl services output for listener endpoints.
 * Returns array of { protocol, host, port } objects.
 * Falls back to connection host/port if output unavailable.
 */
function parseLsnrctlEndpoints(output, fallbackHost, fallbackPort) {
  const endpoints = [];

  if (output) {
    // Match: (PROTOCOL=TCP)(HOST=hostname)(PORT=1521)
    const pattern = /\(PROTOCOL=([^)]+)\)\(HOST=([^)]+)\)\(PORT=(\d+)\)/gi;
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const endpoint = {
        protocol: match[1].toUpperCase(),
        host:     match[2],
        port:     parseInt(match[3], 10),
        source:   'lsnrctl',
      };
      // Deduplicate
      const exists = endpoints.some(e => e.host === endpoint.host && e.port === endpoint.port);
      if (!exists) endpoints.push(endpoint);
    }

    // Also look for service handler counts
    const handlerPattern = /Handler\(s\):\s*\n\s+"(\w+)"/gi;
    // (just informational — we parse handler types if present)
  }

  // Always include the configured connection endpoint as reference
  if (fallbackHost) {
    const existing = endpoints.some(e => e.host === fallbackHost && e.port === (fallbackPort || 1521));
    if (!existing) {
      endpoints.push({
        protocol: 'TCP',
        host:     fallbackHost,
        port:     fallbackPort || 1521,
        source:   'connection_config',
      });
    }
  }

  return endpoints;
}

/**
 * Build a full TNS connect descriptor from the recommended service.
 */
function buildConnectString({ host, port, serviceName, instanceName }) {
  const tnsDescriptor =
    `(DESCRIPTION=\n` +
    `  (ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))\n` +
    `  (CONNECT_DATA=(SERVICE_NAME=${serviceName})))`;

  const easyConnect = `${host}:${port}/${serviceName}`;
  const sqlplusExample = `sqlplus apps/****@${easyConnect}`;

  return {
    tns_descriptor:   tnsDescriptor,
    easy_connect:     easyConnect,
    sqlplus_example:  sqlplusExample,
    service_name:     serviceName,
    host,
    port,
  };
}

module.exports = router;
