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
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  showText,
  StandardFonts,
  TextRenderingMode,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFName,
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';
import { fitTextToBoxes, measureSegments, type BoxSpec, MAX_EXTENSION_RATIO } from './fit';
import { embedFontSet, FontLoadError, MixedFont, sanitizeForFont, type FontSetBytes, type TextRun } from './font';
import { buildInlineSegments } from './inline';
import { GLYPH_ASCENT, GLYPH_DESCENT } from './layout';
import { roleOf } from './roles';
import { trailingMarker } from './superscript';
import {
  hasRequiredContrast,
  LABEL_TYPOGRAPHY_ROLES,
  subscriptRise,
  superscriptRise,
  superscriptSize,
  TYPOGRAPHY,
  typographyFor,
  type TypographySpec,
} from './typography';
import {
  clipMaskOffRules,
  clipMaskToRules,
  fitTextToTableCell,
  placeTableCellLines,
  tableCellMaskRects,
  textColorFor,
  type CellPlacement,
  type TableFitResult,
} from './table';
import type {
  BlockType,
  ImageBox,
  InlineSegment,
  LayoutContainer,
  LayoutResult,
  LayoutRole,
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

/** Block types written back in this version (TABLE / FIGURE: one logical cell or figure element each). */
export const OVERLAY_TYPES: ReadonlySet<BlockType> = new Set([
  'TITLE',
  'HEADING',
  'BODY',
  'CAPTION',
  'FOOTNOTE',
  'TABLE',
  'FIGURE',
]);
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
/** A heading never comes closer than this to the block under (or over) it. */
const HEADING_CLEARANCE = 1;
/** A centred line leaves at least this share of the text measure free on each side. */
const CENTERED_MIN_SIDE = 0.05;
/** Yield to the event loop after this many blocks so the UI can repaint. */
const YIELD_EVERY_BLOCKS = 20;
/** A fill covering at least this share of the page is the page background. */
const PAGE_BACKGROUND_SHARE = 0.9;
/** A run-in label may take at most this share of its paragraph width; wider labels go on a line of their own. */
const RUN_IN_LABEL_MAX_SHARE = 0.5;
/** Slack (points) when testing whether a fill covers a block. */
const COVER_SLACK = 0.75;

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

/** Cell details of a report (Developer Mode table / figure diagnostics). */
export interface CellReport {
  kind: 'table' | 'figure';
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
  /** Layout role of the unit (pdf/roles.ts). */
  role: LayoutRole;
  /** Mask background used for this unit: the colour and where it came from. */
  background?: { color: string | null; source: BackgroundSource; light: boolean };
  /** Vertical extent of the drawn text of the first source box (paragraph path): top of the first line to the last descender. */
  extent?: { top: number; bottom: number };
  /** Present for logical table cells. */
  cell?: CellReport;
  /** Original font size of the first source block. */
  fontSize: number;
  finalFontSize: number | null;
  lines: number;
  /** Paragraph typography that was applied (absent for table / figure cells). */
  typography?: {
    role: TypographySpec['role'];
    /** Size the fitting started from (may be above the source size). */
    startFontSize: number;
    /** Floor the fitting was not allowed to go below. */
    minFontSize: number;
    /** finalFontSize / document body font size. */
    bodyRatio: number;
    bold: boolean;
    firstLineIndent: number;
    spaceBefore: number;
    spaceAfter: number;
    /** Raised citation markers drawn in this unit. */
    superscripts: number;
    /** Lowered runs drawn in this unit. */
    subscripts?: number;
    /** Label / sidebar heading: which contrasts to the body text hold (size / weight / spacing). */
    contrast?: string[];
    /** Run-in label drawn on the first line of its paragraph ("inline") or on a line of its own. */
    labelPlacement?: 'inline' | 'own-line';
  };
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

/**
 * Developer Mode typography diagnostics: what the new paragraph / heading /
 * citation rules actually did on this export.
 */
export interface TypographyStats {
  /** Units drawn with the TITLE typography. */
  titles: number;
  /** Units drawn with the HEADING typography. */
  headings: number;
  /** Headings / titles whose start size was raised above the source size. */
  sizeBoosted: number;
  /** Headings / titles drawn with the synthetic bold. */
  boldDrawn: number;
  /** Headings / titles that hit their size floor (would have shrunk to body size). */
  floorApplied: number;
  /** Headings fitted against the free space under them instead of their own box alone. */
  headingsSpaceBound: number;
  /** Headings whose ink still reaches the block below after every downgrade. */
  headingCollisions: number;
  /** Smallest heading-to-body size ratio actually drawn (0 when none). */
  minHeadingBodyRatio: number;
  /** Paragraphs drawn with a first-line indent. */
  indentedParagraphs: number;
  /** Units that reserved paragraph spacing before / after. */
  spacedParagraphs: number;
  /** Citation markers drawn raised. */
  superscriptRuns: number;
  /** Units that carry at least one raised marker. */
  superscriptUnits: number;
  /** Runs drawn lowered (subscripts recovered from the text layer). */
  subscriptRuns: number;
  /** Units that carry at least one lowered run. */
  subscriptUnits: number;
  /** Trailing markers the model dropped and that were put back. */
  superscriptRestored: number;
}

/**
 * Developer Mode layout-role diagnostics: what the generic roles did on this
 * export (pdf/roles.ts, pdf/detectors/).
 */
export interface LayoutRoleStats {
  structuredLabels: number;
  sidebarHeadings: number;
  sidebarLabels: number;
  sidebarBodies: number;
  /** Run-in labels drawn on the first line of their paragraph. */
  inlineLabels: number;
  /** Labels that did not fit beside their paragraph and were set on a line of their own. */
  ownLineLabels: number;
  /** Labels / sidebar headings that hold fewer contrasts than required. */
  contrastShortfall: number;
  /** Masks painted in a container's fill instead of white. */
  containerMasks: number;
  /** Masks painted in a covering fill colour (outside containers). */
  tintedMasks: number;
  /** Units drawn in white on a dark background. */
  lightTextUnits: number;
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
  /** Logical figure elements with a translation on the rendered pages. */
  figureCells: number;
  figureCellsWritten: number;
  figureCellsOverflow: number;
  /** Heading hierarchy, paragraph spacing and citation reconstruction. */
  typography: TypographyStats;
  /** Structured labels, sidebar roles and background-aware masks. */
  layoutRoles: LayoutRoleStats;
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
  /** Debug mode: also draw sidebar containers, structured regions and role boxes (default true). */
  debugRoles?: boolean;
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
export function isCenteredBlock(block: TextBlock, page: PageDebugInfo, blocks: readonly TextBlock[] = []): boolean {
  if (block.type !== 'TITLE' && block.type !== 'HEADING') return false;
  const center = block.x + block.width / 2;
  if (block.lines.length >= 2) {
    const tol = Math.max(2, 0.04 * block.width);
    const allCentered = block.lines.every((l) => Math.abs(l.x + l.width / 2 - center) <= tol);
    const notFlushLeft = block.lines.some((l) => l.x - block.x > 2);
    return allCentered && notFlushLeft;
  }
  // Single line: centred on the page (single-column or spanning) is the only
  // reliable signal — but a line that fills the text measure has its centre on
  // the page centre by construction and is flush left, not centred. So it also
  // has to leave a real margin on both sides of what the page writes in.
  if (block.column === 'FULL' || block.column === 'SPANNING') {
    const [x0, , x1] = page.view;
    const pageCenter = (x0 + x1) / 2;
    if (Math.abs(center - pageCenter) > 3 || block.x - x0 <= 30) return false;
    const measure = textMeasure(blocks);
    if (!measure) return true;
    const side = Math.min(block.x - measure.left, measure.right - (block.x + block.width));
    return side >= CENTERED_MIN_SIDE * (measure.right - measure.left);
  }
  return false;
}

/** Left and right edge of what the page writes in, ignoring the running furniture. */
function textMeasure(blocks: readonly TextBlock[]): { left: number; right: number } | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const b of blocks) {
    if (b.type === 'HEADER' || b.type === 'FOOTER' || b.width <= 0) continue;
    left = Math.min(left, b.x);
    right = Math.max(right, b.x + b.width);
  }
  return right > left ? { left, right } : null;
}

/** Extension allowed below a block: 25 % of its height, but never past the page bottom. */
function extensionFor(block: TextBlock, page: PageDebugInfo): number {
  const pageBottom = page.view[1] + PAGE_BOTTOM_MARGIN;
  return Math.max(0, Math.min(MAX_EXTENSION_RATIO * block.height, block.y - pageBottom));
}

/** Empty space a block has around it, before the next block starts. */
export interface BlockSpace {
  above: number;
  below: number;
  /** Free width to the right of the box, up to the right edge of its own column. */
  right: number;
}

/** Two blocks share a column band when their horizontal ranges overlap. */
function sameColumnBand(a: TextBlock, b: TextBlock): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

/**
 * How much empty page a block has over and under it.
 *
 * "Under" is the room a heading may take: from the bottom of its box to the
 * top of the next block whose horizontal range it overlaps, or the page
 * margin when there is none. The two columns of a page never constrain each
 * other, because their ranges do not overlap.
 */
export function spaceAround(block: TextBlock, blocks: readonly TextBlock[], page: PageDebugInfo): BlockSpace {
  let above = page.view[3] - block.top;
  let below = block.y - (page.view[1] + PAGE_BOTTOM_MARGIN);
  const centre = block.y + block.height / 2;
  const right = block.x + block.width;
  let columnRight = right;
  let blocked = Number.POSITIVE_INFINITY;
  for (const other of blocks) {
    if (other === block || other.page !== block.page) continue;
    if (sameColumnBand(block, other)) {
      // Which side a neighbour is on is decided by its centre, so boxes that
      // touch (or overlap by a fraction of a point) still count, with no room.
      if (other.y + other.height / 2 > centre) above = Math.min(above, other.y - block.top);
      else below = Math.min(below, block.y - other.top);
      columnRight = Math.max(columnRight, other.x + other.width);
    } else if (other.x >= right && other.y < block.top && other.top > block.y) {
      blocked = Math.min(blocked, other.x); // stands beside this box, on its own lines
    }
  }
  return {
    above: Math.max(0, above),
    below: Math.max(0, below),
    right: Math.max(0, Math.min(columnRight, blocked) - right),
  };
}

// ---------------------------------------------------------------------------
// Background-aware masking
// ---------------------------------------------------------------------------

export type BackgroundSource = 'container' | 'fill' | 'page' | 'white';

export interface BlockBackground {
  /** Mask colour ("#f4f3ec"), null for white paper. */
  color: string | null;
  source: BackgroundSource;
  /** True when the colour is dark enough that the text is drawn in white. */
  light: boolean;
  /** Masks never leave this rectangle (the container or the fill), null for the page. */
  clip: Rect | null;
  /** Container the block belongs to, when any. */
  container: LayoutContainer | null;
}

function covers(fill: Rect, box: Rect, slack = COVER_SLACK): boolean {
  return (
    fill.x <= box.x + slack &&
    fill.y <= box.y + slack &&
    fill.x + fill.width >= box.x + box.width - slack &&
    fill.y + fill.height >= box.y + box.height - slack
  );
}

function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function normalizeColor(color: string | null): string | null {
  return !color || color === '#ffffff' ? null : color;
}

/**
 * The background a block's masks must be painted in, in this order:
 *
 *   1. the enclosing container: the smallest fill inside the container that
 *      covers the glyphs (a header band), else the container's own fill;
 *   2. the smallest filled rectangle that covers the glyph box;
 *   3. the page background (a fill covering almost the whole page);
 *   4. white.
 *
 * The colour is kept as it is; a dark background only switches the text to
 * white (WCAG contrast, see table.ts), it never lightens the panel.
 */
export function getBackgroundForBlock(
  block: TextBlock,
  page: PageDebugInfo,
  containers: ReadonlyMap<string, LayoutContainer>,
): BlockBackground {
  const box: Rect = { x: block.x, y: block.y, width: block.width, height: block.height };
  const container = block.containerId ? (containers.get(block.containerId) ?? null) : null;
  const covering = page.fills
    .filter((f) => covers(f, box))
    .sort((a, b) => rectArea(a) - rectArea(b));
  const [x0, y0, x1, y1] = page.view;
  const pageArea = Math.max(1, (x1 - x0) * (y1 - y0));

  const finish = (color: string | null, source: BackgroundSource, clip: Rect | null): BlockBackground => ({
    color,
    source,
    light: textColorFor(color) === 'light',
    clip,
    container,
  });

  if (container) {
    const inside = covering.find((f) => covers(container.bbox, f, 1) && rectArea(f) < pageArea * PAGE_BACKGROUND_SHARE);
    const color = inside ? normalizeColor(inside.color) : container.backgroundFill;
    return finish(color, 'container', container.bbox);
  }
  const fill = covering.find((f) => rectArea(f) < pageArea * PAGE_BACKGROUND_SHARE && f.color !== null);
  if (fill) return finish(normalizeColor(fill.color), 'fill', { x: fill.x, y: fill.y, width: fill.width, height: fill.height });
  const pageFill = page.fills.find((f) => rectArea(f) >= pageArea * PAGE_BACKGROUND_SHARE && normalizeColor(f.color) !== null);
  if (pageFill) return finish(normalizeColor(pageFill.color), 'page', null);
  return finish(null, 'white', null);
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------

const WHITE = rgb(1, 1, 1);
const ORANGE = rgb(0.95, 0.5, 0.05);
const PURPLE = rgb(0.55, 0.2, 0.75);
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
  for (const raw of tableCellMaskRects(cell, boxes)) {
    // Borders, connectors, arrows and axis lines are never painted over.
    const r = clipMaskOffRules(raw, pageInfo.rules);
    if (r.width <= 0 || r.height <= 0) continue;
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

/**
 * Mask one source line: its glyph box plus a minimal padding, in the block's
 * background colour, kept off any ruling line and never outside the
 * container or fill it belongs to. Borders, rules, icons and markers next to
 * the text are therefore never painted over.
 */
export function lineMaskRect(line: TextLine, pageInfo: PageDebugInfo, background: BlockBackground): Rect | null {
  const [x0, y0, x1, y1] = pageInfo.view;
  const { top, bottom } = lineExtent(line);
  let left = clamp(line.x - MASK_PAD_X, x0, x1);
  let right = clamp(line.x + line.width + MASK_PAD_X, x0, x1);
  let lo = clamp(bottom - MASK_PAD_Y, y0, y1);
  let hi = clamp(top + MASK_PAD_Y, y0, y1);
  if (pageInfo.rules.length > 0) {
    // A table border right under a caption / note sits inside the padding: leave it alone.
    const clipped = clipMaskToRules({ x: left, y: lo, width: right - left, height: hi - lo }, line.y, line.fontSize, pageInfo.rules);
    lo = clipped.y;
    hi = clipped.y + clipped.height;
    if (background.source !== 'white') {
      // Inside a panel: the panel's own border and rules survive as well.
      const off = clipMaskOffRules({ x: left, y: lo, width: right - left, height: hi - lo }, pageInfo.rules);
      left = off.x;
      right = off.x + off.width;
      lo = off.y;
      hi = off.y + off.height;
    }
  }
  if (background.clip) {
    const c = background.clip;
    left = Math.max(left, c.x);
    right = Math.min(right, c.x + c.width);
    lo = Math.max(lo, c.y);
    hi = Math.min(hi, c.y + c.height);
  }
  if (right - left <= 0 || hi - lo <= 0) return null;
  return { x: left, y: lo, width: right - left, height: hi - lo };
}

function drawLineMask(page: PDFPage, line: TextLine, pageInfo: PageDebugInfo, background: BlockBackground): boolean {
  const r = lineMaskRect(line, pageInfo, background);
  if (!r) return false;
  page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: hexColor(background.color), borderWidth: 0 });
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

  drawRuns(runs: readonly TextRun[], x: number, y: number, size: number, light = false): void {
    const level = light ? 1 : 0;
    const ops = [beginText(), setFillingRgbColor(level, level, level), setTextMatrix(1, 0, 0, 1, x, y)];
    for (const run of runs) ops.push(setFontAndSize(this.key(run.font), size), showText(run.font.encodeText(run.text)));
    ops.push(endText());
    this.page.pushOperators(...ops);
  }

  /**
   * One wrapped line made of ordinary and raised runs.
   *
   *  - a script run — raised or lowered — is set at `superscriptSize(size)`
   *    and shifted with the text rise operator (Ts), which moves the glyphs
   *    without touching the line's own advance, so the paragraph's line height
   *    is unaffected;
   *  - `bold` is synthetic: no bold font file is shipped, so the glyphs are
   *    filled AND stroked (Tr 2) with a hairline. Both the rise and the
   *    rendering mode live in the graphics state, so the whole line is wrapped
   *    in q / Q and nothing leaks into the next draw.
   */
  drawSegments(
    segments: readonly InlineSegment[],
    x: number,
    y: number,
    size: number,
    mixed: MixedFont,
    style: { bold?: boolean; boldStrokeRatio?: number; light?: boolean } = {},
  ): void {
    const bold = style.bold === true && (style.boldStrokeRatio ?? 0) > 0;
    const level = style.light ? 1 : 0;
    const ops: PDFOperator[] = [];
    if (bold) {
      ops.push(
        pushGraphicsState(),
        setStrokingRgbColor(level, level, level),
        setLineWidth(size * (style.boldStrokeRatio ?? 0)),
      );
    }
    ops.push(beginText(), setFillingRgbColor(level, level, level), setTextMatrix(1, 0, 0, 1, x, y));
    if (bold) ops.push(setTextRenderingMode(TextRenderingMode.FillAndOutline));
    const supSize = superscriptSize(size);
    const supRise = superscriptRise(size);
    const subDrop = subscriptRise(size);
    let rise = 0;
    for (const seg of segments) {
      if (!seg.text) continue;
      const script = seg.sup || seg.sub === true;
      const wanted = seg.sup ? supRise : seg.sub ? subDrop : 0;
      if (wanted !== rise) {
        ops.push(setTextRise(wanted));
        rise = wanted;
      }
      const runSize = script ? supSize : size;
      for (const run of mixed.runs(seg.text)) {
        ops.push(setFontAndSize(this.key(run.font), runSize), showText(run.font.encodeText(run.text)));
      }
    }
    if (rise !== 0) ops.push(setTextRise(0));
    ops.push(endText());
    if (bold) ops.push(popGraphicsState());
    this.page.pushOperators(...ops);
  }
}

interface BlockTextStyle {
  /** Points the first baseline is pushed down by (paragraph space before). */
  topOffset: number;
  /** Points the first line is indented by. */
  firstLineIndent: number;
  bold: boolean;
  boldStrokeRatio: number;
  /** White text (dark background). */
  light?: boolean;
  /** A run-in label shares the first baseline of its paragraph: draw at exactly this baseline. */
  baselineOverride?: number;
}

/**
 * Paragraph path: draw the wrapped lines of one source box.
 *
 * `topOffset` is the paragraph space above the block — for a heading it is a
 * slide into the gap that precedes it, for body text it was already taken out
 * of the box height, so in both cases the first baseline simply starts lower.
 * `firstLineIndent` shifts the first line only; the wrapper already shortened
 * that line by the same amount.
 */
function drawBlockText(
  writer: PageTextWriter,
  block: TextBlock,
  pageInfo: PageDebugInfo,
  lines: readonly InlineSegment[][],
  fontSize: number,
  lineHeight: number,
  mixed: MixedFont,
  centered: boolean,
  style: BlockTextStyle,
): DrawTextOutcome {
  const pageBottom = pageInfo.view[1];
  let baseline = style.baselineOverride ?? block.top - style.topOffset - GLYPH_ASCENT * fontSize;
  let drawn = 0;
  let clipped = 0;
  for (const [index, segments] of lines.entries()) {
    if (baseline - GLYPH_DESCENT * fontSize < pageBottom) {
      clipped++;
      baseline -= lineHeight;
      continue;
    }
    if (segments.length > 0) {
      const indent = index === 0 ? style.firstLineIndent : 0;
      let x = block.x + indent;
      if (centered) {
        const w = measureSegments(segments, mixed, fontSize);
        x = block.x + Math.max(0, (block.width - w) / 2);
      }
      try {
        writer.drawSegments(segments, x, baseline, fontSize, mixed, {
          bold: style.bold,
          boldStrokeRatio: style.boldStrokeRatio,
          light: style.light,
        });
      } catch (err) {
        return { drawn, clipped, error: err instanceof Error ? err.message : String(err) };
      }
    }
    drawn++;
    baseline -= lineHeight;
  }
  return { drawn, clipped, error: null };
}

/** Debug PDF: table cells in orange, figure elements in purple (solid: glyph box, dashed: usable rectangle). */
function drawDebugCell(page: PDFPage, block: TextBlock, cell: TableCellInfo, labelFont: PDFFont): void {
  const color = cell.kind === 'figure' ? PURPLE : ORANGE;
  const rect = (r: Rect, dashed: boolean) =>
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: Math.max(0.1, r.width),
      height: Math.max(0.1, r.height),
      borderColor: color,
      borderWidth: dashed ? 0.4 : 0.6,
      borderDashArray: dashed ? [1.5, 1.5] : undefined,
      color: undefined,
    });
  rect(cell.usable, true);
  rect(cell.textBox, false);
  try {
    page.drawText(`${cell.kind === 'figure' ? 'f' : 't'}${cell.tableId} r${cell.rowIndex}c${cell.columnIndex}${cell.numeric ? ' #' : ''}`, {
      x: cell.usable.x + 0.5,
      y: cell.usable.y + cell.usable.height - 3.5,
      size: 3,
      font: labelFont,
      color,
    });
  } catch {
    // labels are optional
  }
  void block;
}

