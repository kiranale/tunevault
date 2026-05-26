/**
 * E2E regression test: logged-in user clicks 'Open Dashboard' → stays on /dashboard.
 *
 * Covers the regression from Task #1513900 where hero CTA sent authed users to
 * /dashboard?demo=1, which auto-ran a demo and redirected to /report/{id}.
 *
 * Requires:
 *   TEST_BASE_URL  - deployed app URL (default: https://tunevault.app)
 *   TEST_USER_EMAIL - test account email
 *   TEST_USER_PASSWORD - test account password (or set up magic-link session cookie)
 *
 * Run: npx playwright test tests/dashboard-no-redirect.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.TEST_BASE_URL || 'https://tunevault.app';

test.describe('Dashboard no-redirect regression', () => {
  test('logged-in user clicking Open Dashboard stays on /dashboard', async ({ page }) => {
    // Simulate a logged-in session by navigating to the app with a valid session cookie.
    // The test relies on TEST_SESSION_COOKIE being set in CI (a pre-baked session cookie
    // for a dedicated test account with existing health checks so _autoRunDemo never fires).
    const sessionCookie = process.env.TEST_SESSION_COOKIE;
    if (!sessionCookie) {
      test.skip('TEST_SESSION_COOKIE not set — skipping authenticated test');
      return;
    }

    // Parse cookie string "name=value" into name/value parts
    const eqIdx = sessionCookie.indexOf('=');
    const cookieName = sessionCookie.substring(0, eqIdx);
    const cookieValue = sessionCookie.substring(eqIdx + 1);

    await page.context().addCookies([{
      name: cookieName,
      value: cookieValue,
      domain: new URL(BASE_URL).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);

    // Visit the landing page
    await page.goto(BASE_URL + '/');

    // Wait for nav auth to resolve (nav-component fetches /api/auth/me)
    await page.waitForFunction(() => {
      const navRight = document.querySelector('.nav-right');
      return navRight && navRight.style.opacity === '1';
    }, { timeout: 10000 });

    // The hero CTA for logged-in users should say "Open Dashboard" or "Run Health Check"
    // and point to /dashboard (not /dashboard?demo=1)
    const heroCta = page.locator('a.hero-cta').first();
    await expect(heroCta).toBeVisible();
    const href = await heroCta.getAttribute('href');
    expect(href).toBe('/dashboard');
    expect(href).not.toContain('demo=1');

    // Click it
    await heroCta.click();

    // Wait 3 seconds for any auto-redirect to fire
    await page.waitForTimeout(3000);

    // Must still be on /dashboard
    expect(new URL(page.url()).pathname).toBe('/dashboard');
  });

  test('visiting /dashboard?demo=1 as returning user stays on /dashboard', async ({ page }) => {
    const sessionCookie = process.env.TEST_SESSION_COOKIE;
    if (!sessionCookie) {
      test.skip('TEST_SESSION_COOKIE not set — skipping authenticated test');
      return;
    }

    const eqIdx = sessionCookie.indexOf('=');
    const cookieName = sessionCookie.substring(0, eqIdx);
    const cookieValue = sessionCookie.substring(eqIdx + 1);

    await page.context().addCookies([{
      name: cookieName,
      value: cookieValue,
      domain: new URL(BASE_URL).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);

    // Navigate directly to the problematic URL
    await page.goto(BASE_URL + '/dashboard?demo=1');

    // ?demo=1 param should be stripped immediately (history.replaceState)
    await page.waitForFunction(() => !window.location.search.includes('demo=1'), { timeout: 2000 });

    // Wait 3 seconds for any deferred redirect to fire
    await page.waitForTimeout(3000);

    // Must still be on /dashboard — no redirect to /report/*
    expect(new URL(page.url()).pathname).toBe('/dashboard');
  });

  test('demo-preview-cta href is /dashboard when logged in', async ({ page }) => {
    const sessionCookie = process.env.TEST_SESSION_COOKIE;
    if (!sessionCookie) {
      test.skip('TEST_SESSION_COOKIE not set — skipping authenticated test');
      return;
    }

    const eqIdx = sessionCookie.indexOf('=');
    const cookieName = sessionCookie.substring(0, eqIdx);
    const cookieValue = sessionCookie.substring(eqIdx + 1);

    await page.context().addCookies([{
      name: cookieName,
      value: cookieValue,
      domain: new URL(BASE_URL).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);

    await page.goto(BASE_URL + '/');

    // Wait for nav auth to resolve
    await page.waitForFunction(() => {
      const navRight = document.querySelector('.nav-right');
      return navRight && navRight.style.opacity === '1';
    }, { timeout: 10000 });

    // The "See what a real report looks like" link must not have ?demo=1 for authed users
    const previewCta = page.locator('a.demo-preview-cta');
    await expect(previewCta).toBeVisible();
    const href = await previewCta.getAttribute('href');
    expect(href).toBe('/dashboard');
    expect(href).not.toContain('demo=1');
  });
});
