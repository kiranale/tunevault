/**
 * db/analytics.js — analytics_events table CRUD.
 *
 * Owns: reading and writing analytics_events (funnel tracking).
 * Does NOT own: user auth, payment logic, health check execution.
 */

'use strict';

const pool = require('./index');

/**
 * Record a funnel event. Fire-and-forget safe — never throws.
 * @param {Object} opts
 * @param {string}  opts.eventName   — event identifier (e.g. 'signup_completed')
 * @param {number}  [opts.userId]    — authenticated user id (null for anon)
 * @param {string}  [opts.sessionId] — browser session id from sessionStorage or cookie
 * @param {string}  [opts.pagePath]  — page path event occurred on
 * @param {string}  [opts.referrer]  — HTTP referrer
 * @param {string}  [opts.ip]        — truncated IP (/24 v4, /48 v6) — never full IP
 * @param {string}  [opts.ipHash]    — SHA-256 of full IP for dedup without PII storage
 * @param {string}  [opts.userAgent] — User-Agent header value (truncated to 500 chars)
 * @param {Object}  [opts.properties]— additional key/value metadata (JSONB)
 */
async function trackEvent({ eventName, userId = null, sessionId = null, pagePath = null, referrer = null, ip = null, ipHash = null, userAgent = null, properties = null }) {
  try {
    await pool.query(
      `INSERT INTO analytics_events
         (event_name, user_id, session_id, page_path, referrer, ip, ip_hash, user_agent, properties, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        eventName,
        userId || null,
        sessionId || null,
        pagePath ? pagePath.slice(0, 500) : null,
        referrer ? referrer.slice(0, 500) : null,
        ip ? ip.slice(0, 45) : null,
        ipHash || null,
        userAgent ? userAgent.slice(0, 500) : null,
        properties ? JSON.stringify(properties) : null,
      ]
    );
  } catch (err) {
    // Silent catch — analytics must never break product functionality
    console.log(JSON.stringify({ level: 'warn', msg: 'analytics.trackEvent failed', eventName, err: err.message }));
  }
}

/**
 * Funnel summary for the admin dashboard.
 * Returns row counts for each funnel step within the given date range.
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Array<{event_name: string, count: number, unique_users: number}>>}
 */
async function getFunnelCounts({ from, to }) {
  const result = await pool.query(
    `SELECT
       event_name,
       COUNT(*) AS count,
       COUNT(DISTINCT user_id) AS unique_users,
       COUNT(DISTINCT session_id) AS unique_sessions
     FROM analytics_events
     WHERE occurred_at BETWEEN $1 AND $2
     GROUP BY event_name
     ORDER BY MIN(occurred_at)`,
    [from, to]
  );
  return result.rows;
}

/**
 * UTM source/medium/campaign breakdown for the admin funnel side panel.
 * Returns top sources by visitor + paid conversion.
 */
async function getUtmBreakdown({ from, to }) {
  const result = await pool.query(
    `SELECT
       COALESCE(properties->>'utm_source',   '(direct)') AS utm_source,
       COALESCE(properties->>'utm_medium',   '(none)')   AS utm_medium,
       COALESCE(properties->>'utm_campaign', '(none)')   AS utm_campaign,
       COUNT(*) FILTER (WHERE event_name = 'page_view')         AS visitors,
       COUNT(*) FILTER (WHERE event_name = 'checkout_completed') AS paid
     FROM analytics_events
     WHERE occurred_at BETWEEN $1 AND $2
       AND event_name IN ('page_view', 'checkout_completed')
     GROUP BY 1, 2, 3
     ORDER BY visitors DESC
     LIMIT 20`,
    [from, to]
  );
  return result.rows;
}

/**
 * Daily event volume for sparkline — returns one row per (day, event_name).
 */
async function getDailyVolume({ from, to }) {
  const result = await pool.query(
    `SELECT
       DATE_TRUNC('day', occurred_at)::date AS day,
       event_name,
       COUNT(*) AS count
     FROM analytics_events
     WHERE occurred_at BETWEEN $1 AND $2
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [from, to]
  );
  return result.rows;
}

/**
 * Daily event volume for a single event — legacy sparkline helper.
 * @param {string} eventName
 * @param {Date}   from
 * @param {Date}   to
 * @returns {Promise<Array<{day: string, count: number}>>}
 */
async function getEventTrend(eventName, { from, to }) {
  const result = await pool.query(
    `SELECT
       DATE_TRUNC('day', occurred_at)::date AS day,
       COUNT(*) AS count
     FROM analytics_events
     WHERE event_name = $1
       AND occurred_at BETWEEN $2 AND $3
     GROUP BY 1
     ORDER BY 1`,
    [eventName, from, to]
  );
  return result.rows;
}

/**
 * Recent events for the live feed table.
 * @returns {Promise<Array>}
 */
async function getRecentEvents(limit = 50) {
  const result = await pool.query(
    `SELECT id, event_name, user_id, session_id, page_path, referrer, properties, occurred_at
     FROM analytics_events
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = { trackEvent, getFunnelCounts, getUtmBreakdown, getDailyVolume, getEventTrend, getRecentEvents };
