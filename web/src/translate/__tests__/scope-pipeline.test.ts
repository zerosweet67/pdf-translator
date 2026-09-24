/**
 * Translation pipeline under a scope: only the selected final logical units
 * reach terminology, translation and QA; the translation cache is reused
 * across scope changes; the terminology cache is keyed by scope.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { isUntranslatableText } from '../../pdf/classify';
import { analyzeLayout } from '../../pdf/layout';
import type { TranslationBlock, TranslationEntry } from '../../pdf/types';
import { detectChapters } from '../../scope/chapters';
import { resolveTranslationScope, terminologyContextUnits, unitsInDocumentOrder, type TranslationScope } from '../../scope/scope';
import { documentAnalysis } from '../../scope/__tests__/fixtures';
import { TranslationCache } from '../cache';
import type { TranslateClient, WorkerBlockInput, WorkerQaItem, WorkerQaResponse, WorkerTranslateResponse } from '../client';
import { clearTerminologyCache, translateDocument } from '../pipeline';
import { documentFingerprint } from '../terminology';

const USAGE = { inputTokens: 100, outputTokens: 80, cachedInputTokens: 0, reasoningTokens: 0 };

/** Fake Worker recording every payload. Translations keep the text; `dropDigitsIn` makes one unit a critical QA case. */
function fakeClient(options: { dropDigitsIn?: string } = {}) {
  const translateCalls: WorkerBlockInput[][] = [];
  const qaCalls: WorkerQaItem[][] = [];
  const terminologyCalls: string[][] = [];
  const client = {
    async translate(blocks: WorkerBlockInput[]): Promise<WorkerTranslateResponse> {
      translateCalls.push(blocks);
      return {
        blocks: blocks.map((b) => ({
          id: b.id,
          translation: options.dropDigitsIn && b.text.includes(options.dropDigitsIn) ? `譯：${b.text.replace(/\d/g, '')}` : `譯：${b.text}`,
        })),
        missing: [],
        usage: { ...USAGE },
      };
    },
    async extractTerminology(samples: string[]) {
      terminologyCalls.push(samples);
      return {
        terms: [{ source: 'bedbound status', target: '臥床狀態', abbreviation: null }],
        usage: { ...USAGE },
      };
    },
    async reviewTranslations(items: WorkerQaItem[]): Promise<WorkerQaResponse> {
      qaCalls.push(items);
      return { blocks: items.map((i) => ({ id: i.id, ok: true, translation: null, issues: [] })), missing: [], usage: { ...USAGE } };
    },
  };
  return { client: client as unknown as TranslateClient, translateCalls, qaCalls, terminologyCalls };
}

const analysis = documentAnalysis(true);
const layout = analyzeLayout(analysis);
const all = layout.translationBlocks;
const chapters = detectChapters(analysis, layout).chapters;
const opts = { pageCount: analysis.pageCount, blocks: layout.blocks, pages: analysis.pages };
const documentKey = documentFingerprint(all);

function select(scope: TranslationScope) {
  const r = resolveTranslationScope(all, chapters, scope, opts);
  if (!r.ok) throw new Error(r.error);
  return r;
}

function chapterId(title: string): string {
  const c = chapters.find((x) => x.title === title);
  if (!c) throw new Error(title);
  return c.id;
}

/** What main.ts does per run: selected units in, terminology from selected + title / abstract, keys from document + scope. */
async function run(
  scope: TranslationScope,
  client: TranslateClient,
  cache: TranslationCache,
  entries = new Map<string, TranslationEntry>(),
  extra: { qa?: boolean } = {},
) {
  const r = select(scope);
  const result = await translateDocument(r.units, entries, {
    client,
    cache,
    targetLanguage: 'zh-TW',
    documentOrder: all,
    documentBlocks: unitsInDocumentOrder(all, r.units, terminologyContextUnits(all)),
    terminologyDocumentKey: documentKey,
    terminologyCacheKey: `${documentKey}|${r.fingerprint}`,
    qa: extra.qa ?? true,
    concurrency: 1,
  });
  return { r, result, entries };
}

