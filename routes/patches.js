/**
 * routes/patches.js — Patch Advisor: detect current CPU/PSU level, gap analysis,
 * and adop prep→cleanup or OPatch runbook generation.
 *
 * Owns: /api/patches/* and /patches page endpoint.
 *       Reads DBA_REGISTRY_SQLPATCH, DBA_REGISTRY_HISTORY, AD_APPLIED_PATCHES, AD_BUGS.
 *       Emits gap analysis vs data/oracle-patches.json curated index.
 *       Generates copy-pasteable adop or OPatch runbook. Read-only against Oracle DB.
 * Does NOT own: auth state, Oracle connection storage, health check execution,
 *               other tabs' data, or any write operations against Oracle.
 *
 * Mounted at: / (GET /patches page) and /api/patches (API routes) via server.js
 *
 * Routes:
 *   GET /patches
 *     Serve patches.html (auth-gated).
 *   GET /api/patches/advisor/:connectionId
 *     Returns { current_level, gap_analysis, recommended_patches, runbook, is_demo }.
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { getConnectionForPatches, getUserForPatches } = require('../db/patches');
const { decrypt } = require('../crypto-utils');
const sshExecutor = require('../services/ssh-executor');
const sshDb       = require('../db/ssh-targets');

const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ─── Patch index (curated, quarterly refresh) ─────────────────────────────────
// LAST_REFRESHED: 2025-10-15. Next refresh due 2026-01-15.
// Update data/oracle-patches.json each quarter after Oracle CPU release.
const PATCH_INDEX = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'oracle-patches.json'), 'utf8')
);

// ─── Oracle client (lazy-loaded) ─────────────────────────────────────────────

let _oracleClient = null;
function getOracleClient() {
  if (!_oracleClient) {
    try { _oracleClient = require('../oracle-client'); } catch (e) { return null; }
  }
  return _oracleClient;
}

// ─── Oracle queries ───────────────────────────────────────────────────────────

// DBA_REGISTRY_SQLPATCH — 12c+ primary source for CPU/PSU history
const SQL_PATCH_QUERY = `
SELECT patch_id, patch_uid, version, action, status,
       TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI:SS') AS action_time,
       description, bundle_series
FROM   sys.dba_registry_sqlpatch
ORDER  BY action_time DESC
FETCH  FIRST 20 ROWS ONLY`;

// DBA_REGISTRY_HISTORY — legacy fallback for 11g and pre-12c DBs
const REGISTRY_HISTORY_QUERY = `
SELECT action_time, action, namespace, version, id, comments
FROM   sys.dba_registry_history
ORDER  BY action_time DESC
FETCH  FIRST 10 ROWS ONLY`;

// DBA_VERSION — detect RDBMS major version
const VERSION_QUERY = `
SELECT version, version_full FROM v$instance`;

// EBS detection: AD_APPLIED_PATCHES — most recent EBS patch applied
const EBS_PATCH_QUERY = `
SELECT ap.patch_name, ap.patch_type,
       TO_CHAR(ap.creation_date, 'YYYY-MM-DD') AS applied_date,
       ap.maint_pack_name
FROM   apps.ad_applied_patches ap
ORDER  BY ap.creation_date DESC
FETCH  FIRST 10 ROWS ONLY`;

// EBS: ADOP session freshness — last cutover date (fs_clone gauge)
const ADOP_SESSION_QUERY = `
SELECT TO_CHAR(MAX(cutover_time), 'YYYY-MM-DD HH24:MI:SS') AS last_cutover
FROM   apps.ad_adop_sessions
WHERE  prepare_status = 'C'
  AND  cutover_time IS NOT NULL`;

// EBS: ADOP prep-prereq — archive log space
const ARCHIVE_SPACE_QUERY = `
SELECT dest_name,
       ROUND(space_limit / 1073741824, 2) AS limit_gb,
       ROUND(space_used  / 1073741824, 2) AS used_gb,
       ROUND((space_limit - space_used) / 1073741824, 2) AS free_gb,
       ROUND(space_used / NULLIF(space_limit,0) * 100, 1) AS used_pct
FROM   v$recovery_file_dest`;

// INVALID objects baseline count (pre-flight check)
const INVALID_OBJECTS_QUERY = `
SELECT COUNT(*) AS cnt FROM dba_objects WHERE status = 'INVALID'`;

// EBS: Full ADOP session history — last 10 sessions with all phase statuses
const ADOP_SESSION_HISTORY_QUERY = `
SELECT session_id,
       NVL(prepare_status,'N/A') AS prepare_status,
       NVL(apply_status,'N/A')   AS apply_status,
       NVL(finalize_status,'N/A') AS finalize_status,
       NVL(cutover_status,'N/A') AS cutover_status,
       NVL(cleanup_status,'N/A') AS cleanup_status,
       TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI') AS start_date,
       TO_CHAR(cutover_time, 'YYYY-MM-DD HH24:MI') AS cutover_time,
       node_name
FROM   apps.ad_adop_sessions
ORDER  BY start_date DESC
FETCH  FIRST 10 ROWS ONLY`;

// EBS: AD and TXK codelevel from AD_TRACKABLE_ENTITIES
const AD_TXK_CODELEVELS_QUERY = `
SELECT abbreviation, codelevel
FROM   apps.ad_trackable_entities
WHERE  abbreviation IN ('AD','TXK')
ORDER  BY abbreviation`;

// EBS: Latest applied EBS CPU bug numbers from AD_BUGS (pattern match on quarterly CPU bug ranges)
const EBS_CPU_BUGS_QUERY = `
SELECT b.bug_number, b.generic_package_flag,
       TO_CHAR(ap.creation_date, 'YYYY-MM-DD') AS applied_date,
       ap.maint_pack_name
FROM   apps.ad_bugs b
       JOIN apps.ad_patch_run_bugs prb ON prb.bug_id = b.bug_id
       JOIN apps.ad_applied_patches ap  ON ap.applied_patch_id = prb.applied_patch_id
WHERE  b.bug_number IN (
         -- Apr 2026 CPU EBS bundle bugs (KA1539 - illustrative well-known IDs)
         '37765220','37765221','37765222',
         -- Jan 2026 CPU EBS
         '36850778','36850779',
         -- Oct 2025 CPU EBS
         '36404937','36404938',
         -- Jul 2025 CPU EBS
         '36059025',
         -- Apr 2025 CPU EBS
         '35910299'
       )
ORDER  BY ap.creation_date DESC
FETCH  FIRST 5 ROWS ONLY`;

// ─── Version matching helpers ─────────────────────────────────────────────────

/**
 * normaliseVersion — extract the major version key used in PATCH_INDEX.
 * "19.18.0.0.0" → "19c"; "21.x.x" → "21c"; "23.x" → "23ai"; "12.2.x" → "12.2"
 */
