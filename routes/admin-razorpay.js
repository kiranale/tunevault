/**
 * routes/admin-razorpay.js — Razorpay test-key validation + live deployment pipeline.
 *
 * Owns: validating new Razorpay test keys, probing the Razorpay API to confirm they work,
 *       updating the server environment via Polsia infra API, and polling until the deploy is live.
 * Does NOT own: production checkout flow, payment pipeline tests, order/subscription CRUD.
 *
 * Mounted at: /api/admin/razorpay (see server.js)
 */

'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

// Polsia infra API — used to update env vars and trigger redeploy
const POLSIA_API_TOKEN   = process.env.POLSIA_API_TOKEN || process.env.POLSIA_API_KEY || '';
const POLSIA_INSTANCE_ID = '29347'; // TuneVault instance

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Call an HTTP(S) URL and return { statusCode, body }.
 * Handles both http and https, streams body, rejects on error.
 */
function httpRequest(url, options, requestBody) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http;
    const reqOpts  = {
      hostname: parsed.hostname,
      port    : parsed.port || (isHttps ? 443 : 80),
      path    : parsed.pathname + (parsed.search || ''),
      method  : options.method || 'GET',
      headers : options.headers || {},
    };

    const req = lib.request(reqOpts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });

    req.on('error', reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

/**
 * Probe Razorpay with a ₹1 test order to confirm a key pair is valid.
 * Returns { ok: true } or { ok: false, statusCode, error } with Razorpay's raw error details.
 */
async function probeRazorpay(keyId, keySecret) {
  const body    = JSON.stringify({ amount: 100, currency: 'INR', receipt: `tv_keytest_${Date.now()}` });
  const basic   = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${basic}`,
    'Content-Type' : 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };

  try {
    const { statusCode, body: raw } = await httpRequest(
      'https://api.razorpay.com/v1/orders',
      { method: 'POST', headers },
      body
    );

    if (statusCode === 200 || statusCode === 201) {
      const parsed = JSON.parse(raw);
      return { ok: true, orderId: parsed.id };
    }

    // Surface the exact Razorpay error — never swallow it
    let errPayload = {};
    try { errPayload = JSON.parse(raw); } catch {}
    const desc   = errPayload?.error?.description || errPayload?.description || raw.slice(0, 200);
    const reason = errPayload?.error?.reason      || '';
    const code   = errPayload?.error?.code        || errPayload?.code || '';
    return { ok: false, statusCode, description: desc, reason, code, raw };

  } catch (netErr) {
    return { ok: false, statusCode: 0, description: `Network error: ${netErr.message}`, reason: 'network_error', code: '' };
  }
}

/**
 * Update env vars on the Polsia instance via the infra API.
 * Returns { ok: true } or { ok: false, error }.
 */
async function updatePolsiaEnv(keyId, keySecret) {
  if (!POLSIA_API_TOKEN) {
    return { ok: false, error: 'POLSIA_API_TOKEN not configured on this server' };
  }

  const payload = JSON.stringify({
    instance_id: parseInt(POLSIA_INSTANCE_ID, 10),
    env_vars: {
      RAZORPAY_TEST_KEY_ID    : keyId,
      RAZORPAY_TEST_KEY_SECRET: keySecret,
    }
  });

  try {
    const { statusCode, body } = await httpRequest(
      'https://polsia.com/api/infra/update-env-vars',
      {
        method : 'POST',
        headers: {
          'Authorization': `Bearer ${POLSIA_API_TOKEN}`,
          'Content-Type' : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }
      },
      payload
    );

    if (statusCode >= 200 && statusCode < 300) return { ok: true };
    let errBody = body;
    try { errBody = JSON.stringify(JSON.parse(body)); } catch {}
    return { ok: false, error: `Polsia API HTTP ${statusCode}: ${errBody.slice(0, 200)}` };

  } catch (err) {
    return { ok: false, error: `Network error calling Polsia API: ${err.message}` };
  }
}

/**
 * Trigger a Polsia redeploy via their infra API.
 */
async function triggerPolsiaDeploy() {
  if (!POLSIA_API_TOKEN) return { ok: false, error: 'POLSIA_API_TOKEN not configured' };

  const payload = JSON.stringify({ instance_id: parseInt(POLSIA_INSTANCE_ID, 10) });

  try {
    const { statusCode, body } = await httpRequest(
      'https://polsia.com/api/infra/push-to-remote',
      {
        method : 'POST',
        headers: {
          'Authorization': `Bearer ${POLSIA_API_TOKEN}`,
          'Content-Type' : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }
      },
      payload
    );

    if (statusCode >= 200 && statusCode < 300) return { ok: true };
    return { ok: false, error: `Polsia deploy API HTTP ${statusCode}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: `Network error triggering deploy: ${err.message}` };
  }
}

/**
 * Poll our own status-test endpoint until testConfigured is true or timeout.
 * Up to 20 polls with 15s delay = ~5 min window.
 * Returns { ok: true } or { ok: false, reason }.
 */
async function pollUntilLive(expectedKeyPrefix, maxAttempts = 20, intervalMs = 15000) {
  const appUrl = process.env.APP_URL || 'https://tunevault.app';

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const { statusCode, body } = await httpRequest(
        `${appUrl}/api/admin/payment-test/status-test`,
        { method: 'GET', headers: { 'Accept': 'application/json' } }
      );

      if (statusCode === 200) {
        const data = JSON.parse(body);
        if (data.testConfigured && data.valid && data.key_id === expectedKeyPrefix) {
          return { ok: true, attempts: i + 1 };
        }
        // Deploy hasn't picked up the new env vars yet — keep polling
      }
    } catch {} // network hiccup — keep polling
  }

  return { ok: false, reason: 'Deploy did not reach live state within timeout', attempts: maxAttempts };
}

