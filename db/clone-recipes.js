/**
 * db/clone-recipes.js — clone_recipes and clone_history table queries.
 *
 * Owns: CRUD for clone_recipes (wizard recipes) and clone_history (run log).
 * Does NOT own: SSH step execution (services/ssh-executor.js),
 *               route handling (routes/ebs-clone.js), Oracle connection auth.
 */

'use strict';

const pool = require('./index');

// ── Clone Recipes ─────────────────────────────────────────────────────────────

/**
 * List recipes for a company, newest first.
 */
async function listRecipes(companyId) {
  const { rows } = await pool.query(
    `SELECT r.*,
            s.display_name AS source_display_name,
            t.display_name AS target_display_name,
            u.email        AS created_by_email
     FROM clone_recipes r
     LEFT JOIN oracle_connections s ON s.id = r.source_connection_id
     LEFT JOIN oracle_connections t ON t.id = r.target_connection_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.company_id = $1
     ORDER BY r.updated_at DESC`,
    [companyId]
  );
  return rows;
}

/**
 * Get a single recipe by id. Returns null if not found.
 */
async function getRecipeById(id) {
  const { rows } = await pool.query(
    `SELECT r.*,
            s.display_name AS source_display_name,
            t.display_name AS target_display_name,
            u.email        AS created_by_email
     FROM clone_recipes r
     LEFT JOIN oracle_connections s ON s.id = r.source_connection_id
     LEFT JOIN oracle_connections t ON t.id = r.target_connection_id
     LEFT JOIN users u ON u.id = r.created_by
     WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Find the most recent recipe for a source→target pair within a company.
 */
async function findRecipeByPair(companyId, sourceConnectionId, targetConnectionId) {
  const { rows } = await pool.query(
    `SELECT * FROM clone_recipes
     WHERE company_id = $1
       AND source_connection_id = $2
       AND target_connection_id = $3
     ORDER BY updated_at DESC
     LIMIT 1`,
    [companyId, sourceConnectionId, targetConnectionId]
  );
  return rows[0] || null;
}

/**
 * Create a new recipe. Returns the created row.
 */
async function createRecipe({
  companyId,
  sourceConnectionId,
  targetConnectionId,
  recipeName,
  preChecksConfig = {},
  cloneSteps = [],
  postSteps = [],
  createdBy,
}) {
  const { rows } = await pool.query(
    `INSERT INTO clone_recipes
       (company_id, source_connection_id, target_connection_id,
        recipe_name, pre_checks_config, clone_steps, post_steps, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      companyId,
      sourceConnectionId || null,
      targetConnectionId || null,
      recipeName,
      JSON.stringify(preChecksConfig),
      JSON.stringify(cloneSteps),
      JSON.stringify(postSteps),
      createdBy || null,
    ]
  );
  return rows[0];
}

/**
 * Update recipe steps and metadata. Returns the updated row.
 */
