/**
 * services/ebs-ssh-checks.js — EBS SSH check catalog and runner.
 *
 * Owns: Check registry (metadata + parsers), runSshChecks() orchestrator.
 * Does NOT own: SSH session lifecycle (ssh-executor.js), credential storage,
 *               Oracle connection auth, HTTP routing.
 *
 * Each check in SSH_CHECKS defines:
 *   id          — stable identifier; used as key in results
 *   label       — human label shown in UI
 *   category    — one of: filesystem, adop, concurrent_managers, weblogic, logs
 *   command_key — key in ssh-executor COMMAND_WHITELIST
 *   requires    — 'apps_tier' | 'db_tier' | 'any'
 *   parse(stdout, stderr, exitCode) → { status, value, evidence, recommendation }
 *     status: 'ok' | 'warn' | 'crit' | 'info' | 'error'
 *     value:  human-readable primary metric (e.g. "12% used")
 *     evidence: short string with raw data backing the status
 *     recommendation: action text (shown only on warn/crit)
 */

'use strict';

const executor = require('./ssh-executor');

// ─── Check registry ──────────────────────────────────────────────────────────

const SSH_CHECKS = [

  // ── Filesystem — apps tier ───────────────────────────────────────────────

  {
    id: 'fs.appl_top',
    label: '$APPL_TOP free space',
    category: 'filesystem',
    command_key: 'ebs.fs.appl_top',
    requires: 'apps_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.inst_top',
    label: '$INST_TOP free space',
    category: 'filesystem',
    command_key: 'ebs.fs.inst_top',
    requires: 'apps_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.oracle_home_apps',
    label: '$ORACLE_HOME (apps tier) free space',
    category: 'filesystem',
    command_key: 'ebs.fs.oracle_home_apps',
    requires: 'apps_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.tmp',
    label: '/tmp free space',
    category: 'filesystem',
    command_key: 'ebs.fs.tmp',
    requires: 'apps_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.conc_log',
    label: 'Concurrent log directory size',
    category: 'filesystem',
    command_key: 'ebs.fs.conc_log',
    requires: 'apps_tier',
    parse: parseDuOutput,
  },
  {
    id: 'fs.conc_out',
    label: 'Concurrent output directory size',
    category: 'filesystem',
    command_key: 'ebs.fs.conc_out',
    requires: 'apps_tier',
    parse: parseDuOutput,
  },
  {
    id: 'fs.adop_staging',
    label: 'ADOP patch staging area size',
    category: 'filesystem',
    command_key: 'ebs.fs.adop_staging',
    requires: 'apps_tier',
    parse: parseDuOutput,
  },

  // ── Filesystem — DB tier ─────────────────────────────────────────────────

  {
    id: 'fs.oracle_home_db',
    label: '$ORACLE_HOME (DB tier) free space',
    category: 'filesystem',
    command_key: 'oracle.fs.oracle_home',
    requires: 'db_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.archive_dest',
    label: 'Archive log destination free space',
    category: 'filesystem',
    command_key: 'oracle.fs.archive_dest',
    requires: 'db_tier',
    parse: parseDfOutput,
  },
  {
    id: 'fs.audit_dest',
    label: 'Audit file destination growth',
    category: 'filesystem',
    command_key: 'oracle.fs.audit_dest',
    requires: 'db_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return { status: 'info', value: 'Not found', evidence: 'adump path not located', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const fileCount = lines.length;
      return {
        status: 'info',
        value: `${fileCount} recent audit files`,
        evidence: lines.slice(0, 3).join('; '),
        recommendation: fileCount > 50
          ? 'Large number of audit files. Consider rotating audit_file_dest.'
          : null,
      };
    },
  },

  // ── adop / patching ──────────────────────────────────────────────────────

  {
    id: 'adop.fs_current',
    label: 'Current run filesystem (fs1/fs2)',
    category: 'adop',
    command_key: 'ebs.adop.fs_current',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return { status: 'info', value: 'fs_ne symlink not found', evidence: '', recommendation: null };
      }
      const link = stdout.trim();
      const fs = link.match(/fs(\d)/) ? 'fs' + link.match(/fs(\d)/)[1] : link;
      return { status: 'info', value: fs, evidence: link, recommendation: null };
    },
  },
  {
    id: 'adop.phase_status',
    label: 'ADOP phase in-progress',
    category: 'adop',
    command_key: 'ebs.adop.phase_status',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_ACTIVE_ADOP_LOG') || !stdout.trim()) {
        return { status: 'ok', value: 'No active ADOP session', evidence: '', recommendation: null };
      }
      const lower = stdout.toLowerCase();
      if (lower.includes('failed') || lower.includes('error')) {
        return {
          status: 'crit',
          value: 'ADOP phase may have errors',
          evidence: stdout.trim().slice(0, 200),
          recommendation: 'Check ADOP log for FAILED status. Run `adop -status` to confirm.',
        };
      }
      if (lower.includes('running') || lower.includes('in progress') || lower.includes('applying')) {
        return {
          status: 'warn',
          value: 'ADOP patch in progress',
          evidence: stdout.trim().slice(0, 200),
          recommendation: 'An ADOP cycle appears active. Monitor until complete.',
        };
      }
      return { status: 'info', value: 'ADOP log found', evidence: stdout.trim().slice(0, 200), recommendation: null };
    },
  },
  {
    id: 'adop.pending_cleanup',
    label: 'Pending ADOP cleanup',
    category: 'adop',
    command_key: 'ebs.adop.pending_cleanup',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_PENDING_CLEANUP') || !stdout.trim()) {
        return { status: 'ok', value: 'No pending cleanup', evidence: '', recommendation: null };
      }
      const count = stdout.trim().split('\n').filter(l => l.trim()).length;
      return {
        status: 'warn',
        value: `${count} pending cleanup directories`,
        evidence: stdout.trim().slice(0, 300),
        recommendation: 'Run `adop phase=cleanup` to free disk space from old patch filesystem.',
      };
    },
  },
  {
    id: 'adop.last_patch',
    label: 'Last patch applied',
    category: 'adop',
    command_key: 'ebs.adop.last_patch',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return { status: 'info', value: 'ad_patch.tail not found', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      // Last substantive line is the most recent patch action
      const summary = lines.slice(-3).join(' / ');
      return { status: 'info', value: 'Patch history available', evidence: summary, recommendation: null };
    },
  },

  // ── Concurrent Managers ──────────────────────────────────────────────────

  {
    id: 'cm.fndlibr_count',
    label: 'FNDLIBR worker process count',
    category: 'concurrent_managers',
    command_key: 'ebs.cm.fndlibr_count',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'error', value: 'No output', evidence: stderr || '', recommendation: 'Check SSH connectivity to apps tier.' };
      }
      const firstLine = stdout.trim().split('\n')[0];
      const count = parseInt(firstLine, 10);
      if (isNaN(count)) {
        return { status: 'info', value: firstLine, evidence: stdout.slice(0, 200), recommendation: null };
      }
      if (count === 0) {
        return {
          status: 'crit',
          value: '0 FNDLIBR processes',
          evidence: 'No FNDLIBR workers found on apps tier',
          recommendation: 'Concurrent Managers appear down. Check FND_CONCURRENT_QUEUES and restart Internal Concurrent Manager.',
        };
      }
      if (count < 3) {
        return {
          status: 'warn',
          value: `${count} FNDLIBR processes`,
          evidence: `Only ${count} worker(s) running`,
          recommendation: 'Low FNDLIBR count. Verify target_processes in FND_CONCURRENT_QUEUES matches expectations.',
        };
      }
      return { status: 'ok', value: `${count} FNDLIBR processes`, evidence: `${count} workers active`, recommendation: null };
    },
  },
  {
    id: 'cm.fndcrm',
    label: 'FNDCRM (ICM) process alive',
    category: 'concurrent_managers',
    command_key: 'ebs.cm.fndcrm',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_RUNNING') || !stdout.trim()) {
        return {
          status: 'crit',
          value: 'FNDCRM not running',
          evidence: 'No FNDCRM (Internal Concurrent Manager) process found',
          recommendation: 'Internal Concurrent Manager is down. Restart via SYSADMIN → Concurrent → Manager → Activate.',
        };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.includes('NOT_RUNNING'));
      if (lines.length === 0) {
        return {
          status: 'crit',
          value: 'FNDCRM not running',
          evidence: 'No FNDCRM process found',
          recommendation: 'Restart ICM via Concurrent Manager administration.',
        };
      }
      return { status: 'ok', value: 'FNDCRM running', evidence: lines[0].slice(0, 120), recommendation: null };
    },
  },
  {
    id: 'cm.opp',
    label: 'OPP process count and recent errors',
    category: 'concurrent_managers',
    command_key: 'ebs.cm.opp',
    requires: 'apps_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'info', value: 'OPP not checked', evidence: '', recommendation: null };
      }
      // First number after "--- OPP Processes ---" line
      const countMatch = stdout.match(/---\s*OPP Processes\s*---\s*\n(\d+)/i);
      const count = countMatch ? parseInt(countMatch[1], 10) : null;
      const hasErrors = stdout.toLowerCase().includes('error') && !stdout.includes('NO_OPP_LOG');
      const errorLines = stdout.split('\n').filter(l => /error/i.test(l)).slice(0, 5);

      if (count === 0) {
        return {
          status: 'crit',
          value: '0 OPP processes',
          evidence: 'Output Post Processor not running',
          recommendation: 'OPP is down. Check FND_CONCURRENT_QUEUES for Output Post Processor queue and restart.',
        };
      }
      if (hasErrors) {
        return {
          status: 'warn',
          value: count !== null ? `${count} OPP processes, errors in log` : 'OPP errors in log',
          evidence: errorLines.join('; ').slice(0, 200),
          recommendation: 'Review FNDOPP log for recurring errors. May indicate PDF generation failures.',
        };
      }
      if (count !== null) {
        return { status: 'ok', value: `${count} OPP processes`, evidence: 'No errors in recent OPP logs', recommendation: null };
      }
      return { status: 'info', value: 'OPP output available', evidence: stdout.slice(0, 200), recommendation: null };
    },
  },

  // ── WebLogic managed servers ─────────────────────────────────────────────

  {
    id: 'wls.oacore',
    label: 'OACore managed server state',
    category: 'weblogic',
    command_key: 'wls.oacore.status',
    requires: 'apps_tier',
    parse: parseAdmanagedOutput,
  },
  {
    id: 'wls.oafm',
    label: 'OAFM managed server state',
    category: 'weblogic',
    command_key: 'wls.oafm.status',
    requires: 'apps_tier',
    parse: parseAdmanagedOutput,
  },
  {
    id: 'wls.forms',
    label: 'Forms managed server state',
    category: 'weblogic',
    command_key: 'wls.forms.status',
    requires: 'apps_tier',
    parse: parseAdmanagedOutput,
  },
  {
    id: 'wls.adminserver',
    label: 'AdminServer state',
    category: 'weblogic',
    command_key: 'wls.adminserver.status',
    requires: 'apps_tier',
    parse: parseAdmanagedOutput,
  },

  // ── Logs ─────────────────────────────────────────────────────────────────

  {
    id: 'logs.listener_errors',
    label: 'Listener log TNS-12xxx errors (24h)',
    category: 'logs',
    command_key: 'oracle.listener.errors',
    requires: 'db_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_ERRORS') || !stdout.trim()) {
        return { status: 'ok', value: 'No TNS-12xxx errors in 24h', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      return {
        status: 'warn',
        value: `${lines.length} TNS-12xxx listener error(s) in 24h`,
        evidence: lines.slice(0, 3).join('; ').slice(0, 300),
        recommendation: 'Investigate listener.log. TNS-12541 = no listener; TNS-12170 = connect timeout; TNS-12537 = connection close.',
      };
    },
  },
  {
    id: 'logs.alert_critical',
    label: 'Alert log critical errors (ORA-600/7445/4031)',
    category: 'logs',
    command_key: 'oracle.alert.critical',
    requires: 'db_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_CRITICAL_ERRORS') || !stdout.trim()) {
        return { status: 'ok', value: 'No critical ORA errors in alert log', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const has600 = lines.some(l => l.includes('ORA-00600'));
      const has7445 = lines.some(l => l.includes('ORA-07445'));
      const has4031 = lines.some(l => l.includes('ORA-04031'));
      const worst = has600 || has7445 ? 'crit' : 'warn';
      return {
        status: worst,
        value: `${lines.length} critical error line(s) in alert log`,
        evidence: lines.slice(0, 5).join('; ').slice(0, 300),
        recommendation: has600
          ? 'ORA-00600 (internal error) detected. Open an Oracle SR immediately and capture incident package.'
          : has7445
          ? 'ORA-07445 (OS exception) detected. Check OS core files and open Oracle SR.'
          : 'ORA-04031 (shared pool exhausted). Consider flushing shared pool or increasing SGA.',
      };
    },
  },
  {
    id: 'logs.alert_ora_recent',
    label: 'Alert log last 10 ORA- errors',
    category: 'logs',
    command_key: 'oracle.alert.tail',
    requires: 'db_tier',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_ORA_ERRORS') || !stdout.trim()) {
        return { status: 'ok', value: 'No ORA- errors in recent alert log', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      return {
        status: 'info',
        value: `${lines.length} ORA- error line(s)`,
        evidence: lines.join('; ').slice(0, 400),
        recommendation: null,
      };
    },
  },
];

