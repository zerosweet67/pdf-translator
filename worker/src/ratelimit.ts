/**
 * Rate limiting: fixed-window counters + concurrency leases, one state per key.
 *
 *   key "auth:<hmac(ip)>"    bucket "attempts"  5 / 60 s
 *   key "session:<sid>"      bucket "requests"  20 / 60 s
 *                            bucket "chars"     250 000 / 300 s
 *                            lease              max 4 active, expires after 300 s
 *
 * Storage: a Durable Object per key (binding RATE_LIMITER). A Durable Object
 * processes one request at a time, so "check then increment" is atomic and the
 * count is global, which neither Workers KV (eventually consistent, 1 write/s per
 * key, no atomic increment) nor an in-memory Map (per Worker instance) can give.
 *
 * The in-memory backend below exists only so the Worker still runs when the
 * binding is missing (unit tests, misconfigured dev); it is NOT a production
 * security mechanism and the Worker logs a warning when it is used.
 *
 * Nothing but counters, timestamps and random lease ids is ever stored here.
 */

export interface BucketSpec {
  /** Bucket name inside the key's state, e.g. "requests". */
  name: string;
  /** Maximum sum of `cost` per window. */
  limit: number;
  windowSeconds: number;
  /** Amount this request consumes (default 1). */
  cost?: number;
}

export interface LeaseSpec {
  /** Maximum simultaneously held leases. */
  max: number;
  /** A lease that is never released expires after this long. */
  ttlSeconds: number;
}

export interface AdmitRequest {
  buckets: BucketSpec[];
  lease?: LeaseSpec;
}

export type AdmitResult =
  | { allowed: true; leaseId: string | null }
  | { allowed: false; reason: 'bucket' | 'concurrency'; bucket: string | null; retryAfterSeconds: number };

interface WindowState {
  count: number;
  /** ms since epoch at which the window resets. */
  resetAt: number;
}

export interface PersistedState {
  windows: Record<string, WindowState>;
  /** leaseId → ms since epoch at which the lease expires. */
  leases: Record<string, number>;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Pure, synchronous limiter logic for one key. All-or-nothing: nothing is consumed when any check fails. */
export class RateLimitCore {
  private readonly windows = new Map<string, WindowState>();
  private readonly leases = new Map<string, number>();

  constructor(saved?: PersistedState | null) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, w] of Object.entries(saved.windows ?? {})) {
      if (w && isFiniteNonNegative(w.count) && isFiniteNonNegative(w.resetAt)) this.windows.set(name, { ...w });
    }
    for (const [id, exp] of Object.entries(saved.leases ?? {})) {
      if (isFiniteNonNegative(exp)) this.leases.set(id, exp);
    }
  }

  admit(req: AdmitRequest, now = Date.now()): AdmitResult {
    this.prune(now);

    // Phase 1: check everything.
    for (const spec of req.buckets) {
      const cost = spec.cost ?? 1;
      const w = this.windows.get(spec.name);
      const count = w && w.resetAt > now ? w.count : 0;
      if (count + cost > spec.limit) {
        const resetAt = w && w.resetAt > now ? w.resetAt : now + spec.windowSeconds * 1000;
        return {
          allowed: false,
          reason: 'bucket',
          bucket: spec.name,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        };
      }
    }
    if (req.lease && this.leases.size >= req.lease.max) {
      return { allowed: false, reason: 'concurrency', bucket: null, retryAfterSeconds: 2 };
    }

    // Phase 2: consume.
    for (const spec of req.buckets) {
      const cost = spec.cost ?? 1;
      const w = this.windows.get(spec.name);
      if (w && w.resetAt > now) w.count += cost;
      else this.windows.set(spec.name, { count: cost, resetAt: now + spec.windowSeconds * 1000 });
    }
    let leaseId: string | null = null;
    if (req.lease) {
      leaseId = crypto.randomUUID();
      this.leases.set(leaseId, now + req.lease.ttlSeconds * 1000);
    }
    return { allowed: true, leaseId };
  }

  release(leaseId: string, now = Date.now()): boolean {
    this.prune(now);
    return this.leases.delete(leaseId);
  }

  /** Drop expired windows and leases. */
  prune(now = Date.now()): void {
    for (const [name, w] of this.windows) if (w.resetAt <= now) this.windows.delete(name);
    for (const [id, exp] of this.leases) if (exp <= now) this.leases.delete(id);
  }

  isEmpty(): boolean {
    return this.windows.size === 0 && this.leases.size === 0;
  }

  snapshot(): PersistedState {
    return { windows: Object.fromEntries(this.windows), leases: Object.fromEntries(this.leases) };
  }
}

