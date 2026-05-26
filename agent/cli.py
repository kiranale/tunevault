"""
agent/cli.py — tunevault-agent CLI entry point.
Owns: argument parsing, subcommand dispatch, startup/shutdown lifecycle.
Does NOT own: Oracle queries, SSH, poll loop internals, probe logic.

Subcommands:
  tunevault-agent start                        — start the poll loop (foreground, systemd runs this)
  tunevault-agent diagnose                     — run probes, print results, exit 0 on pass / 1 on fail
  tunevault-agent register                     — register agent with TuneVault cloud (writes agent.yaml)
  tunevault-agent repair                       — re-install deps, restart service
  tunevault-agent upgrade                      — download latest installer, upgrade in place
  tunevault-agent version                      — print version and exit
  tunevault-agent rotate-key <new-key>         — atomically write new API key to agent.env + restart
  tunevault-agent config get <KEY>             — read a value from agent.env
  tunevault-agent config set <KEY> <VALUE>     — atomically write a value to agent.env
  tunevault-agent migrate-config               — consolidate inline systemd Environment= into agent.env
  tunevault-agent doctor [--json]              — 6-check connectivity diagnosis (PASS/FAIL, exit 0/1)
"""


import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

from agent import VERSION

CONFIG_PATH = os.environ.get("TUNEVAULT_CONFIG", "/etc/tunevault/agent.yaml")

# Logging setup — structured enough for systemd journal
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("tunevault.cli")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_config(path: str = CONFIG_PATH) -> dict:
    """Load and return agent config as a dict.

    Primary source: agent.yaml at CONFIG_PATH.
    Fallback: environment variables (TUNEVAULT_API_URL, TUNEVAULT_API_KEY,
    TUNEVAULT_CONNECTION_ID, etc.) injected by systemd EnvironmentFile=agent.env.
    This fallback lets `python3 -m agent.cli start` work when only agent.env exists.
    """
    try:
        import yaml  # type: ignore[import]
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        # agent.yaml not present — try env var fallback (agent.env via systemd EnvironmentFile=)
        api_key = os.environ.get("TUNEVAULT_API_KEY", "")
        api_url = os.environ.get("TUNEVAULT_API_URL", "") or os.environ.get("TUNEVAULT_API", "")
        conn_id_raw = os.environ.get("TUNEVAULT_CONNECTION_ID", "0")
        if api_key and api_url:
            try:
                conn_id = int(conn_id_raw)
            except (ValueError, TypeError):
                conn_id = 0
            log.info("agent.yaml not found — using environment variables (agent.env fallback)")
            return {
                "api_url": api_url,
                "api_key": api_key,
                "connection_id": conn_id,
                "host": os.environ.get("ORACLE_HOST", ""),
                "port": int(os.environ.get("ORACLE_PORT", "1521") or "1521"),
                "service_name": os.environ.get("ORACLE_SERVICE_NAME", ""),
                "username": os.environ.get("ORACLE_USERNAME", ""),
                "password": os.environ.get("ORACLE_PASSWORD", ""),
            }
        sys.exit(
            f"ERROR: Config not found: {path}\n"
            f"Neither agent.yaml nor TUNEVAULT_API_KEY + TUNEVAULT_API_URL env vars found.\n"
            f"Run: tunevault-agent register --token <TOKEN>"
        )
    except Exception as exc:
        sys.exit(f"ERROR: Failed to read {path}: {exc}")


def _save_config(cfg: dict, path: str = CONFIG_PATH) -> None:
    """Write agent.yaml atomically."""
    import yaml  # type: ignore[import]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False)
    os.replace(tmp, path)
    log.info("Config written to %s", path)


# ── Subcommands ───────────────────────────────────────────────────────────────

def cmd_version(args: argparse.Namespace) -> int:
    print(f"tunevault-agent {VERSION}")
    print(f"Python {sys.version}")
    try:
        import oracledb  # type: ignore[import]
        mode = "thin" if oracledb.is_thin_mode() else "THICK (unexpected)"
        print(f"python-oracledb {oracledb.__version__} ({mode})")
    except ImportError:
        print("python-oracledb: NOT INSTALLED")
    try:
        import paramiko  # type: ignore[import]
        print(f"paramiko {paramiko.__version__}")
    except ImportError:
        print("paramiko: NOT INSTALLED")
    return 0


def cmd_diagnose(args: argparse.Namespace) -> int:
    """Run 8 probes and print results. Exit 0 if all pass/skip, 1 on any fail."""
    from agent.probes import run_all

    config_path = args.config or CONFIG_PATH
    report = run_all(config_path=config_path)

    GREEN = "\033[0;32m"
    RED = "\033[0;31m"
    YELLOW = "\033[1;33m"
    NC = "\033[0m"
    BOLD = "\033[1m"

    use_color = sys.stdout.isatty() and not args.json

    print(f"\n{BOLD}TuneVault Agent v{VERSION} — Diagnostics{NC}\n" if use_color
          else f"\nTuneVault Agent v{VERSION} — Diagnostics\n")

    total = report["total"]
    for probe in report["probes"]:
        n = probe["id"]
        name = probe["name"]
        status = probe["status"].upper()
        detail = probe["detail"]
        fix = probe.get("fix")
        ms = probe.get("latency_ms")

        ms_str = f"  ({ms}ms)" if ms is not None else ""

        if use_color:
            if status == "PASS":
                color = GREEN
            elif status == "FAIL":
                color = RED
            else:
                color = YELLOW
            print(f"  [{n}/{total}] {name} {'.' * max(1, 40 - len(name))} {color}{status}{NC}{ms_str}")
        else:
            print(f"  [{n}/{total}] {name} {'.' * max(1, 40 - len(name))} {status}{ms_str}")

        if detail:
            print(f"         {detail}")
        if fix and status == "FAIL":
            print(f"         → Fix: {fix}")

    print()
    passed = report["passed"]
    if report["ok"]:
        summary = f"PASS — {passed}/{total} probes passed"
        print(f"{GREEN}{summary}{NC}" if use_color else summary)
    else:
        failed = [p for p in report["probes"] if p["status"] == "fail"]
        summary = f"FAIL — {passed}/{total} probes passed ({len(failed)} failed)"
        print(f"{RED}{summary}{NC}" if use_color else summary)
    print()

    if args.json:
        print(json.dumps(report, indent=2))

    return 0 if report["ok"] else 1


