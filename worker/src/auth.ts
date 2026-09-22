/**
 * Invite-code gate + short-lived signed session tokens.
 *
 *   POST /auth/verify { code }  → invite code checked against env.INVITE_CODE
 *                                 → token = base64url(payload) "." base64url(HMAC-SHA256(AUTH_SECRET, base64url(payload)))
 *   Authorization: Bearer <token> on every protected route → verifyAuthToken()
 *
 * The payload only holds timestamps and a random session id; it never contains
 * the invite code, the provider key or any secret. No database: a token is
 * valid while its signature matches and `exp` is in the future. Rotating
 * AUTH_SECRET invalidates every issued token at once.
 */

import type { Env } from './env';

/** Session lifetime: 24 hours. */
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Refuse to sign with a short, guessable AUTH_SECRET. */
export const MIN_AUTH_SECRET_LENGTH = 32;
/** Longer inputs are rejected without hashing. */
export const MAX_INVITE_CODE_LENGTH = 256;

export interface TokenPayload {
  v: 1;
  /** issued at, unix seconds */
  iat: number;
  /** expires at, unix seconds */
  exp: number;
  /** random session id (not secret, only for logs / future per-session limits) */
  sid: string;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** True when both INVITE_CODE and a long enough AUTH_SECRET are configured. */
export function isAuthConfigured(env: Env): boolean {
  return !!env.INVITE_CODE && !!env.AUTH_SECRET && env.AUTH_SECRET.length >= MIN_AUTH_SECRET_LENGTH;
}

/**
 * Compare the submitted code with INVITE_CODE without leaking where they differ:
 * both are hashed first, then the fixed-length digests are compared in full.
 */
export async function inviteCodeMatches(input: string, expected: string): Promise<boolean> {
  if (!expected || input.length === 0 || input.length > MAX_INVITE_CODE_LENGTH) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(input)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function createAuthToken(
  secret: string,
  nowMs = Date.now(),
  ttlSeconds = TOKEN_TTL_SECONDS,
): Promise<{ token: string; payload: TokenPayload }> {
  const iat = Math.floor(nowMs / 1000);
  const sid = base64UrlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const payload: TokenPayload = { v: 1, iat, exp: iat + ttlSeconds, sid };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return { token: `${body}.${base64UrlEncode(new Uint8Array(signature))}`, payload };
}

/**
 * 1. signature (constant-time via crypto.subtle.verify), 2. payload shape, 3. expiration.
 * Returns the payload, or null for anything that is not a valid, unexpired token.
 */
export async function verifyAuthToken(token: string, secret: string, nowMs = Date.now()): Promise<TokenPayload | null> {
  if (!token || !secret || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const signature = base64UrlDecode(sig);
  if (!body || !signature || signature.length !== 32) return null;

  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(body));
  if (!valid) return null;

  const raw = base64UrlDecode(body);
  if (!raw) return null;
  let payload: Partial<TokenPayload>;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Partial<TokenPayload>;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.sid !== 'string') {
    return null;
  }
  if (payload.exp * 1000 <= nowMs) return null;
  return payload as TokenPayload;
}

/** `Authorization: Bearer <token>` → token, else null. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Verify the request's bearer token against env.AUTH_SECRET. Fails closed when auth is not configured. */
export async function authenticate(request: Request, env: Env): Promise<TokenPayload | null> {
  if (!isAuthConfigured(env)) return null;
  const token = readBearerToken(request);
  if (!token) return null;
  return verifyAuthToken(token, env.AUTH_SECRET as string);
}
