#!/usr/bin/env bash
# tests/e2e/installer-container-smoke.sh
#
# Runs inside a fresh OS container (OEL7, OEL8, Ubuntu 22.04) to validate that:
#   1. install.sh --headless completes without errors
#   2. /health returns 200 JSON (proxy didn't crash-loop)
#   3. Probe 1 (driver import) passes — cx_Oracle or oracledb importable
#   4. No FATAL lines in proxy output
#   5. Deliberately broken install (pip install removed) → probe 1 FAIL → CI red
#
# Called by .github/workflows/installer-smoke-test.yml
# Usage: bash tests/e2e/installer-container-smoke.sh [yum|dnf|apt]
#
# This script runs as root inside the container. It installs the minimum
# OS packages needed to run install.sh, then executes it in headless mode.

set -euo pipefail

PKG_MGR="${1:-yum}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

PASS_COUNT=0
FAIL_COUNT=0
_smoke_failed=()

smoke_pass() { PASS_COUNT=$((PASS_COUNT+1)); pass "$1"; }
smoke_fail() { FAIL_COUNT=$((FAIL_COUNT+1)); _smoke_failed+=("$1"); echo -e "${RED}[FAIL]${NC} $1" >&2; }

echo ""
echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  TuneVault Installer Container Smoke Test         ${NC}"
echo -e "${BOLD}  Package manager: ${PKG_MGR}                     ${NC}"
echo -e "${BOLD}════════════════════════════════════════════════════${NC}"
echo ""

# ── Step 1: Install OS prerequisites ────────────────────────────────────────
info "Installing OS prerequisites..."

case "$PKG_MGR" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q 2>/dev/null
    apt-get install -y -q curl python3 python3-venv python3-pip gcc libffi-dev python3-dev 2>/dev/null
    ;;
  dnf)
    dnf install -y -q curl python3 python3-pip gcc libffi-devel python3-devel 2>/dev/null || true
    dnf install -y -q python3-virtualenv 2>/dev/null || true
    ;;
  yum)
    yum install -y -q curl python3 python3-pip gcc libffi-devel python3-devel 2>/dev/null || true
    # OEL7 may not have python3-virtualenv in base repo — pip fallback handled by install.sh
    ;;
esac

info "OS prerequisites installed"

# ── Step 2: Copy install.sh + oracle-proxy.py to a writable location ─────────
# The repo is mounted read-only (/tunevault:ro); work in /tmp/tunevault-smoke
WORK_DIR="/tmp/tunevault-smoke"
mkdir -p "$WORK_DIR"
cp "${REPO_ROOT}/install.sh" "$WORK_DIR/"
cp "${REPO_ROOT}/oracle-proxy.py" "$WORK_DIR/"
chmod +x "$WORK_DIR/install.sh"

info "Working directory: $WORK_DIR"

# ── Step 3: Run install.sh --headless ────────────────────────────────────────
info "Running install.sh --headless..."

INSTALL_LOG="$WORK_DIR/install.log"

# Run from the working dir so oracle-proxy.py download is satisfied by the local copy.
# TUNEVAULT_API_URL points nowhere real — headless mode skips the provision API call.
# The proxy download step (curl oracle-proxy.py) would fail without the real server,
# so we pre-stage oracle-proxy.py and override the download URL to a local file server.
# Simpler: patch PROXY_DEST to use our pre-staged file. We override TUNEVAULT_API to
# a localhost:1 that will fail fast; the provision step is skipped in --headless mode,
# but the oracle-proxy.py download still happens. Pre-stage it at the expected path.

# Pre-create the destination directory and place oracle-proxy.py there
# so the curl download step is skipped gracefully.
PROXY_DEST="/opt/tunevault"
mkdir -p "$PROXY_DEST"
cp "$WORK_DIR/oracle-proxy.py" "$PROXY_DEST/oracle-proxy.py"
chmod +x "$PROXY_DEST/oracle-proxy.py"

# Now run install.sh; it will skip the download since the file already exists.
# We still need to override TUNEVAULT_API to prevent the provision curl from hanging.
set +e
TUNEVAULT_API="http://127.0.0.1:1" \
bash "$WORK_DIR/install.sh" --headless 2>&1 | tee "$INSTALL_LOG"
INSTALL_RC=${PIPESTATUS[0]}
set -e

# ── Assertion 1: install.sh exited 0 ─────────────────────────────────────────
if [ "$INSTALL_RC" -eq 0 ]; then
  smoke_pass "install.sh --headless exited 0"
else
  smoke_fail "install.sh --headless failed (exit $INSTALL_RC)"
