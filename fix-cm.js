const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// Fix CM row TD content - use actual characters
// The current file has: class=mono? Let me check
console.log('File sample:', JSON.stringify(c.substring(94000, 94050)));

// Replace the entire CM tbody row content
// Current (after status fix): return `<tr>
//   <td>${esc(mgr.display_name)}</td>
//   <td class=mono style=font-size:11px;color:var(--text-dim)>${esc(mgr.name)}</td>  <-- wrong
//   <td class=mono>${mgr.target}</td>
//   <td class=mono style=color:${mgr.running < mgr.target ? 'var(--yellow)' : 'var(--green)'} >${mgr.running}</td>  <-- wrong
//   <td>${mDot} ${mStatus === ...}</td>  <-- wrong
// </tr>`;

const oldRow = 'return `<tr>\n                        <td>${esc(mgr.display_name)}</td>\n                        <td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>${esc(mgr.name)}</td>\n                        <td class=\u0022mono\u0022>${mgr.target}</td>\n                        <td class=\u0022mono\u0022 style=\u0022color:${mgr.running < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.running}</td>\n                        <td>${mDot} ${mStatus === \u0027disabled\u0027 ? \u0027Disabled\u0027 : mStatus === \u0027critical\u0027 ? \u0027<span style=\u0022color:var(--red)\u0022>Not Running</span>\u0027 : mStatus === \u0027warning\u0027 ? \u0027<span style=\u0022color:var(--yellow)\u0022>Under-staffed</span>\u0027 : \u0027<span style=\u0022color:var(--green)\u0022>OK</span>\u0027}</td>\n                    </tr>`;';

console.log('oldRow in file?', c.includes(oldRow));

// The issue is the file has real quotes but my strings have escape sequences
// Let me just use very simple patterns - the unique ones

// Replace the status TD (unique pattern)
const statusTD = '<td>${mDot} ${mStatus === ';
if (c.includes(statusTD)) {
    c = c.split(statusTD).join('<td>${dot} ${');
    console.log('Fixed status TD');
}

// Replace mgr.running in the context of the CM row color logic
// The specific pattern: <td class=mono style=color:${mgr.running < mgr.target ? 'var(--yellow)' : 'var(--green)'} >${mgr.running}</td>
const oldRunningCell = '<td class=\u0022mono\u0022 style=\u0022color:${mgr.running < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.running}</td>';
const newRunningCell = '<td class=\u0022mono\u0022 style=\u0022color:${mgr.actual < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.actual}</td>';

console.log('oldRunningCell in file?', c.includes(oldRunningCell));

// Use simpler pattern matching
const runningCellOld = 'style=\u0022color:${mgr.running < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.running}';
console.log('Simple running pattern in file?', c.includes(runningCellOld));

// Replace mgr.name in the node cell - look for the specific pattern
const nodeCellOld = '<td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>${esc(mgr.name)}</td>';
const nodeCellNew = '<td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>${esc(mgr.node) || \u0027\u2014\u0027}</td>';

console.log('nodeCellOld in file?', c.includes(nodeCellOld));

fs.writeFileSync('public/report.html', c);
console.log('Done. Partial fixes applied.');