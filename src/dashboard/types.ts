import type { ProviderStatus } from '../engine/types.js';
import type { ModelInfo } from '../providers/types.js';

export interface DashboardStatus {
  providers: ProviderStatus[];
  models: ModelInfo[];
  recentRequests: RequestLogEntry[];
  timestamp: number;
}

export interface RequestLogEntry {
  id: string;
  timestamp: number;
  model: string;
  routingChain: RoutingStep[];
  outcome: 'success' | 'fallback-success' | 'all-failed';
  latencyMs: number;
  /** The provider that ultimately handled the request (undefined if all failed). */
  provider?: string;
}

export interface RoutingStep {
  provider: string;
  action: 'skipped-circuit-open' | 'skipped-rate-limited' | 'failed' | 'succeeded';
  reason?: string;
}

/** Event emitted by the Router after each request completes. */
export interface RouteCompleteEvent {
  model: string;
  steps: RoutingStep[];
  outcome: RequestLogEntry['outcome'];
  latencyMs: number;
  provider?: string;
}
