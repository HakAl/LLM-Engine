import type { Registry } from '../providers/registry.js';
import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  Provider,
  Usage,
} from '../providers/types.js';
import type {
  RequestOptions,
  ProviderStatus,
  RoutingDecision,
  RateLimitWindow,
} from './types.js';
import { deriveProviderState } from './types.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { retry } from './retry.js';
import {
  AllProvidersUnavailableError,
  StreamInterruptedError,
  TimeoutError,
  type ProviderFailureDetail,
} from '../errors.js';
import type { RouteCompleteEvent, RoutingStep } from '../dashboard/types.js';

export interface RouterConfig {
  registry: Registry;
  rateLimiter: RateLimiter;
  circuitBreaker: CircuitBreaker;
  providerPriority: string[];
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  defaultTimeoutMs?: number;
  onRouteComplete?: (event: RouteCompleteEvent) => void;
}

const DEFAULT_RETRY = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 5000,
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Estimate the token cost of a request for rate limiter pre-reservation.
 *
 * Uses a rough heuristic: ~4 characters per token for prompt, plus
 * the maxTokens budget (or a conservative default) for completion.
 */
function estimateTokens(request: ChatRequest): number {
  const totalChars = request.messages.reduce(
    (sum, msg) => sum + msg.content.length,
    0,
  );
  return Math.ceil(totalChars / 4) + (request.maxTokens ?? 1000);
}

/**
 * Build a combined AbortSignal from optional user signal + timeout.
 *
 * Returns the merged signal and a cleanup function that must be called
 * when the operation completes to clear the timeout timer.
 */
function buildSignal(
  options?: RequestOptions,
  defaultTimeoutMs?: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const userSignal = options?.signal;

  const signals: AbortSignal[] = [];
  let timeoutController: AbortController | undefined;

  if (userSignal) {
    signals.push(userSignal);
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController!.abort(new TimeoutError(timeoutMs)),
      timeoutMs,
    );
    // Store timer reference for cleanup
    const cleanup = () => clearTimeout(timer);
    if (signals.length === 0) {
      return {
        signal: timeoutController.signal,
        cleanup,
      };
    }
    signals.push(timeoutController.signal);
    return {
      signal: AbortSignal.any(signals),
      cleanup,
    };
  }

  if (signals.length === 1) {
    return { signal: signals[0], cleanup: () => {} };
  }

  return { signal: undefined, cleanup: () => {} };
}

/**
 * Router orchestrates provider selection, execution, and fallback.
 *
 * It delegates to the rate limiter, circuit breaker, and retry utilities
 * but does not implement any of that logic itself. Its single
 * responsibility is the orchestration flow:
 *   1. Select eligible providers (priority order, circuit, rate limit)
 *   2. Attempt calls with retry for pre-stream failures
 *   3. Enforce the first-chunk boundary rule
 *   4. Record outcomes for observability and feedback loops
 */
export class Router {
  private readonly config: RouterConfig;
  private readonly retryConfig: Required<NonNullable<RouterConfig['retry']>>;

