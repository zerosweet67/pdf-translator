/**
 * Central typography configuration for the translated text.
 *
 * Everything the renderer needs to decide "how big / how bold / how far
 * apart" lives here, so no font size, weight, indent or spacing number is
 * hidden inside render.ts or fit.ts. The module has no imports other than a
 * type, which keeps it free of cycles: fit.ts and render.ts import from it,
 * never the other way round.
 *
 * Two ideas drive the numbers:
 *
 *  1. Hierarchy is relative to the document body size (layout.ts computes it
 *     as the character-weighted mode of the source font sizes). A source
 *     heading that is only bold — same size as the body — is therefore still
 *     rendered clearly larger, and the fitting floor (minScale) stops the
 *     shrink-to-fit loop from ever pulling a heading back down to body size.
 *
 *  2. Paragraph spacing is paid for differently per role. A heading "slides
 *     down" into the gap that precedes it (more air above, less below, which
 *     is what ties a heading to the text it introduces) and is granted the
 *     same amount of extra downward extension, so it never has to shrink for
 *     it. A body paragraph instead gives up a little of its box height, which
 *     separates it from its neighbours without moving anything else.
 */

import type { BlockType, LayoutRole } from './types';

/**
 * Roles the renderer distinguishes. Every BlockType maps onto one of them;
 * a detector-assigned LayoutRole (pdf/roles.ts) refines the mapping.
 */
export type TypographyRoleName =
  | 'title'
  | 'heading'
  | 'structuredLabel'
  | 'sidebarHeading'
  | 'sidebarLabel'
  | 'sidebarBody'
  | 'body'
  | 'caption'
  | 'footnote'
  | 'other';

export interface RoleConfig {
  /**
   * Preferred start size as a multiple of the document body size. The source
   * size wins when it is already larger. 0 means "always keep the source size".
   */
  sizeScale: number;
  /** Upper bound for the boost, as a multiple of the body size. Ignored when sizeScale is 0. */
  maxScale: number;
  /**
   * Hard floor as a multiple of the body size: the shrink-to-fit loop must
   * not go below it, so the role keeps its visual distance from the body
   * text even in a tight box. 0 means "no absolute floor".
   */
  minScale: number;
  /** Additional floor relative to the role's own start size. */
  relativeMinRatio: number;
  /** Draw with a synthetic bold (fill + stroke); no bold font file is shipped. */
  bold: boolean;
  /** Baseline pitch as a multiple of the font size. */
  lineHeightRatio: number;
  /** First-line indent in em (0 = none). Only paragraph roles use it. */
  firstLineIndentEm: number;
  /** Space kept above the first line, in em. */
  spaceBeforeEm: number;
  /** Space kept below the last line, in em. */
  spaceAfterEm: number;
  /**
   * true: spaceBefore moves the block down and is added to the allowed
   * downward extension (the block slides, it does not shrink).
   * false: spaceBefore / spaceAfter are taken out of the box height.
   */
  slideDown: boolean;
}

