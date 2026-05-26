/**
 * routes/admin-smoke-tests.js — Admin test suite: UI smoke tests + dry-run preview.
 *
 * Owns: /admin/smoke-tests page, /api/admin/smoke-tests/* endpoints.
 *       Validates all TuneVault operations (DB Ops, EBS Ops, Clone wizards, console, terminal).
 *       Provides dry-run/preview mode — shows command that WOULD run without executing.
 * Does NOT own: actual Oracle execution, SSH vault, user auth state, health check logic.
 *
 * Mounted at: /admin/smoke-tests + /api/admin/smoke-tests (see server.js)
 * Admin-only — requires ADMIN_EMAILS membership.
 */

'use strict';

const express  = require('express');
const path     = require('path');
const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// ─── Lazy-load op catalog (avoids ssh2 module crash in local dev without deps) ─

function getOpCatalog() {
  try {
    return require('../services/db-ops-executor').getOpCatalog();
  } catch {
    return [];
  }
}

// ─── GET /admin/smoke-tests — serve the test dashboard ───────────────────────

router.get('/', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'smoke-tests.html'));
});

// ─── GET /api/admin/smoke-tests/catalog — all ops across all categories ──────

router.get('/catalog', requireAdmin, (req, res) => {
  const catalog = getOpCatalog();

  // Layer 1: DB Ops (from executor catalog)
  const dbOps = catalog.map(op => ({
    suite:       'db-ops',
    key:         op.key,
    label:       op.label,
    category:    op.category,
    type:        op.type,
    destructive: op.destructive,
    requiresEbs: op.requiresEbs || false,
    requiresAsm: op.requiresAsm || false,
    requiresRac: op.requiresRac || false,
    requiresGi:  op.requiresGi  || false,
    commandPreview: op.commandPreview || null,
  }));

  // Layer 2: EBS Ops SSH checks (static catalog)
  const ebsOps = getEbsOpsCatalog();

  // Layer 3: Clone wizard steps
  const cloneOps = getCloneCatalog();

  // Layer 4: Pages / UI surfaces
  const uiSurfaces = getUiSurfaces();

  res.json({ dbOps, ebsOps, cloneOps, uiSurfaces });
});

// ─── POST /api/admin/smoke-tests/run-ui-checks — Layer 1 smoke tests ─────────
// Validates: catalog loads, all ops have required fields, preview generates correctly.
// No Oracle connection required — all checks are static analysis.

