/**
 * routes/db-diagnostics.js — Five new high-impact Oracle diagnostic checks.
 *
 * Owns: on-demand diagnostics for scheduler jobs, expired users, Data Guard / Flashback,
 *       recyclebin space, and database link health.
 * Does NOT own: health check execution, user auth state, Oracle connection storage.
 *
 * Mounted at: /api (see server.js)
 *
 * POST /api/health-checks/:id/scheduler-jobs   — failed/broken DBMS_SCHEDULER + DBMS_JOB
 * POST /api/health-checks/:id/expired-users    — expired/locked accounts + default passwords
 * POST /api/health-checks/:id/dataguard-status — Flashback + Data Guard apply/transport lag
 * POST /api/health-checks/:id/recyclebin       — recyclebin space by owner + largest objects
 * POST /api/health-checks/:id/db-links         — DB link enumeration + connectivity probe
 */

'use strict';

const express = require('express');
const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../crypto-utils');

const router = express.Router();

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Shared: load health check row + run guards ───────────────────────────────

async function loadHcAndGuard(req, res) {
  const hcResult = await pool.query(
    `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
            oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
     FROM health_checks hc
     LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
     WHERE hc.id = $1`,
    [req.params.id]
  );

  if (hcResult.rows.length === 0) {
    res.status(404).json({ error: 'Health check not found' });
    return null;
  }

  const hc = hcResult.rows[0];

  if (!hc.is_demo) {
    if (hc.status !== 'completed') {
      res.status(400).json({ error: 'Health check is not yet complete' });
      return null;
    }
    if (!hc.connection_id) {
      res.status(400).json({ error: 'Health check has no saved connection' });
      return null;
    }
    if (hc.connection_type === 'proxy') {
      res.status(400).json({ error: 'This panel requires a direct TCP connection, not a proxy connection' });
      return null;
    }
  }

  return hc;
}

function buildConnParams(hc) {
  return {
    host: hc.host,
    port: hc.port || 1521,
    serviceName: hc.service_name,
    username: hc.username,
    password: decrypt(hc.encrypted_password)
  };
}

// ─── SCHEDULER JOBS ──────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/scheduler-jobs
 *
 * Returns DBMS_SCHEDULER jobs with failures or broken DBMS_JOB legacy jobs.
 * Covers all Oracle editions — DBA_SCHEDULER_JOBS + DBA_JOBS.
 */
router.post('/health-checks/:id/scheduler-jobs', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json({
        failed: [
          { OWNER: 'APPS', JOB_NAME: 'CONC_PROCESSOR_CLEANUP', JOB_TYPE: 'PLSQL_BLOCK', STATE: 'FAILED', FAILURE_COUNT: 3, LAST_RUN: '2026-05-16 02:00:00', NEXT_RUN: '', COMMENTS: 'Concurrent Processor Cleanup job' },
          { OWNER: 'SH', JOB_NAME: 'GATHER_STATS_JOB', JOB_TYPE: 'STORED_PROCEDURE', STATE: 'FAILED', FAILURE_COUNT: 1, LAST_RUN: '2026-05-15 22:00:00', NEXT_RUN: '2026-05-17 22:00:00', COMMENTS: 'Auto stats gather' }
        ],
        disabled: [
          { OWNER: 'APPS', JOB_NAME: 'FND_INCOMPLETE_REQ_CLEANUP', JOB_TYPE: 'PLSQL_BLOCK', STATE: 'DISABLED', FAILURE_COUNT: 0, LAST_RUN: '', NEXT_RUN: '', COMMENTS: 'FND Incomplete Requests Cleanup' }
        ],
        broken_legacy: [],
        severity: 'red'
      });
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const result = await oracle.querySchedulerJobs(buildConnParams(hc));
    res.json(result);
  } catch (err) {
    console.error('[db-diagnostics] scheduler-jobs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch scheduler job status' });
  }
});

// ─── EXPIRED / LOCKED USERS ───────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/expired-users
 *
 * Returns expired, locked, soon-to-expire accounts + default password accounts.
 * Available on all Oracle editions.
 */
router.post('/health-checks/:id/expired-users', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json({
        expired: [
          { USERNAME: 'PORTAL_APP', ACCOUNT_STATUS: 'EXPIRED & LOCKED', EXPIRY_DATE: '2026-04-01', LOCK_DATE: '2026-04-08', PROFILE: 'DEFAULT', CREATED: '2022-01-15' },
          { USERNAME: 'BI_READER', ACCOUNT_STATUS: 'EXPIRED', EXPIRY_DATE: '2026-05-01', LOCK_DATE: '', PROFILE: 'DEFAULT', CREATED: '2023-06-10' }
        ],
        locked: [
          { USERNAME: 'REPORTING', ACCOUNT_STATUS: 'LOCKED', EXPIRY_DATE: '', LOCK_DATE: '2026-05-10', PROFILE: 'DEFAULT', CREATED: '2021-03-20' }
        ],
        expiring_soon: [
          { USERNAME: 'EBS_READER', ACCOUNT_STATUS: 'OPEN', EXPIRY_DATE: '2026-06-01', LOCK_DATE: '', PROFILE: 'DEFAULT', CREATED: '2020-01-01' }
        ],
        default_passwords: [],
        severity: 'yellow'
      });
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const result = await oracle.queryExpiredUsers(buildConnParams(hc));
    res.json(result);
  } catch (err) {
    console.error('[db-diagnostics] expired-users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user account status' });
  }
});

