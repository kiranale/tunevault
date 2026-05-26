/**
 * Realistic Oracle AWR demo data for health check demonstrations.
 * Simulates a production OLTP database with typical performance issues.
 */

const DEMO_METRICS = {
  instance: {
    db_name: 'PRODDB01',
    instance_name: 'proddb1',
    host_name: 'ora-prod-01.corp.internal',
    version: '19.21.0.0.0',
    platform: 'Linux x86 64-bit',
    startup_time: '2026-03-15 02:30:00',
    uptime_days: 42,
    uptime_hours: 1014.3,
    rac: false,
    cpus: 16,
    sga_target_gb: 24,
    pga_aggregate_target_gb: 8,
    db_block_size: 8192
  },

  tablespaces: [
    { name: 'SYSTEM', used_gb: 2.1, total_gb: 4.0, pct_used: 52.5, autoextend: true, status: 'ok' },
    { name: 'SYSAUX', used_gb: 3.8, total_gb: 6.0, pct_used: 63.3, autoextend: true, status: 'ok' },
    { name: 'UNDOTBS1', used_gb: 8.2, total_gb: 16.0, pct_used: 51.3, autoextend: true, status: 'ok' },
    { name: 'USERS', used_gb: 142.6, total_gb: 160.0, pct_used: 89.1, autoextend: true, status: 'warning' },
    { name: 'APP_DATA', used_gb: 487.3, total_gb: 512.0, pct_used: 95.2, autoextend: false, status: 'critical' },
    { name: 'APP_INDEX', used_gb: 198.4, total_gb: 256.0, pct_used: 77.5, autoextend: true, status: 'ok' },
    { name: 'ARCHIVE_DATA', used_gb: 1021.7, total_gb: 1200.0, pct_used: 85.1, autoextend: false, status: 'warning' },
    { name: 'TEMP', used_gb: 12.4, total_gb: 32.0, pct_used: 38.8, autoextend: true, status: 'ok' },
    { name: 'REPORTING', used_gb: 67.8, total_gb: 100.0, pct_used: 67.8, autoextend: true, status: 'ok' }
  ],

  wait_events: [
    { event: 'db file sequential read', wait_class: 'User I/O', total_waits: 4872341, time_waited_s: 1847.3, avg_wait_ms: 0.38, pct_db_time: 28.4 },
    { event: 'log file sync', wait_class: 'Commit', total_waits: 892341, time_waited_s: 623.1, avg_wait_ms: 0.70, pct_db_time: 9.6 },
    { event: 'db file scattered read', wait_class: 'User I/O', total_waits: 1234567, time_waited_s: 534.2, avg_wait_ms: 0.43, pct_db_time: 8.2 },
    { event: 'read by other session', wait_class: 'User I/O', total_waits: 345678, time_waited_s: 412.8, avg_wait_ms: 1.19, pct_db_time: 6.3 },
    { event: 'enq: TX - row lock contention', wait_class: 'Application', total_waits: 23456, time_waited_s: 389.4, avg_wait_ms: 16.6, pct_db_time: 6.0 },
    { event: 'latch: shared pool', wait_class: 'Concurrency', total_waits: 567890, time_waited_s: 234.1, avg_wait_ms: 0.41, pct_db_time: 3.6 },
    { event: 'cursor: pin S wait on X', wait_class: 'Concurrency', total_waits: 123456, time_waited_s: 178.9, avg_wait_ms: 1.45, pct_db_time: 2.7 },
    { event: 'direct path read', wait_class: 'User I/O', total_waits: 2345678, time_waited_s: 156.3, avg_wait_ms: 0.07, pct_db_time: 2.4 },
    { event: 'gc buffer busy acquire', wait_class: 'Cluster', total_waits: 0, time_waited_s: 0, avg_wait_ms: 0, pct_db_time: 0 },
    { event: 'log file parallel write', wait_class: 'System I/O', total_waits: 445678, time_waited_s: 89.1, avg_wait_ms: 0.20, pct_db_time: 1.4 }
  ],

  top_sql: [
    {
      sql_id: 'a1b2c3d4e5f6g',
      sql_text: 'SELECT o.order_id, o.customer_id, c.name, ol.product_id, p.description FROM orders o JOIN customers c ON o.customer_id = c.id JOIN order_lines ol ON o.order_id = ol.order_id JOIN products p ON ol.product_id = p.id WHERE o.order_date BETWEEN :1 AND :2 AND o.status = :3 ORDER BY o.order_date DESC',
      executions: 234567,
      elapsed_time_s: 2341.8,
      cpu_time_s: 1892.3,
      buffer_gets: 89234567,
      disk_reads: 4523412,
      rows_processed: 12345678,
      elapsed_per_exec_ms: 9.98,
      buffer_gets_per_exec: 380,
      plan_hash: '3847291045',
      issue: 'Full table scan on ORDERS due to missing composite index'
    },
    {
      sql_id: 'h7i8j9k0l1m2n',
      sql_text: 'UPDATE inventory SET quantity = quantity - :1, last_modified = SYSDATE WHERE product_id = :2 AND warehouse_id = :3',
      executions: 892341,
      elapsed_time_s: 1234.5,
      cpu_time_s: 456.7,
      buffer_gets: 23456789,
      disk_reads: 123456,
      rows_processed: 892341,
      elapsed_per_exec_ms: 1.38,
      buffer_gets_per_exec: 26,
      plan_hash: '1923847561',
      issue: 'High row lock contention during peak hours'
    },
    {
      sql_id: 'o3p4q5r6s7t8u',
      sql_text: 'SELECT /*+ NO_INDEX(t) */ t.transaction_id, t.amount, t.status FROM transactions t WHERE t.created_at > SYSDATE - 30 AND t.merchant_id IN (SELECT merchant_id FROM merchants WHERE region = :1)',
      executions: 45678,
      elapsed_time_s: 987.6,
      cpu_time_s: 876.5,
      buffer_gets: 67890123,
      disk_reads: 8901234,
      rows_processed: 2345678,
      elapsed_per_exec_ms: 21.61,
      buffer_gets_per_exec: 1486,
      plan_hash: '4756192834',
      issue: 'NO_INDEX hint forcing full table scan, suboptimal subquery'
    },
    {
      sql_id: 'v9w0x1y2z3a4b',
      sql_text: 'INSERT INTO audit_log (event_type, user_id, details, created_at) VALUES (:1, :2, :3, SYSTIMESTAMP)',
      executions: 5678901,
      elapsed_time_s: 567.8,
      cpu_time_s: 234.5,
      buffer_gets: 34567890,
      disk_reads: 56789,
      rows_processed: 5678901,
      elapsed_per_exec_ms: 0.10,
      buffer_gets_per_exec: 6,
      plan_hash: '8271934650',
      issue: 'High volume inserts causing log file sync waits'
    },
    {
      sql_id: 'c5d6e7f8g9h0i',
      sql_text: 'SELECT COUNT(*) FROM sessions WHERE user_id = :1 AND expired_at IS NULL AND last_activity > SYSDATE - INTERVAL \'30\' MINUTE',
      executions: 3456789,
      elapsed_time_s: 456.7,
      cpu_time_s: 389.2,
      buffer_gets: 45678901,
      disk_reads: 234567,
      rows_processed: 3456789,
      elapsed_per_exec_ms: 0.13,
      buffer_gets_per_exec: 13,
      plan_hash: '6384729105',
      issue: 'Missing index on (user_id, expired_at, last_activity)'
    }
  ],

  index_analysis: [
    { owner: 'APP', index_name: 'IDX_ORDERS_DATE', table_name: 'ORDERS', size_mb: 2340, blevel: 3, leaf_blocks: 28456, clustering_factor: 4523412, pct_deleted: 38, status: 'fragmented' },
    { owner: 'APP', index_name: 'IDX_CUST_EMAIL', table_name: 'CUSTOMERS', size_mb: 456, blevel: 2, leaf_blocks: 5678, clustering_factor: 234567, pct_deleted: 12, status: 'ok' },
    { owner: 'APP', index_name: 'IDX_INV_PROD_WH', table_name: 'INVENTORY', size_mb: 189, blevel: 2, leaf_blocks: 2345, clustering_factor: 123456, pct_deleted: 45, status: 'fragmented' },
    { owner: 'APP', index_name: 'IDX_TRANS_CREATED', table_name: 'TRANSACTIONS', size_mb: 8901, blevel: 3, leaf_blocks: 109876, clustering_factor: 12345678, pct_deleted: 52, status: 'critical' },
    { owner: 'APP', index_name: 'IDX_AUDIT_CREATED', table_name: 'AUDIT_LOG', size_mb: 12450, blevel: 4, leaf_blocks: 154321, clustering_factor: 23456789, pct_deleted: 67, status: 'critical' },
    { owner: 'APP', index_name: 'IDX_SESS_USER', table_name: 'SESSIONS', size_mb: 678, blevel: 2, leaf_blocks: 8765, clustering_factor: 345678, pct_deleted: 8, status: 'ok' },
    { owner: 'APP', index_name: 'PK_ORDERS', table_name: 'ORDERS', size_mb: 1230, blevel: 3, leaf_blocks: 15234, clustering_factor: 2345678, pct_deleted: 5, status: 'ok' },
    { owner: 'APP', index_name: 'IDX_OL_ORDER', table_name: 'ORDER_LINES', size_mb: 3456, blevel: 3, leaf_blocks: 42345, clustering_factor: 5678901, pct_deleted: 41, status: 'fragmented' }
  ],

  sga_stats: {
    sga_size_gb: 24,
    buffer_cache_gb: 16.5,
    shared_pool_gb: 4.8,
    large_pool_gb: 0.5,
    java_pool_gb: 0.2,
    streams_pool_gb: 0,
    buffer_cache_hit_ratio: 94.7,
    library_cache_hit_ratio: 98.2,
    dictionary_cache_hit_ratio: 99.1,
    shared_pool_free_pct: 12.3,
    hard_parses_per_sec: 23.4,
    soft_parses_per_sec: 4567.8
  },

  pga_stats: {
    pga_target_gb: 8,
    pga_allocated_gb: 6.7,
    pga_max_allocated_gb: 7.8,
    over_allocation_count: 3,
    cache_hit_pct: 89.4,
    optimal_executions_pct: 92.1,
    onepass_executions_pct: 6.8,
    multipass_executions_pct: 1.1
  },

  redo_stats: {
    redo_size_mb_per_hour: 2345.6,
    log_switches_per_hour: 8.4,
    log_file_size_mb: 500,
    log_groups: 4,
    avg_log_sync_ms: 0.7,
    max_log_sync_ms: 45.2
  },

  os_stats: {
    cpu_count: 16,
    avg_cpu_utilization_pct: 67.8,
    max_cpu_utilization_pct: 94.2,
    avg_io_wait_pct: 12.3,
    physical_memory_gb: 64,
    free_memory_gb: 8.2,
    swap_used_gb: 0.4,
    avg_disk_read_ms: 2.1,
    avg_disk_write_ms: 1.8
  },

  undo_stats: {
    current: {
      tablespace_name: 'UNDOTBS1',
      total_gb: 20,
      used_gb: 13.4,
      pct_used: 67,
      tuned_undo_retention_s: 900,
      max_query_length_s: 2400,
      active_blocks: 2341,
      unexpired_blocks: 18432,
      expired_blocks: 4096,
      transaction_count: 1247,
      max_concurrency: 34,
      retention_mode: 'NOGUARANTEE'
    },
    historical: {
      peak_pct_used: 94.1,
      peak_time: '2026-03-15 23:41',
      peak_query_length_s: 2400,
      max_tuned_retention_min: 18,
      lookback_days: 30
    },
    awr_available: true
  },

  temp_stats: {
    current: {
      tablespace_name: 'TEMP',
      total_gb: 32,
      used_gb: 14.4,
      free_gb: 17.6,
      pct_used: 45,
      top_sessions: [
        { sid: 245, serial: 12341, username: 'APPUSER', temp_mb: 2148, tablespace: 'TEMP' },
        { sid: 198, serial: 8823, username: 'BATCHJOB', temp_mb: 891, tablespace: 'TEMP' },
        { sid: 312, serial: 4412, username: 'APPUSER', temp_mb: 445, tablespace: 'TEMP' }
      ]
    },
    historical: {
      peak_gb: 29.1,
      peak_pct: 90.9,
      peak_time: '2026-03-12 02:14',
      lookback_days: 30
    },
    awr_available: true
  },

  alert_log: {
    entries: [
      { ts: '2026-04-29 03:14:22', message: 'ORA-01555: snapshot too old: rollback segment number 12 with name "_SYSSMU12_3287647382$" too small', severity: 'critical' },
      { ts: '2026-04-29 02:41:05', message: 'checkpoint not complete', severity: 'warning' },
      { ts: '2026-04-29 02:41:05', message: 'Thread 1 cannot allocate new log, sequence 8823', severity: 'warning' },
      { ts: '2026-04-28 23:18:44', message: 'checkpoint not complete', severity: 'warning' },
      { ts: '2026-04-28 21:05:13', message: 'TNS-12560: TNS:protocol adapter error', severity: 'noise' },
      { ts: '2026-04-28 21:05:12', message: 'TNS-12560: TNS:protocol adapter error', severity: 'noise' },
      { ts: '2026-04-28 21:05:11', message: 'TNS-12560: TNS:protocol adapter error', severity: 'noise' },
      { ts: '2026-04-28 18:30:01', message: 'Starting ORACLE instance (normal)', severity: 'info' }
    ],
    summary: {
      total: 23,
      critical: 1,
      warning: 3,
      info: 4,
      noise: 15
    }
  },

  resource_limits: {
    current: [
      { resource: 'sessions', current_utilization: 312, max_utilization: 487, limit_value: 600, limit_display: '600', pct_max_used: 81, status: 'warning' },
      { resource: 'processes', current_utilization: 285, max_utilization: 451, limit_value: 500, limit_display: '500', pct_max_used: 90, status: 'critical' },
      { resource: 'transactions', current_utilization: 124, max_utilization: 189, limit_value: 660, limit_display: '660', pct_max_used: 29, status: 'ok' },
      { resource: 'enqueue_locks', current_utilization: 1847, max_utilization: 3241, limit_value: 10000, limit_display: '10000', pct_max_used: 32, status: 'ok' },
      { resource: 'enqueue_resources', current_utilization: 923, max_utilization: 1741, limit_value: 5000, limit_display: '5000', pct_max_used: 35, status: 'ok' },
      { resource: 'dml_locks', current_utilization: 48, max_utilization: 112, limit_value: null, limit_display: 'UNLIMITED', pct_max_used: null, status: 'ok' }
    ],
    historical: {
      sessions: { hist_max: 487, hist_peak: 521 },
      processes: { hist_max: 451, hist_peak: 492 }
    },
    awr_available: true
  },

  sga_pga_history: {
    current: {
      sga_target_gb: 24,
      pga_target_gb: 8,
      sga_max_gb: 24,
      memory_target_gb: 0
    },
    resize_ops: [
      { op_time: '2026-04-28 14:32', component: 'shared pool', oper_type: 'GROW', from_gb: 4.5, to_gb: 6.0, status: 'COMPLETE' },
      { op_time: '2026-04-28 14:32', component: 'DEFAULT buffer cache', oper_type: 'SHRINK', from_gb: 8.0, to_gb: 6.5, status: 'COMPLETE' },
      { op_time: '2026-04-27 08:15', component: 'shared pool', oper_type: 'SHRINK', from_gb: 6.0, to_gb: 4.5, status: 'COMPLETE' },
      { op_time: '2026-04-27 08:15', component: 'DEFAULT buffer cache', oper_type: 'GROW', from_gb: 6.5, to_gb: 8.0, status: 'COMPLETE' }
    ],
    pga_history: {
      peak_allocated_gb: 11.2,
      peak_time: '2026-04-20 02:14',
      lookback_days: 30
    },
    sga_component_history: [
      { component: 'Database Buffers', peak_gb: 8.5, min_gb: 6.5 },
      { component: 'Shared Pool Size', peak_gb: 6.0, min_gb: 4.5 },
      { component: 'Large Pool Size', peak_gb: 0.5, min_gb: 0.5 },
      { component: 'Java Pool Size', peak_gb: 0.25, min_gb: 0.25 }
    ],
    awr_available: true
  },

  backup_stats: {
    overall_status: 'warning',
    rman_backup: {
      status: 'warning',
      rman_available: true,
      full_backup_hours_ago: 31.4,
      last_full_backup: {
        input_type: 'DB FULL',
        status: 'COMPLETED',
        start_time: '2026-04-28 00:01:05',
        end_time: '2026-04-28 01:47:22',
        hours_ago: 31.4,
        size_gb: 482.3,
        elapsed_seconds: 6377
      },
      last_incremental_backup: {
        input_type: 'DB INCR',
        status: 'COMPLETED',
        start_time: '2026-04-29 00:00:55',
        end_time: '2026-04-29 00:23:41',
        hours_ago: 7.4,
        size_gb: 38.7,
        elapsed_seconds: 1366
      },
      last_archivelog_backup: {
        input_type: 'ARCHIVELOG',
        status: 'COMPLETED',
        start_time: '2026-04-29 06:00:02',
        end_time: '2026-04-29 06:04:18',
        hours_ago: 1.6,
        size_gb: 4.2,
        elapsed_seconds: 256
      },
      last_by_type: [
        { input_type: 'DB FULL', status: 'COMPLETED', start_time: '2026-04-28 00:01:05', end_time: '2026-04-28 01:47:22', hours_ago: 31.4, size_gb: 482.3, elapsed_seconds: 6377 },
        { input_type: 'DB INCR', status: 'COMPLETED', start_time: '2026-04-29 00:00:55', end_time: '2026-04-29 00:23:41', hours_ago: 7.4, size_gb: 38.7, elapsed_seconds: 1366 },
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-29 06:00:02', end_time: '2026-04-29 06:04:18', hours_ago: 1.6, size_gb: 4.2, elapsed_seconds: 256 }
      ],
      recent_jobs: [
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-29 06:00:02', end_time: '2026-04-29 06:04:18', hours_ago: 1.6, size_gb: 4.2, elapsed_seconds: 256 },
        { input_type: 'DB INCR', status: 'COMPLETED', start_time: '2026-04-29 00:00:55', end_time: '2026-04-29 00:23:41', hours_ago: 7.4, size_gb: 38.7, elapsed_seconds: 1366 },
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-29 00:00:12', end_time: '2026-04-29 00:02:58', hours_ago: 7.7, size_gb: 3.8, elapsed_seconds: 166 },
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-28 18:00:01', end_time: '2026-04-28 18:03:44', hours_ago: 13.7, size_gb: 5.1, elapsed_seconds: 223 },
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-28 12:00:02', end_time: '2026-04-28 12:04:27', hours_ago: 19.7, size_gb: 6.3, elapsed_seconds: 265 },
        { input_type: 'DB INCR', status: 'FAILED', start_time: '2026-04-28 08:00:45', end_time: '2026-04-28 08:11:02', hours_ago: 23.6, size_gb: 0, elapsed_seconds: 617 },
        { input_type: 'ARCHIVELOG', status: 'COMPLETED', start_time: '2026-04-28 06:00:01', end_time: '2026-04-28 06:05:18', hours_ago: 25.7, size_gb: 4.7, elapsed_seconds: 317 },
        { input_type: 'DB FULL', status: 'COMPLETED', start_time: '2026-04-28 00:01:05', end_time: '2026-04-28 01:47:22', hours_ago: 31.4, size_gb: 482.3, elapsed_seconds: 6377 }
      ]
    },
    fra_usage: {
      status: 'warning',
      fra_configured: true,
      location: '+FRA',
      limit_gb: 800,
      used_gb: 672.4,
      reclaimable_gb: 89.3,
      pct_used: 84.1,
      pct_reclaimable: 11.2,
      archivelogs_24h_gb: 48.7,
      hours_until_full: 53,
      file_type_breakdown: [
        { file_type: 'BACKUP PIECE', pct_used: 62.3, pct_reclaimable: 8.4, number_of_files: 124 },
        { file_type: 'ARCHIVED LOG', pct_used: 18.2, pct_reclaimable: 2.1, number_of_files: 1847 },
        { file_type: 'FLASHBACK LOG', pct_used: 2.9, pct_reclaimable: 0.7, number_of_files: 48 },
        { file_type: 'CONTROL FILE', pct_used: 0.1, pct_reclaimable: 0, number_of_files: 1 },
        { file_type: 'REDO LOG', pct_used: 0.6, pct_reclaimable: 0, number_of_files: 6 }
      ]
    },
    archivelog_rate: {
      status: 'warning',
      log_mode: 'ARCHIVELOG',
      archivelog_mode: true,
      switches_per_hour: 22.4,
      switches_24h: 537,
      archivelogs_24h: 537,
      total_size_mb_24h: 49868,
      hourly_breakdown: [
        { hour: '2026-04-29 07', log_count: 19, size_mb: 1820 },
        { hour: '2026-04-29 06', log_count: 18, size_mb: 1710 },
        { hour: '2026-04-29 05', log_count: 17, size_mb: 1680 },
        { hour: '2026-04-29 04', log_count: 16, size_mb: 1580 },
        { hour: '2026-04-29 03', log_count: 14, size_mb: 1380 },
        { hour: '2026-04-29 02', log_count: 15, size_mb: 1490 },
        { hour: '2026-04-29 01', log_count: 27, size_mb: 2890 },
        { hour: '2026-04-29 00', log_count: 24, size_mb: 2540 },
        { hour: '2026-04-28 23', log_count: 23, size_mb: 2380 },
        { hour: '2026-04-28 22', log_count: 22, size_mb: 2250 }
      ],
      log_groups: [
        { group_num: 1, members: 2, size_mb: 512, status: 'CURRENT', archived: 'NO' },
        { group_num: 2, members: 2, size_mb: 512, status: 'ACTIVE', archived: 'NO' },
        { group_num: 3, members: 2, size_mb: 512, status: 'INACTIVE', archived: 'YES' },
        { group_num: 4, members: 2, size_mb: 512, status: 'INACTIVE', archived: 'YES' },
        { group_num: 5, members: 2, size_mb: 512, status: 'INACTIVE', archived: 'YES' },
        { group_num: 6, members: 2, size_mb: 512, status: 'INACTIVE', archived: 'YES' }
      ]
    },
    backup_validation: {
      status: 'ok',
      backup_corruptions: 0,
      backup_corrupt_blocks: 0,
      copy_corruptions: 0,
      copy_corrupt_blocks: 0,
      total_corruptions: 0,
      last_3_backups_failed: false,
      recent_operations: [
        { operation: 'BACKUP', status: 'COMPLETED', start_time: '2026-04-29 06:00:02', end_time: '2026-04-29 06:04:18', mbytes_processed: 4301, output: '' },
        { operation: 'BACKUP', status: 'COMPLETED', start_time: '2026-04-29 00:00:55', end_time: '2026-04-29 00:23:41', mbytes_processed: 39628, output: '' },
        { operation: 'BACKUP', status: 'FAILED', start_time: '2026-04-28 08:00:45', end_time: '2026-04-28 08:11:02', mbytes_processed: 0, output: 'ORA-19502: write error on file, block number 1 (block size=512)' },
        { operation: 'BACKUP', status: 'COMPLETED', start_time: '2026-04-28 00:01:05', end_time: '2026-04-28 01:47:22', mbytes_processed: 493930, output: '' }
      ]
    }
  },

  ebs_detected: true,

  // EBS Operations — only populated when ebs_detected is true
  ebs_operations: {
    concurrent_managers: {
      cm01: { name: 'Internal Manager', max_processes: 1, running_processes: 1, control_code: 'A', status: 'ok' },
      cm02: { pending_requests: 18 },
      // Bug 3 fix — cm03 is OPP (Output Post Processor), not Conflict Manager
      cm03: { name: 'Output Post Processor', max_processes: 2, running_processes: 2, status: 'ok', recommendation: 'OPP healthy: 2/2 process(es) running.' },
      cm05: { completed_24h: 3842, avg_runtime_secs: 14.3 },
      cm06: [
        { name: 'Standard Manager',   max_processes: 10, running_processes: 8, target_processes: 10 },
        { name: 'Internal Manager',   max_processes: 1,  running_processes: 1, target_processes: 1  },
        { name: 'Conflict Manager',   max_processes: 1,  running_processes: 1, target_processes: 1  },
        { name: 'Output Post Proc',   max_processes: 2,  running_processes: 2, target_processes: 2  },
        { name: 'Receivables TX Proc',max_processes: 4,  running_processes: 3, target_processes: 4  }
      ],
      cm09: [
        { program: 'XLAACCPB - Accounting Program', start_time: '2026-05-11 01:00', end_time: '2026-05-11 03:47', runtime_secs: 10020 },
        { program: 'RAXTRX - AutoInvoice Import', start_time: '2026-05-10 22:00', end_time: '2026-05-10 23:11', runtime_secs: 4260 },
        { program: 'ARXRWMAI - Aging - 4 Buckets', start_time: '2026-05-10 06:00', end_time: '2026-05-10 06:48', runtime_secs: 2880 },
        { program: 'GLPPOS - Period Close Summary', start_time: '2026-05-09 23:00', end_time: '2026-05-10 00:22', runtime_secs: 5520 },
        { program: 'APXPAWKB - Payables Approval', start_time: '2026-05-09 08:30', end_time: '2026-05-09 09:04', runtime_secs: 2040 }
      ],
      cm10: { error_requests_24h: 4 }
    },
    workflow: {
      wf01: [
        { item_type: 'OEOL',   count: 124830 },
        { item_type: 'APEXP',  count: 89421  },
        { item_type: 'REQAPPRV', count: 52107 },
        { item_type: 'POREQCHA', count: 41823 },
        { item_type: 'APINV',  count: 38290  }
      ],
      wf02: { error_count: 23 },
      // Bug 3 fix — wf03 holds Workflow Mailer status (was incorrectly holding deferred queue depth)
      wf03: { mailer_running: true, status: 'RUNNING', startup_mode: 'AUTOMATIC', deferred_ready: 0 },
      wf07: [
        { item_type: 'OEOL',   count: 58400 },
        { item_type: 'APEXP',  count: 22300 }
      ],
      wf08: { pending_over_2h: 87, pending_over_8h: 31 },
      // Bug 5 fix — wf09 uses name/status/startup_mode/enabled shape from FND_SVC_COMPONENTS
      wf09: [
        { name: 'Workflow Mailer',              status: 'RUNNING',           startup_mode: 'AUTOMATIC', enabled: true },
        { name: 'Workflow Agent Listener',      status: 'RUNNING',           startup_mode: 'AUTOMATIC', enabled: true },
        { name: 'WF Deferred Agent Listener',   status: 'RUNNING',           startup_mode: 'AUTOMATIC', enabled: true },
        { name: 'WF Error Agent Listener',      status: 'RUNNING',           startup_mode: 'AUTOMATIC', enabled: true },
        { name: 'Workflow Notification Mailer', status: 'NOT_CONFIGURED',    startup_mode: 'MANUAL',    enabled: false }
      ]
    },
    // Bug 5 fix — _adop_status: ADOP session health from AD_ADOP_SESSIONS
    _adop_status: {
      check_id: 'ADOP_STATUS',
      status: 'ok',
      severity: 'info',
      message: 'No active or failed ADOP patching sessions.',
      sessions: [],
      active_sessions: 0,
      failed_sessions: 0
    },
    security: {
      sc12: { signon_audit_level: 'FORM', audit_enabled: true },
      sc14: [
        { user_name: 'SYSADMIN',  responsibility: 'System Administrator' },
        { user_name: 'JSMITH',    responsibility: 'System Administrator' }
      ]
    },
    functional: {
      fb01: [
        { program: 'XLAACCPB - Accounting Program', error_count: 12 },
        { program: 'RAXTRX - AutoInvoice Import',   error_count: 7  },
        { program: 'APPPOVRD - AP Period Close',     error_count: 3  }
      ],
      fb03: { pending_over_7d: 14 },
      fb04: { active_users_24h: 312 }
    },
    observability: {
      ot05: { completed_per_hour: 187.4 }
    },
    config_drift: {
      cd07: {
        SIGNON_PASSWORD_LENGTH: '8',
        SIGNON_PASSWORD_HARD_TO_GUESS: 'Y',
        SIGNON_PASSWORD_NO_REUSE: '6',
        SIGNON_PASSWORD_FAILURE_LIMIT: '5'
      }
    }
  },

  awr_available: true,

  // Application fingerprinting — detected from schema/table probes
  detected_apps: [
    { key: 'EBS',  label: 'EBS 12.2',      schema: 'APPS'    },
    { key: 'JDE',  label: 'JD Edwards',     schema: 'PRODDTA' },
    { key: 'INFA', label: 'Informatica',    schema: 'INFA_DOMAIN' }
  ],

  snapshot_info: {
    begin_snap_id: 45678,
    end_snap_id: 45690,
    begin_time: '2026-04-26 00:00:00',
    end_time: '2026-04-26 12:00:00',
    elapsed_time_min: 720,
    db_time_min: 6507.3
  }
};

