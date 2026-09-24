/**
 * Phase D: CJK-aware line wrapping and text fitting for the overlay renderer.
 *
 *  - tokenize: CJK characters break anywhere, Latin words / numbers / URLs /
 *    citations stay whole, CJK punctuation follows simple 禁則 rules.
 *  - tokenizeInline: the same over inline segments, so a raised citation
 *    marker is measured at its own (smaller) size and never separated from
 *    the word it cites.
 *  - wrapTokens: greedy line filling with real glyph widths, optionally with
 *    a first-line indent; it returns both the plain lines and the inline
 *    segments each line is made of.
 *  - fitTextToBox: shrink the font size step by step until the text fits,
 *    then allow a small downward extension, then report overflow.
 *  - fitTextToBoxes: the same for a merged unit whose text flows through
 *    several source blocks (column break, page break).
 *
 * Pure functions. The font is abstracted as a width measurer so the tests use
 * a fake; at runtime it is a pdf-lib PDFFont.
 */

import { GLYPH_ASCENT, GLYPH_DESCENT } from './layout';
import { superscriptSize, TYPOGRAPHY } from './typography';
import type { InlineSegment } from './types';

export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number;
}

// The numbers live in typography.ts so every layout constant sits in one
// place; these names are the long-standing public API of this module.
/** Baseline pitch relative to the font size. */
export const LINE_HEIGHT_RATIO = TYPOGRAPHY.fit.lineHeightRatio;
/** Font size decrement per fitting iteration (points). */
export const FONT_STEP = TYPOGRAPHY.fit.fontStep;
/** Hard lower bound for the font size (points). */
export const MIN_FONT_SIZE_ABS = TYPOGRAPHY.fit.minFontSizeAbs;
/** Never shrink below this fraction of the original font size. */
export const MIN_FONT_SIZE_RATIO = TYPOGRAPHY.fit.bodyMinRatio;
/** A block may grow downward by at most this fraction of its height. */
export const MAX_EXTENSION_RATIO = TYPOGRAPHY.fit.maxExtensionRatio;
const MAX_ITERATIONS = 80;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type TokenKind = 'cjk' | 'word' | 'space' | 'open' | 'close';

export interface Token {
  text: string;
  kind: TokenKind;
  /** Drawn smaller and raised: a citation marker (see typography.ts). */
  sup?: boolean;
  /** Drawn smaller and lowered: a subscript run (see typography.ts). */
  sub?: boolean;
}

/** Raised or lowered: either way the run is set at the script size. */
export function isScriptToken(t: { sup?: boolean; sub?: boolean }): boolean {
  return t.sup === true || t.sub === true;
}

/** Punctuation that must not start a line (行首禁則). */
const NO_LINE_START = new Set([
  ...'，。、；：？！）》」』】〉〕］｝〗〙〛％‰′″℃〜～…—‧・',
  ...',.;:?!)]}',
]);

/** Punctuation that must not end a line (行尾禁則). */
const NO_LINE_END = new Set([...'（《「『【〈〔［｛〖〘〚', ...'([{']);

