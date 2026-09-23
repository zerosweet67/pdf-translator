/**
 * Security / abuse-protection constants, in one place.
 * Plain limits only: no secrets, no per-deployment values (those live in wrangler.toml / secrets).
 */

/** Session lifetime issued by POST /auth/verify: 24 hours. */
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** A token whose `iat` is further in the future than this is rejected (clock skew tolerance). */
export const TOKEN_MAX_FUTURE_IAT_SECONDS = 60;

/** POST /auth/verify: attempts per source (CF-Connecting-IP) per window. */
export const AUTH_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;

/** POST /translate: requests per session per window. Frontend concurrency is 3, a PDF is 12-20 batches. */
export const TRANSLATE_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;

/** POST /translate: total source characters one session may submit per window (cost cap for a stolen token). */
export const TRANSLATE_CHAR_BUDGET = { limit: 250_000, windowSeconds: 5 * 60 } as const;

/** POST /translate: concurrently running requests per session (frontend uses 3). */
export const TRANSLATE_MAX_CONCURRENT = 4;

/**
 * A concurrency lease that is never released (Worker evicted mid-request) expires after this long.
 * Must exceed the longest possible /translate handling time (2 provider calls x 110 s timeout).
 */
export const CONCURRENCY_LEASE_SECONDS = 5 * 60;

/** Maximum HTTP body size per route, in bytes (checked via Content-Length and again while reading). */
export const MAX_BODY_BYTES = {
  /** { "code": "..." } — invite codes are at most 256 characters. */
  authVerify: 4 * 1024,
  /** 50 blocks x 6000 chars + contexts + terminology stays well below this even as multi-byte UTF-8. */
  translate: 512 * 1024,
} as const;
