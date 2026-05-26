/**
 * routes/db-clone.js — DB Clone & Scale guided wizard API + page.
 *
 * Owns: /db-clone page, /api/db-clone/* endpoints (recipes CRUD, history,
 *       step execution, pre-flight checks, Data Pump catalog).
 * Does NOT own: SSH execution (services/ssh-executor.js), Oracle connection
 *               auth (server.js), SSH credential storage (db/ssh-targets.js),
 *               EBS-specific clone operations (routes/ebs-clone.js).
 *
 * Routes:
 *   GET  /db-clone                             — serve wizard page
 *   GET  /api/db-clone/connections             — list connections for current user
 *   GET  /api/db-clone/recipes                 — list recipes for company
 *   GET  /api/db-clone/recipes/:id             — get recipe by id
 *   POST /api/db-clone/recipes                 — create recipe
 *   PUT  /api/db-clone/recipes/:id             — update recipe
 *   DELETE /api/db-clone/recipes/:id           — delete recipe
 *   GET  /api/db-clone/history                 — clone run history
 *   POST /api/db-clone/history/start           — start a clone run
 *   POST /api/db-clone/history/:id/finish      — finish a clone run
 *   GET  /api/db-clone/ssh-targets/:connId     — SSH targets for a connection
 *   POST /api/db-clone/execute-step            — execute a single clone step via SSH
 *   GET  /api/db-clone/commands                — list available DB clone commands
 */

'use strict';

const express = require('express');
const path    = require('path');
const sshDb   = require('../db/ssh-targets');
const recipeDb = require('../db/clone-recipes');
const executor = require('../services/ssh-executor');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function companyId(user) {
  return user.company_domain || user.email.split('@')[1] || `user_${user.id}`;
}

// ── GET /db-clone ─────────────────────────────────────────────────────────────

router.get('/db-clone', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'db-clone.html'));
});

// ── GET /api/db-clone/connections ─────────────────────────────────────────────
// All connections for the user — DB clone works with any Oracle connection,
// not just EBS-detected ones.

