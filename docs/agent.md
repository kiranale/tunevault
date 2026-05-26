# TuneVault Agent (`oracle-proxy.py`)

> **Stub** — Documents the v6 agent config layout and single source of truth for credentials.

## Single Source of Truth: `/etc/tunevault/agent.env`

All agent configuration lives in one file: **`/etc/tunevault/agent.env`**

```ini
# /etc/tunevault/agent.env — managed by TuneVault installer; do not edit manually
TUNEVAULT_API_KEY=<cloud-managed rotating key>
TUNEVAULT_HOST=https://tunevault.app
AGENT_VERSION=6.x.x
ORACLE_HOME=/u01/app/oracle/product/...
ORACLE_SID=ORCL
```

This file is the only place credentials are stored. The systemd service (`tunevault-proxy.service`) sources it on startup. Never put credentials in environment variables outside this file — the agent reads exclusively from `/etc/tunevault/agent.env`.

## Key Rotation

API keys are cloud-managed. When TuneVault rotates a key:
1. New key is pushed via the long-poll channel (`SET_API_KEY` job).
2. Agent writes the new key to `/etc/tunevault/agent.env`.
3. 5-minute grace window allows the old key to remain valid.
4. Agent ACKs the rotation; cloud marks the old key expired.

No manual key management required.

## Install / Uninstall

```bash
# Install (one-line, requires outbound HTTPS on port 443)
curl -sSL https://tunevault.app/install.sh | sudo bash -s -- --token <install-token>

# Uninstall
curl -sSL https://tunevault.app/uninstall.sh | sudo bash
```

## Upgrade

Auto-upgrade is enabled by default. The agent checks its version on every heartbeat; if `agent_version < 6.0.0`, TuneVault queues an upgrade job automatically. Manual trigger available from the /connections UI.

## Systemd Service

```
Unit:    tunevault-proxy.service
ExecStart: /usr/local/bin/oracle-proxy.py
Restart: always
EnvironmentFile: /etc/tunevault/agent.env
```
