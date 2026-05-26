# EBS 12.2.10 Live Validation — ebs12210-db-dev

**Date:** 2026-05-18
**Task:** #1669703
**Topology:** `live-EBS-12.2.10-db-dev`

## What this validates

This is the first non-greenfield row on `/status/installer`. It proves:

1. v6 agent registers + heartbeats on a live EBS 12.2.x DB server (not a Docker sandbox)
2. The 54-check health suite runs to completion against a real EBS database
3. SSH profile configured for `apps_tier` role (agent-forward auth preferred — no key storage)
4. CM-status runbook executes via SSH from the new `routes/ebs-runbooks.js` surface

## Procedure

### Step 1 — Agent install

If task #1668975 (v6 agent) has merged, run:
```
tunevault-proxy upgrade
```

If not yet merged, install v6 side-by-side on port 8443:
```
curl -sSL https://tunevault.app/install-v6.sh | sudo bash -s -- \
  --port 8443 --api-url https://tunevault.app
```

End state: green dot on /connections, `agent_version` = `6.0.0`.

### Step 2 — Health check run

Trigger via /connections detail page → "Run health check". Expect ~54 checks.

Key EBS-specific checks to verify:
- `FND_NODES` — confirm node status (should show this DB-tier node + apps-tier node)
- `WF_MAILER` — workflow mailer status (expect STARTED or known-stopped)
- `OPP` — output post-processor (should be RUNNING)
- `ICM` — Internal Concurrent Manager (should have active PID)
- `EBS_*` category checks — confirm EBS detection flag fired

Attach the JSON run result (`health_checks.check_results` rows) to the run record via the admin EBS result endpoint.

### Step 3 — SSH profile (apps_tier)

In /connections edit modal → SSH Access tab → apps_tier role:
- Auth method: **agent_forward** (no key upload needed — already SSH'd in)
- SSH host: apps-tier hostname or IP (from FND_NODES output)
- SSH port: 22
- SSH user: `applmgr` (or local apps user)
- No bastion section needed (direct connectivity)

Hit "Test SSH" → must return green.

### Step 4 — CM-status runbook

Navigate to /runbooks/cm-status-bounce.html → select ebs12210-db-dev connection.

Verify:
- ICM PID returned (non-zero integer)
- Queue managers table populates (FNDLIBR processes)
- No credential strings (passwords, API keys) visible in browser DevTools → Network panel
- `adcmctl.sh status` output parses cleanly to table format

Record `ssh_runbook_executed = true` in the EBS result via admin endpoint.

### Step 5 — Publish to /status/installer

POST to `/api/admin/installer-validation/ebs-result` with:
```json
{
  "run_id": "<uuid>",
  "install_sha": "<commit-sha-of-install-v6.sh>",
  "agent_version": "6.0.0",
  "kernel_version": "<uname -r output>",
  "overall": "pass",
  "checks_passed": <N>,
  "checks_total": 54,
  "ssh_runbook_executed": true,
  "probes": [
    {"n": 1, "status": "pass", "ms": 120},
    {"n": 2, "status": "pass", "ms": 45},
    {"n": 3, "status": "pass", "ms": 80},
    {"n": 4, "status": "pass", "ms": 200},
    {"n": 5, "status": "pass", "ms": 95},
    {"n": 6, "status": "pass", "ms": 310},
    {"n": 7, "status": "pass", "ms": 60}
  ],
  "duration_total_ms": 45000
}
```

## Surprises / follow-up tasks

*(populate after first run)*

- [ ] If FND_NODES returns both nodes but apps-tier shows `inactive`, follow up with EBS admin — known scheduled maintenance or CM bounce needed?
- [ ] If probe 3 (TNS listener) resolves slowly (>500ms), check if the `apps_tier` SSH profile host differs from the DB-tier TNS host — may need separate SSH target.
- [ ] The `ssh_runbook_executed` flag in the status page currently requires manual admin POST. A follow-up task should wire the runbook execution result back automatically (SSE stream completion → fire POST to /api/admin/installer-validation/ebs-result).
- [ ] Consider adding `checks_amber` and `checks_red` breakdown columns to `installer_validation_runs` for richer EBS health display.

## Hard rules followed

- APPS password handled via credential vault (oracle_connections.credentials_enc). Never written to env files or logs.
- No Cloudflare tunnel — outbound HTTPS long-poll only.
- SSH creds handled via connection_ssh_profiles (AES-256-GCM at rest), decrypted in-memory only.
