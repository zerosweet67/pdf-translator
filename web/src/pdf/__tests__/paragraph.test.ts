import { describe, expect, it } from 'vitest';
import { buildTranslationBlocks } from '../merge';
import { absorbOrphanFragments, orphanSignals, planOrphanMerges } from '../paragraph';
import type { BlockType, ColumnRegion, DetailedBlockType, TableCellInfo, TextBlock } from '../types';

interface Spec {
  id: string;
  page?: number;
  text: string;
  type?: BlockType;
  blockType?: DetailedBlockType;
  column?: ColumnRegion;
  fontSize?: number;
  lineCount?: number;
  translate?: boolean;
  skipReason?: string | null;
  cell?: TableCellInfo;
  /** Bottom edge; by default every new block is stacked under the previous one. */
  y?: number;
}

/**
 * Blocks are declared in reading order, so each one is placed under the one
 * before it. A tail has to *follow* its paragraph, and without a real column
 * the geometry check in paragraph.ts has nothing to look at.
 */
let nextY = 100000;

function block(spec: Spec): TextBlock {
  const type = spec.type ?? 'BODY';
  const y = spec.y ?? (nextY -= 20);
  const translate = spec.translate ?? !['HEADER', 'FOOTER', 'OTHER', 'AUTHOR', 'REFERENCE'].includes(type);
  return {
    id: spec.id,
    page: spec.page ?? 1,
    type,
    sectionType: 'MAIN',
    blockType: spec.blockType ?? (type as DetailedBlockType),
    text: spec.text,
    x: 0,
    y,
    width: 200,
    height: 10,
    top: y + 10,
    fontSize: spec.fontSize ?? 9.5,
    fontName: 'f1',
    fontRealName: null,
    column: spec.column ?? 'LEFT',
    lineCount: spec.lineCount ?? 1,
    lines: [],
    order: 0,
    translate,
    skipReason: spec.skipReason ?? (translate ? null : `type:${type}`),
    cell: spec.cell,
  };
}

const cellInfo: TableCellInfo = {
  id: 'p1-t1-r0c0',
  kind: 'table',
  page: 1,
  tableId: 1,
  rowIndex: 0,
  columnIndex: 0,
  colSpan: 1,
  sourceItemIds: [],
  textBox: { x: 0, y: 0, width: 10, height: 10 },
  usable: { x: 0, y: 0, width: 10, height: 10 },
  alignment: 'left',
  fontSize: 8,
  numeric: false,
  header: false,
  trailingMarker: null,
  background: null,
  maskable: true,
  textOnDark: false,
};

describe('orphanSignals', () => {
  // Test 12: a short lower-case fragment reads as a continuation.
  it('flags a short fragment that starts lower case', () => {
    expect(orphanSignals(block({ id: 'b', text: 'caregivers in the community.' }))).toContain('starts-lowercase');
  });

  // Test 11: a sentence end plus a citation is the classic orphan tail.
  it('flags a sentence tail that ends with a citation marker', () => {
    const signals = orphanSignals(block({ id: 'b', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }));
    expect(signals).toContain('starts-lowercase');
    expect(signals).toContain('citation-tail');
    expect(signals).toContain('classified-fragment');
  });

  it('flags a bare citation number', () => {
    expect(orphanSignals(block({ id: 'b', text: '16,27-29', type: 'OTHER', skipReason: 'fragment' }))).toContain('citation-only');
  });

  it('leaves a capitalised short label alone', () => {
    expect(orphanSignals(block({ id: 'b', text: 'Study Design', type: 'OTHER', skipReason: 'fragment' }))).toEqual([]);
  });

  it('leaves a long or multi-line block alone', () => {
    expect(orphanSignals(block({ id: 'b', text: 'caregivers', lineCount: 3 }))).toEqual([]);
    expect(
      orphanSignals(
        block({ id: 'b', text: 'caregivers of people living with dementia reported a substantially higher burden than the comparison group overall' }),
      ),
    ).toEqual([]);
  });

  // Test 13: table cells never take this path.
  it('never touches a table or figure cell', () => {
    expect(orphanSignals(block({ id: 'b', text: 'caregivers.', type: 'TABLE', cell: cellInfo }))).toEqual([]);
  });

  // Test 14: captions and headings are structural, not tails.
  it('never treats a caption or a heading as a tail', () => {
    expect(orphanSignals(block({ id: 'b', text: 'caregivers.62', type: 'CAPTION' }))).toEqual([]);
    expect(orphanSignals(block({ id: 'b', text: 'limitations', type: 'HEADING' }))).toEqual([]);
  });
});

