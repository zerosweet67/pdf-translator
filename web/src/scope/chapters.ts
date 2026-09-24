/**
 * Chapter detection for the translation scope. Browser-side, deterministic,
 * no AI and no network: it costs no tokens.
 *
 *   1. the PDF's native outline (bookmarks), destinations resolved to
 *      page + Y anchor by pdf/outline.ts; nested items keep their hierarchy
 *   2. fallback: the HEADING units of the final layout (after table and
 *      figure resolution), level from the numbering ("3.1" → 2), else a
 *      conservative font-size guess, else level 1
 *
 * A chapter runs from its anchor (page + Y, y grows upward) to the anchor of
 * the next chapter of the same or a higher level, or to the end of the
 * document. Selecting "3. Results" therefore covers 3.1 and 3.2; selecting
 * "3.1" stops at "3.2".
 */

import { roleOf } from '../pdf/roles';
import type { LayoutResult, OutlineNode, PageDebugInfo, PdfAnalysis, TextBlock } from '../pdf/types';

export interface ChapterInfo {
  id: string;
  title: string;
  /** 1 = top level. */
  level: number;
  /** 1-based PDF page index of the anchor. */
  startPage: number;
  /** Last page the chapter touches (for display and range checks). */
  endPage?: number;
  /** Anchor Y (PDF user space, top edge). Undefined = top of startPage. */
  startY?: number;
  /**
   * Y of the next chapter's anchor on `endPage`. Undefined = the chapter
   * runs to the bottom of `endPage`.
   */
  endY?: number;
  source: 'outline' | 'heading';
  parentId?: string;
  /** True for the "References" chapter: shown, unchecked by default, never translated anyway. */
  references?: boolean;
}

export type ChapterSource = 'outline' | 'heading' | 'none';

export interface ChapterDetection {
  chapters: ChapterInfo[];
  source: ChapterSource;
  /** Developer Mode notes: skipped outline items, why the fallback was used, ... */
  warnings: string[];
}

/** Common academic section titles: always accepted as top-level chapters. */
const KNOWN_HEADING_RE =
  /^(abstract|summary|introduction|background|methods?|methodology|materials and methods|results|findings|discussion|limitations|conclusions?|acknowledg(e)?ments?|appendix|appendices|supplement(al|ary)?( materials?)?|references|bibliography)\b/i;
const REFERENCES_RE = /^(references?|bibliography|literature cited|works cited|reference list|references and notes)\s*[.:]?$/i;
/** "3.", "3.1", "3.1.2 " → level = number of components. */
const NUMBERED_RE = /^(\d+(?:\.\d+)*)\.?\s+\S/;
const ROMAN_RE = /^[IVXLC]+\.\s+\S/;
/** A next-chapter anchor within this share of the page height from the top ends the previous chapter on the page before. */
const PAGE_TOP_SHARE = 0.06;

function stripNumbering(title: string): string {
  return title.replace(/^(\d+(?:\.\d+)*\.?|[IVXLC]+\.|[A-Z]\.)\s+/, '').trim();
}

export function isReferencesTitle(title: string): boolean {
  return REFERENCES_RE.test(stripNumbering(title));
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
}

/** True when a block's text is the chapter title (or starts with it / is its start). */
function titleMatches(blockText: string, title: string): boolean {
  const a = normalizeTitle(blockText);
  const b = normalizeTitle(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length >= 6 && a.startsWith(b)) return true;
  return a.length >= 6 && b.startsWith(a);
}

function pageInfo(pages: readonly PageDebugInfo[], page: number): PageDebugInfo | undefined {
  return pages.find((p) => p.pageNumber === page);
}

function pageTop(pages: readonly PageDebugInfo[], page: number): number {
  const p = pageInfo(pages, page);
  return p ? p.view[3] : 792;
}

function pageHeight(pages: readonly PageDebugInfo[], page: number): number {
  const p = pageInfo(pages, page);
  return p ? p.view[3] - p.view[1] : 792;
}

/**
 * Snap an outline anchor to the heading block that carries the same title:
 * outline destinations often point a few points above the heading (or, for
 * /Fit destinations, nowhere on the page), and some producers give several
 * bookmarks one destination. The block is looked for on the destination page
 * first, then on the following pages.
 */
function snapToHeading(blocks: readonly TextBlock[], title: string, page: number): TextBlock | null {
  const candidates = blocks.filter((b) => (b.type === 'HEADING' || b.type === 'TITLE') && b.page >= page && titleMatches(b.text, title));
  if (candidates.length) {
    candidates.sort((a, b) => a.page - b.page || b.top - a.top);
    return candidates[0];
  }
  // A heading the classifier did not recognise: a short block on the destination page.
  const loose = blocks.filter(
    (b) => b.page === page && b.lineCount <= 2 && b.type !== 'HEADER' && b.type !== 'FOOTER' && b.cell === undefined && titleMatches(b.text, title),
  );
  loose.sort((a, b) => b.top - a.top);
  return loose[0] ?? null;
}

