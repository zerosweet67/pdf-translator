/**
 * Symbol-font Private Use Area normalization.
 *
 * Fonts with the (Adobe) Symbol encoding (Symbol, SymbolMT) often have no
 * ToUnicode map. PDF.js then reports their glyphs at U+F000 + code, e.g.
 * U+F05B / U+F05D for the brackets in "95% CI [3.0, 13.6]", U+F044 for Δ,
 * U+F061 for α and U+F0B1 for ±. No text font has glyphs there, so they used
 * to be drawn as □ and the translator saw garbage.
 *
 * The mapping is applied ONLY when the item's real font name is a Symbol font
 * (see isSymbolEncodedFont): for any other font (Wingdings, custom icon
 * fonts, unresolved names) the same code point means something else, so the
 * character is left as is and later reported by the font fallback warning.
 *
 * SYMBOL_ENCODING is generated from PDF.js' SymbolSetEncoding + glyph list
 * (pdfjs-dist 5, build/pdf.worker.mjs), except Delta, Omega and mu, which
 * map to the Greek letters U+0394 / U+03A9 / U+03BC instead of ∆ INCREMENT /
 * Ω OHM SIGN / µ MICRO SIGN (the Symbol font draws Greek letters there).
 * Entries whose glyph has no standard Unicode value (bracket and radical
 * extension pieces, Apple logo) are deliberately missing.
 */

