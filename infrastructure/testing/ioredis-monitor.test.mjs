import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';

const { Redis } = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('ioredis');

test('reads a monitor event delivered in the same packet as the MONITOR acknowledgement', async () => {
  const server = createServer((socket) => {
    socket.once('data', () => {
      // Force the order that a busy Redis server can produce: no microtask
      // runs between the acknowledgement and the first monitoring frame.
      socket.write('+OK\r\n+1794856974.441263 [1 127.0.0.1:57096] "info"\r\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const redis = new Redis({
    port: address.port,
    protocol: 2,
    host: '127.0.0.1',
    monitor: true,
    enableReadyCheck: false,
    disableClientInfo: true,
    retryStrategy: () => null,
  });
  try {
    const event = await once(redis, 'monitor');
    assert.deepEqual(event.slice(0, 3), [
      '1794856974.441263',
      ['info'],
      '127.0.0.1:57096',
    ]);
  } finally {
    redis.disconnect();
    server.close();
    await once(server, 'close');
  }
});
