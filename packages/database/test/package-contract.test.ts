import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type {
  ApiConnectionDatabase,
  ConnectionManagementDatabase,
  ConnectionTestDatabase,
} from '../src/api.js';
import type {
  ConnectionResolutionDatabase,
  WorkerConnectionResolutionDatabase,
} from '../src/execution.js';
import { createApiConnectionDatabase } from '../src/connections.js';
import { createWorkerConnectionResolutionDatabase } from '../src/connections.js';

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
      '.',
      ...supportedSurfaces.map((surface) => `./${surface}`),
    ]);
    for (const surface of supportedSurfaces)
      expect(packageJson.exports[`./${surface}`]).toEqual({
        types: `./dist/${surface}.d.ts`,
        default: `./dist/${surface}.js`,
      });
  });

  it('keeps role surfaces independent from the broad compatibility root', async () => {
    for (const surface of supportedSurfaces) {
      const source = await readFile(
        new URL(`../src/${surface}.ts`, import.meta.url),
        'utf8',
      );
      expect(source).not.toContain("from './index.js'");
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

  it('does not republish the retired legacy execution persistence surface', async () => {
    const root = await readFile(
      new URL('../src/index.ts', import.meta.url),
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
      expect(root).not.toContain(retiredExport);
  });

  it('publishes behavior-named connection capabilities instead of the broad store', () => {
    const management: ConnectionManagementDatabase = {
      createConnection: () => Promise.reject(new Error('not exercised')),
      findConnectionCreateReplay: () => Promise.resolve(null),
      findConnectionRotateReplay: () => Promise.resolve(null),
      rotateConnectionSecret: () => Promise.reject(new Error('not exercised')),
      revokeConnection: () => Promise.reject(new Error('not exercised')),
    };
    const testing: ConnectionTestDatabase = {
      startConnectionTest: () => Promise.reject(new Error('not exercised')),
      resolveConnectionTestSecret: () =>
        Promise.reject(new Error('not exercised')),
      markConnectionTestDispatched: () => Promise.resolve(undefined),
      completeConnectionTest: () => Promise.reject(new Error('not exercised')),
      abandonConnectionTest: () => Promise.resolve(undefined),
    };
    const api: ApiConnectionDatabase = {
      ...management,
      ...testing,
      close: () => Promise.resolve(undefined),
    };
    const resolution: ConnectionResolutionDatabase = {
      assertConnectionSecretCurrent: () => Promise.resolve(undefined),
      resolveConnectionSecret: () => Promise.reject(new Error('not exercised')),
    };
    const worker: WorkerConnectionResolutionDatabase = {
      ...resolution,
      close: () => Promise.resolve(undefined),
    };

    expect(Object.keys(api).sort()).toEqual([
      'abandonConnectionTest',
      'close',
      'completeConnectionTest',
      'createConnection',
      'findConnectionCreateReplay',
      'findConnectionRotateReplay',
      'markConnectionTestDispatched',
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
    const api = createApiConnectionDatabase(config);
    const worker = createWorkerConnectionResolutionDatabase(config);
    try {
      expect(Object.keys(api).sort()).toEqual([
        'abandonConnectionTest',
        'close',
        'completeConnectionTest',
        'createConnection',
        'findConnectionCreateReplay',
        'findConnectionRotateReplay',
        'markConnectionTestDispatched',
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
    } finally {
      await Promise.all([api.close(), worker.close()]);
    }
  });
});
