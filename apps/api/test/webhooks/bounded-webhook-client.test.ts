import { createServer, type RequestListener, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendBoundedWebhook } from './bounded-webhook-client.js';

const endpointKey = 'a'.repeat(43);
const secret = Buffer.alloc(32, 7).toString('base64url');
const servers: Server[] = [];

describe('bounded webhook integration client', () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          }),
      ),
    );
  });

  it('sends the exact raw bytes and returns captured request authentication', async () => {
    const rawBody = Buffer.from('{  "exact" : true }\n');
    let received = Buffer.alloc(0);
    const origin = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received = Buffer.concat(chunks);
        response.end('{"accepted":true}');
      });
    });

    const result = await sendBoundedWebhook({
      endpointKey,
      idempotencyKey: 'delivery-1',
      origin,
      rawBody,
      secret,
      now: () => 1_700_000_000_000,
    });

    expect(received).toEqual(rawBody);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ accepted: true });
    expect(result.requestMaterial.timestamp).toBe('1700000000');
    expect(result.requestMaterial.signature).toMatch(/^v1=[0-9a-f]{64}$/u);
  });

  it.each([
    ['malformed JSON', Buffer.from('{'), 'not valid JSON'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'not valid JSON'],
  ] as const)(
    'rejects %s response bodies',
    async (_name, responseBody, message) => {
      const origin = await listen((_request, response) => {
        response.end(responseBody);
      });

      await expect(send(origin)).rejects.toThrow(message);
    },
  );

  it('rejects and destroys an over-limit response', async () => {
    const origin = await listen((_request, response) => {
      response.end('x'.repeat(33));
    });

    await expect(send(origin, { maxResponseBytes: 32 })).rejects.toThrow(
      'exceeds 32 bytes',
    );
  });

  it('rejects an aborted or truncated response', async () => {
    const origin = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('{"partial":');
      response.destroy();
    });

    await expect(send(origin)).rejects.toThrow();
  });

  it('destroys a stalled request at its deadline', async () => {
    let socketClosed = false;
    const origin = await listen((request) => {
      request.socket.once('close', () => {
        socketClosed = true;
      });
    });

    await expect(send(origin, { timeoutMs: 10 })).rejects.toThrow(
      'exceeded 10ms',
    );
    await vi.waitFor(
      () => {
        expect(socketClosed).toBe(true);
      },
      { timeout: 5_000 },
    );
  });
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${String(address.port)}`;
}

function send(
  origin: string,
  options: Readonly<{ maxResponseBytes?: number; timeoutMs?: number }> = {},
) {
  return sendBoundedWebhook({
    endpointKey,
    idempotencyKey: 'delivery-1',
    origin,
    rawBody: Buffer.from('{}'),
    secret,
    ...options,
  });
}
