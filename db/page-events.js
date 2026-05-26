/**
 * db/page-events.js — page_events table CRUD.
 *
 * Owns: reading and writing page_events (landing page CTA click tracking).
 * Does NOT own: funnel analytics (analytics_events), user auth, billing.
 */

'use strict';

const pool = require('./index');

/**
 * Record a page event (CTA click or page view).
 * Fire-and-forget safe — never throws.
 *
 * @param {Object} opts
 * @param {string}  opts.eventType  — cta_click | page_view
 * @param {string}  opts.eventName  — e.g. hero_cta, pricing_cta, nav_signup
 * @param {string}  opts.pageUrl    — full URL path
 * @param {string}  [opts.referrer] — HTTP referrer
 * @param {string}  [opts.userAgent]— User-Agent truncated to 500 chars
 * @param {string}  [opts.ipHash]   — SHA-256 of full IP (no PII)
 * @param {string}  [opts.sessionId]— UUID session id
 */
async function trackPageEvent({ eventType, eventName, pageUrl, referrer = null, userAgent = null, ipHash = null, sessionId = null }) {
  try {
    await pool.query(
      `INSERT INTO page_events (event_type, event_name, page_url, referrer, user_agent, ip_hash, session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        eventType,
        eventName,
        pageUrl ? pageUrl.slice(0, 500) : null,
        referrer ? referrer.slice(0, 500) : null,
        userAgent ? userAgent.slice(0, 500) : null,
        ipHash || null,
        sessionId || null,
      ]
    );
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: 'page_events.track failed', eventName, err: err.message }));
  }
}

/**
 * Daily event counts by event_name — for the admin analytics dashboard.
 * Returns rows like: { event_name, date, count }
 */
async function getDailyCounts({ from, to }) {
  const result = await pool.query(
    `SELECT
       event_name,
       DATE_TRUNC('day', created_at)::date AS date,
       COUNT(*) AS count
     FROM page_events
     WHERE created_at BETWEEN $1 AND $2
     GROUP BY 1, 2
     ORDER BY 2, 1`,
    [from, to]
  );
  return result.rows;
}

/**
 * Overall totals by event_name — top-level summary.
 */
async function getTotals({ from, to }) {
  const result = await pool.query(
    `SELECT
       event_name,
       COUNT(*) AS count,
       COUNT(DISTINCT session_id) AS unique_sessions
     FROM page_events
     WHERE created_at BETWEEN $1 AND $2
       AND event_type = 'cta_click'
     GROUP BY 1
     ORDER BY count DESC`,
    [from, to]
  );
  return result.rows;
}

module.exports = { trackPageEvent, getDailyCounts, getTotals };