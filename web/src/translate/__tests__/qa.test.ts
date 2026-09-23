import { beforeEach, describe, expect, it } from 'vitest';
import type { TranslationBlock, TranslationEntry } from '../../pdf/types';
import { TranslationCache } from '../cache';
import { TranslateClientError, type TranslateClient, type WorkerBlockInput, type WorkerQaItem, type WorkerQaResponse, type WorkerTranslateResponse } from '../client';
import { clearTerminologyCache, translateDocument } from '../pipeline';
import { acceptableCorrection, makeQaBatches, runQualityAssurance, type QaCandidate } from '../qa';

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

function entryFor(block: TranslationBlock, translation: string, highRisk = true): TranslationEntry {
  return {
    id: block.id,
    status: 'done',
    translation,
    error: null,
    quality: {
      terminologyHash: '',
      protectedEntities: 0,
      placeholderMissing: [],
      numericMissing: [],
      numericAdded: [],
      citationMissing: [],
      citationAdded: [],
      riskScore: highRisk ? 8 : 0,
      riskReasons: highRisk ? ['NEGATION', 'DENSE_NOTATION'] : [],
      riskLevel: highRisk ? 'hard' : 'none',
      qaTriggers: highRisk ? ['NEGATION_WITH_OUTCOME'] : [],
      highRisk,
      qa: 'none',
      qaIssues: [],
      originalTranslation: null,
    },
  };
}

type Verdict = { ok: boolean; translation: string | null; issues?: string[] };

/** Fake Worker for both routes. `verdicts` decides QA answers; ids not listed are answered ok. */
function fakeClient(options: {
  verdicts?: Record<string, Verdict>;
  qaDropOnce?: string[];
  qaFail?: 'always' | 'once' | 'retryable-once';
  terminology?: { terms: { source: string; target: string; abbreviation: string | null }[] } | 'fail';
} = {}) {
  const translateCalls: WorkerBlockInput[][] = [];
  const qaCalls: WorkerQaItem[][] = [];
  let terminologyCalls = 0;
  const dropped = new Set(options.qaDropOnce ?? []);
  let failures = 0;
  const client = {
    async translate(blocks: WorkerBlockInput[]): Promise<WorkerTranslateResponse> {
      translateCalls.push(blocks);
      return { blocks: blocks.map((b) => ({ id: b.id, translation: `譯：${b.text}` })), missing: [], usage: { inputTokens: 100, outputTokens: 80, cachedInputTokens: 0 } };
    },
    async extractTerminology() {
      terminologyCalls++;
      if (options.terminology === 'fail') throw new TranslateClientError('http', 'boom', { status: 502 });
      return { terms: options.terminology?.terms ?? [], usage: { inputTokens: 300, outputTokens: 60, cachedInputTokens: 0 } };
    },
    async reviewTranslations(items: WorkerQaItem[]): Promise<WorkerQaResponse> {
      qaCalls.push(items);
      if (options.qaFail === 'always' || (options.qaFail === 'once' && failures++ === 0)) {
        throw new TranslateClientError('http', 'QA down', { status: 502, retryable: false });
      }
      if (options.qaFail === 'retryable-once' && failures++ === 0) {
        throw new TranslateClientError('http', 'QA hiccup', { status: 503, retryable: true, retryAfterMs: 1 });
      }
      const blocks = items
        .filter((i) => !dropped.delete(i.id))
        .map((i) => {
          const v = options.verdicts?.[i.id] ?? { ok: true, translation: null, issues: [] };
          return { id: i.id, ok: v.ok, translation: v.translation, issues: v.issues ?? [] };
        });
      return { blocks, missing: [], usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 0 }, providerCalls: 1 };
    },
  } as unknown as TranslateClient;
  return { client, translateCalls, qaCalls, terminologyCalls: () => terminologyCalls };
}

const candidates = (list: [TranslationBlock, string][]): QaCandidate[] => list.map(([block, t]) => ({ block, entry: entryFor(block, t) }));

