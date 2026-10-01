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

# Drag-to-install layout. The volume is named so dmg-layout.applescript can
# address it, and mounted at the matching /Volumes path so Finder sees it as a
# disk it can open.
VOLUME_NAME="TypeByVoice"
MOUNT_POINT="/Volumes/$VOLUME_NAME"
INSTALLER_DIR="$MACOS_ROOT/Installer"
BG_BASE="$INSTALLER_DIR/dmg-background"
RW_DMG="$DIST_DIR/.TypeByVoice-rw.dmg"

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

# --- Preflight for the layout phase ------------------------------------------
# Both checks run before the (slow) Release build, so a missing prerequisite
# costs seconds rather than a full build.

# Styling the window means driving Finder, which means this process must be
# allowed to send AppleEvents. A sandboxed or agent-run shell never is: it gets
# "a privilege violation occurred. (-10004)".
if ! osascript -e 'tell application "Finder" to get name of startup disk' >/dev/null 2>&1; then
  echo "error: cannot control Finder (AppleEvents refused, -10004)." >&2
  echo "  Run this script from a normal Terminal window and allow the" >&2
  echo "  \"... wants access to control Finder\" prompt, or grant it under" >&2
  echo "  System Settings > Privacy & Security > Automation." >&2
  exit 1
fi

for f in "$BG_BASE.png" "$BG_BASE@2x.png"; do
  if [[ ! -f "$f" ]]; then
    echo "error: missing $f — run: swift macos/Scripts/make-dmg-background.swift" >&2
    exit 1
  fi
done

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

# --- Layout phase: writable image → Finder view settings → compressed image ---

TIFF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tbv-dmg-bg.XXXXXX")"
trap 'hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true; rm -rf "$TIFF_DIR" "$STAGE" "$RW_DMG"' EXIT

# HiDPI TIFF so Finder draws the arrow crisply on Retina instead of upscaling
# the 1x PNG.
tiffutil -cathidpicheck "$BG_BASE.png" "$BG_BASE@2x.png" -out "$TIFF_DIR/dmg-background.tiff" >/dev/null

# dmg-layout.applescript addresses the volume by name, so EVERY volume named
# TypeByVoice has to be gone before we mount ours: a stale one is a read-only
# mount of an older DMG, so the layout would fail on it or land on the wrong
# volume. (Three of them were sitting in /Volumes on the machine this was
# written on, and matching the exact path alone covered only one.)
for stale in /Volumes/$VOLUME_NAME*(N); do
  echo "==> Detaching stale mount at $stale"
  hdiutil detach "$stale" >/dev/null 2>&1 || rmdir "$stale" 2>/dev/null || true
done

rm -f "$RW_DMG" "$DMG_PATH"
echo "==> Creating writable image"
# -format UDRW has no diskutil equivalent (diskutil image create from accepts
# only ASIF/RAW/UDRO/UDSB/UDZO/ULFO/ULMO), so hdiutil stays for this one step.
hdiutil create -volname "$VOLUME_NAME" -srcfolder "$STAGE" -ov -format UDRW "$RW_DMG" >/dev/null

echo "==> Mounting and applying layout"
hdiutil attach "$RW_DMG" -nobrowse -noautoopen -readwrite -mountpoint "$MOUNT_POINT" >/dev/null
mkdir -p "$MOUNT_POINT/.background"
cp "$TIFF_DIR/dmg-background.tiff" "$MOUNT_POINT/.background/dmg-background.tiff"
osascript "$MACOS_ROOT/Scripts/dmg-layout.applescript" "$VOLUME_NAME"
sync && sleep 2   # Finder writes .DS_Store lazily; do not detach before it lands
hdiutil detach "$MOUNT_POINT" >/dev/null

rm -f "$DMG_PATH"
echo "==> Creating $DMG_PATH (API=${TBV_API_URL})"
# Non-deprecated equivalent: diskutil image create from "$RW_DMG" --format UDZO "$DMG_PATH"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null

echo "==> Done: $DMG_PATH"
echo "note: unsigned — tell recipients: right-click TypeByVoice → Open (Gatekeeper)"
echo "next: ./macos/Scripts/publish-dmg-release.sh \"$DMG_PATH\""
