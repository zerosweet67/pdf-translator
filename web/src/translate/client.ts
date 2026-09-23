/**
 * Thin HTTP client for the Cloudflare Worker.
 *
 * Only JSON text blocks are ever sent. The PDF itself never leaves the browser.
 */

export type TranslateErrorKind =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'payload_too_large'
  | 'http'
  | 'invalid_response';

/**
 * Error surfaced to the UI. `message` is always written by this client (generic,
 * never the Worker's or provider's raw text); `code` is the Worker's error code
 * (e.g. RATE_LIMITED) and `requestId` the Worker's X-Request-ID for support/debugging.
 * Neither ever contains the session token.
 */
export class TranslateClientError extends Error {
  readonly kind: TranslateErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    kind: TranslateErrorKind,
    message: string,
    options: { status?: number; code?: string; requestId?: string; retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'TranslateClientError';
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * One unit as sent to the Worker. Ordinary blocks are just { id, text };
 * layout data (page, coordinates, fonts, overlay flags) never leaves the browser.
 */
export interface WorkerBlockInput {
  id: string;
  /** The only text that gets translated. */
  text: string;
  /** Context only, never translated. Present only when the neighbour is not in the same request. */
  contextBefore?: string;
  contextAfter?: string;
  /** Source looks cut off; the model must not invent the missing part. */
  incompleteSource?: boolean;
}

/** Provider token usage summed over the Worker's provider calls for one request. */
export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface WorkerBlockOutput {
  id: string;
  translation: string;
}

export interface WorkerTranslateResponse {
  blocks: WorkerBlockOutput[];
  /** Ids the Worker could not get a translation for, even after its own retry. */
  missing: string[];
  provider?: string;
  model?: string;
  usage?: WorkerUsage;
  /** Provider calls made for this request (1, or 2 when the Worker retried missing ids). */
  providerCalls?: number;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Worker error body: { error: "<CODE>", message?: "<generic hint>" }. */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string') return data.error;
  } catch {
    // no JSON body
  }
  return undefined;
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get('X-Request-ID') ?? undefined;
}

/** Console-only note for a failed Worker call: status, code and request id (never headers or tokens). */
function noteFailure(route: string, response: Response, code: string | undefined): void {
  console.warn(`[worker] ${route} → HTTP ${response.status}${code ? ` ${code}` : ''} (request id: ${requestIdOf(response) ?? 'n/a'})`);
}

/** Result of POST /auth/verify. The invite code itself is never stored. */
export type InviteResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'network' | 'server' };

export interface TranslateClientAuth {
  /** Current session token, sent as Authorization: Bearer. */
  getToken: () => string | null;
  /** Called when the Worker answers 401 (missing / invalid / expired session). */
  onUnauthorized?: () => void;
}

