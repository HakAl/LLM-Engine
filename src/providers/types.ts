import type { RequestOptions } from '../engine/types.js';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  usage?: Usage;
  finishReason: string;
}

export interface StreamChunk {
  delta: string;
  model: string;
  provider: string;
  finishReason?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  capabilities: string[];
}

export interface Provider {
  readonly id: string;
  readonly name: string;

  fetchModels(options?: RequestOptions): Promise<ModelInfo[]>;
  chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse>;
  chatStream(request: ChatRequest, options?: RequestOptions): AsyncIterable<StreamChunk>;

  /**
   * Returns the headers from the most recent HTTP response, if available.
   * Used by the router to feed rate-limit headers into the rate limiter.
   * Optional — providers that don't implement this are simply skipped.
   */
  getLastResponseHeaders?(): Headers | undefined;
}
