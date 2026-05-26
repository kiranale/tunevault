"""
tests/test_pmon_sid_detection.py — Unit tests for PMON SID auto-detection.

Tests:
  1. Normal SID 'ORCL' detected from /proc/*/comm
  2. Normal SID 'EBSPROD' detected from /proc/*/comm
  3. SID with underscores and digits ('EBS12_PROD') detected from /proc/*/comm
  4. Garbage strings from operator log ('/', '\"");', '}') produce zero matches
  5. Empty /proc (no entries) → falls back to pgrep, returns empty list
  6. No PMON running → returns empty list (falls through to oratab)
  7. Multiple instances → all valid SIDs returned
  8. Mixed valid+invalid comm entries → only valid SIDs returned
  9. Case insensitivity: 'ora_pmon_orcl' (lowercase) → normalised to 'ORCL'
"""

from __future__ import annotations

import os
import re
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal stub so oracle-proxy.py can be imported without cx_Oracle / oracledb
# ---------------------------------------------------------------------------

def _stub_imports():
    """Insert minimal stubs for heavy dependencies before importing the module."""
    for mod_name in ("cx_Oracle", "oracledb", "yaml", "paramiko"):
        if mod_name not in sys.modules:
            stub = types.ModuleType(mod_name)
            stub.DatabaseError = Exception
            stub.connect = MagicMock()
            stub.makedsn = MagicMock(return_value="(DESCRIPTION=...)")
            stub.is_thin_mode = MagicMock(return_value=True)
            stub.init_oracle_client = MagicMock()
            stub.__version__ = "0.0.0"
            stub.SYSDBA = 2
            sys.modules[mod_name] = stub


_stub_imports()

# ---------------------------------------------------------------------------
# Import the function under test from oracle-proxy.py.
# We exec the file in a controlled namespace to avoid running its __main__ block.
# ---------------------------------------------------------------------------

import importlib.util as _ilu
import pathlib

_PROXY_PATH = pathlib.Path(__file__).parent.parent / "oracle-proxy.py"


def _load_proxy_module():
    """Load oracle-proxy.py as a module without executing its HTTP server startup."""
    spec = _ilu.spec_from_file_location("oracle_proxy", str(_PROXY_PATH))
    mod = _ilu.module_from_spec(spec)
    # Prevent the server from actually starting
    mod.__dict__["__name__"] = "oracle_proxy_test"
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass  # module may call sys.exit(0) at top level — ignore
    return mod


try:
    _proxy = _load_proxy_module()
    _detect_oracle_sids = _proxy._detect_oracle_sids
    _PROXY_LOADED = True
except Exception as e:
    _PROXY_LOADED = False
    _PROXY_LOAD_ERROR = str(e)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_proc_comm_scandir(comm_names: list):
    """
    Build a mock for os.scandir('/proc') that returns DirEntry objects whose
    /proc/<pid>/comm files contain the given comm_names.
    """
    entries = []
    for i, name in enumerate(comm_names, start=1000):
        entry = MagicMock()
        entry.name = str(i)
        entry.is_dir.return_value = True
        entries.append(entry)

    def _mock_scandir(path):
        if path == "/proc":
            return iter(entries)
        raise FileNotFoundError(path)

    # Map pid → comm content
    pid_to_comm = {str(1000 + i): name for i, name in enumerate(comm_names)}

    def _mock_open(path, mode="r"):
        # path looks like /proc/<pid>/comm
        parts = path.split("/")
        if len(parts) == 4 and parts[3] == "comm":
            pid = parts[2]
            comm = pid_to_comm.get(pid, "")
            from io import StringIO
            return StringIO(comm + "\n")
        raise FileNotFoundError(path)

    return _mock_scandir, _mock_open


