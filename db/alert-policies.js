/**
 * db/alert-policies.js — alert_policies and alert_events query functions.
 *
 * Owns: CRUD for alert_policies, alert_events reads/writes, escalation state.
 * Does NOT own: channel notification logic (services/alert-notifier.js),
 *               policy evaluation (services/alert-policy-evaluator.js),
 *               or default policy seeding (called from routes on first login).
 */

'use strict';

const pool = require('./index');

// ── alert_policies ─────────────────────────────────────────────────────────────

/**
 * List all policies for a user (with optional connection filter).
 */
async function listPolicies(userId, { connectionId } = {}) {
  let q = `
    SELECT ap.*,
           oc.name AS connection_name
    FROM alert_policies ap
    LEFT JOIN oracle_connections oc ON oc.id = ap.connection_id
    WHERE ap.user_id = $1
  `;
  const params = [userId];
  if (connectionId !== undefined) {
    params.push(connectionId);
    q += ` AND (ap.connection_id = $${params.length} OR ap.connection_id IS NULL)`;
  }
  q += ' ORDER BY ap.is_default ASC, ap.created_at ASC';
  const { rows } = await pool.query(q, params);
  return rows;
}

/**
 * Get a single policy by id (must belong to userId).
 */
async function getPolicy(id, userId) {
  const { rows } = await pool.query(
    `SELECT ap.*, oc.name AS connection_name
     FROM alert_policies ap
     LEFT JOIN oracle_connections oc ON oc.id = ap.connection_id
     WHERE ap.id = $1 AND ap.user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

/**
 * Get active policies for a connection — used by evaluator after each health check.
 * Returns policies scoped to this connection + any "all connections" policies.
 */
async function getActivePoliciesForConnection(userId, connectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM alert_policies
     WHERE user_id = $1
       AND is_active = TRUE
       AND (connection_id = $2 OR connection_id IS NULL)
     ORDER BY is_default ASC, created_at ASC`,
    [userId, connectionId]
  );
  return rows;
}

/**
 * Create a new policy. Returns the created row.
 */
async function createPolicy({
  userId, name, checkType, connectionId,
  conditions, sustainedMinutes, notificationChannels, escalationChain, isDefault
}) {
  const { rows } = await pool.query(
    `INSERT INTO alert_policies
       (user_id, name, check_type, connection_id, conditions, sustained_minutes,
        notification_channels, escalation_chain, is_active, is_default, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,NOW(),NOW())
     RETURNING *`,
    [
      userId, name, checkType, connectionId || null,
      JSON.stringify(conditions || []),
      sustainedMinutes || null,
      JSON.stringify(notificationChannels || []),
      JSON.stringify(escalationChain || []),
      isDefault || false,
    ]
  );
  return rows[0];
}

/**
 * Update an existing policy. Partial update — only supplied fields change.
 */
async function updatePolicy(id, userId, updates) {
  const fields = [];
  const values = [];

  const allowed = ['name','check_type','connection_id','conditions','sustained_minutes',
                   'notification_channels','escalation_chain','is_active'];

  for (const [key, val] of Object.entries(updates)) {
    if (!allowed.includes(key)) continue;
    values.push(['conditions','notification_channels','escalation_chain'].includes(key)
      ? JSON.stringify(val)
      : val
    );
    fields.push(`${key} = $${values.length}`);
  }
  if (fields.length === 0) return null;

  values.push(id);
  values.push(userId);
  const { rows } = await pool.query(
    `UPDATE alert_policies
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length - 1} AND user_id = $${values.length}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Delete a policy (user-scoped). Cascades to alert_events.
 */
async function deletePolicy(id, userId) {
  const { rowCount } = await pool.query(
    'DELETE FROM alert_policies WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rowCount > 0;
}

/**
 * Toggle is_active for a policy.
 */
async function togglePolicy(id, userId, isActive) {
  const { rows } = await pool.query(
    `UPDATE alert_policies
     SET is_active = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [isActive, id, userId]
  );
  return rows[0] || null;
}

