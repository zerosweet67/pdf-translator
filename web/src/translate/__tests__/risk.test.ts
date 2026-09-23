import { describe, expect, it } from 'vitest';
import type { QaTrigger, TranslationBlock } from '../../pdf/types';
import { assessTranslation } from '../batch';
import { HIGH_SCORE_THRESHOLD, assessRisk, compareRanked, selectQaCandidates, type RankedBlock, type RiskInput } from '../risk';

function unit(id: string, text: string, extra: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id,
    page: 1,
    pages: [1],
    type: 'BODY',
    sectionType: 'MAIN',
    blockType: 'BODY',
    text,
    sourceBlockIds: [id],
    wasMerged: false,
    mergeReason: null,
    incompleteSource: false,
    previousContext: null,
    nextContext: null,
    contextReason: null,
    ...extra,
  };
}

const PLAIN_SOURCE = 'The intervention improved walking distance in the treatment group compared with usual care.';

const base = (over: Partial<RiskInput> = {}): RiskInput => ({
  source: PLAIN_SOURCE,
  translation: '相較於常規照護，該介入改善了治療組的步行距離。',
  wasMerged: false,
  crossPage: false,
  incompleteSource: false,
  numeric: { ok: true, missing: [], added: [] },
  citation: { ok: true, missing: [], added: [] },
  placeholderMissing: 0,
  ...over,
});

describe('assessRisk — hard risk (QA triggers)', () => {
  it('numeric mismatch → always QA (critical)', () => {
    const r = assessRisk(base({ numeric: { ok: false, missing: ['0.03'], added: ['0.3'] } }));
    expect(r.level).toBe('hard');
    expect(r.high).toBe(true);
    expect(r.triggers).toEqual(['NUMERIC_MISMATCH']);
    expect(r.reasons).toContain('NUMERIC_MISMATCH');
  });

  it('citation mismatch → always QA (critical)', () => {
    const r = assessRisk(base({ citation: { ok: false, missing: ['[12]'], added: [] } }));
    expect(r.level).toBe('hard');
    expect(r.triggers).toEqual(['CITATION_MISMATCH']);
  });

  it('placeholder error → always QA (critical)', () => {
    const r = assessRisk(base({ placeholderMissing: 1 }));
    expect(r.level).toBe('hard');
    expect(r.triggers).toEqual(['PLACEHOLDER_ERROR']);
  });

  it('symbol mismatch → QA', () => {
    const r = assessRisk(base({ source: 'The change in FEV1 was ≥ 5% in the treatment group.', translation: 'FEV1 在治療組的變化為 5%。' }));
    expect(r.level).toBe('hard');
    expect(r.triggers).toEqual(['SYMBOL_MISMATCH']);
    expect(r.reasons).toContain('SYMBOL_MISSING');
  });

  it('strong negation + number / outcome in the same sentence → QA', () => {
    const cases = [
      'There was no significant difference in mortality between the groups (12.4% vs 12.9%).',
      'The device did not improve dyspnoea compared with usual care.',
      'The trial failed to demonstrate non-inferiority, with a margin of 3 points.',
      'Higher doses were not associated with a lower risk of readmission.',
      'Across methods, representations no longer exhibit predictive ability.',
    ];
    for (const source of cases) {
      const r = assessRisk(base({ source }));
      expect(r.triggers, source).toContain('NEGATION_WITH_OUTCOME');
      expect(r.level, source).toBe('hard');
    }
  });

  it('uncertainty + numeric content in the same sentence → QA', () => {
    const cases = [
      'Facial airflow may reduce breathlessness scores by 12% after eight weeks.',
      'These findings suggest a 3.2-point improvement that might be clinically relevant.',
      'It is plausible that the model could identify roughly 40% of announcements.',
    ];
    for (const source of cases) {
      const r = assessRisk(base({ source }));
      expect(r.triggers, source).toContain('UNCERTAINTY_WITH_OUTCOME');
      expect(r.level, source).toBe('hard');
    }
  });

  it('cross-page + incomplete source → QA', () => {
    const r = assessRisk(base({ crossPage: true, incompleteSource: true }));
    expect(r.level).toBe('hard');
    expect(r.triggers).toEqual(['CROSS_PAGE_INCOMPLETE']);
  });

  it('merged + incomplete + negation (or hedge) → QA', () => {
    const negation = assessRisk(base({ wasMerged: true, incompleteSource: true, source: 'This was not the case for the' }));
    expect(negation.level).toBe('hard');
    expect(negation.triggers).toEqual(['MERGED_INCOMPLETE_SEMANTIC']);
    const hedge = assessRisk(base({ wasMerged: true, incompleteSource: true, source: 'This may reflect a tendency of the' }));
    expect(hedge.triggers).toEqual(['MERGED_INCOMPLETE_SEMANTIC']);
    // merged + incomplete without a semantic signal stays soft
    expect(assessRisk(base({ wasMerged: true, incompleteSource: true, source: 'The sample consisted of the' })).level).toBe('soft');
  });

  it('weighted score ≥ 8 without a specific trigger → QA', () => {
    // strong negation (3) + six hedges (3) + dense statistics (3); the negation sentence has no number / outcome word and the numbers sit in a sentence without a hedge
    const source =
      'The committee could not reach the participants. It seems likely that adherence was possibly adequate, which may explain the pattern, and it appears the estimates probably hold. Scores were 5.2 (n = 42) and 4.8 (n = 40) with p = 0.03.';
    const r = assessRisk(base({ source }));
    expect(r.score).toBeGreaterThanOrEqual(HIGH_SCORE_THRESHOLD);
    expect(r.level).toBe('hard');
    expect(r.triggers).toContain('HIGH_RISK_SCORE');
  });

  it('triggers come back in priority order', () => {
    const r = assessRisk(
      base({
        source: 'There was no significant difference in mortality (12% vs 14%) and the model may explain 30% of the variance.',
        numeric: { ok: false, missing: ['12%'], added: [] },
        placeholderMissing: 1,
      }),
    );
    expect(r.triggers).toEqual(['PLACEHOLDER_ERROR', 'NUMERIC_MISMATCH', 'NEGATION_WITH_OUTCOME', 'UNCERTAINTY_WITH_OUTCOME']);
  });
});

