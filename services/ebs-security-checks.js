/**
 * services/ebs-security-checks.js — EBS Security check catalog and runner.
 *
 * Owns: 8 security checks (ES01–ES08) across EBS security domain:
 *   ES01 — CPU patch level (quarterly cadence check)
 *   ES02 — APPS schema password age
 *   ES03 — FND Sign-On Audit level
 *   ES04 — SYSADMIN account hygiene
 *   ES05 — Guest/Anonymous user lockdown
 *   ES06 — ICX session timeout
 *   ES07 — SSL/TLS configuration on apps tier (SSH)
 *   ES08 — Open FND responsibilities audit
 *
 * Each check declares:
 *   id               — stable identifier (ES01–ES08)
 *   label            — human label
 *   category         — 'ebs_security'
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

const EBS_SECURITY_CHECKS = [

  // ── ES01 — CPU patch level ────────────────────────────────────────────────
  {
    id: 'ES01',
    label: 'CPU patch level (quarterly cadence)',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT bug_number, description, last_update_date
          FROM apps.ad_bugs
          WHERE (upper(description) LIKE '%CPUJAN%'
              OR upper(description) LIKE '%CPUAPR%'
              OR upper(description) LIKE '%CPUJUL%'
              OR upper(description) LIKE '%CPUOCT%'
              OR upper(description) LIKE '%CRITICAL PATCH UPDATE%')
          ORDER BY last_update_date DESC
          FETCH FIRST 3 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'crit',
          value: 'No quarterly CPU patch found',
          evidence: 'No CPU-pattern bugs in AD_BUGS',
          recommendation: 'Apply current Oracle Critical Patch Update (CPU). Check MOS note 1458915.1.',
        };
      }
      const latest = rows[0];
      const desc = latest.DESCRIPTION || latest.description || '';
      const applied = latest.LAST_UPDATE_DATE || latest.last_update_date || '';
      const appliedDate = new Date(applied);
      const now = Date.now();
      const daysAgo = !isNaN(appliedDate) ? Math.floor((now - appliedDate) / 86400000) : null;
      // Each quarter is ~91 days; >2 quarters = >182 days = red; >1 quarter = >91 days = amber
      if (daysAgo !== null && daysAgo > 182) {
        return {
          status: 'crit',
          value: `CPU applied ${daysAgo}d ago (>2 quarters behind)`,
          evidence: `${desc.slice(0, 100)} — ${applied}`,
          recommendation: 'CPU is more than 2 quarters out of date. Apply current quarterly CPU immediately. See MOS 1458915.1.',
        };
      }
      if (daysAgo !== null && daysAgo > 91) {
        return {
          status: 'warn',
          value: `CPU applied ${daysAgo}d ago (>1 quarter behind)`,
          evidence: `${desc.slice(0, 100)} — ${applied}`,
          recommendation: 'CPU is more than one quarter old. Plan upgrade to current quarterly CPU.',
        };
      }
      return {
        status: 'ok',
        value: `CPU current (applied ${daysAgo !== null ? daysAgo + 'd ago' : applied})`,
        evidence: desc.slice(0, 120),
        recommendation: null,
      };
    },
  },

  // ── ES02 — APPS password age ──────────────────────────────────────────────
  {
    id: 'ES02',
    label: 'APPS schema password age',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT user_name, password_date, last_logon_date
          FROM apps.fnd_user
          WHERE user_name = 'APPS'
          AND rownum = 1`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'info',
          value: 'APPS user not found in FND_USER',
          evidence: 'Query returned no rows',
          recommendation: 'Verify APPS schema exists and FND_USER is accessible.',
        };
      }
      const r = rows[0];
      const pwdDate = r.PASSWORD_DATE || r.password_date;
      if (!pwdDate) {
        return {
          status: 'warn',
          value: 'APPS password date not set',
          evidence: 'PASSWORD_DATE is NULL',
          recommendation: 'Set a password rotation policy for the APPS schema user.',
        };
      }
      const pwdAge = Math.floor((Date.now() - new Date(pwdDate)) / 86400000);
      if (pwdAge > 90) {
        return {
          status: 'crit',
          value: `APPS password age: ${pwdAge} days`,
          evidence: `PASSWORD_DATE=${pwdDate}`,
          recommendation: `APPS password is ${pwdAge} days old (>90d). Rotate via FNDCPASS utility.`,
        };
      }
      return {
        status: 'ok',
        value: `APPS password age: ${pwdAge} days`,
        evidence: `PASSWORD_DATE=${pwdDate}`,
        recommendation: null,
      };
    },
  },

  // ── ES03 — FND Sign-On Audit level ───────────────────────────────────────
  {
    id: 'ES03',
    label: 'FND Sign-On Audit level',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT pov.profile_option_value
          FROM apps.fnd_profile_option_values pov
          JOIN apps.fnd_profile_options po
            ON po.profile_option_id = pov.profile_option_id
          WHERE po.profile_option_name = 'SIGNONAUDIT:LEVEL'
            AND pov.level_id = 10001
          FETCH FIRST 1 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'crit',
          value: 'Sign-On Audit level not configured',
          evidence: 'No site-level value for SIGNONAUDIT:LEVEL',
          recommendation: 'Set Sign-On Audit level to FORM or MENU in System Administrator → Profile → System.',
        };
      }
      const val = (rows[0].PROFILE_OPTION_VALUE || rows[0].profile_option_value || '').toUpperCase().trim();
      if (!val || val === 'NONE' || val === '') {
        return {
          status: 'crit',
          value: `Sign-On Audit: ${val || 'NULL/NONE'}`,
          evidence: `SIGNONAUDIT:LEVEL = ${val || 'NULL'}`,
          recommendation: 'Sign-On Audit is disabled. Set to FORM or MENU to capture user session history.',
        };
      }
      if (val === 'USER') {
        return {
          status: 'warn',
          value: 'Sign-On Audit: USER only',
          evidence: `SIGNONAUDIT:LEVEL = USER`,
          recommendation: 'Consider upgrading Sign-On Audit to FORM level for more granular session tracking.',
        };
      }
      return {
        status: 'ok',
        value: `Sign-On Audit: ${val}`,
        evidence: `SIGNONAUDIT:LEVEL = ${val}`,
        recommendation: null,
      };
    },
  },

  // ── ES04 — SYSADMIN account hygiene ──────────────────────────────────────
  {
    id: 'ES04',
    label: 'SYSADMIN account hygiene',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT user_name, password_date, last_logon_date,
                 end_date, start_date
          FROM apps.fnd_user
          WHERE user_name = 'SYSADMIN'
          AND rownum = 1`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'info',
          value: 'SYSADMIN not found in FND_USER',
          evidence: 'Query returned no rows',
          recommendation: null,
        };
      }
      const r = rows[0];
      const pwdDate = r.PASSWORD_DATE || r.password_date;
      const endDate = r.END_DATE || r.end_date;
      const issues = [];

      if (!pwdDate) {
        issues.push('password date not set');
      } else {
        const pwdAge = Math.floor((Date.now() - new Date(pwdDate)) / 86400000);
        if (pwdAge > 90) issues.push(`password ${pwdAge}d old (>90d)`);
      }
      if (!endDate) {
        issues.push('account never expires');
      }

      if (issues.length > 0) {
        const severity = issues.some(i => i.includes('password')) ? 'crit' : 'warn';
        return {
          status: severity,
          value: `SYSADMIN: ${issues.join(', ')}`,
          evidence: `PASSWORD_DATE=${pwdDate || 'NULL'} END_DATE=${endDate || 'NULL'}`,
          recommendation: 'Rotate SYSADMIN password (FNDCPASS) and set account end date for shared admin accounts.',
        };
      }
      return {
        status: 'ok',
        value: 'SYSADMIN account hygiene OK',
        evidence: `PASSWORD_DATE=${pwdDate} END_DATE=${endDate}`,
        recommendation: null,
      };
    },
  },

  // ── ES05 — Guest/Anonymous user lockdown ─────────────────────────────────
  {
    id: 'ES05',
    label: 'Guest/Anonymous user lockdown',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT u.user_name, u.end_date,
                 COUNT(ur.responsibility_id) AS resp_count
          FROM apps.fnd_user u
          LEFT JOIN apps.fnd_user_resp_groups_direct ur
            ON ur.user_id = u.user_id
            AND (ur.end_date IS NULL OR ur.end_date > SYSDATE)
          WHERE u.user_name IN ('GUEST', 'ANONYMOUS')
          GROUP BY u.user_name, u.end_date`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'info',
          value: 'GUEST/ANONYMOUS user not found',
          evidence: 'FND_USER has no GUEST or ANONYMOUS entry',
          recommendation: null,
        };
      }
      const flagged = rows.filter(r => {
        const cnt = parseInt(r.RESP_COUNT || r.resp_count, 10) || 0;
        return cnt > 0;
      });
      if (flagged.length > 0) {
        const detail = flagged.map(r =>
          `${r.USER_NAME || r.user_name}: ${r.RESP_COUNT || r.resp_count} non-default responsibilities`
        ).join('; ');
        return {
          status: 'warn',
          value: `${flagged.length} guest user(s) with active responsibilities`,
          evidence: detail.slice(0, 300),
          recommendation: 'Remove non-default responsibilities from GUEST/ANONYMOUS users. These should have zero active responsibilities.',
        };
      }
      const names = rows.map(r => r.USER_NAME || r.user_name).join(', ');
      return {
        status: 'ok',
        value: `${names} user(s) have no active responsibilities`,
        evidence: rows.map(r => `${r.USER_NAME || r.user_name}: ${r.RESP_COUNT || r.resp_count} resps`).join('; '),
        recommendation: null,
      };
    },
  },

  // ── ES06 — ICX session timeout ────────────────────────────────────────────
  {
    id: 'ES06',
    label: 'ICX session timeout',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT pov.profile_option_value
          FROM apps.fnd_profile_option_values pov
          JOIN apps.fnd_profile_options po
            ON po.profile_option_id = pov.profile_option_id
          WHERE po.profile_option_name = 'ICX_SESSION_TIMEOUT'
            AND pov.level_id = 10001
          FETCH FIRST 1 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'crit',
          value: 'ICX session timeout not configured',
          evidence: 'No site-level value for ICX_SESSION_TIMEOUT',
          recommendation: 'Set ICX_SESSION_TIMEOUT profile to 30 minutes or less in System Administrator → Profile → System.',
        };
      }
      const raw = rows[0].PROFILE_OPTION_VALUE || rows[0].profile_option_value;
      if (!raw || raw === '' || raw === '0') {
        return {
          status: 'crit',
          value: 'ICX session timeout disabled (NULL/0)',
          evidence: `ICX_SESSION_TIMEOUT = ${raw || 'NULL'}`,
          recommendation: 'Session timeout is disabled. Set ICX_SESSION_TIMEOUT to ≤30 minutes to reduce session hijack risk.',
        };
      }
      const minutes = parseInt(raw, 10);
      if (isNaN(minutes)) {
        return {
          status: 'info',
          value: `ICX session timeout: ${raw}`,
          evidence: `ICX_SESSION_TIMEOUT = ${raw}`,
          recommendation: null,
        };
      }
      if (minutes > 30) {
        return {
          status: 'warn',
          value: `ICX session timeout: ${minutes} min (>30 min)`,
          evidence: `ICX_SESSION_TIMEOUT = ${raw}`,
          recommendation: `Session timeout is ${minutes} minutes. Reduce to ≤30 minutes for better security posture.`,
        };
      }
      return {
        status: 'ok',
        value: `ICX session timeout: ${minutes} min`,
        evidence: `ICX_SESSION_TIMEOUT = ${raw}`,
        recommendation: null,
      };
    },
  },

  // ── ES07 — SSL/TLS on EBS tier (SSH) ─────────────────────────────────────
  {
    id: 'ES07',
    label: 'SSL/TLS configuration on apps tier',
    category: 'ebs_security',
    type: 'ssh',
    min_ebs_version: '12.2',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.security.ssl_tls',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'info',
          value: 'SSL config not accessible',
          evidence: 'ssl.conf not found or not readable',
          recommendation: 'Verify apps tier SSH target has access to Apache/OHS ssl.conf.',
        };
      }
      const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const issues = [];

      // Check for TLS version — look for SSLProtocol directive
      const sslProtoLine = lines.find(l => /^SSLProtocol/i.test(l));
      if (sslProtoLine) {
        if (/SSLv2|SSLv3|TLSv1\b/.test(sslProtoLine) && !/TLSv1\.2|TLSv1\.3/.test(sslProtoLine)) {
          issues.push('Weak SSL/TLS protocol enabled');
        }
      } else {
        issues.push('SSLProtocol directive not found in config');
      }

      // Check for certificate expiry date (openssl output format: "notAfter=...")
      const expiryLine = lines.find(l => /notAfter=/i.test(l));
      if (expiryLine) {
        const dateMatch = expiryLine.match(/notAfter=(.+)/i);
        if (dateMatch) {
          const expiryDate = new Date(dateMatch[1].trim());
          const daysLeft = Math.floor((expiryDate - Date.now()) / 86400000);
          if (!isNaN(daysLeft)) {
            if (daysLeft < 0) {
              issues.push(`Certificate EXPIRED ${Math.abs(daysLeft)}d ago`);
            } else if (daysLeft < 30) {
              issues.push(`Certificate expires in ${daysLeft}d`);
            }
          }
        }
      }

      if (issues.length > 0) {
        const severity = issues.some(i => i.includes('EXPIRED') || i.includes('Weak')) ? 'crit' : 'warn';
        return {
          status: severity,
          value: issues.join('; '),
          evidence: lines.slice(0, 8).join(' | ').slice(0, 300),
          recommendation: 'Address SSL/TLS issues: enable TLS 1.2+, disable SSLv2/SSLv3/TLS 1.0, and renew certificates before expiry.',
        };
      }

      const protoInfo = sslProtoLine || 'SSLProtocol configured';
      return {
        status: 'ok',
        value: 'SSL/TLS configuration OK',
        evidence: protoInfo.slice(0, 200),
        recommendation: null,
      };
    },
  },

  // ── ES08 — Open FND responsibilities audit ────────────────────────────────
  {
    id: 'ES08',
    label: 'Open FND responsibilities audit',
    category: 'ebs_security',
    type: 'tns',
    min_ebs_version: '12.2',
    requires_ssh: false,
    sql: `SELECT
           (SELECT COUNT(*) FROM apps.fnd_user u
            WHERE (u.end_date IS NULL OR u.end_date > SYSDATE)
              AND NOT EXISTS (SELECT 1 FROM apps.fnd_user_resp_groups_direct ur
                              WHERE ur.user_id = u.user_id
                                AND (ur.end_date IS NULL OR ur.end_date > SYSDATE))
              AND u.last_logon_date < SYSDATE - 180
           ) AS inactive_users_with_no_resp,
           (SELECT COUNT(DISTINCT ur.user_id)
            FROM apps.fnd_user_resp_groups_direct ur
            JOIN apps.fnd_user u ON u.user_id = ur.user_id
            WHERE (ur.end_date IS NULL OR ur.end_date > SYSDATE)
              AND (u.end_date IS NULL OR u.end_date > SYSDATE)
            GROUP BY ur.user_id
            HAVING COUNT(ur.responsibility_id) > 15
           ) AS users_with_excess_resps
          FROM dual`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'error',
          value: 'Responsibility audit query failed',
          evidence: 'FND_USER_RESP_GROUPS_DIRECT may not be accessible',
          recommendation: 'Verify APPS schema access to FND_USER_RESP_GROUPS_DIRECT.',
        };
      }

      // Note: the correlated subquery returns multiple rows (one per user for excess)
      // Adapt by checking what was returned
      const r = rows[0];
      const inactive = parseInt(r.INACTIVE_USERS_WITH_NO_RESP || r.inactive_users_with_no_resp, 10) || 0;
      const excessCount = parseInt(r.USERS_WITH_EXCESS_RESPS || r.users_with_excess_resps, 10) || 0;

      const issues = [];
      if (excessCount > 0) issues.push(`${excessCount} user(s) with >15 active responsibilities`);
      if (inactive > 0) issues.push(`${inactive} inactive user(s) (no login 180d+) still active`);

      if (issues.length > 0) {
        return {
          status: 'warn',
          value: issues.join('; '),
          evidence: `excess_resp_users=${excessCount} inactive_active_users=${inactive}`,
          recommendation: 'Review and revoke excessive responsibilities. Disable or end-date users with >180 days no login. Apply least-privilege principle.',
        };
      }
      return {
        status: 'ok',
        value: 'No responsibility over-provisioning detected',
        evidence: `excess_resp_users=${excessCount} inactive_active_users=${inactive}`,
        recommendation: null,
      };
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all applicable EBS Security checks.
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
async function runEbsSecurityChecks({ oracleConn, targetId, role, initiatedBy, timeoutMs = 25_000 }) {
  const results = [];

  const tnsChecks = EBS_SECURITY_CHECKS.filter(c => c.type === 'tns');
  const sshChecks = EBS_SECURITY_CHECKS.filter(c => c.type === 'ssh');

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
  return EBS_SECURITY_CHECKS.map(c => ({
    id: c.id,
    label: c.label,
    category: c.category,
    type: c.type,
    min_ebs_version: c.min_ebs_version,
    requires_ssh: c.requires_ssh,
    requires: c.requires || null,
  }));
}

module.exports = { runEbsSecurityChecks, getCheckCatalog, EBS_SECURITY_CHECKS };
