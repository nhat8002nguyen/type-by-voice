# Backend Droplet CI/CD (Nginx + Compose + Let's Encrypt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the TypeByVoice Nest backend to a single 4GB / 2 vCPU DigitalOcean droplet at `https://tbv-api.nate-ng.com`, with Nginx TLS termination, Docker Compose for all services, and a GitHub Actions workflow that rebuilds and restarts the stack on every `main` push.

**Architecture:** Only `api` is public. Nginx terminates TLS for `tbv-api.nate-ng.com` and reverse-proxies HTTP + WebSocket `/v1/dictate` to `api:3000` on the Compose network. All other Nest apps, Postgres instances, NATS, RabbitMQ, and Redis stay internal (no host ports). GitHub Actions builds production images, pushes them to GHCR, then SSHs to the droplet to pull and `docker compose up -d`. Certbot (webroot) obtains and renews Let's Encrypt certificates; Nginx serves ACME challenges from a shared volume.

**Tech Stack:** Docker Compose v2, `node:24-alpine` production `backend/Dockerfile`, Nginx Alpine, Certbot, GitHub Actions + GHCR, Let's Encrypt, DigitalOcean droplet (4GB RAM / 2 vCPU), domain `tbv-api.nate-ng.com` (Cloudflare DNS).

**Spec:** `docs/superpowers/specs/2026-09-13-backend-design.md` (runtime, public surface, Node/Nest constraints). Deploy requirements from this plan's Goal / Global Constraints (user request 2026-09-26).

## Global Constraints

- Node **24 LTS**; production images `FROM node:24-alpine` via existing `backend/Dockerfile`.
- Nest **12** ESM monorepo under `backend/`. Only public process is `api` on port **3000** (HTTP + WebSocket `/v1/dictate`).
- Public hostname: **`tbv-api.nate-ng.com`**. Clients use `https://tbv-api.nate-ng.com` and `wss://tbv-api.nate-ng.com/v1/dictate`.
- Droplet: **4GB RAM / 2 vCPU**. Do not publish Postgres, NATS, RabbitMQ, Redis, or internal Nest service ports to the host.
- `synchronize` remains off in normal production. First-boot schema uses an explicit `TYPEORM_SYNCHRONIZE=true` escape hatch (this plan); full TypeORM migrations are a follow-on, not blocked here.
- Production requires `JWT_SECRET`, `TRANSCRIPT_ENCRYPTION_KEY` (64 hex), `GROQ_API_KEY` (`NODE_ENV=production` forces Groq). Never commit `.env` or secrets.
- Use `const`/`let`, never `var`. Prefer production images (`npm run build`), not `Dockerfile.dev` / `start:dev`.
- RabbitMQ image for prod: **`rabbitmq:3-alpine`** (no management UI) to save RAM.
- Cloudflare DNS: **grey-cloud (DNS only)** A record for HTTP-01 Let's Encrypt. Do not orange-proxy until certs work.
- CI trigger: **push to `main`** only (plus `workflow_dispatch` for manual redeploy).

## File Structure

```
.github/workflows/
  deploy-backend.yml          # build → GHCR → SSH compose up

deploy/
  README.md                   # droplet bootstrap + DNS + secrets runbook
  docker-compose.yml          # nginx, certbot, + app stack (or include)
  .env.example                # documented secrets (committed)
  nginx/
    nginx.conf                # http block, includes conf.d
    conf.d/
      tbv-api.conf            # :80 ACME + redirect; :443 proxy to api:3000
  scripts/
    init-letsencrypt.sh       # first-time cert issuance
    deploy.sh                 # pull images + compose up (run on droplet)

backend/
  docker-compose.prod.yml     # production Nest + infra services (no host ports except none; nginx peers on network)
  Dockerfile                  # unchanged contract (APP_NAME build-arg)
```

`deploy/docker-compose.yml` defines `nginx` + `certbot` and either:
- `include:`s `../backend/docker-compose.prod.yml`, or
- lists the same services with `image:` from GHCR.

Prefer **one** top-level `deploy/docker-compose.yml` that references GHCR images for Nest apps and keeps infra + nginx in the same file so the droplet only needs one compose project.

---

### Task 1: Production TypeORM synchronize escape hatch

