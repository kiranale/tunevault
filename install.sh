#!/usr/bin/env bash
# TuneVault Agent Installer v8.0
# Usage: curl -fsSL https://tunevault.app/install.sh | sudo TUNEVAULT_TOKEN=<token> bash
#
# What this does — exactly this, nothing else:
#   1. Auto-detect OS (OEL/RHEL 7/8/9, Amazon Linux 2/2023, Ubuntu/Debian)
#   2. Auto-disable broken repos (ngrok, cloudflare, OCI-hosted repos in private labs)
#   3. Auto-install Python 3.8+ if not present — silently, right method per OS
#   4. Provision with cloud (get API key + connection ID)
#   5. Create /opt/tunevault/venv + install python-oracledb thin mode
#   6. Download oracle-proxy.py
#   7. Write /etc/tunevault/agent.env
#   8. Install + start tunevault-agent.service
#   9. Wait for service + heartbeat
#  10. Run 4-probe self-check

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
info() { echo -e "${YELLOW}[..]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WN]${NC}  $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

# ── Mode flags ────────────────────────────────────────────────────────────────
UPGRADE_ONLY=0
HEADLESS=0
for arg in "$@"; do
  [ "$arg" = "--upgrade"  ] && UPGRADE_ONLY=1
  [ "$arg" = "--headless" ] && HEADLESS=1
done

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    TuneVault Agent Installer v8.0        ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Root check ────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || err "Run as root:  curl ... | sudo TUNEVAULT_TOKEN=xxx bash"

# ── API URL ───────────────────────────────────────────────────────────────────
API="${TUNEVAULT_API:-https://tunevault.app}"  # Will be overridden by provisioning response

# ── Token check ───────────────────────────────────────────────────────────────
if [ "$UPGRADE_ONLY" -eq 0 ] && [ "$HEADLESS" -eq 0 ]; then
  [ -n "${TUNEVAULT_TOKEN:-}" ] || err "TUNEVAULT_TOKEN not set. Get the install command from the TuneVault UI."
fi

# ── Paths (single source of truth) ───────────────────────────────────────────
INSTALL_DIR="/opt/tunevault"
VENV_DIR="${INSTALL_DIR}/venv"
VENV_PYTHON="${VENV_DIR}/bin/python3"
VENV_PIP="${VENV_DIR}/bin/pip"
PROXY_SCRIPT="${INSTALL_DIR}/oracle-proxy.py"
ENV_FILE="/etc/tunevault/agent.env"
SERVICE_NAME="tunevault-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── OS detection ──────────────────────────────────────────────────────────────
info "Detecting OS..."
OS_ID=""
OS_VERSION_ID=""
OS_MAJOR=""
PKG_MGR="unknown"

if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-}"
  OS_VERSION_ID="${VERSION_ID:-}"
  OS_MAJOR="${VERSION_ID%%.*}"
fi

# Override with more specific detection
if [ -f /etc/oracle-release ]; then
  OS_ID="oracle"
  _ver=$(cat /etc/oracle-release | grep -oP '\d+\.\d+' | head -1 || echo "7")
  OS_MAJOR="${_ver%%.*}"
  PKG_MGR="yum"
elif [ -f /etc/redhat-release ]; then
  OS_ID="rhel"
  _ver=$(cat /etc/redhat-release | grep -oP '\d+\.\d+' | head -1 || echo "7")
  OS_MAJOR="${_ver%%.*}"
  PKG_MGR="yum"
elif [ -f /etc/system-release ] && grep -qi "amazon" /etc/system-release 2>/dev/null; then
  OS_ID="amzn"
  PKG_MGR="yum"
elif [ "${OS_ID}" = "ubuntu" ] || [ "${OS_ID}" = "debian" ]; then
  PKG_MGR="apt"
elif [ "${OS_ID}" = "rhel" ] || [ "${OS_ID}" = "centos" ] || \
     [ "${OS_ID}" = "rocky" ] || [ "${OS_ID}" = "almalinux" ] || \
     [ "${OS_ID}" = "fedora" ]; then
  PKG_MGR="yum"
