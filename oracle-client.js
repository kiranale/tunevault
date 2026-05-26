/**
 * Oracle Database Client — Thin Mode (no Oracle Instant Client needed)
 *
 * Connects to Oracle 12.1+ databases over TCP using oracledb thin client.
 * Runs read-only health check queries against V$ and DBA_ views.
 * EBS detection via APPS.DUAL probe gates the EBS Operations section (Wave F checks).
 * All APPS schema queries run only when ebsDetected = true.
 *
 * Required Oracle grants for the connecting user:
 *   GRANT SELECT_CATALOG_ROLE TO tunevault_reader;
 *   -- OR explicit grants:
 *   GRANT SELECT ON V_$INSTANCE TO tunevault_reader;
 *   GRANT SELECT ON V_$DATABASE TO tunevault_reader;
 *   GRANT SELECT ON V_$SQL TO tunevault_reader;
 *   GRANT SELECT ON V_$SYSTEM_EVENT TO tunevault_reader;
 *   GRANT SELECT ON V_$SGASTAT TO tunevault_reader;
 *   GRANT SELECT ON V_$SGA TO tunevault_reader;
 *   GRANT SELECT ON V_$PGASTAT TO tunevault_reader;
 *   GRANT SELECT ON V_$PGA_TARGET_ADVICE TO tunevault_reader;
 *   GRANT SELECT ON V_$OSSTAT TO tunevault_reader;
 *   GRANT SELECT ON V_$SYSSTAT TO tunevault_reader;
 *   GRANT SELECT ON V_$LIBRARYCACHE TO tunevault_reader;
 *   GRANT SELECT ON DBA_TABLESPACE_USAGE_METRICS TO tunevault_reader;
 *   GRANT SELECT ON DBA_TABLESPACES TO tunevault_reader;
 *   GRANT SELECT ON DBA_DATA_FILES TO tunevault_reader;
 *   GRANT SELECT ON DBA_FREE_SPACE TO tunevault_reader;
 *   GRANT SELECT ON DBA_INDEXES TO tunevault_reader;
 *   GRANT SELECT ON DBA_IND_STATISTICS TO tunevault_reader;
 */

const oracledb = require('oracledb');

// Thin mode is the default in oracledb 6.x — no Oracle Instant Client needed.
// Do NOT call initOracleClient() — that enables thick mode which requires native libraries.

/**
 * Test an Oracle connection. Returns { success, message, version? }
 */
async function testConnection({ host, port, serviceName, username, password }) {
  let connection;
  try {
    const connectString = `${host}:${port || 1521}/${serviceName}`;
    connection = await oracledb.getConnection({
      user: username,
      password: password,
      connectString: connectString,
      connectTimeout: 15
    });

    const result = await connection.execute(
      `SELECT banner FROM v$version WHERE ROWNUM = 1`
    );
    const version = result.rows?.[0]?.[0] || 'Connected';

    return { success: true, message: 'Connection successful', version };
  } catch (err) {
    return { success: false, message: formatOracleError(err) };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Run all health check queries and return metrics in the same format as demo-data.js
 */
async function collectMetrics({ host, port, serviceName, username, password }) {

  let connection;
  try {
    const connectString = `${host}:${port || 1521}/${serviceName}`;
    connection = await oracledb.getConnection({
      user: username,
      password: password,
      connectString: connectString,
      connectTimeout: 30
    });

    // Check AWR availability once (Diagnostics Pack license)
    const awrAvailable = await checkAwrAvailability(connection);

    // Run all queries in parallel where possible
    const [
      instanceInfo,
      tablespaces,
      waitEvents,
      topSql,
      indexAnalysis,
      sgaStats,
      pgaStats,
      osStats,
      undoStats,
      tempStats,
      alertLog,
      resourceLimits,
      sgaPgaHistory,
      backupStats
    ] = await Promise.all([
      queryInstanceInfo(connection),
      queryTablespaces(connection),
      queryWaitEvents(connection),
      queryTopSql(connection),
      queryIndexAnalysis(connection),
      querySgaStats(connection),
      queryPgaStats(connection),
      queryOsStats(connection),
      queryUndoStats(connection, awrAvailable),
      queryTempStats(connection, awrAvailable),
      queryAlertLog(connection),
      queryResourceLimits(connection, awrAvailable),
      querySgaPgaHistory(connection, awrAvailable),
      queryBackupStats(connection)
    ]);

    // EBS detection: lightweight APPS.DUAL probe — gate for EBS Operations checks
    const ebsDetected = await connection.execute(`SELECT 1 FROM APPS.DUAL`).catch(() => null) !== null;

    // EBS Operations: full APPS schema checks — only run when EBS is detected
    const ebsOps = ebsDetected ? await queryEbsOperations(connection).catch(() => null) : null;

    // Application fingerprinting — lightweight, independent of other checks
    const detectedApps = await detectApplications(connection).catch(() => []);

    return {
      instance: instanceInfo,
      tablespaces,
      wait_events: waitEvents,
      top_sql: topSql,
      index_analysis: indexAnalysis,
      sga_stats: sgaStats,
      pga_stats: pgaStats,
      redo_stats: { redo_size_mb_per_hour: 0, log_switches_per_hour: 0, log_file_size_mb: 0, log_groups: 0, avg_log_sync_ms: 0, max_log_sync_ms: 0 },
      os_stats: osStats,
      undo_stats: undoStats,
      temp_stats: tempStats,
      alert_log: alertLog,
      resource_limits: resourceLimits,
      sga_pga_history: sgaPgaHistory,
      backup_stats: backupStats,
      ebs_detected: ebsDetected,
      ebs_operations: ebsOps,  // null if EBS not detected; full EBS check results if detected
      detected_apps: detectedApps,  // array of { key, label } for detected Oracle applications
      awr_available: awrAvailable,
      snapshot_info: {
        begin_snap_id: 0,
        end_snap_id: 0,
        begin_time: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString(),
        elapsed_time_min: 720,
        db_time_min: 0
      }
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// Individual Query Functions
// ============================================================

async function queryInstanceInfo(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        d.NAME as db_name,
        i.INSTANCE_NAME,
        i.HOST_NAME,
        i.VERSION,
        d.PLATFORM_NAME,
        TO_CHAR(i.STARTUP_TIME, 'YYYY-MM-DD HH24:MI:SS') as startup_time,
        ROUND(SYSDATE - i.STARTUP_TIME) as uptime_days,
        ROUND((SYSDATE - i.STARTUP_TIME) * 24, 1) as uptime_hours,
        (SELECT VALUE FROM v$parameter WHERE name = 'cpu_count') as cpus,
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'sga_target'), 1) as sga_target_gb,
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1) as pga_target_gb,
        (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size') as db_block_size
      FROM v$database d, v$instance i
    `);

    const row = result.rows?.[0];
    if (!row) throw new Error('No instance data');

    return {
      db_name: row[0] || 'UNKNOWN',
      instance_name: row[1] || 'unknown',
      host_name: row[2] || host,
      version: row[3] || row[2] || 'Unknown',
      platform: row[4] || 'Unknown',
      startup_time: row[5] || '',
      uptime_days: row[6] || 0,
      uptime_hours: parseFloat(row[7]) || 0,
      rac: false,
      cpus: parseInt(row[8]) || 1,
      sga_target_gb: parseFloat(row[9]) || 0,
      pga_aggregate_target_gb: parseFloat(row[10]) || 0,
      db_block_size: parseInt(row[11]) || 8192
    };
  } catch (err) {
    console.error('Instance query failed:', err.message);
    // Fallback — try simpler query
    try {
      const result = await conn.execute(`SELECT name FROM v$database`);
      const r2 = await conn.execute(`SELECT instance_name, host_name, version FROM v$instance`);
      return {
        db_name: result.rows?.[0]?.[0] || 'UNKNOWN',
        instance_name: r2.rows?.[0]?.[0] || 'unknown',
        host_name: r2.rows?.[0]?.[1] || 'unknown',
        version: r2.rows?.[0]?.[2] || 'Unknown',
        platform: 'Unknown',
        startup_time: '',
        uptime_days: 0,
        rac: false,
        cpus: 1,
        sga_target_gb: 0,
        pga_aggregate_target_gb: 0,
        db_block_size: 8192
      };
    } catch (e2) {
      return {
        db_name: 'UNKNOWN', instance_name: 'unknown', host_name: 'unknown',
        version: 'Unknown', platform: 'Unknown', startup_time: '',
        uptime_days: 0, rac: false, cpus: 1, sga_target_gb: 0,
        pga_aggregate_target_gb: 0, db_block_size: 8192
      };
    }
  }
}

async function queryTablespaces(conn) {
  try {
    // Try DBA_TABLESPACE_USAGE_METRICS first (simplest, available in 12c+)
    const result = await conn.execute(`
      SELECT
        ts.TABLESPACE_NAME,
        ROUND(um.USED_SPACE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1) as used_gb,
        ROUND(um.TABLESPACE_SIZE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1) as total_gb,
        ROUND(um.USED_PERCENT, 1) as pct_used,
        CASE WHEN df.autoext > 0 THEN 1 ELSE 0 END as autoextend
      FROM DBA_TABLESPACE_USAGE_METRICS um
      JOIN DBA_TABLESPACES ts ON ts.TABLESPACE_NAME = um.TABLESPACE_NAME
      LEFT JOIN (
        SELECT TABLESPACE_NAME, BLOCK_SIZE FROM DBA_TABLESPACES
      ) ts_block ON ts_block.TABLESPACE_NAME = um.TABLESPACE_NAME
      LEFT JOIN (
        SELECT TABLESPACE_NAME, SUM(CASE WHEN AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END) as autoext
        FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME
      ) df ON df.TABLESPACE_NAME = um.TABLESPACE_NAME
      ORDER BY um.USED_PERCENT DESC
    `);

    return (result.rows || []).map(row => {
      const pct = parseFloat(row[3]) || 0;
      return {
        name: row[0],
        used_gb: parseFloat(row[1]) || 0,
        total_gb: parseFloat(row[2]) || 0,
        pct_used: pct,
        autoextend: row[4] > 0,
        status: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'ok'
      };
    });
  } catch (err) {
    console.error('Tablespace query failed, trying fallback:', err.message);
    // Fallback: DBA_DATA_FILES + DBA_FREE_SPACE
    try {
      const result = await conn.execute(`
        SELECT
          df.TABLESPACE_NAME,
          ROUND(SUM(df.BYTES) / 1024 / 1024 / 1024, 1) as total_gb,
          ROUND((SUM(df.BYTES) - NVL(fs.free_bytes, 0)) / 1024 / 1024 / 1024, 1) as used_gb,
          ROUND((1 - NVL(fs.free_bytes, 0) / SUM(df.BYTES)) * 100, 1) as pct_used,
          MAX(CASE WHEN df.AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END) as autoextend
        FROM DBA_DATA_FILES df
        LEFT JOIN (
          SELECT TABLESPACE_NAME, SUM(BYTES) as free_bytes
          FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME
        ) fs ON fs.TABLESPACE_NAME = df.TABLESPACE_NAME
        GROUP BY df.TABLESPACE_NAME, fs.free_bytes
        ORDER BY pct_used DESC
      `);

      return (result.rows || []).map(row => {
        const pct = parseFloat(row[3]) || 0;
        return {
          name: row[0],
          used_gb: parseFloat(row[2]) || 0,
          total_gb: parseFloat(row[1]) || 0,
          pct_used: pct,
          autoextend: row[4] > 0,
          status: pct > 90 ? 'critical' : pct > 80 ? 'warning' : 'ok'
        };
      });
    } catch (e2) {
      console.error('Tablespace fallback also failed:', e2.message);
      return [];
    }
  }
}

async function queryWaitEvents(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        EVENT,
        WAIT_CLASS,
        TOTAL_WAITS,
        ROUND(TIME_WAITED / 100, 1) as time_waited_s,
        CASE WHEN TOTAL_WAITS > 0
          THEN ROUND((TIME_WAITED / 100 / TOTAL_WAITS) * 1000, 2)
          ELSE 0
        END as avg_wait_ms,
        0 as pct_db_time
      FROM V$SYSTEM_EVENT
      WHERE WAIT_CLASS NOT IN ('Idle')
        AND TOTAL_WAITS > 0
      ORDER BY TIME_WAITED DESC
      FETCH FIRST 15 ROWS ONLY
    `);

    const rows = result.rows || [];

    // Calculate total non-idle time for percentage
    const totalTime = rows.reduce((sum, r) => sum + (parseFloat(r[3]) || 0), 0);

    return rows.map(row => ({
      event: row[0],
      wait_class: row[1],
      total_waits: parseInt(row[2]) || 0,
      time_waited_s: parseFloat(row[3]) || 0,
      avg_wait_ms: parseFloat(row[4]) || 0,
      pct_db_time: totalTime > 0 ? Math.round((parseFloat(row[3]) / totalTime) * 1000) / 10 : 0
    }));
  } catch (err) {
    console.error('Wait events query failed:', err.message);
    return [];
  }
}

async function queryTopSql(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        SQL_ID,
        SUBSTR(SQL_TEXT, 1, 500) as sql_text,
        EXECUTIONS,
        ROUND(ELAPSED_TIME / 1000000, 1) as elapsed_time_s,
        ROUND(CPU_TIME / 1000000, 1) as cpu_time_s,
        BUFFER_GETS,
        DISK_READS,
        ROWS_PROCESSED,
        CASE WHEN EXECUTIONS > 0
          THEN ROUND(ELAPSED_TIME / EXECUTIONS / 1000, 2)
          ELSE 0
        END as elapsed_per_exec_ms,
        CASE WHEN EXECUTIONS > 0
          THEN ROUND(BUFFER_GETS / EXECUTIONS)
          ELSE 0
        END as buffer_gets_per_exec,
        PLAN_HASH_VALUE
      FROM V$SQL
      WHERE EXECUTIONS > 0
        AND ELAPSED_TIME > 0
        AND PARSING_SCHEMA_NAME NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN', 'OUTLN', 'MDSYS', 'ORDSYS', 'EXFSYS', 'WMSYS', 'APPQOSSYS', 'DBSFWUSER')
        AND SQL_TEXT NOT LIKE '%v$%'
        AND SQL_TEXT NOT LIKE '%V$%'
        AND COMMAND_TYPE IN (2, 3, 6, 7, 189)
      ORDER BY ELAPSED_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `);

    return (result.rows || []).map(row => {
      const elapsedPerExec = parseFloat(row[8]) || 0;
      const bufferGetsPerExec = parseInt(row[9]) || 0;

      // Auto-detect issues
      let issue = 'Normal operation';
      if (elapsedPerExec > 20) issue = 'Very slow execution — check execution plan';
      else if (elapsedPerExec > 5) issue = 'Slow execution — review query and indexes';
      if (bufferGetsPerExec > 1000) issue = 'High buffer gets — possible full table scan or missing index';
      if (parseInt(row[6]) > parseInt(row[5]) * 0.1 && parseInt(row[6]) > 10000) {
        issue = 'High disk reads relative to buffer gets — data not in cache';
      }

      return {
        sql_id: row[0],
        sql_text: row[1] || '',
        executions: parseInt(row[2]) || 0,
        elapsed_time_s: parseFloat(row[3]) || 0,
        cpu_time_s: parseFloat(row[4]) || 0,
        buffer_gets: parseInt(row[5]) || 0,
        disk_reads: parseInt(row[6]) || 0,
        rows_processed: parseInt(row[7]) || 0,
        elapsed_per_exec_ms: elapsedPerExec,
        buffer_gets_per_exec: bufferGetsPerExec,
        plan_hash: String(row[10] || '0'),
        issue
      };
    });
  } catch (err) {
    console.error('Top SQL query failed:', err.message);
    return [];
  }
}

async function queryIndexAnalysis(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        i.OWNER,
        i.INDEX_NAME,
        i.TABLE_NAME,
        ROUND(s.LEAF_BLOCKS *
          (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size')
          / 1024 / 1024) as size_mb,
        i.BLEVEL,
        s.LEAF_BLOCKS,
        i.CLUSTERING_FACTOR,
        NVL(s.PCT_DIRECT_ACCESS, 100) as pct_direct_access,
        i.STATUS,
        CASE
          WHEN i.STATUS != 'VALID' THEN 'unusable'
          WHEN i.BLEVEL > 4 THEN 'critical'
          WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 50 THEN 'critical'
          WHEN i.BLEVEL > 3 THEN 'fragmented'
          WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 70 THEN 'fragmented'
          ELSE 'ok'
        END as health_status
      FROM DBA_INDEXES i
      LEFT JOIN DBA_IND_STATISTICS s ON s.OWNER = i.OWNER AND s.INDEX_NAME = i.INDEX_NAME AND s.PARTITION_NAME IS NULL
      WHERE i.OWNER NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN', 'OUTLN', 'MDSYS', 'ORDSYS', 'EXFSYS', 'WMSYS', 'XDB', 'CTXSYS', 'APPQOSSYS', 'DBSFWUSER', 'APEX_040000', 'APEX_040200', 'APEX_050000', 'FLOWS_FILES')
        AND i.INDEX_TYPE = 'NORMAL'
        AND NVL(s.LEAF_BLOCKS, 0) > 100
      ORDER BY
        CASE
          WHEN i.STATUS != 'VALID' THEN 1
          WHEN i.BLEVEL > 4 THEN 2
          WHEN i.BLEVEL > 3 THEN 3
          ELSE 4
        END,
        s.LEAF_BLOCKS DESC NULLS LAST
      FETCH FIRST 20 ROWS ONLY
    `);

    return (result.rows || []).map(row => {
      // Estimate pct_deleted from blevel and direct access
      // In real AWR this comes from index statistics; we approximate
      const blevel = parseInt(row[4]) || 0;
      const pctDirect = parseInt(row[7]) || 100;
      const estPctDeleted = Math.max(0, Math.min(100, Math.round(100 - pctDirect + (blevel > 3 ? (blevel - 3) * 15 : 0))));

      return {
        owner: row[0],
        index_name: row[1],
        table_name: row[2],
        size_mb: parseInt(row[3]) || 0,
        blevel: blevel,
        leaf_blocks: parseInt(row[5]) || 0,
        clustering_factor: parseInt(row[6]) || 0,
        pct_deleted: estPctDeleted,
        status: row[9] || 'ok'
      };
    });
  } catch (err) {
    console.error('Index analysis query failed:', err.message);
    return [];
  }
}

async function querySgaStats(conn) {
  try {
    // Get SGA component sizes
    const sgaResult = await conn.execute(`
      SELECT
        ROUND(SUM(VALUE) / 1024 / 1024 / 1024, 1) as sga_size_gb
      FROM V$SGA
    `);

    // Buffer cache hit ratio
    const hitResult = await conn.execute(`
      SELECT
        ROUND(
          (1 - (phys.VALUE / (db_gets.VALUE + con_gets.VALUE))) * 100, 1
        ) as buffer_cache_hit_ratio
      FROM
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'physical reads') phys,
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'db block gets') db_gets,
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'consistent gets') con_gets
    `);

    // Library cache hit ratio
    const libResult = await conn.execute(`
      SELECT ROUND(SUM(PINS - RELOADS) / NULLIF(SUM(PINS), 0) * 100, 1) as lib_hit
      FROM V$LIBRARYCACHE
    `);

    // Dictionary cache hit ratio
    const dictResult = await conn.execute(`
      SELECT ROUND(SUM(GETS - GETMISSES) / NULLIF(SUM(GETS), 0) * 100, 1) as dict_hit
      FROM V$ROWCACHE
    `);

    // Shared pool free
    const spResult = await conn.execute(`
      SELECT
        ROUND(free_bytes.val / total_bytes.val * 100, 1) as shared_pool_free_pct
      FROM
        (SELECT SUM(BYTES) as val FROM V$SGASTAT WHERE POOL = 'shared pool' AND NAME = 'free memory') free_bytes,
        (SELECT SUM(BYTES) as val FROM V$SGASTAT WHERE POOL = 'shared pool') total_bytes
    `);

    // Parse stats
    const parseResult = await conn.execute(`
      SELECT
        ROUND(hp.VALUE / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1) as hard_parses_per_sec,
        ROUND((tp.VALUE - hp.VALUE) / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1) as soft_parses_per_sec
      FROM
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (hard)') hp,
        (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (total)') tp,
        (SELECT (SYSDATE - STARTUP_TIME) * 86400 as VALUE FROM V$INSTANCE) uptime
    `);

    // SGA component breakdown
    const compResult = await conn.execute(`
      SELECT NAME, ROUND(VALUE / 1024 / 1024 / 1024, 1) as gb
      FROM V$SGA
    `);

    const components = {};
    (compResult.rows || []).forEach(r => {
      const name = (r[0] || '').toLowerCase();
      if (name.includes('buffer')) components.buffer_cache_gb = parseFloat(r[1]) || 0;
      if (name.includes('shared')) components.shared_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('large')) components.large_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('java')) components.java_pool_gb = parseFloat(r[1]) || 0;
      if (name.includes('stream')) components.streams_pool_gb = parseFloat(r[1]) || 0;
    });

    return {
      sga_size_gb: parseFloat(sgaResult.rows?.[0]?.[0]) || 0,
      buffer_cache_gb: components.buffer_cache_gb || 0,
      shared_pool_gb: components.shared_pool_gb || 0,
      large_pool_gb: components.large_pool_gb || 0,
      java_pool_gb: components.java_pool_gb || 0,
      streams_pool_gb: components.streams_pool_gb || 0,
      buffer_cache_hit_ratio: parseFloat(hitResult.rows?.[0]?.[0]) || 0,
      library_cache_hit_ratio: parseFloat(libResult.rows?.[0]?.[0]) || 0,
      dictionary_cache_hit_ratio: parseFloat(dictResult.rows?.[0]?.[0]) || 0,
      shared_pool_free_pct: parseFloat(spResult.rows?.[0]?.[0]) || 0,
      hard_parses_per_sec: parseFloat(parseResult.rows?.[0]?.[0]) || 0,
      soft_parses_per_sec: parseFloat(parseResult.rows?.[0]?.[1]) || 0
    };
  } catch (err) {
    console.error('SGA stats query failed:', err.message);
    return {
      sga_size_gb: 0, buffer_cache_gb: 0, shared_pool_gb: 0,
      large_pool_gb: 0, java_pool_gb: 0, streams_pool_gb: 0,
      buffer_cache_hit_ratio: 0, library_cache_hit_ratio: 0,
      dictionary_cache_hit_ratio: 0, shared_pool_free_pct: 0,
      hard_parses_per_sec: 0, soft_parses_per_sec: 0
    };
  }
}

async function queryPgaStats(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1) as pga_target_gb,
        ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME = 'total PGA allocated'), 1) as pga_allocated_gb,
        ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME = 'maximum PGA allocated'), 1) as pga_max_gb,
        (SELECT VALUE FROM V$PGASTAT WHERE NAME = 'over allocation count') as over_alloc,
        ROUND((SELECT VALUE FROM V$PGASTAT WHERE NAME = 'cache hit percentage'), 1) as cache_hit_pct
      FROM DUAL
    `);

    // Get workarea execution stats
    const waResult = await conn.execute(`
      SELECT
        ROUND(optimal.cnt / NULLIF(total.cnt, 0) * 100, 1) as optimal_pct,
        ROUND(onepass.cnt / NULLIF(total.cnt, 0) * 100, 1) as onepass_pct,
        ROUND(multipass.cnt / NULLIF(total.cnt, 0) * 100, 1) as multipass_pct
      FROM
        (SELECT SUM(OPTIMAL_EXECUTIONS + ONEPASS_EXECUTIONS + MULTIPASSES_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) total,
        (SELECT SUM(OPTIMAL_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) optimal,
        (SELECT SUM(ONEPASS_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) onepass,
        (SELECT SUM(MULTIPASSES_EXECUTIONS) as cnt FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) multipass
    `);

    const row = result.rows?.[0] || [];
    const waRow = waResult.rows?.[0] || [];

    return {
      pga_target_gb: parseFloat(row[0]) || 0,
      pga_allocated_gb: parseFloat(row[1]) || 0,
      pga_max_allocated_gb: parseFloat(row[2]) || 0,
      over_allocation_count: parseInt(row[3]) || 0,
      cache_hit_pct: parseFloat(row[4]) || 0,
      optimal_executions_pct: parseFloat(waRow[0]) || 0,
      onepass_executions_pct: parseFloat(waRow[1]) || 0,
      multipass_executions_pct: parseFloat(waRow[2]) || 0
    };
  } catch (err) {
    console.error('PGA stats query failed:', err.message);
    return {
      pga_target_gb: 0, pga_allocated_gb: 0, pga_max_allocated_gb: 0,
      over_allocation_count: 0, cache_hit_pct: 0,
      optimal_executions_pct: 0, onepass_executions_pct: 0, multipass_executions_pct: 0
    };
  }
}

async function queryOsStats(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        STAT_NAME, VALUE
      FROM V$OSSTAT
      WHERE STAT_NAME IN (
        'NUM_CPUS', 'IDLE_TIME', 'BUSY_TIME', 'USER_TIME', 'SYS_TIME',
        'IOWAIT_TIME', 'PHYSICAL_MEMORY_BYTES', 'FREE_MEMORY_BYTES'
      )
    `);

    const stats = {};
    (result.rows || []).forEach(r => {
      stats[r[0]] = parseFloat(r[1]) || 0;
    });

    const totalCpuTime = (stats.IDLE_TIME || 0) + (stats.BUSY_TIME || 0);
    const cpuPct = totalCpuTime > 0 ? Math.round((stats.BUSY_TIME || 0) / totalCpuTime * 1000) / 10 : 0;
    const ioPct = totalCpuTime > 0 ? Math.round((stats.IOWAIT_TIME || 0) / totalCpuTime * 1000) / 10 : 0;

    return {
      cpu_count: parseInt(stats.NUM_CPUS) || 1,
      avg_cpu_utilization_pct: cpuPct,
      max_cpu_utilization_pct: Math.min(cpuPct * 1.3, 100), // Approximate
      avg_io_wait_pct: ioPct,
      physical_memory_gb: Math.round((stats.PHYSICAL_MEMORY_BYTES || 0) / 1024 / 1024 / 1024 * 10) / 10,
      free_memory_gb: Math.round((stats.FREE_MEMORY_BYTES || 0) / 1024 / 1024 / 1024 * 10) / 10,
      swap_used_gb: 0,
      avg_disk_read_ms: 0,
      avg_disk_write_ms: 0
    };
  } catch (err) {
    console.error('OS stats query failed:', err.message);
    return {
      cpu_count: 1, avg_cpu_utilization_pct: 0, max_cpu_utilization_pct: 0,
      avg_io_wait_pct: 0, physical_memory_gb: 0, free_memory_gb: 0,
      swap_used_gb: 0, avg_disk_read_ms: 0, avg_disk_write_ms: 0
    };
  }
}

