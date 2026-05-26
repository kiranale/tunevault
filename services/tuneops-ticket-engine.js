/**
 * services/tuneops-ticket-engine.js — TuneOps ticket auto-creation and lifecycle engine.
 *
 * Owns: Creating/reopening/resolving tickets from health check findings,
 *       canonical key generation, dedup logic, demo ticket seeding.
 * Does NOT own: ticket CRUD queries (db/tuneops-tickets.js), API routing (routes/tuneops.js),
 *               health check execution, user auth.
 *
 * Called as fire-and-forget after runDeltaForConnection completes.
 * Never throws — errors are logged and swallowed so HC completion isn't blocked.
 */

'use strict';

const pool        = require('../db/index');
const db          = require('../db/tuneops-tickets');

// Severity mapping from check_results status to ticket severity enum
const STATUS_TO_SEVERITY = {
  red      : 'critical',
  critical : 'critical',
  amber    : 'warning',
  warning  : 'warning',
  info     : 'info',
  green    : null,   // not a finding
  ok       : null,
};

/**
 * Builds the canonical key for a check_results row.
 * Mirrors schedule-runner.js buildFindingKey() logic for consistency.
 * Format: "{connectionId}:{check_id}:{dimension}" or "{connectionId}:{check_id}"
 */
function buildCanonicalKey(connectionId, checkId, rawPayload) {
  const payload = rawPayload || {};

  if (checkId === 'ST01_TABLESPACE_USAGE' && payload.name) {
    return `${connectionId}:${checkId}:${payload.name.toUpperCase()}`;
  }
  if ((checkId === 'ST02_UNDO_USAGE' || checkId === 'ST03_TEMP_USAGE') && payload.current?.tablespace_name) {
    return `${connectionId}:${checkId}:${payload.current.tablespace_name.toUpperCase()}`;
  }
  return `${connectionId}:${checkId}`;
}

/**
 * Builds a human-readable title from a check_results row.
 */
function buildTitle(row) {
  const payload = row.raw_payload || {};

  if (row.check_id === 'ST01_TABLESPACE_USAGE' && payload.name) {
    return `${payload.name} tablespace ${payload.pct_used}% full`;
  }
  if (row.ai_summary) return row.ai_summary;
  if (row.metric_name && row.metric_value != null) {
    return `${row.metric_name}: ${row.metric_value} ${row.metric_unit || ''}`.trim();
  }
  return row.check_id;
}

/**
 * Resolves the company_id for a connection (uses company_domain from the owning user).
 * Falls back to `conn_{connectionId}` if no user is found.
 */
