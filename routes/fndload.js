/**
 * routes/fndload.js — FNDLOAD object migration wizard API + page.
 *
 * Owns: /fndload page, /api/ebs/fndload/* endpoints.
 * Does NOT own: Oracle connection storage (server.js), SSH vault (db/ssh-targets.js),
 *               Oracle proxy authentication, other EBS ops pages.
 *
 * Security model:
 *   - requireAuth + connection ownership checked server-side for every operation.
 *   - APPS password is passed per-request in request body; never stored or logged.
 *   - FNDLOAD commands are template-built server-side from whitelisted object_type values;
 *     user input (object_names) is shell-escaped before interpolation.
 *   - All operations are written to fndload_history (append-only audit log).
 *   - Target name confirmation is validated server-side, not just UI-side.
 *
 * Routes:
 *   GET  /fndload                        — serve the wizard page
 *   POST /api/ebs/fndload/validate       — validate object names exist on source
 *   POST /api/ebs/fndload/download       — FNDLOAD DOWNLOAD on source (or target), returns .ldt text
 *   POST /api/ebs/fndload/diff           — AI diff two .ldt files
 *   POST /api/ebs/fndload/upload         — FNDLOAD UPLOAD to target, audit logged
 *   GET  /api/ebs/fndload/history        — recent migration history for the user
 */

'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const OpenAI  = require('openai');

const pool               = require('../db/index');
const { decrypt }        = require('../crypto-utils');
const { requireAuth }    = require('../middleware/auth');
const { logFndloadAction, getHistory } = require('../db/fndload');

const router = express.Router();
const openai = new OpenAI();

// ─── Supported object types ──────────────────────────────────────────────────
// Maps object_type label → { lct, download_mode_args(shortName) }
// lct is the FNDLOAD config file on the APPS tier ($FND_TOP/patch/115/import/)
// These are the fully supported types; others may be added in future.

const OBJECT_TYPES = {
  'Concurrent Program':        { lct: 'afcpprog.lct',  catalog_view: 'FND_CONCURRENT_PROGRAMS_VL',  name_col: 'CONCURRENT_PROGRAM_NAME' },
  'Concurrent Executable':     { lct: 'afcpprog.lct',  catalog_view: 'FND_EXECUTABLES_VL',           name_col: 'EXECUTABLE_NAME' },
  'Value Set':                 { lct: 'afffload.lct',  catalog_view: 'FND_FLEX_VALUE_SETS',          name_col: 'FLEX_VALUE_SET_NAME' },
  'Menu':                      { lct: 'afsload.lct',   catalog_view: 'FND_MENUS_VL',                  name_col: 'MENU_NAME' },
  'Responsibility':             { lct: 'afscursp.lct',  catalog_view: 'FND_RESPONSIBILITY_VL',         name_col: 'RESPONSIBILITY_KEY' },
  'Lookup':                    { lct: 'aflvmlu.lct',   catalog_view: 'FND_LOOKUP_TYPES_VL',           name_col: 'LOOKUP_TYPE' },
  'Message':                   { lct: 'afmdmsg.lct',   catalog_view: 'FND_NEW_MESSAGES',              name_col: 'MESSAGE_NAME' },
  'Profile Option':            { lct: 'afscprof.lct',  catalog_view: 'FND_PROFILE_OPTIONS_VL',        name_col: 'PROFILE_OPTION_NAME' },
  'Request Group':             { lct: 'afcpreqg.lct',  catalog_view: 'FND_REQUEST_GROUPS',            name_col: 'REQUEST_GROUP_NAME' },
  'Descriptive Flexfield':     { lct: 'afffload.lct',  catalog_view: 'FND_DESCRIPTIVE_FLEXS_VL',     name_col: 'DESCRIPTIVE_FLEXFIELD_NAME' },
};

// Object types with full FNDLOAD backend wiring
const FULLY_SUPPORTED = new Set([
  'Concurrent Program', 'Value Set', 'Lookup',
]);

