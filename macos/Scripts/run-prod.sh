#!/bin/zsh
# Launch the current Debug TypeByVoice build using macos/.env endpoints (no rebuild).
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MACOS_ROOT="${SCRIPT_DIR:h}"
ENV_FILE="${TBV_ENV_FILE:-$MACOS_ROOT/.env}"

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

export TBV_API_URL TBV_DICTATE_URL
exec "${SCRIPT_DIR}/run.sh"