async function updateRecipe(id, {
  recipeName,
  preChecksConfig,
  cloneSteps,
  postSteps,
  sourceConnectionId,
  targetConnectionId,
}) {
  const fields = [];
  const values = [];
  let i = 1;

  if (recipeName !== undefined)        { fields.push(`recipe_name = $${i++}`);           values.push(recipeName); }
  if (preChecksConfig !== undefined)   { fields.push(`pre_checks_config = $${i++}`);     values.push(JSON.stringify(preChecksConfig)); }
  if (cloneSteps !== undefined)        { fields.push(`clone_steps = $${i++}`);            values.push(JSON.stringify(cloneSteps)); }
  if (postSteps !== undefined)         { fields.push(`post_steps = $${i++}`);             values.push(JSON.stringify(postSteps)); }
  if (sourceConnectionId !== undefined){ fields.push(`source_connection_id = $${i++}`); values.push(sourceConnectionId || null); }
  if (targetConnectionId !== undefined){ fields.push(`target_connection_id = $${i++}`); values.push(targetConnectionId || null); }

  if (fields.length === 0) return getRecipeById(id);

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE clone_recipes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Delete a recipe by id.
 */
async function deleteRecipe(id) {
  await pool.query(`DELETE FROM clone_recipes WHERE id = $1`, [id]);
}

/**
 * Update last_run_at + last_run_status on a recipe.
 */
async function touchRecipeRun(id, status) {
  await pool.query(
    `UPDATE clone_recipes SET last_run_at = NOW(), last_run_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, id]
  );
}

// ── Clone History ─────────────────────────────────────────────────────────────

/**
 * Start a new history run for a recipe. Returns the created row.
 */
async function startRun({
  recipeId,
  companyId,
  sourceConnectionId,
  targetConnectionId,
  startedBy,
  totalSteps,
}) {
  const { rows } = await pool.query(
    `INSERT INTO clone_history
       (recipe_id, company_id, source_connection_id, target_connection_id,
        started_by, status, total_steps, step_results)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, '[]')
     RETURNING *`,
    [recipeId || null, companyId, sourceConnectionId || null, targetConnectionId || null, startedBy || null, totalSteps || 0]
  );
  return rows[0];
}

/**
 * Append a step result to a running history row.
 */
async function appendStepResult(runId, stepIndex, result) {
  await pool.query(
    `UPDATE clone_history
     SET step_results = step_results || $1::jsonb,
         current_step = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify([result]), stepIndex, runId]
  );
}

/**
 * Mark a run complete (success, failed, or aborted).
 */
async function finishRun(runId, { status, errorMessage }) {
  await pool.query(
    `UPDATE clone_history
     SET status = $1,
         completed_at = NOW(),
         error_message = $2,
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
     WHERE id = $3`,
    [status, errorMessage || null, runId]
  );
}

/**
 * List history runs for a company, newest first. Optional filter by recipe_id.
 */
async function listHistory(companyId, { recipeId, limit = 50 } = {}) {
  const params = [companyId];
  let where = `WHERE h.company_id = $1`;
  if (recipeId) {
    params.push(recipeId);
    where += ` AND h.recipe_id = $${params.length}`;
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT h.*,
            s.display_name AS source_display_name,
            t.display_name AS target_display_name,
            u.email        AS started_by_email
     FROM clone_history h
     LEFT JOIN oracle_connections s ON s.id = h.source_connection_id
     LEFT JOIN oracle_connections t ON t.id = h.target_connection_id
     LEFT JOIN users u ON u.id = h.started_by
     ${where}
     ORDER BY h.started_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * Get a single history run by id.
 */
async function getRunById(runId) {
  const { rows } = await pool.query(
    `SELECT h.*,
            s.display_name AS source_display_name,
            t.display_name AS target_display_name,
            u.email        AS started_by_email
     FROM clone_history h
     LEFT JOIN oracle_connections s ON s.id = h.source_connection_id
     LEFT JOIN oracle_connections t ON t.id = h.target_connection_id
     LEFT JOIN users u ON u.id = h.started_by
     WHERE h.id = $1`,
    [runId]
  );
  return rows[0] || null;
}

// ── Connection list (shared across clone wizards) ─────────────────────────────

/**
 * List all oracle_connections owned by a user. Used by clone wizard connection pickers.
 * Returns id, display_name, host, port, service_name, connection_type, ebs_detected, is_demo.
 */
async function listConnectionsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, display_name, host, port, service_name, connection_type,
            ebs_detected, is_demo
     FROM oracle_connections
     WHERE user_id = $1
     ORDER BY display_name`,
    [userId]
  );
  return rows;
}

module.exports = {
  listRecipes,
  getRecipeById,
  findRecipeByPair,
  createRecipe,
  updateRecipe,
  deleteRecipe,
  touchRecipeRun,
  startRun,
  appendStepResult,
  finishRun,
  listHistory,
  getRunById,
  listConnectionsForUser,
};
