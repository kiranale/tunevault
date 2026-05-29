"""
agent/bootstrap.py — Oracle Instant Client self-healing bootstrap.
Owns: thick-mode detection, Instant Client download, init_oracle_client() call.
Does NOT own: Oracle connection lifecycle (db.py), poll loop (poll.py), CLI (cli.py).

Used by oracle_worker.py when a first-connect attempt raises DPY-3015, DPY-3001,
ORA-28040, or ORA-01017 with 11g-verifier markers, to transparently recover without
operator intervention.

Persistence:
  thick_mode=true is written to agent.env once the first successful thick-mode
  connection is established. On subsequent agent restarts, oracle_worker.py reads
  this flag and skips the probe, calling ensure_thick_client() directly.
"""


import logging
import os
import platform
import re
import subprocess
import tempfile
import time
import urllib.request as _ureq
from pathlib import Path
from typing import List, Optional

log = logging.getLogger("tunevault.bootstrap")

# ── Constants ─────────────────────────────────────────────────────────────────

INSTANT_CLIENT_DIR = "/opt/tunevault/instantclient"
LIBCLNTSH_PATH = f"{INSTANT_CLIENT_DIR}/libclntsh.so"

# Default TuneVault API URL — can be overridden via env
_DEFAULT_API_URL = os.environ.get("TUNEVAULT_API", "https://tunevault.app").rstrip("/")

# RPM filename allowlist per arch — mirrors routes/downloads.js IC_ALLOWLIST
_IC_RPMS = {
    "x86_64": [
        "oracle-instantclient21-basic.rpm",
        "oracle-instantclient21-sqlplus.rpm",
    ],
    "aarch64": [
        "oracle-instantclient19.1-basic-19.1.0.0.0-1.aarch64.rpm",
        "oracle-instantclient19.1-sqlplus-19.1.0.0.0-1.aarch64.rpm",
    ],
}

AGENT_ENV_PATH = "/etc/tunevault/agent.env"

# ── Error classification ──────────────────────────────────────────────────────

# DPY errors (python-oracledb thin-mode rejection codes)
_VERIFIER_MISMATCH_DPY = re.compile(r"\b(DPY-3015|DPY-3001)\b")

# ORA codes associated with 11g verifier mismatch
_VERIFIER_MISMATCH_ORA = re.compile(r"\b(ORA-28040|ORA-01017)\b")

# 11g verifier marker strings present in ORA-01017 messages from 12c+ servers
_11G_VERIFIER_MARKERS = [
    "authentication protocol requested by client not supported by server",
    "11g",
    "o5logon",
    "ORA-28040",
]


def is_verifier_mismatch(error_message: str) -> bool:
    """Return True if the error is a thin-mode / 11g verifier mismatch.

    Catches:
      - DPY-3015: unsupported server version (thin mode, pre-12c server)
      - DPY-3001: thin mode protocol limitation
      - ORA-28040: no matching authentication protocol
      - ORA-01017: invalid user/pass WITH 11g verifier markers
        (plain auth failure without markers = wrong password, not a verifier issue)
    """
    msg = error_message.lower()
    if _VERIFIER_MISMATCH_DPY.search(error_message):
        return True
    if re.search(r"ORA-28040", error_message):
        return True
    # ORA-01017 alone is ambiguous — only treat as verifier mismatch if accompanied
    # by protocol/verifier context that signals a server-side restriction, not a
    # password typo.
    if re.search(r"ORA-01017", error_message):
        for marker in _11G_VERIFIER_MARKERS:
            if marker in msg:
                return True
    return False


# ── Instant Client detection & install ────────────────────────────────────────

def _detect_arch() -> str:
    """Return 'x86_64' or 'aarch64'. Raises ValueError for unsupported arches."""
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x86_64"
    if machine in ("aarch64", "arm64"):
        return "aarch64"
    raise ValueError(f"Unsupported architecture for Instant Client: {machine}")


def _libclntsh_present() -> bool:
    """True if Instant Client libclntsh.so already exists on disk."""
    return os.path.exists(LIBCLNTSH_PATH)


