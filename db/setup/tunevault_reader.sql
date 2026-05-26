-- tunevault_reader.sql
-- Canonical least-privilege role for TuneVault monitoring.
--
-- Run this as SYSTEM (or any DBA) on the target Oracle database.
-- TuneVault never asks for SYSDBA unless you explicitly choose the Advanced privilege model.
--
-- What this grants:
--   SELECT_CATALOG_ROLE  — read all DBA_*/ALL_* dictionary views (health checks, space, stats)
--   SELECT ANY DICTIONARY — V$SESSION, V$SQL, V$SQLAREA, V$WAIT_CLASS, GV$ views (RAC)
--   DBMS_WORKLOAD_REPOSITORY EXECUTE — AWR snapshot reads for ADDM
--   DBMS_ADDM EXECUTE — run and read ADDM analysis tasks
--   DBMS_SQLTUNE EXECUTE — SQL Tuning Advisor recommendations
--   DBMS_STATS EXECUTE — read optimizer statistics (no writes needed)
--   DBMS_SQL_MONITOR EXECUTE — Real-Time SQL Monitoring
--   ADVISOR — required to create and read advisor tasks (ADDM, SQL Tuning)
--   V$SESSION/SQL/SQL_PLAN/SQLAREA SELECT — runtime session + SQL inspection
--
-- What this does NOT grant:
--   ALTER SYSTEM, ALTER DATABASE, CREATE ANY TABLE, DROP ANY OBJECT — no writes
--   SYSDBA, SYSOPER — no elevated OS-level access
--   Kill session, RMAN, listener bounce — use the Advanced (OS Auth) model for those
--
-- EBS-specific grants are gated behind the EBS toggle in TuneVault settings.
-- Run the EBS block only if this database hosts Oracle E-Business Suite.

-- ── Step 1: Create the role ──────────────────────────────────────────────────
CREATE ROLE tunevault_reader;

-- ── Step 2: Core grants ───────────────────────────────────────────────────────
GRANT CREATE SESSION TO tunevault_reader;
GRANT SELECT_CATALOG_ROLE TO tunevault_reader;
GRANT SELECT ANY DICTIONARY TO tunevault_reader;

-- AWR + advisor packages (Diagnostics Pack license required for AWR/ADDM on EE)
GRANT EXECUTE ON DBMS_WORKLOAD_REPOSITORY TO tunevault_reader;
GRANT EXECUTE ON DBMS_ADDM TO tunevault_reader;
GRANT EXECUTE ON DBMS_SQLTUNE TO tunevault_reader;
GRANT EXECUTE ON DBMS_STATS TO tunevault_reader;
GRANT EXECUTE ON DBMS_SQL_MONITOR TO tunevault_reader;
GRANT ADVISOR TO tunevault_reader;

-- Dynamic performance views — explicitly grant for non-CDB / older 11g installs
GRANT SELECT ON V_$SESSION TO tunevault_reader;
GRANT SELECT ON V_$SQL TO tunevault_reader;
GRANT SELECT ON V_$SQL_PLAN TO tunevault_reader;
GRANT SELECT ON V_$SQLAREA TO tunevault_reader;

-- ── Step 3: Create the monitoring user ───────────────────────────────────────
CREATE USER tunevault IDENTIFIED BY "<replace-with-strong-password>";
GRANT tunevault_reader TO tunevault;

-- Zero quota — TuneVault never writes to the database
ALTER USER tunevault DEFAULT TABLESPACE USERS QUOTA 0 ON USERS;

-- ── Step 4 (EBS only): Grant APPS schema read access ─────────────────────────
-- Run this block ONLY if this database hosts Oracle E-Business Suite.
-- These grants enable the EBS-specific health checks (CM, WF, concurrent requests, etc.)
--
-- GRANT SELECT ON APPS.FND_CONCURRENT_REQUESTS TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_CONCURRENT_PROGRAMS TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_CONCURRENT_PROGRAMS_TL TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_APPLICATION TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_RESPONSIBILITY TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_USER TO tunevault_reader;
-- GRANT SELECT ON APPS.WF_DEFERRED TO tunevault_reader;
-- GRANT SELECT ON APPS.WF_ERROR TO tunevault_reader;
-- GRANT SELECT ON APPS.AD_BUGS TO tunevault_reader;
-- GRANT SELECT ON APPS.AD_APPLIED_PATCHES TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_NODES TO tunevault_reader;
-- GRANT SELECT ON APPS.FND_OAM_APP_SYS_STATUS TO tunevault_reader;

-- ── Verification ──────────────────────────────────────────────────────────────
-- Run as tunevault to verify access:
--   SELECT COUNT(*) FROM dba_segments;
--   SELECT COUNT(*) FROM v$session;
--   SELECT dbms_metadata.get_ddl('ROLE','TUNEVAULT_READER') FROM dual;
