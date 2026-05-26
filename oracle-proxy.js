#!/usr/bin/env node
/**
 * TuneVault Oracle HTTP Proxy
 * ===========================
 * Runs on your Oracle server. Exposes an HTTP endpoint that TuneVault
 * calls through your HTTPS proxy to collect Oracle health metrics.
 *
 * Architecture:
 *   TuneVault (Render) → HTTPS → Outbound Proxy → localhost:3100 → Oracle :1521
 *
 * Quick Start:
 *   export TUNEVAULT_API_KEY="your-secret-key-here"
 *   node oracle-proxy.js
 *
 * With PM2 (recommended for production):
 *   npm install -g pm2
 *   TUNEVAULT_API_KEY="your-key" pm2 start oracle-proxy.js --name tunevault-proxy
 *   pm2 save && pm2 startup
 *
 * Requirements:
 *   - Node.js 18+
 *   - npm install oracledb   (thin mode — no Oracle Instant Client needed)
 *   - TUNEVAULT_API_KEY environment variable
 *
 * The proxy listens on 127.0.0.1:3100 only.
 * Your HTTPS proxy should point to http://localhost:3100
 *
 * Update your proxy config to route:
 *   hostname: oracledb.yourdomain.com
 *   service: http://localhost:3100  (was: tcp://localhost:1521)
 */

'use strict';

const http = require('http');
const { execFile, execFileSync } = require('child_process');
const oracledb = require('oracledb');

// ============================================================
// Config
// ============================================================

const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.BIND_HOST || '127.0.0.1';  // localhost only — outbound proxy handles external
const API_KEY = process.env.TUNEVAULT_API_KEY;

if (!API_KEY) {
  console.error('FATAL: TUNEVAULT_API_KEY environment variable is required.');
  console.error('Set it with: export TUNEVAULT_API_KEY="your-secret-key-here"');
  process.exit(1);
}

// oracledb 6.x defaults to thin mode — no Instant Client needed
// Thin mode supports Oracle 12.1+

// ============================================================
// Shell Command Whitelist (EBS 12.2.x application tier only)
// ============================================================
// Only status subcommands are whitelisted — NO start/stop/restart.
// All commands use $ADMIN_SCRIPTS_HOME — NO hardcoded paths.
// admanagedsrvctl.sh is the unified controller for all managed servers.
// Individual *ctl.sh scripts are for non-managed services only.
//
// Entry format: { script, args, purpose }
//   script — filename only; resolved via ADMIN_SCRIPTS_HOME at runtime
//   args   — array of allowed arguments (exact match required)
//   purpose — description for audit log and security page
const SHELL_COMMAND_WHITELIST = [
  { script: 'adcmctl.sh',          args: ['status'],                           purpose: 'Concurrent Manager status' },
  { script: 'adalnctl.sh',         args: ['status'],                           purpose: 'APPS TNS Listener status' },
  { script: 'admanagedsrvctl.sh',  args: ['status', 'oacore_server1'],         purpose: 'OACore managed server status' },
  { script: 'admanagedsrvctl.sh',  args: ['status', 'forms_server1'],          purpose: 'Forms managed server status' },
  { script: 'admanagedsrvctl.sh',  args: ['status', 'oafm_server1'],           purpose: 'OA Framework managed server status' },
  { script: 'admanagedsrvctl.sh',  args: ['status', 'wfmlrsvc'],               purpose: 'Workflow Mailer managed service status' },
  { script: 'admanagedsrvctl.sh',  args: ['status', 'opp'],                    purpose: 'Output Post Processor status' },
  { script: 'adadminsrvctl.sh',    args: ['status'],                           purpose: 'Admin Server status' },
  { script: 'adnodemgrctl.sh',     args: ['status'],                           purpose: 'Node Manager status' },
  { script: 'adopmnctl.sh',        args: ['status'],                           purpose: 'OPMN status' },
  { script: 'mwactl.sh',           args: ['status'],                           purpose: 'Middleware Agent status' },
  { script: 'adapcctl.sh',         args: ['status'],                           purpose: 'Apache/OHS status' },
];

// Build a lookup key for O(1) whitelist validation
// Key = "script:arg1:arg2:..."  e.g. "admanagedsrvctl.sh:status:oacore_server1"
const WHITELIST_KEY_SET = new Set(
  SHELL_COMMAND_WHITELIST.map(e => [e.script, ...e.args].join(':'))
);

// Resolve ADMIN_SCRIPTS_HOME from env — required when shell commands are used.
// No fallback: if it is not set the endpoint rejects immediately with a clear error.
// Customers set this in their PM2/systemd environment before starting the proxy.
function getAdminScriptsHome() {
  return process.env.ADMIN_SCRIPTS_HOME || null;
}

// ============================================================
// OS Command Whitelist (for /api/os/exec endpoint)
// ============================================================
// Commands sent as the "command" field in the request body.
// Exact-match keys resolve to an argv array. No shell=true.
// Dynamic tail/cat commands use prefix-validated path resolution.
// Max output: 64KB. Timeout: 10s.
// allow_role: "any" | "apps"  (apps requires PROXY_ROLE=apps env var)

const OS_CMD_WHITELIST = [
  // DB Tier
  { key: 'df -h',                                           argv: ['df', '-h'],                                              allowRole: 'any'  },
  { key: 'free -m',                                         argv: ['free', '-m'],                                            allowRole: 'any'  },
  { key: 'uptime',                                          argv: ['uptime'],                                                allowRole: 'any'  },
  { key: "cat /proc/cpuinfo | grep processor | wc -l",      argv: ['sh', '-c', 'grep processor /proc/cpuinfo | wc -l'],     allowRole: 'any'  },
  { key: 'top -bn1 | head -20',                             argv: ['sh', '-c', 'top -bn1 | head -20'],                      allowRole: 'any'  },
  { key: "ps aux | grep -E '(ora_|tnslsnr)'",               argv: ['sh', '-c', "ps aux | grep -E '(ora_|tnslsnr)'"],        allowRole: 'any'  },
  { key: 'cat /etc/os-release',                             argv: ['cat', '/etc/os-release'],                               allowRole: 'any'  },
  { key: 'vmstat 1 3',                                      argv: ['vmstat', '1', '3'],                                     allowRole: 'any'  },
  // EBS Apps Tier
  { key: "ps aux | grep -E '(FNDLIBR|FNDSM|OAFM|oacore|forms)'",
                                                            argv: ['sh', '-c', "ps aux | grep -E '(FNDLIBR|FNDSM|OAFM|oacore|forms)'"],
                                                                                                                              allowRole: 'apps' },
  { key: 'ls -la $INST_TOP/logs/',                          argv: ['sh', '-c', 'ls -la $INST_TOP/logs/'],                   allowRole: 'apps' },
];

const OS_CMD_MAP = new Map(OS_CMD_WHITELIST.map(e => [e.key, e]));

// Allowed absolute path prefixes for tail/cat dynamic commands
const TAIL_ALLOWED_PREFIXES = [
  '/u01/', '/u02/', '/u03/', '/u04/',
  '/oracle/', '/app/oracle/', '/opt/oracle/',
  '/prod/', '/d01/', '/d02/',
];
if (process.env.ORACLE_BASE) TAIL_ALLOWED_PREFIXES.push(process.env.ORACLE_BASE);
if (process.env.INST_TOP)    TAIL_ALLOWED_PREFIXES.push(process.env.INST_TOP);

// Compiled safe-path: printable ASCII, no shell metacharacters, no ..
const SAFE_PATH_RE = /^[a-zA-Z0-9_/.\-]+$/;

function validateTailPath(rawPath) {
  const path = (rawPath || '').trim();
  if (!path.startsWith('/')) return { path: null, error: 'path must be absolute' };
  if (path.split('/').includes('..'))  return { path: null, error: 'path traversal not allowed' };
  if (!SAFE_PATH_RE.test(path))        return { path: null, error: 'path contains unsafe characters' };
  const allowed = TAIL_ALLOWED_PREFIXES.filter(Boolean);
  if (!allowed.some(p => path.startsWith(p))) {
    return { path: null, error: 'path not under allowed prefix; allowed: ' + allowed.join(', ') };
  }
  return { path, error: null };
}

function runOsCommand(argv, timeout = 10000, maxOutput = 65536) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Use execFile for non-sh commands, exec for sh -c pipelines
    const bin  = argv[0];
    const args = argv.slice(1);
    execFile(bin, args, { timeout, maxBuffer: maxOutput + 1024 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - t0;
      let out = stdout || '';
      if (out.length > maxOutput) out = out.slice(0, maxOutput) + '\n[truncated]';
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      // timeout produces ETIMEDOUT; treat as 124
      const finalExit = (err && err.killed) ? 124 : exitCode;
      resolve({ stdout: out, stderr: stderr || '', exit_code: finalExit, duration_ms: durationMs });
    });
  });
}

// ============================================================
// HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  // CORS headers (not needed for reverse proxy, but safe)
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Powered-By', 'TuneVault-Proxy');

  // Health ping — no auth required
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { status: 'healthy', proxy: 'TuneVault Oracle Proxy', version: '3.5.7', proxy_version: '3.5.7' });
  }

  // All other endpoints require API key
  const authHeader = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (authHeader !== API_KEY) {
    return send(res, 401, { error: 'Unauthorized — invalid or missing API key' });
  }

  // POST /api/healthcheck — run Oracle health queries
  if (req.method === 'POST' && req.url === '/api/healthcheck') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const { service_name, username, password, host, port } = params;

        if (!service_name || !username || !password) {
          return send(res, 400, { error: 'service_name, username, and password are required' });
        }

        // Connect to Oracle locally
        const oracleHost = host || 'localhost';
        const oraclePort = parseInt(port || '1521', 10);

        console.log(`[${new Date().toISOString()}] Health check: ${username}@${oracleHost}:${oraclePort}/${service_name}`);

        const metrics = await collectMetrics({ host: oracleHost, port: oraclePort, serviceName: service_name, username, password });
        return send(res, 200, { success: true, metrics });
      } catch (err) {
        console.error('Health check failed:', err.message);
        return send(res, 500, { success: false, error: formatOracleError(err) });
      }
    });
    return;
  }

  // POST /api/test — RETIRED (direct-connect testing path removed in v3.5.7)
  // Architecture rule: all proxy testing goes through the outbound long-poll channel
  // or the local CLI. No inbound direct-connect endpoints.
  if (req.method === 'POST' && req.url === '/api/test') {
    return send(res, 410, {
      error: 'Gone — /api/test was the legacy direct-connect testing path and has been retired.',
      replacement: {
        on_proxy_host: 'sudo tunevault-proxy diagnose',
        in_product: 'https://tunevault.app/connections/:id → Run Diagnostics',
      },
      architecture_doc: 'https://tunevault.app/docs/architecture#outbound-long-poll',
    });
  }

  // POST /api/addm — on-demand ADDM findings (Enterprise Edition + Diagnostics Pack)
  if (req.method === 'POST' && req.url === '/api/addm') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const { service_name, username, password, host, port, lookback_hours } = params;

        if (!service_name || !username || !password) {
          return send(res, 400, { error: 'service_name, username, and password are required' });
        }

        const oracleHost = host || 'localhost';
        const oraclePort = parseInt(port || '1521', 10);
        const lookbackHours = Math.min(parseInt(lookback_hours) || 24, 168);

        console.log(`[${new Date().toISOString()}] ADDM query: ${username}@${oracleHost}:${oraclePort}/${service_name} (${lookbackHours}h)`);

        const result = await queryAddmFindings({ host: oracleHost, port: oraclePort, serviceName: service_name, username, password }, lookbackHours);
        return send(res, 200, { success: true, result });
      } catch (err) {
        console.error('ADDM query failed:', err.message);
        return send(res, 500, { success: false, error: formatOracleError(err) });
      }
    });
    return;
  }

  // POST /api/addm-run — create AWR snapshot + run ADDM analysis (EE + Diagnostics Pack)
  if (req.method === 'POST' && req.url === '/api/addm-run') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const { service_name, username, password, host, port } = params;

        if (!service_name || !username || !password) {
          return send(res, 400, { error: 'service_name, username, and password are required' });
        }

        const oracleHost = host || 'localhost';
        const oraclePort = parseInt(port || '1521', 10);

        console.log(`[${new Date().toISOString()}] ADDM run-now: ${username}@${oracleHost}:${oraclePort}/${service_name}`);

        const result = await runAddmNow({ host: oracleHost, port: oraclePort, serviceName: service_name, username, password });
        return send(res, 200, { success: true, result });
      } catch (err) {
        console.error('ADDM run-now failed:', err.message);
        return send(res, 500, { success: false, error: formatOracleError(err) });
      }
    });
    return;
  }

  // POST /api/maintenance — auto-maintenance window status (all editions)
  if (req.method === 'POST' && req.url === '/api/maintenance') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const { service_name, username, password, host, port } = params;

        if (!service_name || !username || !password) {
          return send(res, 400, { error: 'service_name, username, and password are required' });
        }

        const oracleHost = host || 'localhost';
        const oraclePort = parseInt(port || '1521', 10);

        console.log(`[${new Date().toISOString()}] Maintenance query: ${username}@${oracleHost}:${oraclePort}/${service_name}`);

        const result = await queryMaintenanceWindows({ host: oracleHost, port: oraclePort, serviceName: service_name, username, password });
        return send(res, 200, { success: true, result });
      } catch (err) {
        console.error('Maintenance query failed:', err.message);
        return send(res, 500, { success: false, error: formatOracleError(err) });
      }
    });
    return;
  }

  // POST /api/parameters — Oracle init parameters with recommended values (all editions)
  if (req.method === 'POST' && req.url === '/api/parameters') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const params = JSON.parse(body || '{}');
        const { service_name, username, password, host, port } = params;

        if (!service_name || !username || !password) {
          return send(res, 400, { error: 'service_name, username, and password are required' });
        }

        const oracleHost = host || 'localhost';
        const oraclePort = parseInt(port || '1521', 10);

        console.log(`[${new Date().toISOString()}] Parameters query: ${username}@${oracleHost}:${oraclePort}/${service_name}`);

        const result = await queryOracleParameters({ host: oracleHost, port: oraclePort, serviceName: service_name, username, password });
        return send(res, 200, { success: true, result });
      } catch (err) {
        console.error('Parameters query failed:', err.message);
        return send(res, 500, { success: false, error: formatOracleError(err) });
      }
    });
    return;
  }

  // POST /api/shell-command — execute a whitelisted EBS application-tier status command
  // Requires: { script, args } where [script, ...args] matches an entry in SHELL_COMMAND_WHITELIST.
  // Uses ADMIN_SCRIPTS_HOME env var — rejects if not set.
  // Execution log: ISO timestamp, requester IP, script+args, exit code, SHA-256 of stdout.
  if (req.method === 'POST' && req.url === '/api/shell-command') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      const ts = new Date().toISOString();
      const requesterIp = req.socket?.remoteAddress || 'unknown';

      let script, args;
      try {
        const parsed = JSON.parse(body || '{}');
        script = parsed.script;
        args   = Array.isArray(parsed.args) ? parsed.args : [];
      } catch (e) {
        return send(res, 400, { error: 'Invalid JSON body' });
      }

      if (!script) {
        return send(res, 400, { error: '"script" is required (filename only, no path)' });
      }

      // Reject any path traversal in the script field
      if (script.includes('/') || script.includes('..') || script.includes('\0')) {
        console.log(`[${ts}] SHELL_REJECTED ip=${requesterIp} script=${script} reason=path_traversal`);
        return send(res, 400, { error: 'script must be a filename only — no path separators' });
      }

      // Validate all arg values for safety (no shell metacharacters)
      const SAFE_ARG = /^[a-zA-Z0-9._\-]+$/;
      for (const arg of args) {
        if (!SAFE_ARG.test(arg)) {
          console.log(`[${ts}] SHELL_REJECTED ip=${requesterIp} script=${script} reason=unsafe_arg arg=${arg}`);
          return send(res, 400, { error: `Unsafe argument: ${arg}` });
        }
      }

      // Whitelist check — exact match on script + args combination
      const lookupKey = [script, ...args].join(':');
      if (!WHITELIST_KEY_SET.has(lookupKey)) {
        console.log(`[${ts}] SHELL_REJECTED ip=${requesterIp} key=${lookupKey} reason=not_whitelisted`);
        return send(res, 403, {
          error: 'Command not in whitelist',
          requested: lookupKey,
          hint: 'Only status subcommands for EBS 12.2.x application tier are whitelisted.'
        });
      }

      const adminScriptsHome = getAdminScriptsHome();
      if (!adminScriptsHome) {
        console.log(`[${ts}] SHELL_REJECTED ip=${requesterIp} key=${lookupKey} reason=no_ADMIN_SCRIPTS_HOME`);
        return send(res, 503, {
          error: 'ADMIN_SCRIPTS_HOME environment variable is not set on this proxy',
          hint: 'Set ADMIN_SCRIPTS_HOME in the proxy environment before using shell commands.'
        });
      }

      const scriptPath = `${adminScriptsHome}/${script}`;

      // Find the whitelist entry for this key to get the purpose string
      const entry = SHELL_COMMAND_WHITELIST.find(e => [e.script, ...e.args].join(':') === lookupKey);

      console.log(`[${ts}] SHELL_EXEC ip=${requesterIp} script=${scriptPath} args=${args.join(' ')} purpose="${entry?.purpose}"`);

      try {
        const { stdout, stderr, exitCode } = await runShellCommand(scriptPath, args);

        // Hash output for audit log — prevents storing sensitive content in logs
        const { createHash } = require('crypto');
        const outputHash = createHash('sha256').update(stdout).digest('hex').slice(0, 16);

        console.log(`[${ts}] SHELL_DONE  ip=${requesterIp} script=${script} args=${args.join(' ')} exit=${exitCode} output_hash=${outputHash}`);

        return send(res, 200, {
          success: true,
          script,
          args,
          purpose: entry?.purpose,
          exit_code: exitCode,
          stdout,
          stderr: stderr || '',
          output_hash: outputHash,
          executed_at: ts
        });
      } catch (err) {
        console.log(`[${ts}] SHELL_ERROR ip=${requesterIp} script=${script} args=${args.join(' ')} err=${err.message}`);
        return send(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // POST /api/execute-sql — execute a whitelisted SQL statement and return results as JSON.
  // Accepts: { service_name, username, password, host, port, sql }
  // The TuneVault server enforces the command whitelist before calling this endpoint.
  // The proxy executes the SQL as-received — no second whitelist check here.
  // 30s query timeout. SELECT results capped at 500 rows. DML returns rowsAffected.
  if (req.method === 'POST' && req.url === '/api/execute-sql') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      const ts = new Date().toISOString();
      const requesterIp = req.socket?.remoteAddress || 'unknown';

      let params;
      try {
        params = JSON.parse(body || '{}');
      } catch (e) {
        return send(res, 400, { error: 'Invalid JSON body' });
      }

      const { service_name, username, password, host, port, sql } = params;

      if (!service_name || !username || !password) {
        return send(res, 400, { error: 'service_name, username, and password are required' });
      }
      if (!sql || !sql.trim()) {
        return send(res, 400, { error: 'sql is required' });
      }

      const oracleHost = host || 'localhost';
      const oraclePort = parseInt(port || '1521', 10);

      console.log(`[${ts}] EXECUTE_SQL ip=${requesterIp} target=${username}@${oracleHost}:${oraclePort}/${service_name} sql_len=${sql.length}`);

      let connection;
      const t0 = Date.now();
      try {
        const connectString = `${oracleHost}:${oraclePort}/${service_name}`;
        connection = await oracledb.getConnection({
          user: username,
          password: password,
          connectString,
          connectTimeout: 20,
        });

        const sqlTrimmed = sql.trim().replace(/;+$/, ''); // strip trailing semicolons (OCI rejects them)
        const result = await connection.execute(sqlTrimmed, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          fetchArraySize: 500,
          maxRows: 500,
          // 30-second execution timeout
          callTimeout: 30000,
        });

        const durationMs = Date.now() - t0;

        if (result.metaData && result.rows !== undefined) {
          // SELECT result — serialize rows to plain objects
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
          console.log(`[${ts}] EXECUTE_SQL_DONE ip=${requesterIp} rows=${rows.length} duration_ms=${durationMs}`);
          return send(res, 200, { success: true, columns, rows, duration_ms: durationMs });
        } else {
          // DML / DDL result
          console.log(`[${ts}] EXECUTE_SQL_DONE ip=${requesterIp} rows_affected=${result.rowsAffected || 0} duration_ms=${durationMs}`);
          return send(res, 200, { success: true, rowsAffected: result.rowsAffected || 0, duration_ms: durationMs });
        }
      } catch (err) {
        const durationMs = Date.now() - t0;
        const oraError = formatOracleError(err);
        console.log(`[${ts}] EXECUTE_SQL_ERROR ip=${requesterIp} duration_ms=${durationMs} err=${oraError}`);
        return send(res, 200, { success: false, error: oraError, duration_ms: durationMs });
      } finally {
        if (connection) {
          try { await connection.close(); } catch (_) {}
        }
      }
    });
    return;
  }

  // POST /api/os/exec — run a whitelisted OS command on the local server.
  // Accepts: { command: "<key>" }
  // Returns: { stdout, stderr, exit_code, duration_ms }
  // Security: strict whitelist match; no shell=true for exact-key commands;
  //           dynamic tail/cat paths validated against allowed prefixes.
  if (req.method === 'POST' && req.url === '/api/os/exec') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      const ts = new Date().toISOString();
      const ip = req.socket?.remoteAddress || 'unknown';

      let params;
      try { params = JSON.parse(body || '{}'); }
      catch (e) { return send(res, 400, { error: 'Invalid JSON body' }); }

      const commandKey = (params.command || '').trim();
      if (!commandKey) return send(res, 400, { error: '"command" is required' });

      const proxyRole = (process.env.PROXY_ROLE || 'db').toLowerCase();

      // ── Dynamic tail with path ─────────────────────────────────────────────
      const tailMatch = commandKey.match(/^tail -n (\d+) (.+)$/);
      if (tailMatch) {
        const lines   = Math.min(parseInt(tailMatch[1], 10), 500);
        const { path, error } = validateTailPath(tailMatch[2]);
        if (error) {
          console.log(`[${ts}] OS_EXEC_REJECT ip=${ip} key=${commandKey} reason=${error}`);
          return send(res, 403, { error: `rejected: ${error}` });
        }
        console.log(`[${ts}] OS_EXEC ip=${ip} tail lines=${lines} path=${path}`);
        const result = await runOsCommand(['tail', '-n', String(lines), path]);
        return send(res, 200, result);
      }

      // ── Dynamic cat with path ──────────────────────────────────────────────
      const catMatch = commandKey.match(/^cat (\/[^ ]+)$/);
      if (catMatch) {
        const { path, error } = validateTailPath(catMatch[1]);
        if (error) {
          console.log(`[${ts}] OS_EXEC_REJECT ip=${ip} key=${commandKey} reason=${error}`);
          return send(res, 403, { error: `rejected: ${error}` });
        }
        console.log(`[${ts}] OS_EXEC ip=${ip} cat path=${path}`);
        const result = await runOsCommand(['cat', path]);
        return send(res, 200, result);
      }

      // ── Exact whitelist match ──────────────────────────────────────────────
      const entry = OS_CMD_MAP.get(commandKey);
      if (!entry) {
        console.log(`[${ts}] OS_EXEC_REJECT ip=${ip} key=${commandKey} reason=not_whitelisted`);
        return send(res, 403, { error: 'command not whitelisted', received: commandKey });
      }

      if (entry.allowRole === 'apps' && proxyRole !== 'apps') {
        console.log(`[${ts}] OS_EXEC_REJECT ip=${ip} key=${commandKey} reason=role_mismatch proxy_role=${proxyRole}`);
        return send(res, 403, { error: 'this command requires PROXY_ROLE=apps on the proxy server' });
      }

      console.log(`[${ts}] OS_EXEC ip=${ip} key=${commandKey}`);
      const result = await runOsCommand(entry.argv);
      return send(res, 200, result);
    });
    return;
  }

  return send(res, 404, { error: 'Not found' });
});