function normaliseVersion(versionStr) {
  if (!versionStr) return null;
  const v = String(versionStr).trim();
  if (v.startsWith('23')) return '23ai';
  if (v.startsWith('21')) return '21c';
  if (v.startsWith('19')) return '19c';
  if (v.startsWith('18')) return '18c';
  if (v.startsWith('12.2')) return '12.2';
  if (v.startsWith('12.1')) return '12.1';
  if (v.startsWith('11')) return '11.2';
  return null;
}

/**
 * findAppliedPatch — from the DBA_REGISTRY_SQLPATCH rows, identify the most
 * recently applied CPU/RU patch and its quarter.
 */
function findAppliedPatch(sqlPatchRows) {
  if (!sqlPatchRows || sqlPatchRows.length === 0) return null;
  // Most recent APPLY action that succeeded
  const applied = sqlPatchRows.find(
    r => (r.ACTION || '').toUpperCase() === 'APPLY' &&
         (r.STATUS || '').toUpperCase() !== 'WITH ERRORS'
  );
  return applied || sqlPatchRows[0];
}

/**
 * computeQuartersGap — count CPU quarters between applied quarter and latest known.
 * Quarter format: "2024-Q2"
 */
function computeQuartersGap(appliedQuarter, latestQuarter) {
  if (!appliedQuarter || !latestQuarter) return null;
  const parse = q => {
    const [y, qn] = q.split('-Q');
    return parseInt(y) * 4 + (parseInt(qn) - 1);
  };
  return parse(latestQuarter) - parse(appliedQuarter);
}

// ─── Gap analysis ─────────────────────────────────────────────────────────────

/**
 * buildGapAnalysis — compare detected current patch against index.
 * Returns { current_patch, latest_patch, quarters_behind, missed_cves, severity_summary }
 */
function buildGapAnalysis({ versionKey, appliedPatchId, appliedLabel, appliedDate }) {
  const versionIndex = PATCH_INDEX.rdbms[versionKey];
  if (!versionIndex) {
    return {
      current_patch: { patch_id: appliedPatchId, label: appliedLabel, date: appliedDate },
      latest_patch: null,
      quarters_behind: null,
      missed_cves: [],
      severity_summary: null,
      eol_warning: null,
      message: `No patch index entry for version key "${versionKey}". Index may need refresh.`
    };
  }

  const eolWarning = versionIndex.eol_warning || null;
  const latestPatch = versionIndex.latest_patch;
  const allPatches  = versionIndex.release_update_patches || [];

  // Find which patch in the index the instance is on
  const currentIndexEntry = allPatches.find(
    p => String(p.patch_number) === String(appliedPatchId)
  );

  let appliedQuarter = currentIndexEntry ? currentIndexEntry.cpu_quarter : null;
  let latestQuarter  = versionIndex.latest_quarter;

  const quartersGap = computeQuartersGap(appliedQuarter, latestQuarter);

  // Collect patches newer than applied — these are "missed"
  let missedPatches = [];
  if (currentIndexEntry) {
    const currentIdx = allPatches.findIndex(p => p.patch_number === currentIndexEntry.patch_number);
    // allPatches is newest-first, so [0..currentIdx-1] are newer
    missedPatches = allPatches.slice(0, currentIdx);
  } else if (latestPatch && String(appliedPatchId) !== String(latestPatch)) {
    // Can't place them in order — assume all index patches are candidates
    missedPatches = allPatches;
  }

  const missedCves = [];
  let maxCvss = 0;
  for (const mp of missedPatches) {
    for (const cve of (mp.cves || [])) {
      missedCves.push({ cve, cvss: mp.cvss_max, label: mp.label, patch_number: mp.patch_number, mos_doc_id: mp.mos_doc_id });
    }
    if ((mp.cvss_max || 0) > maxCvss) maxCvss = mp.cvss_max;
  }

  // Sort CVEs by CVSS descending
  missedCves.sort((a, b) => (b.cvss || 0) - (a.cvss || 0));

  let severitySummary = null;
  if (maxCvss >= 9.0) severitySummary = 'CRITICAL';
  else if (maxCvss >= 7.0) severitySummary = 'HIGH';
  else if (maxCvss >= 4.0) severitySummary = 'MEDIUM';
  else if (missedPatches.length > 0) severitySummary = 'LOW';

  return {
    current_patch: {
      patch_id: appliedPatchId,
      label: appliedLabel || currentIndexEntry?.label || `Patch ${appliedPatchId}`,
      date: appliedDate,
      quarter: appliedQuarter
    },
    latest_patch: {
      patch_number: versionIndex.latest_patch,
      label: versionIndex.latest_label,
      date: versionIndex.latest_release_date,
      quarter: latestQuarter
    },
    quarters_behind: quartersGap,
    missed_cves: missedCves,
    missed_patches: missedPatches,
    severity_summary: severitySummary,
    eol_warning: eolWarning,
    fully_patched: quartersGap === 0 && !eolWarning,
    next_cpu_estimate: guessNextCpuQuarter(latestQuarter)
  };
}

function guessNextCpuQuarter(latestQuarter) {
  if (!latestQuarter) return null;
  const [y, qn] = latestQuarter.split('-Q').map(Number);
  const next = qn === 4 ? { y: y + 1, q: 1 } : { y, q: qn + 1 };
  // Quarter release month approx: Q1=Jan, Q2=Apr, Q3=Jul, Q4=Oct
  const months = { 1: 'January', 2: 'April', 3: 'July', 4: 'October' };
  return `${months[next.q]} ${next.y} (${next.y}-Q${next.q})`;
}

// ─── Runbook generators ───────────────────────────────────────────────────────

