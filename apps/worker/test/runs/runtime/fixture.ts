import type { QueueConsumer } from '@pertexo/queue';
import { vi } from 'vitest';
import type { TestCoordinatorServices } from '../../support/runtime-factories.js';
import type { CoordinatorRuntimeOptions } from '../../../src/runs/runtime.js';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export const RUN_ID = '22222222-2222-4222-8222-222222222222';

export const OUTBOX_EVENT_ID = '44444444-4444-4444-8444-444444444444';

type RuntimeDependencies = TestCoordinatorServices;

export function runtimeOptions(
  overrides: Partial<CoordinatorRuntimeOptions> = {},
): CoordinatorRuntimeOptions {
  return {
    database: {
      connectionString:
        'postgresql://pertexo_app:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      ownerRole: 'pertexo_owner',
    },
    maintenanceDatabase: {
      connectionString:
        'postgresql://pertexo_maintenance:secret@localhost:5432/pertexo',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 2,
      ownerRole: 'pertexo_owner',
    },
    maximumAdmissions: 32,
    redisUrl: 'redis://unreachable.invalid:6379/0',
    ...overrides,
  };
}

export function runtimeDependencies(
  consumer: QueueConsumer,
  dueWakeupScanner: NonNullable<RuntimeDependencies['dueWakeupScanner']>,
  deadlineWakeupScanner: NonNullable<
    RuntimeDependencies['deadlineWakeupScanner']
  >,
) {
  return {
    consumerFactory: () => consumer,
    notifications: {
      close: vi
        .fn<
          NonNullable<
            NonNullable<RuntimeDependencies['notifications']>['close']
          >
        >()
        .mockResolvedValue(undefined),
      publish:
        vi.fn<
          NonNullable<
            NonNullable<RuntimeDependencies['notifications']>['publish']
          >
        >(),
      resync:
        vi.fn<
          NonNullable<
            NonNullable<RuntimeDependencies['notifications']>['resync']
          >
        >(),
    },
    runStore: {
      advance:
        vi.fn<
          NonNullable<NonNullable<RuntimeDependencies['runStore']>['advance']>
        >(),
      close:
        vi.fn<
          NonNullable<NonNullable<RuntimeDependencies['runStore']>['close']>
        >(),
    },
    callStore: {
      performActions: vi
        .fn<
          NonNullable<
            NonNullable<RuntimeDependencies['callStore']>['performActions']
          >
        >()
        .mockResolvedValue(undefined),
      close:
        vi.fn<
          NonNullable<NonNullable<RuntimeDependencies['callStore']>['close']>
        >(),
    },
    dueWakeupScanner,
    deadlineWakeupScanner,
    testSuiteScanner: {
      scan: vi
        .fn<
          NonNullable<
            NonNullable<RuntimeDependencies['testSuiteScanner']>['scan']
          >
        >()
        .mockResolvedValue(0),
      close:
        vi.fn<
          NonNullable<
            NonNullable<RuntimeDependencies['testSuiteScanner']>['close']
          >
        >(),
    },
  } satisfies RuntimeDependencies;
}
