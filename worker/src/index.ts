/**
 * Cloudflare Worker: translation proxy.
 *
 *   GET  /health        → { ok:true }                      (public liveness, nothing else)
 *   GET  /auth/check    → 200 { ok:true, expiresAt, provider, model, effort } | 401   (bearer token)
 *   POST /auth/verify   { code } → 200 { ok:true, token, expiresAt } | 401 { ok:false } | 429 TOO_MANY_ATTEMPTS
 *   POST /translate     { blocks:[{id,text,contextBefore?,contextAfter?,incompleteSource?,type?}], targetLanguage:"zh-TW", terminology? }
 *                       → { blocks:[{id,translation}], missing:[...], provider, model, usage, providerCalls }
 *   POST /terminology   { samples:[string], targetLanguage } → { terms:[{source,target,abbreviation}], provider, model, usage }
 *   POST /qa            { blocks:[{id,source,translation,type?,issues?}], targetLanguage, terminology? }
 *                       → { blocks:[{id,ok,translation,issues}], missing:[...], provider, model, usage, providerCalls }
 *                       all three require Authorization: Bearer <session token>; 401 UNAUTHORIZED before any provider call
 *
 * Every response carries X-Request-ID plus security headers. Error bodies are
 * { error: "<CODE>" } (+ a generic `message` for 4xx validation problems); they
 * never contain stack traces, provider payloads or secrets.
 *
 * Request pipeline: request id → origin allowlist → OPTIONS → route/method → Content-Type
 * → auth → body size + JSON → validation → rate limit (Durable Object) → provider → respond.
 * The handler never sees the PDF, only text blocks.
 */

import { authenticate, createAuthToken, inviteCodeMatches, isAuthConfigured } from './auth';
import {
  AUTH_RATE_LIMIT,
  CONCURRENCY_LEASE_SECONDS,
  MAX_BODY_BYTES,
  TRANSLATE_CHAR_BUDGET,
  TRANSLATE_MAX_CONCURRENT,
  TRANSLATE_RATE_LIMIT,
} from './config';
import { buildCorsHeaders, isOriginAllowed, parseAllowedOrigins } from './cors';
import type { Env } from './env';
import { mergeTerminology } from './prompt';
import { createProvider } from './providers';
import {
  ProviderError,
  type ProviderQaVerdict,
  type ProviderTranslation,
  type ProviderUsage,
  type TranslationProvider,
} from './providers/types';
import { createRateLimiter, type AdmitResult, type RateLimiterBackend } from './ratelimit';
import {
  clientIp,
  isJsonContentType,
  keyedHash,
  logSecurity,
  newRequestId,
  readJsonBody,
  shortHash,
  withSecurityHeaders,
} from './security';
import {
  ValidationError,
  validateQaRequest,
  validateTerminologyRequest,
  validateTranslateRequest,
  type QaRequestBlock,
  type RequestBlock,
} from './validate';

// The Durable Object class must be exported from the Worker entry point.
export { RateLimiterDO } from './ratelimit';

/** Route table: path → allowed methods (everything else is 405 with an Allow header). */
const ROUTES: Record<string, readonly string[]> = {
  '/health': ['GET'],
  '/auth/check': ['GET'],
  '/auth/verify': ['POST'],
  '/translate': ['POST'],
  '/terminology': ['POST'],
  '/qa': ['POST'],
};

interface RequestContext {
  requestId: string;
  route: string;
  cors: Headers;
  env: Env;
  limiter: RateLimiterBackend;
  waitUntil: (promise: Promise<unknown>) => void;
}

function json(body: unknown, status: number, headers: Headers, extra?: Record<string, string>): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** Uniform error body. `message` is only ever a generic, non-sensitive hint. */
function fail(ctx: RequestContext, status: number, code: string, message?: string, extra?: Record<string, string>): Response {
  const body: Record<string, unknown> = { error: code };
  if (message) body.message = message;
  return json(body, status, ctx.cors, extra);
}

function unauthorized(ctx: RequestContext): Response {
  return fail(ctx, 401, 'UNAUTHORIZED');
}

