# Rate limiting and the real client IP

How a request's "client IP" survives three network hops, why the obvious approaches
silently collapse every user into one bucket, and how this repo resolves it.

Written after fixing `fix(api): rate limit per caller instead of per proxy` (`29bd67e`),
where a single shared bucket meant one caller could exhaust the login allowance for
everybody — and where the dictation limit could never have worked at all.

---

## 1. The problem in one line

Rate limiting needs a stable key per caller. Behind a proxy, the address the server
can see is the **proxy's**, not the caller's. Getting it wrong does not throw an
error — it quietly degrades to one bucket (too strict, one user DoSes everyone) or to
a caller-controlled value (too loose, trivially bypassed).

Here there are three distinct addresses in play, and knowing which is which is the
whole exercise:

| Address | What it actually is | Seen by |
|---|---|---|
| `172.18.0.3` | the **nginx container**, as the API's TCP peer | `request.ip` / `socket.remoteAddress` with no proxy awareness |
| `104.21.42.133` | the **Cloudflare edge** your request happened to land on | nginx's `$remote_addr` when the record is proxied |
| `203.0.113.7` | the **caller** | what the rate limiter must key on |

Before the fix, the first one was the key: one bucket for the entire internet.

---

## 2. How a request actually arrives

Cloudflare's proxy status is a **per-DNS-record** setting, and it changes the shape of
the connection, not just the DNS answer.

### Grey cloud — DNS only

Cloudflare answers DNS and then gets out of the way. The client's TCP connection
terminates at **your origin**.

```
client 203.0.113.7 ──TCP──▶ nginx (172.18.0.3) ──▶ api (172.18.0.4)
                             $remote_addr = 203.0.113.7   socket peer = 172.18.0.3
```

- `$remote_addr` **is** the caller. No Cloudflare headers exist.
- The origin IP is public, so anything can also connect to it directly.

### Orange cloud — proxied

Two separate TCP connections. The client's ends at a Cloudflare edge; Cloudflare opens
**its own** connection to your origin.

```
client 203.0.113.7 ──TCP──▶ CF edge 104.21.42.133 ──TCP──▶ nginx ──▶ api
                                       $remote_addr = 104.21.42.133   socket peer = 172.18.0.3
                                       CF-Connecting-IP: 203.0.113.7
```

- `$remote_addr` is now the **edge**, not the caller.
- Cloudflare reports the caller in `CF-Connecting-IP` — "only sent on the traffic from
  Cloudflare's edge to your origin".
- The origin IP is hidden, and you get DDoS absorption, TLS at the edge, caching. That
  is usually why you turn it on.

### What Cloudflare sets, and what it won't let a client set

From Cloudflare's HTTP headers reference:

| Header | Behaviour |
|---|---|
| `CF-Connecting-IP` | The caller's IP. Single, consistent value. **Sent only from a Cloudflare edge.** |
| `X-Forwarded-For` | A *chain*. If the client already sent one, Cloudflare **appends** — so client-supplied junk survives. Cloudflare's own advice is to use `CF-Connecting-IP` instead. |
| `X-Forwarded-Proto` | Overwritten with the protocol the client used. |
| `X-Real-IP` | **Stripped** from the incoming request (absent a Worker subrequest). |
| `True-Client-IP` | Enterprise-only alias of `CF-Connecting-IP`. |

Two consequences worth internalising:

1. `X-Forwarded-For` is **not** trustworthy on its own. It is a list the caller can
   start, so the leftmost entry can be anything the caller felt like claiming.
2. `CF-Connecting-IP` is only trustworthy *because* it comes from Cloudflare. Connect
   directly to the origin and a client can send `CF-Connecting-IP: 1.2.3.4` themselves.
   That is the crux of §4.

### Two different axes people conflate

**Proxy status** (grey/orange) decides *who terminates the connection*.
**SSL/TLS encryption mode** decides *how Cloudflare talks to your origin*:

