/**
 * Text-layer fidelity: put back the runs PDF.js merges away.
 *
 * `getTextContent()` joins neighbouring text runs into one item when their
 * baselines are close. The threshold is a share of the item width, and a
 * sub/superscript is a *small* vertical move, so it regularly loses:
 *
 *     showText "F"                                  10 pt, baseline 660.80
 *     setTextMatrix [6.48, 0, 0, 6.48, 354.6, 659.78]
 *     showText "1,16"                               6.5 pt, baseline 659.78   ← subscript
 *     setTextMatrix [10.02, 0, 0, 10.02, 367.6, 660.80]
 *     showText "= 6.75"
 *
 *   → one item "F1,16 = 6.75" at 10 pt, and with it the size and the baseline
 *     of the subscript. A superscript survives only because its rise is
 *     larger than the threshold.
 *
 * The information is still in the operator list, so this module reads the
 * runs from there and splits the merged items again. It is deliberately
 * conservative: a split happens only when the runs reproduce the item's text
 * exactly, so nothing can be lost, duplicated or reordered. Anything the
 * runs cannot account for keeps the item PDF.js produced.
 *
 * Nothing here knows about formulas, statistics or any particular string: a
 * run is a candidate because it is *smaller* than the item it sits in and its
 * baseline is shifted, which is what a sub- or superscript is.
 *
 * Pure functions, unit-tested in __tests__/textruns.test.ts.
 */

import * as pdfjsLib from 'pdfjs-dist';
import type { TextItemDebug } from './types';

const OPS = pdfjsLib.OPS;

/** One `showText` in user space: what PDF.js drew, where, and how big. */
export interface TextRun {
  text: string;
  /** Baseline origin (PDF user space, points). */
  x: number;
  y: number;
  /** Effective size in points (font size × matrix scale). */
  fontSize: number;
  /** Advance width in points. */
  width: number;
}

