/**
 * db/tuneops-tickets.js — tuneops_tickets table queries.
 *
 * Owns: CRUD for tuneops_tickets, ticket number generation, canonical key lookup.
 * Does NOT own: ticket lifecycle business logic (services/tuneops-ticket-engine.js),
 *               API routing (routes/tuneops.js), or health check execution.
 */

'use strict';

const pool = require('./index');

// ── Ticket number generation ──────────────────────────────────────────────────

/**
 * Generates the next TO-XXXX number for a company.
 * Scoped per company_domain or connection owner.
 * Format: TO-0001 through TO-9999 then TO-10000+.
 */
async function nextTicketNumber(companyId) {
  const { rows } = await pool.query(
    `SELECT ticket_number FROM tuneops_tickets
     WHERE company_id = $1
     ORDER BY id DESC LIMIT 1`,
    [companyId]
  );

  let seq = 1;
  if (rows.length > 0) {
    const last = rows[0].ticket_number; // e.g. "TO-0042"
    const num = parseInt(last.replace('TO-', ''), 10);
    if (!isNaN(num)) seq = num + 1;
  }

  const padded = seq <= 9999
    ? String(seq).padStart(4, '0')
    : String(seq);
  return `TO-${padded}`;
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Creates a new ticket. Returns the created row.
 */
async function createTicket({
  companyId,
  connectionId,
  title,
  description,
  severity,
  status = 'OPEN',
  source = 'health_check',
  sourceReference = {},
  canonicalKey = null,
  recommendedFix = null,
  fixType = null,
  requiresApproval = false,
  assignedTo = null,
}) {
  const ticketNumber = await nextTicketNumber(companyId);

  const { rows } = await pool.query(
    `INSERT INTO tuneops_tickets
       (company_id, connection_id, ticket_number, canonical_key, title, description,
        severity, status, source, source_reference, assigned_to,
        recommended_fix, fix_type, requires_approval, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
     RETURNING *`,
    [
      companyId, connectionId, ticketNumber, canonicalKey,
      title, description, severity, status, source,
      JSON.stringify(sourceReference), assignedTo,
      recommendedFix, fixType, requiresApproval,
    ]
  );
  return rows[0];
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Find tickets by canonical key that are in OPEN or ACKNOWLEDGED status.
 * Used for dedup during health check processing.
 */
async function findOpenByCanonicalKey(canonicalKey) {
  const { rows } = await pool.query(
    `SELECT * FROM tuneops_tickets
     WHERE canonical_key = $1
       AND status IN ('OPEN','ACKNOWLEDGED','CONFIRMED','EXECUTING','REOPENED')
     ORDER BY created_at DESC LIMIT 1`,
    [canonicalKey]
  );
  return rows[0] || null;
}

/**
 * Find the most recent RESOLVED ticket with this canonical key.
 */
async function findResolvedByCanonicalKey(canonicalKey) {
  const { rows } = await pool.query(
    `SELECT * FROM tuneops_tickets
     WHERE canonical_key = $1
       AND status = 'RESOLVED'
     ORDER BY resolved_at DESC LIMIT 1`,
    [canonicalKey]
  );
  return rows[0] || null;
}

/**
 * Get a single ticket by ticket_number.
 */
async function getByTicketNumber(ticketNumber) {
  const { rows } = await pool.query(
    `SELECT t.*,
            u_assigned.email AS assigned_to_email,
            u_approved.email AS approved_by_email,
            u_executed.email AS executed_by_email,
            u_resolved.email AS resolved_by_email
     FROM tuneops_tickets t
     LEFT JOIN users u_assigned ON u_assigned.id = t.assigned_to
     LEFT JOIN users u_approved ON u_approved.id = t.approved_by
     LEFT JOIN users u_executed ON u_executed.id = t.executed_by
     LEFT JOIN users u_resolved ON u_resolved.id = t.resolved_by
     WHERE t.ticket_number = $1`,
    [ticketNumber]
  );
  return rows[0] || null;
}

/**
 * List tickets with optional filters.
 * Returns paginated results (50 per page).
 */
async function listTickets({ companyId, connectionId, status, severity, assignedTo, page = 1 } = {}) {
  const conditions = ['1=1'];
  const params = [];
  let p = 1;

  if (companyId) {
    conditions.push(`t.company_id = $${p++}`);
    params.push(companyId);
  }
  if (connectionId) {
    conditions.push(`t.connection_id = $${p++}`);
    params.push(connectionId);
  }
  if (status) {
    conditions.push(`t.status = $${p++}`);
    params.push(status);
  }
  if (severity) {
    conditions.push(`t.severity = $${p++}`);
    params.push(severity);
  }
  if (assignedTo) {
    conditions.push(`t.assigned_to = $${p++}`);
    params.push(assignedTo);
  }

  const offset = (page - 1) * 50;
  params.push(50, offset);

  const { rows } = await pool.query(
    `SELECT t.*,
            oc.name AS connection_name,
            u_assigned.email AS assigned_to_email
     FROM tuneops_tickets t
     LEFT JOIN oracle_connections oc ON oc.id = t.connection_id
     LEFT JOIN users u_assigned ON u_assigned.id = t.assigned_to
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE t.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
       t.created_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    params
  );
  return rows;
}

/**
 * Count tickets matching filters (for pagination).
 */
async function countTickets({ companyId, connectionId, status, severity, assignedTo } = {}) {
  const conditions = ['1=1'];
  const params = [];
  let p = 1;

  if (companyId) { conditions.push(`company_id = $${p++}`); params.push(companyId); }
  if (connectionId) { conditions.push(`connection_id = $${p++}`); params.push(connectionId); }
  if (status) { conditions.push(`status = $${p++}`); params.push(status); }
  if (severity) { conditions.push(`severity = $${p++}`); params.push(severity); }
  if (assignedTo) { conditions.push(`assigned_to = $${p++}`); params.push(assignedTo); }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM tuneops_tickets WHERE ${conditions.join(' AND ')}`,
    params
  );
  return rows[0].total;
}

// ── Dashboard stats ───────────────────────────────────────────────────────────

/**
 * Returns stats for the TuneOps dashboard widget.
 */
async function getStats(companyId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','ACKNOWLEDGED'))::int                  AS open_total,
       COUNT(*) FILTER (WHERE severity='critical' AND status NOT IN ('RESOLVED','ACKNOWLEDGED'))::int AS open_critical,
       COUNT(*) FILTER (WHERE severity='warning'  AND status NOT IN ('RESOLVED','ACKNOWLEDGED'))::int AS open_warning,
       COUNT(*) FILTER (WHERE severity='info'     AND status NOT IN ('RESOLVED','ACKNOWLEDGED'))::int AS open_info,
       COUNT(*) FILTER (WHERE status='RESOLVED'
                          AND resolved_at >= NOW() - INTERVAL '7 days')::int                   AS resolved_this_week,
       COUNT(*) FILTER (WHERE reopened_count > 0)::int                                         AS total_reopened,
       ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)
         FILTER (WHERE status='RESOLVED' AND resolved_at IS NOT NULL))::int                    AS avg_resolution_hours
     FROM tuneops_tickets
     WHERE company_id = $1`,
    [companyId]
  );
  return rows[0];
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Transition ticket to CONFIRMED status.
 */
async function confirmTicket(ticketNumber) {
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET status = 'CONFIRMED', updated_at = NOW()
     WHERE ticket_number = $1 AND status IN ('OPEN','REOPENED')
     RETURNING *`,
    [ticketNumber]
  );
  return rows[0] || null;
}

