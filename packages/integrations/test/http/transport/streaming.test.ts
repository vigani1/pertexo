import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { Readable, PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import type { NodeVerifiedByteSource } from '@pertexo/node-sdk/server';
import { NodeHttpTransport } from '../../../src/server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function receiver(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const sockets = new Set<Socket>();
  const server = createServer(handle);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Receiver missing');
  return new URL(`http://127.0.0.1:${String(address.port)}/upload`);
}
function source(length: number, open: () => Readable): NodeVerifiedByteSource {
  return {
    byteLength: length,
    sha256: 'a'.repeat(64),
    open,
    release: () => Promise.resolve(),
  };
}
function send(
  url: URL,
  body: NodeVerifiedByteSource,
  signal = new AbortController().signal,
) {
  return new NodeHttpTransport().dispatch({
    url,
    address: { address: '127.0.0.1', family: 4 },
    method: 'POST',
    headers: {},
    body,
    signal,
    timeoutMillis: 5000,
  });
}
it.each([0, 10 * 1024 * 1024])(
  'sends %i exact file bytes with a generated content length and bounded chunks',
  async (length) => {
    const expected = createHash('sha256');
    let seen = 0;
    let receivedDigest = '';
    const url = await receiver((request, response) => {
      const hash = createHash('sha256');
      expect(request.headers['content-length']).toBe(String(length));
      request.on('data', (chunk: Buffer) => {
        seen += chunk.byteLength;
        hash.update(chunk);
      });
      request.on('end', () => {
        receivedDigest = hash.digest('hex');
        response.writeHead(204).end();
      });
    });
    const body = source(length, () =>
      Readable.from(
        (async function* () {
          for (let offset = 0; offset < length; offset += 65536) {
            const chunk = Buffer.alloc(
              Math.min(65536, length - offset),
              offset / 65536,
            );
            expected.update(chunk);
            yield await Promise.resolve(chunk);
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      ),
    );
    const response = await send(url, body);
    expect(response.status).toBe(204);
    expect(seen).toBe(length);
    expect(receivedDigest).toBe(expected.digest('hex'));
    response.close();
  },
);
it('does not accept early response headers as success while the file source can still fail', async () => {
  let replied!: () => void;
  const repliedPromise = new Promise<void>((resolve) => {
    replied = resolve;
  });
  const url = await receiver((_request, response) => {
    response.writeHead(200).flushHeaders();
    replied();
  });
  const body = new PassThrough({ highWaterMark: 65536 });
  const sent = send(
    url,
    source(1000, () => body),
  );
  let settled = false;
  const observed = sent.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  body.write(Buffer.alloc(1));
  await repliedPromise;
  expect(settled).toBe(false);
  body.destroy(new Error('Late file read failed'));
  expect(await observed).toMatchObject({ message: 'Late file read failed' });
  expect(body.closed).toBe(true);
});
it.each([3, 5])(
  'refuses actual length %i when the source declared four bytes',
  async (actual) => {
    const url = await receiver((request, response) => {
      request.resume();
      request.on('end', () => response.writeHead(204).end());
    });
    const body = Readable.from([Buffer.alloc(actual)]);
    await expect(
      send(
        url,
        source(4, () => body),
      ),
    ).rejects.toThrow('Verified HTTP body length mismatch');
    expect(body.destroyed).toBe(true);
  },
);
it('cancels native source and request while a receiver is stalled', async () => {
  let reached!: () => void;
  const received = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const url = await receiver((request) => {
    request.pause();
    reached();
  });
  const controller = new AbortController();
  const native = new PassThrough({ highWaterMark: 65536 });
  const failed = expect(
    send(
      url,
      source(10 * 1024 * 1024, () => native),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  native.write(Buffer.alloc(65536));
  await received;
  controller.abort();
  await failed;
  expect(native.destroyed).toBe(true);
});
