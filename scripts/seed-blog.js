'use strict';

/**
 * Standalone blog article seeder.
 * Run in Render shell: node scripts/seed-blog.js
 * Run locally:        DATABASE_URL=postgres://... node scripts/seed-blog.js
 *
 * Idempotent — safe to run multiple times. Does not touch _migrations.
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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

## The Switchover Decision

ZDM pauses in SYNCTARGET and waits for you to initiate switchover. Check the apply lag before proceeding:

\`\`\`sql
-- On target: check Data Guard apply lag
SELECT NAME, VALUE, UNIT FROM V$DATAGUARD_STATS WHERE NAME IN ('apply lag','transport lag');
-- Acceptable: apply lag < 30 seconds
\`\`\`

When you are ready:
\`\`\`bash
$ZDM_HOME/bin/zdmcli resume job -jobid 1
\`\`\`

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
\`\`\`

## Post-Migration Validation

\`\`\`sql
-- 1. Confirm database role and mode
SELECT NAME, DB_UNIQUE_NAME, DATABASE_ROLE, OPEN_MODE FROM V$DATABASE;

-- 2. Check for invalid objects
SELECT OWNER, COUNT(*) CNT FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
GROUP BY OWNER ORDER BY 2 DESC;

-- 3. Verify key schemas accessible
SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS
WHERE ACCOUNT_STATUS = 'OPEN' ORDER BY USERNAME;
\`\`\`

## TuneVault and Post-Migration Health

The 48 hours after a ZDM migration are the highest-risk period. TuneVault's automated health checks surface the common post-migration issues — missing optimizer statistics, tablespace sizing differences, redo log configuration, and invalid objects — within minutes of pointing at the new instance.
`;

const PERF_CRISIS_CONTENT = `
## The Scenario

It's 09:47 on a Tuesday. Your monitoring fires. The EBS production server is at load average 120. There are 247 active Oracle sessions. Users are calling saying nothing works. Your manager is calling. Your manager's manager is about to call.

This is the moment where having a practiced triage methodology is the difference between a 45-minute incident and a 4-hour one.

## First 60 Seconds: OS-Level Triage

Do not log into Oracle yet. Start at the OS.

\`\`\`bash
# Load average: how many processes are runnable or waiting for I/O?
uptime
# What is actually consuming CPU?
top -b -n 1 | head -30
# Is this CPU or I/O pressure?
vmstat 2 5
# If wa is high, identify the I/O pattern
iostat -x 2 5
# Memory: are we swapping?
free -h
\`\`\`

**High CPU, low I/O wait**: Bad SQL plans, parsing storm, latch contention.
**High I/O wait**: Full table scan on large table, UNDO or TEMP I/O.
**Swapping**: Oracle SGA/PGA sized too large for available RAM.

## Oracle Session Analysis

\`\`\`sql
-- How many sessions? What state are they in?
SELECT STATUS, COUNT(*) FROM V$SESSION GROUP BY STATUS;

-- Top 25 active sessions — most waited first
SELECT s.sid, s.serial#, s.username, s.status,
       s.event, s.wait_class, s.seconds_in_wait, s.sql_id, s.blocking_session
FROM   V$SESSION s
WHERE  s.status = 'ACTIVE' AND s.username IS NOT NULL
ORDER BY s.seconds_in_wait DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

The \`wait_class\` column is your first filter:
- **Concurrency** — latch or library cache contention
- **User I/O** — SQL causing heavy reads
- **Application** — lock waits
- **CPU** — actually on CPU

## Finding the Blocking Chain

\`\`\`sql
-- Find blocker and all blocked sessions
SELECT
    l1.sid AS blocker_sid, s1.username AS blocker_user,
    s1.sql_id AS blocker_sql, s1.seconds_in_wait AS blocker_secs,
    l2.sid AS blocked_sid, s2.username AS blocked_user
FROM V$LOCK l1
    JOIN V$LOCK l2 ON l1.id1 = l2.id1 AND l1.id2 = l2.id2
    JOIN V$SESSION s1 ON l1.sid = s1.sid
    JOIN V$SESSION s2 ON l2.sid = s2.sid
WHERE l1.block = 1 AND l2.request > 0
ORDER BY blocker_secs DESC;
\`\`\`

## Finding Top CPU Consumers

\`\`\`sql
-- Top 15 SQL statements by CPU in the shared pool
SELECT sql_id,
       ROUND(cpu_time/1000000, 1) cpu_secs,
       ROUND(elapsed_time/1000000, 1) ela_secs,
       executions,
       SUBSTR(sql_text, 1, 80) sql_preview
FROM V$SQL
WHERE executions > 0
ORDER BY cpu_time DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

## ASH: The Crisis Investigator

\`\`\`sql
-- What have sessions been waiting on in the last 10 minutes?
SELECT event, wait_class, COUNT(*) samples,
       ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1) pct
FROM V$ACTIVE_SESSION_HISTORY
WHERE sample_time > SYSDATE - 10/1440 AND session_type = 'FOREGROUND'
GROUP BY event, wait_class
ORDER BY samples DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

## Emergency Interventions

### Kill a Blocking Session
\`\`\`sql
ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE;
\`\`\`

### Terminate a Runaway SQL
\`\`\`sql
ALTER SYSTEM CANCEL SQL 'SID=123, SERIAL=4567, SQL_ID=abc123def';
\`\`\`

### As a Last Resort: Flush Shared Pool
\`\`\`sql
-- Do NOT do this without understanding the impact
ALTER SYSTEM FLUSH SHARED_POOL;
\`\`\`

## Root Cause Analysis After the Crisis

\`\`\`sql
-- Find AWR snapshot IDs covering the incident
SELECT snap_id, TO_CHAR(begin_interval_time,'YYYY-MM-DD HH24:MI') snap_time
FROM DBA_HIST_SNAPSHOT
WHERE begin_interval_time > SYSDATE - 4/24
ORDER BY snap_id;

-- Check optimizer statistics freshness
SELECT owner, table_name, last_analyzed,
       ROUND((SYSDATE - last_analyzed)*24,1) hours_since_analyze
FROM DBA_TABLES
WHERE owner IN ('APPS','APPLSYS') AND last_analyzed < SYSDATE - 7
ORDER BY hours_since_analyze DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

## Prevention

1. **Automated statistics jobs** — Run FND_STATS on a schedule.
2. **SQL Plan Baselines** — Pin correct plans: \`DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE\`.
3. **Resource Manager** — Cap runaway queries.
4. **Redo log sizing** — Less than one switch every 15–20 minutes.
5. **Monitoring thresholds** — Alert on active session count, CPU%, log switch frequency.
`;

const EBS_CLONE_CONTENT = `
## Why EBS Cloning Is Not Like Standard Oracle Cloning

Cloning an Oracle E-Business Suite 12.2 instance is significantly more involved than cloning a regular Oracle database. EBS has two distinct tiers — the database tier and the applications tier — and each has its own clone procedure. The two tiers must be cloned in coordination, and the post-clone configuration steps are mandatory and non-trivial.

## Pre-Clone Checklist

**Source Environment**
- EBS is at a clean state — no active ADOP patch cycles, no pending concurrent requests
- Both DB and apps services are running normally
- Autoconfig ran successfully in the last 24 hours

**Target Environment**
- Target OS is the same version as source
- Oracle DB software installed to same ORACLE_HOME path as source
- EBS software will be cloned — do not pre-install EBS on target
- Sufficient disk space on both tiers

## Step 1: Run adpreclone on Source DB Tier

\`\`\`bash
export ORACLE_SID=EBSDEV
perl $ORACLE_HOME/appsutil/scripts/EBSDEV_sourcehost/adpreclone.pl dbTier
\`\`\`

## Step 2: Run adpreclone on Source Apps Tier

\`\`\`bash
source /u01/install/APPS/EBSapps.env run
perl $AD_TOP/bin/adpreclone.pl appsTier
\`\`\`

## Step 3: Take RMAN Backup

\`\`\`bash
rman target /
RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG;
\`\`\`

## Step 4: Transfer Files to Target

\`\`\`bash
# Transfer DB appsutil clone template
rsync -avz /backup/staging/ oracle@targetdbhost:/backup/staging/
# Transfer apps files (100–300GB)
rsync -avz --progress --exclude='*.log' /u01/install/APPS/ applmgr@targetappshost:/u01/install/APPS/
\`\`\`

## Step 5: Restore and Configure Target DB Tier

\`\`\`bash
rman target /
RMAN> RESTORE DATABASE FROM '/backup/rman/';
RMAN> RECOVER DATABASE;
RMAN> ALTER DATABASE OPEN RESETLOGS;

# Change DB name if needed
nid target=/ dbname=EBSCLONE

# Run adcfgclone for the DB tier
perl $ORACLE_HOME/appsutil/clone/bin/adcfgclone.pl dbTier
\`\`\`

## Step 6: Configure Target Apps Tier

\`\`\`bash
cd $COMMON_TOP/clone/bin
perl adcfgclone.pl appsTier
# Runs 30–60 minutes; reconfigures WebLogic domain and autoconfig
\`\`\`

## Step 7: Post-Clone Configuration

\`\`\`sql
-- Unlock APPS and APPLSYS
ALTER USER APPS IDENTIFIED BY <newpassword> ACCOUNT UNLOCK;
ALTER USER APPLSYS IDENTIFIED BY <newpassword> ACCOUNT UNLOCK;

-- Reset sysadmin password
BEGIN
    FND_USER_PKG.UpdateUser(
        x_user_name => 'SYSADMIN', x_owner => 'CUST',
        x_unencrypted_password => '<newpassword>', x_password_date => SYSDATE
    );
    COMMIT;
END;
/
\`\`\`

## Step 8: Services Validation

\`\`\`bash
$ORACLE_HOME/bin/dbstart $ORACLE_HOME
lsnrctl start
tnsping EBSCLONE
$ADMIN_SCRIPTS_HOME/adstartall.sh
\`\`\`

## Post-Clone Validation

\`\`\`sql
-- Verify DB is open and APPS schema accessible
SELECT GLOBAL_NAME FROM GLOBAL_NAME;
SELECT COUNT(*) FROM APPS.FND_USER;

-- Check for invalid objects
SELECT OWNER, COUNT(*) CNT FROM DBA_OBJECTS
WHERE STATUS = 'INVALID'
GROUP BY OWNER ORDER BY 2 DESC;
-- Run @?/rdbms/admin/utlrp.sql if APPS/APPLSYS have invalids

-- Verify Concurrent Manager
SELECT INSTANCE_NUMBER, STATUS_CODE, RUNNING_PROCESSES
FROM FND_CONCURRENT_QUEUES
WHERE CONCURRENT_QUEUE_NAME = 'STANDARD';
\`\`\`

## Common Clone Failures

### adcfgclone Fails at Relink
\`\`\`bash
ls $ORACLE_HOME/lib/libclntsh.so.*  # missing = ORACLE_HOME not transferred correctly
\`\`\`

### tnsping Works but Apps Cannot Connect to DB
\`\`\`bash
sqlplus apps/<pwd>@EBSCLONE  # test from apps tier OS user
\`\`\`

### WebLogic Admin Server Not Starting
\`\`\`bash
grep -r "listen-address" $FMW_HOME/user_projects/domains/EBS_domain/config/config.xml
# Ensure all addresses match the new target hostname
\`\`\`
`;

function stubContent(topics) {
  return `## Coming Soon\n\nThis article is in progress. It will cover: ${topics.join(', ')}.\n\nCheck back soon, or [see our other articles](/blog) for Oracle DBA field notes you can use today.`;
}

const AWR_ASH_CONTENT = `
## Why AWR Reports Are Misread

Most DBAs open an AWR report, scroll straight to "Top 5 Timed Events," pick the top entry, and start tuning that. That's the wrong approach. The top wait event is often a symptom, not a root cause. Reading AWR correctly means starting with the load profile, understanding DB Time, and only then looking at waits — with the context to interpret them.

This guide walks through the sections that actually matter and shows you what to look for in each.

## Generating an AWR Report

AWR snapshots are taken automatically every hour (default). To generate a report:

\`\`\`sql
-- List recent snapshots to find your window
SELECT snap_id, begin_interval_time, end_interval_time
FROM dba_hist_snapshot
ORDER BY snap_id DESC
FETCH FIRST 48 ROWS ONLY;

-- Generate the HTML report for snap IDs 1200–1201 on instance 1
@$ORACLE_HOME/rdbms/admin/awrrpt.sql
-- Choose: html or text, instance number, begin/end snap IDs
\`\`\`

For a specific time window from the command line:

\`\`\`sql
-- AWR report for the last 2 hours
VARIABLE rpt CLOB;
EXEC :rpt := DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
  l_dbid    => (SELECT dbid FROM v$database),
  l_inst_num => 1,
  l_bid     => (SELECT min(snap_id) FROM dba_hist_snapshot
                WHERE begin_interval_time >= SYSDATE - 2/24),
  l_eid     => (SELECT max(snap_id) FROM dba_hist_snapshot
                WHERE end_interval_time   <= SYSDATE)
);
\`\`\`

## Section 1: Report Summary — DB Time Is Everything

The first thing to look at is **DB Time** in the Report Summary. DB Time is the total Oracle CPU + wait time consumed by all foreground sessions during the snapshot window. It is the single most important number in the report.

\`\`\`
DB Time:         1,482.3 (mins)
Elapsed time:       60.1 (mins)
DB CPU:            421.6 (mins)
\`\`\`

Calculate the **active session count**: DB Time ÷ Elapsed Time = 1482.3 ÷ 60.1 = **24.7 average active sessions**.

If your server has 32 CPUs and you see 24.7 average active sessions, the database is well-utilized. If you see 150 average active sessions on the same server, you have a throughput problem — sessions are piling up waiting.

DB CPU ÷ DB Time = 421.6 ÷ 1482.3 = **28% of DB Time was on CPU**. The remaining 72% was wait time. That means wait events matter here.

## Section 2: Load Profile — Throughput at a Glance

\`\`\`
                           Per Second    Per Transaction
               DB Time(s):        24.7              0.04
                DB CPU(s):         7.0              0.01
       Redo size (bytes):    2,847,312         4,210.2
   Logical reads (blocks):      98,421           145.7
   Block changes:                8,492            12.6
   Physical reads (blocks):      1,847             2.7
   Physical writes (blocks):     2,104             3.1
   User calls:                   4,823             7.1
   Parses:                       2,312             3.4
   Hard parses:                    147             0.2
   Executions:                  67,621           100.1
   Rollbacks:                       32             0.0
   Transactions:                   676
\`\`\`

What to look for:

**Hard parses per second > 100**: SQL is not being reused. Check cursor_sharing or application-level bind variable usage. Hard parses are CPU-expensive and cause library cache latch contention.

**Logical reads per transaction > 10,000**: Queries are doing full scans or missing indexes. Cross-check with the SQL ordered by logical reads section.

**Redo size per second > 50 MB**: Heavy write workload. Check for bulk DML without commit batching, or missing direct-path inserts.

**Physical reads per second disproportionate to logical reads**: Buffer cache hit ratio is low. Consider increasing \`DB_CACHE_SIZE\`.

## Section 3: Top 5 Timed Events — Read These Last

Now that you have context, look at Top 5 Timed Events:

\`\`\`
Top 5 Timed Foreground Events
Event                          Waits     Time (s)  Avg wait (ms)  % DB Time
------------------------------ --------- --------- -------------- ---------
DB CPU                                     25,300                     28.4%
db file sequential read        2,847,201  31,200          10.96      35.0%
log file sync                    412,100   8,904          21.61      10.0%
db file scattered read           198,300   4,200          21.18       4.7%
latch: shared pool               12,400   3,600         290.32       4.0%
\`\`\`

**DB CPU first**: If CPU is 28% of DB Time and you have capacity, CPU is not the bottleneck.

**db file sequential read (single block I/O)**: Index reads or undo reads. High total time with reasonable avg wait (10ms) usually means the query is doing many correct index lookups — not necessarily a problem. If avg wait > 30ms, I/O subsystem is slow.

**log file sync**: Wait experienced by a COMMIT. If avg wait > 20ms, your redo log group is on slow storage or log_buffer is undersized. Move redo logs to SSD.

**db file scattered read (multi-block I/O)**: Full table scans or fast full index scans. High here often matches high logical reads per transaction — look for missing indexes.

**latch: shared pool**: If this appears with high total time, you have hard parse or cursor invalidation issues. Check \`cursor_sharing\` and look at \`v$sql\` for statements with high \`parse_calls/executions\` ratio.

## Section 4: SQL Ordered by CPU and Elapsed Time

This is where you find the specific SQL causing load:

\`\`\`sql
-- Find the same top SQL from v$sql in real time
SELECT sql_id,
       ROUND(cpu_time/1e6, 2)         cpu_sec,
       ROUND(elapsed_time/1e6, 2)     elapsed_sec,
       executions,
       ROUND(cpu_time/NULLIF(executions,0)/1e6, 4) cpu_per_exec,
       SUBSTR(sql_text, 1, 100)       sql_preview
FROM v$sql
WHERE executions > 0
ORDER BY cpu_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

For a top SQL from the AWR report, get its execution plan history:

\`\`\`sql
-- See all plans for a specific SQL ID from AWR history
SELECT plan_hash_value,
       MIN(begin_interval_time) first_seen,
       MAX(end_interval_time)   last_seen,
       SUM(executions_delta)    total_execs,
       ROUND(SUM(elapsed_time_delta)/1e6 / NULLIF(SUM(executions_delta),0), 2) avg_elapsed_ms
FROM dba_hist_sql_plan p
JOIN dba_hist_sqlstat  s USING (sql_id, plan_hash_value)
JOIN dba_hist_snapshot sn USING (snap_id)
WHERE p.sql_id = '&your_sql_id'
GROUP BY plan_hash_value
ORDER BY last_seen DESC;
\`\`\`

A plan_hash_value change between two snapshots means the optimizer chose a different plan — often the root cause of a sudden performance regression.

## Section 5: Wait Event Histograms

The histogram section shows how waits are distributed. A histogram where 90% of "db file sequential read" waits complete in <8ms tells a very different story than one where 40% take >64ms.

\`\`\`sql
-- Current wait event histogram from memory
SELECT event, wait_time_milli, wait_count
FROM v$event_histogram
WHERE event IN ('db file sequential read', 'db file scattered read', 'log file sync')
ORDER BY event, wait_time_milli;
\`\`\`

For I/O events, if you see a bimodal distribution (lots of fast waits + a long tail of slow waits), suspect I/O subsystem contention at specific times rather than a persistent problem.

## Using ASH to Drill Into a Specific Window

AWR covers an hour; ASH covers seconds. When a user says "it was slow between 14:23 and 14:31," use ASH:

\`\`\`sql
-- What was happening between 14:23 and 14:31 today?
SELECT
    TO_CHAR(sample_time, 'HH24:MI:SS')  sample_time,
    session_state,
    event,
    COUNT(*)                             active_sessions
FROM v$active_session_history
WHERE sample_time BETWEEN
    TO_DATE('2026-06-09 14:23:00', 'YYYY-MM-DD HH24:MI:SS') AND
    TO_DATE('2026-06-09 14:31:00', 'YYYY-MM-DD HH24:MI:SS')
GROUP BY TO_CHAR(sample_time, 'HH24:MI:SS'), session_state, event
ORDER BY 1, 4 DESC;
\`\`\`

For a specific SQL during that window:

\`\`\`sql
SELECT sql_id, event, COUNT(*) samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) pct
FROM v$active_session_history
WHERE sample_time BETWEEN
    TO_DATE('2026-06-09 14:23:00', 'YYYY-MM-DD HH24:MI:SS') AND
    TO_DATE('2026-06-09 14:31:00', 'YYYY-MM-DD HH24:MI:SS')
  AND session_state = 'WAITING'
GROUP BY sql_id, event
ORDER BY samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

For historical ASH (older than the in-memory window):

\`\`\`sql
-- From DBA_HIST_ACTIVE_SESS_HISTORY — same query on the history table
SELECT sql_id, event, COUNT(*) samples
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN
    TO_DATE('2026-06-08 14:23:00', 'YYYY-MM-DD HH24:MI:SS') AND
    TO_DATE('2026-06-08 14:31:00', 'YYYY-MM-DD HH24:MI:SS')
  AND session_state = 'WAITING'
GROUP BY sql_id, event
ORDER BY samples DESC;
\`\`\`

## The Six Questions an AWR Report Should Answer

When you open any AWR report, work through this checklist:

1. **What is the average active session count?** (DB Time ÷ Elapsed Time) — are you over your CPU count?
2. **What fraction of DB Time is on CPU vs waiting?** If >70% CPU, look at CPU-bound SQL. If <30% CPU, look at waits.
3. **What is the hard parse rate?** Anything above 100/second warrants attention.
4. **What are the top 2–3 waits by total time, and what are their average wait times?** Average wait tells you severity; total time tells you scope.
5. **Are there any "new" events in Top 5 compared to your baseline?** A new latch or enqueue event is a signal.
6. **Which SQL IDs dominate CPU and elapsed time?** Pull their plans and check for plan regressions.

## Common AWR Patterns and What They Mean

| Pattern | Likely Cause | First Check |
|---------|-------------|-------------|
| log file sync >15ms avg | Slow redo storage | Move redo to SSD; check iostat on redo disk |
| library cache: mutex X high | Hard parses / plan invalidation | cursor_sharing=FORCE; check v$sql_plan_statistics_all |
| enq: TX — row lock contention | Application lock contention | v$session.blocking_session |
| buffer busy waits > 1% DB Time | Hot blocks (segment header or data block) | dba_segments where segment_type='TABLE' |
| latch: cache buffers chains | Hot data blocks | Find object with v$bh by file#/block# |
| cursor: pin S wait on X | Hard parse concurrency | cursor_sharing, avoid shared pool flush |
| read by other session | I/O bottleneck with session contention | Check I/O queuing, consider async I/O |

TuneVault's health check runs AWR analysis automatically on every check, surfacing the top wait patterns and flagging SQL regressions without requiring you to manually generate and read the report.
`;

const UPGRADE_19C_CONTENT = `
## Why 19c Is the Right Target

Oracle 19c (19.3+) is Oracle's long-term support release for the 12.2 family — full Premier Support runs through April 2024, Extended Support through April 2027. It is the most stable, best-patched version of the 12.2 codebase. More importantly for EBS and third-party applications, 19c is the last version that maintains full compatibility with 12c feature sets.

If you are on 12.1.0.2 or 12.2.0.1, upgrading to 19c is a direct, supported path. If you are on 11.2.0.4, you can go direct to 19c as well. Oracle does not require you to step through intermediate versions.

## Before You Start: Pre-Upgrade Checks

### Step 1: Run preupgrade.jar

Oracle provides a free diagnostic tool that checks your database for upgrade-blocking conditions:

\`\`\`bash
# On the source (12c) database server
# Download preupgrade.jar from MOS (Doc ID 884522.1)
# Or use the one bundled in your 19c ORACLE_HOME:

java -jar $ORACLE_HOME_19C/rdbms/admin/preupgrade.jar \
  TEXT TERMINAL DIR /tmp/preupgrade_output

# This connects to the database via bequeath (must run as oracle OS user)
# and generates:
#   /tmp/preupgrade_output/preupgrade.log      — human-readable report
#   /tmp/preupgrade_output/preupgrade_fixups.sql — fixups to run BEFORE upgrade
#   /tmp/preupgrade_output/postupgrade_fixups.sql — fixups to run AFTER upgrade
\`\`\`

Read through every WARNING and RECOMMEND item in preupgrade.log. The most common blockers:

**Timezone version mismatch**: Your DB uses TZ version 14, the 19c home ships with TZ version 32. You must update to the target version. Run \`$ORACLE_HOME_19C/OPatch/datapatch\` post-upgrade — or use the timezone upgrade utility.

**Invalid/broken objects**: Pre-upgrade fixups recompile known Oracle-owned invalid objects. Custom schema invalids must be resolved by you.

**Deprecated parameters**: Parameters removed in 19c that must be cleared from spfile before upgrade. preupgrade.log lists them explicitly.

### Step 2: Run preupgrade_fixups.sql on the SOURCE database

\`\`\`sql
-- Connect as SYSDBA to the source database
@/tmp/preupgrade_output/preupgrade_fixups.sql
\`\`\`

This runs automatically — it fixes timezone issues, gathers optimizer statistics, recompiles invalid objects. Review the output for any FAILURE lines.

### Step 3: Identify and fix custom invalid objects

\`\`\`sql
-- Find all non-Oracle invalid objects
SELECT owner, object_type, object_name, status
FROM dba_objects
WHERE status = 'INVALID'
  AND owner NOT IN (
    'SYS','SYSTEM','OUTLN','DBA_BUNDLE','OJVMSYS','LBACSYS',
    'DBSNMP','APPQOSSYS','DBSFWUSER','GSMADMIN_INTERNAL',
    'CTXSYS','ORDPLUGINS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA',
    'MDSYS','OLAPSYS','DVSYS','AUDSYS','DVF','GGSYS','APEX_PUBLIC_USER'
  )
ORDER BY owner, object_type, object_name;

-- Recompile invalid objects in a schema
EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => 'YOUR_SCHEMA', compile_all => FALSE);

-- Or use utlrp.sql to recompile all (takes 5–30 min on large databases)
@$ORACLE_HOME/rdbms/admin/utlrp.sql
\`\`\`

## The AutoUpgrade Tool

AutoUpgrade is Oracle's recommended upgrade method from 19.3 onwards. It handles the entire upgrade process: pre-checks, mode switching, upgrade execution, post-upgrade fixups, and compilation.

### Download and Version Check

AutoUpgrade is distributed as a single JAR. Always use the latest version (downloaded from MOS Doc ID 2485457.1 — do not use the one bundled in the 19c home, it may be outdated):

\`\`\`bash
# Check version
java -jar autoupgrade.jar -version
# Should be 23.x or later for production use

# Verify Java version (minimum: Java 8)
java -version
\`\`\`

### Create the Configuration File

\`\`\`ini
# /home/oracle/autoupgrade/config.cfg

# Global settings
global.autoupg_log_dir=/u01/autoupgrade/logs

# Database 1: PRODDB
upg1.dbname=PRODDB
upg1.start_time=NOW
upg1.source_home=/u01/app/oracle/product/12.2.0/db_1
upg1.target_home=/u01/app/oracle/product/19.3.0/db_1
upg1.sid=PRODDB
upg1.log_dir=/u01/autoupgrade/logs/PRODDB
upg1.upgrade_node=localhost
upg1.run_utlrp=yes
upg1.timezone_upg=yes

# Optional: retain old parameters for analysis (AutoUpgrade strips deprecated ones)
# upg1.drop_grp_after_upgrade=no
\`\`\`

### Analyze Mode (No Changes Made)

\`\`\`bash
# Run analyze — reads the database and generates a report
java -jar autoupgrade.jar -config /home/oracle/autoupgrade/config.cfg -mode analyze

# Review:
cat /u01/autoupgrade/logs/PRODDB/*/autoupgrade_*.log | grep -E "ERROR|WARNING|CRITICAL"
\`\`\`

### Fixups Mode (Prepares the Database)

\`\`\`bash
# Run fixups — makes changes needed before upgrade, but does not upgrade yet
java -jar autoupgrade.jar -config /home/oracle/autoupgrade/config.cfg -mode fixups
\`\`\`

### Deploy Mode (Full Upgrade)

\`\`\`bash
# Full unattended upgrade
nohup java -jar autoupgrade.jar \
  -config /home/oracle/autoupgrade/config.cfg \
  -mode deploy > /u01/autoupgrade/logs/autoupgrade.out 2>&1 &

# Monitor progress (while running)
tail -f /u01/autoupgrade/logs/PRODDB/*/autoupgrade_*.log

# Or use the interactive console
java -jar autoupgrade.jar -config /home/oracle/autoupgrade/config.cfg -mode deploy
# Type 'lsj' to list jobs, 'status -job 1' for detail
\`\`\`

AutoUpgrade will:
1. Shut down the source database cleanly
2. Start it in upgrade mode using the 19c home
3. Run catupgrd.sql (the core catalog upgrade)
4. Run post-upgrade fixups
5. Recompile all invalid objects
6. Update timezone data
7. Restart the database in normal mode

On a typical 200GB database, expect 45–90 minutes. For multi-terabyte databases, the catalog upgrade is the bottleneck (not data volume) and usually completes in under 3 hours.

## Post-Upgrade Tasks

### Verify the Upgrade

\`\`\`sql
-- Check database version
SELECT version FROM v$instance;
-- Should show 19.x.x.x.x

-- Check for remaining invalid objects
SELECT count(*), status FROM dba_objects GROUP BY status;

-- Run post-upgrade fixups
@/tmp/preupgrade_output/postupgrade_fixups.sql

-- Gather fresh optimizer statistics (critical — skip this and you will have bad plans)
EXEC DBMS_STATS.GATHER_DICTIONARY_STATS;
EXEC DBMS_STATS.GATHER_FIXED_OBJECTS_STATS;
\`\`\`

### Update Compatibility Parameter

\`\`\`sql
-- Check current compatible parameter
SHOW PARAMETER compatible;

-- It was set to 12.2.0 for the upgrade — once you are satisfied, advance it:
-- WARNING: This is irreversible. The database cannot be downgraded after this.
ALTER SYSTEM SET COMPATIBLE = '19.0.0' SCOPE=SPFILE;
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

Wait at least 2–4 weeks before advancing compatible. If you discover application issues, you can still restore from backup to 12c as long as compatible < 19.

### Update timezone (if not done by AutoUpgrade)

\`\`\`bash
# Check current timezone version
SELECT version FROM v$timezone_file;

# If < 32, run the DBMS_DST upgrade (required for correct timestamp handling)
# This is a two-phase operation requiring a maintenance window
EXEC DBMS_DST.BEGIN_UPGRADE(32);
# ... application downtime here ...
EXEC DBMS_DST.UPGRADE_DATABASE;
EXEC DBMS_DST.END_UPGRADE;
\`\`\`

### Update listener and tnsnames

\`\`\`bash
# Update listener.ora to point to new ORACLE_HOME
# Remove the 12c entry, add 19c:

LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = dbhost)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = PRODDB)
      (ORACLE_HOME = /u01/app/oracle/product/19.3.0/db_1)
      (SID_NAME = PRODDB)
    )
  )

# Restart listener from 19c home
$ORACLE_HOME_19C/bin/lsnrctl stop
$ORACLE_HOME_19C/bin/lsnrctl start
\`\`\`

## Common Problems and Fixes

**Upgrade hangs at "Running component Catalog"**: Usually a contention issue in the catalog upgrade SQL. Check alert log for ORA-1555 (undo space) or ORA-60 (deadlock). Adding undo space and restarting from the checkpoint usually resolves it.

**catupgrd.sql fails with ORA-04063**: Invalid packages that the upgrade depends on. Run utlrp.sql manually, then re-run the catupgrd script from where it failed (AutoUpgrade can resume from checkpoint).

**Applications fail post-upgrade with ORA-00904 (invalid identifier)**: A column or feature was removed or renamed in 19c. The most common is column names that became reserved words. Fix by using column aliases in queries.

**JDBC thin driver connection failures**: Old JDBC drivers (ojdbc6.jar) are incompatible with 19c in some combinations. Upgrade to ojdbc8.jar from the 19c home.

**EBS R12.2 on 19c**: Run the Oracle E-Business Suite Pre-Upgrade steps first (MOS Doc ID 2552566.1). EBS 12.2.7+ is certified on 19c. Run adop phase=apply for any pending patches after the upgrade.

## Rollback Plan

AutoUpgrade creates a guaranteed restore point (GRP) before the upgrade unless you explicitly disable it:

\`\`\`sql
-- If you need to roll back (must be done before advancing compatible)
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
FLASHBACK DATABASE TO RESTORE POINT AUTOUPGRADE_9212_PRODDB12201;
ALTER DATABASE OPEN RESETLOGS;
-- Re-link the database to the 12c home
\`\`\`

The GRP is automatically dropped by AutoUpgrade after 30 days. Make sure you have a physical backup as well — GRP-based rollback requires the FRA to have enough space for all redo since the snapshot.

TuneVault's health check runs the Oracle 19c readiness checks automatically, identifying deprecated parameters, invalid objects, and timezone version mismatches before you start your upgrade window.
`;

