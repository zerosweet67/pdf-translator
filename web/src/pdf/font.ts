/**
 * Fonts for the translated text. All four are open-source (SIL OFL 1.1),
 * committed in web/public/fonts/ and deployed with the site:
 *
 *  Chinese / CJK             → LXGW WenKai TC (霞鶩文楷 TC), LXGWWenKaiTC-Regular.ttf
 *  Latin, digits, Greek, ±…  → Liberation Serif,           LiberationSerif-Regular.ttf
 *  symbol blocks (arrows, math operators, shapes, dingbats…)
 *                            → Noto Sans Symbols 2,        NotoSansSymbols2-Regular.ttf
 *  final fallback            → Noto Sans TC,               NotoSansTC-Regular.ttf
 *
 * selectFontForGlyph() picks the class's primary font and then checks the
 * font's real cmap; when the glyph is missing it walks the class's fallback
 * chain (see FALLBACK_CHAINS). Only when no loaded font has the glyph is the
 * character replaced (sanitizeForFont), with a "[Font Fallback Warning]".
 *
 * When a primary file cannot be loaded the role falls back to Noto Sans TC
 * and the UI says so. Every font is downloaded once per session and embedded
 * with pdf-lib subsetting.
 *
 * MixedFont splits a string into runs (one font per run) so a line such as
 * 大型語言模型（Large Language Models, LLMs）is drawn with 霞鶩文楷 for the
 * Chinese and the brackets and Liberation Serif for the Latin part. It also
 * implements TextMeasurer for fit.ts, so wrapping uses the real per-run widths.
 *
 * Subsetting caveat: @pdf-lib/fontkit's TrueType subsetter writes short `loca`
 * offsets and does not pad glyph data, so a font with odd-length glyphs would
 * come out corrupted. `trueTypeSubsetSafe()` checks that; an unsafe font is
 * embedded whole instead (correct glyphs beat a small file). CID-keyed CFF
 * (`OTTO`) fonts cannot be subset by the fork at all and are embedded whole too.
 */

import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { isCjkChar, type TextMeasurer } from './fit';

export type FontRole = 'cjk' | 'latin' | 'symbol' | 'fallback';

export interface FontSource {
  role: FontRole;
  label: string;
  /** File name inside the folder, for messages. */
  file: string;
  url: string;
  /** Required fonts abort the export when missing; optional ones fall back. */
  required: boolean;
}

const BASE = import.meta.env.BASE_URL;
export const FONT_DIR = 'web/public/fonts/';

/** The only place file names live. */
export const FONT_SOURCES: Record<FontRole, FontSource> = {
  cjk: {
    role: 'cjk',
    label: 'LXGW WenKai TC',
    file: 'LXGWWenKaiTC-Regular.ttf',
    url: `${BASE}fonts/LXGWWenKaiTC-Regular.ttf`,
    required: false,
  },
  latin: {
    role: 'latin',
    label: 'Liberation Serif',
    file: 'LiberationSerif-Regular.ttf',
    url: `${BASE}fonts/LiberationSerif-Regular.ttf`,
    required: false,
  },
  symbol: {
    role: 'symbol',
    label: 'Noto Sans Symbols 2',
    file: 'NotoSansSymbols2-Regular.ttf',
    url: `${BASE}fonts/NotoSansSymbols2-Regular.ttf`,
    required: false,
  },
  fallback: {
    role: 'fallback',
    label: 'Noto Sans TC',
    file: 'NotoSansTC-Regular.ttf',
    url: `${BASE}fonts/NotoSansTC-Regular.ttf`,
    required: true,
  },
};

/** Drawn in place of characters no loaded font has a glyph for. */
export const FALLBACK_CHAR = '□';

export class FontLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontLoadError';
  }
}

export interface LoadedFont {
  role: FontRole;
  label: string;
  bytes: ArrayBuffer;
  /** False when the fork's subsetter would corrupt this file; it is then embedded whole. */
  subsetSafe: boolean;
}

export interface FontSetBytes {
  cjk: LoadedFont | null;
  latin: LoadedFont | null;
  symbol: LoadedFont | null;
  fallback: LoadedFont;
  /** One human-readable line per missing optional font. */
  notes: string[];
}

export type FontProgress = (message: string) => void;

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const cache = new Map<FontRole, Promise<LoadedFont>>();

