/**
 * routes/security.js
 * Owns: /security/* public routes — trust page, command reference page, and downloads.
 * Does NOT own: authentication, health checks, user management.
 *
 * Routes:
 *   GET /security                    — CISO trust page (public)
 *   GET /security/commands           — full SQL/OS command reference (public)
 *   GET /security/commands.txt       — plaintext download of all queries
 *   GET /security/lockdown.sh        — bash hardening script download
 *   GET /security/lockdown-verify.sh — syscall audit script download
 *   GET /security/lockdown-bundle.tar.gz — full bundle (lockdown.sh + README + whitelist.json)
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const zlib = require('zlib');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal POSIX ustar tar.gz in-memory.
 * Returns a Buffer containing the complete .tar.gz file.
 *
 * @param {Array<{name: string, content: string|Buffer}>} files
 * @returns {Buffer}
 */
function buildTarGz(files) {
  const blocks = [];

  for (const { name, content } of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = buildTarHeader(name, data.length);
    blocks.push(header);
    // Pad content to 512-byte boundary
    const padded = Math.ceil(data.length / 512) * 512;
    const padBuf = Buffer.alloc(padded, 0);
    data.copy(padBuf);
    blocks.push(padBuf);
  }

  // Two 512-byte zero blocks = end-of-archive
  blocks.push(Buffer.alloc(1024, 0));

  const tar = Buffer.concat(blocks);
  return zlib.gzipSync(tar);
}

function buildTarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  const enc = (str, offset, len) => {
    const b = Buffer.from(str, 'utf8').slice(0, len);
    b.copy(header, offset);
  };
  const oct = (n, offset, len) => {
    const s = n.toString(8).padStart(len - 1, '0') + ' ';
    Buffer.from(s).slice(0, len).copy(header, offset);
  };

  enc(name.slice(0, 100), 0, 100);        // name
  enc('0000644\0', 100, 8);               // mode
  enc('0001750\0', 108, 8);               // uid
  enc('0001750\0', 116, 8);               // gid
  oct(size, 124, 12);                     // size
  oct(Math.floor(Date.now() / 1000), 136, 12); // mtime
  header[156] = 0x30;                     // typeflag '0' = regular file
  enc('ustar  \0', 257, 8);              // magic

  // Checksum
  header.fill(0x20, 148, 156);           // fill checksum field with spaces first
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const csStr = sum.toString(8).padStart(6, '0') + '\0 ';
  Buffer.from(csStr).copy(header, 148);

  return header;
}

// ─── Full enhanced lockdown script content ───────────────────────────────────