/**
 * buildEbsAdopRunbook — generate the adop prep→apply→finalize→cleanup sequence
 * with real prerequisite values substituted.
 *
 * @param {object} params
 * @param {string} params.patchNumber  — patch to apply (from gap analysis)
 * @param {object|null} params.archiveSpace  — { free_gb, used_pct, dest_name }
 * @param {string|null} params.lastCutover   — ISO date string
 * @param {number}      params.invalidCount  — baseline INVALID objects count
 * @param {string}      params.versionKey    — "19c" etc. for context
 * @returns {Array<{step, title, commands, notes, verification}>}
 */
function buildEbsAdopRunbook({ patchNumber, archiveSpace, lastCutover, invalidCount, versionKey }) {
  const archWarn = archiveSpace && archiveSpace.free_gb < 20
    ? `⚠️  Archive destination only ${archiveSpace.free_gb}GB free (${archiveSpace.used_pct}% used). Extend before proceeding.`
    : archiveSpace
      ? `✅ Archive destination ${archiveSpace.free_gb}GB free — adequate.`
      : `⚠️  Could not read archive log destination space. Verify manually.`;

  const cutoverWarn = lastCutover
    ? `Last fs_clone cutover: ${lastCutover}.`
    : `⚠️  No completed ADOP cutover found. Verify fs_clone freshness manually.`;

  const invalidWarn = invalidCount > 0
    ? `⚠️  ${invalidCount} INVALID objects at baseline. Resolve before patching to avoid post-patch confusion.`
    : `✅ No INVALID objects at baseline.`;

  const patch = patchNumber || '<PATCH_NUMBER>';

  return [
    {
      step: 'preflight',
      title: '0. Pre-flight Checks',
      notes: [
        archWarn,
        cutoverWarn,
        invalidWarn,
        'Change window required. TuneVault generates commands; your team executes during approved maintenance.',
        'Review Oracle MOS Doc 1594274.1 (EBS 12.2 patching guide) before proceeding.'
      ],
      commands: [
        '-- 1. Verify archive log space',
        'SELECT dest_name, ROUND(space_limit/1073741824,2) limit_gb,',
        '       ROUND(space_used/1073741824,2) used_gb,',
        '       ROUND((space_limit-space_used)/1073741824,2) free_gb',
        'FROM v$recovery_file_dest;',
        '',
        '-- 2. Baseline INVALID objects count',
        'SELECT COUNT(*) FROM dba_objects WHERE status = \'INVALID\';',
        '',
        '-- 3. Confirm no ADOP session stuck in PREPARE/APPLY/FINALIZE',
        'SELECT session_id, prepare_status, apply_status, finalize_status,',
        '       cutover_status, cleanup_status, start_date',
        'FROM apps.ad_adop_sessions',
        'WHERE NVL(cleanup_status,\'X\') != \'C\'',
        'ORDER BY start_date DESC;',
        '',
        '-- 4. Drain Concurrent Managers',
        'SELECT concurrent_queue_name, running_processes, max_processes',
        'FROM apps.fnd_concurrent_queues_vl',
        'WHERE enabled_flag = \'Y\' AND running_processes > 0;'
      ],
      verification: null
    },
    {
      step: 'prepare',
      title: '1. Prepare Phase',
      notes: [
        'adop prepare creates the patch filesystem (fs_clone). Expected runtime: 20-60 min depending on APPL_TOP size.',
        'Run as the applmgr OS user from $APPL_TOP on the primary (run) filesystem.',
        'OPatch prereq checks run automatically — resolve any conflicts before apply.'
      ],
      commands: [
        '# Run as applmgr (or your EBS OS user) on the run filesystem',
        `cd $APPL_TOP`,
        `adop phase=prepare`,
        '',
        '# Monitor progress in another terminal:',
        'tail -f $APPL_TOP/admin/log/adop_prepare_*.log'
      ],
      verification: `-- Confirm prepare completed:
SELECT session_id, prepare_status, TO_CHAR(start_date,'YYYY-MM-DD HH24:MI') start_date
FROM apps.ad_adop_sessions
ORDER BY start_date DESC
FETCH FIRST 3 ROWS ONLY;
-- Expect prepare_status = 'C' for the current session`
    },
    {
      step: 'apply',
      title: `2. Apply Phase — Patch ${patch}`,
      notes: [
        `Applying patch ${patch}.`,
        'patchtop should point to the directory where you unzipped the patch.',
        'For multiple patches: patches=PATCH1:PATCH2:PATCH3 (colon-separated).',
        'merge=yes collapses multiple patches into one adop run — faster than sequential applies.',
        `MOS Doc: ${PATCH_INDEX._meta.mos_doc_id || '2118136.2'}`
      ],
      commands: [
        '# Substitute <PATCH_DIR> with the actual unzip location',
        `adop phase=apply patches=${patch} patchtop=<PATCH_DIR> merge=yes`,
        '',
        '# Multi-patch example:',
        `# adop phase=apply patches=${patch}:PATCH2 patchtop=<PATCH_DIR> merge=yes`,
        '',
        '# Monitor:',
        'tail -f $APPL_TOP/admin/log/adop_apply_*.log'
      ],
      verification: `-- Confirm apply completed without errors:
SELECT session_id, apply_status, TO_CHAR(start_date,'YYYY-MM-DD HH24:MI') start_date
FROM apps.ad_adop_sessions
ORDER BY start_date DESC
FETCH FIRST 3 ROWS ONLY;
-- Also check: grep -i error $APPL_TOP/admin/log/adop_apply_*.log | grep -v "0 error"`
    },
    {
      step: 'finalize',
      title: '3. Finalize Phase',
      notes: [
        'Finalize compiles APPS objects on the patch filesystem.',
        'Expected runtime: 30-90 min. INVALID object count spikes during this phase — normal.',
        'Do not proceed to cutover until finalize_status = C.'
      ],
      commands: [
        'adop phase=finalize',
        '',
        '# Monitor:',
        'tail -f $APPL_TOP/admin/log/adop_finalize_*.log'
      ],
      verification: `-- Confirm finalize + check remaining INVALID objects:
SELECT session_id, finalize_status FROM apps.ad_adop_sessions ORDER BY start_date DESC FETCH FIRST 1 ROW ONLY;
SELECT COUNT(*) AS invalid_after_finalize FROM dba_objects WHERE status = 'INVALID';
-- Compare to baseline (${invalidCount} before patching). Small delta is normal.`
    },
    {
      step: 'cutover',
      title: '4. Cutover Phase',
      notes: [
        '⚠️  This is the downtime window. Applications will be unavailable during cutover.',
        'Coordinate with end users before proceeding.',
        'Cutover switches the active filesystem from run→patch (which becomes the new run).',
        'Expected duration: 5-15 min.'
      ],
      commands: [
        '# Announce downtime / stop load balancer',
        '',
        'adop phase=cutover',
        '',
        '# After cutover, restart services on the new run filesystem:',
        '$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<APPS_PWD>',
        '',
        '# Verify services are up:',
        '$ADMIN_SCRIPTS_HOME/adstatus.sh apps/<APPS_PWD>'
      ],
      verification: `-- Confirm cutover completed:
SELECT session_id, cutover_status, TO_CHAR(cutover_time,'YYYY-MM-DD HH24:MI') cutover_time
FROM apps.ad_adop_sessions
ORDER BY start_date DESC
FETCH FIRST 1 ROW ONLY;
-- cutover_status should = 'C'`
    },
    {
      step: 'cleanup',
      title: '5. Cleanup Phase',
      notes: [
        'Cleanup removes the old (patch) filesystem and releases disk space.',
        'Run after confirming application is stable post-cutover.',
        'cleanup_mode=full removes all adop artifacts. Recommended unless disk space is critical.'
      ],
      commands: [
        'adop phase=cleanup cleanup_mode=full',
        '',
        '# Monitor:',
        'tail -f $APPL_TOP/admin/log/adop_cleanup_*.log'
      ],
      verification: `-- Confirm full cleanup:
SELECT session_id, cleanup_status, TO_CHAR(start_date,'YYYY-MM-DD HH24:MI') start_date
FROM apps.ad_adop_sessions
ORDER BY start_date DESC
FETCH FIRST 1 ROW ONLY;
-- cleanup_status should = 'C'`
    },
    {
      step: 'rollback',
      title: '⬇ Rollback Path (if needed)',
      notes: [
        'Rollback is only possible BEFORE cutover.',
        'If issues arise during prepare or apply, abort the session and run full cleanup.',
        'After cutover there is no automated rollback — restore from backup if necessary.'
      ],
      commands: [
        '# Abort and reset (before cutover only):',
        'adop phase=abort',
        '',
        '# Full cleanup after abort:',
        'adop phase=cleanup cleanup_mode=full',
        '',
        '# Verify session is closed:',
        'SELECT session_id, NVL(cleanup_status,\'N/A\') cleanup_status',
        'FROM apps.ad_adop_sessions',
        'ORDER BY start_date DESC',
        'FETCH FIRST 1 ROW ONLY;'
      ],
      verification: null
    }
  ];
}

