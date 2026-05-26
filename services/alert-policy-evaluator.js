/**
 * services/alert-policy-evaluator.js — evaluates alert policies after each health check run.
 *
 * Owns: loading active policies, evaluating conditions against check_results,
 *       checking sustained_minutes, creating/resolving alert_events, triggering notifications,
 *       and scheduling escalation timers.
 * Does NOT own: policy CRUD (db/alert-policies.js), channel dispatch (services/alert-notifier.js),
 *               or health check execution. All queries go through db/alert-policies.js.
 *
 * Called from services/schedule-runner.js after each delta run.
 * Errors are always caught and logged — never bubble to the caller.
 */

'use strict';

const alertDb  = require('../db/alert-policies');
const notifier = require('./alert-notifier');

// ── Operator evaluators ───────────────────────────────────────────────────────

const OPS = {
  '>=' : (a, b) => Number(a) >= Number(b),
  '>'  : (a, b) => Number(a) >  Number(b),
  '<=' : (a, b) => Number(a) <= Number(b),
  '<'  : (a, b) => Number(a) <  Number(b),
  '==' : (a, b) => String(a) === String(b),
  '!=' : (a, b) => String(a) !== String(b),
};

function evalCondition(cond, value) {
  const fn = OPS[cond.operator];
  if (!fn) return false;
  return fn(value, cond.value);
}

// ── Metric extractors per check_type ─────────────────────────────────────────

async function extractMetric(checkType, connectionId, checkRunId) {
  if (checkType === 'tablespace_usage') {
    const v = await alertDb.getMaxTablespaceUsage(connectionId);
    return { metric: 'usage_percent', value: v, displayValue: v != null ? `${v}%` : null };
  }
  if (checkType === 'health_score') {
    const v = await alertDb.getCheckScore(checkRunId);
    return { metric: 'score', value: v, displayValue: v != null ? `${v}/100` : null };
  }
  if (checkType === 'session_count') {
    const v = await alertDb.getSessionCount(connectionId);
    return { metric: 'session_count', value: v, displayValue: v != null ? `${v} sessions` : null };
  }
  if (checkType === 'redo_log_frequency') {
    const v = await alertDb.getRedoLogFrequency(connectionId);
    return { metric: 'switches_per_hour', value: v, displayValue: v != null ? `${v}/hr` : null };
  }
  if (checkType === 'listener_status') {
    const s = await alertDb.getListenerStatus(connectionId);
    return { metric: 'status', value: s, displayValue: s };
  }
  if (checkType === 'check_failure') {
    const s = await alertDb.getHealthCheckStatus(checkRunId);
    return { metric: 'status', value: s === 'failed' ? 'failed' : 'ok', displayValue: s };
  }
  // Generic fallback — worst severity
  const worst = await alertDb.getWorstSeverity(connectionId);
  return { metric: 'severity', value: worst, displayValue: worst };
}

// ── Sustained check ───────────────────────────────────────────────────────────

async function wasSustained(connectionId, sustainedMinutes) {
  if (!sustainedMinutes) return true;
  const count = await alertDb.getRecentCompletedCheckCount(connectionId, sustainedMinutes);
  return count >= 2;
}

// ── Main evaluator ────────────────────────────────────────────────────────────

async function evaluatePoliciesForConnection(userId, connectionId, checkRunId) {
  if (!userId || !connectionId) return;

  try {
    const policies = await alertDb.getActivePoliciesForConnection(userId, connectionId);
    if (policies.length === 0) return;

    for (const policy of policies) {
      try {
        await evaluatePolicy(policy, connectionId, checkRunId);
      } catch (err) {
        console.warn(`[alert-evaluator] policy ${policy.id} error:`, err.message);
      }
    }

    await runDueEscalations();

  } catch (err) {
    console.error('[alert-evaluator] top-level error for conn', connectionId, err.message);
  }
}

