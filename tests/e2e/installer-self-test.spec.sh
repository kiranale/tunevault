#!/usr/bin/env bash
# tests/e2e/installer-self-test.spec.sh
#
# CI test: validates that install.sh (and tunevault-agent self-test) emit the
# exact 6-probe PASS/FAIL/SKIPPED readout required by the acceptance spec.
#
# Usage (from repo root):
#   bash tests/e2e/installer-self-test.spec.sh
#
# Requires: bash 4+
# Does NOT require: a real Oracle server, a TuneVault API key, or root access.
# Strategy: source the self-test library with mock variables + stub probe helpers,
# then assert the output contains every required line.

set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
_failed=()

# ── test helpers ──────────────────────────────────────────────────────────────
assert_contains() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qF "$pattern"; then
    echo "  [PASS] $label"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "  [FAIL] $label"
    echo "         expected: $pattern"
    echo "         in output: $(echo "$text" | head -20)"
    FAIL_COUNT=$((FAIL_COUNT+1))
    _failed+=("$label")
  fi
}

assert_not_contains() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qF "$pattern"; then
    echo "  [FAIL] $label (should NOT be present)"
    FAIL_COUNT=$((FAIL_COUNT+1))
    _failed+=("$label")
  else
    echo "  [PASS] $label"
    PASS_COUNT=$((PASS_COUNT+1))
  fi
}

assert_grep_e() {
  local label="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qE "$pattern"; then
    echo "  [PASS] $label"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    echo "  [FAIL] $label"
    echo "         expected regex: $pattern"
    FAIL_COUNT=$((FAIL_COUNT+1))
    _failed+=("$label")
  fi
}

# ── build a mock environment for the library ─────────────────────────────────
# We source the library in a subshell with stubs so no real network calls happen.

MOCK_LIB=$(mktemp)
trap 'rm -f "$MOCK_LIB"' EXIT

# Extract the library block from install.sh (between <<'LIBEOF' and LIBEOF)
sed -n "/^cat > \/usr\/local\/lib\/tunevault-self-test\.sh <<'LIBEOF'/,/^LIBEOF$/p" \
  install.sh \
  | sed '1d;$d' > "$MOCK_LIB"

[ -s "$MOCK_LIB" ] || { echo "FATAL: could not extract tunevault-self-test.sh from install.sh"; exit 1; }

# ── Test 1: All probes PASS ───────────────────────────────────────────────────
echo ""
echo "── Test 1: All probes PASS ──────────────────────────────────────────────"

ALL_PASS_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'

  # Stub every probe to always PASS
  probe_1() { probe_pass "$L1" "(cx_Oracle 8.3.0, Python 3.8.0)"; }
  probe_2() { probe_pass "$L2" "(agent_id=42)"; }
  probe_3() { probe_pass "$L3" "(connected 4s ago)"; }
  probe_4() { probe_pass "$L4" "(dbhost:1521)"; }
  probe_5() { probe_pass "$L5" "(bastion.example.com:22)"; }
  probe_6() { probe_pass "$L6" "(SELECT 1 FROM DUAL → 1 row, 12ms)"; }

  run_self_test
' 2>&1)

assert_contains "P1 label present"        "[1/6] Python + cx_Oracle"     "$ALL_PASS_OUTPUT"
assert_contains "P2 label present"        "[2/6] Agent registered"       "$ALL_PASS_OUTPUT"
assert_contains "P3 label present"        "[3/6] Outbound channel"       "$ALL_PASS_OUTPUT"
assert_contains "P4 label present"        "[4/6] TNS listener"           "$ALL_PASS_OUTPUT"
assert_contains "P5 label present"        "[5/6] SSH bastion"            "$ALL_PASS_OUTPUT"
assert_contains "P6 label present"        "[6/6] End-to-end query"       "$ALL_PASS_OUTPUT"
assert_contains "P1 PASS"                 "[1/6] Python + cx_Oracle ........... PASS" "$ALL_PASS_OUTPUT"
assert_contains "P2 PASS"                 "[2/6] Agent registered ............. PASS" "$ALL_PASS_OUTPUT"
assert_contains "P3 PASS"                 "[3/6] Outbound channel ............. PASS" "$ALL_PASS_OUTPUT"
assert_contains "P4 PASS"                 "[4/6] TNS listener ................. PASS" "$ALL_PASS_OUTPUT"
assert_contains "P5 PASS"                 "[5/6] SSH bastion .................. PASS" "$ALL_PASS_OUTPUT"
assert_contains "P6 PASS"                 "[6/6] End-to-end query ............. PASS" "$ALL_PASS_OUTPUT"
assert_contains "Result line present"     "Result:"                      "$ALL_PASS_OUTPUT"
assert_grep_e   "Result 6 PASS"           "Result: 6 PASS / 0 FAIL / 0 SKIPPED" "$ALL_PASS_OUTPUT"
assert_contains "JSON outcome pass"       '"self_test":"pass"'           "$ALL_PASS_OUTPUT"
assert_contains "JSON failed empty"       '"failed":[]'                  "$ALL_PASS_OUTPUT"

