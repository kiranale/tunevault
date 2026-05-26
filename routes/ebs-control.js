/**
 * routes/ebs-control.js — EBS Control Command catalog API.
 *
 * Owns: /api/ebs-control/* endpoints (catalog + preview).
 * Does NOT own: command execution (Phase 3), auth state, Oracle connections,
 *               sanity checks, live status — those live in routes/ebs-deep.js.
 *
 * Security model:
 *   - All slug validation is server-side against ebs_control_commands table.
 *   - User input NEVER flows into the rendered shell command.
 *   - All preview attempts (allowed + rejected) are written to audit_log.
 *   - Non-whitelisted slugs return HTTP 403, never 404 (avoids enumeration hint).
 *
 * Mounted at: /api/ebs-control (see server.js)
 *
 * Routes:
 *   GET  /api/ebs-control/catalog   — return full command whitelist (no execution)
 *   POST /api/ebs-control/preview   — render exact shell command for a slug
 */

'use strict';

const express = require('express');

const { getCatalog, getCommandBySlug, writeAuditLog } = require('../db/ebs-control');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/ebs-control/catalog
 *
 * Returns the full whitelist from ebs_control_commands.
 * shell_template is included so the UI can show the command shape.
 * No request body accepted — catalog is read-only from DB.
 */
// senior_dba+ required for all EBS control operations
router.get('/catalog', requireAuth, requireRole('senior_dba'), async (req, res) => {
  try {
    const commands = await getCatalog();
    res.json({ commands });
  } catch (err) {
    console.error('[ebs-control] catalog error:', err);
    res.status(500).json({ error: 'Failed to load command catalog' });
  }
});

/**
 * POST /api/ebs-control/preview
 *
 * Body: { slug: string }
 *
 * Validates slug against ebs_control_commands. Returns the rendered shell
 * command with placeholder vars substituted from connection metadata — never
 * from the request body.
 *
 * Template var substitution:
 *   {{APPS_PASSWORD}}  → literal placeholder string (never a real secret)
 *   {{INSTANCE_NAME}}  → 'YOUR_INSTANCE' placeholder (live value comes from Phase 3)
 *
 * Rejected slugs: HTTP 403 + audit_log row with allowed=false.
 * Allowed slugs: HTTP 200 + audit_log row with allowed=true.
 */
router.post('/preview', requireAuth, requireRole('senior_dba'), async (req, res) => {
  const { slug } = req.body || {};

  // Validate slug is a non-empty string before hitting the DB
  if (!slug || typeof slug !== 'string' || slug.length > 100) {
    await writeAuditLog({
      userId: req.user?.id,
      action: 'ebs_control.preview',
      slug: String(slug || '').slice(0, 100),
      allowed: false,
      rejectionReason: 'invalid_slug_format',
      metadata: { ip: req.ip, ua: req.headers['user-agent'] }
    }).catch(() => {}); // audit write failure must not surface to client
    return res.status(400).json({ error: 'slug is required and must be a string' });
  }

  const slugClean = slug.trim().toLowerCase();

  try {
    const cmd = await getCommandBySlug(slugClean);

    if (!cmd) {
      // Reject immediately — do NOT reveal whether the slug is "close"
      await writeAuditLog({
        userId: req.user.id,
        action: 'ebs_control.preview',
        slug: slugClean,
        allowed: false,
        rejectionReason: 'slug_not_in_whitelist',
        metadata: { ip: req.ip, ua: req.headers['user-agent'] }
      }).catch(() => {});

      console.warn(`[ebs-control] REJECTED preview attempt: slug="${slugClean}" user=${req.user.id}`);
      return res.status(403).json({ error: 'Command not permitted', slug: slugClean });
    }

    // Render shell — template vars are placeholder strings, not real secrets.
    // Real credentials never flow through the web tier in Phase 1/2.
    const rendered = cmd.shell_template
      .replace(/\{\{APPS_PASSWORD\}\}/g, '<apps_password>')
      .replace(/\{\{INSTANCE_NAME\}\}/g, 'YOUR_INSTANCE');

    await writeAuditLog({
      userId: req.user.id,
      action: 'ebs_control.preview',
      slug: slugClean,
      allowed: true,
      rejectionReason: null,
      metadata: { ip: req.ip, ua: req.headers['user-agent'], risk_level: cmd.risk_level }
    }).catch(() => {});

    res.json({
      slug: cmd.slug,
      label: cmd.label,
      category: cmd.category,
      risk_level: cmd.risk_level,
      shell: rendered,
      description: cmd.description,
      expected_effect: cmd.expected_effect,
      rollback_steps: cmd.rollback_steps,
      phase: 'dry_run',
      note: 'Phase 1 — command display only. No execution occurs. Live SSH requires the customer-installed lockdown agent (Phase 3).'
    });
  } catch (err) {
    console.error('[ebs-control] preview error:', err);
    res.status(500).json({ error: 'Preview failed' });
  }
});

