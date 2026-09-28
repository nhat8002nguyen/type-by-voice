#!/usr/bin/env bash
set -euo pipefail
# Usage: GHCR_TOKEN=... GHCR_USER=... ./ghcr-login.sh
# Token needs read:packages (and write:packages on the builder).
echo "${GHCR_TOKEN:?}" | docker login ghcr.io -u "${GHCR_USER:?}" --password-stdin
