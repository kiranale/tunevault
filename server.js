// Global process error handlers — prevent silent crashes from unhandled rejections.
// These log to Render stdout (visible in logs) but do NOT crash the server process.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : String(reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack ? err.stack.split('\n')[1] : '');
  // Do NOT process.exit — let the server keep serving other requests
});

const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const OpenAI = require('openai');
const { OAuth2Client } = require('google-auth-library');
const { getDemoMetrics, getSummaryScores, getDemoAnalysis, getDemoExecutiveSummary, getDemoRecommendations } = require('./demo-data');
const { encrypt, decrypt } = require('./crypto-utils');
const { generateHealthCheckPDF } = require('./pdf-generator');
const ExcelJS = require('exceljs');
const cron = require('node-cron');
const { runDeltaForConnection } = require('./services/schedule-runner');
const { processHealthCheckFindings, seedDemoTickets } = require('./services/tuneops-ticket-engine');
const { sendHcCompletionEmail } = require('./services/hc-completion-email');
const { detectAndPersistAdopState } = require('./services/adop-detector');
const { requireAdmin: requireAdminMW, requireAdminPage, requireConnectionOwner, requireRole } = require('./middleware/auth');
const { enforceConnectionCap, enforceHealthCheckCap } = require('./middleware/tier-enforce');
const agentChannel = require('./services/agent-channel');
const {
  helmetMiddleware,
  authLimiter,
  connectionLimiter,
  adminLimiter,
  generalApiLimiter,
  validateBody,
  magicLinkSchema,
  createConnectionSchema,
  updateConnectionSchema,
} = require('./middleware/security');

// Oracle client — lazy-loaded so server starts even if oracledb isn't installed yet
let oracleClient = null;
function getOracleClient() {
  if (!oracleClient) {
    try {
      oracleClient = require('./oracle-client');
    } catch (err) {
      console.error('Oracle client not available:', err.message);
      return null;
    }
  }
  return oracleClient;
}

// classifyOracleError is pure string logic — safe to require eagerly without native oracledb
let _classifyOracleError = null;
function classifyOracleError(err, context) {
  if (!_classifyOracleError) {
    try { _classifyOracleError = require('./oracle-client').classifyOracleError; } catch (e) { /* ignore */ }
  }
  if (_classifyOracleError) return _classifyOracleError(err, context);
  return { heading: 'Connection failed', subtext: err.message || String(err), fixCommand: null };
}

// Serialize a DBA diagnosis into a JSON comment embedded at the top of ai_analysis markdown.
// The report page parses this to render the primary diagnosis banner.
function buildErrorAnalysis(diagnosis, errorBody) {
  const diagJson = JSON.stringify(diagnosis);
  return `<!-- DBA_DIAGNOSIS:${diagJson} -->\n\n${errorBody}`;
}

const app = express();
const port = process.env.PORT || 3000;

// Render deploys behind a proxy — trust first hop so rate limiter reads X-Forwarded-For correctly
app.set('trust proxy', 1);

// Database
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Log DB pool errors — prevents "unhandled error event" crashes on connection drops
pool.on('error', (err) => {
  console.error('[db-pool] Unexpected pool client error:', err.message);
});

// OpenAI (via Polsia AI proxy) — 55s timeout, zero retries to prevent 3×60s hang
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  timeout: 55000,
  maxRetries: 0
});

app.use(express.json());
app.use(cookieParser());

// Security headers (helmet) — applied before all routes
app.use(helmetMiddleware);

// ── Health probes — mounted BEFORE rate limiter so they never get throttled ──
// GET /api/health        — public liveness probe (agent CLI, uptime monitors, Render)
// GET /api/agent/health  — build SHA + min-agent-version for upgrade gate
app.use('/api', require('./routes/health'));

// General API rate limiter — 100 req/min per IP on all /api routes
// NOTE: /api/health is mounted above this line and is exempt.
app.use('/api', generalApiLimiter);

// ============================================================
// Auth helpers
// ============================================================

// SESSION_SECRET is required in production — forgeable sessions are a critical vuln
if (!process.env.SESSION_SECRET && (process.env.NODE_ENV === 'production' || process.env.RENDER)) {
  console.error('FATAL: SESSION_SECRET environment variable is required in production.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://tunevault.app';
// Comma-separated list of admin email addresses (e.g. "alice@example.com,bob@example.com")
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);
const GOOGLE_REDIRECT_URI = `${APP_URL}/api/auth/google/callback`;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI) : null;

const COOKIE_NAME = 'tv_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: '/'
};

function createToken(userId) {
  const payload = JSON.stringify({ userId, iat: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch {
    return null;
  }
}

function getTokenFromRequest(req) {
  // httpOnly cookie first, fallback to Bearer header (for API/legacy)
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

async function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await pool.query(
      'SELECT id, email, name, company_domain, google_id FROM users WHERE id = $1',
      [payload.userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Auth error' });
  }
}

// Upsert user by email — creates or updates, links lead records
async function upsertUser({ email, name, google_id, company_domain, sso_provider }) {
  const normalizedEmail = email.trim().toLowerCase();
  const domain = company_domain || normalizedEmail.split('@')[1] || null;

  let result;
  if (google_id) {
    // Try to find by google_id first, then by email
    result = await pool.query(
      `INSERT INTO users (email, name, google_id, company_domain, last_login, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       ON CONFLICT ((LOWER(email)))
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         google_id = COALESCE(EXCLUDED.google_id, users.google_id),
         company_domain = COALESCE(users.company_domain, EXCLUDED.company_domain),
         last_login = NOW(),
         updated_at = NOW()
       RETURNING id, email, name, company_domain, google_id, (xmax = 0) AS is_new`,
      [normalizedEmail, name || null, google_id, domain]
    );
  } else if (sso_provider) {
    // SSO-provisioned user — track provider, preserve existing google_id
    result = await pool.query(
      `INSERT INTO users (email, name, company_domain, sso_provider, last_login, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       ON CONFLICT ((LOWER(email)))
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, users.name),
         company_domain = COALESCE(users.company_domain, EXCLUDED.company_domain),
         sso_provider = EXCLUDED.sso_provider,
         last_login = NOW(),
         updated_at = NOW()
       RETURNING id, email, name, company_domain, google_id, (xmax = 0) AS is_new`,
      [normalizedEmail, name || null, domain, sso_provider]
    );
  } else {
    result = await pool.query(
      `INSERT INTO users (email, name, company_domain, last_login, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW())
       ON CONFLICT ((LOWER(email)))
       DO UPDATE SET
         name = COALESCE(users.name, EXCLUDED.name),
         company_domain = COALESCE(users.company_domain, EXCLUDED.company_domain),
         last_login = NOW(),
         updated_at = NOW()
       RETURNING id, email, name, company_domain, google_id, (xmax = 0) AS is_new`,
      [normalizedEmail, name || null, domain]
    );
  }
  const user = result.rows[0];
  // Fire signup_completed for genuinely new accounts (xmax = 0 → INSERT path taken)
  if (user.is_new) {
    dbAnalytics.trackEvent({
      eventName: 'signup_completed',
      userId: user.id,
      properties: { source: google_id ? 'google' : sso_provider ? 'sso' : 'magic_link' },
    }).catch(() => {});
  }
  return user;
}

// MFA auth gate: after primary auth, check if user has MFA enabled.
// If yes, set pending-MFA cookie (short-lived) and redirect to challenge page instead of full session.
const dbMfa = require('./db/mfa');
const mfaRouterRef = require('./routes/mfa');

async function finishAuth(res, userId, redirect) {
  const mfaRecord = await dbMfa.getMfaRecord(userId).catch(() => null);
  if (mfaRecord?.is_enabled) {
    const pendingToken = mfaRouterRef.createPendingToken(userId, redirect, SESSION_SECRET);
    res.cookie(mfaRouterRef.PENDING_COOKIE, pendingToken, mfaRouterRef.PENDING_OPTS);
    return { needsMfa: true };
  }
  const token = createToken(userId);
  setAuthCookie(res, token);
  return { needsMfa: false };
}

// Admin rate limiter — 20 req/min per IP on all /api/admin/* endpoints
app.use('/api/admin', adminLimiter);

// ============================================================
// Admin banner middleware — injects outreach lock status strip on all /admin/* HTML pages
// ============================================================
// Wraps res.send to inject a sticky top banner showing OUTREACH LOCKED (red) or UNLOCKED (green).
// Applies only to HTML responses on /admin/* paths. JSON/CSV responses are not affected.
app.use('/admin', (req, res, next) => {
  const { isOutreachLocked } = require('./services/outreach-mailer');
  const originalSend = res.send.bind(res);
  res.send = function(body) {
    const contentType = res.getHeader('Content-Type') || '';
    if (typeof body === 'string' && contentType.includes('html')) {
      const locked = isOutreachLocked();
      const banner = locked
        ? `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#7b0000;color:#fff;font-size:12px;font-weight:600;text-align:center;padding:6px 16px;letter-spacing:.02em">
             🔴 OUTREACH LOCKED — no external emails will send &nbsp;·&nbsp; <a href="/admin/outreach-lock" style="color:#ffa0a0;text-decoration:underline">View lock status</a>
           </div><div style="height:32px"></div>`
        : `<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#276127;color:#fff;font-size:12px;font-weight:600;text-align:center;padding:6px 16px;letter-spacing:.02em">
             🟢 OUTREACH UNLOCKED &nbsp;·&nbsp; <a href="/admin/outreach-lock" style="color:#b9f6ca;text-decoration:underline">View lock status</a>
           </div><div style="height:32px"></div>`;
      // Inject banner immediately after <body> tag
      body = body.replace(/<body([^>]*)>/, `<body$1>${banner}`);
    }
    return originalSend(body);
  };
  next();
});

// ============================================================
// Feature routes (modular — live in routes/)
// ============================================================

// Payments + subscriptions (Razorpay)
// Webhook uses express.raw() inline; must be mounted before any body-parser conflict
app.use('/api', require('./routes/payments'));

// Billing & usage — current tier, live usage counters, and caps for billing UI
app.use('/api/billing', require('./routes/billing'));

// Agent installer downloads — oracle-proxy.py, agent-pkg.tar.gz, install.sh, uninstall.sh (public)
app.use('/', require('./routes/downloads'));

// Connection list + health-check list — must be Router-mounted (not inline app.get)
// to avoid Express middleware ordering issues with 60+ app.use mounts.
app.use('/api', require('./routes/connections-list'));

// One-screen Add Connection — SSH-based auto-install flow.
// GET /connections/new (form), POST /api/connections/new (create + token),
// GET /api/connections/:id/ssh-install/stream (SSE: upload+run install.sh, wait for register, ping)
app.use('/', require('./routes/ssh-install'));
app.use('/api/connections', require('./routes/ssh-install'));

// SSH push-install jobs: POST /api/install-jobs, GET /api/install-jobs/:id, GET /api/install-jobs/:id/stream
app.use('/api', require('./routes/install-jobs'));

// CDB/PDB service classifier: GET /api/connections/discover-services
//   POST /api/connections/:id/save-service-classification
//   POST /api/connections/:id/log-blocked-service-override
app.use('/api/connections', require('./routes/service-discovery'));

// TNS Topology Inspector — listener/service reconciliation + recommended connect string.
// GET  /connections/:id/tns-topology          — HTML page
// GET  /api/connections/:id/tns-topology      — run live analysis
// POST /api/connections/:id/tns-topology/snapshot — persist snapshot
// POST /api/connections/:id/tns-topology/share    — issue 7-day share token
// GET  /api/connections/:id/tns-topology/history  — last 30 snapshots
// GET  /share/tns-topology/:token             — public share view
// GET  /api/share/tns-topology/:token         — public share JSON
app.use('/', require('./routes/tns-topology'));
app.use('/api/connections', require('./routes/tns-topology'));

// First-run wow-moment: auto-trigger + Top 5 Tonight panel.
// GET  /connections/:id/first-run             — live progress + findings page
// POST /api/connections/:id/first-run/trigger — idempotent health pack kick-off
// GET  /api/connections/:id/first-run/status  — poll status + ranked findings
// POST /api/connections/:id/first-run/resolve — mark finding resolved
// POST /api/connections/:id/first-run/snooze  — snooze finding 24h
app.use('/', require('./routes/first-run'));
app.use('/api/connections', require('./routes/first-run'));

// Fresh setup wizard — /setup/fresh (3-phase: connection form → agent install → install cmd)
// API endpoints: POST /api/setup/connection, GET /api/setup/install-token/:id/:token,
//                PATCH /api/setup/connection/:id/hostname, GET /api/setup/proxy-status/:id
app.use('/', require('./routes/setup-fresh'));
app.use('/api/setup', require('./routes/setup-fresh'));

// Blog — SEO content pages (/blog, /blog/:slug, /api/blog/posts)
app.use('/', require('./routes/blog'));

// Runbooks — Oracle DBA runbook content pages (/resources/runbooks, /resources/runbooks/:slug)
app.use('/resources/runbooks', require('./routes/runbooks'));

// SEO infrastructure — /sitemap.xml (dynamic, 1h cached, includes blog slugs from DB)
// Must be mounted before express.static so Express intercepts before the static file is served.
app.use('/', require('./routes/seo'));

// Features — Marketing pages (/features/:page, /api/autonomous-remediation-beta)
app.use('/features', require('./routes/features'));
app.use('/api', require('./routes/features'));

// ADDM Findings — on-demand Oracle ADDM advisor query (EE + Diagnostics Pack gated)
app.use('/api', require('./routes/addm'));

// Performance Advisor — ADDM + SQL Tuning Advisor panel (GET cached, POST fetch)
app.use('/api/advisor', require('./routes/performance-advisor'));

// Performance — Top SQL, Wait Events, Blocking Sessions, Segment Hotspots
app.use('/api/performance', require('./routes/performance'));

// Auto-Housekeeping Window status — autotask clients, scheduler windows, stale stats
app.use('/api', require('./routes/housekeeping'));

// Blocking Sessions + Long Operations — on-demand live session diagnostics
app.use('/api', require('./routes/sessions'));

// Admin payment test runner — E2E Razorpay validation (admin-only)
app.use('/api/admin/payment-test', require('./routes/admin-payment-test'));

// Admin Razorpay key management — validate + deploy new test keys (admin-only)
app.use('/api/admin/razorpay', require('./routes/admin-razorpay'));

// Admin live payment validation — ₹1 live charge + auto-refund (admin-only)
app.use('/api/admin/live-test', require('./routes/admin-live-test'));

// Admin EBS validation — smoke-test every EBS code path (admin-only)
app.use('/api/admin/ebs-validation', require('./routes/ebs-validation'));

// Proxy self-test — ingest synthetic EBS fixture through full parse+score+AI pipeline (admin-only)
app.use('/admin', require('./routes/proxy-self-test'));
app.use('/api/admin', require('./routes/proxy-self-test'));

// Admin test harness — VirtualBox Oracle XE guide + validator bundle download (admin-only)
app.use('/admin/test-harness', require('./routes/test-harness'));
app.use('/api/test-harness',   require('./routes/test-harness'));

// Admin smoke test suite — UI checks + dry-run preview for all TuneVault operations (admin-only)
app.use('/admin/smoke-tests',     require('./routes/admin-smoke-tests'));
app.use('/api/admin/smoke-tests', require('./routes/admin-smoke-tests'));

// Agent end-to-end smoke test — 6-step live proof against a real agent connection (admin-only)
app.use('/api/admin/smoke-test', require('./routes/admin-agent-smoke-test'));

// Admin bulk-delete connections — pattern-matched cascade deletes with confirm dialog (ADMIN_BULK_DELETE=1)
app.use('/admin/connections',          require('./routes/admin-connections'));
app.use('/api/admin/connections',      require('./routes/admin-connections'));

// Admin agents fleet view — /admin/agents + /api/admin/agents (heartbeat, version, OS, log tail)
// Also exposes POST /api/admin/agents/log-tail for agents to push their log buffer on heartbeat.
// Smoke endpoints exposed at canonical paths used by scripts/smoke-test-installer.sh + admin/agents.html:
//   POST /api/admin/smoke-token  — issue one-shot 15-min install token for smoke containers
//   POST /api/admin/smoke-runs   — report back a container smoke result (X-Smoke-Secret auth)
//   GET  /api/admin/smoke-runs   — Installer Health card: last 20 smoke run results
app.use('/admin/agents',               require('./routes/admin-agents'));
app.use('/api/admin/agents',           require('./routes/admin-agents'));

// SSH connection pool live stats — GET /api/admin/ssh-pool-stats (admin-only)
app.use('/api/admin/ssh-pool-stats',   require('./routes/ssh-pool-stats'));

const { tokenRouter: smokeTokenRouter, runsRouter: smokeRunsRouter } = require('./routes/installer-smoke-endpoints');
app.use('/api/admin/smoke-token',      smokeTokenRouter);
app.use('/api/admin/smoke-runs',       smokeRunsRouter);

// Admin roadmap reminders — deferred "remind me later" items (admin-only)
app.use('/api/admin/roadmap-reminders', require('./routes/roadmap-reminders'));

// Top SQL Breakdown — five V$SQL rankings (CPU, Elapsed, Buffer Gets, Disk Reads, Executions)
app.use('/api', require('./routes/topsql'));

// Invalid Objects — DBA_OBJECTS where status = 'INVALID', grouped by owner/type (all editions)
app.use('/api', require('./routes/invalidobjects'));

// Unusable Indexes — DBA_INDEXES + DBA_IND_PARTITIONS + DBA_IND_SUBPARTITIONS (all editions)
app.use('/api', require('./routes/unusableindexes'));

// Stale Statistics — DBA_TABLES / DBA_TAB_STATISTICS / DBA_AUTOTASK_CLIENT (all editions)
app.use('/api', require('./routes/stalestatistics'));

// Oracle Parameters — V$PARAMETER with recommended values + traffic-light status
app.use('/api', require('./routes/parameters'));

// DB Diagnostics — Scheduler jobs, expired users, Data Guard/Flashback, recyclebin, DB links
app.use('/api', require('./routes/db-diagnostics'));

// Outreach hard-lock control panel — /admin/outreach-lock (lock state + attempt audit log)
// Also serves /api/admin/outreach-lock/status and /api/admin/outreach-lock/attempts.
// OUTREACH_UNLOCK_TOKEN env var absent = system is LOCKED; no cold email can leave.
app.use('/admin/outreach-lock', require('./routes/outreach-lock'));
app.use('/api/admin/outreach-lock', require('./routes/outreach-lock'));

// Outreach audit — /admin/outreach/audit (operator-ordered halt; read-only audit + CSV export)
// OUTREACH_SEND_ENABLED=false is the kill-switch; any future outreach code MUST check this env var.
app.use('/admin/outreach/audit', require('./routes/outreach-audit'));

// Outreach approval gate — /admin/outreach/approve (batch approval UI + send-trigger API)
// sendOutreachEmail() in services/outreach-mailer.js is the ONLY path that can send cold emails.
// All 4 gates (OUTREACH_UNLOCK_TOKEN, env flag, batch approval, per-recipient auth) enforced inside.
app.use('/admin/outreach/approve', require('./routes/outreach-approve'));

// Drip email unsubscribe — GET /drip/unsubscribe?t=<token>
app.use('/drip', require('./routes/drip'));

// Autonomous monitoring schedules — CRUD + snooze + admin overview
app.use('/api/schedules', require('./routes/schedules'));
app.use('/admin/schedules', require('./routes/schedules'));

// Fleet overview — GET /fleet (HTML page) + /api/fleet/* (API)
app.use('/', require('./routes/fleet'));
app.use('/api/fleet', require('./routes/fleet'));

// Manager / SDM executive dashboard — GET /manager + /api/manager/*
// RBAC: requires manager_role IN (manager, sdm, admin) or ADMIN_EMAILS
app.use('/', require('./routes/manager'));
app.use('/api/manager', require('./routes/manager'));

// SQL Tuning — top-10 V$SQL consumers, AI index/rewrite recommendations
app.use('/api/sql-tuning', require('./routes/sql-tuning'));
app.use('/api/reports', require('./routes/reports'));

// Health check per-check-row export — PDF + CSV, severity-sorted, DBA-first detail
app.use('/api/health-checks', require('./routes/health-check-export'));

// Connection Targets — proxy agent registrations (replaces SSH Targets).
// Owns: /settings/connection-targets, /admin/connection-targets,
//       /api/connection-targets, /api/connection-targets/:id/health-check,
//       301 redirects from /settings/ssh-targets + /admin/ssh-targets,
//       410 tombstones for retired /api/ssh/* and /api/user/ssh/* CRUD.
// Must be mounted BEFORE the legacy ssh-targets and user-ssh-targets routes
// so that 410 tombstones take precedence.
app.use('/', require('./routes/connection-targets'));

// SSH command execution API — allowlisted commands via stored targets
// POST /api/ssh-targets/:id/execute  GET /api/ssh-targets/:id/stream
app.use('/api/ssh-targets', require('./routes/ssh-execute'));

// Settings hub — /settings (account type toggle, links to team + connection targets)
app.use('/settings', require('./routes/settings'));

// User-facing SSH target management — kept for /settings/ssh-targets backward compat.
// The page itself 301-redirects in connection-targets; API CRUD is 410'd above.
app.use('/settings', require('./routes/user-ssh-targets'));
app.use('/api/user/ssh', require('./routes/user-ssh-targets'));

// Notification preferences — /settings/notifications + /api/notifications/preferences
app.use('/', require('./routes/notifications'));

// Team management — /settings/team + /api/team/* + /invite/accept
app.use('/', require('./routes/team'));

// Role hierarchy + approval engine — /api/roles/* + /api/approvals/* + /api/patches/status
app.use('/', require('./routes/roles'));

// TuneBot context-aware chat — /api/tunebot/context + /api/tunebot/chat
app.use('/api/tunebot', require('./routes/tunebot'));

// TuneOps ticketing system — /api/tuneops/tickets + /api/tuneops/stats
app.use('/api/tuneops', require('./routes/tuneops'));

// EBS / WebLogic Quick Access — apps URL config, signed tunnel tokens, HTTP-forward via proxy
app.use('/', require('./routes/apps-tunnel'));

// EBS SSH check catalog + runner (filesystem, adop, CM, WLS, logs — requires SSH target)
app.use('/api/ebs-ssh-checks', require('./routes/ebs-ssh-checks'));

// OS exec via proxy — whitelisted OS commands over the existing secure tunnel (no SSH)
app.use('/api/connections', require('./routes/os-exec'));

// Proxy exec — structured command_id + args execution via HTTPS proxy (replaces SSH targets)
// POST /api/connections/:id/exec  GET /api/connections/:id/exec/audit
app.use('/api/connections', require('./routes/proxy-exec'));

// SSH connection profiles — per-role SSH config (db_host, apps_tier, concurrent_tier, web_tier)
// + in-browser Test SSH dispatched to agent via long-poll channel.
// GET/POST /api/connections/:id/ssh-profiles
// PUT/DELETE /api/connections/:id/ssh-profiles/:role
// POST /api/connections/:id/ssh-test?role=db_host
app.use('/api', require('./routes/ssh-profiles'));

// SSH-first connectivity mode — store SSH key + ORACLE_HOME/SID, test SSH→sqlplus path.
// GET  /api/connections/:id/ssh-connectivity         — current SSH config (key masked)
// PUT  /api/connections/:id/ssh-connectivity         — save connectivity_mode + SSH key
// POST /api/connections/:id/ssh-connectivity/test    — validate SSH + sqlplus reachable
app.use('/api/connections', require('./routes/ssh-connectivity'));

// SSH-driven listener pre-flight: 5-step lsnrctl/tnsping/sqlplus diagnostic.
// GET  /connections/:id/listener-preflight             — HTML page
// POST /api/connections/:id/listener-preflight/run    — execute 5-step check
// GET  /api/connections/:id/listener-preflight/runs   — last 10 run history
// GET  /api/connections/:id/listener-preflight/:runId — single run detail
app.use('/', require('./routes/listener-preflight'));
app.use('/api/connections', require('./routes/listener-preflight'));

// Cloud-managed API key rotation — eliminates on-box key editing.
// POST /api/connections/:id/rotate-key
// GET  /api/connections/:id/rotate-key/status
app.use('/api/connections', require('./routes/key-rotation'));

// Auto-upgrade audit + per-connection toggle.
// GET  /admin/agent-upgrades              — audit page HTML (admin-only)
// GET  /api/admin/agent-upgrades          — last 100 audit rows JSON
// GET  /api/admin/agent-upgrades/csv      — CSV export
// GET  /api/connections/:id/auto-upgrade-status — current audit status
// PATCH /api/connections/:id/auto-upgrade — toggle auto_upgrade_enabled
app.use('/admin', require('./routes/agent-upgrades'));
app.use('/api/admin', require('./routes/agent-upgrades'));
app.use('/api/connections', require('./routes/agent-upgrades'));

// POST /api/admin/reset-upgrade/:id — back-date failed upgrade audit rows so the next
// heartbeat can re-attempt. Alias for routes/agent-upgrades POST /:id/reset-failures.
app.post('/api/admin/reset-upgrade/:id', requireAdminMW, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid connection id' });
  try {
    const result = await pool.query(
      `UPDATE agent_upgrade_audit
         SET triggered_at = NOW() - INTERVAL '25 hours'
       WHERE connection_id = $1
         AND status = 'failed'
         AND triggered_at > NOW() - INTERVAL '24 hours'
       RETURNING id`,
      [id]
    );
    res.json({ ok: true, connection_id: id, rows_reset: result.rows.length });
  } catch (err) {
    console.error('[reset-upgrade] error:', err.message);
    res.status(500).json({ error: 'Failed to reset upgrade suppression' });
  }
});

// Agent install failures — real-time view of failed install.sh runs.
// GET /admin/agent-installs     — HTML table (admin-only, legacy)
// GET /api/admin/agent-installs — JSON list (admin-only, legacy)
app.use('/admin', require('./routes/agent-installs'));
app.use('/api/admin', require('./routes/agent-installs'));

// Install failures triage page — full admin triage with stats, filters, resolve, CSV export.
// GET  /admin/install-failures                       — HTML triage page (admin-only)
// GET  /api/admin/install-failures                   — paginated JSON
// POST /api/admin/install-failures/:id/resolve       — mark row resolved
// POST /api/admin/install-failures/ignore-similar    — 24h mute by class+version
// GET  /api/admin/install-failures/export.csv        — CSV export
app.use('/admin', require('./routes/install-failures'));
app.use('/api/admin', require('./routes/install-failures'));

// Agent crash-loop detection — derived health state + journalctl pull.
// GET  /api/connections/:id/agent-health             — derived agent_health state
// POST /api/connections/:id/pull-journalctl          — queue journalctl pull or fallback
// GET  /api/connections/:id/pull-journalctl/result/:resultId — poll result
app.use('/api/connections', require('./routes/agent-crash-detect'));

// Agent release manifest — version + sha256 integrity check.
// GET /api/agent/release   — manifest + live served_sha256 (warns on mismatch)
// GET /admin/agent-release — admin UI (manifest vs served side by side)
app.use('/', require('./routes/agent-release'));

// Post-upgrade verification ingestion + status surface.
// POST /api/upgrade-verifications                       — agent posts verification bundle
// GET  /api/upgrade-verifications/recent                — last 20 rows for /status/installer
// GET  /api/upgrade-verifications/connection/:id        — latest verification for badge tooltip
// POST /api/connections/:id/re-verify                   — trigger fresh probe (auth required)
app.use('/api', require('./routes/upgrade-verifications'));
app.use('/api/connections', require('./routes/upgrade-verifications'));

// EBS 12.2 Deep Checks — Topology, JVM Heap, OS Metrics, Code Levels, ETCC
app.use('/', require('./routes/ebs-12-2-checks'));
app.use('/api/ebs-12-2', require('./routes/ebs-12-2-checks'));

// EBS Security checks (ES01–ES08) + EBS Performance checks (EP01–EP06)
app.use('/', require('./routes/ebs-security-performance'));

// EBS Middleware — WLS AdminServer, Apache/OHS, Apps Listener management via SSH (apps_tier)
app.use('/', require('./routes/ebs-middleware'));
app.use('/api/ebs-middleware', require('./routes/ebs-middleware'));

// EBS Concurrent — Running Requests view + All-nodes start/stop (adstrtal/adstpall -mode=allnodes)
app.use('/', require('./routes/ebs-concurrent'));
app.use('/api/ebs-concurrent', require('./routes/ebs-concurrent'));

// DB Ops — full Oracle operations catalog: Instance, Listener, Sessions, Tablespace, Memory,
// Stats, Archive, RMAN, ASM (auto-detected), RAC (auto-detected).
app.use('/', require('./routes/db-ops'));
app.use('/api/db-ops', require('./routes/db-ops'));

// EBS Ops hub — categorized card grid linking to all EBS operation pages.
app.use('/', require('./routes/ebs-ops'));

// FNDLOAD Setup Migration — 5-step wizard for migrating EBS setup objects between instances.
app.use('/', require('./routes/fndload'));
app.use('/api/ebs/fndload', require('./routes/fndload'));

// Clone Wizard Hub — unified /clone entry page (DB Clone vs Apps Clone, Guided vs Auto).
app.use('/', require('./routes/clone'));
app.use('/api/clone', require('./routes/clone'));

// EBS Clone & Scale — Rapid Clone Wizard with recipe recording, pre-checks, post-clone steps.
app.use('/', require('./routes/ebs-clone'));
app.use('/api/ebs-clone', require('./routes/ebs-clone'));

// DB Clone & Scale — Guided Oracle DB clone wizard (RMAN, Data Pump, RAC) for all connections.
app.use('/', require('./routes/db-clone'));
app.use('/api/db-clone', require('./routes/db-clone'));

// Service Sanity Check — post-bounce validation for EBS Application Tier + DB Tier (read-only).
app.use('/', require('./routes/sanity-check'));
app.use('/api/sanity-check', require('./routes/sanity-check'));

// SQL Console + Terminal — /sql-console, /terminal, /api/sql-console/run
app.use('/', require('./routes/console'));
app.use('/api/sql-console', require('./routes/console'));

// SQL Execution via proxy — POST /api/connections/:id/execute-sql + GET /api/connections/:id/sql-audit
// Whitelisting engine (SELECT/ALTER SYSTEM/etc.), rate limit 10/min, full sql_audit_log trail.
app.use('/', require('./routes/sql-execute'));

// Browser SSH Terminal — free-form command execution with block-list safety layer
app.use('/api/terminal', require('./routes/terminal'));

// MFA — TOTP setup, challenge verify, admin reset
// Routes defined with full paths (/settings/security, /mfa-challenge, /api/mfa/*)
const mfaRouter = require('./routes/mfa');
app.use('/', mfaRouter);

// SSO — SAML 2.0 login flow, SP metadata, settings CRUD, login page check
// Exposes createToken/upsertUser/finishAuth to routes via app.locals.authHelpers
app.locals.authHelpers = { pool, upsertUser, finishAuth, createToken };
const ssoRouter = require('./routes/sso');
app.use('/', ssoRouter);

// ============================================================
// Auth routes
// ============================================================

// GET /api/auth/google — initiate server-side OAuth 2.0 authorization code flow
app.get('/api/auth/google', authLimiter, (req, res) => {
  if (!googleClient) {
    return res.status(503).send('Google OAuth not configured');
  }
  // Store the redirect destination in a signed state param
  const redirect = req.query.redirect || '/dashboard';
  const state = Buffer.from(JSON.stringify({ redirect })).toString('base64url');

  const authUrl = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account'
  });
  res.redirect(authUrl);
});

// GET /api/auth/google/callback — exchange authorization code for tokens, create session
app.get('/api/auth/google/callback', async (req, res) => {
  if (!googleClient) {
    return res.redirect('/login?error=server_error');
  }
  const { code, error, state } = req.query;
  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect('/login?error=server_error');
  }
  if (!code) {
    return res.redirect('/login?error=server_error');
  }

  // Parse redirect destination from state
  let redirect = '/dashboard';
  try {
    if (state) {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString());
      if (parsed.redirect && parsed.redirect.startsWith('/')) {
        redirect = parsed.redirect;
      }
    }
  } catch (_) { /* ignore malformed state */ }

  try {
    // Exchange authorization code for tokens
    const { tokens } = await googleClient.getToken(code);
    const idToken = tokens.id_token;
    if (!idToken) {
      console.error('Google OAuth: no id_token in token response');
      return res.redirect('/login?error=server_error');
    }

    // Verify the ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { sub: google_id, email, name } = payload;

    if (!email) {
      console.error('Google OAuth: no email in token payload');
      return res.redirect('/login?error=server_error');
    }

    const user = await upsertUser({ email, name, google_id });

    // contacts pre-registration not required on Resend basic tier

    const authResult = await finishAuth(res, user.id, redirect);
    res.redirect(authResult.needsMfa ? '/mfa-challenge' : redirect);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/login?error=server_error');
  }
});

// POST /api/auth/google — verify Google ID token (fallback for client-side GIS flow)
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Google credential required' });
  }
  if (!googleClient) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const { sub: google_id, email, name } = payload;

    if (!email) {
      return res.status(400).json({ error: 'No email in Google token' });
    }

    const user = await upsertUser({ email, name, google_id });

    // contacts pre-registration not required on Resend basic tier

    const authResult = await finishAuth(res, user.id, '/dashboard');
    if (authResult.needsMfa) {
      return res.json({ mfa_required: true, redirect: '/mfa-challenge' });
    }
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// POST /api/auth/magic-link/request — send magic link email
app.post('/api/auth/magic-link/request', authLimiter, validateBody(magicLinkSchema), async (req, res) => {
  const { email, redirect: redirectParam } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  // Validate redirect — must start with / to prevent open redirect
  const safeRedirect = redirectParam && typeof redirectParam === 'string' && redirectParam.startsWith('/') ? redirectParam : '/dashboard';

  try {
    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Invalidate previous unused tokens for this email
    await pool.query(
      `UPDATE magic_link_tokens SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [normalizedEmail]
    );

    await pool.query(
      `INSERT INTO magic_link_tokens (email, token, expires_at) VALUES ($1, $2, $3)`,
      [normalizedEmail, token, expiresAt]
    );

    const appUrl = process.env.APP_URL || 'https://tunevault.app';
    const magicLink = safeRedirect && safeRedirect !== '/dashboard'
      ? `${appUrl}/auth/magic?token=${token}&redirect=${encodeURIComponent(safeRedirect)}`
      : `${appUrl}/auth/magic?token=${token}`;

    // Send email
    const htmlBody = `
      <div style="font-family: 'Space Grotesk', -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px; background: #0a0a0c; color: #e8e8ed; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-flex; align-items: center; gap: 10px; margin-bottom: 8px;">
            <div style="width: 32px; height: 32px; background: #f0a830; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; color: #0a0a0c; font-size: 14px;">TV</div>
            <span style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">TuneVault</span>
          </div>
        </div>
        <div style="background: #111114; border: 1px solid #2a2a30; border-radius: 12px; padding: 32px; text-align: center;">
          <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 12px; letter-spacing: -0.5px;">Your sign-in link</h1>
          <p style="color: #8888a0; font-size: 14px; margin: 0 0 32px; line-height: 1.6;">Click the button below to sign in to TuneVault. This link expires in 15 minutes.</p>
          <a href="${magicLink}" style="display: inline-block; padding: 14px 32px; background: #f0a830; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; letter-spacing: -0.3px;">Sign in to TuneVault →</a>
          <p style="color: #8888a0; font-size: 12px; margin: 24px 0 0; line-height: 1.5;">If you didn't request this, you can safely ignore this email. Your account is secure.</p>
        </div>
        <p style="color: #444455; font-size: 11px; text-align: center; margin-top: 20px;">Link expires at ${expiresAt.toUTCString()}</p>
      </div>
    `;
    const textBody = `Sign in to TuneVault\n\nClick this link to sign in (expires in 15 minutes):\n${magicLink}\n\nIf you didn't request this, ignore this email.`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>',
        to: normalizedEmail,
        subject: 'Your TuneVault sign-in link',
        text: textBody,
        html: htmlBody
      })
    });

    // Always return success (don't leak whether email exists)
    res.json({ success: true, message: 'Magic link sent. Check your inbox.' });
  } catch (err) {
    console.error('Magic link error:', err);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// GET /auth/magic — exchange magic link token for session
app.get('/auth/magic', async (req, res) => {
  const { token, redirect } = req.query;
  const safeRedirect = redirect && redirect.startsWith('/') ? redirect : '/dashboard';

  if (!token) {
    return res.redirect('/login?error=missing_token');
  }

  try {
    const result = await pool.query(
      `SELECT * FROM magic_link_tokens
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect('/login?error=invalid_or_expired');
    }

    const linkRow = result.rows[0];

    // Mark token as used
    await pool.query(
      `UPDATE magic_link_tokens SET used_at = NOW() WHERE id = $1`,
      [linkRow.id]
    );

    // Upsert user
    const user = await upsertUser({ email: linkRow.email });

    // contacts pre-registration not required on Resend basic tier

    const authResult = await finishAuth(res, user.id, safeRedirect);
    res.redirect(authResult.needsMfa ? '/mfa-challenge' : safeRedirect);
  } catch (err) {
    console.error('Magic link verify error:', err);
    res.redirect('/login?error=server_error');
  }
});

// POST /api/auth/logout — clear session cookie
app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// GET /api/auth/me — validate token and return user (includes manager_role for nav gating)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const userEmail = (req.user.email || '').toLowerCase();
  const isAdmin   = ADMIN_EMAILS.has(userEmail);
  try {
    const { rows } = await pool.query(
      'SELECT manager_role FROM users WHERE id = $1',
      [req.user.id]
    );
    const managerRole = rows[0]?.manager_role || null;
    res.json({ user: { ...req.user, is_admin: isAdmin, manager_role: managerRole } });
  } catch (err) {
    // Non-fatal — return without manager_role on DB error
    res.json({ user: { ...req.user, is_admin: isAdmin, manager_role: null } });
  }
});

// GET /api/auth/config — public config for frontend (Google Client ID)
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// Legacy signin/signup — redirect to /login
app.post('/api/auth/signup', (req, res) => {
  res.status(410).json({ error: 'Password auth removed. Use /login (Google or magic link).' });
});
app.post('/api/auth/signin', (req, res) => {
  res.status(410).json({ error: 'Password auth removed. Use /login (Google or magic link).' });
});

// GET /health — bare alias; Render healthCheckPath updated to /api/health but kept
// here for any external monitors that bookmarked the old path.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Login page (primary entry point)
app.get('/login', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'login.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/');
  }
});

// Legacy redirects → /login
app.get('/signup', (req, res) => {
  const qs = req.query.redirect ? `?redirect=${encodeURIComponent(req.query.redirect)}` : '';
  res.redirect('/login' + qs);
});
app.get('/signin', (req, res) => {
  const qs = req.query.redirect ? `?redirect=${encodeURIComponent(req.query.redirect)}` : '';
  res.redirect('/login' + qs);
});

// Lead capture page (backward compat)
app.get('/request-health-check', (req, res) => {
  res.redirect('/login?redirect=/dashboard');
});

// Legacy setup guide redirect → new docs page
app.get('/setup-guide', (req, res) => res.redirect('/docs/oracle-setup'));

// Setup guide doc (public, no auth)
app.get('/docs/oracle-setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'oracle-setup.html'));
});

// SSH prerequisites docs (public, no auth)
app.get('/docs/ssh-prereqs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs', 'ssh-prereqs.html'));
});

// Privilege model docs + tunevault_reader role setup script (public, no auth)
// GET /docs/privileges — privilege model one-pager
// GET /setup/role-script — canonical tunevault_reader.sql (plain text, for copy-paste in wizard + DBA handoff)
app.use('/', require('./routes/privileges'));

// About the Founder page (public, no auth) — both /about and /about/ resolve
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});
app.get('/about/', (req, res) => {
  res.redirect(301, '/about');
});

// TuneVault vs Oracle Enterprise Manager comparison (public, no auth)
app.get('/vs-oem', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vs-oem.html'));
});

// TuneVault vs Datadog/Grafana/Zabbix/OEM/ManageEngine multi-tool comparison (public, no auth)
app.get('/compare', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'compare.html'));
});

// Pricing page — standalone public page for all users; auth state only changes button labels
app.get('/pricing', optionalAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Features page (public, no auth) — Oracle-first check catalogue with EBS as depth layer
app.get('/features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'features.html'));
});

// Performance tab page — Top SQL killers with AI fix recommendations
app.get('/performance', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'performance.html'));
});

// SQL Tuning page — top-10 V$SQL consumers with AI index/rewrite recommendations
app.get('/sql-tuning', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sql-tuning.html'));
});

// ADDM Analysis page — in-product Run ADDM with snapshot picker, findings, AI commentary
app.get('/addm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'addm.html'));
});

// /sample-report — public page, /sample-report/lead (email capture), /sample-report/pdf (download)
app.use('/sample-report', require('./routes/sample-report'));

// Security commands reference (public, no auth, indexable) — SQL/OS command whitelist for enterprise procurement
app.use('/security', require('./routes/security'));

// EBS credential vault — AES-256-GCM encrypted APPS/SYSTEM/WebLogic/SYSADMIN passwords.
// POST   /api/connections/:id/credentials              — upsert (write-only, server encrypts)
// GET    /api/connections/:id/credentials              — list metadata (type, username, rotated_at)
// DELETE /api/connections/:id/credentials/:type        — revoke
// GET    /api/connections/:id/credentials/log          — access audit (admin only)
app.use('/api/connections', require('./routes/ebs-credentials'));

// Architecture / How It Works (public, no auth)
app.get('/architecture', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'architecture.html'));
});

// Feature explanation pages (public, no auth) — marketing surfaces for dropdown links
app.get('/features/sql-tuning', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'features-sql-tuning.html'));
});
app.get('/features/fleet-management', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'features-fleet-management.html'));
});

// Trust & Security one-pager — forwardable enterprise InfoSec review page
app.get('/trust', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trust.html'));
});

// Legal pages — enterprise procurement requirements
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Deep EBS Mode — live EBS status + SSH command control whitelist (auth required, EBS connections only)
app.use('/', require('./routes/ebs-deep'));

// Deep EBS Reports — /report/ebs/:id, POST /api/ebs-deep/run, PDF export
app.use('/', require('./routes/ebs-deep-reports'));

// EBS Control Command catalog + preview (Phase 1: dry-run only, DB-backed whitelist)
app.use('/api/ebs-control', require('./routes/ebs-control'));

// EBS Control Exec — proxy-exec UI for CM/OPMNCTL/ADOP/Listener commands (proxy connections only)
app.get('/ebs-control-exec', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ebs-control-exec.html'));
});

// OS Diagnostics — proxy-exec UI for OS-level shell commands (ps, df, free, oratab, tnsping, crsctl, tail_log)
app.get('/os-diagnostics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'os-diagnostics.html'));
});

// Live log tailing — SSE stream of tail -F over SSH (oacore, Apache, OPMN, ADOP, CM, etc.)
app.use('/api/ssh-tail', require('./routes/ssh-tail'));
app.get('/ebs-log-tail', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ebs-log-tail.html'));
});

// EBS SSH runbooks — CM status/bounce, alert log tail, ADOP phase status
// Uses connection_ssh_profiles via agent channel. Routes: /ebs-runbooks/* + /api/ebs-runbooks/*
app.use('/', require('./routes/ebs-runbooks'));
app.use('/api/ebs-runbooks', require('./routes/ebs-runbooks'));

// Control runbook generator — 4 EBS recovery runbooks with live-data substitution
app.use('/api/control', require('./routes/control-runbook'));

// Upgrade hook — personalized worst-finding data for limit-hit conversion modal
app.use('/api/checks', require('./routes/upgrade'));

// Analytics — funnel event tracking + admin dashboard
// /api/analytics/* — funnel-data endpoint + legacy /event alias
// /api/ec — ad-blocker-safe client-side event ingest (avoids EasyList patterns)
const analyticsRouter = require('./routes/analytics');
app.use('/api', analyticsRouter);

// /api/events — landing page CTA click tracking (page_events table)
// /api/admin/analytics/events — admin daily counts by event_name
const pageEventsRouter = require('./routes/page-events');
app.use('/api', pageEventsRouter);

// Admin: conversion funnel visualisation
app.get('/admin/funnel', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'funnel.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/admin/users');
  }
});

// Performance tab — Top SQL by elapsed/buffer-gets with AI-generated fix recommendations
app.use('/api/performance', require('./routes/performance'));

// Patch Advisor — CPU/PSU level detection, gap analysis, adop/OPatch runbook generation
app.use('/', require('./routes/patches'));

// AI discoverability — /llms.txt, /llms-full.txt, /.well-known/ai-plugin.json
app.use('/', require('./routes/ai-discoverability'));

// TuneOps notification preferences — GET/PUT prefs, POST mute, POST test
app.use('/api/tuneops/notifications', require('./routes/tuneops-notifications'));

// REST API v1 — read-only enterprise integration endpoints (health, tuneops, activity, team)
app.use('/api/v1', require('./routes/v1-api'));

// API key management — /settings/api page + /api/keys CRUD
app.use('/settings', require('./routes/settings-api'));
app.use('/', require('./routes/settings-api'));

// Compliance Reports — SOX change log, access audit, activity summary with PDF/CSV export
// Business + Enterprise tiers only; tier gate enforced inside the route.
app.use('/settings', require('./routes/compliance-reports'));
app.use('/', require('./routes/compliance-reports'));

// Alert Policies + Escalation Engine — configurable thresholds, multi-channel notifications
app.use('/api/alerts', require('./routes/alert-policies'));
app.use('/settings/alerts', require('./routes/alert-policies'));

// Activity Dashboard + Audit Log — unified action history, filters, CSV/PDF export
app.use('/', require('./routes/activity'));
app.use('/api', require('./routes/activity'));

// Agent one-line installer — provision/confirm/heartbeat/uninstall/status
app.use('/api/agent', require('./routes/agent'));

// Installer validation — public /status/installer page + CI result ingestion + admin trigger.
// GET /status/installer (public), GET /api/status/installer (JSON), POST /api/installer-validation/report (CI),
// POST /api/admin/installer-validation/run (admin trigger)
app.use('/', require('./routes/installer-validation'));
app.use('/api', require('./routes/installer-validation'));

// Ready-to-test go/no-go dashboard — operator-facing pre-test checklist.
// GET /status/ready-to-test (HTML, session-gated or ?token= magic token),
// GET /api/status/ready-to-test?conn=<name> (JSON: 6 badges, overall status)
app.use('/', require('./routes/ready-to-test'));
app.use('/api', require('./routes/ready-to-test'));

// Full Validation Suite — one-click coverage matrix for all checks + EBS + DB Ops + SSH paths.
// POST /api/connections/:id/validation-suite/run  → kick off async run
// GET  /api/connections/:id/validation-suite/runs → poll progress
// GET  /connections/:id/validation-suite/:run_id  → report page
// GET  /share/validation/:token                   → public share view
// GET  /api/validation/share/:token               → public share data
app.use('/api/connections', require('./routes/validation-suite'));
app.use('/', require('./routes/validation-suite'));

// Debug failure bundles — structured per-check error context (SQL+ORA error+traceback+proxy log).
// GET  /api/failure-bundles/:id           — fetch single bundle (auth required)
// GET  /api/failure-bundles/:id/markdown  — render as paste-ready markdown
// GET  /api/connections/:id/failure-bundles/badge — 24h failure count badge
// GET  /api/connections/:id/failure-bundles       — recent bundle list
// POST /api/internal/failure-bundle       — proxy-side ingestion (INTERNAL_API_KEY)
app.use('/', require('./routes/failure-bundles'));

// ADOP patch-cycle state: GET /api/connections/:id/adop-state,
// POST /api/connections/:id/adop-state/refresh, GET /api/adop-state/fleet,
// POST /api/adop-state/check-op
app.use('/api/connections', require('./routes/adop-state'));
app.use('/api/adop-state',  require('./routes/adop-state'));

// install.sh + uninstall.sh — served at root for curl | bash install pattern
app.get('/install.sh', (req, res) => {
  const filePath = path.join(__dirname, 'install.sh');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } else {
    res.status(404).send('# install.sh not found\n');
  }
});
// SHA-256 checksum of install.sh — used by `tunevault-proxy upgrade` to verify
// downloaded installer integrity before execution.
app.get('/install.sh.sha256', (req, res) => {
  const filePath = path.join(__dirname, 'install.sh');
  try {
    const content = fs.readFileSync(filePath);
    const hex = crypto.createHash('sha256').update(content).digest('hex');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`sha256:${hex}\n`);
  } catch (e) {
    res.status(404).send('# install.sh not found\n');
  }
});

app.get('/uninstall.sh', (req, res) => {
  const filePath = path.join(__dirname, 'uninstall.sh');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } else {
    res.status(404).send('# uninstall.sh not found\n');
  }
});

// API docs — public reference page (no auth required)
app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
});

// Convenience URL for manual agent upgrades: curl -fsSL .../oracle-proxy.py -o /opt/tunevault/oracle-proxy.py
app.get('/oracle-proxy.py', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'oracle-proxy.py'));
});

// Proxy downloads — serve proxy scripts for installation
app.get('/downloads/oracle-proxy.py', (req, res) => {
  const filePath = path.join(__dirname, 'oracle-proxy.py');
  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Disposition', 'attachment; filename="oracle-proxy.py"');
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/downloads/oracle-proxy.js', (req, res) => {
  const filePath = path.join(__dirname, 'oracle-proxy.js');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="oracle-proxy.js"');
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/downloads/oracle-proxy-install.sh', (req, res) => {
  const filePath = path.join(__dirname, 'oracle-proxy-install.sh');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="oracle-proxy-install.sh"');
    res.setHeader('Content-Type', 'text/plain');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Admin: health check requests list
app.get('/admin/requests', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'requests.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/');
  }
});

// Admin: users dashboard
app.get('/admin/users', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'users.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/');
  }
});

// Admin: checks catalogue browser
app.get('/admin/checks', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'checks.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/admin/users');
  }
});

// Admin: Razorpay E2E payment test dashboard
app.get('/admin/payments/last-test', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'payment-test.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/admin/users');
  }
});

// Admin: EBS validation smoke-test page
app.get('/admin/ebs-validation', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'ebs-validation.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/admin/users');
  }
});

// Admin: Roadmap reminders dashboard
app.get('/admin/roadmap', requireAdminPage, (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'admin', 'roadmap.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/admin/users');
  }
});

// robots.txt — allow public pages, block admin and API
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send([
    'User-agent: *',
    'Allow: /',
    'Allow: /pricing',
    'Allow: /blog',
    'Allow: /oracle-setup',
    'Allow: /security',
    'Allow: /security/commands',
    'Allow: /trust',
    'Allow: /request-health-check',
    'Allow: /features',
    'Allow: /login',
    'Allow: /signup',
    'Allow: /signin',
    'Allow: /fleet',
    'Allow: /sql-tuning',
    'Allow: /llms.txt',
    'Allow: /llms-full.txt',
    'Disallow: /admin/',
    'Disallow: /api/',
    'Disallow: /dashboard',
    'Disallow: /report',
    '',
    `Sitemap: https://tunevault.app/sitemap.xml`
  ].join('\n'));
});

// sitemap.xml — all public-facing pages + blog posts
app.get('/sitemap.xml', async (req, res) => {
  const pages = [
    { url: 'https://tunevault.app/', priority: '1.0', changefreq: 'weekly' },
    { url: 'https://tunevault.app/pricing', priority: '0.9', changefreq: 'monthly' },
    { url: 'https://tunevault.app/security', priority: '0.9', changefreq: 'monthly' },
    { url: 'https://tunevault.app/trust', priority: '0.9', changefreq: 'monthly' },
    { url: 'https://tunevault.app/features', priority: '0.8', changefreq: 'monthly' },
    { url: 'https://tunevault.app/security/commands', priority: '0.8', changefreq: 'monthly' },
    { url: 'https://tunevault.app/blog', priority: '0.8', changefreq: 'weekly' },
    { url: 'https://tunevault.app/oracle-setup', priority: '0.8', changefreq: 'monthly' },
    { url: 'https://tunevault.app/request-health-check', priority: '0.8', changefreq: 'monthly' },
    { url: 'https://tunevault.app/fleet', priority: '0.7', changefreq: 'monthly' },
    { url: 'https://tunevault.app/sql-tuning', priority: '0.7', changefreq: 'monthly' },
  ];
  const lastmod = new Date().toISOString().split('T')[0];
  let blogUrls = '';
  try {
    const { listSlugs } = require('./db/blog');
    const slugs = await listSlugs();
    blogUrls = slugs.map(s => {
      const mod = s.updated_at ? s.updated_at.toISOString().split('T')[0] : lastmod;
      return `  <url>\n    <loc>https://tunevault.app/blog/${encodeURIComponent(s.slug)}</loc>\n    <lastmod>${mod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
    }).join('\n');
  } catch (_) { /* blog table may not exist on first deploy */ }
  const urls = pages.map(p =>
    `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${p.changefreq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
  ).join('\n');
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}${blogUrls ? '\n' + blogUrls : ''}\n</urlset>`);
});

// llms.txt, llms-full.txt, ai-plugin.json — moved to routes/ai-discoverability.js

// nav-component.js carries auth-aware link rewrites — must never be stale in browser cache
app.get('/nav-component.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'nav-component.js'));
});

// Guard: block express.static from serving /admin/*.html to unauthenticated users.
// Named route handlers already use requireAdminPage, but express.static bypasses them
// when the request URL includes the .html extension (e.g. /admin/users.html).
// This middleware intercepts all /admin/** requests before the static file server
// and applies the same requireAdminPage gate — redirect to /signin?next=... if unauth.
app.use('/admin', requireAdminPage);

// Serve static files — no-cache on HTML to prevent stale report pages after deploy
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Landing page
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.json({ message: 'TuneVault - AI Oracle DBA' });
  }
});

// ============================================================
// API: Oracle Connection Management
// ============================================================

// Save a new Oracle connection (direct TCP or proxy/tunnel mode) — senior_dba+
app.post('/api/connections', requireAuth, requireRole('senior_dba'), enforceConnectionCap, connectionLimiter, validateBody(createConnectionSchema), async (req, res) => {
  try {
    const { name, host, port: dbPort, service_name, username, password,
            connection_type, proxy_url, proxy_api_key } = req.body;

    const isProxy = connection_type === 'proxy';

    if (!service_name || !username || !password) {
      return res.status(400).json({ error: 'Fields required: service_name, username, password' });
    }
    if (!isProxy && !host) {
      return res.status(400).json({ error: 'host is required for direct connections' });
    }
    // proxy_url is no longer required — agent-based connections use the outbound
    // long-poll channel and never need a direct URL to the proxy.
    if (isProxy && !proxy_api_key) {
      return res.status(400).json({ error: 'proxy_api_key is required for proxy connections' });
    }

    const encryptedPassword = encrypt(password);
    const encryptedProxyKey = proxy_api_key ? encrypt(proxy_api_key) : null;

    // For proxy connections use the proxy hostname as display host (if provided),
    // otherwise fall back to 'agent' placeholder since the outbound channel doesn't
    // need a reachable host.
    const effectiveHost = isProxy
      ? (proxy_url ? proxy_url.replace(/^https?:\/\//, '').split('/')[0] : 'agent')
      : host;
    const effectivePort = isProxy ? 443 : (dbPort || 1521);

    // Auto-generate display name if blank
    const displayName = (name || '').trim() || `${effectiveHost}/${service_name}`;

    const result = await pool.query(
      `INSERT INTO oracle_connections (name, host, port, service_name, username, encrypted_password,
        connection_type, proxy_url, proxy_api_key_enc, user_id, proxy_key_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, host, port, service_name, username, connection_type, proxy_url, created_at`,
      [displayName, effectiveHost, effectivePort, service_name, username, encryptedPassword,
       connection_type || 'direct', isProxy ? proxy_url : null, encryptedProxyKey, req.user.id,
       isProxy ? new Date() : null]
    );

    dbAnalytics.trackEvent({
      eventName: 'connection_added',
      userId: req.user.id,
      sessionId: req.cookies?.tv_sid || null,
      properties: { method: connection_type || 'direct' },
    }).catch(() => {});

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error saving connection:', err);
    res.status(500).json({ error: 'Failed to save connection' });
  }
});

// List saved connections — moved to routes/connections-list.js (Router-mounted at /api)

// Get a single connection — auth + ownership required
app.get('/api/connections/:id', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, host, port, service_name, username, oracle_version,
              last_tested_at, last_test_success, last_test_message, created_at,
              connection_type, proxy_url, proxy_version, is_ebs, ebs_opt_in, ebs_checks_enabled,
              schedule_enabled, schedule_cron, last_scheduled_run_at, next_scheduled_run_at,
              gi_os_user, gi_oracle_home, asm_sid, privilege_model
       FROM oracle_connections WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching connection:', err);
    res.status(500).json({ error: 'Failed to fetch connection' });
  }
});

// Connections list page — /connections (auth required)
// Card grid with server status, slide-out detail panel, add wizard.
app.get('/connections', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connections.html'));
});

// Must come before /connections/:id wildcard — prevents Express from
// treating /connections/new as a numeric ID.
app.get('/connections/new', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connections-new.html'));
});

// Connection detail (slide-out panel embedded in /connections page — no separate page)
// API-only: GET /api/connections/:id + /api/connections/:id/agent-status

// Reveal the stored proxy API key for a connection (sensitive — auth + ownership required)
// Also returns usage tracking: last_used_at, last_ip, recent_ips, key age in days
app.get('/api/connections/:id/api-key', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT connection_type, proxy_api_key_enc,
              proxy_key_last_used_at, proxy_key_last_ip, proxy_key_ips, proxy_key_created_at
       FROM oracle_connections WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    const conn = result.rows[0];
    if (conn.connection_type !== 'proxy') {
      return res.status(400).json({ error: 'This connection does not use a proxy API key' });
    }
    if (!conn.proxy_api_key_enc) {
      return res.status(404).json({ error: 'No API key stored for this connection' });
    }
    // Compute key age in days for rotation warning
    const keyCreatedAt = conn.proxy_key_created_at;
    const keyAgeDays = keyCreatedAt
      ? Math.floor((Date.now() - new Date(keyCreatedAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    res.json({
      api_key: decrypt(conn.proxy_api_key_enc),
      last_used_at: conn.proxy_key_last_used_at || null,
      last_ip: conn.proxy_key_last_ip || null,
      recent_ips: conn.proxy_key_ips || [],
      key_age_days: keyAgeDays,
      rotation_warning: keyAgeDays !== null && keyAgeDays >= 90,
    });
  } catch (err) {
    console.error('Error fetching api-key:', err);
    res.status(500).json({ error: 'Failed to retrieve API key' });
  }
});

// Update a saved connection — auth + ownership + senior_dba+ required
app.put('/api/connections/:id', requireAuth, requireRole('senior_dba'), requireConnectionOwner, connectionLimiter, validateBody(updateConnectionSchema), async (req, res) => {
  try {
    const { name, host, port: dbPort, service_name, username, password } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    const { proxy_url, proxy_api_key, ebs_checks_enabled, gi_os_user, gi_oracle_home, asm_sid, privilege_model, apps_pwd, weblogic_pwd, ebs_instance_name } = req.body;
    if (name) { updates.push(`name = $${idx++}`); values.push(name); }
    if (host) { updates.push(`host = $${idx++}`); values.push(host); }
    if (dbPort) { updates.push(`port = $${idx++}`); values.push(dbPort); }
    if (service_name) { updates.push(`service_name = $${idx++}`); values.push(service_name); }
    if (username) { updates.push(`username = $${idx++}`); values.push(username); }
    if (password) { updates.push(`encrypted_password = $${idx++}`); values.push(encrypt(password)); }
    if (proxy_url) { updates.push(`proxy_url = $${idx++}`); values.push(proxy_url); }
    if (proxy_api_key) {
      updates.push(`proxy_api_key_enc = $${idx++}`); values.push(encrypt(proxy_api_key));
      // Reset usage tracking when key is rotated
      updates.push(`proxy_key_created_at = $${idx++}`); values.push(new Date());
      updates.push(`proxy_key_last_used_at = $${idx++}`); values.push(null);
      updates.push(`proxy_key_last_ip = $${idx++}`); values.push(null);
      updates.push(`proxy_key_ips = $${idx++}`); values.push(JSON.stringify([]));
    }
    if (typeof ebs_checks_enabled === 'boolean') { updates.push(`ebs_checks_enabled = $${idx++}`); values.push(ebs_checks_enabled); }
    // Grid Infrastructure fields — null value clears the field (allows removing GI config)
    if ('gi_os_user' in req.body) { updates.push(`gi_os_user = $${idx++}`); values.push(gi_os_user || null); }
    if ('gi_oracle_home' in req.body) { updates.push(`gi_oracle_home = $${idx++}`); values.push(gi_oracle_home || null); }
    if ('asm_sid' in req.body) { updates.push(`asm_sid = $${idx++}`); values.push(asm_sid || null); }
    // privilege_model: 'reader' | 'sysdba' — controls which Oracle checks are available
    if (privilege_model) { updates.push(`privilege_model = $${idx++}`); values.push(privilege_model); }
    // EBS app-tier passwords — stored encrypted, sent to agent on each health check
    if (apps_pwd !== undefined) { updates.push(`apps_pwd_enc = $${idx++}`); values.push(apps_pwd ? encrypt(apps_pwd) : null); }
    if (weblogic_pwd !== undefined) { updates.push(`weblogic_pwd_enc = $${idx++}`); values.push(weblogic_pwd ? encrypt(weblogic_pwd) : null); }
    // EBS instance name — groups connections by instance (e.g. EBSDEV, EBSPROD)
    if ('ebs_instance_name' in req.body) { updates.push(`ebs_instance_name = $${idx++}`); values.push(ebs_instance_name || null); }
    updates.push(`updated_at = NOW()`);

    if (updates.length === 1) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE oracle_connections SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, name, host, port, service_name, username, privilege_model, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating connection:', err);
    res.status(500).json({ error: 'Failed to update connection' });
  }
});

// Delete a saved connection — auth + ownership required (no admin role gate).
// Connection owner can always delete their own connection regardless of team role.
// Full cascade in a single transaction:
//   1. Explicit DELETE for tables without FK constraints (no auto-cascade).
//   2. NULL out health_checks.connection_id (FK is NO ACTION — preserves history).
//   3. DELETE oracle_connections — triggers DB-level CASCADE on all other FK tables.
app.delete('/api/connections/:id', requireAuth, requireConnectionOwner, async (req, res) => {
  const connId = req.params.id;
  const userId = req.user ? req.user.id : null;
  const tag = `[delete-connection id=${connId} user=${userId}]`;
  console.log(`${tag} DELETE requested`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Confirm the connection exists before doing any work.
    const check = await client.query('SELECT id, name FROM oracle_connections WHERE id = $1', [connId]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      console.log(`${tag} 404 — not found`);
      return res.status(404).json({ error: 'Connection not found' });
    }
    const connName = check.rows[0].name;
    console.log(`${tag} found connection "${connName}", starting cascade`);

    // Step 2: Delete rows from tables that have no FK constraint on connection_id
    // (these won't cascade automatically and won't block deletion, but leave orphans).
    const noFkTables = [
      'credential_access_log',
      'finding_history',
      'sql_audit_log',
      'sql_console_history',
      'tuneops_notification_mutes',
    ];
    for (const tbl of noFkTables) {
      const r = await client.query(`DELETE FROM ${tbl} WHERE connection_id = $1`, [connId]);
      console.log(`${tag} deleted ${r.rowCount} rows from ${tbl}`);
    }

    // Step 3: NULL out health_checks.connection_id — FK is NO ACTION so must precede DELETE.
    // Preserves run history; rows become connection-orphaned audit records.
    const hcResult = await client.query(
      'UPDATE health_checks SET connection_id = NULL WHERE connection_id = $1',
      [connId]
    );
    console.log(`${tag} nulled connection_id on ${hcResult.rowCount} health_checks rows`);

    // Step 4: Delete the connection. All remaining FK tables (CASCADE) auto-clean:
    // agent_tunnels, addm_runs, advisor_findings, agent_command_results, agent_crash_alerts_sent,
    // agent_diagnose_runs, agent_reg_tokens, agent_upgrade_audit, alert_events, alert_policies,
    // check_failure_bundles, check_results, connection_health_runs, connection_schedules,
    // connection_ssh_profiles, ebs_adop_state, ebs_credentials, ebs_deep_reports, ebs_sanity_runs,
    // install_jobs (SET NULL), listener_preflight_runs, proxy_exec_audit, smoke_test_runs,
    // sql_tuning_findings, ssh_install_credentials, ssh_targets (SET NULL), tns_topology_snapshots,
    // tuneops_tickets (SET NULL), validation_runs, activity_log (SET NULL), clone_recipes (SET NULL).
    const result = await client.query(
      'DELETE FROM oracle_connections WHERE id = $1 RETURNING id',
      [connId]
    );

    await client.query('COMMIT');
    console.log(`${tag} committed — connection "${connName}" fully deleted`);
    res.json({ deleted: true, id: connId, name: connName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${tag} FAILED — rolled back:`, err.message);
    res.status(500).json({ error: 'Failed to delete connection' });
  } finally {
    client.release();
  }
});

// Toggle EBS opt-in for a saved connection — auth + ownership + senior_dba+
app.patch('/api/connections/:id/ebs-opt-in', requireAuth, requireRole('senior_dba'), requireConnectionOwner, async (req, res) => {
  try {
    const { ebs_opt_in } = req.body;
    if (typeof ebs_opt_in !== 'boolean') {
      return res.status(400).json({ error: 'ebs_opt_in must be a boolean' });
    }
    const result = await pool.query(
      `UPDATE oracle_connections SET ebs_opt_in = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, ebs_opt_in`,
      [ebs_opt_in, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating EBS opt-in:', err);
    res.status(500).json({ error: 'Failed to update EBS opt-in' });
  }
});

// Save Grid Infrastructure credentials for a connection — senior_dba+
// Fields are optional — sending null/empty string clears the field (removes GI config).
app.patch('/api/connections/:id/gi-credentials', requireAuth, requireRole('senior_dba'), requireConnectionOwner, async (req, res) => {
  try {
    const { gi_os_user, gi_oracle_home, asm_sid } = req.body;
    const result = await pool.query(
      `UPDATE oracle_connections
          SET gi_os_user    = $1,
              gi_oracle_home = $2,
              asm_sid        = $3,
              updated_at     = NOW()
        WHERE id = $4
       RETURNING id, gi_os_user, gi_oracle_home, asm_sid`,
      [gi_os_user || null, gi_oracle_home || null, asm_sid || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating GI credentials:', err);
    res.status(500).json({ error: 'Failed to update GI credentials' });
  }
});

// Toggle per-connection EBS checks (APPS schema probing) — auth + ownership + senior_dba+
app.patch('/api/connections/:id/ebs-checks', requireAuth, requireRole('senior_dba'), requireConnectionOwner, async (req, res) => {
  try {
    const { ebs_checks_enabled } = req.body;
    if (typeof ebs_checks_enabled !== 'boolean') {
      return res.status(400).json({ error: 'ebs_checks_enabled must be a boolean' });
    }
    const result = await pool.query(
      `UPDATE oracle_connections SET ebs_checks_enabled = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, ebs_checks_enabled`,
      [ebs_checks_enabled, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating EBS checks enabled:', err);
    res.status(500).json({ error: 'Failed to update EBS checks setting' });
  }
});

// ============================================================
// Check History Endpoints
// ============================================================

// GET /api/connections/:id/history?check_id=&from=&to=&limit=
// Time series for a single check_id on a connection
app.get('/api/connections/:id/history', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);
    const { check_id, from, to, limit = 100 } = req.query;

    let query = `
      SELECT id, run_id, check_id, check_category, status,
             metric_name, metric_value, metric_unit,
             ai_summary, recommendation, executed_at
      FROM check_results
      WHERE connection_id = $1
    `;
    const params = [connId];
    let p = 2;

    if (check_id) {
      query += ` AND check_id = $${p++}`;
      params.push(check_id);
    }
    if (from) {
      query += ` AND executed_at >= $${p++}`;
      params.push(from);
    }
    if (to) {
      query += ` AND executed_at <= $${p++}`;
      params.push(to);
    }

    const safeLimit = Math.min(parseInt(limit, 10) || 100, 1000);
    query += ` ORDER BY executed_at DESC LIMIT $${p++}`;
    params.push(safeLimit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching check history:', err);
    res.status(500).json({ error: 'Failed to fetch check history' });
  }
});

// GET /api/connections/:id/runs
// List of recent health check runs with summary counts (green/amber/red per run)
app.get('/api/connections/:id/runs', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const result = await pool.query(
      `SELECT
         run_id,
         MIN(executed_at) AS executed_at,
         COUNT(*) AS total_checks,
         COUNT(*) FILTER (WHERE status = 'green') AS green,
         COUNT(*) FILTER (WHERE status = 'amber') AS amber,
         COUNT(*) FILTER (WHERE status = 'red') AS red,
         COUNT(*) FILTER (WHERE status = 'error') AS error
       FROM check_results
       WHERE connection_id = $1
       GROUP BY run_id
       ORDER BY executed_at DESC
       LIMIT $2`,
      [connId, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching runs:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// DELETE /api/connections/:id/health-history/:runId — remove a single run's check_results rows
app.delete('/api/connections/:id/health-history/:runId', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);
    const { runId } = req.params;
    // UUID format guard — prevents arbitrary string injection into query
    if (!/^[0-9a-f-]{36}$/.test(runId)) return res.status(400).json({ error: 'Invalid run ID' });
    const result = await pool.query(
      'DELETE FROM check_results WHERE connection_id = $1 AND run_id = $2',
      [connId, runId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Run not found' });
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Error deleting run:', err);
    res.status(500).json({ error: 'Failed to delete run' });
  }
});

// DELETE /api/connections/:id/health-history — clear all run history for a connection
app.delete('/api/connections/:id/health-history', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);
    const result = await pool.query(
      'DELETE FROM check_results WHERE connection_id = $1',
      [connId]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Error clearing history:', err);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// GET /api/connections/:id/trends
// Precomputed deltas: current vs 7d ago vs 30d ago for key checks
app.get('/api/connections/:id/trends', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const connId = parseInt(req.params.id, 10);

    // Key checks that are worth trending (across all 15 categories)
    const TREND_CHECKS = [
      // Storage
      'ST01_TABLESPACE_USAGE',
      'ST02_UNDO_USAGE',
      'ST03_TEMP_USAGE',
      'ST04_SEGMENT_GROWTH',
      'ST05_DATAFILE_STATUS',
      // Performance
      'PF01_WAIT_EVENTS',
      'PF02_SQL_PERFORMANCE',
      'PF03_ACTIVE_SESSIONS',
      'PF04_HARD_PARSE_RATE',
      'PF05_CPU_USAGE',
      'PF06_IO_WAIT',
      'PF08_LIBRARY_CACHE',
      'PF09_LONG_RUNNING_SQL',
      'PF10_BUFFER_CACHE',
      'PF11_DISK_SORTS',
      'PF12_FULL_TABLE_SCANS',
      // Memory
      'MEM01_SGA_PGA',
      'MEM02_SHARED_POOL_FREE',
      'MEM03_PGA_OVERALLOC',
      'MEM04_BUFFER_CACHE_HIT',
      'MEM05_SGA_COMPONENTS',
      // Backup
      'BK01_RMAN_FRESHNESS',
      'BK02_FRA_USAGE',
      'BK03_ARCHIVELOG_RATE',
      'BK04_BACKUP_VALIDATION',
      // Observability
      'OB01_DB_UPTIME',
      'OB03_INVALID_OBJECTS',
      'OB04_STALE_STATS',
      'OB05_REDO_LOG_SWITCHES',
      'OB06_BLOCKING_LOCKS',
      'OB07_SESSION_COUNT',
      'OB09_SCN_HEADROOM',
      // Indexes
      'IX01_INDEX_HEALTH',
      'IX02_UNUSABLE_INDEXES',
      'IX03_INDEX_BLOAT',
      // Config
      'CF01_ALERT_LOG',
      'CF02_INIT_PARAMS',
      'CF04_UNDO_RETENTION',
      'CF05_REDO_LOG_CONFIG',
      'CF06_RESOURCE_LIMITS',
      // Security
      'SEC01_DEFAULT_PASSWORDS',
      'SEC02_PUBLIC_PRIVILEGES',
      'SEC03_AUDIT_TRAIL',
      'SEC04_PASSWORD_POLICY',
      'SEC05_DBA_USERS',
    ];

    // Fetch the most recent run for each check, within 3 time windows
    const result = await pool.query(
      `WITH ranked AS (
         SELECT
           check_id,
           check_category,
           status,
           metric_name,
           metric_value,
           metric_unit,
           ai_summary,
           executed_at,
           ROW_NUMBER() OVER (PARTITION BY check_id ORDER BY executed_at DESC) AS rn_current,
           ROW_NUMBER() OVER (PARTITION BY check_id ORDER BY
             CASE WHEN executed_at <= NOW() - INTERVAL '7 days' THEN executed_at END DESC NULLS LAST
           ) AS rn_7d,
           ROW_NUMBER() OVER (PARTITION BY check_id ORDER BY
             CASE WHEN executed_at <= NOW() - INTERVAL '30 days' THEN executed_at END DESC NULLS LAST
           ) AS rn_30d
         FROM check_results
         WHERE connection_id = $1
           AND check_id = ANY($2::text[])
       )
       SELECT
         check_id,
         check_category,
         MAX(CASE WHEN rn_current = 1 THEN status END) AS current_status,
         MAX(CASE WHEN rn_current = 1 THEN metric_value END) AS current_value,
         MAX(CASE WHEN rn_current = 1 THEN metric_unit END) AS metric_unit,
         MAX(CASE WHEN rn_current = 1 THEN metric_name END) AS metric_name,
         MAX(CASE WHEN rn_current = 1 THEN ai_summary END) AS current_summary,
         MAX(CASE WHEN rn_current = 1 THEN executed_at END) AS current_at,
         MAX(CASE WHEN rn_7d = 1 AND executed_at <= NOW() - INTERVAL '7 days' THEN metric_value END) AS value_7d_ago,
         MAX(CASE WHEN rn_7d = 1 AND executed_at <= NOW() - INTERVAL '7 days' THEN status END) AS status_7d_ago,
         MAX(CASE WHEN rn_30d = 1 AND executed_at <= NOW() - INTERVAL '30 days' THEN metric_value END) AS value_30d_ago,
         MAX(CASE WHEN rn_30d = 1 AND executed_at <= NOW() - INTERVAL '30 days' THEN status END) AS status_30d_ago
       FROM ranked
       GROUP BY check_id, check_category
       ORDER BY check_category, check_id`,
      [connId, TREND_CHECKS]
    );

    // Annotate with computed deltas
    const trends = result.rows.map(row => {
      const curr = row.current_value != null ? parseFloat(row.current_value) : null;
      const v7d = row.value_7d_ago != null ? parseFloat(row.value_7d_ago) : null;
      const v30d = row.value_30d_ago != null ? parseFloat(row.value_30d_ago) : null;
      return {
        ...row,
        delta_7d: curr != null && v7d != null ? +(curr - v7d).toFixed(2) : null,
        delta_30d: curr != null && v30d != null ? +(curr - v30d).toFixed(2) : null
      };
    });

    res.json(trends);
  } catch (err) {
    console.error('Error fetching trends:', err);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

// Test an Oracle connection (can test saved or ad-hoc — both direct and proxy) — auth required
app.post('/api/connections/test', requireAuth, async (req, res) => {
  try {
    let { host, port: dbPort, service_name, username, password, connection_id,
          connection_type, proxy_url, proxy_api_key } = req.body;

    // If connection_id provided, load saved connection details — enforce ownership
    if (connection_id) {
      const connResult = await pool.query(
        'SELECT host, port, service_name, username, encrypted_password, connection_type, proxy_url, proxy_api_key_enc FROM oracle_connections WHERE id = $1 AND user_id = $2',
        [connection_id, req.user.id]
      );
      if (connResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Saved connection not found' });
      }
      const conn = connResult.rows[0];
      host = conn.host;
      dbPort = conn.port;
      service_name = conn.service_name;
      username = conn.username;
      password = decrypt(conn.encrypted_password);
      connection_type = conn.connection_type;
      proxy_url = conn.proxy_url;
      proxy_api_key = conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null;
    }

    const isProxy = connection_type === 'proxy';

    if (isProxy) {
      // Test proxy connection — try agent channel first, fall back to direct HTTP
      if (!connection_id && (!proxy_url || !proxy_api_key)) {
        return res.status(400).json({ success: false, message: 'proxy_url and proxy_api_key are required for proxy connections' });
      }

      // All proxy connections route through the outbound agent channel only.
      // Direct inbound HTTP to proxy_url is retired — agents expose no inbound ports.
      if (!connection_id || !agentChannel.isAgentConnected(connection_id)) {
        return res.status(503).json({
          success: false,
          message: 'Agent is not connected. The TuneVault Agent connects outbound — no firewall rules needed. Wait up to 30 seconds after install, then retry.'
        });
      }

      let result;
      try {
        // /api/test retired in proxy v3.5.7 — use /api/ping (lightweight, no catalog access)
        const channelResp = await agentChannel.sendToAgent(connection_id, {
          method: 'POST',
          path: '/api/ping',
          body: { service_name, username, password },
        }, 30000);
        result = channelResp.body || { success: false, message: 'Empty response from agent' };
      } catch (chErr) {
        result = { success: false, message: `Agent channel error: ${chErr.message}` };
      }

      if (connection_id) {
        // Fetch live proxy version via channel
        let liveProxyVersion = null;
        try {
          const hResp = await agentChannel.sendToAgent(connection_id, {
            method: 'GET', path: '/health', body: {},
          }, 10000);
          liveProxyVersion = (hResp.body || {}).proxy_version || null;
        } catch { /* non-critical */ }

        await pool.query(
          `UPDATE oracle_connections SET last_tested_at = NOW(), last_test_success = $1, last_test_message = $2, oracle_version = $3, proxy_version = COALESCE($4, proxy_version) WHERE id = $5`,
          [result.success, result.message, result.version || null, liveProxyVersion, connection_id]
        );
      }
      return res.json(result);
    }

    // Direct connection
    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({
        success: false,
        message: 'Oracle client not available. The oracledb package may not be installed yet.'
      });
    }

    if (!host || !service_name || !username || !password) {
      return res.status(400).json({ success: false, message: 'host, service_name, username, and password are required' });
    }

    const result = await oracle.testConnection({
      host, port: dbPort || 1521, serviceName: service_name, username, password
    });

    if (connection_id) {
      await pool.query(
        `UPDATE oracle_connections SET last_tested_at = NOW(), last_test_success = $1, last_test_message = $2, oracle_version = $3 WHERE id = $4`,
        [result.success, result.message, result.version || null, connection_id]
      );
    }

    res.json(result);
  } catch (err) {
    console.error('Error testing connection:', err);
    res.status(500).json({ success: false, message: 'Internal error testing connection' });
  }
});

// ============================================================
// API: RBAC Role Endpoint
// ============================================================

// GET /api/me/role — returns current user's team role and permissions.
// Individual accounts (not on a team) return role: null, meaning full access (admin-equivalent).
// Used by frontend to gate action buttons.
app.get('/api/me/role', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.role
       FROM team_members tm
       JOIN users u ON u.team_id = tm.team_id
       WHERE u.id = $1 AND tm.user_id = $1
       LIMIT 1`,
      [req.user.id]
    );
    const role = rows.length > 0 ? rows[0].role : null;
    const isTeamMember = role !== null;

    // Permission set derived from role (or full access for individual accounts)
    const rank = isTeamMember ? ['viewer', 'junior_dba', 'senior_dba', 'admin'].indexOf(role) : 3;

    res.json({
      role,                                 // null = individual (full access)
      is_team_member: isTeamMember,
      permissions: {
        run_health_checks:           rank >= 1,
        export_reports:              rank >= 1,
        run_sql_tuning:              rank >= 1,
        execute_db_ops_read:         rank >= 1,
        execute_db_ops_write:        rank >= 2,
        execute_ebs_control:         rank >= 2,
        kill_sessions:               rank >= 2,
        execute_ssh:                 rank >= 2,
        manage_connections:          rank >= 2,
        delete_connections:          rank >= 3,
        manage_ssh_targets:          rank >= 2,
        configure_monitoring:        rank >= 2,
        manage_team:                 rank >= 3,
        manage_billing:              rank >= 3,
      },
    });
  } catch (err) {
    console.error('[api/me/role] error:', err.message);
    res.status(500).json({ error: 'Failed to load role' });
  }
});

// ============================================================
// API: Health Check Endpoints
// ============================================================

// ============================================================
// Rate limiting helpers
// ============================================================

// Check and increment demo run count for a user. Returns {allowed, runs_today}
async function checkDemoRateLimit(userId, userEmail) {
  // Admin bypass — unlimited access for admin users
  if (userEmail && ADMIN_EMAILS.has(userEmail.toLowerCase().trim())) {
    return { allowed: true, runs_today: 0 };
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const DEMO_DAILY_LIMIT = 3;
  const result = await pool.query(
    `INSERT INTO demo_runs (user_id, run_date, run_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, run_date)
     DO UPDATE SET run_count = demo_runs.run_count + 1
     RETURNING run_count`,
    [userId, today]
  );
  const runCount = result.rows[0].run_count;
  if (runCount > DEMO_DAILY_LIMIT) {
    // Undo the increment
    await pool.query(
      `UPDATE demo_runs SET run_count = run_count - 1 WHERE user_id = $1 AND run_date = $2`,
      [userId, today]
    );
    return { allowed: false, runs_today: DEMO_DAILY_LIMIT };
  }
  return { allowed: true, runs_today: runCount };
}

// Check and increment company HC usage. Returns {allowed, hc_count}
async function checkCompanyHCLimit(companyDomain) {
  if (!companyDomain) return { allowed: true, hc_count: 0 };
  const HC_FREE_LIMIT = 5; // free tier: 5 checks/month
  const result = await pool.query(
    `INSERT INTO company_hc_usage (company_domain, hc_count, first_run_at, last_run_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (company_domain)
     DO UPDATE SET hc_count = company_hc_usage.hc_count + 1, last_run_at = NOW()
     RETURNING hc_count`,
    [companyDomain]
  );
  const hcCount = result.rows[0].hc_count;
  if (hcCount > HC_FREE_LIMIT) {
    // Undo increment
    await pool.query(
      `UPDATE company_hc_usage SET hc_count = hc_count - 1 WHERE company_domain = $1`,
      [companyDomain]
    );
    return { allowed: false, hc_count: HC_FREE_LIMIT };
  }
  return { allowed: true, hc_count: hcCount };
}

// Check and decrement HC quota for a user. Returns {allowed, hc_count, plan_tier}
// Paid users: debit user_credits. Free users: debit company_hc_usage (per-company-domain).
const dbPayments = require('./db/payments');
const dbAnalytics = require('./db/analytics');

// Personal email domains that should NOT be treated as a shared company bucket.
// Users on these domains each get their own 5 free checks via user_hc_usage.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'proton.me',
  'aol.com', 'yandex.com', 'yandex.ru', 'mail.com', 'zoho.com',
  'tutanota.com', 'fastmail.com', 'hey.com',
]);

async function checkUserHCLimit(userEmail, userId, companyDomain) {
  if (!userEmail) return { allowed: true, hc_count: 0, plan_tier: 'free' };
  // Admin bypass — unlimited access for admin users
  if (ADMIN_EMAILS.has(userEmail.toLowerCase().trim())) {
    return { allowed: true, hc_count: 0, plan_tier: 'custom' };
  }

  // Paid plan check: if user has a user_credits row, use it
  if (userId) {
    const credits = await dbPayments.getUserCredits(userId);
    if (credits && ['starter', 'growth', 'scale', 'custom'].includes(credits.plan_tier)) {
      if (credits.checks_remaining <= 0) {
        return { allowed: false, hc_count: 0, plan_tier: credits.plan_tier };
      }
      // Decrement credit (unlimited plans use sentinel — decrementUserCredit handles it)
      const updated = await dbPayments.decrementUserCredit(userId);
      if (!updated) {
        return { allowed: false, hc_count: 0, plan_tier: credits.plan_tier };
      }
      return { allowed: true, hc_count: updated.checks_remaining, plan_tier: updated.plan_tier };
    }
  }

  const HC_FREE_LIMIT = 5;
  // Free tier: track per company domain (business emails share a company quota).
  // Personal email domains (gmail, yahoo, etc.) get individual per-email tracking.
  const emailDomain = (userEmail.split('@')[1] || '').toLowerCase().trim();
  const effectiveDomain = companyDomain || emailDomain;
  const isPersonalDomain = PERSONAL_EMAIL_DOMAINS.has(emailDomain);

  if (!isPersonalDomain && effectiveDomain) {
    // Business domain: shared quota across all users at that company
    const result = await pool.query(
      `INSERT INTO company_hc_usage (company_domain, hc_count, first_run_at, last_run_at)
       VALUES ($1, 1, NOW(), NOW())
       ON CONFLICT (company_domain)
       DO UPDATE SET hc_count = company_hc_usage.hc_count + 1, last_run_at = NOW()
       RETURNING hc_count`,
      [effectiveDomain]
    );
    const hcCount = result.rows[0].hc_count;
    if (hcCount > HC_FREE_LIMIT) {
      await pool.query(
        `UPDATE company_hc_usage SET hc_count = hc_count - 1 WHERE company_domain = $1`,
        [effectiveDomain]
      );
      return { allowed: false, hc_count: HC_FREE_LIMIT, plan_tier: 'free' };
    }
    return { allowed: true, hc_count: hcCount, plan_tier: 'free' };
  }

  // Personal domain: per-email quota via user_hc_usage
  const normalizedEmail = userEmail.toLowerCase().trim();
  const result = await pool.query(
    `INSERT INTO user_hc_usage (user_email, hc_count, first_run_at, last_run_at)
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT (user_email)
     DO UPDATE SET hc_count = user_hc_usage.hc_count + 1, last_run_at = NOW()
     RETURNING hc_count`,
    [normalizedEmail]
  );
  const hcCount = result.rows[0].hc_count;
  if (hcCount > HC_FREE_LIMIT) {
    await pool.query(
      `UPDATE user_hc_usage SET hc_count = hc_count - 1 WHERE user_email = $1`,
      [normalizedEmail]
    );
    return { allowed: false, hc_count: HC_FREE_LIMIT, plan_tier: 'free' };
  }
  return { allowed: true, hc_count: hcCount, plan_tier: 'free' };
}

// Optional auth middleware — attaches req.user if valid token present, no error if missing
async function optionalAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return next();
  const payload = verifyToken(token);
  if (!payload) return next();
  try {
    const result = await pool.query('SELECT id, email, name, company_domain FROM users WHERE id = $1', [payload.userId]);
    if (result.rows.length > 0) req.user = result.rows[0];
  } catch {}
  next();
}

// Create a new health check (demo mode or real Oracle connection) — junior_dba+
app.post('/api/health-checks', requireAuth, requireRole('junior_dba'), enforceHealthCheckCap, async (req, res) => {
  try {
    const { connection_name, host, port: dbPort, service_name, username, password, connection_id, is_demo } = req.body;

    if (!connection_name && !connection_id) {
      return res.status(400).json({ error: 'connection_name or connection_id is required' });
    }

    // Determine the connection name for display
    let displayName = connection_name;

    if (is_demo) {
      // Demo mode — check rate limit (3 runs/day per user)
      const rateLimit = await checkDemoRateLimit(req.user.id, req.user.email);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          error: 'Demo limit reached',
          message: 'You\'ve used all 3 free demo runs for today. Come back tomorrow, or connect your own Oracle instance.',
          limit: 3
        });
      }

      // Demo mode — always use deterministic seeded data (no VM/Oracle dependency).
      // Metrics, scores, AI analysis, and executive summary are all pre-seeded so
      // results are identical every time, for every user, with no external calls required.
      const metrics = getDemoMetrics();
      const scores = getSummaryScores(metrics);
      const analysis = getDemoAnalysis();
      const { summary_text: demoSummaryText, top_action: demoTopAction, ebs_summary: demoEbsSummary, ebs_action: demoEbsAction } = getDemoExecutiveSummary();
      const demoRecs = getDemoRecommendations();

      const result = await pool.query(
        `INSERT INTO health_checks (connection_name, host, port, service_name, is_demo, metrics, overall_score, ai_analysis, summary_text, top_action, ebs_summary, ebs_action, ai_recommendations, status, completed_at, username)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, 'completed', NOW(), 'demo')
         RETURNING *`,
        [
          displayName || 'Demo: Production OLTP',
          'demo.tunevault.internal',
          1521,
          'PRODDB01',
          JSON.stringify(metrics),
          scores.overall,
          analysis,
          demoSummaryText,
          demoTopAction,
          demoEbsSummary,
          demoEbsAction,
          JSON.stringify(demoRecs)
        ]
      );

      const healthCheck = result.rows[0];

      // Seed demo TuneOps tickets once per demo company (idempotent)
      seedDemoTickets(null).catch(err => {
        console.error('[tuneops-engine] seedDemoTickets error:', err.message);
      });

      return res.json({
        id: healthCheck.id,
        connection_name: healthCheck.connection_name,
        status: 'completed',
        overall_score: scores.overall,
        scores,
        message: 'Demo health check complete.'
      });
    }

    // Real Oracle connection — enforce plan quota (paid plans use user_credits; free tier uses company_hc_usage)
    const hcLimit = await checkUserHCLimit(req.user.email, req.user.id, req.user.company_domain);
    if (!hcLimit.allowed) {
      const isPaid = ['starter', 'growth', 'scale', 'custom'].includes(hcLimit.plan_tier);
      // Include last completed check ID so frontend can fetch personalized upgrade hook
      let lastCheckId = null;
      try {
        if (req.user.id) {
          const lcRes = await pool.query(
            `SELECT hc.id FROM health_checks hc
             JOIN oracle_connections oc ON hc.connection_id = oc.id
             WHERE oc.user_id = $1 AND hc.status = 'completed' AND hc.is_demo = false
             ORDER BY hc.completed_at DESC LIMIT 1`,
            [req.user.id]
          );
          lastCheckId = lcRes.rows[0]?.id || null;
        }
      } catch { /* non-blocking — modal falls back to generic if missing */ }
      dbAnalytics.trackEvent({
        eventName: 'free_tier_limit_hit',
        userId: req.user?.id || null,
        sessionId: req.cookies?.tv_sid || null,
        properties: { plan_tier: hcLimit.plan_tier },
      }).catch(() => {});
      return res.status(429).json({
        error: isPaid ? 'Plan quota reached' : 'Free health check limit reached',
        message: isPaid
          ? `You have used all your ${hcLimit.plan_tier} plan checks for this billing period. Upgrade or wait for renewal.`
          : 'You have used all 5 free health checks this month. Upgrade to run more.',
        plan_tier: hcLimit.plan_tier,
        last_check_id: lastCheckId,
      });
    }

    // Real Oracle connection — if a saved connection_id was provided, verify ownership before proceeding
    if (connection_id) {
      const ownerCheck = await pool.query(
        'SELECT id FROM oracle_connections WHERE id = $1 AND user_id = $2 LIMIT 1',
        [connection_id, req.user.id]
      );
      if (ownerCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Access denied: you do not own this connection' });
      }
    }

    // Real Oracle connection — resolve connection details
    let connHost = host;
    let connPort = dbPort || 1521;
    let connService = service_name;
    let connUsername = username;
    let connPassword = password;
    let connId = connection_id || null;

    let connConnectionType = 'direct';
    let connProxyUrl = null;
    let connProxyApiKey = null;
    let connServerType = null;
    let connAppsPwd = null;
    let connWeblogicPwd = null;
    let isAgentConnection = false; // agent-installed: proxy on Oracle box, may lack credentials

    // Support inline proxy mode (no saved connection)
    const { connection_type: inlineConnType, proxy_url: inlineProxyUrl, proxy_api_key: inlineProxyApiKey } = req.body;
    if (inlineConnType === 'proxy') {
      connConnectionType = 'proxy';
      connProxyUrl = inlineProxyUrl;
      connProxyApiKey = inlineProxyApiKey;
    }

    if (connection_id) {
      const connResult = await pool.query(
        'SELECT id, name, host, port, service_name, username, encrypted_password, connection_type, proxy_url, proxy_api_key_enc, server_type, apps_pwd_enc, weblogic_pwd_enc FROM oracle_connections WHERE id = $1 AND user_id = $2',
        [connection_id, req.user.id]
      );
      if (connResult.rows.length === 0) {
        return res.status(404).json({ error: 'Saved connection not found' });
      }
      const conn = connResult.rows[0];
      connHost = conn.host;
      connPort = conn.port || 1521;
      connService = conn.service_name;
      connUsername = conn.username;
      // Safely decrypt — agent-only connections have NULL encrypted_password
      connPassword = conn.encrypted_password ? decrypt(conn.encrypted_password) : null;
      displayName = displayName || conn.name;
      connId = conn.id;
      connConnectionType = conn.connection_type || 'direct';
      connProxyUrl = conn.proxy_url;
      connProxyApiKey = conn.proxy_api_key_enc ? decrypt(conn.proxy_api_key_enc) : null;
      connServerType = conn.server_type || null;
      connAppsPwd     = conn.apps_pwd_enc     ? decrypt(conn.apps_pwd_enc)     : null;
      connWeblogicPwd = conn.weblogic_pwd_enc ? decrypt(conn.weblogic_pwd_enc) : null;

      // Detect agent connection: proxy type with missing Oracle credentials
      // Agent-installed connections have the proxy running locally on the Oracle box;
      // it uses OS auth (/ as sysdba) so explicit credentials are not required.
      if (connConnectionType === 'proxy' && !connUsername && !conn.encrypted_password) {
        isAgentConnection = true;
        // Pull SIDs from agent_tunnels if service_name is missing
        if (!connService) {
          try {
            const tunnelResult = await pool.query(
              'SELECT oracle_sids, dns_hostname FROM agent_tunnels WHERE connection_id = $1',
              [connection_id]
            );
            if (tunnelResult.rows.length > 0) {
              const tunnel = tunnelResult.rows[0];
              const sids = tunnel.oracle_sids || [];
              if (sids.length > 0) {
                connService = sids[0]; // Use first detected SID
              }
            }
          } catch { /* non-fatal — proxy will auto-detect from /etc/oratab */ }
        }
      }
    }

    const isProxy = connConnectionType === 'proxy';

    if (!isProxy && !connHost) {
      return res.status(400).json({ error: 'Oracle connection details required (host, service_name, username, password)' });
    }
    // Agent connections use OS auth via the proxy — credentials not required
    if (!isAgentConnection && (!connService || !connUsername || !connPassword)) {
      return res.status(400).json({ error: 'Oracle connection details required (service_name, username, password)' });
    }
    // Schema-level guard: agent connections route ONLY through the outbound channel.
    // If the agent hasn't checked in yet, fail fast with a clear message instead of
    // timing out after 3 minutes trying to reach an inbound port that doesn't exist.
    if (isProxy && connId && !agentChannel.isAgentConnected(connId) && false) {
      return res.status(503).json({
        error: 'Agent is not connected. The TuneVault Agent connects outbound — no inbound firewall ports are needed. Wait up to 30 seconds for the agent to check in, then retry.'
      });
    }

    if (isProxy && !connProxyUrl) {
      // proxy_url is deprecated for outbound-channel agents but still checked for legacy rows
      // (direct-install proxies with an explicit hostname). Tolerate missing value gracefully.
      console.warn(`[hc] conn=${connId} has no proxy_url — outbound channel only`);
    }
    // Resolve placeholder proxy_url — agent may have registered since connection was created.
    // NOTE: proxy_url is deprecated; agent channel is the sole communication path.
    // This block remains to tolerate existing rows that still have the placeholder value.
    if (isProxy && connProxyUrl === 'https://pending.tunevault.agent') {
      let resolved = false;
      if (connId) {
        try {
          // Priority 1: tunnel DNS hostname (secure HTTPS via Cloudflare)
          const tunnelRow = await pool.query(
            `SELECT dns_hostname FROM agent_tunnels WHERE connection_id = $1 AND dns_hostname IS NOT NULL AND status IN ('provisioned','confirmed','active')`,
            [connId]
          );
          if (tunnelRow.rows.length > 0 && tunnelRow.rows[0].dns_hostname) {
            connProxyUrl = `https://${tunnelRow.rows[0].dns_hostname}`;
            resolved = true;
          }
          // Priority 2: connection's host field (direct HTTP to proxy port)
          // Skip for app server connections — host is the remote DB host, not the proxy address.
          if (!resolved && connServerType !== 'apps' && connHost && connHost !== 'pending.tunevault.agent') {
            connProxyUrl = `http://${connHost}:3100`;
            resolved = true;
          }
          // Priority 3: agent polling channel active — no proxy_url needed
          if (!resolved) {
            const agentActive = await pool.query(
              `SELECT id FROM agent_tunnels WHERE connection_id = $1 AND status = 'active' LIMIT 1`,
              [connId]
            );
            if (agentActive.rows.length > 0) {
              resolved = true;
              connProxyUrl = null;
            }
          }
          // Persist resolved URL so future health checks don't hit this path
          if (resolved && connProxyUrl) {
            await pool.query(
              `UPDATE oracle_connections SET proxy_url = $1, updated_at = NOW() WHERE id = $2 AND proxy_url = 'https://pending.tunevault.agent'`,
              [connProxyUrl, connId]
            );
          } else if (resolved && !connProxyUrl) {
            await pool.query(
              `UPDATE oracle_connections SET proxy_url = NULL, updated_at = NOW() WHERE id = $1 AND proxy_url = 'https://pending.tunevault.agent'`,
              [connId]
            );
          }
        } catch (_resolveErr) {
          // Non-fatal — fall through to error message
          console.warn('[hc] proxy_url resolve failed:', _resolveErr.message);
        }
      }
      if (!resolved) {
        return res.status(400).json({
          error: 'Agent proxy is not yet registered. Please wait for the agent installer to complete, or re-run the installer on your Oracle server.'
        });
      }
    }
    if (isProxy && !connProxyApiKey) {
      return res.status(400).json({ error: 'proxy_api_key is required for proxy connections' });
    }

    const displayHost = isProxy ? connProxyUrl : connHost;

    // Insert the health check record first (status: connecting)
    const insertResult = await pool.query(
      `INSERT INTO health_checks (connection_name, host, port, service_name, is_demo, connection_id, status, metrics, overall_score, username)
       VALUES ($1, $2, $3, $4, false, $5, 'connecting', '{}', 0, $6)
       RETURNING *`,
      [displayName || (isAgentConnection ? `${connService || 'auto-detect'} (via agent)` : isProxy ? `${connService} (via proxy)` : `${connHost}/${connService}`),
       displayHost, isProxy ? 443 : connPort, connService || null, connId, connUsername || (isAgentConnection ? 'sys (os auth)' : null)]
    );

    const healthCheck = insertResult.rows[0];

    // Track health_check_started (all checks) and first_check_started (first only)
    (async () => {
      try {
        if (req.user?.id) {
          const prev = await pool.query(
            `SELECT 1 FROM health_checks WHERE connection_id IN
               (SELECT id FROM oracle_connections WHERE user_id = $1) AND id != $2 AND is_demo = false LIMIT 1`,
            [req.user.id, healthCheck.id]
          );
          const isFirst = prev.rows.length === 0;
          // Always fire generalised event for funnel dashboard
          await dbAnalytics.trackEvent({
            eventName: 'health_check_started',
            userId: req.user.id,
            sessionId: req.cookies?.tv_sid || null,
            properties: { connection_type: connConnectionType, is_first: isFirst },
          });
          if (isFirst) {
            await dbAnalytics.trackEvent({
              eventName: 'first_check_started',
              userId: req.user.id,
              sessionId: req.cookies?.tv_sid || null,
              properties: { connection_type: connConnectionType },
            });
          }
        }
      } catch { /* non-blocking */ }
    })();

    if (isProxy) {
      // Run via HTTP proxy — agent connections use OS auth (no credentials needed)
      runProxyHealthCheck(healthCheck.id, {
        connectionId: connId,
        proxyUrl: connProxyUrl,
        proxyApiKey: connProxyApiKey,
        serviceName: connService,
        username: connUsername,
        password: connPassword,
        osAuth: isAgentConnection,
        host: connHost,
        port: connPort,
        serverType: connServerType,
        appsPwd: connAppsPwd,
        weblogicPwd: connWeblogicPwd,
      }).catch(err => {
        console.error('Proxy health check error:', err.message);
      });
    } else {
    // Run real Oracle collection + AI analysis asynchronously
    runRealHealthCheck(healthCheck.id, {
      host: connHost,
      port: connPort,
      serviceName: connService,
      username: connUsername,
      password: connPassword,
      connectionId: connId
    }).catch(err => {
      console.error('Real health check error:', err.message);
    });
    }

    res.json({
      id: healthCheck.id,
      connection_name: healthCheck.connection_name,
      status: 'connecting',
      overall_score: 0,
      scores: {},
      message: 'Connecting to Oracle database and collecting metrics...'
    });
  } catch (err) {
    console.error('Error creating health check:', err);
    res.status(500).json({ error: 'Failed to create health check' });
  }
});

// Get a specific health check
app.get('/api/health-checks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT hc.* FROM health_checks hc WHERE hc.id = $1 AND (hc.user_id = $2 OR hc.user_id IS NULL)`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = result.rows[0];
    const scores = hc.metrics && Object.keys(hc.metrics).length > 0 ? getSummaryScores(hc.metrics) : {};

    // EBS detection: read from metrics (set by APPS.DUAL probe during collection)
    const isEbs = !!(hc.metrics && hc.metrics.ebs_detected);

    // During analysis: compute live elapsed from DB heartbeat only.
    // Previously fell back to Date.now() - created_at when heartbeat hadn't started,
    // which inflated elapsed time with the entire collection phase and caused the
    // client timer to show 20-30s before GPT even began, then jump back to 0s when
    // the heartbeat kicked in. Now returns 0 until the first heartbeat writes, giving
    // the client a clean monotonic counter from actual GPT start.
    let analysisElapsedMs = null;
    if (hc.status === 'analyzing') {
      analysisElapsedMs = hc.analysis_progress_ms != null ? hc.analysis_progress_ms : 0;
    }

    // Admin debug data: attach analysis_run if present (gated at render time in frontend)
    let analysisRun = null;
    const token = getTokenFromRequest(req);
    const payload = verifyToken(token);
    if (payload) {
      try {
        const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [payload.userId]);
        const email = (userRes.rows[0]?.email || '').toLowerCase();
        if (ADMIN_EMAILS.has(email)) {
          const runRes = await pool.query(
            `SELECT * FROM analysis_runs WHERE health_check_id = $1 ORDER BY id DESC LIMIT 1`,
            [hc.id]
          );
          analysisRun = runRes.rows[0] || null;
        }
      } catch { /* non-blocking — admin data is optional */ }
    }

    // Privilege model — look up from the connection record if available.
    // Drives the greyed-out n/a sections on the report page for reader connections.
    let privilegeModel = 'sysdba'; // safe default for legacy checks without a connection
    if (hc.connection_id) {
      try {
        const connPrivRes = await pool.query(
          `SELECT privilege_model FROM oracle_connections WHERE id = $1`,
          [hc.connection_id]
        );
        if (connPrivRes.rows.length > 0 && connPrivRes.rows[0].privilege_model) {
          privilegeModel = connPrivRes.rows[0].privilege_model;
        }
      } catch { /* non-critical — fall back to sysdba */ }
    }

    res.json({
      id: hc.id,
      connection_name: hc.connection_name,
      username: hc.username,
      host: hc.host,
      service_name: hc.service_name,
      is_demo: hc.is_demo,
      status: hc.status,
      overall_score: hc.overall_score,
      scores,
      metrics: hc.metrics,
      ai_analysis: hc.ai_analysis,
      summary_text: hc.summary_text || null,
      top_action: hc.top_action || null,
      ebs_summary: hc.ebs_summary || null,
      ebs_action: hc.ebs_action || null,
      ai_recommendations: hc.ai_recommendations || null,
      created_at: hc.created_at,
      completed_at: hc.completed_at,
      connection_id: hc.connection_id,
      error_message: hc.error_message,
      is_ebs: isEbs,
      privilege_model: privilegeModel,
      // Instrumentation fields — used by dashboard live counter + admin debug panel
      analysis_stage: hc.analysis_stage || null,
      analysis_elapsed_ms: analysisElapsedMs,
      analysis_run: analysisRun
    });
  } catch (err) {
    console.error('Error fetching health check:', err);
    res.status(500).json({ error: 'Failed to fetch health check' });
  }
});

// List recent health checks — moved to routes/connections-list.js (Router-mounted at /api)

// Cancel a running health check — auth + ownership required
app.post('/api/health-checks/:id/cancel', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, status FROM health_checks WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }
    const hc = result.rows[0];
    if (hc.status === 'completed' || hc.status === 'error') {
      return res.json({ id: hc.id, status: hc.status, message: 'Health check already finished' });
    }
    await pool.query(
      `UPDATE health_checks SET status = 'error', ai_analysis = '## Cancelled\n\nThis health check was cancelled by the user.', completed_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ id: hc.id, status: 'error', message: 'Health check cancelled' });
  } catch (err) {
    console.error('Error cancelling health check:', err);
    res.status(500).json({ error: 'Failed to cancel health check' });
  }
});

// ── POST /api/instance-healthcheck ───────────────────────────────────────────
// Runs health checks on all connections belonging to an EBS instance in parallel.
// Accepts { instance_name } — looks up all member connection IDs, queues each HC,
// returns per-member HC IDs immediately so the UI can poll each one independently.
app.post('/api/instance-healthcheck', requireAuth, requireRole('junior_dba'), async (req, res) => {
  const { instance_name } = req.body;
  if (!instance_name) return res.status(400).json({ error: 'instance_name required' });

  try {
    const connResult = await pool.query(
      `SELECT id, name, server_type
         FROM oracle_connections
        WHERE ebs_instance_name = $1
          AND (user_id = $2 OR user_id IS NULL)
        ORDER BY server_type`,   // db first, then apps
      [instance_name, req.user.id]
    );

    if (connResult.rows.length === 0) {
      return res.status(404).json({ error: `No connections found for instance '${instance_name}'` });
    }

    // Fire one HC per member in parallel — same flow as POST /api/health-checks
    const members = connResult.rows;
    const hcPromises = members.map(async (conn) => {
      try {
        const hcRes = await pool.query(
          `INSERT INTO health_checks (connection_name, connection_id, status, username, user_id, is_demo)
           VALUES ($1, $2, 'pending', $3, $4, false)
           RETURNING id`,
          [conn.name, conn.id, req.user.email, req.user.id]
        );
        const hcId = hcRes.rows[0].id;

        // Fetch full connection row for the HC runner
        const fullConn = await pool.query(
          `SELECT id, name, host, port, service_name, username, encrypted_password,
                  connection_type, proxy_url, proxy_api_key_enc, server_type,
                  apps_pwd_enc, weblogic_pwd_enc
             FROM oracle_connections WHERE id = $1`,
          [conn.id]
        );
        const c = fullConn.rows[0];
        if (!c) return { connection_id: conn.id, name: conn.name, hc_id: hcId, queued: false, error: 'Connection not found' };

        const appsPwd     = c.apps_pwd_enc     ? decrypt(c.apps_pwd_enc)     : null;
        const weblogicPwd = c.weblogic_pwd_enc ? decrypt(c.weblogic_pwd_enc) : null;
        const password    = c.encrypted_password ? decrypt(c.encrypted_password) : null;
        const proxyApiKey = c.proxy_api_key_enc  ? decrypt(c.proxy_api_key_enc)  : null;

        // Fire-and-forget HC (same as the normal POST /api/health-checks path)
        runProxyHealthCheck(hcId, {
          connectionId:  c.id,
          proxyUrl:      c.proxy_url,
          proxyApiKey,
          serviceName:   c.service_name,
          username:      c.username,
          password,
          host:          c.host,
          port:          c.port || 1521,
          serverType:    c.server_type,
          appsPwd,
          weblogicPwd,
        }).catch(err => console.error(`[instance-hc] member ${conn.id} failed:`, err.message));

        return { connection_id: conn.id, name: conn.name, server_type: conn.server_type, hc_id: hcId, queued: true };
      } catch (err) {
        return { connection_id: conn.id, name: conn.name, server_type: conn.server_type, hc_id: null, queued: false, error: err.message };
      }
    });

    const results = await Promise.all(hcPromises);
    res.json({ ok: true, instance_name, members: results });
  } catch (err) {
    console.error('[instance-hc] error:', err.message);
    res.status(500).json({ error: 'Failed to start instance health check' });
  }
});

// SQL Tuning Recommendations — on-demand endpoint
// POST /api/health-checks/:id/sql-tuning
// Body: { sql_ids: string[] }   (subset of top_sql sql_ids from the health check)
// Uses the connection stored on the health check to reconnect and run analysis.
// For demo health checks returns deterministic demo tuning data.
app.post('/api/health-checks/:id/sql-tuning', requireAuth, async (req, res) => {
  try {
    const hcResult = await pool.query(
      `SELECT hc.*, oc.host, oc.port, oc.service_name, oc.username, oc.encrypted_password,
              oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc
       FROM health_checks hc
       LEFT JOIN oracle_connections oc ON hc.connection_id = oc.id
       WHERE hc.id = $1 AND (hc.user_id = $2 OR hc.is_demo = true)`,
      [req.params.id, req.user.id]
    );

    if (hcResult.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = hcResult.rows[0];

    // For demo health checks return deterministic demo data
    if (hc.is_demo) {
      const sqlIds = req.body.sql_ids || [];
      const demoRecs = sqlIds.map(sqlId => ({
        sql_id: sqlId,
        plan_available: true,
        red_flags: [
          { type: 'full_table_scan', severity: 'high', detail: 'Full table scan on ORDERS (2.3M rows)' },
          { type: 'nested_loops_high_rows', severity: 'high', detail: 'Nested loops with 234,567 estimated rows — consider hash join' }
        ],
        missing_index_candidates: [
          {
            table: 'APP.ORDERS',
            columns: ['CUSTOMER_ID', 'ORDER_DATE'],
            predicates: '"ORDER_DATE" BETWEEN :1 AND :2 AND "STATUS" = :3',
            create_sql: `CREATE INDEX idx_orders_cust_date ON APP.ORDERS (CUSTOMER_ID, ORDER_DATE, STATUS);`,
            reason: 'Full table scan with filter on unindexed column(s): CUSTOMER_ID, ORDER_DATE'
          }
        ],
        cursor_sharing: {
          sql_id: sqlId,
          child_cursors: 3,
          sibling_sqls: 0,
          has_literals: false,
          hard_parses: 12,
          issues: []
        },
        tuning_pack_licensed: true,
        dbms_sqltune_sql: `-- ============================================================
-- DBMS_SQLTUNE — SQL Tuning Advisor for SQL_ID: ${sqlId}
-- REQUIRES: Oracle Tuning Pack license
-- ============================================================

DECLARE
  l_task_name VARCHAR2(30);
BEGIN
  l_task_name := DBMS_SQLTUNE.CREATE_TUNING_TASK(
    sql_id      => '${sqlId}',
    scope       => DBMS_SQLTUNE.SCOPE_COMPREHENSIVE,
    time_limit  => 60,
    task_name   => 'tune_${sqlId.substring(0, 10)}',
    description => 'Tuning task created by TuneVault'
  );
  DBMS_OUTPUT.PUT_LINE('Task created: ' || l_task_name);
END;
/

BEGIN
  DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => 'tune_${sqlId.substring(0, 10)}');
END;
/

SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('tune_${sqlId.substring(0, 10)}') FROM DUAL;`
      }));
      return res.json({ tuning_pack_licensed: true, recommendations: demoRecs });
    }

    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    if (!hc.connection_id) {
      return res.status(400).json({ error: 'Health check has no saved connection — cannot run SQL tuning analysis' });
    }

    if (hc.connection_type === 'proxy') {
      return res.status(400).json({ error: 'SQL tuning analysis requires a direct TCP connection, not a proxy connection' });
    }

    const oracle = getOracleClient();
    if (!oracle) {
      return res.status(503).json({ error: 'Oracle client not available' });
    }

    const sqlIds = Array.isArray(req.body.sql_ids) ? req.body.sql_ids.slice(0, 10) : [];
    if (sqlIds.length === 0) {
      return res.status(400).json({ error: 'sql_ids array is required and must not be empty' });
    }

    const connParams = {
      host: hc.host,
      port: hc.port || 1521,
      serviceName: hc.service_name,
      username: hc.username,
      password: decrypt(hc.encrypted_password)
    };

    const result = await oracle.getSqlTuningRecommendations(connParams, sqlIds);
    res.json(result);
  } catch (err) {
    console.error('Error fetching SQL tuning recommendations:', err);
    res.status(500).json({ error: 'Failed to fetch SQL tuning recommendations' });
  }
});

// Download a completed health check as PDF — auth + ownership required
app.get('/api/health-checks/:id/pdf', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM health_checks WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [req.params.id, req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = result.rows[0];
    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    const scores = hc.metrics && Object.keys(hc.metrics).length > 0 ? getSummaryScores(hc.metrics) : {};
    const data = {
      id: hc.id,
      connection_name: hc.connection_name,
      username: hc.username,
      host: hc.host,
      service_name: hc.service_name,
      is_demo: hc.is_demo,
      status: hc.status,
      overall_score: hc.overall_score,
      scores,
      metrics: hc.metrics,
      ai_analysis: hc.ai_analysis,
      summary_text: hc.summary_text || null,
      top_action: hc.top_action || null,
      ai_recommendations: hc.ai_recommendations || null,
      created_at: hc.created_at,
      completed_at: hc.completed_at,
    };

    const safeName = (hc.connection_name || 'report')
      .replace(/[^a-z0-9_\-]/gi, '_')
      .substring(0, 50);
    const filename = `tunevault-health-check-${safeName}-${hc.id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const pdfDoc = generateHealthCheckPDF(data);
    pdfDoc.pipe(res);
  } catch (err) {
    console.error('Error generating PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF' });
    }
  }
});

// Download a completed health check as XLSX (Excel) — auth + ownership required
app.get('/api/health-checks/:id/xlsx', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM health_checks WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [req.params.id, req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check not found' });
    }

    const hc = result.rows[0];
    if (hc.status !== 'completed') {
      return res.status(400).json({ error: 'Health check is not yet complete' });
    }

    const m = hc.metrics || {};
    const scores = m && Object.keys(m).length > 0 ? getSummaryScores(m) : {};

    const safeName = (hc.connection_name || 'report')
      .replace(/[^a-z0-9_\-]/gi, '_')
      .substring(0, 50);
    const filename = `tunevault-health-check-${safeName}-${hc.id}.xlsx`;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TuneVault';
    workbook.created = new Date();

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1E2E' } };
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    const warnFont = { color: { argb: 'FFB45309' } };
    const critFont = { color: { argb: 'FFDC2626' } };
    const okFont = { color: { argb: 'FF059669' } };

    function statusFont(v, critThresh, warnThresh) {
      if (v > critThresh) return critFont;
      if (v > warnThresh) return warnFont;
      return okFont;
    }

    function addHeaders(sheet, headers) {
      const row = sheet.addRow(headers);
      row.eachCell(cell => {
        cell.fill = headerFill;
        cell.font = headerFont;
        cell.alignment = { horizontal: 'center' };
      });
      return row;
    }

    // ── Summary sheet ──
    const sumSheet = workbook.addWorksheet('Summary');
    sumSheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Value', key: 'value', width: 20 },
    ];
    addHeaders(sumSheet, ['Metric', 'Value']);
    sumSheet.addRow({ metric: 'Connection', value: hc.connection_name });
    sumSheet.addRow({ metric: 'Database', value: m.instance?.db_name || '—' });
    sumSheet.addRow({ metric: 'Oracle Version', value: m.instance?.version || '—' });
    sumSheet.addRow({ metric: 'Host', value: m.instance?.host_name || '—' });
    sumSheet.addRow({ metric: 'Overall Score', value: hc.overall_score });
    sumSheet.addRow({ metric: 'Tablespace Score', value: scores.tablespace || 0 });
    sumSheet.addRow({ metric: 'Wait Events Score', value: scores.wait_events || 0 });
    sumSheet.addRow({ metric: 'SQL Perf Score', value: scores.sql_performance || 0 });
    sumSheet.addRow({ metric: 'Active Sessions Score', value: scores.active_sessions || 0 });
    sumSheet.addRow({ metric: 'Memory Score', value: scores.memory || 0 });
    sumSheet.addRow({ metric: 'Index Health Score', value: scores.index_health || 0 });
    sumSheet.addRow({ metric: 'Date', value: new Date(hc.created_at).toLocaleString() });

    // ── Tablespaces sheet ──
    if (m.tablespaces && m.tablespaces.length > 0) {
      const tsSheet = workbook.addWorksheet('Tablespaces');
      tsSheet.columns = [
        { header: 'Name', key: 'name', width: 22 },
        { header: 'Used (GB)', key: 'used_gb', width: 12 },
        { header: 'Total (GB)', key: 'total_gb', width: 12 },
        { header: 'Usage %', key: 'pct_used', width: 10 },
        { header: 'Autoextend', key: 'autoextend', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
      ];
      addHeaders(tsSheet, ['Name', 'Used (GB)', 'Total (GB)', 'Usage %', 'Autoextend', 'Status']);
      m.tablespaces.forEach(t => {
        const row = tsSheet.addRow({ name: t.name, used_gb: t.used_gb, total_gb: t.total_gb, pct_used: t.pct_used, autoextend: t.autoextend ? 'ON' : 'OFF', status: t.pct_used > 90 ? 'CRITICAL' : t.pct_used > 80 ? 'WARNING' : 'OK' });
        row.getCell('pct_used').font = statusFont(t.pct_used, 90, 80);
      });
    }

    // ── Wait Events sheet ──
    if (m.wait_events && m.wait_events.length > 0) {
      const weSheet = workbook.addWorksheet('Wait Events');
      weSheet.columns = [
        { header: 'Event', key: 'event', width: 35 },
        { header: 'Wait Class', key: 'wait_class', width: 18 },
        { header: '% DB Time', key: 'pct_db_time', width: 12 },
        { header: 'Total Waits', key: 'total_waits', width: 14 },
        { header: 'Avg Wait (ms)', key: 'avg_wait_ms', width: 14 },
      ];
      addHeaders(weSheet, ['Event', 'Wait Class', '% DB Time', 'Total Waits', 'Avg Wait (ms)']);
      m.wait_events.filter(w => w.pct_db_time > 0).forEach(w => {
        const row = weSheet.addRow({ event: w.event, wait_class: w.wait_class, pct_db_time: w.pct_db_time, total_waits: w.total_waits, avg_wait_ms: w.avg_wait_ms });
        row.getCell('pct_db_time').font = statusFont(w.pct_db_time, 10, 5);
      });
    }

    // ── Top SQL sheet ──
    if (m.top_sql && m.top_sql.length > 0) {
      const sqlSheet = workbook.addWorksheet('Top SQL');
      sqlSheet.columns = [
        { header: 'SQL ID', key: 'sql_id', width: 18 },
        { header: 'ms/exec', key: 'elapsed', width: 12 },
        { header: 'Executions', key: 'execs', width: 14 },
        { header: 'Gets/exec', key: 'gets', width: 12 },
        { header: 'Issue', key: 'issue', width: 45 },
        { header: 'SQL Text', key: 'sql_text', width: 60 },
      ];
      addHeaders(sqlSheet, ['SQL ID', 'ms/exec', 'Executions', 'Gets/exec', 'Issue', 'SQL Text']);
      m.top_sql.forEach(s => {
        sqlSheet.addRow({ sql_id: s.sql_id, elapsed: s.elapsed_per_exec_ms, execs: s.executions, gets: s.buffer_gets_per_exec, issue: s.issue, sql_text: (s.sql_text || '').substring(0, 500) });
      });
    }

    // ── Indexes sheet ──
    if (m.index_analysis && m.index_analysis.length > 0) {
      const idxSheet = workbook.addWorksheet('Indexes');
      idxSheet.columns = [
        { header: 'Index', key: 'index_name', width: 25 },
        { header: 'Table', key: 'table_name', width: 22 },
        { header: 'Size (MB)', key: 'size_mb', width: 12 },
        { header: 'B-Level', key: 'blevel', width: 10 },
        { header: 'Deleted %', key: 'pct_deleted', width: 12 },
        { header: 'Status', key: 'status', width: 14 },
      ];
      addHeaders(idxSheet, ['Index', 'Table', 'Size (MB)', 'B-Level', 'Deleted %', 'Status']);
      m.index_analysis.forEach(i => {
        const row = idxSheet.addRow({ index_name: i.index_name, table_name: i.table_name, size_mb: i.size_mb, blevel: i.blevel, pct_deleted: i.pct_deleted, status: i.pct_deleted > 50 ? 'CRITICAL' : i.pct_deleted > 30 ? 'FRAGMENTED' : 'OK' });
        row.getCell('pct_deleted').font = statusFont(i.pct_deleted, 50, 30);
      });
    }

    // ── Memory sheet ──
    const memSheet = workbook.addWorksheet('Memory');
    memSheet.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 18 },
    ];
    addHeaders(memSheet, ['Metric', 'Value']);
    const sga = m.sga_stats || {};
    const pga = m.pga_stats || {};
    memSheet.addRow({ metric: 'SGA Size', value: (sga.sga_size_gb || 0) + ' GB' });
    memSheet.addRow({ metric: 'Buffer Cache', value: (sga.buffer_cache_gb || 0) + ' GB' });
    memSheet.addRow({ metric: 'Buffer Cache Hit Ratio', value: (sga.buffer_cache_hit_ratio || 0) + '%' });
    memSheet.addRow({ metric: 'Library Cache Hit Ratio', value: (sga.library_cache_hit_ratio || 0) + '%' });
    memSheet.addRow({ metric: 'Shared Pool Free', value: (sga.shared_pool_free_pct || 0) + '%' });
    memSheet.addRow({ metric: 'Hard Parses/sec', value: sga.hard_parses_per_sec || 0 });
    memSheet.addRow({ metric: 'PGA Target', value: (pga.pga_target_gb || 0) + ' GB' });
    memSheet.addRow({ metric: 'PGA Allocated', value: (pga.pga_allocated_gb || 0) + ' GB' });
    memSheet.addRow({ metric: 'PGA Optimal %', value: (pga.optimal_executions_pct || 0) + '%' });
    memSheet.addRow({ metric: 'PGA One-pass %', value: (pga.onepass_executions_pct || 0) + '%' });
    memSheet.addRow({ metric: 'PGA Multi-pass %', value: (pga.multipass_executions_pct || 0) + '%' });

    // ── OS Stats sheet ──
    const osSheet = workbook.addWorksheet('OS Stats');
    osSheet.columns = [
      { header: 'Metric', key: 'metric', width: 25 },
      { header: 'Value', key: 'value', width: 18 },
    ];
    addHeaders(osSheet, ['Metric', 'Value']);
    const os = m.os_stats || {};
    osSheet.addRow({ metric: 'CPU Count', value: os.cpu_count || 0 });
    osSheet.addRow({ metric: 'Avg CPU %', value: (os.avg_cpu_utilization_pct || 0) + '%' });
    osSheet.addRow({ metric: 'Max CPU %', value: (os.max_cpu_utilization_pct || 0) + '%' });
    osSheet.addRow({ metric: 'I/O Wait %', value: (os.avg_io_wait_pct || 0) + '%' });
    osSheet.addRow({ metric: 'Physical RAM', value: (os.physical_memory_gb || 0) + ' GB' });
    osSheet.addRow({ metric: 'Free Memory', value: (os.free_memory_gb || 0) + ' GB' });
    osSheet.addRow({ metric: 'Avg Disk Read', value: (os.avg_disk_read_ms || 0) + 'ms' });
    osSheet.addRow({ metric: 'Avg Disk Write', value: (os.avg_disk_write_ms || 0) + 'ms' });

    // ── Backup sheet ──
    if (m.backup_stats) {
      const bkSheet = workbook.addWorksheet('Backup & Recovery');
      bkSheet.columns = [
        { header: 'Check', key: 'check', width: 30 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Detail', key: 'detail', width: 50 },
      ];
      addHeaders(bkSheet, ['Check', 'Status', 'Detail']);
      const bk = m.backup_stats;
      bkSheet.addRow({ check: 'Overall Backup Status', status: (bk.overall_status || 'unknown').toUpperCase(), detail: '' });
      if (bk.rman_backup) {
        const r = bk.rman_backup;
        bkSheet.addRow({ check: 'RMAN Configured', status: r.rman_available ? 'YES' : 'NO', detail: '' });
        bkSheet.addRow({ check: 'Last Full Backup', status: (r.status || 'unknown').toUpperCase(), detail: r.full_backup_hours_ago != null ? r.full_backup_hours_ago + 'h ago' : 'NONE' });
        if (r.last_by_type && r.last_by_type.length > 0) {
          r.last_by_type.forEach(bt => {
            bkSheet.addRow({ check: `  Last ${bt.input_type}`, status: bt.status, detail: `${bt.hours_ago}h ago, ${bt.size_gb}GB` });
          });
        }
        if (r.recent_jobs && r.recent_jobs.length > 0) {
          bkSheet.addRow({ check: '', status: '', detail: '' });
          bkSheet.addRow({ check: 'Recent Backup Jobs', status: '', detail: '' });
          r.recent_jobs.forEach(j => {
            bkSheet.addRow({ check: `  ${j.input_type}`, status: j.status, detail: `${j.start_time} — ${j.size_gb}GB` });
          });
        }
      }
      if (bk.fra_usage && bk.fra_usage.fra_configured) {
        const f = bk.fra_usage;
        bkSheet.addRow({ check: '', status: '', detail: '' });
        bkSheet.addRow({ check: 'FRA Usage', status: (f.status || 'unknown').toUpperCase(), detail: `${f.pct_used}% (${f.used_gb}/${f.limit_gb} GB)` });
        bkSheet.addRow({ check: 'FRA Reclaimable', status: '', detail: `${f.pct_reclaimable}% (${f.reclaimable_gb} GB)` });
        if (f.hours_until_full != null) bkSheet.addRow({ check: 'Hours Until FRA Full', status: '', detail: f.hours_until_full + 'h' });
      }
      if (bk.archivelog_rate) {
        const al = bk.archivelog_rate;
        bkSheet.addRow({ check: '', status: '', detail: '' });
        bkSheet.addRow({ check: 'Archive Mode', status: al.log_mode || 'UNKNOWN', detail: '' });
        bkSheet.addRow({ check: 'Log Switches/Hour', status: (al.status || 'unknown').toUpperCase(), detail: (al.switches_per_hour || 0).toString() });
        bkSheet.addRow({ check: 'Switches (24h)', status: '', detail: (al.switches_24h || 0).toString() });
      }
      if (bk.backup_validation) {
        const v = bk.backup_validation;
        bkSheet.addRow({ check: '', status: '', detail: '' });
        bkSheet.addRow({ check: 'Backup Integrity', status: (v.total_corruptions || 0) === 0 ? 'CLEAN' : 'CORRUPT', detail: `${v.total_corruptions || 0} corruptions` });
      }
    }

    // ── Undo Tablespace sheet ──
    if (m.undo_stats && m.undo_stats.current) {
      const undoSheet = workbook.addWorksheet('Undo Tablespace');
      undoSheet.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 20 },
      ];
      addHeaders(undoSheet, ['Metric', 'Value']);
      const uc = m.undo_stats.current;
      undoSheet.addRow({ metric: 'Tablespace Name', value: uc.tablespace_name || '—' });
      undoSheet.addRow({ metric: 'Total Size (GB)', value: uc.total_gb || 0 });
      undoSheet.addRow({ metric: 'Used (GB)', value: uc.used_gb || 0 });
      undoSheet.addRow({ metric: 'Usage %', value: uc.pct_used != null ? uc.pct_used + '%' : '—' });
      undoSheet.addRow({ metric: 'Tuned Retention (s)', value: uc.tuned_undo_retention_s || 0 });
      undoSheet.addRow({ metric: 'Max Query Length (s)', value: uc.max_query_length_s || 0 });
      undoSheet.addRow({ metric: 'Retention Mode', value: uc.retention_mode || '—' });
      undoSheet.addRow({ metric: 'Undo Blocks', value: uc.undo_blocks || 0 });
      undoSheet.addRow({ metric: 'Active Blocks', value: uc.active_blocks || 0 });
      undoSheet.addRow({ metric: 'Expired Blocks', value: uc.expired_blocks || 0 });
      const uh = m.undo_stats.historical || {};
      if (uh.peak_pct_used != null) undoSheet.addRow({ metric: 'Peak Usage % (30d)', value: uh.peak_pct_used + '%' });
      if (uh.peak_time) undoSheet.addRow({ metric: 'Peak Time', value: uh.peak_time });
    }

    // ── Temp Tablespace sheet ──
    if (m.temp_stats && m.temp_stats.current) {
      const tempSheet = workbook.addWorksheet('Temp Tablespace');
      tempSheet.columns = [
        { header: 'Metric', key: 'metric', width: 28 },
        { header: 'Value', key: 'value', width: 20 },
      ];
      addHeaders(tempSheet, ['Metric', 'Value']);
      const tc = m.temp_stats.current;
      tempSheet.addRow({ metric: 'Tablespace Name', value: tc.tablespace_name || '—' });
      tempSheet.addRow({ metric: 'Total Size (GB)', value: tc.total_gb || 0 });
      tempSheet.addRow({ metric: 'Used (GB)', value: tc.used_gb || 0 });
      tempSheet.addRow({ metric: 'Free (GB)', value: tc.free_gb || 0 });
      tempSheet.addRow({ metric: 'Usage %', value: tc.pct_used != null ? tc.pct_used + '%' : '—' });
      if (tc.top_sessions && tc.top_sessions.length > 0) {
        tempSheet.addRow({ metric: '', value: '' });
        tempSheet.addRow({ metric: 'Top Temp-Consuming Sessions', value: '' });
        tc.top_sessions.forEach(s => {
          tempSheet.addRow({ metric: `  SID ${s.sid} (${s.username || 'UNKNOWN'})`, value: (s.temp_mb || 0) + ' MB' });
        });
      }
    }

    // ── Alert Log sheet ──
    if (m.alert_log && m.alert_log.entries && m.alert_log.entries.length > 0) {
      const alSheet = workbook.addWorksheet('Alert Log');
      alSheet.columns = [
        { header: 'Timestamp', key: 'ts', width: 22 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Message', key: 'message', width: 80 },
      ];
      addHeaders(alSheet, ['Timestamp', 'Severity', 'Message']);
      const als = m.alert_log.summary || {};
      alSheet.addRow({ ts: 'Summary', severity: '', message: `Total: ${als.total || 0}, Critical: ${als.critical || 0}, Warning: ${als.warning || 0}, Info: ${als.info || 0}` });
      m.alert_log.entries.slice(0, 100).forEach(e => {
        const row = alSheet.addRow({ ts: e.ts, severity: (e.severity || 'info').toUpperCase(), message: (e.message || '').substring(0, 200) });
        if (e.severity === 'critical') row.getCell('severity').font = critFont;
        else if (e.severity === 'warning') row.getCell('severity').font = warnFont;
      });
    }

    // ── Resource Limits sheet ──
    if (m.resource_limits && m.resource_limits.current && m.resource_limits.current.length > 0) {
      const rlSheet = workbook.addWorksheet('Resource Limits');
      rlSheet.columns = [
        { header: 'Resource', key: 'resource', width: 22 },
        { header: 'Current', key: 'current', width: 12 },
        { header: 'Max Used', key: 'max_used', width: 12 },
        { header: 'Limit', key: 'limit', width: 14 },
        { header: '% of Limit', key: 'pct', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
      ];
      addHeaders(rlSheet, ['Resource', 'Current', 'Max Used', 'Limit', '% of Limit', 'Status']);
      m.resource_limits.current.forEach(r => {
        rlSheet.addRow({ resource: r.resource, current: r.current_utilization, max_used: r.max_utilization, limit: r.limit_display, pct: r.pct_max_used != null ? r.pct_max_used + '%' : 'N/A', status: (r.status || 'ok').toUpperCase() });
      });
    }

    // ── SGA/PGA History sheet ──
    if (m.sga_pga_history && m.sga_pga_history.current) {
      const sgaSheet = workbook.addWorksheet('SGA PGA History');
      sgaSheet.columns = [
        { header: 'Metric', key: 'metric', width: 30 },
        { header: 'Value', key: 'value', width: 20 },
      ];
      addHeaders(sgaSheet, ['Metric', 'Value']);
      const sc = m.sga_pga_history.current;
      sgaSheet.addRow({ metric: 'SGA Target', value: (sc.sga_target_gb || 0) + ' GB' });
      sgaSheet.addRow({ metric: 'PGA Target', value: (sc.pga_target_gb || 0) + ' GB' });
      sgaSheet.addRow({ metric: 'SGA Max Size', value: (sc.sga_max_gb || 0) + ' GB' });
      sgaSheet.addRow({ metric: 'Memory Target', value: (sc.memory_target_gb || 0) + ' GB' });
      const ph = m.sga_pga_history.pga_history || {};
      if (ph.peak_allocated_gb != null) sgaSheet.addRow({ metric: 'PGA Peak Allocated', value: ph.peak_allocated_gb + ' GB' });
      if (ph.peak_time) sgaSheet.addRow({ metric: 'PGA Peak Time', value: ph.peak_time });
      const resOps = m.sga_pga_history.resize_ops || [];
      if (resOps.length > 0) {
        sgaSheet.addRow({ metric: '', value: '' });
        sgaSheet.addRow({ metric: 'Recent Resize Operations', value: '' });
        resOps.forEach(op => {
          sgaSheet.addRow({ metric: `  ${op.component || '—'} (${op.oper_type || '—'})`, value: `${op.from_gb || 0} → ${op.to_gb || 0} GB` });
        });
      }
    }

    // EBS Operations sheet — only when EBS was detected
    if (m.ebs_detected && m.ebs_operations) {
      const ebsSheet = workbook.addWorksheet('EBS Operations');
      ebsSheet.columns = [
        { header: 'Category', key: 'category', width: 22 },
        { header: 'Check', key: 'check', width: 36 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Value', key: 'value', width: 24 },
        { header: 'Notes', key: 'notes', width: 40 }
      ];
      addHeaders(ebsSheet, ['Category', 'Check', 'Status', 'Value', 'Notes']);

      const ebs = m.ebs_operations;
      const addEbsRow = (cat, check, status, value, notes) => ebsSheet.addRow({ category: cat, check, status, value: String(value || ''), notes: notes || '' });

      const cm = ebs.concurrent_managers || {};
      if (cm.cm01) addEbsRow('Concurrent Mgrs', 'Internal Manager', cm.cm01.running_processes === 0 ? 'FAIL' : 'OK', `${cm.cm01.running_processes}/${cm.cm01.max_processes} proc`, `Control: ${cm.cm01.control_code}`);
      if (cm.cm02) addEbsRow('Concurrent Mgrs', 'Pending Requests', cm.cm02.pending_requests > 200 ? 'FAIL' : cm.cm02.pending_requests > 50 ? 'WARN' : 'OK', cm.cm02.pending_requests, 'Phase=P Status=I');
      if (cm.cm05) addEbsRow('Concurrent Mgrs', 'Avg Runtime (24h)', cm.cm05.avg_runtime_secs > 3600 ? 'WARN' : 'OK', `${cm.cm05.avg_runtime_secs}s`, `${cm.cm05.completed_24h} completed`);
      if (cm.cm10) addEbsRow('Concurrent Mgrs', 'Error Requests (24h)', cm.cm10.error_requests_24h > 20 ? 'FAIL' : cm.cm10.error_requests_24h > 5 ? 'WARN' : 'OK', cm.cm10.error_requests_24h, 'Status IN (E,X,D)');

      const wf = ebs.workflow || {};
      if (wf.wf02) addEbsRow('Workflow', 'WF Errors', wf.wf02.error_count > 50 ? 'FAIL' : wf.wf02.error_count > 10 ? 'WARN' : 'OK', wf.wf02.error_count, 'activity_status=ERROR');
      if (wf.wf03) addEbsRow('Workflow', 'Deferred Queue', wf.wf03.deferred_ready > 500 ? 'FAIL' : wf.wf03.deferred_ready > 100 ? 'WARN' : 'OK', wf.wf03.deferred_ready, 'WF_DEFERRED state=0');
      if (wf.wf08) addEbsRow('Workflow', 'Notification Backlog >2h', wf.wf08.pending_over_2h > 500 ? 'FAIL' : wf.wf08.pending_over_2h > 100 ? 'WARN' : 'OK', wf.wf08.pending_over_2h, `${wf.wf08.pending_over_8h} >8h`);

      const sec = ebs.security || {};
      if (sec.sc12) addEbsRow('Security', 'Sign-on Audit', sec.sc12.audit_enabled ? 'OK' : 'WARN', sec.sc12.signon_audit_level, 'SIGNONAUDIT:LEVEL profile');
      if (sec.sc14) addEbsRow('Security', 'SysAdmin Users', sec.sc14.length > 5 ? 'WARN' : 'OK', sec.sc14.length, sec.sc14.map(u => u.user_name).join(', '));

      const fb = ebs.functional || {};
      if (fb.fb03) addEbsRow('ADOP & App Tier', 'Notification Aging >7d', fb.fb03.pending_over_7d > 200 ? 'FAIL' : fb.fb03.pending_over_7d > 50 ? 'WARN' : 'OK', fb.fb03.pending_over_7d, 'Stale WF notifications');
      if (fb.fb04) addEbsRow('ADOP & App Tier', 'Active EBS Users (24h)', 'INFO', fb.fb04.active_users_24h, 'ICX_SESSIONS');

      // Long-running CM requests
      if (cm.cm09 && cm.cm09.length) {
        ebsSheet.addRow({});
        ebsSheet.addRow({ category: 'Top Long Requests (7d)', check: 'Program', status: 'Runtime', value: 'Started', notes: '' });
        cm.cm09.forEach(req => ebsSheet.addRow({ category: '', check: req.program, status: `${Math.round((req.runtime_secs || 0) / 60)} min`, value: req.start_time, notes: '' }));
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error generating XLSX:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate XLSX' });
    }
  }
});

// ============================================================
// Real Oracle Health Check Flow
// ============================================================

async function runRealHealthCheck(healthCheckId, oracleConfig) {
  const t0 = Date.now(); // t0: collection started (proxy POST landed / job started)

  // Hard 5-minute deadline — protects against hung Oracle connections
  const HC_TIMEOUT_MS = 5 * 60 * 1000;
  let hcTimeoutId;
  const hcTimeoutPromise = new Promise((_, reject) => {
    hcTimeoutId = setTimeout(() => {
      reject(new Error('Health check timed out after 5 minutes. The Oracle server may be unresponsive or the query is too slow.'));
    }, HC_TIMEOUT_MS);
  });

  try {
    await Promise.race([runRealHealthCheckInner(healthCheckId, oracleConfig, t0), hcTimeoutPromise]);
  } catch (err) {
    console.error('Real health check failed:', err.message);
    const diagnosis = classifyOracleError(err, {
      host: oracleConfig.host,
      port: oracleConfig.port || 1521,
      serviceName: oracleConfig.serviceName || oracleConfig.service_name,
      username: oracleConfig.username,
      isProxy: false
    });
    const errorBody = `## Connection Error\n\n${err.message}\n\n### Troubleshooting\n- Verify the hostname and port are correct\n- Ensure the Oracle listener is running\n- Check that the service name/SID exists\n- Verify the username has SELECT_CATALOG_ROLE or appropriate grants\n- Check firewall rules allow TCP connections on the specified port`;
    await pool.query(
      `UPDATE health_checks SET status = 'error', ai_analysis = $1, completed_at = NOW() WHERE id = $2`,
      [buildErrorAnalysis(diagnosis, errorBody), healthCheckId]
    );
  } finally {
    clearTimeout(hcTimeoutId);
  }
}

async function runRealHealthCheckInner(healthCheckId, oracleConfig, t0) {
  const oracle = getOracleClient();
  if (!oracle) {
    await pool.query(
      `UPDATE health_checks SET status = 'error', ai_analysis = $1, completed_at = NOW() WHERE id = $2`,
      ['Oracle client not available. The oracledb package may not be installed on the server.', healthCheckId]
    );
    return;
  }

  try {
    // Update status to collecting
    await pool.query(
      `UPDATE health_checks SET status = 'collecting', analysis_stage = 'collecting' WHERE id = $1`,
      [healthCheckId]
    );

    // Collect real metrics from Oracle
    const metrics = await oracle.collectMetrics(oracleConfig);

    const connectionId = oracleConfig.connectionId || null;

    // Calculate scores using same logic as demo
    const scores = getSummaryScores(metrics);

    // t1: check results parsed and written to DB
    const t1 = Date.now();
    console.log(`[pipeline] report=${healthCheckId} stage=metrics_collected dur_collect_ms=${t1 - t0}`);

    // Save metrics and scores
    await pool.query(
      `UPDATE health_checks SET metrics = $1, overall_score = $2, status = 'analyzing', analysis_stage = 'ai_pending' WHERE id = $3`,
      [JSON.stringify(metrics), scores.overall, healthCheckId]
    );

    // Run AI analysis — pass t0/t1 for full pipeline timing
    await runAIAnalysis(healthCheckId, metrics, scores, connectionId, t0, t1);

  } catch (err) {
    // Re-throw so the outer runRealHealthCheck catch handler updates the DB
    throw err;
  }
}

// Current canonical proxy version — bump this when oracle-proxy.py/oracle-proxy.js VERSION changes
const LATEST_PROXY_VERSION = '3.20.33';

// ============================================================
// Proxy Health Check Flow
// ============================================================

async function runProxyHealthCheck(healthCheckId, { connectionId, proxyUrl, proxyApiKey, serviceName, username, password, osAuth, host, port, serverType = null, appsPwd = null, weblogicPwd = null }) {
  const t0 = Date.now(); // t0: collection started

  // Hard 3-minute deadline — protects against hung proxy connections where
  // socket timeout (120s) fails to fire due to keep-alive packets on tunnels.
  // Without this, health check gets stuck in 'collecting' status forever.
  const PROXY_HC_TIMEOUT_MS = 3 * 60 * 1000;
  let proxyTimeoutId;
  const proxyTimeoutPromise = new Promise((_, reject) => {
    proxyTimeoutId = setTimeout(() => {
      reject(new Error('Proxy health check timed out after 3 minutes. The proxy agent may be unreachable or the Oracle query is hanging.'));
    }, PROXY_HC_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      runProxyHealthCheckInner(healthCheckId, { connectionId, proxyUrl, proxyApiKey, serviceName, username, password, osAuth, host, port, serverType, appsPwd, weblogicPwd }, t0),
      proxyTimeoutPromise
    ]);
  } catch (err) {
    console.error('Proxy health check failed:', err.message);
    const diagnosis = classifyOracleError(err, {
      host: null,
      port: null,
      serviceName: serviceName,
      username: username,
      isProxy: true,
      proxyUrl: proxyUrl
    });
    const errMsg = err.message || '';
    let errorBody;
    if (serverType === 'apps') {
      errorBody = `## Health Check Error\n\n${errMsg}\n\n### Note\nThis is an EBS application server. Run the health check on the database server connection instead.`;
    } else {
      const isSidError = /ORA-12514|ORA-12505|TNS.*listener|unknown.*service|timed out/i.test(errMsg);
      const sidHint = isSidError
        ? `\n- **Check the Oracle SID/service name** — the configured SID may not match any running instance. Run \`ps -ef | grep ora_pmon\` on the Oracle server to see active SIDs.`
        : '';
      const curlStep = proxyUrl ? `\n- Verify the proxy URL is reachable (try \`curl ${proxyUrl}/health\`)` : '';
      errorBody = `## Proxy Connection Error\n\n${errMsg}\n\n### Troubleshooting${sidHint}${curlStep}\n- Check the API key matches what's configured in TUNEVAULT_API_KEY on the proxy server\n- Ensure your outbound HTTPS proxy is routing HTTP traffic to http://localhost:3100 (not TCP)\n- Confirm the proxy is running: systemctl status tunevault-proxy (or python3 oracle-proxy.py)`;
    }
    await pool.query(
      `UPDATE health_checks SET status = 'error', ai_analysis = $1, completed_at = NOW() WHERE id = $2`,
      [buildErrorAnalysis(diagnosis, errorBody), healthCheckId]
    );
  } finally {
    clearTimeout(proxyTimeoutId);
  }
}

// Inner function extracted so Promise.race can wrap it with a hard timeout
// proxyUrl/proxyApiKey are retained in the signature for backward compat but no longer used —
// all traffic goes through the outbound agent channel (see fetchMetricsFromProxy).
async function runProxyHealthCheckInner(healthCheckId, { connectionId, serviceName, username, password, osAuth, host, port, serverType, appsPwd = null, weblogicPwd = null }, t0) {
  try {
    await pool.query(`UPDATE health_checks SET status = 'collecting', analysis_stage = 'collecting' WHERE id = $1`, [healthCheckId]);

    const metrics = await fetchMetricsFromProxy({ connectionId, serviceName, username, password, osAuth, host, port, serverType, appsPwd, weblogicPwd });

    // ── EBS app-tier path: store findings then run AI analysis ───────────────
    if (metrics.server_type === 'apps') {
      const appScore = metrics._app_score || 0;
      delete metrics._app_score;
      const t1 = Date.now();
      console.log(`[pipeline] report=${healthCheckId} stage=app_tier_collecting score=${appScore} dur_ms=${t1 - t0}`);
      await pool.query(
        `UPDATE health_checks SET metrics = $1, overall_score = $2, status = 'analyzing', analysis_stage = 'ai_pending' WHERE id = $3`,
        [JSON.stringify(metrics), appScore, healthCheckId]
      );
      console.log(`[ai] running analysis for app tier conn ${connectionId} report ${healthCheckId} score ${appScore} findings ${(metrics.findings || []).length}`);
      await runAIAnalysis(healthCheckId, metrics, { overall: appScore }, connectionId, t0, t1);
      return;
    }

    // Record proxy version on the connection row
    const proxyVersion = metrics.proxy_version || null;
    if (connectionId && proxyVersion) {
      await pool.query(
        `UPDATE oracle_connections SET proxy_version = COALESCE($1, proxy_version) WHERE id = $2`,
        [proxyVersion, connectionId]
      );
    }

    // Track proxy key usage: last-used timestamp + IP (proxy URL hostname as proxy identity)
    if (connectionId) {
      try {
        const connRow = await pool.query(
          `SELECT proxy_url, proxy_key_ips FROM oracle_connections WHERE id = $1`,
          [connectionId]
        );
        if (connRow.rows[0] && connRow.rows[0].proxy_url) {
          const proxyHost = new URL(connRow.rows[0].proxy_url).hostname;
          const existingIps = (connRow.rows[0].proxy_key_ips) || [];
          const ipList = [proxyHost, ...existingIps.filter(ip => ip !== proxyHost)].slice(0, 5);
          await pool.query(
            `UPDATE oracle_connections
             SET proxy_key_last_used_at = NOW(),
                 proxy_key_last_ip = $1,
                 proxy_key_ips = $2::jsonb
             WHERE id = $3`,
            [proxyHost, JSON.stringify(ipList), connectionId]
          );
        }
      } catch (_trackErr) {
        // Non-fatal — usage tracking best-effort
      }
    }

    // Log if outdated
    if (proxyVersion && proxyVersion < LATEST_PROXY_VERSION) {
      console.log(`Proxy at ${proxyUrl} is running v${proxyVersion} — update available (latest: ${LATEST_PROXY_VERSION})`);
    }

    // Persist discovered host/SID info from agent proxy (backfill NULL fields)
    const discovered = metrics._discovered;
    if (connectionId && discovered) {
      try {
        await pool.query(
          `UPDATE oracle_connections
           SET host         = COALESCE(host, $1),
               service_name = COALESCE(service_name, $2),
               port         = COALESCE(port, $3)
           WHERE id = $4`,
          [discovered.host || 'localhost', discovered.service_name || null,
           discovered.port || 1521, connectionId]
        );
        // Also update the health check record with discovered service info
        if (discovered.service_name) {
          await pool.query(
            `UPDATE health_checks SET service_name = COALESCE(service_name, $1) WHERE id = $2`,
            [discovered.service_name, healthCheckId]
          );
        }
      } catch (_discoverErr) {
        // Non-fatal — connection record update best-effort
        console.warn('[proxy-hc] Failed to persist discovered connection info:', _discoverErr.message);
      }
    }

    const scores = getSummaryScores(metrics);

    // t1: check results parsed and written to DB
    const t1 = Date.now();
    console.log(`[pipeline] report=${healthCheckId} stage=metrics_collected dur_collect_ms=${t1 - t0}`);

    await pool.query(
      `UPDATE health_checks SET metrics = $1, overall_score = $2, status = 'analyzing', analysis_stage = 'ai_pending' WHERE id = $3`,
      [JSON.stringify(metrics), scores.overall, healthCheckId]
    );

    // Pass connectionId + t0/t1 for full pipeline timing
    await runAIAnalysis(healthCheckId, metrics, scores, connectionId, t0, t1);
  } catch (err) {
    // Re-throw so the outer runProxyHealthCheck catch handler updates the DB
    throw err;
  }
}

async function fetchMetricsFromProxy({ connectionId, serviceName, username, password, osAuth, host, port, serverType, appsPwd = null, weblogicPwd = null }) {
  // All proxy health checks MUST go through the outbound agent channel.
  // Direct inbound hits to proxy_url are retired — agents expose no inbound ports.
  // Check agent_tunnels for active status (oracle-proxy.py uses HTTP polling not WS channel)
  if (connectionId) {
    const tunnelCheck = await pool.query(
      `SELECT status FROM agent_tunnels WHERE connection_id = $1 AND status = 'active' LIMIT 1`,
      [connectionId]
    );
    if (tunnelCheck.rows.length === 0 && !agentChannel.isAgentConnected(connectionId)) {
      throw new Error(
        'Agent is not connected. The TuneVault Agent connects outbound to the cloud — ' +
        'no inbound ports or firewall rules are needed. ' +
        'Wait up to 30 seconds after install for the agent to check in, then retry.'
      );
    }
  }

  // ── EBS app-tier: call /api/ebs-app-healthcheck instead of /api/healthcheck ─
  if (serverType === 'apps') {
    const appBody = {};
    if (appsPwd)     appBody.apps_pwd     = appsPwd;
    if (weblogicPwd) appBody.weblogic_pwd = weblogicPwd;
    // For EBS app tier — longer timeout to accommodate slow VMs and large EBS environments
    const hcTimeout = serverType === 'apps' ? 300000 : 120000;
    const resp = await agentChannel.sendToAgent(connectionId, {
      method: 'POST',
      path: '/api/ebs-app-healthcheck',
      body: appBody,
    }, hcTimeout);
    const parsed = resp.body || {};
    if (resp.statusCode !== 200 || !parsed.success) {
      throw new Error(parsed.error || `App-tier health check failed (HTTP ${resp.statusCode})`);
    }
    return {
      server_type:  'apps',
      findings:     parsed.findings     || [],
      checks_ok:    parsed.checks_ok    || [],
      checks_total: parsed.checks_total || 0,
      ran_at:       parsed.ran_at       || null,
      _app_score:   parsed.score        || 0,
    };
  }

  // ── Oracle DB path ────────────────────────────────────────────────────────
  const payload = { service_name: serviceName || '', username: username || '', password: password || '', host: host || 'localhost', port: port || 1521 };
  // Agent connections use OS auth — proxy connects as / as sysdba
  if (osAuth) payload.os_auth = true;

  const resp = await agentChannel.sendToAgent(connectionId, {
    method: 'POST',
    path: '/api/healthcheck',
    body: payload,
  }, 120000);

  const parsed = resp.body || {};
  if (resp.statusCode !== 200 || !parsed.success) {
    throw new Error(parsed.error || `Proxy returned HTTP ${resp.statusCode}`);
  }
  return parsed.metrics;
}

// testProxyConnection() removed in v3.5.7 — /api/test is retired (410 Gone).
// All proxy testing routes through the outbound agent channel or `tunevault-proxy diagnose`.

// ============================================================
// Check Results Persistence
// ============================================================

// Maps structured metrics into individual check_results rows.
// One row per logical check (tablespace, top SQL, wait events summary, etc.).
// connectionId is required — demo runs (no connectionId) are not persisted.
async function persistCheckResults(connectionId, runId, metrics, scores) {
  if (!connectionId) return;

  const now = new Date();
  const rows = [];

  // Helper: score → status
  function scoreToStatus(score) {
    if (score == null) return 'error';
    if (score >= 80) return 'green';
    if (score >= 60) return 'amber';
    return 'red';
  }

  // --- Storage: one row per tablespace ---
  for (const ts of (metrics.tablespaces || [])) {
    rows.push({
      check_id: 'ST01_TABLESPACE_USAGE',
      check_category: 'storage',
      status: ts.pct_used > 90 ? 'red' : ts.pct_used > 80 ? 'amber' : 'green',
      metric_name: 'pct_used',
      metric_value: ts.pct_used,
      metric_unit: '%',
      raw_payload: ts,
      ai_summary: `${ts.name}: ${ts.pct_used}% used (${ts.used_gb}GB / ${ts.total_gb}GB)`,
      recommendation: ts.pct_used > 90 ? 'CRITICAL: Add datafile or extend tablespace immediately' : null
    });
  }

  // --- Storage: undo ---
  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    rows.push({
      check_id: 'ST02_UNDO_USAGE',
      check_category: 'storage',
      status: (u.pct_used || 0) > 90 ? 'red' : (u.pct_used || 0) > 70 ? 'amber' : 'green',
      metric_name: 'pct_used',
      metric_value: u.pct_used,
      metric_unit: '%',
      raw_payload: metrics.undo_stats,
      ai_summary: `Undo tablespace ${u.tablespace_name}: ${u.pct_used}% used`,
      recommendation: null
    });
  }

  // --- Storage: temp ---
  if (metrics.temp_stats && metrics.temp_stats.current) {
    const t = metrics.temp_stats.current;
    rows.push({
      check_id: 'ST03_TEMP_USAGE',
      check_category: 'storage',
      status: (t.pct_used || 0) > 90 ? 'red' : (t.pct_used || 0) > 70 ? 'amber' : 'green',
      metric_name: 'pct_used',
      metric_value: t.pct_used,
      metric_unit: '%',
      raw_payload: metrics.temp_stats,
      ai_summary: `Temp tablespace ${t.tablespace_name}: ${t.pct_used}% used`,
      recommendation: null
    });
  }

  // --- Performance: wait events summary ---
  rows.push({
    check_id: 'PF01_WAIT_EVENTS',
    check_category: 'performance',
    status: scoreToStatus(scores.wait_events),
    metric_name: 'score',
    metric_value: scores.wait_events,
    metric_unit: 'score',
    raw_payload: { wait_events: metrics.wait_events || [], score: scores.wait_events },
    ai_summary: `Wait events score: ${scores.wait_events}/100`,
    recommendation: scores.wait_events < 60 ? 'High wait event contention detected — review top wait classes' : null
  });

  // --- Performance: top SQL ---
  rows.push({
    check_id: 'PF02_SQL_PERFORMANCE',
    check_category: 'performance',
    status: scoreToStatus(scores.sql_performance),
    metric_name: 'score',
    metric_value: scores.sql_performance,
    metric_unit: 'score',
    raw_payload: { top_sql: metrics.top_sql || [], score: scores.sql_performance },
    ai_summary: `SQL performance score: ${scores.sql_performance}/100`,
    recommendation: scores.sql_performance < 60 ? 'Slow or high-buffer SQL detected — review top SQL report' : null
  });

  // --- Performance: active sessions ---
  const sessionResource = (metrics.resource_limits && metrics.resource_limits.current || [])
    .find(r => r.resource === 'sessions');
  rows.push({
    check_id: 'PF03_ACTIVE_SESSIONS',
    check_category: 'performance',
    status: scoreToStatus(scores.active_sessions),
    metric_name: 'pct_used',
    metric_value: sessionResource ? sessionResource.pct_max_used : null,
    metric_unit: '%',
    raw_payload: { resource_limits: metrics.resource_limits, score: scores.active_sessions },
    ai_summary: `Active sessions score: ${scores.active_sessions}/100${sessionResource ? ` (${sessionResource.pct_max_used}% of limit)` : ''}`,
    recommendation: scores.active_sessions < 60 ? 'Session count approaching limit — investigate blocking or connection pooling' : null
  });

  // --- Memory: SGA/PGA ---
  rows.push({
    check_id: 'MEM01_SGA_PGA',
    check_category: 'memory',
    status: scoreToStatus(scores.memory),
    metric_name: 'buffer_cache_hit_ratio',
    metric_value: metrics.sga_stats ? metrics.sga_stats.buffer_cache_hit_ratio : null,
    metric_unit: '%',
    raw_payload: { sga_stats: metrics.sga_stats || {}, pga_stats: metrics.pga_stats || {}, os_stats: metrics.os_stats || {}, score: scores.memory },
    ai_summary: `Memory score: ${scores.memory}/100. Buffer hit: ${metrics.sga_stats ? metrics.sga_stats.buffer_cache_hit_ratio : 'N/A'}%. OS free: ${metrics.os_stats && metrics.os_stats.free_memory_gb != null ? metrics.os_stats.free_memory_gb + ' GB' : 'N/A'}`,
    recommendation: scores.memory < 80 ? 'Memory pressure detected — check OS free RAM and Oracle SGA/PGA configuration' : null
  });

  // --- Backup: RMAN ---
  if (metrics.backup_stats && metrics.backup_stats.rman_backup) {
    const b = metrics.backup_stats.rman_backup;
    const hoursAgo = b.full_backup_hours_ago;
    rows.push({
      check_id: 'BK01_RMAN_FRESHNESS',
      check_category: 'backup',
      status: b.status === 'critical' ? 'red' : b.status === 'warning' ? 'amber' : b.status === 'ok' ? 'green' : 'amber',
      metric_name: 'full_backup_hours_ago',
      metric_value: hoursAgo,
      metric_unit: 'hours',
      raw_payload: b,
      ai_summary: b.last_full_backup ? `Last full backup: ${b.last_full_backup.end_time} (${hoursAgo}h ago)` : 'No RMAN full backup found',
      recommendation: hoursAgo > 48 ? 'CRITICAL: No backup in 48h — verify RMAN schedule immediately' : null
    });
  }

  // --- Backup: FRA usage ---
  const fraData = metrics.backup_stats && metrics.backup_stats.fra_usage;
  if (fraData) {
    const f = fraData;
    rows.push({
      check_id: 'BK02_FRA_USAGE',
      check_category: 'backup',
      status: (f.pct_used || 0) > 90 ? 'red' : (f.pct_used || 0) > 80 ? 'amber' : 'green',
      metric_name: 'pct_used',
      metric_value: f.pct_used,
      metric_unit: '%',
      raw_payload: f,
      ai_summary: `FRA usage: ${f.pct_used}%`,
      recommendation: (f.pct_used || 0) > 90 ? 'FRA nearly full — delete obsolete backups or expand FRA' : null
    });
  }

  // --- Backup: archivelog rate ---
  const archData = metrics.backup_stats && metrics.backup_stats.archivelog_rate;
  if (archData) {
    const logsPerHour = archData.switches_per_hour != null ? archData.switches_per_hour : null;
    rows.push({
      check_id: 'BK03_ARCHIVELOG_RATE',
      check_category: 'backup',
      status: archData.status === 'critical' ? 'red' : archData.status === 'warning' ? 'amber' : 'green',
      metric_name: 'logs_per_hour',
      metric_value: logsPerHour,
      metric_unit: 'logs/hr',
      raw_payload: archData,
      ai_summary: archData.archivelog_mode === false ? 'NOT in ARCHIVELOG mode' : `Archivelog rate: ${logsPerHour} switches/hr`,
      recommendation: archData.archivelog_mode === false ? 'CRITICAL: Database not in ARCHIVELOG mode — backup and recovery capability is severely limited' : null
    });
  }

  // --- Config: alert log ---
  if (metrics.alert_log) {
    const a = metrics.alert_log;
    const criticals = (a.critical || []).length;
    const warnings = (a.warning || []).length;
    rows.push({
      check_id: 'CF01_ALERT_LOG',
      check_category: 'config',
      status: criticals > 0 ? 'red' : warnings > 0 ? 'amber' : 'green',
      metric_name: 'critical_count',
      metric_value: criticals,
      metric_unit: 'events',
      raw_payload: a,
      ai_summary: `Alert log 24h: ${criticals} critical, ${warnings} warning`,
      recommendation: criticals > 0 ? 'Critical errors in alert log — review immediately' : null
    });
  }

  // --- Config: resource limits ---
  if (metrics.resource_limits) {
    rows.push({
      check_id: 'CF02_RESOURCE_LIMITS',
      check_category: 'config',
      status: scoreToStatus(scores.active_sessions),
      metric_name: 'score',
      metric_value: scores.active_sessions,
      metric_unit: 'score',
      raw_payload: metrics.resource_limits,
      ai_summary: `Resource limits: ${scoreToStatus(scores.active_sessions)}`,
      recommendation: null
    });
  }

  // --- Index health ---
  rows.push({
    check_id: 'IX01_INDEX_HEALTH',
    check_category: 'indexes',
    status: scoreToStatus(scores.index_health),
    metric_name: 'score',
    metric_value: scores.index_health,
    metric_unit: 'score',
    raw_payload: { index_analysis: metrics.index_analysis || [], score: scores.index_health },
    ai_summary: `Index health score: ${scores.index_health}/100`,
    recommendation: scores.index_health < 70 ? 'Fragmented indexes detected — run REBUILD on high-deleted-block indexes' : null
  });

  // ============================================================
  // OBSERVABILITY checks (from instance + alert_log + proxy data)
  // ============================================================

  // --- OB01: DB Uptime ---
  if (metrics.instance) {
    const inst = metrics.instance;
    const uptimeDays = inst.uptime_days || 0;
    rows.push({
      check_id: 'OB01_DB_UPTIME',
      check_category: 'observability',
      status: uptimeDays < 1 ? 'red' : uptimeDays < 7 ? 'amber' : 'green',
      metric_name: 'uptime_days',
      metric_value: uptimeDays,
      metric_unit: 'days',
      raw_payload: { uptime_days: uptimeDays, startup_time: inst.startup_time, version: inst.version },
      ai_summary: `DB uptime: ${uptimeDays} days (started ${inst.startup_time || 'unknown'})`,
      recommendation: uptimeDays < 1 ? 'Database restarted recently — verify if planned or investigate unexpected shutdown' : null
    });
  }

  // --- OB02: Alert Log Errors ---
  if (metrics.alert_log) {
    const al = metrics.alert_log;
    const summary = al.summary || {};
    const critCount = summary.critical || 0;
    const warnCount = summary.warning || 0;
    rows.push({
      check_id: 'OB02_ALERT_LOG_ERRORS',
      check_category: 'observability',
      status: critCount > 5 ? 'red' : critCount > 0 ? 'amber' : 'green',
      metric_name: 'critical_count',
      metric_value: critCount,
      metric_unit: 'events',
      raw_payload: { summary, recent_critical: (al.entries || []).filter(e => e.severity === 'critical').slice(0, 5) },
      ai_summary: `Alert log 24h: ${critCount} critical, ${warnCount} warning`,
      recommendation: critCount > 0 ? 'Critical ORA- errors in alert log — investigate immediately' : null
    });
  }

  // --- OB05: Redo Log Switches ---
  if (metrics.backup_stats && metrics.backup_stats.archivelog_rate) {
    const arch = metrics.backup_stats.archivelog_rate;
    const switchesPerHour = arch.switches_per_hour || 0;
    rows.push({
      check_id: 'OB05_REDO_LOG_SWITCHES',
      check_category: 'observability',
      status: switchesPerHour > 20 ? 'red' : switchesPerHour > 6 ? 'amber' : 'green',
      metric_name: 'switches_per_hour',
      metric_value: switchesPerHour,
      metric_unit: 'switches/hr',
      raw_payload: { switches_per_hour: switchesPerHour, switches_24h: arch.switches_24h, log_groups: arch.log_groups },
      ai_summary: `Redo log switches: ${switchesPerHour}/hr (${arch.switches_24h || 0} in 24h). ${(arch.log_groups || []).length} log groups configured`,
      recommendation: switchesPerHour > 20 ? 'Excessive log switches — increase redo log file sizes to reduce switch frequency' : null
    });
  }

  // --- OB08: Online Redo Logs ---
  if (metrics.backup_stats && metrics.backup_stats.archivelog_rate) {
    const arch = metrics.backup_stats.archivelog_rate;
    const logGroups = arch.log_groups || [];
    const avgSizeMb = logGroups.length > 0 ? logGroups.reduce((s, g) => s + (g.size_mb || 0), 0) / logGroups.length : 0;
    rows.push({
      check_id: 'OB08_ONLINE_REDO_LOGS',
      check_category: 'observability',
      status: avgSizeMb < 50 ? 'red' : avgSizeMb < 200 ? 'amber' : 'green',
      metric_name: 'avg_log_size_mb',
      metric_value: Math.round(avgSizeMb),
      metric_unit: 'MB',
      raw_payload: { log_groups: logGroups, group_count: logGroups.length, avg_size_mb: Math.round(avgSizeMb) },
      ai_summary: `${logGroups.length} redo log groups, avg size ${Math.round(avgSizeMb)}MB`,
      recommendation: avgSizeMb < 50 ? 'Redo logs are too small — increase to 500MB-1GB per group' : null
    });
  }

  // --- OB10: DB Version (informational) ---
  if (metrics.instance && metrics.instance.version) {
    rows.push({
      check_id: 'OB10_DB_VERSION',
      check_category: 'observability',
      status: 'green',
      metric_name: 'version',
      metric_value: null,
      metric_unit: null,
      raw_payload: { version: metrics.instance.version, platform: metrics.instance.platform },
      ai_summary: `Oracle version: ${metrics.instance.version} on ${metrics.instance.platform || 'unknown platform'}`,
      recommendation: null
    });
  }

  // --- OB03: Invalid Objects (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.invalid_objects) {
    const inv = metrics.db_objects.invalid_objects;
    rows.push({
      check_id: 'OB03_INVALID_OBJECTS',
      check_category: 'observability',
      status: inv.count > 20 ? 'red' : inv.count > 5 ? 'amber' : 'green',
      metric_name: 'invalid_count',
      metric_value: inv.count,
      metric_unit: 'objects',
      raw_payload: inv,
      ai_summary: `${inv.count} invalid object(s): ${inv.packages} packages, ${inv.procedures} procedures, ${inv.views} views, ${inv.triggers} triggers`,
      recommendation: inv.count > 0 ? 'Run: EXEC UTL_RECOMP.RECOMP_PARALLEL(4); to recompile invalid objects' : null
    });
  }

  // --- OB04: Stale Statistics (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.stale_stats) {
    const ss = metrics.db_objects.stale_stats;
    rows.push({
      check_id: 'OB04_STALE_STATISTICS',
      check_category: 'observability',
      status: ss.stale_count > 50 ? 'red' : ss.stale_count > 10 ? 'amber' : 'green',
      metric_name: 'stale_count',
      metric_value: ss.stale_count,
      metric_unit: 'tables',
      raw_payload: ss,
      ai_summary: `${ss.stale_count} table(s) with stale statistics. ${ss.never_analyzed} never analyzed.`,
      recommendation: ss.stale_count > 10 ? "Run: EXEC DBMS_STATS.GATHER_DATABASE_STATS(OPTIONS=>'GATHER STALE');" : null
    });
  }

  // --- OB06: Blocking Locks (from session_stats) ---
  if (metrics.session_stats) {
    const bs = metrics.session_stats.blocked_sessions || 0;
    rows.push({
      check_id: 'OB06_BLOCKING_LOCKS',
      check_category: 'observability',
      status: bs > 5 ? 'red' : bs > 0 ? 'amber' : 'green',
      metric_name: 'blocked_sessions',
      metric_value: bs,
      metric_unit: 'sessions',
      raw_payload: { blocked_sessions: bs, total_sessions: metrics.session_stats.total_sessions, active_sessions: metrics.session_stats.active_sessions },
      ai_summary: `${bs} session(s) currently blocked. Total sessions: ${metrics.session_stats.total_sessions}, active: ${metrics.session_stats.active_sessions}`,
      recommendation: bs > 0 ? 'Identify blocker: SELECT blocking_session, sid, sql_id, event FROM V$SESSION WHERE blocking_session IS NOT NULL' : null
    });
  }

  // --- OB07: Active User Sessions (from session_stats) ---
  if (metrics.session_stats) {
    const us = metrics.session_stats.user_sessions || 0;
    rows.push({
      check_id: 'OB07_LISTENER_SESSIONS',
      check_category: 'observability',
      status: us > 500 ? 'red' : us > 300 ? 'amber' : 'green',
      metric_name: 'user_sessions',
      metric_value: us,
      metric_unit: 'sessions',
      raw_payload: { user_sessions: us, active_sessions: metrics.session_stats.active_sessions, total_sessions: metrics.session_stats.total_sessions },
      ai_summary: `${us} user sessions (${metrics.session_stats.active_sessions || 0} active, ${metrics.session_stats.total_sessions || 0} total)`,
      recommendation: us > 500 ? 'High session count — review connection pooling configuration' : null
    });
  }

  // --- OB09: SCN Headroom (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.scn_headroom) {
    const scn = metrics.db_objects.scn_headroom;
    rows.push({
      check_id: 'OB09_SCN_HEADROOM',
      check_category: 'observability',
      status: scn.days_remaining != null ? (scn.days_remaining < 90 ? 'red' : scn.days_remaining < 180 ? 'amber' : 'green') : 'green',
      metric_name: 'scn_days_remaining',
      metric_value: scn.days_remaining,
      metric_unit: 'days',
      raw_payload: scn,
      ai_summary: scn.days_remaining != null ? `SCN headroom: ${scn.days_remaining} days remaining (current SCN: ${scn.current_scn})` : 'SCN headroom not calculated',
      recommendation: scn.days_remaining != null && scn.days_remaining < 90 ? 'Low SCN headroom — contact Oracle Support for guidance' : null
    });
  }

  // --- OB11: Control File Status (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.controlfiles) {
    const cf = metrics.db_objects.controlfiles;
    rows.push({
      check_id: 'OB11_CONTROLFILE_STATUS',
      check_category: 'observability',
      status: cf.invalid_count > 0 ? 'red' : cf.count < 2 ? 'amber' : 'green',
      metric_name: 'controlfile_count',
      metric_value: cf.count,
      metric_unit: 'files',
      raw_payload: cf,
      ai_summary: `${cf.count} control file(s), ${cf.invalid_count} invalid`,
      recommendation: cf.count < 2 ? 'Multiplex control files to at least 3 locations for safety' : null
    });
  }

  // --- OB12: SPFILE in use (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.spfile) {
    const sp = metrics.db_objects.spfile;
    rows.push({
      check_id: 'OB12_SPFILE_IN_USE',
      check_category: 'observability',
      status: sp.using_spfile ? 'green' : 'red',
      metric_name: 'param_file_type',
      metric_value: null,
      metric_unit: null,
      raw_payload: sp,
      ai_summary: `Parameter file type: ${sp.param_file_type}`,
      recommendation: !sp.using_spfile ? 'Database started with PFILE — create SPFILE: CREATE SPFILE FROM PFILE; and restart' : null
    });
  }

  // ============================================================
  // PERFORMANCE extended checks
  // ============================================================

  // --- PF04: Hard Parse Rate ---
  if (metrics.sga_stats) {
    const hardParses = metrics.sga_stats.hard_parses_per_sec || 0;
    rows.push({
      check_id: 'PF04_HARD_PARSE_RATE',
      check_category: 'performance',
      status: hardParses > 100 ? 'red' : hardParses > 20 ? 'amber' : 'green',
      metric_name: 'hard_parses_per_sec',
      metric_value: hardParses,
      metric_unit: 'parses/sec',
      raw_payload: { hard_parses_per_sec: hardParses, soft_parses_per_sec: metrics.sga_stats.soft_parses_per_sec || 0 },
      ai_summary: `Hard parse rate: ${hardParses}/sec. Soft parses: ${metrics.sga_stats.soft_parses_per_sec || 0}/sec`,
      recommendation: hardParses > 100 ? 'High hard parse rate — enable cursor sharing or refactor application to use bind variables' : null
    });
  }

  // --- PF05: CPU Usage ---
  if (metrics.os_stats) {
    const cpuPct = metrics.os_stats.avg_cpu_utilization_pct || 0;
    rows.push({
      check_id: 'PF05_CPU_USAGE',
      check_category: 'performance',
      status: cpuPct > 90 ? 'red' : cpuPct > 75 ? 'amber' : 'green',
      metric_name: 'cpu_pct_used',
      metric_value: cpuPct,
      metric_unit: '%',
      raw_payload: { cpu_pct: cpuPct, iowait_pct: metrics.os_stats.avg_io_wait_pct, cpu_count: metrics.os_stats.cpu_count },
      ai_summary: `CPU: ${cpuPct}% used (${metrics.os_stats.cpu_count} CPUs). I/O wait: ${metrics.os_stats.avg_io_wait_pct || 0}%`,
      recommendation: cpuPct > 90 ? 'CPU saturated — identify top CPU SQL via V$SQL ORDER BY cpu_time DESC' : null
    });
  }

  // --- PF06: IO Wait ---
  if (metrics.os_stats) {
    const ioWait = metrics.os_stats.avg_io_wait_pct || 0;
    rows.push({
      check_id: 'PF06_IO_WAIT',
      check_category: 'performance',
      status: ioWait > 20 ? 'red' : ioWait > 10 ? 'amber' : 'green',
      metric_name: 'io_wait_pct',
      metric_value: ioWait,
      metric_unit: '%',
      raw_payload: { io_wait_pct: ioWait, cpu_count: metrics.os_stats.cpu_count },
      ai_summary: `I/O wait: ${ioWait}%. Physical memory: ${metrics.os_stats.physical_memory_gb || 0}GB, free: ${metrics.os_stats.free_memory_gb || 0}GB`,
      recommendation: ioWait > 20 ? 'High I/O wait — review storage throughput, consider ASM striping or faster storage tier' : null
    });
  }

  // --- PF08: Library Cache Hit Ratio ---
  if (metrics.sga_stats) {
    const libHit = metrics.sga_stats.library_cache_hit_ratio || 0;
    rows.push({
      check_id: 'PF08_LIBRARY_CACHE_HIT',
      check_category: 'performance',
      status: libHit < 95 ? 'red' : libHit < 98 ? 'amber' : 'green',
      metric_name: 'lib_cache_hit_pct',
      metric_value: libHit,
      metric_unit: '%',
      raw_payload: { library_cache_hit_ratio: libHit, dictionary_cache_hit_ratio: metrics.sga_stats.dictionary_cache_hit_ratio || 0 },
      ai_summary: `Library cache hit: ${libHit}%. Dictionary cache hit: ${metrics.sga_stats.dictionary_cache_hit_ratio || 0}%`,
      recommendation: libHit < 95 ? 'Low library cache hit — increase SHARED_POOL_SIZE to improve SQL reuse' : null
    });
  }

  // --- PF09: Long-Running SQL (from session_stats) ---
  if (metrics.session_stats) {
    const lrs = metrics.session_stats.long_running_sql_count || 0;
    rows.push({
      check_id: 'PF09_LONG_RUNNING_SQL',
      check_category: 'performance',
      status: lrs > 5 ? 'red' : lrs > 0 ? 'amber' : 'green',
      metric_name: 'long_running_count',
      metric_value: lrs,
      metric_unit: 'statements',
      raw_payload: { long_running_count: lrs, max_runtime_min: metrics.session_stats.max_runtime_min },
      ai_summary: `${lrs} SQL statement(s) running >5 minutes. Longest: ${metrics.session_stats.max_runtime_min || 0} min`,
      recommendation: lrs > 0 ? 'Long-running SQL detected — review execution plans and lock waits' : null
    });
  }

  // --- PF10: Buffer Cache Hit Ratio ---
  if (metrics.sga_stats) {
    const bufHit = metrics.sga_stats.buffer_cache_hit_ratio || 0;
    rows.push({
      check_id: 'PF10_BUFFER_CACHE_HIT',
      check_category: 'performance',
      status: bufHit < 90 ? 'red' : bufHit < 95 ? 'amber' : 'green',
      metric_name: 'buffer_cache_hit_pct',
      metric_value: bufHit,
      metric_unit: '%',
      raw_payload: { buffer_cache_hit_ratio: bufHit, sga_size_gb: metrics.sga_stats.sga_size_gb, buffer_cache_gb: metrics.sga_stats.buffer_cache_gb },
      ai_summary: `Buffer cache hit: ${bufHit}%. Cache size: ${metrics.sga_stats.buffer_cache_gb || 0}GB / SGA: ${metrics.sga_stats.sga_size_gb || 0}GB`,
      recommendation: bufHit < 90 ? 'Low buffer cache hit ratio — increase DB_CACHE_SIZE or SGA_TARGET' : null
    });
  }

  // --- PF11: Sort Disk Ratio (from schema_stats) ---
  if (metrics.schema_stats) {
    const diskSortPct = metrics.schema_stats.disk_sort_pct || 0;
    rows.push({
      check_id: 'PF11_SORT_DISK_RATIO',
      check_category: 'performance',
      status: diskSortPct > 5 ? 'red' : diskSortPct > 1 ? 'amber' : 'green',
      metric_name: 'disk_sort_pct',
      metric_value: diskSortPct,
      metric_unit: '%',
      raw_payload: { disk_sort_pct: diskSortPct, disk_sorts: metrics.schema_stats.disk_sorts, mem_sorts: metrics.schema_stats.mem_sorts },
      ai_summary: `Disk sort ratio: ${diskSortPct}% (${metrics.schema_stats.disk_sorts || 0} disk / ${metrics.schema_stats.mem_sorts || 0} memory sorts)`,
      recommendation: diskSortPct > 5 ? 'High disk sort ratio — increase PGA_AGGREGATE_TARGET to reduce temp usage' : null
    });
  }

  // --- PF12: Table Scan Rate (from schema_stats) ---
  if (metrics.schema_stats) {
    const ftPct = metrics.schema_stats.full_table_scan_pct || 0;
    rows.push({
      check_id: 'PF12_TABLE_SCAN_RATE',
      check_category: 'performance',
      status: ftPct > 20 ? 'red' : ftPct > 10 ? 'amber' : 'green',
      metric_name: 'full_scan_pct',
      metric_value: ftPct,
      metric_unit: '%',
      raw_payload: { full_table_scan_pct: ftPct, long_scans: metrics.schema_stats.long_scans },
      ai_summary: `Full table scan rate: ${ftPct}% (${metrics.schema_stats.long_scans || 0} long table scans)`,
      recommendation: ftPct > 20 ? 'High full scan rate — review top SQL for missing index opportunities' : null
    });
  }

  // ============================================================
  // STORAGE extended checks (from available metrics)
  // ============================================================

  // --- ST04: Segment Growth (from schema_stats) ---
  if (metrics.schema_stats && metrics.schema_stats.top_segments) {
    const segs = metrics.schema_stats.top_segments;
    const largest = segs[0];
    rows.push({
      check_id: 'ST04_SEGMENT_GROWTH',
      check_category: 'storage',
      status: largest && largest.size_gb > 100 ? 'amber' : 'green',
      metric_name: 'largest_segment_gb',
      metric_value: largest ? largest.size_gb : null,
      metric_unit: 'GB',
      raw_payload: { top_segments: segs.slice(0, 5) },
      ai_summary: largest ? `Largest non-system segment: ${largest.owner}.${largest.segment_name} (${largest.segment_type}) = ${largest.size_gb}GB` : 'No large segments found',
      recommendation: null
    });
  }

  // --- ST05: Datafile Status (from schema_stats) ---
  if (metrics.schema_stats) {
    const problemDf = metrics.schema_stats.problem_datafiles || 0;
    rows.push({
      check_id: 'ST05_DATAFILE_STATUS',
      check_category: 'storage',
      status: problemDf > 0 ? 'red' : 'green',
      metric_name: 'problem_datafiles',
      metric_value: problemDf,
      metric_unit: 'count',
      raw_payload: { problem_datafiles: problemDf, offline_datafiles: metrics.schema_stats.offline_datafiles || 0 },
      ai_summary: problemDf > 0 ? `${problemDf} datafile(s) in problem state (${metrics.schema_stats.offline_datafiles || 0} offline)` : 'All datafiles accessible',
      recommendation: problemDf > 0 ? 'Offline or unavailable datafiles require immediate recovery' : null
    });
  }

  // --- ST06: Recycle Bin Size (from db_objects) ---
  if (metrics.db_objects && metrics.db_objects.recyclebin) {
    const rb = metrics.db_objects.recyclebin;
    rows.push({
      check_id: 'ST06_RECYCLEBIN_SIZE',
      check_category: 'storage',
      status: rb.size_gb > 10 ? 'red' : rb.size_gb > 2 ? 'amber' : 'green',
      metric_name: 'recyclebin_size_gb',
      metric_value: rb.size_gb,
      metric_unit: 'GB',
      raw_payload: rb,
      ai_summary: `Recycle bin: ${rb.object_count} objects, ${rb.size_gb}GB`,
      recommendation: rb.size_gb > 2 ? 'Run PURGE DBA_RECYCLEBIN to reclaim wasted space' : null
    });
  }

  // ============================================================
  // MEMORY extended checks
  // ============================================================

  // --- MEM02: Shared Pool Free ---
  if (metrics.sga_stats) {
    const spFree = metrics.sga_stats.shared_pool_free_pct || 0;
    rows.push({
      check_id: 'MEM02_SHARED_POOL_FREE',
      check_category: 'memory',
      status: spFree < 5 ? 'red' : spFree < 15 ? 'amber' : 'green',
      metric_name: 'shared_pool_free_pct',
      metric_value: spFree,
      metric_unit: '%',
      raw_payload: { shared_pool_free_pct: spFree, shared_pool_gb: metrics.sga_stats.shared_pool_gb, sga_size_gb: metrics.sga_stats.sga_size_gb },
      ai_summary: `Shared pool free: ${spFree}%. Total shared pool: ${metrics.sga_stats.shared_pool_gb || 0}GB`,
      recommendation: spFree < 5 ? 'Shared pool critically low — increase SHARED_POOL_SIZE or restart DB to clear cursor cache' : null
    });
  }

  // --- MEM03: PGA Over-Allocation ---
  if (metrics.pga_stats) {
    const pg = metrics.pga_stats;
    const multipassPct = pg.multipass_executions_pct || 0;
    const overAllocCount = pg.over_allocation_count || 0;
    rows.push({
      check_id: 'MEM03_PGA_OVERALLOC',
      check_category: 'memory',
      status: multipassPct > 5 ? 'red' : multipassPct > 1 ? 'amber' : 'green',
      metric_name: 'multipass_pct',
      metric_value: multipassPct,
      metric_unit: '%',
      raw_payload: { multipass_pct: multipassPct, over_allocation_count: overAllocCount, pga_target_gb: pg.pga_target_gb, pga_allocated_gb: pg.pga_allocated_gb, cache_hit_pct: pg.cache_hit_pct },
      ai_summary: `PGA: ${multipassPct}% multi-pass ops, ${overAllocCount} over-allocations. Cache hit: ${pg.cache_hit_pct || 0}%`,
      recommendation: multipassPct > 5 ? 'PGA under-sized — increase PGA_AGGREGATE_TARGET to reduce disk sort operations' : null
    });
  }

  // --- MEM04: Large Pool ---
  if (metrics.sga_stats && metrics.sga_stats.large_pool_gb != null) {
    const largePoolGb = metrics.sga_stats.large_pool_gb || 0;
    rows.push({
      check_id: 'MEM04_LARGE_POOL',
      check_category: 'memory',
      status: 'green',
      metric_name: 'large_pool_gb',
      metric_value: largePoolGb,
      metric_unit: 'GB',
      raw_payload: { large_pool_gb: largePoolGb, sga_size_gb: metrics.sga_stats.sga_size_gb },
      ai_summary: `Large pool: ${largePoolGb}GB allocated. (Free pct not separately tracked in proxy)`,
      recommendation: null
    });
  }

  // --- MEM05: Memory Target (AMM config) ---
  if (metrics.sga_pga_history && metrics.sga_pga_history.current) {
    const mc = metrics.sga_pga_history.current;
    rows.push({
      check_id: 'MEM05_MEMORY_TARGET',
      check_category: 'memory',
      status: 'green',
      metric_name: 'sga_target_gb',
      metric_value: mc.sga_target_gb,
      metric_unit: 'GB',
      raw_payload: { sga_target_gb: mc.sga_target_gb, pga_target_gb: mc.pga_target_gb, memory_target_gb: mc.memory_target_gb, sga_max_gb: mc.sga_max_gb },
      ai_summary: `Memory config: SGA target ${mc.sga_target_gb}GB, PGA target ${mc.pga_target_gb}GB, memory_target ${mc.memory_target_gb || 0}GB`,
      recommendation: null
    });
  }

  // ============================================================
  // BACKUP extended checks (BK04-BK06)
  // ============================================================

  // --- BK04: Backup Validation (block corruptions) ---
  if (metrics.backup_stats && metrics.backup_stats.backup_validation) {
    const bv = metrics.backup_stats.backup_validation;
    const totalCorrupt = bv.total_corruptions || 0;
    rows.push({
      check_id: 'BK04_BACKUP_VALIDATION',
      check_category: 'backup',
      status: totalCorrupt > 0 ? 'red' : bv.last_3_backups_failed ? 'red' : bv.status === 'warning' ? 'amber' : 'green',
      metric_name: 'corrupt_blocks',
      metric_value: totalCorrupt,
      metric_unit: 'blocks',
      raw_payload: { total_corruptions: totalCorrupt, backup_corruptions: bv.backup_corruptions, copy_corruptions: bv.copy_corruptions, last_3_backups_failed: bv.last_3_backups_failed },
      ai_summary: totalCorrupt > 0 ? `CRITICAL: ${totalCorrupt} backup corruption(s) detected` : `No backup corruptions. Last 3 backups failed: ${bv.last_3_backups_failed ? 'YES' : 'no'}`,
      recommendation: totalCorrupt > 0 ? 'CRITICAL: Block corruption found — run RMAN VALIDATE DATABASE and open Oracle SR immediately' : null
    });
  }

  // --- BK05: Standby Lag (Data Guard) - informational if no DG ---
  rows.push({
    check_id: 'BK05_STANDBY_LAG',
    check_category: 'backup',
    status: 'green',
    metric_name: 'apply_lag_min',
    metric_value: null,
    metric_unit: 'minutes',
    raw_payload: { note: 'Data Guard stats not collected in current proxy version — not applicable for this deployment' },
    ai_summary: 'Data Guard: not configured or not collected in proxy',
    recommendation: null
  });

  // ============================================================
  // CONFIG extended checks (CF03-CF07 from available data)
  // ============================================================

  // --- CF01 is already persisted (alert log) ---

  // --- CF03: Parameter Audit (AUDIT_TRAIL setting) - informational ---
  rows.push({
    check_id: 'CF03_AUDIT_TRAIL',
    check_category: 'config',
    status: 'green',
    metric_name: null,
    metric_value: null,
    metric_unit: null,
    raw_payload: { note: 'Audit trail parameter not collected in current proxy version' },
    ai_summary: 'Audit trail: not collected in current proxy version',
    recommendation: null
  });

  // --- CF04: Undo Retention ---
  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    const retentionMin = Math.round((u.tuned_undo_retention_s || 900) / 60);
    rows.push({
      check_id: 'CF04_UNDO_RETENTION',
      check_category: 'config',
      status: retentionMin < 15 ? 'amber' : 'green',
      metric_name: 'tuned_undo_retention_min',
      metric_value: retentionMin,
      metric_unit: 'minutes',
      raw_payload: { tuned_undo_retention_s: u.tuned_undo_retention_s, max_query_length_s: u.max_query_length_s, retention_mode: u.retention_mode },
      ai_summary: `Undo retention: ${retentionMin} min (tuned). Max query length: ${Math.round((u.max_query_length_s || 0) / 60)} min. Mode: ${u.retention_mode || 'NOGUARANTEE'}`,
      recommendation: retentionMin < 15 ? 'Short undo retention may cause ORA-01555 (snapshot too old) for long queries' : null
    });
  }

  // --- CF05: SGA/PGA Target Config ---
  if (metrics.sga_stats) {
    const sgaGb = metrics.sga_stats.sga_size_gb || 0;
    const pgaGb = (metrics.pga_stats || {}).pga_target_gb || 0;
    rows.push({
      check_id: 'CF05_MEMORY_CONFIG',
      check_category: 'config',
      status: 'green',
      metric_name: 'sga_size_gb',
      metric_value: sgaGb,
      metric_unit: 'GB',
      raw_payload: { sga_size_gb: sgaGb, pga_target_gb: pgaGb, buffer_cache_gb: metrics.sga_stats.buffer_cache_gb, shared_pool_gb: metrics.sga_stats.shared_pool_gb },
      ai_summary: `Memory: SGA ${sgaGb}GB (buffer cache ${metrics.sga_stats.buffer_cache_gb || 0}GB, shared pool ${metrics.sga_stats.shared_pool_gb || 0}GB). PGA target ${pgaGb}GB`,
      recommendation: null
    });
  }

  // ============================================================
  // INDEX extended checks
  // ============================================================

  // --- IX02: Unusable Indexes ---
  if ((metrics.index_analysis || []).length > 0) {
    const unusable = metrics.index_analysis.filter(i => i.status === 'unusable');
    rows.push({
      check_id: 'IX02_UNUSABLE_INDEXES',
      check_category: 'indexes',
      status: unusable.length > 0 ? 'red' : 'green',
      metric_name: 'unusable_count',
      metric_value: unusable.length,
      metric_unit: 'count',
      raw_payload: { unusable_indexes: unusable.map(i => ({ owner: i.owner, index_name: i.index_name, table_name: i.table_name })) },
      ai_summary: unusable.length > 0 ? `${unusable.length} unusable index(es) detected` : 'No unusable indexes found',
      recommendation: unusable.length > 0 ? 'Rebuild unusable indexes: ALTER INDEX <owner>.<name> REBUILD ONLINE;' : null
    });
  }

  // --- IX03: Fragmented Indexes ---
  if ((metrics.index_analysis || []).length > 0) {
    const fragmented = metrics.index_analysis.filter(i => i.status === 'fragmented' || i.status === 'critical');
    rows.push({
      check_id: 'IX03_FRAGMENTED_INDEXES',
      check_category: 'indexes',
      status: scoreToStatus(scores.index_health),
      metric_name: 'fragmented_count',
      metric_value: fragmented.length,
      metric_unit: 'count',
      raw_payload: { fragmented_indexes: fragmented.slice(0, 10).map(i => ({ owner: i.owner, index_name: i.index_name, blevel: i.blevel, pct_deleted: i.pct_deleted })) },
      ai_summary: `${fragmented.length} fragmented index(es). Index health score: ${scores.index_health}/100`,
      recommendation: fragmented.length > 0 ? 'Run REBUILD on heavily fragmented indexes to improve query performance' : null
    });
  }

  // ============================================================
  // SECURITY checks (SEC01-SEC07 from security_stats)
  // ============================================================

  if (metrics.security_stats) {
    const sec = metrics.security_stats;

    // --- SEC01: Default Passwords ---
    rows.push({
      check_id: 'SEC01_DEFAULT_PASSWORDS',
      check_category: 'security',
      status: sec.default_pwd_accounts > 0 ? 'red' : 'green',
      metric_name: 'default_pwd_count',
      metric_value: sec.default_pwd_accounts,
      metric_unit: 'accounts',
      raw_payload: { default_pwd_accounts: sec.default_pwd_accounts },
      ai_summary: sec.default_pwd_accounts > 0 ? `${sec.default_pwd_accounts} open account(s) with default passwords` : 'No accounts using default passwords',
      recommendation: sec.default_pwd_accounts > 0 ? 'Change default passwords immediately or lock unused accounts' : null
    });

    // --- SEC02: PUBLIC Privileges ---
    rows.push({
      check_id: 'SEC02_PUBLIC_PRIVILEGES',
      check_category: 'security',
      status: sec.dangerous_public_grants > 0 ? 'red' : 'green',
      metric_name: 'dangerous_public_grants',
      metric_value: sec.dangerous_public_grants,
      metric_unit: 'grants',
      raw_payload: { dangerous_public_grants: sec.dangerous_public_grants },
      ai_summary: sec.dangerous_public_grants > 0 ? `${sec.dangerous_public_grants} dangerous privilege(s) granted to PUBLIC` : 'No dangerous PUBLIC grants detected',
      recommendation: sec.dangerous_public_grants > 0 ? 'Revoke dangerous PUBLIC grants: REVOKE <privilege> FROM PUBLIC;' : null
    });

    // --- SEC03: Audit Trail ---
    rows.push({
      check_id: 'SEC03_AUDIT_TRAIL',
      check_category: 'security',
      status: !sec.audit_enabled ? 'amber' : 'green',
      metric_name: 'audit_trail',
      metric_value: null,
      metric_unit: null,
      raw_payload: { audit_trail: sec.audit_trail, audit_enabled: sec.audit_enabled },
      ai_summary: `Audit trail: ${sec.audit_trail}. Auditing ${sec.audit_enabled ? 'ENABLED' : 'DISABLED'}`,
      recommendation: !sec.audit_enabled ? 'Enable auditing for compliance: ALTER SYSTEM SET AUDIT_TRAIL=DB SCOPE=SPFILE; Restart required.' : null
    });

    // --- SEC04: Password Policy ---
    rows.push({
      check_id: 'SEC04_PASSWORD_POLICY',
      check_category: 'security',
      status: !sec.password_policy_active ? 'amber' : 'green',
      metric_name: 'password_verify_function',
      metric_value: null,
      metric_unit: null,
      raw_payload: { password_verify_function: sec.password_verify_function, policy_active: sec.password_policy_active },
      ai_summary: `Password verify function: ${sec.password_verify_function}. Policy: ${sec.password_policy_active ? 'ACTIVE' : 'NOT SET'}`,
      recommendation: !sec.password_policy_active ? 'Enable password verification: ALTER PROFILE DEFAULT LIMIT PASSWORD_VERIFY_FUNCTION ORA12C_STRONG_VERIFY_FUNCTION;' : null
    });

    // --- SEC05: DBA User Count ---
    rows.push({
      check_id: 'SEC05_DBA_USERS',
      check_category: 'security',
      status: sec.dba_user_count > 5 ? 'amber' : 'green',
      metric_name: 'dba_user_count',
      metric_value: sec.dba_user_count,
      metric_unit: 'users',
      raw_payload: { dba_user_count: sec.dba_user_count },
      ai_summary: `${sec.dba_user_count} non-system user(s) with DBA privilege`,
      recommendation: sec.dba_user_count > 5 ? 'Review and minimize DBA role grants — use least-privilege model' : null
    });

    // --- SEC06: Schema-only accounts open ---
    rows.push({
      check_id: 'SEC06_SCHEMA_ACCOUNTS',
      check_category: 'security',
      status: sec.open_schema_accounts > 0 ? 'amber' : 'green',
      metric_name: 'open_schema_accounts',
      metric_value: sec.open_schema_accounts,
      metric_unit: 'accounts',
      raw_payload: { open_schema_accounts: sec.open_schema_accounts },
      ai_summary: `${sec.open_schema_accounts} schema-only account(s) in OPEN status`,
      recommendation: sec.open_schema_accounts > 0 ? 'Lock schema-only accounts: ALTER USER <name> ACCOUNT LOCK;' : null
    });
  }

  // ============================================================
  // CONFIG extended (CF03-CF07) — fill in remaining checks
  // ============================================================

  // --- CF06: Resource Limit Proximity ---
  if (metrics.resource_limits && metrics.resource_limits.current) {
    const nearLimit = (metrics.resource_limits.current || []).filter(r => r.pct_max_used != null && r.pct_max_used > 80);
    rows.push({
      check_id: 'CF06_RESOURCE_UTILIZATION',
      check_category: 'config',
      status: nearLimit.some(r => r.pct_max_used > 90) ? 'red' : nearLimit.length > 0 ? 'amber' : 'green',
      metric_name: 'resources_near_limit',
      metric_value: nearLimit.length,
      metric_unit: 'count',
      raw_payload: { near_limit: nearLimit.map(r => ({ resource: r.resource, pct_max_used: r.pct_max_used, max_utilization: r.max_utilization, limit_value: r.limit_value })) },
      ai_summary: nearLimit.length > 0 ? `${nearLimit.length} resource(s) near limit: ${nearLimit.map(r => r.resource).join(', ')}` : 'All resource limits have comfortable headroom',
      recommendation: nearLimit.length > 0 ? `Increase limits for: ${nearLimit.map(r => r.resource).join(', ')}` : null
    });
  }

  // ============================================================
  // EBS OPERATIONS checks — only when metrics.ebs_operations is populated
  // ============================================================
  const ebs = metrics.ebs_operations;
  if (ebs) {
    const cm = ebs.concurrent_managers || {};
    const wf = ebs.workflow || {};
    const sec = ebs.security || {};
    const fb = ebs.functional || {};

    // CM01: Internal Manager
    if (cm.cm01) {
      const icm = cm.cm01;
      const running = icm.running_processes || 0;
      const max = icm.max_processes || 1;
      rows.push({
        check_id: 'EBS_CM01_INTERNAL_MANAGER',
        check_category: 'ebs_operations',
        status: running === 0 ? 'red' : running < max ? 'amber' : 'green',
        metric_name: 'running_processes',
        metric_value: running,
        metric_unit: 'processes',
        raw_payload: icm,
        ai_summary: `Internal Manager: ${running}/${max} processes running`,
        recommendation: running === 0 ? 'CRITICAL: Internal Manager is down — restart via FNDSM or adcmctl.sh start' : null
      });
    }

    // CM02: Standard Manager pending queue
    if (cm.cm02) {
      const pending = cm.cm02.pending_requests || 0;
      rows.push({
        check_id: 'EBS_CM02_PENDING_REQUESTS',
        check_category: 'ebs_operations',
        status: pending > 200 ? 'red' : pending > 50 ? 'amber' : 'green',
        metric_name: 'pending_requests',
        metric_value: pending,
        metric_unit: 'requests',
        raw_payload: cm.cm02,
        ai_summary: `Standard Manager pending queue: ${pending} requests`,
        recommendation: pending > 200 ? 'CRITICAL: Request backlog exceeds 200 — check manager capacity or stuck requests' : pending > 50 ? 'Pending queue elevated — monitor for growing backlog' : null
      });
    }

    // CM05: Avg runtime of completed requests last 24h
    if (cm.cm05) {
      const avg = cm.cm05.avg_runtime_secs || 0;
      rows.push({
        check_id: 'EBS_CM05_REQUEST_RUNTIME',
        check_category: 'ebs_operations',
        status: avg > 3600 ? 'red' : avg > 600 ? 'amber' : 'green',
        metric_name: 'avg_runtime_secs',
        metric_value: avg,
        metric_unit: 'seconds',
        raw_payload: cm.cm05,
        ai_summary: `CM avg request runtime: ${avg}s over last 24h (${cm.cm05.completed_24h} completed)`,
        recommendation: avg > 3600 ? 'Requests averaging >1hr — investigate long-running programs and consider resource limits' : null
      });
    }

    // CM10: Error requests last 24h
    if (cm.cm10) {
      const errs = cm.cm10.error_requests_24h || 0;
      rows.push({
        check_id: 'EBS_CM10_ERROR_REQUESTS',
        check_category: 'ebs_operations',
        status: errs > 20 ? 'red' : errs > 5 ? 'amber' : 'green',
        metric_name: 'error_requests_24h',
        metric_value: errs,
        metric_unit: 'requests',
        raw_payload: cm.cm10,
        ai_summary: `${errs} concurrent request(s) errored in last 24h`,
        recommendation: errs > 5 ? 'Review errored requests: SELECT concurrent_program_name, logfile_name FROM fnd_concurrent_requests WHERE status_code IN (\'E\',\'X\') AND actual_completion_date > SYSDATE-1' : null
      });
    }

    // Bug 3 — CM03: OPP (Output Post Processor) status
    // ebs_cm_status / ebs_opp_status — OPP is the PDF/output generation engine;
    // if it goes down, all report output silently queues with no delivery.
    if (cm.cm03) {
      const opp = cm.cm03;
      const running = opp.running_processes || 0;
      const max = opp.max_processes || 0;
      rows.push({
        check_id: 'EBS_CM03_OPP_STATUS',
        check_category: 'ebs_operations',
        status: running === 0 && max > 0 ? 'red' : running < max ? 'amber' : 'green',
        metric_name: 'running_processes',
        metric_value: running,
        metric_unit: 'processes',
        raw_payload: opp,
        ai_summary: `Output Post Processor (OPP): ${running}/${max} process(es) running`,
        recommendation: running === 0 && max > 0
          ? 'CRITICAL: OPP is down — PDF/output generation will fail. Restart via adcmctl.sh or check FNDCPOPP manager status.'
          : running < max
            ? `OPP running below target (${running}/${max}) — monitor for output delivery delays`
            : null
      });
    }

    // WF02: Workflow errors
    if (wf.wf02) {
      const errs = wf.wf02.error_count || 0;
      rows.push({
        check_id: 'EBS_WF02_WORKFLOW_ERRORS',
        check_category: 'ebs_operations',
        status: errs > 50 ? 'red' : errs > 10 ? 'amber' : 'green',
        metric_name: 'error_count',
        metric_value: errs,
        metric_unit: 'items',
        raw_payload: wf.wf02,
        ai_summary: `${errs} Workflow item(s) in ERROR status`,
        recommendation: errs > 10 ? 'Retry errored workflow items: SELECT item_type, item_key FROM wf_item_activity_statuses WHERE activity_status=\'ERROR\'' : null
      });
    }

    // WF03: Deferred queue depth
    if (wf.wf03) {
      const deferred = wf.wf03.deferred_ready || 0;
      rows.push({
        check_id: 'EBS_WF03_DEFERRED_QUEUE',
        check_category: 'ebs_operations',
        status: deferred > 500 ? 'red' : deferred > 100 ? 'amber' : 'green',
        metric_name: 'deferred_ready',
        metric_value: deferred,
        metric_unit: 'items',
        raw_payload: wf.wf03,
        ai_summary: `${deferred} Workflow deferred item(s) ready to process`,
        recommendation: deferred > 100 ? 'High deferred queue — verify WF Background Agent is running' : null
      });
    }

    // WF08: Notification backlog
    if (wf.wf08) {
      const over2h = wf.wf08.pending_over_2h || 0;
      const over8h = wf.wf08.pending_over_8h || 0;
      rows.push({
        check_id: 'EBS_WF08_NOTIFICATION_BACKLOG',
        check_category: 'ebs_operations',
        status: over8h > 100 ? 'red' : over2h > 100 ? 'amber' : 'green',
        metric_name: 'pending_over_2h',
        metric_value: over2h,
        metric_unit: 'notifications',
        raw_payload: wf.wf08,
        ai_summary: `Workflow notification backlog: ${over2h} pending >2h, ${over8h} pending >8h`,
        recommendation: over8h > 100 ? 'CRITICAL: Notification backlog >8h exceeds threshold — check Workflow Mailer service and SMTP connectivity' : over2h > 100 ? 'Notification backlog growing — verify Workflow Mailer is processing outbound mail' : null
      });
    }

    // Bug 5 — WF09: Workflow service component health (Agent Listener, Notification Mailer, etc.)
    // ebs_wf_listeners — FND_SVC_COMPONENTS; all expected services must be RUNNING.
    if (wf.wf09 && wf.wf09.length > 0) {
      const services = wf.wf09;
      const down = services.filter(s => !s.enabled && s.status !== 'NOT_CONFIGURED');
      rows.push({
        check_id: 'EBS_WF09_SERVICE_COMPONENTS',
        check_category: 'ebs_operations',
        status: down.length > 0 ? 'red' : 'green',
        metric_name: 'services_down',
        metric_value: down.length,
        metric_unit: 'services',
        raw_payload: { services },
        ai_summary: down.length > 0
          ? `${down.length} Workflow service(s) not running: ${down.map(s => s.name || s.type).join(', ')}`
          : `All ${services.length} Workflow service component(s) running`,
        recommendation: down.length > 0
          ? `Start stopped Workflow services in Oracle Applications Manager (OAM) → Service Components or via svcctl.sh`
          : null
      });
    }

    // Bug 5 — ADOP sessions: active/failed E-Business Suite online patching cycles.
    // ebs_adop_sessions — AD_ADOP_SESSIONS; active ADOP cycles block patching and indicate
    // a potentially stalled cutover that must be resolved before the next patch window.
    if (ebs._adop_status && ebs._adop_status.status !== 'skip') {
      const adop = ebs._adop_status;
      const failed = adop.failed_sessions || 0;
      const active = adop.active_sessions || 0;
      rows.push({
        check_id: 'EBS_ADOP_SESSIONS',
        check_category: 'ebs_operations',
        status: failed > 0 ? 'red' : active > 0 ? 'amber' : 'green',
        metric_name: 'adop_failed_sessions',
        metric_value: failed,
        metric_unit: 'sessions',
        raw_payload: adop,
        ai_summary: failed > 0
          ? `${failed} ADOP session(s) in FAILED state — patching cycle may be stalled`
          : active > 0
            ? `${active} active ADOP patching session(s) in progress`
            : 'No active or failed ADOP sessions',
        recommendation: failed > 0
          ? 'Investigate failed ADOP sessions: SELECT session_id, prepare_status, apply_status, cutover_status FROM ad_adop_sessions WHERE status=\'F\''
          : active > 0
            ? 'ADOP patching cycle in progress — do not start another patching cycle until cutover/cleanup is complete'
            : null
      });
    }

    // SC12: Sign-on audit
    if (sec.sc12) {
      const s12 = sec.sc12;
      rows.push({
        check_id: 'EBS_SC12_SIGNON_AUDIT',
        check_category: 'ebs_operations',
        status: s12.audit_enabled ? 'green' : 'amber',
        metric_name: 'signon_audit_level',
        metric_value: null,
        metric_unit: null,
        raw_payload: s12,
        ai_summary: `EBS sign-on audit level: ${s12.signon_audit_level}`,
        recommendation: !s12.audit_enabled ? 'Enable sign-on audit: set SIGNONAUDIT:LEVEL to FORM or USER in FND_PROFILE_OPTIONS' : null
      });
    }

    // SC14: SYSADMIN responsibility users
    if (sec.sc14) {
      const sysAdminCount = sec.sc14.length;
      rows.push({
        check_id: 'EBS_SC14_SYSADMIN_USERS',
        check_category: 'ebs_operations',
        status: sysAdminCount > 5 ? 'amber' : 'green',
        metric_name: 'sysadmin_user_count',
        metric_value: sysAdminCount,
        metric_unit: 'users',
        raw_payload: { users: sec.sc14 },
        ai_summary: `${sysAdminCount} user(s) with System Administrator responsibility`,
        recommendation: sysAdminCount > 5 ? 'Review System Administrator grants — minimize to essential staff only' : null
      });
    }

    // FB03: WF notification aging
    if (fb.fb03) {
      const stale = fb.fb03.pending_over_7d || 0;
      rows.push({
        check_id: 'EBS_FB03_NOTIFICATION_AGING',
        check_category: 'ebs_operations',
        status: stale > 200 ? 'red' : stale > 50 ? 'amber' : 'green',
        metric_name: 'pending_over_7d',
        metric_value: stale,
        metric_unit: 'notifications',
        raw_payload: fb.fb03,
        ai_summary: `${stale} WF notification(s) pending >7 days`,
        recommendation: stale > 50 ? 'Purge stale notifications: EXEC wf_purge.notifications(null, null, SYSDATE-30)' : null
      });
    }

    // FB04: Active EBS users
    if (fb.fb04) {
      const users = fb.fb04.active_users_24h || 0;
      rows.push({
        check_id: 'EBS_FB04_ACTIVE_USERS',
        check_category: 'ebs_operations',
        status: 'green',
        metric_name: 'active_users_24h',
        metric_value: users,
        metric_unit: 'users',
        raw_payload: fb.fb04,
        ai_summary: `${users} distinct EBS user(s) active in last 24h (ICX_SESSIONS)`,
        recommendation: null
      });
    }
  }

  // Bulk insert all rows
  if (rows.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO check_results
           (connection_id, run_id, check_id, check_category, status,
            metric_name, metric_value, metric_unit, raw_payload, ai_summary, recommendation, executed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          connectionId,
          runId,
          row.check_id,
          row.check_category,
          row.status,
          row.metric_name || null,
          row.metric_value != null ? row.metric_value : null,
          row.metric_unit || null,
          JSON.stringify(row.raw_payload),
          row.ai_summary || null,
          row.recommendation || null,
          now
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('persistCheckResults failed:', err.message);
  } finally {
    client.release();
  }
}

// ============================================================
// AI Analysis Engine
// ============================================================

// System prompt demands concrete, runnable SQL — never generic advice.
// TuneVault's value is giving DBAs the exact commands, not "consider adding an index".
const AI_ANALYSIS_SYSTEM_PROMPT = `You are TuneVault, an expert Oracle DBA AI agent. You produce RUNNABLE SQL COMMANDS — never vague advice.

RULES (strict):
1. Every recommendation MUST include a concrete SQL or ALTER command in a \`\`\`sql code block.
2. NEVER say "check execution plan", "consider adding an index", "review wait events", or any generic advice without the actual command.
3. For slow SQL: provide the exact DBMS_XPLAN query, the specific CREATE INDEX statement (with column names from the SQL text), or the exact optimizer hint syntax.
4. For memory issues: provide the exact ALTER SYSTEM SET command with a calculated value based on the metrics provided.
5. For stale stats: provide the exact EXEC DBMS_STATS.GATHER_TABLE_STATS command with schema and table names from the data.
6. For wait events: provide the specific parameter change or SQL rewrite to fix it.
7. If you cannot determine the exact fix from the data provided, give a DIAGNOSTIC SQL statement the DBA can run to get the missing info — still a concrete \`\`\`sql block.
8. Critical Issues section MUST list every finding with severity CRITICAL from the data. If no critical findings exist, say "No critical issues detected."
9. Use severity labels: CRITICAL (immediate action), WARNING (schedule soon), INFO (monitor).
10. Be direct. No filler. Every sentence must provide actionable value.`;

async function runAIAnalysis(healthCheckId, metrics, scores, connectionId, t0 = null, t1 = null) {
  // One UUID per health check run — shared by all check_results rows from this run
  const runId = connectionId ? crypto.randomUUID() : null;
  // t0/t1 passed from caller; default to now if not provided (e.g. direct calls)
  const effectiveT0 = t0 || Date.now();
  const effectiveT1 = t1 || Date.now();

  // Heartbeat: update analysis_progress_ms every 5s during GPT call so the
  // polling endpoint can return live elapsed time to the dashboard.
  const heartbeatStart = Date.now();
  let heartbeatTimer = null;
  function startHeartbeat() {
    heartbeatTimer = setInterval(async () => {
      const elapsedMs = Date.now() - heartbeatStart;
      try {
        await pool.query(
          `UPDATE health_checks SET analysis_progress_ms = $1, analysis_stage = 'gpt_running' WHERE id = $2`,
          [elapsedMs, healthCheckId]
        );
      } catch { /* heartbeat is best-effort — never block analysis */ }
    }, 5000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // Timing bookmarks — filled in as stages complete
  let t2 = null, t3 = null, t4 = null, t5 = null, t6 = null;
  const retryLog = [];
  let outcome = 'ai';
  // Captured after successful GPT call — shared with post-analysis fire-and-forget tasks
  let completedAnalysisText = null;

  try {
    // t2: prompt assembled
    const prompt = buildAnalysisPrompt(metrics, scores);
    t2 = Date.now();
    const promptCharCount = prompt.length;
    const promptTokenEst = Math.round(promptCharCount / 4);
    await pool.query(
      `UPDATE health_checks SET analysis_stage = 'prompt_ready' WHERE id = $1`,
      [healthCheckId]
    );
    console.log(`[pipeline] report=${healthCheckId} stage=prompt_assembled dur_prompt_ms=${t2 - effectiveT1} prompt_chars=${promptCharCount} prompt_tokens_est=${promptTokenEst}`);

    // Hard 55s abort — safety net in case SDK timeout doesn't fire
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      retryLog.push({ reason: 'abort_timeout_55s', latency_ms: Date.now() - t3 });
      controller.abort();
    }, 55000);

    // t3: GPT call started
    t3 = Date.now();
    startHeartbeat();
    await pool.query(
      `UPDATE health_checks SET analysis_stage = 'gpt_running', analysis_progress_ms = 0 WHERE id = $1`,
      [healthCheckId]
    );

    let completion;
    try {
      // Hard 55s Promise.race — guarantees resolution even if AbortController
      // doesn't cleanly terminate the HTTP request (e.g. proxy keeps connection alive).
      // The AbortController is still wired as a belt-and-suspenders measure.
      const gptPromise = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: AI_ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000
      }, { signal: controller.signal });

      const raceTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AI analysis hard timeout (55s)')), 55000);
      });

      completion = await Promise.race([gptPromise, raceTimeout]);
    } finally {
      clearTimeout(abortTimer);
      stopHeartbeat();
    }

    // t4: GPT call returned
    t4 = Date.now();
    const tokenUsage = completion.usage || {};
    const finishReason = completion.choices[0]?.finish_reason || 'unknown';
    console.log(`[ai-analysis] report=${healthCheckId} stage=gpt_returned dur_gpt_ms=${t4 - t3} prompt_tokens=${tokenUsage.prompt_tokens || 0} completion_tokens=${tokenUsage.completion_tokens || 0} total_tokens=${tokenUsage.total_tokens || 0} finish_reason=${finishReason} model=${completion.model || 'gpt-4o-mini'}`);

    // t5: response parsed into sections
    const analysis = completion.choices[0]?.message?.content || 'Analysis could not be generated.';
    completedAnalysisText = analysis;
    t5 = Date.now();

    // t6: persisted + ready for dashboard
    // Write an inline rule-based summary atomically with completion so the frontend
    // never polls a completed report with NULL summary_text. The async
    // generateExecutiveSummary() will override with AI text if it succeeds.
    // Also write an inline EBS summary so the EBS card never shows a stuck spinner.
    const inlineFindings = buildFindingsForSummary(metrics, scores);
    const inlineSummary = buildInlineSummary(scores, inlineFindings);
    const inlineAction = buildInlineAction(inlineFindings);
    const inlineRecs = buildInlineRecommendations(metrics, scores, inlineFindings);
    const inlineEbsSummary = metrics.ebs_detected ? buildInlineEbsSummary(metrics) : null;
    const inlineEbsAction = metrics.ebs_detected ? buildInlineEbsAction(metrics) : null;
    await pool.query(
      `UPDATE health_checks SET ai_analysis = $1, summary_text = $2, top_action = $3, ai_recommendations = $4, ebs_summary = $5, ebs_action = $6, status = 'completed', completed_at = NOW(), analysis_stage = 'completed', analysis_progress_ms = $7 WHERE id = $8`,
      [analysis, inlineSummary, inlineAction, JSON.stringify(inlineRecs), inlineEbsSummary, inlineEbsAction, t4 - t3, healthCheckId]
    );
    t6 = Date.now();
    suppressDripOnCheckComplete(healthCheckId);

    console.log(`[ai-analysis] report=${healthCheckId} outcome=ai latency_ms=${t6 - effectiveT0} dur_collect_ms=${effectiveT1 - effectiveT0} dur_prompt_ms=${t2 - effectiveT1} dur_gpt_ms=${t4 - t3} dur_parse_ms=${t5 - t4} dur_persist_ms=${t6 - t5} total_tokens=${tokenUsage.total_tokens || 0}`);

    // Persist timing to analysis_runs
    await pool.query(
      `INSERT INTO analysis_runs
         (health_check_id, t0_request_received, t1_metrics_written, t2_prompt_assembled,
          t3_gpt_call_start, t4_gpt_call_returned, t5_response_parsed, t6_persisted,
          model, prompt_tokens, completion_tokens, total_tokens, finish_reason,
          dur_collect_ms, dur_prompt_ms, dur_gpt_ms, dur_parse_ms, dur_persist_ms, dur_total_ms,
          outcome, retry_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        healthCheckId, effectiveT0, effectiveT1, t2, t3, t4, t5, t6,
        completion.model || 'gpt-4o-mini',
        tokenUsage.prompt_tokens || 0, tokenUsage.completion_tokens || 0, tokenUsage.total_tokens || 0,
        finishReason,
        effectiveT1 - effectiveT0, t2 - effectiveT1, t4 - t3, t5 - t4, t6 - t5, t6 - effectiveT0,
        'ai', JSON.stringify(retryLog)
      ]
    ).catch(err => console.error(`[ai-analysis] report=${healthCheckId} analysis_runs_write_error=${err.message}`));

  } catch (err) {
    stopHeartbeat();
    const latencyMs = Date.now() - effectiveT0;
    const gptMs = t3 ? Date.now() - t3 : null;
    console.error(`[ai-analysis] report=${healthCheckId} error=${err.message} latency_ms=${latencyMs}${gptMs !== null ? ` dur_gpt_ms=${gptMs}` : ''}`);
    outcome = 'fallback';

    // Fallback to rule-based analysis — always completes the health check.
    // Also generate an inline rule-based executive summary so the frontend
    // never shows a "Generating executive summary..." spinner on the fallback path.
    try {
      const fallback = generateFallbackAnalysis(metrics, scores);

      // Build rule-based executive summary inline — same logic as generateExecutiveSummary catch block
      const fallbackFindings = buildFindingsForSummary(metrics, scores);
      const fbCritCount = fallbackFindings.filter(f => f.severity === 'critical').length;
      const fbWarnCount = fallbackFindings.filter(f => f.severity === 'warning').length;
      let inlineSummary;
      if (scores.overall < 50) {
        inlineSummary = 'This database is in critical condition and requires immediate DBA intervention.';
      } else if (scores.overall < 75) {
        inlineSummary = 'This database is in a degraded state with several issues that need prompt attention.';
      } else {
        inlineSummary = 'This database is in acceptable health with minor items to monitor.';
      }
      if (fbCritCount > 0) {
        const hasStorage = fallbackFindings.some(f => f.severity === 'critical' && f.category === 'Storage');
        const hasPerf = fallbackFindings.some(f => f.severity === 'critical' && f.category === 'Performance');
        const hasBackup = fallbackFindings.some(f => f.severity === 'critical' && f.category === 'Backup');
        const impacts = [];
        if (hasStorage) impacts.push('storage capacity risks that could halt operations');
        if (hasPerf) impacts.push('performance issues affecting response times');
        if (hasBackup) impacts.push('backup gaps that increase data loss exposure');
        if (impacts.length === 0) impacts.push('issues that could impact service availability');
        inlineSummary += ` ${impacts.join(' and ')} were detected.`;
        inlineSummary += ' Immediate action is recommended to prevent service disruption.';
      } else if (fbWarnCount > 0) {
        inlineSummary += ` ${fbWarnCount} item(s) should be reviewed within the next maintenance window.`;
      }
      const inlineAction = buildInlineAction(fallbackFindings);

      const fallbackRecs = buildInlineRecommendations(metrics, scores, fallbackFindings);
      const fbEbsSummary = metrics.ebs_detected ? buildInlineEbsSummary(metrics) : null;
      const fbEbsAction = metrics.ebs_detected ? buildInlineEbsAction(metrics) : null;
      t6 = Date.now();
      await pool.query(
        `UPDATE health_checks SET ai_analysis = $1, summary_text = $2, top_action = $3, ai_recommendations = $4, ebs_summary = $5, ebs_action = $6, status = 'completed', completed_at = NOW(), analysis_stage = 'completed_fallback', analysis_progress_ms = $7 WHERE id = $8`,
        [fallback, inlineSummary, inlineAction, JSON.stringify(fallbackRecs), fbEbsSummary, fbEbsAction, latencyMs, healthCheckId]
      );
      console.log(`[ai-analysis] report=${healthCheckId} fallback_with_summary=true crit=${fbCritCount} warn=${fbWarnCount} recs=${fallbackRecs.length}`);
      suppressDripOnCheckComplete(healthCheckId);
    } catch (fallbackErr) {
      outcome = 'error';
      console.error(`[ai-analysis] report=${healthCheckId} fallback_error=${fallbackErr.message}`);
      try {
        t6 = Date.now();
        // Write a minimal EBS summary too so the EBS card doesn't show an infinite spinner
        const errEbsSummary = metrics.ebs_detected ? 'EBS application layer was detected. Check the EBS sections below for operational details.' : null;
        await pool.query(
          `UPDATE health_checks SET ai_analysis = $1, summary_text = $2, top_action = $3, ebs_summary = COALESCE(ebs_summary, $4), status = 'completed', completed_at = NOW(), analysis_stage = 'completed_error' WHERE id = $5`,
          [
            '## Analysis Unavailable\n\nAI analysis could not be generated for this health check. The report data is still available in the tabs above.',
            'Health check data is available — AI analysis could not be generated at this time.',
            'Review the health check tabs above for detailed findings.',
            errEbsSummary,
            healthCheckId
          ]
        );
        suppressDripOnCheckComplete(healthCheckId);
      } catch (dbErr) {
        console.error(`[ai-analysis] report=${healthCheckId} db_write_error=${dbErr.message}`);
      }
    }

    // Persist error timing to analysis_runs
    pool.query(
      `INSERT INTO analysis_runs
         (health_check_id, t0_request_received, t1_metrics_written, t2_prompt_assembled,
          t3_gpt_call_start, t4_gpt_call_returned, t5_response_parsed, t6_persisted,
          dur_collect_ms, dur_prompt_ms, dur_gpt_ms, dur_total_ms,
          outcome, error_message, retry_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        healthCheckId, effectiveT0, effectiveT1 || null, t2, t3, t4, t5, t6,
        effectiveT1 ? effectiveT1 - effectiveT0 : null,
        t2 && effectiveT1 ? t2 - effectiveT1 : null,
        t3 && t4 ? t4 - t3 : (t3 ? Date.now() - t3 : null),
        latencyMs,
        outcome, err.message, JSON.stringify(retryLog)
      ]
    ).catch(e => console.error(`[ai-analysis] report=${healthCheckId} analysis_runs_error_write=${e.message}`));
  }

  // Generate executive summary (fire-and-forget — displayed prominently at top of report)
  generateExecutiveSummary(healthCheckId, metrics, scores).catch(err => {
    console.error('generateExecutiveSummary error:', err.message);
  });

  // Generate structured recommendations with confidence badges + evidence trails (fire-and-forget)
  // Pass completedAnalysisText so GPT can extract verbatim fix_sql commands from the analysis.
  generateStructuredRecommendations(healthCheckId, metrics, scores, completedAnalysisText).catch(err => {
    console.error('generateStructuredRecommendations error:', err.message);
  });

  // Persist individual check rows for history/trends (fire-and-forget — never blocks HC completion)
  if (runId) {
    persistCheckResults(connectionId, runId, metrics, scores).catch(err => {
      console.error('persistCheckResults error:', err.message);
    });
  }

  // Autonomous monitoring delta — runs after persist so check_results are available
  if (connectionId) {
    runDeltaForConnection(connectionId, healthCheckId).catch(err => {
      console.error('[schedule-runner] delta error:', err.message);
    });
  }

  // ADOP patch-cycle detection — EBS connections only, fire-and-forget
  if (connectionId) {
    detectAndPersistAdopState(connectionId).catch(err => {
      console.error('[adop-detector] fire-and-forget error:', err.message);
    });
  }

  // TuneOps ticket engine — create/reopen/resolve tickets from health check findings
  if (connectionId) {
    processHealthCheckFindings(connectionId, healthCheckId).catch(err => {
      console.error('[tuneops-engine] processHealthCheckFindings error:', err.message);
    });
  }

  // Health check completion email — fire-and-forget, never blocks
  sendHcCompletionEmail({ healthCheckId, connectionId, metrics, scores }).catch(err => {
    console.error('[hc-email] fire-and-forget error:', err.message);
  });
}

// ============================================================
// Executive Summary Generator
// Produces a 3-sentence summary + single top action for the
// "TuneVault AI Summary" card shown at top of every report.
// Input: top 15 findings ranked by severity. Max ~800 tokens in.
// ============================================================

async function generateExecutiveSummary(healthCheckId, metrics, scores) {
  const startMs = Date.now();
  console.log(`[executive-summary] report=${healthCheckId} server_type=${metrics && metrics.server_type} score=${scores && scores.overall}`);
  try {
    // EBS app-tier: proxy findings come as metrics.findings[] — completely different data shape
    if (metrics.server_type === 'apps') {
      const appFindings = metrics.findings || [];
      const appOk = metrics.checks_ok || [];
      const critItems = appFindings.filter(f => f.severity === 'critical');
      const warnItems = appFindings.filter(f => f.severity === 'warning');

      if (appFindings.length === 0) {
        await pool.query(
          `UPDATE health_checks SET summary_text = $1, top_action = $2 WHERE id = $3`,
          [
            appOk.length > 0 ? `All ${appOk.length} EBS app tier components are healthy — no issues found.` : 'EBS app tier health check completed with no findings.',
            'Continue monitoring on the current schedule.',
            healthCheckId
          ]
        );
        return;
      }

      const appFindingsText = appFindings.map((f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}: ${f.details}`
      ).join('\n');
      const appOkText = appOk.slice(0, 6).map(c => `- ${c.title}: ${c.details}`).join('\n') || 'None';

      const appRaceTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Executive summary generation timeout (30s)')), 30000)
      );
      const appCompletion = await Promise.race([openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a senior Oracle E-Business Suite administrator writing a terse technical brief for another EBS admin who needs to act right now.

RULES:
1. CORE_DB_SUMMARY: 3-5 sentences. Name specific components by their exact names (e.g. "forms-c4ws_server1 is shutdown"). Include exact counts (X critical, Y warnings). State the business impact concretely — which users/functionality is broken. Write for an EBS DBA, not a manager.
2. TOP_DB_ACTION: 1-2 sentences. The single most urgent fix with the exact EBS command. Example: "Start forms-c4ws_server1 — run as applmgr: admanagedsrvctl.sh start forms-c4ws_server1"
3. Never use phrases like "requires immediate attention", "service disruption", or "your team has the details below".

CRITICAL RULES FOR EBS APP TIER COMMANDS:
All EBS admin scripts are in $ADMIN_SCRIPTS_HOME (set by sourcing EBSapps.env). Run as applmgr OS user.

- Managed server down → admanagedsrvctl.sh start <server_name>
- Managed server stop → admanagedsrvctl.sh stop <server_name>
- Admin Server → adadminsrvctl.sh start (WLS pwd then APPS pwd via stdin)
- Node Manager → adnodemgrctl.sh start
- Apache/OHS → adapcctl.sh start
- OPMN → adopmnctl.sh start
- Apps Listener → adalnctl.sh start
- Concurrent Manager → adcmctl.sh start apps/<password>
- Workflow Mailer → Cannot be started via command line. Navigate: EBS System Administrator → Oracle Applications Manager → Service Components → Find "Workflow Notification Mailer" → click Activate. Or use: SELECT component_name, component_status FROM fnd_svc_components WHERE component_type='WF_MAILER';
- Invalid objects → Run on DB SERVER as sysdba: sqlplus / as sysdba @$ORACLE_HOME/rdbms/admin/utlrp.sql
- Tablespace → Run on DB SERVER: ALTER TABLESPACE <name> ADD DATAFILE SIZE 1G AUTOEXTEND ON NEXT 512M MAXSIZE UNLIMITED;
- NEVER use $AD_TOP/bin, stopall.sh, startall.sh, or any Oracle DB home bin scripts for EBS app tier fixes
- NEVER suggest adapcctl.sh for Workflow Mailer — it starts Apache not the mailer`
          },
          {
            role: 'user',
            content: `EBS App Tier health check — score: ${scores.overall}/100\n${critItems.length} critical, ${warnItems.length} warnings\n\nFindings:\n${appFindingsText}\n\nPassing checks (context):\n${appOkText}\n\nWrite:\nCORE_DB_SUMMARY: <3-5 sentences naming specific down components and business impact>\nTOP_DB_ACTION: <1-2 sentences with exact EBS command to fix the top issue>`
          }
        ],
        temperature: 0.2,
        max_tokens: 400
      }), appRaceTimeout]);

      const appRaw = appCompletion.choices[0]?.message?.content || '';
      const appSummaryMatch = appRaw.match(/CORE_DB_SUMMARY:\s*(.+?)(?=TOP_DB_ACTION:|$)/s);
      const appActionMatch = appRaw.match(/TOP_DB_ACTION:\s*(.+)/s);
      const appSummaryText = (appSummaryMatch ? appSummaryMatch[1] : appRaw).trim();
      const appTopAction = appActionMatch ? appActionMatch[1].trim() : null;

      await pool.query(
        `UPDATE health_checks SET summary_text = $1, top_action = $2 WHERE id = $3`,
        [appSummaryText, appTopAction, healthCheckId]
      );
      console.log(`[executive-summary] report=${healthCheckId} app_tier=true crit=${critItems.length} warn=${warnItems.length} latency_ms=${Date.now() - startMs}`);
      return;
    }

    // Build compact findings list for prompt — critical first, max 15
    const findings = buildFindingsForSummary(metrics, scores);
    const top15 = findings.slice(0, 15);

    if (top15.length === 0) {
      await pool.query(
        `UPDATE health_checks SET summary_text = $1, top_action = $2 WHERE id = $3`,
        ['No critical or high-severity issues detected. The database is healthy across all monitored dimensions.', 'Continue monitoring on the current schedule.', healthCheckId]
      );
      return;
    }

    // Pass real metric names/values — DBA needs specifics, not executive translations.
    const findingsText = top15.map((f, i) =>
      `${i + 1}. [${f.severity.toUpperCase()}] ${f.category} — ${f.metric}: ${f.value}`
    ).join('\n');

    // EBS operational context — passed to GPT only for the EBS-specific section.
    // Never included in core DB findings to prevent leaking EBS terms into DB summary.
    let ebsContext = '';
    const hasEbs = !!(metrics.ebs_detected);
    if (hasEbs) {
      const ebsOps = metrics.ebs_operations;
      const cmPending = ebsOps && ebsOps.concurrent_managers && ebsOps.concurrent_managers.cm02 ? ebsOps.concurrent_managers.cm02.pending_requests : null;
      const wfErrors = ebsOps && ebsOps.workflow && ebsOps.workflow.wf02 ? ebsOps.workflow.wf02.error_count : null;
      const notifBacklog = ebsOps && ebsOps.workflow && ebsOps.workflow.wf08 ? ebsOps.workflow.wf08.pending_over_2h : null;
      const cmStatus = ebsOps && ebsOps.concurrent_managers && ebsOps.concurrent_managers.cm01 ? ebsOps.concurrent_managers.cm01.status : null;
      const wfMailerErrors = ebsOps && ebsOps.workflow && ebsOps.workflow.wf03 ? ebsOps.workflow.wf03.error_count : null;
      ebsContext = `\n\nOracle E-Business Suite detected. App-layer findings (for EBS_SUMMARY only — never include in CORE_DB_SUMMARY):`;
      if (cmStatus !== null) ebsContext += `\n- Concurrent Manager status: ${cmStatus}`;
      if (cmPending !== null) ebsContext += `\n- CM pending requests: ${cmPending}`;
      if (wfErrors !== null) ebsContext += `\n- Workflow errors: ${wfErrors}`;
      if (wfMailerErrors !== null) ebsContext += `\n- Workflow Mailer errors: ${wfMailerErrors}`;
      if (notifBacklog !== null) ebsContext += `\n- Notification backlog (>2h): ${notifBacklog}`;
    }

    // 30s timeout — fire-and-forget function, must not hang indefinitely
    const summaryRaceTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Executive summary generation timeout (30s)')), 30000)
    );
    const completion = await Promise.race([openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a senior Oracle DBA writing a terse technical brief for another DBA who needs to act right now. Two sections: core Oracle DB summary and (if EBS detected) a separate EBS app-layer summary.

RULES:
1. CORE_DB_SUMMARY: 3-5 sentences. Use the exact metric names from the findings (tablespace names, wait event names, percentages). Quantify: "X critical findings, Y warnings". State the specific impact — which operations are at risk. End with the single most urgent area. Write for a DBA, not a manager.
2. TOP_DB_ACTION: 1-2 sentences. The single most urgent fix with a specific runnable SQL query. Format: "Fix <specific issue> — run: <SQL here>"
3. Never use phrases like "requires immediate attention", "service disruption risk", or "your DBA team has the details".
4. EBS_SUMMARY (only if EBS detected): 2 sentences. Name specific EBS services with their exact status and which users/functionality is affected.
5. EBS_ACTION (only if EBS detected): 1 sentence with a specific EBS command or SQL query.
6. If EBS is NOT detected, omit EBS_SUMMARY and EBS_ACTION entirely.

GOOD TOP_DB_ACTION example: "log file sync at 71.8% of DB time indicates redo log I/O bottleneck — check: SELECT group#, bytes/1024/1024 mb, status FROM v\$log ORDER BY group#;"
BAD TOP_DB_ACTION example: "Address the most urgent performance issue — your DBA team has the details."`
        },
        {
          role: 'user',
          content: `Oracle database health check — score: ${scores.overall}/100\n${top15.filter(f => f.severity === 'critical').length} critical findings, ${top15.filter(f => f.severity === 'warning').length} warnings\n\nFindings:\n${findingsText}${ebsContext}\n\nWrite the structured brief. Include EBS sections only if EBS is detected:\nCORE_DB_SUMMARY: <3-5 sentences using exact metric names from findings, quantify counts, name most urgent area>\nTOP_DB_ACTION: <1-2 sentences with specific runnable SQL to diagnose or fix the top issue>\n${hasEbs ? 'EBS_SUMMARY: <2 sentences naming specific EBS services and their status — no DB metrics>\nEBS_ACTION: <1 sentence with specific EBS command or SQL>' : ''}`
        }
      ],
      temperature: 0.2,
      max_tokens: hasEbs ? 600 : 400
    }), summaryRaceTimeout]);

    const raw = completion.choices[0]?.message?.content || '';
    const latencyMs = Date.now() - startMs;
    const tokenUsage = completion.usage || {};

    // Parse structured output — core DB fields always present; EBS fields only when EBS detected
    const coreDbMatch = raw.match(/CORE_DB_SUMMARY:\s*(.+?)(?=TOP_DB_ACTION:|EBS_SUMMARY:|$)/s);
    const topDbMatch = raw.match(/TOP_DB_ACTION:\s*(.+?)(?=EBS_SUMMARY:|EBS_ACTION:|$)/s);
    const ebsSummaryMatch = raw.match(/EBS_SUMMARY:\s*(.+?)(?=EBS_ACTION:|$)/s);
    const ebsActionMatch = raw.match(/EBS_ACTION:\s*(.+)/s);

    // Fall back to legacy SUMMARY: format if model used old pattern
    const legacySummaryMatch = !coreDbMatch ? raw.match(/SUMMARY:\s*(.+?)(?=TOP_ACTION:|$)/s) : null;
    const legacyActionMatch = !topDbMatch ? raw.match(/TOP_ACTION:\s*(.+)/s) : null;

    const summaryText = (coreDbMatch ? coreDbMatch[1] : legacySummaryMatch ? legacySummaryMatch[1] : raw).trim();
    const topAction = (topDbMatch ? topDbMatch[1] : legacyActionMatch ? legacyActionMatch[1] : null)?.trim() || null;
    const ebsSummary = ebsSummaryMatch ? ebsSummaryMatch[1].trim() : null;
    const ebsAction = ebsActionMatch ? ebsActionMatch[1].trim() : null;

    await pool.query(
      `UPDATE health_checks SET summary_text = $1, top_action = $2, ebs_summary = $3, ebs_action = $4 WHERE id = $5`,
      [summaryText, topAction, ebsSummary, ebsAction, healthCheckId]
    );

    // Telemetry: one log per summary generation
    console.log(`[executive-summary] report=${healthCheckId} latency_ms=${latencyMs} prompt_tokens=${tokenUsage.prompt_tokens || 0} completion_tokens=${tokenUsage.completion_tokens || 0} total_tokens=${tokenUsage.total_tokens || 0} has_ebs=${hasEbs} has_ebs_summary=${!!ebsSummary}`);
  } catch (err) {
    console.error(`[executive-summary] report=${healthCheckId} error=${err.message}`);
    // Build a rule-based exec summary fallback — executive-level, no raw metrics
    try {
      const fallbackFindings = buildFindingsForSummary(metrics, scores);
      const critCount = fallbackFindings.filter(f => f.severity === 'critical').length;
      const warnCount = fallbackFindings.filter(f => f.severity === 'warning').length;

      // Executive-level posture statement — no tablespace names, no SQL IDs
      let fallbackSummary;
      if (scores.overall < 50) {
        fallbackSummary = 'This database is in critical condition and requires immediate DBA intervention.';
      } else if (scores.overall < 75) {
        fallbackSummary = 'This database is in a degraded state with several issues that need prompt attention.';
      } else {
        fallbackSummary = 'This database is in acceptable health with minor items to monitor.';
      }

      if (critCount > 0) {
        const hasStorage = fallbackFindings.some(f => f.severity === 'critical' && f.category === 'Storage');
        const hasPerf = fallbackFindings.some(f => f.severity === 'critical' && f.category === 'Performance');
        const impacts = [];
        if (hasStorage) impacts.push('storage capacity risks that could halt operations');
        if (hasPerf) impacts.push('performance issues affecting response times');
        if (impacts.length === 0) impacts.push('issues that could impact service availability');
        fallbackSummary += ` ${impacts.join(' and ')} were detected.`;
      } else if (warnCount > 0) {
        fallbackSummary += ` ${warnCount} item(s) should be reviewed within the next maintenance window.`;
      }

      if (critCount > 0) {
        fallbackSummary += ' Immediate action is recommended to prevent service disruption.';
      }

      const fallbackAction = buildInlineAction(fallbackFindings) || null;

      // Rule-based EBS fallback so the EBS card never stays stuck on the spinner
      const fbEbsSummary = metrics.ebs_detected ? buildInlineEbsSummary(metrics) : null;
      const fbEbsAction = metrics.ebs_detected ? buildInlineEbsAction(metrics) : null;

      await pool.query(
        `UPDATE health_checks SET summary_text = COALESCE(summary_text, $1), top_action = COALESCE(top_action, $2), ebs_summary = COALESCE(ebs_summary, $3), ebs_action = COALESCE(ebs_action, $4) WHERE id = $5`,
        [fallbackSummary, fallbackAction, fbEbsSummary, fbEbsAction, healthCheckId]
      );
    } catch (dbErr) {
      console.error(`[executive-summary] report=${healthCheckId} fallback_write_error=${dbErr.message}`);
    }
  }
}

// Build compact EBS-layer findings for the EBS_SUMMARY section.
// Returns status items for CM, Workflow, Mailer — never includes Oracle DB metrics.
function buildEbsFindingsForSummary(metrics) {
  const items = [];
  const ebsOps = metrics.ebs_operations;
  if (!ebsOps) return items;
  const cm = ebsOps.concurrent_managers || {};
  const wf = ebsOps.workflow || {};
  // CM status
  if (cm.cm01 && cm.cm01.status && cm.cm01.status.toLowerCase() !== 'normal') {
    items.push(`Concurrent Manager is ${cm.cm01.status}`);
  }
  if (cm.cm02 && cm.cm02.pending_requests > 50) {
    items.push(`${cm.cm02.pending_requests} CM requests pending`);
  }
  // Workflow errors
  if (wf.wf02 && wf.wf02.error_count > 0) {
    items.push(`${wf.wf02.error_count} Workflow errors`);
  }
  if (wf.wf03 && wf.wf03.error_count > 0) {
    items.push(`${wf.wf03.error_count} Workflow Mailer errors`);
  }
  if (wf.wf08 && wf.wf08.pending_over_2h > 0) {
    items.push(`${wf.wf08.pending_over_2h} notifications stuck >2h`);
  }
  return items;
}

// Build a flat findings array for the executive summary prompt.
// Only critical and warning items — ordered critical first.
function buildFindingsForSummary(metrics, scores) {
  const findings = [];

  // EBS app-tier: findings come directly from the proxy response
  if (metrics.server_type === 'apps') {
    const sevOrder = { critical: 0, warning: 1 };
    return (metrics.findings || [])
      .map(f => ({
        severity: f.severity === 'critical' ? 'critical' : 'warning',
        category: 'EBS App',
        metric: f.title,
        value: f.details
      }))
      .sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));
  }

  // Tablespace
  (metrics.tablespaces || []).forEach(t => {
    if (t.pct_used > 90) findings.push({ severity: 'critical', category: 'Storage', metric: `${t.name} tablespace`, value: `${t.pct_used}% used (${t.used_gb}GB/${t.total_gb}GB), autoextend=${t.autoextend}` });
    else if (t.pct_used > 80) findings.push({ severity: 'warning', category: 'Storage', metric: `${t.name} tablespace`, value: `${t.pct_used}% used` });
  });

  // Wait events
  (metrics.wait_events || []).filter(w => w.pct_db_time > 10).forEach(w => {
    findings.push({ severity: 'critical', category: 'Performance', metric: `Wait: ${w.event}`, value: `${w.pct_db_time}% DB time (${w.wait_class})` });
  });
  (metrics.wait_events || []).filter(w => w.pct_db_time > 5 && w.pct_db_time <= 10).forEach(w => {
    findings.push({ severity: 'warning', category: 'Performance', metric: `Wait: ${w.event}`, value: `${w.pct_db_time}% DB time` });
  });

  // SQL
  (metrics.top_sql || []).filter(sq => sq.elapsed_per_exec_ms > 5).forEach(sq => {
    findings.push({ severity: 'warning', category: 'SQL', metric: `SQL ${sq.sql_id}`, value: `${sq.elapsed_per_exec_ms}ms/exec — ${sq.issue}` });
  });

  // Index
  (metrics.index_analysis || []).filter(i => i.pct_deleted > 50).forEach(i => {
    findings.push({ severity: 'critical', category: 'Indexes', metric: `${i.index_name} on ${i.table_name}`, value: `${i.pct_deleted}% deleted blocks` });
  });
  (metrics.index_analysis || []).filter(i => i.pct_deleted > 30 && i.pct_deleted <= 50).forEach(i => {
    findings.push({ severity: 'warning', category: 'Indexes', metric: `${i.index_name}`, value: `${i.pct_deleted}% fragmented` });
  });

  // Backup
  if (metrics.backup_stats) {
    const b = metrics.backup_stats;
    if (b.overall_status === 'critical') {
      const rman = b.rman_backup || {};
      findings.push({ severity: 'critical', category: 'Backup', metric: 'RMAN backup', value: rman.last_full_backup ? `Last full ${rman.full_backup_hours_ago}h ago` : 'No full backup found' });
    } else if (b.overall_status === 'warning') {
      const rman = b.rman_backup || {};
      findings.push({ severity: 'warning', category: 'Backup', metric: 'RMAN backup', value: rman.last_full_backup ? `Last full ${rman.full_backup_hours_ago}h ago` : 'Backup status degraded' });
    }
  }

  // Undo
  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    const hist = metrics.undo_stats.historical || {};
    if (hist.peak_query_length_s && u.tuned_undo_retention_s && hist.peak_query_length_s > u.tuned_undo_retention_s) {
      findings.push({ severity: 'critical', category: 'Config', metric: 'Undo retention', value: `Longest query (${hist.peak_query_length_s}s) exceeds UNDO_RETENTION (${u.tuned_undo_retention_s}s) — ORA-01555 risk` });
    } else if (u.pct_used > 90) {
      findings.push({ severity: 'critical', category: 'Storage', metric: 'Undo tablespace', value: `${u.pct_used}% used` });
    }
  }

  // Resource limits
  (metrics.resource_limits && metrics.resource_limits.current || []).filter(r => r.status === 'critical').forEach(r => {
    findings.push({ severity: 'critical', category: 'Config', metric: `Resource limit: ${r.resource}`, value: `${r.pct_max_used}% of limit` });
  });

  // PGA
  if (metrics.sga_pga_history && metrics.sga_pga_history.pga_history) {
    const pgaHist = metrics.sga_pga_history.pga_history;
    const pgaTarget = metrics.sga_pga_history.current && metrics.sga_pga_history.current.pga_target_gb;
    if (pgaHist.peak_allocated_gb && pgaTarget && pgaHist.peak_allocated_gb > pgaTarget * 1.2) {
      findings.push({ severity: 'warning', category: 'Memory', metric: 'PGA undersized', value: `Peak ${pgaHist.peak_allocated_gb}GB vs target ${pgaTarget}GB` });
    }
  }

  // Sort critical → warning
  const sevOrder = { critical: 0, warning: 1 };
  findings.sort((a, b) => (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2));
  return findings;
}

// Build an inline rule-based executive summary. Written atomically with status='completed'
// so the frontend never sees a completed report with NULL summary_text.
// The async generateExecutiveSummary() will override with a better AI-generated version.
function buildInlineSummary(scores, findings) {
  const critCount = findings.filter(f => f.severity === 'critical').length;
  const warnCount = findings.filter(f => f.severity === 'warning').length;

  // EBS app-tier findings use {category:'EBS App', metric:title, value:details}
  const isAppTier = findings.some(f => f.category === 'EBS App');
  if (isAppTier) {
    const critFindings = findings.filter(f => f.severity === 'critical');
    const warnFindings = findings.filter(f => f.severity === 'warning');
    if (critCount === 0 && warnCount === 0) {
      return `EBS app tier is healthy — all ${findings.length > 0 ? findings.length : ''} checks passed.`.trim();
    }
    let summary = `EBS app tier health check scored ${scores.overall}/100 with ${critCount} critical finding${critCount !== 1 ? 's' : ''} and ${warnCount} warning${warnCount !== 1 ? 's' : ''}.`;
    if (critFindings.length > 0) {
      const names = critFindings.slice(0, 2).map(f => f.metric || f.title).filter(Boolean);
      if (names.length) summary += ` Critical: ${names.join(', ')}.`;
    }
    summary += ' AI analysis is generating — check back shortly for specific remediation steps.';
    return summary;
  }

  let summary;
  if (scores.overall < 50) {
    summary = 'This database is in critical condition and requires immediate DBA intervention.';
  } else if (scores.overall < 75) {
    summary = 'This database is in a degraded state with several issues that need prompt attention.';
  } else {
    summary = 'This database is in acceptable health with minor items to monitor.';
  }
  if (critCount > 0) {
    const hasStorage = findings.some(f => f.severity === 'critical' && f.category === 'Storage');
    const hasPerf = findings.some(f => f.severity === 'critical' && f.category === 'Performance');
    const hasBackup = findings.some(f => f.severity === 'critical' && f.category === 'Backup');
    const impacts = [];
    if (hasStorage) impacts.push('storage capacity risks that could halt operations');
    if (hasPerf) impacts.push('performance issues affecting response times');
    if (hasBackup) impacts.push('backup gaps that increase data loss exposure');
    if (impacts.length === 0) impacts.push('issues that could impact service availability');
    summary += ` ${impacts.join(' and ')} were detected.`;
    summary += ' Immediate action is recommended to prevent service disruption.';
  } else if (warnCount > 0) {
    summary += ` ${warnCount} item(s) should be reviewed within the next maintenance window.`;
  }
  return summary;
}

// Build an inline top-action string from findings. Provides specific SQL or command per category.
function buildInlineAction(findings) {
  const topFinding = findings[0];
  if (!topFinding) return 'Continue monitoring on the current schedule.';
  if (topFinding.category === 'EBS App') {
    const t = topFinding.metric.toLowerCase();
    if (t.includes('forms') || t.includes('oacore') || t.includes('managed server')) {
      const match = (topFinding.value || topFinding.details || '').match(/:\s*(\S*server\S*)/i);
      const serverName = match ? match[1].replace(/\.$/, '') : '<server_name>';
      return `Start ${serverName} — run as applmgr: admanagedsrvctl.sh start ${serverName}`;
    }
    if (t.includes('concurrent') || t.includes('adcmctl'))
      return `Start Concurrent Manager — run as applmgr: adcmctl.sh start apps/<apps_pwd>`;
    if (t.includes('workflow') || t.includes('mailer'))
      return `Restart Workflow Notification Mailer via OAM: System Administrator > Workflow > Notification Mailer > Activate`;
    if (t.includes('apache') || t.includes('ohs'))
      return `Restart Apache/OHS — run as applmgr: adapcctl.sh restart`;
    return `Check EBS services status — run as applmgr: admanagedsrvctl.sh status all`;
  }
  switch (topFinding.category) {
    case 'Storage':
      return `Check tablespace headroom: SELECT tablespace_name, ROUND(used_space/total_space*100,1)||'%' pct_used FROM dba_tablespace_usage_metrics ORDER BY used_space/total_space DESC FETCH FIRST 10 ROWS ONLY;`;
    case 'Performance':
      return `Check top waits: SELECT event, ROUND(time_waited/100,1) seconds, wait_class FROM v$system_event WHERE wait_class!='Idle' ORDER BY time_waited DESC FETCH FIRST 5 ROWS ONLY;`;
    case 'Backup':
      return `Check RMAN history: SELECT status, input_type, ROUND((SYSDATE-completion_time)*24,1)||'h ago' age FROM v$rman_backup_job_details ORDER BY start_time DESC FETCH FIRST 3 ROWS ONLY;`;
    case 'Indexes':
      return `Rebuild fragmented index: ALTER INDEX <index_name> REBUILD ONLINE; -- verify bloat first: SELECT index_name, pct_deleted FROM index_stats;`;
    case 'Memory':
      return `Check PGA usage: SELECT name, ROUND(value/1024/1024,1)||' MB' val FROM v$pgastat WHERE name IN ('total PGA allocated','total PGA used for auto workareas');`;
    case 'SQL':
      return `Check top SQL by elapsed: SELECT sql_id, ROUND(elapsed_time/NULLIF(executions,0)/1000,1)||'ms' avg, SUBSTR(sql_text,1,80) FROM v$sql WHERE executions>0 ORDER BY elapsed_time/NULLIF(executions,0) DESC FETCH FIRST 5 ROWS ONLY;`;
    default:
      return `Investigate ${topFinding.metric} — see the Health Overview tab for remediation SQL.`;
  }
}

// Build an inline rule-based EBS summary from metrics.
// Written atomically with status='completed' so the EBS card never shows a stuck spinner.
// The async generateExecutiveSummary() will override with AI-generated EBS_SUMMARY if it succeeds.
function buildInlineEbsSummary(metrics) {
  const items = buildEbsFindingsForSummary(metrics);
  if (items.length === 0) {
    return 'Oracle E-Business Suite detected. No critical application-layer issues found — Concurrent Manager, Workflow, and Mailer services are operating normally.';
  }
  return `Oracle E-Business Suite detected with ${items.length} finding(s): ${items.join('; ')}. Review the EBS sections below for operational details.`;
}

// Build an inline EBS action string from metrics.
function buildInlineEbsAction(metrics) {
  const items = buildEbsFindingsForSummary(metrics);
  if (items.length === 0) return null;
  // Return the first finding as the top action
  const ebsOps = metrics.ebs_operations || {};
  const cm = ebsOps.concurrent_managers || {};
  const wf = ebsOps.workflow || {};
  if (cm.cm01 && cm.cm01.status && cm.cm01.status.toLowerCase() !== 'normal') {
    return 'Check Concurrent Manager status — it is not running normally. Verify ICM is active and restart pending managers.';
  }
  if (wf.wf02 && wf.wf02.error_count > 0) {
    return `Investigate ${wf.wf02.error_count} Workflow errors — check WF_NOTIFICATIONS for stuck items and retry or skip failed activities.`;
  }
  if (wf.wf03 && wf.wf03.error_count > 0) {
    return `Workflow Mailer has ${wf.wf03.error_count} errors — verify mailer configuration and check notification processing queue.`;
  }
  return 'Review the EBS Operations tab for detailed application-layer findings.';
}

// Build inline rule-based recommendations from metrics. Written atomically with completion
// so the frontend always has structured recommendations. The async
// generateStructuredRecommendations() will override with richer GPT-enhanced versions.
function buildInlineRecommendations(metrics, scores, findings) {
  const recs = [];
  let recIdx = 1;
  const recId = () => `rec_${String(recIdx++).padStart(3, '0')}`;

  // Tablespace recommendations from actual data
  (metrics.tablespaces || []).filter(t => t.pct_used > 90).forEach(t => {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `${t.name} Tablespace ${t.pct_used}% Full — ${t.used_gb} GB / ${t.total_gb} GB`,
      evidence: `${t.name}: ${t.pct_used}% used (${t.used_gb} GB of ${t.total_gb} GB). Autoextend: ${t.autoextend ? 'ON' : 'OFF'}. At this level, write operations may halt during peak load.`,
      fix_sql: t.autoextend
        ? `-- Check current datafile sizes\nSELECT file_name, bytes/1024/1024/1024 size_gb, autoextensible, maxbytes/1024/1024/1024 max_gb\nFROM dba_data_files WHERE tablespace_name = '${t.name}';`
        : `ALTER TABLESPACE ${t.name} ADD DATAFILE SIZE 50G AUTOEXTEND ON NEXT 10G MAXSIZE UNLIMITED;`,
      diagnostic_sql: null, check_id: 'tablespace', check_tab: 'Storage'
    });
  });

  // Wait event recommendations from actual data
  (metrics.wait_events || []).filter(w => w.pct_db_time > 10).forEach(w => {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `${w.event}: ${w.pct_db_time}% DB time — ${(w.total_waits || 0).toLocaleString()} waits`,
      evidence: `${w.event} [${w.wait_class}]: ${w.pct_db_time}% of DB time, ${(w.total_waits || 0).toLocaleString()} total waits, avg ${w.avg_wait_ms}ms. Threshold: >10% DB time = critical.`,
      fix_sql: null,
      diagnostic_sql: `SELECT sid, serial#, username, sql_id, seconds_in_wait\nFROM v$session WHERE event = '${w.event}' AND wait_class <> 'Idle'\nORDER BY seconds_in_wait DESC FETCH FIRST 10 ROWS ONLY;`,
      check_id: 'wait_events', check_tab: 'Performance'
    });
  });

  // Slow SQL recommendations from actual data
  (metrics.top_sql || []).filter(s => s.elapsed_per_exec_ms > 5).slice(0, 3).forEach(s => {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `SQL_ID ${s.sql_id} — ${s.elapsed_per_exec_ms}ms/exec, ${(s.buffer_gets_per_exec || 0).toLocaleString()} gets/exec`,
      evidence: `SQL_ID ${s.sql_id}: ${s.elapsed_per_exec_ms}ms avg elapsed per execution, ${(s.buffer_gets_per_exec || 0).toLocaleString()} buffer gets/exec, ${(s.executions || 0).toLocaleString()} executions. Issue: ${s.issue || 'high elapsed time'}.`,
      fix_sql: null,
      diagnostic_sql: `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('${s.sql_id}', NULL, 'ALLSTATS LAST +PEEKED_BINDS'));`,
      check_id: 'sql', check_tab: 'SQL'
    });
  });

  // Index fragmentation from actual data
  (metrics.index_analysis || []).filter(i => i.pct_deleted > 50).forEach(i => {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `${i.index_name} — ${i.pct_deleted}% Fragmented, ${i.size_mb} MB`,
      evidence: `Index ${i.index_name} on ${i.table_name}: ${i.pct_deleted}% deleted blocks, size ${i.size_mb} MB. Fragmentation >50% degrades query performance.`,
      fix_sql: `ALTER INDEX ${i.owner ? i.owner + '.' : ''}${i.index_name} REBUILD ONLINE PARALLEL 4;`,
      diagnostic_sql: null, check_id: 'indexes', check_tab: 'Indexes'
    });
  });

  // Backup recommendations from actual data
  const backup = metrics.backup_stats || {};
  if (backup.rman_backup && backup.rman_backup.full_backup_hours_ago > 24) {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `RMAN Backup ${Math.round(backup.rman_backup.full_backup_hours_ago)}h Overdue`,
      evidence: `Last full RMAN backup: ${backup.rman_backup.full_backup_hours_ago}h ago. Standard RPO: 24h. Recovery point objective breached.`,
      fix_sql: `-- Run immediate RMAN backup\n-- RMAN> BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG DELETE INPUT;`,
      diagnostic_sql: null, check_id: 'backup', check_tab: 'Backup & Recovery'
    });
  }

  // Memory recommendations from actual data
  const sga = metrics.sga_stats || {};
  if (sga.buffer_cache_hit_ratio != null && sga.buffer_cache_hit_ratio < 90) {
    recs.push({
      id: recId(), severity: 'critical', confidence: 'high',
      title: `Buffer Cache Hit Ratio ${sga.buffer_cache_hit_ratio}% — Below 90% Threshold`,
      evidence: `Buffer cache hit ratio: ${sga.buffer_cache_hit_ratio}%. Target: >95%. Low hit ratio means excessive physical I/O.`,
      fix_sql: `ALTER SYSTEM SET DB_CACHE_SIZE = 4G SCOPE=BOTH;\n-- Or increase SGA_TARGET\nALTER SYSTEM SET SGA_TARGET = 8G SCOPE=BOTH;`,
      diagnostic_sql: null, check_id: 'memory', check_tab: 'Config & Sizing'
    });
  }

  return recs.slice(0, 12);
}

// ============================================================
// Structured Recommendations Generator
// Produces per-recommendation objects with confidence badges
// and evidence trails for the DBA-facing trust layer.
//
// Confidence levels:
//   high   — hard metric breached a defined threshold (e.g. UNDO 94% full, V$UNDOSTAT-backed)
//   medium — pattern / heuristic-based (e.g. index fragmentation signal, wait class pattern)
//   low    — correlational / needs DBA validation (e.g. PGA undersized inference)
//
// Output persisted to health_checks.ai_recommendations (JSONB array).
// Each element: { id, title, severity, confidence, evidence, fix_sql, check_id, check_tab }
// ============================================================

async function generateStructuredRecommendations(healthCheckId, metrics, scores, aiAnalysisText) {
  const startMs = Date.now();
  try {
    // Build per-category evidence snapshots from collected metrics.
    // These are the raw numbers that back any recommendation — passed verbatim so
    // GPT echoes them in the evidence fields rather than inventing backing data.
    const evidenceContext = buildEvidenceContext(metrics, scores);
    if (!evidenceContext.trim()) {
      console.log(`[structured-recs] report=${healthCheckId} skipped=no_evidence`);
      return;
    }

    const systemPrompt = `You are TuneVault, an expert Oracle DBA AI. You extract structured recommendations from an Oracle health check.

TASK: Parse the provided evidence data and produce a JSON array of recommendation objects.

EVERY recommendation MUST answer these three questions in order:
1. WHAT METRIC TRIGGERED THIS AND WHAT WAS THE VALUE?
   Put this in the "evidence" field. Include the exact number, threshold breached, and projected impact if applicable.
   Examples:
   - "USERS tablespace 92.5% full, 4.2 GB free of 57.5 GB total. Autoextend is OFF. At current 180 MB/day growth rate, full in ~23 days."
   - "db file sequential read [User I/O]: 18.4% of DB time, 2,847,392 waits, avg 14.3ms. Threshold: >10% DB time = critical."
   - "SQL_ID 8zg4v1d3f7q9r: 847ms/exec, 124,832 buffer gets/exec, 1,203 executions. Hash join without index on ORDERS.CUSTOMER_ID."
   Never say "as indicated by the analysis" — cite the actual numbers from the data.

2. WHAT IS THE ROOT CAUSE?
   Include this at the end of the evidence field, 1 sentence. Identify the specific misconfiguration, missing object, or design issue.
   Examples: "Autoextend disabled on USERS01.DBF; no additional datafiles configured."
             "Missing index on FK column ORDERS.CUSTOMER_ID forces full table scan on every join."
             "UNDO_RETENTION=900s but V$UNDOSTAT shows queries running up to 4,847s — ORA-01555 risk."

3. EXACT SQL OR SHELL COMMAND TO REMEDIATE:
   - For issues with a safe direct fix: put the exact runnable SQL/DDL/shell in "fix_sql".
     Parameterize with REAL values from the evidence (real tablespace name, real SQL_ID, real datafile path if available).
     Examples:
     - "ALTER TABLESPACE USERS ADD DATAFILE SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE 50G;"
     - "CREATE INDEX ORDERS_CUSTOMER_IDX ON ORDERS(CUSTOMER_ID) PARALLEL 4; ALTER INDEX ORDERS_CUSTOMER_IDX NOPARALLEL;"
     - "ALTER SYSTEM SET UNDO_RETENTION=7200 SCOPE=BOTH;"
   - For issues with NO safe one-command fix (long-running queries, complex waits, session analysis):
     put the exact DIAGNOSTIC SQL the DBA should run NEXT in "diagnostic_sql".
     Use real SQL_IDs, real wait event names from the evidence. No generic advice.
     Examples:
     - "SELECT sql_id, sql_text, elapsed_time, cpu_time, buffer_gets FROM v\$sql WHERE sql_id = '8zg4v1d3f7q9r';"
     - "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('8zg4v1d3f7q9r', NULL, 'ALLSTATS LAST +PEEKED_BINDS'));"
     - "SELECT event, time_waited, state FROM gv\$session_wait WHERE event = 'db file sequential read' ORDER BY time_waited DESC;"
   - NEVER output abstract advice like "check the execution plan", "review tablespace growth", "investigate wait events".
     The DBA already knows to do that. Give them the actual command.

FORBIDDEN in fix_sql or diagnostic_sql:
- "Review [something]" — actionless
- "Monitor [something]" — actionless
- "Consider [something]" — too vague
- "Check [something]" — too vague
- Abstract descriptions without actual SQL/commands

CONFIDENCE RULES (assign exactly one per recommendation):
- "high": recommendation is backed by a HARD METRIC that crossed a defined threshold
  Examples: tablespace >90% full, RMAN backup >48h old, V$UNDOSTAT shows peak_query > UNDO_RETENTION,
            wait event >10% DB time, resource limit >90% of max
- "medium": recommendation is based on a PATTERN or HEURISTIC that strongly suggests an issue
  Examples: index >30% deleted blocks, SQL >5ms/exec with high buffer gets, PGA multi-pass >1%,
            wait event 5-10% DB time, tablespace 80-90% full
- "low": recommendation is CORRELATIONAL — useful signal but needs DBA validation before acting
  Examples: SGA sizing inference from cache ratios, parameter tuning suggestions, preventive actions

OUTPUT FORMAT: Return a valid JSON array only. No prose before or after.
[
  {
    "id": "rec_001",
    "title": "Short DBA-facing title with key metric inline (max 80 chars). Example: 'USERS Tablespace 92.5% Full — 23 Days to Fill'",
    "severity": "critical" | "warning" | "info",
    "confidence": "high" | "medium" | "low",
    "evidence": "Exact metric value that triggered this + root cause in one sentence. Never fabricate numbers.",
    "fix_sql": "Exact runnable SQL/DDL/shell for issues with a safe direct fix, parameterized with real values. null if diagnostic_sql is provided instead.",
    "diagnostic_sql": "Exact diagnostic SQL for issues where direct fix requires investigation first. null if fix_sql is provided.",
    "check_id": "short key for the check category: tablespace|wait_events|sql|indexes|backup|undo|memory|sessions|config",
    "check_tab": "Tab name in the dashboard where this check lives: Summary|Tablespaces|Wait Events|SQL|Sessions|Memory|Backups|Parameters"
  }
]

Rules:
- Max 12 recommendations. Order: critical first, then warning, then info.
- Every recommendation needs EITHER fix_sql OR diagnostic_sql (not both, not neither).
- Only include recommendations that have actual evidence in the provided data.
- Title must include the key metric value: "USERS Tablespace 92.5% Full" not "Tablespace almost full"
- SQL must use real object names and values from the evidence data, not placeholders like <tablespace_name>.`;

    const userContent = `Oracle health check evidence data:

${evidenceContext}

AI analysis text (for extracting fix_sql commands — copy verbatim, do not modify):
${(aiAnalysisText || '').substring(0, 3000)}

Produce the JSON array of structured recommendations.`;

    // 55s timeout — fire-and-forget function, must not hang indefinitely
    const recsRaceTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Structured recommendations generation timeout (55s)')), 55000)
    );
    const completion = await Promise.race([openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }), recsRaceTimeout]);

    const raw = completion.choices[0]?.message?.content || '';
    const latencyMs = Date.now() - startMs;

    // Parse JSON response — strip any markdown fencing if GPT wrapped it
    let recommendations;
    try {
      const jsonText = raw.replace(/^```json\n?|^```\n?|\n?```$/gm, '').trim();
      recommendations = JSON.parse(jsonText);
      if (!Array.isArray(recommendations)) throw new Error('not an array');
    } catch (parseErr) {
      console.error(`[structured-recs] report=${healthCheckId} parse_error=${parseErr.message} raw_preview=${raw.substring(0, 200)}`);
      return;
    }

    // Validate and sanitize each recommendation
    const valid = recommendations.filter(r =>
      r && typeof r === 'object' &&
      typeof r.title === 'string' &&
      ['critical', 'warning', 'info'].includes(r.severity) &&
      ['high', 'medium', 'low'].includes(r.confidence) &&
      typeof r.evidence === 'string'
    ).slice(0, 12).map((r, i) => ({
      id: `rec_${String(i + 1).padStart(3, '0')}`,
      title: String(r.title).substring(0, 120),
      severity: r.severity,
      confidence: r.confidence,
      evidence: String(r.evidence).substring(0, 600),
      fix_sql: r.fix_sql ? String(r.fix_sql).substring(0, 2000) : null,
      diagnostic_sql: r.diagnostic_sql ? String(r.diagnostic_sql).substring(0, 2000) : null,
      check_id: r.check_id || 'general',
      check_tab: r.check_tab || 'Summary'
    }));

    if (valid.length === 0) {
      console.log(`[structured-recs] report=${healthCheckId} skipped=no_valid_recs`);
      return;
    }

    await pool.query(
      `UPDATE health_checks SET ai_recommendations = $1 WHERE id = $2`,
      [JSON.stringify(valid), healthCheckId]
    );

    const tokenUsage = completion.usage || {};
    console.log(`[structured-recs] report=${healthCheckId} recs=${valid.length} latency_ms=${latencyMs} tokens=${tokenUsage.total_tokens || 0} high=${valid.filter(r=>r.confidence==='high').length} medium=${valid.filter(r=>r.confidence==='medium').length} low=${valid.filter(r=>r.confidence==='low').length}`);
  } catch (err) {
    // Non-blocking — main report is already complete.
    console.error(`[structured-recs] report=${healthCheckId} error=${err.message}`);
  }
}

// Build a structured evidence snapshot from collected metrics.
// Used as grounding data for generateStructuredRecommendations.
// Returns compact multi-line string — each section maps to a check category.
function buildEvidenceContext(metrics, scores) {
  const lines = [];

  // Health scores
  lines.push(`## Health Scores`);
  lines.push(`Overall: ${scores.overall ?? 'N/A'}/100, Tablespace: ${scores.tablespace ?? 'N/A'}/100, Wait Events: ${scores.wait_events ?? 'N/A'}/100, SQL: ${scores.sql_performance ?? 'N/A'}/100, Indexes: ${scores.index_health ?? 'N/A'}/100, Memory: ${scores.memory ?? 'N/A'}/100`);

  // Tablespaces
  if (metrics.tablespaces && metrics.tablespaces.length > 0) {
    lines.push(`\n## Tablespace Usage`);
    metrics.tablespaces.forEach(t => {
      lines.push(`- ${t.name}: ${t.pct_used}% used (${t.used_gb}GB/${t.total_gb}GB), autoextend=${t.autoextend}`);
    });
  }

  // Wait events
  if (metrics.wait_events && metrics.wait_events.length > 0) {
    const topWaits = metrics.wait_events.filter(w => w.pct_db_time > 1).slice(0, 5);
    if (topWaits.length > 0) {
      lines.push(`\n## Top Wait Events`);
      topWaits.forEach(w => {
        lines.push(`- ${w.event} [${w.wait_class}]: ${w.pct_db_time}% DB time, ${w.total_waits} waits, avg ${w.avg_wait_ms}ms`);
      });
    }
  }

  // Top SQL
  if (metrics.top_sql && metrics.top_sql.length > 0) {
    const slowSql = metrics.top_sql.filter(s => s.elapsed_per_exec_ms > 2).slice(0, 5);
    if (slowSql.length > 0) {
      lines.push(`\n## Slow SQL`);
      slowSql.forEach(s => {
        lines.push(`- SQL_ID ${s.sql_id}: ${s.elapsed_per_exec_ms}ms/exec, ${s.buffer_gets_per_exec} gets/exec, ${s.executions} execs — ${s.issue}`);
      });
    }
  }

  // Index analysis
  if (metrics.index_analysis && metrics.index_analysis.length > 0) {
    const fragmented = metrics.index_analysis.filter(i => i.pct_deleted > 10).slice(0, 5);
    if (fragmented.length > 0) {
      lines.push(`\n## Index Fragmentation`);
      fragmented.forEach(i => {
        lines.push(`- ${i.index_name} on ${i.table_name}: ${i.pct_deleted}% deleted blocks, blevel=${i.blevel}, ${i.size_mb}MB`);
      });
    }
  }

  // Undo stats
  if (metrics.undo_stats && metrics.undo_stats.current) {
    const u = metrics.undo_stats.current;
    const hist = metrics.undo_stats.historical || {};
    lines.push(`\n## Undo Tablespace`);
    lines.push(`- ${u.tablespace_name}: ${u.pct_used}% used (${u.used_gb}GB/${u.total_gb}GB), UNDO_RETENTION=${u.tuned_undo_retention_s}s, longest_query=${u.max_query_length_s}s`);
    if (hist.peak_query_length_s) {
      lines.push(`- Historical peak query: ${hist.peak_query_length_s}s (${hist.peak_query_length_s > u.tuned_undo_retention_s ? 'EXCEEDS retention — ORA-01555 risk' : 'within retention'})`);
    }
  }

  // Backup stats
  if (metrics.backup_stats) {
    const b = metrics.backup_stats;
    const rman = b.rman_backup || {};
    lines.push(`\n## Backup & Recovery`);
    lines.push(`- Status: ${b.overall_status || 'unknown'}, Last full backup: ${rman.last_full_backup ? rman.full_backup_hours_ago + 'h ago' : 'none found'}`);
    if (rman.fra_pct_used != null) lines.push(`- FRA usage: ${rman.fra_pct_used}%`);
    if (rman.archive_mode) lines.push(`- Archive mode: ${rman.archive_mode}`);
  }

  // SGA/PGA stats
  if (metrics.sga_pga_stats) {
    const m = metrics.sga_pga_stats;
    lines.push(`\n## Memory`);
    if (m.buffer_cache_hit_ratio != null) lines.push(`- Buffer cache hit ratio: ${m.buffer_cache_hit_ratio}%`);
    if (m.library_cache_hit_ratio != null) lines.push(`- Library cache hit ratio: ${m.library_cache_hit_ratio}%`);
    if (m.hard_parses_per_sec != null) lines.push(`- Hard parses/sec: ${m.hard_parses_per_sec}`);
    if (m.pga_allocated_gb != null) lines.push(`- PGA allocated: ${m.pga_allocated_gb}GB`);
    if (m.pga_multipass_pct != null) lines.push(`- PGA multi-pass executions: ${m.pga_multipass_pct}%`);
  }

  // Resource limits
  if (metrics.resource_limits && metrics.resource_limits.current && metrics.resource_limits.current.length > 0) {
    const critical = metrics.resource_limits.current.filter(r => r.status === 'critical' || r.pct_max_used > 70);
    if (critical.length > 0) {
      lines.push(`\n## Resource Limits`);
      critical.forEach(r => {
        lines.push(`- ${r.resource}: ${r.current_utilization}/${r.max_utilization} (${r.pct_max_used}% of limit) — ${r.status}`);
      });
    }
  }

  return lines.join('\n');
}

function buildAnalysisPrompt(metrics, scores) {
  // ── EBS app-tier: separate prompt focused on middleware + EBS components ──
  if (metrics.server_type === 'apps') {
    const findings  = metrics.findings  || [];
    const checksOk  = metrics.checks_ok || [];
    const critItems = findings.filter(f => f.severity === 'critical');
    const warnItems = findings.filter(f => f.severity === 'warning');

    const findingsText = findings.length > 0
      ? findings.map(f => `- [${f.severity.toUpperCase()}] ${f.title}: ${f.details}`).join('\n')
      : '- No findings (all checks passed)';
    const okText = checksOk.length > 0
      ? checksOk.map(c => `- [OK] ${c.title}: ${c.details}`).join('\n')
      : '- No passing checks recorded';

    return `You are a senior Oracle E-Business Suite administrator. Analyze this EBS application-tier health check and provide a concise, actionable report.

## EBS Application Server Health — Score ${scores.overall}/100
- Critical findings: ${critItems.length}
- Warnings: ${warnItems.length}
- Checks passed: ${checksOk.length}

## All Findings
${findingsText}

## Passing Checks
${okText}

FORMAT YOUR RESPONSE EXACTLY AS FOLLOWS:

## Health Overview
Two or three sentences summarising the overall EBS app-tier health. Reference the score and the most impactful finding.

## EBS Component Status
Brief status of WebLogic managed servers, OPMN, Concurrent Manager, Workflow Mailer, and Node Manager based on the findings above. Flag anything not running.

## DB Health from App Tier
Summarise the invalid objects and tablespace usage findings. Recommend adop phase=cleanup if invalid objects are elevated post-patch.

## System Resources
Comment on disk, memory, CPU load, and IO wait findings and their impact on EBS middleware performance.

## Recommended Actions
Numbered list (most urgent first). Each action: one sentence + the exact EBS admin script command (as applmgr). Use admanagedsrvctl.sh for managed servers, adapcctl.sh for Apache, adcmctl.sh for CM, adadminsrvctl.sh for Admin Server. For invalid objects: run utlrp.sql on the DB server, not the app server. Never use stopall.sh or startall.sh.

## Executive Summary
EXACTLY one sentence. No more. Start with: "Overall, this EBS application server..."`;
  }

  // ── DB-tier prompt (original) ──────────────────────────────────────────────
  const tsSection = (metrics.tablespaces || []).length > 0
    ? metrics.tablespaces.map(t => `- ${t.name}: ${t.pct_used}% (${t.used_gb}GB/${t.total_gb}GB) autoextend=${t.autoextend}`).join('\n')
    : '- No tablespace data collected (insufficient privileges)';

  const waitSection = (metrics.wait_events || []).filter(w => w.pct_db_time > 0).length > 0
    ? metrics.wait_events.filter(w => w.pct_db_time > 0).map(w => `- ${w.event} [${w.wait_class}]: ${w.pct_db_time}% DB time, ${w.total_waits.toLocaleString()} waits, avg ${w.avg_wait_ms}ms`).join('\n')
    : '- No wait event data collected';

  const sqlSection = (metrics.top_sql || []).length > 0
    ? metrics.top_sql.map(s => `- SQL_ID: ${s.sql_id} — ${s.elapsed_per_exec_ms}ms/exec, ${s.buffer_gets_per_exec} gets/exec, ${s.executions.toLocaleString()} execs\n  Issue: ${s.issue}\n  SQL: ${(s.sql_text || '').substring(0, 200)}`).join('\n\n')
    : '- No SQL data collected';

  const idxSection = (metrics.index_analysis || []).length > 0
    ? metrics.index_analysis.map(i => `- ${i.index_name} on ${i.table_name}: ${i.size_mb}MB, ${i.pct_deleted}% deleted blocks, blevel=${i.blevel} — ${i.status}`).join('\n')
    : '- No index data collected';

  // Undo section
  const undoSection = metrics.undo_stats ? (() => {
    const u = metrics.undo_stats;
    const lines = [`- ${u.current.tablespace_name}: ${u.current.pct_used}% used (${u.current.used_gb?.toFixed ? u.current.used_gb.toFixed(1) : u.current.used_gb}GB/${u.current.total_gb}GB), retention=${u.current.tuned_undo_retention_s}s, longest query=${u.current.max_query_length_s}s`];
    if (u.historical && u.historical.peak_pct_used != null) {
      lines.push(`- Historical peak: ${u.historical.peak_pct_used}% at ${u.historical.peak_time || 'unknown'} (30-day lookback)`);
      if (u.historical.peak_query_length_s && u.current.tuned_undo_retention_s && u.historical.peak_query_length_s > u.current.tuned_undo_retention_s) {
        lines.push(`- ⚠️ RISK: Longest query (${u.historical.peak_query_length_s}s) exceeds UNDO_RETENTION (${u.current.tuned_undo_retention_s}s) — ORA-01555 risk`);
      }
    }
    return lines.join('\n');
  })() : '- No undo data';

  // Temp section
  const tempSection = metrics.temp_stats ? (() => {
    const t = metrics.temp_stats;
    const lines = [`- ${t.current.tablespace_name}: ${t.current.pct_used}% used (${t.current.used_gb?.toFixed ? t.current.used_gb.toFixed(1) : t.current.used_gb}GB/${t.current.total_gb}GB free)`];
    if (t.current.top_sessions && t.current.top_sessions.length > 0) {
      lines.push(`- Top temp user: ${t.current.top_sessions[0].username} using ${t.current.top_sessions[0].temp_mb}MB`);
    }
    if (t.historical && t.historical.peak_gb != null) {
      lines.push(`- Historical peak: ${t.historical.peak_gb}GB (${t.historical.peak_pct}%) at ${t.historical.peak_time || 'unknown'}`);
    }
    return lines.join('\n');
  })() : '- No temp data';

  // Alert log section
  const alertSection = metrics.alert_log ? (() => {
    const a = metrics.alert_log;
    const lines = [`- Summary (last 24h): ${a.summary.total} entries — ${a.summary.critical} critical, ${a.summary.warning} warning, ${a.summary.noise} noise`];
    (a.entries || []).filter(e => e.severity === 'critical' || e.severity === 'warning').slice(0, 5).forEach(e => {
      lines.push(`- [${e.severity.toUpperCase()}] ${e.ts}: ${e.message.substring(0, 150)}`);
    });
    return lines.join('\n');
  })() : '- No alert log data';

  // Resource limits section
  const resourceSection = metrics.resource_limits ? (() => {
    const r = metrics.resource_limits;
    return (r.current || []).map(rl =>
      `- ${rl.resource}: ${rl.current_utilization} current, ${rl.max_utilization} peak, limit=${rl.limit_display} (${rl.pct_max_used != null ? rl.pct_max_used + '% of limit' : 'UNLIMITED'}) [${rl.status}]`
    ).join('\n') || '- No resource limit data';
  })() : '- No resource limit data';

  // Backup & Recovery section
  const backupSection = metrics.backup_stats ? (() => {
    const b = metrics.backup_stats;
    const lines = [`- Overall backup status: ${b.overall_status?.toUpperCase() || 'UNKNOWN'}`];

    if (b.rman_backup) {
      const r = b.rman_backup;
      if (!r.rman_available) {
        lines.push('- RMAN: Not configured or no backup jobs found');
      } else {
        if (r.last_full_backup) {
          lines.push(`- Last FULL backup: ${r.full_backup_hours_ago}h ago (${r.last_full_backup.size_gb}GB, ${r.last_full_backup.status}) [${r.rman_backup?.status?.toUpperCase() || r.status?.toUpperCase() || ''}]`);
        } else {
          lines.push('- Last FULL backup: NONE FOUND — critical data loss risk');
        }
        if (r.last_incremental_backup) {
          lines.push(`- Last INCREMENTAL: ${r.last_incremental_backup.hours_ago}h ago (${r.last_incremental_backup.size_gb}GB, ${r.last_incremental_backup.status})`);
        }
        if (r.last_archivelog_backup) {
          lines.push(`- Last ARCHIVELOG backup: ${r.last_archivelog_backup.hours_ago}h ago (${r.last_archivelog_backup.status})`);
        }
      }
    }

    if (b.fra_usage) {
      const f = b.fra_usage;
      if (!f.fra_configured) {
        lines.push('- FRA: Not configured');
      } else {
        lines.push(`- FRA: ${f.pct_used}% used (${f.used_gb}GB/${f.limit_gb}GB), ${f.pct_reclaimable}% reclaimable, ${f.hours_until_full ? f.hours_until_full + 'h until full' : 'fill rate unknown'} [${f.status?.toUpperCase() || ''}]`);
        lines.push(`- Archivelog generation: ${f.archivelogs_24h_gb}GB/day`);
      }
    }

    if (b.archivelog_rate) {
      const a = b.archivelog_rate;
      lines.push(`- Archive mode: ${a.log_mode}, ${a.switches_per_hour}/hr log switches (${a.switches_24h} in 24h) [${a.status?.toUpperCase() || ''}]`);
      if (a.log_groups && a.log_groups.length > 0) {
        lines.push(`- Redo log groups: ${a.log_groups.length}, size: ${a.log_groups[0]?.size_mb || 0}MB each`);
      }
    }

    if (b.backup_validation) {
      const v = b.backup_validation;
      if (v.total_corruptions > 0) {
        lines.push(`- ⚠️ CORRUPTION DETECTED: ${v.backup_corruptions} backup corruptions (${v.backup_corrupt_blocks} blocks), ${v.copy_corruptions} copy corruptions`);
      } else {
        lines.push(`- Corruption checks: CLEAN (0 backup/copy corruptions found) [${v.status?.toUpperCase() || ''}]`);
      }
      if (v.last_3_backups_failed) {
        lines.push('- ⚠️ Last 3 backup jobs ALL FAILED — immediate investigation required');
      }
      const failedOps = (v.recent_operations || []).filter(op => op.status === 'FAILED');
      if (failedOps.length > 0) {
        lines.push(`- Recent failures: ${failedOps.map(op => op.operation + ' at ' + op.start_time + ' — ' + (op.output || '').substring(0, 100)).join('; ')}`);
      }
    }

    return lines.join('\n');
  })() : '- No backup data collected';

  // SGA/PGA history section
  const sgaPgaHistSection = metrics.sga_pga_history ? (() => {
    const h = metrics.sga_pga_history;
    const lines = [];
    if (h.current) {
      lines.push(`- SGA Target: ${h.current.sga_target_gb}GB, PGA Target: ${h.current.pga_target_gb}GB, Memory Target: ${h.current.memory_target_gb || 0}GB`);
    }
    if (h.pga_history && h.pga_history.peak_allocated_gb) {
      lines.push(`- PGA peak (30d): ${h.pga_history.peak_allocated_gb}GB at ${h.pga_history.peak_time || 'unknown'} (target=${h.current.pga_target_gb}GB)`);
    }
    if (h.resize_ops && h.resize_ops.length > 0) {
      lines.push(`- ASMM resize ops (recent): ${h.resize_ops.slice(0, 3).map(op => `${op.component} ${op.oper_type} ${op.from_gb}→${op.to_gb}GB`).join(', ')}`);
    }
    return lines.join('\n') || '- No SGA/PGA history';
  })() : '- No SGA/PGA history';

  // Null-safe access for sections that may be missing on limited-privilege connections
  const inst = metrics.instance || {};
  const sga = metrics.sga_stats || {};
  const pga = metrics.pga_stats || {};
  const os = metrics.os_stats || {};

  return `Analyze this Oracle database health data and provide a detailed health report with prioritized, actionable recommendations.

## Database Instance
- Name: ${inst.db_name || 'Unknown'} (${inst.version || 'Unknown'})
- Host: ${inst.host_name || 'Unknown'}
- CPUs: ${inst.cpus || 'N/A'}, SGA: ${inst.sga_target_gb || 'N/A'}GB, PGA: ${inst.pga_aggregate_target_gb || 'N/A'}GB
- Uptime: ${inst.uptime_days || 'N/A'} days
- AWR Available: ${metrics.awr_available ? 'Yes (Diagnostics Pack licensed)' : 'No (current values only)'}
- Installed Applications: ${(metrics.detected_apps && metrics.detected_apps.length > 0) ? metrics.detected_apps.map(a => a.label).join(', ') : 'None detected'}

## Health Scores (0-100)
- Overall: ${scores.overall}
- Tablespace: ${scores.tablespace}
- Wait Events: ${scores.wait_events}
- SQL Performance: ${scores.sql_performance}
- Index Health: ${scores.index_health}
- Memory: ${scores.memory}

## Tablespace Usage
${tsSection}

## Undo Tablespace
${undoSection}

## Temp Tablespace
${tempSection}

## Alert Log (Last 24h)
${alertSection}

## Backup & Recovery
${backupSection}

## Top Wait Events
${waitSection}

## Top SQL by Elapsed Time
${sqlSection}

## Index Analysis
${idxSection}

## SGA Statistics
- Buffer Cache Hit Ratio: ${sga.buffer_cache_hit_ratio ?? 'N/A'}%
- Library Cache Hit Ratio: ${sga.library_cache_hit_ratio ?? 'N/A'}%
- Shared Pool Free: ${sga.shared_pool_free_pct ?? 'N/A'}%
- Hard Parses/sec: ${sga.hard_parses_per_sec ?? 'N/A'}

## PGA Statistics
- PGA Allocated: ${pga.pga_allocated_gb ?? 'N/A'}GB of ${pga.pga_target_gb ?? 'N/A'}GB target
- Optimal: ${pga.optimal_executions_pct ?? 'N/A'}%, One-pass: ${pga.onepass_executions_pct ?? 'N/A'}%, Multi-pass: ${pga.multipass_executions_pct ?? 'N/A'}%

## SGA/PGA Historical Sizing
${sgaPgaHistSection}

## Resource Limits
${resourceSection}

## OS/Host Stats
- CPU Utilization: avg ${os.avg_cpu_utilization_pct ?? 'N/A'}%, max ${os.max_cpu_utilization_pct ?? 'N/A'}%
- I/O Wait: ${os.avg_io_wait_pct ?? 'N/A'}%
- Avg Disk Read: ${os.avg_disk_read_ms ?? 'N/A'}ms, Write: ${os.avg_disk_write_ms ?? 'N/A'}ms

FORMAT YOUR RESPONSE EXACTLY AS FOLLOWS (all sections required):

## Health Overview

Structured DBA-grade metrics breakdown. Use subsections for each category that has findings. Include specific values, thresholds, and status for each metric. Format:

### Storage
Tablespace utilization (name, % used, autoextend status). Flag any above 80%.

### Performance
Top wait events (name, % DB time, avg wait), slow SQL count and worst offender (SQL_ID, ms/exec). Buffer cache hit ratio.

### Memory
SGA/PGA sizing, buffer cache hit ratio, shared pool free %. Flag if below target.

### Backup & Recovery
Last full backup age, FRA usage %, archivelog rate. Flag if RPO exceeded.

### Security
Default password accounts, dangerous PUBLIC grants, DBA privilege count. Include only if issues found.

Omit any subsection where all metrics are healthy. This section is the detailed reference — the executive summary card above provides the business-level view.

## Critical Issues
List EVERY item with severity CRITICAL. Each item needs:
- What's wrong (one line)
- The exact fix command in a \`\`\`sql code block
- If no critical issues: write "No critical issues detected."

## Backup & Recovery Assessment
RMAN freshness, FRA capacity, archivelog rate, any corruption. Include specific RMAN commands in \`\`\`sql blocks if action is needed.

## Performance Recommendations
For EACH slow SQL (elapsed_per_exec_ms > 5ms): provide the SQL_ID, the problem, and ONE of:
- A CREATE INDEX statement with specific columns inferred from the SQL text
- An optimizer hint (e.g., \`/*+ INDEX(t idx_name) */\`)
- An ALTER SESSION SET parameter change
- At minimum, the diagnostic query: \`SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('sql_id', NULL, 'ALLSTATS LAST'));\`
NEVER write "check execution plan" or "consider adding an index" without the actual statement.

## Capacity Planning
Tablespace growth projections, memory sizing (exact ALTER SYSTEM SET commands with calculated GB values), resource limits approaching thresholds.

## Alert Log Action Items
Critical/warning entries that need follow-up — with the exact investigation command for each.

## Estimated Impact
Quantified: "Buffer cache hit ratio improves from X% to ~Y%", "SQL_ID abc elapsed drops from Xms to ~Yms".`;
}

// Rule-based fallback when LLM is unavailable — still produces concrete SQL, not generic advice
function generateFallbackAnalysis(metrics, scores) {
  const inst = metrics.instance || {};
  const sga = metrics.sga_stats || {};
  const pga = metrics.pga_stats || {};
  const lines = [];

  const criticalTs = (metrics.tablespaces || []).filter(t => t.pct_used > 90);
  const warnTs = (metrics.tablespaces || []).filter(t => t.pct_used > 80 && t.pct_used <= 90);
  const fragIdx = (metrics.index_analysis || []).filter(i => i.pct_deleted > 40);
  const slowSql = (metrics.top_sql || []).filter(s => s.elapsed_per_exec_ms > 5);
  const criticalWaits = (metrics.wait_events || []).filter(w => w.pct_db_time > 20);
  const highWaits = (metrics.wait_events || []).filter(w => w.pct_db_time > 10 && w.pct_db_time <= 20);
  // ── Health Overview — structured DBA-grade metrics breakdown by category ──
  lines.push('## Health Overview\n\n');

  // Storage subsection
  const hasStorageIssues = criticalTs.length > 0 || warnTs.length > 0;
  if (hasStorageIssues) {
    lines.push('### Storage\n\n');
    lines.push('| Tablespace | Used | Capacity | Status | Autoextend |\n');
    lines.push('|------------|------|----------|--------|------------|\n');
    criticalTs.forEach(t => {
      lines.push(`| ${t.name} | **${t.pct_used}%** | ${t.used_gb}GB / ${t.total_gb}GB | 🔴 CRITICAL | ${t.autoextend ? 'ON' : 'OFF'} |\n`);
    });
    warnTs.forEach(t => {
      lines.push(`| ${t.name} | **${t.pct_used}%** | ${t.used_gb}GB / ${t.total_gb}GB | ⚠️ WARNING | ${t.autoextend ? 'ON' : 'OFF'} |\n`);
    });
    lines.push('\n');
  }

  // Performance subsection
  const hasPerformanceIssues = criticalWaits.length > 0 || highWaits.length > 0 || slowSql.length > 0;
  if (hasPerformanceIssues) {
    lines.push('### Performance\n\n');
    if (criticalWaits.length > 0 || highWaits.length > 0) {
      lines.push('**Top Wait Events:**\n\n');
      [...criticalWaits, ...highWaits.slice(0, 2)].forEach(w => {
        lines.push(`- ${w.event} [${w.wait_class}]: **${w.pct_db_time}% DB time** — ${(w.total_waits || 0).toLocaleString()} waits, avg ${w.avg_wait_ms}ms\n`);
      });
      lines.push('\n');
    }
    if (slowSql.length > 0) {
      lines.push(`**Slow SQL:** ${slowSql.length} statement(s) above 5ms/exec threshold\n\n`);
      slowSql.slice(0, 3).forEach(s => {
        lines.push(`- SQL_ID **${s.sql_id}**: ${s.elapsed_per_exec_ms}ms/exec (${(s.executions || 0).toLocaleString()} execs) — ${s.issue || 'high elapsed time'}\n`);
      });
      lines.push('\n');
    }
    if (fragIdx.filter(i => i.pct_deleted > 40).length > 0) {
      lines.push('**Index Fragmentation:**\n\n');
      fragIdx.filter(i => i.pct_deleted > 40).forEach(i => {
        const severity = i.pct_deleted > 50 ? '🔴 CRITICAL' : '⚠️ WARNING';
        lines.push(`- ${i.index_name} on ${i.table_name}: **${i.pct_deleted}% deleted blocks** (${i.size_mb}MB) — ${severity}\n`);
      });
      lines.push('\n');
    }
  }

  // Memory subsection
  const hasMemoryIssues = (sga.buffer_cache_hit_ratio != null && sga.buffer_cache_hit_ratio < 95);
  if (hasMemoryIssues) {
    lines.push('### Memory\n\n');
    lines.push(`- Buffer cache hit ratio: **${sga.buffer_cache_hit_ratio}%** (target >95%)\n`);
    if (sga.library_cache_hit_ratio != null) lines.push(`- Library cache hit ratio: ${sga.library_cache_hit_ratio}%\n`);
    if (sga.shared_pool_free_pct != null) lines.push(`- Shared pool free: ${sga.shared_pool_free_pct}%\n`);
    if (pga.multipass_executions_pct != null && pga.multipass_executions_pct > 1) {
      lines.push(`- PGA multi-pass: **${pga.multipass_executions_pct}%** (should be <1%)\n`);
    }
    lines.push('\n');
  }

  // Backup subsection
  const backup = metrics.backup_stats || {};
  const hasBackupIssues = (backup.rman_backup && (!backup.rman_backup.rman_available || backup.rman_backup.full_backup_hours_ago > 24))
    || (backup.fra_usage && backup.fra_usage.pct_used > 80)
    || (backup.backup_validation && backup.backup_validation.total_corruptions > 0);
  if (hasBackupIssues) {
    lines.push('### Backup & Recovery\n\n');
    if (backup.rman_backup && !backup.rman_backup.rman_available) {
      lines.push('- RMAN: **Not configured** — critical data loss risk\n');
    } else if (backup.rman_backup && backup.rman_backup.full_backup_hours_ago > 24) {
      lines.push(`- Last full RMAN backup: **${backup.rman_backup.full_backup_hours_ago}h ago** (exceeds 24h RPO)\n`);
    }
    if (backup.fra_usage && backup.fra_usage.pct_used > 80) {
      lines.push(`- FRA usage: **${backup.fra_usage.pct_used}%** (${backup.fra_usage.used_gb}GB / ${backup.fra_usage.limit_gb}GB)\n`);
    }
    if (backup.backup_validation && backup.backup_validation.total_corruptions > 0) {
      lines.push(`- **${backup.backup_validation.total_corruptions} backup corruption(s)** detected\n`);
    }
    lines.push('\n');
  }

  if (!hasStorageIssues && !hasPerformanceIssues && !hasMemoryIssues && !hasBackupIssues) {
    lines.push('All monitored dimensions are within healthy thresholds.\n\n');
  }

  // Critical Issues — must always be populated from actual findings.
  // Includes storage, indexes, backup, memory, wait events, and slow SQL.
  lines.push('\n\n## Critical Issues\n\n');
  let hasCritical = false;

  criticalTs.forEach(t => {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: Tablespace ${t.name} at ${t.pct_used}%\n\n`);
    lines.push(`Used ${t.used_gb}GB of ${t.total_gb}GB. Autoextend: ${t.autoextend ? 'ON' : 'OFF'}.\n\n`);
    lines.push('```sql\n');
    if (!t.autoextend) {
      lines.push(`ALTER TABLESPACE ${t.name} ADD DATAFILE SIZE 50G AUTOEXTEND ON NEXT 10G MAXSIZE 100G;\n`);
    } else {
      lines.push(`-- Check current datafile sizes and growth\nSELECT file_name, bytes/1024/1024/1024 AS gb, autoextensible, maxbytes/1024/1024/1024 AS max_gb\nFROM dba_data_files WHERE tablespace_name = '${t.name}';\n`);
    }
    lines.push('```\n\n');
  });

  fragIdx.filter(i => i.pct_deleted > 50).forEach(i => {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: Index ${i.index_name} — ${i.pct_deleted}% fragmented\n\n`);
    lines.push(`Size: ${i.size_mb}MB on table ${i.table_name}.\n\n`);
    lines.push('```sql\n');
    lines.push(`ALTER INDEX ${i.owner}.${i.index_name} REBUILD ONLINE PARALLEL 4;\n`);
    lines.push('```\n\n');
  });

  // Wait events consuming >20% DB time — these are critical performance blockers
  criticalWaits.forEach(w => {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: Wait Event "${w.event}" — ${w.pct_db_time}% of DB Time\n\n`);
    lines.push(`Wait class: ${w.wait_class}. ${(w.total_waits || 0).toLocaleString()} total waits, avg ${w.avg_wait_ms}ms each.\n\n`);
    lines.push('```sql\n');
    if (w.wait_class === 'User I/O') {
      lines.push(`-- Identify I/O-heavy SQL causing "${w.event}"\nSELECT sql_id, disk_reads, buffer_gets, elapsed_time/1e6 AS elapsed_s\nFROM v$sql WHERE disk_reads > 10000 ORDER BY disk_reads DESC FETCH FIRST 10 ROWS ONLY;\n`);
    } else if (w.wait_class === 'Concurrency') {
      lines.push(`-- Identify sessions blocked by concurrency waits\nSELECT sid, serial#, event, wait_class, seconds_in_wait, sql_id\nFROM v$session WHERE wait_class = 'Concurrency' AND status = 'ACTIVE';\n`);
    } else if (w.event && w.event.toLowerCase().includes('log file')) {
      lines.push(`-- Redo log performance — check size and switch frequency\nSELECT group#, bytes/1024/1024 AS mb, status FROM v$log;\nSELECT COUNT(*) AS switches_last_hour FROM v$log_history WHERE first_time > SYSDATE - 1/24;\n`);
    } else {
      lines.push(`-- Investigate sessions hitting this wait event\nSELECT sid, serial#, event, p1, p2, p3, wait_time, seconds_in_wait\nFROM v$session_wait WHERE event = '${w.event}';\n`);
    }
    lines.push('```\n\n');
  });

  // Slow SQL with very high elapsed times — critical when >50ms/exec or high buffer gets
  const criticalSql = slowSql.filter(s => s.elapsed_per_exec_ms > 50 || s.buffer_gets_per_exec > 50000);
  criticalSql.slice(0, 3).forEach(s => {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: SQL_ID ${s.sql_id} — ${s.elapsed_per_exec_ms}ms/exec\n\n`);
    lines.push(`Issue: ${s.issue || 'Excessive elapsed time per execution'}. `);
    lines.push(`Buffer gets: ${(s.buffer_gets_per_exec || 0).toLocaleString()}/exec across ${(s.executions || 0).toLocaleString()} executions.\n\n`);
    if (s.sql_text) {
      lines.push(`SQL preview: \`${(s.sql_text || '').substring(0, 120)}...\`\n\n`);
    }
    lines.push('```sql\n');
    lines.push(`-- Get the execution plan for this SQL\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('${s.sql_id}', NULL, 'ALLSTATS LAST'));\n\n`);
    if (s.buffer_gets_per_exec > 10000) {
      // Try to extract table name from SQL text for a more specific index recommendation
      const tableMatch = s.sql_text ? s.sql_text.match(/FROM\s+(\w+\.?\w+)/i) : null;
      const tableName = tableMatch ? tableMatch[1] : 'schema.table_name';
      lines.push(`-- High buffer gets (${(s.buffer_gets_per_exec || 0).toLocaleString()}/exec) — likely missing index\n-- After reviewing the plan, create an index on the filter/join columns:\n-- CREATE INDEX ${tableName.replace('.', '_')}_idx ON ${tableName}(column_name) ONLINE PARALLEL 4;\n\n`);
    }
    lines.push(`-- Force plan reparse if stale\nEXEC DBMS_SHARED_POOL.PURGE('${s.sql_id}', 'C');\n`);
    lines.push('```\n\n');
  });

  // Backup critical issues
  const backupStats = metrics.backup_stats || {};
  if (backupStats.rman_backup && !backupStats.rman_backup.rman_available) {
    hasCritical = true;
    lines.push('### 🔴 CRITICAL: No RMAN Backup Configured\n\n');
    lines.push('No backup jobs found. Data loss risk is HIGH.\n\n');
    lines.push('```sql\n-- Check backup history\nSELECT * FROM V$RMAN_BACKUP_JOB_DETAILS ORDER BY start_time DESC FETCH FIRST 5 ROWS ONLY;\n```\n\n');
  }
  if (backupStats.backup_validation && backupStats.backup_validation.total_corruptions > 0) {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: ${backupStats.backup_validation.total_corruptions} Backup Corruptions Detected\n\n`);
    lines.push('```sql\n-- Investigate corruptions\nSELECT * FROM V$DATABASE_BLOCK_CORRUPTION;\nSELECT * FROM V$BACKUP_CORRUPTION;\n```\n\n');
  }

  // SGA/buffer cache critical
  if (sga.buffer_cache_hit_ratio != null && sga.buffer_cache_hit_ratio < 90) {
    hasCritical = true;
    const currentSga = inst.sga_target_gb || 4;
    const recommendedSga = Math.ceil(currentSga * 1.5);
    lines.push(`### 🔴 CRITICAL: Buffer Cache Hit Ratio at ${sga.buffer_cache_hit_ratio}% (target: >95%)\n\n`);
    lines.push('```sql\n');
    lines.push(`ALTER SYSTEM SET sga_target=${recommendedSga}G SCOPE=BOTH;\n`);
    lines.push('```\n\n');
  }

  // Resource limits at critical
  (metrics.resource_limits && metrics.resource_limits.current || []).filter(r => r.status === 'critical').forEach(r => {
    hasCritical = true;
    lines.push(`### 🔴 CRITICAL: Resource Limit "${r.resource}" at ${r.pct_max_used}% of limit\n\n`);
    lines.push(`Current: ${r.current_utilization}, Peak: ${r.max_utilization}, Limit: ${r.limit_display}\n\n`);
    lines.push('```sql\n');
    lines.push(`-- Check current resource utilization\nSELECT resource_name, current_utilization, max_utilization, initial_allocation, limit_value\nFROM v$resource_limit WHERE resource_name = '${r.resource}';\n`);
    lines.push('```\n\n');
  });

  if (!hasCritical) {
    lines.push('No critical issues detected.\n\n');
  }

  // Performance Recommendations — concrete SQL for every slow query
  lines.push('## Performance Recommendations\n\n');

  if (slowSql.length === 0) {
    lines.push('No slow SQL detected (all queries under 5ms/exec).\n\n');
  }

  slowSql.forEach(s => {
    lines.push(`### ⚠️ WARNING: SQL_ID ${s.sql_id} — ${s.elapsed_per_exec_ms}ms/exec (${(s.executions || 0).toLocaleString()} execs)\n\n`);
    lines.push(`Issue: ${s.issue || 'High elapsed time per execution'}\n\n`);
    if (s.sql_text) {
      lines.push(`SQL preview: \`${(s.sql_text || '').substring(0, 150)}...\`\n\n`);
    }
    // Extract table names from SQL for targeted recommendations
    const tableNames = s.sql_text ? [...new Set((s.sql_text.match(/(?:FROM|JOIN|UPDATE|INTO)\s+(\w+\.?\w+)/gi) || []).map(m => m.replace(/^(?:FROM|JOIN|UPDATE|INTO)\s+/i, '')))] : [];
    const primaryTable = tableNames[0] || 'schema.table_name';
    // Extract WHERE clause columns for index hints
    const whereColumns = s.sql_text ? [...new Set((s.sql_text.match(/WHERE\s+[\s\S]*?(?:AND|OR|\s)(\w+)\s*[=<>!]/gi) || []).map(m => { const col = m.match(/(\w+)\s*[=<>!]/); return col ? col[1] : null; }).filter(Boolean))] : [];

    lines.push('```sql\n');
    lines.push(`-- Step 1: Get the execution plan\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('${s.sql_id}', NULL, 'ALLSTATS LAST'));\n\n`);
    if (s.buffer_gets_per_exec > 10000) {
      if (whereColumns.length > 0) {
        lines.push(`-- Step 2: High buffer gets (${(s.buffer_gets_per_exec || 0).toLocaleString()}/exec) — likely full table scan\n-- Suggested index based on WHERE clause columns:\nCREATE INDEX ${primaryTable.replace(/\./g, '_')}_perf_idx ON ${primaryTable}(${whereColumns.slice(0, 3).join(', ')}) ONLINE PARALLEL 4;\n\n`);
      } else {
        lines.push(`-- Step 2: High buffer gets (${(s.buffer_gets_per_exec || 0).toLocaleString()}/exec) — review plan for full-scan columns\n-- CREATE INDEX ${primaryTable.replace(/\./g, '_')}_perf_idx ON ${primaryTable}(filter_column) ONLINE PARALLEL 4;\n\n`);
      }
    }
    lines.push(`-- Step 3: Force plan reparse if stale\nEXEC DBMS_SHARED_POOL.PURGE('${s.sql_id}', 'C');\n`);
    lines.push('```\n\n');
  });

  // Wait events
  if (criticalWaits.length > 0) {
    lines.push('## Wait Event Analysis\n\n');
    criticalWaits.forEach(w => {
      lines.push(`### ⚠️ ${w.event} [${w.wait_class}]: ${w.pct_db_time}% DB time\n\n`);
      lines.push(`${w.total_waits.toLocaleString()} waits, avg ${w.avg_wait_ms}ms each.\n\n`);
      lines.push('```sql\n');
      if (w.wait_class === 'User I/O') {
        lines.push(`-- Identify I/O-heavy SQL causing this wait\nSELECT sql_id, disk_reads, buffer_gets, elapsed_time/1e6 AS elapsed_s\nFROM v$sql WHERE disk_reads > 10000 ORDER BY disk_reads DESC FETCH FIRST 10 ROWS ONLY;\n`);
      } else if (w.wait_class === 'Concurrency') {
        lines.push(`-- Identify concurrency bottleneck sessions\nSELECT sid, serial#, event, wait_class, seconds_in_wait, sql_id\nFROM v$session WHERE wait_class = 'Concurrency' AND status = 'ACTIVE';\n`);
      } else if (w.event && w.event.toLowerCase().includes('log file')) {
        lines.push(`-- Redo log performance — check log size and switches\nSELECT group#, bytes/1024/1024 AS mb, status FROM v$log;\nSELECT COUNT(*) AS switches_last_hour FROM v$log_history WHERE first_time > SYSDATE - 1/24;\n\n-- If >6 switches/hour, increase redo log size:\n-- ALTER DATABASE ADD LOGFILE GROUP N SIZE 1G;\n`);
      } else {
        lines.push(`-- Investigate sessions hitting this wait\nSELECT sid, serial#, event, p1, p2, p3, wait_time, seconds_in_wait\nFROM v$session_wait WHERE event = '${w.event}';\n`);
      }
      lines.push('```\n\n');
    });
  }

  // Index maintenance — non-critical indexes
  const warnIdx = fragIdx.filter(i => i.pct_deleted <= 50);
  if (warnIdx.length > 0) {
    lines.push('## Index Maintenance\n\n');
    warnIdx.forEach(i => {
      lines.push(`### ⚠️ WARNING: ${i.index_name} — ${i.pct_deleted}% fragmented (${i.size_mb}MB)\n\n`);
      lines.push('```sql\n');
      lines.push(`ALTER INDEX ${i.owner}.${i.index_name} REBUILD ONLINE PARALLEL 4;\n`);
      lines.push('```\n\n');
    });
  }

  // Memory Analysis — null-safe access
  lines.push('## Memory Analysis\n\n');
  const bufferHit = sga.buffer_cache_hit_ratio;
  const multiPass = pga.multipass_executions_pct;
  const currentSga = inst.sga_target_gb || 'N/A';
  const currentPga = inst.pga_aggregate_target_gb || pga.pga_target_gb || 'N/A';

  if (bufferHit != null) {
    lines.push(`Buffer Cache Hit Ratio: **${bufferHit}%** `);
    if (bufferHit < 95 && currentSga !== 'N/A') {
      const recSga = Math.ceil(Number(currentSga) * 1.25);
      lines.push(`(below 95% target)\n\n\`\`\`sql\nALTER SYSTEM SET sga_target=${recSga}G SCOPE=BOTH;\n\`\`\`\n\n`);
    } else {
      lines.push('(healthy)\n\n');
    }
  }

  if (multiPass != null) {
    lines.push(`PGA Multi-pass: **${multiPass}%** `);
    if (multiPass > 1 && currentPga !== 'N/A') {
      const recPga = Math.ceil(Number(currentPga) * 1.5);
      lines.push(`(above 1% threshold)\n\n\`\`\`sql\nALTER SYSTEM SET pga_aggregate_target=${recPga}G SCOPE=BOTH;\n\`\`\`\n\n`);
    } else {
      lines.push('(acceptable)\n\n');
    }
  }

  if (sga.hard_parses_per_sec != null && sga.hard_parses_per_sec > 20) {
    lines.push(`Hard Parses/sec: **${sga.hard_parses_per_sec}** (high — cursor sharing may help)\n\n`);
    lines.push('```sql\nALTER SYSTEM SET cursor_sharing=FORCE SCOPE=BOTH;\n-- Monitor for plan regression after enabling\n```\n\n');
  }

  return lines.join('');
}

// Download routes defined above at lines 767-789 (oracle-proxy.py, oracle-proxy.js, oracle-proxy-install.sh)

// Proxy version endpoint — used by oracle-proxy.py auto-update check
// Returns current canonical version + sha256 checksum of the downloadable file
app.get('/api/proxy/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const filePath = path.join(__dirname, 'oracle-proxy.py');
  try {
    const content = fs.readFileSync(filePath);
    const checksum = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
    // Extract VERSION = "x.y.z" from the file itself as source of truth
    const match = content.toString().match(/^VERSION\s*=\s*["']([^"']+)["']/m);
    const version = match ? match[1].trim() : '3.1.1';
    console.log('[proxy/version] parsed version:', match ? match[1].trim() : 'NO MATCH', '| file bytes:', content.length);
    res.json({ version, checksum, download_url: '/downloads/oracle-proxy.py' });
  } catch (err) {
    res.status(500).json({ error: 'Could not compute proxy version' });
  }
});

// Proxy checksums endpoint — returns SHA-256 digests for all downloadable proxy artifacts
// Used by oracle-setup.html to display integrity verification checksums to customers
app.get('/api/proxy/checksums', (req, res) => {
  const artifacts = [
    { file: 'oracle-proxy.py',          filename: 'oracle-proxy.py',          label: 'Python 3.6+',    download: '/downloads/oracle-proxy.py' },
    { file: 'oracle-proxy.js',          filename: 'oracle-proxy.js',          label: 'Node.js 14+',    download: '/downloads/oracle-proxy.js' },
    { file: 'oracle-proxy-install.sh',  filename: 'oracle-proxy-install.sh',  label: 'Shell installer', download: '/downloads/oracle-proxy-install.sh' },
  ];
  try {
    const results = artifacts.map(a => {
      const content = fs.readFileSync(path.join(__dirname, a.file));
      return {
        filename: a.filename,
        label: a.label,
        download_url: a.download,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        size_bytes: content.length,
      };
    });
    // Cache-Control: allow browsers to cache for 5 min; checksums only change on deploy
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ checksums: results, generated_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Could not compute checksums' });
  }
});

// Dashboard page — no-cache to prevent stale HTML after deploys
app.get('/dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/');
  }
});

// Health check history page
app.get('/reports', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// Report page — no-cache prevents stale HTML after deploys (express.static
// only covers /report.html, not /report/:id which uses sendFile directly)
app.get('/report/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const htmlPath = path.join(__dirname, 'public', 'report.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.redirect('/dashboard');
  }
});

// ============================================================
// API: Health Check Lead Capture
// ============================================================

// Submit a health check request (public, no auth)
app.post('/api/health-check-requests', async (req, res) => {
  try {
    const { name, email, company, oracle_version, env_type, num_databases, pain_point } = req.body;
    // Capture source URL from body or referer header
    const source_url = req.body.source_url || req.get('Referer') || null;

    if (!name || !email || !company) {
      return res.status(400).json({ error: 'name, email, and company are required' });
    }

    const result = await pool.query(
      `INSERT INTO health_check_requests (name, email, company, oracle_version, env_type, num_databases, pain_point, status, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8)
       RETURNING id, name, email, company, status, created_at`,
      [name, email, company, oracle_version || null, env_type || null, num_databases || null, pain_point || null, source_url]
    );

    const lead = result.rows[0];

    // Send internal notification email to company inbox
    const companySlug = 'tunevault';
    const inboxEmail = `${companySlug}@polsia.app`;
    const htmlBody = `
      <div style='font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;'>
        <div style='background: #111114; border: 1px solid #2a2a30; border-radius: 12px; padding: 24px; color: #e8e8ed;'>
          <h2 style='color: #f0a830; margin-top: 0;'>New Health Check Request</h2>
          <table style='width: 100%; border-collapse: collapse; margin: 16px 0;'>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Name</strong></td><td style='padding: 8px 0;'>${name}</td></tr>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Email</strong></td><td style='padding: 8px 0;'><a href='mailto:${email}' style='color: #f0a830;'>${email}</a></td></tr>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Company</strong></td><td style='padding: 8px 0;'>${company}</td></tr>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Oracle Version</strong></td><td style='padding: 8px 0;'>${oracle_version || 'Not specified'}</td></tr>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Environment</strong></td><td style='padding: 8px 0;'>${env_type || 'Not specified'}</td></tr>
            <tr><td style='padding: 8px 0; color: #8888a0;'><strong>Databases</strong></td><td style='padding: 8px 0;'>${num_databases || 'Not specified'}</td></tr>
          </table>
          ${pain_point ? `<div style='background: #1a1a1f; padding: 16px; border-radius: 8px; margin-top: 16px;'><strong style='color: #8888a0;'>Pain Point:</strong><p style='margin: 8px 0 0; line-height: 1.6;'>${pain_point}</p></div>` : ''}
          <a href='/admin/requests' style='display: inline-block; margin-top: 20px; padding: 10px 20px; background: #f0a830; color: #0a0a0c; text-decoration: none; border-radius: 6px; font-weight: 600;'>View in Admin &rarr;</a>
        </div>
      </div>
    `;
    const textBody = `New Health Check Request\n\nName: ${name}\nEmail: ${email}\nCompany: ${company}\nOracle Version: ${oracle_version || 'Not specified'}\nEnvironment: ${env_type || 'Not specified'}\nDatabases: ${num_databases || 'Not specified'}\n${pain_point ? `\nPain Point: ${pain_point}` : ''}\n\nView in Admin: /admin/requests`;

    // Fire-and-forget email send — don't block the response
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>',
        to: inboxEmail,
        subject: `New Health Check Request: ${name} from ${company}`,
        text: textBody,
        html: htmlBody,
      }),
    }).catch(err => console.error('Failed to send health check request notification email:', err.message));

    res.json({ success: true, id: lead.id });
  } catch (err) {
    console.error('Error saving health check request:', err);
    res.status(500).json({ error: 'Failed to save health check request' });
  }
});

// ============================================================
// Checks Catalogue API
// ============================================================

// GET /api/checks-catalogue — list all checks, filterable by category/status
app.get('/api/checks-catalogue', async (req, res) => {
  try {
    const { category, status } = req.query;
    let query = `SELECT id, check_id, category, name, description, severity_thresholds, remediation_hint, requires, status, created_at FROM checks_catalogue WHERE 1=1`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    query += ` ORDER BY category, check_id`;
    const result = await pool.query(query, params);
    res.json({ checks: result.rows, total: result.rows.length });
  } catch (err) {
    // Table may not exist yet if migration hasn't run
    if (err.message && err.message.includes('relation "checks_catalogue" does not exist')) {
      res.json({ checks: [], total: 0, note: 'checks_catalogue table not yet created — run migrations' });
    } else {
      console.error('Error fetching checks catalogue:', err.message);
      res.status(500).json({ error: 'Failed to fetch checks catalogue' });
    }
  }
});

// GET /api/checks-catalogue/categories — distinct category list with counts
app.get('/api/checks-catalogue/categories', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT category, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status='production') AS production_count,
              COUNT(*) FILTER (WHERE status='experimental') AS experimental_count
       FROM checks_catalogue
       GROUP BY category
       ORDER BY category`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    if (err.message && err.message.includes('relation "checks_catalogue" does not exist')) {
      res.json({ categories: [] });
    } else {
      console.error('Error fetching categories:', err.message);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  }
});

// PATCH /api/admin/checks-catalogue/:checkId/status — update check status (admin)
app.patch('/api/admin/checks-catalogue/:checkId/status', requireAdminMW, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['production', 'experimental', 'needs_validation'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }
    const result = await pool.query(
      `UPDATE checks_catalogue SET status=$1, updated_at=NOW() WHERE check_id=$2 RETURNING check_id, status`,
      [status, req.params.checkId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Check not found' });
    res.json({ success: true, check_id: result.rows[0].check_id, status: result.rows[0].status });
  } catch (err) {
    console.error('Error updating check status:', err.message);
    res.status(500).json({ error: 'Failed to update check status' });
  }
});

// CI synthetic test helper — create a minimal oracle_connections row for automated delete tests.
// Admin-only. Returns { id } so the caller can DELETE and assert 404.
// Inserts with a distinctive name prefix so accidental orphans are easy to spot and clean up.
app.post('/api/admin/test/connections', requireAdminMW, async (req, res) => {
  try {
    const name = (req.body && req.body.name) || `__ci-delete-test-${Date.now()}__`;
    const host = (req.body && req.body.host) || 'test.invalid';
    const port = (req.body && req.body.port) || 1521;
    const service_name = (req.body && req.body.service_name) || 'TESTSVC';
    const username = (req.body && req.body.username) || 'ci_test';
    // Minimal insert — password is empty string (plaintext, only used for CI test rows)
    const result = await pool.query(
      `INSERT INTO oracle_connections (name, host, port, service_name, username, password, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '', $6, NOW(), NOW())
       RETURNING id, name`,
      [name, host, port, service_name, username, req.user.id]
    );
    console.log(`[ci-test-helper] created synthetic connection id=${result.rows[0].id} name="${name}"`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[ci-test-helper] failed to create synthetic connection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List all health check requests (admin — auth required)
app.get('/api/admin/health-check-requests', requireAdminMW, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, company, oracle_version, env_type, num_databases, pain_point, status, source_url, created_at
       FROM health_check_requests
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing health check requests:', err);
    res.status(500).json({ error: 'Failed to list health check requests' });
  }
});

// Update health check request status (admin — auth required)
app.patch('/api/admin/health-check-requests/:id', requireAdminMW, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['new', 'contacted', 'scheduled', 'completed', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    const result = await pool.query(
      `UPDATE health_check_requests SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check request not found' });
    }

    res.json({ success: true, status });
  } catch (err) {
    console.error('Error updating health check request status:', err);
    res.status(500).json({ error: 'Failed to update health check request' });
  }
});

// Delete health check request (admin — auth required)
app.delete('/api/admin/health-check-requests/:id', requireAdminMW, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM health_check_requests WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Health check request not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting health check request:', err);
    res.status(500).json({ error: 'Failed to delete health check request' });
  }
});

// Bulk update status (admin — auth required) — e.g. mark all new → contacted
app.post('/api/admin/health-check-requests/bulk-status', requireAdminMW, async (req, res) => {
  try {
    const { ids, status } = req.body;
    const validStatuses = ['new', 'contacted', 'scheduled', 'completed', 'closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    await pool.query(
      `UPDATE health_check_requests SET status = $1 WHERE id = ANY($2::int[])`,
      [status, ids]
    );
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    console.error('Error bulk-updating health check request status:', err);
    res.status(500).json({ error: 'Failed to bulk update status' });
  }
});

// CSV export (admin — auth required)
app.get('/api/admin/health-check-requests/export.csv', requireAdminMW, async (req, res) => {
  try {
    const { status } = req.query;
    const validStatuses = ['new', 'contacted', 'scheduled', 'completed', 'closed'];
    let query = `SELECT id, name, email, company, oracle_version, env_type, num_databases, pain_point, status, source_url, created_at FROM health_check_requests`;
    const params = [];
    if (status && validStatuses.includes(status)) {
      query += ` WHERE status = $1`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);

    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = ['ID', 'Name', 'Email', 'Company', 'Oracle Version', 'Environment', 'DBs', 'Pain Point', 'Status', 'Source URL', 'Date'];
    const rows = result.rows.map(r => [
      r.id, r.name, r.email, r.company, r.oracle_version, r.env_type,
      r.num_databases, r.pain_point, r.status, r.source_url,
      new Date(r.created_at).toISOString()
    ].map(csvEscape).join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="health-check-requests.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting health check requests CSV:', err);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// Send reply email to a lead (admin — auth required)
app.post('/api/admin/send-reply', requireAdminMW, async (req, res) => {
  try {
    const { to, name, subject, body, requestId } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }

    const htmlBody = `
      <div style="font-family: 'Helvetica Neue', Helvetica, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; background: #fff; color: #111;">
        ${body.split('\n').map(line => line.trim() ? `<p style="margin: 0 0 14px; line-height: 1.6;">${line}</p>` : '<br>').join('')}
        <hr style="margin: 28px 0; border: none; border-top: 1px solid #eee;" />
        <p style="font-size: 12px; color: #999; margin: 0;">TuneVault — Oracle Database Health Checks</p>
      </div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'TuneVault <noreply@tunevault.app>',
        to,
        subject,
        text: body,
        html: htmlBody,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.json().catch(() => ({}));
      console.error('Email proxy error:', err);
      return res.status(502).json({ error: 'Failed to send email via proxy', detail: err });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error sending reply email:', err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// Run blog seed on demand — idempotent upsert of all articles (admin-only)
app.post('/api/admin/seed-blog', requireAdminMW, (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, 'scripts', 'seed-blog.js');
  execFile(process.execPath, [script], { env: process.env, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[seed-blog] admin endpoint failed:', err.message, stderr);
      return res.status(500).json({ ok: false, error: err.message, stderr });
    }
    console.log('[seed-blog] completed via admin endpoint');
    res.json({ ok: true, output: stdout });
  });
});

// List all users with health check stats (admin — auth required)
app.get('/api/admin/users', requireAdminMW, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        u.id,
        u.email,
        u.name,
        u.company_domain,
        CASE WHEN u.google_id IS NOT NULL THEN 'google' ELSE 'magic_link' END AS auth_method,
        u.created_at,
        u.last_login,
        COUNT(hc.id)::int AS total_checks,
        COUNT(hc.id) FILTER (WHERE hc.is_demo = true)::int AS demo_checks,
        COUNT(hc.id) FILTER (WHERE hc.is_demo = false)::int AS own_db_checks
       FROM users u
       LEFT JOIN health_checks hc ON hc.user_id = u.id
       GROUP BY u.id, u.email, u.name, u.company_domain, u.google_id, u.created_at, u.last_login
       ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing admin users:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Demo DB status — demo always uses deterministic seeded data (admin — auth required)
app.get('/api/admin/demo-status', requireAdminMW, async (req, res) => {
  const recent = await pool.query(
    `SELECT id, connection_name, status, overall_score, created_at
     FROM health_checks WHERE is_demo = true ORDER BY created_at DESC LIMIT 5`
  ).catch(() => ({ rows: [] }));

  res.json({
    live_demo_configured: false,
    mode: 'seeded_data',
    recent_demo_runs: recent.rows
  });
});

// ============================================================
// Schedule Config API
// ============================================================

// Allowed cron presets (maps UI label to cron expression)
const SCHEDULE_PRESETS = {
  '*/5 * * * *':  'Every 5 minutes (testing)',
  '0 * * * *':    'Every 1 hour',
  '0 */6 * * *':  'Every 6 hours',
  '0 */12 * * *': 'Every 12 hours',
  '0 0 * * *':    'Every 24 hours',
};

// Compute next run time from a cron string.
// Uses the cron library's validate() for safety; falls back to 6h from now on parse errors.
function computeNextRunAt(cronStr) {
  if (!cron.validate(cronStr)) {
    console.warn(`Invalid cron expression "${cronStr}", defaulting to 6h interval`);
    cronStr = '0 */6 * * *';
  }
  // Walk minute-by-minute from now (up to 24h) to find next match
  const parts = cronStr.split(' ');
  const now = new Date();
  const candidate = new Date(now.getTime() + 60000); // start 1 minute ahead
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 1440; i++) {
    if (matchesCron(candidate, parts)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  // Fallback: 6 hours from now
  return new Date(now.getTime() + 6 * 3600 * 1000);
}

function matchesCron(date, parts) {
  const [minPart, hourPart, domPart, monPart, dowPart] = parts;
  const min  = date.getMinutes();
  const hour = date.getHours();
  const dom  = date.getDate();
  const mon  = date.getMonth() + 1;
  const dow  = date.getDay();
  return (
    cronFieldMatches(minPart,  min,  0, 59) &&
    cronFieldMatches(hourPart, hour, 0, 23) &&
    cronFieldMatches(domPart,  dom,  1, 31) &&
    cronFieldMatches(monPart,  mon,  1, 12) &&
    cronFieldMatches(dowPart,  dow,  0, 7)
  );
}

function cronFieldMatches(field, value, min, max) {
  if (field === '*') return true;
  // Handle */n (step from min)
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  // Handle n-m/step ranges
  if (field.includes('/')) {
    const [range, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    const [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  }
  // Handle comma-separated list
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  // Handle range n-m
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  // Literal number (also treat 7 == 0 for Sunday)
  const n = parseInt(field, 10);
  if (field === '7' && value === 0) return true;
  return n === value;
}

// PATCH /api/connections/:id/schedule — enable/disable scheduled runs + set cron
app.patch('/api/connections/:id/schedule', requireAuth, requireConnectionOwner, async (req, res) => {
  try {
    const { schedule_enabled, schedule_cron } = req.body;

    if (typeof schedule_enabled !== 'boolean') {
      return res.status(400).json({ error: 'schedule_enabled must be a boolean' });
    }

    const connId = parseInt(req.params.id, 10);

    // Only the connection's owner can update it (fetch to verify ownership)
    const connResult = await pool.query(
      'SELECT id, user_id, name FROM oracle_connections WHERE id = $1',
      [connId]
    );
    if (connResult.rows.length === 0) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    if (connResult.rows[0].user_id && connResult.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Validate cron — only allow known presets (security: don't accept arbitrary cron from client)
    const safeCron = schedule_cron && SCHEDULE_PRESETS[schedule_cron]
      ? schedule_cron
      : '0 */6 * * *';

    let nextRunAt = null;
    if (schedule_enabled) {
      nextRunAt = computeNextRunAt(safeCron);
    }

    const result = await pool.query(
      `UPDATE oracle_connections
       SET schedule_enabled = $1,
           schedule_cron = $2,
           next_scheduled_run_at = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, schedule_enabled, schedule_cron, next_scheduled_run_at`,
      [schedule_enabled, safeCron, nextRunAt, connId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating schedule config:', err);
    res.status(500).json({ error: 'Failed to update schedule config' });
  }
});

// GET /api/schedule-presets — return allowed cron presets for UI
app.get('/api/schedule-presets', (req, res) => {
  res.json(Object.entries(SCHEDULE_PRESETS).map(([cron_expr, label]) => ({ cron_expr, label })));
});

// ============================================================
// Scheduled Health Check Runner
// Decision: node-cron inside the existing Express process.
// Rationale: single-service constraint, no Bull/BullMQ present.
// One tick per minute; only fires actual work when a connection
// has schedule_enabled=true AND next_scheduled_run_at <= NOW().
// ============================================================

// Check if a user/company is on paid tier
// Paid = any users not subject to the 1-free-HC-per-company wall,
// i.e. either internal (polsia.com domain) or has already had >1 real run approved.
// We detect paid via company_hc_usage: if hc_count > 1 they already bypassed the wall
// or were manually unlocked. For scheduled runs we skip the wall entirely for connections
// belonging to users who have previously succeeded (hc_count >= 1 already consumed = they paid/are internal).
// Free tier: hc_count === 0 means they haven't run yet — schedule should be blocked at save time.
// If hc_count === 1: they used their free HC, schedule runs will consume more — block unless paid.
// Paid signal: hc_count in company_hc_usage set to a large number (999) by admin, or user domain is internal.
const INTERNAL_DOMAINS = new Set(['polsia.com', 'polsia.internal', 'tunevault.internal']);

async function isScheduledRunAllowed(userId) {
  // Connections without user_id are legacy/admin entries — allow them
  if (!userId) return { allowed: true, reason: 'no_user_id' };
  try {
    const userResult = await pool.query('SELECT company_domain FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) return { allowed: false, reason: 'user_not_found' };
    const domain = userResult.rows[0].company_domain || '';
    if (INTERNAL_DOMAINS.has(domain)) return { allowed: true, reason: 'internal' };

    // Check company_hc_usage — if hc_count >= 999 it's been manually unlocked (paid/trial)
    const usageResult = await pool.query(
      'SELECT hc_count FROM company_hc_usage WHERE company_domain = $1',
      [domain]
    );
    if (usageResult.rows.length === 0) {
      // No prior HCs on file — this shouldn't happen (schedule requires at least one prior run) but block it
      return { allowed: false, reason: 'free_tier_no_prior_run' };
    }
    const hcCount = usageResult.rows[0].hc_count;
    if (hcCount >= 999) return { allowed: true, reason: 'paid_unlocked' };

    // Free tier: already used the 1 free HC, scheduled runs would add more — block
    return { allowed: false, reason: 'free_tier' };
  } catch (err) {
    console.error('isScheduledRunAllowed error:', err.message);
    return { allowed: false, reason: 'error' };
  }
}

async function runScheduledHealthCheck(conn) {
  const connId = conn.id;
  console.log(`[scheduler] Running scheduled HC for connection ${connId} (${conn.name})`);

  try {
    // Resolve credentials — agent connections may have NULL encrypted_password
    const password      = conn.encrypted_password ? decrypt(conn.encrypted_password) : null;
    const proxyApiKey   = conn.proxy_api_key_enc  ? decrypt(conn.proxy_api_key_enc)  : null;
    const appsPwd       = conn.apps_pwd_enc       ? decrypt(conn.apps_pwd_enc)       : null;
    const weblogicPwd   = conn.weblogic_pwd_enc   ? decrypt(conn.weblogic_pwd_enc)   : null;
    const isProxy = conn.connection_type === 'proxy';
    const isAgent = isProxy && !conn.username && !conn.encrypted_password;

    const displayName = conn.name || (isAgent ? `${conn.service_name || 'auto-detect'} (via agent)` : isProxy ? `${conn.service_name} (via proxy)` : `${conn.host}/${conn.service_name}`);
    // Resolve placeholder proxy_url — agent may have registered since connection was created
    let resolvedProxyUrl = conn.proxy_url;
    if (isProxy && resolvedProxyUrl === 'https://pending.tunevault.agent') {
      try {
        const tunnelRow = await pool.query(
          `SELECT dns_hostname FROM agent_tunnels WHERE connection_id = $1 AND dns_hostname IS NOT NULL AND status IN ('provisioned','confirmed','active')`,
          [connId]
        );
        if (tunnelRow.rows.length > 0 && tunnelRow.rows[0].dns_hostname) {
          resolvedProxyUrl = `https://${tunnelRow.rows[0].dns_hostname}`;
        } else if (conn.server_type !== 'apps' && conn.host && conn.host !== 'pending.tunevault.agent') {
          resolvedProxyUrl = `http://${conn.host}:3100`;
        }
        if (resolvedProxyUrl !== 'https://pending.tunevault.agent') {
          await pool.query(
            `UPDATE oracle_connections SET proxy_url = $1, updated_at = NOW() WHERE id = $2 AND proxy_url = 'https://pending.tunevault.agent'`,
            [resolvedProxyUrl, connId]
          );
        }
      } catch (_resolveErr) {
        console.warn(`[scheduler] proxy_url resolve failed for conn ${connId}:`, _resolveErr.message);
      }
      if (resolvedProxyUrl === 'https://pending.tunevault.agent') {
        console.warn(`[scheduler] Skipping HC for conn ${connId} — agent proxy not yet registered`);
        return;
      }
    }

    const displayHost = isProxy ? resolvedProxyUrl : conn.host;

    // Insert health check record
    const insertResult = await pool.query(
      `INSERT INTO health_checks (connection_name, host, port, service_name, is_demo, connection_id, status, metrics, overall_score, username)
       VALUES ($1, $2, $3, $4, false, $5, 'connecting', '{}', 0, $6)
       RETURNING id`,
      [displayName, displayHost, isProxy ? 443 : conn.port, conn.service_name, connId, conn.username || (isAgent ? 'sys (os auth)' : null)]
    );
    const healthCheckId = insertResult.rows[0].id;

    // Kick off the run (fire-and-forget)
    if (isProxy) {
      runProxyHealthCheck(healthCheckId, {
        connectionId: connId,
        proxyUrl: resolvedProxyUrl,
        proxyApiKey,
        serviceName: conn.service_name,
        username: conn.username,
        password,
        osAuth: isAgent,
        serverType:   conn.server_type || null,
        appsPwd,
        weblogicPwd,
      }).catch(err => {
        console.error(`[scheduler] Proxy HC error for conn ${connId}:`, err.message);
      });
    } else {
      runRealHealthCheck(healthCheckId, {
        host: conn.host,
        port: conn.port,
        serviceName: conn.service_name,
        username: conn.username,
        password,
        connectionId: connId
      }).catch(err => {
        console.error(`[scheduler] Real HC error for conn ${connId}:`, err.message);
      });
    }

    console.log(`[scheduler] HC ${healthCheckId} enqueued for conn ${connId}`);
  } catch (err) {
    // Proxy/Oracle unreachable: write one error row into check_results, don't retry
    console.error(`[scheduler] Failed to start HC for conn ${connId}:`, err.message);
    const runId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO check_results
         (connection_id, run_id, check_id, check_category, status, raw_payload, executed_at)
       VALUES ($1, $2, 'SCHEDULER_ERROR', 'error', 'error', $3, NOW())`,
      [connId, runId, JSON.stringify({ error: err.message, scheduled: true })]
    ).catch(e => console.error('[scheduler] Failed to write error row:', e.message));
  }
}

// Expose health-check runner to routes via Express app.locals.
// routes/first-run.js calls req.app.locals.runHealthCheckForConnection(conn) to fire a pack.
app.locals.runHealthCheckForConnection = runScheduledHealthCheck;

// Tick every 60 seconds — find due connections and run them
function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      // Find all connections due for a scheduled run
      const result = await pool.query(
        `SELECT oc.id, oc.name, oc.host, oc.port, oc.service_name, oc.username,
                oc.encrypted_password, oc.connection_type, oc.proxy_url, oc.proxy_api_key_enc,
                oc.schedule_cron, oc.user_id, oc.server_type,
                oc.apps_pwd_enc, oc.weblogic_pwd_enc
         FROM oracle_connections oc
         WHERE oc.schedule_enabled = true
           AND oc.next_scheduled_run_at <= NOW()`
      );

      if (result.rows.length === 0) return;
      console.log(`[scheduler] ${result.rows.length} connection(s) due for scheduled run`);

      for (const conn of result.rows) {
        // Update timestamps first (prevents double-fire if run takes > 60s)
        const nextRun = computeNextRunAt(conn.schedule_cron);
        await pool.query(
          `UPDATE oracle_connections
           SET last_scheduled_run_at = NOW(), next_scheduled_run_at = $1
           WHERE id = $2`,
          [nextRun, conn.id]
        );

        // Check free-tier guard
        const access = await isScheduledRunAllowed(conn.user_id);
        if (!access.allowed) {
          console.log(`[scheduler] Skipping conn ${conn.id} (${conn.name}): ${access.reason}`);
          // Write a blocked row so it's visible in history
          const runId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO check_results
               (connection_id, run_id, check_id, check_category, status, raw_payload, executed_at)
             VALUES ($1, $2, 'SCHEDULER_BLOCKED', 'error', 'error', $3, NOW())`,
            [conn.id, runId, JSON.stringify({ blocked: true, reason: access.reason, scheduled: true })]
          ).catch(() => {});
          continue;
        }

        await runScheduledHealthCheck(conn);
      }
    } catch (err) {
      console.error('[scheduler] Tick error:', err.message);
    }
  });
  console.log('[scheduler] Started — checking for due connections every 60s');
}

// ============================================================
// Trial activation drip — 3-touch email sequence (every 30 min)
// ============================================================

const emailDripDb  = require('./db/email-drip');
const { sendDripStep } = require('./services/drip-mailer');

/**
 * Called (fire-and-forget) whenever a real (non-demo) health check completes.
 * Suppresses all remaining drip emails for that user — they've seen value, no need to nudge.
 */
function suppressDripOnCheckComplete(healthCheckId) {
  pool.query(
    `SELECT hc.user_id, hc.is_demo, hc.connection_id, hc.score,
            oc.is_ebs,
            (SELECT COUNT(*) FROM check_results WHERE run_id = hc.id AND status = 'red') AS red_count,
            (SELECT COUNT(*) FROM check_results WHERE run_id = hc.id) AS finding_count
     FROM health_checks hc
     LEFT JOIN oracle_connections oc ON oc.id = hc.connection_id
     WHERE hc.id = $1`,
    [healthCheckId]
  ).then(async ({ rows }) => {
    const hc = rows[0];
    if (!hc || !hc.user_id || hc.is_demo) return;

    // Suppress drip emails
    await emailDripDb.suppressUser(hc.user_id, 'check_completed');

    // Track health_check_completed (all checks) and first_check_completed (first only)
    const prevRes = await pool.query(
      `SELECT 1 FROM health_checks
       WHERE connection_id IN (SELECT id FROM oracle_connections WHERE user_id = $1)
         AND id != $2 AND is_demo = false AND status = 'completed' LIMIT 1`,
      [hc.user_id, healthCheckId]
    );
    const isFirst = prevRes.rows.length === 0;
    const checkProps = {
      score        : hc.score ? Number(hc.score) : null,
      critical_count: Number(hc.red_count),
      finding_count: Number(hc.finding_count),
      is_ebs       : Boolean(hc.is_ebs),
    };
    // Generalised event — every completed check
    await dbAnalytics.trackEvent({
      eventName: 'health_check_completed',
      userId: hc.user_id,
      properties: checkProps,
    });
    if (isFirst) {
      await dbAnalytics.trackEvent({
        eventName: 'first_check_completed',
        userId: hc.user_id,
        properties: checkProps,
      });
    }
  }).catch(err => {
    console.warn('[drip] suppress-on-complete error:', err.message);
  });
}

async function runDripTick() {
  // Step 1 — signup +0h: immediate, no DB connection required
  try {
    const users1 = await emailDripDb.getUsersForStep1();
    for (const user of users1) {
      // Mark before send to prevent double-fire if send is slow
      await emailDripDb.markStepSent(user.id, 1);
      const result = await sendDripStep(1, user);
      if (!result.sent) {
        console.warn(`[drip] step 1 send failed for ${user.email}: ${result.error}`);
      } else {
        console.log(`[drip] step 1 sent to ${user.email}`);
        dbAnalytics.trackEvent({ eventName: 'trial_drip_email_sent', userId: user.id, properties: { step: 1 } }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[drip] step 1 tick error:', err.message);
  }

  // Step 2 — signup +24h, no DB connected
  try {
    const users2 = await emailDripDb.getUsersForStep2();
    for (const user of users2) {
      await emailDripDb.markStepSent(user.id, 2);
      const result = await sendDripStep(2, user);
      if (!result.sent) {
        console.warn(`[drip] step 2 send failed for ${user.email}: ${result.error}`);
      } else {
        console.log(`[drip] step 2 sent to ${user.email}`);
        dbAnalytics.trackEvent({ eventName: 'trial_drip_email_sent', userId: user.id, properties: { step: 2 } }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[drip] step 2 tick error:', err.message);
  }

  // Step 3 — signup +72h, no real check completed
  try {
    const users3 = await emailDripDb.getUsersForStep3();
    for (const user of users3) {
      await emailDripDb.markStepSent(user.id, 3);
      const result = await sendDripStep(3, user);
      if (!result.sent) {
        console.warn(`[drip] step 3 send failed for ${user.email}: ${result.error}`);
      } else {
        console.log(`[drip] step 3 sent to ${user.email}`);
        dbAnalytics.trackEvent({ eventName: 'trial_drip_email_sent', userId: user.id, properties: { step: 3 } }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[drip] step 3 tick error:', err.message);
  }
}

function startDripCron() {
  // Run immediately on boot (catches any backlog) then every 30 minutes
  runDripTick().catch(err => console.error('[drip] initial tick error:', err.message));
  cron.schedule('*/30 * * * *', () => {
    runDripTick().catch(err => console.error('[drip] tick error:', err.message));
  });
  console.log('[drip] Started — running every 30 minutes');
}

// ── Agent health sweeper — auto-probes all live agent connections every 5 min ──
// Stores results in connection_health_runs for the /connections fleet-health column.
// Respects a 4-min recency guard in getConnectionsForSweep() to avoid duplicate runs.

const healthDb = require('./db/connection-health');
const { runDiagnosticsForConnection } = require('./routes/connections-list');

async function runHealthSweep() {
  let conns;
  try {
    conns = await healthDb.getConnectionsForSweep();
  } catch (err) {
    console.error('[health-sweeper] DB query error:', err.message);
    return;
  }
  if (!conns.length) return;
  console.log(`[health-sweeper] Sweeping ${conns.length} agent connection(s)`);

  // Fan out — each probe run takes up to 60s; run in parallel but don't crash on failure
  await Promise.allSettled(
    conns.map(conn => runDiagnosticsForConnection(conn, 'sweeper').catch(err => {
      console.error(`[health-sweeper] conn ${conn.connection_id} error:`, err.message);
    }))
  );

  // Prune stale run history (keep last 50 per connection) — non-blocking
  healthDb.pruneOldRuns().catch(err => console.error('[health-sweeper] prune error:', err.message));
}

// ── Crash-loop email sweep — email the owner once per incident ─────────────
// Runs every 10 minutes to detect registered_no_heartbeat / crash_loop state.
// Sends a one-time alert to the connection owner (dedupped by agent_crash_alerts_sent).
const { sendCrashLoopAlert, deriveAgentHealth } = require('./routes/agent-crash-detect');

async function runCrashLoopEmailSweep() {
  try {
    // Candidate connections: proxy type, confirmed in last 2h, no recent heartbeat
    const result = await pool.query(
      `SELECT oc.id, oc.name, oc.host, oc.installed_at, u.email AS owner_email
       FROM oracle_connections oc
       LEFT JOIN agent_tunnels at ON at.connection_id = oc.id
       LEFT JOIN users u ON u.id = oc.user_id
       WHERE oc.connection_type = 'proxy'
         AND u.email IS NOT NULL
         AND at.status = 'confirmed'
         AND at.confirmed_at > NOW() - INTERVAL '2 hours'
         AND (at.last_heartbeat IS NULL OR at.last_heartbeat < NOW() - INTERVAL '2 minutes')`,
      []
    );
    if (!result.rows.length) return;

    await Promise.allSettled(result.rows.map(async row => {
      try {
        const health = await deriveAgentHealth(row.id);
        if (health.state !== 'crash_loop' && health.state !== 'registered_no_heartbeat') return;
        await sendCrashLoopAlert({
          connectionId: row.id,
          connectionName: row.name,
          agentHealth: health.state,
          recipientEmail: row.owner_email,
          host: row.host,
          installFailureClass: health.install_failure?.error_class,
        });
      } catch (e) {
        console.warn(`[crash-sweep] conn ${row.id} error:`, e.message);
      }
    }));
  } catch (err) {
    console.error('[crash-sweep] sweep error:', err.message);
  }
}

function startHealthSweeper() {
  // Offset from the scheduler (which fires every 1 min) — start at */5 to not double-fire on boot
  cron.schedule('*/5 * * * *', () => {
    runHealthSweep().catch(err => console.error('[health-sweeper] tick error:', err.message));
  });
  // Crash-loop email sweep — runs every 10 minutes (offset from health sweep)
  cron.schedule('2-59/10 * * * *', () => {
    runCrashLoopEmailSweep().catch(err => console.error('[crash-sweep] tick error:', err.message));
  });
  console.log('[health-sweeper] Started — probing live agents every 5 minutes');
}

// ── Failure bundle retention cron — purge bundles older than 30 days ──────────
// Runs daily at 03:17 UTC (offset avoids hourly job collisions).
const bundleDb = require('./db/failure-bundles');
cron.schedule('17 3 * * *', async () => {
  try {
    const n = await bundleDb.purgeOldBundles();
    if (n > 0) console.log(`[bundle-purge] Deleted ${n} failure bundle(s) older than 30 days`);
  } catch (err) {
    console.error('[bundle-purge] Error:', err.message);
  }
});

// ── TNS topology snapshot retention cron — purge snapshots older than 30 days ──
// Runs daily at 03:37 UTC (offset from bundle-purge to avoid I/O spikes).
const tnsTopoDb = require('./db/tns-topology');
cron.schedule('37 3 * * *', async () => {
  try {
    const n = await tnsTopoDb.purgeOldSnapshots();
    if (n > 0) console.log(`[tns-snapshot-purge] Deleted ${n} TNS topology snapshot(s) older than 30 days`);
  } catch (err) {
    console.error('[tns-snapshot-purge] Error:', err.message);
  }
});

// ── Global 404 handler — must come after all routes and static middleware ──────
app.use((req, res) => {
  // Explicit /api/ check first — avoids relying on req.accepts('html') which
  // is unreliable for non-browser clients (Accept:*/* matches 'html').
  const isApi = (req.originalUrl || req.path).startsWith('/api/');
  if (!isApi && req.accepts('html')) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  res.status(404).json({ error: 'Not found', path: req.originalUrl || req.path });
});

// ── Global error handler — catches unhandled errors from route handlers ────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error-handler]', err.message, err.stack ? err.stack.split('\n')[1] : '');
  // Never expose stack traces in production
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  if (!((req.originalUrl || req.path).startsWith('/api/')) && req.accepts('html')) {
    return res.status(err.status || 500).sendFile(path.join(__dirname, 'public', '500.html'));
  }
  res.status(err.status || 500).json({ error: message, code: err.code || 'INTERNAL_ERROR' });
});

// Idempotent startup fixes — column guards + one-time data patches.
// Runs before app.listen() so requests never see missing columns.
async function ensureColumns() {
  await pool.query(`
    ALTER TABLE oracle_connections
      ADD COLUMN IF NOT EXISTS apps_pwd_enc      TEXT,
      ADD COLUMN IF NOT EXISTS weblogic_pwd_enc  TEXT,
      ADD COLUMN IF NOT EXISTS ebs_instance_name VARCHAR(64),
      ADD COLUMN IF NOT EXISTS ebs_context_file  TEXT
  `);

  await pool.query(`
    ALTER TABLE blog_posts
      ADD COLUMN IF NOT EXISTS coming_soon BOOLEAN DEFAULT FALSE
  `);

  // Backfill is_ebs for any connections we know are EBS by server_type or instance membership.
  await pool.query(`
    UPDATE oracle_connections
       SET is_ebs = true
     WHERE is_ebs IS NOT TRUE
       AND (server_type IN ('apps','both') OR ebs_instance_name IS NOT NULL)
  `);

  // Infer server_type='apps' for connections that have no Oracle DB host (app-tier only)
  // and either: ebs_instance_name set, OR an agent_tunnels row with no oracle_sids
  // (app servers have no Oracle SIDs because they don't run the DB).
  // Guard: host IS NULL — DB-tier connections always have host set after confirming service_name.
  await pool.query(`
    UPDATE oracle_connections
       SET server_type = 'apps',
           is_ebs      = TRUE
     WHERE server_type IS NULL
       AND (host IS NULL OR host = '')
       AND (
         ebs_instance_name IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM agent_tunnels at
           WHERE at.connection_id = oracle_connections.id
             AND (at.oracle_sids IS NULL OR array_length(at.oracle_sids, 1) IS NULL)
             AND at.status <> 'uninstalled'
         )
       )
  `);

  // Reset auto-upgrade suppression for any connection whose proxy is < 3.20.6.
  // Pre-3.20.6 proxies can't handle self-upgrade work items so they accumulate
  // failed audit rows that suppress further attempts. Back-dating unblocks the
  // next heartbeat re-evaluation. Idempotent — no-op once successfully upgraded.
  await pool.query(`
    UPDATE agent_upgrade_audit
    SET triggered_at = NOW() - INTERVAL '25 hours'
    WHERE status = 'failed'
      AND triggered_at > NOW() - INTERVAL '24 hours'
      AND connection_id IN (
        SELECT id FROM oracle_connections
        WHERE proxy_version < '3.20.6'
           OR proxy_version IS NULL
      )
  `);
}

ensureColumns()
  .then(() => {
    app.listen(port, () => {
      console.log(`TuneVault running on port ${port}`);
      const oracle = getOracleClient();
      if (oracle) {
        console.log('Oracle thin client loaded — live connections enabled');
      } else {
        console.log('Oracle thin client not available — demo mode only');
      }
      startScheduler();
      startDripCron();
      startHealthSweeper();
    });
  })
  .catch(err => {
    console.error('Startup column check failed:', err.message);
    // Start anyway — columns may already exist or DB may be temporarily unavailable
    app.listen(port, () => {
      console.log(`TuneVault running on port ${port} (column check failed — continuing)`);
      startScheduler();
      startDripCron();
      startHealthSweeper();
    });
  });
