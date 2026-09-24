/**
 * Partial-scope PDF output through the real pipeline in Node: a 3-page PDF
 * built with pdf-lib → PDF.js extraction → layout → scope "page 2 only" →
 * side-by-side render. The output keeps every page, the selected page gets
 * the Chinese overlay and the other pages stay English (never masked).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../../pdf/extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../../pdf/font';
import { analyzeLayout } from '../../pdf/layout';
import { assessOverlay, generateTranslatedPdf } from '../../pdf/render';
import type { TranslationEntry } from '../../pdf/types';
import { resolveTranslationScope } from '../scope';

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

const PARAGRAPHS: Record<number, string[]> = {
  1: [
    'The first page explains why bedbound status matters for older adults and',
    'how the national survey followed community-dwelling participants until death.',
    'Every interview recorded mobility, cognition and the living arrangements.',
  ],
  2: [
    'The second page describes the statistical methods used for the analysis.',
    'Weighted logistic regression models estimated the odds of being bedbound',
    'during the last year of life, adjusting for age, sex and dementia status.',
  ],
  3: [
    'The third page discusses the limitations of self-reported functional data',
    'and the implications for clinicians who plan care at the end of life.',
    'Future work should validate the measures against clinical records.',
  ],
};

async function buildSourcePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageNumber of [1, 2, 3]) {
    const page = doc.addPage([612, 792]);
    PARAGRAPHS[pageNumber].forEach((line, i) => page.drawText(line, { x: 60, y: 700 - i * 14, size: 11, font }));
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const out: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    }
  } finally {
    await pdf.destroy();
  }
  return out;
}

describe('partial scope PDF output', () => {
  it('35.–37. keeps every page, overlays only the selected units, leaves the rest English', async () => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;
    const source = await buildSourcePdf();
    const analysis = await extractPdf(source, 'scope-render.pdf');
    expect(analysis.pageCount).toBe(3);
    const layout = analyzeLayout(analysis);
    assessOverlay(layout, analysis);
    expect(layout.translationBlocks.length).toBeGreaterThanOrEqual(3);

    const scope = resolveTranslationScope(layout.translationBlocks, [], { mode: 'pages', startPage: 2, endPage: 2 }, { pageCount: 3 });
    if (!scope.ok) throw new Error(scope.error);
    expect(scope.units.every((u) => u.pages.includes(2))).toBe(true);
    expect(scope.units.length).toBeGreaterThanOrEqual(1);

    // Only the selected units are translated (as main.ts does); the rest never get an entry.
    const entries = new Map<string, TranslationEntry>();
    for (const u of scope.units) entries.set(u.id, { id: u.id, status: 'done', translation: '第二頁描述分析所用的統計方法，加權邏輯迴歸模型估計生命最後一年臥床的勝算比。', error: null });

    const fonts: FontSetBytes = {
      cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
      latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
      symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
      fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
      notes: [],
    };
    const result = await generateTranslatedPdf({
      pdfBytes: source,
      fileName: 'scope-render.pdf',
      analysis,
      layout,
      entries,
      mode: 'overlay',
      output: 'bilingual',
      pages: null,
      unitIds: new Set(scope.units.map((u) => u.id)),
      fonts,
    });

    // 35. full page count, one spread per original page
    expect(result.stats.pagesRendered).toBe(3);
    // 37. the selected units were written; 36. nothing outside the scope was touched (no report, no mask)
    expect(result.stats.unitsWritten).toBe(scope.units.length);
    expect(result.reports.every((r) => r.page === 2)).toBe(true);
    expect(result.reports.some((r) => r.skipped)).toBe(false);

    const texts = await pageTexts(result.bytes);
    expect(texts).toHaveLength(3);
    const cjk = /[一-鿿]/;
    // page 1 and 3 spreads: original English on both halves, no Chinese anywhere
    expect(texts[0]).toContain('bedbound status matters');
    expect(texts[0]).not.toMatch(cjk);
    expect(texts[2]).toContain('limitations of self-reported');
    expect(texts[2]).not.toMatch(cjk);
    // page 2 spread: the English original on the left, the Chinese overlay on the right
    expect(texts[1]).toContain('statistical methods');
    expect(texts[1]).toMatch(cjk);
  }, 60_000);
});