**Files:**
- Modify: `backend/apps/api/src/app.module.ts` (TypeORM `synchronize` expression)
- Modify: `backend/apps/workflows-service/src/workflows-service.module.ts`
- Modify: `backend/apps/notifications-service/src/notifications-service.module.ts`
- Create: `backend/libs/tracing/src/typeorm-synchronize.ts` (shared helper — or put under a tiny shared util; if no shared place fits without new lib, duplicate a 3-line helper in each module **or** add `backend/libs/config/` — prefer one helper file imported by all three)
- Test: `backend/libs/tracing/src/typeorm-synchronize.spec.ts` (or colocated with the helper)

**Why:** Production sets `NODE_ENV=production`, so today's `synchronize: process.env.NODE_ENV === 'development'` never creates tables, and there are **zero** migrations. Without this, `/health` and auth crash on empty Postgres.

**Interfaces:**
- Consumes: `process.env.NODE_ENV`, `process.env.TYPEORM_SYNCHRONIZE`
- Produces: `export function shouldSynchronizeTypeOrm(env?: NodeJS.ProcessEnv): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { shouldSynchronizeTypeOrm } from './typeorm-synchronize.js';

describe('shouldSynchronizeTypeOrm', () => {
  it('is true in development', () => {
    expect(shouldSynchronizeTypeOrm({ NODE_ENV: 'development' })).toBe(true);
  });

  it('is false in production by default', () => {
    expect(shouldSynchronizeTypeOrm({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is true in production when TYPEORM_SYNCHRONIZE=true', () => {
    expect(
      shouldSynchronizeTypeOrm({
        NODE_ENV: 'production',
        TYPEORM_SYNCHRONIZE: 'true',
      }),
    ).toBe(true);
  });

  it('ignores other TYPEORM_SYNCHRONIZE values', () => {
    expect(
      shouldSynchronizeTypeOrm({
        NODE_ENV: 'production',
        TYPEORM_SYNCHRONIZE: '1',
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run libs/tracing/src/typeorm-synchronize.spec.ts -v`  
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```typescript
/** shouldSynchronizeTypeOrm reports whether TypeORM may auto-create schema for this process. */
export function shouldSynchronizeTypeOrm(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === 'development') {
    return true;
  }
  return env.TYPEORM_SYNCHRONIZE === 'true';
}
```

Export from `backend/libs/tracing/src/index.ts` if that barrel already re-exports helpers; otherwise import by path `@app/tracing` only if the path mapping already covers it — match existing export style in `libs/tracing`.

Update each TypeORM `forRoot`:

```typescript
synchronize: shouldSynchronizeTypeOrm(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run libs/tracing/src/typeorm-synchronize.spec.ts -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/libs/tracing/src/typeorm-synchronize.ts \
  backend/libs/tracing/src/typeorm-synchronize.spec.ts \
  backend/libs/tracing/src/index.ts \
  backend/apps/api/src/app.module.ts \
  backend/apps/workflows-service/src/workflows-service.module.ts \
  backend/apps/notifications-service/src/notifications-service.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): allow explicit TypeORM synchronize in production bootstrap

EOF
)"
```

---

### Task 2: Production Compose stack (GHCR images, no public internal ports)

**Files:**
- Create: `deploy/docker-compose.yml` (Nest apps + infra; nginx/certbot added in Task 3)
- Create: `deploy/.env.example`
- Keep: `backend/docker-compose.yml` as **dev-only** (do not break local `docker compose up`)

**Interfaces:**
- Consumes: GHCR image tags via env `IMAGE_TAG` (default `latest`), secrets from `.env`
- Produces: Compose project with services: `api`, `quota-service`, `speech-service`, `workflows-service`, `notifications-service`, `api-db`, `quota-db`, `workflows-db`, `notifications-db`, `nats-server`, `rabbitmq`, `redis`

- [ ] **Step 1: Write `deploy/.env.example`**

```bash
# Copy to /opt/type-by-voice/deploy/.env on the droplet (never commit .env)

IMAGE_TAG=latest
GHCR_OWNER=REPLACE_WITH_GITHUB_OWNER_OR_ORG

# Postgres (shared credentials across DBs is OK for single-droplet MVP)
POSTGRES_USER=tbv
POSTGRES_PASSWORD=REPLACE_WITH_LONG_RANDOM
# per-service DB names stay api / quota / workflows / notifications

JWT_SECRET=REPLACE_WITH_LONG_RANDOM
TRANSCRIPT_ENCRYPTION_KEY=REPLACE_WITH_64_HEX_CHARS
GROQ_API_KEY=gsk_REPLACE
GROQ_MODEL=whisper-large-v3-turbo
SPEECH_PROVIDER=groq

# First boot only — set true once until tables exist, then set false and redeploy
TYPEORM_SYNCHRONIZE=true

# Optional Nest Observe (leave empty to disable)
OBSERVE_APP_KEY=
OBSERVE_APP_SECRET=

# Certbot
CERTBOT_EMAIL=you@example.com
DOMAIN=tbv-api.nate-ng.com
```

