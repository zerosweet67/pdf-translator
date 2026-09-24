/**
 * Document translation pipeline (User Mode and Developer Mode share it):
 *
 *   1. terminology  – one /terminology call on selected excerpts (cached per
 *                     document for the session); failure → no auto glossary
 *   2. translate    – translateBlocks(): protection, batches, cache, post-checks
 *   3. QA           – hard-risk blocks only (risk.ts triggers), critical
 *                     mismatches always, the rest within the QA budget;
 *                     failure → first-round kept
 *
 * User terminology always wins over the automatic glossary (terminology.ts).
 */

import type { TranslationBlock, TranslationEntry } from '../pdf/types';
import { translateBlocks, type TranslateBlocksOptions, type TranslationStats } from './batch';
import type { WorkerUsage } from './client';
import { runQualityAssurance, type QaCandidate, type QaStats } from './qa';
import { selectQaCandidates, type RankedBlock } from './risk';
import {
  documentFingerprint,
  mergeTerminology,
  parseTerminologyResponse,
  relevantTerms,
  selectTerminologySamples,
  terminologyHash,
  userTermsFromMap,
  type TermEntry,
} from './terminology';

/**
 * QA budget: at most this share of the translated blocks goes to QA, after the
 * hard-risk triggers have selected the candidates (risk.ts). Critical
 * mismatches (placeholder / numeric / citation) are always reviewed, even
 * beyond the budget. Benchmark on the 50-page accounting paper: a plain 10 %
 * share cost +45 % tokens over the pre-quality baseline; triggers + 5 % keep
 * the whole pipeline (terminology + placeholders + QA) inside +30 %.
 */
export const DEFAULT_MAX_QA_SHARE = 0.05;

export type PipelineStage = 'terminology' | 'translate' | 'qa';

export interface TerminologyStats {
  requests: number;
  /** Excerpts and characters sent for extraction. */
  samples: number;
  sampleChars: number;
  autoTerms: number;
  userTerms: number;
  /** Served from the per-session cache (no request). */
  cached: boolean;
  usage: WorkerUsage | null;
  durationMs: number;
  warnings: string[];
}

/** How the QA policy treated the risk-flagged blocks (Developer Mode "QA avoided"). */
export interface QaPolicyStats {
  /** Blocks with soft signals only: never sent, by policy. */
  softRiskSkipped: number;
  /** Hard-risk blocks sent to QA. */
  hardRiskChecked: number;
  /** Blocks with a critical mismatch, reviewed regardless of the budget. */
  criticalForced: number;
  /** Hard-risk blocks left unreviewed by the budget. */
  budgetSkippedHardRisk: number;
  /** Blocks the share allowed. */
  budget: number;
}

export interface DocumentTranslationOptions extends Omit<TranslateBlocksOptions, 'terms'> {
  /** Developer Mode terminology map ("english term = 中文"); overrides automatic entries. */
  userTerminology?: Record<string, string> | null;
  /** Units to sample terminology from (the selected scope plus title / abstract); defaults to `blocks`. */
  documentBlocks?: readonly TranslationBlock[];
  /**
   * Key of the per-session terminology cache: document fingerprint + scope
   * fingerprint (main.ts). The same scope of the same document reuses its
   * extraction. Defaults to the fingerprint of `documentBlocks`.
   */
  terminologyCacheKey?: string;
  /**
   * Key of the document the scope belongs to. Auto terms extracted for other
   * scopes of the same document are kept and merged in, so a chapter translated
   * later uses the same renderings as the chapters before it. Defaults to
   * `terminologyCacheKey`.
   */
  terminologyDocumentKey?: string;
  /** Automatic glossary extraction (default true). */
  terminologyExtraction?: boolean;
  /** Second-pass QA of hard-risk blocks (default true). */
  qa?: boolean;
  maxQaShare?: number;
  onStage?: (stage: PipelineStage) => void;
  onQaProgress?: (done: number, total: number) => void;
}

export interface DocumentTranslationResult {
  translation: TranslationStats;
  terminology: TerminologyStats;
  qa: QaStats;
  qaPolicy: QaPolicyStats;
  /** The merged glossary used for this run (user first, then auto). */
  terms: TermEntry[];
  /** Hard-risk blocks (QA candidates) found by the post-checks, before the budget. */
  highRiskBlocks: number;
  /** Blocks with soft signals only (reported, never sent). */
  softRiskBlocks: number;
  /** Hard-risk blocks left unreviewed because of the QA budget. */
  qaSkippedBlocks: number;
  warnings: string[];
}

