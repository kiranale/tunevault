const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// Replace CM thead
c = c.replace(
    /<th>Manager<\/th>\n                    <th>Internal Name<\/th>\n                    <th>Target<\/th>\n                    <th>Running<\/th>\n                    <th>Status<\/th>/,
    '<th>Manager Name</th>\n                    <th>Node</th>\n                    <th>Actual Processes</th>\n                    <th>Target Processes</th>\n                    <th>Status</th>'
);
console.log('Replaced CM thead:', c.includes('Actual Processes'));

// Replace CM tbody mapping
const oldCMMap = `const mStatus = !mgr.enabled ? 'disabled'
                                  : mgr.running === 0 && mgr.target > 0 ? 'critical'
                                  : mgr.running < mgr.target             ? 'warning'
                                  : 'ok';
                    const mDot = mStatus === 'critical' ? '🔴' : mStatus === 'warning' ? '🟡' : mStatus === 'disabled' ? '⚫' : '🟢';
                    return \u0060<tr>
                        <td>\u0024{esc(mgr.display_name || mgr.name)}</td>
                        <td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>\u0024{esc(mgr.name)}</td>
                        <td class=\u0022mono\u0022>\u0024{mgr.target}</td>
                        <td class=\u0022mono\u0022 style=\u0022color:\u0024{mgr.running < mgr.target ? 'var(--yellow)' : 'var(--green)'}\u0022>\u0024{mgr.running}</td>
                        <td>\u0024{mDot} \u0024{mStatus === 'disabled' ? 'Disabled' : mStatus === 'critical' ? '<span style=\u0022color:var(--red)\u0022>Not Running</span>' : mStatus === 'warning' ? '<span style=\u0022color:var(--yellow)\u0022>Under-staffed</span>' : '<span style=\u0022color:var(--green)\u0022>OK</span>'}</td>
                    </tr>\u0060;`;

console.log('oldCMMap in file?', c.includes(oldCMMap));

// Try to find the exact marker
const marker1 = 'mgr.display_name || mgr.name';
const marker2 = 'mgr.name)}';
console.log('marker1 in file?', c.includes(marker1));
console.log('marker2 in file?', c.includes(marker2));

// Since complex replacement is hard, let's do smaller targeted changes
// Replace individual field references
// 1. Replace the CM status computation (the mStatus and mDot block)
const oldStatus = `const mStatus = !mgr.enabled ? 'disabled'
                                  : mgr.running === 0 && mgr.target > 0 ? 'critical'
                                  : mgr.running < mgr.target             ? 'warning'
                                  : 'ok';
                    const mDot = mStatus === 'critical' ? '🔴' : mStatus === 'warning' ? '🟡' : mStatus === 'disabled' ? '⚫' : '🟢';`;

const newStatus = `const s = mgr.status_label || 'Running';
                    const badStatus = ['Deactivated', 'Terminated', 'Node unavai'].includes(s);
                    const warnStatus = ['Deactivating', 'Suspending', 'Terminating', 'Verifying', 'Activating', 'Restarting', 'Resuming'].includes(s);
                    const dot = badStatus ? '🔴' : warnStatus ? '🟡' : '✅';`;

c = c.split(oldStatus).join(newStatus);
console.log('Replaced CM status logic');

// 2. Replace the CM row TD fields
c = c.split('<td>${esc(mgr.display_name || mgr.name)}</td>').join('<td>${esc(mgr.display_name)}</td>');
c = c.split('<td class=\"mono\" style=\"font-size:11px;color:var(--text-dim)\">${esc(mgr.name)}</td>').join('<td class=\"mono\" style=\"font-size:11px;color:var(--text-dim)\">${esc(mgr.node) || \\'—\\'}</td>');
c = c.split('${mgr.target}').join('${mgr.target}');
console.log('Checking target references...');

// For the running column, we need to replace the <td class=mono>${mgr.running}</td>
// but this also appears in other contexts. Let's be specific.
// The CM row has: target, running columns
// We want: actual, target columns

// Replace the specific target and running cell patterns in CM table
// The CM table has: <td class=mono>${mgr.target}</td> then <td class=mono style=...>${mgr.running}</td>
// New: <td class=mono>${mgr.target}</td> then <td class=mono style=...>${mgr.actual}</td>

// But we also need to change the header from Target/Running to Target Processes/Actual Processes
// And the color logic: ${mgr.running < mgr.target → ${mgr.actual < mgr.target

c = c.split('mgr.running < mgr.target').join('mgr.actual < mgr.target');
c = c.split('${mgr.running}').join('${mgr.actual}');
console.log('Replaced running → actual');

// Replace CM recommendation check
c = c.split('m.target > 0 && m.running < m.target').join('m.target > 0 && m.actual < m.target');
console.log('Replaced CM recommendation check');

// Replace OPP field names
c = c.split('opp.current_processes').join('opp.actual');
c = c.split('opp.target_processes').join('opp.target');
console.log('Replaced OPP field names');

// Replace OACore section start
const oacoreMarker = `// ── Check 3: OACore ──────────────────────────────────────
        if (oac) {
            html += \u0060
        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>
            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>
                <h3>\u0024{statusDot(oac.status)} OACore (OA Framework) Heap</h3>`;

console.log('oacoreMarker in file?', c.includes('// ── Check 3: OACore'));

fs.writeFileSync('public/report.html', c);
console.log('Partial changes applied. Check what needs manual fixing.');
console.log('Total file length:', c.length);