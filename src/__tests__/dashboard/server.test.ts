import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startDashboardServer } from '../../dashboard/server.js';
import type { Engine } from '../../engine/engine.js';
import type { ChatResponse, StreamChunk, ModelInfo } from '../../providers/types.js';
import type { DashboardStatus } from '../../dashboard/types.js';
import type { ProviderStatus } from '../../engine/types.js';

// ── Mock Engine ────────────────────────────────────────────────────

function createMockEngine(overrides: Partial<Engine> = {}): Engine {
  const mockStatus: DashboardStatus = {
    providers: [
      {
        id: 'groq',
        name: 'Groq',
        state: 'healthy',
        rateLimits: [],
        circuitState: 'closed',
      },
    ],
    models: [
      {
        id: 'llama-3.1-8b',
        name: 'Llama 3.1 8B',
        provider: 'groq',
        contextWindow: 8192,
        capabilities: ['chat'],
      },
    ],
    recentRequests: [],
    timestamp: Date.now(),
  };

  const mockChatResponse: ChatResponse = {
    content: 'Hello from mock!',
    model: 'llama-3.1-8b',
    provider: 'groq',
    finishReason: 'stop',
  };

  return {
    chat: vi.fn().mockResolvedValue(mockChatResponse),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield { delta: 'Hello', model: 'llama-3.1-8b', provider: 'groq' } satisfies StreamChunk;
      yield { delta: ' world', model: 'llama-3.1-8b', provider: 'groq', finishReason: 'stop' } satisfies StreamChunk;
    }),
    getAvailableModels: vi.fn().mockReturnValue(mockStatus.models),
    getProviderStatus: vi.fn().mockReturnValue(mockStatus.providers),
    updateConfig: vi.fn(),
    getDashboardStatus: vi.fn().mockReturnValue(mockStatus),
    onRequestComplete: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as Engine;
}

// ── Helpers ────────────────────────────────────────────────────────

