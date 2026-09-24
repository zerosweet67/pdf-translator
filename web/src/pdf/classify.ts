/**
 * Phase C: heuristic block classification and "do not translate" rules.
 *
 * Inputs are blocks in reading order (see layout.ts). This module mutates
 * `type`, `sectionType`, `blockType`, `translate` and `skipReason` in place. Everything is based on
 * font size relative to the body text, page position, repetition across
 * pages and simple regular expressions. No machine learning.
 */

import { analyzeCompleteness } from './text';
import type { BlockType, DetailedBlockType, PageDebugInfo, SectionType, TextBlock } from './types';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const CAPTION_RE = /^(fig(ure)?s?\.?|table|scheme|chart|plate|algorithm|listing)\s*[\dIVXivx]+[a-z]?\s*[.:|—-]?/i;
const REFERENCES_HEADING_RE =
  /^(\d+\.?\s*)?(references?|bibliography|literature cited|works cited|reference list|references and notes)\s*[.:]?$/i;
const ABSTRACT_RE = /^abstract\b/i;
/**
 * A *candidate* numbered heading: "3.", "3.1", "IV.", "B." followed by a
 * capitalised, period-free line. The pattern alone decides nothing — every
 * wrapped body line that starts with a number and happens to carry no full
 * stop matches it too ("15 ExT sessions between groups, whereas power output,
 * HR, RPE, intensity ratings of"). isNumberedHeading() weighs the evidence.
 */
const NUMBERED_HEADING_RE = /^(\d+(\.\d+)*\.?|[IVXLC]+\.?|[A-Z]\.)\s+[A-Z][^.]{2,90}$/;
/** Numbering that is punctuated ("3." / "3.1" / "IV." / "B."), not a bare number that could simply open a sentence. */
const PUNCTUATED_NUMBERING_RE = /^(\d+\.(\d+\.?)*|[IVXLC]+\.|[A-Z]\.)\s/;
/** A line that stops in the middle of a clause is never a heading. */
const ENDS_MID_CLAUSE_RE = /[,;，、；]$/;
const PAGE_NUMBER_RE = /^(page\s+)?\d{1,4}(\s+(of|\/)\s+\d{1,4})?$/i;
const DOI_RE = /^(doi:?\s*)?(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i;
const URL_RE = /^(https?:\/\/\S+|www\.\S+)$/i;
const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const CITATION_MARKER_RE = /^[[(]?\s*\d+(\s*[,;–-]\s*\d+)*\s*[\])]?$/;
const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/i;
const ITALIC_RE = /italic|oblique/i;
const MATH_SYMBOLS_RE = /[=+−×÷±∑∏∫√∞≈≠≤≥∂∇αβγδεθλμπσφψωΔΣΩ∈∉⊂⊃∪∩]/g;
const AFFILIATION_RE =
  /\b(university|universit[aä]t|institute|department|dept\.?|school of|college|laboratory|hospital|center|centre|faculty|corresponding author|e-?mail)\b|@/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeForRepeat(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

function isBoldFont(block: TextBlock): boolean {
  return BOLD_RE.test(block.fontRealName ?? '') || BOLD_RE.test(block.fontName);
}

function isItalicFont(block: TextBlock): boolean {
  return ITALIC_RE.test(block.fontRealName ?? '') || ITALIC_RE.test(block.fontName);
}

function isAllCaps(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g) ?? [];
  return letters.length >= 3 && letters.every((c) => c === c.toUpperCase());
}

/** Share of the content words (4+ letters) that start with a capital: headings are title-cased, wrapped body lines are not. */
function isTitleCased(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]{4,}/.test(w));
  if (words.length === 0) return false;
  const capitalised = words.filter((w) => /^[^A-Za-z]*[A-Z]/.test(w)).length;
  return capitalised / words.length >= 0.7;
}

