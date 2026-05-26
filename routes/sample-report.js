/**
 * routes/sample-report.js — public sample report page + email lead capture + PDF download.
 *
 * Owns: GET /sample-report (serves HTML), POST /api/sample-report/lead (email capture),
 *       GET /api/sample-report/pdf (streams sample PDF on demand, cached in memory).
 * Does NOT own: auth, payments, health check execution, analytics pipeline.
 */

'use strict';

const express = require('express');
const path    = require('path');
const router  = express.Router();

const { insertSampleReportLead } = require('../db/sample-report-leads');
const { generateHealthCheckPDF } = require('../pdf-generator');
const {
  getDemoMetrics,
  getSummaryScores,
  getDemoAnalysis,
  getDemoExecutiveSummary,
  getDemoRecommendations,
} = require('../demo-data');

// PDF cached in memory after first generation — avoids re-running pdfkit on every hit
let _cachedPdfBuffer = null;

// ---------------------------------------------------------------------------
// GET /sample-report — public, no auth required
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sample-report.html'));
});

// ---------------------------------------------------------------------------
// POST /api/sample-report/lead — optional email capture before PDF download
// Returns { ok: true, pdfUrl } on success.
// Does NOT require auth.
// ---------------------------------------------------------------------------
router.post('/lead', async (req, res) => {
  const { email } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const cleanEmail = email.trim().toLowerCase().slice(0, 254);

  try {
    const ip       = req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const referrer = req.headers['referer'] || req.headers['referrer'] || null;
    await insertSampleReportLead({ email: cleanEmail, ip, referrer });
  } catch (err) {
    // Never block the download — lead capture is always optional
    console.error('[sample-report] lead insert error:', err.message);
  }

  res.json({ ok: true, pdfUrl: '/sample-report/pdf' });
});

// ---------------------------------------------------------------------------
// GET /api/sample-report/pdf — generate and stream the sample PDF
// Public, no auth. Cached in memory after first generation (~1-2s).
// ---------------------------------------------------------------------------
router.get('/pdf', async (req, res) => {
  try {
    if (_cachedPdfBuffer) {
      return sendPdf(res, _cachedPdfBuffer);
    }

    const metrics = getDemoMetrics();
    const scores  = getSummaryScores();

    // Build data object matching generateHealthCheckPDF expectations
    const data = {
      connection_name:    'prod-ebs-01',
      connection_id:      'demo',
      db_version:         '19.21.0.0.0 — Oracle Database 19c Enterprise Edition',
      platform:           'Linux x86 64-bit',
      checked_at:         new Date().toISOString(),
      is_demo:            true,
      score:              67,
      metrics:            metrics,
      scores:             scores,
      ai_analysis:        getDemoAnalysis(),
      summary_text:       getDemoExecutiveSummary(),
      top_action:         'Add USERS datafile now, then schedule RMAN full backup for tonight.',
      ai_recommendations: getDemoRecommendations(),
    };

    // Collect PDF chunks into buffer
    const chunks = [];
    const doc = generateHealthCheckPDF(data);

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      _cachedPdfBuffer = Buffer.concat(chunks);
      sendPdf(res, _cachedPdfBuffer);
    });
    doc.on('error', (err) => {
      console.error('[sample-report] pdf generation error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed' });
    });
  } catch (err) {
    console.error('[sample-report] pdf route error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed' });
  }
});

function sendPdf(res, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-sample-report.pdf"');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(buffer);
}

module.exports = router;