function send(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

// ============================================================
// Shell Command Execution
// ============================================================

// Wraps execFile in a promise. Uses the pre-validated scriptPath and args array.
// 30s timeout — status commands should return in < 5s; this guards against hangs.
// Never spawns a shell (execFile, not exec) — no shell interpolation of arguments.
function runShellCommand(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile(scriptPath, args, { timeout: 30000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        return reject(new Error(`Script not found: ${scriptPath} — check ADMIN_SCRIPTS_HOME`));
      }
      // Non-zero exit is normal for "service not running" — return it, don't throw
      const exitCode = err ? (err.code || 1) : 0;
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode });
    });
  });
}

server.listen(PORT, HOST, () => {
  console.log(`TuneVault Oracle Proxy listening on ${HOST}:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Proxy is ready. Update your outbound HTTPS proxy to route to http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Change with: PORT=3101 node oracle-proxy.js`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

// ============================================================
// Oracle Connection Test
// ============================================================

async function testConnection({ host, port, serviceName, username, password }) {
  let connection;
  try {
    const connectString = `${host}:${port}/${serviceName}`;
    connection = await oracledb.getConnection({
      user: username,
      password: password,
      connectString,
      connectTimeout: 15
    });

    const result = await connection.execute(`SELECT banner FROM v$version WHERE ROWNUM = 1`);
    const version = result.rows?.[0]?.[0] || 'Connected';
    return { success: true, message: 'Connection successful', version };
  } catch (err) {
    return { success: false, message: formatOracleError(err) };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// Oracle Metrics Collection
// ============================================================

async function collectMetrics({ host, port, serviceName, username, password }) {
  let connection;
  try {
    const connectString = `${host}:${port}/${serviceName}`;
    connection = await oracledb.getConnection({
      user: username,
      password: password,
      connectString,
      connectTimeout: 30
    });

    const awrAvailable = await checkAwrAvailability(connection);

    const [instanceInfo, tablespaces, waitEvents, topSql, indexAnalysis, sgaStats, pgaStats, osStats,
           undoStats, tempStats, alertLog, resourceLimits, sgaPgaHistory, backupStats, appsHealth,
           dbObjects, sessionStats, securityStats, schemaStats] = await Promise.all([
      queryInstanceInfo(connection),
      queryTablespaces(connection),
      queryWaitEvents(connection),
      queryTopSql(connection),
      queryIndexAnalysis(connection),
      querySgaStats(connection),
      queryPgaStats(connection),
      queryOsStats(connection),
      queryUndoStats(connection, awrAvailable),
      queryTempStats(connection, awrAvailable),
      queryAlertLog(connection),
      queryResourceLimits(connection, awrAvailable),
      querySgaPgaHistory(connection, awrAvailable),
      queryBackupStats(connection),
      queryAppsHealth(connection),
      queryDbObjects(connection),
      querySessionStats(connection),
      querySecurityStats(connection),
      querySchemaStats(connection)
    ]);

    return {
      instance: instanceInfo,
      tablespaces,
      wait_events: waitEvents,
      top_sql: topSql,
      index_analysis: indexAnalysis,
      sga_stats: sgaStats,
      pga_stats: pgaStats,
      redo_stats: { redo_size_mb_per_hour: 0, log_switches_per_hour: 0, log_file_size_mb: 0, log_groups: 0, avg_log_sync_ms: 0, max_log_sync_ms: 0 },
      os_stats: osStats,
      undo_stats: undoStats,
      temp_stats: tempStats,
      alert_log: alertLog,
      resource_limits: resourceLimits,
      sga_pga_history: sgaPgaHistory,
      backup_stats: backupStats,
      apps_health: appsHealth,
      db_objects: dbObjects,
      session_stats: sessionStats,
      security_stats: securityStats,
      schema_stats: schemaStats,
      awr_available: awrAvailable,
      proxy_version: '3.5.3',
      snapshot_info: {
        begin_snap_id: 0, end_snap_id: 0,
        begin_time: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString(),
        elapsed_time_min: 720, db_time_min: 0
      }
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// Query Functions
// ============================================================

async function queryInstanceInfo(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        d.NAME as db_name,
        i.INSTANCE_NAME,
        i.HOST_NAME,
        i.VERSION,
        d.PLATFORM_NAME,
        TO_CHAR(i.STARTUP_TIME, 'YYYY-MM-DD HH24:MI:SS') as startup_time,
        ROUND(SYSDATE - i.STARTUP_TIME) as uptime_days,
        (SELECT VALUE FROM v$parameter WHERE name = 'cpu_count') as cpus,
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'sga_target'), 1) as sga_target_gb,
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1) as pga_target_gb,
        (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size') as db_block_size
      FROM v$database d, v$instance i
    `);
    const row = result.rows?.[0];
    if (!row) throw new Error('No instance data');
    return {
      db_name: row[0] || 'UNKNOWN',
      instance_name: row[1] || 'unknown',
      host_name: row[2] || 'unknown',
      version: row[3] || 'Unknown',
      platform: row[4] || 'Unknown',
      startup_time: row[5] || '',
      uptime_days: row[6] || 0,
      rac: false,
      cpus: parseInt(row[7]) || 1,
      sga_target_gb: parseFloat(row[8]) || 0,
      pga_aggregate_target_gb: parseFloat(row[9]) || 0,
      db_block_size: parseInt(row[10]) || 8192
    };
  } catch (err) {
    console.error('Instance query failed:', err.message);
    try {
      const r1 = await conn.execute(`SELECT name FROM v$database`);
      const r2 = await conn.execute(`SELECT instance_name, host_name, version FROM v$instance`);
      return {
        db_name: r1.rows?.[0]?.[0] || 'UNKNOWN',
        instance_name: r2.rows?.[0]?.[0] || 'unknown',
        host_name: r2.rows?.[0]?.[1] || 'unknown',
        version: r2.rows?.[0]?.[2] || 'Unknown',
        platform: 'Unknown', startup_time: '', uptime_days: 0,
        rac: false, cpus: 1, sga_target_gb: 0, pga_aggregate_target_gb: 0, db_block_size: 8192
      };
    } catch (e2) {
      return { db_name: 'UNKNOWN', instance_name: 'unknown', host_name: 'unknown', version: 'Unknown', platform: 'Unknown', startup_time: '', uptime_days: 0, rac: false, cpus: 1, sga_target_gb: 0, pga_aggregate_target_gb: 0, db_block_size: 8192 };
    }
  }
}

async function queryTablespaces(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        ts.TABLESPACE_NAME,
        ROUND(um.USED_SPACE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1) as used_gb,
        ROUND(um.TABLESPACE_SIZE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1) as total_gb,
        ROUND(um.USED_PERCENT, 1) as pct_used,
        CASE WHEN df.autoext > 0 THEN 1 ELSE 0 END as autoextend
      FROM DBA_TABLESPACE_USAGE_METRICS um
      JOIN DBA_TABLESPACES ts ON ts.TABLESPACE_NAME = um.TABLESPACE_NAME
      LEFT JOIN (SELECT TABLESPACE_NAME, BLOCK_SIZE FROM DBA_TABLESPACES) ts_block ON ts_block.TABLESPACE_NAME = um.TABLESPACE_NAME
      LEFT JOIN (
        SELECT TABLESPACE_NAME, SUM(CASE WHEN AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END) as autoext
        FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME
      ) df ON df.TABLESPACE_NAME = um.TABLESPACE_NAME
      ORDER BY um.USED_PERCENT DESC
    `);
    return (result.rows || []).map(row => {
      const pct = parseFloat(row[3]) || 0;
      return { name: row[0], used_gb: parseFloat(row[1]) || 0, total_gb: parseFloat(row[2]) || 0, pct_used: pct, autoextend: row[4] > 0, status: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'ok' };
    });
  } catch (err) {
    console.error('Tablespace primary query failed:', err.message);
    try {
      const result = await conn.execute(`
        SELECT df.TABLESPACE_NAME,
          ROUND(SUM(df.BYTES) / 1024 / 1024 / 1024, 1) as total_gb,
          ROUND((SUM(df.BYTES) - NVL(fs.free_bytes, 0)) / 1024 / 1024 / 1024, 1) as used_gb,
          ROUND((1 - NVL(fs.free_bytes, 0) / SUM(df.BYTES)) * 100, 1) as pct_used,
          MAX(CASE WHEN df.AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END) as autoextend
        FROM DBA_DATA_FILES df
        LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) as free_bytes FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) fs ON fs.TABLESPACE_NAME = df.TABLESPACE_NAME
        GROUP BY df.TABLESPACE_NAME, fs.free_bytes ORDER BY pct_used DESC
      `);
      return (result.rows || []).map(row => {
        const pct = parseFloat(row[3]) || 0;
        return { name: row[0], used_gb: parseFloat(row[2]) || 0, total_gb: parseFloat(row[1]) || 0, pct_used: pct, autoextend: row[4] > 0, status: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'ok' };
      });
    } catch (e2) {
      return [];
    }
  }
}

async function queryWaitEvents(conn) {
  try {
    const result = await conn.execute(`
      SELECT EVENT, WAIT_CLASS, TOTAL_WAITS,
        ROUND(TIME_WAITED / 100, 1) as time_waited_s,
        CASE WHEN TOTAL_WAITS > 0 THEN ROUND((TIME_WAITED / 100 / TOTAL_WAITS) * 1000, 2) ELSE 0 END as avg_wait_ms
      FROM V$SYSTEM_EVENT
      WHERE WAIT_CLASS NOT IN ('Idle') AND TOTAL_WAITS > 0
      ORDER BY TIME_WAITED DESC
      FETCH FIRST 15 ROWS ONLY
    `);
    const rows = result.rows || [];
    const totalTime = rows.reduce((s, r) => s + (parseFloat(r[3]) || 0), 0);
    return rows.map(row => ({
      event: row[0], wait_class: row[1], total_waits: parseInt(row[2]) || 0,
      time_waited_s: parseFloat(row[3]) || 0, avg_wait_ms: parseFloat(row[4]) || 0,
      pct_db_time: totalTime > 0 ? Math.round((parseFloat(row[3]) / totalTime) * 1000) / 10 : 0
    }));
  } catch (err) {
    console.error('Wait events query failed:', err.message);
    return [];
  }
}

async function queryTopSql(conn) {
  try {
    const result = await conn.execute(`
      SELECT SQL_ID, SUBSTR(SQL_TEXT, 1, 500), EXECUTIONS,
        ROUND(ELAPSED_TIME / 1000000, 1), ROUND(CPU_TIME / 1000000, 1),
        BUFFER_GETS, DISK_READS, ROWS_PROCESSED,
        CASE WHEN EXECUTIONS > 0 THEN ROUND(ELAPSED_TIME / EXECUTIONS / 1000, 2) ELSE 0 END as elapsed_per_exec_ms,
        CASE WHEN EXECUTIONS > 0 THEN ROUND(BUFFER_GETS / EXECUTIONS) ELSE 0 END as buffer_gets_per_exec,
        PLAN_HASH_VALUE
      FROM V$SQL
      WHERE EXECUTIONS > 0 AND ELAPSED_TIME > 0
        AND PARSING_SCHEMA_NAME NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','EXFSYS','WMSYS','APPQOSSYS','DBSFWUSER')
        AND SQL_TEXT NOT LIKE '%v$%' AND SQL_TEXT NOT LIKE '%V$%'
        AND COMMAND_TYPE IN (2, 3, 6, 7, 189)
      ORDER BY ELAPSED_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `);
    return (result.rows || []).map(row => {
      const elapsedPerExec = parseFloat(row[8]) || 0;
      const bufferGetsPerExec = parseInt(row[9]) || 0;
      let issue = 'Normal operation';
      if (elapsedPerExec > 20) issue = 'Very slow execution — check execution plan';
      else if (elapsedPerExec > 5) issue = 'Slow execution — review query and indexes';
      if (bufferGetsPerExec > 1000) issue = 'High buffer gets — possible full table scan or missing index';
      if (parseInt(row[6]) > parseInt(row[5]) * 0.1 && parseInt(row[6]) > 10000) issue = 'High disk reads relative to buffer gets — data not in cache';
      return {
        sql_id: row[0], sql_text: row[1] || '', executions: parseInt(row[2]) || 0,
        elapsed_time_s: parseFloat(row[3]) || 0, cpu_time_s: parseFloat(row[4]) || 0,
        buffer_gets: parseInt(row[5]) || 0, disk_reads: parseInt(row[6]) || 0,
        rows_processed: parseInt(row[7]) || 0, elapsed_per_exec_ms: elapsedPerExec,
        buffer_gets_per_exec: bufferGetsPerExec, plan_hash: String(row[10] || '0'), issue
      };
    });
  } catch (err) {
    console.error('Top SQL query failed:', err.message);
    return [];
  }
}

async function queryIndexAnalysis(conn) {
  try {
    const result = await conn.execute(`
      SELECT i.OWNER, i.INDEX_NAME, i.TABLE_NAME,
        ROUND(s.LEAF_BLOCKS * (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size') / 1024 / 1024) as size_mb,
        i.BLEVEL, s.LEAF_BLOCKS, i.CLUSTERING_FACTOR,
        NVL(s.PCT_DIRECT_ACCESS, 100) as pct_direct_access,
        i.STATUS,
        CASE
          WHEN i.STATUS != 'VALID' THEN 'unusable'
          WHEN i.BLEVEL > 4 THEN 'critical'
          WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 50 THEN 'critical'
          WHEN i.BLEVEL > 3 THEN 'fragmented'
          WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 70 THEN 'fragmented'
          ELSE 'ok'
        END as health_status
      FROM DBA_INDEXES i
      LEFT JOIN DBA_IND_STATISTICS s ON s.OWNER = i.OWNER AND s.INDEX_NAME = i.INDEX_NAME AND s.PARTITION_NAME IS NULL
      WHERE i.OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','EXFSYS','WMSYS','XDB','CTXSYS','APPQOSSYS','DBSFWUSER','APEX_040000','APEX_040200','APEX_050000','FLOWS_FILES')
        AND i.INDEX_TYPE = 'NORMAL' AND NVL(s.LEAF_BLOCKS, 0) > 100
      ORDER BY CASE WHEN i.STATUS != 'VALID' THEN 1 WHEN i.BLEVEL > 4 THEN 2 WHEN i.BLEVEL > 3 THEN 3 ELSE 4 END, s.LEAF_BLOCKS DESC NULLS LAST
      FETCH FIRST 20 ROWS ONLY
    `);
    return (result.rows || []).map(row => {
      const blevel = parseInt(row[4]) || 0;
      const pctDirect = parseInt(row[7]) || 100;
      const estPctDeleted = Math.max(0, Math.min(100, Math.round(100 - pctDirect + (blevel > 3 ? (blevel - 3) * 15 : 0))));
      return { owner: row[0], index_name: row[1], table_name: row[2], size_mb: parseInt(row[3]) || 0, blevel, leaf_blocks: parseInt(row[5]) || 0, clustering_factor: parseInt(row[6]) || 0, pct_deleted: estPctDeleted, status: row[9] || 'ok' };
    });
  } catch (err) {
    console.error('Index analysis query failed:', err.message);
    return [];
  }
}

async function querySgaStats(conn) {
  try {
    const [sgaR, hitR, libR, dictR, spR, parseR, compR] = await Promise.all([
      conn.execute(`SELECT ROUND(SUM(VALUE) / 1024 / 1024 / 1024, 1) FROM V$SGA`),
      conn.execute(`SELECT ROUND((1 - (phys.VALUE / (db_gets.VALUE + con_gets.VALUE))) * 100, 1) FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'physical reads') phys, (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'db block gets') db_gets, (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'consistent gets') con_gets`),
      conn.execute(`SELECT ROUND(SUM(PINS - RELOADS) / NULLIF(SUM(PINS), 0) * 100, 1) FROM V$LIBRARYCACHE`),
      conn.execute(`SELECT ROUND(SUM(GETS - GETMISSES) / NULLIF(SUM(GETS), 0) * 100, 1) FROM V$ROWCACHE`),
      conn.execute(`SELECT ROUND(free_bytes.val / total_bytes.val * 100, 1) FROM (SELECT SUM(BYTES) as val FROM V$SGASTAT WHERE POOL = 'shared pool' AND NAME = 'free memory') free_bytes, (SELECT SUM(BYTES) as val FROM V$SGASTAT WHERE POOL = 'shared pool') total_bytes`),
      conn.execute(`SELECT ROUND(hp.VALUE / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1), ROUND((tp.VALUE - hp.VALUE) / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1) FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (hard)') hp, (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (total)') tp, (SELECT (SYSDATE - STARTUP_TIME) * 86400 as VALUE FROM V$INSTANCE) uptime`),
      conn.execute(`SELECT NAME, ROUND(VALUE / 1024 / 1024 / 1024, 1) FROM V$SGA`)
    ]);
    const components = {};
    (compR.rows || []).forEach(r => {
      const name = (r[0] || '').toLowerCase();
      if (name.includes('buffer')) components.buffer_cache_gb = parseFloat(r[1]) || 0;
      if (name.includes('shared')) components.shared_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('large')) components.large_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('java')) components.java_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('stream')) components.streams_pool_gb = parseFloat(r[1]) || 0;
    });
    return {
      sga_size_gb: parseFloat(sgaR.rows?.[0]?.[0]) || 0,
      buffer_cache_gb: components.buffer_cache_gb || 0,
      shared_pool_gb: components.shared_pool_gb || 0,
      large_pool_gb: components.large_pool_gb || 0,
      java_pool_gb: components.java_pool_gb || 0,
      streams_pool_gb: components.streams_pool_gb || 0,
      buffer_cache_hit_ratio: parseFloat(hitR.rows?.[0]?.[0]) || 0,
      library_cache_hit_ratio: parseFloat(libR.rows?.[0]?.[0]) || 0,
      dictionary_cache_hit_ratio: parseFloat(dictR.rows?.[0]?.[0]) || 0,
      shared_pool_free_pct: parseFloat(spR.rows?.[0]?.[0]) || 0,
      hard_parses_per_sec: parseFloat(parseR.rows?.[0]?.[0]) || 0,
      soft_parses_per_sec: parseFloat(parseR.rows?.[0]?.[1]) || 0
    };
  } catch (err) {
    console.error('SGA stats query failed:', err.message);
    return { sga_size_gb: 0, buffer_cache_gb: 0, shared_pool_gb: 0, large_pool_gb: 0, java_pool_gb: 0, streams_pool_gb: 0, buffer_cache_hit_ratio: 0, library_cache_hit_ratio: 0, dictionary_cache_hit_ratio: 0, shared_pool_free_pct: 0, hard_parses_per_sec: 0, soft_parses_per_sec: 0 };
  }
}

async function queryPgaStats(conn) {
  try {
    const r = await conn.execute(`
      SELECT
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1),
        ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME = 'total PGA allocated'), 1),
        ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME = 'maximum PGA allocated'), 1),
        (SELECT VALUE FROM V$PGASTAT WHERE NAME = 'over allocation count'),
        ROUND((SELECT VALUE FROM V$PGASTAT WHERE NAME = 'cache hit percentage'), 1)
      FROM DUAL
    `);
    const wa = await conn.execute(`
      SELECT ROUND(optimal.cnt/NULLIF(total.cnt,0)*100,1), ROUND(onepass.cnt/NULLIF(total.cnt,0)*100,1), ROUND(multipass.cnt/NULLIF(total.cnt,0)*100,1)
      FROM (SELECT SUM(OPTIMAL_EXECUTIONS+ONEPASS_EXECUTIONS+MULTIPASSES_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE>0) total,
           (SELECT SUM(OPTIMAL_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE>0) optimal,
           (SELECT SUM(ONEPASS_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE>0) onepass,
           (SELECT SUM(MULTIPASSES_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE>0) multipass
    `);
    const row = r.rows?.[0] || [];
    const waRow = wa.rows?.[0] || [];
    return {
      pga_target_gb: parseFloat(row[0]) || 0, pga_allocated_gb: parseFloat(row[1]) || 0,
      pga_max_allocated_gb: parseFloat(row[2]) || 0, over_allocation_count: parseInt(row[3]) || 0,
      cache_hit_pct: parseFloat(row[4]) || 0, optimal_executions_pct: parseFloat(waRow[0]) || 0,
      onepass_executions_pct: parseFloat(waRow[1]) || 0, multipass_executions_pct: parseFloat(waRow[2]) || 0
    };
  } catch (err) {
    console.error('PGA stats query failed:', err.message);
    return { pga_target_gb: 0, pga_allocated_gb: 0, pga_max_allocated_gb: 0, over_allocation_count: 0, cache_hit_pct: 0, optimal_executions_pct: 0, onepass_executions_pct: 0, multipass_executions_pct: 0 };
  }
}

async function queryOsStats(conn) {
  try {
    const result = await conn.execute(`
      SELECT STAT_NAME, VALUE FROM V$OSSTAT
      WHERE STAT_NAME IN ('NUM_CPUS','IDLE_TIME','BUSY_TIME','USER_TIME','SYS_TIME','IOWAIT_TIME','PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES')
    `);
    const stats = {};
    (result.rows || []).forEach(r => { stats[r[0]] = parseFloat(r[1]) || 0; });
    const totalCpuTime = (stats.IDLE_TIME || 0) + (stats.BUSY_TIME || 0);
    const cpuPct = totalCpuTime > 0 ? Math.round((stats.BUSY_TIME || 0) / totalCpuTime * 1000) / 10 : 0;
    const ioPct = totalCpuTime > 0 ? Math.round((stats.IOWAIT_TIME || 0) / totalCpuTime * 1000) / 10 : 0;
    return {
      cpu_count: parseInt(stats.NUM_CPUS) || 1, avg_cpu_utilization_pct: cpuPct,
      max_cpu_utilization_pct: Math.min(cpuPct * 1.3, 100), avg_io_wait_pct: ioPct,
      physical_memory_gb: Math.round((stats.PHYSICAL_MEMORY_BYTES || 0) / 1024 / 1024 / 1024 * 10) / 10,
      free_memory_gb: Math.round((stats.FREE_MEMORY_BYTES || 0) / 1024 / 1024 / 1024 * 10) / 10,
      swap_used_gb: 0, avg_disk_read_ms: 0, avg_disk_write_ms: 0
    };
  } catch (err) {
    console.error('OS stats query failed:', err.message);
    return { cpu_count: 1, avg_cpu_utilization_pct: 0, max_cpu_utilization_pct: 0, avg_io_wait_pct: 0, physical_memory_gb: 0, free_memory_gb: 0, swap_used_gb: 0, avg_disk_read_ms: 0, avg_disk_write_ms: 0 };
  }
}

// ============================================================
// Wave A: Undo, Temp, Alert Log, Resource Limits, SGA/PGA History
// ============================================================

async function checkAwrAvailability(conn) {
  try {
    await conn.execute(`SELECT COUNT(*) FROM DBA_HIST_UNDOSTAT WHERE ROWNUM = 1`);
    return true;
  } catch (err) {
    return false;
  }
}

async function queryUndoStats(conn, awrAvailable) {
  try {
    const currentResult = await conn.execute(`
      SELECT UNDOBLKS, TXNCOUNT, MAXQUERYLEN, MAXCONCURRENCY, TUNED_UNDORETENTION,
             EXPIREDBLKS, UNEXPIREDBLKS, ACTIVEBLKS
      FROM V$UNDOSTAT WHERE ROWNUM = 1 ORDER BY END_TIME DESC
    `);
    const tsResult = await conn.execute(`
      SELECT d.TABLESPACE_NAME,
             SUM(d.BYTES)/1073741824 AS TOTAL_GB,
             SUM(d.BYTES - NVL(f.FREE_BYTES,0))/1073741824 AS USED_GB,
             ROUND(SUM(d.BYTES - NVL(f.FREE_BYTES,0))/SUM(d.BYTES)*100,1) AS PCT_USED,
             t.RETENTION
      FROM DBA_DATA_FILES d JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME=d.TABLESPACE_NAME
      LEFT JOIN (SELECT FILE_ID, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY FILE_ID) f ON f.FILE_ID=d.FILE_ID
      WHERE t.CONTENTS='UNDO' GROUP BY d.TABLESPACE_NAME, t.RETENTION
    `);
    const row = (currentResult.rows||[[]])[0]||[];
    const tsRow = (tsResult.rows||[[]])[0]||[];
    const current = {
      undo_blocks: parseInt(row[0])||0, transaction_count: parseInt(row[1])||0,
      max_query_length_s: parseInt(row[2])||0, max_concurrency: parseInt(row[3])||0,
      tuned_undo_retention_s: parseInt(row[4])||900, expired_blocks: parseInt(row[5])||0,
      unexpired_blocks: parseInt(row[6])||0, active_blocks: parseInt(row[7])||0,
      tablespace_name: tsRow[0]||'UNDOTBS1', total_gb: parseFloat(tsRow[1])||0,
      used_gb: parseFloat(tsRow[2])||0, pct_used: parseFloat(tsRow[3])||0,
      retention_mode: tsRow[4]||'NOGUARANTEE'
    };
    let historical = { peak_pct_used: null, peak_time: null, peak_query_length_s: null, lookback_days: 30 };
    if (awrAvailable) {
      try {
        const hr = await conn.execute(`
          SELECT ROUND(MAX(u.UNDOBLKS)/NULLIF(d.TOTAL_BLOCKS,0)*100,1),
                 TO_CHAR(MAX(u.END_TIME) KEEP (DENSE_RANK LAST ORDER BY u.UNDOBLKS),'YYYY-MM-DD HH24:MI'),
                 MAX(u.MAXQUERYLEN), ROUND(MAX(u.TUNED_UNDORETENTION)/60,0)
          FROM DBA_HIST_UNDOSTAT u CROSS JOIN (
            SELECT SUM(BLOCKS) AS TOTAL_BLOCKS FROM DBA_DATA_FILES df
            JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME=df.TABLESPACE_NAME WHERE t.CONTENTS='UNDO'
          ) d WHERE u.END_TIME > SYSDATE-30
        `);
        const h = (hr.rows||[[]])[0]||[];
        historical = { peak_pct_used: parseFloat(h[0])||null, peak_time: h[1]||null, peak_query_length_s: parseInt(h[2])||null, max_tuned_retention_min: parseInt(h[3])||null, lookback_days: 30 };
      } catch(e) {}
    }
    return { current, historical, awr_available: awrAvailable };
  } catch(err) {
    console.error('Undo stats query failed:', err.message);
    return { current: { tablespace_name:'UNDOTBS1', total_gb:0, used_gb:0, pct_used:0, tuned_undo_retention_s:900, max_query_length_s:0, retention_mode:'NOGUARANTEE' }, historical: { peak_pct_used:null, peak_time:null, lookback_days:30 }, awr_available: awrAvailable };
  }
}

async function queryTempStats(conn, awrAvailable) {
  try {
    const freeResult = await conn.execute(`
      SELECT TABLESPACE_NAME, ROUND(TABLESPACE_SIZE/1073741824,2), ROUND(FREE_SPACE/1073741824,2),
             ROUND((TABLESPACE_SIZE-FREE_SPACE)/NULLIF(TABLESPACE_SIZE,0)*100,1)
      FROM DBA_TEMP_FREE_SPACE
    `);
    const sessionResult = await conn.execute(`
      SELECT s.SID, s.SERIAL#, s.USERNAME, ROUND(s.BLOCKS*8192/1048576,1), s.TABLESPACE
      FROM V$TEMPSEG_USAGE s ORDER BY s.BLOCKS DESC FETCH FIRST 10 ROWS ONLY
    `).catch(() => ({ rows: [] }));
    const freeRow = (freeResult.rows||[[]])[0]||[];
    const totalGb = parseFloat(freeRow[1])||0, freeGb = parseFloat(freeRow[2])||0;
    const current = {
      tablespace_name: freeRow[0]||'TEMP', total_gb: totalGb,
      used_gb: Math.max(0, totalGb-freeGb), free_gb: freeGb,
      pct_used: parseFloat(freeRow[3])||0,
      top_sessions: (sessionResult.rows||[]).map(r=>({ sid:r[0], serial:r[1], username:r[2]||'UNKNOWN', temp_mb:parseFloat(r[3])||0, tablespace:r[4]||'' }))
    };
    let historical = { peak_gb:null, peak_pct:null, peak_time:null, lookback_days:30 };
    if (awrAvailable) {
      try {
        const hr = await conn.execute(`SELECT NULL, NULL, NULL FROM DUAL`);
        // Simplified: DBA_HIST_TBSPC_SPACE_USAGE join is temp-tablespace specific — returning null when not easy to isolate
        historical = { peak_gb: null, peak_pct: null, peak_time: null, lookback_days: 30 };
      } catch(e) {}
    }
    return { current, historical, awr_available: awrAvailable };
  } catch(err) {
    console.error('Temp stats query failed:', err.message);
    return { current:{ tablespace_name:'TEMP', total_gb:0, used_gb:0, free_gb:0, pct_used:0, top_sessions:[] }, historical:{ peak_gb:null, peak_pct:null, peak_time:null, lookback_days:30 }, awr_available: awrAvailable };
  }
}

async function queryAlertLog(conn) {
  try {
    const result = await conn.execute(`
      SELECT TO_CHAR(ORIGINATING_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS'), MESSAGE_TEXT
      FROM V$DIAG_ALERT_EXT
      WHERE ORIGINATING_TIMESTAMP > SYSDATE-1
        AND (MESSAGE_TEXT LIKE 'ORA-%' OR MESSAGE_TEXT LIKE '%checkpoint%'
             OR MESSAGE_TEXT LIKE '%corruption%' OR MESSAGE_TEXT LIKE '%recovery%'
             OR MESSAGE_TEXT LIKE '%error%' OR MESSAGE_TEXT LIKE '%warning%'
             OR MESSAGE_TEXT LIKE '%TNS-%' OR MESSAGE_TEXT LIKE '%instance%'
             OR MESSAGE_TEXT LIKE 'Thread%')
      ORDER BY ORIGINATING_TIMESTAMP DESC FETCH FIRST 200 ROWS ONLY
    `);
    const classified = (result.rows||[]).map(r => {
      const msg = (r[1]||'').trim();
      let severity = 'info';
      if (/ORA-600|ORA-7445|ORA-1578|ORA-04031|ORA-01555/.test(msg)) severity = 'critical';
      else if (/ORA-\d{4,5}/.test(msg)) severity = 'warning';
      else if (/checkpoint not complete|cannot allocate new log|block corruption|instance termination/.test(msg.toLowerCase())) severity = 'critical';
      else if (/checkpoint|redo log switch|archiv|TNS-1\d{4}/.test(msg.toLowerCase())) severity = 'warning';
      else if (/TNS-12560|TNS-12537|opiodr aborting|Fatal NI/.test(msg)) severity = 'noise';
      return { ts: r[0]||'', message: msg, severity };
    });
    const summary = { total: classified.length, critical: classified.filter(e=>e.severity==='critical').length, warning: classified.filter(e=>e.severity==='warning').length, info: classified.filter(e=>e.severity==='info').length, noise: classified.filter(e=>e.severity==='noise').length };
    return { entries: classified.slice(0,100), summary };
  } catch(err) {
    const msg = err.message || '';
    // V$DIAG_ALERT_EXT requires an explicit grant even with SELECT_CATALOG_ROLE
    const missingGrant = msg.includes('ORA-00942') || msg.includes('ORA-01031');
    const errorMsg = missingGrant
      ? 'Alert log access requires GRANT SELECT ON V_$DIAG_ALERT_EXT TO your_user'
      : msg;
    if (!missingGrant) console.error('Alert log query failed:', msg);
    return { entries:[], summary:{ total:0, critical:0, warning:0, info:0, noise:0 }, error: errorMsg };
  }
}

async function queryResourceLimits(conn, awrAvailable) {
  try {
    const currentResult = await conn.execute(`
      SELECT RESOURCE_NAME, CURRENT_UTILIZATION, MAX_UTILIZATION, INITIAL_ALLOCATION, LIMIT_VALUE
      FROM V$RESOURCE_LIMIT
      WHERE RESOURCE_NAME IN ('sessions','processes','enqueue_locks','enqueue_resources','dml_locks','temporary_table_locks','transactions','max_rollback_segments')
      ORDER BY CASE RESOURCE_NAME WHEN 'sessions' THEN 1 WHEN 'processes' THEN 2 WHEN 'transactions' THEN 3 WHEN 'enqueue_locks' THEN 4 ELSE 9 END
    `);
    const current = (currentResult.rows||[]).map(r => {
      const limitVal = r[4]==='UNLIMITED' ? null : (parseInt(r[4])||null);
      const maxUtil = parseInt(r[2])||0;
      const pctUsed = limitVal ? Math.round(maxUtil/limitVal*100) : null;
      return { resource:r[0]||'', current_utilization:parseInt(r[1])||0, max_utilization:maxUtil, initial_allocation:r[3]||'0', limit_value:limitVal, limit_display:r[4]||'0', pct_max_used:pctUsed, status: pctUsed!==null?(pctUsed>=90?'critical':pctUsed>=80?'warning':'ok'):'ok' };
    });
    let historical = {};
    if (awrAvailable) {
      try {
        const hr = await conn.execute(`
          SELECT RESOURCE_NAME, MAX(CURRENT_UTILIZATION), MAX(MAX_UTILIZATION)
          FROM DBA_HIST_RESOURCE_LIMIT
          WHERE SNAP_ID IN (SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT WHERE END_INTERVAL_TIME > SYSDATE-30)
          GROUP BY RESOURCE_NAME
        `);
        (hr.rows||[]).forEach(r => { historical[r[0]] = { hist_max:parseInt(r[1])||0, hist_peak:parseInt(r[2])||0 }; });
      } catch(e) {}
    }
    return { current, historical, awr_available: awrAvailable };
  } catch(err) {
    console.error('Resource limits query failed:', err.message);
    return { current:[], historical:{}, awr_available: awrAvailable };
  }
}

async function querySgaPgaHistory(conn, awrAvailable) {
  try {
    const paramResult = await conn.execute(`
      SELECT NAME, VALUE FROM V$PARAMETER
      WHERE NAME IN ('sga_target','pga_aggregate_target','sga_max_size','memory_target','memory_max_target')
    `);
    const params = {};
    (paramResult.rows||[]).forEach(r => { params[r[0]] = parseInt(r[1])||0; });
    const current = {
      sga_target_gb: Math.round((params['sga_target']||0)/1073741824*10)/10,
      pga_target_gb: Math.round((params['pga_aggregate_target']||0)/1073741824*10)/10,
      sga_max_gb: Math.round((params['sga_max_size']||0)/1073741824*10)/10,
      memory_target_gb: Math.round((params['memory_target']||0)/1073741824*10)/10
    };
    const resizeResult = await conn.execute(`
      SELECT TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI'), COMPONENT, OPER_TYPE,
             ROUND(INITIAL_SIZE/1073741824,2), ROUND(FINAL_SIZE/1073741824,2), STATUS
      FROM V$SGA_RESIZE_OPS ORDER BY START_TIME DESC FETCH FIRST 20 ROWS ONLY
    `).catch(() => ({ rows:[] }));
    const resizeOps = (resizeResult.rows||[]).map(r => ({ op_time:r[0]||'', component:r[1]||'', oper_type:r[2]||'', from_gb:parseFloat(r[3])||0, to_gb:parseFloat(r[4])||0, status:r[5]||'' }));
    let pgaHistory = { peak_allocated_gb:null, peak_time:null };
    let sgaComponentHistory = [];
    if (awrAvailable) {
      try {
        const pr = await conn.execute(`
          SELECT ROUND(MAX(VALUE)/1073741824,2), TO_CHAR(MAX(s.END_INTERVAL_TIME) KEEP (DENSE_RANK LAST ORDER BY p.VALUE),'YYYY-MM-DD HH24:MI')
          FROM DBA_HIST_PGASTAT p JOIN DBA_HIST_SNAPSHOT s ON s.SNAP_ID=p.SNAP_ID
          WHERE p.NAME='maximum PGA allocated' AND s.END_INTERVAL_TIME>SYSDATE-30
        `);
        const phr = (pr.rows||[[]])[0]||[];
        pgaHistory = { peak_allocated_gb:parseFloat(phr[0])||null, peak_time:phr[1]||null, lookback_days:30 };
      } catch(e) {}
      try {
        const sr = await conn.execute(`
          SELECT NAME, ROUND(MAX(VALUE)/1073741824,2), ROUND(MIN(VALUE)/1073741824,2)
          FROM DBA_HIST_SGA
          WHERE SNAP_ID IN (SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT WHERE END_INTERVAL_TIME>SYSDATE-30)
            AND NAME IN ('Database Buffers','Shared Pool Size','Large Pool Size','Java Pool Size')
          GROUP BY NAME
        `);
        sgaComponentHistory = (sr.rows||[]).map(r => ({ component:r[0]||'', peak_gb:parseFloat(r[1])||0, min_gb:parseFloat(r[2])||0 }));
      } catch(e) {}
    }
    return { current, resize_ops: resizeOps, pga_history: pgaHistory, sga_component_history: sgaComponentHistory, awr_available: awrAvailable };
  } catch(err) {
    console.error('SGA/PGA history query failed:', err.message);
    return { current:{ sga_target_gb:0, pga_target_gb:0, sga_max_gb:0, memory_target_gb:0 }, resize_ops:[], pga_history:{ peak_allocated_gb:null, peak_time:null }, sga_component_history:[], awr_available: awrAvailable };
  }
}

// ============================================================
// Wave B: Backup & Recovery Health Checks
// ============================================================

/**
 * Master function — runs all 4 backup checks and returns structured backup_stats.
 * Gracefully handles non-RMAN databases (all checks return null on failure).
 */
async function queryBackupStats(conn) {
  const [rmanBackup, fraUsage, archivelogRate, backupValidation] = await Promise.all([
    queryRmanBackup(conn),
    queryFraUsage(conn),
    queryArchivelogRate(conn),
    queryBackupValidation(conn)
  ]);

  // Compute overall backup status (worst of the 4 checks)
  const statuses = [rmanBackup, fraUsage, archivelogRate, backupValidation]
    .map(c => (c && c.status) || 'unknown');
  const overallStatus = statuses.includes('critical') ? 'critical'
    : statuses.includes('warning') ? 'warning'
    : statuses.every(s => s === 'ok') ? 'ok' : 'unknown';

  return { rman_backup: rmanBackup, fra_usage: fraUsage, archivelog_rate: archivelogRate, backup_validation: backupValidation, overall_status: overallStatus };
}

/**
 * Check 1: RMAN Backup Freshness
 * No full backup in >48h = critical | >24h = warning | <24h = ok
 */
async function queryRmanBackup(conn) {
  try {
    // Last backup job by type from V$RMAN_BACKUP_JOB_DETAILS
    const jobResult = await conn.execute(`
      SELECT
        INPUT_TYPE,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        ROUND((SYSDATE - END_TIME) * 24, 1) AS HOURS_AGO,
        ROUND(OUTPUT_BYTES / 1073741824, 2) AS SIZE_GB,
        ELAPSED_SECONDS
      FROM (
        SELECT INPUT_TYPE, STATUS, START_TIME, END_TIME, OUTPUT_BYTES, ELAPSED_SECONDS,
               ROW_NUMBER() OVER (PARTITION BY INPUT_TYPE ORDER BY END_TIME DESC) AS RN
        FROM V$RMAN_BACKUP_JOB_DETAILS
        WHERE STATUS = 'COMPLETED'
      )
      WHERE RN = 1
      ORDER BY
        CASE INPUT_TYPE WHEN 'DB FULL' THEN 1 WHEN 'DB INCR' THEN 2 WHEN 'ARCHIVELOG' THEN 3 ELSE 4 END
    `).catch(() => ({ rows: [] }));

    // Recent backup jobs (last 10 regardless of type)
    const recentResult = await conn.execute(`
      SELECT
        INPUT_TYPE,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        ROUND((SYSDATE - END_TIME) * 24, 1) AS HOURS_AGO,
        ROUND(OUTPUT_BYTES / 1073741824, 2) AS SIZE_GB,
        ELAPSED_SECONDS
      FROM V$RMAN_BACKUP_JOB_DETAILS
      ORDER BY START_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `).catch(() => ({ rows: [] }));

    const lastByType = (jobResult.rows || []).map(r => ({
      input_type: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      hours_ago: parseFloat(r[4]) || 0,
      size_gb: parseFloat(r[5]) || 0,
      elapsed_seconds: parseInt(r[6]) || 0
    }));

    const recentJobs = (recentResult.rows || []).map(r => ({
      input_type: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      hours_ago: parseFloat(r[4]) || 0,
      size_gb: parseFloat(r[5]) || 0,
      elapsed_seconds: parseInt(r[6]) || 0
    }));

    // Find last full backup age
    const fullBackup = lastByType.find(b => b.input_type === 'DB FULL');
    const incrBackup = lastByType.find(b => b.input_type === 'DB INCR');
    const archBackup = lastByType.find(b => b.input_type === 'ARCHIVELOG');

    const fullHoursAgo = fullBackup ? fullBackup.hours_ago : null;
    let status = 'unknown';
    if (recentJobs.length === 0 && lastByType.length === 0) {
      status = 'unknown'; // No RMAN usage detected
    } else if (fullHoursAgo === null) {
      status = 'critical'; // No full backup ever
    } else if (fullHoursAgo > 48) {
      status = 'critical';
    } else if (fullHoursAgo > 24) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      rman_available: recentJobs.length > 0 || lastByType.length > 0,
      last_by_type: lastByType,
      recent_jobs: recentJobs,
      full_backup_hours_ago: fullHoursAgo,
      last_full_backup: fullBackup || null,
      last_incremental_backup: incrBackup || null,
      last_archivelog_backup: archBackup || null
    };
  } catch (err) {
    console.error('RMAN backup query failed:', err.message);
    return { status: 'unknown', rman_available: false, last_by_type: [], recent_jobs: [], error: err.message };
  }
}

