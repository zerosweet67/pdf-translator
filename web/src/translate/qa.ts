/**
 * Second-pass QA for high-risk blocks only.
 *
 *  - candidates come from the risk assessment (batch.ts / pipeline.ts); a
 *    normal block is never sent here
 *  - batches of at most QA_MAX_BLOCKS blocks / QA_MAX_CHARS characters
 *    (source + translation), the same concurrency as translation
 *  - ids missing from a reply are re-sent once on their own; a block whose
 *    review never arrives keeps its first translation (`qa: 'failed'`)
 *  - a translation is replaced only when the reviewer answers ok:false with a
 *    non-empty correction; each block is corrected at most once and never
 *    reviewed again (no translate → QA → translate loops)
 *  - nothing here throws: a QA outage leaves every first-round translation as it is
 */

import type { TranslationBlock, TranslationEntry } from '../pdf/types';
import { TranslateClient, TranslateClientError, type WorkerQaItem, type WorkerUsage } from './client';
import { compareNumeric } from './entities';
import { relevantTerms, toWorkerTerminology, type TermEntry } from './terminology';

export const QA_MAX_BLOCKS = 20;
/** Source + translation characters per QA request. */
export const QA_MAX_CHARS = 16_000;
const QA_CONCURRENCY = 3;
const QA_MAX_ATTEMPTS = 2;
const QA_MISSING_RETRY_BATCH = 5;
const CJK_RE = /[㐀-鿿]/;

export interface QaCandidate {
  block: TranslationBlock;
  entry: TranslationEntry;
}

export interface QaStats {
  requests: number;
  providerCalls: number;
  retryRequests: number;
  /** Blocks selected for review. */
  blocksSent: number;
  /** Blocks for which a verdict arrived. */
  blocksChecked: number;
  correctedBlocks: number;
  /** Blocks whose review never arrived (first translation kept). */
  failedBlocks: number;
  usage: WorkerUsage | null;
  /** Corrections rejected by the sanity check (empty, not Chinese, numbers broken). */
  rejectedCorrections: number;
  durationMs: number;
  warnings: string[];
}

