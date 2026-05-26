/**
 * db/sql-tuning.js — PostgreSQL queries for the SQL Tuning module.
 *
 * Owns: sql_tuning_findings CRUD — persisting, loading, and purging tuning analysis.
 * Does NOT own: Oracle query execution (routes/sql-tuning.js), auth, Pool construction,
 *               or any other module's data.
 */

'use strict';

const pool = require('./index');

/**
 * upsertTuningFindings — bulk-insert (or replace) a full tuning run for a connection.
 * Deletes all prior findings for this connection before inserting the new batch.
 * Atomic via a single transaction so the UI never sees a partial result.
 *
 * @param {number} connectionId
 * @param {Array<object>} findings  Normalized finding objects from routes/sql-tuning.js
 * @returns {Promise<void>}
 */
async function upsertTuningFindings(connectionId, findings) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Purge stale findings for this connection (keep only the latest run)
    await client.query(
      'DELETE FROM sql_tuning_findings WHERE connection_id = $1',
      [connectionId]
    );

    for (const f of findings) {
      await client.query(
        `INSERT INTO sql_tuning_findings (
           connection_id, sql_id, plan_hash, rank,
           parsing_schema_name, executions,
           elapsed_per_exec_ms, cpu_per_exec_ms,
           buffer_gets_per_exec, disk_reads_per_exec, rows_processed_per_exec,
           sql_text, metrics_json, plan_summary_json,
           ai_recommendation_text, recommended_sql_text,
           fix_type, diagnosis_tag, is_heuristic, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())`,
        [
          connectionId,
          f.sql_id,
          f.plan_hash || null,
          f.rank || null,
          f.parsing_schema_name || null,
          f.executions || 0,
          f.elapsed_per_exec_ms || 0,
          f.cpu_per_exec_ms || 0,
          f.buffer_gets_per_exec || 0,
          f.disk_reads_per_exec || 0,
          f.rows_processed_per_exec || 0,
          f.sql_text || null,
          JSON.stringify(f.metrics_json || {}),
          JSON.stringify(f.plan_summary_json || []),
          f.ai_recommendation_text || null,
          f.recommended_sql_text || null,
          f.fix_type || null,
          f.diagnosis_tag || null,
          f.is_heuristic || false,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * getTuningFindings — fetch the latest tuning findings for a connection.
 *
 * @param {number} connectionId
 * @returns {Promise<Array<object>>}
 */
async function getTuningFindings(connectionId) {
  const result = await pool.query(
    `SELECT
       id, sql_id, plan_hash, rank,
       parsing_schema_name, executions,
       elapsed_per_exec_ms, cpu_per_exec_ms,
       buffer_gets_per_exec, disk_reads_per_exec, rows_processed_per_exec,
       sql_text, metrics_json, plan_summary_json,
       ai_recommendation_text, recommended_sql_text,
       fix_type, diagnosis_tag, is_heuristic, created_at
     FROM sql_tuning_findings
     WHERE connection_id = $1
     ORDER BY rank ASC NULLS LAST, elapsed_per_exec_ms DESC`,
    [connectionId]
  );
  return result.rows;
}

/**
 * getConnectionForTuning — load an oracle_connection row (ownership-checked).
 * Returns null if not found or not owned by userId.
 *
 * @param {number} connId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getConnectionForTuning(connId, userId) {
  const result = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections
     WHERE id = $1 AND user_id = $2`,
    [connId, userId]
  );
  return result.rows[0] || null;
}

/**
 * getUserForTuning — load a user row by id (used by auth middleware).
 *
 * @param {number} userId
 * @returns {Promise<{id, email}|null>}
 */
async function getUserForTuning(userId) {
  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

module.exports = { upsertTuningFindings, getTuningFindings, getConnectionForTuning, getUserForTuning };
