'use strict';

/* eslint-disable no-await-in-loop */

const AUTHOR = 'Kiran Kumar Ale';

// ── Article content ──────────────────────────────────────────────────────────

const ZDM_CONTENT = `
## What Is Oracle ZDM?

Oracle Zero Downtime Migration (ZDM) is Oracle's own tooling for migrating Oracle databases with minimal or zero application downtime. Introduced alongside Oracle Database 19c, it has matured significantly through 21c and 23ai patch cycles.

ZDM handles the complexity of database migration by orchestrating:

- Physical or logical replication to the target while your source stays live
- Continuous synchronization during the migration window
- A coordinated switchover that completes in 2–15 minutes

The phrase "zero downtime" is slightly optimistic. You will have a brief switchover window. What ZDM eliminates is the multi-hour planned outage of traditional export/import or straight RMAN restore approaches.

## Architecture Overview

ZDM uses three distinct tiers:

**ZDM Service Host** — A dedicated server or VM where the ZDM software is installed. This host orchestrates the migration but processes no data itself. It needs SSH access to both source and target database hosts.

**Source Database Host** — Your existing production Oracle server. ZDM connects here to take backups, configure Data Guard, or drive a Data Pump export.

**Target Database Host** — The destination. For cloud migrations this is typically an Oracle Base Database Service or ExaCS instance. For on-premises targets it is any Oracle-supported Linux host.

The ZDM service coordinates everything through a sequential phase model: it SSH's into both endpoints, executes remote commands, and tracks migration progress through a series of named phases with checkpoint/resume capability.

## Migration Methods: Physical vs Logical

ZDM offers three migration methods, and the choice matters enormously for large databases:

**Physical Migration (RMAN-based)** — Uses RMAN backup and restore to transfer the database to the target, then configures a Data Guard standby for ongoing redo apply. Switchover is a Data Guard role change. Fastest for large databases (multi-TB). Requires compatible OS and endian format between source and target.

**Logical Migration (Data Pump-based)** — Exports schema and data using Oracle Data Pump, with optional GoldenGate for continuous replication. Required for cross-platform, cross-version, or cross-endian migrations. Slower for large databases but more flexible.

**Online Logical Migration** — Combines Data Pump for the initial load with GoldenGate Microservices for continuous replication. True near-zero downtime. Requires GoldenGate licensing.

For most lift-and-shift migrations to OCI, physical migration is the right choice. You get faster transfer times and a simpler change model.

## Prerequisites Checklist

Before you run a single zdmcli command, verify each of these:

### Network and SSH Connectivity
\`\`\`bash
# From ZDM host — test passwordless SSH to both source and target
ssh -i /home/zdmuser/.ssh/id_rsa oracle@sourcehost "echo OK"
ssh -i /home/zdmuser/.ssh/id_rsa oracle@targethost "echo OK"

# Verify oracle user has passwordless sudo
ssh oracle@sourcehost "sudo /bin/ls /etc/oratab"
\`\`\`

### Oracle Database Versions
- ZDM software version should be >= your target Oracle version
- Source DB minimum: 11.2.0.4 for physical migration, 12.1.0.2 for logical
- Target: same version or higher than source

### Wallets and sys Credentials
\`\`\`bash
# Create source wallet with MKSTORE
mkstore -wrl /home/zdmuser/wallets/src -create
mkstore -wrl /home/zdmuser/wallets/src -createCredential "sourcehost:1521/PRODDB" sys

# Create target wallet
mkstore -wrl /home/zdmuser/wallets/tgt -create
mkstore -wrl /home/zdmuser/wallets/tgt -createCredential "targethost:1521/PRODDB_TGT" sys

# Create sqlnet.ora on ZDM host pointing to wallet
cat > $ORACLE_HOME/network/admin/sqlnet.ora <<EOF
WALLET_LOCATION = (SOURCE = (METHOD = FILE)(METHOD_DATA = (DIRECTORY = /home/zdmuser/wallets/src)))
SQLNET.WALLET_OVERRIDE = TRUE
EOF
\`\`\`

### Disk Space
- ZDM host: 30+ GB for software and working logs
- Source: enough for RMAN backup (use \`RMAN_COMPRESSION_ALGORITHM=MEDIUM\` to reduce)
- OCI Object Storage bucket: pre-created with correct compartment permissions

## Starting the ZDM Service

\`\`\`bash
export ZDM_HOME=/u01/zdmhome
export ZDM_BASE=/u01/zdmbase

# Start
$ZDM_HOME/bin/zdmservice start

# Verify
$ZDM_HOME/bin/zdmservice status

# Expected:
# ZDM Service is up and running.
# Listening on port: 8895

# Logs go here if something is wrong
tail -100 $ZDM_BASE/zdm/log/zdm_service.log
\`\`\`

## The Response File

The response file is the single most important artefact in the migration. Every parameter lives here.

\`\`\`properties
# /home/zdmuser/response/prod_to_oci.rsp

# Target DB unique name (must match what you provisioned on OCI)
TGT_DB_UNIQUE_NAME=PRODDB_TGT

# Physical migration using Data Guard replication
MIGRATION_METHOD=ONLINE_PHYSICAL

# Transfer data via OCI Object Storage
DATA_TRANSFER_MEDIUM=OSS
HOST=https://objectstorage.us-ashburn-1.oraclecloud.com
OPC_CONTAINER=zdm-migration-bucket

# RMAN compression — reduces transfer time significantly for large DBs
RMAN_COMPRESSION_ALGORITHM=MEDIUM

# Run datapatch on target post-switchover (recommended: TRUE)
TGT_SKIP_DATAPATCH=FALSE

# Source DB unique name
SRC_DB_UNIQUE_NAME=PRODDB

# Keep source running after switchover until you confirm target is stable
SHUTDOWN_SOURCE=FALSE

# Archive log gap threshold — how many seconds of lag is acceptable at switchover
# Default 30 is fine for most workloads; lower for very busy systems
# MAX_APPLY_LAG=30
\`\`\`

### Key Parameters Explained

**MIGRATION_METHOD** — This is the fundamental choice. ONLINE_PHYSICAL gives you live Data Guard sync with a rapid switchover. OFFLINE_PHYSICAL is a backup/restore with no sync. ONLINE_LOGICAL requires GoldenGate.

**DATA_TRANSFER_MEDIUM** — OSS uses OCI Object Storage (fast, scalable, recommended for anything >100GB). DBLINK transfers directly over SQL*Net (simpler setup, but slower for large DBs). NFS works for collocated target.

**TGT_SKIP_DATAPATCH** — Only set TRUE if you're doing a test migration and want to save time. For production migrations, always FALSE. Skipping datapatch can leave objects in an invalid state.

## Running the Migration

\`\`\`bash
$ZDM_HOME/bin/zdmcli migrate database \\
  -sourcedb PRODDB \\
  -sourcenode sourcehost.example.com \\
  -srcauth zdmauth \\
  -srcarg1 user:oracle \\
  -srcarg2 identity_file:/home/zdmuser/.ssh/id_rsa \\
  -srcarg3 sudo_location:/usr/bin/sudo \\
  -targetnode targethost.oci.example.com \\
  -tgtauth zdmauth \\
  -tgtarg1 user:oracle \\
  -tgtarg2 identity_file:/home/zdmuser/.ssh/id_rsa \\
  -tgtarg3 sudo_location:/usr/bin/sudo \\
  -rsp /home/zdmuser/response/prod_to_oci.rsp \\
  -sourcesyswallet /home/zdmuser/wallets/src \\
  -targetsyswallet /home/zdmuser/wallets/tgt

# Returns immediately with a job ID
# Job ID: 1
\`\`\`

Important: ZDM submits the job and returns immediately. The migration runs asynchronously. Do not close your terminal session — use \`screen\` or \`tmux\` for long migrations.

## Monitoring with zdmcli query job

\`\`\`bash
# Poll current status
$ZDM_HOME/bin/zdmcli query job -jobid 1

# Sample output mid-migration:
# JOB ID       : 1
# OPERATION    : MIGRATE
# STATUS       : RUNNING
# CREATED      : 2025-05-20T09:00:00
# STARTED      : 2025-05-20T09:00:15
# SCHEDULED    : 2025-05-20T09:00:00
# PHASE_NAME         PHASE_STATUS    STARTED              DURATION
# SETUP              COMPLETED       09:00:15             00:02:14
# VALIDATESOURCE     COMPLETED       09:02:29             00:01:03
# VALIDATETARGET     COMPLETED       09:03:32             00:00:47
# INITIALTRANSFER    IN_PROGRESS     09:04:19             02:34:12

# Watch it live (runs every 60s)
watch -n 60 "$ZDM_HOME/bin/zdmcli query job -jobid 1"
\`\`\`

### Phase-by-Phase Breakdown

| Phase | Duration (typical) | What Happens |
|-------|-------------------|-------------|
| SETUP | 2–5 min | Creates working dirs, validates SSH, checks Oracle Net |
| VALIDATESOURCE | 1–2 min | Connects to source DB, checks version, mode, archive log |
| VALIDATETARGET | 1–2 min | Connects to target DB, checks provisioning |
| INITIALTRANSFER | Hours | RMAN backup from source → OCI Object Storage; restore to target |
| SYNCTARGET | Ongoing | Archive log apply loop — keeps target current |
| SWITCHOVER | 2–15 min | Role change: source → standby, target → primary |
| POSTSWITCHOVER | 30–60 min | TNS config update, datapatch if enabled, cleanup |

INITIALTRANSFER is where the bulk of time goes for large databases. For a 5TB database with MEDIUM compression, expect 4–8 hours depending on your network to OCI. SYNCTARGET then runs continuously until you trigger switchover.

## The Switchover Decision

ZDM pauses in SYNCTARGET and waits for you to initiate switchover. This is intentional — you control when the service interruption happens. Check the apply lag before proceeding:

\`\`\`sql
-- On target: check Data Guard apply lag
SELECT NAME, VALUE, UNIT FROM V$DATAGUARD_STATS WHERE NAME IN ('apply lag','transport lag');

-- Acceptable: apply lag < 30 seconds
-- If lag is high, wait for SYNCTARGET to catch up
\`\`\`

When you are ready:
\`\`\`bash
# Resume the job to trigger switchover
$ZDM_HOME/bin/zdmcli resume job -jobid 1
\`\`\`

From this point forward, ZDM executes the actual switchover. Application teams should monitor for connectivity restoration.

## Common Failures and Fixes

### SSH Authentication Failures
\`\`\`
Error: SSH connection to sourcehost failed — Permission denied (publickey)
\`\`\`
Fix: Verify the identity file path is correct and the public key is in the oracle user's authorized_keys on both source and target.

### Wallet Cannot Open
\`\`\`
ORA-28353: failed to open wallet
\`\`\`
Check that the wallet path in your sqlnet.ora on the ZDM host matches where you created the wallet, and that the wallet contains the correct credential. Use \`mkstore -wrl /path/to/wallet -listCredential\` to verify.

### Archive Log Destination Full
\`\`\`bash
-- On source during SYNCTARGET
SELECT DEST_ID, STATUS, ERROR FROM V$ARCHIVE_DEST WHERE STATUS != 'INACTIVE';
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE = 500G SCOPE=BOTH;
\`\`\`

### Object Storage Auth Errors
\`\`\`bash
# Test OCI OS connectivity from ZDM host
oci os bucket list --compartment-id <ocid> --namespace <namespace>
# If this fails, check your OCI config file and API key setup
\`\`\`

### Target DB Not Opening READ WRITE
After switchover, if the target database doesn't open normally:
\`\`\`sql
-- Check for ORA-16038 or similar Data Guard errors
SELECT ERROR_CODE, MESSAGE FROM V$DATAGUARD_STATUS ORDER BY TIMESTAMP DESC;
-- Common fix: enable standby log file archiving was skipped
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT;
\`\`\`

## Post-Migration Validation

Run these on the target immediately after POSTSWITCHOVER completes:

\`\`\`sql
-- 1. Confirm database role and mode
SELECT NAME, DB_UNIQUE_NAME, DATABASE_ROLE, OPEN_MODE FROM V$DATABASE;

-- 2. Check for invalid objects (especially in APPS schema for EBS)
SELECT OWNER, COUNT(*) CNT FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
GROUP BY OWNER ORDER BY 2 DESC;

-- 3. Verify key schemas accessible
SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS
WHERE ACCOUNT_STATUS = 'OPEN' ORDER BY USERNAME;

-- 4. Check for any pending Data Guard transport
SELECT DEST_ID, STATUS, ERROR FROM V$ARCHIVE_DEST
WHERE TARGET = 'STANDBY' AND STATUS != 'INACTIVE';

-- 5. Verify tablespace and datafile status
SELECT FILE#, STATUS, NAME FROM V$DATAFILE WHERE STATUS != 'ONLINE';
\`\`\`

For EBS databases specifically, also run autoconfig on both DB and apps tiers and verify the context file points to the new hostname/service.

## TuneVault and Post-Migration Health

The 48 hours after a ZDM migration are the highest-risk period. Your database is running on new infrastructure with potentially different I/O characteristics, different memory allocation, and slightly different parameter defaults. TuneVault's automated health checks surface the common post-migration issues — missing optimizer statistics, tablespace sizing differences, redo log configuration, and invalid objects — within minutes of pointing at the new instance. Run a health check immediately after validation, then again after 24 hours of production load.
`;

