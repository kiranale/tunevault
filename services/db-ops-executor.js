/**
 * services/db-ops-executor.js — DB Ops SQL + SSH execution engine.
 *
 * Owns: Executing DB Ops SQL queries (sessions, tablespace, memory, stats, RMAN, ASM, RAC)
 *       and SSH-based operations (listener, archive, RMAN CLI, srvctl).
 * Does NOT own: credential storage (db/ssh-targets.js), route auth,
 *               EBS-specific checks (services/ebs-ssh-checks.js).
 *
 * SQL ops run via the oracle-client lazy-loaded here (read-only path).
 * SSH ops delegate to services/ssh-executor.js (whitelist-enforced).
 *
 * All destructive ops require the caller to pass confirmed=true after
 * showing the exact command in a confirmation modal on the frontend.
 */

'use strict';

const sshExec = require('./ssh-executor');

// ─── SQL catalog ──────────────────────────────────────────────────────────────
// Keys are opKey values sent from the frontend.
// type: 'sql'  → run via oracle-client
// type: 'ssh'  → delegate to ssh-executor COMMAND_WHITELIST by commandKey
// destructive: true → frontend must pass confirmed:true (double-gate on server too)
// sysdba: true  → requires SYSDBA privilege (reader pool rejected; advisory only in demo)