| Mode | Edge → origin | Consequence for this repo |
|---|---|---|
| Flexible | plain HTTP on port 80 | **Redirect loop.** nginx answers port 80 with `return 301 https://…`, Cloudflare sends it back to port 80, forever. |
| Full | HTTPS, origin cert **not** verified | Works; silently tolerates an expired or wrong origin cert. |
| Full (strict) | HTTPS, origin cert verified | Correct here — the Let's Encrypt cert is valid for `tbv-api.nate-ng.com`. |

A third arrival mode: **Cloudflare Tunnel** (`cloudflared`). No public ingress at all;
connections reach nginx from the tunnel daemon, so `$remote_addr` is the tunnel and
`CF-Connecting-IP` is again the only source of truth.

---

## 3. The five traps

Each of these looks reasonable and is wrong. The first two are what this repo actually
had.

**Trap 1 — the naive default.** `request.ip` is the **socket peer**. Behind nginx that
is the container address, so *every* caller shares one bucket. That is the bug.

```ts
return request.ip || request.socket?.remoteAddress || 'unknown'; // 172.18.0.3, always
```

**Trap 2 — the header you have, not the header you trust.** Using
`X-Real-IP: $remote_addr` in nginx looks like a fix, and in grey mode it is. In orange
mode `$remote_addr` is the *Cloudflare edge*: you get one bucket per edge instead of one
globally. Still shared, just harder to notice.

**Trap 3 — `trust proxy: true`.** Tempting and dangerous. Express then takes the
**leftmost** `X-Forwarded-For` entry, which the caller controls. A caller sends
`X-Forwarded-For: <random>` per request and gets an unlimited supply of fresh buckets —
the rate limiter becomes decorative. Worse than no limiting, because it looks like
protection.

**Trap 4 — hop counting.** "Trust 1 proxy" is correct until the record turns orange and
it becomes 2. The setting silently depends on a DNS toggle in someone else's dashboard.

**Trap 5 — `ngx_http_realip_module`.** The idiomatic nginx answer, and a fine one — but
it is **not in the default build**. nginx's configure docs list `--without-http_geo_module`
and `--without-http_map_module` (so `geo`/`map` *are* built by default) but
`--with-http_realip_module` is explicitly opt-in. On a stock `nginx:alpine` image you may
not have it, and a config that references it fails to load.

---

## 4. How the address is chosen: the actual algorithm

Understanding the rule is what makes the whole thing click. Express delegates to
`proxy-addr`, whose source (in `backend/node_modules`) is short enough to read:

```js
// forwarded(): build the chain, NEAREST FIRST
var addrs = [socketAddr].concat(proxyAddrs);   // [socket, xff[0], xff[1], …]

// alladdrs(): walk outward, stop at the first address we do NOT trust
for (var i = 0; i < addrs.length - 1; i++) {
  if (trust(addrs[i], i)) continue;
  addrs.length = i + 1;
}

// proxyaddr(): the answer is the LAST survivor of that walk
var addr = addrs[addrs.length - 1];
```

So the rule is:

> **The client is the closest address to the socket that is not a trusted proxy.**

Two properties follow, and they are why this design is safe:

- **Forging further left is useless.** Entries to the left of the client are never
  reached, because the walk already stopped.
- **The trust list, not the header, decides.** A caller can put anything in
  `X-Forwarded-For`; they cannot make their own address *appear trusted*.

`parse()` walks the header **backwards**, so the chain ends up nearest-first:

```
X-Forwarded-For: 9.9.9.9, 203.0.113.7   ← "9.9.9.9" is the caller's fabrication
socket peer:     172.18.0.3             ← nginx container

chain (nearest first): [172.18.0.3, 203.0.113.7, 9.9.9.9]
walk: 172.18.0.3 trusted → skip;  203.0.113.7 untrusted → stop → client = 203.0.113.7
```

