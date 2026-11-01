import Fastify from 'fastify';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createCallbackStore } from '@pertexo/core/runs';
import { createCallbackTokenKeys } from '@pertexo/integrations/server';
import { RedisRateLimitRuntime } from '@pertexo/rate-limit';
import { registerCallbackIngress } from '../../../src/webhooks/callbacks/ingress.js';
import { silentLogger } from '../../support/silent-logger.js';

const databaseUrl = process.env.CALLBACK_FIXTURE_DATABASE_URL;
const redisUrl = process.env.CALLBACK_FIXTURE_REDIS_URL;
if (
  databaseUrl === undefined ||
  redisUrl === undefined ||
  process.send === undefined
)
  throw new Error(
    'Callback receiver requires its disposable database, Redis namespace and IPC.',
  );
const store = createCallbackStore(
  parseDatabaseConfig({ connectionString: databaseUrl, max: 2 }),
);
const keys = createCallbackTokenKeys({
  origin: 'http://127.0.0.1',
  keys: {
    current: { version: '1', key: Buffer.alloc(32, 71).toString('base64url') },
    previous: [],
  },
});
const limits = new RedisRateLimitRuntime(redisUrl);
const app = Fastify({ logger: false });
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  return (closing ??= (async () => {
    app.server.closeAllConnections();
    await app.close();
    await store.close();
    await limits.close();
    keys.close();
  })());
}
const shutdown = () => {
  void close().then(
    () => {
      if (process.connected) process.disconnect();
    },
    () => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    },
  );
};
process.once('SIGTERM', shutdown);
process.once('disconnect', shutdown);
try {
  registerCallbackIngress(app, {
    store,
    keys,
    rateLimitConsumer: limits,
    logger: silentLogger,
  });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  process.send({ origin });
} catch (error) {
  await close();
  throw error;
}
