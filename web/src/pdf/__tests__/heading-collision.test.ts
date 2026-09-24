/**
 * A heading must not be drawn over the paragraph that follows it.
 *
 * Journals set a section heading at the body size, in bold, on a single line,
 * and start the next paragraph on the very next baseline. The translated
 * heading is raised to 1.2 x the body size and slides down by its space
 * before, so it needs about twice the height of its own box — and the ~1 pt
 * that separates the box from the next one is all the room there is.
 *
 * The page is built with pdf-lib and goes through the real pipeline
 * (extract -> layout -> render), so the assertions are about the ink the
 * renderer actually put on the page, taken from its own reports.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdf } from '../extract';
import { trueTypeSubsetSafe, type FontRole, type FontSetBytes, type LoadedFont } from '../font';
import { analyzeLayout } from '../layout';
import { assessOverlay, generateTranslatedPdf, type BlockRenderReport } from '../render';
import type { LayoutResult, TextBlock, TranslationEntry } from '../types';

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

const BODY_SIZE = 10;
/** Baseline pitch of the column: the box of a line is ~10.5 pt tall, so ~1 pt separates two blocks. */
const PITCH = 11.5;
const TIGHT_HEADING = 'Data Analysis';
/** A heading with a whole empty line under it: the control case. */
const LOOSE_HEADING = 'Statistical Methods';

const PARAGRAPH = [
  'The dynamic apnea started five minutes after the end of the warm-up with',
  'three minutes of countdown, as applied during the official competitions,',
  'and the athletes were free to choose their own preparation routine.',
];
const AFTER_TIGHT = [
  'Heart rate variability was recorded with a finger cuff device at baseline',
  'and after the apnea, and the beat-to-beat series was resampled at 4 Hz',
  'before the spectral indices were computed over the whole recording.',
];
const AFTER_LOOSE = [
  'Repeated measures analysis of variance compared the two conditions and',
  'the post-hoc comparisons were corrected for the number of the tests.',
];

/** One column of body lines with two bold headings in it, at a constant pitch. */
async function buildSourcePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([612, 792]);
  let y = 700;
  const line = (text: string, isHeading = false) => {
    page.drawText(text, { x: 60, y, size: BODY_SIZE, font: isHeading ? bold : regular });
    y -= PITCH;
  };
  PARAGRAPH.forEach((t) => line(t));
  line(TIGHT_HEADING, true); // next paragraph starts on the very next baseline
  AFTER_TIGHT.forEach((t) => line(t));
  y -= PITCH; // a blank line before the loose heading, and one after it
  line(LOOSE_HEADING, true);
  y -= PITCH;
  AFTER_LOOSE.forEach((t) => line(t));
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const TRANSLATIONS: Record<string, string> = {
  [TIGHT_HEADING]: '資料分析',
  [LOOSE_HEADING]: '統計方法',
};

interface Rendered {
  layout: LayoutResult;
  reports: BlockRenderReport[];
  blocks: TextBlock[];
}

let rendered: Rendered;

beforeAll(async () => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs').href;
  const source = await buildSourcePdf();
  const analysis = await extractPdf(source, 'heading-collision.pdf');
  // The layout-role detectors are off: a bold line over a paragraph is also
  // the shape of a structured-abstract label, and this fixture is about the
  // plain HEADING role (which is what the real section headings carry).
  const layout = analyzeLayout(analysis, { detectLayoutRoles: false });
  assessOverlay(layout, analysis);

  const entries = new Map<string, TranslationEntry>();
  for (const unit of layout.translationBlocks) {
    const text = unit.text.trim();
    const translation = TRANSLATIONS[text] ?? '受試者在熱身結束五分鐘後開始動態閉氣，並以三分鐘倒數計時，與正式比賽的流程相同。';
    entries.set(unit.id, { id: unit.id, status: 'done', translation, error: null });
  }
  const fonts: FontSetBytes = {
    cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
    latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
    symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
    fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
    notes: [],
  };
  const result = await generateTranslatedPdf({
    pdfBytes: source,
    fileName: 'heading-collision.pdf',
    analysis,
    layout,
    entries,
    mode: 'overlay',
    output: 'translated',
    pages: null,
    fonts,
  });
  rendered = { layout, reports: result.reports, blocks: layout.blocks };
}, 120000);

function headingBlock(text: string): TextBlock {
  const block = rendered.blocks.find((b) => b.text.trim() === text);
  if (!block) throw new Error(`no block for ${text}; blocks: ${rendered.blocks.map((b) => b.text.slice(0, 30)).join(' | ')}`);
  return block;
}

function reportOf(block: TextBlock): BlockRenderReport {
  const report = rendered.reports.find((r) => r.sourceBlockIds.includes(block.id));
  if (!report) throw new Error(`no report for ${block.id}`);
  return report;
}

/** The block drawn right below `block` in the same column. */
function blockBelow(block: TextBlock): TextBlock {
  const below = rendered.blocks
    .filter((b) => b.page === block.page && b.id !== block.id && b.top <= block.y + 0.5 && b.x < block.x + block.width && block.x < b.x + b.width)
    .sort((a, b) => b.top - a.top);
  if (!below[0]) throw new Error(`nothing below ${block.id}`);
  return below[0];
}

describe('heading that has no room under it', () => {
  it('is set as a heading at all', () => {
    const heading = headingBlock(TIGHT_HEADING);
    expect(heading.type).toBe('HEADING');
    // The paragraph below starts on the next baseline: ~1 pt of air, no more.
    expect(heading.y - blockBelow(heading).top).toBeLessThan(2);
  });

  it('does not draw its text over the paragraph below it', () => {
    const heading = headingBlock(TIGHT_HEADING);
    const next = blockBelow(heading);
    const extent = reportOf(heading).extent;
    expect(extent, 'the heading was laid out through the paragraph path').toBeDefined();
    expect(extent!.bottom, `heading ink reaches ${extent!.bottom}, the next block starts at ${next.top}`).toBeGreaterThanOrEqual(next.top - 0.5);
  });

  it('keeps a visible difference to the body text', () => {
    const report = reportOf(headingBlock(TIGHT_HEADING));
    expect(report.finalFontSize).toBeGreaterThanOrEqual(rendered.layout.bodyFontSize);
    expect(report.typography?.bold).toBe(true);
  });

  it('does not report an overflow for a short heading', () => {
    expect(reportOf(headingBlock(TIGHT_HEADING)).reason).toBeNull();
  });
});

describe('heading that has room under it', () => {
  it('keeps the full size boost', () => {
    const report = reportOf(headingBlock(LOOSE_HEADING));
    expect(report.finalFontSize).toBeGreaterThan(rendered.layout.bodyFontSize);
    expect(report.reason).toBeNull();
  });

  it('still does not reach the paragraph below', () => {
    const heading = headingBlock(LOOSE_HEADING);
    const extent = reportOf(heading).extent;
    expect(extent!.bottom).toBeGreaterThanOrEqual(blockBelow(heading).top - 0.5);
  });
});

describe('body paragraphs', () => {
  it('are not moved or resized by the heading rules', () => {
    for (const report of rendered.reports) {
      if (report.type !== 'BODY') continue;
      expect(report.finalFontSize, `${report.unitId}`).toBeLessThanOrEqual(BODY_SIZE + 0.01);
    }
  });
});