/**
 * buildOpatchRunbook — RDBMS-only OPatch sequence for non-EBS instances.
 */
function buildOpatchRunbook({ patchNumber, invalidCount, versionKey }) {
  const patch = patchNumber || '<PATCH_NUMBER>';
  const versionIndex = PATCH_INDEX.rdbms[versionKey] || {};
  const latestEntry  = (versionIndex.release_update_patches || [])[0] || {};
  const mosDocId     = latestEntry.mos_doc_id || '2118136.2';

  return [
    {
      step: 'preflight',
      title: '0. Pre-flight Checks',
      notes: [
        `Applying patch ${patch} to ${versionKey || 'Oracle DB'}.`,
        `MOS Doc ID: ${mosDocId}`,
        '⚠️  Change window required. TuneVault generates commands; your team executes during approved maintenance.',
        `Baseline INVALID objects: ${invalidCount !== null ? invalidCount : 'unknown'}.`
      ],
      commands: [
        '# Verify OPatch version (minimum 12.2.0.1.37 for 19c)',
        '$ORACLE_HOME/OPatch/opatch version',
        '',
        '# Check inventory and conflicts',
        '$ORACLE_HOME/OPatch/opatch lsinventory -detail | tail -40',
        '',
        '# Prereq check (dry run — no changes)',
        `cd /tmp/<PATCH_${patch}>`,
        `$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -phBaseDir .`,
        '',
        '-- Baseline INVALID objects:',
        'SELECT COUNT(*) FROM dba_objects WHERE status = \'INVALID\';'
      ],
      verification: null
    },
    {
      step: 'apply',
      title: `1. Apply Patch ${patch}`,
      notes: [
        'Oracle Home must be shut down (all instances using this OH) before apply.',
        'Apply as the oracle OS user who owns $ORACLE_HOME.',
        'datapatch runs post-apply to update SQL objects in the database catalog.'
      ],
      commands: [
        '# 1. Stop all instances using this ORACLE_HOME',
        'sqlplus / as sysdba <<EOF',
        'shutdown immediate;',
        'exit;',
        'EOF',
        '',
        '# 2. Apply the RU patch',
        `cd /tmp/<PATCH_${patch}>`,
        `$ORACLE_HOME/OPatch/opatch apply`,
        '',
        '# 3. Verify patch is listed in inventory',
        `$ORACLE_HOME/OPatch/opatch lsinv | grep ${patch}`,
        '',
        '# 4. Start the database',
        'sqlplus / as sysdba <<EOF',
        'startup;',
        'exit;',
        'EOF'
      ],
      verification: `-- Confirm patch visible in registry:
SELECT patch_id, version, action, status, TO_CHAR(action_time,'YYYY-MM-DD') applied
FROM sys.dba_registry_sqlpatch
ORDER BY action_time DESC
FETCH FIRST 5 ROWS ONLY;`
    },
    {
      step: 'datapatch',
      title: '2. Run datapatch',
      notes: [
        'datapatch applies SQL changes from the patch into the database catalog.',
        'Must run with the database open and as oracle OS user.',
        'Expected runtime: 5-20 min. Output logged to $ORACLE_BASE/cfgtoollogs/sqlpatch/.'
      ],
      commands: [
        '$ORACLE_HOME/OPatch/datapatch -verbose',
        '',
        '# Check datapatch log for errors:',
        'ls -lt $ORACLE_BASE/cfgtoollogs/sqlpatch/ | head -5',
        'tail -50 $ORACLE_BASE/cfgtoollogs/sqlpatch/<latest_log>.log'
      ],
      verification: `-- Confirm datapatch completed successfully:
SELECT patch_id, action, status, TO_CHAR(action_time,'YYYY-MM-DD HH24:MI') action_time
FROM sys.dba_registry_sqlpatch
WHERE patch_id = ${patch}
ORDER BY action_time DESC;
-- status should = 'SUCCESS', action = 'APPLY'

-- Check INVALID objects post-patch:
SELECT COUNT(*) AS invalid_after FROM dba_objects WHERE status = 'INVALID';
-- Compare to baseline (${invalidCount !== null ? invalidCount : 'N/A'} before patching)`
    },
    {
      step: 'verify',
      title: '3. Post-patch Verification',
      notes: [
        'Compile any remaining INVALID objects.',
        'Recheck critical views and packages.',
        'If INVALID count increased significantly, check datapatch log for errors.'
      ],
      commands: [
        '-- Recompile INVALID objects (run as sysdba):',
        'EXEC UTL_RECOMP.recomp_serial();',
        '',
        '-- Or targeted for APPS schema (EBS-adjacent DBs):',
        '-- EXEC UTL_RECOMP.recomp_schema(\'APPS\');'
      ],
      verification: `-- Final health check:
SELECT patch_id, action, status FROM sys.dba_registry_sqlpatch WHERE patch_id = ${patch};
SELECT COUNT(*) AS invalid_final FROM dba_objects WHERE status = 'INVALID';
SELECT comp_id, status, version FROM dba_registry ORDER BY comp_id;`
    }
  ];
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function getDemoPatchData() {
  const versionKey = '19c';
  const versionIndex = PATCH_INDEX.rdbms[versionKey];
  const allPatches = versionIndex.release_update_patches;

  // Simulate instance on 19.23 RU (Jan 2024 CPU) — 4 quarters behind
  const simulatedCurrentPatch = allPatches.find(p => p.label.includes('19.23'));

  const gapAnalysis = buildGapAnalysis({
    versionKey,
    appliedPatchId: simulatedCurrentPatch.patch_number,
    appliedLabel: simulatedCurrentPatch.label,
    appliedDate: simulatedCurrentPatch.release_date
  });

  const runbook = buildEbsAdopRunbook({
    patchNumber: versionIndex.latest_patch,
    archiveSpace: { free_gb: 42.3, used_pct: 67.4, dest_name: '+FRA' },
    lastCutover: '2024-01-15 03:22:00',
    invalidCount: 3,
    versionKey
  });

  return {
    is_demo: true,
    connection_name: 'Demo EBS 12.2 Instance',
    db_version: '19.18.0.0.0 (demo)',
    db_version_key: versionKey,
    ebs_detected: true,
    current_level: {
      source: 'demo',
      patches: [
        {
          patch_id: simulatedCurrentPatch.patch_number,
          description: simulatedCurrentPatch.label,
          action: 'APPLY',
          status: 'SUCCESS',
          action_time: simulatedCurrentPatch.release_date
        }
      ],
      raw_version: '19.18.0.0.0'
    },
    ebs_level: {
      applied_patches: [
        { patch_name: '34174657', patch_type: 'G', applied_date: '2024-03-20', maint_pack_name: 'R12.AD.C.Delta.13' },
        { patch_name: '33267777', patch_type: 'G', applied_date: '2023-08-10', maint_pack_name: 'R12.AD.C.Delta.12' },
        { patch_name: '23135261', patch_type: 'G', applied_date: '2022-11-02', maint_pack_name: 'R12.AD.C.Delta.11' }
      ],
      last_cutover: '2024-01-15 03:22:00',
      adop_sessions: [
        { session_id: 301, prepare_status: 'C', apply_status: 'C', finalize_status: 'C', cutover_status: 'C', cleanup_status: 'C', start_date: '2024-01-14 22:00', cutover_time: '2024-01-15 03:22', node_name: 'ebsnode1' },
        { session_id: 298, prepare_status: 'C', apply_status: 'C', finalize_status: 'C', cutover_status: 'C', cleanup_status: 'C', start_date: '2023-08-09 21:30', cutover_time: '2023-08-10 02:45', node_name: 'ebsnode1' },
        { session_id: 292, prepare_status: 'C', apply_status: 'F', finalize_status: 'N/A', cutover_status: 'N/A', cleanup_status: 'C', start_date: '2023-05-12 19:00', cutover_time: null, node_name: 'ebsnode1' }
      ],
      ad_codelevel: 'R12.AD.C.Delta.13',
      txk_codelevel: 'R12.TXK.C.Delta.13'
    },
    preflight: {
      archive_space: { free_gb: 42.3, used_pct: 67.4, dest_name: '+FRA', limit_gb: 130.0, used_gb: 87.7 },
      invalid_objects_count: 3
    },
    gap_analysis: gapAnalysis,
    recommended_patches: allPatches.slice(0, 4),
    runbook,
    patch_index_meta: PATCH_INDEX._meta
  };
}

// ─── Patch check query — used by /api/patches/check ──────────────────────────
// Looks up specific patch numbers in dba_registry_sqlpatch and dba_registry_history.
// Parameterised by the Oracle client layer; patch numbers come as a filter in JS
// because Oracle doesn't support variadic IN binds portably across proxy + direct.
const PATCH_CHECK_SQL = `
SELECT patch_id, patch_uid, version, action, status,
       TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI:SS') AS action_time,
       description, bundle_series
FROM   sys.dba_registry_sqlpatch
WHERE  action = 'APPLY'
ORDER  BY action_time DESC`;

// EBS AD_APPLIED_PATCHES — check specific patch names for EBS instances
const EBS_PATCH_CHECK_SQL = `
SELECT ap.patch_name,
       TO_CHAR(ap.creation_date, 'YYYY-MM-DD') AS applied_date,
       ap.maint_pack_name
FROM   apps.ad_applied_patches ap
ORDER  BY ap.creation_date DESC`;

/**
 * buildPatchCheckResult — compare requested patch numbers against applied rows.
 * Returns [{patch_number, applied, date, home, source}] for each requested patch.
 */
function buildPatchCheckResult(requestedPatches, dbPatchRows, ebsPatchRows) {
  const dbMap = {};
  for (const r of dbPatchRows) {
    const pid = String(r.patch_id || r.PATCH_ID || '').trim();
    if (pid) dbMap[pid] = r;
  }

  const ebsMap = {};
  for (const r of ebsPatchRows) {
    const pn = String(r.patch_name || r.PATCH_NAME || '').trim();
    if (pn) ebsMap[pn] = r;
  }

  return requestedPatches.map(num => {
    const clean = String(num).trim();

    // Check DB home first (dba_registry_sqlpatch)
    if (dbMap[clean]) {
      const r = dbMap[clean];
      return {
        patch_number: clean,
        applied: true,
        date: r.action_time || r.ACTION_TIME || null,
        home: 'DB ORACLE_HOME',
        description: r.description || r.DESCRIPTION || null,
        source: 'dba_registry_sqlpatch'
      };
    }

    // Check EBS AD_APPLIED_PATCHES
    if (ebsMap[clean]) {
      const r = ebsMap[clean];
      return {
        patch_number: clean,
        applied: true,
        date: r.applied_date || r.APPLIED_DATE || null,
        home: 'APPS (EBS)',
        description: r.maint_pack_name || null,
        source: 'ad_applied_patches'
      };
    }

    return {
      patch_number: clean,
      applied: false,
      date: null,
      home: null,
      description: null,
      source: null
    };
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve the patches page — keep for backward compat, redirect to /db-ops?cat=patches
router.get('/patches', (req, res) => {
  res.redirect(301, '/db-ops?cat=patches');
});

// Serve the EBS Patches page
router.get('/ebs-patches', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'ebs-patches.html'));
});

// Main advisor endpoint
router.get('/api/patches/advisor/:connectionId', requireAuth, async (req, res) => {
  const connId = parseInt(req.params.connectionId, 10);

  // Demo mode
  if (req.query.demo === '1' || isNaN(connId)) {
    return res.json(getDemoPatchData());
  }

  // Load connection
  const conn = await getConnectionForPatches(req.user.id, connId).catch(() => null);
  if (!conn) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const oracle = getOracleClient();
  if (!oracle) {
    // Oracle client unavailable — return demo with note
    const demo = getDemoPatchData();
    demo.is_demo = true;
    demo.oracle_unavailable = true;
    return res.json(demo);
  }

  // Resolve credentials
  let password;
  try {
    password = conn.encrypted_password ? decrypt(conn.encrypted_password) : null;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to decrypt credentials' });
  }

  // Build connection config
  const isProxy = conn.connection_type === 'proxy';
  const connConfig = isProxy
    ? { proxyUrl: conn.proxy_url, proxyApiKey: conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null }
    : { host: conn.host, port: conn.port, serviceName: conn.service_name, username: conn.username, password };

  try {
    // 1. RDBMS version
    let rawVersion = null;
    try {
      const vRows = await oracle.runQuery(connConfig, VERSION_QUERY, []);
      rawVersion = vRows[0]?.VERSION_FULL || vRows[0]?.VERSION || null;
    } catch (_) { /* non-fatal */ }

    const versionKey = normaliseVersion(rawVersion);

    // 2. SQL patch history (12c+)
    let sqlPatches = [];
    try {
      const rows = await oracle.runQuery(connConfig, SQL_PATCH_QUERY, []);
      sqlPatches = rows.map(r => ({
        patch_id:    r.PATCH_ID    || r.patch_id,
        patch_uid:   r.PATCH_UID   || r.patch_uid,
        version:     r.VERSION     || r.version,
        action:      r.ACTION      || r.action,
        status:      r.STATUS      || r.status,
        action_time: r.ACTION_TIME || r.action_time,
        description: r.DESCRIPTION || r.description,
        bundle_series: r.BUNDLE_SERIES || r.bundle_series
      }));
    } catch (_) {
      // Might lack SELECT on DBA_REGISTRY_SQLPATCH — try legacy
      try {
        const rows = await oracle.runQuery(connConfig, REGISTRY_HISTORY_QUERY, []);
        sqlPatches = rows.map(r => ({
          patch_id:    r.ID || r.id,
          action:      r.ACTION || r.action,
          action_time: r.ACTION_TIME || r.action_time,
          description: r.COMMENTS || r.comments,
          version:     r.VERSION || r.version
        }));
      } catch (_2) { /* give up on patch history */ }
    }

    // 3. Current patch identification
    const latestApplied = findAppliedPatch(sqlPatches);
    const appliedPatchId = latestApplied?.patch_id || null;
    const appliedLabel   = latestApplied?.description || null;
    const appliedDate    = latestApplied?.action_time || null;

    // 4. EBS detection (AD_APPLIED_PATCHES access = EBS instance)
    let ebsPatches = [];
    let lastCutover = null;
    let ebsDetected = false;
    let adopSessions = [];
    let adTxkCodelevels = {};
    try {
      const rows = await oracle.runQuery(connConfig, EBS_PATCH_QUERY, []);
      if (rows.length > 0) {
        ebsDetected = true;
        ebsPatches = rows.map(r => ({
          patch_name:      r.PATCH_NAME || r.patch_name,
          patch_type:      r.PATCH_TYPE || r.patch_type,
          applied_date:    r.APPLIED_DATE || r.applied_date,
          maint_pack_name: r.MAINT_PACK_NAME || r.maint_pack_name
        }));
        // fs_clone freshness
        const cutoverRows = await oracle.runQuery(connConfig, ADOP_SESSION_QUERY, []).catch(() => []);
        lastCutover = cutoverRows[0]?.LAST_CUTOVER || cutoverRows[0]?.last_cutover || null;

        // Full ADOP session history
        try {
          const sessRows = await oracle.runQuery(connConfig, ADOP_SESSION_HISTORY_QUERY, []);
          adopSessions = sessRows.map(r => ({
            session_id:      r.SESSION_ID || r.session_id,
            prepare_status:  r.PREPARE_STATUS || r.prepare_status || 'N/A',
            apply_status:    r.APPLY_STATUS || r.apply_status || 'N/A',
            finalize_status: r.FINALIZE_STATUS || r.finalize_status || 'N/A',
            cutover_status:  r.CUTOVER_STATUS || r.cutover_status || 'N/A',
            cleanup_status:  r.CLEANUP_STATUS || r.cleanup_status || 'N/A',
            start_date:      r.START_DATE || r.start_date,
            cutover_time:    r.CUTOVER_TIME || r.cutover_time,
            node_name:       r.NODE_NAME || r.node_name
          }));
        } catch (_) { /* non-fatal */ }

        // AD/TXK codelevels
        try {
          const clRows = await oracle.runQuery(connConfig, AD_TXK_CODELEVELS_QUERY, []);
          for (const r of clRows) {
            const abbr = (r.ABBREVIATION || r.abbreviation || '').toUpperCase();
            adTxkCodelevels[abbr] = r.CODELEVEL || r.codelevel;
          }
        } catch (_) { /* non-fatal */ }
      }
    } catch (_) { /* no EBS */ }

    // 5. Preflight: archive space + INVALID objects
    let archiveSpace = null;
    try {
      const rows = await oracle.runQuery(connConfig, ARCHIVE_SPACE_QUERY, []);
      if (rows.length > 0) {
        const r = rows[0];
        archiveSpace = {
          dest_name: r.DEST_NAME || r.dest_name,
          limit_gb:  parseFloat(r.LIMIT_GB || r.limit_gb || 0),
          used_gb:   parseFloat(r.USED_GB  || r.used_gb  || 0),
          free_gb:   parseFloat(r.FREE_GB  || r.free_gb  || 0),
          used_pct:  parseFloat(r.USED_PCT || r.used_pct || 0)
        };
      }
    } catch (_) { /* non-fatal */ }

    let invalidCount = null;
    try {
      const rows = await oracle.runQuery(connConfig, INVALID_OBJECTS_QUERY, []);
      invalidCount = parseInt(rows[0]?.CNT || rows[0]?.cnt || 0, 10);
    } catch (_) { /* non-fatal */ }

    // 6. Gap analysis
    const gapAnalysis = versionKey
      ? buildGapAnalysis({ versionKey, appliedPatchId, appliedLabel, appliedDate })
      : null;

    // 7. Recommended patches
    const versionIndex = PATCH_INDEX.rdbms[versionKey] || {};
    const recommendedPatches = (versionIndex.release_update_patches || []).slice(0, 4);

    // 8. Runbook
    const targetPatch = gapAnalysis?.latest_patch?.patch_number || versionIndex.latest_patch;
    const runbook = ebsDetected
      ? buildEbsAdopRunbook({ patchNumber: targetPatch, archiveSpace, lastCutover, invalidCount, versionKey })
      : buildOpatchRunbook({ patchNumber: targetPatch, invalidCount, versionKey });

    return res.json({
      is_demo: false,
      connection_name: conn.name,
      db_version: rawVersion,
      db_version_key: versionKey,
      ebs_detected: ebsDetected,
      current_level: {
        source: sqlPatches.length > 0 ? 'dba_registry_sqlpatch' : 'unknown',
        patches: sqlPatches,
        raw_version: rawVersion
      },
      ebs_level: ebsDetected ? {
        applied_patches: ebsPatches,
        last_cutover: lastCutover,
        adop_sessions: adopSessions,
        ad_codelevel: adTxkCodelevels['AD'] || null,
        txk_codelevel: adTxkCodelevels['TXK'] || null
      } : null,
      preflight: {
        archive_space: archiveSpace,
        invalid_objects_count: invalidCount
      },
      gap_analysis: gapAnalysis,
      recommended_patches: recommendedPatches,
      runbook,
      patch_index_meta: PATCH_INDEX._meta
    });

  } catch (err) {
    console.error('[patches] advisor error:', err.message);
    return res.status(500).json({ error: 'Failed to query Oracle database', detail: err.message });
  }
});

// Serve the Patch Status (Dev/Func) page
router.get('/patches/status', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'patches-status.html'));
});