/**
 * Transition ticket to EXECUTING status.
 * Blocked if requires_approval=true and approved_by is null (stub: always passes for Individual).
 */
async function executeTicket(ticketNumber, executedBy) {
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET status = 'EXECUTING', executed_by = $2, executed_at = NOW(), updated_at = NOW()
     WHERE ticket_number = $1 AND status = 'CONFIRMED'
     RETURNING *`,
    [ticketNumber, executedBy]
  );
  return rows[0] || null;
}

/**
 * Transition ticket to RESOLVED with optional notes.
 */
async function resolveTicket(ticketNumber, resolvedBy, resolutionNotes = null, executionResult = null) {
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET status = 'RESOLVED',
         resolved_by = $2,
         resolved_at = NOW(),
         resolution_notes = $3,
         execution_result = COALESCE($4::jsonb, execution_result),
         updated_at = NOW()
     WHERE ticket_number = $1 AND status IN ('EXECUTING','CONFIRMED','OPEN','REOPENED')
     RETURNING *`,
    [ticketNumber, resolvedBy, resolutionNotes, executionResult ? JSON.stringify(executionResult) : null]
  );
  return rows[0] || null;
}

/**
 * Transition ticket to ACKNOWLEDGED status.
 */
async function acknowledgeTicket(ticketNumber, userId) {
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET status = 'ACKNOWLEDGED', assigned_to = $2, updated_at = NOW()
     WHERE ticket_number = $1 AND status IN ('OPEN','REOPENED')
     RETURNING *`,
    [ticketNumber, userId]
  );
  return rows[0] || null;
}

/**
 * Reopen a RESOLVED ticket (increments reopened_count).
 */
async function reopenTicket(ticketId, { severity, title, description } = {}) {
  const setClauses = [
    'status = \'REOPENED\'',
    'reopened_count = reopened_count + 1',
    'resolved_at = NULL',
    'resolved_by = NULL',
    'resolution_notes = NULL',
    'updated_at = NOW()',
  ];
  const params = [ticketId];
  let p = 2;

  if (severity) { setClauses.push(`severity = $${p++}`); params.push(severity); }
  if (title) { setClauses.push(`title = $${p++}`); params.push(title); }
  if (description) { setClauses.push(`description = $${p++}`); params.push(description); }

  const { rows } = await pool.query(
    `UPDATE tuneops_tickets SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

/**
 * Auto-resolve a ticket by canonical key (health check cleared the finding).
 */
async function autoResolveByCanonicalKey(canonicalKey, healthCheckId) {
  const notes = `Auto-resolved — finding cleared on health check run #${healthCheckId}`;
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET status = 'RESOLVED',
         resolved_at = NOW(),
         resolution_notes = $2,
         updated_at = NOW()
     WHERE canonical_key = $1
       AND status IN ('OPEN','ACKNOWLEDGED','CONFIRMED','REOPENED')
     RETURNING *`,
    [canonicalKey, notes]
  );
  return rows;
}

/**
 * Update severity (worsening only) on an open ticket.
 */
async function worsenSeverity(ticketId, newSeverity, description) {
  const SEV_RANK = { info: 1, warning: 2, critical: 3 };

  // Only update if new severity is actually worse
  const { rows } = await pool.query(
    `UPDATE tuneops_tickets
     SET severity = $2,
         description = $3,
         updated_at = NOW()
     WHERE id = $1
       AND (CASE severity WHEN 'info' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END)
           < (CASE $2::text WHEN 'info' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END)
     RETURNING *`,
    [ticketId, newSeverity, description]
  );
  return rows[0] || null;
}

/**
 * General-purpose patch for status, assignment, notes.
 */
async function patchTicket(ticketNumber, { assignedTo, resolutionNotes, description }) {
  const setClauses = ['updated_at = NOW()'];
  const params = [ticketNumber];
  let p = 2;

  if (assignedTo !== undefined) { setClauses.push(`assigned_to = $${p++}`); params.push(assignedTo); }
  if (resolutionNotes !== undefined) { setClauses.push(`resolution_notes = $${p++}`); params.push(resolutionNotes); }
  if (description !== undefined) { setClauses.push(`description = $${p++}`); params.push(description); }

  if (setClauses.length === 1) return null; // nothing to update

  const { rows } = await pool.query(
    `UPDATE tuneops_tickets SET ${setClauses.join(', ')} WHERE ticket_number = $1 RETURNING *`,
    params
  );
  return rows[0] || null;
}

// ── Demo seeding ──────────────────────────────────────────────────────────────

/**
 * Returns true if demo tickets already exist for this company.
 */
async function demoTicketsExist(companyId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tuneops_tickets WHERE company_id = $1 AND source_reference->>'is_demo' = 'true' LIMIT 1`,
    [companyId]
  );
  return rows.length > 0;
}

