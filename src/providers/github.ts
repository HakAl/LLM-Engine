import type { ModelInfo } from './types.js';
import type { RequestOptions } from '../engine/types.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * GitHub Models provider adapter.
 *
 * Chat endpoint: https://models.github.ai/inference/chat/completions
 * Catalog endpoint: https://models.github.ai/catalog/models
 *
 * The catalog uses a non-standard response shape (plain array, not
 * `{ data: [...] }`), so fetchModels is overridden.
 */
export class GitHubModelsProvider extends OpenAICompatibleProvider {
  readonly id = 'github';
  readonly name = 'GitHub Models';

  private readonly apiKey: string;

  constructor(apiKey: string, config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'https://models.github.ai/inference';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  async fetchModels(options?: RequestOptions): Promise<ModelInfo[]> {
    const signal = options?.signal;
    const response = await fetch('https://models.github.ai/catalog/models', {
      headers: { Authorization: this.authHeader() },
      signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub catalog returned HTTP ${response.status}`);
    }

    const json = await response.json() as Record<string, unknown>;

    // Response is an array-like object keyed by index, not { data: [...] }
    const entries = Object.values(json) as Array<Record<string, unknown>>;

    return entries
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && 'id' in e)
      .map((e) => ({
        id: e['id'] as string,
        name: (e['name'] as string) ?? (e['id'] as string),
        provider: this.id,
        contextWindow: 0,
        capabilities: [],
      }));
  }
}
