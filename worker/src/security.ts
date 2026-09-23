/**
 * Request-level hardening shared by every route: request ids, security headers,
 * strict Content-Type, bounded body reading, redacted security logging.
 */

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Headers set on every response (JSON API, nothing is cacheable, nothing embeds). */
export function withSecurityHeaders(response: Response, requestId: string): Response {
  const res = new Response(response.body, response);
  res.headers.set('X-Request-ID', requestId);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return res;
}

/** True for `application/json` (any charset parameter). */
export function isJsonContentType(request: Request): boolean {
  const raw = request.headers.get('Content-Type');
  if (!raw) return false;
  return raw.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * The client address as seen by Cloudflare's edge. `CF-Connecting-IP` is set by
 * Cloudflare itself and overwritten if a client tries to supply it, so it is
 * trustworthy on *.workers.dev / Cloudflare-proxied hosts. `X-Forwarded-For`
 * is deliberately NOT used. Returns null when absent (e.g. some local dev setups).
 */
export function clientIp(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP')?.trim();
  return ip ? ip : null;
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Keyed hash of a value (an IP) so counters and logs never hold the raw address.
 * With `secret` it is HMAC-SHA256 (not reversible without the secret); without
 * one it falls back to plain SHA-256.
 */
export async function keyedHash(value: string, secret: string | undefined): Promise<string> {
  if (secret) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`ip:${value}`)));
  }
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(`ip:${value}`)));
}

/** Short form for logs: 12 hex characters of the keyed hash. */
export function shortHash(fullHash: string): string {
  return fullHash.slice(0, 12);
}

export type BodyReadResult<T = unknown> =
  | { ok: true; value: T; bytes: number }
  | { ok: false; error: 'too_large' | 'invalid_json' | 'empty' };

/**
 * Read a JSON body of at most `maxBytes`. Rejects on Content-Length before reading
 * anything, and again while streaming for chunked / unlabelled bodies, so a
 * multi-megabyte JSON never gets parsed.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, error: 'too_large' };
  }
  if (!request.body) return { ok: false, error: 'empty' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (total === 0) return { ok: false, error: 'empty' };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)), bytes: total };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

export type SecurityEvent =
  | 'ORIGIN_REJECTED'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'AUTH_RATE_LIMIT'
  | 'AUTH_INVITE_REJECTED'
  | 'AUTH_OK'
  | 'AUTH_TOKEN_REJECTED'
  | 'AUTH_NO_CLIENT_IP'
  | 'TRANSLATE_RATE_LIMIT'
  | 'TRANSLATE_CONCURRENCY_LIMIT'
  | 'RATE_LIMIT_STORE_ERROR'
  | 'UNHANDLED_ERROR';

/**
 * One-line, grep-able security log. Only pass identifiers and numbers: never a
 * token, header value, invite code, secret or translation text. Values are
 * flattened to a single line so log injection through a crafted value is not possible.
 */
export function logSecurity(event: SecurityEvent, fields: Record<string, string | number | undefined>): void {
  const parts = [`event=${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${String(v).replace(/[\s"]+/g, '_').slice(0, 120)}`);
  }
  const line = `[Security] ${parts.join(' ')}`;
  if (event === 'RATE_LIMIT_STORE_ERROR' || event === 'UNHANDLED_ERROR') console.error(line);
  else console.warn(line);
}
