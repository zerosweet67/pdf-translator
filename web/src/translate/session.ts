/**
 * Session token from POST /auth/verify, kept in sessionStorage only:
 * closing the tab ends the session (entering the invite code again is fine).
 * The Worker is the only party that can validate the token; the expiry read
 * here just avoids showing the app with a token that is obviously stale.
 */

const KEY = 'pdf-translator.session';

interface StoredSession {
  token: string;
  /** ms since epoch */
  expiresAt: number;
}

function read(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof s.token !== 'string' || typeof s.expiresAt !== 'number') return null;
    return { token: s.token, expiresAt: s.expiresAt };
  } catch {
    return null;
  }
}

let memory: StoredSession | null = read();

/** The token if one is stored and not yet expired. */
export function getSessionToken(): string | null {
  if (!memory || memory.expiresAt <= Date.now()) return null;
  return memory.token;
}

export function saveSession(token: string, expiresAt: number): void {
  memory = { token, expiresAt };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // storage blocked: the session still lives in memory until reload
  }
}

export function clearSession(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
