import { describe, expect, it } from 'vitest';
import type { TranslationBlock } from '../../pdf/types';
import { translateBlocks } from '../batch';
import { TranslationCache } from '../cache';
import type { TranslateClient, WorkerBlockInput, WorkerTranslateResponse } from '../client';
import { compareCitations, extractCitations, protectText, restoreText } from '../protect';

function unit(id: string, text: string): TranslationBlock {
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
  };
}

describe('protectText / restoreText', () => {
  it('protects [12] and restores it', () => {
    const p = protectText('Prior work [12] found this.');
    expect(p.text).toBe('Prior work __CITE_1__ found this.');
    expect(p.placeholders).toEqual([{ token: '__CITE_1__', kind: 'CITE', value: '[12]' }]);
    const r = restoreText('先前研究 __CITE_1__ 發現此點。', p.placeholders);
    expect(r).toEqual({ text: '先前研究 [12] 發現此點。', missing: [], leftover: [] });
  });

  it('protects [12–15] and [3,5,8] and restores them even when the model mangles the token slightly', () => {
    const p = protectText('See [12–15] and [3,5,8].');
    expect(p.text).toBe('See __CITE_1__ and __CITE_2__.');
    const r = restoreText('見 _CITE_1_ 與 __CITE_02 __。', p.placeholders);
    expect(r.text).toBe('見 [12–15] 與 [3,5,8]。');
    expect(r.missing).toEqual([]);
  });

  it('protects author-year citations, narrative and parenthetical', () => {
    const p = protectText('As shown by Smith et al. (2024) and others (Smith & Lee, 2023; Wu, 2020, p. 12), see also (e.g., Sarkar and Vafa, 2024).');
    // parenthetical citations are matched before narrative ones, so their placeholders come first
    expect(p.placeholders.map((x) => x.value)).toEqual(['(Smith & Lee, 2023; Wu, 2020, p. 12)', '(e.g., Sarkar and Vafa, 2024)', 'Smith et al. (2024)']);
    expect(p.text).toBe('As shown by __CITE_3__ and others __CITE_1__, see also __CITE_2__.');
    expect(restoreText('如 __CITE_3__ 與其他研究 __CITE_1__ 所示，另見 __CITE_2__。', p.placeholders).text).toBe(
      '如 Smith et al. (2024) 與其他研究 (Smith & Lee, 2023; Wu, 2020, p. 12) 所示，另見 (e.g., Sarkar and Vafa, 2024)。',
    );
  });

  it('protects Figure 2, Fig. 2A, Table S1, Fig. B1, Supplementary Figure 3 and Appendix A', () => {
    const p = protectText('Figure 2 and Fig. 2A show it; Table S1, Fig. B1, Supplementary Figure 3 and Appendix A too. Figures 2 and 3 agree.');
    expect(p.placeholders.map((x) => x.value)).toEqual(['Figure 2', 'Fig. 2A', 'Table S1', 'Fig. B1', 'Supplementary Figure 3', 'Appendix A', 'Figures 2 and 3']);
    expect(p.placeholders.every((x) => x.kind === 'REF')).toBe(true);
    expect(restoreText('__REF_1__ 與 __REF_2__ 顯示。', p.placeholders).text).toBe('Figure 2 與 Fig. 2A 顯示。');
  });

  it('protects DOI, URL and e-mail', () => {
    const p = protectText('See https://doi.org/10.1000/xyz123, doi:10.1234/abc.5 and mail me@example.org.');
    expect(p.placeholders.map((x) => [x.kind, x.value])).toEqual([
      ['EMAIL', 'me@example.org'],
      ['URL', 'https://doi.org/10.1000/xyz123'],
      ['DOI', 'doi:10.1234/abc.5'],
    ]);
  });

  it('reports missing placeholders and leftovers', () => {
    const p = protectText('See [1] and [2].');
    const r = restoreText('見 [1]。__CITE_9__', p.placeholders);
    expect(r.missing.map((m) => m.token)).toEqual(['__CITE_1__', '__CITE_2__']);
    expect(r.leftover).toEqual(['__CITE_9__']);
  });

  it('leaves text alone when it already contains placeholder-like tokens', () => {
    expect(protectText('Literal __CITE_1__ in the source [3].').placeholders).toEqual([]);
  });
});

describe('compareCitations', () => {
  it('compares the citation multiset semantically', () => {
    expect(compareCitations('See [12] and Figure 2 (Smith et al., 2024).', '見 [12] 與 Figure 2 (Smith et al., 2024)。').ok).toBe(true);
    expect(compareCitations('See [12-15].', '見 [12–15]。').ok).toBe(true);
    const r = compareCitations('See [12] and Figure 2.', '見 [13] 與 Figure 2。');
    expect(r).toEqual({ ok: false, missing: ['[12]'], added: ['[13]'] });
    expect(compareCitations('See Table 1.', '見表 1。').missing).toEqual(['Table 1']);
    expect(extractCitations('Fig. 3 [4]')).toEqual(['Fig. 3', '[4]']);
  });
});

describe('translateBlocks with protection', () => {
  const fake = (reply: (b: WorkerBlockInput) => string) => {
    const calls: WorkerBlockInput[][] = [];
    const client = {
      async translate(blocks: WorkerBlockInput[]): Promise<WorkerTranslateResponse> {
        calls.push(blocks);
        return { blocks: blocks.map((b) => ({ id: b.id, translation: reply(b) })), missing: [] };
      },
    } as unknown as TranslateClient;
    return { client, calls };
  };

  it('sends placeholders, restores them and stores the restored text in the cache', async () => {
    const { client, calls } = fake((b) => `譯：${b.text}`);
    const entries = new Map();
    const cache = new TranslationCache();
    const block = unit('a', 'Prior work [12] and Figure 2 (Smith et al., 2024) agree.');
    const stats = await translateBlocks([block], entries, { client, cache, targetLanguage: 'zh-TW' });
    expect(calls[0][0].text).toBe('Prior work __CITE_1__ and __REF_1__ __CITE_2__ agree.');
    expect(entries.get('a').translation).toBe('譯：Prior work [12] and Figure 2 (Smith et al., 2024) agree.');
    expect(entries.get('a').quality).toMatchObject({ placeholderMissing: [], citationMissing: [], highRisk: false, protectedEntities: 3 });
    expect(cache.get(block.text, 'zh-TW')).toBe(entries.get('a').translation);
    expect(stats.protectedEntities).toBe(3);
    expect(stats.placeholderWarnings).toBe(0);
  });

  it('a lost placeholder creates a warning and marks the block high-risk', async () => {
    const { client } = fake(() => '譯文遺失了引用。');
    const entries = new Map();
    const stats = await translateBlocks([unit('a', 'Prior work [12] agrees.')], entries, { client, cache: new TranslationCache(), targetLanguage: 'zh-TW' });
    const q = entries.get('a').quality;
    expect(q.placeholderMissing).toEqual(['__CITE_1__']);
    expect(q.riskReasons).toEqual(expect.arrayContaining(['PLACEHOLDER_ERROR', 'CITATION_MISMATCH']));
    expect(q.highRisk).toBe(true);
    expect(stats.placeholderWarnings).toBe(1);
    expect(stats.citationWarnings).toBe(1);
    expect(stats.highRiskBlocks).toBe(1);
  });
});
