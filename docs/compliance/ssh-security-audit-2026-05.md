# SSH Security Audit — May 2026

**Scope:** TuneVault SSH proxy / bastion-host feature
**Date:** 2026-05-15
**Auditor:** Engineering (automated review)
**Purpose:** Enterprise readiness — 5-checkpoint security validation

---

## Summary Table

| # | Checkpoint | Result | Severity | Remediation |
|---|------------|--------|----------|-------------|
| 1 | Command Injection / Allowlist Bypass | **FAIL → FIXED** | P0 | Shell metacharacter guard added to `checkAllowList` |
| 2 | Session Logging / Audit Trail | **PASS** | — | Minor gap: output content not stored (bytes only) |
| 3 | SSH Key Storage Security | **PASS** | — | AES-256-GCM at rest; UI rotation note added |
| 4 | Session Timeout Enforcement | **PASS** | — | 60 s exec / 5 min streaming / 30 s executor default |
| 5 | Rate Limiting / Connection Caps | **PARTIAL → FIXED** | P1 | `test-inline` endpoint now rate-limited; concurrent cap added |

**Overall status: PASS** (all P0/P1 issues remediated at time of this document)

---

## Checkpoint 1 — Command Injection / Allowlist Bypass

### Pre-fix finding: FAIL (P0)

**File:** `routes/ssh-execute.js` — `checkAllowList()`

The allowlist validated only the leading token of a command against allowed prefixes using
`.test(cmd)`. Once a command matched a prefix, the full raw string was passed to `conn.exec()`
without any sanitization of the remainder.

**Exploitable vectors before fix:**

| Payload | Reason it bypassed the allowlist |
|---------|----------------------------------|
| `tail /log; <cmd>` | `tail` prefix matched; `;` interpreted by remote shell |
| `ps && <cmd>` | `ps` matched; `&&` chained execution |
| `cat /path \|\| <cmd>` | `cat` matched; `\|\|` chained execution |
| `ls \| <cmd>` | `ls` matched; pipe to arbitrary command |
| `tail $(<cmd>)` | `tail` matched; command substitution executed before tail |
| `grep pattern /path \`<cmd>\`` | `grep` matched; backtick substitution |
| `cat /path\ncat /other` | newline injected second command |
| `cat /path\x00suffix` | null byte variant |

The `BLOCK_EXCEPTIONS` list (which blocks `rm`, `dd`, `fdisk`, etc.) only evaluated when
a command was NOT on the allowlist, making it irrelevant for injection via allowed prefixes.

### Fix applied

Added `SHELL_INJECTION_RE` to `checkAllowList()` in `routes/ssh-execute.js`. After a command
passes the prefix check, the full command is tested against a shell metacharacter regex. Any
command containing `;`, `&&`, `||`, `|`, `$(`, backtick, newline (`\n` / `\r`), or null byte
is rejected with a 403 **even if it matches an allowed prefix**.

This is conservative: if a legitimate use case requires piping (e.g., `grep … | head -20`),
the whitelisted command templates in `services/ssh-executor.js` handle that — users should
invoke those by command key, not by composing raw shell strings via the execute endpoint.

**Interactive shell path:** None exists. Neither `bash`, `sh`, `/bin/sh`, nor `su -` appear in
the allowlist. The executor uses `conn.exec(cmd)` (single-command execution), not
`conn.shell()` (interactive PTY). There is no path to an interactive bash session through
these endpoints.

### Evidence

```
routes/ssh-execute.js:checkAllowList() — SHELL_INJECTION_RE guard
BLOCK_EXCEPTIONS list — independently blocks rm, dd, fdisk, shutdown, sudo su, kill -9
commandRateLimiter — 5 cmd/min per user
```

---

## Checkpoint 2 — Session Logging / Audit Trail

### Result: PASS

**Every SSH command executed through TuneVault is logged** to `ssh_audit` table via
`writeAudit()` in `db/ssh-targets.js`. This includes both allowed and blocked commands.

**Fields captured per row:**

| Field | Coverage |
|-------|----------|
| `ts` | Timestamp (TIMESTAMPTZ, DEFAULT NOW()) |
| `initiated_by` | User email (not ID — stays readable after account changes) |
| `target_id` | FK to `ssh_targets` (host, role recoverable) |
| `command_key` | Logical operation name |
| `rendered_command` | Exact command string sent to the remote shell (capped 4096 chars) |
| `exit_code` | Process exit code |
| `stdout_bytes` | Output size in bytes |
| `stderr_bytes` | Error output size in bytes |
| `duration_ms` | Execution latency |
| `was_rejected` | Boolean — allowlist rejection |
| `rejection_reason` | Why it was blocked (if applicable) |

