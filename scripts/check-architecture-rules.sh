#!/usr/bin/env bash
# scripts/check-architecture-rules.sh
#
# Enforces architecture invariants defined in docs/ARCHITECTURE_RULES.md.
# Exits 1 with a clear message if any forbidden pattern is found in customer-facing paths.
# Run automatically by .github/workflows/architecture.yml on every PR.
#
# Usage:
#   bash scripts/check-architecture-rules.sh        # check all customer-facing files
#   bash scripts/check-architecture-rules.sh --fix  # (not implemented — fix manually)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RULES_DOC="docs/ARCHITECTURE_RULES.md"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

echo ""
echo -e "${BOLD}Architecture Rules Check${NC}"
echo "  Reference: ${RULES_DOC}"
echo ""

# ── Rule 1: No Cloudflare/tunnel in customer-facing paths ──────────────────
#
# Forbidden strings. All matched case-insensitively against customer-path files.
FORBIDDEN_PATTERNS=(
  "cloudflared"
  "cloudflare-tunnel"
  "tunevault-tunnel\\.service"
  "cf_enabled"
  "cf_tunnel"
  "trycloudflare"
  "cfargotunnel\\.com"
)

# Customer-facing file globs — everything the product serves to users.
# Exclusions:
#   - docs/ARCHITECTURE_RULES.md itself (lists the forbidden patterns by design)
#   - scripts/check-architecture-rules.sh itself (same reason)
#   - scripts/personal-lab/** (Kiran's dev scripts, never shipped)
#   - docs/internal/** (internal notes)
#   - node_modules/
#   - .git/
CUSTOMER_PATH_GLOBS=(
  "*.js"
  "*.html"
  "*.sh"
  "*.py"
  "*.ts"
  "*.md"
  "*.yml"
  "*.yaml"
  "*.json"
  "routes/*.js"
  "services/*.js"
  "db/*.js"
  "middleware/*.js"
  "public/**"
  "migrations/*.js"
  "config/*.js"
)

VIOLATIONS=0

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  # Build the grep command: search all tracked files, excluding known-safe paths
  matches=$(grep -rniE "$pattern" "${REPO_ROOT}" \
    --include="*.js" \
    --include="*.html" \
    --include="*.sh" \
    --include="*.py" \
    --include="*.ts" \
    --include="*.md" \
    --include="*.yml" \
    --include="*.yaml" \
    2>/dev/null \
    | grep -v "node_modules/" \
    | grep -v "\.git/" \
    | grep -v "package-lock\.json" \
    | grep -v "scripts/check-architecture-rules\.sh" \
    | grep -v "docs/ARCHITECTURE_RULES\.md" \
    | grep -v "scripts/personal-lab/" \
    | grep -v "docs/internal/" \
    || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}❌ Cloudflare/tunnel reference found (Rule 1)${NC}"
    echo "   Pattern: ${pattern}"
    echo ""
    while IFS= read -r line; do
      # Extract file:lineno for clean output
      file_line=$(echo "$line" | sed "s|${REPO_ROOT}/||")
      echo -e "   ${YELLOW}${file_line}${NC}"
    done <<< "$matches"
    echo ""
    echo -e "   See: ${BOLD}${RULES_DOC}${NC}"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# ── Rule 2: No Oracle client deps in agent/ (v6 thin-mode guarantee) ──────────
#
# The entire point of v6 is zero Oracle client. These patterns in agent/*.py or
# install-v6.sh mean we regressed to the Oracle Instant Client nightmare.
AGENT_FORBIDDEN_PATTERNS=(
  "ORACLE_HOME"
  "LD_LIBRARY_PATH"
  "libclntsh"
  "init_oracle_client"
  "cx_Oracle"
)

for pattern in "${AGENT_FORBIDDEN_PATTERNS[@]}"; do
  # Exclude comment lines (# ...) and string literals documenting what we're NOT doing
  matches=$(grep -rniE "$pattern" "${REPO_ROOT}/agent" "${REPO_ROOT}/install-v6.sh" \
    2>/dev/null \
    | grep -v "scripts/check-architecture-rules\.sh" \
    | grep -Ev "^[^:]+:[0-9]+:[[:space:]]*#" \
    | grep -iv "do not call\|do not\|no oracle_home\|no libclntsh\|no ld_library\|remove oracledb\|uninstall oracle\|anywhere in this package" \
    || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}❌ Oracle client dependency found in agent/ (Rule 2 — v6 thin-mode)${NC}"
    echo "   Pattern: ${pattern}"
    echo ""
    while IFS= read -r line; do
      file_line=$(echo "$line" | sed "s|${REPO_ROOT}/||")
      echo -e "   ${YELLOW}${file_line}${NC}"
    done <<< "$matches"
    echo ""
    echo "   agent/ must use python-oracledb thin mode only. No ORACLE_HOME."
    echo "   See: agent/db.py for the correct pattern."
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# ── Rule 3: No hardcoded test SIDs (stale lab artifacts) ─────────────────
#
# These SIDs appeared only in a dev lab and should never be committed to code.
# Their presence in any source file means stale data leaked from a test box.
# Added after bug #1670982 (stale SID poisoning probe 5).
HARDCODED_SID_PATTERNS=(
  "ebscdb"
  "ebsdb"
)

for pattern in "${HARDCODED_SID_PATTERNS[@]}"; do
  matches=$(grep -rniE "\\b${pattern}\\b" "${REPO_ROOT}" \
    --include="*.js" \
    --include="*.html" \
    --include="*.sh" \
    --include="*.py" \
    --include="*.ts" \
    --include="*.json" \
    2>/dev/null \
    | grep -v "node_modules/" \
    | grep -v "\.git/" \
    | grep -v "package-lock\.json" \
    | grep -v "scripts/check-architecture-rules\.sh" \
    | grep -v "docs/ARCHITECTURE_RULES\.md" \
    | grep -v "todos/" \
    | grep -v "docs/internal/" \
    || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}❌ Hardcoded test SID found (Rule 3 — stale lab artifact)${NC}"
    echo "   Pattern: ${pattern}"
    echo ""
    while IFS= read -r line; do
      file_line=$(echo "$line" | sed "s|${REPO_ROOT}/||")
      echo -e "   ${YELLOW}${file_line}${NC}"
    done <<< "$matches"
    echo ""
    echo "   These SIDs are test artifacts from ebs12210-db-dev. They must never appear in code."
    echo "   See: bug #1670982"
    echo ""
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ "$VIOLATIONS" -eq 0 ]; then
  echo -e "${GREEN}✓ All architecture rules pass — zero violations.${NC}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}Architecture check FAILED: ${VIOLATIONS} pattern(s) violated.${NC}"
  echo ""
  echo "  Fix: Remove the forbidden references or move them to:"
  echo "    scripts/personal-lab/  (dev-only scripts)"
  echo "    docs/internal/         (internal notes)"
  echo ""
  echo "  See docs/ARCHITECTURE_RULES.md for the full rule set."
  echo ""
  exit 1
fi
