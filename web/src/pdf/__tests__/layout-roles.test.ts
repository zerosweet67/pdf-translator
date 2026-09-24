/**
 * Generic layout roles: structured abstracts, sidebars / callouts, the
 * detector registry, background-aware masking and the role typography.
 *
 * Every fixture is synthetic and built from text items that run through the
 * real layout pipeline (analyzeLayout). The words are deliberately not the
 * ones of any particular journal: "Overview / Purpose / Findings /
 * Interpretation", "Highlights — What we found / Why it matters",
 * "Clinical implications". Nothing in production code checks these words as
 * a condition (pdf/roles.ts keeps a hint list that only adds confidence).
 */
import { describe, expect, it } from 'vitest';
import { detectChapters } from '../../scope/chapters';
import { documentAnalysis, page as fixturePage } from '../../scope/__tests__/fixtures';
import { resolveTranslationScope } from '../../scope/scope';
import { buildPayload } from '../../translate/batch';
import { findRunInLabel, scoreLabel, standaloneLabelCandidate } from '../detectors/labels';
import { applyLayoutRoles, LAYOUT_DETECTORS } from '../detectors/registry';
import { SIDEBAR_MIN_CONFIDENCE } from '../detectors/sidebar';
import { STRUCTURED_MIN_LABEL_CONFIDENCE, STRUCTURED_MIN_REGION_CONFIDENCE } from '../detectors/structuredAbstract';
import { emptyResult, type DetectorContext, type DetectorResult, type LayoutDetector } from '../detectors/types';
import { analyzeLayout } from '../layout';
import { getBackgroundForBlock, lineMaskRect, type BlockBackground } from '../render';
import { defaultRoleFor, LAYOUT_ROLES, roleOf, WORKER_ROLE_TYPES } from '../roles';
import { hasRequiredContrast, roleFor, TYPOGRAPHY, typographyFor } from '../typography';
import type { FilledRect, FrameRect, LayoutContainer, LayoutResult, PageDebugInfo, PdfAnalysis, RuleLine, TextBlock, TextItemDebug, TextLine } from '../types';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const CHAR = 0.5;
const VIEW = [0, 0, 612, 792];

interface ItemOptions {
  fs?: number;
  page?: number;
  bold?: boolean;
  italic?: boolean;
}

function item(text: string, x: number, y: number, o: ItemOptions = {}): TextItemDebug {
  const fs = o.fs ?? 10;
  const fontName = o.bold ? 'g_bold' : o.italic ? 'g_it' : 'g_reg';
  const fontRealName = o.bold ? 'Helvetica-Bold' : o.italic ? 'Helvetica-Oblique' : 'Helvetica';
  return {
    page: o.page ?? 1,
    text,
    x,
    y,
    width: text.length * CHAR * fs,
    height: fs,
    fontSize: fs,
    fontName,
    fontFamily: 'sans-serif',
    fontRealName,
    hasEOL: false,
    transform: [fs, 0, 0, fs, x, y],
  };
}

/** Lines of one paragraph, `pitch` apart, starting at baseline `top`. */
function para(lines: string[], x: number, top: number, o: ItemOptions & { pitch?: number } = {}): TextItemDebug[] {
  const fs = o.fs ?? 10;
  const pitch = o.pitch ?? 1.25 * fs;
  return lines.map((t, i) => item(t, x, top - i * pitch, o));
}

/** A run-in section: a bold label opens the first line, regular text follows on the same line and below. */
function runIn(label: string, lines: string[], x: number, top: number, o: ItemOptions & { pitch?: number } = {}): TextItemDebug[] {
  const fs = o.fs ?? 10;
  const pitch = o.pitch ?? 1.25 * fs;
  const labelItem = item(label, x, top, { ...o, bold: true });
  const first = item(lines[0], x + labelItem.width + 0.35 * fs, top, { ...o, bold: false });
  const rest = lines.slice(1).map((t, i) => item(t, x, top - (i + 1) * pitch, { ...o, bold: false }));
  return [labelItem, first, ...rest];
}

interface PageSpec {
  fills?: FilledRect[];
  frames?: FrameRect[];
  rules?: RuleLine[];
}

function analysisOf(items: TextItemDebug[], pages: Record<number, PageSpec> = {}): PdfAnalysis {
  const pageNumbers = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  const last = Math.max(...pageNumbers, ...Object.keys(pages).map(Number));
  const list: PageDebugInfo[] = [];
  for (let p = 1; p <= last; p++) {
    const spec = pages[p] ?? {};
    list.push(fixturePage(p, { textItemCount: items.filter((i) => i.page === p).length, fills: spec.fills ?? [], frames: spec.frames ?? [], rules: spec.rules ?? [], view: VIEW }));
  }
  return {
    fileName: 'roles.pdf',
    fileSize: 1,
    pdfjsVersion: 'test',
    pageCount: last,
    pages: list,
    items,
    textItemCount: items.length,
    whitespaceItemCount: 0,
    hasSelectableText: true,
    suspiciousItemCount: 0,
    suspiciousRatio: 0,
    normalizedSymbolCount: 0,
  };
}

const BODY_LINES = [
  'Community-dwelling participants were followed for the whole study period',
  'and their outcomes were recorded by trained interviewers at every visit.',
  'The primary analysis compared the two groups with adjusted models, and',
  'sensitivity analyses used alternative definitions of exposure and outcome.',
];

// --- Case A: structured abstract with generic words --------------------------

function caseA(): PdfAnalysis {
  const items = [
    item('Summary', 50, 720, { fs: 12, bold: true }),
    ...runIn('Overview', ['Older adults who become bedbound near the end of life', 'need substantial help from family caregivers every single day.'], 50, 700),
    ...runIn('Purpose', ['To estimate how often community-dwelling decedents were', 'bedbound in their last year and which characteristics were associated.'], 50, 660),
    ...runIn('Findings', ['In this national cohort, dementia was associated with', 'a markedly higher probability of being bedbound before death.'], 50, 620),
    ...runIn('Interpretation', ['Home-based care and caregiver support should be', 'expanded for older adults with dementia in the community.'], 50, 580),
    item('1. Introduction', 50, 530, { fs: 12, bold: true }),
    ...para(BODY_LINES, 50, 510),
  ];
  return analysisOf(items);
}

