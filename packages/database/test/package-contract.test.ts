import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApiConnectionDatabase } from '../src/connections/connections.js';
import { createWorkerConnectionResolutionDatabase } from '../src/connections/connections.js';
import { createDatabaseRuntime } from '../src/platform/database-runtime.js';
import type {
  ApiConnectionDatabase,
  WorkerConnectionResolutionDatabase,
} from '../src/connections/connections.js';

const supportedSurfaces = [
  'api',
  'execution',
  'lifecycle',
  'maintenance',
  'operator',
  'recovery',
] as const;

describe('@pertexo/database package contract', () => {
  it('publishes explicit runtime-role capability surfaces', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly exports: Readonly<
        Record<string, Readonly<{ default: string; types: string }>>
      >;
    };

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ...supportedSurfaces.map((surface) => `./${surface}`),
      './testing',
    ]);
    for (const surface of supportedSurfaces)
      expect(packageJson.exports[`./${surface}`]).toEqual({
        types: `./dist/${surface}.d.ts`,
        default: `./dist/${surface}.js`,
      });
  });

  it('keeps role surfaces independent from the broad testing surface', async () => {
    for (const surface of supportedSurfaces) {
      const source = await readFile(
        new URL(`../src/${surface}.ts`, import.meta.url),
        'utf8',
      );
      expect(source).not.toContain("from './testing.js'");
    }

    const api = await readFile(
      new URL('../src/api.ts', import.meta.url),
      'utf8',
    );
    const execution = await readFile(
      new URL('../src/execution.ts', import.meta.url),
      'utf8',
    );
    const maintenance = await readFile(
      new URL('../src/maintenance.ts', import.meta.url),
      'utf8',
    );
    expect(api).not.toContain('createCoordinatorRunStore');
    expect(execution).not.toContain('createIdentityWorkspaceDatabase');
    expect(maintenance).not.toContain('createControlLedgerCoordinator');
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

  it('does not export role-inappropriate connection methods from source surfaces', async () => {
    const api = await import('../src/api.js');
    const execution = await import('../src/execution.js');

    expect(api).not.toHaveProperty('createConnectionDatabase');
    expect(api).toHaveProperty('createApiConnectionDatabase');
    expect(execution).not.toHaveProperty('createConnectionDatabase');
    expect(execution).toHaveProperty(
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
      workerRuntimeRole: 'pertexo_worker',
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
