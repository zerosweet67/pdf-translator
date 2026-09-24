/**
 * Full-width tables on a two-column page.
 *
 * The fixture is the geometry of "Table 3. Cardiovascular and autonomic
 * variables" of a real two-column paper: the rows run across the whole page,
 * so the column gutter cuts every one of them into a left, a spanning and a
 * right piece. Grouping those pieces per column region stacks *different rows*
 * into one block; the classifier then reads a stack of numbers as a table note
 * or a heading, ends the table there, and the numbers are sent to the
 * translator and drawn over the table.
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../layout';
import { page as fixturePage } from '../../scope/__tests__/fixtures';
import type { FilledRect, PdfAnalysis, RuleLine, TextBlock, TextItemDebug } from '../types';

const VIEW = [0, 0, 595.22, 842];
const CHAR = 0.5;

interface ItemOptions {
  fs?: number;
  bold?: boolean;
  width?: number;
}

function item(text: string, x: number, y: number, o: ItemOptions = {}): TextItemDebug {
  const fs = o.fs ?? 10.02;
  return {
    page: 1,
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

function rule(y: number, x0 = 42.48, x1 = 552.78): RuleLine {
  return { orientation: 'horizontal', x0, y0: y, x1, y1: y, thickness: 0.48 };
}

function analysisOf(items: TextItemDebug[], rules: RuleLine[], fills: FilledRect[]): PdfAnalysis {
  return {
    fileName: 'table-band.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: 1,
    pages: [fixturePage(1, { width: 595.22, height: 842, view: VIEW, textItemCount: items.length, rules, fills })],
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const LEFT_X = 56.7;
const RIGHT_X = 304.7;
const COLUMN_W = 234;

/** Running text above the table, so the page is detected as two-column. */
function columns(): TextItemDebug[] {
  const out: TextItemDebug[] = [];
  const lines = [
    'produced after WET warm-up and the duration of the subsequent apnea',
    'whereas the lactate produced during the apnea executed after the DRY',
    'warm-up showed no correlation with the recovery of the athletes and',
    'the time needed to return to the resting values of heart rate and the',
    'pressure measured before the beginning of the experimental session,',
    'which suggests that the two warm-up protocols act on different paths.',
  ];
  lines.forEach((t, i) => {
    out.push(item(t, LEFT_X, 766 - i * 11.5, { width: COLUMN_W }));
    out.push(item(t, RIGHT_X, 766 - i * 11.5, { width: COLUMN_W }));
  });
  return out;
}

/**
 * The column grid of the real table: the label column, then nine value
 * columns. The producer shades every cell, so these boundaries also appear as
 * filled rectangles - which is what carries the CO | TPR gutter that the text
 * alone cannot show (both values are emitted as one text run).
 */
const GRID = [42.5, 70.9, 119.9, 166.0, 214.4, 262.9, 310.6, 358.3, 399.5, 450.2, 497.7, 552.8];
/** Left edge of the nine value columns. */
const COL_X = GRID.slice(2, 11);
const HEADERS = ['SAP', 'DAP', 'MAP', 'HR', 'SV', 'CO', 'TPR', 'IBI', 'BRS'];
const UNITS = ['(mmHg)', '(mmHg)', '(mmHg)', '(bpm)', '(ml)', '(L/min)', '(mmHg.s/ml)', '(sec)', '(mmHg/ms)'];

interface Row {
  group?: string;
  label: string;
  y: number;
  values: string[];
}

const ROWS: Row[] = [
  {
    group: 'WET',
    label: 'Baseline',
    y: 601.9,
    values: ['129.37 ± 4.9', '65.76 ± 2.9', '84.42 ± 3.4', '72.69 ± 3.7', '95.54 ± 4.1', '6.94 ± 0.6', '0.78 ± 0.2', '0.85 ± 0.05', '12.98 ± 1.6'],
  },
  {
    label: 'Post Apnea',
    y: 591.6,
    values: ['137.03 ± 4.5', '73.03 ± 2.7#', '92.03 ± 3.1#', '72.97 ± 12.3', '86.08 ± 5.9#', '6.25 ± 0.4#', '1.29 ± 0.2#', '0.85 ± 0.05', '12.44 ± 1.8'],
  },
  {
    group: 'DRY',
    label: 'Baseline',
    y: 580.7,
    values: ['130.43 ± 4.9', '68.31 ± 2.9', '86.97 ± 3.7', '70.58 ± 3.1', '93.28 ± 5.9', '6.61 ± 0.5', '0.85 ± 0.3', '0.86 ± 0.04', '13.75 ± 1.5'],
  },
  {
    label: 'Post Apnea',
    y: 569.8,
    values: ['134.38 ± 4.5', '74.60 ± 2.7#', '93.09 ± 3.3#', '73.08 ± 4.6', '83.25 ± 4.5#', '6.04 ± 0.4#', '1.36 ± 0.2#', '0.84 ± 0.05', '12.51 ± 1.9'],
  },
];

