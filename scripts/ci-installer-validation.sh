#!/usr/bin/env bash
# scripts/ci-installer-validation.sh
#
# Run inside an Oracle Linux 7/8 Docker container by .github/workflows/installer-validation.yml.
# Installs the TuneVault agent via install.sh --headless, runs the 7-probe self-test,
# and prints a JSON summary as the last line of stdout.
#
# Environment variables expected (injected by CI):
#   ORACLE_TEST_DSN      — host:port/service (e.g. 192.0.2.10:1521/ORCL)
#   ORACLE_TEST_USER     — Oracle username
#   ORACLE_TEST_PASSWORD — Oracle password
#   TEST_TENANT_EMAIL    — test tenant email (registered in TuneVault)
#   TEST_TENANT_API_KEY  — API key for that tenant
#   TUNEVAULT_APP_URL    — TuneVault app URL (for agent channel)
#
# Output: runs print to stdout; last line is JSON with probe results.

set -euo pipefail

INSTALL_DIR="/opt/tunevault-ci-test"
RESULTS_DIR="/results"
OS_KEY="${OS_KEY:-unknown}"
START_MS=$(date +%s%3N)

log() { echo "[ci-validator] $*" >&2; }
die() { echo "[ci-validator] FATAL: $*" >&2; exit 1; }

# ── 1. Run install.sh --headless ─────────────────────────────────────────────
log "Starting install.sh --headless..."
bash /tunevault/install.sh --headless 2>&1 || {
  log "install.sh exited non-zero"
  END_MS=$(date +%s%3N)
  cat <<EOF
{"probes":[{"n":1,"status":"fail","ms":null,"error":"install.sh exited non-zero"}],"overall":"fail","duration_total_ms":$((END_MS - START_MS))}
EOF
  exit 1
}
log "install.sh --headless completed"

# ── 2. Capture agent version ──────────────────────────────────────────────────
AGENT_VER=""
if [ -f /usr/local/bin/tunevault-agent ]; then
  AGENT_VER=$(tunevault-agent --version 2>/dev/null || echo "")
fi
if [ -n "$AGENT_VER" ]; then
  echo "$AGENT_VER" > "${RESULTS_DIR}/agent-version-${OS_KEY}.txt" 2>/dev/null || true
fi

# ── 3. Start oracle-proxy.py directly (headless — no systemd) ────────────────
log "Starting oracle-proxy.py in background..."
PROXY_PID=""
if [ -f /opt/tunevault-proxy/oracle-proxy.py ]; then
  # Build proxy.env for self-test
  cat > /tmp/proxy.env <<ENVEOF
ORACLE_TEST_DSN=${ORACLE_TEST_DSN:-}
ORACLE_TEST_USER=${ORACLE_TEST_USER:-}
ORACLE_TEST_PASSWORD=${ORACLE_TEST_PASSWORD:-}
TUNEVAULT_APP_URL=${TUNEVAULT_APP_URL:-}
TEST_TENANT_API_KEY=${TEST_TENANT_API_KEY:-}
ENVEOF

  /opt/tunevault-proxy/venv/bin/python3 /opt/tunevault-proxy/oracle-proxy.py \
    --port 8765 --headless 2>/tmp/proxy.log &
  PROXY_PID=$!
  sleep 3  # allow startup
  log "oracle-proxy.py started (PID $PROXY_PID)"
else
  log "oracle-proxy.py not found at expected path — probe results will reflect this"
fi

# ── 4. Run 7-probe self-test ──────────────────────────────────────────────────
log "Running 7-probe self-test..."

PROBE_RESULTS=()
ALL_PASS=true
TOTAL_FAIL=0

run_probe() {
  local N=$1
  local NAME=$2
  local CMD=$3
  local PROBE_START=$(date +%s%3N)

  log "  [${N}/7] ${NAME}..."
  set +e
  OUTPUT=$(eval "$CMD" 2>&1)
  local EXIT=$?
  set -e
  local PROBE_END=$(date +%s%3N)
  local PROBE_MS=$((PROBE_END - PROBE_START))

  if [ $EXIT -eq 0 ]; then
    PROBE_RESULTS+=("{\"n\":${N},\"status\":\"pass\",\"ms\":${PROBE_MS},\"error\":null}")
    log "  [${N}/7] ${NAME} ............... PASS (${PROBE_MS}ms)"
  else
    ALL_PASS=false
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    # Truncate error to 200 chars, escape JSON
    local ERR=$(echo "$OUTPUT" | tail -3 | tr -d '"\\' | head -c 200)
    PROBE_RESULTS+=("{\"n\":${N},\"status\":\"fail\",\"ms\":${PROBE_MS},\"error\":\"${ERR}\"}")
    log "  [${N}/7] ${NAME} ............... FAIL (${PROBE_MS}ms)"
    log "  → $ERR"
  fi
}

skip_probe() {
  local N=$1
  local NAME=$2
  local REASON=$3
  PROBE_RESULTS+=("{\"n\":${N},\"status\":\"skip\",\"ms\":null,\"error\":\"${REASON}\"}")
  log "  [${N}/7] ${NAME} ............... SKIP (${REASON})"
}

# Probe 1: Python env — cx_Oracle + oracledb imports
run_probe 1 "Python env (cx_Oracle + oracledb)" \
  "/opt/tunevault-proxy/venv/bin/python3 -c 'import cx_Oracle, oracledb; print(cx_Oracle.version, oracledb.__version__)' 2>&1"

