/**
 * Phase C: heuristic layout analysis.
 *
 *   text items  →  lines  →  column regions  →  blocks  →  reading order
 *
 * Everything is coordinate based. No machine learning, no reliance on hasEOL.
 * Classification (TITLE / BODY / ...) and translate decisions live in classify.ts.
 */

import { classifyBlocks, isAbbreviationOnly, isUntranslatableText } from './classify';
import { buildTranslationBlocks, contextStats } from './merge';
import { buildTableCells, type ResolvedCell, type TableItemRef } from './table';
import { joinLines } from './text';
import type {
  ColumnLayout,
  ColumnRegion,
  DetailedBlockType,
  LayoutResult,
  PageDebugInfo,
  PageLayout,
  PdfAnalysis,
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
/** Horizontal gap above this × fontSize splits a baseline cluster into separate lines. */
const LINE_GAP_SPLIT = 0.8;
/** Second pass inside one column: lines on the same baseline closer than this are merged. */
const LINE_GAP_MERGE = 2.0;
/** A gap wider than this × fontSize between items becomes a space character. */
const WORD_GAP = 0.12;
/** Minimum body lines on each side of the page to call it two-column. */
const MIN_COLUMN_LINES = 5;
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
 * Cluster items by baseline, then split each cluster by horizontal gaps.
 * Produces "preliminary" lines: a two-column page yields separate lines for
 * the left and right column because the gutter is wider than LINE_GAP_SPLIT.
 */
function buildLines(items: TextItemDebug[], page: number): TextLine[] {
  const byY = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  // 1. baseline clusters
  const clusters: TextItemDebug[][] = [];
  let current: TextItemDebug[] = [];
  let refY = 0;
  let refFs = 0;
  for (const item of byY) {
    if (current.length === 0) {
      current = [item];
      refY = item.y;
      refFs = item.fontSize;
      continue;
    }
    const tol = BASELINE_TOLERANCE * Math.max(refFs, item.fontSize);
    if (Math.abs(refY - item.y) <= tol) {
      current.push(item);
      if (item.text.trim().length > 2 && item.fontSize >= refFs) {
        refY = item.y;
        refFs = item.fontSize;
      }
    } else {
      clusters.push(current);
      current = [item];
      refY = item.y;
      refFs = item.fontSize;
    }
  }
  if (current.length) clusters.push(current);

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

function assignRegion(line: TextLine, columns: ColumnInfo): ColumnRegion {
  if (columns.layout === 'SINGLE_COLUMN' || !columns.gutter) return 'FULL';
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

/** One TextBlock per logical cell, in place of the paragraph-style TABLE blocks classify.ts produced. */
function cellBlock(cell: ResolvedCell, template: TextBlock): TextBlock {
  const info = cell.info;
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
    blockType = 'TABLE_CELL';
    skipReason = 'NUMERIC_ONLY';
  } else {
    blockType = info.header ? 'TABLE_HEADER' : 'TABLE_TEXT_LABEL';
    if (isAbbreviationOnly(cell.text)) skipReason = 'ABBREVIATION_ONLY';
    else if (isUntranslatableText(cell.text)) skipReason = 'UNTRANSLATABLE';
  }
  return {
    id: info.id,
    page: template.page,
    type: 'TABLE',
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
    tableId: info.tableId,
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Regroup TABLE blocks into logical cells (default true; false = the paragraph-style blocks, for A/B comparison). */
  resolveTables?: boolean;
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

  for (const pageInfo of analysis.pages) {
    const items = itemsByPage.get(pageInfo.pageNumber) ?? [];
    const prelim = buildLines(items, pageInfo.pageNumber);
    const columns = detectColumns(prelim, pageInfo, bodyFontSize);

    const regioned = prelim.map((l) => ({ ...l, column: assignRegion(l, columns) }));
    const lines = mergeSameBaseline(regioned, pageInfo.pageNumber);
    lineCount += lines.length;

    const regions: ColumnRegion[] = columns.layout === 'TWO_COLUMN' ? ['LEFT', 'RIGHT', 'SPANNING'] : ['FULL'];
    let pageBlocks: TextBlock[] = [];
    for (const region of regions) {
      pageBlocks.push(...groupBlocks(lines.filter((l) => l.column === region), pageInfo.pageNumber, region));
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
  const finalBlocks = resolved.blocks;
  const translationBlocks: TranslationBlock[] = buildTranslationBlocks(finalBlocks);

  const twoColumnPages = pageLayouts.filter((p) => p.layout === 'TWO_COLUMN').length;
  const context = contextStats(translationBlocks);
  const tables = resolved.tables;

  return {
    bodyFontSize,
    pages: pageLayouts,
    blocks: finalBlocks,
    translationBlocks,
    tables,
    stats: {
      lineCount,
      blockCount: finalBlocks.length,
      translationBlockCount: translationBlocks.length,
      mergedBlockCount: translationBlocks.filter((b) => b.wasMerged).length,
      incompleteBlockCount: translationBlocks.filter((b) => b.incompleteSource).length,
      twoColumnPages,
      singleColumnPages: pageLayouts.length - twoColumnPages,
      ...context,
      tableCount: tables.length,
      tableCellCount: tables.reduce((n, t) => n + t.cells, 0),
      tableTranslatedCells: tables.reduce((n, t) => n + t.translatedCells, 0),
      tableNumericCells: tables.reduce((n, t) => n + t.numericCells, 0),
      tableUnresolvedCount: tables.filter((t) => !t.resolved).length,
    },
  };
}
