/**
 * Glyph coverage of the shipped fonts (web/public/fonts) through the real
 * embed + MixedFont path. Set FONTCHECK_OUT=path.pdf to also write the test
 * page for visual inspection.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { fitTextToBox } from '../fit';
import {
  FALLBACK_CHAR,
  embedFontSet,
  glyphClass,
  MixedFont,
  sanitizeForFont,
  trueTypeSubsetSafe,
  type FontRole,
  type FontSet,
  type LoadedFont,
} from '../font';

function load(role: FontRole, label: string, file: string): LoadedFont {
  const buf = readFileSync(`public/fonts/${file}`);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { role, label, bytes, subsetSafe: trueTypeSubsetSafe(bytes) };
}

const LINES = [
  '慢性肺病患者的呼吸困難',
  'F2F NF ExT EET SD CI COPD ILD SpO2 o1-preview',
  '7.2±9.1 95% 30–40% p<0.001',
  '± − – — ≤ ≥ < > × ÷ ≈ ≠ ∞ √ ° % ‰ α β γ Δ ² ³ ⁻ ₁ ₂ → ← ↑ ↓',
  '() [] {} 〈〉 《》 「」 『』',
  '平均±標準差（mean±SD）為 7.2±9.1，95% CI [3.0, 13.6]，ΔV̇O₂ ≥ 30%。',
];

let doc: PDFDocument;
let fonts: FontSet;
let mixed: MixedFont;

beforeAll(async () => {
  const bytes = {
    cjk: load('cjk', 'LXGW WenKai TC', 'LXGWWenKaiTC-Regular.ttf'),
    latin: load('latin', 'Liberation Serif', 'LiberationSerif-Regular.ttf'),
    symbol: load('symbol', 'Noto Sans Symbols 2', 'NotoSansSymbols2-Regular.ttf'),
    fallback: load('fallback', 'Noto Sans TC', 'NotoSansTC-Regular.ttf'),
    notes: [],
  };
  doc = await PDFDocument.create();
  fonts = await embedFontSet(doc, bytes);
  mixed = new MixedFont(fonts);
}, 30_000);

describe('glyph coverage and fallback', () => {
  it('ships subset-safe font files', () => {
    for (const f of [fonts.cjk, fonts.latin, fonts.symbol, fonts.fallback]) expect(f).not.toBeNull();
  });

  it('draws every test character with a real glyph (no □)', () => {
    for (const line of LINES) {
      const { text, replaced } = sanitizeForFont(line, mixed);
      expect(replaced, line).toBe(0);
      expect(text.includes(FALLBACK_CHAR), line).toBe(false);
    }
  });

  it('selects the primary font per class and falls back by cmap', () => {
    const labelOf = (ch: string) => mixed.selectFontForGlyph(ch)?.font.label;
    expect(labelOf('肺')).toBe('LXGW WenKai TC');
    expect(labelOf('（')).toBe('LXGW WenKai TC');
    expect(labelOf('F')).toBe('Liberation Serif');
    expect(labelOf('±')).toBe('Liberation Serif');
    expect(labelOf('α')).toBe('Liberation Serif');
    expect(glyphClass('≥')).toBe('symbol');
    expect(labelOf('≥')).toBe('Liberation Serif'); // Symbols 2 has no ≥ → next in chain
    expect(labelOf('⋅')).toBe('Noto Sans Symbols 2'); // symbol-class primary
    expect(labelOf('⁻')).toBe('LXGW WenKai TC'); // only WenKai has U+207B
    expect(mixed.selectFontForGlyph('⁻')?.fallback).toBe(true);
  });

  it('measures with the font each glyph is drawn with', () => {
    for (const line of LINES) {
      expect(() => mixed.widthOfTextAtSize(line, 10)).not.toThrow();
      const sum = mixed.runs(line).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, 10), 0);
      expect(mixed.widthOfTextAtSize(line, 10)).toBeCloseTo(sum, 6);
    }
    // fallback glyph: measured with WenKai, not with Liberation's .notdef
    expect(mixed.widthOfTextAtSize('⁻', 10)).toBeCloseTo(fonts.cjk!.font.widthOfTextAtSize('⁻', 10), 6);
  });

  it('replaces characters no font has and reports the code point', () => {
    const { text, replaced } = sanitizeForFont(`CI ${String.fromCharCode(0xf05b)}3.0${String.fromCharCode(0xf05d)}`, mixed);
    expect(replaced).toBe(2);
    expect(text).toBe('CI □3.0□');
    expect(mixed.unsupported.get('U+F05B')).toBe(1);
    expect(mixed.fontsTried(String.fromCharCode(0xf05b))).toEqual([
      'Noto Sans Symbols 2',
      'Liberation Serif',
      'Noto Sans TC',
      'LXGW WenKai TC',
    ]);
  });

  it('wraps, draws and saves a PDF with all test lines', async () => {
    const page = doc.addPage([460, 320]);
    let y = 290;
    for (const line of LINES) {
      const fit = fitTextToBox({ text: sanitizeForFont(line, mixed).text, width: 420, height: 40, originalFontSize: 12, font: mixed });
      for (const l of fit.lines) {
        let x = 20;
        for (const run of mixed.runs(l)) {
          page.drawText(run.text, { x, y, size: fit.fontSize, font: run.font });
          x += run.font.widthOfTextAtSize(run.text, fit.fontSize);
        }
        expect(x - 20).toBeLessThanOrEqual(420.01);
        y -= fit.lineHeight;
      }
      y -= 8;
    }
    const bytes = await doc.save();
    expect(bytes.length).toBeGreaterThan(1000);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
    if (process.env.FONTCHECK_OUT) writeFileSync(process.env.FONTCHECK_OUT, bytes);
  }, 30_000);
});
