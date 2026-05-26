/**
 * db/ebs-adop-state.js — CRUD for ebs_adop_state table.
 *
 * Owns: upsert + read of the ADOP patch-cycle state snapshot per connection.
 * Does NOT own: detecting ADOP state from Oracle (lib/ebs/adop-state.js),
 *               serving the API (routes/adop-state.js).
 */

'use strict';

const pool = require('./index');

/**
 * Upsert the ADOP state for a connection.
 * Called after each health-pack run by the schedule-runner or first-run flow.
 *
 * @param {number}  connectionId
 * @param {object}  state  — AdopState object from lib/ebs/adop-state.js
 */
async function upsertAdopState(connectionId, state) {
  await pool.query(
    `INSERT INTO ebs_adop_state
       (connection_id, patching, phase, session_id, started_at,
        services_in_patch_mode, source, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (connection_id) DO UPDATE SET
       patching               = EXCLUDED.patching,
       phase                  = EXCLUDED.phase,
       session_id             = EXCLUDED.session_id,
       started_at             = EXCLUDED.started_at,
       services_in_patch_mode = EXCLUDED.services_in_patch_mode,
       source                 = EXCLUDED.source,
       checked_at             = EXCLUDED.checked_at`,
    [
      connectionId,
      state.patching,
      state.phase   || null,
      state.session_id !== null && state.session_id !== undefined
        ? String(state.session_id) : null,
      state.started_at || null,
      JSON.stringify(state.services_in_patch_mode || []),
      state.source  || 'vactive_services_only',
      state.checked_at || new Date(),
    ]
  );
}

/**
 * Get the latest ADOP state for a single connection.
 *
 * @param {number} connectionId
 * @returns {object|null}  row or null if not yet detected
 */
async function getAdopState(connectionId) {
  const { rows } = await pool.query(
    `SELECT connection_id, patching, phase, session_id, started_at,
            services_in_patch_mode, source, checked_at
     FROM   ebs_adop_state
     WHERE  connection_id = $1`,
    [connectionId]
  );
  return rows[0] || null;
}

/**
 * Get ADOP state for all connections that have patching=TRUE.
 * Used by fleet overview to surface a fleet-wide banner.
 *
 * @param {number[]} connectionIds  — filter to just these connections
 * @returns {object[]}
 */
async function getAdopStateForConnections(connectionIds) {
  if (!connectionIds || connectionIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT connection_id, patching, phase, session_id, started_at,
            services_in_patch_mode, source, checked_at
     FROM   ebs_adop_state
     WHERE  connection_id = ANY($1)`,
    [connectionIds]
  );
  return rows;
}

/**
 * Return just the patching flag + phase for a connection — lightweight poll.
 * Used by the banner JS poll endpoint.
 *
 * @param {number} connectionId
 * @returns {{ patching: boolean, phase: string|null, checked_at: Date }|null}
 */
async function getAdopPatchingFlag(connectionId) {
  const { rows } = await pool.query(
    `SELECT patching, phase, session_id, started_at, checked_at
     FROM   ebs_adop_state
     WHERE  connection_id = $1`,
    [connectionId]
  );
  if (!rows[0]) return null;
  return {
    patching:    rows[0].patching,
    phase:       rows[0].phase,
    session_id:  rows[0].session_id,
    started_at:  rows[0].started_at,
    checked_at:  rows[0].checked_at,
  };
}

module.exports = {
  upsertAdopState,
  getAdopState,
  getAdopStateForConnections,
  getAdopPatchingFlag,
};
