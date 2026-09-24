/**
 * Sidebar / callout detector.
 *
 * A sidebar or callout box is an information container that stands apart
 * from the main text column: a shaded panel or an outlined box that holds a
 * heading, labels and body text of its own ("Key Points", "Highlights",
 * "Research in Context", "Clinical implications" — the words are never
 * checked; only the panel and its typography are).
 *
 *   filled rectangles / stroked frames of the page
 *     → candidate panels (large enough, not the page tint)
 *     → child blocks: text blocks that lie inside the panel and that no
 *       earlier detector (table, figure) owns
 *     → signals: fill, border, width against the text column, text density,
 *       a heading-like first child, label + body pairs, straddling blocks,
 *       captions, numeric cells, row-shading patterns, two-column text
 *     → confidence; only a panel above SIDEBAR_MIN_CONFIDENCE becomes a
 *       LayoutContainer
 *     → inner roles: SIDEBAR_HEADING (first short bold / larger child),
 *       SIDEBAR_LABEL (run-in or standalone label), SIDEBAR_BODY (the rest)
 *
 * Conservative by design: an uncertain panel is left alone and its blocks
 * keep the ordinary layout path (false positives cost more than misses).
 */

import { isNumericTableCell, textColorFor } from '../table';
import type { FilledRect, FrameRect, LayoutContainer, Rect, RuleLine, TextBlock } from '../types';
import { findRunInLabel, isBoldFontName, scoreLabel, standaloneLabelCandidate } from './labels';
import {
  blockRect,
  emptyResult,
  insideShare,
  unionRects,
  type DetectorContext,
  type DetectorResult,
  type LayoutDetector,
  type RoleAssignment,
} from './types';

export const SIDEBAR_MIN_CONFIDENCE = 0.6;
/** Labels inside an accepted container need less evidence than in open text. */
export const SIDEBAR_LABEL_MIN_CONFIDENCE = 0.45;
/** A panel at most this wide (share of the main text column) sits beside the text: a sidebar; wider panels are callout boxes. */
const SIDEBAR_MAX_WIDTH_SHARE = 0.65;
/** A panel must be at least this large (points) to hold text. */
const PANEL_MIN_WIDTH = 40;
const PANEL_MIN_HEIGHT = 30;
const PANEL_MIN_AREA = 2400;
/** A panel covering more than this share of the page is a page tint. */
const PANEL_MAX_PAGE_SHARE = 0.6;
/** A block belongs to a panel when this share of it lies inside. */
const CHILD_INSIDE_SHARE = 0.85;
/** ...and straddles it when at least this share is inside but less than CHILD_INSIDE_SHARE. */
const STRADDLE_MIN_SHARE = 0.2;
/** Two rectangles overlapping this much are one panel drawn twice (fill + frame). */
const DUPLICATE_OVERLAP = 0.9;
/** Padding of the inner area is clamped to this range (points). */
const PAD_MIN = 1;
const PAD_MAX = 14;
/** Types that are never sidebar children. */
const EXCLUDED_TYPES = new Set(['HEADER', 'FOOTER', 'TITLE', 'AUTHOR', 'REFERENCE']);

interface Panel {
  rect: Rect;
  fill: string | null;
  border: LayoutContainer['border'];
}

function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function overlapShare(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(area(a), area(b), 1e-6);
}

function isWhite(color: string | null): boolean {
  return !color || color === '#ffffff';
}

/** Rules that box a rectangle: a horizontal rule along its top and bottom edge (or a vertical one along each side). */
function rulesBoxing(rect: Rect, rules: readonly RuleLine[]): { thickness: number } | null {
  const tol = 3;
  const spansX = (r: RuleLine) => r.x0 <= rect.x + tol + 0.1 * rect.width && r.x1 >= rect.x + rect.width - tol - 0.1 * rect.width;
  const spansY = (r: RuleLine) => r.y0 <= rect.y + tol + 0.1 * rect.height && r.y1 >= rect.y + rect.height - tol - 0.1 * rect.height;
  const top = rules.find((r) => r.orientation === 'horizontal' && Math.abs(r.y0 - (rect.y + rect.height)) <= tol && spansX(r));
  const bottom = rules.find((r) => r.orientation === 'horizontal' && Math.abs(r.y0 - rect.y) <= tol && spansX(r));
  const left = rules.find((r) => r.orientation === 'vertical' && Math.abs(r.x0 - rect.x) <= tol && spansY(r));
  const right = rules.find((r) => r.orientation === 'vertical' && Math.abs(r.x0 - (rect.x + rect.width)) <= tol && spansY(r));
  const found = [top, bottom, left, right].filter((r): r is RuleLine => !!r);
  if ((top && bottom) || (left && right)) return { thickness: Math.max(...found.map((r) => r.thickness)) };
  return null;
}