export interface TypographyConfig {
  title: RoleConfig;
  heading: RoleConfig;
  /** Section label of a structured abstract ("Objective", "Findings"). */
  structuredLabel: RoleConfig;
  /** Heading of a sidebar / callout box. */
  sidebarHeading: RoleConfig;
  /** Run-in or standalone label inside a sidebar. */
  sidebarLabel: RoleConfig;
  /** Body text inside a sidebar: no paragraph indent, tighter spacing. */
  sidebarBody: RoleConfig;
  body: RoleConfig;
  caption: RoleConfig;
  footnote: RoleConfig;
  other: RoleConfig;
  /** A heading is never rendered below this multiple of the body size. */
  minHeadingBodyRatio: number;
  /** A title is never rendered below this multiple of the body size. */
  minTitleBodyRatio: number;
  /**
   * What must separate a label / sidebar heading from the body text it
   * introduces: at least `required` of size, weight and spacing. Size is
   * the minimum label / body ratio (1 = never below the body size), weight
   * the synthetic bold, spacing the space before the label in em.
   */
  minimumHeadingBodyContrast: {
    sizeRatio: number;
    bold: boolean;
    spaceBeforeEm: number;
    required: number;
  };
  /** Rules for a box too narrow for the wide-column defaults (pdf/typography.ts). */
  narrowBox: {
    /** A first line keeps at least this much usable width (em) after its indent. */
    minFirstLineEm: number;
    /**
     * A label in a box narrower than this (em of the source size) is never
     * raised. Ten em is about what the longest of a set of section labels
     * takes: "Alessandro PIRAS Employment" fills 8 em of its column, and it
     * needs the same treatment as the "Degree" next to it.
     */
    labelEm: number;
  };
  spacing: {
    /** Spacing may consume at most this fraction of a block's height. */
    maxShare: number;
    /** A heading / title never slides down by more than this many em. */
    maxSlideEm: number;
    /** Space above a structured / sidebar label (em of the label size): the section gap. */
    structuredLabelBefore: number;
    /** Gap after a run-in label before the body text starts (em of the label size); vertical for a standalone label. */
    structuredLabelAfter: number;
    /** Space between the end of one section body and the next label (em of the body size). */
    structuredSectionGap: number;
  };
  superscript: {
    /** Font size of a superscript run, as a multiple of the line's font size. */
    scale: number;
    /** Baseline shift upward, in em of the line's font size. */
    riseEm: number;
    /** Never draw a superscript below this size (points). */
    minSize: number;
    /** Baseline shift downward of a subscript run, in em of the line's font size. */
    dropEm: number;
  };
  /** Synthetic bold: stroke width as a multiple of the font size. */
  boldStrokeRatio: number;
  /** Low-level fitting constants; fit.ts re-exports them under its old names. */
  fit: {
    minFontSizeAbs: number;
    bodyMinRatio: number;
    lineHeightRatio: number;
    maxExtensionRatio: number;
    fontStep: number;
  };
}