def _find_system_libclntsh() -> Optional[str]:
    """Scan common Oracle Instant Client install paths for libclntsh.so.

    Returns the directory containing libclntsh.so, or None if not found.
    """
    search_dirs = [
        INSTANT_CLIENT_DIR,
        "/usr/lib/oracle/21/client64/lib",
        "/usr/lib/oracle/19.1/client64/lib",
        "/usr/lib/oracle/18.5/client64/lib",
        "/opt/oracle/instantclient_21_10",
        "/opt/oracle/instantclient_21_5",
        "/opt/oracle/instantclient_19_8",
        "/opt/oracle/instantclient",
        "/usr/local/lib",
    ]
    # Check ORACLE_HOME env var first (highest priority — set by install.sh in agent.env)
    oracle_home = os.environ.get("ORACLE_HOME", "")
    if oracle_home:
        search_dirs.insert(0, f"{oracle_home}/lib")

    # Also glob full Oracle DB server product paths (e.g. /u01/app/oracle/product/19.0.0/db_1/lib)
    # These are present on DB servers but NOT on Instant Client / app-tier-only installs.
    # We add them dynamically so we don't hardcode version numbers.
    import glob as _glob
    _db_globs = [
        "/u*/app/oracle/product/*/db_*/lib",
        "/u*/app/oracle/product/*/dbhome_*/lib",
        "/oracle/app/oracle/product/*/db_*/lib",
    ]
    for _pat in _db_globs:
        for _match in sorted(_glob.glob(_pat), reverse=True):  # newest version first
            if _match not in search_dirs:
                search_dirs.append(_match)

    for d in search_dirs:
        candidate = os.path.join(d, "libclntsh.so")
        # Also try versioned symlinks
        if os.path.exists(candidate):
            return d
        # Try glob for libclntsh.so.X
        try:
            for entry in os.scandir(d):
                if entry.name.startswith("libclntsh.so"):
                    return d
        except (FileNotFoundError, PermissionError):
            pass
    return None


def _download_rpm(api_url: str, arch: str, filename: str, dest_dir: str, timeout_s: int = 300) -> str:
    """Download a single RPM from the TuneVault IC mirror proxy.

    Returns the path to the downloaded file.
    Raises on HTTP error or timeout.
    """
    url = f"{api_url}/downloads/instantclient/{arch}/{filename}"
    dest_path = os.path.join(dest_dir, filename)
    log.info("Downloading Instant Client RPM: %s → %s", url, dest_path)

    req = _ureq.Request(url, method="GET")
    with _ureq.urlopen(req, timeout=timeout_s) as resp:
        if resp.status != 200:
            raise RuntimeError(f"IC mirror returned HTTP {resp.status} for {filename}")
        with open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)

    log.info("Downloaded %s (%.1f MB)", filename, os.path.getsize(dest_path) / 1_048_576)
    return dest_path