/** Candidate panels: fills and frames large enough to hold text, deduplicated. */
export function candidatePanels(fills: readonly FilledRect[], frames: readonly FrameRect[], rules: readonly RuleLine[], view: number[]): Panel[] {
  const pageArea = Math.max(1, (view[2] - view[0]) * (view[3] - view[1]));
  const out: Panel[] = [];
  const ok = (r: Rect) => r.width >= PANEL_MIN_WIDTH && r.height >= PANEL_MIN_HEIGHT && area(r) >= PANEL_MIN_AREA && area(r) <= PANEL_MAX_PAGE_SHARE * pageArea;
  for (const f of fills) {
    const rect = { x: f.x, y: f.y, width: f.width, height: f.height };
    if (!ok(rect)) continue;
    out.push({ rect, fill: isWhite(f.color) ? null : f.color, border: null });
  }
  for (const f of frames) {
    const rect = { x: f.x, y: f.y, width: f.width, height: f.height };
    if (!ok(rect)) continue;
    const twin = out.find((p) => overlapShare(p.rect, rect) >= DUPLICATE_OVERLAP);
    if (twin) twin.border = { thickness: f.thickness, source: 'frame' };
    else out.push({ rect, fill: null, border: { thickness: f.thickness, source: 'frame' } });
  }
  for (const p of out) {
    if (p.border) continue;
    const boxed = rulesBoxing(p.rect, rules);
    if (boxed) p.border = { thickness: boxed.thickness, source: 'rules' };
  }
  // A white fill with no border is invisible: not a panel.
  return out.filter((p) => p.fill !== null || p.border !== null);
}

/**
 * Row shading: other fills of the same left edge and width close above or
 * below `rect` (touching, or at most two stripe heights away, as alternate
 * row shading is). A single band of a clearly different height next to the
 * panel (a header band) is not a stripe; two neighbours always are.
 */
