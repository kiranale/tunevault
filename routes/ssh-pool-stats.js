/**
 * routes/ssh-pool-stats.js — Admin observability for the SSH connection pool.
 *
 * Owns: GET /api/admin/ssh-pool-stats — live pool metrics from oracle-runner.js.
 * Does NOT own: SSH execution, pool management (those live in services/oracle-runner.js).
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { requireAdmin } = require('../middleware/auth');
const { getPoolStats } = require('../services/oracle-runner');

/**
 * GET /api/admin/ssh-pool-stats
 * Returns live SSH connection pool metrics.
 * Example response:
 *   { size: 12, max: 50, oldest_age_ms: 47230, total_evictions_lru: 3, total_evictions_idle: 8 }
 */
router.get('/', requireAdmin, (req, res) => {
  res.json(getPoolStats());
});

module.exports = router;
