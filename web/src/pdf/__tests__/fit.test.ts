import { describe, expect, it } from 'vitest';
import {
  fitTextToBox,
  fitTextToBoxes,
  LINE_HEIGHT_RATIO,
  maxLinesFor,
  minimumFontSize,
  textExtent,
  tokenize,
  wrapText,
  wrapTokens,
  type TextMeasurer,
} from '../fit';
import { GLYPH_ASCENT, GLYPH_DESCENT } from '../layout';

/** CJK and fullwidth characters are 1 em wide, Latin 0.5 em, spaces 0.25 em. */
const fakeFont: TextMeasurer = {
  widthOfTextAtSize(text: string, size: number): number {
    let em = 0;
    for (const ch of text) {
      if (ch === ' ') em += 0.25;
      else if (/[⺀-鿿豈-﫿︰-﹏＀-￯]/.test(ch)) em += 1;
      else em += 0.5;
    }
    return em * size;
  },
};

describe('tokenize', () => {
  it('splits CJK per character and keeps Latin runs whole', () => {
    const t = tokenize('大型語言模型 Large Language Models');
    expect(t.map((x) => x.text)).toEqual(['大', '型', '語', '言', '模', '型', ' ', 'Large', ' ', 'Language', ' ', 'Models']);
    expect(t[0].kind).toBe('cjk');
    expect(t[7].kind).toBe('word');
  });

  it('keeps citations, percentages, model names, URLs and abbreviations as one token', () => {
    const texts = tokenize('偏誤 [12]，ROE 下降 30%，o1-preview 與 GPT-4：https://doi.org/10.1111/1475-679X.12345 LLM').map((x) => x.text);
    expect(texts).toContain('[12]');
    expect(texts).toContain('30%');
    expect(texts).toContain('o1-preview');
    expect(texts).toContain('GPT-4');
    expect(texts).toContain('https://doi.org/10.1111/1475-679X.12345');
    expect(texts).toContain('LLM');
  });

  it('classifies CJK punctuation as open / close', () => {
    const t = tokenize('（見表一）。');
    expect(t[0]).toEqual({ text: '（', kind: 'open' });
    expect(t[t.length - 2]).toEqual({ text: '）', kind: 'close' });
    expect(t[t.length - 1]).toEqual({ text: '。', kind: 'close' });
  });
});

describe('wrapText', () => {
  it('wraps CJK at any character', () => {
    // 10 em wide line, 1 em per character → 10 characters per line
    const lines = wrapText('一二三四五六七八九十甲乙丙丁戊', fakeFont, 10, 100);
    expect(lines).toEqual(['一二三四五六七八九十', '甲乙丙丁戊']);
  });

  it('never starts a line with closing punctuation', () => {
    // "一二三四五六七八九十，" → the comma would land at the line start; pull 十 down with it.
    const lines = wrapText('一二三四五六七八九十，甲乙', fakeFont, 10, 100);
    expect(lines[0]).toBe('一二三四五六七八九');
    expect(lines[1]).toBe('十，甲乙');
    for (const line of lines) expect(/^[，。、；：？！）」』]/.test(line)).toBe(false);
  });

  it('never ends a line with opening punctuation', () => {
    const lines = wrapText('一二三四五六七八九（十甲乙）', fakeFont, 10, 100);
    expect(lines[0]).toBe('一二三四五六七八九');
    expect(lines[1]).toBe('（十甲乙）');
  });

  it('does not split Latin words and drops spaces at line edges', () => {
    // 20 em: "Large Language" = 2.5 + 0.25 + 4 = 6.75 em; "Models" = 3 em
    const lines = wrapText('Large Language Models 大型語言模型 Large', fakeFont, 10, 100);
    for (const line of lines) {
      expect(line.startsWith(' ')).toBe(false);
      expect(line.endsWith(' ')).toBe(false);
      expect(fakeFont.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(100);
    }
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('Large Language Models 大型語言模型 Large');
  });

  it('splits a single token wider than the line by characters', () => {
    const lines = wrapText('https://example.com/a/very/long/path/that/does/not/fit', fakeFont, 10, 50);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fakeFont.widthOfTextAtSize(line, 10)).toBeLessThanOrEqual(50);
    expect(lines.join('')).toBe('https://example.com/a/very/long/path/that/does/not/fit');
  });

  it('honours maxLines and returns the remaining tokens', () => {
    const tokens = tokenize('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸');
    const r = wrapTokens(tokens, fakeFont, 10, 100, 1);
    expect(r.lines).toEqual(['一二三四五六七八九十']);
    expect(r.rest.map((t) => t.text).join('')).toBe('甲乙丙丁戊己庚辛壬癸');
  });
});