const TABLESPACE_MGMT_CONTENT = `
## The Two Modes of Datafile Sizing

Every Oracle tablespace is backed by datafiles. Each datafile is either:

- **Fixed size**: You allocated 100GB and that is what it gets. The database will raise ORA-01652 or ORA-01653 when space runs out.
- **AUTOEXTEND ON**: The datafile grows automatically when more space is needed, up to a MAXSIZE (or unlimited if you did not set one).

Most production databases use a mix of both. Knowing when to use each is the first decision in tablespace management.

## When to Use AUTOEXTEND

Autoextend makes sense for:

- **SYSTEM and SYSAUX tablespaces**: These are internal Oracle spaces. They should never fill up — autoextend prevents outages from catalog growth during patches or upgrades.
- **UNDO tablespace**: Autoextend gives the undo system breathing room during large batch operations. Pair it with UNDO_RETENTION tuning.
- **TEMP tablespace**: Temporary segments are transient. Autoextend with a reasonable MAXSIZE avoids sort-abort errors without wasting permanent disk.

Autoextend is risky for:

- **Application data tablespaces** where runaway jobs or batch imports can fill an entire filesystem overnight. A fixed MAXSIZE with a monitoring alert is safer.
- **Environments where disk is shared** between multiple databases — one database can consume space intended for another.

## When to Use Fixed Size with Alerts

Fixed-size datafiles force you to take an explicit action before a tablespace grows. This is the right model for application data because it catches problems:

- A runaway batch job that is duplicating data
- A missing partition that dumps all rows into a default partition
- An archivelog or audit table that was not housekept

The tradeoff: you need active monitoring and the discipline to pre-allocate space before it is needed.

## Core Monitoring Queries

### Current Tablespace Usage

\`\`\`sql
SELECT
    t.tablespace_name,
    t.contents,
    ROUND(NVL(f.free_mb, 0), 2)             free_mb,
    ROUND(t.total_mb, 2)                    total_mb,
    ROUND((1 - NVL(f.free_mb,0)/t.total_mb)*100, 1) pct_used,
    ROUND(NVL(mx.maxsize_mb, t.total_mb), 2) maxsize_mb,
    CASE
      WHEN (1 - NVL(f.free_mb,0)/t.total_mb)*100 > 90 THEN 'CRITICAL'
      WHEN (1 - NVL(f.free_mb,0)/t.total_mb)*100 > 80 THEN 'WARNING'
      ELSE 'OK'
    END status
FROM
    (SELECT tablespace_name, contents,
            SUM(bytes)/1048576 total_mb
     FROM dba_data_files GROUP BY tablespace_name, contents) t
LEFT JOIN
    (SELECT tablespace_name, SUM(bytes)/1048576 free_mb
     FROM dba_free_space GROUP BY tablespace_name) f
    ON t.tablespace_name = f.tablespace_name
LEFT JOIN
    (SELECT tablespace_name,
            SUM(CASE WHEN maxbytes = 0 THEN bytes ELSE maxbytes END)/1048576 maxsize_mb
     FROM dba_data_files GROUP BY tablespace_name) mx
    ON t.tablespace_name = mx.tablespace_name
ORDER BY pct_used DESC;
\`\`\`

This query accounts for autoextend: if a datafile has MAXSIZE set, it uses that as the ceiling rather than the current allocation. This gives you a more accurate "how much headroom do I really have?" answer.

### UNDO and TEMP (Use Different Views)

UNDO and TEMP tablespaces are not covered by dba_free_space:

\`\`\`sql
-- UNDO usage
SELECT
    d.tablespace_name,
    ROUND(SUM(d.bytes)/1e9, 2) allocated_gb,
    ROUND(SUM(u.bytes)/1e9, 2) used_gb,
    ROUND(SUM(u.bytes)*100/NULLIF(SUM(d.bytes),0), 1) pct_used
FROM dba_data_files d
JOIN v$undostat u ON 1=1  -- cross-join trick; v$undostat shows current undo usage
WHERE d.tablespace_name = (SELECT value FROM v$parameter WHERE name='undo_tablespace')
GROUP BY d.tablespace_name;

-- Simpler UNDO check via v$undostat (last 1440 minutes = 24 hours of stats)
SELECT
    TO_CHAR(begin_time,'HH24:MI') period,
    undoblks,
    txncount,
    maxconcurrency,
    ROUND(undoblks * 8192 / 1e9, 3) undo_gb_per_period
FROM v$undostat
ORDER BY begin_time DESC
FETCH FIRST 12 ROWS ONLY;

-- TEMP usage (currently used)
SELECT
    t.tablespace_name,
    ROUND(SUM(t.bytes)/1e9, 2) total_gb,
    ROUND(NVL(SUM(u.bytes_used)/1e9, 0), 2) used_gb,
    ROUND(NVL(SUM(u.bytes_used)*100/SUM(t.bytes), 0), 1) pct_used
FROM dba_temp_files t
LEFT JOIN v$temp_extent_pool u ON t.file_id = u.file_id
GROUP BY t.tablespace_name;
\`\`\`

## Growth Rate Analysis

Knowing current usage tells you today's problem. Growth rate tells you next month's.

\`\`\`sql
-- Tablespace growth over the last 7 days (requires AWR — Diagnostics Pack license)
SELECT
    tablespace_name,
    TO_CHAR(snap_date, 'YYYY-MM-DD') snap_date,
    ROUND(allocated_mb, 1) allocated_mb,
    ROUND(used_mb, 1) used_mb,
    ROUND(used_mb - LAG(used_mb, 1) OVER (PARTITION BY tablespace_name ORDER BY snap_date), 1) daily_growth_mb
FROM (
    SELECT
        s.tablespace_name,
        TRUNC(sn.end_interval_time) snap_date,
        MAX(s.tablespace_size * 8 / 1024) allocated_mb,
        MAX(s.tablespace_used_size * 8 / 1024) used_mb
    FROM dba_hist_tbspc_space_usage s
    JOIN dba_hist_snapshot sn ON s.snap_id = sn.snap_id
    WHERE sn.end_interval_time >= SYSDATE - 7
    GROUP BY s.tablespace_name, TRUNC(sn.end_interval_time)
)
ORDER BY tablespace_name, snap_date;
\`\`\`

For non-AWR environments, log snapshots daily using a custom table:

\`\`\`sql
-- Create a simple tablespace history log
CREATE TABLE dba_ts_history AS
SELECT SYSDATE snap_time, tablespace_name, SUM(bytes)/1048576 used_mb
FROM dba_segments
GROUP BY tablespace_name;

-- Schedule via DBMS_SCHEDULER to run nightly
-- Then query growth trend:
SELECT tablespace_name,
       MAX(used_mb) - MIN(used_mb) growth_mb_over_period,
       COUNT(*) days_sampled
FROM dba_ts_history
WHERE snap_time >= SYSDATE - 30
GROUP BY tablespace_name
ORDER BY growth_mb_over_period DESC;
\`\`\`

## Adding Space

When you need to extend a tablespace:

\`\`\`sql
-- Option 1: Add a new datafile
ALTER TABLESPACE APP_DATA
  ADD DATAFILE '/u02/oradata/PRODDB/app_data02.dbf'
  SIZE 50G AUTOEXTEND OFF;

-- Option 2: Resize an existing datafile
ALTER DATABASE DATAFILE '/u01/oradata/PRODDB/app_data01.dbf' RESIZE 100G;

-- Option 3: Enable autoextend on existing datafile (carefully)
ALTER DATABASE DATAFILE '/u01/oradata/PRODDB/app_data01.dbf'
  AUTOEXTEND ON MAXSIZE 200G;

-- Find current datafiles and their sizes
SELECT file_name, bytes/1073741824 size_gb, maxbytes/1073741824 maxsize_gb, autoextensible
FROM dba_data_files
WHERE tablespace_name = 'APP_DATA'
ORDER BY file_id;
\`\`\`

## Bigfile Tablespaces

Bigfile tablespaces use a single datafile instead of many smallfiles. Benefits:
- No 1022-datafile limit per tablespace
- Simpler Oracle Managed Files management
- Smaller control file

Drawbacks:
- Backup I/O is sequential (one big file, not parallelizable across files)
- Recovery of a single block requires restoring the entire large file

Use bigfile for ASM environments (ASM handles striping) or when you are already using Oracle Managed Files. Avoid bigfile on filesystems where your backup software can parallelize by file.

\`\`\`sql
-- Create a bigfile tablespace
CREATE BIGFILE TABLESPACE WAREHOUSE_DATA
  DATAFILE '/u04/oradata/PRODDB/warehouse01.dbf' SIZE 5T
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Check if a tablespace is bigfile
SELECT tablespace_name, bigfile FROM dba_tablespaces;
\`\`\`

## Setting Up Proactive Alerts

The best way to avoid tablespace emergencies is to alert before you hit 80%. Oracle provides built-in thresholds via the Server Alert system:

\`\`\`sql
-- Set custom warning/critical thresholds per tablespace
EXEC DBMS_SERVER_ALERT.SET_THRESHOLD(
  metrics_id       => DBMS_SERVER_ALERT.TABLESPACE_PCT_FULL,
  warning_operator => DBMS_SERVER_ALERT.OPERATOR_GE,
  warning_value    => '80',
  critical_operator => DBMS_SERVER_ALERT.OPERATOR_GE,
  critical_value   => '90',
  observation_period => 30,
  consecutive_occurrences => 1,
  instance_name    => NULL,
  object_type      => DBMS_SERVER_ALERT.OBJECT_TYPE_TABLESPACE,
  object_name      => 'APP_DATA'
);

-- View current thresholds
SELECT object_name, metrics_name, warning_value, critical_value
FROM dba_thresholds
WHERE object_type = 'TABLESPACE';
\`\`\`

For email alerts via DBMS_ALERT or an external script:

\`\`\`bash
#!/bin/bash
# tablespace_alert.sh — run from cron every 30 minutes
ALERT_THRESHOLD=80

sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT tablespace_name || '|' || ROUND((1-f.free_mb/t.total_mb)*100,1)
FROM (SELECT tablespace_name, SUM(bytes)/1048576 total_mb FROM dba_data_files GROUP BY tablespace_name) t
LEFT JOIN (SELECT tablespace_name, SUM(bytes)/1048576 free_mb FROM dba_free_space GROUP BY tablespace_name) f
USING (tablespace_name)
WHERE (1-NVL(f.free_mb,0)/t.total_mb)*100 > $ALERT_THRESHOLD;
EXIT;
EOF
\`\`\`

## UNDO Sizing: A Practical Formula

Undersized UNDO causes ORA-01555 (snapshot too old) during long queries. Oversized UNDO wastes disk. The correct UNDO size depends on:

- Peak concurrent transactions (from v$undostat: maxconcurrency)
- Transaction size (undoblks per transaction)
- UNDO_RETENTION setting

\`\`\`sql
-- Calculate recommended UNDO size
SELECT
    MAX(undoblks) * 8192 / 1e9                 peak_undo_gb,
    (SELECT value FROM v$parameter WHERE name='undo_retention') undo_retention_s,
    MAX(undoblks) * 8192 / 1e9 *
    (SELECT value FROM v$parameter WHERE name='undo_retention') / 1800 recommended_size_gb
FROM v$undostat;
\`\`\`

The formula: recommended_undo_size = (undo_blocks_per_second × block_size × undo_retention_seconds). Add 20% headroom.

TuneVault monitors tablespace usage across all your Oracle connections, alerting you when any tablespace exceeds your configured threshold — with 30-day growth trend analysis to predict when you will run out before it becomes an emergency.
`;

