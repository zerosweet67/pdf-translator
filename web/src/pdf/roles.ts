/**
 * Generic layout roles: the one place that defines them.
 *
 * A block's `type` (TITLE / BODY / TABLE ...) keeps driving the legacy
 * pipelines. Its `role` refines that for the translation prompt and the
 * renderer: a structured-abstract label, a sidebar heading, a sidebar body
 * paragraph. Roles are assigned by the detectors in pdf/detectors/; nothing
 * else may invent a role string, so every consumer imports from here.
 *
 * No journal, publisher, page number or fixed sentence is checked anywhere in
 * the role pipeline. The label word list below is a scoring hint only: it
 * raises the confidence of a candidate that already looks like a label by
 * its typography and geometry, and never decides on its own.
 */

import type { BlockType, LayoutRole, TextBlock } from './types';

/** Every role, in ownership priority (an earlier owner wins a contested block). */
export const LAYOUT_ROLES: readonly LayoutRole[] = [
  'TABLE',
  'FIGURE',
  'SIDEBAR',
  'CALLOUT_BOX',
  'SIDEBAR_HEADING',
  'SIDEBAR_LABEL',
  'SIDEBAR_BODY',
  'STRUCTURED_LABEL',
  'CAPTION',
  'HEADING',
  'FOOTNOTE',
  'REFERENCE',
  'BODY',
];

/** Roles that live inside a sidebar / callout container. */
export const SIDEBAR_ROLES: ReadonlySet<LayoutRole> = new Set(['SIDEBAR_HEADING', 'SIDEBAR_LABEL', 'SIDEBAR_BODY']);

/** Label-like roles: short, bold, introduce the text that follows. */
export const LABEL_ROLES: ReadonlySet<LayoutRole> = new Set(['STRUCTURED_LABEL', 'SIDEBAR_LABEL']);

/** Heading-like roles (labels included): never merged with neighbouring paragraphs, never chapter anchors when detector-assigned. */
export const HEADING_LIKE_ROLES: ReadonlySet<LayoutRole> = new Set(['HEADING', 'STRUCTURED_LABEL', 'SIDEBAR_HEADING', 'SIDEBAR_LABEL']);

/**
 * Roles the Worker receives as `type` (worker/src/prompt.ts has one short
 * guidance line per entry). Everything else falls back to the block type.
 */
export const WORKER_ROLE_TYPES: ReadonlySet<LayoutRole> = new Set(['STRUCTURED_LABEL', 'SIDEBAR_HEADING', 'SIDEBAR_LABEL', 'SIDEBAR_BODY']);

/** Default role of a block type (before any detector runs). */
export function defaultRoleFor(type: BlockType): LayoutRole {
  switch (type) {
    case 'HEADING':
    case 'TITLE':
      return 'HEADING';
    case 'CAPTION':
      return 'CAPTION';
    case 'TABLE':
      return 'TABLE';
    case 'FIGURE':
      return 'FIGURE';
    case 'FOOTNOTE':
      return 'FOOTNOTE';
    case 'REFERENCE':
      return 'REFERENCE';
    default:
      return 'BODY';
  }
}

/** The role of a block or unit: its own, else the default of its type. */
export function roleOf(block: { type: BlockType; role?: LayoutRole }): LayoutRole {
  return block.role ?? defaultRoleFor(block.type);
}

/** Give every block its default role; detectors refine from there. */
export function assignDefaultRoles(blocks: readonly TextBlock[]): void {
  for (const b of blocks) {
    if (!b.role) b.role = defaultRoleFor(b.type);
  }
}

/** True when the role was assigned by a detector (not derived from the type). */
export function isDetectedRole(block: TextBlock): boolean {
  return block.roleDetector !== undefined && block.roleDetector !== 'default';
}

/**
 * Words that often open a section of a structured abstract or a summary box.
 * Scoring hint only (see the module comment): +0.15 to a candidate that
 * already passes the typographic / geometric checks. Lower-case, compared
 * against the label's words after punctuation is stripped.
 */
export const LABEL_HINT_WORDS: ReadonlySet<string> = new Set([
  'importance',
  'objective',
  'objectives',
  'background',
  'design',
  'setting',
  'settings',
  'participants',
  'patients',
  'methods',
  'method',
  'main',
  'outcomes',
  'outcome',
  'measures',
  'measure',
  'results',
  'result',
  'conclusions',
  'conclusion',
  'relevance',
  'interventions',
  'intervention',
  'exposures',
  'exposure',
  'findings',
  'finding',
  'meaning',
  'question',
  'purpose',
  'aim',
  'aims',
  'interpretation',
  'overview',
  'summary',
  'highlights',
  'implications',
  'context',
  'rationale',
  'limitations',
  'funding',
  'registration',
  'evidence',
  'added',
  'points',
  'messages',
  'key',
  'what',
  'why',
  'matters',
  'known',
  'adds',
  'clinical',
  'research',
  'discussion',
  'introduction',
  'materials',
  'analysis',
  'data',
  'sources',
]);

/** Share of a label's words that are hint words, 0 when it has no words. */
export function labelHintShare(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 2 && w !== 'and' && w !== 'of' && w !== 'the' && w !== 'in');
  if (words.length === 0) return 0;
  const hits = words.filter((w) => LABEL_HINT_WORDS.has(w)).length;
  return hits / words.length;
}

/** Human-readable role label for Developer Mode (繁體中文). */
export const ROLE_LABELS_ZH: Record<LayoutRole, string> = {
  BODY: '內文',
  HEADING: '標題',
  STRUCTURED_LABEL: '結構式摘要標籤',
  SIDEBAR: '側欄',
  CALLOUT_BOX: '重點框',
  SIDEBAR_HEADING: '側欄標題',
  SIDEBAR_LABEL: '側欄標籤',
  SIDEBAR_BODY: '側欄內文',
  CAPTION: '圖表標題',
  TABLE: '表格',
  FIGURE: '圖',
  FOOTNOTE: '註腳',
  REFERENCE: '參考文獻',
};