The fabrication never wins, because the walk already stopped. Measured against
`proxy-addr` directly with the container peer and this repo's trust list:

| `X-Forwarded-For` arriving at the api | Chain after truncation | Resolved client |
|---|---|---|
| `203.0.113.7` | `[172.18.0.3, 203.0.113.7]` | `203.0.113.7` ✅ |
| `9.9.9.9, 203.0.113.7` | `[172.18.0.3, 203.0.113.7]` | `203.0.113.7` ✅ |
| `9.9.9.9, 203.0.113.7, 104.21.42.133` | `[172.18.0.3, 104.21.42.133]` | `104.21.42.133` ❌ |

**The third row is the one to remember.** If nginx *appended* its peer
(`$proxy_add_x_forwarded_for`) while proxied, the final entry is the Cloudflare edge —
and because the app's trust list deliberately excludes Cloudflare, the walk stops there
and the key becomes the edge IP. That is per-edge bucketing: the original bug in subtler
form. The app-side `trust proxy` **cannot** fix it alone.

Hence nginx **overwrites** rather than appends, collapsing the chain to a single
validated value, so row 1 is the only shape the api ever sees.

The trust list is what makes this safe even if a fabrication reached the api:
`'uniquelocal'` = `10/8, 172.16/12, 192.168/16, fc00::/7`, covering the container network.
`proxy-addr` also canonicalises IPv4-mapped IPv6 (`::ffff:172.18.0.3`) before range
matching, so a Docker network configured for IPv6 does not slip through.

---

## 5. The implementation

Two layers. nginx owns the network knowledge; the app just reads one value.

### Layer 1 — nginx resolves and overwrites

`deploy/nginx/conf.d/tbv-api.conf` (mirrored byte-for-byte in `tbv-api.tls.conf.example`):

```nginx
# Is the peer genuinely a Cloudflare edge?
geo $tbv_peer_is_cloudflare {
  default 0;
  173.245.48.0/20 1;          # …Cloudflare's published ranges
  103.21.244.0/22 1;
  # …
}

# The combined key starts with "1" ONLY when the peer is Cloudflare, so a forged
# CF-Connecting-IP from anywhere else falls through to $remote_addr.
map $tbv_peer_is_cloudflare$http_cf_connecting_ip $tbv_client_ip {
  default $remote_addr;
  ~^1.+$  $http_cf_connecting_ip;
}
```

Both proxied locations then **overwrite** rather than append:

```nginx
proxy_set_header X-Real-IP $tbv_client_ip;
proxy_set_header X-Forwarded-For $tbv_client_ip;
```

`~^1.+$` needs care: a bare `1` (Cloudflare peer, no header) must not match, which is
why the regex requires at least one character after the `1`. Get that wrong and an
absent `CF-Connecting-IP` becomes an empty client IP.

Trade-off, stated plainly: overwriting discards the chain, so a request that arrived
through a stacked CDN loses its history. In exchange the API can trust exactly one
value. nginx can still log `$remote_addr` (edge) and `$http_cf_connecting_ip` (caller)
separately if you need the detail.

### Layer 2 — the app reads the one value

```ts
// trust-proxy.ts
const TRUSTED_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal'];
export function applyTrustProxy(app) {
  app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);
}
```

```ts
// rate-limit.guard.ts
export function clientIp(request) {
  return (
    firstHeaderValue(request.headers?.['x-real-ip']) ||   // nginx-validated
    request.ip ||                                          // Express, via trust proxy
    request.socket?.remoteAddress ||                       // no proxy (tests, direct)
    'unknown'
  );
}
```

Note what is deliberately **absent**: Cloudflare ranges. nginx already collapsed that hop
into one value, so the app never needs to know Cloudflare exists. One place to maintain
the list, not two.