/** A run counts as a script when it is at most this share of the item's size. */
const SCRIPT_MAX_SIZE_RATIO = 0.85;
/** ...and its baseline moved by at least this share of the item's size. */
const SCRIPT_MIN_SHIFT_RATIO = 0.08;
/** Runs are only matched against an item that starts within this many points of them. */
const ORIGIN_TOLERANCE = 2;

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m × n`, PDF order (m applied first). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function asMatrix(value: unknown): Matrix | null {
  const a = value as ArrayLike<number> | null;
  if (!a || typeof a !== 'object' || a.length !== 6) return null;
  const m: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = a[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    m.push(v);
  }
  return m as Matrix;
}

/**
 * The matrix an operator carries. PDF.js passes `cm` as six numbers but
 * `Tm` as one Float32Array inside the argument list, so both shapes count.
 */
function matrixArg(args: unknown): Matrix | null {
  const direct = asMatrix(args);
  if (direct) return direct;
  return Array.isArray(args) && args.length === 1 ? asMatrix(args[0]) : null;
}

interface Glyph {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

function isGlyph(value: unknown): value is Glyph {
  return typeof value === 'object' && value !== null && 'unicode' in value;
}

interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

/**
 * Every `showText` of a page as a positioned run, in content-stream order.
 *
 * Only what a run needs is tracked: the CTM (save / restore / cm / form
 * XObjects), the text and line matrices, the font size, the rise and the
 * spacing parameters. Vertical writing and rotated text are left to the
 * caller — `fontSize` uses the same hypot() the extractor uses, so a rotated
 * page produces runs that simply never match an item and change nothing.
 */
export function collectTextRuns(opList: OperatorList): TextRun[] {
  const runs: TextRun[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let leading = 0;
  let rise = 0;

  const moveLine = (tx: number, ty: number) => {
    lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
    tm = lineMatrix;
  };

  const show = (glyphs: unknown) => {
    if (!Array.isArray(glyphs) || glyphs.length === 0) return;
    let text = '';
    let advance = 0;
    for (const g of glyphs) {
      if (typeof g === 'number') {
        advance -= (g / 1000) * fontSize * hScale;
        continue;
      }
      if (!isGlyph(g)) continue;
      const unicode = typeof g.unicode === 'string' ? g.unicode : '';
      text += unicode;
      const w = typeof g.width === 'number' ? g.width : 0;
      advance += ((w / 1000) * fontSize + charSpacing + (g.isSpace ? wordSpacing : 0)) * hScale;
    }
    if (text.length > 0) {
      const placed = multiply([fontSize * hScale, 0, 0, fontSize, 0, rise], multiply(tm, ctm));
      // `advance` is in text space; the same scale that turns the font size
      // into points turns it into a width on the page.
      const size = Math.hypot(placed[2], placed[3]);
      runs.push({
        text,
        x: placed[4],
        y: placed[5],
        fontSize: size,
        width: fontSize > 0 ? (advance * size) / fontSize : advance,
      });
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform: {
        const m = matrixArg(args);
        if (m) ctm = multiply(m, ctm);
        break;
      }
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const matrix = Array.isArray(args) ? asMatrix((args as unknown[])[0]) : null;
        if (matrix) ctm = multiply(matrix, ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.beginText:
        tm = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case OPS.setTextMatrix: {
        const m = matrixArg(args);
        if (m) {
          tm = m;
          lineMatrix = m;
        }
        break;
      }
      case OPS.setLeading:
        if (Array.isArray(args) && typeof args[0] === 'number') leading = args[0];
        break;
      case OPS.setLeadingMoveText:
        if (Array.isArray(args) && typeof args[0] === 'number' && typeof args[1] === 'number') {
          leading = -args[1];
          moveLine(args[0], args[1]);
        }
        break;
      case OPS.moveText:
        if (Array.isArray(args) && typeof args[0] === 'number' && typeof args[1] === 'number') moveLine(args[0], args[1]);
        break;
      case OPS.nextLine:
        moveLine(0, -leading);
        break;
      case OPS.setFont:
        if (Array.isArray(args) && typeof args[1] === 'number') fontSize = args[1];
        break;
      case OPS.setTextRise:
        if (Array.isArray(args) && typeof args[0] === 'number') rise = args[0];
        break;
      case OPS.setCharSpacing:
        if (Array.isArray(args) && typeof args[0] === 'number') charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        if (Array.isArray(args) && typeof args[0] === 'number') wordSpacing = args[0];
        break;
      case OPS.setHScale:
        if (Array.isArray(args) && typeof args[0] === 'number') hScale = args[0] / 100;
        break;
      case OPS.showText:
        show(Array.isArray(args) ? (args as unknown[])[0] : null);
        break;
      case OPS.nextLineShowText:
        moveLine(0, -leading);
        show(Array.isArray(args) ? (args as unknown[])[0] : null);
        break;
      case OPS.nextLineSetSpacingShowText:
        if (Array.isArray(args)) {
          if (typeof args[0] === 'number') wordSpacing = args[0];
          if (typeof args[1] === 'number') charSpacing = args[1];
          moveLine(0, -leading);
          show(args[2]);
        }
        break;
      default:
        break;
    }
  }
  return runs;
}

/** Characters that carry meaning for the alignment; PDF.js adds spaces of its own. */
function significant(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Runs indexed by the integer baseline they sit on, for the origin lookup. */
function indexByBaseline(runs: readonly TextRun[]): Map<number, number[]> {
  const index = new Map<number, number[]>();
  runs.forEach((run, i) => {
    const key = Math.round(run.y);
    const list = index.get(key);
    if (list) list.push(i);
    else index.set(key, [i]);
  });
  return index;
}

/**
 * Where the runs of `item` start: the first unconsumed run that begins at the
 * item's own origin. Looking the start up by position rather than walking a
 * cursor keeps every item independent — one item the runs cannot explain does
 * not take the rest of the page with it.
 */
function startOfItem(item: TextItemDebug, runs: readonly TextRun[], index: Map<number, number[]>, consumed: number): number {
  const base = Math.round(item.y);
  for (const key of [base, base - 1, base + 1]) {
    for (const i of index.get(key) ?? []) {
      if (i < consumed) continue;
      if (Math.abs(runs[i].x - item.x) > ORIGIN_TOLERANCE) continue;
      if (Math.abs(runs[i].y - item.y) > ORIGIN_TOLERANCE) continue;
      if (significant(runs[i].text).length === 0) continue;
      return i;
    }
  }
  return -1;
}

/**
 * Which runs make up `item`, or null when they cannot be matched with
 * certainty: the runs from `at` on have to reproduce the item's text exactly,
 * whitespace aside.
 */
function runsOfItem(item: TextItemDebug, runs: readonly TextRun[], at: number): { used: TextRun[]; next: number } | null {
  const wanted = significant(item.text);
  if (wanted.length === 0 || at < 0) return null;
  const used: TextRun[] = [];
  let seen = '';
  let i = at;
  while (i < runs.length && seen.length < wanted.length) {
    const run = runs[i];
    const piece = significant(run.text);
    if (piece.length > 0 && !wanted.startsWith(seen + piece)) return null;
    used.push(run);
    seen += piece;
    i++;
  }
  return seen === wanted ? { used, next: i } : null;
}

/** A run is a script of the item it sits in: clearly smaller, and off the baseline. */
function isScriptRun(run: TextRun, item: TextItemDebug): boolean {
  if (run.fontSize <= 0 || item.fontSize <= 0) return false;
  if (run.fontSize > SCRIPT_MAX_SIZE_RATIO * item.fontSize) return false;
  return Math.abs(run.y - item.y) >= SCRIPT_MIN_SHIFT_RATIO * item.fontSize;
}

/** One item per run, keeping everything the parent item carried. */
function itemOfRun(parent: TextItemDebug, run: TextRun, text: string): TextItemDebug {
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    ...parent,
    text,
    x: round(run.x),
    y: round(run.y),
    width: round(run.width),
    height: round(run.fontSize),
    fontSize: round(run.fontSize),
    transform: [run.fontSize, 0, 0, run.fontSize, run.x, run.y].map((v) => Math.round(v * 10000) / 10000),
  };
}

/**
 * Split the items PDF.js merged back into their runs, wherever a run is a
 * sub- or superscript of the item that swallowed it.
 *
 * An item is only touched when its runs reproduce its text exactly and at
 * least one of them is a script; everything else is passed through unchanged,
 * so a page whose operator list cannot be matched keeps the text layer it had.
 */
export function splitScriptRuns(items: readonly TextItemDebug[], runs: readonly TextRun[]): TextItemDebug[] {
  if (items.length === 0 || runs.length === 0) return [...items];
  const index = indexByBaseline(runs);
  const out: TextItemDebug[] = [];
  let consumed = 0;
  for (const item of items) {
    const match = runsOfItem(item, runs, startOfItem(item, runs, index, consumed));
    if (!match) {
      out.push(item);
      continue;
    }
    consumed = match.next;
    if (!match.used.some((run) => isScriptRun(run, item))) {
      out.push(item);
      continue;
    }
    // Hand the item's own characters back to the runs, in order. Whitespace
    // goes to the run that starts with it, and otherwise to the run before
    // it — which is where the spaces PDF.js inserts for a gap belong.
    const pieces = match.used.map((run) => ({ run, text: '', need: significant(run.text).length, leading: /^\s/.test(run.text) }));
    let piece = 0;
    let pending = '';
    for (const ch of item.text) {
      if (/\s/.test(ch)) {
        pending += ch;
        continue;
      }
      while (piece < pieces.length - 1 && pieces[piece].need === 0) piece++;
      const target = pieces[piece];
      if (pending) {
        const owner = target.leading || piece === 0 ? target : pieces[piece - 1];
        owner.text += pending;
        pending = '';
      }
      target.text += ch;
      if (target.need > 0) target.need--;
    }
    if (pending) pieces[pieces.length - 1].text += pending;
    if (pieces.map((p) => p.text).join('') !== item.text) {
      out.push(item); // should not happen; keep the original rather than risk a change
      continue;
    }
    for (const piece of pieces) {
      if (piece.text.length === 0) continue;
      out.push(itemOfRun(item, piece.run, piece.text));
    }
  }
  return out;
}
