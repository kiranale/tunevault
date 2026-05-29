/**
 * routes/tunebot.js — TuneBot context-aware chat API.
 *
 * Owns: GET /context (connection metadata + latest health check + tickets),
 *       POST /chat (AI response with injected Oracle environment context).
 * Does NOT own: health check execution, connection CRUD, ticket management,
 *               TuneBot UI (public/tunebot.js), OpenAI client initialisation (server.js).
 *
 * Context is scoped to the authenticated user's selected connection.
 * If no health check exists yet, /context returns { noHealthCheck: true }.
 */

'use strict';

const express = require('express');
const pool = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Rate limit: 20 chat calls/min per user (generous but prevents abuse)
const chatCalls = new Map();
function chatRateLimit(req, res, next) {
  const key = `${req.user.id}`;
  const now = Date.now();
  const window = 60000;
  const max = 20;
  const calls = chatCalls.get(key) || [];
  const recent = calls.filter(t => now - t < window);
  if (recent.length >= max) {
    return res.status(429).json({ error: 'Too many requests — wait a moment before asking again.' });
  }
  recent.push(now);
  chatCalls.set(key, recent);
  next();
}

// ── GET /api/tunebot/context?connectionId=X ───────────────────────────────────
// Returns: connection metadata, latest health check summary, top critical findings,
//          open/recent TuneOps tickets. All scoped to the authenticated user.
router.get('/context', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const connectionId = req.query.connectionId ? parseInt(req.query.connectionId, 10) : null;

    // ── 1. Connections list (user-scoped) ─────────────────────────────────────
    const connResult = await pool.query(
      `SELECT id, name, host, port, service_name, oracle_version, connection_type, is_ebs, ebs_checks_enabled
       FROM oracle_connections
       WHERE user_id = $1 OR user_id IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );
    const connections = connResult.rows;

    // Determine active connection
    let activeConn = null;
    if (connectionId) {
      activeConn = connections.find(c => c.id === connectionId) || null;
    }
    if (!activeConn && connections.length > 0) {
      activeConn = connections[0]; // Default to most recent
    }

    if (!activeConn) {
      return res.json({
        noConnections: true,
        connections: [],
        message: 'No Oracle connections found. Add a connection to get started.'
      });
    }

    // ── 2. Latest completed health check for active connection ────────────────
    // health_checks does not have is_ebs — EBS detection comes from oracle_connections
    const hcResult = await pool.query(
      `SELECT id, overall_score, summary_text, top_action, ebs_summary, ebs_action,
              ai_recommendations, created_at, completed_at, status
       FROM health_checks
       WHERE connection_id = $1
         AND (user_id = $2 OR user_id IS NULL)
         AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [activeConn.id, userId]
    );

    if (hcResult.rows.length === 0) {
      return res.json({
        noHealthCheck: true,
        activeConnection: {
          id: activeConn.id,
          name: activeConn.name,
          host: activeConn.host || null,
          oracle_version: activeConn.oracle_version,
          connection_type: activeConn.connection_type,
          is_ebs: activeConn.is_ebs
        },
        connections: connections.map(c => ({ id: c.id, name: c.name })),
        message: `No completed health check found for "${activeConn.name}". Run a health check first.`
      });
    }

    const hc = hcResult.rows[0];

    // ── 3. Critical + amber check results from the latest run ─────────────────
    // check_results.run_id is a UUID (crypto.randomUUID) unrelated to health_checks.id (SERIAL).
    // Look up findings by connection_id + latest run_id for that connection.
    const findingsResult = await pool.query(
      `SELECT check_id, check_category, status, metric_name, metric_value, metric_unit,
              ai_summary, recommendation
       FROM check_results
       WHERE connection_id = $1
         AND run_id = (
           SELECT run_id FROM check_results
           WHERE connection_id = $1
           ORDER BY executed_at DESC LIMIT 1
         )
         AND status IN ('red', 'amber')
       ORDER BY
         CASE status WHEN 'red' THEN 0 WHEN 'amber' THEN 1 ELSE 2 END,
         check_category, check_id
       LIMIT 25`,
      [activeConn.id]
    );

    // ── 4. Open/recent TuneOps tickets for this connection ────────────────────
    let tickets = [];
    try {
      // company_id from user email domain — matches tuneops.js pattern
      const companyId = req.user.company_domain || req.user.email.split('@')[1] || `user_${userId}`;
      const ticketResult = await pool.query(
        `SELECT ticket_number, title, severity, status, created_at, updated_at
         FROM tuneops_tickets
         WHERE company_id = $1
           AND connection_id = $2
           AND status NOT IN ('RESOLVED')
         ORDER BY
           CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
           updated_at DESC
         LIMIT 10`,
        [companyId, activeConn.id]
      );
      tickets = ticketResult.rows;
    } catch (e) {
      // tuneops_tickets may not exist in all environments
      console.log('[tunebot] tuneops_tickets not available:', e.message);
    }

    return res.json({
      activeConnection: {
        id: activeConn.id,
        name: activeConn.name,
        host: activeConn.host || null,
        oracle_version: activeConn.oracle_version || 'Unknown',
        connection_type: activeConn.connection_type || 'direct',
        is_ebs: !!(activeConn.is_ebs || activeConn.ebs_checks_enabled)
      },
      connections: connections.map(c => ({ id: c.id, name: c.name })),
      healthCheck: {
        id: hc.id,
        score: hc.overall_score,
        completedAt: hc.completed_at,
        summary: hc.summary_text,
        topAction: hc.top_action,
        ebsSummary: hc.ebs_summary,
        ebsAction: hc.ebs_action,
        aiRecommendations: hc.ai_recommendations,
        findings: findingsResult.rows
      },
      tickets
    });
  } catch (err) {
    console.error('[tunebot] /context error:', err.message);
    res.status(500).json({ error: 'Failed to load context' });
  }
});

