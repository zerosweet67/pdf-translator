/**
 * Request validation for POST /translate.
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
} as const;

const TARGET_LANGUAGES = new Set(['zh-TW']);

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
}

export interface TranslateRequest {
  blocks: RequestBlock[];
  targetLanguage: string;
  /** Optional extra terminology, merged over the Worker's defaults. */
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

export function validateTranslateRequest(body: unknown): TranslateRequest {
  if (!body || typeof body !== 'object') throw new ValidationError('Body must be a JSON object.');
  const { blocks, targetLanguage, terminology } = body as {
    blocks?: unknown;
    targetLanguage?: unknown;
    terminology?: unknown;
  };

  if (typeof targetLanguage !== 'string' || !TARGET_LANGUAGES.has(targetLanguage)) {
    throw new ValidationError(`targetLanguage must be one of: ${[...TARGET_LANGUAGES].join(', ')}.`);
  }
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
    const { id, text, contextBefore, contextAfter, incompleteSource } = raw as {
      id?: unknown;
      text?: unknown;
      contextBefore?: unknown;
      contextAfter?: unknown;
      incompleteSource?: unknown;
    };
    if (typeof id !== 'string' || id.length === 0 || id.length > LIMITS.maxIdLength) {
      throw new ValidationError(`blocks[${i}].id must be a string of 1-${LIMITS.maxIdLength} characters.`);
    }
    if (seen.has(id)) throw new ValidationError(`Duplicate block id "${id}".`);
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
    seen.add(id);
    out.push({
      id,
      text,
      contextBefore: optionalContext(contextBefore, `blocks[${i}].contextBefore`),
      contextAfter: optionalContext(contextAfter, `blocks[${i}].contextAfter`),
      incompleteSource: incompleteSource === true ? true : undefined,
    });
  }

  return { blocks: out, targetLanguage, terminology: validateTerminology(terminology) };
}
