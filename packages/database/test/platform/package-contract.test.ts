import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiConnectionDatabase } from '../../src/connections/database.js';
import { createWorkerConnectionResolutionDatabase } from '../../src/connections/database.js';
import { createDatabaseRuntime } from '../../src/platform/pool/runtime.js';
import type {
  ApiConnectionDatabase,
  WorkerConnectionResolutionDatabase,
} from '../../src/connections/database.js';

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
    let api: ApiConnectionDatabase | undefined;
    let worker: WorkerConnectionResolutionDatabase | undefined;
    try {
      api = createApiConnectionDatabase(config, runtime);
      worker = createWorkerConnectionResolutionDatabase(config, runtime);
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
