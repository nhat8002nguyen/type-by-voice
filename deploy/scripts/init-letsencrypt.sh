#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source .env

DOMAIN="${DOMAIN:-tbv-api.nate-ng.com}"
EMAIL="${CERTBOT_EMAIL:?CERTBOT_EMAIL required}"

CONF_DIR=./nginx/conf.d
TLS_CONF="${CONF_DIR}/tbv-api.conf"
BOOTSTRAP_EXAMPLE="${CONF_DIR}/tbv-api.http-bootstrap.conf.example"
TLS_BACKUP="${CONF_DIR}/tbv-api.conf.tls.bak"

if [[ ! -f "${BOOTSTRAP_EXAMPLE}" ]]; then
  echo "missing ${BOOTSTRAP_EXAMPLE}" >&2
  exit 1
fi

# Use HTTP-only site until certs exist (Nginx fails if ssl_certificate paths are missing).
if [[ ! -f "./cert-data/.letsencrypt-ready" ]]; then
  cp "${TLS_CONF}" "${TLS_BACKUP}"
  cp "${BOOTSTRAP_EXAMPLE}" "${TLS_CONF}"
fi

docker compose up -d nginx api

docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN"

mkdir -p ./cert-data
touch ./cert-data/.letsencrypt-ready

# Restore TLS site config and reload.
if [[ -f "${TLS_BACKUP}" ]]; then
  mv "${TLS_BACKUP}" "${TLS_CONF}"
fi

docker compose up -d nginx
docker compose exec nginx nginx -s reload

echo "Certificate issued for ${DOMAIN}. TLS config restored."
