/**
 * Export page selection through the real renderer: a 20-page PDF built with
 * pdf-lib → PDF.js extraction → layout → scope → side-by-side export.
 * Verifies the page count of the downloaded file for every mode, that a
 * chapter boundary in the middle of a page keeps that page whole, and that
 * the Chinese overlay only ever lands on the selected units.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdf } from '../../pdf/extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../../pdf/font';
import { analyzeLayout } from '../../pdf/layout';
import { assessOverlay, generateTranslatedPdf } from '../../pdf/render';
import type { LayoutResult, PdfAnalysis, TranslationEntry } from '../../pdf/types';
import type { ChapterInfo } from '../chapters';
import { resolveOutputPages, withOutputSuffix } from '../output';
import { resolveTranslationScope, type TranslationScope } from '../scope';

const PAGE_COUNT = 20;
const TRANSLATION = '這一頁的內容已翻譯成中文，用來確認輸出範圍是否正確。';

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

/** Three paragraphs per page, each a full sentence so the layout keeps them apart. */
async function buildSourcePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= PAGE_COUNT; page++) {
    const p = doc.addPage([612, 792]);
    const lines = [
      `Page ${page} opens with a paragraph about the cohort and how the data were collected.`,
      `Participants on page ${page} were interviewed twice and their answers were recorded.`,
      '',
      `The second paragraph of page ${page} reports the adjusted estimates for this section.`,
      'Confidence intervals were computed with the usual robust standard errors.',
      '',
      `A third paragraph on page ${page} closes the section with a short interpretation.`,
      'No adjustment for multiplicity was applied to any of these comparisons.',
    ];
    lines.forEach((line, i) => {
      if (line) p.drawText(line, { x: 60, y: 700 - i * 30, size: 11, font });
    });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Methods starts halfway down page 5 and ends halfway down page 8, so the
 * export must keep pages 5 and 8 complete rather than cutting them.
 */
const CHAPTERS: ChapterInfo[] = [
  { id: 'c1', title: 'Introduction', level: 1, startPage: 1, startY: 780, endPage: 5, endY: 520, source: 'outline' },
  { id: 'c2', title: 'Methods', level: 1, startPage: 5, startY: 520, endPage: 8, endY: 520, source: 'outline' },
  { id: 'c3', title: 'Results', level: 1, startPage: 8, startY: 520, endPage: 20, source: 'outline' },
];

let source: ArrayBuffer;
let analysis: PdfAnalysis;
let layout: LayoutResult;
let fonts: FontSetBytes;

beforeAll(async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;
  source = await buildSourcePdf();
  analysis = await extractPdf(source, 'output-range.pdf');
  layout = analyzeLayout(analysis);
  assessOverlay(layout, analysis);
  fonts = {
    cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
    latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
    symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
    fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
    notes: [],
  };
}, 180_000);

/** What main.ts does for one run: resolve the scope, resolve the export pages, render. */
async function exportScope(scope: TranslationScope, keepFullDocument = false) {
  const r = resolveTranslationScope(layout.translationBlocks, CHAPTERS, scope, {
    pageCount: analysis.pageCount,
    blocks: layout.blocks,
    pages: analysis.pages,
  });
  if (!r.ok) throw new Error(r.error);
  const output = resolveOutputPages(scope, CHAPTERS, analysis.pageCount, { keepFullDocument });
  const entries = new Map<string, TranslationEntry>();
  for (const u of r.units) entries.set(u.id, { id: u.id, status: 'done', translation: TRANSLATION, error: null });
  const result = await generateTranslatedPdf({
    pdfBytes: source,
    fileName: 'output-range.pdf',
    analysis,
    layout,
    entries,
    mode: 'overlay',
    output: 'bilingual',
    pages: output.pages ? new Set(output.pages) : null,
    unitIds: new Set(r.units.map((u) => u.id)),
    fonts,
  });
  return { resolution: r, output, result, fileName: withOutputSuffix(result.fileName, output.fileSuffix) };
}

describe('exported page count per scope', () => {
  it('the fixture has 20 pages with translatable text on each', () => {
    expect(analysis.pageCount).toBe(PAGE_COUNT);
    const pages = new Set(layout.translationBlocks.flatMap((u) => u.pages));
    expect(pages.size).toBe(PAGE_COUNT);
  });

  it('all → every page', async () => {
    const { result, output, fileName } = await exportScope({ mode: 'all' });
    expect(result.stats.pagesRendered).toBe(PAGE_COUNT);
    expect(output.label).toBe('全部 20 頁');
    expect(fileName).toBe('output-range_bilingual_zh-TW.pdf');
  }, 180_000);

  it('pages p17 → 1 page', async () => {
    const { result, output, resolution, fileName } = await exportScope({ mode: 'pages', startPage: 17, endPage: 17 });
    expect(result.stats.pagesRendered).toBe(1);
    expect(output.pages).toEqual([17]);
    expect(output.label).toBe('第 17 頁');
    expect(fileName).toBe('output-range_bilingual_zh-TW_p17.pdf');
    // every written unit belongs to the scope, and the scope is page 17
    expect(resolution.units.every((u) => u.pages.includes(17))).toBe(true);
    expect(result.reports.every((r) => r.page === 17)).toBe(true);
    expect(result.stats.unitsWritten).toBe(resolution.units.length);
  }, 180_000);

  it('pages p17–20 → 4 pages', async () => {
    const { result, output, fileName } = await exportScope({ mode: 'pages', startPage: 17, endPage: 20 });
    expect(result.stats.pagesRendered).toBe(4);
    expect(output.pages).toEqual([17, 18, 19, 20]);
    expect(fileName).toBe('output-range_bilingual_zh-TW_p17-20.pdf');
  }, 180_000);

  it('chapter Methods (mid-page start and end) → pages 5–8 kept whole', async () => {
    const { result, output, resolution, fileName } = await exportScope({ mode: 'chapters', chapterIds: ['c2'] });
    expect(output.pages).toEqual([5, 6, 7, 8]);
    expect(result.stats.pagesRendered).toBe(4);
    expect(output.label).toBe('第 5–8 頁');
    expect(fileName).toBe('output-range_bilingual_zh-TW_Methods_p5-8.pdf');
    // the chapter starts below the top of page 5, so page 5 is exported whole but only its lower half is translated
    const written = new Set(result.reports.filter((r) => !r.skipped).map((r) => r.page));
    expect([...written].every((p) => p >= 5 && p <= 8)).toBe(true);
    const selected = new Set(resolution.units.map((u) => u.id));
    expect(result.reports.every((r) => selected.has(r.unitId))).toBe(true);
  }, 180_000);

  it('保留完整 PDF → the original page count, overlay still only on the scope', async () => {
    const { result, output, resolution, fileName } = await exportScope({ mode: 'pages', startPage: 17, endPage: 17 }, true);
    expect(result.stats.pagesRendered).toBe(PAGE_COUNT);
    expect(output.pages).toBeNull();
    expect(output.label).toBe('全部 20 頁');
    expect(fileName).toBe('output-range_bilingual_zh-TW.pdf');
    expect(result.reports.every((r) => r.page === 17)).toBe(true);
    expect(result.stats.unitsWritten).toBe(resolution.units.length);
  }, 180_000);
});