const PERF_CRISIS_CONTENT = `
## The Scenario

It's 09:47 on a Tuesday. Your monitoring fires. The EBS production server is at load average 120. There are 247 active Oracle sessions. Users are calling saying nothing works. Your manager is calling. Your manager's manager is about to call.

This is the moment where having a practiced triage methodology is the difference between a 45-minute incident and a 4-hour one.

I have been in this exact situation more than once. Here is the methodology I follow, in order, every time.

## First 60 Seconds: OS-Level Triage

Do not log into Oracle yet. Start at the OS.

\`\`\`bash
# Load average: how many processes are runnable or waiting for I/O?
uptime
# 09:47:13 up 312 days, load average: 121.34, 98.22, 75.61

# What is actually consuming CPU?
top -b -n 1 | head -30

# Is this CPU or I/O pressure? vmstat tells you
vmstat 2 5
# procs: r=runnable, b=blocked waiting for I/O
# us=userspace CPU, sy=kernel CPU, wa=I/O wait
# A high 'wa' means I/O pressure. High 'us' means CPU contention.

# If wa is high, identify the I/O pattern
iostat -x 2 5
# util% near 100% on a device = that device is the bottleneck

# Memory: are we swapping?
free -h
cat /proc/meminfo | grep -E "MemAvailable|SwapFree|Cached"
\`\`\`

From these five commands you will know within 60 seconds whether you are looking at a CPU issue, I/O issue, or memory pressure. This determines your next move.

**High CPU, low I/O wait**: Bad SQL plans, parsing storm, latch contention, or a runaway background job.

**High I/O wait**: Full table scan on large table, UNDO or TEMP I/O, or insufficient I/O bandwidth.

**Swapping**: Oracle SGA/PGA sized too large for available RAM, or a memory leak in a non-Oracle process.

## Oracle Session Analysis

With the OS picture clear, connect to Oracle immediately:

\`\`\`sql
-- How many sessions? What state are they in?
SELECT STATUS, COUNT(*) FROM V$SESSION GROUP BY STATUS;

-- Top 25 active sessions — most waited first
SELECT s.sid, s.serial#, s.username, s.status,
       s.event, s.wait_class,
       s.seconds_in_wait,
       s.sql_id,
       s.blocking_session,
       s.module,
       s.action
FROM   V$SESSION s
WHERE  s.status = 'ACTIVE'
  AND  s.username IS NOT NULL
ORDER BY s.seconds_in_wait DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

The \`wait_class\` column is your first filter:

- **Concurrency** — latch or library cache contention (parsing storm, hot block)
- **User I/O** — SQL causing heavy reads
- **Application** — lock waits (someone has a row-level or table-level lock)
- **System I/O** — control file or redo log I/O
- **CPU** — actually on CPU, not waiting (this looks odd but happens when CPU queue is full)

If you see 200 sessions all waiting on the same event — say, \`enq: TX - row lock contention\` — you have a blocking chain. If they're all on different events you have a broader load problem.

## Finding the Blocking Chain

Row-level locking during a crisis is the most common cause of cascading waits:

\`\`\`sql
-- Find blocker and all blocked sessions
SELECT
    l1.sid AS blocker_sid,
    l1.serial# AS blocker_serial,
    s1.username AS blocker_user,
    s1.sql_id AS blocker_sql,
    s1.event AS blocker_wait,
    s1.seconds_in_wait AS blocker_secs,
    l2.sid AS blocked_sid,
    s2.username AS blocked_user
FROM
    V$LOCK l1
    JOIN V$LOCK l2 ON l1.id1 = l2.id1 AND l1.id2 = l2.id2
    JOIN V$SESSION s1 ON l1.sid = s1.sid
    JOIN V$SESSION s2 ON l2.sid = s2.sid
WHERE l1.block = 1
  AND l2.request > 0
ORDER BY blocker_secs DESC;

-- How many sessions are blocked by a single session?
SELECT blocking_session, COUNT(*) blockers
FROM V$SESSION
WHERE blocking_session IS NOT NULL
GROUP BY blocking_session
ORDER BY 2 DESC;
\`\`\`

If one session is blocking 180 others, that session is your root cause. Get its SQL and decide: is it a legitimate long-running transaction, or is it a stuck/hung process?

\`\`\`sql
-- Get the actual SQL being executed by the blocker
SELECT sq.sql_text, sq.executions, sq.cpu_time/1000000 cpu_s,
       sq.elapsed_time/1000000 ela_s, sq.buffer_gets, sq.disk_reads
FROM V$SQL sq
WHERE sq.sql_id = '&blocker_sql_id';
\`\`\`

## Finding Top CPU Consumers

If it is not a blocking chain but overall CPU pressure:

\`\`\`sql
-- Top 15 SQL statements by CPU in the shared pool right now
SELECT sql_id,
       ROUND(cpu_time/1000000, 1) cpu_secs,
       ROUND(elapsed_time/1000000, 1) ela_secs,
       executions,
       ROUND(cpu_time/NULLIF(executions,0)/1000000, 3) avg_cpu_per_exec,
       buffer_gets,
       disk_reads,
       SUBSTR(sql_text, 1, 80) sql_preview
FROM V$SQL
WHERE executions > 0
ORDER BY cpu_time DESC
FETCH FIRST 15 ROWS ONLY;

-- Also check for high-parse statements (soft or hard parse storms)
SELECT sql_id, parse_calls, executions,
       ROUND(parse_calls/NULLIF(executions,0)*100,1) parse_ratio_pct,
       SUBSTR(sql_text, 1, 80) sql_preview
FROM V$SQL
WHERE parse_calls > 100
ORDER BY parse_calls DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

A high parse_ratio_pct (close to 100%) on frequently executed SQL suggests the application is not using bind variables or the cursor is being aged out of the shared pool and re-parsed constantly.

## ASH: The Crisis Investigator

Active Session History (ASH) is invaluable during a performance crisis because it records the last N seconds of session activity without the overhead of AWR snapshot collection:

\`\`\`sql
-- What have sessions been waiting on in the last 10 minutes?
SELECT event, wait_class, COUNT(*) samples,
       ROUND(COUNT(*) * 10 / 600, 1) avg_active_sessions,
       ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1) pct
FROM V$ACTIVE_SESSION_HISTORY
WHERE sample_time > SYSDATE - 10/1440
  AND session_type = 'FOREGROUND'
GROUP BY event, wait_class
ORDER BY samples DESC
FETCH FIRST 15 ROWS ONLY;

-- Top SQL in ASH for the last 10 minutes
SELECT sql_id, COUNT(*) ash_samples,
       ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1) pct_activity,
       MIN(TO_CHAR(sample_time, 'HH24:MI:SS')) first_seen,
       MAX(TO_CHAR(sample_time, 'HH24:MI:SS')) last_seen
FROM V$ACTIVE_SESSION_HISTORY
WHERE sample_time > SYSDATE - 10/1440
  AND sql_id IS NOT NULL
  AND session_type = 'FOREGROUND'
GROUP BY sql_id
ORDER BY ash_samples DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

ASH does not require Diagnostics Pack licensing for V$ACTIVE_SESSION_HISTORY (in-memory portion). DBA_HIST_ACTIVE_SESS_HISTORY requires the license.

## Latch Contention

Latch contention shows up as "latch: ..." wait events and usually indicates either a very hot block (segment header or common index block getting massive concurrent access) or library cache latch contention from a parsing storm.

\`\`\`sql
-- Check latch hit ratios
SELECT name, sleeps, ROUND((1 - (sleeps/NULLIF(gets,0)))*100, 2) hit_ratio_pct
FROM V$LATCH
WHERE gets > 0
  AND sleeps > 1000
ORDER BY sleeps DESC
FETCH FIRST 10 ROWS ONLY;

-- Find hot blocks (high buffer busy waits)
SELECT obj#, current_obj#, current_file#, current_block#,
       COUNT(*) waits
FROM V$ACTIVE_SESSION_HISTORY
WHERE event = 'buffer busy waits'
  AND sample_time > SYSDATE - 5/1440
GROUP BY obj#, current_obj#, current_file#, current_block#
ORDER BY waits DESC;
\`\`\`

## Redo Log Issues

Excessive log switch frequency causes "log file switch" waits and can spike CPU as the LGWR process flushes more frequently:

\`\`\`sql
-- Log switch frequency
SELECT TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24') hour_bucket,
       COUNT(*) switches
FROM V$LOG_HISTORY
WHERE FIRST_TIME > SYSDATE - 1/24
GROUP BY TO_CHAR(FIRST_TIME,'YYYY-MM-DD HH24')
ORDER BY 1;

-- Current redo log sizing
SELECT l.group#, l.members, l.status, lf.member filename,
       ROUND(l.bytes/1024/1024) size_mb
FROM V$LOG l JOIN V$LOGFILE lf ON l.group# = lf.group#
ORDER BY l.group#;
\`\`\`

If you're seeing 100+ log switches per hour, your redo logs are too small. The immediate fix: increase redo log size. The emergency fix during crisis: force a checkpoint to reduce pending writes.

\`\`\`sql
-- Do not do this lightly in production — it causes a brief I/O spike
ALTER SYSTEM CHECKPOINT;
\`\`\`

## Emergency Interventions

In a production crisis, you may need to take action while still investigating:

### Kill a Blocking Session
\`\`\`sql
-- Kill the top blocker (get SID and SERIAL# from the blocking query above)
ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE;

-- If that doesn't work immediately (session holds resources)
-- Find the OS process ID
SELECT p.spid OS_PID FROM V$SESSION s JOIN V$PROCESS p ON s.paddr = p.addr
WHERE s.sid = 123;

-- Kill at OS level
kill -9 <spid>
\`\`\`

### Terminate a Runaway SQL
\`\`\`sql
-- Cancel a specific SQL without killing the session
ALTER SYSTEM CANCEL SQL 'SID=123, SERIAL=4567, SQL_ID=abc123def';
\`\`\`

### Resource Manager Throttle
If you need to limit a runaway user or module without killing sessions:
\`\`\`sql
-- Temporarily cap CPU for a specific consumer group
DBMS_RESOURCE_MANAGER.UPDATE_PLAN_DIRECTIVE(
  plan => 'DEFAULT_PLAN',
  group_or_subplan => 'LOW_GROUP',
  new_cpu_p1 => 5
);
\`\`\`

### As a Last Resort: Flush Shared Pool
Flushing the shared pool forces re-parsing of all SQL, which can clear a bad plan but will spike CPU briefly as everything re-parses. Use only if you have confirmed library cache corruption or an unfixable bad plan:

\`\`\`sql
-- Do NOT do this without understanding the impact
-- It will cause a brief but significant CPU spike as all SQL re-parses
ALTER SYSTEM FLUSH SHARED_POOL;
\`\`\`

## Root Cause Analysis After the Crisis

Once load returns to normal, investigate systematically:

### Review AWR for the Crisis Window
\`\`\`sql
-- Find AWR snapshot IDs covering the incident
SELECT snap_id, TO_CHAR(begin_interval_time,'YYYY-MM-DD HH24:MI') snap_time
FROM DBA_HIST_SNAPSHOT
WHERE begin_interval_time > SYSDATE - 4/24
ORDER BY snap_id;

-- Generate AWR report covering the incident window
-- From SQL*Plus:
-- @?/rdbms/admin/awrrpt.sql
-- Or use OEM/Grid Control
\`\`\`

### Check for Bad Plan Capture
\`\`\`sql
-- Were any plans changed in the last 24 hours?
SELECT sql_id, plan_hash_value, timestamp, operation, options
FROM DBA_HIST_SQL_PLAN
WHERE timestamp > SYSDATE - 1
  AND id = 0  -- root node of the plan
ORDER BY timestamp DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Check Optimizer Statistics Freshness
Stale statistics are the most common cause of a sudden bad plan:
\`\`\`sql
SELECT owner, table_name, last_analyzed,
       ROUND((SYSDATE - last_analyzed)*24,1) hours_since_analyze,
       num_rows
FROM DBA_TABLES
WHERE owner IN ('APPS','APPLSYS')
  AND last_analyzed < SYSDATE - 7
  AND num_rows > 100000
ORDER BY hours_since_analyze DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

## Prevention: What to Put in Place

After an incident like this, the work is building systems that either prevent recurrence or reduce detection time:

1. **Automated statistics jobs** — EBS ships with FND_STATS, but many sites disable or misconfigure it. Run FND_STATS.GATHER_ALL_COLUMN_STATS on a schedule.

2. **SQL Plan Baselines** — After identifying the correct plans for your critical SQL, pin them: \`DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE\`.

3. **Resource Manager** — Configure consumer groups to cap runaway queries before they saturate the box.

4. **Redo log sizing** — Size logs for less than one switch every 15–20 minutes under normal load.

5. **Monitoring thresholds** — Set alerts for active session count, CPU%, and log switch frequency, not just disk space.

## TuneVault and Performance Visibility

TuneVault's performance checks surface the conditions that lead to this kind of crisis before it happens: stale optimizer statistics, top-CPU SQL, blocking session history, redo log sizing, and wait event trends. After an incident, running a health check gives you a structured view of what was already degraded heading into the crisis. The goal is never to debug live — it is to know which levers need pulling before load spikes.
`;

