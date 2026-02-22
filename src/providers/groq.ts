import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * Groq provider adapter.
 *
 * Uses the OpenAI-compatible API at https://api.groq.com/openai/v1.
 * No custom response mapping needed -- Groq's API matches the
 * standard OpenAI shape exactly.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  readonly id = 'groq';
  readonly name = 'Groq';

  private readonly apiKey: string;

  constructor(apiKey: string, config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'https://api.groq.com/openai/v1';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }
}