const ADOP_CONTENT = `
## Before You Start — Checking Session State

Before running \`adop\`, check whether the database is in a clean state from the previous patch cycle.

\`\`\`sql
SELECT adop_session_id, prepare_status, apply_status, finalize_status,
       cutover_status, cleanup_status, abort_status, status, node_name
FROM ad_adop_sessions
ORDER BY adop_session_id DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

Status codes: \`N\` = not started, \`R\` = running, \`C\` = complete, \`F\` = failed, \`X\` = not applicable.

A healthy baseline before starting a new cycle: all statuses are \`C\` or \`X\` except abort_status which should be \`N\`. If the previous session shows \`F\` in any phase, investigate before proceeding.

\`\`\`sql
-- Check for orphaned patch edition objects from a failed session
SELECT count(*) FROM dba_objects
WHERE edition_name IS NOT NULL AND status = 'INVALID';
\`\`\`

Also confirm \`fs_clone\` ran after the last cycle. If it did not, the patch filesystem is out of sync and apply will behave unpredictably. There is no built-in query for this; check your patch log history or compare timestamps under \`$APPL_TOP/../fs1\` and \`$APPL_TOP/../fs2\`.

## Prepare Phase Failures

### Edition Already Exists

The most common prepare failure is:

\`\`\`
Error: Edition ORA$BASE already exists in an invalid state
\`\`\`

This happens when a previous prepare phase failed midway and left an orphaned edition. Find and drop it:

\`\`\`sql
-- Find editions in the database
SELECT edition_name, usable FROM dba_editions ORDER BY 1;

-- Drop the orphaned patch edition (not ORA$BASE)
DROP EDITION <patch_edition_name> CASCADE;
\`\`\`

Then re-run prepare:

\`\`\`bash
adop phase=prepare
\`\`\`

### Worker Timeouts During Prepare

Prepare spawns parallel workers that compile code in the patch edition. On large or busy databases, workers can time out:

\`\`\`
Error: Worker process timed out after 3600 seconds
\`\`\`

Increase the worker count and bump the timeout:

\`\`\`bash
adop phase=prepare workers=8 prepare_timeout=7200
\`\`\`

### Finding Prepare Logs

Prepare log location: \`$APPL_TOP/../log/adop/<session_id>/\`. For database-side errors, query AD_ZD_LOGS:

\`\`\`sql
SELECT log_sequence, log_type, log_text, log_date
FROM ad_zd_logs
WHERE adop_session_id = (SELECT MAX(adop_session_id) FROM ad_adop_sessions)
  AND log_type = 'E'
ORDER BY log_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

## Apply Phase Hangs

When apply stops making progress, check worker states:

\`\`\`sql
SELECT count(*), status
FROM ad_parallel_workers
WHERE adop_session_id = (SELECT MAX(adop_session_id) FROM ad_adop_sessions)
GROUP BY status;
\`\`\`

A healthy apply shows most workers \`R\` (running) or \`C\` (complete). All workers in \`W\` (waiting) with none running means the job queue is blocked — possibly waiting for a lock held by another session.

Find which jobs are assigned but stuck:

\`\`\`sql
SELECT worker_id, assigned_job_id, status, start_date
FROM ad_parallel_workers
WHERE adop_session_id = (SELECT MAX(adop_session_id) FROM ad_adop_sessions)
  AND status = 'W'
ORDER BY start_date;
\`\`\`

### Restarting Apply Without Losing Progress

ADOP apply is restartable. Kill the hung process and restart with \`restart=yes\`:

\`\`\`bash
adop phase=apply restart=yes workers=8
\`\`\`

ADOP skips jobs already marked complete and resumes from where it left off. You will not lose work already done.

### apply-mode=downtime as a Last Resort

For a patch that repeatedly hangs in online mode, switch to downtime mode. This requires taking all application services down and disables the dual-edition mechanism:

\`\`\`bash
adop phase=apply apply_mode=downtime workers=16
\`\`\`

Use this only when online mode is blocking the patch indefinitely and you have a maintenance window.

## Cutover Timeout

Cutover is the point of no return in a patch cycle. The default timeout is 30 minutes. On busy systems this can expire before all user sessions drain from the patch edition.

\`\`\`
Error: Cutover did not complete within the timeout period
\`\`\`

Increase the timeout:

\`\`\`bash
adop phase=cutover cutover_timeout=120
\`\`\`

Before running cutover, find what is holding up session drain:

\`\`\`sql
SELECT sid, serial#, username, status, program, sql_id,
       ROUND((SYSDATE - last_call_et / 86400) * 24 * 60, 0) minutes_active
FROM v$session
WHERE status = 'ACTIVE'
  AND username IS NOT NULL
  AND username != 'SYS'
ORDER BY last_call_et DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Kill stuck sessions that are not real user work, then retry cutover.

## fs_clone Failures

\`fs_clone\` synchronizes the run filesystem from the patch filesystem after a successful cutover. It is the most disk-intensive phase and the one most likely to fail due to space or NFS issues.

### Disk Space Check

The patch filesystem needs roughly 1.3x the run filesystem size. Check all app tier nodes before starting:

\`\`\`bash
df -h $APPL_TOP $INST_TOP $COMMON_TOP
\`\`\`

### NFS Mount Issues on Multi-Node

In multi-node configurations, the patch filesystem is typically NFS-shared. A stale mount causes cryptic copy errors. Check on all nodes:

\`\`\`bash
df -h | grep nfs
mount | grep $APPL_TOP
\`\`\`

Remount if needed, then retry:

\`\`\`bash
adop phase=fs_clone restart=yes
\`\`\`

## Abort and Full Recovery

### When to Abort

Abort when apply has failed irreversibly and restart is not recovering, or when the patch introduced a regression you cannot fix before cutover:

\`\`\`bash
adop phase=abort
\`\`\`

Abort rolls back the patch edition changes and returns the database to the pre-patch state. It does not affect the run filesystem — EBS continues operating normally.

### Full Cleanup

After abort (or after a successful cycle), run cleanup to reclaim disk space used by the patch filesystem:

\`\`\`bash
adop phase=cleanup cleanup_mode=full_cleanup
\`\`\`

Verify cleanup completed — every status should be \`C\` or \`X\`:

\`\`\`sql
SELECT adop_session_id, prepare_status, apply_status, finalize_status,
       cutover_status, cleanup_status, abort_status
FROM ad_adop_sessions
ORDER BY adop_session_id DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

Any status showing \`F\` after cleanup means cleanup itself failed. Check \`$APPL_TOP/../log/adop/<session>/cleanup/\` for the cause.

## Multi-Node Common Mistakes

### Running adop on the Wrong Node

In multi-node EBS, \`adop\` must be initiated from the master (run) node — the node where the WebLogic AdminServer runs. Running from a secondary node causes inconsistent patch application across nodes.

Identify the master node:

\`\`\`sql
SELECT node_name, server_address, support_cp, support_web, support_admin, support_db
FROM fnd_nodes
WHERE support_admin = 'Y';
\`\`\`

### SSH Trust Between Nodes

ADOP requires passwordless SSH between all application tier nodes as the applmgr OS user. Test before patching:

\`\`\`bash
# From master node, as applmgr
ssh applmgr@<secondary_node_hostname> hostname
\`\`\`

If this prompts for a password, fix SSH trust before starting a patch cycle. A missing SSH trust discovered mid-apply forces an abort.

### Patch Filesystem Sync After Multi-Node Apply

After fs_clone, the patch filesystem on all nodes should mirror the run filesystem. Verify the patch timestamp matches across nodes:

\`\`\`bash
ls -lt $APPL_TOP/../fs2/EBSapps/appl/ad/12.0.0/patch/115/ | head -5
# Run on each node; timestamps should match within seconds
\`\`\`
`;