/** `b` continues the unfinished sentence of the paragraph right before it (same page, same column). */
function continuesPreviousParagraph(prev: TextBlock, b: TextBlock): boolean {
  if (prev.type !== 'BODY' || prev.page !== b.page || prev.column !== b.column) return false;
  const c = analyzeCompleteness(prev.text);
  return !c.complete && c.strong;
}

/**
 * Does a NUMBERED_HEADING_RE hit really read as a heading?
 *
 * Treating every hit as a HEADING mis-filed wrapped body lines that start
 * with a number, and one such line costs far more than a missed heading: the
 * paragraph is no longer merged (merge.ts only merges like with like), half a
 * sentence goes to the model as its own translation unit, typography draws the
 * line as a heading, and chapter detection ends the surrounding chapter there.
 *
 * A hit therefore needs
 *   - no sentence-fragment evidence: no trailing comma or semicolon, no
 *     dangling function word / dash / open bracket, and it must not continue
 *     the unfinished sentence of the BODY block right before it; and
 *   - at least one piece of heading evidence: a larger font, bold, italic, all
 *     caps, punctuated numbering, or a short title-cased line.
 *
 * Deliberately NOT required: a larger or bold font. Plenty of journals set
 * numbered headings in the body size and weight (italic, or carried by the
 * numbering alone), and demoting those would lose real chapters.
 */
function isNumberedHeading(b: TextBlock, rawText: string, fsRatio: number, words: number, prev: TextBlock | null): boolean {
  if (b.lineCount > 2) return false;
  const text = rawText.trim();
  if (!NUMBERED_HEADING_RE.test(text)) return false;

  if (ENDS_MID_CLAUSE_RE.test(text)) return false;
  const self = analyzeCompleteness(text);
  if (!self.complete && self.strong) return false; // "... ratings of", "... and", "... ("
  if (prev && continuesPreviousParagraph(prev, b)) return false;

  return (
    fsRatio >= 1.08 ||
    isBoldFont(b) ||
    isItalicFont(b) ||
    isAllCaps(text) ||
    PUNCTUATED_NUMBERING_RE.test(text) ||
    (words <= 8 && isTitleCased(text))
  );
}

function looksLikeEquation(block: TextBlock): boolean {
  const text = block.text;
  const letters = letterCount(text);
  const nonSpace = text.replace(/\s+/g, '').length;
  if (nonSpace === 0) return true;
  const letterRatio = letters / nonSpace;
  const mathSymbols = (text.match(MATH_SYMBOLS_RE) ?? []).length;
  if (letterRatio < 0.4) return true;
  if (mathSymbols >= 3 && wordCount(text) <= 12) return true;
  return false;
}

interface PageGeom {
  top: number;
  bottom: number;
  height: number;
  width: number;
}

