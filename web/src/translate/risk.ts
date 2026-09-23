/**
 * Risk assessment and QA candidate selection.
 *
 * Every translated block is scored after the deterministic checks (numbers,
 * citations, placeholders, symbols). The signals fall into two classes:
 *
 *   hard risk – at least one QA trigger fired; the block is a QA candidate
 *   soft risk – only weighting signals fired (merged, cross-page, cut-off
 *               source, length ratio, hedges, weak negation, number density,
 *               parentheses); reported in Developer Mode, never sent to QA
 *               on their own
 *
 * QA triggers, in priority order (selectQaCandidates):
 *   1. PLACEHOLDER_ERROR         a placeholder did not come back            (critical)
 *   2. NUMERIC_MISMATCH          numbers / statistics differ                (critical)
 *   3. CITATION_MISMATCH         citations differ                           (critical)
 *   4. SYMBOL_MISMATCH           ±, ≤, ≥, μ, Greek letters lost
 *   5. NEGATION_WITH_OUTCOME     a conclusion-changing negation next to a
 *                                number, statistic, comparison or outcome
 *   6. UNCERTAINTY_WITH_OUTCOME  a hedge next to numeric / statistical content
 *   7. CROSS_PAGE_INCOMPLETE     cross-page unit whose source is cut off
 *   8. MERGED_INCOMPLETE_SEMANTIC merged unit, cut off, with a negation or hedge
 *   9. HIGH_RISK_SCORE           weighted score ≥ HIGH_SCORE_THRESHOLD
 *
 * Critical triggers always go to QA; the others share the QA budget
 * (DEFAULT_MAX_QA_SHARE in pipeline.ts). A block whose deterministic checks
 * all pass and that only looks risky (merged, hedged, long) stays first-round.
 */

import { missingSymbols, numericDensity, type NumericDiff } from './entities';
import { protectText, type CitationDiff } from './protect';
import type { QaTrigger, RiskLevel, RiskReason } from '../pdf/types';

/** Weighted score at which a block goes to QA without any specific trigger. */
export const HIGH_SCORE_THRESHOLD = 8;
/** Length ratio (translation chars / source chars) outside this band is anomalous. */
export const LENGTH_RATIO_MIN = 0.25;
export const LENGTH_RATIO_MAX = 2.0;
/** Ratio checks need some text to be meaningful ("Introduction" → "緒論" is fine). */
const LENGTH_CHECK_MIN_SOURCE = 60;

/** Points per signal (weighting only; the triggers decide the QA candidacy). */
export const RISK_POINTS = {
  critical: HIGH_SCORE_THRESHOLD,
  symbol: 4,
  strongNegation: 3,
  weakNegation: 1,
  merged: 1,
  crossPage: 1,
  incompleteSource: 1,
  lengthAnomaly: 2,
  /** Extra for a length anomaly on a block that carries numbers, a negation or a hedge. */
  lengthAnomalyWithContent: 3,
} as const;

/** Triggers that bypass the QA budget. */
export const CRITICAL_TRIGGERS: ReadonlySet<QaTrigger> = new Set<QaTrigger>(['PLACEHOLDER_ERROR', 'NUMERIC_MISMATCH', 'CITATION_MISMATCH']);

/** QA priority: lower index first. Reading order breaks ties. */
export const QA_TRIGGER_PRIORITY: readonly QaTrigger[] = [
  'PLACEHOLDER_ERROR',
  'NUMERIC_MISMATCH',
  'CITATION_MISMATCH',
  'SYMBOL_MISMATCH',
  'NEGATION_WITH_OUTCOME',
  'UNCERTAINTY_WITH_OUTCOME',
  'CROSS_PAGE_INCOMPLETE',
  'MERGED_INCOMPLETE_SEMANTIC',
  'HIGH_RISK_SCORE',
];

export interface RiskInput {
  source: string;
  translation: string;
  wasMerged: boolean;
  crossPage: boolean;
  incompleteSource: boolean;
  numeric: NumericDiff;
  citation: CitationDiff;
  placeholderMissing: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** Hard risk: a QA candidate. */
  high: boolean;
  score: number;
  /** Every signal that fired, weighting signals included. */
  reasons: RiskReason[];
  /** QA triggers that fired, in priority order. */
  triggers: QaTrigger[];
}

/** Grammatical "not" that never changes a finding; removed before the negation checks. */
const GRAMMATICAL_NOT_RE = /\bnot\s+(?:only|necessarily|just|merely|least|to mention)\b/gi;
/**
 * Negations that can change a research conclusion: "no significant difference",
 * "no evidence of", "did not improve", "failed to show", "was not associated",
 * "not inferior", "neither … nor", "no longer", "cannot".
 */
