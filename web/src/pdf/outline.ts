/**
 * PDF outline (bookmarks) → chapters, browser-side only.
 *
 * `pdf.getOutline()` returns a tree of { title, dest, items }. A `dest` is
 * either a named destination (string, resolved with `pdf.getDestination()`)
 * or an explicit destination array
 *
 *   [pageRef, { name: 'XYZ' }, left, top, zoom]
 *   [pageRef, { name: 'FitH' | 'FitBH' }, top]
 *   [pageRef, { name: 'FitR' }, left, bottom, right, top]
 *   [pageRef, { name: 'Fit' | 'FitB' | 'FitV' | 'FitBV' } ...]   (no usable Y)
 *
 * `pageRef` is resolved with `pdf.getPageIndex()` (0-based → 1-based here).
 * Some producers write a plain page index instead of a reference; that is
 * accepted as well. Anything that fails is reported as a warning for that
 * one item only: its children are still read, and nothing here throws.
 *
 * No AI, no network: this costs no tokens.
 */

import type { OutlineNode } from './types';

/** The subset of PDFDocumentProxy this module needs (mockable in tests). */
export interface OutlineSource {
  getOutline(): Promise<RawOutlineItem[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/** What PDF.js gives per outline item (only the fields used here). */
export interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

export interface OutlineReadResult {
  items: OutlineNode[];
  warnings: string[];
}

/** Safety caps: a malicious or broken outline must not stall the browser. */
const MAX_OUTLINE_ITEMS = 2000;
const MAX_OUTLINE_DEPTH = 8;

function isDestinationKind(v: unknown): v is { name: string } {
  return !!v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string';
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The Y anchor (top edge, PDF user space) of an explicit destination array,
 * null when the destination kind has none or the value is missing (/XYZ with
 * a null top means "keep the current position").
 */
export function destinationTop(dest: readonly unknown[]): number | null {
  const kind = dest[1];
  if (!isDestinationKind(kind)) return null;
  switch (kind.name) {
    case 'XYZ':
      return finite(dest[3]);
    case 'FitH':
    case 'FitBH':
      return finite(dest[2]);
    case 'FitR':
      return finite(dest[5]);
    default:
      return null;
  }
}

/**
 * Resolve one item's destination to a 1-based page and an optional Y anchor.
 * Returns an error (never throws) for unresolved or invalid destinations.
 */
export async function resolveOutlineDestination(
  dest: string | unknown[] | null,
  source: OutlineSource,
): Promise<{ page: number; y: number | null } | { error: string }> {
  let explicit: unknown[] | null = null;
  if (typeof dest === 'string') {
    try {
      explicit = await source.getDestination(dest);
    } catch (err) {
      return { error: `named destination "${dest}" failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!explicit) return { error: `named destination "${dest}" not found` };
  } else if (Array.isArray(dest)) {
    explicit = dest;
  } else {
    return { error: 'no destination' };
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return { error: 'invalid destination array' };

  const ref = explicit[0];
  let pageIndex: number;
  if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0) {
    pageIndex = ref; // some producers store the page index directly
  } else if (ref && typeof ref === 'object') {
    try {
      pageIndex = await source.getPageIndex(ref);
    } catch (err) {
      return { error: `page reference could not be resolved: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    return { error: 'invalid page reference' };
  }
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return { error: `invalid page index ${String(pageIndex)}` };
  return { page: pageIndex + 1, y: destinationTop(explicit) };
}

/**
 * Read the whole outline tree with destinations resolved. Never throws: an
 * unreadable outline yields no items plus a warning; a broken item yields a
 * node with `page: null` plus a warning, and its children are still read.
 */
export async function readOutline(source: OutlineSource, pageCount?: number): Promise<OutlineReadResult> {
  const warnings: string[] = [];
  let raw: RawOutlineItem[] | null = null;
  try {
    raw = await source.getOutline();
  } catch (err) {
    warnings.push(`outline could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return { items: [], warnings };
  }
  if (!raw || raw.length === 0) return { items: [], warnings };

  let count = 0;
  const walk = async (items: RawOutlineItem[], depth: number): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    if (depth > MAX_OUTLINE_DEPTH) return out;
    for (const item of items) {
      if (count++ >= MAX_OUTLINE_ITEMS) {
        warnings.push(`outline truncated after ${MAX_OUTLINE_ITEMS} items`);
        return out;
      }
      const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
      let page: number | null = null;
      let y: number | null = null;
      const resolved = await resolveOutlineDestination(item?.dest ?? null, source);
      if ('error' in resolved) {
        warnings.push(`outline item "${title || '(untitled)'}" skipped: ${resolved.error}`);
      } else if (pageCount !== undefined && resolved.page > pageCount) {
        warnings.push(`outline item "${title || '(untitled)'}" skipped: page ${resolved.page} is beyond the last page (${pageCount})`);
      } else {
        page = resolved.page;
        y = resolved.y;
      }
      const children = Array.isArray(item?.items) && item.items.length ? await walk(item.items, depth + 1) : [];
      if (!title && page === null && children.length === 0) continue;
      out.push({ title, page, y, children });
    }
    return out;
  };
  const items = await walk(raw, 0);
  return { items, warnings };
}
