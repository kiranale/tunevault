/**
 * services/ssh-executor.js — SSH execution engine for TuneVault server-side checks.
 *
 * Owns: SSH session lifecycle, command whitelist enforcement, audit log writes,
 *       proxy routing for SSH targets linked to oracle_connections with proxy mode.
 * Does NOT own: credential storage (db/ssh-targets.js), route handling, Oracle queries.
 *
 * Security model:
 *   - Callers supply a command_key (string identifier), never a raw shell string.
 *   - command_key is looked up against COMMAND_WHITELIST — any unknown key is rejected
 *     before SSH is even attempted.
 *   - Decrypted credentials are kept in-process memory only; never logged.
 *   - All executions (allowed AND rejected) produce an ssh_audit row.
 *   - Default timeout 30 s, hard-kills the channel on expiry.
 *   - When target.connection_id is set and the linked oracle_connection has proxy
 *     mode configured, the SSH exec is forwarded to the proxy's /api/ssh/exec
 *     endpoint instead of connecting directly. Direct SSH is used as fallback.
 */

'use strict';

const { Client } = require('ssh2');
const https      = require('https');
const http       = require('http');
const { decrypt }  = require('../crypto-utils');
const db           = require('../db/ssh-targets');

// ─── Command whitelist ────────────────────────────────────────────────────────
// Map of command_key → { label, template, allowedRoles }
// template may contain {{OS_USER}} which is substituted at render time.
// Regex patterns in allowedPattern guard the rendered string before execution.

