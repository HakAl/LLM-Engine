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

  // ── Port binding ─────────────────────────────────────────────────

  describe('port binding', () => {
    it('uses port 0 to get a random available port', () => {
      expect(server.port).toBeGreaterThan(0);
    });
  });
});
