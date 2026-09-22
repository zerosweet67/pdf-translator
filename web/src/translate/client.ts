/**
 * Thin HTTP client for the Cloudflare Worker.
 *
 * Only JSON text blocks are ever sent. The PDF itself never leaves the browser.
 */

export type TranslateErrorKind = 'network' | 'timeout' | 'rate_limit' | 'auth' | 'http' | 'invalid_response';

export class TranslateClientError extends Error {
  readonly kind: TranslateErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    kind: TranslateErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'TranslateClientError';
    this.kind = kind;
    this.status = options.status;
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

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string } | string };
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error.message === 'string') return data.error.message;
  } catch {
    // ignore, fall through
  }
  return `${response.status} ${response.statusText}`.trim();
}

/** Result of POST /auth/verify. The invite code itself is never stored. */
export type InviteResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'network' | 'server' };

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
    if (!res.ok) return { ok: false, reason: 'server' };
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

  /** GET /health → provider/model info, or null when the Worker is unreachable. */
  async health(): Promise<{ provider?: string; model?: string; effort?: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { headers: this.authHeaders(), signal: AbortSignal.timeout(5000) });
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
      return result;
    } catch (err) {
      if (err instanceof TranslateClientError) this.lastFailure = err.kind;
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
      throw new TranslateClientError('auth', 'Session expired or missing. Enter the invite code again.', { status: 401 });
    }

    if (response.status === 429) {
      throw new TranslateClientError('rate_limit', 'Rate limited by the translation provider.', {
        status: 429,
        retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
        retryable: true,
      });
    }

    if (!response.ok) {
      const message = await readErrorMessage(response);
      const retryable = response.status >= 500 && response.status !== 501;
      throw new TranslateClientError('http', `Worker error ${response.status}: ${message}`, {
        status: response.status,
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
