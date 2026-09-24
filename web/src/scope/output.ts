/**
 * Export page selection: which pages of the original PDF end up in the file
 * the user downloads.
 *
 * This is purely an export concern and is deliberately separate from
 * scope/scope.ts, which decides which logical units are translated. Nothing
 * here changes what is sent to the provider, so cutting the output costs no
 * API call and no token, and a partial export never re-translates anything.
 *
 * Rules:
 *   整份論文  → the whole document, always.
 *   自訂頁數  → exactly the pages the user typed. A unit that was expanded
 *               across the boundary (a paragraph merged from the previous
 *               page) is still translated, but it never adds an output page.
 *   選擇章節  → every page a selected chapter touches, each page whole. A
 *               chapter that starts or ends in the middle of a page keeps
 *               that page complete; pages are never cut in half.
 *   保留完整 PDF (checkbox) → the whole document again, with the Chinese
 *               overlay on the current scope only. It never accumulates the
 *               units of an earlier scope run.
 */

import type { ChapterInfo } from './chapters';
import type { TranslationScope } from './scope';

export interface OutputPages {
  /** Pages to export (1-based, ascending, unique). null = every page. */
  pages: number[] | null;
  /** User-facing line: "全部 50 頁" / "第 17 頁" / "第 5–8 頁" / "第 2–5、9–11 頁". */
  label: string;
  /** Appended to the file name before ".pdf": "" / "_p17" / "_Methods_p5-8". */
  fileSuffix: string;
  /** True when the whole document is exported. */
  full: boolean;
}

/** Longest chapter-title part of a file name, in characters. */
const MAX_TITLE_CHARS = 40;

function clampPage(page: number, total: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.round(page)), total);
}

function pageRange(start: number, end: number): number[] {
  const out: number[] = [];
  for (let p = Math.min(start, end); p <= Math.max(start, end); p++) out.push(p);
  return out;
}

/** Consecutive pages collapsed into [first, last] pairs. */
export function pageRuns(pages: readonly number[]): [number, number][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs;
}

/** "17", "5–8", "2–5、9–11" (en dash, for the UI). */
export function formatPageRuns(pages: readonly number[]): string {
  return pageRuns(pages)
    .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
    .join('、');
}

/** "_p17", "_p17-20", "_p2-5_9-11" (hyphen, for file names). */
function pageSuffix(pages: readonly number[]): string {
  return `_p${pageRuns(pages)
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join('_')}`;
}

/** Chapter title reduced to letters, digits and hyphens, so it is safe in a file name. */
export function sanitizeChapterTitle(title: string): string {
  const cleaned = title
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...cleaned].slice(0, MAX_TITLE_CHARS).join('') || 'chapter';
}

/** "_Methods" for one chapter, "_Methods+2" when three are selected. */
function chapterSuffix(picked: readonly ChapterInfo[]): string {
  if (picked.length === 0) return '';
  const first = sanitizeChapterTitle(picked[0].title);
  return picked.length === 1 ? `_${first}` : `_${first}+${picked.length - 1}`;
}

/**
 * The pages the export will contain. `keepFullDocument` is the "保留完整 PDF"
 * checkbox: the whole document is written and only the current scope's units
 * carry the Chinese overlay.
 */
export function resolveOutputPages(
  scope: TranslationScope,
  chapters: readonly ChapterInfo[],
  pageCount: number,
  options: { keepFullDocument?: boolean } = {},
): OutputPages {
  const total = Math.max(1, Math.floor(pageCount) || 1);
  const whole: OutputPages = { pages: null, label: `全部 ${total} 頁`, fileSuffix: '', full: true };
  if (options.keepFullDocument || scope.mode === 'all') return whole;

  let pages: number[];
  let namePrefix = '';
  if (scope.mode === 'pages') {
    // Exactly what the user typed; boundary-expanded units never widen this.
    pages = pageRange(clampPage(scope.startPage, total), clampPage(scope.endPage, total));
  } else {
    const wanted = new Set(scope.chapterIds);
    const picked = chapters.filter((c) => wanted.has(c.id));
    const set = new Set<number>();
    for (const c of picked) {
      // Whole pages only: a chapter that starts or ends mid-page keeps that page complete.
      for (const p of pageRange(clampPage(c.startPage, total), clampPage(c.endPage ?? c.startPage, total))) set.add(p);
    }
    pages = [...set].sort((a, b) => a - b);
    namePrefix = chapterSuffix(picked);
  }

  if (pages.length === 0) return whole; // nothing to cut to; keeping the document whole is the safe answer
  if (pages.length >= total) return { ...whole, fileSuffix: `${namePrefix}${pageSuffix(pages)}` };
  return {
    pages,
    label: `第 ${formatPageRuns(pages)} 頁`,
    fileSuffix: `${namePrefix}${pageSuffix(pages)}`,
    full: false,
  };
}

/** Insert the range into an already built file name: "a_zh-TW.pdf" + "_p17" → "a_zh-TW_p17.pdf". */
export function withOutputSuffix(fileName: string, suffix: string): string {
  if (!suffix) return fileName;
  const base = fileName.replace(/\.pdf$/i, '');
  return `${base}${suffix}.pdf`;
}
