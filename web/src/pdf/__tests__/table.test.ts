/**
 * Table cells: clustering, numeric detection, geometry, masks, table-only
 * fitting and placement (pdf/table.ts), plus the translation units the
 * layout builds from them (one logical cell = one unit).
 */
import { describe, expect, it } from 'vitest';
import { analyzeLayout } from '../layout';
import {
  BORDER_CLEARANCE,
  MIN_CONTRAST_RATIO,
  backgroundAt,
  buildTableCells,
  clipMaskOffRules,
  clipMaskToRules,
  contrastRatio,
  isStatNotationOnly,
  relativeLuminance,
  sampleBackground,
  textColorFor,
  fitTextToTableCell,
  isNumericTableCell,
  placeTableCellLines,
  TABLE_LINE_HEIGHT_RATIO,
  TABLE_LINE_HEIGHT_TIGHT,
  TABLE_MASK_PAD,
  TABLE_MIN_FONT_SIZE,
  tableCellMaskRects,
  type ResolvedCell,
  type TableItemRef,
} from '../table';
import { GLYPH_ASCENT, GLYPH_DESCENT } from '../layout';
import type { TextMeasurer } from '../fit';
import type { PdfAnalysis, RuleLine, TableCellInfo, TextItemDebug } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FS = 8;
/** Latin glyphs are 0.5 em wide in the fixture. */
const CHAR = 0.5;

function item(text: string, x: number, y: number, fontSize = FS, page = 1): TextItemDebug {
  return {
    page,
    text,
    x,
    y,
    width: text.length * CHAR * fontSize,
    height: fontSize,
    fontSize,
    fontName: 'g_d0_f1',
    fontFamily: 'sans-serif',
    fontRealName: 'Helvetica',
    hasEOL: false,
    transform: [fontSize, 0, 0, fontSize, x, y],
  };
}

function refs(items: TextItemDebug[]): TableItemRef[] {
  return items.map((it, index) => ({ index, item: it }));
}

/**
 * A JAMA-style table (8 pt, rows 12 pt apart, wrapped lines 9 pt apart):
 *
 *   Characteristic        Bedbound (n = 590)          P value      ← spanning header
 *                         Observed No.   Missing
 *                         (weighted %)   count^b
 *   Time from last        4.9 (0.2)      0            <.001
 *   interview to death,
 *     mean (SD)
 *   Female                389 (63.0)     0            <.001
 *   Male                  201 (37.0)     0            .05
 *   Medicaid^d            195 (31.9)     35           <.001
 *   Female 389 (63.0)     1              2            3            ← mixed text + number cell
 */
function jamaItems(): TextItemDebug[] {
  const c0 = 50;
  const c1 = 200;
  const c2 = 260;
  const c3 = 320;
  return [
    item('Characteristic', c0, 200),
    item('Bedbound (n = 590)', c1, 200), // 18 chars → 72 pt: covers columns 1 and 2
    item('P value', c3, 200),
    item('Observed No.', c1, 190),
    item('Missing', c2, 190),
    item('(weighted %)', c1, 181),
    item('count', c2, 181),
    item('b', c2 + 5 * CHAR * FS, 183.5, 5), // superscript marker on "count"
    item('Time from last', c0, 165),
    item('4.9 (0.2)', c1, 165),
    item('0', c2, 165),
    item('<.001', c3, 165),
    item('interview to death,', c0, 156),
    item('mean (SD)', c0 + 6, 147),
    item('Female', c0 + 6, 135),
    item('389 (63.0)', c1, 135),
    item('0', c2, 135),
    item('<.001', c3, 135),
    item('Male', c0 + 6, 123),
    item('201 (37.0)', c1, 123),
    item('0', c2, 123),
    item('.05', c3, 123),
    item('Medicaid', c0, 111),
    item('d', c0 + 8 * CHAR * FS, 113.5, 5), // superscript marker on "Medicaid"
    item('195 (31.9)', c1, 111),
    item('35', c2, 111),
    item('<.001', c3, 111),
    item('Female 389 (63.0)', c0, 99),
    item('1', c1, 99),
    item('2', c2, 99),
    item('3', c3, 99),
  ];
}

