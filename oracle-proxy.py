#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TuneVault Oracle HTTP Proxy
============================
Runs on your Oracle server. Exposes an HTTP endpoint that TuneVault
calls through your HTTPS proxy to collect Oracle health metrics.

Architecture:
  TuneVault (Render) -> HTTPS -> Outbound Proxy -> localhost:3100 -> Oracle :1521

Quick Start:
  export TUNEVAULT_API_KEY="your-secret-key-here"
  python3 oracle-proxy.py

With systemd (recommended for production):
  systemctl start tunevault-proxy
  systemctl enable tunevault-proxy

Requirements:
  - Python 3.6+
  - cx_Oracle (pip3 install cx_Oracle)
  - ORACLE_HOME and LD_LIBRARY_PATH set to include Oracle client libs
  - TUNEVAULT_API_KEY environment variable

The proxy listens on 127.0.0.1:3100 only.
Your HTTPS proxy should point to http://localhost:3100

Update your proxy config to route:
  hostname: oracledb.yourdomain.com
  service: http://localhost:3100  (was: tcp://localhost:1521)
"""

from __future__ import print_function

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timedelta

# Python 3.6 compatible HTTP server
try:
    from http.server import HTTPServer, BaseHTTPRequestHandler
except ImportError:
    print("FATAL: Python 3 is required. http.server module not found.")
    sys.exit(1)

try:
    from urllib.request import urlopen, Request
    from urllib.error import URLError, HTTPError
except ImportError:
    print("FATAL: Python 3 is required. urllib.request module not found.")
    sys.exit(1)

# Try cx_Oracle first (thick driver, requires Oracle Instant Client).
# Fall back to oracledb thin driver (pure Python, no client libs required).
# If neither is available the agent cannot connect to Oracle — abort to prevent crash-loop.
_ORACLE_DRIVER = None
_ORACLE_VERSION = "unknown"
_ORACLEDB_THICK_MODE = False  # True when oracledb.init_oracle_client() succeeded

try:
    import cx_Oracle
    _ORACLE_DRIVER = "cx_Oracle"
    _ORACLE_VERSION = cx_Oracle.version
except ImportError:
    pass

def _oracle_client_major(lib_dir):
    """Read maximum major version from libclntsh.so.MAJOR.MINOR filenames — safe, no dlopen."""
    import glob as _g
    _max = 0
    for _f in _g.glob(os.path.join(lib_dir, "libclntsh.so.*.*")):
        try:
            _v = int(os.path.basename(_f).split(".")[2])
            if _v > _max:
                _max = _v
        except (IndexError, ValueError):
            pass
    return _max


def _pre_import_client_major():
    """Peek at maximum Oracle client major version across ORACLE_HOME/lib and LD_LIBRARY_PATH dirs."""
    _oh = os.environ.get("ORACLE_HOME", "")
    _dirs = [os.path.join(_oh, "lib")] if _oh else []
    for _d in os.environ.get("LD_LIBRARY_PATH", "").split(":"):
        if _d and ("oracle" in _d.lower() or "instantclient" in _d.lower()):
            _dirs.append(_d)
    _max = 0
    for _d in _dirs:
        if os.path.isdir(_d):
            _v = _oracle_client_major(_d)
            if _v > _max:
                _max = _v
    return _max


if _ORACLE_DRIVER is None:
    try:
        # The sys.modules stub blocks thick_impl.so from loading at import time.
        # oracledb 2.x and 3.x both import thick_impl at package level and access
        # its attributes immediately. On EBS app servers with Oracle 10g/11g client,
        # dlopen of thick_impl.so segfaults in the Cython init — uncatchable.
        #
        # But: with Oracle 12c+ the .so loads cleanly. Stubbing it out on DB servers
        # with 12c+ breaks the import (oracledb gets an empty module, accesses missing
        # attributes, raises AttributeError → ImportError → FATAL).
        #
        # Rule: only stub when client major < 12 (10g/11g segfault risk).
        # - 12c+: no stub → thick_impl.so loads fine → import succeeds → thick mode.
        # - 10g/11g: stub → import blocked safely → thin mode (or FATAL if needed).
        # - No client: no stub → thick_impl.so raises ImportError (no libclntsh.so,
        #   catchable) → oracledb imports in thin mode.
        _pre_major = _pre_import_client_major()
        _need_stub = _pre_major > 0 and _pre_major < 12

        _thick_stub = None
        if _need_stub:
            _thick_stub = type(sys)('oracledb.thick_impl')
            sys.modules['oracledb.thick_impl'] = _thick_stub
        try:
            import oracledb as cx_Oracle  # noqa: N811  — alias so all call sites below work unchanged
        finally:
            if _thick_stub is not None and sys.modules.get('oracledb.thick_impl') is _thick_stub:
                del sys.modules['oracledb.thick_impl']

        _ORACLE_DRIVER = "oracledb"
        _ORACLE_VERSION = cx_Oracle.__version__
        # Switch to thick mode when Oracle client libraries are present on this server.
        # Thin mode rejects password verifier type 0x939 with DPY-3015; thick mode
        # supports all verifier types. EBS DB servers always have ORACLE_HOME set.
        # Must be called once here, before any cx_Oracle.connect() call.
        _oh = os.environ.get("ORACLE_HOME", "")
        _lib_dir = os.path.join(_oh, "lib") if _oh and os.path.isdir(os.path.join(_oh, "lib")) else None
        if _lib_dir is None:
            for _ldir in os.environ.get("LD_LIBRARY_PATH", "").split(":"):
                if _ldir and os.path.isdir(_ldir) and (
                    "oracle" in _ldir.lower() or "instantclient" in _ldir.lower()
                ):
                    _lib_dir = _ldir
                    break

        _thick_ok = True
        if _lib_dir:
            _cv = _oracle_client_major(_lib_dir)
            if _cv and _cv < 12:
                _thick_ok = False  # 10g/11g — skip thick mode
        try:
            if _thick_ok:
                if _lib_dir:
                    cx_Oracle.init_oracle_client(lib_dir=_lib_dir)
                else:
                    cx_Oracle.init_oracle_client()
                _ORACLEDB_THICK_MODE = True
        except Exception:
            pass  # thick mode unavailable (no client libs) — stay in thin mode
    except ImportError:
        pass

# Read SERVER_TYPE from agent.env early — needed to decide whether a missing
# Oracle driver is fatal (db/both) or acceptable (apps).
def _read_server_type():
    for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
        try:
            with open(_p) as _f:
                for _line in _f:
                    if _line.strip().startswith("SERVER_TYPE="):
                        return _line.strip().split("=", 1)[1].strip()
        except Exception:
            pass
    return ""

_SERVER_TYPE = _read_server_type()  # "db" | "apps" | "both" | "unknown" | ""

# Read EBS_DB_HOST from agent.env — used on app servers to redirect Oracle DB connections
# to the remote DB instead of localhost (app servers have no local Oracle instance).
_EBS_DB_HOST = ""
for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
    try:
        with open(_p) as _f:
            for _line in _f:
                if _line.strip().startswith("EBS_DB_HOST="):
                    _EBS_DB_HOST = _line.strip().split("=", 1)[1].strip()
                    break
        if _EBS_DB_HOST:
            break
    except Exception:
        pass


# Read APPS_ENV_FILE from agent.env — path to EBSapps.env on app servers.
# Set by install.sh from the context file s_base attribute.
_APPS_ENV_FILE = ""
for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
    try:
        with open(_p) as _f:
            for _line in _f:
                if _line.strip().startswith("APPS_ENV_FILE="):
                    _APPS_ENV_FILE = _line.strip().split("=", 1)[1].strip()
                    break
        if _APPS_ENV_FILE:
            break
    except Exception:
        pass

# Read APPS_PWD from agent.env — Oracle APPS password for CM check (optional).
_APPS_PWD = ""
for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
    try:
        with open(_p) as _f:
            for _line in _f:
                if _line.strip().startswith("APPS_PWD="):
                    _APPS_PWD = _line.strip().split("=", 1)[1].strip()
                    break
        if _APPS_PWD:
            break
    except Exception:
        pass

# Read WEBLOGIC_PWD from agent.env — WebLogic Admin password for WLS server checks (optional).
_WEBLOGIC_PWD = ""
for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
    try:
        with open(_p) as _f:
            for _line in _f:
                if _line.strip().startswith("WEBLOGIC_PWD="):
                    _WEBLOGIC_PWD = _line.strip().split("=", 1)[1].strip()
                    break
        if _WEBLOGIC_PWD:
            break
    except Exception:
        pass

# Read INSTANCE_NAME from agent.env — EBS instance name (e.g. EBS12212) for fleet grouping.
# Sent in every poll so the cloud DB stays in sync even after manual agent.env edits.
_INSTANCE_NAME = ""
for _p in ("/etc/tunevault/agent.env", "/etc/tunevault/proxy.env"):
    try:
        with open(_p) as _f:
            for _line in _f:
                if _line.strip().startswith("INSTANCE_NAME="):
                    _INSTANCE_NAME = _line.strip().split("=", 1)[1].strip()
                    break
        if _INSTANCE_NAME:
            break
    except Exception:
        pass


def _resolve_db_host(params):
    """Return the Oracle DB host for a request.

    On app servers the Oracle DB is always remote. Override whatever host the
    TuneVault backend sent with EBS_DB_HOST from agent.env so connections reach
    the actual DB tier rather than localhost.
    """
    if _SERVER_TYPE == "apps" and _EBS_DB_HOST:
        return _EBS_DB_HOST
    return params.get("host", "localhost")


if _ORACLE_DRIVER is None:
    if _SERVER_TYPE == "apps":
        # App servers run EBS app-tier checks (SSH-based: Apache, Forms, OACore, WLS)
        # and don't connect to Oracle DB directly — oracledb is not required.
        print("[warn] App server — oracledb not installed. Oracle DB checks disabled; EBS app-tier checks active.")
    else:
        print("FATAL: Neither cx_Oracle nor oracledb is installed.")
        print("Install Oracle Instant Client first, then run the repair command:")
        print("  curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair")
        print("This is a hard failure — agent cannot connect to Oracle without cx_Oracle.")
        sys.exit(1)

# paramiko is optional — required only for SSH exec endpoints
try:
    import paramiko
    import io
    _PARAMIKO_AVAILABLE = True
except ImportError:
    _PARAMIKO_AVAILABLE = False

# ============================================================
# Config
# ============================================================

PORT = int(os.environ.get("PORT", "3100"))
# IMPORTANT: localhost-only bind is intentional and correct.
# The TuneVault cloud reaches this proxy via the outbound long-poll channel
# (_cloud_poll_loop → POST /api/agent/poll). No inbound ports, no firewall
# rules, no tunnel services, no public DNS are required. If you change
# this to 0.0.0.0 you are exposing Oracle credentials on a public port.
HOST = os.environ.get("BIND_HOST", "127.0.0.1")
_API_KEY_RAW = os.environ.get("TUNEVAULT_API_KEY", "")

# Allow --validate-only to run without an API key (self-test mode, no server started)
_VALIDATE_ONLY = "--validate-only" in sys.argv

if not _API_KEY_RAW and not _VALIDATE_ONLY:
    print("FATAL: TUNEVAULT_API_KEY environment variable is required.")
    print('Set it with: export TUNEVAULT_API_KEY="key1"')
    print('Multiple connections: export TUNEVAULT_API_KEY="key1,key2,key3"')
    sys.exit(1)

# Support comma-separated keys for multiple connections sharing one proxy.
# Each TuneVault connection has its own API key; list them all here.
# Single key is still accepted as-is — backward compatible.
# v3.5.1 fix: strip whitespace AND newlines per token to handle env artifacts.
VALID_KEYS = frozenset(
    k.strip().strip("\r\n")
    for k in _API_KEY_RAW.split(",")
    if k.strip().strip("\r\n")
)
# Backward compat aliases
API_KEYS = VALID_KEYS
API_KEY = next(iter(VALID_KEYS), "")

VERSION = "3.20.12"  # verify auto-upgrade end-to-end test

# ── Proxy metadata (read from /etc/tunevault/proxy.env if present) ──────────
# Sent on every outbound poll so the server can persist version info.
def _load_proxy_env_metadata():
    """Read installer version metadata from /etc/tunevault/proxy.env."""
    meta = {}
    env_path = "/etc/tunevault/proxy.env"
    try:
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    meta[k.strip()] = v.strip()
    except Exception:
        pass
    return meta

_PROXY_ENV_META = _load_proxy_env_metadata()
_PROXY_VERSION = _PROXY_ENV_META.get("VERSION", "")
_INSTALLED_AT = _PROXY_ENV_META.get("INSTALLED_AT", "")
_LAST_UPGRADE_AT = _PROXY_ENV_META.get("LAST_UPGRADE_AT", "")

# ── OS / kernel metadata ──────────────────────────────────────────────────────
def _get_os_id():
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("ID="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return ""

def _get_kernel():
    try:
        import platform
        return platform.release()
    except Exception:
        return ""

_OS_ID = _get_os_id()
_KERNEL = _get_kernel()

# Whitelist of host:port pairs the HTTP-forward endpoint may reach.
# Customer-controlled via proxy.env: APPS_URL_WHITELIST=host1:port1,host2:port2
# If not set, HTTP forwarding is disabled entirely.
_APPS_WHITELIST_RAW = os.environ.get("APPS_URL_WHITELIST", "")
APPS_URL_WHITELIST = set(
    h.strip().lower() for h in _APPS_WHITELIST_RAW.split(",") if h.strip()
)

# TuneVault server URL for version checks and downloads
TUNEVAULT_URL = os.environ.get("TUNEVAULT_URL", "https://tunevault.app").rstrip("/")

# ============================================================
# OS Command Whitelist (for /api/os/exec endpoint)
# ============================================================
# Security: commands are matched by exact key or prefix pattern.
# NO shell=True — subprocess.run with list args only.
# Max output: 64KB. Timeout: 10s.
#
# Each entry:
#   key        — unique command key (sent as "command" in request body)
#   argv       — exact arg list passed to subprocess.run (no shell)
#   allow_role — "db" | "apps" | "any"  (apps role requires PROXY_ROLE=apps)
# Dynamic commands (tail with path, cat with path) use prefix matching below.

_OS_CMD_WHITELIST = [
    # DB Tier
    {"key": "df -h",                                     "argv": ["df", "-h"],                                             "allow_role": "any"},
    {"key": "free -m",                                   "argv": ["free", "-m"],                                           "allow_role": "any"},
    {"key": "uptime",                                    "argv": ["uptime"],                                               "allow_role": "any"},
    {"key": "cat /proc/cpuinfo | grep processor | wc -l","argv": ["sh", "-c", "grep processor /proc/cpuinfo | wc -l"],    "allow_role": "any"},
    {"key": "top -bn1 | head -20",                       "argv": ["sh", "-c", "top -bn1 | head -20"],                     "allow_role": "any"},
    {"key": "ps aux | grep -E '(ora_|tnslsnr)'",         "argv": ["sh", "-c", "ps aux | grep -E '(ora_|tnslsnr)'"],       "allow_role": "any"},
    {"key": "cat /etc/os-release",                       "argv": ["cat", "/etc/os-release"],                              "allow_role": "any"},
    {"key": "vmstat 1 3",                                "argv": ["vmstat", "1", "3"],                                    "allow_role": "any"},
    # EBS Apps Tier
    {"key": "ps aux | grep -E '(FNDLIBR|FNDSM|OAFM|oacore|forms)'",
                                                         "argv": ["sh", "-c", "ps aux | grep -E '(FNDLIBR|FNDSM|OAFM|oacore|forms)'"],
                                                                                                                           "allow_role": "apps"},
    {"key": "ls -la $INST_TOP/logs/",                   "argv": ["sh", "-c", "ls -la $INST_TOP/logs/"],                  "allow_role": "apps"},
]

# Build lookup dict for O(1) exact-match
_OS_CMD_MAP = {entry["key"]: entry for entry in _OS_CMD_WHITELIST}

# Prefix patterns for dynamic tail/cat commands (path validation applied separately)
# Allowed path prefixes — reject if path doesn't start with one of these.
_TAIL_ALLOWED_PATH_PREFIXES = (
    "/u01/", "/u02/", "/u03/", "/u04/",
    "/oracle/", "/app/oracle/", "/opt/oracle/",
    "/prod/", "/d01/", "/d02/",
)
_TAIL_ORACLE_BASE_ENV = os.environ.get("ORACLE_BASE", "")
_TAIL_INST_TOP_ENV    = os.environ.get("INST_TOP", "")

# Compiled safe-path regex: printable ASCII, no shell metacharacters, no ..
_SAFE_PATH_RE = re.compile(r'^[a-zA-Z0-9_/.\-]+$')


def _resolve_tail_path(path_arg):
    """
    Validate a path argument for tail/cat commands.
    Returns (resolved_path, error_string_or_None).
    Path must be absolute, no shell metacharacters, no traversal.
    """
    path = path_arg.strip()
    # Must be absolute
    if not path.startswith("/"):
        return None, "path must be absolute"
    # No traversal
    if ".." in path.split("/"):
        return None, "path traversal not allowed"
    # No shell metacharacters
    if not _SAFE_PATH_RE.match(path):
        return None, "path contains unsafe characters"
    # Must start with an allowed prefix OR be under ORACLE_BASE / INST_TOP
    allowed = list(_TAIL_ALLOWED_PATH_PREFIXES)
    if _TAIL_ORACLE_BASE_ENV:
        allowed.append(_TAIL_ORACLE_BASE_ENV)
    if _TAIL_INST_TOP_ENV:
        allowed.append(_TAIL_INST_TOP_ENV)
    if not any(path.startswith(p) for p in allowed):
        return None, ("path not under allowed prefix; allowed: " +
                      ", ".join(p for p in allowed if p))
    return path, None


# ============================================================
# Proxy-Exec Whitelist (for /exec endpoint)
# ============================================================
# New structured endpoint: POST /exec { command_id, args[], cwd?, timeout_s? }
# Each command_id maps to a parameterized shell template.
# Args are validated per-command — no arbitrary shell execution.
# Runs as the OS user running the proxy (oracle by default).
# Audit log: /var/log/tunevault/exec.log
#
# arg_types:
#   "path"   — must be absolute, under allowed prefixes, no traversal/metacharacters
#   "sid"    — Oracle SID: alphanumeric + underscore, 1-30 chars
#   "int"    — positive integer only
#   "name"   — alphanumeric + underscore + hyphen + dot, 1-64 chars
#   "lsnr"   — listener name: alphanumeric + underscore, 1-30 chars

_EXEC_WHITELIST = {
    # Status / read-only checks
    "adcmctl_status": {
        "label": "Concurrent Manager Status",
        "argv_template": ["{ADCMCTL}", "status", "apps/{APPS_PWD}"],
        "args": [],
        "env_requires": ["ADCMCTL"],
        "timeout_s": 30,
    },
    "adcmctl_start": {
        "label": "Start Concurrent Managers",
        "argv_template": ["{ADCMCTL}", "start", "apps/{APPS_PWD}"],
        "args": [],
        "env_requires": ["ADCMCTL"],
        "timeout_s": 60,
        "destructive": True,
    },
    "adcmctl_stop": {
        "label": "Stop Concurrent Managers",
        "argv_template": ["{ADCMCTL}", "stop", "apps/{APPS_PWD}"],
        "args": [],
        "env_requires": ["ADCMCTL"],
        "timeout_s": 60,
        "destructive": True,
    },
    "opmnctl_status": {
        "label": "OPMN Status",
        "argv_template": ["sh", "-c", "{ORACLE_HOME}/opmn/bin/opmnctl status"],
        "args": [],
        "env_requires": ["ORACLE_HOME"],
        "timeout_s": 20,
    },
    "adop_status": {
        "label": "ADOP Status",
        "argv_template": ["sh", "-c", "adop phase=status"],
        "args": [],
        "env_requires": [],
        "timeout_s": 30,
    },
    "tail_log": {
        "label": "Tail Log File",
        "argv_template": ["tail", "-n", "{lines}", "{path}"],
        "args": [
            {"name": "path", "type": "path"},
            {"name": "lines", "type": "int", "default": "100", "max": 500},
        ],
        "env_requires": [],
        "timeout_s": 10,
    },
    "ps_oracle": {
        "label": "Oracle Processes",
        "argv_template": ["sh", "-c", "ps aux | grep -E '(ora_|tnslsnr|FNDLIBR|FNDSM)' | grep -v grep"],
        "args": [],
        "env_requires": [],
        "timeout_s": 10,
    },
    "df_h": {
        "label": "Disk Usage",
        "argv_template": ["df", "-h"],
        "args": [],
        "env_requires": [],
        "timeout_s": 10,
    },
    "free_m": {
        "label": "Memory Usage",
        "argv_template": ["free", "-m"],
        "args": [],
        "env_requires": [],
        "timeout_s": 10,
    },
    "oratab_read": {
        "label": "Read /etc/oratab",
        "argv_template": ["cat", "/etc/oratab"],
        "args": [],
        "env_requires": [],
        "timeout_s": 5,
    },
    "listener_status": {
        "label": "Listener Status",
        "argv_template": ["sh", "-c", "lsnrctl status {lsnr_name}"],
        "args": [
            {"name": "lsnr_name", "type": "lsnr", "default": "LISTENER"},
        ],
        "env_requires": [],
        "timeout_s": 15,
    },
    "tnsping": {
        "label": "TNS Ping",
        "argv_template": ["sh", "-c", "tnsping {service_name}"],
        "args": [
            {"name": "service_name", "type": "name"},
        ],
        "env_requires": [],
        "timeout_s": 15,
    },
    "crsctl_stat": {
        "label": "CRS Resource Status",
        "argv_template": ["sh", "-c", "{ORACLE_HOME}/bin/crsctl stat res -t"],
        "args": [],
        "env_requires": ["ORACLE_HOME"],
        "timeout_s": 20,
    },
    "sqlplus_query": {
        "label": "SQLPlus Query",
        "argv_template": ["sh", "-c",
            "echo \"{sql}\" | {ORACLE_HOME}/bin/sqlplus -S / as sysdba"],
        "args": [
            {"name": "sql", "type": "sql_safe"},
        ],
        "env_requires": ["ORACLE_HOME"],
        "timeout_s": 30,
    },
}

# Compiled validators for each arg type
_EXEC_ARG_VALIDATORS = {
    "sid":      re.compile(r'^[A-Za-z0-9_]{1,30}$'),
    "name":     re.compile(r'^[A-Za-z0-9_\-\.]{1,64}$'),
    "lsnr":     re.compile(r'^[A-Za-z0-9_]{1,30}$'),
    # SQL safe: only SELECT / SHOW / ALTER SYSTEM — readonly + listener ops; no DML
    "sql_safe": re.compile(
        r'^(SELECT|SHOW|ALTER SYSTEM)\s',
        re.IGNORECASE,
    ),
}

# Exec audit log
_EXEC_AUDIT_LOG = os.environ.get("EXEC_AUDIT_LOG", "/var/log/tunevault/exec.log")


def _exec_audit(command_id, args, exit_code, requestor_user_id, duration_ms):
    """Append one line to the exec audit log. Never raises."""
    try:
        entry = json.dumps({
            "ts": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "command_id": command_id,
            "args": args,
            "exit_code": exit_code,
            "user_id": requestor_user_id,
            "duration_ms": duration_ms,
        })
        log_dir = os.path.dirname(_EXEC_AUDIT_LOG)
        if log_dir and not os.path.isdir(log_dir):
            try:
                os.makedirs(log_dir, exist_ok=True)
            except OSError:
                pass
        with open(_EXEC_AUDIT_LOG, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass


def _validate_exec_arg(value, arg_spec):
    """
    Validate a single arg value against its spec.
    Returns (cleaned_value, error_string_or_None).
    """
    arg_type = arg_spec.get("type")

    if arg_type == "path":
        return _resolve_tail_path(value)

    if arg_type == "int":
        try:
            n = int(value)
        except (TypeError, ValueError):
            return None, "must be an integer"
        if n < 1:
            return None, "must be positive"
        max_val = arg_spec.get("max")
        if max_val and n > max_val:
            n = max_val
        return str(n), None

    if arg_type in _EXEC_ARG_VALIDATORS:
        val = str(value).strip()
        if not _EXEC_ARG_VALIDATORS[arg_type].match(val):
            return None, "invalid format for type %s" % arg_type
        return val, None

    return None, "unknown arg type: %s" % arg_type


def run_os_command(argv, timeout=10, max_output=65536):
    """
    Run argv via subprocess.run (no shell). Returns (stdout, stderr, exit_code, duration_ms).
    Caps combined output at max_output bytes.
    """
    t0 = time.time()
    try:
        result = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            shell=False,
        )
        duration_ms = int((time.time() - t0) * 1000)
        stdout = result.stdout.decode("utf-8", errors="replace")
        stderr = result.stderr.decode("utf-8", errors="replace")
        # Truncate to max_output
        if len(stdout) > max_output:
            stdout = stdout[:max_output] + "\n[truncated]"
        return stdout, stderr, result.returncode, duration_ms
    except subprocess.TimeoutExpired:
        duration_ms = int((time.time() - t0) * 1000)
        return "", "command timed out after %ds" % timeout, 124, duration_ms
    except FileNotFoundError as e:
        duration_ms = int((time.time() - t0) * 1000)
        return "", "command not found: %s" % str(e), 127, duration_ms
    except Exception as e:
        duration_ms = int((time.time() - t0) * 1000)
        return "", str(e), -1, duration_ms

# ============================================================
# Auto-Update
# ============================================================

def _ts():
    """Return ISO timestamp prefix for log lines."""
    return datetime.now().strftime("[%Y-%m-%dT%H:%M:%S]")


# ── Structured logging — stdout so systemd captures via journal ──────────────
# Configured once at module level so all code paths (boot, poll loop, error
# handlers) share the same handler. NOT a file — systemd captures stdout.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("tunevault_agent")

# ── Watchdog configuration (env-overridable) ─────────────────────────────────
# Tier 1: first successful heartbeat must arrive within DEGRADED_S of boot.
# After that the watchdog tracks time-since-last-poll, not time-since-boot.
# Tier 2: warn + jitter backoff until RESTART_S elapsed with no poll success.
# Tier 3: exit (→ systemd restart) only after RESTART_S of continuous failure.
_WATCHDOG_DEGRADED_S = int(os.environ.get("AGENT_WATCHDOG_DEGRADED_S", "60"))
_WATCHDOG_RESTART_S  = int(os.environ.get("AGENT_WATCHDOG_RESTART_S",  "300"))
_POLL_BACKOFF_MAX_S  = int(os.environ.get("AGENT_POLL_BACKOFF_MAX_S",  "30"))

# Shared between main thread and poll loop:
#   _first_heartbeat_event — set on first successful poll (signals boot watchdog OK)
#   _last_poll_ok_time     — updated on every successful poll (watchdog reads this)
#   _poll_stage            — last stage label for restart-reason reporting
_first_heartbeat_event = threading.Event()
_last_poll_ok_time     = None          # float (time.time()) or None
_poll_stage            = "init"        # string label
_last_poll_upgrade_trigger = 0.0       # rate-limit poll-triggered proxy updates (1h)
_stale_upgrade_count = 0               # consecutive "already at latest" responses — drives backoff

# Lock protecting _last_poll_ok_time and _poll_stage
_poll_state_lock = threading.Lock()


def _compute_sha256(path):
    """Compute sha256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def check_for_update():
    """
    Contact TuneVault to check for a newer proxy version.
    Returns (needs_update, remote_version, download_url, expected_checksum) or raises.
    """
    version_url = TUNEVAULT_URL + "/api/proxy/version"
    req = Request(version_url, headers={"User-Agent": "TuneVault-Proxy/%s" % VERSION})
    try:
        resp = urlopen(req, timeout=30)
        content = resp.read()
        data = json.loads(content.decode("utf-8"))
    except HTTPError as e:
        raise RuntimeError("Version check HTTP error: %s" % str(e))
    except URLError as e:
        raise RuntimeError("Version check network error: %s" % str(e))

    remote_version = data.get("version", "")
    expected_checksum = data.get("checksum", "")
    download_path = data.get("download_url", "/downloads/oracle-proxy.py")
    download_url = TUNEVAULT_URL + download_path

    print("%s [upgrade] downloaded %d bytes, remote VERSION line: %r" % (_ts(), len(content), remote_version))

    if not remote_version:
        raise RuntimeError("Version check returned empty version")

    # Any version mismatch (remote != current) means we need to update.
    # Previously used > comparison which silently returned False when the server's
    # regex fell back to the '3.1.1' default (older than the running version).
    needs_update = remote_version != VERSION
    print("%s [upgrade] remote=%s current=%s needs_update=%s" % (_ts(), remote_version, VERSION, needs_update))

    if needs_update:
        return True, remote_version, download_url, expected_checksum
    else:
        return False, VERSION, None, None


def perform_update(remote_version, download_url, expected_checksum):
    """
    Download the new proxy, validate checksum, replace self, restart via os.execv.
    Never raises — logs and returns False on any failure.
    """
    self_path = os.path.abspath(__file__)
    print("%s [auto-update] New version %s available (running %s) — downloading..." % (
        _ts(), remote_version, VERSION))

    # Download to a temp file in the same directory so rename is atomic
    tmp_dir = os.path.dirname(self_path)
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(dir=tmp_dir, suffix=".py.tmp")
        os.close(tmp_fd)
    except Exception as e:
        print("%s [auto-update] WARN: Could not create temp file: %s — keeping current version." % (_ts(), e))
        return False

    try:
        req = Request(download_url, headers={"User-Agent": "TuneVault-Proxy/%s" % VERSION})
        try:
            resp = urlopen(req, timeout=120)
        except (HTTPError, URLError) as e:
            print("%s [auto-update] WARN: Download failed: %s — keeping current version." % (_ts(), e))
            return False

        with open(tmp_path, "wb") as f:
            shutil.copyfileobj(resp, f)

        # Validate checksum
        actual_sha256 = _compute_sha256(tmp_path)
        if expected_checksum:
            expected_hex = expected_checksum.replace("sha256:", "")
            if actual_sha256 != expected_hex:
                print("%s [auto-update] WARN: Checksum mismatch (got %s, expected %s) — keeping current version." % (
                    _ts(), actual_sha256, expected_hex))
                return False

        # Preserve permissions (executable bit etc.)
        try:
            st = os.stat(self_path)
            os.chmod(tmp_path, st.st_mode)
        except Exception:
            pass

        # Atomic replace
        shutil.move(tmp_path, self_path)
        print("%s [auto-update] Updated to v%s — restarting..." % (_ts(), remote_version))

        # Restart in-place: replace current process image
        # os.execv preserves PID; systemd/PM2 won't notice a restart
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            print("%s [auto-update] WARN: os.execv failed (%s) — restart manually." % (_ts(), e))
            return False

    except Exception as e:
        print("%s [auto-update] WARN: Update failed: %s — keeping current version." % (_ts(), e))
        return False
    finally:
        # Clean up temp if still exists (shouldn't be after shutil.move or execv)
        if os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    return True


# Configurable update check interval — default 30 min; override via env for testing.
UPDATE_CHECK_INTERVAL = int(os.environ.get("PROXY_UPDATE_INTERVAL", "1800"))


def auto_update_loop(interval_seconds=None):
    """
    Background thread: check for updates at startup, then every UPDATE_CHECK_INTERVAL seconds.
    Runs as daemon so it doesn't block clean shutdown.
    """
    if interval_seconds is None:
        interval_seconds = UPDATE_CHECK_INTERVAL
    # Initial check after 30 seconds (let server fully start first)
    time.sleep(30)
    while True:
        try:
            print("%s [auto_update] checking for updates — current %s" % (_ts(), VERSION))
            needs_update, remote_version, download_url, expected_checksum = check_for_update()
            print("%s [auto_update] latest version: %s, current: %s, needs_update: %s" % (
                _ts(), remote_version, VERSION, needs_update))
            if needs_update:
                perform_update(remote_version, download_url, expected_checksum)
                # If we get here, update failed (execv would have replaced us)
            else:
                print("%s [auto_update] v%s is current — next check in %ds" % (_ts(), VERSION, interval_seconds))
        except Exception as e:
            print("%s [auto_update] WARN: Version check failed: %s" % (_ts(), e))
        time.sleep(interval_seconds)

# ============================================================
# ADDM Findings (on-demand panel)
# ============================================================

