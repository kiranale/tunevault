const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// Fix OACore section: replace the entire section from html += ` (OACore) to the closing } with a placeholder
// The OACore section currently has:
// - Header: ${statusDot('ok')} OACore (OA Framework) Heap  (fixed by fix-all.js)
// - Body: ${statusTag(oac.status)}, ${oac.heap_mb != null ? ...}  (BROKEN - oac is undefined)
// - Closes with `;</div>`; then } (closing old if(oac) block)

// Strategy: find the OACore section (from html += ` to the closing }) and replace with placeholder
// Unique markers: OACore uses `<h3>${statusDot('ok')} OACore` (which is correct)
// We need to find where the section body (with oac.* references) starts and ends

// The OACore section starts at: html += `
// After OACore header (line with ${statusDot('ok')} OACore)
// The next lines contain oac.status, oac.heap_mb, etc.
// It ends at `;</div>`; followed by a } then the next section

// Let me find the unique start of the OACore section body (the statusTag line)
// This is: ${statusTag(oac.status)}
// And it ends at the } that closes the if(oac) block

// Search for the specific broken pattern in OACore
const oacoreStatusTag = '${statusTag(oac.status)}';
const oacoreIdx = c.indexOf(oacoreStatusTag);
if (oacoreIdx === -1) {
  console.log('OACore statusTag not found');
} else {
  console.log('OACore statusTag at:', oacoreIdx);

  // Find the start of the OACore section body - look backwards for html += `
  const searchStart = Math.max(0, oacoreIdx - 200);
  const htmlStart = c.lastIndexOf('html += `\n        <div class=\u0022card\u0022', oacoreIdx);
  console.log('OACore html block starts at:', htmlStart);

  // Find the end - look for the closing } of the if(oac) block
  // It should be the `}` that comes after the `;</div>` of the OACore section
  const check4Idx = c.indexOf('// ── Check 4: Forms');
  console.log('Check 4: Forms at:', check4Idx);

  // The OACore section ends with `;</div>`; then `}` then `// ── Check 4: Forms`
  // Let me search for the `}` that closes the if(oac) block
  const endSearchStart = oacoreIdx + 100;
  const endSearchEnd = check4Idx;

  // Look for `</div>`; followed by `}` (the closing of the if block)
  const oacoreEnd = c.indexOf('</div>`;\n        }\n\n        // ── Check 4: Forms', endSearchStart, endSearchEnd);
  console.log('OACore end pattern at:', oacoreEnd);

  // Also check without the blank line
  const oacoreEnd2 = c.indexOf('</div>`;\n        }\n        // ── Check 4: Forms', endSearchStart, endSearchEnd);
  console.log('Oacore end pattern2 at:', oacoreEnd2);

  // Try to find the `}` that closes the if(oac)
  const closeBraceSearch = c.indexOf('        }\n\n        // ── Check 4: Forms', endSearchStart, endSearchEnd);
  console.log('Close brace pattern at:', closeBraceSearch);

  if (closeBraceSearch !== -1) {
    // The section starts at htmlStart and ends at closeBraceSearch + length of `}`
    // Replace with placeholder
    const sectionStart = htmlStart;
    // Find the beginning of the line containing htmlStart
    const lineStart = c.lastIndexOf('\n', sectionStart - 1) + 1;
    // Find the end - the `}` that closes the if(oac) block
    const sectionEnd = closeBraceSearch + '        }'.length;

    console.log('Replacing lines from', lineStart, 'to', sectionEnd);
    const before = c.substring(0, lineStart);
    const after = c.substring(sectionEnd);

    // Build the placeholder - use a backtick template but construct carefully
    const statusDotExpr = String.fromCharCode(36) + '{statusDot(\u0027ok\u0027)}';
    const placeholder = [
      '        html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>' + statusDotExpr + ' OACore (OA Framework) Heap</h3>\n            </div>\n            <div style=\u0022padding:20px 24px;text-align:center\u0022>\n                <div style=\u0022font-size:28px;margin-bottom:8px\u0022>🔌</div>\n                <div style=\u0022font-size:14px;color:var(--text-dim)\u0022>Available with OS Agent (optional add-on)</div>\n                <div style=\u0022font-size:13px;color:var(--text-dim);margin-top:4px\u0022>Install the OS Agent to monitor OACore JVM heap, active sessions, and receive tuning recommendations.</div>\n            </div>\n        </div>\u0060;',
      ''
    ].join('\n');

    c = before + placeholder + after;
    console.log('Replaced OACore section');
  } else {
    console.log('Could not find OACore section end');
    console.log('Searching manually...');
    const sectionContent = c.substring(oacoreIdx, check4Idx);
    console.log('Section content sample:', JSON.stringify(sectionContent.slice(0, 100)));
  }
}

