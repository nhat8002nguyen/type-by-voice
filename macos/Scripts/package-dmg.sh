#!/bin/zsh
# Build Release TypeByVoice (ad-hoc signed), bake endpoints from macos/.env into Info.plist, wrap in DMG.
# Not notarized — recipients must right-click → Open the first time.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
ENV_FILE="${TBV_ENV_FILE:-$MACOS_ROOT/.env}"
DERIVED_DATA="${TBV_DERIVED_DATA:-$MACOS_ROOT/DerivedData-Release}"
DIST_DIR="${TBV_DIST_DIR:-$MACOS_ROOT/dist}"
STAGE="$DIST_DIR/stage"
APP_SRC="$DERIVED_DATA/Build/Products/Release/TypeByVoice.app"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE — copy macos/.env.example to macos/.env and edit" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${TBV_API_URL:-}" || -z "${TBV_DICTATE_URL:-}" ]]; then
  echo "error: TBV_API_URL and TBV_DICTATE_URL must be set in $ENV_FILE" >&2
  exit 1
fi

cd "$MACOS_ROOT"
echo "==> Building Release → $DERIVED_DATA"
xcodebuild \
  -scheme TypeByVoice \
  -destination 'platform=macOS' \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  build

if [[ ! -d "$APP_SRC" ]]; then
  echo "error: Release app missing at $APP_SRC" >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_SRC/Contents/Info.plist")"
DMG_NAME="TypeByVoice-${VERSION}+${BUILD}.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$DIST_DIR"
ditto "$APP_SRC" "$STAGE/TypeByVoice.app"
PLIST="$STAGE/TypeByVoice.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :TBV_API_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :TBV_DICTATE_URL" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :TBV_API_URL string ${TBV_API_URL}" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :TBV_DICTATE_URL string ${TBV_DICTATE_URL}" "$PLIST"
# Re-sign ad-hoc after plist edit so the seal matches.
codesign --force --deep --sign - "$STAGE/TypeByVoice.app"
ln -sf /Applications "$STAGE/Applications"

rm -f "$DMG_PATH"
echo "==> Creating $DMG_PATH (API=${TBV_API_URL})"
hdiutil create \
  -volname "TypeByVoice" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGE"
echo "==> Done: $DMG_PATH"
echo "note: unsigned — tell recipients: right-click TypeByVoice → Open (Gatekeeper)"
echo "next: ./macos/Scripts/publish-dmg-release.sh \"$DMG_PATH\""
