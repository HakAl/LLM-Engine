import { createParser } from 'eventsource-parser';
import type { RequestOptions, RateLimitWindow } from '../../engine/types.js';
import {
  AuthError,
  RateLimitError,
  ProviderError,
  TimeoutError,
  StreamInterruptedError,
} from '../../errors.js';
import type {
  Provider,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ModelInfo,
} from '../types.js';

export interface OpenAICompatibleConfig {
  cacheTtlMs?: number;
  baseUrl?: string;
}

interface ModelsCache {
  models: ModelInfo[];
  expiresAt: number;
}

/**
 * Abstract base class for providers that expose an OpenAI-compatible API.
 *
 * Subclasses must implement:
 *   - `baseUrl` (the API root, no trailing slash)
 *   - `authHeader()` (returns the Authorization header value)
 *
 * Subclasses may override:
 *   - `mapResponseChunk()` to adapt non-standard SSE payloads
 *   - `mapModelEntry()` to adapt non-standard model list entries
 *   - `parseRateLimitHeaders()` to extract rate-limit windows from response headers
 */
export abstract class OpenAICompatibleProvider implements Provider {
  abstract readonly id: string;
  abstract readonly name: string;

  /** Default base URL for this provider. Subclasses must implement. */
  protected abstract get defaultBaseUrl(): string;
  protected abstract authHeader(): string;

  private readonly cacheTtlMs: number;
  private readonly baseUrlOverride?: string;
  private modelsCache: ModelsCache | null = null;
  /** Stashed from the most recent buildSignal call for error context. */
  private lastTimeoutMs = 0;
  /** Headers from the most recent successful HTTP response. */
  private lastHeaders: Headers | undefined;

  constructor(config?: OpenAICompatibleConfig) {
    this.cacheTtlMs = config?.cacheTtlMs ?? 60_000;
    this.baseUrlOverride = config?.baseUrl;
  }

  /** Effective base URL: config override wins over the default. */
  protected get baseUrl(): string {
    return this.baseUrlOverride ?? this.defaultBaseUrl;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Returns headers from the most recent HTTP response, for rate-limit learning. */
  getLastResponseHeaders(): Headers | undefined {
    return this.lastHeaders;
  }

  /**
   * Non-streaming chat -- implemented by collecting chatStream().
   * Single execution path: there is no separate non-streaming fetch.
   */
  async chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse> {
    let content = '';
    let model = request.model;
    let finishReason = '';

    for await (const chunk of this.chatStream(request, options)) {
      content += chunk.delta;
      model = chunk.model;
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
    }

    return {
      content,
      model,
      provider: this.id,
      finishReason: finishReason || 'stop',
    };
  }

  /**
   * Streaming chat via SSE.
   */
  async *chatStream(
    request: ChatRequest,
    options?: RequestOptions,
  ): AsyncIterable<StreamChunk> {
    const signal = this.buildSignal(options);

    const body = this.buildRequestBody(request);

    const response = await this.doFetch(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader(),
        },
        body: JSON.stringify(body),
        signal,
      },
      request.model,
    );

