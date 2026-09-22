/**
 * Cloudflare Worker: translation proxy.
 *
 *   POST /translate   { blocks:[{id,text,contextBefore?,contextAfter?,incompleteSource?}], targetLanguage:"zh-TW" }
 *                  → { blocks:[{id,translation}], missing:[...], provider, model, usage, providerCalls }
 *                     requires Authorization: Bearer <session token>, else 401 before any provider call
 *   POST /auth/verify { code }  → 200 { ok:true, token, expiresAt } | 401 { ok:false } | 400 (missing code)
 *   GET  /auth/check  → 200 { ok:true, expiresAt } | 401 { ok:false }   (bearer token)
 *   GET  /health      → { ok:true } (+ provider/model/effort when a valid token is sent)
 *
 * Responsibilities: CORS, invite-code auth, validation, provider call, id-set
 * verification with one retry for missing ids, safe error mapping. It never sees the PDF.
 *
 * The handler is split into stages (cors → auth → validate → translate → respond).
 */

import { authenticate, createAuthToken, inviteCodeMatches, isAuthConfigured } from './auth';
import { buildCorsHeaders, isOriginAllowed, parseAllowedOrigins } from './cors';
import type { Env } from './env';
import { mergeTerminology } from './prompt';
import { createProvider } from './providers';
import { ProviderError, type ProviderTranslation, type ProviderUsage, type TranslationProvider } from './providers/types';
import { ValidationError, validateTranslateRequest, type RequestBlock } from './validate';

function json(body: unknown, status: number, headers: Headers): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

function errorResponse(status: number, code: string, message: string, headers: Headers, retryAfter?: number): Response {
  const h = new Headers(headers);
  if (retryAfter !== undefined) h.set('Retry-After', String(Math.ceil(retryAfter)));
  return json({ error: { code, message } }, status, h);
}

function cleanTranslation(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Call the provider, then check that every requested id came back.
 * Ids that are missing are re-sent once on their own.
 */
async function translateWithVerification(
  provider: TranslationProvider,
  blocks: RequestBlock[],
  targetLanguage: string,
  terminology: Record<string, string>,
): Promise<{ translations: Map<string, string>; missing: string[]; usage: ProviderUsage; providerCalls: number }> {
  const wanted = new Set(blocks.map((b) => b.id));
  const translations = new Map<string, string>();
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let providerCalls = 0;
  const account = (u: ProviderUsage | undefined) => {
    providerCalls++;
    if (!u) return;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens;
  };

  const absorb = (results: ProviderTranslation[]) => {
    for (const r of results) {
      if (!wanted.has(r.id)) continue; // ignore invented ids
      const clean = cleanTranslation(r.translation);
      if (clean.length > 0 && !translations.has(r.id)) translations.set(r.id, clean);
    }
  };

  const first = await provider.translate(blocks, targetLanguage, terminology);
  account(first.usage);
  absorb(first.blocks);

  let missing = blocks.filter((b) => !translations.has(b.id));
  if (missing.length > 0) {
    console.warn(`[translate] ${missing.length} of ${blocks.length} ids missing, retrying those once`);
    try {
      const second = await provider.translate(missing, targetLanguage, terminology);
      account(second.usage);
      absorb(second.blocks);
    } catch (err) {
      // Keep what we have; the frontend re-sends missing ids itself.
      console.warn('[translate] retry for missing ids failed', err instanceof Error ? err.message : err);
    }
    missing = blocks.filter((b) => !translations.has(b.id));
  }

  return { translations, missing: missing.map((b) => b.id), usage, providerCalls };
}

function unauthorized(cors: Headers): Response {
  return errorResponse(401, 'unauthorized', 'Missing, invalid or expired session. Enter the invite code again.', cors);
}

async function handleAuthVerify(request: Request, env: Env, cors: Headers): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } }, 400, cors);
  }
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return json({ ok: false, error: { code: 'missing_code', message: 'Invite code is required.' } }, 400, cors);
  }
  if (!isAuthConfigured(env)) {
    console.error('[auth] INVITE_CODE / AUTH_SECRET not configured (AUTH_SECRET needs >= 32 chars)');
    return json({ ok: false, error: { code: 'auth_not_configured', message: 'Service is not configured.' } }, 500, cors);
  }
  if (!(await inviteCodeMatches(code.trim(), (env.INVITE_CODE as string).trim()))) {
    return json({ ok: false }, 401, cors);
  }
  const { token, payload } = await createAuthToken(env.AUTH_SECRET as string);
  return json({ ok: true, token, expiresAt: payload.exp * 1000 }, 200, cors);
}

