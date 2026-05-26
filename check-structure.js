const fs = require('fs');
const html = fs.readFileSync('public/report.html', 'utf8');
const lines = html.split('\n');

console.log('Total lines:', lines.length);

// Find key functions
const keywords = [
  'async function loadReport',
  'function renderReport',
  'function renderAISummaryTab',
  'function renderScoreCard',
  'function renderPerformanceTab',
  'function renderStorageTab',
  'function renderBackupTab',
  'function renderAppsTab',
  'function renderConfigTab',
  'function renderIndexesTab',
  'function renderOsTab',
  'function buildFindings',
  'function renderVitalsBar',
  'function esc',
  'function markdownToHtml',
  'function formatNum'
];

for (const kw of keywords) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(kw)) {
      console.log(kw + ' at line ' + (i+1) + ': ' + lines[i].trim().substring(0, 80));
      break;
    }
  }
}

// Check if renderScoreCard is defined before it's used
const renderScoreCardLine = lines.findIndex(l => l.includes('function renderScoreCard')) + 1;
const renderScoreCardUsage = lines.findIndex(l => l.includes('renderScoreCard(')) + 1;
console.log('\nrenderScoreCard defined at line:', renderScoreCardLine);
console.log('renderScoreCard first used at line:', renderScoreCardUsage);
console.log('Function hoisting works because:', renderScoreCardLine > renderScoreCardUsage ? 'DEF IS AFTER USE (BAD for let/const, OK for function declarations)' : 'DEF IS BEFORE USE');

// Check if fix-report.js was applied
const hasRunning = html.includes('mgr.actual');
const hasTargetProcesses = html.includes('Target Processes');
console.log('\nfix-report.js was applied:', hasRunning && hasTargetProcesses ? 'YES' : 'NO (or partially)');
console.log('Contains mgr.actual:', hasRunning);
console.log('Contains Target Processes:', hasTargetProcesses);

// Check for OPP/CM field usage
const hasOppActual = html.includes('opp.actual');
const hasMgrRunning = html.includes('mgr.running');
console.log('\nContains opp.actual:', hasOppActual);
console.log('Contains mgr.running:', hasMgrRunning);

// Check the OPP data section
const oppSectionIdx = html.indexOf('opp.current_processes');
console.log('\nopp.current_processes in file:', oppSectionIdx >= 0);
const oppActualIdx = html.indexOf('opp.actual');
console.log('opp.actual in file:', oppActualIdx >= 0);