router.get('/api/db-clone/connections', requireAuth, async (req, res) => {
  try {
    const connections = await recipeDb.listConnectionsForUser(req.user.id);
    res.json({ success: true, connections });
  } catch (err) {
    console.error('[db-clone] connections error:', err.message);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// ── GET /api/db-clone/recipes ─────────────────────────────────────────────────

router.get('/api/db-clone/recipes', requireAuth, async (req, res) => {
  try {
    const recipes = await recipeDb.listRecipes(companyId(req.user));
    res.json({ success: true, recipes });
  } catch (err) {
    console.error('[db-clone] list recipes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// ── GET /api/db-clone/recipes/:id ─────────────────────────────────────────────

router.get('/api/db-clone/recipes/:id', requireAuth, async (req, res) => {
  try {
    const recipe = await recipeDb.getRecipeById(parseInt(req.params.id, 10));
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    if (recipe.company_id !== companyId(req.user)) return res.status(403).json({ error: 'Access denied' });
    res.json({ success: true, recipe });
  } catch (err) {
    console.error('[db-clone] get recipe error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// ── POST /api/db-clone/recipes ────────────────────────────────────────────────

router.post('/api/db-clone/recipes', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const {
      source_connection_id,
      target_connection_id,
      recipe_name,
      pre_checks_config,
      clone_steps,
      post_steps,
    } = req.body;

    if (!recipe_name || !recipe_name.trim()) {
      return res.status(400).json({ error: 'recipe_name is required' });
    }

    const recipe = await recipeDb.createRecipe({
      companyId: companyId(req.user),
      sourceConnectionId: source_connection_id ? parseInt(source_connection_id, 10) : null,
      targetConnectionId: target_connection_id ? parseInt(target_connection_id, 10) : null,
      recipeName: recipe_name.trim(),
      preChecksConfig: pre_checks_config || {},
      cloneSteps: clone_steps || [],
      postSteps: post_steps || [],
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, recipe });
  } catch (err) {
    console.error('[db-clone] create recipe error:', err.message);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// ── PUT /api/db-clone/recipes/:id ─────────────────────────────────────────────

router.put('/api/db-clone/recipes/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await recipeDb.getRecipeById(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found' });
    if (existing.company_id !== companyId(req.user)) return res.status(403).json({ error: 'Access denied' });

    const updated = await recipeDb.updateRecipe(id, {
      recipeName: req.body.recipe_name,
      preChecksConfig: req.body.pre_checks_config,
      cloneSteps: req.body.clone_steps,
      postSteps: req.body.post_steps,
      sourceConnectionId: req.body.source_connection_id,
      targetConnectionId: req.body.target_connection_id,
    });

    res.json({ success: true, recipe: updated });
  } catch (err) {
    console.error('[db-clone] update recipe error:', err.message);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// ── DELETE /api/db-clone/recipes/:id ──────────────────────────────────────────

router.delete('/api/db-clone/recipes/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await recipeDb.getRecipeById(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found' });
    if (existing.company_id !== companyId(req.user)) return res.status(403).json({ error: 'Access denied' });
    await recipeDb.deleteRecipe(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[db-clone] delete recipe error:', err.message);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

// ── GET /api/db-clone/history ─────────────────────────────────────────────────

router.get('/api/db-clone/history', requireAuth, async (req, res) => {
  try {
    const { recipe_id, limit } = req.query;
    const history = await recipeDb.listHistory(companyId(req.user), {
      recipeId: recipe_id ? parseInt(recipe_id, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ success: true, history });
  } catch (err) {
    console.error('[db-clone] history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ── POST /api/db-clone/history/start ──────────────────────────────────────────

router.post('/api/db-clone/history/start', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const { recipe_id, source_connection_id, target_connection_id, total_steps } = req.body;
    const run = await recipeDb.startRun({
      recipeId: recipe_id ? parseInt(recipe_id, 10) : null,
      companyId: companyId(req.user),
      sourceConnectionId: source_connection_id ? parseInt(source_connection_id, 10) : null,
      targetConnectionId: target_connection_id ? parseInt(target_connection_id, 10) : null,
      startedBy: req.user.id,
      totalSteps: total_steps || 0,
    });
    res.json({ success: true, run });
  } catch (err) {
    console.error('[db-clone] start run error:', err.message);
    res.status(500).json({ error: 'Failed to start clone run' });
  }
});

// ── POST /api/db-clone/history/:id/finish ─────────────────────────────────────

router.post('/api/db-clone/history/:id/finish', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const runId = parseInt(req.params.id, 10);
    const { status, error_message } = req.body;
    if (!['success', 'failed', 'aborted'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await recipeDb.finishRun(runId, { status, errorMessage: error_message });
    res.json({ success: true });
  } catch (err) {
    console.error('[db-clone] finish run error:', err.message);
    res.status(500).json({ error: 'Failed to finish clone run' });
  }
});

// ── GET /api/db-clone/ssh-targets/:connId ─────────────────────────────────────

router.get('/api/db-clone/ssh-targets/:connId', requireAuth, async (req, res) => {
  try {
    const connId = parseInt(req.params.connId, 10);
    const all = await sshDb.listTargetsByUser(req.user.id);
    // Prefer db_tier targets; fall back to any target for the connection or unlinked
    const targets = all.filter(t => !t.connection_id || t.connection_id === connId);
    res.json({ success: true, targets: targets.map(t => ({
      id: t.id,
      host: t.host,
      port: t.port,
      os_user: t.os_user,
      role: t.role,
      auth_method: t.auth_method,
      display_label: `${t.os_user}@${t.host} (${t.role})`,
    }))});
  } catch (err) {
    console.error('[db-clone] ssh-targets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch SSH targets' });
  }
});

// ── GET /api/db-clone/commands ────────────────────────────────────────────────
// Returns the subset of whitelisted commands relevant to DB clone operations.

router.get('/api/db-clone/commands', requireAuth, async (req, res) => {
  try {
    const allCmds = executor.getWhitelist();
    // Filter to db_tier commands + system diagnostic commands for clone context
    const dbCloneKeys = Object.entries(allCmds)
      .filter(([, def]) => def.allowedRoles.includes('db_tier'))
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
    res.json({ success: true, commands: dbCloneKeys });
  } catch (err) {
    console.error('[db-clone] commands error:', err.message);
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

// ── POST /api/db-clone/execute-step ───────────────────────────────────────────
// Execute a single DB clone wizard step via the SSH executor.
// Body: { target_id, command_key, run_id?, step_index? }

router.post('/api/db-clone/execute-step', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const { target_id, command_key, run_id, step_index } = req.body;

    if (!target_id || !command_key) {
      return res.status(400).json({ error: 'target_id and command_key required' });
    }

    const target = await sshDb.getTargetByIdForUserWithCreds(target_id, req.user.id);
    if (!target) return res.status(404).json({ error: 'SSH target not found or access denied' });

    const startMs = Date.now();
    const result = await executor.runCommand({
      targetId: parseInt(target_id, 10),
      commandKey: command_key,
      initiatedBy: req.user.id,
    });
    const durationMs = Date.now() - startMs;

    const stepResult = {
      command_key,
      target_id,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      success: result.ok,
      rejected: result.rejected || false,
      rejection_reason: result.rejectionReason || null,
      duration_ms: durationMs,
      ran_at: new Date().toISOString(),
    };

    if (run_id && step_index !== undefined) {
      recipeDb.appendStepResult(parseInt(run_id, 10), step_index, stepResult).catch(e => {
        console.error('[db-clone] appendStepResult error:', e.message);
      });
    }

    res.json({ success: true, result: stepResult });
  } catch (err) {
    console.error('[db-clone] execute-step error:', err.message);
    res.status(500).json({ error: err.message || 'Step execution failed' });
  }
});

module.exports = router;
