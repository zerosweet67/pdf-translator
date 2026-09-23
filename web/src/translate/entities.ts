/**
 * Numeric / statistical integrity.
 *
 * Every block gets a "numeric signature": the multiset of numbers (with sign,
 * decimals and a % flag) plus structured statistical entities (p-values,
 * n = …, mean ± sd). Source and translation are compared on these semantic
 * values, never on raw strings, so "95 %" ≡ "95%", "p = 0.03" ≡ "p=0.03",
 * "10–15" ≡ "10-15", "5.2±1.1" ≡ "5.2 ± 1.1", "1,234" ≡ "1234", ".05" ≡ "0.05".
 *
 * Numbers that legitimately appear only on one side are tolerated:
 *   - a number word in the source ("three groups") rendered as a digit,
 *   - a small digit in the source rendered as a Chinese numeral (兩組),
 *   - roman numerals (phase II → 第 2 期).
 * Everything else is reported as missing / added and marks the block high-risk.
 */

export interface NumericSignature {
  /** Numbers, normalized ("0.05", "-1.2", "12.4%"), sorted. */
  numbers: string[];
  /** Structured entities: "p<0.05", "n=42", "5.2±1.1", sorted. */
  stats: string[];
}

export interface NumericDiff {
  ok: boolean;
  /** Present in the source, absent from the translation. */
  missing: string[];
  /** Present in the translation, absent from the source. */
  added: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  once: 1, twice: 2, single: 1, double: 2, triple: 3, half: 0.5, quarter: 0.25, dozen: 12, both: 2,
};
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const CJK_NUMERALS: Record<string, string> = {
  '0': '零', '1': '一', '2': '二兩', '3': '三', '4': '四', '5': '五', '6': '六', '7': '七', '8': '八', '9': '九', '10': '十',
};

/** Canonical ASCII form: digits, punctuation, dashes, spacing around operators, thousands separators. */
export function normalizeNumericText(text: string): string {
  let t = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[．]/g, '.')
    .replace(/[％]/g, '%')
    .replace(/[＝]/g, '=')
    .replace(/[＜]/g, '<')
    .replace(/[＞]/g, '>')
    .replace(/[＋]/g, '+')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/[–—‐‑−﹣－]/g, '-')
    .replace(/[×]/g, 'x')
    .replace(/ /g, ' ');
  // thousands separators: 1,234,567 → 1234567 (but not "42, 13")
  for (let i = 0; i < 4; i++) t = t.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  t = t
    .replace(/(\d)\s*percent\b/gi, '$1%')
    .replace(/百分之\s*(\d+(?:\.\d+)?)/g, '$1%')
    .replace(/\s*([=<>≤≥±%])\s*/g, '$1')
    .replace(/(\d)\s*(?:-|~|～|至|to)\s*(\d)/g, '$1-$2')
    .replace(/\bp\s*-?\s*value\b/gi, 'p')
    .replace(/(\d)\s+(\d{3})(?!\d)/g, '$1$2'); // "1 000" style thousands
  return t;
}

