/**
 * routes/console.js — SQL Console + Terminal pages and SQL execution API.
 *
 * Owns: /sql-console page, /terminal page, /api/sql-console/* endpoints:
 *   POST /api/sql-console/run       — execute arbitrary SQL
 *   POST /api/sql-console/explain   — explain plan for a SQL statement
 *   GET  /api/sql-console/history   — server-side query history per user+connection
 *   GET  /api/sql-console/audit     — admin audit export per connection (CSV-ready)
 *   POST /api/sql-console/export    — export result set as CSV
 * Does NOT own: SSH execution (routes/ssh-targets.js), DB Ops catalog
 *               (routes/db-ops.js), Oracle connection storage (server.js pool).
 *
 * SQL console accepts arbitrary SQL from authenticated users (senior_dba+)
 * and executes it against the user's own Oracle connection. Results are
 * returned as rows + columns for tabular display. DDL/DML returns rowsAffected.
 *
 * Security: user must own the connection (user_id match). Every execution
 * is logged to sql_console_history AND activity_log for full audit trail.
 */

'use strict';

const express = require('express');
const pathM   = require('path');

const pool    = require('../db/index');
const { decrypt } = require('../crypto-utils');
const { requireAuth, requireRole, requireAdmin, requireConnectionOwner } = require('../middleware/auth');
const { insertHistory, getHistory, getAuditHistory } = require('../db/sql-console-history');

const router = express.Router();

// ─── Read-only enforcement: block DDL/DML keywords ────────────────────────────
// Returns null if clean, or an error message string if blocked.
function blockNonSelect(sql) {
  // Strip leading comment lines and whitespace to find the first statement keyword
  const clean = sql
    .replace(/\/\/[^\n\r]*/g, '')   // C++ style inline comments
    .replace(/--[^\n\r]*/g, '')     // SQL single-line comments
    .trimStart();

  // Block DDL/DML keywords at the start of the statement.
  // Covers: INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, MERGE, GRANT, REVOKE
  const BLOCKED = /^\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|GRANT|REVOKE)\b/i;
  if (BLOCKED.test(clean)) {
    const matched = clean.match(BLOCKED)[0];
    return `Write operations (${matched}) are not allowed in SQL Console. This is a read-only query tool.`;
  }
  return null;
}

// ─── Helper: load + decrypt oracle connection (user-scoped) ──────────────────

async function getConnParams(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc, name,
            connectivity_mode, ssh_db_host, ssh_db_user, ssh_db_key_enc,
            ssh_oracle_home, ssh_oracle_sid
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  if (!rows.length) return null;
  const conn = rows[0];
  return {
    id: conn.id,
    host: conn.host,
    port: conn.port || 1521,
    serviceName: conn.service_name,
    username: conn.username,
    password: conn.encrypted_password ? decrypt(conn.encrypted_password) : null,
    connectionType: conn.connection_type,
    proxyUrl: conn.proxy_url,
    proxyApiKeyEnc: conn.proxy_api_key_enc,
    name: conn.name,
    connectivityMode: conn.connectivity_mode || 'tns',
    sshDbHost: conn.ssh_db_host,
    sshDbUser: conn.ssh_db_user,
    sshDbKeyEnc: conn.ssh_db_key_enc,
    sshOracleHome: conn.ssh_oracle_home,
    sshOracleSid: conn.ssh_oracle_sid,
  };
}

// ─── Oracle client helper (direct TCP via thin oracledb) ─────────────────────

let _oracledb = null;
function getOracledb() {
  if (!_oracledb) {
    try { _oracledb = require('oracledb'); } catch (_) { return null; }
  }
  return _oracledb;
}

async function withOracleConnection(connParams, fn, timeoutMs = 30000) {
  const oracledb = getOracledb();
  if (!oracledb) throw new Error('Oracle client not available on this server');
  const connectString = `${connParams.host}:${connParams.port}/${connParams.serviceName}`;
  const conn = await oracledb.getConnection({
    user: connParams.username,
    password: connParams.password,
    connectString,
    connectTimeout: 20,
  });
  try {
    return await fn(conn, oracledb);
  } finally {
    try { await conn.close(); } catch (_) {}
  }
}

// ─── Proxy call helper ───────────────────────────────────────────────────────