describe('planOrphanMerges', () => {
  // Test 10 + 11: the reported failure case.
  it('gives "among family caregivers.62" back to the paragraph above it', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a substantially higher burden' }),
      block({ id: 'p1-b005', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
    ];
    const plan = planOrphanMerges(blocks);
    expect(plan.merges).toEqual([
      expect.objectContaining({ fragmentId: 'p1-b005', ownerId: 'p1-b004', reason: expect.stringContaining('previous-paragraph-open') }),
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('absorbs a lower-case tail even when the paragraph above ends a sentence', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'The cohort was followed for twelve months.' }),
      block({ id: 'p1-b005', text: 'and beyond.', type: 'OTHER', skipReason: 'fragment' }),
    ];
    expect(planOrphanMerges(blocks).merges[0]).toMatchObject({ ownerId: 'p1-b004', reason: expect.stringContaining('fragment-continues-sentence') });
  });

  it('does not reach across a heading', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a higher burden' }),
      block({ id: 'p1-b005', text: 'Limitations', type: 'HEADING' }),
      block({ id: 'p1-b006', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
    ];
    const plan = planOrphanMerges(blocks);
    expect(plan.merges).toEqual([]);
    expect(plan.unresolved).toEqual(['p1-b006']);
  });

  it('does not reach across a table cell', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a higher burden' }),
      block({ id: 'p1-b005', text: 'Mean (SD)', type: 'TABLE', cell: cellInfo }),
      block({ id: 'p1-b006', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
    ];
    expect(planOrphanMerges(blocks).merges).toEqual([]);
  });

  it('skips running headers and footers on the way back', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a higher burden' }),
      block({ id: 'p1-b005', text: 'JAMA Neurology', type: 'HEADER' }),
      block({ id: 'p2-b001', page: 2, text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
    ];
    expect(planOrphanMerges(blocks).merges[0]).toMatchObject({ fragmentId: 'p2-b001', ownerId: 'p1-b004' });
  });

  it('does not absorb across a font size change', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a higher burden' }),
      block({ id: 'p1-b005', text: 'among family caregivers.62', fontSize: 7, type: 'OTHER', skipReason: 'fragment' }),
    ];
    expect(planOrphanMerges(blocks).merges).toEqual([]);
  });
});

describe('absorbOrphanFragments → buildTranslationBlocks', () => {
  it('turns the paragraph and its tail into ONE translation unit that keeps both boxes', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a substantially higher burden' }),
      block({ id: 'p1-b005', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
      block({ id: 'p1-b006', text: 'A new paragraph starts here and ends properly.' }),
    ];
    const plan = absorbOrphanFragments(blocks);
    expect(plan.merges).toHaveLength(1);
    expect(blocks[1].translate).toBe(true);
    expect(blocks[1].type).toBe('BODY');
    expect(blocks[1].orphanOf).toBe('p1-b004');

    const units = buildTranslationBlocks(blocks);
    expect(units).toHaveLength(2);
    const merged = units[0];
    expect(merged.sourceBlockIds).toEqual(['p1-b004', 'p1-b005']);
    expect(merged.orphanFragmentIds).toEqual(['p1-b005']);
    expect(merged.text).toBe('Dementia caregiving is associated with a substantially higher burden among family caregivers.62');
    expect(merged.wasMerged).toBe(true);
    expect(merged.mergeReason).toContain('orphan-tail');
    // The tail is no longer a unit of its own, so it is never fitted or drawn alone.
    expect(units.map((u) => u.id)).not.toContain('p1-b005');
  });

  it('carries the superscript markers of every source block into the unit', () => {
    const owner = block({ id: 'p1-b004', text: 'Higher burden was reported' });
    const tail = block({ id: 'p1-b005', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' });
    tail.superscripts = [{ text: '62', anchor: '' }];
    const blocks = [owner, tail];
    absorbOrphanFragments(blocks);
    const units = buildTranslationBlocks(blocks);
    expect(units[0].superscripts).toEqual([{ text: '62', anchor: '' }]);
  });

  it('keeps a tail as its own unit when its owner never produces one', () => {
    const owner = block({ id: 'p1-b004', text: 'Higher burden was reported', translate: false, type: 'OTHER' });
    const tail = block({ id: 'p1-b005', text: 'among family caregivers.62' });
    tail.orphanOf = 'p1-b004';
    const units = buildTranslationBlocks([owner, tail]);
    expect(units.map((u) => u.id)).toEqual(['p1-b005']);
  });

  it('leaves table cell blocks out of the unit entirely', () => {
    const blocks = [
      block({ id: 'p1-b004', text: 'Dementia caregiving is associated with a higher burden' }),
      block({ id: 'p1-b005', text: 'among family caregivers.62', type: 'OTHER', skipReason: 'fragment' }),
      block({ id: 'p1-b006', text: 'Mean (SD)', type: 'TABLE', cell: cellInfo }),
    ];
    absorbOrphanFragments(blocks);
    const units = buildTranslationBlocks(blocks);
    const cellUnit = units.find((u) => u.sourceBlockIds.includes('p1-b006'));
    expect(cellUnit?.sourceBlockIds).toEqual(['p1-b006']);
    expect(cellUnit?.wasMerged).toBe(false);
  });
});