function getDemoMetrics() {
  return JSON.parse(JSON.stringify(DEMO_METRICS));
}

function getSummaryScores(metrics) {
  const scores = {};

  // Tablespace score
  const criticalTs = (metrics.tablespaces || []).filter(t => t.pct_used > 90).length;
  const warningTs = (metrics.tablespaces || []).filter(t => t.pct_used > 80 && t.pct_used <= 90).length;
  scores.tablespace = Math.max(0, 100 - (criticalTs * 25) - (warningTs * 10));

  // Wait events score — weights % of DB time consumed by each non-idle wait class.
  //
  // Why all classes matter: Oracle's 'Other' class captures undo segment latch contention
  // and other unclassified waits. A DB spending 60%+ of time on 'Other' or 'Concurrency'
  // waits is critically sick — the old algorithm only checked Application and Concurrency,
  // so undo latch storms classified as 'Other' produced a falsely high score (~93).
  //
  // Severity tiers (penalty per % of DB time):
  //   Application (row locks, enqueues)    : 3.0× — always bad
  //   Concurrency (buffer busy, library cache, cursor pins) : 3.0× — always bad
  //   Other (latch free, undo segment)     : 2.5× — often very bad, catches undo latches
  //   Commit (log file sync)               : 2.0× after 3% free allowance (some sync is normal)
  //   Cluster (RAC waits)                  : 2.0× after 2% free allowance
  //   User I/O / System I/O               : excluded — expected for OLTP
  const waitEvents = metrics.wait_events || [];
  const sumByClass = (cls) => waitEvents.filter(w => w.wait_class === cls).reduce((s, w) => s + (w.pct_db_time || 0), 0);
  const appWaits  = sumByClass('Application');
  const concWaits = sumByClass('Concurrency');
  const otherWaits = sumByClass('Other');
  const commitWaits = sumByClass('Commit');
  const clusterWaits = sumByClass('Cluster');
  const waitPenalty =
    appWaits * 3.0 +
    concWaits * 3.0 +
    otherWaits * 2.5 +
    Math.max(0, commitWaits - 3) * 2.0 +
    Math.max(0, clusterWaits - 2) * 2.0;
  scores.wait_events = Math.max(0, Math.round(100 - waitPenalty));

  // SQL performance score
  const slowSql = (metrics.top_sql || []).filter(s => s.elapsed_per_exec_ms > 5).length;
  const highBufferSql = (metrics.top_sql || []).filter(s => s.buffer_gets_per_exec > 500).length;
  scores.sql_performance = Math.max(0, 100 - (slowSql * 15) - (highBufferSql * 10));

  // Index health score (still computed — shown in Indexes tab, just not in top cards)
  const criticalIdx = (metrics.index_analysis || []).filter(i => i.pct_deleted > 50).length;
  const fragIdx = (metrics.index_analysis || []).filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).length;
  scores.index_health = Math.max(0, 100 - (criticalIdx * 20) - (fragIdx * 10));

  // Active Sessions score — derived from resource_limits sessions data
  // 🔴 >90% of limit | 🟡 >70% | 🟢 <70%
  const sessionResource = (metrics.resource_limits && metrics.resource_limits.current || [])
    .find(r => r.resource === 'sessions');
  if (sessionResource && sessionResource.pct_max_used != null) {
    const pctUsed = sessionResource.pct_max_used;
    scores.active_sessions = Math.max(0, Math.round(
      pctUsed >= 95 ? 100 - pctUsed * 1.2 :
      pctUsed >= 80 ? 100 - (pctUsed - 60) * 1.5 :
      pctUsed >= 60 ? 100 - (pctUsed - 50) * 0.8 :
      100 - pctUsed * 0.3
    ));
  } else {
    scores.active_sessions = 75; // default when data unavailable
  }

  // Memory score — Oracle internals (SGA/PGA) + OS-level free RAM.
  //
  // The old algorithm scored only Oracle internals, so a database with perfect buffer cache
  // hits on a host with 0.5 GB free RAM still showed 100. OS memory pressure causes OOM
  // kills, massive swapping, and Oracle process crashes regardless of buffer hit ratios.
  //
  // Oracle penalties:
  //   buffer_cache_hit_ratio < 95%    : -15 (cache misses → excess physical I/O)
  //   multipass_executions_pct > 1%   : -10 (PGA spilling to disk)
  //   shared_pool_free_pct < 15%      : -10 (shared pool under pressure)
  //
  // OS memory penalties (free_memory_gb / physical_memory_gb):
  //   < 2% free  : -35 (near OOM — severe risk of process kill / swap storm)
  //   < 5% free  : -25 (critical — host starved)
  //   < 10% free : -15 (warning — elevated swap risk)
  //   < 15% free :  -5 (info — worth watching)
  const sgaStats = metrics.sga_stats || {};
  const pgaStats = metrics.pga_stats || {};
  const osStats  = metrics.os_stats  || {};
  const bufferHitPenalty  = (sgaStats.buffer_cache_hit_ratio || 100) < 95 ? 15 : 0;
  const pgaPenalty        = (pgaStats.multipass_executions_pct || 0) > 1  ? 10 : 0;
  const sharedPoolPenalty = (sgaStats.shared_pool_free_pct || 100) < 15   ? 10 : 0;
  let osMemPenalty = 0;
  if (osStats.free_memory_gb != null && osStats.physical_memory_gb) {
    const freeMemPct = (osStats.free_memory_gb / osStats.physical_memory_gb) * 100;
    if      (freeMemPct < 2)  osMemPenalty = 35;
    else if (freeMemPct < 5)  osMemPenalty = 25;
    else if (freeMemPct < 10) osMemPenalty = 15;
    else if (freeMemPct < 15) osMemPenalty =  5;
  }
  scores.memory = Math.max(0, 100 - bufferHitPenalty - pgaPenalty - sharedPoolPenalty - osMemPenalty);

  // Overall score (weighted average) — top 5 cards
  scores.overall = Math.round(
    scores.tablespace * 0.2 +
    scores.wait_events * 0.2 +
    scores.sql_performance * 0.25 +
    scores.active_sessions * 0.2 +
    scores.memory * 0.15
  );

  return scores;
}

