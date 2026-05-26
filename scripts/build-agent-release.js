/**
 * scripts/build-agent-release.js — generate agent/release.json with sha256 of the live agent tarball.
 *
 * Owns: computing sha256 of the tarball that /downloads/agent-pkg.tar.gz actually serves,
 *       writing agent/release.json so the route + install.sh can verify integrity.
 * Does NOT own: the tarball format, the download route, or version bumping (that lives in agent/__init__.py).
 *
 * Run: node scripts/build-agent-release.js
 * Called at build time or manually after bumping agent/__init__.py VERSION.
 */

'use strict';

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Read current agent version from agent/__init__.py
function readAgentVersion() {
  const initPath = path.join(ROOT, 'agent', '__init__.py');
  const content = fs.readFileSync(initPath, 'utf8');
  const match = content.match(/VERSION\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error('Cannot find VERSION in agent/__init__.py');
  return match[1];
}

// Build the same tarball that downloads.js serves, compute sha256
function computeTarballSha256() {
  console.log('[build-agent-release] Building agent tarball...');
  const tarball = execSync(`tar -czf - -C "${ROOT}" agent`, {
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');
  console.log(`[build-agent-release] Tarball size: ${tarball.length} bytes`);
  return sha256;
}

function main() {
  const version = readAgentVersion();
  const sha256 = computeTarballSha256();
  const buildTime = new Date().toISOString();

  const release = {
    version,
    build_time: buildTime,
    sha256,
    python_min: '3.6',
    oel_supported: ['7.x', '8.x', '9.x'],
    changelog_url: 'https://tunevault.app/agent/changelog',
  };

  const outPath = path.join(ROOT, 'agent', 'release.json');
  fs.writeFileSync(outPath, JSON.stringify(release, null, 2) + '\n');
  console.log(`[build-agent-release] Wrote ${outPath}`);
  console.log(`  version:    ${version}`);
  console.log(`  build_time: ${buildTime}`);
  console.log(`  sha256:     ${sha256}`);
}

main();