const STRONG_NEGATION_RE =
  /\b(?:no|not)\s+(?:statistically\s+)?significant(?:ly)?\b|\bno\s+(?:evidence|effect|effects|difference|differences|association|associations|change|changes|improvement|benefit|relationship|relation|correlation|impact|longer)\b|\b(?:did|does|do|was|were|is|are|has|have|had|could|would|should|may|might|can)\s+not\b|\bcannot\b|\bfail(?:s|ed|ing)?\s+to\b|\bnot\s+(?:inferior|superior|associated|related|correlated|different|different\s+from)\b|\bnon-?inferior(?:ity)?\b|\bneither\b[^.;]{0,120}\bnor\b/i;
const WEAK_NEGATION_RE = /\b(?:not|no|without|none|never|nothing|nor)\b/i;
const HEDGE_RE = /\b(?:may|might|could|possibly|possible|suggests?|suggested|suggesting|indicates?|indicated|indicating|likely|unlikely|approximately|appears?|appeared|seems?|seemed|tend(?:s|ed)? to|potentially|potential|probably|presumably|plausible|plausibly|perhaps)\b/gi;
const APPROX_NUMBER_RE = /\b(?:approximately|about|around|roughly|nearly|almost|circa|up to|at least|at most|more than|less than|fewer than|over|under)\s+\$?\d/i;
/** Comparison / outcome vocabulary: a conclusion-changing negation next to it can flip a finding. */
const OUTCOME_RE =
  /\b(?:increas(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing|tion)|improv(?:e|es|ed|ing|ement)|higher|lower|greater|smaller|larger|better|worse|superior|inferior|significant(?:ly)?|difference|differences|effect|effects|association|associated|correlat(?:ed|ion|es)|predict(?:s|ed|ive|ion|ions)?|outcome|outcomes|efficacy|benefit|benefits|risk|risks|mortality|survival|accuracy|performance|compared|comparison|versus|vs\.?|relative to)\b/i;
