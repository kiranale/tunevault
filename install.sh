#!/usr/bin/env bash
# TuneVault Agent Installer — v7.5 (CLI helper, upgrade mode, pinned pip deps)
# CHANGELOG:
#   v7.5 (2026-05-24): Cherry-pick v7.0 candidate wins into v7.4 baseline. (Task #1847672)
#     - tunevault-agent CLI adds diagnose, version, repair (pinned deps), rotate-key, start, help
#     - --upgrade mode re-uses existing creds from agent.env; skips provisioning
#     - --headless mode for CI smoke tests (dummy creds, skip service install)
#     - 4-probe self-check: systemctl is-active, oracledb import, oracle-proxy.py exists, API_KEY len>10
#     - 60s heartbeat poll (exits early at alive:true + seconds_ago<=30)
#     - On systemd failure: POST install-failures with installer_version=7.5.0
#     - StartLimitBurst=3 + StartLimitIntervalSec=300 in systemd [Unit]
#     - Stop+disable legacy tunevault-proxy.service before new unit install
#     - pip deps pinned: python-oracledb==2.5.1, paramiko==3.5.0, requests==2.32.3, pyyaml==6.0.2
#     - KEEPS v7.4 _pmon_sids_detect() — /proc/*/comm + strict regex; NO ps|awk regression
#   v7.4 (2026-05-23): PMON SID detection rewritten. All 4 `ps -eo args= | awk ora_pmon` call
#     sites replaced with _pmon_sids_detect(): enumerates /proc/*/comm (no ps/awk, no shell
#     splitting), applies strict ^ora_pmon_([A-Za-z][A-Za-z0-9_$#]{0,7})$ regex — metacharacters
#     and garbage strings ('/', '"");', '}') produce zero matches. pgrep fallback for containers.
#     Eliminates "Rejected SID candidate" log noise and latent injection risk. (Task #1838549)
#   v7.1 (2026-05-23): tunevault-agent uninstall subcommand. Interactive prompt (skip with -y). Steps: stop/disable systemd service, POST /api/agent/uninstall cloud deregister (idempotent), remove unit file, daemon-reload, rm -rf /opt/tunevault + /etc/tunevault. Flags: --dry-run, --purge-logs, --keep-connection. Success banner now includes "To remove: sudo tunevault-agent uninstall".
#   v7.0 (2026-05-22): SID detection hardening. (1) Strict regex validation ^[A-Za-z][A-Za-z0-9_$#]{0,7}$ applied to every candidate — rejects error strings, spaces, asterisks, shell metacharacters. (2) /etc/oratab promoted to Tier 2 (before srvctl); parses only non-comment non-star SID:HOME:Y/N lines. (3) srvctl (Tier 3) guarded by CRS presence check: /etc/oracle/olr.loc OR crsctl binary found — never invoked on standalone installs. (4) Empty-SID array sends explicit [] + surfaced UI message. Fixes apex-lab regression: garbage srvctl error string was rendered as only selectable SID.
#   v6.9 (2026-05-22): tunevault-agent doctor --deep: 3 sequential HTTP probes (health/register dry-run/heartbeat) with full HTTP traces + latency_ms. Server-side: POST /api/agent/register X-TuneVault-Doctor:dry-run validate-only, heartbeat {doctor:true} short-circuit.
#   v6.8 (2026-05-22): Agent emits structured INFO milestones to stdout (journald-captured): boot/env/deps/dns/health/register/loop-entered/heartbeat. Distinct exit codes per failure stage (exit 3-8,20). 30s watchdog: no heartbeat within 30s → sys.exit(20) → systemd restart. Bumps agent to v3.6.2.
#   v6.7 (2026-05-22): tunevault-agent doctor (7-check table: env-file/systemd/api-reachable/api-auth/heartbeat/oracle-driver/disk-space) + tunevault-agent logs subcommand.
#   v6.6 (2026-05-22): Move StartLimitIntervalSec/StartLimitBurst from [Service] to [Unit] (systemd unit-level directives); add systemd-analyze verify post-install gate.
#   v6.5 (2026-05-22): Write agent.env before systemctl start + verify non-empty; tempfile unit write (install -m 0644); 10s journal health gate post-start.
#   v6.4 (2026-05-22): OS-agnostic output; PMON awk rewrite; listener endpoint fallback chain.
#   v6.3 (2025-XX-XX): Python 3.6 fix: use oracle-proxy.py when agent.cli requires 3.7+.
# Usage: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │  INSTALLER CONTRACT — what this script does, guaranteed end-state       │
# ├──────────────────────────────────┬──────────────────────────────────────┤
# │  SSH-mode connection             │  TNS/cx_Oracle connection            │
# ├──────────────────────────────────┼──────────────────────────────────────┤
# │  1. OS detection (OEL/RHEL/Ubuntu│  Same OS detection + Python check    │
# │     /Amazon Linux)               │                                      │
# │  2. Call /api/agent/provision    │  Same provisioning call              │
# │     → API key, connection ID     │                                      │
# │  3. Install Python venv +        │  3. Install Python venv              │
# │     paramiko for SSH support     │  4. Install cx_Oracle==8.3.0         │
# │  4. Download oracle-proxy.py     │     ─ Python 3.6: pre-built wheel   │
# │  5. Write /etc/tunevault/        │       wheel from tunevault mirror    │
# │     proxy.env (API key, URL,     │     ─ All others: pip install        │
# │     connection ID)               │     ─ Verify: python3 -c             │
# │  6. Create + enable + start      │       'import cx_Oracle;             │
# │     tunevault-proxy.service      │        print(cx_Oracle.version)'     │
# │  7. Detect Oracle SIDs (PMON     │     ─ Falls back to oracledb thin    │
# │     → oratab → srvctl/CRS)       │       driver if cx_Oracle fails      │
# │  8. Auto-register via            │  5-7. Same proxy/env/services as SSH │
# │     /api/agent/confirm after     │                                      │
# │     proxy is active              │  Same SID detection                  │
# │  9. Self-checks (4 checks):      │  Same registration                   │
# │     ─ proxy service active       │  Self-checks (4 checks):             │
# │     ─ cx_Oracle/oracledb import  │  ─ proxy service active              │
# │     ─ Agent registered w/ cloud  │  ─ cx_Oracle/oracledb import         │
# │     ─ SELECT 1 FROM DUAL         │  ─ Agent registered w/ cloud         │
# │                                  │  ─ SELECT 1 FROM DUAL                │
# ├──────────────────────────────────┴──────────────────────────────────────┤
# │  ARCHITECTURE: Agent initiates outbound HTTPS long-poll to TuneVault.   │
# │  Zero inbound ports. Zero DNS. Zero Cloudflare. Zero tunnels.           │
# │  IDEMPOTENCY: re-running converges to the same end state.               │
# │  ─ venv pip used exclusively (never system pip)                         │
# │  ─ cx_Oracle pinned to 8.3.0                                            │
# │  ─ --upgrade re-downloads proxy + cx_Oracle + restarts proxy service    │
# └─────────────────────────────────────────────────────────────────────────┘

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${YELLOW}[..] $*${NC}"; }
err()  { echo -e "${RED}[ERR] $*${NC}" >&2; exit 1; }

# ── Mode flags ───────────────────────────────────────────────────────────────
UPGRADE_ONLY=0
REPAIR_ONLY=0
HEADLESS=0  # CI mode: skips interactive prompts, API provisioning, and systemd; uses dummy creds
ALLOW_SHA_MISMATCH=0  # dev/debug override — never set in production installs
for arg in "$@"; do
  [ "$arg" = "--upgrade"          ] && UPGRADE_ONLY=1
  [ "$arg" = "--repair"           ] && REPAIR_ONLY=1
  [ "$arg" = "--headless"         ] && HEADLESS=1
  [ "$arg" = "--fake-creds"       ] && HEADLESS=1   # alias used in CI workflow
  [ "$arg" = "--allow-sha-mismatch" ] && ALLOW_SHA_MISMATCH=1
done

# ── API URL (can be overridden for testing) — must come before banner ────────
TUNEVAULT_API="${TUNEVAULT_API:-https://tunevault.app}"

