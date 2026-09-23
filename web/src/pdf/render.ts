/**
 * Phase D–F: write the translation back into the original PDF with pdf-lib.
 *
 *   original bytes ─► PDFDocument.load ─► per page:
 *       1. white rectangles over every source LINE of an eligible unit
 *       2. the Chinese translation, wrapped and fitted into the block box
 *   ─► save ─► Uint8Array for download
 *
 * Coordinates: PDF.js text items and pdf-lib drawing both use PDF user space
 * (points, origin bottom-left, y up), so block/line geometry from layout.ts is
 * used as-is. Pages with /Rotate ≠ 0 are skipped in this version.
 *
 * Debug mode draws red boxes around eligible blocks (blue: their lines, grey:
 * units that are translated but not overlaid, green dashed: images) without
 * masking anything, so the coordinate mapping can be checked first.
 */

import {
  beginText,
  concatTransformationMatrix,
  degrees,
  EncryptedPDFError,
  endText,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  StandardFonts,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFName,
  type PDFPage,
} from 'pdf-lib';
import { fitTextToBoxes, type BoxSpec, MAX_EXTENSION_RATIO } from './fit';
import { embedFontSet, FontLoadError, MixedFont, sanitizeForFont, type FontSetBytes, type TextRun } from './font';
import { GLYPH_ASCENT, GLYPH_DESCENT } from './layout';
import {
  clipMaskToRules,
  fitTextToTableCell,
  placeTableCellLines,
  tableCellMaskRects,
  type CellPlacement,
  type TableFitResult,
} from './table';
import type {
  BlockType,
  ImageBox,
  LayoutResult,
  PageDebugInfo,
  PdfAnalysis,
  Rect,
  TableCellInfo,
  TextBlock,
  TextLine,
  TranslationBlock,
  TranslationEntry,
} from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Block types written back in this version (TABLE: translated table labels / headers). */
export const OVERLAY_TYPES: ReadonlySet<BlockType> = new Set(['TITLE', 'HEADING', 'BODY', 'CAPTION', 'FOOTNOTE', 'TABLE']);
/** Leading footnote marker in the source text: "1 ", "12 ", "* ", "∗" (U+2217, math fonts), "† ", "¹ ". */
const FOOTNOTE_MARKER_RE = /^(\d{1,3}|[*∗⁎†‡§¶]{1,2}|[¹²³⁴⁵⁶⁷⁸⁹⁰]{1,3})(?=\s|[A-Z(\[“"])/;
/** Horizontal / vertical padding of the white mask around each source line (points). */
const MASK_PAD_X = 1.5;
const MASK_PAD_Y = 1;
/** A block overlapping an image by more than this fraction of its area is left alone. */
const IMAGE_OVERLAP_RATIO = 0.1;
/** Images covering more than this fraction of the page are treated as background. */
const BACKGROUND_IMAGE_RATIO = 0.9;
/** |b| or |c| of the text matrix above this means rotated / skewed text. */
const ROTATION_EPS = 0.02;
/** Keep this distance from the page bottom when extending a block downward. */
const PAGE_BOTTOM_MARGIN = 2;
/** Yield to the event loop after this many blocks so the UI can repaint. */
const YIELD_EVERY_BLOCKS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderMode = 'overlay' | 'debug';

/**
 * translated: the original pages are modified in place (masks + Chinese).
 * bilingual:  a new document; every output page is a spread with the untouched
 *             original page on the left and the translated page on the right.
 */
export type RenderOutput = 'translated' | 'bilingual';

/** White gutter between the two halves of a spread (points). */
export const BILINGUAL_GAP = 14;

export interface RenderProgress {
  stage: string;
  page: number;
  pageCount: number;
  /** 0–100 */
  percent: number;
}

/** Table-cell details of a report (Developer Mode table diagnostics). */
export interface CellReport {
  tableId: number;
  row: number;
  column: number;
  sourceText: string;
  /** Font size at which the cell still did not fit (overflow), or the size it was drawn with. */
  finalFontSize: number;
  /** HEIGHT / WIDTH when the cell overflowed, null when it was written. */
  overflowReason: string | null;
}

export interface BlockRenderReport {
  unitId: string;
  sourceBlockIds: string[];
  page: number;
  type: BlockType;
  /** Present for logical table cells. */
  cell?: CellReport;
  /** Original font size of the first source block. */
  fontSize: number;
  finalFontSize: number | null;
  lines: number;
  /** True when the layout is not reliable (overflow, page clipping, draw failure). */
  warning: boolean;
  /** Warning or skip reason, null when everything went fine. */
  reason: string | null;
  /** Human readable detail. */
  message: string | null;
  skipped: boolean;
  /** Characters drawn with the fallback font because the primary font lacks the glyph. */
  fallbackGlyphs: number;
}

export interface RenderStats {
  pagesRendered: number;
  unitsWritten: number;
  unitsSkipped: number;
  masksDrawn: number;
  replacedChars: number;
  /** Total glyphs drawn with the fallback font (see BlockRenderReport.fallbackGlyphs). */
  fontFallbackCount: number;
  /** Logical table cells with a translation on the rendered pages. */
  tableCells: number;
  /** Table cells masked and rewritten. */
  tableCellsWritten: number;
  /** Table cells whose translation did not fit even at the minimum size: kept in English. */
  tableCellsOverflow: number;
}

export interface RenderResult {
  bytes: Uint8Array;
  fileName: string;
  mode: RenderMode;
  output: RenderOutput;
  /** e.g. "LXGW WenKai TC + Liberation Serif (fallback Noto Sans TC)"; "—" in debug mode. */
  fonts: string;
  reports: BlockRenderReport[];
  warnings: BlockRenderReport[];
  stats: RenderStats;
}

export interface RenderOptions {
  /** The untouched bytes of the original file. */
  pdfBytes: ArrayBuffer;
  fileName: string;
  analysis: PdfAnalysis;
  layout: LayoutResult;
  entries: ReadonlyMap<string, TranslationEntry>;
  mode: RenderMode;
  /** Default 'translated'. */
  output?: RenderOutput;
  /** Gutter between the halves of a bilingual spread (points). */
  gap?: number;
  /**
   * Pages to process (1-based). null = every page. translated: other pages
   * stay untouched; bilingual: only these pages produce a spread.
   */
  pages?: ReadonlySet<number> | null;
  /** Restrict to these translation unit ids. null = all units. */
  unitIds?: ReadonlySet<string> | null;
  /** Required in overlay mode: the loaded font files (see font.ts loadFontSet). */
  fonts?: FontSetBytes | null;
  onProgress?: (progress: RenderProgress) => void;
}

export type RenderErrorKind = 'ENCRYPTED' | 'LOAD_FAILED' | 'FONT' | 'SAVE_FAILED' | 'MEMORY';

export class RenderError extends Error {
  readonly kind: RenderErrorKind;
  constructor(kind: RenderErrorKind, message: string) {
    super(message);
    this.name = 'RenderError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function isFiniteBox(b: { x: number; y: number; width: number; height: number }): boolean {
  return [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
}

function intersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Images that are not full-page backgrounds. */
function foregroundImages(page: PageDebugInfo): ImageBox[] {
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.max(1, (x1 - x0) * (y1 - y0));
  return page.images.filter((img) => (img.width * img.height) / pageArea < BACKGROUND_IMAGE_RATIO);
}

function overlapsImage(block: TextBlock, page: PageDebugInfo): boolean {
  const area = block.width * block.height;
  if (area <= 0) return false;
  let covered = 0;
  for (const img of foregroundImages(page)) covered += intersectionArea(block, img);
  return covered / area > IMAGE_OVERLAP_RATIO;
}

function hasRotatedText(block: TextBlock): boolean {
  for (const line of block.lines) {
    for (const item of line.items) {
      const [a, b, c, d] = item.transform;
      const scale = Math.max(Math.abs(a), Math.abs(d), 1e-6);
      if (Math.abs(b) > ROTATION_EPS * scale || Math.abs(c) > ROTATION_EPS * scale) return true;
    }
  }
  return false;
}

function isInsidePage(block: TextBlock, page: PageDebugInfo): boolean {
  const [x0, y0, x1, y1] = page.view;
  const slack = 2;
  return block.x >= x0 - slack && block.y >= y0 - slack && block.x + block.width <= x1 + slack && block.top <= y1 + slack;
}

function assessUnit(
  unit: TranslationBlock,
  blockById: ReadonlyMap<string, TextBlock>,
  pageById: ReadonlyMap<number, PageDebugInfo>,
): string | null {
  if (!OVERLAY_TYPES.has(unit.type)) return `TYPE_${unit.type}`;
  for (const id of unit.sourceBlockIds) {
    const block = blockById.get(id);
    if (!block) return 'SOURCE_MISSING';
    const page = pageById.get(block.page);
    if (!page) return 'PAGE_MISSING';
    if (page.rotation % 360 !== 0) return 'PAGE_ROTATED';
    if (!isFiniteBox(block) || block.lines.length === 0) return 'INVALID_COORDINATES';
    if (!isInsidePage(block, page)) return 'OUT_OF_PAGE';
    if (hasRotatedText(block)) return 'ROTATED_TEXT';
    if (overlapsImage(block, page)) return 'IMAGE_OVERLAP';
  }
  return null;
}

/**
 * Decide for every translation unit whether the overlay renderer will touch it.
 * Mutates `overlayEligible` / `overlaySkippedReason` on the units so the UI can
 * show them. Safe to call again.
 */
export function assessOverlay(layout: LayoutResult, analysis: PdfAnalysis): void {
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  const pageById = new Map(analysis.pages.map((p) => [p.pageNumber, p]));
  for (const unit of layout.translationBlocks) {
    const reason = assessUnit(unit, blockById, pageById);
    unit.overlayEligible = reason === null;
    unit.overlaySkippedReason = reason;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function outputFileName(originalName: string, suffix: string): string {
  const base = originalName.replace(/\.pdf$/i, '') || 'document';
  return `${base}${suffix}.pdf`;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Vertical extent of one source line from its items (superscripts included). */
function lineExtent(line: TextLine): { top: number; bottom: number } {
  let top = line.y + GLYPH_ASCENT * line.fontSize;
  let bottom = line.y - GLYPH_DESCENT * line.fontSize;
  for (const item of line.items) {
    top = Math.max(top, item.y + GLYPH_ASCENT * item.fontSize);
    bottom = Math.min(bottom, item.y - GLYPH_DESCENT * item.fontSize);
  }
  return { top, bottom };
}

/** Multi-line blocks whose lines all share the block's centre are centred (titles, some headings). */
function isCenteredBlock(block: TextBlock, page: PageDebugInfo): boolean {
  if (block.type !== 'TITLE' && block.type !== 'HEADING') return false;
  const center = block.x + block.width / 2;
  if (block.lines.length >= 2) {
    const tol = Math.max(2, 0.04 * block.width);
    const allCentered = block.lines.every((l) => Math.abs(l.x + l.width / 2 - center) <= tol);
    const notFlushLeft = block.lines.some((l) => l.x - block.x > 2);
    return allCentered && notFlushLeft;
  }
  // Single line: centred on the page (single-column or spanning) is the only reliable signal.
  if (block.column === 'FULL' || block.column === 'SPANNING') {
    const [x0, , x1] = page.view;
    const pageCenter = (x0 + x1) / 2;
    return Math.abs(center - pageCenter) <= 3 && block.x - x0 > 30;
  }
  return false;
}

/** Extension allowed below a block: 25 % of its height, but never past the page bottom. */
function extensionFor(block: TextBlock, page: PageDebugInfo): number {
  const pageBottom = page.view[1] + PAGE_BOTTOM_MARGIN;
  return Math.max(0, Math.min(MAX_EXTENSION_RATIO * block.height, block.y - pageBottom));
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

const WHITE = rgb(1, 1, 1);
const ORANGE = rgb(0.95, 0.5, 0.05);
const RED = rgb(0.85, 0.1, 0.1);
const BLUE = rgb(0.15, 0.35, 0.9);
const GREY = rgb(0.55, 0.55, 0.55);
const GREEN = rgb(0.1, 0.6, 0.2);
const SEPARATOR = rgb(0.82, 0.82, 0.82);

/** Where an embedded original page goes on a spread, honouring /Rotate. */
interface PagePlacement {
  x: number;
  y: number;
  rotateDegrees: number;
  displayWidth: number;
  displayHeight: number;
}

/**
 * The embedded page's form matrix already moves its view box to (0, 0), so its
 * content spans [0, W] × [0, H] before rotation. /Rotate is clockwise; pdf-lib's
 * rotate option is counter-clockwise, hence the sign flip. The rotated box is
 * shifted so its bottom-left corner lands at (offsetX, 0).
 */
function pagePlacement(pageInfo: PageDebugInfo, offsetX: number): PagePlacement {
  const [x0, y0, x1, y1] = pageInfo.view;
  const w = x1 - x0;
  const h = y1 - y0;
  const rotation = ((pageInfo.rotation % 360) + 360) % 360;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad) * 1e6) / 1e6;
  const sin = Math.round(Math.sin(rad) * 1e6) / 1e6;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [cx, cy] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ]) {
    xs.push(cx * cos - cy * sin);
    ys.push(cx * sin + cy * cos);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: offsetX - minX,
    y: -minY,
    rotateDegrees: -rotation,
    displayWidth: Math.max(...xs) - minX,
    displayHeight: Math.max(...ys) - minY,
  };
}

/** "#f4f3ec" → pdf-lib colour; white when the string is not a hex colour. */
function hexColor(hex: string | null) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return WHITE;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/**
 * Table cell: one mask per source line, clipped to the cell interior (table
 * rules and neighbouring cells stay untouched), in the cell's background colour.
 */
function drawCellMasks(page: PDFPage, block: TextBlock, cell: TableCellInfo, pageInfo: PageDebugInfo): number {
  const [x0, y0, x1, y1] = pageInfo.view;
  const boxes = block.lines.map((line) => {
    const { top, bottom } = lineExtent(line);
    return { x: line.x, right: line.x + line.width, top, bottom };
  });
  const color = hexColor(cell.background);
  let drawn = 0;
  for (const r of tableCellMaskRects(cell, boxes)) {
    const left = clamp(r.x, x0, x1);
    const right = clamp(r.x + r.width, x0, x1);
    const lo = clamp(r.y, y0, y1);
    const hi = clamp(r.y + r.height, y0, y1);
    if (right - left <= 0 || hi - lo <= 0) continue;
    page.drawRectangle({ x: left, y: lo, width: right - left, height: hi - lo, color, borderWidth: 0 });
    drawn++;
  }
  return drawn;
}

function drawLineMask(page: PDFPage, line: TextLine, pageInfo: PageDebugInfo): boolean {
  const [x0, y0, x1, y1] = pageInfo.view;
  const { top, bottom } = lineExtent(line);
  const left = clamp(line.x - MASK_PAD_X, x0, x1);
  const right = clamp(line.x + line.width + MASK_PAD_X, x0, x1);
  let lo = clamp(bottom - MASK_PAD_Y, y0, y1);
  let hi = clamp(top + MASK_PAD_Y, y0, y1);
  if (pageInfo.rules.length > 0) {
    // A table border right under a caption / note sits inside the padding: leave it alone.
    const clipped = clipMaskToRules({ x: left, y: lo, width: right - left, height: hi - lo }, line.y, line.fontSize, pageInfo.rules);
    lo = clipped.y;
    hi = clipped.y + clipped.height;
  }
  if (right - left <= 0 || hi - lo <= 0) return false;
  page.drawRectangle({ x: left, y: lo, width: right - left, height: hi - lo, color: WHITE, borderWidth: 0 });
  return true;
}

interface DrawTextOutcome {
  drawn: number;
  clipped: number;
  error: string | null;
}

/**
 * Writes mixed-font lines with raw text operators: one BT…ET per line, one
 * Tf + Tj per run. The text position advances after every Tj, so runs in
 * different fonts join seamlessly. Each font gets one resource entry per page
 * (pdf-lib's drawText/setFont would add one per call).
 */
class PageTextWriter {
  private readonly keys = new Map<PDFFont, PDFName>();

  constructor(private readonly page: PDFPage) {}

  private key(font: PDFFont): PDFName {
    let key = this.keys.get(font);
    if (!key) {
      key = this.page.node.newFontDictionary(font.name, font.ref);
      this.keys.set(font, key);
    }
    return key;
  }

  drawRuns(runs: readonly TextRun[], x: number, y: number, size: number): void {
    const ops = [beginText(), setFillingRgbColor(0, 0, 0), setTextMatrix(1, 0, 0, 1, x, y)];
    for (const run of runs) ops.push(setFontAndSize(this.key(run.font), size), showText(run.font.encodeText(run.text)));
    ops.push(endText());
    this.page.pushOperators(...ops);
  }
}

function drawBlockText(
  writer: PageTextWriter,
  block: TextBlock,
  pageInfo: PageDebugInfo,
  lines: readonly string[],
  fontSize: number,
  lineHeight: number,
  mixed: MixedFont,
  centered: boolean,
): DrawTextOutcome {
  const pageBottom = pageInfo.view[1];
  let baseline = block.top - GLYPH_ASCENT * fontSize;
  let drawn = 0;
  let clipped = 0;
  for (const line of lines) {
    if (baseline - GLYPH_DESCENT * fontSize < pageBottom) {
      clipped++;
      baseline -= lineHeight;
      continue;
    }
    if (line.length > 0) {
      let x = block.x;
      if (centered) {
        const w = mixed.widthOfTextAtSize(line, fontSize);
        x = block.x + Math.max(0, (block.width - w) / 2);
      }
      try {
        writer.drawRuns(mixed.runs(line), x, baseline, fontSize);
      } catch (err) {
        return { drawn, clipped, error: err instanceof Error ? err.message : String(err) };
      }
    }
    drawn++;
    baseline -= lineHeight;
  }
  return { drawn, clipped, error: null };
}

/** Debug PDF: table cells in orange (solid: source text box, dashed: usable rectangle). */
function drawDebugCell(page: PDFPage, block: TextBlock, cell: TableCellInfo, labelFont: PDFFont): void {
  const rect = (r: Rect, dashed: boolean) =>
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: Math.max(0.1, r.width),
      height: Math.max(0.1, r.height),
      borderColor: ORANGE,
      borderWidth: dashed ? 0.4 : 0.6,
      borderDashArray: dashed ? [1.5, 1.5] : undefined,
      color: undefined,
    });
  rect(cell.usable, true);
  rect(cell.textBox, false);
  try {
    page.drawText(`t${cell.tableId} r${cell.rowIndex}c${cell.columnIndex}${cell.numeric ? ' #' : ''}`, {
      x: cell.usable.x + 0.5,
      y: cell.usable.y + cell.usable.height - 3.5,
      size: 3,
      font: labelFont,
      color: ORANGE,
    });
  } catch {
    // labels are optional
  }
  void block;
}

function drawDebugPage(
  page: PDFPage,
  pageInfo: PageDebugInfo,
  units: readonly TranslationBlock[],
  blockById: ReadonlyMap<string, TextBlock>,
  labelFont: PDFFont,
  cellBlocks: readonly TextBlock[] = [],
): void {
  const [, , , pageTop] = pageInfo.view;
  for (const block of cellBlocks) {
    if (block.cell && block.page === pageInfo.pageNumber) drawDebugCell(page, block, block.cell, labelFont);
  }
  for (const img of foregroundImages(pageInfo)) {
    page.drawRectangle({
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
      borderColor: GREEN,
      borderWidth: 0.6,
      borderDashArray: [3, 2],
      color: undefined,
    });
  }
  for (const unit of units) {
    const eligible = unit.overlayEligible === true;
    for (const id of unit.sourceBlockIds) {
      const block = blockById.get(id);
      if (!block || block.page !== pageInfo.pageNumber || !isFiniteBox(block)) continue;
      if (block.cell) continue; // drawn above in the table style
      if (eligible) {
        for (const line of block.lines) {
          const { top, bottom } = lineExtent(line);
          page.drawRectangle({
            x: line.x,
            y: bottom,
            width: Math.max(0.1, line.width),
            height: Math.max(0.1, top - bottom),
            borderColor: BLUE,
            borderWidth: 0.3,
            color: undefined,
          });
        }
      }
      page.drawRectangle({
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        borderColor: eligible ? RED : GREY,
        borderWidth: eligible ? 0.8 : 0.5,
        borderDashArray: eligible ? undefined : [2, 2],
        color: undefined,
      });
      const label = eligible ? block.id : `${block.id} ${unit.overlaySkippedReason ?? 'skip'}`;
      const labelSize = 5;
      const labelY = block.top + 1.5 + labelSize > pageTop ? block.y - labelSize - 1 : block.top + 1.5;
      try {
        page.drawText(label.replace(/[^\x20-\x7e]/g, '?'), {
          x: block.x,
          y: labelY,
          size: labelSize,
          font: labelFont,
          color: eligible ? RED : GREY,
        });
      } catch {
        // labels are optional
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Unit layout (fit once per unit, even when it spans two pages)
// ---------------------------------------------------------------------------

interface UnitLayout {
  fontSize: number;
  lineHeight: number;
  /** Lines per source block id. */
  parts: Map<string, string[]>;
  fits: boolean;
  extended: boolean;
  overflow: number;
  replaced: number;
  fallbackGlyphs: number;
  iterations: number;
  minFontSize: number;
  /** Table cell: the table-only fit and where its lines go. */
  table?: { fit: TableFitResult; placement: CellPlacement };
}

/**
 * Table cell: fit into the cell's usable rectangle with the table-only rules
 * (no downward extension, 5 pt floor). The width depends on the alignment:
 * a left-aligned cell keeps its own left edge, a right-aligned one its right edge.
 */
function layoutTableCell(translation: string, block: TextBlock, cell: TableCellInfo, mixed: MixedFont): UnitLayout {
  const { text, replaced } = sanitizeForFont(translation, mixed);
  const usableRight = cell.usable.x + cell.usable.width;
  const width =
    cell.alignment === 'left'
      ? usableRight - Math.max(cell.usable.x, cell.textBox.x)
      : cell.alignment === 'right'
        ? Math.min(usableRight, cell.textBox.x + cell.textBox.width) - cell.usable.x
        : cell.usable.width;
  const fit = fitTextToTableCell({
    text,
    width: Math.max(1, width),
    height: cell.usable.height,
    originalFontSize: cell.fontSize,
    font: mixed,
    trailingMarker: cell.trailingMarker,
  });
  const placement = placeTableCellLines(cell, fit, mixed);
  return {
    fontSize: fit.fontSize,
    lineHeight: fit.lineHeight,
    parts: new Map([[block.id, fit.lines]]),
    fits: fit.fits,
    extended: false,
    overflow: fit.overflow,
    replaced,
    fallbackGlyphs: mixed.fallbackCount(text),
    iterations: fit.iterations,
    minFontSize: fit.minFontSize,
    table: { fit, placement },
  };
}

/** Draw the fitted lines of a table cell at their placed positions, plus the footnote marker. */
function drawTableCellText(writer: PageTextWriter, placement: CellPlacement, fontSize: number, mixed: MixedFont): DrawTextOutcome {
  let drawn = 0;
  try {
    for (const line of placement.lines) {
      if (line.text.length > 0) writer.drawRuns(mixed.runs(line.text), line.x, line.y, fontSize);
      drawn++;
    }
    const m = placement.marker;
    if (m) writer.drawRuns(mixed.runs(m.text), m.x, m.y, m.fontSize);
  } catch (err) {
    return { drawn, clipped: 0, error: err instanceof Error ? err.message : String(err) };
  }
  return { drawn, clipped: 0, error: null };
}

/** Footnotes keep their marker: if the translation dropped "1 " / "* " / "¹ ", put the source's back. */
function keepFootnoteMarker(unit: TranslationBlock, translation: string): string {
  if (unit.type !== 'FOOTNOTE') return translation;
  const marker = FOOTNOTE_MARKER_RE.exec(unit.text.trimStart())?.[1];
  if (!marker) return translation;
  const t = translation.trimStart();
  if (t.startsWith(marker)) return t;
  return `${marker} ${t}`;
}

function layoutUnit(
  unit: TranslationBlock,
  translation: string,
  sources: readonly TextBlock[],
  pageById: ReadonlyMap<number, PageDebugInfo>,
  mixed: MixedFont,
): UnitLayout {
  const { text, replaced } = sanitizeForFont(keepFootnoteMarker(unit, translation), mixed);
  const boxes: BoxSpec[] = sources.map((b) => {
    const pageInfo = pageById.get(b.page);
    return { width: b.width, height: b.height, maxExtension: pageInfo ? extensionFor(b, pageInfo) : 0 };
  });
  const originalFontSize = sources[0].fontSize;
  const result = fitTextToBoxes(text, boxes, originalFontSize, mixed);
  const parts = new Map<string, string[]>();
  sources.forEach((b, i) => parts.set(b.id, result.parts[i]?.lines ?? []));
  return {
    fontSize: result.fontSize,
    lineHeight: result.lineHeight,
    parts,
    fits: result.fits,
    extended: result.extended,
    overflow: result.overflow,
    replaced,
    fallbackGlyphs: mixed.fallbackCount(text),
    iterations: result.iterations,
    minFontSize: result.minFontSize,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function hasTranslation(entry: TranslationEntry | undefined): entry is TranslationEntry & { translation: string } {
  return !!entry && (entry.status === 'done' || entry.status === 'cached') && !!entry.translation?.trim();
}

export async function generateTranslatedPdf(options: RenderOptions): Promise<RenderResult> {
  const { analysis, layout, entries, mode } = options;
  const output: RenderOutput = options.output ?? 'translated';
  const bilingual = output === 'bilingual';
  const gap = options.gap ?? BILINGUAL_GAP;
  const onProgress = options.onProgress ?? (() => undefined);
  const pageCount = analysis.pageCount;
  const report = (stage: string, page: number, done: number) =>
    onProgress({ stage, page, pageCount, percent: pageCount ? Math.round((done / pageCount) * 100) : 0 });

  // 1. load the original -----------------------------------------------------
  report('Preparing PDF...', 0, 0);
  let sourceDoc: PDFDocument;
  try {
    sourceDoc = await PDFDocument.load(options.pdfBytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError) {
      throw new RenderError('ENCRYPTED', 'This PDF is encrypted. Remove the password (e.g. print to PDF) and try again.');
    }
    throw new RenderError('LOAD_FAILED', `pdf-lib could not open the PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pdfPages = sourceDoc.getPages();
  if (pdfPages.length !== pageCount) {
    console.warn(`[PDF Render] pdf-lib sees ${pdfPages.length} pages, PDF.js saw ${pageCount}. Using page indices as-is.`);
  }

  // translated: draw straight onto the original pages.
  // bilingual:  a new document that receives the original pages as XObjects.
  const doc = bilingual ? await PDFDocument.create() : sourceDoc;
  if (bilingual) {
    const title = sourceDoc.getTitle();
    if (title) doc.setTitle(`${title} (zh-TW bilingual)`);
  }

  // 2. fonts -----------------------------------------------------------------
  let mixed: MixedFont | null = null;
  let fontsLabel = '—';
  let labelFont: PDFFont | null = null;
  if (mode === 'overlay') {
    report('Loading font...', 0, 0);
    if (!options.fonts) throw new RenderError('FONT', 'The fonts were not loaded.');
    try {
      const fontSet = await embedFontSet(doc, options.fonts);
      mixed = new MixedFont(fontSet);
      fontsLabel = fontSet.label;
    } catch (err) {
      throw new RenderError('FONT', err instanceof FontLoadError ? err.message : String(err));
    }
  } else {
    labelFont = await doc.embedFont(StandardFonts.Helvetica);
  }

  // 3. indices ---------------------------------------------------------------
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  const pageById = new Map(analysis.pages.map((p) => [p.pageNumber, p]));
  const selectedPages = options.pages ?? new Set(analysis.pages.map((p) => p.pageNumber));
  const units = layout.translationBlocks.filter((u) => !options.unitIds || options.unitIds.has(u.id));
  const unitsByPage = new Map<number, TranslationBlock[]>();
  for (const unit of units) {
    const pages = new Set(unit.sourceBlockIds.map((id) => blockById.get(id)?.page).filter((p): p is number => !!p));
    for (const p of pages) {
      const list = unitsByPage.get(p) ?? [];
      list.push(unit);
      unitsByPage.set(p, list);
    }
  }

  const reports = new Map<string, BlockRenderReport>();
  const layouts = new Map<string, UnitLayout | null>();
  const stats: RenderStats = {
    pagesRendered: 0,
    unitsWritten: 0,
    unitsSkipped: 0,
    masksDrawn: 0,
    replacedChars: 0,
    fontFallbackCount: 0,
    tableCells: 0,
    tableCellsWritten: 0,
    tableCellsOverflow: 0,
  };
  /** Layout blocks that are logical table cells (for the debug PDF). */
  const cellBlocks = layout.blocks.filter((b) => b.cell !== undefined);

  const skip = (unit: TranslationBlock, reason: string, message: string | null = null) => {
    if (reports.has(unit.id)) return;
    reports.set(unit.id, {
      unitId: unit.id,
      sourceBlockIds: unit.sourceBlockIds,
      page: unit.page,
      type: unit.type,
      fontSize: blockById.get(unit.sourceBlockIds[0])?.fontSize ?? 0,
      finalFontSize: null,
      lines: 0,
      warning: false,
      reason,
      message,
      skipped: true,
      fallbackGlyphs: 0,
    });
    stats.unitsSkipped++;
  };

  /** Fit a unit once; null when it cannot be written. */
  const getLayout = (unit: TranslationBlock): UnitLayout | null => {
    if (layouts.has(unit.id)) return layouts.get(unit.id) ?? null;
    let result: UnitLayout | null = null;
    if (!unit.overlayEligible) {
      skip(unit, unit.overlaySkippedReason ?? 'NOT_ELIGIBLE');
    } else {
      const entry = entries.get(unit.id);
      if (!hasTranslation(entry)) {
        skip(unit, 'NO_TRANSLATION');
      } else {
        const sources = unit.sourceBlockIds.map((id) => blockById.get(id)).filter((b): b is TextBlock => !!b);
        const cellBlock = sources.length === 1 ? sources[0] : null;
        try {
          if (cellBlock?.cell) {
            stats.tableCells++;
            const cellLayout = layoutTableCell(entry.translation, cellBlock, cellBlock.cell, mixed as MixedFont);
            if (cellLayout.fits) {
              result = cellLayout;
            } else {
              // Table-only fallback: no downward extension, no clipping — the English cell stays.
              const fit = cellLayout.table?.fit;
              const cell = cellBlock.cell;
              const reasonWord = fit?.reason === 'WIDTH' ? 'wider than the cell' : 'taller than the cell';
              const message =
                `translation is ${reasonWord} by ${cellLayout.overflow.toFixed(1)} pt even at ${cellLayout.fontSize} pt ` +
                `(table ${cell.tableId}, row ${cell.rowIndex}, column ${cell.columnIndex}); English kept`;
              reports.set(unit.id, {
                unitId: unit.id,
                sourceBlockIds: unit.sourceBlockIds,
                page: unit.page,
                type: unit.type,
                cell: {
                  tableId: cell.tableId,
                  row: cell.rowIndex,
                  column: cell.columnIndex,
                  sourceText: cellBlock.text,
                  finalFontSize: cellLayout.fontSize,
                  overflowReason: fit?.reason ?? 'HEIGHT',
                },
                fontSize: cellBlock.fontSize,
                finalFontSize: cellLayout.fontSize,
                lines: cellLayout.parts.get(cellBlock.id)?.length ?? 0,
                warning: true,
                reason: 'TABLE_CELL_OVERFLOW',
                message,
                skipped: true,
                fallbackGlyphs: 0,
              });
              stats.unitsSkipped++;
              stats.tableCellsOverflow++;
              console.warn(`[PDF Render Warning] block=${unit.id} reason=TABLE_CELL_OVERFLOW (${message})`);
            }
          } else {
            result = layoutUnit(unit, entry.translation, sources, pageById, mixed as MixedFont);
          }
        } catch (err) {
          skip(unit, 'FIT_FAILED', err instanceof Error ? err.message : String(err));
          console.warn(`[PDF Render Warning] block=${unit.id} reason=FIT_FAILED`, err);
        }
      }
    }
    layouts.set(unit.id, result);
    return result;
  };

  // 4. pages -----------------------------------------------------------------
  const pageNumbers = [...selectedPages]
    .filter((p) => p >= 1 && p <= pdfPages.length && pageById.has(p))
    .sort((a, b) => a - b);
  let pagesDone = 0;
  let blocksSinceYield = 0;

  // Bilingual: embed every original page of the range in ONE call, so pdf-lib
  // uses one object copier and shared fonts / images are copied only once.
  const embeddedByPage = new Map<number, PDFEmbeddedPage>();
  if (bilingual && pageNumbers.length > 0) {
    report('Embedding original pages...', 0, 0);
    const boxes = pageNumbers.map((n) => {
      const [x0, y0, x1, y1] = (pageById.get(n) as PageDebugInfo).view;
      return { left: x0, bottom: y0, right: x1, top: y1 };
    });
    try {
      const embedded = await doc.embedPages(
        pageNumbers.map((n) => pdfPages[n - 1]),
        boxes,
      );
      pageNumbers.forEach((n, i) => embeddedByPage.set(n, embedded[i]));
    } catch (err) {
      throw new RenderError('LOAD_FAILED', `pdf-lib could not embed the original pages: ${err instanceof Error ? err.message : String(err)}`);
    }
    await yieldToUi();
  }

  /**
   * Masks + translation (or debug boxes) for one source page, drawn on
   * `target`. (dx, dy) moves the page's user space to where the page sits on
   * the target: 0/0 for the original page itself, the right half for a spread.
   */
  const paintPage = async (target: PDFPage, pageNumber: number, pageInfo: PageDebugInfo, dx: number, dy: number) => {
    const pageUnits = unitsByPage.get(pageNumber) ?? [];
    const shifted = dx !== 0 || dy !== 0;
    if (shifted) target.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, dx, dy));

    if (mode === 'debug') {
      drawDebugPage(target, pageInfo, pageUnits, blockById, labelFont as PDFFont, cellBlocks);
      if (shifted) target.pushOperators(popGraphicsState());
      return;
    }

    // Pass 1: masks for every line that will be rewritten on this page.
    // Table cells: union of their source lines clipped to the cell interior.
    report('Masking original text...', pageNumber, pagesDone);
    const writable: TranslationBlock[] = [];
    for (const unit of pageUnits) {
      if (!getLayout(unit)) continue;
      writable.push(unit);
      for (const id of unit.sourceBlockIds) {
        const block = blockById.get(id);
        if (!block || block.page !== pageNumber) continue;
        if (block.cell) {
          stats.masksDrawn += drawCellMasks(target, block, block.cell, pageInfo);
          continue;
        }
        for (const line of block.lines) if (drawLineMask(target, line, pageInfo)) stats.masksDrawn++;
      }
    }

    // Pass 2: the translation. All masks of the page are already down, so a
    // block that extends below its box is never hidden by a later mask.
    report('Fitting translated text...', pageNumber, pagesDone);
    const writer = new PageTextWriter(target);
    for (const unit of writable) {
      const unitLayout = getLayout(unit) as UnitLayout;
      const firstBlock = blockById.get(unit.sourceBlockIds[0]);
      let existing = reports.get(unit.id);
      if (!existing) {
        existing = {
          unitId: unit.id,
          sourceBlockIds: unit.sourceBlockIds,
          page: unit.page,
          type: unit.type,
          fontSize: firstBlock?.fontSize ?? 0,
          finalFontSize: unitLayout.fontSize,
          lines: [...unitLayout.parts.values()].reduce((n, l) => n + l.length, 0),
          warning: false,
          reason: null,
          message: null,
          skipped: false,
          fallbackGlyphs: unitLayout.fallbackGlyphs,
        };
        const notes: string[] = [];
        if (unitLayout.table && firstBlock?.cell) {
          const cell = firstBlock.cell;
          existing.cell = {
            tableId: cell.tableId,
            row: cell.rowIndex,
            column: cell.columnIndex,
            sourceText: firstBlock.text,
            finalFontSize: unitLayout.fontSize,
            overflowReason: null,
          };
          stats.tableCellsWritten++;
          if (unitLayout.fontSize < cell.fontSize) notes.push(`table cell shrunk from ${cell.fontSize} pt to ${unitLayout.fontSize} pt`);
          if (unitLayout.lineHeight < unitLayout.fontSize * 1.1) notes.push('tight table line height');
        }
        if (!unitLayout.fits) {
          existing.warning = true;
          existing.reason = 'TEXT_OVERFLOW';
          notes.push(`text exceeds the block by ${unitLayout.overflow.toFixed(1)} pt even at ${unitLayout.fontSize} pt`);
        } else if (unitLayout.extended) {
          notes.push('extended below the original block');
        }
        if (unit.wasMerged) notes.push(`merged unit flowed through ${unit.sourceBlockIds.length} blocks`);
        if (unitLayout.replaced > 0) notes.push(`${unitLayout.replaced} character(s) missing from every font, drawn as □`);
        if (unitLayout.fallbackGlyphs > 0) notes.push(`${unitLayout.fallbackGlyphs} glyph(s) drawn with the fallback font`);
        stats.replacedChars += unitLayout.replaced;
        stats.fontFallbackCount += unitLayout.fallbackGlyphs;
        existing.message = notes.length ? notes.join('; ') : null;
        reports.set(unit.id, existing);
        stats.unitsWritten++;
      }

      for (const id of unit.sourceBlockIds) {
        const block = blockById.get(id);
        if (!block || block.page !== pageNumber) continue;
        const lines = unitLayout.parts.get(id) ?? [];
        const outcome = unitLayout.table
          ? drawTableCellText(writer, unitLayout.table.placement, unitLayout.fontSize, mixed as MixedFont)
          : drawBlockText(
              writer,
              block,
              pageInfo,
              lines,
              unitLayout.fontSize,
              unitLayout.lineHeight,
              mixed as MixedFont,
              isCenteredBlock(block, pageInfo),
            );
        if (outcome.error) {
          existing.warning = true;
          existing.reason = 'DRAW_FAILED';
          existing.message = `${existing.message ? `${existing.message}; ` : ''}drawText failed on ${id}: ${outcome.error}`;
          console.warn(`[PDF Render Warning] block=${id} reason=DRAW_FAILED ${outcome.error}`);
        } else if (outcome.clipped > 0) {
          existing.warning = true;
          existing.reason = existing.reason ?? 'PAGE_OVERFLOW';
          existing.message = `${existing.message ? `${existing.message}; ` : ''}${outcome.clipped} line(s) of ${id} fall below the page and are not drawn`;
        }
        console.log(
          `[PDF Render] page=${pageNumber} block=${id} unit=${unit.id} fontSize=${existing.fontSize} ` +
            `finalFontSize=${unitLayout.fontSize} lines=${lines.length} warning=${existing.warning}` +
            (existing.reason ? ` reason=${existing.reason}` : ''),
        );
        if (existing.warning && existing.reason) {
          console.warn(`[PDF Render Warning] block=${id} reason=${existing.reason}${existing.message ? ` (${existing.message})` : ''}`);
        }
        if (++blocksSinceYield >= YIELD_EVERY_BLOCKS) {
          blocksSinceYield = 0;
          await yieldToUi();
        }
      }
    }
    if (shifted) target.pushOperators(popGraphicsState());
  };

  for (const pageNumber of pageNumbers) {
    const sourcePage = pdfPages[pageNumber - 1];
    const pageInfo = pageById.get(pageNumber) as PageDebugInfo;
    const stage = mode === 'debug' ? 'Drawing bounding boxes...' : 'Writing translation...';

    if (!bilingual) {
      report(stage, pageNumber, pagesDone);
      await paintPage(sourcePage, pageNumber, pageInfo, 0, 0);
    } else {
      // One spread: [ original page | gap | translated page ], same height as the page.
      report('Composing spread...', pageNumber, pagesDone);
      const embedded = embeddedByPage.get(pageNumber);
      if (!embedded) continue;
      const left = pagePlacement(pageInfo, 0);
      const right = pagePlacement(pageInfo, left.displayWidth + gap);
      const spread = doc.addPage([left.displayWidth * 2 + gap, left.displayHeight]);
      spread.drawPage(embedded, { x: left.x, y: left.y, rotate: degrees(left.rotateDegrees) });
      spread.drawPage(embedded, { x: right.x, y: right.y, rotate: degrees(right.rotateDegrees) });
      spread.drawLine({
        start: { x: left.displayWidth + gap / 2, y: 0 },
        end: { x: left.displayWidth + gap / 2, y: left.displayHeight },
        thickness: 0.5,
        color: SEPARATOR,
      });
      // The overlay is drawn in the page's own user space, shifted to the right half.
      // Rotated pages are shown as-is on both sides (their units are PAGE_ROTATED anyway).
      if (pageInfo.rotation % 360 === 0) {
        const [x0, y0] = pageInfo.view;
        await paintPage(spread, pageNumber, pageInfo, left.displayWidth + gap - x0, -y0);
      }
    }

    stats.pagesRendered++;
    pagesDone++;
    report(stage, pageNumber, pagesDone);
    await yieldToUi();
  }

  // Units on selected pages that were never reached (e.g. no translation) still get a report.
  if (mode === 'overlay') {
    for (const pageNumber of pageNumbers) {
      for (const unit of unitsByPage.get(pageNumber) ?? []) if (!reports.has(unit.id)) getLayout(unit);
    }
  }

  // 5. save ------------------------------------------------------------------
  report('Saving PDF...', pageCount, pageCount);
  await yieldToUi();
  let bytes: Uint8Array;
  try {
    bytes = await doc.save();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind: RenderErrorKind = err instanceof RangeError || /allocation|memory/i.test(message) ? 'MEMORY' : 'SAVE_FAILED';
    throw new RenderError(
      kind,
      kind === 'MEMORY'
        ? `The browser ran out of memory while saving the PDF (${message}). Try a smaller page range.`
        : `pdf-lib could not save the PDF: ${message}`,
    );
  }

  const allReports = [...reports.values()];
  if (mode === 'overlay') {
    console.log(`[PDF Render] fonts: ${fontsLabel}  fallbackGlyphs: ${stats.fontFallbackCount}  replacedChars: ${stats.replacedChars}`);
    if (mixed && mixed.unsupported.size > 0) {
      console.warn('[Font Fallback Warning] characters without a glyph in any font:', Object.fromEntries(mixed.unsupported));
    }
  }
  const suffix = `${bilingual ? '_bilingual' : ''}${mode === 'debug' ? '_debug-boxes' : '_zh-TW'}`;
  return {
    bytes,
    fileName: outputFileName(options.fileName, suffix),
    mode,
    output,
    fonts: fontsLabel,
    reports: allReports,
    warnings: allReports.filter((r) => r.warning),
    stats,
  };
}
