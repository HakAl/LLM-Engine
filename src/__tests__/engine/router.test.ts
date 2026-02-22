import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router, type RouterConfig } from '../../engine/router.js';
import { RateLimiter } from '../../engine/rate-limiter.js';
import { CircuitBreaker } from '../../engine/circuit-breaker.js';
import { Registry } from '../../providers/registry.js';
import type {
  Provider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
} from '../../providers/types.js';
import type { RequestOptions } from '../../engine/types.js';
import {
  AllProvidersUnavailableError,
  StreamInterruptedError,
  ProviderError,
} from '../../errors.js';

// ── Mock Provider Factory ──────────────────────────────────────────

function createMockProvider(
  id: string,
  name: string,
  overrides?: {
    chat?: Provider['chat'];
    chatStream?: Provider['chatStream'];
    fetchModels?: Provider['fetchModels'];
  },
): Provider {
  const models: ModelInfo[] = [
    {
      id: 'gpt-4',
      name: 'GPT-4',
      provider: id,
      contextWindow: 8192,
      capabilities: ['chat'],
    },
  ];

  return {
    id,
    name,
    fetchModels: overrides?.fetchModels ?? vi.fn<Provider['fetchModels']>().mockResolvedValue(models),
    chat: overrides?.chat ?? vi.fn<Provider['chat']>().mockResolvedValue({
      content: `Response from ${id}`,
      model: 'gpt-4',
      provider: id,
      finishReason: 'stop',
    }),
    chatStream: overrides?.chatStream ?? vi.fn<Provider['chatStream']>().mockImplementation(
      function () {
        return (async function* () {
          yield { delta: 'Hello', model: 'gpt-4', provider: id };
          yield { delta: ' world', model: 'gpt-4', provider: id, finishReason: 'stop' };
        })();
      },
    ),
  };
}

/**
 * Create a chatStream mock that yields chunks then throws mid-stream.
 */
function createFailingStreamAfterChunks(
  providerId: string,
  chunksBeforeError: number,
  error: Error,
): Provider['chatStream'] {
  return vi.fn<Provider['chatStream']>().mockImplementation(function () {
    let count = 0;
    return (async function* () {
      while (count < chunksBeforeError) {
        yield { delta: `chunk-${count}`, model: 'gpt-4', provider: providerId };
        count++;
      }
      throw error;
    })();
  });
}

/**
 * Create a chatStream mock that fails immediately (before first chunk).
 */
function createImmediatelyFailingStream(error: Error): Provider['chatStream'] {
  return vi.fn<Provider['chatStream']>().mockImplementation(function () {
    return (async function* () {
      throw error;
    })();
  });
}

// ── Test Helpers ───────────────────────────────────────────────────