export const TYPOGRAPHY: TypographyConfig = {
  title: {
    sizeScale: 1.65,
    maxScale: 2.2,
    minScale: 1.35,
    relativeMinRatio: 0.72,
    bold: true,
    lineHeightRatio: 1.25,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.3,
    spaceAfterEm: 0.25,
    slideDown: true,
  },
  heading: {
    sizeScale: 1.2,
    maxScale: 1.6,
    minScale: 1.12,
    relativeMinRatio: 0.8,
    bold: true,
    lineHeightRatio: 1.28,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.34,
    spaceAfterEm: 0.2,
    slideDown: true,
  },
  structuredLabel: {
    // At least the body size, a little above when the source is flat; bold and
    // spaced so the label keeps two of the three contrasts even at body size.
    sizeScale: 1.02,
    maxScale: 1.2,
    minScale: 1.0,
    relativeMinRatio: 0.9,
    bold: true,
    lineHeightRatio: 1.28,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.5,
    spaceAfterEm: 0.35,
    slideDown: true,
  },
  sidebarHeading: {
    sizeScale: 1.15,
    maxScale: 1.5,
    minScale: 1.08,
    relativeMinRatio: 0.85,
    bold: true,
    lineHeightRatio: 1.28,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.3,
    spaceAfterEm: 0.25,
    slideDown: true,
  },
  sidebarLabel: {
    sizeScale: 1.0,
    maxScale: 1.15,
    minScale: 1.0,
    relativeMinRatio: 0.9,
    bold: true,
    lineHeightRatio: 1.28,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.45,
    spaceAfterEm: 0.3,
    slideDown: true,
  },
  sidebarBody: {
    sizeScale: 0,
    maxScale: 0,
    minScale: 0,
    relativeMinRatio: 0.72,
    bold: false,
    lineHeightRatio: 1.28,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.15,
    spaceAfterEm: 0.15,
    slideDown: false,
  },
  body: {
    sizeScale: 0,
    maxScale: 0,
    minScale: 0,
    relativeMinRatio: 0.7,
    bold: false,
    lineHeightRatio: 1.3,
    firstLineIndentEm: 2,
    spaceBeforeEm: 0.18,
    spaceAfterEm: 0.18,
    slideDown: false,
  },
  caption: {
    sizeScale: 0,
    maxScale: 0,
    minScale: 0,
    relativeMinRatio: 0.7,
    bold: false,
    lineHeightRatio: 1.25,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0.12,
    spaceAfterEm: 0.12,
    slideDown: false,
  },
  // Footnotes keep the source metrics exactly (same numbers as `other`): a
  // named role for the hierarchy, no change in how they were rendered before.
  footnote: {
    sizeScale: 0,
    maxScale: 0,
    minScale: 0,
    relativeMinRatio: 0.7,
    bold: false,
    lineHeightRatio: 1.3,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0,
    spaceAfterEm: 0,
    slideDown: false,
  },
  other: {
    sizeScale: 0,
    maxScale: 0,
    minScale: 0,
    relativeMinRatio: 0.7,
    bold: false,
    lineHeightRatio: 1.3,
    firstLineIndentEm: 0,
    spaceBeforeEm: 0,
    spaceAfterEm: 0,
    slideDown: false,
  },
  minHeadingBodyRatio: 1.12,
  minTitleBodyRatio: 1.35,
  narrowBox: {
    minFirstLineEm: 4,
    labelEm: 10,
  },
  minimumHeadingBodyContrast: {
    sizeRatio: 1.0,
    bold: true,
    spaceBeforeEm: 0.3,
    required: 2,
  },
  spacing: {
    maxShare: 0.18,
    maxSlideEm: 0.4,
    structuredLabelBefore: 0.5,
    structuredLabelAfter: 0.35,
    structuredSectionGap: 0.5,
  },
  superscript: {
    scale: 0.7,
    riseEm: 0.36,
    minSize: 4,
    dropEm: 0.14,
  },
  boldStrokeRatio: 0.032,
  fit: {
    minFontSizeAbs: 6,
    bodyMinRatio: 0.7,
    lineHeightRatio: 1.3,
    maxExtensionRatio: 0.25,
    fontStep: 0.5,
  },
};

/** Which typography role a layout block type (refined by its layout role) belongs to. */
export function roleFor(type: BlockType, role?: LayoutRole): TypographyRoleName {
  switch (role) {
    case 'STRUCTURED_LABEL':
      return 'structuredLabel';
    case 'SIDEBAR_HEADING':
      return 'sidebarHeading';
    case 'SIDEBAR_LABEL':
      return 'sidebarLabel';
    case 'SIDEBAR_BODY':
      return type === 'FOOTNOTE' ? 'footnote' : 'sidebarBody';
    default:
      break;
  }
  switch (type) {
    case 'TITLE':
      return 'title';
    case 'HEADING':
      return 'heading';
    case 'BODY':
      return 'body';
    case 'CAPTION':
      return 'caption';
    case 'FOOTNOTE':
      return 'footnote';
    default:
      return 'other';
  }
}

/** Label-like typography roles: they take the structured spacing and the contrast floor. */
export const LABEL_TYPOGRAPHY_ROLES: ReadonlySet<TypographyRoleName> = new Set(['structuredLabel', 'sidebarLabel', 'sidebarHeading']);

export interface TypographyInput {
  type: BlockType;
  /** Layout role of the unit (pdf/roles.ts); refines the typography role. */
  role?: LayoutRole;
  /** Font size of the source block (points). */
  sourceFontSize: number;
  /** Document body font size (points), from layout.ts. */
  bodyFontSize: number;
  /**
   * Body font size inside the unit's container (points). Sidebar roles are
   * sized against it instead of the document body, so a sidebar set smaller
   * than the main text keeps its own hierarchy.
   */
  containerBodyFontSize?: number;
  /** Height of the first source box (points); spacing is capped against it. */
  blockHeight: number;
  /**
   * Width of the first source box (points). A box that is only a few em wide
   * cannot carry the wide-column defaults: the paragraph indent would leave
   * no line to write on and a raised label would wrap onto the text below.
   */
  blockWidth?: number;
  /** True when the unit continues a paragraph that started elsewhere: no indent. */
  isContinuation?: boolean;
}

