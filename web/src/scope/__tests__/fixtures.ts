/**
 * Shared fixtures for the scope tests: layout blocks, translation units and
 * a multi-page analysis (body text, a JAMA-style table, a flowchart figure,
 * references) that runs through the real layout pipeline.
 */
import type {
  BlockType,
  FilledRect,
  OutlineNode,
  PageDebugInfo,
  PdfAnalysis,
  RuleLine,
  TextBlock,
  TextItemDebug,
  TranslationBlock,
} from '../../pdf/types';

export const PAGE_TOP = 792;

export function page(pageNumber: number, extra: Partial<PageDebugInfo> = {}): PageDebugInfo {
  return {
    pageNumber,
    width: 612,
    height: 792,
    rotation: 0,
    view: [0, 0, 612, 792],
    textItemCount: 0,
    images: [],
    rules: [],
    fills: [],
    frames: [],
    ...extra,
  };
}

export interface BlockSpec {
  id: string;
  page: number;
  /** Top edge; the block is `height` tall (default 12). */
  top: number;
  text: string;
  type?: BlockType;
  height?: number;
  fontSize?: number;
  translate?: boolean;
}

export function block(spec: BlockSpec): TextBlock {
  const type = spec.type ?? 'BODY';
  const height = spec.height ?? 12;
  const translate = spec.translate ?? !['HEADER', 'FOOTER', 'OTHER', 'AUTHOR', 'REFERENCE'].includes(type);
  return {
    id: spec.id,
    page: spec.page,
    type,
    sectionType: type === 'REFERENCE' ? 'REFERENCES' : 'MAIN',
    blockType: type === 'TABLE' ? 'TABLE_TEXT_LABEL' : type === 'FIGURE' ? 'FIGURE_LABEL' : type,
    text: spec.text,
    x: 50,
    y: spec.top - height,
    width: 400,
    height,
    top: spec.top,
    fontSize: spec.fontSize ?? (type === 'HEADING' ? 12 : 10),
    fontName: 'f1',
    fontRealName: null,
    column: 'FULL',
    lineCount: 1,
    lines: [],
    order: 0,
    translate,
    skipReason: translate ? null : `type:${type}`,
  };
}

/** A translation unit over one or more layout blocks (span = first top … last bottom). */
export function unit(blocks: TextBlock[], extra: Partial<TranslationBlock> = {}): TranslationBlock {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const merged = blocks.length > 1;
  return {
    id: merged ? `merged-${blocks.map((b) => b.id).join('-')}` : first.id,
    page: first.page,
    pages: [...new Set(blocks.map((b) => b.page))],
    type: first.type,
    sectionType: first.sectionType,
    blockType: first.blockType,
    text: blocks.map((b) => b.text).join(' '),
    sourceBlockIds: blocks.map((b) => b.id),
    wasMerged: merged,
    mergeReason: merged ? 'test' : null,
    incompleteSource: false,
    previousContext: null,
    nextContext: null,
    contextReason: null,
    span: { startPage: first.page, startY: first.top, endPage: last.page, endY: last.y },
    ...extra,
  };
}

export function outline(title: string, pg: number | null, y: number | null, children: OutlineNode[] = []): OutlineNode {
  return { title, page: pg, y, children };
}

// ---------------------------------------------------------------------------
// A real multi-page document for analyzeLayout()
// ---------------------------------------------------------------------------

const FS = 8;
const CHAR = 0.5;

