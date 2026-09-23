/**
 * Document terminology.
 *
 *  - selectTerminologySamples(): the excerpts (title, abstract, headings,
 *    captions, abbreviation definitions, term-dense paragraphs) sent ONCE to
 *    the Worker's /terminology route; never the whole paper.
 *  - parseTerminologyResponse(): validates the structured reply, drops
 *    ordinary words, caps the list at MAX_AUTO_TERMS.
 *  - mergeTerminology(): user entries always win over automatic ones.
 *  - relevantTerms(): the entries that actually occur in a text, so a batch
 *    (and the cache key of a block) only carries what it needs.
 *  - terminologyHash(): stable hash of a term list for cache keys.
 *  - toWorkerTerminology(): the { "english term": "中文（ABBR）" } map the
 *    Worker already accepts; the abbreviation rides along in the value and the
 *    Worker prompt explains the first-mention / bare-abbreviation rule.
 */

import type { TranslationBlock } from '../pdf/types';

export const MAX_AUTO_TERMS = 50;
/** Characters of excerpts sent for extraction. */
export const SAMPLE_BUDGET_CHARS = 7000;

export interface TermEntry {
  source: string;
  target: string;
  abbreviation: string | null;
  origin: 'user' | 'auto';
}

/** Ordinary words that never belong in a glossary, even when the model lists them. */
const GENERIC_TERMS = new Set([
  'patient', 'patients', 'participant', 'participants', 'subject', 'subjects', 'result', 'results', 'study', 'studies',
  'exercise', 'research', 'data', 'method', 'methods', 'analysis', 'analyses', 'table', 'figure', 'group', 'groups',
  'paper', 'article', 'author', 'authors', 'section', 'approach', 'conclusion', 'conclusions', 'introduction',
  'discussion', 'background', 'objective', 'objectives', 'aim', 'aims', 'effect', 'effects', 'model', 'models',
  'sample', 'samples', 'test', 'tests', 'value', 'values', 'measure', 'measures', 'time', 'week', 'weeks', 'month',
  'months', 'year', 'years', 'number', 'level', 'levels', 'change', 'changes', 'difference', 'differences',
]);

const CJK_RE = /[㐀-鿿豈-﫿]/;
const ABBREV_DEF_RE = /\b[A-Za-z][a-z]+(?:[ -][a-z]+){0,6}\s*\(\s*[A-Z][A-Za-z0-9]{1,9}\s*\)/;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Sentence(s) around the first abbreviation definition of a block, ±window chars. */
function definitionExcerpt(text: string, window = 160): string | null {
  const m = ABBREV_DEF_RE.exec(text);
  if (!m || m.index === undefined) return null;
  const start = Math.max(0, m.index - window);
  const end = Math.min(text.length, m.index + m[0].length + window);
  return clip(text.slice(start, end), window * 2 + 40);
}

/** How many term-like tokens (abbreviations, capitalized compounds, hyphenated words) a text has. */
function termDensity(text: string): number {
  const abbreviations = (text.match(/\b[A-Z][A-Z0-9]{1,8}\b/g) ?? []).length;
  const hyphenated = (text.match(/\b[a-z]+-[a-z]+(?:-[a-z]+)?\b/g) ?? []).length;
  const capitalized = (text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? []).length;
  return abbreviations * 2 + hyphenated + capitalized;
}

/**
 * Pick the excerpts with the highest terminology value within `budget`
 * characters. Small documents are sent whole (still within the budget).
 */
export function selectTerminologySamples(blocks: readonly TranslationBlock[], budget = SAMPLE_BUDGET_CHARS): string[] {
  const translatable = blocks.filter((b) => b.type !== 'REFERENCE' && b.text.trim().length > 0);
  const total = translatable.reduce((n, b) => n + b.text.length, 0);
  if (total <= budget) return translatable.map((b) => clip(b.text, budget));

  const samples: string[] = [];
  const used = new Set<string>();
  let spent = 0;
  const add = (id: string | null, text: string) => {
    if (id && used.has(id)) return false;
    const t = clip(text, 1200);
    if (!t || spent + t.length > budget) return false;
    if (id) used.add(id);
    samples.push(t);
    spent += t.length;
    return true;
  };

  // 1. title(s)
  for (const b of translatable) if (b.type === 'TITLE') add(b.id, clip(b.text, 300));
  // 2. abstract / opening paragraphs
  let opening = 0;
  for (const b of translatable) {
    if (b.type !== 'BODY' || b.page > 2 || b.text.length < 80) continue;
    if (add(b.id, clip(b.text, 900))) opening++;
    if (opening >= 5) break;
  }
  // 3. headings, joined
  const headings = translatable.filter((b) => b.type === 'HEADING').map((b) => clip(b.text, 120));
  if (headings.length) {
    for (const b of translatable) if (b.type === 'HEADING') used.add(b.id);
    add(null, headings.join(' | ').slice(0, 1200));
  }
  // 4. captions
  let captions = 0;
  for (const b of translatable) {
    if (b.type !== 'CAPTION') continue;
    if (add(b.id, clip(b.text, 300))) captions++;
    if (captions >= 8) break;
  }
  // 5. abbreviation definitions ("chronic obstructive pulmonary disease (COPD)")
  let definitions = 0;
  for (const b of translatable) {
    if (used.has(b.id) || spent > budget * 0.8) break;
    const excerpt = definitionExcerpt(b.text);
    if (excerpt && add(b.id, excerpt)) definitions++;
    if (definitions >= 10) break;
  }
  // 6. the most term-dense body paragraphs, at most one per page
  const dense = translatable
    .filter((b) => b.type === 'BODY' && !used.has(b.id) && b.text.length >= 200)
    .map((b) => ({ b, score: termDensity(b.text) / Math.sqrt(b.text.length) }))
    .sort((x, y) => y.score - x.score);
  const pages = new Set<number>();
  for (const { b } of dense) {
    if (spent >= budget * 0.95) break;
    if (pages.has(b.page)) continue;
    if (add(b.id, clip(b.text, 600))) pages.add(b.page);
  }
  return samples;
}

