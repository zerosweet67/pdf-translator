/**
 * Prompts, terminology preferences and structured-output schemas for the three
 * provider tasks: translation, document terminology extraction and second-pass QA.
 * Shared by every provider so switching providers never changes the brief.
 *
 * Token economy: the system prompt states every rule once, the glossary is
 * filtered to the terms that actually occur in the batch, and each unit is
 * sent as {id, text} plus, only when needed, contextBefore / contextAfter /
 * incompleteSource / type.
 */

import type { QaRequestBlock, RequestBlock } from './validate';

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

interface TextCarrier {
  text?: string;
  source?: string;
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * Keep only the glossary entries whose term (or its singular / plural form,
 * with hyphens or spaces) occurs in the batch text, case-insensitively. An
 * abbreviation given in the rendering as 中文（ABBR） also matches on its own.
 */
export function filterTerminology(terminology: Record<string, string>, blocks: readonly TextCarrier[]): Record<string, string> {
  const raw = blocks.map((b) => `${b.text ?? b.source ?? ''} ${b.contextBefore ?? ''} ${b.contextAfter ?? ''}`).join('\n');
  const haystack = raw.toLowerCase().replace(/[-\s]+/g, ' ');
  const out: Record<string, string> = {};
  for (const [term, zh] of Object.entries(terminology)) {
    const t = term.toLowerCase().replace(/[-\s]+/g, ' ');
    const stem = t.endsWith('s') ? t.slice(0, -1) : t;
    if (haystack.includes(stem)) {
      out[term] = zh;
      continue;
    }
    const abbr = /（([A-Za-z0-9][A-Za-z0-9\-/+.]{0,14})）\s*$/.exec(zh)?.[1];
    if (abbr && new RegExp(`(?<![A-Za-z0-9])${abbr.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9])`).test(raw)) out[term] = zh;
  }
  return out;
}

const BASE_PROMPT = `Translate academic English into precise Traditional Chinese as used in Taiwan academia (繁體中文，台灣用語), at the quality of a published journal article. Fidelity comes before fluency.

Requirements:
- Preserve the author's exact meaning, tone and every detail. Never summarize, omit, expand, explain, invent content or add causal links.
- Keep every qualifier, negation, comparison and degree of certainty: "may / might / could" → 可能 (never 會); "suggest / indicate" → 顯示／指出 (never 證明); "associated with" → 與……相關 (never 導致); "no significant difference" → 無顯著差異; "failed to demonstrate" → 未能證實; "not inferior" → 不劣於; "approximately" → 約. Never strengthen or weaken a finding.
- Copy every number, %, range, ±, p-value, n =, CI, unit and symbol (± ≤ ≥ < > = % ° μ Greek letters) exactly; never round, reorder, convert or drop them.
- Tokens like __CITE_1__, __REF_2__, __DOI_1__, __URL_1__, __EMAIL_1__ are placeholders for citations, figure/table references, DOIs, URLs and e-mails: copy each one unchanged, exactly once, where it belongs.
- Preserve exactly: remaining citation markers, DOIs, URLs, model names, symbols such as SpO2, PaCO2, FEV1, TRPM8, and proper nouns.
- Abbreviations: first mention of the full term → 中文全名（ABBR）; afterwards, and whenever the source has only the abbreviation (COPD, FEV1, RCT, LLM …), keep the bare abbreviation, never expand it. A glossary rendering 中文（ABBR） follows the same rule.
- Keep terminology consistent and follow the glossary below when the term is used in its technical sense.
- Taiwan academic usage: statistical "significant" → 顯著 (not 明顯), "data" → 資料, "participants / subjects" → 參與者／受試者 by context, "intervention" → 介入; avoid Mainland Chinese terminology when a Taiwan equivalent exists. Not dramatic or casual.
- Render first-person research statements idiomatically: "I show that…" → 研究結果顯示……／本文指出……; "I find that…", "We find that…" → 研究發現……／本文發現……; "I set out to examine…" → 本文旨在探討……; "the literature does not provide…" → 現有文獻往往缺乏……. Never 我顯示／我發現／我著手.
- Use full-width Chinese punctuation (，。、；：「」) in Chinese sentences.

Input: a JSON array of units in document reading order, each {"id","text"}. Neighbouring units are context only, for meaning and terminology. A unit may also carry "contextBefore" / "contextAfter" (surrounding text from outside this batch; context only, never translate or include it), "incompleteSource": true (the text is cut off by a page or column break: translate only the available text, do not complete the sentence) or "type" (TITLE: formal and concise, no expansion. HEADING: keep the section tone and level. CAPTION: concise, keep figure/table numbers. FOOTNOTE: brief and faithful. TABLE: terse labels. TABLE_CELL: one table cell or one figure label (flowchart box, axis title, forest-plot row); translate faithfully and concisely, preserve every number, unit, abbreviation (SD, CI, OR, HR, n, p …), statistical notation and footnote marker, prefer compact academic wording that fits a small box, omit nothing. STRUCTURED_LABEL: a section label of a structured abstract; use concise academic heading wording. SIDEBAR_HEADING: translate as a concise heading. SIDEBAR_LABEL: translate faithfully and compactly. SIDEBAR_BODY: translate faithfully using concise prose. No type = body text: complete and faithful).

Output: {"blocks":[{"id","translation"}]} with exactly one translation per input id, the same ids, no merged, split, skipped or invented ids, each translation on a single line. If a text is only a DOI, URL, number or code, return it unchanged.`;

/** System prompt for one batch: base rules plus the glossary entries that occur in `blocks`. */
export function buildSystemPrompt(terminology: Record<string, string>, blocks: readonly RequestBlock[] = []): string {
  const entries = Object.entries(blocks.length > 0 ? filterTerminology(terminology, blocks) : terminology);
  if (entries.length === 0) return BASE_PROMPT;
  return `${BASE_PROMPT}\n\nTerminology (preferred renderings in the usual technical sense, matched case-insensitively):\n${glossaryLines(entries)}`;
}

function glossaryLines(entries: [string, string][]): string {
  return entries.map(([en, zh]) => `- ${en} → ${zh}`).join('\n');
}

interface PromptUnit {
  id: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  incompleteSource?: boolean;
  type?: string;
}

export function buildUserMessage(blocks: RequestBlock[], targetLanguage: string): string {
  const units: PromptUnit[] = blocks.map((b) => {
    const unit: PromptUnit = { id: b.id, text: b.text };
    if (b.contextBefore) unit.contextBefore = b.contextBefore;
    if (b.contextAfter) unit.contextAfter = b.contextAfter;
    if (b.incompleteSource) unit.incompleteSource = true;
    if (b.type) unit.type = b.type;
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

// ---------------------------------------------------------------------------
// Document terminology extraction (one call per document)
// ---------------------------------------------------------------------------

export const MAX_TERMINOLOGY_TERMS = 50;

export const TERMINOLOGY_PROMPT = `You build the glossary for translating ONE English academic paper into Traditional Chinese as used in Taiwan academia. You receive excerpts of the paper (title, abstract, headings, captions, definitions, representative paragraphs).

List the terms whose rendering must stay consistent through the whole paper: disease names, anatomical and physiological terms, drugs, interventions, devices, scales and questionnaires, measurement names, technical terms, study-specific terminology and repeated noun phrases, together with the abbreviation the paper uses for each (if any).

Rules:
- At most ${MAX_TERMINOLOGY_TERMS} entries. Only terms that are important, repeated, or easy to translate inconsistently.
- No ordinary words (patient, result, study, exercise, method, data, group).
- "source": the English term as written in the paper (singular; lowercase unless a proper noun). "target": the standard Taiwan academic rendering in Traditional Chinese. "abbreviation": the paper's abbreviation for exactly this term, otherwise null. Never invent an abbreviation; well-known abbreviations (COPD, FEV1, RCT, mMRC) stay abbreviations.
- Examples: chronic obstructive pulmonary disease → 慢性阻塞性肺病 (COPD); interstitial lung disease → 間質性肺病 (ILD); inspiratory neural drive → 吸氣神經驅動; modified Medical Research Council dyspnea scale → 改良版 Medical Research Council 呼吸困難量表 (mMRC); fan-to-face → 臉部送風.

Output: {"terms":[{"source","target","abbreviation"}]}.`;

export function buildTerminologyMessage(samples: readonly string[]): string {
  return `Excerpts of the paper (${samples.length}):\n${samples.map((s, i) => `[${i + 1}] ${s}`).join('\n')}`;
}

export const TERMINOLOGY_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          abbreviation: { type: ['string', 'null'] },
        },
        required: ['source', 'target', 'abbreviation'],
        additionalProperties: false,
      },
    },
  },
  required: ['terms'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Second-pass QA of high-risk blocks
// ---------------------------------------------------------------------------

export const QA_ISSUE_CODES = [
  'NUMERIC_MISMATCH',
  'CITATION_MISMATCH',
  'NEGATION_ERROR',
  'UNCERTAINTY_ERROR',
  'TERMINOLOGY_INCONSISTENCY',
  'MISSING_CONTENT',
  'ADDED_CONTENT',
  'MEANING_DISTORTION',
  'PLACEHOLDER_ERROR',
] as const;

const QA_BASE_PROMPT = `Review English → Traditional Chinese (Taiwan) academic translations for fidelity only.

Check only:
- meaning distortion
- missing or added negation
- altered uncertainty (may / might / could, suggest / indicate, likely, approximately)
- numeric / statistical changes (numbers, %, ranges, ±, p-values, n =, CI, units, symbols)
- citation changes (reference numbers, authors, years, figure / table numbers)
- terminology inconsistency with the glossary
- missing content
- added content

Do not rewrite for style: fluency, word order, punctuation, synonyms of equal strength, a bare abbreviation for its full name (or the reverse) and a citation kept in English are not errors. If uncertain, return ok=true.

Input: JSON array of {"id","source","translation"}, optionally "type" (block type) and "issues" (automatic triggers; may be false alarms).
Output: {"blocks":[{"id","ok","translation","issues"}]}, exactly one entry per input id. ok=true → translation null, issues []. ok=false → the minimally corrected translation (change only the wrong words; keep every number, symbol and citation as in the source) and issue codes from: ${QA_ISSUE_CODES.join(', ')}.`;

export function buildQaSystemPrompt(terminology: Record<string, string>, blocks: readonly QaRequestBlock[] = []): string {
  const entries = Object.entries(blocks.length > 0 ? filterTerminology(terminology, blocks) : terminology);
  if (entries.length === 0) return QA_BASE_PROMPT;
  return `${QA_BASE_PROMPT}\n\nTerminology (the paper's glossary; the translation must use these renderings):\n${glossaryLines(entries)}`;
}

interface QaUnit {
  id: string;
  source: string;
  translation: string;
  type?: string;
  issues?: string[];
}

export function buildQaMessage(blocks: readonly QaRequestBlock[], targetLanguage: string): string {
  const units: QaUnit[] = blocks.map((b) => {
    const unit: QaUnit = { id: b.id, source: b.source, translation: b.translation };
    if (b.type) unit.type = b.type;
    if (b.issues && b.issues.length) unit.issues = b.issues;
    return unit;
  });
  return `Review these ${units.length} translations into ${languageName(targetLanguage)}.\n${JSON.stringify(units)}`;
}

export const QA_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ok: { type: 'boolean' },
          translation: { type: ['string', 'null'] },
          issues: { type: 'array', items: { type: 'string', enum: [...QA_ISSUE_CODES] } },
        },
        required: ['id', 'ok', 'translation', 'issues'],
        additionalProperties: false,
      },
    },
  },
  required: ['blocks'],
  additionalProperties: false,
} as const;