/** Auto terminology per (document, scope) fingerprint, for this page session only (spec §8). */
const terminologyCache = new Map<string, TermEntry[]>();
/** Union of the auto terms extracted so far per document (all scopes), for consistent renderings. */
const documentTerms = new Map<string, TermEntry[]>();

export function clearTerminologyCache(): void {
  terminologyCache.clear();
  documentTerms.clear();
}

/** `base` first, then the entries of `extra` whose term / abbreviation is not taken yet (all auto). */
function unionAutoTerms(base: readonly TermEntry[], extra: readonly TermEntry[]): TermEntry[] {
  const taken = new Set<string>();
  const out: TermEntry[] = [];
  for (const t of [...base, ...extra]) {
    const key = t.source.toLowerCase();
    if (taken.has(key) || (t.abbreviation && taken.has(t.abbreviation.toLowerCase()))) continue;
    taken.add(key);
    if (t.abbreviation) taken.add(t.abbreviation.toLowerCase());
    out.push(t);
  }
  return out;
}

async function extractDocumentTerminology(
  documentBlocks: readonly TranslationBlock[],
  options: DocumentTranslationOptions,
  stats: TerminologyStats,
): Promise<TermEntry[]> {
  const fingerprint = options.terminologyCacheKey ?? documentFingerprint(documentBlocks);
  const documentKey = options.terminologyDocumentKey ?? fingerprint;
  const known = documentTerms.get(documentKey) ?? [];
  const cached = terminologyCache.get(fingerprint);
  if (cached) {
    stats.cached = true;
    const merged = unionAutoTerms(known, cached);
    documentTerms.set(documentKey, merged);
    stats.autoTerms = merged.length;
    return merged;
  }
  const samples = selectTerminologySamples(documentBlocks);
  stats.samples = samples.length;
  stats.sampleChars = samples.reduce((n, s) => n + s.length, 0);
  if (samples.length === 0) return known;
  const started = performance.now();
  try {
    const response = await options.client.extractTerminology(samples);
    stats.requests++;
    stats.usage = response.usage ?? null;
    const terms = parseTerminologyResponse({ terms: response.terms });
    terminologyCache.set(fingerprint, terms);
    const merged = unionAutoTerms(known, terms);
    documentTerms.set(documentKey, merged);
    stats.autoTerms = merged.length;
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.warnings.push(`Terminology extraction failed; translating without an automatic glossary. (${message})`);
    console.warn('[Terminology] extraction failed, continuing without auto terminology', err);
    return known;
  } finally {
    stats.durationMs = Math.round(performance.now() - started);
  }
}

