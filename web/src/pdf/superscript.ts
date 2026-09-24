/**
 * Superscript citation / reference markers.
 *
 * Vancouver-style papers write their references as raised numbers glued to
 * the preceding word ("among family caregivers.62", "16,27-29"). PDF.js
 * reports them as ordinary text items, so without this module they end up in
 * the block text as plain digits, are handed to the model as running text and
 * are finally drawn on the baseline at body size — which is exactly the
 * "引用編號沒有以上標呈現" problem.
 *
 * Two detectors run, in this order:
 *
 *  1. metadata: an item on a line is a superscript when it is set smaller
 *     than the line's dominant size AND its baseline sits above the line's
 *     baseline AND its text looks like a citation marker. This is the
 *     reliable path and is always used.
 *
 *  2. fallback: some producers merge the marker into the word's own text item
 *     ("caregivers.62"), so no geometry survives. Then a marker is only
 *     accepted when the digits follow a sentence-final punctuation mark that
 *     itself follows a letter — "caregivers.62", never "0.05", "COVID-19",
 *     "Table 1" or "p = .62". Deliberately narrow: a missed marker only costs
 *     the raised look, a wrong one would raise a real number.
 *
 * Pure functions over the extraction structures, unit-tested in
 * __tests__/superscript.test.ts.
 */

import type { ScriptRun, TextBlock, TextItemDebug, TextLine } from './types';

/** An item is a superscript candidate when it is at most this fraction of the line size. */
export const SUP_MAX_FONT_RATIO = 0.86;
/** ...and its baseline sits at least this many em (of the line size) above the line baseline. */
export const SUP_MIN_RISE_EM = 0.14;
/** A lowered one sits at least this many em below it; a subscript drops less than a superscript rises. */
export const SUB_MIN_DROP_EM = 0.08;
/** Longest marker accepted, in characters ("16,27-29,31" is 11). */
export const SUP_MAX_LENGTH = 16;

/**
 * A citation marker: one number, a comma list, an en-dash / hyphen range, or
 * any combination — 68, 57,58, 27-29, 16,27-29. Letter markers (a, b, †) are
 * footnote markers and are handled by the table / footnote paths, not here.
 */
export const CITATION_MARKER_RE = /^\d{1,3}(?:\s*[,;]\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3})?|\s*[–—-]\s*\d{1,3})*$/;

/** Same pattern, anchored for use inside a longer string. */
const CITATION_MARKER_SOURCE = String.raw`\d{1,3}(?:\s*[,;]\s*\d{1,3}(?:\s*[–—-]\s*\d{1,3})?|\s*[–—-]\s*\d{1,3})*`;

/**
 * Fallback: digits glued to the end of a word through a sentence-final mark
 * ("caregivers.62", "risk,15", "outcome.16,27-29"). The character before the
 * punctuation must be a letter or a closing bracket, which rules out decimals
 * ("0.05"), version numbers and "p = .62".
 */
const GLUED_MARKER_RE = new RegExp(
  String.raw`(?<=[A-Za-z一-鿿)\]][.,;:!?])(${CITATION_MARKER_SOURCE})(?![\d.%A-Za-z一-鿿])`,
  'g',
);

/** True when `text` is exactly a citation marker such as "68" or "16,27-29". */
export function isCitationMarker(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= SUP_MAX_LENGTH && CITATION_MARKER_RE.test(t);
}

/** Markers are compared and re-emitted without their internal spaces. */
export function normalizeMarker(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Is this item a raised citation marker on its line? `line.y` / `line.fontSize`
 * are the dominant baseline and size (layout.ts picks the item contributing
 * the most characters), so a one-item line can never flag itself.
 */
export function isSuperscriptItem(item: TextItemDebug, line: TextLine): boolean {
  if (line.items.length < 2) return false;
  if (!isCitationMarker(item.text)) return false;
  if (item.fontSize > line.fontSize * SUP_MAX_FONT_RATIO) return false;
  return item.y - line.y >= SUP_MIN_RISE_EM * line.fontSize;
}

/** Longest lowered run accepted: a subscript is an index, not a word. */
export const SUB_MAX_LENGTH = 6;

/**
 * Text that can be a lowered index: letters, digits and the separators of a
 * list or a range, no spaces. Wider than a citation marker, because a
 * subscript is just as often a letter (the "p" of partial eta squared, the
 * "max" of VO2max is already too long and stays text).
 */
const SUB_TEXT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9,;+–—-]*[A-Za-z0-9])?$/;

/**
 * The identifier a lowered run hangs off: the letters and digits directly in
 * front of it, punctuation and spaces excluded. "; n" gives "n" (the n of
 * np2), "for H" gives "H", "the FEV" gives "FEV" — which is exactly what a
 * translation keeps verbatim, while "; n" with its spacing is not.
 */
const SUB_ANCHOR_RE = /[A-Za-z0-9]+$/;

/** The identifier `before` ends with, empty when it ends in anything else. */
function anchorOf(before: string): string {
  return (SUB_ANCHOR_RE.exec(before)?.[0] ?? '').slice(-SUB_ANCHOR_MAX);
}

