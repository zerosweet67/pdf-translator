/**
 * The title of a two-column paper.
 *
 * Its first line runs the full width of the page and its second line stops
 * after a couple of words, so the column model files the first one as
 * SPANNING and the second one as LEFT. Grouping runs per region, so the two
 * lines can never land in one block, and two things then go wrong:
 *
 *   1. only BODY blocks were ever merged into one translation unit, so the
 *      model was asked to translate "…Warm-Up Protocols on" without its
 *      object and answered with an ellipsis, and "Dynamic Apnea" separately;
 *   2. a single-line block that fills the measure has its centre on the page
 *      centre, which the centring detector read as "this line is centred",
 *      so the translated title was drawn centred under a flush-left original.
 *
 * The coordinates are the ones of the real file.
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../layout';
import { analyzeCompleteness } from '../text';
import { isCenteredBlock } from '../render';
import { page as fixturePage } from '../../scope/__tests__/fixtures';
import type { PdfAnalysis, TextBlock, TextItemDebug } from '../types';

const VIEW = [0, 0, 595.22, 842];

function item(text: string, x: number, y: number, right: number, fs = 9, bold = false): TextItemDebug {
  return {
    page: 1,
    text,
    x,
    y,
    width: right - x,
    height: fs,
    fontSize: fs,
    fontName: bold ? 'g_bold' : 'g_reg',
    fontFamily: 'serif',
    fontRealName: bold ? 'TimesNewRomanPS-BoldMT' : 'TimesNewRomanPSMT',
    hasEOL: false,
    transform: [fs, 0, 0, fs, x, y],
  };
}

const TITLE_1 = 'Acute Cardiovascular and Metabolic Effects of Different Warm-Up Protocols on';
const TITLE_2 = 'Dynamic Apnea';

const ABSTRACT = [
  'The aim of this study was to evaluate the acute physiological',
  'response to different warm-up protocols on the dynamic apnea',
  'performance. The traditional approach, including a series of',
  'short-mid dives in water (WET warm-up), was compared to a',
  'more recent strategy, consisting in exercises performed outside',
  'the water (DRY warm-up). Nine athletes were tested in two',
];
const RIGHT = [
  'redistribution of blood flow from peripheral to cerebral and',
  'myocardial circulation, bradycardia and a reduced cardiac',
  'output (Gooden, 1994). Peripheral vasoconstriction causes',
  'an ischemia in muscles and skin, blood flow is directed',
  'mainly toward the brain and heart, while the rest of the',
  'organism receives a limited amount of blood, therefore',
];

/** `centred` moves the two title lines onto the page centre instead of the left margin. */
function titlePage(centred: boolean): PdfAnalysis {
  const items: TextItemDebug[] = [];
  const pageCentre = 595.22 / 2;
  const w1 = 481.8;
  const w2 = 96.1;
  const x1 = centred ? pageCentre - 380 / 2 : 56.7;
  const x2 = centred ? pageCentre - w2 / 2 : 56.7;
  items.push(item(TITLE_1, x1, 719.9, x1 + (centred ? 380 : w1), 13.98, true));
  items.push(item(TITLE_2, x2, 703.76, x2 + w2, 13.98, true));
  items.push(item('Luca Vitali, Milena Raffi and Alessandro Piras', 56.7, 674.42, 307.8, 10.98, true));
  items.push(item('Department of Biomedical and Neuromotor Sciences, University of Bologna, Italy', 56.7, 662.78, 391.8, 10.02));
  items.push(item('Abstract', 56.7, 616.7, 93.9, 10.02, true));
  ABSTRACT.forEach((t, i) => items.push(item(t, 56.7, 606.38 - i * 10.38, 290.6)));
  RIGHT.forEach((t, i) => items.push(item(t, 304.7, 606.38 - i * 10.38, 538.6)));
  return {
    fileName: 'title.pdf',
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

function layoutOf(centred: boolean) {
  const analysis = titlePage(centred);
  return { analysis, layout: analyzeLayout(analysis) };
}

function blockWith(blocks: readonly TextBlock[], needle: string): TextBlock {
  const found = blocks.find((b) => b.text.includes(needle));
  if (!found) throw new Error(`no block with "${needle}" in ${blocks.map((b) => b.text.slice(0, 30)).join(' | ')}`);
  return found;
}

describe('a title whose two lines fall into different column regions', () => {
  it('is one translation unit, with the whole sentence', () => {
    const { layout } = layoutOf(false);
    const unit = layout.translationBlocks.find((u) => u.text.includes('Acute Cardiovascular'));
    expect(unit, 'the title is translated').toBeDefined();
    expect(unit!.text).toBe(`${TITLE_1} ${TITLE_2}`);
    // A title carries no full stop, so it stays "incomplete" in the weak
    // sense; what matters is that it no longer breaks off after a preposition,
    // which is what made the model answer with an ellipsis.
    expect(analyzeCompleteness(unit!.text).strong, 'the title does not break off mid-phrase').toBe(false);
    // ...and the second line is not a unit of its own.
    expect(layout.translationBlocks.filter((u) => u.text.includes('Dynamic Apnea'))).toHaveLength(1);
  });

  it('keeps the title blocks apart from the authors and the abstract', () => {
    const { layout } = layoutOf(false);
    const unit = layout.translationBlocks.find((u) => u.text.includes('Acute Cardiovascular'))!;
    expect(unit.type).toBe('TITLE');
    expect(unit.text).not.toContain('Vitali');
    expect(unit.text).not.toContain('Abstract');
  });
});

describe('centring detection', () => {
  it('does not call a flush-left title centred just because it fills the measure', () => {
    const { analysis, layout } = layoutOf(false);
    const title = blockWith(layout.blocks, 'Acute Cardiovascular');
    expect(isCenteredBlock(title, analysis.pages[0], layout.blocks)).toBe(false);
  });

  it('still recognises a title that really is centred', () => {
    const { analysis, layout } = layoutOf(true);
    const title = blockWith(layout.blocks, 'Acute Cardiovascular');
    expect(isCenteredBlock(title, analysis.pages[0], layout.blocks)).toBe(true);
  });

  it('never centres body text', () => {
    const { analysis, layout } = layoutOf(false);
    const body = blockWith(layout.blocks, 'The aim of this study');
    expect(isCenteredBlock(body, analysis.pages[0], layout.blocks)).toBe(false);
  });
});
