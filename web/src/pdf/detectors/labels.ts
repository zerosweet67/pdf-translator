/**
 * Label candidates shared by the structured-abstract and sidebar detectors.
 *
 * Two shapes are recognised:
 *
 *   run-in     the first items of a paragraph's first line are set in a
 *              different (heavier) font than the rest of the line:
 *              "IMPORTANCE As older adults live longer ..."
 *              "Findings In this cross-sectional study ..."
 *   standalone a short block of its own, bold or capitalised or ending in a
 *              colon, followed by a body paragraph:
 *              "Background" / "Purpose:" on a line of their own
 *
 * Both are scored from typography and geometry only (font change, weight,
 * capitalisation, length, what follows, a short rule above). The common
 * academic label words in pdf/roles.ts add a small bonus and never decide.
 */

import { labelHintShare } from '../roles';
import type { RuleLine, TextBlock, TextItemDebug } from '../types';

/** Font names that carry a weight above regular. */
const BOLD_RE = /bold|black|heavy|semibold|demibold|demi\b|extrabold|ultrabold/i;
/** A medium weight is a weaker but still visible contrast. */
const MEDIUM_RE = /medium/i;
/** A gap wider than this × fontSize between items becomes a space (same as layout.ts). */
const WORD_GAP = 0.12;
/** A run-in label may take at most this share of its line. */
const RUN_IN_MAX_LINE_SHARE = 0.6;
/** Label limits. */
export const LABEL_MAX_WORDS = 8;
export const LABEL_MAX_CHARS = 60;
/** A short rule sits this close above the label (× font size). */
const RULE_ABOVE_MAX = 2.2;
/** A standalone label's body starts within this many line pitches below it. */
const FOLLOW_MAX_PITCH = 2.4;

export interface LabelCandidate {
  blockId: string;
  /** How the label sits: run-in (text follows on the same line), own-line (fills line 0 of a multi-line block), standalone (a block of its own). */
  placement: 'run-in' | 'own-line' | 'standalone';
  /** Leading items of line 0 that form the label (run-in / own-line), 0 for standalone. */
  itemCount: number;
  text: string;
  /** Text after the label on the same line (run-in only). */
  remainder: string;
  fontName: string;
  fontRealName: string | null;
  fontSize: number;
  bold: boolean;
  /** Left edge / width of the label glyphs. */
  x: number;
  width: number;
  /** Baseline of the label. */
  y: number;
}

export interface LabelScore {
  confidence: number;
  signals: string[];
}

export function isBoldFontName(name: string | null | undefined): boolean {
  return !!name && BOLD_RE.test(name);
}

function isMediumFontName(name: string | null | undefined): boolean {
  return !!name && MEDIUM_RE.test(name) && !isBoldFontName(name);
}

/** Join items of one line into text (word spaces from the gaps). */
export function joinItemTexts(items: readonly TextItemDebug[]): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = item.x - (prev.x + prev.width);
      const fs = Math.max(prev.fontSize, item.fontSize, 1);
      if (gap > WORD_GAP * fs && !/\s$/.test(out) && !/^\s/.test(item.text)) out += ' ';
    }
    out += item.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
}

/** Text is a plausible label: short, has letters, does not end a sentence. */
function plausibleLabelText(text: string): boolean {
  const t = text.trim();
  if (letterCount(t) < 2) return false;
  if (wordCount(t) > LABEL_MAX_WORDS || t.length > LABEL_MAX_CHARS) return false;
  if (/[.!?]$/.test(t) && !/\b[A-Z]\.$/.test(t)) return false;
  return true;
}

function sameFont(a: TextItemDebug, b: TextItemDebug): boolean {
  return a.fontName === b.fontName && Math.abs(a.fontSize - b.fontSize) <= 0.06 * Math.max(a.fontSize, b.fontSize);
}

/**
 * The run-in label of a block, when its first line opens with items in a
 * font that the rest of the line (or the next line) does not use. Null when
 * the block has no such run.
 */
export function findRunInLabel(block: TextBlock): LabelCandidate | null {
  if (block.cell || block.lines.length === 0) return null;
  const line0 = block.lines[0];
  const items = [...line0.items].sort((a, b) => a.x - b.x);
  if (items.length < 2 && block.lines.length < 2) return null;
  const first = items[0];
  let count = 0;
  while (count < items.length && sameFont(items[count], first)) count++;
  const labelItems = items.slice(0, count);
  const rest = items.slice(count);
  const text = joinItemTexts(labelItems);
  if (!plausibleLabelText(text)) return null;

  let placement: LabelCandidate['placement'];
  let contrastFont: TextItemDebug | null = null;
  if (rest.length > 0) {
    placement = 'run-in';
    contrastFont = rest[0];
  } else {
    if (block.lines.length < 2) return null;
    placement = 'own-line';
    const next = block.lines[1].items[0];
    contrastFont = next ?? null;
  }
  if (!contrastFont) return null;
  const bold = isBoldFontName(first.fontRealName) || isBoldFontName(first.fontName);
  // The label font must differ from what follows; a bold-only difference by name counts.
  const fontDiffers = contrastFont.fontName !== first.fontName || Math.abs(contrastFont.fontSize - first.fontSize) > 0.06 * first.fontSize;
  if (!fontDiffers) return null;
  const labelLeft = Math.min(...labelItems.map((i) => i.x));
  const labelRight = Math.max(...labelItems.map((i) => i.x + i.width));
  if (placement === 'run-in' && labelRight - labelLeft > RUN_IN_MAX_LINE_SHARE * Math.max(1, line0.width)) return null;
  return {
    blockId: block.id,
    placement,
    itemCount: count,
    text,
    remainder: placement === 'run-in' ? joinItemTexts(rest) : '',
    fontName: first.fontName,
    fontRealName: first.fontRealName,
    fontSize: first.fontSize,
    bold,
    x: labelLeft,
    width: labelRight - labelLeft,
    y: first.y,
  };
}

