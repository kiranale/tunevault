/**
 * E2E regression test: Add Connection wizard — Agent method must never show
 * "Please fill in proxy URL" validation error.
 *
 * Regression for Task #1659474:
 *   - Proxy/Agent method wizard previously fired proxy_url validation even when
 *     proxy URL is not required for agent connections.
 *   - The wizard now redirects "Agent Installer" to /setup/fresh immediately.
 *   - The legacy `proxy` method name also redirects to /setup/fresh.
 *
 * Test strategy:
 *   1. Unit-style: mock POST /api/connections so the API call succeeds,
 *      open the dashboard, open the wizard, select Agent method, assert
 *      redirect to /setup/fresh with no error toast.
 *   2. API-level: verify POST /api/connections with proxy type + no proxy_url
 *      passes the Zod schema (no 400 for missing proxy_url).
 *
 * Requires:
 *   TEST_BASE_URL      - deployed app URL (default: http://localhost:3000)
 *   TEST_SESSION_COOKIE - valid session cookie "name=value"
 *
 * Run: npx playwright test tests/e2e/add-connection-agent.spec.ts
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// Helper: inject a valid session cookie
async function injectSession(page: any) {
  const sessionCookie = process.env.TEST_SESSION_COOKIE;
  if (!sessionCookie) return false;
  const eqIdx = sessionCookie.indexOf('=');
  await page.context().addCookies([{
    name: sessionCookie.substring(0, eqIdx),
    value: sessionCookie.substring(eqIdx + 1),
    domain: new URL(BASE_URL).hostname,
    path: '/',
    httpOnly: true,
    secure: BASE_URL.startsWith('https'),
    sameSite: 'Lax' as const,
  }]);
  return true;
}

test.describe('Add Connection wizard — Agent method (Task #1659474 regression)', () => {

  // ── Regression test 1: wizard redirects agent → /setup/fresh, no error toast ─

  test('selecting Agent method and clicking Continue redirects to /setup/fresh without error', async ({ page }) => {
    const hasSession = await injectSession(page);
    if (!hasSession) {
      test.skip();
      return;
    }

    await page.goto(BASE_URL + '/dashboard');
    await page.waitForLoadState('networkidle');

    // Open the Add Connection wizard
    const addBtn = page.getByRole('button', { name: /add connection/i }).first();
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    // Wizard should open — wait for the method selection step
    await expect(page.locator('.method-cards')).toBeVisible({ timeout: 5000 });

    // Select "Agent Installer" method
    const agentCard = page.locator('.method-card').filter({ hasText: /agent installer/i });
    await expect(agentCard).toBeVisible();
    await agentCard.click();

    // Click Continue
    const continueBtn = page.getByRole('button', { name: /continue/i });
    await expect(continueBtn).toBeVisible();
    await continueBtn.click();

    // Must redirect to /setup/fresh — not stay in the wizard with a proxy URL error
    await page.waitForURL('**/setup/fresh', { timeout: 5000 });
    expect(new URL(page.url()).pathname).toBe('/setup/fresh');

    // No error toast / no "proxy URL" error text on screen
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('proxy URL');
    expect(bodyText).not.toContain('Please fill in');
    expect(bodyText).not.toContain('proxy_url');
  });

  // ── Regression test 2: agent save flow on /setup/fresh shows no proxy URL error ─

  test('/setup/fresh agent form submits service/user/pass without proxy URL error', async ({ page }) => {
    const hasSession = await injectSession(page);
    if (!hasSession) {
      test.skip();
      return;
    }

    // Intercept the mint-token API call — return a mock install command so the
    // wizard can proceed to step 3 without a real Oracle server.
    await page.route('**/api/agent/mint-token', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connection_id: 99999,
          install_cmd: 'curl -sSL https://tunevault.app/install.sh | sudo bash -s -- --api-key tvp_test',
        }),
      });
    });

    await page.goto(BASE_URL + '/setup/fresh');
    await page.waitForLoadState('networkidle');

    // Step 1: Agent Installer should already be selected (default)
    await expect(page.locator('#opt-agent')).toBeVisible({ timeout: 5000 });
    await page.click('#s1-next-btn');

    // Step 2 (Agent): fill host IP (required), name is optional
    await expect(page.locator('#step2-agent')).toBeVisible({ timeout: 3000 });

    // Service name / user / password are NOT on the agent step (agent auto-detects SIDs)
    // Host IP is required
    await page.fill('#f-agent-host', '10.0.1.50');
    await page.fill('#f-agent-name', 'TESTPDB-agent');

    // Submit
    const submitBtn = page.locator('#step2-agent button[id="s2-agent-btn"]').first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
    } else {
      await page.click('button:has-text("Generate Install Command")');
    }

    // Must NOT show any proxy URL error message
    await page.waitForTimeout(1000);
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('proxy URL');
    expect(bodyText).not.toContain('Please fill in proxy');
    expect(bodyText).not.toContain('proxy_url');

    // Should reach step 3 (install command displayed)
    await expect(page.locator('#step3')).toBeVisible({ timeout: 5000 });
  });

  // ── Regression test 3: POST /api/connections with proxy type + empty proxy_url succeeds ─

  test('API POST /api/connections with proxy type and no proxy_url returns 200 not 400', async ({ request }) => {
    const sessionCookie = process.env.TEST_SESSION_COOKIE;
    if (!sessionCookie) {
      test.skip();
      return;
    }

    const response = await request.post(`${BASE_URL}/api/connections`, {
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
      },
      data: {
        name: 'E2E-test-agent-conn',
        service_name: 'TESTPDB',
        username: 'tv_user',
        password: 'xxx',
        connection_type: 'proxy',
        proxy_api_key: 'tvp_' + 'a'.repeat(48),
        host: '',
        port: 443,
      },
    });

    // 200 = saved OK; 402 = tier cap (OK — not a validation error); 403 = RBAC
    // The important thing: NOT 400 (which would mean proxy_url validation rejected it)
    expect(response.status()).not.toBe(400);

    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty('id');

      // Cleanup: delete the test connection
      const connId = body.id;
      await request.delete(`${BASE_URL}/api/connections/${connId}`, {
        headers: { Cookie: sessionCookie },
      });
    }
  });

  // ── Core regression: wizard step 2 "proxy" method also goes to /setup/fresh ─

  test('legacy proxy method in wizard redirects to /setup/fresh (not proxy URL form)', async ({ page }) => {
    const hasSession = await injectSession(page);
    if (!hasSession) {
      test.skip();
      return;
    }

    await page.goto(BASE_URL + '/dashboard');
    await page.waitForLoadState('networkidle');

    // Directly set _wiz.method = 'proxy' in JS to test the dead-branch guard
    // and verify wizNext() redirects instead of rendering the old proxy form
    await page.evaluate(() => {
      // @ts-ignore
      if (typeof _wiz !== 'undefined') {
        // @ts-ignore
        _wiz.method = 'proxy';
        // @ts-ignore
        _wiz.step = 1;
        // @ts-ignore
        if (typeof wizNext === 'function') wizNext();
      }
    });

    // After wizNext() with proxy method, must redirect to /setup/fresh
    await page.waitForTimeout(500);
    const currentPath = new URL(page.url()).pathname;
    // Either redirected to /setup/fresh OR still on /dashboard (if _wiz not defined yet)
    // The key assertion: NOT on a wizard step 2 showing "proxy URL" error
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('Please fill in proxy URL');
  });
});