const EBS_CLONE_CONTENT = `
## Why EBS Cloning Is Not Like Standard Oracle Cloning

Cloning an Oracle E-Business Suite 12.2 instance is significantly more involved than cloning a regular Oracle database. EBS has two distinct tiers — the database tier and the applications tier — and each has its own clone procedure. The two tiers must be cloned in coordination, and the post-clone configuration steps are mandatory and non-trivial.

The procedure documented here is based on EBS 12.2.x using the standard rapidclone/adcfgclone approach. This is the Oracle-supported method and the one you should use for any production clone.

## Pre-Clone Checklist

Before you run any preclone scripts, verify:

**Source Environment**
- EBS is at a clean state — no active ADOP patch cycles, no pending concurrent requests that must complete
- Both DB and apps services are running normally
- Autoconfig ran successfully in the last 24 hours (check $APPL_TOP/admin/logs)
- No FS corruption issues on either tier

**Target Environment**
- Target OS is the same version as source (same Linux release, same kernel family)
- Oracle DB software installed to same ORACLE_HOME path as source (for rapidclone to work cleanly)
- EBS software will be cloned — do not pre-install EBS on target
- Sufficient disk space: DB tier needs space for all datafiles + archive logs; apps tier needs space for all EBS application files (typically 100–300GB)
- Target hostnames have forward and reverse DNS resolution

**Network**
- Source and target can communicate on Oracle listener port (1521 or your custom port)
- Target apps host can reach target DB host on 1521
- Both hosts have internet or proxy access for any post-clone patches (if needed)

## Step 1: Run adpreclone on Source DB Tier

Log in to the source database server as the oracle OS user (not as applmgr):

\`\`\`bash
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export ORACLE_SID=EBSDEV

# The preclone script is generated by autoconfig and lives in appsutil
# Find your context name first
ls $ORACLE_HOME/appsutil/scripts/

# Run preclone — this creates the RDBMS clone template
perl $ORACLE_HOME/appsutil/scripts/EBSDEV_sourcehost/adpreclone.pl dbTier

# Expected output ends with:
# Completed adpreclone.pl for dbTier
\`\`\`

This script does several things:
- Creates a clone template directory under \`$ORACLE_HOME/appsutil/clone/\`
- Captures the current Oracle home configuration
- Does NOT stop the database — source stays live

Check the log for errors:
\`\`\`bash
ls -lrt $ORACLE_HOME/appsutil/log/EBSDEV_sourcehost/
# Review the most recent adpreclone log
\`\`\`

## Step 2: Run adpreclone on Source Apps Tier

Log in to the source applications server as the applmgr OS user:

\`\`\`bash
# Source the EBS environment
source /u01/install/APPS/EBSapps.env run

# Run preclone on the apps tier
perl $AD_TOP/bin/adpreclone.pl appsTier

# You will be prompted for the APPS password
# Enter it and wait — this takes 10–20 minutes

# Expected output:
# adpreclone.pl: Completed preclone for appsTier.
\`\`\`

The apps tier preclone:
- Removes environment-specific configuration from the scripts (replaces paths with tokens)
- Creates the clone template in \`$INST_TOP/admin/scripts/\`
- Compresses the JAVA_TOP and other large directories for transfer

## Step 3: Shut Down Source (for Clean Clone) or Use Hot Backup

For a development clone where a brief outage is acceptable:

\`\`\`bash
# Stop apps services
$ADMIN_SCRIPTS_HOME/adstopall.sh

# Take an RMAN backup of the DB
rman target /
RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG;
RMAN> EXIT;

# Or if you want an offline consistent backup
RMAN> SHUTDOWN IMMEDIATE;
RMAN> STARTUP MOUNT;
RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE;
RMAN> ALTER DATABASE OPEN;
RMAN> EXIT;
\`\`\`

For a production-equivalent clone that cannot afford downtime, use an RMAN online backup while the apps preclone scripts handle the apps tier files.

## Step 4: Transfer Files to Target

\`\`\`bash
# Transfer DB files via tar + rsync — faster than cp for many small files
# On source DB tier:
cd $ORACLE_HOME/appsutil
tar czf /backup/staging/appsutil_clone.tar.gz clone/

# Transfer to target DB host
rsync -avz --progress /backup/staging/ oracle@targetdbhost:/backup/staging/

# Transfer RMAN backup files
rsync -avz --progress /backup/rman/ oracle@targetdbhost:/backup/rman/

# On source apps tier — the apps files are large; use rsync with compression
# This is the bulk of the transfer time (100–300GB typical)
rsync -avz --progress --exclude='*.log' \\
  /u01/install/APPS/ applmgr@targetappshost:/u01/install/APPS/
\`\`\`

If source and target are on the same SAN or NFS, you can use consistent snapshots instead of file transfer — significantly faster for large environments.

## Step 5: Restore and Configure Target DB Tier

On the target database server, as the oracle OS user:

\`\`\`bash
# Extract the appsutil clone template
cd $ORACLE_HOME
tar xzf /backup/staging/appsutil_clone.tar.gz

# Restore RMAN backup
rman target /
RMAN> RESTORE DATABASE FROM '/backup/rman/';
RMAN> RECOVER DATABASE;
RMAN> ALTER DATABASE OPEN RESETLOGS;
RMAN> EXIT;

# Change the DB name (if cloning to a different SID)
# Use nid for DBID change if needed
nid target=/ dbname=EBSCLONE

# Export ORACLE_SID pointing to new SID
export ORACLE_SID=EBSCLONE

# Run adcfgclone for the DB tier
# This updates all the configuration to the new hostname, SID, and paths
perl $ORACLE_HOME/appsutil/clone/bin/adcfgclone.pl dbTier

# You will be prompted for:
# - New DB SID
# - New target hostname (short hostname, not FQDN)
# - New ORACLE_HOME path (press Enter to keep same)
# - New domain name
# - APPS password
\`\`\`

The \`adcfgclone.pl dbTier\` script:
- Updates the DB context file with new hostnames and parameters
- Relinks Oracle binaries for the new environment
- Runs autoconfig on the DB tier
- Creates new listener and tnsnames configuration

Check the log carefully:
\`\`\`bash
ls -lrt $ORACLE_HOME/appsutil/log/
# Any errors in adcfgclone.txt need to be resolved before proceeding
\`\`\`

## Step 6: Configure Target Apps Tier

On the target applications server, as the applmgr OS user:

\`\`\`bash
# The apps files were already rsync'd to the target
# Run adcfgclone for the apps tier
cd $COMMON_TOP/clone/bin  # or wherever adcfgclone.pl was transferred

perl adcfgclone.pl appsTier

# You will be prompted for all the configuration:
# - Target apps server hostname
# - Target DB hostname
# - Target DB SID
# - Target DB port (typically 1521)
# - APPS password
# - Weblogic admin password
# - JDK home path
# - etc.
\`\`\`

This script runs for 30–60 minutes. It:
- Updates all context file variables with new hostnames and paths
- Runs autoconfig on the applications tier
- Regenerates all startup/shutdown scripts
- Reconfigures the WebLogic domain
- Updates tnsnames.ora and listener.ora

## Step 7: Post-Clone Configuration

After adcfgclone completes successfully on both tiers:

### Unlock APPS and APPLSYS Accounts
\`\`\`sql
-- On target DB, as SYSDBA
ALTER USER APPS IDENTIFIED BY <newpassword> ACCOUNT UNLOCK;
ALTER USER APPLSYS IDENTIFIED BY <newpassword> ACCOUNT UNLOCK;

-- If the password was changed, update context file and run autoconfig again
-- OR update the .env files manually
\`\`\`

### Reset Application-Level Passwords
\`\`\`sql
-- Oracle EBS sysadmin password reset
BEGIN
    FND_USER_PKG.UpdateUser(
        x_user_name     => 'SYSADMIN',
        x_owner         => 'CUST',
        x_unencrypted_password => '<newpassword>',
        x_password_date => SYSDATE
    );
    COMMIT;
END;
/
\`\`\`

### Verify Autoconfig Ran Clean
\`\`\`bash
# Check latest autoconfig log on both tiers
# DB tier
ls -lrt $ORACLE_HOME/appsutil/log/*/autoconfig.txt

# Apps tier
ls -lrt $APPL_TOP/admin/EBSCLONE_targetappshost/log/
# Last file should be adconfig.txt with no errors
\`\`\`

### Update Context File if Needed

If any parameters were entered incorrectly during adcfgclone, edit the context file and re-run autoconfig:

\`\`\`bash
# DB context file location
vi $ORACLE_HOME/appsutil/EBSCLONE_targetdbhost.xml

# Apps context file
vi $APPL_TOP/admin/EBSCLONE_targetappshost.xml

# Re-run autoconfig after any context file change
$ADMIN_SCRIPTS_HOME/adautocfg.sh
\`\`\`

## Step 8: Services Validation

\`\`\`bash
# Start database
$ORACLE_HOME/bin/dbstart $ORACLE_HOME

# Start listener
lsnrctl start

# Verify tnsping works from apps tier to DB tier
tnsping EBSCLONE

# Start apps services
$ADMIN_SCRIPTS_HOME/adstartall.sh

# Check all services came up
$ADMIN_SCRIPTS_HOME/adstrtal.sh

# Verify WebLogic Admin Server
$FMW_HOME/user_projects/domains/EBS_domain/bin/startWebLogic.sh &
\`\`\`

## Post-Clone Validation Checklist

Run these SQL checks before declaring the clone usable:

\`\`\`sql
-- 1. Verify DB is open and APPS schema is accessible
SELECT GLOBAL_NAME FROM GLOBAL_NAME;
SELECT COUNT(*) FROM APPS.FND_USER;

-- 2. Check for invalid objects
SELECT OWNER, COUNT(*) CNT FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
GROUP BY OWNER ORDER BY 2 DESC;
-- If APPS or APPLSYS have invalids, run utlrp.sql
-- @?/rdbms/admin/utlrp.sql

-- 3. Check profile options for new hostname
SELECT PROFILE_OPTION_NAME, PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES v, FND_PROFILE_OPTIONS o
WHERE o.PROFILE_OPTION_ID = v.PROFILE_OPTION_ID
  AND PROFILE_OPTION_NAME LIKE '%HOST%'
  AND LEVEL_ID = 10001;

-- 4. Verify Concurrent Manager can connect
-- Try starting ICM and checking FND_CONCURRENT_PROCESSES
SELECT INSTANCE_NUMBER, STATUS_CODE, RUNNING_PROCESSES
FROM FND_CONCURRENT_QUEUES
WHERE CONCURRENT_QUEUE_NAME = 'STANDARD';
\`\`\`

## Common Clone Failures

### adcfgclone Fails at Relink
Usually a missing library or wrong ORACLE_HOME path. Check:
\`\`\`bash
ls $ORACLE_HOME/lib/libclntsh.so.*
# If missing, the Oracle home was not transferred correctly
\`\`\`

### tnsping Works but Apps Cannot Connect to DB
Check that the DB listener is using the correct protocol address and that the apps tier tnsnames.ora has the correct entry. Also verify the connection test from the apps tier OS user:
\`\`\`bash
sqlplus apps/<pwd>@EBSCLONE
\`\`\`

### WebLogic Admin Server Not Starting
Usually due to a hostname mismatch in the WebLogic domain configuration. Check:
\`\`\`bash
grep -r "listen-address" $FMW_HOME/user_projects/domains/EBS_domain/config/config.xml
# Ensure all addresses match the new target hostname
\`\`\`

### Context File Variables Not Updated Correctly
If autoconfig ran but some files still have old hostnames:
\`\`\`bash
grep -r "oldhost" $APPL_TOP/admin/ | grep -v ".log" | head -20
# Edit context file and re-run adautocfg.sh
\`\`\`

## TuneVault and Cloned Environments

After an EBS clone, the target environment inherits whatever health issues the source had — plus potentially new ones introduced during the clone. TuneVault's post-clone health check verifies invalid objects, listener configuration, tablespace status, Concurrent Manager accessibility, and EBS-specific configuration checks that confirm the clone is fully functional before developers or QA teams start using it.
`;