def cmd_register(args: argparse.Namespace) -> int:
    """Register agent with TuneVault cloud. Writes /etc/tunevault/agent.yaml."""
    import urllib.request as _ureq
    import urllib.error as _uerr

    token = args.token or os.environ.get("TUNEVAULT_TOKEN", "")
    api_url = args.api_url or os.environ.get("TUNEVAULT_API", "https://tunevault.app")

    if not token:
        sys.exit("ERROR: --token is required (or set TUNEVAULT_TOKEN env var)")

    log.info("Registering with %s ...", api_url)

    payload = json.dumps({"token": token}).encode("utf-8")
    req = _ureq.Request(
        f"{api_url.rstrip('/')}/api/agent/provision",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with _ureq.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read())
    except _uerr.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        sys.exit(f"ERROR: Provision failed HTTP {exc.code}: {error_body}")
    except Exception as exc:
        sys.exit(f"ERROR: Provision request failed: {exc}")

    connection_id = body.get("connection_id")
    api_key = body.get("api_key")
    returned_url = body.get("api_url") or api_url

    if not connection_id or not api_key:
        sys.exit(f"ERROR: Unexpected provision response: {body}")

    # Write agent.yaml
    cfg = {
        "api_url": returned_url,
        "api_key": api_key,
        "connection_id": connection_id,
        # DB fields will be populated by /connections wizard after service selection
        "host": "",
        "port": 1521,
        "service_name": "",
        "username": "",
        "password": "",
    }
    _save_config(cfg, path=args.config or CONFIG_PATH)

    log.info("Registered — connection_id=%s", connection_id)
    print(f"✓ Registered — connection_id={connection_id}")
    print(f"  Config written to: {args.config or CONFIG_PATH}")
    print(f"  Next: tunevault-agent diagnose")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    """Start the agent (foreground). systemd runs this.

    Three-phase startup — process lifecycle is DECOUPLED from Oracle connectivity.

    Phase 1 — Network bootstrap (only legit exit path):
      Load config, verify api_key + connection_id, POST /api/agent/register
      to confirm cloud reachability. If this fails → log a single ERROR + exit 1.

    Phase 2 — Heartbeat loop starts immediately:
      Long-poll + standalone heartbeat thread begin with agent_status='starting'.
      Cloud sees the agent as alive immediately regardless of Oracle state.

    Phase 3 — Oracle worker (supervised, isolated):
      Daemon thread attempts Oracle connection. On failure: sets
      agent_status='oracle_unreachable', persists error dict, sleeps 60s, retries.
      On success: agent_status='healthy'. NEVER exits the process.
    """
    import urllib.request as _ureq
    import urllib.error as _uerr
    import threading
    from agent.poll import PollConfig, run_poll_loop
    from agent.oracle_worker import AgentState, start_oracle_worker_thread

    cfg_data = _load_config(args.config or CONFIG_PATH)

    api_url = cfg_data.get("api_url", "").rstrip("/")
    api_key = cfg_data.get("api_key", "")
    connection_id = cfg_data.get("connection_id", 0)

    # ── Phase 1: Network bootstrap ────────────────────────────────────────────
    if not api_key or not connection_id:
        log.error(
            "FATAL: api_key and connection_id are required. "
            "Run: tunevault-agent register --token <TOKEN>"
        )
        return 1

    if not api_url:
        log.error("FATAL: api_url not set in config.")
        return 1

    log.info("TuneVault Agent v%s starting — connection_id=%s", VERSION, connection_id)

    # Verify cloud reachability: POST /api/agent/register (lightweight presence check).
    # This is the ONLY phase where we exit on failure.
    import json as _json
    try:
        import socket as _socket
        _socket.setdefaulttimeout(15)
        reg_payload = _json.dumps({
            "connection_id": connection_id,
            "agent_version": VERSION,
            "event": "agent_start",
        }).encode("utf-8")
        reg_req = _ureq.Request(
            f"{api_url}/api/agent/heartbeat",
            data=reg_payload,
            headers={
                "Content-Type": "application/json",
                "X-TuneVault-Key": api_key,
            },
            method="POST",
        )
        with _ureq.urlopen(reg_req, timeout=15) as resp:
            resp.read()  # consume body
        log.info("Phase 1 complete — cloud reachable, heartbeat acknowledged")
    except _uerr.HTTPError as exc:
        if exc.code == 401 or exc.code == 403:
            log.error(
                "FATAL: API key rejected by cloud (HTTP %d). "
                "Run: tunevault-agent rotate-key <new-key>",
                exc.code,
            )
            return 1
        # Non-auth HTTP error is not fatal — cloud may be deploying; Phase 2 will retry
        log.warning("Phase 1: cloud returned HTTP %d — continuing anyway (Phase 2 will retry)", exc.code)
    except Exception as exc:
        # Network unreachable at startup — don't block the agent from running
        # (the poll loop's backoff will handle reconnection).
        log.warning("Phase 1: could not reach cloud (%s) — continuing anyway", exc)

    # ── Phase 2: Shared state + poll loop ─────────────────────────────────────
    # AgentState is shared between the oracle worker and the poll loop metadata.
    # Initial status: 'starting' — becomes 'healthy' or 'oracle_unreachable'.
    state = AgentState()

    poll_cfg = PollConfig(
        api_url=api_url,
        api_key=api_key,
        connection_id=connection_id,
        db_host=cfg_data.get("host", ""),
        db_port=int(cfg_data.get("port", 1521) or 1521),
        db_service_name=cfg_data.get("service_name", ""),
        db_username=cfg_data.get("username", ""),
        db_password=cfg_data.get("password", ""),
        agent_state=state,
    )

    stop_event = threading.Event()

    # ── Phase 3: Oracle worker thread ─────────────────────────────────────────
    # Starts immediately but never blocks the poll loop or exits on Oracle failure.
    # api_url is passed so the worker can download Instant Client on verifier-mismatch.
    start_oracle_worker_thread(
        state=state,
        db_host=poll_cfg.db_host,
        db_port=poll_cfg.db_port,
        db_service_name=poll_cfg.db_service_name,
        db_username=poll_cfg.db_username,
        db_password=poll_cfg.db_password,
        stop_event=stop_event,
        api_url=api_url,
    )

    log.info(
        "Phase 2+3 running — poll loop + Oracle worker started. "
        "DB: %s:%d/%s",
        poll_cfg.db_host, poll_cfg.db_port, poll_cfg.db_service_name,
    )

    try:
        run_poll_loop(poll_cfg, stop_event)
    except KeyboardInterrupt:
        log.info("Shutdown requested")
        stop_event.set()

    return 0


