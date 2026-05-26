const fs = require('fs');
const lines = fs.readFileSync('public/report.html', 'utf8').split('\n');
const l = lines[550];
console.log('Has em-dash (U+2014):', l.includes('\u2014'));
console.log('Has en-dash (U+2013):', l.includes('\u2013'));
console.log('Char at pos 12:', l.charCodeAt(12), '=', JSON.stringify(l.charAt(12)));
// Find the em-dash position
const dashPos = l.indexOf('\u2014');
console.log('Em-dash at position:', dashPos);