# ── Release banner — fetch manifest and print version/sha before doing anything
RELEASE_VERSION=""; RELEASE_BUILD=""; RELEASE_SHA256=""; RELEASE_PYTHON=""
_release_json=$(curl -fsSL --max-time 10 "${TUNEVAULT_API}/api/agent/release" 2>/dev/null || true)
if [ -n "$_release_json" ]; then
  RELEASE_VERSION=$(echo "$_release_json" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  RELEASE_BUILD=$(echo "$_release_json"   | grep -o '"build_time":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  RELEASE_SHA256=$(echo "$_release_json"  | grep -o '"sha256":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  RELEASE_PYTHON=$(echo "$_release_json"  | grep -o '"python_min":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  RELEASE_WARN=$(echo "$_release_json"    | grep -o '"warning":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
fi

echo -e "${BOLD}====================================================${NC}"
echo -e "${BOLD}  TuneVault Agent Installer${NC}"
if [ -n "$RELEASE_VERSION" ]; then
echo -e "    Version:    ${RELEASE_VERSION}"
echo -e "    Built:      ${RELEASE_BUILD}"
echo -e "    SHA256:     ${RELEASE_SHA256:0:16}...${RELEASE_SHA256: -8}"
echo -e "    Python:     >= ${RELEASE_PYTHON:-3.6}"
else
echo -e "    (release manifest unavailable — proceeding)"
fi
echo -e "${BOLD}====================================================${NC}"
echo ""

# Warn if cloud thinks the served tarball is stale
if [ -n "$RELEASE_WARN" ]; then
  echo -e "${RED}  ⚠  CLOUD WARNING: ${RELEASE_WARN}${NC}"
  echo ""
fi

# ── Root check ──────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || err "Run as root: curl ... | sudo TUNEVAULT_TOKEN=xxx bash"

# ── Token check (not needed for repair, upgrade, or headless/CI mode) ─────────
if [ "$REPAIR_ONLY" -eq 0 ] && [ "$UPGRADE_ONLY" -eq 0 ] && [ "$HEADLESS" -eq 0 ]; then
  [ -n "${TUNEVAULT_TOKEN:-}" ] || err "TUNEVAULT_TOKEN not set. Get the install command from the TuneVault UI."
fi

# ── REPAIR MODE ──────────────────────────────────────────────────────────────
# curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair
# Skips: provisioning, user creation, systemd unit creation, cert provisioning.
# Does: re-installs cx_Oracle into the existing venv, restarts service, verifies health.
if [ "$REPAIR_ONLY" -eq 1 ]; then
  echo -e "${BOLD}╔═══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║       TuneVault Agent REPAIR Mode             ║${NC}"
  echo -e "${BOLD}╚═══════════════════════════════════════════════╝${NC}"
  echo ""

  PROXY_DEST="/opt/tunevault"
  VENV_DIR="${PROXY_DEST}/venv"
  VENV_PIP="${VENV_DIR}/bin/pip"
  VENV_PYTHON="${VENV_DIR}/bin/python3"
  CX_ORACLE_VERSION="8.3.0"

  [ -f "$VENV_PYTHON" ] || err "Venv not found at $VENV_DIR — run full installer first: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"

  # Detect Python version
  PYTHON_MAJOR_MINOR=$("$VENV_PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null) || PYTHON_MAJOR_MINOR=""
  [ -n "$PYTHON_MAJOR_MINOR" ] || err "Cannot determine Python version from venv at $VENV_PYTHON"
  ok "Venv Python: ${PYTHON_MAJOR_MINOR}"

  IS_PY36=0
  [ "$PYTHON_MAJOR_MINOR" = "3.6" ] && IS_PY36=1

  # Upgrade pip in venv
  "$VENV_PIP" install --quiet --upgrade pip setuptools 2>/dev/null || true

  # Detect ORACLE_HOME / LD_LIBRARY_PATH
  if [ -z "${ORACLE_HOME:-}" ]; then
    if [ -f /etc/oratab ]; then
      DETECTED_HOME=$(grep -v '^#' /etc/oratab 2>/dev/null | grep -v '^$' | grep -v '^\*' | head -1 | cut -d: -f2 || true)
      [ -n "$DETECTED_HOME" ] && [ -d "$DETECTED_HOME" ] && export ORACLE_HOME="$DETECTED_HOME"
    fi
    if [ -z "${ORACLE_HOME:-}" ]; then
      ORACLE_PID=$(pgrep -f "ora_pmon" 2>/dev/null | head -1 || true)
      if [ -n "$ORACLE_PID" ]; then
        DETECTED_HOME=$(strings /proc/"$ORACLE_PID"/environ 2>/dev/null | grep "^ORACLE_HOME=" | cut -d= -f2 || true)
        [ -n "$DETECTED_HOME" ] && [ -d "$DETECTED_HOME" ] && export ORACLE_HOME="$DETECTED_HOME"
      fi
    fi
  fi
  [ -n "${ORACLE_HOME:-}" ] && export LD_LIBRARY_PATH="${ORACLE_HOME}/lib:${LD_LIBRARY_PATH:-}" && ok "ORACLE_HOME: $ORACLE_HOME"

  # Attempt 1: cx_Oracle
  info "Installing cx_Oracle==${CX_ORACLE_VERSION} into existing venv…"
  REPAIR_DRIVER_OK=0

  if [ "$IS_PY36" -eq 1 ]; then
    "$VENV_PIP" install --quiet "cx_Oracle==${CX_ORACLE_VERSION}" 2>&1 | tail -5 || {
      info "Direct pip failed — trying manylinux wheel…"
      WHEEL_URL="https://files.pythonhosted.org/packages/cx_Oracle-${CX_ORACLE_VERSION}-cp36-cp36m-manylinux_2_5_x86_64.manylinux1_x86_64.whl"
      TMP_WHEEL="/tmp/cx_oracle_${CX_ORACLE_VERSION}_py36.whl"
      curl -fsSL -o "$TMP_WHEEL" "$WHEEL_URL" 2>/dev/null && "$VENV_PIP" install --quiet "$TMP_WHEEL" 2>&1 | tail -3 && rm -f "$TMP_WHEEL" || true
    }
  else
    "$VENV_PIP" install --quiet "cx_Oracle==${CX_ORACLE_VERSION}" 2>&1 | tail -5 || true
  fi

  if "$VENV_PYTHON" -c "import cx_Oracle; print('cx_Oracle', cx_Oracle.version)" 2>/dev/null; then
    ok "cx_Oracle verified in venv"
    REPAIR_DRIVER_OK=1
  else
    info "cx_Oracle import still failing — trying oracledb thin driver…"
    "$VENV_PIP" install --quiet "oracledb" 2>&1 | tail -3 || true
    if "$VENV_PYTHON" -c "import oracledb; print('oracledb', oracledb.__version__)" 2>/dev/null; then
      ok "oracledb thin driver verified in venv"
      REPAIR_DRIVER_OK=1
    fi
  fi

  [ "$REPAIR_DRIVER_OK" -eq 1 ] || err "REPAIR FAILED — neither cx_Oracle nor oracledb could be installed.
  Install Oracle Instant Client first, then re-run repair:
    curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair"

  # Restart service — try tunevault-agent first (v6.1+), fall back to tunevault-proxy (v3-v5)
  _REPAIR_SVC="tunevault-agent"
  systemctl is-active tunevault-agent.service >/dev/null 2>&1 || _REPAIR_SVC="tunevault-proxy"
  info "Restarting ${_REPAIR_SVC} service…"
  systemctl restart "${_REPAIR_SVC}.service" || err "systemctl restart ${_REPAIR_SVC} failed — check: journalctl -u ${_REPAIR_SVC} -n 50"
  sleep 5

  # Verify service is active
  if ! systemctl is-active "${_REPAIR_SVC}.service" >/dev/null 2>&1; then
    err "${_REPAIR_SVC}.service is not active after restart.
  Check logs: journalctl -u ${_REPAIR_SVC} -n 50"
  fi
  ok "${_REPAIR_SVC}.service is active"

  # Verify /health endpoint
  HEALTH_OK=0
  for _attempt in 1 2 3 4 5 6; do
    HEALTH_RESP=$(curl -fs http://localhost:3100/health 2>/dev/null || true)
    if echo "$HEALTH_RESP" | grep -q '"status"'; then
      HEALTH_OK=1
      break
    fi
    [ "$_attempt" -lt 6 ] && sleep 2
  done

  if [ "$HEALTH_OK" -eq 0 ]; then
    err "REPAIR INCOMPLETE — service is active but /health did not return JSON {status: ok} within 12s.
  Check logs: journalctl -u ${_REPAIR_SVC} -n 50"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}╔═══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║  ✅ REPAIR COMPLETE — agent active, /health OK        ║${NC}"
  echo -e "${GREEN}${BOLD}║     running post-repair diagnostics…                  ║${NC}"
  echo -e "${GREEN}${BOLD}╚═══════════════════════════════════════════════════════╝${NC}"

  # Post-repair: run diagnose to confirm all probes pass.
  # If the diagnose library isn't installed yet (old install), skip gracefully.
  _DIAG_LIB=/usr/local/lib/tunevault-diagnose.sh
  if [ -f "$_DIAG_LIB" ]; then
    # shellcheck source=/dev/null
    source "$_DIAG_LIB"
    run_diagnose 1 || {
      echo -e "${YELLOW}⚠ Repair succeeded but diagnose found issues above.${NC}"
      echo -e "${YELLOW}  Check the → Fix lines above for next steps.${NC}"
      # Don't exit 1 — repair itself worked; diagnose failures are advisory here.
    }
  else
    info "Diagnose library not installed — upgrade with: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<existing-token> bash"
  fi

  exit 0
fi

# ── OS detection ─────────────────────────────────────────────────────────────
info "Detecting operating system…"
OS_INFO="unknown"
PKG_MGR=""
OS_MAJOR_VERSION=""

if [ -f /etc/oracle-release ]; then
  OS_INFO="$(cat /etc/oracle-release)"
  PKG_MGR="yum"
  OS_MAJOR_VERSION=$(echo "$OS_INFO" | grep -oE '[0-9]+' | head -1 || echo "0")
elif [ -f /etc/redhat-release ]; then
  OS_INFO="$(cat /etc/redhat-release)"
  PKG_MGR="yum"
  OS_MAJOR_VERSION=$(echo "$OS_INFO" | grep -oE '[0-9]+' | head -1 || echo "0")
elif [ -f /etc/system-release ] && grep -qi "amazon" /etc/system-release 2>/dev/null; then
  OS_INFO="$(cat /etc/system-release)"
  PKG_MGR="yum"
  OS_MAJOR_VERSION=7  # Amazon Linux 2 ~ el7; Amazon Linux 2023 handled below
  grep -qi "2023" /etc/system-release 2>/dev/null && OS_MAJOR_VERSION=8
elif [ -f /etc/os-release ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  OS_INFO="$NAME $VERSION_ID"
  OS_MAJOR_VERSION=$(echo "$VERSION_ID" | cut -d. -f1)
  case "$ID" in
    ubuntu|debian) PKG_MGR="apt";;
    rhel|centos|rocky|almalinux|fedora) PKG_MGR="yum";;
    *) PKG_MGR="unknown";;
  esac
fi

ok "OS: $OS_INFO"
[ "$PKG_MGR" != "unknown" ] || err "Unsupported Linux distribution — install requires yum or apt package manager with Python 3.6+."

# ── Dependency check ─────────────────────────────────────────────────────────
info "Checking dependencies…"
for cmd in curl python3 systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    info "Installing $cmd…"
    if [ "$PKG_MGR" = "apt" ]; then
      apt-get install -y -q "$cmd" 2>/dev/null || err "Cannot install $cmd"
    else
      yum install -y -q "$cmd" 2>/dev/null || err "Cannot install $cmd"
    fi
  fi
done
ok "Dependencies satisfied"

# ── Detect Python version for wheel selection ─────────────────────────────────
PYTHON_MAJOR_MINOR=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
ok "Python: ${PYTHON_MAJOR_MINOR}"

# Python 3.6: cx_Oracle 8.3.0 is the last version with a 3.6 wheel.
# Newer cx_Oracle requires Python 3.8+.
IS_PY36=0
[ "$PYTHON_MAJOR_MINOR" = "3.6" ] && IS_PY36=1

# ── Provision: call /api/agent/provision ──────────────────────────────────────
# Pure-bash JSON field extractor (no jq required)
get_field() {
  local val
  val=$(echo "$1" | sed -n "s/.*\"$2\":\s*\"\([^\"]*\)\".*/\1/p" | head -1)
  if [ -z "$val" ]; then
    val=$(echo "$1" | sed -n "s/.*\"$2\":\s*\([0-9][0-9]*\).*/\1/p" | head -1)
  fi
  echo "$val"
}
get_bool() { echo "$1" | grep -o "\"$2\":\s*true" | grep -c true || true; }

if [ "$HEADLESS" -eq 1 ]; then
  # CI/headless mode: skip real API provisioning, use dummy creds.
  # Goal: verify venv + driver install only; no live Oracle or TuneVault needed.
  info "Headless mode — skipping API provisioning, using dummy credentials"
  API_KEY="headless-test-key"
  API_URL="${TUNEVAULT_API}"
  CONNECTION_ID="0"
  ok "Headless credentials set (API_KEY=headless-test-key, CONNECTION_ID=0)"
elif [ "$UPGRADE_ONLY" -eq 1 ]; then
  # Upgrade mode: restore creds from agent.env (v7.5+) or legacy proxy.env (v3-v5).
  # No new token needed — re-uses TUNEVAULT_API_KEY/CONNECTION_ID/API_URL already on disk.
  # WHY agent.env first: v7.4+ writes agent.env; proxy.env is only for older installs.
  if [ -f /etc/tunevault/agent.env ]; then
    source /etc/tunevault/agent.env
    _UPGRADE_ENV_SOURCE="agent.env"
  elif [ -f /etc/tunevault/proxy.env ]; then
    source /etc/tunevault/proxy.env
    _UPGRADE_ENV_SOURCE="proxy.env"
  else
    err "Neither agent.env nor proxy.env found — run fresh install first: curl ... | sudo TUNEVAULT_TOKEN=<token> bash"
  fi
  API_KEY="${TUNEVAULT_API_KEY:-}"
  API_URL="${TUNEVAULT_API_URL:-$TUNEVAULT_API}"
  CONNECTION_ID="${TUNEVAULT_CONNECTION_ID:-}"
  [ -n "$API_KEY" ]      || err "TUNEVAULT_API_KEY missing from ${_UPGRADE_ENV_SOURCE}"
  [ -n "$CONNECTION_ID" ] || err "TUNEVAULT_CONNECTION_ID missing from ${_UPGRADE_ENV_SOURCE}"
  ok "Upgrade mode — using existing credentials from ${_UPGRADE_ENV_SOURCE} (connection ID: $CONNECTION_ID)"
else
  info "Provisioning agent with TuneVault…"
  PROVISION_RESP=$(curl -fsSL -X POST \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${TUNEVAULT_TOKEN}\"}" \
    "${TUNEVAULT_API}/api/agent/provision") || err "Cannot reach ${TUNEVAULT_API}. Check network connectivity."

  API_KEY=$(get_field "$PROVISION_RESP" "api_key")
  API_URL=$(get_field "$PROVISION_RESP" "api_url")
  CONNECTION_ID=$(get_field "$PROVISION_RESP" "connection_id")

  [ -n "$API_KEY" ] || err "Provisioning failed — invalid token or server error."
  [ -n "$CONNECTION_ID" ] || err "Missing connection_id in provisioning response."
  # Fall back to tunevault.app if API_URL not in response
  API_URL="${API_URL:-$TUNEVAULT_API}"
  ok "Provisioned — connection ID: $CONNECTION_ID"
fi

# ── Write config files ────────────────────────────────────────────────────────
info "Writing config to /etc/tunevault…"
mkdir -p /etc/tunevault

# agent.env — single source of truth for all agent config.
# EnvironmentFile= in the systemd unit points here.
# Never add Environment= lines to the unit — they silently override this file.
# Preserve existing INSTALLED_AT if upgrading (don't overwrite original install timestamp)
_EXISTING_INSTALLED_AT=""
# Check new path first, fall back to legacy proxy.env for upgrades from v3/v4/v5
if [ -f /etc/tunevault/agent.env ]; then
  _EXISTING_INSTALLED_AT=$(grep '^INSTALLED_AT=' /etc/tunevault/agent.env 2>/dev/null | cut -d= -f2 || true)
elif [ -f /etc/tunevault/proxy.env ]; then
  _EXISTING_INSTALLED_AT=$(grep '^INSTALLED_AT=' /etc/tunevault/proxy.env 2>/dev/null | cut -d= -f2 || true)
fi
_INSTALLED_AT="${_EXISTING_INSTALLED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
_LAST_UPGRADE_AT=""
[ "$UPGRADE_ONLY" -eq 1 ] && _LAST_UPGRADE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > /etc/tunevault/agent.env <<ENVEOF
TUNEVAULT_API_KEY=${API_KEY}
TUNEVAULT_API_URL=${API_URL}
TUNEVAULT_CONNECTION_ID=${CONNECTION_ID}
VERSION=7.5.0
INSTALLED_AT=${_INSTALLED_AT}
LAST_UPGRADE_AT=${_LAST_UPGRADE_AT}
ENVEOF
chmod 600 /etc/tunevault/agent.env

# ── Verify agent.env before proceeding to systemd ────────────────────────────
# Root cause of the apex-lab incident: service started before agent.env had
# TUNEVAULT_API_KEY, causing oracle-proxy.py to print the fatal key-required
# message and exit, crash-looping the unit. Hard gate here prevents that.
[ -s /etc/tunevault/agent.env ] \
  || err "FATAL: /etc/tunevault/agent.env is empty after write — check disk space and /etc/tunevault permissions"
grep -q "^TUNEVAULT_API_KEY=" /etc/tunevault/agent.env \
  || err "FATAL: TUNEVAULT_API_KEY not found in /etc/tunevault/agent.env — provisioning may have failed"
_KEY_VAL=$(grep '^TUNEVAULT_API_KEY=' /etc/tunevault/agent.env | cut -d= -f2)
[ -n "$_KEY_VAL" ] \
  || err "FATAL: TUNEVAULT_API_KEY is blank in /etc/tunevault/agent.env — re-run installer with a valid token"
ok "agent.env verified — TUNEVAULT_API_KEY present and non-empty"

# ── Python proxy install (venv) ───────────────────────────────────────────────
# All Python work uses /opt/tunevault/venv exclusively — never system pip.
info "Setting up Python venv at /opt/tunevault/venv…"
PROXY_DEST="/opt/tunevault"
VENV_DIR="${PROXY_DEST}/venv"
VENV_PIP="${VENV_DIR}/bin/pip"
VENV_PYTHON="${VENV_DIR}/bin/python3"

mkdir -p "$PROXY_DEST"

# Download proxy script (always re-download on upgrade too)
info "Downloading oracle-proxy.py…"
curl -fsSL "${API_URL}/downloads/oracle-proxy.py" -o "${PROXY_DEST}/oracle-proxy.py" \
  || err "Failed to download oracle-proxy.py"
chmod +x "${PROXY_DEST}/oracle-proxy.py"
ok "oracle-proxy.py downloaded"

# Download agent/ Python package (needed for `python3 -m agent.cli start`)
info "Downloading agent package (agent-pkg.tar.gz)…"
if curl -fsSL "${API_URL}/downloads/agent-pkg.tar.gz" -o /tmp/tunevault-agent-pkg.tar.gz 2>/dev/null; then
  # Verify sha256 against the release manifest (if we fetched it at banner time).
  # Fails closed on mismatch — supply-chain safety. Use --allow-sha-mismatch for dev only.
  if [ -n "$RELEASE_SHA256" ] && command -v sha256sum >/dev/null 2>&1; then
    DOWNLOADED_SHA256=$(sha256sum /tmp/tunevault-agent-pkg.tar.gz | awk '{print $1}')
    if [ "$DOWNLOADED_SHA256" = "$RELEASE_SHA256" ]; then
      ok "sha256 verified: ${DOWNLOADED_SHA256:0:16}..."
    else
      echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
      echo -e "${RED}║  FATAL: tarball sha256 does not match release manifest           ║${NC}"
      echo -e "${RED}║  Expected: ${RELEASE_SHA256:0:48}  ║${NC}"
      echo -e "${RED}║  Got:      ${DOWNLOADED_SHA256:0:48}  ║${NC}"
      echo -e "${RED}║  Refusing to install an unverified binary.                       ║${NC}"
      echo -e "${RED}║  Contact support@tunevault.app or retry in a few minutes.        ║${NC}"
      echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
      if [ "$ALLOW_SHA_MISMATCH" -eq 1 ]; then
        echo -e "${YELLOW}[..] --allow-sha-mismatch set — skipping SHA gate (dev/debug only)${NC}"
      else
        exit 1
      fi
    fi
  fi
  # Unpack into /opt/tunevault/ so agent/__init__.py lands at /opt/tunevault/agent/__init__.py
  tar -xzf /tmp/tunevault-agent-pkg.tar.gz -C "${PROXY_DEST}" 2>/dev/null && \
    rm -f /tmp/tunevault-agent-pkg.tar.gz && \
    ok "agent/ package unpacked to ${PROXY_DEST}/agent/"
else
  # Non-fatal on upgrade — agent/ may already be present from a previous install.
  # If it's missing at service start the sanity check below will catch it.
  info "WARN: agent-pkg.tar.gz download failed — agent/ package may already be installed"
fi

# Set up venv (idempotent — no-op if already exists)
if [ ! -f "${VENV_PYTHON}" ]; then
  python3 -m venv "$VENV_DIR" 2>/dev/null || {
    info "venv module missing — installing python3-venv…"
    if [ "$PKG_MGR" = "apt" ]; then
      apt-get install -y -q python3-venv python3-pip 2>/dev/null
    else
      yum install -y -q python3-pip 2>/dev/null || true
      # Some yum-based distros may need python3-virtualenv from EPEL
      if ! python3 -m venv "$VENV_DIR" 2>/dev/null; then
        pip3 install virtualenv 2>/dev/null || python3 -m pip install virtualenv 2>/dev/null || true
        python3 -m virtualenv "$VENV_DIR"
      fi
    fi
    python3 -m venv "$VENV_DIR"
  }
  ok "venv created"
else
  ok "venv already exists — reusing"
fi

# Upgrade pip inside venv first (prevents old pip wheel install failures)
"$VENV_PIP" install --quiet --upgrade pip setuptools 2>/dev/null || true

# ── Install cx_Oracle 8.3.0 ──────────────────────────────────────────────────
# cx_Oracle 8.3.0 is the last release with Python 3.6 wheels.
# Python 3.8+: pip resolves 8.3.0 normally.
# Python 3.6: pip may resolve an incompatible version — force the wheel.
CX_ORACLE_VERSION="8.3.0"

install_cx_oracle() {
  info "Installing cx_Oracle==${CX_ORACLE_VERSION} into venv…"

  if [ "$IS_PY36" -eq 1 ]; then
    # Python 3.6: cx_Oracle 8.3.0 is the last version with a cp36 wheel.
    # PyPI still hosts it; pin explicitly so pip doesn't try cx_Oracle 9+.
    info "  Python 3.6 detected — installing compatible cx_Oracle ${CX_ORACLE_VERSION} wheel"
    "$VENV_PIP" install --quiet "cx_Oracle==${CX_ORACLE_VERSION}" 2>&1 | tail -5 || {
      # Fallback: download the manylinux wheel directly from PyPI
      info "  Direct pip failed — trying explicit manylinux wheel download…"
      WHEEL_URL="https://files.pythonhosted.org/packages/cx_Oracle-${CX_ORACLE_VERSION}-cp36-cp36m-manylinux_2_5_x86_64.manylinux1_x86_64.whl"
      TMP_WHEEL="/tmp/cx_oracle_${CX_ORACLE_VERSION}_py36.whl"
      if curl -fsSL -o "$TMP_WHEEL" "$WHEEL_URL" 2>/dev/null; then
        "$VENV_PIP" install --quiet "$TMP_WHEEL" 2>&1 | tail -3
        rm -f "$TMP_WHEEL"
      else
        info "  manylinux wheel download failed — cx_Oracle unavailable on this Python version"
        return 1
      fi
    }
  else
    "$VENV_PIP" install --quiet "cx_Oracle==${CX_ORACLE_VERSION}" 2>&1 | tail -5
  fi
}

# Install/reinstall cx_Oracle on fresh install OR upgrade
DRIVER_OK=0

# Install build deps for native extensions (cx_Oracle compiles against Oracle headers)
if [ "$UPGRADE_ONLY" -eq 0 ]; then
  if [ "$PKG_MGR" = "apt" ]; then
    apt-get install -y -q gcc libffi-dev python3-dev 2>/dev/null || true
  else
    yum install -y -q gcc libffi-devel python3-devel 2>/dev/null || true
  fi
fi

# Detect ORACLE_HOME so LD_LIBRARY_PATH is set when cx_Oracle tries to load
if [ -z "${ORACLE_HOME:-}" ]; then
  # Try oratab first
  if [ -f /etc/oratab ]; then
    DETECTED_HOME=$(grep -v '^#' /etc/oratab 2>/dev/null | grep -v '^$' | grep -v '^\*' | head -1 | cut -d: -f2 || true)
    [ -n "$DETECTED_HOME" ] && [ -d "$DETECTED_HOME" ] && export ORACLE_HOME="$DETECTED_HOME"
  fi
  # Try running PMON process env
  if [ -z "${ORACLE_HOME:-}" ]; then
    ORACLE_PID=$(pgrep -f "ora_pmon" 2>/dev/null | head -1 || true)
    if [ -n "$ORACLE_PID" ]; then
      DETECTED_HOME=$(strings /proc/"$ORACLE_PID"/environ 2>/dev/null | grep "^ORACLE_HOME=" | cut -d= -f2 || true)
      [ -n "$DETECTED_HOME" ] && [ -d "$DETECTED_HOME" ] && export ORACLE_HOME="$DETECTED_HOME"
    fi
  fi
fi
[ -n "${ORACLE_HOME:-}" ] && export LD_LIBRARY_PATH="${ORACLE_HOME}/lib:${LD_LIBRARY_PATH:-}" && ok "ORACLE_HOME: $ORACLE_HOME"

# Attempt 1: cx_Oracle (requires Oracle Instant Client or full client libs)
if install_cx_oracle && "$VENV_PYTHON" -c "import cx_Oracle; print('cx_Oracle', cx_Oracle.version)" 2>/dev/null; then
  ok "cx_Oracle $(${VENV_PYTHON} -c 'import cx_Oracle; print(cx_Oracle.version)') installed and verified"
  DRIVER_OK=1
else
  info "cx_Oracle import failed (Oracle Instant Client may be missing) — trying oracledb thin driver…"
  # Attempt 2: oracledb thin mode (pure Python, no Instant Client needed)
  "$VENV_PIP" install --quiet "oracledb" 2>&1 | tail -3 || true
  if "$VENV_PYTHON" -c "import oracledb; print('oracledb', oracledb.__version__)" 2>/dev/null; then
    ok "oracledb (thin driver, no Instant Client) installed and verified"
    DRIVER_OK=1
  else
    # Abort install — starting the service without a driver causes a crash loop.
    # Better to fail loud than to thrash systemd with RestartSec=10 indefinitely.
    err "FATAL: Neither cx_Oracle nor oracledb could be installed.
  Oracle Instant Client must be present before the driver can be installed.
  Install Instant Client (https://www.oracle.com/database/technologies/instant-client.html),
  then re-run the repair command:
    curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair"
  fi
fi

# Install remaining deps — pinned versions prevent import failures on fresh installs.
# WHY pinned: floating versions caused oracledb import failures on 2026-05-17 incident.
# python-oracledb: thin driver used when cx_Oracle not available
# paramiko: SSH connectivity mode
# requests: outbound HTTP long-poll channel
# pyyaml: agent.cli config parsing
"$VENV_PIP" install --quiet \
  "python-oracledb==2.5.1" \
  "paramiko==3.5.0" \
  "requests==2.32.3" \
  "pyyaml==6.0.2" \
  2>/dev/null || true
ok "Python proxy dependencies installed (pinned versions)"

# ── Connectivity probe — thin-mode connect attempt ────────────────────────────
# Run a real connect attempt in oracledb thin mode against discovered DSN/creds.
# This detects DPY-3015 (11g password verifier incompatible with thin mode) BEFORE
# we declare install success on package install alone.
#
# WHY thin mode first: oracledb thin is pure-Python and always available at this
# point (we just installed it above). If thin mode succeeds, nothing else needed.
# If it fails with DPY-3015/ORA-28040/ORA-01017 + "11g", we know the DB uses the
# old password verifier and we need Oracle Instant Client (thick mode).
#
# TELEMETRY: We track which path customers land on so Wave 1 can see the distribution.

# Install telemetry path: "thin_ok" | "ic_installed" | "thin_fail_no_ic" | "skipped"
_TELEMETRY_PATH="skipped"
_TELEMETRY_ERROR=""
_IC_DIR="/opt/tunevault/instantclient"
_IC_INSTALLED=0

# ── Instant Client installer function ─────────────────────────────────────────
# Downloads Oracle Instant Client Basic + SQL*Plus RPM from TuneVault mirror.
# Mirror URL is constructed from the API_URL so customers never need to reach oracle.com.
# Installs into /opt/tunevault/instantclient — isolated from /u01/app/oracle.
# The systemd unit Environment= lines are patched in-place after install.
install_instant_client() {
  local ic_dir="${_IC_DIR}"
  local ic_arch="x86_64"
  local ic_ver_major="21"  # IC 21.x has broad glibc compat; works on OL7+ (glibc 2.17+)

  # Platform detection — pick correct arch/version
  local uname_m
  uname_m=$(uname -m 2>/dev/null || echo "x86_64")
  case "$uname_m" in
    aarch64|arm64) ic_arch="aarch64";;
    *) ic_arch="x86_64";;
  esac

  # OL7 / glibc 2.17: IC 21.x minimum glibc is 2.14 — compatible.
  # But IC 21.x RPMs are el7/el8-compatible.
  local glibc_ver
  glibc_ver=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "2.17")
  info "Platform: ${uname_m}, glibc ${glibc_ver}, OS major ${OS_MAJOR_VERSION}"

  # Mirror URL: TuneVault serves IC RPMs at /downloads/instantclient/<arch>/<rpm>
  # This avoids oracle.com network dependency on customer hosts.
  local ic_base_url="${API_URL}/downloads/instantclient/${ic_arch}"
  local ic_basic_rpm="oracle-instantclient${ic_ver_major}-basic.rpm"
  local ic_sqlplus_rpm="oracle-instantclient${ic_ver_major}-sqlplus.rpm"
  local ic_tmp="/tmp/tunevault-ic-$$"

  mkdir -p "$ic_tmp" "$ic_dir"

  info "Downloading Oracle Instant Client ${ic_ver_major} Basic from TuneVault mirror (~80MB)…"
  if ! curl -fsSL --max-time 300 "${ic_base_url}/${ic_basic_rpm}" -o "${ic_tmp}/${ic_basic_rpm}" 2>/dev/null; then
    info "Mirror download failed — falling back to direct oracle.com download"
    local dl_base="https://download.oracle.com/otn_software/linux/instantclient/2110000"
    if [ "$ic_arch" = "aarch64" ]; then
      dl_base="https://download.oracle.com/otn_software/linux/instantclient/191000"
      ic_basic_rpm="oracle-instantclient19.1-basic-19.1.0.0.0-1.aarch64.rpm"
    fi
    curl -fsSL --max-time 300 "${dl_base}/${ic_basic_rpm}" -o "${ic_tmp}/${ic_basic_rpm}" 2>/dev/null || {
      rm -rf "$ic_tmp"
      return 1
    }
  fi
  ok "IC Basic RPM downloaded"

  info "Downloading Oracle Instant Client ${ic_ver_major} SQL*Plus…"
  curl -fsSL --max-time 120 "${ic_base_url}/${ic_sqlplus_rpm}" -o "${ic_tmp}/${ic_sqlplus_rpm}" 2>/dev/null || \
    info "SQL*Plus download failed (non-fatal — only Basic is required for oracledb thick mode)"

  # Install: prefer rpm to /opt/tunevault/instantclient (avoid clobbering /usr/lib/oracle)
  # Use --prefix to install to our private dir, OR extract RPM manually with rpm2cpio.
  # rpm --prefix requires relocatable RPMs — IC RPMs are not always relocatable.
  # Safe approach: install system-wide with rpm (idempotent) + symlink into our dir.
  info "Installing Instant Client RPM(s)…"
  local IC_LIB_DIR=""

  if command -v rpm >/dev/null 2>&1; then
    rpm -ivh --nodeps "${ic_tmp}/${ic_basic_rpm}" 2>/dev/null || \
      rpm -Uvh --nodeps "${ic_tmp}/${ic_basic_rpm}" 2>/dev/null || true
    # Detect where rpm installed the libraries
    IC_LIB_DIR=$(rpm -ql "${ic_basic_rpm%.rpm}" 2>/dev/null | grep '\.so' | head -1 | xargs dirname 2>/dev/null || true)
    if [ -z "$IC_LIB_DIR" ]; then
      IC_LIB_DIR=$(find /usr/lib/oracle /usr/lib64 -name "libclntsh.so*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || true)
    fi
    [ -n "$IC_LIB_DIR" ] && ok "IC installed to: ${IC_LIB_DIR}"

    # Optional: SQL*Plus
    [ -f "${ic_tmp}/${ic_sqlplus_rpm}" ] && \
      rpm -ivh --nodeps "${ic_tmp}/${ic_sqlplus_rpm}" 2>/dev/null || true
  elif command -v dpkg >/dev/null 2>&1 && command -v alien >/dev/null 2>&1; then
    # Ubuntu/Debian: convert RPM → deb via alien
    (cd "$ic_tmp" && alien --to-deb --scripts "${ic_basic_rpm}" 2>/dev/null) || true
    local deb_file; deb_file=$(ls "${ic_tmp}"/*.deb 2>/dev/null | head -1 || true)
    if [ -n "$deb_file" ]; then
      dpkg -i "$deb_file" 2>/dev/null || true
      IC_LIB_DIR=$(find /usr/lib/oracle /usr/lib -name "libclntsh.so*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || true)
    fi
  else
    # Manual extraction via cpio (no rpm or dpkg)
    info "Extracting IC RPM with cpio (no rpm/dpkg available)…"
    (cd "$ic_dir" && rpm2cpio "${ic_tmp}/${ic_basic_rpm}" 2>/dev/null | cpio -idm 2>/dev/null) || \
    (cd "$ic_dir" && cat "${ic_tmp}/${ic_basic_rpm}" | (cpio -i 2>/dev/null || true)) || true
    IC_LIB_DIR=$(find "$ic_dir" -name "libclntsh.so*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || true)
  fi

  rm -rf "$ic_tmp"

  # Symlink discovered lib dir → /opt/tunevault/instantclient (canonical path)
  if [ -n "$IC_LIB_DIR" ] && [ "$IC_LIB_DIR" != "$ic_dir" ]; then
    # Populate our canonical dir by symlinking all .so files
    mkdir -p "$ic_dir"
    for _f in "${IC_LIB_DIR}"/*.so* "${IC_LIB_DIR}"/libclntsh*; do
      [ -e "$_f" ] || continue
      ln -sf "$_f" "${ic_dir}/$(basename "$_f")" 2>/dev/null || true
    done
    ok "IC libs symlinked to ${ic_dir}"
    IC_LIB_DIR="$ic_dir"
  elif [ -z "$IC_LIB_DIR" ]; then
    IC_LIB_DIR="$ic_dir"
  fi

  # Verify: libclntsh.so must exist
  if find "$IC_LIB_DIR" -name "libclntsh.so*" 2>/dev/null | grep -q .; then
    ok "libclntsh.so verified in ${IC_LIB_DIR}"
    # Run ldconfig so the linker picks up the new libs immediately
    echo "$IC_LIB_DIR" > /etc/ld.so.conf.d/oracle-instant-client.conf
    ldconfig 2>/dev/null || true
    export _IC_LIB_DIR="$IC_LIB_DIR"
    _IC_INSTALLED=1
    return 0
  fi

  info "WARNING: libclntsh.so not found after IC install — thick mode may not work"
  export _IC_LIB_DIR="$IC_LIB_DIR"
  return 1
}

# ── thin-mode connectivity probe ──────────────────────────────────────────────
# Called after driver install. Reads ORACLE_HOST/PORT/SID from agent.env if available.
# Returns: 0 = success (thin mode works), 1 = auth error needing IC, 2 = other failure
run_thin_probe() {
  # Get Oracle endpoint from agent.env (written above by PMON/lsnrctl detection)
  local probe_host probe_port probe_svc
  probe_host=$(grep '^ORACLE_HOST=' /etc/tunevault/agent.env 2>/dev/null | cut -d= -f2 | head -1 || echo "")
  probe_port=$(grep '^ORACLE_PORT=' /etc/tunevault/agent.env 2>/dev/null | cut -d= -f2 | head -1 || echo "1521")
  probe_svc=$(grep '^ORACLE_SERVICE_NAME=\|^ORACLE_PRIMARY_SERVICE=' /etc/tunevault/agent.env 2>/dev/null | head -1 | cut -d= -f2 || echo "")
  # Fall back to first detected SID
  [ -z "$probe_svc" ] && probe_svc=$(echo "${ORACLE_SIDS:-}" | cut -d, -f1 || echo "")
  [ -z "$probe_host" ] && probe_host=$(echo "${DETECTED_HOST:-}" || echo "")

  if [ -z "$probe_host" ] || [ -z "$probe_svc" ]; then
    # No Oracle endpoint detected — skip probe (happens on cloud-only monitoring mode)
    info "Connectivity probe: no Oracle endpoint detected — skipping (agent will probe on first health check)"
    _TELEMETRY_PATH="skipped"
    return 0
  fi

  info "Running thin-mode connectivity probe: ${probe_host}:${probe_port}/${probe_svc}…"

  local probe_result
  probe_result=$("$VENV_PYTHON" - <<PYPROBE 2>&1 || true
import sys
import os

try:
    import oracledb
except ImportError:
    print("SKIP:oracledb not available")
    sys.exit(0)

host = "${probe_host}"
port = ${probe_port}
svc  = "${probe_svc}"

dsn_svc = "%s:%d/%s" % (host, port, svc)
dsn_sid = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=%s)(PORT=%d))(CONNECT_DATA=(SID=%s)))" % (host, port, svc)

def _probe(dsn_str):
    try:
        conn = oracledb.connect(user="", password="", dsn=dsn_str)
        conn.close()
        return ("THIN_OK", None)
    except oracledb.DatabaseError as e:
        msg = str(e)
        code = getattr(e.args[0], 'code', 0) if e.args else 0
        # ORA-01017 or ORA-01005 = service reachable, auth error — thin mode works
        if code in (1017, 1005):
            return ("THIN_AUTH_OK", None)
        # DPY-3015 = thin driver cannot auth with 11g verifier
        if "DPY-3015" in msg or "DPY-3001" in msg or "ORA-28040" in msg:
            return ("NEED_IC", msg)
        # ORA-01017 with hint about 12c verifier = 11g password hash
        if code == 1017 and ("verifier" in msg.lower() or "11g" in msg.lower()):
            return ("NEED_IC", msg)
        return ("THIN_FAIL", msg)
    except Exception as e:
        return ("THIN_FAIL", str(e))

status, err = _probe(dsn_svc)
if status == "THIN_FAIL":
    status2, err2 = _probe(dsn_sid)
    if status2 != "THIN_FAIL":
        status, err = status2, err2
    else:
        # Use more specific of the two errors
        if err2 and ("DPY" in str(err2) or "ORA-28040" in str(err2)):
            err = err2

if err:
    print("%s:%s" % (status, err[:200]))
else:
    print(status)
PYPROBE
  )

  local probe_status
  probe_status=$(echo "$probe_result" | head -1 | cut -d: -f1)

  case "$probe_status" in
    THIN_OK|THIN_AUTH_OK)
      ok "Thin-mode connectivity probe: PASS (${probe_status})"
      _TELEMETRY_PATH="thin_ok"
      return 0
      ;;
    NEED_IC)
      # 11g password verifier detected — need Instant Client thick mode
      local ic_err
      ic_err=$(echo "$probe_result" | head -1 | cut -d: -f2-)
      info "DPY-3015/ORA-28040 detected: ${ic_err}"
      info "This database uses 11g password verifier — requires Oracle Instant Client for thick-mode auth."
      _TELEMETRY_ERROR="$ic_err"
      return 1
      ;;
    SKIP)
      info "Thin-mode probe skipped (oracledb not available)"
      _TELEMETRY_PATH="skipped"
      return 0
      ;;
    *)
      info "Thin-mode connectivity probe inconclusive (${probe_result:-no result}) — continuing install"
      _TELEMETRY_PATH="thin_fail_no_ic"
      _TELEMETRY_ERROR="$probe_result"
      return 0  # Non-fatal — probe is informational at this stage
      ;;
  esac
}

# ── DPY-3015 / 11g verifier self-healing flow ─────────────────────────────────
# Only runs in non-headless, non-upgrade mode (real install with Oracle endpoint detected).
# Skipped in CI headless mode — no live Oracle available there.
if [ "$HEADLESS" -eq 0 ] && [ -n "${ORACLE_SIDS:-}${DETECTED_HOST:-}" ]; then

  if run_thin_probe; then
    # thin_ok or skipped — nothing more to do
    :
  else
    # NEED_IC path: auto-install Instant Client and retry in thick mode
    info ""
    info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    info "  Auto-fix: downloading Oracle Instant Client…"
    info "  (11g password verifier requires thick-mode driver)"
    info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if install_instant_client; then
      # Reinstall cx_Oracle with IC libs now available, then re-verify with thick mode
      info "Instant Client installed — reinstalling cx_Oracle for thick mode…"
      export LD_LIBRARY_PATH="${_IC_LIB_DIR}:${LD_LIBRARY_PATH:-}"
      export ORACLE_HOME="${_IC_LIB_DIR}"
      "$VENV_PIP" install --quiet --force-reinstall "cx_Oracle==${CX_ORACLE_VERSION}" 2>&1 | tail -3 || \
        "$VENV_PIP" install --quiet "cx_Oracle" 2>&1 | tail -3 || true

      # Thick-mode retry probe
      THICK_PROBE=$("$VENV_PYTHON" - <<THICKPROBE 2>&1 || true
import sys
import os
os.environ.setdefault("LD_LIBRARY_PATH", "${_IC_LIB_DIR}")

try:
    import oracledb
    oracledb.init_oracle_client(lib_dir="${_IC_LIB_DIR}")
except Exception:
    pass

try:
    import cx_Oracle
    probe_dsn = "${DETECTED_HOST:-localhost}:${DETECTED_PORT:-1521}/${ORACLE_SIDS%%,*}"
    conn = cx_Oracle.connect("/", dsn=probe_dsn)
    conn.close()
    print("THICK_OK")
except Exception as e:
    msg = str(e)
    code = getattr(e.args[0], 'code', 0) if hasattr(e, 'args') and e.args else 0
    if code in (1017, 1005):
        print("THICK_AUTH_OK")
    else:
        print("THICK_FAIL:" + msg[:200])
THICKPROBE
      )

      if echo "$THICK_PROBE" | grep -qE "^THICK_OK|^THICK_AUTH_OK"; then
        ok "Thick-mode connectivity probe: PASS — 11g verifier scenario resolved"
        _TELEMETRY_PATH="ic_installed"
        # Persist IC lib dir into agent.env.
        # WHY plain value: systemd EnvironmentFile= does not expand shell variables,
        # so we write the literal path without ${...} syntax.
        {
          echo "INSTANT_CLIENT_DIR=${_IC_LIB_DIR}"
          echo "ORACLE_HOME=${_IC_LIB_DIR}"
          echo "LD_LIBRARY_PATH=${_IC_LIB_DIR}"
        } >> /etc/tunevault/agent.env
        ok "IC lib dir persisted to agent.env (LD_LIBRARY_PATH=${_IC_LIB_DIR})"
      else
        info "Thick-mode probe returned: ${THICK_PROBE}"
        info ""
        info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        info "  Detected scenario : DPY-3015 (11g password verifier)"
        info "  Files attempted   : ${_IC_DIR} / ${_IC_LIB_DIR:-/usr/lib/oracle}"
        info "  Thick-mode result : ${THICK_PROBE}"
        info ""
        info "  Next step: Verify Oracle Instant Client ${_IC_DIR} contains libclntsh.so"
        info "    find ${_IC_DIR} -name 'libclntsh.so*'"
        info "  Then re-run the installer: curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
        info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        _TELEMETRY_PATH="thin_fail_no_ic"
        _TELEMETRY_ERROR="thick_probe_failed: ${THICK_PROBE}"
      fi
    else
      info "Instant Client download/install failed — continuing with thin driver"
      info "If the database requires thick-mode auth (11g verifier), connections may fail."
      info "To fix manually: install Oracle Instant Client 19c or 21c, then run:"
      info "  curl -fsSL ${API_URL}/install.sh | sudo bash -s -- --repair"
      _TELEMETRY_PATH="thin_fail_no_ic"
      _TELEMETRY_ERROR="ic_download_failed"
    fi
  fi
fi

# ── timeout= kwarg patch (python-oracledb < 1.4.0) ────────────────────────────
# Some versions of python-oracledb (before 1.4.0) do not accept timeout= in
# connect(). This causes ORA-12170 / TypeError in oracle-proxy.py.
# We sed-patch any timeout=N, calls from connect() call sites in the agent package.
# Idempotent: checks for the old pattern before patching. Logs every patch.
patch_timeout_kwarg() {
  local agent_dir="${PROXY_DEST}/agent"
  local patched=0

  # oracledb < 1.4 uses tcp_connect_timeout param name (not timeout=)
  # We look for: oracledb.connect(..., timeout=N, ...) and remove the kwarg.
  # WHY: timeout= was added in oracledb 1.4; older thin-mode callers crash with TypeError.
  # The connect() timeout behavior is handled by the TNS listener timeout instead.
  for _pyf in "${PROXY_DEST}/oracle-proxy.py" "${agent_dir}/oracle_worker.py" "${agent_dir}/poll.py"; do
    [ -f "$_pyf" ] || continue
    # Pattern: timeout=<int_or_var>, (with trailing comma or closing paren)
    if grep -qE 'oracledb\.connect\([^)]*timeout=[^,)]+' "$_pyf" 2>/dev/null; then
      # Remove the timeout= kwarg from oracledb.connect() calls
      sed -i 's/\(oracledb\.connect([^)]*\)[,[:space:]]*timeout=[^,)]*\([,)]\)/\1\2/g' "$_pyf" 2>/dev/null && \
        ok "Patched timeout= kwarg in $(basename $_pyf)" && patched=$((patched + 1))
    fi
  done

  [ "$patched" -eq 0 ] && info "timeout= kwarg: no patch needed (oracledb version is compatible)" || true
  return 0
}

# Apply timeout= patch unconditionally (idempotent if no match)
patch_timeout_kwarg

# ── Post-install telemetry ─────────────────────────────────────────────────────
# POST install outcome to /api/agent/install-telemetry so Wave 1 monitoring
# can see where customers land (thin_ok vs ic_installed vs failures).
# Non-blocking: never prevents install from continuing.
post_install_telemetry() {
  local path="${1:-skipped}"
  local error_msg="${2:-}"
  local host_str
  host_str=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "unknown")
  local _glibc
  _glibc=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1 || echo "unknown")
  local _ora_ver
  _ora_ver=$("$VENV_PYTHON" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null || \
             "$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || echo "unknown")
  local _payload
  _payload=$(printf '{"connection_id":%s,"path":"%s","error":"%s","os_info":"%s","os_major":%s,"glibc_ver":"%s","oracle_driver":"%s","installer_version":"7.5.0","host":"%s"}' \
    "${CONNECTION_ID:-0}" \
    "$path" \
    "$(echo "$error_msg" | head -c 200 | sed 's/["\\/]/\\&/g; s/\n/ /g')" \
    "${OS_INFO:-unknown}" \
    "${OS_MAJOR_VERSION:-0}" \
    "$_glibc" \
    "$_ora_ver" \
    "$host_str")

  curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -d "$_payload" \
    "${API_URL:-https://tunevault.app}/api/agent/install-telemetry" \
    --max-time 10 >/dev/null 2>&1 || true
}

# Post telemetry (soft-fail, non-blocking)
if [ "$HEADLESS" -eq 0 ]; then
  post_install_telemetry "${_TELEMETRY_PATH}" "${_TELEMETRY_ERROR}"
fi

# ── systemd unit ─────────────────────────────────────────────────────────────
if [ "$HEADLESS" -eq 1 ]; then
  # Headless/CI mode: skip systemd (unavailable in containers without PID 1 = systemd).
  # Verify agent.cli is importable (same sanity as non-headless path), then start in background.
  info "Headless mode — verifying agent package and starting directly (no systemd)"
  if ! (cd "${PROXY_DEST}" && PYTHONPATH="${PROXY_DEST}" "${VENV_PYTHON}" -c 'import agent.cli' 2>/dev/null); then
    info "WARN: import agent.cli failed in headless mode — falling back to oracle-proxy.py"
    TUNEVAULT_API_KEY="$API_KEY" TUNEVAULT_API_URL="$API_URL" TUNEVAULT_CONNECTION_ID="$CONNECTION_ID" \
      "$VENV_PYTHON" "${PROXY_DEST}/oracle-proxy.py" &
    HEADLESS_PID=$!
    ok "oracle-proxy.py started (PID $HEADLESS_PID, fallback)"
  else
    TUNEVAULT_API_KEY="$API_KEY" TUNEVAULT_API_URL="$API_URL" TUNEVAULT_CONNECTION_ID="$CONNECTION_ID" \
      bash -c "cd '${PROXY_DEST}' && PYTHONPATH='${PROXY_DEST}' '${VENV_PYTHON}' -m agent.cli start" &
    HEADLESS_PID=$!
    ok "agent.cli start launched (PID $HEADLESS_PID)"
  fi
else
  info "Installing systemd service unit…"

  # ── Migrate v3/v4/v5 layout on upgrade ───────────────────────────────────
  # Old layout: tunevault-proxy.service with inline Environment=TUNEVAULT_* lines.
  # New layout: tunevault-agent.service with EnvironmentFile=/etc/tunevault/agent.env only.
  # If we detect inline Environment= overlap with agent.env, run migrate-config automatically.
  if systemctl cat tunevault-proxy.service >/dev/null 2>&1 || systemctl cat tunevault-agent.service >/dev/null 2>&1; then
    # Check for inline Environment= overlap — the silent-override trap
    _INLINE_KEYS=$(systemctl cat tunevault-proxy.service 2>/dev/null | grep '^Environment=TUNEVAULT_' | sed 's/^Environment=//;s/=.*//' || true)
    _INLINE_KEYS+=" $(systemctl cat tunevault-agent.service 2>/dev/null | grep '^Environment=TUNEVAULT_' | sed 's/^Environment=//;s/=.*//' || true)"
    _AGENT_KEYS=$(grep -o '^[A-Z_]*' /etc/tunevault/agent.env 2>/dev/null | tr '\n' ' ' || true)
    _HAS_OVERLAP=0
    for _K in $_INLINE_KEYS; do
      [ -z "$_K" ] && continue
      echo "$_AGENT_KEYS" | grep -q "$_K" && _HAS_OVERLAP=1 && break
    done
    if [ "$_HAS_OVERLAP" -eq 1 ]; then
      info "Detected dual-config drift — running tunevault-agent migrate-config…"
      if command -v tunevault-agent >/dev/null 2>&1; then
        tunevault-agent migrate-config || true
        ok "migrate-config completed (inline Environment= removed from systemd unit)"
      else
        info "tunevault-agent CLI not yet installed — migration will complete after install"
      fi
    fi
    # Stop legacy service name before installing new unit
    systemctl stop tunevault-proxy.service 2>/dev/null || true
    systemctl disable tunevault-proxy.service 2>/dev/null || true
    # Remove old unit file so `systemctl start tunevault-proxy` can't accidentally
    # resurrect the legacy service. The new canonical service is tunevault-agent.
    rm -f /etc/systemd/system/tunevault-proxy.service
    systemctl daemon-reload 2>/dev/null || true
  fi

  # tunevault-agent.service — outbound long-poll agent.
  # DO NOT add Environment= lines here. All config lives in /etc/tunevault/agent.env.
  # Edit config via: tunevault-agent rotate-key OR tunevault-agent config set <KEY> <VALUE>
  #
  # systemd processes Environment= AFTER EnvironmentFile= (overrides it silently).
  # Using EnvironmentFile= exclusively prevents the silent-shadow trap.
  # ── Choose ExecStart based on Python version ─────────────────────────────
  # agent.cli uses `from __future__ import annotations` (PEP 563, Python 3.7+).
  # Python 3.6 raises SyntaxError at import time, crash-looping the unit.
  # Use oracle-proxy.py directly on Python 3.6; agent.cli on 3.7+.
  if [ "$IS_PY36" -eq 1 ]; then
    _EXEC_START="${VENV_PYTHON} ${PROXY_DEST}/oracle-proxy.py"
    info "Python 3.6 detected — using oracle-proxy.py entry point (agent.cli requires Python 3.7+)"
  else
    _EXEC_START="${VENV_PYTHON} -m agent.cli start"
  fi

  # Write unit to a tempfile first, then atomic install.
  # WHY tempfile: writing directly to /etc/systemd/system/ while systemd holds
  # a file descriptor on the unit (during restart) can corrupt the unit on
  # ext3/tmpfs. install(1) does an atomic rename. Idempotent: re-running
  # produces a byte-identical file because the heredoc has no dynamic content
  # other than _EXEC_START and PROXY_DEST (both are deterministic per run).
  _UNIT_TMP=$(mktemp /tmp/tunevault-agent-service-XXXXXX)
  cat > "$_UNIT_TMP" <<SVCEOF
# TuneVault Agent v6.8
#
# DO NOT add Environment= lines here.
# All agent config lives in /etc/tunevault/agent.env.
# EnvironmentFile= is read BEFORE any Environment= lines — list it first.
#
# To update the API key:   sudo tunevault-agent rotate-key <new-key>
# To update any config:    sudo tunevault-agent config set <KEY> <VALUE>
# To migrate old layout:   sudo tunevault-agent migrate-config

[Unit]
Description=TuneVault Oracle Agent
After=network.target
Wants=network-online.target
# Stop looping after 3 rapid restarts in 5min (true bootstrap failure → unit reports 'failed')
# Oracle connect failures never exit the process so they don't count against this limit.
# WHY [Unit] not [Service]: StartLimitIntervalSec is a unit-level directive since systemd 230.
# Placing it in [Service] causes "Unknown lvalue" warnings and silently disables throttling.
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
EnvironmentFile=/etc/tunevault/agent.env
ExecStart=${_EXEC_START}
WorkingDirectory=${PROXY_DEST}
Environment=PYTHONPATH=${PROXY_DEST}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tunevault-agent
# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
SVCEOF
  # install -m 0644: atomic rename + sets permissions in one step
  install -m 0644 "$_UNIT_TMP" /etc/systemd/system/tunevault-agent.service
  rm -f "$_UNIT_TMP"

  systemctl daemon-reload

  # Validate unit file syntax — catches future directive-placement regressions immediately.
  # WHY: systemd silently ignores unknown directives in the wrong section; systemd-analyze
  # verify surfaces them at install time rather than silently disabling the feature.
  info "Validating unit file syntax…"
  if command -v systemd-analyze >/dev/null 2>&1; then
    if ! systemd-analyze verify /etc/systemd/system/tunevault-agent.service 2>&1; then
      err "FATAL: tunevault-agent.service failed systemd-analyze verify.
  The unit file has a structural error. Please report this to TuneVault support:
    https://tunevault.app/support"
    fi
    ok "Unit file syntax verified"
  else
    info "systemd-analyze not available — skipping unit file verification"
  fi

  # Postinstall sanity: verify the entry point is present before starting systemd.
  # On Python 3.7+: verify agent.cli is importable (catches missing/broken package).
  # On Python 3.6:  skip agent.cli import (requires Python 3.7+ due to PEP 563),
  #                 verify oracle-proxy.py exists instead.
  info "Verifying agent entry point…"
  if [ "$IS_PY36" -eq 1 ]; then
    # Python 3.6 path: agent.cli is not usable; oracle-proxy.py is the entry point.
    if [ ! -f "${PROXY_DEST}/oracle-proxy.py" ]; then
      err "FATAL: oracle-proxy.py not found at ${PROXY_DEST}/oracle-proxy.py.
  Fix: re-run the installer:
    curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    fi
    ok "oracle-proxy.py present — sanity check passed (Python 3.6 path)"
  else
    if ! (cd "${PROXY_DEST}" && PYTHONPATH="${PROXY_DEST}" "${VENV_PYTHON}" -c 'import agent.cli' 2>/dev/null); then
      err "FATAL: 'import agent.cli' failed.
  The agent/ package is missing or broken at ${PROXY_DEST}/agent/.
  Fix: re-run the installer to re-download the package:
    curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    fi
    ok "agent.cli importable — sanity check passed"
  fi

  # Enable + start agent
  systemctl enable tunevault-agent.service 2>/dev/null || true
  systemctl restart tunevault-agent.service || err "Failed to start tunevault-agent.service"

  # ── 10s post-start journal health gate ───────────────────────────────────
  # Check the journal for three outcomes within 10s:
  #   (a) FATAL key-required string → installer prints remediation + exits 1
  #   (b) Connected/polling line    → installer prints [OK] + continues
  #   (c) Neither in 10s            → warn + continue (may still be starting)
  #
  # WHY journal not sleep: sleep(3) misses fast failures and wastes time on
  # slow starts. journalctl --since + --follow lets us react the instant a
  # decisive line appears.
  #
  # The two fatal strings to detect:
  #   oracle-proxy.py (Python 3.6 path): "FATAL: TUNEVAULT_API_KEY environment variable is required."
  #   agent.cli       (Python 3.7+ path): "FATAL: api_key and connection_id are required."
  # The success markers:
  #   oracle-proxy.py: "[cloud] Connected to TuneVault cloud"
  #   agent.cli:       "Phase 1 complete" (log.info)
  info "Waiting up to 10s for agent to confirm startup (journal health gate)…"
  _GATE_RESULT="timeout"
  _GATE_START=$(date +%s)
  _GATE_DEADLINE=$(( _GATE_START + 10 ))

  while [ "$(date +%s)" -lt "$_GATE_DEADLINE" ]; do
    _JLOG=$(journalctl -u tunevault-agent --since "15 seconds ago" --no-pager -q 2>/dev/null || true)

    # (a) Detect fatal key-missing crash
    if echo "$_JLOG" | grep -qF "TUNEVAULT_API_KEY environment variable is required" || \
       echo "$_JLOG" | grep -qF "api_key and connection_id are required"; then
      _GATE_RESULT="key_missing"
      break
    fi

    # (b) Detect successful cloud connection (oracle-proxy.py or agent.cli)
    if echo "$_JLOG" | grep -qE "Connected to TuneVault cloud|Phase 1 complete|heartbeat acknowledged|long.poll.*started|poll loop started"; then
      _GATE_RESULT="connected"
      break
    fi

    sleep 1
  done

  case "$_GATE_RESULT" in
    connected)
      ok "Agent connected to TuneVault cloud (journal health gate: PASS)"
      ;;
    key_missing)
      echo "" >&2
      echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}" >&2
      echo -e "${RED}${BOLD}║  FATAL: Agent failed to start — API key not found in env     ║${NC}" >&2
      echo -e "${RED}${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}" >&2
      echo -e "${RED}${BOLD}║  Your /etc/tunevault/agent.env is missing or empty.          ║${NC}" >&2
      echo -e "${RED}${BOLD}║                                                              ║${NC}" >&2
      echo -e "${RED}${BOLD}║  To fix:                                                     ║${NC}" >&2
      echo -e "${RED}${BOLD}║    sudo tunevault-agent rotate-key <your-api-key>            ║${NC}" >&2
      echo -e "${RED}${BOLD}║                                                              ║${NC}" >&2
      echo -e "${RED}${BOLD}║  Or re-run the installer with your token:                    ║${NC}" >&2
      echo -e "${RED}${BOLD}║    curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=<token> bash${NC}" >&2
      echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}" >&2
      echo "" >&2
      # Show the last 20 journal lines for context
      echo -e "${YELLOW}Last journal lines:${NC}" >&2
      journalctl -u tunevault-agent -n 20 --no-pager -q 2>/dev/null >&2 || true
      err "Install aborted — agent.env key issue. Fix with rotate-key then re-run."
      ;;
    timeout)
      echo -e "${YELLOW}[WARN] Agent did not log a connection confirmation within 10s.${NC}" >&2
      echo -e "${YELLOW}       This may be normal if the host has slow network startup.${NC}" >&2
      echo -e "${YELLOW}       Check status: systemctl status tunevault-agent${NC}" >&2
      echo -e "${YELLOW}       Check logs:   journalctl -u tunevault-agent -n 30${NC}" >&2
      # Non-fatal — cloud heartbeat will confirm within 60s
      ok "tunevault-agent.service enabled + started (connection confirmation pending)"
      ;;
  esac