// ---------------------------------------------------------------------------
// Durable Object: one instance per key, JSON over fetch (no RPC base class so
// the same code runs under plain vitest with a mocked namespace).
// ---------------------------------------------------------------------------

export type RateLimitOp = ({ op: 'admit' } & AdmitRequest) | { op: 'release'; leaseId: string };

const STORAGE_KEY = 'state';

export class RateLimiterDO {
  private core = new RateLimitCore();

  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
  ) {
    // Load the persisted counters before the first request is processed.
    void this.state.blockConcurrencyWhile(async () => {
      this.core = new RateLimitCore(await this.state.storage.get<PersistedState>(STORAGE_KEY));
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let op: RateLimitOp;
    try {
      op = (await request.json()) as RateLimitOp;
    } catch {
      return new Response(null, { status: 400 });
    }
    const now = Date.now();
    let result: unknown;
    if (op.op === 'admit' && Array.isArray(op.buckets)) {
      result = this.core.admit(op, now);
    } else if (op.op === 'release' && typeof op.leaseId === 'string') {
      result = { released: this.core.release(op.leaseId, now) };
    } else {
      return new Response(null, { status: 400 });
    }
    this.core.prune(now);
    if (this.core.isEmpty()) await this.state.storage.delete(STORAGE_KEY);
    else await this.state.storage.put(STORAGE_KEY, this.core.snapshot());
    return Response.json(result);
  }
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

export interface RateLimiterBackend {
  readonly kind: 'durable-object' | 'memory';
  admit(key: string, req: AdmitRequest): Promise<AdmitResult>;
  release(key: string, leaseId: string): Promise<void>;
}

export class DurableObjectRateLimiter implements RateLimiterBackend {
  readonly kind = 'durable-object';

  constructor(private readonly namespace: DurableObjectNamespace) {}

  private async call(key: string, op: RateLimitOp): Promise<unknown> {
    const stub = this.namespace.get(this.namespace.idFromName(key));
    const res = await stub.fetch('https://rate-limiter.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op),
    });
    if (!res.ok) throw new Error(`rate limiter returned HTTP ${res.status}`);
    return res.json();
  }

  async admit(key: string, req: AdmitRequest): Promise<AdmitResult> {
    const result = (await this.call(key, { op: 'admit', ...req })) as AdmitResult;
    if (typeof result?.allowed !== 'boolean') throw new Error('rate limiter returned an invalid result');
    return result;
  }

  async release(key: string, leaseId: string): Promise<void> {
    await this.call(key, { op: 'release', leaseId });
  }
}

/** Per-isolate fallback. Counts are lost on restart and not shared between Worker instances. */
export class MemoryRateLimiter implements RateLimiterBackend {
  readonly kind = 'memory';
  private readonly cores = new Map<string, RateLimitCore>();

  private core(key: string): RateLimitCore {
    let c = this.cores.get(key);
    if (!c) {
      c = new RateLimitCore();
      this.cores.set(key, c);
    }
    return c;
  }

  async admit(key: string, req: AdmitRequest): Promise<AdmitResult> {
    const c = this.core(key);
    const result = c.admit(req);
    if (c.isEmpty()) this.cores.delete(key);
    return result;
  }

  async release(key: string, leaseId: string): Promise<void> {
    const c = this.cores.get(key);
    if (!c) return;
    c.release(leaseId);
    if (c.isEmpty()) this.cores.delete(key);
  }

  /** Test helper. */
  reset(): void {
    this.cores.clear();
  }
}

let memoryFallback: MemoryRateLimiter | null = null;
let warnedAboutFallback = false;

export function createRateLimiter(namespace: DurableObjectNamespace | undefined): RateLimiterBackend {
  if (namespace) return new DurableObjectRateLimiter(namespace);
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      '[Security] event=RATE_LIMIT_FALLBACK_MEMORY detail=RATE_LIMITER_binding_missing_using_per_instance_memory_counters_NOT_safe_for_production',
    );
  }
  memoryFallback ??= new MemoryRateLimiter();
  return memoryFallback;
}

/** Test helper: forget the fallback's counters. */
export function resetMemoryRateLimiter(): void {
  memoryFallback?.reset();
}
