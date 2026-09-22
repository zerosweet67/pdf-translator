import { describe, expect, it } from 'vitest';
import { isSymbolEncodedFont, normalizeSymbolFontText } from '../symbols';

const pua = (code: number) => String.fromCharCode(0xf000 + code);

describe('Symbol-font private-use normalization', () => {
  it('maps the SymbolMT code points found in the medical sample PDF', () => {
    const font = 'AAAABS+SymbolMT';
    expect(normalizeSymbolFontText(`95% CI ${pua(0x5b)}3.0, 13.6${pua(0x5d)}`, font)).toEqual({ text: '95% CI [3.0, 13.6]', mapped: 2 });
    expect(normalizeSymbolFontText(pua(0x44), font).text).toBe('Δ'); // Delta → Greek capital, not U+2206
    expect(normalizeSymbolFontText(pua(0x61) + pua(0x62), font).text).toBe('αβ');
    expect(normalizeSymbolFontText(`7.2${pua(0xb1)}9.1`, font).text).toBe('7.2±9.1');
    expect(normalizeSymbolFontText(`${pua(0xb3)}40 years`, font).text).toBe('≥40 years');
    expect(normalizeSymbolFontText(pua(0xb7), font).text).toBe('•');
  });

  it('maps other standard Symbol-encoding glyphs', () => {
    const font = 'Symbol';
    expect(normalizeSymbolFontText([0xa3, 0xb4, 0xb8, 0xbb, 0xb9, 0xa5, 0xd6, 0xb0, 0xae, 0x6d, 0x57].map(pua).join(''), font).text).toBe(
      '≤×÷≈≠∞√°→μΩ',
    );
  });

  it('does not guess for other fonts or unmapped code points', () => {
    expect(normalizeSymbolFontText(pua(0x5b), 'Wingdings-Regular')).toEqual({ text: pua(0x5b), mapped: 0 });
    expect(normalizeSymbolFontText(pua(0x5b), null)).toEqual({ text: pua(0x5b), mapped: 0 });
    expect(normalizeSymbolFontText(pua(0x5b), 'g_d0_f14')).toEqual({ text: pua(0x5b), mapped: 0 });
    // bracket extension piece (no standard Unicode value) stays as is
    expect(normalizeSymbolFontText(pua(0xe9), 'SymbolMT').text).toBe(pua(0xe9));
    expect(normalizeSymbolFontText('plain text', 'SymbolMT')).toEqual({ text: 'plain text', mapped: 0 });
  });

  it('recognizes Symbol font names', () => {
    expect(isSymbolEncodedFont('AAAAAT+SymbolMT')).toBe(true);
    expect(isSymbolEncodedFont('Symbol')).toBe(true);
    expect(isSymbolEncodedFont('SymbolMT,Bold')).toBe(true);
    expect(isSymbolEncodedFont('SymbolNeu')).toBe(false);
    expect(isSymbolEncodedFont('TimesNewRomanPS-BoldMT')).toBe(false);
  });
});
