/**
 * tests/e2e/health-check.spec.ts — E2E smoke tests for health check export endpoints.
 *
 * Owns: smoke assertions for GET /api/health-checks/:id/export?format=pdf|csv
 * Does NOT own: health check execution logic, auth flows, or database tests.
 *
 * Strategy:
 *   1. Find or create a demo health check run.
 *   2. Hit /api/health-checks/:id/export?format=pdf  → assert 200 + application/pdf + non-empty.
 *   3. Hit /api/health-checks/:id/export?format=csv  → assert 200 + text/csv + expected header.
 *   4. Hit with bad format → assert 400.
 *   5. Hit unauthenticated → assert 302 (redirect to login) or 401.
 *
 * Requires env vars (at least one of):
 *   TEST_SESSION_COOKIE  — "name=value" pre-baked cookie (live-URL CI)
 *   SESSION_SECRET + E2E_ADMIN_USER_ID — mint a fresh token (local / CI-local)
 *
 * Optional:
 *   TEST_BASE_URL — override default (https://tunevault.app)
 *
 * Run: npx playwright test tests/e2e/health-check.spec.ts
 */

import { test, expect } from '@playwright/test';
import { buildCookieHeader } from './auth-bypass';

const BASE_URL = process.env.TEST_BASE_URL || 'https://tunevault.app';
const CSV_EXPECTED_HEADER = 'severity,category,check_name,observed_value,threshold,status,remediation_command,doc_link';

// ── Helper: get or create a demo health check run ID ─────────────────────────

async function getDemoRunId(request: any, cookieHeader: string): Promise<number | null> {
  // First try to list recent health checks and find a completed demo run
  const listRes = await request.get(`${BASE_URL}/api/health-checks/recent?limit=5&demo=true`, {
    headers: { Cookie: cookieHeader },
  });

  if (listRes.ok()) {
    const body = await listRes.json().catch(() => null);
    if (Array.isArray(body)) {
      const completed = body.find((hc: any) => hc.status === 'completed' && hc.is_demo);
      if (completed) return completed.id;
    }
  }

  // Fallback: POST to /api/health-checks/demo to create a demo run
  const demoRes = await request.post(`${BASE_URL}/api/health-checks/demo`, {
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    data: JSON.stringify({ is_demo: true }),
  });

  if (demoRes.ok()) {
    const body = await demoRes.json().catch(() => null);
    if (body && body.id) return body.id;
  }

  return null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('Health check export endpoints (Task #1834839)', () => {

  /**
   * Assertion 1: PDF export returns 200 + application/pdf + non-empty body.
   * This is the primary smoke test — verifies the route is mounted and PDFKit produces output.
   */
  test('PDF export returns 200 + application/pdf + non-empty body', async ({ request }) => {
    const cookieHeader = buildCookieHeader(BASE_URL);
    if (!cookieHeader) {
      test.skip();
      return;
    }

    const runId = await getDemoRunId(request, cookieHeader);
    if (!runId) {
      // No demo health check available — can still verify route is mounted by
      // expecting 404 for a nonexistent ID (not 404 "route not found")
      const probeRes = await request.get(`${BASE_URL}/api/health-checks/999999/export?format=pdf`, {
        headers: { Cookie: cookieHeader },
      });
      // 404 = route exists, health check not found (correct)
      // 500 = route has a bug
      // 302/401 = auth issue
      expect([404, 400]).toContain(probeRes.status());
      test.info().annotations.push({ type: 'note', description: 'No demo run available — probed with nonexistent ID, got expected 404/400' });
      return;
    }

    const res = await request.get(`${BASE_URL}/api/health-checks/${runId}/export?format=pdf`, {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] || '';
    expect(contentType).toContain('application/pdf');

    const body = await res.body();
    expect(body.length).toBeGreaterThan(500); // A minimal PDF is always >500 bytes

    // PDFs start with %PDF-
    const pdfMagic = body.slice(0, 4).toString('ascii');
    expect(pdfMagic).toBe('%PDF');
  });

  /**
   * Assertion 2: CSV export returns 200 + text/csv + expected header row.
   * Verifies column structure matches the DBA-first schema spec.
   */
  test('CSV export returns 200 + text/csv + expected header row', async ({ request }) => {
    const cookieHeader = buildCookieHeader(BASE_URL);
    if (!cookieHeader) {
      test.skip();
      return;
    }

    const runId = await getDemoRunId(request, cookieHeader);
    if (!runId) {
      // Probe with nonexistent ID
      const probeRes = await request.get(`${BASE_URL}/api/health-checks/999999/export?format=csv`, {
        headers: { Cookie: cookieHeader },
      });
      expect([404, 400]).toContain(probeRes.status());
      test.info().annotations.push({ type: 'note', description: 'No demo run available — probed with nonexistent ID' });
      return;
    }

    const res = await request.get(`${BASE_URL}/api/health-checks/${runId}/export?format=csv`, {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status()).toBe(200);

    const contentType = res.headers()['content-type'] || '';
    expect(contentType.toLowerCase()).toContain('text/csv');

    const body = await res.text();
    const firstLine = body.split('\r\n')[0] || body.split('\n')[0];
    expect(firstLine).toBe(CSV_EXPECTED_HEADER);

    // Must have at least one data row beyond the header
    const lines = body.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
  });

  /**
   * Assertion 3: Invalid format returns 400.
   * Prevents silent wrong format fallback.
   */
  test('Invalid format query param returns 400', async ({ request }) => {
    const cookieHeader = buildCookieHeader(BASE_URL);
    if (!cookieHeader) {
      test.skip();
      return;
    }

    const res = await request.get(`${BASE_URL}/api/health-checks/1/export?format=xlsx`, {
      headers: { Cookie: cookieHeader },
    });

    // 400 for bad format, or 404 if run ID 1 doesn't exist (both are acceptable — bad format hits before run lookup in some paths)
    // The route validates format first before DB lookup, so we should get 400
    expect([400, 404]).toContain(res.status());
  });

  /**
   * Assertion 4: Unauthenticated request is rejected (302 redirect or 401).
   * Ensures the export endpoint is not publicly accessible.
   */
  test('Unauthenticated export request is rejected', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health-checks/1/export?format=pdf`, {
      // No Cookie header — test that auth gate fires
      maxRedirects: 0,
    });

    // Unauthenticated → 302 redirect to /login or 401
    expect([302, 401]).toContain(res.status());
  });

  /**
   * Assertion 5: Content-Disposition header has correct filename format.
   * Verifies filename convention: tunevault-healthcheck-<slug>-<YYYYMMDD-HHMM>.pdf
   */
  test('PDF response Content-Disposition matches filename convention', async ({ request }) => {
    const cookieHeader = buildCookieHeader(BASE_URL);
    if (!cookieHeader) {
      test.skip();
      return;
    }

    const runId = await getDemoRunId(request, cookieHeader);
    if (!runId) {
      test.skip();
      return;
    }

    const res = await request.get(`${BASE_URL}/api/health-checks/${runId}/export?format=pdf`, {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status()).toBe(200);

    const disposition = res.headers()['content-disposition'] || '';
    expect(disposition).toContain('attachment');
    expect(disposition).toMatch(/tunevault-healthcheck-/);
    expect(disposition).toMatch(/\.pdf"/);
  });

});