fi

[ "$PKG_MGR" != "unknown" ] || err "Unsupported OS: ${OS_ID}. Supported: OEL/RHEL 7-9, Amazon Linux, Ubuntu 20+."

OS_DISPLAY="${PRETTY_NAME:-${OS_ID} ${OS_MAJOR}}"
ok "OS: ${OS_DISPLAY}  (id=${OS_ID} major=${OS_MAJOR} pkg=${PKG_MGR})"

# ── Auto-disable broken repos (silent — never block install) ──────────────────
info "Checking package repos..."

_disable_repo() {
  local repo="$1"
  if [ "$PKG_MGR" = "yum" ]; then
    yum-config-manager --disable "$repo" >/dev/null 2>&1 || true
  elif [ "$PKG_MGR" = "apt" ]; then
    true  # apt doesn't have the same concept
  fi
}

if [ "$PKG_MGR" = "yum" ]; then
  # Disable repos known to fail in private/lab environments
  # These are non-Oracle repos that break yum when they 404 or timeout
  for _broken_repo in ngrok cloudflare ol8_UEKR6 ol8_UEKR7; do
    _disable_repo "$_broken_repo"
  done

  # OCI-hosted repos time out in private labs — disable them
  # They use $ociregion/$ocidomain variables that resolve to unreachable hosts
  for _repo_file in /etc/yum.repos.d/*.repo; do
    [ -f "$_repo_file" ] || continue
    if grep -q 'oci.oraclecloud.com' "$_repo_file" 2>/dev/null; then
      _repo_id=$(grep '^\[' "$_repo_file" | tr -d '[]' | head -1)
      [ -n "$_repo_id" ] && _disable_repo "$_repo_id"
    fi
  done

  ok "Repo check done"
fi

# ── Auto-install Python 3.8+ ──────────────────────────────────────────────────
info "Checking Python 3.8+..."

# Find best available python3 binary
PYTHON3_BIN=""
for _py in python3.11 python3.10 python3.9 python3.8 python3; do
  _bin=$(command -v "$_py" 2>/dev/null || true)
  if [ -n "$_bin" ]; then
    _maj=$("$_bin" -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
    _min=$("$_bin" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
    if [ "$_maj" -eq 3 ] && [ "$_min" -ge 8 ]; then
      PYTHON3_BIN="$_bin"
      ok "Found Python ${_maj}.${_min} at ${_bin}"
      break
    fi
  fi
done

# Also check SCL path for OEL7 rh-python38
if [ -z "$PYTHON3_BIN" ] && [ -f /opt/rh/rh-python38/root/usr/bin/python3.8 ]; then
  # Make it accessible
  ln -sf /opt/rh/rh-python38/root/usr/bin/python3.8 /usr/local/bin/python3.8 2>/dev/null || true
  ln -sf /opt/rh/rh-python38/root/usr/bin/pip3.8 /usr/local/bin/pip3.8 2>/dev/null || true
  PYTHON3_BIN=/usr/local/bin/python3.8
  ok "Found SCL Python 3.8 → linked to /usr/local/bin/python3.8"
fi

# If still not found — auto-install
if [ -z "$PYTHON3_BIN" ]; then
  info "Python 3.8+ not found — installing automatically..."

  _py_installed=0

  if [ "$PKG_MGR" = "apt" ]; then
    # Ubuntu/Debian
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -q python3.8 python3.8-venv python3-pip 2>/dev/null && _py_installed=1 || true
    [ "$_py_installed" -eq 0 ] && \
      apt-get install -y -q python3 python3-venv python3-pip 2>/dev/null && _py_installed=1 || true

  elif [ "$OS_ID" = "oracle" ] || [ "$OS_ID" = "rhel" ] || \
       [ "$OS_ID" = "centos" ] || [ "$OS_ID" = "rocky" ] || [ "$OS_ID" = "almalinux" ]; then

    if [ "${OS_MAJOR}" = "8" ] || [ "${OS_MAJOR}" = "9" ]; then
      # OEL8/RHEL8/OEL9 — python38 or python39 in AppStream
      dnf install -y python38 --disablerepo="*oci*" --disablerepo="*UEKR*" \
        >/dev/null 2>&1 && _py_installed=1 || true
      [ "$_py_installed" -eq 0 ] && \
        dnf install -y python39 --disablerepo="*oci*" --disablerepo="*UEKR*" \
        >/dev/null 2>&1 && _py_installed=1 || true
      [ "$_py_installed" -eq 0 ] && \
        dnf install -y python3 --disablerepo="*oci*" --disablerepo="*UEKR*" \
        >/dev/null 2>&1 && _py_installed=1 || true

    elif [ "${OS_MAJOR}" = "7" ]; then
      # OEL7/RHEL7 — use SCL rh-python38
      yum install -y oracle-softwarecollection-release-el7 \
        --disablerepo=ngrok --disablerepo=cloudflare \
        >/dev/null 2>&1 || \
      yum install -y centos-release-scl \
        --disablerepo=ngrok --disablerepo=cloudflare \
        >/dev/null 2>&1 || true

      yum install -y rh-python38 \
        --disablerepo=ngrok --disablerepo=cloudflare \
        >/dev/null 2>&1 && _py_installed=1 || true

      if [ "$_py_installed" -eq 1 ]; then
        # Link SCL python into PATH
        ln -sf /opt/rh/rh-python38/root/usr/bin/python3.8 /usr/local/bin/python3.8 2>/dev/null || true
        ln -sf /opt/rh/rh-python38/root/usr/bin/pip3.8 /usr/local/bin/pip3.8 2>/dev/null || true
        # Also link scl libs so import works without scl enable
        _scl_lib="/opt/rh/rh-python38/root/usr/lib64"
        if [ -d "$_scl_lib" ]; then
          echo "$_scl_lib" > /etc/ld.so.conf.d/rh-python38.conf
          ldconfig 2>/dev/null || true
        fi
      fi
    fi

  elif [ "$OS_ID" = "amzn" ]; then
    # Amazon Linux 2
    amazon-linux-extras install -y python3.8 >/dev/null 2>&1 && _py_installed=1 || true
    # Amazon Linux 2023 — python3.11 available
    [ "$_py_installed" -eq 0 ] && \
      dnf install -y python3.11 >/dev/null 2>&1 && _py_installed=1 || true
    [ "$_py_installed" -eq 0 ] && \
      yum install -y python38 >/dev/null 2>&1 && _py_installed=1 || true
  fi

  # Last resort: compile from source (works on ANY Linux with gcc)
  if [ "$_py_installed" -eq 0 ]; then
    warn "Package install failed — compiling Python 3.8 from source (5-10 min)..."
    _build_deps="gcc openssl-devel bzip2-devel libffi-devel zlib-devel"
    if [ "$PKG_MGR" = "apt" ]; then
      _build_deps="gcc libssl-dev libbz2-dev libffi-dev zlib1g-dev"
      apt-get install -y -q $_build_deps 2>/dev/null || true
    else
      yum install -y $_build_deps \
        --disablerepo=ngrok --disablerepo=cloudflare \
        >/dev/null 2>&1 || true
    fi
    cd /tmp
    curl -fsSL https://www.python.org/ftp/python/3.8.18/Python-3.8.18.tgz -o Python-3.8.18.tgz \
      || err "Cannot download Python 3.8 source. Check internet connectivity."
    tar xzf Python-3.8.18.tgz
    cd Python-3.8.18
    ./configure --enable-optimizations --quiet 2>/dev/null
    make -j$(nproc) altinstall >/dev/null 2>&1
    cd /
    rm -rf /tmp/Python-3.8.18 /tmp/Python-3.8.18.tgz
    _py_installed=1
    ok "Python 3.8 compiled and installed"
  fi

  # Re-scan for python after install
  for _py in python3.11 python3.10 python3.9 python3.8 python3; do
    _bin=$(command -v "$_py" 2>/dev/null || true)
    if [ -n "$_bin" ]; then
      _maj=$("$_bin" -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
      _min=$("$_bin" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
      if [ "$_maj" -eq 3 ] && [ "$_min" -ge 8 ]; then
        PYTHON3_BIN="$_bin"
        ok "Python ${_maj}.${_min} ready at ${_bin}"
        break
      fi
    fi
  done

  [ -n "$PYTHON3_BIN" ] || err "Could not install Python 3.8+. Please install manually:
  OEL7:  yum install -y rh-python38 && ln -sf /opt/rh/rh-python38/root/usr/bin/python3.8 /usr/local/bin/python3.8
  OEL8:  dnf install -y python38
  Ubuntu: apt-get install -y python3.8"
fi

# ── Provision ─────────────────────────────────────────────────────────────────
if [ "$HEADLESS" -eq 1 ]; then
  info "Headless mode — using dummy credentials"
  API_KEY="headless-test-key"
  CONNECTION_ID="0"

elif [ "$UPGRADE_ONLY" -eq 1 ]; then
  [ -f "$ENV_FILE" ] || err "$ENV_FILE not found. Run fresh install first."
  source "$ENV_FILE"
  API_KEY="${TUNEVAULT_API_KEY:-}"
  CONNECTION_ID="${TUNEVAULT_CONNECTION_ID:-}"
  API="${TUNEVAULT_API_URL:-$API}"
  [ -n "$API_KEY" ]       || err "TUNEVAULT_API_KEY missing from $ENV_FILE"
  [ -n "$CONNECTION_ID" ] || err "TUNEVAULT_CONNECTION_ID missing from $ENV_FILE"
  ok "Upgrade mode — connection ID: $CONNECTION_ID"

else
  info "Provisioning with TuneVault..."
  PROVISION=$(curl -fsSL -X POST \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${TUNEVAULT_TOKEN}\"}" \
    "${API}/api/agent/provision") \
    || err "Cannot reach ${API}. Check network connectivity to the internet."

  _field() { echo "$1" | sed -n "s/.*\"$2\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
  _num()   { echo "$1" | sed -n "s/.*\"$2\":[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -1; }

  API_KEY=$(      _field "$PROVISION" "api_key")
  CONNECTION_ID=$(  _num "$PROVISION" "connection_id")
  API_URL_RESP=$(  _field "$PROVISION" "api_url")
  [ -n "$API_URL_RESP" ] && API="$API_URL_RESP"

  [ -n "$API_KEY"       ] || err "Provisioning failed — invalid token or server error.
  Response: $PROVISION"
  [ -n "$CONNECTION_ID" ] || err "Missing connection_id in provisioning response."
  ok "Provisioned — connection ID: $CONNECTION_ID"
fi

# ── Write agent.env ───────────────────────────────────────────────────────────
info "Writing config..."
mkdir -p /etc/tunevault
_INSTALLED_AT="$(grep '^INSTALLED_AT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
_INSTALLED_AT="${_INSTALLED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

cat > "$ENV_FILE" <<ENVEOF
TUNEVAULT_API_KEY=${API_KEY}
TUNEVAULT_API_URL=${API}
TUNEVAULT_CONNECTION_ID=${CONNECTION_ID}
VERSION=8.0.0
INSTALLED_AT=${_INSTALLED_AT}
ENVEOF
chmod 600 "$ENV_FILE"
ok "Config written to $ENV_FILE"

# ── Python venv ───────────────────────────────────────────────────────────────
info "Setting up Python venv at ${VENV_DIR}..."
mkdir -p "$INSTALL_DIR"

# Check if venv exists AND is using python3.8+
_VENV_NEEDS_REBUILD=0
if [ -f "$VENV_PYTHON" ]; then
  _VENV_MAJ=$("$VENV_PYTHON" -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
  _VENV_MIN=$("$VENV_PYTHON" -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
  if [ "$_VENV_MAJ" -lt 3 ] || { [ "$_VENV_MAJ" -eq 3 ] && [ "$_VENV_MIN" -lt 8 ]; }; then
    warn "venv uses Python ${_VENV_MAJ}.${_VENV_MIN} — rebuilding with Python 3.8+"
    _VENV_NEEDS_REBUILD=1
  else
    ok "venv exists with Python ${_VENV_MAJ}.${_VENV_MIN} — reusing"
  fi
fi

if [ ! -f "$VENV_PYTHON" ] || [ "$_VENV_NEEDS_REBUILD" -eq 1 ]; then
  if [ -f /opt/rh/rh-python38/root/usr/lib64/libpython3.8.so.1.0 ]; then
    export LD_LIBRARY_PATH="/opt/rh/rh-python38/root/usr/lib64:${LD_LIBRARY_PATH:-}"
  fi
  "$PYTHON3_BIN" -m venv "$VENV_DIR" --clear 2>/dev/null || {
    info "venv module missing — installing..."
    if [ "$PKG_MGR" = "apt" ]; then
      apt-get install -y -q python3-venv python3-pip 2>/dev/null || true
    else
      yum install -y python3-venv --disablerepo=ngrok --disablerepo=cloudflare \
        >/dev/null 2>&1 || true
    fi
    "$PYTHON3_BIN" -m venv "$VENV_DIR" --clear \
      || err "Cannot create venv. Try: $PYTHON3_BIN -m venv $VENV_DIR"
  }
  ok "venv created with $PYTHON3_BIN"
fi

# Ensure SCL libs are in venv's LD path for OEL7
if [ -f /opt/rh/rh-python38/root/usr/lib64/libpython3.8.so.1.0 ]; then
  echo "/opt/rh/rh-python38/root/usr/lib64" > /etc/ld.so.conf.d/rh-python38.conf
  ldconfig 2>/dev/null || true
fi

# Upgrade pip
"$VENV_PIP" install --quiet --upgrade pip 2>/dev/null || true

# ── Install Oracle thin driver ─────────────────────────────────────────────────
info "Installing python-oracledb (thin mode — no Oracle client needed)..."
"$VENV_PIP" install --quiet "python-oracledb>=2.3.0" 2>/dev/null \
  || "$VENV_PIP" install --quiet "oracledb" 2>/dev/null \
  || err "Failed to install python-oracledb. Check pip network access."

"$VENV_PYTHON" -c "import oracledb; print('oracledb', oracledb.__version__)" 2>/dev/null \
  || err "python-oracledb import failed after install."
ok "python-oracledb thin driver ready"

# ── Install other deps ─────────────────────────────────────────────────────────
info "Installing paramiko, requests, pyyaml..."
"$VENV_PIP" install --quiet "paramiko>=3.4.0" "requests>=2.31.0" "pyyaml>=6.0" 2>/dev/null || true

# ── Download oracle-proxy.py ───────────────────────────────────────────────────
info "Downloading oracle-proxy.py..."
curl -fsSL "${API}/downloads/oracle-proxy.py" -o "$PROXY_SCRIPT" \
  || err "Failed to download oracle-proxy.py from ${API}/downloads/oracle-proxy.py"
chmod +x "$PROXY_SCRIPT"
ok "oracle-proxy.py downloaded"

# ── Detect Oracle SIDs ────────────────────────────────────────────────────────
info "Detecting Oracle environment..."
ORACLE_SIDS=""

PMON_SIDS=$(ps -ef 2>/dev/null \
  | grep '[o]ra_pmon_' \
  | grep -o 'ora_pmon_[A-Za-z0-9_]*' \
  | sed 's/^ora_pmon_//' \
  | grep -E '^[A-Za-z0-9_]{1,30}$' \
  | sort -u | tr '\n' ',' | sed 's/,$//' || true)
[ -n "$PMON_SIDS" ] && ORACLE_SIDS="$PMON_SIDS" && ok "Oracle SIDs (PMON): $ORACLE_SIDS"

if [ -z "$ORACLE_SIDS" ] && [ -f /etc/oratab ]; then
  ORACLE_SIDS=$(grep -v '^#' /etc/oratab 2>/dev/null \
    | grep -v '^$' | grep -v '^\*' \
    | cut -d: -f1 | tr '\n' ',' | sed 's/,$//' || true)
  [ -n "$ORACLE_SIDS" ] && ok "Oracle SIDs (oratab): $ORACLE_SIDS"
fi

[ -z "$ORACLE_SIDS" ] && info "No Oracle SIDs detected — agent will auto-detect on first run"

# ── Install systemd service ────────────────────────────────────────────────────
if [ "$HEADLESS" -eq 0 ]; then
  info "Installing ${SERVICE_NAME}.service..."

  # Stop + disable any legacy service names
  for _old in tunevault-proxy tunevault-agent; do
    systemctl stop    "${_old}.service" 2>/dev/null || true
    systemctl disable "${_old}.service" 2>/dev/null || true
  done
  systemctl daemon-reload 2>/dev/null || true

  # For OEL7 SCL: write LD path into service env
  _LD_EXTRA=""
  if [ -f /opt/rh/rh-python38/root/usr/lib64/libpython3.8.so.1.0 ]; then
    _LD_EXTRA="Environment=LD_LIBRARY_PATH=/opt/rh/rh-python38/root/usr/lib64"
  fi

  cat > "$SERVICE_FILE" <<SVCEOF
[Unit]
Description=TuneVault Oracle Agent v8
After=network.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
${_LD_EXTRA}
ExecStart=${VENV_PYTHON} ${PROXY_SCRIPT}
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tunevault-agent
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" 2>/dev/null || true
  systemctl restart "$SERVICE_NAME" \
    || err "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 30"

  ok "${SERVICE_NAME}.service enabled + started"

  # ── Wait for service to stay active ─────────────────────────────────────────
  info "Waiting for service to stay active (30s max)..."
  _SVC_OK=0
  for _i in $(seq 1 30); do
    _STATE=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)
    if [ "$_STATE" = "active" ]; then
      _SVC_OK=1
      ok "Service active after ${_i}s"
      break
    elif [ "$_STATE" = "failed" ]; then
      break
    fi
    sleep 1
  done

  if [ "$_SVC_OK" -eq 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}Service did not stay active.${NC}"
    echo -e "${YELLOW}── journalctl -u ${SERVICE_NAME} (last 30 lines) ──${NC}"
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager -l 2>/dev/null || true
    echo ""
    echo -e "${BOLD}Most likely fixes:${NC}"
    echo "  1. Run:  tunevault-agent diagnose"
    echo "  2. Run:  tunevault-agent repair"
    echo "  3. Logs: journalctl -u $SERVICE_NAME -n 50"
    _HOST=$(hostname -f 2>/dev/null || hostname || echo unknown)
    _JCTL=$(journalctl -u "$SERVICE_NAME" -n 30 --no-pager -l 2>/dev/null \
            | head -c 8000 | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' || true)
    curl -fsS -X POST -H "Content-Type: application/json" \
      -d "{\"connection_id\":${CONNECTION_ID},\"host\":\"${_HOST}\",\"error_class\":\"systemd_failed\",\"journalctl_tail\":\"${_JCTL}\",\"installer_version\":\"8.0.0\"}" \
      "${API}/api/agent/install-failures" --max-time 10 >/dev/null 2>&1 || true
    exit 1
  fi

  # ── Register + heartbeat ─────────────────────────────────────────────────────
  info "Registering agent with cloud..."
  SIDS_JSON="[]"
  if [ -n "$ORACLE_SIDS" ]; then
    SIDS_JSON=$(echo "$ORACLE_SIDS" | tr ',' '\n' \
      | sed 's/^/"/; s/$/"/' | tr '\n' ',' | sed 's/,$//' | sed 's/^/[/; s/$/]/')
  fi
  _HOST=$(hostname -f 2>/dev/null || hostname || echo unknown)
  _PY_VER=$("$VENV_PYTHON" --version 2>&1 || echo unknown)
  _DRV_VER=$("$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || echo unknown)

  CONFIRM=$(curl -fsSL -X POST \
    -H "Content-Type: application/json" \
    -H "X-TuneVault-Key: ${API_KEY}" \
    -d "{\"connection_id\":${CONNECTION_ID},\"oracle_sids\":${SIDS_JSON},\"machine_hostname\":\"${_HOST}\",\"installer_version\":\"8.0.0\",\"python_version\":\"${_PY_VER}\",\"oracle_driver\":\"oracledb-${_DRV_VER}\"}" \
    "${API}/api/agent/confirm" 2>/dev/null) || CONFIRM="{}"

  echo "$CONFIRM" | grep -q '"ok":true' \
    && ok "Agent registered — visible in TuneVault dashboard" \
    || info "Registration deferred — agent will appear within 60s"

  if [ "$CONNECTION_ID" != "0" ]; then
    info "Waiting for heartbeat confirmation (60s max)..."
    _HB_OK=0
    for _i in $(seq 0 2 60); do
      _HB=$(curl -fsS \
        "${API}/api/agent/heartbeat-check?connection_id=${CONNECTION_ID}" \
        --max-time 8 2>/dev/null || true)
      _ALIVE=$(echo "$_HB" | grep -c '"alive":true' || true)
      _SECS=$(echo "$_HB" | sed -n 's/.*"seconds_ago":[[:space:]]*\([0-9]*\).*/\1/p' | head -1 || true)
      if [ "$_ALIVE" -gt 0 ] && [ -n "$_SECS" ] && [ "$_SECS" -le 30 ] 2>/dev/null; then
        _HB_OK=1
        ok "Heartbeat confirmed (${_SECS}s ago)"
        break
      fi
      sleep 2
    done
    [ "$_HB_OK" -eq 0 ] && info "No heartbeat within 60s — check: journalctl -u $SERVICE_NAME -n 20"
  fi
