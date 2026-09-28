#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${IMAGE_TAG:?IMAGE_TAG required}"
: "${GHCR_OWNER:?GHCR_OWNER required}"

docker compose pull
docker compose up -d --remove-orphans
docker image prune -f

# Smoke: health through api container (Node 24 has global fetch).
# Retry briefly — Nest/Postgres may still be starting after compose up.
health_ok=0
for _ in $(seq 1 15); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(async (r)=>{const t=await r.text(); if(!t.includes('ok')) process.exit(1)}).catch(()=>process.exit(1))"; then
    health_ok=1
    break
  fi
  sleep 3
done

if [[ "${health_ok}" -eq 1 ]]; then
  echo "api health ok"
else
  echo "api health check failed after retries" >&2
  exit 1
fi
