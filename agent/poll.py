"""
agent/poll.py — Outbound HTTPS long-poll loop.
Owns: cloud communication lifecycle, heartbeat, work dispatch, result submission,
      3-tier watchdog (tier1=warn@60s, tier2=degraded@300s, tier3=exit after 300s sustained).
Does NOT own: Oracle queries (agent/db.py), SSH (agent/ssh.py), CLI (agent/cli.py).

Architecture:
  - Agent connects outbound to TuneVault cloud via HTTPS (no inbound ports)
  - POST /api/agent/poll with metadata → cloud holds connection ≤25s
  - If work arrives: execute locally, POST /api/agent/respond with result
  - If no work: loop immediately (heartbeat)
  - Exponential backoff on network errors (jitter, cap = AGENT_POLL_BACKOFF_MAX_S)
  - Watchdog: tier1 warn at AGENT_WATCHDOG_DEGRADED_S, exit at AGENT_WATCHDOG_RESTART_S
  - Before exit: POST /api/agent/restart-reason so cloud surfaces reason in UI

No Cloudflare. No tunnels. No DNS. Zero inbound ports.
"""


import json
import logging
import os
import random
import sys
import threading
import time
import urllib.error as _uerr
import urllib.request as _ureq
import uuid
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("tunevault.poll")

# Current agent version — must match agent/__init__.py
from agent import VERSION

# Re-check thin mode at module load
try:
    import oracledb  # type: ignore[import]
    assert oracledb.is_thin_mode(), "oracledb must be in thin mode"
except ImportError:
    pass  # probes.py will surface this


class PollConfig:
    """Runtime configuration for the poll loop."""

    __slots__ = (
        "api_url", "api_key", "connection_id",
        "db_host", "db_port", "db_service_name",
        "db_username", "db_password",
        "agent_version",
        "agent_state",  # AgentState instance shared with oracle_worker
    )

    def __init__(
        self,
        api_url: str,
        api_key: str,
        connection_id: int,
        db_host: str = "",
        db_port: int = 1521,
        db_service_name: str = "",
        db_username: str = "",
        db_password: str = "",
        agent_state: "Optional[Any]" = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.connection_id = int(connection_id)
        self.db_host = db_host
        self.db_port = db_port
        self.db_service_name = db_service_name
        self.db_username = db_username
        self.db_password = db_password
        self.agent_version = VERSION
        self.agent_state = agent_state  # None until oracle_worker sets up state


def _post_json(url: str, payload: dict, api_key: str, timeout: float = 35.0) -> Tuple[int, dict]:
    """POST JSON, return (status_code, parsed_body). Raises on network error."""
    data = json.dumps(payload).encode("utf-8")
    req = _ureq.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-TuneVault-Key": api_key,
        },
        method="POST",
    )
    try:
        with _ureq.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
            return resp.status, body
    except _uerr.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8", errors="replace"))
        except Exception:
            body = {"error": str(exc)}
        return exc.code, body


def _build_metadata(cfg: PollConfig) -> Dict[str, Any]:
    """Metadata sent with every poll (heartbeat info for server-side tracking).

    Includes agent_status + oracle error + oracle_mode fields from AgentState
    when available.  oracle_mode / instant_client_path / verifier_workaround_active
    are the thick-mode fallback surface — the cloud dashboard reads them to show
    DBAs exactly what connection mode their agent is using.
    """
    import platform
    base = {
        "connection_id": cfg.connection_id,
        "agent_version": VERSION,
        "python_version": "%d.%d.%d" % sys.version_info[:3],
        "platform": sys.platform,
        "arch": platform.machine(),
    }
    if cfg.agent_state is not None:
        # Merge in oracle worker status fields — never raise if AgentState is misconfigured
        try:
            base.update(cfg.agent_state.get_heartbeat_fields())
        except Exception:
            pass
    return base


