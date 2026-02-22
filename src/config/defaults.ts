import type { EngineConfig, RateLimitOverride } from './types.js';

/**
 * Metadata for each supported provider: environment variable name,
 * base URL, default priority, and known free-tier rate limits.
 *
 * Rate limits are seeded from observed provider responses. Providers
 * that send rate-limit headers (Groq, Cerebras, GitHub) will have
 * these overwritten by reactive header learning. For providers that
 * don't send headers (Gemini, SambaNova RPM/TPM) these are essential.
 */
export interface ProviderDefaults {
  envVar: string;
  baseUrl: string;
  priority: number;
  rateLimits?: RateLimitOverride[];
}

/**
 * Provider metadata keyed by provider id.
 * Priority order: groq=1, cerebras=2, sambanova=3, github=4, gemini=5.
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  groq: {
    envVar: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    priority: 1,
    rateLimits: [
      { type: 'rpm', total: 14_400, windowMs: 60_000 },
      { type: 'tpm', total: 6_000, windowMs: 60_000 },
    ],
  },
  cerebras: {
    envVar: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    priority: 2,
    rateLimits: [
      { type: 'rpm', total: 30, windowMs: 60_000 },
      { type: 'tpm', total: 60_000, windowMs: 60_000 },
      { type: 'rpd', total: 14_400, windowMs: 86_400_000 },
    ],
  },
  sambanova: {
    envVar: 'SAMBANOVA_API_KEY',
    baseUrl: 'https://api.sambanova.ai/v1',
    priority: 3,
    rateLimits: [
      { type: 'rpd', total: 20, windowMs: 86_400_000 },
    ],
  },
  github: {
    envVar: 'GITHUB_MODELS_API_KEY',
    baseUrl: 'https://models.github.ai/inference',
    priority: 4,
    rateLimits: [
      { type: 'rpm', total: 20_000, windowMs: 60_000 },
      { type: 'tpm', total: 2_000_000, windowMs: 60_000 },
    ],
  },
  gemini: {
    envVar: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    priority: 5,
    rateLimits: [
      { type: 'rpm', total: 10, windowMs: 60_000 },
      { type: 'tpm', total: 250_000, windowMs: 60_000 },
      { type: 'rpd', total: 20, windowMs: 86_400_000 },
    ],
  },
};

/**
 * Default engine configuration values.
 * Provider map starts empty; the loader populates it from env vars.
 */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  providers: {},
  defaultCacheTtlMs: 60_000,
  defaultTimeoutMs: 30_000,
  retry: {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
  },
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 30_000,
    maxCooldownMs: 300_000,
  },
  seedRpm: 10,
};
