/**
 * Shared data structures.
 *
 * Coordinates everywhere are PDF user space: points, origin bottom-left,
 * y grows upward. Nothing here is converted to canvas or pdf-lib space yet.
 */

// ---------------------------------------------------------------------------
// Phase B: raw PDF.js extraction
// ---------------------------------------------------------------------------

/** One PDF.js text item, normalized for debugging. */
export interface TextItemDebug {
  /** 1-based page number. */
  page: number;
  /** The text string PDF.js produced for this item. */
  text: string;
  /** Baseline start X in PDF user space (points). transform[4]. */
  x: number;
  /** Baseline Y in PDF user space (points, origin at bottom). transform[5]. */
  y: number;
  /** Advance width of the whole item in points, as reported by PDF.js. */
  width: number;
  /** Item height in points, as reported by PDF.js (usually equals fontSize). */
  height: number;
  /** Effective font size in points, derived from the transform matrix. */
  fontSize: number;
  /** PDF.js internal font identifier, e.g. "g_d0_f1". Stable within one document. */
  fontName: string;
  /** Generic family from textContent.styles ("serif", "sans-serif", ...). */
  fontFamily: string | null;
  /** Real font name from the PDF when available, e.g. "TimesNewRomanPS-BoldMT". */
  fontRealName: string | null;
  /** PDF.js hint that a line break follows this item. Not reliable for paragraphs. */
  hasEOL: boolean;
  /** Raw 6-element transform matrix [a, b, c, d, e, f] exactly as PDF.js gave it. */
  transform: number[];
}

/** Axis-aligned bounding box of a raster image drawn on a page, PDF user space. */
export interface ImageBox {
  /** Left edge (points). */
  x: number;
  /** Bottom edge (points). */
  y: number;
  width: number;
  height: number;
}

/**
 * A thin straight vector line (stroked path or thin filled rectangle) on a
 * page, PDF user space. Table rules are the main use; `x1 - x0` or `y1 - y0`
 * is (almost) zero depending on the orientation.
 */
export interface RuleLine {
  orientation: 'horizontal' | 'vertical';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Stroke width or rectangle thickness (points). */
  thickness: number;
}

/** A filled rectangle (row shading, header background), PDF user space. */
export interface FilledRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** CSS hex colour as PDF.js reports it ("#f4f3ec"), null when unknown. */
  color: string | null;
}

/** Per-page geometry, needed later when converting coordinate systems. */
export interface PageDebugInfo {
  pageNumber: number;
  /** Rendered width at scale 1, in points (already accounts for /Rotate). */
  width: number;
  /** Rendered height at scale 1, in points. */
  height: number;
  /** Page rotation in degrees (0, 90, 180, 270). */
  rotation: number;
  /** Raw page box [x0, y0, x1, y1]. Origin is NOT always (0, 0). */
  view: number[];
  /** Non-whitespace text items found on this page. */
  textItemCount: number;
  /**
   * Raster images (XObjects and inline images) placed on the page, from the
   * operator list. Vector drawings are not included. Empty when detection failed.
   */
  images: ImageBox[];
  /**
   * Horizontal / vertical rules (table borders, separators) from the operator
   * list. Empty when detection failed or the page has none.
   */
  rules: RuleLine[];
  /** Filled rectangles that may be table backgrounds (light colours only). */
  fills: FilledRect[];
}

/** Result of analysing one PDF file. */
export interface PdfAnalysis {
  fileName: string;
  fileSize: number;
  pdfjsVersion: string;
  pageCount: number;
  pages: PageDebugInfo[];
  /** All non-whitespace text items across all pages, in PDF.js order. */
  items: TextItemDebug[];
  /** Number of non-whitespace text items. */
  textItemCount: number;
  /** Number of items that were whitespace only and were skipped. */
  whitespaceItemCount: number;
  /** True when at least one non-whitespace text item exists. */
  hasSelectableText: boolean;
  /** Items that look like unreadable output, e.g. "(cid:123)" or U+FFFD. */
  suspiciousItemCount: number;
  /** suspiciousItemCount / textItemCount, 0 when there are no items. */
  suspiciousRatio: number;
  /** Symbol-font Private Use Area characters converted to Unicode (see symbols.ts). */
  normalizedSymbolCount: number;
}

// ---------------------------------------------------------------------------
// Phase C: layout analysis
// ---------------------------------------------------------------------------