// ─── Shared parsers ───────────────────────────────────────────────────────────

/**
 * Parse `df -h` output for a single filesystem.
 * Looks for the "Use%" column and sets status based on thresholds.
 */
function parseDfOutput(stdout, stderr, exitCode) {
  if (!stdout || !stdout.trim()) {
    const notSet = stderr || stdout;
    if (notSet && (notSet.includes('NOT_SET') || notSet.includes('NOT_FOUND'))) {
      return { status: 'info', value: 'Path not set', evidence: 'Environment variable not defined', recommendation: null };
    }
    return { status: 'error', value: 'No df output', evidence: stderr || '', recommendation: 'Check SSH target role and environment variables.' };
  }

  // Parse Use% from df -h output (last data line)
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const pctMatch = lines[i].match(/(\d+)%/);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1], 10);
      const avail = lines[i].match(/\d+[KMGTP]?\s+(\d+[KMGTP]?)\s+\d+%/) ? lines[i].match(/\d+[KMGTP]?\s+(\d+[KMGTP]?)\s+\d+%/)[1] : '?';
      if (pct >= 90) {
        return {
          status: 'crit',
          value: `${pct}% used`,
          evidence: lines[i].trim(),
          recommendation: `Filesystem at ${pct}%. Immediately free space or expand the filesystem.`,
        };
      }
      if (pct >= 80) {
        return {
          status: 'warn',
          value: `${pct}% used`,
          evidence: lines[i].trim(),
          recommendation: `Filesystem at ${pct}%. Monitor closely and plan capacity expansion.`,
        };
      }
      return { status: 'ok', value: `${pct}% used (${avail} free)`, evidence: lines[i].trim(), recommendation: null };
    }
  }

  // Fallback: path not found sentinel
  if (stdout.includes('NOT_SET') || stdout.includes('NOT_FOUND') || stdout.includes('NOT_AVAILABLE')) {
    return { status: 'info', value: 'Path not available', evidence: stdout.trim().slice(0, 100), recommendation: null };
  }

  return { status: 'info', value: 'df output present', evidence: stdout.trim().slice(0, 150), recommendation: null };
}

