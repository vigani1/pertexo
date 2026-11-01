import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  createConnectionStore,
  createWorkerConnectionResolutionStore,
  type ApiConnectionStore,
  type WorkerConnectionResolutionStore,
} from '../../src/connections/store.js';
import { createDatabaseRuntime } from '@pertexo/database/platform';

describe('@pertexo/database package contract', () => {
  it('runtime factories do not check out a connection before an operation', async () => {
    const config = {
      connectionString: 'postgresql://worker:password@localhost/pertexo',
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 1_000,
      max: 1,
      ownerRole: 'pertexo_owner',
    } as const;
    const connect = vi.spyOn(Pool.prototype, 'connect');
    const runtime = createDatabaseRuntime(config, {
      monitorLockWaits: false,
      role: 'api',
    });
    let api: ApiConnectionStore | undefined;
    let worker: WorkerConnectionResolutionStore | undefined;
    try {
      api = createConnectionStore(config, runtime);
      worker = createWorkerConnectionResolutionStore(config, runtime);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([
        Promise.resolve().then(() => api?.close()),
        Promise.resolve().then(() => worker?.close()),
      ]);
      await runtime.close();
      connect.mockRestore();
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
