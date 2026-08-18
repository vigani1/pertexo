import type { WorkspaceDatabase } from '@pertexo/database';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerApplication } from '../src/app.js';
import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { WorkerReadiness } from '../src/runtime/worker-readiness.js';

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
    ownerRole: 'pertexo_owner',
  },
  nodeEnv: 'test' as const,
  logLevel: 'debug' as const,
  observability: {
    environment: 'test' as const,
    logLevel: 'silent' as const,
    otlpHeaders: {},
    serviceName: 'pertexo-worker',
    serviceVersion: 'test',
  },
};

const logger: StructuredLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

function dependencies(
  selectedDatabase: WorkspaceDatabase = database,
  telemetry: TelemetryLifecycle = {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
) {
  return { database: selectedDatabase, logger, telemetry };
}

describe('worker application bootstrap', () => {
  it('creates a standalone context without an HTTP server', async () => {
    const app = await createWorkerApplication(workerConfig, dependencies());

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
      createWorkerApplication(workerConfig, dependencies(unavailableDatabase)),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });

  it('connects drain state to readiness and admission', async () => {
    const app = await createWorkerApplication(workerConfig, dependencies());
    const drainState = app.get(WorkerDrainState);
    const readiness = app.get(WorkerReadiness);

    expect(drainState.canAcceptWork()).toBe(true);
    drainState.beginDrain();
    expect(() => {
      readiness.assertCanAcceptWork();
    }).toThrow('worker is draining');
    await expect(readiness.checkReadiness()).rejects.toThrow(
      'worker is draining',
    );

    await app.close();
  });

  it('enters drain state before shutdown resources close', async () => {
    const lifecycle: { drainState?: WorkerDrainState } = {};
    const close = vi.fn().mockImplementation(() => {
      expect(lifecycle.drainState?.canAcceptWork()).toBe(false);
      return Promise.resolve();
    });
    const selectedDatabase: WorkspaceDatabase = { ...database, close };
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(selectedDatabase),
    );
    lifecycle.drainState = app.get(WorkerDrainState);

    expect(app.get(WorkerDrainState).canAcceptWork()).toBe(true);
    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('shuts telemetry down with the worker application lifecycle', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const telemetry: TelemetryLifecycle = {
      enabled: true,
      started: true,
      start: vi.fn(),
      shutdown,
    };
    const app = await createWorkerApplication(
      workerConfig,
      dependencies(database, telemetry),
    );

    await app.close();

    expect(shutdown).toHaveBeenCalledOnce();
  });
});