/**
 * Bulk insert demo tickets (used during demo health check seeding).
 */
async function insertDemoTickets(tickets) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const t of tickets) {
      const { rows } = await client.query(
        `INSERT INTO tuneops_tickets
           (company_id, connection_id, ticket_number, canonical_key, title, description,
            severity, status, source, source_reference, recommended_fix, fix_type,
            requires_approval, reopened_count,
            resolved_at, resolution_notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 NOW() - ($17 || ' minutes')::interval,
                 NOW() - ($17 || ' minutes')::interval)
         ON CONFLICT (ticket_number) DO NOTHING
         RETURNING *`,
        [
          t.companyId, t.connectionId, t.ticketNumber, t.canonicalKey,
          t.title, t.description, t.severity, t.status,
          t.source, JSON.stringify(t.sourceReference),
          t.recommendedFix, t.fixType, false, t.reopenedCount || 0,
          t.resolvedAt || null, t.resolutionNotes || null,
          t.ageMinutes || 0,
        ]
      );
      if (rows[0]) created.push(rows[0]);
    }
    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createTicket,
  findOpenByCanonicalKey,
  findResolvedByCanonicalKey,
  getByTicketNumber,
  listTickets,
  countTickets,
  getStats,
  confirmTicket,
  executeTicket,
  resolveTicket,
  acknowledgeTicket,
  reopenTicket,
  autoResolveByCanonicalKey,
  worsenSeverity,
  patchTicket,
  demoTicketsExist,
  insertDemoTickets,
  nextTicketNumber,
};
