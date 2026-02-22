import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * SambaNova provider adapter.
 *
 * Uses the OpenAI-compatible API at https://api.sambanova.ai/v1.
 * No custom response mapping needed -- SambaNova's API matches the
 * standard OpenAI shape exactly.
 */
export class SambaNovaProvider extends OpenAICompatibleProvider {
  readonly id = 'sambanova';
  readonly name = 'SambaNova';

  private readonly apiKey: string;

  constructor(apiKey: string, config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'https://api.sambanova.ai/v1';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }
}