/** Horizontal rules halfway between the rows (JAMA-style grey row rules): under the header and under every data row. */
function jamaRules(): RuleLine[] {
  const ys = [176.5, 142.5, 130.5, 118.5, 106.5, 94.5]; // 4.5 pt under each row's baseline
  return ys.map((y) => ({ orientation: 'horizontal', x0: 45, y0: y, x1: 360, y1: y, thickness: 0.25 }));
}

function build(items = jamaItems(), rules: RuleLine[] = [], fills = []) {
  const result = buildTableCells({ page: 1, tableId: 1, items: refs(items), rules, fills });
  if (!result.ok) throw new Error(`table not resolved: ${result.reason}`);
  return result;
}

function cellWithText(cells: ResolvedCell[], text: string): ResolvedCell {
  const found = cells.filter((c) => c.text === text);
  if (found.length !== 1) throw new Error(`expected exactly one cell "${text}", found ${found.length}: ${cells.map((c) => c.text).join(' | ')}`);
  return found[0];
}

/** CJK and fullwidth characters are 1 em wide, Latin 0.5 em, spaces 0.25 em. */
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

function cellInfo(overrides: Partial<TableCellInfo> = {}): TableCellInfo {
  return {
    id: 'p1-t1-r0c0',
    kind: 'table',
    page: 1,
    tableId: 1,
    rowIndex: 0,
    columnIndex: 0,
    colSpan: 1,
    sourceItemIds: [0],
    textBox: { x: 50, y: 100, width: 60, height: 8.4 },
    usable: { x: 49, y: 98, width: 100, height: 12 },
    alignment: 'left',
    fontSize: 8,
    numeric: false,
    header: false,
    trailingMarker: null,
    background: null,
    maskable: true,
    textOnDark: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cell clustering (tests 1–8)
// ---------------------------------------------------------------------------

describe('table cell clustering', () => {
  it('finds the rows and columns of the fixture', () => {
    const r = build();
    expect(r.columns).toBe(4);
    expect(r.rows).toBe(10);
  });

  it('1. keeps a single-line cell as one cell with its own text', () => {
    const r = build();
    const female = cellWithText(r.cells, 'Female');
    expect(female.info.columnIndex).toBe(0);
    expect(female.info.numeric).toBe(false);
    expect(female.fragments).toHaveLength(1);
  });

  it('2. merges the wrapped lines of a row label into one cell', () => {
    const r = build();
    const label = cellWithText(r.cells, 'Time from last interview to death, mean (SD)');
    expect(label.fragments).toHaveLength(3);
    expect(label.info.rowIndex).toBe(3);
    expect(label.info.textBox.height).toBeGreaterThan(20); // spans three baselines
    expect(r.cells.some((c) => c.text === 'interview to death,')).toBe(false);
    expect(r.cells.some((c) => c.text === 'mean (SD)')).toBe(false);
  });

  it('3. merges a wrapped column header and keeps the spanning header as one cell', () => {
    const r = build();
    const header = cellWithText(r.cells, 'Observed No. (weighted %)');
    expect(header.info.header).toBe(true);
    expect(header.info.columnIndex).toBe(1);
    const spanning = cellWithText(r.cells, 'Bedbound (n = 590)');
    expect(spanning.info.colSpan).toBe(2);
    expect(spanning.info.alignment).toBe('center');
  });

  it('4. keeps a superscript footnote marker in its cell, out of the text', () => {
    const r = build();
    const medicaid = cellWithText(r.cells, 'Medicaid');
    expect(medicaid.info.trailingMarker).toBe('d');
    expect(medicaid.info.sourceItemIds).toHaveLength(2);
    expect(r.cells.some((c) => c.text === 'd')).toBe(false);
    const count = cellWithText(r.cells, 'Missing count');
    expect(count.info.trailingMarker).toBe('b');
  });

  it('5. does not merge adjacent columns', () => {
    const r = build();
    const row = r.cells.filter((c) => c.info.rowIndex === 6);
    expect(row.map((c) => c.text)).toEqual(['Female', '389 (63.0)', '0', '<.001']);
    expect(new Set(row.map((c) => c.info.columnIndex)).size).toBe(4);
  });

  it('6. does not merge adjacent rows', () => {
    const r = build();
    expect(cellWithText(r.cells, 'Female').info.rowIndex).toBe(6);
    expect(cellWithText(r.cells, 'Male').info.rowIndex).toBe(7);
    expect(cellWithText(r.cells, '389 (63.0)').info.rowIndex).toBe(6);
    expect(cellWithText(r.cells, '201 (37.0)').info.rowIndex).toBe(7);
    // rules between rows block merging even when a line starts lowercase
    const items = jamaItems().map((it) => (it.text === 'Male' ? { ...it, text: 'male' } : it));
    const withRules = build(items, jamaRules());
    expect(withRules.cells.some((c) => c.text === 'male')).toBe(true);
  });

  it('7. detects numeric cells', () => {
    const r = build();
    for (const text of ['389 (63.0)', '.05', '35', '4.9 (0.2)']) expect(cellWithText(r.cells, text).info.numeric).toBe(true);
    for (const text of ['0', '<.001']) {
      const cells = r.cells.filter((c) => c.text === text);
      expect(cells.length).toBeGreaterThanOrEqual(3);
      for (const c of cells) expect(c.info.numeric).toBe(true);
    }
    for (const text of ['Female', 'Medicaid', 'P value', 'Characteristic']) expect(cellWithText(r.cells, text).info.numeric).toBe(false);
  });

  it('8. keeps a mixed text + number cell as one translatable cell', () => {
    const r = build();
    const mixed = cellWithText(r.cells, 'Female 389 (63.0)');
    expect(mixed.info.numeric).toBe(false);
    expect(mixed.info.columnIndex).toBe(0);
    expect(mixed.info.colSpan).toBe(1);
  });

  it('gives every cell a usable rectangle inside its column and row bands', () => {
    const r = build(jamaItems(), jamaRules());
    for (const c of r.cells) {
      const { textBox, usable } = c.info;
      expect(usable.x).toBeLessThanOrEqual(textBox.x + 1e-6);
      expect(usable.x + usable.width).toBeGreaterThanOrEqual(textBox.x + textBox.width - 1e-6);
      // A rule right above the row may trim the generous 0.8 em ascent allowance a little, never the glyphs.
      expect(usable.y).toBeLessThanOrEqual(textBox.y + 0.1 * FS);
      expect(usable.y + usable.height).toBeGreaterThanOrEqual(textBox.y + textBox.height - 0.25 * FS);
    }
    // neighbouring cells of one row never overlap horizontally
    const row = r.cells.filter((c) => c.info.rowIndex === 6).sort((a, b) => a.info.columnIndex - b.info.columnIndex);
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1].info.usable;
      expect(row[i].info.usable.x).toBeGreaterThanOrEqual(prev.x + prev.width - 1e-6);
    }
  });

  it('refuses a table without column structure', () => {
    const items = [item('Only one column', 50, 200), item('another line', 50, 188), item('third', 50, 176)];
    const result = buildTableCells({ page: 1, tableId: 1, items: refs(items), rules: [], fills: [] });
    expect(result.ok).toBe(false);
  });

  it('takes the cell background from the fill under it, whatever its lightness', () => {
    const box = { x: 50, y: 100, width: 60, height: 8 };
    const fill = (color: string) => [{ x: 40, y: 95, width: 200, height: 20, color }];
    expect(backgroundAt(box, fill('#f4f3ec'))).toBe('#f4f3ec');
    expect(backgroundAt(box, fill('#adadad'))).toBe('#adadad');
    expect(backgroundAt(box, fill('#202020'))).toBe('#202020'); // dark boxes keep their colour, text turns white
    expect(backgroundAt(box, fill('#ffffff'))).toBeNull(); // white is plain paper
    expect(backgroundAt(box, [{ x: 400, y: 95, width: 20, height: 20, color: '#f4f3ec' }])).toBeNull();
  });

  it('reports a background it cannot sample reliably', () => {
    const box = { x: 50, y: 100, width: 60, height: 8 };
    const one = sampleBackground(box, [{ x: 40, y: 95, width: 200, height: 20, color: '#f4f3ec' }]);
    expect(one).toEqual({ color: '#f4f3ec', ambiguous: false });
    // two fills meeting inside the glyph box
    const split = sampleBackground(box, [
      { x: 40, y: 95, width: 40, height: 20, color: '#f4f3ec' },
      { x: 80, y: 95, width: 160, height: 20, color: '#c0d0e0' },
    ]);
    expect(split.ambiguous).toBe(true);
    // a raster image under the text
    const overImage = sampleBackground(box, [], [{ x: 0, y: 0, width: 300, height: 300 }]);
    expect(overImage.ambiguous).toBe(true);
  });

  it('picks the text colour by WCAG contrast', () => {
    expect(textColorFor(null)).toBe('dark');
    expect(textColorFor('#f4f3ec')).toBe('dark');
    expect(textColorFor('#f1bf83')).toBe('dark'); // the flowchart's orange box
    expect(textColorFor('#1f3864')).toBe('light'); // a dark navy header bar
    expect(textColorFor('#000000')).toBe('light');
    // every solid colour reaches the minimum with black or white text
    for (const hex of ['#767676', '#808080', '#595959', '#a0a0a0']) {
      const choice = textColorFor(hex);
      expect(choice, hex).not.toBeNull();
      const l = relativeLuminance(hex);
      expect(contrastRatio(l, choice === 'light' ? 1 : 0)).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    }
  });

  it('keeps statistical notation out of the API', () => {
    for (const t of ['OR (95% CI)', 'HR (95% CI)', 'aOR (95% CI)', 'SD', 'n (%)', 'P', 'RR', 'N']) {
      expect(isStatNotationOnly(t), t).toBe(true);
    }
    for (const t of ['Odds ratio (95% CI)', 'Variable', 'Female', 'mean (SD)', 'Age at death']) {
      expect(isStatNotationOnly(t), t).toBe(false);
    }
    // "No" is an answer in a flowchart, not the count abbreviation: it is translated
    for (const t of ['No', 'Yes', 'No. (%)']) expect(isStatNotationOnly(t), t).toBe(false);
  });
});