async function evaluatePolicy(policy, connectionId, checkRunId) {
  const { value, displayValue } = await extractMetric(policy.check_type, connectionId, checkRunId);
  if (value === null) return;

  const conditions = Array.isArray(policy.conditions) ? policy.conditions : [];
  if (conditions.length === 0) return;

  let firedCondition = null;
  for (const cond of conditions) {
    if (evalCondition(cond, value)) {
      if (!firedCondition || severityRank(cond.severity) > severityRank(firedCondition.severity)) {
        firedCondition = cond;
      }
    }
  }

  const openEvent = await alertDb.getOpenEvent(policy.id, connectionId);

  if (!firedCondition) {
    if (openEvent) {
      await alertDb.resolveEvent(openEvent.id);
      console.log(`[alert-evaluator] policy ${policy.id} resolved for conn ${connectionId}`);
    }
    return;
  }

  if (policy.sustained_minutes && !openEvent) {
    const sustained = await wasSustained(connectionId, policy.sustained_minutes);
    if (!sustained) {
      console.log(`[alert-evaluator] policy ${policy.id} condition met but not yet sustained, skipping`);
      return;
    }
  }

  if (openEvent) return; // already open, don't re-fire

  const event = await alertDb.createEvent({
    policyId    : policy.id,
    connectionId,
    checkRunId,
    currentValue: displayValue,
    severity    : firedCondition.severity || 'warning',
  });

  console.log(`[alert-evaluator] policy ${policy.id} TRIGGERED — conn ${connectionId}, value: ${displayValue}`);

  const connInfo  = await alertDb.getConnectionInfo(connectionId);
  const userEmail = await alertDb.getUserEmail(policy.user_id);

  const channels = fillDefaultEmails(policy.notification_channels, userEmail);

  const context = {
    policyName   : policy.name,
    connectionName: connInfo?.name || `Connection ${connectionId}`,
    connectionId,
    severity     : firedCondition.severity || 'warning',
    currentValue : displayValue,
    checkType    : policy.check_type,
    eventId      : event.id,
  };

  const results = await notifier.sendNotifications(channels, context);
  for (const r of results) {
    await alertDb.appendNotification(event.id, { step: 0, ...r });
  }

  // Set up escalation timer if chain exists
  const esc = Array.isArray(policy.escalation_chain) ? policy.escalation_chain : [];
  if (esc.length > 0) {
    const first  = esc[0];
    const nextAt = new Date(Date.now() + (first.delay_minutes || 15) * 60 * 1000);
    await alertDb.advanceEscalation(event.id, 0, nextAt);
  }
}

function fillDefaultEmails(channels, userEmail) {
  if (!userEmail || !Array.isArray(channels)) return channels || [];
  return channels.map(ch => {
    if (ch.type === 'email' && Array.isArray(ch.config?.emails) && ch.config.emails.length === 0) {
      return { ...ch, config: { ...ch.config, emails: [userEmail] } };
    }
    return ch;
  });
}

function severityRank(s) {
  return { info: 1, warning: 2, critical: 3 }[s] || 0;
}

// ── Escalation runner ─────────────────────────────────────────────────────────

async function runDueEscalations() {
  try {
    const dueEvents = await alertDb.getDueEscalations();
    for (const event of dueEvents) {
      try {
        await processEscalation(event);
      } catch (err) {
        console.warn(`[alert-evaluator] escalation error event ${event.id}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[alert-evaluator] getDueEscalations error:', err.message);
  }
}

async function processEscalation(event) {
  const escalation = Array.isArray(event.escalation_chain) ? event.escalation_chain : [];
  const nextStep   = event.escalation_step + 1;

  if (nextStep >= escalation.length) {
    await alertDb.clearEscalationTimer(event.id);
    return;
  }

  const step     = escalation[nextStep];
  const channels = step.notification_channels || [];
  const userEmail = await alertDb.getUserEmail(event.user_id);

  const context = {
    policyName    : event.policy_name,
    connectionName: event.connection_name,
    connectionId  : event.connection_id,
    severity      : event.severity,
    currentValue  : event.current_value,
    checkType     : '',
    eventId       : event.id,
  };

  const results = await notifier.sendNotifications(fillDefaultEmails(channels, userEmail), context);
  for (const r of results) {
    await alertDb.appendNotification(event.id, { step: nextStep, ...r });
  }

  const hasMoreSteps = (nextStep + 1) < escalation.length;
  if (hasMoreSteps) {
    const nextEscStep = escalation[nextStep + 1];
    const nextAt = new Date(Date.now() + (nextEscStep.delay_minutes || 30) * 60 * 1000);
    await alertDb.advanceEscalation(event.id, nextStep, nextAt);
  } else {
    await alertDb.setEscalationStep(event.id, nextStep);
  }

  console.log(`[alert-evaluator] escalation step ${nextStep} fired for event ${event.id}`);
}

module.exports = { evaluatePoliciesForConnection, runDueEscalations };
