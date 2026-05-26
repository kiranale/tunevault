/**
 * services/ebs-12-2-checks.js — EBS 12.2 deep check catalog and runner.
 *
 * Owns: EBS 12.2-specific check registry across 5 categories:
 *   A. Topology & Sizing  (8 checks) — TNS + SSH
 *   B. JVM Heap & GC      (6 checks) — SSH
 *   C. OS Metrics         (7 checks) — SSH
 *   D. Code Levels        (6 checks) — TNS
 *   E. ETCC               (3 checks) — SSH
 *
 * Does NOT own: SSH session lifecycle (ssh-executor.js), Oracle auth,
 *               HTTP routing, credential storage.
 *
 * Each check declares:
 *   id               — stable identifier
 *   label            — human label
 *   category         — one of: topology, jvm_heap, os_metrics, code_levels, etcc
 *   type             — 'tns' | 'ssh'
 *   min_ebs_version  — '12.2.7' (all checks in this file)
 *   requires_ssh     — true | false
 *   requires         — 'apps_tier' | 'db_tier' | 'any' (for SSH checks)
 *   command_key      — key in ssh-executor COMMAND_WHITELIST (SSH checks only)
 *   sql              — Oracle SQL string (TNS checks only)
 *   parse(result)    → { status, value, evidence, recommendation }
 *     status: 'ok' | 'warn' | 'crit' | 'info' | 'error'
 */

'use strict';

const executor = require('./ssh-executor');

// ─── Check registry ──────────────────────────────────────────────────────────