const CJK_RE =
  /[⺀-⿟　-〿぀-ヿ㄀-ㄯ㆐-ㇿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/;

/** CJK ideographs, kana, bopomofo, CJK punctuation and fullwidth forms. */
export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

const isCjk = isCjkChar;

function isAscii(ch: string): boolean {
  return ch.charCodeAt(0) < 0x80;
}

/**
 * Split a translated string into wrap units.
 *
 *  - whitespace runs → one `space` token
 *  - CJK characters → one `cjk` token each
 *  - CJK closing punctuation → `close`; ASCII closers attached to a Latin
 *    word stay inside the word ("Models,", "[12]", "30%.")
 *  - CJK opening punctuation → `open`; ASCII openers start a Latin word
 *  - everything else (Latin letters, digits, URLs, "o1-preview", "GPT-4",
 *    "https://doi.org/…") → one `word` token per run
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  const flush = () => {
    if (word) {
      tokens.push({ text: word, kind: 'word' });
      word = '';
    }
  };

  for (const ch of text) {
    if (/\s/.test(ch)) {
      flush();
      if (tokens.length === 0 || tokens[tokens.length - 1].kind !== 'space') tokens.push({ text: ' ', kind: 'space' });
      continue;
    }
    if (NO_LINE_START.has(ch)) {
      if (word && isAscii(ch)) {
        word += ch;
        continue;
      }
      flush();
      tokens.push({ text: ch, kind: 'close' });
      continue;
    }
    if (NO_LINE_END.has(ch)) {
      flush();
      if (isAscii(ch)) {
        word = ch;
        continue;
      }
      tokens.push({ text: ch, kind: 'open' });
      continue;
    }
    if (isCjk(ch)) {
      flush();
      tokens.push({ text: ch, kind: 'cjk' });
      continue;
    }
    word += ch;
  }
  flush();
  return tokens;
}

/**
 * Tokenize inline segments (pdf/inline.ts). A superscript segment is kept as
 * ONE token whatever it contains, so "16,27-29" can never be broken across a
 * line, and it is tagged so every later width lookup uses the smaller script
 * size. A lowered run is tagged `sub` and handled the same way.
 */
export function tokenizeInline(segments: readonly InlineSegment[]): Token[] {
  const out: Token[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    if (seg.sup) {
      out.push({ text: seg.text, kind: 'word', sup: true });
      continue;
    }
    if (seg.sub) {
      out.push({ text: seg.text, kind: 'word', sub: true });
      continue;
    }
    out.push(...tokenize(seg.text));
  }
  return out;
}

/** Merge consecutive tokens of one line into as few inline segments as possible. */
function toSegments(tokens: readonly Token[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  for (const t of tokens) {
    const sup = t.sup === true;
    const sub = t.sub === true;
    const last = out[out.length - 1];
    if (last && last.sup === sup && (last.sub === true) === sub) last.text += t.text;
    else out.push(sub ? { text: t.text, sup, sub } : { text: t.text, sup });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

export interface WrapResult {
  lines: string[];
  /** The same lines split into ordinary and raised runs, in drawing order. */
  segmentLines: InlineSegment[][];
  /** Tokens not placed because `maxLines` was reached (empty otherwise). */
  rest: Token[];
}

/**
 * Greedy line filling.
 *
 *  - a `close` token that does not fit pulls the previous token down with it
 *    (a line never starts with 。，）…)
 *  - an `open` token never stays at the end of a line
 *  - spaces are dropped at line starts and line ends
 *  - a single token wider than the line (long URL) is split by characters
 *  - stops after `maxLines` and returns the unplaced tokens in `rest`
 */
export function wrapTokens(
  input: readonly Token[],
  font: TextMeasurer,
  fontSize: number,
  maxWidth: number,
  maxLines = Number.POSITIVE_INFINITY,
  firstLineIndent = 0,
): WrapResult {
  const tokens = [...input];
  const supSize = superscriptSize(fontSize);
  const widthCache = new Map<string, number>();
  const widthOf = (t: Token): number => {
    const script = isScriptToken(t);
    const key = script ? `\u0001${t.text}` : t.text;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = font.widthOfTextAtSize(t.text, script ? supSize : fontSize);
      widthCache.set(key, w);
    }
    return w;
  };

  interface Placed {
    token: Token;
    index: number;
  }

  const lines: string[] = [];
  const segmentLines: InlineSegment[][] = [];
  let cur: Placed[] = [];
  let curWidth = 0;
  let i = 0;

  /** The first line is shortened by the paragraph indent. */
  const lineWidth = () => Math.max(1, maxWidth - (lines.length === 0 ? Math.max(0, firstLineIndent) : 0));

  const pushLine = () => {
    while (cur.length && cur[cur.length - 1].token.kind === 'space') cur.pop();
    lines.push(cur.map((p) => p.token.text).join(''));
    segmentLines.push(toSegments(cur.map((p) => p.token)));
    cur = [];
    curWidth = 0;
  };
  const lastPlaced = (): Placed | undefined => cur[cur.length - 1];

  while (i < tokens.length && lines.length < maxLines) {
    const t = tokens[i];
    const maxWidthNow = lineWidth();

    if (t.kind === 'space') {
      if (cur.length > 0 && curWidth + widthOf(t) <= maxWidthNow) {
        cur.push({ token: t, index: i });
        curWidth += widthOf(t);
      }
      i++;
      continue;
    }

    const w = widthOf(t);

    if (cur.length === 0 && w > maxWidthNow) {
      // Token wider than the whole line: split it by characters. A raised
      // citation marker is never split: it stays one token so "16,27-29"
      // cannot be torn apart by a line break.
      const chars = t.sup ? [] : [...t.text];
      if (chars.length > 1) {
        let chunk = chars[0];
        for (let k = 1; k < chars.length; k++) {
          if (font.widthOfTextAtSize(chunk + chars[k], fontSize) > maxWidthNow) break;
          chunk += chars[k];
        }
        const remainder = t.text.slice(chunk.length);
        tokens.splice(i, 1, { text: chunk, kind: 'word' }, { text: remainder, kind: 'word' });
        continue;
      }
      cur.push({ token: t, index: i });
      curWidth += w;
      i++;
      continue;
    }

    if (curWidth + w <= maxWidthNow) {
      cur.push({ token: t, index: i });
      curWidth += w;
      i++;
      continue;
    }

    // The token does not fit on the current line.
    const last = lastPlaced();

    if (t.kind === 'close') {
      if (last && cur.length >= 2 && last.token.kind !== 'space' && last.token.kind !== 'open') {
        // Never start a line with closing punctuation: pull the previous token down.
        cur.pop();
        curWidth -= widthOf(last.token);
        pushLine();
        cur = [last];
        curWidth = widthOf(last.token);
      } else {
        cur.push({ token: t, index: i }); // hang the punctuation slightly past the edge
        curWidth += w;
        i++;
      }
      continue;
    }

    if (last && cur.length >= 2 && last.token.kind === 'open') {
      // Never end a line with opening punctuation: it moves down with the next token.
      cur.pop();
      curWidth -= widthOf(last.token);
      pushLine();
      cur = [last];
      curWidth = widthOf(last.token);
      continue;
    }
    if (last && cur.length === 1 && last.token.kind === 'open') {
      cur.push({ token: t, index: i });
      curWidth += w;
      i++;
      continue;
    }

    pushLine();
  }

  let restStart = i;
  if (cur.length > 0) {
    if (lines.length < maxLines) pushLine();
    else restStart = cur[0].index; // ran out of lines: give the pending tokens back
  }

  const rest = tokens.slice(restStart);
  while (rest.length && rest[0].kind === 'space') rest.shift();
  return { lines, segmentLines, rest };
}

/** Convenience: wrap a string with no line limit. */
export function wrapText(text: string, font: TextMeasurer, fontSize: number, maxWidth: number): string[] {
  return wrapTokens(tokenize(text), font, fontSize, maxWidth).lines;
}

/** Width of one wrapped line, script runs measured at the smaller script size. */
export function measureSegments(segments: readonly InlineSegment[], font: TextMeasurer, fontSize: number): number {
  const supSize = superscriptSize(fontSize);
  let width = 0;
  for (const seg of segments) width += font.widthOfTextAtSize(seg.text, isScriptToken(seg) ? supSize : fontSize);
  return width;
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

/** Vertical extent of `lineCount` lines: first ascender to last descender. */
export function textExtent(lineCount: number, fontSize: number, lineHeight: number): number {
  if (lineCount <= 0) return 0;
  return (lineCount - 1) * lineHeight + fontSize * (GLYPH_ASCENT + GLYPH_DESCENT);
}

/** How many lines fit into `height` (always at least 1). */
export function maxLinesFor(height: number, fontSize: number, lineHeight: number): number {
  const first = fontSize * (GLYPH_ASCENT + GLYPH_DESCENT);
  if (height <= first) return 1;
  return Math.floor((height - first) / lineHeight + 1e-6) + 1;
}

export function minimumFontSize(originalFontSize: number): number {
  return Math.min(originalFontSize, Math.max(MIN_FONT_SIZE_ABS, originalFontSize * MIN_FONT_SIZE_RATIO));
}

export interface BoxSpec {
  width: number;
  height: number;
  /** Extra height allowed below the box, in points. Defaults to MAX_EXTENSION_RATIO × height. */
  maxExtension?: number;
  /** First-line indent of THIS box, in points (paragraph.ts / typography.ts). */
  firstLineIndent?: number;
}

export interface FitOptions extends BoxSpec {
  /** Plain text; ignored when `segments` is given. */
  text?: string;
  /** Inline segments (raised citation markers); preferred over `text`. */
  segments?: readonly InlineSegment[];
  originalFontSize: number;
  font: TextMeasurer;
  minFontSize?: number;
  /** Baseline pitch as a multiple of the font size; defaults to LINE_HEIGHT_RATIO. */
  lineHeightRatio?: number;
}

export interface FitResult {
  lines: string[];
  /** The same lines as inline runs, for the renderer. */
  segmentLines: InlineSegment[][];
  fontSize: number;
  lineHeight: number;
  /** Extent of the wrapped text at the chosen size. */
  totalHeight: number;
  /** True when the text fits into the box, possibly using the extension. */
  fits: boolean;
  /** True when the extension below the box was needed. */
  extended: boolean;
  /** Points by which the text still exceeds box + extension (0 when it fits). */
  overflow: number;
  iterations: number;
  minFontSize: number;
}

/**
 * Shrink from `originalFontSize` in FONT_STEP decrements until the wrapped
 * text fits `height`. At the minimum size, allow the extension; if even that
 * is not enough, return the minimum-size layout with `fits: false` so the
 * caller can still write everything and raise a warning. Text is never cut.
 */
export function fitTextToBox(options: FitOptions): FitResult {
  const { width, height, originalFontSize, font } = options;
  const minFontSize = options.minFontSize ?? minimumFontSize(originalFontSize);
  const maxExtension = options.maxExtension ?? MAX_EXTENSION_RATIO * height;
  const ratio = options.lineHeightRatio ?? LINE_HEIGHT_RATIO;
  const indent = options.firstLineIndent ?? 0;
  const tokens = options.segments ? tokenizeInline(options.segments) : tokenize(options.text ?? '');

  let fontSize = originalFontSize;
  let iterations = 0;
  let last: FitResult | null = null;

  while (true) {
    iterations++;
    const lineHeight = fontSize * ratio;
    const wrapped = wrapTokens(tokens, font, fontSize, width, Number.POSITIVE_INFINITY, indent);
    const lines = wrapped.lines;
    const totalHeight = textExtent(lines.length, fontSize, lineHeight);
    last = {
      lines,
      segmentLines: wrapped.segmentLines,
      fontSize,
      lineHeight,
      totalHeight,
      fits: true,
      extended: false,
      overflow: 0,
      iterations,
      minFontSize,
    };
    if (totalHeight <= height + 1e-6) return last;
    if (fontSize - FONT_STEP < minFontSize - 1e-9 || iterations >= MAX_ITERATIONS) break;
    fontSize = Math.round((fontSize - FONT_STEP) * 100) / 100;
  }

  if (last.totalHeight <= height + maxExtension + 1e-6) return { ...last, extended: true };
  return { ...last, fits: false, extended: maxExtension > 0, overflow: last.totalHeight - (height + maxExtension) };
}

export interface MultiFitPart {
  lines: string[];
  segmentLines: InlineSegment[][];
  totalHeight: number;
}

export interface MultiFitResult {
  fontSize: number;
  lineHeight: number;
  /** One entry per box, in order. Earlier boxes are filled to capacity. */
  parts: MultiFitPart[];
  fits: boolean;
  extended: boolean;
  overflow: number;
  iterations: number;
  minFontSize: number;
}

/**
 * Flow one translation through several boxes (a merged unit). Each box except
 * the last is filled up to its line capacity, mirroring how the English
 * paragraph originally filled the column before continuing; the remainder
 * goes into the last box, which gets the shrink → extension → warning
 * treatment of fitTextToBox. All boxes share one font size.
 */
export function fitTextToBoxes(
  content: string | readonly InlineSegment[],
  boxes: readonly BoxSpec[],
  originalFontSize: number,
  font: TextMeasurer,
  minFontSizeOverride?: number,
  lineHeightRatio?: number,
): MultiFitResult {
  if (boxes.length === 0) throw new Error('fitTextToBoxes needs at least one box');
  const segments = typeof content === 'string' ? undefined : content;
  const text = typeof content === 'string' ? content : undefined;
  const ratio = lineHeightRatio ?? LINE_HEIGHT_RATIO;

  if (boxes.length === 1) {
    const r = fitTextToBox({
      text,
      segments,
      ...boxes[0],
      originalFontSize,
      font,
      minFontSize: minFontSizeOverride,
      lineHeightRatio: ratio,
    });
    return {
      fontSize: r.fontSize,
      lineHeight: r.lineHeight,
      parts: [{ lines: r.lines, segmentLines: r.segmentLines, totalHeight: r.totalHeight }],
      fits: r.fits,
      extended: r.extended,
      overflow: r.overflow,
      iterations: r.iterations,
      minFontSize: r.minFontSize,
    };
  }

  const minFontSize = minFontSizeOverride ?? minimumFontSize(originalFontSize);
  const tokens = segments ? tokenizeInline(segments) : tokenize(text ?? '');
  const lastBox = boxes[boxes.length - 1];
  const maxExtension = lastBox.maxExtension ?? MAX_EXTENSION_RATIO * lastBox.height;

  let fontSize = originalFontSize;
  let iterations = 0;
  let last: MultiFitResult | null = null;

  while (true) {
    iterations++;
    const lineHeight = fontSize * ratio;
    const parts: MultiFitPart[] = [];
    let rest: Token[] = tokens;
    let lastHeight = 0;
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k];
      const isLast = k === boxes.length - 1;
      const capacity = isLast ? Number.POSITIVE_INFINITY : maxLinesFor(box.height, fontSize, lineHeight);
      const r = wrapTokens(rest, font, fontSize, box.width, capacity, box.firstLineIndent ?? 0);
      const totalHeight = textExtent(r.lines.length, fontSize, lineHeight);
      parts.push({ lines: r.lines, segmentLines: r.segmentLines, totalHeight });
      rest = r.rest;
      if (isLast) lastHeight = totalHeight;
    }
    last = { fontSize, lineHeight, parts, fits: true, extended: false, overflow: 0, iterations, minFontSize };
    if (lastHeight <= lastBox.height + 1e-6) return last;
    if (fontSize - FONT_STEP < minFontSize - 1e-9 || iterations >= MAX_ITERATIONS) break;
    fontSize = Math.round((fontSize - FONT_STEP) * 100) / 100;
  }

  const lastHeight = last.parts[last.parts.length - 1].totalHeight;
  if (lastHeight <= lastBox.height + maxExtension + 1e-6) return { ...last, extended: true };
  return { ...last, fits: false, extended: maxExtension > 0, overflow: lastHeight - (lastBox.height + maxExtension) };
}
