import { describe, expect, it } from 'vitest';
import { CONTEXT_CHARS, MAX_MERGED_BLOCKS, buildTranslationBlocks, contextStats } from '../merge';
import type { BlockType, ColumnRegion, TextBlock } from '../types';

interface Spec {
  id: string;
  page: number;
  text: string;
  type?: BlockType;
  column?: ColumnRegion;
  fontSize?: number;
  translate?: boolean;
}

function block(spec: Spec): TextBlock {
  const type = spec.type ?? 'BODY';
  const translate = spec.translate ?? !['HEADER', 'FOOTER', 'OTHER', 'AUTHOR', 'REFERENCE'].includes(type);
  return {
    id: spec.id,
    page: spec.page,
    type,
    sectionType: 'MAIN',
    blockType: type === 'TABLE' ? 'TABLE_TEXT_LABEL' : type,
    text: spec.text,
    x: 0,
    y: 0,
    width: 100,
    height: 10,
    top: 10,
    fontSize: spec.fontSize ?? 10,
    fontName: 'f1',
    fontRealName: null,
    column: spec.column ?? 'FULL',
    lineCount: 1,
    lines: [],
    order: 0,
    translate,
    skipReason: translate ? null : `type:${type}`,
  };
}

describe('buildTranslationBlocks', () => {
  it('Case 4: merges a sentence cut at the column break', () => {
    const blocks = [
      block({
        id: 'p1-b05',
        page: 1,
        column: 'LEFT',
        text: "for example, the accuracy of OpenAI's premier reasoning model, o1-preview, on basic word",
      }),
      block({
        id: 'p1-b06',
        page: 1,
        column: 'RIGHT',
        text: 'problems is significantly lower when irrelevant information is included.',
      }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('merged-p1-b05-p1-b06');
    expect(out[0].sourceBlockIds).toEqual(['p1-b05', 'p1-b06']);
    expect(out[0].wasMerged).toBe(true);
    expect(out[0].incompleteSource).toBe(false);
    expect(out[0].text).toBe(
      "for example, the accuracy of OpenAI's premier reasoning model, o1-preview, on basic word problems is significantly lower when irrelevant information is included.",
    );
    expect(out[0].mergeReason).toContain('cross-column');
  });

  it('Case 5: merges across a page break, skipping header and footer', () => {
    const blocks = [
      block({ id: 'p1-b12', page: 1, text: 'The results are consistent' }),
      block({ id: 'p1-b13', page: 1, type: 'FOOTER', text: '1' }),
      block({ id: 'p2-b01', page: 2, type: 'HEADER', text: 'Journal of Finance' }),
      block({ id: 'p2-b02', page: 2, text: 'with prior literature showing similar effects.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('merged-p1-b12-p2-b02');
    expect(out[0].pages).toEqual([1, 2]);
    expect(out[0].text).toBe('The results are consistent with prior literature showing similar effects.');
    expect(out[0].mergeReason).toContain('cross-page');
  });

  it('Case 6: never merges across a heading', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'This paragraph has no final period' }),
      block({ id: 'p1-b02', page: 1, type: 'HEADING', text: '2. Data' }),
      block({ id: 'p1-b03', page: 1, text: 'we use quarterly data from Compustat.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out.map((b) => b.id)).toEqual(['p1-b01', 'p1-b02', 'p1-b03']);
    expect(out[0].wasMerged).toBe(false);
    expect(out[0].incompleteSource).toBe(true);
  });

  it('does not merge across a caption', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'Accuracy drops sharply for the' }),
      block({ id: 'p1-b02', page: 1, type: 'CAPTION', text: 'Figure 2. Accuracy by model.' }),
      block({ id: 'p1-b03', page: 1, text: 'largest models in our sample.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out).toHaveLength(3);
    expect(out[0].incompleteSource).toBe(true);
  });

  it('repairs hyphenation at the merge point', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, column: 'LEFT', text: 'We evaluate numerical reason-' }),
      block({ id: 'p1-b02', page: 1, column: 'RIGHT', text: 'ing on three benchmarks.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out[0].text).toBe('We evaluate numerical reasoning on three benchmarks.');
  });

  it('stops after MAX_MERGED_BLOCKS and flags the source as incomplete', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      block({ id: `p1-b0${i + 1}`, page: 1, text: `fragment ${i + 1} continues with the` }),
    );
    const out = buildTranslationBlocks(blocks);
    expect(out[0].sourceBlockIds).toHaveLength(MAX_MERGED_BLOCKS);
    expect(out[0].incompleteSource).toBe(true);
    // the remaining two blocks form their own (still incomplete) unit
    expect(out).toHaveLength(2);
    expect(out[1].sourceBlockIds).toEqual(['p1-b04', 'p1-b05']);
  });

  it('does not merge when the previous block is complete', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'First paragraph ends here.' }),
      block({ id: 'p1-b02', page: 1, text: 'second paragraph starts lowercase for some reason.' }),
    ];
    expect(buildTranslationBlocks(blocks)).toHaveLength(2);
  });

  it('does not merge a weak signal with a block that starts a new sentence', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'Summary statistics' }),
      block({ id: 'p1-b02', page: 1, text: 'Table 1 reports the descriptive statistics.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    expect(out).toHaveLength(2);
    expect(out[0].incompleteSource).toBe(true);
  });

  it('does not merge blocks with clearly different font sizes', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'This ends with the', fontSize: 10 }),
      block({ id: 'p1-b02', page: 1, text: 'next block in a bigger font.', fontSize: 14 }),
    ];
    expect(buildTranslationBlocks(blocks)).toHaveLength(2);
  });

  it('only merges BODY blocks', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, type: 'FOOTNOTE', text: '1 See the appendix for' }),
      block({ id: 'p1-b02', page: 1, type: 'FOOTNOTE', text: 'details on the sample.' }),
    ];
    expect(buildTranslationBlocks(blocks)).toHaveLength(2);
  });

  it('sends no context for complete units (batch neighbours already provide it)', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'One.' }),
      block({ id: 'p1-b02', page: 1, text: 'Two.' }),
      block({ id: 'p1-b03', page: 1, text: 'Three.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    for (const u of out) {
      expect(u.previousContext).toBeNull();
      expect(u.nextContext).toBeNull();
      expect(u.contextReason).toBeNull();
    }
    const stats = contextStats(out);
    expect(stats.inputChars).toBe('One.Two.Three.'.length);
    expect(stats.contextChars).toBe(0);
    expect(stats.contextUnitCount).toBe(0);
    expect(stats.contextCharsSaved).toBeGreaterThan(0);
  });

  it('attaches context to incomplete units and to the unit that continues them', () => {
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: 'Intro sentence.' }),
      // incomplete (ends with a function word) but the next block is a heading, so no merge
      block({ id: 'p1-b02', page: 1, text: 'The results depend on the' }),
      block({ id: 'p1-b03', page: 1, type: 'HEADING', text: 'Results' }),
      block({ id: 'p2-b01', page: 2, text: 'sample period, as Table 2 shows.' }),
      block({ id: 'p2-b02', page: 2, text: 'A complete sentence.' }),
    ];
    const out = buildTranslationBlocks(blocks);
    const byId = new Map(out.map((u) => [u.id, u]));

    const incomplete = byId.get('p1-b02')!;
    expect(incomplete.incompleteSource).toBe(true);
    expect(incomplete.previousContext).toBe('Intro sentence.');
    expect(incomplete.nextContext).toBe('Results');
    expect(incomplete.contextReason).toBe('incomplete');

    const heading = byId.get('p1-b03')!;
    expect(heading.contextReason).toBe('continuation'); // follows an incomplete unit
    expect(heading.previousContext).toBe('The results depend on the');
    expect(heading.nextContext).toBeNull();

    const continuation = byId.get('p2-b01')!;
    expect(continuation.contextReason).toBe('continuation-cross-page'); // lowercase start, new page
    expect(continuation.previousContext).toBe('Results');
    expect(continuation.nextContext).toBeNull();

    expect(byId.get('p2-b02')!.contextReason).toBeNull();
  });

  it('caps context at CONTEXT_CHARS per side and gives merged units both sides', () => {
    const long = 'Word '.repeat(120).trim() + '.';
    const blocks = [
      block({ id: 'p1-b01', page: 1, text: long }),
      block({ id: 'p1-b02', page: 1, text: 'This sentence ends with the', column: 'LEFT' }),
      block({ id: 'p1-b03', page: 1, text: 'other column.', column: 'RIGHT' }),
      block({ id: 'p1-b04', page: 1, text: long }),
    ];
    const out = buildTranslationBlocks(blocks);
    const merged = out.find((u) => u.wasMerged)!;
    expect(merged.contextReason).toBe('merged');
    expect(merged.previousContext!.length).toBeLessThanOrEqual(CONTEXT_CHARS + 1);
    expect(merged.nextContext!.length).toBeLessThanOrEqual(CONTEXT_CHARS + 1);
  });
});
