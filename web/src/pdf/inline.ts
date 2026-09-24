/**
 * Inline typography of a translated paragraph: spacing normalization and
 * sub/superscript segmentation.
 *
 * The model returns one plain string. Before it can be wrapped and drawn it
 * has to be turned into inline segments, because the citation markers inside
 * it are set smaller and raised (see superscript.ts / typography.ts), and its
 * spacing has to be normalized: models mix "照顧者 62"、"照顧者62"、
 * "30 %"、"（ 見表 1 ）" freely, which is what makes the Chinese output look
 * uneven.
 *
 * Order matters. Segmentation runs first, so the spacing rules can see where
 * a marker starts and never insert a space in front of one; the marker text
 * itself is then never touched again — the digits reach the page exactly as
 * the source had them.
 *
 * This path is used by the paragraph renderer only (TITLE / HEADING / BODY /
 * CAPTION / FOOTNOTE). Table cells and figure elements keep their own code.
 *
 * Pure functions, unit-tested in __tests__/inline.test.ts.
 */

import { isCitationMarker, normalizeMarker } from './superscript';
import type { InlineSegment, ScriptRun } from './types';

/** Closing CJK punctuation: never preceded by a space. */
const CJK_CLOSERS = '，。、；：？！）》」』】〉〕］｝〗〙〛％‰…—·';
/** Opening CJK punctuation: never followed by a space. */
const CJK_OPENERS = '（《「『【〈〔［｛〖〘〚';
/** Units that stay glued to the number in front of them. */
const GLUED_UNITS = '%‰℃°′″';

/**
 * Chinese *letters*: ideographs, kana, bopomofo and compatibility forms, but
 * NOT the full-width punctuation. Punctuation must stay out of the "insert one
 * space" rules, or "30%。" would become "30% 。".
 */
const CJK_TEXT = String.raw`⺀-⻿぀-ヿ㄀-ㄯㆠ-ㆿ㐀-䶿一-鿿豈-﫿`;
/** The same plus CJK punctuation and full-width forms, for the "no space" rules. */
const CJK_ANY = String.raw`⺀-⻿　-〿぀-ヿ㄀-ㄯㆠ-ㆿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯`;

