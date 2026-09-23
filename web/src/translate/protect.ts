/**
 * Protected entities.
 *
 * Citations ([12], [3–6], (Smith et al., 2024), Smith (2024)), figure / table /
 * appendix references, DOIs, URLs and e-mail addresses are replaced by
 * placeholders before the text goes to the model and put back afterwards, so
 * they can neither be dropped, renumbered nor "translated".
 *
 * Placeholder format: __KIND_n__ (e.g. __CITE_1__, __REF_2__). The restore
 * step is lenient about the small distortions models occasionally produce
 * (spacing, full-width underscores) and reports every placeholder that could
 * not be found: the caller then treats the block as high-risk.
 *
 * Numbers and statistics are deliberately NOT placeholders: the model needs
 * them in place to produce a readable sentence ("12 weeks" → "12 週"); they are
 * checked after translation instead (see entities.ts).
 */

export type ProtectedKind = 'CITE' | 'REF' | 'DOI' | 'URL' | 'EMAIL';

export interface Placeholder {
  token: string;
  kind: ProtectedKind;
  /** The original text the placeholder stands for. */
  value: string;
}

export interface ProtectedText {
  /** Text with placeholders; identical to the input when nothing was protected. */
  text: string;
  placeholders: Placeholder[];
}

export interface RestoreResult {
  text: string;
  /** Placeholders that were not found in the translation (their values are lost). */
  missing: Placeholder[];
  /** Placeholder-like tokens left in the output that belong to no known placeholder. */
  leftover: string[];
}

// One author: "Smith", "O'Brien", "Van der Berg", "Smith and Lee", "Smith & Lee", "Smith et al."
const AUTHOR = String.raw`[A-Z][A-Za-z'’\-]+(?:\s+(?:van|von|de|der|da|di|le)\s+[A-Z][A-Za-z'’\-]+)?(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]+)*(?:\s+et\s+al\.?)?`;
const YEAR = String.raw`\d{4}[a-z]?`;
const ONE_PAREN_CITE = String.raw`(?:(?:see|see also|e\.g\.|cf\.|also|i\.e\.),?\s+)?${AUTHOR},?\s+${YEAR}(?:,\s*(?:pp?\.\s*)?\d+(?:[–\-]\d+)?)?`;
// 2, 2A, 3.1, S1, B1, C2a, A, IV  (a bare letter must not start a word: "Table A" but not "Table Also")
const REF_NUMBER = String.raw`(?:\(?(?:S\d+|[A-Z]\d+|\d+(?:\.\d+)*)[A-Za-z]?\)?|[A-Z](?![A-Za-z0-9])|[IVX]{1,4}(?![A-Za-z]))`;

const PATTERNS: { kind: ProtectedKind; re: RegExp }[] = [
  { kind: 'EMAIL', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: 'URL', re: /(?:https?:\/\/|www\.)[^\s<>"'）)\]]+[^\s<>"'）)\].,;:]/g },
  { kind: 'DOI', re: /\b(?:doi:\s*)?10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;:)]/gi },
  // [12], [3–6], [3,5,8], [12-15, 18]
  { kind: 'CITE', re: /\[\d{1,4}(?:\s*[,;–\-]\s*\d{1,4})*\]/g },
  // (Smith et al., 2024), (Smith & Lee, 2023; Wu, 2020), (see Smith, 2024, p. 12)
  { kind: 'CITE', re: new RegExp(String.raw`\((?:${ONE_PAREN_CITE})(?:;\s*(?:${ONE_PAREN_CITE}))*\)`, 'g') },
  // Smith et al. (2024), Smith and Lee (2023)
  { kind: 'CITE', re: new RegExp(String.raw`\b${AUTHOR}\s+\(${YEAR}(?:,\s*${YEAR})*\)`, 'g') },
  // Figure 2, Fig. 2A, Figures 2 and 3, Table S1, Fig. B1, Supplementary Figure 3, Appendix A, Eq. (4)
  {
    kind: 'REF',
    re: new RegExp(
      String.raw`\b(?:(?:Supplementary|Supplemental|Online|Extended Data)\s+)?(?:Figures?|Figs?\.|Tables?|Appendix|Appendices|Equations?|Eqs?\.)\s+(?:${REF_NUMBER})(?:\s*(?:[,–\-]|and|to|&)\s*(?:${REF_NUMBER}))*`,
      'g',
    ),
  },
];

