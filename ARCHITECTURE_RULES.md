# TuneVault Architecture Rules

Rules that are enforced by CI and must not be violated. Each rule has a
corresponding `scripts/ci/` check that fails the build on regression.

---

## No direct-connect testing endpoints

**Rule:** The proxy agent (`oracle-proxy.py`) must not expose any inbound
direct-connect testing endpoints that accept Oracle credentials over HTTP.

**Why:** TuneVault's proxy architecture is outbound-only. The agent
long-polls the TuneVault cloud (`POST /api/agent/poll`) to receive work.
No inbound ports, firewall rules, or DNS records pointing to the proxy are
required or intended. Exposing `/api/test` (or similar) with `X-Api-Key`
authentication creates an inbound credential surface and is an architecture
violation. It also generates support cycles ("I'm getting 401 on /api/test")
that are resolved faster through the correct testing paths.

**Retired endpoint:** `POST /api/test` — returns 410 Gone since `oracle-proxy.py` v3.5.7.

**Correct testing paths:**

| Need | How |
|------|-----|
| Test agent connectivity on the proxy host | `sudo tunevault-proxy diagnose` (local CLI, no API key, no network) |
| Test end-to-end Oracle connectivity from the product | Open `/connections/:id` → click **Run Diagnostics** |
| View architecture documentation | `https://tunevault.app/docs/architecture#outbound-long-poll` |

**CI enforcement:** `scripts/ci/check-no-direct-connect.sh` grep-fails the
build on any of:
- `/api/test` in customer-facing files
- `X-Api-Key:` in customer-facing docs (the inbound header)
- `curl ... -X POST ... proxy` patterns in documentation
- `proxy_url` form inputs in UI

**Exemptions:** `oracle-proxy.py` itself is exempted from the grep-lock
(it contains the 410 tombstone comment). The CI script is also self-exempted.

---

## Cloudflare / tunnel purge

Direct proxy-URL configuration and Cloudflare-based tunnels were removed.
See task history for the rationale. The outbound long-poll channel is the
only supported agent↔cloud transport.
