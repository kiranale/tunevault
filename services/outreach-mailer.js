/**
 * services/outreach-mailer.js
 *
 * Owns: The ONE and ONLY code path that can send a cold outreach email.
 *       Every outbound prospect email MUST go through sendOutreachEmail().
 *
 * Does NOT own: batch creation, recipient management, admin UI, auth.
 *
 * Hard lock (Gate 0 — blocks all other gates if not satisfied):
 *   OUTREACH_UNLOCK_TOKEN env var must be set. If unset or empty, every
 *   outreach attempt returns HTTP 403 / throws with {error:'OUTREACH_LOCKED'}.
 *   Additionally, the recipient domain must NOT be an internal allowlisted domain
 *   (tunevault.app, polsia.app, or any operator personal email in ADMIN_EMAILS).
 *   Internal addresses are always allowed through regardless of lock state so
 *   welcome/alert emails to the operator are not blocked.
 *
 * Gate order after hard lock passes (first fail wins — throws + logs to outreach_send_log):
 *   Gate 1 — OUTREACH_SEND_ENABLED env var must be 'true'
 *   Gate 2 — batch.approval_status = 'APPROVED', approved within last 60 minutes
 *   Gate 3 — recipient.send_authorized = true
 *
 * Every attempt (blocked or allowed) is logged to outreach_attempts via db/outreach-lock.
 */

const db = require('../db/outreach');
const lockDb = require('../db/outreach-lock');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>';
const RESEND_API_URL = 'https://api.resend.com';

// Internal domains — emails to these are never treated as cold outreach.
const INTERNAL_DOMAINS = ['tunevault.app', 'polsia.app'];

/**
 * Returns true if this email address is an internal/operator address
 * that should bypass the cold-outreach hard lock.
 */
function isInternalEmail(email) {
  if (!email) return false;
  const lower = email.toLowerCase().trim();
  const domain = lower.split('@')[1] || '';
  if (INTERNAL_DOMAINS.includes(domain)) return true;

  // Also check ADMIN_EMAILS env var — operator personal emails
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(lower);
}

/**
 * isOutreachLocked — returns true when OUTREACH_UNLOCK_TOKEN is absent/empty.
 * The system is LOCKED by default; only an explicit token unlocks it.
 */
function isOutreachLocked() {
  const token = (process.env.OUTREACH_UNLOCK_TOKEN || '').trim();
  return token.length === 0;
}

/**
 * sendOutreachEmail — the single chokepoint for all cold prospect emails.
 *
 * @param {Object} opts
 * @param {number}  opts.batchId       — outreach_batches.id
 * @param {number}  opts.recipientId   — outreach_recipients.id
 * @param {string}  opts.subject       — email subject line (overrides batch template if provided)
 * @param {string}  opts.body          — plain-text body
 * @param {string}  opts.html          — HTML body (optional)
 * @param {string}  opts.calledBy      — identifier of calling route/agent (for audit log)
 *
 * @returns {{ sent: true, messageId: string } | never}
 * @throws  Error with gate failure message (also logged to outreach_send_log)
 */