const RAC_CONTENT = `
## First Commands When RAC Is Behaving Badly

When a RAC cluster is degraded, start at the CRS layer before touching the database.

\`\`\`bash
# Top-level CRS health
crsctl check crs

# Individual CRS components
crsctl check cssd     # cluster synchronization daemon
crsctl check crsd     # cluster ready services daemon
crsctl check evmd     # event manager daemon

# Database resource status across all instances
srvctl status database -d MYDB

# Full resource state table — read this carefully
crsctl stat res -t
\`\`\`

In the \`crsctl stat res -t\` output, look for resources in \`INTERMEDIATE\` or \`OFFLINE\` state that should be \`ONLINE\`. A VIP showing \`INTERMEDIATE\` means network failover is in progress or stuck.

## Diagnosing Interconnect Performance

The private interconnect is the most common source of RAC performance problems. In AWR, poor interconnect shows up as \`gc buffer busy acquire\`, \`gc cr request\`, and \`gc current request\` dominating Top Timed Events.

### Verify the Interconnect Interface

\`\`\`bash
# Which interface is configured for the interconnect?
oifcfg getif
# Output: eth1  192.168.10.0  global  cluster_interconnect

# Confirm the interface is actually on the private network
ip addr show eth1
\`\`\`

### Measure Interconnect Latency

\`\`\`bash
# From node 1, ping node 2 private IP with 8KB packets (simulates block transfer)
ping -I eth1 192.168.10.102 -s 8192 -c 100

# Acceptable: avg round-trip < 0.5ms
# Investigate: avg round-trip > 1ms
# Problem:     avg round-trip > 3ms or any packet loss
\`\`\`

### Global Cache Statistics in SQL

\`\`\`sql
SELECT name, value
FROM v$sysstat
WHERE name IN (
  'gc cr blocks received',
  'gc current blocks received',
  'gc cr block receive time',
  'gc current block receive time'
);
\`\`\`

Calculate average transfer time: \`gc cr block receive time\` / \`gc cr blocks received\` gives milliseconds per block. Under 5ms is normal. Over 15ms indicates interconnect congestion or a hot-block problem between instances.

### Finding Hot Objects Driving Interconnect Traffic

\`\`\`sql
SELECT o.object_name, o.object_type, o.owner,
       SUM(s.value) gc_waits
FROM v$segment_statistics s
JOIN dba_objects o ON s.obj# = o.object_id
WHERE s.statistic_name = 'gc buffer busy acquire'
  AND s.value > 0
GROUP BY o.object_name, o.object_type, o.owner
ORDER BY gc_waits DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

## CRS Not Starting After Reboot

The diagnostic path starts with the CRS trace log:

\`\`\`bash
# CRS trace log location
ls -lt /u01/app/grid/diag/crs/$(hostname)/crs/trace/

# Scan recent entries for errors
grep -i "error\|fatal\|fail" \
  /u01/app/grid/diag/crs/$(hostname)/crs/trace/ocssd.trc | tail -50
\`\`\`

### Voting Disk Not Reachable

The most common post-reboot CRS failure is the voting disk timing out:

\`\`\`bash
# Check voting disk configuration and current accessibility
crsctl query css votedisk

# Output format:
# 0.     STATE:Online   LABEL:VOTE1   DGNAME:OCR   DEVPATH:/dev/sdc
# A state of "Offline" or timeout errors means storage is the problem
\`\`\`

Fix the storage path (SAN zoning, multipath device, NFS mount) before trying to start CRS again.

### Starting CRS Manually

\`\`\`bash
# OL7+ (systemd-based)
systemctl start ohas

# OL6 and earlier (init.d-based)
/etc/init.d/ohasd start

# Verify CRS started successfully
crsctl check crs
\`\`\`

### Disk Timeout Tuning

If your storage has higher latency (SAN over a busy fabric, or cloud block storage), the default disk timeout may be too short:

\`\`\`bash
# Check current disk timeout (seconds before a node is considered dead)
crsctl get css disktimeout
# Default: 200

# Check misscount (seconds a node can miss a heartbeat before eviction)
crsctl get css misscount
# Default: 30
\`\`\`

Increasing these delays eviction — which can be dangerous. Change only with Oracle Support guidance.

## Node Eviction — Why It Happens

Node eviction (a node forcibly rebooted by the cluster) happens because the surviving nodes cannot confirm the evicted node is alive, and a split-brain scenario would risk data corruption. It is not a crash — it is a deliberate safety mechanism.

The root cause is always in \`ocssd.trc\` on the surviving node:

\`\`\`bash
grep -A 5 "evict\|reconfig\|EVICTION" \
  /u01/app/grid/diag/crs/$(hostname)/crs/trace/ocssd.trc | tail -100
\`\`\`

### Network Flap vs Storage Delay

- **Network flap**: ocssd.trc shows missed private-network heartbeats. Check NIC bonding status (\`cat /proc/net/bonding/bond1\`) and switch port error counters (\`ethtool -S eth1 | grep error\`).
- **Storage delay**: ocssd.trc shows voting disk I/O timing out. Check storage latency (\`iostat -x 2 10\`) and SAN fabric error logs.
- **Both combined**: storage I/O pressure causing network congestion — common in environments where storage and interconnect share the same physical NICs.

A node that reboots itself shows \`Node is being evicted\` in its own \`ocssd.trc\` just before reboot — it could not reach the voting disk within the disk timeout and self-evicted to prevent corruption.

## Resource Management and srvctl

Use \`srvctl\` for managing database instances and services in RAC. It keeps the CRS resource model consistent. Using \`sqlplus / as sysdba\` to shut down an instance directly bypasses CRS and leaves resources in a stale state.

\`\`\`bash
# Start a specific instance
srvctl start instance -d MYDB -i MYDB2

# Stop a specific instance cleanly
srvctl stop instance -d MYDB -i MYDB1 -o immediate

# Relocate a service from MYDB1 to MYDB2
srvctl relocate service -d MYDB -s myservice -i MYDB1 -t MYDB2

# Check service status
srvctl status service -d MYDB -s myservice

# Stop the entire database across all nodes
srvctl stop database -d MYDB -o immediate
\`\`\`

Use \`crsctl stop crs\` only when you need to bring down the entire CRS stack for OS maintenance — it also stops ASM, VIPs, and all cluster resources on that node.

## ASM and Disk Group Issues in RAC

\`\`\`sql
-- Connect to ASM instance: sqlplus / as sysasm
SELECT name, state, type,
       ROUND(total_mb/1024, 1) total_gb,
       ROUND(free_mb/1024, 1) free_gb,
       ROUND((total_mb - free_mb) * 100.0 / total_mb, 1) pct_used
FROM v$asm_diskgroup
ORDER BY name;
\`\`\`

From the OS on any RAC node:

\`\`\`bash
# List disk groups and their state
asmcmd lsdg

# Check individual disk health
asmcmd lsdsk -G DATA --discovery
\`\`\`

### Adding a Disk and Rebalancing

\`\`\`sql
-- Add a disk to the DATA disk group
ALTER DISKGROUP DATA ADD DISK '/dev/sde' NAME DATA_0004;

-- Rebalance at power level 4 (1=slow, 11=max speed)
ALTER DISKGROUP DATA REBALANCE POWER 4;

-- Monitor rebalance progress
SELECT group_number, operation, state, power, sofar, est_work, est_rate, est_minutes
FROM v$asm_operation
WHERE operation = 'REBAL';
\`\`\`

Schedule rebalance for low-usage windows — it competes with I/O from all instances sharing the disk group.
`;

