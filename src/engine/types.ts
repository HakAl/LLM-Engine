export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RateLimitWindow {
  type: 'rpm' | 'rpd' | 'tpm';
  remaining: number;
  total: number;
  resetsAt: Date;
}

export interface AcquireResult {
  granted: boolean;
  waitMs?: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  state: 'healthy' | 'degraded' | 'unavailable';
  rateLimits: RateLimitWindow[];
  circuitState: CircuitState;
}

export interface RoutingDecision {
  provider: string;
  reason: string;
  fallbacksAttempted: Array<{
    provider: string;
    reason: string;
  }>;
}

export function deriveProviderState(
  circuitState: CircuitState,
  rateLimits: RateLimitWindow[],
): 'healthy' | 'degraded' | 'unavailable' {
  if (circuitState === 'open') return 'unavailable';
  if (circuitState === 'half-open') return 'degraded';
  const hasExhaustedWindow = rateLimits.some(w => w.remaining <= 0);
  if (hasExhaustedWindow) return 'degraded';
  return 'healthy';
}
