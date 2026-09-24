import { describe, expect, it } from 'vitest';
import type { WorkerUsage } from '../client';
import { JobUsage, formatSeconds, formatTokens, formatUsageBreakdown } from '../usage';

function usage(input: number, output: number, cached = 0, reasoning = 0): WorkerUsage {
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningTokens: reasoning };
}

describe('JobUsage', () => {
  it('starts at zero', () => {
    const job = new JobUsage();
    expect(job.hasUsage).toBe(false);
    expect(job.totals()).toEqual({
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalProcessedTokens: 0,
    });
  });

  it('sums the three stages into the job totals', () => {
    const job = new JobUsage();
    job.add('terminology', usage(300, 60, 0, 20), 900);
    job.add('translation', usage(5000, 2000, 1200, 400), 30_000);
    job.add('qa', usage(700, 150, 100, 50), 4000);

    expect(job.totals()).toEqual({
      totalInputTokens: 6000,
      totalCachedInputTokens: 1300,
      totalOutputTokens: 2210,
      totalReasoningTokens: 470,
      totalProcessedTokens: 8210,
    });
    const snapshot = job.snapshot();
    expect(snapshot.totalDurationMs).toBe(34_900);
    expect(snapshot.complete).toBe(true);
  });

  it('counts cached input and reasoning tokens as subsets, never added on top', () => {
    const job = new JobUsage();
    // Everything cached and everything reasoning: the totals must not double count.
    job.add('translation', usage(1000, 500, 1000, 500), 10);
    const t = job.totals();
    expect(t.totalProcessedTokens).toBe(1500);
    expect(t.totalProcessedTokens).toBe(t.totalInputTokens + t.totalOutputTokens);
    expect(job.stage('translation').processedTokens).toBe(1500);
  });

  it('accumulates repeated calls of one stage (batches, retries, a second run)', () => {
    const job = new JobUsage();
    job.add('translation', usage(100, 40, 10, 5), 1000); // first batch
    job.add('translation', usage(80, 30, 0, 5), 800); // retry of missing ids
    job.add('translation', usage(200, 60, 20, 10), 2000); // full run after a test run

    expect(job.stage('translation')).toEqual({
      inputTokens: 380,
      cachedInputTokens: 30,
      outputTokens: 130,
      reasoningTokens: 20,
      processedTokens: 510,
      reported: true,
      durationMs: 3800,
    });
    expect(job.totals().totalProcessedTokens).toBe(510);
  });

  it('records time but no tokens when a stage reports no usage', () => {
    const job = new JobUsage();
    job.add('terminology', null, 1200);
    job.add('translation', usage(100, 50), 2000);

    const snapshot = job.snapshot();
    expect(snapshot.terminology.reported).toBe(false);
    expect(snapshot.terminology.durationMs).toBe(1200);
    expect(snapshot.totalProcessedTokens).toBe(150); // nothing estimated for terminology
    expect(snapshot.complete).toBe(false);
    expect(job.hasUsage).toBe(true);
  });

  it('marks a stage reported again once any of its calls returns usage', () => {
    const job = new JobUsage();
    job.add('qa', null, 500);
    expect(job.snapshot().complete).toBe(false);
    job.add('qa', usage(10, 5), 500);
    expect(job.snapshot().complete).toBe(true);
    expect(job.stage('qa').durationMs).toBe(1000);
  });

  it('ignores stages that never ran', () => {
    const job = new JobUsage();
    job.add('translation', usage(10, 5), 100);
    const snapshot = job.snapshot();
    expect(snapshot.terminology.durationMs).toBe(0);
    expect(snapshot.qa.reported).toBe(false);
    expect(snapshot.complete).toBe(true); // a stage that did not run does not make the job incomplete
  });

  it('snapshots are detached copies', () => {
    const job = new JobUsage();
    job.add('qa', usage(10, 5), 10);
    const snapshot = job.snapshot();
    job.add('qa', usage(10, 5), 10);
    expect(snapshot.qa.inputTokens).toBe(10);
    expect(job.stage('qa').inputTokens).toBe(20);
  });
});

describe('formatting', () => {
  it('groups thousands and rounds seconds', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
    expect(formatSeconds(42_350)).toBe('42.4');
  });

  it('breaks the job down per stage with the job totals', () => {
    const job = new JobUsage();
    job.add('terminology', usage(300, 60, 0, 20), 900);
    job.add('translation', usage(5000, 2000, 1200, 400), 30_000);
    job.add('qa', usage(700, 150, 100, 50), 4000);
    const text = formatUsageBreakdown(job.snapshot()).join('\n');

    expect(text).toContain('Terminology:');
    expect(text).toContain('Translation:');
    expect(text).toContain('QA:');
    expect(text).toContain('totalInputTokens');
    expect(text).toContain('6,000');
    expect(text).toContain('totalProcessedTokens');
    expect(text).toContain('8,210');
    expect(text).not.toContain('usage not reported');
  });

  it('flags a stage whose provider reported no usage', () => {
    const job = new JobUsage();
    job.add('terminology', null, 900);
    job.add('translation', usage(100, 50), 1000);
    const text = formatUsageBreakdown(job.snapshot()).join('\n');
    expect(text).toContain('usage not reported by the provider');
    expect(text).toContain('under-count');
  });
});
