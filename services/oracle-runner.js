/**
 * services/oracle-runner.js — Unified Oracle query executor.
 *
 * Owns: routing a SQL query to the correct execution path based on
 *       connection.connectivity_mode: TNS (cx_Oracle via proxy agent),
 *       SSH sqlplus (pipe SQL to sqlplus -s / as sysdba over SSH),
 *       or both (TNS preferred, SSH fallback).
 * Does NOT own: connection CRUD, health check orchestration, SSH credential
 *               storage (those remain in db/agent.js and crypto-utils.js).
 *
 * SSH connections are pooled per connection_id with:
 *   - 5-minute idle eviction (stale connections trimmed by background interval)
 *   - LRU cap of MAX_SSH_POOL_SIZE (default 50, env: TUNEVAULT_SSH_POOL_MAX)
 *     — when cap is hit the least-recently-used entry is closed and evicted
 *       before the new entry is inserted. Both eviction paths call client.end()
 *       to avoid leaking file descriptors.
 *
 * Security: SSH private key is decrypted in-memory only, never written to disk.
 * sqlplus output is column-separated using a controlled separator.
 */

'use strict';

const { Client } = require('ssh2');
const { decrypt } = require('../crypto-utils');

// ── SSH connection pool ───────────────────────────────────────────────────────
// Map<connectionId, { client, lastUsedAt, ready }>
// Iteration order of Map is insertion order; we keep it as MRU-to-front by
// delete-then-re-set on every access, so the first entry is always the LRU.
const _pool = new Map();
const POOL_IDLE_MS = 5 * 60 * 1000; // 5 min

// Cap — overridable via env for integration tests or oversized fleets.
const MAX_SSH_POOL_SIZE = (() => {
  const v = parseInt(process.env.TUNEVAULT_SSH_POOL_MAX, 10);
  return Number.isFinite(v) && v > 0 ? v : 50;
})();

// Lifetime eviction counters (monotonically increasing, never reset).
let _totalEvictionsLru  = 0;
let _totalEvictionsIdle = 0;

/**
 * Promote an existing pool entry to most-recently-used.
 * Map preserves insertion order; delete + re-set moves the key to the end,
 * making the remaining first entry the least-recently-used.
 */
function _touch(id, entry) {
  _pool.delete(id);
  entry.lastUsedAt = Date.now();
  _pool.set(id, entry);
}

/**
 * Cleanly close and remove the LRU pool entry when the pool is full.
 * Logs the eviction with structured fields for observability.
 */
function _evictLru() {
  // First entry in iteration order = oldest (LRU)
  const [lruId, lruEntry] = _pool.entries().next().value;
  const ageMsNow = Date.now() - lruEntry.lastUsedAt;
  try { lruEntry.client.end(); } catch (_) { /* ignore — already closed */ }
  _pool.delete(lruId);
  _totalEvictionsLru++;
  console.log(JSON.stringify({
    level: 'info',
    msg: 'ssh_pool_lru_evict',
    connection_id: lruId,
    age_ms: ageMsNow,
    reason: 'lru_evict',
    pool_size_after: _pool.size,
  }));
}

// Reap idle connections every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pool.entries()) {
    if (now - entry.lastUsedAt > POOL_IDLE_MS) {
      try { entry.client.end(); } catch (_) { /* ignore */ }
      _pool.delete(id);
      _totalEvictionsIdle++;
    }
  }
}, 2 * 60 * 1000).unref();

// ── Column separator for sqlplus output parsing ───────────────────────────────
// Use a rare character sequence unlikely to appear in Oracle data.
const COL_SEP = '||TVOUT||';

/**
 * Get (or create) a pooled SSH client for the given connection record.
 * Returns a connected ssh2 Client ready for exec calls.
 *
 * @param {object} conn - oracle_connections row with ssh_* fields populated
 * @param {string} conn.id
 * @param {string} conn.ssh_db_host
 * @param {string} conn.ssh_db_user
 * @param {string} conn.ssh_db_key_enc  - AES-GCM encrypted private key
 */
