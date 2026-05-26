"""
agent/probes.py — The 8 diagnostic probes, pure Python.
Owns: probe definitions, probe result schema, probe orchestration.
Does NOT own: HTTP serving, poll loop, CLI arg parsing.

Probe schema (one entry per probe):
  {
    "id": int,              # 1-8
    "name": str,
    "status": "pass" | "fail" | "skip",
    "detail": str,          # human-readable result
    "fix": str | None,      # actionable fix command on failure
    "latency_ms": int | None,
  }
"""


import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("tunevault.probes")

VERSION = "6.1.0"


def _probe(
    id: int,
    name: str,
    status: str,
    detail: str,
    fix: Optional[str] = None,
    latency_ms: Optional[int] = None,
) -> Dict[str, Any]:
    return {
        "id": id,
        "name": name,
        "status": status,
        "detail": detail,
        "fix": fix,
        "latency_ms": latency_ms,
    }


def probe_1_agent_online() -> Dict[str, Any]:
    """Probe 1 — Agent process is running and reachable."""
    return _probe(
        1,
        "Agent online",
        "pass",
        f"TuneVault Agent v{VERSION} running (pure-Python thin mode)",
    )


def probe_2_python_drivers() -> Dict[str, Any]:
    """Probe 2 — python-oracledb and paramiko are importable."""
    missing = []
    versions = {}

    try:
        import oracledb  # type: ignore[import]
        versions["oracledb"] = oracledb.__version__
        if not oracledb.is_thin_mode():
            return _probe(
                2,
                "Python drivers",
                "fail",
                "oracledb is in THICK mode — thin mode required",
                fix="Uninstall Oracle Instant Client or remove oracledb.init_oracle_client() calls",
            )
    except ImportError:
        missing.append("python-oracledb")

    try:
        import paramiko  # type: ignore[import]
        versions["paramiko"] = paramiko.__version__
    except ImportError:
        missing.append("paramiko")

    if missing:
        return _probe(
            2,
            "Python drivers",
            "fail",
            f"Missing packages: {', '.join(missing)}",
            fix=f"pip install {' '.join(missing)}",
        )

    detail = f"oracledb {versions.get('oracledb', '?')} (thin), paramiko {versions.get('paramiko', '?')}"
    return _probe(2, "Python drivers", "pass", detail)


def probe_3_config_loaded(config_path: str = "/etc/tunevault/agent.yaml") -> Dict[str, Any]:
    """Probe 3 — Agent config file present and has required fields."""
    t0 = time.monotonic()
    try:
        import yaml  # type: ignore[import]
        with open(config_path) as f:
            cfg = yaml.safe_load(f)
        required = ["api_key", "api_url", "connection_id"]
        missing = [k for k in required if not cfg.get(k)]
        latency_ms = round((time.monotonic() - t0) * 1000)
        if missing:
            return _probe(
                3, "Config loaded", "fail",
                f"Missing required config fields: {', '.join(missing)}",
                fix=f"Edit {config_path} and add the missing fields",
                latency_ms=latency_ms,
            )
        api_key_len = len(cfg.get("api_key", ""))
        return _probe(
            3, "Config loaded", "pass",
            f"Config OK — api_key length={api_key_len}, connection_id={cfg.get('connection_id')}",
            latency_ms=latency_ms,
        )
    except FileNotFoundError:
        return _probe(
            3, "Config loaded", "fail",
            f"Config file not found: {config_path}",
            fix=f"Re-run installer: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash",
        )
    except Exception as exc:
        return _probe(
            3, "Config loaded", "fail",
            f"Failed to read config: {exc}",
            fix=f"Check {config_path} for YAML syntax errors",
        )


def probe_4_listener_reachable(host: str, port: int) -> Dict[str, Any]:
    """Probe 4 — TNS listener TCP probe (no credentials required)."""
    from agent.db import listener_reachable
    result = listener_reachable(host, port)
    if result["ok"]:
        return _probe(
            4, "TNS listener reachable", "pass",
            f"TCP {host}:{port} → {result['latency_ms']}ms",
            latency_ms=result["latency_ms"],
        )
    return _probe(
        4, "TNS listener reachable", "fail",
        f"TCP {host}:{port} unreachable — {result['error']}",
        fix=f"Check firewall rules and Oracle listener status: lsnrctl status",
        latency_ms=result["latency_ms"],
    )