  constructor(config: RouterConfig) {
    this.config = config;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? DEFAULT_RETRY.maxRetries,
      baseDelayMs: config.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    };
  }

  /**
   * Execute a chat request, collecting the full response.
   *
   * Internally calls executeStream and assembles the result.
   */
  async execute(
    request: ChatRequest,
    options?: RequestOptions,
  ): Promise<ChatResponse> {
    const chunks: StreamChunk[] = [];

    for await (const chunk of this.executeStream(request, options)) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      throw new Error('Stream completed without producing any chunks');
    }

    const lastChunk = chunks[chunks.length - 1];
    const content = chunks.map((c) => c.delta).join('');

    return {
      content,
      model: lastChunk.model,
      provider: lastChunk.provider,
      finishReason: lastChunk.finishReason ?? 'stop',
    };
  }

  /**
   * Stream a chat request with provider fallback.
   *
   * The first-chunk boundary rule:
   * - Before any chunk is yielded: retry within provider, then fallback
   * - After first chunk is yielded: any error throws StreamInterruptedError
   */
  async *executeStream(
    request: ChatRequest,
    options?: RequestOptions,
  ): AsyncIterable<StreamChunk> {
    const { signal, cleanup } = buildSignal(options, this.config.defaultTimeoutMs);
    const tokenEstimate = estimateTokens(request);
    const failures: ProviderFailureDetail[] = [];
    const steps: RoutingStep[] = [];
    const startTime = Date.now();
    let succeededProvider: string | undefined;

    try {
      const candidateProviderIds = this.findCandidateProviders(request.model);

      for (const providerId of candidateProviderIds) {
        // Gate 1: Circuit breaker
        if (!this.config.circuitBreaker.tryProbe(providerId)) {
          steps.push({ provider: providerId, action: 'skipped-circuit-open' });
          failures.push({
            provider: providerId,
            error: new Error(`Circuit breaker open for ${providerId}`),
            reason: 'circuit-open',
          });
          continue;
        }

        // Gate 2: Rate limiter
        const acquireResult = this.config.rateLimiter.acquire(providerId, tokenEstimate);
        if (!acquireResult.granted) {
          steps.push({
            provider: providerId,
            action: 'skipped-rate-limited',
            reason: `wait ${acquireResult.waitMs}ms`,
          });
          failures.push({
            provider: providerId,
            error: new Error(
              `Rate limited for ${providerId}, wait ${acquireResult.waitMs}ms`,
            ),
            reason: 'rate-limited',
          });
          continue;
        }

        // Attempt the call
        const provider = this.config.registry.getProvider(providerId)!;
        const attemptResult = await this.attemptProvider(
          provider,
          request,
          tokenEstimate,
          signal,
        );

        if (attemptResult.type === 'success') {
          steps.push({ provider: providerId, action: 'succeeded' });
          succeededProvider = providerId;
          yield* attemptResult.stream;
          this.emitRouteComplete(request.model, steps, startTime, succeededProvider);
          return;
        }

        // Pre-stream failure -- record and try next provider
        steps.push({
          provider: providerId,
          action: 'failed',
          reason: attemptResult.error.message,
        });
        failures.push({
          provider: providerId,
          error: attemptResult.error,
          reason: 'error',
        });
      }

      this.emitRouteComplete(request.model, steps, startTime, undefined);
      throw new AllProvidersUnavailableError(failures);
    } finally {
      cleanup();
    }
  }

  /**
   * Build a status snapshot of every provider in the priority list.
   */
  getProviderStatus(): ProviderStatus[] {
    return this.config.providerPriority.map((id) => {
      const provider = this.config.registry.getProvider(id);
      const circuitState = this.config.circuitBreaker.getState(id);
      const rateLimits = this.config.rateLimiter.getStatus(id);

      return {
        id,
        name: provider?.name ?? id,
        state: deriveProviderState(circuitState, rateLimits),
        rateLimits,
        circuitState,
      };
    });
  }

  // ---- Private helpers ----

  /**
   * Filter providerPriority to those that serve the requested model
   * according to the registry.
   */
  private findCandidateProviders(modelId: string): string[] {
    const providersForModel = this.config.registry.findProvidersForModel(modelId);
    const providerIdSet = new Set(providersForModel.map((p) => p.id));

    return this.config.providerPriority.filter((id) => providerIdSet.has(id));
  }

  /**
   * Attempt a streaming call to a single provider, wrapped in retry
   * for the pre-stream phase (connecting and getting the first chunk).
   *
   * Returns either a successful stream generator or an error.
   */
  private async attemptProvider(
    provider: Provider,
    request: ChatRequest,
    tokenEstimate: number,
    signal: AbortSignal | undefined,
  ): Promise<
    | { type: 'success'; stream: AsyncGenerator<StreamChunk> }
    | { type: 'failure'; error: Error }
  > {
    try {
      // Wrap the "get first chunk" phase in retry
      const { firstChunk, iterator } = await retry(
        () => this.connectAndGetFirstChunk(provider, request, signal),
        {
          maxRetries: this.retryConfig.maxRetries,
          baseDelayMs: this.retryConfig.baseDelayMs,
          maxDelayMs: this.retryConfig.maxDelayMs,
          signal,
        },
      );

      // First chunk received -- this provider owns the stream.
      // Record success for the connection phase.
      this.config.circuitBreaker.recordSuccess(provider.id);

      // Feed rate-limit headers into the limiter for reactive learning
      const headers = provider.getLastResponseHeaders?.();
      if (headers) {
        this.config.rateLimiter.recordRateLimitResponse(provider.id, headers);
      }

      // Build a generator that yields the first chunk, then the rest,
      // and handles mid-stream errors + cleanup.
      const stream = this.drainStream(
        provider,
        firstChunk,
        iterator,
        tokenEstimate,
      );

      return { type: 'success', stream };
    } catch (error) {
      // Pre-stream failure (all retries exhausted or non-retryable)
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.circuitBreaker.recordFailure(provider.id);
      this.config.rateLimiter.reconcile(provider.id, tokenEstimate, undefined);
      return { type: 'failure', error: err };
    }
  }

  /**
   * Connect to a provider's stream and pull the first chunk.
   *
   * This is the function that gets retried. If the connection fails
   * or the iterator throws before yielding, the retry wrapper catches it.
   */
  private async connectAndGetFirstChunk(
    provider: Provider,
    request: ChatRequest,
    signal: AbortSignal | undefined,
  ): Promise<{
    firstChunk: StreamChunk;
    iterator: AsyncIterator<StreamChunk>;
  }> {
    const stream = provider.chatStream(request, signal ? { signal } : undefined);
    const iterator = stream[Symbol.asyncIterator]();

    const firstResult = await iterator.next();
    if (firstResult.done) {
      throw new Error(`Provider ${provider.id} stream completed without yielding`);
    }

    return { firstChunk: firstResult.value, iterator };
  }

  private emitRouteComplete(
    model: string,
    steps: RoutingStep[],
    startTime: number,
    succeededProvider: string | undefined,
  ): void {
    if (!this.config.onRouteComplete) return;

    const hasFailedSteps = steps.some(
      s => s.action !== 'succeeded',
    );

    let outcome: RouteCompleteEvent['outcome'];
    if (!succeededProvider) {
      outcome = 'all-failed';
    } else if (hasFailedSteps && steps.length > 1) {
      outcome = 'fallback-success';
    } else {
      outcome = 'success';
    }

    this.config.onRouteComplete({
      model,
      steps,
      outcome,
      latencyMs: Date.now() - startTime,
      provider: succeededProvider,
    });
  }

  /**
   * Yield the first chunk and drain the remaining stream.
   *
   * After the first chunk, any error becomes a StreamInterruptedError --
   * no retry, no fallback. This is the "first chunk boundary rule".
   */
  private async *drainStream(
    provider: Provider,
    firstChunk: StreamChunk,
    iterator: AsyncIterator<StreamChunk>,
    tokenEstimate: number,
  ): AsyncGenerator<StreamChunk> {
    let chunksEmitted = 0;

    try {
      yield firstChunk;
      chunksEmitted++;

      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        yield result.value;
        chunksEmitted++;
      }

      // Stream completed successfully -- reconcile tokens
      // (We do not have actual usage from streaming, so pass undefined)
      this.config.rateLimiter.reconcile(provider.id, tokenEstimate, undefined);
    } catch (error) {
      // Mid-stream failure: no retry, no fallback
      // Feed failure back into circuit breaker so repeated mid-stream
      // failures will eventually trip the breaker.
      this.config.circuitBreaker.recordFailure(provider.id);
      this.config.rateLimiter.reconcile(provider.id, tokenEstimate, undefined);

      const err = error instanceof Error ? error : new Error(String(error));
      throw new StreamInterruptedError(provider.id, chunksEmitted, undefined, {
        cause: err,
      });
    }
  }
}
