/**
 * routes/roadmap-reminders.js — Roadmap reminder admin API.
 *
 * Owns: listing roadmap reminders and their surface status, flipping the manual
 *       feature flag, dismissing a reminder, and evaluating auto-trigger conditions.
 * Does NOT own: user auth, health check logic, payments.
 *
 * Mounted at: /api/admin/roadmap-reminders (see server.js)
 * Access: admin only (ADMIN_EMAILS env var)
 */

'use strict';

const express = require('express');
const pool    = require('../db/index');
const db      = require('../db/roadmap-reminders');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── TRIGGER EVALUATION ─────────────────────────────────────────────────────

/**
 * Returns true when a reminder's trigger condition is satisfied.
 *
 * Supported trigger_condition_json shapes:
 *   { "paying_customers_gte": N }     — true when paying customers >= N
 *   { "feature_flag": "<flag_name>" } — true when reminder row has manual_flag = true
 *   { "always": true }                — always true
 *   Compound conditions are OR'd together (any condition met = surface it).
 */
async function evalTrigger(reminder, payingCount) {
  const cond = reminder.trigger_condition_json;
  if (!cond) return false;
  if (cond.always) return true;

  // Paying customer count threshold
  if (typeof cond.paying_customers_gte === 'number') {
    if (payingCount >= cond.paying_customers_gte) return true;
  }

  // Manual feature flag stored on the reminder row itself
  if (cond.feature_flag && reminder.manual_flag) return true;

  return false;
}

// Count distinct paying users (subscriptions active OR one_time payments captured)
async function getPayingCustomersCount() {
  try {
    const result = await pool.query(`
      SELECT COUNT(DISTINCT user_id) AS cnt FROM (
        SELECT user_id FROM subscriptions WHERE status IN ('active','authenticated')
        UNION
        SELECT user_id FROM payments WHERE status = 'captured'
      ) AS paid
    `);
    return parseInt(result.rows[0]?.cnt ?? 0, 10);
  } catch {
    return 0;
  }
}

// ─── GET /api/admin/roadmap-reminders ───────────────────────────────────────
// Returns all reminders, each annotated with `should_surface` based on trigger evaluation.

router.get('/', requireAdmin, async (req, res) => {
  try {
    const reminders    = await db.listReminders();
    const payingCount  = await getPayingCustomersCount();

    const annotated = await Promise.all(
      reminders.map(async (r) => {
        const should_surface = r.dismissed_at ? false : await evalTrigger(r, payingCount);
        // Record first surfaced_at when condition fires
        if (should_surface && !r.surfaced_at) {
          await db.markSurfaced(r.id).catch(() => {});
        }
        return { ...r, should_surface, paying_customers_count: payingCount };
      })
    );

    res.json({ reminders: annotated, paying_customers_count: payingCount });
  } catch (err) {
    console.error('[roadmap-reminders] list failed:', err.message);
    res.status(500).json({ error: 'Failed to load reminders' });
  }
});

// ─── POST /api/admin/roadmap-reminders/:id/flag ──────────────────────────────
// Manually flip show_agency_reminder flag (sets manual_flag = true/false).

router.post('/:id/flag', requireAdmin, async (req, res) => {
  const { id }      = req.params;
  const { enabled } = req.body;
  try {
    const reminder = await db.setManualFlag(parseInt(id, 10), enabled);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ reminder });
  } catch (err) {
    console.error('[roadmap-reminders] flag update failed:', err.message);
    res.status(500).json({ error: 'Failed to update flag' });
  }
});

// ─── POST /api/admin/roadmap-reminders/:id/dismiss ───────────────────────────
// Admin dismisses the reminder card.

router.post('/:id/dismiss', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const reminder = await db.dismissReminder(parseInt(id, 10));
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ reminder });
  } catch (err) {
    console.error('[roadmap-reminders] dismiss failed:', err.message);
    res.status(500).json({ error: 'Failed to dismiss' });
  }
});

// ─── POST /api/admin/roadmap-reminders/:id/resurface ─────────────────────────
// Un-dismiss a previously dismissed reminder.

router.post('/:id/resurface', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const reminder = await db.resurfaceReminder(parseInt(id, 10));
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    res.json({ reminder });
  } catch (err) {
    console.error('[roadmap-reminders] resurface failed:', err.message);
    res.status(500).json({ error: 'Failed to resurface' });
  }
});

module.exports = router;
