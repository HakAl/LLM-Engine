import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retry, RetryOptions } from '../../engine/retry.js';
import { ProviderError, RateLimitError, RetryExhaustedError, AuthError } from '../../errors.js';

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin Math.random so jitter is deterministic in tests: full jitter = 0.5 * capped
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseOptions: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
  };

  // ----------------------------------------------------------------
  // Success on first try
  // ----------------------------------------------------------------
  it('succeeds on first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = retry(fn, baseOptions);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // Succeeds after N failures
  // ----------------------------------------------------------------
  it('succeeds after transient failures', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new ProviderError('openai', 500, 'server error', { isRetryable: true }))
      .mockRejectedValueOnce(new ProviderError('openai', 502, 'bad gateway', { isRetryable: true }))
      .mockResolvedValue('success');

    const promise = retry(fn, baseOptions);

    // Advance past the first backoff: attempt 0 => baseDelay * 2^0 = 100, jitter => 0.5 * 100 = 50ms
    await vi.advanceTimersByTimeAsync(50);
    // Advance past the second backoff: attempt 1 => baseDelay * 2^1 = 200, jitter => 0.5 * 200 = 100ms
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // ----------------------------------------------------------------
  // Non-retryable error throws immediately
  // ----------------------------------------------------------------
  it('throws non-retryable errors immediately without retrying', async () => {
    const authErr = new AuthError('openai', 'bad key');
    const fn = vi.fn().mockRejectedValue(authErr);

    await expect(retry(fn, baseOptions)).rejects.toThrow(authErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws non-retryable ProviderError immediately', async () => {
    const providerErr = new ProviderError('openai', 400, 'bad request', { isRetryable: false });
    const fn = vi.fn().mockRejectedValue(providerErr);

    await expect(retry(fn, baseOptions)).rejects.toThrow(providerErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // Abort signal during backoff wait
  // ----------------------------------------------------------------
  it('aborts during backoff when signal is triggered', async () => {
    const controller = new AbortController();
    const fn = vi.fn()
      .mockRejectedValueOnce(new ProviderError('openai', 500, 'fail', { isRetryable: true }))
      .mockResolvedValue('never reached');

    const promise = retry(fn, { ...baseOptions, signal: controller.signal });

    // Let the first attempt fail and the backoff sleep start
    await vi.advanceTimersByTimeAsync(10);

    // Abort while sleeping
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(promise).rejects.toThrow('cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts before first attempt if already signaled', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('pre-aborted', 'AbortError'));

    const fn = vi.fn().mockResolvedValue('never');

    await expect(
      retry(fn, { ...baseOptions, signal: controller.signal }),
    ).rejects.toThrow('pre-aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // Retry-After from RateLimitError is respected
  // ----------------------------------------------------------------
  it('uses retryAfterMs from RateLimitError instead of computed backoff', async () => {
    const rateLimitErr = new RateLimitError('anthropic', 3000);
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue('recovered');

    const onAttempt = vi.fn();
    const promise = retry(fn, { ...baseOptions, onAttempt });

    // The delay should be 3000ms (retryAfterMs), not the computed backoff
    // Advance to just before: should not have resolved
    await vi.advanceTimersByTimeAsync(2999);
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance the remaining 1ms
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);

    // Verify onAttempt was called with the retryAfterMs delay
    expect(onAttempt).toHaveBeenCalledWith(0, rateLimitErr, 3000);
  });

  // ----------------------------------------------------------------
  // Exhaustion with all errors collected
  // ----------------------------------------------------------------
  it('throws RetryExhaustedError with all errors after maxRetries', async () => {
    const errors = [
      new ProviderError('openai', 500, 'fail 1', { isRetryable: true }),
      new ProviderError('openai', 502, 'fail 2', { isRetryable: true }),
      new ProviderError('openai', 503, 'fail 3', { isRetryable: true }),
      new ProviderError('openai', 500, 'fail 4', { isRetryable: true }),
    ];

    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      return Promise.reject(errors[callCount++]);
    });

    const promise = retry(fn, baseOptions);
    // Attach a no-op handler so the rejection is "handled" during timer advancement
    promise.catch(() => {});

    // Advance through all three backoff periods
    // attempt 0: delay = 0.5 * 100 = 50ms
    await vi.advanceTimersByTimeAsync(50);
    // attempt 1: delay = 0.5 * 200 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // attempt 2: delay = 0.5 * 400 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toThrow(RetryExhaustedError);

    try {
      await promise;
    } catch (err) {
      const exhausted = err as RetryExhaustedError;
      expect(exhausted.attempts).toBe(4); // 1 initial + 3 retries = 4 total errors
      expect(exhausted.errors).toHaveLength(4);
      expect(exhausted.errors[0].message).toBe('fail 1');
      expect(exhausted.errors[3].message).toBe('fail 4');
      expect(exhausted.totalElapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  // ----------------------------------------------------------------
  // onAttempt callback
  // ----------------------------------------------------------------
  it('calls onAttempt with attempt number, error, and delay for each retry', async () => {
    const err1 = new ProviderError('openai', 500, 'fail 1', { isRetryable: true });
    const err2 = new ProviderError('openai', 502, 'fail 2', { isRetryable: true });
    const fn = vi.fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockResolvedValue('done');

    const onAttempt = vi.fn();
    const promise = retry(fn, { ...baseOptions, onAttempt });

    // Advance past backoff for attempt 0: 0.5 * 100 = 50ms
    await vi.advanceTimersByTimeAsync(50);
    // Advance past backoff for attempt 1: 0.5 * 200 = 100ms
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenNthCalledWith(1, 0, err1, 50);
    expect(onAttempt).toHaveBeenNthCalledWith(2, 1, err2, 100);
  });

  // ----------------------------------------------------------------
  // Exponential backoff with jitter
  // ----------------------------------------------------------------
  it('applies exponential backoff capped at maxDelayMs', async () => {
    const options: RetryOptions = {
      maxRetries: 5,
      baseDelayMs: 100,
      maxDelayMs: 500,
      onAttempt: vi.fn(),
    };

    const fn = vi.fn().mockRejectedValue(
      new ProviderError('openai', 500, 'fail', { isRetryable: true }),
    );

    const promise = retry(fn, options);
    // Attach a no-op handler so the rejection is "handled" during timer advancement
    promise.catch(() => {});

    // With Math.random = 0.5:
    // attempt 0: min(100 * 2^0, 500) = 100 => 0.5 * 100 = 50
    // attempt 1: min(100 * 2^1, 500) = 200 => 0.5 * 200 = 100
    // attempt 2: min(100 * 2^2, 500) = 400 => 0.5 * 400 = 200
    // attempt 3: min(100 * 2^3, 500) = 500 (capped) => 0.5 * 500 = 250
    // attempt 4: min(100 * 2^4, 500) = 500 (capped) => 0.5 * 500 = 250
    for (const delay of [50, 100, 200, 250, 250]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    await expect(promise).rejects.toThrow(RetryExhaustedError);

    const onAttempt = options.onAttempt as ReturnType<typeof vi.fn>;
    expect(onAttempt).toHaveBeenCalledTimes(5);
    expect(onAttempt.mock.calls.map((c: unknown[]) => c[2])).toEqual([50, 100, 200, 250, 250]);
  });

  // ----------------------------------------------------------------
  // Custom isRetryable
  // ----------------------------------------------------------------
  it('respects custom isRetryable predicate', async () => {
    const customErr = new Error('custom transient');
    const fn = vi.fn()
      .mockRejectedValueOnce(customErr)
      .mockResolvedValue('ok');

    const isRetryable = (err: Error) => err.message.includes('transient');

    const promise = retry(fn, { ...baseOptions, isRetryable });
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('custom isRetryable rejects non-matching errors immediately', async () => {
    const fatalErr = new Error('fatal');
    const fn = vi.fn().mockRejectedValue(fatalErr);

    const isRetryable = (err: Error) => err.message.includes('transient');

    await expect(retry(fn, { ...baseOptions, isRetryable })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // RateLimitError without retryAfterMs falls back to computed backoff
  // ----------------------------------------------------------------
  it('uses computed backoff when RateLimitError has no retryAfterMs', async () => {
    const rateLimitErr = new RateLimitError('openai');
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue('ok');

    const onAttempt = vi.fn();
    const promise = retry(fn, { ...baseOptions, onAttempt });

    // Computed: 0.5 * 100 = 50ms (attempt 0)
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe('ok');
    expect(onAttempt).toHaveBeenCalledWith(0, rateLimitErr, 50);
  });

  // ----------------------------------------------------------------
  // maxRetries = 0 means no retries
  // ----------------------------------------------------------------
  it('does not retry when maxRetries is 0', async () => {
    const err = new ProviderError('openai', 500, 'fail', { isRetryable: true });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      retry(fn, { ...baseOptions, maxRetries: 0 }),
    ).rejects.toThrow(RetryExhaustedError);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