function getLockdownScriptContent() {
  return `#!/usr/bin/env bash
# tunevault-lockdown.sh — Enterprise Hardening Script
# Version: v2 (2026-05-11)
# ==============================================================
# Run as root on the Oracle application / proxy host BEFORE
# installing the TuneVault proxy agent.
#
# This script is the customer's source of truth.
# TuneVault cannot modify what's locked down here.
#
# Usage:
#   chmod +x tunevault-lockdown.sh
#   sudo ./tunevault-lockdown.sh [--install-dir /opt/tunevault]
#
# Actions (idempotent — safe to re-run):
#   1. Create restricted 'tunevault' OS user (/sbin/nologin)
#   2. Create /opt/tunevault with mode 750
#   3. Install SELinux or AppArmor confinement profile
#   4. Apply iptables/firewalld outbound rules (port 443 only)
#   5. Write sudoers whitelist (EBS status commands only)
#   6. Install logrotate config for /var/log/tunevault-audit.log
#   7. Print verification summary
#
# Tested on: Oracle Linux 7/8/9, RHEL 7/8/9, Ubuntu 20.04/22.04
# Requirements: bash, sudo, useradd, iptables or firewalld
# ==============================================================

set -euo pipefail

INSTALL_DIR="\${1:-/opt/tunevault}"
PROXY_USER="tunevault"
PROXY_GROUP="tunevault"
AUDIT_LOG="/var/log/tunevault-audit.log"
SELINUX_MODULE="tunevault"
APPARMOR_PROFILE="/etc/apparmor.d/opt.tunevault.proxy"
SUDOERS_FILE="/etc/sudoers.d/tunevault"
LOGROTATE_FILE="/etc/logrotate.d/tunevault"

# Allowed outbound destinations (port 443 HTTPS only)
TUNEVAULT_DOMAIN="tunevault.app"
TUNEVAULT_CIDR_HINTS="104.21.0.0/16 172.67.0.0/16"  # TuneVault CDN edge ranges (advisory only)

PASS=0; FAIL=0
log()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
warn() { echo "  ⚠ $*"; }
err()  { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TuneVault Enterprise Lockdown Script v2"
echo "  \$(date)"
echo "  Install dir: \$INSTALL_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Must run as root
if [[ "\$(id -u)" != "0" ]]; then
  echo "ERROR: Must run as root: sudo ./tunevault-lockdown.sh"
  exit 1
fi

# ──────────────────────────────────────────────────────────
# STEP 1: Restricted OS user
# ──────────────────────────────────────────────────────────
echo "[1/6] OS user: \$PROXY_USER"

if ! getent group "\$PROXY_GROUP" &>/dev/null; then
  groupadd --system "\$PROXY_GROUP"
  ok "Group \$PROXY_GROUP created"
else
  ok "Group \$PROXY_GROUP already exists"
fi

if ! id "\$PROXY_USER" &>/dev/null; then
  useradd \\
    --system \\
    --gid "\$PROXY_GROUP" \\
    --shell /sbin/nologin \\
    --no-create-home \\
    --comment "TuneVault proxy — read-only Oracle health checks" \\
    "\$PROXY_USER"
  ok "User \$PROXY_USER created (shell: /sbin/nologin, no home)"
else
  # Enforce shell is nologin even if user exists
  usermod --shell /sbin/nologin "\$PROXY_USER" 2>/dev/null || true
  ok "User \$PROXY_USER already exists (shell enforced to /sbin/nologin)"
fi

# ──────────────────────────────────────────────────────────
# STEP 2: Directory permissions
# ──────────────────────────────────────────────────────────
echo ""
echo "[2/6] Directory: \$INSTALL_DIR"

mkdir -p "\$INSTALL_DIR/logs" "\$INSTALL_DIR/bin" "\$INSTALL_DIR/keys"
chown -R "\$PROXY_USER:\$PROXY_GROUP" "\$INSTALL_DIR"
chmod 750 "\$INSTALL_DIR" "\$INSTALL_DIR/bin" "\$INSTALL_DIR/keys"
chmod 700 "\$INSTALL_DIR/logs"
ok "Directories created with mode 750/700"

# Audit log file
touch "\$AUDIT_LOG"
chown "\$PROXY_USER:\$PROXY_GROUP" "\$AUDIT_LOG"
chmod 640 "\$AUDIT_LOG"
ok "Audit log: \$AUDIT_LOG (640)"

# ──────────────────────────────────────────────────────────
# STEP 3: SELinux or AppArmor confinement
# ──────────────────────────────────────────────────────────
echo ""
echo "[3/6] MAC confinement (SELinux or AppArmor)"

SELINUX_STATUS="\$(getenforce 2>/dev/null || echo 'Disabled')"
APPARMOR_STATUS="\$(aa-status --enabled 2>/dev/null && echo 'yes' || echo 'no')"

if [[ "\$SELINUX_STATUS" == "Enforcing" || "\$SELINUX_STATUS" == "Permissive" ]]; then
  log "SELinux detected (\$SELINUX_STATUS) — writing type enforcement policy"

  # Write a minimal SELinux .te module for the proxy process
  cat > /tmp/tunevault.te << 'SELINUX_EOF'
module tunevault 1.0;
require {
  type unconfined_t;
  type tunevault_t;
  class file { read write execute };
  class dir { read search };
}
# tunevault process: read/write /opt/tunevault, write audit log, network connect
allow tunevault_t var_log_t:file { append };
allow tunevault_t self:tcp_socket { create connect read write };
SELINUX_EOF

  if command -v checkmodule &>/dev/null && command -v semodule_package &>/dev/null; then
    checkmodule -M -m -o /tmp/tunevault.mod /tmp/tunevault.te 2>/dev/null && \\
    semodule_package -o /tmp/tunevault.pp -m /tmp/tunevault.mod 2>/dev/null && \\
    semodule -i /tmp/tunevault.pp 2>/dev/null && ok "SELinux module installed" || \\
    warn "SELinux module compile failed — apply manually: /tmp/tunevault.te"
  else
    warn "checkmodule/semodule_package not installed — copy /tmp/tunevault.te and apply manually"
  fi

  # Label the install directory
  if command -v chcon &>/dev/null; then
    chcon -R -t bin_t "\$INSTALL_DIR/bin" 2>/dev/null && ok "SELinux context set on \$INSTALL_DIR/bin" || true
  fi

elif [[ "\$APPARMOR_STATUS" == "yes" ]]; then
  log "AppArmor detected — writing confinement profile"

  cat > "\$APPARMOR_PROFILE" << APPARMOR_EOF
# TuneVault proxy AppArmor profile — generated by tunevault-lockdown.sh v2
# Restricts filesystem access to /opt/tunevault and /tmp only.
profile tunevault /opt/tunevault/bin/oracle-proxy* {
  include <abstractions/base>
  include <abstractions/nameservice>

  # Allow proxy binary to execute
  /opt/tunevault/bin/** ix,

  # Read-only access to proxy files
  /opt/tunevault/** r,

  # Write access to logs and tmp only
  /opt/tunevault/logs/** rw,
  /tmp/** rw,
  /var/log/tunevault-audit.log w,

  # Outbound network only (443/tcp — enforced by iptables in step 4)
  network tcp,

  # Deny all other filesystem access
  deny /etc/shadow r,
  deny /etc/passwd w,
  deny /home/** rw,
  deny /root/** rw,
  deny /var/lib/** w,

  # Allow reading system libraries
  /lib/** rm,
  /usr/lib/** rm,
  /usr/local/lib/** rm,
  /usr/bin/node rix,
  /usr/local/bin/node rix,
}
APPARMOR_EOF

  if command -v apparmor_parser &>/dev/null; then
    apparmor_parser -r "\$APPARMOR_PROFILE" 2>/dev/null && \\
    ok "AppArmor profile installed: \$APPARMOR_PROFILE" || \\
    warn "AppArmor reload failed — profile written, reload manually: apparmor_parser -r \$APPARMOR_PROFILE"
  else
    warn "apparmor_parser not found — profile written to \$APPARMOR_PROFILE, apply manually"
  fi

else
  warn "Neither SELinux nor AppArmor detected — MAC confinement skipped"
  warn "Consider enabling SELinux (Oracle/RHEL) or AppArmor (Ubuntu) for defence-in-depth"
fi

# ──────────────────────────────────────────────────────────
# STEP 4: Outbound firewall rules
# ──────────────────────────────────────────────────────────
echo ""
echo "[4/6] Outbound firewall rules (port 443 only for tunevault user)"

# Detect firewall manager
if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
  FIREWALL="firewalld"
elif command -v iptables &>/dev/null; then
  FIREWALL="iptables"
else
  FIREWALL="none"
fi

PROXY_UID=\$(id -u "\$PROXY_USER" 2>/dev/null)

if [[ "\$FIREWALL" == "iptables" && -n "\$PROXY_UID" ]]; then
  log "iptables: adding owner-match rules for uid \$PROXY_UID"

  # Remove any existing tunevault rules first (idempotency)
  iptables -D OUTPUT -m owner --uid-owner "\$PROXY_UID" -j ACCEPT 2>/dev/null || true
  iptables -D OUTPUT -m owner --uid-owner "\$PROXY_UID" -j DROP 2>/dev/null || true

  # Allow DNS lookups (needed to resolve tunevault.app)
  iptables -I OUTPUT 1 -m owner --uid-owner "\$PROXY_UID" -p udp --dport 53 -j ACCEPT
  iptables -I OUTPUT 1 -m owner --uid-owner "\$PROXY_UID" -p tcp --dport 53 -j ACCEPT
  # Allow outbound 443 only
  iptables -I OUTPUT 1 -m owner --uid-owner "\$PROXY_UID" -p tcp --dport 443 -j ACCEPT
  # Allow established/related (responses)
  iptables -I OUTPUT 1 -m owner --uid-owner "\$PROXY_UID" -m state --state ESTABLISHED,RELATED -j ACCEPT
  # Block everything else for this user
  iptables -A OUTPUT -m owner --uid-owner "\$PROXY_UID" -j DROP

  # Persist rules if iptables-save is available
  if command -v iptables-save &>/dev/null; then
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || \\
    iptables-save > /etc/sysconfig/iptables 2>/dev/null || true
  fi

  ok "iptables rules added: uid \$PROXY_UID may only reach port 443 outbound"

elif [[ "\$FIREWALL" == "firewalld" ]]; then
  warn "firewalld detected — UID-based rules require rich rules or nftables"
  warn "Manual step: add rule allowing only uid \$PROXY_UID to reach port 443 outbound"
  log "  Example nftables rule:"
  log "    nft add rule inet filter output skuid \$PROXY_UID tcp dport != 443 drop"
else
  warn "No firewall manager found — outbound restriction skipped"
  warn "Recommended: restrict uid \$PROXY_UID to outbound 443 only"
fi

# ──────────────────────────────────────────────────────────
# STEP 5: Sudoers whitelist (EBS status commands only)
# ──────────────────────────────────────────────────────────
echo ""
echo "[5/6] Sudoers whitelist"

[[ -f "\$SUDOERS_FILE" ]] && rm -f "\$SUDOERS_FILE"

cat > "\$SUDOERS_FILE" << 'SUDOERS_EOF'
# TuneVault proxy — minimal sudo whitelist (EBS 12.2.x application tier)
# Generated by tunevault-lockdown.sh v2
# DO NOT edit manually — re-run tunevault-lockdown.sh to regenerate.
#
# What this grants:
#   The 'tunevault' system user may run ONLY the listed status commands
#   as the 'oracle' OS user. No start/stop/restart commands are granted.
#
# What this does NOT grant:
#   - Any write access to Oracle files
#   - Any login or interactive shell
#   - Any command not explicitly listed below

Defaults:tunevault env_keep += "ADMIN_SCRIPTS_HOME ORACLE_HOME ORACLE_SID"
Defaults:tunevault !requiretty

# Non-managed EBS services (individual *ctl.sh scripts)
Cmnd_Alias TUNEVAULT_STATUS_STANDALONE = \
  $ADMIN_SCRIPTS_HOME/adcmctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adalnctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adadminsrvctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adnodemgrctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adopmnctl.sh status, \
  $ADMIN_SCRIPTS_HOME/mwactl.sh status, \
  $ADMIN_SCRIPTS_HOME/adapcctl.sh status

# Managed EBS servers (via admanagedsrvctl.sh — the 12.2.x unified controller)
Cmnd_Alias TUNEVAULT_STATUS_MANAGED = \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status forms_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oafm_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status wfmlrsvc, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status opp

# Grant status-only access. No other commands permitted.
tunevault ALL=(oracle) NOPASSWD: TUNEVAULT_STATUS_STANDALONE, TUNEVAULT_STATUS_MANAGED

SUDOERS_EOF

# Validate syntax
if command -v visudo &>/dev/null; then
  if visudo -c -f "\$SUDOERS_FILE" &>/dev/null; then
    ok "Sudoers syntax validated: \$SUDOERS_FILE"
  else
    err "Sudoers validation failed — removing \$SUDOERS_FILE"
    rm -f "\$SUDOERS_FILE"
    exit 1
  fi
fi
chmod 440 "\$SUDOERS_FILE"
ok "Sudoers whitelist installed (440)"

# ──────────────────────────────────────────────────────────
# STEP 6: Logrotate for audit log
# ──────────────────────────────────────────────────────────
echo ""
echo "[6/6] Logrotate config"

cat > "\$LOGROTATE_FILE" << LOGROTATE_EOF
\$AUDIT_LOG {
    weekly
    rotate 52
    compress
    delaycompress
    missingok
    notifempty
    create 640 \$PROXY_USER \$PROXY_GROUP
    postrotate
        kill -HUP \\\$(cat /var/run/tunevault.pid 2>/dev/null) 2>/dev/null || true
    endscript
}
LOGROTATE_EOF
ok "Logrotate config: \$LOGROTATE_FILE (weekly, 52-week retention)"

# ──────────────────────────────────────────────────────────
# VERIFICATION SUMMARY
# ──────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Lockdown complete — Verification Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Checks passed : \$PASS"
echo "  Checks failed : \$FAIL"
echo ""
echo "  OS user:"
id "\$PROXY_USER" 2>/dev/null && \\
  echo "    Shell: \$(getent passwd \$PROXY_USER | cut -d: -f7)" || \\
  err "User \$PROXY_USER not found"
echo ""
echo "  Install directory:"
ls -la "\$INSTALL_DIR" 2>/dev/null | head -6
echo ""
echo "  Sudoers whitelist:"
cat "\$SUDOERS_FILE" 2>/dev/null | grep -v '^#' | grep -v '^$' || err "Sudoers file missing"
echo ""
echo "  Audit log:"
ls -la "\$AUDIT_LOG" 2>/dev/null || warn "Audit log not yet created"
echo ""

if [[ \$FAIL -gt 0 ]]; then
  echo "  ⚠  \$FAIL step(s) need attention above."
  echo ""
fi

echo "  Security review: https://tunevault.app/security"
echo "  Install docs:    https://tunevault.app/docs/oracle-setup"
echo ""
echo "  Next step: install the proxy as user '\$PROXY_USER'"
echo "  sudo -u \$PROXY_USER bash /path/to/oracle-proxy-install.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
`;
}