const providerBound = (units: readonly TranslationBlock[]) => units.filter((u) => !isUntranslatableText(u.text)).map((u) => u.id).sort();
const sentIds = (calls: WorkerBlockInput[][]) => calls.flat().map((b) => b.id).sort();

beforeEach(() => clearTerminologyCache());

describe('scope → pipeline', () => {
  it('27. whole document: every translatable final unit is sent (table cells and figure elements included)', async () => {
    const f = fakeClient();
    const { r } = await run({ mode: 'all' }, f.client, new TranslationCache());
    expect(r.units).toHaveLength(all.length);
    expect(sentIds(f.translateCalls)).toEqual(providerBound(all));
    const sentTypes = new Set(f.translateCalls.flat().map((b) => b.type));
    expect(sentTypes.has('TABLE_CELL')).toBe(true); // table cells and figure elements go with the cell guidance
    expect(f.translateCalls.flat().some((b) => b.text === 'Never')).toBe(true);
  });

  it('28. chapter mode sends only the final units of the selected chapter', async () => {
    const f = fakeClient();
    const { r } = await run({ mode: 'chapters', chapterIds: [chapterId('2. Methods')] }, f.client, new TranslationCache());
    expect(sentIds(f.translateCalls)).toEqual(providerBound(r.units));
    const selected = new Set(r.units.map((u) => u.id));
    for (const b of f.translateCalls.flat()) expect(selected.has(b.id)).toBe(true);
    // nothing from the results table, the figure or the discussion
    const sentText = f.translateCalls.flat().map((b) => b.text).join('\n');
    expect(sentText).not.toMatch(/Characteristic|go outside|Decedent|Bedbound participants/);
    expect(sentText).toMatch(/Eligible participants/);
    expect(sentText).toMatch(/2\.1 Participants/);
  });

  it('29. page mode sends only the final units of the selected pages, table cells of page 3 included', async () => {
    const f = fakeClient();
    const { r } = await run({ mode: 'pages', startPage: 3, endPage: 3 }, f.client, new TranslationCache());
    expect(sentIds(f.translateCalls)).toEqual(providerBound(r.units));
    const sent = f.translateCalls.flat();
    expect(sent.filter((b) => b.type === 'TABLE_CELL').length).toBe(layout.tables[0].translatedCells);
    expect(sent.some((b) => b.text === 'Time from last interview to death, mean (SD)')).toBe(true);
    expect(sent.some((b) => /^(0|35|<\.001|389 \(63\.0\))$/.test(b.text))).toBe(false); // numeric cells never leave the browser
    expect(sent.some((b) => b.text === 'Never')).toBe(false); // page 4's figure
  });

  it('30. terminology receives only the selected units plus the title and abstract', async () => {
    const f = fakeClient();
    const { r } = await run({ mode: 'pages', startPage: 5, endPage: 5 }, f.client, new TranslationCache());
    expect(f.terminologyCalls).toHaveLength(1);
    const samples = f.terminologyCalls[0];
    const allowed = new Set(unitsInDocumentOrder(all, r.units, terminologyContextUnits(all)).map((u) => u.text));
    for (const s of samples) expect(allowed.has(s)).toBe(true);
    expect(samples.some((s) => s.startsWith('Bedbound Status During'))).toBe(true); // title
    expect(samples.some((s) => s.startsWith('Community-dwelling participants'))).toBe(true); // abstract
    expect(samples.some((s) => s.startsWith('Decedent participants'))).toBe(true); // selected page
    expect(samples.some((s) => /Eligible participants|Characteristic|go outside/.test(s))).toBe(false);
  });

  it('31. QA receives only selected translated units', async () => {
    const f = fakeClient({ dropDigitsIn: 'Decedent' }); // page 5 paragraph loses its numbers → critical QA case
    const { r } = await run({ mode: 'pages', startPage: 5, endPage: 5 }, f.client, new TranslationCache());
    expect(f.qaCalls.length).toBeGreaterThanOrEqual(1);
    const selected = new Set(r.units.map((u) => u.id));
    for (const item of f.qaCalls.flat()) expect(selected.has(item.id)).toBe(true);
    expect(f.qaCalls.flat().some((i) => i.source.startsWith('Decedent'))).toBe(true);
    // the same mismatch outside the scope is never reviewed
    const g = fakeClient({ dropDigitsIn: 'Decedent' });
    await run({ mode: 'pages', startPage: 1, endPage: 2 }, g.client, new TranslationCache());
    expect(g.qaCalls.flat().some((i) => i.source.startsWith('Decedent'))).toBe(false);
  });

  it('32. non-selected units are never sent to any route', async () => {
    const f = fakeClient({ dropDigitsIn: 'Eligible' });
    const { r } = await run({ mode: 'chapters', chapterIds: [chapterId('2. Methods')] }, f.client, new TranslationCache());
    const selected = new Set(r.units.map((u) => u.id));
    const outside = all.filter((u) => !selected.has(u.id));
    expect(outside.length).toBeGreaterThan(10);
    const sentText = [
      ...f.translateCalls.flat().map((b) => b.text),
      ...f.qaCalls.flat().flatMap((i) => [i.source, i.translation]),
      ...f.terminologyCalls.flat(),
    ].join('\n');
    const context = new Set(terminologyContextUnits(all).map((u) => u.id));
    for (const u of outside) {
      expect(sentIds(f.translateCalls)).not.toContain(u.id);
      expect(f.qaCalls.flat().map((i) => i.id)).not.toContain(u.id);
      // short labels ("P value", "Never") are naturally substrings of sentences; check the real texts only
      if (!context.has(u.id) && u.text.length >= 20) expect(sentText.includes(u.text), `leaked: ${u.id} ${JSON.stringify(u.text)}`).toBe(false);
    }
  });

  it('33. the translation cache is reused across scope changes (Introduction first, then the whole paper)', async () => {
    const f = fakeClient();
    const cache = new TranslationCache();
    const intro = await run({ mode: 'chapters', chapterIds: [chapterId('1. Introduction')] }, f.client, cache);
    const introIds = new Set(intro.r.units.map((u) => u.id));
    const introSent = f.translateCalls.length;
    expect(introSent).toBeGreaterThan(0);
    const whole = await run({ mode: 'all' }, f.client, cache, new Map());
    const secondRun = f.translateCalls.slice(introSent).flat().map((b) => b.id);
    for (const id of introIds) expect(secondRun).not.toContain(id);
    expect(whole.result.translation.cachedBlocks).toBe(providerBound(intro.r.units).length);
    expect(whole.result.translation.translatedBlocks + whole.result.translation.cachedBlocks).toBe(providerBound(all).length);
    for (const id of introIds) expect(whole.entries.get(id)?.status).toBe('cached');
  });

  it('34. the terminology cache is keyed by document + scope', async () => {
    const f = fakeClient();
    const cache = new TranslationCache();
    const a = await run({ mode: 'pages', startPage: 1, endPage: 1 }, f.client, cache);
    expect(a.result.terminology.cached).toBe(false);
    expect(f.terminologyCalls).toHaveLength(1);
    const again = await run({ mode: 'pages', startPage: 1, endPage: 1 }, f.client, cache, new Map());
    expect(again.result.terminology.cached).toBe(true);
    expect(f.terminologyCalls).toHaveLength(1); // same scope: no second extraction
    const other = await run({ mode: 'pages', startPage: 2, endPage: 2 }, f.client, cache, new Map());
    expect(other.result.terminology.cached).toBe(false);
    expect(f.terminologyCalls).toHaveLength(2); // another scope of the same document: extracted once more
    expect(f.terminologyCalls[1].some((s) => s.startsWith('Eligible participants'))).toBe(true);
    expect(f.terminologyCalls[1].some((s) => s.startsWith('Older participants'))).toBe(false);
    // the glossary of the earlier scope is kept for consistent renderings
    expect(other.result.terms.map((t) => t.source)).toContain('bedbound status');
  });
});
