/**
 * Security hardening: rate limits (Durable Object path), token validation,
 * Content-Type / method / body-size protection, CORS, headers, log redaction.
 * The provider is mocked: these tests never call OpenAI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let providerGate: Promise<void> | null = null;
const providerTranslate = vi.fn(async (blocks: { id: string; text: string }[]) => {
  if (providerGate) await providerGate;
  return {
    blocks: blocks.map((b) => ({ id: b.id, translation: `譯:${b.text}` })),
    model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  };
});
const createProvider = vi.fn(() => ({ name: 'mock', model: 'mock-model', translate: providerTranslate }));
vi.mock('../providers', () => ({ createProvider: () => createProvider() }));

import { createAuthToken, TOKEN_TTL_SECONDS } from '../auth';
import {
  AUTH_RATE_LIMIT,
  MAX_BODY_BYTES,
  TRANSLATE_CHAR_BUDGET,
  TRANSLATE_MAX_CONCURRENT,
  TRANSLATE_RATE_LIMIT,
} from '../config';
import type { Env } from '../env';
import worker from '../index';
import { RateLimitCore, resetMemoryRateLimiter } from '../ratelimit';
import { LIMITS } from '../validate';
import { decodeTokenPayload, mockRateLimiterNamespace, signPayload, sleep, type MockNamespace } from './helpers';

const PAGES_ORIGIN = 'https://alice.github.io';
const INVITE = 'friends-2026-long-random-code';
const SECRET = 'unit-test-auth-secret-0123456789abcdef-0123456789';
const BASE = 'https://worker.example';

let namespace: MockNamespace;
let ENV: Env;

beforeEach(() => {
  namespace = mockRateLimiterNamespace();
  ENV = {
    OPENAI_API_KEY: 'sk-test-not-used',
    INVITE_CODE: INVITE,
    AUTH_SECRET: SECRET,
    ALLOWED_ORIGINS: `http://localhost:5173, ${PAGES_ORIGIN}`,
    RATE_LIMITER: namespace,
  };
  providerGate = null;
  providerTranslate.mockClear();
  createProvider.mockClear();
  resetMemoryRateLimiter();
});

interface CallInit extends RequestInit {
  origin?: string | null;
  ip?: string | null;
  env?: Env;
}

function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? 'http://localhost:5173');
  if (init.ip !== null) headers.set('CF-Connecting-IP', init.ip ?? '203.0.113.10');
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), init.env ?? ENV);
}

function verify(code: unknown, init: CallInit = {}): Promise<Response> {
  return call('/auth/verify', {
    method: 'POST',
    body: JSON.stringify(code === undefined ? {} : { code }),
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  });
}

const SMALL_BODY = { targetLanguage: 'zh-TW', blocks: [{ id: 'b1', text: 'Hello world.' }] };

function translate(token: string | undefined, body: unknown = SMALL_BODY, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return call('/translate', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init, headers });
}

async function login(ip = '203.0.113.10'): Promise<string> {
  const res = await verify(INVITE, { ip });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('invite code brute-force protection (POST /auth/verify)', () => {
  it(`wrong code → 401 for the first ${AUTH_RATE_LIMIT.limit} attempts, then 429 TOO_MANY_ATTEMPTS`, async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) {
      const res = await verify(`guess-${i}`);
      expect(res.status).toBe(401);
      expect(await body(res)).toEqual({ ok: false });
    }
    const blocked = await verify(INVITE); // even the right code is refused once the window is exhausted
    expect(blocked.status).toBe(429);
    expect(await body(blocked)).toEqual({ error: 'TOO_MANY_ATTEMPTS' });
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(AUTH_RATE_LIMIT.windowSeconds);
    expect(namespace.keys.size).toBe(1); // one Durable Object for this source
  });

  it('the limit is per source: another IP is not affected', async () => {
    for (let i = 0; i <= AUTH_RATE_LIMIT.limit; i++) await verify('nope', { ip: '198.51.100.1' });
    expect((await verify('nope', { ip: '198.51.100.1' })).status).toBe(429);
    expect((await verify(INVITE, { ip: '198.51.100.2' })).status).toBe(200);
  });

  it('valid invite code → 200 with a token', async () => {
    const res = await verify(INVITE);
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.ok).toBe(true);
    expect(typeof data.token).toBe('string');
  });

  it('the Durable Object key is a keyed hash, never the raw IP', async () => {
    await verify('x', { ip: '198.51.100.77' });
    for (const key of namespace.keys) {
      expect(key).toMatch(/^auth:[0-9a-f]{64}$/);
      expect(key).not.toContain('198.51.100.77');
    }
  });

  it('counters survive Durable Object eviction (persisted state)', async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) await verify('nope');
    namespace.evictAll();
    expect((await verify('nope')).status).toBe(429);
  });

  it('rate limiter outage → 503, never a free pass', async () => {
    namespace.failing = true;
    const res = await verify(INVITE);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: 'SERVICE_UNAVAILABLE' });
  });

  it('a request that only claims an IP via X-Forwarded-For shares the "unknown" bucket', async () => {
    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) {
      await verify('nope', { ip: null, headers: { 'X-Forwarded-For': `10.0.0.${i}` } });
    }
    expect((await verify('nope', { ip: null, headers: { 'X-Forwarded-For': '10.0.0.99' } })).status).toBe(429);
  });
});

describe('session token validation (POST /translate)', () => {
  it('valid token → translation allowed', async () => {
    const res = await translate(await login());
    expect(res.status).toBe(200);
    expect(providerTranslate).toHaveBeenCalledTimes(1);
  });

  it('every rejected token gets the identical 401 { error: "UNAUTHORIZED" } and never reaches the provider', async () => {
    const good = await login();
    const [goodBody, goodSig] = good.split('.');
    const payload = decodeTokenPayload(good) as { v: number; iat: number; exp: number; sid: string };
    const now = Math.floor(Date.now() / 1000);

    const cases: Record<string, string | undefined> = {
      missing: undefined,
      empty: '',
      garbage: 'garbage',
      'three parts': 'a.b.c',
      'non-base64url characters': `${goodBody}.${goodSig}!`,
      'short signature': `${goodBody}.${goodSig.slice(0, 20)}`,
      'signature of another secret': await signPayload(payload, 'another-secret-that-is-long-enough-1234567890'),
      'modified payload, original signature': `${btoa(JSON.stringify({ ...payload, exp: payload.exp + 999_999 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')}.${goodSig}`,
      expired: (await createAuthToken(SECRET, (now - TOKEN_TTL_SECONDS - 5) * 1000)).token,
      'iat far in the future': (await createAuthToken(SECRET, (now + 3600) * 1000)).token,
      'lifetime longer than TOKEN_TTL_SECONDS': (await createAuthToken(SECRET, now * 1000, TOKEN_TTL_SECONDS + 3600)).token,
      'wrong version (properly signed)': await signPayload({ ...payload, v: 2 }, SECRET),
      'missing exp (properly signed)': await signPayload({ v: 1, iat: payload.iat, sid: payload.sid }, SECRET),
      'missing iat (properly signed)': await signPayload({ v: 1, exp: payload.exp, sid: payload.sid }, SECRET),
      'missing sid (properly signed)': await signPayload({ v: 1, iat: payload.iat, exp: payload.exp }, SECRET),
      'non-integer exp (properly signed)': await signPayload({ ...payload, exp: 'soon' }, SECRET),
      'raw invite code as token': INVITE,
      'payload json is an array (properly signed)': await signPayload([1, 2, 3], SECRET),
    };

    for (const [name, token] of Object.entries(cases)) {
      const res = await translate(token);
      expect(res.status, name).toBe(401);
      expect(await body(res), name).toEqual({ error: 'UNAUTHORIZED' });
    }
    expect(createProvider).not.toHaveBeenCalled();
    expect(providerTranslate).not.toHaveBeenCalled();
    // and the untouched token still works
    expect((await translate(good)).status).toBe(200);
  });

  it('GET /auth/check answers 401 { error: "UNAUTHORIZED" } without a session and provider info with one', async () => {
    const anon = await call('/auth/check');
    expect(anon.status).toBe(401);
    expect(await body(anon)).toEqual({ error: 'UNAUTHORIZED' });
    const authed = await call('/auth/check', { headers: { Authorization: `Bearer ${await login()}` } });
    expect(authed.status).toBe(200);
    const data = await body(authed);
    expect(data.ok).toBe(true);
    expect(typeof data.model).toBe('string');
  });
});

describe('translate abuse limits (per session)', () => {
  it(`request ${TRANSLATE_RATE_LIMIT.limit + 1} within a minute → 429 RATE_LIMITED, provider not called for it`, async () => {
    const token = await login();
    for (let i = 0; i < TRANSLATE_RATE_LIMIT.limit; i++) expect((await translate(token)).status).toBe(200);
    const res = await translate(token);
    expect(res.status).toBe(429);
    expect(await body(res)).toEqual({ error: 'RATE_LIMITED' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(providerTranslate).toHaveBeenCalledTimes(TRANSLATE_RATE_LIMIT.limit);
  });

  it('limits are per session: a second session keeps working', async () => {
    const a = await login('203.0.113.1');
    const b = await login('203.0.113.2');
    for (let i = 0; i < TRANSLATE_RATE_LIMIT.limit; i++) await translate(a);
    expect((await translate(a)).status).toBe(429);
    expect((await translate(b)).status).toBe(200);
  });

  it(`a normal PDF (${TRANSLATE_RATE_LIMIT.limit} batches, 3 in parallel) completes without hitting a limit`, async () => {
    const token = await login();
    const batches = Array.from({ length: TRANSLATE_RATE_LIMIT.limit }, (_, i) => ({
      targetLanguage: 'zh-TW',
      blocks: Array.from({ length: 10 }, (_, j) => ({ id: `p${i}-b${j}`, text: `Paragraph ${j} of batch ${i}. `.repeat(20) })),
    }));
    let next = 0;
    const statuses: number[] = [];
    const lane = async () => {
      while (next < batches.length) {
        const res = await translate(token, batches[next++]);
        statuses.push(res.status);
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    expect(statuses).toEqual(Array(TRANSLATE_RATE_LIMIT.limit).fill(200));
  });

  it(`more than ${TRANSLATE_CHAR_BUDGET.limit} characters in ${TRANSLATE_CHAR_BUDGET.windowSeconds / 60} minutes → 429 RATE_LIMITED`, async () => {
    const token = await login();
    // 7 blocks x 5700 chars = 39 900 chars per request (under the 40 000 per-request cap)
    const big = {
      targetLanguage: 'zh-TW',
      blocks: Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, text: 'x'.repeat(5700) })),
    };
    const perRequest = 7 * 5700;
    const fits = Math.floor(TRANSLATE_CHAR_BUDGET.limit / perRequest); // 6
    for (let i = 0; i < fits; i++) expect((await translate(token, big)).status).toBe(200);
    const res = await translate(token, big);
    expect(res.status).toBe(429);
    expect(await body(res)).toEqual({ error: 'RATE_LIMITED' });
    expect(providerTranslate).toHaveBeenCalledTimes(fits);
    // all-or-nothing: the refused request consumed nothing, so a small one that fits the remainder still passes
    expect((await translate(token)).status).toBe(200);
  });

  it(`request ${TRANSLATE_MAX_CONCURRENT + 1} while ${TRANSLATE_MAX_CONCURRENT} are in flight → 429 TOO_MANY_CONCURRENT_REQUESTS`, async () => {
    const token = await login();
    let open: () => void = () => undefined;
    providerGate = new Promise<void>((resolve) => (open = resolve));
    const inFlight = Array.from({ length: TRANSLATE_MAX_CONCURRENT }, () => translate(token));
    await sleep(20); // let the in-flight requests acquire their leases
    expect(providerTranslate).toHaveBeenCalledTimes(TRANSLATE_MAX_CONCURRENT);
    const fifth = await translate(token);
    expect(fifth.status).toBe(429);
    expect(await body(fifth)).toEqual({ error: 'TOO_MANY_CONCURRENT_REQUESTS' });
    open();
    for (const res of await Promise.all(inFlight)) expect(res.status).toBe(200);
    await sleep(20); // lease release runs in the background
    expect((await translate(token)).status).toBe(200);
  });

  it('a lease is released when the provider fails, so errors do not leak concurrency slots', async () => {
    const token = await login();
    providerTranslate.mockRejectedValueOnce(new Error('boom'));
    expect((await translate(token)).status).toBe(500);
    await sleep(10);
    for (let i = 0; i < TRANSLATE_MAX_CONCURRENT; i++) expect((await translate(token)).status).toBe(200);
  });
});

describe('payload protection', () => {
  it('Content-Length above the limit → 413 before the body is read; provider not called', async () => {
    const token = await login();
    const res = await translate(token, SMALL_BODY, { headers: { 'Content-Length': String(MAX_BODY_BYTES.translate + 1) } });
    expect(res.status).toBe(413);
    expect(await body(res)).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' });
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('an actually oversized JSON body (no trustworthy Content-Length) → 413', async () => {
    const token = await login();
    const huge = JSON.stringify({ targetLanguage: 'zh-TW', blocks: [{ id: 'b1', text: 'x'.repeat(MAX_BODY_BYTES.translate + 1000) }] });
    const res = await translate(token, huge);
    expect(res.status).toBe(413);
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('an oversized /auth/verify body → 413', async () => {
    const res = await verify('x'.repeat(MAX_BODY_BYTES.authVerify + 100));
    expect(res.status).toBe(413);
  });

  it('existing validation limits still apply (too many blocks / total chars) → 400, provider not called', async () => {
    const token = await login();
    const tooMany = {
      targetLanguage: 'zh-TW',
      blocks: Array.from({ length: LIMITS.maxBlocks + 1 }, (_, i) => ({ id: `b${i}`, text: 'hi' })),
    };
    expect((await translate(token, tooMany)).status).toBe(400);
    const tooLong = {
      targetLanguage: 'zh-TW',
      blocks: Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, text: 'x'.repeat(LIMITS.maxBlockChars) })),
    };
    expect((await translate(token, tooLong)).status).toBe(400);
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('invalid JSON → 400 INVALID_JSON', async () => {
    const res = await translate(await login(), '{not json');
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ error: 'INVALID_JSON' });
  });
});

describe('Content-Type and method protection', () => {
  it('POST without application/json → 415', async () => {
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
      const res = await call('/auth/verify', { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify({ code: INVITE }) });
      expect(res.status, type).toBe(415);
      expect(await body(res), type).toMatchObject({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    const token = await login();
    const res = await call('/translate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(SMALL_BODY),
    });
    expect(res.status).toBe(415);
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('application/json with a charset parameter is accepted', async () => {
    const res = await call('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ code: INVITE }),
    });
    expect(res.status).toBe(200);
  });

  it('wrong method → 405 with an Allow header', async () => {
    const cases: [string, string, string][] = [
      ['GET', '/translate', 'POST'],
      ['PUT', '/translate', 'POST'],
      ['GET', '/auth/verify', 'POST'],
      ['POST', '/health', 'GET'],
      ['POST', '/auth/check', 'GET'],
      ['DELETE', '/auth/check', 'GET'],
    ];
    const token = await login();
    for (const [method, path, allow] of cases) {
      const res = await call(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get('Allow'), `${method} ${path}`).toBe(allow);
      expect(await body(res)).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    }
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('unknown path → 404', async () => {
    expect((await call('/admin')).status).toBe(404);
  });
});

describe('CORS', () => {
  function preflight(path: string, origin: string): Promise<Response> {
    return call(path, {
      method: 'OPTIONS',
      origin,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
  }

  it('allowed origin: preflight succeeds without a token and the actual response echoes the origin', async () => {
    for (const origin of ['http://localhost:5173', PAGES_ORIGIN]) {
      const pre = await preflight('/translate', origin);
      expect(pre.status).toBe(204);
      expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
      expect(pre.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID');
      const res = await verify(INVITE, { origin });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
  });

  it('unknown origin → 403 for preflight and for the actual request, no wildcard ever', async () => {
    const pre = await preflight('/translate', 'https://evil.example');
    expect(pre.status).toBe(403);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const res = await verify(INVITE, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: 'ORIGIN_NOT_ALLOWED' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const lookalike = await preflight('/translate', `${PAGES_ORIGIN}.evil.example`);
    expect(lookalike.status).toBe(403);
  });
});

describe('response hygiene', () => {
  it('every response carries the security headers and a request id', async () => {
    const responses = [
      await call('/health'),
      await call('/translate', { method: 'OPTIONS' }),
      await translate(undefined),
      await call('/nope'),
      await verify(INVITE, { origin: 'https://evil.example' }),
    ];
    for (const res of responses) {
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
      expect(res.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
    }
    const ids = new Set(responses.map((r) => r.headers.get('X-Request-ID')));
    expect(ids.size).toBe(responses.length);
  });

  it('GET /health reveals nothing but { ok: true }, even to a signed-in client', async () => {
    expect(await body(await call('/health'))).toEqual({ ok: true });
    expect(await body(await call('/health', { headers: { Authorization: `Bearer ${await login()}` } }))).toEqual({ ok: true });
  });

  it('provider failures are mapped to generic errors without provider details', async () => {
    const token = await login();
    providerTranslate.mockRejectedValueOnce(new Error('OpenAI said: invalid_api_key sk-live-abc'));
    const res = await translate(token);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('OpenAI');
    expect(JSON.parse(text)).toEqual({ error: 'INTERNAL_ERROR' });
  });
});

describe('security logging redaction', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    const capture = (...args: unknown[]) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs security events with hashed ip / request id, but never secrets, tokens or the invite code', async () => {
    const token = await login();
    for (let i = 0; i <= AUTH_RATE_LIMIT.limit; i++) await verify('wrong-guess');
    await translate('tampered.token');
    await translate(token);
    providerTranslate.mockRejectedValueOnce(new Error('provider exploded'));
    await translate(token);

    const all = lines.join('\n');
    expect(all).toContain('event=AUTH_RATE_LIMIT');
    expect(all).toContain('event=AUTH_INVITE_REJECTED');
    expect(all).toContain('event=AUTH_TOKEN_REJECTED');
    expect(all).toMatch(/ipHash=[0-9a-f]{12}\b/);
    expect(all).toMatch(/requestId=[0-9a-f-]{36}/);
    expect(all).not.toContain(INVITE);
    expect(all).not.toContain('wrong-guess');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(ENV.OPENAI_API_KEY as string);
    expect(all).not.toContain(token);
    expect(all).not.toContain('203.0.113.10');
    expect(all).not.toContain('Bearer');
  });
});

describe('RateLimitCore (fixed windows + leases)', () => {
  const T0 = 1_700_000_000_000;

  it('fixed window: denies past the limit and resets after windowSeconds', () => {
    const core = new RateLimitCore();
    const spec = { buckets: [{ name: 'a', limit: 3, windowSeconds: 60 }] };
    expect(core.admit(spec, T0).allowed).toBe(true);
    expect(core.admit(spec, T0 + 1000).allowed).toBe(true);
    expect(core.admit(spec, T0 + 2000).allowed).toBe(true);
    const denied = core.admit(spec, T0 + 30_000);
    expect(denied).toEqual({ allowed: false, reason: 'bucket', bucket: 'a', retryAfterSeconds: 30 });
    expect(core.admit(spec, T0 + 60_000).allowed).toBe(true);
  });

  it('all-or-nothing: a denied bucket consumes nothing in the others', () => {
    const core = new RateLimitCore();
    const req = {
      buckets: [
        { name: 'requests', limit: 10, windowSeconds: 60 },
        { name: 'chars', limit: 100, windowSeconds: 300, cost: 60 },
      ],
    };
    expect(core.admit(req, T0).allowed).toBe(true);
    expect(core.admit(req, T0 + 1).allowed).toBe(false); // chars would be 120
    expect(core.snapshot().windows.requests.count).toBe(1);
  });

  it('leases: cap, release, expiry', () => {
    const core = new RateLimitCore();
    const req = { buckets: [], lease: { max: 2, ttlSeconds: 10 } };
    const a = core.admit(req, T0);
    const b = core.admit(req, T0);
    expect(a.allowed && b.allowed).toBe(true);
    expect(core.admit(req, T0)).toMatchObject({ allowed: false, reason: 'concurrency' });
    expect(core.release((a as { leaseId: string }).leaseId, T0)).toBe(true);
    expect(core.admit(req, T0).allowed).toBe(true);
    expect(core.admit(req, T0 + 10_001).allowed).toBe(true); // both expired
    expect(core.admit(req, T0 + 10_001).allowed).toBe(true);
    expect(core.admit(req, T0 + 10_001).allowed).toBe(false);
  });

  it('snapshot round-trips and ignores corrupt data', () => {
    const core = new RateLimitCore();
    core.admit({ buckets: [{ name: 'a', limit: 5, windowSeconds: 60 }] }, T0);
    const restored = new RateLimitCore(core.snapshot());
    expect(restored.snapshot()).toEqual(core.snapshot());
    const corrupt = new RateLimitCore({ windows: { a: { count: -1, resetAt: 'x' } }, leases: { z: NaN } } as never);
    expect(corrupt.isEmpty()).toBe(true);
  });
});

describe('without the RATE_LIMITER binding', () => {
  it('falls back to in-memory counters (still enforces the auth limit within one instance)', async () => {
    const env: Env = { ...ENV, RATE_LIMITER: undefined };
    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) expect((await verify('nope', { env })).status).toBe(401);
    expect((await verify('nope', { env })).status).toBe(429);
  });
});
