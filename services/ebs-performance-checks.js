/**
 * services/ebs-performance-checks.js — EBS Performance check catalog and runner.
 *
 * Owns: 6 performance checks (EP01–EP06) across EBS performance domain:
 *   EP01 — Concurrent request throughput (24h)
 *   EP02 — Workflow notification backlog
 *   EP03 — Forms session concurrency
 *   EP04 — OACore response time indicators (SSH)
 *   EP05 — Apache/OHS connection saturation (SSH)
 *   EP06 — DB session pressure from EBS (APPS schema sessions)
 *
 * Each check declares:
 *   id               — stable identifier (EP01–EP06)
 *   label            — human label
 *   category         — 'ebs_performance'
 *   type             — 'tns' | 'ssh'
 *   min_ebs_version  — '12.2' (all checks in this file)
 *   requires_ssh     — true | false
 *   requires         — 'apps_tier' | 'db_tier' | 'any' (SSH checks)
 *   command_key      — key in ssh-executor COMMAND_WHITELIST (SSH checks only)
 *   sql              — Oracle SQL string (TNS checks only)
 *   parse(result)    → { status, value, evidence, recommendation }
 *     status: 'ok' | 'warn' | 'crit' | 'info' | 'error'
 *
 * Does NOT own: SSH session lifecycle (ssh-executor.js), Oracle auth,
 *               HTTP routing, credential storage.
 */

'use strict';

const executor = require('./ssh-executor');

// ─── Check registry ──────────────────────────────────────────────────────────