function callProxy(proxyBase, apiKey, body, timeoutMs = 35000) {
  const https = require('https');
  const http  = require('http');
  return new Promise((resolve, reject) => {
    const endpoint = `${proxyBase.replace(/\/+$/, '')}/api/execute-sql`;
    let parsed;
    try { parsed = new URL(endpoint); } catch (e) { return reject(e); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length':  bodyBuf.length,
        'X-Api-Key':      apiKey,
      },
      rejectUnauthorized: false,
    };
    const req = lib.request(options, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('Proxy returned invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Proxy request timed out')); });
    req.write(bodyBuf);
    req.end();
  });
}

// ─── SQL column name extractor (for SSH raw mode) ──────────────────────────
// Parses column aliases out of a SELECT list for raw array display.

function parseSqlColumns(sql) {
  const sqlUpper = sql.trim().toUpperCase();
  if (!sqlUpper.startsWith('SELECT') || sqlUpper.startsWith('SELECT INTO')) return null;
  // Strip leading SELECT keyword, find FROM or analytic clauses
  const afterSelect = sqlUpper.slice(6).trim();
  let end;
  // Find the outermost FROM (not inside parens)
  let depth = 0, inStr = false, strChar;
  for (let i = 0; i < afterSelect.length; i++) {
    const c = afterSelect[i];
    if (!inStr && (c === '"' || c === "'")) { inStr = true; strChar = c; }
    else if (inStr && c === strChar) { inStr = false; }
    else if (!inStr) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) break;
      else if (c === ' ' && depth === 0) {
        const rest = afterSelect.slice(i).trimStart();
        if (rest.startsWith('FROM') || rest.startsWith('WHERE') ||
            rest.startsWith('GROUP') || rest.startsWith('ORDER') ||
            rest.startsWith('HAVING') || rest.startsWith('LIMIT') ||
            rest.startsWith('FETCH')  || rest.startsWith('OFFSET')) {
          end = i; break;
        }
      }
    }
  }
  if (end === undefined) end = afterSelect.length;
  const colStr = afterSelect.slice(0, end);
  // Split on unquoted commas at depth=0
  const aliases = [];
  depth = 0; inStr = false; strChar = null; let token = '';
  for (let i = 0; i <= colStr.length; i++) {
    const c = colStr[i];
    const isEnd = i === colStr.length;
    if (!inStr && !isEnd && (c === '"' || c === "'")) { inStr = true; strChar = c; token += c; }
    else if (inStr && c === strChar) { inStr = false; token += c; }
    else if (!inStr && !isEnd && (c === '(' || c === ')')) { depth += (c === '(' ? 1 : -1); token += c; }
    else if (!inStr && !isEnd && c === ',') {
      aliases.push(token.trim()); token = '';
    } else {
      if (!isEnd) token += c;
    }
  }
  if (token.trim()) aliases.push(token.trim());
  // Strip AS prefix and trailing keywords from each alias
  return aliases.map(a => {
    a = a.trim();
    const upper = a.toUpperCase();
    const asIdx = upper.indexOf(' AS ');
    if (asIdx >= 0) return a.slice(asIdx + 4).trim().replace(/^["']|["']$/g, '');
    // Strip "table.col" prefix
    const dot = a.lastIndexOf('.');
    return (dot >= 0 ? a.slice(dot + 1) : a).trim().replace(/^["']|["']$/g, '');
  });
}

// ─── Unified SQL executor ────────────────────────────────────────────────────
// Routes to SSH sqlplus, direct TCP (oracledb), or proxy depending on
// connection type and connectivity_mode.

async function executeSQL(connParams, sql, maxRows = 500, timeoutMs = 30000) {
  const sqlTrimmed = sql.trim().replace(/;+$/, '');
  const t0 = Date.now();
  const mode = connParams.connectivityMode || 'tns';

  // ── SSH sqlplus path ──────────────────────────────────────────────────────
  if ((mode === 'ssh_sqlplus' || mode === 'both') && connParams.sshDbKeyEnc) {
    const { runViaSsh } = require('../services/oracle-runner');
    try {
      const rawResult = await runViaSsh({
        id:              connParams.id,
        ssh_db_host:     connParams.sshDbHost,
        ssh_db_user:     connParams.sshDbUser,
        ssh_db_key_enc:  connParams.sshDbKeyEnc,
        ssh_oracle_home: connParams.sshOracleHome,
        ssh_oracle_sid:  connParams.sshOracleSid,
        service_name:    connParams.serviceName,
      }, sqlTrimmed);

      const elapsed = Date.now() - t0;
      const rawRows = rawResult.rows || [];
      const cols = parseSqlColumns(sqlTrimmed) || rawRows[0]
        ? rawRows[0].map((_, i) => `COLUMN_${i + 1}`)
        : [];
      const rows = rawRows.map(row =>
        Object.fromEntries(cols.map((col, i) => [col, row[i] ?? null]))
      );
      return { rows, cols, rowCount: rows.length, elapsed_ms: elapsed };
    } catch (sshErr) {
      // If 'both' mode, fall through to TNS/proxy on SSH failure
      if (mode === 'both') {
        console.warn('[sql-console] SSH path failed, falling back to TNS:', sshErr.message);
      } else {
        const elapsed = Date.now() - t0;
        return { error: `SSH error: ${sshErr.message}`, elapsed_ms: elapsed };
      }
    }
  }

  // ── Proxy path ────────────────────────────────────────────────────────────
  if (connParams.connectionType === 'proxy') {
    if (!connParams.proxyUrl || !connParams.proxyApiKeyEnc) {
      throw new Error('Proxy connection lost — check proxy status');
    }
    const apiKey = decrypt(connParams.proxyApiKeyEnc);
    const result = await callProxy(connParams.proxyUrl, apiKey, {
      host:         connParams.host,
      port:         connParams.port,
      service_name: connParams.serviceName,
      username:     connParams.username,
      password:     connParams.password,
      sql:          sqlTrimmed,
    }, timeoutMs);

    const elapsed = Date.now() - t0;
    if (!result.success && result.error) {
      return { error: result.error, elapsed_ms: elapsed };
    }
    return {
      rows: result.rows || [],
      cols: result.columns || [],
      rowCount: result.rows ? result.rows.length : (result.rowsAffected || 0),
      rowsAffected: result.rowsAffected,
      elapsed_ms: elapsed,
    };
  }

  // ── Direct TCP path ───────────────────────────────────────────────────────
  return await withOracleConnection(connParams, async (conn, oracledb) => {
    const r = await conn.execute(sqlTrimmed, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: maxRows,
      maxRows,
      callTimeout: timeoutMs,
    });

    const elapsed = Date.now() - t0;

    if (r.metaData && r.rows !== undefined) {
      const cols = r.metaData.map(c => c.name);
      const rows = (r.rows || []).map(row => {
        const out = {};
        cols.forEach(col => {
          const v = row[col];
          if (v instanceof Date) out[col] = v.toISOString();
          else if (Buffer.isBuffer(v)) out[col] = v.toString('hex');
          else out[col] = v;
        });
        return out;
      });
      return { rows, cols, rowCount: rows.length, elapsed_ms: elapsed };
    }
    return { rowsAffected: r.rowsAffected || 0, elapsed_ms: elapsed };
  }, timeoutMs);
}

// ─── Audit log helper ────────────────────────────────────────────────────────

async function logToActivityLog(userId, userEmail, action, connectionId, detail, req) {
  try {
    await pool.query(
      `INSERT INTO activity_log (user_id, user_email, action_type, connection_id, detail, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, userEmail, action, connectionId, JSON.stringify(detail),
       req.headers['x-forwarded-for'] || req.ip]
    );
  } catch (_) {
    // Non-fatal — don't block the request
  }
}

// ─── GET /connections/:id/sql-console ─────────────────────────────────────────
// Link from connection detail page — pre-selects the connection in the console.

router.get('/connections/:id/sql-console', requireAuth, (req, res) => {
  const connId = parseInt(req.params.id, 10);
  if (!connId || isNaN(connId)) return res.redirect('/sql-console');
  res.redirect(`/sql-console?connection=${connId}`);
});

// ─── GET /sql-console ─────────────────────────────────────────────────────────

router.get('/sql-console', requireAuth, (req, res) => {
  res.sendFile(pathM.join(__dirname, '..', 'public', 'sql-console.html'));
});

// ─── GET /terminal ────────────────────────────────────────────────────────────

router.get('/terminal', requireAuth, (req, res) => {
  res.sendFile(pathM.join(__dirname, '..', 'public', 'terminal.html'));
});

// ─── POST /api/sql-console/run ───────────────────────────────────────────────
// Body: { connection_id, sql, timeout_ms? }
// Returns: { rows, cols, rowCount, elapsed_ms } or { rowsAffected, elapsed_ms }
// senior_dba+ only — requires ownership of the connection.

router.post('/api/sql-console/run', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { connection_id, sql, timeout_ms } = req.body || {};

  if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'sql is required' });
  if (sql.length > 8000) return res.status(400).json({ error: 'SQL too long (max 8000 chars)' });

  const blocked = blockNonSelect(sql);
  if (blocked) return res.status(403).json({ error: blocked });

  const connId = parseInt(connection_id, 10);
  if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection_id' });

  const timeoutVal = Math.min(Math.max(5000, parseInt(timeout_ms, 10) || 30000), 120000);

  let connParams;
  try {
    connParams = await getConnParams(connId, req.user.id);
  } catch (err) {
    console.error('[sql-console] Failed to load connection:', err.message);
    return res.status(500).json({ error: 'Failed to load connection' });
  }

  if (!connParams) {
    return res.status(404).json({ error: 'Connection not found or access denied' });
  }

  try {
    const result = await executeSQL(connParams, sql, 500, timeoutVal);

    if (result.error) {
      // Log failed execution
      insertHistory({
        connection_id: connId, user_id: req.user.id, sql_text: sql,
        elapsed_ms: result.elapsed_ms, success: false, error_message: result.error,
        source_ip: req.headers['x-forwarded-for'] || req.ip,
        user_agent: (req.headers['user-agent'] || '').substring(0, 512),
      }).catch(() => {});

      logToActivityLog(req.user.id, req.user.email, 'sql_console_execute', connId, {
        sql_text: sql.substring(0, 2000), success: false, error: result.error,
        elapsed_ms: result.elapsed_ms,
      }, req);

      return res.status(400).json({ error: result.error });
    }

    const rowCount = result.rows ? result.rows.length : (result.rowsAffected || 0);

    // Log successful execution
    insertHistory({
      connection_id: connId, user_id: req.user.id, sql_text: sql,
      elapsed_ms: result.elapsed_ms, rows_returned: rowCount, success: true,
      source_ip: req.headers['x-forwarded-for'] || req.ip,
      user_agent: (req.headers['user-agent'] || '').substring(0, 512),
    }).catch(() => {});

    logToActivityLog(req.user.id, req.user.email, 'sql_console_execute', connId, {
      sql_text: sql.substring(0, 2000), success: true, rows_returned: rowCount,
      elapsed_ms: result.elapsed_ms,
    }, req);

    res.json(result);
  } catch (err) {
    const message = err.message || String(err);

    insertHistory({
      connection_id: connId, user_id: req.user.id, sql_text: sql,
      success: false, error_message: message.substring(0, 2000),
      source_ip: req.headers['x-forwarded-for'] || req.ip,
      user_agent: (req.headers['user-agent'] || '').substring(0, 512),
    }).catch(() => {});

    logToActivityLog(req.user.id, req.user.email, 'sql_console_execute', connId, {
      sql_text: sql.substring(0, 2000), success: false, error: message.substring(0, 2000),
    }, req);

    res.status(400).json({ error: message });
  }
});

// ─── POST /api/sql-console/explain ───────────────────────────────────────────
// Body: { connection_id, sql }
// Runs EXPLAIN PLAN FOR <sql>, then SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)
// Returns: { plan: string[] } — array of plan output lines

router.post('/api/sql-console/explain', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { connection_id, sql } = req.body || {};

  if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'sql is required' });
  if (sql.length > 8000) return res.status(400).json({ error: 'SQL too long (max 8000 chars)' });

  const connId = parseInt(connection_id, 10);
  if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection_id' });

  let connParams;
  try {
    connParams = await getConnParams(connId, req.user.id);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load connection' });
  }
  if (!connParams) {
    return res.status(404).json({ error: 'Connection not found or access denied' });
  }

  // Explain plan only works on direct TCP or proxy — not SSH
  if (connParams.connectionType === 'proxy') {
    // For proxy connections, we run both statements via proxy
    try {
      const sqlTrimmed = sql.trim().replace(/;+$/, '');

      // Step 1: EXPLAIN PLAN
      const explainResult = await callProxy(
        connParams.proxyUrl,
        decrypt(connParams.proxyApiKeyEnc),
        {
          host: connParams.host,
          port: connParams.port,
          service_name: connParams.serviceName,
          username: connParams.username,
          password: connParams.password,
          sql: `EXPLAIN PLAN FOR ${sqlTrimmed}`,
        },
        15000
      );

      if (!explainResult.success && explainResult.error) {
        return res.status(400).json({ error: explainResult.error });
      }

      // Step 2: Read the plan
      const planResult = await callProxy(
        connParams.proxyUrl,
        decrypt(connParams.proxyApiKeyEnc),
        {
          host: connParams.host,
          port: connParams.port,
          service_name: connParams.serviceName,
          username: connParams.username,
          password: connParams.password,
          sql: `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)`,
        },
        10000
      );

      if (!planResult.success && planResult.error) {
        return res.status(400).json({ error: planResult.error });
      }

      const planLines = (planResult.rows || []).map(row => {
        const vals = Object.values(row);
        return vals.join(' ');
      });

      // Log to audit
      insertHistory({
        connection_id: connId, user_id: req.user.id,
        sql_text: `EXPLAIN PLAN FOR ${sql.substring(0, 4000)}`,
        success: true, rows_returned: planLines.length,
        source_ip: req.headers['x-forwarded-for'] || req.ip,
        user_agent: (req.headers['user-agent'] || '').substring(0, 512),
      }).catch(() => {});

      logToActivityLog(req.user.id, req.user.email, 'sql_console_explain', connId, {
        sql_text: sql.substring(0, 2000),
      }, req);

      return res.json({ plan: planLines });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // Direct TCP path
  try {
    const oracledb = getOracledb();
    if (!oracledb) return res.status(503).json({ error: 'Oracle client not available' });

    const connectString = `${connParams.host}:${connParams.port}/${connParams.serviceName}`;
    const conn = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 20,
    });

    try {
      const sqlTrimmed = sql.trim().replace(/;+$/, '');

      // Step 1: EXPLAIN PLAN FOR ...
      await conn.execute(`EXPLAIN PLAN FOR ${sqlTrimmed}`);

      // Step 2: Retrieve the plan
      const planResult = await conn.execute(
        `SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY)`,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 200 }
      );

      const planLines = (planResult.rows || []).map(r => r.PLAN_TABLE_OUTPUT || '');

      // Log to audit
      insertHistory({
        connection_id: connId, user_id: req.user.id,
        sql_text: `EXPLAIN PLAN FOR ${sql.substring(0, 4000)}`,
        success: true, rows_returned: planLines.length,
        source_ip: req.headers['x-forwarded-for'] || req.ip,
        user_agent: (req.headers['user-agent'] || '').substring(0, 512),
      }).catch(() => {});

      logToActivityLog(req.user.id, req.user.email, 'sql_console_explain', connId, {
        sql_text: sql.substring(0, 2000),
      }, req);

      return res.json({ plan: planLines });
    } finally {
      try { await conn.close(); } catch (_) {}
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ─── GET /api/sql-console/history ────────────────────────────────────────────
// Query: ?connection_id=N&limit=50
// Returns: { entries: [{sql_text, elapsed_ms, rows_returned, success, executed_at}] }

router.get('/api/sql-console/history', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const connectionId = parseInt(req.query.connection_id, 10);
  if (!connectionId) return res.status(400).json({ error: 'connection_id is required' });

  try {
    const entries = await getHistory({
      user_id: req.user.id,
      connection_id: connectionId,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    return res.json({ entries });
  } catch (err) {
    console.error('[sql-console] history fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ─── GET /api/sql-console/audit ──────────────────────────────────────────────
// Admin audit export — returns all executions for a connection with user info.
// Query: ?connection_id=N&from=ISO&to=ISO&format=csv|json
// Admin-only endpoint.

router.get('/api/sql-console/audit', requireAuth, requireAdmin, async (req, res) => {
  const connectionId = parseInt(req.query.connection_id, 10);
  if (!connectionId) return res.status(400).json({ error: 'connection_id is required' });

  try {
    const entries = await getAuditHistory({
      connection_id: connectionId,
      user_id: req.query.user_id ? parseInt(req.query.user_id, 10) : undefined,
      from_date: req.query.from || undefined,
      to_date: req.query.to || undefined,
      limit: parseInt(req.query.limit, 10) || 500,
    });

    if (req.query.format === 'csv') {
      const csvHeader = 'Date,User Email,SQL,Elapsed (ms),Rows,Success,Error,Source IP\n';
      const csvRows = entries.map(e => {
        const sqlEsc = `"${(e.sql_text || '').replace(/"/g, '""')}"`;
        const errEsc = e.error_message ? `"${e.error_message.replace(/"/g, '""')}"` : '';
        return [
          e.executed_at ? new Date(e.executed_at).toISOString() : '',
          e.user_email || '',
          sqlEsc,
          e.elapsed_ms || '',
          e.rows_returned || 0,
          e.success ? 'YES' : 'NO',
          errEsc,
          e.source_ip || '',
        ].join(',');
      }).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sql-audit-${connectionId}.csv"`);
      return res.send(csvHeader + csvRows);
    }

    return res.json({ entries });
  } catch (err) {
    console.error('[sql-console] audit fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit data' });
  }
});