const PLACEHOLDER_TOKEN_RE = /__[A-Z]+_\d+__/g;
/** Sentence boundary: terminal punctuation followed by a capital, quote or bracket ("et al. [2024]" and "Fig. 2" do not split). */
const SENTENCE_SPLIT_RE = /(?<=[.!?;])\s+(?=[A-Z“"(])/;
const HEDGE_TEST_RE = new RegExp(HEDGE_RE.source, 'i');

/** The source without citations, figure/table references, DOIs, URLs and e-mails: years in citations are not statistics. */
function contentText(source: string): string {
  return protectText(source).text.replace(PLACEHOLDER_TOKEN_RE, ' ');
}

/** Numbers, statistics or an approximate quantity in a piece of (citation-free) text. */
function hasNumericContent(text: string): boolean {
  const density = numericDensity(text);
  return density.numbers > 0 || density.stats > 0 || APPROX_NUMBER_RE.test(text);
}

/**
 * Sentence-level co-occurrence: a conclusion-changing negation in the same
 * sentence as a number, statistic, comparison or outcome, and a hedge in the
 * same sentence as numeric content. "may reduce mortality by 15%" counts,
 * "this may reflect…" does not.
 */
function semanticTriggers(content: string): { negationWithOutcome: boolean; uncertaintyWithNumbers: boolean } {
  let negationWithOutcome = false;
  let uncertaintyWithNumbers = false;
  for (const sentence of content.split(SENTENCE_SPLIT_RE)) {
    const numeric = hasNumericContent(sentence);
    if (!negationWithOutcome && STRONG_NEGATION_RE.test(sentence) && (numeric || OUTCOME_RE.test(sentence))) negationWithOutcome = true;
    if (!uncertaintyWithNumbers && numeric && HEDGE_TEST_RE.test(sentence)) uncertaintyWithNumbers = true;
    if (negationWithOutcome && uncertaintyWithNumbers) break;
  }
  return { negationWithOutcome, uncertaintyWithNumbers };
}

/** Score one translated block; `reasons` lists every signal that fired, `triggers` the QA triggers. */
export function assessRisk(input: RiskInput): RiskAssessment {
  const reasons = new Set<RiskReason>();
  const triggers = new Set<QaTrigger>();
  let score = 0;
  const signal = (reason: RiskReason, points: number) => {
    reasons.add(reason);
    score += points;
  };

  // deterministic checks
  if (input.placeholderMissing > 0) {
    signal('PLACEHOLDER_ERROR', RISK_POINTS.critical);
    triggers.add('PLACEHOLDER_ERROR');
  }
  if (!input.numeric.ok) {
    signal('NUMERIC_MISMATCH', RISK_POINTS.critical);
    triggers.add('NUMERIC_MISMATCH');
  }
  if (!input.citation.ok) {
    signal('CITATION_MISMATCH', RISK_POINTS.critical);
    triggers.add('CITATION_MISMATCH');
  }
  if (missingSymbols(input.source, input.translation).length > 0) {
    signal('SYMBOL_MISSING', RISK_POINTS.symbol);
    triggers.add('SYMBOL_MISMATCH');
  }

  // semantic signals of the source
  const text = input.source.replace(GRAMMATICAL_NOT_RE, ' ');
  const content = contentText(text);
  const density = numericDensity(content);
  const hasNumeric = hasNumericContent(content);
  const strongNegation = STRONG_NEGATION_RE.test(text);
  const weakNegation = !strongNegation && WEAK_NEGATION_RE.test(text);
  const hedges = (text.match(HEDGE_RE) ?? []).length;
  const semantic = semanticTriggers(content);

  if (strongNegation) {
    signal('NEGATION', RISK_POINTS.strongNegation);
    if (semantic.negationWithOutcome) triggers.add('NEGATION_WITH_OUTCOME');
  } else if (weakNegation) {
    signal('NEGATION', RISK_POINTS.weakNegation);
  }

  if (hedges > 0) {
    signal('UNCERTAINTY', hedges >= 4 ? 3 : hedges >= 2 ? 2 : 1);
    if (APPROX_NUMBER_RE.test(content)) signal('UNCERTAINTY', 1);
    if (semantic.uncertaintyWithNumbers) triggers.add('UNCERTAINTY_WITH_OUTCOME');
  }

  if (density.numbers >= 8 || density.stats >= 3) signal('DENSE_NOTATION', 3);
  else if (density.numbers >= 4 || density.stats >= 1) signal('DENSE_NOTATION', 2);
  else if (density.parentheses >= 3) signal('DENSE_NOTATION', 1);

  // structural signals: weighting only, QA in combination
  if (input.wasMerged) signal('MERGED_BLOCK', RISK_POINTS.merged);
  if (input.crossPage) signal('CROSS_PAGE_BLOCK', RISK_POINTS.crossPage);
  if (input.incompleteSource) signal('INCOMPLETE_SOURCE', RISK_POINTS.incompleteSource);
  if (input.crossPage && input.incompleteSource) triggers.add('CROSS_PAGE_INCOMPLETE');
  if (input.wasMerged && input.incompleteSource && (strongNegation || weakNegation || hedges > 0)) triggers.add('MERGED_INCOMPLETE_SEMANTIC');

  const srcLen = input.source.trim().length;
  const dstLen = input.translation.trim().length;
  if (srcLen >= LENGTH_CHECK_MIN_SOURCE) {
    const ratio = dstLen / srcLen;
    if (ratio < LENGTH_RATIO_MIN || ratio > LENGTH_RATIO_MAX) {
      signal('LENGTH_ANOMALY', RISK_POINTS.lengthAnomaly);
      if (strongNegation || hasNumeric || hedges > 0) signal('LENGTH_ANOMALY', RISK_POINTS.lengthAnomalyWithContent);
    }
  }

  if (triggers.size === 0 && score >= HIGH_SCORE_THRESHOLD) triggers.add('HIGH_RISK_SCORE');

  const ordered = QA_TRIGGER_PRIORITY.filter((t) => triggers.has(t));
  const level: RiskLevel = ordered.length > 0 ? 'hard' : reasons.size > 0 ? 'soft' : 'none';
  return { level, high: level === 'hard', score, reasons: [...reasons], triggers: ordered };
}

/** A hard-risk block with its triggers and score, for the QA candidate selection. */
export interface RankedBlock {
  id: string;
  score: number;
  /** Position in reading order; the last tie-breaker. */
  order: number;
  triggers: readonly QaTrigger[];
}

export interface QaSelection {
  selected: Set<string>;
  /** Blocks with a critical trigger: always selected, even beyond the budget. */
  critical: number;
  /** Hard-risk blocks left unreviewed by the budget. */
  budgetSkipped: number;
  /** Blocks the share allows. */
  budget: number;
}

export function isCritical(triggers: readonly QaTrigger[]): boolean {
  return triggers.some((t) => CRITICAL_TRIGGERS.has(t));
}

/** Rank of the block's most urgent trigger (index in QA_TRIGGER_PRIORITY). */
export function triggerRank(triggers: readonly QaTrigger[]): number {
  let best = QA_TRIGGER_PRIORITY.length;
  for (const t of triggers) best = Math.min(best, QA_TRIGGER_PRIORITY.indexOf(t));
  return best;
}

/** Priority order: most urgent trigger, then score, then reading order. */
export function compareRanked(a: RankedBlock, b: RankedBlock): number {
  return triggerRank(a.triggers) - triggerRank(b.triggers) || b.score - a.score || a.order - b.order;
}

/**
 * Which hard-risk blocks go to QA. Critical mismatches (placeholder, numeric,
 * citation) are always selected; the remaining budget (`maxShare` of the
 * translated blocks, at least one block) is filled in priority order.
 */
export function selectQaCandidates(ranked: readonly RankedBlock[], translatedBlocks: number, maxShare: number): QaSelection {
  const budget = Math.max(1, Math.ceil(translatedBlocks * maxShare));
  const sorted = [...ranked].sort(compareRanked);
  const selected = new Set<string>();
  let critical = 0;
  for (const r of sorted) {
    if (!isCritical(r.triggers)) continue;
    selected.add(r.id);
    critical++;
  }
  for (const r of sorted) {
    if (selected.size >= budget) break;
    selected.add(r.id);
  }
  return { selected, critical, budgetSkipped: ranked.length - selected.size, budget };
}
