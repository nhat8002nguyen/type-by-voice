#!/bin/zsh
# Launch the current Debug TypeByVoice build (no rebuild, no Accessibility reset).
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
DERIVED_DATA="${TBV_DERIVED_DATA:-$MACOS_ROOT/DerivedData}"
APP="${DERIVED_DATA}/Build/Products/Debug/TypeByVoice.app"

export TBV_API_URL="${TBV_API_URL:-http://127.0.0.1:3000}"
export TBV_DICTATE_URL="${TBV_DICTATE_URL:-ws://127.0.0.1:3000/v1/dictate}"

if [[ ! -d "$APP" ]]; then
  echo "error: no Debug build at $APP" >&2
  echo "hint: run macos/Scripts/build-and-run.sh first" >&2
  exit 1
fi

echo "==> Killing existing TypeByVoice (if any)"
pkill -x TypeByVoice 2>/dev/null || true
sleep 0.3

echo "==> Launching $APP"
echo "    TBV_API_URL=${TBV_API_URL}"
echo "    TBV_DICTATE_URL=${TBV_DICTATE_URL}"
open -n --env TBV_API_URL --env TBV_DICTATE_URL "$APP"
sleep 1
if pgrep -x TypeByVoice >/dev/null; then
  echo "==> Running (pid $(pgrep -n -x TypeByVoice))"
else
  echo "error: TypeByVoice did not start" >&2
  exit 1
fi