// Now fix Forms section similarly - find frm.status reference
const frmStatusTag = 'frm.status !==';
const frmIdx = c.indexOf(frmStatusTag);
console.log('Forms frm.status at:', frmIdx);

if (frmIdx !== -1) {
  // Find the Forms section start (the html += ` after Forms comment)
  const formsCommentIdx = c.indexOf('// ── Check 4: Forms');
  const formsHtmlStart = c.indexOf('html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>${statusDot(\u0027ok\u0027)} Forms Server</h3>', formsCommentIdx);
  console.log('Forms html block at:', formsHtmlStart);

  if (formsHtmlStart !== -1) {
    // Find the end - Forms section ends before Apache section
    const wfMailerComment = '// ── Check 5: Workflow Mailer';
    const wfMailerIdx = c.indexOf(wfMailerComment, frmIdx);
    console.log('Workflow Mailer section at:', wfMailerIdx);

    if (wfMailerIdx !== -1) {
      // The Forms section ends at the `</div>`; before the Workflow Mailer section
      const formsEndSearch = c.indexOf('</div>`;\n        }\n\n        // ── Check 5:', frmIdx, wfMailerIdx);
      console.log('Forms end pattern at:', formsEndSearch);

      if (formsEndSearch !== -1) {
        const sectionStart = c.lastIndexOf('\n', formsHtmlStart - 1) + 1;
        const sectionEnd = formsEndSearch + '</div>`;'.length;

        const before = c.substring(0, sectionStart);
        const after = c.substring(sectionEnd);

        const statusDotExpr2 = String.fromCharCode(36) + '{statusDot(\u0027ok\u0027)}';
        const placeholder = [
          '        html += `\n        <div class=\u0022card\u0022 style=\u0022margin-bottom:16px\u0022>\n            <div style=\u0022display:flex;justify-content:space-between;align-items:center;margin-bottom:16px\u0022>\n                <h3>' + statusDotExpr2 + ' Forms Server</h3>\n            </div>\n            <div style=\u0022padding:20px 24px;text-align:center\u0022>\n                <div style=\u0022font-size:28px;margin-bottom:8px\u0022>🔌</div>\n                <div style=\u0022font-size:14px;color:var(--text-dim)\u0022>Available with OS Agent (optional add-on)</div>\n                <div style=\u0022font-size:13px;color:var(--text-dim);margin-top:4px\u0022>Install the OS Agent to monitor Forms server count, active sessions, and receive sizing recommendations.</div>\n            </div>\n        </div>\u0060;',
          ''
        ].join('\n');

        c = before + placeholder + after;
        console.log('Replaced Forms section');
      }
    }
  }
}

fs.writeFileSync('public/report.html', c);
console.log('Saved. Verifying...');

const content = fs.readFileSync('public/report.html', 'utf8');
console.log('oac.status in file:', content.includes('oac.status'));
console.log('frm.status in file:', content.includes('frm.status'));
console.log('oac.heap_mb in file:', content.includes('oac.heap_mb'));
console.log('frm.servers in file:', content.includes('frm.servers'));
console.log('OACore placeholder:', content.includes('Available with OS Agent'));
console.log('Total length:', content.length);