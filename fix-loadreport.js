const fs = require('fs');
const lines = fs.readFileSync('public/report.html', 'utf8').split('\n');

const newLoadReport = `    async function loadReport() {
        // Prevent double-rendering if report is already loaded
        if (reportLoadedAt) return;

        try {
            const res = await fetch('/api/health-checks/' + reportId);
            if (\!res.ok) {
                document.getElementById('reportContent').innerHTML = '<div class=\"analyzing-state\"><p class=\"analyzing-text\">Report not found.</p><a href=\"/dashboard\" class=\"nav-btn\" style=\"margin-top:16px;display:inline-block\">Back to Dashboard</a></div>';
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
                document.getElementById('reportContent').innerHTML = '<div class=\"analyzing-state\"><p class=\"analyzing-text\">Report data could not be displayed.</p><p style=\"color:var(--text-dim);font-size:13px;margin-top:8px\">If the report was run with a limited-privilege user, some data sections may be unavailable.</p><a href=\"/dashboard\" class=\"nav-btn\" style=\"margin-top:16px;display:inline-block\">Back to Dashboard</a></div>';
                reportLoadedAt = new Date(); // stop polling on render failure
                return;
            }

            if (\!renderOk) {
                reportLoadedAt = new Date();
                return;
            }

            if (data.status \!== 'completed' && data.status \!== 'error') {
                pollTimer = setTimeout(loadReport, 2000);
            } else {
                reportLoadedAt = new Date();
            }
        } catch (err) {
            console.error('Failed to load report:', err);
            document.getElementById('reportContent').innerHTML = '<div class=\"analyzing-state\"><p class=\"analyzing-text\">Failed to load report.</p><p style=\"color:var(--text-dim);font-size:13px;margin-top:8px\">' + (err.message || 'Unknown error') + '</p><a href=\"/dashboard\" class=\"nav-btn\" style=\"margin-top:16px;display:inline-block\">Back to Dashboard</a></div>';
            reportLoadedAt = new Date(); // stop polling on fetch error
        }
    }`;

const startIdx = 538; // line 539 (0-indexed)
const endIdx = 568;   // line 569 (0-indexed)

const newLines = [
    ...lines.slice(0, startIdx),
    ...newLoadReport.split('\n'),
    ...lines.slice(endIdx + 1)
];

fs.writeFileSync('public/report.html', newLines.join('\n'));
console.log('Done\! Replaced lines', startIdx+1, '-', endIdx+1);
