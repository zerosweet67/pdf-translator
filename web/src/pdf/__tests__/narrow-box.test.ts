/**
 * Narrow boxes: the author-biography column of a two-column paper.
 *
 * The column is 145 pt wide and justified, which produces three problems the
 * wide-column rules never meet:
 *
 *   1. a label block ("Luca VITALI Employment") is raised above the body size
 *      and then wraps inside a 54 pt box, one character per line, over the
 *      text under it;
 *   2. a 20 pt wide paragraph ("Ph.D.") gets the 2 em first-line indent of a
 *      body paragraph, which leaves 2 pt of usable width, so the fit breaks
 *      the word into "P" / "h.D.";
 *   3. the wide word gaps of the justified column leave a single word
 *      ("diving") in a block of its own, which the orphan pass then appends to
 *      the end of the paragraph — the word jumps to the end of the sentence.
 *
 * The coordinates are the ones the real file uses.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { beforeAll, describe, expect, it } from 'vitest';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../font';
import { analyzeLayout } from '../layout';
import { planOrphanMerges } from '../paragraph';
import { assessOverlay, generateTranslatedPdf, type BlockRenderReport } from '../render';
import { TYPOGRAPHY, typographyFor } from '../typography';
import { page as fixturePage } from '../../scope/__tests__/fixtures';
import type { LayoutResult, PdfAnalysis, TextBlock, TextItemDebug, TranslationEntry } from '../types';

const VIEW = [0, 0, 595.22, 842];
const BODY = 9;

// ---------------------------------------------------------------------------
// 1 + 2: the typography rules on their own
// ---------------------------------------------------------------------------

function spec(o: { type: 'BODY' | 'HEADING'; role?: 'STRUCTURED_LABEL' | 'SIDEBAR_LABEL'; width: number; size?: number }) {
  return typographyFor({
    type: o.type,
    role: o.role,
    sourceFontSize: o.size ?? BODY,
    bodyFontSize: BODY,
    blockHeight: 9.4,
    blockWidth: o.width,
  });
}

describe('first-line indent in a narrow box', () => {
  it('is dropped when the box is too narrow to keep a usable first line', () => {
    // "Ph.D." sits in a 20.5 pt box: 2 em of indent would leave 2.5 pt.
    expect(spec({ type: 'BODY', width: 20.5 }).firstLineIndent).toBe(0);
  });

  it('is kept in full in a normal column', () => {
    const wide = spec({ type: 'BODY', width: 234 });
    expect(wide.firstLineIndent).toBeCloseTo(TYPOGRAPHY.body.firstLineIndentEm * BODY, 5);
  });

  it('is reduced, not dropped, in a column that is merely tight', () => {
    const indent = spec({ type: 'BODY', width: 50 }).firstLineIndent;
    expect(indent).toBeGreaterThan(0);
    expect(indent).toBeLessThan(TYPOGRAPHY.body.firstLineIndentEm * BODY);
  });

  it('is decided by the width in em, not by a fixed number of points', () => {
    // The same 60 pt box is roomy for 6 pt text and tight for 12 pt text.
    const small = spec({ type: 'BODY', width: 60, size: 6 });
    const large = spec({ type: 'BODY', width: 60, size: 12 });
    expect(small.firstLineIndent).toBeCloseTo(TYPOGRAPHY.body.firstLineIndentEm * 6, 5);
    expect(large.firstLineIndent).toBeLessThan(TYPOGRAPHY.body.firstLineIndentEm * 12);
  });
});

describe('label in a narrow box', () => {
  it('is not raised above the source size', () => {
    const narrow = spec({ type: 'HEADING', role: 'STRUCTURED_LABEL', width: 53.8 });
    expect(narrow.fontSize).toBe(BODY);
    expect(narrow.boosted).toBe(false);
  });

  it('may shrink to the body size and keeps its weight', () => {
    const narrow = spec({ type: 'HEADING', role: 'STRUCTURED_LABEL', width: 53.8 });
    expect(narrow.minFontSize).toBeLessThanOrEqual(BODY);
    expect(narrow.bold).toBe(true);
  });

  it('leaves a wide label exactly as it was', () => {
    const wide = spec({ type: 'HEADING', role: 'STRUCTURED_LABEL', width: 234 });
    const before = typographyFor({ type: 'HEADING', role: 'STRUCTURED_LABEL', sourceFontSize: BODY, bodyFontSize: BODY, blockHeight: 9.4 });
    expect(wide.fontSize).toBe(before.fontSize);
    expect(wide.minFontSize).toBe(before.minFontSize);
    expect(wide.fontSize).toBeGreaterThan(BODY);
  });
});

// ---------------------------------------------------------------------------
// 3: the orphan pass
// ---------------------------------------------------------------------------

let counter = 0;
/** One TextLine, so the same-line rules in paragraph.ts have something to read. */
function line(text: string, x: number, y: number, width: number) {
  return { page: 10, text, x, y, width, height: 9, fontSize: 9, fontName: 'f1', fontRealName: null, column: 'RIGHT' as const, items: [] };
}

