# TuneVault Architecture Rules

This file is the canonical lock for TuneVault's architecture invariants.
A CI check (`scripts/check-architecture-rules.sh`) enforces these rules on every PR.
Violations fail the build. The check is in `.github/workflows/architecture.yml`.

---

## Rule 1: Cloudflare Tunnels are NOT part of TuneVault's product architecture.

### The Rule

No customer-facing code, documentation, runbooks, or installer output may reference
Cloudflare tunnel services (`cloudflared`, `cloudflare-tunnel`, `tunevault-tunnel.service`,
Cloudflare Zero Trust tunnels, `*.cfargotunnel.com`, `trycloudflare.com`).

### Rationale

TuneVault's agent communication model is **outbound-only long-poll**:

- `oracle-proxy.py` runs on the Oracle server as a systemd service (`tunevault-proxy`).
- The proxy opens an outbound HTTPS connection to `tunevault.app/api/agent/poll` every 10 seconds.
- TuneVault sends health check jobs through this channel; the proxy executes them locally.
- **No inbound ports. No DNS records. No third-party tunnel services.**

Cloudflare tunnel support was removed from the product in May 2026 (install.sh v4.0).
Any reference to it in customer-facing surfaces:
1. Confuses users who follow outdated steps and get stuck on non-existent infrastructure.
2. Creates support load for a feature that no longer exists.
3. Contradicts the "400 KB Python script, zero inbound ports" marketing differentiator.

### Patterns that are FORBIDDEN in customer-facing code

```
cloudflared
cloudflare-tunnel
tunevault-tunnel.service
cf_enabled
cf_tunnel
trycloudflare
*.cfargotunnel.com
tunevault-tunnel
```

### Where these patterns ARE allowed (never customer-facing)

- `scripts/personal-lab/**` — Kiran's personal dev/test scripts only
- `docs/internal/**` — Internal notes marked NOT CUSTOMER-FACING

### What to do instead

If a customer asks about connectivity, refer them to the outbound-only architecture:
- **Runbook:** `/resources/runbooks/agent-connection-failure`
- **Architecture page:** `/architecture`
- **Setup guide:** `/setup/fresh`

The agent requires only outbound HTTPS (port 443) to `tunevault.app`. No tunnel setup.
No third-party accounts. No DNS records. If that's blocked, Direct TCP is the fallback.

---

## Adding New Architecture Rules

Append a new numbered `## Rule N` section. Update `scripts/check-architecture-rules.sh`
to add the new forbidden patterns and the file glob scope.

Reference this file from every PR that touches connectivity, installer, or agent code:
> "Checked against docs/ARCHITECTURE_RULES.md — no violations."
