"""
tests/test_doctor_command.py — Unit tests for `tunevault-agent doctor`.

Owns: asserting cmd_doctor output format and exit codes under mocked subsystems.
Does NOT own: integration testing against live Oracle or TuneVault cloud.

Tests:
  1. Happy path — all 6 checks PASS → exit 0 + PASS markers in output
  2. agent.env missing → AGENT IDENTITY FAIL → exit 1
  3. Cloud unreachable (timeout) → CLOUD REACHABLE FAIL → exit 1
  4. API key rejected (HTTP 401) → REGISTRATION FAIL → exit 1
  5. Heartbeat stale → HEARTBEAT FAIL → exit 1
  6. Oracle TCP connect refused → ORACLE TCP FAIL → exit 1
  7. --json flag → output is valid JSON with 'checks' array
  8. SKIP behaviour — no Oracle host in env → ORACLE TCP SKIP, exit 0
  9. Last error SKIP when journalctl finds no errors
"""

from __future__ import annotations

import io
import json
import sys
import types
import unittest
from unittest.mock import MagicMock, patch, mock_open


# ---------------------------------------------------------------------------
# Stub heavy imports so agent.cli can be imported in CI without Oracle/paramiko
# ---------------------------------------------------------------------------

def _stub_imports() -> None:
    for mod_name in ("oracledb", "cx_Oracle", "paramiko", "yaml"):
        if mod_name not in sys.modules:
            stub = types.ModuleType(mod_name)
            stub.DatabaseError = Exception
            stub.connect = MagicMock()
            stub.is_thin_mode = MagicMock(return_value=True)
            stub.init_oracle_client = MagicMock()
            stub.__version__ = "0.0.0"
            stub.SYSDBA = 2
            stub.safe_load = MagicMock(return_value={})
            sys.modules[mod_name] = stub


_stub_imports()

from agent.cli import cmd_doctor  # noqa: E402  (import after stub setup)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GOOD_ENV = (
    "TUNEVAULT_API_KEY=tvp_fakekeyABCDEFGHIJKLMNOP\n"
    "TUNEVAULT_API_URL=https://tunevault.app\n"
    "TUNEVAULT_CONNECTION_ID=42\n"
    "ORACLE_HOST=db.example.com\n"
    "ORACLE_PORT=1521\n"
)

_GOOD_HEALTH_RESP = b'{"status":"ok"}'
_GOOD_STATUS_RESP = b'{"registered":true,"status":"active"}'
_GOOD_HB_RESP     = b'{"alive":true,"seconds_ago":15,"last_heartbeat_at":"2026-05-25T07:00:00Z"}'


def _make_args(json_flag: bool = False) -> MagicMock:
    args = MagicMock()
    args.json = json_flag
    args.config = None
    return args


def _fake_url_open(url_responses: dict):
    """Return a context-manager factory that serves pre-canned responses by URL substring."""
    import urllib.request as _ureq

    class _FakeResp:
        def __init__(self, body: bytes, status: int = 200):
            self._body = body
            self.status = status

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

    def _urlopen(req, timeout=10):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        for key, (body, status) in url_responses.items():
            if key in url:
                return _FakeResp(body, status)
        raise Exception(f"No mock for URL: {url}")

    return _urlopen


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDoctorHappyPath(unittest.TestCase):
    """All subsystems healthy — exit 0, all PASS markers present."""

    def test_happy_path_exit_0(self):
        url_map = {
            "/api/health":            (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":      (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (_GOOD_HB_RESP, 200),
        }
        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("socket.create_connection", return_value=MagicMock()),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 0, msg=f"Expected exit 0, got {rc}. Output:\n{output}")
        self.assertIn("[PASS]", output)
        self.assertNotIn("[FAIL]", output)

    def test_happy_path_json_output(self):
        url_map = {
            "/api/health":                (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":          (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (_GOOD_HB_RESP, 200),
        }
        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("socket.create_connection", return_value=MagicMock()),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args(json_flag=True))
        output = mock_out.getvalue()
        self.assertEqual(rc, 0)
        data = json.loads(output)
        self.assertIn("checks", data)
        self.assertIn("ok", data)
        self.assertTrue(data["ok"])
        checks = {c["check"]: c["status"] for c in data["checks"]}
        self.assertEqual(checks["AGENT IDENTITY"], "PASS")
        self.assertEqual(checks["CLOUD REACHABLE"], "PASS")
        self.assertEqual(checks["REGISTRATION"], "PASS")
        self.assertEqual(checks["HEARTBEAT"], "PASS")
        self.assertEqual(checks["ORACLE TCP"], "PASS")


