/**
 * db/blog.js — Blog post query functions.
 *
 * Owns: blog_posts table queries (list, getBySlug, create).
 * Does NOT own: route handling, HTML rendering, auth.
 */

'use strict';

const pool = require('./index');

/**
 * List all published blog posts ordered by published_at descending.
 * Returns: id, title, slug, excerpt, author, published_at, read_time_minutes
 */
async function listPosts() {
  const result = await pool.query(
    `SELECT id, title, slug, excerpt, author, published_at, read_time_minutes,
            COALESCE(coming_soon, false) AS coming_soon
     FROM blog_posts
     WHERE seo_noindex = false
     ORDER BY coming_soon ASC, published_at DESC`
  );
  return result.rows;
}

/**
 * Fetch a single post by slug.
 * Returns full row including content, or null if not found.
 */
async function getPostBySlug(slug) {
  const result = await pool.query(
    `SELECT id, title, slug, excerpt, content, author, published_at, read_time_minutes
     FROM blog_posts
     WHERE slug = $1`,
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Insert a new blog post. Used by seed script.
 */
async function createPost({ title, slug, excerpt, content, author, published_at, read_time_minutes }) {
  const result = await pool.query(
    `INSERT INTO blog_posts (title, slug, excerpt, content, author, published_at, read_time_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       excerpt = EXCLUDED.excerpt,
       content = EXCLUDED.content,
       author = EXCLUDED.author,
       published_at = EXCLUDED.published_at,
       read_time_minutes = EXCLUDED.read_time_minutes,
       updated_at = NOW()
     RETURNING id`,
    [title, slug, excerpt, content, author || 'TuneVault Team', published_at, read_time_minutes || 10]
  );
  return result.rows[0];
}

/**
 * List all slugs for sitemap generation.
 */
async function listSlugs() {
  const result = await pool.query(
    `SELECT slug, updated_at FROM blog_posts WHERE seo_noindex = false ORDER BY published_at DESC`
  );
  return result.rows;
}

module.exports = { listPosts, getPostBySlug, createPost, listSlugs };