export interface TypographySpec {
  role: TypographyRoleName;
  /** Size the fitting starts from (points). */
  fontSize: number;
  /** Floor for the shrink-to-fit loop (points). */
  minFontSize: number;
  lineHeightRatio: number;
  bold: boolean;
  boldStrokeRatio: number;
  /** First-line indent of the first box, in points (0 = none). */
  firstLineIndent: number;
  /** Points kept above the first baseline. */
  spaceBefore: number;
  /** Points kept below the last line. */
  spaceAfter: number;
  /** true: spaceBefore is added to the extension instead of taken from the height. */
  slideDown: boolean;
  /** fontSize / bodyFontSize, for the Developer Mode hierarchy report. */
  bodyRatio: number;
  /** True when the start size was raised above the source size. */
  boosted: boolean;
  /** True when the box was too narrow for the role's defaults (see TYPOGRAPHY.narrowBox). */
  narrowBox: boolean;
  /**
   * Which contrasts to the body text hold for a label / sidebar heading
   * (size, weight, spacing); empty for other roles. At least
   * TYPOGRAPHY.minimumHeadingBodyContrast.required of them are guaranteed.
   */
  contrast: Array<'size' | 'weight' | 'spacing'>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The absolute floor shared by every role (fit.ts uses the same numbers). */
function absoluteFloor(startSize: number): number {
  return Math.min(startSize, Math.max(TYPOGRAPHY.fit.minFontSizeAbs, startSize * TYPOGRAPHY.fit.bodyMinRatio));
}

/**
 * Resolve the typography of one translation unit.
 *
 * Start size: the source size, raised to `sizeScale × body` when the source
 * hierarchy is too flat (a bold-only heading), capped at `maxScale × body`.
 * Floor: the strictest of the role's absolute floor (`minScale × body`), its
 * relative floor and the shared 6 pt / 70 % rule — which is what stops a
 * heading from being fitted back down to body size.
 */
export function typographyFor(input: TypographyInput): TypographySpec {
  const role = roleFor(input.type, input.role);
  const cfg = TYPOGRAPHY[role];
  const sidebar = role === 'sidebarHeading' || role === 'sidebarLabel' || role === 'sidebarBody';
  const reference = sidebar && input.containerBodyFontSize && input.containerBodyFontSize > 0 ? input.containerBodyFontSize : input.bodyFontSize;
  const body = reference > 0 ? reference : input.sourceFontSize;
  const source = input.sourceFontSize > 0 ? input.sourceFontSize : body;

  const label = LABEL_TYPOGRAPHY_ROLES.has(role);
  const width = input.blockWidth !== undefined && input.blockWidth > 0 ? input.blockWidth : Number.POSITIVE_INFINITY;
  // A label whose box is only a few em wide has no room for the extra size:
  // it would wrap inside a box that is already too small for its own words,
  // and the wrap lands on the text underneath. The weight carries the
  // hierarchy there instead of the size.
  const narrowBox = label && width < TYPOGRAPHY.narrowBox.labelEm * source;

  let fontSize = source;
  if (cfg.sizeScale > 0 && !narrowBox) {
    // The cap bounds the BOOST, never the source: a title the document
    // already sets at 20 pt keeps its 20 pt.
    const wanted = Math.min(body * cfg.sizeScale, body * cfg.maxScale);
    fontSize = Math.max(source, wanted);
  }
  fontSize = round(fontSize);

  const floors = [absoluteFloor(fontSize), fontSize * cfg.relativeMinRatio];
  if (cfg.minScale > 0) floors.push(body * cfg.minScale);
  if (role === 'heading') floors.push(body * TYPOGRAPHY.minHeadingBodyRatio);
  if (role === 'title') floors.push(body * TYPOGRAPHY.minTitleBodyRatio);
  // The strongest floor wins, but never above the start size.
  const minFontSize = round(Math.min(fontSize, Math.max(...floors)));

  const height = Math.max(0, input.blockHeight);
  const budget = TYPOGRAPHY.spacing.maxShare * height;
  // A label slides by the structured section gap; that slide is never capped
  // by the block height because a one-line label has no height to speak of.
  const slideCap = label ? TYPOGRAPHY.spacing.structuredLabelBefore * fontSize : TYPOGRAPHY.spacing.maxSlideEm * fontSize;
  const spaceBefore = cfg.slideDown
    ? round(Math.min(cfg.spaceBeforeEm * fontSize, slideCap))
    : round(Math.min(cfg.spaceBeforeEm * fontSize, budget / 2));
  // A label keeps its space after (the gap to the run-in body text); other
  // sliding roles pay nothing below.
  const spaceAfter = cfg.slideDown ? (label ? round(cfg.spaceAfterEm * fontSize) : 0) : round(Math.min(cfg.spaceAfterEm * fontSize, budget / 2));
  // The indent is what is left of it once the first line keeps a usable
  // width: measured in em, so the same box is roomy for small text and too
  // narrow for large text. Without this a 20 pt wide paragraph ("Ph.D.")
  // keeps 2 pt to write on and the word is broken up.
  const wantedIndent = input.isContinuation ? 0 : cfg.firstLineIndentEm * fontSize;
  const firstLineIndent = round(Math.max(0, Math.min(wantedIndent, width - TYPOGRAPHY.narrowBox.minFirstLineEm * fontSize)));

  const contrast: TypographySpec['contrast'] = [];
  if (label) {
    const c = TYPOGRAPHY.minimumHeadingBodyContrast;
    if (minFontSize >= body * c.sizeRatio - 1e-6 && fontSize > body + 1e-6) contrast.push('size');
    if (cfg.bold && c.bold) contrast.push('weight');
    if (spaceBefore >= c.spaceBeforeEm * fontSize - 1e-6) contrast.push('spacing');
  }

  return {
    role,
    fontSize,
    minFontSize,
    lineHeightRatio: cfg.lineHeightRatio,
    bold: cfg.bold,
    boldStrokeRatio: TYPOGRAPHY.boldStrokeRatio,
    firstLineIndent,
    spaceBefore,
    spaceAfter,
    slideDown: cfg.slideDown,
    bodyRatio: round(fontSize / body),
    boosted: fontSize > source + 1e-6,
    narrowBox,
    contrast,
  };
}

/** True when a label spec keeps the required number of contrasts to the body text. */
export function hasRequiredContrast(spec: TypographySpec): boolean {
  if (!LABEL_TYPOGRAPHY_ROLES.has(spec.role)) return true;
  return spec.contrast.length >= TYPOGRAPHY.minimumHeadingBodyContrast.required;
}

/** Font size of a superscript run drawn inside a line set at `fontSize`. */
export function superscriptSize(fontSize: number): number {
  return Math.max(TYPOGRAPHY.superscript.minSize, round(fontSize * TYPOGRAPHY.superscript.scale));
}

/** Baseline shift (points, upward) of a superscript run inside a line set at `fontSize`. */
export function superscriptRise(fontSize: number): number {
  return round(fontSize * TYPOGRAPHY.superscript.riseEm);
}

/**
 * Baseline shift (points, downward and therefore negative) of a subscript run
 * inside a line set at `fontSize`. Smaller in magnitude than the rise: a
 * lowered run only has to clear the baseline, while a raised one has to clear
 * the x-height.
 */
export function subscriptRise(fontSize: number): number {
  return -round(fontSize * TYPOGRAPHY.superscript.dropEm);
}