interface Anchor {
  page: number;
  /** Undefined = top of the page. */
  y: number | undefined;
}

interface Draft {
  id: string;
  title: string;
  level: number;
  anchor: Anchor;
  source: 'outline' | 'heading';
  parentId?: string;
}

function draftsFromOutline(outline: readonly OutlineNode[], blocks: readonly TextBlock[], pages: readonly PageDebugInfo[], warnings: string[]): Draft[] {
  const out: Draft[] = [];
  let n = 0;
  const walk = (nodes: readonly OutlineNode[], parent: Draft | null) => {
    for (const node of nodes) {
      n++;
      let self: Draft | null = null;
      if (node.page !== null && node.title) {
        const heading = snapToHeading(blocks, node.title, node.page);
        let anchor: Anchor;
        if (heading) anchor = { page: heading.page, y: heading.top };
        else if (node.y !== null) anchor = { page: node.page, y: Math.min(node.y, pageTop(pages, node.page)) };
        else anchor = { page: node.page, y: undefined };
        self = {
          id: `ol-${n}`,
          title: node.title,
          level: parent ? parent.level + 1 : 1,
          anchor,
          source: 'outline',
          parentId: parent?.id,
        };
        out.push(self);
      } else if (node.title) {
        warnings.push(`outline item "${node.title}" has no resolvable destination; its children are kept`);
      }
      if (node.children.length) walk(node.children, self ?? parent);
    }
  };
  walk(outline, null);
  return out;
}

/** Level of a heading from its numbering, else from the known list, else null (decided by font size). */
function numberedLevel(text: string): number | null {
  const m = NUMBERED_RE.exec(text);
  if (m) return m[1].split('.').length;
  if (ROMAN_RE.test(text)) return 1;
  return null;
}

function draftsFromHeadings(blocks: readonly TextBlock[]): Draft[] {
  // Structured-abstract labels and sidebar headings / labels are HEADING
  // blocks for the pipeline but never chapters (pdf/roles.ts).
  const headings = blocks.filter((b) => b.type === 'HEADING' && b.text.trim().length >= 2 && !b.labelFor && !b.containerId && roleOf(b) === 'HEADING');
  if (headings.length === 0) return [];

  // Conservative font-size hierarchy: only when two clearly different sizes exist.
  const sizes = [...new Set(headings.map((h) => Math.round(h.fontSize * 2) / 2))].sort((a, b) => b - a);
  const twoTiers = sizes.length >= 2 && sizes[0] >= 1.1 * sizes[sizes.length - 1];
  const largest = sizes[0];

  const drafts: Draft[] = headings.map((h, i) => {
    const text = h.text.trim();
    let level = numberedLevel(text);
    if (level === null) {
      if (KNOWN_HEADING_RE.test(stripNumbering(text))) level = 1;
      else if (twoTiers) level = Math.round(h.fontSize * 2) / 2 >= largest ? 1 : 2;
      else level = 1;
    }
    return { id: `hd-${h.id}-${i}`, title: text, level, anchor: { page: h.page, y: h.top }, source: 'heading' };
  });

  // Normalise: the shallowest level becomes 1, and a level never jumps by more than one.
  const min = Math.min(...drafts.map((d) => d.level));
  let prev = 0;
  for (const d of drafts) {
    d.level = Math.max(1, d.level - min + 1);
    if (d.level > prev + 1) d.level = prev + 1;
    prev = d.level;
  }
  // Parent = nearest previous chapter with a smaller level.
  const stack: Draft[] = [];
  for (const d of drafts) {
    while (stack.length && stack[stack.length - 1].level >= d.level) stack.pop();
    d.parentId = stack[stack.length - 1]?.id;
    stack.push(d);
  }
  return drafts;
}

function compareAnchors(a: Anchor, b: Anchor): number {
  if (a.page !== b.page) return a.page - b.page;
  const ay = a.y ?? Number.POSITIVE_INFINITY;
  const by = b.y ?? Number.POSITIVE_INFINITY;
  return by - ay; // larger y = earlier on the page
}

/**
 * A "front matter" chapter for the title / abstract that precede the first
 * anchor (common with heading fallback: the abstract has no heading).
 */