const EBS_PERFORMANCE_CHECKS = [

  // ── EP01 — Concurrent request throughput ─────────────────────────────────
  {
    id: 'EP01',
    label: 'Concurrent request throughput (24h)',
    category: 'ebs_performance',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT
           COUNT(*) AS total_requests,
           SUM(CASE WHEN phase_code = 'C' AND status_code = 'C' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN phase_code = 'P' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN phase_code = 'R' THEN 1 ELSE 0 END) AS running,
           ROUND(AVG(CASE
             WHEN phase_code = 'C' AND actual_start_date IS NOT NULL AND actual_completion_date IS NOT NULL
             THEN (actual_completion_date - actual_start_date) * 1440
           END), 2) AS avg_runtime_min,
           ROUND(AVG(CASE
             WHEN actual_start_date IS NOT NULL AND requested_start_date IS NOT NULL
             THEN (actual_start_date - requested_start_date) * 1440
           END), 2) AS avg_wait_min
          FROM apps.fnd_concurrent_requests
          WHERE requested_start_date > SYSDATE - 1`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'error',
          value: 'FND_CONCURRENT_REQUESTS inaccessible',
          evidence: 'Query returned no rows',
          recommendation: 'Verify APPS schema access.',
        };
      }
      const r = rows[0];
      const total = parseInt(r.TOTAL_REQUESTS || r.total_requests, 10) || 0;
      const completed = parseInt(r.COMPLETED || r.completed, 10) || 0;
      const pending = parseInt(r.PENDING || r.pending, 10) || 0;
      const running = parseInt(r.RUNNING || r.running, 10) || 0;
      const avgWait = parseFloat(r.AVG_WAIT_MIN || r.avg_wait_min) || 0;
      const avgRuntime = parseFloat(r.AVG_RUNTIME_MIN || r.avg_runtime_min) || 0;

      if (avgWait > 10) {
        return {
          status: 'crit',
          value: `Avg wait time ${avgWait.toFixed(1)} min (>10 min threshold)`,
          evidence: `24h: total=${total} completed=${completed} pending=${pending} running=${running} avg_runtime=${avgRuntime.toFixed(1)}min`,
          recommendation: 'Concurrent request wait time exceeds 10 minutes. Increase ICM worker processes or reduce queue depth.',
        };
      }
      if (pending > 100) {
        return {
          status: 'warn',
          value: `${pending} pending requests, avg wait ${avgWait.toFixed(1)} min`,
          evidence: `24h: total=${total} completed=${completed} pending=${pending} running=${running}`,
          recommendation: 'High number of pending requests. Review Concurrent Manager capacity and queue assignments.',
        };
      }
      return {
        status: 'ok',
        value: `${completed} completed in 24h, avg wait ${avgWait.toFixed(1)} min`,
        evidence: `total=${total} pending=${pending} running=${running} avg_runtime=${avgRuntime.toFixed(1)}min`,
        recommendation: null,
      };
    },
  },

  // ── EP02 — Workflow notification backlog ──────────────────────────────────
  {
    id: 'EP02',
    label: 'Workflow notification backlog',
    category: 'ebs_performance',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT status, COUNT(*) AS cnt,
                 MAX(begin_date) AS newest,
                 MIN(begin_date) AS oldest
          FROM apps.wf_notifications
          GROUP BY status
          ORDER BY cnt DESC`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'info',
          value: 'WF_NOTIFICATIONS empty or inaccessible',
          evidence: 'Query returned no rows',
          recommendation: null,
        };
      }
      const openRow = rows.find(r => (r.STATUS || r.status || '').toUpperCase() === 'OPEN');
      const openCount = openRow ? parseInt(openRow.CNT || openRow.cnt, 10) || 0 : 0;
      const oldestOpen = openRow ? (openRow.OLDEST || openRow.oldest) : null;

      let oldestDays = null;
      if (oldestOpen) {
        const d = new Date(oldestOpen);
        oldestDays = !isNaN(d) ? Math.floor((Date.now() - d) / 86400000) : null;
      }

      const allSummary = rows.map(r =>
        `${r.STATUS || r.status}:${r.CNT || r.cnt}`
      ).join(', ');

      if (openCount > 5000 || (oldestDays !== null && oldestDays > 30)) {
        const severity = openCount > 5000 ? 'crit' : 'warn';
        return {
          status: severity,
          value: `${openCount} OPEN notifications${oldestDays !== null ? `, oldest ${oldestDays}d` : ''}`,
          evidence: allSummary.slice(0, 300),
          recommendation: 'Large WF notification backlog. Purge processed notifications and check Workflow Mailer status.',
        };
      }
      return {
        status: 'ok',
        value: `${openCount} OPEN notifications`,
        evidence: allSummary.slice(0, 300),
        recommendation: null,
      };
    },
  },

  // ── EP03 — Forms session concurrency ─────────────────────────────────────
  {
    id: 'EP03',
    label: 'Forms session concurrency',
    category: 'ebs_performance',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT
           (SELECT COUNT(*) FROM apps.icx_sessions
            WHERE disabled_reason IS NULL
              AND (last_connect + (limit_time/1440)) > SYSDATE
           ) AS active_icx_sessions,
           (SELECT COUNT(*) FROM v$session
            WHERE username = 'APPLSYSPUB' OR module LIKE '%FORMS%'
           ) AS forms_db_sessions`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'error',
          value: 'Forms session query failed',
          evidence: 'ICX_SESSIONS or V$SESSION not accessible',
          recommendation: 'Verify APPS schema access to ICX_SESSIONS and V$SESSION.',
        };
      }
      const r = rows[0];
      const icxSessions = parseInt(r.ACTIVE_ICX_SESSIONS || r.active_icx_sessions, 10) || 0;
      const formsDb = parseInt(r.FORMS_DB_SESSIONS || r.forms_db_sessions, 10) || 0;
      // Without formsweb.cfg SSH access we can only report the counts
      return {
        status: icxSessions > 500 ? 'warn' : 'ok',
        value: `${icxSessions} active ICX sessions, ${formsDb} Forms DB sessions`,
        evidence: `icx_active=${icxSessions} forms_db_sessions=${formsDb}`,
        recommendation: icxSessions > 500
          ? 'High Forms session count. Compare against maxConnections in formsweb.cfg and monitor for growth.'
          : null,
      };
    },
  },

  // ── EP04 — OACore response time indicators (SSH) ──────────────────────────
  {
    id: 'EP04',
    label: 'OACore response time indicators',
    category: 'ebs_performance',
    type: 'ssh',
    min_ebs_version: '12.2',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.perf.oacore_indicators',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'info',
          value: 'OACore indicators not available',
          evidence: 'oacore log/config not accessible via SSH',
          recommendation: 'Ensure apps_tier SSH target has read access to oacore logs and WLS config.xml.',
        };
      }
      const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const issues = [];

      // Parse GC frequency: look for lines with "GC" count from log grep
      const gcLine = lines.find(l => /^GC_COUNT=/i.test(l));
      if (gcLine) {
        const gcMatch = gcLine.match(/GC_COUNT=(\d+)/i);
        const gcCount = gcMatch ? parseInt(gcMatch[1], 10) : null;
        if (gcCount !== null && gcCount > 10) {
          issues.push(`GC ${gcCount}/min (>10 threshold)`);
        }
      }

      // Parse heap usage
      const heapLine = lines.find(l => /^HEAP_PCT=/i.test(l));
      if (heapLine) {
        const heapMatch = heapLine.match(/HEAP_PCT=([\d.]+)/i);
        const heapPct = heapMatch ? parseFloat(heapMatch[1]) : null;
        if (heapPct !== null && heapPct > 85) {
          issues.push(`Heap ${heapPct.toFixed(0)}% used (>85% threshold)`);
        }
      }

      // Parse thread pool
      const threadLine = lines.find(l => /^THREAD_PCT=/i.test(l));
      if (threadLine) {
        const threadMatch = threadLine.match(/THREAD_PCT=([\d.]+)/i);
        const threadPct = threadMatch ? parseFloat(threadMatch[1]) : null;
        if (threadPct !== null && threadPct > 85) {
          issues.push(`Thread pool ${threadPct.toFixed(0)}% active (>85%)`);
        }
      }

      if (issues.length > 0) {
        return {
          status: 'crit',
          value: issues.join('; '),
          evidence: lines.slice(0, 8).join(' | ').slice(0, 300),
          recommendation: 'OACore performance pressure detected. Increase heap (-Xmx), review GC algorithm, scale thread pool.',
        };
      }

      return {
        status: 'ok',
        value: 'OACore indicators within normal range',
        evidence: lines.slice(0, 6).join(' | ').slice(0, 300),
        recommendation: null,
      };
    },
  },

  // ── EP05 — Apache/OHS connection saturation (SSH) ─────────────────────────
  {
    id: 'EP05',
    label: 'Apache/OHS connection saturation',
    category: 'ebs_performance',
    type: 'ssh',
    min_ebs_version: '12.2',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.perf.apache_saturation',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'info',
          value: 'Apache saturation info unavailable',
          evidence: 'httpd process count or MaxClients not accessible',
          recommendation: 'Ensure apps_tier SSH target has access to Apache process list and httpd.conf.',
        };
      }
      const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);

      // Expected output format:
      //   HTTPD_CHILDREN=<n>
      //   MAX_CLIENTS=<n>
      const childLine = lines.find(l => /^HTTPD_CHILDREN=/i.test(l));
      const maxLine = lines.find(l => /^MAX_CLIENTS=/i.test(l));

      const children = childLine ? parseInt(childLine.split('=')[1], 10) : null;
      const maxClients = maxLine ? parseInt(maxLine.split('=')[1], 10) : null;

      if (children === null) {
        return {
          status: 'info',
          value: 'Apache child count not parsed',
          evidence: lines.slice(0, 4).join(' | ').slice(0, 200),
          recommendation: null,
        };
      }

      if (maxClients !== null && maxClients > 0) {
        const satPct = (children / maxClients) * 100;
        if (satPct >= 90) {
          return {
            status: 'crit',
            value: `${children}/${maxClients} Apache connections (${satPct.toFixed(0)}% saturation)`,
            evidence: `httpd_children=${children} MaxClients=${maxClients}`,
            recommendation: 'Apache near capacity. Increase MaxClients/MaxRequestWorkers in httpd.conf and restart OHS.',
          };
        }
        if (satPct >= 75) {
          return {
            status: 'warn',
            value: `${children}/${maxClients} Apache connections (${satPct.toFixed(0)}% saturation)`,
            evidence: `httpd_children=${children} MaxClients=${maxClients}`,
            recommendation: `Apache at ${satPct.toFixed(0)}% capacity. Plan for MaxClients increase before peak load.`,
          };
        }
        return {
          status: 'ok',
          value: `${children}/${maxClients} Apache connections (${satPct.toFixed(0)}%)`,
          evidence: `httpd_children=${children} MaxClients=${maxClients}`,
          recommendation: null,
        };
      }

      // No MaxClients parsed — just report child count
      if (children === 0) {
        return {
          status: 'crit',
          value: '0 Apache child processes',
          evidence: 'No httpd workers found',
          recommendation: 'Apache/OHS appears down. Check status with adoachectl.sh status.',
        };
      }
      return {
        status: 'info',
        value: `${children} Apache child processes`,
        evidence: lines.slice(0, 4).join(' | ').slice(0, 200),
        recommendation: null,
      };
    },
  },

  // ── EP06 — DB session pressure from EBS ──────────────────────────────────
  {
    id: 'EP06',
    label: 'DB session pressure from EBS (APPS sessions)',
    category: 'ebs_performance',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT
           (SELECT COUNT(*) FROM v$session WHERE username = 'APPS') AS apps_sessions,
           (SELECT value FROM v$parameter WHERE name = 'sessions') AS max_sessions`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'error',
          value: 'V$SESSION / V$PARAMETER not accessible',
          evidence: 'Query returned no rows',
          recommendation: 'Verify DBA-level access to V$SESSION and V$PARAMETER.',
        };
      }
      const r = rows[0];
      const appsSessions = parseInt(r.APPS_SESSIONS || r.apps_sessions, 10) || 0;
      const maxSessions = parseInt(r.MAX_SESSIONS || r.max_sessions, 10) || 0;

      if (maxSessions > 0) {
        const pct = (appsSessions / maxSessions) * 100;
        if (pct >= 80) {
          return {
            status: 'crit',
            value: `APPS: ${appsSessions}/${maxSessions} sessions (${pct.toFixed(0)}%)`,
            evidence: `apps_sessions=${appsSessions} max_sessions=${maxSessions}`,
            recommendation: 'APPS session count critically high. Investigate session leaks, consider increasing sessions parameter.',
          };
        }
        if (pct >= 60) {
          return {
            status: 'warn',
            value: `APPS: ${appsSessions}/${maxSessions} sessions (${pct.toFixed(0)}%)`,
            evidence: `apps_sessions=${appsSessions} max_sessions=${maxSessions}`,
            recommendation: `APPS sessions at ${pct.toFixed(0)}% of DB maximum. Monitor for growth and review connection pool settings.`,
          };
        }
        return {
          status: 'ok',
          value: `APPS: ${appsSessions}/${maxSessions} sessions (${pct.toFixed(0)}%)`,
          evidence: `apps_sessions=${appsSessions} max_sessions=${maxSessions}`,
          recommendation: null,
        };
      }

      // max_sessions not available
      return {
        status: appsSessions > 300 ? 'warn' : 'info',
        value: `${appsSessions} APPS sessions`,
        evidence: `apps_sessions=${appsSessions} (max_sessions unavailable)`,
        recommendation: appsSessions > 300
          ? 'High APPS session count. Compare against SESSIONS parameter and investigate if sessions are stale.'
          : null,
      };
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all applicable EBS Performance checks.
 *
 * @param {Object} opts
 * @param {Object}  [opts.oracleConn]   Oracle connection (for TNS checks)
 * @param {number}  [opts.targetId]     SSH target ID (for SSH checks)
 * @param {string}  [opts.role]         'apps_tier' | 'db_tier'
 * @param {string}  opts.initiatedBy    User email for audit log
 * @param {number}  [opts.timeoutMs]    Per-check timeout
 *
 * @returns {Promise<{checks, summary, ranAt}>}
 */
