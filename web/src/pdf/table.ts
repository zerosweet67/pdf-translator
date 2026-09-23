/**
 * Table cells: the text items of a detected table become logical cells.
 *
 *   raw text items of one table
 *     → baseline rows (superscript markers stay with their row)
 *     → fragments (items separated by a wide gap on one row)
 *     → column bands from the x-projection of the data rows
 *     → fragment → column assignment (spanning headers cover several bands)
 *     → wrapped lines of one cell merged across rows
 *     → one TableCellInfo per logical cell: text, usable rectangle, alignment
 *
 * Also here, because they are table-only rules the renderer must not share
 * with paragraphs:
 *   - isNumericTableCell(): cells that are never translated
 *   - tableCellMaskRects(): masks limited to the cell interior (rules survive)
 *   - fitTextToTableCell(): wrap → tighter line height → smaller font, never
 *     below TABLE_MIN_FONT_SIZE, never extending below the cell
 *   - placeTableCellLines(): where each translated line goes inside the cell
 *
 * Pure functions, unit-tested in __tests__/table.test.ts. Tables are found by
 * classify.ts (caption → TABLE blocks); this module only reorganises their items.
 */

import { isNumericOnly } from './classify';
import { textExtent, tokenize, wrapTokens, type TextMeasurer } from './fit';
import { GLYPH_ASCENT, GLYPH_DESCENT } from './layout';
import { analyzeCompleteness, joinLines } from './text';
import type { CellAlignment, FilledRect, Rect, RuleLine, TableCellInfo, TextItemDebug } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Items whose baselines differ by less than this × fontSize share a row. */
const ROW_BASELINE_TOLERANCE = 0.5;
/** A horizontal gap above this × row font size separates two fragments (cells) on one row. */
const FRAGMENT_GAP = 0.75;
/** A gap wider than this × fontSize between items becomes a space. */
const WORD_GAP = 0.12;
/** Column bands are separated by an empty x-gap at least this wide (points, or × font size). */
const MIN_COLUMN_GAP_PT = 3;
const MIN_COLUMN_GAP_RATIO = 0.35;
/** Superscript: this much smaller than the row font and raised by at least SUPERSCRIPT_RAISE × row font. */
const SUPERSCRIPT_SIZE = 0.8;
const SUPERSCRIPT_RAISE = 0.12;
/** Wrapped lines of one cell: baseline pitch at most this × font size. */
const WRAP_PITCH_MAX = 1.6;
/** Header zone: same column set and this tight a pitch means one wrapped header cell. */
const HEADER_TIGHT_PITCH = 1.25;
/** Wrapped continuation lines are left-aligned or indented by up to this × font size. */
const WRAP_ALIGN_TOLERANCE = 3;
/** Hanging indent of a continuation line, × font size. */
const HANGING_INDENT_MIN = 0.4;
/** Distance kept from a table rule (points). */
export const BORDER_CLEARANCE = 1;
/** Distance kept from the midpoint between two rows / columns without a rule (points). */
export const NEIGHBOUR_CLEARANCE = 0.5;
/** Horizontal padding inside the column bounds (points). */
export const CELL_PAD_X = 1;
/** Room above / below the text of a cell that has no neighbour or rule on that side, × font size. */
const OPEN_SIDE_ROOM = 0.3;
/** Mask padding around each source line (points), before clipping to the cell interior. */
export const TABLE_MASK_PAD = 0.5;
/**
 * A fill is reused as the mask colour only when black text stays readable on
 * it: every channel at least this (0–255) and relative luminance at least
 * BACKGROUND_MIN_LUMINANCE. Darker fills (a black header bar) get a white mask.
 */
const BACKGROUND_MIN_CHANNEL = 0x60;
const BACKGROUND_MIN_LUMINANCE = 0.45;

/** Table-only fitting: starting line height, tighter fallback, font step and floor. */
export const TABLE_LINE_HEIGHT_RATIO = 1.15;
export const TABLE_LINE_HEIGHT_TIGHT = 1.08;
export const TABLE_FONT_STEP = 0.25;
export const TABLE_MIN_FONT_SIZE = 5;
/** Footnote markers are drawn at this fraction of the cell font size, raised by MARKER_RAISE × size. */
export const MARKER_SCALE = 0.65;
export const MARKER_RAISE = 0.33;
/** A line may exceed the usable width by this much (points): rounding and hanging punctuation. */
const WIDTH_TOLERANCE = 0.3;
const MAX_FIT_ITERATIONS = 200;

// ---------------------------------------------------------------------------
// Numeric cells
// ---------------------------------------------------------------------------

/** Placeholder tokens common in statistical tables ("—", "NA", "NR", "Ref"). */
const PLACEHOLDER_RE = /^(?:[-–—―.…]+|NA|N\/A|n\/a|NR|ND|NS|ns|n\.s\.|NE|NC|Ref\.?|REF)$/;
/** A number (with %, ±, ranges, brackets, p / n tokens) followed by a short unit ("85.9 y", "12 mo", "3.5 kg"). */
const NUMBER_WITH_UNIT_RE = /^[<>≤≥≈~]?\s*[-–−+]?\d[\d.,]*(?:\s*[-–−–—±×x/]\s*\d[\d.,]*)*\s*%?\s*(?:\([^()]*\)|\[[^[\]]*\])?\s*[A-Za-zµμ]{1,2}$/;

