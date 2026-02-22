import { randomUUID } from 'node:crypto';
import type { ChatRequest, ChatResponse, StreamChunk, ModelInfo } from '../providers/types.js';
import {
  AuthError,
  RateLimitError,
  ProviderError,
  TimeoutError,
  AllProvidersUnavailableError,
} from '../errors.js';

// ── OpenAI Wire Types ───────────────────────────────────────────────

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface OpenAIMessage {
  role: string;
  content: string;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

export interface OpenAIModelList {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
}

export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

// ── Validation ──────────────────────────────────────────────────────

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

interface ValidationSuccess {
  ok: true;
  request: OpenAIChatRequest;
}

interface ValidationFailure {
  ok: false;
  status: number;
  body: OpenAIErrorEnvelope;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function parseAndValidate(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: 'Invalid JSON in request body',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: 'Request body must be a JSON object',
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      },
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (!obj.model || typeof obj.model !== 'string') {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: 'Missing or invalid "model" field',
          type: 'invalid_request_error',
          code: 'model_required',
        },
      },
    };
  }

  if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: 'Missing or empty "messages" array',
          type: 'invalid_request_error',
          code: 'messages_required',
        },
      },
    };
  }

  for (let i = 0; i < obj.messages.length; i++) {
    const msg = obj.messages[i];
    if (typeof msg !== 'object' || msg === null) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            message: `messages[${i}] must be an object`,
            type: 'invalid_request_error',
            code: 'invalid_message',
          },
        },
      };
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.role !== 'string' || !VALID_ROLES.has(m.role)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            message: `messages[${i}].role must be one of: system, user, assistant`,
            type: 'invalid_request_error',
            code: 'invalid_role',
          },
        },
      };
    }
    if (typeof m.content !== 'string') {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            message: `messages[${i}].content must be a string`,
            type: 'invalid_request_error',
            code: 'invalid_content',
          },
        },
      };
    }
  }

  return {
    ok: true,
    request: {
      model: obj.model,
      messages: obj.messages as OpenAIMessage[],
      temperature: typeof obj.temperature === 'number' ? obj.temperature : undefined,
      max_tokens: typeof obj.max_tokens === 'number' ? obj.max_tokens : undefined,
      stream: obj.stream === true,
    },
  };
}

// ── Request Translation ─────────────────────────────────────────────

export function toInternalRequest(openai: OpenAIChatRequest): ChatRequest {
  return {
    model: openai.model,
    messages: openai.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    })),
    temperature: openai.temperature,
    maxTokens: openai.max_tokens,
  };
}

// ── Response Translation ────────────────────────────────────────────

function generateId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function toOpenAIResponse(response: ChatResponse, requestId?: string): OpenAIChatCompletion {
  const result: OpenAIChatCompletion = {
    id: requestId ?? generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: response.finishReason,
      },
    ],
  };

  if (response.usage) {
    result.usage = {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    };
  }

  return result;
}

// ── Stateful Stream Adapter ─────────────────────────────────────────

export class OpenAIStreamAdapter {
  private readonly id: string;
  private readonly created: number;
  private isFirst = true;

  constructor(requestId?: string) {
    this.id = requestId ?? generateId();
    this.created = Math.floor(Date.now() / 1000);
  }

  adapt(chunk: StreamChunk): OpenAIChatCompletionChunk {
    const delta: { role?: string; content?: string } = {};

    if (this.isFirst) {
      delta.role = 'assistant';
      this.isFirst = false;
    }

    if (chunk.delta) {
      delta.content = chunk.delta;
    }

    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: chunk.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: chunk.finishReason ?? null,
        },
      ],
    };
  }
}

// ── Model List Translation ──────────────────────────────────────────

export function toOpenAIModelList(models: ModelInfo[]): OpenAIModelList {
  const seen = new Set<string>();
  const deduped: OpenAIModelList['data'] = [];

  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    deduped.push({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.provider,
    });
  }

  return { object: 'list', data: deduped };
}

// ── Error Translation ───────────────────────────────────────────────

export function toOpenAIError(error: unknown): { status: number; body: OpenAIErrorEnvelope } {
  if (error instanceof AuthError) {
    return {
      status: 401,
      body: {
        error: {
          message: error.message,
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      },
    };
  }

  if (error instanceof RateLimitError) {
    return {
      status: 429,
      body: {
        error: {
          message: error.message,
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      },
    };
  }

  if (error instanceof TimeoutError) {
    return {
      status: 408,
      body: {
        error: {
          message: error.message,
          type: 'timeout_error',
          code: 'request_timeout',
        },
      },
    };
  }

  if (error instanceof AllProvidersUnavailableError) {
    return {
      status: 503,
      body: {
        error: {
          message: error.message,
          type: 'server_error',
          code: 'all_providers_unavailable',
        },
      },
    };
  }

  if (error instanceof ProviderError) {
    return {
      status: error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502,
      body: {
        error: {
          message: error.message,
          type: 'provider_error',
          code: `provider_${error.statusCode}`,
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : 'Internal server error';
  return {
    status: 500,
    body: {
      error: {
        message,
        type: 'server_error',
        code: null,
      },
    },
  };
}
