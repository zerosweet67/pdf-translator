import { describe, expect, it } from 'vitest';
import type { TranslationBlock } from '../../pdf/types';
import { buildPayload, translateBlocks } from '../batch';
import { TranslationCache } from '../cache';
import type { TranslateClient, WorkerBlockInput, WorkerTranslateResponse } from '../client';
import {
  MAX_AUTO_TERMS,
  mergeTerminology,
  parseTerminologyResponse,
  relevantTerms,
  selectTerminologySamples,
  terminologyHash,
  toWorkerTerminology,
  userTermsFromMap,
  type TermEntry,
} from '../terminology';

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

const COPD: TermEntry = { source: 'chronic obstructive pulmonary disease', target: '慢性阻塞性肺病', abbreviation: 'COPD', origin: 'auto' };
const IND: TermEntry = { source: 'inspiratory neural drive', target: '吸氣神經驅動', abbreviation: null, origin: 'auto' };
const FAN: TermEntry = { source: 'fan-to-face', target: '臉部送風', abbreviation: null, origin: 'auto' };

describe('parseTerminologyResponse', () => {
  it('parses the structured reply, drops generic words and malformed entries, caps at 50', () => {
    const terms = parseTerminologyResponse({
      terms: [
        { source: 'chronic obstructive pulmonary disease', target: '慢性阻塞性肺病', abbreviation: 'COPD' },
        { source: 'inspiratory neural drive', target: '吸氣神經驅動', abbreviation: null },
        { source: 'patients', target: '病人', abbreviation: null }, // generic
        { source: 'exercise', target: '運動', abbreviation: null }, // generic
        { source: 'bad', target: 'no chinese', abbreviation: null }, // target not Chinese
        { source: 42, target: '數字', abbreviation: null }, // wrong type
        { source: 'Inspiratory Neural Drive', target: '重複', abbreviation: null }, // duplicate (case-insensitive)
        { source: 'modified Medical Research Council dyspnea scale', target: '改良版 Medical Research Council 呼吸困難量表', abbreviation: 'mMRC' },
        ...Array.from({ length: 60 }, (_, i) => ({ source: `term number ${i}`, target: `術語${i}`, abbreviation: null })),
      ],
    });
    expect(terms.slice(0, 3)).toEqual([
      { ...COPD },
      { ...IND },
      { source: 'modified Medical Research Council dyspnea scale', target: '改良版 Medical Research Council 呼吸困難量表', abbreviation: 'mMRC', origin: 'auto' },
    ]);
    expect(terms).toHaveLength(MAX_AUTO_TERMS);
    expect(parseTerminologyResponse(null)).toEqual([]);
    expect(parseTerminologyResponse({ terms: 'nope' })).toEqual([]);
  });
});

describe('mergeTerminology', () => {
  it('user terminology overrides auto terminology with the same source or abbreviation', () => {
    const user = userTermsFromMap({ 'chronic obstructive pulmonary disease': '慢性阻塞性肺疾病', 'fan-to-face (F2F)': '風扇對臉' });
    const merged = mergeTerminology(user, [COPD, IND, FAN, { ...IND, source: 'Dyspnoea', abbreviation: 'F2F' }]);
    expect(merged.map((t) => [t.source, t.target, t.abbreviation, t.origin])).toEqual([
      ['chronic obstructive pulmonary disease', '慢性阻塞性肺疾病', null, 'user'],
      ['fan-to-face', '風扇對臉', 'F2F', 'user'],
      ['inspiratory neural drive', '吸氣神經驅動', null, 'auto'],
    ]);
  });
});

describe('relevantTerms', () => {
  it('keeps only the entries that occur in the text (term, plural, hyphen/space, or bare abbreviation)', () => {
    const terms = [COPD, IND, FAN];
    expect(relevantTerms(terms, 'Patients with COPD reported lower inspiratory neural drives.').map((t) => t.source)).toEqual([
      'chronic obstructive pulmonary disease',
      'inspiratory neural drive',
    ]);
    expect(relevantTerms(terms, 'The fan to face group improved.').map((t) => t.source)).toEqual(['fan-to-face']);
    expect(relevantTerms(terms, 'Nothing relevant here; SCOPED and COPDX are other words.')).toEqual([]);
    expect(relevantTerms(terms, 'Baseline characteristics were similar.')).toEqual([]);
  });

  it('a batch only carries the terms of its own blocks', async () => {
    const calls: { blocks: WorkerBlockInput[]; terminology: Record<string, string> }[] = [];
    const client = {
      async translate(blocks: WorkerBlockInput[], _lang: string, terminology: Record<string, string>): Promise<WorkerTranslateResponse> {
        calls.push({ blocks, terminology });
        return { blocks: blocks.map((b) => ({ id: b.id, translation: `譯：${b.text}` })), missing: [] };
      },
    } as unknown as TranslateClient;
    const blocks = [unit('a', 'Patients with COPD were enrolled.'), unit('b', 'The fan-to-face intervention was applied.')];
    await translateBlocks(blocks, new Map(), {
      client,
      cache: new TranslationCache(),
      targetLanguage: 'zh-TW',
      terms: [COPD, IND, FAN],
      maxBlocksPerBatch: 1,
      concurrency: 1,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].terminology).toEqual({ 'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）' });
    expect(calls[1].terminology).toEqual({ 'fan-to-face': '臉部送風' });
  });
});

