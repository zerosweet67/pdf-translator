import { describe, expect, it } from 'vitest';
import { captionKind, classifyBlocks, isNumericOnly, looksLikeReferenceEntry } from '../classify';
import type { PageDebugInfo, TextBlock } from '../types';

const PAGE_H = 792;
const PAGE_W = 612;
const BODY = 10;

interface Spec {
  page: number;
  text: string;
  /** Baseline position from the top of the page (points). */
  fromTop: number;
  x?: number;
  width?: number;
  fontSize?: number;
  lines?: number;
}

let counter = 0;
function block(s: Spec): TextBlock {
  const fontSize = s.fontSize ?? BODY;
  const lines = s.lines ?? 1;
  const height = lines * fontSize * 1.2;
  const y = PAGE_H - s.fromTop - height;
  return {
    id: `p${s.page}-b${String(++counter).padStart(3, '0')}`,
    page: s.page,
    type: 'OTHER',
    sectionType: 'MAIN',
    blockType: 'OTHER',
    text: s.text,
    x: s.x ?? 72,
    y,
    width: s.width ?? 468,
    height,
    top: y + height,
    fontSize,
    fontName: 'f1',
    fontRealName: 'TimesNewRomanPSMT',
    column: 'FULL',
    lineCount: lines,
    lines: [],
    order: counter,
    translate: false,
    skipReason: null,
  };
}

function pages(n: number): PageDebugInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    pageNumber: i + 1,
    width: PAGE_W,
    height: PAGE_H,
    rotation: 0,
    view: [0, 0, PAGE_W, PAGE_H],
    textItemCount: 10,
    images: [],
  }));
}

const LONG =
  'Breathlessness is a disabling symptom in people with chronic obstructive pulmonary disease and interstitial lung disease, and it limits the intensity of exercise training in these patients considerably.';

/** A small academic paper: body → references → figure → supplemental figure / table → questionnaire. */
function paper(): TextBlock[] {
  counter = 0;
  return [
    block({ page: 1, text: LONG, fromTop: 200, lines: 3 }),
    block({ page: 1, text: LONG, fromTop: 260, lines: 3 }),
    // references
    block({ page: 2, text: 'REFERENCES', fromTop: 100, width: 80 }),
    block({ page: 2, text: '23. Jones, N.L., Clinical exercise testing. 4th ed. 1997, Philadelphia: Saunders.', fromTop: 130 }),
    block({ page: 2, text: '24. Borg, G.A., Psychophysical bases of perceived exertion. Med Sci Sports Exerc, 1982. 14(5): p. 377-81.', fromTop: 160, lines: 2 }),
    block({ page: 2, text: 'breathlessness and recovery time in patients with COPD: a pilot randomised controlled', fromTop: 200, x: 108 }),
    // Case 1: figure after the reference list
    block({ page: 3, text: 'Figure 1. Experimental study design, showing two baseline exercise training outcome assessment visits.', fromTop: 500, lines: 2 }),
    // Case 2: supplemental figure
    block({ page: 4, text: 'Supplemental Material Figure 2. Changes in body composition outcome variables from baseline to post-ExT.', fromTop: 500, lines: 2 }),
    // Case 3–5: supplemental table
    block({ page: 5, text: 'Supplemental Material Table 3. Baseline participant demographics of people with chronic obstructive pulmonary disease (COPD)', fromTop: 80 }),
    block({ page: 5, text: 'only in the fan-to-face (F2F) and no fan (NF) groups.', fromTop: 95, width: 260 }),
    block({ page: 5, text: 'F2F group (n=12)', fromTop: 120, x: 300, width: 90 }),
    block({ page: 5, text: 'Female, n (%)', fromTop: 140, width: 70 }),
    block({ page: 5, text: '5 (41)', fromTop: 140, x: 330, width: 30 }),
    block({ page: 5, text: 'Age, years', fromTop: 155, width: 50 }),
    block({ page: 5, text: '67.6 ± 5.2', fromTop: 155, x: 330, width: 50 }),
    block({ page: 5, text: '72.3 ± 6.9', fromTop: 155, x: 450, width: 50 }),
    block({ page: 5, text: 'Smoking history', fromTop: 170, width: 80 }),
    block({ page: 5, text: 'p<0.001', fromTop: 170, x: 450, width: 40 }),
    block({ page: 5, text: 'Clinical Diagnosis', fromTop: 185, width: 90 }),
    block({ page: 5, text: 'COPD', fromTop: 200, width: 30 }),
    block({ page: 5, text: 'Medication Summary', fromTop: 215, width: 100 }),
    block({ page: 5, text: 'Note: Data are presented as mean ± standard deviation, unless otherwise stated.', fromTop: 300, fontSize: 9 }),
    // Case 6: questionnaire
    block({ page: 6, text: 'End-of-Study Questionnaires for All Participants', fromTop: 100, width: 250 }),
    block({ page: 6, text: 'Why did you choose this criterion (please explain)?', fromTop: 130, width: 280 }),
    block({ page: 6, text: 'Uncertain about benefit', fromTop: 150, width: 120 }),
  ];
}