const LEGEND_1 =
  'SAP; systolic arterial pressure, DAP; diastolic arterial pressure, MAP; mean arterial pressure, HR; heart rate, SV; stroke volume, CO; cardiac output,';
const LEGEND_2 =
  'TPR; total peripheral resistance, IBI; Interbeat interval, BRS; baroreflex sensitivity. # represent significant differences across times at p < 0.05.';

function tablePage(): PdfAnalysis {
  const items = columns();
  items.push(item('Table 3. Cardiovascular and autonomic variables. Data are means ± SD.', 49.6, 634.5, { fs: 9, bold: true, width: 277.2 }));
  HEADERS.forEach((h, i) => {
    const width = h.length * 5.7;
    const unitWidth = UNITS[i].length * 4.6;
    const centre = (GRID[i + 2] + GRID[i + 3]) / 2;
    items.push(item(h, centre - width / 2, 622.9, { fs: 9, bold: true, width }));
    items.push(item(UNITS[i], centre - unitWidth / 2, 612.6, { fs: 9, bold: true, width: unitWidth }));
  });
  for (const row of ROWS) {
    if (row.group) items.push(item(row.group, 42.5, row.y - 5.2, { fs: 9, bold: true, width: 21 }));
    items.push(item(row.label, 70.9, row.y, { fs: 9, bold: true, width: row.label === 'Baseline' ? 32.0 : 43.7 }));
    // Like the real file: the values nearly touch, and two of them are emitted
    // as a single text run, so no projection of the text can separate them.
    row.values.forEach((v, i) => items.push(item(v, COL_X[i], row.y, { fs: 9, width: 41 })));
  }
  items.push(item(LEGEND_1, LEFT_X, 559.9, { fs: 7.98, width: 481.9 }));
  items.push(item(LEGEND_2, LEFT_X, 550.7, { fs: 7.98, width: 458.1 }));
  const rules = [rule(781.97, 56.7, 538.62), rule(631.52), rule(610.34), rule(589.1), rule(578.3, 70.86), rule(567.44)];
  const fills: FilledRect[] = [];
  for (const [y, height] of [[610.6, 20.7], [599.3, 10.3], [589.3, 10.4], [578.5, 10.3], [567.7, 10.3]] as const) {
    for (let c = 0; c < GRID.length - 1; c++) fills.push({ x: GRID[c], y, width: GRID[c + 1] - GRID[c], height, color: '#fabf90' });
  }
  return analysisOf(items, rules, fills);
}

function layout(): TextBlock[] {
  return analyzeLayout(tablePage()).blocks;
}

/** "129.37 ± 4.9" and friends. */
function isValue(token: string): boolean {
  return /\d/.test(token) && /[±.]/.test(token);
}

describe('full-width table on a two-column page', () => {
  it('resolves every data row into table cells', () => {
    const blocks = layout();
    const cells = blocks.filter((b) => b.type === 'TABLE');
    for (const row of ROWS) {
      for (const v of row.values) {
        // Two neighbouring values the producer emits as one text run stay in
        // one cell - no projection can separate them - but every value has to
        // live inside the table and nowhere else.
        const cell = cells.find((c) => c.text.replace(/\s+/g, '').includes(v.replace(/\s+/g, '')));
        expect(cell, `"${v}" belongs to a table cell`).toBeDefined();
        expect(cell?.translate, `"${v}" is not translated`).toBe(false);
      }
      const label = cells.find((c) => c.text.trim() === row.label);
      expect(label, `row label "${row.label}"`).toBeDefined();
    }
    expect(cells.filter((c) => c.blockType === 'TABLE_HEADER')).toHaveLength(HEADERS.length);
  });

  it('keeps the value columns apart instead of merging CO and TPR', () => {
    const cells = layout().filter((b) => b.type === 'TABLE');
    const merged = cells.find((b) => /\bCO\b/.test(b.text) && /\bTPR\b/.test(b.text));
    expect(merged, `CO and TPR share one cell: ${JSON.stringify(merged?.text)}`).toBeUndefined();
  });

  it('never sends a row of numbers to the translator as prose', () => {
    for (const b of layout()) {
      if (!b.translate) continue;
      const values = b.text.split(/\s+/).filter(isValue).length;
      expect(values, `${b.id} [${b.type}/${b.blockType}] ${JSON.stringify(b.text.slice(0, 90))}`).toBeLessThan(4);
    }
  });

  it('does not turn a row label into a heading', () => {
    const heading = layout().find((b) => b.type === 'HEADING' && /Baseline|Post Apnea|DRY|WET/.test(b.text));
    expect(heading, `row label read as a heading: ${JSON.stringify(heading?.text)}`).toBeUndefined();
  });

  it('keeps the caption and the legend translatable', () => {
    const blocks = layout();
    const caption = blocks.find((b) => b.text.startsWith('Table 3.'));
    expect(caption?.blockType).toBe('TABLE_CAPTION');
    expect(caption?.translate).toBe(true);
    const legend = blocks.find((b) => b.text.includes('systolic arterial pressure'));
    expect(legend?.translate, `legend ${JSON.stringify(legend?.blockType)}`).toBe(true);
  });
});