`clientIp` preferring the header is also what fixes **WebSockets**. The dictation gateway
receives a raw `IncomingMessage`, which has **no `.ip` property** — so before this change
`clientIp` fell all the way through to `socket.remoteAddress` and the dictate limit was
keyed on nginx no matter what `request.ip` said:

```ts
// dictate.gateway.ts — `req` is IncomingMessage, not an Express request
if (!this.limiter.allowDictateUpgrade(clientIp(req))) { … }
```

### Why both layers, if either would do?

They cover different consumers. `trust proxy` fixes `request.ip` for anything that asks
(including `req.protocol`, which matters for secure cookies behind TLS termination).
`clientIp` reads the header, which is the only option for a raw upgrade request. Each is
individually sufficient for HTTP; together they are robust to the other changing.

---

## 6. Truth table

| DNS mode | `$remote_addr` at nginx | `CF-Connecting-IP` | `$tbv_client_ip` | Bucket key |
|---|---|---|---|---|
| Grey (DNS only) | caller `203.0.113.7` | absent | `$remote_addr` → caller | caller ✅ |
| Orange (proxied) | edge `104.21.42.133` | caller | `CF-Connecting-IP` → caller | caller ✅ |
| Grey, caller forges `CF-Connecting-IP` | caller | forged | `$remote_addr` → caller | caller ✅ |
| Orange, caller forges both | edge | real caller (CF rewrites) | `CF-Connecting-IP` → caller | caller ✅ |

The same nginx config is correct in all four, which is the point — the record's colour is
a toggle someone can flip in a dashboard and the rate limiter should not care.

---

## 7. Interview deep dive

The questions an interviewer reaches for once "I'd rate limit by IP" has been said.

**Q: Where does the client IP come from behind a proxy, and why is it hard?**
The TCP peer is the proxy. The real address only exists in a header, and headers are
attacker-controlled unless you can authenticate the sender. So the problem is not
"parse the header" but "decide which sender you believe". Concretely: nginx's
`$remote_addr` is the caller in grey mode and the CDN edge in orange mode, and
`X-Forwarded-For` is a chain the caller can start.

**Q: Why is naive `X-Forwarded-For` handling dangerous?**
Because it is caller-writable. Taking the leftmost entry (what `trust proxy: true` does)
lets a caller mint a new identity per request and bypass the limit entirely — the worst
outcome, since it fails open while looking secure. You need a trust boundary: either a
known proxy range, or a trusted hop count, or a header the proxy *overwrites* that a
client cannot reach.

**Q: Why not just trust the whole chain?**
You must know where the chain becomes trustworthy. The safe rule is "the closest
address to the socket that is not a trusted proxy" — walk outward, stop at the first
address you do not vouch for. Everything the caller prepended sits further left and is
never consulted. That is `proxy-addr`'s algorithm in Express.

**Q: `trust proxy: true` vs a list?**
`true` means "trust everything", i.e. the leftmost entry wins — caller-controlled. A list
(CIDRs / named ranges) means "these addresses are hops; stop at the first that isn't".
The list is the safe one, and it should be as narrow as the topology allows.

**Q: Why not count hops?**
It couples the code to the deployment's shape. Add a CDN, or toggle a DNS record, and the
hop count changes with no code change — silently shifting the derived IP. Prefer explicit
ranges over an implicit count.

**Q: Where should the trust boundary live — nginx or the app?**
Either works; split it by responsibility. nginx is where network topology already lives
(it terminates the connection), so it resolves the address once and rewrites the headers;
the app then reads a single trusted value and stays ignorant of CDNs. Putting the CDN's
CIDR list in application config means the app must be redeployed to track a change in
someone else's network.

**Q: How do you prove the limiter keys per caller?**
Not by reading the code — by testing the failure mode. From one client IP, send more than
the limit while **varying every caller-controlled input** (a different forged
`X-Real-IP` per request) and while **alternating arrival paths** (direct to the origin,
and via the CDN edge). If the key is right, all of it collapses into one bucket and the
`429` appears at exactly limit + 1. If any layer is wrong, the requests scatter into
extra buckets and it never trips. This repo's verification did exactly that and got
10 requests then `429`:

```
 1 origin-direct  forged X-Real-IP=203.0.113.1   -> 400
 …
10 cloudflare     forged X-Real-IP=203.0.113.10  -> 400
11 origin-direct  forged X-Real-IP=203.0.113.11  -> 429
```

The alternation is the part that proves `CF-Connecting-IP` is being honoured: had nginx
fallen back to `$remote_addr`, the Cloudflare-path requests would have been keyed by the
edge and formed a second bucket, and request 11 would not have tripped.

**Q: What are the inherent limits of IP-based rate limiting?**
IP is a network identity, not a person:
- **NAT / CGNAT** — a whole office or mobile carrier shares one IP, so they share a
  bucket; one heavy user degrades everyone. This is a false positive.
- **Mobile** — the IP changes as the device moves, so a limit can be reset by reconnecting.
  A false negative.
- **IPv6** — a single caller can hold a `/64` and rotate within it. Bucket IPv6 by `/64`,
  not by full address, or the limit is decorative again.
- **Tor / proxies** — cheap to source new addresses.
So: IP limits are a blunt first line. Pair them with a **secondary key** (this repo does —
per-email on login: 10/min per IP *and* 5/min per email, plus exponential backoff after
5 failures) and, for anything that matters, an authenticated key: user ID or API token.

**Q: Which key would you choose?**
Whichever is closest to the thing being protected, cheapest to verify, and hardest for the
attacker to vary. Anonymous endpoints → IP (+ a second dimension). Authenticated → user or
token ID, because that is stable across NAT and survives IP rotation. Login specifically →
both, since IP catches spraying across many accounts and email catches hammering one.

**Q: Where do the counters live?**
Redis, so they are shared across replicas: `INCR` plus `EXPIRE … NX` for a fixed 60s
window from the first hit, and a separate `lock:email:*` counter for backoff. In-process
maps only work for a single instance — this repo keeps one as a test/fallback, and the
dictate path currently uses only that, so it would become per-replica if the API were
scaled. Worth knowing before scaling out.

**Q: Fixed window vs sliding window vs token bucket?**
Fixed window (`INCR` + `EXPIRE`) is one round trip and easy to reason about, but allows a
burst at the boundary: 10 requests at 12:59:59 and 10 more at 13:00:00 passes 20 in a
second. A sliding window (sorted set of timestamps, or two counters weighted by overlap)
smooths that at more cost. A token bucket allows controlled bursts and refill, and is
usually what you want for an API. Choose based on whether you are protecting a *rate* or
an *allowance*.

**Q: What about races and atomicity?**
`INCR` is atomic, so concurrent requests cannot lose a count. The `EXPIRE … NX` matters
for the same reason: setting the TTL unconditionally on every hit would slide the window
forever and the counter would never reset — the window would be immortal. Read-modify-write
in application code (GET then SET) is the anti-pattern to avoid.

**Q: Fail open or fail closed when the store is down?**
Fail **open** for login (an outage should not lock everyone out) and fail **closed** for
expensive or abuse-prone operations (e.g. transcription, which costs money per request).
Decide deliberately and document it; the default of "the guard throws" is a fail-closed
choice whether you meant it or not.

**Q: What should the response look like?**
`429 Too Many Requests`, and ideally `Retry-After` so clients can back off instead of
hammering. This repo returns `429` with a plain message via
`HttpException('Too Many Requests', 429)` and does **not** send `Retry-After` — a client
has to guess the window. Worth adding if clients ever retry aggressively.
Distinguish it from `401`: 401 means "authenticate", 429 means "wait".

