/**
 * Layout-role benchmark / visual regression harness (not a unit test).
 *
 * Runs the real pipeline (PDF.js extraction → layout → pdf-lib overlay) on a
 * PDF with deterministic fake translations (no API call) twice — with the
 * layout role detectors off ("before") and on ("after") — and writes:
 *   <out>/roles-before.pdf, <out>/roles-after.pdf
 *   <out>/roles-after-debug.pdf   (bounding boxes incl. containers / regions)
 *   <out>/roles-metrics.json
 *
 * Metrics per variant: structured labels, sidebar containers, children,
 * overlapping units (drawn extent reaching into another block), overflow
 * warnings, white-patch risk (lines masked in white over a coloured fill),
 * container / tinted masks, duplicate source items, contrast shortfall.
 *
 * Skipped unless LAYOUT_ROLES_BENCH_PDF is set; LAYOUT_ROLES_BENCH_OUT is the
 * output folder (default: the input's folder), LAYOUT_ROLES_BENCH_PAGES an
 * optional comma-separated page list.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { extractPdf } from '../extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../font';
import { analyzeLayout } from '../layout';
import { assessOverlay, generateTranslatedPdf, type BlockRenderReport } from '../render';
import { roleOf } from '../roles';
import type { LayoutResult, PdfAnalysis, TranslationEntry } from '../types';
import { fakeTranslate } from './fake-translate';

declare const process: { env: Record<string, string | undefined> };

const INPUT = process.env.LAYOUT_ROLES_BENCH_PDF;

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Written units whose drawn text reaches into the box of another block on the same page. */
function overlapCount(layout: LayoutResult, reports: readonly BlockRenderReport[], pages: ReadonlySet<number>): number {
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  let n = 0;
  for (const r of reports) {
    if (r.skipped || !r.extent || !pages.has(r.page)) continue;
    const first = blockById.get(r.sourceBlockIds[0]);
    if (!first) continue;
    const drawn: Box = { x: first.x, y: r.extent.bottom, width: first.width, height: r.extent.top - r.extent.bottom };
    const own = new Set(r.sourceBlockIds);
    // The run-in label of this paragraph shares its first line by design.
    if (first.labelBlockId) own.add(first.labelBlockId);
    if (first.labelFor) own.add(first.labelFor);
    for (const b of layout.blocks) {
      if (b.page !== first.page || own.has(b.id)) continue;
      if (intersects(drawn, { x: b.x, y: b.y, width: b.width, height: b.height })) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Lines that would be masked in white although they sit on a coloured fill. */
function whitePatchRisk(layout: LayoutResult, analysis: PdfAnalysis, reports: readonly BlockRenderReport[], assumeWhite: boolean): number {
  const pageById = new Map(analysis.pages.map((p) => [p.pageNumber, p]));
  const blockById = new Map(layout.blocks.map((b) => [b.id, b]));
  let n = 0;
  for (const r of reports) {
    if (r.skipped) continue;
    const white = assumeWhite || !r.background || r.background.source === 'white' || r.background.color === null;
    if (!white) continue;
    for (const id of r.sourceBlockIds) {
      const b = blockById.get(id);
      const page = b ? pageById.get(b.page) : undefined;
      if (!b || !page || b.cell) continue;
      const tinted = page.fills.some(
        (f) =>
          f.color !== null && f.color !== '#ffffff' && f.width * f.height >= 2400 &&
          f.x <= b.x + 0.5 && f.x + f.width >= b.x + b.width - 0.5 && f.y <= b.y + 0.5 && f.y + f.height >= b.top - 0.5,
      );
      if (tinted) n += b.lineCount;
    }
  }
  return n;
}

describe.skipIf(!INPUT)('layout roles benchmark', () => {
  it('renders before / after PDFs and writes metrics', async () => {
    const input = INPUT as string;
    const outDir = process.env.LAYOUT_ROLES_BENCH_OUT ?? input.replace(/[\\/][^\\/]+$/, '');
    mkdirSync(outDir, { recursive: true });
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;

    const buf = readFileSync(input);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const analysis = await extractPdf(bytes, 'bench.pdf');
    const pageFilter = process.env.LAYOUT_ROLES_BENCH_PAGES ? new Set(process.env.LAYOUT_ROLES_BENCH_PAGES.split(',').map(Number)) : null;
    const renderedPages = pageFilter ?? new Set(analysis.pages.map((p) => p.pageNumber));

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
      const layout = analyzeLayout(analysis, { detectLayoutRoles: on });
      assessOverlay(layout, analysis);
      const entries = new Map<string, TranslationEntry>();
      for (const unit of layout.translationBlocks) {
        entries.set(unit.id, { id: unit.id, status: 'done', translation: fakeTranslate(unit.text), error: null });
      }
      const common = { pdfBytes: bytes, fileName: 'bench.pdf', analysis, layout, entries, output: 'translated' as const, pages: pageFilter, fonts };
      const result = await generateTranslatedPdf({ ...common, mode: 'overlay' });
      writeFileSync(`${outDir}/roles-${variant}.pdf`, result.bytes);
      if (on) {
        const debug = await generateTranslatedPdf({ ...common, mode: 'debug', debugRoles: true });
        writeFileSync(`${outDir}/roles-after-debug.pdf`, debug.bytes);
      }
      const reports = result.reports.filter((r) => renderedPages.has(r.page));
      writeFileSync(
        `${outDir}/roles-${variant}-warnings.json`,
        JSON.stringify(
          reports
            .filter((r) => r.warning || r.skipped)
            .map((r) => ({ unitId: r.unitId, role: r.role, type: r.type, reason: r.reason, message: r.message, fontSize: r.fontSize, finalFontSize: r.finalFontSize, extent: r.extent })),
          null,
          2,
        ),
      );
      const pageBlocks = layout.blocks.filter((b) => renderedPages.has(b.page));
      metrics[variant] = {
        structuredRegions: layout.structuredRegions.filter((r) => renderedPages.has(r.page)).length,
        structuredLabels: pageBlocks.filter((b) => roleOf(b) === 'STRUCTURED_LABEL').length,
        sidebars: layout.containers.filter((c) => renderedPages.has(c.page)).length,
        sidebarChildren: layout.containers.filter((c) => renderedPages.has(c.page)).reduce((n, c) => n + c.children.length, 0),
        sidebarRoles: {
          heading: pageBlocks.filter((b) => roleOf(b) === 'SIDEBAR_HEADING').length,
          label: pageBlocks.filter((b) => roleOf(b) === 'SIDEBAR_LABEL').length,
          body: pageBlocks.filter((b) => roleOf(b) === 'SIDEBAR_BODY').length,
        },
        unitsWritten: reports.filter((r) => !r.skipped).length,
        overlap: overlapCount(layout, reports, renderedPages),
        overflow: reports.filter((r) => r.reason === 'TEXT_OVERFLOW').length,
        // "before" had white-only masks for paragraphs: every masked line on a coloured fill was a white patch.
        whitePatches: whitePatchRisk(layout, analysis, reports, !on),
        backgroundMismatch: reports.filter((r) => r.background && r.background.source === 'white' && !r.skipped).length === 0 ? 0 : whitePatchRisk(layout, analysis, reports, false),
        containerMasks: result.stats.layoutRoles.containerMasks,
        tintedMasks: result.stats.layoutRoles.tintedMasks,
        lightTextUnits: result.stats.layoutRoles.lightTextUnits,
        inlineLabels: result.stats.layoutRoles.inlineLabels,
        ownLineLabels: result.stats.layoutRoles.ownLineLabels,
        contrastShortfall: result.stats.layoutRoles.contrastShortfall,
        duplicateSourceItems: layout.stats.duplicateSourceItems,
        warnings: result.warnings.filter((w) => renderedPages.has(w.page)).length,
        bodyUnits: reports.filter((r) => r.role === 'BODY' && !r.skipped).length,
        bodyOverflow: reports.filter((r) => r.role === 'BODY' && r.reason === 'TEXT_OVERFLOW').length,
      };
    }
    writeFileSync(`${outDir}/roles-metrics.json`, JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics, null, 2));
    expect((metrics.after as { duplicateSourceItems: number }).duplicateSourceItems).toBe(0);
  }, 300_000);
});