const DATAGUARD_CONTENT = `
## Pre-Switchover Checks — Never Skip These

Verify the configuration is healthy on both primary and standby before initiating any role change. A switchover that fails midway is more disruptive than the planned maintenance.

### Check Database Role and Switchover Readiness

\`\`\`sql
-- Run on primary
SELECT db_unique_name, database_role, switchover_status,
       protection_mode, protection_level
FROM v$database;
\`\`\`

\`switchover_status\` must be \`TO STANDBY\` before you can proceed. If it shows \`SESSIONS ACTIVE\`, active sessions are blocking the role change — either wait for them to complete or kill them. If it shows \`NOT ALLOWED\`, the standby has not acknowledged the primary's redo transport.

### Verify Redo Apply on the Standby

\`\`\`sql
-- Run on standby
SELECT process, status, sequence#, block#, blocks
FROM v$managed_standby
WHERE process LIKE 'MRP%';
\`\`\`

MRP should show \`APPLYING_LOG\`. If it shows \`WAIT_FOR_LOG\`, the standby is waiting for redo that has not arrived — check the transport configuration.

### Check for a Sequence Gap

\`\`\`sql
-- On primary: last archived sequence
SELECT MAX(sequence#) last_archived
FROM v$archived_log
WHERE dest_id = 1 AND standby_dest = 'NO';

-- On standby: last applied sequence
SELECT MAX(sequence#) last_applied
FROM v$archived_log
WHERE applied = 'YES';
\`\`\`

A gap of 0–2 is normal (in-flight redo). A larger gap means the standby is behind — let it catch up before switching over.

### DGMGRL Validation

\`\`\`
dgmgrl /
DGMGRL> VALIDATE DATABASE VERBOSE <standby_db_unique_name>;
\`\`\`

Look for \`ERROR\` or \`WARNING\` lines in the output. Any \`WARNING: Apply lag is X minutes\` must be resolved before a clean switchover.

## DGMGRL Switchover (Preferred Method)

\`\`\`bash
# Connect to DGMGRL on the primary host as oracle OS user
dgmgrl /
\`\`\`

\`\`\`
DGMGRL> SHOW CONFIGURATION;
-- Verify all databases show SUCCESS or WARNING (not DISABLED or ERROR)

DGMGRL> SWITCHOVER TO <standby_db_unique_name>;
-- Progress messages:
-- Performing switchover NOW, please wait...
-- Operation requires a connection to instance "STANDBY1" on database "STDBY"
-- Switchover processing complete.

DGMGRL> SHOW CONFIGURATION;
-- Former standby should now show "Primary database"
-- Former primary should show "Physical standby database"
\`\`\`

After switchover completes, applications need to reconnect to the new primary. If using a SCAN listener or service-based connection, this happens automatically.

## SQL Switchover Without Broker

Use this path if you are not using the Data Guard broker (\`dg_broker_start=FALSE\`).

\`\`\`sql
-- Step 1: On the PRIMARY — commit to standby role
-- SESSIONS ACTIVE clause lets Oracle drain sessions; WITH SESSION SHUTDOWN
-- forces immediate session termination if needed
ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY WITH SESSION SHUTDOWN;
\`\`\`

\`\`\`sql
-- Step 2: On the STANDBY — commit to primary role
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;

-- Step 3: Open the new primary
ALTER DATABASE OPEN;
\`\`\`

\`\`\`sql
-- Step 4: Back on the former primary (now the new standby) —
-- mount it and start redo apply
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

Update \`LOG_ARCHIVE_DEST_n\` in the new primary's spfile to point at the new standby's TNS alias if needed.

## Failover — Primary Is Lost

Failover is a one-way operation: the primary is declared dead and the standby takes over. Do not failover on a network blip. Confirm the primary is genuinely unreachable from at least two independent paths before proceeding.

### DGMGRL Failover

\`\`\`
DGMGRL> FAILOVER TO <standby_db_unique_name>;
\`\`\`

Without \`IMMEDIATE\`, DGMGRL tries to flush any unsent redo from the primary first — this minimises data loss but requires the primary to be reachable at the network level.

\`\`\`
-- If the primary is completely unreachable (accept potential data loss)
DGMGRL> FAILOVER TO <standby_db_unique_name> IMMEDIATE;
\`\`\`

### SQL Failover Without Broker

\`\`\`sql
-- On the standby: finish applying all received redo
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE FINISH;

-- Verify MRP has stopped (it will stop automatically after FINISH)
SELECT process, status, sequence# FROM v$managed_standby;

-- Convert to primary
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;

-- Open the new primary
ALTER DATABASE OPEN;
\`\`\`

## Reinstating the Old Primary as New Standby

If Flashback Database was enabled on the old primary before the failover, you can convert it to a standby rather than rebuilding from scratch.

\`\`\`sql
-- On the new primary: find the SCN at which the standby became primary
SELECT standby_became_primary_scn FROM v$database;
\`\`\`

\`\`\`sql
-- On the old primary: start in mount mode
STARTUP MOUNT;

-- Flashback to just before the failover point
FLASHBACK DATABASE TO SCN <standby_became_primary_scn>;

-- Convert to physical standby
ALTER DATABASE CONVERT TO PHYSICAL STANDBY;

-- Restart in mount mode and start redo apply
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

The old primary is now a standby receiving redo from the new primary. Optionally re-add it to the broker configuration with \`ADD DATABASE\`.

## Common Switchover and Failover Failures

### ORA-16467: Switchover Target Is Not Synchronized

\`\`\`
ORA-16467: switchover target is not synchronized with the primary database
\`\`\`

The standby has an apply lag. Query the lag:

\`\`\`sql
SELECT name, value, unit, time_computed
FROM v$dataguard_stats
WHERE name IN ('apply lag', 'transport lag');
\`\`\`

Wait for the apply lag to reach zero, or diagnose why the standby cannot catch up (archive log destination full, MRP crashed, network congestion).

### ORA-16472: Flashback Database Required

\`\`\`
ORA-16472: feature requires Flashback Database to be enabled
\`\`\`

The broker is configured for automatic reinstatement after failover, which requires Flashback Database. Enable it before the next failover:

\`\`\`sql
-- On both databases (in mount mode)
ALTER DATABASE FLASHBACK ON;
ALTER DATABASE OPEN;
\`\`\`

### Switchover Hangs at SESSIONS ACTIVE

\`\`\`sql
-- Find and kill active sessions blocking the switchover
SELECT sid, serial#, username, status, program, machine
FROM v$session
WHERE status = 'ACTIVE'
  AND username IS NOT NULL
  AND username NOT IN ('SYS','SYSTEM')
ORDER BY last_call_et DESC;

ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE;
\`\`\`

Then retry the switchover. If a high-volume OLTP application is holding sessions open, coordinate with the application team to drain connections to the primary before initiating the role change.
`;

