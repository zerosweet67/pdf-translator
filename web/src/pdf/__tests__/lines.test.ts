/**
 * Line building (layout.ts step 1): which text items end up on one line.
 *
 * The fixtures reproduce real geometries from the corpus, in particular the
 * author-biography page of a two-column paper, where a heading in the *left*
 * column sits vertically between two baselines of the *right* column and used
 * to chain them into a single line.
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../layout';
import { page as fixturePage } from '../../scope/__tests__/fixtures';
import type { PdfAnalysis, TextBlock, TextItemDebug } from '../types';

const CHAR = 0.5;

interface ItemOptions {
  fs?: number;
  page?: number;
  bold?: boolean;
  width?: number;
}

function item(text: string, x: number, y: number, o: ItemOptions = {}): TextItemDebug {
  const fs = o.fs ?? 10;
  return {
    page: o.page ?? 1,
    text,
    x,
    y,
    width: o.width ?? text.length * CHAR * fs,
    height: fs,
    fontSize: fs,
    fontName: o.bold ? 'g_bold' : 'g_reg',
    fontFamily: 'serif',
    fontRealName: o.bold ? 'TimesNewRomanPS-BoldMT' : 'TimesNewRomanPSMT',
    hasEOL: false,
    transform: [fs, 0, 0, fs, x, y],
  };
}

function analysisOf(items: TextItemDebug[]): PdfAnalysis {
  const last = Math.max(...items.map((i) => i.page));
  return {
    fileName: 'lines.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: last,
    pages: Array.from({ length: last }, (_, i) => fixturePage(i + 1, { textItemCount: items.filter((x) => x.page === i + 1).length })),
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
  };
}

function blocksOf(items: TextItemDebug[]): TextBlock[] {
  return analyzeLayout(analysisOf(items), { resolveTables: false, resolveFigures: false, detectLayoutRoles: false }).blocks;
}

/** Every line of every block, in reading order. */
function lineTexts(blocks: readonly TextBlock[]): string[] {
  return blocks.flatMap((b) => b.lines.map((l) => l.text));
}

// ---------------------------------------------------------------------------
// The author-biography page: exact geometry of the real PDF (page 10)
// ---------------------------------------------------------------------------

/**
 * Right column (x = 388.1, 9 pt), justified, one item per word on the wrapped
 * line; left column (x = 62.3) carries an 11 pt heading whose baseline
 * (515.2) falls between the right column's 520.3 and 509.9.
 */
function biographyPage(): TextItemDebug[] {
  const left: TextItemDebug[] = [];
  const LEFT_LINES = [
    'Within the design of the current study, we acknowledge the following',
    'limitations. Capillary blood was collected from the fingertip and the',
    'analysis of hemoglobin is extensively utilized in the field, although',
    'end-tidal gas parameters were not measured in the present protocol.',
    'The following points summarise what the two warm-up protocols did',
    'and did not change in the cardiovascular response of the athletes.',
  ];
  LEFT_LINES.forEach((t, i) => left.push(item(t, 56.7, 620 - i * 11.5, { fs: 10.02, width: 234 })));
  left.push(item('Key points', 62.3, 515.2, { fs: 10.98, bold: true, width: 50.4 }));

  const right: TextItemDebug[] = [
    item('Ph.D.', 388.1, 551.3, { fs: 9, width: 20.5 }),
    item('Research interests', 388.1, 540.8, { fs: 9, bold: true, width: 70.2 }),
    item('Motor control, postural control, visual', 388.1, 530.6, { fs: 9, width: 145.2 }),
    item('perception,', 388.1, 520.3, { fs: 9, width: 40.2 }),
    item('attention,', 433.8, 520.3, { fs: 9, width: 33.8 }),
    item('optic', 473.1, 520.3, { fs: 9, width: 18.0 }),
    item('flow,', 496.6, 520.3, { fs: 9, width: 18.7 }),
    item('eye', 520.8, 520.3, { fs: 9, width: 12.5 }),
    item('movements, electrophysiology, muscle', 388.1, 509.9, { fs: 9, width: 145.1 }),
    item('physiology.', 388.1, 499.6, { fs: 9, width: 42.3 }),
    item('E-mail:', 388.1, 489.2, { fs: 9, bold: true, width: 29.0 }),
    item('milena.raffi@unibo.it', 419.5, 489.2, { fs: 9, width: 78.2 }),
  ];
  return [...left, ...right];
}

