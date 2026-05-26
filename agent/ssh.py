"""
agent/ssh.py — SSH connectivity via paramiko.
Owns: SSH connection lifecycle, command execution, lsnrctl parsing for service discovery,
      bastion/ProxyJump support, host-key fingerprint capture.
Does NOT own: Oracle DB queries, poll loop, CLI, probe orchestration.

Uses paramiko — pure Python SSH, no subprocess/shell-out, no ssh binary.
Jump host / bastion support via ProxyJump (open_connection_with_bastion).
"""


import hashlib
import io
import logging
import re
import time
from typing import List, Optional, Set, Tuple

log = logging.getLogger("tunevault.ssh")

try:
    import paramiko  # type: ignore[import]
except ImportError as _e:
    raise SystemExit(
        "FATAL: paramiko not installed.\n"
        "Run: pip install paramiko\n"
        f"Original error: {_e}"
    ) from _e


class SSHConfig:
    """SSH connection parameters (key or password auth)."""

    __slots__ = ("host", "port", "username", "auth_method", "key_content", "password", "key_passphrase")

    def __init__(
        self,
        host: str,
        port: int = 22,
        username: str = "oracle",
        auth_method: str = "key",      # "key" or "password"
        key_content: Optional[str] = None,   # PEM-encoded private key text
        password: Optional[str] = None,
        key_passphrase: Optional[str] = None,
    ) -> None:
        self.host = host
        self.port = int(port)
        self.username = username
        self.auth_method = auth_method
        self.key_content = key_content
        self.password = password
        self.key_passphrase = key_passphrase

    def __repr__(self) -> str:
        return f"SSHConfig(host={self.host!r}, port={self.port}, user={self.username!r}, auth={self.auth_method!r})"


def _load_private_key(key_content: str, passphrase: Optional[str] = None) -> paramiko.PKey:
    """Parse PEM key content into a paramiko PKey object.

    Tries RSA, Ed25519, ECDSA, DSS in that order.
    """
    key_bytes = key_content.encode() if isinstance(key_content, str) else key_content
    pp = passphrase.encode() if isinstance(passphrase, str) else passphrase

    for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey):
        try:
            return key_cls.from_private_key(io.BytesIO(key_bytes), password=pp)
        except Exception:
            continue
    raise ValueError("Could not parse private key — unsupported type or wrong passphrase")


def _build_connect_kwargs(cfg: SSHConfig, timeout_s: float) -> dict:
    """Build paramiko.SSHClient.connect() keyword args from an SSHConfig."""
    kwargs: dict = {
        "hostname": cfg.host,
        "port": cfg.port,
        "username": cfg.username,
        "timeout": timeout_s,
        "look_for_keys": False,
        "allow_agent": cfg.auth_method == "agent_forward",
    }
    if cfg.auth_method in ("key", "key_upload") and cfg.key_content:
        kwargs["pkey"] = _load_private_key(cfg.key_content, cfg.key_passphrase)
    elif cfg.auth_method == "password" and cfg.password:
        kwargs["password"] = cfg.password
    elif cfg.auth_method == "agent_forward":
        # SSH agent forwarding — paramiko uses the running ssh-agent automatically
        pass
    else:
        raise ValueError(f"auth_method={cfg.auth_method!r} requires matching credential fields")
    return kwargs


def _capture_host_key_pin(client: "paramiko.SSHClient") -> Optional[str]:
    """Return SHA256 fingerprint of the remote host key, or None if unavailable."""
    try:
        transport = client.get_transport()
        if transport is None:
            return None
        host_key = transport.get_remote_server_key()
        key_bytes = host_key.asbytes()
        digest = hashlib.sha256(key_bytes).digest()
        import base64
        pin = "SHA256:" + base64.b64encode(digest).decode().rstrip("=")
        return pin
    except Exception:
        return None