// ============================================================
// Wave A: Undo, Temp, Alert Log, Resource Limits, SGA/PGA History
// ============================================================

/**
 * Check if AWR (Diagnostics Pack) is available on this database.
 * Gracefully falls back to current V$ views if not licensed.
 */
async function checkAwrAvailability(conn) {
  try {
    // DBA_HIST_UNDOSTAT exists only when Diagnostics Pack is licensed
    await conn.execute(`SELECT COUNT(*) FROM DBA_HIST_UNDOSTAT WHERE ROWNUM = 1`);
    return true;
  } catch (err) {
    return false; // Not licensed or view not accessible
  }
}

/**
 * Undo Usage — current V$UNDOSTAT + DBA_HIST_UNDOSTAT historical peaks
 */
async function queryUndoStats(conn, awrAvailable) {
  try {
    // Current undo stats from V$UNDOSTAT (last 10-min interval)
    const currentResult = await conn.execute(`
      SELECT
        UNDOBLKS,
        TXNCOUNT,
        MAXQUERYLEN,
        MAXCONCURRENCY,
        TUNED_UNDORETENTION,
        EXPIREDBLKS,
        UNEXPIREDBLKS,
        ACTIVEBLKS
      FROM V$UNDOSTAT
      WHERE ROWNUM = 1
      ORDER BY END_TIME DESC
    `);

    // Undo tablespace size from DBA_TABLESPACES + DBA_DATA_FILES
    const tsResult = await conn.execute(`
      SELECT
        d.TABLESPACE_NAME,
        SUM(d.BYTES) / 1073741824 AS TOTAL_GB,
        SUM(d.BYTES - NVL(f.FREE_BYTES, 0)) / 1073741824 AS USED_GB,
        ROUND(SUM(d.BYTES - NVL(f.FREE_BYTES, 0)) / SUM(d.BYTES) * 100, 1) AS PCT_USED,
        t.RETENTION AS RETENTION_MODE
      FROM DBA_DATA_FILES d
      JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = d.TABLESPACE_NAME
      LEFT JOIN (
        SELECT FILE_ID, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY FILE_ID
      ) f ON f.FILE_ID = d.FILE_ID
      WHERE t.CONTENTS = 'UNDO'
      GROUP BY d.TABLESPACE_NAME, t.RETENTION
    `);

    const row = (currentResult.rows || [[]])[0] || [];
    const tsRow = (tsResult.rows || [[]])[0] || [];

    const current = {
      undo_blocks: parseInt(row[0]) || 0,
      transaction_count: parseInt(row[1]) || 0,
      max_query_length_s: parseInt(row[2]) || 0,
      max_concurrency: parseInt(row[3]) || 0,
      tuned_undo_retention_s: parseInt(row[4]) || 900,
      expired_blocks: parseInt(row[5]) || 0,
      unexpired_blocks: parseInt(row[6]) || 0,
      active_blocks: parseInt(row[7]) || 0,
      tablespace_name: tsRow[0] || 'UNDOTBS1',
      total_gb: parseFloat(tsRow[1]) || 0,
      used_gb: parseFloat(tsRow[2]) || 0,
      pct_used: parseFloat(tsRow[3]) || 0,
      retention_mode: tsRow[4] || 'NOGUARANTEE'
    };

    let historical = { peak_pct_used: null, peak_time: null, peak_query_length_s: null, lookback_days: 30 };

    if (awrAvailable) {
      try {
        const histResult = await conn.execute(`
          SELECT
            ROUND(MAX(u.UNDOBLKS) / NULLIF(d.TOTAL_BLOCKS, 0) * 100, 1) AS PEAK_PCT,
            TO_CHAR(MAX(u.END_TIME) KEEP (DENSE_RANK LAST ORDER BY u.UNDOBLKS), 'YYYY-MM-DD HH24:MI') AS PEAK_TIME,
            MAX(u.MAXQUERYLEN) AS MAX_QUERY_LEN,
            ROUND(MAX(u.TUNED_UNDORETENTION) / 60, 0) AS MAX_TUNED_RETENTION_MIN
          FROM DBA_HIST_UNDOSTAT u
          CROSS JOIN (
            SELECT SUM(BLOCKS) AS TOTAL_BLOCKS
            FROM DBA_DATA_FILES df
            JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = df.TABLESPACE_NAME
            WHERE t.CONTENTS = 'UNDO'
          ) d
          WHERE u.END_TIME > SYSDATE - 30
        `);
        const hr = (histResult.rows || [[]])[0] || [];
        historical = {
          peak_pct_used: parseFloat(hr[0]) || null,
          peak_time: hr[1] || null,
          peak_query_length_s: parseInt(hr[2]) || null,
          max_tuned_retention_min: parseInt(hr[3]) || null,
          lookback_days: 30
        };
      } catch (e) { /* AWR query failed */ }
    }

    return { current, historical, awr_available: awrAvailable };
  } catch (err) {
    console.error('Undo stats query failed:', err.message);
    return {
      current: { tablespace_name: 'UNDOTBS1', total_gb: 0, used_gb: 0, pct_used: 0, tuned_undo_retention_s: 900, max_query_length_s: 0, retention_mode: 'NOGUARANTEE' },
      historical: { peak_pct_used: null, peak_time: null, lookback_days: 30 },
      awr_available: awrAvailable
    };
  }
}

/**
 * Temp Usage — current V$SORT_SEGMENT / DBA_TEMP_FREE_SPACE + historical peaks
 */
async function queryTempStats(conn, awrAvailable) {
  try {
    // Current temp usage
    const freeResult = await conn.execute(`
      SELECT
        TABLESPACE_NAME,
        ROUND(TABLESPACE_SIZE / 1073741824, 2) AS TOTAL_GB,
        ROUND(FREE_SPACE / 1073741824, 2) AS FREE_GB,
        ROUND((TABLESPACE_SIZE - FREE_SPACE) / NULLIF(TABLESPACE_SIZE, 0) * 100, 1) AS PCT_USED
      FROM DBA_TEMP_FREE_SPACE
    `);

    // Top temp consumers by session
    const sessionResult = await conn.execute(`
      SELECT
        s.SID,
        s.SERIAL#,
        NVL(p.USERNAME, s.USERNAME) AS USERNAME,
        ROUND(s.BLOCKS * t.BLOCK_SIZE / 1048576, 1) AS TEMP_MB,
        s.TABLESPACE
      FROM V$TEMPSEG_USAGE s
      JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = s.TABLESPACE
      JOIN V$SESSION p ON p.SID = s.SESSION_ADDR
      ORDER BY s.BLOCKS DESC
      FETCH FIRST 10 ROWS ONLY
    `).catch(() =>
      conn.execute(`
        SELECT s.SID, s.SERIAL#, s.USERNAME, ROUND(s.BLOCKS * 8192 / 1048576, 1) AS TEMP_MB, s.TABLESPACE
        FROM V$TEMPSEG_USAGE s ORDER BY s.BLOCKS DESC FETCH FIRST 10 ROWS ONLY
      `).catch(() => ({ rows: [] }))
    );

    const freeRow = (freeResult.rows || [[]])[0] || [];
    const totalGb = parseFloat(freeRow[1]) || 0;
    const freeGb = parseFloat(freeRow[2]) || 0;
    const usedGb = Math.max(0, totalGb - freeGb);

    const sessions = (sessionResult.rows || []).map(r => ({
      sid: r[0],
      serial: r[1],
      username: r[2] || 'UNKNOWN',
      temp_mb: parseFloat(r[3]) || 0,
      tablespace: r[4] || ''
    }));

    const current = {
      tablespace_name: freeRow[0] || 'TEMP',
      total_gb: totalGb,
      used_gb: usedGb,
      free_gb: freeGb,
      pct_used: parseFloat(freeRow[3]) || 0,
      top_sessions: sessions
    };

    let historical = { peak_gb: null, peak_pct: null, peak_time: null, lookback_days: 30 };

    if (awrAvailable) {
      try {
        const histResult = await conn.execute(`
          SELECT
            ROUND(MAX(SPACE_USED_TOTAL) / 1073741824, 2) AS PEAK_GB,
            ROUND(MAX(SPACE_USED_TOTAL) / NULLIF(MAX(TABLESPACE_SIZE), 0) * 100, 1) AS PEAK_PCT,
            TO_CHAR(MAX(SNAP_TIME) KEEP (DENSE_RANK LAST ORDER BY SPACE_USED_TOTAL), 'YYYY-MM-DD HH24:MI') AS PEAK_TIME
          FROM (
            SELECT
              h.SNAP_ID,
              s.END_INTERVAL_TIME AS SNAP_TIME,
              SUM(h.TABLESPACE_USEDSIZE * 8192) AS SPACE_USED_TOTAL,
              SUM(h.TABLESPACE_SIZE * 8192) AS TABLESPACE_SIZE
            FROM DBA_HIST_TBSPC_SPACE_USAGE h
            JOIN DBA_HIST_SNAPSHOT s ON s.SNAP_ID = h.SNAP_ID
            JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME =
              (SELECT TABLESPACE_NAME FROM DBA_TABLESPACE_GROUPS WHERE ROWNUM=1 UNION ALL SELECT TABLESPACE_NAME FROM DBA_TABLESPACES WHERE CONTENTS='TEMPORARY' AND ROWNUM=1)
            WHERE s.END_INTERVAL_TIME > SYSDATE - 30
            GROUP BY h.SNAP_ID, s.END_INTERVAL_TIME
          )
        `).catch(() =>
          conn.execute(`
            SELECT NULL, NULL, NULL FROM DUAL
          `)
        );
        const hr = (histResult.rows || [[]])[0] || [];
        historical = {
          peak_gb: parseFloat(hr[0]) || null,
          peak_pct: parseFloat(hr[1]) || null,
          peak_time: hr[2] || null,
          lookback_days: 30
        };
      } catch (e) { /* AWR query failed */ }
    }

    return { current, historical, awr_available: awrAvailable };
  } catch (err) {
    console.error('Temp stats query failed:', err.message);
    return {
      current: { tablespace_name: 'TEMP', total_gb: 0, used_gb: 0, free_gb: 0, pct_used: 0, top_sessions: [] },
      historical: { peak_gb: null, peak_pct: null, peak_time: null, lookback_days: 30 },
      awr_available: awrAvailable
    };
  }
}

/**
 * Alert Log — last 24 hours from V$DIAG_ALERT_EXT
 */
async function queryAlertLog(conn) {
  try {
    const result = await conn.execute(`
      SELECT
        TO_CHAR(ORIGINATING_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS,
        MESSAGE_TEXT
      FROM V$DIAG_ALERT_EXT
      WHERE ORIGINATING_TIMESTAMP > SYSDATE - 1
        AND (
          MESSAGE_TEXT LIKE 'ORA-%'
          OR MESSAGE_TEXT LIKE '%checkpoint%'
          OR MESSAGE_TEXT LIKE '%corruption%'
          OR MESSAGE_TEXT LIKE '%recovery%'
          OR MESSAGE_TEXT LIKE '%error%'
          OR MESSAGE_TEXT LIKE '%warning%'
          OR MESSAGE_TEXT LIKE '%TNS-%'
          OR MESSAGE_TEXT LIKE '%instance%'
          OR MESSAGE_TEXT LIKE 'Thread%'
        )
      ORDER BY ORIGINATING_TIMESTAMP DESC
      FETCH FIRST 200 ROWS ONLY
    `);

    const entries = (result.rows || []).map(r => ({
      ts: r[0] || '',
      message: (r[1] || '').trim()
    }));

    // Classify each entry
    const classified = entries.map(e => {
      const msg = e.message;
      let severity = 'info';
      if (/ORA-600|ORA-7445|ORA-1578|ORA-04031|ORA-01555/.test(msg)) severity = 'critical';
      else if (/ORA-\d{4,5}/.test(msg)) severity = 'warning';
      else if (/checkpoint not complete|cannot allocate new log|block corruption|instance termination|ORA-04031/.test(msg.toLowerCase())) severity = 'critical';
      else if (/checkpoint|redo log switch|archiv|TNS-1\d{4}/.test(msg.toLowerCase())) severity = 'warning';
      else if (/TNS-12560|TNS-12537|opiodr aborting|Fatal NI/.test(msg)) severity = 'noise';
      return { ...e, severity };
    });

    const summary = {
      total: classified.length,
      critical: classified.filter(e => e.severity === 'critical').length,
      warning: classified.filter(e => e.severity === 'warning').length,
      info: classified.filter(e => e.severity === 'info').length,
      noise: classified.filter(e => e.severity === 'noise').length
    };

    return { entries: classified.slice(0, 100), summary };
  } catch (err) {
    console.error('Alert log query failed:', err.message);
    // V$DIAG_ALERT_EXT may require additional privilege
    return { entries: [], summary: { total: 0, critical: 0, warning: 0, info: 0, noise: 0 }, error: err.message };
  }
}

/**
 * Resource Limits — current V$RESOURCE_LIMIT + DBA_HIST_RESOURCE_LIMIT peaks
 */
async function queryResourceLimits(conn, awrAvailable) {
  try {
    const currentResult = await conn.execute(`
      SELECT
        RESOURCE_NAME,
        CURRENT_UTILIZATION,
        MAX_UTILIZATION,
        INITIAL_ALLOCATION,
        LIMIT_VALUE
      FROM V$RESOURCE_LIMIT
      WHERE RESOURCE_NAME IN (
        'sessions', 'processes', 'enqueue_locks', 'enqueue_resources',
        'dml_locks', 'temporary_table_locks', 'transactions',
        'max_rollback_segments', 'sort_segment_locks'
      )
      ORDER BY
        CASE RESOURCE_NAME
          WHEN 'sessions' THEN 1 WHEN 'processes' THEN 2 WHEN 'transactions' THEN 3
          WHEN 'enqueue_locks' THEN 4 WHEN 'enqueue_resources' THEN 5
          WHEN 'dml_locks' THEN 6 ELSE 9 END
    `);

    const current = (currentResult.rows || []).map(r => {
      const limitVal = r[4] === 'UNLIMITED' ? null : (parseInt(r[4]) || null);
      const maxUtil = parseInt(r[2]) || 0;
      const pctUsed = limitVal ? Math.round(maxUtil / limitVal * 100) : null;
      return {
        resource: r[0] || '',
        current_utilization: parseInt(r[1]) || 0,
        max_utilization: maxUtil,
        initial_allocation: r[3] || '0',
        limit_value: limitVal,
        limit_display: r[4] || '0',
        pct_max_used: pctUsed,
        status: pctUsed !== null ? (pctUsed >= 90 ? 'critical' : pctUsed >= 80 ? 'warning' : 'ok') : 'ok'
      };
    });

    let historical = [];

    if (awrAvailable) {
      try {
        const histResult = await conn.execute(`
          SELECT
            RESOURCE_NAME,
            MAX(CURRENT_UTILIZATION) AS HIST_MAX_UTIL,
            MAX(MAX_UTILIZATION) AS HIST_PEAK_UTIL
          FROM DBA_HIST_RESOURCE_LIMIT
          WHERE SNAP_ID IN (
            SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT WHERE END_INTERVAL_TIME > SYSDATE - 30
          )
          GROUP BY RESOURCE_NAME
        `);
        const histMap = {};
        (histResult.rows || []).forEach(r => {
          histMap[r[0]] = { hist_max: parseInt(r[1]) || 0, hist_peak: parseInt(r[2]) || 0 };
        });
        historical = histMap;
      } catch (e) { /* AWR failed */ }
    }

    return { current, historical, awr_available: awrAvailable };
  } catch (err) {
    console.error('Resource limits query failed:', err.message);
    return { current: [], historical: {}, awr_available: awrAvailable };
  }
}

/**
 * SGA/PGA Historical Sizing from DBA_HIST_PGASTAT, DBA_HIST_SGA, V$SGA_RESIZE_OPS
 */
async function querySgaPgaHistory(conn, awrAvailable) {
  try {
    // Current SGA/PGA targets from V$PARAMETER
    const paramResult = await conn.execute(`
      SELECT NAME, VALUE
      FROM V$PARAMETER
      WHERE NAME IN ('sga_target', 'pga_aggregate_target', 'sga_max_size', 'memory_target', 'memory_max_target')
    `);

    const params = {};
    (paramResult.rows || []).forEach(r => {
      params[r[0]] = parseInt(r[1]) || 0;
    });

    const sgaTargetGb = Math.round((params['sga_target'] || 0) / 1073741824 * 10) / 10;
    const pgaTargetGb = Math.round((params['pga_aggregate_target'] || 0) / 1073741824 * 10) / 10;
    const sgaMaxGb = Math.round((params['sga_max_size'] || 0) / 1073741824 * 10) / 10;
    const memTargetGb = Math.round((params['memory_target'] || 0) / 1073741824 * 10) / 10;

    // Recent ASMM resize operations
    const resizeResult = await conn.execute(`
      SELECT
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI') AS OP_TIME,
        COMPONENT,
        OPER_TYPE,
        ROUND(INITIAL_SIZE / 1073741824, 2) AS FROM_GB,
        ROUND(FINAL_SIZE / 1073741824, 2) AS TO_GB,
        STATUS
      FROM V$SGA_RESIZE_OPS
      ORDER BY START_TIME DESC
      FETCH FIRST 20 ROWS ONLY
    `).catch(() => ({ rows: [] }));

    const resizeOps = (resizeResult.rows || []).map(r => ({
      op_time: r[0] || '',
      component: r[1] || '',
      oper_type: r[2] || '',
      from_gb: parseFloat(r[3]) || 0,
      to_gb: parseFloat(r[4]) || 0,
      status: r[5] || ''
    }));

    let pgaHistory = { peak_allocated_gb: null, peak_time: null };
    let sgaComponentHistory = [];

    if (awrAvailable) {
      try {
        // PGA peak from DBA_HIST_PGASTAT
        const pgaHistResult = await conn.execute(`
          SELECT
            ROUND(MAX(VALUE) / 1073741824, 2) AS PEAK_PGA_GB,
            TO_CHAR(MAX(s.END_INTERVAL_TIME) KEEP (DENSE_RANK LAST ORDER BY p.VALUE), 'YYYY-MM-DD HH24:MI') AS PEAK_TIME
          FROM DBA_HIST_PGASTAT p
          JOIN DBA_HIST_SNAPSHOT s ON s.SNAP_ID = p.SNAP_ID
          WHERE p.NAME = 'maximum PGA allocated'
            AND s.END_INTERVAL_TIME > SYSDATE - 30
        `);
        const pr = (pgaHistResult.rows || [[]])[0] || [];
        pgaHistory = {
          peak_allocated_gb: parseFloat(pr[0]) || null,
          peak_time: pr[1] || null,
          lookback_days: 30
        };
      } catch (e) { /* AWR failed */ }

      try {
        // SGA component history from DBA_HIST_SGA
        const sgaHistResult = await conn.execute(`
          SELECT
            NAME AS COMPONENT,
            ROUND(MAX(VALUE) / 1073741824, 2) AS PEAK_GB,
            ROUND(MIN(VALUE) / 1073741824, 2) AS MIN_GB
          FROM DBA_HIST_SGA
          WHERE SNAP_ID IN (
            SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT WHERE END_INTERVAL_TIME > SYSDATE - 30
          )
            AND NAME IN ('Database Buffers', 'Shared Pool Size', 'Large Pool Size', 'Java Pool Size')
          GROUP BY NAME
        `);
        sgaComponentHistory = (sgaHistResult.rows || []).map(r => ({
          component: r[0] || '',
          peak_gb: parseFloat(r[1]) || 0,
          min_gb: parseFloat(r[2]) || 0
        }));
      } catch (e) { /* AWR failed */ }
    }

    return {
      current: { sga_target_gb: sgaTargetGb, pga_target_gb: pgaTargetGb, sga_max_gb: sgaMaxGb, memory_target_gb: memTargetGb },
      resize_ops: resizeOps,
      pga_history: pgaHistory,
      sga_component_history: sgaComponentHistory,
      awr_available: awrAvailable
    };
  } catch (err) {
    console.error('SGA/PGA history query failed:', err.message);
    return {
      current: { sga_target_gb: 0, pga_target_gb: 0, sga_max_gb: 0, memory_target_gb: 0 },
      resize_ops: [],
      pga_history: { peak_allocated_gb: null, peak_time: null },
      sga_component_history: [],
      awr_available: awrAvailable
    };
  }
}

// ============================================================
// Wave B: Backup & Recovery Health Checks
// ============================================================

/**
 * Master function — runs all 4 backup checks and returns structured backup_stats.
 * Gracefully handles non-RMAN databases (all checks return null on failure).
 */
async function queryBackupStats(conn) {
  const [rmanBackup, fraUsage, archivelogRate, backupValidation] = await Promise.all([
    queryRmanBackup(conn),
    queryFraUsage(conn),
    queryArchivelogRate(conn),
    queryBackupValidation(conn)
  ]);

  // Compute overall backup status (worst of the 4 checks)
  const statuses = [rmanBackup, fraUsage, archivelogRate, backupValidation]
    .map(c => (c && c.status) || 'unknown');
  const overallStatus = statuses.includes('critical') ? 'critical'
    : statuses.includes('warning') ? 'warning'
    : statuses.every(s => s === 'ok') ? 'ok' : 'unknown';

  return { rman_backup: rmanBackup, fra_usage: fraUsage, archivelog_rate: archivelogRate, backup_validation: backupValidation, overall_status: overallStatus };
}

/**
 * Check 1: RMAN Backup Freshness
 * 🔴 no full backup in >48h | 🟡 >24h | 🟢 <24h
 */
async function queryRmanBackup(conn) {
  try {
    // Last backup job by type from V$RMAN_BACKUP_JOB_DETAILS
    const jobResult = await conn.execute(`
      SELECT
        INPUT_TYPE,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        ROUND((SYSDATE - END_TIME) * 24, 1) AS HOURS_AGO,
        ROUND(OUTPUT_BYTES / 1073741824, 2) AS SIZE_GB,
        ELAPSED_SECONDS
      FROM (
        SELECT INPUT_TYPE, STATUS, START_TIME, END_TIME, OUTPUT_BYTES, ELAPSED_SECONDS,
               ROW_NUMBER() OVER (PARTITION BY INPUT_TYPE ORDER BY END_TIME DESC) AS RN
        FROM V$RMAN_BACKUP_JOB_DETAILS
        WHERE STATUS = 'COMPLETED'
      )
      WHERE RN = 1
      ORDER BY
        CASE INPUT_TYPE WHEN 'DB FULL' THEN 1 WHEN 'DB INCR' THEN 2 WHEN 'ARCHIVELOG' THEN 3 ELSE 4 END
    `).catch(() => ({ rows: [] }));

    // Recent backup jobs (last 10 regardless of type)
    const recentResult = await conn.execute(`
      SELECT
        INPUT_TYPE,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        ROUND((SYSDATE - END_TIME) * 24, 1) AS HOURS_AGO,
        ROUND(OUTPUT_BYTES / 1073741824, 2) AS SIZE_GB,
        ELAPSED_SECONDS
      FROM V$RMAN_BACKUP_JOB_DETAILS
      ORDER BY START_TIME DESC
      FETCH FIRST 10 ROWS ONLY
    `).catch(() => ({ rows: [] }));

    const lastByType = (jobResult.rows || []).map(r => ({
      input_type: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      hours_ago: parseFloat(r[4]) || 0,
      size_gb: parseFloat(r[5]) || 0,
      elapsed_seconds: parseInt(r[6]) || 0
    }));

    const recentJobs = (recentResult.rows || []).map(r => ({
      input_type: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      hours_ago: parseFloat(r[4]) || 0,
      size_gb: parseFloat(r[5]) || 0,
      elapsed_seconds: parseInt(r[6]) || 0
    }));

    // Find last full backup age
    const fullBackup = lastByType.find(b => b.input_type === 'DB FULL');
    const incrBackup = lastByType.find(b => b.input_type === 'DB INCR');
    const archBackup = lastByType.find(b => b.input_type === 'ARCHIVELOG');

    const fullHoursAgo = fullBackup ? fullBackup.hours_ago : null;
    let status = 'unknown';
    if (recentJobs.length === 0 && lastByType.length === 0) {
      status = 'unknown'; // No RMAN usage detected
    } else if (fullHoursAgo === null) {
      status = 'critical'; // No full backup ever
    } else if (fullHoursAgo > 48) {
      status = 'critical';
    } else if (fullHoursAgo > 24) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      rman_available: recentJobs.length > 0 || lastByType.length > 0,
      last_by_type: lastByType,
      recent_jobs: recentJobs,
      full_backup_hours_ago: fullHoursAgo,
      last_full_backup: fullBackup || null,
      last_incremental_backup: incrBackup || null,
      last_archivelog_backup: archBackup || null
    };
  } catch (err) {
    console.error('RMAN backup query failed:', err.message);
    return { status: 'unknown', rman_available: false, last_by_type: [], recent_jobs: [], error: err.message };
  }
}

/**
 * Check 2: Fast Recovery Area (FRA) Usage
 * 🔴 >90% used AND <10% reclaimable | 🟡 >80% | 🟢 <80%
 */
