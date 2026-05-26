# CI Required Status Checks

Configure these as required checks on the `main` branch in GitHub → Settings → Branches → Branch protection rules.

## Required checks

| Check name | Workflow file | Scope |
|---|---|---|
| `e2e / connections-smoke` | `.github/workflows/e2e-smoke.yml` | Boots app + Postgres in CI, runs Playwright smoke suite against /connections |
| `Architecture Rules` | `.github/workflows/architecture.yml` | Enforces server.js LOC cap, db/ encapsulation, no DDL in runtime files |
| `OL7 Gate (required)` | `.github/workflows/install-sh-ol7-gate.yml` | Installs agent in OL7 full-systemd container, asserts 8 journal milestones |

## How to add a required status check

1. Go to **GitHub → Settings → Branches → Branch protection rules** for `main`.
2. Enable **"Require status checks to pass before merging"**.
3. Click **"Add status check"** and type the exact check name from the table above.
4. Enable **"Require branches to be up to date before merging"**.
5. Save.

> The exact check name must match the `name:` field of the job in the workflow YAML, prefixed by the workflow name: `<workflow-name> / <job-name>`.
> Example: workflow `name: E2E Smoke — /connections tripwire`, job `name: connections-smoke` → check name is `connections-smoke` (GitHub uses just the job name).

## E2E smoke: required secrets

The `e2e-smoke.yml` workflow runs against a local Postgres service — no secrets needed for the CI variant.

The `e2e-post-deploy.yml` workflow runs against live `tunevault.app` — it requires:

| Secret name | Description |
|---|---|
| `E2E_SMOKE_SESSION_COOKIE` | Pre-baked `tv_session=<token>` cookie for the dedicated smoke-test admin account. Generate by logging in as `e2e-smoke@tunevault.internal` and copying the `tv_session` cookie value, prefixed with `tv_session=`. |
| `POSTMARK_SERVER_TOKEN` | Postmark server API token for ops failure alert emails. |
| `OPS_ALERT_EMAIL` | Recipient address for failure alerts (e.g. `ops@tunevault.app`). |

## Renewing E2E_SMOKE_SESSION_COOKIE

The `tv_session` cookie has a 30-day TTL. Set a calendar reminder to rotate it monthly:

1. Log in to `tunevault.app` as `e2e-smoke@tunevault.internal` (use magic-link flow).
2. Copy the `tv_session` cookie value from browser DevTools → Application → Cookies.
3. Update the `E2E_SMOKE_SESSION_COOKIE` secret: `tv_session=<new-value>`.

## Local development

Run the connections smoke suite locally against a running dev server:

```bash
# Mode 1: pre-baked cookie (if you have a valid session)
TEST_BASE_URL=http://localhost:3000 \
TEST_SESSION_COOKIE="tv_session=<your-cookie>" \
npx playwright test tests/e2e/connections.spec.ts

# Mode 2: mint a fresh token from SESSION_SECRET
TEST_BASE_URL=http://localhost:3000 \
SESSION_SECRET=your-dev-secret \
E2E_ADMIN_USER_ID=1 \
npx playwright test tests/e2e/connections.spec.ts
```

## What the connections smoke suite asserts

1. `GET /connections` returns 200 and the page shell renders.
2. Within 5s, loading spinner is gone and either the connections grid or empty-state is visible.
3. Delete button on a connection card opens the confirm modal (skipped if account has no connections).
4. `/dashboard#connections` has no in-page connections table (old section removed).
5. `GET /api/connections` returns 200 with a JSON array.

Total: 5 tests, ~6–8 assertions. Intentionally tight — this is a tripwire, not full regression coverage.