/**
 * Parse `du -sh` output (single line: "12G /path").
 * Reports size as-is; warns on large dirs (>20G).
 */
function parseDuOutput(stdout, stderr, exitCode) {
  if (!stdout || !stdout.trim()) {
    return { status: 'info', value: 'Not found', evidence: 'Path not available or variable not set', recommendation: null };
  }
  if (stdout.includes('PATH_NOT_FOUND') || stdout.includes('NOT_FOUND') || stdout.includes('NOT_SET')) {
    return { status: 'info', value: 'Path not found', evidence: stdout.trim().slice(0, 100), recommendation: null };
  }
  const sizeMatch = stdout.trim().match(/^([\d.]+[KMGTP]?)/i);
  const size = sizeMatch ? sizeMatch[1] : stdout.trim().slice(0, 20);
  const numMatch = stdout.trim().match(/^([\d.]+)([KMGTP]?)/i);
  let status = 'info';
  if (numMatch) {
    const num = parseFloat(numMatch[1]);
    const unit = (numMatch[2] || '').toUpperCase();
    const gbApprox = unit === 'G' ? num : unit === 'T' ? num * 1024 : unit === 'M' ? num / 1024 : 0;
    if (gbApprox > 50) status = 'warn';
    else if (gbApprox > 20) status = 'info';
  }
  return {
    status,
    value: size,
    evidence: stdout.trim().slice(0, 150),
    recommendation: status === 'warn' ? 'Directory is large (>50GB). Review for purge opportunities.' : null,
  };
}

