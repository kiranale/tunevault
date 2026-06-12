'use strict';

const pool = require('./index');

async function createJob(connectionId, opKey, userId) {
  const { rows } = await pool.query(
    `INSERT INTO ebs_jobs (connection_id, op_key, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [connectionId, opKey, userId]
  );
  return { id: rows[0].id };
}

async function startJob(jobId) {
  await pool.query(
    `UPDATE ebs_jobs SET status = 'running', started_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [jobId]
  );
}

async function completeJob(jobId, { ok, stdout, exit_code, duration_ms }) {
  await pool.query(
    `UPDATE ebs_jobs
     SET status = 'done', ok = $2, stdout = $3, exit_code = $4,
         duration_ms = $5, finished_at = NOW()
     WHERE id = $1`,
    [jobId, ok, stdout, exit_code, duration_ms]
  );
}

async function getJob(jobId) {
  const { rows } = await pool.query(
    `SELECT j.*, c.user_id
     FROM ebs_jobs j
     JOIN oracle_connections c ON c.id = j.connection_id
     WHERE j.id = $1`,
    [jobId]
  );
  return rows[0] || null;
}

async function timeoutStaleJobs() {
  const { rowCount } = await pool.query(
    `UPDATE ebs_jobs SET status = 'timeout', finished_at = NOW()
     WHERE status IN ('queued','running')
       AND created_at < NOW() - INTERVAL '45 minutes'`
  );
  return rowCount || 0;
}

module.exports = { createJob, startJob, completeJob, getJob, timeoutStaleJobs };
