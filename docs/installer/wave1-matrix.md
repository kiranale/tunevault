# Wave 1 Installer Self-Healing — Test Matrix

**Feature:** DPY-3015 detection, Instant Client auto-download, thick-mode retry, `timeout=` patch
**Installer version:** v6.2
**Date:** 2026-05-20

---

## Background

EBS 12.1/12.2 customers running Oracle 11g often hit `DPY-3015` (thin driver cannot authenticate
with the 11g password verifier). Before v6.2, this required a 7-step manual fix. v6.2 makes the
one-line installer zero-touch for this scenario.

**Before:** `curl install.sh | sudo bash` → agent installs, logs show DPY-3015, customer opens a ticket.
**After:** Installer detects DPY-3015, auto-downloads Instant Client (~80 MB from TuneVault mirror),
retries in thick mode, prints green checkmark. One command, no chat needed.

---

## Test Matrix

| # | Target | Oracle | EBS | Thin probe result | IC auto-install | Thick probe | Overall | Notes |
|---|--------|--------|-----|-------------------|-----------------|-------------|---------|-------|
| 1 | OL8 x86\_64 | 19c CDB | — | `THIN_AUTH_OK` | Skipped | — | ✅ PASS | Standard path; IC not needed |
| 2 | OL8 x86\_64 | 12.1 EBS 12.2.x | 12.2.x | `THIN_AUTH_OK` | Skipped | — | ✅ PASS | 12c verifier; thin works |
| 3 | OL7 x86\_64 | 11.2 EBS 12.1.3 | 12.1.3 | `NEED_IC` (DPY-3015) | IC 21c Basic installed | `THICK_AUTH_OK` | ✅ PASS | **Main scenario** |
| 4 | OL8 x86\_64 | 11.2 EBS 12.1.3 | 12.1.3 | `NEED_IC` (DPY-3015) | IC 21c Basic installed | `THICK_AUTH_OK` | ✅ PASS | OL8 + 11g verifier |
| 5 | OL9 x86\_64 | 19c standalone | — | `THIN_AUTH_OK` | Skipped | — | ✅ PASS | glibc 2.34 |
| 6 | OL7 x86\_64 | 19c CDB | — | `THIN_AUTH_OK` | Skipped | — | ✅ PASS | glibc 2.17; thin works fine |
| 7 | Fresh OL8 (no Oracle) | — | — | Skipped (no SID) | Skipped | — | ✅ PASS | Probe skipped gracefully; agent registers |
| 8 | Fresh OL9 (no Oracle) | — | — | Skipped (no SID) | Skipped | — | ✅ PASS | Same as above |

---

## Telemetry Path Distribution (expected)

| `install_path` | Expected % | Scenario |
|----------------|-----------|----------|
| `thin_ok` | ~70% | Modern Oracle (12c+), 12c verifier enabled |
| `ic_installed` | ~20% | EBS 12.1 / Oracle 11.2 customers |
| `skipped` | ~8% | Cloud-only monitoring, no local Oracle |
| `thin_fail_no_ic` | ~2% | IC download failed (network issue) or unexpected error |

Wave 1 dashboard query:
```
event:install_telemetry | stats count by install_path
```

---

## DPY-3015 Flow (happy path)

```
curl install.sh | sudo TUNEVAULT_TOKEN=xxx bash

[..] Installing oracledb (thin driver)…
[OK] oracledb 2.x installed and verified
[..] Running thin-mode connectivity probe: ebs12210-db-dev:1521/EBSDEVDB…
[..] DPY-3015/ORA-28040 detected: [ORA-28040] No matching authentication protocol
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Auto-fix: downloading Oracle Instant Client…
  (11g password verifier requires thick-mode driver)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[..] Downloading Oracle Instant Client 21 Basic from TuneVault mirror (~80MB)…
[OK] IC Basic RPM downloaded
[..] Installing Instant Client RPM(s)…
[OK] libclntsh.so verified in /opt/tunevault/instantclient
[..] Instant Client installed — reinstalling cx_Oracle for thick mode…
[OK] Thick-mode connectivity probe: PASS — 11g verifier scenario resolved
[OK] IC lib dir persisted to agent.env (LD_LIBRARY_PATH=/opt/tunevault/instantclient)
✓ TuneVault Agent active, heartbeat confirmed at 10:25:03 UTC.
```

---

## timeout= Kwarg Patch

`python-oracledb < 1.4.0` does not accept `timeout=` in `connect()`. The installer
sed-patches `oracle-proxy.py` and `agent/oracle_worker.py` on every run (idempotent).

**Pattern removed:** `, timeout=<value>` from `oracledb.connect(...)` call sites.
**Why:** timeout is handled at the TCP/TNS listener level; the kwarg TypeError is fatal.

---

## Cloudflare Check

`install.sh` contains **zero** references to:
- `cloudflared`
- `tunevault-tunnel.service`
- `cf_enabled`
- `CF_TUNNEL_TOKEN`

Verified by: `grep -i 'cloudflare\|cloudflared\|cf_enabled\|tunevault-tunnel' install.sh` → no output.
