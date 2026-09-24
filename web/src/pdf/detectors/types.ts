/**
 * Layout detector contract (pdf/detectors/registry.ts runs them).
 *
 * A detector looks at the final blocks of ONE page (tables and figures are
 * already resolved into cells) plus the page's vector graphics, and answers
 * with role assignments, containers and structured regions. It never mutates
 * the blocks: the registry applies the answers, splits run-in labels off
 * their paragraphs, and keeps the ownership ledger so a source text item can
 * never be claimed twice.
 *
 * Adding a layout pattern (pull quote, warning box, methods summary box,
 * clinical pearls, graphical-abstract label, supplementary sidebar) means
 * writing one detector and adding it to LAYOUT_DETECTORS; nothing in
 * layout.ts, merge.ts or render.ts needs to change.
 */

import type { LayoutContainer, LayoutRole, PageDebugInfo, PageLayout, Rect, TextBlock } from '../types';

export interface DetectorContext {
  page: PageDebugInfo;
  /** Column layout of the page (gutter for two-column pages). */
  layout: PageLayout;
  /** Final blocks of this page, in reading order. Read-only for detectors. */
  blocks: readonly TextBlock[];
  /** Document body font size (points). */
  bodyFontSize: number;
  /** Ownership ledger so far: block id → detector that owns it. Owned blocks must not be claimed. */
  owned: ReadonlyMap<string, string>;
  /** Estimated main text column width on this page (points). */
  textWidth: number;
}

/**
 * A run-in label split: the first `itemCount` items of the block's first
 * line become a label block of their own (id `${blockId}-L`); the rest of
 * the block keeps its id and gets `bodyRole`.
 */
export interface LabelSplit {
  itemCount: number;
  bodyRole: LayoutRole;
}

export interface RoleAssignment {
  blockId: string;
  role: LayoutRole;
  confidence: number;
  signals: string[];
  containerId?: string;
  split?: LabelSplit;
}

/** A structured section before the label block exists (ids refer to the original blocks). */
export interface StructuredSectionDraft {
  labelBlock: string;
  /** Body blocks after the label. For a run-in label the label's own block comes first. */
  bodyBlocks: string[];
  inline: boolean;
  confidence: number;
  signals: string[];
}

export interface StructuredRegionDraft {
  page: number;
  sections: StructuredSectionDraft[];
  confidence: number;
  signals: string[];
}

export interface DetectorResult {
  containers: LayoutContainer[];
  assignments: RoleAssignment[];
  regions: StructuredRegionDraft[];
  /** Free-form notes for Developer Mode (why a candidate was rejected, ...). */
  diagnostics: string[];
}

export interface LayoutDetector {
  /** Stable name, used in the ownership ledger and Developer Mode. */
  name: string;
  run(ctx: DetectorContext): DetectorResult;
}

export function emptyResult(): DetectorResult {
  return { containers: [], assignments: [], regions: [], diagnostics: [] };
}

export function blockRect(b: TextBlock): Rect {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

export function unionRects(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const top = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: top - y };
}

/** Share of `inner` that lies inside `outer` (0–1). */
export function insideShare(inner: Rect, outer: Rect): number {
  const w = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  if (w <= 0 || h <= 0) return 0;
  const a = Math.max(1e-6, inner.width * inner.height);
  return (w * h) / a;
}
