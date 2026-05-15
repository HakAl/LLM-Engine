import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalMLXProvider } from '../../providers/local-mlx.js';

function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LocalMLXProvider', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('uses the local-mlx id and name', () => {
      const provider = new LocalMLXProvider();
      expect(provider.id).toBe('local-mlx');
      expect(provider.name).toBe('Local MLX');
    });
  });

  describe('default configuration', () => {
    it('targets the mlx_lm.server default at 127.0.0.1:8080', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({ data: [{ id: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit' }] }),
      );

      const provider = new LocalMLXProvider();
      await provider.fetchModels();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe('http://127.0.0.1:8080/v1/models');
    });

    it('uses "none" placeholder API key when none is supplied', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ data: [] }));

      const provider = new LocalMLXProvider();
      await provider.fetchModels();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer none');
    });
  });

  describe('configuration overrides', () => {
    it('honours a custom base URL', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ data: [] }));

      const provider = new LocalMLXProvider('none', {
        baseUrl: 'http://192.168.1.42:9000/v1',
      });
      await provider.fetchModels();

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe('http://192.168.1.42:9000/v1/models');
    });

    it('honours a custom API key', async () => {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse({ data: [] }));

      const provider = new LocalMLXProvider('local-secret');
      await provider.fetchModels();

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer local-secret');
    });
  });

  describe('fetchModels', () => {
    it('returns models from /v1/models in the standard shape', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockJsonResponse({
          data: [
            {
              id: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
              object: 'model',
            },
          ],
        }),
      );

      const provider = new LocalMLXProvider();
      const models = await provider.fetchModels();

      expect(models).toHaveLength(1);
      expect(models[0]).toEqual({
        id: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
        name: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
        provider: 'local-mlx',
        contextWindow: 0,
        capabilities: [],
      });
    });

    it('surfaces ECONNREFUSED as a fetch error, not a crash', async () => {
      const refused = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
          code: 'ECONNREFUSED',
        }),
      });
      fetchSpy.mockRejectedValueOnce(refused);

      const provider = new LocalMLXProvider();

      // The provider should propagate the fetch error rather than swallowing
      // it. Registry.create then catches the rejection via Promise.allSettled
      // and excludes the provider — that is the "provider unavailable" path.
      await expect(provider.fetchModels()).rejects.toThrow(/fetch failed/);
    });
  });

  describe('chat request translation', () => {
    function streamingResponse(body: string): Response {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    it('POSTs to /v1/chat/completions with stream:true and OpenAI body', async () => {
      const sseBody =
        'data: {"id":"x","model":"mlx","choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n';
      fetchSpy.mockResolvedValueOnce(streamingResponse(sseBody));

      const provider = new LocalMLXProvider();
      await provider.chat({
        model: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.4,
        maxTokens: 64,
      });

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        model: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        temperature: 0.4,
        max_tokens: 64,
      });
    });
  });
});
