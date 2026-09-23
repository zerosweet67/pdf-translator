/**
 * Request validation for POST /translate, POST /terminology and POST /qa.
 * Limits keep a single request small enough for one provider call.
 */

export const LIMITS = {
  maxBlocks: 50,
  maxBlockChars: 6000,
  maxTotalChars: 40_000,
  maxContextChars: 600,
  maxIdLength: 96,
  maxTerminologyEntries: 200,
  maxTermLength: 120,
  /** POST /terminology: excerpts per request and characters per excerpt / in total. */
  maxSamples: 40,
  maxSampleChars: 2000,
  maxSampleTotalChars: 16_000,
  /** POST /qa: blocks per request, characters (source + translation) in total, warning codes per block. */
  maxQaBlocks: 20,
  maxQaTotalChars: 60_000,
  maxQaIssues: 12,
} as const;

const TARGET_LANGUAGES = new Set(['zh-TW']);
const BLOCK_TYPE_RE = /^[A-Z_]{1,24}$/;
const ISSUE_CODE_RE = /^[A-Z_]{1,40}$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface RequestBlock {
  id: string;
  /** The only text that is translated. */
  text: string;
  /** Context only, never translated. Sent only when the neighbour is not in the same request. */
  contextBefore?: string;
  contextAfter?: string;
  /** Source looks cut off; the model must not invent the missing part. */
  incompleteSource?: boolean;
  /** Block type for the short per-type guidance (TITLE, HEADING, CAPTION, ...). */
  type?: string;
}

export interface TranslateRequest {
  blocks: RequestBlock[];
  targetLanguage: string;
  /** Optional extra terminology, merged over the Worker's defaults. */
  terminology: Record<string, string>;
}

export interface TerminologyRequest {
  samples: string[];
  targetLanguage: string;
}

export interface QaRequestBlock {
  id: string;
  source: string;
  translation: string;
  type?: string;
  issues?: string[];
}

export interface QaRequest {
  blocks: QaRequestBlock[];
  targetLanguage: string;
  terminology: Record<string, string>;
}

function validateTerminology(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('terminology must be an object of { "english term": "中文" }.');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > LIMITS.maxTerminologyEntries) {
    throw new ValidationError(`terminology has too many entries (max ${LIMITS.maxTerminologyEntries}).`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const k = key.trim();
    if (typeof value !== 'string') throw new ValidationError(`terminology["${k}"] must be a string.`);
    const v = value.trim();
    if (!k || !v) continue;
    if (k.length > LIMITS.maxTermLength || v.length > LIMITS.maxTermLength) {
      throw new ValidationError(`terminology entry "${k}" exceeds ${LIMITS.maxTermLength} characters.`);
    }
    out[k] = v;
  }
  return out;
}

