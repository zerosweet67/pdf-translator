/**
 * Phase B: PDF.js text extraction.
 *
 * Responsibilities of this module (and nothing more):
 *   - configure the PDF.js worker in a Vite/GitHub Pages friendly way
 *   - open a PDF from an ArrayBuffer that lives only in the browser
 *   - read every page's text items with coordinates and font info
 *   - produce a flat debug structure
 *
 * Deliberately NOT here yet: line/paragraph grouping, column detection,
 * translation, pdf-lib, fonts. Those arrive in Phase C and later.
 */

import * as pdfjsLib from 'pdfjs-dist';
// Vite's `?url` import returns the final URL of the worker file, both in
// `vite dev` and in the production bundle (respecting `base`). This is what
// prevents the classic "works locally, worker 404 on GitHub Pages" problem.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { FilledRect, ImageBox, PageDebugInfo, PdfAnalysis, RuleLine, TextItemDebug } from './types';
import { normalizeSymbolFontText } from './symbols';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ---------------------------------------------------------------------------
// Image bounding boxes (needed by the overlay phase to avoid masking figures)
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];

/** PDF `cm` semantics: the new CTM is `m × ctm`. */
function multiplyMatrix(m: Matrix, ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

function isMatrix(value: unknown): value is Matrix {
  return Array.isArray(value) && value.length === 6 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Images are painted into the unit square under the current CTM. */
function unitSquareBox(ctm: Matrix): ImageBox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [ux, uy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    xs.push(ctm[0] * ux + ctm[2] * uy + ctm[4]);
    ys.push(ctm[1] * ux + ctm[3] * uy + ctm[5]);
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: round(x0), y: round(y0), width: round(Math.max(...xs) - x0), height: round(Math.max(...ys) - y0) };
}

/** What the operator-list walk collects for one page. */
export interface PageGraphics {
  images: ImageBox[];
  rules: RuleLine[];
  fills: FilledRect[];
}

/** Thin straight paths up to this thickness (points) count as rules. */
const RULE_MAX_THICKNESS = 2.5;
/** Rules shorter than this (points) are ignored (tick marks, underlines of single glyphs). */
const RULE_MIN_LENGTH = 6;
/** Filled rectangles smaller than this area (pt²) are ignored (bullets, icons). */
const FILL_MIN_AREA = 40;
/** Safety cap so a page made of thousands of tiny paths cannot blow up memory. */
const MAX_GRAPHICS_PER_PAGE = 4000;

/** Transform an axis-aligned box [minX, minY, maxX, maxY] by `ctm` and return the resulting bounding box. */
function transformedBox(minMax: number[], ctm: Matrix): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [ux, uy] of [
    [minMax[0], minMax[1]],
    [minMax[2], minMax[1]],
    [minMax[0], minMax[3]],
    [minMax[2], minMax[3]],
  ]) {
    xs.push(ctm[0] * ux + ctm[2] * uy + ctm[4]);
    ys.push(ctm[1] * ux + ctm[3] * uy + ctm[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** PDF.js reports fill colours as "#rrggbb" strings; anything else is unknown. */
function fillColorOf(args: unknown): string | null {
  if (Array.isArray(args) && typeof args[0] === 'string' && /^#[0-9a-f]{6}$/i.test(args[0])) return args[0].toLowerCase();
  return null;
}

/** True when a path's draw ops describe straight segments only (no curves). */
function isStraightPath(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  for (const sub of data) {
    const arr = sub as ArrayLike<number>;
    let i = 0;
    while (i < arr.length) {
      const op = arr[i];
      if (op === 0 || op === 1) i += 3; // moveTo / lineTo x y
      else if (op === 4) i += 1; // closePath
      else return false; // curveTo / quadraticCurveTo
    }
  }
  return true;
}

/**
 * Walk the page's operator list and record where raster images land, plus
 * thin straight paths (table rules) and filled rectangles (row shading).
 * Tracks q/Q, cm and form XObjects; annotations are excluded. Charts drawn
 * with curves are ignored.
 */
async function collectPageGraphics(page: pdfjsLib.PDFPageProxy): Promise<PageGraphics> {
  const OPS = pdfjsLib.OPS;
  const imageOps = new Set<number>(
    [
      OPS.paintImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObject,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectRepeat,
      OPS.paintImageMaskXObjectGroup,
    ].filter((op): op is number => typeof op === 'number'),
  );

  // Painting operators that end a constructPath (see PDF.js OPS): stroke,
  // closeStroke, fill, eoFill, fillStroke, eoFillStroke, closeFillStroke, closeEOFillStroke.
  const strokeOps = new Set<number>([OPS.stroke, OPS.closeStroke].filter((op): op is number => typeof op === 'number'));
  const fillOps = new Set<number>(
    [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(
      (op): op is number => typeof op === 'number',
    ),
  );

  const opList = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  const boxes: ImageBox[] = [];
  const rules: RuleLine[] = [];
  const fills: FilledRect[] = [];
  interface GState {
    ctm: Matrix;
    fill: string | null;
    lineWidth: number;
  }
  const stack: GState[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let fillColor: string | null = null;
  let lineWidth = 1;
  let annotationDepth = 0;

  const addRuleOrFill = (paintOp: number, data: unknown, minMax: unknown) => {
    if (annotationDepth > 0 || rules.length + fills.length >= MAX_GRAPHICS_PER_PAGE) return;
    // minMax is a Float32Array [minX, minY, maxX, maxY] in the path's own coordinate space.
    const mm = minMax as ArrayLike<number> | null;
    if (!mm || typeof mm !== 'object' || mm.length !== 4) return;
    const box = [mm[0], mm[1], mm[2], mm[3]];
    if (!box.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    if (!isStraightPath(data)) return;
    const [x0, y0, x1, y1] = transformedBox(box, ctm);
    const w = x1 - x0;
    const h = y1 - y0;
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
    const stroked = strokeOps.has(paintOp);
    const filled = fillOps.has(paintOp);
    if (!stroked && !filled) return;
    const thickness = stroked ? Math.max(lineWidth * scale, 0.1) : Math.min(w, h);
    const horizontal = h <= RULE_MAX_THICKNESS && w >= RULE_MIN_LENGTH && w > h * 3;
    const vertical = w <= RULE_MAX_THICKNESS && h >= RULE_MIN_LENGTH && h > w * 3;
    if (horizontal || vertical) {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      rules.push(
        horizontal
          ? { orientation: 'horizontal', x0: round(x0), y0: round(cy), x1: round(x1), y1: round(cy), thickness: round(thickness) }
          : { orientation: 'vertical', x0: round(cx), y0: round(y0), x1: round(cx), y1: round(y1), thickness: round(thickness) },
      );
      return;
    }
    if (filled && w * h >= FILL_MIN_AREA) {
      fills.push({ x: round(x0), y: round(y0), width: round(w), height: round(h), color: fillColor });
    }
  };

  const restoreState = () => {
    const g = stack.pop();
    if (!g) return;
    ctm = g.ctm;
    fillColor = g.fill;
    lineWidth = g.lineWidth;
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;
    switch (fn) {
      case OPS.save:
        stack.push({ ctm, fill: fillColor, lineWidth });
        break;
      case OPS.restore:
        restoreState();
        break;
      case OPS.transform:
        if (isMatrix(args)) ctm = multiplyMatrix(args, ctm);
        break;
      case OPS.setLineWidth:
        if (Array.isArray(args) && typeof args[0] === 'number') lineWidth = args[0];
        break;
      case OPS.setFillRGBColor:
        fillColor = fillColorOf(args);
        break;
      case OPS.constructPath:
        if (Array.isArray(args) && typeof args[0] === 'number') addRuleOrFill(args[0], args[1], args[2]);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ctm, fill: fillColor, lineWidth });
        const matrix = Array.isArray(args) ? (args as unknown[])[0] : null;
        if (isMatrix(matrix)) ctm = multiplyMatrix(matrix, ctm);
        break;
      }
      case OPS.paintFormXObjectEnd:
        restoreState();
        break;
      case OPS.beginAnnotation:
        annotationDepth++;
        stack.push({ ctm, fill: fillColor, lineWidth });
        break;
      case OPS.endAnnotation:
        annotationDepth = Math.max(0, annotationDepth - 1);
        restoreState();
        break;
      default:
        if (imageOps.has(fn) && annotationDepth === 0) {
          const box = unitSquareBox(ctm);
          if (box.width >= 1 && box.height >= 1) boxes.push(box);
        }
    }
  }
  return { images: boxes, rules, fills };
}

// Derive the text item types from PDF.js itself so we do not depend on
// deep import paths inside the package.
type TextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>>;
type TextContentItem = TextContent['items'][number];
type TextItem = Extract<TextContentItem, { str: string }>;

function isTextItem(item: TextContentItem): item is TextItem {
  return typeof (item as { str?: unknown }).str === 'string';
}

/** Matches PDF.js output for glyphs it could not map to Unicode. */
const CID_PATTERN = /\(cid:\d+\)/;
const REPLACEMENT_CHAR = '�';
/** Above this ratio of suspicious items we warn in the console. */
const SUSPICIOUS_WARN_RATIO = 0.2;

function looksSuspicious(text: string): boolean {
  if (CID_PATTERN.test(text)) return true;
  if (text.includes(REPLACEMENT_CHAR)) return true;
  // Private Use Area characters usually mean a symbol font without ToUnicode.
  let pua = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xe000 && code <= 0xf8ff) pua++;
  }
  return pua > 0 && pua / text.length > 0.5;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface ExtractOptions {
  /** Called after each page is processed. */
  onProgress?: (pagesDone: number, pageCount: number) => void;
}

/**
 * Extract text items from a PDF held in memory.
 *
 * @param buffer   The file bytes from `file.arrayBuffer()`. The buffer is copied
 *                 before being handed to PDF.js, because PDF.js transfers the
 *                 bytes to its worker and the original would become unusable.
 *                 Later phases need the original bytes again for pdf-lib.
 * @param fileName Only used for labelling the result.
 */
export async function extractPdf(
  buffer: ArrayBuffer,
  fileName: string,
  options: ExtractOptions = {},
): Promise<PdfAnalysis> {
  const data = new Uint8Array(buffer.slice(0));
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const pages: PageDebugInfo[] = [];
  const items: TextItemDebug[] = [];
  let whitespaceItemCount = 0;
  let suspiciousItemCount = 0;
  let normalizedSymbolCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();

      // Resolve real font names (e.g. "TimesNewRomanPS-BoldMT") once per font id.
      // PDF.js exposes a font on page.commonObjs once an operator list has
      // loaded it; a font first used on this page only appears after
      // collectImageBoxes() below, so unresolved names are retried there.
      const realFontNames = new Map<string, string>();
      const resolveRealFontName = (fontId: string): string | null => {
        const known = realFontNames.get(fontId);
        if (known !== undefined) return known;
        let name: string | null = null;
        try {
          if (page.commonObjs.has(fontId)) {
            const font = page.commonObjs.get(fontId) as { name?: unknown } | null;
            name = typeof font?.name === 'string' ? font.name : null;
          }
        } catch {
          name = null;
        }
        if (name !== null) realFontNames.set(fontId, name);
        return name;
      };

      const pageItems: TextItemDebug[] = [];

      for (const raw of textContent.items) {
        if (!isTextItem(raw)) continue; // skip marked-content markers
        if (raw.str.trim().length === 0) {
          whitespaceItemCount++;
          continue;
        }

        // transform = [a, b, c, d, e, f]
        //   e, f : text origin (start of baseline) in PDF user space
        //   d    : vertical scale = font size when text is not rotated
        //   c    : vertical skew/rotation component
        // hypot(c, d) gives the font size even for rotated text.
        const [, , c, d, e, f] = raw.transform;
        const fontSize = Math.hypot(c, d);
        const style = textContent.styles[raw.fontName];

        const item: TextItemDebug = {
          page: pageNumber,
          text: raw.str,
          x: round(e),
          y: round(f),
          width: round(raw.width),
          height: round(raw.height),
          fontSize: round(fontSize),
          fontName: raw.fontName,
          fontFamily: style?.fontFamily ?? null,
          fontRealName: resolveRealFontName(raw.fontName),
          hasEOL: raw.hasEOL,
          transform: raw.transform.map((v) => round(v, 4)),
        };

        pageItems.push(item);
      }

      // Image placement for the overlay phase, table rules and fills for the
      // table renderer. Never fatal: a page whose operator list cannot be read
      // simply reports none.
      let graphics: PageGraphics = { images: [], rules: [], fills: [] };
      try {
        graphics = await collectPageGraphics(page);
      } catch (err) {
        console.warn(`[extractPdf] image / rule detection failed on page ${pageNumber}:`, err);
      }

      // Late font names, then Symbol-font PUA normalization (U+F05B → "[", U+F044 → Δ, ...).
      for (const item of pageItems) {
        item.fontRealName ??= resolveRealFontName(item.fontName);
        const normalized = normalizeSymbolFontText(item.text, item.fontRealName);
        if (normalized.mapped > 0) {
          item.text = normalized.text;
          normalizedSymbolCount += normalized.mapped;
        }
        if (looksSuspicious(item.text)) suspiciousItemCount++;
        items.push(item);
      }
      const pageItemCount = pageItems.length;

      pages.push({
        pageNumber,
        width: round(viewport.width),
        height: round(viewport.height),
        rotation: viewport.rotation,
        view: page.view.map((v) => round(v)),
        textItemCount: pageItemCount,
        images: graphics.images,
        rules: graphics.rules,
        fills: graphics.fills,
      });

      page.cleanup();
      options.onProgress?.(pageNumber, pdf.numPages);
    }
  } finally {
    await pdf.destroy();
  }

  const textItemCount = items.length;
  if (normalizedSymbolCount > 0) {
    console.info(`[extractPdf] ${normalizedSymbolCount} Symbol-font private-use character(s) normalized to Unicode (e.g. U+F05B → "[").`);
  }
  const suspiciousRatio = textItemCount === 0 ? 0 : suspiciousItemCount / textItemCount;

  if (textItemCount > 0 && suspiciousRatio > SUSPICIOUS_WARN_RATIO) {
    console.warn(
      `[extractPdf] ${suspiciousItemCount} of ${textItemCount} text items ` +
        `(${(suspiciousRatio * 100).toFixed(1)}%) look unreadable, e.g. "(cid:123)". ` +
        'This PDF probably lacks a ToUnicode map and may not translate correctly.',
    );
  }

  return {
    fileName,
    fileSize: buffer.byteLength,
    pdfjsVersion: pdfjsLib.version,
    pageCount: pdf.numPages,
    pages,
    items,
    textItemCount,
    whitespaceItemCount,
    hasSelectableText: textItemCount > 0,
    suspiciousItemCount,
    suspiciousRatio,
    normalizedSymbolCount,
  };
}