/**
 * Check 2: Fast Recovery Area (FRA) Usage
 * >90% used AND <10% reclaimable = critical | >80% = warning | <80% = ok
 */
async function queryFraUsage(conn) {
  try {
    // FRA overview from V$RECOVERY_FILE_DEST
    const destResult = await conn.execute(`
      SELECT
        NAME,
        ROUND(SPACE_LIMIT / 1073741824, 2) AS LIMIT_GB,
        ROUND(SPACE_USED / 1073741824, 2) AS USED_GB,
        ROUND(SPACE_RECLAIMABLE / 1073741824, 2) AS RECLAIMABLE_GB,
        NUMBER_OF_FILES
      FROM V$RECOVERY_FILE_DEST
    `).catch(() => ({ rows: [] }));

    // Breakdown by file type from V$FLASH_RECOVERY_AREA_USAGE
    const usageResult = await conn.execute(`
      SELECT
        FILE_TYPE,
        ROUND(PERCENT_SPACE_USED, 1) AS PCT_USED,
        ROUND(PERCENT_SPACE_RECLAIMABLE, 1) AS PCT_RECLAIMABLE,
        NUMBER_OF_FILES
      FROM V$FLASH_RECOVERY_AREA_USAGE
      ORDER BY PERCENT_SPACE_USED DESC
    `).catch(() => ({ rows: [] }));

    // Archivelog generation rate (last 24h) for "hours until full" prediction
    const genRateResult = await conn.execute(`
      SELECT
        ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1073741824, 2) AS ARCHIVELOGS_24H_GB
      FROM V$ARCHIVED_LOG
      WHERE COMPLETION_TIME > SYSDATE - 1
        AND STANDBY_DEST = 'NO'
    `).catch(() => ({ rows: [[0]] }));

    const destRow = (destResult.rows || [[]])[0] || [];
    const limitGb = parseFloat(destRow[1]) || 0;
    const usedGb = parseFloat(destRow[2]) || 0;
    const reclaimableGb = parseFloat(destRow[3]) || 0;
    const fraLocation = destRow[0] || '';

    const pctUsed = limitGb > 0 ? Math.round((usedGb / limitGb) * 1000) / 10 : 0;
    const pctReclaimable = limitGb > 0 ? Math.round((reclaimableGb / limitGb) * 1000) / 10 : 0;
    const archivelogs24hGb = parseFloat((genRateResult.rows || [[0]])[0]?.[0]) || 0;

    // Hours until FRA full: (limitGb - usedGb + reclaimableGb) / hourly_rate
    const availableGb = limitGb - usedGb + reclaimableGb;
    const hourlyRateGb = archivelogs24hGb / 24;
    const hoursUntilFull = (hourlyRateGb > 0 && limitGb > 0)
      ? Math.round(availableGb / hourlyRateGb)
      : null;

    const fileTypeBreakdown = (usageResult.rows || []).map(r => ({
      file_type: r[0] || '',
      pct_used: parseFloat(r[1]) || 0,
      pct_reclaimable: parseFloat(r[2]) || 0,
      number_of_files: parseInt(r[3]) || 0
    }));

    let status = 'unknown';
    if (limitGb === 0) {
      status = 'unknown'; // FRA not configured
    } else if (pctUsed > 90 && pctReclaimable < 10) {
      status = 'critical';
    } else if (pctUsed > 80) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      fra_configured: limitGb > 0,
      location: fraLocation,
      limit_gb: limitGb,
      used_gb: usedGb,
      reclaimable_gb: reclaimableGb,
      pct_used: pctUsed,
      pct_reclaimable: pctReclaimable,
      archivelogs_24h_gb: archivelogs24hGb,
      hours_until_full: hoursUntilFull,
      file_type_breakdown: fileTypeBreakdown
    };
  } catch (err) {
    console.error('FRA usage query failed:', err.message);
    return { status: 'unknown', fra_configured: false, error: err.message };
  }
}

