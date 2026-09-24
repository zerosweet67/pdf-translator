/** Deterministic pseudo-translation shared by the benchmark harnesses (no API call). */
import { isCjkChar } from '../fit';

const POOL = '研究結果顯示患者臥床狀態生命最後年期間社區居住老年人特徵比較分析平均標準差性別女男種族教育收入婚姻失智症衰弱慢病症狀焦慮憂鬱日常活動功能限制疼痛聽力視力自評健康觀察數加權缺失差異值計';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic pseudo-translation: numbers / symbols / abbreviations stay, words become CJK of realistic length. */
export function fakeTranslate(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    const keep = /^[\d(),.%±<>=≤≥/:;\[\]\-–—*†‡§¶]+[a-z]?$/i.test(tok) || /^[A-Z][A-Z0-9]{1,5}[,)]?$/.test(tok) || /^\(?[np]\s*=/.test(tok);
    if (keep) {
      out.push(tok);
      continue;
    }
    const letters = tok.replace(/[^A-Za-z]/g, '').length;
    const n = Math.max(1, Math.ceil(letters * 0.55));
    let s = '';
    const h = hash(tok);
    for (let i = 0; i < n; i++) s += POOL[(h + i * 7 + n) % POOL.length];
    if (/,$/.test(tok)) s += '，';
    else if (/[.;:]$/.test(tok)) s += '。';
    const m = /(\([^()]*\))$/.exec(tok);
    if (m && !s.endsWith(m[1])) s += m[1];
    out.push(s);
  }
  // CJK runs join without spaces; keep a space next to Latin / numeric tokens.
  let result = '';
  for (const t of out) {
    if (result && !(isCjkChar(result[result.length - 1]) && isCjkChar(t[0]))) result += ' ';
    result += t;
  }
  return result;
}