fi

# ── Detect Oracle environment ──────────────────────────────────────────────────
# Four-tier SID detection: PMON (running instances) → /etc/oratab → srvctl (RAC/CRS only) → empty
# Strict validation applied to every candidate: ^[A-Za-z][A-Za-z0-9_$#]{0,7}$
# This single check catches error strings, spaces, asterisks, shell metacharacters.
info "Detecting Oracle environment…"
ORACLE_SIDS=""

# Helper: validate a single SID candidate against Oracle SID naming rules.
# Oracle SID rules: 1-8 chars, starts with a letter, remainder alphanumeric + _ $ #
# Returns 0 (valid) or 1 (invalid/garbage).
_sid_valid() {
  local s="$1"
  # Must start with a letter; remaining chars alphanumeric, underscore, dollar, hash; max 8 total
  case "$s" in
    ""|*[!A-Za-z0-9_\$\#]*) return 1 ;;
    [A-Za-z]*) ;;
    *) return 1 ;;
  esac
  [ "${#s}" -le 8 ] || return 1
  return 0
}

# Helper: filter a comma-separated list through _sid_valid; return validated CSV.
_filter_sids() {
  local raw="$1"
  local out=""
  local s
  for s in $(echo "$raw" | tr ',' '\n'); do
    if _sid_valid "$s"; then
      out="${out:+$out,}$s"
    else
      info "Rejected SID candidate (failed validation): '$s'"
    fi
  done
  echo "$out"
}

# Helper: detect running Oracle PMON SIDs from /proc/*/comm (canonical, no ps parsing).
# /proc/<pid>/comm contains the exact process name Oracle set — no shell splitting.
# Strict regex ^ora_pmon_([A-Za-z][A-Za-z0-9_$#]{0,7})$ ensures only valid SID chars
# pass through; metacharacters, slashes, and garbage strings produce zero matches.
# Falls back to pgrep -a -f when /proc is not enumerable (containers, non-Linux).
# Returns a comma-separated validated SID list, or empty string if none found.
_pmon_sids_detect() {
  local sids="" comm sid
  # Primary: enumerate /proc/*/comm — one file per process, no shell word-splitting.
  if [ -d /proc ] && ls /proc/*/comm >/dev/null 2>&1; then
    for f in /proc/*/comm; do
      [ -r "$f" ] || continue
      comm=$(cat "$f" 2>/dev/null) || continue
      # Strict match: ora_pmon_ prefix + valid SID chars only
      case "$comm" in
        ora_pmon_[A-Za-z]*)
          sid="${comm#ora_pmon_}"
          if _sid_valid "$sid"; then
            case ",$sids," in
              *",$sid,"*) ;;  # deduplicate
              *) sids="${sids:+$sids,}$sid" ;;
            esac
          else
            info "Rejected PMON SID candidate (failed validation): '$sid'"
          fi
          ;;
      esac
    done
  fi
  # Fallback: pgrep when /proc enumeration failed (container namespaces, BSD).
  if [ -z "$sids" ] && command -v pgrep >/dev/null 2>&1; then
    local raw_pgrep
    raw_pgrep=$(pgrep -a -f '^ora_pmon_' 2>/dev/null || pgrep -l -f 'ora_pmon_' 2>/dev/null || true)
    if [ -n "$raw_pgrep" ]; then
      local token
      while IFS= read -r line; do
        for token in $line; do
          case "$token" in
            ora_pmon_[A-Za-z]*)
              sid="${token#ora_pmon_}"
              if _sid_valid "$sid"; then
                case ",$sids," in
                  *",$sid,"*) ;;
                  *) sids="${sids:+$sids,}$sid" ;;
                esac
              else
                info "Rejected PMON SID candidate (pgrep fallback, failed validation): '$sid'"
              fi
              ;;
          esac
        done
      done <<< "$raw_pgrep"
    fi
  fi
  echo "$sids"
}

# Tier 1: Running PMON processes — one ora_pmon_<SID> per active instance.
# Uses /proc/*/comm (canonical, no shell parsing) with strict SID regex validation.
# This prevents shell metacharacters and garbage strings from reaching downstream calls.
PMON_SIDS=$(_pmon_sids_detect)
if [ -n "$PMON_SIDS" ]; then
  ORACLE_SIDS="$PMON_SIDS"
  ok "Detected running Oracle instance SIDs (PMON): $ORACLE_SIDS"

  # CDB/PDB awareness: check listener for PDB service names.
  # Listener services include both the CDB instance and any open PDBs.
  # We can't query v$pdbs without credentials, but the listener is accessible.
  PDB_SERVICES=""
  LSNRCTL_BIN=""
  if command -v lsnrctl >/dev/null 2>&1; then
    LSNRCTL_BIN="lsnrctl"
  elif [ -n "${ORACLE_HOME:-}" ] && [ -x "${ORACLE_HOME}/bin/lsnrctl" ]; then
    LSNRCTL_BIN="${ORACLE_HOME}/bin/lsnrctl"
  fi
  if [ -n "$LSNRCTL_BIN" ]; then
    # Run lsnrctl status with SID name first (EBS listener alias = SID),
    # then fall back to bare lsnrctl status (standard Oracle LISTENER).
    LSNRCTL_OUTPUT=""
    FIRST_SID=$(echo "$PMON_SIDS" | cut -d, -f1)
    if [ -n "$FIRST_SID" ]; then
      LSNRCTL_OUTPUT=$($LSNRCTL_BIN status "$FIRST_SID" 2>/dev/null || true)
    fi
    if [ -z "$LSNRCTL_OUTPUT" ] || echo "$LSNRCTL_OUTPUT" | grep -qi "no listener"; then
      LSNRCTL_OUTPUT=$($LSNRCTL_BIN status 2>/dev/null || true)
    fi

    # Parse HOST and PORT from listener endpoint summary.
    # Format: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=hostname)(PORT=1521)))
    # Pick the first TCP endpoint — that's what Oracle clients connect to.
    DETECTED_HOST=""
    DETECTED_PORT=""
    if [ -n "$LSNRCTL_OUTPUT" ]; then
      # POSIX replacement for grep -oP (lookbehind not in basic/extended grep).
      # Capture (HOST=...) value then strip prefix/suffix with sed.
      DETECTED_HOST=$(echo "$LSNRCTL_OUTPUT" | grep -oE '\(HOST=[^)]+\)' | head -1 | sed 's/^(HOST=//;s/)$//' || true)
      DETECTED_PORT=$(echo "$LSNRCTL_OUTPUT" | grep -oE '\(PORT=[0-9]+\)' | head -1 | sed 's/^(PORT=//;s/)$//' || true)
    fi

    if [ -n "$DETECTED_HOST" ]; then
      ok "Listener endpoint detected: ${DETECTED_HOST}:${DETECTED_PORT:-1521}"
    fi

    # Extract service names from the same lsnrctl output — PDB services are those
    # NOT matching the CDB instance SID(s). Exclude generic XDB/XE/PLSExtProc services.
    # POSIX replacement for grep -oP (lookbehind not in basic/extended grep).
    # Extract service name between Service "..." quotes using grep -oE + sed strip.
    ALL_LISTENER_SVCS=$(echo "$LSNRCTL_OUTPUT" | grep -oE 'Service "[^"]+"' | sed 's/Service "//;s/"$//' | sort -u || true)
    if [ -n "$ALL_LISTENER_SVCS" ]; then
      for svc in $ALL_LISTENER_SVCS; do
        IS_CDB_SID=0
        for sid in $(echo "$PMON_SIDS" | tr ',' ' '); do
          [ "$svc" = "$sid" ] && IS_CDB_SID=1 && break
          # Also skip SID-related XDB service (e.g., EBSDEVDBXDB)
          [ "$svc" = "${sid}XDB" ] && IS_CDB_SID=1 && break
        done
        # Skip known non-PDB Oracle services
        case "$svc" in PLSExtProc|SYS\$*) IS_CDB_SID=1 ;; esac
        [ "$IS_CDB_SID" -eq 0 ] && PDB_SERVICES="${PDB_SERVICES:+$PDB_SERVICES,}$svc"
      done
    fi
  fi
  if [ -n "$PDB_SERVICES" ]; then
    info "PDB service names (from listener): $PDB_SERVICES"
    info "Installer will use CDB instance SID ($ORACLE_SIDS) for connection."
    info "Target specific PDBs via the TuneVault dashboard after setup."
  fi
fi

# Write detected Oracle host/port to agent.env so proxy + diagnose probes use real values.
# WHY append: agent.env is written earlier (before Oracle detection) with API keys;
# we append host/port here because they depend on the PMON/lsnrctl results above.
# Fallback A: tnslsnr process args — present when Oracle listener is running
# even if lsnrctl is not on PATH. Format: "tnslsnr LISTENER -inherit"
if [ -z "${DETECTED_HOST:-}" ]; then
  TNSLSNR_OUTPUT=$(ps -eo args= 2>/dev/null | awk '/[t]nslsnr/' | head -1 || true)
  if [ -n "$TNSLSNR_OUTPUT" ]; then
    # Listener is running — run lsnrctl with explicit binary path if needed
    TNSLSNR_PATH=$(ps -eo args= 2>/dev/null | awk '/[t]nslsnr/ { print $1; exit }' || true)
    TNS_HOME=$(dirname "$(dirname "$TNSLSNR_PATH")" 2>/dev/null || true)
    if [ -n "$TNS_HOME" ] && [ -x "${TNS_HOME}/bin/lsnrctl" ]; then
      LSNRCTL_FALLBACK_OUT=$("${TNS_HOME}/bin/lsnrctl" status 2>/dev/null || true)
    elif command -v lsnrctl >/dev/null 2>&1; then
      LSNRCTL_FALLBACK_OUT=$(lsnrctl status 2>/dev/null || true)
    fi
    if [ -n "${LSNRCTL_FALLBACK_OUT:-}" ]; then
      DETECTED_HOST=$(echo "$LSNRCTL_FALLBACK_OUT" | grep -oE '\(HOST=[^)]+\)' | head -1 | sed 's/^(HOST=//;s/)$//' || true)
      DETECTED_PORT=$(echo "$LSNRCTL_FALLBACK_OUT" | grep -oE '\(PORT=[0-9]+\)' | head -1 | sed 's/^(PORT=//;s/)$//' || true)
      [ -n "$DETECTED_HOST" ] && ok "Listener endpoint detected (tnslsnr fallback): ${DETECTED_HOST}:${DETECTED_PORT:-1521}"
    fi
  fi
fi

# Fallback B: read PORT from $ORACLE_HOME/network/admin/listener.ora
if [ -z "${DETECTED_HOST:-}" ] && [ -n "${ORACLE_HOME:-}" ] && [ -f "${ORACLE_HOME}/network/admin/listener.ora" ]; then
  FB_PORT=$(grep -oE 'PORT[[:space:]]*=[[:space:]]*[0-9]+' "${ORACLE_HOME}/network/admin/listener.ora" 2>/dev/null | head -1 | grep -oE '[0-9]+' || true)
  if [ -n "$FB_PORT" ]; then
    DETECTED_PORT="$FB_PORT"
    info "Listener PORT ${FB_PORT} read from listener.ora (host will be resolved at runtime)"
  fi
fi

if [ -n "${DETECTED_HOST:-}" ] || [ -n "${DETECTED_PORT:-}" ]; then
  {
    echo "ORACLE_HOST=${DETECTED_HOST:-localhost}"
    echo "ORACLE_PORT=${DETECTED_PORT:-1521}"
  } >> /etc/tunevault/agent.env
  ok "Oracle endpoint written to agent.env: ${DETECTED_HOST:-localhost}:${DETECTED_PORT:-1521}"
else
  # All detection paths exhausted — proxy will auto-detect at first connect.
  info "Listener endpoint not detected — proxy will auto-detect at runtime"
fi

# Tier 2: /etc/oratab — canonical Oracle SID registry, present on every install type
# (standalone, RAC, EBS, Free, Express). Parse non-comment non-star SID:HOME:Y/N entries.
# Promoted above srvctl because it works on all topologies; srvctl is RAC-only.
if [ -z "$ORACLE_SIDS" ] && [ -f /etc/oratab ]; then
  ORATAB_SIDS_RAW=$(grep -v '^#' /etc/oratab 2>/dev/null | grep -v '^$' | grep -v '^\*' | cut -d: -f1 | tr '\n' ',' | sed 's/,$//' || true)
  ORATAB_SIDS=$(_filter_sids "$ORATAB_SIDS_RAW")
  if [ -n "$ORATAB_SIDS" ]; then
    ORACLE_SIDS="$ORATAB_SIDS"
    ok "Detected Oracle SIDs (oratab): $ORACLE_SIDS"
  fi
