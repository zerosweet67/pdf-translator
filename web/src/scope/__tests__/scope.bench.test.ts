/**
 * Translation scope benchmark / regression harness (not a unit test).
 *
 * Runs the real pipeline on a PDF (PDF.js extraction → layout → chapters →
 * scope → optional real translation through the Worker → pdf-lib overlay)
 * for several scopes and writes per-scope metrics: selected final logical
 * units (BODY / TABLE_CELL / FIGURE / CAPTION), duplicate source items,
 * boundary-expanded units, requests, *actual* provider usage per stage
 * (terminology / translation / QA), wall-clock, and the rendering checks
 * (full page count, only selected units overlaid).
 *
 * Skipped unless SCOPE_BENCH_PDF is set.
 *   SCOPE_BENCH_PDF      input PDF
 *   SCOPE_BENCH_OUT      output folder (default: the input's folder)
 *   SCOPE_BENCH_SCOPES   ';'-separated: "all" | "pages=3-12" | "chapter=<title substring>[,<title substring>]"
 *                        (default "all")
 *   SCOPE_BENCH_WORKER   Worker URL (e.g. http://127.0.0.1:8787); without it no API call is made
 *   SCOPE_BENCH_INVITE   invite code for the Worker
 *   SCOPE_BENCH_RENDER   "0" to skip the PDF export
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../../pdf/extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../../pdf/font';
import { analyzeLayout } from '../../pdf/layout';
import { assessOverlay, generateTranslatedPdf } from '../../pdf/render';
import type { TranslationEntry } from '../../pdf/types';
import { TranslationCache } from '../../translate/cache';
import { TranslateClient } from '../../translate/client';
import { clearTerminologyCache, translateDocument } from '../../translate/pipeline';
import { documentFingerprint } from '../../translate/terminology';
import { JobUsage } from '../../translate/usage';
import { chapterPageLabel, detectChapters } from '../chapters';
import { resolveTranslationScope, terminologyContextUnits, unitsInDocumentOrder, type TranslationScope } from '../scope';
import { fakeTranslate } from '../../pdf/__tests__/fake-translate';

declare const process: { env: Record<string, string | undefined> };

const INPUT = process.env.SCOPE_BENCH_PDF;

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

describe.skipIf(!INPUT)('translation scope benchmark', () => {
  it('resolves every requested scope, translates it (real Worker when configured) and renders the full PDF', async () => {
    const input = INPUT as string;
    const outDir = process.env.SCOPE_BENCH_OUT ?? input.replace(/[\\/][^\\/]+$/, '');
    mkdirSync(outDir, { recursive: true });
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;

    const buf = readFileSync(input);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const t0 = performance.now();
    const analysis = await extractPdf(bytes, 'bench.pdf');
    const layout = analyzeLayout(analysis);
    assessOverlay(layout, analysis);
    const analysisMs = Math.round(performance.now() - t0);
    const detection = detectChapters(analysis, layout);
    const all = layout.translationBlocks;
    const documentKey = documentFingerprint(all);
    expect(layout.stats.duplicateSourceItems).toBe(0);

    const workerUrl = process.env.SCOPE_BENCH_WORKER;
    let client: TranslateClient | null = null;
    if (workerUrl) {
      let token: string | null = null;
      const c = new TranslateClient(workerUrl, 180_000, { getToken: () => token });
      const invite = await c.verifyInvite(process.env.SCOPE_BENCH_INVITE ?? '');
      if (!invite.ok) throw new Error(`invite rejected: ${invite.reason}`);
      token = invite.token;
      client = c;
    }

    const fonts: FontSetBytes | null =
      process.env.SCOPE_BENCH_RENDER === '0'
        ? null
        : {
            cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
            latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
            symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
            fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
            notes: [],
          };

    const specs = (process.env.SCOPE_BENCH_SCOPES ?? 'all').split(';').map((s) => s.trim()).filter(Boolean);
    const scopes: { label: string; scope: TranslationScope }[] = [];
    for (const spec of specs) {
      if (spec === 'all') scopes.push({ label: 'all', scope: { mode: 'all' } });
      else if (spec.startsWith('pages=')) {
        const [s, e] = spec.slice(6).split('-').map(Number);
        scopes.push({ label: spec, scope: { mode: 'pages', startPage: s, endPage: e } });
      } else if (spec.startsWith('chapter=')) {
        const ids = spec
          .slice(8)
          .split(',')
          .map((needle) => {
            const c = detection.chapters.find((x) => x.title.toLowerCase().includes(needle.trim().toLowerCase()));
            if (!c) throw new Error(`no chapter matching "${needle}" among: ${detection.chapters.map((x) => x.title).join(' | ')}`);
            return c.id;
          });
        scopes.push({ label: spec, scope: { mode: 'chapters', chapterIds: ids } });
      } else throw new Error(`unknown scope spec "${spec}"`);
    }

    const metrics: Record<string, unknown> = {
      input,
      pages: analysis.pageCount,
      analysisMs,
      logicalUnits: all.length,
      layoutStats: layout.stats,
      chapterSource: detection.source,
      chapters: detection.chapters.map((c) => ({ id: c.id, level: c.level, title: c.title, pages: chapterPageLabel(c), startY: c.startY, endY: c.endY })),
      chapterWarnings: detection.warnings,
      worker: workerUrl ?? null,
      runs: {} as Record<string, unknown>,
    };
    const allTableUnits = new Set(all.filter((u) => u.type === 'TABLE').map((u) => u.id));
    const allFigureUnits = new Set(all.filter((u) => u.type === 'FIGURE').map((u) => u.id));
    const blockById = new Map(layout.blocks.map((b) => [b.id, b]));

    for (const { label, scope } of scopes) {
      const started = performance.now();
      const r = resolveTranslationScope(all, detection.chapters, scope, { pageCount: analysis.pageCount, blocks: layout.blocks, pages: analysis.pages });
      if (!r.ok) throw new Error(`${label}: ${r.error}`);
      const selected = new Set(r.units.map((u) => u.id));
      // §48 regressions: ownership, subset of the whole-document cells, figure text never back in the paragraph pipeline
      expect(r.stats.duplicateSourceItems).toBe(0);
      for (const u of r.units) {
        if (u.type === 'TABLE') expect(allTableUnits.has(u.id)).toBe(true);
        if (u.type === 'FIGURE') expect(allFigureUnits.has(u.id)).toBe(true);
        if (u.type === 'FOOTNOTE' || u.type === 'BODY') for (const id of u.sourceBlockIds) expect(blockById.get(id)?.cell).toBeUndefined();
      }

      // translation: real Worker (actual usage) or deterministic fake (no API)
      const entries = new Map<string, TranslationEntry>();
      const usage = new JobUsage();
      let translation: Record<string, unknown> = { mode: 'fake' };
      if (client) {
        clearTerminologyCache(); // each run is its own job (fresh caches), like a fresh page session
        const cache = new TranslationCache();
        const result = await translateDocument(r.units, entries, {
          client,
          cache,
          targetLanguage: 'zh-TW',
          documentOrder: all,
          documentBlocks: unitsInDocumentOrder(all, r.units, terminologyContextUnits(all)),
          terminologyDocumentKey: documentKey,
          terminologyCacheKey: `${documentKey}|${r.fingerprint}`,
        });
        usage.add('terminology', result.terminology.usage, result.terminology.durationMs);
        usage.add('translation', result.translation.usage, result.translation.durationMs);
        usage.add('qa', result.qa.usage, result.qa.durationMs);
        const s = result.translation;
        translation = {
          mode: 'worker',
          terminologyRequests: result.terminology.requests,
          terminologySamples: result.terminology.samples,
          terminologySampleChars: result.terminology.sampleChars,
          autoTerms: result.terminology.autoTerms,
          translationRequests: s.requests,
          providerCalls: s.providerCalls,
          retryRequests: s.retryRequests,
          translatedBlocks: s.translatedBlocks,
          cachedBlocks: s.cachedBlocks,
          skippedBlocks: s.skippedBlocks,
          failedBlocks: s.failedBlocks,
          inputChars: s.inputChars,
          contextChars: s.contextChars,
          qaRequests: result.qa.requests,
          qaBlocksSent: result.qa.blocksSent,
          qaCorrected: result.qa.correctedBlocks,
          hardRisk: result.highRiskBlocks,
          warnings: result.warnings,
          usage: usage.snapshot(),
        };
        // §39: the Worker only ever saw selected units
        for (const id of entries.keys()) expect(selected.has(id)).toBe(true);
      } else {
        for (const u of r.units) entries.set(u.id, { id: u.id, status: 'done', translation: fakeTranslate(u.text), error: null });
      }

      let render: Record<string, unknown> = { skipped: true };
      if (fonts) {
        const out = await generateTranslatedPdf({
          pdfBytes: bytes,
          fileName: 'bench.pdf',
          analysis,
          layout,
          entries,
          mode: 'overlay',
          output: 'bilingual',
          pages: null,
          unitIds: selected,
          fonts,
        });
        const file = `${outDir}/scope-${label.replace(/[^a-z0-9]+/gi, '_')}.pdf`;
        writeFileSync(file, out.bytes);
        // §32–34: every page kept, nothing outside the scope touched or masked
        expect(out.stats.pagesRendered).toBe(analysis.pageCount);
        for (const rep of out.reports) expect(selected.has(rep.unitId)).toBe(true);
        render = {
          file,
          pagesRendered: out.stats.pagesRendered,
          unitsWritten: out.stats.unitsWritten,
          unitsSkipped: out.stats.unitsSkipped,
          tableCellsWritten: out.stats.tableCellsWritten,
          tableCellsOverflow: out.stats.tableCellsOverflow,
          figureCellsWritten: out.stats.figureCellsWritten,
          figureCellsOverflow: out.stats.figureCellsOverflow,
          reportsOutsideScope: out.reports.filter((rep) => !selected.has(rep.unitId)).length,
          warnings: out.reports.filter((rep) => rep.warning).length,
          reports: out.reports.map((rep) => ({
            unitId: rep.unitId,
            type: rep.type,
            role: rep.role,
            fontSize: rep.fontSize,
            finalFontSize: rep.finalFontSize,
            lines: rep.lines,
            indent: rep.typography?.firstLineIndent,
            bold: rep.typography?.bold,
            extent: rep.extent,
            reason: rep.reason,
            message: rep.message,
          })),
        };
      }

      (metrics.runs as Record<string, unknown>)[label] = {
        scope,
        units: r.units.map((u) => ({
          id: u.id,
          type: u.type,
          blockType: u.blockType,
          role: u.role,
          pages: u.pages,
          wasMerged: u.wasMerged,
          incompleteSource: u.incompleteSource,
          contextReason: u.contextReason,
          previousContext: u.previousContext,
          nextContext: u.nextContext,
          source: u.text,
          translation: entries.get(u.id)?.translation ?? null,
          status: entries.get(u.id)?.status ?? null,
        })),
        fingerprint: r.fingerprint,
        stats: r.stats,
        boundaryExpandedIds: [...r.boundaryExpandedIds],
        translation,
        render,
        wallClockMs: Math.round(performance.now() - started),
      };
      console.log(`[scope bench] ${label}: ${r.stats.selectedUnits}/${r.stats.totalUnits} units, ${r.stats.selectedChars} chars, ${Math.round(performance.now() - started)} ms`);
    }
    writeFileSync(`${outDir}/scope-metrics.json`, JSON.stringify(metrics, null, 2));
  }, 1_800_000);
});