function classified(): Map<string, TextBlock> {
  const blocks = paper();
  classifyBlocks(blocks, pages(6), BODY);
  return new Map(blocks.map((b) => [b.text, b]));
}

describe('reference section boundary', () => {
  const byText = classified();
  const get = (prefix: string) => [...byText.values()].find((b) => b.text.startsWith(prefix))!;

  it('keeps real bibliography entries untranslated', () => {
    for (const p of ['23. Jones', '24. Borg']) {
      const b = get(p);
      expect(b.sectionType).toBe('REFERENCES');
      expect(b.blockType).toBe('REFERENCE');
      expect(b.translate).toBe(false);
      expect(b.skipReason).toBe('REFERENCE_ENTRY');
    }
    const cont = get('breathlessness and recovery');
    expect(cont.blockType).toBe('REFERENCE');
    expect(cont.translate).toBe(false);
    expect(cont.skipReason).toBe('REFERENCE_CONTINUATION');
  });

  it('Case 1: a figure caption after the references ends REFERENCES and is translated', () => {
    const b = get('Figure 1.');
    expect(b.sectionType).toBe('FIGURES');
    expect(b.blockType).toBe('FIGURE_CAPTION');
    expect(b.type).toBe('CAPTION');
    expect(b.translate).toBe(true);
  });

  it('Case 2: supplemental figure caption', () => {
    const b = get('Supplemental Material Figure 2.');
    expect(b.sectionType).toBe('SUPPLEMENTAL');
    expect(b.blockType).toBe('FIGURE_CAPTION');
    expect(b.translate).toBe(true);
  });

  it('Case 3: supplemental table caption (and its continuation line)', () => {
    const cap = get('Supplemental Material Table 3.');
    expect(cap.sectionType).toBe('SUPPLEMENTAL');
    expect(cap.blockType).toBe('TABLE_CAPTION');
    expect(cap.translate).toBe(true);
    const cont = get('only in the fan-to-face');
    expect(cont.blockType).toBe('TABLE_CAPTION');
    expect(cont.translate).toBe(true);
  });

  it('Case 4: table text labels and headers are translated', () => {
    expect(get('F2F group (n=12)').blockType).toBe('TABLE_HEADER');
    for (const label of ['Female, n (%)', 'Age, years', 'Smoking history', 'Clinical Diagnosis', 'Medication Summary']) {
      const b = get(label);
      expect(b.type, label).toBe('TABLE');
      expect(b.blockType, label).toBe('TABLE_TEXT_LABEL');
      expect(b.translate, label).toBe(true);
    }
    const abbr = get('COPD');
    expect(abbr.translate).toBe(false);
    expect(abbr.skipReason).toBe('ABBREVIATION_ONLY');
    const note = get('Note: Data are');
    expect(note.blockType).toBe('TABLE_NOTE');
    expect(note.translate).toBe(true);
  });

  it('Case 5: numeric cells are preserved and not sent to the API', () => {
    for (const cell of ['5 (41)', '67.6 ± 5.2', '72.3 ± 6.9', 'p<0.001']) {
      const b = get(cell);
      expect(b.blockType, cell).toBe('TABLE_CELL');
      expect(b.translate, cell).toBe(false);
      expect(b.skipReason, cell).toBe('NUMERIC_ONLY');
    }
  });

  it('Case 6: questionnaire items in the supplement are translated', () => {
    const q = get('Why did you choose');
    expect(q.sectionType).toBe('SUPPLEMENTAL');
    expect(q.blockType).toBe('QUESTIONNAIRE');
    expect(q.translate).toBe(true);
    const option = get('Uncertain about benefit');
    expect(option.blockType).toBe('QUESTIONNAIRE');
    expect(option.translate).toBe(true);
    expect(get('End-of-Study Questionnaires').translate).toBe(true);
  });

  it('recognizes a references heading that is not typeset as a heading', () => {
    counter = 0;
    const blocks = [
      block({ page: 1, text: LONG, fromTop: 200, lines: 3 }),
      block({ page: 2, text: 'REFERENCES', fromTop: 100, width: 60, fontSize: 8 }),
      block({ page: 2, text: 'Ball, R., and P. Brown. “An Empirical Evaluation of Accounting Income Numbers.” Journal of', fromTop: 130, fontSize: 8 }),
      block({ page: 2, text: 'Accounting Research 6 (1968): 159–78.', fromTop: 142, fontSize: 8 }),
    ];
    classifyBlocks(blocks, pages(2), BODY);
    expect(blocks.slice(2).map((b) => [b.blockType, b.translate])).toEqual([
      ['REFERENCE', false],
      ['REFERENCE', false],
    ]);
  });
});

