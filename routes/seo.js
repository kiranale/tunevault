/**
 * routes/seo.js — Sitemap and crawlability infrastructure.
 *
 * Owns: GET /sitemap.xml (dynamic, 1h cached), GET /robots.txt (static with explicit
 *       crawler allowances served here so Express intercepts before express.static).
 * Does NOT own: llms.txt, ai-plugin.json (see routes/ai-discoverability.js),
 *               canonical meta tags (managed per-page in public/*.html),
 *               blog article pages (see routes/blog.js).
 *
 * Why dynamic sitemap: blog posts come from the DB, so slugs can't be hardcoded.
 * 1-hour cache keeps GSC happy without hammering the DB on every crawl.
 *
 * hreflang: Not added yet (English-only, single region). When multi-region support
 * ships, add <xhtml:link rel="alternate" hreflang="XX" href="..."/> inside each
 * <url> block and declare xmlns:xhtml in the <urlset> opening tag.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { listPosts } = require('../db/blog');

const SITE_URL = process.env.APP_URL || 'https://tunevault.app';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory sitemap cache — avoids DB hit on every crawl
let sitemapCache = null;
let sitemapCachedAt = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Static pages — ordered by crawl priority
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_PAGES = [
  // Core marketing
  { path: '/',                                       priority: '1.0', changefreq: 'weekly'  },
  { path: '/pricing',                                priority: '0.9', changefreq: 'weekly'  },
  { path: '/vs-oem',                                 priority: '0.8', changefreq: 'monthly' },
  { path: '/compare',                                priority: '0.8', changefreq: 'monthly' },
  { path: '/features',                               priority: '0.8', changefreq: 'monthly' },
  { path: '/sample-report',                          priority: '0.8', changefreq: 'monthly' },
  { path: '/request-health-check',                   priority: '0.8', changefreq: 'monthly' },
  { path: '/blog',                                   priority: '0.8', changefreq: 'weekly'  },
  // Feature deep-dives
  { path: '/features/sql-tuning',                    priority: '0.7', changefreq: 'monthly' },
  { path: '/features/fleet-management',              priority: '0.7', changefreq: 'monthly' },
  { path: '/features/autonomous-remediation',        priority: '0.7', changefreq: 'monthly' },
  // Comparison & trust
  { path: '/about',                                  priority: '0.7', changefreq: 'monthly' },
  { path: '/trust',                                  priority: '0.7', changefreq: 'monthly' },
  { path: '/security',                               priority: '0.7', changefreq: 'monthly' },
  { path: '/architecture',                           priority: '0.7', changefreq: 'monthly' },
  // Content & resources
  { path: '/sql-tuning',                             priority: '0.7', changefreq: 'monthly' },
  { path: '/docs/oracle-setup',                      priority: '0.7', changefreq: 'monthly' },
  { path: '/api-docs',                               priority: '0.6', changefreq: 'monthly' },
  // Runbooks — Oracle DBA emergency recovery guides
  { path: '/resources/runbooks',                             priority: '0.8', changefreq: 'monthly' },
  { path: '/resources/runbooks/tablespace-full-recovery',    priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/archive-log-destination-full',priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/opp-tuning-ebs',             priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/workflow-mailer-smtp-recovery',priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/rman-backup-failure-triage',  priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/adop-cutover-rollback',       priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/oracle-db-upgrade-triage',    priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/ebs-upgrade-triage',          priority: '0.7', changefreq: 'monthly' },
  { path: '/resources/runbooks/agent-connection-failure',     priority: '0.7', changefreq: 'monthly' },
  // AI discoverability (low priority; referenced for completeness)
  { path: '/llms.txt',                               priority: '0.5', changefreq: 'monthly' },
  // Auth
  { path: '/login',                                  priority: '0.4', changefreq: 'yearly'  },
  // Legal
  { path: '/privacy',                                priority: '0.3', changefreq: 'yearly'  },
  { path: '/terms',                                  priority: '0.3', changefreq: 'yearly'  },
];

const LASTMOD = '2026-05-17'; // bump on meaningful content changes — replaced legacy tunnel runbook with agent-connection-failure

function buildXmlEntry({ loc, lastmod, changefreq, priority }) {
  return `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

async function generateSitemap() {
  // Fetch published blog posts for dynamic URLs
  let blogEntries = [];
  try {
    const posts = await listPosts();
    blogEntries = posts
      .filter(p => p.published_at)
      .map(p => buildXmlEntry({
        loc: `${SITE_URL}/blog/${p.slug}`,
        lastmod: p.updated_at
          ? new Date(p.updated_at).toISOString().slice(0, 10)
          : (p.published_at ? new Date(p.published_at).toISOString().slice(0, 10) : LASTMOD),
        changefreq: 'monthly',
        priority: '0.7',
      }));
  } catch (_) {
    // Non-fatal — sitemap still emits without blog URLs
  }

  const staticEntries = STATIC_PAGES.map(p => buildXmlEntry({
    loc: `${SITE_URL}${p.path}`,
    lastmod: LASTMOD,
    changefreq: p.changefreq,
    priority: p.priority,
  }));

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Core marketing + public pages -->
${staticEntries.join('\n')}
  <!-- Blog articles (dynamic — from DB) -->
${blogEntries.join('\n')}
</urlset>`;
}

// GET /sitemap.xml — dynamic, 1h in-memory cache, valid application/xml
router.get('/sitemap.xml', async (req, res) => {
  const now = Date.now();
  if (!sitemapCache || now - sitemapCachedAt > CACHE_TTL_MS) {
    sitemapCache = await generateSitemap();
    sitemapCachedAt = now;
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
  res.send(sitemapCache);
});

module.exports = router;