const OP_CATALOG = {
  // ── Instance Control ────────────────────────────────────────────────────────
  'instance.status': {
    label: 'Instance Status',
    category: 'instance',
    type: 'sql',
    sql: `SELECT instance_name, host_name, version, status, database_status,
                 logins, archiver, startup_time
          FROM v$instance`,
    destructive: false,
  },
  'instance.startup.open': {
    label: 'Startup (OPEN)',
    category: 'instance',
    type: 'ssh',
    commandKey: 'oracle.instance.startup.open',
    destructive: true,
    sysdba: true,
  },
  'instance.startup.mount': {
    label: 'Startup (MOUNT)',
    category: 'instance',
    type: 'ssh',
    commandKey: 'oracle.instance.startup.mount',
    destructive: true,
    sysdba: true,
  },
  'instance.startup.nomount': {
    label: 'Startup (NOMOUNT)',
    category: 'instance',
    type: 'ssh',
    commandKey: 'oracle.instance.startup.nomount',
    destructive: true,
    sysdba: true,
  },
  'instance.shutdown.immediate': {
    label: 'Shutdown Immediate',
    category: 'instance',
    type: 'ssh',
    commandKey: 'oracle.instance.shutdown.immediate',
    destructive: true,
    sysdba: true,
  },
  'instance.shutdown.abort': {
    label: 'Shutdown Abort',
    category: 'instance',
    type: 'ssh',
    commandKey: 'oracle.instance.shutdown.abort',
    destructive: true,
    sysdba: true,
  },

  // ── Listener ────────────────────────────────────────────────────────────────
  'listener.status': {
    label: 'Listener Status',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.status',
    destructive: false,
  },
  'listener.services': {
    label: 'Listener Services',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.services',
    destructive: false,
  },
  'listener.start': {
    label: 'Start Listener',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.start',
    destructive: true,
  },
  'listener.stop': {
    label: 'Stop Listener',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.stop',
    destructive: true,
  },
  'listener.reload': {
    label: 'Reload Listener',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.reload',
    destructive: false,
  },
  'listener.save_config': {
    label: 'Save Listener Config',
    category: 'listener',
    type: 'ssh',
    commandKey: 'oracle.listener.save_config',
    destructive: false,
  },

  // ── PDB Operations ──────────────────────────────────────────────────────────
  'pdb.list': {
    label: 'List PDBs',
    category: 'pdb',
    type: 'sql',
    sql: `SELECT name, open_mode, restricted, con_id FROM v$pdbs ORDER BY name`,
    destructive: false,
  },

  // ── Tablespace Ops ──────────────────────────────────────────────────────────
  'tablespace.usage': {
    label: 'Tablespace Usage',
    category: 'tablespace',
    type: 'sql',
    sql: `SELECT t.tablespace_name,
                 ROUND(t.bytes/1073741824,2) AS size_gb,
                 ROUND((t.bytes - NVL(f.bytes,0))/1073741824,2) AS used_gb,
                 ROUND(NVL(f.bytes,0)/1073741824,2) AS free_gb,
                 ROUND((t.bytes - NVL(f.bytes,0))*100/t.bytes,1) AS pct_used,
                 t.autoextensible
          FROM (
            SELECT tablespace_name, SUM(bytes) bytes,
                   MAX(CASE WHEN autoextensible='YES' THEN 'YES' ELSE 'NO' END) autoextensible
            FROM dba_data_files GROUP BY tablespace_name
          ) t
          LEFT JOIN (
            SELECT tablespace_name, SUM(bytes) bytes FROM dba_free_space GROUP BY tablespace_name
          ) f ON t.tablespace_name = f.tablespace_name
          ORDER BY pct_used DESC NULLS LAST`,
    destructive: false,
  },

  // ── Session Management ──────────────────────────────────────────────────────
  'sessions.active': {
    label: 'Active Sessions',
    category: 'sessions',
    type: 'sql',
    sql: `SELECT s.sid, s.serial#, s.username, s.status, s.machine,
                 s.program, s.sql_id, s.event, s.seconds_in_wait,
                 s.wait_class, s.logon_time
          FROM v$session s
          WHERE s.type = 'USER' AND s.status = 'ACTIVE'
          ORDER BY s.seconds_in_wait DESC NULLS LAST
          FETCH FIRST 50 ROWS ONLY`,
    destructive: false,
  },
  'sessions.all': {
    label: 'All User Sessions',
    category: 'sessions',
    type: 'sql',
    sql: `SELECT s.sid, s.serial#, s.username, s.status, s.machine,
                 s.program, s.event, s.wait_class, s.seconds_in_wait, s.logon_time
          FROM v$session s
          WHERE s.type = 'USER'
          ORDER BY s.status, s.username
          FETCH FIRST 100 ROWS ONLY`,
    destructive: false,
  },
  'sessions.blocking': {
    label: 'Blocking Session Tree',
    category: 'sessions',
    type: 'sql',
    sql: `SELECT l.sid AS blocker_sid, l.serial# AS blocker_serial,
                 l.username AS blocker_user,
                 w.sid AS waiter_sid, w.serial# AS waiter_serial,
                 w.username AS waiter_user,
                 w.seconds_in_wait, w.event, w.sql_id
          FROM v$session l
          JOIN v$session w ON w.blocking_session = l.sid
          WHERE l.blocking_session IS NULL
          ORDER BY w.seconds_in_wait DESC NULLS LAST`,
    destructive: false,
  },
  'sessions.kill': {
    label: 'Kill Session',
    category: 'sessions',
    type: 'sql',
    // sql is rendered dynamically: ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE
    sqlTemplate: `ALTER SYSTEM KILL SESSION '{{SID}},{{SERIAL}}' IMMEDIATE`,
    destructive: true,
    sysdba: false, // DBA privilege sufficient
  },

  // ── Memory Ops ──────────────────────────────────────────────────────────────
  'memory.components': {
    label: 'Memory Components',
    category: 'memory',
    type: 'sql',
    sql: `SELECT component, current_size/1048576 AS current_mb,
                 min_size/1048576 AS min_mb, max_size/1048576 AS max_mb,
                 granule_size/1048576 AS granule_mb, last_oper_type, last_oper_mode
          FROM v$sga_dynamic_components
          ORDER BY current_size DESC`,
    destructive: false,
  },
  'memory.sga_pga': {
    label: 'SGA / PGA Summary',
    category: 'memory',
    type: 'sql',
    sql: `SELECT name, value/1048576 AS mb FROM v$sga
          UNION ALL
          SELECT 'PGA Aggregate Target' AS name,
                 value/1048576 AS mb
          FROM v$parameter WHERE name = 'pga_aggregate_target'
          UNION ALL
          SELECT 'PGA Total Allocated', value/1048576
          FROM v$pgastat WHERE name = 'total PGA allocated'`,
    destructive: false,
  },
  'memory.flush_shared_pool': {
    label: 'Flush Shared Pool',
    category: 'memory',
    type: 'sql',
    sql: `ALTER SYSTEM FLUSH SHARED_POOL`,
    destructive: true,
    sysdba: true,
  },
  'memory.flush_buffer_cache': {
    label: 'Flush Buffer Cache',
    category: 'memory',
    type: 'sql',
    sql: `ALTER SYSTEM FLUSH BUFFER_CACHE`,
    destructive: true,
    sysdba: true,
  },

  // ── Statistics ──────────────────────────────────────────────────────────────
  'stats.stale': {
    label: 'Stale Statistics',
    category: 'stats',
    type: 'sql',
    sql: `SELECT owner, table_name, num_rows, last_analyzed,
                 stale_stats, stattype_locked
          FROM dba_tab_statistics
          WHERE (stale_stats = 'YES' OR last_analyzed IS NULL)
            AND owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                              'ORDDATA','CTXSYS','ANONYMOUS','XDB','WMSYS')
          ORDER BY owner, table_name
          FETCH FIRST 100 ROWS ONLY`,
    destructive: false,
  },
  'stats.locked': {
    label: 'Locked Statistics',
    category: 'stats',
    type: 'sql',
    sql: `SELECT owner, table_name, stattype_locked, num_rows, last_analyzed
          FROM dba_tab_statistics
          WHERE stattype_locked IS NOT NULL
            AND owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                              'ORDDATA','CTXSYS','ANONYMOUS','XDB','WMSYS')
          ORDER BY owner, table_name`,
    destructive: false,
  },
  'stats.gather_schema': {
    label: 'Gather Schema Stats',
    category: 'stats',
    type: 'sql',
    sqlTemplate: `BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(ownname => '{{SCHEMA}}', degree => 4); END;`,
    destructive: true,
  },
  'stats.gather_system': {
    label: 'Gather System Stats',
    category: 'stats',
    type: 'sql',
    sql: `BEGIN DBMS_STATS.GATHER_SYSTEM_STATS(); END;`,
    destructive: true,
  },
  'stats.gather_dictionary': {
    label: 'Gather Dictionary Stats',
    category: 'stats',
    type: 'sql',
    sql: `BEGIN DBMS_STATS.GATHER_DICTIONARY_STATS(); END;`,
    destructive: true,
    sysdba: false,
  },

  // ── Archive Log ─────────────────────────────────────────────────────────────
  'archive.status': {
    label: 'Archive Log Status',
    category: 'archive',
    type: 'sql',
    sql: `SELECT d.name, d.log_mode, i.archiver
          FROM v$database d CROSS JOIN v$instance i
          UNION ALL
          SELECT dest_id||' '||dest_name, status, target FROM v$archive_dest WHERE status != 'INACTIVE'`,
    destructive: false,
  },
  'archive.list_recent': {
    label: 'Recent Archive Logs',
    category: 'archive',
    type: 'sql',
    sql: `SELECT thread#, sequence#, name, blocks*block_size/1048576 AS size_mb,
                 completion_time
          FROM v$archived_log
          WHERE completion_time > SYSDATE - 1
          ORDER BY completion_time DESC
          FETCH FIRST 50 ROWS ONLY`,
    destructive: false,
  },
  'archive.switch_logfile': {
    label: 'Switch Log File',
    category: 'archive',
    type: 'sql',
    sql: `ALTER SYSTEM SWITCH LOGFILE`,
    destructive: true,
  },

  // ── RMAN ────────────────────────────────────────────────────────────────────
  'rman.last_backup': {
    label: 'Last Backup Summary',
    category: 'rman',
    type: 'sql',
    sql: `SELECT session_key, input_type, status,
                 start_time, end_time,
                 ROUND((end_time - start_time)*1440,1) AS duration_min,
                 ROUND(input_bytes/1073741824,2) AS input_gb
          FROM v$rman_backup_job_details
          ORDER BY start_time DESC
          FETCH FIRST 10 ROWS ONLY`,
    destructive: false,
  },
  'rman.status': {
    label: 'RMAN Crosscheck Status',
    category: 'rman',
    type: 'ssh',
    commandKey: 'oracle.rman.crosscheck',
    destructive: false,
  },
  'rman.retention': {
    label: 'RMAN Retention Policy',
    category: 'rman',
    type: 'ssh',
    commandKey: 'oracle.rman.show_retention',
    destructive: false,
  },
  'rman.list_expired': {
    label: 'List Expired Backups',
    category: 'rman',
    type: 'ssh',
    commandKey: 'oracle.rman.list_expired',
    destructive: false,
  },

  // ── ASM ─────────────────────────────────────────────────────────────────────
  // SQL ops (run against the RDBMS instance which can see V$ASM_* views via Oracle Net)
  'asm.diskgroups': {
    label: 'ASM Diskgroup Usage',
    category: 'asm',
    type: 'sql',
    sql: `SELECT name, state, type,
                 ROUND(total_mb/1024,1) AS total_gb,
                 ROUND(free_mb/1024,1) AS free_gb,
                 ROUND((total_mb-free_mb)*100/NULLIF(total_mb,0),1) AS pct_used
          FROM v$asm_diskgroup
          ORDER BY name`,
    destructive: false,
    requiresAsm: true,
  },
  'asm.disks': {
    label: 'ASM Disk Health',
    category: 'asm',
    type: 'sql',
    sql: `SELECT d.name, d.header_status, d.mode_status, d.state,
                 d.os_mb, d.total_mb, d.free_mb, d.reads, d.writes,
                 d.read_errs, d.write_errs, g.name AS group_name
          FROM v$asm_disk d
          LEFT JOIN v$asm_diskgroup g ON d.group_number = g.group_number
          ORDER BY d.group_number, d.disk_number`,
    destructive: false,
    requiresAsm: true,
  },
  'asm.rebalance': {
    label: 'ASM Rebalance Status',
    category: 'asm',
    type: 'sql',
    sql: `SELECT group_number, pass, state, sofar, est_work, est_rate, est_minutes
          FROM v$asm_operation`,
    destructive: false,
    requiresAsm: true,
  },
  // GI SSH ops — require gi_os_user + gi_oracle_home + asm_sid on the connection
  'gi.asm.diskgroups': {
    label: 'ASM Diskgroups (asmcmd lsdg)',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.diskgroups',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.disks': {
    label: 'ASM Disk Status (asmcmd lsdsk)',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.disks',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.rebalance': {
    label: 'ASM Rebalance (asmcmd lsop)',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.rebalance',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.alertlog': {
    label: 'ASM Alert Log ORA- Errors',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.alertlog',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.parameters': {
    label: 'ASM Key Parameters',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.parameters',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.diskgroup.mount': {
    label: 'Mount ASM Diskgroup',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.diskgroup.mount',
    commandPreviewOverride: 'asmcmd mount {{DG_NAME}}',
    destructive: false,
    requiresGi: true,
  },
  'gi.asm.diskgroup.dismount': {
    label: 'Dismount ASM Diskgroup',
    category: 'asm',
    type: 'ssh',
    commandKey: 'gi.asm.diskgroup.dismount',
    commandPreviewOverride: 'asmcmd umount {{DG_NAME}}',
    destructive: true,
    requiresGi: true,
  },

  // ── RAC ─────────────────────────────────────────────────────────────────────
  // SQL ops (run against RDBMS, which can see GV$ views via Oracle Net)
  'rac.instances': {
    label: 'RAC Instances',
    category: 'rac',
    type: 'sql',
    sql: `SELECT inst_id, instance_name, host_name, status, database_status,
                 active_state, startup_time
          FROM gv$instance
          ORDER BY inst_id`,
    destructive: false,
    requiresRac: true,
  },
  'rac.services': {
    label: 'RAC Services',
    category: 'rac',
    type: 'sql',
    sql: `SELECT name, pdb, network_name, enabled, active_instances
          FROM gv$services
          GROUP BY name, pdb, network_name, enabled, active_instances
          ORDER BY name`,
    destructive: false,
    requiresRac: true,
  },
  'rac.interconnects': {
    label: 'Cluster Interconnects',
    category: 'rac',
    type: 'sql',
    sql: `SELECT inst_id, name, ip_address, is_public, source FROM gv$cluster_interconnects ORDER BY inst_id`,
    destructive: false,
    requiresRac: true,
  },
  // GI SSH ops — require gi_os_user + gi_oracle_home on the connection
  'rac.srvctl_status': {
    label: 'CRS Resource Status (srvctl)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'oracle.rac.srvctl_status',
    destructive: false,
    requiresRac: true,
  },
  'gi.rac.crs.status': {
    label: 'CRS Resource Status (crsctl stat res -t)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.crs.status',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.crs.check': {
    label: 'CRS Health Check (crsctl check crs)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.crs.check',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.vip.status': {
    label: 'VIP Status (srvctl status vip)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.vip.status',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.scan.listener': {
    label: 'SCAN Listener Status',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.scan.listener',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.ocr.check': {
    label: 'OCR Integrity Check (ocrcheck)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.ocr.check',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.db.services': {
    label: 'Database Services (srvctl status database)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.db.services',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.nodeapps.status': {
    label: 'Node Apps Status (srvctl status nodeapps)',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.nodeapps.status',
    destructive: false,
    requiresGi: true,
  },
  'gi.rac.instance.stop': {
    label: 'Stop RAC Instance',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.instance.stop',
    commandPreviewOverride: 'srvctl stop instance -d {{DB_NAME}} -n {{NODE_NAME}}',
    destructive: true,
    requiresGi: true,
  },
  'gi.rac.instance.start': {
    label: 'Start RAC Instance',
    category: 'rac',
    type: 'ssh',
    commandKey: 'gi.rac.instance.start',
    commandPreviewOverride: 'srvctl start instance -d {{DB_NAME}} -n {{NODE_NAME}}',
    destructive: true,
    requiresGi: true,
  },

  // ── WLS Admin Server ─────────────────────────────────────────────────────
  'wls.adminserver.status': {
    label: 'AdminServer Status',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.adminserver.status',
    destructive: false,
    requiresEbs: true,
  },
  'wls.adminserver.start': {
    label: 'Start AdminServer',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.adminserver.start',
    destructive: true,
    requiresEbs: true,
  },
  'wls.adminserver.stop': {
    label: 'Stop AdminServer',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.adminserver.stop',
    destructive: true,
    requiresEbs: true,
  },
  'wls.adminserver.restart': {
    label: 'Restart AdminServer',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.adminserver.restart',
    destructive: true,
    requiresEbs: true,
  },
  'wls.adminserver.port': {
    label: 'AdminServer Port Check (7001/7002)',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.adminserver.port',
    destructive: false,
    requiresEbs: true,
  },
  'wls.managed.list': {
    label: 'All Managed Server States',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.managed.list',
    destructive: false,
    requiresEbs: true,
  },
  'wls.oacore.status': {
    label: 'OACore Status',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oacore.status',
    destructive: false,
    requiresEbs: true,
  },
  'wls.oacore.start': {
    label: 'Start OACore',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oacore.start',
    destructive: true,
    requiresEbs: true,
  },
  'wls.oacore.stop': {
    label: 'Stop OACore',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oacore.stop',
    destructive: true,
    requiresEbs: true,
  },
  'wls.oafm.status': {
    label: 'OAFM Status',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oafm.status',
    destructive: false,
    requiresEbs: true,
  },
  'wls.oafm.start': {
    label: 'Start OAFM',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oafm.start',
    destructive: true,
    requiresEbs: true,
  },
  'wls.oafm.stop': {
    label: 'Stop OAFM',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.oafm.stop',
    destructive: true,
    requiresEbs: true,
  },
  'wls.forms.status': {
    label: 'Forms Server Status',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.forms.status',
    destructive: false,
    requiresEbs: true,
  },
  'wls.forms.start': {
    label: 'Start Forms Server',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.forms.start',
    destructive: true,
    requiresEbs: true,
  },
  'wls.forms.stop': {
    label: 'Stop Forms Server',
    category: 'wls',
    type: 'ssh',
    commandKey: 'wls.forms.stop',
    destructive: true,
    requiresEbs: true,
  },

  // ── Apache / OPMN ────────────────────────────────────────────────────────
  'apache.status': {
    label: 'Apache / OHS Status',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.apache.status',
    destructive: false,
    requiresEbs: true,
  },
  'apache.start': {
    label: 'Start Apache / OHS',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.apache.start',
    destructive: true,
    requiresEbs: true,
  },
  'apache.stop': {
    label: 'Stop Apache / OHS',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.apache.stop',
    destructive: true,
    requiresEbs: true,
  },
  'apache.restart': {
    label: 'Restart Apache / OHS',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.apache.restart',
    destructive: true,
    requiresEbs: true,
  },
  'apache.opmn.list': {
    label: 'OPMN Process List',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.opmn.list',
    destructive: false,
    requiresEbs: true,
  },
  'apache.errorlog': {
    label: 'Apache Error Log (last 50 lines)',
    category: 'apache',
    type: 'ssh',
    commandKey: 'ebs.apache.errorlog',
    destructive: false,
    requiresEbs: true,
  },

  // ── Apps Listener ─────────────────────────────────────────────────────────
  'appslistener.status': {
    label: 'Apps Listener Status',
    category: 'apps_listener',
    type: 'ssh',
    commandKey: 'ebs.appslistener.status',
    destructive: false,
    requiresEbs: true,
  },
  'appslistener.start': {
    label: 'Start Apps Listener',
    category: 'apps_listener',
    type: 'ssh',
    commandKey: 'ebs.appslistener.start',
    destructive: true,
    requiresEbs: true,
  },
  'appslistener.stop': {
    label: 'Stop Apps Listener',
    category: 'apps_listener',
    type: 'ssh',
    commandKey: 'ebs.appslistener.stop',
    destructive: true,
    requiresEbs: true,
  },
  'appslistener.services': {
    label: 'Apps Listener Services',
    category: 'apps_listener',
    type: 'ssh',
    commandKey: 'ebs.appslistener.services',
    destructive: false,
    requiresEbs: true,
  },
  'appslistener.log': {
    label: 'Apps Listener Log (last 50 lines)',
    category: 'apps_listener',
    type: 'ssh',
    commandKey: 'ebs.appslistener.log',
    destructive: false,
    requiresEbs: true,
  },

  // ── EBS Concurrent Requests (read-only SQL) ───────────────────────────────
  'ebs.concurrent.running': {
    label: 'Running Concurrent Requests',
    category: 'ebs_concurrent',
    type: 'sql',
    // APPS schema — only valid on EBS connections
    sql: `SELECT r.request_id,
                 r.phase_code,
                 r.status_code,
                 NVL(p.user_concurrent_program_name, r.concurrent_program_id) AS program,
                 r.requestor,
                 r.actual_start_date,
                 ROUND((SYSDATE - r.actual_start_date) * 1440, 1) AS runtime_minutes
          FROM apps.fnd_concurrent_requests r
          LEFT JOIN apps.fnd_concurrent_programs_vl p
            ON p.concurrent_program_id = r.concurrent_program_id
           AND p.application_id        = r.program_application_id
          WHERE r.phase_code = 'R'
            AND r.status_code IN ('R', 'T', 'B')
          ORDER BY r.actual_start_date NULLS LAST
          FETCH FIRST 100 ROWS ONLY`,
    destructive: false,
    requiresEbs: true,
  },

  // ── EBS All-nodes start/stop ──────────────────────────────────────────────
  'ebs.allnodes.start': {
    label: 'Start All Apps Services (All Nodes)',
    category: 'ebs_concurrent',
    type: 'ssh',
    commandKey: 'ebs.allnodes.start',
    destructive: true,
    requiresEbs: true,
  },
  'ebs.allnodes.stop': {
    label: 'Stop All Apps Services (All Nodes)',
    category: 'ebs_concurrent',
    type: 'ssh',
    commandKey: 'ebs.allnodes.stop',
    destructive: true,
    requiresEbs: true,
  },

  // ── FRA (Flash Recovery Area) ─────────────────────────────────────────────
  'fra.usage': {
    label: 'FRA Usage',
    category: 'fra',
    type: 'sql',
    sql: `SELECT space_limit/1073741824 AS limit_gb,
                 space_used/1073741824 AS used_gb,
                 ROUND(space_used*100/NULLIF(space_limit,0),1) AS pct_used,
                 space_reclaimable/1073741824 AS reclaimable_gb
          FROM v$recovery_file_dest`,
    destructive: false,
  },
  'fra.files': {
    label: 'FRA Contents (by type)',
    category: 'fra',
    type: 'sql',
    sql: `SELECT file_type,
                 number_of_files AS file_count,
                 ROUND(percent_space_used,1) AS pct_used,
                 ROUND(percent_space_reclaimable,1) AS pct_reclaimable
          FROM v$flash_recovery_area_usage
          ORDER BY percent_space_used DESC NULLS LAST`,
    destructive: false,
  },
  'fra.delete_obsolete': {
    label: 'Delete Obsolete FRA Files (RMAN)',
    category: 'fra',
    type: 'ssh',
    commandKey: 'oracle.rman.delete_obsolete',
    destructive: true,
  },

  // ── Controlfile ───────────────────────────────────────────────────────────
  'controlfile.info': {
    label: 'Controlfile Info',
    category: 'controlfile',
    type: 'sql',
    sql: `SELECT name, status, is_recovery_dest_file, block_size, file_size_blks
          FROM v$controlfile
          UNION ALL
          SELECT 'AUTOBACKUP_ENABLED' AS name, value AS status,
                 'NO' AS is_recovery_dest_file, NULL AS block_size, NULL AS file_size_blks
          FROM v$rman_configuration WHERE name = 'CONTROLFILE AUTOBACKUP'`,
    destructive: false,
  },
  'controlfile.backup': {
    label: 'Backup Controlfile to Trace',
    category: 'controlfile',
    type: 'sql',
    sql: `ALTER DATABASE BACKUP CONTROLFILE TO TRACE AS REUSE RESETLOGS`,
    destructive: true,
    sysdba: true,
  },

  // ── Recycle Bin ───────────────────────────────────────────────────────────
  'recyclebin.show': {
    label: 'Recycle Bin Contents',
    category: 'recyclebin',
    type: 'sql',
    sql: `SELECT owner, type, original_name, object_name, droptime,
                 ROUND(space*8192/1048576,1) AS size_mb
          FROM dba_recyclebin
          ORDER BY droptime DESC
          FETCH FIRST 50 ROWS ONLY`,
    destructive: false,
  },
  'recyclebin.purge': {
    label: 'Purge DBA Recycle Bin',
    category: 'recyclebin',
    type: 'sql',
    sql: `PURGE DBA_RECYCLEBIN`,
    destructive: true,
    sysdba: true,
  },

  // ── Large Segments ────────────────────────────────────────────────────────
  'segments.large': {
    label: 'Large Segment Report',
    category: 'segments',
    type: 'sql',
    sql: `SELECT owner, segment_name, segment_type, tablespace_name,
                 ROUND(bytes/1073741824,2) AS size_gb
          FROM dba_segments
          WHERE bytes > 104857600   -- > 100 MB
            AND owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                              'ORDDATA','CTXSYS','ANONYMOUS','XDB','WMSYS')
          ORDER BY bytes DESC
          FETCH FIRST 50 ROWS ONLY`,
    destructive: false,
  },
  'segments.top_growth': {
    label: 'Top Growing Segments (AWR)',
    category: 'segments',
    type: 'sql',
    sql: `SELECT o.owner, o.object_name, o.object_type, o.tablespace_name,
                 ROUND(s.space_used_delta/1048576,1) AS growth_mb,
                 ROUND(s.space_used_total/1048576,1) AS total_mb
          FROM dba_hist_seg_stat s
          JOIN dba_hist_seg_stat_obj o
            ON s.obj# = o.obj# AND s.dataobj# = o.dataobj# AND s.ts# = o.ts#
          WHERE s.snap_id = (SELECT MAX(snap_id) FROM dba_hist_snapshot)
            AND s.space_used_delta > 0
          ORDER BY s.space_used_delta DESC
          FETCH FIRST 30 ROWS ONLY`,
    destructive: false,
  },

  // ── Undo Management ───────────────────────────────────────────────────────
  'undo.status': {
    label: 'Undo Segment Status',
    category: 'undo',
    type: 'sql',
    sql: `SELECT tablespace_name, status, SUM(blocks)*8/1024 AS size_mb, COUNT(*) AS segs
          FROM dba_undo_extents
          GROUP BY tablespace_name, status
          ORDER BY tablespace_name, status`,
    destructive: false,
  },
  'undo.advisor': {
    label: 'Undo Advisor (UNDOSTAT)',
    category: 'undo',
    type: 'sql',
    sql: `SELECT TO_CHAR(begin_time,'DD-MON HH24:MI') AS period_start,
                 ROUND(undoblks*8/1024,1) AS undo_mb_generated,
                 txncount, maxquerylen, maxconcurrency,
                 ROUND(expiredblks*8/1024,1) AS expired_mb,
                 ROUND(unexpiredblks*8/1024,1) AS unexpired_mb,
                 ROUND(tuned_undoretention/60,1) AS retention_min
          FROM v$undostat
          ORDER BY begin_time DESC
          FETCH FIRST 12 ROWS ONLY`,
    destructive: false,
  },

  // ── Temp Tablespace ───────────────────────────────────────────────────────
  'temp.usage': {
    label: 'Temp Tablespace Usage',
    category: 'temp',
    type: 'sql',
    sql: `SELECT ts.tablespace_name,
                 ROUND(ts.bytes_used/1048576,1) AS used_mb,
                 ROUND(ts.bytes_free/1048576,1) AS free_mb,
                 ROUND(ts.bytes_used*100/NULLIF(ts.bytes_used+ts.bytes_free,0),1) AS pct_used
          FROM (
            SELECT tablespace_name,
                   SUM(bytes_used) bytes_used,
                   SUM(bytes_free) bytes_free
            FROM v$temp_space_header
            GROUP BY tablespace_name
          ) ts
          ORDER BY pct_used DESC NULLS LAST`,
    destructive: false,
  },
  'temp.sessions': {
    label: 'Temp Usage by Session',
    category: 'temp',
    type: 'sql',
    sql: `SELECT s.sid, s.serial#, s.username, s.status, s.sql_id,
                 ROUND(t.blocks*8/1024,1) AS temp_mb
          FROM v$sort_usage t
          JOIN v$session s ON s.saddr = t.session_addr
          ORDER BY t.blocks DESC
          FETCH FIRST 30 ROWS ONLY`,
    destructive: false,
  },

  // ── Scheduler Jobs ────────────────────────────────────────────────────────
  'scheduler.running': {
    label: 'Running Scheduler Jobs',
    category: 'scheduler',
    type: 'sql',
    sql: `SELECT owner, job_name, status, cpu_used, session_id,
                 actual_start_date, running_instance
          FROM dba_scheduler_running_jobs
          ORDER BY actual_start_date`,
    destructive: false,
  },
  'scheduler.failed': {
    label: 'Failed Scheduler Jobs (7 days)',
    category: 'scheduler',
    type: 'sql',
    sql: `SELECT owner, job_name, status, error#, run_duration,
                 actual_start_date
          FROM dba_scheduler_job_run_details
          WHERE status = 'FAILED'
            AND actual_start_date > SYSDATE - 7
          ORDER BY actual_start_date DESC
          FETCH FIRST 50 ROWS ONLY`,
    destructive: false,
  },
  'scheduler.disabled': {
    label: 'Disabled Scheduler Jobs',
    category: 'scheduler',
    type: 'sql',
    sql: `SELECT owner, job_name, job_type, state, last_run_duration,
                 next_run_date, enabled
          FROM dba_scheduler_jobs
          WHERE enabled = 'FALSE'
            AND owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN',
                              'WMSYS','ORACLE_OCM')
          ORDER BY owner, job_name`,
    destructive: false,
  },

  // ── Invalid Objects ───────────────────────────────────────────────────────
  'objects.invalid': {
    label: 'Invalid Objects',
    category: 'objects',
    type: 'sql',
    sql: `SELECT owner, object_name, object_type, status, last_ddl_time
          FROM dba_objects
          WHERE status = 'INVALID'
            AND owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                              'ORDDATA','CTXSYS','ANONYMOUS','XDB','WMSYS')
          ORDER BY owner, object_type, object_name
          FETCH FIRST 200 ROWS ONLY`,
    destructive: false,
  },
  'objects.recompile': {
    label: 'Recompile All Invalid Objects',
    category: 'objects',
    type: 'sql',
    sql: `BEGIN DBMS_UTILITY.COMPILE_SCHEMA(schema => USER, compile_all => FALSE); END;`,
    destructive: true,
  },
  'objects.recompile_all': {
    label: 'UTL_RECOMP (All Schemas, Parallel)',
    category: 'objects',
    type: 'sql',
    sql: `BEGIN UTL_RECOMP.RECOMP_PARALLEL(4); END;`,
    destructive: true,
    sysdba: true,
  },

  // ── User Management ───────────────────────────────────────────────────────
  'users.list': {
    label: 'Database Users',
    category: 'users',
    type: 'sql',
    sql: `SELECT username, account_status, profile, default_tablespace,
                 lock_date, expiry_date, created
          FROM dba_users
          WHERE username NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                                 'ORDDATA','CTXSYS','ANONYMOUS','XDB','WMSYS',
                                 'APPQOSSYS','ORACLE_OCM','DVSYS','AUDSYS','GSMADMIN_INTERNAL')
          ORDER BY account_status, username`,
    destructive: false,
  },
  'users.locked': {
    label: 'Locked / Expired Accounts',
    category: 'users',
    type: 'sql',
    sql: `SELECT username, account_status, lock_date, expiry_date, profile
          FROM dba_users
          WHERE account_status NOT IN ('OPEN')
          ORDER BY account_status, username`,
    destructive: false,
  },
  'users.profiles': {
    label: 'Password Profiles',
    category: 'users',
    type: 'sql',
    sql: `SELECT profile, resource_name, limit
          FROM dba_profiles
          WHERE resource_name IN (
            'PASSWORD_LIFE_TIME','PASSWORD_REUSE_TIME','PASSWORD_REUSE_MAX',
            'FAILED_LOGIN_ATTEMPTS','PASSWORD_LOCK_TIME','PASSWORD_GRACE_TIME'
          )
          ORDER BY profile, resource_name`,
    destructive: false,
  },
};

// ─── Low-level Oracle connection helper ──────────────────────────────────────

let _oracledb = null;
function getOracledb() {
  if (!_oracledb) {
    try { _oracledb = require('oracledb'); } catch (_) { return null; }
  }
  return _oracledb;
}

async function withOracleConnection(connParams, fn) {
  const oracledb = getOracledb();
  if (!oracledb) throw new Error('Oracle client not available');
  const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
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

// ─── Detection queries ────────────────────────────────────────────────────────

async function detectCapabilities(connParams) {
  const out = { hasAsm: false, hasRac: false, hasPdb: false };
  const oracledb = getOracledb();
  if (!oracledb) return out;

  try {
    await withOracleConnection(connParams, async (conn) => {
      async function q(sql) {
        try { return await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY }); }
        catch (_) { return null; }
      }

      const racR = await q(`SELECT value FROM v$parameter WHERE name='cluster_database'`);
      out.hasRac = racR?.rows?.some(r => String(r[0] || '').toUpperCase() === 'TRUE') || false;

      const asmR = await q(`SELECT COUNT(*) FROM v$asm_diskgroup`);
      out.hasAsm = Number(asmR?.rows?.[0]?.[0] || 0) > 0;

      const pdbR = await q(`SELECT COUNT(*) FROM v$pdbs WHERE con_id > 2`);
      out.hasPdb = Number(pdbR?.rows?.[0]?.[0] || 0) > 0;
    });
  } catch (_) {}

  return out;
}

// ─── Op executor ─────────────────────────────────────────────────────────────

/**
 * Run a DB Op.
 * @param {Object} opts
 * @param {string}      opts.opKey
 * @param {Object}      opts.connParams  — { host, port, serviceName, username, password,
 *                                          giOsUser?, giOracleHome?, asmSid? }
 * @param {number|null} opts.targetId    — SSH target ID (for SSH ops)
 * @param {string}      opts.initiatedBy
 * @param {boolean}     [opts.confirmed] — must be true for destructive ops
 * @param {Object}      [opts.params]    — runtime params (SID, SERIAL, SCHEMA, DG_NAME, etc.)
 * @returns {Promise<{ ok, rows, columns, text, error, commandPreview }>}
 */
async function runOp({ opKey, connParams, targetId = null, initiatedBy, confirmed = false, params = {} }) {
  const op = OP_CATALOG[opKey];
  if (!op) {
    return { ok: false, error: `Unknown op: ${opKey}` };
  }

  // GI ops require GI credentials on the connection
  if (op.requiresGi && (!connParams.giOsUser || !connParams.giOracleHome)) {
    return { ok: false, error: 'This operation requires Grid Infrastructure credentials. Configure gi_os_user and gi_oracle_home on the connection.' };
  }

  // Safety: destructive ops must be explicitly confirmed
  if (op.destructive && !confirmed) {
    return { ok: false, error: 'Confirmation required for destructive operations', commandPreview: renderPreview(op, params) };
  }

  if (op.type === 'sql') {
    return runSqlOp(op, connParams, params, initiatedBy);
  } else if (op.type === 'ssh') {
    if (!targetId) return { ok: false, error: 'Requires SSH target — Configure SSH Access to enable (/admin/ssh-targets)' };
    // Build GI substitution vars from connection params + caller params
    const extraVars = {};
    if (connParams.giOsUser)    extraVars.GI_OS_USER    = connParams.giOsUser;
    if (connParams.giOracleHome) extraVars.GI_ORACLE_HOME = connParams.giOracleHome;
    if (connParams.asmSid)      extraVars.ASM_SID       = connParams.asmSid;
    // Caller params (DG_NAME, DB_NAME, NODE_NAME) forwarded too
    for (const [k, v] of Object.entries(params)) {
      if (v) extraVars[k] = String(v);
    }
    return runSshOp(op, targetId, initiatedBy, extraVars);
  }
  return { ok: false, error: `Unknown op type: ${op.type}` };
}

function renderPreview(op, params) {
  if (op.type === 'ssh') return `ssh: ${op.commandKey}`;
  let sql = op.sqlTemplate || op.sql || '';
  for (const [k, v] of Object.entries(params)) {
    // Only allow simple alphanumeric/underscore values in substitutions (guard injection)
    if (/^[a-zA-Z0-9_$#]*$/.test(String(v))) {
      sql = sql.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }
  return sql;
}

async function runSqlOp(op, connParams, params, initiatedBy) {
  const oracledb = getOracledb();
  if (!oracledb) return { ok: false, error: 'Oracle client not available' };

  let sql = op.sqlTemplate ? renderPreview(op, params) : op.sql;

  // Guard: if template still has placeholders, reject
  if (sql.includes('{{')) {
    return { ok: false, error: 'Missing required parameters' };
  }

  try {
    return await withOracleConnection(connParams, async (conn) => {
      const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
      return {
        ok: true,
        rows: result.rows || [],
        columns: (result.metaData || []).map(c => c.name),
        text: null,
      };
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function runSshOp(op, targetId, initiatedBy, extraVars = {}) {
  try {
    const result = await sshExec.runCommand({
      targetId,
      commandKey: op.commandKey,
      initiatedBy,
      extraVars,
    });
    return {
      ok: result.ok,
      rows: null,
      columns: null,
      text: result.stdout || result.stderr,
      error: result.ok ? null : (result.rejectionReason || 'SSH execution failed'),
      durationMs: result.durationMs,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Privilege derivation ─────────────────────────────────────────────────────
//
// requiredPrivilege: 'reader' | 'dba_role' | 'sysdba'
//
// 'reader'   — works with tunevault_reader (SELECT_CATALOG_ROLE + explicit V$ grants)
// 'dba_role' — needs DBA role or specific elevated grants (EXECUTE on DBMS_STATS,
//              DBMS_RMAN views, ADVISOR, or SSH ops that require oracle OS user)
// 'sysdba'   — needs SYSDBA/OS Auth: ALTER SYSTEM, ALTER DATABASE, instance lifecycle,
//              kill session, flush pools, EBS start/stop all
//
// Explicit overrides per op key take priority; otherwise derive from op fields.

const PRIVILEGE_OVERRIDES = {
  // Instance lifecycle — SYSDBA required for startup/shutdown
  'instance.startup.open':         'sysdba',
  'instance.startup.mount':        'sysdba',
  'instance.startup.nomount':      'sysdba',
  'instance.shutdown.immediate':   'sysdba',
  'instance.shutdown.abort':       'sysdba',
  // Kill session — ALTER SYSTEM requires SYSDBA or DBA; we gate at sysdba to be safe
  'sessions.kill':                 'sysdba',
  // Memory flush — ALTER SYSTEM
  'memory.flush_shared_pool':      'sysdba',
  'memory.flush_buffer_cache':     'sysdba',
  // Archive switch — ALTER SYSTEM
  'archive.switch_logfile':        'sysdba',
  // Stats gathering — EXECUTE on DBMS_STATS (dba_role covers this via tunevault_reader grants)
  'stats.gather_schema':           'dba_role',
  'stats.gather_system':           'dba_role',
  'stats.gather_dictionary':       'dba_role',
  // RMAN — V$RMAN views accessible with DBA; RMAN crosscheck requires connection as target DB owner
  'rman.last_backup':              'dba_role',
  'rman.status':                   'dba_role',
  'rman.retention':                'dba_role',
  'rman.list_expired':             'dba_role',
  // EBS start/stop all — requires OS auth / SYSDBA
  'ebs.allnodes.start':            'sysdba',
  'ebs.allnodes.stop':             'sysdba',
  // GI/RAC srvctl — SSH as GI OS user, functionally DBA-level
  'gi.rac.instance.stop':          'sysdba',
  'gi.rac.instance.start':         'sysdba',
  'gi.asm.diskgroup.dismount':     'sysdba',
  // WLS/Apache stop/start/restart — DBA-level SSH
  'wls.adminserver.start':         'dba_role',
  'wls.adminserver.stop':          'dba_role',
  'wls.adminserver.restart':       'dba_role',
  'wls.oacore.start':              'dba_role',
  'wls.oacore.stop':               'dba_role',
  'wls.oafm.start':                'dba_role',
  'wls.oafm.stop':                 'dba_role',
  'wls.forms.start':               'dba_role',
  'wls.forms.stop':                'dba_role',
  'apache.start':                  'dba_role',
  'apache.stop':                   'dba_role',
  'apache.restart':                'dba_role',
  'appslistener.start':            'dba_role',
  'appslistener.stop':             'dba_role',
  // Listener start/stop — SSH as oracle OS user
  'listener.start':                'dba_role',
  'listener.stop':                 'dba_role',
  // FRA delete obsolete — RMAN SSH
  'fra.delete_obsolete':           'dba_role',
  // Controlfile backup — ALTER DATABASE
  'controlfile.backup':            'sysdba',
  // Recycle bin purge — PURGE DBA_RECYCLEBIN
  'recyclebin.purge':              'sysdba',
  // Recompile — UTL_RECOMP
  'objects.recompile_all':         'sysdba',
};

// Human-readable labels for the privilege tiers
const PRIVILEGE_LABELS = {
  reader:   'Standard (tunevault_reader)',
  dba_role: 'DBA Role',
  sysdba:   'SYSDBA',
};

// Grant hint for each tier — shown in tooltip on gated ops
const PRIVILEGE_GRANT_HINTS = {
  dba_role: 'Requires DBA role or elevated privileges beyond SELECT_CATALOG_ROLE',
  sysdba:   'Requires SYSDBA / OS authentication',
};

function derivePrivilege(key, op) {
  if (PRIVILEGE_OVERRIDES[key]) return PRIVILEGE_OVERRIDES[key];
  // sysdba flag on op
  if (op.sysdba) return 'sysdba';
  // SSH ops that are destructive generally need DBA-level OS access
  if (op.type === 'ssh' && op.destructive) return 'dba_role';
  // SSH status/read ops need oracle OS user access — dba_role is appropriate
  if (op.type === 'ssh') return 'dba_role';
  // SQL ops: destructive SQL without sysdba flag → dba_role
  if (op.destructive) return 'dba_role';
  // Non-destructive SQL: covered by tunevault_reader
  return 'reader';
}

// ─── Catalog getter ───────────────────────────────────────────────────────────

function getOpCatalog() {
  return Object.entries(OP_CATALOG).map(([key, op]) => {
    const requiredPrivilege = derivePrivilege(key, op);
    return {
      key,
      label: op.label,
      category: op.category,
      type: op.type,
      destructive: op.destructive || false,
      sysdba: op.sysdba || false,
      requiresAsm: op.requiresAsm || false,
      requiresRac: op.requiresRac || false,
      requiresGi: op.requiresGi || false,
      requiresEbs: op.requiresEbs || false,
      requiredPrivilege,
      privilegeLabel: PRIVILEGE_LABELS[requiredPrivilege],
      privilegeGrantHint: PRIVILEGE_GRANT_HINTS[requiredPrivilege] || null,
      commandPreview: op.commandPreviewOverride || op.sql || op.sqlTemplate || (op.commandKey ? `ssh: ${op.commandKey}` : ''),
    };
  });
}

module.exports.PRIVILEGE_LABELS = PRIVILEGE_LABELS;

// Render the SQL for a given op key with substituted params.
// Used by db-ops.js to get the SQL to send to the proxy /api/run_sql endpoint.
function renderOpSql(opKey, params = {}) {
  const op = OP_CATALOG[opKey];
  if (!op || op.type !== 'sql') return null;
  return renderPreview(op, params);
}

module.exports = { runOp, getOpCatalog, detectCapabilities, renderOpSql };