export class TranslateClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly auth: TranslateClientAuth | undefined;
  /** Kind of the most recent failed /translate call; cleared by a success. */
  lastFailure: TranslateErrorKind | null = null;
  /** The most recent failed /translate call itself (for the user-facing message); cleared by a success. */
  lastError: TranslateClientError | null = null;

  constructor(baseUrl: string, timeoutMs = 120_000, auth?: TranslateClientAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.auth = auth;
  }

  private authHeaders(): Record<string, string> {
    const token = this.auth?.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** POST /auth/verify: the Worker compares the code with its INVITE_CODE secret. */
  async verifyInvite(code: string): Promise<InviteResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (res.status === 401 || res.status === 400) return { ok: false, reason: 'invalid' };
    if (res.status === 429) {
      noteFailure('/auth/verify', res, await readErrorCode(res));
      return { ok: false, reason: 'rate_limited' };
    }
    if (!res.ok) {
      noteFailure('/auth/verify', res, await readErrorCode(res));
      return { ok: false, reason: 'server' };
    }
    try {
      const data = (await res.json()) as { ok?: unknown; token?: unknown; expiresAt?: unknown };
      if (data.ok === true && typeof data.token === 'string' && typeof data.expiresAt === 'number') {
        return { ok: true, token: data.token, expiresAt: data.expiresAt };
      }
    } catch {
      // fall through
    }
    return { ok: false, reason: 'server' };
  }

  /** GET /auth/check → 'valid' | 'invalid' (401) | 'unknown' (Worker unreachable or other error). */
  async checkSession(): Promise<'valid' | 'invalid' | 'unknown'> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/check`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) return 'invalid';
      return res.ok ? 'valid' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  get endpoint(): string {
    return `${this.baseUrl}/translate`;
  }

  /**
   * Provider/model info for Developer Mode, or null when the Worker is unreachable or the
   * session is invalid. GET /health is public and deliberately says nothing but { ok:true };
   * the details come from the authenticated GET /auth/check.
   */
  async workerInfo(): Promise<{ provider?: string; model?: string; effort?: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/check`, { headers: this.authHeaders(), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return (await res.json()) as { provider?: string; model?: string; effort?: string };
    } catch {
      return null;
    }
  }

  async translate(
    blocks: WorkerBlockInput[],
    targetLanguage: string,
    terminology: Record<string, string> = {},
  ): Promise<WorkerTranslateResponse> {
    try {
      const result = await this.translateOnce(blocks, targetLanguage, terminology);
      this.lastFailure = null;
      this.lastError = null;
      return result;
    } catch (err) {
      if (err instanceof TranslateClientError) {
        this.lastFailure = err.kind;
        this.lastError = err;
      }
      throw err;
    }
  }

  private async translateOnce(
    blocks: WorkerBlockInput[],
    targetLanguage: string,
    terminology: Record<string, string>,
  ): Promise<WorkerTranslateResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const payload: Record<string, unknown> = { blocks, targetLanguage };
    if (Object.keys(terminology).length > 0) payload.terminology = terminology;

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new TranslateClientError('timeout', `Worker did not answer within ${this.timeoutMs / 1000}s.`, {
          retryable: true,
        });
      }
      throw new TranslateClientError(
        'network',
        `Cannot reach the Worker at ${this.endpoint}. ` +
          'Check that `wrangler dev` is running and that this origin is listed in ALLOWED_ORIGINS (CORS).',
        { retryable: true },
      );
    }
    clearTimeout(timer);

    if (response.status === 401) {
      // Not retryable: the session is missing or expired; the UI asks for the invite code again.
      this.auth?.onUnauthorized?.();
      throw new TranslateClientError('auth', 'Session expired or missing. Enter the invite code again.', {
        status: 401,
        code: 'UNAUTHORIZED',
        requestId: requestIdOf(response),
      });
    }

    if (!response.ok) {
      const code = await readErrorCode(response);
      const requestId = requestIdOf(response);
      noteFailure('/translate', response, code);
      const common = { status: response.status, code, requestId };

      if (response.status === 429) {
        // Worker per-session limit (RATE_LIMITED / TOO_MANY_CONCURRENT_REQUESTS) or the provider's
        // own limit (PROVIDER_RATE_LIMITED): wait for Retry-After, then the batch is retried.
        throw new TranslateClientError('rate_limit', 'Too many translation requests. Waiting before retrying.', {
          ...common,
          retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
          retryable: true,
        });
      }
      if (response.status === 413) {
        throw new TranslateClientError('payload_too_large', 'This batch is too large for the translation service.', common);
      }
      const retryable = response.status >= 500 && response.status !== 501;
      throw new TranslateClientError('http', `Translation service error (HTTP ${response.status}${code ? `, ${code}` : ''}).`, {
        ...common,
        retryable,
      });
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new TranslateClientError('invalid_response', 'Worker returned a non-JSON body.', { retryable: true });
    }

    return normalizeResponse(data);
  }
}

function normalizeResponse(data: unknown): WorkerTranslateResponse {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { blocks?: unknown }).blocks)) {
    throw new TranslateClientError('invalid_response', 'Worker response is missing a "blocks" array.', {
      retryable: true,
    });
  }
  const raw = data as {
    blocks: unknown[];
    missing?: unknown;
    provider?: unknown;
    model?: unknown;
    usage?: { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown };
    providerCalls?: unknown;
  };
  const blocks: WorkerBlockOutput[] = [];
  for (const entry of raw.blocks) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as WorkerBlockOutput).id === 'string' &&
      typeof (entry as WorkerBlockOutput).translation === 'string'
    ) {
      blocks.push({ id: (entry as WorkerBlockOutput).id, translation: (entry as WorkerBlockOutput).translation });
    }
  }
  const missing = Array.isArray(raw.missing) ? raw.missing.filter((m): m is string => typeof m === 'string') : [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage =
    raw.usage && typeof raw.usage === 'object'
      ? { inputTokens: num(raw.usage.inputTokens), outputTokens: num(raw.usage.outputTokens), cachedInputTokens: num(raw.usage.cachedInputTokens) }
      : undefined;
  return {
    blocks,
    missing,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    usage,
    providerCalls: typeof raw.providerCalls === 'number' ? raw.providerCalls : undefined,
  };
}
