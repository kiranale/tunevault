#!/usr/bin/env bash
# TuneVault Agent Uninstaller
# Usage: sudo bash uninstall.sh
# Or: curl -fsSL https://tunevault.app/uninstall.sh | sudo bash

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
info() { echo -e "${YELLOW}[..] $*${NC}"; }

echo -e "${BOLD}TuneVault Agent Uninstaller${NC}"
[ "$(id -u)" -eq 0 ] || { echo -e "${RED}Run as root${NC}" >&2; exit 1; }

# Load config
API_KEY=""
API_URL="https://tunevault.app"
CONNECTION_ID=""
[ -f /etc/tunevault/proxy.env ] && . /etc/tunevault/proxy.env
API_KEY="${TUNEVAULT_API_KEY:-}"
API_URL="${TUNEVAULT_API_URL:-https://tunevault.app}"
CONNECTION_ID="${TUNEVAULT_CONNECTION_ID:-}"

# Notify TuneVault (best-effort)
if [ -n "$API_KEY" ] && [ -n "$CONNECTION_ID" ]; then
  info "Notifying TuneVault…"
  curl -sfS -X POST \
    -H "Content-Type: application/json" \
    -H "X-TuneVault-Key: ${API_KEY}" \
    -d "{\"connection_id\":\"${CONNECTION_ID}\"}" \
    "${API_URL}/api/agent/uninstall" >/dev/null 2>&1 || info "Notify failed (non-fatal)"
fi

# Stop + disable services (clean up all known service names including legacy ones)
for svc in tunevault-proxy tunevault-tunnel tunevault-agent; do
  systemctl stop "$svc" 2>/dev/null || true
  systemctl disable "$svc" 2>/dev/null || true
  rm -f "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload 2>/dev/null || true
ok "Services removed"

# Remove files
rm -rf /etc/tunevault /opt/tunevault
rm -f /usr/local/bin/tunnel-agent
ok "Files removed"

echo -e "${GREEN}${BOLD}TuneVault Agent uninstalled.${NC}"
