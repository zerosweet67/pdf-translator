/**
 * Table benchmark / visual regression harness (not a unit test).
 *
 * Runs the real pipeline (PDF.js extraction → layout → pdf-lib overlay) on a
 * PDF with deterministic fake translations (no API call) and writes:
 *   <out>/after.pdf   – logical table cells (this version)
 *   <out>/before.pdf  – the previous paragraph-style table blocks
 *   <out>/after-debug.pdf – bounding boxes incl. table cells
 *   <out>/metrics.json
 *
 * Skipped unless TABLE_BENCH_PDF (input file) is set; TABLE_BENCH_OUT is the
 * output folder (default: the input's folder), TABLE_BENCH_PAGES an optional
 * comma-separated page list.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../font';
import { analyzeLayout } from '../layout';
import { assessOverlay, generateTranslatedPdf } from '../render';
import { estimateTokens } from '../../translate/batch';
import { fakeTranslate } from './fake-translate';
import type { TextBlock, TranslationBlock, TranslationEntry } from '../types';

declare const process: { env: Record<string, string | undefined> };

const INPUT = process.env.TABLE_BENCH_PDF;

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

describe.skipIf(!INPUT)('table benchmark', () => {
  it('renders before / after PDFs and writes metrics', async () => {
    const input = INPUT as string;
    const outDir = process.env.TABLE_BENCH_OUT ?? input.replace(/[\\/][^\\/]+$/, '');
    mkdirSync(outDir, { recursive: true });
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;

    const buf = readFileSync(input);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const analysis = await extractPdf(bytes, 'bench.pdf');
    const pageFilter = process.env.TABLE_BENCH_PAGES ? new Set(process.env.TABLE_BENCH_PAGES.split(',').map(Number)) : null;

    const fonts: FontSetBytes = {
      cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
      latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
      symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
      fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
      notes: [],
    };

    const metrics: Record<string, unknown> = {};
    for (const variant of ['before', 'after'] as const) {
      const on = variant === 'after';
      const layout = analyzeLayout(analysis, { resolveTables: on, resolveFigures: on });
      assessOverlay(layout, analysis);
      const entries = new Map<string, TranslationEntry>();
      const tableUnits: TranslationBlock[] = [];
      for (const unit of layout.translationBlocks) {
        entries.set(unit.id, { id: unit.id, status: 'done', translation: fakeTranslate(unit.text), error: null });
        if (unit.type === 'TABLE') tableUnits.push(unit);
      }
      const result = await generateTranslatedPdf({
        pdfBytes: bytes,
        fileName: 'bench.pdf',
        analysis,
        layout,
        entries,
        mode: 'overlay',
        output: 'translated',
        pages: pageFilter,
        fonts,
      });
      writeFileSync(`${outDir}/${variant}.pdf`, result.bytes);
      if (variant === 'after') {
        const debug = await generateTranslatedPdf({
          pdfBytes: bytes,
          fileName: 'bench.pdf',
          analysis,
          layout,
          entries,
          mode: 'debug',
          output: 'translated',
          pages: pageFilter,
          fonts,
        });
        writeFileSync(`${outDir}/after-debug.pdf`, debug.bytes);
      }
      const tableBlocks = layout.blocks.filter((b) => b.type === 'TABLE');
      const overflowReports = result.reports.filter((r) => r.reason === 'TABLE_CELL_OVERFLOW');
      const tableWarnings = result.warnings.filter((w) => w.type === 'TABLE');

      // --- figures ---------------------------------------------------------
      const renderedPages = pageFilter ?? new Set(analysis.pages.map((p) => p.pageNumber));
      const figureBlocks = layout.blocks.filter((b) => (on ? b.type === 'FIGURE' : false) && renderedPages.has(b.page));
      const figureOverflow = result.reports.filter((r) => r.reason === 'FIGURE_CELL_OVERFLOW');
      const figureUnits = layout.translationBlocks.filter((u) => u.type === 'FIGURE' && renderedPages.has(u.page));
      const countItems = (list: readonly TextBlock[]) =>
        list.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.items.length, 0), 0);
      // Before: the same source text, as the paragraph pipeline grouped it.
      const figureRegionPages = new Set(layout.figures.map((f) => f.page));
      const beforeFigureLike = layout.blocks.filter(
        (b) => !on && renderedPages.has(b.page) && b.type !== 'HEADER' && b.type !== 'FOOTER' && b.cell === undefined,
      );
      let figureInputTokens = 0;
      let figureOutputTokens = 0;
      for (const u of figureUnits) {
        figureInputTokens += estimateTokens(u.text) + 12;
        figureOutputTokens += estimateTokens(entries.get(u.id)?.translation ?? '') + 12;
      }
      const figures = {
        detected: layout.figures.filter((f) => renderedPages.has(f.page)).length,
        summaries: layout.figures.filter((f) => renderedPages.has(f.page)),
        textItems: on ? countItems(figureBlocks) : countItems(beforeFigureLike),
        logicalUnits: figureBlocks.length,
        translatedUnits: figureUnits.length,
        numericSkipped: figureBlocks.filter((b) => b.cell?.numeric).length,
        untranslatableSkipped: figureBlocks.filter((b) => !b.translate && !b.cell?.numeric).length,
        written: result.stats.figureCellsWritten,
        fallbackEnglish: figureOverflow.length,
        fallbackDetails: figureOverflow.map((r) => ({ id: r.unitId, page: r.page, cell: r.cell, message: r.message })),
        estimatedInputTokens: figureInputTokens,
        estimatedOutputTokens: figureOutputTokens,
        onDarkBackground: figureBlocks.filter((b) => b.cell?.textOnDark).length,
        withBackgroundColour: figureBlocks.filter((b) => b.cell?.background).length,
        regionPages: [...figureRegionPages],
      };
      metrics[variant] = {
        duplicateSourceItems: layout.stats.duplicateSourceItems,
        figures,
        tableLayoutBlocks: tableBlocks.length,
        tableTranslationUnits: tableUnits.length,
        tableApiBlocks: tableUnits.filter((u) => entries.get(u.id)?.status === 'done').length,
        tableUnitsWritten: result.reports.filter((r) => r.type === 'TABLE' && !r.skipped).length,
        tableUnitsSkipped: result.reports.filter((r) => r.type === 'TABLE' && r.skipped).length,
        tableTextOverflowWarnings: tableWarnings.filter((w) => w.reason === 'TEXT_OVERFLOW').length,
        tableCellOverflow: overflowReports.length,
        tableCellOverflowDetails: overflowReports.map((r) => ({ id: r.unitId, page: r.page, cell: r.cell, message: r.message })),
        stats: result.stats,
        layoutStats: layout.stats,
        tables: layout.tables,
        cells:
          variant === 'after'
            ? layout.blocks
                .filter((b) => b.cell && renderedPages.has(b.page))
                .map((b) => ({
                  id: b.id,
                  page: b.page,
                  text: b.text,
                  translate: b.translate,
                  skip: b.skipReason,
                  cell: b.cell,
                  translation: entries.get(b.id)?.translation ?? null,
                }))
            : undefined,
      };
    }
    writeFileSync(`${outDir}/metrics.json`, JSON.stringify(metrics, null, 2));
    expect(metrics.after).toBeDefined();
  }, 300_000);
});