def query_addm_findings(host, port, service_name, username, password, lookback_hours):
    """Connect to Oracle and fetch ADDM findings (Enterprise Edition + Diagnostics Pack)."""
    dsn = cx_Oracle.makedsn(host, port, service_name=service_name)
    conn = None
    try:
        conn = cx_Oracle.connect(user=username, password=password, dsn=dsn)
        cursor = conn.cursor()

        # License check: Enterprise Edition required
        enterprise = False
        try:
            cursor.execute("SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1")
            row = cursor.fetchone()
            banner = str(row[0] if row else "").upper()
            enterprise = "ENTERPRISE" in banner
        except Exception:
            enterprise = True  # assume EE if V$VERSION inaccessible

        if not enterprise:
            return {
                "licensed": False,
                "not_licensed_reason": "Oracle Standard Edition detected. ADDM requires Oracle Enterprise Edition + Diagnostics Pack.",
                "lookback_hours": lookback_hours, "task_name": None, "task_id": None, "findings": []
            }

        # Diagnostics Pack check
        diagnostics_licensed = False
        try:
            cursor.execute("""
                SELECT DETECTED_USAGES, CURRENTLY_USED
                FROM DBA_FEATURE_USAGE_STATISTICS
                WHERE NAME = 'Diagnostic Pack'
                AND ROWNUM = 1
            """)
            row = cursor.fetchone()
            if row:
                detected = int(row[0] or 0)
                if detected > 0 or row[1] == "TRUE":
                    diagnostics_licensed = True
        except Exception:
            pass

        if not diagnostics_licensed:
            try:
                cursor.execute("SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'")
                row = cursor.fetchone()
                val = str(row[0] if row else "").upper()
                diagnostics_licensed = val in ("DIAGNOSTIC+TUNING", "DIAGNOSTIC")
            except Exception:
                pass

        if not diagnostics_licensed:
            return {
                "licensed": False,
                "not_licensed_reason": "Oracle Diagnostics Pack license not detected. ADDM queries skipped.",
                "lookback_hours": lookback_hours, "task_name": None, "task_id": None, "findings": []
            }

        # Find most recent completed ADDM task.
        # Use CDB_ADVISOR_TASKS first so that tasks created in CDB$ROOT (by a
        # SYSDBA connected to the root container) are visible from PDB sessions.
        # DBA_ADVISOR_TASKS only shows the current container, causing root-level
        # tasks to be invisible when queried from a PDB session.
        # Include STATUS='EXECUTED' — some Oracle versions use that value instead.
        task_id = None
        task_name = None
        task_con_name = None
        task_begin_snap = None
        task_end_snap = None
        try:
            try:
                cursor.execute("""
                    SELECT t.TASK_ID, t.TASK_NAME, c.NAME AS CON_NAME
                    FROM CDB_ADVISOR_TASKS t
                    JOIN V$CONTAINERS c ON c.CON_ID = t.CON_ID
                    WHERE t.ADVISOR_NAME = 'ADDM'
                      AND t.STATUS IN ('COMPLETED', 'EXECUTED')
                      AND t.COMPLETION_DATE >= SYSDATE - :lb_days
                    ORDER BY t.COMPLETION_DATE DESC
                    FETCH FIRST 1 ROWS ONLY
                """, {"lb_days": lookback_hours / 24.0})
            except Exception:
                # CDB view inaccessible (non-CDB install or insufficient privilege)
                cursor.execute("""
                    SELECT t.TASK_ID, t.TASK_NAME, NULL AS CON_NAME
                    FROM DBA_ADVISOR_TASKS t
                    WHERE t.ADVISOR_NAME = 'ADDM'
                      AND t.STATUS IN ('COMPLETED', 'EXECUTED')
                      AND t.COMPLETION_DATE >= SYSDATE - :lb_days
                    ORDER BY t.COMPLETION_DATE DESC
                    FETCH FIRST 1 ROWS ONLY
                """, {"lb_days": lookback_hours / 24.0})
            row = cursor.fetchone()
            if row:
                task_id = int(row[0])
                task_name = str(row[1])
                task_con_name = str(row[2]) if row[2] else None
        except Exception:
            pass

        # Pull snap range from task parameters
        if task_id:
            try:
                cursor.execute("""
                    SELECT PARAMETER_NAME, PARAMETER_VALUE
                    FROM DBA_ADVISOR_PARAMETERS
                    WHERE TASK_ID = :task_id
                      AND PARAMETER_NAME IN ('BEGIN_SNAP', 'END_SNAP', 'DB_TIME')
                """, {"task_id": task_id})
                for prow in cursor.fetchall():
                    pname = str(prow[0])
                    pval = prow[1]
                    if pname == "BEGIN_SNAP" and pval:
                        task_begin_snap = int(pval)
                    elif pname == "END_SNAP" and pval:
                        task_end_snap = int(pval)
            except Exception:
                pass

        if not task_id:
            return {
                "licensed": True, "lookback_hours": lookback_hours,
                "task_name": None, "task_id": None, "findings": [],
                "info": "No completed ADDM tasks found in the last %d hours." % lookback_hours
            }

        # Fetch findings
        raw_findings = []
        try:
            cursor.execute("""
                SELECT f.FINDING_ID, f.TYPE, f.NAME, f.MESSAGE, f.IMPACT_DB_PERCENT, f.SQL_ID
                FROM DBA_ADVISOR_FINDINGS f
                WHERE f.TASK_ID = :task_id
                ORDER BY NVL(f.IMPACT_DB_PERCENT, 0) DESC
            """, {"task_id": task_id})
            for row in cursor.fetchall():
                raw_findings.append({
                    "finding_id": int(row[0]), "type": str(row[1] or "INFORMATION"),
                    "name": str(row[2] or ""), "message": str(row[3] or ""),
                    "impact_pct": float(row[4] or 0), "sql_id": str(row[5]) if row[5] else None
                })
        except Exception:
            pass

        if not raw_findings:
            return {
                "licensed": True, "lookback_hours": lookback_hours,
                "task_name": task_name, "task_id": task_id,
                "container": task_con_name, "begin_snap": task_begin_snap, "end_snap": task_end_snap,
                "findings": [],
                "no_findings_reason": "Analysis completed — no significant database activity detected in this snapshot window. ADDM only reports issues when workload is high enough to diagnose. Re-run during a workload period or widen the snapshot range to see recommendations."
            }

        # Fetch recommendations
        finding_ids = [f["finding_id"] for f in raw_findings]
        rec_map = {}
        try:
            placeholders = ",".join([":%d" % i for i in range(len(finding_ids))])
            bind_vars = {"task_id": task_id}
            for i, fid in enumerate(finding_ids):
                bind_vars[str(i)] = fid
            cursor.execute("""
                SELECT r.FINDING_ID, r.REC_ID, r.TYPE, r.BENEFIT_DB_PERCENT, r.MESSAGE
                FROM DBA_ADVISOR_RECOMMENDATIONS r
                WHERE r.TASK_ID = :task_id AND r.FINDING_ID IN (%s)
                ORDER BY r.FINDING_ID, r.REC_ID
            """ % placeholders, bind_vars)
            for row in cursor.fetchall():
                fid = int(row[0])
                if fid not in rec_map:
                    rec_map[fid] = []
                rec_map[fid].append({
                    "rec_id": int(row[1]), "type": str(row[2] or ""),
                    "benefit_pct": float(row[3] or 0), "message": str(row[4] or ""), "actions": []
                })
        except Exception:
            pass

        # Fetch actions
        try:
            placeholders = ",".join([":%d" % i for i in range(len(finding_ids))])
            bind_vars = {"task_id": task_id}
            for i, fid in enumerate(finding_ids):
                bind_vars[str(i)] = fid
            cursor.execute("""
                SELECT a.FINDING_ID, a.REC_ID, a.ACTION_ID, a.COMMAND, a.ATTR1, a.ATTR2, a.ATTR3, a.ATTR4
                FROM DBA_ADVISOR_ACTIONS a
                WHERE a.TASK_ID = :task_id AND a.FINDING_ID IN (%s)
                ORDER BY a.FINDING_ID, a.REC_ID, a.ACTION_ID
            """ % placeholders, bind_vars)
            for row in cursor.fetchall():
                fid = int(row[0])
                rid = int(row[1])
                recs = rec_map.get(fid, [])
                for rec in recs:
                    if rec["rec_id"] == rid:
                        rec["actions"].append({
                            "action_id": int(row[2]), "command": str(row[3] or ""),
                            "attr1": str(row[4]) if row[4] else None, "attr2": str(row[5]) if row[5] else None,
                            "attr3": str(row[6]) if row[6] else None, "attr4": str(row[7]) if row[7] else None
                        })
                        break
        except Exception:
            pass

        # Merge findings with recommendations
        findings = []
        for f in raw_findings:
            severity = "critical" if f["impact_pct"] >= 10 else "warning" if f["impact_pct"] >= 3 else "info"
            findings.append(dict(f, severity=severity, recommendations=rec_map.get(f["finding_id"], [])))

        return {
            "licensed": True, "lookback_hours": lookback_hours,
            "task_name": task_name, "task_id": task_id,
            "container": task_con_name, "begin_snap": task_begin_snap, "end_snap": task_end_snap,
            "findings": findings
        }
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


# ============================================================
# Maintenance Windows (on-demand panel — all editions)
# ============================================================

def query_maintenance_windows(host, port, service_name, username, password):
    """Connect to Oracle and fetch auto-maintenance window status."""
    dsn = cx_Oracle.makedsn(host, port, service_name=service_name)
    conn = None
    try:
        conn = cx_Oracle.connect(user=username, password=password, dsn=dsn)
        cursor = conn.cursor()

        # 1. Autotask clients
        CLIENT_NAMES = ['auto optimizer stats collection', 'sql tuning advisor', 'auto space advisor']
        clients = []
        client_rows = []
        try:
            cursor.execute("""
                SELECT c.CLIENT_NAME, c.STATUS,
                       h.JOB_START_TIME, h.JOB_STATUS, h.JOB_DURATION
                FROM DBA_AUTOTASK_CLIENT c
                LEFT JOIN (
                  SELECT CLIENT_NAME, JOB_START_TIME, JOB_STATUS, JOB_DURATION,
                         ROW_NUMBER() OVER (PARTITION BY CLIENT_NAME ORDER BY JOB_START_TIME DESC) AS rn
                  FROM DBA_AUTOTASK_JOB_HISTORY
                  WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
                ) h ON h.CLIENT_NAME = c.CLIENT_NAME AND h.rn = 1
                WHERE c.CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
                ORDER BY c.CLIENT_NAME
            """)
            client_rows = cursor.fetchall() or []
        except Exception:
            pass

        # Run stats
        run_stats = {}
        try:
            cursor.execute("""
                SELECT CLIENT_NAME, COUNT(*) AS total_runs,
                       SUM(CASE WHEN JOB_STATUS != 'SUCCEEDED' THEN 1 ELSE 0 END) AS failures
                FROM DBA_AUTOTASK_JOB_HISTORY
                WHERE JOB_START_TIME >= SYSTIMESTAMP - INTERVAL '7' DAY
                  AND CLIENT_NAME IN ('auto optimizer stats collection','sql tuning advisor','auto space advisor')
                GROUP BY CLIENT_NAME
            """)
            for row in cursor.fetchall():
                run_stats[str(row[0]).lower()] = {"runs": int(row[1] or 0), "failures": int(row[2] or 0)}
        except Exception:
            pass

        # Tuning Pack license
        tuning_licensed = False
        try:
            cursor.execute("""
                SELECT DETECTED_USAGES, CURRENTLY_USED
                FROM DBA_FEATURE_USAGE_STATISTICS WHERE NAME = 'SQL Tuning Advisor'
                AND ROWNUM = 1
            """)
            row = cursor.fetchone()
            if row and (int(row[0] or 0) > 0 or row[1] == "TRUE"):
                tuning_licensed = True
        except Exception:
            try:
                cursor.execute("SELECT VALUE FROM v$parameter WHERE name = 'control_management_pack_access'")
                row = cursor.fetchone()
                val = str(row[0] if row else "").upper()
                tuning_licensed = val in ("DIAGNOSTIC+TUNING", "TUNING")
            except Exception:
                pass

        for row in client_rows:
            name = str(row[0] or "")
            status = str(row[1] or "")
            last_run_date = row[2].isoformat() if row[2] else None
            last_run_status = str(row[3]) if row[3] else None
            duration_raw = row[4]
            duration_secs = None
            if duration_raw:
                import re
                m = re.search(r"(\d+)\s+(\d+):(\d+):(\d+)", str(duration_raw))
                if m:
                    duration_secs = int(m.group(1)) * 86400 + int(m.group(2)) * 3600 + int(m.group(3)) * 60 + int(m.group(4))

            key = name.lower()
            stats = run_stats.get(key, {"runs": 0, "failures": 0})
            is_tuning = key == "sql tuning advisor"

            if status != "ENABLED":
                traffic_light = "red"
            elif stats["runs"] > 0 and stats["failures"] < stats["runs"]:
                traffic_light = "green"
            else:
                traffic_light = "amber"

            clients.append({
                "client_name": name, "status": status,
                "last_run_date": last_run_date, "last_run_status": last_run_status,
                "last_run_duration_secs": duration_secs,
                "runs_7d": stats["runs"], "failures_7d": stats["failures"],
                "traffic_light": traffic_light,
                "tuning_pack_required": is_tuning,
                "tuning_pack_licensed": tuning_licensed if is_tuning else None
            })

        # Fill missing clients
        existing_names = [c["client_name"] for c in clients]
        for name in CLIENT_NAMES:
            if name not in existing_names:
                is_tuning = name == "sql tuning advisor"
                clients.append({
                    "client_name": name, "status": "UNKNOWN",
                    "last_run_date": None, "last_run_status": None,
                    "last_run_duration_secs": None,
                    "runs_7d": 0, "failures_7d": 0, "traffic_light": "amber",
                    "tuning_pack_required": is_tuning,
                    "tuning_pack_licensed": tuning_licensed if is_tuning else None
                })

        # 2. Maintenance windows
        windows = []
        try:
            cursor.execute("""
                SELECT WINDOW_NAME,
                       TO_CHAR(NEXT_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS next_start,
                       REPEAT_INTERVAL,
                       EXTRACT(HOUR FROM DURATION) * 60 + EXTRACT(MINUTE FROM DURATION) AS duration_mins,
                       ENABLED,
                       TO_CHAR(LAST_START_DATE, 'YYYY-MM-DD HH24:MI:SS') AS last_start,
                       TO_CHAR(LAST_END_DATE, 'YYYY-MM-DD HH24:MI:SS') AS last_end
                FROM DBA_SCHEDULER_WINDOWS
                WHERE WINDOW_NAME LIKE '%DAY_WINDOW' OR WINDOW_NAME LIKE '%WINDOW'
                ORDER BY WINDOW_NAME
            """)
            for row in cursor.fetchall():
                name = str(row[0] or "")
                if not name.endswith("WINDOW"):
                    continue
                duration_mins = int(row[3] or 0)
                windows.append({
                    "window_name": name,
                    "next_start_date": str(row[1]) if row[1] else None,
                    "repeat_interval": str(row[2]) if row[2] else None,
                    "duration_hours": round(duration_mins / 60.0, 2),
                    "enabled": row[4] == "TRUE" or row[4] is True,
                    "last_start_date": str(row[5]) if row[5] else None,
                    "last_end_date": str(row[6]) if row[6] else None
                })
        except Exception:
            pass

        # 3. Stale stats
        stale_count = 0
        stale_top10 = []
        try:
            cursor.execute("SELECT COUNT(*) FROM DBA_TAB_STATISTICS WHERE STALE_STATS = 'YES'")
            row = cursor.fetchone()
            stale_count = int(row[0] or 0) if row else 0
        except Exception:
            pass

        try:
            cursor.execute("""
                SELECT OWNER, TABLE_NAME, NUM_ROWS,
                       TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed, STALE_STATS
                FROM DBA_TAB_STATISTICS
                WHERE STALE_STATS = 'YES'
                  AND OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','XDB','MDSYS','CTXSYS','OLAPSYS','WMSYS','ORDSYS')
                ORDER BY NUM_ROWS DESC NULLS LAST
                FETCH FIRST 10 ROWS ONLY
            """)
            for row in cursor.fetchall():
                stale_top10.append({
                    "owner": str(row[0] or ""), "table_name": str(row[1] or ""),
                    "num_rows": int(row[2] or 0),
                    "last_analyzed": str(row[3]) if row[3] else None,
                    "stale_stats": str(row[4] or "")
                })
        except Exception:
            pass

        disabled_clients = [c["client_name"] for c in clients if c["traffic_light"] == "red"]
        disabled_windows = [w["window_name"] for w in windows if not w["enabled"] or w["duration_hours"] == 0]

        return {
            "autotask_clients": clients, "windows": windows,
            "stale_tables_count": stale_count, "stale_tables_top10": stale_top10,
            "disabled_clients": disabled_clients, "disabled_windows": disabled_windows
        }
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


# ============================================================
# Oracle Init Parameters (on-demand panel — all editions)
# ============================================================

def query_parameters(host, port, service_name, username, password):
    """Connect to Oracle and fetch V$PARAMETER with recommended values."""
    dsn = cx_Oracle.makedsn(host, port, service_name=service_name)
    conn = None
    try:
        conn = cx_Oracle.connect(user=username, password=password, dsn=dsn)
        cursor = conn.cursor()

        def run_query(sql):
            try:
                cursor.execute(sql)
                return cursor.fetchall() or []
            except Exception:
                return []

        param_rows = run_query("SELECT name, value, isdefault, isinstance_modifiable, issys_modifiable, description FROM v$parameter ORDER BY name")
        os_rows    = run_query("SELECT stat_name, value FROM v$osstat WHERE stat_name IN ('PHYSICAL_MEMORY_BYTES','NUM_CPUS','NUM_CPU_CORES')")
        lic_rows   = run_query("SELECT sessions_highwater FROM v$license")
        df_rows    = run_query("SELECT COUNT(*) FROM v$datafile")

        os_map = {}
        for r in os_rows:
            os_map[str(r[0])] = int(r[1] or 0)
        ram_bytes = os_map.get('PHYSICAL_MEMORY_BYTES', 0)
        ram_gb    = round(ram_bytes / (1024**3) * 10) / 10 if ram_bytes > 0 else 0
        cpu_count = os_map.get('NUM_CPUS', os_map.get('NUM_CPU_CORES', 1)) or 1
        sess_hw   = int(lic_rows[0][0] or 0) if lic_rows else 0
        df_count  = int(df_rows[0][0] or 0) if df_rows else 0

        param_map = {}
        for r in param_rows:
            param_map[str(r[0]).lower()] = str(r[1] or '')
        is_ee     = 'inmemory_size' in param_map
        edition   = 'EE' if is_ee else 'SE'

        def parse_bytes(val):
            if not val:
                return 0
            s = str(val).strip().upper()
            if s.isdigit():
                return int(s)
            import re
            m = re.match(r'^(\d+(?:\.\d+)?)\s*([KMGT]?)$', s)
            if not m:
                return 0
            n = float(m.group(1))
            mult = {'K': 1024, 'M': 1024**2, 'G': 1024**3, 'T': 1024**4}.get(m.group(2), 1)
            return int(n * mult)

        def fmt_bytes(b):
            if b == 0: return '0'
            if b >= 1024**3: return str(round(b / 1024**3, 1)).rstrip('0').rstrip('.') + 'G'
            if b >= 1024**2: return str(int(b / 1024**2)) + 'M'
            if b >= 1024:    return str(int(b / 1024)) + 'K'
            return str(b)

        def eval_param(name, current):
            n = name.lower()
            cur = (current or '').strip()
            cur_num = parse_bytes(cur)
            if n in ('memory_target', 'memory_max_target'):
                if ram_gb == 0: return ('unknown', 'N/A', '')
                rec = int(ram_gb * 0.7 * 1024**3)
                if cur_num == 0: return ('green', 'AMM disabled (manual SGA/PGA)', 'Preferred on Linux')
                if cur_num < rec * 0.5: return ('red', fmt_bytes(rec), 'Undersized for %s GB RAM' % ram_gb)
                if cur_num > ram_gb * 0.9 * 1024**3: return ('amber', fmt_bytes(rec), 'Leaves too little RAM for OS')
                return ('green', fmt_bytes(rec), '')
            if n == 'sga_target':
                if ram_gb == 0: return ('unknown', 'N/A', '')
                rec = int(ram_gb * 0.45 * 1024**3)
                if cur_num == 0: return ('amber', fmt_bytes(rec), 'SGA auto-tuning is off')
                if cur_num < rec * 0.5: return ('amber', fmt_bytes(rec), 'Consider ~45%% of RAM (%s GB)' % ram_gb)
                return ('green', fmt_bytes(rec), '')
            if n == 'sga_max_size':
                if ram_gb == 0: return ('unknown', 'N/A', '')
                rec = int(ram_gb * 0.6 * 1024**3)
                if cur_num < rec * 0.6: return ('amber', fmt_bytes(rec), 'Cap may restrict SGA growth')
                return ('green', fmt_bytes(rec), '')
            if n == 'pga_aggregate_target':
                if ram_gb == 0: return ('unknown', 'N/A', '')
                rec = int(ram_gb * 0.25 * 1024**3)
                if cur_num == 0: return ('amber', fmt_bytes(rec), 'Auto PGA is off')
                if cur_num < rec * 0.4: return ('amber', fmt_bytes(rec), '~25%% of RAM recommended')
                return ('green', fmt_bytes(rec), '')
            if n == 'pga_aggregate_limit':
                if ram_gb == 0: return ('unknown', 'N/A', '')
                rec = int(ram_gb * 0.5 * 1024**3)
                if cur_num > 0 and cur_num < rec * 0.4: return ('amber', fmt_bytes(rec), 'Hard PGA limit may kill large sorts')
                return ('green', fmt_bytes(rec), '')
            if n in ('db_cache_size', 'shared_pool_size'):
                if parse_bytes(param_map.get('sga_target', '0')) > 0:
                    return ('green', 'Auto-tuned by SGA_TARGET', '')
                return ('green', '256M – 512M' if n == 'shared_pool_size' else fmt_bytes(int((ram_gb or 16) * 0.3 * 1024**2)), '')
            if n == 'large_pool_size':
                if cur_num < 64 * 1024**2: return ('amber', '64M+', 'Required for RMAN and parallel execution')
                return ('green', '64M+', '')
            if n == 'java_pool_size': return ('green', '32M–128M', 'Only matters if Java stored procedures are used')
            if n == 'streams_pool_size': return ('green', '0 (auto) or 64M+ if replication used', '')
            if n == 'processes':
                c = int(cur) if cur.isdigit() else 0
                hw_rec = max(300, int(sess_hw * 1.2)) if sess_hw > 0 else 300
                if c == 0: return ('unknown', str(hw_rec), '')
                if sess_hw > 0 and c < sess_hw * 1.1: return ('red', str(hw_rec), 'Process limit nearly exhausted (HW: %d)' % sess_hw)
                if sess_hw > 0 and c < sess_hw * 1.3: return ('amber', str(hw_rec), 'Less than 30%% headroom (HW: %d)' % sess_hw)
                return ('green', '~%d' % hw_rec, '')
            if n == 'sessions':
                proc = int(param_map.get('processes', '0') or 0) if (param_map.get('processes', '0') or '0').isdigit() else 0
                derived = int(proc * 1.5) + 22
                if proc > 0 and (int(cur) if cur.isdigit() else 0) < derived * 0.9:
                    return ('amber', str(derived), 'Should be CEIL(processes*1.5)+22')
                return ('green', str(derived) if proc > 0 else 'derived from PROCESSES', '')
            if n == 'open_cursors':
                c = int(cur) if cur.isdigit() else 0
                if c < 300: return ('red', '300+', 'Risk of ORA-01000')
                if c < 500: return ('amber', '500–1000', 'Low — increase if ORA-01000 occurs')
                return ('green', '300–1000', '')
            if n == 'undo_retention':
                c = int(cur) if cur.isdigit() else 0
                if c < 900: return ('amber', '900+', 'ORA-01555 risk')
                if c > 86400: return ('amber', '3600–7200', 'May cause UNDO tablespace bloat')
                return ('green', '900–3600 sec', '')
            if n == 'undo_tablespace':
                if not cur: return ('amber', 'UNDOTBS1', 'No undo tablespace configured')
                return ('green', cur, '')
            if n == 'db_recovery_file_dest_size':
                if cur_num == 0: return ('amber', '10G+', 'FRA not configured')
                return ('green', fmt_bytes(cur_num), 'Check V$RECOVERY_FILE_DEST for usage %%')
            if n == 'log_buffer':
                if cur_num < 8 * 1024**2: return ('amber', '8M–32M', 'Small log buffer may cause redo latch waits')
                return ('green', '8M–32M', '')
            if n == 'optimizer_mode':
                if cur.upper() == 'ALL_ROWS': return ('green', 'ALL_ROWS', '')
                return ('amber', 'ALL_ROWS', 'FIRST_ROWS degrades throughput')
            if n == 'cursor_sharing':
                if cur.upper() == 'EXACT': return ('green', 'EXACT', '')
                if cur.upper() == 'FORCE': return ('amber', 'EXACT', 'FORCE is a workaround — fix the SQL instead')
                return ('amber', 'EXACT', '')
            if n == 'parallel_max_servers':
                if cpu_count == 1: return ('green', '0–2', 'Single-CPU instance')
                rec = cpu_count * 2
                if (int(cur) if cur.isdigit() else 0) > cpu_count * 8: return ('amber', str(rec), 'Excessive parallelism may thrash CPU')
                return ('green', '%d–%d' % (cpu_count, rec), '')
            if n == 'result_cache_max_size':
                if edition != 'EE': return ('green', 'N/A (SE)', 'EE feature')
                if cur_num < 128 * 1024**2: return ('amber', '128M+', 'Result cache too small')
                return ('green', '128M–512M', '')
            if n == 'inmemory_size':
                if edition != 'EE': return ('green', 'N/A (SE)', 'EE only')
                if cur_num == 0: return ('green', '0 (disabled)', 'Enable only if licensed')
                return ('green', fmt_bytes(cur_num), '')
            if n == 'audit_trail':
                if cur.upper() in ('NONE', 'FALSE', '0'): return ('red', 'DB or OS', 'No auditing — compliance risk')
                return ('green', 'DB or OS', '')
            if n == 'sec_case_sensitive_logon':
                if cur.upper() in ('FALSE', '0'): return ('amber', 'TRUE', 'Case-insensitive passwords weaken security')
                return ('green', 'TRUE', '')
            if n == 'remote_login_passwordfile':
                if cur.upper() == 'NONE': return ('amber', 'EXCLUSIVE', 'Required for remote SYSDBA')
                if cur.upper() == 'SHARED': return ('amber', 'EXCLUSIVE', 'Use EXCLUSIVE')
                return ('green', 'EXCLUSIVE', '')
            if n == 'os_authent_prefix':
                if cur != '': return ('amber', '""', 'Allows OS-authenticated logins')
                return ('green', '""', '')
            if n == 'db_files':
                limit = int(cur) if cur.isdigit() else 200
                if df_count > 0 and df_count >= limit * 0.8: return ('red', str(max(limit * 2, 1000)), '%d/%d datafiles used' % (df_count, limit))
                if df_count > 0 and df_count >= limit * 0.6: return ('amber', str(limit), '%d/%d datafiles used' % (df_count, limit))
                return ('green', '200+', '%d/%d used' % (df_count, limit) if df_count > 0 else '')
            if n == 'db_block_size':
                if (int(cur) if cur.isdigit() else 0) < 8192: return ('amber', '8192', 'Sub-8k block size is uncommon')
                return ('green', '8192 (OLTP) or 16384 (DW)', '')
            if n == 'filesystemio_options':
                v = cur.upper()
                if v in ('SETALL', 'ASYNCH,DIRECTIO'): return ('green', 'SETALL', '')
                if v in ('NONE', ''): return ('amber', 'SETALL', 'Enable on Linux for async + directIO')
                return ('amber', 'SETALL', 'Current: %s' % cur)
            if n == 'disk_asynch_io':
                if cur.upper() == 'TRUE': return ('green', 'TRUE', '')
                return ('amber', 'TRUE', 'Async I/O reduces wait time')
            if n == 'compatible': return ('green', 'Match current version', 'Lowering prevents rolling back upgrades')
            if n == 'control_file_record_keep_time':
                if (int(cur) if cur.isdigit() else 0) < 7: return ('amber', '30', 'Low retention — RMAN catalog may miss history')
                return ('green', '30+', '')
            return ('green', cur or '(default)', '')

        TRACKED = [
            ('memory_target',        'Memory'), ('memory_max_target',    'Memory'),
            ('sga_target',           'Memory'), ('sga_max_size',         'Memory'),
            ('pga_aggregate_target', 'Memory'), ('pga_aggregate_limit',  'Memory'),
            ('db_cache_size',        'Memory'), ('shared_pool_size',     'Memory'),
            ('large_pool_size',      'Memory'), ('java_pool_size',       'Memory'),
            ('streams_pool_size',    'Memory'),
            ('processes',            'Processes & Sessions'),
            ('sessions',             'Processes & Sessions'),
            ('open_cursors',         'Processes & Sessions'),
            ('undo_tablespace',      'Undo & Recovery'),
            ('undo_retention',       'Undo & Recovery'),
            ('db_recovery_file_dest_size', 'Undo & Recovery'),
            ('log_buffer',           'Undo & Recovery'),
            ('optimizer_mode',       'Performance'), ('cursor_sharing',       'Performance'),
            ('parallel_max_servers', 'Performance'), ('result_cache_max_size','Performance'),
            ('inmemory_size',        'Performance'),
            ('audit_trail',          'Security & Audit'),
            ('sec_case_sensitive_logon',   'Security & Audit'),
            ('remote_login_passwordfile',  'Security & Audit'),
            ('os_authent_prefix',    'Security & Audit'),
            ('db_files',             'Storage & I/O'), ('db_block_size',      'Storage & I/O'),
            ('filesystemio_options', 'Storage & I/O'), ('disk_asynch_io',     'Storage & I/O'),
            ('compatible',           'Misc'), ('nls_characterset',      'Misc'),
            ('nls_nchar_characterset','Misc'), ('diagnostic_dest',       'Misc'),
            ('control_file_record_keep_time','Misc'),
        ]

        parameters = []
        for pname, category in TRACKED:
            raw = param_map.get(pname.lower())
            if raw is None:
                continue
            row = next((r for r in param_rows if str(r[0]).lower() == pname.lower()), None)
            is_dynamic = str(row[3]) == 'TRUE' if row else False
            status, recommended, note = eval_param(pname, raw)
            parameters.append({
                'name': pname,
                'category': category,
                'current_value': raw or '(not set)',
                'recommended': recommended,
                'status': status,
                'note': note,
                'is_dynamic': is_dynamic,
                'scope': 'SCOPE=BOTH' if is_dynamic else 'SCOPE=SPFILE  -- restart required'
            })

        return {
            'parameters': parameters,
            'hardware': {'ram_gb': ram_gb, 'cpu_count': cpu_count},
            'sessions_highwater': sess_hw,
            'datafile_count': df_count,
            'edition': edition
        }
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


# ============================================================
# Oracle Error Formatting
# ============================================================

def format_oracle_error(err):
    msg = str(err)
    if "ORA-12154" in msg:
        return "TNS name could not be resolved. Check service name."
    if "ORA-12541" in msg:
        return "No listener at the specified host and port. Check host and port."
    if "ORA-12514" in msg:
        return "Service name not found. Check the service name or SID."
    if "ORA-12170" in msg:
        return "Connection timed out. Host may be unreachable."
    if "ORA-01017" in msg:
        return "Invalid username or password."
    if "ORA-28000" in msg:
        return "Account is locked."
    if "ORA-28001" in msg:
        return "Password has expired."
    if "ORA-01031" in msg:
        return "Insufficient privileges. User needs SELECT_CATALOG_ROLE or explicit grants."
    if "ORA-00942" in msg:
        return "Table or view does not exist. User may need additional grants."
    return msg


# ============================================================
# Oracle Query Functions
# ============================================================

