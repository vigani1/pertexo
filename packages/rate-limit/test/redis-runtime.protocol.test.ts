import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { RedisRateLimitRuntime } from '../src/redis-runtime.js';

const decision = {
  endpointClass: 'ordinary_mutation',
  failureMode: 'closed',
  windowSeconds: 60,
  dimensions: [{ kind: 'actor', identifier: 'actor-a', limit: 10 }],
} as const;

type ProtocolFixture = Readonly<{
  connections: () => number;
  openSockets: ReadonlySet<Socket>;
  server: Server;
  url: string;
}>;

function readLine(
  buffer: Buffer,
  offset: number,
): [string, number] | undefined {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return undefined;
  return [buffer.toString('utf8', offset, end), end + 2];
}

function readCommand(
  buffer: Buffer,
): Readonly<{ command: string; consumed: number }> | undefined {
  const header = readLine(buffer, 0);
  if (!header?.[0].startsWith('*')) return undefined;
  const count = Number(header[0].slice(1));
  let offset = header[1];
  let command = '';
  for (let index = 0; index < count; index += 1) {
    const lengthLine = readLine(buffer, offset);
    if (!lengthLine?.[0].startsWith('$')) return undefined;
    const length = Number(lengthLine[0].slice(1));
    offset = lengthLine[1];
    if (buffer.length < offset + length + 2) return undefined;
    if (index === 0)
      command = buffer.toString('utf8', offset, offset + length).toLowerCase();
    offset += length + 2;
  }
  return { command, consumed: offset };
}

async function startProtocolFixture(): Promise<ProtocolFixture> {
  let connections = 0;
  const openSockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const parsed = readCommand(pending);
        if (parsed === undefined) return;
        pending = pending.subarray(parsed.consumed);
        if (parsed.command === 'quit') continue;
        if (parsed.command === 'eval') socket.write('*3\r\n:1\r\n:0\r\n:0\r\n');
        else if (parsed.command === 'info') socket.write('$0\r\n\r\n');
        else socket.write('+OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Redis protocol fixture did not bind a TCP port');
  return {
    connections: () => connections,
    openSockets,
    server,
    url: `redis://127.0.0.1:${String(address.port)}`,
  };
}

const fixtures: ProtocolFixture[] = [];

afterEach(async () => {
  const active = fixtures.splice(0);
  await Promise.all(
    active.map(async ({ openSockets, server }) => {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }),
  );
});

describe('Redis rate-limit runtime protocol ownership', () => {
  it('destroys a real socket after a stalled QUIT without reconnecting', async () => {
    const fixture = await startProtocolFixture();
    fixtures.push(fixture);
    const runtime = new RedisRateLimitRuntime(fixture.url, {
      operationTimeoutMs: 100,
    });

    await expect(runtime.consume(decision)).resolves.toEqual({ allowed: true });
    await expect(runtime.close()).rejects.toThrow(
      'Redis rate-limit close timed out',
    );
    await expect.poll(() => fixture.openSockets.size).toBe(0);
    expect(fixture.connections()).toBe(1);
    await expect(runtime.consume(decision)).rejects.toThrow(/closed/iu);
    expect(fixture.connections()).toBe(1);
  });
});