// ─── Shell-escape helper ──────────────────────────────────────────────────────
// Wraps a string in single quotes and escapes embedded single quotes.
// Safe for POSIX sh arguments.
function shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ─── Proxy SSH exec helper ────────────────────────────────────────────────────
async function runViaProxy(proxyUrl, proxyApiKey, sshTarget, authConfig, command, timeoutMs = 120000) {
  const baseUrl = proxyUrl.replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl = baseUrl + '/api/ssh/exec';
  const started = Date.now();

  const body = JSON.stringify({
    host:        sshTarget.host,
    port:        sshTarget.port || 22,
    username:    sshTarget.os_user,
    auth_method: sshTarget.auth_method === 'key' ? 'key' : 'password',
    password:    sshTarget.auth_method !== 'key' ? (authConfig.password || '') : '',
    private_key: sshTarget.auth_method === 'key'  ? (authConfig.privateKey || '') : '',
    command,
    timeout:     Math.ceil(timeoutMs / 1000),
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      ok: false, exitCode: null, stdout: '', stderr: '[proxy] Request timed out',
      durationMs: Date.now() - started,
    }), timeoutMs + 5000);

    const urlObj    = new URL(execUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const options   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Api-Key':      proxyApiKey,
      },
      rejectUnauthorized: false,
    };

    const req = transport.request(options, (proxyRes) => {
      let raw = '';
      proxyRes.on('data', (chunk) => { raw += chunk; });
      proxyRes.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(raw);
          resolve({
            ok:         data.success === true,
            exitCode:   data.exit_code ?? null,
            stdout:     (data.stdout || '').slice(0, 512_000),
            stderr:     (data.stderr || '').slice(0, 64_000),
            durationMs: Date.now() - started,
          });
        } catch {
          resolve({ ok: false, exitCode: null, stdout: '', stderr: raw.slice(0, 1000), durationMs: Date.now() - started });
        }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, exitCode: null, stdout: '', stderr: err.message, durationMs: Date.now() - started }); });
    req.write(body);
    req.end();
  });
}

