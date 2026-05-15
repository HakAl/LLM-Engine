import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './base/openai-compatible.js';

/**
 * Local MLX provider adapter.
 *
 * Talks to a locally-running `mlx_lm.server` exposing an OpenAI-compatible
 * API (default http://127.0.0.1:8080/v1). The API key is a placeholder
 * since the local server doesn't authenticate.
 *
 * Connection failures (server not running) surface as native fetch errors
 * and are caught by Registry.create's Promise.allSettled, so the provider
 * is excluded from the registry rather than crashing the engine.
 */
export class LocalMLXProvider extends OpenAICompatibleProvider {
  readonly id = 'local-mlx';
  readonly name = 'Local MLX';

  private readonly apiKey: string;

  constructor(apiKey: string = 'none', config?: OpenAICompatibleConfig) {
    super(config);
    this.apiKey = apiKey;
  }

  protected get defaultBaseUrl(): string {
    return 'http://127.0.0.1:8080/v1';
  }

  protected authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }
}
