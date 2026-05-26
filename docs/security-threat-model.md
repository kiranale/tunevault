# TuneVault Security Threat Model

**Date:** 2026-05-18
**Version:** 1.0
**Scope:** Production cloud service + on-premises agent + web frontend
**Audience:** Internal engineering; security review

---

## 1. Architecture Overview

TuneVault operates a split-plane model:

```
Customer Oracle host
  ┌─────────────────────────────────┐
  │  oracle-proxy.py (agent)        │
  │  - Outbound HTTPS only          │
  │  - No inbound ports             │
  │  - Per-connection bearer key    │
  └──────────────┬──────────────────┘
                 │ HTTPS long-poll (customer outbound only)
                 ▼
  TuneVault Cloud (Render, US region)
  ┌─────────────────────────────────┐
  │  Express / Node.js              │
  │  Neon PostgreSQL (encrypted)    │
  │  Session auth + RBAC            │
  └──────────────┬──────────────────┘
                 │ HTTPS
                 ▼
  Browser (customer DBA)
```

**Key property:** No inbound port is ever opened on the customer host. The agent polls outbound. Cloudflare is not in the customer data path.

---

## 2. Trust Zones

| Zone | Trust Level | Authentication |
|------|-------------|----------------|
| Browser session | Authenticated user | Session cookie (HttpOnly, Secure, SameSite=Lax) |
| Agent long-poll | Per-tunnel bearer | AES-256-GCM encrypted API key, per-connection |
| Admin endpoints | Internal only | `ADMIN_EMAILS` env allowlist |
| Database (Neon) | Implicit trust | `DATABASE_URL` env var, TLS required |
| Polsia email proxy | Authenticated | `POLSIA_EMAIL_PROXY_KEY` env var |

---

## 3. Assets

| Asset | Location | Sensitivity |
|-------|----------|-------------|
| Oracle credentials (host, user, password) | `oracle_connections.encrypted_password` (AES-256-GCM) | Critical |
| Oracle proxy API keys | `oracle_connections.proxy_api_key_enc` (AES-256-GCM) | Critical |
| SSH private keys | `connection_ssh_profiles.encrypted_key` (AES-256-GCM), `ssh_install_credentials.encrypted_credential` | Critical |
| Session tokens | `users.session_token` (DB), HttpOnly cookie | High |
| Magic link tokens | `magic_link_tokens` table (single-use, 15-min TTL) | High |
| Agent registration tokens | `agent_reg_tokens` table (single-use, 30-min TTL) | Medium |
| Encryption master key | `ENCRYPTION_KEY` env var (64-hex, 256-bit) | Critical — never logged, never committed |
| Health check results | `health_checks`, `check_results` tables | Medium |
| SQL audit logs | `sql_audit_log`, `ssh_audit`, `proxy_exec_audit` | Medium |

---

## 4. Threat Actors

| Actor | Capability | Motivation |
|-------|-----------|------------|
| Unauthenticated internet attacker | Full network access to HTTPS endpoints | Credential theft, data exfil |
| Authenticated user (non-admin) | Valid session, any tenant | Cross-tenant data access, privilege escalation |
| Compromised agent host | Code execution on Oracle server | Key exfil, command injection upstream |
| Malicious agent payload | Crafted HTTP response to long-poll | Cloud-side injection via response parsing |
| Insider (employee) | DB access, log access | Credential access |
| Compromised cloud service (Render/Neon) | Platform access | DB dump, env var read |

---

## 5. Threat Scenarios & Controls

### T1: Cross-Tenant Connection Access
**Scenario:** Authenticated user A queries connection owned by user B by guessing numeric ID.

**Controls:**
- All `/api/connections/:id` routes use `requireConnectionOwner` middleware (checked in `middleware/auth.js`)
- `POST /api/connections/test`: ownership enforced via `AND user_id = ?` on both load paths (fixed 2026-05-18)
- `POST /api/health-checks` with `connection_id`: ownership pre-checked before use (fixed 2026-05-18)
- `POST /api/health-checks/:id/sql-tuning`: ownership via `AND hc.user_id = ?` (fixed 2026-05-18)
- `POST /api/health-checks/:id/cancel`: strict `AND user_id = ?`, no legacy NULL bypass (fixed 2026-05-18)

