/**
 * Worker bindings. Secrets come from `wrangler secret put` (or `.dev.vars` locally),
 * plain vars from `[vars]` in wrangler.toml, the rate limiter from `[[durable_objects.bindings]]`.
 */
export interface Env {
  // secrets
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Invite code users type on the first screen. */
  INVITE_CODE?: string;
  /** HMAC-SHA256 key for session tokens (at least 32 characters). */
  AUTH_SECRET?: string;
  // vars
  PROVIDER?: string;
  OPENAI_MODEL?: string;
  /** none | low | medium | high  (Responses API reasoning.effort) */
  OPENAI_REASONING_EFFORT?: string;
  ANTHROPIC_MODEL?: string;
  TRANSLATION_EFFORT?: string;
  ALLOWED_ORIGINS?: string;
  // bindings
  /**
   * Durable Object namespace holding rate-limit counters (auth attempts per source,
   * translate requests / characters / concurrency per session). Optional only so the
   * Worker still boots without it, using an in-memory fallback that is NOT reliable
   * across Worker instances; production must bind it (see wrangler.toml).
   */
  RATE_LIMITER?: DurableObjectNamespace;
}
