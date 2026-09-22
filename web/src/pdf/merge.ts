/**
 * Turn layout blocks into translation units.
 *
 *  - A BODY block whose text does not end a sentence is merged with the next
 *    BODY block in reading order (across the column gutter or the page break),
 *    up to MAX_MERGED_BLOCKS blocks.
 *  - Merging never crosses a heading, caption, title, reference entry or any
 *    non-translatable block other than running headers/footers.
 *  - Whatever is still incomplete after merging is flagged incompleteSource so
 *    the prompt tells the model not to invent the missing text.
 *  - Context policy: units in one batch already see each other, so a normal
 *    complete unit gets NO previousContext / nextContext. Only units that are
 *    incomplete, merged, or continue an incomplete neighbour (page / column
 *    break) get up to CONTEXT_CHARS of neighbouring text.
 *
 * Pure function over TextBlock[], unit-tested in __tests__/merge.test.ts.
 */

import { analyzeCompleteness, headContext, joinFragments, tailContext, type CompletenessResult } from './text';
import type { BlockType, TextBlock, TranslationBlock } from './types';

export const MAX_MERGED_BLOCKS = 3;
/** Characters of neighbouring text handed to the model as context, per side. */
export const CONTEXT_CHARS = 120;
/** The previous policy (every unit, both sides), only used to report savings. */
export const LEGACY_CONTEXT_CHARS = 300;
/** Font size difference (relative) still considered "the same paragraph style". */
const FONT_SIZE_TOLERANCE = 0.1;

/** Block types that may be merged with the following block of the same type. */
const MERGEABLE: ReadonlySet<BlockType> = new Set(['BODY']);
/** Blocks that sit between paragraphs without interrupting them. */
const PASS_THROUGH: ReadonlySet<BlockType> = new Set(['HEADER', 'FOOTER']);

interface Continuation {
  index: number;
  block: TextBlock;
  why: string;
}

/**
 * Find the block that continues `last`, starting after `fromIndex`.
 * Returns null when the next real block is not a valid continuation.
 */
function findContinuation(
  blocks: TextBlock[],
  fromIndex: number,
  last: TextBlock,
  completeness: CompletenessResult,
): Continuation | null {
  for (let j = fromIndex + 1; j < blocks.length; j++) {
    const n = blocks[j];
    if (PASS_THROUGH.has(n.type)) continue;

    if (!n.translate || n.type !== last.type) return null; // heading, caption, reference, table fragment...
    if (n.page !== last.page && n.page !== last.page + 1) return null;
    if (Math.abs(n.fontSize - last.fontSize) > FONT_SIZE_TOLERANCE * last.fontSize) return null;

    const startsLowercase = /^[a-z]/.test(n.text.trimStart());
    // Weak signal (just no final period) needs the next block to visibly continue the sentence.
    if (!startsLowercase && !completeness.strong) return null;

    const flags = [
      completeness.reason,
      n.page !== last.page ? 'cross-page' : null,
      n.column !== last.column ? 'cross-column' : null,
      startsLowercase ? 'next-starts-lowercase' : null,
    ].filter(Boolean);
    return { index: j, block: n, why: `${last.id}→${n.id} (${flags.join(', ')})` };
  }
  return null;
}

export function buildTranslationBlocks(blocks: TextBlock[]): TranslationBlock[] {
  const out: TranslationBlock[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.translate || consumed.has(b.id)) continue;

    const group: TextBlock[] = [b];
    let text = b.text;
    let completeness = analyzeCompleteness(text);
    const reasons: string[] = [];

    if (MERGEABLE.has(b.type)) {
      let cursor = i;
      while (!completeness.complete && group.length < MAX_MERGED_BLOCKS) {
        const found = findContinuation(blocks, cursor, group[group.length - 1], completeness);
        if (!found) break;
        group.push(found.block);
        consumed.add(found.block.id);
        text = joinFragments(text, found.block.text);
        reasons.push(found.why);
        cursor = found.index;
        completeness = analyzeCompleteness(text);
      }
    }

    const sourceBlockIds = group.map((g) => g.id);
    const wasMerged = group.length > 1;
    out.push({
      id: wasMerged ? `merged-${sourceBlockIds.join('-')}` : b.id,
      page: b.page,
      pages: [...new Set(group.map((g) => g.page))],
      type: b.type,
      sectionType: b.sectionType,
      blockType: b.blockType,
      text,
      sourceBlockIds,
      wasMerged,
      mergeReason: wasMerged ? reasons.join('; ') : null,
      incompleteSource: !completeness.complete,
      previousContext: null,
      nextContext: null,
      contextReason: null,
    });
  }

  assignContext(out);
  return out;
}

/** A unit that visibly continues the previous one (lowercase start). */
function startsMidSentence(unit: TranslationBlock): boolean {
  return /^[a-z]/.test(unit.text.trimStart());
}

/**
 * Headings, titles and captions normally end without a period, so their
 * `incompleteSource` flag says nothing about a cut sentence. Only running
 * text counts here.
 */
function cutMidSentence(unit: TranslationBlock): boolean {
  return unit.incompleteSource && (unit.type === 'BODY' || unit.type === 'FOOTNOTE');
}

/**
 * Attach neighbouring context only where it changes the translation:
 *  - incomplete unit: what comes next (and before) tells the model where the
 *    sentence goes;
 *  - merged unit: its pieces came from different columns/pages;
 *  - continuation: the previous unit was incomplete, or this unit starts
 *    mid-sentence, so the sentence began elsewhere (column / page break).
 */
function assignContext(units: TranslationBlock[]): void {
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const prev = i > 0 ? units[i - 1] : null;
    const next = i < units.length - 1 ? units[i + 1] : null;
    const reasons: string[] = [];
    const incomplete = cutMidSentence(unit);
    if (incomplete) reasons.push('incomplete');
    if (unit.wasMerged) reasons.push('merged');
    const continuation = (prev && cutMidSentence(prev)) || startsMidSentence(unit);
    if (continuation) reasons.push(prev && prev.page !== unit.page ? 'continuation-cross-page' : 'continuation');

    const wantPrev = reasons.length > 0;
    const wantNext = incomplete || unit.wasMerged;
    unit.previousContext = wantPrev && prev ? tailContext(prev.text, CONTEXT_CHARS) : null;
    unit.nextContext = wantNext && next ? headContext(next.text, CONTEXT_CHARS) : null;
    unit.contextReason = unit.previousContext || unit.nextContext ? reasons.join('+') : null;
  }
}

export interface ContextStats {
  inputChars: number;
  contextChars: number;
  contextUnitCount: number;
  contextCharsSaved: number;
}

/** Token-budget figures for the UI: what is sent now versus the old policy. */
export function contextStats(units: readonly TranslationBlock[]): ContextStats {
  let inputChars = 0;
  let contextChars = 0;
  let contextUnitCount = 0;
  let legacy = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    inputChars += u.text.length;
    const attached = (u.previousContext?.length ?? 0) + (u.nextContext?.length ?? 0);
    contextChars += attached;
    if (attached > 0) contextUnitCount++;
    if (i > 0) legacy += tailContext(units[i - 1].text, LEGACY_CONTEXT_CHARS).length;
    if (i < units.length - 1) legacy += headContext(units[i + 1].text, LEGACY_CONTEXT_CHARS).length;
  }
  return { inputChars, contextChars, contextUnitCount, contextCharsSaved: Math.max(0, legacy - contextChars) };
}