**Residual risk:** Legacy connections with `user_id IS NULL` (pre-user-scoping era) are accessible to any authenticated user. Tracked for migration.

---

### T2: Agent API Key Compromise
**Scenario:** Attacker obtains the `X-TuneVault-Key` bearer token for an agent.

**Controls:**
- Key stored AES-256-GCM encrypted in DB; never appears in logs
- Key is per-connection (compromise of one key doesn't affect other tunnels)
- Key rotation available via `/api/connections/:id/rotate-key` — old key valid for ≤5-minute grace window only
- Key tracked: `proxy_key_last_used_at`, `proxy_key_last_ip`, `proxy_key_ips` JSONB allow anomaly detection
- If key is compromised: rotate immediately; old key expires from grace window within 5 minutes

**Residual risk:** Grace window is 5 minutes; a live attacker with the old key during rotation has that window.

---

### T3: Agent Command Injection
**Scenario:** Attacker crafts a malicious work item delivered to the agent via the long-poll channel, causing arbitrary command execution on the Oracle host.

**Controls:**
- Agent (`oracle-proxy.py`) enforces a strict command allowlist — only named commands with typed argument validation execute
- Arguments are validated by type (`path`, `sid`, `int`, `name`, `sql_safe`) before subprocess execution
- All subprocess calls use argv arrays (no `shell=True`) — no shell metacharacter injection
- SQL argument type (`sql_safe`) restricts to SELECT/SHOW/ALTER SYSTEM only via regex
- Audit log at `/var/log/tunevault/exec.log` records every execution with user_id and exit code

**Residual risk:** TLS is the only wire-level integrity protection for work items (no HMAC payload signing). A sophisticated MITM on the TLS session could inject crafted work items — however this requires a CA-level compromise or TLS downgrade attack, which is mitigated by the agent validating the server's certificate via system CA bundle.

---

### T4: Magic Link Phishing / Replay
**Scenario:** Attacker obtains a magic link token and uses it to authenticate as the victim.

**Controls:**
- Tokens: 32 random bytes (256-bit entropy), 15-minute TTL
- Single-use: `used_at IS NULL` enforced at query time; marked used atomically on consumption
- Previous tokens for the same email are invalidated on new request (`DELETE WHERE used_at IS NULL AND email = ?`)
- Rate limited: 10 requests/minute per IP via `authLimiter`
- Tokens are never logged (only email is logged on request)

**Residual risk:** Attacker with network access between email server and recipient could intercept the link. Mitigated by HTTPS transport and 15-minute TTL.

---

### T5: SQL Console Privilege Escalation
**Scenario:** A `senior_dba` user executes arbitrary SQL against a connection they don't own.

**Controls:**
- `POST /api/sql-console/run` requires `senior_dba` role (not `junior_dba` or `viewer`)
- Handler calls `getConnParams(connectionId, userId)` which enforces `WHERE id = ? AND user_id = ?` — query returns 0 rows for unowned connections
- Every SQL execution logged to `sql_audit_log` with user, connection, SQL text, success/failure, duration
- SQL allowlist applied before execution (no DDL, no DML on sensitive tables)

**Residual risk:** The ownership check is inside the handler, not at middleware layer. Functionally correct but relies on no one accidentally removing the inner check. Consider extracting to middleware.

---

### T6: Credential Leakage via Logs
**Scenario:** Oracle credentials or proxy keys appear in application logs, Datadog, or error responses.

**Controls:**
- Credentials stored only as AES-256-GCM ciphertext in DB; only decrypted at point of use
- SSH install audit log explicitly omits credentials (`// credential intentionally omitted`)
- API key display masked in responses: `tvp_XXXXXXXX...XXXX` (first 8 + last 4 chars)
- Error responses use generic messages (e.g., "Connection failed") not Oracle connection strings
- Datadog logs via structured logger — raw `console.*` not used in production paths per CLAUDE.md policy

**Residual risk:** Oracle error messages (e.g., `ORA-12541: TNS:no listener at host:port`) may include host/port from the TNS error itself. No actual credentials exposed, but connection topology may leak in error detail fields.

---

### T7: Registration Token Hijacking
**Scenario:** Attacker intercepts the agent registration token during install and provisions the agent to a malicious endpoint.

**Controls:**
- Tokens are 32 random bytes (256-bit entropy), 30-minute TTL
- Single-use: atomic `UPDATE ... WHERE used = FALSE` prevents double-redemption
- Token is delivered over HTTPS only (never in URL params in production paths)
- Agent verifies cloud endpoint via HTTPS certificate validation before redemption

**Residual risk:** 30-minute window is relatively generous. If install.sh is run on a compromised network with MITM capability, the token could be stolen in transit. Acceptable for the install flow — shortening TTL could cause friction on slow provisioning environments.

---

### T8: Compromised Render/Neon Platform
**Scenario:** Render (hosting) or Neon (database) is compromised, giving an attacker access to env vars or DB contents.

**Controls:**
- All credentials in DB are AES-256-GCM encrypted with `ENCRYPTION_KEY` (env var, not in DB)
- Even with full DB dump, attacker needs the `ENCRYPTION_KEY` separately to decrypt any credential
- `ENCRYPTION_KEY` is a Render environment variable — not committed to git, not in logs
- Neon database uses TLS; connection string in `DATABASE_URL` (Render env var)

**Residual risk:** If both the Render env var (`ENCRYPTION_KEY`) and the Neon database are compromised simultaneously, all credentials become accessible. This requires a dual-platform compromise.

---

## 6. RBAC Summary

| Role | DB Ops | EBS Ops | SQL Console | Connection CRUD | Admin |
|------|--------|---------|-------------|-----------------|-------|
| viewer | read-only | read-only | ✗ | ✗ | ✗ |
| junior_dba | run non-destructive | limited | ✗ | ✗ | ✗ |
| senior_dba | run all | full | ✓ | create/edit | ✗ |
| admin | full | full | ✓ | full + delete | ✓ |

RBAC is enforced server-side via `requireRole()` middleware. Client-side visibility flags are cosmetic only — never trusted for authorization decisions.

---

## 7. Encryption Standards

| Use | Algorithm | Key Management |
|-----|-----------|----------------|
| Credentials at rest | AES-256-GCM | 256-bit key, Render env var, rotated manually |
| SSH keys at rest | AES-256-GCM | Same key |
| Transport (cloud↔browser) | TLS 1.2+ | Render-managed cert (Let's Encrypt) |
| Transport (cloud↔agent) | TLS 1.2+ | System CA bundle validation |
| Password hashing (MFA recovery) | bcrypt | Per-hash salt |

---

## 8. Audit Surfaces

| Log Table | What It Records | Retention |
|-----------|-----------------|-----------|
| `sql_audit_log` | Every SQL execution attempt (allowed/blocked) | Indefinite |
| `ssh_audit` | Every SSH command (allowed/rejected, exit code) | Indefinite |
| `proxy_exec_audit` | Every OS exec via proxy (command_id, args, outcome) | Indefinite |
| `rbac_audit_log` | Every permission-denied API hit | Indefinite |
| `agent_upgrade_audit` | Auto-upgrade lifecycle events | Indefinite |
| `audit_log` | EBS control command previews/executions | Indefinite |
| `/var/log/tunevault/exec.log` | Agent-side execution log (on customer host) | Host-managed |

---

## 9. Known Limitations & Accepted Risks

| Limitation | Risk Level | Mitigation / Timeline |
|------------|-----------|----------------------|
| No HMAC signing on agent channel payloads | Low | TLS provides wire integrity; payload signing would add defense-in-depth |
| Legacy connections with `user_id IS NULL` | Medium | Migration in progress; all new connections have user_id |
| API key rotation grace window (5 min) | Low | Necessary for in-flight requests; acceptable |
| SQL error messages may reveal host:port | Low | No credentials exposed; Oracle error format, not our output |

---

## 10. Security Contact

Report vulnerabilities to: **security@tunevault.app**

Response SLA: 24 hours for critical, 72 hours for medium.

Do not publish vulnerability details until a fix has been deployed and verified.
