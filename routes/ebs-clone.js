/**
 * routes/ebs-clone.js — EBS Clone & Scale wizard API + page.
 *
 * Owns: /ebs-clone page, /api/ebs-clone/* endpoints (recipes CRUD, history, step execution).
 * Does NOT own: SSH execution (services/ssh-executor.js), Oracle connection auth (server.js),
 *               SSH credential storage (db/ssh-targets.js).
 *
 * Routes:
 *   GET  /ebs-clone                           — serve the wizard page
 *   GET  /api/ebs-clone/connections           — list EBS-detected connections for current user
 *   GET  /api/ebs-clone/recipes               — list recipes for company
 *   GET  /api/ebs-clone/recipes/:id           — get recipe by id
 *   POST /api/ebs-clone/recipes               — create recipe
 *   PUT  /api/ebs-clone/recipes/:id           — update recipe
 *   DELETE /api/ebs-clone/recipes/:id         — delete recipe
 *   GET  /api/ebs-clone/history               — clone run history
 *   POST /api/ebs-clone/history/start         — start a clone run (creates history row)
 *   POST /api/ebs-clone/history/:id/finish    — finish a clone run
 *   GET  /api/ebs-clone/ssh-targets/:connId   — SSH targets for a connection
 *   POST /api/ebs-clone/execute-step          — execute a single clone step via SSH
 */

'use strict';

const express    = require('express');
const path       = require('path');
const pool       = require('../db/index');
const sshDb      = require('../db/ssh-targets');
const recipeDb   = require('../db/clone-recipes');
const executor   = require('../services/ssh-executor');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Company ID from authenticated user ───────────────────────────────────────

function companyId(user) {
  return user.company_domain || user.email.split('@')[1] || `user_${user.id}`;
}

// ── GET /ebs-clone ────────────────────────────────────────────────────────────

router.get('/ebs-clone', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-clone.html'));
});

// ── GET /api/ebs-clone/connections ───────────────────────────────────────────
// Returns connections with EBS detected for current user (or all for team).
// Frontend shows display_name only — no env labels.