def cmd_repair(args: argparse.Namespace) -> int:
    """Re-install Python deps and restart systemd service."""
    import subprocess

    print("Repairing TuneVault Agent...")

    # Re-install packages into existing venv
    venv_pip = "/opt/tunevault/venv/bin/pip"
    if not os.path.exists(venv_pip):
        sys.exit("ERROR: Venv not found at /opt/tunevault/venv — run full installer first")

    packages = ["python-oracledb", "paramiko", "requests", "pyyaml", "cryptography"]
    log.info("Re-installing: %s", " ".join(packages))
    result = subprocess.run([venv_pip, "install", "--upgrade"] + packages, check=False)
    if result.returncode != 0:
        sys.exit("ERROR: pip install failed")

    # Restart service
    subprocess.run(["systemctl", "restart", "tunevault-agent"], check=False)
    time.sleep(3)

    # Diagnose
    print("\nPost-repair diagnostics:")
    return cmd_diagnose(args)


def _read_agent_env(path: str) -> List[str]:
    """Read /etc/tunevault/agent.env lines. Returns [] if file missing."""
    try:
        with open(path) as f:
            return f.readlines()
    except FileNotFoundError:
        return []
    except Exception as exc:
        sys.exit(f"ERROR: Cannot read {path}: {exc}")


