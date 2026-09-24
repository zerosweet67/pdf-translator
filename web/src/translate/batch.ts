/**
 * Batch translation orchestration.
 *
 *  - reading order is preserved: batches are consecutive slices of the block list
 *  - a batch closes at MAX_BLOCKS blocks or MAX_CHARS characters (text + context), whichever first
 *  - a few batches run concurrently
 *  - transport failures retry with backoff; 429 honours Retry-After
 *  - ids missing from a response are re-sent on their own (never the whole batch again)
 *  - nothing throws to the caller: every block ends as done / cached / skipped / failed
 *
 * Token economy (see README §8):
 *  - blocks the classifier let through but that need no translation (numbers,
 *    DOI, URL, e-mail, citation marker) are marked `skipped` and never sent;
 *  - the cache is consulted per block with a whitespace-normalized key plus
 *    the hash of the glossary entries relevant to that block;
 *  - previous/next context is dropped whenever the neighbouring unit is in
 *    the same request: the model already sees it there in reading order, so
 *    the text would only be sent twice. Context survives only across batch
 *    boundaries and next to cached / skipped neighbours;
 *  - the payload carries id, text and (rarely) contextBefore / contextAfter /
 *    incompleteSource / type. Layout, fonts, pages and debug data stay in the browser;
 *  - a batch carries only the glossary entries that occur in its blocks.
 *
 * Academic fidelity (translate/protect.ts, entities.ts, risk.ts):
 *  - citations, figure/table references, DOIs, URLs and e-mails are replaced
 *    by placeholders before the request and restored afterwards;
 *  - every translation is checked for lost placeholders, changed numbers /
 *    statistics and changed citations, then scored; the result lives in
 *    `entry.quality` and drives the second-pass QA (qa.ts).
 *
 * `TranslationStats` records requests, chars and tokens (estimated, plus the
 * provider's real usage when the Worker reports it) for Developer Mode.
 */

import { isUntranslatableText } from '../pdf/classify';
import { isCjkChar } from '../pdf/fit';
import { roleOf, WORKER_ROLE_TYPES } from '../pdf/roles';
import type { BlockQuality, TranslationBlock, TranslationEntry } from '../pdf/types';
import type { TranslationCache } from './cache';
import { TranslateClient, TranslateClientError, type WorkerBlockInput, type WorkerUsage } from './client';
import { compareNumeric } from './entities';
import { compareCitations, protectText, restoreText, type ProtectedText } from './protect';
import { assessRisk } from './risk';
import { relevantTerms, terminologyHash, toWorkerTerminology, type TermEntry } from './terminology';

export const DEFAULT_MAX_BLOCKS = 25;
/** Text + context characters per request; the Worker accepts up to 40 000. */
export const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const MISSING_RETRY_BATCH_SIZE = 5;

/** Rough size of the Worker's system prompt after compression + a few matched glossary terms. */
const PROMPT_TOKENS_ESTIMATE = 650;
/** JSON keys, id and quotes per unit in the request and in the reply. */
const PER_UNIT_OVERHEAD_TOKENS = 12;
/**
 * The policy before this optimization, for the "saved" figure: full prompt
 * with the whole glossary (~4 200 chars), 15 blocks / 12 000 chars per
 * request, 150-char contexts sent even when the neighbour was in the batch.
 */
const LEGACY_PROMPT_TOKENS = 1050;
const LEGACY_MAX_BLOCKS = 15;
const LEGACY_MAX_CHARS = 12_000;
const LEGACY_CONTEXT_RATIO = 150 / 120;

/** Block types that get a short guidance line in the Worker prompt; BODY is the default and is not sent. */
const TYPED_BLOCKS = new Set(['TITLE', 'HEADING', 'CAPTION', 'FOOTNOTE', 'TABLE']);
/** Table and figure units are logical cells (pdf/table.ts, pdf/figure.ts): the Worker gets the cell guidance. */
const TABLE_CELL_TYPE = 'TABLE_CELL';