describe('runQualityAssurance', () => {
  it('QA ok=true keeps the original translation', async () => {
    const { client, qaCalls } = fakeClient();
    const c = candidates([[unit('a', 'No significant difference was found.'), '未發現顯著差異。']]);
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(c[0].entry.translation).toBe('未發現顯著差異。');
    expect(c[0].entry.quality?.qa).toBe('ok');
    expect(stats).toMatchObject({ requests: 1, blocksSent: 1, blocksChecked: 1, correctedBlocks: 0, failedBlocks: 0 });
    // payload: id, source, translation and the QA triggers only (no soft signals, no context, no entity details)
    expect(qaCalls[0][0]).toEqual({ id: 'a', source: 'No significant difference was found.', translation: '未發現顯著差異。', issues: ['NEGATION_WITH_OUTCOME'] });
  });

  it('a translation is replaced only for ok=false; an ok=true verdict with a rewrite keeps the first round', async () => {
    const { client } = fakeClient({ verdicts: { a: { ok: true, translation: '本研究並未發現任何顯著之差異。', issues: [] } } });
    const c = candidates([[unit('a', 'No significant difference was found.'), '未發現顯著差異。']]);
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(c[0].entry.translation).toBe('未發現顯著差異。');
    expect(c[0].entry.quality?.qa).toBe('ok');
    expect(stats.correctedBlocks).toBe(0);
  });

  it('QA correction replaces the translation and keeps the original for reference', async () => {
    const { client } = fakeClient({ verdicts: { a: { ok: false, translation: '未發現顯著差異。', issues: ['NEGATION_ERROR'] } } });
    const c = candidates([[unit('a', 'No significant difference was found.'), '發現顯著差異。']]);
    const corrected: string[] = [];
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW', onCorrected: (_b, t) => corrected.push(t) });
    expect(c[0].entry.translation).toBe('未發現顯著差異。');
    expect(c[0].entry.quality).toMatchObject({ qa: 'corrected', qaIssues: ['NEGATION_ERROR'], originalTranslation: '發現顯著差異。' });
    expect(corrected).toEqual(['未發現顯著差異。']);
    expect(stats.correctedBlocks).toBe(1);
  });

  it('QA failure keeps the first-round translation and reports a warning', async () => {
    const { client } = fakeClient({ qaFail: 'always' });
    const c = candidates([[unit('a', 'No significant difference was found.'), '發現顯著差異。']]);
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(c[0].entry.translation).toBe('發現顯著差異。');
    expect(c[0].entry.quality?.qa).toBe('failed');
    expect(stats.failedBlocks).toBe(1);
    expect(stats.correctedBlocks).toBe(0);
    expect(stats.warnings.length).toBeGreaterThan(0);
  });

  it('never reviews or corrects a block more than once', async () => {
    const { client, qaCalls } = fakeClient({ verdicts: { a: { ok: false, translation: '修正版。', issues: ['MEANING_DISTORTION'] } } });
    const c = candidates([
      [unit('a', 'Sentence a.'), '句子甲。'],
      [unit('b', 'Sentence b.'), '句子乙。'],
    ]);
    await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(qaCalls).toHaveLength(1);
    expect(qaCalls.flat().filter((i) => i.id === 'a')).toHaveLength(1);
    expect(c[0].entry.translation).toBe('修正版。');
    expect(c[0].entry.quality?.qa).toBe('corrected');
  });

  it('retries only the ids missing from a QA reply', async () => {
    const { client, qaCalls } = fakeClient({ qaDropOnce: ['b'], verdicts: { b: { ok: false, translation: '乙修正。' } } });
    const c = candidates([
      [unit('a', 'Sentence a.'), '句子甲。'],
      [unit('b', 'Sentence b.'), '句子乙。'],
      [unit('c', 'Sentence c.'), '句子丙。'],
    ]);
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(qaCalls).toHaveLength(2);
    expect(qaCalls[1].map((i) => i.id)).toEqual(['b']);
    expect(c[1].entry.translation).toBe('乙修正。');
    expect(stats).toMatchObject({ requests: 2, retryRequests: 1, blocksChecked: 3, correctedBlocks: 1, failedBlocks: 0 });
  });

  it('retries a retryable transport error once, then keeps going', async () => {
    const { client, qaCalls } = fakeClient({ qaFail: 'retryable-once' });
    const c = candidates([[unit('a', 'Sentence a.'), '句子甲。']]);
    const stats = await runQualityAssurance(c, { client, targetLanguage: 'zh-TW' });
    expect(qaCalls).toHaveLength(2);
    expect(stats.blocksChecked).toBe(1);
  });

  it('batches at most 20 blocks per request', () => {
    const c = candidates(Array.from({ length: 45 }, (_, i) => [unit(`b${i}`, 'x'), 'y']));
    expect(makeQaBatches(c, 20, 16_000).map((b) => b.length)).toEqual([20, 20, 5]);
  });

  it('rejects corrections that are empty, not Chinese or numerically broken', () => {
    const block = unit('a', 'n = 42 improved.');
    expect(acceptableCorrection(block, 'n = 42 改善。', '')).toBe(false);
    expect(acceptableCorrection(block, 'n = 42 改善。', 'n = 42 improved.')).toBe(false);
    expect(acceptableCorrection(block, 'n = 42 改善。', 'n = 24 改善。')).toBe(false);
    expect(acceptableCorrection(block, 'n = 42 改善。', 'n = 42 有所改善。')).toBe(true);
  });
});