def _install_rpms(api_url: str, arch: str, target_dir: str = INSTANT_CLIENT_DIR) -> str:
    """Download and install Instant Client RPMs for the given arch.

    Uses rpm2cpio + cpio to extract without rpm (works on Docker / non-root-friendly setups
    where rpm install is available, but also handles the cpio extraction fallback).

    Returns the directory containing libclntsh.so.
    Raises RuntimeError on failure.
    """
    rpms = _IC_RPMS.get(arch)
    if not rpms:
        raise ValueError(f"No RPM list for arch {arch}")

    os.makedirs(target_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="tunevault-ic-") as tmp_dir:
        # Download all RPMs
        rpm_paths = []
        for filename in rpms:
            rp = _download_rpm(api_url, arch, filename, tmp_dir)
            rpm_paths.append(rp)

        # Try rpm install first (most EBS servers have rpm)
        rpm_bin = _which("rpm")
        if rpm_bin:
            try:
                log.info("Installing via rpm --install ...")
                result = subprocess.run(
                    [rpm_bin, "--install", "--nodeps", "--prefix", target_dir] + rpm_paths,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,  # Python 3.6 compat (text= is 3.7+)
                    timeout=120,
                )
                if result.returncode == 0:
                    log.info("RPM install succeeded")
                    lib_dir = _find_system_libclntsh() or target_dir
                    return lib_dir
                else:
                    log.warning("rpm --install failed: %s — falling back to rpm2cpio", result.stderr[:200])
            except Exception as exc:
                log.warning("rpm install exception: %s — falling back to rpm2cpio", exc)

        # Fallback: rpm2cpio + cpio extraction
        rpm2cpio = _which("rpm2cpio")
        cpio_bin = _which("cpio")
        if rpm2cpio and cpio_bin:
            log.info("Extracting via rpm2cpio + cpio ...")
            for rp in rpm_paths:
                extract_dir = os.path.join(tmp_dir, "extract")
                os.makedirs(extract_dir, exist_ok=True)
                try:
                    # rpm2cpio <rpm> | cpio -idmv
                    r2c = subprocess.run(
                        [rpm2cpio, rp],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=60,
                    )
                    subprocess.run(
                        [cpio_bin, "-idmv"],
                        input=r2c.stdout,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        cwd=extract_dir,
                        timeout=60,
                    )
                    # Copy extracted libs to target_dir
                    for root, dirs, files in os.walk(extract_dir):
                        for fname in files:
                            if fname.startswith("libclntsh") or fname.startswith("libnnz") or fname.startswith("libocci"):
                                src = os.path.join(root, fname)
                                dst = os.path.join(target_dir, fname)
                                try:
                                    import shutil
                                    shutil.copy2(src, dst)
                                    log.debug("Copied %s → %s", fname, target_dir)
                                except Exception as e:
                                    log.warning("Copy failed %s: %s", fname, e)
                except Exception as exc:
                    log.warning("rpm2cpio extract failed for %s: %s", rp, exc)

            # Create libclntsh.so symlink if only versioned file exists
            _fix_libclntsh_symlink(target_dir)
            if os.path.exists(LIBCLNTSH_PATH) or _find_system_libclntsh():
                return target_dir

        raise RuntimeError(
            f"Could not install Instant Client: neither rpm nor rpm2cpio+cpio succeeded. "
            f"Target dir: {target_dir}"
        )


def _fix_libclntsh_symlink(lib_dir: str) -> None:
    """Create libclntsh.so → libclntsh.so.21.1 (or .19.1) symlink if needed."""
    so_path = os.path.join(lib_dir, "libclntsh.so")
    if os.path.exists(so_path):
        return  # already present
    # Find a versioned candidate
    try:
        for entry in os.scandir(lib_dir):
            if entry.name.startswith("libclntsh.so."):
                os.symlink(entry.path, so_path)
                log.info("Created symlink: %s → %s", so_path, entry.name)
                return
    except Exception as exc:
        log.warning("Could not create libclntsh.so symlink: %s", exc)


def _which(cmd: str) -> Optional[str]:
    import shutil
    return shutil.which(cmd)


# ── Thick mode persistence ─────────────────────────────────────────────────────

def _read_thick_mode_flag() -> bool:
    """Return True if thick_mode=true is set in agent.env."""
    try:
        with open(AGENT_ENV_PATH) as f:
            for line in f:
                stripped = line.strip()
                if stripped == "ORACLE_THICK_MODE=true":
                    return True
    except FileNotFoundError:
        pass
    except Exception as exc:
        log.debug("Could not read agent.env for thick_mode flag: %s", exc)
    return False


def _persist_thick_mode(lib_dir: str) -> None:
    """Write ORACLE_THICK_MODE=true and ORACLE_INSTANT_CLIENT_DIR=<path> to agent.env atomically.

    Safe to call multiple times — idempotent.
    """
    try:
        existing: List[str] = []
        try:
            with open(AGENT_ENV_PATH) as f:
                existing = f.readlines()
        except FileNotFoundError:
            pass

        # Remove old thick mode lines
        new_lines = [
            l for l in existing
            if not l.startswith("ORACLE_THICK_MODE=")
            and not l.startswith("ORACLE_INSTANT_CLIENT_DIR=")
        ]
        new_lines.append("ORACLE_THICK_MODE=true\n")
        new_lines.append(f"ORACLE_INSTANT_CLIENT_DIR={lib_dir}\n")

        env_dir = os.path.dirname(AGENT_ENV_PATH)
        os.makedirs(env_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=env_dir, prefix=".agent-env-")
        try:
            with os.fdopen(fd, "w") as f:
                f.writelines(new_lines)
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, AGENT_ENV_PATH)
        except Exception:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
            raise

        log.info("Persisted thick_mode=true + instant_client_dir=%s to agent.env", lib_dir)
    except Exception as exc:
        # Non-fatal — worst case is we re-probe on next restart
        log.warning("Could not persist thick_mode flag to agent.env: %s", exc)