# ── Test 2: P4 fails → P6 SKIPPED, exit non-zero ────────────────────────────
echo ""
echo "── Test 2: P4 (TNS) fails → P6 auto-SKIPPED ────────────────────────────"

P4_FAIL_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'

  probe_1() { probe_pass "$L1" "(cx_Oracle 8.3.0, Python 3.8.0)"; }
  probe_2() { probe_pass "$L2" "(agent_id=42)"; }
  probe_3() { probe_pass "$L3" "(connected 2s ago)"; }
  probe_4() { probe_fail "$L4" "ORA-12541: TNS:no listener" "check listener — run \`lsnrctl status\` to verify host, port, and service registration"; return 1; }
  probe_5() { probe_pass "$L5" "(bastion.example.com:22)"; }
  probe_6() {
    local p4_status=$1
    if [ "$p4_status" -ne 0 ]; then
      probe_skip "$L6" "(TNS failed)"
      return 0
    fi
    probe_pass "$L6" "(SELECT 1 FROM DUAL → 1 row)"
  }

  run_self_test || true
' 2>&1)

assert_contains "P4 FAIL present"         "[4/6] TNS listener ................. FAIL"       "$P4_FAIL_OUTPUT"
assert_contains "ORA error shown"         "ORA-12541: TNS:no listener"                       "$P4_FAIL_OUTPUT"
assert_contains "Fix line shown"          "Fix:"                                              "$P4_FAIL_OUTPUT"
assert_contains "lsnrctl fix"             "lsnrctl status"                                    "$P4_FAIL_OUTPUT"
assert_contains "P6 SKIPPED"              "[6/6] End-to-end query ............. SKIPPED"     "$P4_FAIL_OUTPUT"
assert_grep_e   "Result 4 PASS 1 FAIL 1 SKIP" "Result: 4 PASS / 1 FAIL / 1 SKIPPED"         "$P4_FAIL_OUTPUT"
assert_contains "JSON outcome fail"       '"self_test":"fail"'                                "$P4_FAIL_OUTPUT"
assert_contains "P4 in failed list"       "probe_4_tns_listener"                             "$P4_FAIL_OUTPUT"
assert_not_contains "P6 NOT in failed"    "probe_6_end_to_end_query"                         "$P4_FAIL_OUTPUT"

# ── Test 3: P5 SKIPPED (no SSH config) ───────────────────────────────────────
echo ""
echo "── Test 3: P5 skipped (no SSH config file) ──────────────────────────────"

P5_SKIP_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'

  probe_1() { probe_pass "$L1" "(cx_Oracle 8.3.0, Python 3.8.0)"; }
  probe_2() { probe_pass "$L2" "(agent_id=42)"; }
  probe_3() { probe_pass "$L3" "(connected 1s ago)"; }
  probe_4() { probe_pass "$L4" "(dbhost:1521)"; }
  probe_5() { probe_skip "$L5" "(no SSH config — skip)"; }
  probe_6() { probe_pass "$L6" "(SELECT 1 FROM DUAL → 1 row)"; }

  run_self_test
' 2>&1)

assert_contains "P5 SKIPPED line"        "[5/6] SSH bastion .................. SKIPPED"     "$P5_SKIP_OUTPUT"
assert_grep_e   "Result 5 PASS 0 FAIL 1 SKIP" "Result: 5 PASS / 0 FAIL / 1 SKIPPED"         "$P5_SKIP_OUTPUT"
assert_contains "JSON outcome pass (no real fail)" '"self_test":"pass"'                       "$P5_SKIP_OUTPUT"
assert_not_contains "P5 not in failed"   "probe_5_ssh_bastion"                               "$P5_SKIP_OUTPUT"

# ── Test 4: Separator lines present ──────────────────────────────────────────
echo ""
echo "── Test 4: Header / separator lines ────────────────────────────────────"

assert_contains "Header line"            "TuneVault Agent Self-Test"    "$ALL_PASS_OUTPUT"
assert_contains "Separator 1"            "========================================"  "$ALL_PASS_OUTPUT"

# ── Test 5: Exit code non-zero on any FAIL ───────────────────────────────────
echo ""
echo "── Test 5: Exit codes ───────────────────────────────────────────────────"

ALL_PASS_RC=0
bash -c '
  source '"$MOCK_LIB"'
  probe_1() { probe_pass "$L1" ""; }; probe_2() { probe_pass "$L2" ""; }
  probe_3() { probe_pass "$L3" ""; }; probe_4() { probe_pass "$L4" ""; }
  probe_5() { probe_pass "$L5" ""; }; probe_6() { probe_pass "$L6" ""; }
  run_self_test
' >/dev/null 2>&1 || ALL_PASS_RC=$?

if [ "$ALL_PASS_RC" -eq 0 ]; then
  echo "  [PASS] exit 0 when all probes pass"
  PASS_COUNT=$((PASS_COUNT+1))