// GET /api/patches/check?connection_id=X&patches=12345678,33915561
// Simplified patch applied/not-applied lookup for Dev/Func teams.
// No ADOP state, no gap analysis, no runbook — just yes/no per patch number.
router.get('/api/patches/check', requireAuth, async (req, res) => {
  const { connection_id, patches: patchParam } = req.query;

  if (!connection_id || !patchParam) {
    return res.status(400).json({ error: 'connection_id and patches are required' });
  }

  // Parse patch numbers — comma-separated or newline-separated
  const requestedPatches = patchParam
    .split(/[\n,]+/)
    .map(p => p.trim())
    .filter(p => /^\d+$/.test(p)); // only numeric patch numbers

  if (requestedPatches.length === 0) {
    return res.status(400).json({ error: 'No valid patch numbers provided (expected numeric IDs)' });
  }

  if (requestedPatches.length > 50) {
    return res.status(400).json({ error: 'Too many patch numbers — limit is 50 per request' });
  }

  // Demo mode (no real connection)
  if (connection_id === 'demo') {
    const demo = requestedPatches.map((num, i) => ({
      patch_number: num,
      applied: i % 3 !== 2, // demo: 2 of 3 applied
      date: i % 3 !== 2 ? '2024-01-15 03:22:00' : null,
      home: i % 3 !== 2 ? (i % 2 === 0 ? 'DB ORACLE_HOME' : 'APPS (EBS)') : null,
      description: i % 3 !== 2 ? '19.23 RU (demo)' : null,
      source: i % 3 !== 2 ? (i % 2 === 0 ? 'dba_registry_sqlpatch' : 'ad_applied_patches') : null
    }));
    return res.json({ results: demo, connection_name: 'Demo Instance', is_demo: true });
  }

  const connId = parseInt(connection_id, 10);
  const conn = await getConnectionForPatches(req.user.id, connId).catch(() => null);
  if (!conn) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const oracle = getOracleClient();
  if (!oracle) {
    return res.status(503).json({ error: 'Oracle client unavailable — use proxy connection type' });
  }

  let password;
  try {
    password = conn.encrypted_password ? decrypt(conn.encrypted_password) : null;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to decrypt credentials' });
  }

  const isProxy = conn.connection_type === 'proxy';
  const connConfig = isProxy
    ? { proxyUrl: conn.proxy_url, proxyApiKey: conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null }
    : { host: conn.host, port: conn.port, serviceName: conn.service_name, username: conn.username, password };

  try {
    // Fetch all applied DB patches (dba_registry_sqlpatch)
    let dbRows = [];
    try {
      dbRows = await oracle.runQuery(connConfig, PATCH_CHECK_SQL, []);
    } catch (_) { /* no SELECT on DBA_REGISTRY_SQLPATCH — leave empty */ }

    // Fetch EBS patches if available (AD_APPLIED_PATCHES — non-fatal if not EBS)
    let ebsRows = [];
    try {
      ebsRows = await oracle.runQuery(connConfig, EBS_PATCH_CHECK_SQL, []);
    } catch (_) { /* not an EBS instance */ }

    const results = buildPatchCheckResult(requestedPatches, dbRows, ebsRows);
    return res.json({ results, connection_name: conn.name, is_demo: false });

  } catch (err) {
    console.error('[patches] check error:', err.message);
    return res.status(500).json({ error: 'Failed to query Oracle database', detail: err.message });
  }
});