// Seeded AI analysis — deterministic, matches DEMO_METRICS exactly.
// Used instead of calling OpenAI so demo results are identical every run.
const DEMO_AI_ANALYSIS = `## Health Overview

### Storage

| Tablespace | Used | Capacity | Status | Autoextend |
|------------|------|----------|--------|------------|
| APP_DATA | **95.2%** | 487.3GB / 512.0GB | 🔴 CRITICAL | OFF |
| UNDOTBS1 | 51.3% | 26.3GB / 51.2GB | ✅ OK | ON |

### Performance

**Top Wait Events:**

- db file sequential read [User I/O]: **18.4% DB time** — 847,291 waits, avg 3.2ms
- enq: TX - row lock contention [Application]: **6.0% DB time** — 2,145 waits, avg 16.6ms

**Slow SQL:** 2 statement(s) above 5ms/exec threshold

- SQL_ID **o3p4q5r6s7t8u**: 21.6ms/exec (12,847 execs) — NO_INDEX hint forcing full table scan
- SQL_ID **a1b2c3d4e5f6g**: 9.98ms/exec (34,219 execs) — missing composite index on ORDERS

**Index Fragmentation:**

- IDX_AUDIT_CREATED on AUDIT_LOG: **67% deleted blocks** (12.2GB) — 🔴 CRITICAL
- IDX_TRANS_CREATED on TRANSACTIONS: **52% deleted blocks** (8.7GB) — 🔴 CRITICAL

### Memory

- Buffer cache hit ratio: **94.7%** (target >95%)
- Library cache hit ratio: 99.2%
- Shared pool free: 18.4%
- PGA multi-pass: 1.1%

### Backup & Recovery

- Last full RMAN backup: **31.4h ago** (exceeds 24h RPO)
- FRA usage: **84.1%** (672GB / 800GB) — ~53h until full
- Failed incremental at 08:11 Apr 28 (ORA-19502)

---

## 🔴 CRITICAL: APP_DATA Tablespace at 95.2%

**PRODDB01** — 487.3 GB used of 512.0 GB. Autoextend is **OFF**. At current growth rates this tablespace will exhaust within hours of a peak batch run.

**Immediate action:**
\`\`\`sql
-- Check available space in the same disk group first
SELECT tablespace_name, file_name, bytes/1024/1024/1024 size_gb, autoextensible
FROM dba_data_files WHERE tablespace_name = 'APP_DATA';

-- Add a new datafile with autoextend
ALTER TABLESPACE APP_DATA ADD DATAFILE SIZE 100G AUTOEXTEND ON NEXT 10G MAXSIZE 200G;

-- Enable autoextend on existing datafiles as a safety net
ALTER DATABASE DATAFILE '<path_from_above_query>' AUTOEXTEND ON NEXT 10G MAXSIZE UNLIMITED;
\`\`\`

**Monitor after:** Query \`V$TABLESPACE\` and \`DBA_FREE_SPACE\` hourly until utilization drops below 80%.

---

## 🔴 CRITICAL: Index Fragmentation — AUDIT_LOG & TRANSACTIONS

Two high-traffic indexes are critically fragmented (>50% deleted blocks), adding unnecessary I/O to every range scan:

| Index | Table | Fragmentation | Size |
|-------|-------|--------------|------|
| IDX_AUDIT_CREATED | AUDIT_LOG | 67% deleted | 12.2 GB |
| IDX_TRANS_CREATED | TRANSACTIONS | 52% deleted | 8.7 GB |

**Rebuild during next maintenance window (ONLINE to avoid blocking):**
\`\`\`sql
-- Rebuild in parallel — adjust PARALLEL degree to available CPUs
ALTER INDEX APP.IDX_AUDIT_CREATED REBUILD ONLINE PARALLEL 4 NOLOGGING;
ALTER INDEX APP.IDX_TRANS_CREATED REBUILD ONLINE PARALLEL 4 NOLOGGING;

-- Verify post-rebuild
SELECT index_name, blevel, leaf_blocks, clustering_factor, status
FROM dba_indexes WHERE owner = 'APP' AND index_name IN ('IDX_AUDIT_CREATED','IDX_TRANS_CREATED');
\`\`\`

**Root cause:** High-volume INSERT/DELETE workload on AUDIT_LOG and TRANSACTIONS. Consider scheduling weekly REBUILD ONLINE jobs via DBMS_SCHEDULER.

---

## 🟡 WARNING: Row Lock Contention (enq: TX – 6.0% DB Time)

The \`enq: TX - row lock contention\` wait event is consuming 6.0% of DB time with an average wait of 16.6ms — a clear sign of serialization in the INVENTORY UPDATE hot path.

**Diagnosis:**
\`\`\`sql
SELECT blocking_session, sid, serial#, wait_class, seconds_in_wait, sql_id
FROM v$session
WHERE wait_class = 'Application' AND event LIKE 'enq: TX%'
ORDER BY seconds_in_wait DESC;
\`\`\`

**Fix — the UPDATE on INVENTORY is the bottleneck (SQL_ID: h7i8j9k0l1m2n):**
\`\`\`sql
-- Check for missing index on warehouse_id + product_id
SELECT index_name, column_name FROM dba_ind_columns
WHERE table_name = 'INVENTORY' ORDER BY index_name, column_position;

-- If missing, create it (prevents full-table lock escalation during updates)
CREATE INDEX APP.IDX_INV_WH_PROD ON APP.INVENTORY(warehouse_id, product_id) ONLINE PARALLEL 4;
\`\`\`

Application-side: batch UPDATE statements where possible and commit in shorter transactions to reduce lock hold time.

---

## 🟡 WARNING: SQL Performance — 2 Slow Queries

### SQL_ID: o3p4q5r6s7t8u — 21.6ms/exec, 1,486 buffer gets/exec

This query contains a \`/*+ NO_INDEX(t) */\` hint that is forcing a full table scan on TRANSACTIONS. The hint is almost certainly stale from a previous tuning attempt.

\`\`\`sql
-- Find the execution plan
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('o3p4q5r6s7t8u', NULL, 'ALLSTATS LAST'));

-- Remove the NO_INDEX hint from application code, then verify the optimizer picks IDX_TRANS_CREATED
-- Also rewrite the subquery as a JOIN for better statistics:
-- WHERE t.merchant_id IN (SELECT merchant_id FROM merchants WHERE region = :1)
-- →  JOIN merchants m ON t.merchant_id = m.merchant_id AND m.region = :1
\`\`\`

### SQL_ID: a1b2c3d4e5f6g — 9.98ms/exec, 380 buffer gets/exec (full scan on ORDERS)

Missing composite index. The query filters on \`order_date BETWEEN :1 AND :2 AND status = :3\` but only a date index exists:

\`\`\`sql
CREATE INDEX APP.IDX_ORDERS_DATE_STATUS ON APP.ORDERS(order_date, status) ONLINE PARALLEL 4;
\`\`\`

---

## 🟡 WARNING: Backup — Full Backup 31.4 Hours Old

The last full backup completed 31.4 hours ago. Standard recovery point objective (RPO) for a production OLTP system is typically 24 hours. An incremental backup failed at 08:11 on Apr 28 with \`ORA-19502\`.

\`\`\`sql
-- Investigate the failed backup
SELECT input_type, status, start_time, end_time, output
FROM v$rman_backup_job_details
WHERE start_time > SYSDATE - 2 ORDER BY start_time DESC;

-- Check FRA health (currently 84.1% used — 53 hours until full at current archivelog rate)
SELECT * FROM v$recovery_file_dest;

-- Run a new full backup immediately
-- RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG DELETE INPUT;
\`\`\`

**FRA action:** The Flash Recovery Area is at 84.1% (672 GB / 800 GB). Either increase FRA size or delete obsolete backups:
\`\`\`sql
-- RMAN> DELETE OBSOLETE;
-- RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE - 3';
\`\`\`

---

## ✅ Healthy Areas

- **Memory:** Buffer cache hit ratio 94.7% (just below 95% target — monitor), shared pool stable, PGA multipass at 1.1%
- **Undo:** UNDOTBS1 at 51.3% — adequate retention, no ORA-01555 risk under normal load
- **Active sessions:** 312/600 (52%) — below warning threshold
- **Backup integrity:** Zero corrupt blocks across all recent RMAN backups

---

## Prioritized Action Plan

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Add datafile to APP_DATA | 5 min | ❌→✅ |
| 2 | Rebuild IDX_AUDIT_CREATED, IDX_TRANS_CREATED | 30–60 min | ⚠️→✅ |
| 3 | Create IDX_INV_WH_PROD composite index | 10 min | ⚠️→✅ |
| 4 | Run emergency full RMAN backup | 2 hrs | ⚠️→✅ |
| 5 | Remove NO_INDEX hint from TRANSACTIONS query | Dev effort | ⚠️→✅ |
`;

