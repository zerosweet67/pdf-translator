/**
 * Layout detector registry: runs the detectors in ownership priority and
 * applies their answers to the final block set.
 *
 *   TABLE  →  FIGURE  →  SIDEBAR / CALLOUT  →  STRUCTURED ABSTRACT  →  CAPTION  →  BODY
 *
 * The first three entries do not detect anything here (tables and figures
 * are resolved earlier in layout.ts, captions by classify.ts); they only
 * enter their blocks into the ownership ledger so that no later detector can
 * claim a table cell, a figure label or a caption. A detector's assignment
 * for a block that is already owned is dropped and reported.
 *
 * Applying the answers:
 *   - a run-in label is split off its paragraph: the label items become a
 *     block of their own (`${id}-L`) with the label role, the paragraph
 *     keeps its id, its remaining items and the body role; the two are
 *     linked by labelFor / labelBlockId so the renderer can set them on one
 *     first line again. No source text item is duplicated.
 *   - containers and structured regions get their final ids and bounding
 *     boxes.
 *
 * To add a layout pattern, append a detector to LAYOUT_DETECTORS (see
 * pdf/detectors/types.ts). Nothing else changes.
 */

import { GLYPH_ASCENT, GLYPH_DESCENT } from '../layout';
import { assignDefaultRoles, roleOf } from '../roles';
import { joinLines } from '../text';
import type {
  LayoutContainer,
  PageDebugInfo,
  PageLayout,
  PdfAnalysis,
  StructuredAbstractRegion,
  StructuredSection,
  TextBlock,
  TextItemDebug,
  TextLine,
} from '../types';
import { joinItemTexts } from './labels';
import { sidebarDetector } from './sidebar';
import { structuredAbstractDetector } from './structuredAbstract';
import {
  blockRect,
  emptyResult,
  unionRects,
  type DetectorContext,
  type DetectorResult,
  type LayoutDetector,
  type RoleAssignment,
  type StructuredRegionDraft,
} from './types';

/** A detector that only registers ownership of blocks an earlier stage produced. */
function ownershipDetector(name: string, owns: (b: TextBlock) => boolean): LayoutDetector {
  return {
    name,
    run(ctx: DetectorContext): DetectorResult {
      const result = emptyResult();
      for (const b of ctx.blocks) {
        if (ctx.owned.has(b.id) || !owns(b)) continue;
        result.assignments.push({ blockId: b.id, role: roleOf(b), confidence: 1, signals: ['pre-resolved'] });
      }
      return result;
    },
  };
}

export const tableOwnership = ownershipDetector('table', (b) => b.type === 'TABLE' || b.cell?.kind === 'table');
export const figureOwnership = ownershipDetector('figure', (b) => b.type === 'FIGURE' || b.cell?.kind === 'figure');
export const captionOwnership = ownershipDetector('caption', (b) => b.type === 'CAPTION');

/** Detectors in ownership priority. Append new patterns here. */
export const LAYOUT_DETECTORS: readonly LayoutDetector[] = [
  tableOwnership,
  figureOwnership,
  sidebarDetector,
  structuredAbstractDetector,
  captionOwnership,
];

export interface LayoutRolesResult {
  /** Blocks in reading order, run-in labels split into their own blocks. */
  blocks: TextBlock[];
  containers: LayoutContainer[];
  regions: StructuredAbstractRegion[];
  /** Detector name → blocks it owns (after splits). */
  ownership: Record<string, number>;
  diagnostics: string[];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/** Main text column width on a page: the wide body paragraphs, else a share of the page. */
function estimateTextWidth(blocks: readonly TextBlock[], page: PageDebugInfo, layout: PageLayout): number {
  const widths = blocks.filter((b) => b.type === 'BODY' && b.lineCount >= 2 && b.column !== 'SPANNING').map((b) => b.width);
  const measured = percentile(widths, 0.9);
  if (measured > 0) return measured;
  const pageWidth = page.view[2] - page.view[0];
  return layout.layout === 'TWO_COLUMN' ? 0.4 * pageWidth : 0.8 * pageWidth;
}

function makeLine(template: TextLine, items: TextItemDebug[]): TextLine {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const dom = sorted.reduce((a, b) => (b.text.trim().length > a.text.trim().length ? b : a), sorted[0]);
  const left = Math.min(...sorted.map((i) => i.x));
  const right = Math.max(...sorted.map((i) => i.x + i.width));
  return {
    page: template.page,
    text: joinItemTexts(sorted),
    x: round(left),
    y: round(dom.y),
    width: round(right - left),
    height: round(dom.fontSize),
    fontSize: dom.fontSize,
    fontName: dom.fontName,
    fontRealName: dom.fontRealName,
    column: template.column,
    items: sorted,
  };
}

/** Recompute a block's text and geometry from its lines (after a split). */
function refreshGeometry(block: TextBlock): void {
  const lines = block.lines;
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.x + l.width));
  const top = Math.max(...lines.map((l) => l.y + GLYPH_ASCENT * l.fontSize));
  const bottom = Math.min(...lines.map((l) => l.y - GLYPH_DESCENT * l.fontSize));
  const dom = lines.reduce((a, b) => (b.text.length > a.text.length ? b : a), lines[0]);
  block.text = joinLines(lines.map((l) => l.text));
  block.x = round(left);
  block.y = round(bottom);
  block.width = round(right - left);
  block.height = round(top - bottom);
  block.top = round(top);
  block.fontSize = dom.fontSize;
  block.fontName = dom.fontName;
  block.fontRealName = dom.fontRealName;
  block.lineCount = lines.length;
}