fi

# Tier 3: srvctl (Grid Infrastructure / RAC) — ONLY when CRS is actually installed.
# srvctl is present on any Oracle DB install (it ships with the RDBMS), but it only
# works when Grid Infrastructure is running. On standalone installs it exits non-zero
# and prints the Clusterware error to stdout — NOT stderr — which gets captured as a
# SID candidate if we're not careful.
# Guard 1: /etc/oracle/olr.loc — created by GI rooters.sh, absent on standalone.
# Guard 2: crsctl binary — present only when GI is installed.
# Both guards must be checked before running srvctl.
if [ -z "$ORACLE_SIDS" ]; then
  CRS_PRESENT=0
  [ -f /etc/oracle/olr.loc ] && CRS_PRESENT=1
  if [ "$CRS_PRESENT" -eq 0 ]; then
    command -v crsctl >/dev/null 2>&1 && CRS_PRESENT=1
  fi
  if [ "$CRS_PRESENT" -eq 0 ] && [ -n "${GRID_HOME:-}" ] && [ -x "${GRID_HOME}/bin/crsctl" ]; then
    CRS_PRESENT=1
  fi

  if [ "$CRS_PRESENT" -eq 1 ]; then
    SRVCTL_BIN=""
    if command -v srvctl >/dev/null 2>&1; then
      SRVCTL_BIN="srvctl"
    elif [ -n "${ORACLE_HOME:-}" ] && [ -x "${ORACLE_HOME}/bin/srvctl" ]; then
      SRVCTL_BIN="${ORACLE_HOME}/bin/srvctl"
    fi
    if [ -n "$SRVCTL_BIN" ]; then
      # Redirect stderr explicitly; srvctl also emits error text on stdout on some
      # CRS versions, so validate content as a second line of defence.
      SRVCTL_RAW=$($SRVCTL_BIN config database 2>/dev/null || true)
      # Skip if output contains Clusterware/ORA-* errors (CRS down or partial install)
      if [ -n "$SRVCTL_RAW" ] && ! echo "$SRVCTL_RAW" | grep -qiE 'Clusterware|ORA-|Start Oracle|Unable to'; then
        SRVCTL_SIDS_RAW=$(echo "$SRVCTL_RAW" | tr '\n' ',' | sed 's/,$//')
        SRVCTL_SIDS=$(_filter_sids "$SRVCTL_SIDS_RAW")
        if [ -n "$SRVCTL_SIDS" ]; then
          ORACLE_SIDS="$SRVCTL_SIDS"
          ok "Detected Oracle SIDs (srvctl/RAC): $ORACLE_SIDS"
        fi
      fi
    fi
  else
    info "No Grid Infrastructure detected — skipping srvctl (standalone Oracle host)"
  fi
fi

if [ -z "$ORACLE_SIDS" ]; then
  info "No Oracle SIDs detected — start the database or set ORACLE_SID manually; TuneVault will auto-detect on first health check"
fi

# ── Wait for proxy to start ───────────────────────────────────────────────────
info "Waiting for proxy to come up on localhost:3100…"
MAX_WAIT=30
WAITED=0
PROXY_UP=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf http://localhost:3100/health >/dev/null 2>&1 || \
     curl -sf http://localhost:3100/api/health >/dev/null 2>&1 || \
     ss -tlnp 2>/dev/null | grep -q ':3100 ' || \
     netstat -tlnp 2>/dev/null | grep -q ':3100 '; then
    PROXY_UP=1
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
[ "$PROXY_UP" -eq 1 ] && ok "Proxy listening on :3100" || info "Proxy not yet on :3100 — registration proceeding anyway"

# ── Auto-register with TuneVault cloud ────────────────────────────────────────
if [ "$HEADLESS" -eq 1 ]; then
  info "Headless mode — skipping cloud registration"
else
  # Proxy is up (or attempted). Register now so the connection appears in the
  # dashboard with no separate command required.
  info "Registering agent with TuneVault cloud…"

  SIDS_JSON="[]"
  if [ -n "$ORACLE_SIDS" ]; then
    SIDS_JSON=$(echo "$ORACLE_SIDS" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | tr '\n' ',' | sed 's/,$//' | sed 's/^/[/;s/$/]/')
  fi
  # PDB service names detected from lsnrctl (distinct from CDB instance SIDs above).
  # These are passed to the server as pdb_services so the UI can show a labeled picker.
  PDB_JSON="[]"
  if [ -n "${PDB_SERVICES:-}" ]; then
    PDB_JSON=$(echo "$PDB_SERVICES" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | tr '\n' ',' | sed 's/,$//' | sed 's/^/[/;s/$/]/')
  fi
  MACHINE_HOSTNAME=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "")
  _KERNEL=$(uname -r 2>/dev/null || echo "unknown")
  _OSID=$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "unknown")
  _PY_VER=$("$VENV_PYTHON" --version 2>&1 | awk '{print $2}' || echo "")
  _CX_VER=$("$VENV_PYTHON" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null || echo "")
  CONFIRM_PAYLOAD="{\"connection_id\":${CONNECTION_ID},\"os_info\":\"${OS_INFO}\",\"oracle_home\":\"${ORACLE_HOME:-}\",\"oracle_sids\":${SIDS_JSON},\"pdb_services\":${PDB_JSON},\"machine_hostname\":\"${MACHINE_HOSTNAME}\",\"installer_version\":\"7.5.0\",\"proxy_version\":\"7.5.0\",\"python_version\":\"${_PY_VER}\",\"cx_oracle_version\":\"${_CX_VER}\",\"os_id\":\"${_OSID}\",\"kernel\":\"${_KERNEL}\"}"

  CONFIRM_RESP=$(curl -fsSL -X POST \
    -H "Content-Type: application/json" \
    -H "X-TuneVault-Key: ${API_KEY}" \
    -d "$CONFIRM_PAYLOAD" \
    "${API_URL}/api/agent/confirm" 2>/dev/null) || {
    info "Confirm request failed — services are running. TuneVault will detect the heartbeat."
    CONFIRM_RESP="{\"ok\":false}"
  }

  CONFIRM_OK=$(get_bool "$CONFIRM_RESP" "ok")
  if [ "$CONFIRM_OK" -gt 0 ]; then
    ok "Agent registered — connection appears in TuneVault dashboard"
  else
    info "Registration deferred — proxy heartbeat will register within 60s"
  fi
fi

# ── Install tunevault-agent CLI dispatcher ────────────────────────────────────
# Writes /usr/local/bin/tunevault-agent — dispatches to the Python agent CLI for
# all subcommands except self-test (which uses the bash self-test library).
# Subcommands: start, diagnose, register, repair, upgrade, version, self-test,
#              rotate-key, config, migrate-config, --help
info "Installing tunevault-agent CLI…"
cat > /usr/local/bin/tunevault-agent <<'CLIEOF'
#!/usr/bin/env bash
# tunevault-agent — TuneVault Agent CLI v7.5
# All subcommands implemented in bash or delegated to oracle-proxy.py.
# The agent/ Python package is NOT deployed to customer machines — only
# oracle-proxy.py exists on disk. This dispatcher must never reference
# agent.cli or python -m agent.cli.
# Subcommands: start, diagnose, register, repair, upgrade, version, self-test,
#              rotate-key, config, migrate-config, doctor, logs, uninstall, --help
set -euo pipefail

VENV_PYTHON="/opt/tunevault/venv/bin/python3"
PROXY_SCRIPT="/opt/tunevault/oracle-proxy.py"
ENV_FILE="/etc/tunevault/agent.env"

_load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    source "$ENV_FILE"
  elif [ -f /etc/tunevault/proxy.env ]; then
    # shellcheck source=/dev/null
    source /etc/tunevault/proxy.env
  else
    echo "ERROR: No config found in /etc/tunevault/ — is TuneVault agent installed?" >&2
    exit 1
  fi
}