function stripePattern(rect: Rect, fills: readonly FilledRect[]): boolean {
  let neighbours = 0;
  let similar = 0;
  for (const f of fills) {
    if (Math.abs(f.x - rect.x) > 2 || Math.abs(f.width - rect.width) > 2) continue;
    if (Math.abs(f.y - rect.y) <= 0.5 && Math.abs(f.height - rect.height) <= 0.5) continue; // itself
    const gapBelow = rect.y - (f.y + f.height);
    const gapAbove = f.y - (rect.y + rect.height);
    const near = (gapBelow >= -2 && gapBelow <= 2 * rect.height) || (gapAbove >= -2 && gapAbove <= 2 * rect.height);
    if (!near) continue;
    neighbours++;
    if (f.height >= 0.5 * rect.height && f.height <= 2 * rect.height) similar++;
  }
  return similar >= 1 || neighbours >= 2;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function headingLike(b: TextBlock, childBodySize: number): boolean {
  if (b.lineCount > 2 || wordCount(b.text) > 8) return false;
  if (/[.!?]$/.test(b.text.trim())) return false;
  return b.type === 'HEADING' || isBoldFontName(b.fontRealName) || isBoldFontName(b.fontName) || b.fontSize >= 1.05 * childBodySize;
}

interface Scored {
  panel: Panel;
  children: TextBlock[];
  confidence: number;
  signals: string[];
}

function scorePanel(panel: Panel, ctx: DetectorContext): Scored | null {
  const rect = panel.rect;
  const signals: string[] = [];
  const children: TextBlock[] = [];
  let straddlers = 0;
  let ownedInside = 0;
  for (const b of ctx.blocks) {
    const share = insideShare(blockRect(b), rect);
    if (share < STRADDLE_MIN_SHARE) continue;
    if (ctx.owned.has(b.id)) {
      if (share >= 0.5) ownedInside++;
      continue;
    }
    if (EXCLUDED_TYPES.has(b.type)) continue;
    if (share >= CHILD_INSIDE_SHARE) children.push(b);
    else straddlers++;
  }
  if (children.length === 0) return null;
  const lines = children.reduce((n, b) => n + b.lineCount, 0);
  const words = children.reduce((n, b) => n + wordCount(b.text), 0);
  // A single coloured word or a one-line highlight is not a container.
  if (children.length < 2 && (lines < 3 || words < 6)) return null;

  let score = 0;
  if (panel.fill !== null) {
    score += 0.3;
    signals.push('background-fill');
  }
  if (panel.border) {
    score += panel.border.source === 'frame' ? 0.3 : 0.2;
    signals.push(`border:${panel.border.source}`);
  }
  const widthShare = rect.width / Math.max(1, ctx.textWidth);
  if (widthShare <= SIDEBAR_MAX_WIDTH_SHARE) {
    score += 0.15;
    signals.push('narrower-than-column');
  } else if (widthShare <= 0.85) {
    score += 0.05;
    signals.push('narrow');
  }
  const density = children.reduce((n, b) => n + area(blockRect(b)), 0) / Math.max(1, area(rect));
  if (density >= 0.12 && density <= 0.9) {
    score += 0.1;
    signals.push('text-density');
  } else if (density < 0.06) {
    score -= 0.2;
    signals.push('mostly-empty');
  }
  const ordered = [...children].sort((a, b) => a.order - b.order);
  const childBodySize = median(children.filter((b) => b.lineCount >= 2).map((b) => b.fontSize)) || median(children.map((b) => b.fontSize));
  if (headingLike(ordered[0], childBodySize)) {
    score += 0.15;
    signals.push('heading-first');
  }
  const labelPairs = ordered.filter((b) => findRunInLabel(b) !== null).length;
  const standaloneLabels = ordered.filter((b, i) => standaloneLabelCandidate(b) !== null && i > 0 && ordered[i + 1]?.type === 'BODY').length;
  if (labelPairs + standaloneLabels >= 1) {
    score += 0.1;
    signals.push('label-body-pattern');
  }
  if (children.some((b) => b.lineCount >= 2 && b.type === 'BODY')) {
    score += 0.05;
    signals.push('body-paragraph');
  }

  // Negative evidence.
  if (children.some((b) => b.type === 'CAPTION')) {
    score -= 0.5;
    signals.push('contains-caption');
  }
  const numeric = children.filter((b) => isNumericTableCell(b.text)).length;
  if (numeric / children.length >= 0.3) {
    score -= 0.4;
    signals.push('numeric-cells');
  }
  if (stripePattern(rect, ctx.page.fills)) {
    score -= 0.3;
    signals.push('row-shading');
  }
  if (straddlers > children.length) {
    score -= 0.3;
    signals.push('straddling-blocks');
  }
  if (ownedInside > 0) {
    score -= 0.4;
    signals.push('table-or-figure-inside');
  }
  const columns = new Set(children.map((b) => b.column));
  if (columns.has('LEFT') && columns.has('RIGHT')) {
    score -= 0.4;
    signals.push('two-column-text');
  }
  if (widthShare >= 0.95 && children.length >= 10) {
    score -= 0.2;
    signals.push('page-wide-many-blocks');
  }
  return { panel, children: ordered, confidence: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), signals };
}

function paddingOf(rect: Rect, children: readonly TextBlock[]): LayoutContainer['padding'] {
  const inner = unionRects(children.map(blockRect));
  const clamp = (v: number) => Math.max(PAD_MIN, Math.min(PAD_MAX, Math.round(v * 100) / 100));
  return {
    left: clamp(inner.x - rect.x),
    right: clamp(rect.x + rect.width - (inner.x + inner.width)),
    top: clamp(rect.y + rect.height - (inner.y + inner.height)),
    bottom: clamp(inner.y - rect.y),
  };
}