export function item(text: string, x: number, y: number, fontSize = 10, pg = 1): TextItemDebug {
  return {
    page: pg,
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

/** Seven lines of body text starting at `top`, 12 pt apart. */
function paragraph(pg: number, top: number, seed: string): TextItemDebug[] {
  const lines = [
    `${seed} participants were followed for the whole study period and`,
    'their outcomes were recorded by trained interviewers at every visit.',
    'The primary analysis compared the two groups with adjusted models,',
    'and sensitivity analyses used alternative definitions of exposure.',
    'All estimates are reported with 95% confidence intervals and the',
    'corresponding two-sided P values, without any adjustment for multiplicity.',
    'Missing covariates were handled with multiple imputation by chained equations.',
  ];
  return lines.map((t, i) => item(t, 50, top - i * 12, 10, pg));
}

/** JAMA-style table (from table.test.ts), placed on `pg`. */
function tableItems(pg: number): TextItemDebug[] {
  const c0 = 50;
  const c1 = 200;
  const c2 = 260;
  const c3 = 320;
  const t = (text: string, x: number, y: number, fontSize = FS) => item(text, x, y, fontSize, pg);
  return [
    t('Characteristic', c0, 200),
    t('Bedbound (n = 590)', c1, 200),
    t('P value', c3, 200),
    t('Observed No.', c1, 190),
    t('Missing', c2, 190),
    t('(weighted %)', c1, 181),
    t('count', c2, 181),
    t('b', c2 + 5 * CHAR * FS, 183.5, 5),
    t('Time from last', c0, 165),
    t('4.9 (0.2)', c1, 165),
    t('0', c2, 165),
    t('<.001', c3, 165),
    t('interview to death,', c0, 156),
    t('mean (SD)', c0 + 6, 147),
    t('Female', c0 + 6, 135),
    t('389 (63.0)', c1, 135),
    t('0', c2, 135),
    t('<.001', c3, 135),
    t('Male', c0 + 6, 123),
    t('201 (37.0)', c1, 123),
    t('0', c2, 123),
    t('.05', c3, 123),
    t('Medicaid', c0, 111),
    t('d', c0 + 8 * CHAR * FS, 113.5, 5),
    t('195 (31.9)', c1, 111),
    t('35', c2, 111),
    t('<.001', c3, 111),
    t('Female 389 (63.0)', c0, 99),
    t('1', c1, 99),
    t('2', c2, 99),
    t('3', c3, 99),
  ];
}

function tableRules(): RuleLine[] {
  return [176.5, 142.5, 130.5, 118.5, 106.5, 94.5].map((y) => ({ orientation: 'horizontal', x0: 45, y0: y, x1: 360, y1: y, thickness: 0.25 }));
}

/** Flowchart figure (from figure.test.ts), placed on `pg`. */
function figureItems(pg: number): TextItemDebug[] {
  const f = (text: string, x: number, y: number) => item(text, x, y, 6.5, pg);
  return [f('In the last month, how often did', 70, 312), f('you go outside?', 70, 304), f('Never', 66, 265), f('Yes', 128, 265)];
}

function figureFills(): FilledRect[] {
  const fill = (x: number, y: number, width: number, height: number, color: string): FilledRect => ({ x, y, width, height, color });
  return [fill(60, 300, 200, 20, '#ebf2f5'), fill(60, 260, 40, 14, '#ffe5cc'), fill(120, 260, 40, 14, '#f1bf83'), fill(50, 250, 230, 80, '#ececed')];
}

function figureRules(): RuleLine[] {
  return [
    { orientation: 'vertical', x0: 80, y0: 274, x1: 80, y1: 300, thickness: 0.5 },
    { orientation: 'vertical', x0: 140, y0: 274, x1: 140, y1: 300, thickness: 0.5 },
    { orientation: 'horizontal', x0: 80, y0: 288, x1: 140, y1: 288, thickness: 0.5 },
  ];
}

/**
 * Five pages:
 *   1  title, "Abstract" heading + paragraph, "1. Introduction" heading + paragraph
 *   2  "2. Methods" heading + paragraph, "2.1 Participants" heading + paragraph
 *   3  "3. Results" heading, Table 1 (caption + JAMA cells + note)
 *   4  Figure 1 (caption + flowchart) + paragraph
 *   5  "4. Discussion" heading + paragraph, "References" heading + entries
 */
export function documentAnalysis(withOutline = false): PdfAnalysis {
  const items: TextItemDebug[] = [
    item('Bedbound Status During the Last Year of Life', 50, 722, 18, 1),
    item('Abstract', 50, 700, 12, 1),
    ...paragraph(1, 680, 'Community-dwelling'),
    item('1. Introduction', 50, 560, 12, 1),
    ...paragraph(1, 540, 'Older'),
    item('2. Methods', 50, 740, 12, 2),
    ...paragraph(2, 720, 'Eligible'),
    item('2.1 Participants', 50, 600, 12, 2),
    ...paragraph(2, 580, 'Enrolled'),
    item('3. Results', 50, 740, 12, 3),
    ...paragraph(3, 720, 'Bedbound'),
    item('Table 1. Characteristics of decedents by bedbound status.', 50, 222, 9, 3),
    ...tableItems(3),
    item('Note: values are mean (SD).', 50, 80, 7, 3),
    item('Figure 1. Assessment of bedbound status.', 48, 340, 7.5, 4),
    ...figureItems(4),
    item('Flowchart shows the survey flow and skip logic used to classify bedbound status of respondents.', 420, 120, 7, 4),
    ...paragraph(4, 700, 'Surveyed'),
    item('4. Discussion', 50, 740, 12, 5),
    ...paragraph(5, 720, 'Decedent'),
    item('References', 50, 560, 12, 5),
    item('1. Smith J, Doe A. Bedbound status in late life. JAMA. 2020;323(5):421-430.', 50, 540, 9, 5),
    item('2. Lee K, et al. Functional decline before death. J Am Geriatr Soc. 2019;67(2):301-309.', 50, 528, 9, 5),
  ];
  const count = (pg: number) => items.filter((i) => i.page === pg).length;
  const analysis: PdfAnalysis = {
    fileName: 'scope.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: 5,
    pages: [
      page(1, { textItemCount: count(1) }),
      page(2, { textItemCount: count(2) }),
      page(3, { textItemCount: count(3), rules: tableRules() }),
      page(4, { textItemCount: count(4), rules: figureRules(), fills: figureFills() }),
      page(5, { textItemCount: count(5) }),
    ],
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
    outline: [],
    outlineWarnings: [],
  };
  if (withOutline) {
    analysis.outline = [
      outline('1. Introduction', 1, 570),
      outline('2. Methods', 2, 750, [outline('2.1 Participants', 2, 610)]),
      outline('3. Results', 3, 750),
      outline('4. Discussion', 5, 750),
      outline('References', 5, 570),
    ];
  }
  return analysis;
}
