/**
 * Figures: vector diagrams whose text must never be treated as paragraphs.
 *
 *   vector fills / frames / rules  →  proximity cluster  →  figure caption?
 *     → figure region
 *         → leaf boxes (filled or outlined) become text containers
 *             one box = one logical text element
 *         → loose text with no box:
 *             a regular grid (forest plot) → the table cell clustering
 *             otherwise → one element per text line, bounded by its neighbours
 *
 * Every element becomes a TableCellInfo, so the renderer writes it through the
 * cell path it already uses for table cells: the mask is the glyph union
 * clipped to the element's own rectangle and painted in the background colour,
 * the text is fitted without downward extension down to 5 pt, and an element
 * that still does not fit keeps its English.
 *
 * Detection is deliberately conservative. A figure is only resolved when a
 * figure caption and a dense vector cluster agree, which covers flowcharts,
 * box-and-arrow diagrams and structured statistical figures such as forest
 * plots. Anything else keeps its English rather than being guessed at.
 *
 * Pure functions, unit-tested in __tests__/figure.test.ts.
 */

import {
  buildTableCells,
  buildTextFragments,
  isNumericTableCell,
  isStatNotationOnly,
  sampleBackground,
  textColorFor,
  type Fragment,
  type ResolvedCell,
  type TableItemRef,
} from './table';
import { joinLines } from './text';
import type { CellAlignment, FilledRect, FrameRect, ImageBox, Rect, RuleLine, TableCellInfo } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Vector elements closer than this (points) belong to the same drawing. */
const CLUSTER_GAP = 24;
/** A cluster needs at least this many vector elements to be a figure. */
const MIN_CLUSTER_ELEMENTS = 6;
/** ...and at least this area (pt²), about 120 × 60. */
const MIN_CLUSTER_AREA = 7000;
/** Vertical distance between a figure caption and its drawing (points). */
const CAPTION_MAX_DISTANCE = 170;
/** Cost guard: pages with more vector elements than this are not clustered. */
const MAX_GRAPHICS = 1200;
/** A box must be at least this large (pt²) to hold text. */
const CONTAINER_MIN_AREA = 60;
/** A box covering more than this share of the region is a backdrop, not a text container. */
const CONTAINER_MAX_SHARE = 0.55;
/** Padding kept inside a container box, on top of half its border thickness (points). */
const CONTAINER_PAD = 1.2;
/** Distance kept from a neighbouring text element or rule when expanding a loose label (points). */
const OBSTACLE_GAP = 0.75;
/** Room a loose label gets on a side where nothing is in the way, × font size. */
const OPEN_SIDE_ROOM = 0.35;
/** The loose text of a figure is tried as a grid only from this many lines on. */
const MIN_STRUCTURED_ITEMS = 6;
/** A rule this wide (share of the page) inside the top / bottom margin is page furniture, not figure content. */
const FURNITURE_WIDTH_SHARE = 0.8;
const FURNITURE_MARGIN_SHARE = 0.12;
/** Two boxes overlapping this much are the same node drawn as a fill plus an outline. */
const DUPLICATE_BOX_OVERLAP = 0.9;
/** A ruling line overlapping the glyphs by more than this (points) makes the element unmaskable. */
const RULE_THROUGH_TEXT = 0.3;
/** Text is centred in its box when the left and right gaps differ by less than this (points, or × width). */
const CENTER_TOLERANCE_PT = 1.5;
const CENTER_TOLERANCE_RATIO = 0.06;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function right(r: Rect): number {
  return r.x + r.width;
}

function top(r: Rect): number {
  return r.y + r.height;
}

function intersects(a: Rect, b: Rect, slack = 0): boolean {
  return a.x - slack < right(b) && right(a) + slack > b.x && a.y - slack < top(b) && top(a) + slack > b.y;
}

function contains(outer: Rect, inner: Rect, slack = 0.5): boolean {
  return inner.x >= outer.x - slack && right(inner) <= right(outer) + slack && inner.y >= outer.y - slack && top(inner) <= top(outer) + slack;
}

function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= right(r) && y >= r.y && y <= top(r);
}

function union(boxes: readonly Rect[]): Rect {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(top)) - y };
}

