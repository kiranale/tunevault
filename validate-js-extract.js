    const reportId = window.location.pathname.split('/').pop();
    let pollTimer = null;
    let reportLoadedAt = null;

    // ============================================================
    // CANCEL
    // ============================================================
    async function cancelHealthCheck() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        try {
            await fetch('/api/health-checks/' + reportId + '/cancel', { method: 'POST' });
            loadReport();
        } catch (err) {
            alert('Failed to cancel health check.');
        }
    }

    // ============================================================
    // LOAD + POLL
    // ============================================================
    async function loadReport() {
        // Prevent double-rendering if report is already loaded
        if (reportLoadedAt) return;

        try {
            const res = await fetch('/api/health-checks/' + reportId);
            if (!res.ok) {
                document.getElementById('reportContent').innerHTML = '<div class="analyzing-state"><p class="analyzing-text">Report not found.</p><a href="/dashboard" class="nav-btn" style="margin-top:16px;display:inline-block">Back to Dashboard</a></div>';
                reportLoadedAt = new Date(); // stop polling
                return;
            }
            const data = await res.json();

            // Wrap renderReport in try-catch -- render errors must NOT leave spinner visible
            let renderOk = false;
            try {
                renderReport(data);
                renderOk = true;
            } catch (renderErr) {
                console.error('Report render failed:', renderErr);
                document.getElementById('reportContent').innerHTML = '<div class="analyzing-state"><p class="analyzing-text">Report data could not be displayed.</p><p style="color:var(--text-dim);font-size:13px;margin-top:8px">If the report was run with a limited-privilege user, some data sections may be unavailable.</p><a href="/dashboard" class="nav-btn" style="margin-top:16px;display:inline-block">Back to Dashboard</a></div>';
                reportLoadedAt = new Date(); // stop polling on render failure
                return;
            }

            if (!renderOk) {
                reportLoadedAt = new Date();
                return;
            }

            if (data.status !== 'completed' && data.status !== 'error') {
                pollTimer = setTimeout(loadReport, 2000);
            } else {
                reportLoadedAt = new Date();
            }
        } catch (err) {
            console.error('Failed to load report:', err);
            document.getElementById('reportContent').innerHTML = '<div class="analyzing-state"><p class="analyzing-text">Failed to load report.</p><p style="color:var(--text-dim);font-size:13px;margin-top:8px">' + (err.message || 'Unknown error') + '</p><a href="/dashboard" class="nav-btn" style="margin-top:16px;display:inline-block">Back to Dashboard</a></div>';
            reportLoadedAt = new Date(); // stop polling on fetch error
        }
    }

    function showDownloadButton() {
        const nav = document.getElementById('navActions');
        if (!nav || nav.querySelector('.download-btn')) return;

        // XLSX button
        const xlsxBtn = document.createElement('a');
        xlsxBtn.href = '/api/health-checks/' + reportId + '/xlsx';
        xlsxBtn.className = 'download-btn';
        xlsxBtn.style.background = 'var(--surface-2)';
        xlsxBtn.style.color = 'var(--text)';
        xlsxBtn.style.border = '1px solid var(--border)';
        xlsxBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Detailed XLSX';
        nav.insertBefore(xlsxBtn, nav.firstChild);

        // PDF button
        const pdfBtn = document.createElement('a');
        pdfBtn.href = '/api/health-checks/' + reportId + '/pdf';
        pdfBtn.className = 'download-btn';
        pdfBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Summary PDF';
        nav.insertBefore(pdfBtn, nav.firstChild);
    }

    // ============================================================
    // VITALS BAR
    // ============================================================
    function renderVitalsBar(data) {
        const bar = document.getElementById('vitalsBar');
        const inner = document.getElementById('vitalsInner');
        if (!data || !data.metrics) { bar.style.display = 'none'; return; }

        const m = data.metrics;
        const s = data.scores || {};

        // DB status — 'analyzing' means Oracle checks succeeded (AI still running)
        const dbOk = data.status === 'completed' || data.status === 'analyzing';
        const dbClass = dbOk ? 'ok' : 'crit';

        // Tablespace worst
        const maxTs = m.tablespaces ? Math.max(...m.tablespaces.map(t => t.pct_used)) : 0;
        const tsClass = maxTs > 90 ? 'crit' : maxTs > 80 ? 'warn' : 'ok';

        // Overall score color
        const scoreClass = data.overall_score >= 75 ? 'ok' : data.overall_score >= 50 ? 'warn' : 'crit';

        // CPU
        const cpu = m.os_stats ? m.os_stats.avg_cpu_utilization_pct : null;
        const cpuClass = cpu > 80 ? 'crit' : cpu > 60 ? 'warn' : 'ok';

        // Memory
        const freeMemPct = m.os_stats && m.os_stats.physical_memory_gb > 0
            ? Math.round((m.os_stats.free_memory_gb / m.os_stats.physical_memory_gb) * 100) : null;
        const memClass = freeMemPct !== null ? (freeMemPct < 10 ? 'crit' : freeMemPct < 20 ? 'warn' : 'ok') : 'unknown';

        // Wait events score
        const waitClass = s.wait_events >= 75 ? 'ok' : s.wait_events >= 50 ? 'warn' : 'crit';

        // Time ago
        const checkedAt = new Date(data.created_at);
        const minutesAgo = Math.floor((Date.now() - checkedAt.getTime()) / 60000);
        const timeAgo = minutesAgo < 1 ? 'just now' : minutesAgo < 60 ? minutesAgo + ' min ago' : Math.floor(minutesAgo/60) + 'h ago';

        inner.innerHTML = `
            <div class="vital-item">
                <div class="vital-dot ${dbClass}"></div>
                <span class="vital-label">DB</span>
                <span class="vital-value">${dbOk ? 'Online' : 'Error'}</span>
            </div>
            <div class="vital-item">
                <div class="vital-dot ${scoreClass}"></div>
                <span class="vital-label">Score</span>
                <span class="vital-value">${data.overall_score || '—'}<span style="font-size:11px;color:var(--text-dim)">/100</span></span>
            </div>
            <div class="vital-item">
                <div class="vital-dot ${tsClass}"></div>
                <span class="vital-label">Storage</span>
                <span class="vital-value">${maxTs}<span style="font-size:11px;color:var(--text-dim)">% max</span></span>
            </div>
            <div class="vital-item">
                <div class="vital-dot ${waitClass}"></div>
                <span class="vital-label">Waits</span>
                <span class="vital-value">${s.wait_events || '—'}<span style="font-size:11px;color:var(--text-dim)">/100</span></span>
            </div>
            ${cpu !== null ? `<div class="vital-item">
                <div class="vital-dot ${cpuClass}"></div>
                <span class="vital-label">CPU</span>
                <span class="vital-value">${cpu}<span style="font-size:11px;color:var(--text-dim)">%</span></span>
            </div>` : ''}
            ${freeMemPct !== null ? `<div class="vital-item">
                <div class="vital-dot ${memClass}"></div>
                <span class="vital-label">Free RAM</span>
                <span class="vital-value">${m.os_stats.free_memory_gb}<span style="font-size:11px;color:var(--text-dim)"> GB</span></span>
            </div>` : ''}
            <div class="vital-item">
                <div class="vital-timestamp">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    Last checked: ${timeAgo}
                </div>
            </div>
        `;
        bar.style.display = 'block';
    }

    // ============================================================
    // MAIN RENDER
    // ============================================================
    function renderReport(data) {
        // Connecting / Collecting states
        if (data.status === 'connecting' || data.status === 'collecting') {
            document.getElementById('reportContent').innerHTML = `
                <div class="analyzing-state">
                    <div class="analyzing-spinner"></div>
                    <p class="analyzing-text">${data.status === 'connecting' ? 'Connecting to Oracle database...' : 'Collecting metrics from Oracle...'}</p>
                    <p style="color:var(--text-dim);font-size:13px;margin-top:8px">${esc(data.connection_name || '')}</p>
                    <button class="cancel-btn" onclick="cancelHealthCheck()">Cancel</button>
                </div>`;
            return;
        }

        // Error state
        if (data.status === 'error') {
            let html = `
                <div class="report-header">
                    <div class="report-title">
                        <h1>${esc(data.connection_name)}</h1>
                        <div class="report-meta">
                            <span style="color:var(--red)">Connection Error</span>
                            <span class="dot"></span>
                            <span>${new Date(data.created_at).toLocaleString()}</span>
                        </div>
                    </div>
                </div>`;
            if (data.ai_analysis) {
                html += `<div class="ai-analysis" style="border-color:rgba(248,113,113,0.3)">
                    <div class="ai-analysis-header"><h3 style="color:var(--red)">Error Details</h3></div>
                    <div class="ai-content">${markdownToHtml(data.ai_analysis)}</div>
                </div>`;
            }
            document.getElementById('reportContent').innerHTML = html;
            return;
        }

        const m = data.metrics;
        if (!m || !m.instance) {
            document.getElementById('reportContent').innerHTML = `
                <div class="analyzing-state">
                    <p class="analyzing-text">Report data not available yet.</p>
                    <a href="/dashboard" class="nav-btn" style="margin-top:16px;display:inline-block">Back to Dashboard</a>
                </div>`;
            return;
        }

        // Render vitals bar
        renderVitalsBar(data);

        const s = data.scores;
        const scoreColor = (v) => v >= 75 ? 'var(--green)' : v >= 50 ? 'var(--yellow)' : 'var(--red)';
        const scoreTag = (v) => v >= 75 ? 'tag-ok' : v >= 50 ? 'tag-warning' : 'tag-critical';
        const scoreLabel = (v) => v >= 75 ? 'Healthy' : v >= 50 ? 'Needs Attention' : 'Critical';

        const circumference = 2 * Math.PI * 38;
        const offset = circumference - (data.overall_score / 100) * circumference;

        // Build findings for AI Summary tab
        const findings = buildFindings(data);

        let critCount = findings.filter(f => f.severity === 'critical').length;
        let warnCount = findings.filter(f => f.severity === 'warning').length;
        let okCount = findings.filter(f => f.severity === 'ok').length;

        // Tab badge markup
        const summaryBadge = critCount ? `<span class="tab-badge tab-badge-crit">${critCount}</span>` :
                             warnCount ? `<span class="tab-badge tab-badge-warn">${warnCount}</span>` :
                             `<span class="tab-badge tab-badge-ok">✓</span>`;

        const storageBadge = (() => {
            let crit = m.tablespaces.filter(t => t.pct_used > 90).length;
            let warn = m.tablespaces.filter(t => t.pct_used > 80 && t.pct_used <= 90).length;
            // Include undo/temp
            if (m.undo_stats && m.undo_stats.current) {
                const u = m.undo_stats.current; const hist = m.undo_stats.historical || {};
                const risk = hist.peak_query_length_s && u.tuned_undo_retention_s && hist.peak_query_length_s > u.tuned_undo_retention_s;
                if (risk || u.pct_used > 90) crit++; else if (u.pct_used > 80) warn++;
            }
            if (m.temp_stats && m.temp_stats.current) {
                if (m.temp_stats.current.pct_used > 90) crit++; else if (m.temp_stats.current.pct_used > 80) warn++;
            }
            if (crit) return `<span class="tab-badge tab-badge-crit">${crit}</span>`;
            if (warn) return `<span class="tab-badge tab-badge-warn">${warn}</span>`;
            return '';
        })();

        const configBadge = (() => {
            let crit = 0, warn = 0;
            if (m.resource_limits && m.resource_limits.current) {
                crit += m.resource_limits.current.filter(r => r.status === 'critical').length;
                warn += m.resource_limits.current.filter(r => r.status === 'warning').length;
            }
            if (m.alert_log && m.alert_log.summary && m.alert_log.summary.critical > 0) crit++;
            if (crit) return `<span class="tab-badge tab-badge-crit">${crit}</span>`;
            if (warn) return `<span class="tab-badge tab-badge-warn">${warn}</span>`;
            return '';
        })();

        const idxBadge = (() => {
            const crit = m.index_analysis.filter(i => i.pct_deleted > 50).length;
            const warn = m.index_analysis.filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).length;
            if (crit) return `<span class="tab-badge tab-badge-crit">${crit}</span>`;
            if (warn) return `<span class="tab-badge tab-badge-warn">${warn}</span>`;
            return '';
        })();

        const backupBadge = (() => {
            if (!m.backup_stats) return '';
            const s = m.backup_stats.overall_status;
            if (s === 'critical') return '<span class="tab-badge tab-badge-crit">!</span>';
            if (s === 'warning') return '<span class="tab-badge tab-badge-warn">!</span>';
            if (s === 'ok') return '<span class="tab-badge tab-badge-ok">✓</span>';
            return '';
        })();


        let html = `
        <!-- Report header -->
        <div class="report-header">
            <div class="report-title">
                <h1>${esc(data.connection_name)}</h1>
                <div class="report-meta">
                    <span>${esc(m.instance.db_name)} &middot; Oracle ${esc(m.instance.version)}</span>
                    <span class="dot"></span>
                    <span>${new Date(data.created_at).toLocaleString()}</span>
                    ${data.is_demo ? '<span class="dot"></span><span style="color:var(--accent)">Demo Mode</span>' : ''}
                    ${m.proxy_version ? '<span class="dot"></span><span style="color:var(--text-dim)">Proxy v' + esc(m.proxy_version) + '</span>' : ''}
                </div>
                ${m.proxy_version && m.proxy_version < '3.1.1' ? '<div style="margin-top:8px;padding:8px 14px;background:rgba(180,83,9,0.12);border:1px solid rgba(180,83,9,0.3);border-radius:8px;font-size:12px;color:var(--yellow)"><strong>Proxy update available.</strong> Your proxy is running v' + esc(m.proxy_version) + '. Download the latest from <a href="/downloads/oracle-proxy.py" style="color:var(--accent)">here</a> and restart the proxy service to get all health check sections.</div>' : ''}
            </div>
            <div class="score-ring-wrapper">
                <div class="score-ring">
                    <svg viewBox="0 0 100 100">
                        <circle class="bg" cx="50" cy="50" r="38"/>
                        <circle class="fg" cx="50" cy="50" r="38"
                            stroke="${scoreColor(data.overall_score)}"
                            stroke-dasharray="${circumference}"
                            stroke-dashoffset="${offset}"/>
                    </svg>
                    <div class="score-text" style="color:${scoreColor(data.overall_score)}">${data.overall_score}</div>
                </div>
                <div class="score-ring-label">${scoreLabel(data.overall_score)}</div>
            </div>
        </div>

        <!-- 5 score cards -->
        <div class="scores-row">
            ${renderScoreCard('Tablespace', s.tablespace)}
            ${renderScoreCard('Wait Events', s.wait_events)}
            ${renderScoreCard('SQL Perf', s.sql_performance)}
            ${renderScoreCard('Active Sessions', s.active_sessions)}
            ${renderScoreCard('Memory', s.memory)}
        </div>

        <!-- 8-TAB NAVIGATION -->
        <div class="tabs-nav" id="tabsNav">
            <button class="tab-btn active" onclick="switchTab('summary',this)">🧠 AI Summary ${summaryBadge}</button>
            <button class="tab-btn" onclick="switchTab('performance',this)">⚡ Performance ${(() => { const alCrit = m.alert_log && m.alert_log.summary && m.alert_log.summary.critical > 0; return alCrit ? '<span class="tab-badge tab-badge-crit">!</span>' : ''; })()}</button>
            <button class="tab-btn" onclick="switchTab('storage',this)">💾 Storage ${storageBadge}</button>
            <button class="tab-btn" onclick="switchTab('backup',this)">🛡 Backup &amp; Recovery ${backupBadge}</button>
            <button class="tab-btn" onclick="switchTab('config',this)">⚙️ Config &amp; Sizing ${configBadge}</button>
            <button class="tab-btn" onclick="switchTab('indexes',this)">🔑 Indexes ${idxBadge}</button>
            <button class="tab-btn" onclick="switchTab('os',this)">🖥 OS Stats</button>
        </div>

        <!-- ===== TAB 1: AI SUMMARY ===== -->
        <div class="tab-panel active" id="tab-summary">
            ${renderAISummaryTab(data, findings, critCount, warnCount, okCount)}
        </div>

        <!-- ===== TAB 2: PERFORMANCE ===== -->
        <div class="tab-panel" id="tab-performance">
            ${renderPerformanceTab(data, m, s, scoreTag)}
        </div>

        <!-- ===== TAB 3: STORAGE ===== -->
        <div class="tab-panel" id="tab-storage">
            ${renderStorageTab(data, m, s, scoreTag)}
        </div>

        <!-- ===== TAB 4: BACKUP & RECOVERY ===== -->
        <div class="tab-panel" id="tab-backup">
            ${renderBackupTab(data, m)}
        </div>


        <!-- ===== TAB 6: CONFIG & SIZING ===== -->
        <div class="tab-panel" id="tab-config">
            ${renderConfigTab(data, m)}
        </div>

        <!-- ===== TAB 7: INDEXES ===== -->
        <div class="tab-panel" id="tab-indexes">
            ${renderIndexesTab(data, m, s, scoreTag)}
        </div>

        <!-- ===== TAB 8: OS STATS ===== -->
        <div class="tab-panel" id="tab-os">
            ${renderOsTab(data, m)}
        </div>
        `;

        document.getElementById('reportContent').innerHTML = html;

        if (data.status === 'completed') {
            showDownloadButton();
        }
    }

    // ============================================================
    // TAB SWITCHING
    // ============================================================
    function switchTab(name, btn) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('tab-' + name);
        if (panel) panel.classList.add('active');
    }

    // ============================================================
    // BUILD FINDINGS (aggregated from metrics)
    // ============================================================
    function buildFindings(data) {
        const findings = [];
        const m = data.metrics;
        const s = data.scores;

        // Tablespace findings
        if (m.tablespaces) {
            m.tablespaces.forEach(t => {
                if (t.pct_used > 90) {
                    findings.push({
                        severity: 'critical',
                        category: 'Storage',
                        metric: t.name + ' Tablespace',
                        value: t.pct_used + '% used (' + t.used_gb + ' GB / ' + t.total_gb + ' GB)',
                        recommendation: 'Tablespace is ' + t.pct_used + '% full. Add datafiles or enable AUTOEXTEND immediately.',
                        fix: t.autoextend
                            ? `-- Add a datafile to ${t.name}\nALTER TABLESPACE ${t.name} ADD DATAFILE SIZE 2G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                            : `-- Enable AUTOEXTEND on existing datafile\nALTER DATABASE DATAFILE '/path/to/datafile.dbf' AUTOEXTEND ON NEXT 512M MAXSIZE UNLIMITED;\n-- Or add new datafile\nALTER TABLESPACE ${t.name} ADD DATAFILE SIZE 2G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                    });
                } else if (t.pct_used > 80) {
                    findings.push({
                        severity: 'warning',
                        category: 'Storage',
                        metric: t.name + ' Tablespace',
                        value: t.pct_used + '% used — approaching limit',
                        recommendation: 'Tablespace is above 80%. Monitor closely and plan expansion.',
                        fix: `ALTER TABLESPACE ${t.name} ADD DATAFILE SIZE 1G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                    });
                }
            });
        }

        // Wait event findings
        if (m.wait_events) {
            m.wait_events.filter(w => w.pct_db_time > 10).forEach(w => {
                findings.push({
                    severity: 'critical',
                    category: 'Performance',
                    metric: 'Wait Event: ' + w.event,
                    value: w.pct_db_time + '% DB time — ' + w.wait_class,
                    recommendation: w.wait_class === 'Application'
                        ? 'Application lock contention detected. Review locking patterns and long-running transactions.'
                        : w.event.toLowerCase().includes('log')
                            ? 'Redo log write contention. Consider increasing redo log size or adding log groups.'
                            : 'High wait time on ' + w.event + '. Investigate sessions waiting on this event.',
                    fix: w.event.toLowerCase().includes('log')
                        ? `-- Check redo log size\nSELECT GROUP#, BYTES/1024/1024 MB FROM V$LOG;\n-- Add larger redo logs\nALTER DATABASE ADD LOGFILE SIZE 500M;\nALTER DATABASE DROP LOGFILE GROUP <old_group>;`
                        : `-- Find sessions waiting on this event\nSELECT SID, SERIAL#, USERNAME, SQL_ID, SECONDS_IN_WAIT\nFROM V$SESSION\nWHERE EVENT = '${w.event}' AND WAIT_CLASS <> 'Idle'\nORDER BY SECONDS_IN_WAIT DESC;`
                });
            });

            m.wait_events.filter(w => w.pct_db_time > 5 && w.pct_db_time <= 10).forEach(w => {
                findings.push({
                    severity: 'warning',
                    category: 'Performance',
                    metric: 'Wait Event: ' + w.event,
                    value: w.pct_db_time + '% DB time',
                    recommendation: 'Notable wait time. Monitor trend.',
                    fix: `SELECT SID, SERIAL#, USERNAME, SQL_ID, SECONDS_IN_WAIT\nFROM V$SESSION WHERE EVENT = '${w.event}'\nORDER BY SECONDS_IN_WAIT DESC;`
                });
            });
        }

        // SQL performance findings
        if (m.top_sql) {
            m.top_sql.filter(sq => sq.elapsed_per_exec_ms > 5).forEach(sq => {
                findings.push({
                    severity: 'critical',
                    category: 'SQL',
                    metric: 'Slow SQL: ' + sq.sql_id,
                    value: sq.elapsed_per_exec_ms + 'ms/exec × ' + formatNum(sq.executions) + ' executions',
                    recommendation: sq.issue || 'High elapsed time per execution. Review execution plan, consider index or rewrite.',
                    fix: `-- Get execution plan\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('${sq.sql_id}', NULL, 'ALLSTATS LAST'));\n-- Force hard parse to refresh plan\nEXECUTE DBMS_SHARED_POOL.PURGE('${sq.sql_id}', 'C');`
                });
            });
        }

        // Index findings
        if (m.index_analysis) {
            m.index_analysis.filter(i => i.pct_deleted > 50).forEach(i => {
                findings.push({
                    severity: 'critical',
                    category: 'Indexes',
                    metric: 'Fragmented Index: ' + i.index_name,
                    value: i.pct_deleted + '% deleted entries — rebuild needed',
                    recommendation: 'Index has excessive deleted entries, degrading query performance.',
                    fix: `ALTER INDEX ${i.index_name} REBUILD ONLINE;`
                });
            });
            m.index_analysis.filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).forEach(i => {
                findings.push({
                    severity: 'warning',
                    category: 'Indexes',
                    metric: 'Index: ' + i.index_name,
                    value: i.pct_deleted + '% deleted entries',
                    recommendation: 'Consider rebuilding this index during a maintenance window.',
                    fix: `ALTER INDEX ${i.index_name} REBUILD ONLINE;`
                });
            });
        }

        // Memory findings
        if (m.sga_stats) {
            if (m.sga_stats.buffer_cache_hit_ratio < 90) {
                findings.push({
                    severity: 'critical',
                    category: 'Memory',
                    metric: 'Buffer Cache Hit Ratio',
                    value: m.sga_stats.buffer_cache_hit_ratio + '% (threshold: 90%)',
                    recommendation: 'Buffer cache hit ratio is low — too much physical I/O. Increase SGA_TARGET or DB_CACHE_SIZE.',
                    fix: `-- Increase buffer cache (adjust to available RAM)\nALTER SYSTEM SET DB_CACHE_SIZE = 4G SCOPE=BOTH;\n-- Or increase SGA_TARGET\nALTER SYSTEM SET SGA_TARGET = 8G SCOPE=BOTH;`
                });
            }
            if (m.sga_stats.shared_pool_free_pct < 5) {
                findings.push({
                    severity: 'warning',
                    category: 'Memory',
                    metric: 'Shared Pool Free Memory',
                    value: m.sga_stats.shared_pool_free_pct + '% free — very low',
                    recommendation: 'Shared pool is nearly exhausted. Increase SHARED_POOL_SIZE.',
                    fix: `ALTER SYSTEM SET SHARED_POOL_SIZE = 2G SCOPE=BOTH;`
                });
            }
            if (m.pga_stats && m.pga_stats.multipass_executions_pct > 5) {
                findings.push({
                    severity: 'warning',
                    category: 'Memory',
                    metric: 'PGA Multi-pass Executions',
                    value: m.pga_stats.multipass_executions_pct + '% — disk spill detected',
                    recommendation: 'Sort operations are spilling to disk. Increase PGA_AGGREGATE_TARGET.',
                    fix: `ALTER SYSTEM SET PGA_AGGREGATE_TARGET = 4G SCOPE=BOTH;`
                });
            }
        }

        // Undo findings
        if (m.undo_stats && m.undo_stats.current) {
            const u = m.undo_stats.current;
            const hist = m.undo_stats.historical || {};
            const ora01555Risk = hist.peak_query_length_s && u.tuned_undo_retention_s && hist.peak_query_length_s > u.tuned_undo_retention_s;
            if (ora01555Risk) {
                findings.push({
                    severity: 'critical',
                    category: 'Storage',
                    metric: 'ORA-01555 Risk (Undo Retention)',
                    value: 'Longest query ' + hist.peak_query_length_s + 's exceeds UNDO_RETENTION ' + u.tuned_undo_retention_s + 's',
                    recommendation: 'Queries are running longer than UNDO_RETENTION allows. Risk of "snapshot too old" errors.',
                    fix: `ALTER SYSTEM SET UNDO_RETENTION=${Math.ceil((hist.peak_query_length_s||1800)*1.5)} SCOPE=BOTH;\n-- Also consider expanding undo tablespace if pct_used is high`
                });
            } else if (u.pct_used > 90) {
                findings.push({
                    severity: 'critical',
                    category: 'Storage',
                    metric: 'Undo Tablespace Critical',
                    value: u.pct_used + '% used — ' + u.tablespace_name,
                    recommendation: 'Undo tablespace is critically full. Add a datafile immediately.',
                    fix: `ALTER TABLESPACE ${u.tablespace_name} ADD DATAFILE SIZE 5G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                });
            } else if (u.pct_used > 80) {
                findings.push({
                    severity: 'warning',
                    category: 'Storage',
                    metric: 'Undo Tablespace High',
                    value: u.pct_used + '% used — monitor closely',
                    recommendation: 'Undo tablespace is above 80%. Plan to add a datafile.',
                    fix: `ALTER TABLESPACE ${u.tablespace_name} ADD DATAFILE SIZE 5G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                });
            }
        }

        // Temp findings
        if (m.temp_stats && m.temp_stats.current) {
            const t = m.temp_stats.current;
            const hist = m.temp_stats.historical || {};
            if ((hist.peak_pct || 0) > 90 || t.pct_used > 80) {
                findings.push({
                    severity: (hist.peak_pct || 0) > 90 || t.pct_used > 90 ? 'critical' : 'warning',
                    category: 'Storage',
                    metric: 'Temp Tablespace Pressure',
                    value: 'Current: ' + t.pct_used + '%, 30d peak: ' + ((hist.peak_pct) ? hist.peak_pct + '%' : 'N/A'),
                    recommendation: 'Temp tablespace has been at risk of exhaustion. Add temp datafiles and investigate large sort consumers.',
                    fix: `ALTER TABLESPACE ${t.tablespace_name} ADD TEMPFILE SIZE 8G AUTOEXTEND ON MAXSIZE UNLIMITED;`
                });
            }
        }

        // Alert log findings
        if (m.alert_log && m.alert_log.summary) {
            const al = m.alert_log;
            al.entries && al.entries.filter(e => e.severity === 'critical').forEach(e => {
                findings.push({
                    severity: 'critical',
                    category: 'Alert Log',
                    metric: 'Alert Log Critical',
                    value: e.ts + ': ' + e.message.substring(0, 100),
                    recommendation: 'Critical alert log entry requires immediate investigation.',
                    fix: e.message.includes('ORA-01555') ? `ALTER SYSTEM SET UNDO_RETENTION=3600 SCOPE=BOTH;` : ''
                });
            });
            if (al.summary.warning > 2) {
                findings.push({
                    severity: 'warning',
                    category: 'Alert Log',
                    metric: 'Alert Log Warnings',
                    value: al.summary.warning + ' warning entries in last 24h',
                    recommendation: 'Multiple alert log warnings detected. Check for checkpoint incomplete and redo log issues.',
                    fix: `-- Check checkpoint frequency\nSELECT NAME, VALUE FROM V$PARAMETER WHERE NAME IN ('log_checkpoints_to_alert','fast_start_mttr_target');\n-- Add redo log groups if switching too fast\nALTER DATABASE ADD LOGFILE SIZE 500M;`
                });
            }
        }

        // Resource limit findings
        if (m.resource_limits && m.resource_limits.current) {
            m.resource_limits.current.filter(r => r.status === 'critical').forEach(r => {
                findings.push({
                    severity: 'critical',
                    category: 'Config',
                    metric: 'Resource Limit Critical: ' + r.resource,
                    value: 'Peak at ' + r.max_utilization + ' of ' + r.limit_display + ' limit (' + r.pct_max_used + '%)',
                    recommendation: r.resource + ' has been at ' + r.pct_max_used + '% of limit. Increase before next peak.',
                    fix: `ALTER SYSTEM SET ${r.resource.toUpperCase()}=${Math.ceil((r.limit_value||100)*1.5)} SCOPE=SPFILE;\n-- Restart required for PROCESSES`
                });
            });
            m.resource_limits.current.filter(r => r.status === 'warning').forEach(r => {
                findings.push({
                    severity: 'warning',
                    category: 'Config',
                    metric: 'Resource Limit Warning: ' + r.resource,
                    value: 'Peak at ' + r.pct_max_used + '% of limit (' + r.limit_display + ')',
                    recommendation: 'Monitor ' + r.resource + ' — approaching limit.',
                    fix: `ALTER SYSTEM SET ${r.resource.toUpperCase()}=${Math.ceil((r.limit_value||100)*1.5)} SCOPE=SPFILE;`
                });
            });
        }

        // PGA history finding
        if (m.sga_pga_history && m.sga_pga_history.pga_history) {
            const pgaHist = m.sga_pga_history.pga_history;
            const pgaTarget = m.sga_pga_history.current && m.sga_pga_history.current.pga_target_gb;
            if (pgaHist.peak_allocated_gb && pgaTarget && pgaHist.peak_allocated_gb > pgaTarget * 1.2) {
                findings.push({
                    severity: 'warning',
                    category: 'Memory',
                    metric: 'PGA Undersized (Historical)',
                    value: 'Peak ' + pgaHist.peak_allocated_gb + 'GB exceeds target ' + pgaTarget + 'GB by ' + Math.round((pgaHist.peak_allocated_gb/pgaTarget-1)*100) + '%',
                    recommendation: 'PGA_AGGREGATE_TARGET is insufficient — multipass sorts occurring. Increase to cover historical peak.',
                    fix: `ALTER SYSTEM SET PGA_AGGREGATE_TARGET=${Math.ceil(pgaHist.peak_allocated_gb*1.5)}G SCOPE=BOTH;`
                });
            }
        }

        // Add OK findings for healthy areas
        if (s.tablespace >= 75 && findings.filter(f => f.category === 'Storage').length === 0) {
            findings.push({ severity: 'ok', category: 'Storage', metric: 'All Tablespaces', value: 'All below 80% capacity', recommendation: '', fix: '' });
        }
        if (s.memory >= 75 && findings.filter(f => f.category === 'Memory').length === 0) {
            findings.push({ severity: 'ok', category: 'Memory', metric: 'SGA / PGA', value: 'Memory sizing is healthy', recommendation: '', fix: '' });
        }
        if (s.index_health >= 75 && findings.filter(f => f.category === 'Indexes').length === 0) {
            findings.push({ severity: 'ok', category: 'Indexes', metric: 'All Indexes', value: 'No fragmentation detected', recommendation: '', fix: '' });
        }

        // Sort: critical → warning → ok
        const sevOrder = { critical: 0, warning: 1, ok: 2 };
        findings.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
        return findings;
    }

    // ============================================================
    // TAB 1: AI SUMMARY
    // ============================================================
    function renderAISummaryTab(data, findings, critCount, warnCount, okCount) {
        let html = '';

        // AI analysis section
        if (data.status === 'analyzing') {
            html += `<div class="ai-analysis">
                <div class="ai-analysis-header">
                    <div class="ai-pulse"></div>
                    <h3>AI Analysis in Progress</h3>
                </div>
                <div class="analyzing-state" style="padding:30px 0">
                    <div class="analyzing-spinner"></div>
                    <p class="analyzing-text">Analyzing your database metrics...</p>
                    <button class="cancel-btn" onclick="cancelHealthCheck()">Cancel</button>
                </div>
            </div>`;
        } else if (data.ai_analysis) {
            html += `<div class="ai-analysis">
                <div class="ai-analysis-header">
                    <div class="ai-pulse"></div>
                    <h3>AI Analysis</h3>
                </div>
                <div class="ai-content">${markdownToHtml(data.ai_analysis)}</div>
            </div>`;
        }

        // Findings header
        html += `<div class="findings-header">
            ${critCount ? `<div class="findings-counter counter-crit">🔴 ${critCount} Critical</div>` : ''}
            ${warnCount ? `<div class="findings-counter counter-warn">🟡 ${warnCount} Warning</div>` : ''}
            ${okCount ? `<div class="findings-counter counter-ok">🟢 ${okCount} OK</div>` : ''}
        </div>`;

        if (critCount > 0) {
            html += `<p style="font-size:14px;color:var(--text-dim);margin-bottom:16px">${critCount} critical issue${critCount > 1 ? 's' : ''} detected — fix these first:</p>`;
        }

        // Finding cards
        findings.forEach((f, i) => {
            const sevClass = f.severity === 'critical' ? 'sev-critical' :
                             f.severity === 'warning' ? 'sev-warning' : 'sev-ok';
            const emoji = f.severity === 'critical' ? '🔴' : f.severity === 'warning' ? '🟡' : '🟢';
            const expanded = f.severity === 'critical' || (i < 3);

            html += `<div class="finding-item sev-${f.severity} ${expanded ? '' : 'collapsed'}">
                <div class="finding-header" onclick="toggleFinding(this.parentElement)">
                    <div class="finding-header-left">
                        <span class="sev-badge ${sevClass}">${emoji} ${f.severity.toUpperCase()}</span>
                        <div>
                            <div class="finding-metric">${esc(f.metric)}</div>
                            <div class="finding-value">${esc(f.value)}</div>
                        </div>
                    </div>
                    <span class="finding-toggle">&#9662;</span>
                </div>
                ${f.severity !== 'ok' ? `<div class="finding-body">
                    <p class="finding-rec">${esc(f.recommendation)}</p>
                    ${f.fix ? `<div style="position:relative">
                        <div class="fix-command">${esc(f.fix)}<button class="copy-btn" onclick="copyFix(this, ${JSON.stringify(f.fix)})">Copy</button></div>
                    </div>` : ''}
                </div>` : ''}
            </div>`;
        });

        return html;
    }

    // ============================================================
    // TAB 2: PERFORMANCE
    // ============================================================
    function renderPerformanceTab(data, m, s, scoreTag) {
        let html = '';

        // Wait Events (real data)
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>Top Wait Events <span class="tag ${scoreTag(s.wait_events)}">${s.wait_events}/100</span></h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <table class="data-table">
                    <tr><th>Event</th><th>Wait Class</th><th>% DB Time</th><th></th><th>Total Waits</th><th>Avg Wait</th></tr>
                    ${m.wait_events.filter(w => w.pct_db_time > 0).map(w => {
                        const cls = w.pct_db_time > 10 ? 'crit' : w.pct_db_time > 5 ? 'warn' : 'ok';
                        return `<tr>
                            <td class="mono" style="font-size:12px">${esc(w.event)}</td>
                            <td><span class="tag tag-${w.wait_class === 'Application' ? 'critical' : w.wait_class === 'Concurrency' ? 'warning' : 'ok'}" style="font-size:10px">${esc(w.wait_class)}</span></td>
                            <td class="mono" style="color:${cls === 'crit' ? 'var(--red)' : cls === 'warn' ? 'var(--yellow)' : 'var(--text)'}">${w.pct_db_time}%</td>
                            <td class="bar-cell"><div class="bar-track"><div class="bar-fill fill-${cls}" style="width:${Math.min(w.pct_db_time * 3, 100)}%"></div></div></td>
                            <td class="mono">${formatNum(w.total_waits)}</td>
                            <td class="mono">${w.avg_wait_ms}ms</td>
                        </tr>`;
                    }).join('')}
                </table>
            </div>
        </div>`;

        // Top SQL (real data)
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>Top SQL by Elapsed Time <span class="tag ${scoreTag(s.sql_performance)}">${s.sql_performance}/100</span></h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                ${m.top_sql.map(sq => `
                    <div style="margin-bottom:18px;padding-bottom:18px;border-bottom:1px solid var(--border)">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                            <span class="mono" style="color:var(--accent);font-size:13px">${esc(sq.sql_id)}</span>
                            <span class="tag ${sq.elapsed_per_exec_ms > 5 ? 'tag-critical' : sq.elapsed_per_exec_ms > 1 ? 'tag-warning' : 'tag-ok'}">${sq.elapsed_per_exec_ms}ms/exec</span>
                        </div>
                        <div class="sql-block">${esc(sq.sql_text)}</div>
                        <div style="display:flex;gap:20px;margin-top:8px;font-size:12px;color:var(--text-dim)">
                            <span>Executions: <span class="mono">${formatNum(sq.executions)}</span></span>
                            <span>Buffer Gets/exec: <span class="mono">${sq.buffer_gets_per_exec}</span></span>
                            <span>Disk Reads: <span class="mono">${formatNum(sq.disk_reads)}</span></span>
                        </div>
                        <div style="margin-top:8px;font-size:13px;color:var(--red)">&#9888; ${esc(sq.issue)}</div>
                    </div>
                `).join('')}
            </div>
        </div>`;

        // Alert Log (real data if available)
        if (m.alert_log) {
            const al = m.alert_log;
            const sum = al.summary || {};
            const sevColor = sum.critical > 0 ? 'var(--red)' : sum.warning > 0 ? 'var(--yellow)' : 'var(--text-dim)';
            html += `<div class="section">
                <div class="section-header" onclick="toggleSection(this)">
                    <h3>Alert Log — Last 24 Hours
                        ${sum.critical > 0 ? '<span class="tag tag-critical">'+sum.critical+' CRITICAL</span>' : ''}
                        ${sum.warning > 0 ? '<span class="tag tag-warning">'+sum.warning+' WARNING</span>' : ''}
                    </h3>
                    <span class="section-toggle">&#9662;</span>
                </div>
                <div class="section-body">
                    <div style="background:var(--surface-2,#1a1a1e);border-radius:8px;padding:14px;margin-bottom:16px;display:flex;gap:24px;flex-wrap:wrap">
                        <span style="font-size:13px">Total: <span class="mono">${sum.total||0}</span></span>
                        <span style="font-size:13px;color:var(--red)">🔴 Critical: <span class="mono">${sum.critical||0}</span></span>
                        <span style="font-size:13px;color:var(--yellow)">🟡 Warning: <span class="mono">${sum.warning||0}</span></span>
                        <span style="font-size:13px;color:var(--text-dim)">ℹ️ Info: <span class="mono">${sum.info||0}</span></span>
                        <span style="font-size:13px;color:var(--text-dim)">⚪ Noise: <span class="mono">${sum.noise||0}</span></span>
                    </div>
                    ${al.error ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">⚠️ Alert log access error: ${esc(al.error)} (requires SELECT on V$DIAG_ALERT_EXT)</div>` : ''}
                    ${al.entries && al.entries.filter(e => e.severity !== 'noise').length > 0 ? `
                    <table class="data-table">
                        <tr><th style="width:160px">Time</th><th style="width:80px">Severity</th><th>Message</th></tr>
                        ${al.entries.filter(e => e.severity !== 'noise').map(e => `<tr>
                            <td class="mono" style="font-size:11px;color:var(--text-dim)">${esc(e.ts)}</td>
                            <td>${e.severity==='critical' ? '<span class="tag tag-critical">CRITICAL</span>' : e.severity==='warning' ? '<span class="tag tag-warning">WARNING</span>' : '<span class="tag tag-ok">INFO</span>'}</td>
                            <td class="mono" style="font-size:11px;word-break:break-word">${esc(e.message.substring(0,250))}</td>
                        </tr>`).join('')}
                    </table>` : (!al.error ? '<div style="font-size:13px;color:var(--green)">✅ No critical or warning entries in the last 24 hours.</div>' : '')}
                    ${al.entries && al.entries.filter(e => e.severity === 'noise').length > 0 ? `
                    <div style="margin-top:12px;font-size:12px;color:var(--text-dim)">
                        ${al.entries.filter(e => e.severity === 'noise').length} noise entries hidden (TNS scanner bots, routine events)
                    </div>` : ''}
                </div>
            </div>`;
        }

        // ASH placeholder
        html += `<div class="placeholder-card">
            <div class="placeholder-icon">📊</div>
            <div class="placeholder-title">Active Session History (ASH)</div>
            <div class="placeholder-desc">Real-time and historical active session analysis — top sessions, wait event trends, DB time breakdown. Requires DBA_HIST_ACTIVE_SESS_HISTORY access.</div>
            <span class="wave-badge">Wave A — Coming Soon</span>
        </div>`;

        return html;
    }

    // ============================================================
    // TAB 3: STORAGE
    // ============================================================
    function renderStorageTab(data, m, s, scoreTag) {
        const critTs = m.tablespaces.filter(t => t.pct_used > 90).length;
        const warnTs = m.tablespaces.filter(t => t.pct_used > 80 && t.pct_used <= 90).length;

        let html = `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>Tablespace Usage ${critTs ? '<span class="tag tag-critical">'+critTs+' CRITICAL</span>' : ''} ${warnTs ? '<span class="tag tag-warning">'+warnTs+' WARNING</span>' : ''}</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <table class="data-table">
                    <tr><th>Tablespace</th><th>Used</th><th>Total</th><th>Usage</th><th></th><th>Autoextend</th></tr>
                    ${m.tablespaces.map(t => {
                        const cls = t.pct_used > 90 ? 'crit' : t.pct_used > 80 ? 'warn' : 'ok';
                        return `<tr>
                            <td><span class="status-dot dot-${cls}"></span><span class="mono">${esc(t.name)}</span></td>
                            <td class="mono">${t.used_gb} GB</td>
                            <td class="mono">${t.total_gb} GB</td>
                            <td class="bar-cell"><div class="bar-track"><div class="bar-fill fill-${cls}" style="width:${t.pct_used}%"></div></div></td>
                            <td class="mono" style="color:${cls === 'crit' ? 'var(--red)' : cls === 'warn' ? 'var(--yellow)' : 'var(--text-dim)'}">${t.pct_used}%</td>
                            <td>${t.autoextend ? '<span style="color:var(--green)">ON</span>' : '<span style="color:var(--red)">OFF</span>'}</td>
                        </tr>`;
                    }).join('')}
                </table>
            </div>
        </div>`;

        // Undo Tablespace (real data)
        if (m.undo_stats && m.undo_stats.current) {
            const u = m.undo_stats.current;
            const hist = m.undo_stats.historical || {};
            const undoCls = u.pct_used > 90 ? 'crit' : u.pct_used > 80 ? 'warn' : 'ok';
            const ora01555Risk = hist.peak_query_length_s && u.tuned_undo_retention_s && hist.peak_query_length_s > u.tuned_undo_retention_s;
            html += `<div class="section">
                <div class="section-header" onclick="toggleSection(this)">
                    <h3>Undo Tablespace ${ora01555Risk ? '<span class="tag tag-critical">ORA-01555 RISK</span>' : ''} ${u.pct_used > 80 ? '<span class="tag tag-'+(u.pct_used>90?'critical':'warning')+'">'+u.pct_used+'% USED</span>' : ''}</h3>
                    <span class="section-toggle">&#9662;</span>
                </div>
                <div class="section-body">
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                        <div class="stat-mini"><div class="stat-label">Tablespace</div><div class="mono stat-val">${esc(u.tablespace_name)}</div></div>
                        <div class="stat-mini"><div class="stat-label">Current Usage</div><div class="mono stat-val" style="color:${undoCls==='crit'?'var(--red)':undoCls==='warn'?'var(--yellow)':'var(--green)'}">${u.pct_used}% (${typeof u.used_gb==='number'?u.used_gb.toFixed(1):u.used_gb}/${u.total_gb} GB)</div></div>
                        <div class="stat-mini"><div class="stat-label">Tuned Retention</div><div class="mono stat-val">${u.tuned_undo_retention_s}s</div></div>
                        <div class="stat-mini"><div class="stat-label">Longest Query</div><div class="mono stat-val" style="color:${ora01555Risk?'var(--red)':'var(--text)'}">${u.max_query_length_s}s ${ora01555Risk?'⚠️':''}</div></div>
                        <div class="stat-mini"><div class="stat-label">Retention Mode</div><div class="mono stat-val">${esc(u.retention_mode)}</div></div>
                        <div class="stat-mini"><div class="stat-label">Active Blocks</div><div class="mono stat-val">${(u.active_blocks||0).toLocaleString()}</div></div>
                    </div>
                    <div class="bar-track" style="height:10px;margin-bottom:12px"><div class="bar-fill fill-${undoCls}" style="width:${u.pct_used}%"></div></div>
                    ${m.undo_stats.awr_available && hist.peak_pct_used != null ? `
                    <div style="background:var(--surface-2,#1a1a1e);border-radius:8px;padding:14px;margin-top:12px">
                        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">📈 30-Day Historical Peak (DBA_HIST_UNDOSTAT)</div>
                        <div style="display:flex;gap:24px;flex-wrap:wrap">
                            <span style="font-size:13px">Peak usage: <span class="mono" style="color:${hist.peak_pct_used>90?'var(--red)':hist.peak_pct_used>80?'var(--yellow)':'var(--text)'}">${hist.peak_pct_used}%</span> at <span class="mono">${esc(hist.peak_time||'unknown')}</span></span>
                            ${hist.peak_query_length_s ? `<span style="font-size:13px">Peak query length: <span class="mono" style="color:${ora01555Risk?'var(--red)':'var(--text)'}">${hist.peak_query_length_s}s</span></span>` : ''}
                            ${hist.max_tuned_retention_min ? `<span style="font-size:13px">Max tuned retention: <span class="mono">${hist.max_tuned_retention_min} min</span></span>` : ''}
                        </div>
                        ${ora01555Risk ? `<div style="margin-top:10px;padding:10px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">🔴 ORA-01555 Risk: Longest query (${hist.peak_query_length_s}s) exceeds UNDO_RETENTION (${u.tuned_undo_retention_s}s). Fix: <span class="mono">ALTER SYSTEM SET UNDO_RETENTION=${Math.ceil(hist.peak_query_length_s*1.5)} SCOPE=BOTH;</span></div>` : ''}
                    </div>` : (!m.undo_stats.awr_available ? `<div style="font-size:12px;color:var(--text-dim);margin-top:8px">📋 Historical peaks require Diagnostics Pack license (DBA_HIST_UNDOSTAT)</div>` : '')}
                </div>
            </div>`;
        }

        // Temp Tablespace (real data)
        if (m.temp_stats && m.temp_stats.current) {
            const t = m.temp_stats.current;
            const hist = m.temp_stats.historical || {};
            const tempCls = t.pct_used > 90 ? 'crit' : t.pct_used > 80 ? 'warn' : 'ok';
            html += `<div class="section">
                <div class="section-header" onclick="toggleSection(this)">
                    <h3>Temp Tablespace ${t.pct_used > 80 ? '<span class="tag tag-'+(t.pct_used>90?'critical':'warning')+'">'+t.pct_used+'% USED</span>' : ''}</h3>
                    <span class="section-toggle">&#9662;</span>
                </div>
                <div class="section-body">
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                        <div class="stat-mini"><div class="stat-label">Tablespace</div><div class="mono stat-val">${esc(t.tablespace_name)}</div></div>
                        <div class="stat-mini"><div class="stat-label">Current Usage</div><div class="mono stat-val" style="color:${tempCls==='crit'?'var(--red)':tempCls==='warn'?'var(--yellow)':'var(--green)'}">${t.pct_used}% (${typeof t.used_gb==='number'?t.used_gb.toFixed(1):t.used_gb}/${t.total_gb} GB)</div></div>
                        <div class="stat-mini"><div class="stat-label">Free</div><div class="mono stat-val">${typeof t.free_gb==='number'?t.free_gb.toFixed(1):t.free_gb} GB</div></div>
                        ${hist.peak_gb ? `<div class="stat-mini"><div class="stat-label">30d Peak</div><div class="mono stat-val" style="color:${(hist.peak_pct||0)>90?'var(--red)':(hist.peak_pct||0)>80?'var(--yellow)':'var(--text)'}">${hist.peak_gb} GB (${hist.peak_pct}%)</div></div>` : ''}
                        ${hist.peak_time ? `<div class="stat-mini"><div class="stat-label">Peak Time</div><div class="mono stat-val">${esc(hist.peak_time)}</div></div>` : ''}
                    </div>
                    <div class="bar-track" style="height:10px;margin-bottom:16px"><div class="bar-fill fill-${tempCls}" style="width:${t.pct_used}%"></div></div>
                    ${t.top_sessions && t.top_sessions.length > 0 ? `
                    <div style="margin-top:12px">
                        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Top Temp Consumers</div>
                        <table class="data-table">
                            <tr><th>SID</th><th>Username</th><th>Temp Used (MB)</th><th>Tablespace</th></tr>
                            ${t.top_sessions.map(sess => `<tr>
                                <td class="mono">${sess.sid}</td>
                                <td class="mono">${esc(sess.username)}</td>
                                <td class="mono" style="color:${sess.temp_mb>1024?'var(--red)':sess.temp_mb>256?'var(--yellow)':'var(--text)'}">${(sess.temp_mb||0).toLocaleString()}</td>
                                <td class="mono">${esc(sess.tablespace||'')}</td>
                            </tr>`).join('')}
                        </table>
                    </div>` : ''}
                </div>
            </div>`;
        }

        // Datafile I/O placeholder (still Wave A)
        html += `<div class="coming-soon-grid">
            <div class="coming-soon-item">
                <div class="cs-label">🔵 Datafile I/O</div>
                <div class="cs-desc">Per-datafile read/write throughput, hot file detection, I/O wait correlation. Pinpoints storage bottlenecks to specific tablespaces.</div>
                <span class="wave-badge" style="margin-top:8px;display:inline-block">Wave A — Coming Soon</span>
            </div>
        </div>`;

        return html;
    }

    // ============================================================
    // TAB 4: BACKUP & RECOVERY
    // ============================================================
    function renderBackupTab(data, m) {
        const b = m && m.backup_stats;
        if (!b) {
            return `<div class="placeholder-card">
                <div class="placeholder-icon">🛡</div>
                <div class="placeholder-title">Backup &amp; Recovery</div>
                <div class="placeholder-desc">No backup data collected. Run a health check to populate this tab.</div>
            </div>`;
        }

        function statusDot(s) {
            if (s === 'critical') return '🔴';
            if (s === 'warning') return '🟡';
            if (s === 'ok') return '🟢';
            return '⚪';
        }
        function statusTag(s) {
            if (s === 'critical') return '<span class="tag tag-critical">CRITICAL</span>';
            if (s === 'warning') return '<span class="tag tag-warning">WARNING</span>';
            if (s === 'ok') return '<span class="tag tag-ok">OK</span>';
            return '<span style="color:var(--text-dim);font-size:12px">UNKNOWN</span>';
        }
        function fmt(n, decimals=1) {
            if (n == null || isNaN(n)) return '—';
            return Number(n).toFixed(decimals);
        }

        let html = '';

        // ── Check 1: RMAN Backup Freshness ──
        const r = b.rman_backup || {};
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>${statusDot(r.status)} RMAN Backup Freshness ${statusTag(r.status)}</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">`;

        if (!r.rman_available || !r.last_by_type || r.last_by_type.length === 0) {
            html += `<div style="padding:20px;background:var(--surface-2);border-radius:8px;color:var(--text-dim);font-size:13px">
                ⚪ RMAN not configured on this database, or no completed backup jobs found.
                This database may be relying on OS-level backups or cold backups.
            </div>`;
        } else {
            // Summary stats
            const fullHrs = r.full_backup_hours_ago;
            const fullCls = fullHrs == null ? 'var(--text-dim)' : fullHrs > 48 ? 'var(--red)' : fullHrs > 24 ? 'var(--yellow)' : 'var(--green)';
            html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                <div class="stat-mini"><div class="stat-label">Last Full Backup</div>
                    <div class="mono stat-val" style="color:${fullCls}">${fullHrs != null ? fmt(fullHrs) + 'h ago' : 'NONE FOUND'}</div></div>
                ${r.last_incremental_backup ? `<div class="stat-mini"><div class="stat-label">Last Incremental</div>
                    <div class="mono stat-val">${fmt(r.last_incremental_backup.hours_ago)}h ago</div></div>` : ''}
                ${r.last_archivelog_backup ? `<div class="stat-mini"><div class="stat-label">Last Archivelog</div>
                    <div class="mono stat-val">${fmt(r.last_archivelog_backup.hours_ago)}h ago</div></div>` : ''}
                ${r.last_full_backup ? `<div class="stat-mini"><div class="stat-label">Full Backup Size</div>
                    <div class="mono stat-val">${fmt(r.last_full_backup.size_gb)} GB</div></div>` : ''}
            </div>`;

            // Last by type table
            if (r.last_by_type && r.last_by_type.length > 0) {
                html += `<div style="margin-bottom:16px">
                    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Last Completed Backup Per Type</div>
                    <table class="data-table">
                        <tr><th>Type</th><th>Last Completed</th><th>Age</th><th>Size</th><th>Duration</th><th>Status</th></tr>
                        ${r.last_by_type.map(bk => {
                            const ageCls = bk.input_type === 'DB FULL' && bk.hours_ago > 48 ? 'var(--red)'
                                         : bk.input_type === 'DB FULL' && bk.hours_ago > 24 ? 'var(--yellow)' : 'var(--green)';
                            const dur = bk.elapsed_seconds > 3600 ? Math.round(bk.elapsed_seconds/3600*10)/10 + 'h' : Math.round(bk.elapsed_seconds/60) + 'm';
                            return `<tr>
                                <td class="mono">${esc(bk.input_type)}</td>
                                <td class="mono">${esc(bk.end_time)}</td>
                                <td class="mono" style="color:${ageCls}">${fmt(bk.hours_ago)}h ago</td>
                                <td class="mono">${fmt(bk.size_gb)} GB</td>
                                <td class="mono">${dur}</td>
                                <td><span style="color:${bk.status==='COMPLETED'?'var(--green)':'var(--red)'}">${esc(bk.status)}</span></td>
                            </tr>`;
                        }).join('')}
                    </table>
                </div>`;
            }

            // Recent jobs (last 10)
            if (r.recent_jobs && r.recent_jobs.length > 0) {
                html += `<div style="margin-top:12px">
                    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Recent Backup Jobs (last 10)</div>
                    <table class="data-table">
                        <tr><th>Type</th><th>Start</th><th>End</th><th>Size</th><th>Status</th></tr>
                        ${r.recent_jobs.map(bk => `<tr>
                            <td class="mono">${esc(bk.input_type)}</td>
                            <td class="mono" style="font-size:12px">${esc(bk.start_time)}</td>
                            <td class="mono" style="font-size:12px">${esc(bk.end_time)}</td>
                            <td class="mono">${fmt(bk.size_gb)} GB</td>
                            <td><span style="color:${bk.status==='COMPLETED'?'var(--green)':bk.status==='FAILED'?'var(--red)':'var(--yellow)'}">${esc(bk.status)}</span></td>
                        </tr>`).join('')}
                    </table>
                </div>`;
            }

            // Fix guidance
            if (r.status === 'critical') {
                const fixHours = Math.ceil((fullHrs || 0) * 1.1);
                html += `<div style="margin-top:14px;padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">
                    🔴 <strong>Action Required:</strong> Last full backup is ${fullHrs != null ? fmt(fullHrs) + 'h old' : 'missing'}. Run immediately:<br>
                    <code style="display:block;margin-top:8px;padding:8px;background:#1a1a1f;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px">
                    RMAN TARGET /<br>RUN {<br>&nbsp;&nbsp;BACKUP AS COMPRESSED BACKUPSET FULL DATABASE PLUS ARCHIVELOG;<br>}</code>
                </div>`;
            } else if (r.status === 'warning') {
                html += `<div style="margin-top:14px;padding:12px;background:#2d2400;border-radius:6px;border-left:3px solid var(--yellow);font-size:13px">
                    🟡 Full backup is ${fmt(fullHrs)}h old (target: &lt;24h). Verify backup schedule is running on time.
                </div>`;
            }
        }
        html += '</div></div>';

        // ── Check 2: FRA Usage ──
        const f = b.fra_usage || {};
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>${statusDot(f.status)} Fast Recovery Area (FRA) ${statusTag(f.status)}</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">`;

        if (!f.fra_configured) {
            html += `<div style="padding:20px;background:var(--surface-2);border-radius:8px;color:var(--text-dim);font-size:13px">
                ⚪ FRA not configured (DB_RECOVERY_FILE_DEST not set). Backups may be written to a custom location.
                <br><br>To configure FRA: <code style="font-family:'JetBrains Mono',monospace;font-size:12px">ALTER SYSTEM SET DB_RECOVERY_FILE_DEST='/fra' SCOPE=BOTH; ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE=500G SCOPE=BOTH;</code>
            </div>`;
        } else {
            const fraFillCls = f.pct_used > 90 ? 'crit' : f.pct_used > 80 ? 'warn' : 'ok';
            html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                <div class="stat-mini"><div class="stat-label">Location</div><div class="mono stat-val" style="font-size:11px">${esc(f.location)}</div></div>
                <div class="stat-mini"><div class="stat-label">FRA Usage</div>
                    <div class="mono stat-val" style="color:${fraFillCls==='crit'?'var(--red)':fraFillCls==='warn'?'var(--yellow)':'var(--green)'}">${fmt(f.pct_used)}% (${fmt(f.used_gb)}/${fmt(f.limit_gb)} GB)</div></div>
                <div class="stat-mini"><div class="stat-label">Reclaimable</div>
                    <div class="mono stat-val">${fmt(f.pct_reclaimable)}% (${fmt(f.reclaimable_gb)} GB)</div></div>
                <div class="stat-mini"><div class="stat-label">Archivelog Rate</div>
                    <div class="mono stat-val">${fmt(f.archivelogs_24h_gb)} GB/day</div></div>
                ${f.hours_until_full != null ? `<div class="stat-mini"><div class="stat-label">Hours Until Full</div>
                    <div class="mono stat-val" style="color:${f.hours_until_full < 24 ? 'var(--red)' : f.hours_until_full < 72 ? 'var(--yellow)' : 'var(--green)'}">${f.hours_until_full}h</div></div>` : ''}
            </div>
            <div class="bar-track" style="height:10px;margin-bottom:16px">
                <div class="bar-fill fill-${fraFillCls}" style="width:${Math.min(f.pct_used,100)}%"></div>
            </div>`;

            if (f.file_type_breakdown && f.file_type_breakdown.length > 0) {
                html += `<div style="margin-top:12px">
                    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">FRA Breakdown by File Type</div>
                    <table class="data-table">
                        <tr><th>File Type</th><th>% Used</th><th>% Reclaimable</th><th>Files</th></tr>
                        ${f.file_type_breakdown.map(ft => `<tr>
                            <td class="mono">${esc(ft.file_type)}</td>
                            <td class="mono" style="color:${ft.pct_used>30?'var(--yellow)':'var(--text)'}">${fmt(ft.pct_used)}%</td>
                            <td class="mono">${fmt(ft.pct_reclaimable)}%</td>
                            <td class="mono">${(ft.number_of_files||0).toLocaleString()}</td>
                        </tr>`).join('')}
                    </table>
                </div>`;
            }

            if (f.status === 'critical') {
                html += `<div style="margin-top:14px;padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">
                    🔴 FRA at ${fmt(f.pct_used)}% with only ${fmt(f.pct_reclaimable)}% reclaimable. Risk of archiver stuck!<br>
                    <code style="display:block;margin-top:8px;padding:8px;background:#1a1a1f;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px">
                    -- Increase FRA size (example: 1TB)<br>
                    ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE=1000G SCOPE=BOTH;<br><br>
                    -- Or delete obsolete backups via RMAN<br>
                    RMAN TARGET / &lt;&lt; EOF<br>DELETE NOPROMPT OBSOLETE;<br>EOF</code>
                </div>`;
            } else if (f.status === 'warning') {
                html += `<div style="margin-top:14px;padding:12px;background:#2d2400;border-radius:6px;border-left:3px solid var(--yellow);font-size:13px">
                    🟡 FRA at ${fmt(f.pct_used)}% — approaching capacity. ${f.hours_until_full != null ? `Estimated full in ${f.hours_until_full}h at current archivelog rate.` : ''} Run DELETE OBSOLETE soon.
                </div>`;
            }
        }
        html += '</div></div>';

        // ── Check 3: Archivelog Generation Rate ──
        const al = b.archivelog_rate || {};
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>${statusDot(al.status)} Archivelog Generation Rate ${statusTag(al.status)}</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                    <div class="stat-mini"><div class="stat-label">Archive Mode</div>
                        <div class="mono stat-val" style="color:${al.archivelog_mode===false?'var(--red)':al.archivelog_mode?'var(--green)':'var(--text-dim)'}">${esc(al.log_mode || 'UNKNOWN')}</div></div>
                    <div class="stat-mini"><div class="stat-label">Log Switches/Hour</div>
                        <div class="mono stat-val" style="color:${(al.switches_per_hour||0)>20?'var(--yellow)':(al.switches_per_hour||0)>30?'var(--red)':'var(--text)'}">${fmt(al.switches_per_hour)}/hr</div></div>
                    <div class="stat-mini"><div class="stat-label">Switches (24h)</div>
                        <div class="mono stat-val">${(al.switches_24h||0).toLocaleString()}</div></div>
                    <div class="stat-mini"><div class="stat-label">Archivelogs (24h)</div>
                        <div class="mono stat-val">${(al.archivelogs_24h||0).toLocaleString()}</div></div>
                    <div class="stat-mini"><div class="stat-label">Volume (24h)</div>
                        <div class="mono stat-val">${fmt((al.total_size_mb_24h||0)/1024)} GB</div></div>
                    ${al.log_groups && al.log_groups.length > 0 ? `<div class="stat-mini"><div class="stat-label">Redo Log Groups</div>
                        <div class="mono stat-val">${al.log_groups.length} × ${al.log_groups[0]?.size_mb||0}MB</div></div>` : ''}
                </div>`;

        if (al.archivelog_mode === false) {
            html += `<div style="margin-top:8px;padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">
                🔴 Database is in NOARCHIVELOG mode — point-in-time recovery is impossible!<br>
                <code style="display:block;margin-top:8px;padding:8px;background:#1a1a1f;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px">
                -- Enable archivelog mode (requires shutdown)<br>
                SHUTDOWN IMMEDIATE;<br>STARTUP MOUNT;<br>ALTER DATABASE ARCHIVELOG;<br>ALTER DATABASE OPEN;<br>ALTER SYSTEM ARCHIVE LOG CURRENT;</code>
            </div>`;
        } else if ((al.switches_per_hour||0) > 20) {
            html += `<div style="margin-top:8px;padding:12px;background:#2d2400;border-radius:6px;border-left:3px solid var(--yellow);font-size:13px">
                🟡 ${fmt(al.switches_per_hour)} log switches/hour exceeds 20/hr threshold. Redo logs may be undersized.<br>
                <code style="display:block;margin-top:8px;padding:8px;background:#1a1a1f;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px">
                -- Add larger redo log groups (example: 1GB each)<br>
                ALTER DATABASE ADD LOGFILE GROUP 7 SIZE 1G;<br>ALTER DATABASE ADD LOGFILE GROUP 8 SIZE 1G;<br>-- Then drop old undersized groups after they become INACTIVE</code>
            </div>`;
        }

        // Redo log groups table
        if (al.log_groups && al.log_groups.length > 0) {
            html += `<div style="margin-top:16px">
                <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Redo Log Groups</div>
                <table class="data-table">
                    <tr><th>Group</th><th>Members</th><th>Size</th><th>Status</th><th>Archived</th></tr>
                    ${al.log_groups.map(lg => `<tr>
                        <td class="mono">${lg.group_num}</td>
                        <td class="mono">${lg.members}</td>
                        <td class="mono">${(lg.size_mb||0).toLocaleString()} MB</td>
                        <td class="mono" style="color:${lg.status==='CURRENT'?'var(--blue)':lg.status==='ACTIVE'?'var(--yellow)':'var(--text-dim)'}">${esc(lg.status)}</td>
                        <td class="mono" style="color:${lg.archived==='YES'?'var(--green)':'var(--text-dim)'}">${esc(lg.archived)}</td>
                    </tr>`).join('')}
                </table>
            </div>`;
        }

        // Hourly archivelog breakdown (last 12h bar chart)
        if (al.hourly_breakdown && al.hourly_breakdown.length > 0) {
            const maxCount = Math.max(...al.hourly_breakdown.map(h => h.log_count), 1);
            html += `<div style="margin-top:16px">
                <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Archivelog Count by Hour (last 24h)</div>
                <div style="display:flex;align-items:flex-end;gap:4px;height:60px;background:var(--surface-2);border-radius:6px;padding:8px">
                    ${al.hourly_breakdown.slice(0,24).reverse().map(h => {
                        const pct = Math.round((h.log_count / maxCount) * 100);
                        const tooHigh = h.log_count > 20;
                        return `<div title="${h.hour}: ${h.log_count} logs (${h.size_mb}MB)" style="flex:1;background:${tooHigh?'var(--yellow)':'var(--accent)'};height:${Math.max(pct,4)}%;border-radius:2px 2px 0 0;opacity:0.8;min-height:4px"></div>`;
                    }).join('')}
                </div>
                <div style="font-size:11px;color:var(--text-dim);margin-top:4px;text-align:center">← oldest &nbsp;&nbsp; newest →</div>
            </div>`;
        }

        html += '</div></div>';

        // ── Check 4: Backup Validation ──
        const v = b.backup_validation || {};
        html += `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>${statusDot(v.status)} Backup Validation &amp; Corruption Check ${statusTag(v.status)}</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px">
                    <div class="stat-mini"><div class="stat-label">Backup Corruptions</div>
                        <div class="mono stat-val" style="color:${(v.backup_corruptions||0)>0?'var(--red)':'var(--green)'}">${(v.backup_corruptions||0)} (${(v.backup_corrupt_blocks||0)} blocks)</div></div>
                    <div class="stat-mini"><div class="stat-label">Copy Corruptions</div>
                        <div class="mono stat-val" style="color:${(v.copy_corruptions||0)>0?'var(--red)':'var(--green)'}">${(v.copy_corruptions||0)} (${(v.copy_corrupt_blocks||0)} blocks)</div></div>
                    <div class="stat-mini"><div class="stat-label">Total Corruptions</div>
                        <div class="mono stat-val" style="color:${(v.total_corruptions||0)>0?'var(--red)':'var(--green)'}">${v.total_corruptions||0}</div></div>
                    <div class="stat-mini"><div class="stat-label">Integrity</div>
                        <div class="mono stat-val" style="color:${(v.total_corruptions||0)>0?'var(--red)':'var(--green)'}">${(v.total_corruptions||0)===0?'CLEAN ✓':'CORRUPT ⚠️'}</div></div>
                </div>`;

        if ((v.total_corruptions||0) > 0) {
            html += `<div style="margin-bottom:14px;padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">
                🔴 Corruption detected in backup sets or datafile copies! Validate and potentially restore from a clean backup.<br>
                <code style="display:block;margin-top:8px;padding:8px;background:#1a1a1f;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px">
                -- Check specific corruption details<br>
                SELECT * FROM V$BACKUP_CORRUPTION;<br>
                SELECT * FROM V$COPY_CORRUPTION;<br><br>
                -- Validate backup pieces<br>
                RMAN TARGET /<br>VALIDATE BACKUPSET ALL CHECK LOGICAL;</code>
            </div>`;
        } else if (v.last_3_backups_failed) {
            html += `<div style="margin-bottom:14px;padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px">
                🔴 Last 3 RMAN backup jobs all FAILED. Check RMAN output for error details and resolve immediately.
            </div>`;
        }

        if (v.recent_operations && v.recent_operations.length > 0) {
            html += `<div style="margin-top:4px">
                <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Recent RMAN Operations (last 7 days)</div>
                <table class="data-table">
                    <tr><th>Operation</th><th>Start Time</th><th>End Time</th><th>MB Processed</th><th>Status</th></tr>
                    ${v.recent_operations.map(op => `<tr>
                        <td class="mono">${esc(op.operation)}</td>
                        <td class="mono" style="font-size:12px">${esc(op.start_time)}</td>
                        <td class="mono" style="font-size:12px">${esc(op.end_time)}</td>
                        <td class="mono">${(op.mbytes_processed||0).toLocaleString()}</td>
                        <td>
                            <span style="color:${op.status==='COMPLETED'?'var(--green)':op.status==='FAILED'?'var(--red)':'var(--yellow)'}">${esc(op.status)}</span>
                            ${op.status==='FAILED' && op.output ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px">${esc(op.output.substring(0,120))}</div>` : ''}
                        </td>
                    </tr>`).join('')}
                </table>
            </div>`;
        }

        html += '</div></div>';

        return html;
    }


    // ============================================================
    // TAB 6: CONFIG & SIZING
    // ============================================================
    function renderConfigTab(data, m) {
        if (!m || !m.instance) return '<div class="placeholder-card"><div class="placeholder-icon">⚙️</div><div class="placeholder-title">Config &amp; Sizing</div><div class="placeholder-desc">No data available.</div></div>';

        const inst = m.instance;
        const sgaGb = inst.sga_target_gb || 0;
        const pgaGb = inst.pga_aggregate_target_gb || 0;
        const bufHit = m.sga_stats ? m.sga_stats.buffer_cache_hit_ratio : null;
        const pgaAlloc = m.pga_stats ? m.pga_stats.pga_allocated_gb : null;

        // Score each param
        function sizingBadge(current, peak, limit) {
            if (!peak || !limit) return '<span class="sized-ok">— NO DATA</span>';
            const pctOfLimit = (peak / limit) * 100;
            if (pctOfLimit > 100) return '<span class="sized-crit">🔴 EXCEEDED</span>';
            if (pctOfLimit > 90) return '<span class="sized-crit">🔴 CRITICAL</span>';
            if (pctOfLimit > 80) return '<span class="sized-warn">🟡 NEAR LIMIT</span>';
            return '<span class="sized-ok">🟢 OK</span>';
        }

        let html = `<div class="card">
            <h3>⚙️ Database Parameters</h3>
            <p style="font-size:13px;color:var(--text-dim);margin-bottom:20px">
                Current settings vs. current usage. Historical peak data requires DBA_HIST_RESOURCE_LIMIT access (Wave A).
            </p>
            <table class="config-table">
                <thead>
                    <tr>
                        <th>Parameter</th>
                        <th>Current Setting</th>
                        <th>Current Usage</th>
                        <th>Status</th>
                        <th>Fix Command</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="mono">SGA_TARGET</td>
                        <td class="mono">${sgaGb} GB</td>
                        <td>${m.sga_stats ? m.sga_stats.buffer_cache_hit_ratio + '% buffer hit' : '—'}</td>
                        <td>${bufHit !== null ? (bufHit < 90 ? '<span class="sized-crit">🔴 LOW HIT RATIO</span>' : '<span class="sized-ok">🟢 OK</span>') : '—'}</td>
                        <td class="mono" style="font-size:11px;color:var(--text-dim)">ALTER SYSTEM SET SGA_TARGET=<b>?G</b> SCOPE=BOTH;</td>
                    </tr>
                    <tr>
                        <td class="mono">PGA_AGGREGATE_TARGET</td>
                        <td class="mono">${pgaGb} GB</td>
                        <td>${pgaAlloc !== null ? pgaAlloc + ' GB allocated' : '—'}</td>
                        <td>${m.pga_stats ? (m.pga_stats.multipass_executions_pct > 5 ? '<span class="sized-crit">🔴 DISK SPILL</span>' : '<span class="sized-ok">🟢 OK</span>') : '—'}</td>
                        <td class="mono" style="font-size:11px;color:var(--text-dim)">ALTER SYSTEM SET PGA_AGGREGATE_TARGET=<b>?G</b> SCOPE=BOTH;</td>
                    </tr>
                    <tr>
                        <td class="mono">DB_BLOCK_SIZE</td>
                        <td class="mono">${inst.db_block_size || '—'}</td>
                        <td>—</td>
                        <td>—</td>
                        <td class="mono" style="font-size:11px;color:var(--text-dim);font-style:italic">Read-only — set at creation</td>
                    </tr>
                </tbody>
            </table>
        </div>`;

        // Resource Limits (real data)
        if (m.resource_limits && m.resource_limits.current && m.resource_limits.current.length > 0) {
            const rl = m.resource_limits;
            const critCount = rl.current.filter(r => r.status === 'critical').length;
            const warnCount = rl.current.filter(r => r.status === 'warning').length;
            const hist = rl.historical || {};
            html += `<div class="card" style="margin-top:20px">
                <h3>📊 Resource Limits
                    ${critCount > 0 ? '<span class="tag tag-critical" style="margin-left:8px">'+critCount+' CRITICAL</span>' : ''}
                    ${warnCount > 0 ? '<span class="tag tag-warning" style="margin-left:8px">'+warnCount+' NEAR LIMIT</span>' : ''}
                </h3>
                <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px">Current usage, session/process peak, and limit headroom. ${rl.awr_available ? 'Historical peaks from DBA_HIST_RESOURCE_LIMIT (30-day lookback).' : 'AWR not available — current V$RESOURCE_LIMIT only.'}</p>
                <table class="config-table">
                    <thead>
                        <tr><th>Resource</th><th>Current</th><th>Session Peak</th><th>30d AWR Peak</th><th>Limit</th><th>% of Limit</th><th>Status</th><th>Fix Command</th></tr>
                    </thead>
                    <tbody>
                        ${rl.current.map(r => {
                            const awrPeak = hist[r.resource] ? hist[r.resource].hist_peak : null;
                            const awrMax = hist[r.resource] ? hist[r.resource].hist_max : null;
                            const fixCmd = r.status !== 'ok' && r.limit_value ? `ALTER SYSTEM SET ${r.resource.toUpperCase()}=${Math.ceil(r.limit_value * 1.5)} SCOPE=SPFILE;` : '—';
                            return `<tr>
                                <td class="mono">${esc(r.resource)}</td>
                                <td class="mono">${r.current_utilization.toLocaleString()}</td>
                                <td class="mono">${r.max_utilization.toLocaleString()}</td>
                                <td class="mono">${awrPeak != null ? awrPeak.toLocaleString() : (rl.awr_available ? '—' : 'N/A')}</td>
                                <td class="mono">${esc(r.limit_display)}</td>
                                <td class="mono" style="color:${r.status==='critical'?'var(--red)':r.status==='warning'?'var(--yellow)':'var(--text-dim)'}">${r.pct_max_used != null ? r.pct_max_used + '%' : '—'}</td>
                                <td>${r.status==='critical' ? '<span class="sized-crit">🔴 CRITICAL</span>' : r.status==='warning' ? '<span class="sized-warn">🟡 NEAR LIMIT</span>' : '<span class="sized-ok">🟢 OK</span>'}</td>
                                <td class="mono" style="font-size:10px;color:var(--text-dim)">${fixCmd !== '—' ? esc(fixCmd) : '—'}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
        }

        // SGA/PGA Historical Sizing (real data)
        if (m.sga_pga_history) {
            const h = m.sga_pga_history;
            const c = h.current || {};
            const pgaHist = h.pga_history || {};
            const pgaOverAllocated = pgaHist.peak_allocated_gb && c.pga_target_gb && pgaHist.peak_allocated_gb > c.pga_target_gb;
            html += `<div class="card" style="margin-top:20px">
                <h3>🧮 SGA/PGA Historical Sizing ${pgaOverAllocated ? '<span class="tag tag-warning" style="margin-left:8px">PGA UNDERSIZED</span>' : ''}</h3>
                <p style="font-size:13px;color:var(--text-dim);margin-bottom:16px">${h.awr_available ? 'Historical peaks from DBA_HIST_PGASTAT and DBA_HIST_SGA (30-day lookback).' : 'AWR not available — current V$PARAMETER values only.'}</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:20px">
                    <div class="stat-mini"><div class="stat-label">SGA_TARGET</div><div class="mono stat-val">${c.sga_target_gb || 0} GB</div></div>
                    <div class="stat-mini"><div class="stat-label">SGA_MAX_SIZE</div><div class="mono stat-val">${c.sga_max_gb || 0} GB</div></div>
                    <div class="stat-mini"><div class="stat-label">PGA_AGGREGATE_TARGET</div><div class="mono stat-val">${c.pga_target_gb || 0} GB</div></div>
                    <div class="stat-mini"><div class="stat-label">MEMORY_TARGET</div><div class="mono stat-val">${c.memory_target_gb || 0} GB ${c.memory_target_gb === 0 ? '<span style="color:var(--text-dim);font-size:11px">(AMM off)</span>' : ''}</div></div>
                    ${pgaHist.peak_allocated_gb ? `<div class="stat-mini"><div class="stat-label">PGA 30d Peak</div><div class="mono stat-val" style="color:${pgaOverAllocated?'var(--red)':'var(--text)'}">${pgaHist.peak_allocated_gb} GB ${pgaOverAllocated ? '⚠️' : ''}</div></div>` : ''}
                    ${pgaHist.peak_time ? `<div class="stat-mini"><div class="stat-label">PGA Peak At</div><div class="mono stat-val">${esc(pgaHist.peak_time)}</div></div>` : ''}
                </div>
                ${pgaOverAllocated ? `<div style="padding:12px;background:#2d1a1a;border-radius:6px;border-left:3px solid var(--red);font-size:13px;margin-bottom:16px">
                    🔴 PGA undersized: Peak allocation (${pgaHist.peak_allocated_gb}GB) exceeded target (${c.pga_target_gb}GB) — heavy multipass sorts occurring.<br>
                    Fix: <span class="mono">ALTER SYSTEM SET PGA_AGGREGATE_TARGET=${Math.ceil((pgaHist.peak_allocated_gb||0)*1.5)}G SCOPE=BOTH;</span>
                </div>` : ''}
                ${h.sga_component_history && h.sga_component_history.length > 0 ? `
                <div style="margin-bottom:16px">
                    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">SGA Component 30-Day Range (ASMM)</div>
                    <table class="data-table">
                        <tr><th>Component</th><th>Min (GB)</th><th>Peak (GB)</th><th>Variance</th></tr>
                        ${h.sga_component_history.map(comp => {
                            const variance = comp.peak_gb - comp.min_gb;
                            return `<tr>
                                <td class="mono">${esc(comp.component)}</td>
                                <td class="mono">${comp.min_gb}</td>
                                <td class="mono">${comp.peak_gb}</td>
                                <td class="mono" style="color:${variance>1?'var(--yellow)':'var(--text-dim)'}">${variance.toFixed(2)} GB ${variance > 1 ? '⚡ ASMM active' : ''}</td>
                            </tr>`;
                        }).join('')}
                    </table>
                </div>` : ''}
                ${h.resize_ops && h.resize_ops.length > 0 ? `
                <div>
                    <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Recent ASMM Resize Operations (V$SGA_RESIZE_OPS)</div>
                    <table class="data-table">
                        <tr><th>Time</th><th>Component</th><th>Operation</th><th>From</th><th>To</th><th>Status</th></tr>
                        ${h.resize_ops.slice(0,10).map(op => `<tr>
                            <td class="mono" style="font-size:11px">${esc(op.op_time)}</td>
                            <td class="mono" style="font-size:11px">${esc(op.component)}</td>
                            <td><span class="tag ${op.oper_type==='GROW'?'tag-ok':'tag-warning'}" style="font-size:10px">${esc(op.oper_type)}</span></td>
                            <td class="mono">${op.from_gb} GB</td>
                            <td class="mono">${op.to_gb} GB</td>
                            <td class="mono" style="font-size:11px;color:var(--text-dim)">${esc(op.status)}</td>
                        </tr>`).join('')}
                    </table>
                </div>` : ''}
            </div>`;
        }

        // Remaining Wave C items
        html += `<div class="placeholder-card">
            <div class="placeholder-icon">📐</div>
            <div class="placeholder-title">Full Parameter Sizing Analysis</div>
            <div class="placeholder-desc">
                Every parameter with: current setting → current usage → historical peak (with date) → trend → sized correctly? → exact fix command.<br><br>
                Covers: OPEN_CURSORS, DB_FILES, LOG_BUFFER, redo log size, and EBS parameters (CM workers, OPP heap, OACore count, WLS thread pool).
            </div>
            <span class="wave-badge">Wave C — Coming Soon</span>
        </div>`;

        return html;
    }

    // ============================================================
    // TAB 7: INDEXES
    // ============================================================
    function renderIndexesTab(data, m, s, scoreTag) {
        const critIdx = m.index_analysis.filter(i => i.pct_deleted > 50).length;
        const fragIdx = m.index_analysis.filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).length;

        return `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>Index Analysis ${critIdx ? '<span class="tag tag-critical">'+critIdx+' CRITICAL</span>' : ''} ${fragIdx ? '<span class="tag tag-warning">'+fragIdx+' FRAGMENTED</span>' : ''} <span class="tag ${scoreTag(s.index_health)}">${s.index_health}/100</span></h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <table class="data-table">
                    <tr><th>Index</th><th>Table</th><th>Size</th><th>B-Level</th><th>Deleted %</th><th></th><th>Status</th><th>Fix</th></tr>
                    ${m.index_analysis.map(i => {
                        const cls = i.pct_deleted > 50 ? 'crit' : i.pct_deleted > 30 ? 'warn' : 'ok';
                        return `<tr>
                            <td class="mono" style="font-size:12px">${esc(i.index_name)}</td>
                            <td class="mono" style="font-size:12px">${esc(i.table_name)}</td>
                            <td class="mono">${formatSize(i.size_mb)}</td>
                            <td class="mono">${i.blevel}</td>
                            <td class="mono" style="color:${cls === 'crit' ? 'var(--red)' : cls === 'warn' ? 'var(--yellow)' : 'var(--text-dim)'}">${i.pct_deleted}%</td>
                            <td class="bar-cell"><div class="bar-track"><div class="bar-fill fill-${cls}" style="width:${i.pct_deleted}%"></div></div></td>
                            <td><span class="status-dot dot-${cls}"></span>${esc(i.status)}</td>
                            <td>${i.pct_deleted > 30 ? `<button class="nav-btn" style="font-size:11px;padding:4px 10px" onclick="copyFix(this, 'ALTER INDEX ${esc(i.index_name)} REBUILD ONLINE;')">Copy Fix</button>` : '—'}</td>
                        </tr>`;
                    }).join('')}
                </table>
            </div>
        </div>`;
    }

    // ============================================================
    // TAB 8: OS STATS
    // ============================================================
    function renderOsTab(data, m) {
        return `<div class="section">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>OS / Host Statistics</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <div class="instance-grid">
                    ${instItem('CPU Count', m.os_stats.cpu_count)}
                    ${instItem('Avg CPU %', m.os_stats.avg_cpu_utilization_pct + '%')}
                    ${instItem('Max CPU %', m.os_stats.max_cpu_utilization_pct + '%')}
                    ${instItem('I/O Wait %', m.os_stats.avg_io_wait_pct + '%')}
                    ${instItem('Physical RAM', m.os_stats.physical_memory_gb + ' GB')}
                    ${instItem('Free Memory', m.os_stats.free_memory_gb + ' GB')}
                    ${instItem('Avg Disk Read', m.os_stats.avg_disk_read_ms + 'ms')}
                    ${instItem('Avg Disk Write', m.os_stats.avg_disk_write_ms + 'ms')}
                </div>
            </div>
        </div>
        <div class="section collapsed">
            <div class="section-header" onclick="toggleSection(this)">
                <h3>Instance Information</h3>
                <span class="section-toggle">&#9662;</span>
            </div>
            <div class="section-body">
                <div class="instance-grid">
                    ${instItem('Database', m.instance.db_name)}
                    ${instItem('Version', m.instance.version)}
                    ${instItem('Host', m.instance.host_name)}
                    ${instItem('CPUs', m.instance.cpus)}
                    ${instItem('SGA Target', m.instance.sga_target_gb + ' GB')}
                    ${instItem('PGA Target', m.instance.pga_aggregate_target_gb + ' GB')}
                    ${instItem('Uptime', m.instance.uptime_days + ' days')}
                    ${instItem('Block Size', m.instance.db_block_size)}
                </div>
            </div>
        </div>`;
    }

    // ============================================================
    // SHARED HELPERS
    // ============================================================
    function renderScoreCard(label, value) {
        const color = value >= 75 ? 'var(--green)' : value >= 50 ? 'var(--yellow)' : 'var(--red)';
        return `<div class="score-card">
            <div class="score-card-value" style="color:${color}">${value}</div>
            <div class="score-card-label">${label}</div>
        </div>`;
    }

    function instItem(label, value) {
        return `<div class="instance-item"><div class="label">${label}</div><div class="value">${esc(String(value))}</div></div>`;
    }

    function toggleSection(el) {
        el.parentElement.classList.toggle('collapsed');
    }

    function toggleFinding(el) {
        el.classList.toggle('collapsed');
    }

    function copyFix(btn, text) {
        navigator.clipboard.writeText(text).then(() => {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            btn.style.color = 'var(--green)';
            setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
        }).catch(() => {
            prompt('Copy this command:', text);
        });
    }

    function formatNum(n) {
        if (n == null || isNaN(n)) return '—';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toString();
    }

    function formatSize(mb) {
        if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
        return mb + ' MB';
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s || '');
        return d.innerHTML;
    }

    function markdownToHtml(md) {
        if (!md) return '';
        let html = md
            .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        html = html.replace(/(<li>[\s\S]*?<\/li>)/g, function(match) {
            if (!match.startsWith('<ul>')) return '<ul>' + match + '</ul>';
            return match;
        });
        html = html.replace(/<\/ul>\s*<ul>/g, '');

        return '<p>' + html + '</p>';
    }

    // ============================================================
    // BOOT
    // ============================================================
    loadReport();