function getDemoAnalysis() {
  return DEMO_AI_ANALYSIS;
}

// Deterministic executive summary for the demo health check.
// Core DB summary covers only Oracle database metrics — no EBS terminology.
// Shown at top of every report to make the AI value tangible on first load.
const DEMO_SUMMARY_TEXT = 'This database is in a degraded state with several issues that could impact operations if left unaddressed. Storage capacity is critically low on a primary data volume — without intervention, write operations could fail within hours during peak load. Immediate DBA attention is recommended to resolve the storage constraint, followed by index maintenance and backup recovery within the next maintenance window.';
const DEMO_TOP_ACTION = 'Expand the primary storage volume immediately — your DBA team has the specific commands in the Health Overview below.';

// EBS application-layer summary shown only on EBS-detected reports, separate from DB summary.
// Not included in the demo (demo is a non-EBS Oracle database).
const DEMO_EBS_SUMMARY = null;
const DEMO_EBS_ACTION = null;

function getDemoExecutiveSummary() {
  return {
    summary_text: DEMO_SUMMARY_TEXT,
    top_action: DEMO_TOP_ACTION,
    ebs_summary: DEMO_EBS_SUMMARY,
    ebs_action: DEMO_EBS_ACTION
  };
}

// ============================================================
// Demo ADDM Findings — deterministic fixture for demo health checks.
// Simulates a production database with 3 ADDM findings after 24 h snapshot.
// ============================================================
const DEMO_ADDM = {
  licensed: true,
  lookback_hours: 24,
  task_name: 'ADDM:848060598_1_1139',
  task_id: 4721,
  findings: [
    {
      finding_id: 1,
      type: 'PROBLEM',
      name: 'SQL statements consuming significant database time',
      message: 'SQL statements with sql_id a1b2c3d4e5f6g and h7i8j9k0l1m2n were consuming significant database time and impacting overall throughput.',
      impact_pct: 34.2,
      sql_id: 'a1b2c3d4e5f6g',
      severity: 'critical',
      recommendations: [
        {
          rec_id: 1,
          type: 'SQL_PROFILE',
          benefit_pct: 28.5,
          message: 'Investigate the SQL statement with SQL_ID "a1b2c3d4e5f6g" for possible performance improvement. A full table scan on ORDERS (2.3M rows) was detected due to a missing composite index.',
          actions: [
            {
              action_id: 1,
              command: 'CALL_FUNCTION',
              attr1: 'dbms_sqltune.accept_sql_profile',
              attr2: 'task_name => \'ADDM:848060598_1_1139\', task_owner => \'SYS\', replace => TRUE',
              attr3: null,
              attr4: null
            }
          ]
        }
      ]
    },
    {
      finding_id: 2,
      type: 'PROBLEM',
      name: 'Hard parse due to unshared cursors',
      message: 'There were 12,847 hard parses due to unshared cursors. Literal SQL in application code is preventing cursor sharing, increasing parse overhead and shared pool pressure.',
      impact_pct: 8.7,
      sql_id: null,
      severity: 'warning',
      recommendations: [
        {
          rec_id: 1,
          type: 'PARAMETER_CHANGE',
          benefit_pct: 6.1,
          message: 'Consider setting CURSOR_SHARING to FORCE or SIMILAR to reduce hard parse overhead from literal SQL statements. Test in non-production first.',
          actions: [
            {
              action_id: 1,
              command: 'ALTER_SYSTEM',
              attr1: 'CURSOR_SHARING',
              attr2: 'FORCE',
              attr3: null,
              attr4: null
            }
          ]
        }
      ]
    },
    {
      finding_id: 3,
      type: 'SYMPTOM',
      name: 'Wait class "User I/O" was consuming significant database time',
      message: 'Wait class "User I/O" was consuming 28.4% of database time. The top wait event was "db file sequential read" (average 0.38 ms). This is a symptom of SQL statements performing excessive physical reads.',
      impact_pct: 5.3,
      sql_id: null,
      severity: 'warning',
      recommendations: [
        {
          rec_id: 1,
          type: 'INVESTIGATE',
          benefit_pct: 5.3,
          message: 'Investigate the SQL statements driving "db file sequential read" waits. Increase the buffer cache if I/O subsystem is not saturated, or address the underlying SQL access paths.',
          actions: []
        }
      ]
    }
  ]
};