function frontMatter(drafts: Draft[], blocks: readonly TextBlock[], source: 'outline' | 'heading'): Draft | null {
  if (drafts.length === 0) return null;
  const first = drafts.reduce((a, b) => (compareAnchors(a.anchor, b.anchor) <= 0 ? a : b));
  const before = blocks.some((b) => {
    if (!b.translate || (b.type !== 'TITLE' && b.type !== 'BODY' && b.type !== 'HEADING')) return false;
    return compareAnchors({ page: b.page, y: b.top }, first.anchor) < 0 && !(b.page === first.anchor.page && first.anchor.y !== undefined && b.top <= first.anchor.y + 2);
  });
  if (!before) return null;
  return { id: 'front', title: '標題與摘要', level: 1, anchor: { page: 1, y: undefined }, source };
}

/** Turn anchored drafts into chapters with end positions (see the module comment). */
export function finishChapters(drafts: Draft[], pages: readonly PageDebugInfo[], pageCount: number): ChapterInfo[] {
  const out: ChapterInfo[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    let next: Draft | null = null;
    for (let j = i + 1; j < drafts.length; j++) {
      if (drafts[j].level <= d.level) {
        next = drafts[j];
        break;
      }
    }
    const chapter: ChapterInfo = {
      id: d.id,
      title: d.title,
      level: d.level,
      startPage: d.anchor.page,
      startY: d.anchor.y,
      source: d.source,
      parentId: d.parentId,
      references: isReferencesTitle(d.title),
    };
    if (!next) {
      chapter.endPage = Math.max(d.anchor.page, pageCount);
    } else {
      const atTop = next.anchor.y === undefined || next.anchor.y >= pageTop(pages, next.anchor.page) - PAGE_TOP_SHARE * pageHeight(pages, next.anchor.page);
      if (atTop && next.anchor.page > d.anchor.page) {
        chapter.endPage = next.anchor.page - 1;
      } else {
        chapter.endPage = next.anchor.page;
        chapter.endY = next.anchor.y ?? pageTop(pages, next.anchor.page);
      }
      if (chapter.endPage < chapter.startPage) chapter.endPage = chapter.startPage;
    }
    out.push(chapter);
  }
  return out;
}

const MSG_NO_CHAPTERS = '此 PDF 無法可靠偵測章節，請改用整份論文或自訂頁數。';

/**
 * Detect chapters: native outline first, HEADING units of the final layout
 * otherwise. `source: 'none'` (with a warning) when neither is reliable; the
 * whole-document and page scopes keep working in that case.
 */
export function detectChapters(analysis: PdfAnalysis, layout: LayoutResult | null): ChapterDetection {
  const warnings: string[] = [...(analysis.outlineWarnings ?? [])];
  const blocks = layout?.blocks ?? [];
  const pages = analysis.pages;

  let drafts = draftsFromOutline(analysis.outline ?? [], blocks, pages, warnings);
  let source: ChapterSource = drafts.length ? 'outline' : 'none';
  if (drafts.length === 0) {
    if ((analysis.outline ?? []).length) warnings.push('outline present but no item could be resolved; falling back to headings');
    drafts = draftsFromHeadings(blocks);
    if (drafts.length >= 2) source = 'heading';
    else {
      drafts = [];
      warnings.push(drafts.length === 1 ? 'only one heading detected' : 'no headings detected');
    }
  }
  if (source === 'none') return { chapters: [], source, warnings: [MSG_NO_CHAPTERS, ...warnings] };

  // Reading order by anchor, stable for equal anchors (outline order / layout order).
  const ordered = drafts.map((d, i) => ({ d, i })).sort((a, b) => compareAnchors(a.d.anchor, b.d.anchor) || a.i - b.i).map((x) => x.d);
  const front = frontMatter(ordered, blocks, source);
  if (front) ordered.unshift(front);
  // Duplicate anchors (several bookmarks sharing one destination) make empty chapters; say so.
  for (let i = 1; i < ordered.length; i++) {
    if (compareAnchors(ordered[i - 1].anchor, ordered[i].anchor) === 0 && ordered[i - 1].level === ordered[i].level) {
      warnings.push(`"${ordered[i - 1].title}" and "${ordered[i].title}" share one anchor (page ${ordered[i].anchor.page}); the first one is empty`);
    }
  }
  return { chapters: finishChapters(ordered, pages, analysis.pageCount), source, warnings };
}

/** "p.3" or "p.3–5" for the chapter list. */
export function chapterPageLabel(chapter: ChapterInfo): string {
  const end = chapter.endPage ?? chapter.startPage;
  return end > chapter.startPage ? `p.${chapter.startPage}–${end}` : `p.${chapter.startPage}`;
}

/** Ids of `id` and every descendant, for the checkbox tree. */
export function chapterSubtreeIds(chapters: readonly ChapterInfo[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of chapters) if (c.parentId === out[i]) out.push(c.id);
  return out;
}