const EBS_PERF_CONTENT = `
## Diagnosing Slow EBS — Where to Start

When EBS is slow, the first split is: database tier or application tier?

Run this on the DB tier to see what SQL is consuming CPU right now:

\`\`\`sql
SELECT sql_id,
       ROUND(cpu_time / 1000000, 1) cpu_secs,
       executions,
       ROUND(cpu_time / 1000000 / NULLIF(executions, 0), 3) cpu_per_exec,
       SUBSTR(sql_text, 1, 80) sql_preview
FROM v$sql
WHERE executions > 0
  AND parsing_schema_name IN ('APPS', 'APPLSYS')
ORDER BY cpu_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

If the top SQL are business-logic queries (AP, AR, GL tables), the problem is in the database. If the DB is idle but EBS is slow, look at WebLogic JVM heap, OHS/OPMN, or the Forms server.

### Concurrent Request Performance Baseline

\`\`\`sql
SELECT user_concurrent_program_name,
       ROUND(AVG((actual_completion_date - actual_start_date) * 24 * 60), 1) avg_mins,
       ROUND(MAX((actual_completion_date - actual_start_date) * 24 * 60), 1) max_mins,
       COUNT(*) runs
FROM fnd_concurrent_requests_vl
WHERE phase_code = 'C' AND status_code = 'C'
  AND actual_start_date > SYSDATE - 7
GROUP BY user_concurrent_program_name
HAVING COUNT(*) > 5
ORDER BY avg_mins DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Run this weekly and store the results. When performance regresses, compare the current numbers against your baseline to identify which specific programs degraded and by how much.

## Concurrent Manager Queue Sizing

Undersized CM queues create a pending backlog: submitted requests sit in PENDING phase while the target queue is saturated at max_processes.

\`\`\`sql
SELECT concurrent_queue_name, user_concurrent_queue_name,
       running_processes, max_processes, min_processes, enabled_flag
FROM fnd_concurrent_queues_vl
WHERE enabled_flag = 'Y'
ORDER BY running_processes DESC;
\`\`\`

If \`running_processes = max_processes\` consistently during peak hours, the queue is the bottleneck. Increase \`max_processes\` via System Administrator → Concurrent → Manager → Define.

Rule of thumb: for the Standard Manager, set \`max_processes\` to (CPU cores / 4), capped at 20. Beyond 20 concurrent workers, lock contention on \`FND_CONCURRENT_REQUESTS\` starts to limit throughput more than worker count helps.

### Dedicated Queues for Heavy Programs

Batch programs that run 30+ minutes (payroll, inventory costing, COGS recognition) should have dedicated queues so they cannot starve interactive concurrent requests:

\`\`\`sql
-- Find programs running in Standard Manager with long average runtimes
SELECT r.concurrent_program_name,
       p.user_concurrent_program_name,
       COUNT(*) runs,
       ROUND(AVG((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) avg_mins
FROM fnd_concurrent_requests r
JOIN fnd_concurrent_programs_vl p
  ON r.concurrent_program_id = p.concurrent_program_id
WHERE r.actual_start_date > SYSDATE - 30
  AND r.phase_code = 'C' AND r.status_code = 'C'
GROUP BY r.concurrent_program_name, p.user_concurrent_program_name
HAVING AVG((r.actual_completion_date - r.actual_start_date) * 24 * 60) > 30
ORDER BY avg_mins DESC;
\`\`\`

## OPP Bottlenecks

The Output Post Processor generates PDF and formatted output after a concurrent request completes. When OPP falls behind, requests appear to complete in the database but users cannot access output — they sit in PENDING phase with \`phase_code = 'C'\` and status_code = \`'R'\` or \`'Z'\`.

\`\`\`sql
-- Count requests waiting for OPP processing
SELECT COUNT(*) pending_opp
FROM fnd_conc_pp_actions
WHERE status_code = 'P';
\`\`\`

A count above 50 means OPP is behind. Above 200 means users are noticing.

### OPP JVM Heap Size

Check the current OPP service configuration:

\`\`\`sql
SELECT manager_type, user_service_name, developer_parameters
FROM fnd_cp_services
WHERE manager_type = 'OPP';
\`\`\`

Look for \`-Xmx\` in \`developer_parameters\`. The default is \`-Xmx256m\`. For EBS instances generating large PDF reports, increase it to \`-Xmx1024m\`. This is changed in System Administrator → Concurrent → Manager → Service → OPP node → edit the JVM arguments.

Also increase the number of OPP instances from 1 to 3–5 by editing the target processes in the OPP manager definition.

### OPP Process Timeout Profile

The profile \`Concurrent: OPP Process Timeout\` controls how long OPP waits for output generation before giving up. The default is 120 seconds. Increase it to 600 for complex BI Publisher reports:

Navigate to System Administrator → Profile → System → search for \`Concurrent: OPP Process Timeout\`.

## Stuck Requests — Safe Diagnosis and Kill

\`\`\`sql
SELECT request_id, user_concurrent_program_name,
       phase_code, status_code,
       ROUND((SYSDATE - actual_start_date) * 24, 1) running_hours,
       os_process_id, requested_by
FROM fnd_concurrent_requests_vl
WHERE phase_code = 'R'
  AND actual_start_date < SYSDATE - 2/24
ORDER BY running_hours DESC;
\`\`\`

Do not kill the OS process directly without first cancelling in FND — the database request record will remain in Running phase, blocking the queue from processing further requests.

Safe cancellation:

\`\`\`sql
-- Connect as APPS user and cancel the request
EXEC FND_CONCURRENT.CANCEL_REQUEST(:request_id);
COMMIT;
\`\`\`

If the request does not respond to \`CANCEL_REQUEST\` within 5 minutes, kill the OS process using \`os_process_id\` from the query above, then manually close the request record:

\`\`\`sql
UPDATE fnd_concurrent_requests
SET phase_code = 'C',
    status_code = 'D',
    actual_completion_date = SYSDATE
WHERE request_id = :request_id;
COMMIT;
\`\`\`

## WF Mailer Performance Tuning

A growing WF Notification Mailer backlog manifests as users not receiving workflow notifications. Check the backlog:

\`\`\`sql
SELECT COUNT(*), mail_status
FROM wf_notifications
WHERE status = 'OPEN'
GROUP BY mail_status;
\`\`\`

\`MAIL\` status means pending outbound delivery. A count above a few hundred means the mailer is not keeping pace with notification volume.

Tuning parameters in Workflow Administrator → Notification Mailer → Advanced:

- \`PROCESSOR_OUT_THREAD_COUNT\`: default 1; increase to 3–5 for high volume
- \`PROCESSOR_IN_THREAD_COUNT\`: set to 0 unless using inbound email responses
- \`PROCESSOR_TIMEOUT\`: time in seconds each thread waits for the mail server; default 30

For a large backlog, temporarily increase out threads to 10, let the queue drain, then return to the steady-state value.

## FND_STATS — When Stale Statistics Kill CM Performance

EBS ships with its own statistics utility, \`FND_STATS\`, which understands Oracle Applications table structures. Stale statistics on \`FND_CONCURRENT_REQUESTS\` — which can contain millions of rows on a busy system — cause the CM dequeue SQL to use full table scans instead of index lookups.

Check freshness:

\`\`\`sql
SELECT table_name, last_analyzed, num_rows,
       ROUND(SYSDATE - last_analyzed, 0) days_since_analyze
FROM dba_tables
WHERE owner = 'APPS'
  AND table_name IN (
    'FND_CONCURRENT_REQUESTS', 'FND_CONCURRENT_PROCESSES',
    'FND_CONCURRENT_QUEUES', 'WF_NOTIFICATIONS',
    'WF_NOTIFICATION_ATTRIBUTES', 'WF_ITEMS'
  )
ORDER BY days_since_analyze DESC NULLS LAST;
\`\`\`

Anything older than 14 days on a busy EBS instance is a performance risk. Gather stats on the critical tables:

\`\`\`sql
EXEC FND_STATS.GATHER_TABLE_STATS('APPS', 'FND_CONCURRENT_REQUESTS');
EXEC FND_STATS.GATHER_TABLE_STATS('APPS', 'WF_NOTIFICATIONS');
\`\`\`

Schedule the \`Gather Schema Statistics\` concurrent program weekly via the EBS concurrent manager, targeting the APPS schema with ESTIMATE_PERCENT=15. Running it at 100% on multi-million-row tables takes far longer without meaningfully better statistics.
`;