def safe_int(val, default=0):
    """Safely convert to int."""
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def safe_float(val, default=0.0):
    """Safely convert to float."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def query_instance_info(cursor):
    try:
        cursor.execute("""
            SELECT
                d.NAME,
                i.INSTANCE_NAME,
                i.HOST_NAME,
                i.VERSION,
                d.PLATFORM_NAME,
                TO_CHAR(i.STARTUP_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                ROUND(SYSDATE - i.STARTUP_TIME),
                (SELECT VALUE FROM v$parameter WHERE name = 'cpu_count'),
                ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'sga_target'), 1),
                ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1),
                (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size')
            FROM v$database d, v$instance i
        """)
        row = cursor.fetchone()
        if not row:
            raise Exception("No instance data")
        return {
            "db_name": row[0] or "UNKNOWN",
            "instance_name": row[1] or "unknown",
            "host_name": row[2] or "unknown",
            "version": row[3] or "Unknown",
            "platform": row[4] or "Unknown",
            "startup_time": row[5] or "",
            "uptime_days": safe_int(row[6]),
            "rac": False,
            "cpus": safe_int(row[7], 1),
            "sga_target_gb": safe_float(row[8]),
            "pga_aggregate_target_gb": safe_float(row[9]),
            "db_block_size": safe_int(row[10], 8192),
        }
    except Exception as e:
        print("Instance query failed: %s" % str(e))
        # Fallback to simpler queries
        try:
            cursor.execute("SELECT name FROM v$database")
            r1 = cursor.fetchone()
            cursor.execute("SELECT instance_name, host_name, version FROM v$instance")
            r2 = cursor.fetchone()
            return {
                "db_name": (r1[0] if r1 else "UNKNOWN"),
                "instance_name": (r2[0] if r2 else "unknown"),
                "host_name": (r2[1] if r2 else "unknown"),
                "version": (r2[2] if r2 else "Unknown"),
                "platform": "Unknown",
                "startup_time": "",
                "uptime_days": 0,
                "rac": False,
                "cpus": 1,
                "sga_target_gb": 0,
                "pga_aggregate_target_gb": 0,
                "db_block_size": 8192,
            }
        except Exception:
            return {
                "db_name": "UNKNOWN", "instance_name": "unknown",
                "host_name": "unknown", "version": "Unknown",
                "platform": "Unknown", "startup_time": "",
                "uptime_days": 0, "rac": False, "cpus": 1,
                "sga_target_gb": 0, "pga_aggregate_target_gb": 0,
                "db_block_size": 8192,
            }


def query_tablespaces(cursor):
    try:
        cursor.execute("""
            SELECT
                ts.TABLESPACE_NAME,
                ROUND(um.USED_SPACE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1),
                ROUND(um.TABLESPACE_SIZE * ts_block.BLOCK_SIZE / 1024 / 1024 / 1024, 1),
                ROUND(um.USED_PERCENT, 1),
                CASE WHEN df.autoext > 0 THEN 1 ELSE 0 END
            FROM DBA_TABLESPACE_USAGE_METRICS um
            JOIN DBA_TABLESPACES ts ON ts.TABLESPACE_NAME = um.TABLESPACE_NAME
            LEFT JOIN (SELECT TABLESPACE_NAME, BLOCK_SIZE FROM DBA_TABLESPACES) ts_block
                ON ts_block.TABLESPACE_NAME = um.TABLESPACE_NAME
            LEFT JOIN (
                SELECT TABLESPACE_NAME,
                    SUM(CASE WHEN AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END) as autoext
                FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME
            ) df ON df.TABLESPACE_NAME = um.TABLESPACE_NAME
            ORDER BY um.USED_PERCENT DESC
        """)
        rows = cursor.fetchall()
        results = []
        for row in rows:
            pct = safe_float(row[3])
            if pct > 90:
                status = "critical"
            elif pct > 80:
                status = "warning"
            else:
                status = "ok"
            results.append({
                "name": row[0],
                "used_gb": safe_float(row[1]),
                "total_gb": safe_float(row[2]),
                "pct_used": pct,
                "autoextend": safe_int(row[4]) > 0,
                "status": status,
            })
        return results
    except Exception as e:
        print("Tablespace primary query failed: %s" % str(e))
        # Fallback query
        try:
            cursor.execute("""
                SELECT df.TABLESPACE_NAME,
                    ROUND(SUM(df.BYTES) / 1024 / 1024 / 1024, 1),
                    ROUND((SUM(df.BYTES) - NVL(fs.free_bytes, 0)) / 1024 / 1024 / 1024, 1),
                    ROUND((1 - NVL(fs.free_bytes, 0) / SUM(df.BYTES)) * 100, 1),
                    MAX(CASE WHEN df.AUTOEXTENSIBLE = 'YES' THEN 1 ELSE 0 END)
                FROM DBA_DATA_FILES df
                LEFT JOIN (
                    SELECT TABLESPACE_NAME, SUM(BYTES) as free_bytes
                    FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME
                ) fs ON fs.TABLESPACE_NAME = df.TABLESPACE_NAME
                GROUP BY df.TABLESPACE_NAME, fs.free_bytes
                ORDER BY 4 DESC
            """)
            rows = cursor.fetchall()
            results = []
            for row in rows:
                pct = safe_float(row[3])
                if pct > 90:
                    status = "critical"
                elif pct > 80:
                    status = "warning"
                else:
                    status = "ok"
                results.append({
                    "name": row[0],
                    "used_gb": safe_float(row[2]),
                    "total_gb": safe_float(row[1]),
                    "pct_used": pct,
                    "autoextend": safe_int(row[4]) > 0,
                    "status": status,
                })
            return results
        except Exception:
            return []


def query_wait_events(cursor):
    try:
        cursor.execute("""
            SELECT EVENT, WAIT_CLASS, TOTAL_WAITS,
                ROUND(TIME_WAITED / 100, 1),
                CASE WHEN TOTAL_WAITS > 0
                    THEN ROUND((TIME_WAITED / 100 / TOTAL_WAITS) * 1000, 2)
                    ELSE 0 END
            FROM V$SYSTEM_EVENT
            WHERE WAIT_CLASS NOT IN ('Idle') AND TOTAL_WAITS > 0
            ORDER BY TIME_WAITED DESC
            FETCH FIRST 15 ROWS ONLY
        """)
        rows = cursor.fetchall()
        total_time = sum(safe_float(r[3]) for r in rows)
        results = []
        for row in rows:
            time_waited = safe_float(row[3])
            pct = round(time_waited / total_time * 100, 1) if total_time > 0 else 0
            results.append({
                "event": row[0],
                "wait_class": row[1],
                "total_waits": safe_int(row[2]),
                "time_waited_s": time_waited,
                "avg_wait_ms": safe_float(row[4]),
                "pct_db_time": pct,
            })
        return results
    except Exception as e:
        print("Wait events query failed: %s" % str(e))
        return []


def query_top_sql(cursor):
    try:
        cursor.execute("""
            SELECT SQL_ID, SUBSTR(SQL_TEXT, 1, 500), EXECUTIONS,
                ROUND(ELAPSED_TIME / 1000000, 1), ROUND(CPU_TIME / 1000000, 1),
                BUFFER_GETS, DISK_READS, ROWS_PROCESSED,
                CASE WHEN EXECUTIONS > 0
                    THEN ROUND(ELAPSED_TIME / EXECUTIONS / 1000, 2)
                    ELSE 0 END,
                CASE WHEN EXECUTIONS > 0
                    THEN ROUND(BUFFER_GETS / EXECUTIONS)
                    ELSE 0 END,
                PLAN_HASH_VALUE
            FROM V$SQL
            WHERE EXECUTIONS > 0 AND ELAPSED_TIME > 0
                AND PARSING_SCHEMA_NAME NOT IN (
                    'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS',
                    'ORDSYS','EXFSYS','WMSYS','APPQOSSYS','DBSFWUSER'
                )
                AND SQL_TEXT NOT LIKE '%v$%' AND SQL_TEXT NOT LIKE '%V$%'
                AND COMMAND_TYPE IN (2, 3, 6, 7, 189)
            ORDER BY ELAPSED_TIME DESC
            FETCH FIRST 10 ROWS ONLY
        """)
        rows = cursor.fetchall()
        results = []
        for row in rows:
            elapsed_per_exec = safe_float(row[8])
            buffer_gets_per_exec = safe_int(row[9])
            disk_reads = safe_int(row[6])
            buffer_gets = safe_int(row[5])

            issue = "Normal operation"
            if elapsed_per_exec > 20:
                issue = "Very slow execution - check execution plan"
            elif elapsed_per_exec > 5:
                issue = "Slow execution - review query and indexes"
            if buffer_gets_per_exec > 1000:
                issue = "High buffer gets - possible full table scan or missing index"
            if disk_reads > buffer_gets * 0.1 and disk_reads > 10000:
                issue = "High disk reads relative to buffer gets - data not in cache"

            results.append({
                "sql_id": row[0],
                "sql_text": row[1] or "",
                "executions": safe_int(row[2]),
                "elapsed_time_s": safe_float(row[3]),
                "cpu_time_s": safe_float(row[4]),
                "buffer_gets": buffer_gets,
                "disk_reads": disk_reads,
                "rows_processed": safe_int(row[7]),
                "elapsed_per_exec_ms": elapsed_per_exec,
                "buffer_gets_per_exec": buffer_gets_per_exec,
                "plan_hash": str(row[10] or "0"),
                "issue": issue,
            })
        return results
    except Exception as e:
        print("Top SQL query failed: %s" % str(e))
        return []


def query_index_analysis(cursor):
    try:
        cursor.execute("""
            SELECT i.OWNER, i.INDEX_NAME, i.TABLE_NAME,
                ROUND(s.LEAF_BLOCKS * (SELECT TO_NUMBER(VALUE) FROM v$parameter
                    WHERE name = 'db_block_size') / 1024 / 1024),
                i.BLEVEL, s.LEAF_BLOCKS, i.CLUSTERING_FACTOR,
                NVL(s.PCT_DIRECT_ACCESS, 100),
                i.STATUS,
                CASE
                    WHEN i.STATUS != 'VALID' THEN 'unusable'
                    WHEN i.BLEVEL > 4 THEN 'critical'
                    WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 50 THEN 'critical'
                    WHEN i.BLEVEL > 3 THEN 'fragmented'
                    WHEN NVL(s.PCT_DIRECT_ACCESS, 100) < 70 THEN 'fragmented'
                    ELSE 'ok'
                END
            FROM DBA_INDEXES i
            LEFT JOIN DBA_IND_STATISTICS s
                ON s.OWNER = i.OWNER AND s.INDEX_NAME = i.INDEX_NAME
                AND s.PARTITION_NAME IS NULL
            WHERE i.OWNER NOT IN (
                'SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS',
                'EXFSYS','WMSYS','XDB','CTXSYS','APPQOSSYS','DBSFWUSER',
                'APEX_040000','APEX_040200','APEX_050000','FLOWS_FILES'
            )
            AND i.INDEX_TYPE = 'NORMAL'
            AND NVL(s.LEAF_BLOCKS, 0) > 100
            ORDER BY
                CASE WHEN i.STATUS != 'VALID' THEN 1
                     WHEN i.BLEVEL > 4 THEN 2
                     WHEN i.BLEVEL > 3 THEN 3
                     ELSE 4 END,
                s.LEAF_BLOCKS DESC NULLS LAST
            FETCH FIRST 20 ROWS ONLY
        """)
        rows = cursor.fetchall()
        results = []
        for row in rows:
            blevel = safe_int(row[4])
            pct_direct = safe_int(row[7], 100)
            extra = (blevel - 3) * 15 if blevel > 3 else 0
            est_pct_deleted = max(0, min(100, round(100 - pct_direct + extra)))
            results.append({
                "owner": row[0],
                "index_name": row[1],
                "table_name": row[2],
                "size_mb": safe_int(row[3]),
                "blevel": blevel,
                "leaf_blocks": safe_int(row[5]),
                "clustering_factor": safe_int(row[6]),
                "pct_deleted": est_pct_deleted,
                "status": row[9] or "ok",
            })
        return results
    except Exception as e:
        print("Index analysis query failed: %s" % str(e))
        return []


def query_sga_stats(cursor):
    try:
        cursor.execute("SELECT ROUND(SUM(VALUE) / 1024 / 1024 / 1024, 1) FROM V$SGA")
        sga_size = safe_float((cursor.fetchone() or [0])[0])

        cursor.execute("""
            SELECT ROUND(
                (1 - (phys.VALUE / (db_gets.VALUE + con_gets.VALUE))) * 100, 1)
            FROM
                (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'physical reads') phys,
                (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'db block gets') db_gets,
                (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'consistent gets') con_gets
        """)
        buffer_hit = safe_float((cursor.fetchone() or [0])[0])

        cursor.execute("""
            SELECT ROUND(SUM(PINS - RELOADS) / NULLIF(SUM(PINS), 0) * 100, 1)
            FROM V$LIBRARYCACHE
        """)
        lib_hit = safe_float((cursor.fetchone() or [0])[0])

        cursor.execute("""
            SELECT ROUND(SUM(GETS - GETMISSES) / NULLIF(SUM(GETS), 0) * 100, 1)
            FROM V$ROWCACHE
        """)
        dict_hit = safe_float((cursor.fetchone() or [0])[0])

        cursor.execute("""
            SELECT ROUND(free_bytes.val / total_bytes.val * 100, 1)
            FROM
                (SELECT SUM(BYTES) as val FROM V$SGASTAT
                 WHERE POOL = 'shared pool' AND NAME = 'free memory') free_bytes,
                (SELECT SUM(BYTES) as val FROM V$SGASTAT
                 WHERE POOL = 'shared pool') total_bytes
        """)
        sp_free = safe_float((cursor.fetchone() or [0])[0])

        cursor.execute("""
            SELECT
                ROUND(hp.VALUE / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1),
                ROUND((tp.VALUE - hp.VALUE) / NULLIF(GREATEST(uptime.VALUE, 1), 0), 1)
            FROM
                (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (hard)') hp,
                (SELECT VALUE FROM V$SYSSTAT WHERE NAME = 'parse count (total)') tp,
                (SELECT (SYSDATE - STARTUP_TIME) * 86400 as VALUE FROM V$INSTANCE) uptime
        """)
        parse_row = cursor.fetchone() or [0, 0]
        hard_parses = safe_float(parse_row[0])
        soft_parses = safe_float(parse_row[1])

        cursor.execute("SELECT NAME, ROUND(VALUE / 1024 / 1024 / 1024, 1) FROM V$SGA")
        comp_rows = cursor.fetchall()
        components = {}
        for r in comp_rows:
            name = (r[0] or "").lower()
            val = safe_float(r[1])
            if "buffer" in name:
                components["buffer_cache_gb"] = val
            if "shared" in name:
                components["shared_pool_gb"] = val
            if "large" in name:
                components["large_pool_gb"] = val
            if "java" in name:
                components["java_pool_gb"] = val
            if "stream" in name:
                components["streams_pool_gb"] = val

        return {
            "sga_size_gb": sga_size,
            "buffer_cache_gb": components.get("buffer_cache_gb", 0),
            "shared_pool_gb": components.get("shared_pool_gb", 0),
            "large_pool_gb": components.get("large_pool_gb", 0),
            "java_pool_gb": components.get("java_pool_gb", 0),
            "streams_pool_gb": components.get("streams_pool_gb", 0),
            "buffer_cache_hit_ratio": buffer_hit,
            "library_cache_hit_ratio": lib_hit,
            "dictionary_cache_hit_ratio": dict_hit,
            "shared_pool_free_pct": sp_free,
            "hard_parses_per_sec": hard_parses,
            "soft_parses_per_sec": soft_parses,
        }
    except Exception as e:
        print("SGA stats query failed: %s" % str(e))
        return {
            "sga_size_gb": 0, "buffer_cache_gb": 0, "shared_pool_gb": 0,
            "large_pool_gb": 0, "java_pool_gb": 0, "streams_pool_gb": 0,
            "buffer_cache_hit_ratio": 0, "library_cache_hit_ratio": 0,
            "dictionary_cache_hit_ratio": 0, "shared_pool_free_pct": 0,
            "hard_parses_per_sec": 0, "soft_parses_per_sec": 0,
        }


def query_pga_stats(cursor):
    try:
        cursor.execute("""
            SELECT
                ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024
                       FROM v$parameter WHERE name = 'pga_aggregate_target'), 1),
                ROUND((SELECT VALUE/1024/1024/1024
                       FROM V$PGASTAT WHERE NAME = 'total PGA allocated'), 1),
                ROUND((SELECT VALUE/1024/1024/1024
                       FROM V$PGASTAT WHERE NAME = 'maximum PGA allocated'), 1),
                (SELECT VALUE FROM V$PGASTAT WHERE NAME = 'over allocation count'),
                ROUND((SELECT VALUE FROM V$PGASTAT
                       WHERE NAME = 'cache hit percentage'), 1)
            FROM DUAL
        """)
        row = cursor.fetchone() or [0, 0, 0, 0, 0]

        cursor.execute("""
            SELECT
                ROUND(optimal.cnt / NULLIF(total.cnt, 0) * 100, 1),
                ROUND(onepass.cnt / NULLIF(total.cnt, 0) * 100, 1),
                ROUND(multipass.cnt / NULLIF(total.cnt, 0) * 100, 1)
            FROM
                (SELECT SUM(OPTIMAL_EXECUTIONS + ONEPASS_EXECUTIONS + MULTIPASSES_EXECUTIONS) as cnt
                 FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) total,
                (SELECT SUM(OPTIMAL_EXECUTIONS) as cnt
                 FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) optimal,
                (SELECT SUM(ONEPASS_EXECUTIONS) as cnt
                 FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) onepass,
                (SELECT SUM(MULTIPASSES_EXECUTIONS) as cnt
                 FROM V$SQL_WORKAREA_HISTOGRAM WHERE LOW_OPTIMAL_SIZE > 0) multipass
        """)
        wa_row = cursor.fetchone() or [0, 0, 0]

        return {
            "pga_target_gb": safe_float(row[0]),
            "pga_allocated_gb": safe_float(row[1]),
            "pga_max_allocated_gb": safe_float(row[2]),
            "over_allocation_count": safe_int(row[3]),
            "cache_hit_pct": safe_float(row[4]),
            "optimal_executions_pct": safe_float(wa_row[0]),
            "onepass_executions_pct": safe_float(wa_row[1]),
            "multipass_executions_pct": safe_float(wa_row[2]),
        }
    except Exception as e:
        print("PGA stats query failed: %s" % str(e))
        return {
            "pga_target_gb": 0, "pga_allocated_gb": 0,
            "pga_max_allocated_gb": 0, "over_allocation_count": 0,
            "cache_hit_pct": 0, "optimal_executions_pct": 0,
            "onepass_executions_pct": 0, "multipass_executions_pct": 0,
        }


def query_os_stats(cursor):
    try:
        cursor.execute("""
            SELECT STAT_NAME, VALUE FROM V$OSSTAT
            WHERE STAT_NAME IN (
                'NUM_CPUS','IDLE_TIME','BUSY_TIME','USER_TIME',
                'SYS_TIME','IOWAIT_TIME','PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES'
            )
        """)
        rows = cursor.fetchall()
        stats = {}
        for r in rows:
            stats[r[0]] = safe_float(r[1])

        total_cpu_time = stats.get("IDLE_TIME", 0) + stats.get("BUSY_TIME", 0)
        cpu_pct = round(stats.get("BUSY_TIME", 0) / total_cpu_time * 100, 1) if total_cpu_time > 0 else 0
        io_pct = round(stats.get("IOWAIT_TIME", 0) / total_cpu_time * 100, 1) if total_cpu_time > 0 else 0

        return {
            "cpu_count": safe_int(stats.get("NUM_CPUS", 1), 1),
            "avg_cpu_utilization_pct": cpu_pct,
            "max_cpu_utilization_pct": min(cpu_pct * 1.3, 100),
            "avg_io_wait_pct": io_pct,
            "physical_memory_gb": round(stats.get("PHYSICAL_MEMORY_BYTES", 0) / 1024 / 1024 / 1024, 1),
            "free_memory_gb": round(stats.get("FREE_MEMORY_BYTES", 0) / 1024 / 1024 / 1024, 1),
            "swap_used_gb": 0,
            "avg_disk_read_ms": 0,
            "avg_disk_write_ms": 0,
        }
    except Exception as e:
        print("OS stats query failed: %s" % str(e))
        return {
            "cpu_count": 1, "avg_cpu_utilization_pct": 0,
            "max_cpu_utilization_pct": 0, "avg_io_wait_pct": 0,
            "physical_memory_gb": 0, "free_memory_gb": 0,
            "swap_used_gb": 0, "avg_disk_read_ms": 0, "avg_disk_write_ms": 0,
        }


# ============================================================
# Wave A: Undo, Temp, Alert Log, Resource Limits, SGA/PGA History
# ============================================================


def query_undo_stats(cursor):
    """Undo tablespace stats — current usage from V$UNDOSTAT + DBA_DATA_FILES."""
    try:
        # Current undo stats from V$UNDOSTAT (last 10-min interval)
        cursor.execute("""
            SELECT
                UNDOBLKS,
                TXNCOUNT,
                MAXQUERYLEN,
                MAXCONCURRENCY,
                TUNED_UNDORETENTION,
                EXPIREDBLKS,
                UNEXPIREDBLKS,
                ACTIVEBLKS
            FROM V$UNDOSTAT
            WHERE ROWNUM = 1
            ORDER BY END_TIME DESC
        """)
        undo_row = cursor.fetchone() or [0] * 8

        # Undo tablespace size from DBA_TABLESPACES + DBA_DATA_FILES
        cursor.execute("""
            SELECT
                d.TABLESPACE_NAME,
                SUM(d.BYTES) / 1073741824,
                SUM(d.BYTES - NVL(f.FREE_BYTES, 0)) / 1073741824,
                ROUND(SUM(d.BYTES - NVL(f.FREE_BYTES, 0)) / SUM(d.BYTES) * 100, 1),
                t.RETENTION
            FROM DBA_DATA_FILES d
            JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = d.TABLESPACE_NAME
            LEFT JOIN (
                SELECT FILE_ID, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY FILE_ID
            ) f ON f.FILE_ID = d.FILE_ID
            WHERE t.CONTENTS = 'UNDO'
            GROUP BY d.TABLESPACE_NAME, t.RETENTION
        """)
        ts_row = cursor.fetchone() or [None] * 5

        current = {
            "undo_blocks": safe_int(undo_row[0]),
            "transaction_count": safe_int(undo_row[1]),
            "max_query_length_s": safe_int(undo_row[2]),
            "max_concurrency": safe_int(undo_row[3]),
            "tuned_undo_retention_s": safe_int(undo_row[4], 900),
            "expired_blocks": safe_int(undo_row[5]),
            "unexpired_blocks": safe_int(undo_row[6]),
            "active_blocks": safe_int(undo_row[7]),
            "tablespace_name": ts_row[0] or "UNDOTBS1",
            "total_gb": round(safe_float(ts_row[1]), 2),
            "used_gb": round(safe_float(ts_row[2]), 2),
            "pct_used": safe_float(ts_row[3]),
            "retention_mode": ts_row[4] or "NOGUARANTEE",
        }

        return {
            "current": current,
            "historical": {"peak_pct_used": None, "peak_time": None, "lookback_days": 30},
            "awr_available": False,
        }
    except Exception as e:
        print("Undo stats query failed: %s" % str(e))
        return {
            "current": {
                "tablespace_name": "UNDOTBS1", "total_gb": 0, "used_gb": 0, "pct_used": 0,
                "tuned_undo_retention_s": 900, "max_query_length_s": 0, "retention_mode": "NOGUARANTEE",
            },
            "historical": {"peak_pct_used": None, "peak_time": None, "lookback_days": 30},
            "awr_available": False,
        }


def query_temp_stats(cursor):
    """Temp tablespace stats — current usage from DBA_TEMP_FREE_SPACE."""
    try:
        # Current temp usage
        cursor.execute("""
            SELECT
                TABLESPACE_NAME,
                ROUND(TABLESPACE_SIZE / 1073741824, 2),
                ROUND(FREE_SPACE / 1073741824, 2),
                ROUND((TABLESPACE_SIZE - FREE_SPACE) / NULLIF(TABLESPACE_SIZE, 0) * 100, 1)
            FROM DBA_TEMP_FREE_SPACE
        """)
        free_row = cursor.fetchone() or [None] * 4

        total_gb = safe_float(free_row[1])
        free_gb = safe_float(free_row[2])
        used_gb = max(0, total_gb - free_gb)

        # Top temp consumers by session
        sessions = []
        try:
            cursor.execute("""
                SELECT
                    s.SID,
                    s.SERIAL#,
                    NVL(p.USERNAME, s.USERNAME),
                    ROUND(s.BLOCKS * t.BLOCK_SIZE / 1048576, 1),
                    s.TABLESPACE
                FROM V$TEMPSEG_USAGE s
                JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME = s.TABLESPACE
                JOIN V$SESSION p ON p.SID = s.SESSION_ADDR
                ORDER BY s.BLOCKS DESC
                FETCH FIRST 10 ROWS ONLY
            """)
            sessions = [
                {
                    "sid": safe_int(r[0]),
                    "serial": safe_int(r[1]),
                    "username": r[2] or "UNKNOWN",
                    "temp_mb": safe_float(r[3]),
                    "tablespace": r[4] or "",
                }
                for r in cursor.fetchall()
            ]
        except Exception:
            # V$TEMPSEG_USAGE join may not work on all versions
            try:
                cursor.execute("""
                    SELECT SID, SERIAL#, USERNAME, ROUND(BLOCKS * 8192 / 1048576, 1), TABLESPACE
                    FROM V$TEMPSEG_USAGE ORDER BY BLOCKS DESC FETCH FIRST 10 ROWS ONLY
                """)
                sessions = [
                    {
                        "sid": safe_int(r[0]),
                        "serial": safe_int(r[1]),
                        "username": r[2] or "UNKNOWN",
                        "temp_mb": safe_float(r[3]),
                        "tablespace": r[4] or "",
                    }
                    for r in cursor.fetchall()
                ]
            except Exception:
                pass

        current = {
            "tablespace_name": free_row[0] or "TEMP",
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "pct_used": safe_float(free_row[3]),
            "top_sessions": sessions,
        }

        return {
            "current": current,
            "historical": {"peak_gb": None, "peak_pct": None, "peak_time": None, "lookback_days": 30},
            "awr_available": False,
        }
    except Exception as e:
        print("Temp stats query failed: %s" % str(e))
        return {
            "current": {"tablespace_name": "TEMP", "total_gb": 0, "used_gb": 0, "free_gb": 0, "pct_used": 0, "top_sessions": []},
            "historical": {"peak_gb": None, "peak_pct": None, "peak_time": None, "lookback_days": 30},
            "awr_available": False,
        }


def query_alert_log(cursor):
    """Alert log — last 24 hours from V$DIAG_ALERT_EXT."""
    try:
        cursor.execute("""
            SELECT
                TO_CHAR(ORIGINATING_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'),
                MESSAGE_TEXT
            FROM V$DIAG_ALERT_EXT
            WHERE ORIGINATING_TIMESTAMP > SYSDATE - 1
              AND (
                MESSAGE_TEXT LIKE 'ORA-%%'
                OR MESSAGE_TEXT LIKE '%%checkpoint%%'
                OR MESSAGE_TEXT LIKE '%%corruption%%'
                OR MESSAGE_TEXT LIKE '%%recovery%%'
                OR MESSAGE_TEXT LIKE '%%error%%'
                OR MESSAGE_TEXT LIKE '%%warning%%'
                OR MESSAGE_TEXT LIKE '%%TNS-%%'
                OR MESSAGE_TEXT LIKE '%%instance%%'
                OR MESSAGE_TEXT LIKE 'Thread%%'
              )
            ORDER BY ORIGINATING_TIMESTAMP DESC
            FETCH FIRST 200 ROWS ONLY
        """)
        rows = cursor.fetchall()

        import re
        entries = []
        for r in rows:
            ts = r[0] or ""
            msg = (r[1] or "").strip()
            # Classify severity
            severity = "info"
            if re.search(r"ORA-600|ORA-7445|ORA-1578|ORA-04031|ORA-01555", msg):
                severity = "critical"
            elif re.search(r"ORA-\d{4,5}", msg):
                severity = "warning"
            elif re.search(r"checkpoint not complete|cannot allocate new log|block corruption|instance termination", msg, re.IGNORECASE):
                severity = "critical"
            elif re.search(r"checkpoint|redo log switch|archiv|TNS-1\d{4}", msg, re.IGNORECASE):
                severity = "warning"
            elif re.search(r"TNS-12560|TNS-12537|opiodr aborting|Fatal NI", msg):
                severity = "noise"
            entries.append({"ts": ts, "message": msg, "severity": severity})

        summary = {
            "total": len(entries),
            "critical": len([e for e in entries if e["severity"] == "critical"]),
            "warning": len([e for e in entries if e["severity"] == "warning"]),
            "info": len([e for e in entries if e["severity"] == "info"]),
            "noise": len([e for e in entries if e["severity"] == "noise"]),
        }

        return {"entries": entries[:100], "summary": summary}
    except Exception as e:
        msg = str(e)
        # V$DIAG_ALERT_EXT requires an explicit grant even with SELECT_CATALOG_ROLE
        missing_grant = "ORA-00942" in msg or "ORA-01031" in msg
        error_msg = (
            "Alert log access requires GRANT SELECT ON V_$DIAG_ALERT_EXT TO your_user"
            if missing_grant else msg
        )
        if not missing_grant:
            print("Alert log query failed: %s" % msg)
        return {"entries": [], "summary": {"total": 0, "critical": 0, "warning": 0, "info": 0, "noise": 0}, "error": error_msg}


def query_resource_limits(cursor):
    """Resource limits — current from V$RESOURCE_LIMIT."""
    try:
        cursor.execute("""
            SELECT
                RESOURCE_NAME,
                CURRENT_UTILIZATION,
                MAX_UTILIZATION,
                INITIAL_ALLOCATION,
                LIMIT_VALUE
            FROM V$RESOURCE_LIMIT
            WHERE RESOURCE_NAME IN (
                'sessions', 'processes', 'enqueue_locks', 'enqueue_resources',
                'dml_locks', 'temporary_table_locks', 'transactions',
                'max_rollback_segments', 'sort_segment_locks'
            )
            ORDER BY
                CASE RESOURCE_NAME
                    WHEN 'sessions' THEN 1 WHEN 'processes' THEN 2 WHEN 'transactions' THEN 3
                    WHEN 'enqueue_locks' THEN 4 WHEN 'enqueue_resources' THEN 5
                    WHEN 'dml_locks' THEN 6 ELSE 9 END
        """)
        rows = cursor.fetchall()

        current = []
        for r in rows:
            limit_val = None if r[4] == "UNLIMITED" else safe_int(r[4], None)
            max_util = safe_int(r[2])
            pct_used = round(max_util / limit_val * 100) if limit_val else None
            status = "ok"
            if pct_used is not None:
                if pct_used >= 90:
                    status = "critical"
                elif pct_used >= 80:
                    status = "warning"
            current.append({
                "resource": r[0] or "",
                "current_utilization": safe_int(r[1]),
                "max_utilization": max_util,
                "initial_allocation": r[3] or "0",
                "limit_value": limit_val,
                "limit_display": r[4] or "0",
                "pct_max_used": pct_used,
                "status": status,
            })

        return {"current": current, "historical": {}, "awr_available": False}
    except Exception as e:
        print("Resource limits query failed: %s" % str(e))
        return {"current": [], "historical": {}, "awr_available": False}


def query_sga_pga_history(cursor):
    """SGA/PGA sizing — current targets from V$PARAMETER + recent resize ops."""
    try:
        # Current SGA/PGA targets from V$PARAMETER
        cursor.execute("""
            SELECT NAME, VALUE
            FROM V$PARAMETER
            WHERE NAME IN ('sga_target', 'pga_aggregate_target', 'sga_max_size', 'memory_target', 'memory_max_target')
        """)
        params = {}
        for r in cursor.fetchall():
            params[r[0]] = safe_int(r[1])

        sga_target_gb = round(params.get("sga_target", 0) / 1073741824, 1)
        pga_target_gb = round(params.get("pga_aggregate_target", 0) / 1073741824, 1)
        sga_max_gb = round(params.get("sga_max_size", 0) / 1073741824, 1)
        mem_target_gb = round(params.get("memory_target", 0) / 1073741824, 1)

        # Recent ASMM resize operations
        resize_ops = []
        try:
            cursor.execute("""
                SELECT
                    TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI'),
                    COMPONENT,
                    OPER_TYPE,
                    ROUND(INITIAL_SIZE / 1073741824, 2),
                    ROUND(FINAL_SIZE / 1073741824, 2),
                    STATUS
                FROM V$SGA_RESIZE_OPS
                ORDER BY START_TIME DESC
                FETCH FIRST 20 ROWS ONLY
            """)
            resize_ops = [
                {
                    "op_time": r[0] or "",
                    "component": r[1] or "",
                    "oper_type": r[2] or "",
                    "from_gb": safe_float(r[3]),
                    "to_gb": safe_float(r[4]),
                    "status": r[5] or "",
                }
                for r in cursor.fetchall()
            ]
        except Exception:
            pass

        return {
            "current": {
                "sga_target_gb": sga_target_gb,
                "pga_target_gb": pga_target_gb,
                "sga_max_gb": sga_max_gb,
                "memory_target_gb": mem_target_gb,
            },
            "resize_ops": resize_ops,
            "pga_history": {"peak_allocated_gb": None, "peak_time": None},
            "sga_component_history": [],
            "awr_available": False,
        }
    except Exception as e:
        print("SGA/PGA history query failed: %s" % str(e))
        return {
            "current": {"sga_target_gb": 0, "pga_target_gb": 0, "sga_max_gb": 0, "memory_target_gb": 0},
            "resize_ops": [],
            "pga_history": {"peak_allocated_gb": None, "peak_time": None},
            "sga_component_history": [],
            "awr_available": False,
        }


# ============================================================
# Wave B: Backup & Recovery Health Checks
# ============================================================

def query_backup_stats(cursor):
    """Collect backup and recovery health data — RMAN, FRA, archivelog, validation."""
    rman_backup = query_rman_backup(cursor)
    fra_usage = query_fra_usage(cursor)
    archivelog_rate = query_archivelog_rate(cursor)
    backup_validation = query_backup_validation(cursor)

    statuses = [c.get("status", "unknown") for c in [rman_backup, fra_usage, archivelog_rate, backup_validation]]
    if "critical" in statuses:
        overall_status = "critical"
    elif "warning" in statuses:
        overall_status = "warning"
    elif all(s == "ok" for s in statuses):
        overall_status = "ok"
    else:
        overall_status = "unknown"

    return {
        "rman_backup": rman_backup,
        "fra_usage": fra_usage,
        "archivelog_rate": archivelog_rate,
        "backup_validation": backup_validation,
        "overall_status": overall_status,
    }


def query_rman_backup(cursor):
    """RMAN Backup Freshness — 🔴 >48h, 🟡 >24h, 🟢 <24h"""
    try:
        cursor.execute("""
            SELECT
                INPUT_TYPE,
                STATUS,
                TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                ROUND((SYSDATE - END_TIME) * 24, 1),
                ROUND(OUTPUT_BYTES / 1073741824, 2),
                ELAPSED_SECONDS
            FROM (
                SELECT INPUT_TYPE, STATUS, START_TIME, END_TIME, OUTPUT_BYTES, ELAPSED_SECONDS,
                       ROW_NUMBER() OVER (PARTITION BY INPUT_TYPE ORDER BY END_TIME DESC) AS RN
                FROM V$RMAN_BACKUP_JOB_DETAILS
                WHERE STATUS = 'COMPLETED'
            )
            WHERE RN = 1
            ORDER BY CASE INPUT_TYPE WHEN 'DB FULL' THEN 1 WHEN 'DB INCR' THEN 2 WHEN 'ARCHIVELOG' THEN 3 ELSE 4 END
        """)
        last_by_type_rows = cursor.fetchall()

        cursor.execute("""
            SELECT
                INPUT_TYPE,
                STATUS,
                TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                ROUND((SYSDATE - END_TIME) * 24, 1),
                ROUND(OUTPUT_BYTES / 1073741824, 2),
                ELAPSED_SECONDS
            FROM V$RMAN_BACKUP_JOB_DETAILS
            ORDER BY START_TIME DESC
            FETCH FIRST 10 ROWS ONLY
        """)
        recent_rows = cursor.fetchall()

        def row_to_job(r):
            return {
                "input_type": r[0] or "",
                "status": r[1] or "",
                "start_time": r[2] or "",
                "end_time": r[3] or "",
                "hours_ago": safe_float(r[4]),
                "size_gb": safe_float(r[5]),
                "elapsed_seconds": safe_int(r[6]),
            }

        last_by_type = [row_to_job(r) for r in last_by_type_rows]
        recent_jobs = [row_to_job(r) for r in recent_rows]

        full_backup = next((b for b in last_by_type if b["input_type"] == "DB FULL"), None)
        incr_backup = next((b for b in last_by_type if b["input_type"] == "DB INCR"), None)
        arch_backup = next((b for b in last_by_type if b["input_type"] == "ARCHIVELOG"), None)
        full_hours_ago = full_backup["hours_ago"] if full_backup else None

        if not last_by_type and not recent_jobs:
            status = "unknown"
        elif full_hours_ago is None:
            status = "critical"
        elif full_hours_ago > 48:
            status = "critical"
        elif full_hours_ago > 24:
            status = "warning"
        else:
            status = "ok"

        return {
            "status": status,
            "rman_available": len(recent_jobs) > 0 or len(last_by_type) > 0,
            "full_backup_hours_ago": full_hours_ago,
            "last_full_backup": full_backup,
            "last_incremental_backup": incr_backup,
            "last_archivelog_backup": arch_backup,
            "last_by_type": last_by_type,
            "recent_jobs": recent_jobs,
        }
    except Exception as e:
        print("RMAN backup query failed: %s" % str(e))
        return {"status": "unknown", "rman_available": False, "last_by_type": [], "recent_jobs": [], "error": str(e)}


def query_fra_usage(cursor):
    """FRA Usage — 🔴 >90% used and <10% reclaimable, 🟡 >80%, 🟢 <80%"""
    try:
        cursor.execute("""
            SELECT
                NAME,
                ROUND(SPACE_LIMIT / 1073741824, 2),
                ROUND(SPACE_USED / 1073741824, 2),
                ROUND(SPACE_RECLAIMABLE / 1073741824, 2),
                NUMBER_OF_FILES
            FROM V$RECOVERY_FILE_DEST
        """)
        dest_row = cursor.fetchone() or [None, 0, 0, 0, 0]

        cursor.execute("""
            SELECT FILE_TYPE,
                   ROUND(PERCENT_SPACE_USED, 1),
                   ROUND(PERCENT_SPACE_RECLAIMABLE, 1),
                   NUMBER_OF_FILES
            FROM V$FLASH_RECOVERY_AREA_USAGE
            ORDER BY PERCENT_SPACE_USED DESC
        """)
        usage_rows = cursor.fetchall()

        cursor.execute("""
            SELECT ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1073741824, 2)
            FROM V$ARCHIVED_LOG
            WHERE COMPLETION_TIME > SYSDATE - 1 AND STANDBY_DEST = 'NO'
        """)
        gen_row = cursor.fetchone() or [0]

        limit_gb = safe_float(dest_row[1])
        used_gb = safe_float(dest_row[2])
        reclaimable_gb = safe_float(dest_row[3])
        fra_location = dest_row[0] or ""

        pct_used = round((used_gb / limit_gb) * 100, 1) if limit_gb > 0 else 0
        pct_reclaimable = round((reclaimable_gb / limit_gb) * 100, 1) if limit_gb > 0 else 0
        archivelogs_24h_gb = safe_float(gen_row[0])

        available_gb = limit_gb - used_gb + reclaimable_gb
        hourly_rate_gb = archivelogs_24h_gb / 24 if archivelogs_24h_gb > 0 else 0
        hours_until_full = round(available_gb / hourly_rate_gb) if hourly_rate_gb > 0 and limit_gb > 0 else None

        file_type_breakdown = [{
            "file_type": r[0] or "",
            "pct_used": safe_float(r[1]),
            "pct_reclaimable": safe_float(r[2]),
            "number_of_files": safe_int(r[3]),
        } for r in usage_rows]

        if limit_gb == 0:
            status = "unknown"
        elif pct_used > 90 and pct_reclaimable < 10:
            status = "critical"
        elif pct_used > 80:
            status = "warning"
        else:
            status = "ok"

        return {
            "status": status,
            "fra_configured": limit_gb > 0,
            "location": fra_location,
            "limit_gb": limit_gb,
            "used_gb": used_gb,
            "reclaimable_gb": reclaimable_gb,
            "pct_used": pct_used,
            "pct_reclaimable": pct_reclaimable,
            "archivelogs_24h_gb": archivelogs_24h_gb,
            "hours_until_full": hours_until_full,
            "file_type_breakdown": file_type_breakdown,
        }
    except Exception as e:
        print("FRA usage query failed: %s" % str(e))
        return {"status": "unknown", "fra_configured": False, "error": str(e)}


def query_archivelog_rate(cursor):
    """Archivelog generation rate — 🟡 >20 switches/hr, 🔴 not in archivelog mode"""
    try:
        cursor.execute("SELECT LOG_MODE FROM V$DATABASE")
        mode_row = cursor.fetchone() or ["ARCHIVELOG"]
        log_mode = mode_row[0] or "ARCHIVELOG"

        cursor.execute("""
            SELECT
                TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24') AS HOUR,
                COUNT(*),
                ROUND(SUM(BLOCKS * BLOCK_SIZE) / 1048576, 1)
            FROM V$ARCHIVED_LOG
            WHERE COMPLETION_TIME > SYSDATE - 1 AND STANDBY_DEST = 'NO'
            GROUP BY TO_CHAR(COMPLETION_TIME, 'YYYY-MM-DD HH24')
            ORDER BY HOUR DESC
        """)
        arch_rows = cursor.fetchall()

        cursor.execute("""
            SELECT l.GROUP#, l.MEMBERS, ROUND(l.BYTES/1048576,0), l.STATUS, l.ARCHIVED
            FROM V$LOG l ORDER BY l.GROUP#
        """)
        log_rows = cursor.fetchall()

        cursor.execute("""
            SELECT ROUND(COUNT(*) / 24.0, 1), COUNT(*)
            FROM V$LOG_HISTORY WHERE FIRST_TIME > SYSDATE - 1
        """)
        switch_row = cursor.fetchone() or [0, 0]

        hourly_breakdown = [{"hour": r[0] or "", "log_count": safe_int(r[1]), "size_mb": safe_float(r[2])} for r in arch_rows]
        log_groups = [{"group_num": safe_int(r[0]), "members": safe_int(r[1]), "size_mb": safe_int(r[2]), "status": r[3] or "", "archived": r[4] or ""} for r in log_rows]

        switches_per_hour = safe_float(switch_row[0])
        switches_24h = safe_int(switch_row[1])
        archivelogs_24h = sum(h["log_count"] for h in hourly_breakdown)
        total_size_mb_24h = sum(h["size_mb"] for h in hourly_breakdown)

        if log_mode != "ARCHIVELOG":
            status = "critical"
        elif switches_per_hour > 20:
            status = "warning"
        else:
            status = "ok"

        return {
            "status": status,
            "log_mode": log_mode,
            "archivelog_mode": log_mode == "ARCHIVELOG",
            "switches_per_hour": switches_per_hour,
            "switches_24h": switches_24h,
            "archivelogs_24h": archivelogs_24h,
            "total_size_mb_24h": total_size_mb_24h,
            "hourly_breakdown": hourly_breakdown[:24],
            "log_groups": log_groups,
        }
    except Exception as e:
        print("Archivelog rate query failed: %s" % str(e))
        return {"status": "unknown", "archivelog_mode": None, "error": str(e)}


def query_backup_validation(cursor):
    """Backup validation — 🔴 corruption found or last 3 jobs failed"""
    try:
        cursor.execute("""
            SELECT OPERATION, STATUS,
                   TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                   TO_CHAR(END_TIME, 'YYYY-MM-DD HH24:MI:SS'),
                   MBYTES_PROCESSED,
                   SUBSTR(NVL(OUTPUT,''), 1, 300)
            FROM V$RMAN_STATUS
            WHERE OPERATION IN ('BACKUP','RESTORE','RECOVER','DELETE','VALIDATE')
              AND START_TIME > SYSDATE - 7
            ORDER BY START_TIME DESC
            FETCH FIRST 20 ROWS ONLY
        """)
        ops_rows = cursor.fetchall()

        cursor.execute("SELECT COUNT(*), NVL(SUM(BLOCKS),0) FROM V$BACKUP_CORRUPTION")
        bc_row = cursor.fetchone() or [0, 0]

        cursor.execute("SELECT COUNT(*), NVL(SUM(BLOCKS),0) FROM V$COPY_CORRUPTION")
        cc_row = cursor.fetchone() or [0, 0]

        recent_ops = [{
            "operation": r[0] or "",
            "status": r[1] or "",
            "start_time": r[2] or "",
            "end_time": r[3] or "",
            "mbytes_processed": safe_float(r[4]),
            "output": (r[5] or "")[:300],
        } for r in ops_rows]

        backup_corruptions = safe_int(bc_row[0])
        backup_corrupt_blocks = safe_int(bc_row[1])
        copy_corruptions = safe_int(cc_row[0])
        copy_corrupt_blocks = safe_int(cc_row[1])
        total_corruptions = backup_corruptions + copy_corruptions

        recent_backups = [op for op in recent_ops if op["operation"] == "BACKUP"][:3]
        last_3_failed = len(recent_backups) > 0 and all(b["status"] == "FAILED" for b in recent_backups)

        if total_corruptions > 0:
            status = "critical"
        elif last_3_failed:
            status = "critical"
        elif any(b["status"] == "FAILED" for b in recent_backups):
            status = "warning"
        else:
            status = "ok"

        return {
            "status": status,
            "backup_corruptions": backup_corruptions,
            "backup_corrupt_blocks": backup_corrupt_blocks,
            "copy_corruptions": copy_corruptions,
            "copy_corrupt_blocks": copy_corrupt_blocks,
            "total_corruptions": total_corruptions,
            "last_3_backups_failed": last_3_failed,
            "recent_operations": recent_ops,
        }
    except Exception as e:
        print("Backup validation query failed: %s" % str(e))
        return {"status": "unknown", "total_corruptions": 0, "error": str(e)}


# ============================================================
# Wave E: EBS Apps Health Checks
# All EBS tables are schema-qualified with APPS. so queries
# resolve correctly when connected as SYSTEM user.
# ============================================================

def _probe_ebs_detection(cursor):
    """Return (is_ebs, error_message) by probing APPS schema presence.

    Bug 2 fix: Uses a four-step fallback probe chain that survives locked APPS
    schemas, missing SELECT ANY DICTIONARY, and partial grant configurations.

      Step 1 — APPS.FND_PRODUCT_GROUPS (canonical EBS sentinel; best coverage)
      Step 2 — APPS.FND_CONCURRENT_QUEUES (always present on running EBS instances)
      Step 3 — APPS.FND_PRODUCT_INSTALLATIONS (present on all EBS 11i/12.x)
      Step 4 — ALL_TABLES WHERE OWNER='APPS' (schema-level probe, no FND grants needed)

    Logs which probe succeeded to help debug permission issues on new installations.

    Returns:
      (True,  None)   — EBS confirmed (any probe succeeded)
      (False, None)   — EBS not present (non-EBS database, correct negative)
      (False, str)    — APPS schema detected but FND tables not accessible
                        (permissions issue — needs a clear error, not silent fail)
    """
    _IS_FND_ERROR = lambda m: 'ORA-00942' in m or 'ORA-00904' in m

    # Step 1 (Bug 2a): FND_PRODUCT_GROUPS — canonical EBS sentinel
    try:
        cursor.execute(
            'SELECT RELEASE_NAME FROM APPS.FND_PRODUCT_GROUPS WHERE ROWNUM = 1'
        )
        cursor.fetchone()
        print('[EBS probe] Step 1 (FND_PRODUCT_GROUPS) succeeded — EBS detected')
        return True, None
    except Exception as e1:
        if not _IS_FND_ERROR(str(e1)):
            return False, None  # APPS schema not present → non-EBS

    # Step 2 (Bug 2a): FND_CONCURRENT_QUEUES — present on all live EBS instances
    try:
        cursor.execute(
            'SELECT 1 FROM APPS.FND_CONCURRENT_QUEUES WHERE ROWNUM = 1'
        )
        cursor.fetchone()
        print('[EBS probe] Step 2 (FND_CONCURRENT_QUEUES) succeeded — EBS detected')
        return True, None
    except Exception as e2:
        if not _IS_FND_ERROR(str(e2)):
            return False, None

    # Step 3 (Bug 2b): FND_PRODUCT_INSTALLATIONS — universally present on EBS 11i/12.x
    try:
        cursor.execute(
            'SELECT 1 FROM APPS.FND_PRODUCT_INSTALLATIONS WHERE ROWNUM = 1'
        )
        cursor.fetchone()
        print('[EBS probe] Step 3 (FND_PRODUCT_INSTALLATIONS) succeeded — EBS detected')
        return True, None
    except Exception as e3:
        if not _IS_FND_ERROR(str(e3)):
            return False, None

    # Step 4 (Bug 2c): ALL_TABLES schema-level probe — no FND grants needed
    try:
        cursor.execute(
            "SELECT 1 FROM ALL_TABLES WHERE OWNER = 'APPS' AND ROWNUM = 1"
        )
        row = cursor.fetchone()
        if row:
            print('[EBS probe] Step 4 (ALL_TABLES OWNER=APPS) succeeded — EBS detected')
            return True, None
        # APPS owner exists but no tables accessible
        return False, None
    except Exception as e4:
        msg4 = str(e4)
        if _IS_FND_ERROR(msg4):
            # Bug 5: APPS schema reached across all probes but no FND grants
            return False, (
                'APPS schema detected but FND tables are not accessible. '
                'Grant SELECT on APPS.FND_PRODUCT_GROUPS to the connecting user, '
                'or connect as APPS / SYSTEM with SELECT ANY TABLE privilege. '
                'Error: %s' % msg4
            )
        return False, None


def _build_ebs_operations_from_proxy(apps_health):
    """Convert the proxy's query_apps_health() result dict into the
    ebs_operations shape expected by the TuneVault server (oracle-client.js
    format: concurrent_managers.cm01 / cm02 / cm05 / cm10, workflow.wf02 /
    wf03 / wf08, etc.).

    This is the canonical translation layer — the proxy's internal
    representation uses named sub-dicts (managers list, opp_data, etc.)
    while the server API consumes the coded cm01/wf02 structure.
    """
    if not apps_health:
        return None

    cm_raw = apps_health.get('concurrent_managers') or {}
    wf_raw = apps_health.get('workflow') or {}
    opp_raw = apps_health.get('opp') or {}

    # ── CM01: Internal Concurrent Manager ────────────────────────────────
    cm01 = None
    managers = cm_raw.get('managers') or []
    for m in managers:
        if 'internal' in (m.get('display_name') or '').lower():
            cm01 = {
                'name': m.get('display_name', 'Internal Manager'),
                'max_processes': safe_int(m.get('target', 0)),
                'running_processes': safe_int(m.get('actual', 0)),
                'control_code': m.get('status_label', ''),
                'status': 'critical' if cm_raw.get('icm_down') else 'ok',
            }
            break
    # If ICM not found by name, synthesise from icm_down flag
    if cm01 is None and 'icm_down' in cm_raw:
        cm01 = {
            'name': 'Internal Manager',
            'max_processes': 1,
            'running_processes': 0 if cm_raw['icm_down'] else 1,
            'control_code': '',
            'status': 'critical' if cm_raw['icm_down'] else 'ok',
        }

    # ── CM02: Pending request queue depth ────────────────────────────────
    cm02 = None
    pending = safe_int(cm_raw.get('pending_requests', 0))
    cm02 = {'pending_requests': pending}

    # ── CM03: OPP queue depth (Bug 3 — was not surfaced before) ──────────
    cm03 = None
    if opp_raw:
        cm03 = {
            'name': opp_raw.get('manager_name', 'Output Post Processor'),
            'max_processes': safe_int(opp_raw.get('target', 0)),
            'running_processes': safe_int(opp_raw.get('actual', 0)),
            'status': opp_raw.get('status', 'ok'),
            'recommendation': opp_raw.get('recommendation', ''),
        }

    # ── CM05: Running request count (approx from running_requests) ────────
    cm05 = {
        'completed_24h': safe_int(cm_raw.get('running_requests', 0)),
        'avg_runtime_secs': 0,
    }

    # ── CM10: Not available via this proxy path — omit ────────────────────

    # ── WF02: WF error queue depth (Bug 3 — was not surfaced before) ─────
    wf02 = None
    if 'error_count' in wf_raw:
        wf02 = {'error_count': safe_int(wf_raw.get('error_count', 0))}

    # ── WF03: WF Mailer status (Bug 3 — was not surfaced before) ─────────
    wf03 = None
    if 'mailer_component' in wf_raw or 'mailer_running' in wf_raw:
        mailer = wf_raw.get('mailer_component') or {}
        wf03 = {
            'mailer_running': bool(wf_raw.get('mailer_running', False)),
            'status': mailer.get('status', 'UNKNOWN') if mailer else 'UNKNOWN',
            'startup_mode': mailer.get('startup_mode', '') if mailer else '',
            'deferred_ready': 0,  # not available from this query path
        }

    # ── WF08: Stuck notifications backlog ────────────────────────────────
    wf08 = None
    stuck = safe_int(wf_raw.get('stuck_notifications', 0))
    wf08 = {'pending_over_2h': stuck, 'pending_over_8h': 0}

    # ── WF09: All WF service components ──────────────────────────────────
    wf09 = [
        {
            'name': s.get('name', ''),
            'enabled': s.get('status', '') == 'RUNNING',
            'status': s.get('status', 'UNKNOWN'),
            'startup_mode': s.get('startup_mode', ''),
        }
        for s in (wf_raw.get('services') or [])
    ]

    # ── ADOP_STATUS (Bug 3 — was not surfaced in ebs_operations before) ──
    adop = apps_health.get('adop_status') or {}
    adop_sessions = adop.get('sessions') or []
    adop_result = {
        'check_id': 'ADOP_STATUS',
        'status': adop.get('status', 'skip'),
        'severity': adop.get('severity', 'info'),
        'message': adop.get('message', ''),
        'sessions': adop_sessions,
        'active_sessions': len([s for s in adop_sessions if (s.get('status') or '').upper() in ('INPROGRESS', 'IN_PROGRESS', 'RUNNING', 'ACTIVE')]),
        'failed_sessions': len([s for s in adop_sessions if (s.get('status') or '').upper() == 'FAILED']),
    }

    return {
        'concurrent_managers': {
            'cm01': cm01,
            'cm02': cm02,
            'cm03': cm03,  # OPP
            'cm05': cm05,
            'cm06': [{'name': m.get('display_name', ''), 'max_processes': safe_int(m.get('target', 0)), 'running_processes': safe_int(m.get('actual', 0)), 'target_processes': safe_int(m.get('target', 0))} for m in managers],
            'cm09': [],
            'cm10': None,
        },
        'workflow': {
            'wf01': [],
            'wf02': wf02,
            'wf03': wf03,
            'wf07': [],
            'wf08': wf08,
            'wf09': wf09,
            # Overall WF status summary
            'status': wf_raw.get('status', 'ok'),
            'mailer_running': bool(wf_raw.get('mailer_running', False)),
        },
        'security': {'sc12': None, 'sc14': []},
        'functional': {'fb01': [], 'fb03': None, 'fb04': None},
        'observability': {'ot05': None},
        'config_drift': {'cd07': None},
        # Extra proxy-only keys (informational, not consumed by server checks)
        '_adop_status': adop_result,
        '_apps_env': apps_health.get('apps_env') or {},
        '_overall_status': apps_health.get('status', 'ok'),
    }


def query_apps_health(cursor):
    """Query Oracle E-Business Suite application tier health.

    Returns dict with is_ebs=True on success, is_ebs=False on non-EBS,
    or a dict with error key when APPS schema is present but FND tables
    are not accessible (Bug 5 — clear error instead of silent None).

    OACore, Forms Server, OHS checks require OS Agent (not via DB).
    All table references use APPS. schema prefix so they resolve
    when connected as SYSTEM (with SELECT ANY TABLE privilege).
    """
    # Bug 2 + Bug 5: standardised two-step EBS probe
    is_ebs, probe_error = _probe_ebs_detection(cursor)
    if not is_ebs:
        if probe_error:
            # Bug 5: APPS schema present but FND tables not readable
            return {'is_ebs': False, 'ebs_probe_error': probe_error}
        return None  # clean non-EBS database

    # Bug 4: wrap the whole body in try/except, but collect partial results
    # Sub-checks already have their own try/except — the outer wrapper now
    # returns a partial result instead of discarding everything.
    partial_result = {'is_ebs': True, 'status': 'ok'}
    sub_errors = []

    try:

        # ── Concurrent Manager queues (verified against EBS 12.2.12) ──
        managers = []
        try:
            cursor.execute('''
                SELECT DISTINCT
                    b.user_concurrent_queue_name AS manager_name,
                    a.target_node               AS node,
                    a.running_processes          AS actual_procs,
                    a.max_processes              AS target_procs,
                    DECODE(b.control_code,
                        'D', 'Deactivating',
                        'E', 'Deactivated',
                        'N', 'Node unavai',
                        'A', 'Activating',
                        'X', 'Terminated',
                        'T', 'Terminating',
                        'V', 'Verifying',
                        'O', 'Suspending',
                        'P', 'Suspended',
                        'Q', 'Resuming',
                        'R', 'Restarting',
                        'Running')                 AS status_label
                FROM apps.fnd_concurrent_queues     a,
                     apps.fnd_concurrent_queues_vl  b
                WHERE a.concurrent_queue_id = b.concurrent_queue_id
                  AND a.max_processes != 0
                ORDER BY a.max_processes DESC
            ''')
            for r in cursor.fetchall():
                managers.append({
                    'display_name': r[0] or '',
                    'node':         r[1] or '',
                    'actual':       safe_int(r[2]),
                    'target':       safe_int(r[3]),
                    'status_label': r[4] or 'Running',
                })
        except Exception as e:
            print('CM query failed (non-fatal): %s' % str(e))

        # ── Pending / running request counts ──────────────────────
        pending_count = 0
        running_count = 0
        try:
            cursor.execute('''
                SELECT PHASE_CODE, COUNT(*)
                FROM APPS.FND_CONCURRENT_REQUESTS
                WHERE PHASE_CODE IN ('P', 'R')
                  AND HOLD_FLAG = 'N'
                GROUP BY PHASE_CODE
            ''')
            for r in cursor.fetchall():
                if r[0] == 'P':
                    pending_count = safe_int(r[1])
                elif r[0] == 'R':
                    running_count = safe_int(r[1])
        except Exception as e:
            print('Request count query failed (non-fatal): %s' % str(e))

        # ── OPP (dedicated query) ──────────────────────────────────────
        opp_data = {'manager_name': 'Output Post Processor', 'actual': 0, 'target': 0,
                    'status': 'ok', 'recommendation': 'OPP healthy: 0/0 process(es) running.'}
        try:
            cursor.execute('''
                SELECT b.user_concurrent_queue_name AS manager_name,
                       a.running_processes          AS actual,
                       a.max_processes              AS target
                FROM apps.fnd_concurrent_queues    a,
                     apps.fnd_concurrent_queues_vl b
                WHERE a.concurrent_queue_id = b.concurrent_queue_id
                  AND a.concurrent_queue_name = 'FNDCPOPP'
            ''')
            row = cursor.fetchone()
            if row:
                opp_actual = safe_int(row[1])
                opp_target = safe_int(row[2])
                if opp_actual == 0 and opp_target > 0:
                    opp_st = 'critical'
                    opp_rec = 'OPP is not running — PDF/output generation will fail. Start OPP from the CM admin page.'
                elif opp_actual < opp_target:
                    opp_st = 'warning'
                    opp_rec = 'OPP has %d/%d processes running — throughput may be degraded.' % (opp_actual, opp_target)
                else:
                    opp_st = 'ok'
                    opp_rec = 'OPP healthy: %d/%d process(es) running.' % (opp_actual, opp_target)
                opp_data = {
                    'manager_name': row[0] or 'Output Post Processor',
                    'actual': opp_actual, 'target': opp_target,
                    'status': opp_st, 'recommendation': opp_rec,
                }
        except Exception as e:
            print('OPP query failed (non-fatal): %s' % str(e))

        # ── All Workflow components (WF% types — all 13 components) ──
        wf_services = []
        try:
            cursor.execute('''
                SELECT component_type, component_name, component_status, startup_mode
                FROM apps.fnd_svc_components
                WHERE component_type LIKE 'WF%%'
                ORDER BY 1, 2
            ''')
            for r in cursor.fetchall():
                wf_services.append({
                    'type': r[0] or '',
                    'name': r[1] or '',
                    'status': r[2] or 'UNKNOWN',
                    'startup_mode': r[3] or '',
                })
        except Exception as e:
            print('WF components query failed (non-fatal): %s' % str(e))

        # ── Stuck notifications ───────────────────────────────────
        stuck_notif = 0
        try:
            cursor.execute('''
                SELECT COUNT(*)
                FROM APPS.WF_NOTIFICATIONS
                WHERE STATUS = 'OPEN'
                  AND MAIL_STATUS = 'MAIL'
                  AND BEGIN_DATE < SYSDATE - 1/24
            ''')
            row = cursor.fetchone()
            stuck_notif = safe_int(row[0]) if row else 0
        except Exception as e:
            print('WF stuck notif query failed (non-fatal): %s' % str(e))

        # ── WF_ERROR queue depth ──────────────────────────────────
        wf_err_count = 0
        try:
            cursor.execute('SELECT COUNT(*) FROM APPS.WF_ERROR')
            row = cursor.fetchone()
            wf_err_count = safe_int(row[0]) if row else 0
        except Exception as e:
            print('WF error query failed (non-fatal): %s' % str(e))

        # ── Process CM status ────────────────────────────────────
        icm = None
        for m in managers:
            if 'internal concurrent manager' in (m.get('display_name') or '').lower():
                icm = m
                break

        icm_down = not icm or (icm.get('actual', 0) == 0 and icm.get('target', 0) > 0)
        cm_status = 'critical' if icm_down else 'ok'
        if not icm_down:
            under_staffed = any(m.get('target', 0) > 0 and m.get('actual', 0) < m.get('target', 0) for m in managers)
            if under_staffed or pending_count > 50:
                cm_status = 'warning'

        # ── Workflow status (all WF components) ─────────────────
        mailer = None
        for s in wf_services:
            if s.get('type') == 'WF_MAILER' or 'mailer' in (s.get('name') or '').lower():
                mailer = s
                break
        mailer_running = bool(mailer and mailer.get('status') == 'RUNNING')

        critical_comps = [s for s in wf_services if s.get('status') in ('DEACTIVATED_SYSTEM', 'STOPPED')]
        warning_comps  = [s for s in wf_services if s.get('status') not in ('RUNNING', 'DEACTIVATED_SYSTEM', 'STOPPED', 'UNKNOWN', '')]

        if mailer and not mailer_running:
            wf_status = 'critical'
        elif critical_comps:
            wf_status = 'critical'
        elif stuck_notif > 50 or wf_err_count > 20:
            wf_status = 'critical'
        elif warning_comps or stuck_notif > 5 or wf_err_count > 0:
            wf_status = 'warning'
        else:
            wf_status = 'ok'

        # ── Wave F: APPS_ENV and ADOP_STATUS ────────────────────────
        apps_env_result = query_apps_env(cursor)
        adop_result     = query_adop_status()

        # ── Overall apps status ───────────────────────────────────
        statuses = [cm_status, wf_status, opp_data['status'], apps_env_result['status'], adop_result['status']]
        if 'critical' in statuses:
            overall_status = 'critical'
        elif 'warning' in statuses:
            overall_status = 'warning'
        else:
            overall_status = 'ok'

        result = {
            'is_ebs': True,
            'status': overall_status,
            'concurrent_managers': {
                'status': cm_status,
                'icm_down': icm_down,
                'managers': managers,
                'pending_requests': pending_count,
                'running_requests': running_count,
            },
            'opp': opp_data,
            'workflow': {
                'status': wf_status,
                'mailer_running': mailer_running,
                'mailer_component': mailer,
                'services': wf_services,
                'stuck_notifications': stuck_notif,
                'error_count': wf_err_count,
            },
            'apps_env':    apps_env_result,
            'adop_status': adop_result,
            # oacore and forms: not available via DB — display placeholder via OS Agent
        }
        if sub_errors:
            result['sub_check_errors'] = sub_errors
        return result

    except Exception as e:
        # Bug 4: graceful degradation — return partial result with error noted
        # instead of returning None (which would discard all sub-check data
        # already collected before the exception was raised).
        print('EBS apps health query failed (partial result returned): %s' % str(e))
        partial_result['_outer_error'] = str(e)
        partial_result['status'] = 'error'
        if sub_errors:
            partial_result['sub_check_errors'] = sub_errors
        return partial_result


# ============================================================
# Wave F: APPS_ENV Check (Python proxy — OS + DB sources)
# ============================================================

def query_apps_env(cursor):
    """Query EBS environment variables from OS environment and Oracle DB.

    Since the proxy runs on the EBS app tier, process.environ holds the
    variables set when the EBS context file is sourced.
    DB sources supplement APPS_JDBC_URL and ORACLE_SID.
    """
    ALL_VARS = [
        'CONTEXT_FILE',
        'ADMIN_SCRIPTS_HOME',
        'INST_TOP',
        'COMMON_TOP',
        'FMW_HOME',
        'EBS_DOMAIN_HOME',
        'APPS_JDBC_URL',
        'TWO_TASK',
        'ORACLE_HOME',
        'ORACLE_SID',
        'TNS_ADMIN',
    ]
    CRITICAL_VARS = frozenset(['CONTEXT_FILE', 'INST_TOP', 'COMMON_TOP', 'ADMIN_SCRIPTS_HOME'])

    env_vars = {}

    # Step 1: OS environment (highest priority)
    for v in ALL_VARS:
        val = os.environ.get(v, '')
        if val:
            env_vars[v] = val

    # Step 2: Supplement from Oracle DB
    try:
        cursor.execute(
            "SELECT METVAL_CLOB FROM APPS.FND_OAM_METVAL WHERE METNAME = 'APPS_JDBC_URL' AND ROWNUM = 1"
        )
        row = cursor.fetchone()
        if row and row[0] and 'APPS_JDBC_URL' not in env_vars:
            env_vars['APPS_JDBC_URL'] = str(row[0])[:200]
    except Exception:
        pass

    try:
        cursor.execute("SELECT INSTANCE_NAME FROM v$instance")
        row = cursor.fetchone()
        if row and row[0] and 'ORACLE_SID' not in env_vars:
            env_vars['ORACLE_SID'] = str(row[0])
    except Exception:
        pass

    try:
        cursor.execute("SELECT VALUE FROM v$parameter WHERE name = 'tns_admin' AND ROWNUM = 1")
        row = cursor.fetchone()
        if row and row[0] and 'TNS_ADMIN' not in env_vars:
            env_vars['TNS_ADMIN'] = str(row[0])
    except Exception:
        pass

    # Step 3: Build rows
    rows = []
    for v in ALL_VARS:
        val = env_vars.get(v)
        rows.append({
            'variable': v,
            'value':    val,
            'state':    'OK' if val else 'MISSING',
            'critical': v in CRITICAL_VARS,
        })

    missing_critical = [r for r in rows if r['critical'] and r['state'] == 'MISSING']
    missing_any      = [r for r in rows if r['state'] == 'MISSING']

    if missing_critical:
        status  = 'critical'
        message = '%d critical EBS env var(s) missing: %s' % (
            len(missing_critical), ', '.join(r['variable'] for r in missing_critical))
    elif missing_any:
        status  = 'warning'
        message = '%d EBS env var(s) not detected (non-critical): %s' % (
            len(missing_any), ', '.join(r['variable'] for r in missing_any))
    else:
        status  = 'ok'
        message = 'All %d EBS environment variables are present.' % len(rows)

    os_env_available = any(os.environ.get(v) for v in ALL_VARS)

    return {
        'check_id': 'APPS_ENV',
        'status':   status,
        'severity': 'critical' if missing_critical else ('warning' if missing_any else 'ok'),
        'message':  message,
        'os_env_available': os_env_available,
        'display': {
            'columns': ['Variable', 'State', 'Value'],
            'rows': [[r['variable'], r['state'], (r['value'] or '')[:120] or '\u2014'] for r in rows],
        },
        'variables': rows,
    }


# ============================================================
# Wave F: ADOP_STATUS Check (Python proxy — OS command)
# ============================================================

def query_adop_status():
    """Run `adop -status -detail` on the EBS app tier and parse output.

    Requires APPS_PWD in environment. SKIP if not set.
    """
    import subprocess

    apps_pwd = os.environ.get('APPS_PWD', '') or os.environ.get('APPS_PASSWORD', '')
    if not apps_pwd:
        return {
            'check_id': 'ADOP_STATUS',
            'status':   'skip',
            'severity': 'info',
            'message':  'Skipped: APPS_PWD not set in proxy environment.',
            'display':  {'columns': ['Field', 'Value'], 'rows': [['Status', 'SKIPPED \u2014 APPS_PWD not available']]},
            'sessions': [],
        }

    admin_scripts_home = os.environ.get('ADMIN_SCRIPTS_HOME', '')
    adop_bin = os.path.join(admin_scripts_home, 'adop') if admin_scripts_home else 'adop'

    try:
        proc = subprocess.run(
            [adop_bin, '-status', '-detail'],
            env=dict(os.environ, APPS_PWD=apps_pwd),
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = (proc.stdout or '') + (proc.stderr or '')
    except subprocess.TimeoutExpired:
        return {
            'check_id': 'ADOP_STATUS',
            'status':   'warning',
            'severity': 'warning',
            'message':  'adop -status timed out after 30s.',
            'display':  {'columns': ['Field', 'Value'], 'rows': [['Status', 'TIMEOUT']]},
            'sessions': [],
        }
    except (OSError, Exception) as e:
        msg = str(e)[:200]
        return {
            'check_id': 'ADOP_STATUS',
            'status':   'warning',
            'severity': 'warning',
            'message':  'adop command failed: %s' % msg,
            'display':  {'columns': ['Field', 'Value'], 'rows': [['Error', msg]]},
            'sessions': [],
        }

    sessions = _parse_adop_output(output)

    failed_sessions = [s for s in sessions if (s.get('status') or '').upper() == 'FAILED']
    active_sessions = [s for s in sessions if (s.get('status') or '').upper() in ('INPROGRESS', 'IN_PROGRESS', 'RUNNING', 'ACTIVE')]

    if not sessions:
        status  = 'ok'
        message = 'No ADOP sessions found \u2014 no active or recent patching activity.'
    elif failed_sessions:
        status  = 'critical'
        message = '%d ADOP session(s) in FAILED state. Review before next patch cycle.' % len(failed_sessions)
    elif active_sessions:
        status  = 'warning'
        message = '%d ADOP session(s) currently active.' % len(active_sessions)
    else:
        status  = 'ok'
        message = 'ADOP: %d historical session(s) found, none in FAILED state.' % len(sessions)

    return {
        'check_id': 'ADOP_STATUS',
        'status':   status,
        'severity': 'critical' if failed_sessions else ('warning' if active_sessions else 'ok'),
        'message':  message,
        'display': {
            'columns': ['Session ID', 'Node', 'Phase', 'Status'],
            'rows': [[s.get('session_id', '\u2014'), s.get('node', '\u2014'),
                      s.get('phase', '\u2014'), s.get('status', '\u2014')] for s in sessions],
        },
        'sessions':   sessions,
        'raw_output': output[:2000],
    }


def _parse_adop_output(text):
    """Parse `adop -status -detail` output into session dicts."""
    sessions = []
    # Split by blank lines to get per-session blocks
    import re
    blocks = re.split(r'\n\s*\n', text)
    for block in blocks:
        session = {}
        for line in block.splitlines():
            line = line.strip()
            m = re.match(r'^(SESSION\s*ID|NODE|PHASE|STATUS)\s*[:\-]\s*(.+)', line, re.IGNORECASE)
            if m:
                key   = m.group(1).strip().lower().replace(' ', '_')
                value = m.group(2).strip()
                if key == 'session_id': session['session_id'] = value
                elif key == 'node':     session['node']       = value
                elif key == 'phase':    session['phase']      = value
                elif key == 'status':   session['status']     = value
        if session.get('session_id') or session.get('phase') or session.get('status'):
            sessions.append(session)
    return sessions


# ============================================================
# Wave G: Database Objects, Sessions, Security, Schema Stats
# ============================================================

def query_db_objects(cursor):
    """Collect invalid objects, stale stats, SCN headroom, SPFILE, recycle bin, control files."""
    EXCLUDED_OWNERS = "('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS','APPQOSSYS','DBSFWUSER','OJVMSYS','DVSYS','LBACSYS')"

    # Invalid objects
    try:
        cursor.execute("""
            SELECT COUNT(*) AS invalid_count,
                   COUNT(CASE WHEN OBJECT_TYPE IN ('PACKAGE BODY','PACKAGE') THEN 1 END),
                   COUNT(CASE WHEN OBJECT_TYPE = 'PROCEDURE' THEN 1 END),
                   COUNT(CASE WHEN OBJECT_TYPE = 'VIEW' THEN 1 END),
                   COUNT(CASE WHEN OBJECT_TYPE = 'TRIGGER' THEN 1 END)
            FROM DBA_OBJECTS
            WHERE STATUS = 'INVALID'
              AND OWNER NOT IN """ + EXCLUDED_OWNERS)
        r = cursor.fetchone() or (0, 0, 0, 0, 0)
        invalid = {"count": safe_int(r[0]), "packages": safe_int(r[1]), "procedures": safe_int(r[2]), "views": safe_int(r[3]), "triggers": safe_int(r[4])}
    except Exception as e:
        print("Invalid objects query failed: %s" % str(e))
        invalid = {"count": 0, "packages": 0, "procedures": 0, "views": 0, "triggers": 0}

    # Stale statistics
    try:
        cursor.execute("""
            SELECT COUNT(*) AS stale_count,
                   COUNT(CASE WHEN LAST_ANALYZED IS NULL THEN 1 END)
            FROM DBA_TAB_STATISTICS
            WHERE STALE_STATS = 'YES'
              AND OWNER NOT IN """ + EXCLUDED_OWNERS)
        r = cursor.fetchone() or (0, 0)
        stale = {"stale_count": safe_int(r[0]), "never_analyzed": safe_int(r[1])}
    except Exception as e:
        print("Stale stats query failed: %s" % str(e))
        stale = {"stale_count": 0, "never_analyzed": 0}

    # SCN headroom
    try:
        cursor.execute("""
            SELECT CURRENT_SCN,
                   ROUND((TO_NUMBER(SYSDATE - TO_DATE('01-01-1988','DD-MM-YYYY')) * 24 * 3600 * 16384 * 1024 - CURRENT_SCN) / (24*3600*16384), 0)
            FROM V$DATABASE""")
        r = cursor.fetchone() or (None, None)
        scn = {"current_scn": safe_int(r[0]) if r[0] is not None else None, "days_remaining": safe_int(r[1]) if r[1] is not None else None}
    except Exception as e:
        print("SCN headroom query failed: %s" % str(e))
        scn = {"current_scn": None, "days_remaining": None}

    # SPFILE
    try:
        cursor.execute("SELECT DECODE(COUNT(*),0,'PFILE','SPFILE') FROM V$PARAMETER WHERE NAME='spfile' AND VALUE IS NOT NULL")
        r = cursor.fetchone()
        pft = str(r[0]) if r else "UNKNOWN"
        spfile = {"param_file_type": pft, "using_spfile": pft == "SPFILE"}
    except Exception as e:
        print("SPFILE query failed: %s" % str(e))
        spfile = {"param_file_type": "UNKNOWN", "using_spfile": False}

    # Recycle bin
    try:
        cursor.execute("SELECT COUNT(*), ROUND(SUM(SPACE)*8192/1073741824, 2) FROM DBA_RECYCLEBIN")
        r = cursor.fetchone() or (0, 0)
        recyclebin = {"object_count": safe_int(r[0]), "size_gb": safe_float(r[1])}
    except Exception as e:
        print("Recyclebin query failed: %s" % str(e))
        recyclebin = {"object_count": 0, "size_gb": 0}

    # Control files
    try:
        cursor.execute("""
            SELECT COUNT(*),
                   SUM(CASE WHEN STATUS IS NOT NULL AND STATUS != '' THEN 1 ELSE 0 END)
            FROM V$CONTROLFILE""")
        r = cursor.fetchone() or (0, 0)
        controlfiles = {"count": safe_int(r[0]), "invalid_count": safe_int(r[1])}
    except Exception as e:
        print("Controlfile query failed: %s" % str(e))
        controlfiles = {"count": 0, "invalid_count": 0}

    return {
        "invalid_objects": invalid,
        "stale_stats": stale,
        "scn_headroom": scn,
        "spfile": spfile,
        "recyclebin": recyclebin,
        "controlfiles": controlfiles,
    }


def query_session_stats(cursor):
    """Active/blocked session counts and long-running SQL."""
    # Session counts
    try:
        cursor.execute("""
            SELECT COUNT(*),
                   COUNT(CASE WHEN STATUS = 'ACTIVE' AND TYPE = 'USER' THEN 1 END),
                   COUNT(CASE WHEN TYPE = 'USER' THEN 1 END)
            FROM V$SESSION""")
        r = cursor.fetchone() or (0, 0, 0)
        total = safe_int(r[0])
        active = safe_int(r[1])
        user = safe_int(r[2])
    except Exception as e:
        print("Session count query failed: %s" % str(e))
        total, active, user = 0, 0, 0

    # Blocked sessions
    try:
        cursor.execute("SELECT COUNT(*) FROM V$SESSION WHERE BLOCKING_SESSION IS NOT NULL AND STATUS='ACTIVE'")
        r = cursor.fetchone()
        blocked = safe_int(r[0]) if r else 0
    except Exception as e:
        print("Blocked session query failed: %s" % str(e))
        blocked = 0

    # Long-running SQL (>5 min)
    try:
        cursor.execute("""
            SELECT COUNT(*), ROUND(MAX((SYSDATE - SQL_EXEC_START) * 1440), 1)
            FROM V$SESSION
            WHERE STATUS = 'ACTIVE' AND TYPE = 'USER'
              AND SQL_EXEC_START IS NOT NULL
              AND (SYSDATE - SQL_EXEC_START) * 1440 > 5""")
        r = cursor.fetchone() or (0, 0)
        long_count = safe_int(r[0])
        max_min = safe_float(r[1])
    except Exception as e:
        print("Long SQL query failed: %s" % str(e))
        long_count, max_min = 0, 0

    return {
        "total_sessions": total,
        "active_sessions": active,
        "user_sessions": user,
        "blocked_sessions": blocked,
        "long_running_sql_count": long_count,
        "max_runtime_min": max_min,
    }


def query_security_stats(cursor):
    """Security posture checks: default passwords, public privs, audit, password policy."""
    # Default passwords
    try:
        cursor.execute("SELECT COUNT(*) FROM DBA_USERS_WITH_DEFPWD WHERE ACCOUNT_STATUS='OPEN'")
        r = cursor.fetchone()
        def_pwd = safe_int(r[0]) if r else 0
    except Exception as e:
        print("Default pwd query failed: %s" % str(e))
        def_pwd = 0

    # Dangerous PUBLIC grants
    try:
        cursor.execute("""
            SELECT COUNT(*) FROM DBA_SYS_PRIVS
            WHERE GRANTEE='PUBLIC'
              AND PRIVILEGE IN ('CREATE PROCEDURE','CREATE ANY PROCEDURE','CREATE ANY TRIGGER',
                                'ALTER SYSTEM','ALTER DATABASE','DROP ANY TABLE','EXECUTE ANY PROCEDURE')""")
        r = cursor.fetchone()
        pub_privs = safe_int(r[0]) if r else 0
    except Exception as e:
        print("PUBLIC privs query failed: %s" % str(e))
        pub_privs = 0

    # Open schema-only accounts
    try:
        cursor.execute("""
            SELECT COUNT(*) FROM DBA_USERS
            WHERE ACCOUNT_STATUS='OPEN'
              AND AUTHENTICATION_TYPE='NONE'
              AND USERNAME NOT IN ('SYS','SYSTEM')""")
        r = cursor.fetchone()
        open_schema = safe_int(r[0]) if r else 0
    except Exception as e:
        print("Schema accounts query failed: %s" % str(e))
        open_schema = 0

    # Password verify function
    try:
        cursor.execute("SELECT LIMIT FROM DBA_PROFILES WHERE PROFILE='DEFAULT' AND RESOURCE_NAME='PASSWORD_VERIFY_FUNCTION'")
        r = cursor.fetchone()
        pwd_fn = str(r[0]) if r else "NULL"
    except Exception as e:
        print("Password profile query failed: %s" % str(e))
        pwd_fn = "UNKNOWN"

    # Audit trail
    try:
        cursor.execute("SELECT VALUE FROM V$PARAMETER WHERE NAME='audit_trail'")
        r = cursor.fetchone()
        audit = str(r[0]).upper() if r else "NONE"
    except Exception as e:
        print("Audit trail query failed: %s" % str(e))
        audit = "UNKNOWN"

    # DBA users
    try:
        cursor.execute("SELECT COUNT(DISTINCT GRANTEE) FROM DBA_SYS_PRIVS WHERE PRIVILEGE='DBA' AND GRANTEE NOT IN ('SYS','SYSTEM','DBA','SYSMAN')")
        r = cursor.fetchone()
        dba_count = safe_int(r[0]) if r else 0
    except Exception as e:
        print("DBA users query failed: %s" % str(e))
        dba_count = 0

    return {
        "default_pwd_accounts": def_pwd,
        "dangerous_public_grants": pub_privs,
        "open_schema_accounts": open_schema,
        "password_verify_function": pwd_fn,
        "password_policy_active": pwd_fn not in ("NULL", "null", "UNKNOWN", None),
        "audit_trail": audit,
        "audit_enabled": audit not in ("NONE", "UNKNOWN"),
        "dba_user_count": dba_count,
    }


def query_schema_stats(cursor):
    """Top segments, datafile status, sort and full-scan ratios."""
    EXCLUDED_OWNERS = "('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS')"

    # Top segments
    try:
        cursor.execute("""
            SELECT OWNER, SEGMENT_NAME, SEGMENT_TYPE, ROUND(SUM(BYTES)/1073741824, 2)
            FROM DBA_SEGMENTS
            WHERE OWNER NOT IN """ + EXCLUDED_OWNERS + """
            GROUP BY OWNER, SEGMENT_NAME, SEGMENT_TYPE
            ORDER BY 4 DESC
            FETCH FIRST 10 ROWS ONLY""")
        rows = cursor.fetchall() or []
        top_segs = [{"owner": r[0] or "", "segment_name": r[1] or "", "segment_type": r[2] or "", "size_gb": safe_float(r[3])} for r in rows]
    except Exception as e:
        print("Top segments query failed: %s" % str(e))
        top_segs = []

    # Problem datafiles
    try:
        cursor.execute("""
            SELECT COUNT(*), COUNT(CASE WHEN STATUS='OFFLINE' THEN 1 END)
            FROM DBA_DATA_FILES WHERE STATUS NOT IN ('AVAILABLE','ONLINE')""")
        r = cursor.fetchone() or (0, 0)
        problem_df = safe_int(r[0])
        offline_df = safe_int(r[1])
    except Exception as e:
        print("Datafile status query failed: %s" % str(e))
        problem_df, offline_df = 0, 0

    # Sort ratios from V$SYSSTAT
    try:
        cursor.execute("SELECT VALUE FROM V$SYSSTAT WHERE NAME='sorts (disk)'")
        r = cursor.fetchone()
        disk_sorts = safe_int(r[0]) if r else 0
        cursor.execute("SELECT VALUE FROM V$SYSSTAT WHERE NAME='sorts (memory)'")
        r = cursor.fetchone()
        mem_sorts = safe_int(r[0]) if r else 0
        total_sorts = disk_sorts + mem_sorts
        disk_sort_pct = round(disk_sorts / total_sorts * 100, 2) if total_sorts > 0 else 0.0
    except Exception as e:
        print("Sort stats query failed: %s" % str(e))
        disk_sorts, mem_sorts, disk_sort_pct = 0, 0, 0.0

    # Full table scan ratio
    try:
        cursor.execute("SELECT VALUE FROM V$SYSSTAT WHERE NAME='table scans (long tables)'")
        r = cursor.fetchone()
        long_scans = safe_int(r[0]) if r else 0
        cursor.execute("SELECT VALUE FROM V$SYSSTAT WHERE NAME='table fetch by rowid'")
        r = cursor.fetchone()
        index_lookups = safe_int(r[0]) if r else 0
        total_lookups = long_scans + index_lookups
        ft_pct = round(long_scans / total_lookups * 100, 2) if total_lookups > 0 else 0.0
    except Exception as e:
        print("FT scan stats query failed: %s" % str(e))
        long_scans, ft_pct = 0, 0.0

    return {
        "top_segments": top_segs,
        "problem_datafiles": problem_df,
        "offline_datafiles": offline_df,
        "disk_sort_pct": disk_sort_pct,
        "disk_sorts": disk_sorts,
        "mem_sorts": mem_sorts,
        "full_table_scan_pct": ft_pct,
        "long_scans": long_scans,
    }


# ============================================================
# Oracle Metrics Collection
# ============================================================

def _safe_query(name, fn, cursor, fallback):
    """Run a query function with error handling — returns (result, error_or_None)."""
    try:
        return fn(cursor), None
    except Exception as e:
        err_msg = str(e)
        print("Query %s failed (non-fatal): %s" % (name, err_msg))
        # Return fallback + error detail so callers know which queries failed
        return fallback, err_msg


def _detect_oracle_sids():
    """Detect Oracle SIDs using a three-tier strategy.

    Tier 1: /proc/*/comm — each PMON process has comm == 'ora_pmon_<SID>'.
            Strict regex ^ora_pmon_([A-Z0-9_]{1,30})$ applied so shell
            metacharacters, slashes, and garbage strings can never slip through.
            Falls back to pgrep if /proc is unreadable (containers, BSD).
    Tier 2: srvctl config database (Grid Infrastructure / RAC).
    Tier 3: /etc/oratab — fallback; may contain stale entries on repurposed servers.
    """
    # Tier 1: /proc/*/comm enumeration — canonical, no shell, no awk.
    # Oracle PMON names its process exactly ora_pmon_<INSTANCE_NAME> where
    # INSTANCE_NAME obeys Oracle SID rules: starts with letter, ≤30 chars,
    # alphanumeric + underscore only (in practice).
    # Strict regex ensures we never pass garbage to downstream shell calls.
    _SID_RE = re.compile(r'^ora_pmon_([A-Z0-9_]{1,30})$', re.IGNORECASE)

    def _pmon_sids_from_proc():
        sids = []
        try:
            for entry in os.scandir('/proc'):
                if not entry.is_dir():
                    continue
                comm_path = '/proc/%s/comm' % entry.name
                try:
                    with open(comm_path, 'r') as f:
                        comm = f.read().strip()
                except (OSError, IOError):
                    continue
                m = _SID_RE.match(comm)
                if m:
                    sid = m.group(1).upper()
                    if sid not in sids:
                        sids.append(sid)
        except (OSError, PermissionError):
            pass
        return sids

    def _pmon_sids_from_pgrep():
        # Fallback: pgrep -a -f when /proc is not enumerable (containers, BSD).
        # Same strict regex applied — pgrep output may include full argv.
        sids = []
        try:
            import subprocess as _sp
            result = _sp.run(
                ['pgrep', '-a', '-f', 'ora_pmon_'],
                stdout=_sp.PIPE, stderr=_sp.PIPE,
                universal_newlines=True, timeout=5,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    # line format: "<pid> ora_pmon_SID" or "<pid> .../ora_pmon_SID ..."
                    for token in line.split():
                        m = _SID_RE.search(token)
                        if m:
                            sid = m.group(1).upper()
                            if sid not in sids:
                                sids.append(sid)
        except Exception:
            pass
        return sids

    pmon_sids = _pmon_sids_from_proc()
    if not pmon_sids:
        pmon_sids = _pmon_sids_from_pgrep()
    if pmon_sids:
        return pmon_sids

    # Tier 2: srvctl (Grid Infrastructure)
    try:
        import subprocess, shutil
        srvctl_bin = shutil.which('srvctl')
        if not srvctl_bin:
            oracle_home = os.environ.get('ORACLE_HOME', '')
            candidate = os.path.join(oracle_home, 'bin', 'srvctl')
            if oracle_home and os.path.isfile(candidate):
                srvctl_bin = candidate
        if srvctl_bin:
            result = subprocess.run(
                [srvctl_bin, 'config', 'database'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                srvctl_sids = [s.strip() for s in result.stdout.splitlines() if s.strip()]
                if srvctl_sids:
                    return srvctl_sids
    except Exception:
        pass

    # Tier 3: /etc/oratab (fallback — may be stale)
    return _read_oratab_sids()


def _read_oratab_sids():
    """Read /etc/oratab and return list of SID names (non-comment, non-empty lines).

    Least reliable tier — oratab can contain stale entries from decommissioned
    databases on repurposed servers. Prefer _detect_oracle_sids() which checks
    running instances first.
    """
    sids = []
    try:
        with open('/etc/oratab', 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and not line.startswith('*'):
                    parts = line.split(':')
                    if parts[0]:
                        sids.append(parts[0])
    except Exception:
        pass
    return sids


def _detect_listener_endpoint():
    """Parse HOST and PORT from lsnrctl status output.

    Tries SID-named listener first (EBS: listener alias = SID name),
    then falls back to bare `lsnrctl status`.  Returns (host, port) tuple;
    either value may be None if parsing fails.
    """
    import subprocess as _sp, shutil as _sh, re as _re

    lsnr_bin = _sh.which("lsnrctl") or ""
    oh = os.environ.get("ORACLE_HOME", "")
    if not lsnr_bin and oh:
        cand = os.path.join(oh, "bin", "lsnrctl")
        if os.path.isfile(cand):
            lsnr_bin = cand
    if not lsnr_bin:
        return (None, None)

    lsnr_out = ""
    # Try SID-named listener first (EBS pattern)
    sids = _detect_oracle_sids()
    if sids:
        try:
            r = _sp.run([lsnr_bin, "status", sids[0]],
                        capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                lsnr_out = r.stdout
        except Exception:
            pass
    # Fall back to default listener
    if not lsnr_out or "no listener" in lsnr_out.lower():
        try:
            r = _sp.run([lsnr_bin, "status"],
                        capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                lsnr_out = r.stdout
        except Exception:
            pass

    host = None
    port = None
    if lsnr_out:
        m = _re.search(r'\(HOST=([^)]+)\)', lsnr_out)
        if m:
            host = m.group(1)
        m = _re.search(r'\(PORT=(\d+)\)', lsnr_out)
        if m:
            port = int(m.group(1))
    return (host, port)


def _discover_listener_services(host, port, cdb_sids=None):
    """Return non-XDB service names from lsnrctl services/status, excluding CDB SIDs.

    Uses lsnrctl services (preferred) for full per-instance registration data, then
    falls back to lsnrctl status.  Service classification:
      1. Blocked: CDB SID names, *XDB, PLSExtProc, SYS$*, 32-char hex GUIDs
      2. Blocked: *_ebs_patch services (ADOP fs_clone/patch-fs mode — transient,
         connecting to them hangs or returns ORA-12537 during patch cycle)
      3. Blocked via lsnrctl services: services whose only registered instance is
         not in the local PMON SID list (remote/stale registrations)
      4. Scored: lowercase ebs* (PDB EBS services) → 0; everything else → 1

    Returns list of candidate service_name strings, best candidate first.
    """
    import subprocess as _sp, shutil as _sh, re as _re
    lsnr_bin = _sh.which("lsnrctl") or ""
    oh = os.environ.get("ORACLE_HOME", "")
    if not lsnr_bin and oh:
        cand = os.path.join(oh, "bin", "lsnrctl")
        if os.path.isfile(cand):
            lsnr_bin = cand
    if not lsnr_bin:
        return []

    sids = cdb_sids or _detect_oracle_sids()
    cdb_sid_set = set(s.upper() for s in sids)

    # Try lsnrctl services first (gives per-instance registration blocks)
    lsnr_svc_out = ""
    lsnr_st_out = ""
    for _args in ([lsnr_bin, "services", sids[0]] if sids else [], [lsnr_bin, "services"]):
        if not _args:
            continue
        try:
            r = _sp.run(_args, capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and "no listener" not in r.stdout.lower() and "Service" in r.stdout:
                lsnr_svc_out = r.stdout
                break
        except Exception:
            pass

    # lsnrctl status fallback for service name list
    for _args in ([lsnr_bin, "status", sids[0]] if sids else [], [lsnr_bin, "status"]):
        if not _args:
            continue
        try:
            r = _sp.run(_args, capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and "no listener" not in r.stdout.lower():
                lsnr_st_out = r.stdout
                break
        except Exception:
            pass

    if not lsnr_svc_out and not lsnr_st_out:
        return []

    # Parse lsnrctl services blocks for per-instance data
    # Block format: Service "NAME" has N instance(s).\n  Instance "INST", status READY,...
    svc_instances = {}   # service_name -> set(instance_names_upper)
    current_svc = None
    for line in lsnr_svc_out.splitlines():
        m = _re.match(r'\s*Service "([^"]+)"', line)
        if m:
            current_svc = m.group(1)
            svc_instances.setdefault(current_svc, set())
        elif current_svc:
            m2 = _re.match(r'\s*Instance "([^"]+)"', line)
            if m2:
                svc_instances[current_svc].add(m2.group(1).upper())

    # Collect all service names from both outputs
    all_svc_names = set(_re.findall(r'Service "([^"]+)"', lsnr_svc_out))
    all_svc_names.update(_re.findall(r'Service "([^"]+)"', lsnr_st_out))

    services = []
    seen = set()
    for svc in sorted(all_svc_names):
        if svc in seen:
            continue
        seen.add(svc)
        up = svc.upper()
        # Block: CDB instance SIDs
        if up in cdb_sid_set:
            continue
        # Block: XDB (HTTP/XMLType endpoint — not for SQL)
        if up.endswith("XDB"):
            continue
        # Block: Oracle internal services
        if up in ("PLSEXTPROC", "EXTPROC1521"):
            continue
        if svc.startswith("SYS$"):
            continue
        # Block: 32-char hex GUIDs (Oracle internal identifiers)
        if _re.match(r'^[0-9a-f]{32}$', svc.lower()):
            continue
        # Block: ADOP patch-mode services (*_ebs_patch suffix).
        # These are transient patch-cycle services — blocked unconditionally.
        if _re.search(r'_ebs_patch$', svc, _re.IGNORECASE):
            continue
        # Block: services not registered with any local PMON instance
        # (only applies when lsnrctl services data is available)
        if svc_instances.get(svc) is not None:
            inst_set = svc_instances[svc]
            if inst_set and not any(
                i in cdb_sid_set or any(c.startswith(i) or i.startswith(c) for c in cdb_sid_set)
                for i in inst_set
            ):
                continue
        services.append(svc)

    # Score: ebs* (lowercase, no _ebs_patch) → 0 (best); everything else → 1
    def _score(s):
        sl = s.lower()
        if _re.match(r'^ebs[a-z0-9_]+$', sl) and not sl.endswith("_ebs_patch"):
            return 0
        return 1

    services.sort(key=_score)
    return services


def _probe_oracle_with_sid_fallback(host, port, cdb_sid, username, password, os_auth=False, timeout_s=8):
    """Try connecting to Oracle using CDB SID-style descriptor first.

    CDB instances register as dedicated-server SIDs in the listener, NOT as service
    names.  Using SERVICE_NAME=EBSDEVDB results in "no response from Oracle" because
    the listener accepts the TCP but Oracle waits for a matching service registration
    that never comes.

    Strategy:
      1. SID-style descriptor:  (CONNECT_DATA=(SID=<cdb_sid>))
      2. SERVICE_NAME with the cached ORACLE_PRIMARY_SERVICE env var (previous winner)
      3. Each service name from lsnrctl, in score order (ebs* first)

    Returns dict:
      { "ok": True, "descriptor": "SID=...", "method": "sid"|"service", "conn": <cx_Oracle.Connection> }
      or
      { "ok": False, "tried": [("descriptor", "error"), ...] }
    """
    import re as _re
    tried = []

    def _try_sid_descriptor(sid):
        """Build a (DESCRIPTION=...) that uses SID= instead of SERVICE_NAME=."""
        dsn = (
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={h})(PORT={p}))"
            "(CONNECT_DATA=(SID={s})))".format(h=host, p=port, s=sid)
        )
        if username and password:
            return cx_Oracle.connect(user=username, password=password, dsn=dsn)
        else:
            os.environ['ORACLE_SID'] = sid
            return cx_Oracle.connect("/", mode=cx_Oracle.SYSDBA)

    def _try_service_descriptor(svc):
        """Build a SERVICE_NAME descriptor (standard TNS)."""
        dsn = cx_Oracle.makedsn(host, port, service_name=svc)
        if username and password:
            return cx_Oracle.connect(user=username, password=password, dsn=dsn)
        else:
            os.environ['ORACLE_SID'] = svc
            return cx_Oracle.connect("/", mode=cx_Oracle.SYSDBA)

    # 1. SID-style connect (correct for CDB instances)
    if cdb_sid:
        try:
            conn = _try_sid_descriptor(cdb_sid)
            return {"ok": True, "descriptor": "SID=%s" % cdb_sid, "method": "sid", "conn": conn}
        except Exception as e:
            tried.append(("SID=%s" % cdb_sid, str(e)))

    # 2. Cached winning service from a previous probe (skip re-discovery loop).
    # ORACLE_SERVICE_NAME is the canonical key written by probe 5 / diagnose.
    # ORACLE_PRIMARY_SERVICE is the backward-compat alias — check both.
    cached_svc = os.environ.get("ORACLE_SERVICE_NAME", "") or os.environ.get("ORACLE_PRIMARY_SERVICE", "")
    if cached_svc and cached_svc != cdb_sid:
        try:
            conn = _try_service_descriptor(cached_svc)
            return {"ok": True, "descriptor": "SERVICE_NAME=%s (cached)" % cached_svc, "method": "service", "conn": conn}
        except Exception as e:
            tried.append(("SERVICE_NAME=%s (cached)" % cached_svc, str(e)))

    # 3. Iterate listener services — ebs* first, then rest
    detected_sids = _detect_oracle_sids()
    listener_svcs = _discover_listener_services(host, port, cdb_sids=detected_sids)
    for svc in listener_svcs:
        if svc == cdb_sid:
            continue  # already tried as SID above
        try:
            conn = _try_service_descriptor(svc)
            # Cache the winner so future probes skip the loop.
            # Set both ORACLE_SERVICE_NAME (canonical) and ORACLE_PRIMARY_SERVICE (compat).
            os.environ["ORACLE_SERVICE_NAME"] = svc
            os.environ["ORACLE_PRIMARY_SERVICE"] = svc
            return {"ok": True, "descriptor": "SERVICE_NAME=%s (autodetected from listener)" % svc, "method": "service", "conn": conn}
        except Exception as e:
            tried.append(("SERVICE_NAME=%s" % svc, str(e)))

    return {"ok": False, "tried": tried}


def _connect_oracle(host, port, service_name, username, password):
    """Connect to Oracle — uses OS auth (/ as sysdba) when credentials are empty."""
    if username and password:
        dsn = cx_Oracle.makedsn(host, port, service_name=service_name)
        return cx_Oracle.connect(user=username, password=password, dsn=dsn)
    else:
        # OS authentication: proxy runs on Oracle box as oracle user
        # Use ORACLE_SID env var or auto-detect from running instances
        sid = service_name
        if not sid:
            sids = _detect_oracle_sids()
            sid = sids[0] if sids else None
        if sid:
            os.environ['ORACLE_SID'] = sid
        return cx_Oracle.connect("/", mode=cx_Oracle.SYSDBA)


def collect_metrics(host, port, service_name, username, password):
    """Connect to Oracle and collect all health metrics."""
    conn = None
    query_errors = []
    try:
        conn = _connect_oracle(host, port, service_name, username, password)
        cursor = conn.cursor()

        instance_info, err = _safe_query("instance_info", query_instance_info, cursor, {})
        if err: query_errors.append({"query": "instance_info", "error": err})

        tablespaces, err = _safe_query("tablespaces", query_tablespaces, cursor, [])
        if err: query_errors.append({"query": "tablespaces", "error": err})

        wait_events, err = _safe_query("wait_events", query_wait_events, cursor, [])
        if err: query_errors.append({"query": "wait_events", "error": err})

        top_sql, err = _safe_query("top_sql", query_top_sql, cursor, [])
        if err: query_errors.append({"query": "top_sql", "error": err})

        index_analysis, err = _safe_query("index_analysis", query_index_analysis, cursor, [])
        if err: query_errors.append({"query": "index_analysis", "error": err})

        sga_stats, err = _safe_query("sga_stats", query_sga_stats, cursor, {})
        if err: query_errors.append({"query": "sga_stats", "error": err})

        pga_stats, err = _safe_query("pga_stats", query_pga_stats, cursor, {})
        if err: query_errors.append({"query": "pga_stats", "error": err})

        os_stats, err = _safe_query("os_stats", query_os_stats, cursor, {})
        if err: query_errors.append({"query": "os_stats", "error": err})

        # Wave A queries
        undo_stats, err = _safe_query("undo_stats", query_undo_stats, cursor, None)
        if err: query_errors.append({"query": "undo_stats", "error": err})

        temp_stats, err = _safe_query("temp_stats", query_temp_stats, cursor, None)
        if err: query_errors.append({"query": "temp_stats", "error": err})

        alert_log, err = _safe_query("alert_log", query_alert_log, cursor, None)
        if err: query_errors.append({"query": "alert_log", "error": err})

        resource_limits, err = _safe_query("resource_limits", query_resource_limits, cursor, None)
        if err: query_errors.append({"query": "resource_limits", "error": err})

        sga_pga_history, err = _safe_query("sga_pga_history", query_sga_pga_history, cursor, None)
        if err: query_errors.append({"query": "sga_pga_history", "error": err})

        # Wave B queries
        backup_stats, err = _safe_query("backup_stats", query_backup_stats, cursor, None)
        if err: query_errors.append({"query": "backup_stats", "error": err})

        # Wave E: EBS Apps Health (returns None for non-EBS databases)
        apps_health, err = _safe_query("apps_health", query_apps_health, cursor, None)
        if err: query_errors.append({"query": "apps_health", "error": err})

        # Bug 1: translate apps_health into the server-expected payload shape.
        # The server (server.js + oracle-client.js contract) requires:
        #   metrics.ebs_detected  — boolean
        #   metrics.ebs_operations — { concurrent_managers: { cm01, cm02 … }, workflow: … }
        # The proxy historically only emitted apps_health with a different structure.
        ebs_detected = bool(apps_health and apps_health.get('is_ebs'))
        ebs_probe_error = apps_health.get('ebs_probe_error') if apps_health else None
        ebs_operations = _build_ebs_operations_from_proxy(apps_health) if ebs_detected else None

        # Wave G: DB Objects, Sessions, Security, Schema Stats
        db_objects, err = _safe_query("db_objects", query_db_objects, cursor, {})
        if err: query_errors.append({"query": "db_objects", "error": err})

        session_stats, err = _safe_query("session_stats", query_session_stats, cursor, {})
        if err: query_errors.append({"query": "session_stats", "error": err})

        security_stats, err = _safe_query("security_stats", query_security_stats, cursor, {})
        if err: query_errors.append({"query": "security_stats", "error": err})

        schema_stats, err = _safe_query("schema_stats", query_schema_stats, cursor, {})
        if err: query_errors.append({"query": "schema_stats", "error": err})

        cursor.close()

        now = datetime.utcnow()
        twelve_hours_ago = now - timedelta(hours=12)

        result = {
            "instance": instance_info,
            "tablespaces": tablespaces,
            "wait_events": wait_events,
            "top_sql": top_sql,
            "index_analysis": index_analysis,
            "sga_stats": sga_stats,
            "pga_stats": pga_stats,
            "redo_stats": {
                "redo_size_mb_per_hour": 0,
                "log_switches_per_hour": 0,
                "log_file_size_mb": 0,
                "log_groups": 0,
                "avg_log_sync_ms": 0,
                "max_log_sync_ms": 0,
            },
            "os_stats": os_stats,
            "undo_stats": undo_stats,
            "temp_stats": temp_stats,
            "alert_log": alert_log,
            "resource_limits": resource_limits,
            "sga_pga_history": sga_pga_history,
            "backup_stats": backup_stats,
            # Bug 1: server-expected EBS keys
            "ebs_detected": ebs_detected,
            "ebs_operations": ebs_operations,
            # Raw proxy data (kept for diagnostics/backward compatibility)
            "apps_health": apps_health,
            "ebs_probe_error": ebs_probe_error,
            "db_objects": db_objects,
            "session_stats": session_stats,
            "security_stats": security_stats,
            "schema_stats": schema_stats,
            "proxy_version": VERSION,
            "snapshot_info": {
                "begin_snap_id": 0,
                "end_snap_id": 0,
                "begin_time": twelve_hours_ago.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "end_time": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "elapsed_time_min": 720,
                "db_time_min": 0,
            },
        }
        if query_errors:
            result["query_errors"] = query_errors
        return result
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def test_connection(host, port, service_name, username, password):
    """Quick connection test - returns version string."""
    conn = None
    try:
        conn = _connect_oracle(host, port, service_name, username, password)
        cursor = conn.cursor()
        cursor.execute("SELECT banner FROM v$version WHERE ROWNUM = 1")
        row = cursor.fetchone()
        version = row[0] if row else "Connected"
        cursor.close()
        return {"success": True, "message": "Connection successful", "version": version}
    except Exception as e:
        return {"success": False, "message": format_oracle_error(e)}
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


# ============================================================
# SSH Execution (v3.3.0+)
# ============================================================

def run_ssh_command(host, port, username, auth_method, password, private_key, command, timeout):
    """
    Execute a shell command on a remote host over SSH using paramiko.
    Returns dict: { success, stdout, stderr, exit_code, elapsed_ms }
    Never raises — errors are returned as success=False.
    """
    if not _PARAMIKO_AVAILABLE:
        return {
            "success": False,
            "stdout": "",
            "stderr": "paramiko library not installed. Run: pip3 install paramiko",
            "exit_code": -1,
            "elapsed_ms": 0,
        }

    started_ms = int(time.time() * 1000)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        connect_kwargs = {
            "hostname": host,
            "port": int(port),
            "username": username,
            "timeout": int(timeout),
            "banner_timeout": int(timeout),
            "auth_timeout": int(timeout),
        }
        if auth_method == "key":
            key_file = io.StringIO(private_key)
            # Try RSA first, then Ed25519, then DSS
            pkey = None
            for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.DSSKey, paramiko.ECDSAKey):
                try:
                    key_file.seek(0)
                    pkey = key_cls.from_private_key(key_file)
                    break
                except Exception:
                    continue
            if pkey is None:
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": "Could not parse private key (tried RSA, Ed25519, DSS, ECDSA)",
                    "exit_code": -1,
                    "elapsed_ms": int(time.time() * 1000) - started_ms,
                }
            connect_kwargs["pkey"] = pkey
        else:
            connect_kwargs["password"] = password or ""
            connect_kwargs["look_for_keys"] = False
            connect_kwargs["allow_agent"] = False

        client.connect(**connect_kwargs)
        stdin, stdout_fh, stderr_fh = client.exec_command(command, timeout=int(timeout))
        stdout_data = stdout_fh.read().decode("utf-8", errors="replace")
        stderr_data = stderr_fh.read().decode("utf-8", errors="replace")
        exit_code = stdout_fh.channel.recv_exit_status()
        elapsed = int(time.time() * 1000) - started_ms
        return {
            "success": exit_code == 0,
            "stdout": stdout_data,
            "stderr": stderr_data,
            "exit_code": exit_code,
            "elapsed_ms": elapsed,
        }
    except Exception as e:
        elapsed = int(time.time() * 1000) - started_ms
        return {
            "success": False,
            "stdout": "",
            "stderr": str(e),
            "exit_code": -1,
            "elapsed_ms": elapsed,
        }
    finally:
        try:
            client.close()
        except Exception:
            pass


# ============================================================
# HTTP Request Handler
# ============================================================

class ProxyHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the TuneVault Oracle Proxy."""

    # Suppress default logging
    def log_message(self, fmt, *args):
        timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        print("[%s] %s %s" % (timestamp, self.command, self.path))

    def send_json(self, status_code, data):
        """Send a JSON response."""
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Powered-By", "TuneVault-Proxy")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        """Read the request body."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            return self.rfile.read(content_length).decode("utf-8")
        return "{}"

    def check_auth(self):
        """Check API key authentication. Returns True if authorized.
        Accepts any key in VALID_KEYS via X-Api-Key or Authorization: Bearer headers.
        Uses constant-time compare to prevent timing attacks.
        """
        import hmac
        api_key = ""
        received_header = "none"
        # Check X-Api-Key first (case-insensitive header lookup via BaseHTTPRequestHandler)
        xak = self.headers.get("X-Api-Key", "")
        if xak:
            api_key = xak.strip()
            received_header = "X-Api-Key"
        else:
            auth_header = self.headers.get("Authorization", "")
            if auth_header.lower().startswith("bearer "):
                api_key = auth_header[7:].strip()
                received_header = "Authorization"
        # Constant-time compare against all valid keys
        matched = any(
            hmac.compare_digest(api_key.encode(), vk.encode())
            for vk in VALID_KEYS
        ) if api_key else False
        if not matched:
            prefix = api_key[:8] if api_key else ""
            self.send_json(401, {
                "error": "unauthorized",
                "received_header": received_header,
                "received_prefix": prefix,
            })
            return False
        return True

    def do_GET(self):
        """Handle GET requests."""
        # Health ping - no auth required
        if self.path == "/health" or self.path == "/api/health":
            self.send_json(200, {
                "status": "healthy",
                "proxy": "TuneVault Oracle Proxy",
                "version": VERSION,
                "runtime": "python",
            })
            return

        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        """Handle POST requests."""
        # POST /api/healthcheck - run Oracle health queries
        if self.path == "/api/healthcheck":
            if not self.check_auth():
                return
            if _ORACLE_DRIVER is None and _SERVER_TYPE == "apps":
                self.send_json(200, {
                    "success": False,
                    "error": "App server — Oracle DB health checks run on the DB server connection. This server monitors EBS app tier only.",
                })
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                service_name = params.get("service_name", "")
                username = params.get("username", "")
                password = params.get("password", "")
                host = _resolve_db_host(params)
                port = int(params.get("port", 1521))
                os_auth = params.get("os_auth", False)

                # OS auth mode: proxy uses / as sysdba — no credentials needed
                if not os_auth and (not service_name or not username or not password):
                    self.send_json(400, {
                        "error": "service_name, username, and password are required (or set os_auth=true)"
                    })
                    return

                # Auto-detect SID from running instances (PMON → srvctl → oratab)
                if not service_name and os_auth:
                    sids = _detect_oracle_sids()
                    service_name = sids[0] if sids else ""

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                auth_mode = "os_auth" if os_auth else username
                print("[%s] Health check: %s@%s:%d/%s" % (
                    timestamp, auth_mode, host, port, service_name))

                metrics = collect_metrics(host, port, service_name, username, password)
                # Include discovered connection info so the server can persist it
                metrics["_discovered"] = {
                    "host": host,
                    "port": port,
                    "service_name": service_name,
                    "auth_mode": "os_auth" if os_auth else "credentials"
                }
                self.send_json(200, {"success": True, "metrics": metrics})
            except Exception as e:
                print("Health check failed: %s" % str(e))
                traceback.print_exc()
                self.send_json(500, {
                    "success": False,
                    "error": format_oracle_error(e),
                })
            return

        # POST /api/test — RETIRED (direct-connect testing path removed in v3.5.7)
        # Architecture rule: all proxy testing goes through the outbound long-poll channel
        # or the local CLI. No inbound direct-connect endpoints.
        if self.path == "/api/test":
            self.send_json(410, {
                "error": "Gone — /api/test was the legacy direct-connect testing path and has been retired.",
                "replacement": {
                    "on_proxy_host": "sudo tunevault-proxy diagnose",
                    "in_product": "https://tunevault.app/connections/:id → Run Diagnostics",
                },
                "architecture_doc": "https://tunevault.app/docs/architecture#outbound-long-poll",
            })
            return

        # POST /api/ping - lightweight smoke test (no catalog access)
        # Returns: agent_version, oracle_home, hostname, detected_sids,
        #          oracle_listener_up, sample_query_ms
        if self.path == "/api/ping":
            if not self.check_auth():
                return
            import time as _time
            import socket as _socket
            t_start = _time.time()
            hostname = _socket.gethostname()
            oracle_home = os.environ.get('ORACLE_HOME', '')
            detected_sids = _detect_oracle_sids()

            # Try a SELECT 1 FROM DUAL via the first available SID
            sample_query_ms = None
            oracle_listener_up = False
            try:
                body = self.read_body()
                params = json.loads(body) if body else {}
                service_name = params.get("service_name", "")
                username = params.get("username", "")
                password = params.get("password", "")
                host = _resolve_db_host(params)
                port = int(params.get("port", 1521))
                os_auth = params.get("os_auth", False)

                # Use first detected SID if none supplied
                if not service_name and detected_sids:
                    service_name = detected_sids[0]

                if service_name and (os_auth or (username and password)):
                    q_start = _time.time()
                    conn = _connect_oracle(host, port, service_name, username, password)
                    cur = conn.cursor()
                    cur.execute("SELECT 1 FROM DUAL")
                    cur.fetchone()
                    cur.close()
                    conn.close()
                    sample_query_ms = round((_time.time() - q_start) * 1000)
                    oracle_listener_up = True
            except Exception:
                oracle_listener_up = False

            roundtrip_ms = round((_time.time() - t_start) * 1000)
            self.send_json(200, {
                "ok": True,
                "agent_version": VERSION,
                "oracle_home": oracle_home,
                "hostname": hostname,
                "detected_sids": detected_sids,
                "oracle_listener_up": oracle_listener_up,
                "sample_query_ms": sample_query_ms,
                "roundtrip_ms": roundtrip_ms,
            })
            return

        # POST /api/detect-sids — CDB/PDB SID re-detection (used by Re-detect SIDs button).
        # Returns: { cdb_sids: [...], pdb_services: [...] }
        # cdb_sids: running instance names from PMON (via _detect_oracle_sids)
        # pdb_services: listener service names excluding known CDB SIDs and XDB/PLSExtProc
        if self.path == "/api/detect-sids":
            if not self.check_auth():
                return
            import subprocess as _sp, shutil as _sh
            cdb_sids = _detect_oracle_sids()
            pdb_services = []
            try:
                lsnr_bin = _sh.which("lsnrctl") or ""
                oh = os.environ.get("ORACLE_HOME", "")
                if not lsnr_bin and oh:
                    cand = os.path.join(oh, "bin", "lsnrctl")
                    if os.path.isfile(cand):
                        lsnr_bin = cand
                if lsnr_bin:
                    out = _sp.run([lsnr_bin, "status"], capture_output=True, text=True, timeout=10)
                    if out.returncode == 0:
                        import re as _re
                        seen = set()
                        for svc in _re.findall(r'Service "([^"]+)"', out.stdout):
                            # Skip CDB instance SIDs and well-known Oracle internal services
                            if svc in cdb_sids:
                                continue
                            if svc in seen:
                                continue
                            if svc.endswith("XDB") or svc.upper() in ("PLSEXTPROC",):
                                continue
                            if svc.startswith("SYS$"):
                                continue
                            seen.add(svc)
                            pdb_services.append(svc)
            except Exception:
                pass
            self.send_json(200, {"ok": True, "cdb_sids": cdb_sids, "pdb_services": pdb_services})
            return

        # POST /api/run-diagnostics — 7-probe end-to-end diagnostic check.
        # Matches the installer self-test sequence so results are directly comparable.
        # Returns: { probes: [{id, name, status, detail, fix}], passed, total, ran_at }
        if self.path == "/api/run-diagnostics":
            if not self.check_auth():
                return
            import time as _time
            import socket as _socket

            try:
                body = self.read_body()
                params = json.loads(body) if body else {}
                service_name   = params.get("service_name", "")
                username       = params.get("username", "")
                password       = params.get("password", "")
                # Auto-detect host/port from lsnrctl when UI doesn't provide them,
                # instead of blindly defaulting to localhost:1521.
                _req_host      = params.get("host", "")
                _req_port      = params.get("port", "")
                if not _req_host or not _req_port:
                    _det_h, _det_p = _detect_listener_endpoint()
                    if not _req_host:
                        _req_host = _det_h or os.environ.get("ORACLE_HOST", "") or "localhost"
                    if not _req_port:
                        _req_port = _det_p or int(os.environ.get("ORACLE_PORT", "0")) or 1521
                host           = _req_host
                port           = int(_req_port)
                os_auth        = params.get("os_auth", False)
                bastion_host   = params.get("bastion_host", "")
                bastion_port   = int(params.get("bastion_port", 22))
                bastion_user   = params.get("bastion_user", "")
                bastion_key    = params.get("bastion_key", "")
                has_bastion    = bool(bastion_host and bastion_user)
            except Exception as e:
                self.send_json(400, {"error": "invalid request body: %s" % str(e)})
                return

            probes = []
            tns_ok = False
            # Set by probe 3 — tracks which connect method won so probes 4/5/6 can reuse it.
            # "sid" = SID-style descriptor; "service" = SERVICE_NAME descriptor.
            _probe3_method = "service"
            _probe3_sid_value = ""   # the SID or SERVICE_NAME that worked

            # ── Probe 1: Agent online ─────────────────────────────────────────
            # If we're executing this handler, the agent is running and reachable.
            probes.append({
                "id": 1, "name": "Agent online",
                "status": "pass",
                "detail": "Agent v%s reachable — heartbeat active" % VERSION,
                "fix": None,
            })

            # ── Probe 2: SSH bastion hop ──────────────────────────────────────
            if has_bastion:
                try:
                    result = run_ssh_command(
                        bastion_host, bastion_port, bastion_user,
                        "key" if bastion_key else "password",
                        "", bastion_key,
                        "exit 0", 10
                    )
                    if result.get("exit_code", -1) == 0:
                        probes.append({
                            "id": 2, "name": "SSH bastion hop",
                            "status": "pass",
                            "detail": "SSH bastion %s reachable (exit 0)" % bastion_host,
                            "fix": None,
                        })
                    else:
                        probes.append({
                            "id": 2, "name": "SSH bastion hop",
                            "status": "fail",
                            "detail": result.get("stderr", "non-zero exit"),
                            "fix": "Verify SSH key in /etc/tunevault/ssh_key and bastion firewall rules.",
                        })
                except Exception as e:
                    probes.append({
                        "id": 2, "name": "SSH bastion hop",
                        "status": "fail",
                        "detail": str(e),
                        "fix": "Verify SSH key in /etc/tunevault/ssh_key and bastion firewall rules.",
                    })
            else:
                probes.append({
                    "id": 2, "name": "SSH bastion hop",
                    "status": "skip",
                    "detail": "No bastion configured for this connection.",
                    "fix": None,
                })

            # ── Probe 3: TNS listener responds ───────────────────────────────
            # CDB instances (e.g. EBSDEVDB) register in the listener as a dedicated-server
            # SID, NOT as a SERVICE_NAME.  Using makedsn(service_name=SID) causes the
            # listener to accept TCP but Oracle to wait forever → "no response from Oracle".
            # Fix: try SID-style descriptor first; fall back to scored listener service names.
            detected_sids = _detect_oracle_sids()
            # Explicit service_name from caller overrides auto-detect; used as SID candidate.
            cdb_sid_candidate = service_name or (detected_sids[0] if detected_sids else "")
            sid_for_test = ""   # will hold the winning identifier for downstream probes
            winning_descriptor = ""

            if cdb_sid_candidate or detected_sids:
                t0 = _time.time()
                result3 = _probe_oracle_with_sid_fallback(
                    host, port,
                    cdb_sid=cdb_sid_candidate,
                    username=username, password=password,
                    os_auth=os_auth,
                )
                elapsed = round((_time.time() - t0) * 1000)
                if result3["ok"]:
                    try:
                        result3["conn"].close()
                    except Exception:
                        pass
                    winning_descriptor = result3["descriptor"]
                    _probe3_method = result3["method"]
                    # Capture just the identifier part for downstream probes
                    if result3["method"] == "sid":
                        sid_for_test = cdb_sid_candidate
                        _probe3_sid_value = cdb_sid_candidate
                    else:
                        # Extract SERVICE_NAME value from descriptor string for downstream use
                        import re as _re3
                        _m = _re3.search(r'SERVICE_NAME=([^\s(]+)', winning_descriptor)
                        sid_for_test = _m.group(1).split()[0] if _m else cdb_sid_candidate
                        _probe3_sid_value = sid_for_test
                    tns_ok = True
                    probes.append({
                        "id": 3, "name": "TNS listener responds",
                        "status": "pass",
                        "detail": "Connected via %s in %dms" % (winning_descriptor, elapsed),
                        "fix": None,
                    })
                else:
                    tried_summary = "; ".join(
                        "%s → %s" % (d, e[:80]) for d, e in result3["tried"]
                    )
                    probes.append({
                        "id": 3, "name": "TNS listener responds",
                        "status": "fail",
                        "detail": "All connect paths failed. Tried: %s" % (tried_summary or "none"),
                        "fix": "Check listener: `lsnrctl status`. Verify ORACLE_SID, host, and port.",
                    })
            else:
                probes.append({
                    "id": 3, "name": "TNS listener responds",
                    "status": "skip",
                    "detail": "No service name — auto-detect found no SIDs.",
                    "fix": "Set service_name or ensure Oracle is running.",
                })

            # Local helper that reuses the winning connect method from probe 3.
            # When probe 3 succeeded via SID-syntax, SERVICE_NAME= would fail again
            # (the root cause of the EBSDEVDB bug), so we must honour _probe3_method.
            def _connect_for_probe():
                if _probe3_method == "sid":
                    dsn = (
                        "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={h})(PORT={p}))"
                        "(CONNECT_DATA=(SID={s})))".format(h=host, p=port, s=_probe3_sid_value)
                    )
                    if username and password:
                        return cx_Oracle.connect(user=username, password=password, dsn=dsn)
                    else:
                        os.environ['ORACLE_SID'] = _probe3_sid_value
                        return cx_Oracle.connect("/", mode=cx_Oracle.SYSDBA)
                else:
                    return _connect_oracle(host, port, sid_for_test, username, password)

            # ── Probe 4: Auth + SELECT_CATALOG_ROLE ──────────────────────────
            if tns_ok and username:
                try:
                    conn4 = _connect_for_probe()
                    cur4  = conn4.cursor()
                    cur4.execute(
                        "SELECT granted_role FROM dba_role_privs "
                        "WHERE grantee = USER AND granted_role = 'SELECT_CATALOG_ROLE'"
                    )
                    row = cur4.fetchone()
                    cur4.close()
                    conn4.close()
                    if row:
                        probes.append({
                            "id": 4, "name": "Auth + SELECT_CATALOG_ROLE",
                            "status": "pass",
                            "detail": "User %s authenticated; SELECT_CATALOG_ROLE confirmed." % username,
                            "fix": None,
                        })
                    else:
                        probes.append({
                            "id": 4, "name": "Auth + SELECT_CATALOG_ROLE",
                            "status": "fail",
                            "detail": "SELECT_CATALOG_ROLE not granted to %s." % username,
                            "fix": "GRANT SELECT_CATALOG_ROLE TO %s;" % username,
                        })
                except Exception as e:
                    probes.append({
                        "id": 4, "name": "Auth + SELECT_CATALOG_ROLE",
                        "status": "fail",
                        "detail": str(e),
                        "fix": "Check credentials and ensure the user exists.",
                    })
            else:
                skip_reason = "TNS probe failed — cannot test auth." if not tns_ok else "No username — skipping role check."
                probes.append({
                    "id": 4, "name": "Auth + SELECT_CATALOG_ROLE",
                    "status": "skip",
                    "detail": skip_reason,
                    "fix": None,
                })

            # ── Probe 5: SELECT 1 FROM DUAL × 3, median latency ──────────────
            if tns_ok and (os_auth or (username and password)):
                latencies = []
                probe5_ok = True
                probe5_err = ""
                for _ in range(3):
                    try:
                        conn5 = _connect_for_probe()
                        cur5  = conn5.cursor()
                        t0    = _time.time()
                        cur5.execute("SELECT 1 FROM DUAL")
                        cur5.fetchone()
                        latencies.append(round((_time.time() - t0) * 1000))
                        cur5.close()
                        conn5.close()
                    except Exception as e:
                        probe5_ok = False
                        probe5_err = str(e)
                        break

                if probe5_ok and latencies:
                    latencies.sort()
                    median = latencies[len(latencies) // 2]
                    status5 = "pass" if median <= 5000 else "fail"
                    detail5 = "SELECT 1 FROM DUAL ×3 via %s — median %dms (latencies: %s)" % (
                        winning_descriptor or _probe3_method,
                        median, ", ".join("%dms" % x for x in latencies))
                    fix5 = None if status5 == "pass" else "Median latency >5s — check DB load and network."
                    probes.append({
                        "id": 5, "name": "Sample query latency",
                        "status": status5, "detail": detail5, "fix": fix5,
                    })
                else:
                    probes.append({
                        "id": 5, "name": "Sample query latency",
                        "status": "fail",
                        "detail": probe5_err or "All 3 queries failed",
                        "fix": "Check DB connectivity and credentials.",
                    })
            else:
                probes.append({
                    "id": 5, "name": "Sample query latency",
                    "status": "skip",
                    "detail": "TNS probe failed or no credentials — skipping.",
                    "fix": None,
                })

            # ── Probe 6: End-to-end — v$instance row fetch ───────────────────
            if tns_ok and (os_auth or (username and password)):
                try:
                    conn6 = _connect_for_probe()
                    cur6  = conn6.cursor()
                    t0    = _time.time()
                    cur6.execute("SELECT instance_name, status, version FROM v$instance")
                    row6 = cur6.fetchone()
                    elapsed6 = round((_time.time() - t0) * 1000)
                    cur6.close()
                    conn6.close()
                    if row6:
                        inst_name, inst_status, inst_ver = row6[0], row6[1], row6[2]
                        probes.append({
                            "id": 6, "name": "End-to-end health check",
                            "status": "pass",
                            "detail": "v$instance: %s status=%s ver=%s (%dms)" % (
                                inst_name, inst_status, inst_ver, elapsed6),
                            "fix": None,
                        })
                    else:
                        probes.append({
                            "id": 6, "name": "End-to-end health check",
                            "status": "fail",
                            "detail": "v$instance returned no rows",
                            "fix": "Check database open mode and user SELECT ANY DICTIONARY privilege.",
                        })
                except Exception as e:
                    probes.append({
                        "id": 6, "name": "End-to-end health check",
                        "status": "fail",
                        "detail": str(e),
                        "fix": "Check v$instance access: GRANT SELECT ON v_$instance TO %s;" % (username or "your_user"),
                    })
            else:
                probes.append({
                    "id": 6, "name": "End-to-end health check",
                    "status": "skip",
                    "detail": "Probe 3 (TNS) failed — skipping end-to-end check.",
                    "fix": None,
                })

            # ── Probe 7: Proxy version current (stale proxy detection) ──────
            # Checks whether this proxy has retired /api/test (v3.5.7+).
            # PASS = 410 Gone. FAIL = 200 (legacy endpoint still active).
            try:
                import urllib.request as _ureq
                import urllib.error as _uerr
                _req = _ureq.Request(
                    "http://127.0.0.1:%d/api/test" % int(os.environ.get("PROXY_PORT", "3100")),
                    data=b"{}",
                    headers={"X-Api-Key": "dummy", "Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    _resp = _ureq.urlopen(_req, timeout=5)
                    _code = _resp.getcode()
                except _uerr.HTTPError as _he:
                    _code = _he.code
                except Exception:
                    _code = 0

                if _code == 410:
                    probes.append({
                        "id": 7, "name": "Proxy version current",
                        "status": "pass",
                        "detail": "Proxy v3.5.7+ confirmed: /api/test → 410 Gone",
                        "fix": None,
                    })
                elif _code == 200:
                    probes.append({
                        "id": 7, "name": "Proxy version current",
                        "status": "fail",
                        "detail": "Stale proxy: /api/test returned 200 (legacy endpoint still active)",
                        "fix": "Stale proxy detected. Run: sudo tunevault-proxy upgrade",
                    })
                else:
                    probes.append({
                        "id": 7, "name": "Proxy version current",
                        "status": "fail",
                        "detail": "Proxy not responding to version probe (http_code=%s)" % (_code or "timeout"),
                        "fix": "Proxy not responding to version probe — check tunevault-agent.service",
                    })
            except Exception as _e7:
                probes.append({
                    "id": 7, "name": "Proxy version current",
                    "status": "fail",
                    "detail": "Version probe error: %s" % str(_e7),
                    "fix": "Proxy not responding to version probe — check tunevault-agent.service",
                })

            passed = sum(1 for p in probes if p["status"] == "pass")
            total  = len(probes)
            ran_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")

            self.send_json(200, {
                "ok": True,
                "probes": probes,
                "passed": passed,
                "total": total,
                "ran_at": ran_at,
            })
            return

        # POST /api/addm - on-demand ADDM findings (EE + Diagnostics Pack)
        if self.path == "/api/addm":
            if not self.check_auth():
                return
            if _ORACLE_DRIVER is None and _SERVER_TYPE == "apps":
                self.send_json(200, {"success": False, "error": "App server — Oracle DB health checks run on the DB server connection. This server monitors EBS app tier only."})
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                service_name = params.get("service_name", "")
                username = params.get("username", "")
                password = params.get("password", "")
                host = _resolve_db_host(params)
                port = int(params.get("port", 1521))
                lookback_hours = min(int(params.get("lookback_hours", 24)), 168)

                if not service_name or not username or not password:
                    self.send_json(400, {
                        "error": "service_name, username, and password are required"
                    })
                    return

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] ADDM query: %s@%s:%d/%s (%dh)" % (
                    timestamp, username, host, port, service_name, lookback_hours))

                result = query_addm_findings(host, port, service_name, username, password, lookback_hours)
                self.send_json(200, {"success": True, "result": result})
            except Exception as e:
                print("ADDM query failed: %s" % str(e))
                traceback.print_exc()
                self.send_json(500, {
                    "success": False,
                    "error": format_oracle_error(e),
                })
            return

        # POST /api/maintenance - auto-maintenance window status (all editions)
        if self.path == "/api/maintenance":
            if not self.check_auth():
                return
            if _ORACLE_DRIVER is None and _SERVER_TYPE == "apps":
                self.send_json(200, {"success": False, "error": "App server — Oracle DB health checks run on the DB server connection. This server monitors EBS app tier only."})
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                service_name = params.get("service_name", "")
                username = params.get("username", "")
                password = params.get("password", "")
                host = _resolve_db_host(params)
                port = int(params.get("port", 1521))

                if not service_name or not username or not password:
                    self.send_json(400, {
                        "error": "service_name, username, and password are required"
                    })
                    return

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] Maintenance query: %s@%s:%d/%s" % (
                    timestamp, username, host, port, service_name))

                result = query_maintenance_windows(host, port, service_name, username, password)
                self.send_json(200, {"success": True, "result": result})
            except Exception as e:
                print("Maintenance query failed: %s" % str(e))
                traceback.print_exc()
                self.send_json(500, {
                    "success": False,
                    "error": format_oracle_error(e),
                })
            return

        # POST /api/ebs-probe — Lightweight EBS detection + Concurrent Manager status + recent
        # concurrent requests (last 1h). Used by the smoke test EBS steps.
        # Does NOT require full healthcheck run — three targeted queries only.
        # Returns: { ebs_detected, concurrent_managers, recent_requests, error? }
        if self.path == "/api/ebs-probe":
            if not self.check_auth():
                return
            if _ORACLE_DRIVER is None and _SERVER_TYPE == "apps":
                self.send_json(200, {"success": False, "error": "App server — Oracle DB health checks run on the DB server connection. This server monitors EBS app tier only."})
                return
            try:
                body = self.read_body()
                params = json.loads(body) if body else {}
                service_name = params.get("service_name", "")
                username     = params.get("username", "")
                password     = params.get("password", "")
                host         = _resolve_db_host(params)
                port         = int(params.get("port", 1521))
                os_auth      = params.get("os_auth", False)

                if not os_auth and (not service_name or not username or not password):
                    self.send_json(400, {
                        "error": "service_name, username, and password are required (or set os_auth=true)"
                    })
                    return

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] EBS probe: %s@%s:%d/%s" % (
                    timestamp, username or "os_auth", host, port, service_name))

                conn = _connect_oracle(host, port, service_name, username, password)
                cursor = conn.cursor()

                # Step 1: APPS.DUAL detection
                ebs_detected = False
                try:
                    cursor.execute("SELECT 1 FROM APPS.DUAL")
                    cursor.fetchone()
                    ebs_detected = True
                except Exception:
                    ebs_detected = False

                concurrent_managers = []
                recent_requests = []

                if ebs_detected:
                    # Step 2: Concurrent Manager status (FND_CONCURRENT_QUEUES)
                    try:
                        cursor.execute("""
                            SELECT q.CONCURRENT_QUEUE_NAME,
                                   q.MAX_PROCESSES,
                                   q.RUNNING_PROCESSES,
                                   NVL(q.CONTROL_CODE, 'X') AS CTRL_CODE,
                                   TO_CHAR(q.LAST_UPDATE_DATE, 'YYYY-MM-DD HH24:MI:SS') AS LAST_UPD
                            FROM APPS.FND_CONCURRENT_QUEUES_VL q
                            WHERE q.ENABLED_FLAG = 'Y'
                              AND q.MAX_PROCESSES > 0
                            ORDER BY
                                CASE q.CONCURRENT_QUEUE_NAME
                                    WHEN 'FNDCPOAM' THEN 1
                                    ELSE 2
                                END,
                                q.RUNNING_PROCESSES DESC
                            FETCH FIRST 20 ROWS ONLY
                        """)
                        rows = cursor.fetchall()
                        for r in rows:
                            name = str(r[0] or "")
                            max_procs = int(r[1] or 0)
                            running = int(r[2] or 0)
                            ctrl_code = str(r[3] or "X")
                            last_upd = str(r[4] or "")
                            # A=Active/Normal, D=Deactivate, X=Down/No control
                            status = "active" if ctrl_code in ("A", " ") else "stopped"
                            concurrent_managers.append({
                                "name": name,
                                "max_processes": max_procs,
                                "running_processes": running,
                                "control_code": ctrl_code,
                                "status": status,
                                "last_update": last_upd,
                            })
                    except Exception as cm_err:
                        concurrent_managers = [{"error": str(cm_err)}]

                    # Step 3: Recent concurrent requests (last 1 hour) — EBS Ops path verification
                    try:
                        cursor.execute("""
                            SELECT r.REQUEST_ID,
                                   r.CONCURRENT_PROGRAM_ID,
                                   r.PHASE_CODE,
                                   r.STATUS_CODE,
                                   TO_CHAR(r.REQUESTED_START_DATE, 'HH24:MI:SS') AS REQ_TIME
                            FROM APPS.FND_CONCURRENT_REQUESTS r
                            WHERE r.REQUESTED_START_DATE >= SYSDATE - (1/24)
                            ORDER BY r.REQUEST_ID DESC
                            FETCH FIRST 10 ROWS ONLY
                        """)
                        rows = cursor.fetchall()
                        for r in rows:
                            recent_requests.append({
                                "request_id": int(r[0] or 0),
                                "program_id": int(r[1] or 0),
                                "phase": str(r[2] or ""),
                                "status": str(r[3] or ""),
                                "requested_at": str(r[4] or ""),
                            })
                    except Exception as req_err:
                        recent_requests = [{"error": str(req_err)}]

                try:
                    cursor.close()
                    conn.close()
                except Exception:
                    pass

                self.send_json(200, {
                    "success": True,
                    "ebs_detected": ebs_detected,
                    "concurrent_managers": concurrent_managers,
                    "recent_requests": recent_requests,
                })
            except Exception as e:
                print("EBS probe failed: %s" % str(e))
                traceback.print_exc()
                self.send_json(500, {
                    "success": False,
                    "error": format_oracle_error(e),
                })
            return

        # POST /api/parameters — Oracle init parameters with recommended values (all editions)
        if self.path == "/api/parameters":
            if not self.check_auth():
                return
            if _ORACLE_DRIVER is None and _SERVER_TYPE == "apps":
                self.send_json(200, {"success": False, "error": "App server — Oracle DB health checks run on the DB server connection. This server monitors EBS app tier only."})
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                service_name = params.get("service_name", "")
                username     = params.get("username", "")
                password     = params.get("password", "")
                host         = _resolve_db_host(params)
                port         = int(params.get("port", 1521))

                if not service_name or not username or not password:
                    self.send_json(400, {"error": "service_name, username, and password are required"})
                    return

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] Parameters query: %s@%s:%d/%s" % (timestamp, username, host, port, service_name))

                result = query_parameters(host, port, service_name, username, password)
                self.send_json(200, {"success": True, "result": result})
            except Exception as e:
                print("Parameters query failed: %s" % str(e))
                traceback.print_exc()
                self.send_json(500, {"success": False, "error": format_oracle_error(e)})
            return

        # POST /api/ebs-app-healthcheck — aggregated EBS app-tier health check.
        # Only runs when SERVER_TYPE=apps. Returns structured findings + score.
        # All checks source EBSapps.env (from APPS_ENV_FILE in agent.env) so that
        # $ADMIN_SCRIPTS_HOME and $CONTEXT_FILE are available to each command.
        if self.path == "/api/ebs-app-healthcheck":
            if not self.check_auth():
                return
            if _SERVER_TYPE != "apps":
                self.send_json(200, {
                    "success": False,
                    "error": "This endpoint is only available on EBS application servers "
                             "(SERVER_TYPE=apps). Run /api/healthcheck on the DB server connection instead.",
                })
                return

            # Read passwords from request body — server sends them per HC so they
            # don't need to live in agent.env on disk.
            try:
                _body = self.read_body()
                _params = json.loads(_body) if _body else {}
            except Exception:
                _params = {}
            # Fall back to agent.env values for backward compat / installs where passwords
            # were set during install.sh prompts rather than via the Edit Connection form.
            req_apps_pwd     = _params.get("apps_pwd", "") or _APPS_PWD
            req_weblogic_pwd = _params.get("weblogic_pwd", "") or _WEBLOGIC_PWD
            print("[HC] weblogic_pwd present: %s, apps_pwd present: %s"
                  % (bool(req_weblogic_pwd), bool(req_apps_pwd)))

            timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
            print("[%s] EBS app-tier health check" % timestamp)

            findings  = []
            checks_ok = []

            def _finding(check_id, title, severity, details, raw=""):
                findings.append({
                    "check_id": check_id,
                    "title":    title,
                    "severity": severity,
                    "details":  details,
                    "raw_output": raw[:2000] if raw else "",
                })

            def _ok(check_id, title, details, raw=""):
                checks_ok.append({"check_id": check_id, "title": title,
                                   "status": "ok", "details": details,
                                   "raw_output": raw[:2000] if raw else ""})

            env_file = _APPS_ENV_FILE

            def _src_cmd(cmd):
                """Source EBSapps.env (stdout+stderr suppressed) then run cmd."""
                if not env_file:
                    return cmd
                _ef = env_file.replace("'", "'\\''")
                return "source '%s' run >/dev/null 2>&1; %s" % (_ef, cmd)

            def _run(cmd, timeout=15):
                return run_os_command(["bash", "-c", cmd], timeout=timeout)

            no_env_msg = ("APPS_ENV_FILE not configured — reinstall agent with context file path "
                          "so EBSapps.env can be sourced for this check.")

            # Pre-extract EBS DB service name once; reused by CM / WF-mailer / invalid-objects queries.
            # Use permissive grep so different context-file attribute names all resolve.
            _ebs_svc = ""
            if env_file and _EBS_DB_HOST:
                _sv_out, _, _, _ = _run(_src_cmd(
                    "grep -i 's_dbSid\\|s_systemname\\|s_db_sid' \"$CONTEXT_FILE\" 2>/dev/null "
                    "| sed 's/.*>\\([^<]*\\)<.*/\\1/' "
                    "| grep -v '^[[:space:]]*$' | head -1"
                ))
                _ebs_svc = _sv_out.strip()
            print("[HC] _ebs_svc: %r" % _ebs_svc)

            # ── 1. Apache / OHS status ────────────────────────────────────────
            if not env_file:
                _finding("apache_status", "Apache/OHS Status", "warning", no_env_msg)
            else:
                cmd = _src_cmd("$ADMIN_SCRIPTS_HOME/adapcctl.sh status")
                stdout, stderr, exit_code, _ = _run(cmd)
                out = stdout + stderr
                if exit_code != 0 or "stopped" in out.lower():
                    _finding("apache_status", "Apache/OHS Not Running", "critical",
                             "adapcctl.sh status reports Apache/OHS is stopped or failed "
                             "(exit code %d)." % exit_code, out)
                else:
                    _ok("apache_status", "Apache/OHS Status", "Apache/OHS is running.", out)

            # ── 2. OPMN status ────────────────────────────────────────────────
            if not env_file:
                _finding("opmn_status", "OPMN Status", "warning", no_env_msg)
            else:
                cmd = _src_cmd("$ADMIN_SCRIPTS_HOME/adopmnctl.sh status")
                stdout, stderr, exit_code, _ = _run(cmd)
                out = stdout + stderr
                if any(kw in out for kw in ("Down", "down", "FAILED", "failed")):
                    _finding("opmn_status", "OPMN Components Down", "critical",
                             "adopmnctl.sh status reports one or more OPMN components are down.", out)
                elif exit_code != 0:
                    _finding("opmn_status", "OPMN Status Check Failed", "warning",
                             "adopmnctl.sh status returned exit code %d." % exit_code, out)
                else:
                    _ok("opmn_status", "OPMN Status", "All OPMN components are Alive.", out)

            # ── 3. Apps Listener (FNDSM) status ──────────────────────────────
            if not env_file:
                _finding("apps_listener", "Apps Listener Status", "warning", no_env_msg)
            else:
                cmd = _src_cmd("$ADMIN_SCRIPTS_HOME/adalnctl.sh status")
                stdout, stderr, exit_code, _ = _run(cmd)
                out = stdout + stderr
                if exit_code != 0 or any(kw in out.lower() for kw in ("not running", "stopped", "down")):
                    _finding("apps_listener", "Apps Listener Not Running", "warning",
                             "adalnctl.sh status reports the Apps Listener (FNDSM) is not running.", out)
                else:
                    _ok("apps_listener", "Apps Listener Status", "Apps Listener is running.", out)

            # Helper: shell-escape a password for single-quoted heredoc interpolation
            def _sh(pwd):
                return (pwd or "").replace("'", "'\\''")

            # Noise lines emitted by EBS admin scripts — strip before storing raw output.
            _MANAGED_NOISE = [
                "you are running admanagedsrvctl",
                "enter the weblogic admin password",
                "server specific logs are located",
                "admanagedsrvctl.sh: exiting with status",
                "admanagedsrvctl.sh: check the logfile",
                "you are running adadminsrvctl",
                "enter the apps schema password",
                "adadminsrvctl.sh: exiting with status",
                "adadminsrvctl.sh: check the logfile",
            ]

            def _clean_raw(raw):
                lines = [l for l in raw.splitlines()
                         if not any(n in l.lower() for n in _MANAGED_NOISE)
                         and l.strip()]
                return "\n".join(lines)

            import subprocess as _sp

            # ── 4. Managed servers (dynamic discovery from CONTEXT_FILE) ─────
            if not env_file:
                _finding("managed_servers", "Managed Servers", "warning", no_env_msg)
            elif not req_weblogic_pwd:
                # No WebLogic password — list server names from CONTEXT_FILE as informational
                _srv_out, _, _, _ = _run(_src_cmd(
                    "grep 'oa_service_name' \"$CONTEXT_FILE\" 2>/dev/null "
                    "| grep 'managed_server' "
                    "| sed -n 's/.*>\\([a-zA-Z0-9_-]*\\)<.*/\\1/p' "
                    "| grep -v '^$' | sort -u"
                ), timeout=10)
                _srv_names = [s.strip() for s in _srv_out.splitlines() if s.strip()]
                if _srv_names:
                    _ok("managed_servers", "Managed Servers",
                        "Set WebLogic password in Edit Connection for per-server status. "
                        "Servers in CONTEXT_FILE: %s" % ", ".join(_srv_names))
                else:
                    _ok("managed_servers", "Managed Servers",
                        "Set WebLogic password in Edit Connection to enable managed server status check.")
            else:
                _srv_out, _, _, _ = _run(_src_cmd(
                    "grep 'oa_service_name' \"$CONTEXT_FILE\" 2>/dev/null "
                    "| grep 'managed_server' "
                    "| sed -n 's/.*>\\([a-zA-Z0-9_-]*\\)<.*/\\1/p' "
                    "| grep -v '^$' | sort -u"
                ), timeout=10)
                _srv_names = [s.strip() for s in _srv_out.splitlines() if s.strip()]
                if not _srv_names:
                    _finding("managed_servers", "Managed Servers — No Servers Found", "warning",
                             "No managed_server entries found in CONTEXT_FILE. "
                             "Verify CONTEXT_FILE is set correctly via EBSapps.env.")
                else:
                    _srv_states = []
                    _wls_esc = _sh(req_weblogic_pwd)
                    for _s in _srv_names:
                        _s_cmd = _src_cmd(
                            "timeout 45s admanagedsrvctl.sh status %(sv)s <<EOF 2>/dev/null\n"
                            "%(wls)s\nEOF\n"
                        ) % {"sv": _sh(_s), "wls": _wls_esc}
                        _s_out, _s_err, _s_exit, _ = _run(_s_cmd, timeout=50)
                        _s_raw_orig = _s_out + _s_err
                        _s_raw = _clean_raw(_s_raw_orig)
                        # State detection on original output — _clean_raw strips the
                        # "Invalid server name" line which is the NOT_DEPLOYED signal.
                        if _s_exit == 124:
                            _srv_states.append((_s, "TIMEOUT", _s_raw))
                        elif "invalid server name" in _s_raw_orig.lower() or "invalid managed server" in _s_raw_orig.lower():
                            _srv_states.append((_s, "NOT_DEPLOYED", _s_raw))
                        elif _sp.run(["grep", "-qi", "is running"],
                                     input=_s_raw_orig.encode(),
                                     capture_output=True).returncode == 0:
                            _srv_states.append((_s, "RUNNING", _s_raw))
                        elif any(kw in _s_raw_orig.lower() for kw in ("is shutdown", "is not running", "not running")):
                            _srv_states.append((_s, "DOWN", _s_raw))
                        else:
                            _srv_states.append((_s, "UNKNOWN", _s_raw))
                    _down = [n for n, st, _ in _srv_states if st in ("DOWN", "TIMEOUT")]
                    _combined_raw = "\n".join(
                        "=== %s ===\nStatus: %s\n%s" % (n, st, raw[:500])
                        for n, st, raw in _srv_states
                    )
                    if _down:
                        _finding("managed_servers", "Managed Servers Down", "critical",
                                 "Servers not running: %s" % ", ".join(_down),
                                 _combined_raw)
                    else:
                        _running_count = sum(1 for _, st, _ in _srv_states if st == "RUNNING")
                        _nd_count = sum(1 for _, st, _ in _srv_states if st == "NOT_DEPLOYED")
                        _unk_count = sum(1 for _, st, _ in _srv_states if st == "UNKNOWN")
                        _parts = []
                        if _running_count: _parts.append("%d running" % _running_count)
                        if _nd_count: _parts.append("%d not deployed on this node" % _nd_count)
                        if _unk_count: _parts.append("%d unknown" % _unk_count)
                        _ok("managed_servers", "Managed Servers",
                            "Managed servers: %s" % ", ".join(_parts),
                            _combined_raw)

            # ── 5c. Node Manager ──────────────────────────────────────────────
            if not env_file:
                _finding("node_manager", "Node Manager", "warning", no_env_msg)
            else:
                cmd = _src_cmd("$ADMIN_SCRIPTS_HOME/adnodemgrctl.sh status 2>/dev/null")
                stdout, stderr, exit_code, _ = _run(cmd)
                out = stdout + stderr
                if exit_code != 0 or any(kw in out.lower() for kw in ("not running", "stopped", "failed", "dead")):
                    _finding("node_manager", "Node Manager Not Running", "critical",
                             "adnodemgrctl.sh status reports Node Manager is not running "
                             "(exit code %d)." % exit_code, out)
                else:
                    _ok("node_manager", "Node Manager", "Node Manager is running.", out)

            # ── 6. WebLogic Admin Server (via adadminsrvctl.sh, heredoc) ─────
            # Only relevant on the WLS admin host — skip on managed-server-only nodes.
            if not env_file:
                _finding("admin_server", "WebLogic Admin Server", "warning", no_env_msg)
            elif not req_weblogic_pwd or not req_apps_pwd:
                _ok("admin_server", "WebLogic Admin Server",
                    "Set WebLogic and APPS passwords in Edit Connection to enable Admin Server check.")
            else:
                _host_cmd = _src_cmd(
                    "HOST=$(hostname -s); "
                    "ADMIN_HOST=$(grep -i 's_wls_admin_host\\|wls_admin_host' \"$CONTEXT_FILE\" 2>/dev/null "
                    "| sed -E 's/.*>([^<]*)<.*/\\1/' | grep -v '^[[:space:]]*$' | head -1 | xargs 2>/dev/null); "
                    "if [ -n \"$ADMIN_HOST\" ] && [ \"$HOST\" != \"$ADMIN_HOST\" ]; then "
                    "echo \"skip:$ADMIN_HOST\"; else echo is_admin; fi"
                )
                _host_out, _, _, _ = _run(_host_cmd)
                if _host_out.strip().startswith("skip:"):
                    _adm_host = _host_out.strip()[len("skip:"):].strip()
                    _ok("admin_server", "WebLogic Admin Server",
                        "Admin Server runs on host '%s' — skipped on this managed-server node." % _adm_host)
                else:
                    cmd = _src_cmd(
                        "timeout 60 bash -c 'adadminsrvctl.sh status <<EOF 2>/dev/null\n"
                        "%(wls)s\n%(apps)s\nEOF\n'"
                    ) % {"wls": _sh(req_weblogic_pwd), "apps": _sh(req_apps_pwd)}
                    stdout, stderr, exit_code, _ = _run(cmd, timeout=65)
                    out = _clean_raw(stdout + stderr)
                    _running = _sp.run(["grep", "-qi", "is running"], input=out.encode(),
                                       capture_output=True).returncode == 0
                    if exit_code == 124:
                        _finding("admin_server", "Admin Server Check Timed Out", "warning",
                                 "adadminsrvctl.sh status timed out after 60s.", out)
                    elif _running:
                        _ok("admin_server", "WebLogic Admin Server",
                            "Admin Server is running.", out)
                    else:
                        _finding("admin_server", "WebLogic Admin Server Not Running", "critical",
                                 "adadminsrvctl.sh status reports Admin Server is not running "
                                 "(exit code %d)." % exit_code, out)

            # ── 7. Concurrent Manager — FND_CONCURRENT_QUEUES_VL via sqlplus ─
            _MANDATORY_MGR = {
                "internal manager", "standard manager",
                "output post processor", "service manager",
                "workflow agent listener",
            }
            if not env_file:
                _finding("cm_status", "Concurrent Manager Status", "warning", no_env_msg)
            elif not req_apps_pwd:
                _ok("cm_status", "Concurrent Manager Status",
                    "Set APPS password in Edit Connection to enable Concurrent Manager checks.")
            else:
                _pw = _sh(req_apps_pwd)
                _sql_cmd = _src_cmd(
                    "sqlplus -s 'apps/%(pw)s' << CMSQLEND\n"
                    "set pages 0 feedback off heading off echo off verify off\n"
                    "SELECT user_concurrent_queue_name||'|'||max_processes||'|'"
                    "||running_processes||'|'||nvl(control_code,'A')\n"
                    "FROM apps.fnd_concurrent_queues_vl\n"
                    "WHERE enabled_flag='Y'\n"
                    "ORDER BY user_concurrent_queue_name;\n"
                    "exit;\n"
                    "CMSQLEND\n"
                ) % {"pw": _pw}
                _sq_out, _sq_err, _sq_exit, _ = _run(_sql_cmd, timeout=30)
                _sq_full = _sq_out + _sq_err
                print("[HC] CM sqlplus exit: %d" % _sq_exit)
                _mgrs, _crit_down, _warn_down = [], [], []
                for _ln in _sq_out.splitlines():
                    _pts = [p.strip() for p in _ln.strip().split("|")]
                    if len(_pts) == 4:
                        try:
                            _mn   = _pts[0]
                            _tgt  = int(_pts[1])
                            _rc   = int(_pts[2])
                            _cc   = _pts[3]
                            if _cc == 'E' or _tgt == 0:
                                continue   # deactivated or no target — skip
                            _mgrs.append((_mn, _tgt, _rc))
                            if _rc == 0:
                                if _mn.lower() in _MANDATORY_MGR:
                                    _crit_down.append("%s (0/%d)" % (_mn, _tgt))
                                else:
                                    _warn_down.append("%s (0/%d)" % (_mn, _tgt))
                            elif _rc < _tgt:
                                _warn_down.append("%s (%d/%d)" % (_mn, _rc, _tgt))
                        except ValueError:
                            pass
                if not _mgrs and _sq_exit != 0:
                    _finding("cm_status", "CM Query Failed", "warning",
                             "sqlplus query to FND_CONCURRENT_QUEUES_VL failed "
                             "(exit %d). Check APPS credentials and DB connectivity." % _sq_exit, _sq_full)
                elif _crit_down:
                    _finding("cm_status", "Mandatory Manager Down", "critical",
                             "Critical mandatory manager(s) not running: %s"
                             % "; ".join(_crit_down[:5]), _sq_full)
                elif _warn_down:
                    _finding("cm_status", "Concurrent Manager Under-Staffed", "warning",
                             "%d manager(s) running fewer than target processes: %s"
                             % (len(_warn_down), "; ".join(_warn_down[:5])), _sq_full)
                elif _mgrs:
                    _ok("cm_status", "Concurrent Manager Status",
                        "All %d active managers running at target." % len(_mgrs),
                        "Manager Name|Target|Running\n" +
                        "\n".join("%s|%d|%d" % (n, t, r) for n, t, r in _mgrs))
                else:
                    _ok("cm_status", "Concurrent Manager Status",
                        "No active managers found (all deactivated or max_processes=0).", _sq_full)

            # ── 8. Workflow Mailer — FND_SVC_COMPONENTS + stuck notifications ─
            if not env_file:
                _finding("wf_mailer", "Workflow Mailer", "warning", no_env_msg)
            elif not req_apps_pwd:
                _ok("wf_mailer", "Workflow Mailer",
                    "Set APPS password in Edit Connection to enable Workflow Mailer checks.")
            else:
                _pw = _sh(req_apps_pwd)
                # Query 1: service component states
                _wf_cmd = _src_cmd(
                    "sqlplus -s 'apps/%(pw)s' << WFSQLEND\n"
                    "set pages 0 feedback off heading off echo off verify off\n"
                    "select component_name||'|'||component_status\n"
                    "from apps.fnd_svc_components\n"
                    "order by component_name;\n"
                    "exit;\n"
                    "WFSQLEND\n"
                ) % {"pw": _pw}
                _wf_out, _wf_err, _wf_exit, _ = _run(_wf_cmd, timeout=25)
                _wf_full = _wf_out + _wf_err
                # Query 2: stuck outbound notifications (>2h)
                _stuck_cmd = _src_cmd(
                    "sqlplus -s 'apps/%(pw)s' << STUCKSQLEND\n"
                    "set pages 0 feedback off heading off echo off verify off\n"
                    "select count(*) from applsys.wf_notifications\n"
                    "where mail_status='MAIL' and status='OPEN'\n"
                    "and begin_date < sysdate - 2/24;\n"
                    "exit;\n"
                    "STUCKSQLEND\n"
                ) % {"pw": _pw}
                _st_out, _st_err, _st_exit, _ = _run(_stuck_cmd, timeout=20)
                _stuck_count = 0
                try:
                    _stuck_count = int(_st_out.strip().splitlines()[-1].strip()) if _st_out.strip() else 0
                except (ValueError, IndexError):
                    pass
                # Parse component list
                _comps = []
                _mailer_row = None
                for _ln in _wf_out.splitlines():
                    _pts = [p.strip() for p in _ln.strip().split("|")]
                    if len(_pts) == 2 and _pts[0]:
                        _comps.append((_pts[0], _pts[1]))
                        if "workflow notification mailer" in _pts[0].lower():
                            _mailer_row = (_pts[0], _pts[1])
                _comp_table = "Component|Status\n" + "\n".join("%s|%s" % c for c in _comps[:20])
                if not _comps and _wf_exit != 0:
                    _finding("wf_mailer", "WF Mailer Query Failed", "warning",
                             "No service component data returned — check APPS credentials "
                             "(sqlplus exit %d)." % _wf_exit, _wf_full)
                elif _mailer_row and _mailer_row[1].upper() != "RUNNING":
                    _finding("wf_mailer", "Workflow Mailer Not Running", "critical",
                             "%s status: %s. Restart via EBS System Admin → Workflow → Service Components."
                             % (_mailer_row[0], _mailer_row[1]), _comp_table)
                elif _stuck_count > 50:
                    _finding("wf_mailer", "Stuck Workflow Notifications", "warning",
                             "%d outbound notifications stuck >2h. "
                             "Check Workflow Mailer and WF Background Process." % _stuck_count,
                             _comp_table)
                elif _mailer_row:
                    _ok("wf_mailer", "Workflow Mailer",
                        "%s: %s. %s stuck notifications."
                        % (_mailer_row[0], _mailer_row[1],
                           _stuck_count if _stuck_count > 0 else "No"),
                        _comp_table)
                else:
                    _ok("wf_mailer", "Workflow Mailer",
                        "No Workflow Notification Mailer component found in FND_SVC_COMPONENTS "
                        "(%d components returned)." % len(_comps), _comp_table)

            # ── 8b. ADOP status ───────────────────────────────────────────────
            if not env_file:
                _finding("adop_status", "ADOP Status", "warning", no_env_msg)
            elif not req_apps_pwd:
                _ok("adop_status", "ADOP Status",
                    "Set APPS password in Edit Connection to enable ADOP status check.")
            else:
                _adop_cmd = _src_cmd(
                    "timeout 60 bash -c 'env COLUMNS=300 adop -status -detail <<EOF\n"
                    "%(apps)s\nEOF\n'"
                ) % {"apps": _sh(req_apps_pwd)}
                _adop_out, _adop_err, _adop_exit, _ = _run(_adop_cmd, timeout=65)
                _adop_full = _adop_out + _adop_err
                if _adop_exit == 124:
                    _finding("adop_status", "ADOP Command Timed Out", "critical",
                             "adop -status -detail timed out after 60s.", _adop_full)
                elif "FAILED" in _adop_full.upper():
                    _session_line = next(
                        (l.strip() for l in _adop_full.splitlines()
                         if "session" in l.lower() or "phase" in l.lower()), "")
                    _finding("adop_status", "ADOP Session in FAILED State", "critical",
                             "ADOP reports a FAILED session. Investigate with: adop -status -detail. "
                             + _session_line, _adop_full)
                elif "exiting with status = 0" in _adop_full.lower() or "no active session" in _adop_full.lower():
                    # Extract session/phase info if present
                    _summary = "; ".join(
                        l.strip() for l in _adop_full.splitlines()
                        if any(kw in l.lower() for kw in ("session", "phase", "status"))
                        and l.strip() and not l.startswith("adop")
                    )[:200]
                    _ok("adop_status", "ADOP Status",
                        "ADOP completed successfully. " + (_summary or "No active patch session."),
                        _adop_full)
                else:
                    _finding("adop_status", "ADOP Unexpected Output", "warning",
                             "adop -status -detail returned unexpected output "
                             "(exit %d). Review raw output." % _adop_exit, _adop_full)

            # ── 9. Invalid objects (local sqlplus via EBSapps.env) ───────────
            # TWO_TASK/ORACLE_SID set by EBSapps.env — no @host needed.
            if env_file and req_apps_pwd:
                _pw = _sh(req_apps_pwd)
                _inv_cmd = _src_cmd(
                    "sqlplus -S 'apps/%(pw)s' << INVSQLEND\n"
                    "set pages 0 feedback off heading off echo off verify off\n"
                    "SELECT owner||'|'||COUNT(*) FROM dba_objects\n"
                    "WHERE status='INVALID' GROUP BY owner ORDER BY COUNT(*) DESC;\n"
                    "exit;\n"
                    "INVSQLEND\n"
                ) % {"pw": _pw}
                _inv_out, _inv_err, _inv_exit, _ = _run(_inv_cmd, timeout=25)
                _inv_full = _inv_out + _inv_err
                _inv_rows = []
                for _ln in _inv_out.splitlines():
                    _pts = _ln.strip().split("|")
                    if len(_pts) == 2:
                        try:
                            _owner = _pts[0].strip()
                            _cnt   = int(_pts[1].strip())
                            if _cnt > 0:
                                _inv_rows.append((_owner, _cnt))
                        except ValueError:
                            pass
                _inv_table = ("Owner|Invalid Objects\n" +
                             "\n".join("%s|%d" % (o, c) for o, c in _inv_rows)) if _inv_rows else ""
                if _inv_exit != 0 and not _inv_rows:
                    _finding("invalid_objects", "Invalid Objects Check Failed", "warning",
                             "sqlplus query for invalid objects failed (exit %d). "
                             "Check APPS credentials and DB connectivity." % _inv_exit, _inv_full)
                elif _inv_rows:
                    _apps_inv   = next((c for o, c in _inv_rows if o.upper() == "APPS"), 0)
                    _other_crit = [(o, c) for o, c in _inv_rows if o.upper() != "APPS" and c > 10]
                    _top5       = "; ".join("%s: %d" % (o, c) for o, c in _inv_rows[:5])
                    if _apps_inv > 0:
                        _finding("invalid_objects", "APPS Schema Has Invalid Objects", "critical",
                                 "APPS schema has %d invalid object(s). "
                                 "Run utlrp.sql or adrelink to resolve. Top owners: %s"
                                 % (_apps_inv, _top5), _inv_table)
                    elif _other_crit:
                        _finding("invalid_objects", "Invalid Objects Detected", "warning",
                                 "%d schema(s) have >10 invalid objects. Top owners: %s"
                                 % (len(_other_crit), _top5), _inv_table)
                    else:
                        _ok("invalid_objects", "Invalid Objects",
                            "No critical invalid objects. Minor counts: %s" % _top5, _inv_table)
                else:
                    _ok("invalid_objects", "Invalid Objects",
                        "No invalid objects found in the database.", "")

            # ── 8. Disk usage ──────────────────────────────────────────────────
            stdout, stderr, exit_code, _ = run_os_command(["df", "-h"], timeout=10)
            if exit_code != 0:
                _finding("disk_usage", "Disk Usage Check Failed", "warning",
                         "df -h returned exit code %d." % exit_code, stderr)
            else:
                crit_fs = []
                warn_fs = []
                for line in stdout.splitlines()[1:]:
                    parts = line.split()
                    if len(parts) >= 5:
                        pct_str = parts[4].rstrip("%")
                        try:
                            pct   = int(pct_str)
                            mount = parts[5] if len(parts) >= 6 else parts[-1]
                            if pct >= 95:
                                crit_fs.append("%s at %d%%" % (mount, pct))
                            elif pct >= 85:
                                warn_fs.append("%s at %d%%" % (mount, pct))
                        except ValueError:
                            pass
                if crit_fs:
                    _finding("disk_usage", "Critical Disk Usage", "critical",
                             "Filesystems at or above 95%%: %s" % ", ".join(crit_fs),
                             stdout[:1000])
                elif warn_fs:
                    _finding("disk_usage", "High Disk Usage", "warning",
                             "Filesystems at or above 85%%: %s" % ", ".join(warn_fs),
                             stdout[:1000])
                else:
                    _ok("disk_usage", "Disk Usage", "All filesystems below 85%% threshold.")

            # ── 9. Memory ──────────────────────────────────────────────────────
            stdout, stderr, exit_code, _ = run_os_command(["free", "-m"], timeout=10)
            if exit_code != 0:
                _finding("memory_usage", "Memory Check Failed", "warning",
                         "free -m returned exit code %d." % exit_code, stderr)
            else:
                available_mb = None
                for line in stdout.splitlines():
                    if line.startswith("Mem:"):
                        parts = line.split()
                        if len(parts) >= 7:
                            try:
                                available_mb = int(parts[6])
                            except ValueError:
                                pass
                        break
                if available_mb is None:
                    _finding("memory_usage", "Memory Parse Failed", "warning",
                             "Could not parse available memory from free -m output.", stdout[:300])
                elif available_mb < 256:
                    _finding("memory_usage", "Critical Memory Pressure", "critical",
                             "Available memory: %dMB (below 256MB critical threshold)." % available_mb,
                             stdout[:300])
                elif available_mb < 512:
                    _finding("memory_usage", "Low Available Memory", "warning",
                             "Available memory: %dMB (below 512MB warning threshold)." % available_mb,
                             stdout[:300])
                else:
                    _ok("memory_usage", "Memory Usage",
                        "Available memory: %dMB." % available_mb)

            # ── Score ──────────────────────────────────────────────────────────
            score = 100
            for f in findings:
                if f["severity"] == "critical":
                    score -= 25
                elif f["severity"] == "warning":
                    score -= 10
            score = max(0, score)

            self.send_json(200, {
                "success":      True,
                "server_type":  "apps",
                "score":        score,
                "findings":     findings,
                "checks_ok":    checks_ok,
                "checks_total": len(findings) + len(checks_ok),
                "ran_at":       timestamp,
            })
            return

        # POST /api/ssh/exec — execute a shell command on a remote host via SSH
        if self.path == "/api/ssh/exec":
            if not self.check_auth():
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                host        = params.get("host", "")
                port        = int(params.get("port", 22))
                username    = params.get("username", "")
                auth_method = params.get("auth_method", "password")
                password    = params.get("password", "")
                private_key = params.get("private_key", "")
                command     = params.get("command", "")
                timeout     = min(int(params.get("timeout", 30)), 120)

                if not host or not username or not command:
                    self.send_json(400, {"error": "host, username, and command are required"})
                    return
                if auth_method not in ("key", "password"):
                    self.send_json(400, {"error": "auth_method must be key or password"})
                    return

                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] SSH exec: %s@%s:%d — %s" % (timestamp, username, host, port, command[:60]))

                result = run_ssh_command(host, port, username, auth_method, password, private_key, command, timeout)
                self.send_json(200, result)
            except Exception as e:
                traceback.print_exc()
                self.send_json(500, {"success": False, "stdout": "", "stderr": str(e), "exit_code": -1, "elapsed_ms": 0})
            return

        # POST /api/ssh/test — convenience endpoint: runs whoami && hostname && uname -a
        if self.path == "/api/ssh/test":
            if not self.check_auth():
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                host        = params.get("host", "")
                port        = int(params.get("port", 22))
                username    = params.get("username", "")
                auth_method = params.get("auth_method", "password")
                password    = params.get("password", "")
                private_key = params.get("private_key", "")
                timeout     = min(int(params.get("timeout", 30)), 120)

                if not host or not username:
                    self.send_json(400, {"error": "host and username are required"})
                    return

                result = run_ssh_command(
                    host, port, username, auth_method, password, private_key,
                    "whoami && hostname && uname -a", timeout
                )
                self.send_json(200, result)
            except Exception as e:
                traceback.print_exc()
                self.send_json(500, {"success": False, "stdout": "", "stderr": str(e), "exit_code": -1, "elapsed_ms": 0})
            return

        # POST /api/http-forward — proxy an HTTP request to an internal apps URL.
        # Security: target host:port must be in APPS_URL_WHITELIST (set in proxy.env).
        # Accepts: {target_url, method, headers, body}
        # Returns: {status, headers, body (base64)}
        if self.path == "/api/http-forward":
            if not self.check_auth():
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                target_url  = params.get("target_url", "").strip()
                method      = params.get("method", "GET").upper()
                req_headers = params.get("headers") or {}
                req_body    = params.get("body", "")

                if not target_url:
                    self.send_json(400, {"error": "target_url is required"})
                    return

                if method not in ("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"):
                    self.send_json(400, {"error": "Unsupported method"})
                    return

                # Parse host:port from target_url for whitelist check
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(target_url)
                    netloc_host = parsed.hostname or ""
                    netloc_port = parsed.port or (443 if parsed.scheme == "https" else 80)
                    netloc_key  = ("%s:%d" % (netloc_host.lower(), netloc_port))
                except Exception:
                    self.send_json(400, {"error": "Invalid target_url"})
                    return

                if not APPS_URL_WHITELIST:
                    self.send_json(403, {
                        "error": "HTTP forwarding disabled — set APPS_URL_WHITELIST in proxy.env"
                    })
                    return

                if netloc_key not in APPS_URL_WHITELIST:
                    self.send_json(403, {
                        "error": "Target %s not in APPS_URL_WHITELIST" % netloc_key,
                        "whitelist": list(APPS_URL_WHITELIST)
                    })
                    return

                # Build and send the upstream request
                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] HTTP forward: %s %s" % (timestamp, method, target_url[:80]))

                import base64
                fwd_body = req_body.encode("utf-8") if isinstance(req_body, str) else req_body
                fwd_req = Request(target_url, data=fwd_body if method not in ("GET", "HEAD") else None, method=method)

                # Forward safe headers; drop hop-by-hop
                skip = {"host", "content-length", "transfer-encoding", "connection"}
                for k, v in req_headers.items():
                    if k.lower() not in skip:
                        fwd_req.add_header(k, v)

                # Allow redirects, 30s timeout
                import ssl
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE

                try:
                    resp = urlopen(fwd_req, timeout=30, context=ctx)
                    resp_status  = resp.getcode()
                    resp_headers = dict(resp.headers)
                    resp_body    = resp.read()
                except HTTPError as he:
                    resp_status  = he.code
                    resp_headers = dict(he.headers)
                    resp_body    = he.read()

                self.send_json(200, {
                    "success": True,
                    "status": resp_status,
                    "headers": resp_headers,
                    "body": base64.b64encode(resp_body).decode("ascii"),
                })
            except Exception as e:
                traceback.print_exc()
                self.send_json(500, {"success": False, "error": str(e)})
            return

        # POST /api/os/exec — execute a whitelisted OS command on the local server.
        # Accepts: { "command": "<key>" }
        # Returns: { "stdout", "stderr", "exit_code", "duration_ms" }
        # Security: strict whitelist match only; no shell=True; 10s timeout; 64KB cap.
        if self.path == "/api/os/exec":
            if not self.check_auth():
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                command_key = params.get("command", "").strip()

                if not command_key:
                    self.send_json(400, {"error": "command is required"})
                    return

                proxy_role = os.environ.get("PROXY_ROLE", "db").lower()
                timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

                # ── Dynamic tail/cat with path ────────────────────────────────
                # Allowed forms: "tail -n 100 /path/to/logfile"
                #                "cat /path/to/file"
                tail_match = re.match(r'^tail -n (\d+) (.+)$', command_key)
                cat_match  = re.match(r'^cat (/[^ ]+)$', command_key)

                if tail_match:
                    lines    = min(int(tail_match.group(1)), 500)
                    raw_path = tail_match.group(2)
                    path, err = _resolve_tail_path(raw_path)
                    if err:
                        print("[%s] OS_EXEC_REJECT key=%r reason=%s" % (timestamp, command_key, err))
                        self.send_json(403, {"error": "rejected: %s" % err})
                        return
                    argv = ["tail", "-n", str(lines), path]
                    print("[%s] OS_EXEC tail lines=%d path=%s" % (timestamp, lines, path))
                    stdout, stderr, exit_code, duration_ms = run_os_command(argv)
                    self.send_json(200, {"stdout": stdout, "stderr": stderr,
                                        "exit_code": exit_code, "duration_ms": duration_ms})
                    return

                if cat_match:
                    raw_path = cat_match.group(1)
                    path, err = _resolve_tail_path(raw_path)
                    if err:
                        print("[%s] OS_EXEC_REJECT key=%r reason=%s" % (timestamp, command_key, err))
                        self.send_json(403, {"error": "rejected: %s" % err})
                        return
                    argv = ["cat", path]
                    print("[%s] OS_EXEC cat path=%s" % (timestamp, path))
                    stdout, stderr, exit_code, duration_ms = run_os_command(argv)
                    self.send_json(200, {"stdout": stdout, "stderr": stderr,
                                        "exit_code": exit_code, "duration_ms": duration_ms})
                    return

                # ── Exact whitelist match ─────────────────────────────────────
                entry = _OS_CMD_MAP.get(command_key)
                if not entry:
                    print("[%s] OS_EXEC_REJECT key=%r reason=not_whitelisted" % (timestamp, command_key))
                    self.send_json(403, {
                        "error": "command not whitelisted",
                        "received": command_key,
                    })
                    return

                # Role check
                if entry["allow_role"] == "apps" and proxy_role != "apps":
                    print("[%s] OS_EXEC_REJECT key=%r reason=role_mismatch proxy_role=%s" % (
                        timestamp, command_key, proxy_role))
                    self.send_json(403, {
                        "error": "this command requires PROXY_ROLE=apps on the proxy server",
                    })
                    return

                print("[%s] OS_EXEC key=%r" % (timestamp, command_key))
                stdout, stderr, exit_code, duration_ms = run_os_command(entry["argv"])
                self.send_json(200, {
                    "stdout": stdout,
                    "stderr": stderr,
                    "exit_code": exit_code,
                    "duration_ms": duration_ms,
                })

            except Exception as e:
                traceback.print_exc()
                self.send_json(500, {"error": str(e), "exit_code": -1, "stdout": "", "stderr": str(e), "duration_ms": 0})
            return

        # POST /exec — structured proxy exec with command_id + validated args[].
        # Auth: X-Api-Key header (same connection API key as all proxy endpoints).
        # Body: { "command_id": str, "args": {}, "cwd": str (opt), "timeout_s": int (opt) }
        # Returns: { "stdout", "stderr", "exit_code", "duration_ms", "command_id" }
        # All executions audit-logged to EXEC_AUDIT_LOG (/var/log/tunevault/exec.log).
        if self.path == "/exec":
            if not self.check_auth():
                return
            try:
                body = self.read_body()
                params = json.loads(body)
                command_id = str(params.get("command_id", "")).strip()
                args_in    = params.get("args", {}) or {}
                timeout_s  = params.get("timeout_s", None)
                requestor  = params.get("requestor_user_id", "unknown")

                if not command_id:
                    self.send_json(400, {"error": "command_id is required"})
                    return

                spec = _EXEC_WHITELIST.get(command_id)
                if not spec:
                    self.send_json(403, {
                        "error": "command_id not whitelisted",
                        "command_id": command_id,
                        "allowed": list(_EXEC_WHITELIST.keys()),
                    })
                    return

                # Check required env vars
                for env_var in spec.get("env_requires", []):
                    if not os.environ.get(env_var):
                        self.send_json(400, {
                            "error": "Required env var %s not set on proxy server" % env_var,
                        })
                        return

                # Validate and resolve each arg
                resolved_args = {}
                for arg_spec in spec.get("args", []):
                    arg_name    = arg_spec["name"]
                    default_val = arg_spec.get("default")
                    raw_val     = args_in.get(arg_name, default_val)

                    if raw_val is None:
                        self.send_json(400, {
                            "error": "Missing required arg: %s" % arg_name,
                        })
                        return

                    cleaned, err = _validate_exec_arg(str(raw_val), arg_spec)
                    if err:
                        self.send_json(400, {
                            "error": "Invalid arg '%s': %s" % (arg_name, err),
                        })
                        return
                    resolved_args[arg_name] = cleaned

                # Build argv from template, substituting {VARNAME} with env vars + resolved args
                env_subs = {k: os.environ.get(k, "") for k in spec.get("env_requires", [])}
                all_subs = dict(env_subs, **resolved_args)

                # APPS_PWD is a special env var for EBS apps password
                all_subs["APPS_PWD"] = os.environ.get("APPS_PWD", "apps")

                try:
                    argv = [seg.format(**all_subs) for seg in spec["argv_template"]]
                except KeyError as ke:
                    self.send_json(500, {"error": "Template var missing: %s" % ke})
                    return

                # Apply timeout: caller may request shorter; use spec default for upper bound
                spec_timeout = spec.get("timeout_s", 30)
                if timeout_s is not None:
                    try:
                        timeout_s = max(1, min(int(timeout_s), spec_timeout))
                    except (TypeError, ValueError):
                        timeout_s = spec_timeout
                else:
                    timeout_s = spec_timeout

                ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                print("[%s] PROXY_EXEC command_id=%s user=%s" % (ts, command_id, requestor))

                stdout, stderr, exit_code, duration_ms = run_os_command(
                    argv, timeout=timeout_s, max_output=10 * 1024 * 1024
                )

                _exec_audit(command_id, resolved_args, exit_code, requestor, duration_ms)

                self.send_json(200, {
                    "command_id":  command_id,
                    "stdout":      stdout,
                    "stderr":      stderr,
                    "exit_code":   exit_code,
                    "duration_ms": duration_ms,
                })

            except json.JSONDecodeError:
                self.send_json(400, {"error": "Invalid JSON body"})
            except Exception as e:
                traceback.print_exc()
                self.send_json(500, {
                    "error": str(e), "exit_code": -1,
                    "stdout": "", "stderr": str(e), "duration_ms": 0,
                })
            return

        self.send_json(404, {"error": "Not found"})


