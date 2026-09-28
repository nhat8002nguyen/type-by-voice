#!/bin/zsh
# Build Debug TypeByVoice, reset Accessibility (via Xcode phase + explicit call),
# and launch against the local backend.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
REPO_ROOT="${MACOS_ROOT:h}"
DERIVED_DATA="${TBV_DERIVED_DATA:-$MACOS_ROOT/DerivedData}"
APP="${DERIVED_DATA}/Build/Products/Debug/TypeByVoice.app"
BUNDLE_ID="app.typebyvoice.TypeByVoice"

export TBV_API_URL="${TBV_API_URL:-http://127.0.0.1:3000}"
export TBV_DICTATE_URL="${TBV_DICTATE_URL:-ws://127.0.0.1:3000/v1/dictate}"

echo "==> Killing existing TypeByVoice (if any)"
pkill -x TypeByVoice 2>/dev/null || true
sleep 0.3

echo "==> Building Debug → ${DERIVED_DATA}"
cd "$MACOS_ROOT"
xcodebuild \
  -scheme TypeByVoice \
  -destination 'platform=macOS' \
  -configuration Debug \
  -derivedDataPath "$DERIVED_DATA" \
  build

if [[ ! -d "$APP" ]]; then
  echo "error: app not found at $APP" >&2
  exit 1
fi

# Prefer this build in Launch Services so System Settings (Accessibility, etc.)
# resolves the real AppIcon. Other copies (worktrees, /tmp DerivedData) with the
# same bundle ID can win the Accessibility refresh and show a generic icon.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREG" ]]; then
  echo "==> Preferring $APP in Launch Services"
  while IFS= read -r other; do
    [[ -z "$other" || "$other" == "$APP" ]] && continue
    echo "    unregister $other"
    "$LSREG" -u "$other" >/dev/null 2>&1 || true
  done < <(mdfind "kMDItemCFBundleIdentifier == '${BUNDLE_ID}'" 2>/dev/null || true)
  "$LSREG" -f -R "$APP" >/dev/null 2>&1 || true
fi

echo "==> Resetting Accessibility for ${BUNDLE_ID}"
"${SCRIPT_DIR}/reset-accessibility.sh" "${BUNDLE_ID}"

echo "==> Launching $APP"
echo "    TBV_API_URL=${TBV_API_URL}"
echo "    TBV_DICTATE_URL=${TBV_DICTATE_URL}"
# open --env NAME alone sets an empty value; pass NAME=value explicitly.
open -n --env "TBV_API_URL=${TBV_API_URL}" --env "TBV_DICTATE_URL=${TBV_DICTATE_URL}" "$APP"
sleep 1
if pgrep -x TypeByVoice >/dev/null; then
  echo "==> Running (pid $(pgrep -n -x TypeByVoice))"
  echo "note: re-enable TypeByVoice in System Settings → Privacy & Security → Accessibility"
else
  echo "error: TypeByVoice did not start" >&2
  exit 1
fi