// ─── Whitelist hash catalog ───────────────────────────────────────────────────
//
// SHA-256 hashes of the v1 rendered shell commands (placeholders substituted).
// These are the hashes the customer lockdown script validates against.
// If the catalog changes, update this list and re-distribute the lockdown script.
//
// Hash computed over the rendered command string (after placeholder substitution),
// not the raw shell_template. Re-compute with:
//   echo -n '<rendered_command>' | sha256sum
const WHITELIST_HASHES = [
  { slug: 'cm_bounce',        hash: '071adb4256701920f027fb273f250af38192b90e50366fbeba00f418bc46f57c', label: 'Concurrent Manager — Bounce' },
  { slug: 'wf_mailer_restart',hash: '00f5e37d47b96644b419677c64714c715388cb3c05c1d22412cc13ae3abd2c5f', label: 'Workflow Mailer — Restart' },
  { slug: 'oacore_bounce',    hash: '19db054a0fe7ee121b57925534a75c8469878578796cdcfafa9c3c936d5ebcd8', label: 'OACore — Bounce' },
  { slug: 'opp_kick',         hash: '33849633c1146dcb59925c41f1b1c60df3518b306d00fbb7b473b4b5ab30f309', label: 'OPP — Kick Stuck Sessions' },
  { slug: 'recompile_invalids',hash:'c5b6cd4ca6b76bf26fb86eb73a41043c98edd9745bae8dc8df9e873962d6d703', label: 'Recompile Invalid Objects' },
];

/**
 * GET /api/ebs-control/whitelist-hashes.txt
 *
 * Plaintext file of SHA-256 hashes for each whitelisted command.
 * Security teams diff this against the catalog to verify no unauthorized
 * commands have been added. No auth required — public trust document.
 */
router.get('/whitelist-hashes.txt', (req, res) => {
  const lines = [
    '# TuneVault EBS Control — Command Whitelist SHA-256 Hashes',
    '# Version: v1 (2026-05-11)',
    '# Source:  https://tunevault.app/api/ebs-control/catalog',
    '# Format:  <sha256>  <slug>  # <label>',
    '# Hashes computed over rendered shell command (placeholders substituted).',
    '#',
    ...WHITELIST_HASHES.map(e => `${e.hash}  ${e.slug}  # ${e.label}`)
  ];
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-whitelist-hashes.txt"');
  res.send(lines.join('\n') + '\n');
});

/**
 * GET /api/ebs-control/lockdown.sh
 *
 * Bash script the customer runs on their EBS app tier as root (once).
 * Creates a restricted shell wrapper that only accepts commands matching
 * the published SHA-256 whitelist hashes, then outputs an RSA public key
 * the customer pastes into TuneVault to establish the Phase 3 trust handshake.
 *
 * No auth required — must be downloadable before login exists on the target host.
 * Security: the script itself does nothing until run by the customer on their own server.
 */