export type ColumnLayout = 'SINGLE_COLUMN' | 'TWO_COLUMN';

/**
 * Which horizontal region of the page a line or block occupies.
 *  FULL     - single-column page
 *  LEFT     - left column of a two-column page
 *  RIGHT    - right column of a two-column page
 *  SPANNING - crosses the gutter on a two-column page (title, abstract, wide caption)
 */
export type ColumnRegion = 'FULL' | 'LEFT' | 'RIGHT' | 'SPANNING';

/**
 * Coarse block type: drives merging (BODY only), overlay eligibility and
 * text placement. TABLE covers text cells of a detected table.
 */
export type BlockType =
  | 'TITLE'
  | 'AUTHOR'
  | 'HEADING'
  | 'BODY'
  | 'CAPTION'
  | 'FOOTNOTE'
  | 'HEADER'
  | 'FOOTER'
  | 'REFERENCE'
  | 'TABLE'
  | 'OTHER';

/**
 * Document section a block belongs to (classify.ts). REFERENCES ends at the
 * next figure/table caption or high-level heading; FIGURES / TABLES are the
 * figure and table pages placed after the reference list.
 */
export type SectionType = 'MAIN' | 'REFERENCES' | 'FIGURES' | 'TABLES' | 'SUPPLEMENTAL' | 'APPENDIX';

/** Fine-grained classification shown in Developer Mode; `type` is derived from it. */
export type DetailedBlockType =
  | 'TITLE'
  | 'AUTHOR'
  | 'HEADING'
  | 'BODY'
  | 'CAPTION'
  | 'FOOTNOTE'
  | 'HEADER'
  | 'FOOTER'
  | 'REFERENCE'
  | 'OTHER'
  | 'FIGURE_CAPTION'
  | 'FIGURE_NOTE'
  | 'TABLE_CAPTION'
  | 'TABLE_HEADER'
  | 'TABLE_TEXT_LABEL'
  | 'TABLE_CELL'
  | 'TABLE_NOTE'
  | 'SUPPLEMENTAL_HEADING'
  | 'SUPPLEMENTAL_BODY'
  | 'SUPPLEMENTAL_FOOTNOTE'
  | 'QUESTIONNAIRE'
  | 'APPENDIX_HEADING'
  | 'APPENDIX_BODY';

/** A visual line: text items sharing one baseline and horizontally adjacent. */
export interface TextLine {
  page: number;
  text: string;
  /** Left edge (points). */
  x: number;
  /** Baseline Y (points). Glyphs extend above by ~0.8·fontSize and below by ~0.25·fontSize. */
  y: number;
  width: number;
  /** Approximate visual height, equals the dominant fontSize. */
  height: number;
  /** Font size of the item that contributes the most characters. */
  fontSize: number;
  /** Font id of the item that contributes the most characters. */
  fontName: string;
  fontRealName: string | null;
  column: ColumnRegion;
  items: TextItemDebug[];
}

/** A paragraph-like block: consecutive lines in the same column. */
export interface TextBlock {
  /** "p{page}-b{index}" in reading order within the page. */
  id: string;
  page: number;
  type: BlockType;
  /** Section the block lives in (MAIN until a references heading, ...). */
  sectionType: SectionType;
  /** Fine-grained type (TABLE_CAPTION, SUPPLEMENTAL_BODY, ...). */
  blockType: DetailedBlockType;
  /** Lines joined with spaces, end-of-line hyphenation removed. */
  text: string;
  /** Bounding box left edge (points). */
  x: number;
  /** Bounding box BOTTOM edge (points, PDF coordinates). */
  y: number;
  width: number;
  height: number;
  /** Convenience: y + height. */
  top: number;
  fontSize: number;
  fontName: string;
  fontRealName: string | null;
  column: ColumnRegion;
  lineCount: number;
  lines: TextLine[];
  /** Reading order across the whole document, 0-based. */
  order: number;
  /** Whether this block is sent to the translation API. */
  translate: boolean;
  /** Why the block is not translated, null when translate is true. */
  skipReason: string | null;
  /** Table this block belongs to (per document, from the table caption), TABLE blocks only. */
  tableId?: number;
  /**
   * Set when the block is one logical table cell (pdf/table.ts): the cell's
   * usable rectangle, position and alignment. Such a block is masked, fitted
   * and drawn by the table-only path of the renderer.
   */
  cell?: TableCellInfo;
}

