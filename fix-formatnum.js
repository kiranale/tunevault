const fs = require('fs');
let content = fs.readFileSync('public/report.html', 'utf8');

// Fix formatNum to handle undefined/null
const old = `    function formatNum(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toString();
    }`;

const updated = `    function formatNum(n) {
        if (n == null || isNaN(n)) return '—';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
        return n.toString();
    }`;

if (content.includes(old)) {
    content = content.replace(old, updated);
    fs.writeFileSync('public/report.html', content);
    console.log('Fixed formatNum to handle undefined/null');
} else {
    console.log('formatNum pattern not found, checking if already fixed...');
    // Check the current state
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('function formatNum')) {
            console.log('Found at line', i+1, ':', lines[i]);
            console.log('Next line:', lines[i+1]);
            break;
        }
    }
}
