/**
 * Per-job token accounting.
 *
 * One job = one translation run of one PDF: the file was picked and 開始翻譯
 * (User Mode) or Translate Full PDF (Developer Mode) started a scope run.
 * `JobUsage` accumulates the provider's *actual* usage (never an estimate) of
 * every call that run makes, split into the three stages that spend tokens:
 *
 *   terminology → translation → QA
 *
 * Everything inside a stage adds up: batches, the client's retries and the
 * Worker's own missing-id retry. A new file and every new scope run reset the
 * counters (main.ts creates a fresh JobUsage in startJob()), so translating
 * chapter A and then chapter B of the same PDF reports each run on its own;
 * a Developer Mode test run adds to the counters until the next full run.
 *
 * Subset rule, applied everywhere in this file:
 *   cachedInputTokens ⊆ inputTokens   (cache reads are input tokens)
 *   reasoningTokens   ⊆ outputTokens  (reasoning is billed as output)
 * so neither is ever added on top:
 *   totalProcessedTokens = totalInputTokens + totalOutputTokens
 */

import type { WorkerUsage } from './client';

export type UsageStage = 'terminology' | 'translation' | 'qa';

export const USAGE_STAGES: readonly UsageStage[] = ['terminology', 'translation', 'qa'];

/** Running total of one stage. `reported` stays false while no call returned usage. */
export interface StageUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Input + output of this stage (cached / reasoning are subsets, not added). */
  processedTokens: number;
  /** True once at least one call of this stage reported actual usage. */
  reported: boolean;
  /** Wall-clock time spent in this stage, summed over the job's runs. */
  durationMs: number;
}

export interface JobUsageTotals {
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  /** totalInputTokens + totalOutputTokens. */
  totalProcessedTokens: number;
}

export interface JobUsageSnapshot extends JobUsageTotals {
  terminology: StageUsage;
  translation: StageUsage;
  qa: StageUsage;
  /** True when every stage that ran reported actual usage. */
  complete: boolean;
  /** Terminology + translation + QA time of this job. */
  totalDurationMs: number;
}

function emptyStage(): StageUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens: 0,
    reported: false,
    durationMs: 0,
  };
}

/** Token counters of one translation job, reset by creating a new instance. */
export class JobUsage {
  private readonly stages: Record<UsageStage, StageUsage> = {
    terminology: emptyStage(),
    translation: emptyStage(),
    qa: emptyStage(),
  };
  /** Stages that ran but whose provider reported no usage (so totals understate). */
  private readonly unreported = new Set<UsageStage>();

  /**
   * Add one stage's actual usage to the job.
   *
   * `usage` is null/undefined when the stage ran without the provider reporting
   * usage: the stage is then marked unreported and nothing is estimated in its
   * place. `durationMs` is added even then.
   */
  add(stage: UsageStage, usage: WorkerUsage | null | undefined, durationMs = 0): void {
    const s = this.stages[stage];
    s.durationMs += Math.max(0, durationMs);
    if (!usage) {
      if (durationMs > 0) this.unreported.add(stage);
      return;
    }
    s.inputTokens += usage.inputTokens;
    s.cachedInputTokens += usage.cachedInputTokens;
    s.outputTokens += usage.outputTokens;
    s.reasoningTokens += usage.reasoningTokens;
    s.processedTokens = s.inputTokens + s.outputTokens;
    s.reported = true;
    this.unreported.delete(stage);
  }

  stage(name: UsageStage): StageUsage {
    return { ...this.stages[name] };
  }

  totals(): JobUsageTotals {
    let input = 0;
    let cached = 0;
    let output = 0;
    let reasoning = 0;
    for (const name of USAGE_STAGES) {
      const s = this.stages[name];
      input += s.inputTokens;
      cached += s.cachedInputTokens;
      output += s.outputTokens;
      reasoning += s.reasoningTokens;
    }
    return {
      totalInputTokens: input,
      totalCachedInputTokens: cached,
      totalOutputTokens: output,
      totalReasoningTokens: reasoning,
      // cached ⊆ input and reasoning ⊆ output, so they are deliberately not added here.
      totalProcessedTokens: input + output,
    };
  }

  snapshot(): JobUsageSnapshot {
    const totals = this.totals();
    return {
      ...totals,
      terminology: this.stage('terminology'),
      translation: this.stage('translation'),
      qa: this.stage('qa'),
      complete: this.unreported.size === 0,
      totalDurationMs: USAGE_STAGES.reduce((n, name) => n + this.stages[name].durationMs, 0),
    };
  }

  /** True once any stage has reported actual usage. */
  get hasUsage(): boolean {
    return USAGE_STAGES.some((name) => this.stages[name].reported);
  }
}

/** "12,345" — the one number User Mode shows. */
export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Seconds with one decimal, for the user-facing 翻譯時間 line. */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/** Developer Mode: the full per-stage breakdown plus the job totals. */
export function formatUsageBreakdown(snapshot: JobUsageSnapshot): string[] {
  const pad = (label: string) => label.padEnd(26, ' ');
  const line = (label: string, value: number) => `  ${pad(label)}${formatTokens(value).padStart(12, ' ')}`;
  const lines: string[] = [];
  const stageLabels: Record<UsageStage, string> = {
    terminology: 'Terminology',
    translation: 'Translation',
    qa: 'QA',
  };

  for (const name of USAGE_STAGES) {
    const s = snapshot[name];
    lines.push(
      `${stageLabels[name]}${s.reported ? '' : s.durationMs > 0 ? '  (usage not reported by the provider)' : '  (no tokens spent)'}:`,
      line('input tokens', s.inputTokens),
      line('cached input tokens', s.cachedInputTokens),
      line('output tokens', s.outputTokens),
      line('reasoning tokens', s.reasoningTokens),
      line('processed (in + out)', s.processedTokens),
      `  ${pad('time')}${`${formatSeconds(s.durationMs)}s`.padStart(12, ' ')}`,
      '',
    );
  }

  lines.push(
    'Job total (actual provider usage):',
    line('totalInputTokens', snapshot.totalInputTokens),
    line('totalCachedInputTokens', snapshot.totalCachedInputTokens),
    line('totalOutputTokens', snapshot.totalOutputTokens),
    line('totalReasoningTokens', snapshot.totalReasoningTokens),
    line('totalProcessedTokens', snapshot.totalProcessedTokens),
    `  ${pad('total time')}${`${formatSeconds(snapshot.totalDurationMs)}s`.padStart(12, ' ')}`,
    '  cachedInputTokens ⊆ inputTokens and reasoningTokens ⊆ outputTokens (never added twice).',
  );
  if (!snapshot.complete) {
    lines.push('  note: a stage ran without the provider reporting usage, so the totals under-count it.');
  }
  return lines;
}
