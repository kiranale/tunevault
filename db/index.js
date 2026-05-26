/**
 * db/index.js — single Pool instance for the application.
 *
 * Owns: PostgreSQL connection pool construction.
 * Does NOT own: query logic (see entity files in db/).
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  // Fail loudly at import time so misconfiguration surfaces immediately
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

module.exports = pool;