const EBS_OCI_CONTENT = `
## ZDM vs Traditional Rapid Clone — Which to Use

For the database tier, you have two options when moving EBS 12.2 to OCI:

**ZDM (Zero Downtime Migration)**: Best for databases over 2TB or when the maintenance window is under 4 hours. ZDM automates Data Guard setup, redo transport, and the switchover. It requires a dedicated ZDM service host, OCI CLI configured on both source and target, and a more complex setup that takes a day to prepare.

**RMAN to Object Storage**: Right for databases under 500GB, for teams doing their first OCI migration, or when you have a 6–12 hour maintenance window. Full control, no extra software, same process as any RMAN restore.

For the application tier, use rapid clone (\`adpreclone\` + \`adcfgclone\`) in both cases. ZDM handles the database only.

## OCI Prerequisites Specific to EBS

### VCN and Subnet Design

EBS on OCI requires three subnets at minimum:

| Subnet | Type | Key Inbound Ports |
|--------|------|-------------------|
| DB subnet | Private | 1521 (listener), 1526 (RAC secondary) |
| App tier subnet | Private | 7001–7002 (WLS), 8000–8021 (EBS HTTP), 1647 (apps listener), 6701 (OPMN) |
| Load balancer subnet | Public | 443, 80 |

Security list rules must allow the app tier subnet to reach the DB subnet on port 1521. A common mistake is creating the DB system first and adding the security list rule only after the app tier is already deployed and failing to connect.

### Shape Selection

- DB tier: \`VM.Standard2.8\` (16 OCPU, 120GB RAM) as a minimum for databases under 1TB. For I/O-heavy OLTP, \`VM.DenseIO2.8\` provides local NVMe with lower latency.
- App tier: \`VM.Standard2.8\` minimum for EBS 12.2. WebLogic heap alone needs 8–16GB; with OHS, OPMN, Forms, and the concurrent tier all on one node, 120GB RAM fills up quickly.

### Object Storage Bucket

Create the bucket before starting the RMAN backup:

\`\`\`bash
# Create bucket in the correct compartment
oci os bucket create \
  --compartment-id <compartment_ocid> \
  --name ebs-migration-rman \
  --namespace <namespace>
\`\`\`

## DB Tier Migration — RMAN to Object Storage

### Install and Configure OCI CLI on Source

\`\`\`bash
# Install OCI CLI
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Configure credentials
oci setup config
# Enter: user OCID, tenancy OCID, region, path to API signing key
\`\`\`

### Run RMAN Backup and Upload

\`\`\`bash
# Take a compressed backup to local staging area
rman target / << RMAN
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO COMPRESSED BACKUPSET;
BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG
  FORMAT '/backup/rman/ebs_%U.bkp';
RMAN

# Upload to Object Storage (parallel, 10 concurrent uploads)
oci os object bulk-upload \
  --bucket-name ebs-migration-rman \
  --src-dir /backup/rman \
  --parallel-upload-count 10 \
  --namespace <namespace>
\`\`\`

### Restore on the OCI DB System

\`\`\`bash
# Download backup from Object Storage to OCI DB System
oci os object bulk-download \
  --bucket-name ebs-migration-rman \
  --dest-dir /backup/rman \
  --parallel-download-count 10 \
  --namespace <namespace>

# Restore and recover
rman target / << RMAN
RESTORE DATABASE FROM '/backup/rman/';
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
RMAN
\`\`\`

\`\`\`sql
-- Verify the restored database
SELECT name, db_unique_name, open_mode, database_role FROM v$database;
-- open_mode should be READ WRITE
\`\`\`

## App Tier Migration

### Prepare Source App Tier for Clone

\`\`\`bash
# On source DB tier (as oracle user)
export ORACLE_SID=EBSPROD
perl $ORACLE_HOME/appsutil/scripts/${ORACLE_SID}_$(hostname)/adpreclone.pl dbTier

# On source app tier (as applmgr user)
source /u01/install/APPS/EBSapps.env run
perl $AD_TOP/bin/adpreclone.pl appsTier
\`\`\`

### Archive and Transfer to OCI

\`\`\`bash
# Create archive (skip logs and temp files to reduce size)
tar -czf /backup/apps_$(date +%Y%m%d).tar.gz \
  --exclude='*.log' \
  --exclude='*.out' \
  --exclude='$APPL_TOP/*/log' \
  $APPL_TOP $INST_TOP $COMMON_TOP

# Upload to Object Storage
oci os object put \
  --bucket-name ebs-migration-rman \
  --file /backup/apps_$(date +%Y%m%d).tar.gz \
  --name apps_$(date +%Y%m%d).tar.gz

# On OCI compute: download and extract
oci os object get \
  --bucket-name ebs-migration-rman \
  --name apps_$(date +%Y%m%d).tar.gz \
  --file /backup/apps.tar.gz

tar -xzf /backup/apps.tar.gz -C /
\`\`\`

### Run adcfgclone on OCI Compute

\`\`\`bash
cd $COMMON_TOP/clone/bin
perl adcfgclone.pl appsTier
# Runs 30–60 minutes
# Prompts for new app tier hostname, DB connection string, ports
\`\`\`

## Post-Clone Autoconfig for OCI Hostnames

Every EBS service uses hostnames pulled from the context file. After a clone to OCI, all the old source hostnames need to be replaced.

### Update the Context File

Open \`$CONTEXT_FILE\` (found by running \`echo $CONTEXT_FILE\` as applmgr) and update:

- \`s_webentryhost\`: the OCI compute public IP or load balancer hostname
- \`s_webentryurlport\`: 443 for SSL, 8000 for non-SSL
- \`s_login_page\`: full URL to the EBS login page
- \`s_dbhost\`: the OCI DB system private IP or hostname

Then run autoconfig:

\`\`\`bash
perl $AD_TOP/bin/adautocfg.pl
\`\`\`

### Update FND_NODES

\`\`\`sql
-- Check what node names are registered
SELECT node_name, server_address, support_cp, support_web, support_admin
FROM fnd_nodes ORDER BY node_name;

-- Update app tier node to the new OCI compute hostname
UPDATE fnd_nodes
SET node_name = UPPER('<new_oci_compute_hostname>'),
    server_address = '<new_oci_private_ip>'
WHERE node_name = UPPER('<old_source_hostname>');
COMMIT;
\`\`\`

### Bounce All Services and Verify

\`\`\`bash
$ADMIN_SCRIPTS_HOME/adstopall.sh
$ADMIN_SCRIPTS_HOME/adstartall.sh

# Verify EBS login page responds
curl -sk https://<new_hostname>/OA_HTML/AppsLocalLogin.jsp | grep -i "login\|oracle"
\`\`\`

## Common Post-Clone Failures on OCI

### SSL Certificate Errors in OHS

The old SSL wallet references the source hostname. After cloning, regenerate the wallet using Oracle Wallet Manager (\`owm\`), or set \`s_ssl_enabled\` to \`false\` in the context file and re-run autoconfig for a plain HTTP test environment.

### FNDSM Not Starting

FNDSM startup failure after autoconfig almost always means the apps listener hostname in tnsnames.ora still references the old hostname. Check:

\`\`\`bash
grep -i $(hostname) $TNS_ADMIN/tnsnames.ora
# Should show the new OCI hostname; if not, re-run autoconfig after
# verifying s_dbhost and s_appservnode in the context file
\`\`\`

### Reports Servlet 404

Check \`s_reportsserver\` in the context file — it must match the new OCI compute hostname. Update it, re-run autoconfig, and bounce the Reports Server in the WebLogic console.

### WebLogic Managed Servers Not Starting

OCI Security Lists block all inbound ports by default. After migration, verify that the following ports are open within the app tier Security List: 7001 (AdminServer), 7201–7210 (managed servers), 5556 (Node Manager). Without Node Manager connectivity, the AdminServer cannot start managed servers remotely.
`;