function block(o: Partial<TextBlock> & { text: string; x: number; y: number; width: number }): TextBlock {
  const height = o.height ?? 9.4;
  return {
    id: o.id ?? `b${String(++counter).padStart(3, '0')}`,
    page: 10,
    type: o.type ?? 'BODY',
    sectionType: 'SUPPLEMENTAL',
    blockType: 'SUPPLEMENTAL_BODY',
    text: o.text,
    x: o.x,
    y: o.y,
    width: o.width,
    height,
    top: o.y + height,
    fontSize: 9,
    fontName: 'f1',
    fontRealName: 'TimesNewRomanPSMT',
    column: 'RIGHT',
    lineCount: o.lineCount ?? 1,
    lines: o.lines ?? [line(o.text, o.x, o.y + 2.3, o.width)],
    order: counter,
    translate: true,
    skipReason: null,
  };
}

describe('a word left alone by a justified narrow column', () => {
  /** The real geometry: "diving" sits on the second line of the paragraph, not after it. */
  function biography(): TextBlock[] {
    counter = 0;
    return [
      block({
        id: 'b034',
        text: 'Sport sciences, exercise physiology, breath-hold',
        x: 388.1,
        y: 642.7,
        width: 145.2,
        height: 19.8,
        lineCount: 2,
        lines: [line('Sport sciences, exercise physiology,', 388.1, 655.28, 145.2), line('breath-hold', 388.1, 644.96, 41.5)],
      }),
      block({
        id: 'b035',
        text: 'physiology, therapeutic exercise E-mail: luca.vitali5@studio.unibo.it',
        x: 388.1,
        y: 622.0,
        width: 145.0,
        height: 30.1,
        lineCount: 3,
        lines: [line('physiology,', 491.0, 644.96, 42.2), line('therapeutic exercise', 388.1, 634.58, 71.8), line('E-mail: luca.vitali5@studio.unibo.it', 388.1, 624.26, 131.8)],
      }),
      block({ id: 'b036', text: 'diving', x: 448.8, y: 642.7, width: 23.0, lines: [line('diving', 448.8, 644.96, 23.0)] }),
    ];
  }

  it('is given to the line it continues, not to the end of the paragraph', () => {
    const plan = planOrphanMerges(biography());
    const merge = plan.merges.find((m) => m.fragmentId === 'b036');
    expect(merge?.ownerId, 'the word follows "…breath-hold", which is the last line of b034').toBe('b034');
  });

  it('still absorbs a real sentence tail under its paragraph', () => {
    counter = 0;
    const blocks = [
      block({ id: 'a1', text: '• DRY warm-up seems to induce a more pronounced diving', x: 63.4, y: 464.8, width: 221.5, lines: [line('• DRY warm-up seems to induce a more pronounced diving', 63.4, 467.1, 221.5)] }),
      block({ id: 'a2', text: 'response', x: 70.6, y: 452.9, width: 31.5, lines: [line('response', 70.6, 455.2, 31.5)] }),
    ];
    const plan = planOrphanMerges(blocks);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]).toMatchObject({ fragmentId: 'a2', ownerId: 'a1' });
  });
});

// ---------------------------------------------------------------------------
// End to end: the column through layout and the renderer
// ---------------------------------------------------------------------------

function item(text: string, x: number, y: number, right: number, bold = false): TextItemDebug {
  return {
    page: 1,
    text,
    x,
    y,
    width: right - x,
    height: 9,
    fontSize: 9,
    fontName: bold ? 'g_bold' : 'g_reg',
    fontFamily: 'serif',
    fontRealName: bold ? 'TimesNewRomanPS-BoldMT' : 'TimesNewRomanPSMT',
    hasEOL: false,
    transform: [9, 0, 0, 9, x, y],
  };
}

