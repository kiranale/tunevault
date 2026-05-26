/**
 * db/outreach.js
 *
 * Owns: All DB queries for outreach_batches, outreach_recipients, outreach_send_log.
 * Does NOT own: sending emails, HTTP routes, admin auth, Postmark calls.
 */

const pool = require('./index');

// ─── Batches ─────────────────────────────────────────────────────────────────

async function getBatch(id) {
  const r = await pool.query(
    `SELECT b.*, u.email AS approved_by_email
       FROM outreach_batches b
       LEFT JOIN users u ON u.id = b.approved_by
      WHERE b.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function getBatchByName(name) {
  const r = await pool.query(
    'SELECT * FROM outreach_batches WHERE name = $1',
    [name]
  );
  return r.rows[0] || null;
}

async function listBatches() {
  const r = await pool.query(
    `SELECT b.*, u.email AS approved_by_email,
            COUNT(rec.id) AS recipient_count,
            COUNT(rec.id) FILTER (WHERE rec.send_authorized) AS authorized_count,
            COUNT(rec.id) FILTER (WHERE rec.status = 'SENT') AS sent_count
       FROM outreach_batches b
       LEFT JOIN users u ON u.id = b.approved_by
       LEFT JOIN outreach_recipients rec ON rec.batch_id = b.id
      GROUP BY b.id, u.email
      ORDER BY b.created_at DESC`
  );
  return r.rows;
}

async function createBatch({ name, templateSubject, templateBody, sendWindowStart, sendWindowEnd, notes }) {
  const r = await pool.query(
    `INSERT INTO outreach_batches
       (name, template_subject, template_body, send_window_start, send_window_end, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, templateSubject, templateBody, sendWindowStart || null, sendWindowEnd || null, notes || null]
  );
  return r.rows[0];
}

// Approve a batch. approved_by is the user.id of the operator pressing the button.
async function approveBatch(batchId, approvedByUserId) {
  const r = await pool.query(
    `UPDATE outreach_batches
        SET approval_status = 'APPROVED',
            approved_by = $1,
            approved_at = NOW(),
            updated_at = NOW()
      WHERE id = $2
        AND approval_status = 'PENDING'
     RETURNING *`,
    [approvedByUserId, batchId]
  );
  return r.rows[0] || null;
}

async function rejectBatch(batchId) {
  const r = await pool.query(
    `UPDATE outreach_batches
        SET approval_status = 'REJECTED', updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [batchId]
  );
  return r.rows[0] || null;
}

// ─── Recipients ───────────────────────────────────────────────────────────────

async function getRecipientsForBatch(batchId) {
  const r = await pool.query(
    `SELECT * FROM outreach_recipients WHERE batch_id = $1 ORDER BY created_at ASC`,
    [batchId]
  );
  return r.rows;
}

async function getRecipient(recipientId) {
  const r = await pool.query(
    'SELECT * FROM outreach_recipients WHERE id = $1',
    [recipientId]
  );
  return r.rows[0] || null;
}

async function addRecipient(batchId, { email, name, company }) {
  const r = await pool.query(
    `INSERT INTO outreach_recipients (batch_id, email, name, company)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (batch_id, email) DO NOTHING
     RETURNING *`,
    [batchId, email.toLowerCase().trim(), name || null, company || null]
  );
  return r.rows[0] || null;
}

async function authorizeRecipient(recipientId) {
  const r = await pool.query(
    `UPDATE outreach_recipients
        SET send_authorized = true, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [recipientId]
  );
  return r.rows[0] || null;
}

async function markRecipientSent(recipientId) {
  const r = await pool.query(
    `UPDATE outreach_recipients
        SET status = 'SENT', sent_at = NOW()
      WHERE id = $1 RETURNING *`,
    [recipientId]
  );
  return r.rows[0] || null;
}

async function markRecipientBlocked(recipientId) {
  await pool.query(
    `UPDATE outreach_recipients SET status = 'BLOCKED' WHERE id = $1`,
    [recipientId]
  );
}

// ─── Send Log ─────────────────────────────────────────────────────────────────

async function logSendAttempt({
  batchId,
  recipientId,
  recipientEmail,
  gateResult,        // 'ALLOWED' | 'BLOCKED'
  blockedReason,     // e.g. 'ENV_DISABLED', 'BATCH_NOT_APPROVED', 'RECIPIENT_NOT_AUTHORIZED'
  gateFailed,        // which gate index ('gate1', 'gate2', 'gate3') or null
  postmarkMessageId,
  errorMessage,
  metadata,
}) {
  const r = await pool.query(
    `INSERT INTO outreach_send_log
       (batch_id, recipient_id, recipient_email, gate_result,
        blocked_reason, gate_failed, postmark_message_id, error_message, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      batchId || null,
      recipientId || null,
      recipientEmail || null,
      gateResult,
      blockedReason || null,
      gateFailed || null,
      postmarkMessageId || null,
      errorMessage || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
  return r.rows[0].id;
}

async function getRecentSendLog(limit = 100) {
  const r = await pool.query(
    `SELECT l.*, b.name AS batch_name
       FROM outreach_send_log l
       LEFT JOIN outreach_batches b ON b.id = l.batch_id
      ORDER BY l.attempted_at DESC
      LIMIT $1`,
    [limit]
  );
  return r.rows;
}

module.exports = {
  // Batches
  getBatch,
  getBatchByName,
  listBatches,
  createBatch,
  approveBatch,
  rejectBatch,
  // Recipients
  getRecipientsForBatch,
  getRecipient,
  addRecipient,
  authorizeRecipient,
  markRecipientSent,
  markRecipientBlocked,
  // Send log
  logSendAttempt,
  getRecentSendLog,
};
