#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

: "${IMAGE_TAG:?IMAGE_TAG required}"
: "${GHCR_OWNER:?GHCR_OWNER required}"

docker compose pull
docker compose up -d --remove-orphans
docker image prune -f

# Smoke: health through api container (Node 24 has global fetch)
if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(async (r)=>{const t=await r.text(); if(!t.includes('ok')) process.exit(1)}).catch(()=>process.exit(1))"; then
  echo "api health ok"
else
  echo "api health check failed" >&2
  exit 1
fi