describe('isNumericTableCell', () => {
  it('accepts numbers, statistics, ranges, p-values, n =, placeholders and short units', () => {
    for (const t of ['389 (63.0)', '0', '13.23', '<.001', 'P < .05', '12–15', '5.2 ± 1.1', 'n = 590', '(n = 590)', '—', 'NA', 'N/A', '85.9 y', '12 mo', '63.0%', '0.12 [0.05-0.33]', '12.3a', '0*']) {
      expect(isNumericTableCell(t), t).toBe(true);
    }
  });

  it('rejects text cells, mixed cells and labels with statistical notation', () => {
    for (const t of ['Female', 'Female 389 (63.0)', 'mean (SD)', 'Difference, %', 'Observed No. (weighted %)', 'Reference', '']) {
      expect(isNumericTableCell(t), t).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fitting (tests 9–17)
// ---------------------------------------------------------------------------

describe('fitTextToTableCell', () => {
  it('9. keeps the original size when the text fits', () => {
    const r = fitTextToTableCell({ text: '女性', width: 100, height: 12, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBe(8);
    expect(r.lines).toEqual(['女性']);
    expect(r.lineHeight).toBeCloseTo(8 * TABLE_LINE_HEIGHT_RATIO);
  });

  it('10. wraps Chinese over several lines inside the cell', () => {
    const r = fitTextToTableCell({ text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', width: 80, height: 30, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBe(8);
    expect(r.lines).toEqual(['一二三四五六七八九十', '甲乙丙丁戊己庚辛壬癸']);
    expect(r.totalHeight).toBeLessThanOrEqual(30);
  });

  it('11. shrinks the font in 0.25 pt steps until one line fits the width', () => {
    // 12 ideographs: 96 pt at 8 pt, 78 pt at 6.5 pt (81 pt at 6.75 pt does not fit 80 pt)
    const r = fitTextToTableCell({ text: '一二三四五六七八九十甲乙', width: 80, height: 9, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBe(6.5);
    expect(r.lines).toHaveLength(1);
  });

  it('12. never goes below 5 pt', () => {
    const r = fitTextToTableCell({ text: '一二三四五六七八九十'.repeat(3), width: 60, height: 8, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(false);
    expect(r.fontSize).toBe(TABLE_MIN_FONT_SIZE);
    expect(r.minFontSize).toBe(TABLE_MIN_FONT_SIZE);
    const configured = fitTextToTableCell({ text: '一二三四五六七八九十'.repeat(3), width: 60, height: 8, originalFontSize: 8, font: fakeFont, minFontSize: 3 });
    expect(configured.minFontSize).toBe(TABLE_MIN_FONT_SIZE);
  });

  it('13. tightens the line height before shrinking the font', () => {
    // two lines at 8 pt: 17.6 pt tall at 1.15, 17.04 pt at 1.08 → a 17.2 pt cell fits only with the tight leading
    const r = fitTextToTableCell({ text: '一二三四五六七八九十甲乙丙丁戊', width: 80, height: 17.2, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBe(8);
    expect(r.lines).toHaveLength(2);
    expect(r.lineHeight).toBeCloseTo(8 * TABLE_LINE_HEIGHT_TIGHT);
    expect(r.lineHeight).toBeGreaterThanOrEqual(8 * (GLYPH_ASCENT + GLYPH_DESCENT)); // glyph boxes never collide
  });

  it('14. never extends below the cell: a fit is inside the height or it is no fit', () => {
    for (const height of [8, 10, 12, 17, 20, 30]) {
      const r = fitTextToTableCell({ text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', width: 80, height, originalFontSize: 8, font: fakeFont });
      if (r.fits) expect(r.totalHeight).toBeLessThanOrEqual(height + 1e-6);
      else expect(r.totalHeight).toBeGreaterThan(height);
      expect('extended' in r).toBe(false);
    }
  });

  it('15. placed lines never cross the row boundary', () => {
    const cell = cellInfo({ usable: { x: 49, y: 98, width: 100, height: 20 }, textBox: { x: 50, y: 108, width: 60, height: 8.4 } });
    const fit = fitTextToTableCell({ text: '一二三四五六七八九十甲乙丙丁戊', width: 100, height: 20, originalFontSize: 8, font: fakeFont });
    expect(fit.fits).toBe(true);
    const placed = placeTableCellLines(cell, fit, fakeFont);
    expect(placed.lines).toHaveLength(2);
    const top = placed.lines[0].y + GLYPH_ASCENT * fit.fontSize;
    const bottom = placed.lines[placed.lines.length - 1].y - GLYPH_DESCENT * fit.fontSize;
    expect(top).toBeLessThanOrEqual(cell.usable.y + cell.usable.height + 1e-6);
    expect(bottom).toBeGreaterThanOrEqual(cell.usable.y - 1e-6);
  });

  it('16. placed lines never cross the column boundary, for every alignment', () => {
    for (const alignment of ['left', 'center', 'right'] as const) {
      const cell = cellInfo({ alignment, usable: { x: 49, y: 98, width: 70, height: 20 }, textBox: { x: 50, y: 108, width: 60, height: 8.4 } });
      const width = alignment === 'left' ? cell.usable.x + cell.usable.width - cell.textBox.x : alignment === 'right' ? cell.textBox.x + cell.textBox.width - cell.usable.x : cell.usable.width;
      const fit = fitTextToTableCell({ text: '差異，% 值 abc', width, height: 20, originalFontSize: 8, font: fakeFont });
      expect(fit.fits).toBe(true);
      const placed = placeTableCellLines(cell, fit, fakeFont);
      for (const line of placed.lines) {
        expect(line.x).toBeGreaterThanOrEqual(cell.usable.x - 1e-6);
        expect(line.x + line.width).toBeLessThanOrEqual(cell.usable.x + cell.usable.width + 0.3);
      }
    }
  });

  it('17. reports overflow (the caller keeps the English cell) instead of clipping or extending', () => {
    const r = fitTextToTableCell({ text: '一二三四五六七八九十'.repeat(4), width: 60, height: 10, originalFontSize: 8, font: fakeFont });
    expect(r.fits).toBe(false);
    expect(r.reason).toBe('HEIGHT');
    expect(r.overflow).toBeGreaterThan(0);
    expect(r.lines.join('')).toBe('一二三四五六七八九十'.repeat(4)); // nothing was cut
  });

  it('accounts for the footnote marker on the last line', () => {
    const without = fitTextToTableCell({ text: '一二三四五六七八九十', width: 80, height: 10, originalFontSize: 8, font: fakeFont });
    expect(without.fontSize).toBe(8);
    const withMarker = fitTextToTableCell({ text: '一二三四五六七八九十', width: 80, height: 10, originalFontSize: 8, font: fakeFont, trailingMarker: 'd' });
    expect(withMarker.fits).toBe(true);
    expect(withMarker.fontSize).toBeLessThan(8);
    const cell = cellInfo({ trailingMarker: 'd', usable: { x: 49, y: 98, width: 80, height: 10 } });
    const placed = placeTableCellLines(cell, withMarker, fakeFont);
    expect(placed.marker).not.toBeNull();
    expect(placed.marker?.text).toBe('d');
    expect(placed.marker?.y).toBeGreaterThan(placed.lines[0].y);
  });
});

// ---------------------------------------------------------------------------
// Masks (tests 18–23)
// ---------------------------------------------------------------------------

describe('tableCellMaskRects', () => {
  const lines = [
    { x: 50, right: 110, top: 106.4, bottom: 98 },
    { x: 50, right: 90, top: 97.4, bottom: 89 },
  ];
  const cell = cellInfo({ textBox: { x: 50, y: 89, width: 60, height: 17.4 }, usable: { x: 49, y: 87.5, width: 100, height: 20.4 } });

  it('18. the union of the masks covers every source line', () => {
    const masks = tableCellMaskRects(cell, lines);
    expect(masks).toHaveLength(2);
    lines.forEach((line, i) => {
      const m = masks[i];
      expect(m.x).toBeLessThanOrEqual(line.x);
      expect(m.x + m.width).toBeGreaterThanOrEqual(line.right);
      expect(m.y).toBeLessThanOrEqual(line.bottom);
      expect(m.y + m.height).toBeGreaterThanOrEqual(line.top);
    });
  });

  it('19. every mask stays inside the cell', () => {
    for (const m of tableCellMaskRects(cell, lines)) {
      expect(m.x).toBeGreaterThanOrEqual(cell.usable.x);
      expect(m.x + m.width).toBeLessThanOrEqual(cell.usable.x + cell.usable.width);
      expect(m.y).toBeGreaterThanOrEqual(cell.usable.y);
      expect(m.y + m.height).toBeLessThanOrEqual(cell.usable.y + cell.usable.height);
    }
  });

  it('20. horizontal borders are preserved', () => {
    const r = build(jamaItems(), jamaRules());
    for (const c of r.cells) {
      const boxes = c.fragments.map((f) => ({ x: f.x, right: f.right, top: f.top, bottom: f.bottom }));
      for (const m of tableCellMaskRects(c.info, boxes)) {
        for (const rule of jamaRules()) {
          const half = rule.thickness / 2;
          const crosses = m.y < rule.y0 + half && m.y + m.height > rule.y0 - half;
          expect(crosses, `${c.text} mask crosses rule at ${rule.y0}`).toBe(false);
        }
      }
      // and the usable area itself keeps the clearance
      const below = jamaRules().find((rule) => rule.y0 < c.info.textBox.y && rule.y0 > c.info.textBox.y - 6);
      if (below) expect(c.info.usable.y).toBeGreaterThanOrEqual(below.y0 + below.thickness / 2 + BORDER_CLEARANCE - 1e-6);
    }
  });

  it('21. vertical borders are preserved', () => {
    const vertical: RuleLine[] = [
      { orientation: 'vertical', x0: 190, y0: 90, x1: 190, y1: 210, thickness: 0.5 },
      { orientation: 'vertical', x0: 305, y0: 90, x1: 305, y1: 210, thickness: 0.5 },
    ];
    const r = build(jamaItems(), vertical);
    for (const c of r.cells) {
      const boxes = c.fragments.map((f) => ({ x: f.x, right: f.right, top: f.top, bottom: f.bottom }));
      for (const m of tableCellMaskRects(c.info, boxes)) {
        for (const rule of vertical) {
          const half = rule.thickness / 2;
          const crosses = m.x < rule.x0 + half && m.x + m.width > rule.x0 - half;
          expect(crosses, `${c.text} mask crosses vertical rule at ${rule.x0}`).toBe(false);
        }
      }
    }
    const observed = cellWithText(r.cells, 'Observed No. (weighted %)');
    expect(observed.info.usable.x).toBeGreaterThanOrEqual(190 + 0.25 + BORDER_CLEARANCE - 1e-6);
    const spanning = cellWithText(r.cells, 'Bedbound (n = 590)');
    expect(spanning.info.usable.x + spanning.info.usable.width).toBeLessThanOrEqual(305 - 0.25 - BORDER_CLEARANCE + 1e-6);
  });

  it('22. masks never touch the text of neighbouring cells', () => {
    const r = build(jamaItems(), jamaRules());
    for (const c of r.cells) {
      const boxes = c.fragments.map((f) => ({ x: f.x, right: f.right, top: f.top, bottom: f.bottom }));
      const masks = tableCellMaskRects(c.info, boxes);
      for (const other of r.cells) {
        if (other === c) continue;
        const t = other.info.textBox;
        for (const m of masks) {
          const overlapX = Math.min(m.x + m.width, t.x + t.width) - Math.max(m.x, t.x);
          const overlapY = Math.min(m.y + m.height, t.y + t.height) - Math.max(m.y, t.y);
          expect(overlapX > 0 && overlapY > 0, `mask of "${c.text}" touches "${other.text}"`).toBe(false);
        }
      }
    }
  });

  it('keeps a caption mask off the table border right under it (clipMaskToRules)', () => {
    // 12 pt caption at baseline 501.6, mask pad reaching 497.6; the table's top border is at 498.2
    const mask = { x: 70, y: 497.6, width: 250, height: 14 };
    const rules: RuleLine[] = [{ orientation: 'horizontal', x0: 72, y0: 498.2, x1: 320, y1: 498.2, thickness: 0.6 }];
    const clipped = clipMaskToRules(mask, 501.6, 12, rules);
    expect(clipped.y).toBeGreaterThanOrEqual(498.2 + 0.3 + 0.5); // clear of the rule (its edge is at 498.5)
    expect(clipped.y).toBeLessThanOrEqual(501.6 - 0.2 * 12 + 1e-6); // descenders still masked
    expect(clipped.y + clipped.height).toBeCloseTo(mask.y + mask.height);
    // a rule elsewhere on the page changes nothing
    const far = clipMaskToRules(mask, 501.6, 12, [{ orientation: 'horizontal', x0: 72, y0: 430, x1: 320, y1: 430, thickness: 0.6 }]);
    expect(far).toEqual(mask);
    const aside = clipMaskToRules(mask, 501.6, 12, [{ orientation: 'horizontal', x0: 400, y0: 498.2, x1: 500, y1: 498.2, thickness: 0.6 }]);
    expect(aside).toEqual(mask);
  });

  it('pulls a mask off a border it only reaches into (clipMaskOffRules)', () => {
    const mask = { x: 70, y: 100, width: 100, height: 12 };
    const rules: RuleLine[] = [
      { orientation: 'horizontal', x0: 60, y0: 99.5, x1: 200, y1: 99.5, thickness: 0.5 }, // just under the mask
      { orientation: 'vertical', x0: 170.4, y0: 90, x1: 170.4, y1: 130, thickness: 0.5 }, // just right of it
      { orientation: 'horizontal', x0: 60, y0: 60, x1: 200, y1: 60, thickness: 0.5 }, // far away
    ];
    const clipped = clipMaskOffRules(mask, rules);
    expect(clipped.y).toBeGreaterThanOrEqual(99.5 + 0.25 + BORDER_CLEARANCE - 1e-6);
    expect(clipped.x + clipped.width).toBeLessThanOrEqual(170.4 - 0.25 - BORDER_CLEARANCE + 1e-6);
    expect(clipped.y + clipped.height).toBeCloseTo(mask.y + mask.height); // the far rule changes nothing
    expect(clipped.x).toBeCloseTo(mask.x);
    // a rule drawn through the middle of the text is not an edge: the glyphs stay covered
    const through = clipMaskOffRules(mask, [{ orientation: 'horizontal', x0: 60, y0: 106, x1: 200, y1: 106, thickness: 0.5 }]);
    expect(through).toEqual(mask);
  });

  it('23. does not over-mask the whitespace around a short line', () => {
    const masks = tableCellMaskRects(cell, lines);
    lines.forEach((line, i) => {
      const m = masks[i];
      expect(m.width).toBeLessThanOrEqual(line.right - line.x + 2 * TABLE_MASK_PAD + 1e-6);
      expect(m.height).toBeLessThanOrEqual(line.top - line.bottom + 2 * TABLE_MASK_PAD + 1e-6);
    });
    // the second (shorter) line's mask is narrower than the first's
    expect(masks[1].width).toBeLessThan(masks[0].width);
  });
});

// ---------------------------------------------------------------------------
// Translation units (tests 24–28)
// ---------------------------------------------------------------------------

function analysisWithTable(): PdfAnalysis {
  const items = [item('Table 1. Characteristics of decedents by bedbound status.', 50, 222, 9), ...jamaItems(), item('Note: values are mean (SD).', 50, 80, 7)];
  return {
    fileName: 'table.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        rotation: 0,
        view: [0, 0, 612, 792],
        textItemCount: items.length,
        images: [],
        rules: jamaRules(),
        fills: [],
        frames: [],
      },
    ],
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
  };
}

describe('table translation units', () => {
  it('24. one logical cell = one translation unit', () => {
    const layout = analyzeLayout(analysisWithTable());
    expect(layout.tables).toHaveLength(1);
    expect(layout.tables[0].resolved).toBe(true);
    const cells = layout.blocks.filter((b) => b.cell);
    expect(cells.length).toBe(layout.tables[0].cells);
    const units = layout.translationBlocks.filter((u) => u.type === 'TABLE');
    expect(units.length).toBe(cells.filter((b) => b.translate).length);
    for (const u of units) {
      expect(u.sourceBlockIds).toHaveLength(1);
      expect(u.wasMerged).toBe(false);
      expect(layout.blocks.find((b) => b.id === u.sourceBlockIds[0])?.cell).toBeDefined();
    }
  });

  it('25. several text items of one cell produce one translation, never duplicates', () => {
    const layout = analyzeLayout(analysisWithTable());
    const texts = layout.translationBlocks.filter((u) => u.type === 'TABLE').map((u) => u.text);
    expect(texts.filter((t) => t === 'Time from last interview to death, mean (SD)')).toHaveLength(1);
    expect(texts).not.toContain('interview to death,');
    expect(texts).not.toContain('mean (SD)');
    expect(new Set(layout.translationBlocks.map((u) => u.id)).size).toBe(layout.translationBlocks.length);
  });

  it('26. numeric-only cells are not translation units (no provider call)', () => {
    const layout = analyzeLayout(analysisWithTable());
    const numeric = layout.blocks.filter((b) => b.cell?.numeric);
    expect(numeric.length).toBeGreaterThanOrEqual(14);
    for (const b of numeric) {
      expect(b.translate).toBe(false);
      expect(b.skipReason).toBe('NUMERIC_ONLY');
    }
    const unitIds = new Set(layout.translationBlocks.flatMap((u) => u.sourceBlockIds));
    for (const b of numeric) expect(unitIds.has(b.id)).toBe(false);
    expect(layout.stats.tableNumericCells).toBe(numeric.length);
  });

  it('27. a long row label is translated once, as one unit', () => {
    const layout = analyzeLayout(analysisWithTable());
    const units = layout.translationBlocks.filter((u) => u.text === 'Time from last interview to death, mean (SD)');
    expect(units).toHaveLength(1);
    expect(units[0].blockType).toBe('TABLE_TEXT_LABEL');
  });

  it('28. a wrapped header cell is translated once, as one unit', () => {
    const layout = analyzeLayout(analysisWithTable());
    const units = layout.translationBlocks.filter((u) => u.text === 'Observed No. (weighted %)');
    expect(units).toHaveLength(1);
    expect(units[0].blockType).toBe('TABLE_HEADER');
    expect(layout.translationBlocks.filter((u) => u.text === 'Bedbound (n = 590)')).toHaveLength(1);
  });

  it('keeps the table in English when its cells cannot be resolved', () => {
    const a = analysisWithTable();
    // one column only: every row is a single fragment
    a.items = [a.items[0], item('Alpha', 50, 200), item('Beta', 50, 188), item('Gamma', 50, 176), item('Note: values are mean (SD).', 50, 80, 7)];
    a.textItemCount = a.items.length;
    a.pages[0].textItemCount = a.items.length;
    const layout = analyzeLayout(a);
    expect(layout.tables).toHaveLength(1);
    expect(layout.tables[0].resolved).toBe(false);
    for (const b of layout.blocks.filter((b) => b.type === 'TABLE')) {
      expect(b.translate).toBe(false);
      expect(b.skipReason).toMatch(/^TABLE_UNRESOLVED/);
    }
  });
});
