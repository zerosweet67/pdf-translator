/**
 * Provider adapter contract. Adding a provider = implementing this interface
 * and registering it in providers/index.ts.
 */

import type { RequestBlock } from '../validate';

export interface ProviderTranslation {
  id: string;
  translation: string;
}

/** Token usage of one provider call, as reported by the provider. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache (part of inputTokens). */
  cachedInputTokens: number;
}

export interface ProviderResult {
  blocks: ProviderTranslation[];
  model: string;
  usage?: ProviderUsage;
}

export interface TranslationProvider {
  readonly name: string;
  readonly model: string;
  translate(
    blocks: RequestBlock[],
    targetLanguage: string,
    terminology: Record<string, string>,
  ): Promise<ProviderResult>;
}

/** Error that is safe to surface to the frontend (no stack traces, no provider payloads). */
export class ProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Shape-check a parsed JSON payload into ProviderTranslation[]; drops malformed entries. */
export function normalizeTranslations(parsed: unknown): ProviderTranslation[] {
  const list = (parsed as { blocks?: unknown })?.blocks;
  if (!Array.isArray(list)) throw new ProviderError(502, 'invalid_json', 'Model output is missing a "blocks" array.');
  const out: ProviderTranslation[] = [];
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as ProviderTranslation).id === 'string' &&
      typeof (entry as ProviderTranslation).translation === 'string'
    ) {
      out.push({ id: (entry as ProviderTranslation).id, translation: (entry as ProviderTranslation).translation });
    }
  }
  return out;
}
