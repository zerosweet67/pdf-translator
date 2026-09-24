import { describe, expect, it } from 'vitest';
import { fitTextToBoxes, type TextMeasurer } from '../fit';
import { superscriptRise, superscriptSize, roleFor, typographyFor, TYPOGRAPHY } from '../typography';

const BODY = 9.5;

/** CJK 1 em, Latin 0.5 em, space 0.25 em — same fake as fit.test.ts. */
const fakeFont: TextMeasurer = {
  widthOfTextAtSize(text: string, size: number): number {
    let em = 0;
    for (const ch of text) {
      if (ch === ' ') em += 0.25;
      else if (/[⺀-鿿＀-￯]/.test(ch)) em += 1;
      else em += 0.5;
    }
    return em * size;
  },
};

function spec(type: 'TITLE' | 'HEADING' | 'BODY' | 'CAPTION' | 'TABLE', sourceFontSize: number, blockHeight = 40) {
  return typographyFor({ type, sourceFontSize, bodyFontSize: BODY, blockHeight });
}

describe('roleFor', () => {
  it('maps the block types the paragraph renderer knows', () => {
    expect(roleFor('TITLE')).toBe('title');
    expect(roleFor('HEADING')).toBe('heading');
    expect(roleFor('BODY')).toBe('body');
    expect(roleFor('CAPTION')).toBe('caption');
    expect(roleFor('TABLE')).toBe('other');
    expect(roleFor('FIGURE')).toBe('other');
    expect(roleFor('FOOTNOTE')).toBe('footnote');
  });
});

describe('typographyFor: heading hierarchy', () => {
  // Test 1: TITLE > HEADING > BODY, with a visible gap to the body size.
  it('keeps TITLE clearly larger than HEADING, and HEADING clearly larger than BODY', () => {
    const title = spec('TITLE', 16);
    const heading = spec('HEADING', 11);
    const body = spec('BODY', BODY);

    expect(title.fontSize).toBeGreaterThan(heading.fontSize);
    expect(heading.fontSize).toBeGreaterThan(body.fontSize);
    expect(heading.fontSize / BODY).toBeGreaterThanOrEqual(TYPOGRAPHY.minHeadingBodyRatio);
    expect(title.fontSize / BODY).toBeGreaterThanOrEqual(TYPOGRAPHY.minTitleBodyRatio);
  });

  it('raises a bold-only heading that the source set at body size', () => {
    const heading = spec('HEADING', BODY);
    expect(heading.boosted).toBe(true);
    expect(heading.fontSize).toBeCloseTo(BODY * TYPOGRAPHY.heading.sizeScale, 5);
    expect(heading.bold).toBe(true);
  });

  it('never shrinks a source heading that is already large', () => {
    const heading = spec('HEADING', 14);
    expect(heading.fontSize).toBe(14);
    expect(heading.boosted).toBe(false);
  });

  it('caps the boost so a heading cannot explode', () => {
    const heading = typographyFor({ type: 'HEADING', sourceFontSize: 4, bodyFontSize: BODY, blockHeight: 20 });
    expect(heading.fontSize).toBeLessThanOrEqual(BODY * TYPOGRAPHY.heading.maxScale + 1e-9);
  });

  it('the cap bounds the boost only: a large source heading is never shrunk', () => {
    // 16 pt heading over an 8.5 pt body is above heading.maxScale × body (13.6).
    const heading = typographyFor({ type: 'HEADING', sourceFontSize: 16, bodyFontSize: 8.5, blockHeight: 20 });
    expect(heading.fontSize).toBe(16);
    const title = typographyFor({ type: 'TITLE', sourceFontSize: 24, bodyFontSize: 8.5, blockHeight: 40 });
    expect(title.fontSize).toBe(24);
  });

  it('leaves BODY at its source size and gives it no bold', () => {
    const body = spec('BODY', BODY);
    expect(body.fontSize).toBe(BODY);
    expect(body.bold).toBe(false);
    expect(body.boosted).toBe(false);
  });

  // Test 2: the fitting floor keeps a heading away from body size.
  it('floors a heading above the body size so fitting cannot flatten it', () => {
    const heading = spec('HEADING', 11);
    expect(heading.minFontSize).toBeGreaterThanOrEqual(BODY * TYPOGRAPHY.minHeadingBodyRatio - 1e-9);
    const body = spec('BODY', BODY);
    expect(body.minFontSize).toBeLessThan(BODY);
  });

  it('a tight box still cannot fit a heading down to body size', () => {
    const heading = spec('HEADING', 11, 12);
    // One short line in a box far too small: the loop shrinks to the floor and stops.
    const result = fitTextToBoxes(
      [{ text: '研究限制與未來方向的補充說明', sup: false }],
      [{ width: 24, height: 10, maxExtension: 0 }],
      heading.fontSize,
      fakeFont,
      heading.minFontSize,
      heading.lineHeightRatio,
    );
    expect(result.fontSize).toBeGreaterThanOrEqual(heading.minFontSize - 1e-9);
    expect(result.fontSize / BODY).toBeGreaterThanOrEqual(TYPOGRAPHY.minHeadingBodyRatio - 0.01);
  });
});