/** Horizontal alignment of a table cell, taken from its column. */
export type CellAlignment = 'left' | 'center' | 'right';

/** Axis-aligned rectangle in PDF user space (bottom-left origin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One logical table cell: every text item, line and footnote marker of that
 * cell merged into one translation unit (pdf/table.ts).
 */
export interface TableCellInfo {
  /** "p{page}-t{tableId}-r{row}c{col}". */
  id: string;
  page: number;
  tableId: number;
  rowIndex: number;
  columnIndex: number;
  /** Number of columns the cell spans (1 for an ordinary cell). */
  colSpan: number;
  /** Index of every source text item (position in PdfAnalysis.items) of this cell. */
  sourceItemIds: number[];
  /** Tight union of the source glyph boxes. */
  textBox: Rect;
  /**
   * Rectangle the translation may occupy: inside the row / column band,
   * clear of table rules and neighbouring cells, with a small padding.
   */
  usable: Rect;
  alignment: CellAlignment;
  fontSize: number;
  /** Cell text only: numbers, statistics, dashes. Never translated. */
  numeric: boolean;
  /** Column header (above the first data row). */
  header: boolean;
  /** Superscript footnote marker at the end of the cell ("d" of "Medicaid^d"), drawn back after the translation. */
  trailingMarker: string | null;
  /** Fill colour behind the cell ("#f4f3ec"), null for plain paper. */
  background: string | null;
}

/** Table diagnostics for Developer Mode (one entry per detected table). */
export interface TableSummary {
  page: number;
  tableId: number;
  /** False when cell clustering failed; the table's blocks then stay in English. */
  resolved: boolean;
  rows: number;
  columns: number;
  cells: number;
  translatedCells: number;
  numericCells: number;
  headerCells: number;
  /** Why clustering failed, null when resolved. */
  reason: string | null;
}

export interface PageLayout {
  pageNumber: number;
  layout: ColumnLayout;
  /** Empty vertical band between the two columns, null for single-column pages. */
  gutter: { left: number; right: number } | null;
  width: number;
  height: number;
  view: number[];
  lineCount: number;
  blockCount: number;
}