/** Roles of the children of one accepted container. */
function innerRoles(container: LayoutContainer, children: readonly TextBlock[], ctx: DetectorContext): RoleAssignment[] {
  const out: RoleAssignment[] = [];
  const childBodySize = container.bodyFontSize;
  let headingTaken = false;
  children.forEach((b, i) => {
    const base = { blockId: b.id, containerId: container.id };
    if (!headingTaken && i === 0 && headingLike(b, childBodySize) && findRunInLabel(b) === null) {
      headingTaken = true;
      out.push({ ...base, role: 'SIDEBAR_HEADING', confidence: container.confidence, signals: ['first-child', 'heading-like'] });
      return;
    }
    const runIn = findRunInLabel(b);
    if (runIn) {
      const score = scoreLabel(runIn, { block: b, next: children[i + 1] ?? null, rules: ctx.page.rules, referenceFontSize: childBodySize });
      if (score.confidence >= SIDEBAR_LABEL_MIN_CONFIDENCE) {
        out.push({
          ...base,
          role: 'SIDEBAR_LABEL',
          confidence: score.confidence,
          signals: score.signals,
          split: { itemCount: runIn.itemCount, bodyRole: 'SIDEBAR_BODY' },
        });
        return;
      }
    }
    const standalone = standaloneLabelCandidate(b);
    if (standalone && i > 0) {
      const score = scoreLabel(standalone, { block: b, next: children[i + 1] ?? null, rules: ctx.page.rules, referenceFontSize: childBodySize });
      if (score.confidence >= SIDEBAR_LABEL_MIN_CONFIDENCE) {
        out.push({ ...base, role: 'SIDEBAR_LABEL', confidence: score.confidence, signals: score.signals });
        return;
      }
    }
    out.push({ ...base, role: 'SIDEBAR_BODY', confidence: container.confidence, signals: ['inside-container'] });
  });
  return out;
}

export const sidebarDetector: LayoutDetector = {
  name: 'sidebar',
  run(ctx: DetectorContext): DetectorResult {
    const result = emptyResult();
    const panels = candidatePanels(ctx.page.fills, ctx.page.frames, ctx.page.rules, ctx.page.view);
    if (panels.length === 0) return result;
    const scored = panels
      .map((p) => scorePanel(p, ctx))
      .filter((s): s is Scored => s !== null)
      .sort((a, b) => b.confidence - a.confidence || area(a.panel.rect) - area(b.panel.rect));
    const claimed = new Set<string>();
    let index = 0;
    for (const s of scored) {
      const children = s.children.filter((b) => !claimed.has(b.id));
      if (s.confidence < SIDEBAR_MIN_CONFIDENCE) {
        result.diagnostics.push(
          `page ${ctx.page.pageNumber}: panel [${s.panel.rect.x}, ${s.panel.rect.y}, ${s.panel.rect.width}×${s.panel.rect.height}] rejected (${s.confidence}: ${s.signals.join(', ')})`,
        );
        continue;
      }
      if (children.length === 0) continue;
      index++;
      const bodySize = median(children.filter((b) => b.lineCount >= 2).map((b) => b.fontSize)) || median(children.map((b) => b.fontSize));
      const widthShare = s.panel.rect.width / Math.max(1, ctx.textWidth);
      const container: LayoutContainer = {
        id: `p${ctx.page.pageNumber}-c${index}`,
        type: widthShare <= SIDEBAR_MAX_WIDTH_SHARE ? 'SIDEBAR' : 'CALLOUT_BOX',
        page: ctx.page.pageNumber,
        bbox: { ...s.panel.rect },
        backgroundFill: s.panel.fill,
        border: s.panel.border,
        padding: paddingOf(s.panel.rect, children),
        children: children.map((b) => b.id),
        confidence: s.confidence,
        signals: s.signals,
        detector: 'sidebar',
        bodyFontSize: bodySize,
        textOnDark: textColorFor(s.panel.fill) === 'light',
      };
      result.containers.push(container);
      result.assignments.push(...innerRoles(container, children, ctx));
      for (const b of children) claimed.add(b.id);
    }
    return result;
  },
};