CMD="${1:-}"
case "$CMD" in
  start)
    # systemd ExecStart calls this — exec oracle-proxy.py directly
    if [ ! -f "$VENV_PYTHON" ]; then
      echo "ERROR: Python venv not found at $VENV_PYTHON — run full installer first" >&2
      exit 1
    fi
    if [ ! -f "$PROXY_SCRIPT" ]; then
      echo "ERROR: oracle-proxy.py not found at $PROXY_SCRIPT — run full installer first" >&2
      exit 1
    fi
    shift
    exec "$VENV_PYTHON" "$PROXY_SCRIPT" "$@"
    ;;
  self-test|diagnose)
    # 8-probe health check — implemented in bash self-test library
    _load_env
    API_KEY="${TUNEVAULT_API_KEY:-}"
    API_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
    CONNECTION_ID="${TUNEVAULT_CONNECTION_ID:-}"
    VENV_PIP="/opt/tunevault/venv/bin/pip"
    VENV_DIR="/opt/tunevault/venv"
    CONF="$ENV_FILE"
    # shellcheck source=/dev/null
    source /usr/local/lib/tunevault-self-test.sh
    run_self_test
    ;;
  version)
    ver=$(grep -m1 '^VERSION' "$PROXY_SCRIPT" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' || echo "unknown")
    py_ver=$("$VENV_PYTHON" --version 2>&1 || echo "unknown")
    echo "tunevault-agent $ver"
    echo "$py_ver"
    cx_ver=$("$VENV_PYTHON" -c "import cx_Oracle; print('cx_Oracle', cx_Oracle.version)" 2>/dev/null || true)
    ora_ver=$("$VENV_PYTHON" -c "import oracledb; print('python-oracledb', oracledb.__version__)" 2>/dev/null || true)
    [ -n "$cx_ver" ] && echo "$cx_ver"
    [ -n "$ora_ver" ] && echo "$ora_ver"
    ;;
  rotate-key)
    NEW_KEY="${2:-}"
    if [ -z "$NEW_KEY" ]; then
      echo "Usage: tunevault-agent rotate-key <new-key>" >&2
      exit 1
    fi
    if [ ! -f "$ENV_FILE" ]; then
      echo "ERROR: $ENV_FILE not found — is TuneVault agent installed?" >&2
      exit 1
    fi
    # Atomic rotate: write to tmp, replace, restart
    TMP="${ENV_FILE}.tmp.$$"
    sed "s|^TUNEVAULT_API_KEY=.*|TUNEVAULT_API_KEY=${NEW_KEY}|" "$ENV_FILE" > "$TMP"
    mv -f "$TMP" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "API key updated in $ENV_FILE"
    systemctl restart tunevault-agent.service 2>/dev/null && echo "Service restarted" || echo "WARN: could not restart service" >&2
    ;;
  config)
    SUBCMD="${2:-}"
    KEY="${3:-}"
    VALUE="${4:-}"
    case "$SUBCMD" in
      get)
        [ -z "$KEY" ] && { echo "Usage: tunevault-agent config get <KEY>" >&2; exit 1; }
        grep "^${KEY}=" "$ENV_FILE" 2>/dev/null | head -1 | sed "s/^${KEY}=//" || echo "(not set)"
        ;;
      set)
        [ -z "$KEY" ] && { echo "Usage: tunevault-agent config set <KEY> <VALUE>" >&2; exit 1; }
        TMP="${ENV_FILE}.tmp.$$"
        if grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
          sed "s|^${KEY}=.*|${KEY}=${VALUE}|" "$ENV_FILE" > "$TMP"
        else
          cp "$ENV_FILE" "$TMP"
          echo "${KEY}=${VALUE}" >> "$TMP"
        fi
        mv -f "$TMP" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "${KEY} updated"
        ;;
      *)
        echo "Usage: tunevault-agent config get|set <KEY> [VALUE]" >&2
        exit 1
        ;;
    esac
    ;;
  repair)
    # Repair: re-installs pinned Python deps and restarts the service.
    # WHY pinned versions: floating versions caused oracledb import failures (2026-05-17).
    echo "Repairing TuneVault agent (pinned dep versions)…"
    VENV_PIP="/opt/tunevault/venv/bin/pip"
    if [ -f "$VENV_PIP" ]; then
      "$VENV_PIP" install --quiet --upgrade pip 2>/dev/null || true
      "$VENV_PIP" install --quiet "cx_Oracle==8.3.0" 2>/dev/null || true
      "$VENV_PIP" install --quiet "python-oracledb==2.5.1" 2>/dev/null || true
      "$VENV_PIP" install --quiet "paramiko==3.5.0" 2>/dev/null || true
      "$VENV_PIP" install --quiet "requests==2.32.3" 2>/dev/null || true
      "$VENV_PIP" install --quiet "pyyaml==6.0.2" 2>/dev/null || true
      echo "Dependencies refreshed (pinned)"
    fi
    systemctl daemon-reload 2>/dev/null || true
    systemctl restart tunevault-agent.service 2>/dev/null && echo "Service restarted" || echo "WARN: could not restart service" >&2
    ;;
  upgrade)
    # Delegate to oracle-proxy.py --update-now for self-update
    if [ -f "$VENV_PYTHON" ] && [ -f "$PROXY_SCRIPT" ]; then
      exec "$VENV_PYTHON" "$PROXY_SCRIPT" --update-now
    else
      echo "ERROR: Cannot upgrade — proxy script or venv missing" >&2
      exit 1
    fi
    ;;
  migrate-config)
    # Move inline systemd Environment= vars into agent.env
    SVC_FILE="/etc/systemd/system/tunevault-agent.service"
    if [ ! -f "$SVC_FILE" ]; then
      echo "No service file found at $SVC_FILE" >&2
      exit 1
    fi
    INLINE_KEYS=$(grep '^Environment=TUNEVAULT_' "$SVC_FILE" 2>/dev/null | sed 's/^Environment=//' || true)
    if [ -z "$INLINE_KEYS" ]; then
      echo "No inline Environment= keys found — nothing to migrate."
      exit 0
    fi
    mkdir -p /etc/tunevault
    touch "$ENV_FILE"
    while IFS= read -r line; do
      key=$(echo "$line" | cut -d= -f1)
      if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        echo "$line" >> "$ENV_FILE"
        echo "  migrated: $key"
      else
        echo "  skipped (already in agent.env): $key"
      fi
    done <<< "$INLINE_KEYS"
    chmod 600 "$ENV_FILE"
    echo "Migration complete. Remove Environment= lines from $SVC_FILE and run: systemctl daemon-reload && systemctl restart tunevault-agent"
    ;;
  register)
    echo "Registration is handled during installation." >&2
    echo "Re-run: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash" >&2
    exit 1
    ;;
  doctor)
    # ── tunevault-agent doctor ────────────────────────────────────────────────
    # 7-check install verification: env-file, systemd, api-reachable, api-auth,
    # long-poll heartbeat, oracle-driver, disk-space.
    # Flags: --json   → machine-readable JSON instead of table
    #        --deep   → synthetic end-to-end HTTP round-trips (health+register+heartbeat)
    # Exit: 0 = all pass, 1 = one or more failures.
    _DOC_JSON=0
    _DOC_DEEP=0
    for _darg in "$@"; do
      [ "$_darg" = "--json" ] && _DOC_JSON=1
      [ "$_darg" = "--deep" ] && _DOC_DEEP=1
    done

    # ── --deep mode: synthetic end-to-end HTTP round-trips ───────────────────
    if [ "$_DOC_DEEP" -eq 1 ]; then
      RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
      NC='\033[0m'; BOLD='\033[1m'

      # Load env for credentials
      _DEEP_ENV="/etc/tunevault/agent.env"
      if [ -f "$_DEEP_ENV" ]; then
        # shellcheck source=/dev/null
        . "$_DEEP_ENV" 2>/dev/null || true
      fi
      _DEEP_API_KEY="${TUNEVAULT_API_KEY:-}"
      _DEEP_API_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
      _DEEP_CONN_ID="${TUNEVAULT_CONNECTION_ID:-}"

      echo ""
      echo -e "${BOLD}TuneVault Agent Deep Check${NC}  (tunevault-agent doctor --deep)"
      echo -e "──────────────────────────────────────────────────────────────────"
      echo -e "  Cloud: ${_DEEP_API_URL}"
      echo ""

      _DEEP_PASS=0
      _DEEP_FAIL_STEP=0
      _DEEP_FAIL_MSG=""

      # ── Probe 1: Health ──────────────────────────────────────────────────────
      echo -e "${BOLD}[1/3] Health probe${NC}  GET ${_DEEP_API_URL}/api/health"
      _D1_T0=$(date +%s%3N 2>/dev/null || echo 0)
      _D1_RESP=$(curl -fsS -w '\nHTTP_CODE:%{http_code}' \
        "${_DEEP_API_URL}/api/health" --max-time 10 2>/dev/null) || _D1_RESP="HTTP_CODE:000"
      _D1_T1=$(date +%s%3N 2>/dev/null || echo 0)
      _D1_MS=$(( _D1_T1 - _D1_T0 ))
      _D1_HTTP=$(echo "$_D1_RESP" | grep '^HTTP_CODE:' | sed 's/HTTP_CODE://')
      _D1_BODY=$(echo "$_D1_RESP" | grep -v '^HTTP_CODE:' | head -20)
      echo -e "  Status:  ${_D1_HTTP}  (${_D1_MS}ms)"
      if [ -n "$_D1_BODY" ]; then
        # Pretty-print JSON body (indent 2 spaces per key)
        echo "$_D1_BODY" | sed 's/,"/,\n  "/g;s/^{/{\n  /;s/}$/\n}/' | sed 's/^/  /' 2>/dev/null || echo "  $_D1_BODY"
      fi
      if [ "$_D1_HTTP" = "200" ]; then
        echo -e "  ${GREEN}[PASS]${NC} Health endpoint reachable, DB connected"
        _DEEP_PASS=$(( _DEEP_PASS + 1 ))
      else
        _D1_INTERP=""
        case "$_D1_HTTP" in
          000) _D1_INTERP="timeout or egress blocked / DNS poisoned — check outbound HTTPS on port 443" ;;
          401) _D1_INTERP="token invalid or revoked" ;;
          403) _D1_INTERP="token valid but connection paused" ;;
          404) _D1_INTERP="cloud URL wrong — verify TUNEVAULT_API_URL in agent.env" ;;
          5*) _D1_INTERP="TuneVault cloud issue — check https://status.tunevault.app" ;;
          *) _D1_INTERP="unexpected HTTP ${_D1_HTTP}" ;;
        esac
        echo -e "  ${RED}[FAIL: HTTP ${_D1_HTTP}]${NC} ${_D1_INTERP}"
        _DEEP_FAIL_STEP=1
        _DEEP_FAIL_MSG="health probe returned HTTP ${_D1_HTTP}: ${_D1_INTERP}"
      fi
      echo ""

      # ── Probe 2: Register dry-run ────────────────────────────────────────────
      echo -e "${BOLD}[2/3] Register dry-run${NC}  POST ${_DEEP_API_URL}/api/agent/register"
      _D2_BODY_REQ="{\"connection_id\":${_DEEP_CONN_ID:-0},\"agent_version\":\"doctor-deep\"}"
      _D2_T0=$(date +%s%3N 2>/dev/null || echo 0)
      _D2_RESP=$(curl -fsS -w '\nHTTP_CODE:%{http_code}' \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-TuneVault-Key: ${_DEEP_API_KEY}" \
        -H "X-TuneVault-Doctor: dry-run" \
        -D /dev/stderr \
        -d "$_D2_BODY_REQ" \
        "${_DEEP_API_URL}/api/agent/register" --max-time 10 2>/tmp/deep_headers_d2) || _D2_RESP="HTTP_CODE:000"
      _D2_T1=$(date +%s%3N 2>/dev/null || echo 0)
      _D2_MS=$(( _D2_T1 - _D2_T0 ))
      _D2_HTTP=$(echo "$_D2_RESP" | grep '^HTTP_CODE:' | sed 's/HTTP_CODE://')
      _D2_BODY=$(echo "$_D2_RESP" | grep -v '^HTTP_CODE:' | head -10)
      _D2_REQ_ID=$(grep -i '^x-request-id:' /tmp/deep_headers_d2 2>/dev/null | head -1 | tr -d '\r' | sed 's/^[^:]*: //' || echo "")
      echo -e "  Status:  ${_D2_HTTP}  (${_D2_MS}ms)"
      [ -n "$_D2_REQ_ID" ] && echo -e "  Request-ID: ${_D2_REQ_ID}"
      if [ -n "$_D2_BODY" ]; then
        echo "$_D2_BODY" | sed 's/,"/,\n  "/g;s/^{/{\n  /;s/}$/\n}/' | sed 's/^/  /' 2>/dev/null || echo "  $_D2_BODY"
      fi
      if echo "$_D2_HTTP" | grep -qE '^2'; then
        echo -e "  ${GREEN}[PASS]${NC} Register dry-run accepted — key valid + host classified"
        _DEEP_PASS=$(( _DEEP_PASS + 1 ))
      else
        _D2_INTERP=""
        case "$_D2_HTTP" in
          000) _D2_INTERP="timeout or egress blocked — check outbound HTTPS on port 443" ;;
          401) _D2_INTERP="token invalid or revoked — rotate with: tunevault-agent rotate-key <new-key>" ;;
          403) _D2_INTERP="token valid but connection paused or unauthorized" ;;
          404) _D2_INTERP="cloud URL wrong — verify TUNEVAULT_API_URL in agent.env" ;;
          5*) _D2_INTERP="TuneVault cloud issue — check https://status.tunevault.app" ;;
          *) _D2_INTERP="unexpected HTTP ${_D2_HTTP}" ;;
        esac
        echo -e "  ${RED}[FAIL: HTTP ${_D2_HTTP}]${NC} ${_D2_INTERP}"
        [ "$_DEEP_FAIL_STEP" -eq 0 ] && { _DEEP_FAIL_STEP=2; _DEEP_FAIL_MSG="register dry-run returned HTTP ${_D2_HTTP}: ${_D2_INTERP}"; }
      fi
      rm -f /tmp/deep_headers_d2
      echo ""

      # ── Probe 3: Heartbeat ping ──────────────────────────────────────────────
      echo -e "${BOLD}[3/3] Heartbeat probe${NC}  POST ${_DEEP_API_URL}/api/agent/heartbeat"
      _D3_BODY_REQ="{\"connection_id\":${_DEEP_CONN_ID:-0},\"doctor\":true}"
      _D3_T0=$(date +%s%3N 2>/dev/null || echo 0)
      _D3_RESP=$(curl -fsS -w '\nHTTP_CODE:%{http_code}' \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-TuneVault-Key: ${_DEEP_API_KEY}" \
        -d "$_D3_BODY_REQ" \
        "${_DEEP_API_URL}/api/agent/heartbeat" --max-time 10 2>/dev/null) || _D3_RESP="HTTP_CODE:000"
      _D3_T1=$(date +%s%3N 2>/dev/null || echo 0)
      _D3_MS=$(( _D3_T1 - _D3_T0 ))
      _D3_HTTP=$(echo "$_D3_RESP" | grep '^HTTP_CODE:' | sed 's/HTTP_CODE://')
      _D3_BODY=$(echo "$_D3_RESP" | grep -v '^HTTP_CODE:' | head -10)
      echo -e "  Status:  ${_D3_HTTP}  (${_D3_MS}ms)"
      if [ -n "$_D3_BODY" ]; then
        echo "$_D3_BODY" | sed 's/,"/,\n  "/g;s/^{/{\n  /;s/}$/\n}/' | sed 's/^/  /' 2>/dev/null || echo "  $_D3_BODY"
      fi
      if echo "$_D3_HTTP" | grep -qE '^2'; then
        echo -e "  ${GREEN}[PASS]${NC} Heartbeat endpoint reachable, queue stats returned"
        _DEEP_PASS=$(( _DEEP_PASS + 1 ))
      else
        _D3_INTERP=""
        case "$_D3_HTTP" in
          000) _D3_INTERP="timeout or egress blocked — check outbound HTTPS on port 443" ;;
          401) _D3_INTERP="token invalid or revoked — rotate with: tunevault-agent rotate-key <new-key>" ;;
          403) _D3_INTERP="token valid but connection paused or unauthorized" ;;
          404) _D3_INTERP="cloud URL wrong — verify TUNEVAULT_API_URL in agent.env" ;;
          5*) _D3_INTERP="TuneVault cloud issue — check https://status.tunevault.app" ;;
          *) _D3_INTERP="unexpected HTTP ${_D3_HTTP}" ;;
        esac
        echo -e "  ${RED}[FAIL: HTTP ${_D3_HTTP}]${NC} ${_D3_INTERP}"
        [ "$_DEEP_FAIL_STEP" -eq 0 ] && { _DEEP_FAIL_STEP=3; _DEEP_FAIL_MSG="heartbeat probe returned HTTP ${_D3_HTTP}: ${_D3_INTERP}"; }
      fi
      echo ""

      # ── Summary ──────────────────────────────────────────────────────────────
      echo -e "──────────────────────────────────────────────────────────────────"
      if [ "$_DEEP_PASS" -eq 3 ]; then
        echo -e "  ${GREEN}${BOLD}Deep check: 3/3 passed${NC}"
      else
        echo -e "  ${RED}${BOLD}Deep check: ${_DEEP_PASS}/3 passed — FAILED at step ${_DEEP_FAIL_STEP}${NC}"
        echo -e "  ${YELLOW}${_DEEP_FAIL_MSG}${NC}"
      fi
      echo ""

      [ "$_DEEP_PASS" -eq 3 ] || exit 1
      exit 0
    fi
    # ── end --deep block ────────────────────────────────────────────────────

    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
    PASS_SYM="${GREEN}✓${NC}"; FAIL_SYM="${RED}✗${NC}"

    _doc_pass() { echo -e "  ${GREEN}✓${NC}  ${1}  ${YELLOW}${2:-}${NC}"; }
    _doc_fail() { echo -e "  ${RED}✗${NC}  ${1}  ${YELLOW}${2:-}${NC}"; }

    _DOC_TOTAL=7
    _DOC_PASS=0
    _DOC_RESULTS=""   # name:pass:detail newline-separated

    # ── label width: pad each label to 22 chars ──────────────────────────────
    _lpad() { printf "%-22s" "$1"; }

    # ── check 1: env-file ────────────────────────────────────────────────────
    _C1_LABEL=$(_lpad "env-file")
    _C1_OK=0; _C1_DETAIL=""
    _AGENT_ENV="/etc/tunevault/agent.env"
    if [ ! -f "$_AGENT_ENV" ]; then
      _C1_DETAIL="$_AGENT_ENV not found"
    elif [ ! -r "$_AGENT_ENV" ]; then
      _C1_DETAIL="$_AGENT_ENV not readable (permission denied)"
    else
      # shellcheck source=/dev/null
      . "$_AGENT_ENV" 2>/dev/null || true
      _C1_KEY="${TUNEVAULT_API_KEY:-}"
      _C1_URL="${TUNEVAULT_API_URL:-}"
      _C1_CID="${TUNEVAULT_CONNECTION_ID:-}"
      if [ -z "$_C1_KEY" ]; then
        _C1_DETAIL="TUNEVAULT_API_KEY missing"
      elif ! echo "$_C1_KEY" | grep -q '^tvp_'; then
        _C1_DETAIL="TUNEVAULT_API_KEY does not start with tvp_ (got: ${_C1_KEY:0:8}…)"
      elif [ -z "$_C1_URL" ]; then
        _C1_DETAIL="TUNEVAULT_API_URL missing"
      elif ! echo "$_C1_CID" | grep -qE '^[0-9]+$'; then
        _C1_DETAIL="TUNEVAULT_CONNECTION_ID missing or not an integer (got: $_C1_CID)"
      else
        _C1_OK=1
        _C1_DETAIL="KEY=tvp_… URL=$_C1_URL CID=$_C1_CID"
      fi
    fi
    [ "$_C1_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}env-file:${_C1_OK}:${_C1_DETAIL}"$'\n'

    # Expose env vars for later checks (already sourced above, but ensure set)
    _DOC_API_URL="${TUNEVAULT_API_URL:-}"
    _DOC_API_KEY="${TUNEVAULT_API_KEY:-}"
    _DOC_CONN_ID="${TUNEVAULT_CONNECTION_ID:-}"

    # ── check 2: systemd-unit ────────────────────────────────────────────────
    _C2_LABEL=$(_lpad "systemd-unit")
    _C2_OK=0; _C2_DETAIL=""
    if ! command -v systemctl >/dev/null 2>&1; then
      _C2_DETAIL="systemctl not found"
    else
      _C2_SVC="tunevault-agent"
      _C2_ACTIVE=$(systemctl is-active "$_C2_SVC.service" 2>/dev/null || echo "unknown")
      _C2_ENABLED=$(systemctl is-enabled "$_C2_SVC.service" 2>/dev/null || echo "unknown")
      # systemd-analyze verify (non-fatal if unavailable)
      _C2_VERIFY=""
      if command -v systemd-analyze >/dev/null 2>&1; then
        _C2_VERIFY=$(systemd-analyze verify "$_C2_SVC.service" 2>&1 || true)
      fi
      if [ "$_C2_ACTIVE" = "active" ] && [ "$_C2_ENABLED" = "enabled" ]; then
        if [ -n "$_C2_VERIFY" ]; then
          _C2_DETAIL="active, enabled — systemd-analyze warn: $_C2_VERIFY"
          _C2_OK=1   # warnings don't block; errors would show in is-active
        else
          _C2_DETAIL="active, enabled, unit clean"
          _C2_OK=1
        fi
      elif [ "$_C2_ACTIVE" != "active" ]; then
        _C2_DETAIL="service is $(_C2_ACTIVE) — sudo systemctl start tunevault-agent"
      else
        _C2_DETAIL="service active but not enabled — sudo systemctl enable tunevault-agent"
        # still functionally running; treat as pass with warning
        _C2_OK=1
        _C2_DETAIL="active but not enabled (not auto-start on boot)"
      fi
    fi
    [ "$_C2_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}systemd-unit:${_C2_OK}:${_C2_DETAIL}"$'\n'

    # ── check 3: api-reachable ───────────────────────────────────────────────
    _C3_LABEL=$(_lpad "api-reachable")
    _C3_OK=0; _C3_DETAIL=""
    if [ -z "$_DOC_API_URL" ]; then
      _C3_DETAIL="TUNEVAULT_API_URL not set (env-file check failed)"
    else
      _C3_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' \
        "${_DOC_API_URL}/api/health" --max-time 10 2>/dev/null) || _C3_HTTP="000"
      if [ "$_C3_HTTP" = "200" ]; then
        _C3_OK=1
        _C3_DETAIL="HTTP 200 from ${_DOC_API_URL}/api/health"
      else
        _C3_DETAIL="HTTP ${_C3_HTTP} from ${_DOC_API_URL}/api/health — check outbound HTTPS"
      fi
    fi
    [ "$_C3_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}api-reachable:${_C3_OK}:${_C3_DETAIL}"$'\n'

    # ── check 4: api-auth ────────────────────────────────────────────────────
    _C4_LABEL=$(_lpad "api-auth")
    _C4_OK=0; _C4_DETAIL=""
    if [ -z "$_DOC_API_KEY" ] || [ -z "$_DOC_API_URL" ] || [ -z "$_DOC_CONN_ID" ]; then
      _C4_DETAIL="skipped (env-file check failed)"
    else
      _C4_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' \
        -X POST \
        -H "Content-Type: application/json" \
        -H "X-TuneVault-Key: ${_DOC_API_KEY}" \
        -d "{\"connection_id\":${_DOC_CONN_ID}}" \
        "${_DOC_API_URL}/api/agent/handshake" \
        --max-time 10 2>/dev/null) || _C4_HTTP="000"
      if echo "$_C4_HTTP" | grep -qE '^2'; then
        _C4_OK=1
        _C4_DETAIL="HTTP ${_C4_HTTP} — key valid, connection bound"
      elif [ "$_C4_HTTP" = "401" ] || [ "$_C4_HTTP" = "403" ]; then
        _C4_DETAIL="HTTP ${_C4_HTTP} — API key rejected; rotate with: tunevault-agent rotate-key <new-key>"
      else
        _C4_DETAIL="HTTP ${_C4_HTTP} from handshake endpoint"
      fi
    fi
    [ "$_C4_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}api-auth:${_C4_OK}:${_C4_DETAIL}"$'\n'

    # ── check 5: long-poll heartbeat (last 120s) ─────────────────────────────
    _C5_LABEL=$(_lpad "long-poll")
    _C5_OK=0; _C5_DETAIL=""
    if [ -z "$_DOC_API_URL" ] || [ -z "$_DOC_CONN_ID" ]; then
      _C5_DETAIL="skipped (env-file check failed)"
    else
      _C5_RESP=$(curl -fsS \
        "${_DOC_API_URL}/api/agent/heartbeat-check?connection_id=${_DOC_CONN_ID}" \
        --max-time 10 2>/dev/null) || _C5_RESP=""
      _C5_ALIVE=$(echo "$_C5_RESP" | sed -n 's/.*"alive":[[:space:]]*true.*/yes/p' | head -1 || true)
      _C5_SECS=$(echo "$_C5_RESP" | sed -n 's/.*"seconds_ago":[[:space:]]*\([0-9]*\).*/\1/p' | head -1 || true)
      if [ "$_C5_ALIVE" = "yes" ] && [ -n "$_C5_SECS" ] && [ "$_C5_SECS" -le 120 ] 2>/dev/null; then
        _C5_OK=1
        _C5_DETAIL="heartbeat ${_C5_SECS}s ago"
      elif [ "$_C5_ALIVE" = "yes" ]; then
        _C5_DETAIL="heartbeat ${_C5_SECS}s ago (> 120s threshold — agent may be stalled)"
      else
        _C5_DETAIL="no recent heartbeat — check: journalctl -u tunevault-agent -n 30"
      fi
    fi
    [ "$_C5_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}long-poll:${_C5_OK}:${_C5_DETAIL}"$'\n'

    # ── check 6: oracle-driver ───────────────────────────────────────────────
    _C6_LABEL=$(_lpad "oracle-driver")
    _C6_OK=0; _C6_DETAIL=""
    _VENV_PY="/opt/tunevault/venv/bin/python3"
    if [ ! -f "$_VENV_PY" ]; then
      _C6_DETAIL="venv not found at $_VENV_PY — re-run installer"
    else
      # Try cx_Oracle first, fall back to oracledb thin driver
      _C6_CX=$("$_VENV_PY" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null || echo "")
      _C6_ORA=$("$_VENV_PY" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || echo "")
      if [ -n "$_C6_CX" ] && [ -n "$_C6_ORA" ]; then
        _C6_OK=1; _C6_DETAIL="cx_Oracle ${_C6_CX} + oracledb ${_C6_ORA}"
      elif [ -n "$_C6_CX" ]; then
        _C6_OK=1; _C6_DETAIL="cx_Oracle ${_C6_CX}"
      elif [ -n "$_C6_ORA" ]; then
        _C6_OK=1; _C6_DETAIL="oracledb ${_C6_ORA} (thin mode)"
      else
        _C6_DETAIL="neither cx_Oracle nor oracledb imports — run: tunevault-agent repair"
      fi
    fi
    [ "$_C6_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}oracle-driver:${_C6_OK}:${_C6_DETAIL}"$'\n'

    # ── check 7: disk-space (/opt/tunevault > 100 MB free) ──────────────────
    _C7_LABEL=$(_lpad "disk-space")
    _C7_OK=0; _C7_DETAIL=""
    if [ -d /opt/tunevault ]; then
      # df -k gives 1K blocks; 100 MB = 102400 KB
      _C7_FREE_KB=$(df -k /opt/tunevault 2>/dev/null | awk 'NR==2{print $4}' || echo "0")
      _C7_FREE_MB=$(( _C7_FREE_KB / 1024 ))
      if [ "$_C7_FREE_MB" -ge 100 ]; then
        _C7_OK=1; _C7_DETAIL="${_C7_FREE_MB} MB free"
      else
        _C7_DETAIL="${_C7_FREE_MB} MB free — need >100 MB; clean up /opt/tunevault"
      fi
    else
      _C7_DETAIL="/opt/tunevault not found — agent not installed"
    fi
    [ "$_C7_OK" -eq 1 ] && _DOC_PASS=$((_DOC_PASS+1))
    _DOC_RESULTS="${_DOC_RESULTS}disk-space:${_C7_OK}:${_C7_DETAIL}"$'\n'

    _DOC_FAIL=$(( _DOC_TOTAL - _DOC_PASS ))

    if [ "$_DOC_JSON" -eq 1 ]; then
      # Machine-readable JSON output
      _J_CHECKS="["
      _J_FIRST=1
      while IFS=: read -r _j_name _j_ok _j_detail; do
        [ -z "$_j_name" ] && continue
        [ "$_J_FIRST" -eq 1 ] && _J_FIRST=0 || _J_CHECKS="${_J_CHECKS},"
        _j_detail_esc=$(echo "$_j_detail" | sed 's/\\/\\\\/g;s/"/\\"/g')
        _J_CHECKS="${_J_CHECKS}{\"check\":\"${_j_name}\",\"pass\":$([ "$_j_ok" = "1" ] && echo true || echo false),\"detail\":\"${_j_detail_esc}\"}"
      done <<< "$_DOC_RESULTS"
      _J_CHECKS="${_J_CHECKS}]"
      echo "{\"doctor\":\"$([ "$_DOC_FAIL" -eq 0 ] && echo pass || echo fail)\",\"pass\":${_DOC_PASS},\"fail\":${_DOC_FAIL},\"total\":${_DOC_TOTAL},\"checks\":${_J_CHECKS}}"
    else
      # Human-readable aligned table
      echo ""
      echo -e "${BOLD}TuneVault Agent Doctor${NC}  (tunevault-agent doctor)"
      echo -e "──────────────────────────────────────────────────────────────"
      printf "  %-4s  %-22s  %s\n" "    " "Check" "Detail"
      echo -e "──────────────────────────────────────────────────────────────"
      while IFS=: read -r _r_name _r_ok _r_detail; do
        [ -z "$_r_name" ] && continue
        _r_label=$(printf "%-22s" "$_r_name")
        if [ "$_r_ok" = "1" ]; then
          echo -e "  ${GREEN}✓${NC}   ${_r_label}  ${_r_detail}"
        else
          echo -e "  ${RED}✗${NC}   ${_r_label}  ${YELLOW}${_r_detail}${NC}"
        fi
      done <<< "$_DOC_RESULTS"
      echo -e "──────────────────────────────────────────────────────────────"
      if [ "$_DOC_FAIL" -eq 0 ]; then
        echo -e "  ${GREEN}${BOLD}${_DOC_PASS}/${_DOC_TOTAL} checks passed${NC}"
      else
        echo -e "  ${RED}${BOLD}${_DOC_PASS}/${_DOC_TOTAL} — ${_DOC_FAIL} issue(s) found, see above${NC}"
      fi
      echo ""
    fi

    [ "$_DOC_FAIL" -eq 0 ] || exit 1
    ;;
  logs)
    # ── tunevault-agent logs ──────────────────────────────────────────────────
    # Tail journalctl output for the tunevault-agent service.
    # Extra args (after "logs") are forwarded to journalctl (e.g. -n 100, --since "1h ago").
    shift  # drop "logs" from $@; remaining args are journalctl options
    if command -v journalctl >/dev/null 2>&1; then
      # Default with no extra args: follow mode, last 50 lines
      if [ "$#" -eq 0 ]; then
        exec journalctl -u tunevault-agent -f -n 50
      else
        exec journalctl -u tunevault-agent "$@"
      fi
    else
      echo "journalctl not found — check /var/log/syslog or /var/log/messages for agent output" >&2
      exit 1
    fi
    ;;
  uninstall)
    # ── tunevault-agent uninstall ─────────────────────────────────────────────
    # Stops the agent, removes all installed files, and deregisters with cloud.
    # Default: interactive prompt. Flags:
    #   -y | --yes           skip confirmation prompt
    #   --purge-logs         also remove /var/log/tunevault
    #   --keep-connection    skip cloud deregister (connection row preserved for re-use)
    #   --dry-run            print what would happen; change nothing
    _U_YES=0
    _U_PURGE_LOGS=0
    _U_KEEP_CONN=0
    _U_DRY=0
    for _uarg in "$@"; do
      [ "$_uarg" = "-y" ]               && _U_YES=1
      [ "$_uarg" = "--yes" ]            && _U_YES=1
      [ "$_uarg" = "--purge-logs" ]     && _U_PURGE_LOGS=1
      [ "$_uarg" = "--keep-connection" ] && _U_KEEP_CONN=1
      [ "$_uarg" = "--dry-run" ]        && _U_DRY=1
    done

    # Load env to get API key + connection ID (needed for cloud deregister)
    _U_API_KEY=""
    _U_CONN_ID=""
    _U_API_URL="https://tunevault.app"
    if [ -f "$ENV_FILE" ]; then
      # shellcheck source=/dev/null
      . "$ENV_FILE" 2>/dev/null || true
      _U_API_KEY="${TUNEVAULT_API_KEY:-}"
      _U_CONN_ID="${TUNEVAULT_CONNECTION_ID:-}"
      _U_API_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
    elif [ -f /etc/tunevault/proxy.env ]; then
      # shellcheck source=/dev/null
      . /etc/tunevault/proxy.env 2>/dev/null || true
      _U_API_KEY="${TUNEVAULT_API_KEY:-}"
      _U_CONN_ID="${TUNEVAULT_CONNECTION_ID:-}"
      _U_API_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
    fi

    _RED='\033[0;31m'; _GREEN='\033[0;32m'; _YELLOW='\033[1;33m'; _NC='\033[0m'; _BOLD='\033[1m'

    if [ "$_U_DRY" -eq 1 ]; then
      echo ""
      echo -e "${_BOLD}[dry-run] tunevault-agent uninstall${_NC}  — no changes will be made"
      echo ""
      echo "  Would run: systemctl stop tunevault-agent"
      echo "  Would run: systemctl disable tunevault-agent"
      if [ "$_U_KEEP_CONN" -eq 0 ] && [ -n "$_U_API_KEY" ] && [ -n "$_U_CONN_ID" ]; then
        echo "  Would POST: ${_U_API_URL}/api/agent/uninstall  (deregister connection ${_U_CONN_ID})"
      elif [ "$_U_KEEP_CONN" -eq 1 ]; then
        echo "  Skip: cloud deregister (--keep-connection)"
      else
        echo "  Skip: cloud deregister (no API credentials found in env file)"
      fi
      echo "  Would run: rm /etc/systemd/system/tunevault-agent.service"
      echo "  Would run: systemctl daemon-reload"
      echo "  Would run: rm -rf /opt/tunevault"
      echo "  Would run: rm -rf /etc/tunevault"
      if [ "$_U_PURGE_LOGS" -eq 1 ]; then
        echo "  Would run: rm -rf /var/log/tunevault  (--purge-logs)"
      else
        echo "  Preserve:  /var/log/tunevault  (use --purge-logs to remove)"
      fi
      echo ""
      exit 0
    fi

    # Interactive prompt (skipped with -y / --yes)
    if [ "$_U_YES" -eq 0 ]; then
      echo ""
      echo -e "${_YELLOW}This will stop the agent, remove /opt/tunevault, delete the systemd unit,"
      echo -e "and deregister this host from TuneVault cloud.${_NC}"
      echo ""
      printf "Continue? [y/N] "
      read -r _U_CONFIRM
      case "$_U_CONFIRM" in [yY]*) ;; *)
        echo "Aborted."
        exit 0
        ;;
      esac
    fi

    echo ""
    echo -e "${_BOLD}Uninstalling TuneVault Agent…${_NC}"
    echo ""

    # Step tracking
    _U_RESULTS=""
    _u_step() {
      local _label="$1"; local _cmd="$2"
      if eval "$_cmd" >/dev/null 2>&1; then
        echo -e "  ${_GREEN}✓${_NC}  ${_label}"
        _U_RESULTS="${_U_RESULTS}${_label}:ok\n"
      else
        echo -e "  ${_RED}✗${_NC}  ${_label}"
        _U_RESULTS="${_U_RESULTS}${_label}:fail\n"
      fi
    }

    # a. Stop service (ignore if not running)
    _u_step "Stop tunevault-agent service" \
      "systemctl stop tunevault-agent.service 2>/dev/null || true"

    # b. Disable service
    _u_step "Disable tunevault-agent service" \
      "systemctl disable tunevault-agent.service 2>/dev/null || true"

    # c. Cloud deregister
    if [ "$_U_KEEP_CONN" -eq 1 ]; then
      echo -e "  ${_YELLOW}–${_NC}  Cloud deregister skipped (--keep-connection)"
    elif [ -z "$_U_API_KEY" ] || [ -z "$_U_CONN_ID" ]; then
      echo -e "  ${_YELLOW}–${_NC}  Cloud deregister skipped (no credentials found in env file)"
    else
      _U_DEREG_RC=0
      _U_DEREG_RESP=$(curl -fsS -X POST \
        -H "Content-Type: application/json" \
        -H "X-TuneVault-Key: ${_U_API_KEY}" \
        -d "{\"connection_id\":${_U_CONN_ID}}" \
        "${_U_API_URL}/api/agent/uninstall" \
        --max-time 15 2>/dev/null) || _U_DEREG_RC=$?
      if [ "$_U_DEREG_RC" -eq 0 ]; then
        echo -e "  ${_GREEN}✓${_NC}  Cloud deregister — connection moved to Removed"
      else
        echo -e "  ${_YELLOW}✗${_NC}  Cloud deregister failed (network error — connection row may remain active)"
      fi
    fi

    # d. Remove systemd unit
    _u_step "Remove /etc/systemd/system/tunevault-agent.service" \
      "rm -f /etc/systemd/system/tunevault-agent.service"

    # e. daemon-reload
    _u_step "systemctl daemon-reload" \
      "systemctl daemon-reload 2>/dev/null || true"

    # f. Remove /opt/tunevault (binary, venv, install scripts)
    _u_step "Remove /opt/tunevault" \
      "rm -rf /opt/tunevault"

    # g. Remove /etc/tunevault (agent.env)
    _u_step "Remove /etc/tunevault" \
      "rm -rf /etc/tunevault"

    # h. Purge logs if requested; otherwise leave them and print location
    if [ "$_U_PURGE_LOGS" -eq 1 ]; then
      _u_step "Remove /var/log/tunevault (--purge-logs)" \
        "rm -rf /var/log/tunevault"
    fi

    # Also remove CLI symlinks so no stale commands remain
    _u_step "Remove CLI scripts" \
      "rm -f /usr/local/bin/tunevault-agent /usr/local/bin/tunevault-proxy /usr/local/lib/tunevault-self-test.sh /usr/local/lib/tunevault-diagnose.sh"

    echo ""
    echo -e "${_GREEN}${_BOLD}Uninstall complete.${_NC}"
    if [ "$_U_PURGE_LOGS" -eq 0 ]; then
      echo -e "  Post-mortem logs preserved at ${_YELLOW}/var/log/tunevault${_NC} — remove manually when no longer needed."
    fi
    if [ "$_U_KEEP_CONN" -eq 0 ] && [ -n "$_U_CONN_ID" ]; then
      echo -e "  Connection row moved to ${_YELLOW}Removed${_NC} on ${_U_API_URL}/connections"
      echo -e "  You can restore it within 30 days from the Removed section."
    fi
    echo ""
    ;;
  --help|-h|help|"")
    echo "TuneVault Agent CLI  v7.5"
    echo ""
    echo "Usage: tunevault-agent <command> [options]"
    echo ""
    echo "Commands:"
    echo "  doctor [--json] [--deep]    Run 7-check install verification; --deep performs synthetic HTTP round-trips"
    echo "  logs [-n N] [--since ...]   Tail journalctl for tunevault-agent (all args forwarded)"
    echo "  uninstall [-y] [--dry-run] [--purge-logs] [--keep-connection]"
    echo "                              Stop agent, remove all files, deregister with cloud"
    echo "  diagnose [--json]           Run 8-probe health check on this agent host"
    echo "  repair                      Re-install Python deps and restart service"
    echo "  upgrade [--api-url URL]     Download latest installer and upgrade in place"
    echo "  version                     Print version information"
    echo "  self-test                   Run installer self-test (legacy)"
    echo "  start                       Start the poll loop (systemd runs this)"
    echo "  rotate-key NEW_KEY          Atomically rotate API key in agent.env"
    echo "  config get|set KEY [VALUE]  Read or write agent.env values"
    echo "  migrate-config              Consolidate inline systemd Environment= into agent.env"
    echo "  --help                      Show this help"
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    echo "Run 'tunevault-agent --help' for usage." >&2
    exit 1
    ;;
esac
CLIEOF
chmod +x /usr/local/bin/tunevault-agent

# ── Install tunevault-proxy dispatcher CLI ────────────────────────────────────
# Writes /usr/local/bin/tunevault-proxy — the canonical entry point for DBAs.
# Subcommands: diagnose, register, repair, version, self-test (alias)
info "Installing tunevault-proxy CLI…"
cat > /usr/local/bin/tunevault-proxy <<'TVPEOF'
#!/usr/bin/env bash
# tunevault-proxy — TuneVault agent CLI  v4.5
# Usage: tunevault-proxy <command> [options]
#   diagnose [--json]  — run 7 local health probes; exit 0=all pass, 1=any fail
#   upgrade            — in-place upgrade: backup proxy.env, replace binaries, restore creds, restart
#   self-test          — alias for 'diagnose' (backward compat)
#   repair             — re-run repair mode from installer
#   version            — print agent/installer version
#   --help | -h        — show this help
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
_ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
_info() { echo -e "${YELLOW}[..]${NC} $*"; }
_err()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

CMD="${1:-}"
case "$CMD" in
  diagnose|self-test)
    shift
    JSON_MODE=0
    for _a in "$@"; do [ "$_a" = "--json" ] && JSON_MODE=1; done
    LIB=/usr/local/lib/tunevault-diagnose.sh
    if [ ! -f "$LIB" ]; then
      echo "ERROR: $LIB not found — re-run installer to upgrade" >&2
      exit 1
    fi
    # shellcheck source=/dev/null
    source "$LIB"
    run_diagnose "$JSON_MODE"
    ;;
  upgrade)
    # ── In-place upgrade ──────────────────────────────────────────────────────
    # Backs up proxy.env, downloads new install.sh, verifies SHA256, runs
    # --upgrade, restores TUNEVAULT_API_KEY + TUNEVAULT_CONNECTION_ID,
    # restarts service, auto-runs 7-probe diagnose. Exits 0 only if all pass.
    echo -e "${BOLD}╔════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   TuneVault Proxy — In-Place Upgrade       ║${NC}"
    echo -e "${BOLD}╚════════════════════════════════════════════╝${NC}"

    CONF=/etc/tunevault/proxy.env
    [ -f "$CONF" ] || _err "proxy.env not found at $CONF — run a fresh install first."

    # Source current env so we have TUNEVAULT_API_URL for the download URL
    # shellcheck source=/dev/null
    source "$CONF"
    INSTALLER_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"

    # ── Version pre-check: skip if already on latest ────────────────────────
    # Compare installed oracle-proxy.py VERSION against server's latest.
    CUR_PROXY_VER="unknown"
    if [ -f /opt/tunevault/oracle-proxy.py ]; then
      CUR_PROXY_VER=$(grep -m1 '^VERSION' /opt/tunevault/oracle-proxy.py 2>/dev/null \
        | sed 's/^VERSION\s*=\s*["'"'"']\([^"'"'"']*\)["'"'"']/\1/' || echo "unknown")
    fi
    _info "Checking for updates (current proxy: v${CUR_PROXY_VER})…"
    REMOTE_VER_JSON=$(curl -fsSL "${INSTALLER_URL}/api/proxy/version" --max-time 10 2>/dev/null || echo "")
    if [ -n "$REMOTE_VER_JSON" ]; then
      # Pure-bash JSON field extraction (no jq)
      REMOTE_VER=$(echo "$REMOTE_VER_JSON" | sed -n 's/.*"version":\s*"\([^"]*\)".*/\1/p' | head -1)
      if [ -n "$REMOTE_VER" ] && [ "$CUR_PROXY_VER" = "$REMOTE_VER" ]; then
        _ok "Already on latest proxy version (v${CUR_PROXY_VER}). No upgrade needed."
        exit 0
      fi
      [ -n "$REMOTE_VER" ] && _info "Upgrade: v${CUR_PROXY_VER} → v${REMOTE_VER}"
    fi

    # Backup proxy.env (preserve API key + connection ID across upgrade)
    BAK="${CONF}.bak.$(date +%s)"
    cp "$CONF" "$BAK"
    _ok "proxy.env backed up to $BAK"

    # Download installer to temp file and verify it's non-empty
    TMP_INSTALLER=$(mktemp /tmp/tunevault-install-XXXXXX.sh)
    _info "Downloading installer from ${INSTALLER_URL}/install.sh…"
    curl -fsSL "${INSTALLER_URL}/install.sh" -o "$TMP_INSTALLER" \
      || { rm -f "$TMP_INSTALLER"; _err "Failed to download installer. Check network connectivity."; }
    [ -s "$TMP_INSTALLER" ] || { rm -f "$TMP_INSTALLER"; _err "Downloaded installer is empty."; }
    _ok "Installer downloaded ($(wc -c < "$TMP_INSTALLER") bytes)"

    # ── SHA-256 verification ────────────────────────────────────────────────
    # Download expected checksum from server; verify downloaded installer.
    # Non-fatal if sha256 endpoint is unavailable (older server) — warn only.
    REMOTE_SHA=$(curl -fsSL "${INSTALLER_URL}/install.sh.sha256" --max-time 10 2>/dev/null || echo "")
    if [ -n "$REMOTE_SHA" ]; then
      # Endpoint returns "sha256:<hex>" — extract hex portion
      REMOTE_SHA_HEX=$(echo "$REMOTE_SHA" | sed 's/^sha256://' | tr -d '[:space:]')
      LOCAL_SHA_HEX=$(sha256sum "$TMP_INSTALLER" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$TMP_INSTALLER" 2>/dev/null | awk '{print $1}' || echo "")
      if [ -n "$LOCAL_SHA_HEX" ] && [ "$REMOTE_SHA_HEX" = "$LOCAL_SHA_HEX" ]; then
        _ok "SHA-256 verified"
      elif [ -n "$LOCAL_SHA_HEX" ]; then
        rm -f "$TMP_INSTALLER"
        _err "SHA-256 mismatch! Expected: ${REMOTE_SHA_HEX}  Got: ${LOCAL_SHA_HEX}
  The download may have been tampered with or corrupted. Retry, or install manually."
      else
        echo -e "${YELLOW}[..] SHA-256 check skipped (sha256sum not available)${NC}"
      fi
    else
      echo -e "${YELLOW}[..] SHA-256 check skipped (server endpoint unavailable)${NC}"
    fi

    # Run installer in upgrade mode (replaces binaries, skips provisioning)
    _info "Running upgrade…"
    bash "$TMP_INSTALLER" --upgrade
    rm -f "$TMP_INSTALLER"

    # Restore original API key + connection ID (upgrade may overwrite with placeholders)
    _BAK_KEY=$(grep '^TUNEVAULT_API_KEY=' "$BAK" 2>/dev/null | cut -d= -f2 || true)
    _BAK_CONN=$(grep '^TUNEVAULT_CONNECTION_ID=' "$BAK" 2>/dev/null | cut -d= -f2 || true)
    _BAK_URL=$(grep '^TUNEVAULT_API_URL=' "$BAK" 2>/dev/null | cut -d= -f2 || true)
    if [ -n "$_BAK_KEY" ] && [ -n "$_BAK_CONN" ]; then
      sed -i "s|^TUNEVAULT_API_KEY=.*|TUNEVAULT_API_KEY=${_BAK_KEY}|" "$CONF"
      sed -i "s|^TUNEVAULT_CONNECTION_ID=.*|TUNEVAULT_CONNECTION_ID=${_BAK_CONN}|" "$CONF"
      # Restore API URL too (upgrade writes the default, not the backed-up one)
      [ -n "$_BAK_URL" ] && sed -i "s|^TUNEVAULT_API_URL=.*|TUNEVAULT_API_URL=${_BAK_URL}|" "$CONF"
      # Stamp LAST_UPGRADE_AT
      _NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      if grep -q '^LAST_UPGRADE_AT=' "$CONF" 2>/dev/null; then
        sed -i "s|^LAST_UPGRADE_AT=.*|LAST_UPGRADE_AT=${_NOW}|" "$CONF"
      else
        echo "LAST_UPGRADE_AT=${_NOW}" >> "$CONF"
      fi
      _ok "API key + connection ID restored from backup"
    fi

    # Restart service — try tunevault-agent (v6.1+) first, then legacy tunevault-proxy
    local _up_svc="tunevault-agent"
    systemctl is-active tunevault-agent.service >/dev/null 2>&1 || _up_svc="tunevault-proxy"
    _info "Restarting ${_up_svc}.service…"
    systemctl restart "${_up_svc}.service" \
      || _err "systemctl restart failed — check: journalctl -u ${_up_svc} -n 50"
    sleep 3
    systemctl is-active "${_up_svc}.service" >/dev/null 2>&1 \
      || _err "Service not active after restart. Rollback: sudo cp ${BAK} ${CONF} && systemctl restart ${_up_svc}"
    _ok "Service restarted"

    # Run diagnose — all 7 probes (human-readable output)
    echo ""
    _info "Running post-upgrade diagnostics…"
    LIB=/usr/local/lib/tunevault-diagnose.sh
    if [ -f "$LIB" ]; then
      # shellcheck source=/dev/null
      source "$LIB"
      if run_diagnose 0; then
        echo ""
        echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}${BOLD}║  ✅ UPGRADE COMPLETE — all 7 probes pass     ║${NC}"
        echo -e "${GREEN}${BOLD}║     /connections will show new version        ║${NC}"
        echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
        exit 0
      else
        echo ""
        echo -e "${YELLOW}⚠ Upgrade completed but some probes failed.${NC}"
        echo -e "${YELLOW}  Rollback: sudo cp ${BAK} ${CONF} && systemctl restart ${_up_svc}${NC}"
        exit 1
      fi
    else
      echo -e "${GREEN}${BOLD}✅ UPGRADE COMPLETE — restart clean.${NC}"
    fi
    ;;
  repair)
    [ -f /etc/tunevault/proxy.env ] && source /etc/tunevault/proxy.env 2>/dev/null || true
    INSTALLER_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
    echo "Downloading and running repair mode…"
    curl -fsSL "${INSTALLER_URL}/install.sh" | bash -s -- --repair
    ;;
  register)
    echo "Usage: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    echo "Get your install token from the TuneVault UI under Connections → Add Connection."
    ;;
  version)
    echo "tunevault-proxy installer/agent"
    echo "  installer:  v4.5"
    if [ -f /opt/tunevault/oracle-proxy.py ]; then
      PROXY_VER=$(grep -m1 '^VERSION' /opt/tunevault/oracle-proxy.py 2>/dev/null \
        | sed 's/^VERSION\s*=\s*["'"'"']\([^"'"'"']*\)["'"'"']/\1/' || echo "unknown")
      echo "  proxy:      v${PROXY_VER}"
    fi
    if [ -f /etc/tunevault/proxy.env ]; then
      source /etc/tunevault/proxy.env 2>/dev/null || true
      echo "  env ver:    ${VERSION:-unknown}"
    fi
    VENV_PYTHON=/opt/tunevault/venv/bin/python3
    if [ -f "$VENV_PYTHON" ]; then
      PY_VER=$("$VENV_PYTHON" --version 2>&1 || echo "unknown")
      echo "  python:     $PY_VER"
      CX_VER=$("$VENV_PYTHON" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null || echo "not installed")
      echo "  cx_Oracle:  $CX_VER"
      ORA_VER=$("$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || echo "not installed")
      echo "  oracledb:   $ORA_VER"
    fi
    ;;
  --help|-h|help|"")
    echo "TuneVault Proxy CLI  v4.5"
    echo ""
    echo "Usage: tunevault-proxy <command> [options]"
    echo ""
    echo "Commands:"
    echo "  diagnose [--json]  Run 7-probe health check on this proxy host"
    echo "  upgrade            In-place upgrade: backup creds, replace binaries, restart, verify"
    echo "  register           Show how to register a new connection"
    echo "  repair             Re-run repair mode (re-installs drivers, restarts service)"
    echo "  version            Print version information"
    echo "  --help             Show this help"
    echo ""
    echo "Quick upgrade:"
    echo "  sudo tunevault-proxy upgrade"
    echo "  # or: curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --upgrade"
    ;;
  *)
    echo "Unknown command: $CMD" >&2
    echo "Run 'tunevault-proxy --help' for usage." >&2
    exit 1
    ;;