// --- Case A2: standalone labels on their own line ----------------------------

function caseStandalone(): PdfAnalysis {
  const items = [
    item('Background', 50, 700, { bold: true }),
    ...para(['Breathlessness limits exercise training in chronic lung disease and', 'reduces the benefit that patients obtain from rehabilitation.'], 50, 687.5),
    item('Approach', 50, 650, { bold: true }),
    ...para(['A randomised trial compared training with and without facial airflow', 'over eight weeks in two rehabilitation centres.'], 50, 637.5),
    item('Outcome', 50, 600, { bold: true }),
    ...para(['Facial airflow increased the training intensity that participants', 'tolerated without changing the perceived effort.'], 50, 587.5),
    ...para(BODY_LINES, 50, 520),
  ];
  return analysisOf(items);
}

// --- Case B: shaded sidebar beside the main column ----------------------------

const PANEL: FilledRect = { x: 380, y: 420, width: 180, height: 300, color: '#e8f0f8' };

function caseB(options: { fill?: string; withHeaderBand?: boolean; topRule?: boolean } = {}): PdfAnalysis {
  const main = [
    item('Introduction', 50, 730, { fs: 12, bold: true }),
    ...para(['Bedbound status during the last year of life is common', 'among older adults and burdens family caregivers heavily', 'with many hours of help every week of the year.', 'This study measured how often it happened nationally.'], 50, 700),
    ...para(['Weighted regression models estimated the odds of being', 'bedbound by dementia status, age and living arrangement', 'and the number of caregiving hours received each week', 'from family members and paid helpers in the home.'], 50, 620),
    ...para(['The findings underscore the need for home-based care', 'and support services for caregivers of older adults', 'living with dementia in the community at the end of life,', 'a group that is growing quickly in every region.'], 50, 540),
  ];
  const panel = [
    item('Highlights', 392, 700, { fs: 11, bold: true }),
    ...runIn('What we found', ['dementia raised the', 'odds of being bedbound', 'almost five times.'], 392, 680, { fs: 9 }),
    ...runIn('Why it matters', ['caregivers of bedbound', 'adults give nearly three', 'times more weekly help.'], 392, 630, { fs: 9 }),
  ];
  const fills: FilledRect[] = [{ ...PANEL, color: options.fill ?? PANEL.color }];
  if (options.withHeaderBand) fills.push({ x: 380, y: 692, width: 180, height: 28, color: '#c0d0e0' });
  const rules: RuleLine[] = options.topRule ? [{ orientation: 'horizontal', x0: 380, y0: 720, x1: 560, y1: 720, thickness: 0.5 }] : [];
  return analysisOf([...main, ...panel], { 1: { fills, rules } });
}

// --- Case C: framed callout box across the column -----------------------------

function caseC(): PdfAnalysis {
  const items = [
    item('Methods', 50, 730, { fs: 12, bold: true }),
    ...para(BODY_LINES, 50, 700),
    ...para(BODY_LINES, 50, 620),
    item('Clinical implications', 55, 455, { bold: true }),
    ...para(['Clinicians should ask about bed confinement when they plan', 'home care for older adults with dementia, because the need for', 'help rises steeply in the months before death.'], 55, 440),
    ...para(BODY_LINES, 50, 360),
  ];
  const frames: FrameRect[] = [{ x: 45, y: 400, width: 410, height: 70, thickness: 1 }];
  return analysisOf(items, { 1: { frames } });
}

function blocksOf(layout: LayoutResult, role: string): TextBlock[] {
  return layout.blocks.filter((b) => roleOf(b) === role);
}

function itemsOf(blocks: readonly TextBlock[]): TextItemDebug[] {
  return blocks.flatMap((b) => b.lines.flatMap((l) => l.items));
}

// ---------------------------------------------------------------------------
// Role definitions
// ---------------------------------------------------------------------------

describe('roles', () => {
  it('defines every role once, with a default per block type', () => {
    for (const role of ['BODY', 'HEADING', 'STRUCTURED_LABEL', 'SIDEBAR', 'CALLOUT_BOX', 'SIDEBAR_HEADING', 'SIDEBAR_LABEL', 'SIDEBAR_BODY', 'CAPTION', 'TABLE', 'FIGURE', 'FOOTNOTE', 'REFERENCE']) {
      expect(LAYOUT_ROLES).toContain(role);
    }
    expect(defaultRoleFor('BODY')).toBe('BODY');
    expect(defaultRoleFor('TITLE')).toBe('HEADING');
    expect(defaultRoleFor('TABLE')).toBe('TABLE');
    expect(defaultRoleFor('OTHER')).toBe('BODY');
  });

  it('maps the roles onto the typography hierarchy', () => {
    expect(roleFor('HEADING', 'STRUCTURED_LABEL')).toBe('structuredLabel');
    expect(roleFor('HEADING', 'SIDEBAR_HEADING')).toBe('sidebarHeading');
    expect(roleFor('HEADING', 'SIDEBAR_LABEL')).toBe('sidebarLabel');
    expect(roleFor('BODY', 'SIDEBAR_BODY')).toBe('sidebarBody');
    expect(roleFor('BODY', 'BODY')).toBe('body');
    expect(roleFor('FOOTNOTE')).toBe('footnote');
  });
});

// ---------------------------------------------------------------------------
// 1–4: structured abstract
// ---------------------------------------------------------------------------

