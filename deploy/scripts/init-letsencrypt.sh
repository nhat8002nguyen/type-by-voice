#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source .env

DOMAIN="${DOMAIN:-tbv-api.nate-ng.com}"
EMAIL="${CERTBOT_EMAIL:?CERTBOT_EMAIL required}"

CONF_DIR=./nginx/conf.d
TLS_CONF="${CONF_DIR}/tbv-api.conf"
TLS_TEMPLATE="${CONF_DIR}/tbv-api.tls.conf.example"

if [[ ! -f "${TLS_TEMPLATE}" ]]; then
  echo "missing ${TLS_TEMPLATE}" >&2
  exit 1
fi

# ACME-only HTTP site (no api upstream) so nginx starts before GHCR images exist.
cat > "${TLS_CONF}" <<EOF
server {
  listen 80;
  server_name ${DOMAIN};

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 503;
  }
}
EOF

# Only nginx is required for HTTP-01; do not pull Nest images here.
docker compose up -d --no-deps nginx

# Empty entrypoint overrides the renew-loop. Prefer --domains over -d (Compose detach).
docker compose run --rm --no-deps --entrypoint "" certbot \
  certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --domains "$DOMAIN"

mkdir -p ./cert-data
touch ./cert-data/.letsencrypt-ready

# Restore full TLS site config from the durable template.
cp "${TLS_TEMPLATE}" "${TLS_CONF}"

# Nginx TLS conf proxies to api; that hostname exists only after the app stack is up.
if docker compose up -d --no-deps nginx \
  && docker compose exec -T nginx nginx -t \
  && docker compose exec -T nginx nginx -s reload; then
  echo "Certificate issued for ${DOMAIN}. TLS config restored from ${TLS_TEMPLATE}."
else
  echo "Certificate issued for ${DOMAIN}. TLS template written to ${TLS_CONF}."
  echo "Start the full stack (./scripts/deploy.sh), then: docker compose exec nginx nginx -s reload"
fi