/** The bio column of the real page, item for item, plus a left column so the page is two-column. */
function bioItems(): TextItemDebug[] {
  const left: TextItemDebug[] = [];
  const lines = [
    'Westerhof, B. E., Gisolf, J., Karemaker, J. M., Wesseling, K. H.,',
    'Secher, N. H. and van Lieshout, J. J. (2006) Time course analysis',
    'of baroreflex sensitivity during postural stress. American Journal',
    'of Physiology Heart and Circulatory Physiology 291, 2864-2874.',
    'Whitehead, R. D., Mei, Z., Mapango, C. and Jefferds, M. E. D.',
    '(2019) Methods and analyzers for hemoglobin measurement in',
  ];
  lines.forEach((t, i) => left.push(item(t, 56.7, 748 - i * 10.4, 290.6)));
  return [
    ...left,
    item('Luca VITALI', 388.1, 748.28, 441.9, true),
    item('Employment', 388.1, 737.9, 437.7, true),
    item('Department', 388.1, 727.76, 430.7),
    item('of', 436.8, 727.76, 444.3),
    item('Quality', 450.4, 727.76, 477.4),
    item('Life', 483.4, 727.76, 498.4),
    item('Studies,', 504.5, 727.76, 533.3),
    item('University of Bologna, Italy.', 388.1, 717.38, 491.9),
    item('Degree', 388.1, 706.88, 415.2, true),
    item('Ph.D.', 388.1, 696.68, 408.6),
    item('Research interests', 388.1, 665.48, 458.4, true),
    item('Sport', 388.1, 655.28, 407.7),
    item('sciences,', 414.9, 655.28, 447.1),
    item('exercise', 454.4, 655.28, 483.8),
    item('physiology,', 491.1, 655.28, 533.3),
    item('breath-hold', 388.1, 644.96, 429.6),
    item('diving', 448.8, 644.96, 471.8),
    item('physiology,', 491.0, 644.96, 533.2),
    item('therapeutic exercise', 388.1, 634.58, 459.9),
  ];
}

function analysisOf(items: TextItemDebug[]): PdfAnalysis {
  return {
    fileName: 'narrow-box.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: 1,
    pages: [fixturePage(1, { width: 595.22, height: 842, view: VIEW, textItemCount: items.length })],
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
  };
}

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

const TRANSLATIONS: Record<string, string> = {
  'Ph.D.': '博士',
  Degree: '學位',
  'Research interests': '研究興趣',
  'Luca VITALI Employment': 'Luca VITALI 任職',
  diving: '潛水',
};

let rendered: { layout: LayoutResult; reports: BlockRenderReport[] };

beforeAll(async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;
  const doc = await PDFDocument.create();
  doc.addPage([595.22, 842]);
  const saved = await doc.save();
  const pdfBytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;

  const analysis = analysisOf(bioItems());
  const layout = analyzeLayout(analysis);
  assessOverlay(layout, analysis);
  const entries = new Map<string, TranslationEntry>();
  for (const unit of layout.translationBlocks) {
    const key = unit.text.trim();
    entries.set(unit.id, { id: unit.id, status: 'done', translation: TRANSLATIONS[key] ?? `${key.slice(0, 8)}的中文翻譯內容`, error: null });
  }
  const fonts: FontSetBytes = {
    cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
    latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
    symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
    fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
    notes: [],
  };
  const result = await generateTranslatedPdf({
    pdfBytes,
    fileName: 'narrow-box.pdf',
    analysis,
    layout,
    entries,
    mode: 'overlay',
    output: 'translated',
    pages: null,
    fonts,
  });
  rendered = { layout, reports: result.reports };
}, 120000);

function blockOf(text: string): TextBlock {
  const found = rendered.layout.blocks.find((b) => b.text.trim() === text);
  if (!found) throw new Error(`no block "${text}" in ${rendered.layout.blocks.map((b) => b.text.slice(0, 24)).join(' | ')}`);
  return found;
}

function reportOf(block: TextBlock): BlockRenderReport {
  const found = rendered.reports.find((r) => r.sourceBlockIds.includes(block.id));
  if (!found) throw new Error(`no report for ${block.id}`);
  return found;
}

describe('the biography column through the renderer', () => {
  it('keeps "Ph.D." on one line', () => {
    const report = reportOf(blockOf('Ph.D.'));
    expect(report.typography?.firstLineIndent).toBe(0);
    expect(report.lines).toBe(1);
  });

  it('reads "breath-hold diving physiology" in that order, and never ends a unit with the word', () => {
    const diving = blockOf('diving');
    const unit = rendered.layout.translationBlocks.find((u) => u.sourceBlockIds.includes(diving.id) || u.orphanFragmentIds?.includes(diving.id));
    expect(unit, 'the word belongs to a unit').toBeDefined();
    expect(unit!.text).toContain('breath-hold diving');
    for (const other of rendered.layout.translationBlocks) expect(other.text.trim().endsWith('diving'), other.text).toBe(false);
  });

  it('does not draw the name label over the text under it', () => {
    const label = blockOf('Luca VITALI Employment');
    const extent = reportOf(label).extent;
    const below = rendered.layout.blocks
      .filter((b) => b.id !== label.id && b.x < label.x + label.width && label.x < b.x + b.width && b.y + b.height / 2 < label.y + label.height / 2)
      .sort((a, b) => b.top - a.top)[0];
    expect(extent!.bottom, `label ink ${extent!.bottom} vs ${below.id} top ${below.top}`).toBeGreaterThanOrEqual(below.top - 0.5);
  });

  it('keeps the label bold and no smaller than the body text', () => {
    const report = reportOf(blockOf('Luca VITALI Employment'));
    expect(report.typography?.bold).toBe(true);
    expect(report.finalFontSize).toBeGreaterThanOrEqual(BODY - 0.01);
  });
});
