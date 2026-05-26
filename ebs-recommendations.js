/**
 * ebs-recommendations.js — Workflow Mailer recovery runbook generator
 *
 * Owns: computing recovery_runbook from apps_health.workflow data.
 * Does NOT own: fetching data from Oracle, rendering HTML.
 *
 * Called from oracle-client.js after queryAppsHealth() builds the workflow object,
 * and used by demo-data.js to seed consistent demo runbook content.
 */

'use strict';

/**
 * Build a recovery_runbook object if Workflow Mailer needs attention.
 * Returns null when the mailer is healthy and no action is needed.
 *
 * Trigger: stuck_notifications > 50 OR error_count > 10 OR mailer_running === false
 *
 * @param {object} workflow  — the apps_health.workflow sub-object
 * @returns {object|null}
 */
function buildWorkflowMailerRunbook(workflow) {
  if (!workflow) return null;

  const stuckNotif   = workflow.stuck_notifications || 0;
  const wfErrCount   = workflow.error_count          || 0;
  const mailerRunning = !!workflow.mailer_running;

  // Only attach runbook when action is actually needed
  if (stuckNotif <= 50 && wfErrCount <= 10 && mailerRunning) return null;

  return {
    title:   'Workflow Mailer Recovery Runbook',
    note:    'Run as APPS user. Verify backups before any UPDATE.',
    trigger: {
      stuck_notifications: stuckNotif,
      wf_error_count:      wfErrCount,
      mailer_running:      mailerRunning
    },
    steps: [
      {
        id:      'inspect-notifications',
        heading: 'Step 1 — Inspect stuck notifications',
        type:    'sql',
        content: `SELECT MAIL_STATUS, COUNT(*), MIN(BEGIN_DATE), MAX(BEGIN_DATE)
FROM APPLSYS.WF_NOTIFICATIONS
WHERE MAIL_STATUS IN ('MAIL','ERROR','INVALID')
GROUP BY MAIL_STATUS;`
      },
      {
        id:      'requeue-notifications',
        heading: 'Step 2 — Re-queue MAIL-status notifications',
        type:    'sql',
        content: `UPDATE APPLSYS.WF_NOTIFICATIONS
SET MAIL_STATUS = 'MAIL', STATUS = 'OPEN'
WHERE MAIL_STATUS = 'MAIL' AND BEGIN_DATE < SYSDATE - 1/24;
COMMIT;`
      },
      {
        id:      'inspect-wf-error',
        heading: 'Step 3 — Inspect WF_ERROR queue',
        type:    'sql',
        content: `SELECT CORRID, MSG_STATE, ENQ_TIME
FROM APPLSYS.AQ$WF_ERROR
ORDER BY ENQ_TIME DESC FETCH FIRST 20 ROWS ONLY;`
      },
      {
        id:      'restart-mailer',
        heading: 'Step 4 — Restart the Notification Mailer',
        type:    'shell',
        content: 'adcmctl.sh stop apps/<pwd> && adcmctl.sh start apps/<pwd>',
        note:    'Or: Workflow Manager → Notification Mailer → Stop → Start'
      },
      {
        id:      'verify-smtp',
        heading: 'Step 5 — Verify SMTP configuration',
        type:    'sql',
        content: `SELECT COMPONENT_PARAMETER_ID, PARAMETER_VALUE
FROM FND_SVC_COMP_PARAM_VALS_V
WHERE COMPONENT_NAME = 'Workflow Notification Mailer'
AND COMPONENT_PARAMETER_ID IN ('OUTBOUND_SERVER','INBOUND_SERVER','REPLYTO');`
      }
    ]
  };
}

module.exports = { buildWorkflowMailerRunbook };