router.post('/run-ui-checks', requireAdmin, (req, res) => {
  const started = Date.now();
  const results = [];

  // ── Check 1: DB Ops catalog loads and has entries ──────────────────────────
  let catalog = [];
  try {
    catalog = getOpCatalog();
    results.push({
      id: 'dbops.catalog.loads',
      label: 'DB Ops catalog loads without errors',
      pass: catalog.length > 0,
      detail: `${catalog.length} operations in catalog`,
    });
  } catch (err) {
    results.push({
      id: 'dbops.catalog.loads',
      label: 'DB Ops catalog loads without errors',
      pass: false,
      detail: `Error: ${err.message}`,
    });
  }

  // ── Check 2: All ops have required fields ──────────────────────────────────
  const missingFields = catalog.filter(op =>
    !op.key || !op.label || !op.category || !op.type
  );
  results.push({
    id: 'dbops.catalog.fields',
    label: 'All ops have key, label, category, type',
    pass: missingFields.length === 0,
    detail: missingFields.length === 0
      ? `All ${catalog.length} ops valid`
      : `Missing fields: ${missingFields.map(o => o.key).join(', ')}`,
  });

  // ── Check 3: No duplicate op keys ─────────────────────────────────────────
  const keys = catalog.map(o => o.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  results.push({
    id: 'dbops.catalog.unique-keys',
    label: 'No duplicate op keys',
    pass: dupes.length === 0,
    detail: dupes.length === 0 ? 'All keys unique' : `Duplicates: ${dupes.join(', ')}`,
  });

  // ── Check 4: All categories are known/valid ────────────────────────────────
  const VALID_CATEGORIES = [
    'instance', 'listener', 'pdb', 'tablespace', 'sessions', 'memory',
    'stats', 'archive', 'rman', 'asm', 'rac',
    'wls', 'apache', 'apps_listener', 'ebs_concurrent',
  ];
  const unknownCats = [...new Set(catalog.map(o => o.category))]
    .filter(c => !VALID_CATEGORIES.includes(c));
  results.push({
    id: 'dbops.catalog.categories',
    label: 'All op categories are known',
    pass: unknownCats.length === 0,
    detail: unknownCats.length === 0
      ? `${VALID_CATEGORIES.length} valid categories`
      : `Unknown: ${unknownCats.join(', ')}`,
  });

  // ── Check 5: EBS ops have requiresEbs flag ─────────────────────────────────
  const ebsCats = ['wls', 'apache', 'apps_listener', 'ebs_concurrent'];
  const ebsOpsWithoutFlag = catalog
    .filter(o => ebsCats.includes(o.category) && !o.requiresEbs);
  results.push({
    id: 'dbops.ebs-flag',
    label: 'EBS category ops have requiresEbs flag',
    pass: ebsOpsWithoutFlag.length === 0,
    detail: ebsOpsWithoutFlag.length === 0
      ? 'All EBS ops correctly flagged'
      : `Missing flag: ${ebsOpsWithoutFlag.map(o => o.key).join(', ')}`,
  });

  // ── Check 6: ASM ops have requiresAsm flag ────────────────────────────────
  const asmOpsWithoutFlag = catalog
    .filter(o => o.category === 'asm' && !o.requiresAsm && !o.requiresGi);
  results.push({
    id: 'dbops.asm-flag',
    label: 'ASM category ops have requiresAsm or requiresGi flag',
    pass: asmOpsWithoutFlag.length === 0,
    detail: asmOpsWithoutFlag.length === 0
      ? 'All ASM ops correctly flagged'
      : `Missing flag: ${asmOpsWithoutFlag.map(o => o.key).join(', ')}`,
  });

  // ── Check 7: RAC ops have requiresRac flag ────────────────────────────────
  const racOpsWithoutFlag = catalog
    .filter(o => o.category === 'rac' && !o.requiresRac && !o.requiresGi);
  results.push({
    id: 'dbops.rac-flag',
    label: 'RAC category ops have requiresRac or requiresGi flag',
    pass: racOpsWithoutFlag.length === 0,
    detail: racOpsWithoutFlag.length === 0
      ? 'All RAC ops correctly flagged'
      : `Missing flag: ${racOpsWithoutFlag.map(o => o.key).join(', ')}`,
  });

  // ── Check 8: Preview generates for all ops ───────────────────────────────
  const opsWithoutPreview = catalog.filter(o => !o.commandPreview);
  results.push({
    id: 'dbops.preview-generates',
    label: 'Command preview exists for all ops',
    pass: opsWithoutPreview.length === 0,
    detail: opsWithoutPreview.length === 0
      ? 'All ops have a preview'
      : `No preview: ${opsWithoutPreview.slice(0, 5).map(o => o.key).join(', ')}${opsWithoutPreview.length > 5 ? ` +${opsWithoutPreview.length - 5} more` : ''}`,
  });

  // ── Check 9: Destructive ops require confirmation ─────────────────────────
  const destructiveOps = catalog.filter(o => o.destructive);
  results.push({
    id: 'dbops.destructive-count',
    label: 'Destructive ops identified (require confirmation gate)',
    pass: destructiveOps.length > 0,
    detail: `${destructiveOps.length} destructive ops require confirmation: ${destructiveOps.slice(0, 5).map(o => o.key).join(', ')}${destructiveOps.length > 5 ? '...' : ''}`,
  });

  // ── Check 10: EBS SSH checks catalog loads ───────────────────────────────
  let ebsCatalog = [];
  try {
    ebsCatalog = getEbsOpsCatalog();
    results.push({
      id: 'ebs-ops.catalog.loads',
      label: 'EBS Ops SSH catalog loads',
      pass: ebsCatalog.length > 0,
      detail: `${ebsCatalog.length} EBS SSH checks`,
    });
  } catch (err) {
    results.push({
      id: 'ebs-ops.catalog.loads',
      label: 'EBS Ops SSH catalog loads',
      pass: false,
      detail: `Error: ${err.message}`,
    });
  }

  // ── Check 11: Clone wizard pages reachable (file exists) ──────────────────
  const fs = require('fs');
  const clonePages = [
    { id: 'clone.ebs.page', label: 'EBS Clone page file exists', file: 'public/ebs-clone.html' },
    { id: 'clone.db.page',  label: 'DB Clone page file exists',  file: 'public/db-clone.html' },
    { id: 'dbops.page',     label: 'DB Ops page file exists',    file: 'public/db-ops.html' },
    { id: 'console.page',   label: 'SQL Console page file exists', file: 'public/sql-console.html' },
    { id: 'terminal.page',  label: 'Terminal page file exists',  file: 'public/terminal.html' },
    { id: 'dashboard.page', label: 'Dashboard page file exists', file: 'public/dashboard.html' },
    { id: 'patches.page',   label: 'Patches page file exists',   file: 'public/patches.html' },
  ];
  for (const p of clonePages) {
    const exists = fs.existsSync(path.join(__dirname, '..', p.file));
    results.push({ id: p.id, label: p.label, pass: exists, detail: exists ? p.file : `Missing: ${p.file}` });
  }

  // ── Check 12: Route files exist ───────────────────────────────────────────
  const routeFiles = [
    { id: 'route.db-ops',    label: 'DB Ops route file exists',    file: 'routes/db-ops.js' },
    { id: 'route.db-clone',  label: 'DB Clone route file exists',  file: 'routes/db-clone.js' },
    { id: 'route.ebs-clone', label: 'EBS Clone route file exists', file: 'routes/ebs-clone.js' },
    { id: 'route.console',   label: 'SQL Console route file exists', file: 'routes/console.js' },
    { id: 'route.terminal',  label: 'Terminal route file exists',   file: 'routes/terminal.js' },
    { id: 'route.patches',   label: 'Patches route file exists',    file: 'routes/patches.js' },
  ];
  for (const r of routeFiles) {
    const exists = fs.existsSync(path.join(__dirname, '..', r.file));
    results.push({ id: r.id, label: r.label, pass: exists, detail: exists ? r.file : `Missing: ${r.file}` });
  }

  // ── Check 13: DB categorization summary ──────────────────────────────────
  const byCategory = {};
  for (const op of catalog) {
    byCategory[op.category] = (byCategory[op.category] || 0) + 1;
  }

  const elapsed = Date.now() - started;
  const passed  = results.filter(r => r.pass).length;
  const failed  = results.filter(r => !r.pass).length;

  res.json({
    summary: { total: results.length, passed, failed, elapsed_ms: elapsed, run_at: new Date().toISOString() },
    results,
    catalog_stats: {
      total_ops: catalog.length,
      by_category: byCategory,
      destructive_count: destructiveOps.length,
      ebs_only_count: catalog.filter(o => o.requiresEbs).length,
      asm_only_count: catalog.filter(o => o.requiresAsm || o.requiresGi).length,
      rac_only_count: catalog.filter(o => o.requiresRac || o.requiresGi).length,
    },
  });
});

// ─── POST /api/admin/smoke-tests/preview — dry-run a specific op ─────────────
// Returns the exact command that WOULD execute — no Oracle/SSH connection needed.

router.post('/preview', requireAdmin, (req, res) => {
  const { op_key, params } = req.body || {};
  if (!op_key) return res.status(400).json({ error: 'op_key required' });

  const catalog = getOpCatalog();
  const op = catalog.find(o => o.key === op_key);
  if (!op) return res.status(404).json({ error: `Unknown op_key: ${op_key}` });

  // Render any template placeholders with provided params (or show them as markers)
  let preview = op.commandPreview || '[No command preview available]';
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      preview = preview.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v || `[${k}]`);
    }
  }

  res.json({
    op_key,
    label: op.label,
    category: op.category,
    type: op.type,
    destructive: op.destructive,
    requires: {
      ebs: op.requiresEbs || false,
      asm: op.requiresAsm || false,
      rac: op.requiresRac || false,
      gi: op.requiresGi || false,
    },
    command_preview: preview,
    preview_note: op.type === 'sql'
      ? 'SQL — executed via Oracle Net (direct TCP connection required)'
      : 'SSH — executed via ssh-executor whitelist on the target server',
    is_dry_run: true,
  });
});