describe('abbreviations', () => {
  it('are carried in the Worker map as 中文（ABBR） and bare abbreviations in the source stay untouched by protection', () => {
    expect(toWorkerTerminology([COPD, IND])).toEqual({
      'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）',
      'inspiratory neural drive': '吸氣神經驅動',
    });
    const [p] = buildPayload([unit('a', 'FEV1 and SpO2 in COPD (n = 12).')]);
    expect(p.text).toBe('FEV1 and SpO2 in COPD (n = 12).');
  });
});

describe('terminologyHash / cache key', () => {
  it('changes when the relevant terminology changes, not with entry order', () => {
    const h1 = terminologyHash([COPD, IND]);
    expect(terminologyHash([IND, COPD])).toBe(h1);
    expect(terminologyHash([COPD])).not.toBe(h1);
    expect(terminologyHash([{ ...COPD, target: '慢性阻塞性肺疾病' }])).not.toBe(terminologyHash([COPD]));
    expect(terminologyHash([])).toBe('');

    const cache = new TranslationCache();
    cache.set('COPD is common.', 'zh-TW', '舊譯', terminologyHash([COPD]));
    expect(cache.get('COPD is common.', 'zh-TW', terminologyHash([COPD]))).toBe('舊譯');
    expect(cache.get('COPD is common.', 'zh-TW', terminologyHash([{ ...COPD, target: '慢性阻塞性肺疾病' }]))).toBeUndefined();
    expect(cache.get('COPD is common.', 'zh-TW')).toBeUndefined();
  });

  it('a block is not served from the cache when its relevant terms differ', async () => {
    const calls: WorkerBlockInput[][] = [];
    const client = {
      async translate(blocks: WorkerBlockInput[]): Promise<WorkerTranslateResponse> {
        calls.push(blocks);
        return { blocks: blocks.map((b) => ({ id: b.id, translation: `譯：${b.text}` })), missing: [] };
      },
    } as unknown as TranslateClient;
    const cache = new TranslationCache();
    const blocks = [unit('a', 'COPD is common.')];
    await translateBlocks(blocks, new Map(), { client, cache, targetLanguage: 'zh-TW', terms: [COPD] });
    await translateBlocks(blocks, new Map(), { client, cache, targetLanguage: 'zh-TW', terms: [COPD] });
    expect(calls).toHaveLength(1); // second run: cache hit
    await translateBlocks(blocks, new Map(), { client, cache, targetLanguage: 'zh-TW', terms: [{ ...COPD, target: '慢性阻塞性肺疾病' }] });
    expect(calls).toHaveLength(2); // different glossary: translated again
  });
});

describe('selectTerminologySamples', () => {
  it('sends the whole text of a small document and a budgeted selection of a large one', () => {
    const small = [unit('t', 'Title', { type: 'TITLE' }), unit('b', 'Body text.')];
    expect(selectTerminologySamples(small)).toEqual(['Title', 'Body text.']);

    const big: TranslationBlock[] = [unit('t', 'Facial airflow enhances exercise training', { type: 'TITLE' })];
    for (let p = 1; p <= 30; p++) {
      big.push(unit(`h${p}`, `Section ${p} heading`, { type: 'HEADING', page: p }));
      for (let i = 0; i < 4; i++) {
        big.push(unit(`b${p}-${i}`, `${'Long paragraph about chronic obstructive pulmonary disease (COPD) and inspiratory neural drive. '.repeat(6)}`, { page: p }));
      }
      big.push(unit(`c${p}`, `Figure ${p}. Caption about the fan-to-face (F2F) group.`, { type: 'CAPTION', page: p }));
    }
    const samples = selectTerminologySamples(big, 7000);
    const chars = samples.reduce((n, s) => n + s.length, 0);
    expect(chars).toBeLessThanOrEqual(7000);
    expect(samples[0]).toBe('Facial airflow enhances exercise training');
    expect(samples.some((s) => s.includes('Section 1 heading | Section 2 heading'))).toBe(true);
    expect(samples.some((s) => s.startsWith('Figure 1.'))).toBe(true);
  });
});
