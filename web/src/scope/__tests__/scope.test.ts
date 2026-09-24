/**
 * Scope resolution (scope/scope.ts): page ranges, chapters, cross-boundary
 * units, and the guarantee that the scope works on the final logical units
 * (TABLE_CELL / FIGURE elements after table and figure resolution).
 */
import { describe, expect, it } from 'vitest';
import { isUntranslatableText } from '../../pdf/classify';
import { analyzeLayout } from '../../pdf/layout';
import type { TranslationBlock } from '../../pdf/types';
import { detectChapters, type ChapterInfo } from '../chapters';
import {
  MSG_INVALID_PAGE_RANGE,
  resolveTranslationScope,
  scopeFingerprint,
  terminologyContextUnits,
  unitsInDocumentOrder,
  validatePageRange,
  type TranslationScope,
} from '../scope';
import { block, documentAnalysis, unit } from './fixtures';

// ---------------------------------------------------------------------------
// Hand-built units on 20 pages
// ---------------------------------------------------------------------------

/** One paragraph per page (top 700), plus a merged unit page 9 → 10 and two headings on page 12. */
function handUnits(): { units: TranslationBlock[]; chapters: ChapterInfo[] } {
  const units: TranslationBlock[] = [];
  for (let p = 1; p <= 20; p++) {
    if (p === 9) {
      const a = block({ id: 'p9-b001', page: 9, top: 700, text: 'The sentence starts on page nine and' });
      const b = block({ id: 'p10-b001', page: 10, top: 700, text: 'ends on page ten.' });
      units.push(unit([a, b]));
      units.push(unit([block({ id: 'p9-b002', page: 9, top: 400, text: 'Another page nine paragraph.' })]));
      continue;
    }
    if (p === 10) {
      units.push(unit([block({ id: 'p10-b002', page: 10, top: 400, text: 'Second paragraph on page ten.' })]));
      continue;
    }
    if (p === 12) {
      units.push(unit([block({ id: 'p12-b001', page: 12, top: 740, text: '3. Results', type: 'HEADING' })]));
      units.push(unit([block({ id: 'p12-b002', page: 12, top: 700, text: 'Results paragraph one.' })]));
      units.push(unit([block({ id: 'p12-b003', page: 12, top: 500, text: '3.1 Primary outcome', type: 'HEADING' })]));
      units.push(unit([block({ id: 'p12-b004', page: 12, top: 460, text: 'Primary outcome paragraph.' })]));
      units.push(unit([block({ id: 'p12-b005', page: 12, top: 300, text: '3.2 Secondary outcome', type: 'HEADING' })]));
      units.push(unit([block({ id: 'p12-b006', page: 12, top: 260, text: 'Secondary outcome paragraph.' })]));
      continue;
    }
    if (p === 13) {
      units.push(unit([block({ id: 'p13-b001', page: 13, top: 740, text: '4. Discussion', type: 'HEADING' })]));
      units.push(unit([block({ id: 'p13-b002', page: 13, top: 700, text: 'Discussion paragraph.' })]));
      continue;
    }
    units.push(unit([block({ id: `p${p}-b001`, page: p, top: 700, text: `Paragraph on page ${p}.` })]));
  }
  const chapters: ChapterInfo[] = [
    { id: 'c3', title: '3. Results', level: 1, startPage: 12, startY: 740, endPage: 13, endY: 740, source: 'outline' },
    { id: 'c31', title: '3.1 Primary outcome', level: 2, startPage: 12, startY: 500, endPage: 12, endY: 300, source: 'outline', parentId: 'c3' },
    { id: 'c32', title: '3.2 Secondary outcome', level: 2, startPage: 12, startY: 300, endPage: 13, endY: 740, source: 'outline', parentId: 'c3' },
    { id: 'c4', title: '4. Discussion', level: 1, startPage: 13, startY: 740, endPage: 20, source: 'outline' },
  ];
  return { units, chapters };
}

const ids = (units: TranslationBlock[]) => units.map((u) => u.id);

