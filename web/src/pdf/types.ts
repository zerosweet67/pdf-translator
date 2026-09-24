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

/** A stroked rectangle (a flowchart box, a legend frame), PDF user space. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Stroke width (points). */
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
  /** Filled rectangles that may be table backgrounds or figure boxes. */
  fills: FilledRect[];
  /** Stroked rectangles (outlined flowchart boxes, legend frames). */
  frames: FrameRect[];
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
  /**
   * The PDF's native outline (bookmarks) with every destination resolved to a
   * page and, when the destination carries one, a Y anchor (pdf/outline.ts).
   * Empty when the PDF has no outline. Optional so fixtures need not set it.
   */
  outline?: OutlineNode[];
  /** Outline items whose destination could not be resolved (Developer Mode). */
  outlineWarnings?: string[];
}

/**
 * One outline (bookmark) entry, destination already resolved. `page` is the
 * 1-based PDF page index (not the printed page number); `y` is the anchor in
 * PDF user space (points, origin bottom-left) when the destination has one
 * (/XYZ, /FitH, /FitR), null otherwise. `page` is null when the destination
 * could not be resolved; the entry is then ignored by chapter detection but
 * its children are still used.
 */
export interface OutlineNode {
  title: string;
  page: number | null;
  y: number | null;
  children: OutlineNode[];
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
  | 'FIGURE'
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
  | 'FIGURE_LABEL'
  | 'SUPPLEMENTAL_HEADING'
  | 'SUPPLEMENTAL_BODY'
  | 'SUPPLEMENTAL_FOOTNOTE'
  | 'QUESTIONNAIRE'
  | 'APPENDIX_HEADING'
  | 'APPENDIX_BODY';

/**
 * Generic layout role of a block (pdf/roles.ts). `type` keeps driving the
 * legacy pipelines (merging, overlay eligibility); `role` refines how a block
 * is translated (short per-role guidance) and rendered (typography, container
 * aware masking). Every block carries one; the default is derived from `type`.
 */
export type LayoutRole =
  | 'BODY'
  | 'HEADING'
  | 'STRUCTURED_LABEL'
  | 'SIDEBAR'
  | 'CALLOUT_BOX'
  | 'SIDEBAR_HEADING'
  | 'SIDEBAR_LABEL'
  | 'SIDEBAR_BODY'
  | 'CAPTION'
  | 'TABLE'
  | 'FIGURE'
  | 'FOOTNOTE'
  | 'REFERENCE';

/** Container kinds a layout detector can produce (pdf/detectors/). */
export type LayoutContainerType = 'SIDEBAR' | 'CALLOUT_BOX';

/**
 * A container that owns several text blocks: a shaded sidebar, an outlined
 * callout box. Detected by pdf/detectors/sidebar.ts; its children carry
 * `containerId` and one of the SIDEBAR_* roles. The container itself is
 * never a translation unit and its vector graphics are never redrawn.
 */
export interface LayoutContainer {
  /** "p{page}-c{index}". */
  id: string;
  type: LayoutContainerType;
  page: number;
  bbox: Rect;
  /** Fill colour of the panel ("#f4f3ec"), null for a plain / white panel. */
  backgroundFill: string | null;
  /** Outline: a stroked frame or the rules that box the panel, null when there is none. */
  border: { thickness: number; source: 'frame' | 'rules' } | null;
  /** Inner usable area: bbox inset by the padding. */
  padding: { left: number; right: number; top: number; bottom: number };
  /** Ids of the child blocks, in reading order. */
  children: string[];
  /** 0–1, from the detector's signals (only containers above the threshold are kept). */
  confidence: number;
  /** Which signals fired, for Developer Mode. */
  signals: string[];
  /** Detector that produced it. */
  detector: string;
  /** Dominant body font size of the children (points), the typographic reference inside the panel. */
  bodyFontSize: number;
  /** True when the fill is dark enough that text inside is drawn in white. */
  textOnDark: boolean;
}

/** One label + body pair of a structured abstract (pdf/detectors/structuredAbstract.ts). */
export interface StructuredSection {
  /** Id of the STRUCTURED_LABEL block. */
  labelBlock: string;
  /** Ids of the body blocks that follow the label, in reading order. */
  bodyBlocks: string[];
  bbox: Rect;
  /** True when the label opens the first line of its paragraph (run-in label). */
  inline: boolean;
  /** 0–1 label confidence. */
  confidence: number;
  signals: string[];
}

/** A structured abstract: several label + body sections with one label style. */
export interface StructuredAbstractRegion {
  /** "p{page}-sa{index}". */
  id: string;
  page: number;
  bbox: Rect;
  sections: StructuredSection[];
  /** 0–1 region confidence (only regions above the threshold are kept). */
  confidence: number;
  signals: string[];
  detector: string;
}

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
  /** Figure this block belongs to (per document), FIGURE blocks only. */
  figureId?: number;
  /**
   * Set when the block is one logical table cell (pdf/table.ts): the cell's
   * usable rectangle, position and alignment. Such a block is masked, fitted
   * and drawn by the table-only path of the renderer.
   */
  cell?: TableCellInfo;
  /**
   * Superscript runs found in this block: citation markers ("62",
   * "16,27-29") and exponents, in the order they appear (pdf/superscript.ts),
   * each with the identifier it followed. The renderer raises them again in
   * the translation; the block text itself is untouched, so the translation
   * input and its cache key do not change.
   */
  superscripts?: ScriptRun[];
  /**
   * Subscript runs found in this block (the "2" of H2O, the "p" of np2), in
   * the order they appear (pdf/superscript.ts). Recovered from the operator
   * list by pdf/textruns.ts when PDF.js merged them into their neighbour.
   */
  subscripts?: ScriptRun[];
  /**
   * Set on a sentence-tail fragment that pdf/paragraph.ts attached to an
   * earlier paragraph: the id of the block it belongs to. Such a block is
   * never a translation unit of its own.
   */
  orphanOf?: string;
  /** Why the orphan detector attached it, for Developer Mode. */
  orphanReason?: string;
  /** Generic layout role (pdf/roles.ts); absent = the default role of `type` (see roleOf()). */
  role?: LayoutRole;
  /** Container (sidebar / callout) that owns this block, when any. */
  containerId?: string;
  /**
   * Structured / sidebar label: the body block the label introduces. Set on
   * a STRUCTURED_LABEL / SIDEBAR_LABEL block that was split off the first
   * line of its paragraph (run-in label); the renderer draws the label and
   * that body on one first line.
   */
  labelFor?: string;
  /** Body block: the run-in label block that opens its first line. */
  labelBlockId?: string;
  /** Which detector assigned the role, for Developer Mode. */
  roleDetector?: string;
  /** 0–1 confidence of the role assignment (1 for the default role). */
  roleConfidence?: number;
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
 * A raised or lowered run together with the identifier it hangs off.
 *
 * A script run is rarely a word of its own — it is the "p" of np2, the "2" of
 * H2O, the "1" of FEV1, the exponent of np2 — so on its own it cannot be
 * found again in the translation without moving every stray letter or digit.
 * `anchor` is the identifier that immediately preceded it on its source line;
 * the renderer looks for the two together.
 */
export interface ScriptRun {
  /** The run's own text ("p", "2", "1,16", "62"). */
  text: string;
  /** The identifier it directly followed on the source line ("n", "H", "FEV"); empty when it had none. */
  anchor: string;
}

/**
 * One run of translated text that shares a single vertical position: either
 * ordinary text or a raised citation marker. Produced by pdf/inline.ts,
 * wrapped by pdf/fit.ts and drawn by pdf/render.ts.
 */
export interface InlineSegment {
  text: string;
  /** Draw smaller and raised above the baseline (pdf/typography.ts). */
  sup: boolean;
  /** Draw smaller and lowered below the baseline; mutually exclusive with `sup`. */
  sub?: boolean;
}

/**
 * One logical cell: every text item, line and footnote marker of one table
 * cell (pdf/table.ts) or one figure text element (pdf/figure.ts) merged into
 * a single translation unit. Both are masked, fitted and drawn by the
 * cell path of the renderer, never by the paragraph path.
 */
export interface TableCellInfo {
  /** "p{page}-t{tableId}-r{row}c{col}" for a table, "p{page}-f{figureId}-..." for a figure. */
  id: string;
  /** Table cell or figure text element. */
  kind: 'table' | 'figure';
  page: number;
  /** Table id, or figure id when `kind` is 'figure'. */
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
  /** Fill colour behind the cell ("#f4f3ec"), null for plain paper (masked white). */
  background: string | null;
  /**
   * False when this text cannot be masked safely: its background could not be
   * sampled reliably (several fills, or a raster image underneath), or a
   * ruling line runs through the glyphs, so a mask would erase an axis,
   * gridline or connector. Such a cell keeps its source text.
   */
  maskable: boolean;
  /** True when the background is dark enough that the translation is drawn in white (WCAG contrast). */
  textOnDark: boolean;
}

/** How one detected figure was resolved (Developer Mode figure diagnostics). */
export interface FigureSummary {
  page: number;
  figureId: number;
  /** False when no text element could be separated confidently; the figure stays English. */
  resolved: boolean;
  /** Text containers (filled or outlined boxes) found inside the figure. */
  containers: number;
  /** True when the loose text was resolved as a row/column grid (forest plot, structured figure). */
  structured: boolean;
  cells: number;
  translatedCells: number;
  numericCells: number;
  /** Raw text items the figure owns. */
  textItems: number;
  reason: string | null;
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
  /** Detected figures (caption + vector cluster) and how their text elements were resolved. */
  figures: FigureSummary[];
  /** Sidebar / callout containers (pdf/detectors/sidebar.ts). */
  containers: LayoutContainer[];
  /** Structured abstract regions (pdf/detectors/structuredAbstract.ts). */
  structuredRegions: StructuredAbstractRegion[];
  /** Per-detector ownership ledger: detector name → number of blocks it claimed. */
  roleOwnership: Record<string, number>;
  stats: {
    lineCount: number;
    blockCount: number;
    translationBlockCount: number;
    /** Translation units that combine 2–3 layout blocks. */
    mergedBlockCount: number;
    /** Sentence-tail fragments absorbed into the preceding paragraph (pdf/paragraph.ts). */
    orphanMergedCount: number;
    /** Fragment-looking blocks the orphan detector left alone (no safe owner). */
    orphanUnresolvedCount: number;
    /** Superscript citation markers found across the document (pdf/superscript.ts). */
    superscriptMarkerCount: number;
    /** Layout blocks that carry at least one superscript citation marker. */
    superscriptBlockCount: number;
    /** Markers found only by the glued-text fallback (weaker evidence). */
    superscriptGluedCount: number;
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
    /** Figures detected with high confidence (caption + vector cluster). */
    figureCount: number;
    /** Logical text elements over all resolved figures. */
    figureCellCount: number;
    figureTranslatedCells: number;
    /** Numeric figure cells kept as they are (no API call). */
    figureNumericCells: number;
    /** Figures whose text could not be separated (kept in English). */
    figureUnresolvedCount: number;
    /** Vertical bands of a two-column page a full-width table occupies (pdf/layout.ts). */
    tableBandCount: number;
    /** Blocks inside such a band that the table pipeline did not claim; kept out of the translation. */
    tableBandSuppressed: number;
    /**
     * Source text items claimed by more than one block after tables and
     * figures were resolved. Must be 0; a non-zero value means a text item
     * would be translated (and masked) twice.
     */
    duplicateSourceItems: number;
    /** Structured abstract regions / labels found (pdf/detectors/structuredAbstract.ts). */
    structuredRegionCount: number;
    structuredLabelCount: number;
    /** Sidebar / callout containers and their children (pdf/detectors/sidebar.ts). */
    sidebarCount: number;
    calloutCount: number;
    sidebarChildCount: number;
    /** Source text items owned by blocks with a detector-assigned role. */
    roleClaimedSourceItems: number;
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
  /** Layout role of the first source block (pdf/roles.ts); absent = the default role of `type`. */
  role?: LayoutRole;
  /** Sidebar / callout container of the source blocks, when any. */
  containerId?: string;
  /** Text to translate: source texts joined with hyphenation repaired. */
  text: string;
  /** Layout block ids this translation covers, in reading order. */
  sourceBlockIds: string[];
  wasMerged: boolean;
  /** Human-readable explanation of each merge step, null when not merged. */
  mergeReason: string | null;
  /** Source block ids that were absorbed as sentence-tail fragments (pdf/paragraph.ts). */
  orphanFragmentIds?: string[];
  /**
   * Superscript runs of the source blocks ("62", "16,27-29", exponents), in
   * order. The renderer uses them to raise the same runs in the translation;
   * `text` (and therefore the cache key) is unaffected.
   */
  superscripts?: ScriptRun[];
  /** Subscript runs of the source blocks, in order. */
  subscripts?: ScriptRun[];
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
  /**
   * Where the unit starts and ends on the page(s), for the translation scope
   * (scope/scope.ts): top of the first source block and bottom of the last
   * one. Set by buildTranslationBlocks(); fixtures may leave it out, the scope
   * then falls back to `pages`.
   */
  span?: UnitSpan;
}

/** Page + Y extent of a translation unit in PDF user space (y grows upward). */
export interface UnitSpan {
  startPage: number;
  /** Top edge of the first source block. */
  startY: number;
  endPage: number;
  /** Bottom edge of the last source block. */
  endY: number;
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