// ─── OPatch output parser ─────────────────────────────────────────────────────

/**
 * parseOpatchInventory — extract patch IDs and descriptions from `opatch lsinventory` stdout.
 *
 * OPatch output format (per-patch block):
 *   Patch  12345678 : applied on Mon Jan 15 03:22:00 UTC 2024
 *   Unique Patch ID:  99999999
 *     Created on 15 Jan 2024, 01:00:00 hrs PST8PDT
 *     Bugs fixed:
 *       35910299, 35910300, ...
 *
 * We collect the "Patch  NNNNN" lines (those are the top-level applied patch IDs).
 */
function parseOpatchInventory(rawOutput) {
  if (!rawOutput) return { patches: [], error: null };

  // Error / not found cases
  if (/ORACLE_COMMON_NOT_FOUND|ORACLE_HOME_NOT_FOUND|DB_ORACLE_HOME_NOT_FOUND/.test(rawOutput)) {
    return { patches: [], error: rawOutput.trim() };
  }
  if (/Error\s+invoking\s+opatch|OPatch.*not\s+found|No such file/i.test(rawOutput)) {
    return { patches: [], error: 'opatch binary not found or returned error' };
  }

  const patches = [];
  // Match lines like: "Patch  12345678 : applied on ..."
  // or               "Patch  12345678  : applied on ..."
  const patchLineRe = /^\s*Patch\s+(\d+)\s*:/im;
  // Also capture description from the same line or following line
  const descRe = /^\s*Patch\s+(\d+)\s*:\s*(.+)/im;

  const lines = rawOutput.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*Patch\s+(\d+)\s*:/i);
    if (m) {
      const id = m[1].trim();
      // Extract description — everything after the colon on the same line
      const descMatch = line.match(/^\s*Patch\s+\d+\s*:\s*(.+)/i);
      const desc = descMatch ? descMatch[1].trim() : null;
      if (!patches.find(p => p.id === id)) {
        patches.push({ id, description: desc });
      }
    }
  }

  return { patches, error: null };
}