// ── POST /api/tunebot/chat ────────────────────────────────────────────────────
// Body: { message: string, connectionId?: number, context?: object, history?: [] }
// Returns: { reply: string, source: 'ai' | 'error' }
router.post('/chat', requireAuth, chatRateLimit, async (req, res) => {
  const { message, context, history = [] } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Build the system prompt — inject real Oracle context when available
  let systemPrompt = buildSystemPrompt(context);

  // Build conversation messages (last 6 turns max to stay within token budget)
  const recentHistory = (Array.isArray(history) ? history : []).slice(-6);
  const messages = [
    ...recentHistory.map(turn => ({
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.content
    })),
    { role: 'user', content: message.trim() }
  ];
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const completion = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: systemPrompt,
      messages: messages,
    });
    const reply = completion.content[0]?.text || 'Sorry, I could not generate a response.';
    res.json({ reply, source: 'ai' });
  } catch (err) {
    console.error('[tunebot] /chat AI error:', err.message);
    // Don't crash — return a graceful error the frontend can handle
    res.status(503).json({
      error: 'AI temporarily unavailable',
      source: 'error'
    });
  }
});

// ── Prompt builder ────────────────────────────────────────────────────────────

const TUNEVAULT_PRODUCT_KNOWLEDGE = `## TuneVault Product Knowledge
- **What it does:** Connects to Oracle databases and runs 200+ health checks across 13 DB categories + 5 EBS categories. Results display in a 9-tab dashboard with PDF/XLSX export.
- **Agent install:** \`curl -fsSL https://tunevault-bm8c.onrender.com/install.sh | sudo TUNEVAULT_TOKEN=<token> TUNEVAULT_API=https://tunevault-bm8c.onrender.com bash\`
- **Get a token:** Go to /connections/new in the TuneVault UI — the token is generated there.
- **Agent:** A Python service (oracle-proxy.py) that runs on the Oracle server. Installs to /opt/tunevault/. Managed by systemd as tunevault-agent.service.
- **Supported OS:** Oracle Linux (OEL) 7/8/9, RHEL 7/8/9, Amazon Linux 2/2023, Ubuntu/Debian.
- **Connectivity:** Outbound polling only — no inbound ports, no firewall rules, no VPN required. Agent polls the TuneVault cloud every 25s.
- **DB user:** Creates a least-privilege \`tunevault_reader\` role with SELECT_CATALOG_ROLE. Script at /docs/privileges.
- **Pricing:** See /pricing page. Free tier available; paid plans unlock deeper checks and EBS operations.
- **Support:** support@tunevault.app`;