/** Cheap token estimate: ~4 English characters or ~0.8 CJK character per token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjk++;
    else other++;
  }
  return Math.ceil(other / 4 + cjk * 1.2);
}

export interface BatchProgress {
  message: string;
  batchesTotal: number;
  batchesStarted: number;
  batchesDone: number;
  blocksTotal: number;
  blocksDone: number;
  blocksFailed: number;
}

export interface TranslationStats {
  /** HTTP requests sent to the Worker. */
  requests: number;
  /** Provider calls behind them (the Worker retries missing ids once itself). */
  providerCalls: number;
  /** Requests that re-sent something: transport retries and missing-id passes. */
  retryRequests: number;
  blocksTotal: number;
  translatedBlocks: number;
  cachedBlocks: number;
  skippedBlocks: number;
  failedBlocks: number;
  /** Characters of `text` sent to the API. */
  inputChars: number;
  /** Context characters actually sent (after dropping in-batch neighbours). */
  contextChars: number;
  /** Context characters the units carried before batching. */
  contextCharsAssigned: number;
  /** Units that were sent with contextBefore / contextAfter. */
  extraContextBlocks: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Tokens of the retry requests (real usage when available, else estimated). */
  retryTokens: number;
  /** Summed provider usage, null when no response carried usage. */
  usage: WorkerUsage | null;
  /** What the previous policy would have sent for the same blocks (estimate). */
  baselineEstimatedInputTokens: number;
  baselineRequests: number;
  durationMs: number;
  /** Glossary entries sent, summed over requests (only the relevant ones per batch). */
  terminologyEntriesSent: number;
  /** Citations / references / DOIs / URLs / e-mails replaced by placeholders. */
  protectedEntities: number;
  /** Blocks with at least one placeholder that did not come back. */
  placeholderWarnings: number;
  /** Blocks whose numbers / statistics differ from the source. */
  numericWarnings: number;
  /** Blocks whose citations differ from the source. */
  citationWarnings: number;
  /** Blocks scored high-risk by the post-checks (QA candidates). */
  highRiskBlocks: number;
}

export interface TranslateBlocksOptions {
  client: TranslateClient;
  cache: TranslationCache;
  targetLanguage: string;
  /** Document glossary (user + auto); only the entries relevant to a batch are sent with it. */
  terms?: readonly TermEntry[];
  /** Placeholder protection of citations / references / DOIs / URLs (default true). */
  protect?: boolean;
  maxBlocksPerBatch?: number;
  maxCharsPerBatch?: number;
  concurrency?: number;
  maxAttempts?: number;
  /**
   * All units of the document in reading order. Lets a batch drop the context
   * of neighbours it already contains. Without it every assigned context is sent.
   */
  documentOrder?: readonly TranslationBlock[];
  onProgress?: (progress: BatchProgress) => void;
  /** Called whenever one block's entry changes, for incremental UI updates. */
  onEntry?: (entry: TranslationEntry) => void;
  /** Once aborted, no further batches are started (requests in flight finish and are cached). */
  signal?: AbortSignal;
}

function contextLength(block: TranslationBlock): number {
  return (block.previousContext?.length ?? 0) + (block.nextContext?.length ?? 0);
}