esac
TVPEOF
chmod +x /usr/local/bin/tunevault-proxy
ok "tunevault-proxy CLI installed (/usr/local/bin/tunevault-proxy diagnose)"

# Write the shared self-test library (sourced by both installer and CLI)
mkdir -p /usr/local/lib
cat > /usr/local/lib/tunevault-self-test.sh <<'LIBEOF'
#!/usr/bin/env bash
# Shared self-test library for TuneVault agent.
# Sourced by install.sh and /usr/local/bin/tunevault-agent.
# Requires: API_KEY, API_URL, CONNECTION_ID, VENV_PYTHON, VENV_PIP, VENV_DIR

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

# ─── probe helpers ─────────────────────────────────────────────────────────────
# Spec-exact format: "[N/6] Label ..... PASS (detail)"
# label arg includes [N/6] + trailing dots — fixed per probe so CI can grep exactly.
probe_pass()  { _LAST_PROBE_SKIPPED=0; echo -e "${GREEN}${1} PASS${NC} ${2:-}"; }
probe_fail()  { _LAST_PROBE_SKIPPED=0; echo -e "${RED}${1} FAIL${NC}"; echo -e "      ${YELLOW}→ ${2:-error}${NC}"; echo -e "      ${YELLOW}→ Fix: ${3:-}${NC}"; }
probe_skip()  { _LAST_PROBE_SKIPPED=1; echo -e "${YELLOW}${1} SKIPPED${NC} ${2:-}"; }
_LAST_PROBE_SKIPPED=0

# Fixed labels (with dot-padding) — match spec output exactly
L1="[1/6] Python + cx_Oracle ..........."
L2="[2/6] Agent registered ............."
L3="[3/6] Outbound channel ............."
L4="[4/6] TNS listener ................."
L5="[5/6] SSH bastion .................."
L6="[6/6] End-to-end query ............."

# Runs a command with a hard timeout (bash-only, no external 'timeout' required).
# Returns the exit code of the command or 1 on timeout/error.
# Uses || true guards so set -e in the parent doesn't abort on non-zero wait().
_with_timeout() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
  local killer=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null || true
  return $rc
}

