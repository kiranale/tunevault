/**
 * services/adop-detector.js — ADOP state detection orchestrator.
 *
 * Owns: wiring oracle-client/agent-channel queryFn to the lib/ebs/adop-state
 *       detector, and persisting the result via db/ebs-adop-state.
 * Does NOT own: the detection logic (lib/ebs/adop-state.js), SQL execution
 *               (oracle-client.js / agent-channel.js), or serving the API.
 *
 * Call detectAndPersistAdopState(connectionId) fire-and-forget after each
 * health-pack run. It never throws.
 */

'use strict';

const agentChannel  = require('./agent-channel');
const { detectAdopState } = require('../lib/ebs/adop-state');
const adopDb         = require('../db/ebs-adop-state');
const pool           = require('../db/index');

/**
 * Detect ADOP state for a connection and persist the result.
 *
 * Execution path:
 *  1. Load connection record to check connectivity_mode + ebs detected flag.
 *  2. Route to agent channel (TNS / proxy path) or skip for non-EBS connections.
 *  3. Call detectAdopState(queryFn) → AdopState.
 *  4. Upsert into ebs_adop_state.
 *
 * Never throws — all errors are swallowed and logged.
 *
 * @param {number} connectionId
 */
async function detectAndPersistAdopState(connectionId) {
  try {
    // Load connection metadata
    const { rows } = await pool.query(
      `SELECT id, is_ebs, ebs_checks_enabled, connectivity_mode,
              ssh_db_host, ssh_db_user, ssh_db_key_enc, ssh_oracle_home, ssh_oracle_sid
       FROM   oracle_connections
       WHERE  id = $1`,
      [connectionId]
    );
    const conn = rows[0];
    if (!conn) return;

    // Only run ADOP check on EBS connections — skip plain Oracle/non-EBS
    if (!conn.is_ebs && !conn.ebs_checks_enabled) return;

    // Build a queryFn that routes queries via the agent channel
    const queryFn = await _buildQueryFn(conn);
    if (!queryFn) {
      // Agent not connected and SSH not configured — skip silently
      return;
    }

    const state = await detectAdopState(queryFn);
    await adopDb.upsertAdopState(connectionId, state);

    if (state.patching) {
      console.log(
        `[adop-detector] conn=${connectionId} patching=true phase=${state.phase || 'unknown'} ` +
        `services=${state.services_in_patch_mode.join(',')}`
      );
    }
  } catch (err) {
    // Fire-and-forget — never crash the caller
    console.error(`[adop-detector] conn=${connectionId} error=${err.message}`);
  }
}

/**
 * Build a queryFn that sends a SQL query to Oracle via the agent channel.
 *
 * Uses /api/execute-sql if available (proxy v3.5.5+), otherwise falls back
 * to health-check-based probe which is a best-effort approach.
 *
 * Returns null when no execution path is available (agent offline, no SSH).
 *
 * @param {object} conn — oracle_connections row
 * @returns {Function|null}
 */
async function _buildQueryFn(conn) {
  const mode = conn.connectivity_mode || 'tns';

  // SSH sqlplus path — use oracle-runner
  if (mode === 'ssh_sqlplus' || mode === 'both') {
    if (conn.ssh_db_host && conn.ssh_db_user && conn.ssh_db_key_enc) {
      let oracleRunner;
      try { oracleRunner = require('./oracle-runner'); } catch (_) { /* not available */ }
      if (oracleRunner) {
        return async (sql) => {
          return oracleRunner.runQuery(conn, sql);
        };
      }
    }
  }

  // TNS path — use agent channel /api/sql if agent is connected
  if (agentChannel.isAgentConnected(conn.id)) {
    return async (sql) => {
      try {
        const resp = await agentChannel.sendToAgent(
          conn.id,
          {
            method: 'POST',
            path:   '/api/execute-sql',
            body:   { sql, bind: [] },
          },
          15_000
        );
        if (resp && resp.ok !== false && Array.isArray(resp.rows)) {
          // Normalize: agent returns { rows: [[col,val], ...] } or { rows: [{COL:val},...] }
          return { rows: resp.rows };
        }
        // If the agent doesn't support /api/execute-sql, return empty
        return { rows: [] };
      } catch (_) {
        return { rows: [] };
      }
    };
  }

  return null;
}

module.exports = { detectAndPersistAdopState };