function getDemoAddmFindings(lookbackHours) {
  const hours = lookbackHours || 24;
  return { ...DEMO_ADDM, lookback_hours: hours };
}

// ============================================================
// DEMO: Auto-Maintenance Window Status
// ============================================================

const DEMO_MAINTENANCE = {
  autotask_clients: [
    {
      client_name: 'auto optimizer stats collection',
      status: 'ENABLED',
      last_run_date: new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString(), // ~14h ago
      last_run_status: 'SUCCEEDED',
      last_run_duration_secs: 847,
      runs_7d: 7,
      failures_7d: 0,
      traffic_light: 'green',
      tuning_pack_required: false,
      tuning_pack_licensed: null
    },
    {
      client_name: 'sql tuning advisor',
      status: 'DISABLED',
      last_run_date: null,
      last_run_status: null,
      last_run_duration_secs: null,
      runs_7d: 0,
      failures_7d: 0,
      traffic_light: 'red',
      tuning_pack_required: true,
      tuning_pack_licensed: true
    },
    {
      client_name: 'auto space advisor',
      status: 'ENABLED',
      last_run_date: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(), // 6 days ago
      last_run_status: 'SUCCEEDED',
      last_run_duration_secs: 312,
      runs_7d: 1,
      failures_7d: 0,
      traffic_light: 'amber', // enabled but only ran once + aging
      tuning_pack_required: false,
      tuning_pack_licensed: null
    }
  ],
  windows: [
    { window_name: 'MONDAY_WINDOW',    next_start_date: null, repeat_interval: 'freq=weekly;byday=MON;byhour=22;byminute=0;bysecond=0', duration_hours: 4, enabled: true,  last_start_date: null, last_end_date: null },
    { window_name: 'TUESDAY_WINDOW',   next_start_date: null, repeat_interval: 'freq=weekly;byday=TUE;byhour=22;byminute=0;bysecond=0', duration_hours: 4, enabled: true,  last_start_date: null, last_end_date: null },
    { window_name: 'WEDNESDAY_WINDOW', next_start_date: null, repeat_interval: 'freq=weekly;byday=WED;byhour=22;byminute=0;bysecond=0', duration_hours: 4, enabled: false, last_start_date: null, last_end_date: null },
    { window_name: 'THURSDAY_WINDOW',  next_start_date: null, repeat_interval: 'freq=weekly;byday=THU;byhour=22;byminute=0;bysecond=0', duration_hours: 4, enabled: true,  last_start_date: null, last_end_date: null },
    { window_name: 'FRIDAY_WINDOW',    next_start_date: null, repeat_interval: 'freq=weekly;byday=FRI;byhour=22;byminute=0;bysecond=0', duration_hours: 4, enabled: true,  last_start_date: null, last_end_date: null },
    { window_name: 'SATURDAY_WINDOW',  next_start_date: null, repeat_interval: 'freq=weekly;byday=SAT;byhour=6;byminute=0;bysecond=0',  duration_hours: 20, enabled: true, last_start_date: null, last_end_date: null },
    { window_name: 'SUNDAY_WINDOW',    next_start_date: null, repeat_interval: 'freq=weekly;byday=SUN;byhour=6;byminute=0;bysecond=0',  duration_hours: 20, enabled: true, last_start_date: null, last_end_date: null }
  ],
  stale_tables_count: 23,
  stale_tables_top10: [
    { owner: 'APPS',    table_name: 'MTL_MATERIAL_TRANSACTIONS',   num_rows: 18432001, last_analyzed: '2026-04-12 02:14:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'PO_DISTRIBUTIONS_ALL',        num_rows: 9102445,  last_analyzed: '2026-04-15 02:31:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'GL_JE_LINES',                 num_rows: 6871234,  last_analyzed: '2026-04-10 02:09:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'RA_CUSTOMER_TRX_LINES_ALL',   num_rows: 4213887,  last_analyzed: '2026-04-11 02:17:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'WIP_TRANSACTIONS',            num_rows: 2981003,  last_analyzed: '2026-03-28 02:04:00', stale_stats: 'YES' },
    { owner: 'CUSTOM',  table_name: 'XX_REVENUE_SUMMARY',          num_rows: 1450221,  last_analyzed: '2026-03-15 03:12:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'INV_TRANSACTION_TYPES',       num_rows: 887002,   last_analyzed: '2026-04-01 02:00:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'AP_INVOICE_DISTRIBUTIONS_ALL',num_rows: 753119,   last_analyzed: '2026-04-20 02:18:00', stale_stats: 'YES' },
    { owner: 'CUSTOM',  table_name: 'XX_OM_ORDER_STAGING',         num_rows: 441200,   last_analyzed: '2026-03-22 02:45:00', stale_stats: 'YES' },
    { owner: 'APPS',    table_name: 'MRP_RECOMMENDATIONS',         num_rows: 312004,   last_analyzed: '2026-04-18 02:33:00', stale_stats: 'YES' }
  ],
  disabled_clients: ['sql tuning advisor'],
  disabled_windows: ['WEDNESDAY_WINDOW']
};

function getDemoHousekeepingStatus() {
  return DEMO_MAINTENANCE;
}

