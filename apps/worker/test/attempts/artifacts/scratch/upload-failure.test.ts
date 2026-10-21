import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { NodeHttpTransport } from '@pertexo/integrations/server';
import { afterEach, expect, it } from 'vitest';
import { withByteProgress } from '../../../../src/attempts/artifacts/scratch/progress.js';
import { ArtifactScratchSpace } from '../../../../src/attempts/artifacts/scratch/space.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it.each(['reset', 'timeout'] as const)(
  'keeps scratch ready and reusable after an upload %s',
  async (failure) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-upload-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const scratch = await ArtifactScratchSpace.create(directory);
    const signal = new AbortController().signal;
    const length = 10 * 1024 * 1024;
    const file = await scratch.spool({
      attemptId: 'upload',
      maxBytes: length,
      body: Readable.from(
        (function* () {
          for (let offset = 0; offset < length; offset += 65536)
            yield Buffer.alloc(65536, 42);
        })(),
      ),
      signal,
    });
    cleanups.push(() => file.release().catch(() => undefined));
    let received = 0;
    const sockets = new Set<Socket>();
    const server = createServer((request) => {
      request.once('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (failure === 'reset') request.socket.resetAndDestroy();
        else request.pause();
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
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
      throw new Error('Upload receiver has no address');
    let raw: ReturnType<typeof file.open> | undefined;
    let closed: Promise<void> | undefined;
    await expect(
      new NodeHttpTransport().dispatch({
        url: new URL(`http://127.0.0.1:${String(address.port)}/upload`),
        address: { address: '127.0.0.1', family: 4 },
        method: 'POST',
        headers: {},
        body: {
          byteLength: file.byteLength,
          sha256: file.sha256,
          release: file.release,
          open(readSignal: AbortSignal) {
            raw = file.open();
            const guarded = withByteProgress(raw, readSignal);
            closed = Promise.all([
              finished(raw).catch(() => undefined),
              finished(guarded).catch(() => undefined),
            ]).then(() => undefined);
            return guarded;
          },
        },
        signal,
        timeoutMillis: failure === 'timeout' ? 500 : 5000,
      }),
    ).rejects.toHaveProperty(
      'code',
      failure === 'timeout'
        ? 'ETIMEDOUT'
        : expect.stringMatching(/^(ECONNRESET|EPIPE)$/u),
    );
    await closed;
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(length);
    expect(raw?.bytesRead).toBeLessThan(length);
    await file.release();
    expect(raw?.closed).toBe(true);
    expect(() => {
      scratch.checkReadiness();
    }).not.toThrow();
    const next = await scratch.spool({
      attemptId: 'next-step',
      maxBytes: 4,
      body: Readable.from([Buffer.from('next')]),
      signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of next.open()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('next');
    await next.release();
    expect(() => {
      scratch.checkReadiness();
    }).not.toThrow();
  },
);