/**
 * Is this item a lowered run on its line (the "2" of H2O, the "p" of np2)?
 * Same shape as a superscript, the other way round: the drop is smaller than
 * a rise, which is exactly why PDF.js merges subscripts into their neighbour
 * and pdf/textruns.ts has to split them out again.
 */
export function isSubscriptItem(item: TextItemDebug, line: TextLine): boolean {
  if (line.items.length < 2) return false;
  const text = item.text.trim();
  if (text.length === 0 || text.length > SUB_MAX_LENGTH || !SUB_TEXT_RE.test(text)) return false;
  if (item.fontSize > line.fontSize * SUP_MAX_FONT_RATIO) return false;
  return line.y - item.y >= SUB_MIN_DROP_EM * line.fontSize;
}

/** A raised marker as one of the two detectors found it. Its `text` has its internal spaces removed ("16,27-29"). */
export interface MarkerDetection extends ScriptRun {
  /** How it was found. */
  source: 'metadata' | 'glued';
}

/**
 * Every raised run of one line, in reading order, each with the identifier it
 * followed — "np" for the exponent of np2, "caregivers" for a citation. The
 * anchor is a hint, not a condition: a citation whose word was translated is
 * still placed by its number alone (see pdf/inline.ts).
 */
export function lineSuperscripts(line: TextLine): MarkerDetection[] {
  const out: MarkerDetection[] = [];
  let before = '';
  for (const item of line.items) {
    if (isSuperscriptItem(item, line)) {
      out.push({ text: normalizeMarker(item.text), anchor: anchorOf(before), source: 'metadata' });
    }
    before += item.text;
  }
  return out;
}

/** Longest anchor kept in front of a lowered run. */
export const SUB_ANCHOR_MAX = 8;

/**
 * Every lowered run of one line, in reading order, each with the identifier
 * it directly follows. A run that follows a space, a punctuation mark or
 * nothing at all is dropped: without an anchor it cannot be placed in the
 * translation without guessing.
 */
export function lineSubscripts(line: TextLine): ScriptRun[] {
  const out: ScriptRun[] = [];
  let before = '';
  for (const item of line.items) {
    if (isSubscriptItem(item, line)) {
      const anchor = anchorOf(before);
      if (anchor) out.push({ text: item.text.trim(), anchor });
    }
    before += item.text;
  }
  return out;
}

/** Citation markers glued into a word's own text item (fallback detector). */
export function gluedSuperscripts(text: string): MarkerDetection[] {
  const out: MarkerDetection[] = [];
  GLUED_MARKER_RE.lastIndex = 0;
  for (const m of text.matchAll(GLUED_MARKER_RE)) {
    const marker = normalizeMarker(m[1]);
    if (marker.length <= SUP_MAX_LENGTH) out.push({ text: marker, anchor: '', source: 'glued' });
  }
  return out;
}

export interface BlockSuperscripts {
  /** The raised runs, in the order they appear in the block text. */
  markers: ScriptRun[];
  metadataCount: number;
  gluedCount: number;
}

/**
 * All citation markers of one layout block. Metadata detection runs over the
 * block's lines; the glued fallback runs over the block text and only adds
 * markers the metadata pass did not already find.
 */
export function collectBlockSuperscripts(block: TextBlock): BlockSuperscripts {
  const markers: ScriptRun[] = [];
  const seen = new Set<string>();
  let metadataCount = 0;
  let gluedCount = 0;

  // One marker per raised run, duplicates included: a paragraph that raises
  // the same exponent three times ("np2 … np2 … np2") needs three of them, or
  // only the first one comes back raised in the translation.
  for (const line of block.lines) {
    for (const found of lineSuperscripts(line)) {
      metadataCount++;
      seen.add(found.text);
      markers.push({ text: found.text, anchor: found.anchor });
    }
  }
  for (const found of gluedSuperscripts(block.text)) {
    if (seen.has(found.text)) continue;
    gluedCount++;
    seen.add(found.text);
    markers.push({ text: found.text, anchor: '' });
  }
  return { markers, metadataCount, gluedCount };
}

/**
 * The lowered runs of one layout block, one entry per run.
 *
 * There is no glued fallback: a subscript that PDF.js merged into its
 * neighbour leaves no trace in the text, and guessing one from the digits
 * alone would lower ordinary numbers.
 */
export function collectBlockSubscripts(block: TextBlock): ScriptRun[] {
  const runs: ScriptRun[] = [];
  for (const line of block.lines) runs.push(...lineSubscripts(line));
  return runs;
}

/**
 * The marker a text ends with, if any ("…caregivers.62" → "62"). Used by the
 * renderer to put a trailing citation back when the translation dropped it.
 */
export function trailingMarker(text: string): string | null {
  const m = new RegExp(String.raw`(${CITATION_MARKER_SOURCE})\s*$`).exec(text.trimEnd());
  if (!m) return null;
  const marker = normalizeMarker(m[1]);
  if (!isCitationMarker(marker)) return null;
  // Must be glued to a word, not a standalone number ("Table 1", "2024").
  const before = text.trimEnd().slice(0, m.index);
  if (!/[A-Za-z一-鿿)\]][.,;:!?]?$/.test(before)) return null;
  return marker;
}
