/**
 * Translation prompt, terminology preferences and structured-output schema.
 * Shared by every provider so switching providers never changes the brief.
 *
 * Token economy: the system prompt states every rule once (~1 700 chars
 * instead of ~4 200), the glossary is filtered to the terms that actually
 * occur in the batch, and each unit is sent as {id, text} plus, only when
 * needed, contextBefore / contextAfter / incompleteSource.
 */

import type { RequestBlock } from './validate';

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-TW': 'Traditional Chinese as used in Taiwan (繁體中文，台灣用語)',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * Preferred renderings for terms that appear in accounting, finance, economics,
 * computer science and AI papers. These are preferences, not blind replacements:
 * the model applies them when the term is used in its usual technical sense.
 * The frontend may send more entries per request; request entries override these.
 * Only the entries whose term occurs in the batch are put into the prompt.
 */
export const DEFAULT_TERMINOLOGY: Record<string, string> = {
  'large language model': '大型語言模型',
  'numerical reasoning': '數值推理',
  'look-ahead bias': '前瞻偏誤',
  'return on equity': '股東權益報酬率',
  'profit margin': '利潤率',
  'financial statements': '財務報表',
  inference: '推論',
  'earnings': '盈餘',
  'cash flow': '現金流量',
  'balance sheet': '資產負債表',
  'income statement': '損益表',
  'analyst': '分析師',
  'forecast': '預測',
  'benchmark': '基準',
  'prompt': '提示',
  'chain-of-thought': '思維鏈',
  'fine-tuning': '微調',
  'out-of-sample': '樣本外',
  'in-sample': '樣本內',
  'robustness': '穩健性',
  'regression': '迴歸',
  'variable': '變數',
  'significance': '顯著性',
  'literature': '文獻',
};

export function mergeTerminology(extra: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_TERMINOLOGY };
  for (const [k, v] of Object.entries(extra ?? {})) {
    const key = k.trim();
    const value = v.trim();
    if (key && value) merged[key] = value;
  }
  return merged;
}

/**
 * Keep only the glossary entries whose term (or its singular / plural form,
 * with hyphens or spaces) occurs in the batch text, case-insensitively.
 */
export function filterTerminology(terminology: Record<string, string>, blocks: readonly RequestBlock[]): Record<string, string> {
  const haystack = blocks
    .map((b) => `${b.text} ${b.contextBefore ?? ''} ${b.contextAfter ?? ''}`)
    .join('\n')
    .toLowerCase()
    .replace(/[-\s]+/g, ' ');
  const out: Record<string, string> = {};
  for (const [term, zh] of Object.entries(terminology)) {
    const t = term.toLowerCase().replace(/[-\s]+/g, ' ');
    const stem = t.endsWith('s') ? t.slice(0, -1) : t;
    if (haystack.includes(stem)) out[term] = zh;
  }
  return out;
}

const BASE_PROMPT = `Translate academic English into fluent, precise Traditional Chinese as used in Taiwan academia (繁體中文，台灣用語), at the quality of a published journal article.

Requirements:
- Preserve the author's exact meaning, academic tone and every detail. Do not summarize, omit, add, explain, or invent missing content.
- Prefer natural Taiwan academic Chinese syntax over English word order; avoid Mainland Chinese terminology when a Taiwan equivalent exists. Do not make the prose dramatic or casual.
- Preserve exactly: numbers, percentages, equations, citation markers ([12], (Smith et al., 2020), superscript numbers), DOIs, URLs, model names, abbreviations (o1-preview, GPT-4, ROE, LLM) and proper nouns.
- Keep terminology consistent across the batch. On a term's first mention you may add the English term or abbreviation in parentheses, e.g. 大型語言模型（Large Language Models, LLMs）、股東權益報酬率（ROE）; afterwards use only the Chinese term or the abbreviation.
- Render first-person research statements idiomatically: "I show that…" → 研究結果顯示……／本文指出……; "I find that…", "We find that…" → 研究發現……／本文發現……; "I set out to examine…" → 本文旨在探討……; "the literature does not provide…" → 現有文獻往往缺乏……. Never 我顯示／我發現／我著手.
- Use full-width Chinese punctuation (，。、；：「」) in Chinese sentences.

Input: a JSON array of units in document reading order, each {"id","text"}. Neighbouring units are context only, for meaning and terminology. A unit may also carry "contextBefore" / "contextAfter" (surrounding text from outside this batch; context only, never translate or include it) or "incompleteSource": true (the text is cut off by a page or column break: translate only the available text, do not complete the sentence).

Output: {"blocks":[{"id","translation"}]} with exactly one translation per input id, the same ids, no merged, split, skipped or invented ids, each translation on a single line. If a text is only a DOI, URL, number or code, return it unchanged.`;

/** System prompt for one batch: base rules plus the glossary entries that occur in `blocks`. */
export function buildSystemPrompt(terminology: Record<string, string>, blocks: readonly RequestBlock[] = []): string {
  const entries = Object.entries(blocks.length > 0 ? filterTerminology(terminology, blocks) : terminology);
  if (entries.length === 0) return BASE_PROMPT;
  const lines = entries.map(([en, zh]) => `- ${en} → ${zh}`).join('\n');
  return `${BASE_PROMPT}\n\nTerminology (preferred renderings in the usual technical sense, matched case-insensitively):\n${lines}`;
}

interface PromptUnit {
  id: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  incompleteSource?: boolean;
}

export function buildUserMessage(blocks: RequestBlock[], targetLanguage: string): string {
  const units: PromptUnit[] = blocks.map((b) => {
    const unit: PromptUnit = { id: b.id, text: b.text };
    if (b.contextBefore) unit.contextBefore = b.contextBefore;
    if (b.contextAfter) unit.contextAfter = b.contextAfter;
    if (b.incompleteSource) unit.incompleteSource = true;
    return unit;
  });
  return `Translate the "text" of these ${units.length} units into ${languageName(targetLanguage)}.\n${JSON.stringify(units)}`;
}

/** JSON schema for structured outputs. additionalProperties:false is required on every object. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          translation: { type: 'string' },
        },
        required: ['id', 'translation'],
        additionalProperties: false,
      },
    },
  },
  required: ['blocks'],
  additionalProperties: false,
} as const;
