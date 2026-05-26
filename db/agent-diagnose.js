/**
 * db/agent-diagnose.js — agent_diagnose_runs CRUD.
 *
 * Owns: insert + read operations for agent diagnose run records.
 * Does NOT own: connection ownership checks, API key validation (routes/agent.js).
 */

'use strict';

const pool = require('./index');

/**
 * Insert a new diagnose run row.
 *
 * @param {object} data
 * @param {number} data.connectionId
 * @param {string} [data.agentVersion]
 * @param {string} [data.host]
 * @param {string[]} [data.detectedSids]
 * @param {string[]} [data.listenerServices]
 * @param {string} [data.chosenService]
 * @param {Array}  [data.probes]        — [{id, name, status, detail}]
 * @param {number} [data.roundtripMs]
 * @returns {Promise<object>} inserted row
 */
async function insertDiagnoseRun(data) {
  const {
    connectionId,
    agentVersion = null,
    host = null,
    detectedSids = [],
    listenerServices = [],
    chosenService = null,
    probes = [],
    roundtripMs = null,
  } = data;

  const probes_arr = Array.isArray(probes) ? probes : [];
  const passCount = probes_arr.filter(p => p.status === 'pass').length;
  const failCount = probes_arr.filter(p => p.status === 'fail').length;
  const skipCount = probes_arr.filter(p => p.status === 'skip').length;
  const overallStatus = failCount > 0 ? 'fail' : 'pass';

  const res = await pool.query(
    `INSERT INTO agent_diagnose_runs
       (connection_id, agent_version, host, detected_sids, listener_services, chosen_service,
        probes, roundtrip_ms, overall_status, pass_count, fail_count, skip_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      connectionId,
      agentVersion,
      host,
      detectedSids,
      listenerServices,
      chosenService,
      JSON.stringify(probes_arr),
      roundtripMs,
      overallStatus,
      passCount,
      failCount,
      skipCount,
    ]
  );
  return res.rows[0];
}

/**
 * Get the latest diagnose run for a connection.
 * Returns null if no runs exist.
 */
async function getLatestDiagnoseRun(connectionId) {
  const res = await pool.query(
    `SELECT * FROM agent_diagnose_runs
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [connectionId]
  );
  return res.rows[0] || null;
}

/**
 * Get the latest diagnose runs for multiple connections in one query.
 * Returns a map of connectionId -> row.
 *
 * @param {number[]} connectionIds
 * @returns {Promise<Record<number, object>>}
 */
async function getLatestDiagnoseRunsForConnections(connectionIds) {
  if (!connectionIds.length) return {};
  const res = await pool.query(
    `SELECT DISTINCT ON (connection_id) *
     FROM agent_diagnose_runs
     WHERE connection_id = ANY($1)
     ORDER BY connection_id, created_at DESC`,
    [connectionIds]
  );
  const map = {};
  for (const row of res.rows) {
    map[row.connection_id] = row;
  }
  return map;
}

/**
 * List recent diagnose runs for a connection (for history view).
 * Returns up to `limit` rows, newest first.
 */
async function listDiagnoseRuns(connectionId, limit = 20) {
  const res = await pool.query(
    `SELECT * FROM agent_diagnose_runs
     WHERE connection_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [connectionId, limit]
  );
  return res.rows;
}

module.exports = {
  insertDiagnoseRun,
  getLatestDiagnoseRun,
  getLatestDiagnoseRunsForConnections,
  listDiagnoseRuns,
};