/**
 * Seed default policies for a new user if they have none yet.
 * Idempotent — skips if defaults already exist.
 */
async function seedDefaultPolicies(userId) {
  const { rows: existing } = await pool.query(
    'SELECT id FROM alert_policies WHERE user_id = $1 AND is_default = TRUE LIMIT 1',
    [userId]
  );
  if (existing.length > 0) return; // already seeded

  const defaults = [
    {
      name: 'Tablespace Warning (>90%)',
      checkType: 'tablespace_usage',
      conditions: [{ metric: 'usage_percent', operator: '>=', value: 90, severity: 'warning' }],
      notificationChannels: [{ type: 'email', config: { emails: [] }, is_active: true }],
      escalationChain: [],
    },
    {
      name: 'Tablespace Critical (>95%)',
      checkType: 'tablespace_usage',
      conditions: [{ metric: 'usage_percent', operator: '>=', value: 95, severity: 'critical' }],
      notificationChannels: [{ type: 'email', config: { emails: [] }, is_active: true }],
      escalationChain: [
        { delay_minutes: 15, notification_channels: [{ type: 'email', config: { emails: [] }, is_active: true }] }
      ],
    },
    {
      name: 'Low Health Score (<50)',
      checkType: 'health_score',
      conditions: [{ metric: 'score', operator: '<', value: 50, severity: 'warning' }],
      notificationChannels: [{ type: 'email', config: { emails: [] }, is_active: true }],
      escalationChain: [],
    },
    {
      name: 'Failed Health Check',
      checkType: 'check_failure',
      conditions: [{ metric: 'status', operator: '==', value: 'failed', severity: 'critical' }],
      notificationChannels: [{ type: 'email', config: { emails: [] }, is_active: true }],
      escalationChain: [],
    },
  ];

  for (const d of defaults) {
    await createPolicy({ userId, ...d, isDefault: true });
  }
}

// ── alert_events ───────────────────────────────────────────────────────────────

/**
 * Get open (non-resolved) events for a policy + connection pair.
 * Used for deduplication: don't re-trigger if already open.
 */