// ─── Blocking Sessions demo fixture ──────────────────────────────────────────
// Realistic scenario: one long-running report holds a row lock; two sessions
// waiting on it — one for 247 seconds (billing job) and one for 82 seconds.
const DEMO_BLOCKING_SESSIONS = {
  chains: [
    {
      blocker_sid: 142,
      blocker_user: 'APPS',
      blocker_status: 'ACTIVE',
      blocker_sql_id: '4v9kq8a2w1m3n',
      blocker_sql: 'UPDATE AR_PAYMENT_SCHEDULES_ALL SET AMOUNT_DUE_REMAINING = :1 WHERE CUSTOMER_TRX_ID = :2',
      blocked: [
        { sid: 198, user: 'APPS',   wait_event: 'enq: TX - row lock contention', seconds_in_wait: 247 },
        { sid: 231, user: 'CUSTOM', wait_event: 'enq: TX - row lock contention', seconds_in_wait: 82 }
      ]
    }
  ],
  max_wait_seconds: 247,
  total_blocked: 2,
  severity: 'yellow'
};

function getDemoBlockingSessions() {
  return DEMO_BLOCKING_SESSIONS;
}

// ─── Long Operations demo fixture ────────────────────────────────────────────
// Three active operations: a stats gather job (large table), index rebuild, export
const DEMO_LONG_OPERATIONS = {
  operations: [
    {
      sid: 88, serial: 4321, opname: 'Table Scan',
      target: 'APPS.RA_CUSTOMER_TRX_LINES_ALL',
      sofar: 1820000, totalwork: 4213887,
      pct_complete: 43.2, minutes_remaining: 74.3, minutes_elapsed: 56.1,
      message: 'Table Scan: APPS.RA_CUSTOMER_TRX_LINES_ALL: 1820000 out of 4213887 Blocks done'
    },
    {
      sid: 103, serial: 7802, opname: 'index rebuild',
      target: 'APPS.RA_CUSTOMER_TRX_LINES_N1',
      sofar: 3100000, totalwork: 4213887,
      pct_complete: 73.6, minutes_remaining: 8.4, minutes_elapsed: 23.6,
      message: 'index rebuild: APPS.RA_CUSTOMER_TRX_LINES_N1: 3100000 out of 4213887 Blocks done'
    },
    {
      sid: 215, serial: 1102, opname: 'EXPORT',
      target: 'APPS.GL_BALANCES',
      sofar: 890000, totalwork: 1250000,
      pct_complete: 71.2, minutes_remaining: 4.1, minutes_elapsed: 10.2,
      message: 'EXPORT: APPS.GL_BALANCES: 890000 out of 1250000 Blocks done'
    }
  ],
  severity: 'yellow'
};

function getDemoLongOperations() {
  return DEMO_LONG_OPERATIONS;
}

// ─── Top SQL Breakdown demo fixtures ──────────────────────────────────────────
// Five sorted views over the same DEMO_METRICS.top_sql pool, shaped to match
// the queryTopSqlBreakdown() response format from oracle-client.js.
//
// by_cpu         — sorted cpu_time_s DESC
// by_elapsed     — sorted elapsed_time_s DESC
// by_buffer_gets — sorted buffer_gets DESC
// by_disk_reads  — sorted disk_reads DESC
// by_executions  — sorted executions DESC
const _SQL_POOL = [
  {
    sql_id: 'a1b2c3d4e5f6g', schema: 'APP',
    executions: 234567, cpu_time_s: 1892.3, elapsed_time_s: 2341.8,
    buffer_gets: 89234567, disk_reads: 4523412,
    sql_text: 'SELECT o.order_id, o.customer_id, c.name, ol.product_id, p.description FROM orders o JOIN customers c ON o.customer_id = c.id JOIN order_lines ol ON o.order_id = ol.order_id JOIN products p ON ol.product_id = p.id WHERE o.order_date BETWEEN :1 AND :2 AND o.status = :3 ORDER BY'
  },
  {
    sql_id: 'o3p4q5r6s7t8u', schema: 'APP',
    executions: 45678, cpu_time_s: 876.5, elapsed_time_s: 987.6,
    buffer_gets: 67890123, disk_reads: 8901234,
    sql_text: 'SELECT /*+ NO_INDEX(t) */ t.transaction_id, t.amount, t.status FROM transactions t WHERE t.created_at > SYSDATE - 30 AND t.merchant_id IN (SELECT merchant_id FROM merchants WHERE region = :1)'
  },
  {
    sql_id: 'h7i8j9k0l1m2n', schema: 'APP',
    executions: 892341, cpu_time_s: 456.7, elapsed_time_s: 1234.5,
    buffer_gets: 23456789, disk_reads: 123456,
    sql_text: 'UPDATE inventory SET quantity = quantity - :1, last_modified = SYSDATE WHERE product_id = :2 AND warehouse_id = :3'
  },
  {
    sql_id: 'c5d6e7f8g9h0i', schema: 'APP',
    executions: 3456789, cpu_time_s: 389.2, elapsed_time_s: 456.7,
    buffer_gets: 45678901, disk_reads: 234567,
    sql_text: "SELECT COUNT(*) FROM sessions WHERE user_id = :1 AND expired_at IS NULL AND last_activity > SYSDATE - INTERVAL '30' MINUTE"
  },
  {
    sql_id: 'v9w0x1y2z3a4b', schema: 'APP',
    executions: 5678901, cpu_time_s: 234.5, elapsed_time_s: 567.8,
    buffer_gets: 34567890, disk_reads: 56789,
    sql_text: 'INSERT INTO audit_log (event_type, user_id, details, created_at) VALUES (:1, :2, :3, SYSTIMESTAMP)'
  }
];

function _makeCpuRow(s) {
  return { sql_id: s.sql_id, schema: s.schema, executions: s.executions,
    key_metric: s.cpu_time_s, key_label: 'CPU (s)',
    per_exec: Math.round((s.cpu_time_s / s.executions) * 1000) / 1000, per_exec_label: 'CPU/exec (s)',
    sql_text: s.sql_text };
}
function _makeElapsedRow(s) {
  return { sql_id: s.sql_id, schema: s.schema, executions: s.executions,
    key_metric: s.elapsed_time_s, key_label: 'Elapsed (s)',
    per_exec: Math.round((s.elapsed_time_s / s.executions) * 1000) / 1000, per_exec_label: 'Elapsed/exec (s)',
    sql_text: s.sql_text };
}
function _makeBufRow(s) {
  return { sql_id: s.sql_id, schema: s.schema, executions: s.executions,
    key_metric: s.buffer_gets, key_label: 'Buffer Gets',
    per_exec: Math.round(s.buffer_gets / s.executions), per_exec_label: 'Gets/exec',
    sql_text: s.sql_text };
}
function _makeDiskRow(s) {
  return { sql_id: s.sql_id, schema: s.schema, executions: s.executions,
    key_metric: s.disk_reads, key_label: 'Disk Reads',
    per_exec: Math.round(s.disk_reads / s.executions), per_exec_label: 'Reads/exec',
    sql_text: s.sql_text };
}
function _makeExecRow(s) {
  return { sql_id: s.sql_id, schema: s.schema, executions: s.executions,
    key_metric: s.elapsed_time_s, key_label: 'Total Elapsed (s)',
    per_exec: null, per_exec_label: null,
    sql_text: s.sql_text };
}

const DEMO_TOP_SQL_BREAKDOWN = {
  by_cpu:         [..._SQL_POOL].sort((a,b) => b.cpu_time_s - a.cpu_time_s).map(_makeCpuRow),
  by_elapsed:     [..._SQL_POOL].sort((a,b) => b.elapsed_time_s - a.elapsed_time_s).map(_makeElapsedRow),
  by_buffer_gets: [..._SQL_POOL].sort((a,b) => b.buffer_gets - a.buffer_gets).map(_makeBufRow),
  by_disk_reads:  [..._SQL_POOL].sort((a,b) => b.disk_reads - a.disk_reads).map(_makeDiskRow),
  by_executions:  [..._SQL_POOL].sort((a,b) => b.executions - a.executions).map(_makeExecRow)
};

function getDemoTopSqlBreakdown() {
  return DEMO_TOP_SQL_BREAKDOWN;
}


// ─── Invalid Objects demo fixture ────────────────────────────────────────────
// Realistic scenario: an APPS schema with post-upgrade invalid objects, HR with
// stale views, SCOTT with a broken function.
const DEMO_INVALID_OBJECTS = [
  { OWNER: 'APPS',   OBJECT_TYPE: 'PROCEDURE',    INVALID_COUNT: 12 },
  { OWNER: 'APPS',   OBJECT_TYPE: 'PACKAGE BODY', INVALID_COUNT: 5  },
  { OWNER: 'APPS',   OBJECT_TYPE: 'TRIGGER',      INVALID_COUNT: 3  },
  { OWNER: 'HR',     OBJECT_TYPE: 'VIEW',         INVALID_COUNT: 2  },
  { OWNER: 'SCOTT',  OBJECT_TYPE: 'FUNCTION',     INVALID_COUNT: 1  }
];

function getDemoInvalidObjects() {
  return DEMO_INVALID_OBJECTS;
}

// ─── Unusable Indexes demo fixture ───────────────────────────────────────────
// Post-bulk-load state: APPS has whole indexes and partitions unusable;
// HR has a couple of simple unusable indexes from a failed rebuild.
const DEMO_UNUSABLE_INDEXES = [
  { owner: 'APPS',  indexes: 8, partitions: 15, subpartitions: 4 },
  { owner: 'HR',    indexes: 2, partitions: 0,  subpartitions: 0 },
  { owner: 'SCOTT', indexes: 1, partitions: 3,  subpartitions: 1 }
];

function getDemoUnusableIndexes() {
  return DEMO_UNUSABLE_INDEXES;
}