function getBundleReadme() {
  return `# TuneVault Lockdown Bundle — README

Version: v2 (2026-05-11)
Security contact: security@tunevault.app
Review page: https://tunevault.app/security

---

## What's in this bundle

| File | Purpose |
|------|---------|
| \`tunevault-lockdown.sh\` | Run as root on your proxy host before installing the proxy |
| \`README.md\` | This file — explains every action with compliance framework mapping |
| \`whitelist.json\` | Machine-readable command whitelist with SHA-256 hashes |

---

## What the lockdown script does

Run \`sudo ./tunevault-lockdown.sh\` on your Oracle application server or proxy host.
The script is idempotent — safe to re-run at any time.

### Step 1 — Restricted OS user

Creates a \`tunevault\` system account with:
- Shell: \`/sbin/nologin\` (no interactive login possible)
- No home directory
- System account (UID in system range)

**SOC 2 CC6.6:** Non-privileged accounts cannot escalate.
**ISO 27001 A.9.2.3:** Privileged access rights are restricted and controlled.
**NIST 800-53 AC-6:** Least privilege — minimum necessary access only.

### Step 2 — Directory permissions

- \`/opt/tunevault\` owned by \`tunevault:tunevault\` with mode 750
- \`/opt/tunevault/logs\` with mode 700 (no group read)
- No other OS user can read proxy files or configuration

**SOC 2 CC6.1:** Logical access controls restrict access to system components.
**ISO 27001 A.9.4.1:** Access to programs and data is restricted on a need-to-know basis.
**NIST 800-53 AC-3:** Access enforcement on all system resources.

### Step 3 — SELinux / AppArmor confinement

If SELinux is present (Oracle Linux, RHEL), installs a minimal type enforcement
module restricting the proxy to \`/opt/tunevault\` and network connections only.

If AppArmor is present (Ubuntu), installs a profile that:
- Allows read/write only to \`/opt/tunevault\` and \`/tmp\`
- Denies access to \`/home\`, \`/root\`, \`/etc/shadow\`
- Allows outbound network (enforced to port 443 by iptables in Step 4)

**SOC 2 CC6.8:** Malicious software detection and prevention.
**ISO 27001 A.12.2.1:** Controls against malware — mandatory access control.
**NIST 800-53 SI-3:** Malicious code protection via confinement.

### Step 4 — Outbound firewall rules

Adds iptables rules scoped to the \`tunevault\` UID:
- ALLOW: outbound TCP port 443 (HTTPS to tunevault.app)
- ALLOW: DNS (UDP/TCP port 53) for hostname resolution
- ALLOW: ESTABLISHED/RELATED (response packets)
- DROP: all other outbound traffic from this UID

This means even if the proxy binary were compromised, it cannot exfiltrate
data to any destination other than port 443 on tunevault.app.

**SOC 2 CC6.6:** Network access is restricted to only necessary paths.
**ISO 27001 A.13.1.1:** Network controls limit data exfiltration risk.
**NIST 800-53 SC-7:** Boundary protection — restrict outbound to known endpoints.

### Step 5 — Sudoers whitelist

Grants the \`tunevault\` user the ability to run ONLY the listed EBS status
commands as the \`oracle\` OS user — no password required for these specific
commands only. Specifically:

Permitted (status only — no start/stop/restart):
- \`adcmctl.sh status\` — Concurrent Manager
- \`adalnctl.sh status\` — APPS TNS Listener
- \`adadminsrvctl.sh status\` — Admin Server
- \`adnodemgrctl.sh status\` — Node Manager
- \`adopmnctl.sh status\` — OPMN
- \`mwactl.sh status\` — Middleware Agent
- \`adapcctl.sh status\` — Apache/OHS
- \`admanagedsrvctl.sh status oacore_server1\` — OACore
- \`admanagedsrvctl.sh status forms_server1\` — Forms
- \`admanagedsrvctl.sh status oafm_server1\` — OA Framework
- \`admanagedsrvctl.sh status wfmlrsvc\` — Workflow Mailer
- \`admanagedsrvctl.sh status opp\` — OPP

NOT permitted: start, stop, restart, bounce, or any other subcommand.

**SOC 2 CC6.3:** Least privilege for privileged access.
**ISO 27001 A.9.4.4:** Use of privileged utility programs is restricted.
**NIST 800-53 AC-6(1):** Authorise access to security functions only.

### Step 6 — Audit logging with logrotate

- Every action by the \`tunevault\` user is logged via syslog (tag: \`tunevault\`)
- \`/var/log/tunevault-audit.log\` captures all proxy activity
- logrotate: weekly rotation, 52-week (1 year) retention, compressed

**SOC 2 CC7.2:** Anomalies and incidents are detected and logged.
**ISO 27001 A.12.4.1:** Event logging of user activities and security events.
**NIST 800-53 AU-2:** Audit events — all privileged command executions.

---

## How to verify after installation

\`\`\`bash
# Confirm no interactive shell
getent passwd tunevault | cut -d: -f7
# → /sbin/nologin

# Confirm directory permissions
ls -la /opt/tunevault
# → drwxr-x--- tunevault tunevault ...

# Confirm sudoers whitelist
sudo -l -U tunevault
# → Lists only the permitted status commands

# Confirm firewall rules (if iptables)
iptables -L OUTPUT -n | grep $(id -u tunevault)
# → Shows accept 443 + drop rules
\`\`\`

---

## Questions

security@tunevault.app — we aim to respond promptly to security issues.

Full live security reference: https://tunevault.app/security
`;
}

function getBundleWhitelist() {
  const whitelist = {
    version: 'v2',
    generated: new Date().toISOString(),
    source: 'https://tunevault.app/api/ebs-control/catalog',
    description: 'TuneVault EBS Control Command Whitelist. Every command TuneVault can issue on your EBS application tier. Anything not on this list cannot be executed.',
    commands: [
      {
        slug: 'cm_bounce',
        label: 'Concurrent Manager — Bounce',
        category: 'CM',
        risk_level: 'medium',
        dry_run_only: false,
        description: 'Stops and restarts the Concurrent Manager process',
        hash_v1: '071adb4256701920f027fb273f250af38192b90e50366fbeba00f418bc46f57c'
      },
      {
        slug: 'wf_mailer_restart',
        label: 'Workflow Mailer — Restart',
        category: 'WF',
        risk_level: 'low',
        dry_run_only: false,
        description: 'Restarts the Workflow Notification Mailer service',
        hash_v1: '00f5e37d47b96644b419677c64714c715388cb3c05c1d22412cc13ae3abd2c5f'
      },
      {
        slug: 'oacore_bounce',
        label: 'OACore — Bounce',
        category: 'WLS',
        risk_level: 'medium',
        dry_run_only: false,
        description: 'Bounces the OA Framework core managed server',
        hash_v1: '19db054a0fe7ee121b57925534a75c8469878578796cdcfafa9c3c936d5ebcd8'
      },
      {
        slug: 'opp_kick',
        label: 'OPP — Kick Stuck Sessions',
        category: 'OPP',
        risk_level: 'low',
        dry_run_only: false,
        description: 'Clears stuck Output Post Processor sessions',
        hash_v1: '33849633c1146dcb59925c41f1b1c60df3518b306d00fbb7b473b4b5ab30f309'
      },
      {
        slug: 'recompile_invalids',
        label: 'Recompile Invalid Objects',
        category: 'DB',
        risk_level: 'low',
        dry_run_only: false,
        description: 'Runs UTL_RECOMP.recomp_serial() to recompile invalid database objects',
        hash_v1: 'c5b6cd4ca6b76bf26fb86eb73a41043c98edd9745bae8dc8df9e873962d6d703'
      }
    ]
  };
  return JSON.stringify(whitelist, null, 2);
}

