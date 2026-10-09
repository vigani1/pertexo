import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiConnectionDatabase } from '../src/connections/database.js';
import { createWorkerConnectionResolutionDatabase } from '../src/connections/database.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import type {
  ApiConnectionDatabase,
  WorkerConnectionResolutionDatabase,
} from '../src/connections/database.js';

const areas = [
  'artifacts',
  'attempts',
  'authoring',
  'connections',
  'identity',
  'inbox',
  'lifecycle',
  'notifications',
  'operator',
  'outbox',
  'platform',
  'previews',
  'runs',
  'tenant-access',
  'triggers',
] as const;

describe('@pertexo/database package contract', () => {
  it('publishes one entry point per area', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly exports: Readonly<
        Record<string, Readonly<{ default: string; types: string }>>
      >;
    };

    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [...areas.map((area) => `./${area}`), './testing'].sort(),
    );
    for (const area of areas)
      expect(packageJson.exports[`./${area}`]).toEqual({
        types: `./dist/${area}/index.d.ts`,
        default: `./dist/${area}/index.js`,
      });
  });

  it('keeps area entry points independent from the testing surface', async () => {
    for (const area of areas) {
      const source = await readFile(
        new URL(`../src/${area}/index.ts`, import.meta.url),
        'utf8',
      );
      expect(source).not.toContain('testing.js');
      expect(source).not.toContain('createCoordinatorRunStore');
    }
  });

  it('confines broad fixture capabilities to the explicit testing subpath', async () => {
    const testing = await readFile(
      new URL('../src/testing.ts', import.meta.url),
      'utf8',
    );
    for (const retiredExport of [
      'claimNodeAttempt',
      'commitCoordinatorTransition',
      'dispatchDueWorkflowWaits',
      'readExpiredAttemptReconciliations',
      'reconcileExpiredNodeAttempt',
      'scheduleNodeAttemptRetry',
      'suspendNodeAttemptUntil',
    ])
      expect(testing).not.toContain(retiredExport);
  });

  it('exports the API and worker connection stores, not the combined one', async () => {
    const connections = await import('../src/connections/index.js');

    expect(connections).not.toHaveProperty('createConnectionDatabase');
    expect(connections).toHaveProperty('createApiConnectionDatabase');
    expect(connections).toHaveProperty(
      'createWorkerConnectionResolutionDatabase',
    );
  });

  it('runtime factories project only the methods owned by each role', async () => {
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
      expect(Object.keys(api).sort()).toEqual([
        'abandonConnectionTest',
        'close',
        'completeConnectionTest',
        'createConnection',
        'findConnectionCreateReplay',
        'findConnectionRotateReplay',
        'listConnectionUsage',
        'listConnections',
        'markConnectionTestDispatched',
        'readConnection',
        'resolveConnectionLookupSecret',
        'resolveConnectionTestSecret',
        'revokeConnection',
        'rotateConnectionSecret',
        'startConnectionTest',
      ]);
      expect(Object.keys(worker).sort()).toEqual([
        'assertConnectionSecretCurrent',
        'close',
        'resolveConnectionSecret',
      ]);
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