describe('baseline clustering', () => {
  it('does not chain two baselines of one column through a heading in the other', () => {
    const lines = lineTexts(blocksOf(biographyPage()));
    expect(lines).toContain('perception, attention, optic flow, eye');
    expect(lines).toContain('movements, electrophysiology, muscle');
    expect(lines).toContain('Key points');
    for (const l of lines) expect(l).not.toMatch(/perception,\s*movements/);
  });

  it('keeps the words of the wrapped column in reading order', () => {
    const blocks = blocksOf(biographyPage());
    const bio = blocks.find((b) => b.text.includes('perception'))!;
    const order = ['Motor control', 'perception,', 'attention,', 'optic flow, eye', 'movements,', 'electrophysiology', 'physiology.'];
    let at = -1;
    for (const needle of order) {
      const next = bio.text.indexOf(needle, at + 1);
      expect(next, `${needle} in ${JSON.stringify(bio.text)}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('still joins a raised citation marker to the line it belongs to', () => {
    const items = [
      item('among family caregivers of people with dementia', 56.7, 600, { fs: 10, width: 220 }),
      item('62', 279, 603.6, { fs: 7, width: 7 }), // superscript: smaller and raised
      item('and the effect persisted after adjustment for age.', 56.7, 587, { fs: 10, width: 220 }),
    ];
    const lines = lineTexts(blocksOf(items));
    expect(lines[0]).toBe('among family caregivers of people with dementia 62');
    expect(lines[1]).toBe('and the effect persisted after adjustment for age.');
  });

  it('keeps far apart items of one baseline in separate lines (table row, running header)', () => {
    const items = [
      item('Vitali et al.', 56.7, 797.3, { fs: 7.98, width: 35.7 }),
      item('303', 524.3, 797.4, { fs: 7.98, width: 12 }),
      item('Baseline', 70.9, 601.7, { fs: 9, width: 32 }),
      item('129.37 ± 4.9', 119.9, 601.9, { fs: 9, width: 46 }),
      item('84.42 ± 3.4', 214.4, 601.9, { fs: 9, width: 41 }),
    ];
    const lines = lineTexts(blocksOf(items));
    expect(lines).toContain('Vitali et al.');
    expect(lines).toContain('303');
    expect(lines).toContain('Baseline');
    expect(lines).toContain('129.37 ± 4.9');
    expect(lines).toContain('84.42 ± 3.4');
  });

  it('joins a raised citation run of several characters to its line', () => {
    const items = [
      item('the effect was replicated in three independent cohorts', 56.7, 600, { fs: 10, width: 230 }),
      item('16,27-29', 288, 603.6, { fs: 7, width: 22 }),
      item('and remained after adjustment.', 56.7, 587, { fs: 10, width: 130 }),
    ];
    const lines = lineTexts(blocksOf(items));
    expect(lines[0]).toBe('the effect was replicated in three independent cohorts 16,27-29');
  });

  it('keeps a smaller footnote line below a paragraph out of it', () => {
    const items = [
      item('The primary outcome was assessed by two blinded raters.', 56.7, 600, { fs: 10, width: 230 }),
      item('a Adjusted for age, sex and baseline severity of disease.', 56.7, 586, { fs: 8, width: 190 }),
    ];
    const lines = lineTexts(blocksOf(items));
    expect(lines).toContain('The primary outcome was assessed by two blinded raters.');
    expect(lines).toContain('a Adjusted for age, sex and baseline severity of disease.');
  });

  it('does not let a large font pull in the next line of a tight column', () => {
    // 9 pt column, 10.4 pt pitch, with a 14 pt word on the first line.
    const items = [
      item('Results', 56.7, 600, { fs: 14, bold: true, width: 45 }),
      item('of the second experiment', 105, 600, { fs: 9, width: 95 }),
      item('are reported in the following paragraph.', 56.7, 589.6, { fs: 9, width: 150 }),
    ];
    const lines = lineTexts(blocksOf(items));
    expect(lines[0]).toBe('Results of the second experiment');
    expect(lines[1]).toBe('are reported in the following paragraph.');
  });
});