describe('assessRisk — soft risk (never QA on its own)', () => {
  const soft = (input: RiskInput, reason: string) => {
    const r = assessRisk(input);
    expect(r.level, reason).toBe('soft');
    expect(r.high, reason).toBe(false);
    expect(r.triggers, reason).toEqual([]);
    return r;
  };

  it('merged only → no QA', () => {
    expect(soft(base({ wasMerged: true }), 'merged').reasons).toEqual(['MERGED_BLOCK']);
  });

  it('cross-page only → no QA', () => {
    expect(soft(base({ crossPage: true }), 'cross-page').reasons).toEqual(['CROSS_PAGE_BLOCK']);
  });

  it('incomplete source only → no QA', () => {
    expect(soft(base({ incompleteSource: true }), 'incomplete').reasons).toEqual(['INCOMPLETE_SOURCE']);
  });

  it('hedge only → no QA', () => {
    const r = soft(base({ source: 'This may reflect sensory feedback, which suggests a possible role of the trigeminal nerve.' }), 'hedge');
    expect(r.reasons).toEqual(['UNCERTAINTY']);
  });

  it('weak or grammatical negation only → no QA', () => {
    const weak = soft(base({ source: 'Participants without a smartphone were enrolled; no device was provided.' }), 'weak negation');
    expect(weak.reasons).toEqual(['NEGATION']);
    expect(weak.score).toBe(1);
    const grammatical = assessRisk(base({ source: 'The method is not only faster but also cheaper, and not necessarily less accurate.' }));
    expect(grammatical.triggers).toEqual([]);
    expect(grammatical.score).toBeLessThanOrEqual(1);
  });

  it('length anomaly only → no QA (warning)', () => {
    const r = soft(base({ translation: '好。' }), 'length');
    expect(r.reasons).toEqual(['LENGTH_ANOMALY']);
  });

  it('number density or parentheses only → no QA', () => {
    const r = soft(
      base({
        source: 'Mean 5.2 ± 1.1 vs 4.8 ± 1.3 (p = 0.03; 95% CI 0.1 to 0.7; n = 42 and n = 40).',
        translation: '平均 5.2 ± 1.1 vs 4.8 ± 1.3（p = 0.03；95% CI 0.1 至 0.7；n = 42 與 n = 40）。',
      }),
      'dense',
    );
    expect(r.reasons).toEqual(['DENSE_NOTATION']);
  });

  it('citation years are not statistics', () => {
    const r = assessRisk(base({ source: 'Prior work (Smith et al., 2019; Lee and Wu, 2021) suggests that memorization may matter [3, 4].' }));
    expect(r.triggers).toEqual([]);
    expect(r.reasons).not.toContain('DENSE_NOTATION');
  });

  it('a plain paragraph has no risk at all', () => {
    const r = assessRisk(base());
    expect(r.level).toBe('none');
    expect(r.reasons).toEqual([]);
    expect(r.score).toBe(0);
  });
});

