import { describe, expect, it } from 'vitest';
import { analyzeCompleteness, headContext, joinFragments, joinLines, tailContext } from '../text';

describe('hyphenation repair', () => {
  it('Case 1: set- + tings → settings', () => {
    expect(joinFragments('set-', 'tings')).toBe('settings');
    expect(joinLines(['in different set-', 'tings the model'])).toBe('in different settings the model');
  });

  it('Case 2: reason- + ing → reasoning', () => {
    expect(joinLines(['numerical reason-', 'ing ability'])).toBe('numerical reasoning ability');
    expect(joinLines(['finan-', 'cial statements'])).toBe('financial statements');
  });

  it('Case 3: keeps real hyphenated compounds', () => {
    expect(joinLines(['works out-of-the-box'])).toBe('works out-of-the-box');
    expect(joinFragments('out-of-the-', 'box')).toBe('out-of-the-box');
    expect(joinFragments('state-of-the-', 'art')).toBe('state-of-the-art');
    expect(joinFragments('well-', 'known')).toBe('well-known');
    expect(joinFragments('self-', 'attention')).toBe('self-attention');
    expect(joinFragments('5-', 'year')).toBe('5-year');
    expect(joinFragments('X-', 'ray')).toBe('X-ray');
  });

  it('keeps the hyphen when the next line starts with a capital letter', () => {
    expect(joinFragments('non-', 'Gaussian')).toBe('non-Gaussian');
  });

  it('joins ordinary lines with a space', () => {
    expect(joinLines(['The results are', 'consistent.'])).toBe('The results are consistent.');
  });

  it('collapses whitespace and skips empty lines', () => {
    expect(joinLines(['  a  ', '', ' b '])).toBe('a b');
  });
});

describe('sentence completeness', () => {
  it('accepts sentences ending with terminal punctuation', () => {
    expect(analyzeCompleteness('The model fails.').complete).toBe(true);
    expect(analyzeCompleteness('Does it fail?').complete).toBe(true);
    expect(analyzeCompleteness('We show the following:').complete).toBe(true);
  });

  it('ignores trailing citation markers and quotes', () => {
    expect(analyzeCompleteness('as shown before [12].').complete).toBe(true);
    expect(analyzeCompleteness('as shown before. [12]').complete).toBe(true);
    expect(analyzeCompleteness('as shown before (Smith et al., 2020).').complete).toBe(true);
    expect(analyzeCompleteness('he said “done.”').complete).toBe(true);
  });

  it('Case 4: detects a block cut mid-sentence', () => {
    const r = analyzeCompleteness(
      "for example, the accuracy of OpenAI's premier reasoning model, o1-preview, on basic word",
    );
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('no-terminal-punctuation');
    expect(r.strong).toBe(false);
  });

  it('flags function-word endings as strong signals', () => {
    const r = analyzeCompleteness('The results are consistent with the');
    expect(r.complete).toBe(false);
    expect(r.strong).toBe(true);
    expect(analyzeCompleteness('as reported by').strong).toBe(true);
    expect(analyzeCompleteness('the accuracy is significantly lower when,').strong).toBe(true);
  });

  it('treats abbreviations as continuing the sentence', () => {
    expect(analyzeCompleteness('as shown in prior work, e.g.').complete).toBe(false);
    expect(analyzeCompleteness('Smith et al.').complete).toBe(false);
  });
});

describe('context snippets', () => {
  const long = 'First sentence here. Second sentence follows. Third sentence ends the paragraph.';

  it('tailContext prefers a sentence boundary', () => {
    expect(tailContext(long, 45)).toBe('Third sentence ends the paragraph.');
    expect(tailContext('short', 45)).toBe('short');
  });

  it('headContext prefers a sentence boundary', () => {
    expect(headContext(long, 50)).toBe('First sentence here. Second sentence follows.');
    expect(headContext('short', 45)).toBe('short');
  });
});
