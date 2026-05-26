"""
tests/test_thick_fallback.py — Unit tests for DPY-3015 / ORA-28040 thick-mode fallback.

Tests:
  1. is_verifier_mismatch() correctly classifies DPY-3015, DPY-3001, ORA-28040,
     ORA-01017 with 11g markers, and does NOT misclassify plain password failures.
  2. oracle_worker._try_thick_fallback() succeeds when bootstrap + retry both succeed.
  3. oracle_worker._try_thick_fallback() fails gracefully when bootstrap fails.
  4. oracle_worker.run_oracle_worker() calls thick fallback exactly once on DPY-3015.
  5. Pre-warm path: if ORACLE_THICK_MODE=true in agent.env, bootstrap is called at start.
  6. AgentState.set_thick_mode() updates oracle_mode / instant_client_path / workaround fields.
  7. /agent/health endpoint returns correct oracle_mode from AgentState.
"""

from __future__ import annotations

import threading
import types
import unittest
from unittest.mock import MagicMock, patch, call


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_dpy_exc(code: str) -> Exception:
    """Construct a mock oracledb exception with a DPY- error code in its message."""
    exc = Exception(f"({code}) Error connecting in thin mode: unsupported protocol")
    return exc


def _make_ora_exc(code: int, extra: str = "") -> Exception:
    msg = f"ORA-{code:05d}: {extra or 'login failed'}"
    return Exception(msg)


# ── 1. is_verifier_mismatch() classification ──────────────────────────────────

class TestIsVerifierMismatch(unittest.TestCase):

    def _fn(self, msg: str) -> bool:
        from agent.bootstrap import is_verifier_mismatch
        return is_verifier_mismatch(msg)

    def test_dpy_3015_matches(self):
        self.assertTrue(self._fn("(DPY-3015) Error connecting in thin mode"))

    def test_dpy_3001_matches(self):
        self.assertTrue(self._fn("(DPY-3001) some thin mode restriction"))

    def test_ora_28040_matches(self):
        self.assertTrue(self._fn("ORA-28040: No matching authentication protocol"))

    def test_ora_01017_with_11g_marker_matches(self):
        # The 11g verifier marker present alongside ORA-01017
        self.assertTrue(self._fn(
            "ORA-01017: invalid username/password; "
            "authentication protocol requested by client not supported by server"
        ))

    def test_ora_01017_with_o5logon_marker_matches(self):
        self.assertTrue(self._fn("ORA-01017: o5logon protocol mismatch"))

    def test_ora_01017_plain_password_does_not_match(self):
        # Plain ORA-01017 without any verifier context must NOT trigger thick fallback
        self.assertFalse(self._fn("ORA-01017: invalid username/password"))

    def test_ora_12541_does_not_match(self):
        self.assertFalse(self._fn("ORA-12541: TNS: no listener"))

    def test_ora_12514_does_not_match(self):
        self.assertFalse(self._fn("ORA-12514: TNS: listener does not currently know of service"))

    def test_empty_string_does_not_match(self):
        self.assertFalse(self._fn(""))

    def test_generic_exception_does_not_match(self):
        self.assertFalse(self._fn("Connection refused"))


# ── 2. AgentState thick mode fields ──────────────────────────────────────────

class TestAgentStateThickMode(unittest.TestCase):

    def _make_state(self):
        from agent.oracle_worker import AgentState
        return AgentState()

    def test_initial_state_is_thin(self):
        state = self._make_state()
        fields = state.get_health_fields()
        self.assertEqual(fields["oracle_mode"], "thin")
        self.assertIsNone(fields["instant_client_path"])
        self.assertFalse(fields["verifier_workaround_active"])

    def test_set_thick_mode_updates_fields(self):
        state = self._make_state()
        state.set_thick_mode("/opt/tunevault/instantclient")
        fields = state.get_health_fields()
        self.assertEqual(fields["oracle_mode"], "thick")
        self.assertEqual(fields["instant_client_path"], "/opt/tunevault/instantclient")
        self.assertTrue(fields["verifier_workaround_active"])

    def test_heartbeat_fields_include_mode(self):
        state = self._make_state()
        state.set_thick_mode("/opt/tunevault/instantclient")
        hb = state.get_heartbeat_fields()
        self.assertEqual(hb["oracle_mode"], "thick")
        self.assertTrue(hb["verifier_workaround_active"])


# ── 3. _try_thick_fallback() — bootstrap succeeds, retry succeeds ──────────

