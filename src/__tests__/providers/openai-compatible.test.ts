import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../../providers/base/openai-compatible.js';
import type { ChatRequest, StreamChunk } from '../../providers/types.js';
import type { RateLimitWindow } from '../../engine/types.js';
import {
  AuthError,
  RateLimitError,
  ProviderError,
  TimeoutError,
  StreamInterruptedError,
} from '../../errors.js';

// ---------------------------------------------------------------------------
// Test subclass -- concrete implementation of the abstract base
// ---------------------------------------------------------------------------

class TestProvider extends OpenAICompatibleProvider {
  readonly id = 'test-provider';
  readonly name = 'Test Provider';

  constructor(config?: { cacheTtlMs?: number }) {
    super(config);
  }

  protected get baseUrl(): string {
    return 'https://api.test-provider.com/v1';
  }

  protected authHeader(): string {
    return 'Bearer test-api-key';
  }
}

// ---------------------------------------------------------------------------
// Helpers for building SSE payloads
// ---------------------------------------------------------------------------

function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}

function sseChatChunk(content: string, model: string, finishReason?: string | null): string {
  const choice: Record<string, unknown> = {
    delta: { content },
    index: 0,
  };
  if (finishReason !== undefined) {
    choice['finish_reason'] = finishReason;
  }
  return sseEvent(JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model,
    choices: [choice],
  }));
}

function sseDone(): string {
  return sseEvent('[DONE]');
}

/**
 * Create a ReadableStream from an array of string chunks.
 * Each string is encoded as a Uint8Array and enqueued separately,
 * simulating how a real SSE stream arrives in fragments.
 */
function createSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * Create a ReadableStream that fails mid-stream after emitting some chunks.
 */
function createFailingSSEStream(
  successChunks: string[],
  error: Error,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < successChunks.length) {
        controller.enqueue(encoder.encode(successChunks[index]!));
        index++;
      } else {
        controller.error(error);
      }
    },
  });
}

/**
 * Build a mock Response with a streaming body.
 */
function mockStreamResponse(
  body: ReadableStream<Uint8Array>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/event-stream',
      ...headers,
    },
  });
}

/**
 * Build a mock JSON response (non-streaming).
 */
function mockJsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

/**
 * Build a mock text/HTML response (for error scenarios).
 */