async function getOpenEvent(policyId, connectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM alert_events
     WHERE policy_id = $1
       AND connection_id = $2
       AND status IN ('triggered','acknowledged','escalated')
     ORDER BY triggered_at DESC
     LIMIT 1`,
    [policyId, connectionId]
  );
  return rows[0] || null;
}

/**
 * Create a new alert event when a policy fires.
 */
async function createEvent({ policyId, connectionId, checkRunId, currentValue, severity }) {
  const { rows } = await pool.query(
    `INSERT INTO alert_events
       (policy_id, connection_id, check_run_id, current_value, severity,
        status, escalation_step, triggered_at, notifications_sent)
     VALUES ($1,$2,$3,$4,$5,'triggered',0,NOW(),'[]')
     RETURNING *`,
    [policyId, connectionId, checkRunId || null, currentValue, severity]
  );
  return rows[0];
}

/**
 * Resolve an open alert event.
 */
async function resolveEvent(eventId) {
  await pool.query(
    `UPDATE alert_events
     SET status = 'resolved', resolved_at = NOW()
     WHERE id = $1 AND status != 'resolved'`,
    [eventId]
  );
}

/**
 * Acknowledge an event (user clicked "acknowledge").
 */
async function acknowledgeEvent(eventId, userId) {
  const { rows } = await pool.query(
    `UPDATE alert_events
     SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
     WHERE id = $1 AND status IN ('triggered','escalated')
     RETURNING *`,
    [eventId, userId]
  );
  return rows[0] || null;
}

/**
 * Append a notification attempt to the event's notifications_sent log.
 */
async function appendNotification(eventId, entry) {
  await pool.query(
    `UPDATE alert_events
     SET notifications_sent = notifications_sent || $2::jsonb
     WHERE id = $1`,
    [eventId, JSON.stringify([entry])]
  );
}

/**
 * Advance escalation step and set next_escalation_at.
 */
async function advanceEscalation(eventId, nextStep, nextEscalationAt) {
  await pool.query(
    `UPDATE alert_events
     SET escalation_step = $1,
         status = 'escalated',
         next_escalation_at = $2
     WHERE id = $3`,
    [nextStep, nextEscalationAt, eventId]
  );
}

/**
 * Get all events due for escalation.
 */
async function getDueEscalations() {
  const { rows } = await pool.query(
    `SELECT ae.*, ap.notification_channels, ap.escalation_chain, ap.name AS policy_name,
            ap.user_id,
            oc.name AS connection_name
     FROM alert_events ae
     JOIN alert_policies ap ON ap.id = ae.policy_id
     JOIN oracle_connections oc ON oc.id = ae.connection_id
     WHERE ae.status IN ('triggered','escalated')
       AND ae.next_escalation_at IS NOT NULL
       AND ae.next_escalation_at <= NOW()`
  );
  return rows;
}

/**
 * List recent events for a user (for the UI).
 */
async function listEvents(userId, { limit = 50, connectionId, status } = {}) {
  let q = `
    SELECT ae.*, ap.name AS policy_name, ap.check_type,
           oc.name AS connection_name
    FROM alert_events ae
    JOIN alert_policies ap ON ap.id = ae.policy_id
    JOIN oracle_connections oc ON oc.id = ae.connection_id
    WHERE ap.user_id = $1
  `;
  const params = [userId];
  if (connectionId) { params.push(connectionId); q += ` AND ae.connection_id = $${params.length}`; }
  if (status)       { params.push(status);       q += ` AND ae.status = $${params.length}`; }
  params.push(limit);
  q += ` ORDER BY ae.triggered_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(q, params);
  return rows;
}

// ── Queries used by evaluator ─────────────────────────────────────────────────

/**
 * Get the max tablespace usage percent across all recent ST01 check_results for a connection.
 */
async function getMaxTablespaceUsage(connectionId) {
  const { rows } = await pool.query(
    `SELECT MAX((raw_payload->>'pct_used')::numeric) AS max_pct
     FROM check_results
     WHERE connection_id = $1
       AND check_id = 'ST01_TABLESPACE_USAGE'
       AND (raw_payload->>'pct_used') IS NOT NULL
     ORDER BY executed_at DESC
     LIMIT 20`,
    [connectionId]
  );
  return rows[0]?.max_pct != null ? Number(rows[0].max_pct) : null;
}

/** Get health check score for a run. */
async function getCheckScore(checkRunId) {
  const { rows } = await pool.query(
    'SELECT score FROM health_checks WHERE id = $1',
    [checkRunId]
  );
  return rows[0]?.score != null ? Number(rows[0].score) : null;
}

/** Get session count from most recent PF01 check_result. */
async function getSessionCount(connectionId) {
  const { rows } = await pool.query(
    `SELECT (raw_payload->>'session_count')::integer AS cnt
     FROM check_results
     WHERE connection_id = $1 AND check_id = 'PF01_SESSION_COUNT'
     ORDER BY executed_at DESC LIMIT 1`,
    [connectionId]
  );
  return rows[0]?.cnt != null ? Number(rows[0].cnt) : null;
}

/** Get redo log switch frequency from most recent RA01 check_result. */
async function getRedoLogFrequency(connectionId) {
  const { rows } = await pool.query(
    `SELECT (raw_payload->>'switches_per_hour')::numeric AS freq
     FROM check_results
     WHERE connection_id = $1 AND check_id = 'RA01_LOG_SWITCH_FREQ'
     ORDER BY executed_at DESC LIMIT 1`,
    [connectionId]
  );
  return rows[0]?.freq != null ? Number(rows[0].freq) : null;
}

