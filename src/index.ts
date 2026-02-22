// LLM Engine — public API

export { createEngine } from './engine/engine.js';
export type { Engine } from './engine/engine.js';

// Request/response types
export type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
  Message,
  Usage,
} from './providers/types.js';

// Engine types
export type {
  RequestOptions,
  ProviderStatus,
  RoutingDecision,
  CircuitState,
  RateLimitWindow,
} from './engine/types.js';

// Config types
export type {
  EngineConfig,
  ProviderConfig,
} from './config/types.js';

// Dashboard types
export type {
  DashboardStatus,
  RequestLogEntry,
  RoutingStep,
  RouteCompleteEvent,
} from './dashboard/types.js';

export { RequestLog } from './dashboard/request-log.js';

// Dashboard server
export { startDashboardServer } from './dashboard/server.js';
export type { DashboardServerOptions } from './dashboard/server.js';

// Errors
export {
  EngineError,
  AuthError,
  RateLimitError,
  ProviderError,
  TimeoutError,
  StreamInterruptedError,
  AllProvidersUnavailableError,
  RetryExhaustedError,
} from './errors.js';
