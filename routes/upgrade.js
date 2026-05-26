// routes/upgrade.js
// Owns: upgrade-hook data for the personalized limit-hit modal.
// Does NOT own: plan activation, payment flows, or check execution.

const express = require('express');
const router = express.Router();
const pool = require('../db/index');

// Category → recommended plan mapping.
// EBS-specific categories push to Scale; critical infra → Growth; simple → Starter.
const CATEGORY_PLAN = {
  ebs_operations: 'scale',
  ebs_cm: 'scale',
  ebs_wf: 'scale',
  ebs_adop: 'scale',
  storage: 'growth',
  memory: 'growth',
  performance: 'growth',
  backup: 'growth',
  security: 'growth',
  network: 'starter',
  parameters: 'starter',
  objects: 'starter',
};

// Copy variants keyed by check_id prefix / check_category.
// Each variant: headline fragment + urgency_line.
const COPY_VARIANTS = {
  ST01_TABLESPACE: {
    urgency: (finding) => {
      const pct = finding.metric_value;
      const daysLeft = pct ? Math.round(((100 - pct) / Math.max(pct - 70, 1)) * 14) : null;
      return daysLeft && daysLeft < 30
        ? `At current growth rate this auto-pages your on-call in ~${daysLeft} days — usually at 4am, on a Sunday.`
        : `At ${pct}% full, you have days — not weeks — before this stops Oracle cold.`;
    },
    plan_line: (plan) => `${planLabel(plan)} catches this 14 days earlier and pages you before it pages your phone.`,
  },
  ADOP: {
    urgency: () => 'Your next EBS patch window will fail without intervention — ADOP sessions don\'t self-heal.',
    plan_line: (plan) => `${planLabel(plan)} flags stuck ADOP sessions before you discover them mid-patch.`,
  },
  CM: {
    urgency: () => 'Concurrent Manager drift compounds under quarter-end load — CM will deadlock when you can least afford it.',
    plan_line: (plan) => `${planLabel(plan)} monitors CM config drift and alerts before the queue backs up.`,
  },
  AUDIT: {
    urgency: () => 'Your next SOX audit will flag this gap. Remediation after the fact costs 10× more than prevention.',
    plan_line: (plan) => `${planLabel(plan)} tracks audit log continuity so you pass — not scramble.`,
  },
  BK: {
    urgency: () => 'Your RPO violation already exceeds your stated SLA. Every hour without a backup is a liability.',
    plan_line: (plan) => `${planLabel(plan)} alerts on backup staleness before the gap becomes a breach.`,
  },
  WF: {
    urgency: () => 'Your AP team is missing approval emails right now. WF Mailer down = invoices stuck = vendor escalations.',
    plan_line: (plan) => `${planLabel(plan)} monitors WF Mailer health continuously — not just when someone complains.`,
  },
  DEFAULT: {
    urgency: (finding) => `This finding scores ${finding.metric_value !== null ? finding.metric_value : 'critically'} — left unresolved, it degrades database reliability.`,
    plan_line: (plan) => `${planLabel(plan)} monitors this check every hour so you catch it before your users do.`,
  },
};

// Mapping from internal plan slugs → user-facing label (DB $99, DB+EBS $199)
const PLAN_LABELS = { starter: 'DB ($99/mo)', growth: 'DB ($99/mo)', scale: 'DB+EBS ($199/mo)' };
function planLabel(plan) { return PLAN_LABELS[plan] || 'DB ($99/mo)'; }

function pickVariant(check_id, check_category) {
  if (!check_id) return COPY_VARIANTS.DEFAULT;
  const id = check_id.toUpperCase();
  if (id.startsWith('ST01')) return COPY_VARIANTS.ST01_TABLESPACE;
  if (id.startsWith('ADOP') || id.includes('ADOP')) return COPY_VARIANTS.ADOP;
  if (id.startsWith('CM') || id.includes('_CM_')) return COPY_VARIANTS.CM;
  if (id.startsWith('AU') || id.includes('AUDIT')) return COPY_VARIANTS.AUDIT;
  if (id.startsWith('BK')) return COPY_VARIANTS.BK;
  if (id.startsWith('WF') || check_category === 'ebs_wf') return COPY_VARIANTS.WF;
  return COPY_VARIANTS.DEFAULT;
}

function pickPlan(check_id, check_category) {
  if (!check_id && !check_category) return 'starter';
  const id = (check_id || '').toUpperCase();
  if (id.startsWith('ADOP') || id.startsWith('CM') || id.startsWith('WF') ||
      (check_category || '').startsWith('ebs')) return 'scale';
  const plan = CATEGORY_PLAN[check_category] || 'starter';
  return plan;
}