// ─── Oracle connection loader ─────────────────────────────────────────────────
async function getConn(connId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, host, port, service_name, username, encrypted_password,
            connection_type, proxy_url, proxy_api_key_enc
     FROM oracle_connections WHERE id = $1 AND user_id = $2`,
    [connId, userId],
  );
  if (!rows.length) return null;
  const c = rows[0];
  return {
    id:             c.id,
    name:           c.name,
    host:           c.host,
    port:           c.port || 1521,
    serviceName:    c.service_name,
    username:       c.username,
    password:       decrypt(c.encrypted_password),
    connectionType: c.connection_type,
    proxyUrl:       c.proxy_url || null,
    proxyApiKey:    c.proxy_api_key_enc ? decrypt(c.proxy_api_key_enc) : null,
  };
}

// ─── SSH target loader (apps_tier scoped to connection + user) ────────────────
async function getAppsTarget(connId, userId) {
  const { rows } = await pool.query(
    `SELECT st.id, st.host, st.port, st.os_user, st.auth_method,
            st.encrypted_private_key, st.encrypted_passphrase
     FROM ssh_targets st
     WHERE st.connection_id = $1
       AND (st.user_id = $2 OR st.user_id IS NULL)
       AND st.role = 'apps_tier'
     LIMIT 1`,
    [connId, userId],
  );
  if (!rows.length) return null;
  const t = rows[0];
  return {
    id:          t.id,
    host:        t.host,
    port:        t.port || 22,
    os_user:     t.os_user,
    auth_method: t.auth_method,
    privateKey:  t.encrypted_private_key ? decrypt(t.encrypted_private_key) : null,
    passphrase:  t.encrypted_passphrase  ? decrypt(t.encrypted_passphrase)  : null,
  };
}

// ─── SQL SELECT via Oracle proxy (for object validation) ─────────────────────
async function runSqlViaProxy(conn, sql, timeoutMs = 30000) {
  const baseUrl = (conn.proxyUrl || '').replace(/\/proxy$/, '').replace(/\/$/, '');
  const execUrl = baseUrl + '/api/execute-sql';

  const body = JSON.stringify({
    host:         conn.host,
    port:         conn.port,
    service_name: conn.serviceName,
    username:     conn.username,
    password:     conn.password,
    sql,
    max_rows:     500,
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, rows: [], error: 'timeout' }), timeoutMs + 5000);
    const urlObj    = new URL(execUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const options   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Api-Key': conn.proxyApiKey || '' },
      rejectUnauthorized: false,
    };
    const req = transport.request(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try { const d = JSON.parse(raw); resolve({ ok: d.success !== false, rows: d.rows || [], columns: d.columns || [], error: d.error || null }); }
        catch { resolve({ ok: false, rows: [], error: raw.slice(0, 500) }); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, rows: [], error: e.message }); });
    req.write(body);
    req.end();
  });
}

// ─── Build FNDLOAD command ────────────────────────────────────────────────────
// Returns the full shell command to FNDLOAD DOWNLOAD or UPLOAD an object.
// All user-supplied names are shell-escaped.
function buildFndloadCmd(action, { appsPassword, objectType, objectNames, ldtPath }) {
  const typeDef = OBJECT_TYPES[objectType];
  if (!typeDef) throw new Error(`Unknown object type: ${objectType}`);
  const lct = typeDef.lct;

  // $FND_TOP is set in the Oracle EBS environment via adadmin/adautocfg
  const fndTop = '$FND_TOP';
  const lctPath = `${fndTop}/patch/115/import/${lct}`;

  if (action === 'DOWNLOAD') {
    // Multi-object: FNDLOAD apps/<pw> 0 Y DOWNLOAD <lct> <ldt> <entity> <where-clause>
    // Simplified: one command per object, concatenated
    const cmds = objectNames.map(name => {
      const escaped = shellEscape(name);
      return buildSingleDownload({ objectType, lctPath, ldtPath, escaped, appsPassword });
    });
    return cmds.join('\n');
  }

  if (action === 'UPLOAD') {
    // FNDLOAD apps/<pw> 0 Y UPLOAD <lct> <ldt>
    const appsArg = shellEscape(`apps/${appsPassword}`);
    return `FNDLOAD ${appsArg} 0 Y UPLOAD ${shellEscape(lctPath)} ${shellEscape(ldtPath)}`;
  }

  throw new Error(`Unknown FNDLOAD action: ${action}`);
}

function buildSingleDownload({ objectType, lctPath, ldtPath, escaped, appsPassword }) {
  const appsArg = shellEscape(`apps/${appsPassword}`);
  // Different object types use different entity names in the FNDLOAD config
  const entityMap = {
    'Concurrent Program':    'FND_CONCURRENT_PROGRAM',
    'Concurrent Executable': 'FND_EXECUTABLE',
    'Value Set':             'FND_FLEX_VALUE_SET',
    'Menu':                  'FND_MENU',
    'Responsibility':        'FND_RESPONSIBILITY',
    'Lookup':                'FND_LOOKUP_TYPE',
    'Message':               'FND_NEW_MESSAGE',
    'Profile Option':        'FND_PROFILE_OPTION',
    'Request Group':         'FND_REQUEST_GROUP',
    'Descriptive Flexfield': 'FND_DESCRIPTIVE_FLEX',
  };
  const entity = entityMap[objectType] || 'FND_CONCURRENT_PROGRAM';
  return `FNDLOAD ${appsArg} 0 Y DOWNLOAD ${shellEscape(lctPath)} ${shellEscape(ldtPath)} ${entity} ${escaped}`;
}

// ─── AI diff helper ───────────────────────────────────────────────────────────
async function aiDiffLdts(sourceLdt, targetLdt, objectType) {
  const MAX_CHARS = 12000; // stay well under token limits
  const srcSnip = sourceLdt.length > MAX_CHARS ? sourceLdt.slice(0, MAX_CHARS) + '\n... [truncated]' : sourceLdt;
  const tgtSnip = targetLdt.length > MAX_CHARS ? targetLdt.slice(0, MAX_CHARS) + '\n... [truncated]' : targetLdt;

  const prompt = `You are an Oracle EBS DBA expert comparing two FNDLOAD .ldt files for a "${objectType}" object migration.

Source instance .ldt (the version to be migrated FROM):
\`\`\`
${srcSnip}
\`\`\`

Target instance .ldt (the CURRENT version on the destination):
\`\`\`
${tgtSnip}
\`\`\`

Produce a concise human-readable diff. For each object in the files:
1. List attributes that differ between source and target (format: "attribute: source=<val>, target=<val>")
2. List attributes present in source but missing in target (would be added by migration)
3. List entries present in target but not in source (would be overwritten/removed by migration)
4. If files are identical, say "No differences found — source and target are in sync."

Be specific. Use the actual attribute names and values. Keep it under 400 words.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.2,
    });
    return completion.choices[0]?.message?.content?.trim() || 'No diff produced.';
  } catch (err) {
    return `AI diff unavailable: ${err.message}. Review .ldt files manually before proceeding.`;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /fndload — wizard page
router.get('/fndload', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'fndload.html'));
});

// GET /api/ebs/fndload/object-types — metadata for UI
router.get('/api/ebs/fndload/object-types', requireAuth, (req, res) => {
  const types = Object.entries(OBJECT_TYPES).map(([label, def]) => ({
    label,
    lct: def.lct,
    fullySupported: FULLY_SUPPORTED.has(label),
  }));
  res.json({ types });
});

// POST /api/ebs/fndload/validate — check object names exist on source
// Body: { source_conn_id, apps_password, object_type, object_names[] }
router.post('/api/ebs/fndload/validate', requireAuth, async (req, res) => {
  const { source_conn_id, apps_password, object_type, object_names } = req.body;

  if (!source_conn_id || !apps_password || !object_type || !Array.isArray(object_names) || object_names.length === 0) {
    return res.status(400).json({ error: 'source_conn_id, apps_password, object_type, object_names[] required' });
  }
  if (!OBJECT_TYPES[object_type]) {
    return res.status(400).json({ error: `Unknown object_type: ${object_type}` });
  }

  const conn = await getConn(parseInt(source_conn_id, 10), req.user.id);
  if (!conn) return res.status(403).json({ error: 'Source connection not found or access denied' });
  if (conn.connectionType !== 'proxy' || !conn.proxyUrl) {
    return res.status(400).json({ error: 'Source connection must be a proxy connection for FNDLOAD operations' });
  }

  const typeDef   = OBJECT_TYPES[object_type];
  const nameList  = object_names.map(n => `'${String(n).replace(/'/g, "''")}'`).join(',');
  const sql       = `SELECT ${typeDef.name_col} AS name FROM APPS.${typeDef.catalog_view} WHERE ${typeDef.name_col} IN (${nameList})`;

  const result = await runSqlViaProxy(conn, sql);

  if (!result.ok) {
    return res.status(502).json({ error: `Proxy SQL failed: ${result.error}` });
  }

  const found    = new Set((result.rows || []).map(r => Object.values(r)[0]));
  const notFound = object_names.filter(n => !found.has(n));

  res.json({ found: [...found], not_found: notFound });
});

