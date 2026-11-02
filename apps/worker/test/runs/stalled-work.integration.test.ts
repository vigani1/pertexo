import { randomUUID } from 'node:crypto';
import type * as FileSystem from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
  parseMigrationConfig,
} from '@pertexo/database/testing';
import type { StructuredLogger } from '@pertexo/observability';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../../src/config/worker.js';
import { configuredStalledWorkRuntime } from '../../src/runs/stalled-work.js';

// Every worker on a host writes the same path. This file gets one of its own, the
// way the fault suite's preload gives a worker one, so nothing here disturbs them.
const marker = vi.hoisted(() => ({ path: '', writes: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    writeFile: async (
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
    ) => {
      if (path !== '/tmp/pertexo-worker-progress')
        return actual.writeFile(path, data);
      await actual.writeFile(marker.path, data);
      marker.writes += 1;
    },
  };
});

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required`);
  return value;
};

const LIMIT_MS = 60_000;
/** Scans run every 5 s, and a loaded runner can stretch that. */
const WAIT = { timeout: 45_000, interval: 50 };

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('the marker the health check reads', () => {
  const adminUrl = required('DATABASE_ADMIN_URL');
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
    databaseName: `pertexo_test_stalled_work_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const workerConfig = () =>
    ({
      retention: {
        maintenanceDatabase: parseDatabaseConfig({
          connectionString: fixture.databaseUrl(
            required('DATABASE_MAINTENANCE_URL'),
          ),
          max: 2,
          ownerRole: 'pertexo_owner',
        }),
      },
    }) as unknown as WorkerConfig;
  const asAdmin = async (statement: string): Promise<void> => {
    const admin = new Client({
      connectionString: fixture.databaseUrl(adminUrl),
    });
    await admin.connect();
    try {
      await admin.query(statement);
    } finally {
      await admin.end();
    }
  };
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pertexo-stalled-work-'));
    await fixture.create();
    await migrateDatabase(
      parseMigrationConfig({
        DATABASE_MIGRATION_URL: fixture.databaseUrl(
          required('DATABASE_MIGRATION_URL'),
        ),
      }),
    );
  }, LIMIT_MS);

  afterAll(async () => {
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  });

  const useMarker = (name: string): void => {
    marker.path = join(directory, name);
    marker.writes = 0;
  };

  it(
    'moves with each scan, stands still while a consumer has stopped, and moves again after',
    async () => {
      useMarker('consumer');
      const logger = fakeLogger();
      let scans = 0;
      let stopped = false;
      const runtime = configuredStalledWorkRuntime(
        workerConfig(),
        logger as unknown as StructuredLogger,
        {
          attempts: {
            hasStopped: () => {
              scans += 1;
              return stopped;
            },
          },
          triggers: { hasStopped: () => false },
        },
      );
      runtime.start();
      try {
        await runtime.checkReadiness();
        await vi.waitFor(() => {
          expect(marker.writes).toBeGreaterThanOrEqual(1);
        }, WAIT);
        await expect(readFile(marker.path, 'utf8')).resolves.toBe(
          String(process.pid),
        );
        const firstMove = marker.writes;
        await vi.waitFor(() => {
          expect(marker.writes).toBeGreaterThan(firstMove);
        }, WAIT);
        expect(logger.error).not.toHaveBeenCalled();

        stopped = true;
        const scansBefore = scans;
        // The first scan that sees it, whose write can't be under way any more once
        // the next has started.
        await vi.waitFor(() => {
          expect(scans).toBeGreaterThan(scansBefore);
        }, WAIT);
        await vi.waitFor(() => {
          expect(logger.error).toHaveBeenCalledWith(
            'worker.queue_consumer_stopped',
            { stopped: ['attempts'] },
          );
        }, WAIT);
        const scansSeen = scans;
        const writesSeen = marker.writes;
        const touchedAt = (await stat(marker.path)).mtimeMs;
        await vi.waitFor(() => {
          expect(scans).toBeGreaterThanOrEqual(scansSeen + 2);
        }, WAIT);
        expect(marker.writes).toBe(writesSeen);
        expect((await stat(marker.path)).mtimeMs).toBe(touchedAt);
        // One line for the outage, not one every 5 s until the worker is ended.
        expect(logger.error).toHaveBeenCalledOnce();

        stopped = false;
        await vi.waitFor(() => {
          expect(marker.writes).toBeGreaterThan(writesSeen);
        }, WAIT);
        expect((await stat(marker.path)).mtimeMs).toBeGreaterThan(touchedAt);
      } finally {
        await runtime.close();
      }
    },
    LIMIT_MS,
  );

  // A database problem is no reason to restart anything, so a failed scan still
  // counts as progress; the failure shows in readiness and the log instead.
  it(
    'moves through a failed stage, which reads as a failed cycle and clears when it works again',
    async () => {
      useMarker('stage');
      const logger = fakeLogger();
      await asAdmin(
        'revoke select on app.node_attempts from pertexo_maintenance',
      );
      const runtime = configuredStalledWorkRuntime(
        workerConfig(),
        logger as unknown as StructuredLogger,
        {},
      );
      runtime.start();
      try {
        await expect(runtime.checkReadiness()).rejects.toThrow(
          'Stalled work latest cycle failed',
        );
        expect(marker.writes).toBe(1);

        const permissionDenied: unknown = expect.objectContaining({
          code: '42501',
        });
        expect(logger.error).toHaveBeenCalledWith(
          'run_recovery.stage_failed',
          { stage: 'expired_leases' },
          permissionDenied,
        );
        expect(logger.error).toHaveBeenCalledWith(
          'run_recovery.scan_failed',
          {},
          permissionDenied,
        );
        // Only the stage that failed: the other two read tables it still may.
        expect(
          logger.error.mock.calls.filter(
            ([event]) => event === 'run_recovery.stage_failed',
          ),
        ).toHaveLength(1);

        await asAdmin(
          'grant select on app.node_attempts to pertexo_maintenance',
        );
        const failuresSoFar = logger.error.mock.calls.length;
        const movesSoFar = marker.writes;
        await vi.waitFor(() => {
          expect(marker.writes).toBeGreaterThan(movesSoFar);
        }, WAIT);
        await expect(runtime.checkReadiness()).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledTimes(failuresSoFar);
      } finally {
        await asAdmin(
          'grant select on app.node_attempts to pertexo_maintenance',
        );
        await runtime.close();
      }
    },
    LIMIT_MS,
  );
});