# ============================================================
# Main
# ============================================================

def run_validate_only():
    """
    --validate-only: self-test mode.

    Checks connectivity + payload format against the local Oracle listener
    without starting an HTTP server. Reads proxy.env if present; falls back
    to environment variables.  Useful for:
      - DBA troubleshooting on the Oracle server itself
      - CI smoke-test of a new proxy install
      - TuneVault test-harness validation runner

    Exit codes: 0 = all checks passed, 1 = one or more failures.
    """
    import socket

    # ── Load config (proxy.env > environment variables) ──────────────────────
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy.env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for raw in f:
                raw = raw.strip()
                if raw and not raw.startswith("#") and "=" in raw:
                    k, v = raw.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

    env_host     = os.environ.get("ORACLE_HOST", "")
    env_port     = os.environ.get("ORACLE_PORT", "")
    # Auto-detect from lsnrctl when env vars aren't set — avoids blind localhost:1521 default
    if not env_host or not env_port:
        det_host, det_port = _detect_listener_endpoint()
        if not env_host:
            env_host = det_host or "localhost"
        if not env_port:
            env_port = str(det_port) if det_port else "1521"
    host         = env_host
    port         = int(env_port)
    service_name = os.environ.get("ORACLE_SERVICE", "XE")
    username     = os.environ.get("ORACLE_USER", "TUNEVAULT_RO")
    password     = os.environ.get("ORACLE_PASSWORD", "")

    results = []
    any_fail = False

    def vpass(name, detail, data=None):
        results.append({"check": name, "status": "PASS", "detail": detail, "data": data})

    def vfail(name, detail, data=None):
        results.append({"check": name, "status": "FAIL", "detail": detail, "data": data})
        return True  # signals failure

    def vwarn(name, detail, data=None):
        results.append({"check": name, "status": "WARN", "detail": detail, "data": data})

    print("\nTuneVault Oracle Proxy — Validation Mode")
    print("=" * 52)
    print("Host:    %s:%d" % (host, port))
    print("Service: %s" % service_name)
    print("User:    %s" % username)
    print("=" * 52)

    # ── Check 1: cx_Oracle import ─────────────────────────────────────────────
    try:
        import cx_Oracle as _cx
        vpass("cx_Oracle import", "cx_Oracle %s available" % _cx.version)
    except ImportError as e:
        any_fail = vfail("cx_Oracle import", "cx_Oracle not installed: %s" % e)

    # ── Check 2: TCP reachability ─────────────────────────────────────────────
    try:
        s = socket.create_connection((host, port), timeout=5)
        s.close()
        vpass("TCP connectivity", "%s:%d reachable" % (host, port))
    except Exception as e:
        any_fail = vfail("TCP connectivity", "Cannot reach %s:%d — %s" % (host, port, e))

    # ── Check 3: Oracle connection ────────────────────────────────────────────
    conn = None
    try:
        dsn = cx_Oracle.makedsn(host, port, service_name=service_name)
        conn = cx_Oracle.connect(user=username, password=password, dsn=dsn)
        vpass("Oracle connection", "Connected as %s" % username)
    except Exception as e:
        any_fail = vfail("Oracle connection", "cx_Oracle.connect failed: %s" % e)
        conn = None

    # ── Check 4: V$ access ───────────────────────────────────────────────────
    if conn:
        try:
            cur = conn.cursor()
            cur.execute("SELECT banner FROM v$version WHERE ROWNUM = 1")
            row = cur.fetchone()
            vpass("V$VERSION access", row[0] if row else "No rows returned")
            cur.close()
        except Exception as e:
            any_fail = vfail("V$VERSION access", str(e))

    # ── Check 5: DBA_ catalog access ─────────────────────────────────────────
    if conn:
        try:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM dba_segments WHERE ROWNUM = 1")
            cur.fetchone()
            vpass("DBA_SEGMENTS access", "SELECT_CATALOG_ROLE grants confirmed")
            cur.close()
        except Exception as e:
            any_fail = vfail("DBA_SEGMENTS access",
                             "Missing SELECT_CATALOG_ROLE? Error: %s" % e)

    # ── Check 6: EBS detection (two-step probe — negative path correct on XE) ──
    if conn:
        try:
            cur = conn.cursor()
            is_ebs_v, probe_err_v = _probe_ebs_detection(cur)
            if is_ebs_v:
                vwarn("EBS detection",
                      "EBS confirmed via FND_PRODUCT_GROUPS — EBS checks will run. "
                      "Correct behaviour on Oracle EBS 12.1/12.2.")
            elif probe_err_v:
                any_fail = vfail("EBS detection",
                                 "APPS schema reachable but FND tables not accessible: %s" % probe_err_v)
            else:
                vpass("EBS detection (negative path)",
                      "APPS schema / FND tables not present — proxy will return ebs_detected=false. "
                      "Correct behaviour on Oracle XE / non-EBS databases.")
            cur.close()
        except Exception as e:
            any_fail = vfail("EBS detection", str(e))

    # ── Check 7: collect_metrics payload shape ────────────────────────────────
    if conn and password:
        try:
            conn.close()
            conn = None
            metrics = collect_metrics(host, port, service_name, username, password)
            # Required keys in the server-expected payload contract
            required_keys = ["instance", "tablespaces", "top_sql", "wait_events",
                             "ebs_detected"]
            missing = [k for k in required_keys if k not in metrics]
            # If EBS detected, ebs_operations must also be present and non-null
            ebs_detected_val = metrics.get("ebs_detected", False)
            if ebs_detected_val and metrics.get("ebs_operations") is None:
                missing.append("ebs_operations (EBS detected but field is null)")
            if missing:
                any_fail = vfail("Payload structure",
                                 "collect_metrics missing/incorrect keys: %s" % ", ".join(missing),
                                 data={"missing": missing, "present": list(metrics.keys())})
            else:
                detail = "All required payload keys present"
                if ebs_detected_val:
                    ebs_ops = metrics.get("ebs_operations") or {}
                    cm_keys = list((ebs_ops.get("concurrent_managers") or {}).keys())
                    wf_keys = list((ebs_ops.get("workflow") or {}).keys())
                    detail += " (EBS detected; ebs_operations.concurrent_managers=%s wf=%s)" % (cm_keys, wf_keys)
                vpass("Payload structure", detail,
                      data={"keys": list(metrics.keys()),
                            "ebs_detected": ebs_detected_val,
                            "ebs_probe_error": metrics.get("ebs_probe_error")})
        except Exception as e:
            any_fail = vfail("Payload structure",
                             "collect_metrics raised: %s" % e)
    elif conn:
        vwarn("Payload structure", "ORACLE_PASSWORD not set — skipping full metrics collection")

    if conn:
        try:
            conn.close()
        except Exception:
            pass

    # ── Print results ─────────────────────────────────────────────────────────
    print("\n%-52s  %-5s  %s" % ("Check", "State", "Detail"))
    print("-" * 100)
    for r in results:
        marker = {"PASS": "✓", "FAIL": "✗", "WARN": "!"}.get(r["status"], "?")
        print("[%s] %-50s  %-5s  %s" % (marker, r["check"], r["status"], r["detail"]))

    total  = len(results)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    warned = sum(1 for r in results if r["status"] == "WARN")

    print("\n%d/%d passed, %d warnings, %d failed" % (passed, total, warned, failed))

    # Write JSON report
    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "validation-report.json")
    report = {
        "ran_at": datetime.now().isoformat(),
        "host": host,
        "port": port,
        "service": service_name,
        "username": username,
        "summary": {"total": total, "passed": passed, "warned": warned, "failed": failed},
        "checks": results
    }
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print("Report written to %s" % report_path)

    sys.exit(1 if any_fail else 0)