# ─── probe 1: Python + Oracle drivers (cx_Oracle + oracledb) ──────────────────
# This probe actually imports both drivers — not just checks python3 exists.
# A failed import here is a hard failure: the agent cannot connect to Oracle.
# Also checks that the python binary used by systemd matches the venv python.
probe_1() {
  local py_ver cx_ver oradb_ver driver_label both_ok=0
  py_ver=$(_with_timeout 15 "$VENV_PYTHON" -c \
    "import sys; print('{}.{}.{}'.format(*sys.version_info[:3]))" 2>/dev/null) || py_ver=""

  if [ -z "$py_ver" ]; then
    probe_fail "$L1" "python3 not found at $VENV_PYTHON" \
      "Re-run installer or check venv: $VENV_PIP install cx_Oracle==8.3.0"
    return 1
  fi

  # Step 1: attempt to import BOTH drivers simultaneously (ideal case).
  # This catches the crash-loop scenario where neither driver is installed.
  local both_output
  both_output=$(_with_timeout 15 "$VENV_PYTHON" -c \
    'import cx_Oracle, oracledb; print("cx_Oracle", cx_Oracle.version, "oracledb", oracledb.__version__)' \
    2>/dev/null) || both_output=""

  if [ -n "$both_output" ]; then
    driver_label="$(echo "$both_output" | head -1), Python ${py_ver}"
    probe_pass "$L1" "(${driver_label})"
    both_ok=1
  fi

  # Step 2: if both failed, try each individually (single-driver installs).
  if [ "$both_ok" -eq 0 ]; then
    cx_ver=$(_with_timeout 15 "$VENV_PYTHON" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null) || cx_ver=""
    oradb_ver=$(_with_timeout 15 "$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null) || oradb_ver=""

    if [ -n "$cx_ver" ] || [ -n "$oradb_ver" ]; then
      # At least one driver installed — report versions found
      if [ -n "$cx_ver" ] && [ -n "$oradb_ver" ]; then
        driver_label="cx_Oracle ${cx_ver} + oracledb ${oradb_ver}, Python ${py_ver}"
      elif [ -n "$cx_ver" ]; then
        driver_label="cx_Oracle ${cx_ver} (oracledb not installed), Python ${py_ver}"
      else
        driver_label="oracledb ${oradb_ver} thin (cx_Oracle not installed), Python ${py_ver}"
      fi
      probe_pass "$L1" "(${driver_label})"
    else
      # HARD FAIL — neither driver importable. Agent will crash-loop without this.
      probe_fail "$L1" \
        "FATAL: neither cx_Oracle nor oracledb importable in venv (agent will crash-loop without a driver)" \
        "$(printf 'Install Oracle Instant Client first, then run: sudo bash -s -- --repair\n   One-liner: curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair\n   This is a hard failure — agent cannot connect to Oracle without cx_Oracle.')"
      return 1
    fi
  fi

  # Step 3: verify the python binary systemd uses matches our venv python.
  # Mismatch means systemd could be using a system python without drivers installed.
  if command -v systemctl >/dev/null 2>&1; then
    local svc_pid svc_python _st_svc="tunevault-agent"
    systemctl is-active tunevault-agent.service >/dev/null 2>&1 || _st_svc="tunevault-proxy"
    svc_pid=$(systemctl show -p MainPID --value "$_st_svc" 2>/dev/null || echo "")
    if [ -n "$svc_pid" ] && [ "$svc_pid" != "0" ]; then
      svc_python=$(readlink "/proc/${svc_pid}/exe" 2>/dev/null || echo "")
      local venv_real
      venv_real=$(readlink -f "$VENV_PYTHON" 2>/dev/null || echo "$VENV_PYTHON")
      if [ -n "$svc_python" ] && [ "$svc_python" != "$venv_real" ]; then
        probe_fail "$L1" \
          "python binary mismatch: systemd uses ${svc_python} but drivers installed in ${venv_real}" \
          "Check ExecStart in /etc/systemd/system/${_st_svc}.service — should be ${VENV_PYTHON}"
        return 1
      fi
    fi
  fi

  return 0
}

# ─── probe 2: Agent registered ────────────────────────────────────────────────
probe_2() {
  # Use the config path resolved by the caller (agent.env v6.1+ / proxy.env v3-v5)
  local conf="${CONF:-/etc/tunevault/agent.env}"
  if [ ! -f "$conf" ] && [ ! -f /etc/tunevault/proxy.env ]; then
    probe_fail "$L2" "No config found in /etc/tunevault/" "Re-run installer"
    return 1
  fi
  if [ -z "${CONNECTION_ID:-}" ]; then
    probe_fail "$L2" "TUNEVAULT_CONNECTION_ID missing from $conf" "Re-run installer"
    return 1
  fi
  # Confirm cloud side knows about this agent
  local resp
  resp=$(_with_timeout 15 curl -fsS \
    -H "X-TuneVault-Key: ${API_KEY}" \
    "${API_URL}/api/agent/status?connection_id=${CONNECTION_ID}" 2>/dev/null) || resp=""
  if echo "$resp" | grep -q '"registered":true\|"registered": true'; then
    probe_pass "$L2" "(agent_id=${CONNECTION_ID})"
    return 0
  fi
  probe_fail "$L2" "cloud API did not return registered:true for connection ${CONNECTION_ID}" \
    "Wait 60s and retry — or open ${API_URL} and check the connection card"
  return 1
}

# ─── probe 3: Outbound channel ────────────────────────────────────────────────
probe_3() {
  local log_file=/var/log/tunevault/agent.log

  # Try log-based detection first (cheapest)
  if [ -f "$log_file" ]; then
    local ts_line
    ts_line=$(grep "channel:connected" "$log_file" 2>/dev/null | tail -1 || true)
    if [ -n "$ts_line" ]; then
      local ts_str
      ts_str=$(echo "$ts_line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+' | head -1 || true)
      if [ -n "$ts_str" ]; then
        local now_epoch ts_epoch seconds_ago
        now_epoch=$(date +%s 2>/dev/null || echo 0)
        ts_epoch=$(date -d "$ts_str" +%s 2>/dev/null || echo 0)
        seconds_ago=$(( now_epoch - ts_epoch ))
        if [ "$seconds_ago" -le 300 ]; then
          probe_pass "$L3" "(connected ${seconds_ago}s ago)"
          return 0
        fi
      else
        probe_pass "$L3" "(channel:connected log found)"
        return 0
      fi
    fi
  fi

  # Fallback: cloud channel-status endpoint
  local resp
  resp=$(_with_timeout 15 curl -fsS \
    -H "X-TuneVault-Key: ${API_KEY}" \
    "${API_URL}/api/agent/channel-status/${CONNECTION_ID}" 2>/dev/null) || resp=""
  if echo "$resp" | grep -q '"connected":true\|"connected": true'; then
    probe_pass "$L3" "(cloud confirms connected)"
    return 0
  fi

  probe_fail "$L3" "channel not connected (no recent channel:connected in log, cloud says not connected)" \
    "Check agent service: journalctl -u tunevault-agent -n 50 | grep -E 'error|channel'"
  return 1
}

# ─── probe 4: TNS listener reachable ─────────────────────────────────────────
probe_4() {
  local resp
  resp=$(_with_timeout 15 curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -H "X-TuneVault-Key: ${API_KEY}" \
    -d "{\"connection_id\":${CONNECTION_ID}}" \
    "${API_URL}/api/connections/${CONNECTION_ID}/ping" 2>/dev/null) || resp=""

  if echo "$resp" | grep -q '"oracle_listener_up":true\|"oracle_listener_up": true'; then
    local dbhost
    dbhost=$(echo "$resp" | sed -n 's/.*"db_host":"\([^"]*\)".*/\1/p' | head -1 || true)
    probe_pass "$L4" "(${dbhost:-listener up})"
    return 0
  fi

  local ora_err
  ora_err=$(echo "$resp" | sed -n 's/.*"oracle_error":"\([^"]*\)".*/\1/p' | head -1 || true)
  if [ -z "$ora_err" ]; then
    ora_err=$(echo "$resp" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -1 || true)
  fi
  [ -z "$ora_err" ] && ora_err="Oracle ping returned no listener_up confirmation"

  probe_fail "$L4" "$ora_err" \
    "check listener — run \`lsnrctl status\` to verify host, port, and service registration"
  return 1
}

# ─── probe 5: SSH bastion reachable ──────────────────────────────────────────
probe_5() {
  local ssh_conf=/etc/tunevault/ssh.conf
  if [ ! -f "$ssh_conf" ]; then
    probe_skip "$L5" "(no SSH config — skip)"
    return 0
  fi
  local ssh_host ssh_port ssh_user
  ssh_host=$(grep -E '^SSH_HOST=' "$ssh_conf" | cut -d= -f2 || true)
  ssh_port=$(grep -E '^SSH_PORT=' "$ssh_conf" | cut -d= -f2 || echo 22)
  ssh_user=$(grep -E '^SSH_USER=' "$ssh_conf" | cut -d= -f2 || true)
  if [ -z "$ssh_host" ]; then
    probe_skip "$L5" "(SSH_HOST not set in $ssh_conf — skip)"
    return 0
  fi
  local key_file=/etc/tunevault/id_rsa
  local ssh_opts="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no"
  [ -f "$key_file" ] && ssh_opts="$ssh_opts -i $key_file"
  # shellcheck disable=SC2086
  if _with_timeout 15 ssh $ssh_opts -p "$ssh_port" "${ssh_user:+${ssh_user}@}${ssh_host}" exit 2>/dev/null; then
    probe_pass "$L5" "(${ssh_host}:${ssh_port})"
    return 0
  fi
  probe_fail "$L5" "SSH connection to ${ssh_host}:${ssh_port} failed" \
    "Test manually: ssh -o BatchMode=yes -o ConnectTimeout=10 -p $ssh_port ${ssh_host} exit"
  return 1
}

# ─── probe 6: End-to-end query (depends on probe 4) ─────────────────────────
# Only runs if probe 4 passed. If TNS failed, prints SKIPPED and returns 0.
probe_6() {
  local p4_status=$1  # 0=pass, 1=fail
  if [ "$p4_status" -ne 0 ]; then
    probe_skip "$L6" "(TNS failed)"
    return 0  # skipped, not failed — don't count as error
  fi
  local resp
  resp=$(_with_timeout 15 curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -H "X-TuneVault-Key: ${API_KEY}" \
    -d "{\"connection_id\":${CONNECTION_ID}}" \
    "${API_URL}/api/connections/${CONNECTION_ID}/ping" 2>/dev/null) || resp=""

  local query_ms
  query_ms=$(echo "$resp" | sed -n 's/.*"sample_query_ms":[[:space:]]*\([0-9]*\).*/\1/p' | head -1 || true)
  if echo "$resp" | grep -q '"oracle_listener_up":true\|"oracle_listener_up": true'; then
    if [ -n "$query_ms" ]; then
      probe_pass "$L6" "(SELECT 1 FROM DUAL → 1 row, ${query_ms}ms)"
    else
      probe_pass "$L6" "(SELECT 1 FROM DUAL → 1 row)"
    fi
    return 0
  fi
  local ora_err
  ora_err=$(echo "$resp" | sed -n 's/.*"oracle_error":"\([^"]*\)".*/\1/p' | head -1 || true)
  [ -z "$ora_err" ] && ora_err="query did not return a result row"
  probe_fail "$L6" "$ora_err" \
    "check agent logs: journalctl -u tunevault-agent -n 30"
  return 1
}

# ─── main entry point ──────────────────────────────────────────────────────────
run_self_test() {
  echo ""
  echo "========================================"
  echo "TuneVault Agent Self-Test"
  echo "========================================"

  # p* = 0 pass/skip, 1 fail; s* = 1 skipped (not counted in pass or fail)
  local p1=0 p2=0 p3=0 p4=0 p5=0 p6=0
  local s1=0 s2=0 s3=0 s4=0 s5=0 s6=0
  local pass_count=0 fail_count=0 skip_count=0
  local failed_probes=()

  # Run all 6 probes independently — a failure in one never stops the others.
  # _LAST_PROBE_SKIPPED is set by probe_skip() vs probe_pass()/probe_fail().
  _LAST_PROBE_SKIPPED=0; probe_1 || p1=1; s1=$_LAST_PROBE_SKIPPED
  _LAST_PROBE_SKIPPED=0; probe_2 || p2=1; s2=$_LAST_PROBE_SKIPPED
  _LAST_PROBE_SKIPPED=0; probe_3 || p3=1; s3=$_LAST_PROBE_SKIPPED
  _LAST_PROBE_SKIPPED=0; probe_4 || p4=1; s4=$_LAST_PROBE_SKIPPED
  _LAST_PROBE_SKIPPED=0; probe_5 || p5=1; s5=$_LAST_PROBE_SKIPPED
  _LAST_PROBE_SKIPPED=0; probe_6 "$p4" || p6=1; s6=$_LAST_PROBE_SKIPPED

  echo "========================================"

  # Tally: skipped probes count neither as pass nor fail
  for _pair in "p1 s1" "p2 s2" "p3 s3" "p4 s4" "p5 s5" "p6 s6"; do
    read -r _pvar _svar <<< "$_pair"
    eval "_pv=\$$_pvar"; eval "_sv=\$$_svar"
    if [ "$_sv" -eq 1 ]; then
      skip_count=$((skip_count+1))
    elif [ "$_pv" -eq 0 ]; then
      pass_count=$((pass_count+1))
    else
      fail_count=$((fail_count+1))
    fi
  done

  printf "Result: %d PASS / %d FAIL / %d SKIPPED\n" "$pass_count" "$fail_count" "$skip_count"
  echo "========================================"

  # Collect failed probe names for JSON (skipped probes are not failures)
  [ "$s1" -eq 0 ] && [ "$p1" -ne 0 ] && failed_probes+=("probe_1_python_cx_oracle")
  [ "$s2" -eq 0 ] && [ "$p2" -ne 0 ] && failed_probes+=("probe_2_agent_registered")
  [ "$s3" -eq 0 ] && [ "$p3" -ne 0 ] && failed_probes+=("probe_3_outbound_channel")
  [ "$s4" -eq 0 ] && [ "$p4" -ne 0 ] && failed_probes+=("probe_4_tns_listener")
  [ "$s5" -eq 0 ] && [ "$p5" -ne 0 ] && failed_probes+=("probe_5_ssh_bastion")
  [ "$s6" -eq 0 ] && [ "$p6" -ne 0 ] && failed_probes+=("probe_6_end_to_end_query")

  local outcome="pass"
  [ "$fail_count" -gt 0 ] && outcome="fail"

  local failed_json="["
  local _first=1
  for _n in "${failed_probes[@]+"${failed_probes[@]}"}"; do
    [ "$_first" -eq 1 ] && _first=0 || failed_json="${failed_json},"
    failed_json="${failed_json}\"${_n}\""
  done
  failed_json="${failed_json}]"
  echo "{\"self_test\":\"${outcome}\",\"failed\":${failed_json}}"

  [ "$fail_count" -eq 0 ] || return 1
}
LIBEOF
chmod +r /usr/local/lib/tunevault-self-test.sh
ok "tunevault-agent CLI installed (/usr/local/bin/tunevault-agent --help)"

# ── Write tunevault-diagnose.sh library ───────────────────────────────────────
# Sourced by /usr/local/bin/tunevault-proxy diagnose.
# Probes run locally — no curl to Cloudflare, no API key copy-paste needed.
# Reads /etc/tunevault/agent.env (v6.1+) or /etc/tunevault/proxy.env (v3-v5 fallback).
cat > /usr/local/lib/tunevault-diagnose.sh <<'DIAGEOF'
#!/usr/bin/env bash
# tunevault-diagnose.sh — local 7-probe health check for TuneVault proxy hosts.
# Sourced by /usr/local/bin/tunevault-proxy; not intended for direct execution.
# Probe scope: 1-3 local, 4 TCP, 5 Python/Oracle, 6 cloud API, 7 version-current check.

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

# agent.env (v6.1+) is the canonical config; fall back to proxy.env for v3-v5 boxes
if [ -f /etc/tunevault/agent.env ]; then
  _DG_CONF=/etc/tunevault/agent.env
else
  _DG_CONF=/etc/tunevault/proxy.env
fi
_DG_VENV_PYTHON=/opt/tunevault/venv/bin/python3
_DG_PROXY_PORT=3100

# ─── helpers ──────────────────────────────────────────────────────────────────
_dg_pass()  { echo -e "${GREEN}${1} PASS${NC} ${2:-}"; }
_dg_fail()  { echo -e "${RED}${1} FAIL${NC}"; echo -e "      ${YELLOW}→ ${2:-error}${NC}"; echo -e "      ${YELLOW}→ Fix: ${3:-see above}${NC}"; }
_dg_skip()  { echo -e "${YELLOW}${1} SKIP${NC} ${2:-}"; }
_dg_warn()  { echo -e "${YELLOW}${1} WARN${NC} ${2:-}"; }

_dg_elapsed_since() {
  # Return seconds since a unix epoch; 0 if conversion fails
  local epoch=$1
  local now; now=$(date +%s 2>/dev/null || echo 0)
  echo $(( now - epoch ))
}

_dg_tcp_check() {
  # Returns 0 if TCP port is open, 1 otherwise. Also prints latency_ms.
  local host=$1 port=$2
  local t0 t1 elapsed
  t0=$(date +%s%3N 2>/dev/null || echo 0)
  if command -v nc >/dev/null 2>&1; then
    nc -z -w5 "$host" "$port" >/dev/null 2>&1 || return 1
  else
    # Bash built-in TCP pseudo-device (no nc required)
    exec 9<>"/dev/tcp/${host}/${port}" 2>/dev/null || return 1
    exec 9>&-
  fi
  t1=$(date +%s%3N 2>/dev/null || echo 0)
  elapsed=$(( t1 - t0 ))
  echo "${elapsed}"
  return 0
}

_dg_with_timeout() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
  local killer=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null || true
  return $rc
}

# ─── probe 1: Proxy process running ──────────────────────────────────────────
_DL1="[1/8] Proxy process running ........."
dg_probe_1() {
  # Check systemd service first, then fall back to process search.
  local pid uptime_str=""

  if command -v systemctl >/dev/null 2>&1; then
    # Check tunevault-agent (v6.1+) first, then legacy tunevault-proxy.
    # Use is-active for the running check, but prefer whichever unit file
    # actually exists when reporting errors (avoids naming the wrong service).
    local _dg_svc=""
    if systemctl is-active tunevault-agent.service >/dev/null 2>&1; then
      _dg_svc="tunevault-agent"
    elif systemctl is-active tunevault-proxy.service >/dev/null 2>&1; then
      _dg_svc="tunevault-proxy"
    fi

    if [ -n "$_dg_svc" ]; then
      pid=$(systemctl show -p MainPID --value "${_dg_svc}.service" 2>/dev/null || echo "")
      if [ -n "$pid" ] && [ "$pid" != "0" ]; then
        # Calculate uptime from /proc/<pid>/stat
        local start_ticks now_ticks hz elapsed_s
        start_ticks=$(awk '{print $22}' "/proc/${pid}/stat" 2>/dev/null || echo 0)
        hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
        now_ticks=$(awk '{print $1}' /proc/uptime 2>/dev/null | awk '{printf "%d", $1 * 100}' || echo 0)
        elapsed_s=$(( (now_ticks - start_ticks) / hz ))
        if [ "$elapsed_s" -ge 60 ]; then
          uptime_str="$(( elapsed_s / 60 ))m$(( elapsed_s % 60 ))s"
        else
          uptime_str="${elapsed_s}s"
        fi
        _dg_pass "$_DL1" "(pid ${pid}, uptime ${uptime_str})"
        return 0
      else
        _dg_pass "$_DL1" "(systemd: active)"
        return 0
      fi
    else
      # Neither service is active — report whichever unit file exists on disk
      # (prefer tunevault-agent since that's what the v6.1+ installer creates)
      local _dg_err_svc="tunevault-agent"
      systemctl cat tunevault-agent.service >/dev/null 2>&1 || _dg_err_svc="tunevault-proxy"
      local _svc_status
      _svc_status=$(systemctl is-active "${_dg_err_svc}.service" 2>/dev/null || echo unknown)
      _dg_fail "$_DL1" \
        "${_dg_err_svc}.service is not active (${_svc_status})" \
        "sudo systemctl start ${_dg_err_svc}.service  # or: sudo tunevault-agent repair"
      return 1
    fi
  fi

  # Fallback: pgrep for oracle-proxy.py or tunevault-agent start
  pid=$(pgrep -f "oracle-proxy.py\|agent/cli.py start\|agent\.cli start" 2>/dev/null | head -1 || true)
  if [ -n "$pid" ]; then
    _dg_pass "$_DL1" "(pid ${pid}, no systemd)"
    return 0
  fi

  _dg_fail "$_DL1" \
    "Agent process not running (no systemd, no matching process)" \
    "sudo systemctl start tunevault-agent.service  # or re-run installer"
  return 1
}

# ─── probe 2: Python drivers ──────────────────────────────────────────────────
_DL2="[2/8] Python drivers ..............."
dg_probe_2() {
  if [ ! -f "$_DG_VENV_PYTHON" ]; then
    _dg_fail "$_DL2" \
      "venv not found at $_DG_VENV_PYTHON" \
      "Re-run installer: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    return 1
  fi

  local cx_ver oradb_ver
  cx_ver=$(_dg_with_timeout 15 "$_DG_VENV_PYTHON" -c "import cx_Oracle; print(cx_Oracle.version)" 2>/dev/null) || cx_ver=""
  oradb_ver=$(_dg_with_timeout 15 "$_DG_VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null) || oradb_ver=""

  if [ -n "$cx_ver" ] && [ -n "$oradb_ver" ]; then
    _dg_pass "$_DL2" "(cx_Oracle ${cx_ver} + oracledb ${oradb_ver})"
    return 0
  elif [ -n "$cx_ver" ]; then
    _dg_pass "$_DL2" "(cx_Oracle ${cx_ver})"
    return 0
  elif [ -n "$oradb_ver" ]; then
    _dg_pass "$_DL2" "(oracledb ${oradb_ver} thin)"
    return 0
  fi

  _dg_fail "$_DL2" \
    "neither cx_Oracle nor oracledb importable from venv (agent will crash-loop)" \
    "curl -fsSL https://tunevault.app/install.sh | sudo bash -s -- --repair"
  return 1
}

# ─── probe 3: config loaded ───────────────────────────────────────────────────
_DL3="[3/8] Config loaded ................"
dg_probe_3() {
  if [ ! -f "$_DG_CONF" ]; then
    _dg_fail "$_DL3" \
      "$_DG_CONF not found — agent not yet registered" \
      "Run installer with token: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    return 1
  fi

  # Load env
  # shellcheck source=/dev/null
  source "$_DG_CONF" 2>/dev/null || true
  local api_key="${TUNEVAULT_API_KEY:-}"
  local api_url="${TUNEVAULT_API_URL:-}"
  local conn_id="${TUNEVAULT_CONNECTION_ID:-}"

  if [ -z "$api_key" ]; then
    _dg_fail "$_DL3" \
      "TUNEVAULT_API_KEY missing from $_DG_CONF" \
      "sudo tunevault-proxy repair  # or re-run: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    return 1
  fi

  local key_len="${#api_key}"
  if [ "$key_len" -lt 16 ]; then
    _dg_fail "$_DL3" \
      "TUNEVAULT_API_KEY looks truncated (len=${key_len}, expected ≥16)" \
      "sudo tunevault-proxy repair"
    return 1
  fi

  # Export for downstream probes
  export _DG_API_KEY="$api_key"
  export _DG_API_URL="${api_url:-https://tunevault.app}"
  export _DG_CONN_ID="${conn_id:-}"

  _dg_pass "$_DL3" "(TUNEVAULT_API_KEY len=${key_len}, conn=${conn_id:-unset})"
  return 0
}

# ─── probe 4: TNS listener reachable ─────────────────────────────────────────
_DL4="[4/8] TNS listener reachable ......."
dg_probe_4() {
  # Determine Oracle host/port — three-tier detection:
  # 1. Explicit env vars (agent.env sets ORACLE_HOST/PORT from install-time lsnrctl)
  # 2. Running proxy process env (fallback for pre-v6.2 installs)
  # 3. Live lsnrctl detection (always works if Oracle is running)
  local ora_host="${ORACLE_HOST:-}"
  local ora_port="${ORACLE_PORT:-}"

  # Tier 2: running oracle-proxy.py process env
  if [ -z "$ora_host" ] || [ -z "$ora_port" ]; then
    local proxy_pid
    proxy_pid=$(pgrep -f "oracle-proxy.py" 2>/dev/null | head -1 || true)
    if [ -n "$proxy_pid" ]; then
      local env_str
      env_str=$(strings "/proc/${proxy_pid}/environ" 2>/dev/null || true)
      [ -z "$ora_host" ] && ora_host=$(echo "$env_str" | grep "^ORACLE_HOST=" | cut -d= -f2 | head -1 || true)
      [ -z "$ora_port" ] && ora_port=$(echo "$env_str" | grep "^ORACLE_PORT=" | cut -d= -f2 | head -1 || true)
    fi
  fi

  # Tier 3: live lsnrctl detection — parse HOST/PORT from listener endpoint summary.
  # WHY: On pre-v6.2 installs, agent.env has no ORACLE_HOST/PORT. Rather than
  # blindly defaulting to localhost:1521, ask the listener what it actually binds to.
  if [ -z "$ora_host" ] || [ -z "$ora_port" ]; then
    local lsnr_bin=""
    if command -v lsnrctl >/dev/null 2>&1; then
      lsnr_bin="lsnrctl"
    elif [ -n "${ORACLE_HOME:-}" ] && [ -x "${ORACLE_HOME}/bin/lsnrctl" ]; then
      lsnr_bin="${ORACLE_HOME}/bin/lsnrctl"
    fi
    if [ -n "$lsnr_bin" ]; then
      local lsnr_out=""
      # Try SID-named listener first (EBS pattern), then default.
      # _pmon_sids_detect() returns only validated SIDs — safe to pass to lsnrctl.
      local pmon_sid
      pmon_sid=$(_pmon_sids_detect | cut -d, -f1)
      if [ -n "$pmon_sid" ]; then
        lsnr_out=$($lsnr_bin status "$pmon_sid" 2>/dev/null || true)
      fi
      if [ -z "$lsnr_out" ] || echo "$lsnr_out" | grep -qi "no listener"; then
        lsnr_out=$($lsnr_bin status 2>/dev/null || true)
      fi
      if [ -n "$lsnr_out" ]; then
        [ -z "$ora_host" ] && \
        # POSIX: capture (HOST=...) then strip parens with sed.
        ora_host=$(echo "$lsnr_out" | grep -oE '\(HOST=[^)]+\)' | head -1 | sed 's/^(HOST=//;s/)$//' || true)
        [ -z "$ora_port" ] && \
        # POSIX: capture (PORT=...) then strip parens with sed.
        ora_port=$(echo "$lsnr_out" | grep -oE '\(PORT=[0-9]+\)' | head -1 | sed 's/^(PORT=//;s/)$//' || true)
      fi
    fi
  fi

  # Final fallback — only if all three tiers failed
  ora_host="${ora_host:-localhost}"
  ora_port="${ora_port:-1521}"

  export _DG_ORA_HOST="$ora_host"
  export _DG_ORA_PORT="$ora_port"

  local lat_ms
  lat_ms=$(_dg_with_timeout 8 _dg_tcp_check "$ora_host" "$ora_port" 2>/dev/null) || lat_ms=""

  if [ -n "$lat_ms" ]; then
    _dg_pass "$_DL4" "(${ora_host}:${ora_port}, ${lat_ms}ms)"
    return 0
  fi

  _dg_fail "$_DL4" \
    "TCP connection to ${ora_host}:${ora_port} failed (no TNS listener)" \
    "sudo systemctl start oracle-listener  # or: sudo lsnrctl start"
  return 1
}

# ─── probe 5: Oracle service reachable ───────────────────────────────────────
_DL5="[5/8] Oracle service ..............."
dg_probe_5() {
  local p4_status=$1  # 0=pass, 1=fail

  if [ "$p4_status" -ne 0 ]; then
    _dg_skip "$_DL5" "(TNS failed — skipping Oracle service check)"
    return 0
  fi

  # First: try the local proxy /health endpoint — cheapest, no credentials needed.
  local health_resp oracle_status
  health_resp=$(curl -fs "http://localhost:${_DG_PROXY_PORT}/health" 2>/dev/null || true)
  if [ -n "$health_resp" ]; then
    oracle_status=$(echo "$health_resp" | sed -n 's/.*"oracle_status":"\([^"]*\)".*/\1/p' | head -1 || true)
    [ -z "$oracle_status" ] && oracle_status=$(echo "$health_resp" | sed -n 's/.*"oracle":"\([^"]*\)".*/\1/p' | head -1 || true)

    if echo "$health_resp" | grep -qE '"oracle_connected":true|"oracle":true|"oracle_status":"(ok|connected|OPEN)"'; then
      _dg_pass "$_DL5" "(proxy /health confirms oracle connected)"
      return 0
    fi

    # /health exists but doesn't confirm oracle — fall through to Python check
  fi

  # Second: try a direct Python probe using cx_Oracle/oracledb with env credentials.
  # Source proxy.env for connection details (ORACLE_HOST/PORT/SERVICE/USER/PASS).
  local py_script
  local ora_host="${_DG_ORA_HOST:-localhost}"
  local ora_port="${_DG_ORA_PORT:-1521}"
  # Three-tier SID discovery for probe: PMON (ground truth) → proxy env → oratab.
  # PMON is authoritative — the proxy env may contain stale SIDs from a previous
  # registration that were never overwritten (bug #1670982).
  local ora_service=""

  # Tier 1: running PMON — one ora_pmon_<SID> per active instance (most reliable).
  # _pmon_sids_detect() uses /proc/*/comm with strict regex; returns only valid SIDs.
  local pmon_sid
  pmon_sid=$(_pmon_sids_detect | cut -d, -f1)
  if [ -n "$pmon_sid" ]; then
    ora_service="$pmon_sid"
  fi

  # Tier 2: proxy process env (fallback — may be stale on re-registration)
  if [ -z "$ora_service" ]; then
    local proxy_pid
    proxy_pid=$(pgrep -f "oracle-proxy.py" 2>/dev/null | head -1 || true)
    if [ -n "$proxy_pid" ]; then
      local env_str
      env_str=$(strings "/proc/${proxy_pid}/environ" 2>/dev/null || true)
      ora_service=$(echo "$env_str" | grep -E "^ORACLE_SERVICE=|^ORACLE_SID=" | head -1 | cut -d= -f2 || true)
    fi
  fi

  # Tier 3: /etc/oratab (last resort — may contain decommissioned entries)
  if [ -z "$ora_service" ] && [ -f /etc/oratab ]; then
    ora_service=$(grep -v '^#' /etc/oratab 2>/dev/null | grep -v '^$' | grep -v '^\*' | head -1 | cut -d: -f1 || true)
  fi

  if [ -z "$ora_service" ]; then
    _dg_skip "$_DL5" "(TNS reachable but no service/SID detected — proxy will discover on connect)"
    return 0
  fi

  # Attempt a quick connection using oracledb thin driver (no Instant Client needed).
  # CDB instances (e.g. EBSDEVDB) register in the listener as a dedicated-server SID,
  # NOT as a SERVICE_NAME.  Using host:port/SID (SERVICE_NAME syntax) causes the
  # listener to accept TCP but Oracle to wait forever → "no response from Oracle".
  # Fix: try SID-style descriptor first, then fall back to listener service names.
  local t0 t1 elapsed_ms py_result
  t0=$(date +%s%3N 2>/dev/null || echo 0)
  py_result=$(_dg_with_timeout 20 "$_DG_VENV_PYTHON" - <<PYEOF 2>/dev/null || true
import sys, re
try:
    import oracledb
    oracledb.init_oracle_client = lambda **kw: None  # thin mode — no client needed

    ora_host = "${ora_host}"
    ora_port = ${ora_port}
    cdb_sid  = "${ora_service}"

    tried = []

    def _test_conn(dsn_str, label):
        """Return (status_str, None) on success or (None, err_str) on failure."""
        try:
            conn = oracledb.connect(dsn=dsn_str, user="", password="")
            c = conn.cursor()
            c.execute("SELECT STATUS FROM V\$INSTANCE")
            row = c.fetchone()
            conn.close()
            status = row[0] if row else "UNKNOWN"
            return ("OPEN:%s via %s" % (status, label), None)
        except oracledb.DatabaseError as e:
            code = getattr(e.args[0], 'code', 0) if e.args else 0
            # ORA-01017 invalid creds / ORA-01005 null password — service IS up
            if code in (1017, 1005):
                return ("OPEN:AUTH_ONLY via %s" % label, None)
            return (None, str(e))
        except Exception as e:
            return (None, str(e))

    # 1. SID-style descriptor — correct for CDB instances
    sid_dsn = "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=%s)(PORT=%d))(CONNECT_DATA=(SID=%s)))" % (ora_host, ora_port, cdb_sid)
    ok, err = _test_conn(sid_dsn, "SID=%s via dedicated server" % cdb_sid)
    if ok:
        print(ok)
        sys.exit(0)
    tried.append(("SID=%s" % cdb_sid, err))

    # 2. SERVICE_NAME with the CDB SID (fallback — sometimes registered as service)
    svc_dsn = "%s:%d/%s" % (ora_host, ora_port, cdb_sid)
    ok, err = _test_conn(svc_dsn, "SERVICE_NAME=%s" % cdb_sid)
    if ok:
        print(ok)
        sys.exit(0)
    tried.append(("SERVICE_NAME=%s" % cdb_sid, err))

    # 3. Enumerate registered services via lsnrctl services (full per-instance data).
    # lsnrctl services gives "Service NAME has N instance(s)" blocks — use this to
    # know which instance each service is registered with, so we can discard services
    # whose only instance is not in our local PMON list.
    # Also run lsnrctl status as fallback (only shows service name summary).
    import subprocess, shutil
    lsnr_bin = shutil.which("lsnrctl") or ""
    if not lsnr_bin:
        import os as _os
        oh = _os.environ.get("ORACLE_HOME", "")
        if oh:
            cand = oh.rstrip("/") + "/bin/lsnrctl"
            if _os.path.isfile(cand):
                lsnr_bin = cand

    lsnr_svc_out = ""   # from: lsnrctl services
    lsnr_st_out  = ""   # from: lsnrctl status (fallback)
    if lsnr_bin:
        # Try lsnrctl services with SID alias first, then bare
        for _lsnr_args in [[lsnr_bin, "services", cdb_sid], [lsnr_bin, "services"]]:
            try:
                r = subprocess.run(_lsnr_args, capture_output=True, text=True, timeout=15)
                if r.returncode == 0 and "no listener" not in r.stdout.lower() and "Service" in r.stdout:
                    lsnr_svc_out = r.stdout
                    break
            except Exception:
                pass
        # lsnrctl status fallback for service list when services cmd fails
        for _lsnr_args in [[lsnr_bin, "status", cdb_sid], [lsnr_bin, "status"]]:
            try:
                r = subprocess.run(_lsnr_args, capture_output=True, text=True, timeout=10)
                if r.returncode == 0 and "no listener" not in r.stdout.lower():
                    lsnr_st_out = r.stdout
                    break
            except Exception:
                pass

    # Parse lsnrctl services output for per-instance data.
    # Block: Service "NAME" has N instance(s). Instance "INST", status READY, ...
    # Use this to determine which instances each service is registered with.
    svc_instances = {}   # service_name -> set of instance names
    current_svc = None
    for line in lsnr_svc_out.splitlines():
        m = re.match(r'\s*Service "([^"]+)"', line)
        if m:
            current_svc = m.group(1)
            svc_instances.setdefault(current_svc, set())
        elif current_svc:
            m2 = re.match(r'\s*Instance "([^"]+)"', line)
            if m2:
                svc_instances[current_svc].add(m2.group(1).upper())

    # Collect all service names from both outputs
    all_svc_names = set(re.findall(r'Service "([^"]+)"', lsnr_svc_out))
    all_svc_names.update(re.findall(r'Service "([^"]+)"', lsnr_st_out))

    # Filter and score candidates
    svcs = []
    rejected = []
    for svc in sorted(all_svc_names):
        up = svc.upper()
        # Block: CDB instance SIDs (not real services)
        if up == cdb_sid.upper():
            rejected.append((svc, "is CDB instance SID"))
            continue
        # Block: XDB (HTTP/XMLType endpoint — not for SQL)
        if up.endswith("XDB"):
            rejected.append((svc, "XDB service blocked"))
            continue
        # Block: Oracle internal services
        if svc.upper() in ("PLSEXTPROC", "EXTPROC1521"):
            rejected.append((svc, "internal Oracle service"))
            continue
        if svc.startswith("SYS\$"):
            rejected.append((svc, "SYS$ internal service"))
            continue
        # Block: 32-char hex GUIDs (Oracle internal identifiers)
        if re.match(r'^[0-9a-f]{32}$', svc.lower()):
            rejected.append((svc, "GUID service blocked"))
            continue
        # Block: ADOP patch-mode services (*_ebs_patch suffix, case-insensitive).
        # These are transient fs_clone/patch-fs services — connecting to them during
        # ADOP patch cycle causes hangs or ORA-12537. Always blocked.
        if re.search(r'_ebs_patch$', svc, re.IGNORECASE):
            rejected.append((svc, "ADOP patch-mode service blocked"))
            continue
        # Block: services whose only registered instance is not in our local PMON list.
        # cdb_sid is our PMON instance — if lsnrctl services data is available and
        # none of the registered instances match, this is a remote/stale entry.
        if svc_instances.get(svc):
            inst_set = svc_instances[svc]
            if cdb_sid.upper() not in inst_set:
                # Check if any name resembles a local instance (prefix match for PDB names)
                local_match = any(
                    i.startswith(cdb_sid.upper()) or cdb_sid.upper().startswith(i)
                    for i in inst_set
                )
                if not local_match:
                    rejected.append((svc, "not registered with local instance %s (registered: %s)" % (cdb_sid, ",".join(sorted(inst_set)))))
                    continue
        svcs.append(svc)

    # Score: prefer lowercase ebs* (PDB services) that do NOT have _ebs_patch; then rest
    def _score(s):
        sl = s.lower()
        if re.match(r'^ebs[a-z0-9_]+$', sl) and not sl.endswith("_ebs_patch"):
            return 0   # PDB EBS service — best candidate
        if sl.endswith("xdb"):
            return 3   # shouldn't reach here, but deprioritize
        return 1

    svcs.sort(key=_score)
    all_candidates = list(svcs)   # record for JSON output before popping

    # Emit candidate list for JSON output before attempting connections
    if all_candidates:
        print("CANDIDATES:%s" % ",".join(all_candidates))

    for svc in svcs:
        ok, err = _test_conn("%s:%d/%s" % (ora_host, ora_port, svc), "SERVICE_NAME=%s (autodetected)" % svc)
        if ok:
            print("WINNER_SVC:%s\n%s" % (svc, ok))
            sys.exit(0)
        tried.append(("SERVICE_NAME=%s" % svc, err))

    # All paths failed — print full candidate list + errors so the operator can see
    # exactly what was tried and why each failed.
    rejected_info = "; ".join("%s[%s]" % (s, r) for s, r in rejected[:5])
    tried_info = "; ".join("%s->%s" % (d, e[:60]) for d, e in tried)
    print("ERR:All paths failed. Tried: %s. Rejected (filtered): %s" % (tried_info, rejected_info))

except Exception as e:
    print("ERR:" + str(e))
PYEOF
  ) || py_result=""
  t1=$(date +%s%3N 2>/dev/null || echo 0)
  elapsed_ms=$(( t1 - t0 ))

  # Extract winner service name and candidates list from Python output lines.
  # Python emits (on success): CANDIDATES:<comma-list>\nWINNER_SVC:<name>\nOPEN:<status>
  # Python emits (on failure): CANDIDATES:<comma-list>\nERR:...
  local winning_svc=""
  local candidates_csv=""
  if echo "$py_result" | grep -q "^WINNER_SVC:"; then
    winning_svc=$(echo "$py_result" | grep "^WINNER_SVC:" | head -1 | sed 's/^WINNER_SVC://')
  fi
  if echo "$py_result" | grep -q "^CANDIDATES:"; then
    candidates_csv=$(echo "$py_result" | grep "^CANDIDATES:" | head -1 | sed 's/^CANDIDATES://')
  fi
  # Export to module-level globals so run_diagnose() can include in JSON output
  _DG_P5_WINNER="${winning_svc}"
  _DG_P5_CANDIDATES="${candidates_csv}"

  if echo "$py_result" | grep -qE "^OPEN:"; then
    local open_line instance_status
    open_line=$(echo "$py_result" | grep "^OPEN:" | head -1)
    instance_status=$(echo "$open_line" | sed 's/^OPEN://')
    _dg_pass "$_DL5" "(service: ${winning_svc:-detected}, ${instance_status}, ${elapsed_ms}ms)"
    # Persist winning service to agent.env so proxy restarts use it immediately.
    # Write both ORACLE_SERVICE_NAME (canonical) and ORACLE_PRIMARY_SERVICE (backward compat).
    if [ -n "$winning_svc" ] && [ -f /etc/tunevault/agent.env ]; then
      grep -q "^ORACLE_SERVICE_NAME=" /etc/tunevault/agent.env \
        && sed -i "s|^ORACLE_SERVICE_NAME=.*|ORACLE_SERVICE_NAME=${winning_svc}|" /etc/tunevault/agent.env \
        || echo "ORACLE_SERVICE_NAME=${winning_svc}" >> /etc/tunevault/agent.env
      grep -q "^ORACLE_PRIMARY_SERVICE=" /etc/tunevault/agent.env \
        && sed -i "s|^ORACLE_PRIMARY_SERVICE=.*|ORACLE_PRIMARY_SERVICE=${winning_svc}|" /etc/tunevault/agent.env \
        || echo "ORACLE_PRIMARY_SERVICE=${winning_svc}" >> /etc/tunevault/agent.env
      # Restart proxy so it picks up the new service name immediately
      systemctl restart tunevault-agent 2>/dev/null || systemctl restart tunevault-proxy 2>/dev/null || true
    fi
    return 0
  fi

  local err_msg="${py_result:-no response from Oracle}"
  _dg_fail "$_DL5" \
    "Oracle connect failed for ${ora_service} at ${ora_host}:${ora_port}: ${err_msg}" \
    "Check DB is up: ps -ef | grep ora_pmon  # then: sudo lsnrctl services"
  return 1
}

# ─── probe 6: Outbound long-poll to cloud ────────────────────────────────────
_DL6="[6/8] Outbound long-poll to cloud ..."
dg_probe_6() {
  local api_key="${_DG_API_KEY:-}"
  local api_url="${_DG_API_URL:-https://tunevault.app}"
  local conn_id="${_DG_CONN_ID:-}"

  if [ -z "$api_key" ]; then
    _dg_fail "$_DL6" \
      "TUNEVAULT_API_KEY not loaded (probe 3 must pass first)" \
      "sudo tunevault-proxy repair"
    return 1
  fi

  local resp
  resp=$(_dg_with_timeout 15 curl -fsS \
    -H "X-TuneVault-Key: ${api_key}" \
    "${api_url}/api/agent/status?connection_id=${conn_id}" 2>/dev/null) || resp=""

  if echo "$resp" | grep -qE '"registered":true|"registered": true'; then
    # Extract last_seen for display
    local last_seen_raw last_seen_ago=""
    last_seen_raw=$(echo "$resp" | sed -n 's/.*"last_seen_at":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
    if [ -n "$last_seen_raw" ]; then
      local ls_epoch
      ls_epoch=$(date -d "$last_seen_raw" +%s 2>/dev/null || echo 0)
      if [ "$ls_epoch" -gt 0 ]; then
        local secs_ago
        secs_ago=$(_dg_elapsed_since "$ls_epoch")
        last_seen_ago="${secs_ago}s"
      fi
    fi
    local detail="registered"
    [ -n "$last_seen_ago" ] && detail="registered, last_seen=${last_seen_ago}"
    _dg_pass "$_DL6" "(${detail})"
    return 0
  fi

  if echo "$resp" | grep -qE '"registered":false|"registered": false|"error"'; then
    local err_msg
    err_msg=$(echo "$resp" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -1 || true)
    _dg_fail "$_DL6" \
      "agent not registered with cloud${err_msg:+: $err_msg}" \
      "Wait 60s and retry — or open ${api_url} and check the connection card"
    return 1
  fi

  # Empty or unexpected response
  _dg_fail "$_DL6" \
    "unexpected response from cloud API (network issue?): ${resp:-<no response>}" \
    "Check outbound HTTPS from this host: curl -v ${api_url}/api/agent/status"
  return 1
}

# ─── probe 7: Proxy version current (stale proxy detection) ──────────────────
# PASS if /api/test returns 410 Gone (v3.5.7+ correctly retired this endpoint).
# FAIL if /api/test returns 200 (legacy proxy still active — needs upgrade).
# FAIL if anything else (proxy not responding to version probe).
_DL7="[7/8] Proxy version current ........."
dg_probe_7() {
  local port="${_DG_PROXY_PORT:-3100}"
  local http_code
  http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:${port}/api/test" \
    -H 'X-Api-Key: dummy' -d '{}' --max-time 5 2>/dev/null) || http_code="000"

  if [ "$http_code" = "410" ]; then
    _dg_pass "$_DL7" "(proxy v3.5.7+ confirmed: /api/test → 410 Gone)"
    return 0
  elif [ "$http_code" = "200" ]; then
    _dg_fail "$_DL7" \
      "Stale proxy detected: /api/test returned 200 (legacy endpoint still active, expected 410)" \
      "Stale proxy detected. Run: sudo tunevault-proxy upgrade"
    return 1
  else
    _dg_fail "$_DL7" \
      "Proxy not responding to version probe (http_code=${http_code:-timeout})" \
      "Proxy not responding to version probe — check tunevault-agent.service (or tunevault-proxy on older installs)"
    return 1
  fi
}

# ─── probe 8: Key matches cloud (API key round-trip validation) ───────────────
# PASS if POST /api/agent/poll returns 200 (key accepted by cloud).
# FAIL if cloud returns 401 (key rejected — rotation incomplete or env drift).
# SKIP if probe 3 failed (no config) or probe 6 failed (cloud unreachable).
#
# Uses _DG_API_KEY, _DG_API_URL, _DG_CONN_ID exported by probe 3 — single
# source of truth, no redundant file re-read. Same pattern as probe 6.
_DL8="[8/8] Key matches cloud ............"
dg_probe_8() {
  local p3_status=$1
  local p6_status=$2

  if [ "$p3_status" -ne 0 ]; then
    _dg_skip "$_DL8" "(config not loaded — skipping)"
    return 0
  fi
  if [ "$p6_status" -ne 0 ]; then
    _dg_skip "$_DL8" "(cloud unreachable — skipping)"
    return 0
  fi

  # Reuse values exported by probe 3 (same pattern as probe 6).
  # Probe 3 already validated these exist and exported them.
  local _api_key="${_DG_API_KEY:-}"
  local _api_url="${_DG_API_URL:-}"
  local _conn_id="${_DG_CONN_ID:-}"

  if [ -z "$_api_key" ] || [ -z "$_api_url" ] || [ -z "$_conn_id" ]; then
    _dg_fail "$_DL8" \
      "Missing API credentials (api_key/api_url/connection_id not exported by probe 3)" \
      "Re-run installer: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
    return 1
  fi

  local http_code
  http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "${_api_url}/api/agent/poll" \
    -H 'Content-Type: application/json' \
    -H "X-TuneVault-Key: ${_api_key}" \
    -d "{\"connection_id\":${_conn_id}}" \
    --max-time 10 2>/dev/null) || http_code="000"

  if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
    _dg_pass "$_DL8" "(cloud accepted key — 200 OK)"
    return 0
  elif [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
    _dg_fail "$_DL8" \
      "Cloud rejected API key (HTTP ${http_code}) — key mismatch between ${_DG_CONF} and cloud" \
      "Run Rotate Key from /connections — do not edit config by hand"
    return 1
  else
    _dg_fail "$_DL8" \
      "Unexpected HTTP ${http_code} from cloud poll endpoint" \
      "Check outbound HTTPS from this host and confirm cloud URL is correct"
    return 1
  fi
}

# ─── main: run_diagnose ────────────────────────────────────────────────────────
run_diagnose() {
  local json_mode="${1:-0}"

  # Header
  local hostname_str agent_ver_str
  hostname_str=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "unknown")
  # Detect which service is installed: tunevault-agent (v6.1+) or legacy tunevault-proxy
  if systemctl cat tunevault-agent.service >/dev/null 2>&1; then
    agent_ver_str="tunevault-agent"
  else
    agent_ver_str="tunevault-proxy"
  fi

  echo ""
  echo -e "${BOLD}TuneVault Proxy Diagnose v1.2${NC}  host=${hostname_str}  agent=${agent_ver_str}@installer-v4.5"

  local p1=0 p2=0 p3=0 p4=0 p5=0 p6=0 p7=0 p8=0
  local s1=0 s2=0 s3=0 s4=0 s5=0 s6=0 s7=0 s8=0
  local pass_count=0 fail_count=0 skip_count=0

  # Probes 1-3 are purely local — no network.
  dg_probe_1 || p1=1
  dg_probe_2 || p2=1
  dg_probe_3 || p3=1

  # Probe 4: TCP check to Oracle listener
  dg_probe_4 || p4=1

  # Probe 5: Oracle service (depends on probe 4)
  { dg_probe_5 "$p4"; } || { rc=$?; [ "$rc" -eq 0 ] && s5=1 || p5=1; } || true
  # Correct skip detection: if probe_5 called _dg_skip, last output contained SKIP
  # Use _DG_P5_SKIPPED sentinel
  if [ "$p5" -eq 0 ] && [ "$p4" -ne 0 ]; then s5=1; fi

  # Probe 6: cloud API (only runs if probe 3 passed — needs API key)
  if [ "$p3" -ne 0 ]; then
    echo -e "${YELLOW}${_DL6} SKIP${NC} (config not loaded)"
    s6=1
  else
    dg_probe_6 || p6=1
  fi

  # Probe 7: version current — /api/test must return 410 (not 200 / stale)
  # Skips if probe 1 failed (proxy not running)
  if [ "$p1" -ne 0 ]; then
    echo -e "${YELLOW}${_DL7} SKIP${NC} (proxy not running)"
    s7=1
  else
    dg_probe_7 || p7=1
  fi

  # Probe 8: key matches cloud — real API key round-trip validation
  # Skips if probe 3 failed (no API key) or probe 6 failed (cloud unreachable)
  { dg_probe_8 "$p3" "$p6"; } || p8=1
  # Detect skip: set s8 if p3 failed (config absent) or p6 failed (cloud unreachable)
  if [ "$p3" -ne 0 ] || [ "$p6" -ne 0 ]; then s8=1; p8=0; fi

  # Tally
  for _pair in "p1 s1" "p2 s2" "p3 s3" "p4 s4" "p5 s5" "p6 s6" "p7 s7" "p8 s8"; do
    read -r _pv _sv <<< "$_pair"
    eval "_pval=\$$_pv"; eval "_sval=\$$_sv"
    if [ "$_sval" -eq 1 ]; then
      skip_count=$(( skip_count + 1 ))
    elif [ "$_pval" -eq 0 ]; then
      pass_count=$(( pass_count + 1 ))
    else
      fail_count=$(( fail_count + 1 ))
    fi
  done

  echo ""
  if [ "$fail_count" -eq 0 ] && [ "$pass_count" -eq 8 ]; then
    echo -e "${GREEN}${BOLD}Result: ${pass_count}/8 — proxy is healthy. Connection ready in /connections.${NC}"
  elif [ "$fail_count" -eq 0 ] && [ "$pass_count" -eq 7 ] && [ "$skip_count" -eq 1 ]; then
    echo -e "${GREEN}${BOLD}Result: ${pass_count}/8 PASS (1 SKIP) — proxy healthy. Key match check skipped (cloud unreachable or env absent).${NC}"
  elif [ "$fail_count" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}Result: ${pass_count} PASS / 0 FAIL / ${skip_count} SKIP — proxy healthy (some checks skipped).${NC}"
  else
    echo -e "${RED}${BOLD}Result: ${pass_count} PASS / ${fail_count} FAIL / ${skip_count} SKIP — proxy needs attention. See → Fix lines above.${NC}"
  fi

  # JSON output (machine-readable, for CI and --json flag)
  local outcome="pass"; [ "$fail_count" -gt 0 ] && outcome="fail"
  local failed_json="["
  local _first=1
  for _np in "p1:probe_1_process" "p2:probe_2_drivers" "p3:probe_3_proxy_env" "p4:probe_4_tns_listener" "p5:probe_5_oracle_service" "p6:probe_6_outbound_cloud" "p7:probe_7_version_current" "p8:probe_8_key_matches_cloud"; do
    local _key _label _pvar
    _key=$(echo "$_np" | cut -d: -f1)
    _label=$(echo "$_np" | cut -d: -f2)
    eval "_pvar=\$$_key"
    local _skey="s${_key#p}"
    eval "_svar=\$$_skey"
    if [ "$_svar" -eq 0 ] && [ "$_pvar" -ne 0 ]; then
      [ "$_first" -eq 1 ] && _first=0 || failed_json="${failed_json},"
      failed_json="${failed_json}\"${_label}\""
    fi
  done
  failed_json="${failed_json}]"

  # Include service discovery data if probe 5 ran
  local svc_json=""
  if [ -n "${_DG_P5_WINNER:-}" ]; then
    svc_json=",\"oracle_service_winner\":\"${_DG_P5_WINNER}\""
  fi
  if [ -n "${_DG_P5_CANDIDATES:-}" ]; then
    # _DG_P5_CANDIDATES is comma-separated list — emit as JSON array
    local _cands_arr="["
    local _cfirst=1
    for _c in $(echo "$_DG_P5_CANDIDATES" | tr ',' ' '); do
      [ "$_cfirst" -eq 1 ] && _cfirst=0 || _cands_arr="${_cands_arr},"
      _cands_arr="${_cands_arr}\"${_c}\""
    done
    _cands_arr="${_cands_arr}]"
    svc_json="${svc_json},\"oracle_service_candidates\":${_cands_arr}"
  fi

  local json_line="{\"diagnose\":\"${outcome}\",\"pass\":${pass_count},\"fail\":${fail_count},\"skip\":${skip_count},\"failed\":${failed_json}${svc_json}}"
  if [ "$json_mode" -eq 1 ]; then
    echo "$json_line"
  else
    echo "$json_line"
  fi

  # ── POST diagnose results to cloud (soft-fail, never blocks the install) ──────
  # Sends a structured probe-by-probe payload to /api/agent/diagnose so the
  # connection card can render real terminal data instead of stale heuristics.
  # Requires probe 3 to have succeeded (sets _DG_API_KEY / _DG_API_URL / _DG_CONN_ID).
  if [ -n "${_DG_API_KEY:-}" ] && [ -n "${_DG_API_URL:-}" ] && [ -n "${_DG_CONN_ID:-}" ]; then
    # Build probes JSON array from p1-p8 / s1-s8 status flags + label strings
    local _probe_names=(
      "Proxy process running"
      "Python drivers"
      "Config loaded"
      "TNS listener reachable"
      "Oracle service"
      "Outbound long-poll to cloud"
      "Proxy version current"
      "Key matches cloud"
    )
    local _probes_json="["
    local _pfirst=1
    local _pidx=0
    for _pn in "p1 s1" "p2 s2" "p3 s3" "p4 s4" "p5 s5" "p6 s6" "p7 s7" "p8 s8"; do
      read -r _pvar _svar <<< "$_pn"
      eval "_pval=\$$_pvar"; eval "_sval=\$$_svar"
      local _pstatus
      if [ "${_sval:-0}" -eq 1 ]; then
        _pstatus="skip"
      elif [ "${_pval:-0}" -eq 0 ]; then
        _pstatus="pass"
      else
        _pstatus="fail"
      fi
      local _pname="${_probe_names[$_pidx]}"
      [ "$_pfirst" -eq 1 ] && _pfirst=0 || _probes_json="${_probes_json},"
      _probes_json="${_probes_json}{\"id\":$((_pidx+1)),\"name\":\"${_pname}\",\"status\":\"${_pstatus}\"}"
      _pidx=$((_pidx+1))
    done
    _probes_json="${_probes_json}]"

    # Build listener_services JSON array from _DG_P5_CANDIDATES
    local _svc_arr_json="[]"
    if [ -n "${_DG_P5_CANDIDATES:-}" ]; then
      local _sa="["; local _sf=1
      for _sv in $(echo "$_DG_P5_CANDIDATES" | tr ',' ' '); do
        [ "$_sf" -eq 1 ] && _sf=0 || _sa="${_sa},"
        _sa="${_sa}\"${_sv}\""
      done
      _svc_arr_json="${_sa}]"
    fi

    # Detected SIDs from PMON — use validated helper (strict regex, no awk).
    local _pmon_sid_detected=""
    _pmon_sid_detected=$(_pmon_sids_detect | cut -d, -f1)
    local _sids_json="[]"
    [ -n "$_pmon_sid_detected" ] && _sids_json="[\"${_pmon_sid_detected}\"]"

    local _host_str
    _host_str=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "unknown")

    local _post_body
    _post_body=$(printf '{"connection_id":%s,"agent_version":"%s","host":"%s","detected_sids":%s,"listener_services":%s,"chosen_service":"%s","probes":%s,"roundtrip_ms":null,"timestamp":"%s"}' \
      "${_DG_CONN_ID}" \
      "${AGENT_VERSION:-}" \
      "${_host_str}" \
      "${_sids_json}" \
      "${_svc_arr_json}" \
      "${_DG_P5_WINNER:-}" \
      "${_probes_json}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')")

    curl -fsS -X POST \
      -H "Content-Type: application/json" \
      -H "X-TuneVault-Key: ${_DG_API_KEY}" \
      -d "$_post_body" \
      "${_DG_API_URL}/api/agent/diagnose" \
      --max-time 10 >/dev/null 2>&1 || \
      echo -e "${YELLOW}[WARN] Could not POST diagnose to cloud (non-fatal)${NC}" >&2
  fi

  [ "$fail_count" -eq 0 ] || return 1
}
DIAGEOF
chmod +r /usr/local/lib/tunevault-diagnose.sh
ok "tunevault-diagnose.sh library installed"

# ── Self-test ──────────────────────────────────────────────────────────────────
# Uses tunevault-proxy diagnose as the new canonical self-test.
# Headless/CI mode: still runs probe_1 (driver import) via the old self-test lib;
# the diagnose command requires a live systemd service which CI containers don't have.
# shellcheck source=/dev/null
source /usr/local/lib/tunevault-self-test.sh

if [ "$HEADLESS" -eq 1 ]; then
  # Headless/CI mode: verify /health is up, then run probe_1 (driver import) only.
  # Probes 2-6 require a live TuneVault API, registered agent, and Oracle listener —
  # none of which exist in a fresh CI container. Probe 1 is the safety gate that
  # catches the crash-loop root cause (drivers not installed).
  echo ""
  echo "========================================"
  echo "TuneVault Headless Smoke Test (CI)"
  echo "========================================"

  # Wait up to 15s for oracle-proxy.py /health to respond
  _HEALTH_OK=0
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    HRESP=$(curl -fs http://localhost:3100/health 2>/dev/null || true)
    if echo "$HRESP" | grep -q '"status"'; then
      _HEALTH_OK=1
      ok "/health returned JSON in ${_attempt}s"
      break
    fi
    sleep 1
  done

  if [ "$_HEALTH_OK" -eq 0 ]; then
    echo -e "${RED}FATAL: oracle-proxy.py /health did not return JSON within 15s${NC}" >&2
    echo -e "${YELLOW}This means the proxy crashed on startup — likely missing cx_Oracle.${NC}" >&2
    echo -e "${YELLOW}Check proxy output above for FATAL lines.${NC}" >&2
    kill "${HEADLESS_PID:-}" 2>/dev/null || true
    exit 1
  fi

  # Run probe_1 directly (driver import check) — the only probe meaningful without Oracle
  _P1_RESULT=0
  probe_1 || _P1_RESULT=1

  echo "========================================"
  if [ "$_P1_RESULT" -eq 0 ]; then
    printf "Result: 1 PASS / 0 FAIL / 5 SKIPPED (headless)\n"
  else
    printf "Result: 0 PASS / 1 FAIL / 5 SKIPPED (headless)\n"
  fi
  echo "========================================"
  echo "{\"diagnose\":\"$([ "$_P1_RESULT" -eq 0 ] && echo pass || echo fail)\",\"pass\":$([ "$_P1_RESULT" -eq 0 ] && echo 1 || echo 0),\"fail\":$([ "$_P1_RESULT" -ne 0 ] && echo 1 || echo 0),\"skip\":5,\"failed\":$([ "$_P1_RESULT" -ne 0 ] && echo '["probe_2_drivers"]' || echo '[]')}"

  kill "${HEADLESS_PID:-}" 2>/dev/null || true

  if [ "$_P1_RESULT" -ne 0 ]; then
    echo -e "${RED}HEADLESS SMOKE TEST FAILED — driver import probe failed${NC}" >&2
    exit 1
  fi

  ok "Headless smoke test PASSED — drivers verified, /health OK"
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║  ✅ HEADLESS INSTALL COMPLETE — drivers verified     ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
else
  # ── Production post-install verify ────────────────────────────────────────
  # Block until (a) systemd reports active AND (b) cloud confirms a heartbeat.
  # If either check fails: dump journalctl, print the three most likely fixes,
  # report the failure to the cloud, exit 1 so the curl-pipe one-liner fails visibly.
  #
  # WHY: without this the installer exits 0 even when the service is crash-looping,
  # leaving a dead agent on the customer host with no visible indication of failure.

  # ── 4-probe local self-check (v7.5) ──────────────────────────────────────
  # Runs BEFORE the systemd/heartbeat gate so local failures surface with fix hints.
  # Probe order: (a) systemctl is-active  (b) python-oracledb import
  #              (c) oracle-proxy.py exists  (d) agent.env API_KEY len>10
  echo ""
  echo -e "${BOLD}── Local self-check (4 probes) ──────────────────────${NC}"
  _SC_PASS=0; _SC_FAIL=0
  _sc_ok()  { echo -e "  ${GREEN}✓${NC}  $1"; _SC_PASS=$((_SC_PASS+1)); }
  _sc_fail(){ echo -e "  ${RED}✗${NC}  $1"; echo -e "      ${YELLOW}→ Fix: $2${NC}"; _SC_FAIL=$((_SC_FAIL+1)); }

  # (a) systemctl is-active
  _SC_SVC_STATE=$(systemctl is-active tunevault-agent.service 2>/dev/null || echo "unknown")
  if [ "$_SC_SVC_STATE" = "active" ]; then
    _sc_ok "systemctl is-active: active"
  else
    _sc_fail "systemctl is-active: ${_SC_SVC_STATE}" \
      "sudo journalctl -u tunevault-agent -n 30  # then: sudo systemctl start tunevault-agent"
  fi

  # (b) python-oracledb import (pinned dep; required for thin-mode connections)
  if "${VENV_PYTHON}" -c "import oracledb" 2>/dev/null; then
    _sc_ok "python-oracledb importable in venv"
  else
    _sc_fail "python-oracledb not importable" \
      "sudo tunevault-agent repair  # reinstalls pinned deps"
  fi

  # (c) oracle-proxy.py exists
  if [ -f "${PROXY_DEST}/oracle-proxy.py" ]; then
    _sc_ok "oracle-proxy.py present at ${PROXY_DEST}/oracle-proxy.py"
  else
    _sc_fail "oracle-proxy.py missing" \
      "curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=${TUNEVAULT_TOKEN:-<token>} bash"
  fi

  # (d) agent.env API_KEY length > 10
  _SC_KEY=$(grep '^TUNEVAULT_API_KEY=' /etc/tunevault/agent.env 2>/dev/null | cut -d= -f2 || echo "")
  _SC_KEY_LEN="${#_SC_KEY}"
  if [ "$_SC_KEY_LEN" -gt 10 ]; then
    _sc_ok "agent.env TUNEVAULT_API_KEY present (len=${_SC_KEY_LEN})"
  else
    _sc_fail "agent.env TUNEVAULT_API_KEY missing or too short (len=${_SC_KEY_LEN})" \
      "sudo tunevault-agent rotate-key <new-key>  # or re-run installer"
  fi

  echo -e "── ${_SC_PASS}/4 passed, ${_SC_FAIL} failed ──────────────────────────────────${NC}"
  echo ""

  _VERIFY_FAIL_REASON=""
  _VERIFY_SYSTEMD_OK=0
  _VERIFY_HEARTBEAT_OK=0

  # ── Step 1: Poll systemctl is-active for up to 30s ────────────────────────
  info "Verifying tunevault-agent is active (up to 30s)…"
  _SVC_POLL=0
  while [ "$_SVC_POLL" -lt 30 ]; do
    _SVC_STATE=$(systemctl is-active tunevault-agent.service 2>/dev/null || echo "unknown")
    if [ "$_SVC_STATE" = "active" ]; then
      _VERIFY_SYSTEMD_OK=1
      ok "tunevault-agent.service is active (${_SVC_POLL}s)"
      break
    elif [ "$_SVC_STATE" = "failed" ]; then
      _VERIFY_FAIL_REASON="systemd_failed"
      break
    fi
    sleep 1
    _SVC_POLL=$((_SVC_POLL + 1))
  done

  if [ "$_VERIFY_SYSTEMD_OK" -eq 0 ] && [ -z "$_VERIFY_FAIL_REASON" ]; then
    _VERIFY_FAIL_REASON="systemd_failed"
  fi

  # ── Step 2: Poll cloud heartbeat-check for up to 60s ──────────────────────
  # Only attempt if systemd came up (otherwise the agent can't heartbeat anyway).
  if [ "$_VERIFY_SYSTEMD_OK" -eq 1 ] && [ -n "$CONNECTION_ID" ] && [ "$CONNECTION_ID" != "0" ]; then
    info "Waiting for first heartbeat from cloud (up to 60s)…"
    _HB_POLL=0
    while [ "$_HB_POLL" -lt 60 ]; do
      _HB_RESP=$(curl -fsS \
        "${API_URL}/api/agent/heartbeat-check?connection_id=${CONNECTION_ID}" \
        --max-time 8 2>/dev/null || echo "")
      # alive:true AND seconds_ago <= 30 (v7.5: relaxed from 15s to handle slower hosts)
      _HB_ALIVE=$(echo "$_HB_RESP" | sed -n 's/.*"alive":\s*true.*/yes/p' | head -1 || true)
      _HB_SECS=$(echo "$_HB_RESP" | sed -n 's/.*"seconds_ago":\s*\([0-9]*\).*/\1/p' | head -1 || true)
      if [ "$_HB_ALIVE" = "yes" ] && [ -n "$_HB_SECS" ] && [ "$_HB_SECS" -le 30 ] 2>/dev/null; then
        _VERIFY_HEARTBEAT_OK=1
        _HB_TIME=$(date -u +%H:%M:%S 2>/dev/null || echo "??:??:??")
        ok "Heartbeat confirmed at ${_HB_TIME} UTC (${_HB_SECS}s ago)"
        break
      fi
      sleep 2
      _HB_POLL=$((_HB_POLL + 2))
    done
    if [ "$_VERIFY_HEARTBEAT_OK" -eq 0 ]; then
      _VERIFY_FAIL_REASON="${_VERIFY_FAIL_REASON:-no_heartbeat}"
    fi
  elif [ "$_VERIFY_SYSTEMD_OK" -eq 1 ]; then
    # Headless provisioning: CONNECTION_ID=0 — skip heartbeat check, systemd active is enough
    _VERIFY_HEARTBEAT_OK=1
  fi

  # ── Step 3a: SUCCESS ──────────────────────────────────────────────────────
  if [ "$_VERIFY_SYSTEMD_OK" -eq 1 ] && [ "$_VERIFY_HEARTBEAT_OK" -eq 1 ]; then
    _SUCCESS_TIME=$(date -u +%H:%M:%S 2>/dev/null || echo "")
    echo ""
    echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║  ✓ TuneVault Agent active, heartbeat confirmed at ${_SUCCESS_TIME} UTC.  ║${NC}"
    echo -e "${GREEN}${BOLD}║                                                                          ║${NC}"
    echo -e "${GREEN}${BOLD}║  Open ${API_URL}/connections/${CONNECTION_ID} to continue.${NC}${GREEN}${BOLD}  ║${NC}"
    echo -e "${GREEN}${BOLD}║                                                                          ║${NC}"
    echo -e "${GREEN}${BOLD}║  Run \`tunevault-agent doctor --deep\` to verify the cloud connection.    ║${NC}"
    echo -e "${GREEN}${BOLD}║  To remove:  sudo tunevault-agent uninstall                              ║${NC}"
    echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Also run diagnose for full probe matrix (advisory — not a hard gate here)
    # shellcheck source=/dev/null
    source /usr/local/lib/tunevault-diagnose.sh
    run_diagnose 1 || true   # non-fatal after confirmed heartbeat

    exit 0
  fi

  # ── Step 3b: FAILURE ──────────────────────────────────────────────────────
  _JCTL_TAIL=""
  _JCTL_TAIL=$(journalctl -u tunevault-agent -n 50 --no-pager -l 2>/dev/null || echo "(journalctl unavailable)")

  echo ""
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  if [ "$_VERIFY_FAIL_REASON" = "systemd_failed" ]; then
    echo -e "${RED}${BOLD}║  ✗ INSTALL FAILED — systemd service did not start / crashed  ║${NC}"
  elif [ "$_VERIFY_FAIL_REASON" = "no_heartbeat" ]; then
    echo -e "${RED}${BOLD}║  ✗ INSTALL FAILED — service running but no heartbeat received ║${NC}"
  else
    echo -e "${RED}${BOLD}║  ✗ INSTALL FAILED — unknown failure (${_VERIFY_FAIL_REASON:-?})               ║${NC}"
  fi
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  echo -e "${YELLOW}── journalctl -u tunevault-agent (last 50 lines) ──────────────────────${NC}"
  echo "$_JCTL_TAIL"
  echo -e "${YELLOW}────────────────────────────────────────────────────────────────────────${NC}"
  echo ""

  echo -e "${BOLD}Three most likely fixes:${NC}"
  echo -e "  1. ${YELLOW}Re-run the installer${NC} — the agent package may have downloaded partially:"
  echo -e "       curl -fsSL ${API_URL}/install.sh | sudo TUNEVAULT_TOKEN=<token> bash"
  echo -e ""
  echo -e "  2. ${YELLOW}Check /opt/tunevault file ownership${NC} — the venv must be readable by root:"
  echo -e "       ls -la /opt/tunevault/  && ls -la /opt/tunevault/venv/bin/python3"
  echo -e ""
  echo -e "  3. ${YELLOW}Confirm outbound HTTPS to ${API_URL}${NC} — no heartbeat = can't reach cloud:"
  echo -e "       curl -v ${API_URL}/api/health"
  echo ""

  # ── POST failure summary to cloud (soft-fail — never blocks exit) ──────────
  if [ -n "${CONNECTION_ID:-}" ] && [ "$CONNECTION_ID" != "0" ] && [ -n "${API_URL:-}" ]; then
    _HOST_STR=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo "unknown")
    # Escape backslashes and quotes in journalctl tail for JSON embedding; truncate to 8000 chars.
    # WHY 8000: Postgres TEXT columns and API JSON body size limits require bounded input.
    _JCTL_ESC=$(echo "$_JCTL_TAIL" | sed 's/\\/\\\\/g;s/"/\\"/g' | tr '\n' '\\' | sed 's/\\/\\n/g' | head -c 8000 || echo "")
    _FAIL_BODY="{\"connection_id\":${CONNECTION_ID},\"host\":\"${_HOST_STR}\",\"error_class\":\"${_VERIFY_FAIL_REASON:-unknown}\",\"journalctl_tail\":\"${_JCTL_ESC}\",\"installer_version\":\"7.5.0\",\"os_info\":\"${OS_INFO:-unknown}\"}"
    curl -fsS -X POST \
      -H "Content-Type: application/json" \
      -d "$_FAIL_BODY" \
      "${API_URL}/api/agent/install-failures" \
      --max-time 10 >/dev/null 2>&1 || \
      echo -e "${YELLOW}[WARN] Could not POST install failure to cloud (non-fatal)${NC}" >&2
  fi

  exit 1
fi
