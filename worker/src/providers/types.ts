/**
 * Provider adapter contract. Adding a provider = implementing this interface
 * and registering it in providers/index.ts.
 *
 * Three structured-output tasks share one provider: translation, document
 * terminology extraction and second-pass QA.
 */

import type { QaRequestBlock, RequestBlock } from '../validate';

export interface ProviderTranslation {
  id: string;
  translation: string;
}

/**
 * Token usage of one provider call, as reported by the provider (never estimated).
 *
 * `cachedInputTokens` is a subset of `inputTokens` and `reasoningTokens` a subset
 * of `outputTokens`; neither is ever added on top when totals are computed.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache (part of inputTokens). */
  cachedInputTokens: number;
  /** Reasoning / thinking tokens the model billed as output (part of outputTokens). */
  reasoningTokens: number;
}

export interface ProviderResult {
  blocks: ProviderTranslation[];
  model: string;
  usage?: ProviderUsage;
}

/** One glossary entry as the model returns it (validated by the frontend again). */
export interface ProviderTerm {
  source: string;
  target: string;
  abbreviation: string | null;
}

export interface TerminologyResult {
  terms: ProviderTerm[];
  model: string;
  usage?: ProviderUsage;
}

export interface ProviderQaVerdict {
  id: string;
  ok: boolean;
  translation: string | null;
  issues: string[];
}

export interface QaResult {
  blocks: ProviderQaVerdict[];
  model: string;
  usage?: ProviderUsage;
}

export interface TranslationProvider {
  readonly name: string;
  readonly model: string;
  translate(blocks: RequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<ProviderResult>;
  extractTerminology(samples: string[]): Promise<TerminologyResult>;
  reviewTranslations(blocks: QaRequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<QaResult>;
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

/** Shape-check the terminology reply; drops malformed entries. */
export function normalizeTerms(parsed: unknown): ProviderTerm[] {
  const list = (parsed as { terms?: unknown })?.terms;
  if (!Array.isArray(list)) throw new ProviderError(502, 'invalid_json', 'Model output is missing a "terms" array.');
  const out: ProviderTerm[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { source?: unknown; target?: unknown; abbreviation?: unknown };
    if (typeof e.source !== 'string' || typeof e.target !== 'string') continue;
    out.push({ source: e.source, target: e.target, abbreviation: typeof e.abbreviation === 'string' && e.abbreviation.trim() ? e.abbreviation.trim() : null });
  }
  return out;
}

/** Shape-check the QA reply; drops malformed entries. */
export function normalizeVerdicts(parsed: unknown): ProviderQaVerdict[] {
  const list = (parsed as { blocks?: unknown })?.blocks;
  if (!Array.isArray(list)) throw new ProviderError(502, 'invalid_json', 'Model output is missing a "blocks" array.');
  const out: ProviderQaVerdict[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; ok?: unknown; translation?: unknown; issues?: unknown };
    if (typeof e.id !== 'string' || typeof e.ok !== 'boolean') continue;
    out.push({
      id: e.id,
      ok: e.ok,
      translation: typeof e.translation === 'string' ? e.translation : null,
      issues: Array.isArray(e.issues) ? e.issues.filter((i): i is string => typeof i === 'string') : [],
    });
  }
  return out;
}