const RE_SPACE_RUN = /[\s 　]+/g;
const RE_CJK_CJK = new RegExp(String.raw`(?<=[${CJK_ANY}])[ ]+(?=[${CJK_ANY}])`, 'g');
const RE_BEFORE_CJK_CLOSER = new RegExp(String.raw`[ ]+(?=[${CJK_CLOSERS}])`, 'g');
const RE_AFTER_CJK_OPENER = new RegExp(String.raw`(?<=[${CJK_OPENERS}])[ ]+`, 'g');
const RE_BEFORE_ASCII_CLOSER = /[ ]+(?=[,.;:!?)\]}])/g;
const RE_AFTER_ASCII_OPENER = /(?<=[([{])[ ]+/g;
const RE_BEFORE_UNIT = new RegExp(String.raw`(?<=\d)[ ]+(?=[${GLUED_UNITS}])`, 'g');
/** One space between Chinese letters and Latin / digits, in both directions. */
const RE_CJK_THEN_LATIN = new RegExp(String.raw`(?<=[${CJK_TEXT}])(?=[A-Za-z0-9([])`, 'g');
const RE_LATIN_THEN_CJK = new RegExp(String.raw`(?<=[A-Za-z0-9)\]%])(?=[${CJK_TEXT}])`, 'g');

/**
 * Consistent spacing inside one run of translated text.
 *
 *  - whitespace runs (including U+00A0 / U+3000) collapse to one space
 *  - no space between two Chinese characters
 *  - no space before closing or after opening punctuation, Chinese or ASCII
 *  - no space between a number and %, ‰, ℃, °
 *  - exactly one space between Chinese and Latin letters / digits
 *  - no leading or trailing space
 *
 * Chinese punctuation is excluded from the "insert a space" rules because it
 * is full-width: 「（見表 1）」 already carries its own side bearings.
 */
export function normalizeInlineSpacing(text: string): string {
  let t = text.replace(RE_SPACE_RUN, ' ');
  t = t.replace(RE_CJK_CJK, '');
  t = t.replace(RE_BEFORE_CJK_CLOSER, '');
  t = t.replace(RE_AFTER_CJK_OPENER, '');
  t = t.replace(RE_BEFORE_ASCII_CLOSER, '');
  t = t.replace(RE_AFTER_ASCII_OPENER, '');
  t = t.replace(RE_BEFORE_UNIT, '');
  t = t.replace(RE_CJK_THEN_LATIN, ' ');
  t = t.replace(RE_LATIN_THEN_CJK, ' ');
  // The two rules above can meet an existing space: collapse again.
  t = t.replace(/[ ]{2,}/g, ' ');
  return t.trim();
}

/**
 * Find `marker` in `text` as a standalone number run: not part of a longer
 * number, not a decimal. Returns the index, or -1.
 *
 * A dot on either side is only disqualifying when a digit sits on its far
 * side ("0.62", "62.5"). A citation legitimately follows the full stop of the
 * sentence it belongs to — "dementia.1-4" is the normal Vancouver form.
 */
function findMarker(text: string, marker: string, from: number): number {
  let at = from;
  while (at <= text.length - marker.length) {
    const i = text.indexOf(marker, at);
    if (i < 0) return -1;
    const end = i + marker.length;
    const before = i > 0 ? text[i - 1] : '';
    const beforeDot = i > 1 ? text[i - 2] : '';
    const after = end < text.length ? text[end] : '';
    const afterDot = end + 1 < text.length ? text[end + 1] : '';
    const partOfNumber =
      /\d/.test(before) ||
      /\d/.test(after) ||
      (before === '.' && /\d/.test(beforeDot)) ||
      (after === '.' && /\d/.test(afterDot)) ||
      after === '%';
    if (!partOfNumber) return i;
    at = i + 1;
  }
  return -1;
}

/**
 * Find the lowered run `marker` as the text directly following `anchor`, and
 * return where the marker itself starts (or -1).
 *
 * The anchor is what makes a subscript placeable at all: "p" on its own is a
 * letter the translation is full of, "np" is the identifier the source wrote.
 * Nothing is lowered when the anchor is not in the translation — models do
 * keep identifiers and formulas verbatim, and when one does not, the run
 * stays on the baseline instead of landing on the wrong character.
 */
function findAnchored(text: string, anchor: string, marker: string, from: number): number {
  const i = text.indexOf(anchor + marker, from);
  return i < 0 ? -1 : i + anchor.length;
}

/**
 * Split a translated string into ordinary, raised and lowered segments.
 *
 * Every run is looked for once, in the order the source had them, so a
 * document that cites "62" twice raises both and a paper that writes "np2"
 * three times lowers three p's. Raised and lowered runs share one "already
 * taken" list, so no character is claimed twice. A marker the model dropped
 * is simply not found — `appendMissingMarker` puts a trailing one back.
 */
export function splitScriptSegments(
  text: string,
  superscripts: readonly ScriptRun[],
  subscripts: readonly ScriptRun[] = [],
): InlineSegment[] {
  if ((superscripts.length === 0 && subscripts.length === 0) || !text) return text ? [{ text, sup: false }] : [];

  interface Hit {
    start: number;
    end: number;
    text: string;
    sup: boolean;
  }
  const hits: Hit[] = [];
  const taken: Array<[number, number]> = [];
  const free = (at: number, length: number): boolean => !taken.some(([s, e]) => at < e && at + length > s);

  // Lowered runs first: each is tied to its anchor, so it claims its own
  // characters before a bare exponent can take them ("np2" gives its "p" to
  // the subscript and its "2" to the superscript).
  for (const run of subscripts) {
    const marker = run.text;
    let from = 0;
    let at = -1;
    while (true) {
      at = findAnchored(text, run.anchor, marker, from);
      if (at < 0) break;
      if (free(at, marker.length)) break;
      from = at + 1;
    }
    if (at < 0) continue;
    taken.push([at, at + marker.length]);
    hits.push({ start: at, end: at + marker.length, text: marker, sup: false });
  }
  for (const run of superscripts) {
    const marker = normalizeMarker(run.text);
    if (!isCitationMarker(marker)) continue;
    // With its anchor first: an exponent belongs to the identifier it was set
    // on, so "np2" keeps its own "2" instead of taking the one of "F2,32"
    // earlier in the sentence. Without it (a citation whose word became
    // Chinese), the number alone still places the marker.
    let at = -1;
    for (const anchor of run.anchor ? [run.anchor, ''] : ['']) {
      let from = 0;
      while (true) {
        at = anchor ? findAnchored(text, anchor, marker, from) : findMarker(text, marker, from);
        if (at < 0) break;
        if (free(at, marker.length)) break;
        from = at + 1;
      }
      if (at >= 0) break;
    }
    if (at < 0) continue;
    taken.push([at, at + marker.length]);
    hits.push({ start: at, end: at + marker.length, text: marker, sup: true });
  }
  if (hits.length === 0) return [{ text, sup: false }];

  hits.sort((a, b) => a.start - b.start);
  const out: InlineSegment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) out.push({ text: text.slice(cursor, hit.start), sup: false });
    out.push(hit.sup ? { text: hit.text, sup: true } : { text: hit.text, sup: false, sub: true });
    cursor = hit.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), sup: false });
  return out;
}

