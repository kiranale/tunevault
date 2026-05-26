# TuneVault Architecture

> **Stub** — This file documents the v6 agent architecture. For CI-enforced invariants see `docs/ARCHITECTURE_RULES.md`.

## Core Principle: Outbound-Only, No Inbound Ports

TuneVault's agent communication model is **outbound HTTPS long-poll**. There is no Cloudflare tunnel, no reverse proxy, no inbound firewall rules.

- `oracle-proxy.py` runs as `tunevault-proxy` systemd service on the Oracle server.
- Agent opens outbound HTTPS to `tunevault.app/api/agent/poll` every 10 seconds.
- TuneVault pushes health check jobs through this channel; the agent executes them locally and POSTs results back.
- **No inbound ports. No DNS records. No third-party tunnel services.**

## Communication Flow

```
Oracle Server (on-prem)          TuneVault Cloud
─────────────────────            ─────────────────
oracle-proxy.py  ──── HTTPS GET /api/agent/poll ──► server.js
                 ◄─── job payload ─────────────────
                 ──── POST /api/agent/result ──────►
```

## Stack

Single Express.js service (`server.js`) + Neon PostgreSQL. No separate worker processes, no background services, no inbound tunnels. See `README.md` for full stack details.

## Agent Versioning

Agent binaries (`oracle-proxy.py`) are versioned. v6+ uses pure-Python with outbound HTTPS only. Prior versions (v3-v5) used different transport layers — all are auto-upgrade eligible via the heartbeat channel. See `docs/agent.md` for agent config.