- [ ] **Step 2: Write Nest + infra section of `deploy/docker-compose.yml`**

Use this shape (adjust owner via `${GHCR_OWNER}`):

```yaml
name: type-by-voice

x-app-env: &app-env
  NODE_ENV: production
  NATS_SERVER_HOST: nats-server
  RABBITMQ_HOST: amqp://rabbitmq:5672
  REDIS_HOST: redis
  JWT_SECRET: ${JWT_SECRET}
  TYPEORM_SYNCHRONIZE: ${TYPEORM_SYNCHRONIZE:-false}
  OBSERVE_APP_KEY: ${OBSERVE_APP_KEY:-}
  OBSERVE_APP_SECRET: ${OBSERVE_APP_SECRET:-}

services:
  api:
    image: ghcr.io/${GHCR_OWNER}/type-by-voice-api:${IMAGE_TAG}
    restart: unless-stopped
    environment:
      <<: *app-env
      POSTGRES_HOST: api-db
      POSTGRES_PORT: "5432"
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: api
    depends_on:
      - api-db
      - quota-service
      - speech-service
      - workflows-service
      - notifications-service
      - nats-server
      - rabbitmq
      - redis
    # no ports: — nginx reaches api:3000 on the compose network
    deploy:
      resources:
        limits:
          memory: 512M

  quota-service:
    image: ghcr.io/${GHCR_OWNER}/type-by-voice-quota-service:${IMAGE_TAG}
    restart: unless-stopped
    environment:
      <<: *app-env
    depends_on:
      - nats-server
    deploy:
      resources:
        limits:
          memory: 256M

  speech-service:
    image: ghcr.io/${GHCR_OWNER}/type-by-voice-speech-service:${IMAGE_TAG}
    restart: unless-stopped
    environment:
      <<: *app-env
      SPEECH_PROVIDER: ${SPEECH_PROVIDER:-groq}
      GROQ_API_KEY: ${GROQ_API_KEY}
      GROQ_MODEL: ${GROQ_MODEL:-whisper-large-v3-turbo}
    depends_on:
      - nats-server
    deploy:
      resources:
        limits:
          memory: 256M

  workflows-service:
    image: ghcr.io/${GHCR_OWNER}/type-by-voice-workflows-service:${IMAGE_TAG}
    restart: unless-stopped
    environment:
      <<: *app-env
      POSTGRES_HOST: workflows-db
      POSTGRES_PORT: "5432"
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: workflows
      TRANSCRIPT_ENCRYPTION_KEY: ${TRANSCRIPT_ENCRYPTION_KEY}
    depends_on:
      - workflows-db
      - rabbitmq
      - redis
      - nats-server
    deploy:
      resources:
        limits:
          memory: 256M

  notifications-service:
    image: ghcr.io/${GHCR_OWNER}/type-by-voice-notifications-service:${IMAGE_TAG}
    restart: unless-stopped
    environment:
      <<: *app-env
      POSTGRES_HOST: notifications-db
      POSTGRES_PORT: "5432"
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: notifications
    depends_on:
      - notifications-db
      - rabbitmq
      - redis
    deploy:
      resources:
        limits:
          memory: 256M

  api-db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: api
    volumes:
      - api-db-data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          memory: 256M

  quota-db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: quota
    volumes:
      - quota-db-data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          memory: 128M

  workflows-db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: workflows
    volumes:
      - workflows-db-data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          memory: 256M

  notifications-db:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: notifications
    volumes:
      - notifications-db-data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          memory: 128M

  nats-server:
    image: nats:2-alpine
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 64M

  rabbitmq:
    image: rabbitmq:3-alpine
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 256M

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    deploy:
      resources:
        limits:
          memory: 64M

volumes:
  api-db-data:
  quota-db-data:
  workflows-db-data:
  notifications-db-data:
```

Note: Compose `deploy.resources` is honored by Swarm; on plain Compose it is **advisory** on some versions. Still document limits; if the droplet OOMs, add `mem_limit:` (Compose non-Swarm) as a follow-up tweak:

```yaml
mem_limit: 512m
```

Prefer adding `mem_limit` alongside `deploy.resources` for single-node Compose.

- [ ] **Step 3: Validate compose file parses**

Run (from repo root, with a throwaway env):

```bash
cd deploy
cp .env.example .env
# fill GHCR_OWNER=test JWT_SECRET=x TRANSCRIPT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) GROQ_API_KEY=gsk_x POSTGRES_PASSWORD=x
docker compose --env-file .env config >/dev/null
```

Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml deploy/.env.example
git commit -m "$(cat <<'EOF'
feat(deploy): add production compose stack for droplet

EOF
)"
```

---

### Task 3: Nginx reverse proxy + Certbot volumes

**Files:**
- Create: `deploy/nginx/nginx.conf`
- Create: `deploy/nginx/conf.d/tbv-api.conf`
- Modify: `deploy/docker-compose.yml` (add `nginx`, `certbot`, volumes, ports 80/443)
- Create: `deploy/scripts/init-letsencrypt.sh`

**Interfaces:**
- Consumes: upstream `api:3000`; domain from env `DOMAIN`
- Produces: TLS-terminated `https://tbv-api.nate-ng.com` → `api`; WebSocket upgrade for `/v1/dictate`

- [ ] **Step 1: Write `deploy/nginx/nginx.conf`**

```nginx
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server_tokens off;
  client_max_body_size 2m;

  # Dictation can be long-lived
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;

  include /etc/nginx/conf.d/*.conf;
}
```

- [ ] **Step 2: Write `deploy/nginx/conf.d/tbv-api.conf`**

```nginx
upstream tbv_api {
  server api:3000;
  keepalive 16;
}

server {
  listen 80;
  server_name tbv-api.nate-ng.com;

  location /.well-known/acme-challenge/ {
    root /var/www/certbot;
  }

  location / {
    return 301 https://$host$request_uri;
  }
}

server {
  listen 443 ssl http2;
  server_name tbv-api.nate-ng.com;

  ssl_certificate /etc/letsencrypt/live/tbv-api.nate-ng.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tbv-api.nate-ng.com/privkey.pem;
  ssl_session_timeout 1d;
  ssl_session_cache shared:SSL:10m;
  ssl_protocols TLSv1.2 TLSv1.3;

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_pass http://tbv_api;
  }

  # WebSocket dictation
  location /v1/dictate {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://tbv_api;
  }
}
```

- [ ] **Step 3: Add nginx + certbot services to compose**

```yaml
  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - certbot-www:/var/www/certbot:ro
      - certbot-certs:/etc/letsencrypt:ro
    depends_on:
      - api
    mem_limit: 64m

  certbot:
    image: certbot/certbot:v3.1.0
    volumes:
      - certbot-www:/var/www/certbot
      - certbot-certs:/etc/letsencrypt
    entrypoint: /bin/sh -c 'trap exit TERM; while :; do certbot renew --webroot -w /var/www/certbot --quiet; sleep 12h & wait $${!}; done'
    mem_limit: 64m
```

Add volumes `certbot-www` and `certbot-certs` to the `volumes:` section.

- [ ] **Step 4: Write `deploy/scripts/init-letsencrypt.sh`**

First boot cannot mount missing certs or Nginx fails. Script flow:

1. Start nginx with a **temporary** HTTP-only config (or comment ssl server until certs exist).
2. Run certbot certonly webroot once.
3. Swap to full TLS config and reload nginx.

Concrete script:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source .env

DOMAIN="${DOMAIN:-tbv-api.nate-ng.com}"
EMAIL="${CERTBOT_EMAIL:?CERTBOT_EMAIL required}"

mkdir -p ./nginx/conf.d
# Temporarily use HTTP-only site if fullchain missing
if [[ ! -f ./data-hint ]]; then
  :
fi

docker compose up -d nginx api
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN"

docker compose exec nginx nginx -s reload
```

**Bootstrap chicken-and-egg:** ship `deploy/nginx/conf.d/tbv-api.http-bootstrap.conf.example` that only listens on `:80` (ACME + temporary `proxy_pass` to api **without** redirect). Operator:

1. Copy bootstrap conf over `tbv-api.conf`
2. `docker compose up -d`
3. Run `init-letsencrypt.sh`
4. Restore TLS `tbv-api.conf`
5. `docker compose exec nginx nginx -s reload`

Document this exact sequence in `deploy/README.md` (Task 5).

- [ ] **Step 5: Validate nginx config syntax in a container**

```bash
docker run --rm -v "$PWD/deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$PWD/deploy/nginx/conf.d:/etc/nginx/conf.d:ro" \
  nginx:1.27-alpine nginx -t
