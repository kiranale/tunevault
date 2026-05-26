const fs = require('fs');
let c = fs.readFileSync('public/report.html', 'utf8');

// Current broken state:
// Line 570: </svg'Detailed XLSX>;
// Line 577: </svg'Summary PDF>;
//
// These strings have:
// - A rogue ' character that was put in place of > in </svg> (from earlier broken fix)
// - A >; at the end that should be ';
//
// Fix strategy:
// 1. Find the exact bad strings in the file
// 2. Replace '> at end (which is > from </svg> replaced with ') with > (put it back)
// 3. Replace >; at end with ';

const bad1 = '</svg' + String.fromCharCode(39) + 'Detailed XLSX>;';  // </svg'Detailed XLSX>;
const good1 = '</svg>Detailed XLSX' + String.fromCharCode(39) + ';';  // </svg>Detailed XLSX';

const bad2 = '</svg' + String.fromCharCode(39) + 'Summary PDF>;';
const good2 = '</svg>Summary PDF' + String.fromCharCode(39) + ';';

console.log('Looking for:', JSON.stringify(bad1));
console.log('Replace with:', JSON.stringify(good1));

let idx1 = c.indexOf(bad1);
if (idx1 !== -1) {
    console.log('Found bad1 at', idx1);
    c = c.substring(0, idx1) + good1 + c.substring(idx1 + bad1.length);
} else {
    console.log('bad1 not found');
}

let idx2 = c.indexOf(bad2);
if (idx2 !== -1) {
    console.log('Found bad2 at', idx2);
    c = c.substring(0, idx2) + good2 + c.substring(idx2 + bad2.length);
} else {
    console.log('bad2 not found');
}

fs.writeFileSync('public/report.html', c);
console.log('Done. Verifying...');
const lines = fs.readFileSync('public/report.html', 'utf8').split('\n');
console.log('Line 570:', JSON.stringify(lines[569].slice(-30)));
console.log('Line 577:', JSON.stringify(lines[576].slice(-30)));