# ============================================================
# Outbound Cloud Channel — Long-Poll Thread
# ============================================================
# The proxy maintains a persistent outbound HTTPS connection to TuneVault cloud.
# This is the primary communication channel — the proxy is NOT externally reachable.
#
# Protocol:
#   1. POST /api/agent/poll with { connection_id } + X-TuneVault-Key header
#   2. Server holds connection up to 25s, returns { work: <request> | null }
#   3. If work received, execute it locally via HTTP to localhost:3100
#   4. POST /api/agent/respond with { connection_id, request_id, status_code, body }
#   5. Repeat
#
# Each poll also serves as a heartbeat — no separate heartbeat endpoint needed.

# Read cloud config from env (written by installer to /etc/tunevault/proxy.env)
_CLOUD_API_URL = os.environ.get("TUNEVAULT_API_URL", "").rstrip("/")
_CLOUD_CONNECTION_ID = os.environ.get("TUNEVAULT_CONNECTION_ID", "")

def _cloud_poll_loop():
    """Background thread: long-poll TuneVault cloud for work, execute locally, return results."""
    api_url = _CLOUD_API_URL
    conn_id = _CLOUD_CONNECTION_ID
    api_key = API_KEY  # first key in the set

    if not api_url or not conn_id:
        print("%s [cloud] Outbound channel disabled — TUNEVAULT_API_URL or TUNEVAULT_CONNECTION_ID not set" % _ts())
        return

    # Guard: reject malformed connection ID before any network call.
    # parseInt fallback in JS can produce "NaN" if the env var is corrupted
    # (e.g., from a botched upgrade that wrote None → "None" → "NaN").
    # Python's int("NaN") raises ValueError — catch it here so the thread
    # exits cleanly instead of spamming the server with bad polls.
    try:
        conn_id = str(int(conn_id))
    except (ValueError, TypeError):
        print("%s [cloud] FATAL: TUNEVAULT_CONNECTION_ID is not a valid integer (%r) — exiting" % (_ts(), _CLOUD_CONNECTION_ID))
        sys.exit(9)

    backoff = 1  # exponential backoff on errors (seconds)
    max_backoff = 60
    consecutive_ok = 0
    _first_poll_logged = False  # milestone 6: register (first successful poll)
    global _last_poll_ok_time, _poll_stage

    logger.info("long-poll loop starting — %s (connection=%s)", api_url, conn_id)

    # Mark initial stage
    with _poll_state_lock:
        _poll_stage = "polling"

    while True:
        try:
            # ── Poll for work ──
            poll_payload = {
                "connection_id": int(conn_id),
                "agent_version": VERSION,
                "proxy_version": _PROXY_VERSION or VERSION,
                "python_version": "%d.%d.%d" % sys.version_info[:3],
                "cx_oracle_version": _ORACLE_VERSION if _ORACLE_DRIVER else "",
                "oracle_driver": _ORACLE_DRIVER or "",
                "oracle_mode": "thick" if (_ORACLE_DRIVER == "cx_Oracle" or _ORACLEDB_THICK_MODE) else "thin",
                "os_id": _OS_ID,
                "kernel": _KERNEL,
            }
            if _INSTALLED_AT:
                poll_payload["installed_at"] = _INSTALLED_AT
            if _LAST_UPGRADE_AT:
                poll_payload["last_upgrade_at"] = _LAST_UPGRADE_AT
            if _INSTANCE_NAME:
                poll_payload["ebs_instance_name"] = _INSTANCE_NAME
            poll_body = json.dumps(poll_payload).encode("utf-8")
            poll_req = Request(
                "%s/api/agent/poll" % api_url,
                data=poll_body,
                headers={
                    "Content-Type": "application/json",
                    "X-TuneVault-Key": api_key,
                },
                method="POST",
            )

            _poll_t0 = time.time()
            try:
                resp = urlopen(poll_req, timeout=35)  # 25s server hold + 10s network margin
                resp_data = resp.read().decode("utf-8")
                poll_result = json.loads(resp_data)
            except (URLError, HTTPError) as e:
                err_msg = str(e)
                if hasattr(e, 'code') and e.code == 403:
                    logger.error("heartbeat — POST /api/agent/poll → 403 authentication failed — check TUNEVAULT_API_KEY")
                    with _poll_state_lock:
                        _poll_stage = "auth_failure"
                    time.sleep(min(backoff, _POLL_BACKOFF_MAX_S))
                    backoff = min(backoff * 2, _POLL_BACKOFF_MAX_S)
                    continue
                # Network error — backoff and retry (watchdog decides when to escalate)
                if consecutive_ok > 0:
                    logger.warning("heartbeat — connection lost: %s — reconnecting in %ds", err_msg, backoff)
                with _poll_state_lock:
                    _poll_stage = "polling"  # still trying
                time.sleep(min(backoff, _POLL_BACKOFF_MAX_S))
                backoff = min(backoff * 2, _POLL_BACKOFF_MAX_S)
                consecutive_ok = 0
                continue

            # Successful poll — reset backoff, update shared watchdog timestamp
            _poll_ms = int((time.time() - _poll_t0) * 1000)
            with _poll_state_lock:
                _last_poll_ok_time = time.time()
                _poll_stage = "polling"
            if not _first_poll_logged:
                # Milestone 6: register — first successful poll proves key+connection valid
                logger.info("register — POST /api/agent/poll → %d body=%s",
                            200, str(poll_result)[:200])
                _first_poll_logged = True
            # Milestone 8: heartbeat — every cycle
            logger.info("heartbeat — POST /api/agent/poll → 200 in %dms", _poll_ms)
            if consecutive_ok == 0:
                logger.info("first heartbeat acknowledged — outbound channel live")
                _first_heartbeat_event.set()
            consecutive_ok += 1
            backoff = 1

            # Cloud signals a newer oracle-proxy.py is available via poll response field.
            # Backup path for 3.20.6+ proxies — the primary path is the work item below.
            if poll_result.get("proxy_upgrade_available"):
                global _last_poll_upgrade_trigger
                _now = time.time()
                if _now - _last_poll_upgrade_trigger > 3600:
                    _last_poll_upgrade_trigger = _now
                    _latest_ver = poll_result.get("latest_proxy_version", "?")
                    print("%s [upgrade] proxy_upgrade_available in poll response — latest %s — triggering background update" % (_ts(), _latest_ver))
                    logger.info("poll — proxy upgrade signalled (latest %s) — triggering immediate update", _latest_ver)
                    def _do_poll_upgrade():
                        global _last_poll_upgrade_trigger, _stale_upgrade_count
                        try:
                            _nu, _rv, _du, _ck = check_for_update()
                            if _nu:
                                _stale_upgrade_count = 0
                                print("%s [upgrade] poll-triggered: downloading %s..." % (_ts(), _rv))
                                perform_update(_rv, _du, _ck)
                            else:
                                # Render deployment still in progress — back off before retry
                                _stale_upgrade_count += 1
                                _backoff = min(60 * _stale_upgrade_count, 600)
                                print("%s [upgrade] poll-triggered: Render still serving %s (attempt %d) — retry in %ds" % (
                                    _ts(), VERSION, _stale_upgrade_count, _backoff))
                                time.sleep(_backoff)
                                _last_poll_upgrade_trigger = 0.0
                        except Exception as _ue:
                            logger.warning("poll-triggered update failed: %s", _ue)
                    threading.Thread(target=_do_poll_upgrade, daemon=True, name="poll-upgrade").start()

            work = poll_result.get("work")
            if work is None:
                # No work — loop back to poll (this is the heartbeat)
                continue

            # ── Execute work locally ──
            request_id = work.get("request_id", "")
            method = work.get("method", "POST").upper()
            path = work.get("path", "/")
            body = work.get("body", {})

            print("%s [cloud] Received work: %s %s (req=%s)" % (_ts(), method, path, request_id[:8]))

            # Intercept proxy self-upgrade work item before dispatching locally.
            # Server enqueues this when proxy_version < LATEST_PROXY_VERSION.
            if path == "/api/self-upgrade" and body.get("proxy_upgrade"):
                _target_ver = body.get("target_version", "?")
                _dl_url = body.get("latest_proxy_url") or (api_url + "/oracle-proxy.py")
                print("%s [upgrade] proxy self-upgrade work item — target %s — initiating..." % (_ts(), _target_ver))
                def _do_witem_upgrade(_url=_dl_url, _ver=_target_ver):
                    global _last_poll_upgrade_trigger, _stale_upgrade_count
                    try:
                        _nu, _rv, _du, _ck = check_for_update()
                        if _nu:
                            _stale_upgrade_count = 0
                            print("%s [upgrade] work item: downloading %s..." % (_ts(), _rv))
                            perform_update(_rv, _du, _ck)
                        else:
                            # Render deployment still in progress — back off before retry
                            _stale_upgrade_count += 1
                            _backoff = min(60 * _stale_upgrade_count, 600)
                            print("%s [upgrade] work item: Render still serving %s (attempt %d) — retry in %ds" % (
                                _ts(), VERSION, _stale_upgrade_count, _backoff))
                            time.sleep(_backoff)
                            _last_poll_upgrade_trigger = 0.0
                    except Exception as _we:
                        print("%s [upgrade] work item error: %s" % (_ts(), _we))
                threading.Thread(target=_do_witem_upgrade, daemon=True, name="work-item-upgrade").start()
                local_result = {"status_code": 200, "body": {"ok": True, "message": "proxy upgrade initiated", "current_version": VERSION}}
            else:
                try:
                    local_result = _execute_local_request(method, path, body, api_key)
                except Exception as exec_err:
                    print("%s [cloud] Local execution error: %s" % (_ts(), exec_err))
                    local_result = {"status_code": 500, "body": {"error": str(exec_err)}}

            # ── Submit result ──
            try:
                respond_body = json.dumps({
                    "connection_id": int(conn_id),
                    "request_id": request_id,
                    "status_code": local_result.get("status_code", 200),
                    "body": local_result.get("body", {}),
                }).encode("utf-8")
                respond_req = Request(
                    "%s/api/agent/respond" % api_url,
                    data=respond_body,
                    headers={
                        "Content-Type": "application/json",
                        "X-TuneVault-Key": api_key,
                    },
                    method="POST",
                )
                urlopen(respond_req, timeout=15)
                print("%s [cloud] Result submitted for req=%s" % (_ts(), request_id[:8]))
            except Exception as submit_err:
                logger.warning("cloud — failed to submit result for req=%s: %s", request_id[:8], submit_err)

        except Exception as outer_err:
            logger.exception("cloud — unexpected error in poll loop: %s", outer_err)
            time.sleep(min(backoff, max_backoff))
            backoff = min(backoff * 2, max_backoff)


