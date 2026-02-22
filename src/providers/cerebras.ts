import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * Cerebras provider adapter.
 *
 * Uses the OpenAI-compatible API at https://api.cerebras.ai/v1.
 * No custom response mapping needed -- Cerebras's API matches the
 * standard OpenAI shape exactly.
 */
export class CerebrasProvider extends OpenAICompatibleProvider {
  readonly id = 'cerebras';
  readonly name = 'Cerebras';

  private readonly apiKey: string;

  constructor(apiKey: string, config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'https://api.cerebras.ai/v1';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }
}
