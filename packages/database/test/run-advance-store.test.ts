import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createRunAdvanceStore } from '../src/runs/advance/store.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import { BASELINE_COMPATIBILITY_EXPECTATION } from './baseline-compatibility-fixture.js';

const noNetworkConfig = {
  connectionString: 'postgresql://invalid.invalid/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  ownerRole: 'pertexo_owner' as const,
};

const input = (signal: AbortSignal) => ({
  delivery: {
    outboxEventId: '00000000-0000-4000-8000-000000000003',
    payloadChecksum: 'a'.repeat(64),
  },
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  signal,
});

function storeWith(runtime: ReturnType<typeof createDatabaseRuntime>) {
  return createRunAdvanceStore(noNetworkConfig, runtime, {
    compatibilityReleases: BASELINE_COMPATIBILITY_EXPECTATION,
  });
}

describe('run advance store', () => {
  it('honors an already-aborted advance without opening PostgreSQL', async () => {
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      .mockImplementation(() => {
        throw new Error('Unexpected PostgreSQL checkout');
      });
    const runtime = createDatabaseRuntime(noNetworkConfig, {
      monitorLockWaits: false,
    });
    const store = storeWith(runtime);
    const decide = vi.fn();
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        store.advance(input(controller.signal), decide),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(decide).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await Promise.all([store.close(), runtime.close()]);
    }
  });

  it('disposes a late checkout after acquisition is aborted', async () => {
    let resolveCheckout!: (client: PoolClient) => void;
    const checkout = new Promise<PoolClient>((resolve) => {
      resolveCheckout = resolve;
    });
    const connect = vi
      .spyOn(Pool.prototype, 'connect')
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- This exercises the promise overload of pg Pool.connect.
      .mockImplementation((() => checkout) as typeof Pool.prototype.connect);
    const runtime = createDatabaseRuntime(noNetworkConfig, {
      monitorLockWaits: false,
    });
    const store = storeWith(runtime);
    const controller = new AbortController();
    const release = vi.fn();
    try {
      const pending = store.advance(input(controller.signal), vi.fn());
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      resolveCheckout({ release } as unknown as PoolClient);
      await vi.waitFor(() => {
        expect(
          release.mock.calls.some(([reason]) => reason instanceof Error),
        ).toBe(true);
      });
    } finally {
      connect.mockRestore();
      await Promise.all([store.close(), runtime.close()]);
    }
  });
});
