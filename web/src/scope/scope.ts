/**
 * Translation scope: which final logical units go to the provider pipeline.
 *
 * Position in the pipeline (main.ts):
 *
 *   PDF.js extraction → layout → TABLE resolution → FIGURE resolution →
 *   source-item ownership → final logical units (BODY / HEADING / CAPTION /
 *   FOOTNOTE / TABLE_CELL / FIGURE_BOX / FIGURE_LABEL ...)
 *   → resolveTranslationScope()  ← here
 *   → terminology → translation → QA → PDF overlay (selected units only)
 *
 * It works on `LayoutResult.translationBlocks` (the final units) and never on
 * raw text items or pre-table / pre-figure blocks, so cell and figure
 * grouping and source-item ownership are exactly what the whole-document
 * pipeline uses. One implementation serves all three modes; the modes only
 * differ in the interval test.
 *
 * Cross-boundary units (a merged paragraph that starts on page 9 and ends on
 * page 10, or that straddles a chapter anchor) are never cut: a unit that
 * overlaps the selected range is taken whole and counted as boundary-expanded.
 */

import { isUntranslatableText } from '../pdf/classify';
import type { PageDebugInfo, TextBlock, TranslationBlock, UnitSpan } from '../pdf/types';
import { fnv1a } from '../translate/terminology';
import type { ChapterInfo } from './chapters';

export type TranslationScope =
  | { mode: 'all' }
  | { mode: 'chapters'; chapterIds: string[] }
  | { mode: 'pages'; startPage: number; endPage: number };

export const MSG_INVALID_PAGE_RANGE = '請輸入有效頁數範圍。';
export const MSG_NO_CHAPTER_SELECTED = '請至少勾選一個章節。';

/**
 * Chapter membership is decided by how much of a unit's vertical extent lies
 * inside the chapter (pages stacked on top of each other): at least half of
 * the unit, or at least MIN_OVERLAP points (about two lines) of a long merged
 * unit. A heading whose box starts a few points above its outline anchor is
 * therefore still the first unit of its chapter, and the last line of the
 * previous chapter never comes along.
 */
export const MIN_OVERLAP = 24;
export const OVERLAP_SHARE = 0.5;
/** Stacked-page coordinate of an unknown page size. */
const DEFAULT_PAGE_HEIGHT = 792;

/** Deterministic, short, readable; never contains PDF bytes. */
export function scopeFingerprint(scope: TranslationScope): string {
  switch (scope.mode) {
    case 'all':
      return 'all';
    case 'pages':
      return `pages:${scope.startPage}-${scope.endPage}`;
    case 'chapters': {
      const ids = [...new Set(scope.chapterIds)].sort();
      const joined = ids.join(',');
      return `chapters:${ids.length}:${joined.length <= 60 ? joined : fnv1a(joined)}`;
    }
  }
}

export function validatePageRange(
  start: unknown,
  end: unknown,
  pageCount: number,
): { ok: true; startPage: number; endPage: number } | { ok: false; error: string } {
  const s = typeof start === 'string' ? Number(start.trim()) : start;
  const e = typeof end === 'string' ? Number(end.trim()) : end;
  if (typeof s !== 'number' || typeof e !== 'number' || !Number.isInteger(s) || !Number.isInteger(e)) {
    return { ok: false, error: MSG_INVALID_PAGE_RANGE };
  }
  if (s < 1 || e < 1 || s > e || e > pageCount) return { ok: false, error: MSG_INVALID_PAGE_RANGE };
  return { ok: true, startPage: s, endPage: e };
}

export interface ScopeStats {
  totalUnits: number;
  selectedUnits: number;
  /** Characters of `text` over the selected units. */
  selectedChars: number;
  /** Selected units that need a provider call (not skipped as untranslatable). */
  providerBound: number;
  boundaryExpanded: number;
  /** Source text items owned by more than one selected provider-bound unit. Must be 0. */
  duplicateSourceItems: number;
  body: number;
  heading: number;
  caption: number;
  footnote: number;
  tableCells: number;
  figureUnits: number;
  other: number;
  /** Numeric-only table / figure cells inside the scope: kept as they are, never sent. */
  numericSkipped: number;
  /** Pages the selected units touch. */
  selectedPages: number[];
}

export type ScopeResolution =
  | {
      ok: true;
      scope: TranslationScope;
      fingerprint: string;
      /** Selected final logical units, in document order (the original objects). */
      units: TranslationBlock[];
      boundaryExpandedIds: Set<string>;
      stats: ScopeStats;
    }
  | { ok: false; scope: TranslationScope; fingerprint: string; error: string };