async function sendOutreachEmail({ batchId, recipientId, subject, body, html, calledBy }) {
  const logBase = { batchId, recipientId };
  const attemptedBy = calledBy || 'route:unknown';
  const unlockTokenPresent = !isOutreachLocked();
  let recipientEmail = null;

  // ─── Gate 0: hard lock ───────────────────────────────────────────────────
  // Fetch recipient email early so we can check if it's internal.
  // If recipient not found yet, we still block — internal check requires email.
  let earlyRecipient = null;
  try {
    earlyRecipient = await db.getRecipient(recipientId);
    recipientEmail = earlyRecipient?.email || null;
  } catch (_) {
    // DB error during early fetch — proceed with null email, lock check will decide
  }

  const internal = isInternalEmail(recipientEmail);

  if (!internal && isOutreachLocked()) {
    const reason = 'OUTREACH_UNLOCK_TOKEN is not set — hard lock is active';
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent: false,
      blockedReason: 'NO_UNLOCK_TOKEN',
      metadata: { batchId, recipientId },
    });
    const err = new Error(`[outreach-gate0] ${reason}`);
    err.code = 'OUTREACH_LOCKED';
    err.status = 403;
    throw err;
  }

  // Log that we passed gate 0 (either internal email or token present)
  if (internal) {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: false,
      unlockTokenPresent,
      blockedReason: 'INTERNAL_DOMAIN_BYPASS',
      metadata: { batchId, recipientId, note: 'internal email — bypasses hard lock' },
    });
  }

  // ─── Gate 1: global kill-switch ──────────────────────────────────────────
  if (process.env.OUTREACH_SEND_ENABLED !== 'true') {
    const reason = 'OUTREACH_SEND_ENABLED is not true — global kill-switch is active';
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'ENV_DISABLED',
      metadata: { batchId, recipientId, env: process.env.OUTREACH_SEND_ENABLED ?? '(unset)' },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'ENV_DISABLED',
      gateFailed: 'gate1',
      metadata: { env: process.env.OUTREACH_SEND_ENABLED ?? '(unset)' },
    });
    throw new Error(`[outreach-gate1] ${reason}`);
  }

  // ─── Gate 2: batch approval within 60 minutes ────────────────────────────
  const batch = await db.getBatch(batchId);
  if (!batch) {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'BATCH_NOT_FOUND',
      metadata: { batchId, recipientId },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'BATCH_NOT_FOUND',
      gateFailed: 'gate2',
    });
    throw new Error(`[outreach-gate2] Batch ${batchId} not found`);
  }

  if (batch.approval_status !== 'APPROVED') {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'BATCH_NOT_APPROVED',
      metadata: { batchId, approval_status: batch.approval_status },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'BATCH_NOT_APPROVED',
      gateFailed: 'gate2',
      metadata: { approval_status: batch.approval_status },
    });
    throw new Error(`[outreach-gate2] Batch "${batch.name}" approval_status is "${batch.approval_status}" — must be APPROVED`);
  }

  const approvedAt = batch.approved_at ? new Date(batch.approved_at) : null;
  const windowMs = 60 * 60 * 1000; // 60 minutes
  if (!approvedAt || (Date.now() - approvedAt.getTime()) > windowMs) {
    const ageMin = approvedAt ? Math.floor((Date.now() - approvedAt.getTime()) / 60000) : null;
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'APPROVAL_EXPIRED',
      metadata: { batchId, approved_at: batch.approved_at, age_minutes: ageMin },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'APPROVAL_EXPIRED',
      gateFailed: 'gate2',
      metadata: { approved_at: batch.approved_at, age_minutes: ageMin },
    });
    throw new Error(`[outreach-gate2] Batch approval expired — approved ${ageMin} min ago, max is 60 min`);
  }

  // ─── Gate 3: per-recipient authorization ─────────────────────────────────
  // Use early-fetched recipient if available
  const recipient = earlyRecipient || (await db.getRecipient(recipientId));
  if (!recipient) {
    await lockDb.logOutreachAttempt({
      attemptedTo: null,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'RECIPIENT_NOT_FOUND',
      metadata: { recipientId },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'RECIPIENT_NOT_FOUND',
      gateFailed: 'gate3',
    });
    throw new Error(`[outreach-gate3] Recipient ${recipientId} not found`);
  }

  recipientEmail = recipient.email;

  if (recipient.batch_id !== batchId) {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'RECIPIENT_WRONG_BATCH',
      metadata: { recipientId, batchId },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'RECIPIENT_WRONG_BATCH',
      gateFailed: 'gate3',
    });
    throw new Error(`[outreach-gate3] Recipient ${recipientId} does not belong to batch ${batchId}`);
  }

  if (!recipient.send_authorized) {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'RECIPIENT_NOT_AUTHORIZED',
      metadata: { recipientId, send_authorized: recipient.send_authorized },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'RECIPIENT_NOT_AUTHORIZED',
      gateFailed: 'gate3',
      metadata: { send_authorized: recipient.send_authorized },
    });
    throw new Error(`[outreach-gate3] Recipient ${recipientId} (${recipient.email}) send_authorized is false`);
  }

  if (recipient.status === 'SENT') {
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: subject || null,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'ALREADY_SENT',
      metadata: { recipientId },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'ALREADY_SENT',
      gateFailed: 'gate3',
    });
    throw new Error(`[outreach-gate3] Recipient ${recipientId} (${recipient.email}) already sent`);
  }

  // ─── All gates passed — send ──────────────────────────────────────────────
  const emailSubject = subject || batch.template_subject;
  const emailBody = body || batch.template_body;

  let postmarkMessageId = null;
  try {
    const resp = await fetch(`${RESEND_API_URL}/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: recipient.email,
        subject: emailSubject,
        text: emailBody,
        ...(html ? { html } : {}),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '(no body)');
      await lockDb.logOutreachAttempt({
        attemptedTo: recipientEmail,
        attemptedSubject: emailSubject,
        attemptedBy,
        blocked: true,
        unlockTokenPresent,
        blockedReason: 'PROXY_ERROR',
        metadata: { proxy_status: resp.status },
      });
      await db.logSendAttempt({
        ...logBase,
        recipientEmail,
        gateResult: 'BLOCKED',
        blockedReason: 'PROXY_ERROR',
        errorMessage: `HTTP ${resp.status}: ${errText}`,
        metadata: { proxy_status: resp.status },
      });
      throw new Error(`[outreach-send] Email proxy returned ${resp.status}: ${errText}`);
    }

    const data = await resp.json().catch(() => ({}));
    postmarkMessageId = data.message_id || data.MessageID || null;
  } catch (err) {
    if (err.message.startsWith('[outreach-')) throw err; // already logged
    await lockDb.logOutreachAttempt({
      attemptedTo: recipientEmail,
      attemptedSubject: emailSubject,
      attemptedBy,
      blocked: true,
      unlockTokenPresent,
      blockedReason: 'NETWORK_ERROR',
      metadata: { error: err.message },
    });
    await db.logSendAttempt({
      ...logBase,
      recipientEmail,
      gateResult: 'BLOCKED',
      blockedReason: 'NETWORK_ERROR',
      errorMessage: err.message,
    });
    throw err;
  }

  // Mark recipient as sent
  await db.markRecipientSent(recipientId);

  // Log success to both tables
  await lockDb.logOutreachAttempt({
    attemptedTo: recipientEmail,
    attemptedSubject: emailSubject,
    attemptedBy,
    blocked: false,
    unlockTokenPresent,
    blockedReason: null,
    metadata: { batchId, recipientId, messageId: postmarkMessageId },
  });
  await db.logSendAttempt({
    ...logBase,
    recipientEmail,
    gateResult: 'ALLOWED',
    postmarkMessageId,
    metadata: { subject: emailSubject },
  });

  console.log(`[outreach] Sent to ${recipient.email} (batch=${batchId}, recipient=${recipientId})`);

  return { sent: true, messageId: postmarkMessageId };
}

module.exports = { sendOutreachEmail, isOutreachLocked, isInternalEmail };