```

Expected: `syntax is ok` / `test is successful`  
Note: TLS `ssl_certificate` paths may warn if certs absent — for local `-t`, use the HTTP-bootstrap conf file during this check, or mount dummy PEM files.

- [ ] **Step 6: Commit**

```bash
git add deploy/nginx deploy/scripts/init-letsencrypt.sh deploy/docker-compose.yml
git commit -m "$(cat <<'EOF'
feat(deploy): add nginx TLS reverse proxy and certbot renew loop

EOF
)"
```

---

### Task 4: Droplet deploy script + GHCR login helper

**Files:**
- Create: `deploy/scripts/deploy.sh`
- Create: `deploy/scripts/ghcr-login.sh`

**Interfaces:**
- Consumes: `IMAGE_TAG`, `GHCR_OWNER`, `GITHUB_TOKEN` or `CR_PAT` for pull
- Produces: running compose project on the droplet

- [ ] **Step 1: Write `deploy/scripts/ghcr-login.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Usage: GHCR_TOKEN=... ./ghcr-login.sh
# Token needs read:packages (and write:packages on the builder).
echo "${GHCR_TOKEN:?}" | docker login ghcr.io -u "${GHCR_USER:?}" --password-stdin
```

- [ ] **Step 2: Write `deploy/scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

: "${IMAGE_TAG:?IMAGE_TAG required}"
: "${GHCR_OWNER:?GHCR_OWNER required}"

docker compose pull
docker compose up -d --remove-orphans
docker image prune -f

# Smoke: health through nginx if certs exist, else hit api container
if docker compose exec -T api wget -q -O - http://127.0.0.1:3000/health 2>/dev/null | grep -q ok; then
  echo "api health ok"
else
  # alpine node image may lack wget — use docker compose run curl or node
  docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>{if(!t.includes('ok'))process.exit(1)}).catch(()=>process.exit(1))"