describe('validatePageRange', () => {
  it('11.–14. accepts 1 ≤ start ≤ end ≤ total and rejects everything else', () => {
    expect(validatePageRange(3, 5, 13)).toEqual({ ok: true, startPage: 3, endPage: 5 });
    expect(validatePageRange('1', '13', 13)).toEqual({ ok: true, startPage: 1, endPage: 13 });
    expect(validatePageRange(0, 5, 13)).toEqual({ ok: false, error: MSG_INVALID_PAGE_RANGE });
    expect(validatePageRange(1, 14, 13)).toEqual({ ok: false, error: MSG_INVALID_PAGE_RANGE });
    expect(validatePageRange(6, 5, 13)).toEqual({ ok: false, error: MSG_INVALID_PAGE_RANGE });
    expect(validatePageRange('', '5', 13).ok).toBe(false);
    expect(validatePageRange('2.5', '5', 13).ok).toBe(false);
    expect(validatePageRange('abc', '5', 13).ok).toBe(false);
  });
});

describe('scopeFingerprint', () => {
  it('30. is deterministic and independent of chapter order', () => {
    expect(scopeFingerprint({ mode: 'all' })).toBe('all');
    expect(scopeFingerprint({ mode: 'pages', startPage: 3, endPage: 5 })).toBe('pages:3-5');
    expect(scopeFingerprint({ mode: 'chapters', chapterIds: ['b', 'a', 'b'] })).toBe(scopeFingerprint({ mode: 'chapters', chapterIds: ['a', 'b'] }));
    expect(scopeFingerprint({ mode: 'chapters', chapterIds: ['a'] })).not.toBe(scopeFingerprint({ mode: 'chapters', chapterIds: ['b'] }));
    const long = Array.from({ length: 40 }, (_, i) => `hd-p${i}-b001-${i}`);
    expect(scopeFingerprint({ mode: 'chapters', chapterIds: long }).length).toBeLessThan(40);
  });
});

describe('resolveTranslationScope: pages', () => {
  const { units, chapters } = handUnits();
  const opts = { pageCount: 20 };

  it('11. selects only the units of the page range', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'pages', startPage: 3, endPage: 5 }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['p3-b001', 'p4-b001', 'p5-b001']);
    expect(r.stats.boundaryExpanded).toBe(0);
    expect(r.stats.selectedPages).toEqual([3, 4, 5]);
    expect(r.fingerprint).toBe('pages:3-5');
  });

  it('12.–14. an invalid range resolves to an error and selects nothing', () => {
    for (const [s, e] of [
      [0, 5],
      [1, 21],
      [8, 3],
    ]) {
      const r = resolveTranslationScope(units, chapters, { mode: 'pages', startPage: s, endPage: e }, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(MSG_INVALID_PAGE_RANGE);
    }
  });

  it('15. the full page range selects exactly what "all" selects', () => {
    const all = resolveTranslationScope(units, chapters, { mode: 'all' }, opts);
    const full = resolveTranslationScope(units, chapters, { mode: 'pages', startPage: 1, endPage: 20 }, opts);
    if (!all.ok || !full.ok) throw new Error('resolve failed');
    expect(ids(full.units)).toEqual(ids(all.units));
    expect(ids(all.units)).toEqual(ids(units));
    expect(all.stats.selectedUnits).toBe(units.length);
    expect(full.stats.boundaryExpanded).toBe(0);
  });

  it('16. a unit merged across the page break is taken whole and marked boundary-expanded', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'pages', startPage: 10, endPage: 20 }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toContain('merged-p9-b001-p10-b001');
    expect(r.boundaryExpandedIds).toEqual(new Set(['merged-p9-b001-p10-b001']));
    expect(r.stats.boundaryExpanded).toBe(1);
    // ...but nothing else of page 9 comes along
    expect(ids(r.units)).not.toContain('p9-b002');
  });

  it('17. units of pages outside the range are excluded', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'pages', startPage: 10, endPage: 11 }, opts);
    if (!r.ok) throw new Error(r.error);
    for (const u of r.units) expect(u.pages.some((p) => p >= 10 && p <= 11)).toBe(true);
    expect(ids(r.units)).toEqual(['merged-p9-b001-p10-b001', 'p10-b002', 'p11-b001']);
  });

  it('falls back to `pages` for units without a span', () => {
    const noSpan = units.map((u) => ({ ...u, span: undefined }));
    const r = resolveTranslationScope(noSpan, chapters, { mode: 'pages', startPage: 10, endPage: 10 }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['merged-p9-b001-p10-b001', 'p10-b002']);
  });
});

