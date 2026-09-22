/**
 * Text preprocessing that runs before anything is sent for translation.
 *
 *  - joinFragments / joinLines: join line (or block) fragments while repairing
 *    end-of-line hyphenation ("reason-" + "ing" → "reasoning") without
 *    breaking real hyphenated compounds ("state-of-the-" + "art").
 *  - analyzeCompleteness: heuristic "does this text end a sentence?" used to
 *    decide whether a block must be merged with the next one.
 *
 * Pure functions, no DOM, unit-tested in __tests__/text.test.ts.
 */

// ---------------------------------------------------------------------------
// Hyphenation repair
// ---------------------------------------------------------------------------

/**
 * Prefixes that normally keep their hyphen when the line breaks after them.
 * Deliberately short: many prefixes ("pre-", "co-", "inter-") are also common
 * syllable breaks ("pre-diction", "co-efficient"), so they are NOT listed.
 */
const KEEP_HYPHEN_PREFIXES = new Set(['well', 'self', 'cross', 'quasi', 'pseudo', 'ex', 'ill', 'so']);

/**
 * Join two fragments that were separated by a line break.
 *
 * Rule: if the first fragment ends with a purely alphabetic token followed by
 * "-" and the second fragment starts with a lowercase letter, the hyphen is a
 * typesetting break and is removed. Hyphens are kept when the token already
 * contains a hyphen (compound like "out-of-the-"), starts with a digit ("5-"),
 * is a single letter ("X-"), or is a known prefix ("well-").
 */
export function joinFragments(prev: string, next: string): string {
  const p = prev.replace(/\s+$/, '');
  const n = next.replace(/^\s+/, '');
  if (!p) return n;
  if (!n) return p;

  const m = /(\S+)-$/.exec(p);
  if (m) {
    if (!/^[a-z]/.test(n)) return p + n; // "non-" + "Gaussian": keep hyphen, no space
    const token = m[1];
    const core = token.replace(/^[^A-Za-z0-9]+/, '');
    const keep =
      core.includes('-') ||
      /^\d/.test(core) ||
      core.length < 2 ||
      !/^[A-Za-z]+$/.test(core) ||
      KEEP_HYPHEN_PREFIXES.has(core.toLowerCase());
    return keep ? p + n : p.slice(0, -1) + n;
  }

  return `${p} ${n}`;
}

/** Join the text of consecutive lines of one paragraph. */
export function joinLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    out = out ? joinFragments(out, t) : t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Sentence completeness
// ---------------------------------------------------------------------------

export interface CompletenessResult {
  /** True when the text ends a sentence. */
  complete: boolean;
  /** Why we think so, for debugging. */
  reason: string;
  /**
   * True when the incompleteness signal is strong (ends with a function word,
   * comma, open bracket, abbreviation...). A weak signal is only "no final
   * punctuation".
   */
  strong: boolean;
}

/** Words that essentially never end an English sentence. */
const TRAILING_FUNCTION_WORDS = new Set([
  // prepositions
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'into', 'onto', 'upon', 'via', 'per',
  'between', 'among', 'within', 'without', 'under', 'over', 'after', 'before', 'during', 'since', 'until',
  'toward', 'towards', 'through', 'across', 'against', 'versus', 'vs', 'than', 'as', 'like', 'unlike',
  // articles / determiners
  'a', 'an', 'the', 'this', 'these', 'those', 'its', 'their', 'our', 'his', 'her', 'each', 'every', 'any',
  'some', 'such', 'both', 'either', 'neither', 'no',
  // conjunctions / relatives
  'and', 'or', 'but', 'nor', 'yet', 'so', 'because', 'although', 'though', 'while', 'whereas', 'unless',
  'whether', 'if', 'when', 'where', 'that', 'which', 'who', 'whom', 'whose', 'how', 'what', 'why',
  // auxiliaries / copulas / modals
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'can', 'could', 'may', 'might', 'shall', 'should', 'will', 'would', 'must',
  // adverbs that expect a continuation
  'not', 'very', 'more', 'most', 'less', 'also', 'only', 'even', 'rather', 'quite',
]);

const ABBREVIATION_END = /\b(e\.g|i\.e|et al|etc|vs|cf|viz|fig|figs|eq|eqs|no|nos|vol|pp|approx|resp|ca|ibid|op\. cit|inc|ltd|co|dr|mr|mrs|ms|prof|jr|sr|st)\.$/i;

/** Remove trailing citation markers and closing quotes/brackets: `word [12]` → `word`. */
function stripTrailingMarkers(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/\s*[[(][^\])]{0,60}[\])]$/, '') // [12], (Smith et al., 2020), (see Table 1)
      .replace(/[\s"'”’)\]]+$/, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

export function analyzeCompleteness(text: string): CompletenessResult {
  const raw = text.trim();
  if (!raw) return { complete: true, reason: 'empty', strong: false };

  // A terminal mark right at the end always wins, even before a citation: "word [12]."
  if (/[.!?。！？]$/.test(raw) && !ABBREVIATION_END.test(raw)) {
    return { complete: true, reason: 'terminal-punctuation', strong: false };
  }

  const t = stripTrailingMarkers(raw);
  if (!t) return { complete: true, reason: 'only-markers', strong: false };

  if (ABBREVIATION_END.test(t)) return { complete: false, reason: 'abbreviation', strong: true };
  if (/[.!?。！？]$/.test(t)) return { complete: true, reason: 'terminal-punctuation', strong: false };
  if (/[:;：；]$/.test(t)) return { complete: true, reason: 'colon-or-semicolon', strong: false };
  if (/[,，、]$/.test(t)) return { complete: false, reason: 'trailing-comma', strong: true };
  if (/[-–—]$/.test(t)) return { complete: false, reason: 'trailing-dash', strong: true };
  if (/[([{“"]$/.test(t)) return { complete: false, reason: 'open-bracket', strong: true };

  const lastWord = /([A-Za-z'’]+)$/.exec(t)?.[1]?.toLowerCase().replace(/[’']/g, "'");
  if (lastWord && TRAILING_FUNCTION_WORDS.has(lastWord)) {
    return { complete: false, reason: `ends-with-function-word:${lastWord}`, strong: true };
  }

  return { complete: false, reason: 'no-terminal-punctuation', strong: false };
}

/** Convenience wrapper. */
export function isSentenceComplete(text: string): boolean {
  return analyzeCompleteness(text).complete;
}

// ---------------------------------------------------------------------------
// Context snippets
// ---------------------------------------------------------------------------

/** Last `maxChars` of a text, preferably starting at a sentence boundary. */
export function tailContext(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(-maxChars);
  const boundary = slice.search(/[.!?]\s+[A-Z]/);
  return boundary >= 0 && boundary < maxChars * 0.6 ? slice.slice(boundary + 2).trim() : `…${slice.trim()}`;
}

/** First `maxChars` of a text, preferably ending at a sentence boundary. */
export function headContext(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const lastEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  return lastEnd > maxChars * 0.4 ? slice.slice(0, lastEnd + 1).trim() : `${slice.trim()}…`;
}
