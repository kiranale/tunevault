'use strict';
const fs = require('fs');
const path = require('path');

const RUNBOOKS_DIR = path.join(__dirname, '..', 'public', 'runbooks');
const files = fs.readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.html'));

const INSERT_AFTER = '    <meta property="og:site_name" content="TuneVault">';
const OG_IMAGE_BLOCK = `    <meta property="og:image" content="https://tunevault.app/og/runbook.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="Oracle DBA Runbook — TuneVault production-tested recovery guide">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="https://tunevault.app/og/runbook.png">`;

const ALT_INSERT = '    <meta property="og:type" content="article">';

let patched = 0;
for (const file of files) {
  const fpath = path.join(RUNBOOKS_DIR, file);
  let content = fs.readFileSync(fpath, 'utf8');

  if (content.includes('og:image')) {
    console.log(`SKIP (already has og:image): ${file}`);
    continue;
  }

  if (content.includes(INSERT_AFTER)) {
    content = content.replace(INSERT_AFTER, INSERT_AFTER + '\n' + OG_IMAGE_BLOCK);
    fs.writeFileSync(fpath, content);
    console.log(`PATCHED: ${file}`);
    patched++;
  } else if (content.includes(ALT_INSERT)) {
    content = content.replace(ALT_INSERT, ALT_INSERT + '\n' + OG_IMAGE_BLOCK);
    fs.writeFileSync(fpath, content);
    console.log(`PATCHED (via og:type): ${file}`);
    patched++;
  } else {
    console.log(`SKIP (no anchor found): ${file}`);
  }
}

console.log(`\nDone. ${patched} files patched.`);
