import { describe, expect, it } from 'vitest';
import type { TranslationBlock, TranslationEntry } from '../../pdf/types';
import { DEFAULT_MAX_BLOCKS, buildPayload, makeBatches, translateBlocks } from '../batch';
import { TranslationCache, normalizeCacheText } from '../cache';
import type { TranslateClient, WorkerBlockInput, WorkerTranslateResponse } from '../client';

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

/** Fake Worker: records every payload, translates by prefixing, optionally drops ids once. */
function fakeClient(options: { dropOnce?: string[]; usage?: boolean } = {}) {
  const calls: WorkerBlockInput[][] = [];
  const dropped = new Set(options.dropOnce ?? []);
  const client = {
    endpoint: 'fake',
    async translate(blocks: WorkerBlockInput[]): Promise<WorkerTranslateResponse> {
      calls.push(blocks);
      const out = blocks.filter((b) => !dropped.delete(b.id)).map((b) => ({ id: b.id, translation: `譯：${b.text}` }));
      return {
        blocks: out,
        missing: [],
        providerCalls: 1,
        usage: options.usage ? { inputTokens: 100 + blocks.length, outputTokens: 50, cachedInputTokens: 0 } : undefined,
      };
    },
  } as unknown as TranslateClient;
  return { client, calls };
}

describe('makeBatches', () => {
  it('closes a batch at the block limit or the character limit, whichever comes first', () => {
    const small = Array.from({ length: 60 }, (_, i) => unit(`b${i}`, 'x'.repeat(100)));
    expect(makeBatches(small, DEFAULT_MAX_BLOCKS, 10_000).map((b) => b.length)).toEqual([25, 25, 10]);
    const big = Array.from({ length: 6 }, (_, i) => unit(`b${i}`, 'x'.repeat(3000)));
    expect(makeBatches(big, 25, 10_000).map((b) => b.length)).toEqual([3, 3]);
  });

  it('counts attached context towards the character limit', () => {
    const blocks = [unit('a', 'x'.repeat(4000)), unit('b', 'x'.repeat(4000), { previousContext: 'y'.repeat(120), nextContext: 'y'.repeat(120) }), unit('c', 'x'.repeat(1000))];
    expect(makeBatches(blocks, 25, 9000).map((b) => b.map((u) => u.id))).toEqual([['a', 'b'], ['c']]);
    expect(makeBatches(blocks, 25, 8100).map((b) => b.map((u) => u.id))).toEqual([['a'], ['b', 'c']]);
  });
});

describe('buildPayload', () => {
  const doc = [
    unit('u1', 'First sentence.'),
    unit('u2', 'Second sentence cut', { incompleteSource: true, previousContext: 'First sentence.', nextContext: 'off here.', contextReason: 'incomplete' }),
    unit('u3', 'off here.', { previousContext: 'Second sentence cut', contextReason: 'continuation' }),
    unit('u4', 'Fourth.'),
  ];

  it('sends only id and text for ordinary blocks and no layout metadata', () => {
    const [p] = buildPayload([doc[0]], doc);
    expect(p).toEqual({ id: 'u1', text: 'First sentence.' });
  });

  it('drops context whose neighbour is in the same request', () => {
    const payload = buildPayload(doc, doc);
    expect(payload[1]).toEqual({ id: 'u2', text: 'Second sentence cut', incompleteSource: true });
    expect(payload[2]).toEqual({ id: 'u3', text: 'off here.' });
  });

  it('keeps context at a batch boundary and next to blocks that were not sent', () => {
    const [p2] = buildPayload([doc[1]], doc); // u1 and u3 are elsewhere (other batch or cache)
    expect(p2.contextBefore).toBe('First sentence.');
    expect(p2.contextAfter).toBe('off here.');
    const [p3] = buildPayload([doc[2], doc[3]], doc);
    expect(p3.contextBefore).toBe('Second sentence cut');
  });

  it('sends every assigned context when the document order is unknown', () => {
    const payload = buildPayload(doc);
    expect(payload[1].contextBefore).toBe('First sentence.');
    expect(payload[2].contextBefore).toBe('Second sentence cut');
  });
});