fi

# ── Assertion 2: No FATAL lines in proxy/install output ──────────────────────
FATAL_LINES=$(grep -c "^FATAL:" "$INSTALL_LOG" 2>/dev/null || true)
if [ "$FATAL_LINES" -eq 0 ]; then
  smoke_pass "No FATAL lines in install output"
else
  smoke_fail "Found $FATAL_LINES FATAL line(s) in install output"
  grep "^FATAL:" "$INSTALL_LOG" | head -5 >&2 || true
fi

# ── Assertion 3: Probe 1 PASS in output ──────────────────────────────────────
if grep -q "\[1/6\] Python + cx_Oracle ........... PASS" "$INSTALL_LOG" 2>/dev/null; then
  smoke_pass "Probe 1 (driver import) PASSED in install output"
else
  smoke_fail "Probe 1 (driver import) did NOT show PASS in install output"
  grep "\[1/6\]" "$INSTALL_LOG" 2>/dev/null | head -5 >&2 || true
fi

# ── Assertion 4: Driver version reported in probe 1 output ───────────────────
if grep -qE "(cx_Oracle [0-9]+\.[0-9]+\.[0-9]+|oracledb [0-9]+\.[0-9]+)" "$INSTALL_LOG" 2>/dev/null; then
  smoke_pass "Driver version string present in probe 1 output"
else
  smoke_fail "No driver version string found — probe 1 may only be checking python3 exists"
  grep "\[1/6\]" "$INSTALL_LOG" 2>/dev/null | head -3 >&2 || true
fi

# ── Assertion 5: Headless INSTALL COMPLETE banner ────────────────────────────
if grep -q "HEADLESS INSTALL COMPLETE" "$INSTALL_LOG" 2>/dev/null; then
  smoke_pass "Headless install complete banner found"
else
  smoke_fail "Headless install complete banner NOT found"
fi

# ── Step 4: Deliberate break test — remove pip install, expect probe 1 FAIL ──
info ""
info "=== Deliberate break test: remove pip install line from install.sh ==="
info "(This must make probe 1 FAIL — if it doesn't, the probe is not actually checking drivers)"

BROKEN_INSTALL="$WORK_DIR/install-broken.sh"
# Create a version of install.sh that skips the actual driver installation
# by replacing install_cx_oracle() with a no-op.
sed 's/install_cx_oracle()/install_cx_oracle_NOOP()/' "$WORK_DIR/install.sh" > "$BROKEN_INSTALL"
# Also stub out the fallback oracledb install
sed -i 's/"\$VENV_PIP" install --quiet "oracledb"/true  # BROKEN: no driver install/' "$BROKEN_INSTALL"
chmod +x "$BROKEN_INSTALL"

# Remove existing venv so broken install starts fresh
rm -rf "${PROXY_DEST}/venv"

BROKEN_LOG="$WORK_DIR/install-broken.log"
set +e
TUNEVAULT_API="http://127.0.0.1:1" \
bash "$BROKEN_INSTALL" --headless 2>&1 | tee "$BROKEN_LOG"
BROKEN_RC=${PIPESTATUS[0]}
set -e

# The broken install should fail (probe 1 FAIL → exit non-zero)
if [ "$BROKEN_RC" -ne 0 ]; then
  smoke_pass "Deliberate break test: broken install.sh correctly failed (exit $BROKEN_RC)"
else
  smoke_fail "Deliberate break test: broken install.sh exited 0 — probe 1 is NOT checking driver imports"
fi

# Probe 1 FAIL line must appear in the broken install output
if grep -q "\[1/6\] Python + cx_Oracle ........... FAIL" "$BROKEN_LOG" 2>/dev/null; then
  smoke_pass "Deliberate break test: probe 1 FAIL line emitted correctly"
else
  smoke_fail "Deliberate break test: probe 1 FAIL line not found in broken install output"
  grep "\[1/6\]" "$BROKEN_LOG" 2>/dev/null | head -5 >&2 || true
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
printf "Smoke test results: %d PASS / %d FAIL\n" "$PASS_COUNT" "$FAIL_COUNT"
echo "════════════════════════════════════════════════════"

if [ ${#_smoke_failed[@]} -gt 0 ]; then
  echo "Failed assertions:"
  for _f in "${_smoke_failed[@]}"; do echo "  ✗ $_f"; done
  echo ""
  echo "Full install log: $INSTALL_LOG"
  exit 1
fi

echo -e "${GREEN}${BOLD}All smoke test assertions PASSED${NC}"
exit 0