// ─── Internal: EBS Ops catalog (static) ──────────────────────────────────────

function getEbsOpsCatalog() {
  // Derived from routes/ebs-middleware.js and services/ebs-ssh-checks.js
  // These are the EBS-specific SSH operations beyond the db-ops executor catalog.
  return [
    { suite: 'ebs-ops', key: 'ebs.wls.status',         label: 'WebLogic AdminServer Status',   category: 'wls' },
    { suite: 'ebs-ops', key: 'ebs.wls.start',           label: 'Start WebLogic AdminServer',    category: 'wls' },
    { suite: 'ebs-ops', key: 'ebs.wls.stop',            label: 'Stop WebLogic AdminServer',     category: 'wls' },
    { suite: 'ebs-ops', key: 'ebs.apache.status',       label: 'Apache/OHS Status',             category: 'apache' },
    { suite: 'ebs-ops', key: 'ebs.apache.start',        label: 'Start Apache/OHS',              category: 'apache' },
    { suite: 'ebs-ops', key: 'ebs.apache.stop',         label: 'Stop Apache/OHS',               category: 'apache' },
    { suite: 'ebs-ops', key: 'ebs.apache.restart',      label: 'Restart Apache/OHS',            category: 'apache' },
    { suite: 'ebs-ops', key: 'ebs.appslistener.status', label: 'Apps Listener Status',          category: 'apps_listener' },
    { suite: 'ebs-ops', key: 'ebs.appslistener.start',  label: 'Start Apps Listener',           category: 'apps_listener' },
    { suite: 'ebs-ops', key: 'ebs.appslistener.stop',   label: 'Stop Apps Listener',            category: 'apps_listener' },
    { suite: 'ebs-ops', key: 'ebs.rolling.bounce',      label: 'Rolling Bounce (all nodes)',    category: 'managed_servers' },
    { suite: 'ebs-ops', key: 'ebs.concurrent.running',  label: 'Running Concurrent Requests',   category: 'ebs_concurrent' },
    { suite: 'ebs-ops', key: 'ebs.concurrent.pending',  label: 'Pending Concurrent Requests',   category: 'ebs_concurrent' },
    { suite: 'ebs-ops', key: 'ebs.nodes.start',         label: 'Start All EBS Nodes',           category: 'node_control' },
    { suite: 'ebs-ops', key: 'ebs.nodes.stop',          label: 'Stop All EBS Nodes',            category: 'node_control' },
    { suite: 'ebs-ops', key: 'ebs.adop.status',         label: 'ADOP Session Status',           category: 'patching' },
    { suite: 'ebs-ops', key: 'ebs.adop.phase',          label: 'ADOP Phase Progress',           category: 'patching' },
    { suite: 'ebs-ops', key: 'ebs.cm.status',           label: 'CM Status (Workflow)',          category: 'concurrent_mgr' },
    { suite: 'ebs-ops', key: 'ebs.wfmailer.status',     label: 'WF Mailer Status',              category: 'workflow' },
    { suite: 'ebs-ops', key: 'ebs.fs.space',            label: 'Filesystem Space Check',        category: 'filesystem' },
  ];
}

