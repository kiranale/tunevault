/**
 * services/failure-capture.js — Shared failure-capture utility.
 *
 * Owns: captureFailure() — structured error recording for every check failure.
 * Does NOT own: DB schema (migrations/), DB writes (db/failure-bundles.js),
 *               HTTP surface (routes/failure-bundles.js).
 *
 * Design:
 *   - captureFailure() is fire-and-forget — callers should NOT await it in
 *     hot paths. It writes to DB and returns a bundle id, but errors are
 *     swallowed and logged so a DB failure never breaks the health check.
 *   - Auto-extracts ORA-XXXXX codes from error messages.
 *   - Auto-redacts passwords, long bind values, and email addresses before
 *     writing to the DB (via db/failure-bundles.js).
 */

'use strict';

const bundleDb = require('../db/failure-bundles');

// ── ORA error extractor ───────────────────────────────────────────────────────
// Pulls the first ORA-XXXXX or DBI-XXXXX code from an error message.

function extractOraCode(message) {
  if (!message) return null;
  const m = message.match(/\b(ORA|DBI|TNS|SP2|PLS)-\d{4,5}\b/i);
  return m ? m[0].toUpperCase() : null;
}

// ── Main capture function ────────────────────────────────────────────────────

/**
 * Capture a failure and write it to check_failure_bundles.
 *
 * Returns a promise that resolves to the bundle id (or null on DB error).
 * NEVER throws — all errors are swallowed and logged.
 *
 * @param {object} opts
 *   Required: error (Error object or string)
 *   Optional: checkId, connectionId, userId, source, sqlText, bindValues,
 *             connectionProfile, agentVersion, oracleVersion, contextJson
 */
async function captureFailure(opts) {
  try {
    const {
      error, checkId, connectionId, userId,
      source = 'health_check',
      sqlText, bindValues,
      connectionProfile, agentVersion, oracleVersion,
      contextJson,
    } = opts;

    const errObj = error instanceof Error ? error : new Error(String(error));
    const message = errObj.message || String(error);
    const oraCode = extractOraCode(message);

    const row = await bundleDb.insertBundle({
      checkId,
      connectionId,
      userId,
      source,
      sqlText,
      bindValues,
      oraErrorCode:    oraCode,
      oraErrorMessage: message,
      nodeStack:       errObj.stack || null,
      connectionProfile,
      agentVersion,
      oracleVersion,
      contextJson,
    });

    return row ? row.id : null;
  } catch (writeErr) {
    // DB unavailable or schema not ready — log and continue
    console.error('[failure-capture] could not write bundle:', writeErr.message);
    return null;
  }
}

/**
 * Wrap a named async check function with automatic failure capture.
 *
 * Returns a wrapped function that:
 *   - calls the original fn
 *   - on Error: calls captureFailure, then re-throws
 *   - on success: returns the result unchanged
 *
 * Usage:
 *   const result = await withCapture('HC-01', conn, checkFn, connProfile);
 */
async function withCapture(checkId, conn, fn, connProfile) {
  try {
    return await fn();
  } catch (err) {
    captureFailure({
      error:             err,
      checkId,
      connectionId:      conn ? conn.id : null,
      source:            'health_check',
      connectionProfile: connProfile || conn,
      agentVersion:      conn ? conn.agent_version : null,
    }).catch(() => {}); // double-fence — never block the caller
    throw err;
  }
}

module.exports = { captureFailure, withCapture };
