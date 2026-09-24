/**
 * Subscripts, end to end: detection on the line, placement in the
 * translation, wrapping and the size a lowered run is drawn at.
 *
 * The shapes a paper actually uses are covered — a statistic (np2, F1,16), a
 * chemical formula (H2O, CO2) and a clinical index (FEV1) — and they all go
 * through the same generic code: nothing here knows what a formula is, only
 * that a small run sits below its line's baseline and what text it follows.
 *
 * The run recovery that puts these items back in the first place (PDF.js
 * merges a subscript into its neighbour) is tested in textruns.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { collectBlockSubscripts, isSubscriptItem, lineSubscripts } from '../superscript';
import { buildInlineSegments, splitScriptSegments } from '../inline';
import { measureSegments, tokenizeInline, wrapTokens, type TextMeasurer } from '../fit';
import { superscriptSize } from '../typography';
import type { TextBlock, TextItemDebug, TextLine } from '../types';

function item(text: string, x: number, y: number, fontSize: number): TextItemDebug {
  return {
    page: 1,
    text,
    x,
    y,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    fontSize,
    fontName: 'f1',
    fontFamily: 'serif',
    fontRealName: null,
    hasEOL: false,
    transform: [fontSize, 0, 0, fontSize, x, y],
  };
}

function line(items: TextItemDebug[], fontSize = 10, y = 700): TextLine {
  return {
    page: 1,
    text: items.map((i) => i.text).join(''),
    x: items[0]?.x ?? 0,
    y,
    width: 200,
    height: fontSize,
    fontSize,
    fontName: 'f1',
    fontRealName: null,
    column: 'LEFT',
    items,
  };
}

function block(lines: TextLine[]): TextBlock {
  return {
    id: 'p1-b001',
    page: 1,
    type: 'BODY',
    sectionType: 'MAIN',
    blockType: 'BODY',
    text: lines.map((l) => l.text).join(' '),
    x: 0,
    y: 690,
    width: 200,
    height: 20,
    top: 710,
    fontSize: 10,
    fontName: 'f1',
    fontRealName: null,
    column: 'LEFT',
    lineCount: lines.length,
    lines,
    order: 0,
    translate: true,
    skipReason: null,
  };
}

/** CJK 1 em, Latin 0.5 em, spaces 0.25 em. */
const fakeFont: TextMeasurer = {
  widthOfTextAtSize(text: string, size: number): number {
    let em = 0;
    for (const ch of text) {
      if (ch === ' ') em += 0.25;
      else if (/[⺀-鿿豈-﫿︰-﹏＀-￯]/.test(ch)) em += 1;
      else em += 0.5;
    }
    return em * size;
  },
};

/** Raised runs as the source reports them, with no identifier in front. */
const marks = (...texts: string[]) => texts.map((text) => ({ text, anchor: '' }));

describe('isSubscriptItem', () => {
  it('statistics: the p of partial eta squared is lowered', () => {
    // The real coordinates of the ERS paper: "np2 = 0.38" is set as n + p + 2,
    // the p 1.02 pt below the 10.02 pt line, the 2 above it.
    const p = item('p', 309.78, 659.78, 6.48);
    const two = item('2 ', 313.02, 664.28, 6.48);
    const l = line([item('n', 304.74, 660.8, 10.02), p, two, item('= 0.38; F', 317.94, 660.8, 10.02)], 10.02, 660.8);
    expect(isSubscriptItem(p, l)).toBe(true);
    expect(isSubscriptItem(two, l)).toBe(false);
  });

  it('statistics: the index of an F ratio is lowered', () => {
    const index = item('1,16', 354.6, 659.78, 6.48);
    const l = line([item('F', 350, 660.8, 10.02), index, item(' = 6.75', 367.6, 660.8, 10.02)], 10.02, 660.8);
    expect(isSubscriptItem(index, l)).toBe(true);
  });

  it('chemistry: the 2 of H2O is lowered', () => {
    const two = item('2', 66, 698.9, 6.5);
    const l = line([item('H', 60, 700, 10), two, item('O', 70, 700, 10)], 10, 700);
    expect(isSubscriptItem(two, l)).toBe(true);
  });

  it('mathematics: a raised exponent is not a subscript', () => {
    const exponent = item('2', 66, 703.5, 6.5);
    const l = line([item('x', 60, 700, 10), exponent, item(' + 1', 70, 700, 10)], 10, 700);
    expect(isSubscriptItem(exponent, l)).toBe(false);
  });

  it('leaves a run that sits on the baseline alone, however small the print', () => {
    const small = item('12', 80, 700, 7);
    const l = line([item('Note ', 60, 700, 10), small], 10, 700);
    expect(isSubscriptItem(small, l)).toBe(false);
  });

  it('leaves a lowered run that is set at the line size alone (a dropped line, not a script)', () => {
    const big = item('16', 80, 698.5, 10);
    const l = line([item('page ', 60, 700, 10), big], 10, 700);
    expect(isSubscriptItem(big, l)).toBe(false);
  });

  it('never flags the only item of a line', () => {
    const only = item('2', 60, 698.9, 6.5);
    expect(isSubscriptItem(only, line([only], 10, 700))).toBe(false);
  });

  it('takes an index, not a word: a lowered caption stays text', () => {
    const word = item('baseline', 66, 698.9, 6.5);
    const l = line([item('V', 60, 700, 10), word], 10, 700);
    expect(isSubscriptItem(word, l)).toBe(false);
  });
});

