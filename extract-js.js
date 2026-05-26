const fs = require('fs');
const html = fs.readFileSync('public/report.html', 'utf8');
// Find the main script tag (the large one with all the functions)
const scriptMatch = html.match(/<script>([\r\n]*)?([\r\n\na-zA-Z0-9 `~!@#$%^&*()_+={}|[]\\:\";'<>?,.\/-]*?)([\r\n]*)?<\/script>/);
if (!scriptMatch) {
  console.log('No script found - trying different regex');
  process.exit(1);
}
const js = scriptMatch[2];
console.log('Extracted', js.length, 'chars of JS');
fs.writeFileSync('report-script-extracted.js', js);
console.log('Written to report-script-extracted.js');