// ─── DATA GUARD / FLASHBACK ───────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/dataguard-status
 *
 * Returns Flashback database status and Data Guard standby lag.
 * Requires V$DATABASE, V$DATAGUARD_STATS access (EE).
 */
router.post('/health-checks/:id/dataguard-status', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json({
        flashback_on: true,
        flashback_size_gb: 12.5,
        db_role: 'PRIMARY',
        db_unique_name: 'ORCL_PROD',
        standby_databases: [
          { APPLY_LAG: '+00 00:04:32.000000', TRANSPORT_LAG: '+00 00:00:03.000000', APPLY_FINISH_TIME: '+00 00:00:01.000000' }
        ],
        apply_lag_minutes: 4,
        severity: 'green'
      });
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const result = await oracle.queryDataGuardStatus(buildConnParams(hc));
    res.json(result);
  } catch (err) {
    console.error('[db-diagnostics] dataguard-status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Data Guard / Flashback status' });
  }
});

// ─── RECYCLEBIN ───────────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/recyclebin
 *
 * Returns recyclebin space consumption by owner and the 20 largest objects.
 * Available on all Oracle editions (10g+).
 */
router.post('/health-checks/:id/recyclebin', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json({
        total_objects: 247,
        total_size_mb: 1842.5,
        by_owner: [
          { OWNER: 'APPS', OBJECT_COUNT: 180, SIZE_MB: 1420.0 },
          { OWNER: 'SH', OBJECT_COUNT: 42, SIZE_MB: 312.5 },
          { OWNER: 'HR', OBJECT_COUNT: 25, SIZE_MB: 110.0 }
        ],
        largest_objects: [
          { OWNER: 'APPS', ORIGINAL_NAME: 'FND_LOG_MESSAGES', TYPE: 'TABLE', SIZE_MB: 680.0, DROPTIME: '2026-05-10 14:32' },
          { OWNER: 'SH', ORIGINAL_NAME: 'SALES_ARCHIVE_2024', TYPE: 'TABLE', SIZE_MB: 280.5, DROPTIME: '2026-05-08 09:15' }
        ],
        recyclebin_enabled: true,
        severity: 'yellow'
      });
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const result = await oracle.queryRecyclebin(buildConnParams(hc));
    res.json(result);
  } catch (err) {
    console.error('[db-diagnostics] recyclebin error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recyclebin usage' });
  }
});

// ─── DATABASE LINKS ───────────────────────────────────────────────────────────

/**
 * POST /api/health-checks/:id/db-links
 *
 * Enumerates all database links and probes PUBLIC + owned links for connectivity.
 * Available on all Oracle editions.
 */
router.post('/health-checks/:id/db-links', requireAuth, async (req, res) => {
  try {
    const hc = await loadHcAndGuard(req, res);
    if (!hc) return;

    if (hc.is_demo) {
      return res.json({
        links: [
          { OWNER: 'PUBLIC', DB_LINK: 'DW_LINK.WORLD', USERNAME: 'DW_USER', HOST: '10.0.1.50:1521/dwdb', CREATED: '2023-06-01', STATUS: 'ok', ERROR: '' },
          { OWNER: 'APPS', DB_LINK: 'REPORTS.CORP.COM', USERNAME: 'REPORTS_RO', HOST: 'reports-db.corp.com:1521/rptdb', CREATED: '2022-11-15', STATUS: 'failed', ERROR: 'ORA-12541: TNS:no listener' },
          { OWNER: 'PUBLIC', DB_LINK: 'HR_LINK.WORLD', USERNAME: 'HR_READONLY', HOST: 'hr-db.internal:1521/hrdb', CREATED: '2021-01-20', STATUS: 'ok', ERROR: '' }
        ],
        failed_count: 1,
        ok_count: 2,
        severity: 'red'
      });
    }

    const oracle = getOracleClient();
    if (!oracle) return res.status(503).json({ error: 'Oracle client not available' });

    const result = await oracle.queryDatabaseLinks(buildConnParams(hc));
    res.json(result);
  } catch (err) {
    console.error('[db-diagnostics] db-links error:', err.message);
    res.status(500).json({ error: 'Failed to fetch database link status' });
  }
});

module.exports = router;
