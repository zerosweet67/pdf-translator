import { describe, expect, it } from 'vitest';
import { buildInlineSegments, normalizeInlineSpacing, segmentsToText, splitSuperscriptSegments } from '../inline';

describe('normalizeInlineSpacing', () => {
  // Test 9: Chinese + English + digits mixed inline.
  it('puts exactly one space between Chinese and Latin or digits', () => {
    expect(normalizeInlineSpacing('大型語言模型LLM可以')).toBe('大型語言模型 LLM 可以');
    expect(normalizeInlineSpacing('大型語言模型   LLM   可以')).toBe('大型語言模型 LLM 可以');
    expect(normalizeInlineSpacing('共12週的追蹤')).toBe('共 12 週的追蹤');
  });

  it('removes spaces between Chinese characters', () => {
    expect(normalizeInlineSpacing('照 顧 者 負 擔')).toBe('照顧者負擔');
  });

  it('keeps Chinese punctuation tight', () => {
    expect(normalizeInlineSpacing('研究顯示 ，負擔較高 。')).toBe('研究顯示，負擔較高。');
    expect(normalizeInlineSpacing('（ 見表 1 ）')).toBe('（見表 1）');
  });

  it('keeps ASCII punctuation tight', () => {
    expect(normalizeInlineSpacing('models , tools and ( data )')).toBe('models, tools and (data)');
  });

  it('glues a number to its unit', () => {
    expect(normalizeInlineSpacing('下降 30 %')).toBe('下降 30%');
    expect(normalizeInlineSpacing('攝氏 37 ℃')).toBe('攝氏 37℃');
  });

  it('collapses NBSP and ideographic spaces and trims the ends', () => {
    expect(normalizeInlineSpacing('  照顧者 負擔　較高  ')).toBe('照顧者負擔較高');
  });

  it('leaves a well-formed sentence unchanged', () => {
    const good = '在 2020 年的研究中，LLM 的準確率下降 30%。';
    expect(normalizeInlineSpacing(good)).toBe(good);
  });
});

/** Raised runs as the source reports them, with no identifier in front. */
const marks = (...texts: string[]) => texts.map((text) => ({ text, anchor: '' }));

describe('a repeated exponent', () => {
  // The source raises the same "2" three times; every one of them has to come
  // back raised, and the text between them must not be touched.
  const text = 'np2 = 0.38；F1,16 = 6.75；p = 0.019；np2 = 0.30；F1,16 = 10.23；p = 0.006；np2 = 0.39';

  it('raises every occurrence when the source had one marker per run', () => {
    const segments = buildInlineSegments(text, marks('2', '2', '2'));
    const raised = segments.filter((s) => s.sup);
    expect(raised).toHaveLength(3);
    expect(raised.every((s) => s.text === '2')).toBe(true);
    expect(segmentsToText(segments).replace(/ /g, '')).toBe(text.replace(/ /g, ''));
  });

  it('never raises a digit that belongs to a number', () => {
    // "10.23" carries a 2 as well; it must stay where it is, so every raised
    // run has to follow an "np".
    const segments = buildInlineSegments(text, marks('2', '2', '2'));
    segments.forEach((seg, i) => {
      if (!seg.sup) return;
      expect(segments[i - 1]?.text.endsWith('np'), `raised run ${i} follows ${JSON.stringify(segments[i - 1]?.text.slice(-6))}`).toBe(true);
    });
  });

  it('keeps the space the source had after a raised run', () => {
    const segments = buildInlineSegments('np2 = 0.38', marks('2'));
    expect(segmentsToText(segments)).toBe('np2 = 0.38');
  });

  it('still keeps a citation tight against the punctuation that follows', () => {
    expect(segmentsToText(buildInlineSegments('among family caregivers.62, and the rest', marks('62')))).toBe('among family caregivers.62, and the rest');
  });
});

describe('splitSuperscriptSegments', () => {
  // Test 4: a compound citation survives as one raised run.
  it('keeps a compound citation whole', () => {
    const segments = splitSuperscriptSegments('負擔較高16,27-29。', ['16,27-29']);
    expect(segments).toEqual([
      { text: '負擔較高', sup: false },
      { text: '16,27-29', sup: true },
      { text: '。', sup: false },
    ]);
  });

  it('raises single numbers, lists and ranges', () => {
    for (const marker of ['68', '57,58', '27-29']) {
      const segments = splitSuperscriptSegments(`家庭照顧者${marker}`, [marker]);
      expect(segments.filter((s) => s.sup).map((s) => s.text)).toEqual([marker]);
    }
  });

  it('raises every occurrence of the markers the source had', () => {
    const segments = splitSuperscriptSegments('前段62，後段16,27-29。', ['62', '16,27-29']);
    expect(segments.filter((s) => s.sup).map((s) => s.text)).toEqual(['62', '16,27-29']);
  });

  it('raises a citation that follows the full stop of its own sentence', () => {
    const segments = splitSuperscriptSegments('包括失智症。1-4 與全國趨勢一致', ['1-4']);
    expect(segments.filter((s) => s.sup).map((s) => s.text)).toEqual(['1-4']);
    expect(splitSuperscriptSegments('including dementia.1-4 Aligned with', ['1-4']).filter((s) => s.sup)).toHaveLength(1);
  });

  it('does not raise a number that is part of a longer number or a decimal', () => {
    const segments = splitSuperscriptSegments('數值為 0.62 與 622。', ['62']);
    expect(segments.filter((s) => s.sup)).toEqual([]);
  });

  it('returns the text untouched when there are no markers', () => {
    expect(splitSuperscriptSegments('一般段落。', [])).toEqual([{ text: '一般段落。', sup: false }]);
  });
});

describe('buildInlineSegments', () => {
  // Test 5: the marker digits are never rewritten by the typography pass.
  it('keeps the citation digits exactly as the source had them', () => {
    const segments = buildInlineSegments('研究指出家庭照顧者的負擔較高16,27-29。', marks('16,27-29'));
    const raised = segments.filter((s) => s.sup);
    expect(raised).toHaveLength(1);
    expect(raised[0].text).toBe('16,27-29');
    expect(segmentsToText(segments)).toContain('16,27-29');
  });

  // Test 6: no space is inserted in front of a citation marker.
  it('never inserts a space before a marker, whatever the model produced', () => {
    for (const translated of ['負擔較高 62。', '負擔較高62。', '負擔較高  62 。']) {
      const segments = buildInlineSegments(translated, marks('62'));
      const index = segments.findIndex((s) => s.sup);
      expect(index).toBeGreaterThan(0);
      expect(segments[index - 1].text.endsWith(' ')).toBe(false);
    }
  });

  it('keeps one space when Latin text continues after a marker', () => {
    const segments = buildInlineSegments('burden62 and other factors', marks('62'));
    const index = segments.findIndex((s) => s.sup);
    expect(segments[index + 1].text.startsWith(' ')).toBe(true);
  });

  it('puts back a trailing marker the model dropped', () => {
    const segments = buildInlineSegments('在家庭照顧者之間。', marks('62'), '62');
    const last = segments[segments.length - 1];
    expect(last).toEqual({ text: '62', sup: true });
  });

  it('does not duplicate a trailing marker the model kept', () => {
    const segments = buildInlineSegments('在家庭照顧者之間。62', marks('62'), '62');
    expect(segments.filter((s) => s.sup)).toHaveLength(1);
  });

  it('normalizes the ordinary runs while leaving markers alone', () => {
    const segments = buildInlineSegments('照 顧 者LLM負擔較高62 。', marks('62'));
    expect(segmentsToText(segments)).toBe('照顧者 LLM 負擔較高62。');
  });
});