async function handleTranslate(request: Request, env: Env, cors: Headers): Promise<Response> {
  // Auth first: an unauthenticated request never reaches body parsing or the provider.
  if (!(await authenticate(request, env))) return unauthorized(cors);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'invalid_json', 'Request body must be valid JSON.', cors);
  }

  let parsed;
  try {
    parsed = validateTranslateRequest(body);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : 'Invalid request.';
    return errorResponse(400, 'invalid_request', message, cors);
  }

  let provider: TranslationProvider;
  try {
    provider = createProvider(env);
  } catch (err) {
    if (err instanceof ProviderError) return errorResponse(err.status, err.code, err.message, cors);
    throw err;
  }

  try {
    const { translations, missing, usage, providerCalls } = await translateWithVerification(
      provider,
      parsed.blocks,
      parsed.targetLanguage,
      mergeTerminology(parsed.terminology),
    );
    const blocks = parsed.blocks
      .filter((b) => translations.has(b.id))
      .map((b) => ({ id: b.id, translation: translations.get(b.id) as string }));
    console.log(
      `[usage] blocks=${parsed.blocks.length} calls=${providerCalls} input=${usage.inputTokens} cached=${usage.cachedInputTokens} output=${usage.outputTokens} missing=${missing.length}`,
    );
    return json({ blocks, missing, provider: provider.name, model: provider.model, usage, providerCalls }, 200, cors);
  } catch (err) {
    if (err instanceof ProviderError) {
      return errorResponse(err.status, err.code, err.message, cors, err.retryAfterSeconds);
    }
    console.error('[translate] unexpected failure', err);
    return errorResponse(500, 'internal', 'Unexpected error while translating.', cors);
  }
}

/** Basic hardening on every response (JSON API, no HTML). */
function withSecurityHeaders(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return res;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await route(request, env));
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const cors = buildCorsHeaders(origin, allowed);
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (origin && !isOriginAllowed(origin, allowed)) {
    return errorResponse(403, 'origin_not_allowed', `Origin ${origin} is not in ALLOWED_ORIGINS.`, cors);
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    // Public liveness only; provider details are for signed-in (Developer Mode) clients.
    if (!(await authenticate(request, env))) return json({ ok: true }, 200, cors);
    const provider = (env.PROVIDER ?? 'openai').toLowerCase();
    const model =
      provider === 'openai' ? (env.OPENAI_MODEL ?? 'gpt-5.6-terra') : (env.ANTHROPIC_MODEL ?? 'claude-opus-5');
    const effort = provider === 'openai' ? (env.OPENAI_REASONING_EFFORT ?? 'low') : (env.TRANSLATION_EFFORT ?? 'low');
    return json({ ok: true, provider, model, effort }, 200, cors);
  }

  if (url.pathname === '/auth/verify') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Use POST /auth/verify.', cors);
    }
    return handleAuthVerify(request, env, cors);
  }

  if (url.pathname === '/auth/check') {
    if (request.method !== 'GET') {
      return errorResponse(405, 'method_not_allowed', 'Use GET /auth/check.', cors);
    }
    const session = await authenticate(request, env);
    return session ? json({ ok: true, expiresAt: session.exp * 1000 }, 200, cors) : json({ ok: false }, 401, cors);
  }

  if (url.pathname === '/translate') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Use POST /translate.', cors);
    }
    return handleTranslate(request, env, cors);
  }

  return errorResponse(404, 'not_found', 'Not found.', cors);
}