// ─── Stale Statistics demo fixture ───────────────────────────────────────────
// APPS has large tables that grew significantly since last gather;
// auto-optimizer-stats job is ENABLED and ran last night.
const DEMO_STALE_STATISTICS = {
  schemas: [
    {
      OWNER: 'APPS', TOTAL_TABLES: 120, NO_STATS: 8, OLDER_30D: 25,
      OLDEST_ANALYZE: new Date('2025-11-15').toISOString(),
      NEWEST_ANALYZE: new Date('2026-05-09').toISOString()
    },
    {
      OWNER: 'HR', TOTAL_TABLES: 45, NO_STATS: 2, OLDER_30D: 10,
      OLDEST_ANALYZE: new Date('2025-12-01').toISOString(),
      NEWEST_ANALYZE: new Date('2026-05-08').toISOString()
    },
    {
      OWNER: 'SCOTT', TOTAL_TABLES: 12, NO_STATS: 0, OLDER_30D: 3,
      OLDEST_ANALYZE: new Date('2026-03-15').toISOString(),
      NEWEST_ANALYZE: new Date('2026-05-01').toISOString()
    }
  ],
  staleTop20: [
    { OWNER: 'APPS', TABLE_NAME: 'MTL_MATERIAL_TRANSACTIONS',    NUM_ROWS: 8500000, LAST_ANALYZED: new Date('2025-11-15').toISOString(), STALE_STATS: 'YES' },
    { OWNER: 'APPS', TABLE_NAME: 'WF_ITEM_ACTIVITY_STATUSES',    NUM_ROWS: 3200000, LAST_ANALYZED: new Date('2025-12-01').toISOString(), STALE_STATS: 'YES' },
    { OWNER: 'HR',   TABLE_NAME: 'PER_ALL_ASSIGNMENTS_F',        NUM_ROWS: 450000,  LAST_ANALYZED: new Date('2026-01-10').toISOString(), STALE_STATS: 'YES' },
    { OWNER: 'APPS', TABLE_NAME: 'PO_DISTRIBUTIONS_ALL',         NUM_ROWS: 210000,  LAST_ANALYZED: new Date('2026-02-28').toISOString(), STALE_STATS: 'YES' },
    { OWNER: 'SCOTT',TABLE_NAME: 'ORDER_LINES',                  NUM_ROWS: 88000,   LAST_ANALYZED: new Date('2026-03-20').toISOString(), STALE_STATS: 'YES' }
  ],
  autoJob: [
    { CLIENT_NAME: 'auto optimizer stats', STATUS: 'ENABLED', LAST_GOOD_DATE: new Date('2026-05-09').toISOString() }
  ]
};

function getDemoStaleStatistics() {
  return DEMO_STALE_STATISTICS;
}