fi
```

If `node` fetch fails in older images, install nothing — use:

```bash
docker compose exec -T api node -e '...'
```

Node 24 has global `fetch`.

- [ ] **Step 3: Make scripts executable in git**

```bash
chmod +x deploy/scripts/*.sh
git update-index --chmod=+x deploy/scripts/deploy.sh deploy/scripts/ghcr-login.sh deploy/scripts/init-letsencrypt.sh
```

- [ ] **Step 4: Commit**

```bash
git add deploy/scripts
git commit -m "$(cat <<'EOF'
feat(deploy): add droplet pull-and-up deploy scripts

EOF
)"
```

---

### Task 5: Deploy README runbook (DNS, droplet bootstrap, secrets)

**Files:**
- Create: `deploy/README.md`
- Modify: `backend/README.md` (short “Production” link to `deploy/README.md`)

- [ ] **Step 1: Write `deploy/README.md` with these sections (full prose, not stubs)**

Required content:

1. **DNS (Cloudflare)**  
   - Create A record `tbv-api` → droplet public IPv4  
   - Proxy status: **DNS only** (grey cloud)  
   - Wait until `dig +short tbv-api.nate-ng.com` returns the droplet IP

2. **Droplet bootstrap (once)**  
   ```bash
   # as root on Ubuntu droplet
   apt-get update && apt-get install -y git
   # install Docker Engine + Compose plugin (official Docker docs)
   mkdir -p /opt/type-by-voice
   # clone repo OR rsync deploy/ only — prefer full repo clone for scripts
   git clone git@github.com:OWNER/type-by-voice.git /opt/type-by-voice
   cd /opt/type-by-voice/deploy
   cp .env.example .env
   # edit .env — generate secrets:
   #   openssl rand -hex 32          → JWT_SECRET
   #   openssl rand -hex 32          → TRANSCRIPT_ENCRYPTION_KEY (must be 64 hex chars)
   #   openssl rand -base64 24       → POSTGRES_PASSWORD
   ufw allow OpenSSH
   ufw allow 80/tcp
   ufw allow 443/tcp
   ufw --force enable
   ```

3. **GHCR pull auth on droplet**  
   - Create a GitHub PAT (classic) with `read:packages` or use a fine-grained token  
   - `GHCR_USER=... GHCR_TOKEN=... ./scripts/ghcr-login.sh`

4. **First TLS cert** — HTTP bootstrap → `init-letsencrypt.sh` → restore TLS conf → reload

5. **First app start**  
   - `TYPEORM_SYNCHRONIZE=true` in `.env`  
   - `IMAGE_TAG=<sha-or-latest> ./scripts/deploy.sh`  
   - `curl -sS https://tbv-api.nate-ng.com/health` → Terminus JSON with `"status":"ok"`  
   - Set `TYPEORM_SYNCHRONIZE=false` and redeploy

6. **Client URLs**  
   - `TBV_API_URL=https://tbv-api.nate-ng.com`  
   - `TBV_DICTATE_URL=wss://tbv-api.nate-ng.com/v1/dictate`

7. **RAM notes** — expected idle ~1.5–2.5GB with production images; watch `docker stats`; do not enable RabbitMQ management plugin

- [ ] **Step 2: Add a short pointer at the top of `backend/README.md`**

```markdown
## Production

Droplet deploy (Nginx, TLS, Compose, GitHub Actions): see [`../deploy/README.md`](../deploy/README.md).
```

- [ ] **Step 3: Commit**

```bash
git add deploy/README.md backend/README.md
git commit -m "$(cat <<'EOF'
docs(deploy): add droplet bootstrap and TLS runbook

EOF
)"
```

---

### Task 6: GitHub Actions — build images to GHCR

**Files:**
- Create: `.github/workflows/deploy-backend.yml` (build job only in this task; deploy job in Task 7 — **or** one file with both jobs; implement build job steps here and leave deploy job stub that `needs: build` for Task 7 to fill)

**Interfaces:**
- Consumes: `backend/Dockerfile`, `contracts/dictation-v1` as additional build context
- Produces: five GHCR images tagged with `github.sha` and `latest` on `main`

- [ ] **Step 1: Create workflow with build matrix**

```yaml
name: Deploy backend

on:
  push:
    branches: [main]
    paths:
      - "backend/**"
      - "contracts/dictation-v1/**"
      - "deploy/**"
      - ".github/workflows/deploy-backend.yml"
  workflow_dispatch:

permissions:
  contents: read
  packages: write

env:
  REGISTRY: ghcr.io

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app:
          - api
          - quota-service
          - speech-service
          - workflows-service
          - notifications-service
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: backend
          file: backend/Dockerfile
          build-args: |
            APP_NAME=${{ matrix.app }}
          build-contexts: |
            contracts=contracts/dictation-v1
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/type-by-voice-${{ matrix.app }}:${{ github.sha }}
            ghcr.io/${{ github.repository_owner }}/type-by-voice-${{ matrix.app }}:latest
          cache-from: type=gha,scope=${{ matrix.app }}
          cache-to: type=gha,mode=max,scope=${{ matrix.app }}
```

Confirm `docker/build-push-action` `build-contexts` syntax matches the action version; if unsupported, use:

```yaml
# fallback Dockerfile tweak is out of scope — prefer build-contexts
```

Existing Dockerfile line: `COPY --from=contracts . /usr/src/contracts/dictation-v1` — requires BuildKit additional context named `contracts` (already used in `Dockerfile.dev` compose). Keep that contract.

- [ ] **Step 2: Push a branch and verify workflow YAML locally if possible**

```bash
# optional
brew install actionlint 2>/dev/null || true
actionlint .github/workflows/deploy-backend.yml
```

Expected: no errors (or install actionlint later on CI machine)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-backend.yml
git commit -m "$(cat <<'EOF'
ci: build and push backend images to GHCR on main

EOF
)"
```

---

### Task 7: GitHub Actions — SSH deploy job

**Files:**
- Modify: `.github/workflows/deploy-backend.yml`
- Document secrets in `deploy/README.md`

**GitHub repo secrets (create in GitHub UI):**

| Secret | Purpose |
|---|---|
| `DROPLET_HOST` | Droplet IPv4 or hostname |
| `DROPLET_USER` | SSH user (e.g. `root` or `deploy`) |
| `DROPLET_SSH_KEY` | Private key (PEM) for that user |
| `DROPLET_SSH_PORT` | Optional; default `22` |

**Interfaces:**
- Consumes: images from `build` job; SSH secrets
- Produces: remote `./scripts/deploy.sh` with `IMAGE_TAG=${{ github.sha }}`

- [ ] **Step 1: Append deploy job**

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DROPLET_SSH_KEY }}
          port: ${{ secrets.DROPLET_SSH_PORT || 22 }}
          script: |
            set -euo pipefail
            cd /opt/type-by-voice
            git fetch origin main
            git checkout main
            git pull --ff-only origin main
            cd deploy
            # keep server .env; only override tag + owner for this release
            export IMAGE_TAG="${{ github.sha }}"
            export GHCR_OWNER="${{ github.repository_owner }}"
            # ensure compose .env has GHCR_OWNER / IMAGE_TAG or export for compose
            grep -q '^IMAGE_TAG=' .env && sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${IMAGE_TAG}/" .env || echo "IMAGE_TAG=${IMAGE_TAG}" >> .env
            grep -q '^GHCR_OWNER=' .env && sed -i "s/^GHCR_OWNER=.*/GHCR_OWNER=${GHCR_OWNER}/" .env || echo "GHCR_OWNER=${GHCR_OWNER}" >> .env
            ./scripts/deploy.sh
