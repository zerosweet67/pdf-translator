/**
 * Phase D: CJK-aware line wrapping and text fitting for the overlay renderer.
 *
 *  - tokenize: CJK characters break anywhere, Latin words / numbers / URLs /
 *    citations stay whole, CJK punctuation follows simple 禁則 rules.
 *  - wrapTokens: greedy line filling with real glyph widths.
 *  - fitTextToBox: shrink the font size step by step until the text fits,
 *    then allow a small downward extension, then report overflow.
 *  - fitTextToBoxes: the same for a merged unit whose text flows through
 *    several source blocks (column break, page break).
 *
 * Pure functions. The font is abstracted as a width measurer so the tests use
 * a fake; at runtime it is a pdf-lib PDFFont.
 */

import { GLYPH_ASCENT, GLYPH_DESCENT } from './layout';

export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number;
}

/** Baseline pitch relative to the font size. */
export const LINE_HEIGHT_RATIO = 1.3;
/** Font size decrement per fitting iteration (points). */
export const FONT_STEP = 0.5;
/** Hard lower bound for the font size (points). */
export const MIN_FONT_SIZE_ABS = 6;
/** Never shrink below this fraction of the original font size. */
export const MIN_FONT_SIZE_RATIO = 0.7;
/** A block may grow downward by at most this fraction of its height. */
export const MAX_EXTENSION_RATIO = 0.25;
const MAX_ITERATIONS = 80;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type TokenKind = 'cjk' | 'word' | 'space' | 'open' | 'close';

export interface Token {
  text: string;
  kind: TokenKind;
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

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

export interface WrapResult {
  lines: string[];
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
): WrapResult {
  const tokens = [...input];
  const widthCache = new Map<string, number>();
  const widthOf = (t: Token): number => {
    let w = widthCache.get(t.text);
    if (w === undefined) {
      w = font.widthOfTextAtSize(t.text, fontSize);
      widthCache.set(t.text, w);
    }
    return w;
  };

  interface Placed {
    token: Token;
    index: number;
  }

  const lines: string[] = [];
  let cur: Placed[] = [];
  let curWidth = 0;
  let i = 0;

  const pushLine = () => {
    while (cur.length && cur[cur.length - 1].token.kind === 'space') cur.pop();
    lines.push(cur.map((p) => p.token.text).join(''));
    cur = [];
    curWidth = 0;
  };
  const lastPlaced = (): Placed | undefined => cur[cur.length - 1];

  while (i < tokens.length && lines.length < maxLines) {
    const t = tokens[i];

    if (t.kind === 'space') {
      if (cur.length > 0 && curWidth + widthOf(t) <= maxWidth) {
        cur.push({ token: t, index: i });
        curWidth += widthOf(t);
      }
      i++;
      continue;
    }

    const w = widthOf(t);

    if (cur.length === 0 && w > maxWidth) {
      // Token wider than the whole line: split it by characters.
      const chars = [...t.text];
      if (chars.length > 1) {
        let chunk = chars[0];
        for (let k = 1; k < chars.length; k++) {
          if (font.widthOfTextAtSize(chunk + chars[k], fontSize) > maxWidth) break;
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

    if (curWidth + w <= maxWidth) {
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
  return { lines, rest };
}

/** Convenience: wrap a string with no line limit. */
export function wrapText(text: string, font: TextMeasurer, fontSize: number, maxWidth: number): string[] {
  return wrapTokens(tokenize(text), font, fontSize, maxWidth).lines;
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
}

export interface FitOptions extends BoxSpec {
  text: string;
  originalFontSize: number;
  font: TextMeasurer;
  minFontSize?: number;
}

export interface FitResult {
  lines: string[];
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
  const { text, width, height, originalFontSize, font } = options;
  const minFontSize = options.minFontSize ?? minimumFontSize(originalFontSize);
  const maxExtension = options.maxExtension ?? MAX_EXTENSION_RATIO * height;
  const tokens = tokenize(text);

  let fontSize = originalFontSize;
  let iterations = 0;
  let last: FitResult | null = null;

  while (true) {
    iterations++;
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const lines = wrapTokens(tokens, font, fontSize, width).lines;
    const totalHeight = textExtent(lines.length, fontSize, lineHeight);
    last = { lines, fontSize, lineHeight, totalHeight, fits: true, extended: false, overflow: 0, iterations, minFontSize };
    if (totalHeight <= height + 1e-6) return last;
    if (fontSize - FONT_STEP < minFontSize - 1e-9 || iterations >= MAX_ITERATIONS) break;
    fontSize = Math.round((fontSize - FONT_STEP) * 100) / 100;
  }

  if (last.totalHeight <= height + maxExtension + 1e-6) return { ...last, extended: true };
  return { ...last, fits: false, extended: maxExtension > 0, overflow: last.totalHeight - (height + maxExtension) };
}

export interface MultiFitPart {
  lines: string[];
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
  text: string,
  boxes: readonly BoxSpec[],
  originalFontSize: number,
  font: TextMeasurer,
  minFontSizeOverride?: number,
): MultiFitResult {
  if (boxes.length === 0) throw new Error('fitTextToBoxes needs at least one box');
  if (boxes.length === 1) {
    const r = fitTextToBox({ text, ...boxes[0], originalFontSize, font, minFontSize: minFontSizeOverride });
    return {
      fontSize: r.fontSize,
      lineHeight: r.lineHeight,
      parts: [{ lines: r.lines, totalHeight: r.totalHeight }],
      fits: r.fits,
      extended: r.extended,
      overflow: r.overflow,
      iterations: r.iterations,
      minFontSize: r.minFontSize,
    };
  }

  const minFontSize = minFontSizeOverride ?? minimumFontSize(originalFontSize);
  const tokens = tokenize(text);
  const lastBox = boxes[boxes.length - 1];
  const maxExtension = lastBox.maxExtension ?? MAX_EXTENSION_RATIO * lastBox.height;

  let fontSize = originalFontSize;
  let iterations = 0;
  let last: MultiFitResult | null = null;

  while (true) {
    iterations++;
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const parts: MultiFitPart[] = [];
    let rest: Token[] = tokens;
    let lastHeight = 0;
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k];
      const isLast = k === boxes.length - 1;
      const capacity = isLast ? Number.POSITIVE_INFINITY : maxLinesFor(box.height, fontSize, lineHeight);
      const r = wrapTokens(rest, font, fontSize, box.width, capacity);
      const totalHeight = textExtent(r.lines.length, fontSize, lineHeight);
      parts.push({ lines: r.lines, totalHeight });
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
