#!/bin/zsh
# Upload a packaged DMG to the public releases repo and print the download URL.
# Default host: nhat8002nguyen/type-by-voice-releases (public). Override with TBV_RELEASE_REPO.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
DIST_DIR="${TBV_DIST_DIR:-$MACOS_ROOT/dist}"
RELEASE_REPO="${TBV_RELEASE_REPO:-nhat8002nguyen/type-by-voice-releases}"

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

App source stays in the private \`type-by-voice\` repo. This repo only hosts installers.
EOF
)"

echo "==> Creating GitHub Release ${TAG} on ${RELEASE_REPO} with $(basename "$DMG_PATH")"
gh release create "$TAG" "$DMG_PATH" \
  --repo "$RELEASE_REPO" \
  --title "$TITLE" \
  --notes "$NOTES"

ASSET="$(basename "$DMG_PATH")"
TAG_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TAG")"
ASSET_ENC="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ASSET")"
URL="https://github.com/${RELEASE_REPO}/releases/download/${TAG_ENC}/${ASSET_ENC}"
echo "==> Public download URL:"
echo "$URL"
echo "    (or releases page: https://github.com/${RELEASE_REPO}/releases/tag/${TAG_ENC})"
