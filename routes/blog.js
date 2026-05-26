/**
 * routes/blog.js — Blog index and article pages.
 *
 * Owns: GET /blog (curated external articles page), GET /blog/:slug (article), GET /api/blog/posts (JSON API).
 * Does NOT own: user auth, health checks, payments, DB connection.
 *
 * GET /blog serves public/blog.html — a static curated articles page linking to linuxappsdba.blogspot.com.
 * GET /blog/:slug serves individual DB-backed article pages (legacy path, kept for SEO continuity).
 * Mounted at / in server.js (so /blog and /blog/:slug work directly).
 */

'use strict';

const express = require('express');
const path = require('path');
const { listPosts, getPostBySlug } = require('../db/blog');

const router = express.Router();

const SITE_URL = process.env.APP_URL || 'https://tunevault.app';

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Convert markdown-ish content to HTML (headings, code blocks, paragraphs, bold, lists) */
function markdownToHtml(md) {
  if (!md) return '';
  let html = md;

  // Fenced code blocks (```lang ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.trim())}</code></pre>`;
  });

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Unordered lists (lines starting with - or *)
  html = html.replace(/((?:^[*-] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[*-] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Paragraphs — blank-line-separated blocks not already wrapped in a tag
  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol|pre|hr|blockquote)/.test(block)) return block;
    // Replace single newlines within paragraph with <br>
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

// ─── Blog index — serves static curated articles page ─────────────────────

router.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/blog.html'));
});

// ─── Blog article ─────────────────────────────────────────────────────────

router.get('/blog/:slug', async (req, res) => {
  try {
    const post = await getPostBySlug(req.params.slug);
    if (!post) {
      return res.status(404).send('Post not found');
    }

    const bodyHtml = markdownToHtml(post.content);
    const publishedIso = new Date(post.published_at).toISOString();
    const canonicalUrl = `${SITE_URL}/blog/${encodeURIComponent(post.slug)}`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(post.title)} — TuneVault</title>
  <meta name="description" content="${escapeHtml(post.excerpt)}">
  <meta name="keywords" content="Oracle DBA, Oracle EBS, ORA errors, Oracle health check, database performance">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:title" content="${escapeHtml(post.title)}">
  <meta property="og:description" content="${escapeHtml(post.excerpt)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${SITE_URL}/og/blog.png">
  <meta property="og:site_name" content="TuneVault">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(post.title)}">
  <meta name="twitter:description" content="${escapeHtml(post.excerpt)}">
  <meta name="twitter:image" content="${SITE_URL}/og/blog.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/favicon.svg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0a;
      --surface: #111;
      --border: #1e1e1e;
      --text: #e8e8e8;
      --text-dim: #666;
      --accent: #f0a830;
      --code-bg: #161616;
    }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; min-height: 100vh; }
    nav { display: flex; align-items: center; justify-content: space-between; padding: 0 40px; height: 60px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 100; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; color: var(--text); text-decoration: none; }
    .logo-icon { width: 28px; height: 28px; background: var(--accent); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #000; }
    .nav-right { display: flex; align-items: center; gap: 20px; }
    .nav-cta { background: var(--accent); color: #000; font-weight: 600; font-size: 13px; padding: 7px 16px; border-radius: 6px; text-decoration: none; transition: opacity 0.2s; }
    .nav-cta:hover { opacity: 0.85; }
    main { max-width: 720px; margin: 0 auto; padding: 60px 24px 80px; }
    .post-header { margin-bottom: 48px; }
    .post-meta { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }
    .post-header h1 { font-size: 2.2rem; font-weight: 700; line-height: 1.3; margin-bottom: 20px; }
    .post-excerpt-text { font-size: 1.1rem; color: var(--text-dim); line-height: 1.7; padding-bottom: 32px; border-bottom: 1px solid var(--border); }
    /* Article body */
    .article-body h2 { font-size: 1.5rem; font-weight: 700; margin: 48px 0 16px; color: var(--text); }
    .article-body h3 { font-size: 1.15rem; font-weight: 700; margin: 32px 0 12px; color: var(--accent); }
    .article-body p { margin-bottom: 16px; color: var(--text); }
    .article-body strong { color: var(--text); }
    .article-body a { color: var(--accent); }
    .article-body ul, .article-body ol { margin: 16px 0 16px 24px; }
    .article-body li { margin-bottom: 6px; }
    .article-body pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 20px 24px; overflow-x: auto; margin: 24px 0; }
    .article-body code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 13px; color: #b8d4ff; }
    .article-body pre code { color: #b8d4ff; }
    .article-body p code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: var(--accent); }
    .article-body hr { border: none; border-top: 1px solid var(--border); margin: 40px 0; }
    .cta-box { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 32px; margin-top: 60px; text-align: center; }
    .cta-box h3 { font-size: 1.2rem; margin-bottom: 10px; }
    .cta-box p { color: var(--text-dim); font-size: 0.95rem; margin-bottom: 24px; }
    .cta-btn { display: inline-block; background: var(--accent); color: #000; font-weight: 700; font-size: 15px; padding: 12px 28px; border-radius: 8px; text-decoration: none; transition: opacity 0.2s; }
    .cta-btn:hover { opacity: 0.85; }
    .back-link { font-size: 13px; color: var(--text-dim); text-decoration: none; display: inline-flex; align-items: center; gap: 6px; margin-bottom: 40px; }
    .back-link:hover { color: var(--accent); }
    .author-aside { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px 28px; margin-top: 48px; display: flex; align-items: flex-start; gap: 20px; }
    .author-aside-avatar { flex-shrink: 0; width: 52px; height: 52px; border-radius: 50%; background: var(--accent); color: #000; font-weight: 800; font-size: 15px; display: flex; align-items: center; justify-content: center; letter-spacing: 0.02em; }
    .author-aside-body { flex: 1; min-width: 0; }
    .author-aside-name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
    .author-aside-bio { font-size: 13px; color: var(--text-dim); line-height: 1.6; margin-bottom: 12px; }
    .author-aside-links { display: flex; gap: 16px; flex-wrap: wrap; }
    .author-aside-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-dim); text-decoration: none; transition: color 0.2s; }
    .author-aside-link:hover { color: var(--accent); }
    footer { border-top: 1px solid var(--border); padding: 24px 40px; display: flex; justify-content: space-between; align-items: center; color: var(--text-dim); font-size: 13px; }
    footer a { color: inherit; text-decoration: none; }
    footer a:hover { color: var(--accent); }
    @media (max-width: 600px) { nav { padding: 0 16px; } main { padding: 40px 16px 60px; } .post-header h1 { font-size: 1.6rem; } footer { padding: 20px 16px; flex-direction: column; gap: 8px; text-align: center; } .author-aside { flex-direction: column; gap: 14px; } }
  </style>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": "${escapeHtml(post.title).replace(/"/g, '\\"')}",
    "description": "${escapeHtml(post.excerpt).replace(/"/g, '\\"')}",
    "url": "${canonicalUrl}",
    "datePublished": "${publishedIso}",
    "dateModified": "${publishedIso}",
    "author": { "@type": "Person", "name": "Kiran Kumar Ale", "url": "https://www.linkedin.com/in/kirankumarale/", "sameAs": ["https://www.linkedin.com/in/kirankumarale/", "https://linuxappsdba.blogspot.com"] },
    "publisher": { "@type": "Organization", "name": "TuneVault", "url": "${SITE_URL}" },
    "mainEntityOfPage": { "@type": "WebPage", "@id": "${canonicalUrl}" }
  }
  </script>
