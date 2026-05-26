const fs = require('fs');
let c = fs.readFileSync('pdf-generator.js', 'utf8');

console.log('=== PDF-GENERATOR.JS FIXES ===');

// 1. Fix CM table header columns
const oldCMCols = `const cmCols = [
    { header: 'Manager',       width: 175 },
    { header: 'Internal Name', width: 110 },
    { header: 'Target',        width:  50 },
    { header: 'Running',       width:  57 },
    { header: 'Status',        width: 115 },
  ];`;
const newCMCols = `const cmCols = [
    { header: 'Manager Name',     width: 175 },
    { header: 'Node',              width:  90 },
    { header: 'Actual Processes',  width:  55 },
    { header: 'Target Processes',  width:  55 },
    { header: 'Status',            width: 115 },
  ];`;
c = c.split(oldCMCols).join(newCMCols);
console.log('Fixed CM table header:', c.includes('Actual Processes'));

// 2. Fix CM table body - status computation
const oldCMStatus = `const mSt  = !mgr.enabled ? 'disabled' : mgr.running === 0 && mgr.target > 0 ? 'critical' : mgr.running < mgr.target ? 'warning' : 'ok';`;
const newCMStatus = `const mSt  = !mgr.enabled ? 'disabled' : mgr.actual === 0 && mgr.target > 0 ? 'critical' : mgr.actual < mgr.target ? 'warning' : 'ok';`;
c = c.split(oldCMStatus).join(newCMStatus);
console.log('Fixed CM status computation:', !c.includes('mgr.running === 0'));

// 3. Fix CM table row - display_name and node
const oldCMRow1 = `      mgr.display_name || mgr.name,`;
const newCMRow1 = `      mgr.display_name,`;
c = c.split(oldCMRow1).join(newCMRow1);
console.log('Fixed display_name:', c.includes(newCMRow1));

const oldCMRow2 = `      mgr.name,`;
const newCMRow2 = `      mgr.node || '—',`;
c = c.split(oldCMRow2).join(newCMRow2);
console.log('Fixed mgr.name to node:', c.includes(newCMRow2));

// 4. Fix CM table row - running cell color check and value
const oldCMRunning = `{ text: String(mgr.running), color: mgr.running < mgr.target ? COLORS.yellow : COLORS.green }`;
const newCMRunning = `{ text: String(mgr.actual), color: mgr.actual < mgr.target ? COLORS.yellow : COLORS.green }`;
c = c.split(oldCMRunning).join(newCMRunning);
console.log('Fixed running cell:', c.includes(newCMRunning));

// 5. Fix OPP field names - use simple string, not template literal
const oldOPP = 'Processes: ${opp.current_processes}/${opp.target_processes}';
const newOPP = 'Processes: ${opp.actual}/${opp.target}';
c = c.split(oldOPP).join(newOPP);
console.log('Fixed OPP field names:', c.includes('opp.actual/opp.target'));

// 6. Replace OACore section with placeholder
if (c.includes('  // ── OACore ──')) {
  const oacoreStart = c.indexOf('  // ── OACore ──');
  const formsStart = c.indexOf('  // ── Forms ──');
  console.log('OACore block: from', oacoreStart, 'to', formsStart);

  // Find the closing `}` of the if(oac) block
  const searchArea = c.substring(oacoreStart, formsStart);
  const lastBrace = searchArea.lastIndexOf('  }');
  const blockEnd = oacoreStart + lastBrace + 3;

  const before = c.substring(0, oacoreStart);
  const after = c.substring(blockEnd);

  const placeholder = `  // ── OACore ──
  // Available with OS Agent (optional add-on)
  if (y > PAGE_HEIGHT - 100) { doc.addPage(); y = MARGIN; }
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('OACore (OA Framework) Heap', MARGIN, y);
  y += 14;
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim).text('Available with OS Agent (optional add-on)', MARGIN, y);
  y += 12;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.textDim).text('Install the OS Agent to monitor OACore JVM heap, active sessions, and receive tuning recommendations.', MARGIN, y);
  y += 10;

`;

  c = before + placeholder + after;
  console.log('Replaced OACore section:', !c.includes('oac.heap_mb'));
} else {
  console.log('OACore section header not found');
}

