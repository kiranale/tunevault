/**
 * db/agent-install-failures.js — Install failure ingestion + admin read.
 *
 * Owns: agent_install_failures (append-only log of POST /api/agent/install-failures calls).
 * Does NOT own: agent_tunnels, oracle_connections, agent_diagnose_runs.
 */

'use strict';

const pool = require('./index');

/**
 * Record a failed install attempt from install.sh.
 * connection_id may be null (not yet provisioned / provisioning failed).
 */
async function insertInstallFailure({
  connectionId,
  host,
  errorClass,
  journalctlTail,
  installLogTail,
  installerVersion,
  osInfo,
  ipAddress,
  userAgent,
}) {
  const result = await pool.query(
    `INSERT INTO agent_install_failures
       (connection_id, host, error_class, journalctl_tail, install_log_tail, installer_version, os_info, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      connectionId || null,
      host || null,
      errorClass || null,
      journalctlTail ? String(journalctlTail).slice(0, 32768) : null,
      installLogTail ? String(installLogTail).slice(0, 32768) : null,
      installerVersion || null,
      osInfo || null,
      ipAddress || null,
      userAgent ? String(userAgent).slice(0, 512) : null,
    ]
  );
  return result.rows[0];
}

/**
 * Count distinct hosts that reported error_class='systemd_failed'
 * in the last windowMinutes minutes. Used by the alert gate.
 */
async function countRecentSystemdFailed(windowMinutes = 10) {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(host, ip_address::text, 'unknown')) AS cnt
     FROM agent_install_failures
     WHERE error_class = 'systemd_failed'
       AND created_at >= NOW() - ($1 || ' minutes')::interval`,
    [String(windowMinutes)]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Filtered + paginated list for the admin page.
 * Filters: error_class, installer_version, since (24h/7d/30d/all), q (host/ip search).
 * Returns rows newest-first, with resolved rows included (caller can filter client-side).
 */
async function getFilteredFailures({ errorClass, installerVersion, since, q, limit = 50, offset = 0 }) {
  const clauses = [];
  const params  = [];

  if (errorClass) {
    params.push(errorClass);
    clauses.push(`f.error_class = $${params.length}`);
  }

  if (installerVersion) {
    params.push(installerVersion);
    clauses.push(`f.installer_version = $${params.length}`);
  }

  if (since && since !== 'all') {
    const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const interval = intervalMap[since];
    if (interval) {
      params.push(interval);
      clauses.push(`f.created_at >= NOW() - ($${params.length})::interval`);
    }
  }

  if (q) {
    params.push(`%${q}%`);
    clauses.push(`(f.host ILIKE $${params.length} OR f.ip_address::text ILIKE $${params.length})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;
  params.push(offset);
  const offsetPlaceholder = `$${params.length}`;

  const result = await pool.query(
    `SELECT f.id, f.connection_id, f.host, f.error_class,
            f.installer_version, f.os_info, f.ip_address,
            f.journalctl_tail, f.install_log_tail,
            f.created_at, f.resolved_at,
            oc.name AS connection_name
     FROM agent_install_failures f
     LEFT JOIN oracle_connections oc ON oc.id = f.connection_id
     ${where}
     ORDER BY f.created_at DESC
     LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    params
  );
  return result.rows;
}

/**
 * Stats strip: counts for 24h, 7d, unique hosts (24h), most common error_class (24h).
 */
async function getStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS failures_24h,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')   AS failures_7d,
      COUNT(DISTINCT COALESCE(host, ip_address::text))
        FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')        AS unique_hosts_24h,
      (
        SELECT error_class
        FROM agent_install_failures
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND error_class IS NOT NULL
        GROUP BY error_class
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS top_error_class
    FROM agent_install_failures
  `);
  return result.rows[0];
}

/**
 * Distinct error_class values (for filter dropdown).
 */
async function getDistinctErrorClasses() {
  const result = await pool.query(
    `SELECT DISTINCT error_class FROM agent_install_failures
     WHERE error_class IS NOT NULL ORDER BY error_class`
  );
  return result.rows.map(r => r.error_class);
}

/**
 * Distinct installer_version values (for filter dropdown).
 */
async function getDistinctVersions() {
  const result = await pool.query(
    `SELECT DISTINCT installer_version FROM agent_install_failures
     WHERE installer_version IS NOT NULL ORDER BY installer_version DESC`
  );
  return result.rows.map(r => r.installer_version);
}

/**
 * Count distinct hosts with a specific error_class + installer_version in last windowMinutes.
 * Used by the alert gate in routes/install-failures.js to detect failure spikes.
 */
async function countDistinctHostsForPair(errorClass, installerVersion, windowMinutes = 10) {
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(host, ip_address::text, 'unknown')) AS cnt
     FROM agent_install_failures
     WHERE error_class = $1
       AND installer_version = $2
       AND created_at >= NOW() - ($3 || ' minutes')::interval`,
    [errorClass, installerVersion, String(windowMinutes)]
  );
  return parseInt(rows[0].cnt, 10);
}

/**
 * Mark a single failure row as resolved.
 */
async function resolveFailure(id) {
  await pool.query(
    `UPDATE agent_install_failures SET resolved_at = NOW() WHERE id = $1`,
    [id]
  );
}

/**
 * Total count matching filter (for pagination).
 */
async function countFilteredFailures({ errorClass, installerVersion, since, q }) {
  const clauses = [];
  const params  = [];

  if (errorClass) {
    params.push(errorClass);
    clauses.push(`error_class = $${params.length}`);
  }
  if (installerVersion) {
    params.push(installerVersion);
    clauses.push(`installer_version = $${params.length}`);
  }
  if (since && since !== 'all') {
    const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
    const interval = intervalMap[since];
    if (interval) {
      params.push(interval);
      clauses.push(`created_at >= NOW() - ($${params.length})::interval`);
    }
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`(host ILIKE $${params.length} OR ip_address::text ILIKE $${params.length})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM agent_install_failures ${where}`,
    params
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * List recent failures for the legacy admin page. Returns last N rows, newest first.
 */
async function getRecentFailures(limit = 100) {
  const result = await pool.query(
    `SELECT f.id, f.connection_id, f.host, f.error_class,
            f.installer_version, f.os_info,
            f.journalctl_tail, f.install_log_tail,
            f.created_at, f.resolved_at,
            oc.name AS connection_name
     FROM agent_install_failures f
     LEFT JOIN oracle_connections oc ON oc.id = f.connection_id
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Seed 3 fake rows for local dev/testing. Idempotent — skips if dev rows exist.
 */
async function seedDevRows() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM agent_install_failures WHERE host LIKE 'dev-seed-%'`
  );
  if (parseInt(rows[0].cnt, 10) >= 3) return;

  const seeds = [
    {
      host: 'dev-seed-ol7.example.com',
      error_class: 'systemd_failed',
      installer_version: '7.5.0',
      os_info: 'OracleLinux 7.9',
      journalctl_tail: 'May 24 02:00:01 dev-seed-ol7 systemd[1]: tunevault-agent.service: Main process exited, code=exited, status=1/FAILURE\nMay 24 02:00:01 dev-seed-ol7 systemd[1]: Failed to start TuneVault Oracle Proxy Agent.\nMay 24 02:00:02 dev-seed-ol7 systemd[1]: tunevault-agent.service: Unit entered failed state.',
      install_log_tail: '[ERROR] systemd unit failed to start after 30s',
    },
    {
      host: 'dev-seed-ol8.example.com',
      error_class: 'no_heartbeat',
      installer_version: '7.5.0',
      os_info: 'OracleLinux 8.8',
      journalctl_tail: 'May 24 01:45:00 dev-seed-ol8 oracle-proxy[12345]: Stage: boot\nMay 24 01:45:01 dev-seed-ol8 oracle-proxy[12345]: Stage: env_loaded\nMay 24 01:45:02 dev-seed-ol8 oracle-proxy[12345]: Stage: python_deps_ok',
      install_log_tail: '[WARN] No heartbeat received after 60 seconds',
    },
    {
      host: 'dev-seed-rhel8.example.com',
      error_class: 'module_import_error',
      installer_version: '7.4.0',
      os_info: 'RHEL 8.6',
      journalctl_tail: 'May 23 23:00:00 dev-seed-rhel8 oracle-proxy[9999]: ModuleNotFoundError: No module named \'oracledb\'\nMay 23 23:00:00 dev-seed-rhel8 systemd[1]: tunevault-agent.service: Main process exited, code=exited, status=5/NOTINSTALLED',
      install_log_tail: '[ERROR] Python import check failed: oracledb not found',
    },
  ];

  for (const s of seeds) {
    await pool.query(
      `INSERT INTO agent_install_failures (host, error_class, installer_version, os_info, journalctl_tail, install_log_tail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.host, s.error_class, s.installer_version, s.os_info, s.journalctl_tail, s.install_log_tail]
    );
  }
}

module.exports = {
  insertInstallFailure,
  getRecentFailures,
  countRecentSystemdFailed,
  countDistinctHostsForPair,
  getFilteredFailures,
  getStats,
  getDistinctErrorClasses,
  getDistinctVersions,
  resolveFailure,
  countFilteredFailures,
  seedDevRows,
};