describe('structured abstract detection', () => {
  const layout = analyzeLayout(caseA());

  // Test 1: region detection
  it('detects one structured abstract region with generic section words', () => {
    expect(layout.structuredRegions).toHaveLength(1);
    const region = layout.structuredRegions[0];
    expect(region.page).toBe(1);
    expect(region.confidence).toBeGreaterThanOrEqual(STRUCTURED_MIN_REGION_CONFIDENCE);
    expect(region.detector).toBe('structured-abstract');
    expect(layout.stats.structuredRegionCount).toBe(1);
    expect(layout.stats.structuredLabelCount).toBe(4);
  });

  // Test 2: repeated label / body pattern
  it('groups the repeated label + body pattern into sections', () => {
    const region = layout.structuredRegions[0];
    expect(region.sections).toHaveLength(4);
    const labels = region.sections.map((s) => layout.blocks.find((b) => b.id === s.labelBlock)?.text);
    expect(labels).toEqual(['Overview', 'Purpose', 'Findings', 'Interpretation']);
    for (const s of region.sections) {
      expect(s.inline).toBe(true);
      expect(s.bodyBlocks.length).toBeGreaterThanOrEqual(1);
      expect(s.bbox.width).toBeGreaterThan(300);
    }
    // sections are stacked, never overlapping
    for (let i = 1; i < region.sections.length; i++) {
      expect(region.sections[i].bbox.y + region.sections[i].bbox.height).toBeLessThanOrEqual(region.sections[i - 1].bbox.y + 0.01);
    }
  });

  it('splits each run-in label off its paragraph and links the two', () => {
    const labels = blocksOf(layout, 'STRUCTURED_LABEL');
    expect(labels).toHaveLength(4);
    for (const label of labels) {
      expect(label.type).toBe('HEADING');
      expect(label.lineCount).toBe(1);
      expect(label.translate).toBe(true);
      expect(label.roleDetector).toBe('structured-abstract');
      const body = layout.blocks.find((b) => b.id === label.labelFor);
      expect(body).toBeDefined();
      expect(body?.labelBlockId).toBe(label.id);
      expect(roleOf(body as TextBlock)).toBe('BODY');
      expect(body?.text.startsWith(label.text)).toBe(false);
      // the paragraph's first line now starts after the label
      expect((body as TextBlock).lines[0].x).toBeGreaterThan(label.x + label.width);
    }
    const overview = labels.find((l) => l.text === 'Overview') as TextBlock;
    const body = layout.blocks.find((b) => b.id === overview.labelFor) as TextBlock;
    expect(body.text).toMatch(/^Older adults who become bedbound/);
    expect(body.lineCount).toBe(2);
  });

  it('keeps the heading above and the ordinary paragraphs below as they were', () => {
    const summary = layout.blocks.find((b) => b.text === 'Summary') as TextBlock;
    expect(summary.type).toBe('HEADING');
    expect(roleOf(summary)).toBe('HEADING');
    const intro = layout.blocks.find((b) => b.text === '1. Introduction') as TextBlock;
    expect(roleOf(intro)).toBe('HEADING');
    const body = layout.blocks.find((b) => b.text.startsWith('Community-dwelling participants')) as TextBlock;
    expect(roleOf(body)).toBe('BODY');
    expect(body.labelBlockId).toBeUndefined();
  });

  // Test 3: label confidence
  it('scores a bold, capitalised run-in label with text after it above the threshold', () => {
    const body = layout.blocks.find((b) => b.text.startsWith('Older adults')) as TextBlock;
    expect(body.roleConfidence).toBeGreaterThanOrEqual(STRUCTURED_MIN_LABEL_CONFIDENCE);
    const section = layout.structuredRegions[0].sections[0];
    expect(section.signals).toContain('bold-font');
    expect(section.signals).toContain('text-follows');
    expect(section.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('gives a plain single word without contrast a low confidence', () => {
    const analysis = analysisOf([...para(['Results were mixed across all sites and', 'depended on the season of enrolment.'], 50, 700)]);
    const plain = analyzeLayout(analysis);
    expect(plain.structuredRegions).toHaveLength(0);
    const block = plain.blocks[0];
    expect(findRunInLabel(block)).toBeNull();
    expect(standaloneLabelCandidate(block)).toBeNull();
  });

  it('detects standalone labels on their own line as a region without splitting', () => {
    const standalone = analyzeLayout(caseStandalone());
    expect(standalone.structuredRegions).toHaveLength(1);
    const region = standalone.structuredRegions[0];
    expect(region.sections).toHaveLength(3);
    for (const s of region.sections) expect(s.inline).toBe(false);
    const labels = blocksOf(standalone, 'STRUCTURED_LABEL').map((b) => b.text);
    expect(labels).toEqual(['Background', 'Approach', 'Outcome']);
    for (const b of blocksOf(standalone, 'STRUCTURED_LABEL')) expect(b.labelFor).toBeUndefined();
  });

  // Test 4: uppercase text that is not a label
  it('does not turn an ordinary upper-case sentence into a label', () => {
    const analysis = analysisOf([
      item('THIS STUDY WAS APPROVED BY THE INSTITUTIONAL REVIEW BOARD AND ALL PARTICIPANTS', 50, 700),
      item('GAVE WRITTEN INFORMED CONSENT BEFORE ENROLMENT IN THE COHORT.', 50, 687.5),
      ...para(BODY_LINES, 50, 650),
      item('NOTE', 50, 590),
      ...para(BODY_LINES, 50, 577.5),
    ]);
    const out = analyzeLayout(analysis);
    expect(out.structuredRegions).toHaveLength(0);
    expect(blocksOf(out, 'STRUCTURED_LABEL')).toHaveLength(0);
    for (const b of out.blocks) expect(b.labelFor).toBeUndefined();
  });

  it('leaves a single bold lead-in without a repeated pattern as BODY', () => {
    const analysis = analysisOf([
      ...runIn('Note', ['this paragraph opens with an emphasised word but', 'no other paragraph on the page does the same.'], 50, 700),
      ...para(BODY_LINES, 50, 650),
      ...para(BODY_LINES, 50, 580),
    ]);
    const out = analyzeLayout(analysis);
    expect(out.structuredRegions).toHaveLength(0);
    expect(blocksOf(out, 'STRUCTURED_LABEL')).toHaveLength(0);
    expect(out.blocks[0].text).toMatch(/^Note this paragraph/);
  });

  it('scores a candidate from typography and geometry, the hint words only add a bonus', () => {
    const analysis = analysisOf([...runIn('Overview', ['the label is bold and the text follows.'], 50, 700), ...runIn('Zebra', ['the label is bold and the text follows.'], 50, 660)]);
    const out = analyzeLayout(analysis, { detectLayoutRoles: false });
    const [hinted, unhinted] = out.blocks.map((b) => findRunInLabel(b));
    const ctx = (b: TextBlock) => ({ block: b, next: null, rules: [], referenceFontSize: 10 });
    const a = scoreLabel(hinted!, ctx(out.blocks[0]));
    const z = scoreLabel(unhinted!, ctx(out.blocks[1]));
    expect(z.confidence).toBeGreaterThanOrEqual(STRUCTURED_MIN_LABEL_CONFIDENCE);
    expect(a.confidence - z.confidence).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(a.signals).toContain('hint-words');
    expect(z.signals).not.toContain('hint-words');
  });
});

// ---------------------------------------------------------------------------
// 5–10: sidebar
// ---------------------------------------------------------------------------

describe('sidebar detection', () => {
  const layout = analyzeLayout(caseB());

  // Test 5: container
  it('detects the shaded panel beside the main column as a SIDEBAR container', () => {
    expect(layout.containers).toHaveLength(1);
    const c = layout.containers[0];
    expect(c.type).toBe('SIDEBAR');
    expect(c.page).toBe(1);
    expect(c.confidence).toBeGreaterThanOrEqual(SIDEBAR_MIN_CONFIDENCE);
    expect(c.bbox).toEqual({ x: PANEL.x, y: PANEL.y, width: PANEL.width, height: PANEL.height });
    expect(c.signals).toContain('background-fill');
    expect(c.signals).toContain('narrower-than-column');
    expect(c.detector).toBe('sidebar');
    expect(layout.stats.sidebarCount).toBe(1);
    expect(layout.stats.calloutCount).toBe(0);
  });

  // Test 6: background
  it('extracts the fill colour, the inner padding and the text colour', () => {
    const c = layout.containers[0];
    expect(c.backgroundFill).toBe('#e8f0f8');
    expect(c.textOnDark).toBe(false);
    expect(c.border).toBeNull();
    expect(c.padding.left).toBeGreaterThan(0);
    expect(c.padding.top).toBeGreaterThan(0);
    expect(c.bodyFontSize).toBe(9);
  });

  // Test 7: children ownership
  it('owns every text block inside the panel, and nothing outside it', () => {
    const c = layout.containers[0];
    expect(c.children).toHaveLength(5);
    expect(layout.stats.sidebarChildCount).toBe(5);
    for (const id of c.children) {
      const b = layout.blocks.find((x) => x.id === id) as TextBlock;
      expect(b.containerId).toBe(c.id);
      expect(b.roleDetector).toBe('sidebar');
      expect(b.x).toBeGreaterThanOrEqual(c.bbox.x);
      expect(b.x + b.width).toBeLessThanOrEqual(c.bbox.x + c.bbox.width + 0.01);
    }
    for (const b of layout.blocks) {
      if (c.children.includes(b.id)) continue;
      expect(b.containerId).toBeUndefined();
      expect(['BODY', 'HEADING']).toContain(roleOf(b));
    }
    expect(layout.stats.duplicateSourceItems).toBe(0);
  });

  // Test 8: heading
  it('marks the first short bold child as the sidebar heading', () => {
    const headings = blocksOf(layout, 'SIDEBAR_HEADING');
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toBe('Highlights');
    expect(headings[0].labelFor).toBeUndefined();
  });

  // Test 9: labels
  it('marks the run-in bold openers as sidebar labels split off their paragraphs', () => {
    const labels = blocksOf(layout, 'SIDEBAR_LABEL');
    expect(labels.map((b) => b.text)).toEqual(['What we found', 'Why it matters']);
    for (const l of labels) {
      expect(l.labelFor).toBeDefined();
      const body = layout.blocks.find((b) => b.id === l.labelFor) as TextBlock;
      expect(roleOf(body)).toBe('SIDEBAR_BODY');
      expect(body.labelBlockId).toBe(l.id);
    }
  });

  // Test 10: body
  it('marks the remaining text as sidebar body and keeps the main column as BODY', () => {
    const bodies = blocksOf(layout, 'SIDEBAR_BODY');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].text).toMatch(/^dementia raised the/);
    expect(bodies[1].text).toMatch(/^caregivers of bedbound/);
    const main = layout.blocks.filter((b) => b.x === 50 && b.type === 'BODY');
    expect(main).toHaveLength(3);
    for (const b of main) expect(roleOf(b)).toBe('BODY');
  });

  it('never merges a sidebar paragraph with the main text', () => {
    for (const u of layout.translationBlocks) {
      const containers = new Set(u.sourceBlockIds.map((id) => layout.blocks.find((b) => b.id === id)?.containerId));
      expect(containers.size).toBe(1);
    }
    const sidebarUnits = layout.translationBlocks.filter((u) => u.containerId);
    expect(sidebarUnits).toHaveLength(5);
    expect(sidebarUnits.map((u) => u.role)).toEqual(['SIDEBAR_HEADING', 'SIDEBAR_LABEL', 'SIDEBAR_BODY', 'SIDEBAR_LABEL', 'SIDEBAR_BODY']);
  });

  it('accepts a bordered panel and a panel with a header band as well', () => {
    const banded = analyzeLayout(caseB({ withHeaderBand: true, topRule: true }));
    expect(banded.containers).toHaveLength(1);
    expect(banded.containers[0].children.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 11–13 and the single coloured word: false positives
// ---------------------------------------------------------------------------

describe('sidebar false positives', () => {
  // Test 11: grey table rows
  it('does not turn shaded table rows into a sidebar', () => {
    const rows = [
      ['Characteristic', 'Bedbound', 'Missing', 'P value'],
      ['Female', '389 (63.0)', '0', '<.001'],
      ['Male', '201 (37.0)', '0', '.05'],
      ['Medicaid', '195 (31.9)', '35', '<.001'],
      ['Dementia', '312 (52.9)', '12', '<.001'],
    ];
    const xs = [50, 200, 270, 330];
    const items: TextItemDebug[] = [...para(BODY_LINES, 50, 720)];
    rows.forEach((r, i) => r.forEach((t, c) => items.push(item(t, xs[c], 600 - i * 14, { fs: 8 }))));
    const fills: FilledRect[] = [1, 3].map((i) => ({ x: 45, y: 600 - i * 14 - 4, width: 315, height: 12, color: '#f2f2f2' }));
    const out = analyzeLayout(analysisOf([...items, ...para(BODY_LINES, 50, 480)], { 1: { fills } }));
    expect(out.containers).toHaveLength(0);
    expect(out.blocks.some((b) => b.containerId)).toBe(false);
  });

  // Test 12: figure legend box
  it('does not turn a figure legend box into a sidebar', () => {
    const items = [
      ...para(BODY_LINES, 50, 720),
      item('Figure 2. Flow of participants through the trial.', 310, 545, { fs: 8 }),
      item('Solid line, intervention group; dashed line, control group.', 310, 533, { fs: 8 }),
      item('Values are means with 95% confidence intervals.', 310, 521, { fs: 8 }),
      ...para(BODY_LINES, 50, 450),
    ];
    const fills: FilledRect[] = [{ x: 300, y: 510, width: 260, height: 50, color: '#f0f0f0' }];
    const out = analyzeLayout(analysisOf(items, { 1: { fills } }));
    expect(out.containers).toHaveLength(0);
    expect(out.blocks.filter((b) => b.type === 'CAPTION').length).toBeGreaterThanOrEqual(1);
  });

  // Test 13: two-column body under a tint
  it('does not turn a tinted two-column body area into a callout', () => {
    const left = (top: number) => para(['Older adults who become bedbound near', 'the end of life need substantial help', 'from family caregivers every single', 'day of the last months of their lives.'], 50, top);
    const right = (top: number) => para(['Weighted regression models estimated', 'the odds of being bedbound by dementia', 'status, age and living arrangement in', 'the national sample of older decedents.'], 320, top);
    const items = [...left(690), ...left(620), ...left(550), ...left(480), ...right(690), ...right(620), ...right(550), ...right(480)];
    const fills: FilledRect[] = [{ x: 40, y: 400, width: 530, height: 320, color: '#f7f7f0' }];
    const out = analyzeLayout(analysisOf(items, { 1: { fills } }));
    expect(out.pages[0].layout).toBe('TWO_COLUMN');
    expect(out.containers).toHaveLength(0);
    for (const b of out.blocks) expect(roleOf(b)).toBe('BODY');
  });

  it('never makes a container out of a single coloured word or a one-line highlight', () => {
    const items = [...para(BODY_LINES, 50, 720), item('NEW', 50, 640, { bold: true }), item('Important', 300, 600, { bold: true }), ...para(BODY_LINES, 50, 560)];
    const fills: FilledRect[] = [
      { x: 48, y: 636, width: 24, height: 12, color: '#ffe066' },
      { x: 295, y: 590, width: 80, height: 40, color: '#ffe066' },
    ];
    const out = analyzeLayout(analysisOf(items, { 1: { fills } }));
    expect(out.containers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 14–16: background-aware masking
// ---------------------------------------------------------------------------

function fakeBlock(x: number, y: number, width: number, height: number, containerId?: string): TextBlock {
  return {
    id: 'b',
    page: 1,
    type: 'BODY',
    sectionType: 'MAIN',
    blockType: 'BODY',
    text: 'x',
    x,
    y,
    width,
    height,
    top: y + height,
    fontSize: 10,
    fontName: 'g_reg',
    fontRealName: 'Helvetica',
    column: 'FULL',
    lineCount: 1,
    lines: [],
    order: 0,
    translate: true,
    skipReason: null,
    containerId,
  };
}

function container(id: string, bbox: LayoutContainer['bbox'], fill: string | null): LayoutContainer {
  return {
    id,
    type: 'SIDEBAR',
    page: 1,
    bbox,
    backgroundFill: fill,
    border: null,
    padding: { left: 4, right: 4, top: 4, bottom: 4 },
    children: [],
    confidence: 0.9,
    signals: [],
    detector: 'sidebar',
    bodyFontSize: 9,
    textOnDark: false,
  };
}

describe('background-aware masking', () => {
  const panel = container('c1', { x: 380, y: 420, width: 180, height: 300 }, '#e8f0f8');
  const containers = new Map([[panel.id, panel]]);
  const pageInfo = fixturePage(1, {
    fills: [
      { x: 380, y: 420, width: 180, height: 300, color: '#e8f0f8' },
      { x: 380, y: 692, width: 180, height: 28, color: '#c0d0e0' },
      { x: 60, y: 300, width: 200, height: 40, color: '#ffe0e0' },
    ],
    rules: [{ orientation: 'horizontal', x0: 380, y0: 720, x1: 560, y1: 720, thickness: 0.5 }],
  });

  // Test 14: priority order
  it('takes the enclosing container fill first, a covering fill second, then the page, then white', () => {
    const inBand = getBackgroundForBlock(fakeBlock(392, 698, 100, 12, 'c1'), pageInfo, containers);
    expect(inBand.source).toBe('container');
    expect(inBand.color).toBe('#c0d0e0');
    expect(inBand.clip).toEqual(panel.bbox);

    const inPanel = getBackgroundForBlock(fakeBlock(392, 500, 100, 30, 'c1'), pageInfo, containers);
    expect(inPanel.source).toBe('container');
    expect(inPanel.color).toBe('#e8f0f8');

    const overFill = getBackgroundForBlock(fakeBlock(70, 305, 150, 20), pageInfo, containers);
    expect(overFill.source).toBe('fill');
    expect(overFill.color).toBe('#ffe0e0');
    expect(overFill.clip).toEqual({ x: 60, y: 300, width: 200, height: 40 });

    const plain = getBackgroundForBlock(fakeBlock(50, 600, 300, 40), pageInfo, containers);
    expect(plain.source).toBe('white');
    expect(plain.color).toBeNull();
    expect(plain.clip).toBeNull();

    const tinted = fixturePage(1, { fills: [{ x: 0, y: 0, width: 612, height: 792, color: '#fffbe6' }] });
    const onPage = getBackgroundForBlock(fakeBlock(50, 600, 300, 40), tinted, new Map());
    expect(onPage.source).toBe('page');
    expect(onPage.color).toBe('#fffbe6');
  });

  it('keeps the container colour even when it is dark, and only flips the text to white', () => {
    const dark = container('c2', { x: 380, y: 420, width: 180, height: 300 }, '#1f3a5f');
    const bg = getBackgroundForBlock(fakeBlock(392, 500, 100, 30, 'c2'), fixturePage(1), new Map([[dark.id, dark]]));
    expect(bg.color).toBe('#1f3a5f');
    expect(bg.light).toBe(true);
  });

  // Test 15: contrast
  it('chooses dark text on a light fill and light text on a dark fill', () => {
    const light = analyzeLayout(caseB({ fill: '#f4f3ec' }));
    expect(light.containers[0].textOnDark).toBe(false);
    const dark = analyzeLayout(caseB({ fill: '#123456' }));
    expect(dark.containers).toHaveLength(1);
    expect(dark.containers[0].backgroundFill).toBe('#123456');
    expect(dark.containers[0].textOnDark).toBe(true);
  });

  // Test 16: border preservation
  it('keeps a line mask off the panel border and inside the panel', () => {
    const line: TextLine = { page: 1, text: 'Highlights', x: 381, y: 692, width: 60, height: 10, fontSize: 10, fontName: 'g_bold', fontRealName: 'Helvetica-Bold', column: 'FULL', items: [] };
    const bg: BlockBackground = { color: '#e8f0f8', source: 'container', light: false, clip: panel.bbox, container: panel };
    const r = lineMaskRect(line, pageInfo, bg);
    expect(r).not.toBeNull();
    const rect = r as NonNullable<typeof r>;
    // never over the top rule at y = 720 (0.5 pt thick, 1 pt clearance)
    expect(rect.y + rect.height).toBeLessThanOrEqual(720 - 0.25 - 1 + 1e-6);
    // never outside the panel
    expect(rect.x).toBeGreaterThanOrEqual(panel.bbox.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(panel.bbox.x + panel.bbox.width);
    // but still covering the glyphs themselves
    expect(rect.y).toBeLessThanOrEqual(692 - 2.5);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(441);
  });

  it('masks only the glyph box plus a minimal padding, never the whole container', () => {
    const line: TextLine = { page: 1, text: 'x', x: 392, y: 500, width: 100, height: 9, fontSize: 9, fontName: 'g_reg', fontRealName: 'Helvetica', column: 'FULL', items: [] };
    const bg: BlockBackground = { color: '#e8f0f8', source: 'container', light: false, clip: panel.bbox, container: panel };
    const rect = lineMaskRect(line, pageInfo, bg) as NonNullable<ReturnType<typeof lineMaskRect>>;
    expect(rect.width).toBeLessThanOrEqual(100 + 3);
    expect(rect.height).toBeLessThanOrEqual(9 * 1.05 + 2);
  });
});

// ---------------------------------------------------------------------------
// 17–18: ownership and translation scope
// ---------------------------------------------------------------------------

describe('source ownership', () => {
  // Test 17
  it('assigns every source text item to exactly one block, labels included', () => {
    for (const analysis of [caseA(), caseB(), caseC(), caseStandalone()]) {
      const layout = analyzeLayout(analysis);
      expect(layout.stats.duplicateSourceItems).toBe(0);
      const owned = itemsOf(layout.blocks);
      expect(owned).toHaveLength(analysis.items.length);
      expect(new Set(owned).size).toBe(analysis.items.length);
      expect(layout.stats.roleClaimedSourceItems).toBeGreaterThan(0);
      // a label and its paragraph never share an item
      for (const label of layout.blocks.filter((b) => b.labelFor)) {
        const body = layout.blocks.find((b) => b.id === label.labelFor) as TextBlock;
        const labelItems = new Set(itemsOf([label]));
        for (const it of itemsOf([body])) expect(labelItems.has(it)).toBe(false);
      }
      // every unit's source blocks exist and no block is in two units
      const seen = new Set<string>();
      for (const u of layout.translationBlocks) {
        for (const id of u.sourceBlockIds) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      }
    }
  });

  it('records which detector owns which block', () => {
    const layout = analyzeLayout(caseB());
    expect(layout.roleOwnership.sidebar).toBe(5);
    expect(layout.roleOwnership['structured-abstract']).toBeUndefined();
  });

  // Test 18
  it('follows the translation scope: an unselected page contributes no sidebar or label units', () => {
    const page1 = caseB();
    const page2 = caseA();
    const items = [...page1.items, ...page2.items.map((i) => ({ ...i, page: 2 }))];
    const analysis = analysisOf(items, { 1: { fills: [PANEL] } });
    const layout = analyzeLayout(analysis);
    expect(layout.containers).toHaveLength(1);
    expect(layout.structuredRegions).toHaveLength(1);
    expect(layout.structuredRegions[0].page).toBe(2);

    const only2 = resolveTranslationScope(layout.translationBlocks, [], { mode: 'pages', startPage: 2, endPage: 2 }, { pageCount: 2, blocks: layout.blocks, pages: analysis.pages });
    expect(only2.ok).toBe(true);
    if (!only2.ok) return;
    expect(only2.units.some((u) => u.containerId)).toBe(false);
    expect(only2.units.filter((u) => u.role === 'STRUCTURED_LABEL')).toHaveLength(4);
    expect(only2.stats.duplicateSourceItems).toBe(0);

    const only1 = resolveTranslationScope(layout.translationBlocks, [], { mode: 'pages', startPage: 1, endPage: 1 }, { pageCount: 2, blocks: layout.blocks, pages: analysis.pages });
    expect(only1.ok).toBe(true);
    if (!only1.ok) return;
    expect(only1.units.filter((u) => u.containerId)).toHaveLength(5);
    expect(only1.units.some((u) => u.role === 'STRUCTURED_LABEL')).toBe(false);
    expect(only1.stats.duplicateSourceItems).toBe(0);
  });

  it('sends the role to the Worker as the unit type, and nothing else changes', () => {
    const layout = analyzeLayout(caseB());
    const payload = buildPayload(layout.translationBlocks, layout.translationBlocks);
    const byId = new Map(payload.map((p) => [p.id, p]));
    for (const u of layout.translationBlocks) {
      const sent = byId.get(u.id)?.type;
      if (u.role && WORKER_ROLE_TYPES.has(u.role)) expect(sent).toBe(u.role);
      else if (u.type === 'BODY') expect(sent).toBeUndefined();
      else expect(sent).toBe(u.type);
    }
    expect(payload.filter((p) => p.type === 'SIDEBAR_BODY')).toHaveLength(2);
    expect(payload.every((p) => !('page' in p) && !('role' in p))).toBe(true);
  });

  it('keeps structured labels and sidebar headings out of the chapter list', () => {
    const analysis = caseStandalone();
    const layout = analyzeLayout(analysis);
    const detected = detectChapters(analysis, layout);
    const titles = detected.chapters.map((c) => c.title);
    expect(titles).not.toContain('Background');
    expect(titles).not.toContain('Approach');
    const sidebar = analyzeLayout(caseB());
    const chapters = detectChapters(caseB(), sidebar).chapters.map((c) => c.title);
    expect(chapters).not.toContain('Highlights');
  });
});

// ---------------------------------------------------------------------------
// 19–21: regressions
// ---------------------------------------------------------------------------

describe('regressions', () => {
  const analysis = documentAnalysis();
  const withRoles = analyzeLayout(analysis);
  const withoutRoles = analyzeLayout(analysis, { detectLayoutRoles: false });

  // Test 19
  it('resolves the table exactly as before', () => {
    expect(withRoles.tables).toEqual(withoutRoles.tables);
    expect(withRoles.tables[0].resolved).toBe(true);
    for (const b of withRoles.blocks.filter((b) => b.type === 'TABLE')) {
      expect(roleOf(b)).toBe('TABLE');
      expect(b.containerId).toBeUndefined();
      expect(b.roleDetector).toBe('table');
    }
  });

  // Test 20
  it('resolves the figure exactly as before', () => {
    expect(withRoles.figures).toEqual(withoutRoles.figures);
    expect(withRoles.figures[0].resolved).toBe(true);
    for (const b of withRoles.blocks.filter((b) => b.type === 'FIGURE')) {
      expect(roleOf(b)).toBe('FIGURE');
      expect(b.roleDetector).toBe('figure');
    }
  });

  // Test 21
  it('leaves ordinary body text, headings and the unit list untouched', () => {
    expect(withRoles.containers).toHaveLength(0);
    expect(withRoles.structuredRegions).toHaveLength(0);
    expect(withRoles.translationBlocks.map((u) => [u.id, u.text])).toEqual(withoutRoles.translationBlocks.map((u) => [u.id, u.text]));
    expect(withRoles.stats.duplicateSourceItems).toBe(0);
    for (const b of withRoles.blocks) {
      if (b.type === 'BODY') expect(roleOf(b)).toBe('BODY');
      expect(b.labelFor).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 22: generic synthetic cases and the registry
// ---------------------------------------------------------------------------

describe('generic synthetic cases', () => {
  it('Case C: a framed full-width box with a heading is a CALLOUT_BOX', () => {
    const layout = analyzeLayout(caseC());
    expect(layout.containers).toHaveLength(1);
    const c = layout.containers[0];
    expect(c.type).toBe('CALLOUT_BOX');
    expect(c.backgroundFill).toBeNull();
    expect(c.border).toEqual({ thickness: 1, source: 'frame' });
    expect(c.signals).toContain('border:frame');
    expect(c.signals).toContain('heading-first');
    const heading = blocksOf(layout, 'SIDEBAR_HEADING');
    expect(heading.map((b) => b.text)).toEqual(['Clinical implications']);
    const body = blocksOf(layout, 'SIDEBAR_BODY');
    expect(body).toHaveLength(1);
    expect(body[0].text).toMatch(/^Clinicians should ask/);
    // the paragraphs outside the frame stay BODY
    expect(layout.blocks.filter((b) => roleOf(b) === 'BODY' && !b.containerId).length).toBeGreaterThanOrEqual(3);
    expect(layout.stats.duplicateSourceItems).toBe(0);
  });

  it('the registry runs detectors in ownership priority and never lets two claim one block', () => {
    const analysis = caseB();
    const base = analyzeLayout(analysis, { detectLayoutRoles: false });
    const greedy: LayoutDetector = {
      name: 'greedy',
      run(ctx: DetectorContext): DetectorResult {
        const r = emptyResult();
        for (const b of ctx.blocks) r.assignments.push({ blockId: b.id, role: 'SIDEBAR_BODY', confidence: 1, signals: ['greedy'] });
        return r;
      },
    };
    const first = applyLayoutRoles(base.blocks.map((b) => ({ ...b })), analysis, base.pages, base.bodyFontSize, [greedy, ...LAYOUT_DETECTORS]);
    expect(first.ownership.greedy).toBe(base.blocks.length);
    expect(first.ownership.sidebar).toBeUndefined();
    expect(first.containers).toHaveLength(0);

    const second = applyLayoutRoles(base.blocks.map((b) => ({ ...b })), analysis, base.pages, base.bodyFontSize, [...LAYOUT_DETECTORS, greedy]);
    expect(second.ownership.sidebar).toBe(5);
    expect(second.ownership.greedy).toBe(base.blocks.length - 3);
    expect(second.containers).toHaveLength(1);
    // greedy ignores the ledger; the registry drops its claims on owned blocks and says so
    expect(second.diagnostics.filter((d) => /greedy wanted .* but sidebar owns it/.test(d))).toHaveLength(3);
  });

  it('a new pattern is one detector appended to the list, without touching the pipeline', () => {
    const analysis = analysisOf([
      ...para(BODY_LINES, 50, 720),
      item('"Being bedbound is not the end of care, it is where care begins."', 80, 600, { fs: 14, italic: true }),
      ...para(BODY_LINES, 50, 540),
    ]);
    const pullQuote: LayoutDetector = {
      name: 'pull-quote',
      run(ctx: DetectorContext): DetectorResult {
        const r = emptyResult();
        for (const b of ctx.blocks) {
          if (ctx.owned.has(b.id) || b.lineCount !== 1 || b.fontSize < 1.3 * ctx.bodyFontSize || !/^["“]/.test(b.text)) continue;
          r.assignments.push({ blockId: b.id, role: 'SIDEBAR_BODY', confidence: 0.8, signals: ['quote-marks', 'large-italic'] });
        }
        return r;
      },
    };
    const base = analyzeLayout(analysis, { detectLayoutRoles: false });
    const out = applyLayoutRoles(base.blocks, analysis, base.pages, base.bodyFontSize, [...LAYOUT_DETECTORS, pullQuote]);
    const quote = out.blocks.find((b) => b.roleDetector === 'pull-quote') as TextBlock;
    expect(quote).toBeDefined();
    expect(roleOf(quote)).toBe('SIDEBAR_BODY');
    expect(out.ownership['pull-quote']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Typography hierarchy for the new roles
// ---------------------------------------------------------------------------

describe('role typography', () => {
  const BODY = 8.5;

  it('renders a structured label at least at body size, bold and spaced, with two contrasts', () => {
    const spec = typographyFor({ type: 'HEADING', role: 'STRUCTURED_LABEL', sourceFontSize: BODY, bodyFontSize: BODY, blockHeight: 9 });
    expect(spec.role).toBe('structuredLabel');
    expect(spec.fontSize).toBeGreaterThanOrEqual(BODY);
    expect(spec.minFontSize).toBeGreaterThanOrEqual(BODY * TYPOGRAPHY.structuredLabel.minScale - 1e-6);
    expect(spec.bold).toBe(true);
    expect(spec.spaceBefore).toBeGreaterThanOrEqual(TYPOGRAPHY.minimumHeadingBodyContrast.spaceBeforeEm * spec.fontSize - 1e-6);
    expect(spec.spaceAfter).toBeGreaterThan(0);
    expect(spec.contrast).toContain('weight');
    expect(spec.contrast).toContain('spacing');
    expect(hasRequiredContrast(spec)).toBe(true);
    expect(spec.firstLineIndent).toBe(0);
  });

  it('never lets the fitting floor pull a label below the body size', () => {
    const spec = typographyFor({ type: 'HEADING', role: 'STRUCTURED_LABEL', sourceFontSize: 7, bodyFontSize: BODY, blockHeight: 8 });
    expect(spec.minFontSize).toBeGreaterThanOrEqual(BODY - 1e-6);
    const body = typographyFor({ type: 'BODY', sourceFontSize: BODY, bodyFontSize: BODY, blockHeight: 40 });
    expect(spec.minFontSize).toBeGreaterThan(body.minFontSize);
  });

  it('sizes sidebar roles against the container body, not the document body', () => {
    const heading = typographyFor({ type: 'HEADING', role: 'SIDEBAR_HEADING', sourceFontSize: 8, bodyFontSize: 10, containerBodyFontSize: 7.5, blockHeight: 9 });
    expect(heading.role).toBe('sidebarHeading');
    expect(heading.fontSize).toBeCloseTo(Math.max(8, 7.5 * TYPOGRAPHY.sidebarHeading.sizeScale), 1);
    expect(heading.minFontSize).toBeGreaterThanOrEqual(7.5 * TYPOGRAPHY.sidebarHeading.minScale - 1e-6);
    expect(heading.bold).toBe(true);

    const label = typographyFor({ type: 'HEADING', role: 'SIDEBAR_LABEL', sourceFontSize: 7.5, bodyFontSize: 10, containerBodyFontSize: 7.5, blockHeight: 8 });
    expect(label.fontSize).toBeGreaterThanOrEqual(7.5);
    expect(label.minFontSize).toBeGreaterThanOrEqual(7.5 - 1e-6);
    expect(hasRequiredContrast(label)).toBe(true);

    const body = typographyFor({ type: 'BODY', role: 'SIDEBAR_BODY', sourceFontSize: 7.5, bodyFontSize: 10, containerBodyFontSize: 7.5, blockHeight: 60 });
    expect(body.role).toBe('sidebarBody');
    expect(body.fontSize).toBe(7.5);
    expect(body.firstLineIndent).toBe(0);
    expect(body.bold).toBe(false);
  });

  it('keeps the structured spacing configuration in one place', () => {
    expect(TYPOGRAPHY.spacing.structuredLabelBefore).toBeGreaterThan(0);
    expect(TYPOGRAPHY.spacing.structuredLabelAfter).toBeGreaterThan(0);
    expect(TYPOGRAPHY.spacing.structuredSectionGap).toBeGreaterThan(0);
    expect(TYPOGRAPHY.minimumHeadingBodyContrast.required).toBe(2);
  });
});