function mockTextResponse(
  text: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/html',
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Standard request fixture
// ---------------------------------------------------------------------------

const chatRequest: ChatRequest = {
  model: 'gpt-4',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ],
  temperature: 0.7,
  maxTokens: 100,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider', () => {
  let provider: TestProvider;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new TestProvider();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // chatStream — successful streaming
  // -------------------------------------------------------------------------

  describe('chatStream', () => {
    it('yields StreamChunks from SSE events and stops at [DONE]', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('Hello', 'gpt-4'),
        sseChatChunk(' world', 'gpt-4'),
        sseChatChunk('!', 'gpt-4', 'stop'),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.chatStream(chatRequest)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({
        delta: 'Hello',
        model: 'gpt-4',
        provider: 'test-provider',
        finishReason: undefined,
      });
      expect(chunks[1]).toEqual({
        delta: ' world',
        model: 'gpt-4',
        provider: 'test-provider',
        finishReason: undefined,
      });
      expect(chunks[2]).toEqual({
        delta: '!',
        model: 'gpt-4',
        provider: 'test-provider',
        finishReason: 'stop',
      });
    });

    it('sends correct request body with stream: true', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('ok', 'gpt-4', 'stop'),
        sseDone(),
      ]);
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.chatStream(chatRequest)) {
        chunks.push(chunk);
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.test-provider.com/v1/chat/completions');

      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        model: 'gpt-4',
        messages: chatRequest.messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 100,
      });

      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-api-key');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('handles SSE chunks split across read boundaries', async () => {
      // Split a single SSE event across multiple stream reads
      const fullEvent = sseChatChunk('split test', 'gpt-4', 'stop');
      const mid = Math.floor(fullEvent.length / 2);

      const sseBody = createSSEStream([
        fullEvent.slice(0, mid),
        fullEvent.slice(mid),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.chatStream(chatRequest)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.delta).toBe('split test');
    });
  });

  // -------------------------------------------------------------------------
  // chat — non-streaming (collects stream)
  // -------------------------------------------------------------------------

  describe('chat', () => {
    it('collects streamed chunks into a single ChatResponse', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('Hello', 'gpt-4'),
        sseChatChunk(' world', 'gpt-4'),
        sseChatChunk('!', 'gpt-4', 'stop'),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const result = await provider.chat(chatRequest);

      expect(result).toEqual({
        content: 'Hello world!',
        model: 'gpt-4',
        provider: 'test-provider',
        finishReason: 'stop',
      });
    });

    it('defaults finishReason to "stop" when stream provides none', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('ok', 'gpt-4'),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const result = await provider.chat(chatRequest);
      expect(result.finishReason).toBe('stop');
    });
  });

  // -------------------------------------------------------------------------
  // Mid-stream failure
  // -------------------------------------------------------------------------

  describe('mid-stream failure', () => {
    it('throws StreamInterruptedError when stream read fails', async () => {
      const failingBody = createFailingSSEStream(
        [sseChatChunk('partial', 'gpt-4')],
        new Error('network down'),
      );

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(failingBody));

      const chunks: StreamChunk[] = [];

      await expect(async () => {
        for await (const chunk of provider.chatStream(chatRequest)) {
          chunks.push(chunk);
        }
      }).rejects.toThrow(StreamInterruptedError);

      // Should have emitted the chunk before the failure
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.delta).toBe('partial');
    });

    it('includes correct chunksEmitted count in StreamInterruptedError', async () => {
      const failingBody = createFailingSSEStream(
        [
          sseChatChunk('a', 'gpt-4'),
          sseChatChunk('b', 'gpt-4'),
        ],
        new Error('connection reset'),
      );

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(failingBody));

      try {
        for await (const _chunk of provider.chatStream(chatRequest)) {
          // consume
        }
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(StreamInterruptedError);
        const sie = error as StreamInterruptedError;
        expect(sie.chunksEmitted).toBe(2);
        expect(sie.provider).toBe('test-provider');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Error normalization
  // -------------------------------------------------------------------------

  describe('error normalization', () => {
    it('throws AuthError on 401', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Invalid API key' } }, 401),
      );

      await expect(provider.chat(chatRequest)).rejects.toThrow(AuthError);

      try {
        await provider.chat(chatRequest);
      } catch (error) {
        // fetch is already exhausted; re-mock for this assertion
      }
    });

    it('AuthError includes provider context', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Invalid API key' } }, 401),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
        const ae = error as AuthError;
        expect(ae.provider).toBe('test-provider');
        expect(ae.message).toContain('test-provider');
        expect(ae.message).toContain('gpt-4');
      }
    });

    it('throws RateLimitError on 429 with Retry-After header', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse(
          { error: { message: 'Rate limited' } },
          429,
          { 'retry-after': '30' },
        ),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        const rle = error as RateLimitError;
        expect(rle.provider).toBe('test-provider');
        expect(rle.retryAfterMs).toBe(30_000);
      }
    });

    it('throws RateLimitError on 429 without Retry-After header', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'slow down' } }, 429),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        const rle = error as RateLimitError;
        expect(rle.retryAfterMs).toBeUndefined();
      }
    });

    it('throws retryable ProviderError on 500', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Internal error' } }, 500),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.statusCode).toBe(500);
        expect(pe.isRetryable).toBe(true);
        expect(pe.provider).toBe('test-provider');
      }
    });

    it('throws retryable ProviderError on 503', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Service unavailable' } }, 503),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.statusCode).toBe(503);
        expect(pe.isRetryable).toBe(true);
      }
    });

    it('throws non-retryable ProviderError on 400', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Bad request' } }, 400),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.statusCode).toBe(400);
        expect(pe.isRetryable).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Non-JSON error bodies
  // -------------------------------------------------------------------------

  describe('non-JSON error body handling', () => {
    it('handles HTML error body on 503 gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockTextResponse(
          '<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>',
          503,
        ),
      );

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.statusCode).toBe(503);
        expect(pe.isRetryable).toBe(true);
        // The message should contain some portion of the HTML body
        expect(pe.message).toContain('503 Service Temporarily Unavailable');
      }
    });

    it('handles empty error body gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }));

      try {
        await provider.chat(chatRequest);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        const pe = error as ProviderError;
        expect(pe.statusCode).toBe(502);
        expect(pe.message).toContain('HTTP 502');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Abort signal
  // -------------------------------------------------------------------------

  describe('abort signal', () => {
    it('passes signal to fetch and propagates AbortError', async () => {
      const controller = new AbortController();

      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        // Simulate immediate abort
        if (init.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw new DOMException('The operation was aborted.', 'AbortError');
      });

      controller.abort();

      await expect(
        provider.chat(chatRequest, { signal: controller.signal }),
      ).rejects.toThrow(DOMException);

      // Verify signal was passed to fetch
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
    });

    it('user cancellation produces native AbortError, not TimeoutError', async () => {
      const controller = new AbortController();

      fetchSpy.mockImplementation(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      });

      controller.abort();

      try {
        await provider.chat(chatRequest, { signal: controller.signal });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect(error).not.toBeInstanceOf(TimeoutError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('produces TimeoutError when timeout fires', async () => {
      fetchSpy.mockImplementation(async () => {
        // Simulate timeout-triggered abort from AbortSignal.timeout()
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });

      try {
        await provider.chat(chatRequest, { timeoutMs: 100 });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutError);
      }
    });

    it('passes a signal to fetch when timeoutMs is provided', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('ok', 'gpt-4', 'stop'),
        sseDone(),
      ]);
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      await provider.chat(chatRequest, { timeoutMs: 5000 });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeDefined();
    });

    it('merges signal and timeoutMs via AbortSignal.any()', async () => {
      const controller = new AbortController();
      const sseBody = createSSEStream([
        sseChatChunk('ok', 'gpt-4', 'stop'),
        sseDone(),
      ]);
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      await provider.chat(chatRequest, {
        signal: controller.signal,
        timeoutMs: 30_000,
      });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      // When both are provided, the signal should be a composite (not the original controller signal)
      expect(init.signal).toBeDefined();
      // The composed signal should not be the raw controller signal
      expect(init.signal).not.toBe(controller.signal);
    });
  });

  // -------------------------------------------------------------------------
  // fetchModels — caching
  // -------------------------------------------------------------------------

  describe('fetchModels', () => {
    const modelsResponse = {
      data: [
        { id: 'gpt-4', context_window: 8192 },
        { id: 'gpt-3.5-turbo', context_window: 4096 },
      ],
    };

    it('fetches models from /models endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(modelsResponse));

      const models = await provider.fetchModels();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe('https://api.test-provider.com/v1/models');

      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({
        id: 'gpt-4',
        name: 'gpt-4',
        provider: 'test-provider',
        contextWindow: 8192,
        capabilities: [],
      });
    });

    it('caches results within TTL', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(modelsResponse));

      const result1 = await provider.fetchModels();
      const result2 = await provider.fetchModels();

      // Only one fetch call -- second was served from cache
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(result1).toEqual(result2);
    });

    it('refetches after cache TTL expires', async () => {
      vi.useFakeTimers();

      const shortTtlProvider = new TestProvider({ cacheTtlMs: 1000 });

      // Each call needs a fresh Response (body can only be read once)
      fetchSpy.mockImplementation(async () => mockJsonResponse(modelsResponse));

      await shortTtlProvider.fetchModels();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(1500);

      await shortTtlProvider.fetchModels();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('serves cached results before TTL expires', async () => {
      vi.useFakeTimers();

      const shortTtlProvider = new TestProvider({ cacheTtlMs: 5000 });

      fetchSpy.mockImplementation(async () => mockJsonResponse(modelsResponse));

      await shortTtlProvider.fetchModels();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance less than TTL
      vi.advanceTimersByTime(2000);

      await shortTtlProvider.fetchModels();
      // Should still be cached
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('passes auth header to models endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(modelsResponse));

      await provider.fetchModels();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-api-key');
    });

    it('normalizes errors from models endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ error: { message: 'Unauthorized' } }, 401),
      );

      await expect(provider.fetchModels()).rejects.toThrow(AuthError);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty delta content gracefully', async () => {
      const sseBody = createSSEStream([
        sseChatChunk('', 'gpt-4'),
        sseChatChunk('content', 'gpt-4', 'stop'),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.chatStream(chatRequest)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.delta).toBe('');
      expect(chunks[1]!.delta).toBe('content');
    });

    it('skips malformed JSON in SSE data without throwing', async () => {
      const sseBody = createSSEStream([
        sseEvent('not valid json'),
        sseChatChunk('valid', 'gpt-4', 'stop'),
        sseDone(),
      ]);

      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      const chunks: StreamChunk[] = [];
      for await (const chunk of provider.chatStream(chatRequest)) {
        chunks.push(chunk);
      }

      // Should only yield the valid chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.delta).toBe('valid');
    });

    it('omits optional fields from request body when not provided', async () => {
      const minimalRequest: ChatRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const sseBody = createSSEStream([
        sseChatChunk('ok', 'gpt-4', 'stop'),
        sseDone(),
      ]);
      fetchSpy.mockResolvedValueOnce(mockStreamResponse(sseBody));

      await provider.chat(minimalRequest);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
    });
  });
});