async function resolveCompanyId(connectionId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.company_domain
       FROM oracle_connections oc
       JOIN users u ON u.id = oc.user_id
       WHERE oc.id = $1`,
      [connectionId]
    );
    return rows[0]?.company_domain || `conn_${connectionId}`;
  } catch {
    return `conn_${connectionId}`;
  }
}

/**
 * processHealthCheckFindings(connectionId, healthCheckId)
 *
 * Main entry point. Called fire-and-forget after each health check completes.
 *
 * 1. Loads check_results for this run that are amber/red.
 * 2. For each finding: creates a new ticket, reopens a resolved one, or updates severity.
 * 3. For previously open findings now cleared: auto-resolves.
 */
async function processHealthCheckFindings(connectionId, healthCheckId) {
  if (!connectionId || !healthCheckId) return;

  try {
    const companyId = await resolveCompanyId(connectionId);

    // Load current amber/red findings for this specific health check run
    const { rows: currentResults } = await pool.query(
      `SELECT check_id, check_category, status, metric_name, metric_value, metric_unit,
              raw_payload, ai_summary, recommendation
       FROM check_results
       WHERE connection_id = $1
         AND status IN ('amber','red')
       ORDER BY executed_at DESC
       LIMIT 200`,
      [connectionId]
    );

    // Deduplicate — keep latest per canonical key for this run
    // (check_results may have multiple rows per check from different run_ids)
    const latestByKey = {};
    for (const row of currentResults) {
      const key = buildCanonicalKey(connectionId, row.check_id, row.raw_payload);
      if (!latestByKey[key]) latestByKey[key] = row;
    }

    const activeKeys = Object.keys(latestByKey);

    // Process each current finding
    for (const [canonicalKey, row] of Object.entries(latestByKey)) {
      const severity = STATUS_TO_SEVERITY[row.status?.toLowerCase()];
      if (!severity) continue;

      const title = buildTitle(row);
      const description = [
        row.ai_summary,
        row.metric_name && row.metric_value != null
          ? `${row.metric_name}: ${row.metric_value} ${row.metric_unit || ''}`.trim()
          : null,
        row.recommendation ? `Recommended action: ${row.recommendation}` : null,
      ].filter(Boolean).join('\n\n') || title;

      const existing = await db.findOpenByCanonicalKey(canonicalKey);

      if (existing) {
        // Already open — update severity if worsened
        await db.worsenSeverity(existing.id, severity, description);
      } else {
        // Check for a resolved ticket to reopen
        const resolved = await db.findResolvedByCanonicalKey(canonicalKey);
        if (resolved) {
          await db.reopenTicket(resolved.id, { severity, title, description });
        } else {
          // Create fresh ticket
          await db.createTicket({
            companyId,
            connectionId,
            title,
            description,
            severity,
            status: 'OPEN',
            source: 'health_check',
            sourceReference: {
              check_id: row.check_id,
              check_category: row.check_category,
              health_check_run_id: healthCheckId,
            },
            canonicalKey,
            recommendedFix: row.recommendation || null,
            fixType: row.recommendation ? 'sql' : 'manual',
          });
        }
      }
    }

    // Auto-resolve findings that cleared (were open/acknowledged but no longer amber/red)
    // Load all open tickets for this connection to find cleared ones
    const { rows: openTickets } = await pool.query(
      `SELECT id, canonical_key, ticket_number
       FROM tuneops_tickets
       WHERE connection_id = $1
         AND status IN ('OPEN','ACKNOWLEDGED','CONFIRMED','REOPENED')
         AND canonical_key IS NOT NULL
         AND source = 'health_check'`,
      [connectionId]
    );

    for (const ticket of openTickets) {
      if (!activeKeys.includes(ticket.canonical_key)) {
        await db.autoResolveByCanonicalKey(ticket.canonical_key, healthCheckId);
      }
    }

    console.log(`[tuneops-engine] conn=${connectionId} hc=${healthCheckId}: processed ${activeKeys.length} active findings, ${openTickets.length} open tickets checked`);

  } catch (err) {
    // Never propagate — HC completion must not be blocked
    console.error(`[tuneops-engine] error for conn=${connectionId} hc=${healthCheckId}:`, err.message);
  }
}

/**
 * seedDemoTickets(connectionId)
 *
 * Seeds 7 deterministic demo TuneOps tickets. Called once when demo health check
 * results are available. Idempotent — skips if demo tickets already exist.
 */
async function seedDemoTickets(connectionId) {
  if (!connectionId) return;

  try {
    const companyId = 'demo';
    const alreadySeeded = await db.demoTicketsExist(companyId);
    if (alreadySeeded) return;

    const demoTickets = [
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0001',
        canonicalKey: `${connectionId}:ST01_TABLESPACE_USAGE:APP_DATA`,
        title: 'APP_DATA tablespace 95.2% full',
        description: 'APP_DATA tablespace has reached 95.2% capacity (487.3 GB / 512 GB) with AUTOEXTEND disabled. Immediate action required — datafiles cannot grow beyond current limit.\n\nRecommended action: Add a new datafile or extend existing.',
        severity: 'critical',
        status: 'OPEN',
        source: 'health_check',
        sourceReference: { check_id: 'ST01_TABLESPACE_USAGE', check_category: 'Storage', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "ALTER TABLESPACE APP_DATA ADD DATAFILE SIZE 10G;",
        fixType: 'sql',
        ageMinutes: 47,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0002',
        canonicalKey: `${connectionId}:ST01_TABLESPACE_USAGE:ARCHIVE_DATA`,
        title: 'ARCHIVE_DATA tablespace 85.1% full',
        description: 'ARCHIVE_DATA tablespace is at 85.1% utilization (1,021.7 GB / 1,200 GB) with AUTOEXTEND disabled. Growth rate suggests capacity breach within 2 weeks.',
        severity: 'warning',
        status: 'CONFIRMED',
        source: 'health_check',
        sourceReference: { check_id: 'ST01_TABLESPACE_USAGE', check_category: 'Storage', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "ALTER TABLESPACE ARCHIVE_DATA ADD DATAFILE SIZE 50G;",
        fixType: 'sql',
        ageMinutes: 92,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0003',
        canonicalKey: `${connectionId}:PE01_WAIT_EVENTS:enq_TX`,
        title: 'TX row lock contention: avg 16.6ms wait',
        description: 'enq: TX - row lock contention averaging 16.6ms across 23,456 wait events in the AWR window. High contention indicates application-level locking conflicts.\n\nDiagnostic: Identify blocking sessions and review row-level locking patterns.',
        severity: 'critical',
        status: 'OPEN',
        source: 'health_check',
        sourceReference: { check_id: 'PE01_WAIT_EVENTS', check_category: 'Performance', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "SELECT blocking_session, sid, serial#, wait_class, seconds_in_wait FROM v$session WHERE blocking_session IS NOT NULL;",
        fixType: 'sql',
        ageMinutes: 15,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0004',
        canonicalKey: `${connectionId}:PE02_TOP_SQL:a1b2c3d4e5f6g`,
        title: 'High-CPU SQL: a1b2c3d4e5f6g (CPU rank #1)',
        description: 'SQL ID a1b2c3d4e5f6g is the top CPU consumer. Likely missing index or full table scan on large table. Review execution plan and consider adding index.',
        severity: 'warning',
        status: 'RESOLVED',
        source: 'health_check',
        sourceReference: { check_id: 'PE02_TOP_SQL', check_category: 'Performance', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('a1b2c3d4e5f6g', NULL, 'ALLSTATS LAST'));",
        fixType: 'sql',
        resolvedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        resolutionNotes: 'Index created on ORDERS.CUSTOMER_ID. CPU utilization dropped from 42% to 8% of DB time.',
        ageMinutes: 180,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0005',
        canonicalKey: `${connectionId}:ME01_SGA_ADVISOR`,
        title: 'SGA undersized: buffer cache recommendation',
        description: 'SGA Memory Advisor recommends increasing buffer cache. Current SGA Target is 24 GB. Estimated 18% improvement in buffer hit ratio with additional 4 GB allocation.',
        severity: 'warning',
        status: 'ACKNOWLEDGED',
        source: 'health_check',
        sourceReference: { check_id: 'ME01_SGA_ADVISOR', check_category: 'Memory', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "ALTER SYSTEM SET sga_target=28G SCOPE=BOTH;",
        fixType: 'sql',
        ageMinutes: 240,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0006',
        canonicalKey: `${connectionId}:RA01_ARCHIVELOG_SPACE`,
        title: 'Archive log destination 78% full',
        description: 'Fast Recovery Area is approaching capacity. Current utilization 78%. RMAN retention policy may need adjustment or FRA size increase to prevent archive logging issues.',
        severity: 'warning',
        status: 'OPEN',
        source: 'health_check',
        sourceReference: { check_id: 'RA01_ARCHIVELOG_SPACE', check_category: 'RMAN', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-7';",
        fixType: 'manual',
        ageMinutes: 30,
      },
      {
        companyId,
        connectionId,
        ticketNumber: 'TO-0007',
        canonicalKey: `${connectionId}:ST01_TABLESPACE_USAGE:USERS`,
        title: 'USERS tablespace 89.1% full',
        description: 'USERS tablespace is at 89.1% utilization (142.6 GB / 160 GB). AUTOEXTEND is enabled but monitoring is advised. Previously resolved — same finding recurred.',
        severity: 'warning',
        status: 'REOPENED',
        source: 'health_check',
        sourceReference: { check_id: 'ST01_TABLESPACE_USAGE', check_category: 'Storage', health_check_run_id: 0, is_demo: 'true' },
        recommendedFix: "ALTER DATABASE DATAFILE '/u01/oradata/PRODDB01/users01.dbf' AUTOEXTEND ON NEXT 1G MAXSIZE UNLIMITED;",
        fixType: 'sql',
        reopenedCount: 2,
        ageMinutes: 10,
      },
    ];

    await db.insertDemoTickets(demoTickets);
    console.log(`[tuneops-engine] Seeded ${demoTickets.length} demo tickets for conn=${connectionId}`);

  } catch (err) {
    console.error(`[tuneops-engine] demo seed error for conn=${connectionId}:`, err.message);
  }
}

module.exports = {
  processHealthCheckFindings,
  seedDemoTickets,
  buildCanonicalKey,
};
