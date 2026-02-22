import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroqProvider } from '../../providers/groq.js';
import { CerebrasProvider } from '../../providers/cerebras.js';
import { SambaNovaProvider } from '../../providers/sambanova.js';
import { GitHubModelsProvider } from '../../providers/github.js';
import { GeminiProvider } from '../../providers/gemini.js';
import { PROVIDER_DEFAULTS } from '../../config/defaults.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockModelsResponse(): Response {
  return new Response(
    JSON.stringify({ data: [{ id: 'test-model', context_window: 4096 }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Provider adapter definitions -- one source of truth for all test cases
// ---------------------------------------------------------------------------

const adapters = [
  {
    name: 'GroqProvider',
    create: () => new GroqProvider('sk-groq-test-key'),
    expectedId: 'groq',
    expectedName: 'Groq',
    expectedBaseUrl: PROVIDER_DEFAULTS['groq'].baseUrl,
  },
  {
    name: 'CerebrasProvider',
    create: () => new CerebrasProvider('sk-cerebras-test-key'),
    expectedId: 'cerebras',
    expectedName: 'Cerebras',
    expectedBaseUrl: PROVIDER_DEFAULTS['cerebras'].baseUrl,
  },
  {
    name: 'SambaNovaProvider',
    create: () => new SambaNovaProvider('sk-sambanova-test-key'),
    expectedId: 'sambanova',
    expectedName: 'SambaNova',
    expectedBaseUrl: PROVIDER_DEFAULTS['sambanova'].baseUrl,
  },
  {
    name: 'GitHubModelsProvider',
    create: () => new GitHubModelsProvider('sk-github-test-key'),
    expectedId: 'github',
    expectedName: 'GitHub Models',
    expectedBaseUrl: PROVIDER_DEFAULTS['github'].baseUrl,
    expectedModelsUrl: 'https://models.github.ai/catalog/models',
  },
  {
    name: 'GeminiProvider',
    create: () => new GeminiProvider('sk-gemini-test-key'),
    expectedId: 'gemini',
    expectedName: 'Gemini',
    expectedBaseUrl: PROVIDER_DEFAULTS['gemini'].baseUrl,
  },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Provider adapters', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const adapter of adapters) {
    describe(adapter.name, () => {
      it('can be instantiated', () => {
        const provider = adapter.create();
        expect(provider).toBeDefined();
      });

      it(`has id "${adapter.expectedId}"`, () => {
        const provider = adapter.create();
        expect(provider.id).toBe(adapter.expectedId);
      });

      it(`has name "${adapter.expectedName}"`, () => {
        const provider = adapter.create();
        expect(provider.name).toBe(adapter.expectedName);
      });

      it(`uses base URL ${adapter.expectedBaseUrl}`, async () => {
        fetchSpy.mockResolvedValueOnce(mockModelsResponse());

        const provider = adapter.create();
        await provider.fetchModels();

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url] = fetchSpy.mock.calls[0] as [string];
        const expectedUrl = ('expectedModelsUrl' in adapter && adapter.expectedModelsUrl)
          ? adapter.expectedModelsUrl
          : `${adapter.expectedBaseUrl}/models`;
        expect(url).toBe(expectedUrl);
      });

      it('sends Bearer token in Authorization header', async () => {
        fetchSpy.mockResolvedValueOnce(mockModelsResponse());

        const provider = adapter.create();
        await provider.fetchModels();

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toMatch(/^Bearer .+/);
      });

      it('implements the Provider interface (has chat, chatStream, fetchModels)', () => {
        const provider = adapter.create();
        expect(typeof provider.chat).toBe('function');
        expect(typeof provider.chatStream).toBe('function');
        expect(typeof provider.fetchModels).toBe('function');
      });
    });
  }
});