def _execute_work(cfg: PollConfig, work: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch a work item received from the cloud.

    Returns: {"status_code": int, "body": dict}

    Work item schema:
      {
        "request_id": str,
        "method": str,       # "POST" | "GET"
        "path": str,         # e.g. "/api/healthcheck"
        "body": dict,
      }
    """
    method = work.get("method", "GET").upper()
    path = work.get("path", "/")
    body = work.get("body") or {}

    log.info("Work: %s %s", method, path)

    try:
        return _dispatch(cfg, method, path, body)
    except Exception as exc:
        log.error("Work execution error for %s %s: %s", method, path, exc, exc_info=True)
        return {"status_code": 500, "body": {"error": str(exc)}}


def _dispatch(cfg: PollConfig, method: str, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Route a work item to the correct handler."""

    # ── Health check (no-auth self-probe) ─────────────────────────────────
    if path in ("/health", "/api/health"):
        oracle_mode = "thin"
        try:
            import oracledb  # type: ignore[import]
            oracle_mode = "thin" if oracledb.is_thin_mode() else "thick"
        except Exception:
            pass
        return {
            "status_code": 200,
            "body": {
                "status": "healthy",
                "agent": "TuneVault Agent",
                "version": VERSION,
                "mode": oracle_mode,
                "oracle_mode": oracle_mode,
            },
        }

    # ── Agent health (DBAs: oracle mode + thick state) ─────────────────────
    if path in ("/agent/health", "/api/agent/health"):
        return _handle_agent_health(cfg)

    # ── Diagnostics ───────────────────────────────────────────────────────
    if path == "/api/run-diagnostics":
        from agent.probes import run_all
        report = run_all()
        return {"status_code": 200, "body": report}

    # ── Ping / smoke test ─────────────────────────────────────────────────
    if path == "/api/ping":
        return _handle_ping(cfg)

    # ── Oracle health check (the main payload) ─────────────────────────────
    if path == "/api/healthcheck":
        return _handle_healthcheck(cfg, body)

    # ── SQL execution (SQL console) ────────────────────────────────────────
    if path == "/api/execute-sql":
        return _handle_execute_sql(cfg, body)

    # ── SSH command execution ──────────────────────────────────────────────
    if path == "/api/ssh-exec":
        return _handle_ssh_exec(body)

    # ── SSH connectivity test (from UI wizard "Test SSH" button) ───────────
    if path == "/api/ssh-test":
        return _handle_ssh_test(body)

    # ── OS command execution (whitelisted) ────────────────────────────────
    if path == "/api/os-exec":
        return _handle_os_exec(body)

    # ── Self-upgrade (triggered from TuneVault cloud UI) ──────────────
    if path == "/api/self-upgrade":
        return _handle_self_upgrade(body)

    # ── Cloud-managed API key rotation ────────────────────────────────
    if path == "/api/rotate-key":
        return _handle_rotate_key(cfg, body)

    # ── Re-run probe 5 (oracle service re-discovery) ─────────────────────
    if path == "/api/run-probe5":
        return _handle_run_probe5(cfg)

    # ── Retire: /api/test always returns 410 in v6 ────────────────────────
    if path == "/api/test":
        return {
            "status_code": 410,
            "body": {
                "error": "Gone",
                "message": "Direct-connect endpoint retired in v6. Use tunevault-agent diagnose",
            },
        }

    log.warning("Unknown path: %s %s", method, path)
    return {"status_code": 404, "body": {"error": f"Unknown path: {path}"}}


def _handle_agent_health(cfg: PollConfig) -> Dict[str, Any]:
    """Return oracle_mode, instant_client_path, verifier_workaround_active.

    This is the canonical endpoint the TuneVault cloud dashboard reads to display
    exactly what Oracle connection mode the agent is using. DBAs can see at a glance:
      - thin: pure-Python TCP, no Instant Client
      - thick: Instant Client active (DPY-3015 / verifier-mismatch self-healed)

    Response:
      {
        "oracle_mode": "thin" | "thick",
        "instant_client_path": str | null,
        "verifier_workaround_active": bool,
        "agent_version": str,
        "agent_status": str,
      }
    """
    import oracledb  # type: ignore[import]

    oracle_mode = "thin" if oracledb.is_thin_mode() else "thick"

    # Prefer live state from AgentState if available (has instant_client_path + workaround flag)
    health_fields = {
        "oracle_mode": oracle_mode,
        "instant_client_path": None,
        "verifier_workaround_active": False,
    }
    if cfg.agent_state is not None:
        try:
            health_fields.update(cfg.agent_state.get_health_fields())
        except Exception:
            pass

    return {
        "status_code": 200,
        "body": {
            **health_fields,
            "agent_version": VERSION,
            "agent_status": (
                cfg.agent_state.agent_status
                if cfg.agent_state is not None
                else "unknown"
            ),
        },
    }


def _handle_ping(cfg: PollConfig) -> Dict[str, Any]:
    import socket as _socket
    from agent.db import DBConfig, ping as db_ping
    t0 = time.monotonic()

    db_result = {"ok": False, "latency_ms": None, "oracle_version": None, "error": "No DB config"}
    if cfg.db_host and cfg.db_service_name:
        db_cfg = DBConfig(
            host=cfg.db_host,
            port=cfg.db_port,
            service_name=cfg.db_service_name,
            username=cfg.db_username,
            password=cfg.db_password,
        )
        db_result = db_ping(db_cfg)

    return {
        "status_code": 200,
        "body": {
            "ok": True,
            "agent_version": VERSION,
            "hostname": _socket.gethostname(),
            "oracle_listener_up": db_result["ok"],
            "sample_query_ms": db_result.get("latency_ms"),
            "oracle_version": db_result.get("oracle_version"),
            "roundtrip_ms": round((time.monotonic() - t0) * 1000),
            "mode": "thin",
        },
    }


def _handle_healthcheck(cfg: PollConfig, body: Dict[str, Any]) -> Dict[str, Any]:
    """Execute the Oracle health check.

    The cloud sends DB credentials in the body (encrypted in transit).
    Falls back to config file credentials if body has none.
    Delegates the actual heavy SQL to oracle-client.js equivalent which
    is imported via the legacy shim until the full Python port is complete.

    For now: returns a thin-mode capability report. The full health check
    SQL catalog migration from oracle-client.js is Phase 2 of this task.
    """
    from agent.db import DBConfig, run_query

    # Prefer body-supplied credentials (per-connection, sent from cloud)
    db_cfg = DBConfig(
        host=body.get("host") or cfg.db_host,
        port=int(body.get("port") or cfg.db_port or 1521),
        service_name=body.get("service_name") or cfg.db_service_name,
        username=body.get("username") or cfg.db_username,
        password=body.get("password") or cfg.db_password,
    )

    if not db_cfg.service_name:
        return {"status_code": 400, "body": {"error": "service_name is required"}}

    # Run a quick validation query first
    ping_result = run_query(db_cfg, "SELECT 1 FROM DUAL")
    if not ping_result["ok"]:
        return {
            "status_code": 503,
            "body": {"error": f"DB connection failed: {ping_result['error']}"},
        }

    # TODO: full SQL catalog migration — Phase 2.
    # The cloud-side health check runner will detect "v6_thin" and request
    # the extended payload via subsequent work items.
    return {
        "status_code": 200,
        "body": {
            "ok": True,
            "mode": "thin",
            "dsn": db_cfg.dsn,
            "latency_ms": ping_result["latency_ms"],
            "message": "v6 thin-mode agent connected — full health check catalog in Phase 2",
        },
    }


def _handle_execute_sql(cfg: PollConfig, body: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a whitelisted SQL statement (SQL console)."""
    from agent.db import DBConfig, run_query

    sql = body.get("sql", "").strip()
    if not sql:
        return {"status_code": 400, "body": {"error": "sql is required"}}

    db_cfg = DBConfig(
        host=body.get("host") or cfg.db_host,
        port=int(body.get("port") or cfg.db_port or 1521),
        service_name=body.get("service_name") or cfg.db_service_name,
        username=body.get("username") or cfg.db_username,
        password=body.get("password") or cfg.db_password,
    )

    result = run_query(db_cfg, sql)
    status = 200 if result["ok"] else 400
    return {"status_code": status, "body": result}


def _handle_ssh_exec(body: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a whitelisted SSH command via paramiko."""
    from agent.ssh import SSHConfig, open_connection, run_command

    ssh_cfg = SSHConfig(
        host=body.get("host", ""),
        port=int(body.get("port", 22)),
        username=body.get("username", "oracle"),
        auth_method=body.get("auth_method", "key"),
        key_content=body.get("key_content"),
        password=body.get("password"),
        key_passphrase=body.get("key_passphrase"),
    )
    command = body.get("command", "")
    if not command:
        return {"status_code": 400, "body": {"error": "command is required"}}

    try:
        with open_connection(ssh_cfg) as client:
            result = run_command(client, command)
        return {"status_code": 200, "body": result}
    except Exception as exc:
        return {"status_code": 503, "body": {"error": str(exc)}}


def _handle_ssh_test(body: Dict[str, Any]) -> Dict[str, Any]:
    """Test SSH connectivity for a connection profile (UI 'Test SSH' button).

    Accepts the same fields as _handle_ssh_exec plus an optional 'bastion' dict
    for ProxyJump / jump-host support.

    Returns:
        {
            "ok": bool,
            "hostname": str,     # remote hostname from `hostname` command
            "uname": str,        # remote uname output for identification
            "host_key_pin": str, # SHA256 fingerprint of remote host key
            "latency_ms": int,
            "error": str | None,
        }
    """
    import socket as _socket
    import hashlib as _hashlib
    from agent.ssh import SSHConfig, open_connection_with_bastion, run_command

    ssh_cfg = SSHConfig(
        host=body.get("host", ""),
        port=int(body.get("port", 22)),
        username=body.get("username", "oracle"),
        auth_method=body.get("auth_method", "agent_forward"),
        key_content=body.get("key_content"),
        password=body.get("password"),
        key_passphrase=body.get("key_passphrase"),
    )

    bastion_raw = body.get("bastion")
    bastion_cfg: "SSHConfig | None" = None
    if bastion_raw and bastion_raw.get("host"):
        bastion_cfg = SSHConfig(
            host=bastion_raw.get("host", ""),
            port=int(bastion_raw.get("port", 22)),
            username=bastion_raw.get("username", ssh_cfg.username),
            auth_method="key" if bastion_raw.get("key_content") else "password",
            key_content=bastion_raw.get("key_content"),
            password=bastion_raw.get("password"),
            key_passphrase=bastion_raw.get("key_passphrase"),
        )

    t0 = time.monotonic()
    try:
        client, host_key_pin = open_connection_with_bastion(
            ssh_cfg, bastion_cfg, timeout_s=15.0
        )
        try:
            hostname_result = run_command(client, "hostname", timeout_s=10.0)
            uname_result = run_command(client, "uname -sr", timeout_s=10.0)
        finally:
            client.close()

        latency_ms = round((time.monotonic() - t0) * 1000)
        return {
            "status_code": 200,
            "body": {
                "ok": True,
                "hostname": hostname_result["stdout"].strip() if hostname_result["ok"] else None,
                "uname": uname_result["stdout"].strip() if uname_result["ok"] else None,
                "host_key_pin": host_key_pin,
                "latency_ms": latency_ms,
            },
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {
            "status_code": 503,
            "body": {
                "ok": False,
                "error": str(exc),
                "latency_ms": latency_ms,
            },
        }


def _handle_os_exec(body: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a whitelisted OS command (local to the agent host)."""
    import subprocess
    import shlex

    # Strict allowlist — no arbitrary execution
    ALLOWED_COMMANDS = {
        "df": "df -h",
        "free": "free -m",
        "uptime": "uptime",
        "uname": "uname -a",
        "lsnrctl_status": "lsnrctl status",
        "systemctl_status": "systemctl status tunevault-agent",
    }

    command_key = body.get("command_id", "")
    if command_key not in ALLOWED_COMMANDS:
        return {"status_code": 403, "body": {"error": f"Command not in allowlist: {command_key!r}"}}

    cmd = ALLOWED_COMMANDS[command_key]
    try:
        t0 = time.monotonic()
        result = subprocess.run(
            shlex.split(cmd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,  # Python 3.6 compat (capture_output/text=3.7+)
            timeout=30,
        )
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {
            "status_code": 200,
            "body": {
                "ok": result.returncode == 0,
                "exit_code": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "latency_ms": latency_ms,
            },
        }
    except Exception as exc:
        return {"status_code": 500, "body": {"error": str(exc)}}


def _handle_self_upgrade(body: Dict[str, Any]) -> Dict[str, Any]:
    """Run `tunevault-agent upgrade` in a subprocess with a hard timeout.

    Contract:
    - Drains any in-flight work by sending SIGTERM first (via systemctl restart).
    - subprocess.run() with timeout=300 — never bare .wait() to prevent zombies.
    - On failure: returns 500 with stderr so the cloud side can surface the error.
    - stdout is truncated to 8 KB to keep the response manageable.
    """
    import subprocess
    import shutil

    log.info("self-upgrade triggered from cloud")

    # Locate the tunevault-agent binary (same venv that's running us)
    agent_bin = shutil.which("tunevault-agent")
    if not agent_bin:
        # Fallback: check venv location
        import sys as _sys
        venv_bin = "/opt/tunevault/venv/bin/tunevault-agent"
        if __import__("os").path.exists(venv_bin):
            agent_bin = venv_bin
        else:
            agent_bin = _sys.executable.replace("python3", "tunevault-agent").replace("python", "tunevault-agent")

    if not __import__("os").path.exists(agent_bin or ""):
        return {
            "status_code": 500,
            "body": {
                "ok": False,
                "error": f"tunevault-agent binary not found (tried: {agent_bin})",
                "stdout": "",
            },
        }

    try:
        t0 = time.monotonic()
        # Run upgrade with a 300s hard timeout — kills the process if it hangs.
        # No bare .wait() — timeout ensures we never zombie.
        result = subprocess.run(
            [agent_bin, "upgrade"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,  # Python 3.6 compat (capture_output/text=3.7+)
            timeout=300,
        )
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        # Truncate output to prevent oversized responses
        stdout = (result.stdout or "")[:8192]
        stderr = (result.stderr or "")[:4096]

        if result.returncode == 0:
            log.info("self-upgrade succeeded in %dms", elapsed_ms)
            return {
                "status_code": 200,
                "body": {
                    "ok": True,
                    "stdout": stdout,
                    "elapsed_ms": elapsed_ms,
                },
            }
        else:
            log.warning("self-upgrade exited %d after %dms", result.returncode, elapsed_ms)
            return {
                "status_code": 500,
                "body": {
                    "ok": False,
                    "exit_code": result.returncode,
                    "stdout": stdout,
                    "stderr": stderr,
                    "elapsed_ms": elapsed_ms,
                },
            }
    except subprocess.TimeoutExpired as exc:
        # Kill the process if it exceeded 300s — no zombie left behind
        if exc.process:
            try:
                exc.process.kill()
                exc.process.wait(timeout=5)
            except Exception:
                pass
        log.error("self-upgrade timed out after 300s")
        return {
            "status_code": 500,
            "body": {
                "ok": False,
                "error": "Upgrade timed out after 300s — process killed",
                "stdout": (exc.stdout or "")[:4096] if hasattr(exc, "stdout") else "",
            },
        }
    except Exception as exc:
        log.error("self-upgrade error: %s", exc, exc_info=True)
        return {"status_code": 500, "body": {"ok": False, "error": str(exc)}}


def _handle_rotate_key(cfg: PollConfig, body: Dict[str, Any]) -> Dict[str, Any]:
    """Atomically rotate the API key on the agent host.

    Protocol:
      1. Cloud pushes {new_key: str} via long-poll channel.
      2. Agent writes /etc/tunevault/agent.env atomically (tempfile + os.rename).
      3. Agent updates cfg.api_key in-memory so the *current* poll loop starts
         using the new key immediately (before the restart completes).
      4. Agent restarts itself via systemctl so the new key survives process restart.
      5. ACK back to cloud with {ok: true, rotated_at: ISO timestamp}.

    The cloud's verifyApiKey accepts both old and new keys for a 5-minute grace
    window so the restart doesn't cause a 401 for in-flight requests.
    """
    import tempfile
    import subprocess
    import datetime

    new_key = (body.get("new_key") or "").strip()
    if not new_key or len(new_key) < 32:
        log.error("rotate-key: new_key missing or too short")
        return {"status_code": 400, "body": {"ok": False, "error": "new_key missing or too short"}}

    # ── 1. Locate agent.env (v6 path; fall back to proxy.env for older layout) ─
    agent_env_path = "/etc/tunevault/agent.env"
    proxy_env_path = "/opt/tunevault-proxy/proxy.env"

    # Determine which env file is in use
    env_path = agent_env_path if os.path.exists(agent_env_path) else proxy_env_path

    # Read existing env so we preserve all other vars
    existing_lines: List[str] = []
    if os.path.exists(env_path):
        try:
            with open(env_path, "r") as f:
                existing_lines = f.readlines()
        except Exception as exc:
            log.warning("rotate-key: could not read %s: %s", env_path, exc)

    # ── 2. Build new env content with updated TUNEVAULT_API_KEY ───────────────
    key_line = f"TUNEVAULT_API_KEY={new_key}\n"
    new_lines = [l for l in existing_lines if not l.startswith("TUNEVAULT_API_KEY=")]
    new_lines.append(key_line)
    new_content = "".join(new_lines)

    # ── 3. Write atomically (tempfile in same dir + os.rename) ────────────────
    env_dir = os.path.dirname(env_path)
    try:
        os.makedirs(env_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=env_dir, prefix=".agent-env-")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(new_content)
            os.chmod(tmp_path, 0o600)
            os.rename(tmp_path, env_path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            raise
    except Exception as exc:
        log.error("rotate-key: failed to write %s: %s", env_path, exc, exc_info=True)
        return {"status_code": 500, "body": {"ok": False, "error": f"Failed to write env: {exc}"}}

    log.info("rotate-key: wrote new key to %s", env_path)

    # ── 4. Update in-memory key immediately (before restart) ─────────────────
    # This ensures the poll loop uses the new key for the ACK response and
    # subsequent polls — even if the systemctl restart happens before the ACK.
    cfg.api_key = new_key

    rotated_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── 5. Trigger service restart asynchronously (don't block the ACK) ──────
    # Use a daemon thread so the restart doesn't prevent us sending the ACK.
    def _restart_service() -> None:
        import time as _time
        _time.sleep(0.5)  # give the ACK time to be sent first
        for svc in ("tunevault-agent", "tunevault-proxy"):
            try:
                result = subprocess.run(
                    ["systemctl", "restart", svc],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    universal_newlines=True, timeout=30  # capture_output/text=3.7+
                )
                if result.returncode == 0:
                    log.info("rotate-key: restarted %s", svc)
                    return
            except Exception:
                pass
        log.warning("rotate-key: could not restart service (systemctl not available or no matching unit)")

    t = threading.Thread(target=_restart_service, daemon=True)
    t.start()

    return {
        "status_code": 200,
        "body": {
            "ok": True,
            "rotated_at": rotated_at,
            "env_path": env_path,
        },
    }


def _handle_run_probe5(cfg: PollConfig) -> Dict[str, Any]:
    """Re-run probe 5: Oracle service discovery.

    Runs the same service-scoring logic as the installer's dg_probe_5:
      1. Try lsnrctl services to get per-instance registrations.
      2. Block *_ebs_patch services unconditionally.
      3. Score ebs* services highest.
      4. Try connection to each candidate; write winner to agent.env.
      5. Signal oracle_worker to retry immediately via shared state.

    This allows the connection card's 'Re-run probe 5' button to trigger
    self-healing without SSH access.
    """
    import os
    import subprocess

    agent_env_path = "/etc/tunevault/agent.env"

    try:
        # Run inline Python probe 5 logic via lsnrctl
        probe_script = r"""
import subprocess, re, os, time

def _score(svc):
    s = svc.lower()
    if s.endswith('_ebs_patch'):
        return -1  # unconditionally blocked
    if s.startswith('ebs') or s.startswith('vis'):
        return 0
    if 'xdb' in s or len(s) == 32:
        return 99  # skip GUIDs and XDB
    return 5  # generic

def _try_connect(host, port, svc, user, pwd, timeout=10):
    try:
        import oracledb
        c = oracledb.connect(user=user, password=pwd,
                             dsn=f'{host}:{port}/{svc}',
                             tcp_connect_timeout=float(timeout))
        c.close()
        return True
    except Exception:
        return False

# Read current agent.env
env = {}
try:
    with open('/etc/tunevault/agent.env') as f:
        for line in f:
            if '=' in line and not line.strip().startswith('#'):
                k, _, v = line.strip().partition('=')
                env[k] = v
except Exception:
    pass

host = env.get('ORACLE_HOST', 'localhost')
port = int(env.get('ORACLE_PORT', '1521') or '1521')
user = env.get('ORACLE_USERNAME', '')
pwd  = env.get('ORACLE_PASSWORD', '')

# lsnrctl services for per-instance registration data
svcs = []
try:
    out = subprocess.run(
        ['lsnrctl', 'services'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, timeout=20,  # capture_output/text=3.7+
    ).stdout
    for line in out.splitlines():
        m = re.match(r'\s*Service\s+"([^"]+)"', line, re.IGNORECASE)
        if m:
            svcs.append(m.group(1))
except Exception:
    pass

# Sort: blocked last, ebs* first
scored = sorted(set(svcs), key=lambda s: (_score(s), s))
winner = None
for svc in scored:
    if _score(svc) < 0:
        continue
    if _try_connect(host, port, svc, user, pwd):
        winner = svc
        break

if winner:
    # Write ORACLE_SERVICE_NAME back to agent.env atomically
    import tempfile
    lines = open('/etc/tunevault/agent.env').readlines() if os.path.exists('/etc/tunevault/agent.env') else []
    new_lines = [l for l in lines if not l.startswith('ORACLE_SERVICE_NAME=')]
    new_lines.append(f'ORACLE_SERVICE_NAME={winner}\n')
    fd, tmp = tempfile.mkstemp(dir='/etc/tunevault', prefix='.agent-env-')
    with os.fdopen(fd, 'w') as fh:
        fh.writelines(new_lines)
    os.chmod(tmp, 0o600)
    os.rename(tmp, '/etc/tunevault/agent.env')
    print(f'WINNER:{winner}')
else:
    print('WINNER:')
"""
        result = subprocess.run(
            ["python3", "-c", probe_script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,  # Python 3.6 compat (capture_output/text=3.7+)
            timeout=60,
        )
        # Parse winner from output
        oracle_service_name = None
        for line in result.stdout.splitlines():
            if line.startswith("WINNER:"):
                raw = line[7:].strip()
                if raw:
                    oracle_service_name = raw

        if oracle_service_name:
            # Update in-memory config so oracle_worker picks it up on next retry
            cfg.db_service_name = oracle_service_name
            log.info("run-probe5: new service=%s", oracle_service_name)
            return {
                "status_code": 200,
                "body": {
                    "ok": True,
                    "oracle_service_name": oracle_service_name,
                    "message": f"Probe 5 re-run complete. Service: {oracle_service_name}",
                },
            }
        else:
            log.warning("run-probe5: no connectable service found. stderr: %s", result.stderr[:200])
            return {
                "status_code": 200,
                "body": {
                    "ok": False,
                    "oracle_service_name": None,
                    "error": "No connectable Oracle service found",
                    "stderr": result.stderr[:500],
                },
            }
    except Exception as exc:
        log.error("run-probe5 error: %s", exc, exc_info=True)
        return {"status_code": 500, "body": {"ok": False, "error": str(exc)}}


def _post_heartbeat_only(cfg: PollConfig) -> None:
    """POST a standalone heartbeat to /api/agent/heartbeat every 30s.

    This is a fire-and-forget call from a background daemon thread.
    It carries agent_status + oracle error fields so the cloud always
    has fresh status even if the long-poll is holding open on a work wait.
    Never raises — errors are logged and swallowed.
    """
    try:
        metadata = _build_metadata(cfg)
        # heartbeat endpoint expects these specific fields
        hb_payload = {
            "connection_id": cfg.connection_id,
            "agent_version": VERSION,
            **{k: v for k, v in metadata.items()
               if k in (
                   "agent_status", "last_oracle_error", "oracle_retry_count", "uptime_seconds",
                   # thick-mode fallback fields — cloud dashboard reads these to show oracle mode
                   "oracle_mode", "instant_client_path", "verifier_workaround_active",
               )},
        }
        status, _ = _post_json(
            f"{cfg.api_url}/api/agent/heartbeat",
            hb_payload,
            cfg.api_key,
            timeout=10.0,
        )
        if status not in (200, 204):
            log.debug("Standalone heartbeat returned HTTP %d", status)
    except Exception as exc:
        log.debug("Standalone heartbeat error: %s", exc)


def _start_heartbeat_thread(cfg: PollConfig, stop_event: threading.Event) -> threading.Thread:
    """Spawn a daemon thread that POSTs /api/agent/heartbeat every 30s."""
    def _loop() -> None:
        while not stop_event.is_set():
            stop_event.wait(30.0)
            if not stop_event.is_set():
                _post_heartbeat_only(cfg)
    t = threading.Thread(target=_loop, daemon=True, name="heartbeat-thread")
    t.start()
    return t


# ── Watchdog thresholds (env-configurable) ────────────────────────────────────
# tier1: warn after this many seconds of sustained cloud unreachability
# tier3: exit and let systemd recycle after this many seconds (only exit path)
# poll_backoff_max: jittered backoff cap during degraded mode
_WATCHDOG_DEGRADED_S = int(os.environ.get("AGENT_WATCHDOG_DEGRADED_S", "60"))
_WATCHDOG_RESTART_S  = int(os.environ.get("AGENT_WATCHDOG_RESTART_S", "300"))
_POLL_BACKOFF_MAX_S  = int(os.environ.get("AGENT_POLL_BACKOFF_MAX_S", "30"))


def _post_restart_reason(cfg: PollConfig, reason_code: str, last_stage: str,
                          last_error: str, uptime_s: int, seq_id: str) -> None:
    """Fire-and-forget POST to /api/agent/restart-reason before any sys.exit.

    Agent is about to exit — never block on this call. Swallow all exceptions.
    Server responds immediately with {ok:true} before doing any DB work.
    """
    try:
        payload = {
            "connection_id": cfg.connection_id,
            "reason_code": reason_code,
            "last_stage_reached": last_stage,
            "last_error": str(last_error)[:400] if last_error else None,
            "uptime_seconds": uptime_s,
            "restart_sequence_id": seq_id,
        }
        _post_json(
            "{}/api/agent/restart-reason".format(cfg.api_url),
            payload,
            cfg.api_key,
            timeout=5.0,  # short — agent is exiting
        )
    except Exception:
        pass  # never block an exit on this call


def run_poll_loop(cfg: PollConfig, stop_event: Optional[threading.Event] = None) -> None:
    """Run the outbound long-poll loop (blocking).

    This is the agent's main loop. Intended to be called from cli.py.
    Call stop_event.set() to request clean shutdown.

    Error handling:
    - Network errors → jittered exponential backoff, cap = AGENT_POLL_BACKOFF_MAX_S
    - Auth errors (401) → log critical + POST restart_reason(auth_failure) + exit
    - 3-tier watchdog on sustained cloud unreachability:
        tier1 (>AGENT_WATCHDOG_DEGRADED_S): warn, enter degraded mode, double backoff
        tier2 (degraded, <AGENT_WATCHDOG_RESTART_S): jitter-backoff, keep Oracle probes
        tier3 (>AGENT_WATCHDOG_RESTART_S): POST restart_reason(watchdog_timeout) + exit
    - Work execution errors → logged, result submitted with 500 status

    Heartbeat thread:
    - Separate daemon thread posts /api/agent/heartbeat every 30s with
      current agent_status + oracle error fields (from AgentState).
    - This ensures the cloud has fresh status even during long-poll holds.
    """
    if stop_event is None:
        stop_event = threading.Event()

    backoff_s = 1.0
    max_backoff_s = float(_POLL_BACKOFF_MAX_S)

    # Watchdog state — tracks when cloud first became unreachable this session
    _cloud_unavailable_since: Optional[float] = None  # monotonic timestamp
    _last_error_str = ""
    _start_time = time.monotonic()
    # Unique ID for this process lifetime — lets server correlate restart events
    _restart_seq_id = str(uuid.uuid4())[:16]

    log.info(
        "Poll loop starting — api_url=%s connection_id=%s "
        "watchdog=(%ds warn / %ds restart) backoff_max=%ds",
        cfg.api_url, cfg.connection_id,
        _WATCHDOG_DEGRADED_S, _WATCHDOG_RESTART_S, _POLL_BACKOFF_MAX_S,
    )

    # Start dedicated heartbeat thread (30s cadence, carries oracle status)
    _start_heartbeat_thread(cfg, stop_event)

    while not stop_event.is_set():
        try:
            metadata = _build_metadata(cfg)
            status, body = _post_json(
                "{}/api/agent/poll".format(cfg.api_url),
                metadata,
                cfg.api_key,
                timeout=35.0,  # 25s cloud hold + 10s network margin
            )

            if status == 401:
                # Permanent auth failure — exit so systemd reloads with fresh env
                log.critical("Poll returned 401 — API key rejected. Exiting for systemd restart.")
                _post_restart_reason(
                    cfg, "auth_failure", "polling",
                    "HTTP 401 from /api/agent/poll — key rejected",
                    int(time.monotonic() - _start_time), _restart_seq_id,
                )
                sys.exit(4)  # exit 4 = auth failure (matches env/key stage code)

            if status not in (200, 204):
                # Transient cloud error — enter watchdog escalation
                _last_error_str = "HTTP {} from /api/agent/poll".format(status)
                if _cloud_unavailable_since is None:
                    _cloud_unavailable_since = time.monotonic()

                elapsed = time.monotonic() - _cloud_unavailable_since

                if elapsed > _WATCHDOG_RESTART_S:
                    # Tier 3: sustained outage > RESTART_S — exit for systemd recycle
                    log.error(
                        "Cloud unreachable for %.0fs (threshold=%ds). "
                        "Exiting for systemd restart. Last error: %s",
                        elapsed, _WATCHDOG_RESTART_S, _last_error_str,
                    )
                    _post_restart_reason(
                        cfg, "watchdog_timeout", "polling",
                        _last_error_str,
                        int(time.monotonic() - _start_time), _restart_seq_id,
                    )
                    sys.exit(20)  # exit 20 = watchdog (preserved for systemd unit matching)

                if elapsed > _WATCHDOG_DEGRADED_S:
                    # Tier 2: degraded — keep retrying, log periodic warnings
                    log.warning(
                        "DEGRADED: cloud unreachable for %.0fs. "
                        "Retrying with jitter backoff (will exit at %ds). "
                        "Poll returned HTTP %d.",
                        elapsed, _WATCHDOG_RESTART_S, status,
                    )
                else:
                    # Tier 1: first miss, just log warning
                    log.warning("Poll returned HTTP %d: %s", status, body)

                # Jittered backoff — avoids thundering herd on LB recovery
                jitter = backoff_s * (0.8 + 0.4 * random.random())
                stop_event.wait(min(jitter, max_backoff_s))
                backoff_s = min(backoff_s * 2, max_backoff_s)
                continue

            # ── Success path ────────────────────────────────────────────────
            if _cloud_unavailable_since is not None:
                elapsed = time.monotonic() - _cloud_unavailable_since
                log.info("Cloud reachable again after %.0fs degraded.", elapsed)
                _cloud_unavailable_since = None  # reset watchdog
            backoff_s = 1.0

            work = body.get("work")
            if work is None:
                # Heartbeat — no work queued, loop immediately
                continue

            request_id = work.get("request_id", "")
            log.info("Work received: %s %s (req=%s)", work.get("method"), work.get("path"), request_id[:8])

            result = _execute_work(cfg, work)

            # Submit result
            respond_payload = {
                "connection_id": cfg.connection_id,
                "request_id": request_id,
                "status_code": result.get("status_code", 200),
                "body": result.get("body", {}),
            }
            r_status, r_body = _post_json(
                "{}/api/agent/respond".format(cfg.api_url),
                respond_payload,
                cfg.api_key,
                timeout=15.0,
            )
            if r_status != 200:
                log.warning("Respond returned HTTP %d: %s", r_status, r_body)

        except KeyboardInterrupt:
            log.info("Poll loop interrupted by keyboard — clean shutdown")
            break
        except Exception as exc:
            _last_error_str = str(exc)
            if _cloud_unavailable_since is None:
                _cloud_unavailable_since = time.monotonic()

            elapsed = time.monotonic() - _cloud_unavailable_since

            if elapsed > _WATCHDOG_RESTART_S:
                log.error(
                    "Cloud unreachable for %.0fs (threshold=%ds). "
                    "Exiting for systemd restart. Last error: %s",
                    elapsed, _WATCHDOG_RESTART_S, exc,
                )
                _post_restart_reason(
                    cfg, "watchdog_timeout", "polling",
                    _last_error_str,
                    int(time.monotonic() - _start_time), _restart_seq_id,
                )
                sys.exit(20)

            if elapsed > _WATCHDOG_DEGRADED_S:
                log.warning(
                    "DEGRADED: cloud unreachable for %.0fs. "
                    "Retrying with jitter backoff (will exit at %ds). Error: %s",
                    elapsed, _WATCHDOG_RESTART_S, exc,
                )
            else:
                log.warning("Poll error: %s — backoff %.1fs", exc, backoff_s)

            jitter = backoff_s * (0.8 + 0.4 * random.random())
            stop_event.wait(min(jitter, max_backoff_s))
            backoff_s = min(backoff_s * 2, max_backoff_s)

    log.info("Poll loop stopped")