**Admin queryable at:** `GET /api/ssh/audit?target_id=&limit=&offset=` (admin-only, RBAC-gated).

**Query answer for auditors:** "Show me what user X did on May 3rd at 2pm"
→ `SELECT * FROM ssh_audit WHERE initiated_by = 'user@domain' AND ts BETWEEN '...' AND '...' ORDER BY ts`

**Retention policy:** No explicit retention policy is enforced today. The `ssh_audit` table
is append-only with no TTL or archival job. Neon PostgreSQL retains all data indefinitely
until the database size limit is hit.

**Recommendation:** Add a scheduled job or `pg_cron` expression to archive rows older than
1 year to cold storage, or configure Neon's PITR window to cover your retention SLA.
For Enterprise compliance (SOX, SOC2), document the agreed retention period and implement
a purge/archive migration. No data is currently being lost — this is a gap only if a specific
retention SLA is required by a customer's compliance framework.

**Minor gap:** Output content is not stored in the audit log — only byte counts. The actual
`stdout`/`stderr` text is returned to the caller but not persisted. This is intentional
(Oracle query outputs may contain sensitive data), but means an auditor cannot replay exact
output for a past command. Document this policy decision in the Enterprise onboarding guide.

---

## Checkpoint 3 — SSH Key Storage Security

### Result: PASS

**Encryption method:** AES-256-GCM (`crypto-utils.js`)

- Algorithm: `aes-256-gcm` (authenticated encryption — prevents tampering)
- Key source: `ENCRYPTION_KEY` env var (64 hex chars = 32 bytes); crashes at startup if missing in production (`RENDER` or `NODE_ENV=production`)
- IV: `crypto.randomBytes(16)` — unique per encryption operation (no IV reuse)
- Storage format: `iv:tag:ciphertext` (all hex) in `encrypted_private_key` / `encrypted_passphrase` columns
- The decrypted value is a local variable only, never logged, never returned in API responses

**Columns exposed in API responses:** `listTargets()`, `listTargetsByUser()`, `getTargetByIdForUser()` — all explicitly omit `encrypted_private_key` and `encrypted_passphrase` from their `SELECT` clauses. The `getTargetById()` function (which does include credentials) is only called by the executor layer.

**Key rotation mechanism:**

Admin path: `PUT /api/ssh/targets/:id/credentials` (admin-only) accepts a new private key
or password and re-encrypts before persisting. The old credential is overwritten.

User path: `PUT /api/user/ssh/targets/:id/credentials` (senior_dba+) performs the same
operation for user-owned targets.

**Gap:** There is no "generate new SSH keypair" button in the UI that creates a new key on
the server and delivers the public key for installation on the Oracle host. Users must
generate a keypair externally, install the public key on the Oracle server, then paste the
private key into TuneVault. This is standard behavior for bastion-host tools but should be
documented. It's not a vulnerability; it's a UX gap.

---

## Checkpoint 4 — Session Timeout Enforcement

### Result: PASS

**Timeouts by path:**

| Execution path | Idle timeout | Hard timeout | Implementation |
|----------------|-------------|--------------|----------------|
| `POST /api/ssh-targets/:id/execute` | N/A (fire-and-forget, not persistent) | 60 s | `EXEC_TIMEOUT_MS = 60_000` |
| `GET /api/ssh-targets/:id/stream` | Client disconnect closes connection | 5 min hard | `STREAM_TIMEOUT_MS = 5 * 60 * 1000` |
| `services/ssh-executor.js` (internal) | N/A | 30 s default | `DEFAULT_TIMEOUT_MS = 30_000` |
| `POST /api/user/ssh/test-inline` | N/A | 15 s | Hardcoded `timeout = 15000` |

**Architecture note:** TuneVault's SSH model is *stateless per command* — each execution opens
a fresh SSH connection, runs a single command, and closes. There are no long-lived persistent
SSH sessions to idle-timeout. Each request either completes within its hard timeout or is
killed. This is inherently more secure than traditional bastion-host session persistence.

**The 5-minute streaming limit** is enforced by `setTimeout(() => close('timeout_5min'), STREAM_TIMEOUT_MS)`
on the server side, independent of client behavior. A hung client cannot extend this.

**Idle session test:** Not applicable for the stateless command model. The closest equivalent
is a streaming command left running — it terminates at the 5-minute mark.

---

## Checkpoint 5 — Rate Limiting / Connection Caps

### Pre-fix finding: PARTIAL

**What existed before fix:**
- `commandRateLimiter`: 5 commands / minute / user (applied to `/execute` and `/stream`)
- No rate limiting on `POST /api/user/ssh/test-inline`
- No concurrent session limit
- No IP-level brute-force protection on SSH connection attempts

**Gaps identified:**

