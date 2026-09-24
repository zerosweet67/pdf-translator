/**
 * Recovering the sub/superscript runs PDF.js merges away.
 *
 * The fixtures build an operator list the way a typesetter writes one — a
 * text matrix per run, the script runs at a smaller size and an offset
 * baseline — and the merged item `getTextContent()` would return for it.
 * Nothing in the module knows about formulas, so the three cases here
 * (statistics, chemistry, mathematics) are the same code path.
 */
import { OPS } from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { collectTextRuns, splitScriptRuns, type TextRun } from '../textruns';
import type { TextItemDebug } from '../types';

// ---------------------------------------------------------------------------
// A tiny content-stream builder
// ---------------------------------------------------------------------------

const CHAR_WIDTH = 500; // 0.5 em for every glyph, so the arithmetic is easy

function glyphs(text: string) {
  return [...text].map((ch) => ({ unicode: ch, width: ch === ' ' ? 250 : CHAR_WIDTH, isSpace: ch === ' ' }));
}

class Stream {
  readonly fnArray: number[] = [];
  readonly argsArray: unknown[] = [];

  private push(fn: number | undefined, args: unknown): this {
    if (typeof fn === 'number') {
      this.fnArray.push(fn);
      this.argsArray.push(args);
    }
    return this;
  }

  begin(): this {
    return this.push(OPS.beginText, []).push(OPS.setFont, ['f1', 1]);
  }

  /** A run at `size`, starting at (x, y) on the page. */
  run(text: string, size: number, x: number, y: number): this {
    return this.push(OPS.setTextMatrix, [size, 0, 0, size, x, y]).push(OPS.showText, [glyphs(text)]);
  }

  /** A run that continues the previous one (no new matrix). */
  more(text: string): this {
    return this.push(OPS.showText, [glyphs(text)]);
  }

  end(): this {
    return this.push(OPS.endText, []);
  }
}

/** The single item PDF.js would hand back for a set of runs it merged. */
function merged(text: string, x: number, y: number, fontSize: number): TextItemDebug {
  return {
    page: 1,
    text,
    x,
    y,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    fontSize,
    fontName: 'g_d0_f1',
    fontFamily: 'serif',
    fontRealName: 'TimesNewRomanPSMT',
    hasEOL: false,
    transform: [fontSize, 0, 0, fontSize, x, y],
  };
}

function texts(items: readonly TextItemDebug[]): string[] {
  return items.map((i) => i.text);
}

// ---------------------------------------------------------------------------

describe('collectTextRuns', () => {
  it('reads position and size from the text matrix', () => {
    const s = new Stream().begin().run('F', 10, 100, 660.8).run('1,16', 6.5, 105, 659.78).run('= 6.75', 10, 118, 660.8).end();
    const runs = collectTextRuns(s);
    expect(runs.map((r) => r.text)).toEqual(['F', '1,16', '= 6.75']);
    expect(runs[1]).toMatchObject({ x: 105, y: 659.78, fontSize: 6.5 });
    expect(runs[0].fontSize).toBe(10);
    // "F" is one 0.5 em glyph at 10 pt, on the page and not in text space.
    expect(runs[0].width).toBeCloseTo(5, 5);
    expect(runs[1].width).toBeCloseTo(4 * 0.5 * 6.5, 5);
  });

  it('advances the text matrix across a run, so the next one follows it', () => {
    const s = new Stream().begin().run('ab', 10, 100, 700).more('cd').end();
    const runs = collectTextRuns(s);
    expect(runs[0].x).toBe(100);
    // two glyphs of 0.5 em at 10 pt
    expect(runs[1].x).toBeCloseTo(110, 5);
  });

  it('follows the page transform', () => {
    const s = new Stream();
    s.fnArray.push(OPS.transform);
    s.argsArray.push([1, 0, 0, 1, 50, 20]);
    s.begin().run('x', 10, 100, 700).end();
    expect(collectTextRuns(s)[0]).toMatchObject({ x: 150, y: 720 });
  });

  it('accepts the Float32Array shape PDF.js uses for the text matrix', () => {
    const s = new Stream();
    s.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText);
    s.argsArray.push([], ['f1', 1], [new Float32Array([10, 0, 0, 10, 120, 640])], [glyphs('x')]);
    expect(collectTextRuns(s)[0]).toMatchObject({ x: 120, y: 640, fontSize: 10 });
  });

  it('returns nothing for an operator list without text', () => {
    expect(collectTextRuns({ fnArray: [], argsArray: [] })).toEqual([]);
  });
});

