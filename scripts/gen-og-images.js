#!/usr/bin/env node
/**
 * scripts/gen-og-images.js — Generate 1200×630 PNG OG images for each public page.
 *
 * Uses sharp + SVG templates. Run: node scripts/gen-og-images.js
 * Output: public/og/{page}.png
 *
 * Design: black background (#0a0a0c), gold accent stripe, wordmark top-left,
 * large title centered, subtitle line, tunevault.app bottom-right.
 */
'use strict';

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const OUT_DIR = path.join(__dirname, '..', 'public', 'og');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Design tokens (match site CSS vars) ──────────────────────────────────
const BG      = '#0a0a0c';
const SURFACE = '#111114';
const BORDER  = '#2a2a30';
const TEXT    = '#e8e8ed';
const DIM     = '#b8b8c8';
const GOLD    = '#f0a830';
const GOLD2   = '#f5c060';
const GREEN   = '#34d399';
const RED     = '#f87171';

// ── Page definitions ─────────────────────────────────────────────────────
const PAGES = [
  {
    slug:     'home',
    title:    'AI Oracle DBA Agent',
    subtitle: '100+ health checks, EBS-native, autonomous alerting. Zero install.',
    badge:    '100+ CHECKS',
    icon:     '▶',
  },
  {
    slug:     'pricing',
    title:    'Plans from $99/mo',
    subtitle: 'DB ($99/mo) · DB+EBS ($199/mo). Start free, no card required.',
    badge:    'PRICING',
    icon:     '$',
  },
  {
    slug:     'trust',
    title:    'Enterprise InfoSec',
    subtitle: 'Read-only. Outbound-only. No data leaves your network.',
    badge:    'SECURITY',
    icon:     '🔒',
  },
  {
    slug:     'security',
    title:    'Security & Trust',
    subtitle: 'Architecture, command whitelist, audit log schema, lockdown bundle.',
    badge:    'CISO REVIEW',
    icon:     '🛡',
  },
  {
    slug:     'vs-oem',
    title:    'TuneVault vs Oracle EM',
    subtitle: 'Side-by-side on setup time, firewall changes, EBS support, pricing.',
    badge:    'COMPARISON',
    icon:     '⚡',
  },
  {
    slug:     'sql-tuning',
    title:    'AI SQL Tuning',
    subtitle: 'Top resource consumers, index recommendations, query rewrites on demand.',
    badge:    'PERFORMANCE',
    icon:     '⚙',
  },
  {
    slug:     'demo',
    title:    'Live Demo — No Signup',
    subtitle: 'Run 100+ Oracle health checks on a live demo database. See results instantly.',
    badge:    'TRY NOW',
    icon:     '▶',
  },
  {
    slug:     'features',
    title:    '100+ Oracle Health Checks',
    subtitle: '15 categories: storage, performance, security, RMAN, SQL, EBS, and more.',
    badge:    'FEATURES',
    icon:     '✓',
  },
  {
    slug:     'blog',
    title:    'Oracle DBA Blog',
    subtitle: 'In-depth articles on health checks, ORA errors, tuning, and production diagnostics.',
    badge:    'BLOG',
    icon:     '✍',
  },
  {
    slug:     'about',
    title:    'Built by a DBA, for DBAs',
    subtitle: '20+ years Oracle EBS architecture distilled into an autonomous agent.',
    badge:    'ABOUT',
    icon:     '👤',
  },
  {
    slug:     'autonomous-remediation',
    title:    'Autonomous Remediation',
    subtitle: 'AI-powered auto-fixes with approval workflows and full audit trails.',
    badge:    'FEATURE',
    icon:     '⚡',
  },
  {
    slug:     'compare',
    title:    'TuneVault vs Datadog, Grafana, OEM',
    subtitle: 'Depth vs breadth: Oracle-native intelligence vs generic infrastructure monitoring.',
    badge:    'COMPARISON',
    icon:     '⚖',
  },
  {
    slug:     'performance-advisor',
    title:    'Performance Advisor',
    subtitle: 'ADDM + SQL Tuning Advisor, decoded for humans. No Enterprise Manager needed.',
    badge:    'PERFORMANCE',
    icon:     '⚙',
  },
  {
    slug:     'runbook',
    title:    'Oracle DBA Runbooks',
    subtitle: 'Production-tested step-by-step recovery guides for critical Oracle failures.',
    badge:    'RUNBOOKS',
    icon:     '📋',
  },
  {
    slug:     'default',
    title:    'Oracle Operational Intelligence',
    subtitle: 'DB & EBS, end to end. 200+ health checks. Diagnose. Tune. Control.',
    badge:    'TUNEVAULT',
    icon:     '▶',
  },
];