const EBS_12_2_CHECKS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // A. TOPOLOGY & SIZING (8 checks)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'topo.oacore_count',
    label: 'OACore managed server count',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT count(*) as cnt,
                 listagg(node_name, ', ') within group (order by node_name) as nodes
          FROM apps.fnd_nodes
          WHERE support_web = 'Y' AND status = 'A'`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'error', value: 'Query failed', evidence: 'FND_NODES inaccessible', recommendation: 'Verify APPS schema access.' };
      }
      const cnt = parseInt(rows[0].CNT || rows[0].cnt, 10);
      const nodes = rows[0].NODES || rows[0].nodes || '';
      if (isNaN(cnt) || cnt === 0) {
        return { status: 'crit', value: '0 web nodes', evidence: 'No active web nodes in FND_NODES', recommendation: 'Check APPS.FND_NODES for SUPPORT_WEB=Y active entries.' };
      }
      return { status: 'ok', value: `${cnt} web node(s)`, evidence: nodes.slice(0, 200), recommendation: null };
    },
  },

  {
    id: 'topo.forms_count',
    label: 'Forms managed server count',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT count(*) as cnt,
                 listagg(node_name, ', ') within group (order by node_name) as nodes
          FROM apps.fnd_nodes
          WHERE support_forms = 'Y' AND status = 'A'`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'error', value: 'Query failed', evidence: 'FND_NODES inaccessible', recommendation: null };
      }
      const cnt = parseInt(rows[0].CNT || rows[0].cnt, 10);
      const nodes = rows[0].NODES || rows[0].nodes || '';
      if (isNaN(cnt) || cnt === 0) {
        return { status: 'warn', value: '0 forms nodes', evidence: 'No SUPPORT_FORMS=Y active nodes', recommendation: 'Forms nodes not found in FND_NODES. Verify Forms server is registered.' };
      }
      return { status: 'ok', value: `${cnt} forms node(s)`, evidence: nodes.slice(0, 200), recommendation: null };
    },
  },

  {
    id: 'topo.opp_process_count',
    label: 'OPP (Output Post Processor) process count',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT nvl(max_processes, 0) as max_procs,
                 nvl(running_processes, 0) as running_procs,
                 nvl(target_processes, 0) as target_procs,
                 enabled_flag
          FROM apps.fnd_concurrent_queues_vl
          WHERE concurrent_queue_name = 'FNDOPP'
          AND rownum = 1`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'info', value: 'OPP queue not found', evidence: 'FNDOPP not in FND_CONCURRENT_QUEUES_VL', recommendation: 'Output Post Processor may not be configured.' };
      }
      const r = rows[0];
      const running = parseInt(r.RUNNING_PROCS || r.running_procs, 10) || 0;
      const target = parseInt(r.TARGET_PROCS || r.target_procs, 10) || 0;
      const max = parseInt(r.MAX_PROCS || r.max_procs, 10) || 0;
      const enabled = r.ENABLED_FLAG || r.enabled_flag;
      if (enabled !== 'Y') {
        return { status: 'warn', value: 'OPP disabled', evidence: `ENABLED_FLAG=${enabled}`, recommendation: 'Enable OPP queue for concurrent request output processing.' };
      }
      if (running === 0) {
        return { status: 'crit', value: '0 OPP processes running', evidence: `Target=${target} Max=${max}`, recommendation: 'OPP is down. Restart via SYSADMIN → Concurrent → Manager → Administer.' };
      }
      if (running < target) {
        return { status: 'warn', value: `${running}/${target} OPP processes`, evidence: `Running below target (max=${max})`, recommendation: 'OPP running below target. Check for failed worker processes.' };
      }
      return { status: 'ok', value: `${running}/${target} OPP processes (max=${max})`, evidence: `enabled_flag=Y`, recommendation: null };
    },
  },

  {
    id: 'topo.cm_process_count',
    label: 'Concurrent Manager target vs actual processes',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT user_concurrent_queue_name as queue_name,
                 nvl(target_processes, 0) as target_procs,
                 nvl(running_processes, 0) as running_procs,
                 enabled_flag
          FROM apps.fnd_concurrent_queues_vl
          WHERE enabled_flag = 'Y'
          ORDER BY user_concurrent_queue_name
          FETCH FIRST 20 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'error', value: 'No manager data', evidence: 'FND_CONCURRENT_QUEUES_VL returned no rows', recommendation: 'Verify APPS schema access.' };
      }
      const below = rows.filter(r => {
        const t = parseInt(r.TARGET_PROCS || r.target_procs, 10) || 0;
        const run = parseInt(r.RUNNING_PROCS || r.running_procs, 10) || 0;
        return t > 0 && run < t;
      });
      if (below.length > 0) {
        const names = below.map(r => `${r.QUEUE_NAME || r.queue_name}(${r.RUNNING_PROCS || r.running_procs}/${r.TARGET_PROCS || r.target_procs})`).join('; ');
        return {
          status: 'warn',
          value: `${below.length} manager(s) below target`,
          evidence: names.slice(0, 300),
          recommendation: 'Concurrent Managers running below target. Check ICM logs and restart affected managers.',
        };
      }
      const summary = rows.map(r => `${r.QUEUE_NAME || r.queue_name}:${r.RUNNING_PROCS || r.running_procs}`).join(', ').slice(0, 300);
      return { status: 'ok', value: `${rows.length} manager(s) at target`, evidence: summary, recommendation: null };
    },
  },

  {
    id: 'topo.fnd_nodes_active',
    label: 'Active vs configured nodes (FND_NODES)',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT count(*) as total_nodes,
                 sum(case when status = 'A' then 1 else 0 end) as active_nodes,
                 sum(case when support_web = 'Y' then 1 else 0 end) as web_nodes,
                 sum(case when support_forms = 'Y' then 1 else 0 end) as forms_nodes,
                 sum(case when support_cp = 'Y' then 1 else 0 end) as cp_nodes
          FROM apps.fnd_nodes`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'error', value: 'FND_NODES inaccessible', evidence: '', recommendation: null };
      }
      const r = rows[0];
      const total = parseInt(r.TOTAL_NODES || r.total_nodes, 10) || 0;
      const active = parseInt(r.ACTIVE_NODES || r.active_nodes, 10) || 0;
      const web = parseInt(r.WEB_NODES || r.web_nodes, 10) || 0;
      const forms = parseInt(r.FORMS_NODES || r.forms_nodes, 10) || 0;
      const cp = parseInt(r.CP_NODES || r.cp_nodes, 10) || 0;
      if (active < total) {
        return {
          status: 'warn',
          value: `${active}/${total} nodes active`,
          evidence: `Web=${web} Forms=${forms} CP=${cp}`,
          recommendation: 'Some FND_NODES entries are inactive. Review with SYSADMIN → System Administration → Nodes.',
        };
      }
      return {
        status: 'ok',
        value: `${active}/${total} nodes active`,
        evidence: `Web=${web} Forms=${forms} CP=${cp}`,
        recommendation: null,
      };
    },
  },

  {
    id: 'topo.wls_topology',
    label: 'WebLogic topology (AdminServer + cluster)',
    category: 'topology',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.wls.topology',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return { status: 'info', value: 'config.xml not found', evidence: 'EBS_DOMAIN_HOME may not be set or accessible', recommendation: 'Set EBS_DOMAIN_HOME on apps tier SSH target.' };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const serverCount = lines.filter(l => l.includes('<server>')).length;
      const clusterCount = lines.filter(l => l.includes('<cluster>')).length;
      return {
        status: 'info',
        value: `${serverCount} server(s), ${clusterCount} cluster(s) in domain`,
        evidence: lines.slice(0, 8).join('; ').slice(0, 300),
        recommendation: null,
      };
    },
  },

  {
    id: 'topo.apache_children',
    label: 'Apache child process count',
    category: 'topology',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.apache.children',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'info', value: 'Apache process info unavailable', evidence: '', recommendation: null };
      }
      const firstLine = stdout.trim().split('\n')[0];
      const count = parseInt(firstLine, 10);
      if (isNaN(count)) {
        return { status: 'info', value: 'Apache count parse error', evidence: firstLine.slice(0, 100), recommendation: null };
      }
      if (count === 0) {
        return { status: 'crit', value: '0 Apache child processes', evidence: 'No httpd workers found', recommendation: 'Apache/OHS appears down. Check status with: ${INST_TOP}/admin/scripts/adoachectl.sh status' };
      }
      if (count < 5) {
        return { status: 'warn', value: `${count} Apache children`, evidence: 'Low worker count', recommendation: 'Apache worker count below typical minimum. Review MaxRequestWorkers setting.' };
      }
      return { status: 'ok', value: `${count} Apache children`, evidence: `${count} httpd worker processes running`, recommendation: null };
    },
  },

  {
    id: 'topo.workflow_mailer_status',
    label: 'Workflow Mailer status',
    category: 'topology',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT component_name, status, startup_mode, component_type
          FROM apps.wf_all_agent_activity a
          WHERE component_name IN ('Workflow Notification Mailer', 'Workflow Agent Listener Service')
          UNION ALL
          SELECT component_name, status, startup_mode, component_type
          FROM apps.wf_agents
          WHERE component_name IN ('WF_JAVA_DEFERRED','WF_JAVA_INBOUND')
          AND rownum <= 5`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        // Fallback query result — try simpler check
        return { status: 'info', value: 'Workflow Mailer status unavailable', evidence: 'wf_all_agent_activity view not accessible', recommendation: 'Check Workflow Notification Mailer via Oracle Workflow Manager.' };
      }
      const mailer = rows.find(r => (r.COMPONENT_NAME || r.component_name || '').includes('Mailer'));
      if (!mailer) {
        return { status: 'info', value: 'Mailer component not found', evidence: rows.map(r => r.COMPONENT_NAME || r.component_name).join(', '), recommendation: null };
      }
      const status = mailer.STATUS || mailer.status || '';
      if (/stopped|error|invalid/i.test(status)) {
        return { status: 'crit', value: `Workflow Mailer: ${status}`, evidence: `startup_mode=${mailer.STARTUP_MODE || mailer.startup_mode}`, recommendation: 'Restart Workflow Mailer via Workflow Manager admin page.' };
      }
      if (/deactivated|suspended/i.test(status)) {
        return { status: 'warn', value: `Workflow Mailer: ${status}`, evidence: `startup_mode=${mailer.STARTUP_MODE || mailer.startup_mode}`, recommendation: 'Workflow Mailer is suspended. Activate if expected to send notifications.' };
      }
      return { status: 'ok', value: `Workflow Mailer: ${status}`, evidence: `startup_mode=${mailer.STARTUP_MODE || mailer.startup_mode}`, recommendation: null };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // B. JVM HEAP & GC (6 checks)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'jvm.oacore_heap',
    label: 'OACore JVM heap (-Xms/-Xmx)',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.oacore_heap',
    parse(stdout, stderr, exitCode) {
      return parseJvmHeapOutput(stdout, stderr, 'oacore');
    },
  },

  {
    id: 'jvm.forms_heap',
    label: 'Forms JVM heap (-Xms/-Xmx)',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.forms_heap',
    parse(stdout, stderr, exitCode) {
      return parseJvmHeapOutput(stdout, stderr, 'forms');
    },
  },

  {
    id: 'jvm.opp_heap',
    label: 'OPP JVM heap settings',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.opp_heap',
    parse(stdout, stderr, exitCode) {
      return parseJvmHeapOutput(stdout, stderr, 'opp');
    },
  },

  {
    id: 'jvm.permgen_metaspace',
    label: 'PermGen / Metaspace settings',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.permgen',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim() || stdout.includes('NOT_FOUND')) {
        return { status: 'info', value: 'PermGen/Metaspace settings not found', evidence: '', recommendation: null };
      }
      const msMatch = stdout.match(/-XX:MaxMetaspaceSize=([^\s]+)/i);
      const pmMatch = stdout.match(/-XX:MaxPermSize=([^\s]+)/i);
      const setting = msMatch ? `MaxMetaspace=${msMatch[1]}` : pmMatch ? `MaxPermSize=${pmMatch[1]}` : 'Not explicitly set';
      const status = (msMatch || pmMatch) ? 'ok' : 'info';
      return {
        status,
        value: setting,
        evidence: stdout.trim().slice(0, 200),
        recommendation: (!msMatch && !pmMatch)
          ? 'Consider setting -XX:MaxMetaspaceSize to prevent unbounded metaspace growth on JDK8+.'
          : null,
      };
    },
  },

  {
    id: 'jvm.gc_algorithm',
    label: 'GC algorithm in use',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.gc_flags',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim() || stdout.includes('NOT_FOUND')) {
        return { status: 'info', value: 'GC flags not found', evidence: '', recommendation: null };
      }
      const hasG1 = /UseG1GC/i.test(stdout);
      const hasCMS = /UseConcMarkSweepGC/i.test(stdout);
      const hasParallel = /UseParallelGC/i.test(stdout);
      const hasSerial = /UseSerialGC/i.test(stdout);
      const gc = hasG1 ? 'G1GC' : hasCMS ? 'CMS' : hasParallel ? 'ParallelGC' : hasSerial ? 'SerialGC' : 'Default';
      const status = hasG1 ? 'ok' : hasCMS ? 'ok' : hasSerial ? 'warn' : 'info';
      return {
        status,
        value: gc,
        evidence: stdout.trim().slice(0, 200),
        recommendation: hasSerial
          ? 'SerialGC not recommended for EBS production. Use G1GC (-XX:+UseG1GC) for better pause time management.'
          : null,
      };
    },
  },

  {
    id: 'jvm.oom_errors',
    label: 'Recent OutOfMemoryError occurrences (7d)',
    category: 'jvm_heap',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.jvm.oom_errors',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NO_OOM') || !stdout.trim()) {
        return { status: 'ok', value: 'No OOM errors in 7 days', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      return {
        status: 'crit',
        value: `${lines.length} OOM error occurrence(s) in 7 days`,
        evidence: lines.slice(0, 5).join('; ').slice(0, 300),
        recommendation: 'OutOfMemoryError detected. Increase -Xmx, enable GC logging, and check heap dumps in $LOG_HOME.',
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // C. OS METRICS ON APPS TIER (7 checks, SSH)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'os.cpu_utilization',
    label: 'CPU utilization (vmstat)',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.cpu',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'error', value: 'vmstat unavailable', evidence: stderr || '', recommendation: 'Check SSH connectivity to apps tier.' };
      }
      // Parse vmstat output — look for id (idle) column from last data line
      const lines = stdout.trim().split('\n');
      const dataLines = lines.filter(l => /^\s*\d/.test(l));
      if (dataLines.length === 0) {
        return { status: 'info', value: 'vmstat output present', evidence: stdout.slice(0, 200), recommendation: null };
      }
      // Last data line = most recent sample
      const lastLine = dataLines[dataLines.length - 1].trim().split(/\s+/);
      // vmstat columns: r b swpd free buff cache si so bi bo in cs us sy id wa st
      // id is index 14 (0-based), us=12, sy=13
      const idle = parseFloat(lastLine[14] || lastLine[lastLine.length - 3]);
      const used = 100 - idle;
      if (used >= 90) {
        return { status: 'crit', value: `${used.toFixed(0)}% CPU used`, evidence: lastLine.join(' '), recommendation: 'CPU critically high. Identify top processes and consider scaling.' };
      }
      if (used >= 75) {
        return { status: 'warn', value: `${used.toFixed(0)}% CPU used`, evidence: lastLine.join(' '), recommendation: 'CPU utilization elevated. Monitor for sustained spikes.' };
      }
      return { status: 'ok', value: `${used.toFixed(0)}% CPU used (${idle.toFixed(0)}% idle)`, evidence: lastLine.join(' '), recommendation: null };
    },
  },

  {
    id: 'os.memory_swap',
    label: 'Memory free + swap usage',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.memory',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'error', value: 'free -m unavailable', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n');
      // Mem line: Mem: total used free shared buff/cache available
      const memLine = lines.find(l => /^Mem:/i.test(l));
      const swapLine = lines.find(l => /^Swap:/i.test(l));
      if (!memLine) {
        return { status: 'info', value: 'Memory info present', evidence: stdout.slice(0, 200), recommendation: null };
      }
      const memParts = memLine.split(/\s+/);
      const swapParts = swapLine ? swapLine.split(/\s+/) : [];
      const totalMem = parseInt(memParts[1], 10) || 0;
      const availMem = parseInt(memParts[6] || memParts[3], 10) || 0;
      const usedPct = totalMem > 0 ? ((totalMem - availMem) / totalMem * 100) : 0;
      const totalSwap = swapParts.length > 2 ? parseInt(swapParts[1], 10) || 0 : 0;
      const usedSwap = swapParts.length > 2 ? parseInt(swapParts[2], 10) || 0 : 0;
      const swapPct = totalSwap > 0 ? (usedSwap / totalSwap * 100) : 0;

      if (swapPct > 25) {
        return {
          status: 'warn',
          value: `Swap ${swapPct.toFixed(0)}% used, RAM ${usedPct.toFixed(0)}% used`,
          evidence: `Mem: ${totalMem}MB total, ${availMem}MB avail; Swap: ${usedSwap}/${totalSwap}MB`,
          recommendation: 'Active swap usage detected. System may be under memory pressure. Check top processes.',
        };
      }
      return {
        status: usedPct > 85 ? 'warn' : 'ok',
        value: `RAM ${usedPct.toFixed(0)}% used, Swap ${swapPct.toFixed(0)}% used`,
        evidence: `Mem: ${totalMem}MB total, ${availMem}MB avail`,
        recommendation: usedPct > 85 ? 'High memory usage. Monitor for swap activation.' : null,
      };
    },
  },

  {
    id: 'os.load_average',
    label: 'Load average',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.load',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'error', value: 'uptime unavailable', evidence: '', recommendation: null };
      }
      // uptime: "... load average: 1.23, 2.34, 3.45"
      const match = stdout.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
      if (!match) {
        return { status: 'info', value: 'Load average present', evidence: stdout.trim().slice(0, 150), recommendation: null };
      }
      const [, la1, la5, la15] = match;
      const load1 = parseFloat(la1);
      // Heuristic: >8 sustained = typically high for a 4-8 core apps tier
      if (load1 > 16) {
        return { status: 'crit', value: `Load avg 1m=${la1}`, evidence: `1min=${la1} 5min=${la5} 15min=${la15}`, recommendation: 'Load average critically high. Check for runaway processes on apps tier.' };
      }
      if (load1 > 8) {
        return { status: 'warn', value: `Load avg 1m=${la1}`, evidence: `1min=${la1} 5min=${la5} 15min=${la15}`, recommendation: 'Load average elevated. Monitor and correlate with CPU/process data.' };
      }
      return { status: 'ok', value: `Load avg 1m=${la1} 5m=${la5} 15m=${la15}`, evidence: stdout.trim().slice(0, 150), recommendation: null };
    },
  },

  {
    id: 'os.top_cpu_processes',
    label: 'Top 10 processes by CPU',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.top_cpu',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'info', value: 'Top CPU process list unavailable', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim() && !/^USER/.test(l));
      // First line = highest CPU consumer
      const topMatch = lines[0] && lines[0].match(/\s+([\d.]+)\s+([\d.]+)\s+.+?([^\s]+)\s*$/);
      const topCpu = topMatch ? parseFloat(topMatch[1]) : null;
      const topProc = topMatch ? topMatch[3] : 'unknown';
      return {
        status: topCpu !== null && topCpu > 80 ? 'warn' : 'info',
        value: topCpu !== null ? `Top: ${topProc} (${topCpu.toFixed(0)}% CPU)` : 'Top process list',
        evidence: lines.slice(0, 5).join('; ').slice(0, 300),
        recommendation: topCpu > 80 ? `High CPU usage by ${topProc}. Investigate and consider process priority adjustment.` : null,
      };
    },
  },

  {
    id: 'os.top_mem_processes',
    label: 'Top 10 processes by memory',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.top_mem',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'info', value: 'Top memory process list unavailable', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim() && !/^USER/.test(l));
      return {
        status: 'info',
        value: `Top ${Math.min(lines.length, 10)} processes by memory`,
        evidence: lines.slice(0, 5).join('; ').slice(0, 300),
        recommendation: null,
      };
    },
  },

  {
    id: 'os.disk_usage',
    label: 'Disk usage per filesystem (flag >85%)',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.disk',
    parse(stdout, stderr, exitCode) {
      if (!stdout || !stdout.trim()) {
        return { status: 'error', value: 'df -h unavailable', evidence: '', recommendation: null };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const critical = [], warn = [];
      for (const line of lines) {
        const pctMatch = line.match(/(\d+)%/);
        if (!pctMatch) continue;
        const pct = parseInt(pctMatch[1], 10);
        const fs = line.split(/\s+/).pop();
        if (pct >= 90) critical.push(`${fs}:${pct}%`);
        else if (pct >= 85) warn.push(`${fs}:${pct}%`);
      }
      if (critical.length > 0) {
        return { status: 'crit', value: `${critical.length} filesystem(s) ≥90% full`, evidence: critical.join(', '), recommendation: 'Critical disk usage. Free space immediately on: ' + critical.join(', ') };
      }
      if (warn.length > 0) {
        return { status: 'warn', value: `${warn.length} filesystem(s) ≥85% full`, evidence: warn.join(', '), recommendation: 'Plan disk expansion for: ' + warn.join(', ') };
      }
      const totalFs = lines.filter(l => /\d+%/.test(l)).length;
      return { status: 'ok', value: `${totalFs} filesystem(s) all below 85%`, evidence: lines.slice(0, 3).join('; ').slice(0, 200), recommendation: null };
    },
  },

  {
    id: 'os.open_fds',
    label: 'Open file descriptors for oacore PID',
    category: 'os_metrics',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.os.open_fds',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return { status: 'info', value: 'oacore PID not found', evidence: 'oacore process may not be running or lsof requires elevated privileges', recommendation: null };
      }
      const lines = stdout.trim().split('\n');
      // Expected: first line = current open FDs, second line = ulimit max
      const current = parseInt(lines[0], 10);
      const limit = parseInt(lines[1], 10);
      if (isNaN(current)) {
        return { status: 'info', value: 'FD count parse error', evidence: stdout.slice(0, 100), recommendation: null };
      }
      if (!isNaN(limit) && limit > 0) {
        const pct = (current / limit) * 100;
        if (pct >= 80) {
          return {
            status: 'crit',
            value: `${current}/${limit} FDs open (${pct.toFixed(0)}%)`,
            evidence: `FD limit: ${limit}`,
            recommendation: 'oacore approaching file descriptor limit. Increase ulimit -n or investigate FD leaks.',
          };
        }
        if (pct >= 60) {
          return {
            status: 'warn',
            value: `${current}/${limit} FDs open (${pct.toFixed(0)}%)`,
            evidence: `FD limit: ${limit}`,
            recommendation: 'FD usage elevated. Monitor for growth trend.',
          };
        }
        return { status: 'ok', value: `${current}/${limit} FDs open (${pct.toFixed(0)}%)`, evidence: `ulimit -n = ${limit}`, recommendation: null };
      }
      return { status: 'info', value: `${current} open FDs`, evidence: 'ulimit not available for comparison', recommendation: null };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // D. CODE LEVELS & PATCH HISTORY (6 checks)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'code.ebs_release',
    label: 'EBS release version (flag if <12.2.7)',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT release_name FROM apps.fnd_product_groups WHERE rownum = 1`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'error', value: 'FND_PRODUCT_GROUPS inaccessible', evidence: '', recommendation: null };
      }
      const release = rows[0].RELEASE_NAME || rows[0].release_name || '';
      const parts = release.split('.');
      const minor = parseInt(parts[2] || '0', 10);
      if (minor < 7) {
        return {
          status: 'warn',
          value: `EBS ${release}`,
          evidence: `Release is below 12.2.7`,
          recommendation: 'EBS versions below 12.2.7 are end-of-life. Upgrade to 12.2.13+ to receive security patches.',
        };
      }
      return { status: 'ok', value: `EBS ${release}`, evidence: `release_name=${release}`, recommendation: null };
    },
  },

  {
    id: 'code.ad_codelevel',
    label: 'AD code level',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT abbreviation, codelevel, patch_level
          FROM apps.ad_trackable_entities
          WHERE abbreviation = 'AD'`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'info', value: 'AD codelevel not found', evidence: 'AD_TRACKABLE_ENTITIES inaccessible or entry missing', recommendation: null };
      }
      const r = rows[0];
      const level = r.CODELEVEL || r.codelevel || r.PATCH_LEVEL || r.patch_level || 'unknown';
      return { status: 'info', value: `AD codelevel: ${level}`, evidence: `abbreviation=AD level=${level}`, recommendation: null };
    },
  },

  {
    id: 'code.txk_codelevel',
    label: 'TXK code level',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT abbreviation, codelevel, patch_level
          FROM apps.ad_trackable_entities
          WHERE abbreviation = 'TXK'`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'info', value: 'TXK codelevel not found', evidence: 'AD_TRACKABLE_ENTITIES inaccessible or TXK entry missing', recommendation: null };
      }
      const r = rows[0];
      const level = r.CODELEVEL || r.codelevel || r.PATCH_LEVEL || r.patch_level || 'unknown';
      return { status: 'info', value: `TXK codelevel: ${level}`, evidence: `abbreviation=TXK level=${level}`, recommendation: null };
    },
  },

  {
    id: 'code.atg_pf_level',
    label: 'ATG_PF patch level (DELTA patches)',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT bug_number, last_update_date, patch_name
          FROM apps.ad_applied_patches
          WHERE patch_name LIKE 'R12.ATG_PF.C.DELTA.%'
          ORDER BY last_update_date DESC
          FETCH FIRST 5 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'info', value: 'No ATG_PF DELTA patches found', evidence: 'AD_APPLIED_PATCHES has no R12.ATG_PF.C.DELTA.* entries', recommendation: null };
      }
      const latest = rows[0];
      const patchName = latest.PATCH_NAME || latest.patch_name || '';
      const bugNum = latest.BUG_NUMBER || latest.bug_number || '';
      const applied = latest.LAST_UPDATE_DATE || latest.last_update_date || '';
      return {
        status: 'info',
        value: `ATG_PF: ${patchName}`,
        evidence: `Bug ${bugNum} applied ${applied}`,
        recommendation: null,
      };
    },
  },

  {
    id: 'code.last_cpu_psu',
    label: 'Last CPU (Critical Patch Update) applied',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT bug_number, patch_name, last_update_date
          FROM apps.ad_applied_patches
          WHERE patch_name LIKE 'R12.EBS-PATCH-UPD.%'
             OR upper(patch_name) LIKE '%CPU%'
          ORDER BY last_update_date DESC
          FETCH FIRST 3 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return { status: 'info', value: 'No CPU patches found', evidence: 'No R12.EBS-PATCH-UPD.* entries in AD_APPLIED_PATCHES', recommendation: 'Verify CPU (Critical Patch Update) history via adop phase=apply.' };
      }
      const latest = rows[0];
      const patchName = latest.PATCH_NAME || latest.patch_name || '';
      const bugNum = latest.BUG_NUMBER || latest.bug_number || '';
      const applied = latest.LAST_UPDATE_DATE || latest.last_update_date || '';
      // Warn if applied more than 1 year ago (simple heuristic)
      const appliedDate = new Date(applied);
      const daysAgo = !isNaN(appliedDate) ? Math.floor((Date.now() - appliedDate) / 86400000) : null;
      const status = daysAgo !== null && daysAgo > 365 ? 'warn' : 'ok';
      return {
        status,
        value: `CPU: ${patchName || bugNum}`,
        evidence: `Bug ${bugNum} applied ${applied}${daysAgo ? ` (${daysAgo} days ago)` : ''}`,
        recommendation: status === 'warn' ? 'Last CPU (Critical Patch Update) is over a year old. Review Oracle quarterly CPU schedule.' : null,
      };
    },
  },

  {
    id: 'code.last_security_cpu',
    label: 'Last Oracle CPU (security patch) applied',
    category: 'code_levels',
    type: 'tns',
    min_ebs_version: '12.2.7',
    requires_ssh: false,
    sql: `SELECT bug_number, description, last_update_date
          FROM apps.ad_bugs
          WHERE (description LIKE '%CPU%' OR description LIKE '%Critical Patch%' OR description LIKE '%Security%')
            AND last_update_date > SYSDATE - 730
          ORDER BY last_update_date DESC
          FETCH FIRST 5 ROWS ONLY`,
    parse(rows) {
      if (!rows || rows.length === 0) {
        return {
          status: 'warn',
          value: 'No recent CPU patch found (2yr window)',
          evidence: 'No CPU/Critical Patch bugs in AD_BUGS in last 730 days',
          recommendation: 'Apply current Oracle Critical Patch Update (CPU). Check MOS note 1458915.1.',
        };
      }
      const latest = rows[0];
      const bugNum = latest.BUG_NUMBER || latest.bug_number || '';
      const desc = latest.DESCRIPTION || latest.description || '';
      const applied = latest.LAST_UPDATE_DATE || latest.last_update_date || '';
      const appliedDate = new Date(applied);
      const daysAgo = !isNaN(appliedDate) ? Math.floor((Date.now() - appliedDate) / 86400000) : null;
      const status = daysAgo !== null && daysAgo > 180 ? 'warn' : 'ok';
      return {
        status,
        value: `CPU Bug ${bugNum}`,
        evidence: `${desc.slice(0, 100)} — applied ${applied}${daysAgo ? ` (${daysAgo}d ago)` : ''}`,
        recommendation: status === 'warn' ? 'Security CPU is over 6 months old. Apply current quarter CPU.' : null,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // E. ETCC — ENTERPRISE TECHNOLOGY CODELEVEL CHECKER (3 checks)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'etcc.last_run',
    label: 'ETCC last run date',
    category: 'etcc',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.etcc.last_run',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'warn',
          value: 'ETCC log not found',
          evidence: 'checkDBpatch.sh / checkMTpatch.sh logs not found in $AD_TOP/bin',
          recommendation: 'Run ETCC (checkDBpatch.sh and checkMTpatch.sh) to identify missing patches. Download from MOS note 1594718.1.',
        };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      // Lines expected: "DB: <timestamp>" and "MT: <timestamp>"
      return {
        status: 'info',
        value: 'ETCC log timestamps found',
        evidence: lines.slice(0, 4).join('; ').slice(0, 300),
        recommendation: null,
      };
    },
  },

  {
    id: 'etcc.db_missing',
    label: 'ETCC DB tier missing patches',
    category: 'etcc',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'db_tier',
    command_key: 'ebs.etcc.db_missing',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'info',
          value: 'checkDBpatch.log not found',
          evidence: 'Run checkDBpatch.sh on DB tier to generate log',
          recommendation: 'Download ETCC from MOS 1594718.1 and run checkDBpatch.sh on the DB tier.',
        };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      // Look for lines mentioning missing patches
      const missing = lines.filter(l => /MISSING|NOT APPLIED|REQUIRED/i.test(l));
      const upToDate = lines.some(l => /ALL REQUIRED|UP TO DATE|NO MISSING|COMPLIANT/i.test(l));
      if (upToDate) {
        return { status: 'ok', value: 'DB tier patches current (ETCC)', evidence: lines.slice(0, 3).join('; ').slice(0, 200), recommendation: null };
      }
      if (missing.length > 0) {
        return {
          status: 'crit',
          value: `${missing.length} missing DB tier patch(es)`,
          evidence: missing.slice(0, 5).join('; ').slice(0, 300),
          recommendation: 'Apply missing patches identified by ETCC checkDBpatch.sh. See MOS 1594718.1.',
        };
      }
      return { status: 'info', value: 'ETCC DB log present', evidence: lines.slice(0, 3).join('; ').slice(0, 200), recommendation: null };
    },
  },

  {
    id: 'etcc.mt_missing',
    label: 'ETCC MT tier missing patches',
    category: 'etcc',
    type: 'ssh',
    min_ebs_version: '12.2.7',
    requires_ssh: true,
    requires: 'apps_tier',
    command_key: 'ebs.etcc.mt_missing',
    parse(stdout, stderr, exitCode) {
      if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
        return {
          status: 'info',
          value: 'checkMTpatch.log not found',
          evidence: 'Run checkMTpatch.sh on apps tier to generate log',
          recommendation: 'Download ETCC from MOS 1594718.1 and run checkMTpatch.sh on the apps tier.',
        };
      }
      const lines = stdout.trim().split('\n').filter(l => l.trim());
      const missing = lines.filter(l => /MISSING|NOT APPLIED|REQUIRED/i.test(l));
      const upToDate = lines.some(l => /ALL REQUIRED|UP TO DATE|NO MISSING|COMPLIANT/i.test(l));
      if (upToDate) {
        return { status: 'ok', value: 'MT tier patches current (ETCC)', evidence: lines.slice(0, 3).join('; ').slice(0, 200), recommendation: null };
      }
      if (missing.length > 0) {
        return {
          status: 'crit',
          value: `${missing.length} missing MT tier patch(es)`,
          evidence: missing.slice(0, 5).join('; ').slice(0, 300),
          recommendation: 'Apply missing patches identified by ETCC checkMTpatch.sh. See MOS 1594718.1.',
        };
      }
      return { status: 'info', value: 'ETCC MT log present', evidence: lines.slice(0, 3).join('; ').slice(0, 200), recommendation: null };
    },
  },
];

