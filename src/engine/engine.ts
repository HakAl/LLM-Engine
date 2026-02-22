import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
  Provider,
} from '../providers/types.js';
import type {
  RequestOptions,
  ProviderStatus,
} from './types.js';
import type { EngineConfig } from '../config/types.js';
import type { DashboardStatus, RequestLogEntry } from '../dashboard/types.js';
import { ConfigManager } from '../config/loader.js';
import { PROVIDER_DEFAULTS } from '../config/defaults.js';
import { Registry } from '../providers/registry.js';
import { Router } from './router.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { RequestLog } from '../dashboard/request-log.js';
import { GroqProvider } from '../providers/groq.js';
import { CerebrasProvider } from '../providers/cerebras.js';
import { SambaNovaProvider } from '../providers/sambanova.js';
import { GitHubModelsProvider } from '../providers/github.js';
import { GeminiProvider } from '../providers/gemini.js';

export interface Engine {
  chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse>;
  chatStream(request: ChatRequest, options?: RequestOptions): AsyncIterable<StreamChunk>;
  getAvailableModels(): ModelInfo[];
  getProviderStatus(): ProviderStatus[];
  updateConfig(partial: Partial<EngineConfig>): void;
  getDashboardStatus(): DashboardStatus;
  onRequestComplete(callback: (entry: RequestLogEntry) => void): () => void;
}

/** Internal snapshot — captured at request entry for isolation. */
interface EngineSnapshot {
  registry: Registry;
  router: Router;
  configVersion: number;
}

interface ProviderFactoryConfig {
  apiKey: string;
  baseUrl?: string;
  cacheTtlMs?: number;
}

const PROVIDER_FACTORIES: Record<string, (cfg: ProviderFactoryConfig) => Provider> = {
  groq: (cfg) => new GroqProvider(cfg.apiKey, { baseUrl: cfg.baseUrl, cacheTtlMs: cfg.cacheTtlMs }),
  cerebras: (cfg) => new CerebrasProvider(cfg.apiKey, { baseUrl: cfg.baseUrl, cacheTtlMs: cfg.cacheTtlMs }),
  sambanova: (cfg) => new SambaNovaProvider(cfg.apiKey, { baseUrl: cfg.baseUrl, cacheTtlMs: cfg.cacheTtlMs }),
  github: (cfg) => new GitHubModelsProvider(cfg.apiKey, { baseUrl: cfg.baseUrl, cacheTtlMs: cfg.cacheTtlMs }),
  gemini: (cfg) => new GeminiProvider(cfg.apiKey, { baseUrl: cfg.baseUrl, cacheTtlMs: cfg.cacheTtlMs }),
};

/**
 * Create and bootstrap the LLM engine.
 *
 * Reads config (env vars + overrides), constructs provider instances,
 * builds the registry, and returns a ready-to-use Engine.
 */
export async function createEngine(overrides?: Partial<EngineConfig>): Promise<Engine> {
  const configManager = ConfigManager.load(overrides);
  const config = configManager.getConfig();

  const rateLimiter = new RateLimiter({
    seedRpm: config.seedRpm,
    providerOverrides: buildRateLimitOverrides(config),
  });

  const circuitBreaker = new CircuitBreaker({
    failureThreshold: config.circuitBreaker?.failureThreshold ?? 5,
    cooldownMs: config.circuitBreaker?.cooldownMs ?? 30_000,
    maxCooldownMs: config.circuitBreaker?.maxCooldownMs ?? 300_000,
  });

  const requestLog = new RequestLog(config.requestLogCapacity ?? 1000);

  const providers = buildProviders(config);
  const registry = await Registry.create(providers);

  const providerPriority = deriveProviderPriority(config);

  const router = new Router({
    registry,
    rateLimiter,
    circuitBreaker,
    providerPriority,
    retry: config.retry,
    defaultTimeoutMs: config.defaultTimeoutMs,
    onRouteComplete: (event) => requestLog.record(event),
  });

  let snapshot: EngineSnapshot = {
    registry,
    router,
    configVersion: configManager.version,
  };

  let bootstrapInFlight: Promise<EngineSnapshot> | null = null;

  async function ensureSnapshot(): Promise<EngineSnapshot> {
    if (configManager.version === snapshot.configVersion) {
      return snapshot;
    }

    // Single-flight guard: only one re-bootstrap at a time
    if (bootstrapInFlight) {
      return bootstrapInFlight;
    }

    bootstrapInFlight = rebootstrap(
      configManager,
      snapshot,
      rateLimiter,
      circuitBreaker,
      requestLog,
    );

    try {
      const newSnapshot = await bootstrapInFlight;
      snapshot = newSnapshot;
      return newSnapshot;
    } finally {
      bootstrapInFlight = null;
    }
  }

  return {
    async chat(request, options) {
      const snap = await ensureSnapshot();
      return snap.router.execute(request, options);
    },

    async *chatStream(request, options) {
      const snap = await ensureSnapshot();
      yield* snap.router.executeStream(request, options);
    },

    getAvailableModels() {
      return snapshot.registry.getAllModels();
    },

    getProviderStatus() {
      return snapshot.router.getProviderStatus();
    },

    updateConfig(partial) {
      configManager.updateConfig(partial);
    },

    getDashboardStatus() {
      return {
        providers: snapshot.router.getProviderStatus(),
        models: snapshot.registry.getAllModels(),
        recentRequests: requestLog.getRecent(100),
        timestamp: Date.now(),
      };
    },

    onRequestComplete(callback) {
      return requestLog.onEntry(callback);
    },
  };
}

// ---- Internal helpers ----

function buildProviders(config: EngineConfig): Provider[] {
  const providers: Provider[] = [];

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue;

    const factory = PROVIDER_FACTORIES[id];
    if (!factory) continue;

    providers.push(factory({
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      cacheTtlMs: providerConfig.cacheTtlMs,
    }));
  }

  return providers;
}

function deriveProviderPriority(config: EngineConfig): string[] {
  return Object.entries(config.providers)
    .filter(([, pc]) => pc.enabled)
    .sort(([, a], [, b]) => a.priority - b.priority)
    .map(([id]) => id);
}

function buildRateLimitOverrides(config: EngineConfig): Record<string, import('../config/types.js').RateLimitOverride[]> {
  const overrides: Record<string, import('../config/types.js').RateLimitOverride[]> = {};

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.rateLimitOverrides && providerConfig.rateLimitOverrides.length > 0) {
      overrides[id] = providerConfig.rateLimitOverrides;
    }
  }

  return overrides;
}

async function rebootstrap(
  configManager: ConfigManager,
  previous: EngineSnapshot,
  rateLimiter: RateLimiter,
  circuitBreaker: CircuitBreaker,
  requestLog: RequestLog,
): Promise<EngineSnapshot> {
  const config = configManager.getConfig();

  const providers = buildProviders(config);
  const registry = await Registry.create(providers, previous.registry);

  const providerPriority = deriveProviderPriority(config);

  const router = new Router({
    registry,
    rateLimiter,
    circuitBreaker,
    providerPriority,
    retry: config.retry,
    defaultTimeoutMs: config.defaultTimeoutMs,
    onRouteComplete: (event) => requestLog.record(event),
  });

  return {
    registry,
    router,
    configVersion: configManager.version,
  };
}
