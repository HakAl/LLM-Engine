import { z } from 'zod';
import type { EngineConfig, ProviderConfig } from './types.js';
import { PROVIDER_DEFAULTS, DEFAULT_ENGINE_CONFIG } from './defaults.js';
import { parseDotEnv } from './dotenv.js';

// ── Zod schemas for validation ──────────────────────────────────────

const RateLimitOverrideSchema = z.object({
  type: z.enum(['rpm', 'rpd', 'tpm']),
  total: z.number().positive(),
  windowMs: z.number().positive(),
});

const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean(),
  priority: z.number().int().positive(),
  rateLimitOverrides: z.array(RateLimitOverrideSchema).optional(),
  cacheTtlMs: z.number().nonnegative().optional(),
});

const EngineConfigSchema = z.object({
  providers: z.record(ProviderConfigSchema),
  defaultCacheTtlMs: z.number().nonnegative().optional(),
  defaultTimeoutMs: z.number().positive().optional(),
  retry: z
    .object({
      maxRetries: z.number().int().nonnegative().optional(),
      baseDelayMs: z.number().nonnegative().optional(),
      maxDelayMs: z.number().positive().optional(),
    })
    .optional(),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().int().positive().optional(),
      cooldownMs: z.number().positive().optional(),
      maxCooldownMs: z.number().positive().optional(),
    })
    .optional(),
  seedRpm: z.number().int().positive().optional(),
});

// ── Deep merge utility ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceVal = (source as Record<string, unknown>)[key];
    const targetVal = result[key];

    if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

// ── ConfigManager ───────────────────────────────────────────────────

export class ConfigManager {
  private config: EngineConfig;
  private _version: number;

  private constructor(config: EngineConfig) {
    this.config = config;
    this._version = 0;
  }

  /**
   * Factory method.
   *
   * 1. Reads API keys from .env file (the sole source of secrets).
   * 2. Creates a ProviderConfig for each key found.
   * 3. Deep-merges with the default engine config.
   * 4. Applies any caller-supplied overrides on top.
   * 5. Validates the result with zod (warns, does not throw).
   */
  static load(overrides?: Partial<EngineConfig>): ConfigManager {
    const env = parseDotEnv();
    const providers = ConfigManager.buildProviders(env);

    // Start from defaults, layer in discovered providers, then overrides
    let merged: EngineConfig = deepMerge(
      DEFAULT_ENGINE_CONFIG as unknown as Record<string, unknown>,
      { providers } as unknown as Partial<typeof DEFAULT_ENGINE_CONFIG>,
    ) as unknown as EngineConfig;

    if (overrides) {
      merged = deepMerge(
        merged as unknown as Record<string, unknown>,
        overrides as unknown as Partial<typeof merged>,
      ) as unknown as EngineConfig;
    }

    ConfigManager.validate(merged);

    return new ConfigManager(merged);
  }

  /** Returns the current engine configuration (snapshot). */
  getConfig(): EngineConfig {
    return this.config;
  }

  /**
   * Atomically deep-merges a partial update into the current config
   * and increments the version counter.
   */
  updateConfig(partial: Partial<EngineConfig>): void {
    this.config = deepMerge(
      this.config as unknown as Record<string, unknown>,
      partial as unknown as Partial<typeof this.config>,
    ) as unknown as EngineConfig;

    this._version++;

    ConfigManager.validate(this.config);
  }

  /** Monotonically increasing counter. Starts at 0, increments on each updateConfig(). */
  get version(): number {
    return this._version;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private static buildProviders(env: Record<string, string>): Record<string, ProviderConfig> {
    const providers: Record<string, ProviderConfig> = {};

    for (const [id, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
      const apiKey = env[defaults.envVar];
      if (apiKey) {
        providers[id] = {
          apiKey,
          baseUrl: defaults.baseUrl,
          enabled: true,
          priority: defaults.priority,
          rateLimitOverrides: defaults.rateLimits,
        };
      }
    }

    return providers;
  }

  /**
   * Validates the config against the zod schema.
   * Logs warnings for any issues but never throws --
   * a partial config is still usable.
   */
  private static validate(config: EngineConfig): void {
    const result = EngineConfigSchema.safeParse(config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.join('.');
        console.warn(`[ConfigManager] validation warning at "${path}": ${issue.message}`);
      }
    }
  }
}