// 7. Replace Forms section with placeholder
if (c.includes('  // ── Forms ──')) {
  const formsStartIdx = c.indexOf('  // ── Forms ──');
  const wfMailerStart = c.indexOf('  // ── Workflow Mailer ──');
  console.log('Forms block: from', formsStartIdx, 'to', wfMailerStart);

  const searchArea2 = c.substring(formsStartIdx, wfMailerStart);
  const lastBrace2 = searchArea2.lastIndexOf('  }');
  const blockEnd2 = formsStartIdx + lastBrace2 + 3;

  const before2 = c.substring(0, formsStartIdx);
  const after2 = c.substring(blockEnd2);

  const placeholder2 = `  // ── Forms ──
  // Available with OS Agent (optional add-on)
  if (y > PAGE_HEIGHT - 100) { doc.addPage(); y = MARGIN; }
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('Forms Server', MARGIN, y);
  y += 14;
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.textDim).text('Available with OS Agent (optional add-on)', MARGIN, y);
  y += 12;
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.textDim).text('Install the OS Agent to monitor Forms server count, active sessions, and receive sizing recommendations.', MARGIN, y);
  y += 10;

`;

  c = before2 + placeholder2 + after2;
  console.log('Replaced Forms section:', !c.includes('frm.servers'));
} else {
  console.log('Forms section header not found');
}

// 8. Fix WF table header - add Startup Mode column
const oldWFCols = `const svcCols = [
      { header: 'Type',   width: 155 },
      { header: 'Name',   width: 235 },
      { header: 'Status', width: 117 },
    ];`;
const newWFCols = `const svcCols = [
      { header: 'Type',           width: 130 },
      { header: 'Component Name',width: 210 },
      { header: 'Status',         width: 100 },
      { header: 'Startup Mode',   width:  70 },
    ];`;
c = c.split(oldWFCols).join(newWFCols);
console.log('Fixed WF table header:', c.includes('Startup Mode'));

// 9. Fix WF status color check - add DEACTIVATED_SYSTEM
const oldWFStatus = `const sc = s.status === 'RUNNING' ? COLORS.green : s.status === 'STOPPED' ? COLORS.red : COLORS.yellow;`;
const newWFStatus = `const sc = s.status === 'RUNNING' ? COLORS.green : s.status === 'DEACTIVATED_SYSTEM' || s.status === 'STOPPED' ? COLORS.red : COLORS.yellow;`;
c = c.split(oldWFStatus).join(newWFStatus);
console.log('Fixed WF status check:', c.includes('DEACTIVATED_SYSTEM'));

// 10. Add startup_mode to WF row
const oldWFRow = `      y = drawTableRow(doc, y, i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt, svcCols, [
        s.type,
        s.name,
        { text: s.status, color: sc },
      ]);`;
const newWFRow = `      y = drawTableRow(doc, y, i % 2 === 0 ? COLORS.bg : COLORS.tableRowAlt, svcCols, [
        s.type,
        s.name,
        { text: s.status, color: sc },
        s.startup_mode || '—',
      ]);`;
c = c.split(oldWFRow).join(newWFRow);
console.log('Added startup_mode to WF row:', c.includes('s.startup_mode'));

fs.writeFileSync('pdf-generator.js', c);
console.log('\nSaved. Verifying...');

const content = fs.readFileSync('pdf-generator.js', 'utf8');
console.log('=== PDF-GENERATOR.JS VERIFICATION ===');
console.log('mgr.actual:', content.includes('mgr.actual'));
console.log('mgr.node:', content.includes('mgr.node'));
console.log('mgr.running (should be FALSE):', content.includes('mgr.running'));
console.log('opp.actual:', content.includes('opp.actual'));
console.log('opp.target:', content.includes('opp.target'));
console.log('opp.current_processes (should be FALSE):', content.includes('opp.current_processes'));
console.log('Startup Mode:', content.includes('Startup Mode'));
console.log('DEACTIVATED_SYSTEM:', content.includes('DEACTIVATED_SYSTEM'));
console.log('s.startup_mode:', content.includes('s.startup_mode'));
console.log('oac.heap_mb (should be FALSE):', content.includes('oac.heap_mb'));
console.log('frm.servers (should be FALSE):', content.includes('frm.servers'));
console.log('Actual Processes:', content.includes('Actual Processes'));
console.log('Manager Name:', content.includes('Manager Name'));
console.log('Total length:', content.length);