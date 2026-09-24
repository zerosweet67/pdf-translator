/**
 * Claude provider. Uses structured outputs (output_config.format) so the
 * response is guaranteed to be JSON matching the task schema.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  OUTPUT_SCHEMA,
  QA_SCHEMA,
  TERMINOLOGY_PROMPT,
  TERMINOLOGY_SCHEMA,
  buildQaMessage,
  buildQaSystemPrompt,
  buildSystemPrompt,
  buildTerminologyMessage,
  buildUserMessage,
} from '../prompt';
import type { QaRequestBlock, RequestBlock } from '../validate';
import {
  ProviderError,
  normalizeTerms,
  normalizeTranslations,
  normalizeVerdicts,
  type ProviderResult,
  type ProviderUsage,
  type QaResult,
  type TerminologyResult,
  type TranslationProvider,
} from './types';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

function toEffort(value: string | undefined): Effort {
  return (EFFORTS as readonly string[]).includes(value ?? '') ? (value as Effort) : 'low';
}

function retryAfterSeconds(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown }).headers;
  let raw: string | null | undefined;
  if (headers && typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('retry-after');
  } else if (headers && typeof headers === 'object') {
    raw = (headers as Record<string, string | undefined>)['retry-after'];
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mapError(err: unknown): ProviderError {
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError(429, 'rate_limited', 'Translation provider rate limit reached.', retryAfterSeconds(err));
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(500, 'provider_auth', 'Provider API key is missing or invalid on the Worker.');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError(504, 'provider_timeout', 'Translation provider timed out.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(502, 'provider_unreachable', 'Could not reach the translation provider.');
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(502, 'provider_error', `Translation provider returned HTTP ${err.status ?? 'error'}.`);
  }
  return new ProviderError(502, 'provider_error', 'Unexpected translation provider failure.');
}

interface StructuredReply {
  parsed: unknown;
  model: string;
  usage: ProviderUsage;
}

export class AnthropicProvider implements TranslationProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;

  constructor(apiKey: string, model: string | undefined, effort: string | undefined) {
    this.model = model && model.trim() ? model.trim() : 'claude-opus-5';
    this.effort = toEffort(effort);
    // Worker retries at the batch level, so keep SDK retries low.
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 110_000 });
  }

  async translate(blocks: RequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<ProviderResult> {
    const reply = await this.structured(buildSystemPrompt(terminology, blocks), buildUserMessage(blocks, targetLanguage), OUTPUT_SCHEMA, 16000);
    return { blocks: normalizeTranslations(reply.parsed), model: reply.model, usage: reply.usage };
  }

  async extractTerminology(samples: string[]): Promise<TerminologyResult> {
    const reply = await this.structured(TERMINOLOGY_PROMPT, buildTerminologyMessage(samples), TERMINOLOGY_SCHEMA, 4000);
    return { terms: normalizeTerms(reply.parsed), model: reply.model, usage: reply.usage };
  }

  async reviewTranslations(blocks: QaRequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<QaResult> {
    const reply = await this.structured(buildQaSystemPrompt(terminology, blocks), buildQaMessage(blocks, targetLanguage), QA_SCHEMA, 16000);
    return { blocks: normalizeVerdicts(reply.parsed), model: reply.model, usage: reply.usage };
  }

  private async structured(system: string, user: string, schema: unknown, maxTokens: number): Promise<StructuredReply> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: {
          effort: this.effort,
          format: { type: 'json_schema', schema: schema as typeof OUTPUT_SCHEMA },
        },
      });
    } catch (err) {
      console.error('[anthropic] request failed', err instanceof Error ? err.message : err);
      throw mapError(err);
    }

    if (response.stop_reason === 'refusal') {
      throw new ProviderError(502, 'provider_refusal', 'The model declined to process this batch.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ProviderError(502, 'output_truncated', 'Output was truncated. Send a smaller batch.');
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(502, 'invalid_json', 'Model returned invalid JSON.');
    }

    // Anthropic reports cache reads and cache writes outside input_tokens, so both are
    // added back to get the real prompt size. Only the cache *read* counts as cached.
    // Thinking tokens are billed inside output_tokens and are not broken out, so
    // reasoningTokens stays 0 here rather than being estimated.
    const u = response.usage as {
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
    const cached = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return {
      parsed,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens + cached + cacheWrite,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: cached,
        reasoningTokens: 0,
      },
    };
  }
}
