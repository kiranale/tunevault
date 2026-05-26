"""
agent/db.py — Oracle DB connectivity via python-oracledb.
Owns: DB connection lifecycle, query execution, health probe queries.
Does NOT own: SSH, poll loop, CLI parsing, probe orchestration, thick-mode bootstrap.

Default mode: thin (pure-Python TCP, no Oracle client install required).
Thick mode: activated transparently by oracle_worker.py when DPY-3015/DPY-3001/
ORA-28040/ORA-01017 (11g verifier) is detected on first connect — see bootstrap.py.
After bootstrap.py calls oracledb.init_oracle_client(), subsequent connect() calls
here automatically use thick mode without any changes in this file.
"""


import logging
import socket
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("tunevault.db")

# python-oracledb is a hard dependency — fail fast on import so the
# installer self-test catches a broken venv immediately.
try:
    import oracledb  # type: ignore[import]
except ImportError as _e:
    raise SystemExit(
        "FATAL: python-oracledb not installed.\n"
        "Run: pip install python-oracledb\n"
        f"Original error: {_e}"
    ) from _e

# Thin mode is the default. Thick mode is activated at runtime by bootstrap.py
# when a DPY-3015 / ORA-28040 / ORA-01017 (11g-verifier) error is detected on
# first connect. oracle_worker.py owns the decision; db.py is mode-agnostic.
#
# WHY: The original v6 thin-only assertion prevented any thick-mode use, which
# broke EBS shops with 11g verifier accounts. bootstrap.py + oracle_worker.py
# now transparently call oracledb.init_oracle_client() when needed.
_CURRENT_MODE: str = "thin"  # updated by oracle_worker after bootstrap succeeds


def get_connection_mode() -> str:
    """Return 'thin' or 'thick' — reflects the live oracledb mode."""
    return "thin" if oracledb.is_thin_mode() else "thick"


class DBConfig:
    """Immutable connection parameters for one Oracle database."""

    __slots__ = ("host", "port", "service_name", "username", "password")

    def __init__(
        self,
        host: str,
        port: int,
        service_name: str,
        username: str,
        password: str,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.service_name = service_name
        self.username = username
        self.password = password

    @property
    def dsn(self) -> str:
        return f"{self.host}:{self.port}/{self.service_name}"

    def __repr__(self) -> str:  # passwords must not leak into logs
        return f"DBConfig(host={self.host!r}, port={self.port}, service={self.service_name!r}, user={self.username!r})"


def connect(cfg: DBConfig, timeout_s: float = 10.0) -> oracledb.Connection:
    """Open a new thin-mode Oracle connection.

    Raises oracledb.DatabaseError on auth/service failure.
    Raises socket.timeout / ConnectionRefusedError on network failure.
    Caller is responsible for close().
    """
    log.debug("Connecting to %s", cfg.dsn)
    conn = oracledb.connect(
        user=cfg.username,
        password=cfg.password,
        dsn=cfg.dsn,
        # tcp_connect_timeout is seconds as float — supported since oracledb 1.1
        tcp_connect_timeout=timeout_s,
    )
    return conn


def ping(cfg: DBConfig, timeout_s: float = 10.0) -> Dict[str, Any]:
    """Run SELECT 1 FROM DUAL and return timing + version info.

    Returns:
        {
            "ok": bool,
            "latency_ms": int | None,
            "oracle_version": str | None,
            "error": str | None,
        }
    """
    t0 = time.monotonic()
    try:
        with connect(cfg, timeout_s=timeout_s) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM DUAL")
                cur.fetchone()
                # Grab DB version cheaply
                try:
                    cur.execute("SELECT version FROM v$instance")
                    row = cur.fetchone()
                    db_ver = row[0] if row else None
                except Exception:
                    db_ver = None
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.debug("Ping %s OK in %dms", cfg.dsn, latency_ms)
        return {"ok": True, "latency_ms": latency_ms, "oracle_version": db_ver, "error": None}
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.warning("Ping %s FAILED in %dms: %s", cfg.dsn, latency_ms, exc)
        return {"ok": False, "latency_ms": latency_ms, "oracle_version": None, "error": str(exc)}


def listener_reachable(host: str, port: int, timeout_s: float = 5.0) -> Dict[str, Any]:
    """TCP probe to TNS listener — no Oracle credentials required.

    Returns:
        {"ok": bool, "latency_ms": int, "error": str | None}
    """
    t0 = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            pass
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.debug("Listener %s:%d reachable in %dms", host, port, latency_ms)
        return {"ok": True, "latency_ms": latency_ms, "error": None}
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.warning("Listener %s:%d unreachable: %s", host, port, exc)
        return {"ok": False, "latency_ms": latency_ms, "error": str(exc)}


def run_query(cfg: DBConfig, sql: str, params: Any = None, timeout_s: float = 60.0) -> Dict[str, Any]:
    """Execute an arbitrary SQL statement and return rows as list-of-dicts.

    Returns:
        {
            "ok": bool,
            "columns": List[str],
            "rows": List[list],   # row data as plain lists for JSON serialization
            "rowcount": int,
            "latency_ms": int,
            "error": str | None,
        }
    """
    t0 = time.monotonic()
    try:
        with connect(cfg, timeout_s=timeout_s) as conn:
            with conn.cursor() as cur:
                if params:
                    cur.execute(sql, params)
                else:
                    cur.execute(sql)
                columns = [d[0].lower() for d in (cur.description or [])]
                rows = [list(r) for r in (cur.fetchall() or [])]
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {
            "ok": True,
            "columns": columns,
            "rows": rows,
            "rowcount": len(rows),
            "latency_ms": latency_ms,
            "error": None,
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.error("Query failed in %dms: %s", latency_ms, exc)
        return {
            "ok": False,
            "columns": [],
            "rows": [],
            "rowcount": 0,
            "latency_ms": latency_ms,
            "error": str(exc),
        }
