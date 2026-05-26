'use strict';
/**
 * patch-og-dimensions.js
 * Adds og:image:width, og:image:height, og:image:type, og:image:alt
 * to all public HTML pages that have og:image but lack the dimension tags.
 * Also ensures twitter:image exists where og:image exists.
 *
 * Run: node scripts/patch-og-dimensions.js
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Alt text map by image slug (derived from og:image URL)
const ALT_BY_SLUG = {
  'home': 'TuneVault — AI Oracle DBA Agent with 100+ health checks',
  'pricing': 'TuneVault pricing — DB $99/mo, DB+EBS $199/mo',
  'trust': 'TuneVault enterprise security — read-only, outbound-only Oracle monitoring',
  'security': 'TuneVault security and trust — command whitelist and audit trail',
  'vs-oem': 'TuneVault vs Oracle Enterprise Manager comparison',
  'sql-tuning': 'TuneVault AI SQL Tuning — top resource consumers and index recommendations',
  'demo': 'TuneVault live demo — run 100+ Oracle health checks instantly',
  'features': 'TuneVault features — 100+ Oracle health checks across 15 categories',
  'blog': 'TuneVault Oracle DBA Blog',
  'about': 'About TuneVault — built by a DBA for DBAs',
  'autonomous-remediation': 'TuneVault autonomous remediation — AI-powered auto-fixes with approval workflows',
  'compare': 'TuneVault vs Datadog, Grafana, Oracle EM comparison',
  'performance-advisor': 'TuneVault Performance Advisor — ADDM and SQL Tuning decoded for humans',
  'runbook': 'Oracle DBA Runbook — TuneVault production-tested recovery guide',
  'default': 'TuneVault — Oracle Operational Intelligence',
};

function getAltForImage(imageUrl) {
  // Extract slug from URL like https://tunevault.app/og/home.png
  const match = imageUrl.match(/\/og\/([^.]+)\.png/);
  if (match) return ALT_BY_SLUG[match[1]] || 'TuneVault — Oracle DBA Automation';
  return 'TuneVault — Oracle DBA Automation';
}

function collectHtmlFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectHtmlFiles(full, results);
    } else if (entry.name.endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

const htmlFiles = collectHtmlFiles(PUBLIC_DIR);
let patched = 0;
let skipped = 0;

for (const fpath of htmlFiles) {
  let content = fs.readFileSync(fpath, 'utf8');

  // Skip files without og:image
  if (!content.includes('og:image')) { skipped++; continue; }

  // Skip files that already have og:image:width (already patched)
  if (content.includes('og:image:width')) { skipped++; continue; }

  // Extract the og:image URL
  const ogImageMatch = content.match(/<meta property="og:image" content="([^"]+)"/);
  if (!ogImageMatch) { skipped++; continue; }

  const imageUrl = ogImageMatch[1];
  const alt = getAltForImage(imageUrl);

  // Insert dimension/type/alt tags immediately after the og:image line
  const ogImageLine = `<meta property="og:image" content="${imageUrl}">`;
  const dimBlock = `<meta property="og:image" content="${imageUrl}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:alt" content="${alt}">`;

  content = content.replace(ogImageLine, dimBlock);

  // Also ensure twitter:image is PNG (not SVG) if it references the old og-image.svg
  content = content.replace(
    /content="https:\/\/tunevault\.app\/og-image\.svg"/g,
    `content="${imageUrl}"`
  );

  fs.writeFileSync(fpath, content);
  const rel = path.relative(PUBLIC_DIR, fpath);
  console.log(`PATCHED: ${rel}`);
  patched++;
}

console.log(`\nDone. ${patched} files patched, ${skipped} skipped.`);