/**
 * Check 3: Archivelog Generation Rate
 * Not in archivelog mode = critical | switch frequency >20/hour = warning | otherwise = ok
 */
async function queryArchivelogRate(conn) {
  try {
    // Archivelog mode + current sequence
    const modeResult = await conn.execute(`
      SELECT
        LOG_MODE,
        ROUND((SYSDATE - STARTUP_TIME) * 24) AS HOURS_UP
      FROM V$DATABASE, V$INSTANCE
    `).catch(() => ({ rows: [['ARCHIVELOG', 0]] }));

    // Recent archivelog generation (last 24h)
    const archResult = await conn.execute(`
      SELECT
        TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24') AS HOUR,
        COUNT(*) AS LOG_COUNT,
        ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1048576, 1) AS SIZE_MB
      FROM V$ARCHIVED_LOG
      WHERE COMPLETION_TIME > SYSDATE - 1
        AND STANDBY_DEST = 'NO'
      GROUP BY TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24')
      ORDER BY HOUR DESC
    `).catch(() => ({ rows: [] }));

    // Redo log groups and sizes
    const logResult = await conn.execute(`
      SELECT
        l.GROUP#,
        l.MEMBERS,
        ROUND(l.BYTES / 1048576, 0) AS SIZE_MB,
        l.STATUS,
        l.ARCHIVED
      FROM V$LOG l
      ORDER BY l.GROUP#
    `).catch(() => ({ rows: [] }));

    // Log switch frequency from V$LOG_HISTORY (last 24h)
    const switchResult = await conn.execute(`
      SELECT
        ROUND(COUNT(*) / 24.0, 1) AS SWITCHES_PER_HOUR,
        COUNT(*) AS SWITCHES_24H
      FROM V$LOG_HISTORY
      WHERE FIRST_TIME > SYSDATE - 1
    `).catch(() => ({ rows: [[0, 0]] }));

    const modeRow = (modeResult.rows || [['ARCHIVELOG', 0]])[0] || ['ARCHIVELOG', 0];
    const logMode = modeRow[0] || 'ARCHIVELOG';

    const archHourly = (archResult.rows || []).map(r => ({
      hour: r[0] || '',
      log_count: parseInt(r[1]) || 0,
      size_mb: parseFloat(r[2]) || 0
    }));

    const logGroups = (logResult.rows || []).map(r => ({
      group_num: parseInt(r[0]) || 0,
      members: parseInt(r[1]) || 0,
      size_mb: parseInt(r[2]) || 0,
      status: r[3] || '',
      archived: r[4] || ''
    }));

    const switchRow = (switchResult.rows || [[0, 0]])[0] || [0, 0];
    const switchesPerHour = parseFloat(switchRow[0]) || 0;
    const switches24h = parseInt(switchRow[1]) || 0;

    const totalArchivelogs24h = archHourly.reduce((sum, h) => sum + h.log_count, 0);
    const totalSizeMb24h = archHourly.reduce((sum, h) => sum + h.size_mb, 0);

    let status = 'ok';
    if (logMode !== 'ARCHIVELOG') {
      status = 'critical'; // Not in archivelog mode
    } else if (switchesPerHour > 20) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      log_mode: logMode,
      archivelog_mode: logMode === 'ARCHIVELOG',
      switches_per_hour: switchesPerHour,
      switches_24h: switches24h,
      archivelogs_24h: totalArchivelogs24h,
      total_size_mb_24h: totalSizeMb24h,
      hourly_breakdown: archHourly.slice(0, 24),
      log_groups: logGroups
    };
  } catch (err) {
    console.error('Archivelog rate query failed:', err.message);
    return { status: 'unknown', archivelog_mode: null, error: err.message };
  }
}

/**
 * Check 4: Backup Validation
 * Corruption found or last 3 RMAN jobs failed = critical
 */
