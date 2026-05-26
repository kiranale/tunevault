# TuneVault

**Oracle Database + EBS Operations platform.** Connects to Oracle databases via Direct TCP or a lightweight HTTP proxy agent and runs 200+ health checks across 15 categories. Results are displayed in a 9-tab dashboard with PDF/XLSX export, AI-generated summaries, autonomous monitoring, and EBS-native operations.

Live: [tunevault.app](https://tunevault.app)

[![E2E Smoke](https://github.com/Polsia-Inc/tunevault/actions/workflows/e2e-smoke.yml/badge.svg)](https://github.com/Polsia-Inc/tunevault/actions/workflows/e2e-smoke.yml)
[![OL7 Gate](https://github.com/Polsia-Inc/tunevault/actions/workflows/install-sh-ol7-gate.yml/badge.svg)](https://github.com/Polsia-Inc/tunevault/actions/workflows/install-sh-ol7-gate.yml)
[![Architecture Rules](https://github.com/Polsia-Inc/tunevault/actions/workflows/architecture.yml/badge.svg)](https://github.com/Polsia-Inc/tunevault/actions/workflows/architecture.yml)

---

## Tech Stack

- **Backend:** Node.js + Express (single `server.js` entry point, modular `routes/`)
- **Database:** PostgreSQL via [Neon](https://neon.tech) — migrations in `migrations/`
- **Frontend:** Vanilla JS + HTML (no build step) in `public/`
- **Oracle connectivity:** `oracledb` for direct TCP; lightweight proxy binary for agent-based connections
- **Auth:** Google OAuth + magic-link email (session cookies)
- **Payments:** Razorpay (one-time + monthly subscriptions)
- **AI:** OpenAI via Polsia proxy (health check summaries, SQL tuning recommendations)
- **Hosting:** Render (single web service)

---

## Local Development

### Prerequisites

- Node.js 18+
- PostgreSQL database (Neon connection string)
- Oracle Instant Client (for `oracledb` — see [oracle-client setup](public/docs/oracle-setup.html))

### Environment Variables

```
DATABASE_URL=          # Neon PostgreSQL connection string (required)
SESSION_SECRET=        # Cookie signing secret (required in production)
ENCRYPTION_KEY=        # AES-256 key for credential encryption (required in production)
GOOGLE_CLIENT_ID=      # Google OAuth client ID
GOOGLE_CLIENT_SECRET=  # Google OAuth client secret
OPENAI_API_KEY=        # Polsia OpenAI proxy key
RAZORPAY_KEY_ID=       # Razorpay live key
RAZORPAY_KEY_SECRET=   # Razorpay live secret
PORT=3000              # Default port
```

### Run

```bash
npm install
npm run migrate        # Apply database migrations
npm run dev            # Start development server (http://localhost:3000)
```

### Run Migrations Only

```bash
npm run migrate
```

---

## Architecture

```
server.js              — Express entry point, middleware, route mounts (~5000 lines, legacy)
routes/                — Modular Express routers (one file per feature group)
db/                    — Query helpers (Pool constructor lives only in db/index.js)
services/              — Business logic (mailers, schedulers, SSH executors)
middleware/            — Auth (requireAuth, requireAdmin, requireConnectionOwner), security (Helmet, rate limits, Zod)
public/                — Static HTML pages (no build step)
migrations/            — node-pg-migrate JS migrations (DDL only here)
oracle-client.js       — Oracle DB connection + query helpers
pdf-generator.js       — PDF report generation (PDFKit)
crypto-utils.js        — AES-256-GCM encrypt/decrypt for stored credentials
```

### Key Design Decisions

- **Single Express service:** All routes, workers, and background jobs run in one process on Render. No separate worker service.
- **Direct + proxy connectivity:** Users can connect directly (TCP) or install a lightweight proxy binary on the Oracle host for firewall-traversal scenarios.
- **Credentials never at rest in plaintext:** Oracle passwords are in-memory only. SSH keys and proxy API keys are AES-256-GCM encrypted in PostgreSQL.
- **EBS-aware:** Detects Oracle E-Business Suite (via `APPS.DUAL` probe) and activates EBS-specific checks, Concurrent Manager ops, ADOP workflows, and control actions.

---

## Health Check Coverage

- **15 categories:** Performance, Space, Security, Configuration, Network, Archive, RMAN, Memory, Stats, Locks, EBS Operations, SQL Tuning, and more
- **200+ individual checks** encoding decades of DBA heuristics
- **AI summaries** via OpenAI: natural-language findings + top recommended action
- **Delta detection:** Autonomous monitoring compares runs and alerts only on new/resolved findings

---

## Email (Resend)

TuneVault sends transactional email through [Resend](https://resend.com). Seven mailer modules live in `services/` (alert-mailer, alert-notifier, drip-mailer, hc-completion-email, outreach-mailer, welcome-email, tuneops-mailer).

**Required env vars:**

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | API key from the Resend dashboard (`sync: false` in render.yaml — paste manually) |
| `EMAIL_FROM` | `TuneVault <noreply@tunevault.app>` (default; override if using a different sender) |

**Domain verification:** Before email can deliver, add the DNS records Resend generates for your sending domain. Follow [Resend's domain setup guide](https://resend.com/docs/dashboard/domains/introduction) — you'll add a DKIM TXT record and optionally an SPF include. DNS propagation takes up to 48 h; Resend's dashboard shows verification status in real time.

**Smoke test** — run after any mailer change or key rotation to confirm end-to-end delivery:

```bash
RESEND_API_KEY=re_xxxx node scripts/smoke-test-resend.js --to=ops@tunevault.app
```

Successful output (13 rows — 7 mailer paths + 6 raw fetch scenarios):

```
 Mailer                                 │ Status                       │ Message ID                       │         ms
 ──────────────────────────────────────────┼──────────────────────────────┼──────────────────────────────────┼────────────
 alert-mailer                           │ ✅ OK                         │ 01jxxxxxxxxxxxxxxxxxxxxxxxxx     │      421 ms
 alert-notifier                         │ ✅ OK                         │ 01jxxxxxxxxxxxxxxxxxxxxxxxxx     │      388 ms
 ...
 Summary: 13/13 passed
```

On failure the CLI prints the failing row with the HTTP status / error message and exits with code 1. Fix the listed mailer and re-run before deploying.

**Contact management:** Resend audiences and contacts are managed in the Resend dashboard, not in the app. The app logs sends to `email_log` for audit purposes only.

---

## Deployment

Deployed on Render as a single web service. Migrations run automatically at startup via `npm run build` → `npm run migrate`.

Health check endpoint: `GET /health` — returns `{ status: 'ok', db: 'connected' }`

Do not deploy manually. Production deploys go through CI/CD.

---

## License

Proprietary. All rights reserved. Not open source.
