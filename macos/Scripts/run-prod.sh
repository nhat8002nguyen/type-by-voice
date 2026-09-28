#!/bin/zsh
# Launch the current Debug TypeByVoice build against prod API (no rebuild).
set -euo pipefail

SCRIPT_DIR="${0:A:h}"

export TBV_API_URL="${TBV_API_URL:-https://tbv-api.nate-ng.com}"
export TBV_DICTATE_URL="${TBV_DICTATE_URL:-wss://tbv-api.nate-ng.com/v1/dictate}"

exec "${SCRIPT_DIR}/run.sh"
