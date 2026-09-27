#!/bin/sh
set -eu

# Renew Let's Encrypt certs, then reload nginx so new certs are picked up.
# Requires /var/run/docker.sock mounted into this container (see docker-compose.yml).
# Tradeoff: docker.sock grants container control of the Docker daemon — keep the
# certbot image pinned and do not expose this socket more broadly.

ensure_docker_cli() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  # certbot/certbot is Alpine-based and does not ship the Docker CLI.
  apk add --no-cache docker-cli
}

reload_nginx() {
  nginx_id="$(docker ps -q \
    -f "label=com.docker.compose.service=nginx" \
    -f "label=com.docker.compose.project=type-by-voice" | head -n 1)"
  if [ -n "${nginx_id}" ]; then
    docker exec "${nginx_id}" nginx -s reload
    echo "nginx reloaded after cert renew"
  else
    echo "warning: nginx container not found for reload" >&2
  fi
}

ensure_docker_cli

trap exit TERM
while :; do
  if certbot renew --webroot -w /var/www/certbot --quiet \
    --deploy-hook "touch /tmp/certbot-renewed"; then
    if [ -f /tmp/certbot-renewed ]; then
      rm -f /tmp/certbot-renewed
      reload_nginx || true
    fi
  fi
  sleep 12h &
  wait $!
done