export interface LayoutResult {
  /** Character-weighted most common font size across the document. */
  bodyFontSize: number;
  pages: PageLayout[];
  /** All blocks in reading order. */
  blocks: TextBlock[];
  /** The subset that will be translated, in reading order. */
  translationBlocks: TranslationBlock[];
  /** Detected tables (from table captions) and how their cells were resolved. */
  tables: TableSummary[];
  stats: {
    lineCount: number;
    blockCount: number;
    translationBlockCount: number;
    /** Translation units that combine 2–3 layout blocks. */
    mergedBlockCount: number;
    /** Translation units whose text still looks cut off after merging. */
    incompleteBlockCount: number;
    twoColumnPages: number;
    singleColumnPages: number;
    /** Characters of `text` over all translation units (what must be translated). */
    inputChars: number;
    /** Characters of previous/next context actually attached. */
    contextChars: number;
    /** Units that carry extra context. */
    contextUnitCount: number;
    /** Context characters the old "300 chars both sides for every unit" policy would have sent, minus contextChars. */
    contextCharsSaved: number;
    /** Tables detected from captions. */
    tableCount: number;
    /** Logical cells over all resolved tables. */
    tableCellCount: number;
    tableTranslatedCells: number;
    /** Numeric cells kept as they are (no API call). */
    tableNumericCells: number;
    /** Tables whose cells could not be resolved (kept in English). */
    tableUnresolvedCount: number;
  };
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * A unit of translation. Usually one TextBlock; may be several consecutive
 * BODY blocks merged because the sentence ran across a column or page break.
 */
export interface TranslationBlock {
  /** Original block id, or "merged-<id1>-<id2>..." when wasMerged. */
  id: string;
  /** Page of the first source block. */
  page: number;
  /** All pages the source blocks live on (1 or 2 entries). */
  pages: number[];
  type: BlockType;
  /** sectionType / blockType of the first source block, for debugging. */
  sectionType: SectionType;
  blockType: DetailedBlockType;
  /** Text to translate: source texts joined with hyphenation repaired. */
  text: string;
  /** Layout block ids this translation covers, in reading order. */
  sourceBlockIds: string[];
  wasMerged: boolean;
  /** Human-readable explanation of each merge step, null when not merged. */
  mergeReason: string | null;
  /** True when the text still does not end a sentence after merging. */
  incompleteSource: boolean;
  /**
   * Tail of the previous translation unit, for context only. Sent only when
   * the unit needs it (see contextReason); blocks in one batch already see
   * each other.
   */
  previousContext: string | null;
  /** Head of the next translation unit, for context only. */
  nextContext: string | null;
  /** Why extra context is attached ("incomplete", "merged", "continuation"), null when none. */
  contextReason: string | null;
  /** Phase D: whether the overlay renderer masks and rewrites this unit. Set by assessOverlay(). */
  overlayEligible?: boolean;
  /** Why the unit is not overlaid ("TYPE_FOOTNOTE", "IMAGE_OVERLAP", ...), null when eligible. */
  overlaySkippedReason?: string | null;
}

/** `skipped`: needs no translation (number, DOI, URL, ...); kept as it is and never sent. */
export type TranslationStatus = 'pending' | 'translating' | 'done' | 'cached' | 'skipped' | 'failed';

/**
 * QA triggers (translate/risk.ts), in priority order. The first three are
 * critical: they always go to QA, even beyond the QA budget.
 */
export type QaTrigger =
  | 'PLACEHOLDER_ERROR'
  | 'NUMERIC_MISMATCH'
  | 'CITATION_MISMATCH'
  | 'SYMBOL_MISMATCH'
  | 'NEGATION_WITH_OUTCOME'
  | 'UNCERTAINTY_WITH_OUTCOME'
  | 'CROSS_PAGE_INCOMPLETE'
  | 'MERGED_INCOMPLETE_SEMANTIC'
  | 'HIGH_RISK_SCORE';

/** hard: a QA candidate (a trigger fired); soft: weighting signals only, never sent to QA on their own. */
export type RiskLevel = 'none' | 'soft' | 'hard';

/** Risk signals of a block (translate/risk.ts); hard or soft depending on the combination. */
export type RiskReason =
  | 'NUMERIC_MISMATCH'
  | 'CITATION_MISMATCH'
  | 'PLACEHOLDER_ERROR'
  | 'MERGED_BLOCK'
  | 'CROSS_PAGE_BLOCK'
  | 'INCOMPLETE_SOURCE'
  | 'LENGTH_ANOMALY'
  | 'SYMBOL_MISSING'
  | 'NEGATION'
  | 'UNCERTAINTY'
  | 'DENSE_NOTATION';

/**
 * Second-pass QA state of a block:
 *  none      – not a QA candidate (no risk, or soft risk only), never sent
 *  skipped   – hard-risk but over the QA budget (cost cap)
 *  pending   – selected, request in flight
 *  ok        – reviewed, first translation kept
 *  corrected – reviewed, translation replaced once
 *  failed    – QA request failed or returned nothing; first translation kept
 */
export type QaState = 'none' | 'skipped' | 'pending' | 'ok' | 'corrected' | 'failed';

/** Post-translation checks of one block (translate/batch.ts); absent for skipped / failed blocks. */
export interface BlockQuality {
  /** Hash of the terminology entries relevant to this block (part of its cache key). */
  terminologyHash: string;
  /** Protected entities (citations, references, DOIs, URLs, e-mails) in the source. */
  protectedEntities: number;
  placeholderMissing: string[];
  numericMissing: string[];
  numericAdded: string[];
  citationMissing: string[];
  citationAdded: string[];
  riskScore: number;
  /** Every signal that fired (hard and soft). */
  riskReasons: RiskReason[];
  riskLevel: RiskLevel;
  /** QA triggers that fired, in priority order; empty for soft risk. */
  qaTriggers: QaTrigger[];
  /** Hard risk: a QA candidate (`riskLevel === 'hard'`). */
  highRisk: boolean;
  qa: QaState;
  /** Issue codes returned by the QA pass (NUMERIC_MISMATCH, NEGATION_ERROR, ...). */
  qaIssues: string[];
  /** First-round translation, kept when QA replaced it. */
  originalTranslation: string | null;
}

export interface TranslationEntry {
  id: string;
  status: TranslationStatus;
  translation: string | null;
  error: string | null;
  quality?: BlockQuality;
}