</head>
<body>
<nav>
  <a href="/" class="logo"><div class="logo-icon">TV</div>TuneVault</a>
  <div class="nav-right">
    <a href="/blog" style="font-size:13px;color:var(--text-dim);text-decoration:none;">Blog</a>
    <a href="/pricing" style="font-size:13px;color:var(--text-dim);text-decoration:none;">Pricing</a>
    <a href="/signin" style="font-size:13px;color:var(--text-dim);text-decoration:none;">Sign in</a>
    <a href="/signup?path=health-check&redirect=/dashboard" class="nav-cta">Get Started</a>
  </div>
</nav>
<main>
  <a href="/blog" class="back-link">&larr; All articles</a>
  <header class="post-header">
    <div class="post-meta">${formatDate(post.published_at)} &middot; ${post.read_time_minutes} min read &middot; ${escapeHtml(post.author)}</div>
    <h1>${escapeHtml(post.title)}</h1>
    <p class="post-excerpt-text">${escapeHtml(post.excerpt)}</p>
  </header>
  <div class="article-body">
    ${bodyHtml}
  </div>
  <div class="cta-box">
    <h3>Ready to see what&#39;s waiting in your Oracle EBS database?</h3>
    <p>TuneVault runs 200+ automated checks — including all the errors in this post — in minutes. No agents, no inbound firewall rules.</p>
    <a href="/signup?path=health-check&redirect=/dashboard" class="cta-btn">Run Your Free Health Check &rarr;</a>
  </div>
  <aside class="author-aside" aria-label="About the author">
    <div class="author-aside-avatar">KKA</div>
    <div class="author-aside-body">
      <div class="author-aside-name">Kiran Kumar Ale</div>
      <p class="author-aside-bio">20+ years Oracle EBS/DBA/Cloud. 23 Oracle &amp; PM certifications across DBA, EBS, Cloud Infrastructure, and Security tracks. Built TuneVault to encode two decades of production Oracle expertise into an automated health check tool.</p>
      <div class="author-aside-links">
        <a href="https://www.linkedin.com/in/kirankumarale/" target="_blank" rel="author external noopener" class="author-aside-link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          linkedin.com/in/kirankumarale
        </a>
        <a href="mailto:hello@tunevault.app" class="author-aside-link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          hello@tunevault.app
        </a>
        <a href="https://linuxappsdba.blogspot.com" target="_blank" rel="author external noopener" class="author-aside-link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          linuxappsdba.blogspot.com
        </a>
      </div>
    </div>
  </aside>
</main>
<footer>
  <span>TuneVault &copy; 2026</span>
  <span style="display:flex;gap:20px;">
    <a href="/blog">Blog</a>
    <a href="/docs/oracle-setup">Setup Guide</a>
    <a href="/pricing">Pricing</a>
  </span>
</footer>
</body>
</html>`);
  } catch (err) {
    console.error('[blog] article error:', err.message);
    res.status(500).send('Internal server error');
  }
});

// ─── JSON API (for sitemap generation) ───────────────────────────────────

router.get('/api/blog/posts', async (req, res) => {
  try {
    const posts = await listPosts();
    res.json({ posts });
  } catch (err) {
    console.error('[blog] api error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