def _report_restart_reason(reason_code, last_stage, last_error, uptime_seconds):
    """POST a structured restart-reason record to the cloud before exiting.

    Best-effort — called from watchdog/exit paths. Never raises; 3s timeout so
    we don't hang the process. The server responds 200 immediately then persists
    async, so the agent can exit right after receiving any response or timeout.
    """
    api_url  = _CLOUD_API_URL
    conn_id  = _CLOUD_CONNECTION_ID
    api_key  = API_KEY

    if not api_url or not conn_id or not api_key:
        return  # outbound channel not configured — nothing to report

    import uuid as _uuid
    try:
        payload = json.dumps({
            "connection_id":       conn_id,
            "reason_code":         reason_code,
            "last_stage_reached":  last_stage,
            "last_error":          str(last_error)[:500] if last_error else None,
            "uptime_seconds":      int(uptime_seconds) if uptime_seconds is not None else None,
            "restart_sequence_id": str(_uuid.uuid4())[:16],
        }).encode("utf-8")
        req = Request(
            "%s/api/agent/restart-reason" % api_url,
            data=payload,
            headers={
                "Content-Type":   "application/json",
                "X-TuneVault-Key": api_key,
            },
            method="POST",
        )
        urlopen(req, timeout=3)
    except Exception as e:
        # Silently ignore — process is about to exit regardless
        logger.debug("restart-reason report failed (non-fatal): %s", e)


