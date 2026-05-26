/**
 * routes/test-harness.js — VirtualBox Oracle XE test harness guide + validator bundle.
 *
 * Owns: GET /admin/test-harness (HTML guide page)
 *       GET /api/test-harness/validator-bundle (zip download of validator scripts)
 * Does NOT own: Oracle connection logic, health check execution, auth session management.
 *
 * Admin-only. Same auth pattern as ebs-validation.js.
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { requireAdmin, requireAdminPage } = require('../middleware/auth');

const router = express.Router();

// ── GET /admin/test-harness — serve the guide page ────────────────────────────

router.get('/', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, '..', 'public', 'admin', 'test-harness.html');
  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlPath);
  }
  // Fallback: shouldn't happen in production
  res.status(404).send('test-harness.html not found');
});

// ── GET /api/test-harness/validator-bundle — zip download ────────────────────

router.get('/validator-bundle', requireAdmin, (req, res) => {
  const validatorDir = path.join(__dirname, '..', 'public', 'validator');

  // Files to bundle
  const files = [
    { name: 'run-local-validation.sh', path: path.join(validatorDir, 'run-local-validation.sh') },
    { name: 'local_validation.py',     path: path.join(validatorDir, 'local_validation.py') },
    { name: 'proxy.env.template',      path: path.join(validatorDir, 'proxy.env.template') },
    { name: 'oracle-proxy.py',         path: path.join(__dirname, '..', 'oracle-proxy.py') },
  ];

  // Check all files exist
  const missing = files.filter(f => !fs.existsSync(f.path));
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Bundle files missing',
      missing: missing.map(f => f.name)
    });
  }

  // Build a simple uncompressed tar archive in memory (no native deps needed)
  // Format: POSIX tar (512-byte blocks)
  const blocks = [];

  function padBuffer(buf, size) {
    if (buf.length >= size) return buf;
    const padded = Buffer.alloc(size, 0);
    buf.copy(padded);
    return padded;
  }

  function tarHeader(name, size, mode) {
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(name.substring(0, 99));
    nameBytes.copy(header, 0);
    // Mode
    Buffer.from(mode.toString(8).padStart(7, '0') + ' ').copy(header, 100);
    // UID, GID
    Buffer.from('0000000 ').copy(header, 108);
    Buffer.from('0000000 ').copy(header, 116);
    // Size (octal)
    Buffer.from(size.toString(8).padStart(11, '0') + ' ').copy(header, 124);
    // Modification time
    Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + ' ').copy(header, 136);
    // Type (regular file)
    header[156] = 0x30; // '0'
    // Magic
    Buffer.from('ustar  \0').copy(header, 257);
    // Compute checksum
    header.fill(0x20, 148, 156); // blank checksum field
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);
    return header;
  }

  for (const file of files) {
    const content = fs.readFileSync(file.path);
    const header  = tarHeader(file.name, content.length, 0o644);
    blocks.push(header);
    // Pad content to 512-byte boundary
    const padSize = 512 * Math.ceil(content.length / 512);
    blocks.push(padBuffer(content, padSize));
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0));

  const tarData = Buffer.concat(blocks);

  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-validator.tar"');
  res.setHeader('Content-Length', tarData.length);
  res.send(tarData);
});

module.exports = router;