describe('lineSubscripts', () => {
  it('keeps the text each lowered run follows', () => {
    const l = line(
      [
        item('n', 60, 700, 10),
        item('p', 66, 698.9, 6.5),
        item('2 ', 70, 703.5, 6.5),
        item('= 0.38 for H', 75, 700, 10),
        item('2', 135, 698.9, 6.5),
        item('O', 140, 700, 10),
      ],
      10,
      700,
    );
    expect(lineSubscripts(l)).toEqual([
      { text: 'p', anchor: 'n' },
      { text: '2', anchor: 'H' },
    ]);
  });

  it('keeps only the identifier in front of the run, never the punctuation', () => {
    // The line reads "; p = 0.003; np2": the anchor of the lowered p is "n",
    // the one thing the translation is sure to keep.
    const l = line([item('; p = 0.003; n', 60, 700, 10), item('p', 130, 698.9, 6.5), item('2 ', 135, 703.5, 6.5)], 10, 700);
    expect(lineSubscripts(l)).toEqual([{ text: 'p', anchor: 'n' }]);
  });

  it('drops a lowered run with nothing to hang off', () => {
    // A run that opens the line, or follows a space, cannot be placed in the
    // translation without guessing, so it is not reported at all.
    const opens = line([item('2', 60, 698.9, 6.5), item('H', 66, 700, 10)], 10, 700);
    expect(lineSubscripts(opens)).toEqual([]);
    const afterSpace = line([item('value ', 60, 700, 10), item('2', 95, 698.9, 6.5), item('x', 100, 700, 10)], 10, 700);
    expect(lineSubscripts(afterSpace)).toEqual([]);
  });
});

describe('collectBlockSubscripts', () => {
  it('returns one entry per lowered run, repeats included', () => {
    const b = block([
      line([item('F', 60, 700, 10), item('1,16', 66, 698.9, 6.5), item(' = 6.75 and F', 90, 700, 10), item('1,16', 160, 698.9, 6.5)], 10, 700),
      line([item('for H', 60, 688, 10), item('2', 85, 686.9, 6.5), item('O', 90, 688, 10)], 10, 688),
    ]);
    expect(collectBlockSubscripts(b).map((r) => r.text)).toEqual(['1,16', '1,16', '2']);
  });

  it('is empty for a block without any lowered run', () => {
    expect(collectBlockSubscripts(block([line([item('plain ', 60, 700, 10), item('text', 90, 700, 10)], 10, 700)]))).toEqual([]);
  });
});

