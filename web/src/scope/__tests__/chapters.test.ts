/**
 * Chapter detection (scope/chapters.ts): outline → chapters with Y anchors
 * and ends, nested levels, same-page headings, heading fallback, failure.
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../../pdf/layout';
import type { PdfAnalysis } from '../../pdf/types';
import { chapterPageLabel, chapterSubtreeIds, detectChapters, isReferencesTitle, type ChapterInfo } from '../chapters';
import { block, documentAnalysis, outline, page } from './fixtures';

function bare(pageCount: number, extra: Partial<PdfAnalysis> = {}): PdfAnalysis {
  return {
    fileName: 'x.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount,
    pages: Array.from({ length: pageCount }, (_, i) => page(i + 1)),
    items: [],
    textItemCount: 0,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
    outline: [],
    outlineWarnings: [],
    ...extra,
  };
}

function layoutWith(blocks: ReturnType<typeof block>[]) {
  return {
    bodyFontSize: 10,
    pages: [],
    blocks,
    translationBlocks: [],
    tables: [],
    figures: [],
    containers: [],
    structuredRegions: [],
    roleOwnership: {},
    stats: {} as never,
  };
}

const byTitle = (chapters: ChapterInfo[], title: string): ChapterInfo => {
  const c = chapters.find((x) => x.title === title);
  if (!c) throw new Error(`chapter "${title}" not found in ${chapters.map((x) => x.title).join(' | ')}`);
  return c;
};

describe('detectChapters from the native outline', () => {
  it('1. uses the outline with page + Y anchors and computes the ends', () => {
    const analysis = bare(10, {
      outline: [outline('Introduction', 2, 462), outline('Methods', 3, 500), outline('Results', 5, 700), outline('Discussion', 8, 300)],
    });
    const d = detectChapters(analysis, null);
    expect(d.source).toBe('outline');
    expect(d.chapters.map((c) => [c.title, c.startPage, c.startY, c.endPage, c.endY])).toEqual([
      ['Introduction', 2, 462, 3, 500],
      ['Methods', 3, 500, 5, 700],
      ['Results', 5, 700, 8, 300],
      ['Discussion', 8, 300, 10, undefined],
    ]);
    expect(d.chapters.every((c) => c.level === 1 && c.source === 'outline')).toBe(true);
    expect(chapterPageLabel(d.chapters[0])).toBe('p.2–3');
    expect(chapterPageLabel(d.chapters[3])).toBe('p.8–10');
  });

  it('6. two chapters on one page are split by their Y anchors', () => {
    const analysis = bare(3, { outline: [outline('Results', 2, 700), outline('Discussion', 2, 300)] });
    const d = detectChapters(analysis, null);
    const results = byTitle(d.chapters, 'Results');
    const discussion = byTitle(d.chapters, 'Discussion');
    expect([results.startPage, results.startY, results.endPage, results.endY]).toEqual([2, 700, 2, 300]);
    expect([discussion.startPage, discussion.startY, discussion.endPage, discussion.endY]).toEqual([2, 300, 3, undefined]);
    expect(chapterPageLabel(results)).toBe('p.2');
  });

  it('2./7. nested items keep their levels and a parent runs to the next same-or-higher level', () => {
    const analysis = bare(12, {
      outline: [
        outline('3. Results', 5, 700, [outline('3.1 Primary outcome', 5, 400), outline('3.2 Secondary outcome', 6, 600)]),
        outline('4. Discussion', 8, 700),
      ],
    });
    const d = detectChapters(analysis, null);
    const results = byTitle(d.chapters, '3. Results');
    const primary = byTitle(d.chapters, '3.1 Primary outcome');
    const secondary = byTitle(d.chapters, '3.2 Secondary outcome');
    expect(results.level).toBe(1);
    expect(primary.level).toBe(2);
    expect(primary.parentId).toBe(results.id);
    expect(secondary.parentId).toBe(results.id);
    // parent: until 4. Discussion; children: until the next sibling / the parent's end
    expect([results.endPage, results.endY]).toEqual([8, 700]);
    expect([primary.endPage, primary.endY]).toEqual([6, 600]);
    expect([secondary.endPage, secondary.endY]).toEqual([8, 700]);
    expect(chapterSubtreeIds(d.chapters, results.id)).toEqual([results.id, primary.id, secondary.id]);
  });

  it('a next anchor at the very top of a page ends the previous chapter on the page before', () => {
    const analysis = bare(6, { outline: [outline('A', 1, 780), outline('B', 4, 790)] });
    const d = detectChapters(analysis, null);
    expect([d.chapters[0].endPage, d.chapters[0].endY]).toEqual([3, undefined]);
    expect(chapterPageLabel(d.chapters[0])).toBe('p.1–3');
  });

  it('5. skips an unresolved item but keeps its children, with a warning', () => {
    const analysis = bare(9, {
      outline: [outline('Broken', null, null, [outline('Child A', 2, 700), outline('Child B', 4, 700)]), outline('Next', 6, 700)],
      outlineWarnings: ['outline item "Broken" skipped: named destination "x" not found'],
    });
    const d = detectChapters(analysis, null);
    expect(d.source).toBe('outline');
    expect(d.chapters.map((c) => [c.title, c.level])).toEqual([
      ['Child A', 1],
      ['Child B', 1],
      ['Next', 1],
    ]);
    expect(d.warnings.some((w) => w.includes('Broken'))).toBe(true);
  });

  it('snaps an anchor to the heading block with the same title (a /Fit destination without Y, a shared destination)', () => {
    const blocks = [
      block({ id: 'p3-b001', page: 3, top: 700, text: 'Appendix A: Prior Literature', type: 'HEADING' }),
      block({ id: 'p3-b002', page: 3, top: 680, text: 'Some appendix text follows here.' }),
      block({ id: 'p4-b001', page: 4, top: 700, text: 'Appendix B: Prompts', type: 'HEADING' }),
    ];
    const analysis = bare(5, {
      outline: [outline('Appendix A: Prior Literature', 3, null), outline('Appendix B: Prompts', 3, null)],
    });
    const d = detectChapters(analysis, layoutWith(blocks));
    expect(d.chapters.map((c) => [c.title, c.startPage, c.startY])).toEqual([
      ['Appendix A: Prior Literature', 3, 700],
      ['Appendix B: Prompts', 4, 700],
    ]);
  });

  it('adds a front-matter chapter when translatable text precedes the first anchor', () => {
    const blocks = [
      block({ id: 'p1-b001', page: 1, top: 750, text: 'A Title', type: 'TITLE' }),
      block({ id: 'p1-b002', page: 1, top: 700, text: 'Abstract text of the paper.' }),
      block({ id: 'p2-b001', page: 2, top: 750, text: 'Introduction', type: 'HEADING' }),
    ];
    const analysis = bare(4, { outline: [outline('Introduction', 2, 760), outline('Methods', 3, 760)] });
    const d = detectChapters(analysis, layoutWith(blocks));
    expect(d.chapters[0].id).toBe('front');
    expect([d.chapters[0].startPage, d.chapters[0].endPage]).toEqual([1, 1]);
    expect(d.chapters[1].title).toBe('Introduction');
  });

  it('flags the references chapter', () => {
    const analysis = bare(4, { outline: [outline('Results', 1, 700), outline('REFERENCES', 3, 700)] });
    const d = detectChapters(analysis, null);
    expect(byTitle(d.chapters, 'REFERENCES').references).toBe(true);
    expect(byTitle(d.chapters, 'Results').references).toBe(false);
    expect(isReferencesTitle('7. References')).toBe(true);
    expect(isReferencesTitle('Bibliography')).toBe(true);
    expect(isReferencesTitle('Reference standards')).toBe(false);
  });
});

describe('detectChapters heading fallback', () => {
  it('9. uses the HEADING units of the final layout when there is no outline', () => {
    const blocks = [
      block({ id: 'p1-b001', page: 1, top: 750, text: 'Abstract', type: 'HEADING' }),
      block({ id: 'p1-b002', page: 1, top: 730, text: 'Abstract text.' }),
      block({ id: 'p2-b001', page: 2, top: 750, text: 'Introduction', type: 'HEADING' }),
      block({ id: 'p2-b002', page: 2, top: 730, text: 'Intro text.' }),
      block({ id: 'p3-b001', page: 3, top: 750, text: 'Methods', type: 'HEADING' }),
      block({ id: 'p5-b001', page: 5, top: 750, text: 'Results', type: 'HEADING' }),
      block({ id: 'p8-b001', page: 8, top: 400, text: 'Discussion', type: 'HEADING' }),
      block({ id: 'p10-b001', page: 10, top: 750, text: 'References', type: 'HEADING' }),
      block({ id: 'p10-b002', page: 10, top: 730, text: '1. Doe J. Paper. 2020.', type: 'REFERENCE' }),
    ];
    const d = detectChapters(bare(13), layoutWith(blocks));
    expect(d.source).toBe('heading');
    expect(d.chapters.map((c) => [c.title, chapterPageLabel(c)])).toEqual([
      ['Abstract', 'p.1'],
      ['Introduction', 'p.2'],
      ['Methods', 'p.3–4'],
      ['Results', 'p.5–8'],
      ['Discussion', 'p.8–9'],
      ['References', 'p.10–13'],
    ]);
    expect(d.chapters.every((c) => c.level === 1 && c.source === 'heading')).toBe(true);
    expect(byTitle(d.chapters, 'References').references).toBe(true);
  });

  it('derives levels from the numbering and keeps a parent over its children', () => {
    const blocks = [
      block({ id: 'p1-b001', page: 1, top: 750, text: '1 Introduction', type: 'HEADING' }),
      block({ id: 'p2-b001', page: 2, top: 750, text: '2 Methods', type: 'HEADING' }),
      block({ id: 'p2-b002', page: 2, top: 500, text: '2.1 Participants', type: 'HEADING' }),
      block({ id: 'p3-b001', page: 3, top: 750, text: '2.2 Measures', type: 'HEADING' }),
      block({ id: 'p4-b001', page: 4, top: 750, text: '3 Results', type: 'HEADING' }),
    ];
    const d = detectChapters(bare(6), layoutWith(blocks));
    const methods = byTitle(d.chapters, '2 Methods');
    expect(d.chapters.map((c) => c.level)).toEqual([1, 1, 2, 2, 1]);
    expect(byTitle(d.chapters, '2.1 Participants').parentId).toBe(methods.id);
    expect(byTitle(d.chapters, '2.2 Measures').parentId).toBe(methods.id);
    expect([methods.endPage, methods.endY]).toEqual([3, undefined]);
    expect(chapterPageLabel(byTitle(d.chapters, '2.1 Participants'))).toBe('p.2');
  });

  it('without numbering, a clearly larger heading font makes level 1; equal sizes are all level 1', () => {
    const tiered = [
      block({ id: 'p1-b001', page: 1, top: 750, text: 'Study design', type: 'HEADING', fontSize: 14 }),
      block({ id: 'p1-b002', page: 1, top: 600, text: 'Recruitment', type: 'HEADING', fontSize: 11 }),
      block({ id: 'p2-b001', page: 2, top: 750, text: 'Outcomes', type: 'HEADING', fontSize: 14 }),
    ];
    expect(detectChapters(bare(3), layoutWith(tiered)).chapters.map((c) => c.level)).toEqual([1, 2, 1]);
    const flat = tiered.map((b) => ({ ...b, fontSize: 12 }));
    expect(detectChapters(bare(3), layoutWith(flat)).chapters.map((c) => c.level)).toEqual([1, 1, 1]);
  });

  it('10. reports no chapters when neither an outline nor enough headings exist', () => {
    const d = detectChapters(bare(3), layoutWith([block({ id: 'p1-b001', page: 1, top: 750, text: 'Only heading', type: 'HEADING' })]));
    expect(d.source).toBe('none');
    expect(d.chapters).toEqual([]);
    expect(d.warnings[0]).toBe('此 PDF 無法可靠偵測章節，請改用整份論文或自訂頁數。');
    expect(detectChapters(bare(3), null).source).toBe('none');
  });
});

describe('detectChapters on the analysed fixture document', () => {
  it('heading fallback runs on the final layout (after table / figure resolution)', () => {
    const analysis = documentAnalysis(false);
    const layout = analyzeLayout(analysis);
    expect(layout.tables[0]?.resolved).toBe(true);
    expect(layout.figures[0]?.resolved).toBe(true);
    const d = detectChapters(analysis, layout);
    expect(d.source).toBe('heading');
    const titles = d.chapters.map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(['Abstract', '1. Introduction', '2. Methods', '2.1 Participants', '3. Results', '4. Discussion', 'References']));
    // no table cell or figure element ever becomes a chapter
    expect(titles.some((t) => /Characteristic|Never|Yes|Female/.test(t))).toBe(false);
    expect(byTitle(d.chapters, '2.1 Participants').parentId).toBe(byTitle(d.chapters, '2. Methods').id);
  });

  it('prefers the outline when both exist', () => {
    const analysis = documentAnalysis(true);
    const d = detectChapters(analysis, analyzeLayout(analysis));
    expect(d.source).toBe('outline');
    expect(d.chapters.map((c) => c.title)).toEqual(['標題與摘要', '1. Introduction', '2. Methods', '2.1 Participants', '3. Results', '4. Discussion', 'References']);
    // anchors snapped to the heading blocks
    const methods = byTitle(d.chapters, '2. Methods');
    expect(methods.startPage).toBe(2);
    expect(methods.startY).toBeCloseTo(740 + 0.8 * 12, 0);
  });
});
