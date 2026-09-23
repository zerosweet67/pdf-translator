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
import { isCjkChar } from '../fit';
import type { TranslationBlock, TranslationEntry } from '../types';

declare const process: { env: Record<string, string | undefined> };

const INPUT = process.env.TABLE_BENCH_PDF;

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

const POOL = '研究結果顯示患者臥床狀態生命最後年期間社區居住老年人特徵比較分析平均標準差性別女男種族教育收入婚姻失智症衰弱慢病症狀焦慮憂鬱日常活動功能限制疼痛聽力視力自評健康觀察數加權缺失差異值計';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic pseudo-translation: numbers / symbols / abbreviations stay, words become CJK of realistic length. */
export function fakeTranslate(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    const keep = /^[\d(),.%±<>=≤≥/:;\[\]\-–—*†‡§¶]+[a-z]?$/i.test(tok) || /^[A-Z][A-Z0-9]{1,5}[,)]?$/.test(tok) || /^\(?[np]\s*=/.test(tok);
    if (keep) {
      out.push(tok);
      continue;
    }
    const letters = tok.replace(/[^A-Za-z]/g, '').length;
    const n = Math.max(1, Math.ceil(letters * 0.55));
    let s = '';
    const h = hash(tok);
    for (let i = 0; i < n; i++) s += POOL[(h + i * 7 + n) % POOL.length];
    if (/,$/.test(tok)) s += '，';
    else if (/[.;:]$/.test(tok)) s += '。';
    const m = /(\([^()]*\))$/.exec(tok);
    if (m && !s.endsWith(m[1])) s += m[1];
    out.push(s);
  }
  // CJK runs join without spaces; keep a space next to Latin / numeric tokens.
  let result = '';
  for (const t of out) {
    if (result && !(isCjkChar(result[result.length - 1]) && isCjkChar(t[0]))) result += ' ';
    result += t;
  }
  return result;
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
      const layout = analyzeLayout(analysis, { resolveTables: variant === 'after' });
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
      metrics[variant] = {
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
                .filter((b) => b.cell)
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
