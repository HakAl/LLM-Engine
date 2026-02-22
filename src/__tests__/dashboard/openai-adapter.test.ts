import { describe, it, expect } from 'vitest';
import {
  parseAndValidate,
  toInternalRequest,
  toOpenAIResponse,
  toOpenAIModelList,
  toOpenAIError,
  OpenAIStreamAdapter,
} from '../../dashboard/openai-adapter.js';
import type { ChatResponse, StreamChunk, ModelInfo } from '../../providers/types.js';
import {
  AuthError,
  RateLimitError,
  ProviderError,
  TimeoutError,
  AllProvidersUnavailableError,
} from '../../errors.js';

// ── parseAndValidate ────────────────────────────────────────────────

describe('parseAndValidate', () => {
  it('rejects malformed JSON', () => {
    const result = parseAndValidate('{bad json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('invalid_json');
    }
  });

  it('rejects non-object body', () => {
    const result = parseAndValidate('"hello"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('invalid_request');
    }
  });

  it('rejects array body', () => {
    const result = parseAndValidate('[]');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('rejects missing model', () => {
    const result = parseAndValidate(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('model_required');
    }
  });

  it('rejects empty messages', () => {
    const result = parseAndValidate(JSON.stringify({
      model: 'test',
      messages: [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.error.code).toBe('messages_required');
    }
  });

  it('rejects invalid role', () => {
    const result = parseAndValidate(JSON.stringify({
      model: 'test',
      messages: [{ role: 'tool', content: 'hi' }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.error.code).toBe('invalid_role');
    }
  });

  it('rejects non-string content', () => {
    const result = parseAndValidate(JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 123 }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.error.code).toBe('invalid_content');
    }
  });

  it('accepts valid request with stream=true', () => {
    const result = parseAndValidate(JSON.stringify({
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
      max_tokens: 100,
      stream: true,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.model).toBe('llama-3.1-8b');
      expect(result.request.stream).toBe(true);
      expect(result.request.temperature).toBe(0.7);
      expect(result.request.max_tokens).toBe(100);
    }
  });

  it('defaults stream to false', () => {
    const result = parseAndValidate(JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.stream).toBe(false);
    }
  });
});

// ── toInternalRequest ───────────────────────────────────────────────

describe('toInternalRequest', () => {
  it('maps OpenAI fields to internal fields', () => {
    const result = toInternalRequest({
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      max_tokens: 200,
    });
    expect(result.model).toBe('llama-3.1-8b');
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(result.temperature).toBe(0.5);
    expect(result.maxTokens).toBe(200);
  });

  it('leaves optional fields undefined when absent', () => {
    const result = toInternalRequest({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.temperature).toBeUndefined();
    expect(result.maxTokens).toBeUndefined();
  });
});

// ── toOpenAIResponse ────────────────────────────────────────────────

describe('toOpenAIResponse', () => {
  it('produces valid OpenAI completion shape', () => {
    const internal: ChatResponse = {
      content: 'Hello!',
      model: 'llama-3.1-8b',
      provider: 'groq',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };

    const result = toOpenAIResponse(internal, 'chatcmpl-test-123');
    expect(result.id).toBe('chatcmpl-test-123');
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('llama-3.1-8b');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('omits usage when not present', () => {
    const internal: ChatResponse = {
      content: 'Hi',
      model: 'test',
      provider: 'test',
      finishReason: 'stop',
    };
    const result = toOpenAIResponse(internal);
    expect(result.usage).toBeUndefined();
  });

  it('generates chatcmpl- id when not provided', () => {
    const internal: ChatResponse = {
      content: 'Hi',
      model: 'test',
      provider: 'test',
      finishReason: 'stop',
    };
    const result = toOpenAIResponse(internal);
    expect(result.id).toMatch(/^chatcmpl-/);
  });
});

// ── OpenAIStreamAdapter ─────────────────────────────────────────────

describe('OpenAIStreamAdapter', () => {
  it('includes role in first chunk delta', () => {
    const adapter = new OpenAIStreamAdapter('chatcmpl-test');
    const chunk: StreamChunk = { delta: 'Hello', model: 'test', provider: 'test' };
    const result = adapter.adapt(chunk);

    expect(result.id).toBe('chatcmpl-test');
    expect(result.object).toBe('chat.completion.chunk');
    expect(result.choices[0].delta.role).toBe('assistant');
    expect(result.choices[0].delta.content).toBe('Hello');
    expect(result.choices[0].finish_reason).toBeNull();
  });

  it('omits role in subsequent chunks', () => {
    const adapter = new OpenAIStreamAdapter();
    adapter.adapt({ delta: 'first', model: 'test', provider: 'test' });
    const second = adapter.adapt({ delta: 'second', model: 'test', provider: 'test' });

    expect(second.choices[0].delta.role).toBeUndefined();
    expect(second.choices[0].delta.content).toBe('second');
  });

  it('includes finish_reason on terminal chunk', () => {
    const adapter = new OpenAIStreamAdapter();
    adapter.adapt({ delta: 'first', model: 'test', provider: 'test' });
    const last = adapter.adapt({ delta: '', model: 'test', provider: 'test', finishReason: 'stop' });

    expect(last.choices[0].finish_reason).toBe('stop');
  });

  it('uses consistent id and created across chunks', () => {
    const adapter = new OpenAIStreamAdapter('chatcmpl-fixed');
    const c1 = adapter.adapt({ delta: 'a', model: 'test', provider: 'test' });
    const c2 = adapter.adapt({ delta: 'b', model: 'test', provider: 'test' });

    expect(c1.id).toBe(c2.id);
    expect(c1.created).toBe(c2.created);
  });
});

// ── toOpenAIModelList ───────────────────────────────────────────────

describe('toOpenAIModelList', () => {
  it('produces OpenAI model list shape', () => {
    const models: ModelInfo[] = [
      { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', provider: 'groq', contextWindow: 8192, capabilities: ['chat'] },
    ];
    const result = toOpenAIModelList(models);
    expect(result.object).toBe('list');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('llama-3.1-8b');
    expect(result.data[0].object).toBe('model');
    expect(result.data[0].owned_by).toBe('groq');
  });

  it('dedupes by model ID (first-seen wins)', () => {
    const models: ModelInfo[] = [
      { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', provider: 'groq', contextWindow: 8192, capabilities: ['chat'] },
      { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', provider: 'cerebras', contextWindow: 8192, capabilities: ['chat'] },
    ];
    const result = toOpenAIModelList(models);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].owned_by).toBe('groq');
  });
});

// ── toOpenAIError ───────────────────────────────────────────────────

describe('toOpenAIError', () => {
  it('maps AuthError to 401', () => {
    const { status, body } = toOpenAIError(new AuthError('groq'));
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('maps RateLimitError to 429', () => {
    const { status, body } = toOpenAIError(new RateLimitError('groq'));
    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('maps TimeoutError to 408', () => {
    const { status, body } = toOpenAIError(new TimeoutError(5000));
    expect(status).toBe(408);
    expect(body.error.type).toBe('timeout_error');
  });

  it('maps AllProvidersUnavailableError to 503', () => {
    const { status, body } = toOpenAIError(new AllProvidersUnavailableError([]));
    expect(status).toBe(503);
    expect(body.error.type).toBe('server_error');
  });

  it('maps ProviderError to its status code', () => {
    const { status, body } = toOpenAIError(new ProviderError('groq', 502));
    expect(status).toBe(502);
    expect(body.error.type).toBe('provider_error');
  });

  it('maps unknown errors to 500', () => {
    const { status, body } = toOpenAIError(new Error('unexpected'));
    expect(status).toBe(500);
    expect(body.error.type).toBe('server_error');
    expect(body.error.message).toBe('unexpected');
  });

  it('handles non-Error values', () => {
    const { status, body } = toOpenAIError('string error');
    expect(status).toBe(500);
    expect(body.error.message).toBe('Internal server error');
  });
});