router.get('/api/ebs-clone/connections', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, display_name, host, port, service_name, connection_type,
              ebs_detected, ebs_login_url, is_demo
       FROM oracle_connections
       WHERE user_id = $1
       ORDER BY display_name`,
      [req.user.id]
    );
    res.json({ success: true, connections: rows });
  } catch (err) {
    console.error('[ebs-clone] connections error:', err.message);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

// ── GET /api/ebs-clone/recipes ────────────────────────────────────────────────

router.get('/api/ebs-clone/recipes', requireAuth, async (req, res) => {
  try {
    const recipes = await recipeDb.listRecipes(companyId(req.user));
    res.json({ success: true, recipes });
  } catch (err) {
    console.error('[ebs-clone] list recipes error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// ── GET /api/ebs-clone/recipes/:id ───────────────────────────────────────────

router.get('/api/ebs-clone/recipes/:id', requireAuth, async (req, res) => {
  try {
    const recipe = await recipeDb.getRecipeById(parseInt(req.params.id, 10));
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    if (recipe.company_id !== companyId(req.user)) return res.status(403).json({ error: 'Access denied' });
    res.json({ success: true, recipe });
  } catch (err) {
    console.error('[ebs-clone] get recipe error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recipe' });
  }
});

// ── POST /api/ebs-clone/recipes ───────────────────────────────────────────────
// Body: { source_connection_id, target_connection_id, recipe_name, pre_checks_config, clone_steps, post_steps }

router.post('/api/ebs-clone/recipes', requireAuth, requireRole('senior_dba'), async (req, res) => {
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
    console.error('[ebs-clone] create recipe error:', err.message);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// ── PUT /api/ebs-clone/recipes/:id ───────────────────────────────────────────

router.put('/api/ebs-clone/recipes/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
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
    console.error('[ebs-clone] update recipe error:', err.message);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// ── DELETE /api/ebs-clone/recipes/:id ────────────────────────────────────────

router.delete('/api/ebs-clone/recipes/:id', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await recipeDb.getRecipeById(id);
    if (!existing) return res.status(404).json({ error: 'Recipe not found' });
    if (existing.company_id !== companyId(req.user)) return res.status(403).json({ error: 'Access denied' });
    await recipeDb.deleteRecipe(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[ebs-clone] delete recipe error:', err.message);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

// ── GET /api/ebs-clone/history ────────────────────────────────────────────────

router.get('/api/ebs-clone/history', requireAuth, async (req, res) => {
  try {
    const { recipe_id, limit } = req.query;
    const history = await recipeDb.listHistory(companyId(req.user), {
      recipeId: recipe_id ? parseInt(recipe_id, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    res.json({ success: true, history });
  } catch (err) {
    console.error('[ebs-clone] history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ── POST /api/ebs-clone/history/start ────────────────────────────────────────
// Body: { recipe_id?, source_connection_id, target_connection_id, total_steps }

router.post('/api/ebs-clone/history/start', requireAuth, requireRole('senior_dba'), async (req, res) => {
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
    console.error('[ebs-clone] start run error:', err.message);
    res.status(500).json({ error: 'Failed to start clone run' });
  }
});

// ── POST /api/ebs-clone/history/:id/finish ───────────────────────────────────
// Body: { status: 'success'|'failed'|'aborted', error_message? }

router.post('/api/ebs-clone/history/:id/finish', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const runId = parseInt(req.params.id, 10);
    const { status, error_message } = req.body;
    if (!['success', 'failed', 'aborted'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await recipeDb.finishRun(runId, { status, errorMessage: error_message });
    res.json({ success: true });
  } catch (err) {
    console.error('[ebs-clone] finish run error:', err.message);
    res.status(500).json({ error: 'Failed to finish clone run' });
  }
});

// ── GET /api/ebs-clone/ssh-targets/:connId ───────────────────────────────────

router.get('/api/ebs-clone/ssh-targets/:connId', requireAuth, async (req, res) => {
  try {
    const connId = parseInt(req.params.connId, 10);
    // Return user-owned targets, filtering to those linked to this connection (or unlinked)
    const all = await sshDb.listTargetsByUser(req.user.id);
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
    console.error('[ebs-clone] ssh-targets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch SSH targets' });
  }
});

// ── POST /api/ebs-clone/execute-step ─────────────────────────────────────────
// Executes a single clone wizard step via whitelisted SSH commands.
// Body: { target_id, command_key, run_id?, step_index? }
//
// For custom/free-text steps the command is run through 'clone.custom' command_key
// which executes the pre-parameterized template. Custom scripts are only allowed
// when the step type is 'custom' and require senior_dba role.

router.post('/api/ebs-clone/execute-step', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const { target_id, command_key, run_id, step_index } = req.body;

    if (!target_id || !command_key) {
      return res.status(400).json({ error: 'target_id and command_key required' });
    }

    // Ownership check: use user-scoped lookup (includes admin-managed targets with null user_id)
    const target = await sshDb.getTargetByIdForUserWithCreds(target_id, req.user.id);
    if (!target) return res.status(404).json({ error: 'SSH target not found or access denied' });

    const startMs = Date.now();
    // runCommand takes { targetId, commandKey, initiatedBy } — targetId is a number looked up internally
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

    // Optionally record the step result in the history run
    if (run_id && step_index !== undefined) {
      try {
        await recipeDb.appendStepResult(parseInt(run_id, 10), step_index, stepResult);
      } catch (e) {
        console.error('[ebs-clone] appendStepResult error:', e.message);
      }
    }

    res.json({ success: true, result: stepResult });
  } catch (err) {
    console.error('[ebs-clone] execute-step error:', err.message);
    res.status(500).json({ error: err.message || 'Step execution failed' });
  }
});

module.exports = router;