// ── Stub content template ─────────────────────────────────────────────────
function stubContent(title, topics) {
  return `## Coming Soon

This article is in progress. It will cover: ${topics.join(', ')}.

Check back soon, or [see our other articles](/blog) for Oracle DBA field notes you can use today.`;
}

// ── Article definitions ───────────────────────────────────────────────────
const ARTICLES = [
  {
    title: 'Oracle ZDM — Zero Downtime Migration: Architecture, Setup, and Execution',
    slug: 'oracle-zdm-zero-downtime-migration',
    excerpt: 'A production-tested guide to Oracle ZDM: architecture overview, prerequisites, response file parameters, migration phases, monitoring with zdmcli, and the fixes for the failures you will actually encounter.',
    content: ZDM_CONTENT.trim(),
    published_at: '2025-05-10',
    read_time_minutes: 18,
    coming_soon: false,
  },
  {
    title: 'Oracle Database Performance Crisis: Triage, Analysis, and Resolution',
    slug: 'oracle-database-performance-crisis',
    excerpt: 'Load average 120, 247 active sessions, users calling. A step-by-step methodology for diagnosing and resolving an Oracle performance crisis — from first OS command to root cause analysis.',
    content: PERF_CRISIS_CONTENT.trim(),
    published_at: '2024-04-22',
    read_time_minutes: 16,
    coming_soon: false,
  },
  {
    title: 'EBS 12.2 Cloning Procedure — Complete Steps with Commands',
    slug: 'ebs-122-cloning-procedure',
    excerpt: 'The complete EBS 12.2 cloning procedure: pre-clone on both tiers, adcfgclone configuration, post-clone validation, and fixes for the failures that actually happen in practice.',
    content: EBS_CLONE_CONTENT.trim(),
    published_at: '2017-08-15',
    read_time_minutes: 14,
    coming_soon: false,
  },
  // ── Coming Soon stubs ───────────────────────────────────────────────────
  {
    title: 'EBS 12.2 ADOP Patching — Common Failures and How to Fix Them',
    slug: 'ebs-12-2-adop-patching-failures',
    excerpt: 'The ADOP patch cycle failures you will hit in EBS 12.2: cutover timeouts, prepare phase hangs, session cleanup errors, and how to recover from each without starting over.',
    content: stubContent('EBS 12.2 ADOP Patching', ['adop phase=prepare', 'cutover timeouts', 'session cleanup', 'fs_clone', 'adop phase=abort', 'common ORA errors during patching', 'recovery procedures']),
    published_at: '2026-01-15',
    read_time_minutes: 14,
    coming_soon: true,
  },
  {
    title: 'Oracle RAC Troubleshooting — Interconnect, Voting Disk, and CRS',
    slug: 'oracle-rac-troubleshooting',
    excerpt: 'Diagnosing Oracle RAC issues: interconnect performance problems, voting disk failures, CRS evictions, and the OS-level tools that actually tell you what is happening.',
    content: stubContent('Oracle RAC Troubleshooting', ['cluster interconnect diagnosis', 'ocrcheck', 'crsctl commands', 'voting disk recovery', 'node eviction analysis', 'css reconfig events']),
    published_at: '2026-02-01',
    read_time_minutes: 15,
    coming_soon: true,
  },
  {
    title: 'Oracle Data Guard — Switchover and Failover Procedures',
    slug: 'oracle-data-guard-switchover-failover',
    excerpt: 'Step-by-step Data Guard switchover and failover procedures with the DGMGRL commands and SQL, verification steps, and how to recover when the switchover does not complete cleanly.',
    content: stubContent('Oracle Data Guard', ['dgmgrl commands', 'switchover procedure', 'failover procedure', 'verify after switchover', 'flashback database recovery', 'log transport troubleshooting']),
    published_at: '2026-02-15',
    read_time_minutes: 13,
    coming_soon: true,
  },
  {
    title: 'EBS Performance Tuning — CM Queue Management, OPP, and WF Mailer',
    slug: 'ebs-performance-tuning-cm-opp-wf',
    excerpt: 'The practical EBS performance levers that actually matter: sizing Concurrent Manager queues, diagnosing OPP bottlenecks, fixing stuck WF Mailer, and SQL tuning for FND tables.',
    content: stubContent('EBS Performance Tuning', ['FND_CONCURRENT_QUEUES tuning', 'OPP configuration', 'WF_MAILER diagnosis', 'FND_STATS gather', 'profile options for performance', 'session management']),
    published_at: '2026-03-01',
    read_time_minutes: 12,
    coming_soon: true,
  },
  {
    title: 'Oracle Tablespace Management — Autoextend, Monitoring, and Alerts',
    slug: 'oracle-tablespace-management',
    excerpt: 'When to use autoextend vs fixed-size datafiles, how to monitor tablespace growth trends, and the SQL scripts to alert before you hit a full tablespace in production.',
    content: stubContent('Oracle Tablespace Management', ['autoextend vs fixed sizing', 'growth rate projection SQL', 'bigfile tablespaces', 'UNDO and TEMP sizing', 'alert thresholds', 'proactive monitoring']),
    published_at: '2026-03-15',
    read_time_minutes: 10,
    coming_soon: true,
  },
  {
    title: 'Oracle AWR and ASH — Reading Reports Like a Senior DBA',
    slug: 'oracle-awr-ash-analysis',
    excerpt: 'How to read an AWR report without getting lost in the noise: the six sections that matter, what DB Time tells you, how to interpret top wait events, and using ASH to drill into a specific window.',
    content: stubContent('Oracle AWR/ASH Analysis', ['AWR report structure', 'DB Time interpretation', 'Top 5 Timed Events', 'SQL ordered by CPU', 'ASH drill-down', 'comparing baseline to snapshot']),
    published_at: '2026-04-01',
    read_time_minutes: 14,
    coming_soon: true,
  },
  {
    title: 'EBS Cloning to OCI — Lift and Shift with ZDM and Rapid Clone',
    slug: 'ebs-cloning-to-oci',
    excerpt: 'Moving EBS 12.2 to Oracle Cloud Infrastructure: choosing between ZDM physical migration and traditional clone, the networking prerequisites, and the EBS-specific post-migration steps.',
    content: stubContent('EBS Cloning to OCI', ['ZDM vs manual clone', 'OCI DB provisioning', 'BYOL vs included license', 'VCN and subnet setup', 'EBS autoconfig for cloud hostnames', 'post-migration validation']),
    published_at: '2026-04-15',
    read_time_minutes: 16,
    coming_soon: true,
  },
  {
    title: 'Oracle 19c Upgrade from 12c — Step by Step',
    slug: 'oracle-19c-upgrade-from-12c',
    excerpt: 'The complete Oracle 12.1/12.2 to 19c upgrade path: pre-upgrade checks, AutoUpgrade tool, post-upgrade tasks, and the compatibility issues to anticipate before you start.',
    content: stubContent('Oracle 19c Upgrade', ['AutoUpgrade tool', 'preupgrade.jar checks', 'invalid object pre-fix', 'timezone update', 'post-upgrade recompile', 'optimizer changes', 'EBS compatibility']),
    published_at: '2026-05-01',
    read_time_minutes: 15,
    coming_soon: true,
  },
  {
    title: 'Oracle Security Hardening — Profiles, Auditing, and Privilege Reviews',
    slug: 'oracle-security-hardening',
    excerpt: 'Production Oracle security hardening: configuring the DEFAULT profile, implementing unified auditing, reviewing excessive privileges with DBA_SYS_PRIVS, and the checks auditors always ask for.',
    content: stubContent('Oracle Security Hardening', ['DEFAULT profile settings', 'unified auditing', 'DBA_SYS_PRIVS review', 'PUBLIC privilege cleanup', 'password policies', 'OLS and VPD overview']),
    published_at: '2026-05-15',
    read_time_minutes: 12,
    coming_soon: true,
  },
];

module.exports = {
  name: 'blog_seed_articles',
  up: async (client) => {
    // Add coming_soon column if not present
    await client.query(`
      ALTER TABLE blog_posts
        ADD COLUMN IF NOT EXISTS coming_soon BOOLEAN NOT NULL DEFAULT FALSE
    `);

    for (const a of ARTICLES) {
      await client.query(
        `INSERT INTO blog_posts
           (title, slug, excerpt, content, author, published_at, read_time_minutes, coming_soon)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
         ON CONFLICT (slug) DO UPDATE SET
           title            = EXCLUDED.title,
           excerpt          = EXCLUDED.excerpt,
           content          = EXCLUDED.content,
           author           = EXCLUDED.author,
           published_at     = EXCLUDED.published_at,
           read_time_minutes= EXCLUDED.read_time_minutes,
           coming_soon      = EXCLUDED.coming_soon,
           updated_at       = NOW()`,
        [a.title, a.slug, a.excerpt, a.content, AUTHOR,
         a.published_at, a.read_time_minutes, a.coming_soon]
      );
    }
  },
};