async function fetchFont(source: FontSource, onProgress?: FontProgress): Promise<LoadedFont> {
  let response: Response;
  try {
    response = await fetch(source.url);
  } catch (err) {
    throw new FontLoadError(`${source.label}: cannot download ${source.url} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!response.ok) throw new FontLoadError(`${source.label} font file not found (${source.url}, HTTP ${response.status}).`);

  let bytes: ArrayBuffer;
  const total = Number(response.headers.get('content-length')) || null;
  if (response.body && onProgress) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      const mb = (loaded / (1024 * 1024)).toFixed(1);
      onProgress(total ? `Loading font ${source.label}... ${Math.round((loaded / total) * 100)}% (${mb} MB)` : `Loading font ${source.label}... ${mb} MB`);
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bytes = merged.buffer;
  } else {
    bytes = await response.arrayBuffer();
  }

  // A dev server answers a missing public file with index.html (HTTP 200).
  if (bytes.byteLength < 1024 || !isSfnt(bytes)) {
    throw new FontLoadError(`${source.label} font file not found (${source.url} is not a TrueType/OpenType font).`);
  }
  return { role: source.role, label: source.label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

function loadOne(role: FontRole, onProgress?: FontProgress): Promise<LoadedFont> {
  let p = cache.get(role);
  if (!p) {
    p = fetchFont(FONT_SOURCES[role], onProgress).catch((err: unknown) => {
      cache.delete(role); // a missing file may be added later; retry next time
      throw err;
    });
    cache.set(role, p);
  }
  return p;
}

/**
 * Load all four fonts. The fallback font is mandatory; a missing primary font
 * produces a note such as "LXGW WenKai TC font file not found (...)" and that role
 * falls back to Noto Sans TC.
 */
export async function loadFontSet(onProgress?: FontProgress): Promise<FontSetBytes> {
  const fallback = await loadOne('fallback', onProgress);
  const notes: string[] = [];
  const optional = async (role: 'cjk' | 'latin' | 'symbol'): Promise<LoadedFont | null> => {
    try {
      return await loadOne(role, onProgress);
    } catch (err) {
      const source = FONT_SOURCES[role];
      const detail = err instanceof Error ? err.message : String(err);
      const what = role === 'cjk' ? 'Chinese' : role === 'latin' ? 'Latin' : 'symbol';
      notes.push(`${detail} Expected ${FONT_DIR}${source.file}; using the other fonts for ${what} characters.`);
      console.warn(`[fonts] ${detail}`);
      return null;
    }
  };
  const cjk = await optional('cjk');
  const latin = await optional('latin');
  const symbol = await optional('symbol');
  for (const f of [cjk, latin, symbol, fallback]) {
    if (f && !f.subsetSafe) notes.push(`${f.label}: subsetting is not safe for this file, it is embedded whole (larger PDF).`);
  }
  return { cjk, latin, symbol, fallback, notes };
}

// ---------------------------------------------------------------------------
// TrueType inspection
// ---------------------------------------------------------------------------

function isSfnt(bytes: ArrayBuffer): boolean {
  const magic = new DataView(bytes).getUint32(0);
  return magic === 0x00010000 || magic === 0x74727565 /* true */ || magic === 0x4f54544f /* OTTO */;
}

interface TableRecord {
  offset: number;
  length: number;
}

function readTables(view: DataView): Map<string, TableRecord> {
  const tables = new Map<string, TableRecord>();
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > view.byteLength) break;
    const tag = String.fromCharCode(view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3));
    tables.set(tag, { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) });
  }
  return tables;
}

/**
 * True when every glyph in the `glyf` table has an even byte length, which is
 * what the fork's short-offset `loca` writer needs. CFF fonts return false.
 */
export function trueTypeSubsetSafe(bytes: ArrayBuffer): boolean {
  const view = new DataView(bytes);
  if (view.getUint32(0) === 0x4f54544f) return false; // OTTO: CFF outlines
  const tables = readTables(view);
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  if (!head || !maxp || !loca || !tables.has('glyf')) return false;
  const longOffsets = view.getInt16(head.offset + 50) === 1;
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const entrySize = longOffsets ? 4 : 2;
  if (loca.offset + (numGlyphs + 1) * entrySize > view.byteLength) return false;
  let prev = longOffsets ? view.getUint32(loca.offset) : view.getUint16(loca.offset) * 2;
  for (let i = 1; i <= numGlyphs; i++) {
    const at = loca.offset + i * entrySize;
    const off = longOffsets ? view.getUint32(at) : view.getUint16(at) * 2;
    if ((off - prev) % 2 !== 0) return false;
    prev = off;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface EmbeddedFont {
  role: FontRole;
  label: string;
  font: PDFFont;
  charSet: Set<number>;
}

export interface FontSet {
  cjk: EmbeddedFont | null;
  latin: EmbeddedFont | null;
  symbol: EmbeddedFont | null;
  fallback: EmbeddedFont;
  /** e.g. "LXGW WenKai TC + Liberation Serif + Noto Sans Symbols 2 (fallback Noto Sans TC)". */
  label: string;
}

export async function embedFontSet(doc: PDFDocument, bytes: FontSetBytes): Promise<FontSet> {
  doc.registerFontkit(fontkit);
  const embed = async (loaded: LoadedFont): Promise<EmbeddedFont> => {
    try {
      const font = await doc.embedFont(loaded.bytes, { subset: loaded.subsetSafe });
      return { role: loaded.role, label: loaded.label, font, charSet: new Set(font.getCharacterSet()) };
    } catch (err) {
      throw new FontLoadError(`pdf-lib could not embed ${loaded.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const fallback = await embed(bytes.fallback);
  const cjk = bytes.cjk ? await embed(bytes.cjk) : null;
  const latin = bytes.latin ? await embed(bytes.latin) : null;
  const symbol = bytes.symbol ? await embed(bytes.symbol) : null;
  const primaries = [cjk?.label ?? `${fallback.label} (Chinese)`, latin?.label ?? `${fallback.label} (Latin)`];
  if (symbol) primaries.push(symbol.label);
  return { cjk, latin, symbol, fallback, label: `${primaries.join(' + ')} (fallback ${fallback.label})` };
}

// ---------------------------------------------------------------------------
// Mixed-font text
// ---------------------------------------------------------------------------

export interface TextRun {
  text: string;
  font: PDFFont;
  /** True when the run's primary font exists but lacks these glyphs. */
  fallback: boolean;
}

interface Choice {
  font: EmbeddedFont;
  fallback: boolean;
}

export type GlyphClass = 'cjk' | 'latin' | 'symbol';

/**
 * Symbol blocks: arrows, mathematical operators, miscellaneous technical,
 * enclosed alphanumerics, box drawing, geometric shapes, miscellaneous
 * symbols, dingbats, supplemental arrows / math, emoji-range pictographs and
 * the Private Use Area (symbol-font code points that were not normalized).
 * Greek, Latin-1 (± × ÷ ° ² ³), general punctuation (– — ‰ ′) and
 * super/subscripts stay in the Latin class: Liberation Serif draws them in
 * the same style as the surrounding digits.
 */
const SYMBOL_RE = /[\u2190-\u23FF\u2460-\u27BF\u27C0-\u2BFF\uE000-\uF8FF\u{1F000}-\u{1FAFF}]/u;

export function glyphClass(ch: string): GlyphClass {
  if (isCjkChar(ch)) return 'cjk';
  if (SYMBOL_RE.test(ch)) return 'symbol';
  return 'latin';
}

/**
 * Order in which fonts are tried per class. The first entry is the primary
 * font; a glyph drawn with any later font counts as a fallback glyph.
 */
export const FALLBACK_CHAINS: Record<GlyphClass, readonly FontRole[]> = {
  cjk: ['cjk', 'symbol', 'fallback', 'latin'],
  latin: ['latin', 'symbol', 'fallback', 'cjk'],
  // Noto Sans Symbols 2 has no ± ≤ ≥ ≈ ≠ ∞ √ or basic arrows; Liberation Serif does.
  symbol: ['symbol', 'latin', 'fallback', 'cjk'],
};

/**
 * Chooses a font per character and measures / splits strings accordingly.
 * The choice is context-free (it depends only on the character), so the
 * width of a line equals the sum of its tokens' widths, and every width is
 * taken from the font the glyph is finally drawn with: wrapping, fitting and
 * drawing always agree, fallback glyphs included.
 */
export class MixedFont implements TextMeasurer {
  private readonly choiceCache = new Map<string, Choice | null>();
  private readonly widthCache = new Map<string, number>();
  /** Code points already reported by sanitizeForFont (one warning per character per export). */
  readonly unsupported = new Map<string, number>();

  constructor(readonly fonts: FontSet) {}

  private font(role: FontRole): EmbeddedFont | null {
    return this.fonts[role];
  }

  /**
   * selectFontForGlyph: primary font of the character's class if its cmap
   * has the glyph, otherwise the next font of the chain that has it; null
   * when no loaded font has it.
   */
  selectFontForGlyph(ch: string): Choice | null {
    if (this.choiceCache.has(ch)) return this.choiceCache.get(ch) ?? null;
    const cp = ch.codePointAt(0) ?? 0;
    const chain = FALLBACK_CHAINS[glyphClass(ch)];
    const primaryLoaded = this.font(chain[0]) !== null;
    let choice: Choice | null = null;
    for (const [i, role] of chain.entries()) {
      const f = this.font(role);
      if (f && f.charSet.has(cp)) {
        choice = { font: f, fallback: i > 0 && primaryLoaded };
        break;
      }
    }
    this.choiceCache.set(ch, choice);
    return choice;
  }

  /** Labels of the loaded fonts in the order they are tried for `ch`. */
  fontsTried(ch: string): string[] {
    return FALLBACK_CHAINS[glyphClass(ch)].map((r) => this.font(r)?.label).filter((l): l is string => !!l);
  }

  private choose(ch: string): Choice {
    // Characters no font has are replaced by sanitizeForFont() before layout;
    // the fallback font's .notdef only ever measures stray input.
    return this.selectFontForGlyph(ch) ?? { font: this.fonts.fallback, fallback: false };
  }

  /** Any loaded font can draw this code point. */
  hasGlyph(cp: number): boolean {
    return this.selectFontForGlyph(String.fromCodePoint(cp)) !== null;
  }

  runs(text: string): TextRun[] {
    const out: TextRun[] = [];
    for (const ch of text) {
      const { font, fallback } = this.choose(ch);
      const last = out[out.length - 1];
      if (last && last.font === font.font && last.fallback === fallback) last.text += ch;
      else out.push({ text: ch, font: font.font, fallback });
    }
    return out;
  }

  /** Number of characters in `text` that had to use a fallback glyph. */
  fallbackCount(text: string): number {
    let n = 0;
    for (const ch of text) if (this.choose(ch).fallback) n++;
    return n;
  }

  widthOfTextAtSize(text: string, size: number): number {
    const key = `${size}\u0000${text}`;
    const cached = this.widthCache.get(key);
    if (cached !== undefined) return cached;
    let width = 0;
    for (const run of this.runs(text)) width += run.font.widthOfTextAtSize(run.text, size);
    this.widthCache.set(key, width);
    return width;
  }
}

/** ASCII stand-ins for characters PDFs often produce but text fonts often lack. */
const SUBSTITUTES: Record<string, string> = {
  '∗': '*', // U+2217 asterisk operator (math fonts' footnote marker)
  '⁎': '*',
  '−': '-', // U+2212 minus
  '‐': '-', // U+2010 hyphen
  '‑': '-',
  '‒': '-',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬀ': 'ff',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  ' ': ' ',
};

export function codePointLabel(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Replace characters no loaded font can draw: first by an ASCII stand-in
 * (∗ → *, ﬁ → fi), otherwise by □ so they stay visible instead of silently
 * vanishing. drawText therefore never fails mid-render. Every replaced
 * character is reported once per export with its code point and the fonts
 * that were tried, so odd PDF extraction output can be identified.
 */
export function sanitizeForFont(text: string, mixed: MixedFont): { text: string; replaced: number } {
  let replaced = 0;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === ' ' || mixed.hasGlyph(cp)) {
      out += ch;
    } else if (/\s/.test(ch)) {
      out += ' ';
    } else if (SUBSTITUTES[ch] && [...SUBSTITUTES[ch]].every((c) => mixed.hasGlyph(c.codePointAt(0) ?? 0))) {
      out += SUBSTITUTES[ch];
    } else {
      out += FALLBACK_CHAR;
      replaced++;
      const label = codePointLabel(ch);
      const seen = mixed.unsupported.get(label) ?? 0;
      mixed.unsupported.set(label, seen + 1);
      if (seen === 0) {
        console.warn(
          `[Font Fallback Warning]\ncharacter="${ch}"\ncodePoint="${label}"\nfontsTried=${JSON.stringify(mixed.fontsTried(ch))}`,
        );
      }
    }
  }
  return { text: out, replaced };
}