def _execute_local_request(method, path, body, api_key):
    """Forward a request to the local HTTP server at localhost:3100."""
    import socket

    body_bytes = json.dumps(body).encode("utf-8") if body else b""
    host = "127.0.0.1"
    port = PORT

    # Build raw HTTP request (avoids urllib overhead for localhost)
    headers = [
        "%s %s HTTP/1.1" % (method, path),
        "Host: localhost:%d" % port,
        "Content-Type: application/json",
        "Content-Length: %d" % len(body_bytes),
        "X-API-Key: %s" % api_key,
        "Connection: close",
    ]
    raw_request = ("\r\n".join(headers) + "\r\n\r\n").encode("utf-8") + body_bytes

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(120)  # match proxy's own timeout for health checks
    try:
        sock.connect((host, port))
        sock.sendall(raw_request)

        # Read response
        response = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            response += chunk
    finally:
        sock.close()

    # Parse HTTP response
    response_str = response.decode("utf-8", errors="replace")
    header_end = response_str.find("\r\n\r\n")
    if header_end == -1:
        return {"status_code": 502, "body": {"error": "Invalid response from local proxy"}}

    status_line = response_str.split("\r\n")[0]
    try:
        status_code = int(status_line.split(" ")[1])
    except (IndexError, ValueError):
        status_code = 200

    body_str = response_str[header_end + 4:]

    # Handle chunked transfer encoding
    headers_section = response_str[:header_end].lower()
    if "transfer-encoding: chunked" in headers_section:
        # Decode chunked encoding
        decoded = []
        remaining = body_str
        while remaining:
            # Find chunk size line
            nl_pos = remaining.find("\r\n")
            if nl_pos == -1:
                break
            size_str = remaining[:nl_pos].strip()
            if not size_str:
                remaining = remaining[nl_pos + 2:]
                continue
            try:
                chunk_size = int(size_str, 16)
            except ValueError:
                break
            if chunk_size == 0:
                break
            chunk_data = remaining[nl_pos + 2:nl_pos + 2 + chunk_size]
            decoded.append(chunk_data)
            remaining = remaining[nl_pos + 2 + chunk_size + 2:]  # skip \r\n after chunk
        body_str = "".join(decoded)

    try:
        parsed_body = json.loads(body_str)
    except (ValueError, TypeError):
        parsed_body = {"raw": body_str[:2000]}

    return {"status_code": status_code, "body": parsed_body}


