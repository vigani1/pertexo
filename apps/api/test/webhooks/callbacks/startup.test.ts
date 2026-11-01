import { beforeEach, expect, it, vi } from 'vitest';
import {
  createCallbackTokenKeys,
  callbackTokenHash,
} from '@pertexo/integrations/server';
import type { CallbackStore } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createApiCallbackRuntime } from '../../../src/platform/webhooks/callback-runtime.module.js';

const createCallbackStore = vi.hoisted(() => vi.fn());
vi.mock('@pertexo/core/runs', async (original) => ({
  ...(await original<object>()),
  createCallbackStore,
}));
beforeEach(() => {
  createCallbackStore.mockReset();
});

const callbackConfig = {
  origin: 'https://example.test',
  keys: {
    current: { version: '1', key: Buffer.alloc(32, 71).toString('base64url') },
    previous: [],
  },
};
const database = parseDatabaseConfig({
  connectionString: 'postgresql://pertexo_app:fixture@127.0.0.1:1/disposable',
  max: 1,
});
function store(hash: string) {
  return {
    prepare: vi.fn(),
    resolve: vi.fn(),
    respond: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    keysInUse: async function* () {
      yield await Promise.resolve({
        id: '01a10000-0000-7000-8000-000000000001',
        keyVersion: '1',
        tokenHash: hash,
      });
    },
  } satisfies CallbackStore;
}
it('refuses a wrong or missing restore key and closes the acquired store', async () => {
  const original = createCallbackTokenKeys(callbackConfig);
  const tokenHash = callbackTokenHash(
    original.material({ id: '01a10000-0000-7000-8000-000000000001' }, '1')
      .token,
  );
  original.close();
  for (const callbacks of [
    undefined,
    {
      ...callbackConfig,
      keys: {
        current: {
          version: '1',
          key: Buffer.alloc(32, 72).toString('base64url'),
        },
        previous: [],
      },
    },
  ]) {
    const retained = store(tokenHash);
    createCallbackStore.mockReturnValue(retained);
    await expect(
      createApiCallbackRuntime({
        database,
        ...(callbacks === undefined ? {} : { callbacks }),
      }),
    ).rejects.toThrow(/callback/iu);
    expect(retained.close).toHaveBeenCalledOnce();
  }
  const retained = store(tokenHash);
  createCallbackStore.mockReturnValue(retained);
  const runtime = await createApiCallbackRuntime({
    database,
    callbacks: callbackConfig,
  });
  await Promise.all([runtime.close(), runtime.close()]);
  expect(retained.close).toHaveBeenCalledOnce();
});