/** Full pipeline for `blocks`; results go into `entries`. Never throws for terminology / QA problems. */
export async function translateDocument(
  blocks: TranslationBlock[],
  entries: Map<string, TranslationEntry>,
  options: DocumentTranslationOptions,
): Promise<DocumentTranslationResult> {
  const {
    userTerminology,
    documentBlocks = blocks,
    terminologyExtraction = true,
    qa = true,
    maxQaShare = DEFAULT_MAX_QA_SHARE,
    onStage,
    onQaProgress,
    ...translateOptions
  } = options;
  const warnings: string[] = [];
  const terminologyStats: TerminologyStats = {
    requests: 0,
    samples: 0,
    sampleChars: 0,
    autoTerms: 0,
    userTerms: 0,
    cached: false,
    usage: null,
    durationMs: 0,
    warnings: [],
  };

  // 1. terminology
  const userTerms = userTermsFromMap(userTerminology);
  terminologyStats.userTerms = userTerms.length;
  let autoTerms: TermEntry[] = [];
  if (terminologyExtraction && !options.signal?.aborted) {
    onStage?.('terminology');
    autoTerms = await extractDocumentTerminology(documentBlocks, options, terminologyStats);
  }
  const terms = mergeTerminology(userTerms, autoTerms);
  warnings.push(...terminologyStats.warnings);

  // 2. translation with protection and post-checks
  onStage?.('translate');
  const translation = await translateBlocks(blocks, entries, { ...translateOptions, terms });

  // 3. QA: hard-risk blocks only, critical mismatches first and always, the rest within the budget
  const ranked: RankedBlock[] = [];
  const candidatesById = new Map<string, QaCandidate>();
  let softRiskBlocks = 0;
  blocks.forEach((block, order) => {
    const entry = entries.get(block.id);
    const quality = entry?.quality;
    // Cache hits are not re-reviewed: a corrected translation replaced its cache entry in the run that reviewed it.
    if (!entry || !quality || !entry.translation || entry.status !== 'done') return;
    if (quality.riskLevel === 'soft') softRiskBlocks++;
    if (quality.riskLevel !== 'hard') return;
    ranked.push({ id: block.id, score: quality.riskScore, order, triggers: quality.qaTriggers });
    candidatesById.set(block.id, { block, entry });
  });
  const selection =
    qa && !options.signal?.aborted
      ? selectQaCandidates(ranked, translation.translatedBlocks, maxQaShare)
      : { selected: new Set<string>(), critical: 0, budgetSkipped: ranked.length, budget: 0 };
  const candidates: QaCandidate[] = [];
  for (const block of blocks) {
    const c = candidatesById.get(block.id);
    if (!c) continue;
    if (selection.selected.has(block.id)) candidates.push(c);
    else if (c.entry.quality) {
      c.entry.quality = { ...c.entry.quality, qa: 'skipped' };
      translateOptions.onEntry?.(c.entry);
    }
  }
  const qaPolicy: QaPolicyStats = {
    softRiskSkipped: softRiskBlocks,
    hardRiskChecked: candidates.length,
    criticalForced: selection.critical,
    budgetSkippedHardRisk: ranked.length - candidates.length,
    budget: selection.budget,
  };

  let qaStats: QaStats = {
    requests: 0,
    providerCalls: 0,
    retryRequests: 0,
    blocksSent: 0,
    blocksChecked: 0,
    correctedBlocks: 0,
    failedBlocks: 0,
    usage: null,
    rejectedCorrections: 0,
    durationMs: 0,
    warnings: [],
  };
  if (candidates.length > 0) {
    onStage?.('qa');
    qaStats = await runQualityAssurance(candidates, {
      client: options.client,
      targetLanguage: options.targetLanguage,
      terms,
      concurrency: options.concurrency,
      signal: options.signal,
      onProgress: onQaProgress,
      onEntry: translateOptions.onEntry,
      onCorrected: (block, corrected) => {
        const hash = terminologyHash(relevantTerms(terms, block.text));
        options.cache.set(block.text, options.targetLanguage, corrected, hash);
      },
    });
    warnings.push(...qaStats.warnings);
  }

  const result: DocumentTranslationResult = {
    translation,
    terminology: terminologyStats,
    qa: qaStats,
    qaPolicy,
    terms,
    highRiskBlocks: ranked.length,
    softRiskBlocks,
    qaSkippedBlocks: qaPolicy.budgetSkippedHardRisk,
    warnings,
  };
  console.log(
    `[Quality] terms=${terms.length} (auto ${terminologyStats.autoTerms}, user ${terminologyStats.userTerms}, ` +
      `${terminologyStats.cached ? 'cached' : `${terminologyStats.requests} request`}) ` +
      `hardRisk=${ranked.length}/${translation.translatedBlocks} softRisk=${softRiskBlocks} critical=${selection.critical} budget=${selection.budget} ` +
      `qaSent=${qaStats.blocksSent} qaChecked=${qaStats.blocksChecked} corrected=${qaStats.correctedBlocks} ` +
      `qaRequests=${qaStats.requests} qaFailed=${qaStats.failedBlocks} budgetSkipped=${qaPolicy.budgetSkippedHardRisk} ` +
      (qaStats.usage ? `qaIn=${qaStats.usage.inputTokens} qaOut=${qaStats.usage.outputTokens} ` : '') +
      (terminologyStats.usage ? `termIn=${terminologyStats.usage.inputTokens} termOut=${terminologyStats.usage.outputTokens} ` : '') +
      `${(qaStats.durationMs / 1000).toFixed(1)}s qa, ${(terminologyStats.durationMs / 1000).toFixed(1)}s terminology`,
  );
  return result;
}