/**
 * Split the first `itemCount` items of the block's first line into a label
 * block. The paragraph keeps its id and object identity (other references
 * stay valid) and loses only those items.
 */
function splitRunInLabel(block: TextBlock, assignment: RoleAssignment): TextBlock | null {
  const split = assignment.split;
  if (!split || block.lines.length === 0) return null;
  const line0 = block.lines[0];
  const items = [...line0.items].sort((a, b) => a.x - b.x);
  if (split.itemCount <= 0 || split.itemCount > items.length) return null;
  const labelItems = items.slice(0, split.itemCount);
  const restItems = items.slice(split.itemCount);
  if (restItems.length === 0 && block.lines.length < 2) return null;

  const labelLine = makeLine(line0, labelItems);
  const label: TextBlock = {
    id: `${block.id}-L`,
    page: block.page,
    type: 'HEADING',
    sectionType: block.sectionType,
    blockType: 'HEADING',
    text: labelLine.text,
    x: labelLine.x,
    y: round(labelLine.y - GLYPH_DESCENT * labelLine.fontSize),
    width: labelLine.width,
    height: round((GLYPH_ASCENT + GLYPH_DESCENT) * labelLine.fontSize),
    top: round(labelLine.y + GLYPH_ASCENT * labelLine.fontSize),
    fontSize: labelLine.fontSize,
    fontName: labelLine.fontName,
    fontRealName: labelLine.fontRealName,
    column: block.column,
    lineCount: 1,
    lines: [labelLine],
    order: -1,
    translate: true,
    skipReason: null,
    role: assignment.role,
    containerId: assignment.containerId,
    labelFor: block.id,
    roleDetector: undefined,
    roleConfidence: assignment.confidence,
  };

  block.lines = restItems.length > 0 ? [makeLine(line0, restItems), ...block.lines.slice(1)] : block.lines.slice(1);
  refreshGeometry(block);
  block.labelBlockId = label.id;
  block.role = split.bodyRole;
  block.containerId = assignment.containerId;
  block.roleConfidence = assignment.confidence;
  if (block.type === 'OTHER' && block.skipReason === 'fragment') {
    // the label made the rest look like a fragment; it is the paragraph's own text
    block.type = 'BODY';
    block.blockType = 'BODY';
    block.translate = true;
    block.skipReason = null;
  }
  return label;
}

/**
 * Run every detector on every page and apply the answers. `blocks` must be
 * the final block set (tables and figures resolved) in reading order; the
 * returned list replaces it.
 */
