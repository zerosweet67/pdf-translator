/**
 * Export page selection (scope/output.ts): which pages end up in the
 * downloaded file, the "輸出頁面" line and the file name.
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../../pdf/layout';
import { detectChapters, type ChapterInfo } from '../chapters';
import { formatPageRuns, pageRuns, resolveOutputPages, sanitizeChapterTitle, withOutputSuffix } from '../output';
import { resolveTranslationScope, type TranslationScope } from '../scope';
import { block, documentAnalysis, unit } from './fixtures';

function chapter(id: string, title: string, startPage: number, endPage: number, extra: Partial<ChapterInfo> = {}): ChapterInfo {
  return { id, title, level: 1, startPage, endPage, source: 'outline', ...extra };
}

const CHAPTERS: ChapterInfo[] = [
  chapter('c1', 'Introduction', 1, 4, { startY: 700, endY: 520 }),
  // starts mid-page 4 and ends mid-page 8
  chapter('c2', 'Methods', 4, 8, { startY: 520, endY: 300 }),
  chapter('c3', 'Results', 8, 11, { startY: 300, endY: 640 }),
  chapter('c4', 'References', 11, 13, { startY: 640 }),
];

describe('page runs and labels', () => {
  it('collapses consecutive pages and formats them for the UI', () => {
    expect(pageRuns([3, 1, 2, 7, 5, 6])).toEqual([
      [1, 3],
      [5, 7],
    ]);
    expect(formatPageRuns([17])).toBe('17');
    expect(formatPageRuns([5, 6, 7, 8])).toBe('5–8');
    expect(formatPageRuns([2, 3, 4, 5, 9, 10, 11])).toBe('2–5、9–11');
  });

  it('makes a chapter title safe for a file name', () => {
    expect(sanitizeChapterTitle('3. Results')).toBe('3-Results');
    expect(sanitizeChapterTitle('Materials and Methods')).toBe('Materials-and-Methods');
    expect(sanitizeChapterTitle('標題與摘要')).toBe('標題與摘要');
    expect(sanitizeChapterTitle('///')).toBe('chapter');
    expect(sanitizeChapterTitle('a'.repeat(80))).toHaveLength(40);
  });

  it('appends the range to the file name and leaves it alone without one', () => {
    expect(withOutputSuffix('paper_bilingual_zh-TW.pdf', '_p17')).toBe('paper_bilingual_zh-TW_p17.pdf');
    expect(withOutputSuffix('paper_bilingual_zh-TW.pdf', '_Methods_p5-8')).toBe('paper_bilingual_zh-TW_Methods_p5-8.pdf');
    expect(withOutputSuffix('paper_bilingual_zh-TW.pdf', '')).toBe('paper_bilingual_zh-TW.pdf');
  });
});

describe('resolveOutputPages', () => {
  it('all → every page, no suffix', () => {
    const o = resolveOutputPages({ mode: 'all' }, CHAPTERS, 13);
    expect(o.pages).toBeNull();
    expect(o.full).toBe(true);
    expect(o.label).toBe('全部 13 頁');
    expect(o.fileSuffix).toBe('');
  });

  it('pages p17 → exactly one page', () => {
    const o = resolveOutputPages({ mode: 'pages', startPage: 17, endPage: 17 }, CHAPTERS, 50);
    expect(o.pages).toEqual([17]);
    expect(o.full).toBe(false);
    expect(o.label).toBe('第 17 頁');
    expect(o.fileSuffix).toBe('_p17');
  });

  it('pages p17–20 → four pages', () => {
    const o = resolveOutputPages({ mode: 'pages', startPage: 17, endPage: 20 }, CHAPTERS, 50);
    expect(o.pages).toEqual([17, 18, 19, 20]);
    expect(o.label).toBe('第 17–20 頁');
    expect(o.fileSuffix).toBe('_p17-20');
  });

  it('a boundary-expanded unit never widens the page mode output', () => {
    // A unit merged from page 16 into page 17 is translated, but page 16 is not exported.
    const a = block({ id: 'p16-b009', page: 16, top: 120, text: 'The sentence starts on page sixteen and' });
    const b = block({ id: 'p17-b001', page: 17, top: 700, text: 'ends on page seventeen.' });
    const merged = unit([a, b]);
    const r = resolveTranslationScope([merged], [], { mode: 'pages', startPage: 17, endPage: 17 }, { pageCount: 50 });
    if (!r.ok) throw new Error(r.error);
    expect(r.units).toHaveLength(1); // translated whole
    expect(r.stats.boundaryExpanded).toBe(1);
    expect(r.stats.selectedPages).toEqual([16, 17]); // touches both pages
    const o = resolveOutputPages(r.scope, [], 50);
    expect(o.pages).toEqual([17]); // ...but the export is still one page
  });

  it('chapter p5–8 → four pages, with the chapter in the file name', () => {
    const o = resolveOutputPages({ mode: 'chapters', chapterIds: ['c3'] }, [chapter('c3', 'Results', 5, 8)], 13);
    expect(o.pages).toEqual([5, 6, 7, 8]);
    expect(o.label).toBe('第 5–8 頁');
    expect(o.fileSuffix).toBe('_Results_p5-8');
  });

  it('a chapter that starts and ends mid-page keeps both pages whole', () => {
    const o = resolveOutputPages({ mode: 'chapters', chapterIds: ['c2'] }, CHAPTERS, 13);
    expect(o.pages).toEqual([4, 5, 6, 7, 8]); // page 4 and page 8 are never cut in half
    expect(o.label).toBe('第 4–8 頁');
    expect(o.fileSuffix).toBe('_Methods_p4-8');
  });

  it('several chapters make one union; non-consecutive pages stay separate runs', () => {
    const o = resolveOutputPages({ mode: 'chapters', chapterIds: ['c1', 'c3'] }, CHAPTERS, 13);
    expect(o.pages).toEqual([1, 2, 3, 4, 8, 9, 10, 11]);
    expect(o.label).toBe('第 1–4、8–11 頁');
    expect(o.fileSuffix).toBe('_Introduction+1_p1-4_8-11');
  });

  it('保留完整 PDF → the original page count, whatever the scope is', () => {
    const scopes: TranslationScope[] = [
      { mode: 'pages', startPage: 17, endPage: 17 },
      { mode: 'chapters', chapterIds: ['c2'] },
    ];
    for (const scope of scopes) {
      const o = resolveOutputPages(scope, CHAPTERS, 50, { keepFullDocument: true });
      expect(o.pages).toBeNull();
      expect(o.full).toBe(true);
      expect(o.label).toBe('全部 50 頁');
      expect(o.fileSuffix).toBe('');
    }
  });

  it('clamps a range to the document and falls back to the whole document when nothing is covered', () => {
    expect(resolveOutputPages({ mode: 'pages', startPage: 12, endPage: 99 }, CHAPTERS, 13).pages).toEqual([12, 13]);
    const none = resolveOutputPages({ mode: 'chapters', chapterIds: ['missing'] }, CHAPTERS, 13);
    expect(none.pages).toBeNull();
    expect(none.full).toBe(true);
  });

  it('a scope that covers every page exports the whole document but keeps the range in the name', () => {
    const o = resolveOutputPages({ mode: 'pages', startPage: 1, endPage: 13 }, CHAPTERS, 13);
    expect(o.pages).toBeNull();
    expect(o.fileSuffix).toBe('_p1-13');
  });
});

describe('export page selection costs nothing', () => {
  it('does not change the selected units, so no extra API call or token', () => {
    const analysis = documentAnalysis(true);
    const layout = analyzeLayout(analysis);
    const chapters = detectChapters(analysis, layout).chapters;
    const scope = { mode: 'pages', startPage: 3, endPage: 4 } as const;
    const r = resolveTranslationScope(layout.translationBlocks, chapters, scope, {
      pageCount: analysis.pageCount,
      blocks: layout.blocks,
      pages: analysis.pages,
    });
    if (!r.ok) throw new Error(r.error);

    const cut = resolveOutputPages(scope, chapters, analysis.pageCount);
    const whole = resolveOutputPages(scope, chapters, analysis.pageCount, { keepFullDocument: true });
    expect(cut.pages).toEqual([3, 4]);
    expect(whole.pages).toBeNull();

    // The same resolution is used for both exports: the units, and therefore the provider work, are identical.
    const again = resolveTranslationScope(layout.translationBlocks, chapters, scope, {
      pageCount: analysis.pageCount,
      blocks: layout.blocks,
      pages: analysis.pages,
    });
    if (!again.ok) throw new Error(again.error);
    expect(again.units.map((u) => u.id)).toEqual(r.units.map((u) => u.id));
    expect(again.fingerprint).toBe(r.fingerprint);
    expect(again.stats.providerBound).toBe(r.stats.providerBound);
  });
});