    yield* this.parseSSEStream(response, request.model);
  }

  /**
   * Fetch available models. Results are cached with a configurable TTL.
   */
  async fetchModels(options?: RequestOptions): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCache.expiresAt) {
      return this.modelsCache.models;
    }

    const signal = this.buildSignal(options);

    const response = await this.doFetch(
      `${this.baseUrl}/models`,
      {
        method: 'GET',
        headers: {
          Authorization: this.authHeader(),
        },
        signal,
      },
      'models',
    );

    const json = await response.json() as { data: Array<Record<string, unknown>> };
    const models = (json.data ?? []).map((entry) => this.mapModelEntry(entry));

    this.modelsCache = {
      models,
      expiresAt: Date.now() + this.cacheTtlMs,
    };

    return models;
  }

  // ---------------------------------------------------------------------------
  // Extension points for subclasses
  // ---------------------------------------------------------------------------

  /**
   * Parse rate-limit information from response headers.
   * Override in subclasses that receive provider-specific rate-limit headers.
   */
  protected parseRateLimitHeaders(_headers: Headers): RateLimitWindow[] {
    return [];
  }

  /**
   * Map a raw SSE JSON payload to internal fields. Override if the provider
   * uses a non-standard shape.
   */
  protected mapResponseChunk(parsed: Record<string, unknown>): {
    delta: string;
    model: string;
    finishReason?: string;
  } {
    const choices = parsed['choices'] as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const delta = choice?.['delta'] as Record<string, unknown> | undefined;
    return {
      delta: (delta?.['content'] as string) ?? '',
      model: (parsed['model'] as string) ?? '',
      finishReason: (choice?.['finish_reason'] as string) ?? undefined,
    };
  }

  /**
   * Map a raw model list entry to ModelInfo. Override for non-standard shapes.
   */
  protected mapModelEntry(entry: Record<string, unknown>): ModelInfo {
    return {
      id: (entry['id'] as string) ?? '',
      name: (entry['id'] as string) ?? '',
      provider: this.id,
      contextWindow: (entry['context_window'] as number) ?? 0,
      capabilities: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a merged AbortSignal from user-provided signal and/or timeout.
   * - Both provided: merge via AbortSignal.any()
   * - Signal only: use as-is
   * - Timeout only: use AbortSignal.timeout()
   * - Neither: undefined
   */
  private buildSignal(options?: RequestOptions): AbortSignal | undefined {
    const { signal, timeoutMs } = options ?? {};
    this.lastTimeoutMs = timeoutMs ?? 0;

    if (signal && timeoutMs !== undefined) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      return AbortSignal.any([signal, timeoutSignal]);
    }

    if (signal) return signal;
    if (timeoutMs !== undefined) return AbortSignal.timeout(timeoutMs);
    return undefined;
  }

  /**
   * Build the OpenAI-compatible request body with `stream: true`.
   */
  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
    };

    if (request.temperature !== undefined) {
      body['temperature'] = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body['max_tokens'] = request.maxTokens;
    }

    return body;
  }

  /**
   * Wrapper around fetch that normalizes HTTP errors into typed errors.
   */
  private async doFetch(
    url: string,
    init: RequestInit,
    model: string,
  ): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(url, init);
    } catch (error: unknown) {
      // Distinguish user-initiated abort from timeout abort
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error; // native AbortError -- propagate as-is
      }
      if (this.isTimeoutAbort(error)) {
        throw new TimeoutError(this.lastTimeoutMs, `Request to ${this.id} timed out (model: ${model})`);
      }
      throw error;
    }

    if (response.ok) {
      this.lastHeaders = response.headers;
      return response;
    }

    await this.throwForStatus(response, model);

    // unreachable -- throwForStatus always throws
    throw new ProviderError(this.id, response.status, undefined, { isRetryable: false });
  }

  /**
   * Check whether an error is a timeout-triggered abort.
   * Node and browsers set different properties, so we check broadly.
   */
  private isTimeoutAbort(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'TimeoutError') return true;
    // Some runtimes throw a generic Error with code ABORT_ERR when timeout fires
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: unknown }).code === 'ABORT_ERR'
    ) {
      return true;
    }
    return false;
  }

  /**
   * Parse an error response and throw the appropriate typed error.
   */
  private async throwForStatus(response: Response, model: string): Promise<never> {
    const status = response.status;

    // Read body as text first, then try to parse as JSON.
    // This avoids the "body already consumed" problem when response.json()
    // fails on non-JSON content and we fall back to response.text().
    let errorMessage: string;
    try {
      const rawText = await response.text();
      try {
        const json = JSON.parse(rawText) as { error?: { message?: string } };
        errorMessage = json?.error?.message ?? `HTTP ${status}`;
      } catch {
        // Non-JSON body (e.g. HTML 503 page)
        errorMessage = rawText.slice(0, 200) || `HTTP ${status}`;
      }
    } catch {
      errorMessage = `HTTP ${status}`;
    }

    const context = `[${this.id}/${model}] ${errorMessage}`;

    if (status === 401) {
      throw new AuthError(this.id, context);
    }

    if (status === 429) {
      const retryAfter = this.parseRetryAfterHeader(response.headers);
      throw new RateLimitError(this.id, retryAfter, context);
    }

    throw new ProviderError(this.id, status, context, {
      isRetryable: status >= 500,
    });
  }

  /**
   * Parse the Retry-After header into milliseconds.
   * Supports both delta-seconds and HTTP-date formats.
   */
  private parseRetryAfterHeader(headers: Headers): number | undefined {
    const value = headers.get('retry-after');
    if (!value) return undefined;

    // Try as integer (seconds)
    const seconds = Number(value);
    if (!Number.isNaN(seconds)) {
      return Math.ceil(seconds * 1000);
    }

    // Try as HTTP-date
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }

    return undefined;
  }

  /**
   * Parse a streaming response body as SSE, yielding StreamChunks.
   * Uses eventsource-parser for robust SSE parsing.
   * Throws StreamInterruptedError on mid-stream failures.
   */
  private async *parseSSEStream(
    response: Response,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    if (!response.body) {
      throw new StreamInterruptedError(this.id, 0, `No response body from ${this.id}`);
    }

    let chunksEmitted = 0;
    const pendingChunks: Array<Record<string, unknown>> = [];
    let sseComplete = false;

    const parser = createParser({
      onEvent(event) {
        if (event.data === '[DONE]') {
          sseComplete = true;
          return;
        }

        try {
          const parsed = JSON.parse(event.data) as Record<string, unknown>;
          pendingChunks.push(parsed);
        } catch {
          // Malformed JSON in SSE data -- skip silently
        }
      },
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        let result: { done: boolean; value?: Uint8Array };
        try {
          result = await reader.read();
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw error;
          }
          throw new StreamInterruptedError(
            this.id,
            chunksEmitted,
            `Stream read failed from ${this.id} after ${chunksEmitted} chunks`,
            { cause: error instanceof Error ? error : undefined },
          );
        }

        const { value, done: streamDone } = result;

        if (value) {
          const text = decoder.decode(value, { stream: true });
          parser.feed(text);

          // Yield any chunks accumulated by the parser callback
          while (pendingChunks.length > 0) {
            const rawChunk = pendingChunks.shift()!;
            const mapped = this.mapResponseChunk(rawChunk);
            const chunk: StreamChunk = {
              delta: mapped.delta,
              model: mapped.model || model,
              provider: this.id,
              finishReason: mapped.finishReason,
            };
            chunksEmitted++;
            yield chunk;
          }
        }

        if (streamDone || sseComplete) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