class TestTryThickFallbackSuccess(unittest.TestCase):

    @patch("agent.bootstrap.ensure_thick_client")
    @patch("agent.oracle_worker.db")
    def test_bootstrap_and_retry_succeed(self, mock_db_module, mock_ensure):
        """When bootstrap and retry both succeed, ok=True and state is updated."""
        from agent.oracle_worker import AgentState, _try_thick_fallback

        mock_ensure.return_value = {
            "ok": True,
            "lib_dir": "/opt/tunevault/instantclient",
            "source": "downloaded",
            "attempted_actions": ["Downloaded RPMs", "init_oracle_client called"],
            "error": None,
        }

        # Set up db.ping to succeed on the retry
        mock_ping = MagicMock(return_value={
            "ok": True,
            "latency_ms": 42,
            "oracle_version": "11.2.0.4",
            "error": None,
        })
        mock_db_cfg = MagicMock()

        import agent.oracle_worker as ow
        original_db = ow.db if hasattr(ow, "db") else None

        state = AgentState()

        # Patch only what _try_thick_fallback imports internally
        with patch("agent.db.ping", mock_ping), \
             patch("agent.db.DBConfig", return_value=mock_db_cfg):
            result = _try_thick_fallback(
                state=state,
                db_host="myhost",
                db_port=1521,
                db_service_name="EBSDEV",
                db_username="apps",
                db_password="secret",
                api_url="https://tunevault.example.com",
            )

        self.assertTrue(result["ok"])
        self.assertIsNone(result["error"])
        self.assertEqual(state.oracle_mode, "thick")
        self.assertEqual(state.instant_client_path, "/opt/tunevault/instantclient")
        self.assertTrue(state.verifier_workaround_active)


# ── 4. _try_thick_fallback() — bootstrap fails ────────────────────────────

class TestTryThickFallbackBootstrapFail(unittest.TestCase):

    @patch("agent.bootstrap.ensure_thick_client")
    def test_bootstrap_failure_returns_ok_false(self, mock_ensure):
        """When bootstrap fails, ok=False is returned and state is not updated."""
        from agent.oracle_worker import AgentState, _try_thick_fallback

        mock_ensure.return_value = {
            "ok": False,
            "lib_dir": None,
            "source": "download_failed",
            "attempted_actions": ["Tried to download RPMs", "503 from mirror"],
            "error": "IC mirror unavailable: connection refused",
        }

        state = AgentState()

        result = _try_thick_fallback(
            state=state,
            db_host="myhost",
            db_port=1521,
            db_service_name="EBSDEV",
            db_username="apps",
            db_password="secret",
            api_url="https://tunevault.example.com",
        )

        self.assertFalse(result["ok"])
        self.assertIn("mirror", result["error"])
        # State must NOT be updated to thick mode
        self.assertEqual(state.oracle_mode, "thin")
        self.assertFalse(state.verifier_workaround_active)


# ── 5. run_oracle_worker: fallback called exactly once on DPY-3015 ──────────

class TestOracleWorkerThickFallbackLoop(unittest.TestCase):

    def test_thick_fallback_attempted_once_on_dpy_3015(self):
        """DPY-3015 triggers fallback on first connect; not on subsequent loops."""
        from agent.oracle_worker import AgentState, run_oracle_worker
        from agent.bootstrap import is_verifier_mismatch

        stop_event = threading.Event()
        state = AgentState()

        fallback_call_count = 0

        def mock_ping(cfg, timeout_s=10.0):
            return {"ok": False, "latency_ms": 1, "oracle_version": None, "error": "(DPY-3015) thin mode unsupported"}

        def mock_try_thick(state, db_host, db_port, db_service_name, db_username, db_password, api_url):
            nonlocal fallback_call_count
            fallback_call_count += 1
            # Signal stop after first fallback attempt
            stop_event.set()
            return {
                "ok": False,
                "bootstrap": {
                    "lib_dir": None,
                    "attempted_actions": [],
                },
                "retry_error": "still failing",
                "error": "still failing",
            }

        with patch("agent.db.ping", mock_ping), \
             patch("agent.db.DBConfig", return_value=MagicMock()), \
             patch("agent.oracle_worker._try_thick_fallback", side_effect=mock_try_thick), \
             patch("agent.bootstrap.should_try_thick_at_start", return_value=False):
            run_oracle_worker(
                state=state,
                db_host="host",
                db_port=1521,
                db_service_name="EBSDEV",
                db_username="apps",
                db_password="pw",
                stop_event=stop_event,
                retry_interval_s=0.01,
                api_url="https://tunevault.example.com",
            )

        # Fallback should have been attempted exactly once
        self.assertEqual(fallback_call_count, 1)

    def test_no_thick_fallback_on_plain_ora_01017(self):
        """Plain ORA-01017 (wrong password) must NOT trigger thick fallback."""
        from agent.oracle_worker import AgentState, run_oracle_worker

        stop_event = threading.Event()
        state = AgentState()
        fallback_call_count = 0

        def mock_ping(cfg, timeout_s=10.0):
            stop_event.set()  # stop after first attempt
            return {"ok": False, "latency_ms": 1, "oracle_version": None,
                    "error": "ORA-01017: invalid username/password"}

        def mock_try_thick(*args, **kwargs):
            nonlocal fallback_call_count
            fallback_call_count += 1
            return {"ok": False, "error": "should not be called"}

        with patch("agent.db.ping", mock_ping), \
             patch("agent.db.DBConfig", return_value=MagicMock()), \
             patch("agent.oracle_worker._try_thick_fallback", side_effect=mock_try_thick), \
             patch("agent.bootstrap.should_try_thick_at_start", return_value=False):
            run_oracle_worker(
                state=state,
                db_host="host",
                db_port=1521,
                db_service_name="EBSDEV",
                db_username="apps",
                db_password="wrong_pw",
                stop_event=stop_event,
                retry_interval_s=0.01,
                api_url="https://tunevault.example.com",
            )

        self.assertEqual(fallback_call_count, 0, "Thick fallback must not fire on plain ORA-01017")