async function queryFraUsage(conn) {
  try {
    // FRA overview from V$RECOVERY_FILE_DEST
    const destResult = await conn.execute(`
      SELECT
        NAME,
        ROUND(SPACE_LIMIT / 1073741824, 2) AS LIMIT_GB,
        ROUND(SPACE_USED / 1073741824, 2) AS USED_GB,
        ROUND(SPACE_RECLAIMABLE / 1073741824, 2) AS RECLAIMABLE_GB,
        NUMBER_OF_FILES
      FROM V$RECOVERY_FILE_DEST
    `).catch(() => ({ rows: [] }));

    // Breakdown by file type from V$FLASH_RECOVERY_AREA_USAGE
    const usageResult = await conn.execute(`
      SELECT
        FILE_TYPE,
        ROUND(PERCENT_SPACE_USED, 1) AS PCT_USED,
        ROUND(PERCENT_SPACE_RECLAIMABLE, 1) AS PCT_RECLAIMABLE,
        NUMBER_OF_FILES
      FROM V$FLASH_RECOVERY_AREA_USAGE
      ORDER BY PERCENT_SPACE_USED DESC
    `).catch(() => ({ rows: [] }));

    // Archivelog generation rate (last 24h) for "hours until full" prediction
    const genRateResult = await conn.execute(`
      SELECT
        ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1073741824, 2) AS ARCHIVELOGS_24H_GB
      FROM V$ARCHIVED_LOG
      WHERE COMPLETION_TIME > SYSDATE - 1
        AND STANDBY_DEST = 'NO'
    `).catch(() => ({ rows: [[0]] }));

    const destRow = (destResult.rows || [[]])[0] || [];
    const limitGb = parseFloat(destRow[1]) || 0;
    const usedGb = parseFloat(destRow[2]) || 0;
    const reclaimableGb = parseFloat(destRow[3]) || 0;
    const fraLocation = destRow[0] || '';

    const pctUsed = limitGb > 0 ? Math.round((usedGb / limitGb) * 1000) / 10 : 0;
    const pctReclaimable = limitGb > 0 ? Math.round((reclaimableGb / limitGb) * 1000) / 10 : 0;
    const archivelogs24hGb = parseFloat((genRateResult.rows || [[0]])[0]?.[0]) || 0;

    // Hours until FRA full: (limitGb - usedGb + reclaimableGb) / hourly_rate
    const availableGb = limitGb - usedGb + reclaimableGb;
    const hourlyRateGb = archivelogs24hGb / 24;
    const hoursUntilFull = (hourlyRateGb > 0 && limitGb > 0)
      ? Math.round(availableGb / hourlyRateGb)
      : null;

    const fileTypeBreakdown = (usageResult.rows || []).map(r => ({
      file_type: r[0] || '',
      pct_used: parseFloat(r[1]) || 0,
      pct_reclaimable: parseFloat(r[2]) || 0,
      number_of_files: parseInt(r[3]) || 0
    }));

    let status = 'unknown';
    if (limitGb === 0) {
      status = 'unknown'; // FRA not configured
    } else if (pctUsed > 90 && pctReclaimable < 10) {
      status = 'critical';
    } else if (pctUsed > 80) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      fra_configured: limitGb > 0,
      location: fraLocation,
      limit_gb: limitGb,
      used_gb: usedGb,
      reclaimable_gb: reclaimableGb,
      pct_used: pctUsed,
      pct_reclaimable: pctReclaimable,
      archivelogs_24h_gb: archivelogs24hGb,
      hours_until_full: hoursUntilFull,
      file_type_breakdown: fileTypeBreakdown
    };
  } catch (err) {
    console.error('FRA usage query failed:', err.message);
    return { status: 'unknown', fra_configured: false, error: err.message };
  }
}

/**
 * Check 3: Archivelog Generation Rate
 * 🟡 if switch frequency >20/hour | 🔴 if checkpoint-not-complete errors in alert log
 */
async function queryArchivelogRate(conn) {
  try {
    // Archivelog mode + current sequence
    const modeResult = await conn.execute(`
      SELECT
        LOG_MODE,
        ROUND((SYSDATE - STARTUP_TIME) * 24) AS HOURS_UP
      FROM V$DATABASE, V$INSTANCE
    `).catch(() => ({ rows: [['ARCHIVELOG', 0]] }));

    // Recent archivelog generation (last 24h)
    const archResult = await conn.execute(`
      SELECT
        TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24') AS HOUR,
        COUNT(*) AS LOG_COUNT,
        ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1048576, 1) AS SIZE_MB
      FROM V$ARCHIVED_LOG
      WHERE COMPLETION_TIME > SYSDATE - 1
        AND STANDBY_DEST = 'NO'
      GROUP BY TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24')
      ORDER BY HOUR DESC
    `).catch(() => ({ rows: [] }));

    // Redo log groups and sizes
    const logResult = await conn.execute(`
      SELECT
        l.GROUP#,
        l.MEMBERS,
        ROUND(l.BYTES / 1048576, 0) AS SIZE_MB,
        l.STATUS,
        l.ARCHIVED
      FROM V$LOG l
      ORDER BY l.GROUP#
    `).catch(() => ({ rows: [] }));

    // Log switch frequency from V$LOG_HISTORY (last 24h)
    const switchResult = await conn.execute(`
      SELECT
        ROUND(COUNT(*) / 24.0, 1) AS SWITCHES_PER_HOUR,
        COUNT(*) AS SWITCHES_24H
      FROM V$LOG_HISTORY
      WHERE FIRST_TIME > SYSDATE - 1
    `).catch(() => ({ rows: [[0, 0]] }));

    const modeRow = (modeResult.rows || [['ARCHIVELOG', 0]])[0] || ['ARCHIVELOG', 0];
    const logMode = modeRow[0] || 'ARCHIVELOG';

    const archHourly = (archResult.rows || []).map(r => ({
      hour: r[0] || '',
      log_count: parseInt(r[1]) || 0,
      size_mb: parseFloat(r[2]) || 0
    }));

    const logGroups = (logResult.rows || []).map(r => ({
      group_num: parseInt(r[0]) || 0,
      members: parseInt(r[1]) || 0,
      size_mb: parseInt(r[2]) || 0,
      status: r[3] || '',
      archived: r[4] || ''
    }));

    const switchRow = (switchResult.rows || [[0, 0]])[0] || [0, 0];
    const switchesPerHour = parseFloat(switchRow[0]) || 0;
    const switches24h = parseInt(switchRow[1]) || 0;

    const totalArchivelogs24h = archHourly.reduce((sum, h) => sum + h.log_count, 0);
    const totalSizeMb24h = archHourly.reduce((sum, h) => sum + h.size_mb, 0);

    let status = 'ok';
    if (logMode !== 'ARCHIVELOG') {
      status = 'critical'; // Not in archivelog mode
    } else if (switchesPerHour > 20) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      log_mode: logMode,
      archivelog_mode: logMode === 'ARCHIVELOG',
      switches_per_hour: switchesPerHour,
      switches_24h: switches24h,
      archivelogs_24h: totalArchivelogs24h,
      total_size_mb_24h: totalSizeMb24h,
      hourly_breakdown: archHourly.slice(0, 24),
      log_groups: logGroups
    };
  } catch (err) {
    console.error('Archivelog rate query failed:', err.message);
    return { status: 'unknown', archivelog_mode: null, error: err.message };
  }
}

/**
 * Check 4: Backup Validation
 * 🔴 if any corruption found or last 3 RMAN jobs failed
 */
async function queryBackupValidation(conn) {
  try {
    // Recent RMAN operations from V$RMAN_STATUS
    const rmanStatusResult = await conn.execute(`
      SELECT
        OPERATION,
        STATUS,
        TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS START_TIME,
        TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS') AS END_TIME,
        MBYTES_PROCESSED,
        OUTPUT
      FROM V$RMAN_STATUS
      WHERE OPERATION IN ('BACKUP', 'RESTORE', 'RECOVER', 'DELETE', 'VALIDATE')
        AND START_TIME > SYSDATE - 7
      ORDER BY START_TIME DESC
      FETCH FIRST 20 ROWS ONLY
    `).catch(() => ({ rows: [] }));

    // Backup corruption from V$BACKUP_CORRUPTION
    const backupCorrResult = await conn.execute(`
      SELECT
        COUNT(*) AS CORRUPT_COUNT,
        SUM(BLOCKS) AS CORRUPT_BLOCKS
      FROM V$BACKUP_CORRUPTION
    `).catch(() => ({ rows: [[0, 0]] }));

    // Copy corruption from V$COPY_CORRUPTION
    const copyCorrResult = await conn.execute(`
      SELECT
        COUNT(*) AS CORRUPT_COUNT,
        SUM(BLOCKS) AS CORRUPT_BLOCKS
      FROM V$COPY_CORRUPTION
    `).catch(() => ({ rows: [[0, 0]] }));

    const rmanOps = (rmanStatusResult.rows || []).map(r => ({
      operation: r[0] || '',
      status: r[1] || '',
      start_time: r[2] || '',
      end_time: r[3] || '',
      mbytes_processed: parseFloat(r[4]) || 0,
      output: (r[5] || '').substring(0, 300)
    }));

    const backupCorrupt = parseInt((backupCorrResult.rows || [[0]])[0]?.[0]) || 0;
    const backupCorruptBlocks = parseInt((backupCorrResult.rows || [[0, 0]])[0]?.[1]) || 0;
    const copyCorrupt = parseInt((copyCorrResult.rows || [[0]])[0]?.[0]) || 0;
    const copyCorruptBlocks = parseInt((copyCorrResult.rows || [[0, 0]])[0]?.[1]) || 0;
    const totalCorruptions = backupCorrupt + copyCorrupt;

    // Check last 3 RMAN backup jobs
    const recentBackups = rmanOps.filter(op => op.operation === 'BACKUP').slice(0, 3);
    const last3Failed = recentBackups.length > 0 && recentBackups.every(b => b.status === 'FAILED');

    let status = 'ok';
    if (totalCorruptions > 0) {
      status = 'critical';
    } else if (last3Failed) {
      status = 'critical';
    } else if (recentBackups.some(b => b.status === 'FAILED')) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      status,
      backup_corruptions: backupCorrupt,
      backup_corrupt_blocks: backupCorruptBlocks,
      copy_corruptions: copyCorrupt,
      copy_corrupt_blocks: copyCorruptBlocks,
      total_corruptions: totalCorruptions,
      recent_operations: rmanOps,
      last_3_backups_failed: last3Failed
    };
  } catch (err) {
    console.error('Backup validation query failed:', err.message);
    return { status: 'unknown', total_corruptions: 0, error: err.message };
  }
}

// ============================================================
// Application Fingerprinting Engine
// Probes data dictionary views to detect known Oracle application
// schemas. Each probe is independent — one failure never blocks others.
// Falls back from dba_users → all_users when insufficient privileges.
// Returns an array of { key, label, version? } for detected apps.
// ============================================================

async function detectApplications(conn) {
  const detected = [];

  // Resolve available users view (DBA_USERS preferred; fall back to ALL_USERS)
  let usersView = 'dba_users';
  try {
    await conn.execute(`SELECT COUNT(*) FROM dba_users WHERE ROWNUM = 1`);
  } catch (e) {
    usersView = 'all_users';
  }

  // Helper: check if a schema/user exists
  async function schemaExists(schemaName) {
    try {
      const r = await conn.execute(
        `SELECT COUNT(*) FROM ${usersView} WHERE UPPER(username) = UPPER(:1)`,
        [schemaName]
      );
      return (r.rows?.[0]?.[0] || 0) > 0;
    } catch (e) { return false; }
  }

  // Helper: check if a table exists in a given owner
  async function tableExists(owner, tableName) {
    try {
      const view = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
      const r = await conn.execute(
        `SELECT COUNT(*) FROM ${view} WHERE UPPER(owner) = UPPER(:1) AND UPPER(table_name) = UPPER(:2)`,
        [owner, tableName]
      );
      return (r.rows?.[0]?.[0] || 0) > 0;
    } catch (e) { return false; }
  }

  // Helper: get a scalar string value from Oracle
  async function queryString(sql, binds) {
    try {
      const r = await conn.execute(sql, binds || []);
      return r.rows?.[0]?.[0] || null;
    } catch (e) { return null; }
  }

  // Run all probes in parallel for speed; each is independently caught.
  const probes = [

    // ── EBS: APPS schema + FND_CONCURRENT_QUEUES table ──
    (async () => {
      try {
        const hasApps = await schemaExists('APPS');
        if (!hasApps) return;
        const hasFnd = await tableExists('APPS', 'FND_CONCURRENT_QUEUES');
        if (!hasFnd) return;
        // Try to read the EBS release
        const release = await queryString(
          `SELECT RELEASE_NAME FROM APPS.FND_PRODUCT_GROUPS WHERE ROWNUM = 1`
        );
        detected.push({ key: 'EBS', label: release ? `EBS ${release}` : 'EBS', schema: 'APPS' });
      } catch (e) { /* ignore */ }
    })(),

    // ── SOA Suite: SOAINFRA schema + COMPOSITE_DN or MDS schema ──
    (async () => {
      try {
        const hasSoa = await schemaExists('SOAINFRA');
        if (!hasSoa) return;
        const hasComposite = await tableExists('SOAINFRA', 'COMPOSITE_DN');
        if (!hasComposite) return;
        detected.push({ key: 'SOA', label: 'SOA Suite', schema: 'SOAINFRA' });
      } catch (e) { /* ignore */ }
    })(),

    // ── MDS (SOA/ADF Metadata): MDS schema ──
    (async () => {
      try {
        const hasMds = await schemaExists('MDS');
        if (!hasMds) return;
        detected.push({ key: 'MDS', label: 'MDS', schema: 'MDS' });
      } catch (e) { /* ignore */ }
    })(),

    // ── OAM (Oracle Access Manager): OAM or OAM_OAM user ──
    (async () => {
      try {
        const hasOam = await schemaExists('OAM') || await schemaExists('OAM_OAM');
        if (!hasOam) return;
        detected.push({ key: 'OAM', label: 'OAM', schema: 'OAM' });
      } catch (e) { /* ignore */ }
    })(),

    // ── OID (Oracle Internet Directory): ODS schema + CT_CN / DS_ATTRSTORE ──
    (async () => {
      try {
        const hasOds = await schemaExists('ODS');
        if (!hasOds) return;
        const hasCt = await tableExists('ODS', 'CT_CN');
        const hasDs = await tableExists('ODS', 'DS_ATTRSTORE');
        if (!hasCt && !hasDs) return;
        detected.push({ key: 'OID', label: 'OID', schema: 'ODS' });
      } catch (e) { /* ignore */ }
    })(),

    // ── Hyperion / EPM: HSSYS, PLANNING, ESSBASE, or FDMEE schema ──
    (async () => {
      try {
        const schemas = ['HSSYS', 'PLANNING', 'ESSBASE', 'FDMEE'];
        const found = [];
        for (const s of schemas) {
          if (await schemaExists(s)) found.push(s);
        }
        if (found.length === 0) return;
        detected.push({ key: 'EPM', label: 'Hyperion/EPM', schemas: found });
      } catch (e) { /* ignore */ }
    })(),

    // ── PeopleSoft: SYSADM schema + PSSTATUS + PSOPRDEFN ──
    (async () => {
      try {
        const hasSys = await schemaExists('SYSADM');
        if (!hasSys) return;
        const hasPs = await tableExists('SYSADM', 'PSSTATUS');
        if (!hasPs) return;
        detected.push({ key: 'PSFT', label: 'PeopleSoft', schema: 'SYSADM' });
      } catch (e) { /* ignore */ }
    })(),

    // ── Siebel: S_REPOSITORY or S_APP_VIEW tables (any owner) ──
    (async () => {
      try {
        const view = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
        const r = await conn.execute(
          `SELECT COUNT(*) FROM ${view} WHERE UPPER(table_name) IN ('S_REPOSITORY','S_APP_VIEW') AND ROWNUM = 1`
        );
        if ((r.rows?.[0]?.[0] || 0) === 0) return;
        detected.push({ key: 'SIEBEL', label: 'Siebel', schema: 'SIEBEL' });
      } catch (e) { /* ignore */ }
    })(),

    // ── OBIEE: BIPLATFORM schema or S_NQ_% tables ──
    (async () => {
      try {
        const hasBi = await schemaExists('BIPLATFORM');
        if (!hasBi) {
          const view = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
          const r = await conn.execute(
            `SELECT COUNT(*) FROM ${view} WHERE UPPER(table_name) LIKE 'S_NQ_%' AND ROWNUM = 1`
          );
          if ((r.rows?.[0]?.[0] || 0) === 0) return;
        }
        detected.push({ key: 'OBIEE', label: 'OBIEE', schema: 'BIPLATFORM' });
      } catch (e) { /* ignore */ }
    })(),

    // ── APEX: APEX_% user + apex_release ──
    (async () => {
      try {
        const view = usersView === 'dba_users' ? 'dba_users' : 'all_users';
        const r = await conn.execute(
          `SELECT username FROM ${view} WHERE UPPER(username) LIKE 'APEX_%' AND ROWNUM = 1`
        );
        if ((r.rows || []).length === 0) return;
        const apexSchema = r.rows[0][0];
        const ver = await queryString(
          `SELECT VERSION_NO FROM ${apexSchema}.APEX_RELEASE WHERE ROWNUM = 1`
        );
        detected.push({ key: 'APEX', label: ver ? `APEX ${ver}` : 'APEX', schema: apexSchema });
      } catch (e) { /* ignore */ }
    })(),

    // ── ODI: SNP_% tables or ODI% owner ──
    (async () => {
      try {
        const view = usersView === 'dba_users' ? 'dba_users' : 'all_users';
        const r = await conn.execute(
          `SELECT username FROM ${view} WHERE UPPER(username) LIKE 'ODI%' AND ROWNUM = 1`
        );
        if ((r.rows || []).length > 0) {
          detected.push({ key: 'ODI', label: 'ODI', schema: r.rows[0][0] });
          return;
        }
        const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
        const t = await conn.execute(
          `SELECT COUNT(*) FROM ${tView} WHERE UPPER(table_name) LIKE 'SNP_%' AND ROWNUM = 1`
        );
        if ((t.rows?.[0]?.[0] || 0) > 0) {
          detected.push({ key: 'ODI', label: 'ODI', schema: null });
        }
      } catch (e) { /* ignore */ }
    })(),

    // ── GoldenGate: GGS_% tables or GG_MARKER ──
    (async () => {
      try {
        const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
        const r = await conn.execute(
          `SELECT COUNT(*) FROM ${tView} WHERE (UPPER(table_name) LIKE 'GGS_%' OR UPPER(table_name) = 'GG_MARKER') AND ROWNUM = 1`
        );
        if ((r.rows?.[0]?.[0] || 0) === 0) return;
        detected.push({ key: 'GG', label: 'GoldenGate', schema: null });
      } catch (e) { /* ignore */ }
    })(),

    // ── WebLogic/OPSS: OPSS or IAU schema ──
    (async () => {
      try {
        const hasOpss = await schemaExists('OPSS') || await schemaExists('IAU');
        if (!hasOpss) return;
        detected.push({ key: 'OPSS', label: 'WebLogic/OPSS', schema: 'OPSS' });
      } catch (e) { /* ignore */ }
    })(),

    // ── JD Edwards (JDE): JDEADMIN or PRODDTA schema, or F0101 table ──
    (async () => {
      try {
        const hasJdeAdmin = await schemaExists('JDEADMIN');
        const hasProddta = await schemaExists('PRODDTA');
        if (!hasJdeAdmin && !hasProddta) {
          // Fallback: look for F0101 (Address Book master table) in any schema
          const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
          const r = await conn.execute(
            `SELECT COUNT(*) FROM ${tView} WHERE UPPER(table_name) = 'F0101' AND ROWNUM = 1`
          );
          if ((r.rows?.[0]?.[0] || 0) === 0) return;
        }
        const schema = hasJdeAdmin ? 'JDEADMIN' : (hasProddta ? 'PRODDTA' : null);
        detected.push({ key: 'JDE', label: 'JD Edwards', schema });
      } catch (e) { /* ignore */ }
    })(),

    // ── Informatica: INFA_DOMAIN schema, or REP_SESS_LOG / OPB_SUBJECT tables ──
    (async () => {
      try {
        const hasInfa = await schemaExists('INFA_DOMAIN');
        if (hasInfa) {
          detected.push({ key: 'INFA', label: 'Informatica', schema: 'INFA_DOMAIN' });
          return;
        }
        const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
        const r = await conn.execute(
          `SELECT COUNT(*) FROM ${tView} WHERE UPPER(table_name) IN ('REP_SESS_LOG','OPB_SUBJECT') AND ROWNUM = 1`
        );
        if ((r.rows?.[0]?.[0] || 0) === 0) return;
        detected.push({ key: 'INFA', label: 'Informatica', schema: null });
      } catch (e) { /* ignore */ }
    })(),

    // ── Siebel CRM (extended): SIEBEL schema, or S_CONTACT / S_OPTY tables ──
    // Note: base Siebel probe above detects via S_REPOSITORY/S_APP_VIEW; this adds schema check
    (async () => {
      try {
        const hasSiebel = await schemaExists('SIEBEL');
        if (!hasSiebel) return;
        // Confirm with known Siebel CRM tables
        const hasContact = await tableExists('SIEBEL', 'S_CONTACT');
        const hasOpty = await tableExists('SIEBEL', 'S_OPTY');
        if (!hasContact && !hasOpty) return;
        // Only push if the base Siebel probe didn't already add it
        if (!detected.some(a => a.key === 'SIEBEL')) {
          detected.push({ key: 'SIEBEL', label: 'Siebel CRM', schema: 'SIEBEL' });
        }
      } catch (e) { /* ignore */ }
    })(),

    // ── Oracle Identity Manager (OIM): OIM_* or DEV_OIM schema ──
    (async () => {
      try {
        const view = usersView;
        const r = await conn.execute(
          `SELECT username FROM ${view} WHERE UPPER(username) LIKE 'OIM%' AND ROWNUM = 1`
        );
        if ((r.rows || []).length === 0) return;
        detected.push({ key: 'OIM', label: 'Oracle Identity Manager', schema: r.rows[0][0] });
      } catch (e) { /* ignore */ }
    })(),

    // ── Hyperion/EPM extended: HYPADM schema or HSP_* tables ──
    (async () => {
      try {
        const hasHyp = await schemaExists('HYPADM');
        if (hasHyp) {
          // Only push if base EPM probe didn't already fire
          if (!detected.some(a => a.key === 'EPM')) {
            detected.push({ key: 'EPM', label: 'Hyperion/EPM', schema: 'HYPADM' });
          }
          return;
        }
        const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
        const r = await conn.execute(
          `SELECT COUNT(*) FROM ${tView} WHERE UPPER(table_name) LIKE 'HSP_%' AND ROWNUM = 1`
        );
        if ((r.rows?.[0]?.[0] || 0) === 0) return;
        if (!detected.some(a => a.key === 'EPM')) {
          detected.push({ key: 'EPM', label: 'Hyperion/EPM', schema: null });
        }
      } catch (e) { /* ignore */ }
    })(),

    // ── Oracle Fusion Middleware: MDS + OPSS + IAU schemas ──
    (async () => {
      try {
        const hasMds  = await schemaExists('MDS');
        const hasOpss = await schemaExists('OPSS');
        const hasIau  = await schemaExists('IAU');
        // Require at least two of three to avoid false positives on MDS-only installs
        const count = [hasMds, hasOpss, hasIau].filter(Boolean).length;
        if (count < 2) return;
        detected.push({ key: 'FMW', label: 'Fusion Middleware', schema: 'OPSS' });
      } catch (e) { /* ignore */ }
    })(),

    // ── SAP on Oracle: SAPSR3 or SAPR3 schema ──
    (async () => {
      try {
        const hasSap = await schemaExists('SAPSR3') || await schemaExists('SAPR3');
        if (!hasSap) return;
        const schema = (await schemaExists('SAPSR3')) ? 'SAPSR3' : 'SAPR3';
        detected.push({ key: 'SAP', label: 'SAP on Oracle', schema });
      } catch (e) { /* ignore */ }
    })(),

    // ── OBIEE/OAS (extended): DEV_BIPLATFORM schema ──
    // The base OBIEE probe already checks BIPLATFORM; this catches dev/named variants
    (async () => {
      try {
        const view = usersView;
        const r = await conn.execute(
          `SELECT username FROM ${view} WHERE UPPER(username) LIKE '%BIPLATFORM%' AND ROWNUM = 1`
        );
        if ((r.rows || []).length === 0) return;
        if (!detected.some(a => a.key === 'OBIEE')) {
          detected.push({ key: 'OBIEE', label: 'OBIEE/OAS', schema: r.rows[0][0] });
        }
      } catch (e) { /* ignore */ }
    })(),

    // ── Primavera P6: ADMUSER schema with TASK + PROJECT tables ──
    (async () => {
      try {
        const hasAdm = await schemaExists('ADMUSER');
        if (!hasAdm) {
          // Fallback: PROJECT + TASK tables in any schema
          const tView = usersView === 'dba_users' ? 'dba_tables' : 'all_tables';
          const r = await conn.execute(
            `SELECT COUNT(DISTINCT table_name) FROM ${tView} WHERE UPPER(table_name) IN ('TASK','PROJECT')`
          );
          if ((r.rows?.[0]?.[0] || 0) < 2) return;
          detected.push({ key: 'P6', label: 'Primavera P6', schema: null });
          return;
        }
        const hasTask    = await tableExists('ADMUSER', 'TASK');
        const hasProject = await tableExists('ADMUSER', 'PROJECT');
        if (!hasTask && !hasProject) return;
        detected.push({ key: 'P6', label: 'Primavera P6', schema: 'ADMUSER' });
      } catch (e) { /* ignore */ }
    })(),

    // ── Agile PLM: AGILE schema ──
    (async () => {
      try {
        const hasAgile = await schemaExists('AGILE');
        if (!hasAgile) return;
        detected.push({ key: 'AGILE', label: 'Agile PLM', schema: 'AGILE' });
      } catch (e) { /* ignore */ }
    })(),

    // ── Demantra: MDP or DEMANTRA schema ──
    (async () => {
      try {
        const hasMdp      = await schemaExists('MDP');
        const hasDemantra = await schemaExists('DEMANTRA');
        if (!hasMdp && !hasDemantra) return;
        const schema = hasMdp ? 'MDP' : 'DEMANTRA';
        detected.push({ key: 'DEMANTRA', label: 'Demantra', schema });
      } catch (e) { /* ignore */ }
    })()

  ];

  await Promise.allSettled(probes);
  return detected;
}

// ============================================================
// SQL Tuning Recommendations
// ============================================================

/**
 * Check whether the Oracle Tuning Pack is licensed on this database.
 * Probes DBA_FEATURE_USAGE_STATISTICS for DBMS_SQLTUNE usage.
 * Returns { licensed: boolean, method: string }.
 */
async function checkTuningPackLicense(conn) {
  // First try DBA_FEATURE_USAGE_STATISTICS (most reliable)
  try {
    const r = await conn.execute(`
      SELECT DETECTED_USAGES, CURRENTLY_USED
      FROM DBA_FEATURE_USAGE_STATISTICS
      WHERE NAME = 'SQL Tuning Advisor'
      FETCH FIRST 1 ROWS ONLY
    `);
    const row = r.rows?.[0];
    if (row) {
      const detected = parseInt(row[0]) || 0;
      const current = row[1];
      if (detected > 0 || current === 'TRUE') {
        return { licensed: true, method: 'dba_feature_usage_statistics' };
      }
    }
  } catch (err) {
    // DBA_FEATURE_USAGE_STATISTICS not accessible — fall through to v$parameter check
  }

  // Fallback: check control_management_pack_access parameter
  try {
    const p = await conn.execute(
      `SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'`
    );
    const val = String(p.rows?.[0]?.[0] || '').toUpperCase();
    const licensed = val === 'DIAGNOSTIC+TUNING' || val === 'TUNING';
    return { licensed, method: 'v$parameter_control_management_pack_access' };
  } catch (err) {
    // Neither source accessible
    return { licensed: false, method: 'inaccessible' };
  }
}

/**
 * Fetch execution plan from V$SQL_PLAN for a given sql_id.
 * Returns { plan_rows, red_flags, missing_index_candidates }.
 */