// ─── POST /api/sql-console/export ────────────────────────────────────────────
// Body: { rows, cols, format: 'csv' }
// Generates a CSV download from the result set the client already has.

router.post('/api/sql-console/export', requireAuth, requireRole('senior_dba'), (req, res) => {
  const { rows, cols, format } = req.body || {};
  if (!rows || !cols || !Array.isArray(rows) || !Array.isArray(cols)) {
    return res.status(400).json({ error: 'rows and cols arrays are required' });
  }

  // CSV export
  const escapeCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = cols.map(escapeCsv).join(',');
  const body = rows.map(row =>
    cols.map(col => escapeCsv(row[col])).join(',')
  ).join('\n');

  const csv = header + '\n' + body;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="query-results.csv"');
  return res.send(csv);
});

// ─── POST /api/sql-console/cancel ──────────────────────────────────────────
// Body: { connection_id }
// Marks a running query for cancellation.
// SSH: kills the sqlplus subprocess via SSH signal.
// Proxy: sends cancel via proxy agent signal.
// TNS/direct: terminates the OCI call timeout (best-effort).

router.post('/api/sql-console/cancel', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { connection_id } = req.body || {};
  if (!connection_id) return res.status(400).json({ error: 'connection_id is required' });

  const connId = parseInt(connection_id, 10);
  if (!connId || isNaN(connId)) return res.status(400).json({ error: 'Invalid connection_id' });

  let connParams;
  try {
    connParams = await getConnParams(connId, req.user.id);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load connection' });
  }
  if (!connParams) return res.status(404).json({ error: 'Connection not found' });

  const mode = connParams.connectivityMode || 'tns';

  // SSH cancel: send SIGTERM to sqlplus
  if ((mode === 'ssh_sqlplus' || mode === 'both') && connParams.sshDbKeyEnc) {
    try {
      const { runRawSsh } = require('../services/oracle-runner');
      await runRawSsh({
        id:              connParams.id,
        ssh_db_host:     connParams.sshDbHost,
        ssh_db_user:     connParams.sshDbUser,
        ssh_db_key_enc:  connParams.sshDbKeyEnc,
        ssh_oracle_home: connParams.sshOracleHome,
        ssh_oracle_sid:  connParams.sshOracleSid,
      }, `pkill -TERM -f "sqlplus.*as sysdba" 2>/dev/null || echo "no-sqlplus-found"`, 5000);
      return res.json({ cancelled: true, method: 'ssh_sigterm' });
    } catch (err) {
      return res.json({ cancelled: false, error: err.message, method: 'ssh' });
    }
  }

  // Proxy cancel: POST to proxy cancel endpoint
  if (connParams.connectionType === 'proxy' && connParams.proxyUrl && connParams.proxyApiKeyEnc) {
    try {
      const apiKey = decrypt(connParams.proxyApiKeyEnc);
      const result = await callProxy(
        connParams.proxyUrl, apiKey,
        { host: connParams.host, port: connParams.port, action: 'cancel' },
        5000
      );
      return res.json({ cancelled: true, method: 'proxy' });
    } catch (err) {
      return res.json({ cancelled: false, error: err.message, method: 'proxy' });
    }
  }

  // Direct TCP: Oracle callTimeout is server-side; we can't cancel mid-query
  // Return a note that cancellation is best-effort
  return res.json({ cancelled: true, method: 'direct_tcp_note', note: 'Direct TCP queries use server-side timeout; the driver will abort on next call after the timeout fires' });
});

module.exports = router;