const PLACEHOLDER_RE = /__(CITE|REF|DOI|URL|EMAIL)_(\d+)__/g;
/** Lenient form: spacing, single or full-width underscores, leading zeros. */
const LENIENT_RE = /[_＿]{1,2}\s?(CITE|REF|DOI|URL|EMAIL)\s?[_＿]?\s?0*(\d+)\s?[_＿]{1,2}/g;

/** Does the text already contain something that looks like one of our placeholders? */
export function hasPlaceholderCollision(text: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(text);
}

/**
 * Replace protected entities by placeholders. Entities are matched in the
 * order EMAIL → URL → DOI → CITE → REF on the not-yet-protected text, so a DOI
 * inside a URL is one URL placeholder, not two.
 */
export function protectText(text: string): ProtectedText {
  if (hasPlaceholderCollision(text)) return { text, placeholders: [] };
  const placeholders: Placeholder[] = [];
  const counters: Partial<Record<ProtectedKind, number>> = {};
  let out = text;
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (match) => {
      const index = (counters[kind] ?? 0) + 1;
      counters[kind] = index;
      const token = `__${kind}_${index}__`;
      placeholders.push({ token, kind, value: match });
      return token;
    });
  }
  return { text: out, placeholders };
}

/** Put the original entities back; report placeholders that disappeared or were left behind. */
export function restoreText(translated: string, placeholders: readonly Placeholder[]): RestoreResult {
  if (placeholders.length === 0) return { text: translated, missing: [], leftover: [] };
  const byKey = new Map<string, Placeholder>();
  for (const p of placeholders) byKey.set(`${p.kind}_${Number(p.token.replace(/\D+/g, ''))}`, p);
  const found = new Set<string>();
  const leftover: string[] = [];
  LENIENT_RE.lastIndex = 0;
  const text = translated.replace(LENIENT_RE, (match, kind: string, n: string) => {
    const key = `${kind}_${Number(n)}`;
    const p = byKey.get(key);
    if (!p) {
      leftover.push(match);
      return match;
    }
    found.add(key);
    return p.value;
  });
  const missing = placeholders.filter((p) => !found.has(`${p.kind}_${Number(p.token.replace(/\D+/g, ''))}`));
  return { text, missing, leftover };
}

/** All citation-like entities of a text (same patterns as protection), normalized for comparison. */
export function extractCitations(text: string): string[] {
  const out: string[] = [];
  const consumed = protectText(text);
  for (const p of consumed.placeholders) {
    if (p.kind === 'CITE' || p.kind === 'REF') out.push(normalizeCitation(p.value));
  }
  return out.sort();
}

function normalizeCitation(value: string): string {
  return value
    .replace(/[–—‐‑−]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,;\-])\s*/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

export interface CitationDiff {
  ok: boolean;
  missing: string[];
  added: string[];
}

/** Multiset comparison of citations / references between source and translation. */
export function compareCitations(source: string, target: string): CitationDiff {
  const a = extractCitations(source);
  const b = extractCitations(target);
  const counts = new Map<string, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  const added: string[] = [];
  for (const y of b) {
    const n = counts.get(y) ?? 0;
    if (n > 0) counts.set(y, n - 1);
    else added.push(y);
  }
  const missing: string[] = [];
  for (const [x, n] of counts) for (let i = 0; i < n; i++) missing.push(x);
  return { ok: missing.length === 0 && added.length === 0, missing, added };
}
