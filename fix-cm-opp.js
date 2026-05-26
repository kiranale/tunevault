const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

let count = 0;

// 1. CM row: mgr.node -> mgr.name
if (c.includes('esc(mgr.node)')) {
  c = c.split('esc(mgr.node)').join('esc(mgr.name)');
  count++;
  console.log('1. Fixed mgr.node -> mgr.name');
}

// 2. CM row: mgr.actual -> mgr.running (both occurrences)
if (c.includes('mgr.actual < mgr.target')) {
  c = c.split('mgr.actual < mgr.target').join('mgr.running < mgr.target');
  count++;
}
if (c.includes('>${mgr.actual}</td>')) {
  c = c.split('>${mgr.actual}</td>').join('>${mgr.running}</td>');
  count++;
  console.log('2. Fixed mgr.actual -> mgr.running');
}

// 3. CM row: fix the broken status column (line 1916)
// Replace the ${dot} ${'disabled' ? 'Disabled' : mStatus === ... pattern
const mStatusIdx = c.indexOf('mStatus');
if (mStatusIdx >= 0) {
  console.log('Found mStatus at index:', mStatusIdx);
  // Find the broken TD starting from ${dot}
  const dotIdx = c.indexOf('${dot} ${', mStatusIdx - 200);
  const endIdx = c.indexOf('</td>', mStatusIdx);
  if (dotIdx >= 0 && endIdx > dotIdx) {
    const oldStr = c.substring(dotIdx, endIdx + 5);
    // Use double quotes for the replacement string
    // Build replacement using concatenation to avoid template literal eval issues
const p = (s) => s; // passthrough
// The replacement text needs literal ${dot} and ${badStatus ? ...}
// Use string concatenation with char codes for special chars
const quote = String.fromCharCode(39); // '
const newStr = '<td>${dot} ${badStatus ? ' + quote + 'Not Running' + quote + ' : warnStatus ? ' + quote + 'Under-staffed' + quote + ' : ' + quote + 'OK' + quote + '}</td>';
    c = c.split(oldStr).join(newStr);
    count++;
    console.log('3. Fixed broken CM status column (mStatus -> badStatus/warnStatus)');
  }
}

// 4. CM recommendation: m.actual -> m.running
if (c.includes('m.target > 0 && m.actual < m.target')) {
  c = c.split('m.target > 0 && m.actual < m.target').join('m.target > 0 && m.running < m.target');
  count++;
  console.log('4. Fixed m.actual -> m.running in recommendation');
}

// 5. OPP field names: opp.actual -> opp.current_processes
if (c.includes('opp.actual === 0')) {
  c = c.split('opp.actual === 0').join('opp.current_processes === 0');
  count++;
}
if (c.includes('opp.actual < opp.target')) {
  c = c.split('opp.actual < opp.target').join('opp.current_processes < opp.target_processes');
  count++;
}
if (c.includes('${opp.actual} / ${opp.target} target')) {
  c = c.split('${opp.actual} / ${opp.target} target').join('${opp.current_processes} / ${opp.target_processes} target');
  count++;
  console.log('5. Fixed OPP field names');
}

// 6. Remove suspicious standalone } before Workflow Mailer
const lines = c.split('\n');
let fixedLine1982 = false;
for (let i = 0; i < lines.length - 3; i++) {
  if (lines[i].trim() === '</div>`;' &&
      lines[i+1].trim() === '' &&
      lines[i+2].trim() === '}' &&
      lines[i+3].trim().startsWith('//')) {
    lines.splice(i+2, 1);
    fixedLine1982 = true;
    count++;
    console.log('6. Removed suspicious standalone }');
    break;
  }
}
if (fixedLine1982) {
  c = lines.join('\n');
}

console.log('\nTotal fixes:', count);
fs.writeFileSync('public/report.html', c);
console.log('File written.');

// Verify
const html2 = fs.readFileSync('public/report.html', 'utf8');
const lines2 = html2.split('\n');
console.log('\nVerification:');
console.log('Line 1913:', JSON.stringify(lines2[1912]));
console.log('Line 1915:', JSON.stringify(lines2[1914]));
console.log('Line 1916:', JSON.stringify(lines2[1915]));
console.log('Line 1921:', JSON.stringify(lines2[1920]));
console.log('Line 1940:', JSON.stringify(lines2[1939]));
console.log('Line 1981:', JSON.stringify(lines2[1980]));
console.log('Line 1982:', JSON.stringify(lines2[1981]));
console.log('Line 1983:', JSON.stringify(lines2[1982]));
console.log('mStatus still in file?', html2.includes('mStatus'));
console.log('mgr.actual still in file?', html2.includes('mgr.actual'));
console.log('opp.actual still in file?', html2.includes('opp.actual'));