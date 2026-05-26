const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// CM TABLE FIXES
// 1. Running cell: mgr.running -> mgr.actual in the color logic
const runningCell = 'style=\u0022color:${mgr.running < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.running}';
if (c.includes(runningCell)) {
  c = c.split(runningCell).join('style=\u0022color:${mgr.actual < mgr.target ? \u0027var(--yellow)\u0027 : \u0027var(--green)\u0027}\u0022>${mgr.actual}');
  console.log('Replaced running cell');
} else { console.log('runningCell not found'); }

// 2. Node cell: mgr.name -> mgr.node
const nodeCell = '<td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>${esc(mgr.name)}</td>';
if (c.includes(nodeCell)) {
  c = c.split(nodeCell).join('<td class=\u0022mono\u0022 style=\u0022font-size:11px;color:var(--text-dim)\u0022>${esc(mgr.node) || \u0027\u2014\u0027}</td>');
  console.log('Replaced node cell');
} else { console.log('nodeCell not found'); }

// 3. Status TD: mDot -> dot, remove mStatus
const statusTD = '<td>${mDot} ${mStatus === ';
if (c.includes(statusTD)) {
  c = c.split(statusTD).join('<td>${dot} ${');
  console.log('Replaced status TD');
} else { console.log('statusTD not found'); }

// OPP FIELD NAME FIXES
c = c.split('opp.current_processes').join('opp.actual');
c = c.split('opp.target_processes').join('opp.target');
console.log('Replaced OPP field names');

// CM RECOMMENDATION CHECK
c = c.split('m.target > 0 && m.running < m.target').join('m.target > 0 && m.actual < m.target');
console.log('Replaced CM recommendation');

// OACORE PLACEHOLDER
const oacoreStart = '// \u2014 Check 3: OACore';
const newOacore = '// Check 3: OACore (OS Agent required)';
if (c.includes(oacoreStart)) {
  console.log('OACore marker found');
} else {
  console.log('OACore marker NOT found');
}

// Simply replace the if(oac) condition with a placeholder
const oacorePattern = 'if (oac) {\n            html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>${statusDot(oac.status)} OACore (OA Framework) Heap</h3>';
if (c.includes(oacorePattern)) {
  c = c.split(oacorePattern).join('html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>${statusDot(\u0027ok\u0027)} OACore (OA Framework) Heap</h3>');
  console.log('Replaced OACore start');
} else {
  console.log('oacorePattern not found - need different approach');
}

// Also fix the oacore status dot reference - since oac is undefined now
// The OACore status dot uses oac.status which is now undefined
// But we already replaced oac with placeholder, so the condition is bypassed

// FORMS PLACEHOLDER
const formsPattern = 'if (frm) {\n            html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>${statusDot(frm.status !== \u0027unknown\u0027 ? frm.status : \u0027ok\u0027)} Forms Server</h3>';
if (c.includes(formsPattern)) {
  c = c.split(formsPattern).join('html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>${statusDot(\u0027ok\u0027)} Forms Server</h3>');
  console.log('Replaced Forms start');
} else {
  console.log('formsPattern not found - need different approach');
}

// WORKFLOW TABLE FIXES
// 1. WF thead
const oldWFThead = '<th>Component Type</th><th>Name</th><th>Status</th>';
const newWFThead = '<th>Type</th><th>Component Name</th><th>Status</th><th>Startup Mode</th>';
c = c.split(oldWFThead).join(newWFThead);
console.log('Replaced WF thead');

// 2. WF status color check
const oldWFStop = 's.status === \u0027STOPPED\u0027';
const newWFStop = 's.status === \u0027DEACTIVATED_SYSTEM\u0027 || s.status === \u0027STOPPED\u0027';
c = c.split(oldWFStop).join(newWFStop);
console.log('Replaced WF status check');

// 3. Add startup_mode to WF row - find the closing of the status TD and add the new cell
// The WF row ends with: </td> and then </tr>
// We need to add <td>${esc(s.startup_mode) || '—'}</td> before </tr>

// Find the specific pattern: WF status td content followed by </td>\n                </tr>
const wfRowOld = '<td style=\u0022color:${s.status === \u0027RUNNING\u0027 ? \u0027var(--green)\u0027 : s.status === \u0027STOPPED\u0027 ? \u0027var(--red)\u0027 : \u0027var(--yellow)\u0027}\u0022>${esc(s.status)}</td>\n                </tr>';
const wfRowNew = '<td style=\u0022color:${s.status === \u0027RUNNING\u0027 ? \u0027var(--green)\u0027 : s.status === \u0027DEACTIVATED_SYSTEM\u0027 || s.status === \u0027STOPPED\u0027 ? \u0027var(--red)\u0027 : \u0027var(--yellow)\u0027}\u0022>${esc(s.status)}</td>\n                    <td style=\u0022font-size:12px;color:var(--text-dim)\u0022>${esc(s.startup_mode) || \u0027\u2014\u0027}</td>\n                </tr>';
if (c.includes(wfRowOld)) {
  c = c.split(wfRowOld).join(wfRowNew);
  console.log('Added startup_mode to WF row');
} else {
  console.log('WF row pattern not found');
}

// WRITE BACK
fs.writeFileSync('public/report.html', c);
console.log('\nDone.');

// Verify
const content = fs.readFileSync('public/report.html', 'utf8');
console.log('Verification:');
console.log('  mDot still?', content.includes('mDot'));
console.log('  mgr.running still?', content.includes('mgr.running'));
console.log('  mgr.actual?', content.includes('mgr.actual'));
console.log('  mgr.node?', content.includes('mgr.node'));
console.log('  opp.actual?', content.includes('opp.actual'));
console.log('  Startup Mode?', content.includes('Startup Mode'));
console.log('  DEACTIVATED_SYSTEM?', content.includes('DEACTIVATED_SYSTEM'));
console.log('  OACore placeholder?', content.includes('OACore (OA Framework) Heap'));
console.log('  Forms Server?', content.includes('Forms Server</h3>'));