describe('resolveTranslationScope: chapters', () => {
  const { units, chapters } = handUnits();
  const opts = { pageCount: 20 };

  it('7. a parent chapter includes its children up to the next same-level chapter', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'chapters', chapterIds: ['c3'] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['p12-b001', 'p12-b002', 'p12-b003', 'p12-b004', 'p12-b005', 'p12-b006']);
    expect(ids(r.units)).not.toContain('p13-b001');
    expect(r.stats.heading).toBe(3);
    expect(r.stats.body).toBe(3);
  });

  it('8. a child alone stops at the next sibling anchor on the same page', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'chapters', chapterIds: ['c31'] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['p12-b003', 'p12-b004']);
    expect(r.stats.boundaryExpanded).toBe(0);
  });

  it('several chapters form a union; ids are deduplicated in the fingerprint', () => {
    const r = resolveTranslationScope(units, chapters, { mode: 'chapters', chapterIds: ['c32', 'c4', 'c32'] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['p12-b005', 'p12-b006', 'p13-b001', 'p13-b002', ...Array.from({ length: 7 }, (_, i) => `p${14 + i}-b001`)]);
    expect(r.fingerprint).toBe('chapters:2:c32,c4');
  });

  it('a unit that straddles a chapter anchor is taken whole and counted as boundary-expanded', () => {
    const a = block({ id: 'p13-b000', page: 12, top: 120, text: 'The last sentence of the results section continues' });
    const b = block({ id: 'p13-b002x', page: 13, top: 700, text: 'after the discussion heading.' });
    const straddling = unit([a, b]);
    const r = resolveTranslationScope([...units, straddling], chapters, { mode: 'chapters', chapterIds: ['c4'] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toContain(straddling.id);
    expect(r.boundaryExpandedIds.has(straddling.id)).toBe(true);
    // ...and it is not enough to drag in the rest of page 12
    expect(ids(r.units)).not.toContain('p12-b006');
  });

  it('tolerates a heading whose box starts a few points above its anchor', () => {
    const heading = unit([block({ id: 'h', page: 13, top: 740 + 3, text: '4. Discussion', type: 'HEADING' })]);
    const r = resolveTranslationScope([heading], chapters, { mode: 'chapters', chapterIds: ['c4'] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.units)).toEqual(['h']);
    const prev = resolveTranslationScope([heading], chapters, { mode: 'chapters', chapterIds: ['c3'] }, opts);
    if (!prev.ok) throw new Error(prev.error);
    expect(ids(prev.units)).toEqual([]);
  });

  it('rejects an empty selection, unknown ids and a document without chapters', () => {
    expect(resolveTranslationScope(units, chapters, { mode: 'chapters', chapterIds: [] }, opts).ok).toBe(false);
    expect(resolveTranslationScope(units, chapters, { mode: 'chapters', chapterIds: ['nope'] }, opts).ok).toBe(false);
    const none = resolveTranslationScope(units, [], { mode: 'chapters', chapterIds: ['c3'] }, opts);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('無法可靠偵測章節');
  });
});

// ---------------------------------------------------------------------------
// Final logical units through the real layout (table + figure resolution)
// ---------------------------------------------------------------------------

describe('resolveTranslationScope on the analysed document (logical unit integration)', () => {
  const analysis = documentAnalysis(true);
  const layout = analyzeLayout(analysis);
  const chapters = detectChapters(analysis, layout).chapters;
  const opts = { pageCount: analysis.pageCount, blocks: layout.blocks, pages: analysis.pages };
  const chapterId = (title: string) => {
    const c = chapters.find((x) => x.title === title);
    if (!c) throw new Error(`no chapter ${title}`);
    return c.id;
  };

  it('the fixture resolves its table and figure and has no duplicate source items', () => {
    expect(layout.tables).toHaveLength(1);
    expect(layout.tables[0].resolved).toBe(true);
    expect(layout.figures).toHaveLength(1);
    expect(layout.figures[0].resolved).toBe(true);
    expect(layout.stats.duplicateSourceItems).toBe(0);
  });

  it('18./20. scope applies after table resolution: page 3 selects TABLE_CELL units, page 2 selects none', () => {
    const p3 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 3, endPage: 3 }, opts);
    if (!p3.ok) throw new Error(p3.error);
    const tableUnits = p3.units.filter((u) => u.type === 'TABLE');
    expect(tableUnits.length).toBe(layout.tables[0].translatedCells);
    expect(tableUnits.map((u) => u.text)).toContain('Time from last interview to death, mean (SD)');
    expect(tableUnits.map((u) => u.text)).toContain('Observed No. (weighted %)');
    for (const u of tableUnits) expect(layout.blocks.find((b) => b.id === u.sourceBlockIds[0])?.cell?.kind).toBe('table');
    expect(p3.stats.tableCells).toBe(tableUnits.length);
    const p2 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 2, endPage: 2 }, opts);
    if (!p2.ok) throw new Error(p2.error);
    expect(p2.units.some((u) => u.type === 'TABLE')).toBe(false);
    expect(p2.stats.tableCells).toBe(0);
  });

  it('19./21./22. scope applies after figure resolution: page 4 selects the FIGURE elements (box text and labels)', () => {
    const p4 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 4, endPage: 4 }, opts);
    if (!p4.ok) throw new Error(p4.error);
    const figureUnits = p4.units.filter((u) => u.type === 'FIGURE');
    expect(figureUnits.length).toBe(layout.figures[0].translatedCells);
    expect(figureUnits.map((u) => u.text)).toContain('In the last month, how often did you go outside?');
    expect(figureUnits.map((u) => u.text)).toContain('Never');
    for (const u of figureUnits) {
      expect(u.blockType).toBe('FIGURE_LABEL');
      expect(layout.blocks.find((b) => b.id === u.sourceBlockIds[0])?.cell?.kind).toBe('figure');
    }
    expect(p4.stats.figureUnits).toBe(figureUnits.length);
    expect(p4.units.some((u) => u.type === 'CAPTION')).toBe(true); // the figure caption stays a CAPTION unit
    const p5 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 5, endPage: 5 }, opts);
    if (!p5.ok) throw new Error(p5.error);
    expect(p5.units.some((u) => u.type === 'FIGURE')).toBe(false);
  });

  it('23. numeric-only visual units stay skipped inside the scope (never a unit, counted as skipped)', () => {
    const p3 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 3, endPage: 4 }, opts);
    if (!p3.ok) throw new Error(p3.error);
    const numeric = layout.blocks.filter((b) => b.cell?.numeric);
    expect(numeric.length).toBeGreaterThanOrEqual(8);
    const selectedSources = new Set(p3.units.flatMap((u) => u.sourceBlockIds));
    for (const b of numeric) expect(selectedSources.has(b.id)).toBe(false);
    expect(p3.units.some((u) => /^(<\.001|0|35|389 \(63\.0\))$/.test(u.text))).toBe(false);
    expect(p3.stats.numericSkipped).toBe(numeric.length);
    const p1 = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'pages', startPage: 1, endPage: 1 }, opts);
    if (!p1.ok) throw new Error(p1.error);
    expect(p1.stats.numericSkipped).toBe(0);
  });

  it('24./25. pre-table and pre-figure blocks are not provider-bound: every selected unit is a final logical unit', () => {
    const all = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'all' }, opts);
    if (!all.ok) throw new Error(all.error);
    const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
    for (const u of all.units) {
      for (const id of u.sourceBlockIds) {
        const b = blockById.get(id);
        expect(b).toBeDefined();
        // a table / figure text unit is exactly one logical cell, never a paragraph-style pre-table block
        if (b?.type === 'TABLE' || b?.type === 'FIGURE') {
          expect(b.cell).toBeDefined();
          expect(u.sourceBlockIds).toHaveLength(1);
        }
      }
    }
    // the raw table fragments never appear as units
    expect(all.units.map((u) => u.text)).not.toContain('interview to death,');
    expect(all.units.map((u) => u.text)).not.toContain('you go outside?');
    // figure text never goes back to the paragraph / footnote pipeline
    expect(all.units.filter((u) => u.type === 'FOOTNOTE' || u.type === 'BODY').some((u) => /go outside|^Never$|^Yes$/.test(u.text))).toBe(false);
  });

  it('26. duplicate source-item ownership among the selected provider-bound units is 0 in every mode', () => {
    const scopes: TranslationScope[] = [
      { mode: 'all' },
      { mode: 'pages', startPage: 3, endPage: 4 },
      { mode: 'chapters', chapterIds: [chapterId('3. Results')] },
      { mode: 'chapters', chapterIds: [chapterId('2. Methods'), chapterId('4. Discussion')] },
    ];
    for (const scope of scopes) {
      const r = resolveTranslationScope(layout.translationBlocks, chapters, scope, opts);
      if (!r.ok) throw new Error(r.error);
      expect(r.stats.duplicateSourceItems).toBe(0);
      expect(new Set(r.units.map((u) => u.id)).size).toBe(r.units.length);
      expect(r.stats.providerBound).toBe(r.units.filter((u) => !isUntranslatableText(u.text)).length);
    }
  });

  it('chapter "3. Results" (outline anchor) contains the table cells, not the figure or the discussion', () => {
    const r = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'chapters', chapterIds: [chapterId('3. Results')] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(r.stats.tableCells).toBe(layout.tables[0].translatedCells);
    expect(r.stats.figureUnits).toBe(layout.figures[0].translatedCells); // page 4 belongs to Results (next anchor is on page 5)
    expect(r.units.some((u) => u.text.startsWith('Decedent'))).toBe(false);
    expect(r.units.some((u) => u.text === '3. Results')).toBe(true);
    expect(r.units.some((u) => u.text === '4. Discussion')).toBe(false);
    const methods = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'chapters', chapterIds: [chapterId('2. Methods')] }, opts);
    if (!methods.ok) throw new Error(methods.error);
    expect(methods.stats.tableCells).toBe(0);
    expect(methods.stats.figureUnits).toBe(0);
    expect(methods.units.some((u) => u.text === '2.1 Participants')).toBe(true);
  });

  it('the References chapter selects only its heading (reference entries are never units)', () => {
    const r = resolveTranslationScope(layout.translationBlocks, chapters, { mode: 'chapters', chapterIds: [chapterId('References')] }, opts);
    if (!r.ok) throw new Error(r.error);
    expect(r.units.map((u) => u.text)).toEqual(['References']);
    expect(layout.blocks.filter((b) => b.type === 'REFERENCE').every((b) => !b.translate)).toBe(true);
  });
});

describe('terminology helpers', () => {
  it('adds the title and abstract to the selected units in document order, once', () => {
    const { units } = handUnits();
    const title = unit([block({ id: 'p1-b000', page: 1, top: 780, text: 'A Title', type: 'TITLE' })]);
    const abstractHeading = unit([block({ id: 'p1-b000a', page: 1, top: 760, text: 'Abstract', type: 'HEADING' })]);
    const abstractBody = unit([block({ id: 'p1-b000b', page: 1, top: 740, text: 'We studied things.' })]);
    const all = [title, abstractHeading, abstractBody, ...units];
    expect(ids(terminologyContextUnits(all))).toEqual(['p1-b000', 'p1-b000a', 'p1-b000b']);
    const selected = all.filter((u) => u.page === 5);
    expect(ids(unitsInDocumentOrder(all, selected, terminologyContextUnits(all)))).toEqual(['p1-b000', 'p1-b000a', 'p1-b000b', 'p5-b001']);
    expect(ids(unitsInDocumentOrder(all, [title, ...selected], [title]))).toEqual(['p1-b000', 'p5-b001']);
  });
});
