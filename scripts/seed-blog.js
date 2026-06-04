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

const ARTICLES = [
  { title: 'Oracle ZDM — Zero Downtime Migration: Architecture, Setup, and Execution', slug: 'oracle-zdm-zero-downtime-migration', excerpt: 'A production-tested guide to Oracle ZDM: architecture overview, prerequisites, response file parameters, migration phases, monitoring with zdmcli, and the fixes for the failures you will actually encounter.', content: ZDM_CONTENT.trim(), published_at: '2025-05-10', read_time_minutes: 18, coming_soon: false },
  { title: 'Oracle Database Performance Crisis: Triage, Analysis, and Resolution', slug: 'oracle-database-performance-crisis', excerpt: 'Load average 120, 247 active sessions, users calling. A step-by-step methodology for diagnosing and resolving an Oracle performance crisis — from first OS command to root cause analysis.', content: PERF_CRISIS_CONTENT.trim(), published_at: '2024-04-22', read_time_minutes: 16, coming_soon: false },
  { title: 'EBS 12.2 Cloning Procedure — Complete Steps with Commands', slug: 'ebs-122-cloning-procedure', excerpt: 'The complete EBS 12.2 cloning procedure: pre-clone on both tiers, adcfgclone configuration, post-clone validation, and fixes for the failures that actually happen in practice.', content: EBS_CLONE_CONTENT.trim(), published_at: '2017-08-15', read_time_minutes: 14, coming_soon: false },
  { title: 'EBS 12.2 ADOP Patching — Common Failures and How to Fix Them', slug: 'ebs-12-2-adop-patching-failures', excerpt: 'The ADOP patch cycle failures you will hit in EBS 12.2: cutover timeouts, prepare phase hangs, session cleanup errors, and how to recover from each without starting over.', content: stubContent(['adop phase=prepare', 'cutover timeouts', 'session cleanup', 'fs_clone', 'adop phase=abort', 'recovery procedures']), published_at: '2026-01-15', read_time_minutes: 14, coming_soon: true },
  { title: 'Oracle RAC Troubleshooting — Interconnect, Voting Disk, and CRS', slug: 'oracle-rac-troubleshooting', excerpt: 'Diagnosing Oracle RAC issues: interconnect performance problems, voting disk failures, CRS evictions, and the OS-level tools that actually tell you what is happening.', content: stubContent(['cluster interconnect diagnosis', 'ocrcheck', 'crsctl commands', 'voting disk recovery', 'node eviction analysis']), published_at: '2026-02-01', read_time_minutes: 15, coming_soon: true },
  { title: 'Oracle Data Guard — Switchover and Failover Procedures', slug: 'oracle-data-guard-switchover-failover', excerpt: 'Step-by-step Data Guard switchover and failover procedures with the DGMGRL commands and SQL, verification steps, and how to recover when the switchover does not complete cleanly.', content: stubContent(['dgmgrl commands', 'switchover procedure', 'failover procedure', 'verify after switchover', 'flashback database recovery']), published_at: '2026-02-15', read_time_minutes: 13, coming_soon: true },
  { title: 'EBS Performance Tuning — CM Queue Management, OPP, and WF Mailer', slug: 'ebs-performance-tuning-cm-opp-wf', excerpt: 'The practical EBS performance levers that actually matter: sizing Concurrent Manager queues, diagnosing OPP bottlenecks, fixing stuck WF Mailer, and SQL tuning for FND tables.', content: stubContent(['FND_CONCURRENT_QUEUES tuning', 'OPP configuration', 'WF_MAILER diagnosis', 'FND_STATS gather']), published_at: '2026-03-01', read_time_minutes: 12, coming_soon: true },
  { title: 'Oracle Tablespace Management — Autoextend, Monitoring, and Alerts', slug: 'oracle-tablespace-management', excerpt: 'When to use autoextend vs fixed-size datafiles, how to monitor tablespace growth trends, and the SQL scripts to alert before you hit a full tablespace in production.', content: stubContent(['autoextend vs fixed sizing', 'growth rate projection SQL', 'bigfile tablespaces', 'UNDO and TEMP sizing', 'alert thresholds']), published_at: '2026-03-15', read_time_minutes: 10, coming_soon: true },
  { title: 'Oracle AWR and ASH — Reading Reports Like a Senior DBA', slug: 'oracle-awr-ash-analysis', excerpt: 'How to read an AWR report without getting lost in the noise: the six sections that matter, what DB Time tells you, how to interpret top wait events, and using ASH to drill into a specific window.', content: stubContent(['AWR report structure', 'DB Time interpretation', 'Top 5 Timed Events', 'SQL ordered by CPU', 'ASH drill-down']), published_at: '2026-04-01', read_time_minutes: 14, coming_soon: true },
  { title: 'EBS Cloning to OCI — Lift and Shift with ZDM and Rapid Clone', slug: 'ebs-cloning-to-oci', excerpt: 'Moving EBS 12.2 to Oracle Cloud Infrastructure: choosing between ZDM physical migration and traditional clone, the networking prerequisites, and the EBS-specific post-migration steps.', content: stubContent(['ZDM vs manual clone', 'OCI DB provisioning', 'VCN and subnet setup', 'EBS autoconfig for cloud hostnames']), published_at: '2026-04-15', read_time_minutes: 16, coming_soon: true },
  { title: 'Oracle 19c Upgrade from 12c — Step by Step', slug: 'oracle-19c-upgrade-from-12c', excerpt: 'The complete Oracle 12.1/12.2 to 19c upgrade path: pre-upgrade checks, AutoUpgrade tool, post-upgrade tasks, and the compatibility issues to anticipate before you start.', content: stubContent(['AutoUpgrade tool', 'preupgrade.jar checks', 'invalid object pre-fix', 'timezone update', 'post-upgrade recompile', 'EBS compatibility']), published_at: '2026-05-01', read_time_minutes: 15, coming_soon: true },
  { title: 'Oracle Security Hardening — Profiles, Auditing, and Privilege Reviews', slug: 'oracle-security-hardening', excerpt: 'Production Oracle security hardening: configuring the DEFAULT profile, implementing unified auditing, reviewing excessive privileges with DBA_SYS_PRIVS, and the checks auditors always ask for.', content: stubContent(['DEFAULT profile settings', 'unified auditing', 'DBA_SYS_PRIVS review', 'PUBLIC privilege cleanup', 'password policies']), published_at: '2026-05-15', read_time_minutes: 12, coming_soon: true },
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