async function queryBackupValidation(conn) {
  try {
    // Recent RMAN operations from V$RMAN_STATUS
    const rmanStatusResult = await conn.execute(`
      SELECT
        OPERATION,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        MBYTES_PROCESSED,
        OUTPUT
      FROM V$RMAN_STATUS
      WHERE OPERATION IN ('BACKUP', 'RESTORE', 'RECOVER', 'DELETE', 'VALIDATE')
        AND START_TIME > SYSDATE - 7
      ORDER BY START_TIME DESC
      FETCH FIRST 20 ROWS ONLY
    `).catch(() => ({ rows: [] }));

    // Backup corruption from V$BACKUP_CORRUPTION
    const backupCorrResult = await conn.execute(`
      SELECT
        COUNT(*) AS CORRUPT_COUNT,
        SUM(BLOCKS) AS CORRUPT_BLOCKS
      FROM V$BACKUP_CORRUPTION
    `).catch(() => ({ rows: [[0, 0]] }));

    // Copy corruption from V$COPY_CORRUPTION
    const copyCorrResult = await conn.execute(`
      SELECT
        COUNT(*) AS CORRUPT_COUNT,
        SUM(BLOCKS) AS CORRUPT_BLOCKS
      FROM V$COPY_CORRUPTION
    `).catch(() => ({ rows: [[0, 0]] }));

    const rmanOps = (rmanStatusResult.rows || []).map(r => ({
      operation: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      mbytes_processed: parseFloat(r[4]) || 0,
      output: (r[5] || '').substring(0, 300)
    }));

    const backupCorrupt = parseInt((backupCorrResult.rows || [[0]])[0]?.[0]) || 0;
    const backupCorruptBlocks = parseInt((backupCorrResult.rows || [[0, 0]])[0]?.[1]) || 0;
    const copyCorrupt = parseInt((copyCorrResult.rows || [[0]])[0]?.[0]) || 0;
    const copyCorruptBlocks = parseInt((copyCorrResult.rows || [[0, 0]])[0]?.[1]) || 0;
    const totalCorruptions = backupCorrupt + copyCorrupt;

    // Check last 3 RMAN backup jobs
    const recentBackups = rmanOps.filter(op => op.operation === 'BACKUP').slice(0, 3);
    const last3Failed = recentBackups.length > 0 && recentBackups.every(b => b.status === 'FAILED');

    let status = 'ok';
    if (totalCorruptions > 0) {
      status = 'critical';
    } else if (last3Failed) {
      status = 'critical';
    } else if (recentBackups.some(b => b.status === 'FAILED')) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      backup_corruptions: backupCorrupt,
      backup_corrupt_blocks: backupCorruptBlocks,
      copy_corruptions: copyCorrupt,
      copy_corrupt_blocks: copyCorruptBlocks,
      total_corruptions: totalCorruptions,
      recent_operations: rmanOps,
      last_3_backups_failed: last3Failed
    };
  } catch (err) {
    console.error('Backup validation query failed:', err.message);
    return { status: 'unknown', total_corruptions: 0, error: err.message };
  }
}

// ============================================================
// Wave E: EBS Apps Health Checks
// All EBS tables schema-qualified with APPS. for SYSTEM user
// ============================================================

async function queryAppsHealth(conn) {
  try {
    // EBS detection
    const ebsDetect = await conn.execute(
      `SELECT COUNT(*) FROM APPS.FND_APPLICATION WHERE ROWNUM = 1`
    ).catch(() => null);
    if (!ebsDetect) return null;

    const [cmResult, requestResult, oppResult, wfComponentsResult, stuckNotifResult, wfErrorResult] = await Promise.all([
      // ── Concurrent Manager queues (verified against EBS 12.2.12) ──
      conn.execute(`
        SELECT DISTINCT
          b.user_concurrent_queue_name AS manager_name,
          a.target_node               AS node,
          a.running_processes          AS actual_procs,
          a.max_processes              AS target_procs,
          DECODE(b.control_code,
            'D', 'Deactivating',
            'E', 'Deactivated',
            'N', 'Node unavai',
            'A', 'Activating',
            'X', 'Terminated',
            'T', 'Terminating',
            'V', 'Verifying',
            'O', 'Suspending',
            'P', 'Suspended',
            'Q', 'Resuming',
            'R', 'Restarting',
            'Running')                 AS status_label
        FROM apps.fnd_concurrent_queues     a,
             apps.fnd_concurrent_queues_vl  b
        WHERE a.concurrent_queue_id = b.concurrent_queue_id
          AND a.max_processes != 0
        ORDER BY a.max_processes DESC
      `).catch(() => ({ rows: [] })),

      // Pending / running request counts
      conn.execute(`
        SELECT PHASE_CODE, COUNT(*) FROM APPS.FND_CONCURRENT_REQUESTS
        WHERE PHASE_CODE IN ('P','R') AND HOLD_FLAG = 'N' GROUP BY PHASE_CODE
      `).catch(() => ({ rows: [] })),

      // ── OPP (dedicated query) ──────────────────────────────────────
      conn.execute(`
        SELECT b.user_concurrent_queue_name AS manager_name,
               a.running_processes          AS actual,
               a.max_processes              AS target
        FROM apps.fnd_concurrent_queues    a,
             apps.fnd_concurrent_queues_vl b
        WHERE a.concurrent_queue_id = b.concurrent_queue_id
          AND a.concurrent_queue_name = 'FNDCPOPP'
      `).catch(() => ({ rows: [] })),

      // ── All Workflow components (WF% types, all 13 components) ──
      conn.execute(`
        SELECT component_type, component_name, component_status, startup_mode
        FROM apps.fnd_svc_components
        WHERE component_type LIKE 'WF%'
        ORDER BY 1, 2
      `).catch(() => ({ rows: [] })),

      conn.execute(`
        SELECT COUNT(*) FROM APPS.WF_NOTIFICATIONS
        WHERE STATUS = 'OPEN' AND MAIL_STATUS = 'MAIL' AND BEGIN_DATE < SYSDATE - 1/24
      `).catch(() => ({ rows: [[0]] })),

      conn.execute(`SELECT COUNT(*) FROM APPS.WF_ERROR`).catch(() => ({ rows: [[0]] }))
    ]);

    // Process managers (new query: [name, node, actual, target, status_label])
    const managers = (cmResult.rows || []).map(r => ({
      display_name: r[0] || '', node: r[1] || '',
      actual: parseInt(r[2]) || 0, target: parseInt(r[3]) || 0,
      status_label: r[4] || 'Running'
    }));

    const icm = managers.find(m =>
      (m.display_name || '').toLowerCase().includes('internal concurrent manager')
    );

    let pendingCount = 0, runningCount = 0;
    (requestResult.rows || []).forEach(r => {
      if (r[0] === 'P') pendingCount = parseInt(r[1]) || 0;
      if (r[0] === 'R') runningCount = parseInt(r[1]) || 0;
    });

    const icmDown = !icm || (icm.actual === 0 && icm.target > 0);
    let cmStatus = icmDown ? 'critical' : 'ok';
    if (!icmDown) {
      const underStaffed = managers.some(m => m.target > 0 && m.actual < m.target);
      if (underStaffed || pendingCount > 50) cmStatus = 'warning';
    }

    // OPP (dedicated query result)
    const oppRows = oppResult.rows || [];
    const oppActual = oppRows.length > 0 ? parseInt(oppRows[0][1]) || 0 : 0;
    const oppTarget = oppRows.length > 0 ? parseInt(oppRows[0][2]) || 0 : 0;
    const oppData = {
      manager_name: oppRows.length > 0 ? (oppRows[0][0] || 'Output Post Processor') : 'Output Post Processor',
      actual: oppActual, target: oppTarget,
      status: oppActual === 0 && oppTarget > 0 ? 'critical' : oppActual < oppTarget ? 'warning' : 'ok',
      recommendation: oppActual === 0 && oppTarget > 0
        ? 'OPP is not running — PDF/output generation will fail. Start OPP from the CM admin page.'
        : oppActual < oppTarget
          ? `OPP has ${oppActual}/${oppTarget} processes running — throughput may be degraded.`
          : `OPP healthy: ${oppActual}/${oppTarget} process(es) running.`
    };

    // Workflow (all WF% components)
    const wfServices = (wfComponentsResult.rows || []).map(r => ({
      type: r[0] || '', name: r[1] || '',
      status: r[2] || 'UNKNOWN', startup_mode: r[3] || ''
    }));
    const mailer = wfServices.find(s =>
      s.type === 'WF_MAILER' || (s.name || '').toLowerCase().includes('mailer')
    );
    const mailerRunning = !!(mailer && mailer.status === 'RUNNING');
    const stuckNotif = parseInt((stuckNotifResult.rows || [[0]])[0]?.[0]) || 0;
    const wfErrCount = parseInt((wfErrorResult.rows || [[0]])[0]?.[0]) || 0;

    const criticalComps = wfServices.filter(s => s.status === 'DEACTIVATED_SYSTEM' || s.status === 'STOPPED');
    const warningComps = wfServices.filter(s => s.status !== 'RUNNING' && s.status !== 'DEACTIVATED_SYSTEM' && s.status !== 'STOPPED');

    let wfStatus = 'ok';
    if (mailer && !mailerRunning)               wfStatus = 'critical';
    else if (criticalComps.length > 0)         wfStatus = 'critical';
    else if (stuckNotif > 50 || wfErrCount > 20) wfStatus = 'critical';
    else if (warningComps.length > 0 || stuckNotif > 5 || wfErrCount > 0) wfStatus = 'warning';

    // Overall
    const statuses = [cmStatus, wfStatus, oppData.status];
    const overallStatus = statuses.includes('critical') ? 'critical' : statuses.includes('warning') ? 'warning' : 'ok';

    // ── Wave F: APPS_ENV and ADOP_STATUS ────────────────────────
    const appsEnvResult = await queryAppsEnv(conn);
    const adopResult    = await queryAdopStatus();

    // Fold new check statuses into overall
    const allStatuses = [cmStatus, wfStatus, oppData.status, appsEnvResult.status, adopResult.status];
    const newOverall  = allStatuses.includes('critical') ? 'critical'
                      : allStatuses.includes('warning')  ? 'warning'
                      : 'ok';

    return {
      is_ebs: true, status: newOverall,
      concurrent_managers: { status: cmStatus, icm_down: icmDown, managers, pending_requests: pendingCount, running_requests: runningCount },
      opp: oppData,
      workflow: { status: wfStatus, mailer_running: mailerRunning, mailer_component: mailer || null, services: wfServices, stuck_notifications: stuckNotif, error_count: wfErrCount },
      apps_env: appsEnvResult,
      adop_status: adopResult
    };
  } catch (err) {
    console.error('EBS apps health query failed:', err.message);
    return null;
  }
}

// ============================================================
// Wave F: APPS_ENV Check
// Query EBS environment variables from the database and (when
// the proxy runs on the app tier) from the OS environment.
// ============================================================

/**
 * APPS_ENV — display key EBS Apps environment variables.
 *
 * Sources (highest to lowest priority):
 *  1. OS environment (proxy runs on app tier — variables set by
 *     sourcing the EBS context file, e.g. CONTEXT_FILE, INST_TOP …)
 *  2. FND_PROFILE_OPTION_VALUES for DB-accessible profile options
 *     (e.g. APPS_JDBC_URL stored in FND_OAM_METVAL)
 *
 * Returns check_id, status, severity, message, and a display object
 * with columns/rows for table rendering in the UI.
 */
async function queryAppsEnv(conn) {
  const CRITICAL_VARS = [
    'CONTEXT_FILE',
    'INST_TOP',
    'COMMON_TOP',
    'ADMIN_SCRIPTS_HOME'
  ];

  const ALL_VARS = [
    'CONTEXT_FILE',
    'ADMIN_SCRIPTS_HOME',
    'INST_TOP',
    'COMMON_TOP',
    'FMW_HOME',
    'EBS_DOMAIN_HOME',
    'APPS_JDBC_URL',
    'TWO_TASK',
    'ORACLE_HOME',
    'ORACLE_SID',
    'TNS_ADMIN'
  ];

  // Step 1: read from OS environment (available when proxy runs on EBS app tier)
  const envVars = {};
  for (const v of ALL_VARS) {
    const val = process.env[v];
    if (val !== undefined) envVars[v] = val;
  }

  // Step 2: supplement missing vars from Oracle DB where possible
  try {
    // APPS_JDBC_URL: stored in FND_OAM_METVAL (EBS 12.2+) under key 'APPS_JDBC_URL'
    const jdbcResult = await conn.execute(
      `SELECT METVAL_CLOB FROM APPS.FND_OAM_METVAL WHERE METNAME = 'APPS_JDBC_URL' AND ROWNUM = 1`
    ).catch(() => null);
    if (jdbcResult && jdbcResult.rows && jdbcResult.rows[0] && !envVars['APPS_JDBC_URL']) {
      envVars['APPS_JDBC_URL'] = String(jdbcResult.rows[0][0] || '').substring(0, 200);
    }
  } catch (e) { /* non-fatal */ }

  try {
    // TNS_ADMIN: read from v$parameter (LOCAL_LISTENER or similar) as a heuristic
    const tnsResult = await conn.execute(
      `SELECT VALUE FROM v$parameter WHERE name = 'tns_admin' AND ROWNUM = 1`
    ).catch(() => null);
    if (tnsResult && tnsResult.rows && tnsResult.rows[0] && !envVars['TNS_ADMIN']) {
      const val = String(tnsResult.rows[0][0] || '');
      if (val) envVars['TNS_ADMIN'] = val;
    }
  } catch (e) { /* non-fatal */ }

  try {
    // ORACLE_SID: from v$instance
    const sidResult = await conn.execute(`SELECT INSTANCE_NAME FROM v$instance`).catch(() => null);
    if (sidResult && sidResult.rows && sidResult.rows[0] && !envVars['ORACLE_SID']) {
      envVars['ORACLE_SID'] = String(sidResult.rows[0][0] || '');
    }
  } catch (e) { /* non-fatal */ }

  // Step 3: build rows
  const rows = ALL_VARS.map(v => {
    const val = envVars[v];
    const present = val !== undefined && val !== '';
    const isCritical = CRITICAL_VARS.includes(v);
    return {
      variable: v,
      value: present ? val : null,
      state: present ? 'OK' : 'MISSING',
      critical: isCritical
    };
  });

  // Step 4: compute status
  const missingCritical = rows.filter(r => r.critical && r.state === 'MISSING');
  const missingAny      = rows.filter(r => r.state === 'MISSING');

  let status, message;
  if (missingCritical.length > 0) {
    status  = 'critical';
    message = `${missingCritical.length} critical EBS env var(s) missing: ${missingCritical.map(r => r.variable).join(', ')}`;
  } else if (missingAny.length > 0) {
    status  = 'warning';
    message = `${missingAny.length} EBS env var(s) not detected (non-critical): ${missingAny.map(r => r.variable).join(', ')}`;
  } else {
    status  = 'ok';
    message = `All ${rows.length} EBS environment variables are present.`;
  }

  return {
    check_id: 'APPS_ENV',
    status,
    severity: missingCritical.length > 0 ? 'critical' : missingAny.length > 0 ? 'warning' : 'ok',
    message,
    os_env_available: Object.keys(envVars).some(k => process.env[k] !== undefined),
    display: {
      columns: ['Variable', 'State', 'Value'],
      rows: rows.map(r => [r.variable, r.state, r.value ? r.value.substring(0, 120) : '—'])
    },
    variables: rows
  };
}

// ============================================================
// Wave F: ADOP_STATUS Check
// Run `adop -status -detail` on the OS (proxy runs on EBS server)
// and parse Session ID, Node, Phase, Status.
// SKIP if APPS_PWD not available in environment.
// ============================================================

/**
 * ADOP_STATUS — run adop patching utility status check.
 *
 * Requirements:
 *  - Proxy runs on EBS app tier
 *  - APPS_PWD set in environment (used to pass credentials non-interactively)
 *  - adop utility on PATH (or ADMIN_SCRIPTS_HOME in environment)
 *
 * Parsing targets:
 *  Session ID, Node, Phase, Status
 *
 * Returns check_id, status, severity, message, display (columns + rows).
 */
async function queryAdopStatus() {
  // Locate adop binary
  const adminScriptsHome = process.env.ADMIN_SCRIPTS_HOME || '';
  const adopBin = adminScriptsHome ? `${adminScriptsHome}/adop` : 'adop';

  // If APPS_PWD not in environment, return an actionable warning instead of silently skipping.
  // This surfaces the missing config to the user in the dashboard rather than hiding it.
  const appsPwd = process.env.APPS_PWD || process.env.APPS_PASSWORD || '';
  if (!appsPwd) {
    return {
      check_id:   'ADOP_STATUS',
      status:     'warning',
      severity:   'warning',
      message:    'Set APPS_PWD in proxy.env to enable ADOP patching session detection. See setup guide: https://tunevault.app/docs#proxy-setup',
      display:    { columns: ['Field', 'Value'], rows: [['Action Required', 'Add APPS_PWD=<apps_password> to your proxy.env file and restart the proxy service to enable ADOP patch session monitoring.']] },
      sessions:   []
    };
  }

  return new Promise(resolve => {
    const TIMEOUT_MS = 30000;
    const env = Object.assign({}, process.env, { APPS_PWD: appsPwd });

    const proc = execFile(
      adopBin,
      ['-status', '-detail'],
      { env, timeout: TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve({
            check_id: 'ADOP_STATUS',
            status:   'warning',
            severity: 'warning',
            message:  `adop -status timed out after ${TIMEOUT_MS / 1000}s.`,
            display:  { columns: ['Field', 'Value'], rows: [['Status', 'TIMEOUT']] },
            sessions: []
          });
          return;
        }
        if (err && !stdout) {
          // adop not installed or not on PATH
          const msg = (err.message || '').substring(0, 200);
          resolve({
            check_id: 'ADOP_STATUS',
            status:   'warning',
            severity: 'warning',
            message:  `adop command failed: ${msg}`,
            display:  { columns: ['Field', 'Value'], rows: [['Error', msg]] },
            sessions: []
          });
          return;
        }

        // Parse the output
        const output = (stdout || '') + (stderr || '');
        const sessions = parseAdopOutput(output);

        // Determine status
        const failedSessions = sessions.filter(s => (s.status || '').toUpperCase() === 'FAILED');
        const activeSessions  = sessions.filter(s => ['INPROGRESS', 'IN_PROGRESS', 'RUNNING', 'ACTIVE'].includes((s.status || '').toUpperCase()));

        let status, message;
        if (sessions.length === 0) {
          status  = 'ok';
          message = 'No ADOP sessions found — no active or recent patching activity.';
        } else if (failedSessions.length > 0) {
          status  = 'critical';
          message = `${failedSessions.length} ADOP session(s) in FAILED state. Review and clean up before next patch cycle.`;
        } else if (activeSessions.length > 0) {
          status  = 'warning';
          message = `${activeSessions.length} ADOP patching session(s) currently active.`;
        } else {
          status  = 'ok';
          message = `ADOP: ${sessions.length} historical session(s) found, none in FAILED state.`;
        }

        resolve({
          check_id: 'ADOP_STATUS',
          status,
          severity: failedSessions.length > 0 ? 'critical' : activeSessions.length > 0 ? 'warning' : 'ok',
          message,
          display: {
            columns: ['Session ID', 'Node', 'Phase', 'Status'],
            rows: sessions.map(s => [s.session_id || '—', s.node || '—', s.phase || '—', s.status || '—'])
          },
          sessions,
          raw_output: output.substring(0, 2000)
        });
      }
    );

    // Safety net — execFile timeout param above should handle it, but belt-and-suspenders
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    }, TIMEOUT_MS + 1000);
  });
}

/**
 * Parse `adop -status -detail` output.
 *
 * Typical output block per session:
 *   SESSION ID   : 42
 *   NODE         : ebsapp01
 *   PHASE        : FINALIZE
 *   STATUS       : SUCCESS
 *
 * Returns array of { session_id, node, phase, status }.
 */