def open_connection(cfg: SSHConfig, timeout_s: float = 15.0) -> paramiko.SSHClient:
    """Open an SSH connection and return the connected SSHClient.

    Caller is responsible for client.close().
    Uses AutoAddPolicy for known_hosts — suitable for first-connect server installs.
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = _build_connect_kwargs(cfg, timeout_s)

    log.debug("SSH connecting to %s@%s:%d", cfg.username, cfg.host, cfg.port)
    client.connect(**connect_kwargs)
    log.debug("SSH connected to %s@%s:%d", cfg.username, cfg.host, cfg.port)
    return client


def open_connection_with_bastion(
    cfg: SSHConfig,
    bastion: Optional[SSHConfig] = None,
    timeout_s: float = 15.0,
) -> Tuple["paramiko.SSHClient", Optional[str]]:
    """Open SSH connection, optionally via bastion/jump host.

    Returns (client, host_key_pin).
    Caller is responsible for client.close().

    When bastion is provided, establishes a ProxyJump-style tunnel:
      local → bastion → target
    Both hops use paramiko so no system ssh binary is needed.
    """
    if bastion is None:
        client = open_connection(cfg, timeout_s=timeout_s)
        pin = _capture_host_key_pin(client)
        return client, pin

    # ── Bastion hop ──────────────────────────────────────────────────────────
    log.debug("SSH via bastion %s@%s:%d → %s@%s:%d",
              bastion.username, bastion.host, bastion.port,
              cfg.username, cfg.host, cfg.port)

    bastion_client = paramiko.SSHClient()
    bastion_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    bastion_kwargs = _build_connect_kwargs(bastion, timeout_s)
    bastion_client.connect(**bastion_kwargs)

    try:
        # Open a direct-tcpip channel through the bastion to the target
        bastion_transport = bastion_client.get_transport()
        if bastion_transport is None:
            raise RuntimeError("Bastion transport not available after connect")

        dest_addr = (cfg.host, cfg.port)
        src_addr = (bastion.host, 0)
        channel = bastion_transport.open_channel("direct-tcpip", dest_addr, src_addr)

        target_client = paramiko.SSHClient()
        target_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        target_kwargs = _build_connect_kwargs(cfg, timeout_s)
        target_kwargs["sock"] = channel  # tunnel through bastion channel

        target_client.connect(**target_kwargs)
        pin = _capture_host_key_pin(target_client)
        log.debug("SSH connected via bastion to %s@%s:%d (pin=%s)",
                  cfg.username, cfg.host, cfg.port, pin)
        return target_client, pin
    except Exception:
        bastion_client.close()
        raise


def run_command(
    client: paramiko.SSHClient,
    command: str,
    timeout_s: float = 30.0,
) -> dict:
    """Execute a command on an open SSH connection.

    Returns:
        {
            "ok": bool,
            "exit_code": int,
            "stdout": str,
            "stderr": str,
            "latency_ms": int,
        }
    """
    t0 = time.monotonic()
    log.debug("SSH exec: %r", command)
    try:
        _, stdout_ch, stderr_ch = client.exec_command(command, timeout=timeout_s)
        exit_code = stdout_ch.channel.recv_exit_status()
        stdout = stdout_ch.read().decode("utf-8", errors="replace")
        stderr = stderr_ch.read().decode("utf-8", errors="replace")
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.debug("SSH exec done in %dms, exit=%d", latency_ms, exit_code)
        return {
            "ok": exit_code == 0,
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "latency_ms": latency_ms,
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.warning("SSH exec failed in %dms: %s", latency_ms, exc)
        return {
            "ok": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(exc),
            "latency_ms": latency_ms,
        }


def parse_lsnrctl_services(lsnrctl_output: str) -> List[str]:
    """Parse service names from `lsnrctl status` or `lsnrctl services` output.

    Handles the two common output formats:
      Service "ORCL" has 1 instance(s).
      Service "PROD.world" has 2 instance(s).

    Returns list of unique service names, de-duped and lowercased.
    """
    # Match: Service "NAME" has N instance(s).
    pattern = re.compile(r'Service "([^"]+)"', re.IGNORECASE)
    services = pattern.findall(lsnrctl_output)
    # Dedupe preserving order
    seen: Set[str] = set()
    result: List[str] = []
    for svc in services:
        key = svc.lower()
        if key not in seen:
            seen.add(key)
            result.append(svc)
    return result


def discover_services(cfg: SSHConfig, timeout_s: float = 30.0) -> dict:
    """SSH into host and run lsnrctl status to discover Oracle service names.

    This replaces PMON /proc parsing, oratab parsing, and all bash SID detection.

    Returns:
        {
            "ok": bool,
            "services": List[str],
            "raw_output": str,
            "error": str | None,
            "latency_ms": int,
        }
    """
    t0 = time.monotonic()
    try:
        with open_connection(cfg, timeout_s=timeout_s) as client:
            result = run_command(
                client,
                # Try lsnrctl status; fall back gracefully if listener not running
                "lsnrctl status 2>&1 || echo 'LSNRCTL_FAILED'",
                timeout_s=timeout_s,
            )
        raw = result["stdout"]
        services = parse_lsnrctl_services(raw)
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.info("Discovered %d service(s) via lsnrctl in %dms: %s", len(services), latency_ms, services)
        return {
            "ok": bool(services),
            "services": services,
            "raw_output": raw,
            "error": None if services else "No Oracle services found in lsnrctl output",
            "latency_ms": latency_ms,
        }
    except Exception as exc:
        latency_ms = round((time.monotonic() - t0) * 1000)
        log.warning("Service discovery failed in %dms: %s", latency_ms, exc)
        return {
            "ok": False,
            "services": [],
            "raw_output": "",
            "error": str(exc),
            "latency_ms": latency_ms,
        }