/**
 * Parse admanagedsrvctl.sh status output.
 * Looks for RUNNING / STOPPED / FAILED keywords.
 */
function parseAdmanagedOutput(stdout, stderr, exitCode) {
  if (!stdout || !stdout.trim() || stdout.includes('NOT_FOUND') || stdout.includes('NOT_AVAILABLE')) {
    return { status: 'info', value: 'admanagedsrvctl not available', evidence: stdout ? stdout.trim().slice(0, 100) : '', recommendation: null };
  }
  const upper = stdout.toUpperCase();
  if (upper.includes('RUNNING')) {
    return { status: 'ok', value: 'RUNNING', evidence: stdout.trim().slice(0, 200), recommendation: null };
  }
  if (upper.includes('FAILED') || upper.includes('FAILED_NOT_RESTARTABLE')) {
    return {
      status: 'crit',
      value: 'FAILED',
      evidence: stdout.trim().slice(0, 200),
      recommendation: 'Managed server is FAILED. Check WLS Admin Console for exception trace before restarting.',
    };
  }
  if (upper.includes('STOPPED') || upper.includes('DOWN') || upper.includes('SHUTDOWN')) {
    return {
      status: 'warn',
      value: 'STOPPED',
      evidence: stdout.trim().slice(0, 200),
      recommendation: 'Managed server is stopped. Start via admanagedsrvctl.sh start <server> or WLS Admin Console.',
    };
  }
  return { status: 'info', value: 'Status unknown', evidence: stdout.trim().slice(0, 200), recommendation: null };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all SSH checks applicable to a given SSH target.
 *
 * @param {number}   targetId     Row ID in ssh_targets
 * @param {string}   role         'apps_tier' | 'db_tier'
 * @param {string}   initiatedBy  User email
 * @param {Object}   [opts]
 * @param {number}   [opts.timeoutMs=20000]  Per-command SSH timeout
 * @param {number}   [opts.concurrency=6]    Max parallel SSH execs
 *
 * @returns {Promise<{
 *   checks: Array<{
 *     id, label, category, status, value, evidence, recommendation,
 *     durationMs, error: boolean
 *   }>,
 *   summary: { ok: number, warn: number, crit: number, info: number, error: number },
 *   ranAt: string
 * }>}
 */
async function runSshChecks({ targetId, role, initiatedBy, timeoutMs = 20_000, concurrency = 6 }) {
  // Filter to checks that match the target role
  const applicable = SSH_CHECKS.filter(c =>
    c.requires === 'any' || c.requires === role
  );

  // Run in batches to avoid overloading the SSH server
  const results = [];
  for (let i = 0; i < applicable.length; i += concurrency) {
    const batch = applicable.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(check => runSingleCheck(check, targetId, initiatedBy, timeoutMs))
    );
    results.push(...batchResults);
  }

  const summary = { ok: 0, warn: 0, crit: 0, info: 0, error: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  return { checks: results, summary, ranAt: new Date().toISOString() };
}

async function runSingleCheck(check, targetId, initiatedBy, timeoutMs) {
  try {
    const result = await executor.runCommand({
      targetId,
      commandKey: check.command_key,
      initiatedBy,
      timeoutMs,
    });

    if (result.rejected) {
      return {
        id: check.id,
        label: check.label,
        category: check.category,
        status: 'error',
        value: 'Command rejected',
        evidence: result.rejectionReason || '',
        recommendation: 'Check SSH target role configuration.',
        durationMs: result.durationMs,
        error: true,
      };
    }

    const parsed = check.parse(result.stdout, result.stderr, result.exitCode);
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      ...parsed,
      durationMs: result.durationMs,
      error: false,
    };
  } catch (err) {
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      status: 'error',
      value: 'Check failed',
      evidence: err.message || 'Unknown error',
      recommendation: null,
      durationMs: 0,
      error: true,
    };
  }
}

/**
 * Return the check catalog metadata (no parsers) — safe for API/UI use.
 */
function getCheckCatalog() {
  return SSH_CHECKS.map(c => ({
    id: c.id,
    label: c.label,
    category: c.category,
    command_key: c.command_key,
    requires: c.requires,
  }));
}

module.exports = { runSshChecks, getCheckCatalog, SSH_CHECKS };