// GET /api/checks/:id/upgrade-hook
// Returns worst finding from a completed health check for the personalized upgrade modal.
// Picks the worst red check_results row (red > amber), then maps to copy variant + plan.
router.get('/:id/upgrade-hook', async (req, res) => {
  try {
    const checkId = parseInt(req.params.id, 10);
    if (!checkId || isNaN(checkId)) {
      return res.status(400).json({ error: 'Invalid check ID' });
    }

    // Confirm check exists and is completed (not a demo)
    const hcRes = await pool.query(
      `SELECT id, connection_name, overall_score, is_demo, status, metrics FROM health_checks WHERE id = $1`,
      [checkId]
    );
    if (hcRes.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }
    const hc = hcRes.rows[0];

    // Try to get worst finding from check_results (connection-scoped, requires run_id linkage)
    // We match on the connection_id via health_checks → check_results via connection_id + executed_at
    // Strategy: find check_results rows created near this health check's completed_at
    let worstFinding = null;

    if (hc.status === 'completed' && !hc.is_demo) {
      // check_results rows are inserted during the run — match by connection_id
      // Get connection_id from health_checks
      const connRes = await pool.query(
        `SELECT connection_id, completed_at FROM health_checks WHERE id = $1`,
        [checkId]
      );
      const connId = connRes.rows[0]?.connection_id;
      const completedAt = connRes.rows[0]?.completed_at;

      if (connId && completedAt) {
        // Find worst check result near this run (within 10 min window around completion)
        const crRes = await pool.query(
          `SELECT check_id, check_category, status, metric_name, metric_value, metric_unit, ai_summary, recommendation
           FROM check_results
           WHERE connection_id = $1
             AND executed_at BETWEEN $2::timestamptz - interval '15 minutes'
                                  AND $2::timestamptz + interval '5 minutes'
           ORDER BY
             CASE status WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END,
             ABS(COALESCE(metric_value, 0)) DESC
           LIMIT 1`,
          [connId, completedAt]
        );
        worstFinding = crRes.rows[0] || null;
      }
    }

    // Fallback: synthesize from metrics JSON in health_checks if no check_results found
    if (!worstFinding && hc.metrics && hc.metrics.tablespaces) {
      const worst = (hc.metrics.tablespaces || [])
        .filter(ts => ts.pct_used > 80)
        .sort((a, b) => b.pct_used - a.pct_used)[0];
      if (worst) {
        worstFinding = {
          check_id: 'ST01_TABLESPACE_USAGE',
          check_category: 'storage',
          status: worst.pct_used > 90 ? 'red' : 'amber',
          metric_name: 'pct_used',
          metric_value: worst.pct_used,
          metric_unit: '%',
          ai_summary: `${worst.name}: ${worst.pct_used}% used (${worst.used_gb}GB / ${worst.total_gb}GB)`,
          recommendation: worst.pct_used > 90 ? 'CRITICAL: Add datafile or extend tablespace immediately' : null,
        };
      }
    }

    // If still no finding, return a generic hook
    if (!worstFinding) {
      return res.json({
        found: false,
        check_id: null,
        category: null,
        title: 'Multiple issues detected',
        current_value: null,
        threshold: null,
        urgency_line: 'Your free health check surfaced findings that need DBA attention. Upgrade to run continuous checks and catch issues before they page you.',
        plan_line: 'DB ($99/mo) runs checks every hour and emails you before the on-call phone rings.',
        recommended_plan: 'starter',
        health_check_id: checkId,
        connection_name: hc.connection_name,
        overall_score: hc.overall_score,
      });
    }

    const variant = pickVariant(worstFinding.check_id, worstFinding.check_category);
    const plan = pickPlan(worstFinding.check_id, worstFinding.check_category);
    const urgencyLine = typeof variant.urgency === 'function' ? variant.urgency(worstFinding) : variant.urgency;
    const planLine = typeof variant.plan_line === 'function' ? variant.plan_line(plan) : variant.plan_line;

    // Derive human-readable title from ai_summary or check_id
    const title = worstFinding.ai_summary ||
      (worstFinding.check_id || '').replace(/_/g, ' ').replace(/^[A-Z0-9]+ /, '');

    res.json({
      found: true,
      check_id: worstFinding.check_id,
      category: worstFinding.check_category,
      title,
      current_value: worstFinding.metric_value,
      metric_unit: worstFinding.metric_unit,
      threshold: worstFinding.status === 'red' ? 90 : 80,
      urgency_line: urgencyLine,
      plan_line: planLine,
      recommended_plan: plan,
      health_check_id: checkId,
      connection_name: hc.connection_name,
      overall_score: hc.overall_score,
      severity: worstFinding.status === 'red' ? 'critical' : 'high',
    });
  } catch (err) {
    console.error('[upgrade-hook] error:', err.message);
    res.status(500).json({ error: 'Failed to load upgrade hook' });
  }
});

module.exports = router;