/** A whole block that could be a label on its own line. */
export function standaloneLabelCandidate(block: TextBlock): LabelCandidate | null {
  if (block.cell || block.lineCount > 2 || block.lines.length === 0) return null;
  const text = block.text.trim();
  if (!plausibleLabelText(text)) return null;
  const bold = isBoldFontName(block.fontRealName) || isBoldFontName(block.fontName);
  const caps = isAllCaps(text);
  const colon = /:$/.test(text);
  if (!bold && !caps && !colon) return null;
  return {
    blockId: block.id,
    placement: 'standalone',
    itemCount: 0,
    text,
    remainder: '',
    fontName: block.fontName,
    fontRealName: block.fontRealName,
    fontSize: block.fontSize,
    bold,
    x: block.x,
    width: block.width,
    y: block.lines[0].y,
  };
}

export function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ɏ]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0) return false;
  return words.every((w) => /^[A-Z]/.test(w) || /^(and|of|the|in|for|to|a|an|or)$/i.test(w));
}

export interface LabelScoreContext {
  /** The block the candidate belongs to. */
  block: TextBlock;
  /** The next block in reading order in the same column (standalone labels need a body after them). */
  next: TextBlock | null;
  rules: readonly RuleLine[];
  /** Font size the label is compared against (document body or container body). */
  referenceFontSize: number;
}

/** Score a candidate from its typography and geometry; the hint words add at most 0.15. */
export function scoreLabel(c: LabelCandidate, ctx: LabelScoreContext): LabelScore {
  const signals: string[] = [];
  let score = c.placement === 'run-in' ? 0.45 : c.placement === 'own-line' ? 0.35 : 0.25;
  signals.push(`placement:${c.placement}`);

  if (c.bold) {
    score += 0.15;
    signals.push('bold-font');
  } else if (isMediumFontName(c.fontRealName)) {
    score += 0.08;
    signals.push('medium-font');
  }
  if (isAllCaps(c.text)) {
    score += 0.15;
    signals.push('all-caps');
  } else if (isTitleCase(c.text)) {
    score += 0.05;
    signals.push('title-case');
  }
  const hint = labelHintShare(c.text);
  if (hint >= 0.5) {
    score += 0.15;
    signals.push('hint-words');
  } else if (hint > 0) {
    score += 0.08;
    signals.push('hint-word');
  }
  const words = wordCount(c.text);
  if (words <= 4) {
    score += 0.05;
    signals.push('short');
  }
  if (/:$/.test(c.text)) {
    score += 0.05;
    signals.push('colon');
  }

  // What follows the label.
  if (c.placement === 'run-in') {
    if (wordCount(c.remainder) >= 2) {
      score += 0.15;
      signals.push('text-follows');
    } else {
      score -= 0.2;
      signals.push('nothing-follows');
    }
  } else if (c.placement === 'own-line') {
    score += 0.1;
    signals.push('paragraph-follows');
  } else {
    const n = ctx.next;
    const follows =
      n !== null &&
      !n.cell &&
      (n.type === 'BODY' || n.type === 'OTHER') &&
      n.page === ctx.block.page &&
      n.column === ctx.block.column &&
      ctx.block.y - n.top <= FOLLOW_MAX_PITCH * Math.max(c.fontSize, n.fontSize) &&
      ctx.block.y - n.top >= -0.5 * c.fontSize &&
      Math.abs(n.x - ctx.block.x) <= 3;
    if (follows) {
      score += 0.15;
      signals.push('body-follows');
    } else {
      score -= 0.3;
      signals.push('no-body-follows');
    }
  }

  // A short decorative rule right above the label (journal section markers).
  const ruleAbove = ctx.rules.some(
    (r) =>
      r.orientation === 'horizontal' &&
      Math.abs(r.x0 - c.x) <= 3 &&
      r.x1 - r.x0 <= Math.max(60, 0.5 * ctx.block.width) &&
      r.y0 > c.y &&
      r.y0 - c.y <= RULE_ABOVE_MAX * c.fontSize,
  );
  if (ruleAbove) {
    score += 0.1;
    signals.push('rule-above');
  }

  // Size relative to the surrounding text: a label may be at body size or a little above, never tiny.
  const ratio = ctx.referenceFontSize > 0 ? c.fontSize / ctx.referenceFontSize : 1;
  if (ratio < 0.85) {
    score -= 0.2;
    signals.push('smaller-than-body');
  } else if (ratio > 1.6) {
    score -= 0.15;
    signals.push('much-larger-than-body');
  }

  // Penalties.
  if (words > LABEL_MAX_WORDS) {
    score -= 0.5;
    signals.push('too-long');
  }
  if ((c.text.match(/\d/g) ?? []).length >= 3) {
    score -= 0.25;
    signals.push('digits');
  }
  if (/^[a-z]/.test(c.text)) {
    score -= 0.4;
    signals.push('lowercase-start');
  }
  if (c.placement === 'run-in' && c.width > RUN_IN_MAX_LINE_SHARE * ctx.block.width) {
    score -= 0.3;
    signals.push('label-too-wide');
  }

  return { confidence: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), signals };
}

/** The best label candidate of a block (run-in first, standalone otherwise), unscored. */
export function labelCandidateOf(block: TextBlock): LabelCandidate | null {
  return findRunInLabel(block) ?? standaloneLabelCandidate(block);
}
