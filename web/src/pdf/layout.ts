/**
 * Phase C: heuristic layout analysis.
 *
 *   text items  →  lines  →  column regions  →  blocks  →  reading order
 *
 * Everything is coordinate based. No machine learning, no reliance on hasEOL.
 * Classification (TITLE / BODY / ...) and translate decisions live in classify.ts.
 */

import { captionKind, classifyBlocks, isAbbreviationOnly, isNumericRow, isUntranslatableText } from './classify';
import { applyLayoutRoles, countRoleClaimedItems, emptyLayoutRoles } from './detectors/registry';
import { buildFigureCells, detectFigureRegions, isUntranslatableFigureText, type FigureCaptionRef } from './figure';
import { buildTranslationBlocks, contextStats } from './merge';
import { absorbOrphanFragments } from './paragraph';
import { collectBlockSubscripts, collectBlockSuperscripts } from './superscript';
import { buildTableCells, type ResolvedCell, type TableItemRef } from './table';
import { joinLines } from './text';
import type {
  BlockType,
  ColumnLayout,
  ColumnRegion,
  DetailedBlockType,
  FigureSummary,
  LayoutResult,
  PageDebugInfo,
  PageLayout,
  PdfAnalysis,
  Rect,
  TableSummary,
  TextBlock,
  TextItemDebug,
  TextLine,
  TranslationBlock,
} from './types';

// ---------------------------------------------------------------------------
// Tunable thresholds (all relative to font size unless noted)
// ---------------------------------------------------------------------------

/** Items whose baselines differ by less than this × fontSize share a line. */
const BASELINE_TOLERANCE = 0.5;
/**
 * Baseline difference (× fontSize) that counts as "the same baseline" however
 * far apart the items are: the row labels of a table are regularly set a
 * fifth of an em below their values, and the two ends of a running header
 * rarely align to the point. Well below the line pitch of any column, and
 * below the rise of a superscript, which reaches its line through the
 * horizontal condition in joinsLine instead.
 */
const SAME_BASELINE_TOLERANCE = 0.25;
/** A run this much smaller than a line may be a raised or lowered part of it, never a line of its own. */
const MARKER_SIZE_RATIO = 0.9;
/** Horizontal gap above this × fontSize splits a baseline cluster into separate lines. */
const LINE_GAP_SPLIT = 0.8;
/** Second pass inside one column: lines on the same baseline closer than this are merged. */
const LINE_GAP_MERGE = 2.0;
/** A gap wider than this × fontSize between items becomes a space character. */
const WORD_GAP = 0.12;
/** Minimum body lines on each side of the page to call it two-column. */
const MIN_COLUMN_LINES = 5;
/** Two pieces of table furniture closer than this (× fontSize) belong to one table band. */
const TABLE_BAND_MAX_GAP = 2.5;
/** A table band is at least this tall (× fontSize) and carries at least two pieces of furniture. */
const TABLE_BAND_MIN_HEIGHT = 1.5;
const TABLE_BAND_MIN_MARKS = 2;
/** A band holding a wide line of this many words of running text is a figure or a frame, not a table. */
const BAND_PROSE_WORDS = 12;
const BAND_PROSE_WIDTH = 0.5;
/** How far above or below a band its caption may stand (× fontSize). */
const BAND_CAPTION_REACH = 4;
/** Max baseline distance (× fontSize) for two lines to be in one paragraph. */
const MAX_LINE_PITCH = 1.8;
/** Tighter pitch when the previous line is short (probable paragraph end). */
const MAX_LINE_PITCH_AFTER_SHORT = 1.45;
/** Previous line counts as short when it leaves more than this fraction of the column empty. */
const SHORT_LINE_FRACTION = 0.2;
/** A first-line indent larger than this × fontSize starts a new paragraph. */
const INDENT = 0.6;
/** Font size ratio tolerance inside one block. */
const FONT_SIZE_TOLERANCE = 0.15;
/** Glyph extents relative to the baseline, used for bounding boxes (also by fit.ts / render.ts). */
export const GLYPH_ASCENT = 0.8;
export const GLYPH_DESCENT = 0.25;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function itemRight(item: TextItemDebug): number {
  return item.x + item.width;
}

function lineRight(line: TextLine): number {
  return line.x + line.width;
}