/** A rule as a thin rectangle, so it can be treated like any other obstacle. */
export function ruleRect(r: RuleLine): Rect {
  const half = Math.max(r.thickness, 0.2) / 2;
  const x = Math.min(r.x0, r.x1) - (r.orientation === 'vertical' ? half : 0);
  const y = Math.min(r.y0, r.y1) - (r.orientation === 'horizontal' ? half : 0);
  return {
    x,
    y,
    width: Math.abs(r.x1 - r.x0) + (r.orientation === 'vertical' ? 2 * half : 0),
    height: Math.abs(r.y1 - r.y0) + (r.orientation === 'horizontal' ? 2 * half : 0),
  };
}

/**
 * Largest rectangle around `text` that no obstacle reaches into, inside
 * `limit`. Used for a figure label that has no box of its own: it may grow
 * into the empty space around it but never over a neighbouring label, a
 * connector, an axis or a box border.
 */
export function expandBox(text: Rect, obstacles: readonly Rect[], limit: Rect, gap = OBSTACLE_GAP): Rect {
  let left = limit.x;
  let rightEdge = right(limit);
  let bottom = limit.y;
  let topEdge = top(limit);
  for (const o of obstacles) {
    const overlapsY = o.y < top(text) && top(o) > text.y;
    const overlapsX = o.x < right(text) && right(o) > text.x;
    if (overlapsY) {
      if (right(o) <= text.x) left = Math.max(left, right(o) + gap);
      if (o.x >= right(text)) rightEdge = Math.min(rightEdge, o.x - gap);
    }
    if (overlapsX) {
      if (o.y >= top(text)) topEdge = Math.min(topEdge, o.y - gap);
      if (top(o) <= text.y) bottom = Math.max(bottom, top(o) + gap);
    }
  }
  // The text itself is always covered, whatever the neighbours say.
  left = Math.min(left, text.x);
  rightEdge = Math.max(rightEdge, right(text));
  bottom = Math.min(bottom, text.y);
  topEdge = Math.max(topEdge, top(text));
  return { x: round(left), y: round(bottom), width: round(rightEdge - left), height: round(topEdge - bottom) };
}

// ---------------------------------------------------------------------------
// Region detection
// ---------------------------------------------------------------------------

export interface FigureCaptionRef {
  id: string;
  box: Rect;
}

export interface FigureRegion {
  /** The caption this drawing belongs to. */
  captionId: string;
  bounds: Rect;
  /** Vector elements in the cluster, for the confidence report. */
  elements: number;
}

export interface PageGraphicsInput {
  fills: readonly FilledRect[];
  frames: readonly FrameRect[];
  rules: readonly RuleLine[];
  /** Page box [x0, y0, x1, y1], used to recognise header / footer rules. */
  view: number[];
}

/**
 * The running header and footer of a journal page are drawn as one full-width
 * rule near the top or bottom edge. They are not part of any drawing, and
 * letting one join a cluster would stretch the figure across the whole page.
 */
function isPageFurniture(r: RuleLine, view: number[]): boolean {
  if (r.orientation !== 'horizontal') return false;
  const [x0, y0, x1, y1] = view;
  const pageWidth = Math.max(1, x1 - x0);
  const pageHeight = Math.max(1, y1 - y0);
  const wide = Math.abs(r.x1 - r.x0) >= FURNITURE_WIDTH_SHARE * pageWidth;
  const margin = FURNITURE_MARGIN_SHARE * pageHeight;
  return wide && (r.y0 <= y0 + margin || r.y0 >= y1 - margin);
}

function graphicBoxes(page: PageGraphicsInput): Rect[] {
  const out: Rect[] = [];
  for (const f of page.fills) out.push({ x: f.x, y: f.y, width: f.width, height: f.height });
  for (const f of page.frames) out.push({ x: f.x, y: f.y, width: f.width, height: f.height });
  for (const r of page.rules) if (!isPageFurniture(r, page.view)) out.push(ruleRect(r));
  return out;
}

