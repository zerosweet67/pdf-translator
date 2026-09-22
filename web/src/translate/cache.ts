/**
 * In-memory translation cache: (target language, normalized text) → translation.
 * Lives for the page session only, so repeated labels inside one PDF
 * ("Figure", "Baseline", "Results", table headers, questionnaire items) and
 * a re-run on the same file cost no API call. IndexedDB may replace it later.
 */

/**
 * Cache key normalization: trim, collapse runs of whitespace (including
 * Unicode spaces such as U+00A0 and U+3000) to one space. Nothing else:
 * case, punctuation and citations stay, so different text never collides.
 */
export function normalizeCacheText(text: string): string {
  return text.replace(/[\s   -​  　﻿]+/g, ' ').trim();
}

export class TranslationCache {
  private readonly map = new Map<string, string>();
  private hitCount = 0;

  private key(text: string, targetLanguage: string): string {
    return `${targetLanguage}\u0000${normalizeCacheText(text)}`;
  }

  get(text: string, targetLanguage: string): string | undefined {
    const hit = this.map.get(this.key(text, targetLanguage));
    if (hit !== undefined) this.hitCount++;
    return hit;
  }

  set(text: string, targetLanguage: string, translation: string): void {
    this.map.set(this.key(text, targetLanguage), translation);
  }

  get size(): number {
    return this.map.size;
  }

  /** Lookups served from the cache since it was created / cleared. */
  get hits(): number {
    return this.hitCount;
  }

  clear(): void {
    this.map.clear();
    this.hitCount = 0;
  }
}
