/**
 * routes/tuneops-notifications.js — TuneOps notification preference endpoints.
 *
 * Owns: GET/PUT /api/tuneops/notifications/prefs
 *       POST /api/tuneops/notifications/mute/:connectionId
 *       POST /api/tuneops/notifications/test (admin-only smoke test)
 *
 * Does NOT own: ticket CRUD, email rendering, or who-gets-what routing logic
 *               (that lives in services/tuneops-mailer.js).
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { requireAuth, requireAdmin } = require('../middleware/auth');
const db      = require('../db/tuneops-notifications');
const mailer  = require('../services/tuneops-mailer');

const VALID_THRESHOLDS = ['info', 'warning', 'critical'];

// GET /api/tuneops/notifications/prefs
// Returns current notification preferences for the authenticated user.
router.get('/prefs', requireAuth, async (req, res) => {
  try {
    const prefs = await db.getPrefs(req.user.id);
    res.json({ success: true, prefs });
  } catch (err) {
    console.warn('[tuneops-notifications] GET prefs error:', err.message);
    res.status(500).json({ error: 'Failed to load notification preferences' });
  }
});

// PUT /api/tuneops/notifications/prefs
// Body: { notificationsEnabled: boolean, severityThreshold: 'info'|'warning'|'critical' }
router.put('/prefs', requireAuth, async (req, res) => {
  try {
    const { notificationsEnabled, severityThreshold } = req.body;

    if (notificationsEnabled !== undefined && typeof notificationsEnabled !== 'boolean') {
      return res.status(400).json({ error: 'notificationsEnabled must be a boolean' });
    }
    if (severityThreshold !== undefined && !VALID_THRESHOLDS.includes(severityThreshold)) {
      return res.status(400).json({ error: `severityThreshold must be one of: ${VALID_THRESHOLDS.join(', ')}` });
    }

    // Merge with existing prefs
    const existing = await db.getPrefs(req.user.id);
    const prefs = await db.upsertPrefs(req.user.id, {
      notificationsEnabled : notificationsEnabled !== undefined ? notificationsEnabled : existing.notifications_enabled,
      severityThreshold    : severityThreshold !== undefined ? severityThreshold : existing.severity_threshold,
    });

    res.json({ success: true, prefs });
  } catch (err) {
    console.warn('[tuneops-notifications] PUT prefs error:', err.message);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// POST /api/tuneops/notifications/mute/:connectionId
// Body: { hours?: number } — default 24. Mutes notifications for this connection.
router.post('/mute/:connectionId', requireAuth, async (req, res) => {
  try {
    const connectionId = parseInt(req.params.connectionId, 10);
    if (!connectionId) return res.status(400).json({ error: 'Invalid connectionId' });

    const hours = parseInt(req.body.hours, 10) || 24;
    if (hours < 1 || hours > 168) {
      return res.status(400).json({ error: 'hours must be between 1 and 168' });
    }

    await db.muteConnection(req.user.id, connectionId, hours);
    res.json({ success: true, mutedForHours: hours });
  } catch (err) {
    console.warn('[tuneops-notifications] POST mute error:', err.message);
    res.status(500).json({ error: 'Failed to mute connection' });
  }
});

// POST /api/tuneops/notifications/test — admin only
// Sends a test notification to the authenticated admin's email.
// Body: { eventType: 'created_critical' | 'assigned' | ... }
router.post('/test', requireAdmin, async (req, res) => {
  try {
    const { eventType = 'created_critical' } = req.body;
    const adminEmail = req.user.email;
    if (!adminEmail) return res.status(400).json({ error: 'No email on admin account' });

    const testTicket = 'TO-TEST';
    const recipients = [{ email: adminEmail, userId: null }]; // skip prefs check in test

    let result;
    switch (eventType) {
      case 'created_critical':
        result = await mailer.notifyCreated({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB (test.example.com:1521/TESTDB)',
          recommendedFix: "ALTER TABLESPACE USERS ADD DATAFILE '+DATA' SIZE 10G AUTOEXTEND ON;",
          recipients,
        });
        break;

      case 'created_warning':
        result = await mailer.notifyCreated({
          ticketNumber  : testTicket,
          title         : 'Redo log switches > 30/hr',
          severity      : 'warning',
          connectionName: 'TEST_DB',
          recommendedFix: 'ALTER DATABASE ADD LOGFILE SIZE 500M;',
          recipients,
        });
        break;

      case 'assigned':
        result = await mailer.notifyAssigned({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          assigneeName  : 'Test DBA',
          recommendedFix: "ALTER TABLESPACE USERS ADD DATAFILE '+DATA' SIZE 10G;",
          recipients,
        });
        break;

      case 'approval_requested':
        result = await mailer.notifyApprovalRequested({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          requesterName : 'Junior DBA',
          recommendedFix: "ALTER TABLESPACE USERS ADD DATAFILE '+DATA' SIZE 10G;",
          recipients,
        });
        break;

      case 'approved':
        result = await mailer.notifyApproved({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          approverName  : 'Lead DBA',
          recommendedFix: "ALTER TABLESPACE USERS ADD DATAFILE '+DATA' SIZE 10G;",
          recipients,
        });
        break;

      case 'rejected':
        result = await mailer.notifyRejected({
          ticketNumber    : testTicket,
          title           : 'USERS tablespace 92.5% full',
          severity        : 'critical',
          connectionName  : 'TEST_DB',
          approverName    : 'Lead DBA',
          rejectionReason : 'Maintenance window required — schedule for Sunday 02:00.',
          recipients,
        });
        break;

      case 'executed_success':
        result = await mailer.notifyExecutedSuccess({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          executorName  : 'Senior DBA',
          durationMs    : 320,
          recipients,
        });
        break;

      case 'executed_failed':
        result = await mailer.notifyExecutedFailed({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          executorName  : 'Senior DBA',
          errorMessage  : 'ORA-01144: File size exceeds maximum of 4194302 blocks',
          recipients,
        });
        break;

      case 'reopened':
        result = await mailer.notifyReopened({
          ticketNumber  : testTicket,
          title         : 'USERS tablespace 92.5% full',
          severity      : 'critical',
          connectionName: 'TEST_DB',
          reopenedCount : 2,
          healthCheckId : 99,
          recipients,
        });
        break;

      case 'acknowledged':
        result = await mailer.notifyAcknowledged({
          ticketNumber        : testTicket,
          title               : 'Redo log switches > 30/hr',
          severity            : 'warning',
          connectionName      : 'TEST_DB',
          acknowledgedByName  : 'Senior DBA',
          recipients,
        });
        break;

      default:
        return res.status(400).json({
          error: 'Unknown eventType',
          valid : ['created_critical','created_warning','assigned','approval_requested','approved','rejected','executed_success','executed_failed','reopened','acknowledged'],
        });
    }

    res.json({ success: true, eventType, to: adminEmail, results: result });
  } catch (err) {
    console.warn('[tuneops-notifications] POST test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