// POST /api/ebs/fndload/download
// Body: { conn_id, apps_password, object_type, object_names[], target_name_confirm? }
// Returns: { ldt_text, object_type, conn_name }
router.post('/api/ebs/fndload/download', requireAuth, async (req, res) => {
  const { conn_id, apps_password, object_type, object_names, is_target } = req.body;

  if (!conn_id || !apps_password || !object_type || !Array.isArray(object_names) || object_names.length === 0) {
    return res.status(400).json({ error: 'conn_id, apps_password, object_type, object_names[] required' });
  }
  if (!OBJECT_TYPES[object_type]) {
    return res.status(400).json({ error: `Unknown object_type: ${object_type}` });
  }

  const conn = await getConn(parseInt(conn_id, 10), req.user.id);
  if (!conn) return res.status(403).json({ error: 'Connection not found or access denied' });
  if (conn.connectionType !== 'proxy' || !conn.proxyUrl) {
    return res.status(400).json({ error: 'Connection must be a proxy connection for FNDLOAD operations' });
  }

  const target = await getAppsTarget(parseInt(conn_id, 10), req.user.id);
  if (!target) {
    return res.status(400).json({ error: 'No apps_tier SSH target configured for this connection. Add one in Settings → SSH Targets.' });
  }

  const authConfig = { password: target.passphrase || '', privateKey: target.privateKey || '' };
  const ldtPath    = `/tmp/tunevault_${Date.now()}.ldt`;

  const cmd = buildFndloadCmd('DOWNLOAD', { appsPassword: apps_password, objectType: object_type, objectNames: object_names, ldtPath });
  // Also capture the .ldt content after download
  const fullCmd = `${cmd} && cat ${shellEscape(ldtPath)} && rm -f ${shellEscape(ldtPath)}`;

  const result = await runViaProxy(conn.proxyUrl, conn.proxyApiKey, target, authConfig, fullCmd);

  if (!result.ok && !result.stdout) {
    return res.status(502).json({ error: `FNDLOAD DOWNLOAD failed (exit ${result.exitCode}): ${result.stderr}` });
  }

  // Log the download action
  await logFndloadAction({
    user_id: req.user.id, user_email: req.user.email, action: 'download',
    source_conn_id: conn.id, source_conn_name: conn.name,
    object_type, lct_file: OBJECT_TYPES[object_type].lct, object_names,
    success: result.ok, error_message: result.ok ? null : result.stderr?.slice(0, 500),
  }).catch(() => {}); // non-critical

  res.json({ ldt_text: result.stdout, conn_name: conn.name, object_type, exit_code: result.exitCode, stderr: result.stderr });
});