async function getSshClient(conn) {
  const existing = _pool.get(conn.id);
  if (existing && existing.ready) {
    // Promote to MRU position so it isn't the next LRU candidate.
    _touch(conn.id, existing);
    return existing.client;
  }

  // Evict the LRU entry before inserting a new one when at capacity.
  if (_pool.size >= MAX_SSH_POOL_SIZE) {
    _evictLru();
  }

  // Decrypt key in memory
  const privateKey = decrypt(conn.ssh_db_key_enc);

  return new Promise((resolve, reject) => {
    const client = new Client();

    client.on('ready', () => {
      _pool.set(conn.id, { client, lastUsedAt: Date.now(), ready: true });
      resolve(client);
    });

    client.on('error', (err) => {
      _pool.delete(conn.id);
      reject(new Error(`SSH connect error: ${err.message}`));
    });

    client.on('close', () => {
      _pool.delete(conn.id);
    });

    client.connect({
      host: conn.ssh_db_host,
      port: 22,
      username: conn.ssh_db_user,
      privateKey,
      readyTimeout: 15000,
      // Never show prompts — fail fast if key auth is rejected
      tryKeyboard: false,
    });
  });
}

/**
 * Execute a single SSH command and return { stdout, stderr, exitCode }.
 * Timeout defaults to 30s.
 */
async function execSsh(client, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timer;

    client.exec(command, (err, stream) => {
      if (err) return reject(new Error(`SSH exec error: ${err.message}`));

      timer = setTimeout(() => {
        stream.destroy();
        reject(new Error('SSH exec timed out'));
      }, timeoutMs);

      stream.on('data', (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      });
    });
  });
}

/**
 * Build a sqlplus command that runs a single SQL statement and emits
 * column-separated output parseable by parseSqlplusOutput().
 *
 * @param {string} oracleHome - e.g. /u01/app/oracle/product/19.0.0/db_1
 * @param {string} oracleSid  - e.g. EBSDB
 * @param {string} sql        - SQL statement (no trailing semicolon needed)
 * @returns {string} shell command string
 */
function buildSqlplusCommand(oracleHome, oracleSid, sql) {
  // Sanitize oracleHome and oracleSid — must only contain safe path characters
  const safeHome = oracleHome.replace(/[^a-zA-Z0-9/_.-]/g, '');
  const safeSid  = oracleSid.replace(/[^a-zA-Z0-9_.-]/g, '');

  // sqlplus script heredoc — sets formatting options then runs the SQL
  const script = [
    `SET PAGESIZE 1000`,
    `SET LINESIZE 32767`,
    `SET FEEDBACK OFF`,
    `SET HEADING OFF`,
    `SET TRIMOUT ON`,
    `SET TRIMSPOOL ON`,
    `COLUMN COLSEP NEW_VALUE COLSEP_VAL`,
    `SET COLSEP '${COL_SEP}'`,
    `${sql.trimEnd().replace(/;?\s*$/, '')};`,
    `EXIT;`,
  ].join('\n');

  // Pipe heredoc into sqlplus running as sysdba against the local SID
  return [
    `export ORACLE_HOME='${safeHome}'`,
    `export ORACLE_SID='${safeSid}'`,
    `export PATH="$ORACLE_HOME/bin:$PATH"`,
    `export LD_LIBRARY_PATH="$ORACLE_HOME/lib:$LD_LIBRARY_PATH"`,
    `sqlplus -s / as sysdba <<'SQLEOF'\n${script}\nSQLEOF`,
  ].join(' && ');
}

/**
 * Parse sqlplus colsep output into an array of row-arrays.
 * Handles trimming and skips blank lines / error lines (ORA-, SP2-).
 *
 * @param {string} raw - raw stdout from sqlplus
 * @returns {string[][]} rows — each row is an array of column values
 */
function parseSqlplusOutput(raw) {
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip ORA-/SP2- error lines
    if (/^(ORA-|SP2-|ERROR )/.test(trimmed)) continue;
    // Split on the column separator
    const cols = trimmed.split(COL_SEP).map(c => c.trim());
    rows.push(cols);
  }
  return rows;
}

/**
 * Run a SQL query via SSH sqlplus and return rows as arrays of strings.
 *
 * @param {object} conn - oracle_connections row
 * @param {string} sql
 * @returns {Promise<{rows: string[][]}>}
 */