function parseAdopOutput(text) {
  const sessions = [];
  // Split by blank lines to separate session blocks
  const blocks = text.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const session = {};

    for (const line of lines) {
      const m = line.match(/^(SESSION\s*ID|NODE|PHASE|STATUS)\s*[:\-]\s*(.+)/i);
      if (m) {
        const key   = m[1].trim().toLowerCase().replace(/\s+/, '_');
        const value = m[2].trim();
        if (key === 'session_id') session.session_id = value;
        else if (key === 'node')  session.node       = value;
        else if (key === 'phase') session.phase      = value;
        else if (key === 'status') session.status    = value;
      }
    }

    // Only include blocks that look like adop session entries
    if (session.session_id || session.phase || session.status) {
      sessions.push(session);
    }
  }

  return sessions;
}

// ============================================================
// Wave G: Database Objects & Session Stats (OB03, OB04, OB06, OB07, OB09, OB12)
// ============================================================

/**
 * queryDbObjects — collects invalid objects, stale stats, SCN headroom, SPFILE status.
 * All queries are read-only against SYS-visible views.
 */
async function queryDbObjects(conn) {
  try {
    const EXCLUDED_OWNERS = `'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS','APPQOSSYS','DBSFWUSER','OJVMSYS','DVSYS','LBACSYS'`;

    const [invalidR, staleR, scnR, spfileR, recycleR, controlR] = await Promise.all([
      // Invalid objects count
      conn.execute(`
        SELECT COUNT(*) AS invalid_count,
               COUNT(CASE WHEN OBJECT_TYPE IN ('PACKAGE BODY','PACKAGE') THEN 1 END) AS invalid_packages,
               COUNT(CASE WHEN OBJECT_TYPE = 'PROCEDURE' THEN 1 END) AS invalid_procedures,
               COUNT(CASE WHEN OBJECT_TYPE = 'VIEW' THEN 1 END) AS invalid_views,
               COUNT(CASE WHEN OBJECT_TYPE = 'TRIGGER' THEN 1 END) AS invalid_triggers
        FROM DBA_OBJECTS
        WHERE STATUS = 'INVALID'
          AND OWNER NOT IN (${EXCLUDED_OWNERS})
      `).catch(() => ({ rows: [[0,0,0,0,0]] })),

      // Stale statistics count
      conn.execute(`
        SELECT COUNT(*) AS stale_count,
               COUNT(CASE WHEN LAST_ANALYZED IS NULL THEN 1 END) AS never_analyzed
        FROM DBA_TAB_STATISTICS
        WHERE STALE_STATS = 'YES'
          AND OWNER NOT IN (${EXCLUDED_OWNERS})
      `).catch(() => ({ rows: [[0,0]] })),

      // SCN headroom (days remaining)
      conn.execute(`
        SELECT CURRENT_SCN,
               ROUND((TO_NUMBER(SYSDATE - TO_DATE('01-01-1988','DD-MM-YYYY')) * 24 * 3600 * 16384 * 1024 - CURRENT_SCN) / (24*3600*16384), 0) AS days_remaining
        FROM V$DATABASE
      `).catch(() => ({ rows: [[null, null]] })),

      // SPFILE in use
      conn.execute(`
        SELECT DECODE(COUNT(*),0,'PFILE','SPFILE') AS param_file_type
        FROM V$PARAMETER
        WHERE NAME = 'spfile' AND VALUE IS NOT NULL
      `).catch(() => ({ rows: [['UNKNOWN']] })),

      // Recycle bin size
      conn.execute(`
        SELECT COUNT(*) AS object_count, ROUND(SUM(SPACE)*8192/1073741824, 2) AS size_gb
        FROM DBA_RECYCLEBIN
      `).catch(() => ({ rows: [[0, 0]] })),

      // Control file count
      conn.execute(`
        SELECT COUNT(*) AS controlfile_count,
               SUM(CASE WHEN STATUS IS NOT NULL AND STATUS != '' THEN 1 ELSE 0 END) AS invalid_count
        FROM V$CONTROLFILE
      `).catch(() => ({ rows: [[0, 0]] }))
    ]);

    const invalidRow = (invalidR.rows || [[0,0,0,0,0]])[0] || [0,0,0,0,0];
    const staleRow   = (staleR.rows || [[0,0]])[0] || [0,0];
    const scnRow     = (scnR.rows || [[null,null]])[0] || [null,null];
    const spfileRow  = (spfileR.rows || [['UNKNOWN']])[0] || ['UNKNOWN'];
    const recycleRow = (recycleR.rows || [[0,0]])[0] || [0,0];
    const ctrlRow    = (controlR.rows || [[0,0]])[0] || [0,0];

    return {
      invalid_objects: {
        count: parseInt(invalidRow[0]) || 0,
        packages: parseInt(invalidRow[1]) || 0,
        procedures: parseInt(invalidRow[2]) || 0,
        views: parseInt(invalidRow[3]) || 0,
        triggers: parseInt(invalidRow[4]) || 0
      },
      stale_stats: {
        stale_count: parseInt(staleRow[0]) || 0,
        never_analyzed: parseInt(staleRow[1]) || 0
      },
      scn_headroom: {
        current_scn: parseInt(scnRow[0]) || null,
        days_remaining: parseInt(scnRow[1]) || null
      },
      spfile: {
        param_file_type: String(spfileRow[0] || 'UNKNOWN'),
        using_spfile: String(spfileRow[0] || '') === 'SPFILE'
      },
      recyclebin: {
        object_count: parseInt(recycleRow[0]) || 0,
        size_gb: parseFloat(recycleRow[1]) || 0
      },
      controlfiles: {
        count: parseInt(ctrlRow[0]) || 0,
        invalid_count: parseInt(ctrlRow[1]) || 0
      }
    };
  } catch (err) {
    console.error('DB objects query failed:', err.message);
    return {
      invalid_objects: { count: 0, packages: 0, procedures: 0, views: 0, triggers: 0 },
      stale_stats: { stale_count: 0, never_analyzed: 0 },
      scn_headroom: { current_scn: null, days_remaining: null },
      spfile: { param_file_type: 'UNKNOWN', using_spfile: false },
      recyclebin: { object_count: 0, size_gb: 0 },
      controlfiles: { count: 0, invalid_count: 0 }
    };
  }
}

/**
 * querySessionStats — active/blocked session counts, long-running SQL.
 * Covers OB06_BLOCKING_LOCKS, OB07_LISTENER_SESSIONS, PF09_LONG_RUNNING_SQL.
 */
async function querySessionStats(conn) {
  try {
    const [sessionR, blockedR, longSqlR] = await Promise.all([
      // Active user sessions
      conn.execute(`
        SELECT
          COUNT(*) AS total_sessions,
          COUNT(CASE WHEN STATUS = 'ACTIVE' AND TYPE = 'USER' THEN 1 END) AS active_sessions,
          COUNT(CASE WHEN TYPE = 'USER' THEN 1 END) AS user_sessions
        FROM V$SESSION
      `).catch(() => ({ rows: [[0,0,0]] })),

      // Blocked sessions
      conn.execute(`
        SELECT COUNT(*) AS blocked_count
        FROM V$SESSION
        WHERE BLOCKING_SESSION IS NOT NULL AND STATUS = 'ACTIVE'
      `).catch(() => ({ rows: [[0]] })),

      // Long-running SQL (>5 minutes)
      conn.execute(`
        SELECT COUNT(*) AS long_running_count,
               ROUND(MAX((SYSDATE - SQL_EXEC_START) * 1440), 1) AS max_runtime_min
        FROM V$SESSION
        WHERE STATUS = 'ACTIVE'
          AND TYPE = 'USER'
          AND SQL_EXEC_START IS NOT NULL
          AND (SYSDATE - SQL_EXEC_START) * 1440 > 5
      `).catch(() => ({ rows: [[0, 0]] }))
    ]);

    const sessRow   = (sessionR.rows || [[0,0,0]])[0] || [0,0,0];
    const blockRow  = (blockedR.rows || [[0]])[0] || [0];
    const longRow   = (longSqlR.rows || [[0,0]])[0] || [0,0];

    return {
      total_sessions: parseInt(sessRow[0]) || 0,
      active_sessions: parseInt(sessRow[1]) || 0,
      user_sessions: parseInt(sessRow[2]) || 0,
      blocked_sessions: parseInt(blockRow[0]) || 0,
      long_running_sql_count: parseInt(longRow[0]) || 0,
      max_runtime_min: parseFloat(longRow[1]) || 0
    };
  } catch (err) {
    console.error('Session stats query failed:', err.message);
    return { total_sessions: 0, active_sessions: 0, user_sessions: 0, blocked_sessions: 0, long_running_sql_count: 0, max_runtime_min: 0 };
  }
}

/**
 * querySecurityStats — covers SEC01-SEC07: default passwords, public privs,
 * audit settings, password policy, unlocked users, obj audit, roles.
 * All queries are experimental — Oracle security posture checks.
 */
async function querySecurityStats(conn) {
  try {
    const [defaultPwdR, publicPrivR, unlicensedUsersR, profileR, auditR, dbaUsersR] = await Promise.all([
      // Default/well-known passwords check (count of accounts using DEFAULT profile OR password = username)
      conn.execute(`
        SELECT COUNT(*) AS default_pwd_count
        FROM DBA_USERS_WITH_DEFPWD
        WHERE ACCOUNT_STATUS = 'OPEN'
      `).catch(() => ({ rows: [[0]] })),

      // Dangerous PUBLIC grants (EXECUTE on UTL_FILE, UTL_HTTP, DBMS_JAVA, etc.)
      conn.execute(`
        SELECT COUNT(*) AS dangerous_public_grants
        FROM DBA_SYS_PRIVS
        WHERE GRANTEE = 'PUBLIC'
          AND PRIVILEGE IN ('CREATE PROCEDURE','CREATE ANY PROCEDURE','CREATE ANY TRIGGER','ALTER SYSTEM','ALTER DATABASE','DROP ANY TABLE','EXECUTE ANY PROCEDURE')
      `).catch(() => ({ rows: [[0]] })),

      // Unlicensed/schema-only accounts that are OPEN (should be locked)
      conn.execute(`
        SELECT COUNT(*) AS open_schema_accounts
        FROM DBA_USERS
        WHERE ACCOUNT_STATUS = 'OPEN'
          AND AUTHENTICATION_TYPE = 'NONE'
          AND USERNAME NOT IN ('SYS','SYSTEM')
      `).catch(() => ({ rows: [[0]] })),

      // Password policy (verify function in DEFAULT profile)
      conn.execute(`
        SELECT LIMIT AS password_verify_function
        FROM DBA_PROFILES
        WHERE PROFILE = 'DEFAULT' AND RESOURCE_NAME = 'PASSWORD_VERIFY_FUNCTION'
      `).catch(() => ({ rows: [['NULL']] })),

      // Audit enabled check
      conn.execute(`
        SELECT VALUE AS audit_trail FROM V$PARAMETER WHERE NAME = 'audit_trail'
      `).catch(() => ({ rows: [['NONE']] })),

      // DBA-privileged users (should be minimal)
      conn.execute(`
        SELECT COUNT(DISTINCT GRANTEE) AS dba_user_count
        FROM DBA_SYS_PRIVS
        WHERE PRIVILEGE = 'DBA' AND GRANTEE NOT IN ('SYS','SYSTEM','DBA','SYSMAN')
      `).catch(() => ({ rows: [[0]] }))
    ]);

    const defPwd         = parseInt((defaultPwdR.rows || [[0]])[0]?.[0]) || 0;
    const pubPrivs       = parseInt((publicPrivR.rows || [[0]])[0]?.[0]) || 0;
    const openSchema     = parseInt((unlicensedUsersR.rows || [[0]])[0]?.[0]) || 0;
    const pwdVerifyFn    = String((profileR.rows || [['NULL']])[0]?.[0] || 'NULL');
    const auditTrail     = String((auditR.rows || [['NONE']])[0]?.[0] || 'NONE');
    const dbaUserCount   = parseInt((dbaUsersR.rows || [[0]])[0]?.[0]) || 0;

    return {
      default_pwd_accounts: defPwd,
      dangerous_public_grants: pubPrivs,
      open_schema_accounts: openSchema,
      password_verify_function: pwdVerifyFn,
      password_policy_active: pwdVerifyFn !== 'NULL' && pwdVerifyFn !== 'null',
      audit_trail: auditTrail,
      audit_enabled: auditTrail !== 'NONE' && auditTrail !== 'none',
      dba_user_count: dbaUserCount
    };
  } catch (err) {
    console.error('Security stats query failed:', err.message);
    return { default_pwd_accounts: 0, dangerous_public_grants: 0, open_schema_accounts: 0, password_verify_function: 'UNKNOWN', password_policy_active: false, audit_trail: 'UNKNOWN', audit_enabled: false, dba_user_count: 0 };
  }
}

/**
 * querySchemaStats — table/segment growth, recyclebin, datafile status.
 * Covers ST04_SEGMENT_GROWTH, ST05_DATAFILE_STATUS, ST06_RECYCLEBIN_SIZE, ST07.
 */
async function querySchemaStats(conn) {
  try {
    const EXCLUDED_OWNERS = `'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS'`;

    const [topSegR, datafileR, sortR, ftScanR] = await Promise.all([
      // Top 10 segments by size
      conn.execute(`
        SELECT OWNER, SEGMENT_NAME, SEGMENT_TYPE, ROUND(SUM(BYTES)/1073741824, 2) AS size_gb
        FROM DBA_SEGMENTS
        WHERE OWNER NOT IN (${EXCLUDED_OWNERS})
        GROUP BY OWNER, SEGMENT_NAME, SEGMENT_TYPE
        ORDER BY size_gb DESC
        FETCH FIRST 10 ROWS ONLY
      `).catch(() => ({ rows: [] })),

      // Offline/problem datafiles
      conn.execute(`
        SELECT COUNT(*) AS problem_count,
               COUNT(CASE WHEN STATUS = 'OFFLINE' THEN 1 END) AS offline_count
        FROM DBA_DATA_FILES
        WHERE STATUS NOT IN ('AVAILABLE','ONLINE')
      `).catch(() => ({ rows: [[0,0]] })),

      // Disk sort stats from V$SYSSTAT
      conn.execute(`
        SELECT d.VALUE AS disk_sorts, m.VALUE AS mem_sorts
        FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'sorts (disk)') d,
             (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'sorts (memory)') m
      `).catch(() => ({ rows: [[0,0]] })),

      // Full table scan stats
      conn.execute(`
        SELECT s.VALUE AS long_scans, i.VALUE AS index_lookups
        FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'table scans (long tables)') s,
             (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'table fetch by rowid') i
      `).catch(() => ({ rows: [[0,0]] }))
    ]);

    const topSegments = (topSegR.rows || []).map(r => ({
      owner: r[0] || '', segment_name: r[1] || '', segment_type: r[2] || '', size_gb: parseFloat(r[3]) || 0
    }));

    const dfRow = (datafileR.rows || [[0,0]])[0] || [0,0];
    const sortRow = (sortR.rows || [[0,0]])[0] || [0,0];
    const scanRow = (ftScanR.rows || [[0,0]])[0] || [0,0];

    const diskSorts = parseInt(sortRow[0]) || 0;
    const memSorts  = parseInt(sortRow[1]) || 0;
    const diskSortPct = (diskSorts + memSorts) > 0 ? Math.round(diskSorts / (diskSorts + memSorts) * 10000) / 100 : 0;

    const longScans = parseInt(scanRow[0]) || 0;
    const indexLookups = parseInt(scanRow[1]) || 0;
    const ftScanPct = (longScans + indexLookups) > 0 ? Math.round(longScans / (longScans + indexLookups) * 10000) / 100 : 0;

    return {
      top_segments: topSegments,
      problem_datafiles: parseInt(dfRow[0]) || 0,
      offline_datafiles: parseInt(dfRow[1]) || 0,
      disk_sort_pct: diskSortPct,
      disk_sorts: diskSorts,
      mem_sorts: memSorts,
      full_table_scan_pct: ftScanPct,
      long_scans: longScans
    };
  } catch (err) {
    console.error('Schema stats query failed:', err.message);
    return { top_segments: [], problem_datafiles: 0, offline_datafiles: 0, disk_sort_pct: 0, disk_sorts: 0, mem_sorts: 0, full_table_scan_pct: 0, long_scans: 0 };
  }
}

// ============================================================
// ADDM Findings (on-demand panel)
// ============================================================

