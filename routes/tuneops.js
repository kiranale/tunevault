/**
 * routes/tuneops.js — TuneOps ticketing system API.
 *
 * Owns: GET/POST /api/tuneops/tickets, PATCH/action endpoints per ticket,
 *       GET /api/tuneops/stats, GET /tuneops (page redirect).
 * Does NOT own: ticket auto-creation logic (services/tuneops-ticket-engine.js),
 *               CRUD queries (db/tuneops-tickets.js), health check execution.
 *
 * All endpoints require auth. Status transitions enforce valid state machine.
 */

'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db/tuneops-tickets');
const pool = require('../db/index');
const { resolveTier } = require('../services/tier-limits');

const router = express.Router();

// ── Company ID resolution ─────────────────────────────────────────────────────

/**
 * Resolves companyId from the authenticated user.
 * Uses company_domain; falls back to user email domain.
 */
function companyIdForUser(user) {
  return user.company_domain || user.email.split('@')[1] || `user_${user.id}`;
}

// ── GET /api/tuneops/stats ────────────────────────────────────────────────────

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const companyId = companyIdForUser(req.user);
    const stats = await db.getStats(companyId);
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[tuneops] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch TuneOps stats' });
  }
});

// ── GET /api/tuneops/tickets ──────────────────────────────────────────────────

router.get('/tickets', requireAuth, async (req, res) => {
  try {
    const companyId = companyIdForUser(req.user);
    const { status, severity, connection_id, assigned_to, page = 1 } = req.query;

    const filters = { companyId };
    if (status) filters.status = status;
    if (severity) filters.severity = severity;
    if (connection_id) filters.connectionId = parseInt(connection_id, 10);
    if (assigned_to) filters.assignedTo = parseInt(assigned_to, 10);

    const [tickets, total] = await Promise.all([
      db.listTickets({ ...filters, page: parseInt(page, 10) }),
      db.countTickets(filters),
    ]);

    res.json({ success: true, tickets, total, page: parseInt(page, 10), per_page: 50 });
  } catch (err) {
    console.error('[tuneops] list tickets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// ── GET /api/tuneops/tickets/:ticket_number ───────────────────────────────────

router.get('/tickets/:ticket_number', requireAuth, async (req, res) => {
  try {
    const ticket = await db.getByTicketNumber(req.params.ticket_number);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Ownership gate: ticket must belong to user's company
    const companyId = companyIdForUser(req.user);
    if (ticket.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] get ticket error:', err.message);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// ── POST /api/tuneops/tickets ─────────────────────────────────────────────────

router.post('/tickets', requireAuth, async (req, res) => {
  try {
    const companyId = companyIdForUser(req.user);
    const {
      connection_id,
      title,
      description,
      severity = 'info',
      recommended_fix,
      fix_type,
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });

    const validSeverities = ['critical', 'warning', 'info'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({ error: `severity must be one of: ${validSeverities.join(', ')}` });
    }

    const ticket = await db.createTicket({
      companyId,
      connectionId: connection_id || null,
      title,
      description: description || null,
      severity,
      status: 'OPEN',
      source: 'manual',
      sourceReference: { created_by: req.user.id },
      recommendedFix: recommended_fix || null,
      fixType: fix_type || null,
    });

    res.status(201).json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] create ticket error:', err.message);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// ── PATCH /api/tuneops/tickets/:ticket_number ─────────────────────────────────

router.patch('/tickets/:ticket_number', requireAuth, async (req, res) => {
  try {
    const { ticket_number } = req.params;

    // Ownership check
    const existing = await db.getByTicketNumber(ticket_number);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const companyId = companyIdForUser(req.user);
    if (existing.company_id !== companyId) return res.status(403).json({ error: 'Access denied' });

    const { assigned_to, resolution_notes, description } = req.body;
    const ticket = await db.patchTicket(ticket_number, { assignedTo: assigned_to, resolutionNotes: resolution_notes, description });
    res.json({ success: true, ticket: ticket || existing });
  } catch (err) {
    console.error('[tuneops] patch ticket error:', err.message);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// ── POST /api/tuneops/tickets/:ticket_number/confirm ──────────────────────────

router.post('/tickets/:ticket_number/confirm', requireAuth, async (req, res) => {
  try {
    const existing = await db.getByTicketNumber(req.params.ticket_number);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const companyId = companyIdForUser(req.user);
    if (existing.company_id !== companyId) return res.status(403).json({ error: 'Access denied' });

    if (!['OPEN', 'REOPENED'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot confirm a ticket in ${existing.status} status` });
    }

    const ticket = await db.confirmTicket(req.params.ticket_number);
    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] confirm ticket error:', err.message);
    res.status(500).json({ error: 'Failed to confirm ticket' });
  }
});

// ── POST /api/tuneops/tickets/:ticket_number/execute ──────────────────────────

router.post('/tickets/:ticket_number/execute', requireAuth, async (req, res) => {
  try {
    const existing = await db.getByTicketNumber(req.params.ticket_number);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const companyId = companyIdForUser(req.user);
    if (existing.company_id !== companyId) return res.status(403).json({ error: 'Access denied' });

    if (existing.status !== 'CONFIRMED') {
      return res.status(409).json({ error: `Cannot execute a ticket in ${existing.status} status. Must be CONFIRMED first.` });
    }

    // Approval stub: always passes for Individual tier.
    // Full approval routing handled by Role Hierarchy task.
    if (existing.requires_approval && !existing.approved_by) {
      const tier = await resolveTier(req.user.id, req.user.email).catch(() => 'individual');
      if (tier !== 'individual') {
        return res.status(403).json({
          error: 'Approval required before execution',
          code: 'APPROVAL_REQUIRED',
        });
      }
    }

    const ticket = await db.executeTicket(req.params.ticket_number, req.user.id);
    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] execute ticket error:', err.message);
    res.status(500).json({ error: 'Failed to execute ticket' });
  }
});

// ── POST /api/tuneops/tickets/:ticket_number/resolve ──────────────────────────

router.post('/tickets/:ticket_number/resolve', requireAuth, async (req, res) => {
  try {
    const existing = await db.getByTicketNumber(req.params.ticket_number);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const companyId = companyIdForUser(req.user);
    if (existing.company_id !== companyId) return res.status(403).json({ error: 'Access denied' });

    if (['RESOLVED', 'ACKNOWLEDGED'].includes(existing.status)) {
      return res.status(409).json({ error: `Ticket is already ${existing.status}` });
    }

    const { resolution_notes, execution_result } = req.body;
    const ticket = await db.resolveTicket(
      req.params.ticket_number,
      req.user.id,
      resolution_notes || null,
      execution_result || null
    );
    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] resolve ticket error:', err.message);
    res.status(500).json({ error: 'Failed to resolve ticket' });
  }
});

// ── POST /api/tuneops/tickets/:ticket_number/acknowledge ──────────────────────

router.post('/tickets/:ticket_number/acknowledge', requireAuth, async (req, res) => {
  try {
    const existing = await db.getByTicketNumber(req.params.ticket_number);
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    const companyId = companyIdForUser(req.user);
    if (existing.company_id !== companyId) return res.status(403).json({ error: 'Access denied' });

    if (!['OPEN', 'REOPENED'].includes(existing.status)) {
      return res.status(409).json({ error: `Cannot acknowledge a ticket in ${existing.status} status` });
    }

    const ticket = await db.acknowledgeTicket(req.params.ticket_number, req.user.id);
    res.json({ success: true, ticket });
  } catch (err) {
    console.error('[tuneops] acknowledge ticket error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge ticket' });
  }
});

module.exports = router;
