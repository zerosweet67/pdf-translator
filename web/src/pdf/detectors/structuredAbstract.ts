/**
 * Structured abstract detector.
 *
 * A structured abstract is a run of short labels, each followed by a body
 * paragraph, all set in one label style and aligned on one left edge:
 *
 *   IMPORTANCE  As older adults live longer ...
 *   OBJECTIVE   To estimate the prevalence ...
 *   ...
 *
 * or, with other words entirely,
 *
 *   Overview     ...
 *   Purpose      ...
 *   Findings     ...
 *   Interpretation ...
 *
 * The words are never a condition. A candidate label is scored from its
 * typography and geometry (pdf/detectors/labels.ts); consecutive candidates
 * of one style form a region; a region needs at least two sections and a
 * confidence above STRUCTURED_MIN_REGION_CONFIDENCE. Anything weaker stays
 * ordinary BODY text.
 */

import type { TextBlock } from '../types';
import { labelCandidateOf, scoreLabel, type LabelCandidate, type LabelScore } from './labels';
import { emptyResult, type DetectorContext, type DetectorResult, type LayoutDetector, type StructuredRegionDraft, type StructuredSectionDraft } from './types';

/** A label needs at least this confidence to be considered at all... */
export const STRUCTURED_MIN_LABEL_CONFIDENCE = 0.5;
/** ...and a region (two or more labels of one style) at least this much to be kept. */
export const STRUCTURED_MIN_REGION_CONFIDENCE = 0.6;
/** Labels of one region share a font size within this tolerance. */
const STYLE_SIZE_TOLERANCE = 0.1;
/** ...and a left edge within this many points. */
const ALIGN_TOLERANCE = 3;
/** A section whose body is longer than this is not abstract-like (penalty). */
const SECTION_MAX_LINES = 16;
const SECTION_MAX_BODY_BLOCKS = 3;
/** A heading this close above the first section (× its font size) is a hint. */
const HEADING_ABOVE_MAX_PITCH = 3.5;
/** Words a heading above the region may use; a hint only (+0.15), never a condition. */
const ABSTRACT_HEADING_HINT_RE = /^(structured\s+)?(abstract|summary|synopsis|précis|highlights?)\b/i;
/** Block types a section body may consist of. */
const BODY_TYPES = new Set(['BODY', 'OTHER']);

interface ScoredCandidate {
  candidate: LabelCandidate;
  score: LabelScore;
  block: TextBlock;
  index: number;
}

function sameStyle(a: LabelCandidate, b: LabelCandidate): boolean {
  if (a.fontName !== b.fontName) return false;
  return Math.abs(a.fontSize - b.fontSize) <= STYLE_SIZE_TOLERANCE * Math.max(a.fontSize, b.fontSize);
}

function sameColumn(a: TextBlock, b: TextBlock): boolean {
  return a.page === b.page && a.column === b.column;
}

/** Body blocks between two labels: BODY / fragment blocks of the same column that are not owned. */
function bodyBetween(blocks: readonly TextBlock[], from: number, to: number, owned: ReadonlyMap<string, string>): TextBlock[] | null {
  const out: TextBlock[] = [];
  const first = blocks[from];
  for (let i = from + 1; i < to; i++) {
    const b = blocks[i];
    if (owned.has(b.id) || b.cell) return null;
    if (b.type === 'HEADER' || b.type === 'FOOTER') continue;
    if (!BODY_TYPES.has(b.type) || !sameColumn(first, b)) return null;
    out.push(b);
  }
  return out;
}

/** Blocks after the last label of a run that still belong to its section. */
function bodyAfter(blocks: readonly TextBlock[], from: number, owned: ReadonlyMap<string, string>): TextBlock[] {
  const out: TextBlock[] = [];
  const first = blocks[from];
  for (let i = from + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (owned.has(b.id) || b.cell) break;
    if (b.type === 'HEADER' || b.type === 'FOOTER') continue;
    if (!BODY_TYPES.has(b.type) || !sameColumn(first, b)) break;
    if (labelCandidateOf(b)) break;
    out.push(b);
    if (out.length >= SECTION_MAX_BODY_BLOCKS) break;
  }
  return out;
}