def probe_5_oracle_auth(cfg: Any) -> Dict[str, Any]:
    """Probe 5 — Oracle auth + SELECT 1 FROM DUAL via thin mode."""
    from agent.db import ping
    result = ping(cfg)
    if result["ok"]:
        ver = result.get("oracle_version") or "unknown"
        return _probe(
            5, "Oracle auth & query", "pass",
            f"SELECT 1 FROM DUAL → {result['latency_ms']}ms | DB version {ver}",
            latency_ms=result["latency_ms"],
        )
    return _probe(
        5, "Oracle auth & query", "fail",
        f"Oracle query failed — {result['error']}",
        fix="Check username/password and service_name in agent.yaml",
        latency_ms=result["latency_ms"],
    )


def probe_6_cloud_registered(api_url: str, api_key: str, connection_id: int) -> Dict[str, Any]:
    """Probe 6 — Confirm agent is registered with TuneVault cloud."""
    import urllib.request as _ureq
    import urllib.error as _uerr
    import json

    t0 = time.monotonic()
    url = f"{api_url.rstrip('/')}/api/agent/status?connection_id={connection_id}"
    try:
        req = _ureq.Request(url, headers={"X-TuneVault-Key": api_key})
        with _ureq.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
        latency_ms = round((time.monotonic() - t0) * 1000)
        registered = body.get("registered", False)
        status = body.get("status", "unknown")
        if registered:
            return _probe(
                6, "Cloud registered", "pass",
                f"Agent registered with TuneVault cloud (status={status}) in {latency_ms}ms",
                latency_ms=latency_ms,
            )
        return _probe(
            6, "Cloud registered", "fail",
            f"Agent not registered (status={status})",
            fix="Re-run installer with a fresh TUNEVAULT_TOKEN from the TuneVault UI",
            latency_ms=latency_ms,
        )
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return _probe(
            6, "Cloud registered", "fail",
            f"Cloud check failed — {exc}",
            fix="Check outbound HTTPS to tunevault.app",
            latency_ms=latency_ms,
        )


def probe_7_version_current(api_url: str) -> Dict[str, Any]:
    """Probe 7 — Agent version is up to date.

    Fetches /api/latest-agent-version from cloud and compares to local VERSION.
    Unlike the legacy stale-proxy detection (which checked if /api/test returned 410),
    v6 checks the version endpoint directly.
    """
    import urllib.request as _ureq
    import json

    t0 = time.monotonic()
    try:
        url = f"{api_url.rstrip('/')}/api/agent/latest-version"
        req = _ureq.Request(url)
        with _ureq.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
        latest = body.get("version", "")
        latency_ms = round((time.monotonic() - t0) * 1000)

        if not latest:
            # Endpoint not available yet — skip gracefully
            return _probe(
                7, "Agent version current", "skip",
                "Version endpoint not available — skipping check",
                latency_ms=latency_ms,
            )

        if VERSION == latest or VERSION >= latest:
            return _probe(
                7, "Agent version current", "pass",
                f"Agent v{VERSION} is current (latest={latest})",
                latency_ms=latency_ms,
            )

        return _probe(
            7, "Agent version current", "fail",
            f"Agent v{VERSION} is outdated (latest={latest})",
            fix="sudo tunevault-agent upgrade",
            latency_ms=latency_ms,
        )
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        # Network failure → skip (don't block healthy green if cloud is unreachable)
        return _probe(
            7, "Agent version current", "skip",
            f"Could not reach version endpoint: {exc}",
            latency_ms=latency_ms,
        )


