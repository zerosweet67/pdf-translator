/**
 * The one place the frontend learns where the Worker lives.
 *
 *   dev:        web/.env.development → VITE_WORKER_URL=http://127.0.0.1:8787
 *   production: VITE_WORKER_URL set at build time (GitHub Actions repository variable)
 *
 * VITE_* values are compiled into the public bundle, so only the Worker's
 * public URL belongs here, never OPENAI_API_KEY / INVITE_CODE / AUTH_SECRET.
 */

const configured = (import.meta.env.VITE_WORKER_URL as string | undefined)?.trim();

export const WORKER_URL: string = (configured || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '')).replace(/\/+$/, '');
