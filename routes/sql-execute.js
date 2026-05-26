/**
 * routes/sql-execute.js — SQL execution via proxy connection.
 *
 * Owns: POST /api/connections/:id/execute-sql
 *       GET  /api/connections/:id/sql-audit (recent audit log for a connection)
 * Does NOT own: direct TCP SQL execution (routes/console.js),
 *               SSH execution (routes/ssh-execute.js),
 *               Oracle connection storage (server.js / db/index.js).
 *
 * Security model:
 *   - requireAuth + requireConnectionOwner: only connection owners can run SQL.
 *   - Command whitelist enforced server-side before forwarding to proxy.
 *   - Every attempt logged to sql_audit_log (allowed and blocked).
 *   - Rate limit: 10 queries/minute per user (prevents runaway loops).
 *
 * Supported for both proxy and direct TCP connections.
 * For proxy connections: forwards to the proxy agent's /api/execute-sql endpoint.
 * For direct TCP connections: executes via oracledb thin client directly.
 */

'use strict';

const express    = require('express');
const https      = require('https');
const http       = require('http');
const rateLimit  = require('express-rate-limit');

const pool               = require('../db/index');
const { decrypt }        = require('../crypto-utils');
const { requireAuth, requireConnectionOwner } = require('../middleware/auth');
const { logSqlExecution, getAuditLog }        = require('../db/sql-audit-log');

const router = express.Router();

// ─── Rate limiter: 10 queries per minute per user ────────────────────────────
// Keyed by user ID (from req.user, set by requireAuth).
// Falls back to IP if user is somehow not attached (belt-and-suspenders).
const sqlRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id ? `user:${req.user.id}` : req.ip,
  // IP fallback is unreachable (requireAuth runs first); suppress v8 IPv6 validation
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Maximum 10 SQL queries per minute per user.',
      retry_after_seconds: 60,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// ─── SQL Command Whitelist ────────────────────────────────────────────────────
// v1 SQL Console: READ-ONLY enforcement per Task #1792484.
// Only SELECT, EXPLAIN (plan), and DESCRIBE are allowed.
// Everything else (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, GRANT, etc.)
// is rejected with a clear inline error message.

function checkWhitelist(sql) {
  const normalized = sql.trim().toUpperCase();

  // Strip leading comments (-- line comments and /* block comments */)
  const stripped = normalized
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ── Explicitly blocked patterns ──────────────────────────────────────────
  const BLOCKED_PATTERNS = [
    { pattern: /^DROP\b/,               rule: 'DROP',               msg: 'DROP is not permitted.' },
    { pattern: /^DELETE\b/,             rule: 'DELETE',             msg: 'DELETE is not permitted.' },
    { pattern: /^TRUNCATE\b/,           rule: 'TRUNCATE',           msg: 'TRUNCATE is not permitted.' },
    { pattern: /^CREATE\s+USER\b/,      rule: 'CREATE USER',        msg: 'CREATE USER is not permitted.' },
    { pattern: /\bGRANT\s+DBA\b/,       rule: 'GRANT DBA',          msg: 'GRANT DBA is not permitted.' },
    { pattern: /^SHUTDOWN\b/,           rule: 'SHUTDOWN',           msg: 'SHUTDOWN is not permitted through the browser console.' },
    { pattern: /^CREATE\s+DATABASE\s+LINK\b/, rule: 'CREATE DATABASE LINK', msg: 'CREATE DATABASE LINK is not permitted (security risk).' },
    // Anonymous PL/SQL blocks (DECLARE..BEGIN or bare BEGIN..END without an object type)
    { pattern: /^DECLARE\b/,            rule: 'ANONYMOUS PLSQL',    msg: 'Anonymous PL/SQL blocks are not permitted (Phase 2).' },
    { pattern: /^BEGIN\b/,              rule: 'ANONYMOUS PLSQL',    msg: 'Anonymous PL/SQL blocks are not permitted (Phase 2).' },
  ];

  for (const { pattern, rule, msg } of BLOCKED_PATTERNS) {
    if (pattern.test(stripped)) {
      return {
        allowed: false,
        rule,
        message: `Command blocked by security policy. ${msg} Use SQLPlus directly for destructive operations.`,
      };
    }
  }

  // ── Explicitly allowed command prefixes ──────────────────────────────────
  const ALLOWED_PREFIXES = [
    /^SELECT/i,
    /^EXPLAIN/i,
    /^DESCRIBE/i,
    /^DESC/i,
  ];

  for (const pattern of ALLOWED_PREFIXES) {
    if (pattern.test(stripped)) {
      return { allowed: true };
    }
  }

  // Anything else — reject with a helpful message naming what the user tried
  const firstWord = stripped.split(/\s+/)[0] || 'UNKNOWN';
  return {
    allowed: false,
    rule: firstWord,
    message: `Command blocked by security policy. "${firstWord}" is not on the allowed command list. Allowed: SELECT, ALTER SYSTEM, ALTER TABLESPACE, ALTER USER, ALTER DATABASE, SHOW.`,
  };
}