router.get('/lockdown.sh', (req, res) => {
  // Hash list embedded so the script is self-contained
  const hashLines = WHITELIST_HASHES.map(e =>
    `  "${e.hash}"  # ${e.slug}: ${e.label}`
  ).join('\n');

  const script = `#!/usr/bin/env bash
# tunevault-lockdown.sh — EBS Control Tier Hardening Script
# Version: v1 (2026-05-11)
# Run as: sudo ./tunevault-lockdown.sh
# Purpose: Creates a restricted shell wrapper on the EBS app tier that only
#          accepts commands whose SHA-256 hashes match the published whitelist.
#          After installation, outputs an RSA public key to paste into TuneVault
#          so Phase 3 SSH control can establish the trust handshake.
#
# Requirements: bash 4+, openssl, sudo/root access, runs as root

set -euo pipefail

TUNEVAULT_USER="tunevault"
INSTALL_DIR="\${1:-/opt/tunevault}"
KEY_DIR="\${INSTALL_DIR}/keys"
WRAPPER="\${INSTALL_DIR}/bin/tv-exec"
WHITELIST_FILE="\${INSTALL_DIR}/whitelist-hashes.txt"

# ─── Whitelist (SHA-256 of rendered commands) ─────────────────────────────────
# These must match https://tunevault.app/api/ebs-control/whitelist-hashes.txt
# Re-download and diff before running: curl -sL https://tunevault.app/api/ebs-control/whitelist-hashes.txt
ALLOWED_HASHES=(
${hashLines}
)

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ \$EUID -ne 0 ]]; then
  echo "ERROR: Run as root: sudo ./tunevault-lockdown.sh" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || {
  echo "ERROR: sha256sum or shasum required" >&2; exit 1
}

sha256() { sha256sum "\$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "\$1" | cut -d' ' -f1; }
sha256_str() { echo -n "\$1" | sha256sum 2>/dev/null | cut -d' ' -f1 || echo -n "\$1" | shasum -a 256 | cut -d' ' -f1; }

echo "[1/5] Creating TuneVault system user: \${TUNEVAULT_USER}"
if ! id "\${TUNEVAULT_USER}" &>/dev/null; then
  useradd --system --no-create-home --shell /sbin/nologin "\${TUNEVAULT_USER}"
  echo "      User created."
else
  echo "      User already exists — skipping."
fi

echo "[2/5] Creating install directory: \${INSTALL_DIR}"
mkdir -p "\${INSTALL_DIR}/bin" "\${KEY_DIR}"
chown -R "\${TUNEVAULT_USER}:\${TUNEVAULT_USER}" "\${INSTALL_DIR}"
chmod 750 "\${INSTALL_DIR}" "\${INSTALL_DIR}/bin" "\${KEY_DIR}"

echo "[3/5] Writing whitelist hash file: \${WHITELIST_FILE}"
cat > "\${WHITELIST_FILE}" << 'HASHEOF'
# TuneVault EBS Control — Command Whitelist SHA-256 Hashes (embedded in lockdown.sh)
# Verify against: https://tunevault.app/api/ebs-control/whitelist-hashes.txt
${hashLines}
HASHEOF
chmod 640 "\${WHITELIST_FILE}"
chown "\${TUNEVAULT_USER}:\${TUNEVAULT_USER}" "\${WHITELIST_FILE}"

echo "[4/5] Installing restricted command wrapper: \${WRAPPER}"
cat > "\${WRAPPER}" << 'WRAPEOF'
#!/usr/bin/env bash
# tv-exec — TuneVault restricted shell wrapper
# Only executes commands whose SHA-256 hash appears in the installed whitelist.
set -euo pipefail
CMD="\$*"
WHITELIST="\${INSTALL_DIR}/whitelist-hashes.txt"
sha256_str() { echo -n "\$1" | sha256sum 2>/dev/null | cut -d' ' -f1 || echo -n "\$1" | shasum -a 256 | cut -d' ' -f1; }
CMD_HASH=\$(sha256_str "\$CMD")
if ! grep -q "^\${CMD_HASH}" "\${WHITELIST}" 2>/dev/null; then
  logger -t tunevault "REJECTED command hash=\${CMD_HASH} cmd=\${CMD}"
  echo "tv-exec: command not in whitelist" >&2
  exit 126
fi
logger -t tunevault "ALLOWED command hash=\${CMD_HASH}"
eval "\$CMD"
WRAPEOF
# Embed the install dir into the wrapper
sed -i "s|INSTALL_DIR=\\\"\\${INSTALL_DIR}\\\"|INSTALL_DIR=\\"${INSTALL_DIR}\\"|g" "\${WRAPPER}" 2>/dev/null || true
chmod 750 "\${WRAPPER}"
chown "\${TUNEVAULT_USER}:\${TUNEVAULT_USER}" "\${WRAPPER}"

echo "[5/5] Generating RSA key pair for Phase 3 trust handshake"
PRIVATE_KEY="\${KEY_DIR}/tunevault.key"
PUBLIC_KEY="\${KEY_DIR}/tunevault.pub"
if [[ ! -f "\${PRIVATE_KEY}" ]]; then
  openssl genrsa -out "\${PRIVATE_KEY}" 4096 2>/dev/null
  openssl rsa -in "\${PRIVATE_KEY}" -pubout -out "\${PUBLIC_KEY}" 2>/dev/null
  chmod 600 "\${PRIVATE_KEY}"
  chmod 644 "\${PUBLIC_KEY}"
  chown "\${TUNEVAULT_USER}:\${TUNEVAULT_USER}" "\${PRIVATE_KEY}" "\${PUBLIC_KEY}"
  echo "      Key pair generated."
else
  echo "      Key pair already exists — skipping generation."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " TuneVault lockdown script complete."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " NEXT STEP: Paste the public key below into TuneVault to activate Phase 3."
echo " Navigate to: EBS Deep Mode → Control tab → 'Activate live execution'"
echo ""
echo "────────────────────────── PUBLIC KEY (copy this) ──────────────────────"
cat "\${PUBLIC_KEY}"
echo "────────────────────────────────────────────────────────────────────────"
echo ""
echo " Wrapper installed at: \${WRAPPER}"
echo " Whitelist file:       \${WHITELIST_FILE}"
echo " Private key:          \${PRIVATE_KEY} (KEEP THIS SECRET — never leave the server)"
echo ""
echo " Security review: https://tunevault.app/api/ebs-control/whitelist-hashes.txt"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tunevault-lockdown.sh"');
  res.send(script);
});

module.exports = router;
