#!/usr/bin/env bash
# tag-release.sh — Create an annotated git tag for a TuneVault release.
# Usage: ./tag-release.sh <version> <description>
# Example: ./tag-release.sh 3.6.1 post-proxy-rewrite
# Example: ./tag-release.sh 3.6.0 baseline-2026-05-17
#
# Tags are annotated (carry a message) so they show up in `git describe` output
# and are pushed explicitly. Lightweight tags are never used for releases.

set -e

VERSION="${1}"
DESCRIPTION="${2}"

if [ -z "$VERSION" ] || [ -z "$DESCRIPTION" ]; then
  echo "Usage: $0 <version> <description>"
  echo ""
  echo "Examples:"
  echo "  $0 3.6.0 baseline-2026-05-17"
  echo "  $0 3.6.1 pre-proxy-rewrite"
  echo "  $0 3.6.2 stable-installer"
  echo ""
  echo "Convention: v{version}-{description}"
  echo "  baseline-{date}   — last-known-good snapshot before a work session"
  echo "  pre-{task-id}     — snapshot before a specific engineering task"
  echo "  stable-{feature}  — confirmed working state after a feature ships"
  exit 1
fi

TAG="v${VERSION}-${DESCRIPTION}"
DATE=$(date +%Y-%m-%d)
COMMIT=$(git rev-parse --short HEAD)

echo "Tagging commit ${COMMIT} as ${TAG}..."

git tag -a "${TAG}" -m "Release ${TAG} — ${DATE} — commit ${COMMIT}"

echo ""
echo "✓ Created tag: ${TAG}"
echo ""
echo "To push this tag to GitHub:"
echo "  git push origin ${TAG}"
echo ""
echo "To push ALL local tags:"
echo "  git push origin --tags"
echo ""
echo "IMPORTANT: Add an entry to docs/deploy-log.md before pushing."
