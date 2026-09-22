/**
 * CORS for the browser frontend.
 * Only origins listed in the ALLOWED_ORIGINS var receive Access-Control-Allow-Origin
 * (an explicit allowlist, never `*`, because requests carry a session token).
 * An origin is scheme + host (+ port), e.g. https://<user>.github.io, never a path.
 */

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

export function isOriginAllowed(origin: string, allowed: Set<string>): boolean {
  return allowed.has(origin.replace(/\/+$/, ''));
}

export function buildCorsHeaders(origin: string | null, allowed: Set<string>): Headers {
  const headers = new Headers();
  headers.set('Vary', 'Origin');
  if (origin && isOriginAllowed(origin, allowed)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}