/** Symbol encoding byte → Unicode code point. */
const SYMBOL_ENCODING: ReadonlyMap<number, number> = new Map([
  [0x21, 0x0021], // exclam !
  [0x22, 0x2200], // universal ∀
  [0x23, 0x0023], // numbersign #
  [0x24, 0x2203], // existential ∃
  [0x25, 0x0025], // percent %
  [0x26, 0x0026], // ampersand &
  [0x27, 0x220b], // suchthat ∋
  [0x28, 0x0028], // parenleft (
  [0x29, 0x0029], // parenright )
  [0x2a, 0x2217], // asteriskmath ∗
  [0x2b, 0x002b], // plus +
  [0x2c, 0x002c], // comma ,
  [0x2d, 0x2212], // minus −
  [0x2e, 0x002e], // period .
  [0x2f, 0x002f], // slash /
  [0x30, 0x0030], // zero 0
  [0x31, 0x0031], // one 1
  [0x32, 0x0032], // two 2
  [0x33, 0x0033], // three 3
  [0x34, 0x0034], // four 4
  [0x35, 0x0035], // five 5
  [0x36, 0x0036], // six 6
  [0x37, 0x0037], // seven 7
  [0x38, 0x0038], // eight 8
  [0x39, 0x0039], // nine 9
  [0x3a, 0x003a], // colon :
  [0x3b, 0x003b], // semicolon ;
  [0x3c, 0x003c], // less <
  [0x3d, 0x003d], // equal =
  [0x3e, 0x003e], // greater >
  [0x3f, 0x003f], // question ?
  [0x40, 0x2245], // congruent ≅
  [0x41, 0x0391], // Alpha Α
  [0x42, 0x0392], // Beta Β
  [0x43, 0x03a7], // Chi Χ
  [0x44, 0x0394], // Delta Δ
  [0x45, 0x0395], // Epsilon Ε
  [0x46, 0x03a6], // Phi Φ
  [0x47, 0x0393], // Gamma Γ
  [0x48, 0x0397], // Eta Η
  [0x49, 0x0399], // Iota Ι
  [0x4a, 0x03d1], // theta1 ϑ
  [0x4b, 0x039a], // Kappa Κ
  [0x4c, 0x039b], // Lambda Λ
  [0x4d, 0x039c], // Mu Μ
  [0x4e, 0x039d], // Nu Ν
  [0x4f, 0x039f], // Omicron Ο
  [0x50, 0x03a0], // Pi Π
  [0x51, 0x0398], // Theta Θ
  [0x52, 0x03a1], // Rho Ρ
  [0x53, 0x03a3], // Sigma Σ
  [0x54, 0x03a4], // Tau Τ
  [0x55, 0x03a5], // Upsilon Υ
  [0x56, 0x03c2], // sigma1 ς
  [0x57, 0x03a9], // Omega Ω
  [0x58, 0x039e], // Xi Ξ
  [0x59, 0x03a8], // Psi Ψ
  [0x5a, 0x0396], // Zeta Ζ
  [0x5b, 0x005b], // bracketleft [
  [0x5c, 0x2234], // therefore ∴
  [0x5d, 0x005d], // bracketright ]
  [0x5e, 0x22a5], // perpendicular ⊥
  [0x5f, 0x005f], // underscore _
  [0x61, 0x03b1], // alpha α
  [0x62, 0x03b2], // beta β
  [0x63, 0x03c7], // chi χ
  [0x64, 0x03b4], // delta δ
  [0x65, 0x03b5], // epsilon ε
  [0x66, 0x03c6], // phi φ
  [0x67, 0x03b3], // gamma γ
  [0x68, 0x03b7], // eta η
  [0x69, 0x03b9], // iota ι
  [0x6a, 0x03d5], // phi1 ϕ
  [0x6b, 0x03ba], // kappa κ
  [0x6c, 0x03bb], // lambda λ
  [0x6d, 0x03bc], // mu μ
  [0x6e, 0x03bd], // nu ν
  [0x6f, 0x03bf], // omicron ο
  [0x70, 0x03c0], // pi π
  [0x71, 0x03b8], // theta θ
  [0x72, 0x03c1], // rho ρ
  [0x73, 0x03c3], // sigma σ
  [0x74, 0x03c4], // tau τ
  [0x75, 0x03c5], // upsilon υ
  [0x76, 0x03d6], // omega1 ϖ
  [0x77, 0x03c9], // omega ω
  [0x78, 0x03be], // xi ξ
  [0x79, 0x03c8], // psi ψ
  [0x7a, 0x03b6], // zeta ζ
  [0x7b, 0x007b], // braceleft {
  [0x7c, 0x007c], // bar |
  [0x7d, 0x007d], // braceright }
  [0x7e, 0x223c], // similar ∼
  [0xa0, 0x20ac], // Euro €
  [0xa1, 0x03d2], // Upsilon1 ϒ
  [0xa2, 0x2032], // minute ′
  [0xa3, 0x2264], // lessequal ≤
  [0xa4, 0x2044], // fraction ⁄
  [0xa5, 0x221e], // infinity ∞
  [0xa6, 0x0192], // florin ƒ
  [0xa7, 0x2663], // club ♣
  [0xa8, 0x2666], // diamond ♦
  [0xa9, 0x2665], // heart ♥
  [0xaa, 0x2660], // spade ♠
  [0xab, 0x2194], // arrowboth ↔
  [0xac, 0x2190], // arrowleft ←
  [0xad, 0x2191], // arrowup ↑
  [0xae, 0x2192], // arrowright →
  [0xaf, 0x2193], // arrowdown ↓
  [0xb0, 0x00b0], // degree °
  [0xb1, 0x00b1], // plusminus ±
  [0xb2, 0x2033], // second ″
  [0xb3, 0x2265], // greaterequal ≥
  [0xb4, 0x00d7], // multiply ×
  [0xb5, 0x221d], // proportional ∝
  [0xb6, 0x2202], // partialdiff ∂
  [0xb7, 0x2022], // bullet •
  [0xb8, 0x00f7], // divide ÷
  [0xb9, 0x2260], // notequal ≠
  [0xba, 0x2261], // equivalence ≡
  [0xbb, 0x2248], // approxequal ≈
  [0xbc, 0x2026], // ellipsis …
  [0xbf, 0x21b5], // carriagereturn ↵
  [0xc0, 0x2135], // aleph ℵ
  [0xc1, 0x2111], // Ifraktur ℑ
  [0xc2, 0x211c], // Rfraktur ℜ
  [0xc3, 0x2118], // weierstrass ℘
  [0xc4, 0x2297], // circlemultiply ⊗
  [0xc5, 0x2295], // circleplus ⊕
  [0xc6, 0x2205], // emptyset ∅
  [0xc7, 0x2229], // intersection ∩
  [0xc8, 0x222a], // union ∪
  [0xc9, 0x2283], // propersuperset ⊃
  [0xca, 0x2287], // reflexsuperset ⊇
  [0xcb, 0x2284], // notsubset ⊄
  [0xcc, 0x2282], // propersubset ⊂
  [0xcd, 0x2286], // reflexsubset ⊆
  [0xce, 0x2208], // element ∈
  [0xcf, 0x2209], // notelement ∉
  [0xd0, 0x2220], // angle ∠
  [0xd1, 0x2207], // gradient ∇
  [0xd5, 0x220f], // product ∏
  [0xd6, 0x221a], // radical √
  [0xd7, 0x22c5], // dotmath ⋅
  [0xd8, 0x00ac], // logicalnot ¬
  [0xd9, 0x2227], // logicaland ∧
  [0xda, 0x2228], // logicalor ∨
  [0xdb, 0x21d4], // arrowdblboth ⇔
  [0xdc, 0x21d0], // arrowdblleft ⇐
  [0xdd, 0x21d1], // arrowdblup ⇑
  [0xde, 0x21d2], // arrowdblright ⇒
  [0xdf, 0x21d3], // arrowdbldown ⇓
  [0xe0, 0x25ca], // lozenge ◊
  [0xe1, 0x2329], // angleleft 〈
  [0xe5, 0x2211], // summation ∑
  [0xf1, 0x232a], // angleright 〉
  [0xf2, 0x222b], // integral ∫
  [0xf3, 0x2320], // integraltp ⌠
  [0xf5, 0x2321], // integralbt ⌡
]);

/** "AAAAAT+SymbolMT", "Symbol", "SymbolMT,Bold" → true; "Wingdings", "SymbolNeu"… → false. */
export function isSymbolEncodedFont(realName: string | null | undefined): boolean {
  if (!realName) return false;
  const name = realName.replace(/^[A-Z]{6}\+/, '');
  return /^Symbol(MT|PS)?([,-].*)?$/i.test(name);
}

export interface SymbolNormalization {
  text: string;
  /** Characters that were converted. */
  mapped: number;
}

/**
 * Convert Symbol-font code points (U+F020–U+F0FF) to Unicode. Returns the
 * input unchanged unless `realFontName` is a Symbol font; code points without
 * a reliable mapping are kept.
 */
export function normalizeSymbolFontText(text: string, realFontName: string | null | undefined): SymbolNormalization {
  if (!isSymbolEncodedFont(realFontName) || !/[\uF020-\uF0FF]/.test(text)) return { text, mapped: 0 };
  let mapped = 0;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const target = cp >= 0xf020 && cp <= 0xf0ff ? SYMBOL_ENCODING.get(cp - 0xf000) : undefined;
    if (target !== undefined) {
      out += String.fromCodePoint(target);
      mapped++;
    } else {
      out += ch;
    }
  }
  return { text: out, mapped };
}