async function queryAddmFindings(connParams, lookbackHours) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    // License check: Enterprise Edition required
    let enterprise = false;
    try {
      const r = await connection.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`);
      const banner = String(r.rows && r.rows[0] && r.rows[0][0] || '').toUpperCase();
      enterprise = banner.includes('ENTERPRISE');
    } catch (e) {
      enterprise = true; // assume EE if V$VERSION inaccessible
    }

    if (!enterprise) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Oracle Enterprise Edition + Diagnostics Pack.',
        lookback_hours: lookbackHours, task_name: null, task_id: null, findings: []
      };
    }

    // Diagnostics Pack check
    let diagnosticsLicensed = false;
    try {
      const r = await connection.execute(`
        SELECT DETECTED_USAGES, CURRENTLY_USED
        FROM DBA_FEATURE_USAGE_STATISTICS
        WHERE NAME = 'Diagnostic Pack'
        FETCH FIRST 1 ROWS ONLY
      `);
      const row = r.rows && r.rows[0];
      if (row) {
        const detected = parseInt(row[0]) || 0;
        if (detected > 0 || row[1] === 'TRUE') diagnosticsLicensed = true;
      }
    } catch (e) { /* fall through */ }

    if (!diagnosticsLicensed) {
      try {
        const p = await connection.execute(
          `SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'`
        );
        const val = String(p.rows && p.rows[0] && p.rows[0][0] || '').toUpperCase();
        diagnosticsLicensed = val === 'DIAGNOSTIC+TUNING' || val === 'DIAGNOSTIC';
      } catch (e) { /* ignore */ }
    }

    if (!diagnosticsLicensed) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Diagnostics Pack license not detected. ADDM queries skipped.',
        lookback_hours: lookbackHours, task_name: null, task_id: null, findings: []
      };
    }

    // Find most recent completed ADDM task
    let taskId = null, taskName = null;
    try {
      const taskResult = await connection.execute(`
        SELECT t.TASK_ID, t.TASK_NAME
        FROM DBA_ADVISOR_TASKS t
        WHERE t.ADVISOR_NAME = 'ADDM'
          AND t.STATUS = 'COMPLETED'
          AND t.COMPLETION_DATE >= SYSDATE - :lbDays
        ORDER BY t.COMPLETION_DATE DESC
        FETCH FIRST 1 ROWS ONLY
      `, { lbDays: lookbackHours / 24 });
      const taskRow = taskResult.rows && taskResult.rows[0];
      if (taskRow) { taskId = parseInt(taskRow[0]); taskName = String(taskRow[1]); }
    } catch (e) { /* DBA_ADVISOR_TASKS not accessible */ }

    if (!taskId) {
      return {
        licensed: true, lookback_hours: lookbackHours,
        task_name: null, task_id: null, findings: [],
        info: `No completed ADDM tasks found in the last ${lookbackHours} hours.`
      };
    }

    // Fetch findings
    let rawFindings = [];
    try {
      const findResult = await connection.execute(`
        SELECT f.FINDING_ID, f.TYPE, f.NAME, f.MESSAGE, f.IMPACT_DB_PERCENT, f.SQL_ID
        FROM DBA_ADVISOR_FINDINGS f
        WHERE f.TASK_ID = :taskId
        ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC
      `, { taskId });
      rawFindings = (findResult.rows || []).map(row => ({
        finding_id: parseInt(row[0]), type: String(row[1] || 'INFORMATION'),
        name: String(row[2] || ''), message: String(row[3] || ''),
        impact_pct: parseFloat(row[4]) || 0, sql_id: row[5] ? String(row[5]) : null
      }));
    } catch (e) { /* DBA_ADVISOR_FINDINGS not accessible */ }

    if (rawFindings.length === 0) {
      return {
        licensed: true, lookback_hours: lookbackHours, task_name: taskName, task_id: taskId, findings: [],
        // Completed task with zero findings = idle DB, not a data gap
        no_findings_reason: 'Analysis completed — no significant database activity detected. This is normal for idle or lightly-used databases.'
      };
    }

    // Fetch recommendations
    const findingIds = rawFindings.map(f => f.finding_id);
    const recMap = {};
    try {
      const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
      const bindObj = { taskId };
      findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });
      const recResult = await connection.execute(`
        SELECT r.FINDING_ID, r.REC_ID, r.TYPE, r.BENEFIT_DB_PERCENT, r.MESSAGE
        FROM DBA_ADVISOR_RECOMMENDATIONS r
        WHERE r.TASK_ID = :taskId AND r.FINDING_ID IN (${idPlaceholders})
        ORDER BY r.FINDING_ID, r.REC_ID
      `, bindObj);
      for (const row of (recResult.rows || [])) {
        const fid = parseInt(row[0]);
        if (!recMap[fid]) recMap[fid] = [];
        recMap[fid].push({ rec_id: parseInt(row[1]), type: String(row[2] || ''), benefit_pct: parseFloat(row[3]) || 0, message: String(row[4] || ''), actions: [] });
      }
    } catch (e) { /* ignore */ }

    // Fetch actions
    try {
      const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
      const bindObj = { taskId };
      findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });
      const actResult = await connection.execute(`
        SELECT a.FINDING_ID, a.REC_ID, a.ACTION_ID, a.COMMAND, a.ATTR1, a.ATTR2, a.ATTR3, a.ATTR4
        FROM DBA_ADVISOR_ACTIONS a
        WHERE a.TASK_ID = :taskId AND a.FINDING_ID IN (${idPlaceholders})
        ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID
      `, bindObj);
      for (const row of (actResult.rows || [])) {
        const fid = parseInt(row[0]), rid = parseInt(row[1]);
        const recs = recMap[fid] || [];
        const rec = recs.find(r => r.rec_id === rid);
        if (rec) {
          rec.actions.push({ action_id: parseInt(row[2]), command: String(row[3] || ''), attr1: row[4] ? String(row[4]) : null, attr2: row[5] ? String(row[5]) : null, attr3: row[6] ? String(row[6]) : null, attr4: row[7] ? String(row[7]) : null });
        }
      }
    } catch (e) { /* ignore */ }

    // Merge findings + recommendations
    const findings = rawFindings.map(f => ({
      ...f,
      severity: f.impact_pct >= 10 ? 'critical' : f.impact_pct >= 3 ? 'warning' : 'info',
      recommendations: recMap[f.finding_id] || []
    }));

    return { licensed: true, lookback_hours: lookbackHours, task_name: taskName, task_id: taskId, findings };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ============================================================
// ADDM Run Now (create AWR snapshot + analyze)
// ============================================================