describe('assessTranslation', () => {
  it('combines the checks for one block', () => {
    const block = unit('m', 'Merged sentence across the page [3].', { wasMerged: true, pages: [1, 2] });
    const q = assessTranslation(block, '跨頁合併的句子 [3]。', { terminologyHash: 'abc', protectedEntities: 1, placeholderMissing: [] });
    expect(q).toMatchObject({ terminologyHash: 'abc', riskLevel: 'soft', highRisk: false, qaTriggers: [], riskReasons: ['MERGED_BLOCK', 'CROSS_PAGE_BLOCK'], qa: 'none' });
    const cut = assessTranslation(unit('c', 'Merged sentence across the page [3].', { wasMerged: true, pages: [1, 2], incompleteSource: true }), '跨頁 [3]', { terminologyHash: '', protectedEntities: 0, placeholderMissing: [] });
    expect(cut).toMatchObject({ riskLevel: 'hard', highRisk: true, qaTriggers: ['CROSS_PAGE_INCOMPLETE'] });
  });
});

describe('selectQaCandidates', () => {
  const ranked = (id: string, order: number, triggers: QaTrigger[], score = 5): RankedBlock => ({ id, order, triggers, score });

  it('critical mismatches are not limited by the 5 % cap', () => {
    const list = [
      ranked('n1', 0, ['NUMERIC_MISMATCH']),
      ranked('c1', 1, ['CITATION_MISMATCH']),
      ranked('p1', 2, ['PLACEHOLDER_ERROR']),
      ranked('s1', 3, ['SYMBOL_MISMATCH']),
    ];
    const sel = selectQaCandidates(list, 20, 0.05); // budget 1
    expect([...sel.selected]).toEqual(['p1', 'n1', 'c1']);
    expect(sel).toMatchObject({ critical: 3, budget: 1, budgetSkipped: 1 });
  });

  it('non-critical hard-risk blocks share the cap', () => {
    const list = Array.from({ length: 6 }, (_, i) => ranked(`s${i}`, i, ['SYMBOL_MISMATCH']));
    const sel = selectQaCandidates(list, 40, 0.05); // budget 2
    expect([...sel.selected]).toEqual(['s0', 's1']);
    expect(sel.budgetSkipped).toBe(4);
    // a critical block uses a slot first; the rest of the budget goes to the others in priority order
    const withCritical = selectQaCandidates([ranked('n', 5, ['NUMERIC_MISMATCH']), ...list], 40, 0.05);
    expect([...withCritical.selected]).toEqual(['n', 's0']);
  });

  it('orders by trigger priority, then score, then reading order', () => {
    const list = [
      ranked('score', 0, ['HIGH_RISK_SCORE'], 12),
      ranked('merged', 1, ['MERGED_INCOMPLETE_SEMANTIC'], 9),
      ranked('cross', 2, ['CROSS_PAGE_INCOMPLETE'], 9),
      ranked('hedge', 3, ['UNCERTAINTY_WITH_OUTCOME'], 4),
      ranked('neg-late', 4, ['NEGATION_WITH_OUTCOME'], 4),
      ranked('neg-high', 5, ['NEGATION_WITH_OUTCOME'], 7),
      ranked('neg-early', 6, ['NEGATION_WITH_OUTCOME'], 4),
      ranked('symbol', 7, ['SYMBOL_MISMATCH'], 4),
      ranked('cite', 8, ['CITATION_MISMATCH'], 8),
      ranked('num', 9, ['NUMERIC_MISMATCH'], 8),
      ranked('ph', 10, ['PLACEHOLDER_ERROR'], 8),
    ];
    const order = [...list].sort(compareRanked).map((r) => r.id);
    expect(order).toEqual(['ph', 'num', 'cite', 'symbol', 'neg-high', 'neg-late', 'neg-early', 'hedge', 'cross', 'merged', 'score']);
    expect([...selectQaCandidates(list, 100, 0.05).selected]).toEqual(['ph', 'num', 'cite', 'symbol', 'neg-high']);
  });

  it('keeps everything when the budget allows and at least one block for tiny documents', () => {
    const list = [ranked('a', 0, ['SYMBOL_MISMATCH']), ranked('b', 1, ['HIGH_RISK_SCORE'])];
    expect(selectQaCandidates(list, 100, 0.05).selected.size).toBe(2);
    expect(selectQaCandidates(list, 3, 0.05).selected.size).toBe(1);
  });
});