describe('splitScriptSegments', () => {
  it('statistics: lowers the p of np2 and raises its 2, in the same word', () => {
    const out = splitScriptSegments('交互作用效果（np2 = 0.18）', marks('2'), [{ text: 'p', anchor: 'n' }]);
    expect(out.map((s) => s.text).join('')).toBe('交互作用效果（np2 = 0.18）');
    expect(out.filter((s) => s.sub).map((s) => s.text)).toEqual(['p']);
    expect(out.filter((s) => s.sup).map((s) => s.text)).toEqual(['2']);
  });

  it('statistics: lowers every repeated np2 of one paragraph', () => {
    const text = 'np2 = 0.44；np2 = 0.37；np2 = 0.39';
    const runs = [
      { text: 'p', anchor: 'n' },
      { text: 'p', anchor: 'n' },
      { text: 'p', anchor: 'n' },
    ];
    const out = splitScriptSegments(text, marks('2', '2', '2'), runs);
    expect(out.map((s) => s.text).join('')).toBe(text);
    expect(out.filter((s) => s.sub)).toHaveLength(3);
    expect(out.filter((s) => s.sup)).toHaveLength(3);
  });

  it('statistics: lowers the index of an F ratio', () => {
    const out = splitScriptSegments('組間差異顯著（F1,16 = 6.75）', [], [{ text: '1,16', anchor: 'F' }]);
    expect(out).toEqual([
      { text: '組間差異顯著（F', sup: false },
      { text: '1,16', sup: false, sub: true },
      { text: ' = 6.75）', sup: false },
    ]);
  });

  it('chemistry: lowers the 2 of H2O and of CO2', () => {
    const out = splitScriptSegments('水（H2O）與二氧化碳（CO2）', [], [
      { text: '2', anchor: 'H' },
      { text: '2', anchor: 'CO' },
    ]);
    expect(out.map((s) => s.text).join('')).toBe('水（H2O）與二氧化碳（CO2）');
    expect(out.filter((s) => s.sub)).toHaveLength(2);
  });

  it('clinical: lowers the 1 of FEV1', () => {
    const out = splitScriptSegments('用力呼氣一秒量（FEV1）下降', [], [{ text: '1', anchor: 'FEV' }]);
    expect(out.filter((s) => s.sub).map((s) => s.text)).toEqual(['1']);
    expect(out.map((s) => s.text).join('')).toBe('用力呼氣一秒量（FEV1）下降');
  });

  it('needs its anchor, so the numbers a translation is full of stay on the baseline', () => {
    // The same "1" as FEV1, with no FEV in front of it anywhere.
    const out = splitScriptSegments('參見 [1] 與 1-4 項，共 1 例', [], [{ text: '1', anchor: 'FEV' }]);
    expect(out.every((s) => !s.sub)).toBe(true);
  });

  it('never loses, duplicates or reorders a character', () => {
    const text = 'np2 = 0.38；F1,16 = 6.75，二氧化碳（CO2）濃度上升。';
    const out = splitScriptSegments(text, marks('2'), [
      { text: 'p', anchor: 'n' },
      { text: '1,16', anchor: 'F' },
      { text: '2', anchor: 'CO' },
    ]);
    expect(out.map((s) => s.text).join('')).toBe(text);
    expect(out.filter((s) => s.sub)).toHaveLength(3);
  });

  it('is a no-op when the source had no script at all', () => {
    expect(splitScriptSegments('沒有下標的句子。', [], [])).toEqual([{ text: '沒有下標的句子。', sup: false }]);
  });
});

describe('buildInlineSegments with subscripts', () => {
  it('keeps the space the source had after a lowered run', () => {
    const out = buildInlineSegments('F1,16 = 6.75 顯示差異', [], null, [{ text: '1,16', anchor: 'F' }]);
    expect(out.map((s) => s.text).join('')).toBe('F1,16 = 6.75 顯示差異');
    expect(out.find((s) => s.sub)).toMatchObject({ text: '1,16' });
  });

  it('keeps a lowered run tight against the letter it belongs to', () => {
    const out = buildInlineSegments('水（H2O）', [], null, [{ text: '2', anchor: 'H' }]);
    const i = out.findIndex((s) => s.sub);
    expect(out[i - 1].text.endsWith('H')).toBe(true);
    expect(out[i + 1].text.startsWith('O')).toBe(true);
  });
});

describe('wrapping and measuring a lowered run', () => {
  const segments = buildInlineSegments('F1,16 = 6.75', [], null, [{ text: '1,16', anchor: 'F' }]);

  it('keeps a lowered run in one token, so "1,16" is never broken across lines', () => {
    const tokens = tokenizeInline(segments);
    const sub = tokens.filter((t) => t.sub);
    expect(sub).toHaveLength(1);
    expect(sub[0].text).toBe('1,16');
  });

  it('measures it at the script size, not at the line size', () => {
    const size = 10;
    const wide = measureSegments([{ text: '1,16', sup: false }], fakeFont, size);
    const small = measureSegments([{ text: '1,16', sup: false, sub: true }], fakeFont, size);
    expect(small).toBeCloseTo(fakeFont.widthOfTextAtSize('1,16', superscriptSize(size)), 6);
    expect(small).toBeLessThan(wide);
  });

  it('survives wrapping with its flag intact', () => {
    // Narrow enough to force a break; wrapping drops the spaces at the ends of
    // its lines, so the text is compared without them.
    const wrapped = wrapTokens(tokenizeInline(segments), fakeFont, 10, 30);
    expect(wrapped.segmentLines.length).toBeGreaterThan(1);
    const flat = wrapped.segmentLines.flat();
    expect(flat.map((s) => s.text).join('').replace(/ /g, '')).toBe('F1,16=6.75');
    expect(flat.filter((s) => s.sub === true).map((s) => s.text)).toEqual(['1,16']);
  });
});