export function applyLayoutRoles(
  blocks: TextBlock[],
  analysis: PdfAnalysis,
  pageLayouts: readonly PageLayout[],
  bodyFontSize: number,
  detectors: readonly LayoutDetector[] = LAYOUT_DETECTORS,
): LayoutRolesResult {
  assignDefaultRoles(blocks);
  const owned = new Map<string, string>();
  const assignments = new Map<string, RoleAssignment & { detector: string }>();
  const containers: LayoutContainer[] = [];
  const regionDrafts: Array<StructuredRegionDraft & { detector: string }> = [];
  const diagnostics: string[] = [];
  const layoutByPage = new Map(pageLayouts.map((p) => [p.pageNumber, p]));

  for (const page of analysis.pages) {
    const pageBlocks = blocks.filter((b) => b.page === page.pageNumber);
    if (pageBlocks.length === 0) continue;
    const layout = layoutByPage.get(page.pageNumber);
    if (!layout) continue;
    const ctx: DetectorContext = {
      page,
      layout,
      blocks: pageBlocks,
      bodyFontSize,
      owned,
      textWidth: estimateTextWidth(pageBlocks, page, layout),
    };
    for (const detector of detectors) {
      const result = detector.run(ctx);
      diagnostics.push(...result.diagnostics);
      const accepted = new Set<string>();
      for (const a of result.assignments) {
        const owner = owned.get(a.blockId);
        if (owner) {
          diagnostics.push(`page ${page.pageNumber}: ${detector.name} wanted ${a.blockId} (${a.role}) but ${owner} owns it`);
          continue;
        }
        owned.set(a.blockId, detector.name);
        assignments.set(a.blockId, { ...a, detector: detector.name });
        accepted.add(a.blockId);
      }
      for (const c of result.containers) {
        const children = c.children.filter((id) => accepted.has(id));
        if (children.length === 0) continue;
        containers.push({ ...c, children });
      }
      for (const r of result.regions) {
        const sections = r.sections.filter((s) => accepted.has(s.labelBlock));
        if (sections.length < 2) continue;
        regionDrafts.push({ ...r, sections, detector: detector.name });
      }
    }
  }

  // Apply: roles, containers, splits.
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const labelOf = new Map<string, TextBlock>();
  for (const [id, a] of assignments) {
    const block = byId.get(id);
    if (!block) continue;
    if (a.detector === 'table' || a.detector === 'figure' || a.detector === 'caption') {
      block.roleDetector = a.detector;
      block.roleConfidence = 1;
      continue;
    }
    if (a.split) {
      const label = splitRunInLabel(block, a);
      if (label) {
        label.roleDetector = a.detector;
        block.roleDetector = a.detector;
        labelOf.set(block.id, label);
        continue;
      }
    }
    block.role = a.role;
    block.containerId = a.containerId;
    block.roleDetector = a.detector;
    block.roleConfidence = a.confidence;
    if (a.containerId && block.type === 'OTHER' && block.skipReason === 'fragment') {
      // a short line inside a text panel is text, not a figure label
      block.type = 'BODY';
      block.blockType = 'BODY';
      block.translate = true;
      block.skipReason = null;
    }
  }

  // Reading order with the label blocks inserted before their paragraphs.
  const out: TextBlock[] = [];
  for (const b of blocks) {
    const label = labelOf.get(b.id);
    if (label) out.push(label);
    out.push(b);
  }
  out.forEach((b, i) => {
    b.order = i;
  });
  const finalById = new Map(out.map((b) => [b.id, b]));
  const rectOf = (id: string) => {
    const b = finalById.get(id);
    return b ? blockRect(b) : null;
  };

  const finalContainers = containers.map((c) => ({
    ...c,
    children: c.children.flatMap((id) => {
      const label = labelOf.get(id);
      return label ? [label.id, id] : [id];
    }),
  }));

  const regions: StructuredAbstractRegion[] = [];
  const regionCounter = new Map<number, number>();
  for (const draft of regionDrafts) {
    const sections: StructuredSection[] = [];
    for (const s of draft.sections) {
      const label = labelOf.get(s.labelBlock);
      const labelId = label ? label.id : s.labelBlock;
      const rects = [labelId, ...s.bodyBlocks].map(rectOf).filter((r): r is NonNullable<typeof r> => r !== null);
      if (rects.length === 0) continue;
      sections.push({ labelBlock: labelId, bodyBlocks: s.bodyBlocks, bbox: unionRects(rects), inline: s.inline, confidence: s.confidence, signals: s.signals });
    }
    if (sections.length < 2) continue;
    const n = (regionCounter.get(draft.page) ?? 0) + 1;
    regionCounter.set(draft.page, n);
    regions.push({
      id: `p${draft.page}-sa${n}`,
      page: draft.page,
      bbox: unionRects(sections.map((s) => s.bbox)),
      sections,
      confidence: draft.confidence,
      signals: draft.signals,
      detector: draft.detector,
    });
  }

  const ownership: Record<string, number> = {};
  for (const b of out) {
    const d = b.roleDetector;
    if (!d) continue;
    ownership[d] = (ownership[d] ?? 0) + 1;
  }
  return { blocks: out, containers: finalContainers, regions, ownership, diagnostics };
}

/** Source text items owned by blocks with a detector-assigned role (sidebar / structured abstract). */
export function countRoleClaimedItems(blocks: readonly TextBlock[]): number {
  let n = 0;
  for (const b of blocks) {
      if (b.roleDetector !== 'sidebar' && b.roleDetector !== 'structured-abstract') continue;
    for (const line of b.lines) n += line.items.length;
  }
  return n;
}

/** Empty role data for callers that skip detection (A/B comparison). */
export function emptyLayoutRoles(blocks: TextBlock[]): LayoutRolesResult {
  assignDefaultRoles(blocks);
  return { blocks, containers: [], regions: [], ownership: {}, diagnostics: [] };
}