# ── Main entry point ───────────────────────────────────────────────────────────

def ensure_thick_client(api_url: Optional[str] = None) -> dict:
    """Ensure Oracle Instant Client is installed and init_oracle_client() is called.

    Steps:
      1. Check if libclntsh.so already exists at INSTANT_CLIENT_DIR.
      2. If not, scan system paths (Oracle ORACLE_HOME, common paths).
      3. If still not found, download RPMs from the TuneVault IC mirror proxy and install.
      4. Call oracledb.init_oracle_client(lib_dir=...) to switch to thick mode.
      5. Persist thick_mode=true to agent.env so restarts skip the probe overhead.

    Returns a result dict:
      {
        "ok": bool,
        "lib_dir": str | None,         # path used for init_oracle_client
        "source": str,                  # "existing" | "system" | "downloaded"
        "attempted_actions": List[str], # human-readable action log
        "error": str | None,            # error message if ok=False
      }

    Does NOT raise — always returns a dict.
    """
    import oracledb  # type: ignore[import]

    url = (api_url or _DEFAULT_API_URL).rstrip("/")
    actions: List[str] = []

    # Already in thick mode (from a previous call in this process)
    if not oracledb.is_thin_mode():
        return {
            "ok": True,
            "lib_dir": os.environ.get("ORACLE_INSTANT_CLIENT_DIR", INSTANT_CLIENT_DIR),
            "source": "already_thick",
            "attempted_actions": ["oracledb already in thick mode"],
            "error": None,
        }

    # 1. Check our managed directory
    if _libclntsh_present():
        lib_dir = INSTANT_CLIENT_DIR
        actions.append(f"Found existing libclntsh.so at {lib_dir}")
        source = "existing"
    else:
        # 2. Scan system paths
        sys_dir = _find_system_libclntsh()
        if sys_dir:
            lib_dir = sys_dir
            actions.append(f"Found system libclntsh.so at {lib_dir}")
            source = "system"
        else:
            # 3. Download and install RPMs
            actions.append("libclntsh.so not found — downloading Instant Client RPMs from TuneVault mirror")
            try:
                arch = _detect_arch()
                actions.append(f"Detected arch: {arch}")
                lib_dir = _install_rpms(api_url=url, arch=arch)
                actions.append(f"Installed Instant Client RPMs to {lib_dir}")
                source = "downloaded"
            except Exception as exc:
                err_msg = f"Instant Client download/install failed: {exc}"
                log.error(err_msg)
                actions.append(err_msg)
                return {
                    "ok": False,
                    "lib_dir": None,
                    "source": "download_failed",
                    "attempted_actions": actions,
                    "error": err_msg,
                }

    # 4. Call init_oracle_client()
    try:
        actions.append(f"Calling oracledb.init_oracle_client(lib_dir={lib_dir!r})")
        oracledb.init_oracle_client(lib_dir=lib_dir)
        actions.append("oracledb switched to thick mode successfully")
        log.info("Oracle thick mode active — lib_dir=%s (source=%s)", lib_dir, source)
    except Exception as exc:
        err_msg = f"init_oracle_client failed: {exc}"
        log.error(err_msg)
        actions.append(err_msg)
        return {
            "ok": False,
            "lib_dir": lib_dir,
            "source": source,
            "attempted_actions": actions,
            "error": err_msg,
        }

    # 5. Persist to agent.env (fire-and-forget)
    _persist_thick_mode(lib_dir)

    return {
        "ok": True,
        "lib_dir": lib_dir,
        "source": source,
        "attempted_actions": actions,
        "error": None,
    }


def should_try_thick_at_start() -> bool:
    """Return True if agent.env contains ORACLE_THICK_MODE=true.

    Used by oracle_worker.py to skip the probe on known-thick-mode agents
    and go straight to ensure_thick_client() at startup.
    """
    return _read_thick_mode_flag()