def probe_8_config_source_unique(agent_env_path: str = "/etc/tunevault/agent.env") -> Dict[str, Any]:
    """Probe 8 — Config source unique (no dual-config drift).

    PASS = no inline TUNEVAULT_* Environment= directives in the active systemd unit,
           OR no overlap between systemd inline vars and agent.env keys.
    FAIL = any TUNEVAULT_* key defined in BOTH the systemd unit (inline Environment=)
           AND agent.env. systemd processes Environment= AFTER EnvironmentFile=, so
           the inline value silently overrides agent.env edits.
    SKIP = systemctl not available (non-systemd host, CI container, Docker).
    """
    import subprocess

    t0 = time.monotonic()

    # Try to read inline Environment= from active systemd unit
    unit_env_keys: List[str] = []
    unit_env_lines: List[str] = []
    systemctl_available = False

    for svc in ("tunevault-agent", "tunevault-proxy"):
        try:
            result = subprocess.run(
                ["systemctl", "cat", svc],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=10,  # capture_output/text=3.7+
            )
            systemctl_available = True
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    stripped = line.strip()
                    if stripped.startswith("Environment=TUNEVAULT_"):
                        unit_env_lines.append(stripped)
                        kv = stripped[len("Environment="):]
                        key = kv.split("=", 1)[0]
                        unit_env_keys.append(key)
                break  # found a unit — stop trying
        except FileNotFoundError:
            # systemctl not on PATH
            break
        except Exception:
            systemctl_available = True  # systemctl exists but unit not found — that's fine

    latency_ms = round((time.monotonic() - t0) * 1000)

    if not systemctl_available:
        return _probe(
            8, "Config source unique", "skip",
            "systemctl not available — skipping dual-config drift check",
            latency_ms=latency_ms,
        )

    if not unit_env_keys:
        return _probe(
            8, "Config source unique", "pass",
            "No inline Environment=TUNEVAULT_* in systemd unit — agent.env is sole source of truth",
            latency_ms=latency_ms,
        )

    # Check overlap with agent.env
    agent_env_keys: List[str] = []
    try:
        with open(agent_env_path) as f:
            for line in f:
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and "=" in stripped:
                    agent_env_keys.append(stripped.split("=", 1)[0])
    except FileNotFoundError:
        pass

    overlap = list(set(unit_env_keys) & set(agent_env_keys))
    if not overlap:
        # Inline vars exist but don't overlap agent.env — unusual but not an immediate problem
        return _probe(
            8, "Config source unique", "pass",
            f"Inline Environment= vars in unit ({len(unit_env_keys)}) but no overlap with agent.env",
            latency_ms=latency_ms,
        )

    # Overlap: the dangerous case — systemd inline overrides .env silently
    overlap_str = ", ".join(overlap)
    detail_lines = []
    for line in unit_env_lines:
        kv = line[len("Environment="):]
        key = kv.split("=", 1)[0]
        if key in overlap:
            detail_lines.append(f"  {line}")

    detail = (
        f"DUAL-CONFIG DRIFT: {overlap_str} defined in BOTH the systemd unit (inline "
        f"Environment=) AND agent.env. systemd Environment= overrides EnvironmentFile= — "
        f"your agent.env edits are silently shadowed."
    )
    return _probe(
        8, "Config source unique", "fail",
        detail,
        fix="sudo tunevault-agent migrate-config  (removes inline Environment= lines, consolidates into agent.env)",
        latency_ms=latency_ms,
    )


def probe_9_release_match(api_url: str) -> Dict[str, Any]:
    """Probe 9 — Release manifest integrity: installed version + sha256 vs cloud manifest.

    Fetches /api/agent/release from cloud and checks:
    1. Installed VERSION matches manifest version.
    2. If cloud reports served_sha256 != manifest sha256, flags the stale-tarball scenario.
    """
    import urllib.request as _ureq
    import json as _json

    t0 = time.monotonic()
    url = f"{api_url.rstrip('/')}/api/agent/release"
    try:
        req = _ureq.Request(url)
        with _ureq.urlopen(req, timeout=10) as resp:
            body = _json.loads(resp.read())
        latency_ms = round((time.monotonic() - t0) * 1000)

        manifest_version = body.get("version", "")
        manifest_sha256 = body.get("sha256", "")
        served_sha256 = body.get("served_sha256", "")
        warning = body.get("warning", "")
        match = body.get("match")

        issues = []

        # Check 1: installed version vs manifest
        if manifest_version and VERSION != manifest_version:
            issues.append(f"installed v{VERSION} != manifest v{manifest_version} (run: sudo tunevault-agent upgrade)")

        # Check 2: served tarball vs committed manifest (cloud-side detection)
        if match is False and warning:
            issues.append(f"cloud: {warning}")

        if issues:
            return _probe(
                9, "Release match", "fail",
                " | ".join(issues),
                fix="sudo tunevault-agent upgrade  and re-run: curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --upgrade",
                latency_ms=latency_ms,
            )

        detail_parts = [f"v{VERSION} matches manifest"]
        if match is True:
            detail_parts.append(f"served sha256 OK ({served_sha256[:16]}...)")
        return _probe(9, "Release match", "pass", " | ".join(detail_parts), latency_ms=latency_ms)

    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return _probe(
            9, "Release match", "skip",
            f"Could not reach release endpoint: {exc}",
            latency_ms=latency_ms,
        )


