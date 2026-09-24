import { describe, expect, it } from 'vitest';
import {
  collectBlockSuperscripts,
  gluedSuperscripts,
  isCitationMarker,
  isSuperscriptItem,
  trailingMarker,
} from '../superscript';
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

function line(items: TextItemDebug[], fontSize = 9.5, y = 700): TextLine {
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

function block(lines: TextLine[], text: string): TextBlock {
  return {
    id: 'p1-b001',
    page: 1,
    type: 'BODY',
    sectionType: 'MAIN',
    blockType: 'BODY',
    text,
    x: 0,
    y: 690,
    width: 200,
    height: 20,
    top: 710,
    fontSize: 9.5,
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

describe('isCitationMarker', () => {
  it('accepts single numbers, lists, ranges and combinations', () => {
    expect(isCitationMarker('68')).toBe(true);
    expect(isCitationMarker('57,58')).toBe(true);
    expect(isCitationMarker('27-29')).toBe(true);
    expect(isCitationMarker('27–29')).toBe(true);
    expect(isCitationMarker('16,27-29')).toBe(true);
  });

  it('rejects anything that is not a bare reference number', () => {
    expect(isCitationMarker('2024')).toBe(false); // four digits: a year
    expect(isCitationMarker('0.05')).toBe(false);
    expect(isCitationMarker('a')).toBe(false);
    expect(isCitationMarker('12%')).toBe(false);
    expect(isCitationMarker('')).toBe(false);
  });
});

describe('isSuperscriptItem', () => {
  const main = item('among family caregivers.', 60, 700, 9.5);

  it('flags a small raised number on a normal line', () => {
    const marker = item('62', 160, 703.5, 6);
    expect(isSuperscriptItem(marker, line([main, marker]))).toBe(true);
  });

  it('ignores a number set at the line size on the line baseline', () => {
    const inline = item('62', 160, 700, 9.5);
    expect(isSuperscriptItem(inline, line([main, inline]))).toBe(false);
  });

  it('ignores a small number that is not raised (a subscript or a small caption)', () => {
    const low = item('62', 160, 700, 6);
    expect(isSuperscriptItem(low, line([main, low]))).toBe(false);
  });

  it('ignores a raised token that is not a citation marker', () => {
    const marker = item('a', 160, 703.5, 6);
    expect(isSuperscriptItem(marker, line([main, marker]))).toBe(false);
  });

  it('never flags the only item of a line', () => {
    const only = item('62', 160, 703.5, 6);
    expect(isSuperscriptItem(only, line([only]))).toBe(false);
  });
});

describe('gluedSuperscripts (fallback for markers merged into the word)', () => {
  it('finds the marker after a sentence end that follows a letter', () => {
    expect(gluedSuperscripts('among family caregivers.62').map((m) => m.text)).toEqual(['62']);
    expect(gluedSuperscripts('increased risk,16,27-29 and').map((m) => m.text)).toEqual(['16,27-29']);
  });

  it('does not fire when a letter or a Chinese character follows the digits', () => {
    // "…neared death,260萬名死者" (mixed-language text): 260 is a quantity, not a citation.
    expect(gluedSuperscripts('as individuals neared death,260萬名死者')).toEqual([]);
    expect(gluedSuperscripts('the cohort,12th wave')).toEqual([]);
  });

  it('does not mistake decimals, versions or ordinary numbers for markers', () => {
    expect(gluedSuperscripts('the P value was 0.05 overall')).toEqual([]);
    expect(gluedSuperscripts('p = .62 in the model')).toEqual([]);
    expect(gluedSuperscripts('see Table 1 and Figure 2')).toEqual([]);
    expect(gluedSuperscripts('COVID-19 patients')).toEqual([]);
    expect(gluedSuperscripts('a mean of 12.5 years')).toEqual([]);
  });
});

describe('collectBlockSuperscripts', () => {
  it('collects metadata markers first and adds glued ones only when new', () => {
    const main = item('caregivers.', 60, 700, 9.5);
    const marker = item('62', 120, 703.5, 6);
    const b = block([line([main, marker])], 'caregivers.62 Another sentence about burden.16,27-29');
    const found = collectBlockSuperscripts(b);
    // Neither carries an anchor: the raised one follows a full stop, and the
    // glued fallback has no geometry at all. Both are placed by their number.
    expect(found.markers).toEqual([
      { text: '62', anchor: '' },
      { text: '16,27-29', anchor: '' },
    ]);
    expect(found.metadataCount).toBe(1);
    expect(found.gluedCount).toBe(1);
  });

  it('keeps one marker per raised run, so a repeated exponent is restored every time', () => {
    // "np2 = 0.38; F1,16 = 6.75; ... np2 = 0.30; ... np2 = 0.39": the same
    // exponent is raised three times in one paragraph.
    const lines: TextLine[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(line([item('np', 60, 700 - i * 12, 9.5), item('2', 70, 703.5 - i * 12, 6), item('= 0.38;', 76, 700 - i * 12, 9.5)], 9.5, 700 - i * 12));
    }
    const found = collectBlockSuperscripts(block(lines, 'np2 = 0.38; np2 = 0.30; np2 = 0.39'));
    expect(found.markers).toEqual([
      { text: '2', anchor: 'np' },
      { text: '2', anchor: 'np' },
      { text: '2', anchor: 'np' },
    ]);
    expect(found.metadataCount).toBe(3);
  });

  it('returns nothing for a block without markers', () => {
    const b = block([line([item('A plain sentence.', 60, 700, 9.5)])], 'A plain sentence.');
    expect(collectBlockSuperscripts(b).markers).toEqual([]);
  });
});

describe('trailingMarker', () => {
  it('finds the citation a sentence ends with', () => {
    expect(trailingMarker('among family caregivers.62')).toBe('62');
    expect(trailingMarker('higher burden16,27-29')).toBe('16,27-29');
  });

  it('is null for a standalone number', () => {
    expect(trailingMarker('Table 1')).toBeNull();
    expect(trailingMarker('2024')).toBeNull();
    expect(trailingMarker('no marker here.')).toBeNull();
  });
});