export interface ScopeResolveOptions {
  pageCount: number;
  /** Final layout blocks, for the duplicate source-item assertion and numeric-cell stats. */
  blocks?: readonly TextBlock[];
  /** Page geometry for the chapter intervals; letter-size pages are assumed when absent. */
  pages?: readonly PageDebugInfo[];
}

/**
 * Reading-order coordinate: pages stacked top to bottom, so `page 2, y = 700`
 * lies below every position of page 1. Larger = later in the document.
 */
class Ruler {
  private readonly tops: number[] = [];
  private readonly offsets: number[] = [];

  constructor(pages: readonly PageDebugInfo[] | undefined, pageCount: number) {
    let offset = 0;
    for (let p = 1; p <= Math.max(pageCount, 1); p++) {
      const info = pages?.find((x) => x.pageNumber === p);
      const top = info ? info.view[3] : DEFAULT_PAGE_HEIGHT;
      const bottom = info ? info.view[1] : 0;
      this.tops[p] = top;
      this.offsets[p] = offset;
      offset += Math.max(1, top - bottom);
    }
    this.offsets[Math.max(pageCount, 1) + 1] = offset; // "after the last page"
  }

  pos(page: number, y: number): number {
    const p = Math.min(Math.max(1, page), this.offsets.length - 1);
    if (p >= this.offsets.length - 1) return this.offsets[this.offsets.length - 1];
    const top = this.tops[p] ?? DEFAULT_PAGE_HEIGHT;
    const dy = y === Number.POSITIVE_INFINITY ? 0 : y === Number.NEGATIVE_INFINITY ? top : top - y;
    return this.offsets[p] + Math.max(0, dy);
  }
}

/** [start, end) in ruler coordinates. */
interface Interval {
  start: number;
  end: number;
}

function chapterInterval(c: ChapterInfo, ruler: Ruler): Interval {
  const endPage = c.endPage ?? c.startPage;
  const start = ruler.pos(c.startPage, c.startY ?? Number.POSITIVE_INFINITY);
  const end = c.endY !== undefined ? ruler.pos(endPage, c.endY) : ruler.pos(endPage + 1, Number.POSITIVE_INFINITY);
  return { start, end: Math.max(start, end) };
}

function spanOf(unit: { span?: UnitSpan; pages: number[]; page: number }): UnitSpan {
  if (unit.span) return unit.span;
  const pages = unit.pages.length ? unit.pages : [unit.page];
  return { startPage: Math.min(...pages), startY: Number.POSITIVE_INFINITY, endPage: Math.max(...pages), endY: Number.NEGATIVE_INFINITY };
}

function blockSpan(b: TextBlock): UnitSpan {
  return { startPage: b.page, startY: b.top, endPage: b.page, endY: b.y };
}

interface Membership {
  /** Overlaps the selection. */
  selected: boolean;
  /** Lies entirely inside the selection. */
  inside: boolean;
}

function membership(span: UnitSpan, scope: TranslationScope, intervals: Interval[], ruler: Ruler): Membership {
  switch (scope.mode) {
    case 'all':
      return { selected: true, inside: true };
    case 'pages': {
      const selected = span.endPage >= scope.startPage && span.startPage <= scope.endPage;
      return { selected, inside: selected && span.startPage >= scope.startPage && span.endPage <= scope.endPage };
    }
    case 'chapters': {
      const s = ruler.pos(span.startPage, span.startY);
      const e = Math.max(s + 1, ruler.pos(span.endPage, span.endY));
      const length = e - s;
      let selected = false;
      let inside = false;
      for (const iv of intervals) {
        const overlap = Math.min(e, iv.end) - Math.max(s, iv.start);
        if (overlap <= 0) continue;
        if (overlap >= OVERLAP_SHARE * length || overlap >= MIN_OVERLAP) selected = true;
        if (overlap >= length - 1) inside = true;
      }
      return { selected, inside: selected && inside };
    }
  }
}

/**
 * Select the final logical units covered by `scope`. Pure and synchronous;
 * an invalid scope (bad page range, unknown or no chapter ids) yields
 * `ok: false` and the caller must not start any API call.
 */
