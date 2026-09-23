#!/bin/zsh
# Ad-hoc Debug builds re-sign every compile. macOS Accessibility grants bind to
# the code signature, so the toggle can stay "on" while AXIsProcessTrusted()
# is false and Cmd+V paste silently fails. Clear the grant so the user can
# re-enable it for the newly signed binary.
set -euo pipefail

BUNDLE_ID="${1:-app.typebyvoice.TypeByVoice}"

if ! command -v tccutil >/dev/null 2>&1; then
  echo "warning: tccutil not found; skip Accessibility reset for ${BUNDLE_ID}"
  exit 0
fi

if tccutil reset Accessibility "${BUNDLE_ID}"; then
  echo "note: reset Accessibility for ${BUNDLE_ID} — re-enable in System Settings after launch"
else
  echo "warning: could not reset Accessibility for ${BUNDLE_ID}"
fi