/**
 * Cells that carry no translatable language: numbers, percentages, ranges,
 * "n = 590", p-values, ± values, missing counts, dashes and the usual table
 * placeholders. Footnote markers attached to a number ("12.3ᵃ", "0*") do not
 * change the verdict.
 */
export function isNumericTableCell(text: string): boolean {
  const t = text.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (isNumericOnly(t)) return true;
  if (PLACEHOLDER_RE.test(t)) return true;
  // trailing footnote marker after a number: "0.5a", "12 (3.1)b", "389†"
  const stripped = t.replace(/[a-e*†‡§¶#ᵃᵇᶜᵈᵉ]{1,2}$/, '').trim();
  if (stripped !== t && stripped.length > 0 && isNumericOnly(stripped)) return true;
  if (NUMBER_WITH_UNIT_RE.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Internal structures
// ---------------------------------------------------------------------------

export interface TableItemRef {
  /** Position in PdfAnalysis.items (stable id for sourceItemIds). */
  index: number;
  item: TextItemDebug;
}

/** Text items of one row separated from their neighbours by a wide gap: one visual cell line. */
export interface Fragment {
  text: string;
  x: number;
  right: number;
  /** Baseline. */
  y: number;
  top: number;
  bottom: number;
  fontSize: number;
  fontName: string;
  fontRealName: string | null;
  items: TableItemRef[];
  /** Superscript marker(s) at the end of the fragment ("d", "d,e"), kept out of the text. */
  trailingMarker: string | null;
  rowIndex: number;
  colStart: number;
  colEnd: number;
}

interface Row {
  index: number;
  /** Baseline of the dominant text. */
  y: number;
  fontSize: number;
  fragments: Fragment[];
}

interface Band {
  left: number;
  right: number;
}

/** A logical cell before its geometry is final. */
interface CellDraft {
  fragments: Fragment[];
  rows: number[];
  colStart: number;
  colEnd: number;
  text: string;
  trailingMarker: string | null;
}

export interface ResolvedCell {
  info: TableCellInfo;
  text: string;
  /** One entry per source line (fragment) of the cell, top to bottom. */
  fragments: Fragment[];
}

export interface TableInput {
  page: number;
  tableId: number;
  items: TableItemRef[];
  rules: readonly RuleLine[];
  fills: readonly FilledRect[];
}

export type TableBuildResult =
  | { ok: true; cells: ResolvedCell[]; rows: number; columns: number }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Rows and fragments
// ---------------------------------------------------------------------------

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function itemRight(item: TextItemDebug): number {
  return item.x + item.width;
}

function dominantFontSize(items: readonly TextItemDebug[]): number {
  const weights = new Map<number, number>();
  for (const it of items) {
    const key = Math.round(it.fontSize * 4) / 4;
    weights.set(key, (weights.get(key) ?? 0) + Math.max(1, it.text.trim().length));
  }
  let best = items[0]?.fontSize ?? 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && size > best)) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Cluster items by baseline (items of different rows never mix; a raised superscript stays with its row). */
function clusterRows(refs: readonly TableItemRef[]): TableItemRef[][] {
  const sorted = [...refs].sort((a, b) => b.item.y - a.item.y || a.item.x - b.item.x);
  const rows: TableItemRef[][] = [];
  let current: TableItemRef[] = [];
  let refY = 0;
  let refFs = 0;
  for (const ref of sorted) {
    const it = ref.item;
    if (current.length === 0) {
      current = [ref];
      refY = it.y;
      refFs = it.fontSize;
      continue;
    }
    const tol = ROW_BASELINE_TOLERANCE * Math.max(refFs, it.fontSize);
    if (Math.abs(refY - it.y) <= tol) {
      current.push(ref);
      if (it.text.trim().length > 2 && it.fontSize >= refFs) {
        refY = it.y;
        refFs = it.fontSize;
      }
    } else {
      rows.push(current);
      current = [ref];
      refY = it.y;
      refFs = it.fontSize;
    }
  }
  if (current.length) rows.push(current);
  return rows;
}

function isSuperscript(item: TextItemDebug, rowY: number, rowFs: number): boolean {
  return item.fontSize <= SUPERSCRIPT_SIZE * rowFs && item.y - rowY >= SUPERSCRIPT_RAISE * rowFs && item.text.trim().length <= 3;
}

function makeFragment(refs: TableItemRef[], rowIndex: number, rowY: number, rowFs: number): Fragment {
  const sorted = [...refs].sort((a, b) => a.item.x - b.item.x);
  // Trailing superscripts become the footnote marker; other superscripts stay inline.
  let end = sorted.length;
  while (end > 1 && isSuperscript(sorted[end - 1].item, rowY, rowFs)) end--;
  const body = sorted.slice(0, end);
  const markerItems = sorted.slice(end);
  let text = '';
  for (let i = 0; i < body.length; i++) {
    const it = body[i].item;
    if (i > 0) {
      const prev = body[i - 1].item;
      const gap = it.x - itemRight(prev);
      const fs = Math.max(prev.fontSize, it.fontSize, 1);
      const superscript = isSuperscript(it, rowY, rowFs) || isSuperscript(prev, rowY, rowFs);
      if (!superscript && gap > WORD_GAP * fs && !/\s$/.test(text) && !/^\s/.test(it.text)) text += ' ';
    }
    text += it.text;
  }
  const bodyItems = body.map((r) => r.item);
  const fontItem = bodyItems.reduce((a, b) => (b.text.trim().length > a.text.trim().length ? b : a), bodyItems[0]);
  const all = sorted.map((r) => r.item);
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    x: round(Math.min(...all.map((i) => i.x))),
    right: round(Math.max(...all.map(itemRight))),
    y: round(fontItem.y),
    top: round(Math.max(...all.map((i) => i.y + GLYPH_ASCENT * i.fontSize))),
    bottom: round(Math.min(...all.map((i) => i.y - GLYPH_DESCENT * i.fontSize))),
    fontSize: dominantFontSize(bodyItems),
    fontName: fontItem.fontName,
    fontRealName: fontItem.fontRealName,
    items: sorted,
    trailingMarker: markerItems.length ? markerItems.map((r) => r.item.text.trim()).join('') || null : null,
    rowIndex,
    colStart: -1,
    colEnd: -1,
  };
}

function buildRows(refs: readonly TableItemRef[]): Row[] {
  const rows: Row[] = [];
  clusterRows(refs).forEach((cluster, index) => {
    const items = cluster.map((r) => r.item);
    const rowFs = dominantFontSize(items);
    const main = items.filter((i) => i.fontSize >= SUPERSCRIPT_SIZE * rowFs);
    const rowY = median((main.length ? main : items).map((i) => i.y));
    const byX = [...cluster].sort((a, b) => a.item.x - b.item.x);
    const fragments: Fragment[] = [];
    let run: TableItemRef[] = [];
    let runRight = -Infinity;
    for (const ref of byX) {
      const gap = ref.item.x - runRight;
      if (run.length > 0 && gap > FRAGMENT_GAP * rowFs) {
        fragments.push(makeFragment(run, index, rowY, rowFs));
        run = [];
      }
      run.push(ref);
      runRight = Math.max(runRight, itemRight(ref.item));
    }
    if (run.length) fragments.push(makeFragment(run, index, rowY, rowFs));
    rows.push({ index, y: rowY, fontSize: rowFs, fragments });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Column bands from the x-projection of the rows that have the most
 * fragments (data rows): a spanning header or a section label in the label
 * column never bridges two data columns. Returns fewer than 2 bands when the
 * table has no column structure.
 */
function detectBands(rows: readonly Row[]): Band[] {
  const counts = rows.map((r) => r.fragments.length);
  const threshold = Math.max(2, median(counts));
  const candidates = rows.filter((r) => r.fragments.length >= threshold);
  if (candidates.length === 0) return [];
  const fs = median(candidates.map((r) => r.fontSize)) || 10;
  const minGap = Math.max(MIN_COLUMN_GAP_PT, MIN_COLUMN_GAP_RATIO * fs);
  const intervals = candidates
    .flatMap((r) => r.fragments.map((f) => ({ left: f.x, right: f.right })))
    .sort((a, b) => a.left - b.left);
  const bands: Band[] = [];
  for (const iv of intervals) {
    const last = bands[bands.length - 1];
    if (last && iv.left - last.right < minGap) last.right = Math.max(last.right, iv.right);
    else bands.push({ left: iv.left, right: iv.right });
  }
  return bands;
}

/** Columns a fragment covers: every band it overlaps by a meaningful amount, else the nearest band. */
function assignColumns(fragment: Fragment, bands: readonly Band[]): void {
  const width = fragment.right - fragment.x;
  let first = -1;
  let last = -1;
  for (let c = 0; c < bands.length; c++) {
    const b = bands[c];
    const overlap = Math.min(fragment.right, b.right) - Math.max(fragment.x, b.left);
    const needed = Math.max(1.5, 0.15 * Math.min(width, b.right - b.left));
    if (overlap >= needed) {
      if (first < 0) first = c;
      last = c;
    }
  }
  if (first < 0) {
    const center = (fragment.x + fragment.right) / 2;
    let best = 0;
    let bestDist = Infinity;
    bands.forEach((b, c) => {
      const d = center < b.left ? b.left - center : center > b.right ? center - b.right : 0;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    });
    first = last = best;
  }
  fragment.colStart = first;
  fragment.colEnd = last;
}

/** Fragments of one row that landed in the same column range are one visual line (over-split by a wide word gap). */
function mergeSameColumn(row: Row): void {
  const merged: Fragment[] = [];
  for (const f of [...row.fragments].sort((a, b) => a.x - b.x)) {
    const prev = merged[merged.length - 1];
    if (prev && prev.colStart === f.colStart && prev.colEnd === f.colEnd) {
      const items = [...prev.items, ...f.items];
      const combined = makeFragment(items, row.index, row.y, row.fontSize);
      combined.colStart = prev.colStart;
      combined.colEnd = prev.colEnd;
      merged[merged.length - 1] = combined;
      continue;
    }
    merged.push(f);
  }
  row.fragments = merged;
}

// ---------------------------------------------------------------------------
// Wrapped lines → cells
// ---------------------------------------------------------------------------

/** First row that looks like a data row (several fragments, at least one numeric); rows above it are headers. */
function findFirstDataRow(rows: readonly Row[]): number {
  for (const row of rows) {
    if (row.fragments.length >= 2 && row.fragments.some((f) => isNumericTableCell(f.text))) return row.index;
  }
  return 0;
}

function columnsOf(row: Row): Set<number> {
  const set = new Set<number>();
  for (const f of row.fragments) for (let c = f.colStart; c <= f.colEnd; c++) set.add(c);
  return set;
}

/** Row `a` lacks at least one column that row `b` fills. */
function missesColumnsOf(a: Row, b: Row): boolean {
  const cols = columnsOf(a);
  for (const c of columnsOf(b)) if (!cols.has(c)) return true;
  return false;
}

function sameColumnSet(a: Row, b: Row): boolean {
  const ca = columnsOf(a);
  const cb = columnsOf(b);
  if (ca.size !== cb.size) return false;
  for (const c of ca) if (!cb.has(c)) return false;
  return true;
}

function startsContinuation(text: string): boolean {
  return /^[a-z(\[]/.test(text.trimStart());
}

function endsIncomplete(text: string): boolean {
  const c = analyzeCompleteness(text);
  return !c.complete && c.strong;
}

/** Rules this far above a baseline (× font size) and below the baseline above it lie between the two rows. */
const RULE_ABOVE_BASELINE = 0.55;
const RULE_BELOW_BASELINE = 0.2;

/** A horizontal rule between two baselines, crossing the x-range: separate cells. */
function ruleBetween(rules: readonly RuleLine[], upper: Fragment, lower: Fragment): boolean {
  const left = Math.min(upper.x, lower.x);
  const right = Math.max(upper.right, lower.right);
  const lo = lower.y + RULE_ABOVE_BASELINE * lower.fontSize;
  const hi = upper.y - RULE_BELOW_BASELINE * upper.fontSize;
  return rules.some((r) => r.orientation === 'horizontal' && r.y0 > lo && r.y0 < hi && r.x1 > left && r.x0 < right);
}

function aligned(cell: CellDraft, f: Fragment): boolean {
  const first = cell.fragments[0];
  const last = cell.fragments[cell.fragments.length - 1];
  const fs = Math.max(first.fontSize, f.fontSize);
  const leftDiff = f.x - first.x;
  const centerDiff = Math.abs((f.x + f.right) / 2 - (last.x + last.right) / 2);
  const rightDiff = Math.abs(f.right - last.right);
  return (leftDiff >= -0.5 * fs && leftDiff <= WRAP_ALIGN_TOLERANCE * fs) || centerDiff <= 1.5 * fs || rightDiff <= 1.5 * fs;
}

/**
 * Should `f` (row r) continue `cell` (whose last line is on row r-1)?
 *
 *  - never across a rule, never beyond WRAP_PITCH_MAX, never a numeric cell
 *    (except a parenthesised "(n = 590)" under a header)
 *  - header zone: a lowercase / "(" start, an incomplete previous line, or a
 *    very tight pitch with the same column set
 *  - body zone: the continuation row (or the row it continues) must be a
 *    partial row that leaves data columns empty, plus a lowercase / "(" start,
 *    an incomplete previous line, or a hanging indent
 */
function continuesCell(
  cell: CellDraft,
  f: Fragment,
  row: Row,
  prevRow: Row,
  headerZone: boolean,
  rules: readonly RuleLine[],
  columnCount: number,
): boolean {
  const last = cell.fragments[cell.fragments.length - 1];
  const fs = Math.max(last.fontSize, f.fontSize);
  if (last.y - f.y > WRAP_PITCH_MAX * fs) return false;
  if (ruleBetween(rules, last, f)) return false;
  if (!aligned(cell, f)) return false;
  const numericNext = isNumericTableCell(f.text);
  const numericPrev = isNumericTableCell(cell.text);
  if (numericPrev) return false;
  if (numericNext && !(headerZone && /^[([]/.test(f.text))) return false;

  const textSignal = startsContinuation(f.text) || endsIncomplete(cell.text);
  if (headerZone) {
    return textSignal || (sameColumnSet(row, prevRow) && last.y - f.y <= HEADER_TIGHT_PITCH * fs);
  }
  // A wrapped line leaves data columns empty on its row (or the row it continues does).
  const rowPartial = columnsOf(row).size < columnCount;
  const prevPartial = columnsOf(prevRow).size < columnCount;
  if (!rowPartial && !prevPartial) return false;
  const indent = f.x - cell.fragments[0].x;
  const hanging = indent >= HANGING_INDENT_MIN * fs && indent <= WRAP_ALIGN_TOLERANCE * fs && rowPartial && !missesColumnsOf(prevRow, row);
  return textSignal || hanging;
}

function buildCells(rows: readonly Row[], firstDataRow: number, rules: readonly RuleLine[], columnCount: number): CellDraft[] {
  const cells: CellDraft[] = [];
  let open = new Map<string, CellDraft>();
  let prevRow: Row | null = null;
  for (const row of rows) {
    const next = new Map<string, CellDraft>();
    const headerZone = row.index < firstDataRow;
    for (const f of row.fragments) {
      const key = `${f.colStart}-${f.colEnd}`;
      const candidate = prevRow ? open.get(key) : undefined;
      if (candidate && prevRow && continuesCell(candidate, f, row, prevRow, headerZone, rules, columnCount)) {
        if (candidate.trailingMarker) candidate.text += candidate.trailingMarker; // an earlier marker becomes inline
        candidate.fragments.push(f);
        candidate.rows.push(row.index);
        candidate.text = joinLines([candidate.text, f.text]);
        candidate.trailingMarker = f.trailingMarker;
        next.set(key, candidate);
        continue;
      }
      const cell: CellDraft = {
        fragments: [f],
        rows: [row.index],
        colStart: f.colStart,
        colEnd: f.colEnd,
        text: f.text,
        trailingMarker: f.trailingMarker,
      };
      cells.push(cell);
      next.set(key, cell);
    }
    open = next;
    prevRow = row;
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function textBoxOf(fragments: readonly Fragment[]): Rect {
  const x = Math.min(...fragments.map((f) => f.x));
  const right = Math.max(...fragments.map((f) => f.right));
  const top = Math.max(...fragments.map((f) => f.top));
  const bottom = Math.min(...fragments.map((f) => f.bottom));
  return { x: round(x), y: round(bottom), width: round(right - x), height: round(top - bottom) };
}

interface ColumnBounds {
  left: number;
  right: number;
}

/** Column bounds: midpoint of the gap to the neighbouring band, or a vertical rule in that gap (plus clearance). */
function columnBounds(
  colStart: number,
  colEnd: number,
  bands: readonly Band[],
  rules: readonly RuleLine[],
  tableLeft: number,
  tableRight: number,
  yRange: { top: number; bottom: number },
): ColumnBounds {
  const verticalIn = (lo: number, hi: number): RuleLine | null => {
    let best: RuleLine | null = null;
    for (const r of rules) {
      if (r.orientation !== 'vertical' || r.x0 <= lo || r.x0 >= hi) continue;
      if (r.y1 < yRange.bottom || r.y0 > yRange.top) continue;
      if (!best || Math.abs(r.x0 - (lo + hi) / 2) < Math.abs(best.x0 - (lo + hi) / 2)) best = r;
    }
    return best;
  };
  let left: number;
  if (colStart === 0) {
    const rule = verticalIn(tableLeft - 30, bands[0].left);
    left = rule ? rule.x0 + rule.thickness / 2 + BORDER_CLEARANCE : tableLeft - 2;
  } else {
    const lo = bands[colStart - 1].right;
    const hi = bands[colStart].left;
    const rule = verticalIn(lo, hi);
    left = rule ? rule.x0 + rule.thickness / 2 + BORDER_CLEARANCE : (lo + hi) / 2 + NEIGHBOUR_CLEARANCE;
  }
  let right: number;
  if (colEnd === bands.length - 1) {
    const rule = verticalIn(bands[colEnd].right, tableRight + 30);
    right = rule ? rule.x0 - rule.thickness / 2 - BORDER_CLEARANCE : tableRight + 2;
  } else {
    const lo = bands[colEnd].right;
    const hi = bands[colEnd + 1].left;
    const rule = verticalIn(lo, hi);
    right = rule ? rule.x0 - rule.thickness / 2 - BORDER_CLEARANCE : (lo + hi) / 2 - NEIGHBOUR_CLEARANCE;
  }
  return { left, right };
}

/**
 * Vertical bounds of a cell: up to the nearest horizontal rule (minus
 * clearance) or halfway to the nearest other fragment in the same columns,
 * and a little room when nothing is there.
 */
function rowBounds(
  textBox: Rect,
  fontSize: number,
  cellFragments: ReadonlySet<Fragment>,
  allFragments: readonly Fragment[],
  rules: readonly RuleLine[],
  xRange: ColumnBounds,
): { top: number; bottom: number } {
  const textTop = textBox.y + textBox.height;
  const textBottom = textBox.y;
  const frags = [...cellFragments];
  const topBaseline = Math.max(...frags.map((f) => f.y));
  const bottomBaseline = Math.min(...frags.map((f) => f.y));
  // Glyphs really end well inside the 0.8 / 0.25 em allowances; a rule there separates rows.
  const minTop = topBaseline + (RULE_ABOVE_BASELINE + 0.05) * fontSize;
  const maxBottom = bottomBaseline - RULE_BELOW_BASELINE * fontSize;
  const overlapsX = (left: number, right: number) => right > xRange.left && left < xRange.right;

  let ruleAbove: RuleLine | null = null;
  let ruleBelow: RuleLine | null = null;
  for (const r of rules) {
    if (r.orientation !== 'horizontal' || !overlapsX(r.x0, r.x1)) continue;
    if (r.y0 >= minTop && (!ruleAbove || r.y0 < ruleAbove.y0)) ruleAbove = r;
    if (r.y0 <= maxBottom && (!ruleBelow || r.y0 > ruleBelow.y0)) ruleBelow = r;
  }
  let fragAbove = Infinity;
  let fragBelow = -Infinity;
  for (const f of allFragments) {
    if (cellFragments.has(f) || !overlapsX(f.x, f.right)) continue;
    if (f.bottom >= textTop - 0.5) fragAbove = Math.min(fragAbove, f.bottom);
    if (f.top <= textBottom + 0.5) fragBelow = Math.max(fragBelow, f.top);
  }

  let top: number;
  if (ruleAbove && (fragAbove === Infinity || ruleAbove.y0 <= fragAbove)) top = ruleAbove.y0 - ruleAbove.thickness / 2 - BORDER_CLEARANCE;
  else if (fragAbove !== Infinity) top = textTop + (fragAbove - textTop) / 2 - NEIGHBOUR_CLEARANCE;
  else top = textTop + OPEN_SIDE_ROOM * fontSize;

  let bottom: number;
  if (ruleBelow && (fragBelow === -Infinity || ruleBelow.y0 >= fragBelow)) bottom = ruleBelow.y0 + ruleBelow.thickness / 2 + BORDER_CLEARANCE;
  else if (fragBelow !== -Infinity) bottom = textBottom - (textBottom - fragBelow) / 2 + NEIGHBOUR_CLEARANCE;
  else bottom = textBottom - OPEN_SIDE_ROOM * fontSize;

  // Never tighter than the glyphs themselves (a rule drawn through the text, odd geometry).
  return { top: Math.max(top, Math.min(textTop, minTop)), bottom: Math.min(bottom, Math.max(textBottom, maxBottom)) };
}

function alignmentOf(values: { x: number; right: number }[]): CellAlignment {
  if (values.length < 2) return 'left';
  const spread = (nums: number[]) => Math.max(...nums) - Math.min(...nums);
  const left = spread(values.map((v) => v.x));
  const right = spread(values.map((v) => v.right));
  const center = spread(values.map((v) => (v.x + v.right) / 2));
  const best = Math.min(left, right, center);
  if (best === left) return 'left';
  if (best === center) return 'center';
  return 'right';
}

function hexChannelsLight(color: string): boolean {
  const n = parseInt(color.slice(1), 16);
  if (!Number.isFinite(n)) return false;
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  if (r < BACKGROUND_MIN_CHANNEL || g < BACKGROUND_MIN_CHANNEL || b < BACKGROUND_MIN_CHANNEL) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= BACKGROUND_MIN_LUMINANCE;
}

/** Light fill behind the centre of `box`, or null (white and unknown colours are null). */
export function backgroundAt(box: Rect, fills: readonly FilledRect[]): string | null {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let found: string | null = null;
  for (const f of fills) {
    if (cx < f.x || cx > f.x + f.width || cy < f.y || cy > f.y + f.height) continue;
    if (!f.color || f.color === '#ffffff' || !hexChannelsLight(f.color)) {
      found = null; // a later paint covers earlier ones
      continue;
    }
    found = f.color;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildTableCells(input: TableInput): TableBuildResult {
  const refs = input.items.filter((r) => r.item.text.trim().length > 0);
  if (refs.length === 0) return { ok: false, reason: 'NO_ITEMS' };
  const rows = buildRows(refs);
  if (rows.length < 2) return { ok: false, reason: 'SINGLE_ROW' };

  const bands = detectBands(rows);
  if (bands.length < 2) return { ok: false, reason: 'NO_COLUMNS' };

  for (const row of rows) {
    for (const f of row.fragments) assignColumns(f, bands);
    mergeSameColumn(row);
  }
  const allFragments = rows.flatMap((r) => r.fragments);
  const tableLeft = Math.min(...allFragments.map((f) => f.x));
  const tableRight = Math.max(...allFragments.map((f) => f.right));
  const firstDataRow = findFirstDataRow(rows);
  const drafts = buildCells(rows, firstDataRow, input.rules, bands.length);

  // Column alignment from single-column data cells.
  const alignments: CellAlignment[] = bands.map((_, c) => {
    const samples = drafts
      .filter((d) => d.colStart === c && d.colEnd === c && d.rows[0] >= firstDataRow)
      .map((d) => textBoxOf(d.fragments))
      .map((b) => ({ x: b.x, right: b.x + b.width }));
    return alignmentOf(samples);
  });

  const cells: ResolvedCell[] = [];
  const usedIds = new Map<string, number>();
  for (const draft of drafts) {
    const fragmentSet = new Set(draft.fragments);
    const textBox = textBoxOf(draft.fragments);
    const fontSize = dominantFontSize(draft.fragments.flatMap((f) => f.items.map((r) => r.item)));
    const yRange = { top: textBox.y + textBox.height, bottom: textBox.y };
    const cols = columnBounds(draft.colStart, draft.colEnd, bands, input.rules, tableLeft, tableRight, yRange);
    const vertical = rowBounds(textBox, fontSize, fragmentSet, allFragments, input.rules, cols);
    const usableLeft = Math.min(cols.left + CELL_PAD_X, textBox.x);
    const usableRight = Math.max(cols.right - CELL_PAD_X, textBox.x + textBox.width);
    const usable: Rect = {
      x: round(usableLeft),
      y: round(vertical.bottom),
      width: round(usableRight - usableLeft),
      height: round(vertical.top - vertical.bottom),
    };
    const spanning = draft.colEnd > draft.colStart;
    const header = draft.rows[0] < firstDataRow;
    const baseId = `p${input.page}-t${input.tableId}-r${draft.rows[0]}c${draft.colStart}`;
    const seen = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, seen + 1);
    const id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
    const text = draft.text.replace(/\s+/g, ' ').trim();
    cells.push({
      text,
      fragments: draft.fragments,
      info: {
        id,
        page: input.page,
        tableId: input.tableId,
        rowIndex: draft.rows[0],
        columnIndex: draft.colStart,
        colSpan: draft.colEnd - draft.colStart + 1,
        sourceItemIds: draft.fragments.flatMap((f) => f.items.map((r) => r.index)),
        textBox,
        usable,
        alignment: spanning && header ? 'center' : alignments[draft.colStart],
        fontSize,
        numeric: isNumericTableCell(text),
        header,
        trailingMarker: draft.trailingMarker,
        background: backgroundAt(textBox, input.fills),
      },
    });
  }
  cells.sort((a, b) => a.info.rowIndex - b.info.rowIndex || a.info.columnIndex - b.info.columnIndex);
  return { ok: true, cells, rows: rows.length, columns: bands.length };
}

// ---------------------------------------------------------------------------
// Masks (union of the source lines, clipped to the cell interior)
// ---------------------------------------------------------------------------

export interface SourceLineBox {
  x: number;
  right: number;
  top: number;
  bottom: number;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  if (right - x <= 0 || top - y <= 0) return null;
  return { x, y, width: right - x, height: top - y };
}

/**
 * One mask per source line: the line's glyph box plus TABLE_MASK_PAD,
 * clipped to the usable rectangle. The usable rectangle already stops short
 * of every rule and of the neighbouring cells, so borders and other cells
 * are never painted over, and nothing outside the text's own lines is masked.
 */
export function tableCellMaskRects(cell: TableCellInfo, lines: readonly SourceLineBox[]): Rect[] {
  const out: Rect[] = [];
  for (const line of lines) {
    const padded: Rect = {
      x: line.x - TABLE_MASK_PAD,
      y: line.bottom - TABLE_MASK_PAD,
      width: line.right - line.x + 2 * TABLE_MASK_PAD,
      height: line.top - line.bottom + 2 * TABLE_MASK_PAD,
    };
    const clipped = intersect(padded, cell.usable);
    if (clipped) out.push(clipped);
  }
  return out;
}

/**
 * Keep a line mask off the table rules next to it. A rule less than
 * RULE_BELOW_BASELINE × fontSize under the baseline, or less than
 * RULE_ABOVE_BASELINE × fontSize above it, can only sit in the mask's padding
 * (glyphs never reach that far), so trimming the mask there hides nothing.
 * Used for every masked line, so a caption or note directly above a table
 * never paints over the table's top border.
 */
export function clipMaskToRules(mask: Rect, baseline: number, fontSize: number, rules: readonly RuleLine[]): Rect {
  let lo = mask.y;
  let hi = mask.y + mask.height;
  const right = mask.x + mask.width;
  for (const r of rules) {
    if (r.orientation !== 'horizontal' || r.x1 <= mask.x || r.x0 >= right) continue;
    const half = r.thickness / 2;
    if (r.y0 < baseline - RULE_BELOW_BASELINE * fontSize && r.y0 + half + BORDER_CLEARANCE > lo && r.y0 < baseline) {
      lo = Math.min(baseline - RULE_BELOW_BASELINE * fontSize, r.y0 + half + BORDER_CLEARANCE);
    }
    if (r.y0 > baseline + RULE_ABOVE_BASELINE * fontSize && r.y0 - half - BORDER_CLEARANCE < hi) {
      hi = Math.max(baseline + RULE_ABOVE_BASELINE * fontSize, r.y0 - half - BORDER_CLEARANCE);
    }
  }
  return { x: mask.x, y: lo, width: mask.width, height: Math.max(0, hi - lo) };
}

// ---------------------------------------------------------------------------
// Table-only fitting
// ---------------------------------------------------------------------------

export interface TableFitOptions {
  text: string;
  /** Usable width for the text (points). */
  width: number;
  /** Usable height (points): the text may never extend below it. */
  height: number;
  originalFontSize: number;
  font: TextMeasurer;
  /** Configured floor; the effective floor is max(TABLE_MIN_FONT_SIZE, minFontSize). */
  minFontSize?: number;
  /** Footnote marker drawn after the last line at MARKER_SCALE × font size. */
  trailingMarker?: string | null;
}

export interface TableFitResult {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  /** Extent of the wrapped text at the chosen size (first ascender to last descender). */
  totalHeight: number;
  /** Widest line (marker included on the last line). */
  maxWidth: number;
  fits: boolean;
  /** Points the text still exceeds the usable height or width by (0 when it fits). */
  overflow: number;
  /** Which limit failed when `fits` is false. */
  reason: 'HEIGHT' | 'WIDTH' | null;
  iterations: number;
  minFontSize: number;
}

/**
 * Fit a translation into a table cell:
 *   1. wrap at the usable width,
 *   2. tighten the line height (1.15 → 1.08 × font size),
 *   3. shrink the font by TABLE_FONT_STEP and wrap again,
 * down to max(5 pt, minFontSize). There is no downward extension: when even
 * the smallest size does not fit, `fits` is false and the caller falls back
 * (keeps the English cell).
 */
export function fitTextToTableCell(options: TableFitOptions): TableFitResult {
  const { text, width, height, originalFontSize, font } = options;
  const minFontSize = Math.max(TABLE_MIN_FONT_SIZE, options.minFontSize ?? TABLE_MIN_FONT_SIZE);
  const marker = options.trailingMarker ?? null;
  const tokens = tokenize(text);
  const ratios = [TABLE_LINE_HEIGHT_RATIO, TABLE_LINE_HEIGHT_TIGHT];

  let iterations = 0;
  let last: TableFitResult | null = null;
  let fontSize = Math.max(originalFontSize, minFontSize);
  while (true) {
    for (const ratio of ratios) {
      iterations++;
      const lineHeight = fontSize * ratio;
      const lines = wrapTokens(tokens, font, fontSize, width).lines;
      const widths = lines.map((l) => font.widthOfTextAtSize(l, fontSize));
      if (marker && widths.length > 0) widths[widths.length - 1] += font.widthOfTextAtSize(marker, fontSize * MARKER_SCALE);
      const maxWidth = widths.length ? Math.max(...widths) : 0;
      const totalHeight = textExtent(lines.length, fontSize, lineHeight);
      const widthOk = maxWidth <= width + WIDTH_TOLERANCE;
      const heightOk = totalHeight <= height + 1e-6;
      last = {
        lines,
        fontSize,
        lineHeight,
        totalHeight,
        maxWidth,
        fits: widthOk && heightOk,
        overflow: 0,
        reason: null,
        iterations,
        minFontSize,
      };
      if (widthOk && heightOk) return last;
      if (!heightOk) {
        last.reason = 'HEIGHT';
        last.overflow = totalHeight - height;
      } else {
        last.reason = 'WIDTH';
        last.overflow = maxWidth - width;
      }
      if (lines.length <= 1) break; // a single line cannot profit from a tighter line height
    }
    const next = Math.round((fontSize - TABLE_FONT_STEP) * 100) / 100;
    if (next < minFontSize - 1e-9 || iterations >= MAX_FIT_ITERATIONS) break;
    fontSize = next;
  }
  return last as TableFitResult;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface PlacedLine {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  width: number;
}

export interface CellPlacement {
  lines: PlacedLine[];
  /** Where the trailing footnote marker goes (after the last line), null when there is none. */
  marker: { text: string; x: number; y: number; fontSize: number } | null;
}

/**
 * Baselines and x positions of the fitted lines inside the cell:
 *  - vertically anchored at the original text top, shifted up only as far as
 *    needed to keep the last descender inside the usable rectangle;
 *  - horizontally by the cell's alignment (left: the cell's own text left,
 *    keeping indents; right: the original right edge; center: the column).
 * The result never leaves `cell.usable` when the fit reported `fits`.
 */
export function placeTableCellLines(cell: TableCellInfo, fit: TableFitResult, font: TextMeasurer): CellPlacement {
  const { usable, textBox } = cell;
  const usableTop = usable.y + usable.height;
  const usableRight = usable.x + usable.width;
  const textTop = textBox.y + textBox.height;
  const extent = fit.totalHeight;
  let top = Math.min(textTop, usableTop);
  if (top - extent < usable.y) top = Math.min(usableTop, usable.y + extent);
  let baseline = top - GLYPH_ASCENT * fit.fontSize;

  const lines: PlacedLine[] = [];
  for (const text of fit.lines) {
    const width = font.widthOfTextAtSize(text, fit.fontSize);
    let x: number;
    if (cell.alignment === 'right') x = Math.max(usable.x, textBox.x + textBox.width - width);
    else if (cell.alignment === 'center') x = Math.max(usable.x, (usable.x + usableRight) / 2 - width / 2);
    else x = Math.max(usable.x, textBox.x);
    lines.push({ text, x, y: baseline, width });
    baseline -= fit.lineHeight;
  }

  let marker: CellPlacement['marker'] = null;
  if (cell.trailingMarker && lines.length > 0) {
    const last = lines[lines.length - 1];
    const size = fit.fontSize * MARKER_SCALE;
    marker = { text: cell.trailingMarker, x: last.x + last.width, y: last.y + MARKER_RAISE * fit.fontSize, fontSize: size };
  }
  return { lines, marker };
}