async function queryExecutionPlan(conn, sqlId) {
  try {
    // Get execution plan rows
    const planResult = await conn.execute(`
      SELECT
        p.OPERATION,
        p.OPTIONS,
        p.OBJECT_NAME,
        p.OBJECT_OWNER,
        p.CARDINALITY as e_rows,
        p.BYTES,
        p.COST,
        p.PARTITION_START,
        p.PARTITION_STOP,
        p.ACCESS_PREDICATES,
        p.FILTER_PREDICATES,
        p.DEPTH,
        p.POSITION
      FROM V$SQL_PLAN p
      WHERE p.SQL_ID = :sqlId
        AND p.CHILD_NUMBER = (
          SELECT MIN(CHILD_NUMBER) FROM V$SQL_PLAN WHERE SQL_ID = :sqlId
        )
      ORDER BY p.PLAN_HASH_VALUE, p.ID
      FETCH FIRST 50 ROWS ONLY
    `, { sqlId });

    const planRows = (planResult.rows || []).map(row => ({
      operation: row[0] || '',
      options: row[1] || '',
      object_name: row[2] || '',
      object_owner: row[3] || '',
      e_rows: parseInt(row[4]) || 0,
      bytes: parseInt(row[5]) || 0,
      cost: parseInt(row[6]) || 0,
      access_predicates: row[9] || '',
      filter_predicates: row[10] || '',
      depth: parseInt(row[11]) || 0,
      position: parseInt(row[12]) || 0
    }));

    // --- Red flag detection ---
    const redFlags = [];

    // 1. Full table scans on large tables
    for (const row of planRows) {
      if (row.operation === 'TABLE ACCESS' && row.options === 'FULL' && row.object_name) {
        // Try to get row count for the table
        try {
          const sizeResult = await conn.execute(
            `SELECT NVL(NUM_ROWS, 0) FROM DBA_TABLES WHERE TABLE_NAME = :tn AND OWNER = :own`,
            { tn: row.object_name, own: row.object_owner || '%' }
          );
          const numRows = parseInt(sizeResult.rows?.[0]?.[0]) || 0;
          if (numRows > 1000000) {
            redFlags.push({
              type: 'full_table_scan',
              severity: 'high',
              detail: `Full table scan on ${row.object_owner ? row.object_owner + '.' : ''}${row.object_name} (${(numRows / 1000000).toFixed(1)}M rows)`
            });
          } else if (numRows > 100000) {
            redFlags.push({
              type: 'full_table_scan',
              severity: 'medium',
              detail: `Full table scan on ${row.object_owner ? row.object_owner + '.' : ''}${row.object_name} (${(numRows / 1000).toFixed(0)}K rows)`
            });
          } else if (numRows > 0) {
            redFlags.push({
              type: 'full_table_scan',
              severity: 'low',
              detail: `Full table scan on ${row.object_owner ? row.object_owner + '.' : ''}${row.object_name} (${numRows} rows — may be acceptable)`
            });
          } else {
            redFlags.push({
              type: 'full_table_scan',
              severity: 'medium',
              detail: `Full table scan on ${row.object_owner ? row.object_owner + '.' : ''}${row.object_name} (statistics not gathered)`
            });
          }
        } catch (e) {
          redFlags.push({
            type: 'full_table_scan',
            severity: 'medium',
            detail: `Full table scan on ${row.object_name} (table size unavailable)`
          });
        }
      }
    }

    // 2. Cartesian joins (MERGE JOIN CARTESIAN or NESTED LOOPS with no join predicate)
    for (const row of planRows) {
      if (row.operation === 'MERGE JOIN' && row.options === 'CARTESIAN') {
        redFlags.push({
          type: 'cartesian_join',
          severity: 'high',
          detail: 'Cartesian join (MERGE JOIN CARTESIAN) — missing or invalid join predicate'
        });
      }
    }

    // 3. Nested loops with high estimated rows
    for (const row of planRows) {
      if (row.operation === 'NESTED LOOPS' && row.e_rows > 10000) {
        redFlags.push({
          type: 'nested_loops_high_rows',
          severity: 'high',
          detail: `Nested loops with ${row.e_rows.toLocaleString()} estimated rows — consider hash join or index`
        });
      }
    }

    // 4. Index access where full scan might be cheaper (index fast full scan with huge range)
    for (const row of planRows) {
      if (row.operation === 'INDEX' && row.options === 'FAST FULL SCAN' && row.e_rows > 500000) {
        redFlags.push({
          type: 'index_fast_full_scan',
          severity: 'medium',
          detail: `INDEX FAST FULL SCAN on ${row.object_name} returning ${row.e_rows.toLocaleString()} rows — may be cheaper as TABLE ACCESS FULL`
        });
      }
    }

    // 5. Expensive SORT ORDER BY — high cost sort that could be eliminated with an index
    for (const row of planRows) {
      if (row.operation === 'SORT' && row.options === 'ORDER BY' && row.cost > 1000) {
        redFlags.push({
          type: 'expensive_sort',
          severity: 'medium',
          detail: 'Expensive SORT ORDER BY (cost: ' + row.cost.toLocaleString() + ') — consider an index on ORDER BY column(s) to avoid sort'
        });
      }
    }

    // --- Missing index candidates from predicates ---
    const missingIndexCandidates = [];
    const tablePredicates = {};
    for (const row of planRows) {
      if (row.operation === 'TABLE ACCESS' && row.options === 'FULL' && row.object_name) {
        const combined = [row.filter_predicates, row.access_predicates].filter(Boolean).join(' AND ');
        if (combined) {
          const key = `${row.object_owner}.${row.object_name}`;
          tablePredicates[key] = { owner: row.object_owner, table: row.object_name, predicates: combined };
        }
      }
    }

    for (const [key, info] of Object.entries(tablePredicates)) {
      // Extract column names from predicates (simple regex — catches most equality/range patterns)
      const colMatches = info.predicates.match(/\"([A-Z0-9_$#]+)\"|([A-Z][A-Z0-9_$#]{2,})\s*[=<>!]/g) || [];
      const cols = [...new Set(colMatches.map(m => m.replace(/[\"=<>!\s]/g, '')))].filter(c => c.length > 2 && !/^(AND|OR|NOT|IS|IN|BETWEEN|NULL|TRUE|FALSE|SYSDATE|ROWNUM)$/.test(c));

      if (cols.length > 0) {
        // Check existing indexes on this table
        try {
          const idxResult = await conn.execute(`
            SELECT ic.COLUMN_NAME, ic.COLUMN_POSITION, i.INDEX_NAME
            FROM DBA_IND_COLUMNS ic
            JOIN DBA_INDEXES i ON i.OWNER = ic.INDEX_OWNER AND i.INDEX_NAME = ic.INDEX_NAME
            WHERE ic.TABLE_NAME = :tn AND ic.TABLE_OWNER = :own
            ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION
          `, { tn: info.table, own: info.owner });

          const existingIndexCols = new Set((idxResult.rows || []).map(r => r[0]));
          const unindexed = cols.filter(c => !existingIndexCols.has(c));

          if (unindexed.length > 0) {
            const createSql = `CREATE INDEX idx_${info.table.toLowerCase()}_${unindexed[0].toLowerCase()} ON ${info.owner}.${info.table} (${unindexed.slice(0, 3).join(', ')});`;
            missingIndexCandidates.push({
              table: `${info.owner}.${info.table}`,
              columns: unindexed.slice(0, 3),
              predicates: info.predicates.substring(0, 200),
              create_sql: createSql,
              reason: `Full table scan with filter on unindexed column(s): ${unindexed.slice(0, 3).join(', ')}`
            });
          }
        } catch (e) {
          // DBA_IND_COLUMNS not accessible — skip missing index analysis
        }
      }
    }

    return { plan_rows: planRows, red_flags: redFlags, missing_index_candidates: missingIndexCandidates };
  } catch (err) {
    // V$SQL_PLAN not accessible or sql_id not in cursor cache
    return { plan_rows: [], red_flags: [{ type: 'plan_unavailable', severity: 'info', detail: 'Execution plan not available — SQL may have aged out of cursor cache' }], missing_index_candidates: [] };
  }
}

/**
 * Detect cursor sharing issues: many child cursors for same SQL signature,
 * and literals used where bind variables are expected.
 * Returns array of { sql_id, child_cursors, has_literals, detail }.
 */
async function queryCursorSharing(conn, sqlIds) {
  const results = [];
  try {
    // Group by EXACT_MATCHING_SIGNATURE to find duplicate SQL with only literal differences
    const idList = sqlIds.map(id => `'${id}'`).join(',');
    const r = await conn.execute(`
      SELECT
        s.SQL_ID,
        COUNT(s.CHILD_NUMBER) as child_cursors,
        MAX(s.LOADS) as loads,
        MAX(s.PARSE_CALLS) as parse_calls,
        MAX(SUBSTR(s.SQL_TEXT, 1, 200)) as sql_text_sample,
        MAX(s.EXACT_MATCHING_SIGNATURE) as sig
      FROM V$SQL s
      WHERE s.SQL_ID IN (${idList})
      GROUP BY s.SQL_ID
      ORDER BY child_cursors DESC
    `);

    for (const row of (r.rows || [])) {
      const sqlId = row[0];
      const childCursors = parseInt(row[1]) || 1;
      const loads = parseInt(row[2]) || 0;
      const parseCalls = parseInt(row[3]) || 0;
      const sqlText = row[4] || '';
      const sig = String(row[5] || '');

      // Check for sibling SQLs with same signature (literal differences)
      let siblingCount = 0;
      try {
        const sibR = await conn.execute(`
          SELECT COUNT(DISTINCT SQL_ID)
          FROM V$SQL
          WHERE EXACT_MATCHING_SIGNATURE = :sig
            AND SQL_ID <> :sqlId
        `, { sig, sqlId });
        siblingCount = parseInt(sibR.rows?.[0]?.[0]) || 0;
      } catch (e) { /* ignore */ }

      // Detect literals: numbers or quoted strings in WHERE clause position
      const literalPattern = /WHERE\s.+?\s=\s+\d+|WHERE\s.+?\s=\s+'[^']+'/i;
      const hasLiterals = literalPattern.test(sqlText) && !/:\w+/.test(sqlText);

      const issues = [];
      if (childCursors > 5) {
        issues.push(`${childCursors} child cursors — possible bind variable mismatch or invalidation`);
      }
      if (siblingCount > 3) {
        issues.push(`${siblingCount} similar SQLs with same signature but different literals — use bind variables`);
      }
      if (hasLiterals) {
        issues.push('Literal values in SQL text — replace with bind variables to improve cursor reuse');
      }
      if (loads > parseCalls * 0.5 && loads > 10) {
        issues.push(`${loads} hard parses (loads) vs ${parseCalls} parse calls — frequent invalidations`);
      }

      if (issues.length > 0 || childCursors > 3 || siblingCount > 0) {
        results.push({
          sql_id: sqlId,
          child_cursors: childCursors,
          sibling_sqls: siblingCount,
          has_literals: hasLiterals,
          hard_parses: loads,
          issues
        });
      }
    }
  } catch (err) {
    // V$SQL not accessible
  }
  return results;
}

/**
 * Generate DBMS_SQLTUNE copy-paste blocks for each sql_id.
 * Only called when Tuning Pack is licensed.
 */
function generateSqltuneSql(sqlId) {
  return `-- ============================================================
-- DBMS_SQLTUNE — SQL Tuning Advisor for SQL_ID: ${sqlId}
-- REQUIRES: Oracle Tuning Pack license (part of Oracle Diagnostics + Tuning Pack)
-- Run as DBA or user with ADVISOR privilege
-- ============================================================

-- Step 1: Create a tuning task for this SQL_ID
DECLARE
  l_task_name VARCHAR2(30);
BEGIN
  l_task_name := DBMS_SQLTUNE.CREATE_TUNING_TASK(
    sql_id      => '${sqlId}',
    scope       => DBMS_SQLTUNE.SCOPE_COMPREHENSIVE,  -- full analysis
    time_limit  => 60,                                 -- seconds; increase for complex SQL
    task_name   => 'tune_${sqlId.substring(0, 10)}',
    description => 'Tuning task created by TuneVault'
  );
  DBMS_OUTPUT.PUT_LINE('Task created: ' || l_task_name);
END;
/

-- Step 2: Execute the tuning task
BEGIN
  DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => 'tune_${sqlId.substring(0, 10)}');
END;
/

-- Step 3: View the tuning report (plain text)
SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('tune_${sqlId.substring(0, 10)}') FROM DUAL;

-- Step 4: (Optional) Accept a SQL Profile recommendation automatically
-- Only if the report shows a SQL Profile recommendation
-- BEGIN
--   DBMS_SQLTUNE.ACCEPT_SQL_PROFILE(
--     task_name => 'tune_${sqlId.substring(0, 10)}',
--     replace   => TRUE
--   );
-- END;
-- /

-- Step 5: Clean up after review
-- BEGIN
--   DBMS_SQLTUNE.DROP_TUNING_TASK('tune_${sqlId.substring(0, 10)}');
-- END;
-- /`;
}

/**
 * Master function: for a list of sql_ids, collect execution plans,
 * cursor sharing issues, and generate DBMS_SQLTUNE blocks if licensed.
 *
 * connParams: { host, port, serviceName, username, password }
 * sqlIds: string[]
 *
 * Returns array of per-SQL tuning objects.
 */
async function getSqlTuningRecommendations(connParams, sqlIds) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    const [tuningPackResult, cursorSharing] = await Promise.all([
      checkTuningPackLicense(connection),
      queryCursorSharing(connection, sqlIds)
    ]);

    const tuningPackLicensed = tuningPackResult.licensed;

    // Cursor sharing map by sql_id
    const cursorMap = {};
    for (const c of cursorSharing) {
      cursorMap[c.sql_id] = c;
    }

    // Fetch execution plans in parallel (limit parallelism)
    const planResults = await Promise.all(
      sqlIds.map(id => queryExecutionPlan(connection, id).then(p => ({ sql_id: id, ...p })))
    );

    const recommendations = planResults.map(p => {
      const cursor = cursorMap[p.sql_id] || null;
      const sqltuneSql = tuningPackLicensed ? generateSqltuneSql(p.sql_id) : null;

      return {
        sql_id: p.sql_id,
        plan_available: p.plan_rows.length > 0,
        red_flags: p.red_flags,
        missing_index_candidates: p.missing_index_candidates,
        cursor_sharing: cursor,
        tuning_pack_licensed: tuningPackLicensed,
        dbms_sqltune_sql: sqltuneSql
      };
    });

    return {
      tuning_pack_licensed: tuningPackLicensed,
      recommendations
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// ADDM FINDINGS
// ============================================================

/**
 * Check whether this database is Enterprise Edition and has the Diagnostics Pack
 * license (required to query DBA_ADVISOR_FINDINGS without violating license terms).
 *
 * Returns:
 *   { enterprise: bool, diagnostics_licensed: bool, method: string }
 */
async function checkAddmLicense(conn) {
  // 1. Edition check — Standard Edition skips entirely
  let enterprise = false;
  try {
    const r = await conn.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`);
    const banner = String(r.rows?.[0]?.[0] || '').toUpperCase();
    enterprise = banner.includes('ENTERPRISE');
  } catch (e) {
    // V$VERSION inaccessible — assume EE to attempt Diagnostics check
    enterprise = true;
  }

  if (!enterprise) {
    return { enterprise: false, diagnostics_licensed: false, method: 'v$version_standard_edition' };
  }

  // 2. Diagnostics Pack check via DBA_FEATURE_USAGE_STATISTICS
  try {
    const r = await conn.execute(`
      SELECT DETECTED_USAGES, CURRENTLY_USED
      FROM DBA_FEATURE_USAGE_STATISTICS
      WHERE NAME = 'Diagnostic Pack'
      FETCH FIRST 1 ROWS ONLY
    `);
    const row = r.rows?.[0];
    if (row) {
      const detected = parseInt(row[0]) || 0;
      const current = row[1];
      if (detected > 0 || current === 'TRUE') {
        return { enterprise: true, diagnostics_licensed: true, method: 'dba_feature_usage_statistics' };
      }
    }
  } catch (e) {
    // Fall through to v$parameter check
  }

  // 3. Fallback: control_management_pack_access parameter
  try {
    const p = await conn.execute(
      `SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'`
    );
    const val = String(p.rows?.[0]?.[0] || '').toUpperCase();
    const licensed = val === 'DIAGNOSTIC+TUNING' || val === 'DIAGNOSTIC';
    return { enterprise: true, diagnostics_licensed: licensed, method: 'v$parameter_control_management_pack_access' };
  } catch (e) {
    return { enterprise: true, diagnostics_licensed: false, method: 'inaccessible' };
  }
}

/**
 * Fetch ADDM findings from the most recent ADDM task.
 *
 * connParams: { host, port, serviceName, username, password }
 * options: { lookbackHours: number }  default 24h; 168 = 7 days
 *
 * Returns:
 *   {
 *     licensed: bool,           // false if EE+DiagPack not detected
 *     not_licensed_reason: str, // present when licensed=false
 *     lookback_hours: number,
 *     task_name: str|null,
 *     task_id: number|null,
 *     findings: [
 *       {
 *         finding_id,
 *         name,
 *         type,           // PROBLEM | SYMPTOM | ROOT CAUSE | INFORMATION
 *         impact_pct,
 *         message,
 *         severity,       // 'critical'|'warning'|'info'
 *         sql_id,         // may be null
 *         recommendations: [
 *           { rec_id, type, benefit_pct, message,
 *             actions: [{ action_id, command, attr1..attr4 }] }
 *         ]
 *       }
 *     ]
 *   }
 */
async function queryAddmFindings(connParams, options = {}) {
  const lookbackHours = options.lookbackHours || 24;
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    const licenseInfo = await checkAddmLicense(connection);

    if (!licenseInfo.enterprise) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Oracle Enterprise Edition + Diagnostics Pack.',
        lookback_hours: lookbackHours,
        task_name: null,
        task_id: null,
        findings: []
      };
    }

    if (!licenseInfo.diagnostics_licensed) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Diagnostics Pack license not detected (checked DBA_FEATURE_USAGE_STATISTICS and control_management_pack_access parameter). ADDM queries skipped.',
        lookback_hours: lookbackHours,
        task_name: null,
        task_id: null,
        findings: []
      };
    }

    // Find the most recent completed ADDM task within the lookback window.
    // Use CDB_ADVISOR_TASKS (not DBA_ADVISOR_TASKS) so that tasks created in
    // CDB$ROOT (by a SYSDBA connected to the root container) are visible even
    // when this session is scoped to a PDB. DBA_ADVISOR_TASKS only surfaces the
    // current container, so root-level tasks disappear in PDB sessions.
    // Also include STATUS='EXECUTED' — some Oracle versions use that value.
    let taskId = null;
    let taskName = null;
    let taskConName = null;
    let taskBeginSnap = null;
    let taskEndSnap = null;
    try {
      // CDB_ADVISOR_TASKS has CON_ID / CON_NAME columns; fall back to
      // DBA_ADVISOR_TASKS if the CDB view is inaccessible (non-CDB install).
      let taskResult;
      try {
        taskResult = await connection.execute(`
          SELECT t.TASK_ID, t.TASK_NAME, c.NAME AS CON_NAME
          FROM CDB_ADVISOR_TASKS t
          JOIN V$CONTAINERS c ON c.CON_ID = t.CON_ID
          WHERE t.ADVISOR_NAME = 'ADDM'
            AND t.STATUS IN ('COMPLETED', 'EXECUTED')
            AND t.COMPLETION_DATE >= SYSDATE - :lbDays
          ORDER BY t.COMPLETION_DATE DESC
          FETCH FIRST 1 ROWS ONLY
        `, { lbDays: lookbackHours / 24 });
      } catch (cdbErr) {
        // CDB view inaccessible (non-CDB or insufficient privilege) — fall back
        taskResult = await connection.execute(`
          SELECT t.TASK_ID, t.TASK_NAME, NULL AS CON_NAME
          FROM DBA_ADVISOR_TASKS t
          WHERE t.ADVISOR_NAME = 'ADDM'
            AND t.STATUS IN ('COMPLETED', 'EXECUTED')
            AND t.COMPLETION_DATE >= SYSDATE - :lbDays
          ORDER BY t.COMPLETION_DATE DESC
          FETCH FIRST 1 ROWS ONLY
        `, { lbDays: lookbackHours / 24 });
      }

      const taskRow = taskResult.rows?.[0];
      if (taskRow) {
        taskId   = parseInt(taskRow[0]);
        taskName = String(taskRow[1]);
        taskConName = taskRow[2] ? String(taskRow[2]) : null;
      }
    } catch (e) {
      // Both CDB_ADVISOR_TASKS and DBA_ADVISOR_TASKS inaccessible
    }

    // If task found, try to pull snap range + DB time from task parameters
    if (taskId) {
      try {
        const paramResult = await connection.execute(`
          SELECT PARAMETER_NAME, PARAMETER_VALUE
          FROM DBA_ADVISOR_PARAMETERS
          WHERE TASK_ID = :taskId
            AND PARAMETER_NAME IN ('BEGIN_SNAP', 'END_SNAP', 'DB_TIME')
        `, { taskId });
        for (const row of (paramResult.rows || [])) {
          const name = String(row[0]);
          const val  = row[1];
          if (name === 'BEGIN_SNAP') taskBeginSnap = val ? parseInt(val) : null;
          else if (name === 'END_SNAP') taskEndSnap = val ? parseInt(val) : null;
        }
      } catch (e) {
        // DBA_ADVISOR_PARAMETERS not accessible — snap range stays null
      }
    }

    if (!taskId) {
      return {
        licensed: true,
        lookback_hours: lookbackHours,
        task_name: null,
        task_id: null,
        findings: [],
        info: `No completed ADDM tasks found in the last ${lookbackHours} hours. ADDM runs automatically on Enterprise Edition databases — check AWR snapshot schedule.`
      };
    }

    // Fetch findings for this task
    let rawFindings = [];
    try {
      const findResult = await connection.execute(`
        SELECT
          f.FINDING_ID,
          f.TYPE,
          f.NAME,
          f.MESSAGE,
          f.IMPACT_DB_PERCENT,
          f.SQL_ID
        FROM DBA_ADVISOR_FINDINGS f
        WHERE f.TASK_ID = :taskId
        ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC
      `, { taskId });

      rawFindings = (findResult.rows || []).map(row => ({
        finding_id: parseInt(row[0]),
        type: String(row[1] || 'INFORMATION'),
        name: String(row[2] || ''),
        message: String(row[3] || ''),
        impact_pct: parseFloat(row[4]) || 0,
        sql_id: row[5] ? String(row[5]) : null
      }));
    } catch (e) {
      // DBA_ADVISOR_FINDINGS not accessible
    }

    if (rawFindings.length === 0) {
      return {
        licensed: true,
        lookback_hours: lookbackHours,
        task_name: taskName,
        task_id: taskId,
        container: taskConName,
        begin_snap: taskBeginSnap,
        end_snap: taskEndSnap,
        findings: [],
        // Completed task with zero findings = idle DB, not a data gap.
        // ADDM reports no issues when total DB time is very low (e.g. 13s, 7s).
        no_findings_reason: 'Analysis completed — no significant database activity detected in this snapshot window. ADDM only reports issues when workload is high enough to diagnose. Re-run during a workload period or widen the snapshot range to see recommendations.'
      };
    }

    // Fetch recommendations for each finding (join DBA_ADVISOR_RECOMMENDATIONS + DBA_ADVISOR_ACTIONS)
    const findingIds = rawFindings.map(f => f.finding_id);
    const recMap = {};  // finding_id -> []

    // Recommendations
    try {
      const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
      const bindObj = {};
      findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });

      const recResult = await connection.execute(`
        SELECT
          r.FINDING_ID,
          r.REC_ID,
          r.TYPE,
          r.BENEFIT_DB_PERCENT,
          r.MESSAGE
        FROM DBA_ADVISOR_RECOMMENDATIONS r
        WHERE r.TASK_ID = :taskId
          AND r.FINDING_ID IN (${idPlaceholders})
        ORDER BY r.FINDING_ID, r.REC_ID
      `, { taskId, ...bindObj });

      for (const row of (recResult.rows || [])) {
        const fid = parseInt(row[0]);
        if (!recMap[fid]) recMap[fid] = [];
        recMap[fid].push({
          rec_id: parseInt(row[1]),
          type: String(row[2] || ''),
          benefit_pct: parseFloat(row[3]) || 0,
          message: String(row[4] || ''),
          actions: []
        });
      }
    } catch (e) {
      // DBA_ADVISOR_RECOMMENDATIONS not accessible
    }

    // Actions
    try {
      const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
      const bindObj = {};
      findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });

      const actResult = await connection.execute(`
        SELECT
          a.FINDING_ID,
          a.REC_ID,
          a.ACTION_ID,
          a.COMMAND,
          a.ATTR1,
          a.ATTR2,
          a.ATTR3,
          a.ATTR4
        FROM DBA_ADVISOR_ACTIONS a
        WHERE a.TASK_ID = :taskId
          AND a.FINDING_ID IN (${idPlaceholders})
        ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID
      `, { taskId, ...bindObj });

      for (const row of (actResult.rows || [])) {
        const fid = parseInt(row[0]);
        const rid = parseInt(row[1]);
        const recs = recMap[fid] || [];
        const rec = recs.find(r => r.rec_id === rid);
        if (rec) {
          rec.actions.push({
            action_id: parseInt(row[2]),
            command: String(row[3] || ''),
            attr1: row[4] ? String(row[4]) : null,
            attr2: row[5] ? String(row[5]) : null,
            attr3: row[6] ? String(row[6]) : null,
            attr4: row[7] ? String(row[7]) : null
          });
        }
      }
    } catch (e) {
      // DBA_ADVISOR_ACTIONS not accessible
    }

    // Merge findings with their recommendations
    const findings = rawFindings.map(f => {
      const severity = f.impact_pct >= 10 ? 'critical' : f.impact_pct >= 3 ? 'warning' : 'info';
      return {
        ...f,
        severity,
        recommendations: recMap[f.finding_id] || []
      };
    });

    return {
      licensed: true,
      lookback_hours: lookbackHours,
      task_name: taskName,
      task_id: taskId,
      container: taskConName,
      begin_snap: taskBeginSnap,
      end_snap: taskEndSnap,
      findings
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function formatOracleError(err) {
  const msg = err.message || String(err);

  // Common Oracle errors with friendly messages
  if (msg.includes('ORA-12154')) return 'TNS name could not be resolved. Check hostname and service name.';
  if (msg.includes('ORA-12541')) return 'No listener at the specified host and port. Check host and port.';
  if (msg.includes('ORA-12514')) return 'Service name not found. Check the service name or SID.';
  if (msg.includes('ORA-12170')) return 'Connection timed out. Host may be unreachable.';
  if (msg.includes('ORA-01017')) return 'Invalid username or password.';
  if (msg.includes('ORA-28000')) return 'Account is locked.';
  if (msg.includes('ORA-28001')) return 'Password has expired.';
  if (msg.includes('ORA-01031')) return 'Insufficient privileges. User needs SELECT_CATALOG_ROLE or explicit grants on V$ views.';
  if (msg.includes('ORA-00942')) return 'Table or view does not exist. User may need additional grants.';
  if (msg.includes('ENOTFOUND')) return 'Hostname not found. Check the hostname or IP address.';
  if (msg.includes('ECONNREFUSED')) return 'Connection refused. Check host, port, and firewall rules.';
  if (msg.includes('ETIMEDOUT')) return 'Connection timed out. Host may be unreachable or blocked by firewall.';
  if (msg.includes('NJS-500')) return 'oracledb thin client error. Ensure Oracle DB is version 12.1+.';

  return msg;
}

/**
 * Classify an Oracle/TCP connection error into a DBA-friendly primary diagnosis.
 * Returns { heading, subtext, fixCommand } for prominent display above proxy troubleshooting.
 * heading: short bold title (e.g. "Listener is down")
 * subtext: one sentence explaining the Oracle-level cause
 * fixCommand: shell command to fix, or null
 */
function classifyOracleError(err, context) {
  // context: { host, port, serviceName, username, isProxy, proxyUrl }
  const msg = (err.message || String(err)).toLowerCase();
  const raw = err.message || String(err);
  const host = (context && context.host) || 'the host';
  const port = (context && context.port) || 1521;
  const svc  = (context && context.serviceName) || 'the service';
  const user = (context && context.username) || 'the DB user';

  // ORA-12541: listener not running (connection refused on listener port)
  if (raw.includes('ORA-12541') || (msg.includes('no listener') && !msg.includes('service'))) {
    return {
      heading: 'Listener is down',
      subtext: `No Oracle listener is responding at ${host}:${port}. The listener process is not running or is blocked.`,
      fixCommand: 'lsnrctl start'
    };
  }

  // ORA-12514: listener running but service not registered
  if (raw.includes('ORA-12514') || msg.includes('service name not found') || msg.includes('service_name')) {
    return {
      heading: 'Listener is up, service not found',
      subtext: `The listener is running but service "${svc}" is not registered. The database may be down or the service name is wrong.`,
      fixCommand: `lsnrctl services  # check registered services`
    };
  }

  // ORA-01034 / ORA-27101: database is down (instance not available)
  if (raw.includes('ORA-01034') || raw.includes('ORA-27101')) {
    return {
      heading: 'Database is down',
      subtext: `The Oracle instance is not running or is unavailable. The listener may be up but the instance has not started.`,
      fixCommand: 'sqlplus / as sysdba\nstartup'
    };
  }

  // ORA-28000: account locked
  if (raw.includes('ORA-28000')) {
    return {
      heading: 'DB user account locked',
      subtext: `The account "${user}" is locked and cannot log in. It may have exceeded failed login attempts.`,
      fixCommand: `ALTER USER ${user} ACCOUNT UNLOCK;`
    };
  }

  // ORA-01017: bad credentials
  if (raw.includes('ORA-01017') || msg.includes('invalid username or password')) {
    return {
      heading: 'Invalid credentials',
      subtext: `The username or password for "${user}" is incorrect for this connection.`,
      fixCommand: null
    };
  }

  // ORA-01031: insufficient privileges
  if (raw.includes('ORA-01031') || msg.includes('insufficient privileges')) {
    return {
      heading: 'Insufficient privileges',
      subtext: `"${user}" lacks the required grants to run health check queries (SELECT_CATALOG_ROLE or explicit V$ grants).`,
      fixCommand: `GRANT SELECT_CATALOG_ROLE TO ${user};\nGRANT CREATE SESSION TO ${user};`
    };
  }

  // TCP-level: host unreachable
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('ehostunreach') || msg.includes('etimedout') || msg.includes('connection timed out')) {
    return {
      heading: 'Host unreachable',
      subtext: `Cannot reach ${host}:${port}. The host may be offline, blocked by a firewall, or the port is wrong.`,
      fixCommand: null
    };
  }

  // Health check timeout
  if (msg.includes('timed out after 5 minutes')) {
    return {
      heading: 'Health check timed out',
      subtext: 'The Oracle server accepted the connection but did not respond to queries within 5 minutes. The instance may be overloaded or hanging.',
      fixCommand: null
    };
  }

  // Proxy offline
  if (context && context.isProxy && (msg.includes('econnrefused') || msg.includes('fetch') || msg.includes('network') || msg.includes('proxy'))) {
    return {
      heading: 'Proxy offline',
      subtext: `The TuneVault proxy agent at ${context.proxyUrl || 'the proxy URL'} is not responding.`,
      fixCommand: 'systemctl status tunevault-agent\n# or: python3 oracle-proxy.py'
    };
  }

  // Generic fallback
  return {
    heading: 'Connection failed',
    subtext: raw,
    fixCommand: null
  };
}