async function runViaSsh(conn, sql) {
  if (!conn.ssh_db_host || !conn.ssh_db_user || !conn.ssh_db_key_enc) {
    throw new Error('SSH connectivity not configured for this connection');
  }

  const oracleHome = conn.ssh_oracle_home || '/u01/app/oracle/product/19.0.0/db_1';
  const oracleSid  = conn.ssh_oracle_sid  || conn.service_name || '';

  if (!oracleSid) {
    throw new Error('Oracle SID not configured for SSH mode — set ssh_oracle_sid on the connection');
  }

  const client  = await getSshClient(conn);
  const command = buildSqlplusCommand(oracleHome, oracleSid, sql);
  const { stdout, stderr, exitCode } = await execSsh(client, command);

  if (exitCode !== 0 && !stdout) {
    throw new Error(`sqlplus exited ${exitCode}: ${stderr || 'no output'}`);
  }

  // Check for ORA- errors in stdout (sqlplus exits 0 even on SQL errors)
  const firstError = stdout.split('\n').find(l => /^ORA-/.test(l.trim()));
  if (firstError) {
    throw new Error(`Oracle error: ${firstError.trim()}`);
  }

  return { rows: parseSqlplusOutput(stdout) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a SQL query against an oracle_connections record.
 *
 * Routing:
 *   tns         → throws (TNS queries are handled by oracle-client.js / proxy agent)
 *   ssh_sqlplus → SSH + sqlplus path
 *   both        → SSH + sqlplus (the TNS path is used by the proxy agent separately)
 *
 * Returns { rows } where rows is string[][].
 *
 * NOTE: TNS mode is intentionally left to the existing oracle-client.js /
 * proxy agent pipeline. This service owns only the SSH execution path.
 * Callers that need TNS should continue using oracle-client.js directly.
 * The 'both' mode is wired here for the fallback scenario — the caller
 * should try TNS first and then call runQuery() when TNS fails.
 */
async function runQuery(conn, sql) {
  const mode = conn.connectivity_mode || 'tns';

  if (mode === 'tns') {
    throw new Error(
      'runQuery() called for a TNS-only connection — use oracle-client.js instead'
    );
  }

  // ssh_sqlplus or both: use SSH sqlplus path
  return runViaSsh(conn, sql);
}

/**
 * Test SSH connectivity for a connection record.
 * Returns { success, message, sqlplusVersion? }
 */
async function testSshConnectivity(conn) {
  try {
    const client = await getSshClient(conn);
    const oracleHome = conn.ssh_oracle_home || '/u01/app/oracle/product/19.0.0/db_1';
    const safeHome   = oracleHome.replace(/[^a-zA-Z0-9/_.-]/g, '');

    const { stdout } = await execSsh(
      client,
      `echo ok && export ORACLE_HOME='${safeHome}' && $ORACLE_HOME/bin/sqlplus -V 2>&1 | head -1`,
      10000
    );

    if (!stdout.startsWith('ok')) {
      return { success: false, message: 'SSH command did not echo expected output' };
    }

    const versionLine = stdout.split('\n').find(l => /SQL\*Plus/i.test(l));
    return {
      success: true,
      message: 'SSH connection established and sqlplus found',
      sqlplusVersion: versionLine || null,
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Evict a pooled SSH connection (e.g. after credential update).
 */
function evictSshPool(connectionId) {
  const entry = _pool.get(connectionId);
  if (entry) {
    try { entry.client.end(); } catch (_) { /* ignore */ }
    _pool.delete(connectionId);
  }
}

/**
 * Run an arbitrary shell command over SSH for a connection record.
 * Returns { stdout, stderr, exitCode }.
 * Timeout defaults to 30s.
 *
 * Callers are responsible for command safety — only use with allowlisted commands.
 */
async function runRawSsh(conn, command, timeoutMs = 30000) {
  if (!conn.ssh_db_host || !conn.ssh_db_user || !conn.ssh_db_key_enc) {
    throw new Error('SSH connectivity not configured for this connection');
  }
  const client = await getSshClient(conn);
  return execSsh(client, command, timeoutMs);
}

/**
 * Return live pool statistics for the /api/admin/ssh-pool-stats endpoint.
 * oldest_age_ms is 0 when the pool is empty.
 */
function getPoolStats() {
  let oldestAgeMs = 0;
  if (_pool.size > 0) {
    const now = Date.now();
    // First entry in Map iteration = LRU = oldest
    const [, firstEntry] = _pool.entries().next().value;
    oldestAgeMs = now - firstEntry.lastUsedAt;
  }
  return {
    size:                 _pool.size,
    max:                  MAX_SSH_POOL_SIZE,
    oldest_age_ms:        oldestAgeMs,
    total_evictions_lru:  _totalEvictionsLru,
    total_evictions_idle: _totalEvictionsIdle,
  };
}

module.exports = {
  runQuery,
  runViaSsh,
  testSshConnectivity,
  evictSshPool,
  runRawSsh,
  getPoolStats,
  // Exposed for unit tests only — not part of the stable API
  _pool,
  _getMaxPoolSize: () => MAX_SSH_POOL_SIZE,
};