function cleanSource(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function validAbbreviation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const a = raw.trim();
  if (!a || a.length > 15 || !/^[A-Za-z0-9][A-Za-z0-9\-/+.]*$/.test(a)) return null;
  return a;
}

/** Validate the Worker's structured reply into at most MAX_AUTO_TERMS clean entries. */
export function parseTerminologyResponse(data: unknown): TermEntry[] {
  const list = (data as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(list)) return [];
  const out: TermEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const { source, target, abbreviation } = raw as { source?: unknown; target?: unknown; abbreviation?: unknown };
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    const src = cleanSource(source);
    const tgt = target.replace(/\s+/g, ' ').trim();
    if (src.length < 2 || src.length > 80 || !/[A-Za-z]/.test(src)) continue;
    if (tgt.length < 1 || tgt.length > 60 || !CJK_RE.test(tgt)) continue;
    const key = src.toLowerCase();
    if (GENERIC_TERMS.has(key) || seen.has(key)) continue;
    seen.add(key);
    const abbr = validAbbreviation(abbreviation);
    out.push({ source: src, target: tgt, abbreviation: abbr && abbr.toLowerCase() !== key ? abbr : null, origin: 'auto' });
    if (out.length >= MAX_AUTO_TERMS) break;
  }
  return out;
}

/** User entries from the Developer Mode textarea ("term = 中文"); "term (ABBR) = 中文" sets the abbreviation. */
export function userTermsFromMap(map: Record<string, string> | null | undefined): TermEntry[] {
  const out: TermEntry[] = [];
  for (const [k, v] of Object.entries(map ?? {})) {
    const m = /^(.+?)\s*\(([A-Za-z0-9][A-Za-z0-9\-/+.]{0,14})\)$/.exec(k.trim());
    const source = cleanSource(m ? m[1] : k);
    const target = v.trim();
    if (!source || !target) continue;
    out.push({ source, target, abbreviation: m ? m[2] : null, origin: 'user' });
  }
  return out;
}

/**
 * User terminology first; automatic entries whose source (or abbreviation)
 * collides with a user entry are dropped, never merged over it.
 */
export function mergeTerminology(user: readonly TermEntry[], auto: readonly TermEntry[]): TermEntry[] {
  const taken = new Set<string>();
  const out: TermEntry[] = [];
  for (const t of user) {
    const key = t.source.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    if (t.abbreviation) taken.add(t.abbreviation.toLowerCase());
    out.push({ ...t, origin: 'user' });
  }
  for (const t of auto) {
    const key = t.source.toLowerCase();
    if (taken.has(key) || (t.abbreviation && taken.has(t.abbreviation.toLowerCase()))) continue;
    taken.add(key);
    if (t.abbreviation) taken.add(t.abbreviation.toLowerCase());
    out.push({ ...t, origin: 'auto' });
  }
  return out;
}

function foldForMatch(text: string): string {
  return text.toLowerCase().replace(/[-\s]+/g, ' ');
}

/** Entries whose term (singular / plural, hyphen or space) or abbreviation (whole word) occurs in `text`. */
export function relevantTerms(terms: readonly TermEntry[], text: string): TermEntry[] {
  if (terms.length === 0 || !text) return [];
  const haystack = foldForMatch(text);
  const out: TermEntry[] = [];
  for (const t of terms) {
    const term = foldForMatch(t.source);
    const stem = term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term;
    if (haystack.includes(stem)) {
      out.push(t);
      continue;
    }
    if (t.abbreviation) {
      const re = new RegExp(`(?<![A-Za-z0-9])${t.abbreviation.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9])`);
      if (re.test(text)) out.push(t);
    }
  }
  return out;
}

/** FNV-1a 32-bit, hex. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable hash of a term list (order-independent); '' for no terms. */
export function terminologyHash(terms: readonly TermEntry[]): string {
  if (terms.length === 0) return '';
  const lines = terms.map((t) => `${t.source.toLowerCase()}\u0001${t.target}\u0001${t.abbreviation ?? ''}`).sort();
  return fnv1a(lines.join('\n'));
}

/** The Worker's { term: rendering } map; abbreviations are appended as 中文（ABBR）. */
export function toWorkerTerminology(terms: readonly TermEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of terms) {
    out[t.source] = t.abbreviation && !t.target.includes(t.abbreviation) ? `${t.target}（${t.abbreviation}）` : t.target;
  }
  return out;
}

/** Fingerprint of a document's translatable text, for the per-session terminology cache. */
export function documentFingerprint(blocks: readonly TranslationBlock[]): string {
  let n = 0;
  const parts: string[] = [];
  for (const b of blocks) {
    parts.push(b.text);
    n += b.text.length;
  }
  return `${blocks.length}:${n}:${fnv1a(parts.join('\n'))}`;
}
