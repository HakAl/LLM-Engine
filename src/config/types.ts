import type { RateLimitWindow } from '../engine/types.js';

export interface RateLimitOverride {
  type: RateLimitWindow['type'];
  total: number;
  windowMs: number;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  enabled: boolean;
  priority: number;
  rateLimitOverrides?: RateLimitOverride[];
  cacheTtlMs?: number;
}

export interface EngineConfig {
  providers: Record<string, ProviderConfig>;
  defaultCacheTtlMs?: number;
  defaultTimeoutMs?: number;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownMs?: number;
    maxCooldownMs?: number;
  };
  seedRpm?: number;
  requestLogCapacity?: number;
}