def main():
    # ---- CLI argument parsing (Python 3.6 compatible, no argparse needed) ----
    args = sys.argv[1:]
    no_auto_update = "--no-auto-update" in args
    update_now = "--update-now" in args
    validate_only = "--validate-only" in args

    if validate_only:
        run_validate_only()
        return  # run_validate_only calls sys.exit internally; this line unreachable

    if update_now:
        # Immediate update check — perform update if available, then exit
        print("%s [auto-update] Checking for updates (--update-now)..." % _ts())
        try:
            needs_update, remote_version, download_url, expected_checksum = check_for_update()
            if needs_update:
                result = perform_update(remote_version, download_url, expected_checksum)
                # If perform_update returns (execv failed), exit non-zero
                sys.exit(1 if not result else 0)
            else:
                print("%s [auto-update] Already at latest version v%s." % (_ts(), VERSION))
                sys.exit(0)
        except Exception as e:
            print("%s [auto-update] ERROR: %s" % (_ts(), e))
            sys.exit(1)

    # ---- Normal startup — structured milestone logging ----
    # Each milestone: logs at INFO, wraps in try/except that logs full exception
    # and exits with a DISTINCT non-zero code so systemd transitions to `failed`
    # and `tunevault-agent doctor` can map exit code → cause.
    #
    # Exit code map:
    #   2  = auto-update thread crash (non-fatal, logged only)
    #   3  = HTTP server creation failed
    #   4  = env/API key validation failed
    #   5  = python deps check failed (cx_Oracle/requests import)
    #   6  = cloud DNS resolution failed (fatal when API URL configured)
    #   7  = cloud /api/health probe failed (fatal when API URL configured)
    #   8  = cloud poll thread start failed
    #  20  = watchdog: heartbeat silent > AGENT_WATCHDOG_RESTART_S (default 300s) — tier 3 escalation
    #         (previously: no heartbeat within 30s — now softened; tier 1=60s warn, tier 2=60–300s degraded)

    # Milestone 1: boot
    logger.info("agent boot — version=%s pid=%d", VERSION, os.getpid())

    # Milestone 2: env loaded
    try:
        key_prefixes = sorted(k[:8] + "..." for k in VALID_KEYS) if VALID_KEYS else ["(none)"]
        _resolved_host = HOST
        logger.info("env loaded — api_key_prefix=%s host=%s keys=%d",
                    key_prefixes[0] if key_prefixes else "(none)", _resolved_host, len(VALID_KEYS))
    except Exception:
        logger.exception("env loaded — FAILED")
        sys.exit(4)

    # Milestone 3: python deps
    try:
        import requests as _requests_mod
        _requests_version = _requests_mod.__version__
    except ImportError:
        _requests_version = "not-installed"
    _oracle_mode = "thick" if (_ORACLE_DRIVER == "cx_Oracle" or _ORACLEDB_THICK_MODE) else "thin"
    logger.info("python deps ok — %s=%s mode=%s requests=%s", _ORACLE_DRIVER or "oracle-driver", _ORACLE_VERSION, _oracle_mode, _requests_version)

    # Auto-update thread (non-fatal if it crashes)
    if not no_auto_update:
        try:
            updater = threading.Thread(target=auto_update_loop, daemon=True)
            updater.start()
            logger.info("auto-update enabled — checks every %ds (PROXY_UPDATE_INTERVAL); use --no-auto-update to disable", UPDATE_CHECK_INTERVAL)
        except Exception:
            logger.exception("auto-update thread start FAILED — continuing without auto-update")
    else:
        logger.info("auto-update disabled (--no-auto-update)")

    # Create HTTP server
    try:
        server = HTTPServer((HOST, PORT), ProxyHandler)
        logger.info("local http server bound — %s:%d", HOST, PORT)
    except Exception:
        logger.exception("HTTP server bind FAILED on %s:%d", HOST, PORT)
        sys.exit(3)

    # ── Cloud connectivity milestones — only when API URL + connection ID are set ──
    if _CLOUD_API_URL and _CLOUD_CONNECTION_ID:
        # Milestone 4: cloud DNS resolve
        try:
            import socket as _socket
            _dns_t0 = time.time()
            _cloud_host = _CLOUD_API_URL.replace("https://", "").replace("http://", "").split("/")[0]
            _cloud_ip = _socket.gethostbyname(_cloud_host)
            _dns_ms = int((time.time() - _dns_t0) * 1000)
            logger.info("cloud dns resolve — %s → %s in %dms", _cloud_host, _cloud_ip, _dns_ms)
        except Exception:
            logger.exception("cloud dns resolve FAILED — check network/DNS for %s", _CLOUD_API_URL)
            sys.exit(6)

        # Milestone 5: cloud /api/health reachability probe
        health_url = "%s/api/health" % _CLOUD_API_URL
        _api_reachable = False
        try:
            _health_t0 = time.time()
            health_req = Request(health_url, headers={"Accept": "application/json"}, method="GET")
            health_resp = urlopen(health_req, timeout=10)
            _api_status = health_resp.status if hasattr(health_resp, "status") else health_resp.getcode()
            _health_ms = int((time.time() - _health_t0) * 1000)
            if 200 <= _api_status < 300:
                _api_reachable = True
                logger.info("cloud reachability — GET /api/health → %d in %dms", _api_status, _health_ms)
            else:
                logger.error("cloud reachability — GET /api/health → %d (non-2xx) — refusing to start outbound channel", _api_status)
                sys.exit(7)
        except Exception:
            logger.exception("cloud reachability — GET /api/health FAILED — check TUNEVAULT_API_URL (%s) and network", _CLOUD_API_URL)
            sys.exit(7)

        # Milestone 6: register (logged by _cloud_poll_loop on first successful poll)
        # Milestone 7: long-poll loop entered
        try:
            _boot_time = time.time()

            # ── 3-tier watchdog ────────────────────────────────────────────────
            # Tier 1 (0 → DEGRADED_S): wait for first heartbeat; log warning if missed.
            # Tier 2 (DEGRADED_S → RESTART_S): keep agent alive, log degraded, apply
            #   jittered backoff in the poll loop; Oracle probes still run unaffected.
            # Tier 3 (> RESTART_S): report restart_reason then exit(20) for systemd.
            #
            # WHY NOT exit on first miss: a 60–90s transient (TLS renegotiation, LB
            # 502, cloud rate limiter) would previously cause a loop. We now absorb it.
            def _watchdog():
                global _last_poll_ok_time, _poll_stage

                degraded_s = _WATCHDOG_DEGRADED_S
                restart_s  = _WATCHDOG_RESTART_S

                logger.info(
                    "watchdog started — degraded_threshold=%ds restart_threshold=%ds backoff_max=%ds",
                    degraded_s, restart_s, _POLL_BACKOFF_MAX_S,
                )

                # Phase A: wait for first heartbeat (up to degraded_s from boot)
                got_first = _first_heartbeat_event.wait(timeout=degraded_s)
                if got_first:
                    logger.debug("watchdog — first heartbeat received within %ds tier-1 window", degraded_s)
                else:
                    logger.warning(
                        "watchdog — no heartbeat within %ds (tier 1 degraded) — staying alive, "
                        "will restart after %ds total", degraded_s, restart_s,
                    )

                # Phase B: continuous monitoring — measure silence since last successful poll
                while True:
                    time.sleep(10)  # check every 10s

                    with _poll_state_lock:
                        last_ok    = _last_poll_ok_time
                        cur_stage  = _poll_stage

                    now = time.time()
                    if last_ok is not None:
                        silence_s = now - last_ok
                    else:
                        # Still never had a successful poll — measure from boot
                        silence_s = now - _boot_time

                    if silence_s < degraded_s:
                        # All clear — heartbeats flowing
                        continue

                    if silence_s < restart_s:
                        # Tier 2: degraded — warn but stay alive
                        logger.warning(
                            "watchdog — heartbeat silent for %.0fs (degraded, tier 2) — "
                            "oracle probes continuing; will restart at %.0fs",
                            silence_s, restart_s,
                        )
                        continue

                    # Tier 3: > restart_s of continuous silence → exit
                    uptime = now - _boot_time
                    logger.critical(
                        "watchdog — heartbeat silent for %.0fs (> %ds threshold, tier 3) — "
                        "exiting for systemd restart",
                        silence_s, restart_s,
                    )
                    _report_restart_reason(
                        reason_code="watchdog_timeout",
                        last_stage=cur_stage,
                        last_error="No successful poll in %.0fs (threshold %ds)" % (silence_s, restart_s),
                        uptime_seconds=int(uptime),
                    )
                    sys.exit(20)

            _wd_thread = threading.Thread(target=_watchdog, daemon=True, name="heartbeat-watchdog")
            _wd_thread.start()

            cloud_thread = threading.Thread(target=_cloud_poll_loop, daemon=True)
            cloud_thread.start()
            logger.info("long-poll loop entered — interval=25s connection=%s", _CLOUD_CONNECTION_ID)
        except Exception:
            logger.exception("cloud poll thread start FAILED")
            sys.exit(8)
    else:
        logger.info("outbound channel disabled — TUNEVAULT_API_URL / TUNEVAULT_CONNECTION_ID not set; proxy ready for local use")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutdown requested — stopping proxy")
        server.shutdown()


if __name__ == "__main__":
    main()