export interface QaOptions {
  client: TranslateClient;
  targetLanguage: string;
  terms?: readonly TermEntry[];
  maxBlocksPerBatch?: number;
  maxCharsPerBatch?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Called with the final entry of every reviewed block (ok, corrected or failed). */
  onEntry?: (entry: TranslationEntry) => void;
  /** Called when a translation was replaced, so the caller can update its cache. */
  onCorrected?: (block: TranslationBlock, corrected: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTranslation(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Consecutive slices by block count and characters (source + translation). */
export function makeQaBatches(candidates: QaCandidate[], maxBlocks: number, maxChars: number): QaCandidate[][] {
  const batches: QaCandidate[][] = [];
  let current: QaCandidate[] = [];
  let chars = 0;
  for (const c of candidates) {
    const len = c.block.text.length + (c.entry.translation?.length ?? 0);
    if (current.length > 0 && (current.length >= maxBlocks || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(c);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Request payload per block: id, source, current translation, block type
 * (when not body text) and the QA triggers that fired. Soft signals, entity
 * details that passed the deterministic checks, section context and layout
 * data are not sent.
 */
export function buildQaPayload(batch: QaCandidate[]): WorkerQaItem[] {
  return batch.map(({ block, entry }) => {
    const item: WorkerQaItem = { id: block.id, source: block.text, translation: entry.translation ?? '' };
    if (block.type !== 'BODY') item.type = block.type;
    const issues = entry.quality?.qaTriggers ?? [];
    if (issues.length) item.issues = [...issues];
    return item;
  });
}

/**
 * A correction is accepted only when it is non-empty, still Chinese (when the
 * first translation was) and does not introduce a numeric error that the first
 * translation did not have.
 */
export function acceptableCorrection(block: TranslationBlock, current: string, corrected: string): boolean {
  const c = cleanTranslation(corrected);
  if (!c) return false;
  if (CJK_RE.test(current) && !CJK_RE.test(c)) return false;
  const before = compareNumeric(block.text, current);
  const after = compareNumeric(block.text, c);
  if (before.ok && !after.ok) return false;
  return true;
}

/** Review `candidates`, patching their entries in place. Never throws. */
export async function runQualityAssurance(candidates: QaCandidate[], options: QaOptions): Promise<QaStats> {
  const {
    client,
    targetLanguage,
    terms = [],
    maxBlocksPerBatch = QA_MAX_BLOCKS,
    maxCharsPerBatch = QA_MAX_CHARS,
    concurrency = QA_CONCURRENCY,
    signal,
    onProgress,
    onEntry,
    onCorrected,
  } = options;
  const started = performance.now();
  const stats: QaStats = {
    requests: 0,
    providerCalls: 0,
    retryRequests: 0,
    blocksSent: candidates.length,
    blocksChecked: 0,
    correctedBlocks: 0,
    failedBlocks: 0,
    usage: null,
    rejectedCorrections: 0,
    durationMs: 0,
    warnings: [],
  };
  const finish = () => {
    stats.durationMs = Math.round(performance.now() - started);
    return stats;
  };
  if (candidates.length === 0) return finish();

  const byId = new Map(candidates.map((c) => [c.block.id, c]));
  const reviewed = new Set<string>();
  let done = 0;

  const setQuality = (c: QaCandidate, patch: Partial<NonNullable<TranslationEntry['quality']>>, translation?: string) => {
    if (!c.entry.quality) return;
    c.entry.quality = { ...c.entry.quality, ...patch };
    if (translation !== undefined) c.entry.translation = translation;
    onEntry?.(c.entry);
  };

  const account = (usage: WorkerUsage | undefined, providerCalls: number, retry: boolean) => {
    stats.requests++;
    stats.providerCalls += providerCalls;
    if (retry) stats.retryRequests++;
    if (usage) {
      const u = stats.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
      u.inputTokens += usage.inputTokens;
      u.outputTokens += usage.outputTokens;
      u.cachedInputTokens += usage.cachedInputTokens;
      u.reasoningTokens += usage.reasoningTokens;
      stats.usage = u;
    }
  };

  const runBatch = async (batch: QaCandidate[], retryPass: boolean): Promise<void> => {
    const payload = buildQaPayload(batch);
    const batchText = batch.map((c) => c.block.text).join('\n');
    const terminology = toWorkerTerminology(relevantTerms(terms, batchText));
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const response = await client.reviewTranslations(payload, targetLanguage, terminology);
        account(response.usage, response.providerCalls ?? 1, retryPass || attempt > 1);
        for (const verdict of response.blocks) {
          const c = byId.get(verdict.id);
          if (!c || reviewed.has(verdict.id)) continue; // unknown or duplicate id
          reviewed.add(verdict.id);
          stats.blocksChecked++;
          done++;
          const current = c.entry.translation ?? '';
          if (!verdict.ok && verdict.translation && acceptableCorrection(c.block, current, verdict.translation)) {
            const corrected = cleanTranslation(verdict.translation);
            stats.correctedBlocks++;
            setQuality(c, { qa: 'corrected', qaIssues: verdict.issues, originalTranslation: current }, corrected);
            onCorrected?.(c.block, corrected);
          } else {
            if (!verdict.ok && verdict.translation) stats.rejectedCorrections++;
            setQuality(c, { qa: 'ok', qaIssues: verdict.issues });
          }
        }
        onProgress?.(done, candidates.length);
        return;
      } catch (err) {
        const clientErr = err instanceof TranslateClientError ? err : null;
        if (clientErr?.retryable && attempt < QA_MAX_ATTEMPTS && !signal?.aborted) {
          await sleep(clientErr.retryAfterMs ?? 1500 * attempt);
          continue;
        }
        stats.warnings.push(`QA request failed (${clientErr?.kind ?? 'error'}${clientErr?.code ? ` ${clientErr.code}` : ''}); first-round translations kept.`);
        console.warn('[QA] request failed, keeping first-round translations', err);
        return;
      }
    }
  };

  const runAll = async (list: QaCandidate[][], retryPass: boolean) => {
    let next = 0;
    const worker = async () => {
      while (next < list.length && !signal?.aborted) {
        const index = next++;
        await runBatch(list[index], retryPass);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };

  for (const c of candidates) setQuality(c, { qa: 'pending' });
  await runAll(makeQaBatches(candidates, maxBlocksPerBatch, maxCharsPerBatch), false);

  // Ids the reviewer skipped: one more pass, only those ids, small batches.
  const missing = candidates.filter((c) => !reviewed.has(c.block.id));
  if (missing.length > 0 && !signal?.aborted) {
    await runAll(makeQaBatches(missing, QA_MISSING_RETRY_BATCH, maxCharsPerBatch), true);
  }

  for (const c of candidates) {
    if (reviewed.has(c.block.id)) continue;
    stats.failedBlocks++;
    setQuality(c, { qa: 'failed' });
  }
  if (stats.failedBlocks > 0) stats.warnings.push(`${stats.failedBlocks} high-risk block(s) were not reviewed; first-round translations kept.`);
  return finish();
}