// POST /api/ebs/fndload/diff
// Body: { source_ldt, target_ldt, object_type }
router.post('/api/ebs/fndload/diff', requireAuth, async (req, res) => {
  const { source_ldt, target_ldt, object_type } = req.body;
  if (!source_ldt || !object_type) {
    return res.status(400).json({ error: 'source_ldt and object_type required' });
  }

  const diff = await aiDiffLdts(source_ldt || '', target_ldt || '(no existing version on target)', object_type);
  res.json({ diff });
});

// POST /api/ebs/fndload/upload
// Body: { source_conn_id, target_conn_id, apps_password, object_type, object_names[],
//         source_ldt, pre_state_ldt, target_name_confirm, diff_summary }
router.post('/api/ebs/fndload/upload', requireAuth, async (req, res) => {
  const {
    source_conn_id, target_conn_id,
    apps_password, object_type, object_names,
    source_ldt, pre_state_ldt, target_name_confirm, diff_summary,
  } = req.body;

  if (!source_conn_id || !target_conn_id || !apps_password || !object_type ||
      !Array.isArray(object_names) || !source_ldt || !target_name_confirm) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!OBJECT_TYPES[object_type]) {
    return res.status(400).json({ error: `Unknown object_type: ${object_type}` });
  }

  const targetConn = await getConn(parseInt(target_conn_id, 10), req.user.id);
  if (!targetConn) return res.status(403).json({ error: 'Target connection not found or access denied' });
  if (targetConn.connectionType !== 'proxy' || !targetConn.proxyUrl) {
    return res.status(400).json({ error: 'Target connection must be a proxy connection for FNDLOAD operations' });
  }

  // Server-side confirmation check: user must type the exact target connection name
  if (target_name_confirm !== targetConn.name) {
    return res.status(400).json({ error: `Confirmation text does not match target connection name "${targetConn.name}"` });
  }

  const sourceConn = await getConn(parseInt(source_conn_id, 10), req.user.id);
  if (!sourceConn) return res.status(403).json({ error: 'Source connection not found or access denied' });

  const target = await getAppsTarget(parseInt(target_conn_id, 10), req.user.id);
  if (!target) {
    return res.status(400).json({ error: 'No apps_tier SSH target configured for the target connection.' });
  }

  const authConfig = { password: target.passphrase || '', privateKey: target.privateKey || '' };
  const ldtPath    = `/tmp/tunevault_upload_${Date.now()}.ldt`;

  // Write .ldt content to temp file, then FNDLOAD UPLOAD, then verify + cleanup
  const escapedLdt = source_ldt.replace(/'/g, "'\\''");
  const writeCmd   = `cat > ${shellEscape(ldtPath)} << 'TUNEVAULT_EOF'\n${source_ldt}\nTUNEVAULT_EOF`;
  const uploadCmd  = buildFndloadCmd('UPLOAD', { appsPassword: apps_password, objectType: object_type, objectNames: object_names, ldtPath });
  const cleanCmd   = `rm -f ${shellEscape(ldtPath)}`;
  // Chain: write ldt → upload → verify → cleanup
  const typeDef    = OBJECT_TYPES[object_type];
  const nameList   = object_names.map(n => `'${String(n).replace(/'/g, "''")}'`).join(',');
  const verifySql  = `SELECT ${typeDef.name_col} FROM APPS.${typeDef.catalog_view} WHERE ${typeDef.name_col} IN (${nameList})`;
  // Run via proxy SSH
  const fullCmd    = `${writeCmd} && ${uploadCmd} ; ${cleanCmd}`;

  const result = await runViaProxy(targetConn.proxyUrl, targetConn.proxyApiKey, target, authConfig, fullCmd, 180000);

  const uploadResult = {
    return_code: result.exitCode,
    stdout:      result.stdout?.slice(0, 50000),
    stderr:      result.stderr?.slice(0, 5000),
    duration_ms: result.durationMs,
  };

  // Write audit log — always, regardless of success
  await logFndloadAction({
    user_id:          req.user.id,
    user_email:       req.user.email,
    action:           'upload',
    source_conn_id:   sourceConn.id,
    source_conn_name: sourceConn.name,
    target_conn_id:   targetConn.id,
    target_conn_name: targetConn.name,
    object_type,
    lct_file:         typeDef.lct,
    object_names,
    diff_summary:     diff_summary || null,
    upload_result:    uploadResult,
    pre_state_ldt:    pre_state_ldt || null,
    success:          result.ok,
    error_message:    result.ok ? null : (result.stderr?.slice(0, 500) || 'Unknown error'),
  }).catch(() => {}); // non-critical — don't block response

  // Post-upload verification via SQL
  let verified = false;
  if (result.ok && sourceConn.connectionType === 'proxy' && targetConn.proxyUrl) {
    const verifyResult = await runSqlViaProxy(targetConn, verifySql).catch(() => null);
    if (verifyResult?.ok && (verifyResult.rows || []).length > 0) verified = true;
  }

  res.json({
    success:  result.ok,
    verified,
    output:   uploadResult,
    message:  result.ok
      ? `FNDLOAD UPLOAD completed successfully${verified ? ' — verified on target ✅' : '.'}`
      : `FNDLOAD UPLOAD failed (exit ${result.exitCode}). Check output below.`,
  });
});

// GET /api/ebs/fndload/history
router.get('/api/ebs/fndload/history', requireAuth, async (req, res) => {
  try {
    const rows = await getHistory(req.user.id, { limit: 30 });
    res.json({ history: rows });
  } catch (err) {
    console.error('[fndload] history error:', err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

module.exports = router;
