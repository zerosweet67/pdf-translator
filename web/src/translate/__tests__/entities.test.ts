import { describe, expect, it } from 'vitest';
import { compareNumeric, extractNumericSignature, missingSymbols } from '../entities';

describe('compareNumeric', () => {
  it('passes when the numbers are the same', () => {
    const r = compareNumeric(
      'The 42 participants (n = 42) improved by 12.4% after 12 weeks (3.5 L/min, 5.2 ± 1.1, 95% CI 1.2 to 3.4, p = 0.03).',
      '42 位參與者（n = 42）在 12 週後改善了 12.4%（3.5 L/min，5.2 ± 1.1，95% CI 1.2 至 3.4，p = 0.03）。',
    );
    expect(r).toEqual({ ok: true, missing: [], added: [] });
  });

  it('ignores whitespace, full-width and thousands-separator differences', () => {
    expect(compareNumeric('95% CI, p=0.03, 5.2±1.1, 1,234 cases', '95 % CI，p = 0.03，5.2 ± 1.1，１２３４ 例').ok).toBe(true);
    expect(compareNumeric('p < .05 and 12 percent', 'p < 0.05 且 12%').ok).toBe(true);
  });

  it('detects a changed decimal', () => {
    const r = compareNumeric('p = 0.03', 'p = 0.3');
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('0.03');
    expect(r.added).toContain('0.3');
    expect(r.missing).toContain('p=0.03');
  });

  it('detects a changed percentage', () => {
    const r = compareNumeric('improved by 12.4%', '改善了 12.5%');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['12.4%']);
    expect(r.added).toEqual(['12.5%']);
    expect(compareNumeric('improved by 12.4%', '改善了 12.4').ok).toBe(false); // lost the percent sign
  });

  it('detects a changed n =', () => {
    const r = compareNumeric('n = 42', 'n = 24');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['42', 'n=42']));
    expect(r.added).toEqual(expect.arrayContaining(['24', 'n=24']));
  });

  it('treats - and – ranges as equal', () => {
    expect(compareNumeric('10–15 breaths, 3-5 days', '10-15 次呼吸，3–5 天').ok).toBe(true);
    expect(compareNumeric('10–15 breaths', '10 至 15 次呼吸').ok).toBe(true);
    expect(compareNumeric('10–15 breaths', '10–16 次呼吸').ok).toBe(false);
  });

  it('detects a changed ± value', () => {
    const r = compareNumeric('5.2 ± 1.1', '5.2 ± 1.2');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['1.1', '5.2±1.1']));
    expect(r.added).toEqual(expect.arrayContaining(['1.2', '5.2±1.2']));
  });

  it('detects a lost number, an added number and a sign change', () => {
    expect(compareNumeric('42 patients and 12 weeks', '42 位病人').missing).toEqual(['12']);
    expect(compareNumeric('42 patients', '42 位病人，12 週').added).toEqual(['12']);
    const sign = compareNumeric('a change of −0.5', '變化為 0.5');
    expect(sign.missing).toEqual(['-0.5']);
    expect(sign.added).toEqual(['0.5']);
  });

  it('tolerates number words, months, roman numerals, Chinese numerals and magnitude words', () => {
    expect(compareNumeric('three groups in December, phase II', '3 組於 12 月，第 2 期').ok).toBe(true);
    expect(compareNumeric('2 groups', '兩組').ok).toBe(true);
    expect(compareNumeric('a 410 million parameter model needs 8.2 billion tokens', '4.10 億參數的模型需要 82 億個詞元').ok).toBe(true);
    expect(compareNumeric('3–10 billion parameters', '30–100 億個參數').ok).toBe(true);
    expect(compareNumeric('firm-years.3 From each', '樣本。3 本文自各').ok).toBe(true); // footnote marker
  });

  it('extracts a normalized signature', () => {
    expect(extractNumericSignature('p<0.05, n=30, 12.4%, 10–15, −2.5, 1,000, .05')).toEqual({
      numbers: ['-2.5', '0.05', '0.05', '10', '1000', '12.4%', '15', '30'],
      stats: ['n=30', 'p<0.05'],
    });
  });
});

describe('missingSymbols', () => {
  it('reports symbols of the source that the translation lost', () => {
    expect(missingSymbols('ΔFEV1 ≥ 5% and 3 μg', 'ΔFEV1 ≥ 5% 與 3 µg')).toEqual([]);
    expect(missingSymbols('ΔFEV1 ≥ 5%', 'FEV1 變化大於 5%')).toEqual(['Δ', '≥']);
  });
});
