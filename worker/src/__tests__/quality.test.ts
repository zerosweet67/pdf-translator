/**
 * Terminology extraction and second-pass QA routes, prompt builders and
 * validation. The provider is mocked: these tests never call OpenAI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerTranslate = vi.fn(async (blocks: { id: string; text: string }[]) => ({
  blocks: blocks.map((b) => ({ id: b.id, translation: `譯:${b.text}` })),
  model: 'mock-model',
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
}));
const providerTerminology = vi.fn(async (_samples: string[]) => ({
  terms: [
    { source: 'chronic obstructive pulmonary disease', target: '慢性阻塞性肺病', abbreviation: 'COPD' },
    { source: 'inspiratory neural drive', target: '吸氣神經驅動', abbreviation: null },
  ],
  model: 'mock-model',
  usage: { inputTokens: 300, outputTokens: 50, cachedInputTokens: 0 },
}));
let qaVerdicts: Record<string, { ok: boolean; translation: string | null; issues: string[] }> = {};
let qaDropOnce = new Set<string>();
const providerReview = vi.fn(async (blocks: { id: string }[]) => ({
  blocks: blocks
    .filter((b) => !qaDropOnce.delete(b.id))
    .map((b) => ({ id: b.id, ...(qaVerdicts[b.id] ?? { ok: true, translation: null, issues: [] }) })),
  model: 'mock-model',
  usage: { inputTokens: 40, outputTokens: 8, cachedInputTokens: 0 },
}));
vi.mock('../providers', () => ({
  createProvider: () => ({
    name: 'mock',
    model: 'mock-model',
    translate: providerTranslate,
    extractTerminology: providerTerminology,
    reviewTranslations: providerReview,
  }),
}));

import type { Env } from '../env';
import worker from '../index';
import { QA_SCHEMA, TERMINOLOGY_SCHEMA, buildQaMessage, buildQaSystemPrompt, buildSystemPrompt, buildUserMessage, filterTerminology } from '../prompt';
import { resetMemoryRateLimiter } from '../ratelimit';
import { LIMITS, validateQaRequest, validateTerminologyRequest, validateTranslateRequest } from '../validate';
import { mockRateLimiterNamespace } from './helpers';

const INVITE = 'friends-2026-long-random-code';
const SECRET = 'unit-test-auth-secret-0123456789abcdef-0123456789';
const BASE = 'https://worker.example';
let ENV: Env;

beforeEach(() => {
  ENV = {
    OPENAI_API_KEY: 'sk-test-not-used',
    INVITE_CODE: INVITE,
    AUTH_SECRET: SECRET,
    ALLOWED_ORIGINS: 'http://localhost:5173',
    RATE_LIMITER: mockRateLimiterNamespace(),
  };
  qaVerdicts = {};
  qaDropOnce = new Set();
  providerTranslate.mockClear();
  providerTerminology.mockClear();
  providerReview.mockClear();
  resetMemoryRateLimiter();
});

function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', 'CF-Connecting-IP': '203.0.113.10' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body), headers }), ENV);
}

async function login(): Promise<string> {
  const res = await post('/auth/verify', { code: INVITE });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe('POST /terminology', () => {
  it('requires a session and returns the structured glossary', async () => {
    expect((await post('/terminology', { samples: ['x'], targetLanguage: 'zh-TW' })).status).toBe(401);
    expect(providerTerminology).not.toHaveBeenCalled();

    const token = await login();
    const res = await post('/terminology', { samples: ['Chronic obstructive pulmonary disease (COPD) is common.', ' '], targetLanguage: 'zh-TW' }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.terms).toEqual([
      { source: 'chronic obstructive pulmonary disease', target: '慢性阻塞性肺病', abbreviation: 'COPD' },
      { source: 'inspiratory neural drive', target: '吸氣神經驅動', abbreviation: null },
    ]);
    expect(body.usage).toEqual({ inputTokens: 300, outputTokens: 50, cachedInputTokens: 0 });
    expect(body.provider).toBe('mock');
    expect(providerTerminology).toHaveBeenCalledWith(['Chronic obstructive pulmonary disease (COPD) is common.']);
  });

  it('rejects invalid bodies', async () => {
    const token = await login();
    expect((await post('/terminology', { samples: [], targetLanguage: 'zh-TW' }, token)).status).toBe(400);
    expect((await post('/terminology', { samples: ['x'], targetLanguage: 'ja' }, token)).status).toBe(400);
    expect((await post('/terminology', { samples: ['x'.repeat(LIMITS.maxSampleChars + 1)], targetLanguage: 'zh-TW' }, token)).status).toBe(400);
    expect(() => validateTerminologyRequest({ samples: Array.from({ length: LIMITS.maxSamples + 1 }, () => 'x'), targetLanguage: 'zh-TW' })).toThrow(/Too many samples/);
  });
});

describe('POST /qa', () => {
  const blocks = [
    { id: 'a', source: 'No significant difference was found.', translation: '發現顯著差異。', issues: ['NEGATION'] },
    { id: 'b', source: 'Figure 2 shows the result.', translation: 'Figure 2 顯示結果。', type: 'CAPTION' },
  ];

  it('requires a session and returns one verdict per id', async () => {
    expect((await post('/qa', { blocks, targetLanguage: 'zh-TW' })).status).toBe(401);
    const token = await login();
    qaVerdicts = { a: { ok: false, translation: '未發現顯著差異。', issues: ['NEGATION_ERROR'] } };
    const res = await post('/qa', { blocks, targetLanguage: 'zh-TW', terminology: { 'inspiratory neural drive': '吸氣神經驅動' } }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: unknown[]; missing: string[]; usage: unknown; providerCalls: number };
    expect(body.blocks).toEqual([
      { id: 'a', ok: false, translation: '未發現顯著差異。', issues: ['NEGATION_ERROR'] },
      { id: 'b', ok: true, translation: null, issues: [] },
    ]);
    expect(body.missing).toEqual([]);
    expect(body.providerCalls).toBe(1);
    expect(providerReview).toHaveBeenCalledTimes(1);
    const [sent, lang, terminology] = providerReview.mock.calls[0] as unknown as [unknown[], string, Record<string, string>];
    expect(sent).toEqual([
      { id: 'a', source: blocks[0].source, translation: blocks[0].translation, type: undefined, issues: ['NEGATION'] },
      { id: 'b', source: blocks[1].source, translation: blocks[1].translation, type: 'CAPTION', issues: undefined },
    ]);
    expect(lang).toBe('zh-TW');
    expect(terminology['inspiratory neural drive']).toBe('吸氣神經驅動');
  });

  it('retries the ids missing from the first reply once, on their own', async () => {
    const token = await login();
    qaDropOnce = new Set(['b']);
    const res = await post('/qa', { blocks, targetLanguage: 'zh-TW' }, token);
    const body = (await res.json()) as { blocks: { id: string }[]; missing: string[]; providerCalls: number };
    expect(providerReview).toHaveBeenCalledTimes(2);
    expect((providerReview.mock.calls[1][0] as { id: string }[]).map((b) => b.id)).toEqual(['b']);
    expect(body.blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(body.providerCalls).toBe(2);
  });

  it('treats a "not ok" verdict without a correction as missing', async () => {
    const token = await login();
    qaVerdicts = { a: { ok: false, translation: '', issues: ['MEANING_DISTORTION'] } };
    const res = await post('/qa', { blocks: [blocks[0]], targetLanguage: 'zh-TW' }, token);
    const body = (await res.json()) as { blocks: unknown[]; missing: string[] };
    expect(body.blocks).toEqual([]);
    expect(body.missing).toEqual(['a']);
  });

  it('rejects invalid bodies', async () => {
    const token = await login();
    expect((await post('/qa', { blocks: [{ id: 'a', source: 'x' }], targetLanguage: 'zh-TW' }, token)).status).toBe(400);
    expect((await post('/qa', { blocks: [{ ...blocks[0], issues: ['bad code!'] }], targetLanguage: 'zh-TW' }, token)).status).toBe(400);
    expect((await post('/qa', { blocks: [{ ...blocks[0], type: 'weird' }], targetLanguage: 'zh-TW' }, token)).status).toBe(400);
    expect(() => validateQaRequest({ blocks: Array.from({ length: LIMITS.maxQaBlocks + 1 }, (_, i) => ({ ...blocks[0], id: `x${i}` })), targetLanguage: 'zh-TW' })).toThrow(/Too many blocks/);
  });

  it('counts source + translation characters against the session character budget', async () => {
    const token = await login();
    const big = { id: 'big', source: 'x'.repeat(LIMITS.maxBlockChars), translation: 'y'.repeat(LIMITS.maxBlockChars) };
    const res = await post('/qa', { blocks: [big], targetLanguage: 'zh-TW' }, token);
    expect(res.status).toBe(200);
  });
});

describe('prompt builders', () => {
  it('translate units carry the block type and the prompt explains placeholders, hedges and abbreviations', () => {
    const req = validateTranslateRequest({ targetLanguage: 'zh-TW', blocks: [{ id: 'a', text: 'Figure __REF_1__ shows COPD data.', type: 'CAPTION' }, { id: 'b', text: 'Body.' }] });
    expect(req.blocks[0].type).toBe('CAPTION');
    expect(req.blocks[1].type).toBeUndefined();
    expect(buildUserMessage(req.blocks, 'zh-TW')).toContain('"type":"CAPTION"');
    const prompt = buildSystemPrompt({}, req.blocks);
    for (const s of ['__CITE_1__', 'may / might / could', 'no significant difference', 'not inferior', 'bare abbreviation', 'CAPTION: concise']) {
      expect(prompt).toContain(s);
    }
    expect(() => validateTranslateRequest({ targetLanguage: 'zh-TW', blocks: [{ id: 'a', text: 'x', type: 'lower' }] })).toThrow(/block type/);
  });

  it('filterTerminology keeps entries matched by term or by the abbreviation in 中文（ABBR）', () => {
    const glossary = { 'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）', 'inspiratory neural drive': '吸氣神經驅動', 'look-ahead bias': '前瞻偏誤' };
    expect(filterTerminology(glossary, [{ text: 'Patients with COPD were enrolled; look ahead bias is discussed.' }])).toEqual({
      'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）',
      'look-ahead bias': '前瞻偏誤',
    });
    expect(filterTerminology(glossary, [{ source: 'SCOPD is not COPD-like.' }])).toEqual({ 'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）' });
    expect(filterTerminology(glossary, [{ text: 'nothing here' }])).toEqual({});
  });

  it('QA prompt reviews fidelity only and carries the relevant glossary; schemas are strict', () => {
    const blocks = validateQaRequest({ targetLanguage: 'zh-TW', blocks: [{ id: 'a', source: 'COPD improved.', translation: 'COPD 改善。', issues: ['NEGATION'] }] }).blocks;
    const prompt = buildQaSystemPrompt({ 'chronic obstructive pulmonary disease': '慢性阻塞性肺病（COPD）', 'look-ahead bias': '前瞻偏誤' }, blocks);
    expect(prompt).toContain('Do not rewrite for style');
    expect(prompt).toContain('If uncertain, return ok=true');
    expect(prompt.length).toBeLessThan(1500);
    expect(prompt).toContain('慢性阻塞性肺病（COPD）');
    expect(prompt).not.toContain('前瞻偏誤');
    expect(buildQaMessage(blocks, 'zh-TW')).toContain('"issues":["NEGATION"]');
    expect(QA_SCHEMA.properties.blocks.items.required).toEqual(['id', 'ok', 'translation', 'issues']);
    expect(QA_SCHEMA.properties.blocks.items.properties.issues.items.enum).toContain('NUMERIC_MISMATCH');
    expect(TERMINOLOGY_SCHEMA.properties.terms.items.additionalProperties).toBe(false);
  });
});
