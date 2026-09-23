/**
 * Figure text elements: region detection, box containers, loose-label bounds
 * and the guarantee that a figure's text never becomes paragraphs again
 * (pdf/figure.ts, plus the layout that puts it to work).
 */
import { describe, expect, it } from 'vitest';
import { buildFigureCells, detectFigureRegions, expandBox, leafContainers, ruleRect, type FigureCaptionRef } from '../figure';
import { analyzeLayout } from '../layout';
import { tableCellMaskRects, type ResolvedCell, type TableItemRef } from '../table';
import type { FilledRect, FrameRect, PdfAnalysis, Rect, RuleLine, TextItemDebug } from '../types';

// ---------------------------------------------------------------------------
// Fixtures: a small flowchart and a small forest plot
// ---------------------------------------------------------------------------

const FS = 6.5;
const CHAR = 0.5;
const VIEW = [0, 0, 612, 792];

function item(text: string, x: number, y: number, fontSize = FS): TextItemDebug {
  return {
    page: 1,
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

function fill(x: number, y: number, width: number, height: number, color: string | null): FilledRect {
  return { x, y, width, height, color };
}

/**
 * Three boxes and two connectors:
 *
 *   [ In the last month, how often did you go outside? ]   ← light blue
 *        │
 *   [ Never ]   [ Yes ]                                    ← orange, side by side
 */
function flowchartFills(): FilledRect[] {
  return [
    fill(60, 300, 200, 20, '#ebf2f5'),
    fill(60, 260, 40, 14, '#ffe5cc'),
    fill(120, 260, 40, 14, '#f1bf83'),
    fill(50, 250, 230, 80, '#ececed'), // group box around them all
  ];
}

function flowchartRules(): RuleLine[] {
  return [
    { orientation: 'vertical', x0: 80, y0: 274, x1: 80, y1: 300, thickness: 0.5 },
    { orientation: 'vertical', x0: 140, y0: 274, x1: 140, y1: 300, thickness: 0.5 },
    { orientation: 'horizontal', x0: 80, y0: 288, x1: 140, y1: 288, thickness: 0.5 },
  ];
}

function flowchartItems(): TextItemDebug[] {
  return [
    item('In the last month, how often did', 70, 312),
    item('you go outside?', 70, 304),
    item('Never', 66, 265),
    item('Yes', 128, 265),
  ];
}

/** Enough vector elements for a cluster, in a band the caption sits above. */
function plotRules(): RuleLine[] {
  const out: RuleLine[] = [{ orientation: 'horizontal', x0: 200, y0: 96, x1: 390, y1: 96, thickness: 0.5 }];
  for (let i = 0; i < 8; i++) {
    const y = 110 + i * 10;
    out.push({ orientation: 'horizontal', x0: 230, y0: y, x1: 280, y1: y, thickness: 0.4 });
  }
  return out;
}

/** Variable | OR (95% CI), eight rows, label and value on one baseline. */
function plotItems(): TextItemDebug[] {
  const rows = [
    ['Variable', 'OR (95% CI)'],
    ['Age at death (z score)', '1.34 (1.10-1.63)'],
    ['Months before death', '1.49 (1.25-1.77)'],
    ['Female vs male', '1.81 (1.26-2.61)'],
    ['Married', '1.00 (0.63-1.60)'],
    ['Frail', '4.16 (2.87-6.03)'],
    ['Probable dementia', '4.58 (3.09-6.79)'],
    ['Self-rated poor health', '2.13 (1.47-3.10)'],
  ];
  return rows.flatMap(([label, value], i) => {
    const y = 180 - i * 10;
    return [item(label, 50, y), item(value, 157, y)];
  });
}

const CAPTION: FigureCaptionRef = { id: 'p1-b001', box: { x: 48, y: 340, width: 300, height: 8 } };
const PLOT_CAPTION: FigureCaptionRef = { id: 'p1-b001', box: { x: 48, y: 196, width: 300, height: 8 } };

function cellWithText(cells: readonly ResolvedCell[], text: string): ResolvedCell {
  const found = cells.filter((c) => c.text === text);
  if (found.length !== 1) throw new Error(`expected one cell "${text}", got ${found.length}: ${cells.map((c) => c.text).join(' | ')}`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Region detection
// ---------------------------------------------------------------------------

describe('detectFigureRegions', () => {
  const page = { fills: flowchartFills(), frames: [] as FrameRect[], rules: flowchartRules(), view: VIEW };

  it('needs a figure caption and a dense vector cluster', () => {
    const regions = detectFigureRegions(page, [CAPTION]);
    expect(regions).toHaveLength(1);
    expect(regions[0].captionId).toBe(CAPTION.id);
    expect(regions[0].bounds.x).toBeLessThanOrEqual(50);
    expect(regions[0].bounds.y + regions[0].bounds.height).toBeGreaterThanOrEqual(330);
  });

  it('finds nothing without a caption', () => {
    expect(detectFigureRegions(page, [])).toHaveLength(0);
  });

  it('finds nothing when the caption is far away', () => {
    expect(detectFigureRegions(page, [{ id: 'x', box: { x: 48, y: 700, width: 300, height: 8 } }])).toHaveLength(0);
  });

  it('finds nothing in a sparse drawing', () => {
    const sparse = { fills: [fill(60, 300, 200, 20, '#ebf2f5')], frames: [], rules: [], view: VIEW };
    expect(detectFigureRegions(sparse, [CAPTION])).toHaveLength(0);
  });

  it('does not let a running header or footer rule stretch the region', () => {
    const furniture: RuleLine[] = [
      ...flowchartRules(),
      { orientation: 'horizontal', x0: 47.9, y0: 61.5, x1: 562.8, y1: 61.5, thickness: 0.25 },
      { orientation: 'horizontal', x0: 47.9, y0: 742, x1: 562.8, y1: 742, thickness: 0.25 },
    ];
    const regions = detectFigureRegions({ ...page, rules: furniture }, [CAPTION]);
    expect(regions).toHaveLength(1);
    expect(regions[0].bounds.x + regions[0].bounds.width).toBeLessThan(400);
    expect(regions[0].bounds.y).toBeGreaterThan(200);
  });

  it('resolves a plot that is only ruling lines', () => {
    const regions = detectFigureRegions({ fills: [], frames: [], rules: plotRules(), view: VIEW }, [PLOT_CAPTION]);
    expect(regions).toHaveLength(1);
  });
});

describe('leafContainers', () => {
  const region: Rect = { x: 40, y: 240, width: 260, height: 100 };

  it('keeps the innermost boxes and drops the group box around them', () => {
    const containers = leafContainers(region, flowchartFills(), []);
    expect(containers).toHaveLength(3);
    expect(containers.every((c) => c.box.width <= 200)).toBe(true);
  });

  it('counts a node drawn as a fill plus a matching outline once', () => {
    const frames: FrameRect[] = [{ x: 59.7, y: 299.7, width: 200.6, height: 20.6, thickness: 0.6 }];
    const containers = leafContainers(region, flowchartFills(), frames);
    expect(containers).toHaveLength(3);
    expect(containers.find((c) => c.box.width > 150)?.color).toBe('#ebf2f5');
  });

  it('gives every container an interior inside its own border', () => {
    for (const c of leafContainers(region, flowchartFills(), [])) {
      expect(c.inner.x).toBeGreaterThan(c.box.x);
      expect(c.inner.y).toBeGreaterThan(c.box.y);
      expect(c.inner.x + c.inner.width).toBeLessThan(c.box.x + c.box.width);
      expect(c.inner.y + c.inner.height).toBeLessThan(c.box.y + c.box.height);
    }
  });
});

describe('expandBox', () => {
  it('grows into free space but never over an obstacle', () => {
    const text: Rect = { x: 100, y: 100, width: 40, height: 8 };
    const obstacles: Rect[] = [
      { x: 60, y: 96, width: 30, height: 12 }, // left
      { x: 160, y: 96, width: 30, height: 12 }, // right
      { x: 90, y: 120, width: 60, height: 8 }, // above
      { x: 90, y: 80, width: 60, height: 8 }, // below
    ];
    const limit: Rect = { x: 0, y: 0, width: 600, height: 700 };
    const r = expandBox(text, obstacles, limit);
    expect(r.x).toBeGreaterThanOrEqual(90);
    expect(r.x + r.width).toBeLessThanOrEqual(160);
    expect(r.y).toBeGreaterThanOrEqual(88);
    expect(r.y + r.height).toBeLessThanOrEqual(120);
    // the text itself always stays covered
    expect(r.x).toBeLessThanOrEqual(text.x);
    expect(r.x + r.width).toBeGreaterThanOrEqual(text.x + text.width);
  });

  it('treats a ruling line as an obstacle', () => {
    const text: Rect = { x: 100, y: 100, width: 40, height: 8 };
    const rule: RuleLine = { orientation: 'horizontal', x0: 60, y0: 96, x1: 200, y1: 96, thickness: 0.5 };
    const r = expandBox(text, [ruleRect(rule)], { x: 0, y: 0, width: 600, height: 700 });
    expect(r.y).toBeGreaterThanOrEqual(96.25);
  });
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

describe('buildFigureCells: flowchart', () => {
  const region: Rect = { x: 40, y: 240, width: 260, height: 100 };
  const build = () =>
    buildFigureCells({
      page: 1,
      figureId: 1,
      region,
      items: refs(flowchartItems()),
      rules: flowchartRules(),
      fills: flowchartFills(),
      frames: [],
      images: [],
    });

  it('makes one element per box and merges the wrapped lines inside it', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    expect(r.containers).toBe(3);
    const question = cellWithText(r.cells, 'In the last month, how often did you go outside?');
    expect(question.fragments).toHaveLength(2);
    expect(question.info.background).toBe('#ebf2f5');
    expect(question.info.kind).toBe('figure');
  });

  it('never merges two boxes that sit side by side', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    const never = cellWithText(r.cells, 'Never');
    const yes = cellWithText(r.cells, 'Yes');
    expect(never.info.background).toBe('#ffe5cc');
    expect(yes.info.background).toBe('#f1bf83');
    expect(never.info.id).not.toBe(yes.info.id);
    expect(r.cells.some((c) => c.text.includes('Never') && c.text.includes('Yes'))).toBe(false);
  });

  it('keeps every element inside its own box', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    const boxes = leafContainers(region, flowchartFills(), []);
    for (const cell of r.cells) {
      if (cell.info.id.includes('-l')) continue; // loose label, bounded by its neighbours
      const box = boxes.find((b) => b.box.x <= cell.info.textBox.x && b.box.x + b.box.width >= cell.info.textBox.x + cell.info.textBox.width);
      expect(box, cell.text).toBeDefined();
      const u = cell.info.usable;
      expect(u.x).toBeGreaterThanOrEqual((box as { box: Rect }).box.x);
      expect(u.x + u.width).toBeLessThanOrEqual((box as { box: Rect }).box.x + (box as { box: Rect }).box.width);
    }
  });

  it('masks only the glyph boxes and never the box outlines', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    for (const cell of r.cells) {
      const lines = cell.fragments.map((f) => ({ x: f.x, right: f.right, top: f.top, bottom: f.bottom }));
      for (const m of tableCellMaskRects(cell.info, lines)) {
        expect(m.x).toBeGreaterThanOrEqual(cell.info.usable.x - 1e-6);
        expect(m.x + m.width).toBeLessThanOrEqual(cell.info.usable.x + cell.info.usable.width + 1e-6);
        for (const rule of flowchartRules()) {
          const rr = ruleRect(rule);
          const overlapX = Math.min(m.x + m.width, rr.x + rr.width) - Math.max(m.x, rr.x);
          const overlapY = Math.min(m.y + m.height, rr.y + rr.height) - Math.max(m.y, rr.y);
          expect(overlapX > 0.2 && overlapY > 0.2, `${cell.text} mask covers a connector`).toBe(false);
        }
      }
    }
  });
});

describe('buildFigureCells: forest plot', () => {
  const region: Rect = { x: 45, y: 90, width: 350, height: 105 };
  const build = () =>
    buildFigureCells({
      page: 1,
      figureId: 3,
      region,
      items: refs(plotItems()),
      rules: plotRules(),
      fills: [],
      frames: [],
      images: [],
    });

  it('resolves the rows and columns of a plot with no boxes', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    expect(r.containers).toBe(0);
    expect(r.structured).toBe(true);
    expect(r.cells.length).toBe(16);
  });

  it('never merges a value with the label of the next row', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    for (const cell of r.cells) {
      expect(/\d\.\d\d \(.*\).+[A-Za-z]{4}/.test(cell.text), cell.text).toBe(false);
    }
    expect(cellWithText(r.cells, 'Female vs male').info.numeric).toBe(false);
    expect(cellWithText(r.cells, '1.81 (1.26-2.61)').info.numeric).toBe(true);
  });

  it('keeps every value and the OR header out of the API', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    expect(cellWithText(r.cells, 'OR (95% CI)').info.numeric).toBe(true);
    expect(r.cells.filter((c) => c.info.numeric)).toHaveLength(8);
    expect(cellWithText(r.cells, 'Variable').info.numeric).toBe(false);
  });

  it('gives each label a rectangle that stops before the value column', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    const label = cellWithText(r.cells, 'Age at death (z score)');
    expect(label.info.usable.x + label.info.usable.width).toBeLessThan(157);
    const value = cellWithText(r.cells, '1.34 (1.10-1.63)');
    expect(value.info.usable.x).toBeGreaterThanOrEqual(label.info.usable.x + label.info.usable.width - 1e-6);
  });

  it('rows never overlap vertically', () => {
    const r = build();
    if (!r.ok) throw new Error(r.reason);
    const column = r.cells.filter((c) => c.info.columnIndex === 0).sort((a, b) => b.info.usable.y - a.info.usable.y);
    for (let i = 1; i < column.length; i++) {
      const above = column[i - 1].info.usable;
      expect(column[i].info.usable.y + column[i].info.usable.height).toBeLessThanOrEqual(above.y + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the layout
// ---------------------------------------------------------------------------

function analysisWithFigure(): PdfAnalysis {
  const items = [
    item('Figure 1. Assessment of bedbound status.', 48, 340, 7.5),
    ...flowchartItems(),
    item('Flowchart shows the survey flow and skip logic used to classify bedbound status of respondents.', 420, 120, 7),
  ];
  return {
    fileName: 'figure.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        rotation: 0,
        view: VIEW,
        textItemCount: items.length,
        images: [],
        rules: flowchartRules(),
        fills: flowchartFills(),
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

describe('figures through the layout', () => {
  it('turns the figure text into FIGURE cells and leaves the caption alone', () => {
    const layout = analyzeLayout(analysisWithFigure());
    expect(layout.figures).toHaveLength(1);
    expect(layout.figures[0].resolved).toBe(true);
    const cells = layout.blocks.filter((b) => b.cell?.kind === 'figure');
    expect(cells.length).toBe(layout.figures[0].cells);
    for (const c of cells) {
      expect(c.type).toBe('FIGURE');
      expect(c.blockType).toBe('FIGURE_LABEL');
      expect(c.figureId).toBe(1);
      expect(c.tableId).toBeUndefined();
    }
    const caption = layout.blocks.find((b) => b.blockType === 'FIGURE_CAPTION');
    expect(caption?.cell).toBeUndefined();
    expect(caption?.translate).toBe(true);
  });

  it('gives one translation unit per figure element, with no duplicated source items', () => {
    const layout = analyzeLayout(analysisWithFigure());
    const units = layout.translationBlocks.filter((u) => u.type === 'FIGURE');
    expect(units.length).toBeGreaterThanOrEqual(3);
    for (const u of units) expect(u.sourceBlockIds).toHaveLength(1);
    expect(layout.stats.duplicateSourceItems).toBe(0);
    expect(new Set(layout.translationBlocks.map((u) => u.id)).size).toBe(layout.translationBlocks.length);
    // the two lines of one box are one unit, never two
    expect(units.filter((u) => u.text === 'In the last month, how often did you go outside?')).toHaveLength(1);
    expect(units.some((u) => u.text === 'you go outside?')).toBe(false);
  });

  it('can be switched off for an A/B comparison', () => {
    const layout = analyzeLayout(analysisWithFigure(), { resolveFigures: false });
    expect(layout.figures).toHaveLength(0);
    expect(layout.blocks.some((b) => b.cell?.kind === 'figure')).toBe(false);
  });
});