/** Consecutive slices: a batch closes when the next block would exceed either limit. */
export function makeBatches(blocks: TranslationBlock[], maxBlocks: number, maxChars: number): TranslationBlock[][] {
  const batches: TranslationBlock[][] = [];
  let current: TranslationBlock[] = [];
  let chars = 0;
  for (const block of blocks) {
    const len = block.text.length + contextLength(block);
    if (current.length > 0 && (current.length >= maxBlocks || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(block);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Request payload for one batch: id + text, plus context only when the
 * neighbour that context comes from is not part of this same request.
 * `texts` (id → protected text) replaces the source text when given.
 */
export function buildPayload(
  batch: TranslationBlock[],
  documentOrder?: readonly TranslationBlock[],
  texts?: ReadonlyMap<string, string>,
): WorkerBlockInput[] {
  const inBatch = new Set(batch.map((b) => b.id));
  const index = documentOrder ? new Map(documentOrder.map((u, i) => [u.id, i])) : null;
  const order = documentOrder ?? [];
  return batch.map((b) => {
    const input: WorkerBlockInput = { id: b.id, text: texts?.get(b.id) ?? b.text };
    const i = index?.get(b.id);
    const prevInBatch = i !== undefined && i > 0 && inBatch.has(order[i - 1].id);
    const nextInBatch = i !== undefined && i < order.length - 1 && inBatch.has(order[i + 1].id);
    if (b.previousContext && !prevInBatch) input.contextBefore = b.previousContext;
    if (b.nextContext && !nextInBatch) input.contextAfter = b.nextContext;
    if (b.incompleteSource) input.incompleteSource = true;
    // A detector-assigned layout role (structured label, sidebar heading /
    // label / body) carries its own one-line guidance; otherwise the block type.
    const role = roleOf(b);
    if (WORKER_ROLE_TYPES.has(role)) input.type = role;
    else if (b.type === 'TABLE' || b.type === 'FIGURE') input.type = TABLE_CELL_TYPE;
    else if (TYPED_BLOCKS.has(b.type)) input.type = b.type;
    return input;
  });
}

function payloadTokens(payload: WorkerBlockInput[]): number {
  let n = PROMPT_TOKENS_ESTIMATE;
  for (const p of payload) {
    n += PER_UNIT_OVERHEAD_TOKENS + estimateTokens(p.text);
    if (p.contextBefore) n += estimateTokens(p.contextBefore);
    if (p.contextAfter) n += estimateTokens(p.contextAfter);
  }
  return n;
}

/** Input tokens the previous policy would have used for these (uncached) blocks. */
function baselineEstimate(pending: TranslationBlock[]): { tokens: number; requests: number } {
  const batches = makeBatches(pending, LEGACY_MAX_BLOCKS, LEGACY_MAX_CHARS);
  let tokens = batches.length * LEGACY_PROMPT_TOKENS;
  for (const b of pending) {
    tokens += PER_UNIT_OVERHEAD_TOKENS + estimateTokens(b.text);
    tokens += Math.ceil(estimateTokens(`${b.previousContext ?? ''}${b.nextContext ?? ''}`) * LEGACY_CONTEXT_RATIO);
  }
  return { tokens, requests: batches.length };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTranslation(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Post-translation checks of one block: placeholders, numbers, citations,
 * risk score. Pure; used for fresh translations and for cache hits alike.
 */
export function assessTranslation(
  block: TranslationBlock,
  translation: string,
  options: { terminologyHash: string; protectedEntities: number; placeholderMissing: string[] },
): BlockQuality {
  const numeric = compareNumeric(block.text, translation);
  const citation = compareCitations(block.text, translation);
  const risk = assessRisk({
    source: block.text,
    translation,
    wasMerged: block.wasMerged,
    crossPage: block.pages.length > 1,
    incompleteSource: block.incompleteSource,
    numeric,
    citation,
    placeholderMissing: options.placeholderMissing.length,
  });
  return {
    terminologyHash: options.terminologyHash,
    protectedEntities: options.protectedEntities,
    placeholderMissing: options.placeholderMissing,
    numericMissing: numeric.missing,
    numericAdded: numeric.added,
    citationMissing: citation.missing,
    citationAdded: citation.added,
    riskScore: risk.score,
    riskReasons: risk.reasons,
    riskLevel: risk.level,
    qaTriggers: risk.triggers,
    highRisk: risk.high,
    qa: 'none',
    qaIssues: [],
    originalTranslation: null,
  };
}

/**
 * Translate `blocks`, writing results into `entries` (keyed by block id).
 * Existing entries are overwritten; blocks already in the cache are not sent.
 */
export async function translateBlocks(
  blocks: TranslationBlock[],
  entries: Map<string, TranslationEntry>,
  options: TranslateBlocksOptions,
): Promise<TranslationStats> {
  const {
    client,
    cache,
    targetLanguage,
    terms = [],
    protect = true,
    maxBlocksPerBatch = DEFAULT_MAX_BLOCKS,
    maxCharsPerBatch = DEFAULT_MAX_CHARS,
    concurrency = DEFAULT_CONCURRENCY,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    documentOrder,
    onProgress,
    onEntry,
    signal,
  } = options;

  const started = performance.now();
  const progress: BatchProgress = {
    message: 'Preparing blocks...',
    batchesTotal: 0,
    batchesStarted: 0,
    batchesDone: 0,
    blocksTotal: blocks.length,
    blocksDone: 0,
    blocksFailed: 0,
  };
  const stats: TranslationStats = {
    requests: 0,
    providerCalls: 0,
    retryRequests: 0,
    blocksTotal: blocks.length,
    translatedBlocks: 0,
    cachedBlocks: 0,
    skippedBlocks: 0,
    failedBlocks: 0,
    inputChars: 0,
    contextChars: 0,
    contextCharsAssigned: 0,
    extraContextBlocks: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    retryTokens: 0,
    usage: null,
    baselineEstimatedInputTokens: 0,
    baselineRequests: 0,
    durationMs: 0,
    terminologyEntriesSent: 0,
    protectedEntities: 0,
    placeholderWarnings: 0,
    numericWarnings: 0,
    citationWarnings: 0,
    highRiskBlocks: 0,
  };
  const finish = (): TranslationStats => {
    stats.failedBlocks = progress.blocksFailed;
    stats.durationMs = Math.round(performance.now() - started);
    return stats;
  };
  const report = (message?: string) => {
    if (message) progress.message = message;
    onProgress?.({ ...progress });
  };

  const update = (id: string, patch: Partial<TranslationEntry>) => {
    const prev = entries.get(id) ?? { id, status: 'pending', translation: null, error: null };
    const next: TranslationEntry = { ...prev, ...patch };
    entries.set(id, next);
    onEntry?.(next);
  };

  const countWarnings = (q: BlockQuality) => {
    if (q.placeholderMissing.length) stats.placeholderWarnings++;
    if (q.numericMissing.length || q.numericAdded.length) stats.numericWarnings++;
    if (q.citationMissing.length || q.citationAdded.length) stats.citationWarnings++;
    if (q.highRisk) stats.highRiskBlocks++;
  };

  report();

  // Per-block glossary relevance (cache key + batch glossary) and placeholder protection.
  const relevantById = new Map<string, TermEntry[]>();
  const hashById = new Map<string, string>();
  const protectedById = new Map<string, ProtectedText>();
  const protectedTexts = new Map<string, string>();

  // 1. skip what needs no API call, then cache lookup
  const pending: TranslationBlock[] = [];
  for (const block of blocks) {
    if (isUntranslatableText(block.text)) {
      update(block.id, { status: 'skipped', translation: null, error: null, quality: undefined });
      stats.skippedBlocks++;
      progress.blocksDone++;
      continue;
    }
    const relevant = relevantTerms(terms, block.text);
    const hash = terminologyHash(relevant);
    relevantById.set(block.id, relevant);
    hashById.set(block.id, hash);
    const cached = cache.get(block.text, targetLanguage, hash);
    if (cached !== undefined) {
      const quality = assessTranslation(block, cached, { terminologyHash: hash, protectedEntities: 0, placeholderMissing: [] });
      countWarnings(quality);
      update(block.id, { status: 'cached', translation: cached, error: null, quality });
      stats.cachedBlocks++;
      progress.blocksDone++;
    } else {
      const p = protect ? protectText(block.text) : { text: block.text, placeholders: [] };
      protectedById.set(block.id, p);
      protectedTexts.set(block.id, p.text);
      stats.protectedEntities += p.placeholders.length;
      update(block.id, { status: 'pending', translation: null, error: null, quality: undefined });
      pending.push(block);
    }
  }
  for (const b of pending) stats.contextCharsAssigned += contextLength(b);
  const baseline = baselineEstimate(pending);
  stats.baselineEstimatedInputTokens = baseline.tokens;
  stats.baselineRequests = baseline.requests;

  // 2. batches
  const batches = makeBatches(pending, maxBlocksPerBatch, maxCharsPerBatch);
  progress.batchesTotal = batches.length;
  report(pending.length === 0 ? 'All blocks served from cache.' : `Prepared ${batches.length} batches.`);

  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const missingIds: string[] = [];

  const account = (
    payload: WorkerBlockInput[],
    translations: string[],
    usage: WorkerUsage | undefined,
    providerCalls: number,
    retry: boolean,
  ) => {
    stats.requests++;
    stats.providerCalls += providerCalls;
    const inTokens = payloadTokens(payload);
    let outTokens = 0;
    for (const t of translations) outTokens += PER_UNIT_OVERHEAD_TOKENS + estimateTokens(t);
    stats.estimatedInputTokens += inTokens;
    stats.estimatedOutputTokens += outTokens;
    for (const p of payload) {
      stats.inputChars += p.text.length;
      const ctx = (p.contextBefore?.length ?? 0) + (p.contextAfter?.length ?? 0);
      stats.contextChars += ctx;
      if (ctx > 0) stats.extraContextBlocks++;
    }
    if (usage) {
      const u = stats.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
      u.inputTokens += usage.inputTokens;
      u.outputTokens += usage.outputTokens;
      u.cachedInputTokens += usage.cachedInputTokens;
      u.reasoningTokens += usage.reasoningTokens;
      stats.usage = u;
    }
    if (retry) {
      stats.retryRequests++;
      stats.retryTokens += usage ? usage.inputTokens + usage.outputTokens : inTokens + outTokens;
    }
  };

  /** Glossary for one batch: the union of the entries relevant to its blocks. */
  const batchTerminology = (batch: TranslationBlock[]): Record<string, string> => {
    const seen = new Map<string, TermEntry>();
    for (const b of batch) for (const t of relevantById.get(b.id) ?? []) seen.set(t.source.toLowerCase(), t);
    return toWorkerTerminology([...seen.values()]);
  };

  const runBatch = async (batch: TranslationBlock[], label: string, retryPass: boolean): Promise<void> => {
    for (const b of batch) update(b.id, { status: 'translating' });
    const payload = buildPayload(batch, documentOrder, protectedTexts);
    const terminology = batchTerminology(batch);

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const response = await client.translate(payload, targetLanguage, terminology);
        stats.terminologyEntriesSent += Object.keys(terminology).length;
        const got = new Map(response.blocks.map((b) => [b.id, b.translation]));
        const translations: string[] = [];
        for (const b of batch) {
          const raw = got.get(b.id);
          if (raw !== undefined && raw.trim().length > 0) {
            const p = protectedById.get(b.id) ?? { text: b.text, placeholders: [] };
            const restored = restoreText(raw, p.placeholders);
            const clean = cleanTranslation(restored.text);
            const hash = hashById.get(b.id) ?? '';
            const quality = assessTranslation(b, clean, {
              terminologyHash: hash,
              protectedEntities: p.placeholders.length,
              placeholderMissing: [...restored.missing.map((m) => m.token), ...restored.leftover],
            });
            countWarnings(quality);
            translations.push(clean);
            cache.set(b.text, targetLanguage, clean, hash);
            update(b.id, { status: 'done', translation: clean, error: null, quality });
            stats.translatedBlocks++;
            progress.blocksDone++;
          } else {
            missingIds.push(b.id);
          }
        }
        account(payload, translations, response.usage, response.providerCalls ?? 1, retryPass || attempt > 1);
        return;
      } catch (err) {
        const clientErr = err instanceof TranslateClientError ? err : null;
        const retryable = clientErr?.retryable ?? false;
        if (retryable && attempt < maxAttempts) {
          const backoff = clientErr?.retryAfterMs ?? 1500 * 2 ** (attempt - 1);
          report(`${label} failed (${clientErr?.kind ?? 'error'}), retrying in ${Math.round(backoff / 1000)}s...`);
          await sleep(backoff);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        for (const b of batch) {
          update(b.id, { status: 'failed', translation: null, error: message });
          progress.blocksFailed++;
        }
        console.error(`[translate] ${label} failed permanently:`, err);
        return;
      }
    }
  };

  const runAll = async (list: TranslationBlock[][], labelPrefix: string, retryPass: boolean): Promise<void> => {
    let next = 0;
    const worker = async () => {
      while (next < list.length && !signal?.aborted) {
        const index = next++;
        const label = `${labelPrefix} ${index + 1} / ${list.length}`;
        progress.batchesStarted++;
        report(`Translating ${label.toLowerCase()}...`);
        await runBatch(list[index], label, retryPass);
        progress.batchesDone++;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };

  await runAll(batches, 'Batch', false);

  // 3. blocks the provider silently dropped: only those ids, in small batches
  if (signal?.aborted) return finish();
  if (missingIds.length > 0) {
    const retryBlocks = missingIds.map((id) => blockById.get(id)).filter((b): b is TranslationBlock => !!b);
    missingIds.length = 0;
    const retryBatches = makeBatches(retryBlocks, MISSING_RETRY_BATCH_SIZE, maxCharsPerBatch);
    progress.batchesTotal += retryBatches.length;
    report(`Re-sending ${retryBlocks.length} blocks missing from provider responses...`);
    await runAll(retryBatches, 'Retry batch', true);
  }

  for (const id of missingIds) {
    update(id, { status: 'failed', translation: null, error: 'Provider did not return a translation for this block.' });
    progress.blocksFailed++;
  }

  report(
    progress.blocksFailed > 0
      ? `Done with errors: ${progress.blocksDone} translated, ${progress.blocksFailed} failed.`
      : `Done: ${progress.blocksDone} blocks translated.`,
  );
  const s = finish();
  console.log(
    `[Translation Cost] requests=${s.requests} providerCalls=${s.providerCalls} retries=${s.retryRequests} ` +
      `translated=${s.translatedBlocks} cached=${s.cachedBlocks} skipped=${s.skippedBlocks} failed=${s.failedBlocks} ` +
      `inputChars=${s.inputChars} contextChars=${s.contextChars}/${s.contextCharsAssigned} ` +
      `estIn=${s.estimatedInputTokens} estOut=${s.estimatedOutputTokens} ` +
      (s.usage ? `usageIn=${s.usage.inputTokens} usageCached=${s.usage.cachedInputTokens} usageOut=${s.usage.outputTokens} ` : '') +
      `terms=${s.terminologyEntriesSent} protected=${s.protectedEntities} placeholderWarn=${s.placeholderWarnings} ` +
      `numericWarn=${s.numericWarnings} citationWarn=${s.citationWarnings} highRisk=${s.highRiskBlocks} ` +
      `baselineIn=${s.baselineEstimatedInputTokens} (${s.baselineRequests} req) ${(s.durationMs / 1000).toFixed(1)}s`,
  );
  return s;
}