/** Debug PDF colours of the generic layout roles. */
const TEAL = rgb(0.0, 0.55, 0.55);
const MAGENTA = rgb(0.8, 0.1, 0.6);
const ROLE_COLORS: Partial<Record<LayoutRole, ReturnType<typeof rgb>>> = {
  STRUCTURED_LABEL: MAGENTA,
  SIDEBAR_HEADING: TEAL,
  SIDEBAR_LABEL: rgb(0.0, 0.4, 0.75),
  SIDEBAR_BODY: rgb(0.3, 0.65, 0.65),
};

/**
 * Debug PDF, Developer Mode only: sidebar / callout containers (teal, inner
 * area dashed), structured abstract regions (magenta dashed) with their
 * sections (thin), and every block that carries a detector-assigned role in
 * its role colour.
 */
function drawDebugRoles(page: PDFPage, pageInfo: PageDebugInfo, layout: LayoutResult, labelFont: PDFFont): void {
  const rect = (r: Rect, color: ReturnType<typeof rgb>, width: number, dashed: boolean) =>
    page.drawRectangle({
      x: r.x,
      y: r.y,
      width: Math.max(0.1, r.width),
      height: Math.max(0.1, r.height),
      borderColor: color,
      borderWidth: width,
      borderDashArray: dashed ? [2, 2] : undefined,
      color: undefined,
    });
  const label = (text: string, x: number, y: number, color: ReturnType<typeof rgb>) => {
    try {
      page.drawText(text.replace(/[^\x20-\x7e]/g, '?'), { x, y, size: 4, font: labelFont, color });
    } catch {
      // labels are optional
    }
  };
  for (const c of layout.containers) {
    if (c.page !== pageInfo.pageNumber) continue;
    rect(c.bbox, TEAL, 1, false);
    const inner: Rect = {
      x: c.bbox.x + c.padding.left,
      y: c.bbox.y + c.padding.bottom,
      width: c.bbox.width - c.padding.left - c.padding.right,
      height: c.bbox.height - c.padding.top - c.padding.bottom,
    };
    rect(inner, TEAL, 0.4, true);
    label(`${c.id} ${c.type} ${c.confidence} bg=${c.backgroundFill ?? 'none'}`, c.bbox.x + 1, c.bbox.y + c.bbox.height + 1.5, TEAL);
  }
  for (const r of layout.structuredRegions) {
    if (r.page !== pageInfo.pageNumber) continue;
    rect(r.bbox, MAGENTA, 0.8, true);
    label(`${r.id} structured abstract ${r.confidence}`, r.bbox.x + 1, r.bbox.y + r.bbox.height + 1.5, MAGENTA);
    for (const s of r.sections) rect(s.bbox, MAGENTA, 0.3, true);
  }
  for (const b of layout.blocks) {
    if (b.page !== pageInfo.pageNumber || !b.roleDetector) continue;
    const color = ROLE_COLORS[roleOf(b)];
    if (!color) continue;
    rect({ x: b.x, y: b.y, width: b.width, height: b.height }, color, 0.6, false);
  }
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
  /** The same lines as inline runs (raised citation markers), per source block id. */
  segmentParts: Map<string, InlineSegment[][]>;
  fits: boolean;
  extended: boolean;
  overflow: number;
  replaced: number;
  fallbackGlyphs: number;
  iterations: number;
  minFontSize: number;
  /** Heading only: the fit was bound by the free space under the block. */
  spaceBound?: boolean;
  /** Heading only: the ink still reaches the block below (nothing left to give up). */
  collision?: boolean;
  /** Paragraph typography of this unit (absent for table / figure cells). */
  spec?: TypographySpec;
  /** Points the first box is pushed down by. */
  topOffset?: number;
  /** First-line indent actually used for the first box (a run-in label widens it). */
  firstLineIndent?: number;
  /** Raised citation markers in the drawn text. */
  superscriptRuns?: number;
  /** Subscript runs drawn lowered in this unit. */
  subscriptRuns?: number;
  /** True when a trailing marker the model dropped was put back. */
  markerRestored?: boolean;
  /** Table cell: the table-only fit and where its lines go. */
  table?: { fit: TableFitResult; placement: CellPlacement };
  /** Background the unit's masks are painted in. */
  background?: BlockBackground;
  /**
   * Run-in label (STRUCTURED_LABEL / SIDEBAR_LABEL split off a paragraph):
   * whether it fits beside its paragraph, how wide it is, and the baseline
   * of that paragraph's first line once the paragraph has been laid out.
   */
  label?: { inline: boolean; width: number; baseline: number | null };
}

