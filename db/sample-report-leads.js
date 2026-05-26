/**
 * db/sample-report-leads.js — sample_report_leads table queries.
 * Owns: insert lead, list leads (admin).
 * Does NOT own: email delivery, auth logic, analytics events.
 */

'use strict';

const pool = require('./index');

/**
 * Record an email lead from the /sample-report page.
 * Returns the created row.
 */
async function insertSampleReportLead({ email, ip, referrer }) {
  const result = await pool.query(
    `INSERT INTO sample_report_leads (email, ip, referrer)
     VALUES ($1, $2, $3)
     RETURNING id, email, captured_at`,
    [email.trim().toLowerCase(), ip || null, referrer || null]
  );
  return result.rows[0];
}

/**
 * Get all leads (admin use only).
 */
async function listSampleReportLeads({ limit = 100, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT id, email, captured_at, ip, referrer
     FROM sample_report_leads
     ORDER BY captured_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows;
}

module.exports = { insertSampleReportLead, listSampleReportLeads };
