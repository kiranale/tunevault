#!/usr/bin/env bash
# scripts/ci/test-agent-install.sh — Regression test for agent.cli import + systemd unit config.
#
# Two test modes:
#   1. Smoke test (no systemd): verify python3 -m agent.cli --version exits 0.
#      Suitable for GitHub Actions / any Linux container that lacks systemd PID 1.
#   2. Full systemd test (privileged container): verify systemctl is-active tunevault-agent
#      is "active" within 30 seconds of install.
#
# Usage:
#   bash scripts/ci/test-agent-install.sh         # auto-detects mode
#   FORCE_FULL=1 bash scripts/ci/test-agent-install.sh  # force systemd mode
#   SMOKE_ONLY=1 bash scripts/ci/test-agent-install.sh  # force smoke-only
#
# Non-negotiable: NO Cloudflare tunnel logic. Native outbound HTTPS long-poll only.

set -euo pipefail

PROXY_DEST="${TUNEVAULT_INSTALL_DIR:-/opt/tunevault}"
VENV_PYTHON="${PROXY_DEST}/venv/bin/python3"

PASS=0
FAIL=0

_pass() { echo "[PASS] $*"; PASS=$((PASS+1)); }
_fail() { echo "[FAIL] $*" >&2; FAIL=$((FAIL+1)); }

echo "=== TuneVault Agent Install Regression Test ==="
echo "PROXY_DEST=$PROXY_DEST"
echo ""

# ── Test 1: agent/__init__.py exists ─────────────────────────────────────────
if [ -f "${PROXY_DEST}/agent/__init__.py" ]; then
  _pass "agent/__init__.py present at ${PROXY_DEST}/agent/"
else
  _fail "agent/__init__.py MISSING at ${PROXY_DEST}/agent/"
fi

# ── Test 2: agent/cli.py exists ───────────────────────────────────────────────
if [ -f "${PROXY_DEST}/agent/cli.py" ]; then
  _pass "agent/cli.py present"
else
  _fail "agent/cli.py MISSING"
fi

# ── Test 3: venv python exists ───────────────────────────────────────────────
if [ -f "$VENV_PYTHON" ]; then
  _pass "venv python exists at $VENV_PYTHON"
else
  _fail "venv python MISSING at $VENV_PYTHON"
fi

# ── Test 4: import agent.cli succeeds ────────────────────────────────────────
if (cd "${PROXY_DEST}" && PYTHONPATH="${PROXY_DEST}" "${VENV_PYTHON}" -c 'import agent.cli' 2>/dev/null); then
  _pass "import agent.cli succeeded (WorkingDirectory + PYTHONPATH env correct)"
else
  _fail "import agent.cli FAILED — ModuleNotFoundError (agent/ package missing or broken)"
fi

# ── Test 5: python3 -m agent.cli --version (smoke test) ──────────────────────
VERSION_OUT=""
if VERSION_OUT=$(cd "${PROXY_DEST}" && PYTHONPATH="${PROXY_DEST}" "${VENV_PYTHON}" -m agent.cli version 2>&1); then
  _pass "python3 -m agent.cli version: $VERSION_OUT"
else
  _fail "python3 -m agent.cli version FAILED: $VERSION_OUT"
fi

# ── Test 6: systemd unit ExecStart contains 'agent.cli start' ─────────────────
SVC_FILE="/etc/systemd/system/tunevault-agent.service"
if [ -f "$SVC_FILE" ]; then
  if grep -q 'agent\.cli start' "$SVC_FILE"; then
    _pass "systemd ExecStart references agent.cli start"
  else
    _fail "systemd ExecStart does NOT reference agent.cli start (stale unit?)"
    echo "  Current ExecStart: $(grep 'ExecStart' "$SVC_FILE" || echo '(not found)')"
  fi
  if grep -q '^WorkingDirectory=/opt/tunevault' "$SVC_FILE"; then
    _pass "systemd WorkingDirectory=/opt/tunevault"
  else
    _fail "systemd WorkingDirectory missing or wrong"
    echo "  Current WorkingDirectory: $(grep 'WorkingDirectory' "$SVC_FILE" || echo '(not found)')"
  fi
  if grep -q '^Environment=PYTHONPATH=/opt/tunevault' "$SVC_FILE"; then
    _pass "systemd Environment=PYTHONPATH=/opt/tunevault"
  else
    _fail "systemd Environment=PYTHONPATH missing or wrong"
    echo "  Current PYTHONPATH env: $(grep 'PYTHONPATH' "$SVC_FILE" || echo '(not found)')"
  fi
else
  echo "[SKIP] $SVC_FILE not found (not installed — CI smoke mode only)"
fi

# ── Test 7: systemd is-active (if systemd available + FORCE_FULL or systemd PID 1) ──
RUN_SYSTEMD=0
if [ "${FORCE_FULL:-0}" = "1" ]; then
  RUN_SYSTEMD=1
elif [ "${SMOKE_ONLY:-0}" != "1" ] && command -v systemctl >/dev/null 2>&1 && systemctl status >/dev/null 2>&1; then
  RUN_SYSTEMD=1
fi

if [ "$RUN_SYSTEMD" -eq 1 ]; then
  echo "  Waiting up to 30s for tunevault-agent.service to become active…"
  WAITED=0
  IS_ACTIVE=0
  while [ $WAITED -lt 30 ]; do
    if systemctl is-active tunevault-agent.service >/dev/null 2>&1; then
      IS_ACTIVE=1
      break
    fi
    sleep 1
    WAITED=$((WAITED+1))
  done
  if [ "$IS_ACTIVE" -eq 1 ]; then
    _pass "tunevault-agent.service is active (waited ${WAITED}s)"
  else
    _fail "tunevault-agent.service not active after 30s"
    echo "  journalctl tail:"
    journalctl -u tunevault-agent -n 20 --no-pager 2>/dev/null || true
  fi
else
  echo "[SKIP] systemd not available or SMOKE_ONLY=1 — skipping systemctl is-active test"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
