/**
 * auth-bypass.ts — E2E test helper: mint an admin session cookie without the email
 * magic-link flow.
 *
 * Owns: producing a valid tv_session cookie for tests.
 * Does NOT own: actual auth business logic (lives in server.js createToken()).
 *
 * Usage in Playwright specs:
 *   import { injectAdminSession } from './auth-bypass';
 *   await injectAdminSession(page, BASE_URL);
 *
 * Requires env vars:
 *   SESSION_SECRET   — must match the running server's SESSION_SECRET
 *   E2E_ADMIN_USER_ID — numeric user ID of the smoke-test admin account in the DB
 *                       (defaults to '1' for local dev convenience)
 *
 * For CI against live tunevault.app, set TEST_SESSION_COOKIE instead. When that env
 * var is set, injectAdminSession() reads it directly (no need to know SESSION_SECRET).
 */

import * as crypto from 'crypto';
import type { Page, BrowserContext } from '@playwright/test';

const COOKIE_NAME = 'tv_session';

/**
 * Build a signed session token using the same HMAC-SHA256 scheme as server.js createToken().
 * Only used when SESSION_SECRET is available (local/CI-local mode).
 */
function mintToken(userId: number, secret: string): string {
  const payload = JSON.stringify({ userId, iat: Date.now() });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/**
 * Inject an authenticated session cookie into a Playwright page or context.
 *
 * Priority order:
 *   1. TEST_SESSION_COOKIE env var ("name=value" format) — used for live-URL smoke tests
 *      where SESSION_SECRET is not available in CI.
 *   2. SESSION_SECRET + E2E_ADMIN_USER_ID — mint a fresh token locally.
 *
 * Returns true if injection succeeded, false if neither env var was available
 * (callers should test.skip() in that case).
 */
export async function injectAdminSession(
  pageOrContext: Page | BrowserContext,
  baseUrl: string,
): Promise<boolean> {
  // Mode 1: pre-baked cookie from CI secrets (live-URL tests)
  const prebakedCookie = process.env.TEST_SESSION_COOKIE;
  if (prebakedCookie) {
    const eqIdx = prebakedCookie.indexOf('=');
    if (eqIdx > 0) {
      const name = prebakedCookie.substring(0, eqIdx);
      const value = prebakedCookie.substring(eqIdx + 1);
      const ctx = 'addCookies' in pageOrContext
        ? pageOrContext
        : (pageOrContext as Page).context();
      await (ctx as BrowserContext).addCookies([{
        name,
        value,
        domain: new URL(baseUrl).hostname,
        path: '/',
        httpOnly: true,
        secure: baseUrl.startsWith('https'),
        sameSite: 'Lax',
      }]);
      return true;
    }
  }

  // Mode 2: mint a fresh token using SESSION_SECRET (local/CI-local mode)
  const secret = process.env.SESSION_SECRET;
  const userId = parseInt(process.env.E2E_ADMIN_USER_ID || '1', 10);
  if (!secret) {
    return false; // caller must test.skip()
  }

  const token = mintToken(userId, secret);
  const ctx = 'addCookies' in pageOrContext
    ? pageOrContext
    : (pageOrContext as Page).context();
  await (ctx as BrowserContext).addCookies([{
    name: COOKIE_NAME,
    value: token,
    domain: new URL(baseUrl).hostname,
    path: '/',
    httpOnly: true,
    secure: baseUrl.startsWith('https'),
    sameSite: 'Lax',
  }]);
  return true;
}

/**
 * Returns the raw cookie string in "name=value" format, suitable for
 * passing as a Cookie: header in APIRequestContext calls.
 */
export function buildCookieHeader(baseUrl: string): string | null {
  const prebakedCookie = process.env.TEST_SESSION_COOKIE;
  if (prebakedCookie) return prebakedCookie;

  const secret = process.env.SESSION_SECRET;
  const userId = parseInt(process.env.E2E_ADMIN_USER_ID || '1', 10);
  if (!secret) return null;

  return `${COOKIE_NAME}=${mintToken(userId, secret)}`;
}