/**
 * How a run-in label pairs with its paragraph: the label is drawn on the
 * paragraph's first baseline and the paragraph's first line is indented by
 * the label's width plus the structured gap. A label too wide for that
 * (over RUN_IN_LABEL_MAX_SHARE of the paragraph width at its floor size)
 * goes on a line of its own and pushes the paragraph down one line.
 */
interface LabelPairing {
  labelLayout: UnitLayout;
  labelBlock: TextBlock;
  /** True when the source set label and paragraph on one line. */
  sourceInline: boolean;
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
    segmentParts: new Map(),
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

/**
 * Draw the fitted lines of a cell at their placed positions, plus the
 * footnote marker. `light` writes white text, which is what a dark box
 * background needs to stay readable (WCAG contrast, see table.ts).
 */
function drawTableCellText(
  writer: PageTextWriter,
  placement: CellPlacement,
  fontSize: number,
  mixed: MixedFont,
  light: boolean,
): DrawTextOutcome {
  let drawn = 0;
  try {
    for (const line of placement.lines) {
      if (line.text.length > 0) writer.drawRuns(mixed.runs(line.text), line.x, line.y, fontSize, light);
      drawn++;
    }
    const m = placement.marker;
    if (m) writer.drawRuns(mixed.runs(m.text), m.x, m.y, m.fontSize, light);
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

/** A unit that visibly continues a paragraph started elsewhere gets no indent. */
function continuesParagraph(unit: TranslationBlock): boolean {
  return /^[a-z,;:)\]]/.test(unit.text.trimStart());
}

/**
 * Paragraph path: resolve the typography, rebuild the inline citation
 * markers, then fit the translation into the source boxes.
 *
 * The translation string itself is never rewritten — only split into runs and
 * respaced — so the text that was sent (and its cache key) stays untouched.
 */
interface LayoutUnitOptions {
  /** Container the unit lives in (sidebar typography reference). */
  container?: LayoutContainer | null;
  /** Run-in label of this paragraph (already laid out), for the first-line indent. */
  pairing?: LabelPairing | null;
  /** A label unit: the width it may take beside its paragraph (points), 0 for the block's own width. */
  labelMaxWidth?: number;
  /** Empty page above the first source box and under the last one (pdf/render.ts spaceAround). */
  space?: BlockSpace;
}

function layoutUnit(
  unit: TranslationBlock,
  translation: string,
  sources: readonly TextBlock[],
  pageById: ReadonlyMap<number, PageDebugInfo>,
  mixed: MixedFont,
  bodyFontSize: number,
  options: LayoutUnitOptions = {},
): UnitLayout {
  const first = sources[0];
  const spec = typographyFor({
    type: unit.type,
    role: roleOf(unit),
    sourceFontSize: first.fontSize,
    bodyFontSize,
    containerBodyFontSize: options.container?.bodyFontSize,
    blockHeight: first.height,
    blockWidth: options.labelMaxWidth ? Math.max(first.width, options.labelMaxWidth) : first.width,
    isContinuation: continuesParagraph(unit),
  });

  // Script runs: the raised citation markers the source carried (plus a
  // trailing one the model may have dropped) and its lowered subscripts.
  const markers = unit.superscripts ?? [];
  const lowered = unit.subscripts ?? [];
  const tail = trailingMarker(unit.text);
  const restore = tail && markers.some((m) => m.text === tail) ? tail : null;
  const raw = buildInlineSegments(keepFootnoteMarker(unit, translation), markers, restore, lowered);

  let replaced = 0;
  let fallbackGlyphs = 0;
  const segments: InlineSegment[] = [];
  for (const seg of raw) {
    const clean = sanitizeForFont(seg.text, mixed);
    replaced += clean.replaced;
    fallbackGlyphs += mixed.fallbackCount(clean.text);
    if (clean.text.length > 0) {
      segments.push(seg.sub ? { text: clean.text, sup: seg.sup, sub: true } : { text: clean.text, sup: seg.sup });
    }
  }
  // The marker was put back when the model's own output did not contain it.
  const markerRestored = restore !== null && !translation.includes(restore);

  // A paragraph that opens with a run-in label: its first line starts after
  // the label (inline) or one line lower (label on its own line); the
  // structured section gap slides the whole paragraph down like a heading.
  const pairing = options.pairing ?? null;
  let firstLineIndent = spec.firstLineIndent;
  let topOffset = spec.spaceBefore;
  let extraExtension = 0;
  let slide = spec.slideDown;
  if (pairing) {
    const label = pairing.labelLayout;
    const labelSize = label.spec?.fontSize ?? first.fontSize;
    const gap = TYPOGRAPHY.spacing.structuredLabelAfter * labelSize;
    const inline = pairing.sourceInline && (label.label?.inline ?? false);
    const sectionGap = Math.min(TYPOGRAPHY.spacing.structuredSectionGap * spec.fontSize, label.spec?.spaceBefore ?? 0);
    if (inline) {
      firstLineIndent = Math.max(0, pairing.labelBlock.x + (label.label?.width ?? 0) + gap - first.x);
      topOffset = sectionGap;
    } else {
      firstLineIndent = 0;
      topOffset = sectionGap + labelSize * (label.spec?.lineHeightRatio ?? 1.3);
    }
    extraExtension = topOffset;
    slide = true;
  }

  const lastIndex = sources.length - 1;
  const buildBoxes = (headroom: number, slideBy: number, roomBelow: number | null): BoxSpec[] =>
    sources.map((b, i) => {
      const pageInfo = pageById.get(b.page);
      let extension = (pageInfo ? extensionFor(b, pageInfo) : 0) + (i === lastIndex ? extraExtension : 0);
      if (roomBelow !== null && i === lastIndex) extension = Math.min(extension, Math.max(0, roomBelow - slideBy));
      const before = i === 0 ? spec.spaceBefore : 0;
      const after = i === lastIndex ? spec.spaceAfter : 0;
      // slideDown roles keep their box and move into the gap above them; the
      // others pay for the paragraph gap out of their own height.
      const height = (slide ? b.height : Math.max(1, b.height - before - after)) + (i === 0 ? headroom : 0);
      let width = i === 0 && options.labelMaxWidth ? Math.max(b.width, options.labelMaxWidth) : b.width;
      // A label the source set in a narrow box may use the free width beside
      // it: its own box is narrow because the English word was short, and one
      // line across the column beats three lines over the text below.
      if (i === 0 && spec.narrowBox && space) width += space.right;
      return {
        width,
        height,
        maxExtension: extension,
        firstLineIndent: i === 0 ? firstLineIndent : 0,
      };
    });

  // A heading is raised above the body size and slides down by its space
  // before, which together need about twice the height of the single line the
  // source set it on. Where the next paragraph starts right under that line
  // there is no room for either, and the heading used to be drawn straight
  // over it. So the space that is actually free decides, in this order:
  // slide only as far as it reaches, then give up the size floor down to the
  // body size (the weight still carries the hierarchy), then take the space
  // above instead of the space below.
  const spaceBoundRole = spec.role === 'heading' || spec.role === 'title' || LABEL_TYPOGRAPHY_ROLES.has(spec.role);
  const space = spaceBoundRole ? options.space : undefined;
  const roomBelow = space ? Math.max(0, space.below - HEADING_CLEARANCE) : null;
  const roomAbove = space ? Math.max(0, space.above - HEADING_CLEARANCE) : 0;
  const bodyFloor = Math.min(spec.minFontSize, Math.max(bodyFontSize, TYPOGRAPHY.fit.minFontSizeAbs));
  if (roomBelow !== null) slide = true; // the heading keeps its box; the room decides how far it may move
  const slideBy = roomBelow === null ? topOffset : Math.min(topOffset, roomBelow);
  const attempts: Array<{ headroom: number; slideBy: number; minFontSize: number }> =
    roomBelow === null
      ? [{ headroom: 0, slideBy: topOffset, minFontSize: spec.minFontSize }]
      : [
          { headroom: 0, slideBy, minFontSize: spec.minFontSize },
          { headroom: 0, slideBy, minFontSize: bodyFloor },
          { headroom: Math.min(roomAbove, spec.fontSize * spec.lineHeightRatio), slideBy: 0, minFontSize: bodyFloor },
        ];

  let attempt = attempts[0];
  let result = fitTextToBoxes(segments, buildBoxes(attempt.headroom, attempt.slideBy, roomBelow), spec.fontSize, mixed, attempt.minFontSize, spec.lineHeightRatio);
  for (let i = 1; i < attempts.length && !result.fits; i++) {
    attempt = attempts[i];
    result = fitTextToBoxes(segments, buildBoxes(attempt.headroom, attempt.slideBy, roomBelow), spec.fontSize, mixed, attempt.minFontSize, spec.lineHeightRatio);
  }
  topOffset = attempt.slideBy - attempt.headroom;

  // Collision guard: the ink of the last box, measured where it will really
  // be drawn. Everything above has already given up the size floor and the
  // slide, so a hit here means the text cannot be made to fit at all; it is
  // drawn (text is never cut) and reported.
  let collision = false;
  if (roomBelow !== null) {
    const last = sources[lastIndex];
    const drawnHeight = result.parts[lastIndex]?.totalHeight ?? 0;
    const inkBottom = (lastIndex === 0 ? last.top - topOffset : last.top) - drawnHeight;
    collision = inkBottom < last.y - roomBelow - 1e-6;
  }
  const parts = new Map<string, string[]>();
  const segmentParts = new Map<string, InlineSegment[][]>();
  sources.forEach((b, i) => {
    parts.set(b.id, result.parts[i]?.lines ?? []);
    segmentParts.set(b.id, result.parts[i]?.segmentLines ?? []);
  });
  const superscriptRuns = segments.filter((seg) => seg.sup).length;
  const subscriptRuns = segments.filter((seg) => seg.sub === true).length;
  return {
    fontSize: result.fontSize,
    lineHeight: result.lineHeight,
    parts,
    segmentParts,
    fits: result.fits,
    extended: result.extended,
    overflow: result.overflow,
    replaced,
    fallbackGlyphs,
    iterations: result.iterations,
    minFontSize: result.minFontSize,
    spaceBound: roomBelow !== null,
    collision,
    spec,
    topOffset,
    firstLineIndent,
    superscriptRuns,
    subscriptRuns,
    markerRestored,
  };
}

/**
 * Lay out a run-in label: a single line at the label typography, allowed to
 * take up to RUN_IN_LABEL_MAX_SHARE of its paragraph's width. When even the
 * floor size needs more than that (or a second line), the label is set on a
 * line of its own.
 */
function layoutLabelUnit(
  unit: TranslationBlock,
  translation: string,
  label: TextBlock,
  paragraph: TextBlock,
  pageById: ReadonlyMap<number, PageDebugInfo>,
  mixed: MixedFont,
  bodyFontSize: number,
  container: LayoutContainer | null,
): UnitLayout {
  const maxWidth = Math.max(label.width, RUN_IN_LABEL_MAX_SHARE * paragraph.width);
  const result = layoutUnit(unit, translation, [label], pageById, mixed, bodyFontSize, { container, labelMaxWidth: maxWidth });
  const lines = result.segmentParts.get(label.id) ?? [];
  const width = lines.length ? measureSegments(lines[0], mixed, result.fontSize) : 0;
  const inline = lines.length === 1 && width <= RUN_IN_LABEL_MAX_SHARE * paragraph.width + 1e-6;
  return { ...result, label: { inline, width, baseline: null } };
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
  const containerById = new Map(layout.containers.map((c) => [c.id, c]));
  const blocksByPage = new Map<number, TextBlock[]>();
  for (const b of layout.blocks) {
    const list = blocksByPage.get(b.page);
    if (list) list.push(b);
    else blocksByPage.set(b.page, [b]);
  }
  const selectedPages = options.pages ?? new Set(analysis.pages.map((p) => p.pageNumber));
  const units = layout.translationBlocks.filter((u) => !options.unitIds || options.unitIds.has(u.id));
  /** Unit that owns a block (first source block only: the pairing of a label with its paragraph). */
  const unitByFirstBlock = new Map<string, TranslationBlock>();
  for (const unit of units) unitByFirstBlock.set(unit.sourceBlockIds[0], unit);
  const debugRoles = options.debugRoles !== false;
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
    figureCells: 0,
    figureCellsWritten: 0,
    figureCellsOverflow: 0,
    typography: {
      titles: 0,
      headings: 0,
      sizeBoosted: 0,
      boldDrawn: 0,
      floorApplied: 0,
      headingsSpaceBound: 0,
      headingCollisions: 0,
      minHeadingBodyRatio: 0,
      indentedParagraphs: 0,
      spacedParagraphs: 0,
      superscriptRuns: 0,
      superscriptUnits: 0,
      subscriptRuns: 0,
      subscriptUnits: 0,
      superscriptRestored: 0,
    },
    layoutRoles: {
      structuredLabels: 0,
      sidebarHeadings: 0,
      sidebarLabels: 0,
      sidebarBodies: 0,
      inlineLabels: 0,
      ownLineLabels: 0,
      contrastShortfall: 0,
      containerMasks: 0,
      tintedMasks: 0,
      lightTextUnits: 0,
    },
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
      role: roleOf(unit),
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

  /** A run-in label's paragraph: the pairing the paragraph is laid out with, once the label has a layout. */
  const pairingFor = (paragraph: TextBlock): LabelPairing | null => {
    if (!paragraph.labelBlockId) return null;
    const labelBlock = blockById.get(paragraph.labelBlockId);
    const labelUnit = labelBlock ? unitByFirstBlock.get(labelBlock.id) : undefined;
    if (!labelBlock || !labelUnit) return null;
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const labelLayout = getLayout(labelUnit);
    if (!labelLayout?.label) return null;
    const sourceInline =
      labelBlock.lines.length > 0 &&
      paragraph.lines.length > 0 &&
      Math.abs(labelBlock.lines[0].y - paragraph.lines[0].y) <= 0.5 * Math.max(labelBlock.fontSize, paragraph.fontSize);
    return { labelLayout, labelBlock, sourceInline };
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
            const isFigure = cellBlock.cell.kind === 'figure';
            if (isFigure) stats.figureCells++;
            else stats.tableCells++;
            const cellLayout = layoutTableCell(entry.translation, cellBlock, cellBlock.cell, mixed as MixedFont);
            if (cellLayout.fits) {
              result = cellLayout;
            } else {
              // Table-only fallback: no downward extension, no clipping — the English cell stays.
              const fit = cellLayout.table?.fit;
              const cell = cellBlock.cell;
              const reasonWord = fit?.reason === 'WIDTH' ? 'wider than the cell' : 'taller than the cell';
              const where = isFigure
                ? `figure ${cell.tableId}, element ${cell.rowIndex}`
                : `table ${cell.tableId}, row ${cell.rowIndex}, column ${cell.columnIndex}`;
              const message =
                `translation is ${reasonWord} by ${cellLayout.overflow.toFixed(1)} pt even at ${cellLayout.fontSize} pt ` +
                `(${where}); English kept`;
              reports.set(unit.id, {
                unitId: unit.id,
                sourceBlockIds: unit.sourceBlockIds,
                page: unit.page,
                type: unit.type,
                role: roleOf(unit),
                cell: {
                  kind: cell.kind,
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
                reason: isFigure ? 'FIGURE_CELL_OVERFLOW' : 'TABLE_CELL_OVERFLOW',
                message,
                skipped: true,
                fallbackGlyphs: 0,
              });
              stats.unitsSkipped++;
              if (isFigure) stats.figureCellsOverflow++;
              else stats.tableCellsOverflow++;
              console.warn(`[PDF Render Warning] block=${unit.id} reason=CELL_OVERFLOW (${message})`);
            }
          } else {
            const first = sources[0];
            const container = first.containerId ? (containerById.get(first.containerId) ?? null) : null;
            const paragraph = first.labelFor ? blockById.get(first.labelFor) : undefined;
            if (paragraph && sources.length === 1) {
              result = layoutLabelUnit(unit, entry.translation, first, paragraph, pageById, mixed as MixedFont, layout.bodyFontSize, container);
            } else {
              const pairing = pairingFor(first);
              // Headings and labels are fitted against the space they really
              // have; layoutUnit ignores it for the other roles.
              const pageInfo = pageById.get(first.page);
              const space = pageInfo
                  ? spaceAround(sources[sources.length - 1], blocksByPage.get(first.page) ?? [], pageInfo)
                  : undefined;
              result = layoutUnit(unit, entry.translation, sources, pageById, mixed as MixedFont, layout.bodyFontSize, { container, pairing, space });
              if (pairing) {
                // The label shares the paragraph's first baseline (inline) or sits one line above it.
                const inline = pairing.sourceInline && pairing.labelLayout.label?.inline;
                const labelSize = pairing.labelLayout.fontSize;
                const firstBaseline = first.top - (result.topOffset ?? 0) - GLYPH_ASCENT * result.fontSize;
                const lineHeight = labelSize * (pairing.labelLayout.spec?.lineHeightRatio ?? 1.3);
                if (pairing.labelLayout.label) {
                  pairing.labelLayout.label.baseline = inline ? firstBaseline : firstBaseline + lineHeight;
                }
              }
            }
            const background = getBackgroundForBlock(first, pageById.get(first.page) as PageDebugInfo, containerById);
            result.background = background;
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
      if (debugRoles) drawDebugRoles(target, pageInfo, layout, labelFont as PDFFont);
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
        const background = (getLayout(unit) as UnitLayout).background ?? getBackgroundForBlock(block, pageInfo, containerById);
        for (const line of block.lines) {
          if (!drawLineMask(target, line, pageInfo, background)) continue;
          stats.masksDrawn++;
          if (background.source === 'container') stats.layoutRoles.containerMasks++;
          else if (background.source !== 'white') stats.layoutRoles.tintedMasks++;
        }
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
          role: roleOf(unit),
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
        if (unitLayout.spec && firstBlock) {
          const lines = unitLayout.parts.get(firstBlock.id)?.length ?? 0;
          const top = unitLayout.label?.baseline !== null && unitLayout.label?.baseline !== undefined
            ? unitLayout.label.baseline + GLYPH_ASCENT * unitLayout.fontSize
            : firstBlock.top - (unitLayout.topOffset ?? 0);
          const height = lines > 0 ? (lines - 1) * unitLayout.lineHeight + unitLayout.fontSize * (GLYPH_ASCENT + GLYPH_DESCENT) : 0;
          existing.extent = { top: Math.round(top * 100) / 100, bottom: Math.round((top - height) * 100) / 100 };
        }
        if (unitLayout.background) {
          const bg = unitLayout.background;
          existing.background = { color: bg.color, source: bg.source, light: bg.light };
          if (bg.light) {
            stats.layoutRoles.lightTextUnits++;
            notes.push(`drawn in white on ${bg.color}`);
          } else if (bg.source === 'container') notes.push(`masked in the container fill ${bg.color ?? 'white'}`);
          else if (bg.source === 'fill' && bg.color) notes.push(`masked in the fill ${bg.color}`);
        }
        const role = roleOf(unit);
        const lr = stats.layoutRoles;
        if (role === 'STRUCTURED_LABEL') lr.structuredLabels++;
        else if (role === 'SIDEBAR_HEADING') lr.sidebarHeadings++;
        else if (role === 'SIDEBAR_LABEL') lr.sidebarLabels++;
        else if (role === 'SIDEBAR_BODY') lr.sidebarBodies++;
        if (unitLayout.label) {
          if (unitLayout.label.inline) lr.inlineLabels++;
          else lr.ownLineLabels++;
        }
        if (unitLayout.table && firstBlock?.cell) {
          const cell = firstBlock.cell;
          existing.cell = {
            kind: cell.kind,
            tableId: cell.tableId,
            row: cell.rowIndex,
            column: cell.columnIndex,
            sourceText: firstBlock.text,
            finalFontSize: unitLayout.fontSize,
            overflowReason: null,
          };
          if (cell.kind === 'figure') stats.figureCellsWritten++;
          else stats.tableCellsWritten++;
          const what = cell.kind === 'figure' ? 'figure element' : 'table cell';
          if (unitLayout.fontSize < cell.fontSize) notes.push(`${what} shrunk from ${cell.fontSize} pt to ${unitLayout.fontSize} pt`);
          if (unitLayout.lineHeight < unitLayout.fontSize * 1.1) notes.push('tight cell line height');
          if (cell.textOnDark) notes.push(`drawn in white on ${cell.background ?? 'a dark background'}`);
        }
        const spec = unitLayout.spec;
        if (spec) {
          const runs = unitLayout.superscriptRuns ?? 0;
          const lowRuns = unitLayout.subscriptRuns ?? 0;
          existing.typography = {
            role: spec.role,
            startFontSize: spec.fontSize,
            minFontSize: spec.minFontSize,
            bodyRatio: layout.bodyFontSize > 0 ? Math.round((unitLayout.fontSize / layout.bodyFontSize) * 100) / 100 : 0,
            bold: spec.bold,
            firstLineIndent: spec.firstLineIndent,
            spaceBefore: spec.spaceBefore,
            spaceAfter: spec.spaceAfter,
            superscripts: runs,
            subscripts: lowRuns > 0 ? lowRuns : undefined,
            contrast: spec.contrast.length ? [...spec.contrast] : undefined,
            labelPlacement: unitLayout.label ? (unitLayout.label.inline ? 'inline' : 'own-line') : undefined,
          };
          if (!hasRequiredContrast(spec)) {
            stats.layoutRoles.contrastShortfall++;
            notes.push(`label keeps only ${spec.contrast.length} contrast(s) to the body text`);
          }
          const t = stats.typography;
          if (spec.role === 'title') t.titles++;
          if (spec.role === 'heading') t.headings++;
          if (spec.bold) t.boldDrawn++;
          if (spec.boosted) t.sizeBoosted++;
          if (spec.role === 'title' || spec.role === 'heading') {
            const ratio = existing.typography.bodyRatio;
            t.minHeadingBodyRatio = t.minHeadingBodyRatio === 0 ? ratio : Math.min(t.minHeadingBodyRatio, ratio);
            if (unitLayout.fontSize <= spec.minFontSize + 1e-6) t.floorApplied++;
            if (unitLayout.spaceBound) t.headingsSpaceBound++;
            if (unitLayout.collision) {
              t.headingCollisions++;
              notes.push('still reaches the block below');
            }
          }
          if (spec.firstLineIndent > 0) t.indentedParagraphs++;
          if (spec.spaceBefore > 0 || spec.spaceAfter > 0) t.spacedParagraphs++;
          if (runs > 0) {
            t.superscriptUnits++;
            t.superscriptRuns += runs;
          }
          if (lowRuns > 0) {
            t.subscriptUnits++;
            t.subscriptRuns += lowRuns;
          }
          if (unitLayout.markerRestored) t.superscriptRestored++;
          if (spec.boosted) notes.push(`${spec.role} raised from ${firstBlock?.fontSize ?? spec.fontSize} pt to ${spec.fontSize} pt`);
          if (runs > 0) notes.push(`${runs} citation marker(s) drawn as superscript`);
          if (lowRuns > 0) notes.push(`${lowRuns} run(s) drawn as subscript`);
          if (unitLayout.markerRestored) notes.push('trailing citation marker restored');
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
        const spec = unitLayout.spec;
        const isFirstBox = id === unit.sourceBlockIds[0];
        const outcome = unitLayout.table
          ? drawTableCellText(writer, unitLayout.table.placement, unitLayout.fontSize, mixed as MixedFont, block.cell?.textOnDark === true)
          : drawBlockText(
              writer,
              block,
              pageInfo,
              unitLayout.segmentParts.get(id) ?? [],
              unitLayout.fontSize,
              unitLayout.lineHeight,
              mixed as MixedFont,
              isCenteredBlock(block, pageInfo, blocksByPage.get(block.page) ?? []),
              {
                // Paragraph space and indent belong to the first box only; a
                // continuation box carries the rest of the same paragraph.
                topOffset: isFirstBox ? (unitLayout.topOffset ?? 0) : 0,
                firstLineIndent: isFirstBox ? (unitLayout.firstLineIndent ?? spec?.firstLineIndent ?? 0) : 0,
                bold: spec?.bold ?? false,
                boldStrokeRatio: spec?.boldStrokeRatio ?? 0,
                light: unitLayout.background?.light === true,
                baselineOverride: isFirstBox ? (unitLayout.label?.baseline ?? undefined) : undefined,
              },
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
