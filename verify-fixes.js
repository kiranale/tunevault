const fs = require('fs');
const l = fs.readFileSync('public/report.html', 'utf8').split('\n');

const checks = [
  [1913, 'mgr.name'],
  [1915, 'mgr.running'],
  [1916, 'badStatus'],
  [1921, 'm.running'],
  [1940, 'opp.current_processes'],
  [1941, 'opp.target_processes'],
  [1982, 'Check 5'],
];

console.log('=== Verification ===');
let allOk = true;
for (const [lineNum, check] of checks) {
  const line = l[lineNum - 1];
  const ok = line.includes(check);
  console.log('Line', lineNum + ':', ok ? 'PASS' : 'FAIL', '- contains:', check);
  console.log('  Content:', line.trim().substring(0, 80));
  if (!ok) allOk = false;
}

// Check for bad patterns
const badPatterns = ['mgr.actual', 'mgr.node', 'opp.actual', 'opp.target', 'mStatus', 'mgr.running'];
console.log('\n=== Bad pattern check ===');
for (const p of badPatterns) {
  const idx = l.findIndex(ln => ln.includes(p));
  if (idx >= 0) {
    console.log('FOUND bad pattern:', p, 'at line', idx + 1, ':', l[idx].trim().substring(0, 60));
    allOk = false;
  } else {
    console.log('OK - no', p, 'found');
  }
}

console.log('\n' + (allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'));
console.log('Total lines:', l.length);