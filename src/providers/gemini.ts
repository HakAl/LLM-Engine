import type { ModelInfo } from './types.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * Gemini provider adapter (OpenAI-compatible endpoint).
 *
 * Uses the OpenAI-compatible API at
 * https://generativelanguage.googleapis.com/v1beta/openai.
 *
 * The /models endpoint returns IDs with a "models/" prefix
 * (e.g. "models/gemini-2.5-flash") which must be stripped
 * since the chat endpoint expects bare IDs.
 */
export class GeminiProvider extends OpenAICompatibleProvider {
  readonly id = 'gemini';
  readonly name = 'Gemini';

  private readonly apiKey: string;

  constructor(apiKey: string, config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'https://generativelanguage.googleapis.com/v1beta/openai';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  protected mapModelEntry(entry: Record<string, unknown>): ModelInfo {
    const rawId = (entry['id'] as string) ?? '';
    const id = rawId.replace(/^models\//, '');
    return {
      id,
      name: (entry['display_name'] as string) ?? id,
      provider: this.id,
      contextWindow: (entry['context_window'] as number) ?? 0,
      capabilities: [],
    };
  }
}