// ── SVG template ──────────────────────────────────────────────────────────

/**
 * Wrap long text into SVG tspan lines at ~maxChars per line.
 * Returns array of tspan elements.
 */
function wrapTitle(text, x, y, lineHeight, maxChars, fontSize, fill, weight) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (test.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  // vertically center multi-line block
  const totalH = lines.length * lineHeight;
  const startY = y - (totalH - lineHeight) / 2;

  return lines.map((line, i) =>
    `<text x="${x}" y="${startY + i * lineHeight}" ` +
    `font-family="Arial, Helvetica, sans-serif" ` +
    `font-size="${fontSize}" font-weight="${weight}" fill="${fill}" ` +
    `text-anchor="middle">${escXml(line)}</text>`
  ).join('\n');
}

function escXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSvg(page) {
  const W = 1200, H = 630;
  const CX = W / 2;          // center-x

  // split subtitle at ~55 chars
  const subWords = page.subtitle.split(' ');
  const subLines = [];
  let sub = '';
  for (const w of subWords) {
    const t = sub ? `${sub} ${w}` : w;
    if (t.length > 60 && sub) { subLines.push(sub); sub = w; } else { sub = t; }
  }
  if (sub) subLines.push(sub);

  const titleLines = (() => {
    const words = page.title.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (t.length > 24 && cur) { lines.push(cur); cur = w; } else { cur = t; }
    }
    if (cur) lines.push(cur);
    return lines;
  })();

  const titleLineH = 72;
  const titleTotalH = titleLines.length * titleLineH;
  const titleStartY = 280 - titleTotalH / 2;

  const subStartY = titleStartY + titleTotalH + 36;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="${BG}"/>
      <stop offset="100%" stop-color="${SURFACE}"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="${GOLD}"/>
      <stop offset="100%" stop-color="${GOLD2}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>

  <!-- Top gold stripe -->
  <rect x="0" y="0" width="${W}" height="6" fill="url(#goldGrad)" rx="0"/>

  <!-- Bottom border line -->
  <line x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" stroke="${BORDER}" stroke-width="1"/>

  <!-- Subtle grid -->
  <line x1="${CX}" y1="0" x2="${CX}" y2="${H}" stroke="${BORDER}" stroke-width="0.5" opacity="0.3"/>

  <!-- Wordmark top-left -->
  <text x="56" y="66"
    font-family="'JetBrains Mono', 'Courier New', monospace"
    font-size="20" font-weight="600" fill="${GOLD}">▶ TuneVault</text>

  <!-- Badge top-right -->
  <rect x="${W - 56 - 130}" y="42" width="130" height="30" rx="15" fill="${GOLD}" opacity="0.12"/>
  <text x="${W - 56 - 65}" y="62"
    font-family="Arial, Helvetica, sans-serif"
    font-size="12" font-weight="700" fill="${GOLD}" text-anchor="middle"
    letter-spacing="1">${escXml(page.badge)}</text>

  <!-- Title (multi-line, centered) -->
  ${titleLines.map((line, i) =>
    `<text x="${CX}" y="${titleStartY + i * titleLineH}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="62" font-weight="700" fill="${TEXT}" text-anchor="middle">${escXml(line)}</text>`
  ).join('\n  ')}

  <!-- Gold accent dot after title -->
  <rect x="${CX - 24}" y="${titleStartY + titleTotalH + 12}" width="48" height="4" rx="2" fill="url(#goldGrad)"/>

  <!-- Subtitle -->
  ${subLines.map((line, i) =>
    `<text x="${CX}" y="${subStartY + 28 + i * 36}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="24" fill="${DIM}" text-anchor="middle">${escXml(line)}</text>`
  ).join('\n  ')}

  <!-- Bottom domain -->
  <text x="${W - 56}" y="${H - 28}"
    font-family="'JetBrains Mono', 'Courier New', monospace"
    font-size="16" fill="${DIM}" text-anchor="end">tunevault.app</text>

  <!-- Bottom-left: small Oracle badge -->
  <text x="56" y="${H - 28}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14" fill="${DIM}">Oracle DBA Automation</text>
