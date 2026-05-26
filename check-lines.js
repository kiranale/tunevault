const fs = require('fs');
const lines = fs.readFileSync('public/report.html', 'utf8').split('\n');
for (let i = 550; i <= 555; i++) {
    console.log(i + ': ' + JSON.stringify(lines[i-1]));
}