export function resolveTranslationScope(
  units: readonly TranslationBlock[],
  chapters: readonly ChapterInfo[],
  scope: TranslationScope,
  options: ScopeResolveOptions,
): ScopeResolution {
  const fingerprint = scopeFingerprint(scope);
  const fail = (error: string): ScopeResolution => ({ ok: false, scope, fingerprint, error });
  const ruler = new Ruler(options.pages, options.pageCount);

  let intervals: Interval[] = [];
  if (scope.mode === 'pages') {
    const v = validatePageRange(scope.startPage, scope.endPage, options.pageCount);
    if (!v.ok) return fail(v.error);
  } else if (scope.mode === 'chapters') {
    if (chapters.length === 0) return fail('此 PDF 無法可靠偵測章節，請改用整份論文或自訂頁數。');
    const wanted = new Set(scope.chapterIds);
    if (wanted.size === 0) return fail(MSG_NO_CHAPTER_SELECTED);
    const picked = chapters.filter((c) => wanted.has(c.id));
    if (picked.length !== wanted.size) return fail('選取的章節不存在，請重新選擇。');
    intervals = picked.map((c) => chapterInterval(c, ruler));
  }

  const selected: TranslationBlock[] = [];
  const boundaryExpandedIds = new Set<string>();
  const stats: ScopeStats = {
    totalUnits: units.length,
    selectedUnits: 0,
    selectedChars: 0,
    providerBound: 0,
    boundaryExpanded: 0,
    duplicateSourceItems: 0,
    body: 0,
    heading: 0,
    caption: 0,
    footnote: 0,
    tableCells: 0,
    figureUnits: 0,
    other: 0,
    numericSkipped: 0,
    selectedPages: [],
  };
  const pages = new Set<number>();

  for (const unit of units) {
    const m = membership(spanOf(unit), scope, intervals, ruler);
    if (!m.selected) continue;
    selected.push(unit);
    stats.selectedUnits++;
    stats.selectedChars += unit.text.length;
    if (!isUntranslatableText(unit.text)) stats.providerBound++;
    if (!m.inside) {
      boundaryExpandedIds.add(unit.id);
      stats.boundaryExpanded++;
    }
    for (const p of unit.pages) pages.add(p);
    switch (unit.type) {
      case 'BODY':
        stats.body++;
        break;
      case 'HEADING':
      case 'TITLE':
        stats.heading++;
        break;
      case 'CAPTION':
        stats.caption++;
        break;
      case 'FOOTNOTE':
        stats.footnote++;
        break;
      case 'TABLE':
        stats.tableCells++;
        break;
      case 'FIGURE':
        stats.figureUnits++;
        break;
      default:
        stats.other++;
    }
  }
  stats.selectedPages = [...pages].sort((a, b) => a - b);

  if (options.blocks) {
    const blockById = new Map(options.blocks.map((b) => [b.id, b]));
    // Ownership: every source text item of the provider-bound selected units at most once.
    const seen = new Set<object>();
    for (const unit of selected) {
      if (isUntranslatableText(unit.text)) continue;
      for (const id of unit.sourceBlockIds) {
        const block = blockById.get(id);
        if (!block) continue;
        for (const line of block.lines) {
          for (const item of line.items) {
            if (seen.has(item)) stats.duplicateSourceItems++;
            else seen.add(item);
          }
        }
      }
    }
    for (const b of options.blocks) {
      if (!b.cell?.numeric) continue;
      if (membership(blockSpan(b), scope, intervals, ruler).selected) stats.numericSkipped++;
    }
  }

  return { ok: true, scope, fingerprint, units: selected, boundaryExpandedIds, stats };
}

/**
 * Units that always accompany the selected ones into terminology sampling:
 * the title and the abstract (they define the paper's vocabulary). Same
 * sample budget as before; still one extraction request.
 */
export function terminologyContextUnits(units: readonly TranslationBlock[]): TranslationBlock[] {
  const out: TranslationBlock[] = [];
  for (const u of units) if (u.type === 'TITLE') out.push(u);
  const i = units.findIndex((u) => u.page <= 2 && /^abstract\b/i.test(u.text.trim()));
  if (i >= 0) {
    out.push(units[i]);
    const next = units[i + 1];
    if (units[i].type === 'HEADING' && next && next.type === 'BODY' && next.page <= 2) out.push(next);
  }
  return out;
}

/** `selected` plus `extra`, deduplicated, in document order. */
export function unitsInDocumentOrder(
  all: readonly TranslationBlock[],
  selected: readonly TranslationBlock[],
  extra: readonly TranslationBlock[] = [],
): TranslationBlock[] {
  const ids = new Set<string>();
  for (const u of selected) ids.add(u.id);
  for (const u of extra) ids.add(u.id);
  return all.filter((u) => ids.has(u.id));
}
