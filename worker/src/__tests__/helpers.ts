/**
 * Test doubles shared by the Worker tests.
 *
 * `mockRateLimiterNamespace()` runs the real RateLimiterDO class behind a fake
 * DurableObjectNamespace / DurableObjectState, so the Worker → stub.fetch →
 * Durable Object path is exercised under plain vitest (no workerd needed).
 */

import { RateLimiterDO } from '../ratelimit';

type Stored = Map<string, unknown>;

class FakeStorage {
  constructor(private readonly map: Stored) {}
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    // Persist a copy, like real storage (the object must survive instance eviction).
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

class FakeState {
  readonly storage: FakeStorage;
  ready: Promise<unknown> = Promise.resolve();
  constructor(map: Stored) {
    this.storage = new FakeStorage(map);
  }
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.ready = p;
    return p;
  }
}

export interface MockNamespace extends DurableObjectNamespace {
  /** Drop every live instance (their storage survives), simulating eviction. */
  evictAll(): void;
  /** Number of distinct keys that were ever addressed. */
  readonly keys: Set<string>;
  /** Make every DO request fail (simulates an outage). */
  failing: boolean;
}

export function mockRateLimiterNamespace(): MockNamespace {
  const storages = new Map<string, Stored>();
  let instances = new Map<string, { state: FakeState; object: RateLimiterDO }>();
  const keys = new Set<string>();

  function instance(name: string) {
    let live = instances.get(name);
    if (!live) {
      let stored = storages.get(name);
      if (!stored) {
        stored = new Map();
        storages.set(name, stored);
      }
      const state = new FakeState(stored);
      const object = new RateLimiterDO(state as unknown as DurableObjectState, {});
      live = { state, object };
      instances.set(name, live);
    }
    return live;
  }

  // Requests to one object are serialized, like a real Durable Object.
  const queues = new Map<string, Promise<unknown>>();

  const ns = {
    keys,
    failing: false,
    evictAll() {
      instances = new Map();
    },
    idFromName(name: string) {
      keys.add(name);
      return { name, toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = String(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (ns.failing) throw new Error('durable object unavailable (simulated)');
          const run = async () => {
            const live = instance(name);
            await live.state.ready;
            return live.object.fetch(new Request(input, init));
          };
          const prev = queues.get(name) ?? Promise.resolve();
          const next = prev.then(run, run);
          queues.set(name, next.catch(() => undefined));
          return next;
        },
      } as unknown as DurableObjectStub;
    },
  };
  return ns as unknown as MockNamespace;
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign an arbitrary payload exactly like auth.ts does (for tampering tests). */
export async function signPayload(payload: unknown, secret: string): Promise<string> {
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64Url(new Uint8Array(sig))}`;
}

export function decodeTokenPayload(token: string): Record<string, unknown> {
  return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