describe('fitTextToBox', () => {
  const extentFor = (n: number, fs: number) => textExtent(n, fs, fs * LINE_HEIGHT_RATIO);

  it('keeps the original size when the text fits', () => {
    const height = extentFor(2, 10);
    const r = fitTextToBox({ text: '一二三四五六七八九十甲乙', width: 100, height, originalFontSize: 10, font: fakeFont });
    expect(r.fontSize).toBe(10);
    expect(r.lines.length).toBe(2);
    expect(r.fits).toBe(true);
    expect(r.extended).toBe(false);
  });

  it('a single line at the original size fits a one-line block exactly', () => {
    const height = 10 * (GLYPH_ASCENT + GLYPH_DESCENT);
    const r = fitTextToBox({ text: '一二三', width: 100, height, originalFontSize: 10, font: fakeFont });
    expect(r.fontSize).toBe(10);
    expect(r.fits).toBe(true);
  });

  it('shrinks in 0.5pt steps until it fits', () => {
    // 22 chars: 3 lines at 10pt (10 per line), 2 lines at 9pt (11 per line). Box holds 2 lines at 10pt.
    const height = extentFor(2, 10);
    const r = fitTextToBox({ text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑', width: 100, height, originalFontSize: 10, font: fakeFont });
    expect(r.fontSize).toBe(9);
    expect(r.lines.length).toBe(2);
    expect(r.fits).toBe(true);
    expect(r.extended).toBe(false);
    expect(textExtent(r.lines.length, r.fontSize, r.lineHeight)).toBeLessThanOrEqual(height + 1e-6);
  });

  it('falls back to the 25 % extension when the minimum size is still too big', () => {
    // 30 chars need 3 lines even at 7pt (14 per line); 3 lines at 7pt = 25.55pt > 23.5pt box, < box + 25 %.
    const height = extentFor(2, 10);
    const r = fitTextToBox({ text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉', width: 100, height, originalFontSize: 10, font: fakeFont });
    expect(r.fontSize).toBe(minimumFontSize(10));
    expect(r.fits).toBe(true);
    expect(r.extended).toBe(true);
    expect(r.overflow).toBe(0);
  });

  it('uses the extension at the minimum size and reports overflow beyond it', () => {
    const height = extentFor(1, 10);
    const text = '一二三四五六七八九十'.repeat(6); // 60 characters
    const r = fitTextToBox({ text, width: 100, height, originalFontSize: 10, font: fakeFont });
    expect(r.fontSize).toBe(minimumFontSize(10));
    expect(r.fits).toBe(false);
    expect(r.overflow).toBeGreaterThan(0);
    expect(r.lines.join('')).toBe(text); // nothing is dropped
  });

  it('minimum font size is max(6, 0.7 × original)', () => {
    expect(minimumFontSize(10)).toBe(7);
    expect(minimumFontSize(8)).toBe(6);
    expect(minimumFontSize(5)).toBe(5);
  });

  it('maxLinesFor is consistent with textExtent', () => {
    for (const n of [1, 2, 5, 12]) {
      const h = textExtent(n, 9, 9 * LINE_HEIGHT_RATIO);
      expect(maxLinesFor(h, 9, 9 * LINE_HEIGHT_RATIO)).toBe(n);
      expect(maxLinesFor(h - 0.5, 9, 9 * LINE_HEIGHT_RATIO)).toBe(Math.max(1, n - 1));
    }
  });
});

describe('fitTextToBoxes (merged units)', () => {
  it('fills the first box to capacity and continues in the second', () => {
    const lineHeight = 10 * LINE_HEIGHT_RATIO;
    const boxes = [
      { width: 100, height: textExtent(2, 10, lineHeight) },
      { width: 100, height: textExtent(3, 10, lineHeight) },
    ];
    const text = '一二三四五六七八九十'.repeat(4); // 40 characters = 4 lines of 10
    const r = fitTextToBoxes(text, boxes, 10, fakeFont);
    expect(r.fontSize).toBe(10);
    expect(r.parts[0].lines.length).toBe(2);
    expect(r.parts[1].lines.length).toBe(2);
    expect(r.parts.flatMap((p) => p.lines).join('')).toBe(text);
    expect(r.fits).toBe(true);
  });

  it('shrinks all boxes together when the tail does not fit', () => {
    const lineHeight = 10 * LINE_HEIGHT_RATIO;
    const boxes = [
      { width: 100, height: textExtent(2, 10, lineHeight) },
      { width: 100, height: textExtent(2, 10, lineHeight) },
    ];
    const text = '一二三四五六七八九十'.repeat(5); // 50 characters = 5 lines at 10pt, capacity 4
    const r = fitTextToBoxes(text, boxes, 10, fakeFont);
    expect(r.fontSize).toBeLessThan(10);
    expect(r.fits).toBe(true);
    expect(r.parts.flatMap((p) => p.lines).join('')).toBe(text);
  });

  it('never cuts a merged translation even when it overflows', () => {
    const lineHeight = 10 * LINE_HEIGHT_RATIO;
    const boxes = [
      { width: 100, height: textExtent(1, 10, lineHeight), maxExtension: 0 },
      { width: 100, height: textExtent(1, 10, lineHeight), maxExtension: 0 },
    ];
    const text = '一二三四五六七八九十'.repeat(8);
    const r = fitTextToBoxes(text, boxes, 10, fakeFont);
    expect(r.fits).toBe(false);
    expect(r.parts.flatMap((p) => p.lines).join('')).toBe(text);
  });
});