```

Packages on GHCR for a private repo require the droplet to be logged into GHCR. Document: either images are **public** (`package` visibility public) for a simpler pull, or store `GHCR_TOKEN` on the droplet and run `ghcr-login.sh` once (login persists in `~/.docker/config.json`).

**Recommendation for this plan:** make the five packages **public** under GHCR so the droplet can pull without a token. If the repo is private and packages inherit private visibility, set droplet Docker login once with a read PAT.

- [ ] **Step 2: Update `deploy/README.md` with the secrets table and “make GHCR packages public” steps**

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-backend.yml deploy/README.md
git commit -m "$(cat <<'EOF'
ci: SSH deploy compose stack to droplet after image build

EOF
)"
```

---

### Task 8: End-to-end verification checklist (manual on droplet)

**Files:**
- Modify: `deploy/README.md` (add “Verification” checklist)

This task is documentation + operator execution; no production code change unless a bug is found.

- [ ] **Step 1: Add verification checklist to README**

```markdown
## Verification

1. `dig +short tbv-api.nate-ng.com` → droplet IP
2. `curl -sS https://tbv-api.nate-ng.com/health` → `"status":"ok"`
3. Register:
   `curl -sS https://tbv-api.nate-ng.com/v1/auth/register -H 'content-type: application/json' -d '{"email":"you@example.com","password":"a-long-enough-password","platform":"macos","clientVersion":"1.0.0","deviceId":"9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"}'`
4. Dictation harness from laptop:
   `DICTATE_URL=wss://tbv-api.nate-ng.com/v1/dictate DICTATE_TOKEN=... npm run harness` in `contracts/dictation-v1`
5. `docker stats` on droplet — total memory under ~3.2GB with headroom
6. Push a no-op commit to `main` → Actions green → new `IMAGE_TAG` running (`docker compose ps`)
```

- [ ] **Step 2: Operator runs the checklist against the live droplet**

Expected: health ok, register 201, harness receives `final`, Actions redeploy succeeds.

- [ ] **Step 3: After first successful schema sync, set `TYPEORM_SYNCHRONIZE=false` in droplet `.env` and redeploy**

- [ ] **Step 4: Commit README checklist only if Step 1 was not already committed**

```bash
git add deploy/README.md
git commit -m "$(cat <<'EOF'
docs(deploy): add production verification checklist

EOF
)"
```

---

## Out of scope (follow-ons)

- TypeORM migration files replacing `TYPEORM_SYNCHRONIZE` bootstrap
- Quota-service Postgres persistence (still in-memory today; `quota-db` is unused by app code)
- Blue/green or zero-downtime deploys
- Cloudflare orange-cloud / Full (strict) SSL after certs exist
- macOS client default URL switch to production
- Staging environment
- Monitoring / log drain

## Self-review

1. **Spec coverage:** Public-only `api`, Node 24, Nest monorepo, Groq in production, encrypted transcripts key — covered. Deploy/DNS/TLS/CI — covered in Tasks 2–8. Schema gap vs `synchronize` development-only — Task 1.
2. **Placeholders:** None intentional; script paths and compose service names are concrete.
3. **Type consistency:** `shouldSynchronizeTypeOrm`, image names `type-by-voice-${app}`, domain `tbv-api.nate-ng.com`, secrets table aligned across Tasks 5–7.