/** Get listener status from most recent CO02 check_result. */
async function getListenerStatus(connectionId) {
  const { rows } = await pool.query(
    `SELECT status FROM check_results
     WHERE connection_id = $1 AND check_id = 'CO02_LISTENER_STATUS'
     ORDER BY executed_at DESC LIMIT 1`,
    [connectionId]
  );
  return rows[0]?.status || null;
}

/** Get health check status (for check_failure check type). */
async function getHealthCheckStatus(checkRunId) {
  const { rows } = await pool.query(
    'SELECT status FROM health_checks WHERE id = $1',
    [checkRunId]
  );
  return rows[0]?.status || null;
}

/** Get worst check_result severity across all recent results for a connection. */
async function getWorstSeverity(connectionId) {
  const { rows } = await pool.query(
    `SELECT status FROM check_results
     WHERE connection_id = $1
     ORDER BY executed_at DESC LIMIT 100`,
    [connectionId]
  );
  const sevOrder = ['ok','green','info','amber','warning','red','critical'];
  let worst = 'ok';
  for (const r of rows) {
    if (sevOrder.indexOf(r.status) > sevOrder.indexOf(worst)) worst = r.status;
  }
  return worst;
}

/** Count completed health checks in the sustained window. */
async function getRecentCompletedCheckCount(connectionId, minutesWindow) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM health_checks
     WHERE connection_id = $1
       AND created_at > NOW() - ($2 * INTERVAL '1 minute')
       AND status = 'completed'`,
    [connectionId, minutesWindow]
  );
  return Number(rows[0]?.cnt || 0);
}

/** Get connection name and user_id for a connection. */
async function getConnectionInfo(connectionId) {
  const { rows } = await pool.query(
    'SELECT name, user_id FROM oracle_connections WHERE id = $1',
    [connectionId]
  );
  return rows[0] || null;
}

/** Get user email by userId. */
async function getUserEmail(userId) {
  const { rows } = await pool.query(
    'SELECT email FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.email || null;
}

/** Get user plan tier for tier-gating (route helper). */
async function getUserPlanTier(userId) {
  const { rows } = await pool.query(
    `SELECT uc.plan_tier, t.plan_tier AS team_tier
     FROM users u
     LEFT JOIN user_credits uc ON uc.user_id = u.id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.id = $1`,
    [userId]
  );
  const row = rows[0] || {};
  return row.team_tier || row.plan_tier || 'free';
}

/** Clear next_escalation_at on an event. */
async function clearEscalationTimer(eventId) {
  await pool.query(
    'UPDATE alert_events SET next_escalation_at = NULL WHERE id = $1',
    [eventId]
  );
}

/** Advance escalation step without changing status to 'escalated'. */
async function setEscalationStep(eventId, step) {
  await pool.query(
    'UPDATE alert_events SET escalation_step = $1, next_escalation_at = NULL WHERE id = $2',
    [step, eventId]
  );
}

/** Get first connection owned by user (for test notification context). */
async function getFirstUserConnection(userId) {
  const { rows } = await pool.query(
    'SELECT name FROM oracle_connections WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

module.exports = {
  listPolicies,
  getPolicy,
  getActivePoliciesForConnection,
  createPolicy,
  updatePolicy,
  deletePolicy,
  togglePolicy,
  seedDefaultPolicies,
  getOpenEvent,
  createEvent,
  resolveEvent,
  acknowledgeEvent,
  appendNotification,
  advanceEscalation,
  getDueEscalations,
  listEvents,
  // evaluator helpers
  getMaxTablespaceUsage,
  getCheckScore,
  getSessionCount,
  getRedoLogFrequency,
  getListenerStatus,
  getHealthCheckStatus,
  getWorstSeverity,
  getRecentCompletedCheckCount,
  getConnectionInfo,
  getUserEmail,
  getUserPlanTier,
  clearEscalationTimer,
  setEscalationStep,
  getFirstUserConnection,
};
