import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { allocate } from './allocate.js';
import { validateRequest } from './validation.js';
import type { AllocateRequest } from './types.js';

const PORT = Number.parseInt(process.env.APP_PORT ?? '3000', 10);
const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/pools/allocate') {
    let parsed: unknown;
    try {
      const raw = await readBody(req);
      if (raw === '') throw new SyntaxError('empty body');
      parsed = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, {
        error: 'invalid_request',
        message: 'request body must be valid JSON',
        issues: [{ field: '$', message: err instanceof Error ? err.message : 'parse error' }],
      });
      return;
    }

    const issues = validateRequest(parsed);
    if (issues.length > 0) {
      sendJson(res, 400, { error: 'validation_failed', issues });
      return;
    }

    try {
      const result = allocate(parsed as AllocateRequest);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, {
        error: 'solver_error',
        message: err instanceof Error ? err.message : 'internal solver failure',
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'not_found', message: `unknown route: ${req.method} ${url.pathname}` });
});

function start(): void {
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`invalid APP_PORT: ${process.env.APP_PORT}`);
  }
  server.listen(PORT, () => {
    console.log(`pool allocator listening on port ${PORT}`);
  });
}

// Only auto-start when run directly (tests can import the server).
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
