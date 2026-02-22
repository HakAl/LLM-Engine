import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Engine } from '../engine/engine.js';
import {
  parseAndValidate,
  toInternalRequest,
  toOpenAIResponse,
  toOpenAIModelList,
  toOpenAIError,
  OpenAIStreamAdapter,
} from './openai-adapter.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function findUiDir(): string {
  // Sibling ui/ directory (works from both src/ and dist/)
  const sibling = join(__dirname, 'ui');
  if (existsSync(sibling)) return sibling;

  // Fallback: project root src/dashboard/ui/
  const fromDist = join(__dirname, '..', '..', 'src', 'dashboard', 'ui');
  if (existsSync(fromDist)) return fromDist;

  throw new Error(
    'Cannot find dashboard UI files. Expected at: ' + sibling,
  );
}

export interface DashboardServerOptions {
  port?: number;
  engine: Engine;
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<{ port: number; close: () => void }> {
  const { engine, port = 3000 } = options;
  const uiDir = findUiDir();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // API routes
      if (url.pathname === '/api/status') {
        const status = engine.getDashboardStatus();
        sendJson(res, 200, status);
        return;
      }

      if (url.pathname === '/api/models') {
        const models = engine.getAvailableModels();
        sendJson(res, 200, models);
        return;
      }

      // Proxy route: forward chat requests through the engine for testing
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        if (!parsed.model || typeof parsed.model !== 'string') {
          sendJson(res, 400, { error: 'Missing or invalid "model" field' });
          return;
        }
        if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
          sendJson(res, 400, { error: 'Missing or empty "messages" array' });
          return;
        }

        const response = await engine.chat(parsed);
        sendJson(res, 200, response);
        return;
      }

      // Streaming proxy: SSE endpoint for real-time token delivery
      if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        if (!parsed.model || typeof parsed.model !== 'string') {
          sendJson(res, 400, { error: 'Missing or invalid "model" field' });
          return;
        }
        if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
          sendJson(res, 400, { error: 'Missing or empty "messages" array' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          for await (const chunk of engine.chatStream(parsed)) {
            const data = JSON.stringify({
              delta: chunk.delta,
              model: chunk.model,
              provider: chunk.provider,
              finishReason: chunk.finishReason,
            });
            res.write(`data: ${data}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } catch (streamError) {
          const msg = streamError instanceof Error ? streamError.message : 'Stream error';
          res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
        }

        res.end();
        return;
      }

      // ── OpenAI-compatible routes ──────────────────────────────────

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = engine.getAvailableModels();
        sendJson(res, 200, toOpenAIModelList(models));
        return;
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const validation = parseAndValidate(rawBody);

        if (!validation.ok) {
          sendJson(res, validation.status, validation.body);
          return;
        }

        const openaiReq = validation.request;
        const internalReq = toInternalRequest(openaiReq);

        // Abort wiring: cancel upstream generation on client disconnect
        const ac = new AbortController();
        req.on('close', () => ac.abort());

        if (openaiReq.stream) {
          // Streaming response
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const adapter = new OpenAIStreamAdapter();

          try {
            for await (const chunk of engine.chatStream(internalReq, { signal: ac.signal })) {
              const openaiChunk = adapter.adapt(chunk);
              res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
            }
            res.write('data: [DONE]\n\n');
          } catch (streamError) {
            if (!ac.signal.aborted) {
              const { body } = toOpenAIError(streamError);
              res.write(`data: ${JSON.stringify(body)}\n\n`);
            }
          }

          res.end();
          return;
        }

        // Non-streaming response
        try {
          const response = await engine.chat(internalReq, { signal: ac.signal });
          sendJson(res, 200, toOpenAIResponse(response));
        } catch (chatError) {
          const { status, body } = toOpenAIError(chatError);
          sendJson(res, status, body);
        }
        return;
      }

      // Static file serving
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

      // Prevent directory traversal
      if (filePath.includes('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const fullPath = join(uiDir, filePath);
      const ext = extname(fullPath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      try {
        const content = await readFile(fullPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'Request body too large' });
        return;
      }
      const message = error instanceof Error ? error.message : 'Internal server error';
      sendJson(res, 500, { error: message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let overLimit = false;

    req.on('data', (chunk: Buffer) => {
      if (overLimit) return; // drain remaining data silently
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        overLimit = true;
        chunks.length = 0; // free buffered data
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (!overLimit) reject(err);
    });
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}
