export class EngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineError';
  }
}

export class AuthError extends EngineError {
  constructor(
    public readonly provider: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? `Authentication failed for provider: ${provider}`, options);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends EngineError {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs?: number,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? `Rate limited by provider: ${provider}`, options);
    this.name = 'RateLimitError';
  }
}

export class ProviderError extends EngineError {
  public readonly isRetryable: boolean;

  constructor(
    public readonly provider: string,
    public readonly statusCode: number,
    message?: string,
    options?: ErrorOptions & { isRetryable?: boolean },
  ) {
    super(message ?? `Provider ${provider} returned ${statusCode}`, options);
    this.name = 'ProviderError';
    this.isRetryable = options?.isRetryable ?? (statusCode >= 500);
  }
}

export class TimeoutError extends EngineError {
  constructor(
    public readonly timeoutMs: number,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? `Request timed out after ${timeoutMs}ms`, options);
    this.name = 'TimeoutError';
  }
}

export class StreamInterruptedError extends EngineError {
  constructor(
    public readonly provider: string,
    public readonly chunksEmitted: number,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(
      message ?? `Stream interrupted from ${provider} after ${chunksEmitted} chunks`,
      options,
    );
    this.name = 'StreamInterruptedError';
  }
}

export interface ProviderFailureDetail {
  provider: string;
  error: Error;
  reason: 'rate-limited' | 'circuit-open' | 'error' | 'context-too-large';
}

export class AllProvidersUnavailableError extends EngineError {
  constructor(
    public readonly failures: ProviderFailureDetail[],
    message?: string,
    options?: ErrorOptions,
  ) {
    super(
      message ?? `All providers unavailable: ${failures.map(f => `${f.provider} (${f.reason})`).join(', ')}`,
      options,
    );
    this.name = 'AllProvidersUnavailableError';
  }
}

export class RetryExhaustedError extends EngineError {
  constructor(
    public readonly attempts: number,
    public readonly totalElapsedMs: number,
    public readonly errors: Error[],
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? `Retry exhausted after ${attempts} attempts (${totalElapsedMs}ms)`, options);
    this.name = 'RetryExhaustedError';
  }
}
