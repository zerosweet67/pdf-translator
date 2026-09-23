/**
 * Invite code, session token, protected /translate and CORS.
 * The provider is mocked: these tests never call OpenAI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerTranslate = vi.fn(async (blocks: { id: string; text: string }[]) => ({
  blocks: blocks.map((b) => ({ id: b.id, translation: `譯:${b.text}` })),
  model: 'mock-model',
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
}));
const createProvider = vi.fn(() => ({ name: 'mock', model: 'mock-model', translate: providerTranslate }));

vi.mock('../providers', () => ({ createProvider: () => createProvider() }));

import { createAuthToken, verifyAuthToken, TOKEN_TTL_SECONDS } from '../auth';
import type { Env } from '../env';
import worker from '../index';
import { resetMemoryRateLimiter } from '../ratelimit';

const PAGES_ORIGIN = 'https://alice.github.io';
const ENV: Env = {
  OPENAI_API_KEY: 'sk-test-not-used',
  INVITE_CODE: 'friends-2026',
  AUTH_SECRET: 'x'.repeat(16) + 'test-secret-with-enough-length',
  ALLOWED_ORIGINS: `http://localhost:5173, ${PAGES_ORIGIN}`,
};
const BASE = 'https://worker.example';

function call(path: string, init: RequestInit & { origin?: string | null; env?: Env } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? 'http://localhost:5173');
  headers.set('CF-Connecting-IP', '203.0.113.5');
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), init.env ?? ENV);
}

function verify(code: unknown, origin?: string): Promise<Response> {
  return call('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code === undefined ? {} : { code }),
    origin,
  });
}

const TRANSLATE_BODY = JSON.stringify({ targetLanguage: 'zh-TW', blocks: [{ id: 'b1', text: 'Hello world.' }] });

function translate(token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return call('/translate', { method: 'POST', headers, body: TRANSLATE_BODY });
}

async function login(): Promise<string> {
  const res = await verify('friends-2026');
  return ((await res.json()) as { token: string }).token;
}

beforeEach(() => {
  providerTranslate.mockClear();
  createProvider.mockClear();
  resetMemoryRateLimiter(); // ENV has no RATE_LIMITER binding: the in-memory fallback is used here
});

describe('POST /auth/verify', () => {
  it('correct invite code → 200 with a token that does not contain the code or secrets', async () => {
    const res = await verify('friends-2026');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; token: string; expiresAt: number };
    expect(data.ok).toBe(true);
    expect(data.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload = atob(data.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    expect(payload).not.toContain('friends-2026');
    expect(payload).not.toContain(ENV.AUTH_SECRET);
    expect(payload).not.toContain(ENV.OPENAI_API_KEY);
    expect(data.expiresAt - Date.now()).toBeGreaterThan((TOKEN_TTL_SECONDS - 60) * 1000);
  });

  it('surrounding whitespace in the typed code is ignored', async () => {
    expect((await verify('  friends-2026 ')).status).toBe(200);
  });

  it('wrong invite code → 401 { ok:false } without revealing the code', async () => {
    const res = await verify('friends-2025');
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false });
    expect(text).not.toContain('friends-2026');
  });

  it('missing code → 400', async () => {
    expect((await verify(undefined)).status).toBe(400);
    expect((await verify('')).status).toBe(400);
    expect((await verify(123)).status).toBe(400);
  });

  it('fails closed when INVITE_CODE / AUTH_SECRET are not configured', async () => {
    const res = await call('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'anything' }),
      env: { ...ENV, AUTH_SECRET: 'too-short' },
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /translate authorization', () => {
  it('valid token → translation allowed', async () => {
    const res = await translate(await login());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { blocks: { id: string; translation: string }[] };
    expect(data.blocks).toEqual([{ id: 'b1', translation: '譯:Hello world.' }]);
    expect(providerTranslate).toHaveBeenCalledTimes(1);
  });

  it('missing token → 401, provider never called', async () => {
    const res = await translate();
    expect(res.status).toBe(401);
    expect(createProvider).not.toHaveBeenCalled();
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('invalid token → 401', async () => {
    for (const bad of ['garbage', 'a.b', 'YXV0aGVudGljYXRlZA', btoa('authenticated'), '']) {
      expect((await translate(bad)).status).toBe(401);
    }
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('token signed with another secret → 401', async () => {
    const { token } = await createAuthToken('another-secret-that-is-long-enough-1234567890');
    expect((await translate(token)).status).toBe(401);
  });

  it('expired token → 401', async () => {
    const issuedAt = Date.now() - (TOKEN_TTL_SECONDS + 5) * 1000;
    const { token } = await createAuthToken(ENV.AUTH_SECRET as string, issuedAt);
    expect(await verifyAuthToken(token, ENV.AUTH_SECRET as string, issuedAt + 1000)).not.toBeNull();
    expect((await translate(token)).status).toBe(401);
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('modified token payload (extended exp, original signature) → 401', async () => {
    const token = await login();
    const [body, sig] = token.split('.');
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };
    payload.exp += 365 * 24 * 3600;
    const forged = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await translate(`${forged}.${sig}`)).status).toBe(401);
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('the raw invite code is not accepted as a bearer token', async () => {
    expect((await translate('friends-2026')).status).toBe(401);
  });

  it('GET /auth/check reflects the session', async () => {
    const ok = await call('/auth/check', { headers: { Authorization: `Bearer ${await login()}` } });
    expect(ok.status).toBe(200);
    expect((await call('/auth/check')).status).toBe(401);
  });

  it('GET /health is public and reveals only { ok: true }; provider details live on GET /auth/check', async () => {
    const anon = (await (await call('/health')).json()) as Record<string, unknown>;
    expect(anon).toEqual({ ok: true });
    const authed = (await (
      await call('/auth/check', { headers: { Authorization: `Bearer ${await login()}` } })
    ).json()) as Record<string, unknown>;
    expect(authed.ok).toBe(true);
    expect(authed.model).toBeDefined();
  });
});

describe('CORS', () => {
  async function preflight(origin: string): Promise<Response> {
    return call('/translate', {
      method: 'OPTIONS',
      origin,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
    });
  }

  it('localhost dev origin is allowed', async () => {
    const res = await preflight('http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/POST/);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/GET/);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/OPTIONS/);
    expect(res.headers.get('Access-Control-Allow-Headers')).toMatch(/Content-Type/);
    expect(res.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);
  });

  it('GitHub Pages origin is allowed (preflight and actual request)', async () => {
    const res = await preflight(PAGES_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(PAGES_ORIGIN);
    const login = await verify('friends-2026', PAGES_ORIGIN);
    expect(login.status).toBe(200);
    expect(login.headers.get('Access-Control-Allow-Origin')).toBe(PAGES_ORIGIN);
  });

  it('unknown origin is rejected and never gets a wildcard', async () => {
    const res = await preflight('https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const post = await verify('friends-2026', 'https://evil.example');
    expect(post.status).toBe(403);
    expect(post.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('a look-alike host of the Pages origin does not match', async () => {
    const res = await preflight(`${PAGES_ORIGIN}.evil.example`);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('security headers', () => {
  it('are set on every response', async () => {
    for (const res of [await call('/health'), await translate(), await preflight204()]) {
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    }
  });

  function preflight204(): Promise<Response> {
    return call('/translate', { method: 'OPTIONS' });
  }
});