async function runAddmNow(connParams) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    // License check
    let enterprise = false;
    try {
      const r = await connection.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`);
      const banner = String(r.rows && r.rows[0] && r.rows[0][0] || '').toUpperCase();
      enterprise = banner.includes('ENTERPRISE');
    } catch (e) { enterprise = true; }

    if (!enterprise) {
      return { licensed: false, not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Oracle Enterprise Edition + Diagnostics Pack.', lookback_hours: 0, task_name: null, task_id: null, findings: [] };
    }

    let diagnosticsLicensed = false;
    try {
      const r = await connection.execute(`SELECT DETECTED_USAGES, CURRENTLY_USED FROM DBA_FEATURE_USAGE_STATISTICS WHERE NAME = 'Diagnostic Pack' FETCH FIRST 1 ROWS ONLY`);
      const row = r.rows && r.rows[0];
      if (row && (parseInt(row[0]) > 0 || row[1] === 'TRUE')) diagnosticsLicensed = true;
    } catch (e) { /* fall through */ }
    if (!diagnosticsLicensed) {
      try {
        const p = await connection.execute(`SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'`);
        const val = String(p.rows && p.rows[0] && p.rows[0][0] || '').toUpperCase();
        diagnosticsLicensed = val === 'DIAGNOSTIC+TUNING' || val === 'DIAGNOSTIC';
      } catch (e) { /* ignore */ }
    }
    if (!diagnosticsLicensed) {
      return { licensed: false, not_licensed_reason: 'Oracle Diagnostics Pack license not detected. ADDM run-now skipped.', lookback_hours: 0, task_name: null, task_id: null, findings: [] };
    }

    const t0 = Date.now();

    // Step 1: create fresh AWR snapshot
    let newSnapId = null;
    try {
      const snapResult = await connection.execute(
        `BEGIN :snap_id := DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT(); END;`,
        { snap_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
      );
      newSnapId = snapResult.outBinds && snapResult.outBinds.snap_id;
    } catch (e) { /* non-fatal */ }

    const t1 = Date.now();

    // Step 2: get two most-recent snapshots
    let beginSnapId = null, endSnapId = null, dbId = null;
    try {
      const snapsResult = await connection.execute(`SELECT s.SNAP_ID, s.DBID FROM DBA_HIST_SNAPSHOT s WHERE s.STATUS = 'Done' ORDER BY s.SNAP_ID DESC FETCH FIRST 2 ROWS ONLY`);
      const rows = snapsResult.rows || [];
      if (rows.length >= 2) { endSnapId = parseInt(rows[0][0]); beginSnapId = parseInt(rows[1][0]); dbId = rows[0][1]; }
      else if (rows.length === 1) {
        return { licensed: true, lookback_hours: 0, task_name: null, task_id: null, findings: [], run_info: { snapshot_taken: !!newSnapId, snap_id: newSnapId, elapsed_ms: Date.now() - t0 }, info: 'AWR snapshot created but only one snapshot exists — ADDM requires at least two. Run again after the next automatic snapshot.' };
      }
    } catch (e) {
      return { licensed: true, lookback_hours: 0, task_name: null, task_id: null, findings: [], run_info: { snapshot_taken: !!newSnapId, elapsed_ms: Date.now() - t0 }, info: 'DBA_HIST_SNAPSHOT not accessible — cannot determine snapshot IDs for ADDM analysis.' };
    }

    if (!beginSnapId || !endSnapId) {
      return { licensed: true, lookback_hours: 0, task_name: null, task_id: null, findings: [], run_info: { snapshot_taken: !!newSnapId, elapsed_ms: Date.now() - t0 }, info: 'Not enough AWR snapshots to run ADDM analysis.' };
    }

    // Step 3: run ADDM analysis
    let taskId = null, taskName = null;
    const addmTaskName = 'TUNEVAULT_ADDM_' + Date.now();
    try {
      await connection.execute(`BEGIN DBMS_ADDM.ANALYZE_DB(:task_name, :begin_snap, :end_snap, :db_id); END;`, { task_name: addmTaskName, begin_snap: beginSnapId, end_snap: endSnapId, db_id: dbId });
      taskName = addmTaskName;
      const tidResult = await connection.execute(`SELECT TASK_ID FROM DBA_ADVISOR_TASKS WHERE TASK_NAME = :task_name AND ADVISOR_NAME = 'ADDM' FETCH FIRST 1 ROWS ONLY`, { task_name: addmTaskName });
      const tidRow = tidResult.rows && tidResult.rows[0];
      if (tidRow) taskId = parseInt(tidRow[0]);
    } catch (addmErr) {
      return { licensed: true, lookback_hours: 0, task_name: null, task_id: null, findings: [], run_info: { snapshot_taken: !!newSnapId, begin_snap_id: beginSnapId, end_snap_id: endSnapId, elapsed_ms: Date.now() - t0 }, info: `ADDM analysis failed: ${addmErr.message || addmErr}. User may need EXECUTE on DBMS_ADDM or ADVISOR privilege.` };
    }

    const t2 = Date.now();
    if (!taskId) {
      return { licensed: true, lookback_hours: 0, task_name: taskName, task_id: null, findings: [], run_info: { snapshot_taken: !!newSnapId, elapsed_ms: t2 - t0 }, info: 'ADDM task created but task ID not found — may still be executing. Reload in a few seconds.' };
    }

    // Step 4: fetch findings
    let rawFindings = [];
    try {
      const findResult = await connection.execute(`SELECT f.FINDING_ID, f.TYPE, f.NAME, f.MESSAGE, f.IMPACT_DB_PERCENT, f.SQL_ID FROM DBA_ADVISOR_FINDINGS f WHERE f.TASK_ID = :taskId ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC`, { taskId });
      rawFindings = (findResult.rows || []).map(row => ({ finding_id: parseInt(row[0]), type: String(row[1] || 'INFORMATION'), name: String(row[2] || ''), message: String(row[3] || ''), impact_pct: parseFloat(row[4]) || 0, sql_id: row[5] ? String(row[5]) : null }));
    } catch (e) { /* ignore */ }

    const findingIds = rawFindings.map(f => f.finding_id);
    const recMap = {};
    if (findingIds.length > 0) {
      try {
        const idPh = findingIds.map((_, i) => `:f${i}`).join(',');
        const bObj = { taskId };
        findingIds.forEach((id, i) => { bObj[`f${i}`] = id; });
        const recResult = await connection.execute(`SELECT r.FINDING_ID, r.REC_ID, r.TYPE, r.BENEFIT_DB_PERCENT, r.MESSAGE FROM DBA_ADVISOR_RECOMMENDATIONS r WHERE r.TASK_ID = :taskId AND r.FINDING_ID IN (${idPh}) ORDER BY r.FINDING_ID, r.REC_ID`, bObj);
        for (const row of (recResult.rows || [])) {
          const fid = parseInt(row[0]);
          if (!recMap[fid]) recMap[fid] = [];
          recMap[fid].push({ rec_id: parseInt(row[1]), type: String(row[2] || ''), benefit_pct: parseFloat(row[3]) || 0, message: String(row[4] || ''), actions: [] });
        }
      } catch (e) { /* ignore */ }
      try {
        const idPh = findingIds.map((_, i) => `:f${i}`).join(',');
        const bObj = { taskId };
        findingIds.forEach((id, i) => { bObj[`f${i}`] = id; });
        const actResult = await connection.execute(`SELECT a.FINDING_ID, a.REC_ID, a.ACTION_ID, a.COMMAND, a.ATTR1, a.ATTR2, a.ATTR3, a.ATTR4 FROM DBA_ADVISOR_ACTIONS a WHERE a.TASK_ID = :taskId AND a.FINDING_ID IN (${idPh}) ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID`, bObj);
        for (const row of (actResult.rows || [])) {
          const fid = parseInt(row[0]), rid = parseInt(row[1]);
          const recs = recMap[fid] || [];
          const rec = recs.find(r => r.rec_id === rid);
          if (rec) rec.actions.push({ action_id: parseInt(row[2]), command: String(row[3] || ''), attr1: row[4] ? String(row[4]) : null, attr2: row[5] ? String(row[5]) : null, attr3: row[6] ? String(row[6]) : null, attr4: row[7] ? String(row[7]) : null });
        }
      } catch (e) { /* ignore */ }
    }

    const findings = rawFindings.map(f => ({ ...f, severity: f.impact_pct >= 10 ? 'critical' : f.impact_pct >= 3 ? 'warning' : 'info', recommendations: recMap[f.finding_id] || [] }));

    return {
      licensed: true, lookback_hours: 0, task_name: taskName, task_id: taskId, findings,
      run_info: { snapshot_taken: !!newSnapId, snap_id: newSnapId, begin_snap_id: beginSnapId, end_snap_id: endSnapId, snapshot_ms: t1 - t0, analysis_ms: t2 - t1, total_ms: Date.now() - t0 },
      ...(findings.length === 0 ? { no_findings_reason: 'Fresh ADDM analysis completed — no significant database activity detected in the snapshot interval.' } : {})
    };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ============================================================
// Maintenance Windows (on-demand panel — all editions)
// ============================================================

async function queryMaintenanceWindows(connParams) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    // 1. Autotask clients
    const clients = [];
    const CLIENT_NAMES = ['auto optimizer stats collection', 'sql tuning advisor', 'auto space advisor'];

    let clientRows = [];
    try {
      const cr = await connection.execute(`
        SELECT c.CLIENT_NAME, c.STATUS,
               h.JOB_START_TIME, h.JOB_STATUS, h.JOB_DURATION
        FROM DBA_AUTOTASK_CLIENT c
        LEFT JOIN (
          SELECT CLIENT_NAME, JOB_START_TIME, JOB_STATUS, JOB_DURATION,
                 ROW_NUMBER() OVER (PARTITION BY CLIENT_NAME ORDER BY JOB_START_TIME DESC) AS rn
          FROM DBA_AUTOTASK_JOB_HISTORY
          WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
        ) h ON h.CLIENT_NAME = c.CLIENT_NAME AND h.rn = 1
        WHERE c.CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
        ORDER BY c.CLIENT_NAME
      `);
      clientRows = cr.rows || [];
    } catch (e) { /* DBA_AUTOTASK_CLIENT not accessible */ }

    // Run stats per client in last 7 days
    const runStats = {};
    try {
      const rs = await connection.execute(`
        SELECT CLIENT_NAME, COUNT(*) AS total_runs,
               SUM(CASE WHEN JOB_STATUS != 'SUCCEEDED' THEN 1 ELSE 0 END) AS failures
        FROM DBA_AUTOTASK_JOB_HISTORY
        WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
          AND CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
        GROUP BY CLIENT_NAME
      `);
      for (const row of (rs.rows || [])) {
        runStats[String(row[0]).toLowerCase()] = { runs: parseInt(row[1]) || 0, failures: parseInt(row[2]) || 0 };
      }
    } catch (e) { /* DBA_AUTOTASK_JOB_HISTORY not accessible */ }

    // Tuning Pack license check (for sql tuning advisor gating)
    let tuningLicensed = false;
    try {
      const r = await connection.execute(`
        SELECT DETECTED_USAGES, CURRENTLY_USED
        FROM DBA_FEATURE_USAGE_STATISTICS WHERE NAME = 'SQL Tuning Advisor'
        FETCH FIRST 1 ROWS ONLY
      `);
      const row = r.rows && r.rows[0];
      if (row && (parseInt(row[0]) > 0 || row[1] === 'TRUE')) tuningLicensed = true;
    } catch (e) {
      try {
        const p = await connection.execute(`SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'`);
        const val = String(p.rows && p.rows[0] && p.rows[0][0] || '').toUpperCase();
        tuningLicensed = val === 'DIAGNOSTIC+TUNING' || val === 'TUNING';
      } catch (e2) { /* inaccessible */ }
    }

    for (const row of clientRows) {
      const name = String(row[0] || '');
      const status = String(row[1] || '');
      const lastRunDate = row[2] ? new Date(row[2]).toISOString() : null;
      const lastRunStatus = row[3] ? String(row[3]) : null;
      const durationRaw = row[4];
      let durationSecs = null;
      if (durationRaw) {
        const m = String(durationRaw).match(/(\d+)\s+(\d+):(\d+):(\d+)/);
        if (m) durationSecs = parseInt(m[1]) * 86400 + parseInt(m[2]) * 3600 + parseInt(m[3]) * 60 + parseInt(m[4]);
      }
      const key = name.toLowerCase();
      const stats = runStats[key] || { runs: 0, failures: 0 };
      const isTuningAdvisor = key === 'sql tuning advisor';

      let trafficLight;
      if (status !== 'ENABLED') trafficLight = 'red';
      else if (stats.runs > 0 && stats.failures < stats.runs) trafficLight = 'green';
      else trafficLight = 'amber';

      clients.push({
        client_name: name, status, last_run_date: lastRunDate,
        last_run_status: lastRunStatus, last_run_duration_secs: durationSecs,
        runs_7d: stats.runs, failures_7d: stats.failures, traffic_light: trafficLight,
        tuning_pack_required: isTuningAdvisor, tuning_pack_licensed: isTuningAdvisor ? tuningLicensed : null
      });
    }

    // Fill missing clients
    for (const name of CLIENT_NAMES) {
      if (!clients.find(c => c.client_name === name)) {
        clients.push({
          client_name: name, status: 'UNKNOWN', last_run_date: null,
          last_run_status: null, last_run_duration_secs: null,
          runs_7d: 0, failures_7d: 0, traffic_light: 'amber',
          tuning_pack_required: name === 'sql tuning advisor',
          tuning_pack_licensed: name === 'sql tuning advisor' ? tuningLicensed : null
        });
      }
    }

    // 2. Maintenance windows
    const windows = [];
    try {
      const wr = await connection.execute(`
        SELECT WINDOW_NAME,
               TO_CHAR(NEXT_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS next_start,
               REPEAT_INTERVAL,
               EXTRACT(HOUR FROM DURATION) * 60 + EXTRACT(MINUTE FROM DURATION) AS duration_mins,
               ENABLED,
               TO_CHAR(LAST_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS last_start,
               TO_CHAR(LAST_END_DATE, 'YYYY-MM-DD HH24:MI:SS') AS last_end
        FROM DBA_SCHEDULER_WINDOWS
        WHERE WINDOW_NAME LIKE '%DAY_WINDOW' OR WINDOW_NAME LIKE '%WINDOW'
        ORDER BY WINDOW_NAME
      `);
      for (const row of (wr.rows || [])) {
        const name = String(row[0] || '');
        if (!name.endsWith('WINDOW')) continue;
        const durationMins = parseInt(row[3]) || 0;
        windows.push({
          window_name: name,
          next_start_date: row[1] ? String(row[1]) : null,
          repeat_interval: row[2] ? String(row[2]) : null,
          duration_hours: +(durationMins / 60).toFixed(2),
          enabled: row[4] === 'TRUE' || row[4] === true,
          last_start_date: row[5] ? String(row[5]) : null,
          last_end_date: row[6] ? String(row[6]) : null
        });
      }
    } catch (e) { /* DBA_SCHEDULER_WINDOWS not accessible */ }

    // 3. Stale stats
    let staleCount = 0;
    let staleTop10 = [];
    try {
      const sc = await connection.execute(`SELECT COUNT(*) FROM DBA_TAB_STATISTICS WHERE STALE_STATS = 'YES'`);
      staleCount = parseInt(sc.rows && sc.rows[0] && sc.rows[0][0]) || 0;
    } catch (e) { /* not accessible */ }

    try {
      const st = await connection.execute(`
        SELECT OWNER, TABLE_NAME, NUM_ROWS,
               TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed, STALE_STATS
        FROM DBA_TAB_STATISTICS
        WHERE STALE_STATS = 'YES'
          AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','XDB','MDSYS','CTXSYS','OLAPSYS','WMSYS','ORDSYS')
        ORDER BY NUM_ROWS DESC NULLS LAST
        FETCH FIRST 10 ROWS ONLY
      `);
      staleTop10 = (st.rows || []).map(row => ({
        owner: String(row[0] || ''), table_name: String(row[1] || ''),
        num_rows: parseInt(row[2]) || 0, last_analyzed: row[3] ? String(row[3]) : null,
        stale_stats: String(row[4] || '')
      }));
    } catch (e) { /* not accessible */ }

    const disabledClients = clients.filter(c => c.traffic_light === 'red').map(c => c.client_name);
    const disabledWindows = windows.filter(w => !w.enabled || w.duration_hours === 0).map(w => w.window_name);

    return { autotask_clients: clients, windows, stale_tables_count: staleCount, stale_tables_top10: staleTop10, disabled_clients: disabledClients, disabled_windows: disabledWindows };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ============================================================
// Oracle Parameters
// ============================================================

async function queryOracleParameters({ host, port, serviceName, username, password }) {
  let connection;
  try {
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: username, password, connectString: `${host}:${port}/${serviceName}`, connectTimeout: 30
    });

    async function runQuery(sql) {
      try { const r = await connection.execute(sql); return r.rows || []; } catch (e) { return []; }
    }

    const [paramRows, osRows, licRows, dfRows] = await Promise.all([
      runQuery(`SELECT name, value, isdefault, isinstance_modifiable, issys_modifiable, description FROM v$parameter ORDER BY name`),
      runQuery(`SELECT stat_name, value FROM v$osstat WHERE stat_name IN ('PHYSICAL_MEMORY_BYTES','NUM_CPUS','NUM_CPU_CORES')`),
      runQuery(`SELECT sessions_highwater FROM v$license`),
      runQuery(`SELECT COUNT(*) FROM v$datafile`)
    ]);

    const osMap = {};
    osRows.forEach(r => { osMap[String(r[0])] = Number(r[1]) || 0; });
    const ramBytes  = osMap['PHYSICAL_MEMORY_BYTES'] || 0;
    const ramGb     = ramBytes > 0 ? Math.round(ramBytes / (1024 ** 3) * 10) / 10 : 0;
    const cpuCount  = osMap['NUM_CPUS'] || osMap['NUM_CPU_CORES'] || 1;
    const sessHW    = licRows.length > 0 ? (Number(licRows[0][0]) || 0) : 0;
    const datafileCount = dfRows.length > 0 ? (Number(dfRows[0][0]) || 0) : 0;

    const paramMap = {};
    paramRows.forEach(r => { paramMap[String(r[0]).toLowerCase()] = String(r[1] || ''); });
    const isEE = 'inmemory_size' in paramMap || Number(paramMap['cpu_count'] || 0) > 0;
    const edition = isEE ? 'EE' : 'SE';

    function parseBytes(val) {
      if (!val || val === '') return 0;
      const s = String(val).trim().toUpperCase();
      if (/^\d+$/.test(s)) return Number(s);
      const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)$/);
      if (!m) return 0;
      const n = parseFloat(m[1]);
      const mult = { K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 }[m[2]] || 1;
      return Math.round(n * mult);
    }
    function fmtBytes(bytes) {
      if (bytes === 0) return '0';
      if (bytes >= 1024**3) return (bytes / 1024**3).toFixed(1).replace(/\.0$/, '') + 'G';
      if (bytes >= 1024**2) return (bytes / 1024**2).toFixed(0) + 'M';
      if (bytes >= 1024)    return (bytes / 1024).toFixed(0) + 'K';
      return String(bytes);
    }

    function evalParam(name, current) {
      const n = name.toLowerCase(); const cur = (current || '').trim();
      const curNum = parseBytes(cur);
      if (n === 'memory_target' || n === 'memory_max_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.7 * 1024**3);
        if (curNum === 0) return { status: 'green', recommended: 'AMM disabled (manual SGA/PGA)', note: 'Preferred on Linux' };
        if (curNum < rec * 0.5) return { status: 'red', recommended: fmtBytes(rec), note: `Undersized for ${ramGb} GB RAM` };
        if (curNum > ramGb * 0.9 * 1024**3) return { status: 'amber', recommended: fmtBytes(rec), note: 'Leaves too little RAM for OS' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'sga_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.45 * 1024**3);
        if (curNum === 0) return { status: 'amber', recommended: fmtBytes(rec), note: 'SGA auto-tuning is off' };
        if (curNum < rec * 0.5) return { status: 'amber', recommended: fmtBytes(rec), note: `Consider ~45% of RAM (${ramGb} GB)` };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'sga_max_size') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.6 * 1024**3);
        if (curNum < rec * 0.6) return { status: 'amber', recommended: fmtBytes(rec), note: 'Cap may restrict SGA growth' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'pga_aggregate_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.25 * 1024**3);
        if (curNum === 0) return { status: 'amber', recommended: fmtBytes(rec), note: 'Auto PGA is off' };
        if (curNum < rec * 0.4) return { status: 'amber', recommended: fmtBytes(rec), note: '~25% of RAM recommended' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'pga_aggregate_limit') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.5 * 1024**3);
        if (curNum > 0 && curNum < rec * 0.4) return { status: 'amber', recommended: fmtBytes(rec), note: 'Hard PGA limit may kill large sorts' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'db_cache_size') {
        if (paramMap['sga_target'] && parseBytes(paramMap['sga_target']) > 0) return { status: 'green', recommended: 'Auto-tuned by SGA_TARGET', note: '' };
        const rec = Math.round((ramGb || 16) * 0.3 * 1024**3);
        if (curNum > 0 && curNum < rec * 0.4) return { status: 'amber', recommended: fmtBytes(rec), note: '~30% of RAM for buffer cache' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }
      if (n === 'shared_pool_size') {
        if (paramMap['sga_target'] && parseBytes(paramMap['sga_target']) > 0) return { status: 'green', recommended: 'Auto-tuned by SGA_TARGET', note: '' };
        if (curNum > 0 && curNum < 256 * 1024**2) return { status: 'amber', recommended: '256M+', note: 'Shared pool too small' };
        return { status: 'green', recommended: '256M – 512M', note: '' };
      }
      if (n === 'large_pool_size') {
        if (curNum < 64 * 1024**2) return { status: 'amber', recommended: '64M+', note: 'Required for RMAN and parallel execution' };
        return { status: 'green', recommended: '64M+', note: '' };
      }
      if (n === 'java_pool_size') return { status: 'green', recommended: '32M–128M', note: 'Only matters if Java stored procedures are used' };
      if (n === 'streams_pool_size') return { status: 'green', recommended: '0 (auto) or 64M+ if replication used', note: '' };
      if (n === 'processes') {
        const c = Number(cur) || 0; const hwRec = sessHW > 0 ? Math.max(300, Math.ceil(sessHW * 1.2)) : 300;
        if (c === 0) return { status: 'unknown', recommended: String(hwRec), note: '' };
        if (sessHW > 0 && c < sessHW * 1.1) return { status: 'red', recommended: String(hwRec), note: `Process limit nearly exhausted (HW: ${sessHW})` };
        if (sessHW > 0 && c < sessHW * 1.3) return { status: 'amber', recommended: String(hwRec), note: `Less than 30% headroom (HW: ${sessHW})` };
        return { status: 'green', recommended: `~${hwRec}`, note: '' };
      }
      if (n === 'sessions') {
        const proc = Number(paramMap['processes'] || '0'); const derived = Math.ceil(proc * 1.5) + 22;
        if (proc > 0 && Number(cur) < derived * 0.9) return { status: 'amber', recommended: String(derived), note: 'Should be CEIL(processes*1.5)+22' };
        return { status: 'green', recommended: proc > 0 ? String(derived) : 'derived from PROCESSES', note: '' };
      }
      if (n === 'open_cursors') {
        const c = Number(cur) || 0;
        if (c < 300) return { status: 'red', recommended: '300+', note: 'Risk of ORA-01000' };
        if (c < 500) return { status: 'amber', recommended: '500–1000', note: 'Low — increase if ORA-01000 occurs' };
        return { status: 'green', recommended: '300–1000', note: '' };
      }
      if (n === 'undo_retention') {
        const c = Number(cur) || 0;
        if (c < 900) return { status: 'amber', recommended: '900+', note: 'ORA-01555 risk' };
        if (c > 86400) return { status: 'amber', recommended: '3600–7200', note: 'May cause UNDO tablespace bloat' };
        return { status: 'green', recommended: '900–3600 sec', note: '' };
      }
      if (n === 'undo_tablespace') {
        if (!cur) return { status: 'amber', recommended: 'UNDOTBS1', note: 'No undo tablespace configured' };
        return { status: 'green', recommended: cur, note: '' };
      }
      if (n === 'db_recovery_file_dest_size') {
        if (curNum === 0) return { status: 'amber', recommended: '10G+', note: 'FRA not configured' };
        return { status: 'green', recommended: fmtBytes(curNum), note: 'Check V$RECOVERY_FILE_DEST for usage %' };
      }
      if (n === 'log_buffer') {
        if (curNum < 8 * 1024**2) return { status: 'amber', recommended: '8M–32M', note: 'Small log buffer may cause redo latch waits' };
        return { status: 'green', recommended: '8M–32M', note: '' };
      }
      if (n === 'optimizer_mode') {
        const v = cur.toUpperCase();
        if (v === 'ALL_ROWS') return { status: 'green', recommended: 'ALL_ROWS', note: '' };
        return { status: 'amber', recommended: 'ALL_ROWS', note: 'FIRST_ROWS degrades throughput — only for fetch-first OLTP' };
      }
      if (n === 'cursor_sharing') {
        if (cur.toUpperCase() === 'EXACT') return { status: 'green', recommended: 'EXACT', note: '' };
        if (cur.toUpperCase() === 'FORCE') return { status: 'amber', recommended: 'EXACT', note: 'FORCE is a workaround — fix the SQL instead' };
        return { status: 'amber', recommended: 'EXACT', note: '' };
      }
      if (n === 'parallel_max_servers') {
        if (cpuCount === 1) return { status: 'green', recommended: '0–2', note: 'Single-CPU instance' };
        const rec = cpuCount * 2;
        if (Number(cur) > cpuCount * 8) return { status: 'amber', recommended: String(rec), note: 'Excessive parallelism may thrash CPU' };
        return { status: 'green', recommended: `${cpuCount}–${rec}`, note: '' };
      }
      if (n === 'result_cache_max_size') {
        if (edition !== 'EE') return { status: 'green', recommended: 'N/A (SE)', note: 'EE feature' };
        if (curNum < 128 * 1024**2) return { status: 'amber', recommended: '128M+', note: 'Result cache too small' };
        return { status: 'green', recommended: '128M–512M', note: '' };
      }
      if (n === 'inmemory_size') {
        if (edition !== 'EE') return { status: 'green', recommended: 'N/A (SE)', note: 'EE only' };
        if (curNum === 0) return { status: 'green', recommended: '0 (disabled)', note: 'Enable only if licensed' };
        return { status: 'green', recommended: fmtBytes(curNum), note: '' };
      }
      if (n === 'audit_trail') {
        const v = cur.toUpperCase();
        if (v === 'NONE' || v === 'FALSE' || v === '0') return { status: 'red', recommended: 'DB or OS', note: 'No auditing — compliance risk' };
        return { status: 'green', recommended: 'DB or OS', note: '' };
      }
      if (n === 'sec_case_sensitive_logon') {
        if (cur.toUpperCase() === 'FALSE' || cur === '0') return { status: 'amber', recommended: 'TRUE', note: 'Case-insensitive passwords weaken security' };
        return { status: 'green', recommended: 'TRUE', note: '' };
      }
      if (n === 'remote_login_passwordfile') {
        const v = cur.toUpperCase();
        if (v === 'NONE') return { status: 'amber', recommended: 'EXCLUSIVE', note: 'Required for remote SYSDBA' };
        if (v === 'SHARED') return { status: 'amber', recommended: 'EXCLUSIVE', note: 'Use EXCLUSIVE' };
        return { status: 'green', recommended: 'EXCLUSIVE', note: '' };
      }
      if (n === 'os_authent_prefix') {
        if (cur !== '') return { status: 'amber', recommended: '""', note: 'Allows OS-authenticated logins' };
        return { status: 'green', recommended: '""', note: '' };
      }
      if (n === 'db_files') {
        const limit = Number(cur) || 200;
        if (datafileCount > 0 && datafileCount >= limit * 0.8) return { status: 'red', recommended: String(Math.max(limit * 2, 1000)), note: `${datafileCount}/${limit} datafiles used` };
        if (datafileCount > 0 && datafileCount >= limit * 0.6) return { status: 'amber', recommended: String(limit), note: `${datafileCount}/${limit} datafiles used` };
        return { status: 'green', recommended: '200+', note: datafileCount > 0 ? `${datafileCount}/${limit} used` : '' };
      }
      if (n === 'db_block_size') {
        if (Number(cur) < 8192) return { status: 'amber', recommended: '8192', note: 'Sub-8k block size is uncommon' };
        return { status: 'green', recommended: '8192 (OLTP) or 16384 (DW)', note: '' };
      }
      if (n === 'filesystemio_options') {
        const v = cur.toUpperCase();
        if (v === 'SETALL' || v === 'ASYNCH,DIRECTIO') return { status: 'green', recommended: 'SETALL', note: '' };
        if (v === 'NONE' || v === '') return { status: 'amber', recommended: 'SETALL', note: 'Enable on Linux for async + directIO' };
        return { status: 'amber', recommended: 'SETALL', note: `Current: ${cur}` };
      }
      if (n === 'disk_asynch_io') {
        if (cur.toUpperCase() === 'TRUE') return { status: 'green', recommended: 'TRUE', note: '' };
        return { status: 'amber', recommended: 'TRUE', note: 'Async I/O reduces wait time' };
      }
      if (n === 'compatible') return { status: 'green', recommended: 'Match current version', note: 'Lowering prevents rolling back upgrades' };
      if (n === 'control_file_record_keep_time') {
        if (Number(cur) < 7) return { status: 'amber', recommended: '30', note: 'Low retention — RMAN catalog may miss history' };
        return { status: 'green', recommended: '30+', note: '' };
      }
      return { status: 'green', recommended: cur || '(default)', note: '' };
    }

    const TRACKED = {
      memory_target: 'Memory', memory_max_target: 'Memory', sga_target: 'Memory',
      sga_max_size: 'Memory', pga_aggregate_target: 'Memory', pga_aggregate_limit: 'Memory',
      db_cache_size: 'Memory', shared_pool_size: 'Memory', large_pool_size: 'Memory',
      java_pool_size: 'Memory', streams_pool_size: 'Memory',
      processes: 'Processes & Sessions', sessions: 'Processes & Sessions', open_cursors: 'Processes & Sessions',
      undo_tablespace: 'Undo & Recovery', undo_retention: 'Undo & Recovery',
      db_recovery_file_dest_size: 'Undo & Recovery', log_buffer: 'Undo & Recovery',
      optimizer_mode: 'Performance', cursor_sharing: 'Performance',
      parallel_max_servers: 'Performance', result_cache_max_size: 'Performance', inmemory_size: 'Performance',
      audit_trail: 'Security & Audit', sec_case_sensitive_logon: 'Security & Audit',
      remote_login_passwordfile: 'Security & Audit', os_authent_prefix: 'Security & Audit',
      db_files: 'Storage & I/O', db_block_size: 'Storage & I/O',
      filesystemio_options: 'Storage & I/O', disk_asynch_io: 'Storage & I/O',
      compatible: 'Misc', nls_characterset: 'Misc', nls_nchar_characterset: 'Misc',
      diagnostic_dest: 'Misc', control_file_record_keep_time: 'Misc'
    };

    const parameters = [];
    for (const [pname, category] of Object.entries(TRACKED)) {
      const raw = paramMap[pname.toLowerCase()];
      if (raw === undefined) continue;
      const { status, recommended, note } = evalParam(pname, raw);
      const row = paramRows.find(r => String(r[0]).toLowerCase() === pname.toLowerCase());
      const isDynamic = row ? (String(row[3]) === 'TRUE') : false;
      parameters.push({
        name: pname, category,
        current_value: raw || '(not set)', recommended, status, note,
        is_dynamic: isDynamic,
        scope: isDynamic ? 'SCOPE=BOTH' : 'SCOPE=SPFILE  -- restart required'
      });
    }

    return { parameters, hardware: { ram_gb: ramGb, cpu_count: cpuCount }, sessions_highwater: sessHW, datafile_count: datafileCount, edition };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ============================================================
// Error Formatting
// ============================================================

function formatOracleError(err) {
  const msg = err.message || String(err);
  if (msg.includes('ORA-12154')) return 'TNS name could not be resolved. Check service name.';
  if (msg.includes('ORA-12541')) return 'No listener at the specified host and port. Check host and port.';
  if (msg.includes('ORA-12514')) return 'Service name not found. Check the service name or SID.';
  if (msg.includes('ORA-12170')) return 'Connection timed out. Host may be unreachable.';
  if (msg.includes('ORA-01017')) return 'Invalid username or password.';
  if (msg.includes('ORA-28000')) return 'Account is locked.';
  if (msg.includes('ORA-28001')) return 'Password has expired.';
  if (msg.includes('ORA-01031')) return 'Insufficient privileges. User needs SELECT_CATALOG_ROLE or explicit grants.';
  if (msg.includes('ORA-00942')) return 'Table or view does not exist. User may need additional grants.';
  if (msg.includes('ENOTFOUND')) return 'Hostname not found. Check the hostname or IP address.';
  if (msg.includes('ECONNREFUSED')) return 'Connection refused. Check host, port, and that the Oracle listener is running.';
  if (msg.includes('ETIMEDOUT')) return 'Connection timed out. Host may be unreachable.';
  if (msg.includes('NJS-500')) return 'oracledb thin client error. Ensure Oracle DB is version 12.1+.';
  return msg;
}
