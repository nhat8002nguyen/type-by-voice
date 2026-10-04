/**
 * TRUSTED_PROXY_RANGES lists the hop addresses Express may treat as proxies when it
 * resolves `request.ip`.
 *
 * Every request reaches the api container through nginx, so the socket peer is a
 * container address rather than the caller's. Trusting the container networks makes
 * Express walk X-Forwarded-For instead, where nginx has already overwritten the
 * value with the address it validated (see deploy/nginx/conf.d/tbv-api.conf).
 */
const TRUSTED_PROXY_RANGES: readonly string[] = [
  'loopback',
  'linklocal',
  'uniquelocal',
];

/**
 * applyTrustProxy configures Express so `request.ip` is the caller's address rather
 * than the proxy's.
 *
 * Cloudflare ranges are deliberately absent: nginx collapses the Cloudflare hop
 * into a single forwarded value, so the app never needs to know about it.
 */
export function applyTrustProxy(app: {
  /** set applies an Express application setting. */
  set(key: string, value: unknown): unknown;
}): void {
  app.set('trust proxy', [...TRUSTED_PROXY_RANGES]);
}
