/**
 * Orphan sentence tails.
 *
 * The line grouper in layout.ts splits a paragraph whenever the vertical
 * pitch, the font or the left edge changes. A last line that carries only the
 * end of a sentence plus a citation ("among family caregivers.62") therefore
 * often becomes a block of its own — and classify.ts then files it as
 * OTHER/"fragment", so it is never translated, never masked, and stays in
 * English right in the middle of the Chinese page.
 *
 * This module finds those tails and gives each one back to the paragraph it
 * belongs to. The fragment stops being a translation unit: merge.ts appends
 * its text to the owner's and the renderer flows the translation through both
 * boxes, so the fragment's box is masked and filled from the right place.
 *
 * The rules are deliberately conservative — a wrongly absorbed label would
 * disappear from the page:
 *
 *   - the fragment is short (one line, few words, few characters)
 *   - it starts lower case, is punctuation-led, or is a bare citation number
 *   - it is not a caption, heading, reference entry, table cell or figure text
 *   - an owner is found close by in reading order: a BODY paragraph in the
 *     same column band, on the same or the previous page, set at the same
 *     size, whose own text does not end a sentence — or which ends one while
 *     the fragment cannot start one
 *
 * Pure functions over TextBlock[], unit-tested in __tests__/paragraph.test.ts.
 */

import { isCitationMarker } from './superscript';
import { analyzeCompleteness } from './text';
import type { BlockType, TextBlock } from './types';

/** A fragment may span at most this many lines. */
export const ORPHAN_MAX_LINES = 1;
/** ...and hold at most this many characters. */
export const ORPHAN_MAX_CHARS = 90;
/** ...and at most this many whitespace-separated words. */
export const ORPHAN_MAX_WORDS = 8;
/** How far back in reading order an owner is looked for. */
export const ORPHAN_SEARCH_WINDOW = 6;
/** Font size difference (relative) still considered "the same paragraph style". */
export const ORPHAN_FONT_TOLERANCE = 0.12;
/** Types a fragment may have; anything else is structural and stays alone. */
const ABSORBABLE: ReadonlySet<BlockType> = new Set(['BODY', 'OTHER']);
/** Types that may own a fragment. */
const OWNER_TYPES: ReadonlySet<BlockType> = new Set(['BODY']);

export interface OrphanMerge {
  fragmentId: string;
  ownerId: string;
  /** Which rules fired, for Developer Mode. */
  reason: string;
}

export interface OrphanPlan {
  merges: OrphanMerge[];
  /** Fragment-looking blocks for which no safe owner was found. */
  unresolved: string[];
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** A bare citation number, possibly with a closing bracket: "62", "16,27-29", "62)". */
function isCitationOnly(text: string): boolean {
  return isCitationMarker(text.trim().replace(/[)\]]$/, ''));
}

/**
 * Does this block look like the tail of the previous paragraph rather than
 * something of its own? Returns the matching signals, empty when it does not.
 */
export function orphanSignals(block: TextBlock): string[] {
  if (block.cell) return [];
  if (!ABSORBABLE.has(block.type)) return [];
  if (block.lineCount > ORPHAN_MAX_LINES) return [];
  const text = block.text.trim();
  if (!text) return [];
  if (text.length > ORPHAN_MAX_CHARS || wordCount(text) > ORPHAN_MAX_WORDS) return [];

  const signals: string[] = [];
  if (/^[a-z]/.test(text)) signals.push('starts-lowercase');
  if (/^[,.;:)\]}»”’]/.test(text)) signals.push('starts-with-punctuation');
  if (isCitationOnly(text)) signals.push('citation-only');
  // "…caregivers.62": a sentence end plus a citation and nothing else.
  if (/[.!?][\s]*\d{1,3}(?:[,;–-]\d{1,3})*$/.test(text)) signals.push('citation-tail');
  if (block.type === 'OTHER' && block.skipReason === 'fragment') signals.push('classified-fragment');
  // A lone tail needs at least one continuation signal, not just "it is short".
  return signals.some((s) => s !== 'classified-fragment') ? signals : [];
}

/** A tail may start this far above the bottom of its paragraph (rounding, a raised marker). */
const ORPHAN_TAIL_SLACK = 1;
/** Two lines are the same line when their baselines differ by less than this (× fontSize). */
const SAME_LINE_TOLERANCE = 0.25;

/**
 * The fragment continues the last line of `owner`: same baseline, and that
 * line ends to its left. A justified narrow column leaves single words
 * standing this way ("breath-hold" | "diving" | "physiology,"), and the word
 * belongs after the line it follows — not after the whole paragraph.
 */
function continuesSameLine(owner: TextBlock, fragment: TextBlock): boolean {
  const line = owner.lines[owner.lines.length - 1];
  const first = fragment.lines[0];
  if (!line || !first) return false;
  if (Math.abs(line.y - first.y) > SAME_LINE_TOLERANCE * Math.max(fragment.fontSize, 1)) return false;
  return line.x + line.width <= fragment.x + 1;
}