function optionalContext(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be a string.`);
  const t = value.trim();
  if (!t) return undefined;
  if (t.length > LIMITS.maxContextChars) {
    throw new ValidationError(`${label} exceeds ${LIMITS.maxContextChars} characters.`);
  }
  return t;
}

function optionalType(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !BLOCK_TYPE_RE.test(value)) {
    throw new ValidationError(`${label} must be an upper-case block type.`);
  }
  return value;
}

function targetLanguageOf(body: { targetLanguage?: unknown }): string {
  const { targetLanguage } = body;
  if (typeof targetLanguage !== 'string' || !TARGET_LANGUAGES.has(targetLanguage)) {
    throw new ValidationError(`targetLanguage must be one of: ${[...TARGET_LANGUAGES].join(', ')}.`);
  }
  return targetLanguage;
}

function validId(id: unknown, i: number, seen: Set<string>): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.maxIdLength) {
    throw new ValidationError(`blocks[${i}].id must be a string of 1-${LIMITS.maxIdLength} characters.`);
  }
  if (seen.has(id)) throw new ValidationError(`Duplicate block id "${id}".`);
  seen.add(id);
  return id;
}

export function validateTranslateRequest(body: unknown): TranslateRequest {
  if (!body || typeof body !== 'object') throw new ValidationError('Body must be a JSON object.');
  const { blocks, terminology } = body as { blocks?: unknown; terminology?: unknown };
  const targetLanguage = targetLanguageOf(body as { targetLanguage?: unknown });

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new ValidationError('blocks must be a non-empty array.');
  }
  if (blocks.length > LIMITS.maxBlocks) {
    throw new ValidationError(`Too many blocks: ${blocks.length} > ${LIMITS.maxBlocks}.`);
  }

  const seen = new Set<string>();
  const out: RequestBlock[] = [];
  let total = 0;

  for (const [i, raw] of blocks.entries()) {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`blocks[${i}] must be an object.`);
    const { id, text, contextBefore, contextAfter, incompleteSource, type } = raw as {
      id?: unknown;
      text?: unknown;
      contextBefore?: unknown;
      contextAfter?: unknown;
      incompleteSource?: unknown;
      type?: unknown;
    };
    const validatedId = validId(id, i, seen);
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ValidationError(`blocks[${i}].text must be a non-empty string.`);
    }
    if (text.length > LIMITS.maxBlockChars) {
      throw new ValidationError(`blocks[${i}].text exceeds ${LIMITS.maxBlockChars} characters.`);
    }
    total += text.length;
    if (total > LIMITS.maxTotalChars) {
      throw new ValidationError(`Total text exceeds ${LIMITS.maxTotalChars} characters. Send smaller batches.`);
    }
    if (incompleteSource !== undefined && typeof incompleteSource !== 'boolean') {
      throw new ValidationError(`blocks[${i}].incompleteSource must be a boolean.`);
    }
    out.push({
      id: validatedId,
      text,
      contextBefore: optionalContext(contextBefore, `blocks[${i}].contextBefore`),
      contextAfter: optionalContext(contextAfter, `blocks[${i}].contextAfter`),
      incompleteSource: incompleteSource === true ? true : undefined,
      type: optionalType(type, `blocks[${i}].type`),
    });
  }

  return { blocks: out, targetLanguage, terminology: validateTerminology(terminology) };
}

/** POST /terminology: { samples: string[], targetLanguage }. */
export function validateTerminologyRequest(body: unknown): TerminologyRequest {
  if (!body || typeof body !== 'object') throw new ValidationError('Body must be a JSON object.');
  const { samples } = body as { samples?: unknown };
  const targetLanguage = targetLanguageOf(body as { targetLanguage?: unknown });
  if (!Array.isArray(samples) || samples.length === 0) throw new ValidationError('samples must be a non-empty array of strings.');
  if (samples.length > LIMITS.maxSamples) throw new ValidationError(`Too many samples: ${samples.length} > ${LIMITS.maxSamples}.`);
  const out: string[] = [];
  let total = 0;
  for (const [i, raw] of samples.entries()) {
    if (typeof raw !== 'string') throw new ValidationError(`samples[${i}] must be a string.`);
    const t = raw.trim();
    if (!t) continue;
    if (t.length > LIMITS.maxSampleChars) throw new ValidationError(`samples[${i}] exceeds ${LIMITS.maxSampleChars} characters.`);
    total += t.length;
    if (total > LIMITS.maxSampleTotalChars) throw new ValidationError(`Total sample text exceeds ${LIMITS.maxSampleTotalChars} characters.`);
    out.push(t);
  }
  if (out.length === 0) throw new ValidationError('samples must contain text.');
  return { samples: out, targetLanguage };
}

/** POST /qa: { blocks: [{id, source, translation, type?, issues?}], targetLanguage, terminology? }. */
export function validateQaRequest(body: unknown): QaRequest {
  if (!body || typeof body !== 'object') throw new ValidationError('Body must be a JSON object.');
  const { blocks, terminology } = body as { blocks?: unknown; terminology?: unknown };
  const targetLanguage = targetLanguageOf(body as { targetLanguage?: unknown });
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ValidationError('blocks must be a non-empty array.');
  if (blocks.length > LIMITS.maxQaBlocks) throw new ValidationError(`Too many blocks: ${blocks.length} > ${LIMITS.maxQaBlocks}.`);

  const seen = new Set<string>();
  const out: QaRequestBlock[] = [];
  let total = 0;
  for (const [i, raw] of blocks.entries()) {
    if (!raw || typeof raw !== 'object') throw new ValidationError(`blocks[${i}] must be an object.`);
    const { id, source, translation, type, issues } = raw as {
      id?: unknown;
      source?: unknown;
      translation?: unknown;
      type?: unknown;
      issues?: unknown;
    };
    const validatedId = validId(id, i, seen);
    for (const [label, value] of [
      ['source', source],
      ['translation', translation],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError(`blocks[${i}].${label} must be a non-empty string.`);
      }
      if (value.length > LIMITS.maxBlockChars) {
        throw new ValidationError(`blocks[${i}].${label} exceeds ${LIMITS.maxBlockChars} characters.`);
      }
      total += value.length;
    }
    if (total > LIMITS.maxQaTotalChars) {
      throw new ValidationError(`Total text exceeds ${LIMITS.maxQaTotalChars} characters. Send smaller batches.`);
    }
    let codes: string[] | undefined;
    if (issues !== undefined && issues !== null) {
      if (!Array.isArray(issues) || issues.length > LIMITS.maxQaIssues) {
        throw new ValidationError(`blocks[${i}].issues must be an array of at most ${LIMITS.maxQaIssues} codes.`);
      }
      codes = [];
      for (const code of issues) {
        if (typeof code !== 'string' || !ISSUE_CODE_RE.test(code)) throw new ValidationError(`blocks[${i}].issues must contain upper-case codes.`);
        codes.push(code);
      }
    }
    out.push({
      id: validatedId,
      source: source as string,
      translation: translation as string,
      type: optionalType(type, `blocks[${i}].type`),
      issues: codes && codes.length ? codes : undefined,
    });
  }
  return { blocks: out, targetLanguage, terminology: validateTerminology(terminology) };
}