**Q: Anything special about WebSockets?**
Yes, and it is easy to miss: the upgrade request is a raw `IncomingMessage`, not an
Express request, so it has no `.ip` and never benefits from `trust proxy`. Any proxy-aware
logic must be written against headers for that path. Also decide what the limit *means*
for a long-lived connection — per upgrade, per concurrent socket, or per message — because
one socket can carry unlimited traffic.

**Q: How do you avoid breaking on a CDN toggle?**
Never let the derived client IP depend on a setting you do not control. Resolve the caller
from the trusted edge and rewrite the header, and validate with a test that exercises both
paths. That is why this design keys on "is the peer Cloudflare" rather than on "the record
is orange".

---

## 8. Pitfalls in this repo

- **The Cloudflare CIDR list is a snapshot.** Refresh from
  `https://api.cloudflare.com/client/v4/ips` when Cloudflare publishes changes. If it
  goes stale, requests from a new range get keyed by the edge IP — partial bucketing, not
  spoofable. The list appears in both `tbv-api.conf` and `tbv-api.tls.conf.example`, which
  must stay identical.
- **The app trusts `X-Real-IP` unconditionally.** Sound only because nginx is the sole
  ingress and always overwrites it. Publishing the api port, or adding a second proxy,
  breaks that assumption.
- **IPv6 is bucketed by full address**, and Cloudflare serves AAAA records, so a `/64`
  holder can rotate. Bucket by `/64` if that matters.
- **`true` vs unset is a one-word change with large consequences.** `trust proxy: true`
  would reopen the spoofing hole while looking equivalent.
- **NAT is a false positive you cannot fix**, only mitigate with a second key.

---

## 9. Reproducing the verification

```bash
# 1. from ONE client IP, exceed the limit while varying every caller-controlled input
#    and alternating arrival paths (origin-direct vs a Cloudflare edge)
for i in $(seq 1 14); do
  email="probe-$i-$(date +%s)@example.com"
  if [ $((i % 2)) -eq 0 ]; then
    path=cloudflare;    extra=(--resolve tbv-api.nate-ng.com:443:104.21.42.133)
  else
    path=origin-direct; extra=(--resolve tbv-api.nate-ng.com:443:116.118.9.222)
  fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "${extra[@]}" \
    -H "X-Real-IP: 203.0.113.$i" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"probe-only-not-a-real-password\"}" \
    https://tbv-api.nate-ng.com/v1/auth/login)
  echo "$i $path -> $code"
done
# expected: 400 for 1-10, then 429 — one bucket, tripped at limit + 1
```

Locally, without a proxy:

```bash
cd backend && pnpm exec vitest run apps/api/src/trust-proxy.spec.ts \
  apps/api/src/rate-limit/rate-limit.guard.spec.ts
```

`trust-proxy.spec.ts` asserts `request.ip` follows the forwarded chain, that a forged
entry left of the proxy's own entry is ignored, and that two callers get distinct
addresses. The guard spec asserts one caller exhausting its limit leaves another
unaffected.

---

## 10. File map

| File | Role |
|---|---|
| `deploy/nginx/conf.d/tbv-api.conf` | `geo`/`map` resolve `$tbv_client_ip`; both proxied locations overwrite `X-Real-IP` / `X-Forwarded-For` |
| `deploy/nginx/conf.d/tbv-api.tls.conf.example` | byte-identical template; `init-letsencrypt.sh` restores the live conf from it |
| `backend/apps/api/src/trust-proxy.ts` | `applyTrustProxy()` — container ranges for Express `trust proxy` |
| `backend/apps/api/src/main.ts` | creates a `NestExpressApplication` and applies it before listening |
| `backend/apps/api/src/rate-limit/rate-limit.guard.ts` | `clientIp()` prefers the nginx-validated `X-Real-IP`; the limits and Redis keys |
| `backend/apps/api/src/dictate/dictate.gateway.ts` | the raw-upgrade path that needs the header branch |
| `backend/apps/api/src/trust-proxy.spec.ts` | proves the forwarded chain resolves to the caller |