/**
 * Fetch auto-maintenance window status.
 *
 * connParams: { host, port, serviceName, username, password }
 *
 * Returns:
 *   {
 *     autotask_clients: [
 *       { client_name, status, last_run_date, last_run_status, last_run_duration_secs,
 *         runs_7d, failures_7d, traffic_light: 'green'|'amber'|'red',
 *         tuning_pack_required: bool, tuning_pack_licensed: bool|null }
 *     ],
 *     windows: [
 *       { window_name, next_start_date, repeat_interval, duration_hours, enabled,
 *         last_start_date, last_end_date }
 *     ],
 *     stale_tables_count: number,
 *     stale_tables_top10: [ { owner, table_name, num_rows, last_analyzed, stale_status } ],
 *     disabled_clients: string[],
 *     disabled_windows: string[]
 *   }
 */
async function queryHousekeepingWindows(connParams) {
  const { host, port, serviceName, username, password } = connParams;
  let connection;
  try {
    const connectString = `${host}:${port || 1521}/${serviceName}`;
    connection = await oracledb.getConnection({
      user: username,
      password: password,
      connectString,
      connectTimeout: 30
    });

    // ── 1. Autotask clients ─────────────────────────────────────────────
    const clients = [];
    const CLIENT_NAMES = [
      'auto optimizer stats collection',
      'sql tuning advisor',
      'auto space advisor'
    ];

    let clientRows = [];
    try {
      const cr = await connection.execute(`
        SELECT
          c.CLIENT_NAME,
          c.STATUS,
          h.JOB_START_TIME,
          h.JOB_STATUS,
          h.JOB_DURATION
        FROM DBA_AUTOTASK_CLIENT c
        LEFT JOIN (
          SELECT
            CLIENT_NAME,
            JOB_START_TIME,
            JOB_STATUS,
            JOB_DURATION,
            ROW_NUMBER() OVER (PARTITION BY CLIENT_NAME ORDER BY JOB_START_TIME DESC) AS rn
          FROM DBA_AUTOTASK_JOB_HISTORY
          WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
        ) h ON h.CLIENT_NAME = c.CLIENT_NAME AND h.rn = 1
        WHERE c.CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
        ORDER BY c.CLIENT_NAME
      `);
      clientRows = cr.rows || [];
    } catch (e) {
      // DBA_AUTOTASK_CLIENT not accessible — return empty clients list
    }

    // Count runs and failures per client in last 7 days
    const runStats = {};
    try {
      const rs = await connection.execute(`
        SELECT CLIENT_NAME,
               COUNT(*) AS total_runs,
               SUM(CASE WHEN JOB_STATUS != 'SUCCEEDED' THEN 1 ELSE 0 END) AS failures
        FROM DBA_AUTOTASK_JOB_HISTORY
        WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
          AND CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
        GROUP BY CLIENT_NAME
      `);
      for (const row of (rs.rows || [])) {
        runStats[String(row[0]).toLowerCase()] = {
          runs: parseInt(row[1]) || 0,
          failures: parseInt(row[2]) || 0
        };
      }
    } catch (e) { /* DBA_AUTOTASK_JOB_HISTORY not accessible */ }

    // Check Tuning Pack license (needed to gate sql tuning advisor result)
    const tuningLicense = await checkTuningPackLicense(connection);

    for (const row of clientRows) {
      const name = String(row[0] || '');
      const status = String(row[1] || '');
      const lastRunDate = row[2] ? new Date(row[2]).toISOString() : null;
      const lastRunStatus = row[3] ? String(row[3]) : null;
      const durationRaw = row[4]; // INTERVAL type → string like '+00 00:15:30.123'
      let durationSecs = null;
      if (durationRaw) {
        const m = String(durationRaw).match(/(\d+)\s+(\d+):(\d+):(\d+)/);
        if (m) durationSecs = parseInt(m[1]) * 86400 + parseInt(m[2]) * 3600 + parseInt(m[3]) * 60 + parseInt(m[4]);
      }

      const key = name.toLowerCase();
      const stats = runStats[key] || { runs: 0, failures: 0 };

      const isTuningAdvisor = key === 'sql tuning advisor';

      // Traffic light:
      //   green  = enabled + ran successfully in last 7 days
      //   amber  = enabled but no successful run in 7 days (stale)
      //   red    = disabled
      let trafficLight;
      if (status !== 'ENABLED') {
        trafficLight = 'red';
      } else if (stats.runs > 0 && stats.failures < stats.runs) {
        trafficLight = 'green';
      } else {
        trafficLight = 'amber';
      }

      clients.push({
        client_name: name,
        status,
        last_run_date: lastRunDate,
        last_run_status: lastRunStatus,
        last_run_duration_secs: durationSecs,
        runs_7d: stats.runs,
        failures_7d: stats.failures,
        traffic_light: trafficLight,
        tuning_pack_required: isTuningAdvisor,
        tuning_pack_licensed: isTuningAdvisor ? tuningLicense.licensed : null
      });
    }

    // Fill in any missing clients (inaccessible views → mark unknown)
    for (const name of CLIENT_NAMES) {
      if (!clients.find(c => c.client_name === name)) {
        clients.push({
          client_name: name,
          status: 'UNKNOWN',
          last_run_date: null,
          last_run_status: null,
          last_run_duration_secs: null,
          runs_7d: 0,
          failures_7d: 0,
          traffic_light: 'amber',
          tuning_pack_required: name === 'sql tuning advisor',
          tuning_pack_licensed: name === 'sql tuning advisor' ? tuningLicense.licensed : null
        });
      }
    }

    // ── 2. Maintenance windows ──────────────────────────────────────────
    const windows = [];
    try {
      const wr = await connection.execute(`
        SELECT
          WINDOW_NAME,
          TO_CHAR(NEXT_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS next_start,
          REPEAT_INTERVAL,
          EXTRACT(HOUR FROM DURATION) * 60 + EXTRACT(MINUTE FROM DURATION) AS duration_mins,
          ENABLED,
          TO_CHAR(LAST_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS last_start,
          TO_CHAR(LAST_END_DATE,   'YYYY-MM-DD HH24:MI:SS') AS last_end
        FROM DBA_SCHEDULER_WINDOWS
        WHERE WINDOW_NAME LIKE '%DAY_WINDOW'
           OR WINDOW_NAME LIKE '%WINDOW'
        ORDER BY WINDOW_NAME
      `);
      for (const row of (wr.rows || [])) {
        const name = String(row[0] || '');
        if (!name.endsWith('WINDOW')) continue; // only scheduler maintenance windows
        const durationMins = parseInt(row[3]) || 0;
        windows.push({
          window_name: name,
          next_start_date: row[1] ? String(row[1]) : null,
          repeat_interval: row[2] ? String(row[2]) : null,
          duration_hours: +(durationMins / 60).toFixed(2),
          enabled: row[4] === 'TRUE' || row[4] === true,
          last_start_date: row[5] ? String(row[5]) : null,
          last_end_date: row[6] ? String(row[6]) : null
        });
      }
    } catch (e) { /* DBA_SCHEDULER_WINDOWS not accessible */ }

    // ── 3. Stale stats ──────────────────────────────────────────────────
    let staleCount = 0;
    let staleTop10 = [];
    try {
      const sc = await connection.execute(`
        SELECT COUNT(*) FROM DBA_TAB_STATISTICS WHERE STALE_STATS = 'YES'
      `);
      staleCount = parseInt(sc.rows?.[0]?.[0]) || 0;
    } catch (e) { /* not accessible */ }

    try {
      const st = await connection.execute(`
        SELECT OWNER, TABLE_NAME, NUM_ROWS,
               TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed,
               STALE_STATS
        FROM DBA_TAB_STATISTICS
        WHERE STALE_STATS = 'YES'
          AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','XDB','MDSYS','CTXSYS','OLAPSYS','WMSYS','ORDSYS')
        ORDER BY NUM_ROWS DESC NULLS LAST
        FETCH FIRST 10 ROWS ONLY
      `);
      staleTop10 = (st.rows || []).map(row => ({
        owner: String(row[0] || ''),
        table_name: String(row[1] || ''),
        num_rows: parseInt(row[2]) || 0,
        last_analyzed: row[3] ? String(row[3]) : null,
        stale_stats: String(row[4] || '')
      }));
    } catch (e) { /* not accessible */ }

    // ── Build summary lists ─────────────────────────────────────────────
    const disabledClients = clients
      .filter(c => c.traffic_light === 'red')
      .map(c => c.client_name);
    const disabledWindows = windows
      .filter(w => !w.enabled || w.duration_hours === 0)
      .map(w => w.window_name);

    return {
      autotask_clients: clients,
      windows,
      stale_tables_count: staleCount,
      stale_tables_top10: staleTop10,
      disabled_clients: disabledClients,
      disabled_windows: disabledWindows
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Blocking Sessions ────────────────────────────────────────────────────────
/**
 * queryBlockingSessions — returns any sessions that are blocking other sessions.
 * Uses V$SESSION self-join on blocking_session column + V$SQL for the blocker SQL text.
 * No license gating — available on all Oracle editions.
 *
 * Returns:
 *   { chains: BlockingChain[], max_wait_seconds: number, severity: 'green'|'yellow'|'red' }
 *
 * BlockingChain: { blocker_sid, blocker_user, blocker_status, blocker_sql_id, blocker_sql,
 *                  blocked: [ { sid, user, wait_event, seconds_in_wait } ] }
 */
async function queryBlockingSessions(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    let rows = [];
    try {
      const result = await connection.execute(`
        SELECT
          s.sid AS blocked_sid,
          s.username AS blocked_user,
          s.event AS wait_event,
          s.seconds_in_wait,
          bs.sid AS blocker_sid,
          bs.username AS blocker_user,
          bs.sql_id AS blocker_sql_id,
          bs.status AS blocker_status,
          SUBSTR(sq.sql_text, 1, 120) AS blocker_sql
        FROM v$session s
        JOIN v$session bs ON s.blocking_session = bs.sid
        LEFT JOIN v$sql sq ON bs.sql_id = sq.sql_id AND bs.sql_child_number = sq.child_number
        WHERE s.blocking_session IS NOT NULL
        ORDER BY s.seconds_in_wait DESC
      `);
      rows = result.rows || [];
    } catch (e) {
      // V$SESSION join may fail with limited privs — return empty gracefully
    }

    // Group blocked sessions under each blocker
    const chainMap = {};
    for (const row of rows) {
      const [blockedSid, blockedUser, waitEvent, secondsInWait,
             blockerSid, blockerUser, blockerSqlId, blockerStatus, blockerSql] = row;
      const key = String(blockerSid);
      if (!chainMap[key]) {
        chainMap[key] = {
          blocker_sid: Number(blockerSid),
          blocker_user: String(blockerUser || ''),
          blocker_status: String(blockerStatus || ''),
          blocker_sql_id: blockerSqlId ? String(blockerSqlId) : null,
          blocker_sql: blockerSql ? String(blockerSql) : null,
          blocked: []
        };
      }
      chainMap[key].blocked.push({
        sid: Number(blockedSid),
        user: String(blockedUser || ''),
        wait_event: String(waitEvent || ''),
        seconds_in_wait: Number(secondsInWait) || 0
      });
    }

    const chains = Object.values(chainMap);
    const maxWait = rows.length > 0 ? (Number(rows[0][3]) || 0) : 0;
    const totalBlocked = rows.length;

    let severity = 'green';
    if (chains.length > 0) {
      if (maxWait > 300 || totalBlocked > 5) severity = 'red';
      else if (maxWait > 60) severity = 'yellow';
      else severity = 'yellow'; // any blocking = at least yellow
    }

    return { chains, max_wait_seconds: maxWait, total_blocked: totalBlocked, severity };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Long Operations ──────────────────────────────────────────────────────────
/**
 * queryLongOperations — returns in-progress long operations from V$SESSION_LONGOPS.
 * Generic Oracle — no license gating.
 *
 * Returns:
 *   { operations: LongOp[], severity: 'green'|'yellow' }
 *
 * LongOp: { sid, serial, opname, target, sofar, totalwork, pct_complete,
 *            minutes_remaining, minutes_elapsed, message }
 */
async function queryLongOperations(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    let rows = [];
    try {
      const result = await connection.execute(`
        SELECT sid, serial#, opname, target,
               sofar, totalwork,
               ROUND(sofar/NULLIF(totalwork,0)*100, 1) AS pct_complete,
               ROUND(time_remaining/60, 1) AS minutes_remaining,
               ROUND(elapsed_seconds/60, 1) AS minutes_elapsed,
               message
        FROM v$session_longops
        WHERE sofar < totalwork
          AND time_remaining > 0
        ORDER BY time_remaining DESC
      `);
      rows = result.rows || [];
    } catch (e) {
      // Not accessible — return empty
    }

    const operations = rows.map(row => ({
      sid: Number(row[0]),
      serial: Number(row[1]),
      opname: String(row[2] || ''),
      target: String(row[3] || ''),
      sofar: Number(row[4]) || 0,
      totalwork: Number(row[5]) || 0,
      pct_complete: Number(row[6]) || 0,
      minutes_remaining: Number(row[7]) || 0,
      minutes_elapsed: Number(row[8]) || 0,
      message: String(row[9] || '')
    }));

    // Flag if any op has >60 min remaining
    const severity = operations.some(o => o.minutes_remaining > 60) ? 'yellow' : 'green';

    return { operations, severity };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Top SQL Breakdown ────────────────────────────────────────────────────────
/**
 * queryTopSqlBreakdown — fetches 5 different Top-SQL rankings from V$SQL.
 * Generic Oracle — no license gating, no AWR required.
 *
 * Returns:
 *   {
 *     by_cpu:        TopSqlRow[],   // top 10 by cpu_time DESC
 *     by_elapsed:    TopSqlRow[],   // top 10 by elapsed_time DESC
 *     by_buffer_gets:TopSqlRow[],   // top 10 by buffer_gets DESC
 *     by_disk_reads: TopSqlRow[],   // top 10 by disk_reads DESC
 *     by_executions: TopSqlRow[],   // top 10 by executions DESC
 *   }
 *
 * TopSqlRow: { sql_id, schema, executions, key_metric, per_exec, sql_text }
 */
async function queryTopSqlBreakdown(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    async function runQuery(sql) {
      try {
        const r = await connection.execute(sql);
        return r.rows || [];
      } catch (e) {
        return [];
      }
    }

    const [cpuRows, elapsedRows, bufRows, diskRows, execRows] = await Promise.all([
      runQuery(`
        SELECT sql_id, parsing_schema_name, executions,
               ROUND(cpu_time/1e6, 2) AS cpu_seconds,
               ROUND(cpu_time/1e6/NULLIF(executions,0), 3) AS cpu_per_exec,
               SUBSTR(sql_text, 1, 100) AS sql_text_short
        FROM v$sql ORDER BY cpu_time DESC FETCH FIRST 10 ROWS ONLY
      `),
      runQuery(`
        SELECT sql_id, parsing_schema_name, executions,
               ROUND(elapsed_time/1e6, 2) AS elapsed_seconds,
               ROUND(elapsed_time/1e6/NULLIF(executions,0), 3) AS elapsed_per_exec,
               SUBSTR(sql_text, 1, 100) AS sql_text_short
        FROM v$sql ORDER BY elapsed_time DESC FETCH FIRST 10 ROWS ONLY
      `),
      runQuery(`
        SELECT sql_id, parsing_schema_name, executions, buffer_gets,
               ROUND(buffer_gets/NULLIF(executions,0), 0) AS gets_per_exec,
               SUBSTR(sql_text, 1, 100) AS sql_text_short
        FROM v$sql ORDER BY buffer_gets DESC FETCH FIRST 10 ROWS ONLY
      `),
      runQuery(`
        SELECT sql_id, parsing_schema_name, executions, disk_reads,
               ROUND(disk_reads/NULLIF(executions,0), 0) AS reads_per_exec,
               SUBSTR(sql_text, 1, 100) AS sql_text_short
        FROM v$sql ORDER BY disk_reads DESC FETCH FIRST 10 ROWS ONLY
      `),
      runQuery(`
        SELECT sql_id, parsing_schema_name, executions,
               ROUND(elapsed_time/1e6, 2) AS total_elapsed,
               SUBSTR(sql_text, 1, 100) AS sql_text_short
        FROM v$sql ORDER BY executions DESC FETCH FIRST 10 ROWS ONLY
      `)
    ]);

    const mapCpu = r => ({
      sql_id: String(r[0] || ''), schema: String(r[1] || ''),
      executions: Number(r[2]) || 0,
      key_metric: Number(r[3]) || 0, key_label: 'CPU (s)',
      per_exec: Number(r[4]) || 0, per_exec_label: 'CPU/exec (s)',
      sql_text: String(r[5] || '')
    });
    const mapElapsed = r => ({
      sql_id: String(r[0] || ''), schema: String(r[1] || ''),
      executions: Number(r[2]) || 0,
      key_metric: Number(r[3]) || 0, key_label: 'Elapsed (s)',
      per_exec: Number(r[4]) || 0, per_exec_label: 'Elapsed/exec (s)',
      sql_text: String(r[5] || '')
    });
    const mapBuf = r => ({
      sql_id: String(r[0] || ''), schema: String(r[1] || ''),
      executions: Number(r[2]) || 0,
      key_metric: Number(r[3]) || 0, key_label: 'Buffer Gets',
      per_exec: Number(r[4]) || 0, per_exec_label: 'Gets/exec',
      sql_text: String(r[5] || '')
    });
    const mapDisk = r => ({
      sql_id: String(r[0] || ''), schema: String(r[1] || ''),
      executions: Number(r[2]) || 0,
      key_metric: Number(r[3]) || 0, key_label: 'Disk Reads',
      per_exec: Number(r[4]) || 0, per_exec_label: 'Reads/exec',
      sql_text: String(r[5] || '')
    });
    const mapExec = r => ({
      sql_id: String(r[0] || ''), schema: String(r[1] || ''),
      executions: Number(r[2]) || 0,
      key_metric: Number(r[3]) || 0, key_label: 'Total Elapsed (s)',
      per_exec: null, per_exec_label: null,
      sql_text: String(r[4] || '')
    });

    return {
      by_cpu:         cpuRows.map(mapCpu),
      by_elapsed:     elapsedRows.map(mapElapsed),
      by_buffer_gets: bufRows.map(mapBuf),
      by_disk_reads:  diskRows.map(mapDisk),
      by_executions:  execRows.map(mapExec)
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}


// ─── Invalid Objects ─────────────────────────────────────────────────────────
/**
 * queryInvalidObjects — returns counts of INVALID objects grouped by owner and type.
 * Queries DBA_OBJECTS — available on all Oracle editions.
 *
 * @param {object} connParams  { host, port, serviceName, username, password }
 * @returns {InvalidObjectRow[]}
 *   InvalidObjectRow: { owner, object_type, invalid_count }
 */
async function queryInvalidObjects(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    let rows = [];
    try {
      const result = await connection.execute(`
        SELECT owner, object_type, COUNT(*) AS invalid_count
        FROM dba_objects
        WHERE status = 'INVALID'
        GROUP BY owner, object_type
        ORDER BY owner, invalid_count DESC
      `);
      rows = result.rows || [];
    } catch (e) {
      // not accessible — return empty
    }

    return rows.map(row => ({
      OWNER: String(row[0] || ''),
      OBJECT_TYPE: String(row[1] || ''),
      INVALID_COUNT: Number(row[2]) || 0
    }));
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Unusable Indexes ────────────────────────────────────────────────────────
/**
 * queryUnusableIndexes — returns unusable indexes at three granularities:
 *   whole indexes (DBA_INDEXES), partitions (DBA_IND_PARTITIONS),
 *   subpartitions (DBA_IND_SUBPARTITIONS).
 * Merged and returned by owner.
 * Available on all Oracle editions.
 *
 * @param {object} connParams  { host, port, serviceName, username, password }
 * @returns {UnusableIndexRow[]}
 *   UnusableIndexRow: { owner, indexes, partitions, subpartitions }
 */
async function queryUnusableIndexes(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    async function runQuery(sql) {
      try {
        const r = await connection.execute(sql);
        return r.rows || [];
      } catch (e) {
        return [];
      }
    }

    const [regularRows, partRows, subpartRows] = await Promise.all([
      runQuery(`SELECT owner, COUNT(*) AS cnt FROM dba_indexes WHERE status = 'UNUSABLE' GROUP BY owner`),
      runQuery(`SELECT index_owner AS owner, COUNT(*) AS cnt FROM dba_ind_partitions WHERE status = 'UNUSABLE' GROUP BY index_owner`),
      runQuery(`SELECT index_owner AS owner, COUNT(*) AS cnt FROM dba_ind_subpartitions WHERE status = 'UNUSABLE' GROUP BY index_owner`)
    ]);

    // Merge by owner
    const ownerMap = {};
    for (const row of regularRows) {
      const owner = String(row[0] || '');
      if (!ownerMap[owner]) ownerMap[owner] = { owner, indexes: 0, partitions: 0, subpartitions: 0 };
      ownerMap[owner].indexes = Number(row[1]) || 0;
    }
    for (const row of partRows) {
      const owner = String(row[0] || '');
      if (!ownerMap[owner]) ownerMap[owner] = { owner, indexes: 0, partitions: 0, subpartitions: 0 };
      ownerMap[owner].partitions = Number(row[1]) || 0;
    }
    for (const row of subpartRows) {
      const owner = String(row[0] || '');
      if (!ownerMap[owner]) ownerMap[owner] = { owner, indexes: 0, partitions: 0, subpartitions: 0 };
      ownerMap[owner].subpartitions = Number(row[1]) || 0;
    }
    return Object.values(ownerMap).sort((a, b) => (b.indexes + b.partitions + b.subpartitions) - (a.indexes + a.partitions + a.subpartitions));
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Stale Statistics ─────────────────────────────────────────────────────────
/**
 * queryStaleStatistics — returns per-schema statistics health plus the top 20
 * stale tables and the auto-optimizer-stats autotask client status.
 * Queries DBA_TABLES, DBA_TAB_STATISTICS, DBA_AUTOTASK_CLIENT.
 * Available on all Oracle editions.
 *
 * @param {object} connParams  { host, port, serviceName, username, password }
 * @returns {{ schemas, staleTop20, autoJob }}
 */
async function queryStaleStatistics(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    async function runQuery(sql) {
      try {
        const r = await connection.execute(sql);
        return r.rows || [];
      } catch (e) {
        return [];
      }
    }

    const [schemaRows, staleRows, autoJobRows] = await Promise.all([
      runQuery(`
        SELECT owner, COUNT(*) AS total_tables,
               SUM(CASE WHEN last_analyzed IS NULL THEN 1 ELSE 0 END) AS no_stats,
               SUM(CASE WHEN last_analyzed < SYSDATE - 30 THEN 1 ELSE 0 END) AS older_30d,
               MIN(last_analyzed) AS oldest_analyze,
               MAX(last_analyzed) AS newest_analyze
        FROM dba_tables
        WHERE owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','XDB','WMSYS','CTXSYS','MDSYS')
        GROUP BY owner
        ORDER BY older_30d DESC
      `),
      runQuery(`
        SELECT owner, table_name, num_rows, last_analyzed, stale_stats
        FROM dba_tab_statistics
        WHERE stale_stats = 'YES'
          AND owner NOT IN ('SYS','SYSTEM')
        ORDER BY num_rows DESC FETCH FIRST 20 ROWS ONLY
      `),
      runQuery(`
        SELECT client_name, status, last_good_date
        FROM dba_autotask_client
        WHERE client_name LIKE '%stats%'
      `)
    ]);

    const schemas = schemaRows.map(row => ({
      OWNER:          String(row[0] || ''),
      TOTAL_TABLES:   Number(row[1]) || 0,
      NO_STATS:       Number(row[2]) || 0,
      OLDER_30D:      Number(row[3]) || 0,
      OLDEST_ANALYZE: row[4] ? new Date(row[4]).toISOString() : null,
      NEWEST_ANALYZE: row[5] ? new Date(row[5]).toISOString() : null
    }));

    const staleTop20 = staleRows.map(row => ({
      OWNER:         String(row[0] || ''),
      TABLE_NAME:    String(row[1] || ''),
      NUM_ROWS:      Number(row[2]) || 0,
      LAST_ANALYZED: row[3] ? new Date(row[3]).toISOString() : null,
      STALE_STATS:   String(row[4] || '')
    }));

    const autoJob = autoJobRows.map(row => ({
      CLIENT_NAME:    String(row[0] || ''),
      STATUS:         String(row[1] || ''),
      LAST_GOOD_DATE: row[2] ? new Date(row[2]).toISOString() : null
    }));

    return { schemas, staleTop20, autoJob };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── Oracle Init Parameters ───────────────────────────────────────────────────
/**
 * queryOracleParameters — returns current Oracle init.ora parameters with
 * recommended values and traffic-light status (green/amber/red).
 *
 * Queries:
 *   V$PARAMETER   — current parameter name/value/isdefault/isdynamic
 *   V$OSSTAT      — physical RAM (PHYSICAL_MEMORY_BYTES) + CPU count (NUM_CPUS)
 *   V$LICENSE     — sessions high-water (SESSIONS_HIGHWATER)
 *   V$DATABASE    — db_edition (EE/SE)
 *   V$DATAFILE    — datafile count (for db_files headroom check)
 *
 * Returns { parameters: ParamRow[], hardware: { ram_gb, cpu_count },
 *           edition: 'EE'|'SE'|'XE'|'PE'|'unknown' }
 */
async function queryOracleParameters(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    async function runQuery(sql) {
      try { const r = await connection.execute(sql); return r.rows || []; }
      catch (e) { return []; }
    }

    // Fetch all sources in parallel
    const [paramRows, osRows, licRows, dbRows, dfRows] = await Promise.all([
      runQuery(`
        SELECT name, value, isdefault, isinstance_modifiable, issys_modifiable, description
        FROM v$parameter
        ORDER BY name
      `),
      runQuery(`SELECT stat_name, value FROM v$osstat WHERE stat_name IN ('PHYSICAL_MEMORY_BYTES','NUM_CPUS','NUM_CPU_CORES')`),
      runQuery(`SELECT sessions_highwater FROM v$license`),
      runQuery(`SELECT db_unique_name, database_role FROM v$database`),
      runQuery(`SELECT COUNT(*) FROM v$datafile`)
    ]);

    // Parse hardware context
    const osMap = {};
    osRows.forEach(r => { osMap[String(r[0])] = Number(r[1]) || 0; });
    const ramBytes  = osMap['PHYSICAL_MEMORY_BYTES'] || 0;
    const ramGb     = ramBytes > 0 ? Math.round(ramBytes / (1024 ** 3) * 10) / 10 : 0;
    const cpuCount  = osMap['NUM_CPUS'] || osMap['NUM_CPU_CORES'] || 1;
    const sessHW    = licRows.length > 0 ? (Number(licRows[0][0]) || 0) : 0;
    const datafileCount = dfRows.length > 0 ? (Number(dfRows[0][0]) || 0) : 0;

    // Determine edition from db_unique_name / banner approach — use parameter list instead
    // We detect by checking for EE-only parameters that exist in v$parameter
    const paramMap = {};
    paramRows.forEach(r => { paramMap[String(r[0]).toLowerCase()] = String(r[1] || ''); });
    // inmemory_size only appears on EE; result_cache_max_size also EE-only in practice
    const isEE = 'inmemory_size' in paramMap || Number(paramMap['cpu_count'] || 0) > 0;
    const edition = isEE ? 'EE' : 'SE';

    // Compute recommended values and status for each tracked parameter
    function evalParam(name, currentRaw) {
      const current = (currentRaw || '').trim();
      const currentNum = parseBytes(current);
      const n = name.toLowerCase();

      // ── Memory ────────────────────────────────────────────────────────────
      if (n === 'memory_target' || n === 'memory_max_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A — RAM unknown', note: '' };
        const recBytes = Math.round(ramGb * 0.7 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur === 0) return { status: 'green', recommended: 'AMM disabled (manual SGA/PGA)', note: 'Preferred on Linux — avoids Huge Pages incompatibility' };
        if (cur < recBytes * 0.5) return { status: 'red', recommended: fmtBytes(recBytes), note: `Undersized for ${ramGb} GB RAM` };
        if (cur > ramGb * 0.9 * 1024 ** 3) return { status: 'amber', recommended: fmtBytes(recBytes), note: 'Leaves too little RAM for OS' };
        return { status: 'green', recommended: fmtBytes(recBytes), note: '' };
      }

      if (n === 'sga_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const recBytes = Math.round(ramGb * 0.45 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur === 0) return { status: 'amber', recommended: fmtBytes(recBytes), note: 'SGA auto-tuning is off' };
        if (cur < recBytes * 0.5) return { status: 'amber', recommended: fmtBytes(recBytes), note: `Consider ~45% of RAM (${ramGb} GB)` };
        return { status: 'green', recommended: fmtBytes(recBytes), note: '' };
      }

      if (n === 'sga_max_size') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const recBytes = Math.round(ramGb * 0.6 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur < recBytes * 0.6) return { status: 'amber', recommended: fmtBytes(recBytes), note: 'Cap may restrict SGA growth' };
        return { status: 'green', recommended: fmtBytes(recBytes), note: '' };
      }

      if (n === 'pga_aggregate_target') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const recBytes = Math.round(ramGb * 0.25 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur === 0) return { status: 'amber', recommended: fmtBytes(recBytes), note: 'Auto PGA is off' };
        if (cur < recBytes * 0.4) return { status: 'amber', recommended: fmtBytes(recBytes), note: '~25% of RAM recommended' };
        return { status: 'green', recommended: fmtBytes(recBytes), note: '' };
      }

      if (n === 'pga_aggregate_limit') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const recBytes = Math.round(ramGb * 0.5 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur > 0 && cur < recBytes * 0.4) return { status: 'amber', recommended: fmtBytes(recBytes), note: 'Hard PGA limit may kill large sorts' };
        return { status: 'green', recommended: fmtBytes(recBytes), note: '' };
      }

      if (n === 'db_cache_size') {
        if (ramGb === 0) return { status: 'unknown', recommended: 'N/A', note: '' };
        const rec = Math.round(ramGb * 0.3 * 1024 ** 3);
        const cur = parseBytes(current);
        if (cur === 0 && paramMap['sga_target'] && parseBytes(paramMap['sga_target']) > 0)
          return { status: 'green', recommended: 'Auto-tuned by SGA_TARGET', note: '' };
        if (cur > 0 && cur < rec * 0.4) return { status: 'amber', recommended: fmtBytes(rec), note: '~30% of RAM for buffer cache' };
        return { status: 'green', recommended: fmtBytes(rec), note: '' };
      }

      if (n === 'shared_pool_size') {
        const rec = 256 * 1024 * 1024; // 256 MB minimum
        const cur = parseBytes(current);
        if (cur === 0 && paramMap['sga_target'] && parseBytes(paramMap['sga_target']) > 0)
          return { status: 'green', recommended: 'Auto-tuned by SGA_TARGET', note: '' };
        if (cur > 0 && cur < rec) return { status: 'amber', recommended: '256M+', note: 'Shared pool too small — library cache misses likely' };
        return { status: 'green', recommended: '256M – 512M', note: '' };
      }

      if (n === 'large_pool_size') {
        const rec = 64 * 1024 * 1024;
        const cur = parseBytes(current);
        if (cur < rec) return { status: 'amber', recommended: '64M+', note: 'Required for RMAN and parallel execution' };
        return { status: 'green', recommended: '64M+', note: '' };
      }

      if (n === 'java_pool_size') {
        return { status: 'green', recommended: '32M–128M', note: 'Only matters if Java stored procedures are used' };
      }

      if (n === 'streams_pool_size') {
        return { status: 'green', recommended: '0 (auto) or 64M+ if replication used', note: '' };
      }

      // ── Processes & Sessions ───────────────────────────────────────────────
      if (n === 'processes') {
        const cur = Number(current) || 0;
        // Recommend sessions_highwater * 1.2 rounded up, minimum 300
        const hwRec = sessHW > 0 ? Math.max(300, Math.ceil(sessHW * 1.2)) : 300;
        if (cur === 0) return { status: 'unknown', recommended: String(hwRec), note: '' };
        if (sessHW > 0 && cur < sessHW * 1.1)
          return { status: 'red', recommended: String(hwRec), note: `Process limit nearly exhausted (HW: ${sessHW})` };
        if (sessHW > 0 && cur < sessHW * 1.3)
          return { status: 'amber', recommended: String(hwRec), note: `Less than 30% headroom (HW: ${sessHW})` };
        return { status: 'green', recommended: `~${hwRec} (sessions HW: ${sessHW || 'N/A'})`, note: '' };
      }

      if (n === 'sessions') {
        const procStr = paramMap['processes'] || '0';
        const procNum = Number(procStr) || 0;
        const derived = Math.ceil(procNum * 1.5) + 22;
        const cur = Number(current) || 0;
        if (procNum > 0 && cur < derived * 0.9)
          return { status: 'amber', recommended: String(derived), note: `Should be CEIL(processes*1.5)+22` };
        return { status: 'green', recommended: procNum > 0 ? String(derived) : 'derived from PROCESSES', note: '' };
      }

      if (n === 'open_cursors') {
        const cur = Number(current) || 0;
        if (cur < 300) return { status: 'red', recommended: '300+', note: 'Risk of ORA-01000 (max open cursors exceeded)' };
        if (cur < 500) return { status: 'amber', recommended: '500–1000', note: 'Low — increase if ORA-01000 occurs' };
        return { status: 'green', recommended: '300–1000', note: '' };
      }

      // ── Undo & Recovery ────────────────────────────────────────────────────
      if (n === 'undo_retention') {
        const cur = Number(current) || 0;
        if (cur < 900) return { status: 'amber', recommended: '900+', note: 'Low — ORA-01555 (snapshot too old) risk' };
        if (cur > 86400) return { status: 'amber', recommended: '3600–7200', note: 'Very high — may cause UNDO tablespace bloat' };
        return { status: 'green', recommended: '900–3600 sec', note: '' };
      }

      if (n === 'undo_tablespace') {
        if (!current || current === '') return { status: 'amber', recommended: 'UNDOTBS1', note: 'No undo tablespace configured' };
        return { status: 'green', recommended: current, note: '' };
      }

      if (n === 'db_recovery_file_dest_size') {
        const cur = parseBytes(current);
        if (cur === 0) return { status: 'amber', recommended: '10G+', note: 'FRA not configured — RMAN backups may fail' };
        // Can't check FRA usage without another query — just show current
        return { status: 'green', recommended: fmtBytes(cur), note: 'Check V$RECOVERY_FILE_DEST for usage %' };
      }

      if (n === 'log_buffer') {
        const rec = 8 * 1024 * 1024;
        const cur = parseBytes(current);
        if (cur < rec) return { status: 'amber', recommended: '8M–32M', note: 'Small log buffer may cause redo latch waits' };
        return { status: 'green', recommended: '8M–32M', note: '' };
      }

      // ── Performance ────────────────────────────────────────────────────────
      if (n === 'optimizer_mode') {
        const val = current.toUpperCase();
        if (val === 'ALL_ROWS') return { status: 'green', recommended: 'ALL_ROWS', note: '' };
        if (val === 'FIRST_ROWS' || val.startsWith('FIRST_ROWS_'))
          return { status: 'amber', recommended: 'ALL_ROWS', note: 'FIRST_ROWS degrades throughput — only for fetch-first OLTP' };
        return { status: 'amber', recommended: 'ALL_ROWS', note: '' };
      }

      if (n === 'cursor_sharing') {
        const val = current.toUpperCase();
        if (val === 'EXACT') return { status: 'green', recommended: 'EXACT', note: '' };
        if (val === 'FORCE') return { status: 'amber', recommended: 'EXACT', note: 'FORCE is a workaround for non-bind-variable SQL — fix the SQL instead' };
        return { status: 'amber', recommended: 'EXACT', note: '' };
      }

      if (n === 'parallel_max_servers') {
        if (cpuCount === 1) return { status: 'green', recommended: '0–2', note: 'Single-CPU instance' };
        const rec = cpuCount * 2;
        const cur = Number(current) || 0;
        if (cur > cpuCount * 8) return { status: 'amber', recommended: String(rec), note: 'Excessive parallelism may thrash CPU' };
        return { status: 'green', recommended: `${cpuCount}–${rec}`, note: '' };
      }

      if (n === 'result_cache_max_size') {
        if (edition !== 'EE') return { status: 'green', recommended: 'N/A (SE)', note: 'Result cache is Enterprise Edition feature' };
        const rec = 128 * 1024 * 1024;
        const cur = parseBytes(current);
        if (cur < rec) return { status: 'amber', recommended: '128M+', note: 'Result cache too small to be useful' };
        return { status: 'green', recommended: '128M–512M', note: '' };
      }

      if (n === 'inmemory_size') {
        if (edition !== 'EE') return { status: 'green', recommended: 'N/A (SE)', note: 'In-Memory option is EE only' };
        const cur = parseBytes(current);
        if (cur === 0) return { status: 'green', recommended: '0 (disabled)', note: 'Enable only if In-Memory option licensed' };
        return { status: 'green', recommended: fmtBytes(cur), note: '' };
      }

      // ── Security & Audit ───────────────────────────────────────────────────
      if (n === 'audit_trail') {
        const val = current.toUpperCase();
        if (val === 'NONE') return { status: 'red', recommended: 'DB or OS', note: 'No auditing — compliance risk' };
        if (val === 'FALSE' || val === '0') return { status: 'red', recommended: 'DB', note: 'Auditing disabled' };
        return { status: 'green', recommended: 'DB or OS', note: '' };
      }

      if (n === 'sec_case_sensitive_logon') {
        const val = current.toUpperCase();
        if (val === 'FALSE' || val === '0') return { status: 'amber', recommended: 'TRUE', note: 'Case-insensitive passwords weaken security' };
        return { status: 'green', recommended: 'TRUE', note: '' };
      }

      if (n === 'remote_login_passwordfile') {
        const val = current.toUpperCase();
        if (val === 'NONE') return { status: 'amber', recommended: 'EXCLUSIVE', note: 'Password file required for remote SYSDBA' };
        if (val === 'SHARED') return { status: 'amber', recommended: 'EXCLUSIVE', note: 'SHARED allows multiple DBs — use EXCLUSIVE' };
        return { status: 'green', recommended: 'EXCLUSIVE', note: '' };
      }

      if (n === 'os_authent_prefix') {
        if (current !== '') return { status: 'amber', recommended: '""', note: 'Non-empty prefix allows OS-authenticated logins' };
        return { status: 'green', recommended: '""', note: '' };
      }

      // ── Storage & I/O ──────────────────────────────────────────────────────
      if (n === 'db_files') {
        const limit = Number(current) || 200;
        if (datafileCount > 0 && datafileCount >= limit * 0.8)
          return { status: 'red', recommended: String(Math.max(limit * 2, 1000)), note: `Datafile count (${datafileCount}) near limit (${limit})` };
        if (datafileCount > 0 && datafileCount >= limit * 0.6)
          return { status: 'amber', recommended: String(limit), note: `${datafileCount}/${limit} datafiles used (${Math.round(datafileCount/limit*100)}%)` };
        return { status: 'green', recommended: '200+', note: datafileCount > 0 ? `${datafileCount}/${limit} used` : '' };
      }

      if (n === 'db_block_size') {
        const cur = Number(current) || 0;
        if (cur < 8192) return { status: 'amber', recommended: '8192', note: 'Sub-8k block size is uncommon — verify workload matches' };
        return { status: 'green', recommended: '8192 (OLTP) or 16384 (DW)', note: '' };
      }

      if (n === 'filesystemio_options') {
        const val = current.toUpperCase();
        if (val === 'SETALL' || val === 'ASYNCH,DIRECTIO' || val === 'DIRECTIO,ASYNCH')
          return { status: 'green', recommended: 'SETALL', note: '' };
        if (val === 'NONE' || val === '')
          return { status: 'amber', recommended: 'SETALL', note: 'Enable on Linux for async + directIO (reduces I/O latency)' };
        return { status: 'amber', recommended: 'SETALL', note: `Current: ${current}` };
      }

      if (n === 'disk_asynch_io') {
        const val = current.toUpperCase();
        if (val === 'TRUE') return { status: 'green', recommended: 'TRUE', note: '' };
        return { status: 'amber', recommended: 'TRUE', note: 'Async I/O reduces wait time on all platforms' };
      }

      // ── Misc ───────────────────────────────────────────────────────────────
      if (n === 'compatible') {
        // Flag if more than 2 major versions behind installed version
        return { status: 'green', recommended: 'Match current version', note: 'Lowering prevents rolling back upgrades' };
      }

      if (n === 'control_file_record_keep_time') {
        const cur = Number(current) || 0;
        if (cur < 7) return { status: 'amber', recommended: '30', note: 'Low retention — RMAN catalog may miss history' };
        return { status: 'green', recommended: '30+', note: '' };
      }

      // Default — show current as-is, no recommendation
      return { status: 'green', recommended: current || '(default)', note: '' };
    }

    // Parameter definitions we surface (name → category)
    const TRACKED = {
      // Memory
      memory_target:        'Memory',
      memory_max_target:    'Memory',
      sga_target:           'Memory',
      sga_max_size:         'Memory',
      pga_aggregate_target: 'Memory',
      pga_aggregate_limit:  'Memory',
      db_cache_size:        'Memory',
      shared_pool_size:     'Memory',
      large_pool_size:      'Memory',
      java_pool_size:       'Memory',
      streams_pool_size:    'Memory',
      // Processes & Sessions
      processes:            'Processes & Sessions',
      sessions:             'Processes & Sessions',
      open_cursors:         'Processes & Sessions',
      // Undo & Recovery
      undo_tablespace:      'Undo & Recovery',
      undo_retention:       'Undo & Recovery',
      db_recovery_file_dest_size: 'Undo & Recovery',
      log_buffer:           'Undo & Recovery',
      // Performance
      optimizer_mode:       'Performance',
      cursor_sharing:       'Performance',
      parallel_max_servers: 'Performance',
      result_cache_max_size:'Performance',
      inmemory_size:        'Performance',
      // Security & Audit
      audit_trail:          'Security & Audit',
      sec_case_sensitive_logon: 'Security & Audit',
      remote_login_passwordfile:'Security & Audit',
      os_authent_prefix:    'Security & Audit',
      // Storage & I/O
      db_files:             'Storage & I/O',
      db_block_size:        'Storage & I/O',
      filesystemio_options: 'Storage & I/O',
      disk_asynch_io:       'Storage & I/O',
      // Misc
      compatible:           'Misc',
      nls_characterset:     'Misc',
      nls_nchar_characterset:'Misc',
      diagnostic_dest:      'Misc',
      control_file_record_keep_time:'Misc'
    };

    const parameters = [];
    for (const [pname, category] of Object.entries(TRACKED)) {
      const raw = paramMap[pname.toLowerCase()];
      if (raw === undefined) continue; // parameter doesn't exist on this version
      const { status, recommended, note } = evalParam(pname, raw);
      // Is SCOPE=SPFILE required? False = dynamic (SCOPE=BOTH ok)
      const isDynamic = paramRows.find(r => String(r[0]).toLowerCase() === pname.toLowerCase())?.[3] === 'TRUE';
      parameters.push({
        name: pname,
        category,
        current_value: raw || '(not set)',
        recommended,
        status,          // 'green' | 'amber' | 'red' | 'unknown'
        note,
        is_dynamic: isDynamic,
        scope: isDynamic ? 'SCOPE=BOTH' : 'SCOPE=SPFILE  -- restart required'
      });
    }

    return {
      parameters,
      hardware: { ram_gb: ramGb, cpu_count: cpuCount },
      sessions_highwater: sessHW,
      datafile_count: datafileCount,
      edition
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// EBS OPERATIONS CHECKS — APPS schema only (CM, WF, Security, ADOP & App Tier)
// Only called when APPS.DUAL probe succeeds (ebsDetected = true).
// Returns a structured object consumed by persistCheckResults + renderEbsOpsTab.
// ============================================================

async function queryEbsOperations(conn) {
  // Safe query helper — returns null on error rather than throwing
  async function safeExec(sql, opts) {
    try {
      return await conn.execute(sql, opts || [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
    } catch (e) {
      return null;
    }
  }

  // ── CM01: Internal Manager (FNDICM) ─────────────────────────────────────
  let cm01 = null;
  try {
    const r = await safeExec(`SELECT user_concurrent_queue_name, max_processes, running_processes, control_code
      FROM apps.fnd_concurrent_queues_vl
      WHERE concurrent_queue_name = 'FNDICM' AND enabled_flag = 'Y'`);
    if (r && r.rows && r.rows[0]) {
      const row = r.rows[0];
      cm01 = { name: String(row[0] || 'Internal Manager'), max_processes: Number(row[1]) || 0, running_processes: Number(row[2]) || 0, control_code: String(row[3] || '') };
    }
  } catch (e) { /* ignore */ }

  // ── CM02: Standard Manager pending queue depth ───────────────────────────
  let cm02 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*) FROM apps.fnd_concurrent_requests WHERE phase_code = 'P' AND status_code = 'I'`);
    if (r && r.rows) cm02 = { pending_requests: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── CM03: Conflict Manager ───────────────────────────────────────────────
  let cm03 = null;
  try {
    const r = await safeExec(`SELECT user_concurrent_queue_name, max_processes, running_processes, enabled_flag, control_code
      FROM apps.fnd_concurrent_queues_vl WHERE concurrent_queue_name = 'FNDCRM'`);
    if (r && r.rows && r.rows[0]) {
      const row = r.rows[0];
      cm03 = { name: String(row[0] || 'Conflict Manager'), max_processes: Number(row[1]) || 0, running_processes: Number(row[2]) || 0, enabled: String(row[3]) === 'Y', control_code: String(row[4] || '') };
    }
  } catch (e) { /* ignore */ }

  // ── CM05: Request Queue Stats (avg runtime last 24h) ─────────────────────
  let cm05 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*), ROUND(AVG((actual_completion_date - actual_start_date)*86400),1)
      FROM apps.fnd_concurrent_requests
      WHERE phase_code = 'C' AND status_code = 'C'
        AND actual_completion_date > SYSDATE - 1`);
    if (r && r.rows && r.rows[0]) {
      cm05 = { completed_24h: Number(r.rows[0][0]) || 0, avg_runtime_secs: parseFloat(r.rows[0][1]) || 0 };
    }
  } catch (e) { /* ignore */ }

  // ── CM06: Manager Load (all enabled managers) ────────────────────────────
  let cm06 = [];
  try {
    const r = await safeExec(`SELECT user_concurrent_queue_name, max_processes, running_processes, target_processes
      FROM apps.fnd_concurrent_queues_vl
      WHERE enabled_flag = 'Y'
      ORDER BY user_concurrent_queue_name
      FETCH FIRST 20 ROWS ONLY`);
    if (r && r.rows) {
      cm06 = r.rows.map(row => ({
        name: String(row[0] || ''),
        max_processes: Number(row[1]) || 0,
        running_processes: Number(row[2]) || 0,
        target_processes: Number(row[3]) || 0
      }));
    }
  } catch (e) { /* ignore */ }

  // ── CM09: Top 10 Long Requests (last 7 days) ─────────────────────────────
  let cm09 = [];
  try {
    const r = await safeExec(`SELECT concurrent_program_name, TO_CHAR(actual_start_date,'YYYY-MM-DD HH24:MI'), TO_CHAR(actual_completion_date,'YYYY-MM-DD HH24:MI'),
        ROUND((actual_completion_date - actual_start_date)*86400) as runtime_secs
      FROM apps.fnd_concurrent_requests
      WHERE actual_completion_date IS NOT NULL AND actual_start_date IS NOT NULL
        AND actual_start_date > SYSDATE - 7
      ORDER BY runtime_secs DESC NULLS LAST
      FETCH FIRST 10 ROWS ONLY`);
    if (r && r.rows) {
      cm09 = r.rows.map(row => ({ program: String(row[0] || ''), start_time: String(row[1] || ''), end_time: String(row[2] || ''), runtime_secs: Number(row[3]) || 0 }));
    }
  } catch (e) { /* ignore */ }

  // ── CM10: Broken / Error Requests (last 24h) ─────────────────────────────
  let cm10 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*) FROM apps.fnd_concurrent_requests
      WHERE status_code IN ('E','X','D') AND actual_completion_date > SYSDATE - 1`);
    if (r && r.rows) cm10 = { error_requests_24h: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── WF01: Item Count by Type ─────────────────────────────────────────────
  let wf01 = [];
  try {
    const r = await safeExec(`SELECT item_type, COUNT(*) FROM apps.wf_item_activity_statuses
      GROUP BY item_type ORDER BY COUNT(*) DESC FETCH FIRST 15 ROWS ONLY`);
    if (r && r.rows) wf01 = r.rows.map(row => ({ item_type: String(row[0] || ''), count: Number(row[1]) || 0 }));
  } catch (e) { /* ignore */ }

  // ── WF02: Error Count ─────────────────────────────────────────────────────
  let wf02 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*) FROM apps.wf_item_activity_statuses WHERE activity_status = 'ERROR'`);
    if (r && r.rows) wf02 = { error_count: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── WF03: Deferred Queue ──────────────────────────────────────────────────
  let wf03 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*) FROM apps.wf_deferred WHERE state = 0`);
    if (r && r.rows) wf03 = { deferred_ready: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── WF07: Purgeable Items (end_date older than 30 days) ──────────────────
  let wf07 = [];
  try {
    const r = await safeExec(`SELECT item_type, COUNT(*) FROM apps.wf_items
      WHERE end_date < SYSDATE - 30 GROUP BY item_type ORDER BY COUNT(*) DESC FETCH FIRST 10 ROWS ONLY`);
    if (r && r.rows) wf07 = r.rows.map(row => ({ item_type: String(row[0] || ''), count: Number(row[1]) || 0 }));
  } catch (e) { /* ignore */ }

  // ── WF08: Notification Backlog (pending > 2h) ────────────────────────────
  let wf08 = null;
  try {
    const r2h = await safeExec(`SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = 'MAIL' AND status = 'OPEN' AND begin_date < SYSDATE - 2/24`);
    const r8h = await safeExec(`SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = 'MAIL' AND status = 'OPEN' AND begin_date < SYSDATE - 8/24`);
    wf08 = { pending_over_2h: Number(r2h?.rows[0]?.[0]) || 0, pending_over_8h: Number(r8h?.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── WF09: Agent Status ───────────────────────────────────────────────────
  let wf09 = [];
  try {
    const r = await safeExec(`SELECT name, queue_name, enabled FROM apps.wf_agents WHERE enabled = 'Y' ORDER BY name FETCH FIRST 20 ROWS ONLY`);
    if (r && r.rows) wf09 = r.rows.map(row => ({ name: String(row[0] || ''), queue_name: String(row[1] || ''), enabled: String(row[2]) === 'Y' }));
  } catch (e) { /* ignore */ }

  // ── SC12/SC13: Sign-on Audit Profile ─────────────────────────────────────
  let sc12 = null;
  try {
    const r = await safeExec(`SELECT fpov.profile_option_value
      FROM apps.fnd_profile_option_values fpov
      JOIN apps.fnd_profile_options fpo ON fpo.profile_option_id = fpov.profile_option_id
      WHERE fpo.profile_option_name = 'SIGNONAUDIT:LEVEL'
        AND fpov.level_id = 10001`);
    if (r && r.rows && r.rows[0]) {
      const val = String(r.rows[0][0] || 'NONE');
      sc12 = { signon_audit_level: val, audit_enabled: val !== 'NONE' && val !== '0' };
    } else {
      sc12 = { signon_audit_level: 'NONE', audit_enabled: false };
    }
  } catch (e) { /* ignore */ }

  // ── SC14: SYSADMIN Responsibilities ──────────────────────────────────────
  let sc14 = [];
  try {
    const r = await safeExec(`SELECT fu.user_name, frt.responsibility_name
      FROM apps.fnd_user_resp_groups_direct furg
      JOIN apps.fnd_user fu ON fu.user_id = furg.user_id
      JOIN apps.fnd_responsibility_tl frt ON frt.responsibility_id = furg.responsibility_id AND frt.language = 'US'
      WHERE frt.responsibility_name LIKE '%System Admin%'
        AND furg.end_date IS NULL
        AND fu.end_date IS NULL
      ORDER BY fu.user_name
      FETCH FIRST 20 ROWS ONLY`);
    if (r && r.rows) sc14 = r.rows.map(row => ({ user_name: String(row[0] || ''), responsibility: String(row[1] || '') }));
  } catch (e) { /* ignore */ }

  // ── FB01: Top 10 Programs by Error Count (last 7 days) ──────────────────
  let fb01 = [];
  try {
    const r = await safeExec(`SELECT concurrent_program_name, COUNT(*) as error_count
      FROM apps.fnd_concurrent_requests
      WHERE status_code IN ('E','X') AND actual_completion_date > SYSDATE - 7
      GROUP BY concurrent_program_name ORDER BY error_count DESC FETCH FIRST 10 ROWS ONLY`);
    if (r && r.rows) fb01 = r.rows.map(row => ({ program: String(row[0] || ''), error_count: Number(row[1]) || 0 }));
  } catch (e) { /* ignore */ }

  // ── FB03: WF Notification Aging (pending > 7 days) ───────────────────────
  let fb03 = null;
  try {
    const r = await safeExec(`SELECT COUNT(*) FROM apps.wf_notifications WHERE mail_status = 'MAIL' AND status = 'OPEN' AND begin_date < SYSDATE - 7`);
    if (r && r.rows) fb03 = { pending_over_7d: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── FB04: Active User Sessions (last 24h) ────────────────────────────────
  let fb04 = null;
  try {
    const r = await safeExec(`SELECT COUNT(DISTINCT user_id) FROM apps.icx_sessions WHERE last_connect > SYSDATE - 1`);
    if (r && r.rows) fb04 = { active_users_24h: Number(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── OT05: Workflow Throughput (items completed per hour last 24h) ─────────
  let ot05 = null;
  try {
    const r = await safeExec(`SELECT ROUND(COUNT(*) / 24, 1) FROM apps.wf_item_activity_statuses
      WHERE activity_status = 'COMPLETE' AND execution_time > SYSDATE - 1`);
    if (r && r.rows) ot05 = { completed_per_hour: parseFloat(r.rows[0]?.[0]) || 0 };
  } catch (e) { /* ignore */ }

  // ── CD07: Password Policy Drift (FND profile values) ─────────────────────
  let cd07 = null;
  try {
    const policyParams = ['SIGNON_PASSWORD_LENGTH', 'SIGNON_PASSWORD_HARD_TO_GUESS', 'SIGNON_PASSWORD_NO_REUSE', 'SIGNON_PASSWORD_FAILURE_LIMIT'];
    const results = {};
    for (const param of policyParams) {
      const r = await safeExec(`SELECT fpov.profile_option_value FROM apps.fnd_profile_option_values fpov
        JOIN apps.fnd_profile_options fpo ON fpo.profile_option_id = fpov.profile_option_id
        WHERE fpo.profile_option_name = '${param}' AND fpov.level_id = 10001`);
      results[param] = r && r.rows && r.rows[0] ? String(r.rows[0][0]) : null;
    }
    cd07 = results;
  } catch (e) { /* ignore */ }

  return {
    concurrent_managers: { cm01, cm02, cm03, cm05, cm06, cm09, cm10 },
    workflow:            { wf01, wf02, wf03, wf07, wf08, wf09 },
    security:            { sc12, sc14 },
    functional:          { fb01, fb03, fb04 },
    observability:       { ot05 },
    config_drift:        { cd07 }
  };
}

// ── Utility: parse Oracle size strings like 256M, 2G, 1073741824 → bytes ────
function parseBytes(val) {
  if (!val || val === '') return 0;
  const s = String(val).trim().toUpperCase();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2];
  const mult = { K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 }[unit] || 1;
  return Math.round(n * mult);
}

function fmtBytes(bytes) {
  if (bytes === 0) return '0';
  if (bytes >= 1024**3) return (bytes / 1024**3).toFixed(1).replace(/\.0$/, '') + 'G';
  if (bytes >= 1024**2) return (bytes / 1024**2).toFixed(0) + 'M';
  if (bytes >= 1024)    return (bytes / 1024).toFixed(0) + 'K';
  return String(bytes);
}

/**
 * runAddmNow — create a fresh AWR snapshot and run ADDM analysis between the
 * two most-recent snapshots. Returns the same shape as queryAddmFindings().
 *
 * Requires EE + Diagnostics Pack. The operation takes 5-30 seconds on a live
 * database (snapshot creation + ADDM analysis time).
 */
async function runAddmNow(connParams) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30
    });

    // License check — same as queryAddmFindings
    const licenseInfo = await checkAddmLicense(connection);
    if (!licenseInfo.enterprise) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Oracle Enterprise Edition + Diagnostics Pack.',
        lookback_hours: 0, task_name: null, task_id: null, findings: []
      };
    }
    if (!licenseInfo.diagnostics_licensed) {
      return {
        licensed: false,
        not_licensed_reason: 'Oracle Diagnostics Pack license not detected. ADDM run-now skipped.',
        lookback_hours: 0, task_name: null, task_id: null, findings: []
      };
    }

    const t0 = Date.now();

    // Step 1: create a fresh AWR snapshot to close the current sample interval
    let newSnapId = null;
    try {
      const snapResult = await connection.execute(
        `BEGIN :snap_id := DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT(); END;`,
        { snap_id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
      );
      newSnapId = snapResult.outBinds && snapResult.outBinds.snap_id;
    } catch (snapErr) {
      // Non-fatal: if snapshot creation fails we fall back to existing snapshots
    }

    const t1 = Date.now();

    // Step 2: get the two most-recent AWR snapshot IDs (begin + end for ADDM)
    let beginSnapId = null, endSnapId = null, dbId = null;
    try {
      const snapsResult = await connection.execute(`
        SELECT s.SNAP_ID, s.DBID
        FROM DBA_HIST_SNAPSHOT s
        WHERE s.STATUS = 'Done'
        ORDER BY s.SNAP_ID DESC
        FETCH FIRST 2 ROWS ONLY
      `);
      const rows = snapsResult.rows || [];
      if (rows.length >= 2) {
        endSnapId = parseInt(rows[0][0]);
        beginSnapId = parseInt(rows[1][0]);
        dbId = rows[0][1];
      } else if (rows.length === 1) {
        return {
          licensed: true,
          lookback_hours: 0, task_name: null, task_id: null, findings: [],
          run_info: { snapshot_taken: !!newSnapId, snap_id: newSnapId, elapsed_ms: Date.now() - t0 },
          info: 'AWR snapshot created but only one snapshot exists — ADDM requires at least two. Run again after the next automatic snapshot (typically 1 hour).'
        };
      }
    } catch (e) {
      return {
        licensed: true,
        lookback_hours: 0, task_name: null, task_id: null, findings: [],
        run_info: { snapshot_taken: !!newSnapId, elapsed_ms: Date.now() - t0 },
        info: 'DBA_HIST_SNAPSHOT not accessible — cannot determine snapshot IDs for ADDM analysis.'
      };
    }

    if (!beginSnapId || !endSnapId) {
      return {
        licensed: true,
        lookback_hours: 0, task_name: null, task_id: null, findings: [],
        run_info: { snapshot_taken: !!newSnapId, elapsed_ms: Date.now() - t0 },
        info: 'Not enough AWR snapshots to run ADDM analysis. Wait for the next automatic snapshot.'
      };
    }

    // Step 3: run ADDM analysis between the two most-recent snapshots
    let taskId = null, taskName = null;
    const addmTaskName = 'TUNEVAULT_ADDM_' + Date.now();
    try {
      await connection.execute(
        `BEGIN DBMS_ADDM.ANALYZE_DB(:task_name, :begin_snap, :end_snap, :db_id); END;`,
        { task_name: addmTaskName, begin_snap: beginSnapId, end_snap: endSnapId, db_id: dbId }
      );
      taskName = addmTaskName;
      const tidResult = await connection.execute(`
        SELECT TASK_ID FROM DBA_ADVISOR_TASKS
        WHERE TASK_NAME = :task_name AND ADVISOR_NAME = 'ADDM'
        FETCH FIRST 1 ROWS ONLY
      `, { task_name: addmTaskName });
      const tidRow = tidResult.rows && tidResult.rows[0];
      if (tidRow) taskId = parseInt(tidRow[0]);
    } catch (addmErr) {
      return {
        licensed: true,
        lookback_hours: 0, task_name: null, task_id: null, findings: [],
        run_info: { snapshot_taken: !!newSnapId, begin_snap_id: beginSnapId, end_snap_id: endSnapId, elapsed_ms: Date.now() - t0 },
        info: `ADDM analysis failed: ${addmErr.message || addmErr}. The user may need EXECUTE privilege on DBMS_ADDM or ADVISOR privilege.`
      };
    }

    const t2 = Date.now();

    if (!taskId) {
      return {
        licensed: true,
        lookback_hours: 0, task_name: taskName, task_id: null, findings: [],
        run_info: { snapshot_taken: !!newSnapId, elapsed_ms: t2 - t0 },
        info: 'ADDM task created but task ID not found — may still be executing. Reload in a few seconds.'
      };
    }

    // Step 4: fetch findings for the newly-created task
    let rawFindings = [];
    try {
      const findResult = await connection.execute(`
        SELECT f.FINDING_ID, f.TYPE, f.NAME, f.MESSAGE, f.IMPACT_DB_PERCENT, f.SQL_ID
        FROM DBA_ADVISOR_FINDINGS f
        WHERE f.TASK_ID = :taskId
        ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC
      `, { taskId });
      rawFindings = (findResult.rows || []).map(row => ({
        finding_id: parseInt(row[0]),
        type: String(row[1] || 'INFORMATION'),
        name: String(row[2] || ''),
        message: String(row[3] || ''),
        impact_pct: parseFloat(row[4]) || 0,
        sql_id: row[5] ? String(row[5]) : null
      }));
    } catch (e) { /* DBA_ADVISOR_FINDINGS not accessible */ }

    const findingIds = rawFindings.map(f => f.finding_id);
    const recMap = {};
    if (findingIds.length > 0) {
      try {
        const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
        const bindObj = { taskId };
        findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });
        const recResult = await connection.execute(`
          SELECT r.FINDING_ID, r.REC_ID, r.TYPE, r.BENEFIT_DB_PERCENT, r.MESSAGE
          FROM DBA_ADVISOR_RECOMMENDATIONS r
          WHERE r.TASK_ID = :taskId AND r.FINDING_ID IN (${idPlaceholders})
          ORDER BY r.FINDING_ID, r.REC_ID
        `, bindObj);
        for (const row of (recResult.rows || [])) {
          const fid = parseInt(row[0]);
          if (!recMap[fid]) recMap[fid] = [];
          recMap[fid].push({ rec_id: parseInt(row[1]), type: String(row[2] || ''), benefit_pct: parseFloat(row[3]) || 0, message: String(row[4] || ''), actions: [] });
        }
      } catch (e) { /* ignore */ }

      try {
        const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
        const bindObj = { taskId };
        findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });
        const actResult = await connection.execute(`
          SELECT a.FINDING_ID, a.REC_ID, a.ACTION_ID, a.COMMAND, a.ATTR1, a.ATTR2, a.ATTR3, a.ATTR4
          FROM DBA_ADVISOR_ACTIONS a
          WHERE a.TASK_ID = :taskId AND a.FINDING_ID IN (${idPlaceholders})
          ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID
        `, bindObj);
        for (const row of (actResult.rows || [])) {
          const fid = parseInt(row[0]), rid = parseInt(row[1]);
          const recs = recMap[fid] || [];
          const rec = recs.find(r => r.rec_id === rid);
          if (rec) {
            rec.actions.push({ action_id: parseInt(row[2]), command: String(row[3] || ''), attr1: row[4] ? String(row[4]) : null, attr2: row[5] ? String(row[5]) : null, attr3: row[6] ? String(row[6]) : null, attr4: row[7] ? String(row[7]) : null });
          }
        }
      } catch (e) { /* ignore */ }
    }

    const findings = rawFindings.map(f => ({
      ...f,
      severity: f.impact_pct >= 10 ? 'critical' : f.impact_pct >= 3 ? 'warning' : 'info',
      recommendations: recMap[f.finding_id] || []
    }));

    return {
      licensed: true,
      lookback_hours: 0,
      task_name: taskName,
      task_id: taskId,
      findings,
      run_info: {
        snapshot_taken: !!newSnapId,
        snap_id: newSnapId,
        begin_snap_id: beginSnapId,
        end_snap_id: endSnapId,
        snapshot_ms: t1 - t0,
        analysis_ms: t2 - t1,
        total_ms: Date.now() - t0
      },
      ...(findings.length === 0 ? { no_findings_reason: 'Fresh ADDM analysis completed — no significant database activity detected in the snapshot interval.' } : {})
    };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { /* ignore */ }
    }
  }
}

// ─── listAWRSnapshots ─────────────────────────────────────────────────────────
//
// Returns the last 48 AWR snapshots for the ADDM snap-range picker.
// Also returns available containers for multitenant DBs (CDB_HIST_SNAPSHOT).
//
async function listAWRSnapshots(connParams) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 20,
    });

    // Snapshots — try CDB view first (multitenant), fall back to DBA view
    let snapshots = [];
    try {
      const r = await connection.execute(`
        SELECT s.SNAP_ID, s.BEGIN_INTERVAL_TIME, s.END_INTERVAL_TIME,
               s.DBID, c.NAME AS CON_NAME, s.CON_ID
        FROM CDB_HIST_SNAPSHOT s
        JOIN V$CONTAINERS c ON c.CON_ID = s.CON_ID
        WHERE s.STATUS = 'Done'
        ORDER BY s.SNAP_ID DESC
        FETCH FIRST 48 ROWS ONLY
      `);
      snapshots = (r.rows || []).map(row => ({
        snap_id:             parseInt(row[0]),
        begin_interval_time: row[1] ? String(row[1]) : null,
        end_interval_time:   row[2] ? String(row[2]) : null,
        db_id:               row[3] ? String(row[3]) : null,
        container:           row[4] ? String(row[4]) : null,
        con_id:              row[5] != null ? parseInt(row[5]) : null,
      }));
    } catch (e) {
      // Non-CDB or insufficient privilege — fall back to DBA_HIST_SNAPSHOT
      try {
        const r = await connection.execute(`
          SELECT s.SNAP_ID, s.BEGIN_INTERVAL_TIME, s.END_INTERVAL_TIME, s.DBID
          FROM DBA_HIST_SNAPSHOT s
          WHERE s.STATUS = 'Done'
          ORDER BY s.SNAP_ID DESC
          FETCH FIRST 48 ROWS ONLY
        `);
        snapshots = (r.rows || []).map(row => ({
          snap_id:             parseInt(row[0]),
          begin_interval_time: row[1] ? String(row[1]) : null,
          end_interval_time:   row[2] ? String(row[2]) : null,
          db_id:               row[3] ? String(row[3]) : null,
          container:           null,
          con_id:              null,
        }));
      } catch (e2) {
        // AWR not accessible — user likely missing SELECT_CATALOG_ROLE
      }
    }

    // Containers list (for multitenant picker)
    let containers = [];
    try {
      const r = await connection.execute(`
        SELECT CON_ID, NAME, OPEN_MODE FROM V$CONTAINERS ORDER BY CON_ID
      `);
      containers = (r.rows || []).map(row => ({
        con_id:    parseInt(row[0]),
        name:      String(row[1]),
        open_mode: String(row[2] || ''),
      }));
    } catch (e) {
      // V$CONTAINERS inaccessible (non-CDB or no privilege) — empty list is fine
    }

    return { snapshots, containers };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── runAddmBySnapRange ───────────────────────────────────────────────────────
//
// Runs DBMS_ADDM.ANALYZE_DB between explicit beginSnap + endSnap IDs.
// Also fetches the raw report text via DBMS_ADVISOR.GET_TASK_REPORT.
// Optional container parameter for multitenant ALTER SESSION SET CONTAINER.
//
async function runAddmBySnapRange(connParams, { beginSnap, endSnap, container, preset } = {}) {
  let connection;
  const t0 = Date.now();
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 30,
    });

    // License gate
    const licenseInfo = await checkAddmLicense(connection);
    if (!licenseInfo.enterprise) {
      return { licensed: false, not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Enterprise Edition + Diagnostics Pack.', findings: [] };
    }
    if (!licenseInfo.diagnostics_licensed) {
      return { licensed: false, not_licensed_reason: 'Oracle Diagnostics Pack license not detected. Check control_management_pack_access parameter.', findings: [] };
    }

    // Optionally switch container (multitenant)
    if (container && container !== 'CDB$ROOT') {
      try {
        await connection.execute(`ALTER SESSION SET CONTAINER = "${container}"`);
      } catch (e) {
        // Non-fatal — continue in current container
      }
    }

    // Resolve DBID from the snapshot range
    let dbId = null;
    try {
      const r = await connection.execute(
        `SELECT DBID FROM DBA_HIST_SNAPSHOT WHERE SNAP_ID = :snap FETCH FIRST 1 ROWS ONLY`,
        { snap: beginSnap }
      );
      if (r.rows && r.rows[0]) dbId = r.rows[0][0];
    } catch (e) { /* use null — DBMS_ADDM will use current DB_ID */ }

    // Pull snap times for display
    let beginSnapTime = null, endSnapTime = null;
    try {
      const r = await connection.execute(
        `SELECT BEGIN_INTERVAL_TIME, END_INTERVAL_TIME FROM DBA_HIST_SNAPSHOT
         WHERE SNAP_ID = :snap FETCH FIRST 1 ROWS ONLY`,
        { snap: beginSnap }
      );
      if (r.rows && r.rows[0]) beginSnapTime = r.rows[0][0] ? String(r.rows[0][0]) : null;
      const r2 = await connection.execute(
        `SELECT BEGIN_INTERVAL_TIME, END_INTERVAL_TIME FROM DBA_HIST_SNAPSHOT
         WHERE SNAP_ID = :snap FETCH FIRST 1 ROWS ONLY`,
        { snap: endSnap }
      );
      if (r2.rows && r2.rows[0]) endSnapTime = r2.rows[0][1] ? String(r2.rows[0][1]) : null;
    } catch (e) { /* non-critical */ }

    // Check ADVISOR privilege before attempting to create task
    // Detect missing privilege early so we can return a helpful grant SQL
    let advisorPrivCheck = true;
    try {
      await connection.execute(
        `SELECT 1 FROM SESSION_PRIVS WHERE PRIVILEGE = 'ADVISOR'`
      );
    } catch (e) {
      advisorPrivCheck = false;
    }

    // Run DBMS_ADDM.ANALYZE_DB
    const taskName = 'TUNEVAULT_ADDM_' + Date.now();
    const t1 = Date.now();
    try {
      if (dbId) {
        await connection.execute(
          `BEGIN DBMS_ADDM.ANALYZE_DB(:task_name, :begin_snap, :end_snap, :db_id); END;`,
          { task_name: taskName, begin_snap: beginSnap, end_snap: endSnap, db_id: dbId }
        );
      } else {
        await connection.execute(
          `BEGIN DBMS_ADDM.ANALYZE_DB(:task_name, :begin_snap, :end_snap); END;`,
          { task_name: taskName, begin_snap: beginSnap, end_snap: endSnap }
        );
      }
    } catch (addmErr) {
      const msg = String(addmErr.message || addmErr);
      const missingPriv = msg.includes('ORA-01031') || msg.includes('insufficient privileges') || msg.includes('ADVISOR');
      return {
        licensed: true,
        task_name: null, task_id: null, findings: [],
        run_error: msg,
        missing_privilege: missingPriv,
        // One-click grant SQL the operator can run as SYSDBA
        grant_sql: missingPriv ? `GRANT ADVISOR TO ${connParams.username.toUpperCase()};` : null,
        begin_snap_time: beginSnapTime,
        end_snap_time:   endSnapTime,
        run_info: { elapsed_ms: Date.now() - t0 },
      };
    }

    const t2 = Date.now();

    // Look up the task ID
    let taskId = null;
    try {
      const r = await connection.execute(
        `SELECT TASK_ID FROM DBA_ADVISOR_TASKS
         WHERE TASK_NAME = :name AND ADVISOR_NAME = 'ADDM'
         FETCH FIRST 1 ROWS ONLY`,
        { name: taskName }
      );
      if (r.rows && r.rows[0]) taskId = parseInt(r.rows[0][0]);
    } catch (e) { /* ignore */ }

    // Fetch raw report text via DBMS_ADVISOR.GET_TASK_REPORT (HTML or TEXT format)
    let rawReportText = null;
    if (taskId) {
      try {
        const r = await connection.execute(
          `SELECT DBMS_ADVISOR.GET_TASK_REPORT(:task_name, 'TEXT', 'ALL') FROM DUAL`,
          { task_name: taskName }
        );
        const clob = r.rows && r.rows[0] && r.rows[0][0];
        if (clob) {
          if (typeof clob === 'string') {
            rawReportText = clob;
          } else if (clob && typeof clob.getData === 'function') {
            rawReportText = await clob.getData();
          }
        }
      } catch (e) { /* non-fatal — raw report omitted */ }
    }

    // Parse DB time + avg active sessions from the raw report or from AWR sysmetric
    let dbTimeSeconds = null, avgActiveSessions = null;
    try {
      const r = await connection.execute(`
        SELECT SUM(VALUE) AS DB_TIME_SECS
        FROM DBA_HIST_SYS_TIME_MODEL
        WHERE SNAP_ID BETWEEN :begin_snap AND :end_snap
          AND STAT_NAME = 'DB time'
      `, { begin_snap: beginSnap, end_snap: endSnap });
      if (r.rows && r.rows[0] && r.rows[0][0] != null) {
        // DBA_HIST_SYS_TIME_MODEL stores in microseconds — convert to seconds
        dbTimeSeconds = parseFloat(r.rows[0][0]) / 1e6;
      }
    } catch (e) { /* non-critical */ }

    try {
      const r = await connection.execute(`
        SELECT AVG(VALUE)
        FROM DBA_HIST_SYSMETRIC_SUMMARY
        WHERE SNAP_ID BETWEEN :begin_snap AND :end_snap
          AND METRIC_NAME = 'Average Active Sessions'
      `, { begin_snap: beginSnap, end_snap: endSnap });
      if (r.rows && r.rows[0] && r.rows[0][0] != null) {
        avgActiveSessions = parseFloat(r.rows[0][0]);
      }
    } catch (e) { /* non-critical */ }

    // Fetch findings
    let rawFindings = [];
    if (taskId) {
      try {
        const r = await connection.execute(`
          SELECT f.FINDING_ID, f.TYPE, f.NAME, f.MESSAGE, f.IMPACT_DB_PERCENT, f.SQL_ID
          FROM DBA_ADVISOR_FINDINGS f
          WHERE f.TASK_ID = :taskId
          ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC
        `, { taskId });
        rawFindings = (r.rows || []).map(row => ({
          finding_id: parseInt(row[0]),
          type:       String(row[1] || 'INFORMATION'),
          name:       String(row[2] || ''),
          message:    String(row[3] || ''),
          impact_pct: parseFloat(row[4]) || 0,
          sql_id:     row[5] ? String(row[5]) : null,
        }));
      } catch (e) { /* ignore */ }
    }

    // Fetch recommendations + actions
    const findingIds = rawFindings.map(f => f.finding_id);
    const recMap = {};
    if (taskId && findingIds.length > 0) {
      try {
        const idPlaceholders = findingIds.map((_, i) => `:f${i}`).join(',');
        const bindObj = { taskId };
        findingIds.forEach((id, i) => { bindObj[`f${i}`] = id; });
        const rr = await connection.execute(`
          SELECT r.FINDING_ID, r.REC_ID, r.TYPE, r.BENEFIT_DB_PERCENT, r.MESSAGE
          FROM DBA_ADVISOR_RECOMMENDATIONS r
          WHERE r.TASK_ID = :taskId AND r.FINDING_ID IN (${idPlaceholders})
          ORDER BY r.FINDING_ID, r.REC_ID
        `, bindObj);
        for (const row of (rr.rows || [])) {
          const fid = parseInt(row[0]);
          if (!recMap[fid]) recMap[fid] = [];
          recMap[fid].push({ rec_id: parseInt(row[1]), type: String(row[2] || ''), benefit_pct: parseFloat(row[3]) || 0, message: String(row[4] || ''), actions: [] });
        }
        const ra = await connection.execute(`
          SELECT a.FINDING_ID, a.REC_ID, a.ACTION_ID, a.COMMAND, a.ATTR1, a.ATTR2, a.ATTR3, a.ATTR4
          FROM DBA_ADVISOR_ACTIONS a
          WHERE a.TASK_ID = :taskId AND a.FINDING_ID IN (${idPlaceholders})
          ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID
        `, bindObj);
        for (const row of (ra.rows || [])) {
          const fid = parseInt(row[0]), rid = parseInt(row[1]);
          const recs = recMap[fid] || [];
          const rec = recs.find(r => r.rec_id === rid);
          if (rec) rec.actions.push({ action_id: parseInt(row[2]), command: String(row[3] || ''), attr1: row[4] ? String(row[4]) : null, attr2: row[5] ? String(row[5]) : null, attr3: row[6] ? String(row[6]) : null, attr4: row[7] ? String(row[7]) : null });
        }
      } catch (e) { /* ignore */ }
    }

    const findings = rawFindings.map(f => ({
      ...f,
      severity: f.impact_pct >= 10 ? 'critical' : f.impact_pct >= 3 ? 'warning' : 'info',
      recommendations: recMap[f.finding_id] || [],
    }));

    return {
      licensed: true,
      task_name: taskName,
      task_id:   taskId,
      db_id:     dbId ? String(dbId) : null,
      container: container || null,
      begin_snap: beginSnap,
      end_snap:   endSnap,
      begin_snap_time: beginSnapTime,
      end_snap_time:   endSnapTime,
      db_time_seconds: dbTimeSeconds,
      avg_active_sessions: avgActiveSessions,
      findings,
      raw_report_text: rawReportText,
      run_info: {
        begin_snap_id: beginSnap,
        end_snap_id:   endSnap,
        analysis_ms:   t2 - t1,
        total_ms:      Date.now() - t0,
      },
      ...(findings.length === 0 ? { no_findings_reason: 'ADDM analysis completed — no significant database activity detected in this snapshot window.' } : {}),
    };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── runAddmWithPreset ────────────────────────────────────────────────────────
//
// Resolves a preset label (last_1h / last_4h / last_24h / last_bounce) to the
// nearest AWR snapshot IDs, then delegates to runAddmBySnapRange.
//
async function runAddmWithPreset(connParams, { preset = 'last_1h', container } = {}) {
  let connection;
  try {
    const connectString = `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString,
      connectTimeout: 20,
    });

    // Quick license gate before snapshot lookup
    const licenseInfo = await checkAddmLicense(connection);
    if (!licenseInfo.enterprise) return { licensed: false, not_licensed_reason: 'Oracle Standard Edition detected. ADDM requires Enterprise Edition + Diagnostics Pack.', findings: [] };
    if (!licenseInfo.diagnostics_licensed) return { licensed: false, not_licensed_reason: 'Oracle Diagnostics Pack license not detected.', findings: [] };

    // Map preset to hours-ago value
    const hoursMap = { last_1h: 1, last_4h: 4, last_24h: 24, last_bounce: null };
    const lookbackHours = hoursMap[preset] !== undefined ? hoursMap[preset] : 1;

    let beginSnap = null, endSnap = null;

    if (preset === 'last_bounce') {
      // Use snapshots since last instance startup
      try {
        const r = await connection.execute(`
          SELECT MIN(s.SNAP_ID), MAX(s.SNAP_ID)
          FROM DBA_HIST_SNAPSHOT s
          WHERE s.BEGIN_INTERVAL_TIME >= (
            SELECT STARTUP_TIME FROM V$INSTANCE
          )
          AND s.STATUS = 'Done'
        `);
        if (r.rows && r.rows[0]) {
          beginSnap = r.rows[0][0] != null ? parseInt(r.rows[0][0]) : null;
          endSnap   = r.rows[0][1] != null ? parseInt(r.rows[0][1]) : null;
        }
      } catch (e) { /* fall through to time-based */ }
    }

    if (!beginSnap || !endSnap) {
      // Time-based: find the two snapshots bracketing the lookback window
      const lookbackDays = (lookbackHours || 1) / 24;
      try {
        const r = await connection.execute(`
          SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT
          WHERE STATUS = 'Done'
            AND END_INTERVAL_TIME >= SYSDATE - :lb
          ORDER BY SNAP_ID ASC
          FETCH FIRST 1 ROWS ONLY
        `, { lb: lookbackDays });
        if (r.rows && r.rows[0]) beginSnap = parseInt(r.rows[0][0]);

        const r2 = await connection.execute(`
          SELECT SNAP_ID FROM DBA_HIST_SNAPSHOT
          WHERE STATUS = 'Done'
          ORDER BY SNAP_ID DESC
          FETCH FIRST 1 ROWS ONLY
        `);
        if (r2.rows && r2.rows[0]) endSnap = parseInt(r2.rows[0][0]);
      } catch (e) {
        return {
          licensed: true, findings: [], task_name: null, task_id: null,
          run_error: 'DBA_HIST_SNAPSHOT not accessible — missing SELECT_CATALOG_ROLE?',
        };
      }
    }

    if (!beginSnap || !endSnap || beginSnap >= endSnap) {
      return {
        licensed: true, findings: [], task_name: null, task_id: null,
        info: `Not enough AWR snapshots for preset "${preset}". Only ${endSnap ? 1 : 0} snapshot(s) found. Wait for the next automatic snapshot or widen the range.`,
      };
    }

    // Delegate to the explicit snap-range runner
    // (close this connection first — runAddmBySnapRange opens its own)
    await connection.close();
    connection = null;
    return runAddmBySnapRange(connParams, { beginSnap, endSnap, container, preset });
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── Scheduler Job Failures ───────────────────────────────────────────────────
/**
 * querySchedulerJobs — returns DBMS_SCHEDULER jobs that have failed or are disabled,
 * plus legacy DBMS_JOB broken jobs.
 * Available on all Oracle editions (DBA_SCHEDULER_JOBS + DBA_JOBS).
 *
 * Returns:
 *   { failed: JobRow[], disabled: JobRow[], broken_legacy: LegacyJobRow[], severity }
 *
 * JobRow: { owner, job_name, job_type, state, failure_count, last_run_date, next_run_date, error_code, error_message }
 * LegacyJobRow: { job_no, schema_user, what, broken, failures, next_date }
 */
async function querySchedulerJobs(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    // Failed DBMS_SCHEDULER jobs (last run failed or failure_count > 0)
    let failedRows = [];
    try {
      const r = await connection.execute(`
        SELECT owner, job_name, job_type, state,
               failure_count,
               TO_CHAR(last_start_date, 'YYYY-MM-DD HH24:MI:SS') AS last_run,
               TO_CHAR(next_run_date, 'YYYY-MM-DD HH24:MI:SS') AS next_run,
               last_run_duration,
               comments
        FROM dba_scheduler_jobs
        WHERE (state = 'FAILED' OR failure_count > 0)
          AND owner NOT IN ('SYS','SYSTEM','DBSNMP','ORACLE_OCM','EXFSYS','WMSYS','MDSYS','CTXSYS','XDB','ORDSYS','ORDPLUGINS')
        ORDER BY failure_count DESC, owner, job_name
        FETCH FIRST 50 ROWS ONLY
      `);
      failedRows = r.rows || [];
    } catch (e) { /* DBA_SCHEDULER_JOBS not accessible */ }

    // Disabled DBMS_SCHEDULER jobs (may indicate intentional or orphaned)
    let disabledRows = [];
    try {
      const r = await connection.execute(`
        SELECT owner, job_name, job_type, state,
               failure_count,
               TO_CHAR(last_start_date, 'YYYY-MM-DD HH24:MI:SS') AS last_run,
               TO_CHAR(next_run_date, 'YYYY-MM-DD HH24:MI:SS') AS next_run,
               comments
        FROM dba_scheduler_jobs
        WHERE state = 'DISABLED'
          AND owner NOT IN ('SYS','SYSTEM','DBSNMP','ORACLE_OCM','EXFSYS','WMSYS','MDSYS','CTXSYS','XDB','ORDSYS','ORDPLUGINS')
        ORDER BY owner, job_name
        FETCH FIRST 30 ROWS ONLY
      `);
      disabledRows = r.rows || [];
    } catch (e) { /* ignore */ }

    // Legacy DBMS_JOB broken jobs
    let brokenLegacy = [];
    try {
      const r = await connection.execute(`
        SELECT job, schema_user, SUBSTR(what,1,150) AS what,
               broken, failures,
               TO_CHAR(next_date, 'YYYY-MM-DD HH24:MI:SS') AS next_date
        FROM dba_jobs
        WHERE broken = 'Y' OR failures > 0
        ORDER BY failures DESC
        FETCH FIRST 20 ROWS ONLY
      `);
      brokenLegacy = r.rows || [];
    } catch (e) { /* DBA_JOBS not accessible */ }

    const failed = failedRows.map(row => ({
      OWNER: String(row[0] || ''),
      JOB_NAME: String(row[1] || ''),
      JOB_TYPE: String(row[2] || ''),
      STATE: String(row[3] || ''),
      FAILURE_COUNT: Number(row[4]) || 0,
      LAST_RUN: String(row[5] || ''),
      NEXT_RUN: String(row[6] || ''),
      LAST_RUN_DURATION: String(row[7] || ''),
      COMMENTS: String(row[8] || '')
    }));

    const disabled = disabledRows.map(row => ({
      OWNER: String(row[0] || ''),
      JOB_NAME: String(row[1] || ''),
      JOB_TYPE: String(row[2] || ''),
      STATE: String(row[3] || ''),
      FAILURE_COUNT: Number(row[4]) || 0,
      LAST_RUN: String(row[5] || ''),
      NEXT_RUN: String(row[6] || ''),
      COMMENTS: String(row[7] || '')
    }));

    const legacy = brokenLegacy.map(row => ({
      JOB_NO: Number(row[0]) || 0,
      SCHEMA_USER: String(row[1] || ''),
      WHAT: String(row[2] || ''),
      BROKEN: String(row[3] || ''),
      FAILURES: Number(row[4]) || 0,
      NEXT_DATE: String(row[5] || '')
    }));

    const severity = failed.length > 0 ? 'red' : (legacy.filter(j => j.BROKEN === 'Y').length > 0 ? 'yellow' : 'green');

    return { failed, disabled, broken_legacy: legacy, severity };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── Expired / Locked User Accounts ──────────────────────────────────────────
/**
 * queryExpiredUsers — returns Oracle user accounts that are expired, locked,
 * have soon-to-expire passwords, or use default Oracle passwords.
 * Available on all Oracle editions.
 *
 * Returns:
 *   { expired: UserRow[], locked: UserRow[], expiring_soon: UserRow[],
 *     default_passwords: DefaultPwdRow[], severity }
 *
 * UserRow: { username, account_status, expiry_date, lock_date, profile, created }
 */
async function queryExpiredUsers(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    // Exclude built-in system accounts from most checks
    const systemAccounts = `('SYS','SYSTEM','DBSNMP','ORACLE_OCM','XS$NULL','LBACSYS','OUTLN','REMOTE_SCHEDULER_AGENT','SYS$UMF','SPATIAL_CSW_ADMIN_USR','SPATIAL_WFS_ADMIN_USR','APPQOSSYS','SYSDG','SYSKM','SYSRAC','SYSBACKUP','XDB','APEX_PUBLIC_USER','FLOWS_FILES','ANONYMOUS','DIP','OJVMSYS')`;

    let expiredRows = [], lockedRows = [], expiringRows = [], defaultPwdRows = [];

    try {
      const r = await connection.execute(`
        SELECT username, account_status,
               TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
               TO_CHAR(lock_date, 'YYYY-MM-DD') AS lock_date,
               profile,
               TO_CHAR(created, 'YYYY-MM-DD') AS created
        FROM dba_users
        WHERE account_status LIKE '%EXPIRED%'
          AND username NOT IN ${systemAccounts}
        ORDER BY expiry_date NULLS LAST
        FETCH FIRST 40 ROWS ONLY
      `);
      expiredRows = r.rows || [];
    } catch (e) { /* ignore */ }

    try {
      const r = await connection.execute(`
        SELECT username, account_status,
               TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
               TO_CHAR(lock_date, 'YYYY-MM-DD') AS lock_date,
               profile,
               TO_CHAR(created, 'YYYY-MM-DD') AS created
        FROM dba_users
        WHERE account_status LIKE '%LOCKED%'
          AND account_status NOT LIKE '%EXPIRED%'
          AND username NOT IN ${systemAccounts}
        ORDER BY lock_date DESC NULLS LAST
        FETCH FIRST 40 ROWS ONLY
      `);
      lockedRows = r.rows || [];
    } catch (e) { /* ignore */ }

    try {
      const r = await connection.execute(`
        SELECT username, account_status,
               TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
               TO_CHAR(lock_date, 'YYYY-MM-DD') AS lock_date,
               profile,
               TO_CHAR(created, 'YYYY-MM-DD') AS created
        FROM dba_users
        WHERE account_status = 'OPEN'
          AND expiry_date BETWEEN SYSDATE AND SYSDATE + 30
          AND username NOT IN ${systemAccounts}
        ORDER BY expiry_date ASC
        FETCH FIRST 20 ROWS ONLY
      `);
      expiringRows = r.rows || [];
    } catch (e) { /* ignore */ }

    // Check for accounts using default Oracle passwords (DBA_USERS_WITH_DEFPWD)
    try {
      const r = await connection.execute(`
        SELECT u.username, u.account_status,
               TO_CHAR(u.expiry_date, 'YYYY-MM-DD') AS expiry_date,
               u.profile
        FROM dba_users_with_defpwd d
        JOIN dba_users u ON u.username = d.username
        WHERE u.account_status = 'OPEN'
          AND d.username NOT IN ${systemAccounts}
        ORDER BY u.username
        FETCH FIRST 30 ROWS ONLY
      `);
      defaultPwdRows = r.rows || [];
    } catch (e) { /* DBA_USERS_WITH_DEFPWD not accessible on older versions */ }

    function mapUserRow(row) {
      return {
        USERNAME: String(row[0] || ''),
        ACCOUNT_STATUS: String(row[1] || ''),
        EXPIRY_DATE: String(row[2] || ''),
        LOCK_DATE: String(row[3] || ''),
        PROFILE: String(row[4] || ''),
        CREATED: String(row[5] || '')
      };
    }

    const expired = expiredRows.map(mapUserRow);
    const locked = lockedRows.map(mapUserRow);
    const expiring_soon = expiringRows.map(mapUserRow);
    const default_passwords = defaultPwdRows.map(row => ({
      USERNAME: String(row[0] || ''),
      ACCOUNT_STATUS: String(row[1] || ''),
      EXPIRY_DATE: String(row[2] || ''),
      PROFILE: String(row[3] || '')
    }));

    const severity = (default_passwords.length > 0 || expired.filter(u => u.ACCOUNT_STATUS === 'EXPIRED').length > 0)
      ? 'red'
      : (expired.length > 0 || expiring_soon.length > 0)
        ? 'yellow'
        : 'green';

    return { expired, locked, expiring_soon, default_passwords, severity };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── Flashback / Data Guard Lag ───────────────────────────────────────────────
/**
 * queryDataGuardStatus — checks Data Guard standby lag and Flashback database status.
 * Available on all Oracle EE editions.
 *
 * Returns:
 *   { flashback_on, flashback_size_gb, db_unique_name,
 *     standby_databases: StandbyRow[], severity }
 *
 * StandbyRow: { name, role, db_unique_name, apply_lag, transport_lag, status }
 */
async function queryDataGuardStatus(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    // Flashback database status
    let flashbackOn = false, flashbackSizeGb = 0, dbRole = 'PRIMARY', dbUniqueName = '';
    try {
      const r = await connection.execute(`
        SELECT d.FLASHBACK_ON,
               ROUND(NVL(vf.ESTIMATED_FLASHBACK_SIZE,0) / 1073741824, 2) AS flashback_gb,
               d.DATABASE_ROLE,
               d.DB_UNIQUE_NAME
        FROM V$DATABASE d
        LEFT JOIN V$FLASHBACK_DATABASE_STAT vf ON 1=1
        FETCH FIRST 1 ROWS ONLY
      `);
      const row = r.rows?.[0] || [];
      flashbackOn = String(row[0] || 'NO') === 'YES';
      flashbackSizeGb = parseFloat(row[1]) || 0;
      dbRole = String(row[2] || 'PRIMARY');
      dbUniqueName = String(row[3] || '');
    } catch (e) { /* V$DATABASE not accessible */ }

    // Data Guard standby lag from V$DATAGUARD_STATS (available on EE)
    let standbyDatabases = [];
    try {
      const r = await connection.execute(`
        SELECT name, VALUE, UNIT, TIME_COMPUTED
        FROM V$DATAGUARD_STATS
        WHERE name IN ('transport lag', 'apply lag', 'apply finish time')
        ORDER BY name
      `);
      const rows = r.rows || [];
      // Group stats into a single standby entry
      if (rows.length > 0) {
        const stats = {};
        for (const row of rows) {
          stats[String(row[0] || '')] = String(row[1] || '');
        }
        standbyDatabases.push({
          APPLY_LAG: stats['apply lag'] || 'N/A',
          TRANSPORT_LAG: stats['transport lag'] || 'N/A',
          APPLY_FINISH_TIME: stats['apply finish time'] || 'N/A'
        });
      }
    } catch (e) { /* V$DATAGUARD_STATS not accessible — no Data Guard */ }

    // Check V$DATABASE_INCARNATION for physical standby info
    let dbIncarnations = [];
    try {
      const r = await connection.execute(`
        SELECT COUNT(*) FROM V$DATABASE_INCARNATION
      `);
      dbIncarnations = r.rows || [];
    } catch (e) { /* ignore */ }

    // Parse lag string like '+00 00:05:00.000000' into minutes
    function parseLagMinutes(lagStr) {
      if (!lagStr || lagStr === 'N/A') return null;
      const m = lagStr.match(/\+?(\d+)\s+(\d+):(\d+):(\d+)/);
      if (!m) return null;
      return (parseInt(m[1]) * 24 * 60) + (parseInt(m[2]) * 60) + parseInt(m[3]);
    }

    const applyLagMinutes = standbyDatabases.length > 0
      ? parseLagMinutes(standbyDatabases[0].APPLY_LAG)
      : null;

    // Severity: red if lag > 60min, yellow if lag > 10min or flashback off, green otherwise
    let severity = 'green';
    if (applyLagMinutes !== null && applyLagMinutes > 60) severity = 'red';
    else if (applyLagMinutes !== null && applyLagMinutes > 10) severity = 'yellow';
    else if (!flashbackOn && dbRole === 'PRIMARY') severity = 'yellow'; // flashback off is a yellow warning

    return {
      flashback_on: flashbackOn,
      flashback_size_gb: flashbackSizeGb,
      db_role: dbRole,
      db_unique_name: dbUniqueName,
      standby_databases: standbyDatabases,
      apply_lag_minutes: applyLagMinutes,
      severity
    };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── Recyclebin Usage ─────────────────────────────────────────────────────────
/**
 * queryRecyclebin — returns space consumed by objects in the Oracle Recyclebin.
 * Available on all Oracle editions (10g+).
 * Large recyclebin can cause misleading space reports and inflate segment scans.
 *
 * Returns:
 *   { total_objects, total_size_mb, by_owner: OwnerRow[], largest_objects: ObjRow[],
 *     recyclebin_enabled, severity }
 *
 * OwnerRow: { owner, object_count, size_mb }
 * ObjRow: { owner, original_name, type, size_mb, droptime }
 */
async function queryRecyclebin(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    // Check if recyclebin is enabled
    let recyclebinEnabled = true;
    try {
      const r = await connection.execute(
        `SELECT VALUE FROM V$PARAMETER WHERE name = 'recyclebin'`
      );
      recyclebinEnabled = String(r.rows?.[0]?.[0] || 'on').toLowerCase() !== 'off';
    } catch (e) { /* ignore */ }

    // Per-owner summary
    let ownerRows = [];
    try {
      const r = await connection.execute(`
        SELECT owner, COUNT(*) AS object_count,
               ROUND(SUM(space) * 8 / 1024, 2) AS size_mb
        FROM dba_recyclebin
        GROUP BY owner
        ORDER BY size_mb DESC
        FETCH FIRST 20 ROWS ONLY
      `);
      ownerRows = r.rows || [];
    } catch (e) { /* DBA_RECYCLEBIN not accessible */ }

    // Top 20 largest objects in recyclebin
    let largestRows = [];
    try {
      const r = await connection.execute(`
        SELECT owner, original_name, type,
               ROUND(space * 8 / 1024, 2) AS size_mb,
               TO_CHAR(droptime, 'YYYY-MM-DD HH24:MI') AS droptime
        FROM dba_recyclebin
        ORDER BY space DESC
        FETCH FIRST 20 ROWS ONLY
      `);
      largestRows = r.rows || [];
    } catch (e) { /* ignore */ }

    const byOwner = ownerRows.map(row => ({
      OWNER: String(row[0] || ''),
      OBJECT_COUNT: Number(row[1]) || 0,
      SIZE_MB: parseFloat(row[2]) || 0
    }));

    const largestObjects = largestRows.map(row => ({
      OWNER: String(row[0] || ''),
      ORIGINAL_NAME: String(row[1] || ''),
      TYPE: String(row[2] || ''),
      SIZE_MB: parseFloat(row[3]) || 0,
      DROPTIME: String(row[4] || '')
    }));

    const totalObjects = byOwner.reduce((sum, r) => sum + r.OBJECT_COUNT, 0);
    const totalSizeMb = byOwner.reduce((sum, r) => sum + r.SIZE_MB, 0);

    const severity = totalSizeMb > 10240 ? 'yellow' : // > 10 GB recyclebin = warning
      (totalObjects > 1000 ? 'yellow' : 'green');

    return {
      total_objects: totalObjects,
      total_size_mb: totalSizeMb,
      by_owner: byOwner,
      largest_objects: largestObjects,
      recyclebin_enabled: recyclebinEnabled,
      severity
    };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

// ─── Database Link Health ─────────────────────────────────────────────────────
/**
 * queryDatabaseLinks — returns configured database links and tests their connectivity.
 * Available on all Oracle editions.
 *
 * Returns:
 *   { links: LinkRow[], failed_count, ok_count, severity }
 *
 * LinkRow: { owner, db_link, username, host, created, status, error }
 */
async function queryDatabaseLinks(connParams) {
  let connection;
  try {
    const oracledb = require('oracledb');
    oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
    connection = await oracledb.getConnection({
      user: connParams.username,
      password: connParams.password,
      connectString: `${connParams.host}:${connParams.port || 1521}/${connParams.serviceName}`
    });

    // Enumerate all database links
    let linkRows = [];
    try {
      const r = await connection.execute(`
        SELECT owner, db_link, username, host,
               TO_CHAR(created, 'YYYY-MM-DD') AS created
        FROM dba_db_links
        ORDER BY owner, db_link
        FETCH FIRST 50 ROWS ONLY
      `);
      linkRows = r.rows || [];
    } catch (e) { /* DBA_DB_LINKS not accessible */ }

    // For each link, do a lightweight connectivity probe (SELECT 1 FROM DUAL@link)
    // Limit to first 10 links to avoid timeout; skip if many links
    const links = [];
    const probeable = linkRows.slice(0, 10);

    for (const row of probeable) {
      const owner = String(row[0] || '');
      const dbLink = String(row[1] || '');
      const username = String(row[2] || '');
      const host = String(row[3] || '');
      const created = String(row[4] || '');

      let status = 'untested';
      let error = '';

      // Only test PUBLIC or owned-by-current-user links to avoid permission issues
      if (owner === 'PUBLIC' || owner.toUpperCase() === (connParams.username || '').toUpperCase()) {
        try {
          await connection.execute(`SELECT 1 FROM DUAL@"${dbLink}"`);
          status = 'ok';
        } catch (e) {
          status = 'failed';
          error = String(e.message || '').substring(0, 200);
        }
      }

      links.push({ OWNER: owner, DB_LINK: dbLink, USERNAME: username, HOST: host, CREATED: created, STATUS: status, ERROR: error });
    }

    // For links beyond probe limit, add as untested
    for (const row of linkRows.slice(10)) {
      links.push({
        OWNER: String(row[0] || ''),
        DB_LINK: String(row[1] || ''),
        USERNAME: String(row[2] || ''),
        HOST: String(row[3] || ''),
        CREATED: String(row[4] || ''),
        STATUS: 'untested',
        ERROR: ''
      });
    }

    const failedCount = links.filter(l => l.STATUS === 'failed').length;
    const okCount = links.filter(l => l.STATUS === 'ok').length;

    const severity = failedCount > 0 ? 'red' : (links.length > 20 ? 'yellow' : 'green');

    return { links, failed_count: failedCount, ok_count: okCount, severity };
  } finally {
    if (connection) { try { await connection.close(); } catch (e) { /* ignore */ } }
  }
}

module.exports = { testConnection, collectMetrics, getSqlTuningRecommendations, queryAddmFindings, runAddmNow, listAWRSnapshots, runAddmBySnapRange, runAddmWithPreset, queryHousekeepingWindows, queryBlockingSessions, queryLongOperations, queryTopSqlBreakdown, queryInvalidObjects, queryUnusableIndexes, queryStaleStatistics, queryOracleParameters, querySchedulerJobs, queryExpiredUsers, queryDataGuardStatus, queryRecyclebin, queryDatabaseLinks, parseBytes, fmtBytes, classifyOracleError };