function buildRegion(run: ScoredCandidate[], ctx: DetectorContext): StructuredRegionDraft | null {
  if (run.length < 2) return null;
  const sections: StructuredSectionDraft[] = [];
  const signals: string[] = [];
  let longSections = 0;
  for (let k = 0; k < run.length; k++) {
    const cur = run[k];
    const next = run[k + 1];
    const between = next ? bodyBetween(ctx.blocks, cur.index, next.index, ctx.owned) : bodyAfter(ctx.blocks, cur.index, ctx.owned);
    if (between === null) return null;
    const inline = cur.candidate.placement !== 'standalone';
    const bodyBlocks = inline ? [cur.block.id, ...between.map((b) => b.id)] : between.map((b) => b.id);
    const lines = (inline ? cur.block.lineCount : 0) + between.reduce((n, b) => n + b.lineCount, 0);
    if (lines > SECTION_MAX_LINES || between.length > SECTION_MAX_BODY_BLOCKS) longSections++;
    sections.push({
      labelBlock: cur.block.id,
      bodyBlocks,
      inline,
      confidence: cur.score.confidence,
      signals: cur.score.signals,
    });
  }

  let score = run.reduce((n, r) => n + r.score.confidence, 0) / run.length;
  signals.push(`sections:${run.length}`);
  if (run.length >= 4) {
    score += 0.15;
    signals.push('four-or-more');
  } else if (run.length >= 3) {
    score += 0.1;
    signals.push('three-or-more');
  }
  const inlineCount = sections.filter((s) => s.inline).length;
  if (inlineCount >= run.length / 2) {
    score += 0.1;
    signals.push('run-in-majority');
  }
  const xs = run.map((r) => r.candidate.x);
  if (Math.max(...xs) - Math.min(...xs) <= ALIGN_TOLERANCE) {
    score += 0.05;
    signals.push('aligned');
  }
  // A heading right above the first section that reads like an abstract / summary heading.
  const first = run[0].block;
  const above = ctx.blocks
    .filter((b) => b.order < first.order && sameColumn(b, first) && b.type === 'HEADING' && b.y >= first.top && b.y - first.top <= HEADING_ABOVE_MAX_PITCH * first.fontSize)
    .pop();
  if (above && ABSTRACT_HEADING_HINT_RE.test(above.text.trim())) {
    score += 0.15;
    signals.push('abstract-heading-above');
  } else if (above) {
    score += 0.05;
    signals.push('heading-above');
  }
  if (longSections > 0) {
    score -= 0.15 * longSections;
    signals.push(`long-sections:${longSections}`);
  }
  return {
    page: ctx.page.pageNumber,
    sections,
    confidence: Math.max(0, Math.min(1, Math.round(score * 100) / 100)),
    signals,
  };
}

export const structuredAbstractDetector: LayoutDetector = {
  name: 'structured-abstract',
  run(ctx: DetectorContext): DetectorResult {
    const result = emptyResult();
    const blocks = ctx.blocks;

    // 1. label candidates in reading order
    const candidates: ScoredCandidate[] = [];
    blocks.forEach((b, index) => {
      if (ctx.owned.has(b.id) || b.cell || b.containerId) return;
      if (b.type !== 'BODY' && b.type !== 'HEADING' && b.type !== 'OTHER') return;
      const candidate = labelCandidateOf(b);
      if (!candidate) return;
      const next = blocks.slice(index + 1).find((n) => n.type !== 'HEADER' && n.type !== 'FOOTER') ?? null;
      const score = scoreLabel(candidate, { block: b, next, rules: ctx.page.rules, referenceFontSize: ctx.bodyFontSize });
      if (score.confidence < STRUCTURED_MIN_LABEL_CONFIDENCE) {
        result.diagnostics.push(`page ${ctx.page.pageNumber}: ${b.id} label "${candidate.text}" below threshold (${score.confidence}: ${score.signals.join(', ')})`);
        return;
      }
      candidates.push({ candidate, score, block: b, index });
    });
    if (candidates.length < 2) return result;

    // 2. runs of consecutive candidates in one style, one column, with only body text between them
    const runs: ScoredCandidate[][] = [];
    let run: ScoredCandidate[] = [];
    for (const c of candidates) {
      const prev = run[run.length - 1];
      if (
        prev &&
        sameStyle(prev.candidate, c.candidate) &&
        sameColumn(prev.block, c.block) &&
        Math.abs(prev.candidate.x - c.candidate.x) <= ALIGN_TOLERANCE &&
        bodyBetween(blocks, prev.index, c.index, ctx.owned) !== null
      ) {
        run.push(c);
        continue;
      }
      if (run.length) runs.push(run);
      run = [c];
    }
    if (run.length) runs.push(run);

    // 3. regions
    for (const r of runs) {
      const region = buildRegion(r, ctx);
      if (!region) continue;
      if (region.confidence < STRUCTURED_MIN_REGION_CONFIDENCE) {
        result.diagnostics.push(`page ${ctx.page.pageNumber}: region of ${r.length} label(s) rejected (${region.confidence}: ${region.signals.join(', ')})`);
        continue;
      }
      result.regions.push(region);
      for (const s of region.sections) {
        const c = r.find((x) => x.block.id === s.labelBlock) as ScoredCandidate;
        result.assignments.push({
          blockId: s.labelBlock,
          role: 'STRUCTURED_LABEL',
          confidence: s.confidence,
          signals: s.signals,
          split: c.candidate.placement === 'standalone' ? undefined : { itemCount: c.candidate.itemCount, bodyRole: 'BODY' },
        });
        for (const id of s.bodyBlocks) {
          if (id === s.labelBlock) continue;
          result.assignments.push({ blockId: id, role: 'BODY', confidence: region.confidence, signals: ['structured-section-body'] });
        }
      }
    }
    return result;
  },
};
