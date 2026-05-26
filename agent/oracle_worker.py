"""
agent/oracle_worker.py — Supervised Oracle connectivity worker.
Owns: Oracle connection lifecycle in background thread, status/error reporting back to poll loop,
      first-connect thick-mode fallback (DPY-3015 / DPY-3001 / ORA-28040 / ORA-01017 11g-verifier).
Does NOT own: heartbeat HTTP calls (poll.py), CLI parsing (cli.py), probe logic (probes.py),
              Instant Client download/install (bootstrap.py).

Architecture:
  - Runs as a daemon thread started by cmd_start in cli.py AFTER the poll loop is live.
  - Never exits the process on Oracle failure — sets shared state and sleeps 60s before retry.
  - The poll loop reads shared state and includes it in every heartbeat payload.
  - On success: transitions agent_status → 'healthy', begins accepting work.
  - On failure: sets agent_status → 'oracle_unreachable', stores last_oracle_error dict.

Thick-mode fallback (defense-in-depth):
  If first connect raises DPY-3015, DPY-3001, ORA-28040, or ORA-01017 with 11g-verifier
  markers, the worker:
    1. Calls bootstrap.ensure_thick_client() to install Instant Client + init_oracle_client().
    2. Retries the connection in thick mode.
    3. Persists thick_mode=true to agent.env (bootstrap.py handles this).
    4. On subsequent restarts, reads the flag and skips the probe overhead.
  If the thick-mode retry also fails, emits a structured log + telemetry event with
  scenario=verifier_mismatch so DBAs see exactly what happened.

Oracle error capture schema (last_oracle_error):
  {
    "ora_code":       int | None,      # e.g. 12514, 1017, 12541
    "message":        str,             # full exception string (password redacted)
    "traceback_tail": str,             # last 3 lines of traceback
    "attempted_dsn":  str,             # host:port/service (password never included)
    "attempted_at":   str,             # ISO-8601 UTC timestamp
    "scenario":       str | None,      # "verifier_mismatch" | None
    "thick_attempted": bool,           # True if thick fallback was tried
    "client_path":    str | None,      # Instant Client path attempted
    "attempted_actions": List[str],    # human-readable remediation trail
    "remediation":    str | None,      # one-line operator-readable fix
  }
"""


import logging
import os
import re
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

log = logging.getLogger("tunevault.oracle_worker")


