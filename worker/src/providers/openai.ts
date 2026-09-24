/**
 * OpenAI provider (default). Uses the Responses API with a strict JSON schema
 * so every reply has the expected shape: { blocks: [{id, translation}] } for
 * translation, { terms: [...] } for terminology extraction and
 * { blocks: [{id, ok, translation, issues}] } for the QA pass.
 *
 * Quality-first, light reasoning: the model is a GPT-5.6 tier model and
 * `reasoning.effort` defaults to "low". Both are configurable in wrangler.toml.
 */

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

const ENDPOINT = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 110_000;
const MAX_OUTPUT_TOKENS = 16_000;
/** The glossary is at most 50 short entries. */
const TERMINOLOGY_MAX_OUTPUT_TOKENS = 4000;

interface ResponsesOutputContent {
  type: string;
  text?: string;
  refusal?: string;
}

interface ResponsesOutputItem {
  type: string;
  content?: ResponsesOutputContent[];
}

interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string } | null;
}

interface StructuredCall {
  instructions: string;
  input: string;
  schemaName: string;
  schema: unknown;
  maxOutputTokens: number;
}

interface StructuredReply {
  parsed: unknown;
  model: string;
  usage: ProviderUsage | undefined;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const n = Number(headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class OpenAIProvider implements TranslationProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string;
  private readonly effort: string;

  constructor(apiKey: string, model: string | undefined, effort: string | undefined) {
    this.apiKey = apiKey;
    this.model = model && model.trim() ? model.trim() : 'gpt-5.6-terra';
    this.effort = effort && effort.trim() ? effort.trim() : 'low';
  }

  async translate(blocks: RequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<ProviderResult> {
    const reply = await this.structured({
      instructions: buildSystemPrompt(terminology, blocks),
      input: buildUserMessage(blocks, targetLanguage),
      schemaName: 'translations',
      schema: OUTPUT_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    return { blocks: normalizeTranslations(reply.parsed), model: reply.model, usage: reply.usage };
  }

  async extractTerminology(samples: string[]): Promise<TerminologyResult> {
    const reply = await this.structured({
      instructions: TERMINOLOGY_PROMPT,
      input: buildTerminologyMessage(samples),
      schemaName: 'terminology',
      schema: TERMINOLOGY_SCHEMA,
      maxOutputTokens: TERMINOLOGY_MAX_OUTPUT_TOKENS,
    });
    return { terms: normalizeTerms(reply.parsed), model: reply.model, usage: reply.usage };
  }

  async reviewTranslations(blocks: QaRequestBlock[], targetLanguage: string, terminology: Record<string, string>): Promise<QaResult> {
    const reply = await this.structured({
      instructions: buildQaSystemPrompt(terminology, blocks),
      input: buildQaMessage(blocks, targetLanguage),
      schemaName: 'qa_review',
      schema: QA_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    return { blocks: normalizeVerdicts(reply.parsed), model: reply.model, usage: reply.usage };
  }

  /** One Responses API call with a strict JSON schema; every failure becomes a ProviderError. */
  private async structured(call: StructuredCall): Promise<StructuredReply> {
    const body = {
      model: this.model,
      instructions: call.instructions,
      input: [{ role: 'user', content: call.input }],
      reasoning: { effort: this.effort },
      text: {
        format: { type: 'json_schema', name: call.schemaName, strict: true, schema: call.schema },
      },
      max_output_tokens: call.maxOutputTokens,
      store: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(504, 'provider_timeout', 'Translation provider timed out.');
      }
      console.error('[openai] network failure', err instanceof Error ? err.message : err);
      throw new ProviderError(502, 'provider_unreachable', 'Could not reach the translation provider.');
    }
    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as ResponsesReply;
        detail = errBody.error?.message ?? '';
      } catch {
        // ignore
      }
      console.error(`[openai] HTTP ${response.status}: ${detail}`);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(500, 'provider_auth', 'Provider API key is missing or invalid on the Worker.');
      }
      if (response.status === 429) {
        throw new ProviderError(429, 'rate_limited', 'Translation provider rate limit reached.', retryAfterSeconds(response.headers));
      }
      if (response.status === 400) {
        throw new ProviderError(502, 'provider_bad_request', 'Translation provider rejected the request (check model/effort settings in wrangler.toml).');
      }
      throw new ProviderError(502, 'provider_error', `Translation provider returned HTTP ${response.status}.`);
    }

    let reply: ResponsesReply;
    try {
      reply = (await response.json()) as ResponsesReply;
    } catch {
      throw new ProviderError(502, 'invalid_json', 'Provider returned a non-JSON body.');
    }

    if (reply.status === 'incomplete') {
      const reason = reply.incomplete_details?.reason ?? 'unknown';
      throw new ProviderError(502, 'output_truncated', `Translation output was incomplete (${reason}). Send a smaller batch.`);
    }

    let text = '';
    for (const item of reply.output ?? []) {
      if (item.type !== 'message') continue;
      for (const part of item.content ?? []) {
        if (part.type === 'refusal') {
          throw new ProviderError(502, 'provider_refusal', 'The model declined to process this batch.');
        }
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError(502, 'invalid_json', 'Model returned invalid JSON.');
    }

    // Actual provider counts only; the Responses API reports cached prompt tokens
    // inside input_tokens and reasoning tokens inside output_tokens.
    const usage = reply.usage
      ? {
          inputTokens: reply.usage.input_tokens ?? 0,
          outputTokens: reply.usage.output_tokens ?? 0,
          cachedInputTokens: reply.usage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: reply.usage.output_tokens_details?.reasoning_tokens ?? 0,
        }
      : undefined;
    return { parsed, model: reply.model ?? this.model, usage };
  }
}
