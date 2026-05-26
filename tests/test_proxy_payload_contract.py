#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unit tests for oracle-proxy.py — EBS payload contract.

Tests the translation layer (_build_ebs_operations_from_proxy) and EBS probe
(_probe_ebs_detection) without requiring a live Oracle connection.

Run:
    python3 -m pytest tests/test_proxy_payload_contract.py -v
    # or without pytest:
    python3 tests/test_proxy_payload_contract.py
"""

import sys
import os
import types
import json
import unittest

# ---------------------------------------------------------------------------
# Stub out cx_Oracle so the module can be imported without Oracle libs
# ---------------------------------------------------------------------------
if 'cx_Oracle' not in sys.modules:
    cx_mock = types.ModuleType('cx_Oracle')
    cx_mock.version = '8.0.0-stub'

    class _DSNMock:
        pass

    cx_mock.makedsn = lambda *a, **kw: _DSNMock()

    class _ConnMock:
        def cursor(self): return _CursorMock()
        def close(self): pass

    class _CursorMock:
        def execute(self, *a, **kw): pass
        def fetchone(self): return None
        def fetchall(self): return []
        def close(self): pass

    cx_mock.connect = lambda **kw: _ConnMock()
    sys.modules['cx_Oracle'] = cx_mock

# Ensure we import from the repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set required env var so the module loads without FATAL error
os.environ.setdefault('TUNEVAULT_API_KEY', 'test-key')
# Inject --validate-only so the module doesn't start the HTTP server
if '--validate-only' not in sys.argv:
    sys.argv.append('--validate-only')

# Now import the proxy module (functions only, server won't start)
import importlib.util
_spec = importlib.util.spec_from_file_location(
    'oracle_proxy',
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'oracle-proxy.py')
)
proxy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proxy)

_build = proxy._build_ebs_operations_from_proxy
_probe = proxy._probe_ebs_detection
safe_int = proxy.safe_int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_apps_health(
    is_ebs=True,
    icm_down=False,
    managers=None,
    pending_requests=0,
    running_requests=0,
    opp=None,
    wf_status='ok',
    mailer_running=True,
    mailer_component=None,
    wf_services=None,
    stuck_notifications=0,
    wf_err_count=0,
    adop_status=None,
    apps_env=None,
):
    """Build a minimal apps_health dict as query_apps_health() would return."""
    return {
        'is_ebs': is_ebs,
        'status': 'ok',
        'concurrent_managers': {
            'status': 'critical' if icm_down else 'ok',
            'icm_down': icm_down,
            'managers': managers or [],
            'pending_requests': pending_requests,
            'running_requests': running_requests,
        },
        'opp': opp or {
            'manager_name': 'Output Post Processor',
            'actual': 2, 'target': 2,
            'status': 'ok',
            'recommendation': 'OPP healthy: 2/2 process(es) running.',
        },
        'workflow': {
            'status': wf_status,
            'mailer_running': mailer_running,
            'mailer_component': mailer_component,
            'services': wf_services or [],
            'stuck_notifications': stuck_notifications,
            'error_count': wf_err_count,
        },
        'adop_status': adop_status or {
            'check_id': 'ADOP_STATUS',
            'status': 'skip',
            'severity': 'info',
            'message': 'Skipped: APPS_PWD not set.',
            'sessions': [],
        },
        'apps_env': apps_env or {},
    }


# ---------------------------------------------------------------------------
# Tests: _build_ebs_operations_from_proxy
# ---------------------------------------------------------------------------

class TestBuildEbsOperations(unittest.TestCase):

    def test_returns_none_for_none_input(self):
        """Bug 1: must return None (not raise) when apps_health is None."""
        result = _build(None)
        self.assertIsNone(result)

    def test_returns_none_for_non_ebs(self):
        """Bug 1: must return None when is_ebs is False."""
        result = _build({'is_ebs': False})
        self.assertIsNone(result)

    def test_top_level_structure(self):
        """Bug 1: result must have all server-expected top-level keys."""
        ah = _make_apps_health()
        result = _build(ah)
        self.assertIsNotNone(result)
        for key in ('concurrent_managers', 'workflow', 'security', 'functional',
                    'observability', 'config_drift'):
            self.assertIn(key, result, "Missing top-level key: %s" % key)

    def test_concurrent_managers_keys(self):
        """Bug 1: concurrent_managers must have cm01..cm10 shape."""
        ah = _make_apps_health(
            managers=[
                {'display_name': 'Internal Concurrent Manager', 'actual': 2, 'target': 2, 'status_label': 'Running'},
                {'display_name': 'Standard Manager', 'actual': 1, 'target': 1, 'status_label': 'Running'},
            ],
            pending_requests=5,
        )
        result = _build(ah)
        cm = result['concurrent_managers']
        self.assertIn('cm01', cm)
        self.assertIn('cm02', cm)
        self.assertIn('cm03', cm)
        self.assertIn('cm05', cm)

    def test_cm01_icm_found_by_name(self):
        """ICM should be found by matching 'internal' in display_name."""
        ah = _make_apps_health(
            icm_down=False,
            managers=[
                {'display_name': 'Internal Concurrent Manager', 'actual': 3, 'target': 3, 'status_label': 'Running'},
            ],
        )
        result = _build(ah)
        cm01 = result['concurrent_managers']['cm01']
        self.assertIsNotNone(cm01)
        self.assertEqual(cm01['running_processes'], 3)
        self.assertEqual(cm01['max_processes'], 3)
        self.assertEqual(cm01['status'], 'ok')

    def test_cm01_icm_down_fallback(self):
        """If ICM not in manager list, cm01 is synthesised from icm_down=True."""
        ah = _make_apps_health(icm_down=True, managers=[])
        result = _build(ah)
        cm01 = result['concurrent_managers']['cm01']
        self.assertIsNotNone(cm01)
        self.assertEqual(cm01['running_processes'], 0)
        self.assertEqual(cm01['status'], 'critical')

    def test_cm02_pending_requests(self):
        """cm02 must carry pending_requests from concurrent_managers."""
        ah = _make_apps_health(pending_requests=42)
        result = _build(ah)
        cm02 = result['concurrent_managers']['cm02']
        self.assertIsNotNone(cm02)
        self.assertEqual(cm02['pending_requests'], 42)

    def test_cm03_opp_queue_depth(self):
        """Bug 3: OPP queue depth must be surfaced in cm03."""
        ah = _make_apps_health(opp={
            'manager_name': 'Output Post Processor',
            'actual': 0, 'target': 2,
            'status': 'critical',
            'recommendation': 'OPP is not running — PDF/output generation will fail.',
        })
        result = _build(ah)
        cm03 = result['concurrent_managers']['cm03']
        self.assertIsNotNone(cm03)
        self.assertEqual(cm03['running_processes'], 0)
        self.assertEqual(cm03['max_processes'], 2)
        self.assertEqual(cm03['status'], 'critical')

    def test_wf02_error_count_surfaced(self):
        """Bug 3: WF error count must be surfaced in wf02."""
        ah = _make_apps_health(wf_err_count=15)
        result = _build(ah)
        wf02 = result['workflow']['wf02']
        self.assertIsNotNone(wf02)
        self.assertEqual(wf02['error_count'], 15)

    def test_wf03_mailer_status_surfaced(self):
        """Bug 3: WF Mailer status must be surfaced in wf03."""
        ah = _make_apps_health(
            mailer_running=False,
            mailer_component={'type': 'WF_MAILER', 'name': 'Workflow Mailer', 'status': 'DEACTIVATED_SYSTEM', 'startup_mode': 'AUTOMATIC'},
        )
        result = _build(ah)
        wf03 = result['workflow']['wf03']
        self.assertIsNotNone(wf03)
        self.assertFalse(wf03['mailer_running'])
        self.assertEqual(wf03['status'], 'DEACTIVATED_SYSTEM')

    def test_wf08_stuck_notifications(self):
        """Bug 3: stuck notifications must be surfaced in wf08."""
        ah = _make_apps_health(stuck_notifications=77)
        result = _build(ah)
        wf08 = result['workflow']['wf08']
        self.assertIsNotNone(wf08)
        self.assertEqual(wf08['pending_over_2h'], 77)

    def test_adop_sessions_surfaced(self):
        """Bug 3: ADOP sessions must be visible in _adop_status."""
        ah = _make_apps_health(adop_status={
            'check_id': 'ADOP_STATUS',
            'status': 'critical',
            'severity': 'critical',
            'message': '1 ADOP session(s) in FAILED state.',
            'sessions': [
                {'session_id': '42', 'node': 'app1', 'phase': 'apply', 'status': 'FAILED'},
            ],
        })
        result = _build(ah)
        adop = result.get('_adop_status')
        self.assertIsNotNone(adop)
        self.assertEqual(adop['failed_sessions'], 1)
        self.assertEqual(len(adop['sessions']), 1)

    def test_wf_services_mapped_to_wf09(self):
        """WF services list must be mapped to wf09."""
        services = [
            {'type': 'WF_MAILER', 'name': 'Workflow Mailer', 'status': 'RUNNING', 'startup_mode': 'AUTOMATIC'},
            {'type': 'WF_JAVA_AGENT', 'name': 'WF Java Agent', 'status': 'RUNNING', 'startup_mode': 'AUTOMATIC'},
        ]
        ah = _make_apps_health(wf_services=services)
        result = _build(ah)
        wf09 = result['workflow']['wf09']
        self.assertEqual(len(wf09), 2)
        self.assertTrue(wf09[0]['enabled'])

    def test_no_exception_on_missing_optional_fields(self):
        """_build must not raise when optional keys are absent from apps_health."""
        # Minimal apps_health — only is_ebs present
        result = _build({'is_ebs': True})
        self.assertIsNotNone(result)
        # cm01 synthesised from icm_down absent → icm_down defaults to False
        cm01 = result['concurrent_managers']['cm01']
        self.assertIsNotNone(cm01)
        self.assertEqual(cm01['running_processes'], 1)  # icm_down defaults False → 1


# ---------------------------------------------------------------------------
# Tests: _probe_ebs_detection (uses mock cursors)
# ---------------------------------------------------------------------------

class _ORA00942Error(Exception):
    """Simulates cx_Oracle DatabaseError with ORA-00942."""
    def __str__(self): return 'ORA-00942: table or view does not exist'


class _ORA01017Error(Exception):
    """Simulates a non-942 Oracle error."""
    def __str__(self): return 'ORA-01017: invalid username/password'


class _OKCursor:
    """Cursor that succeeds on any execute (EBS present)."""
    def execute(self, sql): pass
    def fetchone(self): return ('R12.2',)


class _FailFirstCursor:
    """Cursor: FND_PRODUCT_GROUPS (step 1) fails with ORA-00942; step 2+ succeed.

    Uses instance-level counter (not class-level) so tests don't share state.
    Bug 2: any of steps 2-4 confirming EBS is sufficient.
    """
    def __init__(self):
        self._call = 0  # instance-level — not shared across test runs

    def execute(self, sql):
        self._call += 1
        if self._call == 1:
            raise _ORA00942Error()

    def fetchone(self): return (1,)


class _BothFailCursor:
    """Cursor: all four probe steps fail with ORA-00942.

    Bug 5: APPS schema is reachable (ORA-00942 instead of ORA-01017) but no
    FND grants exist — should return (False, error_message).
    """
    def execute(self, sql):
        raise _ORA00942Error()
    def fetchone(self): return None


class _NonEbsCursor:
    """Cursor: fails with non-942 error (APPS schema simply not present)."""
    def execute(self, sql):
        raise _ORA01017Error()
    def fetchone(self): return None


class _FailUntilStep3Cursor:
    """Cursor: steps 1-2 fail with ORA-00942; step 3 (FND_PRODUCT_INSTALLATIONS) succeeds.

    Bug 2 — ensures the 4-step chain reaches step 3 when SYSTEM lacks grants on
    FND_PRODUCT_GROUPS and FND_CONCURRENT_QUEUES but can read FND_PRODUCT_INSTALLATIONS.
    """
    def __init__(self):
        self._call = 0

    def execute(self, sql):
        self._call += 1
        if self._call < 3:
            raise _ORA00942Error()

    def fetchone(self): return (1,)


class TestProbeEbsDetection(unittest.TestCase):

    def test_primary_probe_succeeds(self):
        """EBS confirmed when FND_PRODUCT_GROUPS (step 1) is readable."""
        is_ebs, err = _probe(_OKCursor())
        self.assertTrue(is_ebs)
        self.assertIsNone(err)

    def test_step2_fallback_succeeds(self):
        """Bug 2: EBS confirmed via step 2 (FND_CONCURRENT_QUEUES) fallback."""
        is_ebs, err = _probe(_FailFirstCursor())
        self.assertTrue(is_ebs)
        self.assertIsNone(err)

    def test_step3_fallback_succeeds(self):
        """Bug 2: EBS confirmed via step 3 (FND_PRODUCT_INSTALLATIONS) fallback."""
        is_ebs, err = _probe(_FailUntilStep3Cursor())
        self.assertTrue(is_ebs)
        self.assertIsNone(err)

    def test_bug5_apps_reachable_but_fnd_not_accessible(self):
        """Bug 5: returns (False, error_message) when all four probes fail with ORA-00942."""
        is_ebs, err = _probe(_BothFailCursor())
        self.assertFalse(is_ebs)
        self.assertIsNotNone(err)
        self.assertIn('APPS schema detected', err)
        self.assertIn('not accessible', err)

    def test_non_ebs_database(self):
        """Returns (False, None) for non-EBS databases (schema not present — non-942 error)."""
        is_ebs, err = _probe(_NonEbsCursor())
        self.assertFalse(is_ebs)
        self.assertIsNone(err)


# ---------------------------------------------------------------------------
# Tests: payload JSON serialisability
# ---------------------------------------------------------------------------

class TestPayloadSerialisation(unittest.TestCase):

    def test_ebs_operations_json_serialisable(self):
        """ebs_operations output must be JSON-serialisable (no datetime objects etc.)."""
        ah = _make_apps_health(
            managers=[{'display_name': 'Internal Concurrent Manager', 'actual': 2, 'target': 2, 'status_label': 'Running'}],
            pending_requests=10,
            stuck_notifications=3,
            wf_err_count=1,
            wf_services=[{'type': 'WF_MAILER', 'name': 'Mailer', 'status': 'RUNNING', 'startup_mode': 'AUTOMATIC'}],
        )
        result = _build(ah)
        try:
            json.dumps(result)
        except (TypeError, ValueError) as e:
            self.fail('ebs_operations is not JSON-serialisable: %s' % e)

    def test_ebs_probe_error_json_serialisable(self):
        """ebs_probe_error string must be JSON-serialisable."""
        _, err = _probe(_BothFailCursor())
        try:
            json.dumps({'ebs_probe_error': err})
        except (TypeError, ValueError) as e:
            self.fail('ebs_probe_error is not JSON-serialisable: %s' % e)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    unittest.main(verbosity=2)
