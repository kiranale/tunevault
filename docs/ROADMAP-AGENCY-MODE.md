# Roadmap: Agency / Multi-Tenant Mode

**Status:** Deferred — resurfaces when `paying_customers_count >= 5` or `show_agency_reminder` flag is on
**Filed:** 2026-05-11
**Origin:** Owner question — "will MSPs and Oracle consulting firms take TuneVault? Should login be different for agency use?"

---

## Problem Statement

MSPs, DBA consulting firms, and Oracle service partners manage dozens of client databases across separate organisations. Today TuneVault assumes **one account = one customer's databases**. An agency onboarding Client A (5 instances), Client B (12 instances), Client C, etc. has no way to:

- Isolate client data from each other
- Share a single login across all clients
- Pool or allocate check credits per client
- White-label PDF reports with a client's logo
- Let individual clients view their own results without seeing others'

The current model breaks at the first real agency sale. This doc captures the design options so we don't start from scratch when that moment arrives.

---

## Design Options

| Option | Description | Isolation | Eng Lift | Billing |
|--------|-------------|-----------|----------|---------|
| **a) Single account, tagged connections** | Agency adds all connections to one account; tags them by client name | None — all visible together | ~1 day | No per-client billing possible |
| **b) Workspaces inside one account** ⭐ | One login for agency; switch workspace per client; per-workspace credit pools and reports | Good — data scoped to workspace | ~2 weeks | Per-workspace credit pools; agency pays parent invoice |
| **c) Per-client sub-accounts with parent billing** | Each client gets their own login/account if they want; agency has admin cross-view | Strong — full account isolation | ~4–6 weeks | Parent invoice to agency; optional client visibility |
| **d) Enterprise tier with SSO + RBAC** | SAML, role-based access, audit logs; each member has scoped permissions | Strongest | ~8–12 weeks | Enterprise contract; not self-serve |

---

## Recommendation

**Start with (b) Workspaces as a paid add-on.**

- Pricing: **$199+/mo Agency Tier** — includes 5 workspaces + 100 checks/month pooled; $20/workspace beyond 5
- When the first real MSP customer commits, upgrade to (c) per-client sub-accounts with the workspace scaffold already in place
- SSO (d) is only justified when an enterprise contract is on the table — don't build it speculatively

---

## Login Model

- Agency owner uses **single login** (Google OAuth or magic link)
- Owner can **invite per-client read-only users** via email-based magic links scoped to a specific workspace
- No SSO until enterprise tier (option d)
- UI shows a workspace switcher in the nav once the account has >1 workspace

---

## Billing Model

- Agency pays **one parent invoice** (Razorpay subscription at the Agency Tier rate)
- Each workspace has its own check credit pool (allocated on workspace creation)
- Agency owner can redistribute credits between workspaces
- **White-label option**: agency uploads a client logo per workspace; PDF reports substitute TuneVault branding with the client's logo + agency's name in the footer — charged as add-on ($29/mo per workspace)

---

## Data Isolation

- Add `workspace_id UUID NOT NULL` column to: `oracle_connections`, `health_checks`, `check_results`, `health_check_requests`
- Every query in every route that touches these tables gets a `WHERE workspace_id = $workspace` guard enforced in middleware
- Default workspace = `users.default_workspace_id` (set at signup, backward-compatible)
- Phase 2: per-workspace encryption keys (KMS or envelope encryption on stored credentials) — not required for launch

---

## What to Build First (When Triggered)

**Estimated effort: ~2 weeks of engineering**

1. **`workspaces` table** — `id`, `owner_user_id`, `name`, `slug`, `logo_url`, `checks_remaining`, `plan_tier`, `created_at`
2. **`workspace_users` join table** — `workspace_id`, `user_id`, `role` (owner/member/viewer), `invited_at`, `accepted_at`
3. **Workspace middleware** — resolves `workspace_id` from session cookie; rejects requests that try to access cross-workspace data
4. **UI workspace switcher** — dropdown in nav; workspace creation flow; invite-by-email (magic link, scoped to workspace)
5. **Billing integration** — Agency Tier subscription plan in Razorpay; workspace quota management
6. **PDF white-label** — logo upload to R2; substitution in `pdf-generator.js`

Seed data: one default workspace per existing user (migration, backward-compatible).

---

## Open Questions (Answer Before Building)

- Should a client invited as a viewer be able to initiate new health checks, or only view results?
- When an agency pauses a workspace, do scheduled checks keep running?
- If a client wants to "graduate" to their own TuneVault account, what's the data export/handoff flow?