/**
 * computeFmwMismatch — diff oracle_common patches vs Oracle_Home patches.
 * Returns arrays of patch IDs present in one home but not the other.
 */
function computeFmwMismatch(commonPatches, oracleHomePatches) {
  const commonIds      = new Set(commonPatches.map(p => p.id));
  const oracleHomeIds  = new Set(oracleHomePatches.map(p => p.id));

  const inCommonNotHome   = commonPatches.filter(p => !oracleHomeIds.has(p.id));
  const inHomeNotCommon   = oracleHomePatches.filter(p => !commonIds.has(p.id));

  return { inCommonNotHome, inHomeNotCommon, hasMismatch: inCommonNotHome.length > 0 || inHomeNotCommon.length > 0 };
}

// ─── POST /api/patches/fmw-inventory ─────────────────────────────────────────
// Runs opatch lsinventory on oracle_common and Oracle_Home via SSH.
// Parses patch IDs from both, computes mismatch.
// Body: { apps_target_id: number, db_target_id?: number, connection_id: number }

router.post('/api/patches/fmw-inventory', requireAuth, async (req, res) => {
  const { apps_target_id, db_target_id, connection_id } = req.body || {};

  if (!apps_target_id || !connection_id) {
    return res.status(400).json({ error: 'apps_target_id and connection_id are required' });
  }

  const connId = parseInt(connection_id, 10);
  const conn = await getConnectionForPatches(req.user.id, connId).catch(() => null);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  const appsTarget = await sshDb.getTargetById(parseInt(apps_target_id, 10)).catch(() => null);
  if (!appsTarget) return res.status(404).json({ error: 'SSH target not found' });

  // Verify caller owns the target or it's admin-managed
  if (appsTarget.user_id != null && appsTarget.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorised for this SSH target' });
  }

  const results = {};

  // Run oracle_common inventory
  try {
    const r = await sshExecutor.runCommand({ targetId: appsTarget.id, commandKey: 'fmw.opatch.oracle_common', initiatedBy: req.user.email });
    results.oracle_common = { ...parseOpatchInventory(r.stdout), stdout: r.stdout, exitCode: r.exitCode };
  } catch (e) {
    results.oracle_common = { patches: [], error: e.message, stdout: null, exitCode: null };
  }

  // Run Oracle_Home (WLS) inventory
  try {
    const r = await sshExecutor.runCommand({ targetId: appsTarget.id, commandKey: 'fmw.opatch.oracle_home', initiatedBy: req.user.email });
    results.oracle_home = { ...parseOpatchInventory(r.stdout), stdout: r.stdout, exitCode: r.exitCode };
  } catch (e) {
    results.oracle_home = { patches: [], error: e.message, stdout: null, exitCode: null };
  }

  // Optionally run DB ORACLE_HOME inventory on db_target_id
  if (db_target_id) {
    const dbTarget = await sshDb.getTargetById(parseInt(db_target_id, 10)).catch(() => null);
    if (dbTarget && (dbTarget.user_id == null || dbTarget.user_id === req.user.id)) {
      try {
        const r = await sshExecutor.runCommand({ targetId: dbTarget.id, commandKey: 'db.opatch.oracle_home', initiatedBy: req.user.email });
        results.db_oracle_home = { ...parseOpatchInventory(r.stdout), stdout: r.stdout, exitCode: r.exitCode };
      } catch (e) {
        results.db_oracle_home = { patches: [], error: e.message, stdout: null, exitCode: null };
      }
    }
  }

  // Compute FMW mismatch
  const mismatch = computeFmwMismatch(
    results.oracle_common?.patches || [],
    results.oracle_home?.patches || []
  );

  return res.json({ results, mismatch });
});

module.exports = router;