/** Group boxes that are within `gap` of each other (an arrow bridges two nodes of a flowchart). */
function clusterBoxes(boxes: readonly Rect[], gap: number): Array<{ bounds: Rect; elements: number }> {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (!intersects(boxes[i], boxes[j], gap)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map<number, Rect[]>();
  boxes.forEach((b, i) => {
    const key = find(i);
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  });
  return [...groups.values()].map((list) => ({ bounds: union(list), elements: list.length }));
}

/**
 * Figure regions of one page: a dense vector cluster plus a figure caption
 * close to it. Both signals are required, so an isolated rule, a table's
 * ruling lines or a stray box never becomes a figure.
 */
export function detectFigureRegions(page: PageGraphicsInput, captions: readonly FigureCaptionRef[]): FigureRegion[] {
  if (captions.length === 0) return [];
  const boxes = graphicBoxes(page);
  if (boxes.length < MIN_CLUSTER_ELEMENTS || boxes.length > MAX_GRAPHICS) return [];

  const byCaption = new Map<string, { parts: Rect[]; elements: number }>();
  for (const cluster of clusterBoxes(boxes, CLUSTER_GAP)) {
    if (cluster.elements < MIN_CLUSTER_ELEMENTS || area(cluster.bounds) < MIN_CLUSTER_AREA) continue;
    let best: FigureCaptionRef | null = null;
    let bestDistance = Infinity;
    for (const caption of captions) {
      const overlapX = Math.min(right(caption.box), right(cluster.bounds)) - Math.max(caption.box.x, cluster.bounds.x);
      if (overlapX <= 0) continue;
      const distance =
        caption.box.y >= top(cluster.bounds)
          ? caption.box.y - top(cluster.bounds)
          : top(caption.box) <= cluster.bounds.y
            ? cluster.bounds.y - top(caption.box)
            : 0;
      if (distance <= CAPTION_MAX_DISTANCE && distance < bestDistance) {
        best = caption;
        bestDistance = distance;
      }
    }
    if (!best) continue;
    const entry = byCaption.get(best.id) ?? { parts: [], elements: 0 };
    entry.parts.push(cluster.bounds);
    entry.elements += cluster.elements;
    byCaption.set(best.id, entry);
  }
  return [...byCaption.entries()].map(([captionId, e]) => ({ captionId, bounds: union(e.parts), elements: e.elements }));
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

interface Container {
  box: Rect;
  /** Interior after the border and the padding. */
  inner: Rect;
  /** Fill colour of the box itself, null for an outline-only box. */
  color: string | null;
}

/**
 * Boxes that can hold text: filled rectangles and stroked frames inside the
 * region that contain no smaller box. A group box drawn around several nodes
 * therefore never swallows their text.
 */
export function leafContainers(region: Rect, fills: readonly FilledRect[], frames: readonly FrameRect[]): Container[] {
  const limit = CONTAINER_MAX_SHARE * area(region);
  const candidates: Array<{ box: Rect; color: string | null; thickness: number }> = [];
  for (const f of fills) {
    const box = { x: f.x, y: f.y, width: f.width, height: f.height };
    if (!contains(region, box, 4) || area(box) < CONTAINER_MIN_AREA || area(box) > limit) continue;
    candidates.push({ box, color: f.color && f.color !== '#ffffff' ? f.color : null, thickness: 0 });
  }
  for (const f of frames) {
    const box = { x: f.x, y: f.y, width: f.width, height: f.height };
    if (!contains(region, box, 4) || area(box) < CONTAINER_MIN_AREA || area(box) > limit) continue;
    candidates.push({ box, color: null, thickness: f.thickness });
  }
  // A node drawn as a fill plus a matching outline appears twice; keep one.
  const deduped = candidates.filter((c, i) =>
    candidates.every((o, j) => {
      if (i === j) return true;
      const w = Math.min(right(c.box), right(o.box)) - Math.max(c.box.x, o.box.x);
      const h = Math.min(top(c.box), top(o.box)) - Math.max(c.box.y, o.box.y);
      const overlap = w > 0 && h > 0 ? (w * h) / Math.max(area(c.box), area(o.box)) : 0;
      if (overlap < DUPLICATE_BOX_OVERLAP) return true;
      // same node: keep the filled one, else the first
      if (c.color !== null && o.color === null) return true;
      if (c.color === null && o.color !== null) return false;
      return i < j;
    }),
  );
  const leaves = deduped.filter((c) => !deduped.some((o) => o !== c && area(o.box) < area(c.box) - 1 && contains(c.box, o.box, 1)));
  return leaves.map((c) => {
    const pad = c.thickness / 2 + CONTAINER_PAD;
    return {
      box: c.box,
      color: c.color,
      inner: {
        x: round(c.box.x + pad),
        y: round(c.box.y + pad),
        width: round(Math.max(1, c.box.width - 2 * pad)),
        height: round(Math.max(1, c.box.height - 2 * pad)),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function dominantFontSize(fragments: readonly Fragment[]): number {
  const weights = new Map<number, number>();
  for (const f of fragments) {
    const key = Math.round(f.fontSize * 4) / 4;
    weights.set(key, (weights.get(key) ?? 0) + Math.max(1, f.text.length));
  }
  let best = fragments[0]?.fontSize ?? 10;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && size > best)) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** Text of one element: its lines joined with hyphenation repaired; only the last marker stays a marker. */
function elementText(fragments: readonly Fragment[]): { text: string; marker: string | null } {
  const parts: string[] = [];
  fragments.forEach((f, i) => {
    const last = i === fragments.length - 1;
    parts.push(last ? f.text : f.text + (f.trailingMarker ?? ''));
  });
  return { text: joinLines(parts).replace(/\s+/g, ' ').trim(), marker: fragments[fragments.length - 1]?.trailingMarker ?? null };
}

function alignmentIn(container: Rect, fragments: readonly Fragment[]): CellAlignment {
  const leftGap = fragments.reduce((n, f) => n + (f.x - container.x), 0) / fragments.length;
  const rightGap = fragments.reduce((n, f) => n + (right(container) - f.right), 0) / fragments.length;
  const tolerance = Math.max(CENTER_TOLERANCE_PT, CENTER_TOLERANCE_RATIO * container.width);
  if (Math.abs(leftGap - rightGap) <= tolerance) return 'center';
  return leftGap <= rightGap ? 'left' : 'right';
}

function makeCell(
  id: string,
  page: number,
  figureId: number,
  rowIndex: number,
  columnIndex: number,
  fragments: readonly Fragment[],
  usable: Rect,
  alignment: CellAlignment,
  fills: readonly FilledRect[],
  images: readonly ImageBox[],
  containerColor: string | null,
  ruleRects: readonly Rect[] = [],
): ResolvedCell {
  const textBox = union(fragments.map((f) => ({ x: f.x, y: f.bottom, width: f.right - f.x, height: f.top - f.bottom })));
  const { text, marker } = elementText(fragments);
  const sample = sampleBackground(textBox, fills, images);
  // A container's own fill is the most reliable answer; sampling only has to agree.
  const color = containerColor ?? sample.color;
  // An axis, gridline or connector running through the glyphs cannot be masked around.
  const crossed = ruleRects.some((r) => {
    const w = Math.min(right(r), right(textBox)) - Math.max(r.x, textBox.x);
    const h = Math.min(top(r), top(textBox)) - Math.max(r.y, textBox.y);
    return w > RULE_THROUGH_TEXT && h > RULE_THROUGH_TEXT;
  });
  const known = (containerColor !== null || !sample.ambiguous) && !crossed;
  const info: TableCellInfo = {
    id,
    kind: 'figure',
    page,
    tableId: figureId,
    rowIndex,
    columnIndex,
    colSpan: 1,
    sourceItemIds: fragments.flatMap((f) => f.items.map((r) => r.index)),
    textBox: {
      x: round(textBox.x),
      y: round(textBox.y),
      width: round(textBox.width),
      height: round(textBox.height),
    },
    usable,
    alignment,
    fontSize: dominantFontSize(fragments),
    numeric: isNumericTableCell(text) || isStatNotationOnly(text),
    header: false,
    trailingMarker: marker,
    background: known ? color : null,
    maskable: known,
    textOnDark: known && textColorFor(color) === 'light',
  };
  return { info, text, fragments: [...fragments] };
}

export interface FigureInput {
  page: number;
  figureId: number;
  region: Rect;
  items: TableItemRef[];
  rules: readonly RuleLine[];
  fills: readonly FilledRect[];
  frames: readonly FrameRect[];
  images: readonly ImageBox[];
}

export type FigureBuildResult =
  | { ok: true; cells: ResolvedCell[]; containers: number; structured: boolean }
  | { ok: false; reason: string };

/**
 * Split the text of one figure into logical elements. Returns `ok: false`
 * when nothing can be separated confidently; the caller then keeps the
 * figure's English text untouched.
 */
export function buildFigureCells(input: FigureInput): FigureBuildResult {
  const refs = input.items.filter((r) => r.item.text.trim().length > 0);
  if (refs.length === 0) return { ok: false, reason: 'NO_ITEMS' };

  const containers = leafContainers(input.region, input.fills, input.frames);
  const ruleRects = input.rules.map(ruleRect);

  // 1. every text item goes to the smallest box that holds its centre
  const byContainer = new Map<number, TableItemRef[]>();
  const loose: TableItemRef[] = [];
  const ordered = containers.map((c, i) => ({ c, i })).sort((a, b) => area(a.c.box) - area(b.c.box));
  for (const ref of refs) {
    const it = ref.item;
    const cx = it.x + it.width / 2;
    const cy = it.y + it.fontSize * 0.3;
    const hit = ordered.find(({ c }) => containsPoint(c.box, cx, cy));
    if (hit) {
      const list = byContainer.get(hit.i) ?? [];
      list.push(ref);
      byContainer.set(hit.i, list);
    } else {
      loose.push(ref);
    }
  }

  const cells: ResolvedCell[] = [];
  let rowIndex = 0;

  // 2. one element per box
  const boxEntries = [...byContainer.entries()].sort((a, b) => {
    const ca = containers[a[0]].box;
    const cb = containers[b[0]].box;
    return top(cb) - top(ca) || ca.x - cb.x;
  });
  for (const [index, list] of boxEntries) {
    const container = containers[index];
    const fragments = buildTextFragments(list);
    if (fragments.length === 0) continue;
    const textBox = union(fragments.map((f) => ({ x: f.x, y: f.bottom, width: f.right - f.x, height: f.top - f.bottom })));
    const usable: Rect = {
      x: round(Math.min(container.inner.x, textBox.x)),
      y: round(Math.min(container.inner.y, textBox.y)),
      width: 0,
      height: 0,
    };
    usable.width = round(Math.max(right(container.inner), right(textBox)) - usable.x);
    usable.height = round(Math.max(top(container.inner), top(textBox)) - usable.y);
    cells.push(
      makeCell(
        `p${input.page}-f${input.figureId}-b${rowIndex}`,
        input.page,
        input.figureId,
        rowIndex,
        0,
        fragments,
        usable,
        alignmentIn(container.box, fragments),
        input.fills,
        input.images,
        container.color,
        ruleRects,
      ),
    );
    rowIndex++;
  }

  // 3. loose text: a grid when the figure is nothing but a grid, else one element per line
  let structured = false;
  if (loose.length > 0) {
    if (containers.length === 0 && loose.length >= MIN_STRUCTURED_ITEMS) {
      const grid = buildTableCells({
        page: input.page,
        tableId: input.figureId,
        items: loose,
        rules: input.rules,
        fills: input.fills,
        images: input.images,
        idPrefix: `p${input.page}-f${input.figureId}`,
        kind: 'figure',
      });
      if (grid.ok) {
        structured = true;
        for (const cell of grid.cells) {
          const tb = cell.info.textBox;
          const crossed = ruleRects.some((r) => {
            const w = Math.min(right(r), right(tb)) - Math.max(r.x, tb.x);
            const h = Math.min(top(r), top(tb)) - Math.max(r.y, tb.y);
            return w > RULE_THROUGH_TEXT && h > RULE_THROUGH_TEXT;
          });
          cell.info.kind = 'figure';
          if (crossed) {
            cell.info.maskable = false;
            cell.info.background = null;
            cell.info.textOnDark = false;
          }
        }
        cells.push(...grid.cells);
      }
    }
    if (!structured) {
      const fragments = buildTextFragments(loose);
      const obstacles: Rect[] = [
        ...ruleRects,
        ...containers.map((c) => c.box),
        ...fragments.map((f) => ({ x: f.x, y: f.bottom, width: f.right - f.x, height: f.top - f.bottom })),
      ];
      for (const f of fragments) {
        const textBox = { x: f.x, y: f.bottom, width: f.right - f.x, height: f.top - f.bottom };
        const own = obstacles.filter((o) => !(o.x === textBox.x && o.y === textBox.y && o.width === textBox.width));
        const room = OPEN_SIDE_ROOM * f.fontSize;
        const limit: Rect = {
          x: input.region.x,
          y: Math.min(input.region.y, textBox.y - room),
          width: input.region.width,
          height: Math.max(input.region.height, top(textBox) + room - input.region.y),
        };
        cells.push(
          makeCell(
            `p${input.page}-f${input.figureId}-l${rowIndex}`,
            input.page,
            input.figureId,
            rowIndex,
            0,
            [f],
            expandBox(textBox, own, limit),
            'left',
            input.fills,
            input.images,
            null,
            ruleRects,
          ),
        );
        rowIndex++;
      }
    }
  }

  if (cells.length === 0) return { ok: false, reason: 'NO_ELEMENTS' };
  cells.sort((a, b) => top(b.info.textBox) - top(a.info.textBox) || a.info.textBox.x - b.info.textBox.x);
  return { ok: true, cells, containers: containers.length, structured };
}

/** A figure element never needs an API call when it carries no words. */
export function isUntranslatableFigureText(text: string): boolean {
  return isNumericTableCell(text) || isStatNotationOnly(text) || !/[A-Za-zÀ-ɏ]{2}/.test(text);
}