/** The fragment's box stands within the vertical span of this block. */
function insideParagraph(owner: TextBlock, fragment: TextBlock): boolean {
  if (fragment.page !== owner.page || fragment.column !== owner.column) return false;
  return fragment.top <= owner.top + 1 && fragment.y >= owner.y - 1;
}

/** Same column band, or the natural column / page break between two blocks. */
function geometryAllows(owner: TextBlock, fragment: TextBlock): boolean {
  // A sidebar / callout keeps its text: nothing flows in or out of a container.
  if (fragment.containerId !== owner.containerId) return false;
  if (fragment.page === owner.page && fragment.column === owner.column) {
    // A tail comes after its paragraph. A fragment that starts inside the
    // paragraph's own band is a piece of one of its lines — a justified
    // narrow column leaves single words standing alone that way — and
    // absorbing it would move that word to the end of the text.
    return fragment.top <= owner.y + ORPHAN_TAIL_SLACK;
  }
  // Column or page break: the tail may legitimately sit anywhere in the next band.
  return fragment.page === owner.page || fragment.page === owner.page + 1;
}

/**
 * Find the paragraph a fragment belongs to: the closest preceding BODY block
 * in reading order that is still open (or that the fragment visibly
 * continues), within ORPHAN_SEARCH_WINDOW blocks.
 */
function findOwner(
  blocks: readonly TextBlock[],
  index: number,
  signals: readonly string[],
  planned: ReadonlySet<string>,
): { owner: TextBlock; why: string } | null {
  const fragment = blocks[index];
  const startsLower = signals.includes('starts-lowercase') || signals.includes('starts-with-punctuation');
  for (let j = index - 1, steps = 0; j >= 0 && steps < ORPHAN_SEARCH_WINDOW; j--, steps++) {
    const candidate = blocks[j];
    if (planned.has(candidate.id) || candidate.orphanOf) continue; // already a tail itself
    if (candidate.type === 'HEADER' || candidate.type === 'FOOTER') continue; // running furniture
    if (candidate.cell) return null; // a table / figure sits between them
    if (!OWNER_TYPES.has(candidate.type) || !candidate.translate) {
      // A heading, caption or reference entry ends the search: the fragment
      // belongs to whatever follows it, not to something before it.
      return null;
    }
    // A word left standing by a justified line continues the line it follows.
    if (continuesSameLine(candidate, fragment)) return { owner: candidate, why: 'continues-the-same-line' };
    if (!geometryAllows(candidate, fragment)) {
      // The fragment stands *inside* this block: the line it belongs to is an
      // earlier one, so keep looking back instead of giving up.
      if (insideParagraph(candidate, fragment)) continue;
      return null;
    }
    if (Math.abs(candidate.fontSize - fragment.fontSize) > ORPHAN_FONT_TOLERANCE * candidate.fontSize) return null;

    const open = !analyzeCompleteness(candidate.text).complete;
    if (open) return { owner: candidate, why: 'previous-paragraph-open' };
    if (startsLower) return { owner: candidate, why: 'fragment-continues-sentence' };
    return null;
  }
  return null;
}

/**
 * Plan which fragments are absorbed by which paragraph. `blocks` must be in
 * reading order and already classified (and table / figure cells resolved).
 */
export function planOrphanMerges(blocks: readonly TextBlock[]): OrphanPlan {
  const merges: OrphanMerge[] = [];
  const unresolved: string[] = [];
  const planned = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const signals = orphanSignals(blocks[i]);
    if (signals.length === 0) continue;
    const found = findOwner(blocks, i, signals, planned);
    if (!found) {
      unresolved.push(blocks[i].id);
      continue;
    }
    planned.add(blocks[i].id);
    merges.push({ fragmentId: blocks[i].id, ownerId: found.owner.id, reason: `${found.why} (${signals.join(', ')})` });
  }
  return { merges, unresolved };
}

/**
 * Apply a plan: every fragment becomes translatable body text owned by its
 * paragraph. merge.ts turns owner + fragments into a single translation unit;
 * the fragment keeps its own box so the renderer can mask it and flow text
 * into it.
 */
export function applyOrphanPlan(blocks: readonly TextBlock[], plan: OrphanPlan): void {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const merge of plan.merges) {
    const fragment = byId.get(merge.fragmentId);
    if (!fragment) continue;
    fragment.orphanOf = merge.ownerId;
    fragment.orphanReason = merge.reason;
    fragment.type = 'BODY';
    fragment.blockType = 'BODY';
    fragment.translate = true;
    fragment.skipReason = null;
  }
}

/** Convenience for layout.ts: plan and apply in one step. */
export function absorbOrphanFragments(blocks: readonly TextBlock[]): OrphanPlan {
  const plan = planOrphanMerges(blocks);
  applyOrphanPlan(blocks, plan);
  return plan;
}