const COMMAND_WHITELIST = {
  // ── Generic system ────────────────────────────────────────────────────────
  'test.identity': {
    label: 'Test connection identity',
    template: 'whoami && hostname && uname -a',
    allowedRoles: ['apps_tier', 'db_tier', 'utility'],
  },
  'disk.usage': {
    label: 'Disk usage (mounted filesystems)',
    template: 'df -h | grep -v tmpfs',
    allowedRoles: ['apps_tier', 'db_tier', 'utility'],
  },
  'os.memory': {
    label: 'Memory usage summary',
    template: 'free -h',
    allowedRoles: ['apps_tier', 'db_tier', 'utility'],
  },
  'os.load': {
    label: 'CPU load and uptime',
    template: 'uptime && cat /proc/loadavg',
    allowedRoles: ['apps_tier', 'db_tier', 'utility'],
  },

  // ── Oracle listener / alert log ───────────────────────────────────────────
  'oracle.listener.status': {
    label: 'Listener status',
    template: 'lsnrctl status',
    allowedRoles: ['db_tier'],
  },
  // Check listener.log for TNS-12xxx errors in last 24h
  'oracle.listener.errors': {
    label: 'Listener log errors (24h)',
    template: "find $ORACLE_BASE/diag -name 'listener.log' | head -3 | xargs -I{} awk -v d=\"$(date -d '24 hours ago' '+%d-%b-%Y %H:%M:%S' 2>/dev/null || date -v-24H '+%d-%b-%Y %H:%M:%S' 2>/dev/null)\" '$0 >= d' {} 2>/dev/null | grep -iE 'TNS-12[0-9]{3}' | tail -50 || echo 'NO_ERRORS'",
    allowedRoles: ['db_tier'],
  },
  // Alert log: ORA-600 / ORA-7445 / ORA-4031 in last 24h
  'oracle.alert.critical': {
    label: 'Alert log critical errors (24h)',
    template: "find $ORACLE_BASE/diag -name 'alert_*.log' | head -3 | xargs tail -5000 2>/dev/null | grep -E 'ORA-00600|ORA-07445|ORA-04031' | tail -30 || echo 'NO_CRITICAL_ERRORS'",
    allowedRoles: ['db_tier'],
  },
  // Alert log: last 10 ORA- errors of any kind
  'oracle.alert.tail': {
    label: 'Alert log last 10 ORA- errors',
    template: "find $ORACLE_BASE/diag -name 'alert_*.log' | head -3 | xargs tail -10000 2>/dev/null | grep -E '^ORA-[0-9]' | tail -10 || echo 'NO_ORA_ERRORS'",
    allowedRoles: ['db_tier'],
  },
  // Alert log tail raw (last 100 lines)
  'oracle.alert.raw': {
    label: 'Alert log (last 100 lines)',
    template: "find $ORACLE_BASE/diag -name 'alert_*.log' -newer /tmp -exec tail -100 {} + 2>/dev/null | head -200",
    allowedRoles: ['db_tier'],
  },

  // ── Filesystem — apps tier ────────────────────────────────────────────────
  // $APPL_TOP free space
  'ebs.fs.appl_top': {
    label: '$APPL_TOP free space',
    template: "df -h $APPL_TOP 2>/dev/null || df -h $(dirname $APPL_TOP) 2>/dev/null || echo 'APPL_TOP_NOT_SET'",
    allowedRoles: ['apps_tier'],
  },
  // $INST_TOP free space
  'ebs.fs.inst_top': {
    label: '$INST_TOP free space',
    template: "df -h $INST_TOP 2>/dev/null || echo 'INST_TOP_NOT_SET'",
    allowedRoles: ['apps_tier'],
  },
  // $ORACLE_HOME (apps tier) free space
  'ebs.fs.oracle_home_apps': {
    label: '$ORACLE_HOME (apps tier) free space',
    template: "df -h $ORACLE_HOME 2>/dev/null || echo 'ORACLE_HOME_NOT_SET'",
    allowedRoles: ['apps_tier'],
  },
  // /tmp free space
  'ebs.fs.tmp': {
    label: '/tmp free space',
    template: "df -h /tmp",
    allowedRoles: ['apps_tier'],
  },
  // Concurrent log directory size ($APPLCSF/$APPLLOG)
  'ebs.fs.conc_log': {
    label: 'Concurrent log directory size',
    template: "du -sh ${APPLCSF}/${APPLLOG} 2>/dev/null || du -sh $APPLCSF/log 2>/dev/null || echo 'PATH_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // Concurrent output directory size ($APPLCSF/$APPLOUT)
  'ebs.fs.conc_out': {
    label: 'Concurrent output directory size',
    template: "du -sh ${APPLCSF}/${APPLOUT} 2>/dev/null || du -sh $APPLCSF/out 2>/dev/null || echo 'PATH_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // adop patch staging area size
  'ebs.fs.adop_staging': {
    label: 'ADOP patch staging size',
    template: "du -sh $APPL_TOP/../fs_ne 2>/dev/null || echo 'FS_NE_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── Filesystem — DB tier ──────────────────────────────────────────────────
  // $ORACLE_HOME (DB tier) free space
  'oracle.fs.oracle_home': {
    label: '$ORACLE_HOME (DB tier) free space',
    template: "df -h $ORACLE_HOME 2>/dev/null || echo 'ORACLE_HOME_NOT_SET'",
    allowedRoles: ['db_tier'],
  },
  // Archive log destination free space
  'oracle.fs.archive_dest': {
    label: 'Archive log destination free space',
    template: "if [ -n \"$ORACLE_BASE\" ]; then df -h $ORACLE_BASE/fast_recovery_area 2>/dev/null || df -h $ORACLE_BASE/oradata 2>/dev/null || df -h $ORACLE_BASE 2>/dev/null; else echo 'ORACLE_BASE_NOT_SET'; fi",
    allowedRoles: ['db_tier'],
  },
  // audit_file_dest growth — newest 5 audit files
  'oracle.fs.audit_dest': {
    label: 'Audit file destination recent files',
    template: "ls -lht $ORACLE_BASE/admin/*/adump 2>/dev/null | head -10 || ls -lht /u01/app/oracle/admin/*/adump 2>/dev/null | head -10 || echo 'AUDIT_DEST_NOT_FOUND'",
    allowedRoles: ['db_tier'],
  },

  // ── FMW OPatch inventory — used by /api/patches/fmw-inventory ───────────────
  // oracle_common lsinventory — lists patches applied to the shared FMW infrastructure home
  'fmw.opatch.oracle_common': {
    label: 'FMW oracle_common OPatch inventory',
    template: "$FMW_HOME/oracle_common/OPatch/opatch lsinventory -oh $FMW_HOME/oracle_common 2>&1 || echo 'ORACLE_COMMON_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // Oracle_Home (WLS) lsinventory — lists patches applied to the WebLogic/FMW Oracle Home
  'fmw.opatch.oracle_home': {
    label: 'FMW Oracle_Home (WLS) OPatch inventory',
    template: "$FMW_HOME/Oracle_Home/OPatch/opatch lsinventory -oh $FMW_HOME/Oracle_Home 2>&1 || echo 'ORACLE_HOME_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // DB ORACLE_HOME lsinventory — RU/CPU patches on the database tier
  'db.opatch.oracle_home': {
    label: 'DB ORACLE_HOME OPatch inventory',
    template: "$ORACLE_HOME/OPatch/opatch lsinventory -oh $ORACLE_HOME 2>&1 || echo 'DB_ORACLE_HOME_NOT_FOUND'",
    allowedRoles: ['db_tier'],
  },

  // ── adop / patching ───────────────────────────────────────────────────────
  // Current run filesystem (fs1 vs fs2)
  'ebs.adop.fs_current': {
    label: 'ADOP current run filesystem',
    template: "readlink $APPL_TOP/../fs_ne 2>/dev/null || echo 'FS_NE_SYMLINK_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // adop phase in-progress (last line of adop log)
  'ebs.adop.phase_status': {
    label: 'ADOP phase in-progress (last log line)',
    template: "find $APPL_TOP/../fs_ne/EBSapps/log/adop -name 'adop_*.log' -newer /tmp -exec tail -3 {} + 2>/dev/null | tail -20 || echo 'NO_ACTIVE_ADOP_LOG'",
    allowedRoles: ['apps_tier'],
  },
  // Pending cleanup detection
  'ebs.adop.pending_cleanup': {
    label: 'ADOP pending cleanup detection',
    template: "ls $APPL_TOP/../fs_ne/EBSapps/log/adop/*/cleanup 2>/dev/null | head -10 || echo 'NO_PENDING_CLEANUP'",
    allowedRoles: ['apps_tier'],
  },
  // Last patch applied
  'ebs.adop.last_patch': {
    label: 'Last patch applied (ad_patch.tail)',
    template: "cat $APPL_TOP/admin/ad_patch.tail 2>/dev/null | tail -20 || echo 'AD_PATCH_TAIL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── Concurrent Managers ───────────────────────────────────────────────────
  // FNDLIBR process count
  'ebs.cm.fndlibr_count': {
    label: 'FNDLIBR process count',
    template: "ps -ef | grep FNDLIBR | grep -v grep | wc -l && ps -ef | grep FNDLIBR | grep -v grep | head -10",
    allowedRoles: ['apps_tier'],
  },
  // FNDCRM (ICM) alive check
  'ebs.cm.fndcrm': {
    label: 'FNDCRM (ICM) process alive',
    template: "ps -ef | grep FNDCRM | grep -v grep | head -5 || echo 'FNDCRM_NOT_RUNNING'",
    allowedRoles: ['apps_tier'],
  },
  // OPP process count + recent log errors
  'ebs.cm.opp': {
    label: 'OPP process count and recent errors',
    template: "echo '--- OPP Processes ---' && ps -ef | grep FNDOPP | grep -v grep | wc -l && echo '--- Recent OPP Errors ---' && find $APPLCSF/log -name 'FNDOPP*.txt' -newer /tmp 2>/dev/null | xargs grep -i error 2>/dev/null | tail -50 || echo 'NO_OPP_LOG'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS config ────────────────────────────────────────────────────────────
  'ebs.adop.status': {
    label: 'ADOP phase status',
    template: 'adop -status 2>/dev/null || echo "adop not in PATH"',
    allowedRoles: ['apps_tier'],
  },
  'ebs.autoconfig.check': {
    label: 'AutoConfig context file check',
    template: 'ls -lh $CONTEXT_FILE 2>/dev/null && xmllint --xpath "string(//CONTEXT_NAME)" $CONTEXT_FILE 2>/dev/null',
    allowedRoles: ['apps_tier'],
  },
  'ebs.opmn.status': {
    label: 'OPMN process status (opmnctl)',
    template: 'opmnctl status 2>/dev/null || echo "opmnctl not found"',
    allowedRoles: ['apps_tier'],
  },
  // Legacy CM process check (raw ps)
  'ebs.cm.status': {
    label: 'Concurrent Manager process check (ps)',
    template: 'ps -ef | grep FNDLIBR | grep -v grep | head -10',
    allowedRoles: ['apps_tier'],
  },

  // ── DB Ops — Listener control ─────────────────────────────────────────────
  'oracle.listener.services': {
    label: 'Listener services',
    template: 'lsnrctl services',
    allowedRoles: ['db_tier'],
  },
  'oracle.listener.start': {
    label: 'Start listener (lsnrctl start)',
    template: 'lsnrctl start',
    allowedRoles: ['db_tier'],
  },
  'oracle.listener.stop': {
    label: 'Stop listener (lsnrctl stop)',
    template: 'lsnrctl stop',
    allowedRoles: ['db_tier'],
  },
  'oracle.listener.reload': {
    label: 'Reload listener (lsnrctl reload)',
    template: 'lsnrctl reload',
    allowedRoles: ['db_tier'],
  },
  'oracle.listener.save_config': {
    label: 'Save listener config (lsnrctl save_config)',
    template: 'lsnrctl save_config',
    allowedRoles: ['db_tier'],
  },

  // ── DB Ops — Instance control (sqlplus / OS-level) ────────────────────────
  'oracle.instance.startup.open': {
    label: 'Startup instance (OPEN — full)',
    template: 'echo "STARTUP;" | sqlplus -S / as sysdba',
    allowedRoles: ['db_tier'],
  },
  'oracle.instance.startup.mount': {
    label: 'Startup instance in MOUNT mode',
    template: 'echo "STARTUP MOUNT;" | sqlplus -S / as sysdba',
    allowedRoles: ['db_tier'],
  },
  'oracle.instance.startup.nomount': {
    label: 'Startup instance in NOMOUNT mode',
    template: 'echo "STARTUP NOMOUNT;" | sqlplus -S / as sysdba',
    allowedRoles: ['db_tier'],
  },
  'oracle.instance.shutdown.immediate': {
    label: 'Shutdown instance IMMEDIATE',
    template: 'echo "SHUTDOWN IMMEDIATE;" | sqlplus -S / as sysdba',
    allowedRoles: ['db_tier'],
  },
  'oracle.instance.shutdown.abort': {
    label: 'Shutdown instance ABORT',
    template: 'echo "SHUTDOWN ABORT;" | sqlplus -S / as sysdba',
    allowedRoles: ['db_tier'],
  },

  // ── DB Ops — RMAN ─────────────────────────────────────────────────────────
  'oracle.rman.show_retention': {
    label: 'RMAN show retention policy',
    template: "rman target / <<'EOF'\nSHOW RETENTION POLICY;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  'oracle.rman.crosscheck': {
    label: 'RMAN crosscheck backups',
    template: "rman target / <<'EOF'\nCROSSCHECK BACKUP;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  'oracle.rman.list_expired': {
    label: 'RMAN list expired backups',
    template: "rman target / <<'EOF'\nLIST EXPIRED BACKUP;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  'oracle.rman.delete_obsolete': {
    label: 'RMAN delete obsolete backups from FRA',
    // Deletes backups declared obsolete by the configured retention policy.
    // Safe to run — does not touch non-obsolete backups.
    template: "rman target / <<'EOF'\nDELETE NOPROMPT OBSOLETE;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },

  // ── DB Ops — RAC (srvctl) ─────────────────────────────────────────────────
  'oracle.rac.srvctl_status': {
    label: 'srvctl status database',
    template: 'srvctl status database -d $(srvctl config database | head -1) 2>/dev/null || crsctl status res -t 2>/dev/null || echo "srvctl_not_available"',
    allowedRoles: ['db_tier'],
  },

  // ── WebLogic managed servers (via admanagedsrvctl.sh status) ─────────────
  // OACore managed server state
  'wls.oacore.status': {
    label: 'OACore managed server state',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // OAFM managed server state
  'wls.oafm.status': {
    label: 'OAFM managed server state',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oafm_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // Forms managed server state
  'wls.forms.status': {
    label: 'Forms managed server state',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status forms_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  // AdminServer state + heap (parsed from nmConnectCommand output)
  'wls.adminserver.status': {
    label: 'AdminServer state and heap',
    // Use wlst.sh if available; fallback to admanagedsrvctl for AdminServer
    template: "if [ -f $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh ]; then $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status AdminServer 2>/dev/null; else echo 'WLST_NOT_AVAILABLE'; fi",
    allowedRoles: ['apps_tier'],
  },

  // ── WLS AdminServer — start/stop/restart ──────────────────────────────────
  'wls.adminserver.start': {
    label: 'Start AdminServer',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start AdminServer 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.adminserver.stop': {
    label: 'Stop AdminServer',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop AdminServer 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.adminserver.restart': {
    label: 'Restart AdminServer',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop AdminServer 2>/dev/null && sleep 5 && $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start AdminServer 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── WLS managed servers — start/stop ──────────────────────────────────────
  'wls.oacore.start': {
    label: 'Start oacore managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start oacore_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.oacore.stop': {
    label: 'Stop oacore managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop oacore_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.oafm.start': {
    label: 'Start oafm managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start oafm_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.oafm.stop': {
    label: 'Stop oafm managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop oafm_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.forms.start': {
    label: 'Start Forms managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start forms_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'wls.forms.stop': {
    label: 'Stop Forms managed server',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop forms_server1 2>/dev/null || echo 'ADMANAGEDSRVCTL_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // WLS managed server list (all via admanagedsrvctl status)
  'wls.managed.list': {
    label: 'All managed server states',
    template: "for srv in oacore_server1 forms_server1 oafm_server1 oaea_server1 iStore_server1; do echo \"=== $srv ===\"; $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status $srv 2>/dev/null | tail -3 || echo 'NOT_FOUND'; done",
    allowedRoles: ['apps_tier'],
  },

  // AdminServer console port reachability check (7001/7002)
  'wls.adminserver.port': {
    label: 'AdminServer port reachability check',
    // nc (netcat) with 3s timeout; falls back to /dev/tcp if nc absent
    template: "ASPORT=7001; HOST=localhost; (nc -z -w3 $HOST $ASPORT 2>/dev/null && echo \"Port $ASPORT OPEN\") || (nc -z -w3 $HOST 7002 2>/dev/null && echo 'Port 7002 OPEN') || (bash -c \"timeout 3 bash -c \\\"echo > /dev/tcp/$HOST/$ASPORT\\\" 2>/dev/null && echo \\\"Port $ASPORT OPEN\\\"\") || echo 'AdminServer port unreachable (tried 7001, 7002)'",
    allowedRoles: ['apps_tier'],
  },

  // ── Apache / OPMN ─────────────────────────────────────────────────────────
  'ebs.apache.status': {
    label: 'Apache / OHS status (adapcctl.sh)',
    // R12.2 uses OHS via WLS; R12.1 uses adapcctl with OPMN; try both
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adapcctl.sh ]; then $ADMIN_SCRIPTS_HOME/adapcctl.sh status 2>/dev/null; else echo 'adapcctl_not_found'; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.apache.start': {
    label: 'Start Apache / OHS (adapcctl.sh start)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adapcctl.sh ]; then $ADMIN_SCRIPTS_HOME/adapcctl.sh start 2>/dev/null; else echo 'adapcctl_not_found'; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.apache.stop': {
    label: 'Stop Apache / OHS (adapcctl.sh stop)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adapcctl.sh ]; then $ADMIN_SCRIPTS_HOME/adapcctl.sh stop 2>/dev/null; else echo 'adapcctl_not_found'; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.apache.restart': {
    label: 'Restart Apache / OHS',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adapcctl.sh ]; then $ADMIN_SCRIPTS_HOME/adapcctl.sh stop 2>/dev/null && sleep 3 && $ADMIN_SCRIPTS_HOME/adapcctl.sh start 2>/dev/null; else echo 'adapcctl_not_found'; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.opmn.list': {
    label: 'OPMN managed process list',
    template: "opmnctl status 2>/dev/null || (opmnctl status -l 2>/dev/null) || echo 'opmnctl_not_found'",
    allowedRoles: ['apps_tier'],
  },
  'ebs.apache.errorlog': {
    label: 'Apache error log (last 50 lines)',
    // R12.2 OHS logs in $LOG_HOME/ohs; R12.1 in $INST_TOP/logs/Apache/error_log
    template: "find $LOG_HOME/ohs $INST_TOP/logs/Apache 2>/dev/null -name 'error_log*' -newer /tmp | head -3 | xargs tail -50 2>/dev/null || find $INST_TOP/logs -name 'error_log' 2>/dev/null | head -2 | xargs tail -50 2>/dev/null || echo 'APACHE_ERROR_LOG_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── Apps Listener (APPS-tier TNS listener) ────────────────────────────────
  'ebs.appslistener.status': {
    label: 'Apps Listener status (adalnctl.sh)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adalnctl.sh ]; then $ADMIN_SCRIPTS_HOME/adalnctl.sh status 2>/dev/null; else lsnrctl status APPS_${ORACLE_SID} 2>/dev/null || lsnrctl status 2>/dev/null; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.appslistener.start': {
    label: 'Start Apps Listener (adalnctl.sh start)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adalnctl.sh ]; then $ADMIN_SCRIPTS_HOME/adalnctl.sh start 2>/dev/null; else lsnrctl start APPS_${ORACLE_SID} 2>/dev/null; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.appslistener.stop': {
    label: 'Stop Apps Listener (adalnctl.sh stop)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adalnctl.sh ]; then $ADMIN_SCRIPTS_HOME/adalnctl.sh stop 2>/dev/null; else lsnrctl stop APPS_${ORACLE_SID} 2>/dev/null; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.appslistener.services': {
    label: 'Apps Listener registered services',
    template: "lsnrctl services APPS_${ORACLE_SID} 2>/dev/null | grep -E 'Service|Instance|Handler' | head -40 || lsnrctl services 2>/dev/null | grep -E 'Service|Instance|Handler' | head -40 || echo 'LISTENER_SERVICES_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },
  'ebs.appslistener.log': {
    label: 'Apps Listener log (last 50 lines)',
    template: "find $ORACLE_BASE/diag/tnslsnr -name 'listener.log' 2>/dev/null | head -3 | xargs tail -50 2>/dev/null || find $TNS_ADMIN -name 'listener.log' 2>/dev/null | head -3 | xargs tail -50 2>/dev/null || echo 'LISTENER_LOG_NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS All-nodes start/stop (multi-node environments) ───────────────────
  // adstrtal.sh -mode=allnodes — starts all services across all EBS nodes
  'ebs.allnodes.start': {
    label: 'Start All Apps Services (all nodes)',
    // Requires APPS password sourced from environment; dry-run echo if script not found
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adstrtal.sh ]; then $ADMIN_SCRIPTS_HOME/adstrtal.sh apps/\\$APPS_PASS -mode=allnodes 2>/dev/null || $ADMIN_SCRIPTS_HOME/adstrtal.sh -mode=allnodes 2>/dev/null; else echo 'adstrtal.sh not found in ADMIN_SCRIPTS_HOME'; fi",
    allowedRoles: ['apps_tier'],
  },
  // adstpall.sh -mode=allnodes — stops all services across all EBS nodes
  'ebs.allnodes.stop': {
    label: 'Stop All Apps Services (all nodes)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adstpall.sh ]; then $ADMIN_SCRIPTS_HOME/adstpall.sh apps/\\$APPS_PASS -mode=allnodes 2>/dev/null || $ADMIN_SCRIPTS_HOME/adstpall.sh -mode=allnodes 2>/dev/null; else echo 'adstpall.sh not found in ADMIN_SCRIPTS_HOME'; fi",
    allowedRoles: ['apps_tier'],
  },

  // ── Grid Infrastructure (ASM) — read-only diagnostics ────────────────────
  // All GI commands run via: sudo su - {{GI_OS_USER}} -c "ORACLE_HOME={{GI_ORACLE_HOME}} ..."
  // The {{GI_OS_USER}} and {{GI_ORACLE_HOME}} placeholders are substituted from connection fields.

  // ASM diskgroup usage (asmcmd lsdg)
  'gi.asm.diskgroups': {
    label: 'ASM Diskgroup Usage (asmcmd lsdg)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; asmcmd lsdg --discovery 2>/dev/null || asmcmd lsdg 2>/dev/null || echo ASMCMD_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM disk status (asmcmd lsdsk)
  'gi.asm.disks': {
    label: 'ASM Disk Status (asmcmd lsdsk)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; asmcmd lsdsk --statistics 2>/dev/null || asmcmd lsdsk 2>/dev/null || echo ASMCMD_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM rebalance status (asmcmd lsop)
  'gi.asm.rebalance': {
    label: 'ASM Rebalance Operations (asmcmd lsop)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; asmcmd lsop 2>/dev/null || echo NO_ACTIVE_OPERATIONS'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM alert log (last 100 lines, grep ORA-)
  'gi.asm.alertlog': {
    label: 'ASM Alert Log ORA- errors (last 100 lines)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; DIAG_BASE=$(asmcmd pwd 2>/dev/null | head -1); find $ORACLE_BASE/diag/asm/+asm $ORACLE_HOME/../diag/asm 2>/dev/null -name alert_+ASM*.log | head -2 | xargs tail -100 2>/dev/null | grep -E \"^ORA-[0-9]\" | tail -30 || echo NO_ASM_ALERT_ORA_ERRORS'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM parameters (asmcmd spget or env check)
  'gi.asm.parameters': {
    label: 'ASM Key Parameters (diskstring, diskgroups, power_limit)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export ORACLE_SID={{ASM_SID}}; export PATH=$ORACLE_HOME/bin:$PATH; echo \"SELECT name, value FROM v\\$asm_attribute WHERE name IN (\\x27ASM_DISKSTRING\\x27,\\x27ASM_DISKGROUPS\\x27,\\x27ASM_POWER_LIMIT\\x27);\" | sqlplus -S / as sysasm 2>/dev/null || echo SQLPLUS_ASM_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM diskgroup mount
  'gi.asm.diskgroup.mount': {
    label: 'Mount ASM Diskgroup (asmcmd mount)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; asmcmd mount {{DG_NAME}} 2>/dev/null || echo MOUNT_FAILED'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // ASM diskgroup dismount
  'gi.asm.diskgroup.dismount': {
    label: 'Dismount ASM Diskgroup (asmcmd umount)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; asmcmd umount {{DG_NAME}} 2>/dev/null || echo DISMOUNT_FAILED'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },

  // ── Grid Infrastructure (RAC / CRS) ──────────────────────────────────────

  // Cluster resource status (crsctl stat res -t)
  'gi.rac.crs.status': {
    label: 'CRS Resource Status (crsctl stat res -t)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; crsctl stat res -t 2>/dev/null || echo CRS_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // CRS daemon health check
  'gi.rac.crs.check': {
    label: 'CRS Health Check (crsctl check crs)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; crsctl check crs 2>/dev/null || echo CRS_CHECK_FAILED'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // VIP status per node
  'gi.rac.vip.status': {
    label: 'VIP Status (srvctl status vip)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; srvctl status vip -a 2>/dev/null || echo VIP_STATUS_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // SCAN listener status
  'gi.rac.scan.listener': {
    label: 'SCAN Listener Status (srvctl status scan_listener)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; srvctl status scan_listener 2>/dev/null || echo SCAN_LISTENER_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // OCR and Voting Disk check
  'gi.rac.ocr.check': {
    label: 'OCR Integrity Check (ocrcheck)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; ocrcheck 2>/dev/null || echo OCRCHECK_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // DB services status
  'gi.rac.db.services': {
    label: 'Database Services (srvctl status database)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; DB=$(srvctl config database 2>/dev/null | head -1); if [ -n \"$DB\" ]; then srvctl status database -d $DB 2>/dev/null; else echo NO_DB_REGISTERED; fi'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // Node app (nodeapps) status
  'gi.rac.nodeapps.status': {
    label: 'Node Apps Status (srvctl status nodeapps)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; srvctl status nodeapps 2>/dev/null || echo NODEAPPS_NOT_AVAILABLE'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // Stop a specific RAC instance (srvctl stop instance)
  'gi.rac.instance.stop': {
    label: 'Stop RAC Instance (srvctl stop instance)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; srvctl stop instance -d {{DB_NAME}} -n {{NODE_NAME}} 2>/dev/null || echo STOP_FAILED'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },
  // Start a specific RAC instance (srvctl start instance)
  'gi.rac.instance.start': {
    label: 'Start RAC Instance (srvctl start instance)',
    template: "sudo su - {{GI_OS_USER}} -c 'export ORACLE_HOME={{GI_ORACLE_HOME}}; export PATH=$ORACLE_HOME/bin:$PATH; srvctl start instance -d {{DB_NAME}} -n {{NODE_NAME}} 2>/dev/null || echo START_FAILED'",
    allowedRoles: ['db_tier'],
    requiresGi: true,
  },

  // ── Rolling Bounce — EBS Context File + Managed Server Control ───────────
  // Parse context file to discover oacore_server* and forms_server* entries.
  // {{CONTEXT_FILE}} is substituted by the route layer from $CONTEXT_FILE env var path
  // or the default pattern $INST_TOP/appl/admin/<SID>_<hostname>.xml
  'ebs.context.parse.oacore': {
    label: 'Parse context file — OACore server list',
    // List oacore_server entries from context XML; fallback to OPMN status grep
    template: "CTX=${CONTEXT_FILE:-$(find $INST_TOP/appl/admin -name '*_*.xml' 2>/dev/null | head -1)}; if [ -n \"$CTX\" ] && [ -f \"$CTX\" ]; then grep -oE 'oacore_server[0-9]+' | sed 's/oacore_server//' \"$CTX\" 2>/dev/null | sort -n | uniq | sed 's/^/oacore_server/' || grep -c 'oacore_server' \"$CTX\" 2>/dev/null; else opmnctl status 2>/dev/null | grep -i oacore | awk '{print $1}' || echo 'CONTEXT_FILE_NOT_FOUND'; fi",
    allowedRoles: ['apps_tier'],
  },
  'ebs.context.parse.forms': {
    label: 'Parse context file — Forms server list',
    template: "CTX=${CONTEXT_FILE:-$(find $INST_TOP/appl/admin -name '*_*.xml' 2>/dev/null | head -1)}; if [ -n \"$CTX\" ] && [ -f \"$CTX\" ]; then grep -oE 'forms_server[0-9]+' | sed 's/forms_server//' \"$CTX\" 2>/dev/null | sort -n | uniq | sed 's/^/forms_server/' || grep -c 'forms_server' \"$CTX\" 2>/dev/null; else opmnctl status 2>/dev/null | grep -i forms | awk '{print $1}' || echo 'CONTEXT_FILE_NOT_FOUND'; fi",
    allowedRoles: ['apps_tier'],
  },

  // Status check for a specific managed server by name ({{WLS_SERVER_NAME}} substituted)
  // Returns RUNNING, STARTING, STANDBY, or other WLS state
  'wls.managed.status.byname': {
    label: 'Managed server status by name',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status {{WLS_SERVER_NAME}} 2>/dev/null | tail -5 || echo 'STATUS_UNKNOWN'",
    allowedRoles: ['apps_tier'],
  },

  // Stop a specific managed server by name (rolling bounce stop step)
  // Destructive: false here — the route layer gates on confirmed; this is one step of many
  'wls.managed.stop.byname': {
    label: 'Stop managed server by name (rolling bounce step)',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop {{WLS_SERVER_NAME}} 2>/dev/null | tail -10 || echo 'STOP_FAILED'",
    allowedRoles: ['apps_tier'],
  },

  // Start a specific managed server by name (rolling bounce start step)
  'wls.managed.start.byname': {
    label: 'Start managed server by name (rolling bounce step)',
    template: "$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start {{WLS_SERVER_NAME}} 2>/dev/null | tail -10 || echo 'START_FAILED'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS 12.2 deep checks — Topology ───────────────────────────────────

  'ebs.wls.topology': {
    label: 'WLS domain topology from config.xml',
    // Parse server/cluster counts from domain config.xml
    template: "[ -n \"$EBS_DOMAIN_HOME\" ] && grep -E '<server>|<name>|<cluster>' $EBS_DOMAIN_HOME/config/config.xml 2>/dev/null | head -40 || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.apache.children': {
    label: 'Apache/OHS child process count',
    template: "pgrep -c -x httpd 2>/dev/null || ps aux 2>/dev/null | grep -c '[h]ttpd' || echo '0'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS 12.2 deep checks — JVM Heap & GC ──────────────────────────────

  'ebs.jvm.oacore_heap': {
    label: 'OACore JVM heap settings (-Xms/-Xmx)',
    // Check setUserOverrides.sh, then fallback to oacore startup script
    template: "grep -E '\\-Xm[sx][0-9]' $INST_TOP/appl/admin/setUserOverrides.sh 2>/dev/null || grep -rE '\\-Xm[sx][0-9]' $INST_TOP/appl/admin/ 2>/dev/null | head -5 || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.jvm.forms_heap': {
    label: 'Forms JVM heap settings (-Xms/-Xmx)',
    template: "grep -E '\\-Xm[sx][0-9]' $INST_TOP/appl/admin/setUserOverrides.sh 2>/dev/null | grep -i form || grep -rE 'Forms.*\\-Xm[sx]' $INST_TOP/appl/admin/ 2>/dev/null | head -5 || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.jvm.opp_heap': {
    label: 'OPP JVM heap settings',
    template: "grep -E '\\-Xm[sx][0-9]' $FND_TOP/bin/fndcpopp.sh 2>/dev/null || grep -E 'opp.*\\-Xm[sx]|\\-Xm[sx].*opp' $INST_TOP/appl/admin/setUserOverrides.sh 2>/dev/null || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.jvm.permgen': {
    label: 'PermGen/Metaspace JVM settings',
    template: "grep -E 'MaxMetaspaceSize|MaxPermSize|MetaspaceSize' $INST_TOP/appl/admin/setUserOverrides.sh 2>/dev/null | head -10 || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.jvm.gc_flags': {
    label: 'JVM GC algorithm flags',
    template: "grep -E 'UseG1GC|UseConcMarkSweepGC|UseParallelGC|UseSerialGC|GCPolicy' $INST_TOP/appl/admin/setUserOverrides.sh 2>/dev/null | head -5 || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.jvm.oom_errors': {
    label: 'OutOfMemoryError occurrences in JVM logs (7d)',
    template: "find $LOG_HOME -name 'oacore_server*.out' -o -name 'FormsServer*.out' 2>/dev/null | xargs grep -l 'OutOfMemoryError' 2>/dev/null | head -5 | xargs grep -h 'OutOfMemoryError' 2>/dev/null | grep \"$(date -d '7 days ago' '+%Y-%m' 2>/dev/null || date -v-7d '+%Y-%m' 2>/dev/null)\" | tail -20 || echo 'NO_OOM'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS 12.2 deep checks — OS Metrics ─────────────────────────────────

  'ebs.os.cpu': {
    label: 'CPU utilization (vmstat 5 samples)',
    template: 'vmstat 1 5 2>/dev/null || sar -u 1 5 2>/dev/null || echo "vmstat_unavailable"',
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.memory': {
    label: 'Memory free + swap (free -m)',
    template: 'free -m 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -10',
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.load': {
    label: 'Load average (uptime)',
    template: 'uptime',
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.top_cpu': {
    label: 'Top 10 processes by CPU',
    template: "ps aux --sort=-%cpu 2>/dev/null | head -11 || ps -eo user,pid,%cpu,%mem,comm --sort=-%cpu 2>/dev/null | head -11",
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.top_mem': {
    label: 'Top 10 processes by memory',
    template: "ps aux --sort=-%mem 2>/dev/null | head -11 || ps -eo user,pid,%cpu,%mem,comm --sort=-%mem 2>/dev/null | head -11",
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.disk': {
    label: 'Disk usage all filesystems (df -h)',
    template: "df -h 2>/dev/null | grep -v tmpfs | grep -v devtmpfs",
    allowedRoles: ['apps_tier'],
  },

  'ebs.os.open_fds': {
    label: 'Open file descriptors for oacore PID',
    // Get oacore PID, count its FDs, get ulimit -n
    template: "OAPID=$(pgrep -f 'oacore_server' 2>/dev/null | head -1); if [ -n \"$OAPID\" ]; then ls /proc/$OAPID/fd 2>/dev/null | wc -l; su - $USER -c 'ulimit -n' 2>/dev/null || ulimit -n; else echo 'NOT_FOUND'; fi",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS 12.2 deep checks — ETCC ───────────────────────────────────────

  'ebs.etcc.last_run': {
    label: 'ETCC last run timestamps (checkDBpatch + checkMTpatch logs)',
    template: "DB_LOG=$(find $AD_TOP/bin -name 'checkDBpatch.log' 2>/dev/null | head -1); MT_LOG=$(find $AD_TOP/bin -name 'checkMTpatch.log' 2>/dev/null | head -1); if [ -n \"$DB_LOG\" ]; then echo \"DB: $(stat -c '%y' $DB_LOG 2>/dev/null || stat -f '%Sm' $DB_LOG 2>/dev/null)\"; fi; if [ -n \"$MT_LOG\" ]; then echo \"MT: $(stat -c '%y' $MT_LOG 2>/dev/null || stat -f '%Sm' $MT_LOG 2>/dev/null)\"; fi; [ -z \"$DB_LOG\" ] && [ -z \"$MT_LOG\" ] && echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  'ebs.etcc.db_missing': {
    label: 'ETCC DB tier missing patches',
    template: "LOG=$(find $AD_TOP/bin -name 'checkDBpatch.log' 2>/dev/null | head -1); [ -n \"$LOG\" ] && cat $LOG || echo 'NOT_FOUND'",
    allowedRoles: ['db_tier'],
  },

  'ebs.etcc.mt_missing': {
    label: 'ETCC MT tier missing patches',
    template: "LOG=$(find $AD_TOP/bin -name 'checkMTpatch.log' 2>/dev/null | head -1); [ -n \"$LOG\" ] && cat $LOG || echo 'NOT_FOUND'",
    allowedRoles: ['apps_tier'],
  },

  // ── EBS Clone & Scale — Rapid Clone Wizard commands ──────────────────────
  // Source-side preclone preparation
  'ebs.clone.preclone.db': {
    label: 'adpreclone.pl dbTier (source)',
    template: "cd $ORACLE_HOME/appsutil/scripts/$CONTEXT_NAME && perl adpreclone.pl dbTier 2>&1",
    allowedRoles: ['db_tier'],
  },
  'ebs.clone.preclone.apps': {
    label: 'adpreclone.pl appsTier (source)',
    template: "cd $INST_TOP/admin/scripts && perl adpreclone.pl appsTier 2>&1",
    allowedRoles: ['apps_tier'],
  },
  // Target-side postclone configuration
  'ebs.clone.cfgclone.db': {
    label: 'adcfgclone.pl dbTier (target)',
    template: "cd $ORACLE_HOME/appsutil/scripts/$CONTEXT_NAME && perl adcfgclone.pl dbTier 2>&1",
    allowedRoles: ['db_tier'],
  },
  'ebs.clone.cfgclone.apps': {
    label: 'adcfgclone.pl appsTier (target)',
    template: "cd $INST_TOP/admin/scripts && perl adcfgclone.pl appsTier 2>&1",
    allowedRoles: ['apps_tier'],
  },
  // Disk space check for clone target
  'ebs.clone.diskcheck': {
    label: 'Target disk space (for clone sizing)',
    template: "df -h | grep -v tmpfs | grep -v devtmpfs; echo '---'; du -sh $APPL_TOP 2>/dev/null || echo 'APPL_TOP not set'; du -sh $INST_TOP 2>/dev/null || echo 'INST_TOP not set'; du -sh $ORACLE_HOME 2>/dev/null || echo 'ORACLE_HOME not set'",
    allowedRoles: ['apps_tier', 'db_tier'],
  },
  // Context file backup
  'ebs.clone.ctxbackup': {
    label: 'Backup .xml context files before clone',
    template: "BKDIR=/tmp/ctx_bk_$(date +%Y%m%d%H%M%S); mkdir -p $BKDIR; find $APPL_TOP/admin $INST_TOP/appl/admin 2>/dev/null -name '*.xml' -newer /tmp | xargs -I{} cp {} $BKDIR/ 2>/dev/null; ls $BKDIR; echo \"Backed up to $BKDIR\"",
    allowedRoles: ['apps_tier'],
  },
  // Service shutdown verification
  'ebs.clone.services.check': {
    label: 'Verify target services stopped before clone',
    template: "echo '=== Concurrent Managers ==='; ps aux | grep -i fndlibr | grep -v grep | wc -l; echo '=== WLS ==='; ps aux | grep -i weblogic | grep -v grep | wc -l; echo '=== OHS/Apache ==='; ps aux | grep -iE 'httpd|ohs' | grep -v grep | wc -l; echo '=== Forms ==='; ps aux | grep -i f60srvr | grep -v grep | wc -l; echo 'Done'",
    allowedRoles: ['apps_tier'],
  },
  // Network connectivity check target→source
  'ebs.clone.netcheck': {
    label: 'Network connectivity check (ping + port)',
    template: "ping -c 3 {{TARGET_HOST}} 2>&1 | tail -2; nc -zv {{TARGET_HOST}} {{TARGET_PORT}} 2>&1 || echo 'nc_not_available'",
    allowedRoles: ['apps_tier', 'db_tier'],
  },
  // FND_NODES cleanup on target after clone
  'ebs.clone.sql.fndnodes': {
    label: 'FND_NODES cleanup SQL (post-clone)',
    // Just outputs the SQL to run — execution is via Oracle connection, not SSH
    template: "echo 'Run the following SQL on the target database as APPS:'; echo \"DELETE FROM apps.fnd_nodes WHERE node_name NOT IN (SELECT SYS_CONTEXT('USERENV','SERVER_HOST') FROM DUAL);\"; echo 'COMMIT;'",
    allowedRoles: ['apps_tier', 'db_tier'],
  },
  // AutoConfig run on target apps tier
  'ebs.clone.autoconfig.apps': {
    label: 'AutoConfig apps tier (adautocfg.sh)',
    template: "if [ -f $ADMIN_SCRIPTS_HOME/adautocfg.sh ]; then $ADMIN_SCRIPTS_HOME/adautocfg.sh 2>&1; else echo 'adautocfg.sh not found in ADMIN_SCRIPTS_HOME'; fi",
    allowedRoles: ['apps_tier'],
  },
  // AutoConfig run on target DB tier
  'ebs.clone.autoconfig.db': {
    label: 'AutoConfig DB tier (adautocfg.sh)',
    template: "if [ -f $ORACLE_HOME/appsutil/bin/adautocfg.sh ]; then $ORACLE_HOME/appsutil/bin/adautocfg.sh 2>&1; else echo 'adautocfg.sh not found in ORACLE_HOME/appsutil/bin'; fi",
    allowedRoles: ['db_tier'],
  },
  // Apps-tier node health validation post-clone
  'ebs.clone.nodecheck': {
    label: 'Post-clone node health validation',
    template: "echo '=== TNS Listener ==='; lsnrctl status 2>/dev/null | grep -E 'Services|STATUS' | head -5; echo '=== WLS AdminServer ==='; ps aux | grep AdminServer | grep -v grep | head -3; echo '=== OHS ==='; ps aux | grep -iE 'oracle|httpd' | grep -v grep | wc -l; echo '=== Concurrent Managers ==='; ps aux | grep -i fndlibr | grep -v grep | wc -l",
    allowedRoles: ['apps_tier'],
  },

  // ── DB Clone & Scale — Oracle RMAN / Data Pump / RAC ─────────────────────
  // Pre-flight: RMAN backup status (last successful backup timestamp)
  'db.clone.rman.backup_status': {
    label: 'RMAN last successful backup timestamp',
    template: "rman target / nocatalog <<EOF\nLIST BACKUP SUMMARY;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: DB datafile disk usage
  'db.clone.disk.datafiles': {
    label: 'Datafile disk usage (oradata / datafiles)',
    template: "echo '=== Datafiles ==='; df -h $ORACLE_BASE/oradata 2>/dev/null || df -h /u01/oradata 2>/dev/null || df -h / | head -5; du -sh $ORACLE_BASE/oradata/$ORACLE_SID 2>/dev/null || echo 'datafile path not resolved'",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: FRA disk usage
  'db.clone.disk.fra': {
    label: 'Fast Recovery Area (FRA) disk usage',
    template: "df -h $ORACLE_BASE/fast_recovery_area 2>/dev/null || df -h $DB_RECOVERY_FILE_DEST 2>/dev/null || echo 'FRA_PATH_NOT_RESOLVED'",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: network connectivity (target-side test)
  'db.clone.net.check': {
    label: 'Network connectivity to source host',
    template: "ping -c 3 {{TARGET_HOST}} 2>&1 | tail -3; nc -zv {{TARGET_HOST}} {{TARGET_PORT}} 2>&1 | head -3 || telnet {{TARGET_HOST}} {{TARGET_PORT}} </dev/null 2>&1 | head -3",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: listener check on target
  'db.clone.listener.check': {
    label: 'Listener status on target DB',
    template: "lsnrctl status 2>&1",
    allowedRoles: ['db_tier'],
  },
  // Active Duplicate: RMAN DUPLICATE FROM ACTIVE DATABASE (outputs the RMAN script to copy)
  'db.clone.rman.active_dup_script': {
    label: 'RMAN active duplicate — generate script',
    template: "echo 'RMAN ACTIVE DUPLICATE SCRIPT (review and execute):'; echo ''; echo 'rman TARGET sys/PASSWORD@SOURCE_SID AUXILIARY sys/PASSWORD@TARGET_SID'; echo ''; echo 'DUPLICATE TARGET DATABASE TO NEW_DBNAME'; echo '  FROM ACTIVE DATABASE'; echo '  SPFILE'; echo \"  PARAMETER_VALUE_CONVERT '${ORACLE_SID}','{{TARGET_DBNAME}}'\"; echo \"  SET DB_NAME='{{TARGET_DBNAME}}'\"; echo \"  SET DB_UNIQUE_NAME='{{TARGET_DBNAME}}'\"; echo \"  SET CONTROL_FILES='/u01/oradata/{{TARGET_DBNAME}}/control01.ctl'\"; echo \"  SET LOG_FILE_NAME_CONVERT='/u01/oradata/${ORACLE_SID}/','/u01/oradata/{{TARGET_DBNAME}}/';\"; echo \"  SET DB_FILE_NAME_CONVERT='/u01/oradata/${ORACLE_SID}/','/u01/oradata/{{TARGET_DBNAME}}/';\"; echo ';'",
    allowedRoles: ['db_tier'],
  },
  // Backup-based duplicate: check backup set availability
  'db.clone.rman.list_backupsets': {
    label: 'RMAN list available backup sets',
    template: "rman target / nocatalog <<EOF\nLIST BACKUP OF DATABASE SUMMARY;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  // Post-clone: reset passwords for application schema accounts
  'db.clone.post.reset_passwd_script': {
    label: 'Post-clone password reset SQL (generate)',
    template: "echo 'Run as SYSDBA on target:'; echo 'ALTER USER SYSTEM IDENTIFIED BY newpassword;'; echo 'ALTER USER SYS IDENTIFIED BY newpassword;'; echo 'ALTER USER DBSNMP IDENTIFIED BY newpassword;'; echo '-- Then run AutoConfig to regenerate TNS/listener config'",
    allowedRoles: ['db_tier'],
  },
  // Post-clone: rename DB (DBNEWID utility)
  'db.clone.post.dbnewid_check': {
    label: 'DBNEWID — check current DBID and name',
    template: "sqlplus -S / as sysdba <<EOF\nSET PAGESIZE 20 LINESIZE 80\nSELECT DBID, NAME, DB_UNIQUE_NAME, OPEN_MODE FROM V\\$DATABASE;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  // Post-clone: update TNS names entries
  'db.clone.post.tns_show': {
    label: 'Show current tnsnames.ora entries',
    template: "cat $TNS_ADMIN/tnsnames.ora 2>/dev/null || cat $ORACLE_HOME/network/admin/tnsnames.ora 2>/dev/null || echo 'tnsnames.ora not found'",
    allowedRoles: ['db_tier'],
  },
  // Data Pump Export — expdp schema-level (generate command)
  'db.clone.expdp.schema_script': {
    label: 'Data Pump Export (expdp) — schema-level script',
    template: "echo 'Run as oracle on source DB:'; echo \"expdp '/ as sysdba' schemas={{SCHEMA_NAME}} directory=DATA_PUMP_DIR dumpfile={{DUMP_FILE}}.dmp logfile={{DUMP_FILE}}.log parallel=4\"",
    allowedRoles: ['db_tier'],
  },
  // Data Pump Export — full database (generate command)
  'db.clone.expdp.full_script': {
    label: 'Data Pump Export (expdp) — full database script',
    template: "echo 'Run as oracle on source DB:'; echo \"expdp '/ as sysdba' full=y directory=DATA_PUMP_DIR dumpfile={{DUMP_FILE}}_%U.dmp logfile={{DUMP_FILE}}.log parallel=4 compression=all\"",
    allowedRoles: ['db_tier'],
  },
  // Data Pump Import — impdp schema remap (generate command)
  'db.clone.impdp.schema_remap_script': {
    label: 'Data Pump Import (impdp) — schema remap script',
    template: "echo 'Run as oracle on target DB:'; echo \"impdp '/ as sysdba' schemas={{SOURCE_SCHEMA}} remap_schema={{SOURCE_SCHEMA}}:{{TARGET_SCHEMA}} remap_tablespace={{SOURCE_TS}}:{{TARGET_TS}} directory=DATA_PUMP_DIR dumpfile={{DUMP_FILE}}.dmp logfile=impdp_{{DUMP_FILE}}.log table_exists_action=replace\"",
    allowedRoles: ['db_tier'],
  },
  // Data Pump Import — full database remap (generate command)
  'db.clone.impdp.full_script': {
    label: 'Data Pump Import (impdp) — full database script',
    template: "echo 'Run as oracle on target DB:'; echo \"impdp '/ as sysdba' full=y directory=DATA_PUMP_DIR dumpfile={{DUMP_FILE}}_%U.dmp logfile=impdp_full.log remap_tablespace=USERS:USERS table_exists_action=replace\"",
    allowedRoles: ['db_tier'],
  },
  // RAC Node Addition — check GI cluster nodes
  'db.clone.rac.cluster_nodes': {
    label: 'RAC — list current cluster nodes (olsnodes)',
    template: "olsnodes -v 2>/dev/null || echo 'olsnodes not in PATH; try: /u01/app/oracle/product/19c/grid/bin/olsnodes -v'",
    allowedRoles: ['db_tier'],
  },
  // RAC — check GI resources (VIP, SCAN, DB services)
  'db.clone.rac.crs_status': {
    label: 'RAC — GI resource status (crsctl)',
    template: "crsctl stat res -t 2>/dev/null || echo 'crsctl not in PATH'",
    allowedRoles: ['db_tier'],
  },
  // RAC — check ASM disk groups
  'db.clone.rac.asm_groups': {
    label: 'RAC — ASM disk group status',
    template: "asmcmd lsdg 2>/dev/null || sqlplus -S / as sysasm <<EOF\nSET PAGESIZE 20 LINESIZE 120\nSELECT NAME, STATE, TYPE, TOTAL_MB, FREE_MB FROM V\\$ASM_DISKGROUP;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
  // RAC — srvctl DB status across all nodes
  'db.clone.rac.srvctl_status': {
    label: 'RAC — DB instance status across all nodes',
    template: "srvctl status database -d $ORACLE_UNQNAME 2>/dev/null || srvctl status database -d $ORACLE_SID 2>/dev/null || echo 'srvctl not in PATH or ORACLE_UNQNAME not set'",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: service on target (instances running?)
  'db.clone.preflight.instance_check': {
    label: 'Pre-flight — check for running Oracle instances on target',
    template: "ps aux | grep -iE 'ora_[a-z]+_' | grep -v grep | head -10; echo '---'; lsnrctl status 2>&1 | grep -E 'STATUS|Services|Instance' | head -10",
    allowedRoles: ['db_tier'],
  },
  // Pre-flight: SYS/SYSTEM credential test via sqlplus
  'db.clone.preflight.sqlplus_test': {
    label: 'Pre-flight — SQLPLUS connectivity test (/ as sysdba)',
    template: "sqlplus -S / as sysdba <<EOF\nSET PAGESIZE 5\nSELECT 'CONNECTED_OK' FROM DUAL;\nEXIT;\nEOF",
    allowedRoles: ['db_tier'],
  },
};

const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Proxy dispatch helper ─────────────────────────────────────────────────────
// When an SSH target has a connection_id, SSH commands are forwarded to the
// proxy's /api/ssh/exec endpoint instead of direct SSH from the server.
// This allows the proxy — running on the Oracle server's local network — to
// reach private-IP SSH targets that are unreachable from Render.

/**
 * Execute an SSH command via the oracle proxy.
 *
 * @param {string} proxyUrl     Full URL of the proxy (e.g. https://proxy.host/proxy)
 * @param {string} proxyApiKey  Plaintext API key for the proxy
 * @param {Object} target       SSH target row (host, port, os_user, auth_method, ...)
 * @param {string} rendered     The shell command to execute
 * @param {string} authMode     'key' | 'password'
 * @param {Object} authData     { privateKey?, passphrase? } or { password }
 * @param {number} timeoutMs
 * @returns {Promise<{ok, exitCode, stdout, stderr, durationMs, via}>}
 */
async function _runViaProxy(proxyUrl, proxyApiKey, target, rendered, authMode, authData, timeoutMs) {
  // Normalize proxy base URL — strip trailing path components so we can append /api/ssh/exec
  // proxyUrl in oracle_connections is the full proxy endpoint (e.g. https://host/proxy)
  // The SSH exec endpoint lives at the same base: https://host/api/ssh/exec
  const baseUrl = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl = baseUrl + '/api/ssh/exec';

  const body = JSON.stringify({
    host:        target.host,
    port:        target.port || 22,
    username:    target.os_user,
    auth_method: authMode,
    password:    authMode === 'password' ? (authData.password || '') : '',
    private_key: authMode === 'key'      ? (authData.privateKey || '') : '',
    command:     rendered,
    timeout:     Math.ceil(timeoutMs / 1000),
  });

  const started = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false, exitCode: null,
        stdout: '', stderr: '[proxy] Request timed out after ' + timeoutMs + 'ms',
        durationMs: Date.now() - started, via: 'proxy',
      });
    }, timeoutMs + 5000); // give a bit more than SSH timeout for network overhead

    const urlObj = new URL(execUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + (urlObj.search || ''),
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Key':      proxyApiKey,
      },
      // Allow self-signed certs on the proxy (common for on-premise installs)
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        const durationMs = Date.now() - started;
        try {
          const data = JSON.parse(raw);
          resolve({
            ok:         data.success === true,
            exitCode:   data.exit_code ?? null,
            stdout:     (data.stdout || '').slice(0, 32768),
            stderr:     (data.stderr || '').slice(0, 8192),
            durationMs,
            via:        'proxy',
          });
        } catch (e) {
          resolve({
            ok: false, exitCode: null,
            stdout: '', stderr: '[proxy] Invalid JSON response: ' + raw.slice(0, 200),
            durationMs, via: 'proxy',
          });
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false, exitCode: null,
        stdout: '', stderr: '[proxy] Connection error: ' + err.message,
        durationMs: Date.now() - started, via: 'proxy',
      });
    });

    req.write(body);
    req.end();
  });
}

// ─── Connection pool ──────────────────────────────────────────────────────────
// Keeps at most one idle client per target. Cleared on reuse attempt if stale.

const _pool = new Map(); // target_id → { client, readyAt }

function _evict(targetId) {
  const entry = _pool.get(targetId);
  if (entry) {
    try { entry.client.end(); } catch (_) {}
    _pool.delete(targetId);
  }
}

// ─── Core executor ────────────────────────────────────────────────────────────

/**
 * Execute an SSH command on a registered target.
 *
 * @param {Object} opts
 * @param {number}      opts.targetId       Row ID in ssh_targets
 * @param {string}      opts.commandKey     Key in COMMAND_WHITELIST
 * @param {string|null} opts.initiatedBy    User email or system identifier
 * @param {number}      [opts.timeoutMs]    Override default 30 s timeout
 * @param {Object}      [opts.extraVars]    Additional template substitutions for GI commands.
 *                                          Keys map to {{KEY}} placeholders in the template.
 *                                          Only alphanumeric, underscore, dot, plus, slash, hyphen
 *                                          values are accepted (guard against injection).
 *                                          Typical: { GI_OS_USER, GI_ORACLE_HOME, ASM_SID, DG_NAME,
 *                                                     DB_NAME, NODE_NAME }
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   commandKey: string,
 *   rendered: string,
 *   exitCode: number|null,
 *   stdout: string,
 *   stderr: string,
 *   durationMs: number,
 *   rejected: boolean,
 *   rejectionReason: string|null,
 * }>}
 */
async function runCommand({ targetId, commandKey, initiatedBy = null, timeoutMs = DEFAULT_TIMEOUT_MS, extraVars = {} }) {
  const started = Date.now();

  // ── 1. Whitelist check (before any DB or SSH) ─────────────────────────────
  const def = COMMAND_WHITELIST[commandKey];
  if (!def) {
    await db.writeAudit({
      target_id: targetId,
      command_key: commandKey,
      rendered_command: '',
      exit_code: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      duration_ms: Date.now() - started,
      was_rejected: true,
      rejection_reason: 'key_not_in_whitelist',
      initiated_by: initiatedBy,
    }).catch(() => {});
    return { ok: false, commandKey, rendered: '', exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - started, rejected: true, rejectionReason: 'key_not_in_whitelist' };
  }

  // ── 2. Load target + role check ───────────────────────────────────────────
  const target = await db.getTargetById(targetId);
  if (!target) {
    return { ok: false, commandKey, rendered: '', exitCode: null, stdout: '', stderr: 'Target not found', durationMs: Date.now() - started, rejected: true, rejectionReason: 'target_not_found' };
  }

  if (!def.allowedRoles.includes(target.role)) {
    const reason = `role_not_allowed:${target.role}`;
    await db.writeAudit({
      target_id: targetId,
      command_key: commandKey,
      rendered_command: def.template,
      exit_code: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      duration_ms: Date.now() - started,
      was_rejected: true,
      rejection_reason: reason,
      initiated_by: initiatedBy,
    }).catch(() => {});
    return { ok: false, commandKey, rendered: def.template, exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - started, rejected: true, rejectionReason: reason };
  }

  // Substitute {{OS_USER}} from target record, then any caller-supplied extraVars.
  // Only safe characters allowed in substituted values (prevent injection).
  let rendered = def.template.replace(/\{\{OS_USER\}\}/g, target.os_user);
  for (const [k, v] of Object.entries(extraVars)) {
    // Allow alphanumeric, underscore, dot, plus (+ASM), slash (paths), hyphen
    if (/^[a-zA-Z0-9_.+/\-]+$/.test(String(v))) {
      rendered = rendered.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  // If any GI placeholder is still unresolved, reject (misconfigured connection)
  if (def.requiresGi && /\{\{GI_OS_USER\}\}|\{\{GI_ORACLE_HOME\}\}|\{\{ASM_SID\}\}/.test(rendered)) {
    const reason = 'gi_credentials_not_configured';
    await db.writeAudit({
      target_id: targetId, command_key: commandKey, rendered_command: rendered,
      exit_code: null, stdout_bytes: 0, stderr_bytes: 0,
      duration_ms: Date.now() - started, was_rejected: true,
      rejection_reason: reason, initiated_by: initiatedBy,
    }).catch(() => {});
    return { ok: false, commandKey, rendered, exitCode: null, stdout: '', stderr: 'Grid Infrastructure credentials not configured for this connection', durationMs: Date.now() - started, rejected: true, rejectionReason: reason };
  }

  // ── 3. Decrypt credentials ────────────────────────────────────────────────
  // Decrypted values are local variables — they do NOT appear in logs or audit rows.
  let authConfig;
  try {
    if (target.auth_method === 'key') {
      const privateKey = decrypt(target.encrypted_private_key);
      const passphrase = target.encrypted_passphrase ? decrypt(target.encrypted_passphrase) : undefined;
      authConfig = { privateKey, passphrase };
    } else {
      const password = decrypt(target.encrypted_passphrase);
      authConfig = { password };
    }
  } catch (err) {
    const reason = 'credential_decrypt_failed';
    await db.writeAudit({
      target_id: targetId,
      command_key: commandKey,
      rendered_command: rendered,
      exit_code: null,
      stdout_bytes: 0,
      stderr_bytes: 0,
      duration_ms: Date.now() - started,
      was_rejected: true,
      rejection_reason: reason,
      initiated_by: initiatedBy,
    }).catch(() => {});
    return { ok: false, commandKey, rendered, exitCode: null, stdout: '', stderr: 'Credential error', durationMs: Date.now() - started, rejected: true, rejectionReason: reason };
  }

  // ── 3b. Proxy routing — when connection_id is set, route SSH through proxy ──
  // The oracle proxy runs on the Oracle server's network and can reach private
  // IPs that are unreachable from Render. If this target is linked to an Oracle
  // connection that uses proxy mode, forward the SSH exec request there.
  if (target.connection_id) {
    const proxyConn = await db.getConnectionProxyById(target.connection_id).catch(() => null);
    if (proxyConn) {
      const proxyApiKey = decrypt(proxyConn.proxy_api_key_enc);
      const authMode = target.auth_method === 'key' ? 'key' : 'password';
      const authData = target.auth_method === 'key'
        ? { privateKey: authConfig.privateKey || '', passphrase: authConfig.passphrase || '' }
        : { password: authConfig.password || '' };

      const proxyResult = await _runViaProxy(
        proxyConn.proxy_url, proxyApiKey, target, rendered,
        authMode, authData, timeoutMs
      );

      const durationMsProxy = proxyResult.durationMs;
      const stdoutProxy = (proxyResult.stdout || '').slice(0, 32_768);
      const stderrProxy = (proxyResult.stderr || '').slice(0, 8_192);
      const okProxy = proxyResult.ok;

      await db.writeAudit({
        target_id: targetId,
        command_key: commandKey,
        rendered_command: rendered,
        exit_code: proxyResult.exitCode ?? null,
        stdout_bytes: Buffer.byteLength(stdoutProxy),
        stderr_bytes: Buffer.byteLength(stderrProxy),
        duration_ms: durationMsProxy,
        was_rejected: false,
        rejection_reason: okProxy ? null : 'proxy_exec_error',
        initiated_by: initiatedBy,
      }).catch(() => {});

      return {
        ok: okProxy,
        commandKey,
        rendered,
        exitCode: proxyResult.exitCode ?? null,
        stdout: stdoutProxy,
        stderr: stderrProxy,
        durationMs: durationMsProxy,
        rejected: false,
        rejectionReason: okProxy ? null : 'proxy_exec_error',
        via: 'proxy',
      };
    }
    // No proxy configured for this connection — fall through to direct SSH
  }

  // ── 4. Open SSH connection + exec ─────────────────────────────────────────
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let execError = null;

  try {
    await new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => {
        try { conn.end(); } catch (_) {}
        reject(new Error('SSH_TIMEOUT'));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.exec(rendered, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }

          stream.on('close', (code) => {
            exitCode = code;
            clearTimeout(timer);
            conn.end();
            resolve();
          });

          stream.on('data', (data) => { stdout += data.toString(); });
          stream.stderr.on('data', (data) => { stderr += data.toString(); });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      conn.connect({
        host: target.host,
        port: target.port,
        username: target.os_user,
        readyTimeout: timeoutMs,
        ...authConfig,
      });
    });
  } catch (err) {
    execError = err.message || 'SSH error';
    // Evict stale pool entry if present
    _evict(targetId);
  }

  const durationMs = Date.now() - started;

  // Truncate to reasonable sizes before writing audit
  const stdoutTrunc = stdout.slice(0, 32_768);
  const stderrTrunc = stderr.slice(0, 8_192);

  const ok = execError === null && exitCode === 0;

  await db.writeAudit({
    target_id: targetId,
    command_key: commandKey,
    rendered_command: rendered,
    exit_code: exitCode,
    stdout_bytes: Buffer.byteLength(stdoutTrunc),
    stderr_bytes: Buffer.byteLength(stderrTrunc),
    duration_ms: durationMs,
    was_rejected: false,
    rejection_reason: execError ? 'exec_error' : null,
    initiated_by: initiatedBy,
  }).catch(() => {});

  return {
    ok,
    commandKey,
    rendered,
    exitCode,
    stdout: stdoutTrunc,
    stderr: stderrTrunc + (execError ? `\n[executor] ${execError}` : ''),
    durationMs,
    rejected: false,
    rejectionReason: execError ? 'exec_error' : null,
  };
}

/**
 * Return the command whitelist — safe for API exposure (no secrets).
 * @returns {Object}
 */
function getWhitelist() {
  return Object.fromEntries(
    Object.entries(COMMAND_WHITELIST).map(([key, def]) => [
      key,
      { label: def.label, template: def.template, allowedRoles: def.allowedRoles },
    ])
  );
}

module.exports = { runCommand, getWhitelist, DEFAULT_TIMEOUT_MS };