class AgentState:
    """Thread-safe shared state between the Oracle worker and the poll loop.

    Fields:
      agent_status            — 'starting' | 'oracle_unreachable' | 'healthy'
      last_oracle_error       — dict (schema above) or None
      oracle_retry_count      — total attempt count since process start
      start_time              — monotonic time when agent started (for uptime_seconds)
      oracle_mode             — 'thin' | 'thick' (updated after thick bootstrap)
      instant_client_path     — path to Instant Client lib dir if thick mode active
      verifier_workaround_active — True if thick mode was activated due to verifier mismatch
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.agent_status: str = "starting"
        self.last_oracle_error: Optional[Dict[str, Any]] = None
        self.oracle_retry_count: int = 0
        self.start_time: float = time.monotonic()
        self.oracle_mode: str = "thin"
        self.instant_client_path: Optional[str] = None
        self.verifier_workaround_active: bool = False

    def set_starting(self) -> None:
        with self._lock:
            self.agent_status = "starting"

    def set_healthy(self) -> None:
        with self._lock:
            self.agent_status = "healthy"
            self.last_oracle_error = None

    def set_oracle_unreachable(self, error_dict: Dict[str, Any]) -> None:
        with self._lock:
            self.agent_status = "oracle_unreachable"
            self.last_oracle_error = error_dict
            self.oracle_retry_count += 1

    def set_thick_mode(self, lib_dir: str) -> None:
        """Record that thick mode was activated (call after successful bootstrap)."""
        with self._lock:
            self.oracle_mode = "thick"
            self.instant_client_path = lib_dir
            self.verifier_workaround_active = True

    def get_heartbeat_fields(self) -> Dict[str, Any]:
        """Return fields to merge into every heartbeat payload."""
        with self._lock:
            uptime = round(time.monotonic() - self.start_time)
            return {
                "agent_status": self.agent_status,
                "last_oracle_error": self.last_oracle_error,
                "oracle_retry_count": self.oracle_retry_count,
                "uptime_seconds": uptime,
                "oracle_mode": self.oracle_mode,
                "instant_client_path": self.instant_client_path,
                "verifier_workaround_active": self.verifier_workaround_active,
            }

    def get_health_fields(self) -> Dict[str, Any]:
        """Return fields for the /agent/health endpoint."""
        with self._lock:
            return {
                "oracle_mode": self.oracle_mode,
                "instant_client_path": self.instant_client_path,
                "verifier_workaround_active": self.verifier_workaround_active,
            }


# ORA code extractor — catches ORA-XXXXX in exception text
_ORA_PATTERN = re.compile(r"ORA-(\d{4,5})", re.IGNORECASE)


def _extract_ora_code(message: str) -> Optional[int]:
    m = _ORA_PATTERN.search(message)
    return int(m.group(1)) if m else None


def _redact_dsn(dsn: str) -> str:
    """Remove password from any DSN string. Passwords only appear in user/pass@host forms."""
    # Remove password from user/pass@host style (should not appear in plain DSN but be safe)
    return re.sub(r"(:[^:@/]+)@", "@", dsn)


def _build_error_dict(exc: Exception, attempted_dsn: str) -> Dict[str, Any]:
    """Build a structured last_oracle_error dict from an exception."""
    msg = str(exc)
    tb_lines = traceback.format_exc().strip().splitlines()
    tb_tail = "\n".join(tb_lines[-3:]) if len(tb_lines) >= 3 else "\n".join(tb_lines)
    return {
        "ora_code": _extract_ora_code(msg),
        "message": msg,
        "traceback_tail": tb_tail,
        "attempted_dsn": _redact_dsn(attempted_dsn),
        "attempted_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def _emit_verifier_mismatch_telemetry(
    db_host: str,
    db_port: int,
    db_service_name: str,
    bootstrap_result: dict,
    final_error: Optional[str],
) -> None:
    """Emit a structured log line for verifier_mismatch scenarios.

    This surfaces as a single, parseable line in journald/Datadog so operators
    see exactly what happened without pasting commands into a chat loop.
    """
    import json as _json
    log.error(
        "VERIFIER_MISMATCH scenario=%s client_path=%s attempted_actions=%s "
        "thick_retry_error=%s dsn=%s:%d/%s "
        "remediation='%s'",
        "verifier_mismatch",
        bootstrap_result.get("lib_dir"),
        _json.dumps(bootstrap_result.get("attempted_actions", [])),
        final_error or "none",
        db_host, db_port, db_service_name,
        (
            "Thick mode active but still failing — check ORACLE_PASSWORD for this user, "
            "or verify DBA_USERS.PASSWORD_VERSIONS includes 11G for this schema."
            if final_error else
            "Thick mode activated successfully — no further action needed."
        ),
    )


def _try_thick_fallback(
    state: AgentState,
    db_host: str,
    db_port: int,
    db_service_name: str,
    db_username: str,
    db_password: str,
    api_url: str,
) -> dict:
    """Attempt thick-mode fallback after a verifier-mismatch first-connect failure.

    Steps:
      1. Call bootstrap.ensure_thick_client() — installs Instant Client if needed.
      2. If bootstrap succeeds, retry db_ping in thick mode.
      3. Update AgentState with thick mode fields.
      4. Return a result dict with ok + details.

    Never raises — all errors captured in result dict.
    """
    from agent.bootstrap import ensure_thick_client
    from agent.db import DBConfig, ping as db_ping

    attempted_dsn = f"{db_host}:{db_port}/{db_service_name}"
    log.info(
        "Oracle worker: verifier-mismatch detected — attempting thick-mode fallback for %s",
        attempted_dsn,
    )

    bootstrap_result = ensure_thick_client(api_url=api_url)

    if not bootstrap_result["ok"]:
        _emit_verifier_mismatch_telemetry(
            db_host, db_port, db_service_name,
            bootstrap_result,
            bootstrap_result.get("error"),
        )
        return {
            "ok": False,
            "bootstrap": bootstrap_result,
            "retry_error": None,
            "error": bootstrap_result["error"],
        }

    # Bootstrap succeeded — update state
    lib_dir = bootstrap_result["lib_dir"] or ""
    state.set_thick_mode(lib_dir)
    log.info("Oracle worker: thick mode active (lib_dir=%s) — retrying connection", lib_dir)

    # Retry the connection
    db_cfg = DBConfig(
        host=db_host,
        port=db_port,
        service_name=db_service_name,
        username=db_username,
        password=db_password,
    )
    retry_result = db_ping(db_cfg, timeout_s=15.0)

    if retry_result["ok"]:
        log.info(
            "Oracle worker: thick-mode retry SUCCEEDED — %s in %dms",
            attempted_dsn, retry_result["latency_ms"],
        )
        _emit_verifier_mismatch_telemetry(
            db_host, db_port, db_service_name,
            bootstrap_result,
            None,  # no error — succeeded
        )
        return {
            "ok": True,
            "bootstrap": bootstrap_result,
            "retry_error": None,
            "error": None,
            "latency_ms": retry_result["latency_ms"],
        }
    else:
        retry_error = retry_result["error"] or "ping returned ok=False after thick mode"
        log.error(
            "Oracle worker: thick-mode retry ALSO FAILED — %s — %s",
            attempted_dsn, retry_error[:200],
        )
        _emit_verifier_mismatch_telemetry(
            db_host, db_port, db_service_name,
            bootstrap_result,
            retry_error,
        )
        return {
            "ok": False,
            "bootstrap": bootstrap_result,
            "retry_error": retry_error,
            "error": retry_error,
        }


def run_oracle_worker(
    state: AgentState,
    db_host: str,
    db_port: int,
    db_service_name: str,
    db_username: str,
    db_password: str,
    stop_event: threading.Event,
    retry_interval_s: float = 60.0,
    api_url: str = "",
) -> None:
    """Oracle worker main loop — runs in a daemon thread.

    On every iteration:
      1. Attempt Oracle connection (SELECT 1 FROM DUAL).
      2a. If success: set state.healthy, re-probe every 30s.
      2b. If DPY-3015/DPY-3001/ORA-28040/ORA-01017 (11g verifier):
          - Try thick-mode fallback (bootstrap.ensure_thick_client + retry).
          - If fallback succeeds: set state.healthy, continue as thick-mode.
          - If fallback fails: set state.oracle_unreachable with structured telemetry.
      2c. Any other failure: capture error dict, set state.oracle_unreachable.

    Never exits on Oracle error — only stops when stop_event is set.

    Pre-warm: if agent.env contains ORACLE_THICK_MODE=true (from a previous run),
    skip the probe and initialise thick mode immediately before the first connect.
    """
    from agent.db import DBConfig, ping as db_ping
    from agent.bootstrap import is_verifier_mismatch, should_try_thick_at_start

    # Resolve api_url for Instant Client downloads — fall back to env var
    _api_url = (
        api_url
        or os.environ.get("TUNEVAULT_API", "https://tunevault.app")
    ).rstrip("/")

    log.info(
        "Oracle worker starting — DSN: %s:%d/%s user=%s",
        db_host, db_port, db_service_name, db_username,
    )

    # Pre-warm: thick mode already known from previous run — activate before first connect
    if should_try_thick_at_start():
        log.info("Oracle worker: agent.env ORACLE_THICK_MODE=true — pre-warming thick mode")
        from agent.bootstrap import ensure_thick_client
        pw_result = ensure_thick_client(api_url=_api_url)
        if pw_result["ok"]:
            state.set_thick_mode(pw_result.get("lib_dir") or "")
            log.info("Oracle worker: thick mode pre-warmed (lib_dir=%s)", pw_result.get("lib_dir"))
        else:
            log.warning(
                "Oracle worker: thick mode pre-warm failed (%s) — will probe on first connect",
                pw_result.get("error"),
            )

    # Track whether we have already tried thick fallback this run — avoid looping
    _thick_fallback_attempted = state.oracle_mode == "thick"

    while not stop_event.is_set():
        attempted_dsn = f"{db_host}:{db_port}/{db_service_name}"

        if not db_service_name or not db_host:
            # No Oracle config yet — agent-only install, service not configured.
            log.info("Oracle worker: no DB config — staying in 'starting' state, will retry when configured")
            stop_event.wait(retry_interval_s)
            continue

        try:
            db_cfg = DBConfig(
                host=db_host,
                port=db_port,
                service_name=db_service_name,
                username=db_username,
                password=db_password,
            )
            result = db_ping(db_cfg, timeout_s=15.0)

            if result["ok"]:
                if state.agent_status != "healthy":
                    log.info(
                        "Oracle worker: connection HEALTHY — %s:%d/%s in %dms",
                        db_host, db_port, db_service_name, result["latency_ms"],
                    )
                state.set_healthy()
                # Re-probe every 30s to detect Oracle going down
                stop_event.wait(30.0)
                continue
            else:
                raise RuntimeError(result["error"] or "ping returned ok=False")

        except Exception as exc:
            exc_msg = str(exc)
            error_dict = _build_error_dict(exc, attempted_dsn)

            # ── Verifier mismatch detection + thick fallback ──────────────────
            if not _thick_fallback_attempted and is_verifier_mismatch(exc_msg):
                _thick_fallback_attempted = True  # only attempt once per worker lifetime
                fallback = _try_thick_fallback(
                    state=state,
                    db_host=db_host,
                    db_port=db_port,
                    db_service_name=db_service_name,
                    db_username=db_username,
                    db_password=db_password,
                    api_url=_api_url,
                )
                if fallback["ok"]:
                    # Thick-mode retry succeeded — mark healthy and loop
                    state.set_healthy()
                    stop_event.wait(30.0)
                    continue
                else:
                    # Thick-mode retry also failed — build enriched error dict
                    bootstrap_info = fallback.get("bootstrap") or {}
                    error_dict.update({
                        "scenario": "verifier_mismatch",
                        "thick_attempted": True,
                        "client_path": bootstrap_info.get("lib_dir"),
                        "attempted_actions": bootstrap_info.get("attempted_actions", []),
                        "remediation": (
                            "Thick mode activated but connection still fails. "
                            "Check PASSWORD_VERSIONS for this Oracle user: "
                            "SELECT username, password_versions FROM dba_users WHERE username = upper('<USER>'); "
                            "Add 11G verifier if missing: ALTER USER <USER> IDENTIFIED BY <PASS>;"
                        ),
                    })
                    state.set_oracle_unreachable(error_dict)
                    stop_event.wait(retry_interval_s)
                    continue
            # ── End thick fallback ─────────────────────────────────────────────

            ora_code = error_dict["ora_code"]
            log.warning(
                "Oracle worker: connection FAILED (ORA-%s) — %s — retrying in %ds",
                ora_code or "?",
                exc_msg[:120],
                int(retry_interval_s),
            )
            state.set_oracle_unreachable(error_dict)
            stop_event.wait(retry_interval_s)

    log.info("Oracle worker stopped")


def start_oracle_worker_thread(
    state: AgentState,
    db_host: str,
    db_port: int,
    db_service_name: str,
    db_username: str,
    db_password: str,
    stop_event: threading.Event,
    api_url: str = "",
) -> threading.Thread:
    """Spawn and return the Oracle worker daemon thread.

    api_url is passed through to the worker so it can download Instant Client
    RPMs via the TuneVault mirror proxy on verifier-mismatch fallback.
    """
    t = threading.Thread(
        target=run_oracle_worker,
        args=(state, db_host, db_port, db_service_name, db_username, db_password, stop_event),
        kwargs={"api_url": api_url},
        daemon=True,
        name="oracle-worker",
    )
    t.start()
    return t