/** Character-weighted mode of font sizes, rounded to 0.5pt. */
export function computeBodyFontSize(items: TextItemDebug[]): number {
  const weights = new Map<number, number>();
  for (const item of items) {
    const key = Math.round(item.fontSize * 2) / 2;
    if (key <= 0) continue;
    weights.set(key, (weights.get(key) ?? 0) + item.text.trim().length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Step 1: items → lines
// ---------------------------------------------------------------------------

function dominantItem(items: TextItemDebug[]): TextItemDebug {
  let best = items[0];
  let bestLen = -1;
  for (const it of items) {
    const len = it.text.trim().length;
    if (len > bestLen) {
      best = it;
      bestLen = len;
    }
  }
  return best;
}

function buildLineText(items: TextItemDebug[]): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = item.x - itemRight(prev);
      const fs = Math.max(prev.fontSize, item.fontSize, 1);
      const needsSpace = gap > WORD_GAP * fs && !/\s$/.test(out) && !/^\s/.test(item.text);
      if (needsSpace) out += ' ';
    }
    out += item.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function makeLine(page: number, items: TextItemDebug[], column: ColumnRegion): TextLine {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const dom = dominantItem(sorted);
  const left = Math.min(...sorted.map((i) => i.x));
  const right = Math.max(...sorted.map(itemRight));
  return {
    page,
    text: buildLineText(sorted),
    x: round(left),
    y: round(dom.y),
    width: round(right - left),
    height: round(dom.fontSize),
    fontSize: dom.fontSize,
    fontName: dom.fontName,
    fontRealName: dom.fontRealName,
    column,
    items: sorted,
  };
}

/**
 * A group of items that share one baseline, before the horizontal split.
 *
 * `anchorY` / `anchorFs` describe the group's dominant item: the first one
 * with real text, replaced only by a strictly larger one. The anchor
 * deliberately does not follow the items one by one — a reference that moved
 * with every accepted item let a run of slightly different baselines walk a
 * group down the page, one tolerance at a time, and a heading in the
 * neighbouring column could bridge two baselines of this one into a single
 * line whose words then interleaved.
 */
interface BaselineGroup {
  items: TextItemDebug[];
  anchorY: number;
  anchorFs: number;
  /** Whether any item carries real text; a group of markers alone is a satellite. */
  hasLineText: boolean;
  minX: number;
  maxX: number;
}

/** Long enough to carry a baseline; "12", "*" or "d" is a marker or a symbol, not the line. */
function isLineText(item: TextItemDebug): boolean {
  return item.text.trim().length > 2;
}

function startGroup(item: TextItemDebug): BaselineGroup {
  return {
    items: [item],
    anchorY: item.y,
    anchorFs: item.fontSize,
    hasLineText: isLineText(item),
    minX: item.x,
    maxX: itemRight(item),
  };
}

function addToGroup(group: BaselineGroup, item: TextItemDebug): void {
  group.items.push(item);
  group.minX = Math.min(group.minX, item.x);
  group.maxX = Math.max(group.maxX, itemRight(item));
  // Take over the anchor only for the dominant item of the line: the first
  // real text (a group may start at a raised marker), later a strictly larger
  // one. Equal sizes never move the baseline.
  if (isLineText(item) && (!group.hasLineText || item.fontSize > group.anchorFs)) {
    group.anchorY = item.y;
    group.anchorFs = item.fontSize;
  }
  group.hasLineText = group.hasLineText || isLineText(item);
}

/** Baseline difference of two groups, relative to the larger of their sizes. */
function baselineGap(a: BaselineGroup, b: BaselineGroup): number {
  return Math.abs(a.anchorY - b.anchorY) / Math.max(a.anchorFs, b.anchorFs);
}

/**
 * Is `satellite` a run that belongs to the line of `host` rather than a line
 * of its own? Either it carries no real text at all ("*", "62"), or it is set
 * clearly smaller than the host, which is what a raised citation run
 * ("16,27-29") and an inline subscript look like. A group in the host's size
 * or larger is a line — that is what keeps the heading of the neighbouring
 * column out of this one.
 */
function isSatelliteOf(satellite: BaselineGroup, host: BaselineGroup): boolean {
  return !satellite.hasLineText || satellite.anchorFs <= MARKER_SIZE_RATIO * host.anchorFs;
}

function horizontallyNear(a: BaselineGroup, b: BaselineGroup): boolean {
  const reach = LINE_GAP_SPLIT * Math.max(a.anchorFs, b.anchorFs);
  return a.minX <= b.maxX + reach && a.maxX >= b.minX - reach;
}

/**
 * Give every marker-only group (a raised citation number, a "#" on a table
 * row) back to the line it belongs to: the nearest baseline within
 * BASELINE_TOLERANCE that it touches horizontally. Merged groups are emptied,
 * not removed, so the caller keeps the reading order of the rest.
 *
 * This is what the baseline tolerance used to do on its own, before the
 * groups were built: doing it group by group makes it independent of the
 * order in which the items arrive, which is what broke when a marker was
 * followed by a single-letter item of the *other* column.
 */
function attachMarkerGroups(groups: BaselineGroup[]): void {
  for (let i = 0; i < groups.length; i++) {
    const satellite = groups[i];
    if (satellite.items.length === 0) continue;
    let host: BaselineGroup | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let j = 0; j < groups.length; j++) {
      if (j === i) continue;
      const candidate = groups[j];
      if (!candidate.hasLineText || candidate.items.length === 0) continue;
      if (!isSatelliteOf(satellite, candidate)) continue;
      const gap = baselineGap(satellite, candidate);
      if (gap > BASELINE_TOLERANCE || gap >= bestGap) continue;
      if (!horizontallyNear(satellite, candidate)) continue;
      host = candidate;
      bestGap = gap;
    }
    if (!host) continue;
    for (const item of satellite.items) addToGroup(host, item);
    satellite.items = [];
  }
}

/**
 * Cluster items by baseline, then split each cluster by horizontal gaps.
 * Produces "preliminary" lines: a two-column page yields separate lines for
 * the left and right column because the gutter is wider than LINE_GAP_SPLIT.
 */
function buildLines(items: TextItemDebug[], page: number): TextLine[] {
  const byY = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  // 1. baseline groups: only items that really share a baseline, whatever
  //    their horizontal distance (the cells of a table row, the two ends of a
  //    running header). Raised and lowered markers follow in step 1b.
  const groups: BaselineGroup[] = [];
  for (const item of byY) {
    const current = groups[groups.length - 1];
    if (current && Math.abs(current.anchorY - item.y) <= SAME_BASELINE_TOLERANCE * Math.max(current.anchorFs, item.fontSize)) {
      addToGroup(current, item);
    } else {
      groups.push(startGroup(item));
    }
  }

  // 1b. markers back to their line
  attachMarkerGroups(groups);
  const clusters: TextItemDebug[][] = groups.filter((g) => g.items.length > 0).map((g) => g.items);

  // 2. split each cluster at wide horizontal gaps
  const lines: TextLine[] = [];
  for (const cluster of clusters) {
    const byX = cluster.sort((a, b) => a.x - b.x);
    let run: TextItemDebug[] = [];
    for (const item of byX) {
      if (run.length === 0) {
        run.push(item);
        continue;
      }
      const prev = run[run.length - 1];
      const fs = Math.max(prev.fontSize, item.fontSize, 1);
      const gap = item.x - Math.max(...run.map(itemRight));
      if (gap > LINE_GAP_SPLIT * fs) {
        lines.push(makeLine(page, run, 'FULL'));
        run = [item];
      } else {
        run.push(item);
      }
    }
    if (run.length) lines.push(makeLine(page, run, 'FULL'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Step 2: column detection
// ---------------------------------------------------------------------------

interface ColumnInfo {
  layout: ColumnLayout;
  gutter: { left: number; right: number } | null;
}

function detectColumns(lines: TextLine[], page: PageDebugInfo, bodyFontSize: number): ColumnInfo {
  const [x0, , x1] = page.view;
  const mid = (x0 + x1) / 2;

  const bodyLines = lines.filter(
    (l) => l.fontSize >= 0.75 * bodyFontSize && l.fontSize <= 1.3 * bodyFontSize && l.text.length >= 3,
  );

  const left = bodyLines.filter((l) => lineRight(l) <= mid + 2 && l.x < mid);
  const right = bodyLines.filter((l) => l.x >= mid - 2);
  const crossing = bodyLines.filter((l) => l.x < mid - 2 && lineRight(l) > mid + 2);

  const enoughLines = left.length >= MIN_COLUMN_LINES && right.length >= MIN_COLUMN_LINES;
  const notDominatedByFullWidth = crossing.length <= left.length + right.length;

  if (enoughLines && notDominatedByFullWidth) {
    const gutterLeft = percentile(left.map(lineRight), 0.95);
    const gutterRight = percentile(right.map((l) => l.x), 0.05);
    if (gutterRight - gutterLeft >= 2) {
      return { layout: 'TWO_COLUMN', gutter: { left: round(gutterLeft), right: round(gutterRight) } };
    }
  }
  return { layout: 'SINGLE_COLUMN', gutter: null };
}

/**
 * Vertical band of a two-column page that a full-width table occupies.
 * Its rows are read as one region, whatever the gutter says (see tableBands).
 */
export interface TableBand {
  top: number;
  bottom: number;
}

function crossesGutter(x0: number, x1: number, gutter: { left: number; right: number }): boolean {
  return x0 < gutter.left && x1 > gutter.right;
}

/** Words of running text; the values of a table row are not words. */
function proseWordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[A-Za-z]{2,}/.test(t)).length;
}

function inBand(y: number, bands: readonly TableBand[]): boolean {
  return bands.some((b) => y >= b.bottom && y <= b.top);
}

/**
 * The vertical bands of a two-column page that a full-width table occupies.
 *
 * Nothing but a spanning table (or a figure) draws a horizontal rule or fills
 * a cell across the column gutter, so this furniture locates the table
 * without reading a single character. Marks closer than TABLE_BAND_MAX_GAP
 * form one band; a band needs two marks and a real height, which leaves out
 * the rule under a running header and the axis of a figure, and it is dropped
 * again when it holds a wide line of running text, which a table row is not.
 *
 * Every line inside a band becomes SPANNING, because the gutter otherwise
 * cuts each table row into a left, a spanning and a right piece, and grouping
 * per region then stacks pieces of *different rows* into one block: the
 * classifier reads that stack as a note or a heading, ends the table, and the
 * values are translated as prose and drawn over the table.
 */
function tableBands(page: PageDebugInfo, columns: ColumnInfo, lines: readonly TextLine[], bodyFontSize: number): TableBand[] {
  const gutter = columns.gutter;
  if (columns.layout !== 'TWO_COLUMN' || !gutter) return [];

  const marks: TableBand[] = [];
  for (const r of page.rules) {
    if (r.orientation !== 'horizontal') continue;
    if (crossesGutter(Math.min(r.x0, r.x1), Math.max(r.x0, r.x1), gutter)) marks.push({ top: r.y0, bottom: r.y0 });
  }
  for (const f of page.fills) {
    if (crossesGutter(f.x, f.x + f.width, gutter)) marks.push({ top: f.y + f.height, bottom: f.y });
  }
  if (marks.length < TABLE_BAND_MIN_MARKS) return [];
  marks.sort((a, b) => b.top - a.top);

  const grouped: { band: TableBand; marks: number }[] = [];
  for (const mark of marks) {
    const last = grouped[grouped.length - 1];
    if (last && last.band.bottom - mark.top <= TABLE_BAND_MAX_GAP * bodyFontSize) {
      last.band.bottom = Math.min(last.band.bottom, mark.bottom);
      last.band.top = Math.max(last.band.top, mark.top);
      last.marks++;
    } else {
      grouped.push({ band: { top: mark.top, bottom: mark.bottom }, marks: 1 });
    }
  }

  const pageWidth = page.view[2] - page.view[0];
  const isProse = (l: TextLine): boolean => l.width >= BAND_PROSE_WIDTH * pageWidth && proseWordCount(l.text) >= BAND_PROSE_WORDS;
  return grouped
    .filter((g) => g.marks >= TABLE_BAND_MIN_MARKS && g.band.top - g.band.bottom >= TABLE_BAND_MIN_HEIGHT * bodyFontSize)
    .filter((g) => !lines.some((l) => inBand(l.y, [g.band]) && isProse(l)))
    .filter((g) => introducedByTableCaption(g.band, lines, bodyFontSize))
    .map((g) => g.band);
}

/**
 * Does a table caption introduce this band?
 *
 * A figure drawn inside a frame leaves the same marks across the gutter as a
 * table does, and its legend would then be cut into the band and grouped with
 * the drawing. The caption right above (or below) the band says which it is,
 * so only a band a *table* caption introduces is read as a table.
 */
function introducedByTableCaption(band: TableBand, lines: readonly TextLine[], bodyFontSize: number): boolean {
  const reach = BAND_CAPTION_REACH * bodyFontSize;
  let nearest: { distance: number; kind: 'FIGURE' | 'TABLE' } | null = null;
  for (const line of lines) {
    const distance = line.y > band.top ? line.y - band.top : line.y < band.bottom ? band.bottom - line.y : 0;
    if (distance > reach) continue;
    const kind = captionKind(line.text);
    if (!kind) continue;
    if (!nearest || distance < nearest.distance) nearest = { distance, kind };
  }
  return nearest?.kind === 'TABLE';
}

function assignRegion(line: TextLine, columns: ColumnInfo, bands: readonly TableBand[]): ColumnRegion {
  if (columns.layout === 'SINGLE_COLUMN' || !columns.gutter) return 'FULL';
  if (inBand(line.y, bands)) return 'SPANNING';
  const { left, right } = columns.gutter;
  const lr = lineRight(line);
  if (line.x < left - 1 && lr > right + 1) return 'SPANNING';
  const center = (line.x + lr) / 2;
  return center <= (left + right) / 2 ? 'LEFT' : 'RIGHT';
}

/** Merge lines that sit on one baseline inside the same region (wide justified gaps). */
function mergeSameBaseline(lines: TextLine[], page: number): TextLine[] {
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: TextLine[] = [];
  for (const line of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.column === line.column) {
      const fs = Math.max(prev.fontSize, line.fontSize);
      const sameBaseline = Math.abs(prev.y - line.y) <= BASELINE_TOLERANCE * fs;
      const gap = line.x - lineRight(prev);
      if (sameBaseline && gap >= -0.5 * fs && gap <= LINE_GAP_MERGE * fs) {
        out[out.length - 1] = makeLine(page, [...prev.items, ...line.items], prev.column);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: lines → blocks (within one region of one page)
// ---------------------------------------------------------------------------

interface RegionStats {
  left: number;
  right: number;
  width: number;
}

function regionStats(lines: TextLine[]): RegionStats {
  const left = percentile(lines.map((l) => l.x), 0.1);
  const right = percentile(lines.map(lineRight), 0.9);
  return { left, right, width: Math.max(1, right - left) };
}

function isCentered(line: TextLine, stats: RegionStats): boolean {
  const center = line.x + line.width / 2;
  const regionCenter = stats.left + stats.width / 2;
  return Math.abs(center - regionCenter) < 0.08 * stats.width && line.width < 0.85 * stats.width;
}

function shouldBreak(prev: TextLine, line: TextLine, stats: RegionStats): string | null {
  const fs = prev.fontSize;
  const pitch = prev.y - line.y;

  if (pitch <= 0.3 * fs) return 'side-by-side';

  const ratio = line.fontSize / prev.fontSize;
  if (ratio < 1 - FONT_SIZE_TOLERANCE || ratio > 1 + FONT_SIZE_TOLERANCE) return 'font-size';

  if (line.fontName !== prev.fontName) return 'font-change';

  const prevShort = stats.right - lineRight(prev) > SHORT_LINE_FRACTION * stats.width;
  const maxPitch = (prevShort ? MAX_LINE_PITCH_AFTER_SHORT : MAX_LINE_PITCH) * fs;
  if (pitch > maxPitch) return 'line-gap';

  const centeredPair = isCentered(prev, stats) && isCentered(line, stats);
  if (!centeredPair && line.x - prev.x > INDENT * fs) return 'indent';

  return null;
}

/** Paragraph text: lines joined with end-of-line hyphenation repaired (see text.ts). */
function joinLineTexts(lines: TextLine[]): string {
  return joinLines(lines.map((l) => l.text));
}

function makeBlock(page: number, lines: TextLine[], column: ColumnRegion): TextBlock {
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map(lineRight));
  const top = Math.max(...lines.map((l) => l.y + GLYPH_ASCENT * l.fontSize));
  const bottom = Math.min(...lines.map((l) => l.y - GLYPH_DESCENT * l.fontSize));
  const dom = lines.reduce((a, b) => (b.text.length > a.text.length ? b : a), lines[0]);
  return {
    id: '',
    page,
    type: 'OTHER',
    sectionType: 'MAIN',
    blockType: 'OTHER',
    text: joinLineTexts(lines),
    x: round(left),
    y: round(bottom),
    width: round(right - left),
    height: round(top - bottom),
    top: round(top),
    fontSize: dom.fontSize,
    fontName: dom.fontName,
    fontRealName: dom.fontRealName,
    column,
    lineCount: lines.length,
    lines,
    order: -1,
    translate: false,
    skipReason: null,
  };
}

function groupBlocks(lines: TextLine[], page: number, column: ColumnRegion): TextBlock[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const stats = regionStats(sorted);
  const blocks: TextBlock[] = [];
  let current: TextLine[] = [];

  for (const line of sorted) {
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const prev = current[current.length - 1];
    if (shouldBreak(prev, line, stats)) {
      blocks.push(makeBlock(page, current, column));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(makeBlock(page, current, column));
  return blocks;
}

// ---------------------------------------------------------------------------
// Step 4: reading order
// ---------------------------------------------------------------------------

/**
 * Two-column pages: spanning blocks split the page into horizontal bands.
 * Inside each band we read the left column top→bottom, then the right column,
 * then the spanning block that closes the band.
 */
function orderBlocks(blocks: TextBlock[], layout: ColumnLayout): TextBlock[] {
  if (layout === 'SINGLE_COLUMN') {
    return [...blocks].sort((a, b) => b.top - a.top || a.x - b.x);
  }

  const spanning = blocks.filter((b) => b.column === 'SPANNING').sort((a, b) => b.top - a.top);
  const columnOrder: Record<ColumnRegion, number> = { LEFT: 0, RIGHT: 1, SPANNING: 2, FULL: 0 };

  const keyed = blocks.map((block) => {
    let band: number;
    if (block.column === 'SPANNING') {
      band = spanning.indexOf(block);
    } else {
      const centerY = block.y + block.height / 2;
      band = spanning.filter((s) => s.y > centerY).length; // spanning blocks fully above
    }
    return { block, band, col: columnOrder[block.column] };
  });

  keyed.sort((a, b) => a.band - b.band || a.col - b.col || b.block.top - a.block.top || a.block.x - b.block.x);
  return keyed.map((k) => k.block);
}

// ---------------------------------------------------------------------------
// Step 5: table blocks → logical cells (see table.ts)
// ---------------------------------------------------------------------------

/** One TextBlock per logical cell, in place of the paragraph-style TABLE / figure blocks classify.ts produced. */
function cellBlock(cell: ResolvedCell, template: TextBlock): TextBlock {
  const info = cell.info;
  const figure = info.kind === 'figure';
  const lines: TextLine[] = cell.fragments.map((f) => ({
    page: template.page,
    text: f.text + (f.trailingMarker ?? ''),
    x: f.x,
    y: f.y,
    width: round(f.right - f.x),
    height: round(f.fontSize),
    fontSize: f.fontSize,
    fontName: f.fontName,
    fontRealName: f.fontRealName,
    column: template.column,
    items: f.items.map((r) => r.item),
  }));
  const first = cell.fragments[0];
  let blockType: DetailedBlockType;
  let skipReason: string | null = null;
  if (info.numeric) {
    blockType = figure ? 'FIGURE_LABEL' : 'TABLE_CELL';
    skipReason = 'NUMERIC_ONLY';
  } else if (figure) {
    blockType = 'FIGURE_LABEL';
    if (isAbbreviationOnly(cell.text)) skipReason = 'ABBREVIATION_ONLY';
    else if (isUntranslatableFigureText(cell.text)) skipReason = 'UNTRANSLATABLE';
    else if (!info.maskable) skipReason = 'FIGURE_NOT_MASKABLE';
  } else {
    blockType = info.header ? 'TABLE_HEADER' : 'TABLE_TEXT_LABEL';
    if (isAbbreviationOnly(cell.text)) skipReason = 'ABBREVIATION_ONLY';
    else if (isUntranslatableText(cell.text)) skipReason = 'UNTRANSLATABLE';
    else if (!info.maskable) skipReason = 'CELL_NOT_MASKABLE';
  }
  const type: BlockType = figure ? 'FIGURE' : 'TABLE';
  return {
    id: info.id,
    page: template.page,
    type,
    sectionType: template.sectionType,
    blockType,
    text: cell.text,
    x: info.textBox.x,
    y: info.textBox.y,
    width: info.textBox.width,
    height: info.textBox.height,
    top: round(info.textBox.y + info.textBox.height),
    fontSize: info.fontSize,
    fontName: first.fontName,
    fontRealName: first.fontRealName,
    column: template.column,
    lineCount: lines.length,
    lines,
    order: -1,
    translate: skipReason === null,
    skipReason,
    tableId: figure ? undefined : info.tableId,
    figureId: figure ? info.tableId : undefined,
    cell: info,
  };
}

/**
 * Regroup the TABLE blocks of every (page, table) into logical cells. A table
 * whose cells cannot be resolved keeps its blocks but they are no longer
 * translated (English is safer than overlapping Chinese).
 */
function resolveTables(blocks: TextBlock[], analysis: PdfAnalysis): { blocks: TextBlock[]; tables: TableSummary[] } {
  const groups = new Map<string, TextBlock[]>();
  for (const b of blocks) {
    if (b.type !== 'TABLE' || b.tableId === undefined) continue;
    const key = `${b.page}:${b.tableId}`;
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  if (groups.size === 0) return { blocks, tables: [] };

  const itemIndex = new Map<TextItemDebug, number>();
  analysis.items.forEach((item, i) => itemIndex.set(item, i));
  const pageById = new Map(analysis.pages.map((p) => [p.pageNumber, p]));

  // On a two-column page the right-hand cells of a full-width table come after
  // the left column in reading order, past the table note, and end up as OTHER
  // fragments. Short OTHER blocks inside the table's vertical band belong to it.
  const absorbed = new Map<string, string>(); // block id → group key
  for (const [key, group] of groups) {
    const page = group[0].page;
    const top = Math.max(...group.map((b) => b.top));
    const bottom = Math.min(...group.map((b) => b.y));
    const fs = group[0].fontSize;
    for (const b of blocks) {
      if (b.page !== page || b.type !== 'OTHER' || b.tableId !== undefined || absorbed.has(b.id)) continue;
      if (b.lineCount > 2 || b.text.split(/\s+/).length > 12) continue;
      if (b.top > top + 2 || b.y < bottom - 2) continue;
      if (b.fontSize < 0.75 * fs || b.fontSize > 1.3 * fs) continue;
      group.push(b);
      absorbed.set(b.id, key);
    }
  }

  const replacement = new Map<string, TextBlock[]>();
  const tables: TableSummary[] = [];
  for (const [key, group] of groups) {
    const first = group[0];
    const pageInfo = pageById.get(first.page);
    const items: TableItemRef[] = [];
    for (const b of group) {
      for (const line of b.lines) {
        for (const item of line.items) items.push({ index: itemIndex.get(item) ?? -1, item });
      }
    }
    const result = buildTableCells({
      page: first.page,
      tableId: first.tableId as number,
      items,
      rules: pageInfo?.rules ?? [],
      fills: pageInfo?.fills ?? [],
    });
    if (result.ok) {
      const cells = result.cells.map((c) => cellBlock(c, first));
      replacement.set(key, cells);
      tables.push({
        page: first.page,
        tableId: first.tableId as number,
        resolved: true,
        rows: result.rows,
        columns: result.columns,
        cells: cells.length,
        translatedCells: cells.filter((c) => c.translate).length,
        numericCells: cells.filter((c) => c.cell?.numeric).length,
        headerCells: cells.filter((c) => c.cell?.header).length,
        reason: null,
      });
    } else {
      for (const b of group) {
        b.translate = false;
        b.skipReason = `TABLE_UNRESOLVED:${result.reason}`;
      }
      replacement.set(key, group);
      tables.push({
        page: first.page,
        tableId: first.tableId as number,
        resolved: false,
        rows: 0,
        columns: 0,
        cells: 0,
        translatedCells: 0,
        numericCells: 0,
        headerCells: 0,
        reason: result.reason,
      });
    }
  }

  const out: TextBlock[] = [];
  const emitted = new Set<string>();
  for (const b of blocks) {
    const key = b.type === 'TABLE' && b.tableId !== undefined ? `${b.page}:${b.tableId}` : absorbed.get(b.id);
    if (key !== undefined) {
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push(...(replacement.get(key) ?? [b]));
    } else {
      out.push(b);
    }
  }
  out.forEach((b, i) => {
    b.order = i;
  });
  return { blocks: out, tables };
}

/** Block types that always keep their own pipeline, whatever a figure region covers. */
const FIGURE_EXCLUDED_TYPES: ReadonlySet<BlockType> = new Set(['HEADER', 'FOOTER', 'TITLE', 'AUTHOR', 'REFERENCE', 'CAPTION']);
/** Captions and notes keep the CAPTION pipeline; they are never absorbed into their own figure. */
const FIGURE_EXCLUDED_BLOCK_TYPES: ReadonlySet<DetailedBlockType> = new Set([
  'FIGURE_CAPTION',
  'FIGURE_NOTE',
  'TABLE_CAPTION',
  'TABLE_NOTE',
]);
/** A block inside a figure region is figure text when it is this much smaller than the body font... */
const FIGURE_TEXT_MAX_FONT_RATIO = 0.95;
/**
 * Axis labels, tick labels and axis titles sit just outside the drawing's own
 * ink, so membership is tested against the vector cluster grown by this much
 * (points). The type, font-size and line-count filters keep body text out.
 */
const FIGURE_REGION_MARGIN = 20;
/** A block in the caption's own font this close below / above it is the caption's second line, not figure text. */
const CAPTION_CONTINUATION_FONT_TOLERANCE = 0.03;
const CAPTION_CONTINUATION_LINES = 3;
/** ...and no longer than this many lines (a real paragraph that overlaps the region stays a paragraph). */
const FIGURE_TEXT_MAX_LINES = 4;

function blockRect(b: TextBlock): Rect {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** The vector cluster plus the margin its labels live in. */
function grown(r: Rect): Rect {
  const m = FIGURE_REGION_MARGIN;
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

/** Share of `b` that lies inside `region`. */
function insideShare(b: TextBlock, region: Rect): number {
  const r = blockRect(b);
  const w = Math.min(r.x + r.width, region.x + region.width) - Math.max(r.x, region.x);
  const h = Math.min(r.y + r.height, region.y + region.height) - Math.max(r.y, region.y);
  if (w <= 0 || h <= 0) return 0;
  const a = Math.max(1e-6, r.width * r.height);
  return (w * h) / a;
}

/**
 * Regroup the text of every detected figure into logical elements. A block is
 * absorbed only when it lies inside the figure's vector cluster, is not a
 * caption, note, header or footer, does not already belong to a table, and
 * looks like figure text (small font, few lines). Absorption is whole blocks,
 * so no source text item can end up in two units.
 */
function resolveFigures(
  blocks: TextBlock[],
  analysis: PdfAnalysis,
  bodyFontSize: number,
): { blocks: TextBlock[]; figures: FigureSummary[] } {
  const itemIndex = new Map<TextItemDebug, number>();
  analysis.items.forEach((item, i) => itemIndex.set(item, i));

  const figures: FigureSummary[] = [];
  const replacement = new Map<string, TextBlock[]>();
  const absorbed = new Map<string, string>(); // block id → figure key
  let figureId = 0;

  for (const pageInfo of analysis.pages) {
    const pageBlocks = blocks.filter((b) => b.page === pageInfo.pageNumber);
    const captionBlocks = pageBlocks.filter((b) => b.blockType === 'FIGURE_CAPTION');
    const captions: FigureCaptionRef[] = captionBlocks.map((b) => ({ id: b.id, box: blockRect(b) }));
    if (captions.length === 0) continue;
    const regions = detectFigureRegions(pageInfo, captions);

    /** The caption's wrapped second line keeps the CAPTION pipeline, whatever the region covers. */
    const continuesCaption = (b: TextBlock): boolean =>
      captionBlocks.some((c) => {
        if (Math.abs(b.fontSize - c.fontSize) > CAPTION_CONTINUATION_FONT_TOLERANCE * c.fontSize) return false;
        const gap = b.y >= c.top ? b.y - c.top : c.y - b.top;
        if (gap > CAPTION_CONTINUATION_LINES * c.fontSize) return false;
        return Math.min(b.x + b.width, c.x + c.width) - Math.max(b.x, c.x) > 0;
      });

    for (const region of regions) {
      const members = pageBlocks.filter((b) => {
        if (absorbed.has(b.id) || b.tableId !== undefined || b.cell) return false;
        if (FIGURE_EXCLUDED_TYPES.has(b.type) || FIGURE_EXCLUDED_BLOCK_TYPES.has(b.blockType)) return false;
        if (continuesCaption(b)) return false;
        if (insideShare(b, grown(region.bounds)) < 0.8) return false;
        return b.fontSize <= FIGURE_TEXT_MAX_FONT_RATIO * bodyFontSize && b.lineCount <= FIGURE_TEXT_MAX_LINES;
      });
      if (members.length === 0) continue;

      figureId++;
      const key = `${pageInfo.pageNumber}:${figureId}`;
      const items: TableItemRef[] = [];
      for (const b of members) {
        for (const line of b.lines) for (const item of line.items) items.push({ index: itemIndex.get(item) ?? -1, item });
      }
      const result = buildFigureCells({
        page: pageInfo.pageNumber,
        figureId,
        region: grown(region.bounds),
        items,
        rules: pageInfo.rules,
        fills: pageInfo.fills,
        frames: pageInfo.frames,
        images: pageInfo.images,
      });

      for (const b of members) absorbed.set(b.id, key);
      if (result.ok) {
        const cells = result.cells.map((c) => cellBlock(c, members[0]));
        replacement.set(key, cells);
        figures.push({
          page: pageInfo.pageNumber,
          figureId,
          resolved: true,
          containers: result.containers,
          structured: result.structured,
          cells: cells.length,
          translatedCells: cells.filter((c) => c.translate).length,
          numericCells: cells.filter((c) => c.cell?.numeric).length,
          textItems: items.length,
          reason: null,
        });
      } else {
        for (const b of members) {
          b.translate = false;
          b.skipReason = `FIGURE_UNRESOLVED:${result.reason}`;
        }
        replacement.set(key, members);
        figures.push({
          page: pageInfo.pageNumber,
          figureId,
          resolved: false,
          containers: 0,
          structured: false,
          cells: 0,
          translatedCells: 0,
          numericCells: 0,
          textItems: items.length,
          reason: result.reason,
        });
      }
    }
  }

  if (figures.length === 0) return { blocks, figures };

  const out: TextBlock[] = [];
  const emitted = new Set<string>();
  for (const b of blocks) {
    const key = absorbed.get(b.id);
    if (key !== undefined) {
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push(...(replacement.get(key) ?? [b]));
    } else {
      out.push(b);
    }
  }
  out.forEach((b, i) => {
    b.order = i;
  });
  return { blocks: out, figures };
}

/**
 * Source text items claimed by more than one block. Table and figure
 * resolution absorb whole blocks, so this must always be 0; it is reported so
 * a regression cannot silently translate and mask the same text twice.
 */
function countDuplicateSourceItems(blocks: readonly TextBlock[]): number {
  const seen = new Set<TextItemDebug>();
  let duplicates = 0;
  for (const b of blocks) {
    for (const line of b.lines) {
      for (const item of line.items) {
        if (seen.has(item)) duplicates++;
        else seen.add(item);
      }
    }
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Regroup TABLE blocks into logical cells (default true; false = the paragraph-style blocks, for A/B comparison). */
  resolveTables?: boolean;
  /** Regroup the text of detected figures into logical elements (default true). */
  resolveFigures?: boolean;
  /** Run the layout role detectors (sidebar / callout, structured abstract; default true). */
  detectLayoutRoles?: boolean;
}

export function analyzeLayout(analysis: PdfAnalysis, options: LayoutOptions = {}): LayoutResult {
  const bodyFontSize = computeBodyFontSize(analysis.items);
  const itemsByPage = new Map<number, TextItemDebug[]>();
  for (const item of analysis.items) {
    const list = itemsByPage.get(item.page);
    if (list) list.push(item);
    else itemsByPage.set(item.page, [item]);
  }

  const pageLayouts: PageLayout[] = [];
  const allBlocks: TextBlock[] = [];
  let lineCount = 0;
  const bandsByPage = new Map<number, TableBand[]>();

  for (const pageInfo of analysis.pages) {
    const items = itemsByPage.get(pageInfo.pageNumber) ?? [];
    const prelim = buildLines(items, pageInfo.pageNumber);
    const columns = detectColumns(prelim, pageInfo, bodyFontSize);

    const bands = tableBands(pageInfo, columns, prelim, bodyFontSize);
    if (bands.length) bandsByPage.set(pageInfo.pageNumber, bands);
    const regioned = prelim.map((l) => ({ ...l, column: assignRegion(l, columns, bands) }));
    const lines = mergeSameBaseline(regioned, pageInfo.pageNumber);
    lineCount += lines.length;

    const regions: ColumnRegion[] = columns.layout === 'TWO_COLUMN' ? ['LEFT', 'RIGHT', 'SPANNING'] : ['FULL'];
    let pageBlocks: TextBlock[] = [];
    for (const region of regions) {
      const inRegion = lines.filter((l) => l.column === region);
      // A table band is grouped on its own, so the last row of a table and
      // the legend right under it never end up in one block.
      const parts: TextLine[][] = [inRegion.filter((l) => !inBand(l.y, bands))];
      for (const band of bands) parts.push(inRegion.filter((l) => inBand(l.y, [band])));
      for (const part of parts) {
        if (part.length) pageBlocks.push(...groupBlocks(part, pageInfo.pageNumber, region));
      }
    }

    pageBlocks = orderBlocks(pageBlocks, columns.layout);
    pageBlocks.forEach((b, i) => {
      b.id = `p${pageInfo.pageNumber}-b${String(i + 1).padStart(3, '0')}`;
    });

    pageLayouts.push({
      pageNumber: pageInfo.pageNumber,
      layout: columns.layout,
      gutter: columns.gutter,
      width: pageInfo.width,
      height: pageInfo.height,
      view: pageInfo.view,
      lineCount: lines.length,
      blockCount: pageBlocks.length,
    });
    allBlocks.push(...pageBlocks);
  }

  allBlocks.forEach((b, i) => {
    b.order = i;
  });

  classifyBlocks(allBlocks, analysis.pages, bodyFontSize);

  const resolved = options.resolveTables === false ? { blocks: allBlocks, tables: [] } : resolveTables(allBlocks, analysis);
  const withFigures =
    options.resolveFigures === false
      ? { blocks: resolved.blocks, figures: [] }
      : resolveFigures(resolved.blocks, analysis, bodyFontSize);
  // Generic layout roles: sidebar / callout containers and structured
  // abstracts, on the final block set so table cells and figure elements
  // are already owned by their own pipelines (pdf/detectors/registry.ts).
  const roles =
    options.detectLayoutRoles === false
      ? emptyLayoutRoles(withFigures.blocks)
      : applyLayoutRoles(withFigures.blocks, analysis, pageLayouts, bodyFontSize);
  const finalBlocks = roles.blocks;

  // Last line of defence for a full-width table: a row of values still
  // standing inside a table band that the table pipeline did not turn into
  // cells is table furniture, never prose, whatever type it was given. It
  // keeps its text, it is simply not sent to the model and not overdrawn.
  // Running text inside a band (the legend of a framed figure) is left alone.
  let tableBandSuppressed = 0;
  for (const b of finalBlocks) {
    if (!b.translate || b.type === 'TABLE' || b.type === 'FIGURE' || b.type === 'CAPTION') continue;
    if (!isNumericRow(b.text)) continue;
    const bands = bandsByPage.get(b.page);
    if (!bands || !inBand(b.y + b.height / 2, bands)) continue;
    b.translate = false;
    b.skipReason = 'TABLE_BAND_UNRESOLVED';
    tableBandSuppressed++;
  }

  // Inline typography metadata and paragraph repair, both of which must see
  // the final block set (table cells and figure text are already carved out).
  let superscriptMarkerCount = 0;
  let superscriptBlockCount = 0;
  let superscriptGluedCount = 0;
  for (const block of finalBlocks) {
    if (block.cell) continue; // table cells and figure elements have their own marker path
    const lowered = collectBlockSubscripts(block);
    if (lowered.length > 0) block.subscripts = lowered;
    const found = collectBlockSuperscripts(block);
    if (found.markers.length === 0) continue;
    block.superscripts = found.markers;
    superscriptBlockCount++;
    superscriptMarkerCount += found.metadataCount + found.gluedCount;
    superscriptGluedCount += found.gluedCount;
  }
  const orphanPlan = absorbOrphanFragments(finalBlocks);

  const translationBlocks: TranslationBlock[] = buildTranslationBlocks(finalBlocks);

  const twoColumnPages = pageLayouts.filter((p) => p.layout === 'TWO_COLUMN').length;
  const context = contextStats(translationBlocks);
  const tables = resolved.tables;
  const figures = withFigures.figures;

  return {
    bodyFontSize,
    pages: pageLayouts,
    blocks: finalBlocks,
    translationBlocks,
    tables,
    figures,
    containers: roles.containers,
    structuredRegions: roles.regions,
    roleOwnership: roles.ownership,
    stats: {
      lineCount,
      blockCount: finalBlocks.length,
      translationBlockCount: translationBlocks.length,
      mergedBlockCount: translationBlocks.filter((b) => b.wasMerged).length,
      orphanMergedCount: orphanPlan.merges.length,
      orphanUnresolvedCount: orphanPlan.unresolved.length,
      superscriptMarkerCount,
      superscriptBlockCount,
      superscriptGluedCount,
      incompleteBlockCount: translationBlocks.filter((b) => b.incompleteSource).length,
      twoColumnPages,
      singleColumnPages: pageLayouts.length - twoColumnPages,
      ...context,
      tableCount: tables.length,
      tableCellCount: tables.reduce((n, t) => n + t.cells, 0),
      tableTranslatedCells: tables.reduce((n, t) => n + t.translatedCells, 0),
      tableNumericCells: tables.reduce((n, t) => n + t.numericCells, 0),
      tableUnresolvedCount: tables.filter((t) => !t.resolved).length,
      figureCount: figures.length,
      figureCellCount: figures.reduce((n, f) => n + f.cells, 0),
      figureTranslatedCells: figures.reduce((n, f) => n + f.translatedCells, 0),
      figureNumericCells: figures.reduce((n, f) => n + f.numericCells, 0),
      figureUnresolvedCount: figures.filter((f) => !f.resolved).length,
      tableBandCount: [...bandsByPage.values()].reduce((n, b) => n + b.length, 0),
      tableBandSuppressed,
      duplicateSourceItems: countDuplicateSourceItems(finalBlocks),
      structuredRegionCount: roles.regions.length,
      structuredLabelCount: roles.regions.reduce((n, r) => n + r.sections.length, 0),
      sidebarCount: roles.containers.filter((c) => c.type === 'SIDEBAR').length,
      calloutCount: roles.containers.filter((c) => c.type === 'CALLOUT_BOX').length,
      sidebarChildCount: roles.containers.reduce((n, c) => n + c.children.length, 0),
      roleClaimedSourceItems: countRoleClaimedItems(finalBlocks),
    },
  };
}