class TestDoctorAgentEnvMissing(unittest.TestCase):
    """agent.env not found → AGENT IDENTITY FAIL → exit 1."""

    def test_missing_env_file(self):
        with (
            patch("builtins.open", side_effect=FileNotFoundError("/etc/tunevault/agent.env")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL]", output)
        self.assertIn("AGENT IDENTITY", output)


class TestDoctorCloudUnreachable(unittest.TestCase):
    """Cloud HTTPS unreachable → CLOUD REACHABLE FAIL → exit 1."""

    def test_cloud_timeout(self):
        import socket as _socket

        def _bad_urlopen(req, timeout=10):
            raise _socket.timeout("timed out")

        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_bad_urlopen),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("CLOUD REACHABLE", output)
        self.assertIn("[FAIL]", output)


class TestDoctorRegistrationFail(unittest.TestCase):
    """API key rejected (401) → REGISTRATION FAIL → exit 1."""

    def test_api_key_rejected(self):
        import urllib.error as _uerr

        def _urlopen_401(req, timeout=10):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "/api/health" in url:
                class _Ok:
                    status = 200
                    def read(self): return b'{"status":"ok"}'
                    def __enter__(self): return self
                    def __exit__(self, *a): pass
                return _Ok()
            exc = _uerr.HTTPError(url, 401, "Unauthorized", {}, None)
            raise exc

        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_urlopen_401),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("REGISTRATION", output)
        self.assertIn("[FAIL]", output)


class TestDoctorHeartbeatStale(unittest.TestCase):
    """Heartbeat stale (alive=false) → HEARTBEAT FAIL → exit 1."""

    def test_stale_heartbeat(self):
        stale_hb = b'{"alive":false,"seconds_ago":300,"last_heartbeat_at":"2026-05-25T06:00:00Z"}'
        url_map = {
            "/api/health":                (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":          (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (stale_hb, 200),
        }
        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("socket.create_connection", return_value=MagicMock()),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("HEARTBEAT", output)
        self.assertIn("[FAIL]", output)


class TestDoctorOracleTcpFail(unittest.TestCase):
    """Oracle TCP connect refused → ORACLE TCP FAIL → exit 1."""

    def test_tcp_connection_refused(self):
        import socket as _socket

        url_map = {
            "/api/health":                (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":          (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (_GOOD_HB_RESP, 200),
        }

        def _bad_connect(addr, timeout=None):
            raise OSError(111, "Connection refused")

        with (
            patch("builtins.open", mock_open(read_data=_GOOD_ENV)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("socket.create_connection", side_effect=_bad_connect),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("ORACLE TCP", output)
        self.assertIn("[FAIL]", output)


class TestDoctorOracleTcpSkip(unittest.TestCase):
    """No Oracle host in agent.env → ORACLE TCP SKIP → exit 0."""

    def test_no_oracle_host_skip(self):
        env_no_host = (
            "TUNEVAULT_API_KEY=tvp_fakekeyABCDEFGHIJKLMNOP\n"
            "TUNEVAULT_API_URL=https://tunevault.app\n"
            "TUNEVAULT_CONNECTION_ID=42\n"
            # no ORACLE_HOST
        )
        url_map = {
            "/api/health":                (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":          (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (_GOOD_HB_RESP, 200),
        }
        with (
            patch("builtins.open", mock_open(read_data=env_no_host)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args())
        output = mock_out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("ORACLE TCP", output)
        self.assertIn("[SKIP]", output)


class TestDoctorJsonStructure(unittest.TestCase):
    """--json output always has required keys and one entry per check."""

    def test_json_keys_present(self):
        env_no_host = (
            "TUNEVAULT_API_KEY=tvp_fakekeyABCDEFGHIJKLMNOP\n"
            "TUNEVAULT_API_URL=https://tunevault.app\n"
            "TUNEVAULT_CONNECTION_ID=42\n"
        )
        url_map = {
            "/api/health":                (_GOOD_HEALTH_RESP, 200),
            "/api/agent/status":          (_GOOD_STATUS_RESP, 200),
            "/api/agent/heartbeat-check": (_GOOD_HB_RESP, 200),
        }
        with (
            patch("builtins.open", mock_open(read_data=env_no_host)),
            patch("urllib.request.urlopen", side_effect=_fake_url_open(url_map)),
            patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="", stderr="")),
            patch("sys.stdout", new_callable=io.StringIO) as mock_out,
        ):
            rc = cmd_doctor(_make_args(json_flag=True))
        data = json.loads(mock_out.getvalue())
        for key in ("version", "ran_at", "ok", "checks"):
            self.assertIn(key, data)
        for check in data["checks"]:
            for field in ("check", "status", "detail"):
                self.assertIn(field, check)
        check_names = [c["check"] for c in data["checks"]]
        self.assertIn("AGENT IDENTITY", check_names)
        self.assertIn("CLOUD REACHABLE", check_names)
        self.assertIn("REGISTRATION", check_names)
        self.assertIn("HEARTBEAT", check_names)
        self.assertIn("ORACLE TCP", check_names)
        self.assertIn("LAST ERROR", check_names)


if __name__ == "__main__":
    unittest.main()