</svg>`;
}

// ── Blog post card ────────────────────────────────────────────────────────

function buildBlogSvg(title, excerpt) {
  const W = 1200, H = 630;
  const CX = W / 2;

  const titleWords = title.split(' ');
  const titleLines = [];
  let cur = '';
  for (const w of titleWords) {
    const t = cur ? `${cur} ${w}` : w;
    if (t.length > 36 && cur) { titleLines.push(cur); cur = w; } else { cur = t; }
  }
  if (cur) titleLines.push(cur);

  const titleLineH = 60;
  const titleTotalH = titleLines.length * titleLineH;
  const titleStartY = 260 - titleTotalH / 2;

  const subWords = (excerpt || '').split(' ');
  const subLines = [];
  let sub = '';
  for (const w of subWords) {
    const t = sub ? `${sub} ${w}` : w;
    if (t.length > 70 && sub) { subLines.push(sub); sub = w; } else { sub = t; }
    if (subLines.length >= 2) break;
  }
  if (sub && subLines.length < 3) subLines.push(sub);

  const subStartY = titleStartY + titleTotalH + 40;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="${BG}"/>
      <stop offset="100%" stop-color="${SURFACE}"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
      <stop offset="0%" stop-color="${GOLD}"/>
      <stop offset="100%" stop-color="${GOLD2}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bgGrad)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="url(#goldGrad)"/>
  <line x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" stroke="${BORDER}" stroke-width="1"/>
  <text x="56" y="66"
    font-family="'JetBrains Mono', 'Courier New', monospace"
    font-size="20" font-weight="600" fill="${GOLD}">▶ TuneVault Blog</text>
  <rect x="${W - 56 - 100}" y="42" width="100" height="30" rx="15" fill="${GOLD}" opacity="0.12"/>
  <text x="${W - 56 - 50}" y="62"
    font-family="Arial, Helvetica, sans-serif"
    font-size="12" font-weight="700" fill="${GOLD}" text-anchor="middle" letter-spacing="1">ARTICLE</text>
  ${titleLines.map((line, i) =>
    `<text x="${CX}" y="${titleStartY + i * titleLineH}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="52" font-weight="700" fill="${TEXT}" text-anchor="middle">${escXml(line)}</text>`
  ).join('\n  ')}
  <rect x="${CX - 24}" y="${titleStartY + titleTotalH + 12}" width="48" height="4" rx="2" fill="url(#goldGrad)"/>
  ${subLines.map((line, i) =>
    `<text x="${CX}" y="${subStartY + 28 + i * 34}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="22" fill="${DIM}" text-anchor="middle">${escXml(line)}</text>`
  ).join('\n  ')}
  <text x="${W - 56}" y="${H - 28}"
    font-family="'JetBrains Mono', 'Courier New', monospace"
    font-size="16" fill="${DIM}" text-anchor="end">tunevault.app</text>
  <text x="56" y="${H - 28}"
    font-family="Arial, Helvetica, sans-serif"
    font-size="14" fill="${DIM}">Oracle DBA Blog</text>
</svg>`;
}

// ── Generate images ───────────────────────────────────────────────────────

async function generatePage(page) {
  const svg = buildSvg(page);
  const outPath = path.join(OUT_DIR, `${page.slug}.png`);
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);
  console.log(`✓ ${page.slug}.png`);
}

async function main() {
  console.log('Generating OG images → public/og/\n');
  for (const page of PAGES) {
    await generatePage(page);
  }
  console.log(`\nDone. ${PAGES.length} images written to public/og/`);
}

// Only run generation when called directly (not when require()'d by blog.js)
if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

// Export for server-side blog post generation
module.exports = { buildBlogSvg, escXml };