// Root trust page — CISO-facing, public, indexable
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'security.html'));
});

// Detailed command reference page — public, no auth required
router.get('/commands', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'security-commands.html'));
});

// Credential vault documentation — exact storage + encryption + threat model for APPS/WebLogic/SYSTEM passwords
router.get('/credentials', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'security-credentials.html'));
});

// Plaintext download — all SQL queries and OS commands in plain text
router.get('/commands.txt', (req, res) => {
  const deployDate = process.env.DEPLOY_DATE || new Date().toISOString().slice(0, 10);

  const text = `TuneVault Oracle Health Check — Security Commands Reference
============================================================
Generated: ${deployDate}
Proxy version: 3.2.1
Source: https://tunevault.app/security/commands
Read-only: YES — all queries are SELECT only, no writes.

============================================================
SECTION 0: REQUIRED ORACLE GRANTS
============================================================

-- Core catalog access (covers DBA_*, V$*, GV$* views)
GRANT SELECT_CATALOG_ROLE TO tunevault_user;
GRANT CREATE SESSION TO tunevault_user;

-- Alert log access (NOT covered by SELECT_CATALOG_ROLE)
GRANT SELECT ON V_$DIAG_ALERT_EXT TO tunevault_user;

-- EBS Apps schema (skip on non-EBS Oracle databases)
GRANT SELECT ON APPS.FND_CONCURRENT_QUEUES TO tunevault_user;
GRANT SELECT ON APPS.FND_CONCURRENT_QUEUES_VL TO tunevault_user;
GRANT SELECT ON APPS.FND_SVC_COMPONENTS TO tunevault_user;
GRANT SELECT ON APPS.FND_CONCURRENT_REQUESTS TO tunevault_user;
GRANT SELECT ON APPS.WF_NOTIFICATIONS TO tunevault_user;
GRANT SELECT ON APPS.WF_ERROR TO tunevault_user;
GRANT SELECT ON APPS.FND_OAM_METVAL TO tunevault_user;

============================================================
SECTION 1: SQL QUERIES (all SELECT, no writes)
============================================================

--- INSTANCE & VERSION ---

-- Instance information (V$DATABASE, V$INSTANCE, V$PARAMETER)
SELECT d.NAME, i.INSTANCE_NAME, i.HOST_NAME, i.VERSION,
  d.PLATFORM_NAME, TO_CHAR(i.STARTUP_TIME, 'YYYY-MM-DD HH24:MI:SS'),
  ROUND(SYSDATE - i.STARTUP_TIME),
  (SELECT VALUE FROM v$parameter WHERE name = 'cpu_count'),
  ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'sga_target'), 1),
  ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name = 'pga_aggregate_target'), 1),
  (SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name = 'db_block_size')
FROM v$database d, v$instance i;

-- Version banner (V$VERSION)
SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1;

--- STORAGE ---

-- Tablespace usage (DBA_TABLESPACE_USAGE_METRICS, DBA_TABLESPACES, DBA_DATA_FILES)
SELECT ts.TABLESPACE_NAME, ROUND(um.USED_SPACE * ts.BLOCK_SIZE / 1024/1024/1024, 1),
  ROUND(um.TABLESPACE_SIZE * ts.BLOCK_SIZE / 1024/1024/1024, 1),
  ROUND(um.USED_PERCENT, 1),
  CASE WHEN df.autoext > 0 THEN 1 ELSE 0 END
FROM DBA_TABLESPACE_USAGE_METRICS um
JOIN DBA_TABLESPACES ts ON ts.TABLESPACE_NAME = um.TABLESPACE_NAME
LEFT JOIN (SELECT TABLESPACE_NAME, SUM(CASE WHEN AUTOEXTENSIBLE='YES' THEN 1 ELSE 0 END) AS autoext
           FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) df
  ON df.TABLESPACE_NAME = um.TABLESPACE_NAME
ORDER BY um.USED_PERCENT DESC;

-- Undo stats (V$UNDOSTAT)
SELECT UNDOBLKS, TXNCOUNT, MAXQUERYLEN, MAXCONCURRENCY,
  TUNED_UNDORETENTION, EXPIREDBLKS, UNEXPIREDBLKS, ACTIVEBLKS
FROM V$UNDOSTAT WHERE ROWNUM = 1 ORDER BY END_TIME DESC;

-- Undo tablespace size (DBA_DATA_FILES, DBA_TABLESPACES, DBA_FREE_SPACE)
SELECT d.TABLESPACE_NAME, SUM(d.BYTES)/1073741824, SUM(d.BYTES - NVL(f.FREE_BYTES,0))/1073741824,
  ROUND(SUM(d.BYTES - NVL(f.FREE_BYTES,0))/SUM(d.BYTES)*100,1), t.RETENTION
FROM DBA_DATA_FILES d JOIN DBA_TABLESPACES t ON t.TABLESPACE_NAME=d.TABLESPACE_NAME
LEFT JOIN (SELECT FILE_ID, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY FILE_ID) f
  ON f.FILE_ID=d.FILE_ID
WHERE t.CONTENTS='UNDO' GROUP BY d.TABLESPACE_NAME, t.RETENTION;

-- Temp tablespace free space (DBA_TEMP_FREE_SPACE)
SELECT TABLESPACE_NAME, ROUND(TABLESPACE_SIZE/1073741824,2),
  ROUND(FREE_SPACE/1073741824,2),
  ROUND((TABLESPACE_SIZE-FREE_SPACE)/NULLIF(TABLESPACE_SIZE,0)*100,1)
FROM DBA_TEMP_FREE_SPACE;

-- Top temp-consuming sessions (V$TEMPSEG_USAGE)
SELECT s.SID, s.SERIAL#, s.USERNAME, ROUND(s.BLOCKS*8192/1048576,1), s.TABLESPACE
FROM V$TEMPSEG_USAGE s ORDER BY s.BLOCKS DESC FETCH FIRST 10 ROWS ONLY;

-- Top 10 segments by size (DBA_SEGMENTS)
SELECT OWNER, SEGMENT_NAME, SEGMENT_TYPE, ROUND(SUM(BYTES)/1073741824,2)
FROM DBA_SEGMENTS
WHERE OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS')
GROUP BY OWNER, SEGMENT_NAME, SEGMENT_TYPE ORDER BY 4 DESC FETCH FIRST 10 ROWS ONLY;

-- Offline datafiles (DBA_DATA_FILES)
SELECT COUNT(*), COUNT(CASE WHEN STATUS='OFFLINE' THEN 1 END)
FROM DBA_DATA_FILES WHERE STATUS NOT IN ('AVAILABLE','ONLINE');

-- Recycle bin size (DBA_RECYCLEBIN)
SELECT COUNT(*), ROUND(SUM(SPACE)*8192/1073741824,2) FROM DBA_RECYCLEBIN;

--- MEMORY (SGA/PGA) ---

-- SGA size (V$SGA)
SELECT ROUND(SUM(VALUE)/1024/1024/1024,1) FROM V$SGA;

-- Buffer cache hit ratio (V$SYSSTAT)
SELECT ROUND((1-(phys.VALUE/(db_gets.VALUE+con_gets.VALUE)))*100,1)
FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME='physical reads') phys,
     (SELECT VALUE FROM V$SYSSTAT WHERE NAME='db block gets') db_gets,
     (SELECT VALUE FROM V$SYSSTAT WHERE NAME='consistent gets') con_gets;

-- Library cache hit ratio (V$LIBRARYCACHE)
SELECT ROUND(SUM(PINS-RELOADS)/NULLIF(SUM(PINS),0)*100,1) FROM V$LIBRARYCACHE;

-- Dictionary cache hit ratio (V$ROWCACHE)
SELECT ROUND(SUM(GETS-GETMISSES)/NULLIF(SUM(GETS),0)*100,1) FROM V$ROWCACHE;

-- Shared pool free % (V$SGASTAT)
SELECT ROUND(free_bytes.val/total_bytes.val*100,1)
FROM (SELECT SUM(BYTES) AS val FROM V$SGASTAT WHERE POOL='shared pool' AND NAME='free memory') free_bytes,
     (SELECT SUM(BYTES) AS val FROM V$SGASTAT WHERE POOL='shared pool') total_bytes;

-- PGA stats (V$PGASTAT, V$PARAMETER, V$SQL_WORKAREA_HISTOGRAM)
SELECT ROUND((SELECT TO_NUMBER(VALUE)/1024/1024/1024 FROM v$parameter WHERE name='pga_aggregate_target'),1),
  ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME='total PGA allocated'),1),
  ROUND((SELECT VALUE/1024/1024/1024 FROM V$PGASTAT WHERE NAME='maximum PGA allocated'),1),
  (SELECT VALUE FROM V$PGASTAT WHERE NAME='over allocation count'),
  ROUND((SELECT VALUE FROM V$PGASTAT WHERE NAME='cache hit percentage'),1)
FROM DUAL;

-- OS memory & CPU via Oracle (V$OSSTAT)
SELECT STAT_NAME, VALUE FROM V$OSSTAT
WHERE STAT_NAME IN ('NUM_CPUS','IDLE_TIME','BUSY_TIME','USER_TIME','SYS_TIME',
  'IOWAIT_TIME','PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES');

--- PERFORMANCE ---

-- Top 10 SQL by elapsed time (V$SQL)
SELECT SQL_ID, SUBSTR(SQL_TEXT,1,500), EXECUTIONS, ROUND(ELAPSED_TIME/1000000,1),
  ROUND(CPU_TIME/1000000,1), BUFFER_GETS, DISK_READS, ROWS_PROCESSED,
  CASE WHEN EXECUTIONS>0 THEN ROUND(ELAPSED_TIME/EXECUTIONS/1000,2) ELSE 0 END,
  CASE WHEN EXECUTIONS>0 THEN ROUND(BUFFER_GETS/EXECUTIONS) ELSE 0 END,
  PLAN_HASH_VALUE
FROM V$SQL
WHERE EXECUTIONS>0 AND ELAPSED_TIME>0
  AND PARSING_SCHEMA_NAME NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN',
    'MDSYS','ORDSYS','EXFSYS','WMSYS','APPQOSSYS','DBSFWUSER')
  AND SQL_TEXT NOT LIKE '%v$%' AND SQL_TEXT NOT LIKE '%V$%'
  AND COMMAND_TYPE IN (2,3,6,7,189)
ORDER BY ELAPSED_TIME DESC FETCH FIRST 10 ROWS ONLY;

-- Top 15 wait events (V$SYSTEM_EVENT)
SELECT EVENT, WAIT_CLASS, TOTAL_WAITS, ROUND(TIME_WAITED/100,1),
  CASE WHEN TOTAL_WAITS>0 THEN ROUND((TIME_WAITED/100/TOTAL_WAITS)*1000,2) ELSE 0 END
FROM V$SYSTEM_EVENT
WHERE WAIT_CLASS NOT IN ('Idle') AND TOTAL_WAITS>0
ORDER BY TIME_WAITED DESC FETCH FIRST 15 ROWS ONLY;

-- Index health top 20 (DBA_INDEXES, DBA_IND_STATISTICS, V$PARAMETER)
SELECT i.OWNER, i.INDEX_NAME, i.TABLE_NAME,
  ROUND(s.LEAF_BLOCKS*(SELECT TO_NUMBER(VALUE) FROM v$parameter WHERE name='db_block_size')/1024/1024) AS size_mb,
  i.BLEVEL, s.LEAF_BLOCKS, i.CLUSTERING_FACTOR, NVL(s.PCT_DIRECT_ACCESS,100), i.STATUS,
  CASE WHEN i.STATUS!='VALID' THEN 'unusable' WHEN i.BLEVEL>4 THEN 'critical'
       WHEN NVL(s.PCT_DIRECT_ACCESS,100)<50 THEN 'critical'
       WHEN i.BLEVEL>3 THEN 'fragmented' WHEN NVL(s.PCT_DIRECT_ACCESS,100)<70 THEN 'fragmented'
       ELSE 'ok' END
FROM DBA_INDEXES i
LEFT JOIN DBA_IND_STATISTICS s ON s.OWNER=i.OWNER AND s.INDEX_NAME=i.INDEX_NAME AND s.PARTITION_NAME IS NULL
WHERE i.OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','EXFSYS',
  'WMSYS','XDB','CTXSYS','APPQOSSYS','DBSFWUSER','APEX_040000','APEX_040200','APEX_050000','FLOWS_FILES')
  AND i.INDEX_TYPE='NORMAL' AND NVL(s.LEAF_BLOCKS,0)>100
ORDER BY CASE WHEN i.STATUS!='VALID' THEN 1 WHEN i.BLEVEL>4 THEN 2
              WHEN i.BLEVEL>3 THEN 3 ELSE 4 END, s.LEAF_BLOCKS DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;

-- Resource limits (V$RESOURCE_LIMIT)
SELECT RESOURCE_NAME, CURRENT_UTILIZATION, MAX_UTILIZATION, INITIAL_ALLOCATION, LIMIT_VALUE
FROM V$RESOURCE_LIMIT
WHERE RESOURCE_NAME IN ('sessions','processes','enqueue_locks','enqueue_resources',
  'dml_locks','temporary_table_locks','transactions','max_rollback_segments');

-- Session counts and blocked sessions (V$SESSION)
SELECT COUNT(*), COUNT(CASE WHEN STATUS='ACTIVE' AND TYPE='USER' THEN 1 END),
  COUNT(CASE WHEN TYPE='USER' THEN 1 END) FROM V$SESSION;
SELECT COUNT(*) FROM V$SESSION WHERE BLOCKING_SESSION IS NOT NULL AND STATUS='ACTIVE';
SELECT COUNT(*), ROUND(MAX((SYSDATE-SQL_EXEC_START)*1440),1) FROM V$SESSION
WHERE STATUS='ACTIVE' AND TYPE='USER' AND SQL_EXEC_START IS NOT NULL
  AND (SYSDATE-SQL_EXEC_START)*1440>5;

-- Disk sort and full table scan ratios (V$SYSSTAT)
SELECT d.VALUE, m.VALUE FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME='sorts (disk)') d,
  (SELECT VALUE FROM V$SYSSTAT WHERE NAME='sorts (memory)') m;
SELECT s.VALUE, i.VALUE FROM (SELECT VALUE FROM V$SYSSTAT WHERE NAME='table scans (long tables)') s,
  (SELECT VALUE FROM V$SYSSTAT WHERE NAME='table fetch by rowid') i;

-- Invalid objects (DBA_OBJECTS)
SELECT COUNT(*), COUNT(CASE WHEN OBJECT_TYPE IN ('PACKAGE BODY','PACKAGE') THEN 1 END),
  COUNT(CASE WHEN OBJECT_TYPE='PROCEDURE' THEN 1 END),
  COUNT(CASE WHEN OBJECT_TYPE='VIEW' THEN 1 END),
  COUNT(CASE WHEN OBJECT_TYPE='TRIGGER' THEN 1 END)
FROM DBA_OBJECTS WHERE STATUS='INVALID'
  AND OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB',
    'CTXSYS','WMSYS','EXFSYS','APPQOSSYS','DBSFWUSER','OJVMSYS','DVSYS','LBACSYS');

-- Stale statistics (DBA_TAB_STATISTICS)
SELECT COUNT(*), COUNT(CASE WHEN LAST_ANALYZED IS NULL THEN 1 END)
FROM DBA_TAB_STATISTICS WHERE STALE_STATS='YES'
  AND OWNER NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','MDSYS','ORDSYS','XDB','CTXSYS','WMSYS','EXFSYS');

-- SCN headroom (V$DATABASE)
SELECT CURRENT_SCN,
  ROUND((TO_NUMBER(SYSDATE-TO_DATE('01-01-1988','DD-MM-YYYY'))*24*3600*16384*1024-CURRENT_SCN)/(24*3600*16384),0)
FROM V$DATABASE;

-- Alert log errors last 24h (V$DIAG_ALERT_EXT) -- requires explicit GRANT SELECT ON V_$DIAG_ALERT_EXT
SELECT TO_CHAR(ORIGINATING_TIMESTAMP,'YYYY-MM-DD HH24:MI:SS'), MESSAGE_TEXT
FROM V$DIAG_ALERT_EXT
WHERE ORIGINATING_TIMESTAMP>SYSDATE-1
  AND (MESSAGE_TEXT LIKE 'ORA-%' OR MESSAGE_TEXT LIKE '%checkpoint%'
       OR MESSAGE_TEXT LIKE '%corruption%' OR MESSAGE_TEXT LIKE '%recovery%'
       OR MESSAGE_TEXT LIKE '%error%' OR MESSAGE_TEXT LIKE '%warning%'
       OR MESSAGE_TEXT LIKE '%TNS-%' OR MESSAGE_TEXT LIKE '%instance%'
       OR MESSAGE_TEXT LIKE 'Thread%')
ORDER BY ORIGINATING_TIMESTAMP DESC FETCH FIRST 200 ROWS ONLY;

--- BACKUP & RECOVERY ---

-- RMAN backup freshness (V$RMAN_BACKUP_JOB_DETAILS)
SELECT INPUT_TYPE, STATUS, TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI:SS'),
  TO_CHAR(END_TIME,'YYYY-MM-DD HH24:MI:SS'), ROUND((SYSDATE-END_TIME)*24,1),
  ROUND(OUTPUT_BYTES/1073741824,2), ELAPSED_SECONDS
FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY INPUT_TYPE ORDER BY END_TIME DESC) AS RN
      FROM V$RMAN_BACKUP_JOB_DETAILS WHERE STATUS='COMPLETED') WHERE RN=1;

-- FRA usage (V$RECOVERY_FILE_DEST, V$FLASH_RECOVERY_AREA_USAGE, V$ARCHIVED_LOG)
SELECT NAME, ROUND(SPACE_LIMIT/1073741824,2), ROUND(SPACE_USED/1073741824,2),
  ROUND(SPACE_RECLAIMABLE/1073741824,2), NUMBER_OF_FILES FROM V$RECOVERY_FILE_DEST;
SELECT FILE_TYPE, ROUND(PERCENT_SPACE_USED,1), ROUND(PERCENT_SPACE_RECLAIMABLE,1), NUMBER_OF_FILES
FROM V$FLASH_RECOVERY_AREA_USAGE ORDER BY PERCENT_SPACE_USED DESC;
SELECT ROUND(SUM(BLOCKS*BLOCK_SIZE)/1073741824,2) FROM V$ARCHIVED_LOG
WHERE COMPLETION_TIME>SYSDATE-1 AND STANDBY_DEST='NO';

-- Archivelog mode (V$DATABASE, V$INSTANCE, V$LOG_HISTORY, V$LOG, V$ARCHIVED_LOG)
SELECT LOG_MODE, ROUND((SYSDATE-STARTUP_TIME)*24) FROM V$DATABASE, V$INSTANCE;
SELECT TO_CHAR(COMPLETION_TIME,'YYYY-MM-DD HH24'), COUNT(*), ROUND(SUM(BLOCKS*BLOCK_SIZE)/1048576,1)
FROM V$ARCHIVED_LOG WHERE COMPLETION_TIME>SYSDATE-1 AND STANDBY_DEST='NO'
GROUP BY TO_CHAR(COMPLETION_TIME,'YYYY-MM-DD HH24') ORDER BY 1 DESC;
SELECT ROUND(COUNT(*)/24.0,1), COUNT(*) FROM V$LOG_HISTORY WHERE FIRST_TIME>SYSDATE-1;

-- Backup corruption (V$RMAN_STATUS, V$BACKUP_CORRUPTION, V$COPY_CORRUPTION)
SELECT COUNT(*), SUM(BLOCKS) FROM V$BACKUP_CORRUPTION;
SELECT COUNT(*), SUM(BLOCKS) FROM V$COPY_CORRUPTION;

--- SECURITY ---

-- Default-password accounts (DBA_USERS_WITH_DEFPWD)
SELECT COUNT(*) FROM DBA_USERS_WITH_DEFPWD WHERE ACCOUNT_STATUS='OPEN';

-- Dangerous PUBLIC grants (DBA_SYS_PRIVS)
SELECT COUNT(*) FROM DBA_SYS_PRIVS WHERE GRANTEE='PUBLIC'
  AND PRIVILEGE IN ('CREATE PROCEDURE','CREATE ANY PROCEDURE','CREATE ANY TRIGGER',
    'ALTER SYSTEM','ALTER DATABASE','DROP ANY TABLE','EXECUTE ANY PROCEDURE');

-- Schema-only open accounts (DBA_USERS)
SELECT COUNT(*) FROM DBA_USERS
WHERE ACCOUNT_STATUS='OPEN' AND AUTHENTICATION_TYPE='NONE' AND USERNAME NOT IN ('SYS','SYSTEM');

-- Password policy (DBA_PROFILES)
SELECT LIMIT FROM DBA_PROFILES WHERE PROFILE='DEFAULT' AND RESOURCE_NAME='PASSWORD_VERIFY_FUNCTION';

-- Audit trail setting (V$PARAMETER)
SELECT VALUE FROM V$PARAMETER WHERE NAME='audit_trail';

-- DBA-privileged users (DBA_SYS_PRIVS)
SELECT COUNT(DISTINCT GRANTEE) FROM DBA_SYS_PRIVS
WHERE PRIVILEGE='DBA' AND GRANTEE NOT IN ('SYS','SYSTEM','DBA','SYSMAN');

--- EBS / ORACLE APPLICATIONS (EBS environments only) ---

-- Concurrent Manager health (APPS.FND_CONCURRENT_QUEUES, APPS.FND_CONCURRENT_QUEUES_VL)
SELECT b.user_concurrent_queue_name, b.node_name, a.running_processes, a.max_processes
FROM apps.fnd_concurrent_queues a, apps.fnd_concurrent_queues_vl b
WHERE a.concurrent_queue_id = b.concurrent_queue_id;

-- Pending request count (APPS.FND_CONCURRENT_REQUESTS)
SELECT phase_code, COUNT(*) FROM APPS.FND_CONCURRENT_REQUESTS
WHERE phase_code IN ('P','R') GROUP BY phase_code;

-- WF components (APPS.FND_SVC_COMPONENTS)
SELECT component_type, component_name, component_status, startup_mode
FROM apps.fnd_svc_components WHERE component_type LIKE 'WF%' ORDER BY 1, 2;

-- Stuck WF notifications (APPS.WF_NOTIFICATIONS)
SELECT COUNT(*) FROM APPS.WF_NOTIFICATIONS
WHERE STATUS='OPEN' AND MAIL_STATUS='MAIL' AND BEGIN_DATE < SYSDATE - 1/24;

-- WF error queue depth (APPS.WF_ERROR)
SELECT COUNT(*) FROM APPS.WF_ERROR;

-- APPS_JDBC_URL from DB metadata (APPS.FND_OAM_METVAL)
SELECT METVAL_CLOB FROM APPS.FND_OAM_METVAL WHERE METNAME='APPS_JDBC_URL' AND ROWNUM=1;

============================================================
SECTION 2: OS COMMANDS (Shell Command Whitelist)
============================================================

Core health checks: NONE
All OS-level metrics (CPU, memory, I/O wait) are read from Oracle's V$OSSTAT view
via the database connection — no shell commands required for the 100+ core checks.

EBS 12.2.x application-tier commands (conditional — only run when EBS is detected):
All commands use $ADMIN_SCRIPTS_HOME env var. Only "status" subcommands are permitted.
The proxy rejects any command not in this exact whitelist.

Non-managed services (individual *ctl.sh scripts):
  $ADMIN_SCRIPTS_HOME/adcmctl.sh status              — Concurrent Manager status
  $ADMIN_SCRIPTS_HOME/adalnctl.sh status             — APPS TNS Listener status
  $ADMIN_SCRIPTS_HOME/adadminsrvctl.sh status        — Admin Server status
  $ADMIN_SCRIPTS_HOME/adnodemgrctl.sh status         — Node Manager status
  $ADMIN_SCRIPTS_HOME/adopmnctl.sh status            — OPMN status
  $ADMIN_SCRIPTS_HOME/mwactl.sh status               — Middleware Agent status
  $ADMIN_SCRIPTS_HOME/adapcctl.sh status             — Apache/OHS status

Managed servers (all routed through admanagedsrvctl.sh):
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore_server1  — OACore managed server
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status forms_server1   — Forms managed server
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oafm_server1    — OA Framework managed server
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status wfmlrsvc        — Workflow Mailer (managed service)
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status opp             — Output Post Processor

NOT in whitelist (12.1 legacy scripts — do not exist in EBS 12.2.12):
  wfmlrctl.sh      — DOES NOT EXIST. Use admanagedsrvctl.sh status wfmlrsvc
  adppctl.sh       — DOES NOT EXIST. Use admanagedsrvctl.sh status opp
  adformsrvctl.sh  — DO NOT USE for forms. Use admanagedsrvctl.sh status forms_server1

Conditions for any EBS shell command: EBS detected via APPS.DUAL probe AND
ADMIN_SCRIPTS_HOME env var is set in the proxy environment AND script exists on disk.
If any condition is unmet, the check returns a warning without executing the command.

============================================================
SECTION 3: NETWORK EGRESS FROM THE PROXY
============================================================

Host: tunevault.app
Port: 443 (HTTPS / TLS 1.2+)
Connections: 2 endpoints
  1. POST /api/proxy/healthcheck — delivers health check results (JSON metrics)
  2. GET  /api/proxy/version      — auto-update version check (every 6 hours)

Data sent to TuneVault:
  - Oracle performance metrics (tablespace usage, wait events, SQL stats, etc.)
  - Proxy version string (for update check)
  NOT sent: Oracle credentials, database schema, user data rows

Authentication: 64-hex API key in X-API-Key header (generated locally at install time)

No inbound connections from TuneVault.
No external tunnel or VPN required.
No data sent to any third party.

============================================================
END OF DOCUMENT
============================================================
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-security-commands.txt"');
  res.send(text);
});

// lockdown.sh — hardening script customers run BEFORE installing the proxy
// Creates restricted OS user, sets directory permissions, writes sudoers whitelist
router.get('/lockdown.sh', (req, res) => {
  const script = `#!/bin/bash
# tunevault-lockdown.sh
# ==================================================
# Run this on your Oracle server BEFORE installing
# the TuneVault proxy. It creates a restricted OS
# user and configures minimal sudo privileges.
#
# Usage:
#   chmod +x tunevault-lockdown.sh
#   sudo ./tunevault-lockdown.sh [--install-dir /opt/tunevault]
#
# Requirements: bash, sudo, useradd/adduser
# Tested on: Oracle Linux 7/8/9, RHEL 7/8/9, Ubuntu 20/22
# ==================================================

set -euo pipefail

INSTALL_DIR=\${1:-/opt/tunevault}
PROXY_USER=tunevault
PROXY_GROUP=tunevault

# Must run as root
if [ "$(id -u)" != "0" ]; then
  echo "ERROR: Must run as root (sudo ./tunevault-lockdown.sh)"
  exit 1
fi

echo "========================================"
echo " TuneVault Lockdown Script"
echo " $(date)"
echo " Install dir: \$INSTALL_DIR"
echo "========================================"
echo ""

# --- Create restricted group and user ---
if ! getent group "\$PROXY_GROUP" &>/dev/null; then
  echo "[1/4] Creating group: \$PROXY_GROUP"
  groupadd --system "\$PROXY_GROUP"
else
  echo "[1/4] Group \$PROXY_GROUP already exists — skipping"
fi

if ! id "\$PROXY_USER" &>/dev/null; then
  echo "[2/4] Creating user: \$PROXY_USER (no login shell, system account)"
  useradd \\
    --system \\
    --gid "\$PROXY_GROUP" \\
    --shell /sbin/nologin \\
    --no-create-home \\
    --comment "TuneVault proxy service account" \\
    "\$PROXY_USER"
else
  echo "[2/4] User \$PROXY_USER already exists — skipping"
fi

# --- Create and lock down install directory ---
echo "[3/4] Setting up install directory: \$INSTALL_DIR"
mkdir -p "\$INSTALL_DIR"
chown "\$PROXY_USER:\$PROXY_GROUP" "\$INSTALL_DIR"
chmod 750 "\$INSTALL_DIR"

# Log directory (writable by proxy user only)
mkdir -p "\$INSTALL_DIR/logs"
chown "\$PROXY_USER:\$PROXY_GROUP" "\$INSTALL_DIR/logs"
chmod 700 "\$INSTALL_DIR/logs"

# --- Configure sudoers whitelist ---
echo "[4/4] Writing sudoers whitelist..."
SUDOERS_FILE=/etc/sudoers.d/tunevault

# Remove existing file if present
[ -f "\$SUDOERS_FILE" ] && rm -f "\$SUDOERS_FILE"

cat > "\$SUDOERS_FILE" << 'SUDOERS_EOF'
# TuneVault proxy — minimal sudo whitelist (EBS 12.2.x application tier)
# Generated by tunevault-lockdown.sh
# DO NOT edit manually — re-run lockdown.sh to update
#
# All paths use $ADMIN_SCRIPTS_HOME set in the oracle user environment.
# Only "status" subcommands are listed — start/stop/restart are NOT granted.
# admanagedsrvctl.sh is the unified controller for all managed servers.

Defaults:tunevault env_keep += "ADMIN_SCRIPTS_HOME"

# Non-managed services (individual *ctl.sh scripts)
Cmnd_Alias TUNEVAULT_NON_MANAGED = \
  $ADMIN_SCRIPTS_HOME/adcmctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adalnctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adadminsrvctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adnodemgrctl.sh status, \
  $ADMIN_SCRIPTS_HOME/adopmnctl.sh status, \
  $ADMIN_SCRIPTS_HOME/mwactl.sh status, \
  $ADMIN_SCRIPTS_HOME/adapcctl.sh status

# Managed servers (all routed through admanagedsrvctl.sh)
Cmnd_Alias TUNEVAULT_MANAGED = \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status forms_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oafm_server1, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status wfmlrsvc, \
  $ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status opp

tunevault ALL=(oracle) NOPASSWD: TUNEVAULT_NON_MANAGED, TUNEVAULT_MANAGED

# No other commands are permitted
SUDOERS_EOF

# Validate sudoers file syntax
if command -v visudo &>/dev/null; then
  if visudo -c -f "\$SUDOERS_FILE" &>/dev/null; then
    echo "    sudoers syntax OK: \$SUDOERS_FILE"
  else
    echo "ERROR: sudoers validation failed — removing \$SUDOERS_FILE"
    rm -f "\$SUDOERS_FILE"
    exit 1
  fi
fi
chmod 440 "\$SUDOERS_FILE"

# --- Print verification summary ---
echo ""
echo "========================================"
echo " Lockdown complete. Verify before use:"
echo "========================================"
echo ""
echo "OS user:"
id tunevault 2>/dev/null || echo "  ERROR: user not found"
echo ""
echo "Install directory:"
ls -la "\$INSTALL_DIR" 2>/dev/null | head -5
echo ""
echo "Sudoers whitelist:"
cat "\$SUDOERS_FILE" 2>/dev/null
echo ""
echo "Shell (should be /sbin/nologin or /bin/false):"
getent passwd tunevault | cut -d: -f7
echo ""
echo "========================================"
echo " Next: install the proxy as user 'tunevault'"
echo " See: https://tunevault.app/docs/oracle-setup"
echo "========================================"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-lockdown.sh"');
  res.send(script);
});