describe('helpers', () => {
  it('detects bibliography entries', () => {
    expect(looksLikeReferenceEntry('23. Jones, N.L., Clinical exercise testing...')).toBe(true);
    expect(looksLikeReferenceEntry('Borg, G.A., Psychophysical bases of perceived exertion.')).toBe(true);
    expect(looksLikeReferenceEntry('Maltais, F., et al., Intensity of training. Am J Respir Crit Care Med, 1997. 155(2): p. 555-61.')).toBe(true);
    expect(looksLikeReferenceEntry('Figure 1. Experimental study design...')).toBe(false);
    expect(looksLikeReferenceEntry('Why did you choose this criterion (please explain)?')).toBe(false);
  });

  it('recognizes strict captions only', () => {
    expect(captionKind('Figure 1. Experimental study design')).toBe('FIGURE');
    expect(captionKind('Supplemental Material Table 3. Baseline')).toBe('TABLE');
    expect(captionKind('Supplementary Figure S2: Flow')).toBe('FIGURE');
    expect(captionKind('Fig. B1.—Testing foundational accounting operations.')).toBe('FIGURE');
    expect(captionKind('Table 1 reports summary statistics')).toBe(null);
    expect(captionKind('Table 2 for peak CWR CPET data.')).toBe(null);
  });

  it('recognizes numeric-only cells', () => {
    for (const t of ['67.6 ± 5.2', '72.3 ± 6.9', 'n=12', 'p<0.001', '83%', '10,589±7,251', '5 (41)', '-', '- -', '3.1*', '[4.2, 11.3]'])
      expect(isNumericOnly(t), t).toBe(true);
    for (const t of ['Female', 'Age, years', 'Smoking history', 'Body mass index', '95% CI', 'n (%)'])
      expect(isNumericOnly(t), t).toBe(false);
  });
});