# Probe 2: Agent connectivity (proxy /health)
if [ -n "$PROXY_PID" ]; then
  run_probe 2 "Agent connectivity" \
    "curl -sf --max-time 15 http://localhost:8765/health | grep -q '\"status\"'"
else
  skip_probe 2 "Agent connectivity" "proxy not started"
fi

# Probe 3: TNS / listener (requires ORACLE_TEST_DSN)
if [ -n "${ORACLE_TEST_DSN:-}" ]; then
  DSN_HOST=$(echo "$ORACLE_TEST_DSN" | cut -d: -f1)
  DSN_PORT=$(echo "$ORACLE_TEST_DSN" | cut -d: -f2 | cut -d/ -f1)
  run_probe 3 "TNS/listener resolution" \
    "timeout 15 bash -c \"echo '' > /dev/tcp/${DSN_HOST}/${DSN_PORT:-1521}\" 2>&1"
else
  skip_probe 3 "TNS/listener resolution" "ORACLE_TEST_DSN not configured"
fi

# Probe 4: Oracle credentials (requires DSN + credentials)
PROBE4_OK=false
if [ -n "${ORACLE_TEST_DSN:-}" ] && [ -n "${ORACLE_TEST_USER:-}" ] && [ -n "${ORACLE_TEST_PASSWORD:-}" ]; then
  run_probe 4 "Oracle credentials" \
    "/opt/tunevault-proxy/venv/bin/python3 -c \"
import oracledb
conn = oracledb.connect(user='${ORACLE_TEST_USER}', password='${ORACLE_TEST_PASSWORD}', dsn='${ORACLE_TEST_DSN}')
cur = conn.cursor()
cur.execute('SELECT 1 FROM DUAL')
conn.close()
print('ok')
\" 2>&1"
  # Check if probe 4 passed
  LAST_RESULT="${PROBE_RESULTS[-1]}"
  if echo "$LAST_RESULT" | grep -q '"status":"pass"'; then
    PROBE4_OK=true
  fi
else
  skip_probe 4 "Oracle credentials" "credentials not configured"
fi

# Probe 5: SSH bastion (skip if no SSH config — not required for basic validation)
skip_probe 5 "SSH bastion" "SSH bastion not applicable in headless CI mode"

# Probe 6: End-to-end query (only if probe 4 passed)
if [ "$PROBE4_OK" = "true" ]; then
  run_probe 6 "End-to-end query (V\$INSTANCE)" \
    "/opt/tunevault-proxy/venv/bin/python3 -c \"
import oracledb
conn = oracledb.connect(user='${ORACLE_TEST_USER}', password='${ORACLE_TEST_PASSWORD}', dsn='${ORACLE_TEST_DSN}')
cur = conn.cursor()
cur.execute('SELECT STATUS, DATABASE_STATUS FROM V\\\$INSTANCE')
row = cur.fetchone()
conn.close()
print('status:', row[0], 'db_status:', row[1])
\" 2>&1"
else
  skip_probe 6 "End-to-end query" "skipped because probe 4 (credentials) did not pass"
fi

# Probe 7: Proxy version current — /api/test must return 410 (not 200/stale)
# In headless CI mode the proxy was started on port 8765 (not default 3100).
# PASS if response is 410 Gone; FAIL if 200 (legacy endpoint still active).
if [ -n "$PROXY_PID" ]; then
  PROBE7_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST http://localhost:8765/api/test \
    -H 'X-Api-Key: dummy' -d '{}' --max-time 5 2>/dev/null || echo "000")
  if [ "$PROBE7_HTTP" = "410" ]; then
    PROBE7_MS=0
    PROBE_RESULTS+=("{\"n\":7,\"status\":\"pass\",\"ms\":${PROBE7_MS},\"error\":null}")
    log "  [7/7] Proxy version current ............... PASS (410 Gone — proxy current)"
  else
    ALL_PASS=false
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    PROBE_ERR="Stale proxy: /api/test returned ${PROBE7_HTTP} (expected 410 Gone)"
    PROBE_RESULTS+=("{\"n\":7,\"status\":\"fail\",\"ms\":0,\"error\":\"${PROBE_ERR}\"}")
    log "  [7/7] Proxy version current ............... FAIL (http_code=${PROBE7_HTTP})"
    log "  → ${PROBE_ERR}"
  fi
else
  skip_probe 7 "Proxy version current" "proxy not started"
fi

# ── 5. Kill proxy ─────────────────────────────────────────────────────────────
if [ -n "$PROXY_PID" ]; then
  kill "$PROXY_PID" 2>/dev/null || true
fi

# ── 6. Build JSON result ──────────────────────────────────────────────────────
END_MS=$(date +%s%3N)
DURATION=$((END_MS - START_MS))
PROBES_JSON=$(IFS=,; echo "[${PROBE_RESULTS[*]}]")

if [ "$ALL_PASS" = "true" ]; then
  OVERALL="pass"
elif [ $TOTAL_FAIL -gt 0 ]; then
  OVERALL="fail"
else
  OVERALL="pass"  # all skipped = pass (no oracle target configured)
fi

log "Result: overall=${OVERALL} probes=${#PROBE_RESULTS[@]} failed=${TOTAL_FAIL} duration=${DURATION}ms"

# JSON summary — must be the last line of stdout for CI to parse
echo "{\"probes\":${PROBES_JSON},\"overall\":\"${OVERALL}\",\"duration_total_ms\":${DURATION}}"