async function collectStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function buildRouter(
  providers: Provider[],
  overrides?: Partial<RouterConfig>,
): Promise<Router> {
  const registry = await Registry.create(providers);
  const rateLimiter = new RateLimiter({ seedRpm: 100 });
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    maxCooldownMs: 16000,
  });

  return new Router({
    registry,
    rateLimiter,
    circuitBreaker,
    providerPriority: providers.map((p) => p.id),
    retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 },
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Router', () => {
  const defaultRequest: ChatRequest = {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  // ----------------------------------------------------------------
  // 1. Single provider success (chat + stream)
  // ----------------------------------------------------------------
  describe('single provider success', () => {
    it('executes a chat request and returns assembled response', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const router = await buildRouter([provider]);

      const response = await router.execute(defaultRequest);

      expect(response.content).toBe('Hello world');
      expect(response.model).toBe('gpt-4');
      expect(response.provider).toBe('openai');
      expect(response.finishReason).toBe('stop');
    });

    it('streams a chat request and yields chunks', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const router = await buildRouter([provider]);

      const chunks = await collectStream(router.executeStream(defaultRequest));

      expect(chunks).toHaveLength(2);
      expect(chunks[0].delta).toBe('Hello');
      expect(chunks[1].delta).toBe(' world');
      expect(chunks[1].finishReason).toBe('stop');
    });
  });

  // ----------------------------------------------------------------
  // 2. Provider fails with retryable error -> retry succeeds
  // ----------------------------------------------------------------
  describe('retry on retryable error', () => {
    it('retries and succeeds on second attempt', async () => {
      let callCount = 0;
      const chatStream: Provider['chatStream'] = vi.fn().mockImplementation(function () {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            throw new ProviderError('openai', 500, 'server error', { isRetryable: true });
          })();
        }
        return (async function* () {
          yield { delta: 'Recovered', model: 'gpt-4', provider: 'openai', finishReason: 'stop' };
        })();
      });

      const provider = createMockProvider('openai', 'OpenAI', { chatStream });
      const router = await buildRouter([provider]);

      const response = await router.execute(defaultRequest);

      expect(response.content).toBe('Recovered');
      expect(chatStream).toHaveBeenCalledTimes(2);
    });
  });

  // ----------------------------------------------------------------
  // 3. Provider fails -> fallback to second provider
  // ----------------------------------------------------------------
  describe('fallback to next provider', () => {
    it('falls back when first provider exhausts retries', async () => {
      const failingStream = createImmediatelyFailingStream(
        new ProviderError('openai', 500, 'down', { isRetryable: true }),
      );
      const providerA = createMockProvider('openai', 'OpenAI', {
        chatStream: failingStream,
      });

      const providerB = createMockProvider('anthropic', 'Anthropic');
      // Make providerB also serve gpt-4 for this test
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const router = await buildRouter([providerA, providerB]);

      const response = await router.execute(defaultRequest);

      expect(response.provider).toBe('anthropic');
      expect(response.content).toBe('Hello world');
    });
  });

  // ----------------------------------------------------------------
  // 4. All providers fail -> AllProvidersUnavailableError with details
  // ----------------------------------------------------------------
  describe('all providers unavailable', () => {
    it('throws AllProvidersUnavailableError with per-provider details', async () => {
      const failA = createImmediatelyFailingStream(
        new ProviderError('openai', 500, 'openai down', { isRetryable: true }),
      );
      const failB = createImmediatelyFailingStream(
        new ProviderError('anthropic', 503, 'anthropic down', { isRetryable: true }),
      );

      const providerA = createMockProvider('openai', 'OpenAI', { chatStream: failA });
      const providerB = createMockProvider('anthropic', 'Anthropic', { chatStream: failB });
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const router = await buildRouter([providerA, providerB]);

      await expect(router.execute(defaultRequest)).rejects.toThrow(
        AllProvidersUnavailableError,
      );

      try {
        await router.execute(defaultRequest);
      } catch (err) {
        const apue = err as AllProvidersUnavailableError;
        expect(apue.failures.length).toBeGreaterThanOrEqual(2);
        expect(apue.failures.some((f) => f.provider === 'openai')).toBe(true);
        expect(apue.failures.some((f) => f.provider === 'anthropic')).toBe(true);
      }
    });

    it('throws when no providers serve the requested model', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const router = await buildRouter([provider]);

      const badRequest: ChatRequest = {
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      await expect(router.execute(badRequest)).rejects.toThrow(
        AllProvidersUnavailableError,
      );
    });
  });

  // ----------------------------------------------------------------
  // 5. Mid-stream failure -> StreamInterruptedError, no fallback
  // ----------------------------------------------------------------
  describe('mid-stream failure', () => {
    it('throws StreamInterruptedError when stream fails after yielding chunks', async () => {
      const chatStream = createFailingStreamAfterChunks(
        'openai',
        2,
        new Error('connection reset'),
      );

      const providerA = createMockProvider('openai', 'OpenAI', { chatStream });
      const providerB = createMockProvider('anthropic', 'Anthropic');
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const router = await buildRouter([providerA, providerB]);

      const chunks: StreamChunk[] = [];
      await expect(async () => {
        for await (const chunk of router.executeStream(defaultRequest)) {
          chunks.push(chunk);
        }
      }).rejects.toThrow(StreamInterruptedError);

      // Should have received 2 chunks before the error
      expect(chunks).toHaveLength(2);

      // Should NOT have fallen back to providerB
      expect(chunks.every((c) => c.provider === 'openai')).toBe(true);
    });

    it('includes chunksEmitted count in StreamInterruptedError', async () => {
      const chatStream = createFailingStreamAfterChunks(
        'openai',
        3,
        new Error('timeout'),
      );

      const provider = createMockProvider('openai', 'OpenAI', { chatStream });
      const router = await buildRouter([provider]);

      try {
        for await (const _chunk of router.executeStream(defaultRequest)) {
          // consume
        }
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StreamInterruptedError);
        const sie = err as StreamInterruptedError;
        expect(sie.chunksEmitted).toBe(3);
        expect(sie.provider).toBe('openai');
      }
    });
  });

  // ----------------------------------------------------------------
  // 6. Pre-stream failure -> fallback to next provider
  // ----------------------------------------------------------------
  describe('pre-stream failure triggers fallback', () => {
    it('falls back when provider fails before yielding any chunks', async () => {
      // Provider A: fails immediately (non-retryable for faster test)
      const chatStreamA: Provider['chatStream'] = vi.fn().mockImplementation(function () {
        return (async function* () {
          throw new ProviderError('openai', 400, 'bad request', { isRetryable: false });
        })();
      });

      const providerA = createMockProvider('openai', 'OpenAI', { chatStream: chatStreamA });
      const providerB = createMockProvider('anthropic', 'Anthropic');
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const router = await buildRouter([providerA, providerB]);

      const chunks = await collectStream(router.executeStream(defaultRequest));

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].provider).toBe('anthropic');
    });
  });

  // ----------------------------------------------------------------
  // 7. Circuit breaker rejects provider -> skipped
  // ----------------------------------------------------------------
  describe('circuit breaker gating', () => {
    it('skips providers with open circuit breakers', async () => {
      const providerA = createMockProvider('openai', 'OpenAI');
      const providerB = createMockProvider('anthropic', 'Anthropic');
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 60_000,
        maxCooldownMs: 60_000,
      });

      // Trip the circuit breaker for openai
      circuitBreaker.recordFailure('openai');

      const registry = await Registry.create([providerA, providerB]);

      const router = new Router({
        registry,
        rateLimiter: new RateLimiter({ seedRpm: 100 }),
        circuitBreaker,
        providerPriority: ['openai', 'anthropic'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      const response = await router.execute(defaultRequest);

      // Should have skipped openai and gone to anthropic
      expect(response.provider).toBe('anthropic');
      // openai's chatStream should never have been called
      expect(providerA.chatStream).not.toHaveBeenCalled();
    });

    it('records circuit-open in failure details when all are circuit-broken', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 60_000,
        maxCooldownMs: 60_000,
      });
      circuitBreaker.recordFailure('openai');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter: new RateLimiter({ seedRpm: 100 }),
        circuitBreaker,
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      try {
        await router.execute(defaultRequest);
        expect.unreachable('Should have thrown');
      } catch (err) {
        const apue = err as AllProvidersUnavailableError;
        expect(apue).toBeInstanceOf(AllProvidersUnavailableError);
        expect(apue.failures).toHaveLength(1);
        expect(apue.failures[0].reason).toBe('circuit-open');
      }
    });
  });

  // ----------------------------------------------------------------
  // 8. Rate limiter denies provider -> skipped
  // ----------------------------------------------------------------
  describe('rate limiter gating', () => {
    it('skips providers that are rate limited', async () => {
      const providerA = createMockProvider('openai', 'OpenAI');
      const providerB = createMockProvider('anthropic', 'Anthropic');
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      // Create a rate limiter with very low RPM for openai
      const rateLimiter = new RateLimiter({
        seedRpm: 1, // 1 RPM
      });

      const registry = await Registry.create([providerA, providerB]);
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 16000,
      });

      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker,
        providerPriority: ['openai', 'anthropic'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      // First call should succeed for openai (uses the 1 RPM budget)
      const response1 = await router.execute(defaultRequest);
      expect(response1.provider).toBe('openai');

      // Second call should skip openai (rate limited) and go to anthropic
      const response2 = await router.execute(defaultRequest);
      expect(response2.provider).toBe('anthropic');
    });

    it('records rate-limited in failure details', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const rateLimiter = new RateLimiter({ seedRpm: 1 });
      const registry = await Registry.create([provider]);
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 16000,
      });

      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker,
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      // Exhaust the rate limit
      await router.execute(defaultRequest);

      // Now it should fail with rate-limited
      try {
        await router.execute(defaultRequest);
        expect.unreachable('Should have thrown');
      } catch (err) {
        const apue = err as AllProvidersUnavailableError;
        expect(apue).toBeInstanceOf(AllProvidersUnavailableError);
        expect(apue.failures.some((f) => f.reason === 'rate-limited')).toBe(true);
      }
    });
  });

  // ----------------------------------------------------------------
  // 9. Abort signal cancels during execution
  // ----------------------------------------------------------------
  describe('abort signal', () => {
    it('aborts execution when signal is triggered', async () => {
      const controller = new AbortController();

      // Create a provider that yields one chunk then waits for abort
      const chatStream: Provider['chatStream'] = vi.fn().mockImplementation(function () {
        return (async function* () {
          yield { delta: 'start', model: 'gpt-4', provider: 'openai' };
          // Simulate a long wait, checking abort state immediately
          await new Promise<void>((_, reject) => {
            // If already aborted, reject immediately
            if (controller.signal.aborted) {
              reject(controller.signal.reason ?? new DOMException('aborted', 'AbortError'));
              return;
            }
            controller.signal.addEventListener('abort', () => {
              reject(controller.signal.reason ?? new DOMException('aborted', 'AbortError'));
            });
          });
        })();
      });

      const provider = createMockProvider('openai', 'OpenAI', { chatStream });
      const router = await buildRouter([provider]);

      const chunks: StreamChunk[] = [];
      const streamPromise = (async () => {
        for await (const chunk of router.executeStream(defaultRequest, {
          signal: controller.signal,
        })) {
          chunks.push(chunk);
          // Abort after receiving first chunk
          controller.abort(new DOMException('user cancelled', 'AbortError'));
        }
      })();

      await expect(streamPromise).rejects.toThrow(StreamInterruptedError);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].delta).toBe('start');
    });

    it('throws immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new DOMException('pre-aborted', 'AbortError'));

      const provider = createMockProvider('openai', 'OpenAI');
      const router = await buildRouter([provider]);

      // The provider should never be called when signal is pre-aborted
      // The retry wrapper will check the signal first
      await expect(
        router.execute(defaultRequest, { signal: controller.signal }),
      ).rejects.toThrow();

      // Provider stream should not have been called (or was called but immediately aborted)
    });
  });

  // ----------------------------------------------------------------
  // 10. Token reconciliation called after success
  // ----------------------------------------------------------------
  describe('token reconciliation', () => {
    it('calls reconcile on rate limiter after successful stream', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const rateLimiter = new RateLimiter({ seedRpm: 100 });
      const reconcileSpy = vi.spyOn(rateLimiter, 'reconcile');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker: new CircuitBreaker({
          failureThreshold: 3,
          cooldownMs: 1000,
          maxCooldownMs: 16000,
        }),
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await router.execute(defaultRequest);

      // estimateTokens('Hello') = ceil(5/4) + 1000 = 1002
      expect(reconcileSpy).toHaveBeenCalledWith('openai', 1002, undefined);
    });
  });

  // ----------------------------------------------------------------
  // 11. Rate limit headers recorded after response
  // ----------------------------------------------------------------
  describe('circuit breaker feedback', () => {
    it('records success to circuit breaker after first chunk', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 16000,
      });
      const successSpy = vi.spyOn(circuitBreaker, 'recordSuccess');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter: new RateLimiter({ seedRpm: 100 }),
        circuitBreaker,
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await router.execute(defaultRequest);

      expect(successSpy).toHaveBeenCalledWith('openai');
    });

    it('records failure to circuit breaker when provider fails pre-stream', async () => {
      const chatStream = createImmediatelyFailingStream(
        new ProviderError('openai', 400, 'bad request', { isRetryable: false }),
      );
      const provider = createMockProvider('openai', 'OpenAI', { chatStream });

      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 16000,
      });
      const failureSpy = vi.spyOn(circuitBreaker, 'recordFailure');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter: new RateLimiter({ seedRpm: 100 }),
        circuitBreaker,
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      await expect(router.execute(defaultRequest)).rejects.toThrow(
        AllProvidersUnavailableError,
      );

      expect(failureSpy).toHaveBeenCalledWith('openai');
    });
  });

  // ----------------------------------------------------------------
  // Provider status
  // ----------------------------------------------------------------
  describe('getProviderStatus', () => {
    it('returns status for all providers in priority order', async () => {
      const providerA = createMockProvider('openai', 'OpenAI');
      const providerB = createMockProvider('anthropic', 'Anthropic');

      const registry = await Registry.create([providerA, providerB]);
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 1000,
        maxCooldownMs: 16000,
      });
      const rateLimiter = new RateLimiter({ seedRpm: 100 });

      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker,
        providerPriority: ['openai', 'anthropic'],
      });

      const statuses = router.getProviderStatus();

      expect(statuses).toHaveLength(2);
      expect(statuses[0].id).toBe('openai');
      expect(statuses[0].name).toBe('OpenAI');
      expect(statuses[0].state).toBe('healthy');
      expect(statuses[0].circuitState).toBe('closed');
      expect(statuses[1].id).toBe('anthropic');
    });

    it('reflects degraded/unavailable states', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const registry = await Registry.create([provider]);
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 60_000,
        maxCooldownMs: 60_000,
      });
      circuitBreaker.recordFailure('openai');

      const router = new Router({
        registry,
        rateLimiter: new RateLimiter({ seedRpm: 100 }),
        circuitBreaker,
        providerPriority: ['openai'],
      });

      const statuses = router.getProviderStatus();
      expect(statuses[0].state).toBe('unavailable');
      expect(statuses[0].circuitState).toBe('open');
    });
  });

  // ----------------------------------------------------------------
  // Token estimation
  // ----------------------------------------------------------------
  describe('token estimation', () => {
    it('passes token estimate to rate limiter acquire', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const rateLimiter = new RateLimiter({ seedRpm: 100 });
      const acquireSpy = vi.spyOn(rateLimiter, 'acquire');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker: new CircuitBreaker({
          failureThreshold: 3,
          cooldownMs: 1000,
          maxCooldownMs: 16000,
        }),
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      const request: ChatRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello world' }], // 11 chars
        maxTokens: 500,
      };

      await router.execute(request);

      // Expected: Math.ceil(11 / 4) + 500 = 3 + 500 = 503
      expect(acquireSpy).toHaveBeenCalledWith('openai', 503);
    });

    it('uses default maxTokens of 1000 when not specified', async () => {
      const provider = createMockProvider('openai', 'OpenAI');
      const rateLimiter = new RateLimiter({ seedRpm: 100 });
      const acquireSpy = vi.spyOn(rateLimiter, 'acquire');

      const registry = await Registry.create([provider]);
      const router = new Router({
        registry,
        rateLimiter,
        circuitBreaker: new CircuitBreaker({
          failureThreshold: 3,
          cooldownMs: 1000,
          maxCooldownMs: 16000,
        }),
        providerPriority: ['openai'],
        retry: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      });

      // "Hello" = 5 chars, no maxTokens
      await router.execute(defaultRequest);

      // Expected: Math.ceil(5 / 4) + 1000 = 2 + 1000 = 1002
      expect(acquireSpy).toHaveBeenCalledWith('openai', 1002);
    });
  });

  // ----------------------------------------------------------------
  // Priority ordering
  // ----------------------------------------------------------------
  describe('provider priority', () => {
    it('tries providers in priority order', async () => {
      const callOrder: string[] = [];

      const streamA: Provider['chatStream'] = vi.fn().mockImplementation(function () {
        callOrder.push('openai');
        return (async function* () {
          yield { delta: 'A', model: 'gpt-4', provider: 'openai', finishReason: 'stop' };
        })();
      });

      const streamB: Provider['chatStream'] = vi.fn().mockImplementation(function () {
        callOrder.push('anthropic');
        return (async function* () {
          yield { delta: 'B', model: 'gpt-4', provider: 'anthropic', finishReason: 'stop' };
        })();
      });

      const providerA = createMockProvider('openai', 'OpenAI', { chatStream: streamA });
      const providerB = createMockProvider('anthropic', 'Anthropic', { chatStream: streamB });
      (providerB.fetchModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'gpt-4', name: 'GPT-4', provider: 'anthropic', contextWindow: 8192, capabilities: ['chat'] },
      ]);

      const router = await buildRouter([providerA, providerB]);
      const response = await router.execute(defaultRequest);

      expect(response.provider).toBe('openai');
      expect(callOrder).toEqual(['openai']);
      // providerB should never have been tried
      expect(streamB).not.toHaveBeenCalled();
    });
  });
});