// ─── Load oracle connection with proxy credentials ────────────────────────────

async function getConnectionRow(connectionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc, name
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connectionId, userId]
  );
  return rows[0] || null;
}

// ─── Proxy call helper ────────────────────────────────────────────────────────
// Sends POST JSON to the oracle-proxy /api/execute-sql endpoint.
// Returns parsed JSON body or throws on network/timeout error.

function callProxyExecuteSql(proxyBase, apiKey, body, timeoutMs = 35000) {
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
        'Content-Length': bodyBuf.length,
        'X-Api-Key':      apiKey,
      },
      rejectUnauthorized: false, // proxy may use self-signed cert
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Proxy request timed out after 35s')); });
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Direct Oracle execution (non-proxy connections) ─────────────────────────

let _oracledb = null;
function getOracledb() {
  if (!_oracledb) {
    try { _oracledb = require('oracledb'); } catch (_) { return null; }
  }
  return _oracledb;
}

async function executeDirectSql(connRow, sql) {
  const oracledb = getOracledb();
  if (!oracledb) {
    throw new Error('Oracle client not available on this server');
  }

  const password = decrypt(connRow.encrypted_password);
  const connectString = `${connRow.host}:${connRow.port || 1521}/${connRow.service_name}`;

  let connection;
  const t0 = Date.now();
  try {
    connection = await oracledb.getConnection({
      user: connRow.username,
      password,
      connectString,
      connectTimeout: 20,
    });

    const sqlTrimmed = sql.trim().replace(/;+$/, '');
    const result = await connection.execute(sqlTrimmed, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: 500,
      maxRows: 500,
      callTimeout: 30000,
    });

    const duration_ms = Date.now() - t0;

    if (result.metaData && result.rows !== undefined) {
      const columns = result.metaData.map(c => c.name);
      const rows = (result.rows || []).map(row => {
        const out = {};
        columns.forEach(col => {
          const v = row[col];
          if (v instanceof Date) out[col] = v.toISOString();
          else if (Buffer.isBuffer(v)) out[col] = v.toString('hex');
          else out[col] = v;
        });
        return out;
      });
      return { success: true, columns, rows, duration_ms };
    } else {
      return { success: true, rowsAffected: result.rowsAffected || 0, duration_ms };
    }
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

// ─── POST /api/connections/:id/execute-sql ────────────────────────────────────
// Body: { sql: string }
// Returns:
//   SELECT → { columns: string[], rows: object[], duration_ms: number }
//   DML    → { rowsAffected: number, duration_ms: number }
//   Error  → 403 (blocked), 400 (ORA- error), 502 (proxy error), 503 (no Oracle client)

router.post('/api/connections/:id/execute-sql',
  requireAuth,
  requireConnectionOwner,
  sqlRateLimiter,
  async (req, res) => {
    const connectionId = parseInt(req.params.id, 10);
    const { sql } = req.body || {};

    if (!sql || !sql.trim()) {
      return res.status(400).json({ error: 'sql is required' });
    }
    if (sql.length > 8000) {
      return res.status(400).json({ error: 'SQL too long (max 8000 chars)' });
    }

    // ── 1. Whitelist check ────────────────────────────────────────────────────
    const wl = checkWhitelist(sql);

    if (!wl.allowed) {
      // Log the blocked attempt (fire-and-forget — don't let logging failure block the response)
      logSqlExecution({
        user_id:       req.user.id,
        user_email:    req.user.email,
        connection_id: connectionId,
        sql_text:      sql,
        allowed:       false,
        block_reason:  wl.rule,
      }).catch(() => {});

      return res.status(403).json({ error: wl.message, blocked_rule: wl.rule });
    }

    // ── 2. Load connection ────────────────────────────────────────────────────
    let connRow;
    try {
      connRow = await getConnectionRow(connectionId, req.user.id);
    } catch (err) {
      console.error('[sql-execute] DB error loading connection:', err.message);
      return res.status(500).json({ error: 'Failed to load connection' });
    }

    if (!connRow) {
      return res.status(404).json({ error: 'Connection not found or access denied' });
    }

    // ── 3. Execute (proxy or direct) ──────────────────────────────────────────
    let execResult;
    try {
      if (connRow.connection_type === 'proxy') {
        // Proxy path
        if (!connRow.proxy_url || !connRow.proxy_api_key_enc) {
          return res.status(502).json({
            error: `Connection to ${connRow.name || 'this connection'} lost. Check proxy status.`,
          });
        }

        const apiKey = decrypt(connRow.proxy_api_key_enc);

        execResult = await callProxyExecuteSql(connRow.proxy_url, apiKey, {
          host:         connRow.host,
          port:         connRow.port || 1521,
          service_name: connRow.service_name,
          username:     connRow.username,
          password:     decrypt(connRow.encrypted_password),
          sql,
        });

        // Proxy returns { success, ... } but HTTP 200 even on Oracle errors
        if (!execResult.success) {
          logSqlExecution({
            user_id:        req.user.id,
            user_email:     req.user.email,
            connection_id:  connectionId,
            connection_name: connRow.name,
            sql_text:       sql,
            allowed:        true,
            success:        false,
            error_message:  execResult.error,
            duration_ms:    execResult.duration_ms,
          }).catch(() => {});

          return res.status(400).json({ error: execResult.error });
        }
      } else {
        // Direct TCP path
        execResult = await executeDirectSql(connRow, sql);

        if (!execResult.success) {
          logSqlExecution({
            user_id:        req.user.id,
            user_email:     req.user.email,
            connection_id:  connectionId,
            connection_name: connRow.name,
            sql_text:       sql,
            allowed:        true,
            success:        false,
            error_message:  execResult.error,
            duration_ms:    execResult.duration_ms,
          }).catch(() => {});

          return res.status(400).json({ error: execResult.error });
        }
      }
    } catch (err) {
      // Network / timeout / client errors
      const isProxyErr = connRow.connection_type === 'proxy';
      const friendlyMsg = isProxyErr
        ? `Connection to ${connRow.name || 'proxy'} lost. Check proxy status.`
        : err.message;

      logSqlExecution({
        user_id:        req.user.id,
        user_email:     req.user.email,
        connection_id:  connectionId,
        connection_name: connRow.name,
        sql_text:       sql,
        allowed:        true,
        success:        false,
        error_message:  err.message,
      }).catch(() => {});

      const status = isProxyErr ? 502 : 400;
      return res.status(status).json({ error: friendlyMsg });
    }

    // ── 4. Log success + return result ────────────────────────────────────────
    const rowCount = execResult.rows ? execResult.rows.length : (execResult.rowsAffected || 0);

    logSqlExecution({
      user_id:        req.user.id,
      user_email:     req.user.email,
      connection_id:  connectionId,
      connection_name: connRow.name,
      sql_text:       sql,
      allowed:        true,
      success:        true,
      row_count:      rowCount,
      duration_ms:    execResult.duration_ms,
    }).catch(() => {});

    return res.json(execResult);
  }
);

// ─── GET /api/connections/:id/sql-audit ───────────────────────────────────────
// Returns the last 100 SQL audit entries for this connection.
// Only the connection owner can read their own audit log.

router.get('/api/connections/:id/sql-audit',
  requireAuth,
  requireConnectionOwner,
  async (req, res) => {
    const connectionId = parseInt(req.params.id, 10);
    try {
      const rows = await getAuditLog({ connection_id: connectionId, limit: 100 });
      return res.json({ entries: rows });
    } catch (err) {
      console.error('[sql-execute] audit log fetch error:', err.message);
      return res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  }
);

module.exports = router;