/** Raised markers only, by their text: the plain citation path. */
export function splitSuperscriptSegments(text: string, markers: readonly string[]): InlineSegment[] {
  return splitScriptSegments(
    text,
    markers.map((text) => ({ text, anchor: '' })),
  );
}

/** Punctuation that stays tight against a raised run, whatever the source spacing was. */
const RE_TIGHT_AFTER_SUP = /^[,.;:!?%)\]}»”’、，。；：！？）〕］｝]/;

/**
 * Normalize the ordinary segments and tighten the joins around the raised
 * ones. `splitSuperscriptSegments` never emits two ordinary segments in a
 * row, so the only join to decide is "what follows a marker":
 *
 *  - nothing before a marker: the number sits against the word it cites
 *  - Chinese or punctuation after a marker: no space either
 *  - Latin text after a *raised* marker: one space, so "62 and" does not read
 *    "62and"; after a lowered one nothing, so H2O stays H2O
 *  - anything else the source separated with a space keeps it ("np2 = 0.38")
 */
export function normalizeSegments(segments: readonly InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  const isScript = (seg: InlineSegment | undefined): boolean => seg !== undefined && (seg.sup || seg.sub === true);
  for (const seg of segments) {
    if (seg.sup || seg.sub) {
      const prev = out[out.length - 1];
      if (prev && !isScript(prev)) prev.text = prev.text.replace(/[ ]+$/, '');
      out.push(seg.sup ? { text: seg.text, sup: true } : { text: seg.text, sup: false, sub: true });
      continue;
    }
    // normalizeInlineSpacing trims the ends of every run, so a space that
    // followed the raised one has to be put back: "np2 = 0.38" keeps its
    // space, "caregivers.62, and" keeps the comma tight.
    const hadSpace = /^[\s 　]/.test(seg.text);
    let t = normalizeInlineSpacing(seg.text);
    if (t.length === 0) continue;
    const prev = out[out.length - 1];
    // A raised marker is a word of its own, so Latin text after it needs a
    // space ("62 and"). A lowered one belongs to the letter it hangs off, so
    // "H2O" and "CO2" must stay tight and only a space the source itself had
    // comes back.
    const keepsSourceSpace = hadSpace && !RE_TIGHT_AFTER_SUP.test(t);
    if (prev?.sup ? /^[A-Za-z(]/.test(t) || keepsSourceSpace : prev?.sub === true && keepsSourceSpace) t = ` ${t}`;
    out.push({ text: t, sup: false });
  }
  return out;
}

/**
 * Put back a trailing citation marker the model dropped. Mirrors the footnote
 * marker rule of the renderer: the number belongs to the source, not to the
 * translation, so it is restored rather than invented.
 */
export function appendMissingMarker(segments: readonly InlineSegment[], marker: string | null): InlineSegment[] {
  if (!marker) return [...segments];
  if (segments.some((s) => s.sup && s.text === marker)) return [...segments];
  const out = segments.map((s) => ({ ...s }));
  const last = out[out.length - 1];
  if (last && !last.sup) last.text = last.text.replace(/[ ]+$/, '');
  out.push({ text: marker, sup: true });
  return out;
}

/** Plain text of a segment list (what the reports and the cache-neutral logs show). */
export function segmentsToText(segments: readonly InlineSegment[]): string {
  return segments.map((s) => s.text).join('');
}

/**
 * The whole inline pipeline for one translated unit: segment, normalize,
 * restore a dropped trailing marker.
 */
export function buildInlineSegments(
  translation: string,
  markers: readonly ScriptRun[],
  trailing: string | null = null,
  subscripts: readonly ScriptRun[] = [],
): InlineSegment[] {
  const split = splitScriptSegments(translation, markers, subscripts);
  const normalized = normalizeSegments(split);
  return appendMissingMarker(normalized, trailing);
}