fi

# ── 4-probe self-check ────────────────────────────────────────────────────────
echo ""
echo "── Self-check ───────────────────────────────────────────"
_PASS=0; _FAIL=0

if [ "$HEADLESS" -eq 0 ]; then
  _S=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)
  if [ "$_S" = "active" ]; then
    ok "[1/4] Service active"
    _PASS=$((_PASS+1))
  else
    echo -e "${RED}[FAIL]${NC} [1/4] Service not active ($_S)  → journalctl -u $SERVICE_NAME -n 20"
    _FAIL=$((_FAIL+1))
  fi
else
  ok "[1/4] Service check skipped (headless)"
fi

_DRV=$("$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || true)
if [ -n "$_DRV" ]; then
  ok "[2/4] python-oracledb $_DRV importable"
  _PASS=$((_PASS+1))
else
  echo -e "${RED}[FAIL]${NC} [2/4] python-oracledb not importable  → tunevault-agent repair"
  _FAIL=$((_FAIL+1))
fi

if [ -f "$PROXY_SCRIPT" ]; then
  ok "[3/4] oracle-proxy.py present"
  _PASS=$((_PASS+1))
else
  echo -e "${RED}[FAIL]${NC} [3/4] oracle-proxy.py missing at $PROXY_SCRIPT"
  _FAIL=$((_FAIL+1))
fi

_KEY_LEN=$(grep '^TUNEVAULT_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | wc -c || echo 0)
if [ "${_KEY_LEN:-0}" -gt 10 ]; then
  ok "[4/4] agent.env readable, API key present"
  _PASS=$((_PASS+1))
else
  echo -e "${RED}[FAIL]${NC} [4/4] agent.env missing or API key too short  → cat $ENV_FILE"
  _FAIL=$((_FAIL+1))
fi

echo "─────────────────────────────────────────────────────────"
echo ""

if [ "$_FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║  ✓ TuneVault Agent v8.0 installed — all checks passed    ║${NC}"
  echo -e "${GREEN}${BOLD}║  Open: ${API}/connections/${CONNECTION_ID}${NC}${GREEN}${BOLD}  ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
else
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}${BOLD}║  ✗ Install finished but ${_FAIL} check(s) failed.            ║${NC}"
  echo -e "${RED}${BOLD}║  Run: tunevault-agent diagnose                           ║${NC}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
  exit 1
fi

# ── Install tunevault-agent CLI ───────────────────────────────────────────────
cat > /usr/local/bin/tunevault-agent <<CLIEOF
#!/usr/bin/env bash
# tunevault-agent — TuneVault Agent CLI v8.0
set -euo pipefail
ENV_FILE="${ENV_FILE}"
VENV_PYTHON="${VENV_PYTHON}"
VENV_PIP="${VENV_PIP}"
PROXY_SCRIPT="${PROXY_SCRIPT}"
SERVICE="${SERVICE_NAME}"

# OEL7 SCL lib path
[ -f /opt/rh/rh-python38/root/usr/lib64/libpython3.8.so.1.0 ] && \
  export LD_LIBRARY_PATH="/opt/rh/rh-python38/root/usr/lib64:\${LD_LIBRARY_PATH:-}"

_load() { [ -f "\$ENV_FILE" ] && source "\$ENV_FILE" || { echo "No config at \$ENV_FILE"; exit 1; }; }

case "\${1:-}" in
  start)
    exec "\$VENV_PYTHON" "\$PROXY_SCRIPT"
    ;;
  version)
    ver=\$("\$VENV_PYTHON" -c "import oracledb; print(oracledb.__version__)" 2>/dev/null || echo unknown)
    echo "tunevault-agent v8.0  python-oracledb \$ver"
    ;;
  diagnose)
    _load
    echo "=== TuneVault Agent Diagnostics ==="
    echo "Service:    \$(systemctl is-active \$SERVICE 2>/dev/null || echo unknown)"
    echo "Python:     \$("\$VENV_PYTHON" --version 2>&1 || echo FAIL)"
    echo "Driver:     \$("\$VENV_PYTHON" -c 'import oracledb; print(oracledb.__version__)' 2>/dev/null || echo FAIL)"
    echo "Config:     \$ENV_FILE  conn_id=\${TUNEVAULT_CONNECTION_ID:-unset}"
    echo "Proxy:      \$PROXY_SCRIPT  exists=\$([ -f \$PROXY_SCRIPT ] && echo yes || echo NO)"
    echo "API URL:    \${TUNEVAULT_API_URL:-unset}"
    echo "Logs:       journalctl -u \$SERVICE -n 50"
    ;;
  repair)
    echo "Reinstalling dependencies..."
    "\$VENV_PIP" install --quiet --upgrade oracledb paramiko requests pyyaml 2>/dev/null
    systemctl restart "\$SERVICE" 2>/dev/null && echo "Repaired and restarted." || echo "Repaired. Restart manually: systemctl restart \$SERVICE"
    ;;
  rotate-key)
    NEW_KEY="\${2:-}"; [ -n "\$NEW_KEY" ] || { echo "Usage: tunevault-agent rotate-key <new-key>"; exit 1; }
    TMP="\${ENV_FILE}.tmp.\$\$"
    sed "s|^TUNEVAULT_API_KEY=.*|TUNEVAULT_API_KEY=\${NEW_KEY}|" "\$ENV_FILE" > "\$TMP"
    mv -f "\$TMP" "\$ENV_FILE"; chmod 600 "\$ENV_FILE"
    systemctl restart "\$SERVICE" 2>/dev/null && echo "Key rotated and service restarted." || echo "Key rotated."
    ;;
  --help|-h|help|"")
    echo "Usage: tunevault-agent <command>"
    echo "  diagnose    — full health check with fix hints"
    echo "  version     — print version info"
    echo "  repair      — reinstall deps + restart service"
    echo "  rotate-key  — atomically update API key"
    echo "  start       — start poll loop (called by systemd)"
    ;;
  *)
    echo "Unknown command: \${1}. Run: tunevault-agent --help"; exit 1 ;;
esac
CLIEOF
chmod +x /usr/local/bin/tunevault-agent
ok "tunevault-agent CLI installed"