const SECURITY_CONTENT = `
## DEFAULT Profile — What Auditors Check First

The DEFAULT profile applies to every user that does not have a custom profile assigned. In most Oracle installations the DEFAULT profile has unlimited or very permissive settings. Auditors always check this first.

\`\`\`sql
SELECT resource_name, limit
FROM dba_profiles
WHERE profile = 'DEFAULT'
ORDER BY resource_name;
\`\`\`

Production minimum settings:

| Parameter | Recommended Value | Why |
|-----------|------------------|-----|
| PASSWORD_LIFE_TIME | 90 | Force quarterly rotation |
| FAILED_LOGIN_ATTEMPTS | 5 | Lock after 5 failures |
| PASSWORD_LOCK_TIME | 1/24 | Lock for 1 hour |
| PASSWORD_REUSE_TIME | 365 | Cannot reuse within 1 year |
| PASSWORD_REUSE_MAX | 10 | Cannot reuse last 10 passwords |
| PASSWORD_GRACE_TIME | 7 | 7-day warning before expiry |

Apply them:

\`\`\`sql
ALTER PROFILE DEFAULT LIMIT
  PASSWORD_LIFE_TIME       90
  FAILED_LOGIN_ATTEMPTS    5
  PASSWORD_LOCK_TIME       1/24
  PASSWORD_REUSE_TIME      365
  PASSWORD_REUSE_MAX       10
  PASSWORD_GRACE_TIME      7;
\`\`\`

Leave \`SESSIONS_PER_USER\` as \`UNLIMITED\` for application schema owners (APPS, HR, etc.) — connection pools open many sessions under the same database user and a hard cap will break the application.

## Locking Unused Default Accounts

Oracle ships with dozens of default accounts. Any account that is unlocked and not actively managed is a potential entry point — default passwords are documented in Oracle's own manuals.

\`\`\`sql
SELECT username, account_status, last_login, created
FROM dba_users
WHERE account_status NOT LIKE '%LOCKED%'
  AND username NOT IN (
    'SYS', 'SYSTEM', 'DBSNMP', 'DBSFWUSER',
    'APPQOSSYS', 'GSMADMIN_INTERNAL',
    'APPS', 'APPLSYS', 'APPLTMP'
  )
ORDER BY last_login DESC NULLS LAST;
\`\`\`

Lock and expire any account not needed for your application:

\`\`\`sql
ALTER USER OUTLN        ACCOUNT LOCK PASSWORD EXPIRE;
ALTER USER ANONYMOUS    ACCOUNT LOCK PASSWORD EXPIRE;
ALTER USER SCOTT        ACCOUNT LOCK PASSWORD EXPIRE;
ALTER USER MDDATA       ACCOUNT LOCK PASSWORD EXPIRE;
ALTER USER SPATIAL_WFS_ADMIN_USR ACCOUNT LOCK PASSWORD EXPIRE;
\`\`\`

Do not lock SYS or SYSTEM directly — Oracle does not support that. Ensure SYS only connects \`AS SYSDBA\` and that \`REMOTE_LOGIN_PASSWORDFILE\` is set to \`EXCLUSIVE\` or \`SHARED\`, not \`NONE\`.

## Privilege Review — Queries Auditors Always Run

### Excessive System Privileges

\`\`\`sql
SELECT grantee, privilege, admin_option
FROM dba_sys_privs
WHERE privilege IN (
  'CREATE ANY TABLE',   'DROP ANY TABLE',   'ALTER ANY TABLE',
  'EXECUTE ANY PROCEDURE', 'SELECT ANY TABLE', 'DELETE ANY TABLE',
  'CREATE ANY PROCEDURE', 'DROP ANY PROCEDURE', 'ALTER ANY PROCEDURE',
  'BECOME USER', 'ALTER SYSTEM', 'ALTER DATABASE'
)
  AND grantee NOT IN (
    'SYS', 'SYSTEM', 'DBA', 'IMP_FULL_DATABASE',
    'EXP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE',
    'DATAPUMP_EXP_FULL_DATABASE', 'ORACLE_OCM'
  )
ORDER BY grantee, privilege;
\`\`\`

Any non-DBA application user holding \`SELECT ANY TABLE\` can read SYS.USER$ and every business table in the database. This should exist nowhere on a production system.

### PUBLIC Grants (Frequently Overlooked)

\`\`\`sql
SELECT owner, table_name, privilege, grantable
FROM dba_tab_privs
WHERE grantee = 'PUBLIC'
  AND owner NOT IN ('SYS', 'PUBLIC', 'XDB')
ORDER BY owner, table_name;
\`\`\`

Every current and future database user inherits grants to PUBLIC. An EXECUTE grant on a business application procedure granted to PUBLIC is almost certainly a mistake — every DBA, developer, and read-only monitoring user gains that privilege automatically.

### Users with DBA Role

\`\`\`sql
SELECT grantee, admin_option, default_role
FROM dba_role_privs
WHERE granted_role = 'DBA'
  AND grantee NOT IN ('SYS', 'SYSTEM')
ORDER BY grantee;
\`\`\`

The DBA role grants nearly unlimited database access. In most production databases, only SYS and SYSTEM should have it. Application schema owners should hold specific object privileges, not the DBA role.

## Unified Auditing (12c+)

### Check If Unified Auditing Is Active

\`\`\`sql
SELECT value FROM v$option WHERE parameter = 'Unified Auditing';
-- TRUE  = pure unified or mixed mode (12c+ with recompile)
-- FALSE = traditional audit tables only (pre-12c behavior)
\`\`\`

In 12c mixed mode, both traditional (\`aud$\`) and unified audit records are written. Pure unified auditing requires recompiling the Oracle binary — most sites stay in mixed mode.

### Create and Enable an Audit Policy

\`\`\`sql
-- Audit DDL on privileged operations and DML on sensitive tables
CREATE AUDIT POLICY prod_security_ops
  ACTIONS
    DELETE ON hr.employees,
    UPDATE ON hr.employees,
    DELETE ON ar.ra_customer_trx_all
  PRIVILEGES
    CREATE USER, DROP USER, ALTER USER,
    CREATE ROLE, DROP ROLE,
    GRANT ANY PRIVILEGE, REVOKE ANY PRIVILEGE;

AUDIT POLICY prod_security_ops;
\`\`\`

To limit noise, audit only specific users rather than all sessions:

\`\`\`sql
AUDIT POLICY prod_security_ops BY dba_admin, hr_super_user;
\`\`\`

### Query the Unified Audit Trail

\`\`\`sql
SELECT dbusername, action_name, object_schema, object_name,
       sql_text,
       TO_CHAR(event_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') event_utc,
       unified_audit_policies
FROM unified_audit_trail
WHERE event_timestamp > SYSTIMESTAMP - INTERVAL '1' DAY
  AND dbusername NOT IN ('SYS', 'DBSNMP')
ORDER BY event_timestamp DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

Purge the audit trail using \`DBMS_AUDIT_MGMT\` — do not delete from \`UNIFIED_AUDIT_TRAIL\` directly, it is a view over a secured LOB in the AUDSYS schema.

## Network Encryption

Without network encryption, credentials and query results travel in plaintext over the network. Configure both server and client \`sqlnet.ora\`:

\`\`\`
# $ORACLE_HOME/network/admin/sqlnet.ora (server-side)
SQLNET.ENCRYPTION_SERVER = REQUIRED
SQLNET.ENCRYPTION_TYPES_SERVER = (AES256, AES192, AES128)
SQLNET.CRYPTO_CHECKSUM_SERVER = REQUIRED
SQLNET.CRYPTO_CHECKSUM_TYPES_SERVER = (SHA256)
\`\`\`

Setting \`REQUIRED\` on the server means any client that does not support encryption will be refused. Use \`REQUESTED\` if you have legacy clients you cannot update yet.

Verify a session is encrypted after connecting:

\`\`\`sql
SELECT network_service_banner
FROM v$session_connect_info
WHERE sid = SYS_CONTEXT('USERENV', 'SID')
  AND network_service_banner LIKE '%Encryption%';
\`\`\`

If this query returns no rows, the connection is not encrypted. The client \`sqlnet.ora\` is either missing or has \`SQLNET.ENCRYPTION_CLIENT = REJECTED\`.

## Password Verification Function

Without a verification function, Oracle does not enforce password complexity. A user can set their password to \`password1\` and the database accepts it.

Assign Oracle's built-in strong verification function:

\`\`\`sql
ALTER PROFILE DEFAULT LIMIT
  PASSWORD_VERIFY_FUNCTION ora12c_strong_verify_function;
\`\`\`

\`ora12c_strong_verify_function\` (defined in \`$ORACLE_HOME/rdbms/admin/utlpwdmg.sql\`) enforces: minimum 8 characters, at least one letter and one digit, differs from username, differs from old password by at least 3 characters.

For stricter requirements, create a custom function:

\`\`\`sql
CREATE OR REPLACE FUNCTION custom_pwd_verify(
  username     VARCHAR2,
  password     VARCHAR2,
  old_password VARCHAR2
) RETURN BOOLEAN AS
BEGIN
  IF LENGTH(password) < 12 THEN
    RAISE_APPLICATION_ERROR(-20001, 'Password must be at least 12 characters');
  END IF;
  IF REGEXP_INSTR(password, '[A-Z]') = 0 THEN
    RAISE_APPLICATION_ERROR(-20002, 'Password must contain at least one uppercase letter');
  END IF;
  IF REGEXP_INSTR(password, '[0-9]') = 0 THEN
    RAISE_APPLICATION_ERROR(-20003, 'Password must contain at least one digit');
  END IF;
  IF REGEXP_INSTR(password, '[^A-Za-z0-9]') = 0 THEN
    RAISE_APPLICATION_ERROR(-20004, 'Password must contain at least one special character');
  END IF;
  RETURN TRUE;
END;
/

ALTER PROFILE DEFAULT LIMIT PASSWORD_VERIFY_FUNCTION custom_pwd_verify;
\`\`\`

Test after applying:

\`\`\`sql
-- This should raise ORA-28003 with your custom message
ALTER USER testuser IDENTIFIED BY short;

-- This should succeed
ALTER USER testuser IDENTIFIED BY "Str0ng!Pass#2026";
\`\`\`
`;

const ARTICLES = [
  { title: 'Oracle ZDM — Zero Downtime Migration: Architecture, Setup, and Execution', slug: 'oracle-zdm-zero-downtime-migration', excerpt: 'A production-tested guide to Oracle ZDM: architecture overview, prerequisites, response file parameters, migration phases, monitoring with zdmcli, and the fixes for the failures you will actually encounter.', content: ZDM_CONTENT.trim(), published_at: '2025-05-10', read_time_minutes: 18, coming_soon: false },
  { title: 'Oracle Database Performance Crisis: Triage, Analysis, and Resolution', slug: 'oracle-database-performance-crisis', excerpt: 'Load average 120, 247 active sessions, users calling. A step-by-step methodology for diagnosing and resolving an Oracle performance crisis — from first OS command to root cause analysis.', content: PERF_CRISIS_CONTENT.trim(), published_at: '2024-04-22', read_time_minutes: 16, coming_soon: false },
  { title: 'EBS 12.2 Cloning Procedure — Complete Steps with Commands', slug: 'ebs-122-cloning-procedure', excerpt: 'The complete EBS 12.2 cloning procedure: pre-clone on both tiers, adcfgclone configuration, post-clone validation, and fixes for the failures that actually happen in practice.', content: EBS_CLONE_CONTENT.trim(), published_at: '2017-08-15', read_time_minutes: 14, coming_soon: false },
  { title: 'EBS 12.2 ADOP Patching — Common Failures and How to Fix Them', slug: 'ebs-12-2-adop-patching-failures', excerpt: 'The ADOP patch cycle failures you will hit in EBS 12.2: cutover timeouts, prepare phase hangs, session cleanup errors, and how to recover from each without starting over.', content: ADOP_CONTENT.trim(), published_at: '2026-01-15', read_time_minutes: 14, coming_soon: false },
  { title: 'Oracle RAC Troubleshooting — Interconnect, Voting Disk, and CRS', slug: 'oracle-rac-troubleshooting', excerpt: 'Diagnosing Oracle RAC issues: interconnect performance problems, voting disk failures, CRS evictions, and the OS-level tools that actually tell you what is happening.', content: RAC_CONTENT.trim(), published_at: '2026-02-01', read_time_minutes: 15, coming_soon: false },
  { title: 'Oracle Data Guard — Switchover and Failover Procedures', slug: 'oracle-data-guard-switchover-failover', excerpt: 'Step-by-step Data Guard switchover and failover procedures with the DGMGRL commands and SQL, verification steps, and how to recover when the switchover does not complete cleanly.', content: DATAGUARD_CONTENT.trim(), published_at: '2026-02-15', read_time_minutes: 13, coming_soon: false },
  { title: 'EBS Performance Tuning — CM Queue Management, OPP, and WF Mailer', slug: 'ebs-performance-tuning-cm-opp-wf', excerpt: 'The practical EBS performance levers that actually matter: sizing Concurrent Manager queues, diagnosing OPP bottlenecks, fixing stuck WF Mailer, and SQL tuning for FND tables.', content: EBS_PERF_CONTENT.trim(), published_at: '2026-03-01', read_time_minutes: 12, coming_soon: false },
  { title: 'Oracle Tablespace Management — Autoextend, Monitoring, and Alerts', slug: 'oracle-tablespace-management', excerpt: 'When to use autoextend vs fixed-size datafiles, how to monitor tablespace growth trends, and the SQL scripts to alert before you hit a full tablespace in production.', content: TABLESPACE_MGMT_CONTENT.trim(), published_at: '2026-03-15', read_time_minutes: 12, coming_soon: false },
  { title: 'Oracle AWR and ASH — Reading Reports Like a Senior DBA', slug: 'oracle-awr-ash-analysis', excerpt: 'How to read an AWR report without getting lost in the noise: the six sections that matter, what DB Time tells you, how to interpret top wait events, and using ASH to drill into a specific window.', content: AWR_ASH_CONTENT.trim(), published_at: '2026-04-01', read_time_minutes: 14, coming_soon: false },
  { title: 'EBS Cloning to OCI — Lift and Shift with ZDM and Rapid Clone', slug: 'ebs-cloning-to-oci', excerpt: 'Moving EBS 12.2 to Oracle Cloud Infrastructure: choosing between ZDM physical migration and traditional clone, the networking prerequisites, and the EBS-specific post-migration steps.', content: EBS_OCI_CONTENT.trim(), published_at: '2026-04-15', read_time_minutes: 16, coming_soon: false },
  { title: 'Oracle 19c Upgrade from 12c — Step by Step', slug: 'oracle-19c-upgrade-from-12c', excerpt: 'The complete Oracle 12.1/12.2 to 19c upgrade path: pre-upgrade checks, AutoUpgrade tool, post-upgrade tasks, and the compatibility issues to anticipate before you start.', content: UPGRADE_19C_CONTENT.trim(), published_at: '2026-05-01', read_time_minutes: 15, coming_soon: false },
  { title: 'Oracle Security Hardening — Profiles, Auditing, and Privilege Reviews', slug: 'oracle-security-hardening', excerpt: 'Production Oracle security hardening: configuring the DEFAULT profile, implementing unified auditing, reviewing excessive privileges with DBA_SYS_PRIVS, and the checks auditors always ask for.', content: SECURITY_CONTENT.trim(), published_at: '2026-05-15', read_time_minutes: 12, coming_soon: false },
];

async function run() {
  const client = await pool.connect();
  try {
    // 1. Add coming_soon column if missing
    await client.query(`
      ALTER TABLE blog_posts
        ADD COLUMN IF NOT EXISTS coming_soon BOOLEAN NOT NULL DEFAULT FALSE
    `);
    console.log('✓ coming_soon column ensured');

    // 2. Upsert each article — does not require updated_at column
    let inserted = 0, updated = 0;
    for (const a of ARTICLES) {
      // Check if slug exists
      const exists = await client.query('SELECT id FROM blog_posts WHERE slug = $1', [a.slug]);
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO blog_posts (title, slug, excerpt, content, author, published_at, read_time_minutes, coming_soon)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)`,
          [a.title, a.slug, a.excerpt, a.content, AUTHOR, a.published_at, a.read_time_minutes, a.coming_soon]
        );
        console.log(`  + inserted: ${a.slug}`);
        inserted++;
      } else {
        await client.query(
          `UPDATE blog_posts SET
             title = $1, excerpt = $2, content = $3, author = $4,
             published_at = $5::date, read_time_minutes = $6, coming_soon = $7
           WHERE slug = $8`,
          [a.title, a.excerpt, a.content, AUTHOR, a.published_at, a.read_time_minutes, a.coming_soon, a.slug]
        );
        console.log(`  ~ updated:  ${a.slug}`);
        updated++;
      }
    }

    // 3. Verify
    const result = await client.query(
      `SELECT slug, coming_soon FROM blog_posts
       WHERE COALESCE(seo_noindex, false) = false
       ORDER BY COALESCE(coming_soon, false), published_at DESC`
    );
    console.log(`\n✓ Done — ${inserted} inserted, ${updated} updated`);
    console.log(`\nAll visible articles (${result.rows.length}):`);
    result.rows.forEach(r => {
      console.log(`  ${r.coming_soon ? '[stub]' : '[full]'} ${r.slug}`);
    });
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