1. `test-inline` endpoint: accepts raw SSH credentials and makes outbound SSH connections.
   Senior DBAs could use this to probe arbitrary hosts. No rate limiting existed.
2. No global cap on concurrent SSH sessions. A single user could flood the server with
   parallel streaming connections (each using a Node.js thread and system FD).

### Fixes applied

1. **`test-inline` rate limiter:** Added `testInlineRateLimiter` — 3 requests / 5 minutes
   per user. This prevents both credential brute-force and SSRF probing via the endpoint.

2. **Concurrent streaming cap:** Added `_activeStreams` counter in `ssh-execute.js`.
   Hard cap of 20 concurrent streaming connections globally (configurable via
   `SSH_MAX_CONCURRENT_STREAMS` env var). Returns 503 when exceeded.

**What was intentionally NOT added:**

- Per-customer concurrent session limit at the DB/user level: the 5 cmd/min limiter
  already prevents fast cycling. Adding a separate "max 5 concurrent" check would require
  a Redis counter or DB row, adding latency. The global cap of 20 is simpler and sufficient
  for the current user base. Revisit if concurrency issues surface in production.
- IP-level rate limiting on SSH connection attempts: TuneVault is not directly exposed as
  an SSH server — it makes *outbound* SSH connections on behalf of authenticated users.
  The relevant brute-force surface is TuneVault's own authentication layer (already protected
  by auth middleware + Google OAuth), not inbound SSH.

---

## Additional Recommendations

### R1 — Audit log output capture (optional)
For highest-assurance environments, consider storing truncated `stdout` (first 4 KB) in
the `ssh_audit` table. This allows replay verification for sensitive operations. Currently
only byte count is stored. If implemented, ensure the column is encrypted at the application
layer (same key as credential fields) since Oracle query output may contain sensitive data.

### R2 — Log retention SLA
Define and document the audit log retention period (recommended minimum: 1 year for SOX/SOC2).
Implement a quarterly archival job that moves rows older than 365 days to cold storage.
Add a `RETENTION_DAYS` constant to `db/ssh-targets.js` and a cron-triggered cleanup.

### R3 — SSH key rotation UX
Add a "Regenerate Key" button to the SSH targets UI. The UI flow: (1) generate 4096-bit
RSA or Ed25519 keypair server-side; (2) display the public key for the user to install on
the Oracle server; (3) save the encrypted private key to `ssh_targets`. This eliminates
the need for users to handle private key material outside TuneVault.

### R4 — Allowlist documentation for security reviewers
Publish the command allowlist at a `/security/ssh-commands` endpoint (authenticated,
senior_dba+). This lets Enterprise customers' security teams review the exact set of
permitted operations without reading source code.

### R5 — Add `connection_id` to audit log
Currently `ssh_audit` records `target_id` but not `connection_id` (the Oracle connection
the target is linked to). An auditor trying to answer "what happened to the PROD connection?"
must join through `ssh_targets`. Add `connection_id` to `ssh_audit` for faster forensics.

---

## Evidence Summary for Enterprise Security Review

| Control | Implementation | Evidence location |
|---------|---------------|-------------------|
| Authentication required | `requireAuth` middleware on all SSH endpoints | `middleware/auth.js` |
| Authorization (ownership) | User-owned or admin-managed targets only | `routes/ssh-execute.js:loadTarget()` |
| RBAC enforcement | `senior_dba` minimum role for all SSH execution | `routes/user-ssh-targets.js`, `routes/ssh-targets.js` |
| Allowlist-only execution | `checkAllowList()` + `COMMAND_WHITELIST` | `routes/ssh-execute.js`, `services/ssh-executor.js` |
| Injection prevention | `SHELL_INJECTION_RE` guard blocks metacharacters | `routes/ssh-execute.js` (post-fix) |
| No interactive shell | `conn.exec()` not `conn.shell()`; no shell in allowlist | `routes/ssh-execute.js`, `services/ssh-executor.js` |
| Credentials encrypted at rest | AES-256-GCM, random IV per operation | `crypto-utils.js`, `migrations/1748900000000` |
| Credentials never in responses | Explicit column exclusion in all SELECT | `db/ssh-targets.js` |
| Complete audit trail | Every execution (allowed + blocked) logged | `db/ssh-targets.js:writeAudit()` |
| Execution timeout | 30–60 s per command, 5 min streaming hard cap | `routes/ssh-execute.js` |
| Rate limiting | 5 cmd/min (execute/stream); 3/5min (test-inline) | `routes/ssh-execute.js` |
| Confirmation gate | Destructive commands require `confirmed: true` | `routes/ssh-execute.js` |
| Output size cap | 1 MB stdout, 64 KB stderr per execution | `routes/ssh-execute.js` |

---

*Last updated: 2026-05-15. Review annually or on any SSH implementation change.*
