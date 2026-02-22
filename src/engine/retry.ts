import { ProviderError, RateLimitError, RetryExhaustedError } from '../errors.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  isRetryable?: (error: Error) => boolean;
  onAttempt?: (attempt: number, error: Error, delayMs: number) => void;
}

function defaultIsRetryable(error: Error): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof ProviderError) return error.isRetryable;
  return false;
}

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  // Full jitter: uniform random in [0, capped]
  return Math.random() * capped;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    }

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }

    signal?.addEventListener('abort', onAbort);
  });
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    signal,
    isRetryable = defaultIsRetryable,
    onAttempt,
  } = options;

  const errors: Error[] = [];
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      errors.push(err);

      // Non-retryable errors throw immediately
      if (!isRetryable(err)) {
        throw err;
      }

      // If we have exhausted all retries, stop
      if (attempt >= maxRetries) {
        break;
      }

      // Compute delay: prefer Retry-After from RateLimitError, otherwise exponential backoff with jitter
      let delayMs: number;
      if (err instanceof RateLimitError && err.retryAfterMs !== undefined) {
        delayMs = err.retryAfterMs;
      } else {
        delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
      }

      // Notify observer
      onAttempt?.(attempt, err, delayMs);

      // Check abort before sleeping
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }

      await sleep(delayMs, signal);
    }
  }

  const totalElapsedMs = Date.now() - startTime;
  throw new RetryExhaustedError(errors.length, totalElapsedMs, errors);
}