// ─── Shared parsers ───────────────────────────────────────────────────────────

/**
 * Parse JVM startup args looking for -Xms/-Xmx heap settings.
 * Works for oacore, forms, and opp startup scripts.
 */
function parseJvmHeapOutput(stdout, stderr, component) {
  if (!stdout || stdout.includes('NOT_FOUND') || !stdout.trim()) {
    return {
      status: 'info',
      value: `${component} JVM args not found`,
      evidence: 'Startup script or JVM args file not accessible',
      recommendation: `Ensure apps tier SSH target has read access to ${component} startup scripts.`,
    };
  }
  const xmsMatch = stdout.match(/-Xms(\d+[mMgGkK]?)/);
  const xmxMatch = stdout.match(/-Xmx(\d+[mMgGkK]?)/);
  const xms = xmsMatch ? xmsMatch[1] : null;
  const xmx = xmxMatch ? xmxMatch[1] : null;

  if (!xmx) {
    return {
      status: 'warn',
      value: `-Xmx not set for ${component}`,
      evidence: stdout.trim().slice(0, 200),
      recommendation: `Set -Xmx for ${component} JVM to avoid unbounded heap growth. Typical EBS production: -Xmx3072m or higher.`,
    };
  }

  // Convert to MB for comparison
  const toMb = (v) => {
    if (!v) return 0;
    const n = parseFloat(v);
    const u = v.slice(-1).toLowerCase();
    return u === 'g' ? n * 1024 : u === 'k' ? n / 1024 : n;
  };
  const xmxMb = toMb(xmx);

  let status = 'ok';
  let recommendation = null;
  if (xmxMb < 1024) {
    status = 'warn';
    recommendation = `${component} -Xmx is below 1GB (${xmx}). Increase to at least 2048m for production EBS workloads.`;
  }

  return {
    status,
    value: `${component}: -Xms${xms || 'unset'} -Xmx${xmx}`,
    evidence: stdout.trim().slice(0, 200),
    recommendation,
  };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run all applicable EBS 12.2 checks.
 *
 * TNS checks require oracleConn — an active oracle-client connection object.
 * SSH checks require targetId + role.
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
async function runEbs122Checks({ oracleConn, targetId, role, initiatedBy, timeoutMs = 25_000 }) {
  const results = [];

  // Split checks by type
  const tnsChecks = EBS_12_2_CHECKS.filter(c => c.type === 'tns');
  const sshChecks = EBS_12_2_CHECKS.filter(c => c.type === 'ssh');

  // Run TNS checks in parallel (max 8 concurrent)
  if (oracleConn) {
    const TNS_CONCURRENCY = 8;
    for (let i = 0; i < tnsChecks.length; i += TNS_CONCURRENCY) {
      const batch = tnsChecks.slice(i, i + TNS_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(check => runTnsCheck(check, oracleConn)));
      results.push(...batchResults);
    }
  } else {
    // No Oracle conn — stub TNS checks
    for (const check of tnsChecks) {
      results.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: 'info',
        value: 'Requires Oracle connection',
        evidence: 'No active Oracle connection provided for this check run',
        recommendation: null,
        durationMs: 0,
        error: false,
      });
    }
  }

  // Run SSH checks if target provided
  if (targetId && role) {
    const applicableSsh = sshChecks.filter(c => c.requires === 'any' || c.requires === role);
    const SSH_CONCURRENCY = 5;
    for (let i = 0; i < applicableSsh.length; i += SSH_CONCURRENCY) {
      const batch = applicableSsh.slice(i, i + SSH_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(check => runSshCheck(check, targetId, initiatedBy, timeoutMs))
      );
      results.push(...batchResults);
    }
    // Stub unapplicable SSH checks
    const inapplicable = sshChecks.filter(c => c.requires !== 'any' && c.requires !== role);
    for (const check of inapplicable) {
      results.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: 'info',
        value: `Requires ${check.requires} SSH target`,
        evidence: `Current role: ${role}. Attach a ${check.requires} SSH target to run this check.`,
        recommendation: null,
        durationMs: 0,
        error: false,
      });
    }
  } else {
    // No SSH target — stub all SSH checks
    for (const check of sshChecks) {
      results.push({
        id: check.id,
        label: check.label,
        category: check.category,
        status: 'info',
        value: 'Requires SSH target',
        evidence: `Attach an apps_tier SSH target to run this check.`,
        recommendation: null,
        durationMs: 0,
        error: false,
      });
    }
  }

  const summary = { ok: 0, warn: 0, crit: 0, info: 0, error: 0 };
  for (const r of results) {
    summary[r.status] = (summary[r.status] || 0) + 1;
  }

  return { checks: results, summary, ranAt: new Date().toISOString() };
}

