import type { Provider, ModelInfo } from './types.js';
import type { RequestOptions } from '../engine/types.js';

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

interface RegistryOptions {
  fetchTimeoutMs?: number;
}

/**
 * Immutable registry of providers and their models.
 *
 * Created via the async factory `Registry.create()`. Once constructed,
 * its contents never change. To refresh, create a new Registry and
 * pass the old one as `previous` so stale-but-valid data survives
 * transient provider failures.
 */
export class Registry {
  readonly #providers: ReadonlyMap<string, Provider>;
  readonly #models: ReadonlyMap<string, readonly ModelInfo[]>;

  private constructor(
    providers: ReadonlyMap<string, Provider>,
    models: ReadonlyMap<string, readonly ModelInfo[]>,
  ) {
    this.#providers = providers;
    this.#models = models;
  }

  // ── Factory ────────────────────────────────────────────────────────

  /**
   * Build a registry by fetching model lists from every provider
   * concurrently. Individual provider failures are isolated:
   *
   * - If a provider fails AND `previous` has its data, keep the old data.
   * - If a provider fails AND no previous data exists, exclude it with a
   *   warning (console.warn).
   * - A completely empty registry is still valid.
   */
  static async create(
    providers: Provider[],
    previous?: Registry,
    options?: RegistryOptions,
  ): Promise<Registry> {
    const timeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

    const results = await Promise.allSettled(
      providers.map(provider => Registry.#fetchWithTimeout(provider, timeoutMs)),
    );

    const providerMap = new Map<string, Provider>();
    const modelMap = new Map<string, readonly ModelInfo[]>();

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        providerMap.set(provider.id, provider);
        modelMap.set(provider.id, Object.freeze([...result.value]));
      } else {
        // fetchModels failed for this provider
        const previousModels = previous?.getModelsForProvider(provider.id);
        if (previousModels && previousModels.length > 0) {
          providerMap.set(provider.id, provider);
          modelMap.set(provider.id, Object.freeze([...previousModels]));
        } else {
          console.warn(
            `Registry: provider "${provider.id}" excluded — fetchModels failed and no previous data available.`,
          );
        }
      }
    }

    return new Registry(providerMap, modelMap);
  }

  // ── Queries ────────────────────────────────────────────────────────

  /** All registered providers. */
  getProviders(): Provider[] {
    return [...this.#providers.values()];
  }

  /** Look up a single provider by id. */
  getProvider(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  /** Models served by a given provider, or empty array if unknown. */
  getModelsForProvider(id: string): ModelInfo[] {
    const models = this.#models.get(id);
    return models ? [...models] : [];
  }

  /** Which providers can serve the given model id? */
  findProvidersForModel(modelId: string): Provider[] {
    const matching: Provider[] = [];
    for (const [providerId, models] of this.#models) {
      if (models.some(m => m.id === modelId)) {
        const provider = this.#providers.get(providerId);
        if (provider) {
          matching.push(provider);
        }
      }
    }
    return matching;
  }

  /** Flat list of every model across all providers. */
  getAllModels(): ModelInfo[] {
    const all: ModelInfo[] = [];
    for (const models of this.#models.values()) {
      all.push(...models);
    }
    return all;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  static async #fetchWithTimeout(
    provider: Provider,
    timeoutMs: number,
  ): Promise<ModelInfo[]> {
    const controller = new AbortController();

    const options: RequestOptions = {
      signal: controller.signal,
      timeoutMs,
    };

    // Race the provider call against a hard timeout so that even
    // providers that ignore the AbortSignal get cut off.
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`fetchModels timed out for provider "${provider.id}" after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        provider.fetchModels(options),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