function buildSystemPrompt(ctx) {
  const lines = [
    'You are TuneBot, an expert Oracle DBA assistant embedded in TuneVault — a database health monitoring platform.',
    'Your job is to give concrete, actionable DBA advice. Be direct and specific. Lead with the answer.',
    'Format responses in markdown. Use bullet points and code blocks where relevant.',
    'Keep responses concise — 3-6 sentences unless the question requires more detail.',
    '',
    TUNEVAULT_PRODUCT_KNOWLEDGE,
    '',
  ];

  if (!ctx) {
    lines.push('No Oracle environment context is currently available. Answer based on general Oracle DBA knowledge.');
    lines.push('The user can share their connection context by opening TuneBot while viewing their dashboard.');
    return lines.join('\n');
  }

  if (ctx.noConnections) {
    lines.push('The user has no Oracle connections saved yet. Help them get started with TuneVault setup.');
    return lines.join('\n');
  }

  if (ctx.noHealthCheck) {
    const c = ctx.activeConnection || {};
    lines.push(`## Current Connection`);
    lines.push(`- **Name:** ${c.name || 'Unknown'}`);
    lines.push(`- **Oracle Version:** ${c.oracle_version || 'Unknown'}`);
    lines.push(`- **Type:** ${c.connection_type || 'direct'}`);
    lines.push(`- **EBS:** ${c.is_ebs ? 'Yes' : 'No'}`);
    lines.push('');
    lines.push('No health check has been run for this connection yet. If the user asks about issues, encourage them to run a health check first. You can still answer general Oracle questions.');
    return lines.join('\n');
  }

  const conn = ctx.activeConnection || {};
  const hc = ctx.healthCheck || {};
  const tickets = ctx.tickets || [];
  const findings = hc.findings || [];

  // Connection context
  lines.push('## Active Oracle Environment');
  lines.push(`- **Connection:** ${conn.name}`);
  lines.push(`- **Oracle Version:** ${conn.oracle_version || 'Unknown'}`);
  lines.push(`- **Connection Type:** ${conn.connection_type || 'direct'}`);
  lines.push(`- **EBS Detected:** ${conn.is_ebs ? 'Yes — E-Business Suite detected' : 'No'}`);
  lines.push('');

  // Health check summary
  lines.push('## Latest Health Check');
  lines.push(`- **Overall Score:** ${hc.score !== undefined && hc.score !== null ? hc.score + '/100' : 'N/A'}`);
  lines.push(`- **Run At:** ${hc.completedAt ? new Date(hc.completedAt).toUTCString() : 'Unknown'}`);
  if (hc.summary) lines.push(`- **AI Summary:** ${hc.summary}`);
  if (hc.topAction) lines.push(`- **Top Recommended Action:** ${hc.topAction}`);
  if (conn.is_ebs) {
    if (hc.ebsSummary) lines.push(`- **EBS Summary:** ${hc.ebsSummary}`);
    if (hc.ebsAction) lines.push(`- **EBS Top Action:** ${hc.ebsAction}`);
  }
  lines.push('');

  // Findings (red and amber)
  const redFindings = findings.filter(f => f.status === 'red');
  const amberFindings = findings.filter(f => f.status === 'amber');

  if (redFindings.length > 0) {
    lines.push('## Critical Findings (Red)');
    redFindings.forEach(f => {
      const val = f.metric_value !== undefined && f.metric_value !== null
        ? ` — ${f.metric_value}${f.metric_unit ? ' ' + f.metric_unit : ''}`
        : '';
      lines.push(`- **${f.check_id}** [${f.check_category}]${val}: ${f.ai_summary || ''}${f.recommendation ? ' → ' + f.recommendation : ''}`);
    });
    lines.push('');
  }

  if (amberFindings.length > 0) {
    lines.push('## Warning Findings (Amber)');
    amberFindings.slice(0, 8).forEach(f => {
      const val = f.metric_value !== undefined && f.metric_value !== null
        ? ` — ${f.metric_value}${f.metric_unit ? ' ' + f.metric_unit : ''}`
        : '';
      lines.push(`- **${f.check_id}** [${f.check_category}]${val}: ${f.ai_summary || ''}${f.recommendation ? ' → ' + f.recommendation : ''}`);
    });
    lines.push('');
  }

  if (findings.length === 0) {
    lines.push('## Findings');
    lines.push('All checks passed — no critical or warning findings.');
    lines.push('');
  }

  // AI recommendations (structured JSONB from the health check analysis)
  const recs = hc.aiRecommendations;
  if (recs && Array.isArray(recs) && recs.length > 0) {
    lines.push('## AI Recommendations');
    recs.slice(0, 6).forEach(r => {
      const conf = r.confidence ? ` [${r.confidence}]` : '';
      lines.push(`- ${r.title || r.category || 'Recommendation'}${conf}: ${r.summary || r.fix_sql || ''}`);
    });
    lines.push('');
  }

  // Open tickets
  if (tickets.length > 0) {
    lines.push('## Open TuneOps Tickets');
    tickets.forEach(t => {
      lines.push(`- **${t.ticket_number}** [${t.severity}/${t.status}]: ${t.title}`);
    });
    lines.push('');
  }

  lines.push('When answering questions, reference the specific findings, scores, and metrics above. Be a DBA who knows this exact database, not a generic assistant.');
  lines.push('If the user asks about something not covered by the health check data, answer from Oracle DBA knowledge and note that running a health check would give you specific data.');

  return lines.join('\n');
}

module.exports = router;