describe('splitScriptRuns', () => {
  it('statistics: gives F1,16 its subscript back', () => {
    const runs = collectTextRuns(new Stream().begin().run('F', 10, 100, 660.8).run('1,16', 6.5, 105, 659.78).run(' = 6.75', 10, 118, 660.8).end());
    const out = splitScriptRuns([merged('F1,16 = 6.75', 100, 660.8, 10)], runs);
    expect(texts(out)).toEqual(['F', '1,16', ' = 6.75']);
    expect(out[1].fontSize).toBe(6.5);
    expect(out[1].y).toBe(659.78);
    expect(out[0].fontSize).toBe(10);
  });

  it('chemistry: H2O keeps its lowered 2', () => {
    const runs = collectTextRuns(new Stream().begin().run('H', 10, 60, 700).run('2', 6.5, 66, 698.9).run('O', 10, 70, 700).end());
    const out = splitScriptRuns([merged('H2O', 60, 700, 10)], runs);
    expect(texts(out)).toEqual(['H', '2', 'O']);
    expect(out[1].y).toBeLessThan(out[0].y);
  });

  it('mathematics: a raised exponent is split out as well', () => {
    const runs = collectTextRuns(new Stream().begin().run('x', 10, 60, 700).run('2', 6.5, 66, 703.5).run(' + 1', 10, 70, 700).end());
    const out = splitScriptRuns([merged('x2 + 1', 60, 700, 10)], runs);
    expect(texts(out)).toEqual(['x', '2', ' + 1']);
    expect(out[1].y).toBeGreaterThan(out[0].y);
  });

  it('never loses, duplicates or reorders a character', () => {
    const runs = collectTextRuns(new Stream().begin().run('np', 10, 60, 700).run('2', 6.5, 70, 703.5).run(' = 0.38; F', 10, 75, 700).run('1,16', 6.5, 120, 698.9).run(' = 6.75', 10, 133, 700).end());
    const source = 'np2 = 0.38; F1,16 = 6.75';
    const out = splitScriptRuns([merged(source, 60, 700, 10)], runs);
    expect(out.map((i) => i.text).join('')).toBe(source);
    expect(out.filter((i) => i.fontSize < 10)).toHaveLength(2);
  });

  it('leaves an item alone when every run is the same size', () => {
    const runs = collectTextRuns(new Stream().begin().run('plain text', 10, 60, 700).end());
    const item = merged('plain text', 60, 700, 10);
    expect(splitScriptRuns([item], runs)).toEqual([item]);
  });

  it('leaves an item alone when the runs do not reproduce its text', () => {
    const runs = collectTextRuns(new Stream().begin().run('something else', 6, 60, 690).end());
    const item = merged('F1,16 = 6.75', 100, 660.8, 10);
    expect(splitScriptRuns([item], runs)).toEqual([item]);
  });

  it('leaves an item alone when the runs start somewhere else', () => {
    const runs = collectTextRuns(new Stream().begin().run('F', 10, 400, 660.8).run('1,16', 6.5, 405, 659.78).end());
    const item = merged('F1,16', 100, 660.8, 10);
    expect(splitScriptRuns([item], runs)).toEqual([item]);
  });

  it('keeps the spaces PDF.js inserted between runs', () => {
    // PDF.js writes a space where the runs only left a gap.
    const runs = collectTextRuns(new Stream().begin().run('F', 10, 100, 660.8).run('1,16', 6.5, 105, 659.78).run('=', 10, 130, 660.8).end());
    const out = splitScriptRuns([merged('F1,16 =', 100, 660.8, 10)], runs);
    expect(out.map((i) => i.text).join('')).toBe('F1,16 =');
    expect(texts(out)).toEqual(['F', '1,16 ', '=']);
  });

  it('walks items and runs together, so a second line is matched too', () => {
    const runs = collectTextRuns(
      new Stream().begin().run('H', 10, 60, 700).run('2', 6.5, 66, 698.9).run('O', 10, 70, 700).run('and CO', 10, 60, 688).run('2', 6.5, 90, 686.9).end(),
    );
    const out = splitScriptRuns([merged('H2O', 60, 700, 10), merged('and CO2', 60, 688, 10)], runs);
    expect(texts(out)).toEqual(['H', '2', 'O', 'and CO', '2']);
  });

  it('does nothing without runs', () => {
    const item = merged('H2O', 60, 700, 10);
    expect(splitScriptRuns([item], [])).toEqual([item]);
  });
});

describe('a run that is small but on the baseline', () => {
  it('is not a script: small print stays one item', () => {
    const runs: TextRun[] = [
      { text: 'Note', x: 60, y: 700, fontSize: 10, width: 20 },
      { text: ' 12', x: 80, y: 700, fontSize: 7, width: 7 },
    ];
    const item = merged('Note 12', 60, 700, 10);
    expect(splitScriptRuns([item], runs)).toEqual([item]);
  });
});
