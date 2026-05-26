const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// Find the WF status TD closing and add startup_mode TD before </tr>
// The WF row ends with: <td style=color:...>${esc(s.status)}</td>\n                </tr>
// We need to insert <td>${esc(s.startup_mode) || '—'}</td> before </tr>

// Look for the exact line ending pattern
const lines = c.split('\n');
let lineIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('s.status') && lines[i].includes('DEACTIVATED_SYSTEM')) {
    lineIdx = i;
    break;
  }
}
console.log('WF status line index:', lineIdx);
if (lineIdx !== -1) {
  console.log('Current line:', JSON.stringify(lines[lineIdx]));
  console.log('Next line:', JSON.stringify(lines[lineIdx + 1]));
}

// The status TD line ends with: >${esc(s.status)}</td>
// Next line is:                 </tr>`).join('')}
// We need to insert a startup_mode TD between them

// Strategy: find the </td> at end of status TD and add startup_mode TD after it
const statusLineIdx = lineIdx;
const statusLine = lines[statusLineIdx];

// Find the closing of the status TD
const tdEnd = statusLine.lastIndexOf('</td>');
console.log('TD end index in line:', tdEnd);

if (tdEnd !== -1) {
  // Insert the startup_mode TD after </td>
  const before = statusLine.substring(0, tdEnd + 5); // include </td>
  const after = statusLine.substring(tdEnd + 5);
  const newLine = before + '\n                    <td style=\u0022font-size:12px;color:var(--text-dim)\u0022>${esc(s.startup_mode) || \u0027\u2014\u0027}</td>' + after;
  lines[statusLineIdx] = newLine;
  console.log('Updated line:', JSON.stringify(lines[statusLineIdx]));
  c = lines.join('\n');
  fs.writeFileSync('public/report.html', c);
  console.log('Done. Verifying...');
  const newContent = fs.readFileSync('public/report.html', 'utf8');
  console.log('Startup Mode in file?', newContent.includes('s.startup_mode'));
} else {
  console.log('Could not find </td> in status line');
}