describe('TranslationCache', () => {
  it('normalizes whitespace only', () => {
    expect(normalizeCacheText('  Age, years 　 (n=12)\n')).toBe('Age, years (n=12)');
    const cache = new TranslationCache();
    cache.set('Smoking history', 'zh-TW', '吸菸史');
    expect(cache.get('Smoking  history ', 'zh-TW')).toBe('吸菸史');
    expect(cache.get('smoking history', 'zh-TW')).toBeUndefined();
    expect(cache.get('Smoking history.', 'zh-TW')).toBeUndefined();
    expect(cache.hits).toBe(1);
  });
});

describe('translateBlocks', () => {
  const run = async (blocks: TranslationBlock[], client: TranslateClient, cache = new TranslationCache(), extra = {}) => {
    const entries = new Map<string, TranslationEntry>();
    const stats = await translateBlocks(blocks, entries, { client, cache, targetLanguage: 'zh-TW', documentOrder: blocks, ...extra });
    return { entries, stats };
  };

  it('skips untranslatable blocks and cache hits without an API call', async () => {
    const { client, calls } = fakeClient();
    const cache = new TranslationCache();
    cache.set('Results', 'zh-TW', '結果');
    const blocks = [unit('a', 'Results'), unit('b', '67.6 ± 5.2'), unit('c', 'https://doi.org/10.1/x'), unit('d', 'p<0.001'), unit('e', 'A real sentence.')];
    const { entries, stats } = await run(blocks, client, cache);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((b) => b.id)).toEqual(['e']);
    expect(entries.get('a')?.status).toBe('cached');
    expect(entries.get('b')?.status).toBe('skipped');
    expect(entries.get('c')?.status).toBe('skipped');
    expect(entries.get('d')?.status).toBe('skipped');
    expect(entries.get('e')?.translation).toBe('譯：A real sentence.');
    expect(stats).toMatchObject({ requests: 1, translatedBlocks: 1, cachedBlocks: 1, skippedBlocks: 3, failedBlocks: 0 });
  });

  it('re-sends only the ids missing from a response', async () => {
    const { client, calls } = fakeClient({ dropOnce: ['b'] });
    const blocks = ['a', 'b', 'c'].map((id) => unit(id, `Sentence ${id}.`));
    const { entries, stats } = await run(blocks, client);
    expect(calls).toHaveLength(2);
    expect(calls[1].map((b) => b.id)).toEqual(['b']);
    expect(entries.get('b')?.status).toBe('done');
    expect(stats.retryRequests).toBe(1);
    expect(stats.requests).toBe(2);
  });

  it('serves repeated text from the cache within one run', async () => {
    const { client, calls } = fakeClient();
    const blocks = [unit('a', 'Figure'), unit('b', 'Body text.'), unit('c', 'Figure')];
    const { entries, stats } = await run(blocks, client);
    // both "Figure" units are in the same batch: sent once, second one filled by the first response
    expect(calls[0].filter((b) => b.text === 'Figure')).toHaveLength(2);
    expect(entries.get('c')?.translation).toBe('譯：Figure');
    const again = await run(blocks, client, new TranslationCache());
    expect(again.stats.requests).toBe(1);
    expect(stats.cachedBlocks).toBe(0);
  });

  it('sums the provider usage and estimates a baseline', async () => {
    const { client } = fakeClient({ usage: true });
    const blocks = Array.from({ length: 30 }, (_, i) => unit(`b${i}`, `Sentence number ${i} about numerical reasoning.`));
    const { stats } = await run(blocks, client);
    expect(stats.requests).toBe(2);
    expect(stats.usage).toEqual({ inputTokens: 200 + 30, outputTokens: 100, cachedInputTokens: 0 });
    expect(stats.baselineRequests).toBe(2);
    expect(stats.baselineEstimatedInputTokens).toBeGreaterThan(stats.estimatedInputTokens);
    expect(stats.estimatedOutputTokens).toBeGreaterThan(0);
  });
});
