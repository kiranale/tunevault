/**
 * routes/failure-bundles.js — Debug bundle API endpoints.
 *
 * Owns: GET /api/failure-bundles/:id         — fetch a single bundle (auth required)
 *       GET /api/failure-bundles/:id/markdown — render bundle as copy-ready markdown
 *       GET /api/connections/:connId/failure-bundles/badge  — 24h failure count badge
 *       GET /api/connections/:connId/failure-bundles        — recent bundle list
 *       POST /api/internal/failure-bundle    — proxy-side ingestion (INTERNAL_API_KEY)
 *
 * Does NOT own: bundle capture logic (services/failure-capture.js),
 *               DB persistence (db/failure-bundles.js).
 */

'use strict';

const express = require('express');
const router  = express.Router();

const bundleDb = require('../db/failure-bundles');
const capture  = require('../services/failure-capture');
const { requireAuth } = require('../middleware/auth');

// ── Internal ingestion endpoint (proxy-side errors) ────────────────────────────
// Called by oracle-proxy.py on any cx_Oracle exception.
// Auth: INTERNAL_API_KEY header (not user session).

router.post('/api/internal/failure-bundle', async (req, res) => {
  const key = req.headers['x-internal-key'] || req.headers['authorization'];
  const expected = process.env.INTERNAL_API_KEY;
  // Silently accept if no key configured (dev/test environments)
  if (expected && key !== expected && key !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const {
      check_id, connection_id,
      ora_error_code, ora_error_message,
      python_traceback, proxy_log_tail,
      cx_oracle_version, os_release, oracle_version,
      context_json,
    } = req.body;

    const bundle = await bundleDb.insertBundle({
      checkId:         check_id,
      connectionId:    connection_id || null,
      source:          'proxy',
      oraErrorCode:    ora_error_code,
      oraErrorMessage: ora_error_message,
      pythonTraceback: python_traceback,
      proxyLogTail:    proxy_log_tail,
      cxOracleVersion: cx_oracle_version,
      osRelease:       os_release,
      oracleVersion:   oracle_version,
      contextJson:     context_json,
    });

    res.json({ bundle_id: bundle.id });
  } catch (err) {
    console.error('[failure-bundle] proxy ingestion error:', err.message);
    res.status(500).json({ error: 'Failed to store bundle' });
  }
});

// ── Badge count — 24h failures for a connection ───────────────────────────────

router.get('/api/connections/:connId/failure-bundles/badge', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.connId, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const { count } = await bundleDb.getBadgeCount(connId);
    res.json({ count, connection_id: connId });
  } catch (err) {
    console.error('[failure-bundle] badge error:', err.message);
    res.status(500).json({ error: 'Failed to fetch badge count' });
  }
});

// ── Recent bundle list for a connection ──────────────────────────────────────

router.get('/api/connections/:connId/failure-bundles', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.connId, 10);
  if (!connId) return res.status(400).json({ error: 'Invalid connection id' });

  try {
    const bundles = await bundleDb.getRecentForConnection(connId);
    res.json({ bundles, connection_id: connId });
  } catch (err) {
    console.error('[failure-bundle] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

// ── Fetch single bundle ───────────────────────────────────────────────────────

router.get('/api/failure-bundles/:id', requireAuth, async (req, res) => {
  const bundleId = parseInt(req.params.id, 10);
  if (!bundleId) return res.status(400).json({ error: 'Invalid bundle id' });

  try {
    const bundle = await bundleDb.getBundle(bundleId);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    if (!(await bundleDb.userCanAccessBundle(bundleId, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ bundle });
  } catch (err) {
    console.error('[failure-bundle] fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bundle' });
  }
});

// ── Markdown render ──────────────────────────────────────────────────────────
// Returns the bundle as paste-ready markdown (for issue trackers / chat).

router.get('/api/failure-bundles/:id/markdown', requireAuth, async (req, res) => {
  const bundleId = parseInt(req.params.id, 10);
  if (!bundleId) return res.status(400).json({ error: 'Invalid bundle id' });

  try {
    const bundle = await bundleDb.getBundle(bundleId);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    if (!(await bundleDb.userCanAccessBundle(bundleId, req.user.id))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const md = buildMarkdown(bundle);
    res.json({ markdown: md });
  } catch (err) {
    console.error('[failure-bundle] markdown error:', err.message);
    res.status(500).json({ error: 'Failed to render markdown' });
  }
});

// ── Markdown formatter ────────────────────────────────────────────────────────

function buildMarkdown(b) {
  const lines = [];
  lines.push(`# TuneVault Failure Bundle #${b.id}`);
  lines.push('');

  // Metadata table
  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Bundle ID | ${b.id} |`);
  lines.push(`| Check ID | ${b.check_id || '—'} |`);
  lines.push(`| Source | ${b.source} |`);
  lines.push(`| Connection | ${b.connection_name || b.connection_id || '—'} |`);
  lines.push(`| Captured At | ${b.created_at} |`);
  if (b.ora_error_code) lines.push(`| ORA Error Code | \`${b.ora_error_code}\` |`);
  if (b.agent_version)  lines.push(`| Agent Version | ${b.agent_version} |`);
  if (b.oracle_version) lines.push(`| Oracle Version | ${b.oracle_version} |`);
  if (b.cx_oracle_version) lines.push(`| cx_Oracle Version | ${b.cx_oracle_version} |`);
  if (b.os_release)     lines.push(`| OS Release | ${b.os_release} |`);
  lines.push('');

  if (b.ora_error_message) {
    lines.push('## Oracle Error');
    lines.push('');
    lines.push('```');
    lines.push(b.ora_error_message);
    lines.push('```');
    lines.push('');
  }

  if (b.sql_text) {
    lines.push('## SQL');
    lines.push('');
    lines.push('```sql');
    lines.push(b.sql_text);
    lines.push('```');
    lines.push('');
  }

  if (b.bind_values_redacted_json) {
    lines.push('## Bind Values (redacted)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(b.bind_values_redacted_json, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (b.node_stack) {
    lines.push('## Node.js Stack Trace');
    lines.push('');
    lines.push('```');
    lines.push(b.node_stack);
    lines.push('```');
    lines.push('');
  }

  if (b.python_traceback) {
    lines.push('## Python Traceback');
    lines.push('');
    lines.push('```python');
    lines.push(b.python_traceback);
    lines.push('```');
    lines.push('');
  }

  if (b.proxy_log_tail) {
    lines.push('## Proxy Log Tail (last 200 lines)');
    lines.push('');
    lines.push('```');
    lines.push(b.proxy_log_tail);
    lines.push('```');
    lines.push('');
  }

  if (b.connection_profile_redacted_json) {
    lines.push('## Connection Profile (redacted)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(b.connection_profile_redacted_json, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (b.context_json) {
    lines.push('## Extra Context');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(b.context_json, null, 2));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = router;