function tooManyRequests(ctx: RequestContext, code: string, retryAfterSeconds: number): Response {
  return fail(ctx, 429, code, undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
}

function cleanTranslation(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

interface VerifiedCall<T> {
  results: Map<string, T>;
  missing: string[];
  usage: ProviderUsage;
  providerCalls: number;
}

/**
 * Call the provider, then check that every requested id came back.
 * Ids that are missing are re-sent once on their own. Shared by /translate and /qa.
 */
async function callWithVerification<B extends { id: string }, T extends { id: string }>(
  blocks: B[],
  call: (subset: B[]) => Promise<{ items: T[]; usage?: ProviderUsage }>,
  accept: (item: T) => boolean,
): Promise<VerifiedCall<T>> {
  const wanted = new Set(blocks.map((b) => b.id));
  const results = new Map<string, T>();
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
  let providerCalls = 0;
  const account = (u: ProviderUsage | undefined) => {
    providerCalls++;
    if (!u) return;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedInputTokens += u.cachedInputTokens;
    usage.reasoningTokens += u.reasoningTokens;
  };
  const absorb = (items: T[]) => {
    for (const r of items) {
      if (!wanted.has(r.id)) continue; // ignore invented ids
      if (accept(r) && !results.has(r.id)) results.set(r.id, r);
    }
  };

  const first = await call(blocks);
  account(first.usage);
  absorb(first.items);

  let missing = blocks.filter((b) => !results.has(b.id));
  if (missing.length > 0) {
    console.warn(`[provider] ${missing.length} of ${blocks.length} ids missing, retrying those once`);
    try {
      const second = await call(missing);
      account(second.usage);
      absorb(second.items);
    } catch (err) {
      // Keep what we have; the frontend re-sends missing ids itself.
      console.warn('[provider] retry for missing ids failed', err instanceof Error ? err.message : 'error');
    }
    missing = blocks.filter((b) => !results.has(b.id));
  }

  return { results, missing: missing.map((b) => b.id), usage, providerCalls };
}

function translateWithVerification(
  provider: TranslationProvider,
  blocks: RequestBlock[],
  targetLanguage: string,
  terminology: Record<string, string>,
): Promise<VerifiedCall<ProviderTranslation>> {
  return callWithVerification<RequestBlock, ProviderTranslation>(
    blocks,
    async (subset) => {
      const r = await provider.translate(subset, targetLanguage, terminology);
      return { items: r.blocks.map((b) => ({ id: b.id, translation: cleanTranslation(b.translation) })), usage: r.usage };
    },
    (item) => item.translation.length > 0,
  );
}

function reviewWithVerification(
  provider: TranslationProvider,
  blocks: QaRequestBlock[],
  targetLanguage: string,
  terminology: Record<string, string>,
): Promise<VerifiedCall<ProviderQaVerdict>> {
  return callWithVerification<QaRequestBlock, ProviderQaVerdict>(
    blocks,
    async (subset) => {
      const r = await provider.reviewTranslations(subset, targetLanguage, terminology);
      return {
        items: r.blocks.map((v) => ({ ...v, translation: v.ok ? null : v.translation ? cleanTranslation(v.translation) : null })),
        usage: r.usage,
      };
    },
    // a "not ok" verdict without a correction is useless: treat it as missing so it is retried once
    (item) => item.ok || (item.translation !== null && item.translation.length > 0),
  );
}

/** Body read + size / JSON errors mapped to responses. */
async function readBody(ctx: RequestContext, request: Request, maxBytes: number): Promise<{ body: unknown } | { response: Response }> {
  const result = await readJsonBody(request, maxBytes);
  if (result.ok) return { body: result.value };
  if (result.error === 'too_large') {
    logSecurity('PAYLOAD_TOO_LARGE', { route: ctx.route, status: 413, requestId: ctx.requestId, limit: maxBytes });
    return { response: fail(ctx, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.') };
  }
  return { response: fail(ctx, 400, 'INVALID_JSON', 'Request body must be a JSON object.') };
}

/** The rate limiter is a hard dependency: if it cannot answer, the request is refused (fail closed). */
async function admit(ctx: RequestContext, key: string, req: Parameters<RateLimiterBackend['admit']>[1]): Promise<AdmitResult | Response> {
  try {
    return await ctx.limiter.admit(key, req);
  } catch (err) {
    logSecurity('RATE_LIMIT_STORE_ERROR', {
      route: ctx.route,
      status: 503,
      requestId: ctx.requestId,
      detail: err instanceof Error ? err.message : 'error',
    });
    return fail(ctx, 503, 'SERVICE_UNAVAILABLE', undefined, { 'Retry-After': '5' });
  }
}

let warnedAboutMissingIp = false;

async function handleAuthVerify(ctx: RequestContext, request: Request): Promise<Response> {
  const { env } = ctx;
  if (!isAuthConfigured(env)) {
    console.error('[auth] INVITE_CODE / AUTH_SECRET not configured (AUTH_SECRET needs >= 32 chars)');
    return fail(ctx, 500, 'AUTH_NOT_CONFIGURED');
  }

  // Brute-force protection per source, before the body is even parsed.
  const ip = clientIp(request);
  if (!ip && !warnedAboutMissingIp) {
    warnedAboutMissingIp = true;
    logSecurity('AUTH_NO_CLIENT_IP', { route: ctx.route, requestId: ctx.requestId });
  }
  const ipKey = await keyedHash(ip ?? 'unknown', env.AUTH_SECRET);
  const ipHash = shortHash(ipKey);
  const decision = await admit(ctx, `auth:${ipKey}`, {
    buckets: [{ name: 'attempts', limit: AUTH_RATE_LIMIT.limit, windowSeconds: AUTH_RATE_LIMIT.windowSeconds }],
  });
  if (decision instanceof Response) return decision;
  if (!decision.allowed) {
    logSecurity('AUTH_RATE_LIMIT', { route: ctx.route, status: 429, requestId: ctx.requestId, ipHash });
    return tooManyRequests(ctx, 'TOO_MANY_ATTEMPTS', decision.retryAfterSeconds);
  }

  const read = await readBody(ctx, request, MAX_BODY_BYTES.authVerify);
  if ('response' in read) return read.response;
  const code = (read.body as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_REQUEST', message: 'Invite code is required.' }, 400, ctx.cors);
  }

  if (!(await inviteCodeMatches(code.trim(), (env.INVITE_CODE as string).trim()))) {
    logSecurity('AUTH_INVITE_REJECTED', { route: ctx.route, status: 401, requestId: ctx.requestId, ipHash });
    return json({ ok: false }, 401, ctx.cors);
  }
  const { token, payload } = await createAuthToken(env.AUTH_SECRET as string);
  logSecurity('AUTH_OK', { route: ctx.route, status: 200, requestId: ctx.requestId, ipHash, sid: payload.sid });
  return json({ ok: true, token, expiresAt: payload.exp * 1000 }, 200, ctx.cors);
}

interface ProviderTask<T> {
  /** Body size cap for this route. */
  maxBytes: number;
  parse: (body: unknown) => T;
  /** Source characters, for the per-session character budget. */
  chars: (parsed: T) => number;
  /** The provider work; returns the JSON body (provider / model are added) and a log line. */
  run: (provider: TranslationProvider, parsed: T) => Promise<{ body: Record<string, unknown>; log: string }>;
}

/**
 * Shared pipeline of the three provider routes: auth → body → validation →
 * per-session limits (atomic, one round trip) → provider → response.
 */
async function handleProviderTask<T>(ctx: RequestContext, request: Request, task: ProviderTask<T>): Promise<Response> {
  const { env } = ctx;
  // Auth first: an unauthenticated request never reaches body parsing or the provider.
  const session = await authenticate(request, env);
  if (!session) {
    logSecurity('AUTH_TOKEN_REJECTED', { route: ctx.route, status: 401, requestId: ctx.requestId });
    return unauthorized(ctx);
  }

  const read = await readBody(ctx, request, task.maxBytes);
  if ('response' in read) return read.response;

  let parsed: T;
  try {
    parsed = task.parse(read.body);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : 'Invalid request.';
    return fail(ctx, 400, 'INVALID_REQUEST', message);
  }

  // Per-session limits, checked atomically in one round trip: requests / minute,
  // translated characters / 5 minutes, and a lease for the concurrency cap.
  const chars = task.chars(parsed);
  const sessionKey = `session:${session.sid}`;
  const decision = await admit(ctx, sessionKey, {
    buckets: [
      { name: 'requests', limit: TRANSLATE_RATE_LIMIT.limit, windowSeconds: TRANSLATE_RATE_LIMIT.windowSeconds },
      { name: 'chars', limit: TRANSLATE_CHAR_BUDGET.limit, windowSeconds: TRANSLATE_CHAR_BUDGET.windowSeconds, cost: chars },
    ],
    lease: { max: TRANSLATE_MAX_CONCURRENT, ttlSeconds: CONCURRENCY_LEASE_SECONDS },
  });
  if (decision instanceof Response) return decision;
  if (!decision.allowed) {
    const concurrency = decision.reason === 'concurrency';
    logSecurity(concurrency ? 'TRANSLATE_CONCURRENCY_LIMIT' : 'TRANSLATE_RATE_LIMIT', {
      route: ctx.route,
      status: 429,
      requestId: ctx.requestId,
      sid: session.sid,
      bucket: decision.bucket ?? undefined,
    });
    return tooManyRequests(ctx, concurrency ? 'TOO_MANY_CONCURRENT_REQUESTS' : 'RATE_LIMITED', decision.retryAfterSeconds);
  }

  const releaseLease = () => {
    if (!decision.leaseId) return;
    ctx.waitUntil(ctx.limiter.release(sessionKey, decision.leaseId).catch(() => undefined));
  };

  let provider: TranslationProvider;
  try {
    provider = createProvider(env);
  } catch (err) {
    releaseLease();
    if (err instanceof ProviderError) {
      console.error(`[${ctx.route}] provider not configured: ${err.message}`);
      return fail(ctx, 500, 'PROVIDER_NOT_CONFIGURED');
    }
    throw err;
  }

  try {
    const { body, log } = await task.run(provider, parsed);
    console.log(`[usage] route=${ctx.route} requestId=${ctx.requestId} chars=${chars} ${log}`);
    return json({ ...body, provider: provider.name, model: provider.model }, 200, ctx.cors);
  } catch (err) {
    if (err instanceof ProviderError) {
      // ProviderError messages are written by this Worker (never the provider's raw body).
      console.error(`[${ctx.route}] requestId=${ctx.requestId} provider error ${err.status} ${err.code}: ${err.message}`);
      const extra = err.retryAfterSeconds !== undefined ? { 'Retry-After': String(Math.ceil(err.retryAfterSeconds)) } : undefined;
      const status = err.status === 429 ? 429 : err.status >= 500 ? err.status : 502;
      const code = status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_ERROR';
      return fail(ctx, status, code, 'Translation provider request failed.', extra);
    }
    logSecurity('UNHANDLED_ERROR', {
      route: ctx.route,
      status: 500,
      requestId: ctx.requestId,
      detail: err instanceof Error ? `${err.name}:${err.message}` : 'error',
    });
    return fail(ctx, 500, 'INTERNAL_ERROR');
  } finally {
    releaseLease();
  }
}

function usageLog(usage: ProviderUsage, calls: number): string {
  return (
    `calls=${calls} input=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
    `output=${usage.outputTokens} reasoning=${usage.reasoningTokens}`
  );
}

function handleTranslate(ctx: RequestContext, request: Request): Promise<Response> {
  return handleProviderTask(ctx, request, {
    maxBytes: MAX_BODY_BYTES.translate,
    parse: validateTranslateRequest,
    chars: (p) => p.blocks.reduce((n, b) => n + b.text.length, 0),
    run: async (provider, parsed) => {
      const { results, missing, usage, providerCalls } = await translateWithVerification(
        provider,
        parsed.blocks,
        parsed.targetLanguage,
        mergeTerminology(parsed.terminology),
      );
      const blocks = parsed.blocks
        .filter((b) => results.has(b.id))
        .map((b) => ({ id: b.id, translation: (results.get(b.id) as ProviderTranslation).translation }));
      return {
        body: { blocks, missing, usage, providerCalls },
        log: `blocks=${parsed.blocks.length} ${usageLog(usage, providerCalls)} missing=${missing.length}`,
      };
    },
  });
}

/** One call per document: excerpts in, glossary out. The frontend validates and caps the terms again. */
function handleTerminology(ctx: RequestContext, request: Request): Promise<Response> {
  return handleProviderTask(ctx, request, {
    maxBytes: MAX_BODY_BYTES.terminology,
    parse: validateTerminologyRequest,
    chars: (p) => p.samples.reduce((n, s) => n + s.length, 0),
    run: async (provider, parsed) => {
      const result = await provider.extractTerminology(parsed.samples);
      const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
      return {
        body: { terms: result.terms, usage, providerCalls: 1 },
        log: `samples=${parsed.samples.length} terms=${result.terms.length} ${usageLog(usage, 1)}`,
      };
    },
  });
}

/** Second-pass review of high-risk blocks; the frontend decides which blocks and applies corrections. */
function handleQa(ctx: RequestContext, request: Request): Promise<Response> {
  return handleProviderTask(ctx, request, {
    maxBytes: MAX_BODY_BYTES.qa,
    parse: validateQaRequest,
    chars: (p) => p.blocks.reduce((n, b) => n + b.source.length + b.translation.length, 0),
    run: async (provider, parsed) => {
      const { results, missing, usage, providerCalls } = await reviewWithVerification(
        provider,
        parsed.blocks,
        parsed.targetLanguage,
        mergeTerminology(parsed.terminology),
      );
      const blocks = parsed.blocks.filter((b) => results.has(b.id)).map((b) => results.get(b.id) as ProviderQaVerdict);
      const corrected = blocks.filter((b) => !b.ok).length;
      return {
        body: { blocks, missing, usage, providerCalls },
        log: `blocks=${parsed.blocks.length} corrected=${corrected} ${usageLog(usage, providerCalls)} missing=${missing.length}`,
      };
    },
  });
}

async function handleAuthCheck(ctx: RequestContext, request: Request): Promise<Response> {
  const session = await authenticate(request, ctx.env);
  if (!session) return unauthorized(ctx);
  const { env } = ctx;
  const provider = (env.PROVIDER ?? 'openai').toLowerCase();
  const model = provider === 'openai' ? (env.OPENAI_MODEL ?? 'gpt-5.6-terra') : (env.ANTHROPIC_MODEL ?? 'claude-opus-5');
  const effort = provider === 'openai' ? (env.OPENAI_REASONING_EFFORT ?? 'low') : (env.TRANSLATION_EFFORT ?? 'low');
  return json({ ok: true, expiresAt: session.exp * 1000, provider, model, effort }, 200, ctx.cors);
}

async function route(request: Request, env: Env, requestId: string, waitUntil: RequestContext['waitUntil']): Promise<Response> {
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const cors = buildCorsHeaders(origin, allowed);
  const url = new URL(request.url);
  const ctx: RequestContext = {
    requestId,
    route: url.pathname,
    cors,
    env,
    limiter: createRateLimiter(env.RATE_LIMITER),
    waitUntil,
  };

  // Browser requests from an origin outside the allowlist get nothing, preflight included.
  // Requests without an Origin (curl, monitors) are not CORS requests and pass through;
  // the session token still protects /translate.
  if (origin && !isOriginAllowed(origin, allowed)) {
    logSecurity('ORIGIN_REJECTED', { route: ctx.route, status: 403, requestId, method: request.method });
    return fail(ctx, 403, 'ORIGIN_NOT_ALLOWED');
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const methods = ROUTES[url.pathname];
  if (!methods) return fail(ctx, 404, 'NOT_FOUND');
  if (!methods.includes(request.method)) {
    logSecurity('METHOD_NOT_ALLOWED', { route: ctx.route, status: 405, requestId, method: request.method });
    return fail(ctx, 405, 'METHOD_NOT_ALLOWED', undefined, { Allow: methods.join(', ') });
  }
  if (request.method === 'POST' && !isJsonContentType(request)) {
    logSecurity('UNSUPPORTED_MEDIA_TYPE', { route: ctx.route, status: 415, requestId });
    return fail(ctx, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', {
      'Accept-Post': 'application/json',
    });
  }

  switch (url.pathname) {
    case '/health':
      // Public liveness only. Provider details are on GET /auth/check (signed-in clients).
      return json({ ok: true }, 200, cors);
    case '/auth/check':
      return handleAuthCheck(ctx, request);
    case '/auth/verify':
      return handleAuthVerify(ctx, request);
    case '/translate':
      return handleTranslate(ctx, request);
    case '/terminology':
      return handleTerminology(ctx, request);
    case '/qa':
      return handleQa(ctx, request);
    default:
      return fail(ctx, 404, 'NOT_FOUND');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    const waitUntil = (p: Promise<unknown>) => (ctx ? ctx.waitUntil(p) : void p.catch(() => undefined));
    let response: Response;
    try {
      response = await route(request, env, requestId, waitUntil);
    } catch (err) {
      // Last-resort handler: no stack trace or internals leave the Worker.
      logSecurity('UNHANDLED_ERROR', {
        route: new URL(request.url).pathname,
        status: 500,
        requestId,
        detail: err instanceof Error ? `${err.name}:${err.message}` : 'error',
      });
      const cors = buildCorsHeaders(request.headers.get('Origin'), parseAllowedOrigins(env.ALLOWED_ORIGINS));
      response = json({ error: 'INTERNAL_ERROR' }, 500, cors);
    }
    return withSecurityHeaders(response, requestId);
  },
};