function pageGeom(pages: PageDebugInfo[], pageNumber: number): PageGeom {
  const p = pages.find((pg) => pg.pageNumber === pageNumber);
  const view = p?.view ?? [0, 0, 612, 792];
  return { top: view[3], bottom: view[1], height: view[3] - view[1], width: view[2] - view[0] };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function classifyBlocks(blocks: TextBlock[], pages: PageDebugInfo[], bodyFontSize: number): void {
  const body = bodyFontSize;
  const pageCount = pages.length;

  // --- repeated header / footer text across pages -------------------------
  const repeats = new Map<string, Set<number>>();
  for (const b of blocks) {
    const g = pageGeom(pages, b.page);
    const inTop = b.y > g.top - 0.12 * g.height;
    const inBottom = b.top < g.bottom + 0.12 * g.height;
    if ((inTop || inBottom) && b.lineCount <= 2 && b.text.length <= 160) {
      const key = normalizeForRepeat(b.text);
      if (key.length < 2) continue;
      const set = repeats.get(key) ?? new Set<number>();
      set.add(b.page);
      repeats.set(key, set);
    }
  }
  const isRepeated = (b: TextBlock): boolean => {
    if (pageCount < 2) return false;
    const set = repeats.get(normalizeForRepeat(b.text));
    return !!set && set.size >= 2;
  };

  // --- page 1: title & authors -------------------------------------------
  const page1 = blocks.filter((b) => b.page === 1);
  let titleMaxFs = 0;
  for (const b of page1) {
    const g = pageGeom(pages, 1);
    const inHeaderZone = b.y > g.top - 0.08 * g.height;
    if (!inHeaderZone && wordCount(b.text) >= 2 && b.fontSize > titleMaxFs) titleMaxFs = b.fontSize;
  }
  const titleIds = new Set<string>();
  if (titleMaxFs >= 1.3 * body) {
    const g = pageGeom(pages, 1);
    for (const b of page1) {
      const upperHalf = b.y > g.bottom + 0.4 * g.height;
      if (upperHalf && b.fontSize >= 0.9 * titleMaxFs && wordCount(b.text) >= 2) titleIds.add(b.id);
    }
  }

  const abstractIndex = page1.findIndex((b) => ABSTRACT_RE.test(b.text));
  const lastTitleIndex = page1.reduce((acc, b, i) => (titleIds.has(b.id) ? i : acc), -1);
  const authorIds = new Set<string>();
  if (lastTitleIndex >= 0) {
    const end = abstractIndex > lastTitleIndex ? abstractIndex : Math.min(page1.length, lastTitleIndex + 4);
    for (let i = lastTitleIndex + 1; i < end; i++) {
      const b = page1[i];
      if (b.fontSize > 1.25 * body) continue;
      const shortish = b.lineCount <= 6 && b.text.length <= 600;
      const looksAffiliation = AFFILIATION_RE.test(b.text);
      const fewSentences = (b.text.match(/[.!?](\s|$)/g) ?? []).length <= 1;
      if (abstractIndex > lastTitleIndex ? shortish || looksAffiliation : looksAffiliation || (shortish && fewSentences)) {
        authorIds.add(b.id);
      }
    }
  }

  // --- pass over all blocks in reading order ------------------------------
  const state: SectionState = { section: 'MAIN', table: null, prev: null, tableCount: 0 };
  const tableMembers: TableMember[] = [];

  // Pages with questions ("...?") and pages with figure captions: short
  // answer options on a questionnaire page are translated, figure-internal
  // labels are not.
  const questionPages = new Set(blocks.filter((b) => /\?\s*$/.test(b.text)).map((b) => b.page));
  const figurePages = new Set(blocks.filter((b) => captionKind(b.text) === 'FIGURE').map((b) => b.page));

  let prevBlock: TextBlock | null = null;
  for (const b of blocks) {
    const g = pageGeom(pages, b.page);
    const text = b.text;
    const words = wordCount(text);
    const fsRatio = b.fontSize / body;
    const inTopZone = b.y > g.top - 0.08 * g.height;
    const inBottomZone = b.top < g.bottom + 0.07 * g.height;
    b.skipReason = null;

    let type: BlockType;

    if (isRepeated(b) && (inTopZone || b.y > g.top - 0.12 * g.height)) {
      type = 'HEADER';
    } else if (isRepeated(b)) {
      type = 'FOOTER';
    } else if (PAGE_NUMBER_RE.test(text) && (inTopZone || inBottomZone || b.top < g.bottom + 0.12 * g.height)) {
      type = b.y > g.bottom + g.height / 2 ? 'HEADER' : 'FOOTER';
    } else if (titleIds.has(b.id)) {
      type = 'TITLE';
    } else if (authorIds.has(b.id)) {
      type = 'AUTHOR';
    } else if (inTopZone && b.lineCount <= 2 && fsRatio <= 1.15) {
      type = 'HEADER';
    } else if (inBottomZone && b.lineCount <= 2 && fsRatio <= 1.0 && text.length < 200) {
      type = 'FOOTER';
    } else if (CAPTION_RE.test(text)) {
      type = 'CAPTION';
    } else if (
      fsRatio <= 0.88 &&
      (b.y < g.bottom + 0.35 * g.height || /^[\d*†‡§¶]{1,2}\s*[A-Z]/.test(text))
    ) {
      type = 'FOOTNOTE';
    } else if (
      (fsRatio >= 1.12 && b.lineCount <= 3 && text.length <= 200) ||
      (isBoldFont(b) && b.lineCount <= 2 && text.length <= 120 && !/[.;:]$/.test(text)) ||
      isNumberedHeading(b, text, fsRatio, words, prevBlock)
    ) {
      type = 'HEADING';
    } else if (looksLikeEquation(b)) {
      type = 'OTHER';
      b.skipReason = 'equation-or-symbols';
    } else if (b.lineCount === 1 && words <= 3 && fsRatio <= 1.1 && !/[.!?]$/.test(text)) {
      type = 'OTHER';
      b.skipReason = 'fragment';
    } else if (fsRatio >= 0.85 && fsRatio <= 1.25) {
      type = 'BODY';
    } else if (fsRatio > 1.25 && b.lineCount <= 3) {
      type = 'HEADING';
    } else {
      type = 'OTHER';
      b.skipReason = 'unusual-font-size';
    }

    b.type = type;
    b.blockType = type; // refined by classifySection()
    if (type !== 'HEADER' && type !== 'FOOTER' && type !== 'TITLE' && type !== 'AUTHOR') {
      classifySection(b, state, { fsRatio, words, pageWidth: g.width }, tableMembers);
      if (
        b.type === 'OTHER' &&
        b.skipReason === 'fragment' &&
        (state.section === 'SUPPLEMENTAL' || state.section === 'APPENDIX') &&
        questionPages.has(b.page) &&
        !figurePages.has(b.page)
      ) {
        // questionnaire answer option ("Uncertain about benefit")
        b.type = 'BODY';
        b.blockType = 'QUESTIONNAIRE';
        b.skipReason = null;
      }
    }
    b.sectionType = state.section;
    decideTranslate(b);
    prevBlock = b;
  }

  markTableHeaders(tableMembers);
}

// ---------------------------------------------------------------------------
// Sections: references boundary, back-matter figures / tables, supplemental
// ---------------------------------------------------------------------------

interface TableContext {
  id: number;
  lastPage: number;
}

interface PreviousCaption {
  block: TextBlock;
  kind: CaptionKind;
  role: 'caption' | 'note';
}

interface SectionState {
  section: SectionType;
  /** Active table: set by a table caption, cleared by a note, a paragraph, a heading or a gap. */
  table: TableContext | null;
  /**
   * The caption or note the current block may continue: set by captions and
   * notes, kept across figure-internal fragments (OTHER), cleared by any
   * other block.
   */
  prev: PreviousCaption | null;
  tableCount: number;
}

interface TableMember {
  block: TextBlock;
  tableId: number;
}

interface BlockMetrics {
  fsRatio: number;
  words: number;
  pageWidth: number;
}

type CaptionKind = 'FIGURE' | 'TABLE';

/** "Supplemental Material", "Online Supplement", "Extended Data", "Appendix B", ... */
const CAPTION_SOURCE_PREFIX =
  String.raw`^(?:(?:online\s+)?(?:supplement(?:al|ary)?(?:\s+(?:materials?|data|information|digital\s+content))?|extended\s+data|appendix(?:\s+[A-Z0-9]{1,3})?)[\s.:-]+)?`;
const CAPTION_NUMBER = String.raw`\s*(?:[A-Z]?S?\d{1,3}[a-z]?|[IVX]{1,5})`;
/** A real caption: the number is followed by punctuation, a pipe or the end ("Table 3." / "Figure 2:" / "Figure 1 |"). */
const CAPTION_END = String.raw`\s*(?:[.:|—–-]|$)`;
const FIGURE_CAPTION_STRICT_RE = new RegExp(`${CAPTION_SOURCE_PREFIX}e?(?:fig(?:ure)?s?\\.?|scheme|chart|plate)${CAPTION_NUMBER}${CAPTION_END}`, 'i');
const TABLE_CAPTION_STRICT_RE = new RegExp(`${CAPTION_SOURCE_PREFIX}e?table${CAPTION_NUMBER}${CAPTION_END}`, 'i');
const SUPPLEMENTAL_PREFIX_RE = /^(online\s+)?(supplement|extended\s+data|appendix)/i;

/** Headings that open supplementary / appendix material. No period after the keyword part: sentences do not match. */
const SUPPLEMENTAL_HEADING_RE =
  /^(\d+\.?\s*)?(online\s+)?(supplement(al|ary)?(\s+(materials?|methods|information|data|results|figures?|tables?|appendix))?|additional\s+(methods|results|information)|extended\s+(data|methods))\b[^.]{0,60}$/i;
const APPENDIX_SECTION_RE = /^(\d+\.?\s*)?(appendix|appendices)\b[^.]{0,60}$/i;
/** Back-matter headings that end the reference list without opening a supplement. */
const BACK_MATTER_HEADING_RE =
  /^(\d+\.?\s*)?(acknowledg(e)?ments?|funding|author contributions?|conflicts? of interest|competing interests?|disclosures?|data availability|figure legends?|figures|tables)\b[^.]{0,40}$/i;

const NOTE_RE =
  /^(data (are|is|were)|values (are|is|were)|results (are|were)|abbreviations?\b|definition of abbreviations|notes?\b|source[s]?:|error bars|[*∗†‡§¶#]|[a-e][\s)]\s*[A-Z])/i;

const REF_NUMBER_START_RE = /^(\[\d{1,3}\]|\d{1,3}\.)(\s|$)/;
const REF_AUTHOR_START_RE = /^[A-Z][A-Za-z'’-]+,\s+(?:[A-Z]\.\s?-?){1,3}(?:,|\s+and\b|\s*&)/;
const YEAR_RE = /\b(19|20)\d{2}[a-z]?\b/;
const ET_AL_RE = /\bet al\b/i;
const VOLUME_ISSUE_RE = /\b\d+\s*\(\s*\d+(?:[-–]\d+)?\s*\)\s*[:,]/;
const PAGE_RANGE_RE = /\bpp?\.\s*\d+/;
const DOI_ANY_RE = /\b10\.\d{4,9}\/\S+|\bdoi\s*:/i;

/** Bibliography entry features: number or "Surname, X.X." start, DOI, or a year plus journal-style details. */
export function looksLikeReferenceEntry(text: string): boolean {
  const t = text.trim();
  if (REF_NUMBER_START_RE.test(t)) return true;
  if (REF_AUTHOR_START_RE.test(t)) return true;
  if (DOI_ANY_RE.test(t)) return true;
  const year = YEAR_RE.test(t);
  return year && (ET_AL_RE.test(t) || VOLUME_ISSUE_RE.test(t) || PAGE_RANGE_RE.test(t));
}

export function captionKind(text: string): CaptionKind | null {
  const t = text.trim();
  if (TABLE_CAPTION_STRICT_RE.test(t)) return 'TABLE';
  if (FIGURE_CAPTION_STRICT_RE.test(t)) return 'FIGURE';
  return null;
}

/** Only numbers, ranges, ±, %, brackets, comparison signs, dashes and n / p / NS / NA tokens: "67.6 ± 5.2", "p<0.001", "n=12", "5 (41)", "–". */
export function isNumericOnly(text: string): boolean {
  const stripped = text
    .replace(/\b(n|N|p|P|r|R|NS|ns|NA|N\/A|vs)\b/g, '')
    .replace(/[\d\s.,;:±+\-−–—%‰()[\]{}<>=≤≥*∗†‡§¶#/×x^~≈]/g, '');
  return stripped.length === 0 && (/\d/.test(text) || /^[-−–—\s]+$/.test(text.trim()));
}

/** A row whose tokens are values to this share is data, not prose. */
const NUMERIC_ROW_SHARE = 0.6;
/** ...and it must carry at least this many of them. */
const NUMERIC_ROW_MIN_VALUES = 3;

/**
 * A table row that the layout could not cut into cells and that therefore
 * arrives as one long text: "72.69 ± 3.7 95.54 ± 4.1 ... Post Apnea 137.03 ±
 * 4.5 ...". It is wide and has many "words", so it looks like a paragraph to
 * isParagraphLike() and like a note to NOTE_RE, and used to end the table and
 * be translated as prose. Counted over the tokens that carry a letter or a
 * digit, so the separators (±, <, %) of a value do not dilute the share.
 */
export function isNumericRow(text: string): boolean {
  const tokens = text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t));
  if (tokens.length === 0) return false;
  const values = tokens.filter((t) => isNumericOnly(t)).length;
  return values >= NUMERIC_ROW_MIN_VALUES && values / tokens.length >= NUMERIC_ROW_SHARE;
}

/** Upper-case abbreviations only ("COPD", "LABA + ICS", "FEV1/FVC"): the translation would return them unchanged. */
export function isAbbreviationOnly(text: string): boolean {
  const t = text.trim();
  return t.length <= 24 && /^[A-Z][A-Z0-9₀-₉²³.\s+/&-]*$/.test(t) && /[A-Z]{2}/.test(t);
}

function isParagraphLike(b: TextBlock, m: BlockMetrics): boolean {
  return (m.words >= 12 && b.width >= 0.5 * m.pageWidth) || (b.lineCount >= 3 && m.words >= 25);
}

function isShortHeadingCandidate(b: TextBlock, m: BlockMetrics): boolean {
  return b.lineCount <= 2 && m.words <= 12 && !looksLikeReferenceEntry(b.text);
}

function continuesText(prev: TextBlock, next: TextBlock): boolean {
  if (prev.page !== next.page) return false;
  const c = analyzeCompleteness(prev.text);
  return !c.complete && (c.strong || /^[a-z(]/.test(next.text.trim()));
}

function setCaption(b: TextBlock, kind: CaptionKind, blockType: DetailedBlockType, state: SectionState): void {
  b.type = 'CAPTION';
  b.blockType = blockType;
  state.prev = { block: b, kind, role: 'caption' };
}

function setNote(b: TextBlock, kind: CaptionKind, state: SectionState): void {
  b.type = 'CAPTION';
  b.blockType = kind === 'FIGURE' ? 'FIGURE_NOTE' : 'TABLE_NOTE';
  state.prev = { block: b, kind, role: 'note' };
}

/**
 * Decide the section of `b` and refine its type. Mutates `state`.
 *
 * REFERENCES is entered at a "References" / "Bibliography" heading and left
 * again at the next figure or table caption, supplemental / appendix /
 * back-matter heading, generic heading or long prose paragraph. Inside it,
 * only blocks that are neither is REFERENCE (entries and their wrapped
 * lines), so the bibliography stays untranslated while material after it is
 * classified normally.
 */
function classifySection(b: TextBlock, state: SectionState, m: BlockMetrics, tableMembers: TableMember[]): void {
  const text = b.text.trim();

  // 1. references heading
  if (REFERENCES_HEADING_RE.test(text) && b.lineCount <= 2) {
    state.section = 'REFERENCES';
    state.table = null;
    state.prev = null;
    b.type = 'HEADING';
    b.blockType = 'HEADING';
    return;
  }

  // 2. strict figure / table caption (also ends the reference list)
  const kind = captionKind(text);
  if (kind) {
    const supplemental = SUPPLEMENTAL_PREFIX_RE.test(text);
    if (supplemental) state.section = /^(online\s+)?appendix/i.test(text) ? 'APPENDIX' : 'SUPPLEMENTAL';
    else if (state.section === 'REFERENCES' || state.section === 'FIGURES' || state.section === 'TABLES') {
      state.section = kind === 'FIGURE' ? 'FIGURES' : 'TABLES';
    }
    setCaption(b, kind, kind === 'FIGURE' ? 'FIGURE_CAPTION' : 'TABLE_CAPTION', state);
    state.table = kind === 'TABLE' ? { id: ++state.tableCount, lastPage: b.page } : null;
    return;
  }

  // 3. continuation of the caption / note right before ("... people with" / "only in the ...")
  const prev = state.prev;
  if (prev && m.words >= 3 && continuesText(prev.block, b) && (prev.role === 'note' || !isParagraphLike(b, m))) {
    if (prev.role === 'caption') setCaption(b, prev.kind, prev.block.blockType, state);
    else setNote(b, prev.kind, state);
    return;
  }

  // 4a. further notes under a caption or note ("Note: ...", then "Abbreviations: ...", also on the next page)
  if (prev && NOTE_RE.test(text) && b.page <= prev.block.page + 1 && (prev.role === 'note' || prev.kind === 'FIGURE')) {
    setNote(b, prev.kind, state);
    if (prev.kind === 'TABLE') state.table = null;
    return;
  }

  // 4. section headings
  if (isShortHeadingCandidate(b, m) && (b.type === 'HEADING' || (b.lineCount === 1 && m.words <= 6 && !/[,;]$/.test(text)))) {
    let next: SectionType | null = null;
    if (SUPPLEMENTAL_HEADING_RE.test(text)) next = 'SUPPLEMENTAL';
    else if (APPENDIX_SECTION_RE.test(text)) next = 'APPENDIX';
    else if (BACK_MATTER_HEADING_RE.test(text) && state.section === 'REFERENCES') next = 'MAIN';
    if (next) {
      state.section = next;
      state.table = null;
      state.prev = null;
      b.type = 'HEADING';
      b.blockType = next === 'SUPPLEMENTAL' ? 'SUPPLEMENTAL_HEADING' : next === 'APPENDIX' ? 'APPENDIX_HEADING' : 'HEADING';
      return;
    }
  }

  // 5. inside the reference list
  if (state.section === 'REFERENCES') {
    const genericHeading = b.type === 'HEADING' && isShortHeadingCandidate(b, m) && !YEAR_RE.test(text);
    const prose =
      m.words >= 40 && !YEAR_RE.test(text) && !ET_AL_RE.test(text) && !DOI_ANY_RE.test(text) && !VOLUME_ISSUE_RE.test(text);
    if (genericHeading || prose) {
      state.section = 'MAIN';
    } else {
      b.type = 'REFERENCE';
      b.blockType = 'REFERENCE';
      b.skipReason = looksLikeReferenceEntry(text) ? 'REFERENCE_ENTRY' : 'REFERENCE_CONTINUATION';
      return;
    }
  }

  // 6. table body
  const table = state.table;
  if (table) {
    const largeHeading = b.type === 'HEADING' && m.fsRatio >= 1.12;
    // A row of values is never a note and never a paragraph, however wide it
    // is and however many "words" it has: it stays inside the table.
    const values = isNumericRow(text);
    if (b.page > table.lastPage + 1 || largeHeading) {
      state.table = null;
    } else if (!values && (NOTE_RE.test(text) || (isParagraphLike(b, m) && m.fsRatio <= 0.92))) {
      setNote(b, 'TABLE', state);
      state.table = null;
      return;
    } else if (!values && isParagraphLike(b, m)) {
      state.table = null;
    } else {
      table.lastPage = b.page;
      b.type = 'TABLE';
      b.tableId = table.id;
      if (isNumericOnly(text)) {
        b.blockType = 'TABLE_CELL';
        b.skipReason = 'NUMERIC_ONLY';
      } else {
        b.blockType = 'TABLE_TEXT_LABEL';
        if (isAbbreviationOnly(text)) b.skipReason = 'ABBREVIATION_ONLY';
      }
      tableMembers.push({ block: b, tableId: table.id });
      return;
    }
  }

  // 7. an ordinary block ends any caption / note continuation (figure-internal fragments do not)
  if (b.type !== 'OTHER') state.prev = null;

  // 8. prose after back-matter figures / tables is supplementary material
  if (
    (state.section === 'FIGURES' || state.section === 'TABLES') &&
    (b.type === 'HEADING' || ((b.type === 'BODY' || b.type === 'FOOTNOTE') && (b.lineCount >= 2 || m.words >= 12)))
  ) {
    state.section = 'SUPPLEMENTAL';
  }

  // 9. section-specific fine types
  if (state.section === 'SUPPLEMENTAL' || state.section === 'APPENDIX') {
    const supplemental = state.section === 'SUPPLEMENTAL';
    if ((b.type === 'BODY' || b.type === 'HEADING') && /\?\s*$/.test(text)) b.blockType = 'QUESTIONNAIRE';
    else if (b.type === 'BODY') b.blockType = supplemental ? 'SUPPLEMENTAL_BODY' : 'APPENDIX_BODY';
    else if (b.type === 'HEADING') b.blockType = supplemental ? 'SUPPLEMENTAL_HEADING' : 'APPENDIX_HEADING';
    else if (b.type === 'FOOTNOTE') b.blockType = supplemental ? 'SUPPLEMENTAL_FOOTNOTE' : 'FOOTNOTE';
  }
}

/** Text labels that sit entirely above the first numeric row of their table (on that page) are column headers. */
function markTableHeaders(members: TableMember[]): void {
  const firstRowTop = new Map<string, number>();
  for (const { block, tableId } of members) {
    if (block.blockType !== 'TABLE_CELL') continue;
    const key = `${tableId}:${block.page}`;
    firstRowTop.set(key, Math.max(firstRowTop.get(key) ?? -Infinity, block.top));
  }
  for (const { block, tableId } of members) {
    if (block.blockType !== 'TABLE_TEXT_LABEL') continue;
    const top = firstRowTop.get(`${tableId}:${block.page}`);
    if (top !== undefined && block.y >= top - 0.5) block.blockType = 'TABLE_HEADER';
  }
}

// ---------------------------------------------------------------------------
// Do-not-translate rules
// ---------------------------------------------------------------------------

const NON_TRANSLATED_TYPES: ReadonlySet<BlockType> = new Set(['HEADER', 'FOOTER', 'AUTHOR', 'REFERENCE', 'OTHER']);

/**
 * Text that never needs an API call: a number / statistic, DOI, URL, e-mail,
 * citation marker or page number on its own. Used by the classifier and as a
 * last check before a block is sent.
 */
export function isUntranslatableText(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  return DOI_RE.test(t) || URL_RE.test(t) || EMAIL_RE.test(t) || CITATION_MARKER_RE.test(t) || PAGE_NUMBER_RE.test(t) || letterCount(t) < 3 || isNumericOnly(t);
}

function decideTranslate(b: TextBlock): void {
  const text = b.text.trim();

  if (NON_TRANSLATED_TYPES.has(b.type)) {
    b.translate = false;
    b.skipReason = b.skipReason ?? `type:${b.type}`;
    return;
  }
  // Numeric table cells and abbreviation-only labels are kept as they are.
  if (b.skipReason === 'NUMERIC_ONLY' || b.skipReason === 'ABBREVIATION_ONLY') {
    b.translate = false;
    return;
  }

  let reason: string | null = null;
  if (text.length < 2) reason = 'empty';
  else if (DOI_RE.test(text)) reason = 'doi';
  else if (URL_RE.test(text)) reason = 'url';
  else if (EMAIL_RE.test(text)) reason = 'email';
  else if (CITATION_MARKER_RE.test(text)) reason = 'citation-marker';
  else if (PAGE_NUMBER_RE.test(text)) reason = 'page-number';
  else if (letterCount(text) < 3) reason = isNumericOnly(text) ? 'NUMERIC_ONLY' : 'no-letters';
  else if (b.type === 'CAPTION' && wordCount(text) <= 2) reason = 'caption-label-only';

  b.translate = reason === null;
  b.skipReason = reason;
}