// ─── Internal: Clone wizard step catalog ─────────────────────────────────────

function getCloneCatalog() {
  return [
    // EBS Clone wizard
    { suite: 'clone', key: 'ebs.clone.pre-checks',   label: 'EBS Pre-Clone Checks',        wizard: 'ebs-clone', step: 1 },
    { suite: 'clone', key: 'ebs.clone.rman-backup',  label: 'RMAN Database Backup',        wizard: 'ebs-clone', step: 2 },
    { suite: 'clone', key: 'ebs.clone.apps-tier',    label: 'Apps Tier Clone',             wizard: 'ebs-clone', step: 3 },
    { suite: 'clone', key: 'ebs.clone.post-steps',   label: 'Post-Clone Steps',            wizard: 'ebs-clone', step: 4 },
    { suite: 'clone', key: 'ebs.clone.validation',   label: 'Clone Validation',            wizard: 'ebs-clone', step: 5 },
    // DB Clone wizard
    { suite: 'clone', key: 'db.clone.pre-flight',    label: 'DB Pre-Flight Checks',        wizard: 'db-clone', step: 1 },
    { suite: 'clone', key: 'db.clone.rman-exec',     label: 'RMAN Execution',              wizard: 'db-clone', step: 2 },
    { suite: 'clone', key: 'db.clone.datapump',      label: 'Data Pump Export/Import',     wizard: 'db-clone', step: 3 },
    { suite: 'clone', key: 'db.clone.post-clone',    label: 'Post-Clone Customization',    wizard: 'db-clone', step: 4 },
    { suite: 'clone', key: 'db.clone.recipe-save',   label: 'Recipe Save',                 wizard: 'db-clone', step: 5 },
  ];
}

// ─── Internal: UI surfaces catalog ───────────────────────────────────────────

function getUiSurfaces() {
  return [
    { suite: 'ui', key: 'page.dashboard',     label: 'Dashboard', path: '/dashboard',       hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.db-ops',        label: 'DB Ops',    path: '/db-ops',           hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.ebs-clone',     label: 'EBS Clone', path: '/ebs-clone',        hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.db-clone',      label: 'DB Clone',  path: '/db-clone',         hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.sql-console',   label: 'SQL Console', path: '/sql-console',    hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.terminal',      label: 'SSH Terminal', path: '/terminal',      hasConnectionDropdown: false },
    { suite: 'ui', key: 'page.patches',       label: 'Patches',   path: '/patches',          hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.ebs-middleware',label: 'EBS Middleware', path: '/ebs-middleware', hasConnectionDropdown: true },
    { suite: 'ui', key: 'page.ebs-concurrent',label: 'EBS Concurrent', path: '/ebs-concurrent', hasConnectionDropdown: true },
  ];
}

module.exports = router;
