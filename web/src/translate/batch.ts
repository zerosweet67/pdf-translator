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
 *  - the cache is consulted per block with a whitespace-normalized key;
 *  - previous/next context is dropped whenever the neighbouring unit is in
 *    the same request: the model already sees it there in reading order, so
 *    the text would only be sent twice. Context survives only across batch
 *    boundaries and next to cached / skipped neighbours;
 *  - the payload carries id, text and (rarely) contextBefore / contextAfter /
 *    incompleteSource. Layout, fonts, pages and debug data stay in the browser.
 *
 * `TranslationStats` records requests, chars and tokens (estimated, plus the
 * provider's real usage when the Worker reports it) for Developer Mode.
 */

import { isUntranslatableText } from '../pdf/classify';
import { isCjkChar } from '../pdf/fit';
import type { TranslationBlock, TranslationEntry } from '../pdf/types';
import type { TranslationCache } from './cache';
import { TranslateClient, TranslateClientError, type WorkerBlockInput, type WorkerUsage } from './client';

export const DEFAULT_MAX_BLOCKS = 25;
/** Text + context characters per request; the Worker accepts up to 40 000. */
export const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const MISSING_RETRY_BATCH_SIZE = 5;

/** Rough size of the Worker's system prompt after compression + a few matched glossary terms. */
const PROMPT_TOKENS_ESTIMATE = 500;
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
}

export interface TranslateBlocksOptions {
  client: TranslateClient;
  cache: TranslationCache;
  targetLanguage: string;
  /** Optional extra terminology sent with every batch, merged over the Worker defaults. */
  terminology?: Record<string, string>;
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
 */
export function buildPayload(batch: TranslationBlock[], documentOrder?: readonly TranslationBlock[]): WorkerBlockInput[] {
  const inBatch = new Set(batch.map((b) => b.id));
  const index = documentOrder ? new Map(documentOrder.map((u, i) => [u.id, i])) : null;
  const order = documentOrder ?? [];
  return batch.map((b) => {
    const input: WorkerBlockInput = { id: b.id, text: b.text };
    const i = index?.get(b.id);
    const prevInBatch = i !== undefined && i > 0 && inBatch.has(order[i - 1].id);
    const nextInBatch = i !== undefined && i < order.length - 1 && inBatch.has(order[i + 1].id);
    if (b.previousContext && !prevInBatch) input.contextBefore = b.previousContext;
    if (b.nextContext && !nextInBatch) input.contextAfter = b.nextContext;
    if (b.incompleteSource) input.incompleteSource = true;
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
    terminology = {},
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

  report();

  // 1. skip what needs no API call, then cache lookup
  const pending: TranslationBlock[] = [];
  for (const block of blocks) {
    if (isUntranslatableText(block.text)) {
      update(block.id, { status: 'skipped', translation: null, error: null });
      stats.skippedBlocks++;
      progress.blocksDone++;
      continue;
    }
    const cached = cache.get(block.text, targetLanguage);
    if (cached !== undefined) {
      update(block.id, { status: 'cached', translation: cached, error: null });
      stats.cachedBlocks++;
      progress.blocksDone++;
    } else {
      update(block.id, { status: 'pending', translation: null, error: null });
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
      const u = stats.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      u.inputTokens += usage.inputTokens;
      u.outputTokens += usage.outputTokens;
      u.cachedInputTokens += usage.cachedInputTokens;
      stats.usage = u;
    }
    if (retry) {
      stats.retryRequests++;
      stats.retryTokens += usage ? usage.inputTokens + usage.outputTokens : inTokens + outTokens;
    }
  };

  const runBatch = async (batch: TranslationBlock[], label: string, retryPass: boolean): Promise<void> => {
    for (const b of batch) update(b.id, { status: 'translating' });
    const payload = buildPayload(batch, documentOrder);

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const response = await client.translate(payload, targetLanguage, terminology);
        const got = new Map(response.blocks.map((b) => [b.id, b.translation]));
        const translations: string[] = [];
        for (const b of batch) {
          const translation = got.get(b.id);
          if (translation !== undefined && translation.trim().length > 0) {
            const clean = cleanTranslation(translation);
            translations.push(clean);
            cache.set(b.text, targetLanguage, clean);
            update(b.id, { status: 'done', translation: clean, error: null });
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
      `baselineIn=${s.baselineEstimatedInputTokens} (${s.baselineRequests} req) ${(s.durationMs / 1000).toFixed(1)}s`,
  );
  return s;
}
