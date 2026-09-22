import type { Env } from '../env';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { ProviderError, type TranslationProvider } from './types';

export function createProvider(env: Env): TranslationProvider {
  const name = (env.PROVIDER ?? 'openai').toLowerCase();

  switch (name) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) {
        throw new ProviderError(
          500,
          'provider_not_configured',
          'OPENAI_API_KEY is not set. Use `wrangler secret put OPENAI_API_KEY` or `.dev.vars` locally.',
        );
      }
      return new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL, env.OPENAI_REASONING_EFFORT);
    }
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) {
        throw new ProviderError(
          500,
          'provider_not_configured',
          'ANTHROPIC_API_KEY is not set. Use `wrangler secret put ANTHROPIC_API_KEY` or `.dev.vars` locally.',
        );
      }
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, env.TRANSLATION_EFFORT);
    }
    default:
      throw new ProviderError(500, 'provider_not_configured', `Unknown PROVIDER "${name}".`);
  }
}
