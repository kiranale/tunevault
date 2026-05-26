#!/usr/bin/env bash
# check-no-direct-connect.sh
# ----------------------------
# Architecture rule: no direct-connect testing endpoints.
# Fails the build if any banned patterns appear in source files.
#
# Banned patterns:
#   /api/test        — retired direct-connect testing endpoint (410 since v3.5.7)
#                      (tightly anchored to avoid matching /api/test-harness)
#   X-Api-Key:       — inbound API key header in curl examples / customer docs
#   curl.*-X POST.*proxy — curl direct-post to proxy URL in docs
#
# Exempted files (contain the patterns legitimately):
#   oracle-proxy.py          — contains the 410 tombstone itself
#   scripts/ci/check-no-direct-connect.sh — this file
#   CLAUDE.md                — documents the rule; mentions the patterns
#   ARCHITECTURE_RULES.md    — defines the rule; mentions the patterns

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

FAILED=0

# Files to scan: customer-facing HTML, install scripts, markdown docs, JS source
# Excludes:
#   oracle-proxy.py / oracle-proxy.js — contain the 410 tombstone itself
#   check-no-direct-connect.sh       — this file
#   CLAUDE.md / ARCHITECTURE_RULES.md — document the rule (reference banned patterns)
SCAN_FILES=$(find . \
  \( -name "*.html" -o -name "*.sh" -o -name "*.md" -o -name "*.js" \) \
  -not -path './.git/*' \
  -not -path './node_modules/*' \
  -not -name 'oracle-proxy.py' \
  -not -name 'oracle-proxy.js' \
  -not -name 'check-no-direct-connect.sh' \
  -not -name 'CLAUDE.md' \
  -not -name 'ARCHITECTURE_RULES.md' \
  2>/dev/null | sort)

if [ -z "$SCAN_FILES" ]; then
  echo "PASS: no files to scan"
  exit 0
fi

check_pattern() {
  local label="$1"
  local pattern="$2"
  local matches
  matches=$(echo "$SCAN_FILES" | xargs grep -lnE "$pattern" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "FAIL [$label]: banned pattern found in:"
    echo "$matches" | sed 's/^/  /'
    FAILED=1
  else
    echo "PASS [$label]"
  fi
}

# Tightly anchor /api/test to avoid matching /api/test-harness:
#   - "'/api/test'" or '"/api/test"' (quoted in HTML/JS)
#   - '/api/test'  (in curl commands)
#   - path: '/api/test' (in JS object literals / comments about the old endpoint)
check_pattern "/api/test endpoint (exact match)"  "(path[[:space:]]*:[[:space:]]*['\"]|['\"])[/]api/test['\"]"

# X-Api-Key header in customer-facing curl examples (not in internal auth code)
check_pattern "X-Api-Key header in curl docs"     "curl.*X-Api-Key"

# curl -X POST directly to a customer proxy host (e.g. oracledb.customer.com or localhost:3100)
# The pattern excludes cloud admin endpoints (tunevault.app/api/admin/proxy/*)
check_pattern "curl direct-POST to on-prem proxy" "curl[^'\">]*-X POST[^'\">]*(localhost|:3100|/api/test[^-])"

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Architecture rule violated: no direct-connect testing endpoints."
  echo "See ARCHITECTURE_RULES.md § 'No direct-connect testing endpoints'"
  echo "for the rule and the allowed replacements."
  exit 1
fi

echo ""
echo "All direct-connect checks passed."
exit 0