// ─── POST /api/admin/razorpay/set-test-keys ───────────────────────────────────
// Full pipeline: validate → probe → update env → redeploy → assert.
// Body: { keyId: string, keySecret: string }
// Returns streaming JSON or a final { steps: [...], success: bool } response.

router.post('/set-test-keys', requireAdmin, async (req, res) => {
  const { keyId, keySecret } = req.body;
  const steps = [];

  function step(name, status, detail) {
    const s = { name, status, detail: detail || null };
    steps.push(s);
    return s;
  }

  // ── STEP 1: Format validation ──────────────────────────────────────────────
  const trimmedId     = (keyId || '').trim().replace(/[\r\n]/g, '');
  const trimmedSecret = (keySecret || '').trim().replace(/[\r\n]/g, '');

  if (!trimmedId.startsWith('rzp_test_')) {
    step('format_validation', 'fail', 'Key ID must start with rzp_test_');
    return res.status(400).json({ success: false, steps });
  }
  if (trimmedSecret.length < 8) {
    step('format_validation', 'fail', 'Key Secret appears too short — check you copied it correctly');
    return res.status(400).json({ success: false, steps });
  }
  step('format_validation', 'pass', `Key ID starts with rzp_test_ (${trimmedId.slice(0, 16)}…). Secret length ${trimmedSecret.length} chars.`);

  // ── STEP 2: Probe Razorpay ─────────────────────────────────────────────────
  console.log(`[admin-razorpay] set-test-keys: probing Razorpay with key ${trimmedId.slice(0, 16)}... by ${req.user.email}`);
  const probe = await probeRazorpay(trimmedId, trimmedSecret);

  if (!probe.ok) {
    const detail = [
      probe.description && `description: ${probe.description}`,
      probe.reason      && `reason: ${probe.reason}`,
      probe.code        && `code: ${probe.code}`,
      probe.statusCode  && `HTTP: ${probe.statusCode}`,
    ].filter(Boolean).join(' | ');

    step('razorpay_probe', 'fail', detail || 'Razorpay rejected the key pair');
    return res.status(400).json({ success: false, steps });
  }
  step('razorpay_probe', 'pass', `Test order created: ${probe.orderId}`);

  // ── STEP 3: Update env vars via Polsia infra API ───────────────────────────
  // If POLSIA_API_TOKEN is absent, skip deployment and return partial success.
  // The operator must update env vars manually in that case.
  if (!POLSIA_API_TOKEN) {
    step('env_update', 'skipped',
      'POLSIA_API_TOKEN not set on this server. Update RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET manually in your Render/Polsia dashboard, then redeploy.');
    step('deploy', 'skipped', 'Manual redeploy required — see above.');
    step('status_assert', 'skipped', 'Will be verified after your manual redeploy.');
    return res.json({ success: false, partial: true, steps });
  }

  const envResult = await updatePolsiaEnv(trimmedId, trimmedSecret);
  if (!envResult.ok) {
    step('env_update', 'fail', envResult.error);
    return res.status(500).json({ success: false, steps });
  }
  step('env_update', 'pass', 'RAZORPAY_TEST_KEY_ID and RAZORPAY_TEST_KEY_SECRET updated on Polsia instance 29347');

  // ── STEP 4: Trigger redeploy ───────────────────────────────────────────────
  const deployResult = await triggerPolsiaDeploy();
  if (!deployResult.ok) {
    step('deploy', 'warn', `Deploy trigger returned error: ${deployResult.error}. The env vars were saved — redeploy manually if needed.`);
    // Don't fail hard — env vars are already updated
    step('status_assert', 'skipped', 'Redeploy may be in progress. Refresh this page in 3-5 minutes.');
    return res.json({ success: false, partial: true, steps });
  }
  step('deploy', 'pass', 'Redeploy triggered. Polling for live state…');

  // ── STEP 5: Poll until the new keys are live ───────────────────────────────
  // We return a 202 immediately here so the UI doesn't time out — the frontend
  // should poll /api/admin/payment-test/status-test until testConfigured is true.
  // But we also run a blocking poll here for up to 5 attempts (75s) for fast cases.
  const quickPoll = await pollUntilLive(trimmedId, 5, 15000);

  if (quickPoll.ok) {
    step('status_assert', 'pass', `New test keys are live after ${quickPoll.attempts} poll(s). Deploy complete.`);
    return res.json({ success: true, steps });
  }

  // Fast poll didn't converge — deploy is still in progress
  step('status_assert', 'pending',
    'Deploy is still rolling out. Poll /api/admin/payment-test/status-test every 15s until testConfigured:true appears. Usually completes within 3-5 minutes.');
  return res.json({ success: false, partial: true, steps });
});

// ─── GET /api/admin/razorpay/test-key-status ──────────────────────────────────
// Quick auth-gated check of current test key configuration (used by the deploy poller).
router.get('/test-key-status', requireAdmin, (req, res) => {
  const id     = process.env.RAZORPAY_TEST_KEY_ID     || '';
  const secret = process.env.RAZORPAY_TEST_KEY_SECRET || '';
  const valid  = id.startsWith('rzp_test_') && secret.length >= 8;
  res.json({
    testConfigured: valid,
    keyId         : id ? `${id.slice(0, 16)}…` : null,
    mode          : valid ? 'TEST' : null,
  });
});

module.exports = router;