function url(server: { port: number }, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

async function fetchJson(server: { port: number }, path: string, init?: RequestInit) {
  const res = await fetch(url(server, path), init);
  return { res, json: await res.json() };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Dashboard Server', () => {
  let server: { port: number; close: () => void };
  let engine: Engine;

  beforeAll(async () => {
    engine = createMockEngine();
    server = await startDashboardServer({ engine, port: 0 });
  });

  afterAll(() => {
    server.close();
  });

  // ── CORS ─────────────────────────────────────────────────────────

  describe('CORS', () => {
    it('responds to OPTIONS preflight with 204', async () => {
      const res = await fetch(url(server, '/api/status'), { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('includes CORS headers on normal requests', async () => {
      const res = await fetch(url(server, '/api/status'));
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  // ── GET /api/status ──────────────────────────────────────────────

  describe('GET /api/status', () => {
    it('returns 200 with dashboard status', async () => {
      const { res, json } = await fetchJson(server, '/api/status');
      expect(res.status).toBe(200);
      expect(json.providers).toHaveLength(1);
      expect(json.providers[0].id).toBe('groq');
      expect(json.models).toHaveLength(1);
    });

    it('returns application/json content type', async () => {
      const res = await fetch(url(server, '/api/status'));
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  // ── GET /api/models ──────────────────────────────────────────────

  describe('GET /api/models', () => {
    it('returns 200 with model list', async () => {
      const { res, json } = await fetchJson(server, '/api/models');
      expect(res.status).toBe(200);
      expect(Array.isArray(json)).toBe(true);
      expect(json[0].id).toBe('llama-3.1-8b');
    });
  });

  // ── POST /api/chat ───────────────────────────────────────────────

  describe('POST /api/chat', () => {
    it('returns 200 with chat response', async () => {
      const { res, json } = await fetchJson(server, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(json.content).toBe('Hello from mock!');
      expect(json.provider).toBe('groq');
    });

    it('returns 400 when model is missing', async () => {
      const { res, json } = await fetchJson(server, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(400);
      expect(json.error).toContain('model');
    });

    it('returns 400 when messages is empty', async () => {
      const { res, json } = await fetchJson(server, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });
      expect(res.status).toBe(400);
      expect(json.error).toContain('messages');
    });

    it('returns 400 when messages is missing', async () => {
      const { res, json } = await fetchJson(server, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test' }),
      });
      expect(res.status).toBe(400);
      expect(json.error).toContain('messages');
    });

    it('returns 500 when engine.chat throws', async () => {
      const failEngine = createMockEngine({
        chat: vi.fn().mockRejectedValue(new Error('provider exploded')),
      });
      const failServer = await startDashboardServer({ engine: failEngine, port: 0 });
      try {
        const { res, json } = await fetchJson(failServer, '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.1-8b',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        expect(res.status).toBe(500);
        expect(json.error).toContain('provider exploded');
      } finally {
        failServer.close();
      }
    });
  });

  // ── POST /api/chat/stream ────────────────────────────────────────

  describe('POST /api/chat/stream', () => {
    it('returns SSE stream with chunks and [DONE]', async () => {
      const res = await fetch(url(server, '/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const body = await res.text();
      const lines = body.split('\n').filter(l => l.startsWith('data: '));

      expect(lines.length).toBe(3); // 2 chunks + [DONE]
      expect(lines[lines.length - 1]).toBe('data: [DONE]');

      // Parse first chunk
      const first = JSON.parse(lines[0].slice(6));
      expect(first.delta).toBe('Hello');
      expect(first.provider).toBe('groq');
    });

    it('returns 400 when model is missing', async () => {
      const res = await fetch(url(server, '/api/chat/stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(400);
    });

    it('sends error event when stream throws', async () => {
      const failEngine = createMockEngine({
        chatStream: vi.fn().mockImplementation(async function* () {
          yield { delta: 'partial', model: 'test', provider: 'test' } satisfies StreamChunk;
          throw new Error('mid-stream failure');
        }),
      });
      const failServer = await startDashboardServer({ engine: failEngine, port: 0 });
      try {
        const res = await fetch(url(failServer, '/api/chat/stream'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'test',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });

        const body = await res.text();
        const lines = body.split('\n').filter(l => l.startsWith('data: '));

        // Should have partial chunk + error event
        const lastData = lines[lines.length - 1].slice(6);
        const parsed = JSON.parse(lastData);
        expect(parsed.error).toContain('mid-stream failure');
      } finally {
        failServer.close();
      }
    });
  });

  // ── Static Files ─────────────────────────────────────────────────

  describe('Static file serving', () => {
    it('serves index.html at /', async () => {
      const res = await fetch(url(server, '/'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('LLM Engine Dashboard');
    });

    it('serves CSS files with correct content type', async () => {
      const res = await fetch(url(server, '/styles.css'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/css');
    });

    it('serves JS files with correct content type', async () => {
      const res = await fetch(url(server, '/dashboard.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');
    });

    it('returns 404 for missing files', async () => {
      const res = await fetch(url(server, '/nonexistent.txt'));
      expect(res.status).toBe(404);
    });

    it('does not serve files outside ui directory via traversal', async () => {
      // URL normalization resolves /../ to / before the server sees it,
      // so the resolved path falls within uiDir and gets a 404 (not found).
      // This confirms traversal does not leak files from parent directories.
      const res = await fetch(url(server, '/../../../package.json'));
      // Should NOT return 200 with actual package.json content
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain('"llm-engine"');
    });
  });

  // ── POST /v1/chat/completions (non-streaming) ───────────────────

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('returns 200 with OpenAI completion shape', async () => {
      const { res, json } = await fetchJson(server, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(json.object).toBe('chat.completion');
      expect(json.id).toMatch(/^chatcmpl-/);
      expect(json.choices).toHaveLength(1);
      expect(json.choices[0].message.role).toBe('assistant');
      expect(json.choices[0].message.content).toBe('Hello from mock!');
      expect(json.choices[0].finish_reason).toBe('stop');
      expect(json.model).toBe('llama-3.1-8b');
    });

    it('maps max_tokens to engine maxTokens', async () => {
      await fetchJson(server, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 50,
        }),
      });
      const chatCall = (engine.chat as ReturnType<typeof vi.fn>).mock.lastCall;
      expect(chatCall?.[0].maxTokens).toBe(50);
    });

    it('returns 400 with OpenAI error for malformed JSON', async () => {
      const res = await fetch(url(server, '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.error.type).toBe('invalid_request_error');
      expect(json.error.code).toBe('invalid_json');
    });

    it('returns 400 for missing model', async () => {
      const { res, json } = await fetchJson(server, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(400);
      expect(json.error.code).toBe('model_required');
    });

    it('returns 400 for invalid role', async () => {
      const { res, json } = await fetchJson(server, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'tool', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(400);
      expect(json.error.code).toBe('invalid_role');
    });

    it('returns OpenAI error envelope when engine throws', async () => {
      const { AuthError } = await import('../../errors.js');
      const failEngine = createMockEngine({
        chat: vi.fn().mockRejectedValue(new AuthError('groq')),
      });
      const failServer = await startDashboardServer({ engine: failEngine, port: 0 });
      try {
        const { res, json } = await fetchJson(failServer, '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.1-8b',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        expect(res.status).toBe(401);
        expect(json.error.type).toBe('authentication_error');
      } finally {
        failServer.close();
      }
    });
  });

  // ── POST /v1/chat/completions (streaming) ─────────────────────

  describe('POST /v1/chat/completions (streaming)', () => {
    it('returns SSE stream with OpenAI chunk shape', async () => {
      const res = await fetch(url(server, '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const body = await res.text();
      const dataLines = body.split('\n').filter(l => l.startsWith('data: '));

      // 2 chunks + [DONE]
      expect(dataLines).toHaveLength(3);
      expect(dataLines[dataLines.length - 1]).toBe('data: [DONE]');

      // First chunk has role
      const first = JSON.parse(dataLines[0].slice(6));
      expect(first.object).toBe('chat.completion.chunk');
      expect(first.id).toMatch(/^chatcmpl-/);
      expect(first.choices[0].delta.role).toBe('assistant');
      expect(first.choices[0].delta.content).toBe('Hello');

      // Second chunk has finish_reason, no role
      const second = JSON.parse(dataLines[1].slice(6));
      expect(second.choices[0].delta.role).toBeUndefined();
      expect(second.choices[0].delta.content).toBe(' world');
      expect(second.choices[0].finish_reason).toBe('stop');

      // Consistent id across chunks
      expect(first.id).toBe(second.id);
    });

    it('sends OpenAI error envelope on stream failure', async () => {
      const failEngine = createMockEngine({
        chatStream: vi.fn().mockImplementation(async function* () {
          yield { delta: 'partial', model: 'test', provider: 'test' } satisfies StreamChunk;
          throw new Error('mid-stream failure');
        }),
      });
      const failServer = await startDashboardServer({ engine: failEngine, port: 0 });
      try {
        const res = await fetch(url(failServer, '/v1/chat/completions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'test',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
          }),
        });

        const body = await res.text();
        const dataLines = body.split('\n').filter(l => l.startsWith('data: '));
        const lastData = JSON.parse(dataLines[dataLines.length - 1].slice(6));
        expect(lastData.error.type).toBe('server_error');
        expect(lastData.error.message).toContain('mid-stream failure');
      } finally {
        failServer.close();
      }
    });
  });

  // ── GET /v1/models ────────────────────────────────────────────────

  describe('GET /v1/models', () => {
    it('returns OpenAI model list shape', async () => {
      const { res, json } = await fetchJson(server, '/v1/models');
      expect(res.status).toBe(200);
      expect(json.object).toBe('list');
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data[0].id).toBe('llama-3.1-8b');
      expect(json.data[0].object).toBe('model');
      expect(json.data[0].owned_by).toBe('groq');
    });
  });

  // ── CORS with Authorization ───────────────────────────────────────

  describe('CORS with Authorization header', () => {
    it('includes Authorization in allowed headers', async () => {
      const res = await fetch(url(server, '/v1/chat/completions'), { method: 'OPTIONS' });
      expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    });
  });

  // ── Body too large (413) ────────────────────────────────────────

  describe('body too large', () => {
    const oversizedBody = 'x'.repeat(1_048_577); // 1 byte over the 1MB limit

    it('returns clean 413 on /api/chat (not a connection reset)', async () => {
      const { res, json } = await fetchJson(server, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedBody,
      });
      expect(res.status).toBe(413);
      expect(json.error).toContain('too large');
    });

    it('returns clean 413 on /v1/chat/completions (not a connection reset)', async () => {
      const { res, json } = await fetchJson(server, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversizedBody,
      });
      expect(res.status).toBe(413);
      expect(json.error).toBeDefined();
    });
  });

  // ── Port binding ─────────────────────────────────────────────────

  describe('port binding', () => {
    it('uses port 0 to get a random available port', () => {
      expect(server.port).toBeGreaterThan(0);
    });
  });
});