async function runTnsCheck(check, oracleConn) {
  const t0 = Date.now();
  try {
    const result = await oracleConn.execute(check.sql, [], { outFormat: oracleConn.OUT_FORMAT_OBJECT || 4002, fetchArraySize: 100 });
    const rows = result && result.rows ? result.rows : [];
    const parsed = check.parse(rows);
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      ...parsed,
      durationMs: Date.now() - t0,
      error: false,
    };
  } catch (err) {
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      status: 'error',
      value: 'Check failed',
      evidence: err.message || 'Oracle query error',
      recommendation: null,
      durationMs: Date.now() - t0,
      error: true,
    };
  }
}

async function runSshCheck(check, targetId, initiatedBy, timeoutMs) {
  const t0 = Date.now();
  try {
    const result = await executor.runCommand({
      targetId,
      commandKey: check.command_key,
      initiatedBy,
      timeoutMs,
    });

    if (result.rejected) {
      return {
        id: check.id,
        label: check.label,
        category: check.category,
        status: 'error',
        value: 'Command rejected',
        evidence: result.rejectionReason || 'SSH command not in whitelist',
        recommendation: 'Check SSH target role configuration.',
        durationMs: result.durationMs || (Date.now() - t0),
        error: true,
      };
    }

    const parsed = check.parse(result.stdout, result.stderr, result.exitCode);
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      ...parsed,
      durationMs: result.durationMs || (Date.now() - t0),
      error: false,
    };
  } catch (err) {
    return {
      id: check.id,
      label: check.label,
      category: check.category,
      status: 'error',
      value: 'Check failed',
      evidence: err.message || 'Unknown error',
      recommendation: null,
      durationMs: Date.now() - t0,
      error: true,
    };
  }
}