describe('typographyFor: paragraph indent and spacing', () => {
  // Test 7 (config half) and test 8.
  it('indents a body paragraph and nothing else', () => {
    expect(spec('BODY', BODY).firstLineIndent).toBeCloseTo(TYPOGRAPHY.body.firstLineIndentEm * BODY, 5);
    expect(spec('HEADING', 11).firstLineIndent).toBe(0);
    expect(spec('TITLE', 16).firstLineIndent).toBe(0);
    expect(spec('CAPTION', 8).firstLineIndent).toBe(0);
    expect(spec('TABLE', 8).firstLineIndent).toBe(0);
  });

  it('does not indent a paragraph that continues one started elsewhere', () => {
    const continued = typographyFor({
      type: 'BODY',
      sourceFontSize: BODY,
      bodyFontSize: BODY,
      blockHeight: 40,
      isContinuation: true,
    });
    expect(continued.firstLineIndent).toBe(0);
  });

  it('reserves space before and after a body paragraph', () => {
    const body = spec('BODY', BODY, 60);
    expect(body.spaceBefore).toBeGreaterThan(0);
    expect(body.spaceAfter).toBeGreaterThan(0);
    expect(body.slideDown).toBe(false);
  });

  it('gives a heading space above by sliding it down, not by losing height', () => {
    const heading = spec('HEADING', 11, 13);
    expect(heading.slideDown).toBe(true);
    expect(heading.spaceBefore).toBeGreaterThan(0);
    expect(heading.spaceAfter).toBe(0);
    expect(heading.spaceBefore).toBeLessThanOrEqual(TYPOGRAPHY.spacing.maxSlideEm * heading.fontSize + 1e-9);
  });

  it('never lets spacing eat more than the configured share of a short block', () => {
    const body = spec('BODY', BODY, 11);
    expect(body.spaceBefore + body.spaceAfter).toBeLessThanOrEqual(TYPOGRAPHY.spacing.maxShare * 11 + 1e-9);
  });

  it('gives table and figure text no paragraph spacing at all', () => {
    const cell = spec('TABLE', 8, 12);
    expect(cell.spaceBefore).toBe(0);
    expect(cell.spaceAfter).toBe(0);
    expect(cell.firstLineIndent).toBe(0);
    expect(cell.bold).toBe(false);
  });
});

describe('superscript metrics', () => {
  // Test 3: a citation marker is set smaller and raised.
  it('is smaller than the line and raised above the baseline', () => {
    const size = 10;
    expect(superscriptSize(size)).toBeLessThan(size);
    expect(superscriptSize(size)).toBeCloseTo(size * TYPOGRAPHY.superscript.scale, 5);
    expect(superscriptRise(size)).toBeGreaterThan(0);
    expect(superscriptRise(size)).toBeCloseTo(size * TYPOGRAPHY.superscript.riseEm, 5);
  });

  it('never goes below the readable minimum', () => {
    expect(superscriptSize(4)).toBeGreaterThanOrEqual(TYPOGRAPHY.superscript.minSize);
  });
});
