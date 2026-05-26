#!/usr/bin/env bash
# ============================================================
# TuneVault — Local Oracle Proxy Validation Script
# ============================================================
# Validates oracle-proxy.py against a local Oracle XE instance.
# Runs all 9 checks + writes validation-report.json.
#
# Usage:
#   bash run-local-validation.sh
#   bash run-local-validation.sh --host localhost --port 2222 --service XE
#
# Prerequisites:
#   - Python 3.6+
#   - pip3 install cx_Oracle
#   - Oracle XE 21c running (VirtualBox or bare-metal)
#   - TUNEVAULT_RO user created with SELECT_CATALOG_ROLE
#   - proxy.env in the same directory (or env vars set)
#
# proxy.env format:
#   ORACLE_HOST=localhost
#   ORACLE_PORT=1521
#   ORACLE_SERVICE=XE
#   ORACLE_USER=TUNEVAULT_RO
#   ORACLE_PASSWORD=your_password_here
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[PASS]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[FAIL]${NC}  $*"; }
header()  { echo -e "\n${BOLD}$*${NC}"; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
header "TuneVault Oracle Proxy — Local Validation"
echo "======================================================"

# Python 3 check
if ! command -v python3 &>/dev/null; then
  error "python3 not found. Install Python 3.6+ first."
  exit 1
fi
PY_VER=$(python3 --version 2>&1)
info "Python: $PY_VER"

# cx_Oracle check
if ! python3 -c "import cx_Oracle" 2>/dev/null; then
  error "cx_Oracle not installed."
  echo ""
  echo "  Install with:  pip3 install cx_Oracle"
  echo "  Requires Oracle Instant Client libs:"
  echo "    https://www.oracle.com/database/technologies/instant-client/downloads.html"
  exit 1
fi
info "cx_Oracle: $(python3 -c 'import cx_Oracle; print(cx_Oracle.version)')"

# ── Load proxy.env ────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/proxy.env" ]]; then
  info "Loading proxy.env from $SCRIPT_DIR/proxy.env"
  set -a; source "$SCRIPT_DIR/proxy.env"; set +a
else
  warn "proxy.env not found — using environment variables or defaults"
  warn "Create $SCRIPT_DIR/proxy.env with:"
  echo ""
  echo "  ORACLE_HOST=localhost"
  echo "  ORACLE_PORT=1521"
  echo "  ORACLE_SERVICE=XE"
  echo "  ORACLE_USER=TUNEVAULT_RO"
  echo "  ORACLE_PASSWORD=your_password_here"
  echo ""
fi

ORACLE_HOST="${ORACLE_HOST:-localhost}"
ORACLE_PORT="${ORACLE_PORT:-1521}"
ORACLE_SERVICE="${ORACLE_SERVICE:-XE}"
ORACLE_USER="${ORACLE_USER:-TUNEVAULT_RO}"

# Override with CLI args if provided
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)     ORACLE_HOST="$2";    shift 2 ;;
    --port)     ORACLE_PORT="$2";    shift 2 ;;
    --service)  ORACLE_SERVICE="$2"; shift 2 ;;
    --user)     ORACLE_USER="$2";    shift 2 ;;
    --password) ORACLE_PASSWORD="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
info "Target: $ORACLE_USER @ $ORACLE_HOST:$ORACLE_PORT/$ORACLE_SERVICE"
echo "======================================================"

# ── TCP reachability ──────────────────────────────────────────────────────────
header "Step 1: TCP connectivity"
if timeout 5 bash -c "echo > /dev/tcp/$ORACLE_HOST/$ORACLE_PORT" 2>/dev/null; then
  success "$ORACLE_HOST:$ORACLE_PORT is reachable"
else
  error "Cannot reach $ORACLE_HOST:$ORACLE_PORT"
  echo ""
  echo "  VirtualBox fix:"
  echo "    Machine → Settings → Network → Adapter 1 → Port Forwarding"
  echo "    Name: Oracle  Protocol: TCP  Host Port: 1521  Guest Port: 1521"
  echo ""
  echo "  OR if using SSH tunnel on port 2222:"
  echo "    ssh -p 2222 oracle@localhost -L 1521:localhost:1521"
  echo ""
  # Don't exit — Python harness will log the failure properly
fi

# ── Run Python harness ────────────────────────────────────────────────────────
header "Step 2: Full validation (Python harness)"
echo ""

HARNESS="$SCRIPT_DIR/local_validation.py"
if [[ ! -f "$HARNESS" ]]; then
  error "local_validation.py not found at $HARNESS"
  exit 1
fi

# Export for the Python harness
export ORACLE_HOST ORACLE_PORT ORACLE_SERVICE
export ORACLE_USER ORACLE_PASSWORD

set +e
python3 "$HARNESS" "$@"
EXIT_CODE=$?
set -e

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/validation-report.json" ]]; then
  header "Report: $SCRIPT_DIR/validation-report.json"
fi

if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "\n${GREEN}${BOLD}✓ All checks passed.${NC}"
  echo "  Your Oracle XE instance + proxy setup is ready."
  echo ""
  echo "  Next steps:"
  echo "    1. Copy oracle-proxy.py to your Oracle server"
  echo "    2. Set TUNEVAULT_API_KEY + run proxy:"
  echo "       export TUNEVAULT_API_KEY=your-key"
  echo "       python3 oracle-proxy.py"
  echo "    3. Add connection in TuneVault dashboard → Proxy URL"
else
  echo -e "\n${RED}${BOLD}✗ Some checks failed.${NC}"
  echo "  Review the output above and validation-report.json for details."
  echo ""
  echo "  Common fixes:"
  echo "    FAIL cx_Oracle:          pip3 install cx_Oracle"
  echo "    FAIL TCP connectivity:   Check VirtualBox port-forwarding (1521→1521)"
  echo "    FAIL Oracle connection:  Verify ORACLE_USER / ORACLE_PASSWORD in proxy.env"
  echo "    FAIL SELECT_CATALOG:     GRANT SELECT_CATALOG_ROLE TO TUNEVAULT_RO;"
fi

exit $EXIT_CODE
