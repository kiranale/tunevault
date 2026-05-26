# TuneVault Security

## Activity Log Isolation Guarantee

The Activity Log (`/activity`, `/api/activity`) is strictly isolated per company. No user can ever see activity rows that belong to a different company, regardless of role.

### How it works

**Three independent layers prevent cross-tenant leakage:**

**Layer 1 — DB column filter (query time)**
Every `SELECT` on `activity_log` includes a `WHERE company_domain = $viewer_company_domain` condition. This is applied first, before any user-ID scoping, and cannot be removed by any query parameter. Rows written before the `company_domain` column existed (NULL) are treated as legacy and restricted to the writing user only.

**Layer 2 — User-ID ownership scoping (query time)**
Non-admin users get an additional `AND user_id = ANY($visible_ids)` clause. Individual users see only their own rows; team admins see rows for all members of their team (scoped to a single `team_id`, not joined across teams).

**Layer 3 — Serializer guard (response time)**
Before any JSON/CSV/PDF response is written, every row passes through `guardRows()`. Any row whose `company_domain` doesn't match the requesting user's domain is silently dropped and the mismatch is logged as an error. The `company_domain` field is then stripped from all outbound rows.

### Admin access

Platform admins (listed in `ADMIN_EMAILS` env var) are **still company-scoped** on the regular `/activity` route. They see all rows within their own company but cannot see rows from other companies.
Cross-company visibility (for platform support purposes) is only possible via `/admin/...` routes, which require both `requireAdmin` middleware and explicit admin context.

### What's logged

Every write to `activity_log` includes `company_domain` captured from `req.user.company_domain` at write time. The field is never user-supplied.

### Tests

`tests/unit-activity-isolation.js` — 18 unit tests, run with `node tests/unit-activity-isolation.js`.

Covers: company_domain WHERE clause always present, non-admin user-ID scoping, admin company-scope, NULL-domain legacy rows, serializer guard (pass/drop/strip), cross-tenant scenario, pagination clamping (limit, offset).

### Incident response

If `ISOLATION GUARD dropped N rows` appears in production logs, that indicates a query-layer bug where rows from another company reached the serializer. The guard prevented exposure. Treat as P0 and audit `db/activity-log.js` query construction immediately.
