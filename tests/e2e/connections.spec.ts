/**
 * connections.spec.ts — E2E tripwire: /connections page must render and be functional.
 *
 * Owns: smoke assertions for the /connections page — load time, empty/populated state,
 *       delete button binding, confirm modal visibility, and /dashboard#connections cleanup.
 * Does NOT own: full CRUD regression, API contract tests, or auth flow tests.
 *
 * Tripwire goal: catch "page shipped broken" silent failures (Task #1831419).
 * ~6–8 tight assertions. No flaky waits.
 *
 * Requires env vars (at least one of):
 *   TEST_SESSION_COOKIE  — "name=value" pre-baked cookie (live-URL CI)
 *   SESSION_SECRET + E2E_ADMIN_USER_ID — mint a fresh token (local / CI-local)
 *
 * Optional:
 *   TEST_BASE_URL — override default (https://tunevault.app)
 *
 * Run: npx playwright test tests/e2e/connections.spec.ts
 */

import { test, expect } from '@playwright/test';
import { injectAdminSession, buildCookieHeader } from './auth-bypass';

const BASE_URL = process.env.TEST_BASE_URL || 'https://tunevault.app';

// ── Shared setup ────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }, testInfo) => {
  const ok = await injectAdminSession(page, BASE_URL);
  if (!ok) {
    testInfo.skip();
  }
});

// ── Test suite ───────────────────────────────────────────────────────────────

test.describe('/connections page smoke tests (Task #1831419)', () => {

  /**
   * Assertion 1: GET /connections returns 200 and the shell renders.
   * Verifies the route is mounted, auth gate works with our cookie, and the
   * base DOM skeleton (header + page-wrap) is present.
   */
  test('GET /connections returns 200 and shell renders', async ({ page }) => {
    const response = await page.goto(BASE_URL + '/connections');
    expect(response?.status()).toBe(200);

    // Shell elements must be present immediately (no async load needed)
    await expect(page.locator('.page-wrap')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#btn-add')).toBeVisible({ timeout: 3000 });
  });

  /**
   * Assertion 2: Within 5s, either a connections grid with ≥1 row OR the empty-state
   * element is visible. "Loading servers…" must NOT still be on screen after 5s.
   *
   * This is the primary tripwire — if JS fails to execute or the API 500s,
   * this assertion catches it.
   */
  test('page resolves loading state within 5s — shows grid or empty state', async ({ page }) => {
    await page.goto(BASE_URL + '/connections');

    // Wait for the loading spinner to disappear (loadingState hidden by JS)
    await expect(page.locator('[data-testid="connections-loading"]')).toBeHidden({ timeout: 5000 });

    // After loading: exactly ONE of these must be visible — grid or empty state
    const grid = page.locator('[data-testid="connections-grid"]');
    const emptyState = page.locator('[data-testid="connections-empty"]');

    // Use a race: whichever becomes visible first wins
    const gridVisible = await grid.isVisible();
    const emptyVisible = await emptyState.isVisible();

    // At least one must be showing
    expect(gridVisible || emptyVisible).toBe(true);

    // Verify "Loading servers…" text is gone
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('Loading servers…');
  });

  /**
   * Assertion 3: If there are connections in the grid, the Delete button on at least
   * one row has a click handler that opens the confirm modal.
   *
   * If the page shows the empty state instead, this test is a soft pass — we skip
   * the interaction check rather than fail on a legitimately empty test account.
   */
  test('Delete button opens confirm modal (skipped if empty state)', async ({ page }) => {
    await page.goto(BASE_URL + '/connections');

    // Wait for load to complete
    await expect(page.locator('[data-testid="connections-loading"]')).toBeHidden({ timeout: 5000 });

    const emptyState = page.locator('[data-testid="connections-empty"]');
    const isEmptyState = await emptyState.isVisible();

    if (isEmptyState) {
      // No connections to test delete on — acceptable for a dedicated smoke account
      // that has no connections yet. Test passes (empty state is valid).
      test.info().annotations.push({ type: 'note', description: 'Empty state shown — delete modal test skipped (no connections)' });
      return;
    }

    // Grid has connections — find the first visible Delete button
    // card-btn.danger = Delete button on a non-removed card
    const deleteBtn = page.locator('.card-btn.danger').first();
    await expect(deleteBtn).toBeVisible({ timeout: 3000 });

    // Click the delete button
    await deleteBtn.click();

    // The confirm modal must open (gets class 'open' added)
    const modal = page.locator('[data-testid="delete-confirm-modal"]');
    await expect(modal).toHaveClass(/open/, { timeout: 2000 });

    // Modal must contain a visible Cancel button and a Delete button
    await expect(modal.locator('button:has-text("Cancel")')).toBeVisible();
    await expect(modal.locator('#btn-confirm-delete')).toBeVisible();

    // Close the modal without deleting anything
    await modal.locator('button:has-text("Cancel")').click();
    await expect(modal).not.toHaveClass(/open/, { timeout: 1000 });
  });

  /**
   * Assertion 4: /dashboard#connections must NOT show an in-page connections table.
   * The old #connections tab has been removed from the dashboard. Visiting that URL
   * should land on the dashboard page without a connections grid section.
   *
   * The server-side route for /dashboard simply serves dashboard.html — no 301.
   * We verify the response is 200 (not a broken 4xx) and that the page does NOT
   * contain the old in-page connections table markup.
   */
  test('/dashboard#connections has no in-page connections section', async ({ page }) => {
    const response = await page.goto(BASE_URL + '/dashboard#connections');
    // Dashboard route must be alive
    expect(response?.status()).toBe(200);

    // Wait for page to stabilise
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {
      // networkidle timeout is non-fatal — page may have long-poll open
    });

    // The old in-page connections section used id="connections" or data-tab="connections".
    // It must be absent. If the section exists, the old code shipped.
    const oldConnectionsSection = page.locator('#connections, [data-tab="connections"]');
    await expect(oldConnectionsSection).toHaveCount(0, { timeout: 2000 });

    // The old table that held server rows was #connections-table or .connections-list.
    // Verify it is gone.
    const oldTable = page.locator('#connections-table, .connections-list');
    await expect(oldTable).toHaveCount(0, { timeout: 1000 });
  });

  /**
   * Assertion 5 (API-level): GET /api/connections returns 200 with a JSON array.
   * Verifies the backend API is wired, auth gate works, and response shape is correct.
   */
  test('GET /api/connections returns 200 JSON array', async ({ request }) => {
    const cookieHeader = buildCookieHeader(BASE_URL);
    if (!cookieHeader) {
      test.skip();
      return;
    }

    const response = await request.get(`${BASE_URL}/api/connections`, {
      headers: { Cookie: cookieHeader },
    });

    expect(response.status()).toBe(200);

    const body = await response.json();
    // Must be an array (may be empty for a fresh smoke-test account)
    expect(Array.isArray(body)).toBe(true);
  });

});
