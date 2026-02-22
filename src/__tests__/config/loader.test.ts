import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../../config/loader.js';
import { PROVIDER_DEFAULTS, DEFAULT_ENGINE_CONFIG } from '../../config/defaults.js';
import * as dotenv from '../../config/dotenv.js';

describe('ConfigManager', () => {
  let mockEnv: Record<string, string>;

  beforeEach(() => {
    mockEnv = {};
    vi.spyOn(dotenv, 'parseDotEnv').mockImplementation(() => mockEnv);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── load() with no env vars ────────────────────────────────────────

  describe('load with no environment variables set', () => {
    it('returns an empty providers map', () => {
      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers).toEqual({});
    });

    it('applies default engine config values', () => {
      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.defaultCacheTtlMs).toBe(60_000);
      expect(config.defaultTimeoutMs).toBe(30_000);
      expect(config.seedRpm).toBe(10);
      expect(config.retry).toEqual({
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 10_000,
      });
      expect(config.circuitBreaker).toEqual({
        failureThreshold: 5,
        cooldownMs: 30_000,
        maxCooldownMs: 300_000,
      });
    });

    it('starts at version 0', () => {
      const manager = ConfigManager.load();
      expect(manager.version).toBe(0);
    });
  });

  // ── load() with some env vars ──────────────────────────────────────

  describe('load with some API keys set', () => {
    it('creates provider configs for each set env var', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test123';
      mockEnv.GEMINI_API_KEY = 'AIza_test456';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(Object.keys(config.providers)).toHaveLength(2);
      expect(config.providers.groq).toBeDefined();
      expect(config.providers.gemini).toBeDefined();
      expect(config.providers.cerebras).toBeUndefined();
      expect(config.providers.sambanova).toBeUndefined();
      expect(config.providers.github).toBeUndefined();
    });

    it('sets enabled=true for discovered providers', () => {
      mockEnv.CEREBRAS_API_KEY = 'csk_test';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers.cerebras.enabled).toBe(true);
    });

    it('assigns priorities from defaults', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';
      mockEnv.CEREBRAS_API_KEY = 'csk_test';
      mockEnv.SAMBANOVA_API_KEY = 'sn_test';
      mockEnv.GITHUB_MODELS_API_KEY = 'gh_test';
      mockEnv.GEMINI_API_KEY = 'gem_test';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers.groq.priority).toBe(1);
      expect(config.providers.cerebras.priority).toBe(2);
      expect(config.providers.sambanova.priority).toBe(3);
      expect(config.providers.github.priority).toBe(4);
      expect(config.providers.gemini.priority).toBe(5);
    });

    it('sets base URLs from defaults', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers.groq.baseUrl).toBe(
        PROVIDER_DEFAULTS.groq.baseUrl,
      );
    });

    it('stores the API key from the environment', () => {
      mockEnv.SAMBANOVA_API_KEY = 'sn_secret_key_789';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers.sambanova.apiKey).toBe('sn_secret_key_789');
    });
  });

  // ── load() with overrides ──────────────────────────────────────────

  describe('load with overrides', () => {
    it('merges overrides on top of defaults', () => {
      const manager = ConfigManager.load({
        defaultCacheTtlMs: 120_000,
        seedRpm: 20,
      });
      const config = manager.getConfig();

      expect(config.defaultCacheTtlMs).toBe(120_000);
      expect(config.seedRpm).toBe(20);
      // Non-overridden defaults remain
      expect(config.defaultTimeoutMs).toBe(30_000);
    });

    it('deep-merges nested retry overrides', () => {
      const manager = ConfigManager.load({
        retry: { maxRetries: 5 },
      });
      const config = manager.getConfig();

      expect(config.retry?.maxRetries).toBe(5);
      // Other retry defaults remain
      expect(config.retry?.baseDelayMs).toBe(500);
      expect(config.retry?.maxDelayMs).toBe(10_000);
    });

    it('allows overriding provider configs', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';

      const manager = ConfigManager.load({
        providers: {
          groq: {
            apiKey: 'gsk_override',
            enabled: false,
            priority: 10,
          },
        },
      });
      const config = manager.getConfig();

      // The override replaces the env-sourced provider via deep merge
      expect(config.providers.groq.apiKey).toBe('gsk_override');
      expect(config.providers.groq.enabled).toBe(false);
      expect(config.providers.groq.priority).toBe(10);
    });

    it('can add providers not found in env via overrides', () => {
      const manager = ConfigManager.load({
        providers: {
          custom: {
            apiKey: 'custom_key',
            baseUrl: 'https://custom.api.com/v1',
            enabled: true,
            priority: 99,
          },
        },
      });
      const config = manager.getConfig();

      expect(config.providers.custom).toBeDefined();
      expect(config.providers.custom.apiKey).toBe('custom_key');
    });
  });

  // ── getConfig() ────────────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns the current config state', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';

      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.providers.groq).toBeDefined();
      expect(config.defaultCacheTtlMs).toBe(DEFAULT_ENGINE_CONFIG.defaultCacheTtlMs);
    });

    it('reflects changes made by updateConfig', () => {
      const manager = ConfigManager.load();

      manager.updateConfig({ seedRpm: 50 });
      const config = manager.getConfig();

      expect(config.seedRpm).toBe(50);
    });
  });

  // ── updateConfig() ─────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('increments version on each call', () => {
      const manager = ConfigManager.load();

      expect(manager.version).toBe(0);

      manager.updateConfig({ seedRpm: 15 });
      expect(manager.version).toBe(1);

      manager.updateConfig({ seedRpm: 20 });
      expect(manager.version).toBe(2);

      manager.updateConfig({ seedRpm: 25 });
      expect(manager.version).toBe(3);
    });

    it('deep merges partial updates', () => {
      const manager = ConfigManager.load();

      manager.updateConfig({
        retry: { maxRetries: 10 },
      });

      const config = manager.getConfig();
      expect(config.retry?.maxRetries).toBe(10);
      expect(config.retry?.baseDelayMs).toBe(500);
      expect(config.retry?.maxDelayMs).toBe(10_000);
    });

    it('deep merges provider-level updates', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';
      const manager = ConfigManager.load();

      manager.updateConfig({
        providers: {
          groq: {
            apiKey: 'gsk_test',
            enabled: false,
            priority: 1,
          },
        },
      });

      const config = manager.getConfig();
      expect(config.providers.groq.enabled).toBe(false);
      expect(config.providers.groq.apiKey).toBe('gsk_test');
      expect(config.providers.groq.baseUrl).toBe(PROVIDER_DEFAULTS.groq.baseUrl);
    });

    it('preserves existing providers when adding a new one', () => {
      mockEnv.GROQ_API_KEY = 'gsk_test';
      const manager = ConfigManager.load();

      manager.updateConfig({
        providers: {
          newprovider: {
            apiKey: 'new_key',
            enabled: true,
            priority: 6,
          },
        },
      });

      const config = manager.getConfig();
      expect(config.providers.groq).toBeDefined();
      expect(config.providers.newprovider).toBeDefined();
    });
  });

  // ── version ────────────────────────────────────────────────────────

  describe('version', () => {
    it('starts at 0', () => {
      const manager = ConfigManager.load();
      expect(manager.version).toBe(0);
    });

    it('is monotonically increasing', () => {
      const manager = ConfigManager.load();
      const versions: number[] = [];

      for (let i = 0; i < 5; i++) {
        manager.updateConfig({ seedRpm: 10 + i });
        versions.push(manager.version);
      }

      for (let i = 1; i < versions.length; i++) {
        expect(versions[i]).toBeGreaterThan(versions[i - 1]);
      }
    });

    it('does not increment on load, only on updateConfig', () => {
      const manager = ConfigManager.load({ seedRpm: 50 });
      expect(manager.version).toBe(0);
    });
  });

  // ── validation (warns, does not throw) ─────────────────────────────

  describe('validation', () => {
    it('does not throw on partial or empty config', () => {
      expect(() => ConfigManager.load()).not.toThrow();
    });

    it('warns on validation issues but still returns a config', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const manager = ConfigManager.load({
        providers: {
          bad: {
            apiKey: '', // empty string fails min(1)
            enabled: true,
            priority: 1,
          },
        },
      });

      expect(manager.getConfig().providers.bad).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();

      const warningMessages = warnSpy.mock.calls.map(call => call[0] as string);
      const hasApiKeyWarning = warningMessages.some(msg => msg.includes('apiKey'));
      expect(hasApiKeyWarning).toBe(true);
    });

    it('warns on invalid updateConfig values but still applies them', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const manager = ConfigManager.load();

      manager.updateConfig({ seedRpm: -5 } as Partial<EngineConfig>);

      expect(manager.getConfig().seedRpm).toBe(-5);
      expect(manager.version).toBe(1);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // ── default values applied correctly ───────────────────────────────

  describe('default values', () => {
    it('applies all default engine config values', () => {
      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.defaultCacheTtlMs).toBe(60_000);
      expect(config.defaultTimeoutMs).toBe(30_000);
      expect(config.seedRpm).toBe(10);
    });

    it('applies default retry config', () => {
      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.retry).toEqual({
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 10_000,
      });
    });

    it('applies default circuit breaker config', () => {
      const manager = ConfigManager.load();
      const config = manager.getConfig();

      expect(config.circuitBreaker).toEqual({
        failureThreshold: 5,
        cooldownMs: 30_000,
        maxCooldownMs: 300_000,
      });
    });
  });
});