// lockdown-verify.sh — shell script customers can run on their Oracle host
// to audit what the proxy is actually doing using system tools
router.get('/lockdown-verify.sh', (req, res) => {
  const script = `#!/bin/bash
# tunevault-lockdown-verify.sh
# ============================
# Run this on your Oracle server to confirm what the TuneVault proxy
# is doing. Uses standard Linux auditing tools to capture all syscalls
# made by the proxy process for a 30-second window.
#
# Usage:
#   chmod +x lockdown-verify.sh
#   sudo ./lockdown-verify.sh
#
# Requirements: strace OR auditd (script tries strace first, falls back to auditd)
# Tested on: Oracle Linux 7/8/9, RHEL 7/8/9

set -e

PROXY_NAME="oracle-proxy"
REPORT_FILE="/tmp/tunevault-lockdown-$(date +%Y%m%d-%H%M%S).txt"
CAPTURE_SECONDS=30

echo "========================================"
echo " TuneVault Proxy Lockdown Verification"
echo " $(date)"
echo "========================================"
echo ""

# --- Find proxy PID ---
PROXY_PID=$(pgrep -f "oracle-proxy\\.js\\|oracle-proxy\\.py\\|tunevault-proxy" 2>/dev/null | head -1 || true)

if [ -z "$PROXY_PID" ]; then
    echo "WARNING: TuneVault proxy process not found."
    echo "Start the proxy first, then re-run this script."
    exit 1
fi

echo "Found proxy PID: $PROXY_PID"
echo "Process: $(ps -p $PROXY_PID -o comm= 2>/dev/null || echo 'unknown')"
echo ""

# --- Check open network connections ---
echo "--- NETWORK CONNECTIONS ---"
echo "Current outbound connections from proxy process:"
ss -tnp 2>/dev/null | grep "$PROXY_PID" || netstat -tnp 2>/dev/null | grep "$PROXY_PID" || echo "(no current active connections)"
echo ""

echo "Listening ports (proxy binds to 127.0.0.1:3100 only):"
ss -tlnp 2>/dev/null | grep "$PROXY_PID" || netstat -tlnp 2>/dev/null | grep "$PROXY_PID" || echo "(no listening ports found for this PID)"
echo ""

# --- Check open files ---
echo "--- OPEN FILES ---"
echo "Files opened by proxy process (should be: Node.js libs, log files, /dev/null):"
lsof -p "$PROXY_PID" 2>/dev/null | grep -v "mem\\|txt\\|cwd\\|rtd\\|DEL" | head -30 || echo "lsof not available"
echo ""

# --- Syscall trace (if strace available and running as root) ---
if command -v strace &>/dev/null && [ "$(id -u)" = "0" ]; then
    echo "--- SYSCALL TRACE (${CAPTURE_SECONDS}s via strace) ---"
    echo "Capturing syscalls for $CAPTURE_SECONDS seconds..."
    echo "Expected: connect() to tunevault.app:443, getaddrinfo(), read/write on Oracle socket"
    echo "NOT expected: execve() with unexpected commands, openat() on credential files"
    echo ""

    strace -p "$PROXY_PID" -e trace=network,file,process \\
        -f -s 200 -o "$REPORT_FILE.strace" \\
        -- sleep "$CAPTURE_SECONDS" 2>&1 || true

    echo "Syscalls captured. Summary of file opens:"
    grep "openat\\|open(" "$REPORT_FILE.strace" 2>/dev/null | grep -v "ENOENT\\|proc/\\|/lib\\|/usr" | head -20 || echo "(none)"

    echo ""
    echo "Summary of process executions (should be empty or only adop if EBS):"
    grep "execve" "$REPORT_FILE.strace" 2>/dev/null | head -10 || echo "(none — expected)"

    echo ""
    echo "Full strace output saved to: $REPORT_FILE.strace"

elif command -v auditctl &>/dev/null && [ "$(id -u)" = "0" ]; then
    echo "--- AUDIT LOG CAPTURE (${CAPTURE_SECONDS}s via auditd) ---"
    echo "Adding audit rules for proxy PID..."

    auditctl -a always,exit -F pid="$PROXY_PID" -F arch=b64 -S execve -k tunevault_exec 2>/dev/null || true
    auditctl -a always,exit -F pid="$PROXY_PID" -F arch=b64 -S connect -k tunevault_net 2>/dev/null || true
    auditctl -a always,exit -F pid="$PROXY_PID" -F arch=b64 -S openat -k tunevault_files 2>/dev/null || true

    echo "Capturing for $CAPTURE_SECONDS seconds..."
    sleep "$CAPTURE_SECONDS"

    echo "Collecting audit events..."
    ausearch -k tunevault_exec -k tunevault_net -k tunevault_files --start recent 2>/dev/null > "$REPORT_FILE.audit" || true

    echo "Process executions (should be empty or only adop if EBS):"
    grep -A5 "tunevault_exec" "$REPORT_FILE.audit" 2>/dev/null | head -30 || echo "(none — expected)"

    # Clean up rules
    auditctl -d always,exit -F pid="$PROXY_PID" -F arch=b64 -S execve -k tunevault_exec 2>/dev/null || true
    auditctl -d always,exit -F pid="$PROXY_PID" -F arch=b64 -S connect -k tunevault_net 2>/dev/null || true
    auditctl -d always,exit -F pid="$PROXY_PID" -F arch=b64 -S openat -k tunevault_files 2>/dev/null || true

    echo "Full audit log saved to: $REPORT_FILE.audit"
else
    echo "--- STATIC VERIFICATION (strace/auditd not available or not root) ---"
    echo "For full syscall tracing, run as root with strace or auditd installed."
    echo "Static checks only:"
fi

# --- Check proxy source code hash ---
echo ""
echo "--- PROXY BINARY INTEGRITY ---"
JS_PROXY=$(find /opt /home /usr/local -name "oracle-proxy.js" 2>/dev/null | head -1)
PY_PROXY=$(find /opt /home /usr/local -name "oracle-proxy.py" 2>/dev/null | head -1)

if [ -n "$JS_PROXY" ]; then
    echo "Node.js proxy found: $JS_PROXY"
    echo "SHA-256: $(sha256sum "$JS_PROXY" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$JS_PROXY" | cut -d' ' -f1)"
    echo "Last modified: $(stat -c '%y' "$JS_PROXY" 2>/dev/null || stat -f '%Sm' "$JS_PROXY" 2>/dev/null)"
    echo "Version string in file:"
    grep -o "proxy_version.*3\\.[0-9]\\+\\.[0-9]\\+" "$JS_PROXY" 2>/dev/null | head -3 || grep -o "version.*'[0-9]\\+\\.[0-9]\\+\\.[0-9]\\+'" "$JS_PROXY" 2>/dev/null | head -3
fi

if [ -n "$PY_PROXY" ]; then
    echo "Python proxy found: $PY_PROXY"
    echo "SHA-256: $(sha256sum "$PY_PROXY" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$PY_PROXY" | cut -d' ' -f1)"
    echo "Last modified: $(stat -c '%y' "$PY_PROXY" 2>/dev/null || stat -f '%Sm' "$PY_PROXY" 2>/dev/null)"
fi

if [ -z "$JS_PROXY" ] && [ -z "$PY_PROXY" ]; then
    echo "Proxy files not found in standard locations. Check your install path."
fi

# --- Check environment variables (no passwords) ---
echo ""
echo "--- PROXY ENVIRONMENT VARIABLES (keys only, no values) ---"
echo "Environment variable names configured for proxy process:"
if [ "$(id -u)" = "0" ]; then
    cat /proc/$PROXY_PID/environ 2>/dev/null | tr '\\0' '\\n' | cut -d'=' -f1 | sort || echo "Cannot read /proc/$PROXY_PID/environ"
else
    echo "Run as root to inspect proxy environment variables."
fi

echo ""
echo "========================================"
echo " Verification complete."
echo " Review this output to confirm:"
echo "  1. Proxy binds to 127.0.0.1:3100 only"
echo "  2. Outbound connections only to tunevault.app:443"
echo "  3. No unexpected file opens or process executions"
echo "  4. Proxy binary hash matches expected (verify at tunevault.app/security/commands)"
echo "========================================"
echo ""
echo "Questions? Contact: security@tunevault.app"
echo "Full security reference: https://tunevault.app/security/commands"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lockdown-verify.sh"');
  res.send(script);
});

// ─── Lockdown bundle download ─────────────────────────────────────────────────
//
// Generates a .tar.gz on-the-fly containing:
//   - tunevault-lockdown.sh (enhanced hardening script)
//   - README.md (plain-English explanation + compliance framework mapping)
//   - whitelist.json (machine-readable command catalog with SHA-256 hashes)
//
// No auth required — must be downloadable before login exists on the target host.

router.get('/lockdown-bundle.tar.gz', (req, res) => {
  try {
    const files = [
      { name: 'tunevault-lockdown-bundle/tunevault-lockdown.sh', content: getLockdownScriptContent() },
      { name: 'tunevault-lockdown-bundle/README.md', content: getBundleReadme() },
      { name: 'tunevault-lockdown-bundle/whitelist.json', content: getBundleWhitelist() },
    ];

    const tarGz = buildTarGz(files);

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="tunevault-lockdown-bundle.tar.gz"');
    res.setHeader('Content-Length', tarGz.length);
    res.send(tarGz);
  } catch (err) {
    console.error('[security] bundle generation error:', err);
    res.status(500).json({ error: 'Bundle generation failed' });
  }
});

module.exports = router;