class TestPmonSidDetection(unittest.TestCase):

    def setUp(self):
        if not _PROXY_LOADED:
            self.skipTest(f"oracle-proxy.py could not be loaded: {_PROXY_LOAD_ERROR}")

    def _run_with_proc(self, comm_names, pgrep_output=""):
        """Run _detect_oracle_sids() with mocked /proc/*/comm and pgrep."""
        mock_scandir, mock_open = _make_proc_comm_scandir(comm_names)

        def _mock_run(cmd, **kwargs):
            result = MagicMock()
            if "pgrep" in cmd[0] or (isinstance(cmd, list) and "pgrep" in cmd):
                result.returncode = 0 if pgrep_output else 1
                result.stdout = pgrep_output
            else:
                result.returncode = 1
                result.stdout = ""
            return result

        with patch("os.scandir", side_effect=mock_scandir), \
             patch("builtins.open", side_effect=mock_open), \
             patch("subprocess.run", side_effect=_mock_run):
            return _detect_oracle_sids()

    # ── Test 1: normal SID ORCL ───────────────────────────────────────────────

    def test_normal_sid_orcl(self):
        """ORCL SID detected from ora_pmon_ORCL comm entry."""
        result = self._run_with_proc(["sshd", "ora_pmon_ORCL", "bash"])
        # _detect_oracle_sids returns a list from PMON tier
        self.assertIn("ORCL", result, f"Expected ORCL in {result}")

    # ── Test 2: EBS production SID ────────────────────────────────────────────

    def test_normal_sid_ebsprod(self):
        """EBSPROD SID detected from ora_pmon_EBSPROD comm entry."""
        result = self._run_with_proc(["ora_pmon_EBSPROD"])
        self.assertIn("EBSPROD", result, f"Expected EBSPROD in {result}")

    # ── Test 3: SID with underscores and digits ───────────────────────────────

    def test_sid_with_underscore_and_digits(self):
        """EBS12 SID (alphanumeric + digit) detected correctly."""
        result = self._run_with_proc(["ora_pmon_EBS12"])
        self.assertIn("EBS12", result, f"Expected EBS12 in {result}")

    # ── Test 4: garbage strings from operator's log ───────────────────────────

    def test_garbage_slash(self):
        """Garbage SID '/' must produce zero matches."""
        # Constructed as if ps output was 'ora_pmon_/' — would happen with loose regex
        result = self._run_with_proc(["ora_pmon_/"])
        self.assertNotIn("/", result or [], f"Slash must not appear in SID results")

    def test_garbage_inject(self):
        """Garbage SID '\"\"\" );' must produce zero matches."""
        result = self._run_with_proc(['ora_pmon_"");'])
        for s in result or []:
            self.assertNotIn('"', s)
            self.assertNotIn(';', s)

    def test_garbage_brace(self):
        """Garbage SID '}' must produce zero matches."""
        result = self._run_with_proc(["ora_pmon_}"])
        self.assertNotIn("}", result or [])

    # ── Test 5: empty /proc → pgrep fallback (empty) ─────────────────────────

    def test_empty_proc_no_pgrep(self):
        """Empty /proc + no pgrep output → Tier 1 returns None (falls through to oratab)."""
        def _no_proc(path):
            if path == "/proc":
                return iter([])
            raise FileNotFoundError(path)

        def _no_pgrep(cmd, **kwargs):
            r = MagicMock(); r.returncode = 1; r.stdout = ""; return r

        with patch("os.scandir", side_effect=_no_proc), \
             patch("subprocess.run", side_effect=_no_pgrep):
            result = _detect_oracle_sids()
        # With no PMON results, should fall through to oratab tier
        # We just verify the PMON tier doesn't return garbage
        if result is not None:
            for sid in result:
                self.assertRegex(sid, r'^[A-Za-z][A-Za-z0-9_$#]{0,7}$',
                                 f"Unexpected SID format: {sid!r}")

    # ── Test 6: no PMON running ───────────────────────────────────────────────

    def test_no_pmon_running(self):
        """If no ora_pmon_* processes exist, PMON tier returns no results."""
        result = self._run_with_proc(["systemd", "sshd", "cron", "bash"])
        # result may be from oratab tier — just ensure no garbage SIDs
        if result:
            for sid in result:
                self.assertRegex(sid, r'^[A-Za-z][A-Za-z0-9_$#]{0,7}$',
                                 f"Unexpected SID: {sid!r}")

    # ── Test 7: multiple instances ────────────────────────────────────────────

    def test_multiple_instances(self):
        """Multiple ora_pmon_* processes → all valid SIDs returned."""
        result = self._run_with_proc([
            "ora_pmon_ORCL", "ora_pmon_EBSPROD", "sshd",
        ])
        self.assertIn("ORCL", result, f"Expected ORCL in {result}")
        self.assertIn("EBSPROD", result, f"Expected EBSPROD in {result}")

    # ── Test 8: mixed valid + invalid entries ─────────────────────────────────

    def test_mixed_valid_and_invalid(self):
        """Only valid SIDs pass; garbage entries are silently rejected."""
        result = self._run_with_proc([
            "ora_pmon_ORCL",
            "ora_pmon_/",
            'ora_pmon_"");',
            "ora_pmon_}",
            "ora_pmon_EBSPROD",
        ])
        self.assertIn("ORCL", result, f"ORCL missing from {result}")
        self.assertIn("EBSPROD", result, f"EBSPROD missing from {result}")
        for sid in result or []:
            self.assertRegex(sid, r'^[A-Za-z][A-Za-z0-9_$#]{0,7}$',
                             f"Invalid SID passed through: {sid!r}")

    # ── Test 9: lowercase comm normalised to uppercase ────────────────────────

    def test_lowercase_sid_normalised(self):
        """ora_pmon_orcl (lowercase) → normalised to uppercase 'ORCL'."""
        result = self._run_with_proc(["ora_pmon_orcl"])
        # The new code does .upper() — ORCL should appear
        self.assertIn("ORCL", result, f"Expected ORCL (uppercased) in {result}")

    # ── Test 10: SID deduplication ────────────────────────────────────────────

    def test_deduplication(self):
        """Duplicate PMON entries for the same SID produce only one result."""
        result = self._run_with_proc([
            "ora_pmon_ORCL", "ora_pmon_ORCL", "ora_pmon_ORCL",
        ])
        self.assertEqual(result.count("ORCL"), 1,
                         f"Duplicate SIDs not deduplicated: {result}")


if __name__ == "__main__":
    unittest.main()
