import { describe, it, expect, vi } from 'vitest';
import { Registry } from '../../providers/registry.js';
import type { Provider, ModelInfo, ChatRequest, ChatResponse, StreamChunk } from '../../providers/types.js';
import type { RequestOptions } from '../../engine/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeModel(overrides: Partial<ModelInfo> & { id: string; provider: string }): ModelInfo {
  return {
    name: overrides.id,
    contextWindow: 4096,
    capabilities: ['chat'],
    ...overrides,
  };
}

function makeProvider(
  id: string,
  models: ModelInfo[],
  options?: { delay?: number; shouldFail?: boolean },
): Provider {
  return {
    id,
    name: `Provider ${id}`,

    async fetchModels(_opts?: RequestOptions): Promise<ModelInfo[]> {
      if (options?.delay) {
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }
      if (options?.shouldFail) {
        throw new Error(`fetchModels failed for ${id}`);
      }
      return models;
    },

    async chat(_request: ChatRequest, _opts?: RequestOptions): Promise<ChatResponse> {
      throw new Error('Not implemented in test mock');
    },

    async *chatStream(_request: ChatRequest, _opts?: RequestOptions): AsyncIterable<StreamChunk> {
      throw new Error('Not implemented in test mock');
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Registry', () => {
  describe('Registry.create — all providers succeed', () => {
    it('registers all providers and their models', async () => {
      const modelsA = [
        makeModel({ id: 'gpt-4', provider: 'openai' }),
        makeModel({ id: 'gpt-3.5-turbo', provider: 'openai' }),
      ];
      const modelsB = [
        makeModel({ id: 'claude-3-opus', provider: 'anthropic' }),
      ];

      const providerA = makeProvider('openai', modelsA);
      const providerB = makeProvider('anthropic', modelsB);

      const registry = await Registry.create([providerA, providerB]);

      expect(registry.getProviders()).toHaveLength(2);
      expect(registry.getProvider('openai')).toBe(providerA);
      expect(registry.getProvider('anthropic')).toBe(providerB);
      expect(registry.getModelsForProvider('openai')).toEqual(modelsA);
      expect(registry.getModelsForProvider('anthropic')).toEqual(modelsB);
      expect(registry.getAllModels()).toHaveLength(3);
    });
  });

  describe('Registry.create — one provider fails (no previous data)', () => {
    it('excludes the failing provider with a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const modelsA = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const providerA = makeProvider('openai', modelsA);
      const providerB = makeProvider('anthropic', [], { shouldFail: true });

      const registry = await Registry.create([providerA, providerB]);

      expect(registry.getProviders()).toHaveLength(1);
      expect(registry.getProvider('openai')).toBe(providerA);
      expect(registry.getProvider('anthropic')).toBeUndefined();
      expect(registry.getModelsForProvider('anthropic')).toEqual([]);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('anthropic'),
      );

      warnSpy.mockRestore();
    });
  });

  describe('Registry.create — one provider fails with previous data', () => {
    it('preserves the previous model data for the failing provider', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const modelsA = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const modelsB = [makeModel({ id: 'claude-3-opus', provider: 'anthropic' })];

      const providerA = makeProvider('openai', modelsA);
      const providerB = makeProvider('anthropic', modelsB);

      // First: create a healthy registry
      const previous = await Registry.create([providerA, providerB]);
      expect(previous.getProviders()).toHaveLength(2);

      // Second: anthropic fails, but previous data should be preserved
      const failingProviderB = makeProvider('anthropic', [], { shouldFail: true });
      const registry = await Registry.create([providerA, failingProviderB], previous);

      expect(registry.getProviders()).toHaveLength(2);
      expect(registry.getProvider('anthropic')).toBe(failingProviderB);
      expect(registry.getModelsForProvider('anthropic')).toEqual(modelsB);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('Registry.create — all providers fail', () => {
    it('produces a valid empty registry', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const providerA = makeProvider('openai', [], { shouldFail: true });
      const providerB = makeProvider('anthropic', [], { shouldFail: true });

      const registry = await Registry.create([providerA, providerB]);

      expect(registry.getProviders()).toHaveLength(0);
      expect(registry.getAllModels()).toEqual([]);
      expect(registry.getProvider('openai')).toBeUndefined();
      expect(registry.findProvidersForModel('gpt-4')).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });
  });

  describe('Registry.create — empty provider list', () => {
    it('produces a valid empty registry without warnings', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const registry = await Registry.create([]);

      expect(registry.getProviders()).toHaveLength(0);
      expect(registry.getAllModels()).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe('findProvidersForModel', () => {
    it('returns all providers that serve a given model id', async () => {
      const sharedModelId = 'llama-3-70b';

      const modelsA = [
        makeModel({ id: 'gpt-4', provider: 'openai' }),
        makeModel({ id: sharedModelId, provider: 'openai' }),
      ];
      const modelsB = [
        makeModel({ id: sharedModelId, provider: 'groq' }),
      ];
      const modelsC = [
        makeModel({ id: 'claude-3-opus', provider: 'anthropic' }),
      ];

      const providerA = makeProvider('openai', modelsA);
      const providerB = makeProvider('groq', modelsB);
      const providerC = makeProvider('anthropic', modelsC);

      const registry = await Registry.create([providerA, providerB, providerC]);

      const providers = registry.findProvidersForModel(sharedModelId);
      expect(providers).toHaveLength(2);
      expect(providers).toContain(providerA);
      expect(providers).toContain(providerB);
    });

    it('returns empty array for unknown model', async () => {
      const models = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const provider = makeProvider('openai', models);
      const registry = await Registry.create([provider]);

      expect(registry.findProvidersForModel('nonexistent')).toEqual([]);
    });
  });

  describe('concurrent fetchModels', () => {
    it('fetches models from all providers concurrently (not sequentially)', async () => {
      const callOrder: string[] = [];
      const PROVIDER_COUNT = 3;
      const DELAY_MS = 50;

      const providers: Provider[] = [];
      for (let i = 0; i < PROVIDER_COUNT; i++) {
        const id = `provider-${i}`;
        const models = [makeModel({ id: `model-${i}`, provider: id })];
        const p = makeProvider(id, models, { delay: DELAY_MS });

        // Wrap fetchModels to record call timing
        const originalFetch = p.fetchModels.bind(p);
        p.fetchModels = async (opts?: RequestOptions) => {
          callOrder.push(`start-${id}`);
          const result = await originalFetch(opts);
          callOrder.push(`end-${id}`);
          return result;
        };

        providers.push(p);
      }

      const start = Date.now();
      const registry = await Registry.create(providers);
      const elapsed = Date.now() - start;

      expect(registry.getProviders()).toHaveLength(PROVIDER_COUNT);

      // If sequential, total time would be >= PROVIDER_COUNT * DELAY_MS (150ms).
      // If concurrent, total time should be closer to DELAY_MS (50ms).
      // Allow generous margin for CI/slow machines, but it should be well
      // under the sequential time.
      expect(elapsed).toBeLessThan(PROVIDER_COUNT * DELAY_MS);

      // All starts should happen before any end (concurrent execution)
      const startIndices = callOrder
        .map((entry, idx) => (entry.startsWith('start-') ? idx : -1))
        .filter(i => i >= 0);
      const endIndices = callOrder
        .map((entry, idx) => (entry.startsWith('end-') ? idx : -1))
        .filter(i => i >= 0);

      const lastStart = Math.max(...startIndices);
      const firstEnd = Math.min(...endIndices);

      // In concurrent execution, all starts happen before any end
      expect(lastStart).toBeLessThan(firstEnd);
    });
  });

  describe('immutability', () => {
    it('returns fresh arrays from getProviders — mutation does not affect registry', async () => {
      const models = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const provider = makeProvider('openai', models);
      const registry = await Registry.create([provider]);

      const providers1 = registry.getProviders();
      providers1.pop();

      const providers2 = registry.getProviders();
      expect(providers2).toHaveLength(1);
    });

    it('returns fresh arrays from getModelsForProvider', async () => {
      const models = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const provider = makeProvider('openai', models);
      const registry = await Registry.create([provider]);

      const result1 = registry.getModelsForProvider('openai');
      result1.pop();

      const result2 = registry.getModelsForProvider('openai');
      expect(result2).toHaveLength(1);
    });

    it('returns fresh arrays from getAllModels', async () => {
      const models = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const provider = makeProvider('openai', models);
      const registry = await Registry.create([provider]);

      const result1 = registry.getAllModels();
      result1.pop();

      const result2 = registry.getAllModels();
      expect(result2).toHaveLength(1);
    });
  });

  describe('timeout behavior', () => {
    it('excludes a provider whose fetchModels exceeds the timeout', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const fastModels = [makeModel({ id: 'gpt-4', provider: 'openai' })];
      const fastProvider = makeProvider('openai', fastModels);

      // This provider takes 500ms but timeout is 100ms
      const slowProvider = makeProvider('slow-provider', [
        makeModel({ id: 'slow-model', provider: 'slow-provider' }),
      ], { delay: 500 });

      const registry = await Registry.create(
        [fastProvider, slowProvider],
        undefined,
        { fetchTimeoutMs: 100 },
      );

      expect(registry.getProviders()).toHaveLength(1);
      expect(registry.getProvider('openai')).toBe(fastProvider);
      expect(registry.getProvider('slow-provider')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    });
  });
});
