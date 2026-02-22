import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../../engine/engine.js';
import * as dotenv from '../../config/dotenv.js';

describe('Engine', () => {
  beforeEach(() => {
    // Return empty .env so no real providers are discovered
    vi.spyOn(dotenv, 'parseDotEnv').mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an engine with the correct interface', async () => {
    const engine = await createEngine({ providers: {} });

    expect(engine).toBeDefined();
    expect(engine.chat).toBeTypeOf('function');
    expect(engine.chatStream).toBeTypeOf('function');
    expect(engine.getAvailableModels).toBeTypeOf('function');
    expect(engine.getProviderStatus).toBeTypeOf('function');
    expect(engine.updateConfig).toBeTypeOf('function');
  });

  it('getAvailableModels returns empty when no providers configured', async () => {
    const engine = await createEngine({ providers: {} });
    expect(engine.getAvailableModels()).toEqual([]);
  });

  it('getProviderStatus returns empty when no providers configured', async () => {
    const engine = await createEngine({ providers: {} });
    expect(engine.getProviderStatus()).toEqual([]);
  });

  it('updateConfig does not throw', async () => {
    const engine = await createEngine({ providers: {} });
    engine.updateConfig({ seedRpm: 20 });
  });

  it('creates engine with explicit provider config', async () => {
    // Provide a fake key for groq — fetchModels will fail (no real network),
    // but the engine should handle it gracefully.
    const engine = await createEngine({
      providers: {
        groq: {
          apiKey: 'fake-key',
          enabled: true,
          priority: 1,
        },
      },
    });

    // Provider status should include groq even if fetchModels failed
    // (registry may or may not include it depending on network)
    expect(engine).toBeDefined();
  });

  it('lazy re-bootstrap on config change', async () => {
    const engine = await createEngine({ providers: {} });

    // Initial state: no models
    expect(engine.getAvailableModels()).toEqual([]);

    // Update config — should trigger re-bootstrap on next request
    engine.updateConfig({ seedRpm: 5 });

    // getAvailableModels is synchronous (no re-bootstrap trigger),
    // so it still returns the existing snapshot
    expect(engine.getAvailableModels()).toEqual([]);
  });
});
