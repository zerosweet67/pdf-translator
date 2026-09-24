/**
 * Turn layout blocks into translation units.
 *
 *  - A BODY block whose text does not end a sentence is merged with the next
 *    BODY block in reading order (across the column gutter or the page break),
 *    up to MAX_MERGED_BLOCKS blocks.
 *  - A block that pdf/paragraph.ts marked as an orphan sentence tail
 *    (`orphanOf`) is never a unit of its own: it is appended to the unit of
 *    the paragraph it belongs to, so the renderer flows one translation
 *    through both boxes instead of translating and placing the tail alone.
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

import { roleOf } from './roles';
import { analyzeCompleteness, headContext, joinFragments, tailContext, type CompletenessResult } from './text';
import type { BlockType, TextBlock, TranslationBlock } from './types';

export const MAX_MERGED_BLOCKS = 3;
/** Characters of neighbouring text handed to the model as context, per side. */
export const CONTEXT_CHARS = 120;
/** The previous policy (every unit, both sides), only used to report savings. */
export const LEGACY_CONTEXT_CHARS = 300;
/** Font size difference (relative) still considered "the same paragraph style". */
const FONT_SIZE_TOLERANCE = 0.1;

/**
 * Block types that may be merged with the following block of the same type.
 *
 * A title or a heading is in here for one case only: its first line runs the
 * full width of the page and its last line stops short, so the column model
 * files them as SPANNING and LEFT and grouping — which runs per region —
 * cannot put them in one block. findContinuation() then still needs a strong
 * signal (the first part ends on a function word, a comma or a dash), which
 * two headings that merely follow each other never give.
 */
const MERGEABLE: ReadonlySet<BlockType> = new Set(['BODY', 'TITLE', 'HEADING']);
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
    if (n.orphanOf) continue; // a tail already owned by an earlier paragraph

    if (!n.translate || n.type !== last.type) return null; // heading, caption, reference, table fragment...
    // A sidebar paragraph never continues into the main text (or the other way round).
    if (roleOf(n) !== roleOf(last) || n.containerId !== last.containerId) return null;
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

/**
 * Orphan tails (pdf/paragraph.ts) indexed by the paragraph that owns them.
 * A tail whose owner is missing or untranslatable keeps its independence, so
 * no text can be lost by an incomplete plan.
 */
function orphansByOwner(blocks: readonly TextBlock[]): Map<string, TextBlock[]> {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const map = new Map<string, TextBlock[]>();
  for (const b of blocks) {
    if (!b.orphanOf) continue;
    const owner = byId.get(b.orphanOf);
    if (!owner || !owner.translate) continue;
    const list = map.get(b.orphanOf) ?? [];
    list.push(b);
    map.set(b.orphanOf, list);
  }
  return map;
}

export function buildTranslationBlocks(blocks: TextBlock[]): TranslationBlock[] {
  const out: TranslationBlock[] = [];
  const consumed = new Set<string>();
  const orphans = orphansByOwner(blocks);
  const absorbed = new Set<string>();
  for (const list of orphans.values()) for (const o of list) consumed.add(o.id);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // `consumed` already holds every tail that a paragraph claimed; a tail
    // whose owner cannot produce a unit is left to emit its own, as before.
    if (!b.translate || consumed.has(b.id)) continue;

    const group: TextBlock[] = [];
    const orphanIds: string[] = [];
    const reasons: string[] = [];
    let text = '';
    /** Continuation merges only; absorbed tails do not use up the budget. */
    let merges = 1;

    const add = (block: TextBlock) => {
      group.push(block);
      text = text ? joinFragments(text, block.text) : block.text;
    };
    /** Give the paragraph back the sentence tails that were split off it. */
    const absorb = (owner: TextBlock) => {
      for (const tail of orphans.get(owner.id) ?? []) {
        if (absorbed.has(tail.id)) continue;
        absorbed.add(tail.id);
        add(tail);
        orphanIds.push(tail.id);
        reasons.push(`${owner.id}→${tail.id} (orphan-tail: ${tail.orphanReason ?? 'sentence tail'})`);
      }
    };

    add(b);
    absorb(b);
    let completeness = analyzeCompleteness(text);

    if (MERGEABLE.has(b.type)) {
      let cursor = i;
      while (!completeness.complete && merges < MAX_MERGED_BLOCKS) {
        const found = findContinuation(blocks, cursor, group[group.length - 1], completeness);
        if (!found) break;
        merges++;
        consumed.add(found.block.id);
        add(found.block);
        reasons.push(found.why);
        absorb(found.block);
        cursor = found.index;
        completeness = analyzeCompleteness(text);
      }
    }

    const sourceBlockIds = group.map((g) => g.id);
    const wasMerged = group.length > 1;
    const last = group[group.length - 1];
    const superscripts = group.flatMap((g) => g.superscripts ?? []);
    const subscripts = group.flatMap((g) => g.subscripts ?? []);
    out.push({
      id: wasMerged ? `merged-${sourceBlockIds.join('-')}` : b.id,
      page: b.page,
      pages: [...new Set(group.map((g) => g.page))],
      type: b.type,
      sectionType: b.sectionType,
      blockType: b.blockType,
      role: roleOf(b),
      containerId: b.containerId,
      text,
      sourceBlockIds,
      wasMerged,
      mergeReason: wasMerged ? reasons.join('; ') : null,
      orphanFragmentIds: orphanIds.length ? orphanIds : undefined,
      superscripts: superscripts.length ? [...superscripts] : undefined,
      subscripts: subscripts.length ? [...subscripts] : undefined,
      incompleteSource: !completeness.complete,
      previousContext: null,
      nextContext: null,
      contextReason: null,
      span: { startPage: b.page, startY: b.top, endPage: last.page, endY: last.y },
    });
  }

  // A tail whose owner never produced a unit stays a unit of its own: better
  // an isolated fragment than text that silently disappears from the page.
  let stranded = 0;
  for (const list of orphans.values()) {
    for (const tail of list) {
      if (absorbed.has(tail.id)) continue;
      stranded++;
      out.push({
        id: tail.id,
        page: tail.page,
        pages: [tail.page],
        type: tail.type,
        sectionType: tail.sectionType,
        blockType: tail.blockType,
        role: roleOf(tail),
        containerId: tail.containerId,
        text: tail.text,
        sourceBlockIds: [tail.id],
        wasMerged: false,
        mergeReason: null,
        superscripts: tail.superscripts?.length ? [...tail.superscripts] : undefined,
        subscripts: tail.subscripts?.length ? [...tail.subscripts] : undefined,
        incompleteSource: !analyzeCompleteness(tail.text).complete,
        previousContext: null,
        nextContext: null,
        contextReason: null,
        span: { startPage: tail.page, startY: tail.top, endPage: tail.page, endY: tail.y },
      });
    }
  }
  // Stable sort: only the stranded tails appended above move into place.
  if (stranded > 0) out.sort((a, b2) => a.page - b2.page);

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