function canonNumber(raw: string): string {
  let sign = '';
  let s = raw;
  if (s.startsWith('-')) {
    sign = '-';
    s = s.slice(1);
  }
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  if (s.startsWith('.')) s = `0${s}`;
  // strip redundant leading zeros ("007" → "7", but keep "0.5")
  s = s.replace(/^0+(?=\d)/, '');
  // strip trailing zeros in decimals only when the whole fraction is zero ("5.0" → "5")
  if (/\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (s === '0') sign = '';
  return `${sign}${s}${pct ? '%' : ''}`;
}

/**
 * A number token. A leading "." decimal (".05") must not follow a word, ")", "]"
 * or a quote: there it is a footnote marker after a sentence ("word.3", ").1").
 */
const NUMBER_TOKEN_RE = /(?<!\w)(-?)(\d+(?:\.\d+)?|(?<![\w.)\]”"'])\.\d+)(%?)/g;
/** "410 million" / "8.2 billion" and their Chinese renderings "4.10 億" / "82 億" compare by value. */
const EN_MAGNITUDE_RE = /(?<!\w)(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s*(thousand|million|billion|trillion)\b/gi;
const ZH_MAGNITUDE_RE = /(?<!\w)(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s*(千萬|百萬|千|萬|億|兆)(?![A-Za-z])/g;
const MAGNITUDES: Record<string, number> = {
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
  千: 1e3, 萬: 1e4, 百萬: 1e6, 千萬: 1e7, 億: 1e8, 兆: 1e12,
};
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Quantities with a magnitude word, as "≈value" strings, and the text with those numbers blanked. */
function extractMagnitudes(text: string): { values: string[]; rest: string } {
  const values: string[] = [];
  // "3-10 billion" is a range of two quantities; both compare by value
  const blank = (_m: string, num: string, upper: string | undefined, unit: string) => {
    const factor = MAGNITUDES[unit.toLowerCase()] ?? 1;
    for (const n of [num, upper]) if (n) values.push(`≈${Number((Number(n) * factor).toPrecision(6))}`);
    return ' ';
  };
  const rest = text.replace(EN_MAGNITUDE_RE, blank).replace(ZH_MAGNITUDE_RE, blank);
  return { values, rest };
}
const P_VALUE_RE = /(?<![A-Za-z])[pP]([=<>≤≥])(\.?\d+(?:\.\d+)?)/g;
const N_VALUE_RE = /(?<![A-Za-z])[nN]=(\d+)/g;
const PLUS_MINUS_RE = /(-?(?:\d+(?:\.\d+)?|\.\d+))±((?:\d+(?:\.\d+)?|\.\d+))/g;

/** Numbers and statistical entities of a text, normalized and sorted. */
export function extractNumericSignature(text: string): NumericSignature {
  const magnitudes = extractMagnitudes(normalizeNumericText(text));
  const t = magnitudes.rest;
  const numbers: string[] = [...magnitudes.values];
  const stats: string[] = [];
  for (const m of t.matchAll(NUMBER_TOKEN_RE)) {
    const before = m.index > 0 ? t[m.index - 1] : '';
    // "-" is a sign only when attached to the digit and preceded by a boundary; "x-5" is not "-5".
    const sign = m[1] && (before === '' || /[\s(\[=<>:;,/]/.test(before)) ? '-' : '';
    numbers.push(canonNumber(`${sign}${m[2]}${m[3]}`));
  }
  for (const m of t.matchAll(P_VALUE_RE)) stats.push(`p${m[1]}${canonNumber(m[2])}`);
  for (const m of t.matchAll(N_VALUE_RE)) stats.push(`n=${canonNumber(m[1])}`);
  for (const m of t.matchAll(PLUS_MINUS_RE)) stats.push(`${canonNumber(m[1])}±${canonNumber(m[2])}`);
  return { numbers: numbers.sort(), stats: stats.sort() };
}

function multisetDiff(a: string[], b: string[]): { missing: string[]; added: string[] } {
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
  return { missing, added };
}

/** Numbers the translation may add without a digit in the source (number words, roman numerals). */
function tolerableAdded(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.toLowerCase().matchAll(/\b([a-z]+)\b/g)) {
    const v = NUMBER_WORDS[m[1]] ?? MONTHS[m[1]];
    if (v !== undefined) out.add(String(v));
  }
  for (const m of source.matchAll(/\b(I{1,3}|IV|VI{0,3}|IX|X)\b/g)) {
    const v = ROMAN[m[1]];
    if (v !== undefined) out.add(String(v));
  }
  return out;
}

/** A small integer missing from the translation may have become a Chinese numeral (兩組, 三次). */
function renderedAsCjkNumeral(missing: string, target: string): boolean {
  const chars = CJK_NUMERALS[missing];
  if (!chars) return false;
  for (const ch of chars) if (target.includes(ch)) return true;
  return false;
}

/**
 * Compare the numeric content of a source block with its translation.
 * Whitespace / dash / percent / thousands / leading-zero differences never
 * count; changed, missing or added values do.
 */
export function compareNumeric(source: string, target: string): NumericDiff {
  const a = extractNumericSignature(source);
  const b = extractNumericSignature(target);
  const nums = multisetDiff(a.numbers, b.numbers);
  const stats = multisetDiff(a.stats, b.stats);
  const tolerated = tolerableAdded(source);
  const added = [...nums.added.filter((x) => !tolerated.has(x)), ...stats.added];
  const missing = [...nums.missing.filter((x) => !renderedAsCjkNumeral(x, target)), ...stats.missing];
  return { ok: missing.length === 0 && added.length === 0, missing, added };
}

/** Symbols that academic zh-TW keeps as they are; a missing one is a fidelity warning. */
const KEPT_SYMBOLS = /[±≤≥°μµΔ∆αβγδεζηθλσπφχψωΩΣ∑]/g;

/** Symbols of the source that do not appear in the translation. */
export function missingSymbols(source: string, target: string): string[] {
  const out: string[] = [];
  const have = new Set(target.match(KEPT_SYMBOLS) ?? []);
  // µ (micro sign) and μ (Greek mu), Δ and ∆ are interchangeable
  const same = (s: string) => (s === 'µ' ? 'μ' : s === '∆' ? 'Δ' : s === '∑' ? 'Σ' : s);
  const haveNorm = new Set([...have].map(same));
  for (const s of new Set(source.match(KEPT_SYMBOLS) ?? [])) if (!haveNorm.has(same(s))) out.push(s);
  return out;
}

/** How "numeric" a text is: used by the risk scoring (dense statistics → review). */
export function numericDensity(text: string): { numbers: number; stats: number; parentheses: number } {
  const sig = extractNumericSignature(text);
  return { numbers: sig.numbers.length, stats: sig.stats.length, parentheses: (text.match(/[(（]/g) ?? []).length };
}
