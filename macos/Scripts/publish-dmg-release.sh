#!/bin/zsh
# Upload a packaged DMG to a public GitHub Release and print the download URL.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
DIST_DIR="${TBV_DIST_DIR:-$MACOS_ROOT/dist}"

DMG_PATH="${1:-}"
if [[ -z "$DMG_PATH" ]]; then
  DMG_PATH="$(ls -t "$DIST_DIR"/TypeByVoice-*.dmg 2>/dev/null | head -1 || true)"
fi
if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "error: no DMG found — run macos/Scripts/package-dmg.sh first (or pass a path)" >&2
  exit 1
fi

BASE="$(basename "$DMG_PATH" .dmg)"
VERSION_BUILD="${BASE#TypeByVoice-}"
TAG="macos-v${VERSION_BUILD}"
TITLE="TypeByVoice macOS ${VERSION_BUILD} (unsigned)"

NOTES="$(cat <<EOF
Unsigned / ad-hoc-signed macOS build for free sharing (not notarized).

**Install**
1. Download the \`.dmg\`, open it, drag TypeByVoice to Applications.
2. First launch: right-click TypeByVoice → **Open** (Gatekeeper).
3. Enable Microphone + Accessibility when prompted.

Endpoints were baked from the packager's \`macos/.env\` at build time.
EOF
)"

echo "==> Creating GitHub Release ${TAG} with $(basename "$DMG_PATH")"
gh release create "$TAG" "$DMG_PATH" \
  --title "$TITLE" \
  --notes "$NOTES"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ASSET="$(basename "$DMG_PATH")"
ASSET_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$ASSET")"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_ENC}"
echo "==> Public download URL:"
echo "$URL"
echo "    (or releases page: https://github.com/${REPO}/releases/tag/${TAG})"