def run_all(config_path: str = "/etc/tunevault/agent.yaml") -> Dict[str, Any]:
    """Run all probes (8 diagnostic + 1 release-match). Returns the canonical diagnostic report.

    Returns:
        {
            "ok": bool,
            "probes": List[dict],
            "passed": int,
            "total": int,
            "ran_at": str,
        }
    """
    import yaml
    import json
    from datetime import datetime

    probes = []

    # Probe 1 — always passes (agent is running)
    probes.append(probe_1_agent_online())

    # Probe 2 — driver imports
    probes.append(probe_2_python_drivers())

    # Probe 3 — config file
    p3 = probe_3_config_loaded(config_path)
    probes.append(p3)

    # If config not loaded, skip the remaining probes (no credentials to use)
    # Probe 8 still runs — it only needs systemctl, not the config file.
    if p3["status"] != "pass":
        for i, name in [
            (4, "TNS listener reachable"),
            (5, "Oracle auth & query"),
            (6, "Cloud registered"),
            (7, "Agent version current"),
        ]:
            probes.append(_probe(i, name, "skip", "Skipped — config not loaded"))
        # Probe 8: use default agent.env path since config_path is unknown
        probes.append(probe_8_config_source_unique("/etc/tunevault/agent.env"))
        # Probe 9: release match works without config — uses default API URL
        probes.append(probe_9_release_match("https://tunevault.app"))
        return _build_report(probes)

    # Load config for remaining probes
    try:
        with open(config_path) as f:
            cfg_data = yaml.safe_load(f)
    except Exception as exc:
        log.error("Config reload failed: %s", exc)
        cfg_data = {}

    host = cfg_data.get("host", "")
    port = int(cfg_data.get("port", 1521))
    api_url = cfg_data.get("api_url", "")
    api_key = cfg_data.get("api_key", "")
    connection_id = cfg_data.get("connection_id", 0)

    # Probe 4 — TCP listener
    if host and port:
        probes.append(probe_4_listener_reachable(host, port))
    else:
        probes.append(_probe(4, "TNS listener reachable", "skip", "No host/port in config"))

    # Probe 5 — Oracle auth
    if p3["status"] == "pass" and host:
        from agent.db import DBConfig
        db_cfg = DBConfig(
            host=host,
            port=port,
            service_name=cfg_data.get("service_name", ""),
            username=cfg_data.get("username", ""),
            password=cfg_data.get("password", ""),
        )
        probes.append(probe_5_oracle_auth(db_cfg))
    else:
        probes.append(_probe(5, "Oracle auth & query", "skip", "Skipped — incomplete DB config"))

    # Probe 6 — cloud registration
    if api_url and api_key and connection_id:
        probes.append(probe_6_cloud_registered(api_url, api_key, connection_id))
    else:
        probes.append(_probe(6, "Cloud registered", "skip", "Skipped — missing api_url/api_key/connection_id"))

    # Probe 7 — version
    probes.append(probe_7_version_current(api_url or "https://tunevault.app"))

    # Probe 8 — config source unique (no dual-config drift)
    # agent.env path is next to agent.yaml (/etc/tunevault/)
    agent_env_path = os.path.join(os.path.dirname(config_path), "agent.env")
    probes.append(probe_8_config_source_unique(agent_env_path))

    # Probe 9 — release manifest integrity (installed version + sha256 vs cloud manifest)
    probes.append(probe_9_release_match(api_url or "https://tunevault.app"))

    return _build_report(probes)


def _build_report(probes: List[dict]) -> Dict[str, Any]:
    from datetime import datetime, timezone
    passed = sum(1 for p in probes if p["status"] == "pass")
    total = len(probes)
    return {
        "ok": all(p["status"] in ("pass", "skip") for p in probes),
        "probes": probes,
        "passed": passed,
        "total": total,
        "ran_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