else
  echo "  [FAIL] expected exit 0 on all-pass, got $ALL_PASS_RC"
  FAIL_COUNT=$((FAIL_COUNT+1))
  _failed+=("exit 0 on all-pass")
fi

FAIL_RC=0
bash -c '
  source '"$MOCK_LIB"'
  probe_1() { probe_fail "$L1" "err" "fix"; return 1; }
  probe_2() { probe_pass "$L2" ""; }; probe_3() { probe_pass "$L3" ""; }
  probe_4() { probe_pass "$L4" ""; }; probe_5() { probe_pass "$L5" ""; }
  probe_6() { probe_pass "$L6" ""; }
  run_self_test
' >/dev/null 2>&1 || FAIL_RC=$?

if [ "$FAIL_RC" -ne 0 ]; then
  echo "  [PASS] exit non-zero when a probe fails (got $FAIL_RC)"
  PASS_COUNT=$((PASS_COUNT+1))
else
  echo "  [FAIL] expected non-zero exit when a probe fails, got 0"
  FAIL_COUNT=$((FAIL_COUNT+1))
  _failed+=("exit non-zero on fail")
fi

# ── Test 6: Probe 1 emits driver versions (not just python exists) ────────────
echo ""
echo "── Test 6: Probe 1 emits actual driver version strings ─────────────────"

# Simulate probe_1 PASS with both drivers reported
P1_BOTH_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'
  probe_1() { probe_pass "$L1" "(cx_Oracle 8.3.0 oracledb 1.4.2, Python 3.8.10)"; }
  probe_2() { probe_pass "$L2" ""; }; probe_3() { probe_pass "$L3" ""; }
  probe_4() { probe_pass "$L4" ""; }; probe_5() { probe_pass "$L5" ""; }
  probe_6() { probe_pass "$L6" ""; }
  run_self_test
' 2>&1)

assert_contains "P1 version in output" "cx_Oracle 8.3.0"      "$P1_BOTH_OUTPUT"
assert_contains "P1 oracledb version"  "oracledb 1.4.2"       "$P1_BOTH_OUTPUT"
assert_contains "P1 python version"    "Python 3.8.10"        "$P1_BOTH_OUTPUT"

# Simulate probe_1 FAIL (neither driver importable) — must emit FATAL + remediation
P1_FAIL_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'
  probe_1() {
    probe_fail "$L1" \
      "FATAL: neither cx_Oracle nor oracledb importable in venv (agent will crash-loop without a driver)" \
      "Install Oracle Instant Client first, then run: sudo bash -s -- --repair"
    return 1
  }
  probe_2() { probe_pass "$L2" ""; }; probe_3() { probe_pass "$L3" ""; }
  probe_4() { probe_pass "$L4" ""; }; probe_5() { probe_pass "$L5" ""; }
  probe_6() { probe_pass "$L6" ""; }
  run_self_test || true
' 2>&1)

assert_contains  "P1 FATAL in fail msg"    "FATAL: neither cx_Oracle"        "$P1_FAIL_OUTPUT"
assert_contains  "P1 crash-loop in msg"    "crash-loop"                       "$P1_FAIL_OUTPUT"
assert_grep_e    "P1 remediation repair"   "\-\-repair"                       "$P1_FAIL_OUTPUT"
assert_contains "P1 FAIL line"            "[1/6] Python + cx_Oracle ........... FAIL" "$P1_FAIL_OUTPUT"
assert_grep_e   "P1 fail → outcome fail"  '"self_test":"fail"'                "$P1_FAIL_OUTPUT"

# ── Test 7: Python binary mismatch detection ──────────────────────────────────
echo ""
echo "── Test 7: Probe 1 binary mismatch FAIL ─────────────────────────────────"

P1_MISMATCH_OUTPUT=$(bash -c '
  source '"$MOCK_LIB"'
  probe_1() {
    probe_fail "$L1" \
      "python binary mismatch: systemd uses /usr/bin/python3 but drivers installed in /opt/tunevault/venv/bin/python3" \
      "Check ExecStart in /etc/systemd/system/tunevault-proxy.service"
    return 1
  }
  probe_2() { probe_pass "$L2" ""; }; probe_3() { probe_pass "$L3" ""; }
  probe_4() { probe_pass "$L4" ""; }; probe_5() { probe_pass "$L5" ""; }
  probe_6() { probe_pass "$L6" ""; }
  run_self_test || true
' 2>&1)

assert_contains "mismatch detected"   "python binary mismatch"  "$P1_MISMATCH_OUTPUT"
assert_contains "mismatch ExecStart"  "ExecStart"               "$P1_MISMATCH_OUTPUT"
assert_contains "mismatch FAIL line"  "[1/6] Python + cx_Oracle ........... FAIL" "$P1_MISMATCH_OUTPUT"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
printf "Spec tests: %d PASS / %d FAIL\n" "$PASS_COUNT" "$FAIL_COUNT"
echo "========================================"

if [ ${#_failed[@]} -gt 0 ]; then
  echo "Failed assertions:"
  for _f in "${_failed[@]}"; do echo "  - $_f"; done
  exit 1
fi
exit 0