/**
 * Return check catalog metadata (no parsers/SQL) — safe for API/UI use.
 */
function getCheckCatalog() {
  return EBS_12_2_CHECKS.map(c => ({
    id: c.id,
    label: c.label,
    category: c.category,
    type: c.type,
    min_ebs_version: c.min_ebs_version,
    requires_ssh: c.requires_ssh,
    requires: c.requires || null,
  }));
}

/**
 * CHECK_COUNTS — single source of truth for check counts shown in marketing copy.
 * Update these when checks are added or removed.
 */
const CHECK_COUNTS = {
  // Core DB health checks (stored as check_results in Postgres)
  db_core: 54,     // ST×6, PF×11, MEM×5, BK×5, CF×6, IX×3, OB×12, SEC×6
  // EBS native checks (TNS, also stored as check_results with EBS_ prefix)
  ebs_native: 14,  // CM×5, WF×5, SC×2, FB×2
  // EBS SSH checks (original 24 in services/ebs-ssh-checks.js)
  ebs_ssh_legacy: 24, // filesystem×11, adop×4, cm×3, wls×4, logs×3
  // EBS 12.2 deep checks (this file)
  ebs_12_2: EBS_12_2_CHECKS.length,
  // EBS Security checks — ES01–ES08 (services/ebs-security-checks.js)
  ebs_security: 8,
  // EBS Performance checks — EP01–EP06 (services/ebs-performance-checks.js)
  ebs_performance: 6,
  // DB Ops (interactive operations, not auto-scan checks)
  db_ops: 86,
  // Derived totals
  get db_total() { return this.db_core; },
  get ebs_total() { return this.ebs_native + this.ebs_ssh_legacy + this.ebs_12_2 + this.ebs_security + this.ebs_performance; },
  get health_checks_total() { return this.db_core + this.ebs_native + this.ebs_ssh_legacy + this.ebs_12_2 + this.ebs_security + this.ebs_performance; },
  get grand_total_with_ops() { return this.health_checks_total + this.db_ops; },
};

module.exports = { runEbs122Checks, getCheckCatalog, EBS_12_2_CHECKS, CHECK_COUNTS };
