/**
 * db/install-jobs.js — SSH push-install job persistence.
 *
 * Owns: install_jobs rows (audit trail, status, timing)
 *       job_log_lines rows (per-job stdout/stderr append)
 * Does NOT own: SSH credentials (never written to DB — held in-memory only),
 *               oracle_connections CRUD (db/agent.js),
 *               agent tunnel records (db/agent.js).
 */

'use strict';

const pool = require('./index');

/**
 * Create a new install job row.
 * Returns the persisted row with auto-assigned id.
 */
async function createJob({ userId, connectionId, host, sshPort, sshUser }) {
  const result = await pool.query(
    `INSERT INTO install_jobs
       (user_id, connection_id, host, ssh_port, ssh_user, status, started_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), NOW())
     RETURNING id, user_id, connection_id, host, ssh_port, ssh_user, status, started_at`,
    [userId, connectionId || null, host, sshPort || 22, sshUser]
  );
  return result.rows[0];
}

/**
 * Transition a job to a new lifecycle status.
 * Valid statuses: queued → connecting → preflight → installing → verifying → success | failed
 */
async function setStatus(jobId, status) {
  await pool.query(
    `UPDATE install_jobs SET status = $2 WHERE id = $1`,
    [jobId, status]
  );
}

/**
 * Mark job complete (success or failed) with optional exit code and error message.
 */
async function finishJob(jobId, { status, exitCode, errorMessage, connectionId }) {
  await pool.query(
    `UPDATE install_jobs
     SET status        = $2,
         exit_code     = $3,
         error_message = $4,
         connection_id = COALESCE($5, connection_id),
         finished_at   = NOW(),
         duration_ms   = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER * 1000
     WHERE id = $1`,
    [jobId, status, exitCode ?? null, errorMessage ?? null, connectionId ?? null]
  );
}

/**
 * Append a log line (fire-and-forget friendly — caller should .catch(() => {})).
 * seq is caller-managed for ordering guarantee (pass monotonically increasing integer).
 */
async function appendLine(jobId, { seq, stream, line }) {
  await pool.query(
    `INSERT INTO job_log_lines (job_id, seq, stream, line, ts)
     VALUES ($1, $2, $3, $4, NOW())`,
    [jobId, seq, stream || 'stdout', (line || '').slice(0, 4096)]
  );
}

/**
 * Get a single job by id (ownership check is caller's responsibility).
 */
async function getJob(jobId) {
  const result = await pool.query(
    `SELECT id, user_id, connection_id, host, ssh_port, ssh_user,
            status, exit_code, error_message, started_at, finished_at, duration_ms
     FROM install_jobs WHERE id = $1`,
    [jobId]
  );
  return result.rows[0] || null;
}

/**
 * Count active (non-terminal) jobs for a given user_id.
 * Used for the 3-concurrent cap.
 */
async function countActiveForUser(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM install_jobs
     WHERE user_id = $1 AND status NOT IN ('success','failed')`,
    [userId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Count jobs started within the last 24 hours for a given user_id.
 * Used for the 20/day cap.
 */
async function countTodayForUser(userId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM install_jobs
     WHERE user_id = $1 AND started_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Recent log lines for a job in sequence order (used to replay on reconnect).
 */
async function getLogLines(jobId, afterSeq = 0) {
  const result = await pool.query(
    `SELECT seq, stream, line, ts FROM job_log_lines
     WHERE job_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [jobId, afterSeq]
  );
  return result.rows;
}

/**
 * Set the connection_id on an in-flight job once the draft connection is created.
 */
async function setConnectionId(jobId, connectionId) {
  await pool.query(
    `UPDATE install_jobs SET connection_id = $2 WHERE id = $1`,
    [jobId, connectionId]
  );
}

module.exports = {
  createJob,
  setStatus,
  finishJob,
  appendLine,
  getJob,
  countActiveForUser,
  countTodayForUser,
  getLogLines,
  setConnectionId,
};