def _write_agent_env_atomic(path: str, lines: List[str]) -> None:
    """Write lines to agent.env atomically (tempfile + os.rename). Creates dir if needed."""
    import tempfile
    env_dir = os.path.dirname(path)
    try:
        os.makedirs(env_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=env_dir, prefix=".agent-env-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write("".join(lines))
            os.chmod(tmp_path, 0o600)
            os.rename(tmp_path, path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            raise
    except Exception as exc:
        sys.exit(f"ERROR: Cannot write {path}: {exc}")


def _restart_agent_service() -> bool:
    """Restart tunevault-agent (or tunevault-proxy fallback). Returns True on success."""
    import subprocess
    for svc in ("tunevault-agent", "tunevault-proxy"):
        try:
            r = subprocess.run(
                ["systemctl", "restart", svc],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=30,  # capture_output/text=3.7+
            )
            if r.returncode == 0:
                log.info("Restarted %s", svc)
                return True
        except Exception:
            pass
    return False


def _poll_agent_health(api_url: str, max_wait_s: float = 30.0) -> bool:
    """Poll /api/health until 200 or timeout. Returns True if healthy."""
    import urllib.request as _ureq
    import urllib.error as _uerr
    deadline = time.monotonic() + max_wait_s
    while time.monotonic() < deadline:
        try:
            with _ureq.urlopen(f"{api_url.rstrip('/')}/api/health", timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def cmd_rotate_key(args: argparse.Namespace) -> int:
    """Atomically rotate the API key in agent.env and restart the agent service.

    Protocol:
      1. Validate new key (≥32 chars).
      2. Refuse if dual-config drift detected (probe 8 logic).
      3. Atomic write to /etc/tunevault/agent.env.
      4. systemctl restart tunevault-agent.
      5. Poll /api/health until 200 (max 30s).
      6. Print ✓ Key rotated, agent restarted, health 200.
    """
    agent_env = args.env_path or "/etc/tunevault/agent.env"
    new_key = args.new_key.strip()

    if len(new_key) < 32:
        sys.exit("ERROR: new-key must be at least 32 characters")

    # Refuse if dual-config drift exists — user must migrate-config first.
    drift = _detect_dual_config_drift(agent_env)
    if drift["has_overlap"]:
        print("ERROR: Dual-config drift detected. Run `tunevault-agent migrate-config` first.", file=sys.stderr)
        print(f"  Overlapping keys: {', '.join(drift['overlap_keys'])}", file=sys.stderr)
        return 1

    lines = _read_agent_env(agent_env)
    new_lines = [l for l in lines if not l.startswith("TUNEVAULT_API_KEY=")]
    new_lines.append(f"TUNEVAULT_API_KEY={new_key}\n")
    _write_agent_env_atomic(agent_env, new_lines)
    print(f"✓ API key written to {agent_env}")

    if not _restart_agent_service():
        print("⚠  Could not restart service via systemctl (not available or no matching unit).")
        print("   Manually restart: systemctl restart tunevault-agent")
        return 0

    print("✓ Agent service restarted")

    # Load api_url from config to poll health
    api_url = ""
    try:
        import yaml
        cfg_path = args.config or CONFIG_PATH
        with open(cfg_path) as f:
            cfg = yaml.safe_load(f) or {}
        api_url = cfg.get("api_url", "")
    except Exception:
        pass

    if api_url:
        time.sleep(2)  # short grace period for systemd restart
        if _poll_agent_health(api_url, max_wait_s=30.0):
            print("✓ Key rotated, agent restarted, health 200")
        else:
            print("⚠  Agent restarted but /api/health did not return 200 within 30s")
            print("   Check: journalctl -u tunevault-agent -n 30")
    else:
        print("✓ Key rotated, agent restarted (health check skipped — no api_url in config)")

    return 0


def cmd_config(args: argparse.Namespace) -> int:
    """Read or write a single key in /etc/tunevault/agent.env."""
    if not getattr(args, "config_action", None):
        sys.exit("ERROR: usage: tunevault-agent config {get|set} KEY [VALUE]")
    agent_env = "/etc/tunevault/agent.env"
    key = (args.key or "").strip()

    if not key:
        sys.exit("ERROR: KEY is required")

    if args.config_action == "get":
        lines = _read_agent_env(agent_env)
        for line in lines:
            if line.startswith(f"{key}="):
                print(line.split("=", 1)[1].rstrip("\n"))
                return 0
        print(f"(not set)")
        return 0

    elif args.config_action == "set":
        value = (args.value or "").strip()
        if not value:
            sys.exit("ERROR: VALUE is required for config set")

        # Refuse if dual-config drift for this specific key
        drift = _detect_dual_config_drift(agent_env)
        if key in drift.get("overlap_keys", []):
            print(f"ERROR: Key '{key}' is set in BOTH the systemd unit and agent.env.", file=sys.stderr)
            print("  Run `tunevault-agent migrate-config` first to consolidate.", file=sys.stderr)
            return 1

        lines = _read_agent_env(agent_env)
        new_lines = [l for l in lines if not l.startswith(f"{key}=")]
        new_lines.append(f"{key}={value}\n")
        _write_agent_env_atomic(agent_env, new_lines)
        print(f"✓ {key} set in {agent_env}")
        return 0

    else:
        sys.exit(f"ERROR: Unknown config action: {args.config_action}")


def _detect_dual_config_drift(agent_env_path: str = "/etc/tunevault/agent.env") -> dict:
    """Detect overlapping keys between systemd unit inline Environment= and agent.env.

    Returns:
        {
            "has_overlap": bool,
            "overlap_keys": List[str],           # keys present in BOTH sources
            "systemd_env_lines": List[str],       # all inline Environment= lines found
            "agent_env_keys": List[str],          # all keys found in agent.env
        }
    """
    import subprocess

    # 1. Parse inline Environment= from active systemd unit
    systemd_env_lines: List[str] = []
    systemd_env_keys: List[str] = []
    try:
        result = subprocess.run(
            ["systemctl", "cat", "tunevault-agent"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10,  # capture_output/text=3.7+
        )
        if result.returncode != 0:
            # Try legacy service name
            result = subprocess.run(
                ["systemctl", "cat", "tunevault-proxy"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=10,  # capture_output/text=3.7+
            )
        for line in result.stdout.splitlines():
            stripped = line.strip()
            if stripped.startswith("Environment=TUNEVAULT_"):
                systemd_env_lines.append(stripped)
                # Environment=KEY=value → extract KEY
                kv = stripped[len("Environment="):]
                key = kv.split("=", 1)[0]
                systemd_env_keys.append(key)
    except Exception:
        pass  # systemctl not available — no drift possible

    # 2. Parse keys from agent.env
    agent_env_keys: List[str] = []
    lines = _read_agent_env(agent_env_path)
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            agent_env_keys.append(stripped.split("=", 1)[0])

    overlap = list(set(systemd_env_keys) & set(agent_env_keys))

    return {
        "has_overlap": bool(overlap),
        "overlap_keys": overlap,
        "systemd_env_lines": systemd_env_lines,
        "agent_env_keys": agent_env_keys,
    }


def cmd_migrate_config(args: argparse.Namespace) -> int:
    """Consolidate inline systemd Environment= directives into agent.env.

    For boxes on v3/v4/v5 that have TUNEVAULT_* inline in the systemd unit:
      1. Read all inline Environment=TUNEVAULT_* from active unit.
      2. Merge into /etc/tunevault/agent.env (existing agent.env values WIN — newer preferred).
      3. Rewrite the systemd unit without inline Environment= lines.
      4. daemon-reload + restart.
      5. Print before/after diff.

    Safe to run on a clean v6 box (no-op if no inline Environment= found).
    """
    import subprocess
    import tempfile

    print("tunevault-agent migrate-config")
    print()

    agent_env = "/etc/tunevault/agent.env"
    drift = _detect_dual_config_drift(agent_env)

    if not drift["systemd_env_lines"]:
        print("✓ No inline Environment= directives found in systemd unit.")
        print("  Nothing to migrate — agent.env is the single source of truth.")
        return 0

    print(f"Found {len(drift['systemd_env_lines'])} inline Environment= directive(s):")
    for line in drift["systemd_env_lines"]:
        print(f"  {line}")
    print()

    # Step 1: Read current agent.env (existing values win)
    existing_lines = _read_agent_env(agent_env)
    existing_keys = {
        line.split("=", 1)[0]: line.rstrip("\n")
        for line in existing_lines
        if line.strip() and not line.strip().startswith("#") and "=" in line
    }

    # Step 2: Merge — only add keys from systemd that are NOT already in agent.env
    added_keys = []
    for env_line in drift["systemd_env_lines"]:
        kv = env_line[len("Environment="):]
        key, _, value = kv.partition("=")
        if key not in existing_keys:
            existing_lines.append(f"{key}={value}\n")
            added_keys.append(key)
            print(f"  + Adding to agent.env: {key}=<value>")
        else:
            print(f"  = Keeping existing agent.env value for: {key}")

    if added_keys:
        _write_agent_env_atomic(agent_env, existing_lines)
        print(f"\n✓ agent.env updated ({len(added_keys)} key(s) added)")
    else:
        print("\n  agent.env already has all keys — no changes needed")

    # Step 3: Rewrite systemd unit without inline Environment= lines
    # Locate the unit file path (first non-comment non-empty line in systemctl cat is the path)
    unit_path = ""
    try:
        result = subprocess.run(
            ["systemctl", "show", "-p", "FragmentPath", "--value", "tunevault-agent"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10,  # capture_output/text=3.7+
        )
        if result.returncode == 0:
            unit_path = result.stdout.strip()
        if not unit_path:
            result = subprocess.run(
                ["systemctl", "show", "-p", "FragmentPath", "--value", "tunevault-proxy"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=10,  # capture_output/text=3.7+
            )
            if result.returncode == 0:
                unit_path = result.stdout.strip()
    except Exception:
        pass

    if not unit_path or not os.path.exists(unit_path):
        print(f"\n⚠  Could not locate systemd unit file (tried tunevault-agent, tunevault-proxy).")
        print("   Manual step: remove inline Environment= lines from the unit and run:")
        print("   sudo systemctl daemon-reload && sudo systemctl restart tunevault-agent")
        return 0

    # Read unit, strip inline TUNEVAULT_* Environment= lines
    with open(unit_path) as f:
        unit_lines = f.readlines()

    before_count = len(unit_lines)
    cleaned_lines = [
        l for l in unit_lines
        if not l.strip().startswith("Environment=TUNEVAULT_")
    ]
    removed_count = before_count - len(cleaned_lines)

    print(f"\nRewriting {unit_path}")
    print(f"  Before: {before_count} lines")
    print(f"  Removed: {removed_count} inline Environment= line(s)")
    print(f"  After:  {len(cleaned_lines)} lines")

    # Atomic write
    unit_dir = os.path.dirname(unit_path)
    try:
        fd, tmp_unit = tempfile.mkstemp(dir=unit_dir, prefix=".tunevault-unit-")
        with os.fdopen(fd, "w") as f:
            f.writelines(cleaned_lines)
        os.rename(tmp_unit, unit_path)
    except Exception as exc:
        print(f"\n⚠  Could not rewrite unit file: {exc}", file=sys.stderr)
        print("   Check permissions: ls -l {unit_path}", file=sys.stderr)
        return 1

    # Step 4: daemon-reload + restart
    print()
    try:
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=15)
        print("✓ systemctl daemon-reload")
        subprocess.run(["systemctl", "restart", "tunevault-agent"], check=False, timeout=30)
        print("✓ systemctl restart tunevault-agent")
    except Exception as exc:
        print(f"⚠  Service restart failed: {exc}")
        print("   Manually: sudo systemctl daemon-reload && sudo systemctl restart tunevault-agent")

    print()
    print("✓ migrate-config complete")
    print("  Verify: sudo systemctl cat tunevault-agent  (should show zero inline Environment= lines)")
    print("  Verify: sudo tunevault-agent diagnose  (probe 8 should PASS)")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Single-command connectivity diagnosis — the first thing to run when 'the agent isn't connecting'.

    Checks (in order):
      1. AGENT IDENTITY   — agent.env readable, key fields present, systemd uptime
      2. CLOUD REACHABLE  — HTTPS GET /api/health, show HTTP status + latency
      3. REGISTRATION     — GET /api/agent/status to confirm cloud recognises this agent_id
      4. HEARTBEAT        — last heartbeat timestamp + age vs 90s alive threshold
      5. ORACLE TCP       — TCP connect to each configured host:port (no login)
      6. LAST ERROR       — most recent error from journalctl / oracle_worker state

    Flags:
      --json    emit all results as a single JSON object (machine-readable)

    Exit codes: 0 = all critical checks PASS, 1 = one or more FAIL
    """
    import socket
    import subprocess
    import urllib.request as _ureq
    import urllib.error as _uerr

    # ── Color helpers ─────────────────────────────────────────────────────────
    use_color = sys.stdout.isatty() and not getattr(args, "json", False)

    GREEN  = "\033[0;32m"  if use_color else ""
    YELLOW = "\033[1;33m"  if use_color else ""
    RED    = "\033[0;31m"  if use_color else ""
    BOLD   = "\033[1m"     if use_color else ""
    NC     = "\033[0m"     if use_color else ""

    def _fmt(status: str, label: str, detail: str, fix: str = "") -> str:
        if status == "PASS":
            tag = f"{GREEN}[PASS]{NC}"
        elif status == "WARN":
            tag = f"{YELLOW}[WARN]{NC}"
        elif status == "SKIP":
            tag = f"{YELLOW}[SKIP]{NC}"
        else:
            tag = f"{RED}[FAIL]{NC}"
        line = f"  {tag}  {BOLD}{label}{NC}"
        if detail:
            line += f"\n         {detail}"
        if fix and status in ("FAIL", "WARN"):
            line += f"\n         → Fix: {fix}"
        return line

    agent_env_path = "/etc/tunevault/agent.env"
    results: List[dict] = []  # each: {check, status, detail, fix, latency_ms}
    any_fail = False

    def _add(check: str, status: str, detail: str, fix: str = "",
             latency_ms: Optional[int] = None) -> None:
        nonlocal any_fail
        if status == "FAIL":
            any_fail = True
        results.append({
            "check": check,
            "status": status,
            "detail": detail,
            "fix": fix,
            "latency_ms": latency_ms,
        })

    print(f"\n{BOLD}TuneVault Agent v{VERSION} — Doctor{NC}\n")

    # ── 1. AGENT IDENTITY ─────────────────────────────────────────────────────
    env_data: Dict[str, str] = {}
    env_ok = False
    try:
        with open(agent_env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    env_data[k.strip()] = v.strip()
        api_key  = env_data.get("TUNEVAULT_API_KEY", "")
        api_url  = env_data.get("TUNEVAULT_API_URL", "") or env_data.get("TUNEVAULT_API", "")
        conn_id  = env_data.get("TUNEVAULT_CONNECTION_ID", "")
        db_host  = env_data.get("ORACLE_HOST", "")
        db_port_s = env_data.get("ORACLE_PORT", "1521")

        if not api_key:
            _add("AGENT IDENTITY", "FAIL", f"agent.env missing TUNEVAULT_API_KEY",
                 fix=f"Re-run installer or: tunevault-agent config set TUNEVAULT_API_KEY <key>")
        elif not api_url:
            _add("AGENT IDENTITY", "FAIL", f"agent.env missing TUNEVAULT_API_URL",
                 fix=f"tunevault-agent config set TUNEVAULT_API_URL https://tunevault.app")
        elif not conn_id:
            _add("AGENT IDENTITY", "FAIL", f"agent.env missing TUNEVAULT_CONNECTION_ID",
                 fix="Re-register: curl -fsSL https://tunevault.app/install.sh | sudo bash")
        else:
            env_ok = True
            key_preview = f"{api_key[:8]}…" if len(api_key) > 8 else api_key
            # Try to get systemd uptime
            uptime_detail = ""
            try:
                r = subprocess.run(
                    ["systemctl", "show", "tunevault-agent", "--property=ActiveEnterTimestamp"],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    universal_newlines=True, timeout=5,
                )
                ts_line = r.stdout.strip()
                if "=" in ts_line:
                    ts_val = ts_line.split("=", 1)[1].strip()
                    if ts_val and ts_val != "":
                        uptime_detail = f"  started={ts_val}"
            except Exception:
                pass
            _add("AGENT IDENTITY", "PASS",
                 f"key={key_preview}  url={api_url}  connection_id={conn_id}{uptime_detail}")
    except FileNotFoundError:
        _add("AGENT IDENTITY", "FAIL",
             f"agent.env not found at {agent_env_path}",
             fix="Re-run installer: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash")
    except Exception as exc:
        _add("AGENT IDENTITY", "FAIL", f"Cannot read {agent_env_path}: {exc}",
             fix=f"Check file permissions: ls -l {agent_env_path}")

    # ── 2. CLOUD REACHABILITY ────────────────────────────────────────────────
    cloud_url = api_url if env_ok else "https://tunevault.app"
    health_url = f"{cloud_url.rstrip('/')}/api/health"
    t0 = time.monotonic()
    try:
        req = _ureq.Request(health_url, method="GET")
        with _ureq.urlopen(req, timeout=10) as resp:
            latency_ms = round((time.monotonic() - t0) * 1000)
            http_status = resp.status
        if http_status == 200:
            _add("CLOUD REACHABLE", "PASS",
                 f"GET {health_url} → HTTP {http_status} ({latency_ms}ms)",
                 latency_ms=latency_ms)
        else:
            _add("CLOUD REACHABLE", "FAIL",
                 f"GET {health_url} → HTTP {http_status} ({latency_ms}ms)",
                 fix="Check https://status.tunevault.app",
                 latency_ms=latency_ms)
    except _uerr.HTTPError as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        hint = {
            401: "token invalid",
            403: "connection paused",
            404: "wrong URL — verify TUNEVAULT_API_URL",
            503: "cloud issue — check status.tunevault.app",
        }.get(exc.code, f"unexpected HTTP {exc.code}")
        _add("CLOUD REACHABLE", "FAIL",
             f"GET {health_url} → HTTP {exc.code}: {hint} ({latency_ms}ms)",
             fix="Check TUNEVAULT_API_URL in agent.env",
             latency_ms=latency_ms)
    except socket.timeout:
        latency_ms = round((time.monotonic() - t0) * 1000)
        _add("CLOUD REACHABLE", "FAIL",
             f"GET {health_url} → timeout after {latency_ms}ms",
             fix="Check outbound HTTPS/443 from this host (firewall, proxy, egress rules)")
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        _add("CLOUD REACHABLE", "FAIL",
             f"GET {health_url} → {type(exc).__name__}: {exc}",
             fix="DNS resolution or TLS failure — check outbound HTTPS/443",
             latency_ms=latency_ms)

    # ── 3. REGISTRATION STATUS ───────────────────────────────────────────────
    if env_ok:
        status_url = f"{cloud_url.rstrip('/')}/api/agent/status?connection_id={conn_id}"
        t0 = time.monotonic()
        try:
            req = _ureq.Request(
                status_url,
                headers={"X-TuneVault-Key": api_key},
            )
            with _ureq.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read())
            latency_ms = round((time.monotonic() - t0) * 1000)
            registered = body.get("registered", False)
            reg_status = body.get("status", "unknown")
            if registered:
                _add("REGISTRATION", "PASS",
                     f"Cloud recognises connection_id={conn_id}  status={reg_status} ({latency_ms}ms)",
                     latency_ms=latency_ms)
            else:
                _add("REGISTRATION", "FAIL",
                     f"Cloud returned registered=false  status={reg_status} ({latency_ms}ms)",
                     fix="Re-run installer with a fresh token from the TuneVault UI",
                     latency_ms=latency_ms)
        except _uerr.HTTPError as exc:
            latency_ms = round((time.monotonic() - t0) * 1000)
            if exc.code in (401, 403):
                _add("REGISTRATION", "FAIL",
                     f"API key rejected by cloud (HTTP {exc.code}) ({latency_ms}ms)",
                     fix="tunevault-agent rotate-key <new-key>",
                     latency_ms=latency_ms)
            else:
                _add("REGISTRATION", "FAIL",
                     f"Status check failed HTTP {exc.code} ({latency_ms}ms)",
                     fix="Check cloud reachability (check 2 above)",
                     latency_ms=latency_ms)
        except Exception as exc:
            latency_ms = round((time.monotonic() - t0) * 1000)
            _add("REGISTRATION", "FAIL",
                 f"Status check error: {exc} ({latency_ms}ms)",
                 fix="Verify cloud reachability first",
                 latency_ms=latency_ms)
    else:
        _add("REGISTRATION", "SKIP", "Skipped — agent.env not readable")

    # ── 4. HEARTBEAT ─────────────────────────────────────────────────────────
    if env_ok:
        hb_url = f"{cloud_url.rstrip('/')}/api/agent/heartbeat-check?connection_id={conn_id}"
        t0 = time.monotonic()
        try:
            req = _ureq.Request(
                hb_url,
                headers={"X-TuneVault-Key": api_key},
            )
            with _ureq.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read())
            latency_ms = round((time.monotonic() - t0) * 1000)
            alive = body.get("alive", False)
            seconds_ago = body.get("seconds_ago")
            last_hb = body.get("last_heartbeat_at", "")
            if alive:
                _add("HEARTBEAT", "PASS",
                     f"Last heartbeat {seconds_ago}s ago  (alive threshold=90s)  last_at={last_hb}",
                     latency_ms=latency_ms)
            elif seconds_ago is not None:
                threshold = 90
                _add("HEARTBEAT", "FAIL",
                     f"Last heartbeat {seconds_ago}s ago — exceeds {threshold}s alive threshold  last_at={last_hb}",
                     fix="sudo systemctl restart tunevault-agent  then re-check",
                     latency_ms=latency_ms)
            else:
                _add("HEARTBEAT", "WARN",
                     "No heartbeat recorded yet — agent may not have started polling",
                     fix="sudo systemctl start tunevault-agent",
                     latency_ms=latency_ms)
        except _uerr.HTTPError as exc:
            latency_ms = round((time.monotonic() - t0) * 1000)
            if exc.code == 404:
                # Connection ID unknown to cloud — registration likely failed
                _add("HEARTBEAT", "FAIL",
                     f"connection_id={conn_id} not found on cloud (HTTP 404) ({latency_ms}ms)",
                     fix="Re-register agent with a fresh token from TuneVault UI",
                     latency_ms=latency_ms)
            else:
                _add("HEARTBEAT", "FAIL",
                     f"Heartbeat check failed HTTP {exc.code} ({latency_ms}ms)",
                     fix="Check cloud reachability",
                     latency_ms=latency_ms)
        except Exception as exc:
            latency_ms = round((time.monotonic() - t0) * 1000)
            _add("HEARTBEAT", "FAIL",
                 f"Heartbeat check error: {exc}",
                 fix="Check cloud reachability (check 2 above)",
                 latency_ms=latency_ms)
    else:
        _add("HEARTBEAT", "SKIP", "Skipped — agent.env not readable")

    # ── 5. ORACLE TCP REACHABILITY ───────────────────────────────────────────
    # Probe TCP only — no Oracle login. Reads host:port from agent.env.
    # Falls back to agent.yaml if env keys absent.
    oracle_targets: List[tuple] = []  # list of (host, port_int)

    if env_ok and db_host:
        try:
            oracle_targets.append((db_host, int(db_port_s or "1521")))
        except ValueError:
            pass

    # Also check agent.yaml if we can read it
    cfg_yaml_path = getattr(args, "config", None) or CONFIG_PATH
    try:
        import yaml  # type: ignore[import]
        with open(cfg_yaml_path) as f:
            cfg_data = yaml.safe_load(f) or {}
        yaml_host = cfg_data.get("host", "")
        yaml_port = int(cfg_data.get("port", 1521) or 1521)
        if yaml_host and (yaml_host, yaml_port) not in oracle_targets:
            oracle_targets.append((yaml_host, yaml_port))
    except Exception:
        pass

    if oracle_targets:
        for (h, p) in oracle_targets:
            t0 = time.monotonic()
            try:
                sock = socket.create_connection((h, p), timeout=5)
                sock.close()
                latency_ms = round((time.monotonic() - t0) * 1000)
                _add("ORACLE TCP", "PASS",
                     f"TCP {h}:{p} → connected ({latency_ms}ms)",
                     latency_ms=latency_ms)
            except socket.timeout:
                latency_ms = round((time.monotonic() - t0) * 1000)
                _add("ORACLE TCP", "FAIL",
                     f"TCP {h}:{p} → timeout after {latency_ms}ms",
                     fix=f"Check firewall/listener: lsnrctl status  |  telnet {h} {p}")
            except OSError as exc:
                latency_ms = round((time.monotonic() - t0) * 1000)
                _add("ORACLE TCP", "FAIL",
                     f"TCP {h}:{p} → {exc.strerror} ({exc.errno})",
                     fix=f"Check Oracle listener is running: lsnrctl status",
                     latency_ms=latency_ms)
    else:
        _add("ORACLE TCP", "SKIP",
             "No Oracle host configured in agent.env or agent.yaml — skip TCP probe")

    # ── 6. LAST ERROR ─────────────────────────────────────────────────────────
    # Try journalctl for recent agent errors, then fall back to skip.
    last_error_found = False
    try:
        r = subprocess.run(
            [
                "journalctl", "-u", "tunevault-agent",
                "--no-pager", "-n", "50",
                "--output=cat",
                "-p", "err",
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10,
        )
        lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
        if lines:
            # Show last 3 error lines verbatim
            snippet = "\n         ".join(lines[-3:])
            _add("LAST ERROR", "WARN",
                 f"Recent systemd error log (last 3 lines):\n         {snippet}",
                 fix="Full log: journalctl -u tunevault-agent -n 100 --no-pager")
            last_error_found = True
    except FileNotFoundError:
        pass  # journalctl not available (non-systemd)
    except Exception:
        pass

    if not last_error_found:
        # Try reading the oracle_worker state-dump path if any logs exist
        _add("LAST ERROR", "SKIP", "No recent error log entries found via journalctl")

    # ── Output ────────────────────────────────────────────────────────────────
    if not getattr(args, "json", False):
        for r in results:
            print(_fmt(r["status"], r["check"],
                       r["detail"] + (f"  ({r['latency_ms']}ms)" if r.get("latency_ms") is not None and r["status"] != "PASS" else ""),
                       r.get("fix", "")))
        print()
        total   = len([r for r in results if r["status"] != "SKIP"])
        passed  = sum(1 for r in results if r["status"] == "PASS")
        failed  = sum(1 for r in results if r["status"] == "FAIL")
        warned  = sum(1 for r in results if r["status"] == "WARN")
        if not any_fail:
            print(f"{GREEN}✓ All critical checks passed ({passed}/{total}){NC}")
        else:
            print(f"{RED}✗ {failed} check(s) failed — see FAIL entries above{NC}")
        print()
    else:
        # --json: emit canonical JSON object
        out = {
            "version": VERSION,
            "ran_at": _utc_now_iso(),
            "ok": not any_fail,
            "checks": results,
        }
        print(json.dumps(out, indent=2))

    return 1 if any_fail else 0


def _utc_now_iso() -> str:
    """Return current UTC time as ISO-8601 string. Python 3.6 safe."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_upgrade(args: argparse.Namespace) -> int:
    """Upgrade agent in place: download latest installer, run --upgrade."""
    import subprocess
    import tempfile
    import urllib.request as _ureq

    api_url = args.api_url or os.environ.get("TUNEVAULT_API", "https://tunevault.app")
    installer_url = f"{api_url.rstrip('/')}/install.sh"
    sha256_url = f"{api_url.rstrip('/')}/install.sh.sha256"

    print(f"Downloading installer from {installer_url} ...")
    with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as tmp:
        tmp_path = tmp.name
        with _ureq.urlopen(installer_url, timeout=30) as resp:
            tmp.write(resp.read())

    # SHA256 verify
    try:
        with _ureq.urlopen(sha256_url, timeout=10) as resp:
            expected_sha = resp.read().decode().strip().split()[0]
        import hashlib
        with open(tmp_path, "rb") as f:
            actual_sha = hashlib.sha256(f.read()).hexdigest()
        if expected_sha and actual_sha != expected_sha:
            os.unlink(tmp_path)
            sys.exit(f"ERROR: SHA256 mismatch — expected {expected_sha[:12]}, got {actual_sha[:12]}")
        print(f"✓ SHA256 verified ({actual_sha[:12]}...)")
    except Exception as exc:
        print(f"Warning: SHA256 check skipped: {exc}")

    os.chmod(tmp_path, 0o755)
    print("Running installer --upgrade ...")
    result = subprocess.run(["bash", tmp_path, "--upgrade"], check=False)
    os.unlink(tmp_path)

    if result.returncode != 0:
        sys.exit("ERROR: Upgrade installer failed")

    print("\nPost-upgrade diagnostics:")
    return cmd_diagnose(args)


# ── Entry point ───────────────────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tunevault-agent",
        description=f"TuneVault Agent v{VERSION} — pure-Python Oracle health monitoring",
    )
    parser.add_argument("--config", default=None, help="Path to agent.yaml (default: /etc/tunevault/agent.yaml)")
    parser.add_argument("--json", action="store_true", help="Output JSON (diagnose subcommand)")

    # required=True is Python 3.7+ — manual check below for 3.6 compat
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("start", help="Start the poll loop (foreground)")
    sub.add_parser("version", help="Print version and exit")

    d = sub.add_parser("diagnose", help="Run 7 probes and print results")
    d.add_argument("--json", action="store_true", help="Output JSON")

    r = sub.add_parser("register", help="Register with TuneVault cloud")
    r.add_argument("--token", default=None, help="Registration token from TuneVault UI")
    r.add_argument("--api-url", default=None, help="TuneVault API URL override")

    sub.add_parser("repair", help="Re-install deps and restart service")

    u = sub.add_parser("upgrade", help="Upgrade agent in place")
    u.add_argument("--api-url", default=None, help="TuneVault API URL override")

    # ── Config hardening subcommands (v6.1) ───────────────────────────────
    rk = sub.add_parser("rotate-key", help="Atomically rotate API key in agent.env and restart")
    rk.add_argument("new_key", help="New API key (min 32 chars)")
    rk.add_argument("--env-path", default=None, help="Path to agent.env (default: /etc/tunevault/agent.env)")

    cfg_parser = sub.add_parser("config", help="Read or write agent.env values")
    cfg_sub = cfg_parser.add_subparsers(dest="config_action")
    cfg_get = cfg_sub.add_parser("get", help="Read a value from agent.env")
    cfg_get.add_argument("key", help="Key name (e.g. TUNEVAULT_API_KEY)")
    cfg_set = cfg_sub.add_parser("set", help="Atomically write a value to agent.env")
    cfg_set.add_argument("key", help="Key name")
    cfg_set.add_argument("value", help="Value to set")

    sub.add_parser("migrate-config", help="Consolidate inline systemd Environment= into agent.env")

    doc = sub.add_parser("doctor", help="Connectivity diagnosis — 6 checks, clear PASS/FAIL output")
    doc.add_argument("--json", action="store_true", help="Emit results as JSON")

    args = parser.parse_args(argv)

    dispatch = {
        "version": cmd_version,
        "diagnose": cmd_diagnose,
        "register": cmd_register,
        "start": cmd_start,
        "repair": cmd_repair,
        "upgrade": cmd_upgrade,
        "rotate-key": cmd_rotate_key,
        "config": cmd_config,
        "migrate-config": cmd_migrate_config,
        "doctor": cmd_doctor,
    }
    handler = dispatch.get(args.command)
    if not handler:
        parser.print_help()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
