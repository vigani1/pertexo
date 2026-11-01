import { createCallbackStore } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createCallbackTokenKeys } from '@pertexo/integrations/server';
import { createCallbackRuntime } from '../../../../src/attempts/callbacks/runtime.js';
import { fixture } from '../../calls/fixtures.js';

export function callbackResources(origin = 'http://127.0.0.1:9000') {
  const config = parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.workerUrl),
    max: 2,
  });
  const store = createCallbackStore(config);
  const keys = createCallbackTokenKeys({
    origin,
    keys: {
      current: {
        version: '1',
        key: Buffer.alloc(32, 71).toString('base64url'),
      },
      previous: [],
    },
  });
  return {
    config,
    store,
    keys,
    capabilities: {
      callbacks: (context: Parameters<typeof createCallbackRuntime>[2]) =>
        createCallbackRuntime(store, keys, context, () => undefined),
    },
    async close() {
      keys.close();
      await store.close();
    },
  };
}