# ── 6. Pre-warm path ─────────────────────────────────────────────────────────

class TestPreWarmThickMode(unittest.TestCase):

    def test_prewarm_calls_ensure_thick_at_start(self):
        """If ORACLE_THICK_MODE=true in agent.env, ensure_thick_client is called before first connect."""
        from agent.oracle_worker import AgentState, run_oracle_worker

        stop_event = threading.Event()
        state = AgentState()
        bootstrap_called = threading.Event()

        def mock_ensure(api_url=None):
            bootstrap_called.set()
            return {
                "ok": True,
                "lib_dir": "/opt/tunevault/instantclient",
                "source": "existing",
                "attempted_actions": ["Found existing libclntsh.so"],
                "error": None,
            }

        def mock_ping(cfg, timeout_s=10.0):
            stop_event.set()
            return {"ok": True, "latency_ms": 5, "oracle_version": "11.2.0.4", "error": None}

        with patch("agent.bootstrap.should_try_thick_at_start", return_value=True), \
             patch("agent.bootstrap.ensure_thick_client", side_effect=mock_ensure), \
             patch("agent.db.ping", mock_ping), \
             patch("agent.db.DBConfig", return_value=MagicMock()):
            run_oracle_worker(
                state=state,
                db_host="host",
                db_port=1521,
                db_service_name="EBSDEV",
                db_username="apps",
                db_password="pw",
                stop_event=stop_event,
                retry_interval_s=0.01,
                api_url="https://tunevault.example.com",
            )

        self.assertTrue(bootstrap_called.is_set(), "ensure_thick_client must be called on pre-warm")


# ── 7. /agent/health endpoint ─────────────────────────────────────────────────

class TestAgentHealthEndpoint(unittest.TestCase):

    def test_health_endpoint_returns_thin_by_default(self):
        from agent.poll import _handle_agent_health, PollConfig
        from agent.oracle_worker import AgentState

        state = AgentState()
        cfg = PollConfig(
            api_url="https://tunevault.example.com",
            api_key="testkey123456789012345678901234",
            connection_id=99,
            agent_state=state,
        )

        with patch("oracledb.is_thin_mode", return_value=True):
            result = _handle_agent_health(cfg)

        self.assertEqual(result["status_code"], 200)
        body = result["body"]
        self.assertEqual(body["oracle_mode"], "thin")
        self.assertFalse(body["verifier_workaround_active"])
        self.assertIsNone(body["instant_client_path"])

    def test_health_endpoint_returns_thick_after_bootstrap(self):
        from agent.poll import _handle_agent_health, PollConfig
        from agent.oracle_worker import AgentState

        state = AgentState()
        state.set_thick_mode("/opt/tunevault/instantclient")
        cfg = PollConfig(
            api_url="https://tunevault.example.com",
            api_key="testkey123456789012345678901234",
            connection_id=99,
            agent_state=state,
        )

        with patch("oracledb.is_thin_mode", return_value=False):
            result = _handle_agent_health(cfg)

        self.assertEqual(result["status_code"], 200)
        body = result["body"]
        self.assertEqual(body["oracle_mode"], "thick")
        self.assertTrue(body["verifier_workaround_active"])
        self.assertEqual(body["instant_client_path"], "/opt/tunevault/instantclient")


if __name__ == "__main__":
    unittest.main()