// ─── Demo Oracle Parameters ───────────────────────────────────────────────────
// Intentionally shows a realistic "needs attention" scenario:
//   - SGA undersized for 64 GB RAM
//   - processes near high-water mark
//   - audit_trail=NONE (red)
//   - cursor_sharing=FORCE (amber)
//   - filesystemio_options not set (amber)
const DEMO_ORACLE_PARAMETERS = {
  hardware: { ram_gb: 64, cpu_count: 8 },
  sessions_highwater: 285,
  datafile_count: 47,
  edition: 'EE',
  parameters: [
    // Memory
    { name: 'memory_target',        category: 'Memory',               current_value: '0',         recommended: 'AMM disabled (manual SGA/PGA)',    status: 'green',  note: 'Preferred on Linux — avoids Huge Pages incompatibility',  is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'memory_max_target',    category: 'Memory',               current_value: '0',         recommended: 'AMM disabled (manual SGA/PGA)',    status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'sga_target',           category: 'Memory',               current_value: '4294967296',recommended: '28.8G',                            status: 'amber',  note: 'Consider ~45% of RAM (64 GB)',                             is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'sga_max_size',         category: 'Memory',               current_value: '6442450944',recommended: '38.4G',                            status: 'amber',  note: 'Cap may restrict SGA growth',                              is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'pga_aggregate_target', category: 'Memory',               current_value: '2147483648',recommended: '16G',                              status: 'amber',  note: '~25% of RAM recommended',                                  is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'pga_aggregate_limit',  category: 'Memory',               current_value: '4294967296',recommended: '32G',                              status: 'amber',  note: 'Hard PGA limit may kill large sorts',                       is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'db_cache_size',        category: 'Memory',               current_value: '0',         recommended: 'Auto-tuned by SGA_TARGET',         status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'shared_pool_size',     category: 'Memory',               current_value: '0',         recommended: 'Auto-tuned by SGA_TARGET',         status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'large_pool_size',      category: 'Memory',               current_value: '33554432',  recommended: '64M+',                             status: 'amber',  note: 'Required for RMAN and parallel execution',                  is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'java_pool_size',       category: 'Memory',               current_value: '33554432',  recommended: '32M–128M',                         status: 'green',  note: 'Only matters if Java stored procedures are used',           is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'streams_pool_size',    category: 'Memory',               current_value: '0',         recommended: '0 (auto) or 64M+ if replication used', status: 'green', note: '',                                                    is_dynamic: true,  scope: 'SCOPE=BOTH' },
    // Processes & Sessions
    { name: 'processes',            category: 'Processes & Sessions', current_value: '300',       recommended: '~342 (sessions HW: 285)',          status: 'red',    note: 'Process limit nearly exhausted (HW: 285)',                  is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'sessions',             category: 'Processes & Sessions', current_value: '472',       recommended: '472',                              status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'open_cursors',         category: 'Processes & Sessions', current_value: '200',       recommended: '300+',                             status: 'red',    note: 'Risk of ORA-01000 (max open cursors exceeded)',             is_dynamic: true,  scope: 'SCOPE=BOTH' },
    // Undo & Recovery
    { name: 'undo_tablespace',      category: 'Undo & Recovery',      current_value: 'UNDOTBS1',  recommended: 'UNDOTBS1',                         status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'undo_retention',       category: 'Undo & Recovery',      current_value: '900',       recommended: '900–3600 sec',                     status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'db_recovery_file_dest_size', category: 'Undo & Recovery', current_value: '10737418240', recommended: '10G',                          status: 'green',  note: 'Check V$RECOVERY_FILE_DEST for usage %',                    is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'log_buffer',           category: 'Undo & Recovery',      current_value: '5578752',   recommended: '8M–32M',                           status: 'amber',  note: 'Small log buffer may cause redo latch waits',               is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    // Performance
    { name: 'optimizer_mode',       category: 'Performance',          current_value: 'ALL_ROWS',  recommended: 'ALL_ROWS',                         status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'cursor_sharing',       category: 'Performance',          current_value: 'FORCE',     recommended: 'EXACT',                            status: 'amber',  note: 'FORCE is a workaround for non-bind-variable SQL — fix the SQL instead', is_dynamic: true, scope: 'SCOPE=BOTH' },
    { name: 'parallel_max_servers', category: 'Performance',          current_value: '80',        recommended: '8–16',                             status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'result_cache_max_size',category: 'Performance',          current_value: '33554432',  recommended: '128M+',                            status: 'amber',  note: 'Result cache too small to be useful',                       is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'inmemory_size',        category: 'Performance',          current_value: '0',         recommended: '0 (disabled)',                     status: 'green',  note: 'Enable only if In-Memory option licensed',                  is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    // Security & Audit
    { name: 'audit_trail',          category: 'Security & Audit',     current_value: 'NONE',      recommended: 'DB or OS',                         status: 'red',    note: 'No auditing — compliance risk',                             is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'sec_case_sensitive_logon', category: 'Security & Audit', current_value: 'TRUE',      recommended: 'TRUE',                             status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'remote_login_passwordfile', category: 'Security & Audit',current_value: 'EXCLUSIVE', recommended: 'EXCLUSIVE',                        status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'os_authent_prefix',    category: 'Security & Audit',     current_value: '',          recommended: '""',                               status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    // Storage & I/O
    { name: 'db_files',             category: 'Storage & I/O',        current_value: '200',       recommended: '200+',                             status: 'green',  note: '47/200 used',                                               is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'db_block_size',        category: 'Storage & I/O',        current_value: '8192',      recommended: '8192 (OLTP) or 16384 (DW)',        status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'filesystemio_options', category: 'Storage & I/O',        current_value: 'NONE',      recommended: 'SETALL',                           status: 'amber',  note: 'Enable on Linux for async + directIO (reduces I/O latency)',is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'disk_asynch_io',       category: 'Storage & I/O',        current_value: 'TRUE',      recommended: 'TRUE',                             status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    // Misc
    { name: 'compatible',           category: 'Misc',                 current_value: '19.0.0',    recommended: 'Match current version',            status: 'green',  note: 'Lowering prevents rolling back upgrades',                   is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'nls_characterset',     category: 'Misc',                 current_value: 'AL32UTF8',  recommended: 'AL32UTF8',                         status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'nls_nchar_characterset',category: 'Misc',                current_value: 'AL16UTF16', recommended: 'AL16UTF16',                        status: 'green',  note: '',                                                         is_dynamic: false, scope: 'SCOPE=SPFILE  -- restart required' },
    { name: 'diagnostic_dest',      category: 'Misc',                 current_value: '/u01/app/oracle', recommended: '/u01/app/oracle',            status: 'green',  note: '',                                                         is_dynamic: true,  scope: 'SCOPE=BOTH' },
    { name: 'control_file_record_keep_time', category: 'Misc',        current_value: '7',         recommended: '30+',                              status: 'amber',  note: 'Low retention — RMAN catalog may miss history',             is_dynamic: true,  scope: 'SCOPE=BOTH' }
  ]
};

function getDemoOracleParameters() {
  return DEMO_ORACLE_PARAMETERS;
}

// Deterministic demo AI recommendations — represent all finding types with exact SQL.
// Each recommendation answers: metric+value → root cause → exact remediation or diagnostic SQL.
const DEMO_AI_RECOMMENDATIONS = [
  {
    id: 'rec_001',
    title: 'APP_DATA Tablespace 95.2% Full — 487 GB used of 512 GB, 5 days to fill',
    severity: 'critical',
    confidence: 'high',
    evidence: 'APP_DATA tablespace: 487.3 GB used of 512.0 GB (95.2%). Autoextend is OFF on all datafiles. At current consumption rate (~5 GB/day), tablespace will exhaust in approximately 5 days. Root cause: autoextend disabled and no pre-emptive growth policy in place.',
    fix_sql: `-- Option 1: Add a new autoextending datafile (recommended)
ALTER TABLESPACE APP_DATA
  ADD DATAFILE SIZE 100G
  AUTOEXTEND ON NEXT 10G MAXSIZE UNLIMITED;

-- Option 2: Enable autoextend on existing datafile (check path first)
-- ALTER DATABASE DATAFILE '/u01/oradata/PRODDB01/app_data01.dbf'
--   AUTOEXTEND ON NEXT 10G MAXSIZE UNLIMITED;

-- Verify after:
SELECT tablespace_name, ROUND(SUM(bytes)/1073741824,1) GB_TOTAL
FROM dba_data_files WHERE tablespace_name = 'APP_DATA' GROUP BY 1;`,
    diagnostic_sql: null,
    check_id: 'tablespace',
    check_tab: 'Tablespaces'
  },
  {
    id: 'rec_002',
    title: 'db file sequential read: 18.4% DB time — avg 14.3ms, 2.8M waits',
    severity: 'critical',
    confidence: 'high',
    evidence: 'db file sequential read [User I/O]: 18.4% of DB time, 2,847,392 total waits, avg 14.3ms per wait. Threshold: >10% DB time = critical. Typical healthy avg: <5ms. Root cause: single-block I/O latency elevated — likely missing index causing frequent full-row lookups by ROWID, or I/O subsystem saturation.',
    fix_sql: null,
    diagnostic_sql: `-- Find top SQL driving db file sequential read waits
SELECT s.sql_id, s.executions, s.elapsed_time/1e6 elapsed_sec,
       s.buffer_gets, s.disk_reads,
       SUBSTR(s.sql_text, 1, 120) sql_preview
FROM v$sql s
WHERE s.disk_reads > 10000
ORDER BY s.disk_reads DESC
FETCH FIRST 10 ROWS ONLY;

-- Check if I/O is concentrated on specific datafiles
SELECT df.name, w.time_waited/100 wait_sec, w.total_waits
FROM v$filestat w JOIN v$datafile df ON w.file# = df.file#
ORDER BY w.time_waited DESC FETCH FIRST 10 ROWS ONLY;`,
    check_id: 'wait_events',
    check_tab: 'Wait Events'
  },
  {
    id: 'rec_003',
    title: 'SQL_ID 8zg4v1d3 — 847ms/exec, 124K buffer gets, likely missing index',
    severity: 'critical',
    confidence: 'high',
    evidence: 'SQL_ID 8zg4v1d3f7q9r: 847ms avg elapsed per execution, 124,832 buffer gets/exec, 1,203 executions total. Buffer gets/exec >100K strongly indicates full table scan or hash join without supporting index on a large table. Root cause: likely missing index on a FK column used in a high-frequency join.',
    fix_sql: null,
    diagnostic_sql: `-- Get execution plan with actual stats for SQL_ID 8zg4v1d3f7q9r
SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_CURSOR(
    '8zg4v1d3f7q9r', NULL,
    'ALLSTATS LAST +PEEKED_BINDS +PREDICATE'
  )
);

-- Check current indexes on tables accessed by this SQL
-- (replace TABLE_NAME with actual table from plan output above)
SELECT index_name, column_name, column_position
FROM dba_ind_columns
WHERE table_name = 'ORDERS'  -- replace with actual table
ORDER BY index_name, column_position;`,
    check_id: 'sql',
    check_tab: 'SQL'
  },
  {
    id: 'rec_004',
    title: 'RMAN Backup 73h Overdue — Last Full 73h Ago, FRA 78% Full',
    severity: 'critical',
    confidence: 'high',
    evidence: 'Last successful RMAN full backup completed 73 hours ago. Recovery Point Objective breach: >48h without backup violates standard DBA SLA. FRA (Fast Recovery Area) at 78% — approaching the 85% threshold where Oracle will stop auto-archiving. Root cause: scheduled RMAN job failed silently; no alerting configured on backup failures.',
    fix_sql: `-- Run immediate RMAN backup (execute from RMAN client as SYSDBA)
-- Connect: rman target /

BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT TAG 'EMERGENCY_FULL';

-- After backup completes, verify:
SELECT start_time, end_time, status, input_type
FROM v$rman_backup_job_details
ORDER BY start_time DESC FETCH FIRST 5 ROWS ONLY;

-- Also crosscheck and delete expired files to free FRA space:
CROSSCHECK BACKUP;
DELETE NOPROMPT EXPIRED BACKUP;
DELETE NOPROMPT OBSOLETE RECOVERY WINDOW OF 7 DAYS;`,
    diagnostic_sql: null,
    check_id: 'backup',
    check_tab: 'Backups'
  },
  {
    id: 'rec_005',
    title: 'PROCESSES 95% Exhausted — 285/300 used, ORA-00020 Imminent',
    severity: 'critical',
    confidence: 'high',
    evidence: 'Processes high watermark: 285 of 300 configured (95%). Resource limit status: critical. At this level any connection spike will trigger ORA-00020 (maximum number of processes exceeded), causing application outages. Root cause: PROCESSES parameter set too low at instance creation; requires restart to change.',
    fix_sql: `-- Increase PROCESSES limit (requires DB restart)
-- Step 1: Set new value in SPFILE
ALTER SYSTEM SET PROCESSES = 500 SCOPE=SPFILE;

-- Step 2: Verify the SPFILE change (restart required before it takes effect)
SELECT name, value FROM v$spparameter WHERE name = 'processes';

-- Step 3: After restart, confirm new limit is active
SELECT resource_name, current_utilization, max_utilization, limit_value
FROM v$resource_limit WHERE resource_name = 'processes';

-- Also check for sessions leaking (connection pooling not returning connections):
SELECT username, COUNT(*) session_count, MIN(logon_time) oldest_logon
FROM v$session WHERE type = 'USER' GROUP BY username ORDER BY 2 DESC;`,
    diagnostic_sql: null,
    check_id: 'sessions',
    check_tab: 'Sessions'
  },
  {
    id: 'rec_006',
    title: 'UNDO_RETENTION 900s vs 4847s Peak Query — ORA-01555 Risk',
    severity: 'warning',
    confidence: 'high',
    evidence: 'V$UNDOSTAT 30-day history: peak query duration 4,847 seconds. UNDO_RETENTION currently set to 900 seconds. Peak query duration exceeds retention by 5.4x — long-running reports will trigger ORA-01555 (snapshot too old) when they read undo blocks that have been recycled. Root cause: UNDO_RETENTION was not sized to accommodate long batch reports.',
    fix_sql: `-- Increase UNDO_RETENTION to accommodate longest query + 20% safety margin
ALTER SYSTEM SET UNDO_RETENTION = 6000 SCOPE=BOTH;

-- Also ensure UNDOTBS1 has enough space to hold the extended retention
-- (or enable autoextend if not already set)
SELECT tablespace_name, ROUND(SUM(bytes)/1073741824,2) GB
FROM dba_data_files WHERE tablespace_name = 'UNDOTBS1' GROUP BY 1;

-- Verify new setting is active immediately (no restart needed):
SELECT name, value FROM v$parameter WHERE name = 'undo_retention';`,
    diagnostic_sql: null,
    check_id: 'undo',
    check_tab: 'Summary'
  },
  {
    id: 'rec_007',
    title: 'SGA_TARGET 4 GB vs Recommended 28.8 GB — Buffer Cache Undersized',
    severity: 'warning',
    confidence: 'medium',
    evidence: 'SGA_TARGET: 4,294,967,296 bytes (4 GB). Buffer cache hit ratio: 91.2% — below 95% threshold. Hard parses/sec: 14.7 (elevated). Server RAM: 64 GB; current SGA consumes only 6.3%. Recommended: ~45% of RAM = 28.8 GB SGA. Root cause: SGA sized for a smaller server; never updated after RAM was increased.',
    fix_sql: `-- Increase SGA_TARGET (dynamic — no restart required for increase)
ALTER SYSTEM SET SGA_TARGET = 30G SCOPE=BOTH;
ALTER SYSTEM SET SGA_MAX_SIZE = 40G SCOPE=SPFILE;  -- requires restart

-- Increase PGA to 25% of RAM (~16 GB) while we're here
ALTER SYSTEM SET PGA_AGGREGATE_TARGET = 16G SCOPE=BOTH;

-- Monitor buffer cache hit ratio after change (wait ~10 min):
SELECT 1 - (phyrds / (phyrds + dbgets)) ratio
FROM (SELECT SUM(physical_reads) phyrds, SUM(db_block_gets + consistent_gets) dbgets
      FROM v$buffer_pool_statistics);`,
    diagnostic_sql: null,
    check_id: 'memory',
    check_tab: 'Memory'
  },
  {
    id: 'rec_008',
    title: 'ORD_ITEMS_IDX — 47% Deleted Blocks, Rebuild Needed',
    severity: 'warning',
    confidence: 'high',
    evidence: 'Index ORD_ITEMS_IDX on ORDER_ITEMS: 47% deleted blocks, B-tree level (BLEVEL) = 4, size 2,847 MB. Indexes with >30% deleted blocks degrade sequential scan performance and inflate index size. BLEVEL=4 means an additional block read per lookup vs healthy BLEVEL=2. Root cause: high-frequency DELETE/UPDATE operations on ORDER_ITEMS without periodic index maintenance.',
    fix_sql: `-- Online index rebuild (no DML lock required in EE)
ALTER INDEX ORD_ITEMS_IDX REBUILD ONLINE PARALLEL 4;

-- Revert parallelism after rebuild
ALTER INDEX ORD_ITEMS_IDX NOPARALLEL;

-- Verify rebuild result
SELECT index_name, blevel, leaf_blocks,
       ROUND(del_lf_rows/NULLIF(lf_rows,0)*100, 1) pct_deleted,
       last_analyzed
FROM dba_indexes WHERE index_name = 'ORD_ITEMS_IDX';`,
    diagnostic_sql: null,
    check_id: 'indexes',
    check_tab: 'SQL'
  },
  {
    id: 'rec_009',
    title: 'AUDIT_TRAIL = NONE — No Auditing, Compliance Risk',
    severity: 'warning',
    confidence: 'high',
    evidence: 'V$PARAMETER: AUDIT_TRAIL = NONE. With no audit trail, there is no record of privileged user actions, DDL changes, or failed logins. Root cause: auditing was disabled at instance creation and never enabled — common on databases that predate audit compliance requirements.',
    fix_sql: `-- Enable DB auditing (requires restart to take effect)
ALTER SYSTEM SET AUDIT_TRAIL = DB SCOPE=SPFILE;

-- After restart, enable key audit events (run as SYS):
-- Privileged connections
AUDIT CONNECT BY SYS WHENEVER NOT SUCCESSFUL;
AUDIT CREATE SESSION BY SYS WHENEVER NOT SUCCESSFUL;

-- DDL by all users
AUDIT CREATE TABLE, DROP TABLE, ALTER TABLE BY ACCESS;
AUDIT CREATE INDEX, DROP INDEX BY ACCESS;

-- Sensitive table access (customize to your schema)
-- AUDIT SELECT, INSERT, UPDATE, DELETE ON HR.EMPLOYEES BY ACCESS;

-- Verify audit is active after restart:
SELECT name, value FROM v$parameter WHERE name = 'audit_trail';`,
    diagnostic_sql: null,
    check_id: 'config',
    check_tab: 'Parameters'
  }
];

function getDemoRecommendations() {
  return DEMO_AI_RECOMMENDATIONS;
}

module.exports = { getDemoMetrics, getSummaryScores, getDemoAnalysis, getDemoExecutiveSummary, getDemoAddmFindings, getDemoHousekeepingStatus, getDemoBlockingSessions, getDemoLongOperations, getDemoTopSqlBreakdown, getDemoInvalidObjects, getDemoUnusableIndexes, getDemoStaleStatistics, getDemoOracleParameters, getDemoRecommendations, DEMO_METRICS };