describe('translateDocument', () => {
  beforeEach(() => clearTerminologyCache());

  const run = (client: TranslateClient, blocks: TranslationBlock[], extra = {}) => {
    const entries = new Map<string, TranslationEntry>();
    return translateDocument(blocks, entries, { client, cache: new TranslationCache(), targetLanguage: 'zh-TW', documentOrder: blocks, ...extra }).then((r) => ({ r, entries }));
  };

  it('sends only hard-risk blocks to QA; soft-risk blocks (merged only) stay first-round', async () => {
    const { client, qaCalls } = fakeClient();
    const blocks = [
      unit('plain', 'The study enrolled participants from two centres.'),
      unit('risky', 'There was no significant difference in FEV1.'),
      unit('merged', 'A merged sentence.', { wasMerged: true }),
    ];
    const { r, entries } = await run(client, blocks, { maxQaShare: 1 });
    expect(qaCalls.flat().map((i) => i.id)).toEqual(['risky']);
    expect(entries.get('plain')?.quality?.qa).toBe('none');
    expect(entries.get('risky')?.quality?.qa).toBe('ok');
    expect(entries.get('merged')?.quality).toMatchObject({ riskLevel: 'soft', qa: 'none' });
    expect(r.highRiskBlocks).toBe(1);
    expect(r.softRiskBlocks).toBe(1);
    expect(r.qa.blocksSent).toBe(1);
    expect(r.qaPolicy).toMatchObject({ softRiskSkipped: 1, hardRiskChecked: 1, criticalForced: 0, budgetSkippedHardRisk: 0 });
  });

  it('caps the QA share for non-critical hard-risk blocks and marks the rest skipped', async () => {
    const { client, qaCalls } = fakeClient();
    const blocks = Array.from({ length: 10 }, (_, i) => unit(`n${i}`, `No significant difference was found in outcome ${i}.`));
    const { r, entries } = await run(client, blocks, { maxQaShare: 0.3 });
    expect(qaCalls.flat()).toHaveLength(3);
    expect(r.qaSkippedBlocks).toBe(7);
    expect(r.qaPolicy).toMatchObject({ hardRiskChecked: 3, budgetSkippedHardRisk: 7, budget: 3 });
    expect(entries.get('n9')?.quality?.qa).toBe('skipped');
    expect(entries.get('n9')?.translation).toBe('譯：No significant difference was found in outcome 9.');
  });

  it('critical mismatches are reviewed even beyond the QA budget', async () => {
    const { client, qaCalls } = fakeClient();
    // the fake translator drops the number of every "num" block → numeric mismatch (critical)
    const original = client.translate.bind(client);
    client.translate = async (blocks: WorkerBlockInput[]) => {
      const res = await original(blocks, 'zh-TW');
      return { ...res, blocks: res.blocks.map((b) => (b.id.startsWith('num') ? { ...b, translation: '譯：無數字' } : b)) };
    };
    const blocks = [
      ...Array.from({ length: 3 }, (_, i) => unit(`num${i}`, `The score was ${i + 10} points.`)),
      ...Array.from({ length: 7 }, (_, i) => unit(`neg${i}`, `No significant difference was found in outcome ${i}.`)),
    ];
    const { r, entries } = await run(client, blocks, { maxQaShare: 0.1 }); // budget 1
    expect(qaCalls.flat().map((i) => i.id)).toEqual(['num0', 'num1', 'num2']);
    expect(r.qaPolicy).toMatchObject({ criticalForced: 3, hardRiskChecked: 3, budgetSkippedHardRisk: 7, budget: 1 });
    expect(entries.get('num0')?.quality?.qaTriggers).toEqual(['NUMERIC_MISMATCH']);
    expect(entries.get('neg0')?.quality?.qa).toBe('skipped');
  });

  it('terminology extraction failure does not stop the translation', async () => {
    const { client } = fakeClient({ terminology: 'fail' });
    const { r, entries } = await run(client, [unit('a', 'Sentence a.')]);
    expect(entries.get('a')?.status).toBe('done');
    expect(r.terms).toEqual([]);
    expect(r.warnings[0]).toMatch(/Terminology extraction failed/);
  });

  it('extracts terminology once per document per session, user terms first', async () => {
    const { client, terminologyCalls, translateCalls } = fakeClient({
      terminology: { terms: [{ source: 'chronic obstructive pulmonary disease', target: '慢性阻塞性肺病', abbreviation: 'COPD' }] },
    });
    const blocks = [unit('a', 'COPD is common.')];
    const first = await run(client, blocks, { userTerminology: { 'inspiratory neural drive': '吸氣神經驅動' } });
    expect(first.r.terms.map((t) => [t.source, t.origin])).toEqual([
      ['inspiratory neural drive', 'user'],
      ['chronic obstructive pulmonary disease', 'auto'],
    ]);
    expect(first.r.terminology).toMatchObject({ requests: 1, autoTerms: 1, userTerms: 1, cached: false });
    expect(translateCalls).toHaveLength(1);
    const second = await run(client, blocks);
    expect(terminologyCalls()).toBe(1);
    expect(second.r.terminology).toMatchObject({ requests: 0, cached: true, autoTerms: 1 });
  });

  it('QA failure keeps every first-round translation', async () => {
    const { client } = fakeClient({ qaFail: 'always' });
    const { r, entries } = await run(client, [unit('m', 'No significant difference was found in the outcome.')]);
    expect(entries.get('m')?.translation).toBe('譯：No significant difference was found in the outcome.');
    expect(entries.get('m')?.quality?.qa).toBe('failed');
    expect(r.qa.failedBlocks).toBe(1);
  });
});