async function runEbsPerformanceChecks({ oracleConn, targetId, role, initiatedBy, timeoutMs = 25_000 }) {
  const results = [];

  const tnsChecks = EBS_PERFORMANCE_CHECKS.filter(c => c.type === 'tns');
  const sshChecks = EBS_PERFORMANCE_CHECKS.filter(c => c.type === 'ssh');

  if (oracleConn) {
    const TNS_CONCURRENCY = 6;
    for (let i = 0; i < tnsChecks.length; i += TNS_CONCURRENCY) {
      const batch = tnsChecks.slice(i, i + TNS_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(check => runTnsCheck(check, oracleConn)));
      results.push(...batchResults);
    }
  } else {
    for (const check of tnsChecks) {
      results.push(stubCheck(check, 'Requires Oracle connection', 'No active Oracle connection provided'));
    }
  }

  if (targetId && role) {
    const applicableSsh = sshChecks.filter(c => c.requires === 'any' || c.requires === role);
    const SSH_CONCURRENCY = 4;
    for (let i = 0; i < applicableSsh.length; i += SSH_CONCURRENCY) {
      const batch = applicableSsh.slice(i, i + SSH_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(check => runSshCheck(check, targetId, initiatedBy, timeoutMs))
      );
      results.push(...batchResults);
    }
    const inapplicable = sshChecks.filter(c => c.requires !== 'any' && c.requires !== role);
    for (const check of inapplicable) {
      results.push(stubCheck(check, `Requires ${check.requires} SSH target`, `Current role: ${role}`));
    }
  } else {
    for (const check of sshChecks) {
      results.push(stubCheck(check, 'Requires SSH target', 'Attach an apps_tier SSH target to run this check.'));
    }
  }

  const summary = { ok: 0, warn: 0, crit: 0, info: 0, error: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  return { checks: results, summary, ranAt: new Date().toISOString() };
}

function stubCheck(check, value, evidence) {
  return {
    id: check.id,
    label: check.label,
    category: check.category,
    status: 'info',
    value,
    evidence,
    recommendation: null,
    durationMs: 0,
    error: false,
  };
}

async function runTnsCheck(check, oracleConn) {
  const t0 = Date.now();
  try {
    const result = await oracleConn.execute(check.sql, [], { outFormat: oracleConn.OUT_FORMAT_OBJECT || 4002, fetchArraySize: 100 });
    const rows = result && result.rows ? result.rows : [];
    const parsed = check.parse(rows);
    return { id: check.id, label: check.label, category: check.category, ...parsed, durationMs: Date.now() - t0, error: false };
  } catch (err) {
    return {
      id: check.id, label: check.label, category: check.category,
      status: 'error', value: 'Check failed', evidence: err.message || 'Oracle query error',
      recommendation: null, durationMs: Date.now() - t0, error: true,
    };
  }
}

async function runSshCheck(check, targetId, initiatedBy, timeoutMs) {
  const t0 = Date.now();
  try {
    const result = await executor.runCommand({ targetId, commandKey: check.command_key, initiatedBy, timeoutMs });
    if (result.rejected) {
      return {
        id: check.id, label: check.label, category: check.category,
        status: 'error', value: 'Command rejected', evidence: result.rejectionReason || 'SSH command not in whitelist',
        recommendation: 'Check SSH target role configuration.', durationMs: result.durationMs || (Date.now() - t0), error: true,
      };
    }
    const parsed = check.parse(result.stdout, result.stderr, result.exitCode);
    return { id: check.id, label: check.label, category: check.category, ...parsed, durationMs: result.durationMs || (Date.now() - t0), error: false };
  } catch (err) {
    return {
      id: check.id, label: check.label, category: check.category,
      status: 'error', value: 'Check failed', evidence: err.message || 'Unknown error',
      recommendation: null, durationMs: Date.now() - t0, error: true,
    };
  }
}

/**
 * Return check catalog metadata — safe for API/UI use.
 */
function getCheckCatalog() {
  return EBS_PERFORMANCE_CHECKS.map(c => ({
    id: c.id,
    label: c.label,
    category: c.category,
    type: c.type,
    min_ebs_version: c.min_ebs_version,
    requires_ssh: c.requires_ssh,
    requires: c.requires || null,
  }));
}

module.exports = { runEbsPerformanceChecks, getCheckCatalog, EBS_PERFORMANCE_CHECKS };
