import type { WorkspaceDatabase } from '@pertexo/database';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerApplication } from '../src/app.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_worker',
    }),
  close: () => Promise.resolve(),
};

const workerConfig = {
  database: {
    connectionString:
      'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
  },
  nodeEnv: 'test' as const,
  logLevel: 'debug' as const,
};

describe('worker application bootstrap', () => {
  it('creates a standalone context without an HTTP server', async () => {
    const app = await createWorkerApplication(workerConfig, database);

    try {
      expect('getHttpServer' in app).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails startup and closes resources when database readiness fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
      close,
    };

    await expect(
      createWorkerApplication(workerConfig, unavailableDatabase),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });
});
