# Production deploy (DigitalOcean droplet)

Droplet target: **4GB RAM / 2 vCPU**, hostname **`tbv-api.nate-ng.com`**.
Stack: Docker Compose (Nest apps + Postgres/NATS/RabbitMQ/Redis), Nginx TLS termination, Certbot (Let's Encrypt), GitHub Actions → GHCR → SSH redeploy.

## DNS (Cloudflare)

1. Create an **A** record: `tbv-api` → droplet public IPv4.
2. Proxy status: **DNS only** (grey cloud). HTTP-01 Let's Encrypt fails behind orange-cloud until certificates exist.
3. Wait until resolution matches the droplet:

```bash
dig +short tbv-api.nate-ng.com
```

## Droplet bootstrap (once)

As root on an Ubuntu droplet:

```bash
apt-get update && apt-get install -y git
# Docker Engine (Ubuntu package) + Compose V2 plugin:
apt-get install -y docker.io docker-compose-v2
# Or follow official Docker Engine docs:
# https://docs.docker.com/engine/install/ubuntu/
# then: apt-get install -y docker-compose-plugin

# Confirm Compose works (required — scripts use `docker compose`, not `docker-compose`):
docker compose version

mkdir -p /opt/type-by-voice
git clone git@github.com:OWNER/type-by-voice.git /opt/type-by-voice
cd /opt/type-by-voice/deploy
cp .env.example .env
# Edit .env — generate secrets:
#   openssl rand -hex 32          → JWT_SECRET
#   openssl rand -hex 32          → TRANSCRIPT_ENCRYPTION_KEY (must be 64 hex chars)
#   openssl rand -base64 24       → POSTGRES_PASSWORD
# Set GHCR_OWNER to your GitHub user or org.
# Set CERTBOT_EMAIL and DOMAIN=tbv-api.nate-ng.com

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## GHCR pull auth on droplet

Make the five `type-by-voice-*` GHCR packages **public** (recommended for this MVP) so the droplet can pull without a token.

If packages stay private:

1. Create a GitHub PAT (classic) with `read:packages`, or a fine-grained token with package read.
2. Log in once (credentials persist in `~/.docker/config.json`):

```bash
cd /opt/type-by-voice/deploy
GHCR_USER=your-github-username GHCR_TOKEN=ghp_... ./scripts/ghcr-login.sh
```

## First TLS cert

`init-letsencrypt.sh` starts **nginx only** (ACME HTTP-01 on port 80), issues the cert, then writes the TLS site config from `tbv-api.tls.conf.example`. Nest/GHCR images are **not** required for this step.

```bash
cd /opt/type-by-voice/deploy
# DNS must already point here: dig +short tbv-api.nate-ng.com
./scripts/init-letsencrypt.sh
```

What the script does:

1. Writes an ACME-only HTTP site config (no `api` upstream) so nginx can start without the app stack.
2. `docker compose up -d --no-deps nginx`, then `certbot certonly` (HTTP-01 webroot).
3. Marks certs ready, copies `nginx/conf.d/tbv-api.tls.conf.example` → `tbv-api.conf`.
4. Reloads nginx if possible; if `api` is not on the network yet, finish with `./scripts/deploy.sh` then `docker compose exec nginx nginx -s reload`.

Keep `tbv-api.tls.conf.example` in git as the source of truth for HTTPS.

Certbot renew runs every 12 hours via `scripts/certbot-loop.sh`. After a successful renew that writes new certs, the loop reloads nginx through the Docker socket (`docker exec … nginx -s reload`). Mounting `docker.sock` into certbot is a security tradeoff; keep the certbot image tag pinned.

## First app start

1. Keep `TYPEORM_SYNCHRONIZE=true` in `.env` for the first boot (creates schema; no migrations yet).
2. Deploy:

```bash
IMAGE_TAG=<sha-or-latest> GHCR_OWNER=<owner> ./scripts/deploy.sh
```

3. Smoke:

```bash
curl -sS https://tbv-api.nate-ng.com/health
```

Expect Terminus JSON with `"status":"ok"`.

4. Set `TYPEORM_SYNCHRONIZE=false` in `.env` and redeploy so production no longer auto-syncs schema.

## Client URLs

- `TBV_API_URL=https://tbv-api.nate-ng.com`
- `TBV_DICTATE_URL=wss://tbv-api.nate-ng.com/v1/dictate`

## GitHub Actions secrets

Create these repository secrets for `.github/workflows/deploy-backend.yml`:

| Secret | Purpose |
|---|---|
| `DROPLET_HOST` | Droplet IPv4 or hostname |
| `DROPLET_USER` | SSH user (e.g. `root` or `deploy`) |
| `DROPLET_SSH_KEY` | Private key (PEM) for that user |
| `DROPLET_SSH_PORT` | Optional; default `22` |

On every push to `main` that touches `backend/`, `contracts/dictation-v1/`, `deploy/`, or the workflow file, Actions builds five images to GHCR (tagged with `github.sha` and `latest`), then SSHs to the droplet, fast-forwards `/opt/type-by-voice`, updates `IMAGE_TAG` / `GHCR_OWNER` in `deploy/.env`, and runs `./scripts/deploy.sh`.

`workflow_dispatch` is available for manual redeploy.

### Make GHCR packages public

After the first successful build:

1. GitHub → Packages → each `type-by-voice-*` package → Package settings → Change visibility → Public.
2. Or keep private and ensure droplet Docker login (above) stays valid.

## RAM notes

Expect roughly **1.5–2.5GB** idle with production images. Watch `docker stats` on the droplet. Do **not** enable the RabbitMQ management plugin (prod image is `rabbitmq:3-alpine`). Leave headroom under ~3.2GB total.

## Verification

1. `dig +short tbv-api.nate-ng.com` → droplet IP
2. `curl -sS https://tbv-api.nate-ng.com/health` → `"status":"ok"`
3. Register:
   `curl -sS https://tbv-api.nate-ng.com/v1/auth/register -H 'content-type: application/json' -d '{"email":"you@example.com","password":"a-long-enough-password","platform":"macos","clientVersion":"1.0.0","deviceId":"9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"}'`
4. Dictation harness from laptop:
   `DICTATE_URL=wss://tbv-api.nate-ng.com/v1/dictate DICTATE_TOKEN=... npm run harness` in `contracts/dictation-v1`
5. `docker stats` on droplet — total memory under ~3.2GB with headroom
6. Push a no-op commit to `main` → Actions green → new `IMAGE_TAG` running (`docker compose ps`)
7. After first successful schema sync, set `TYPEORM_SYNCHRONIZE=false` in droplet `.env` and redeploy
