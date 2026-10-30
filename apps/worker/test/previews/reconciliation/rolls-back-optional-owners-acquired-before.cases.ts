import { parseDatabaseConfig } from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';

import { type MaintenanceRuntimeFactories } from '../../../src/maintenance/runtime.js';
import { idleConnectionHealth } from './fixture.js';
import { testMaintenanceRuntime } from '../../support/runtime-factories.js';

export function registerRollsBackOptionalOwnersAcquiredBefore(): void {
  it.each([
    ['traceRunner', []],
    [
      'errorWorkflowStore',
      [
        'previewStore',
        'failureNotificationStore',
        'unknownOutcomeStore',
        'replayStore',
      ],
    ],
    [
      'errorWorkflowHandler',
      [
        'previewStore',
        'failureNotificationStore',
        'unknownOutcomeStore',
        'replayStore',
        'errorWorkflowStore',
      ],
    ],
    ['previewStore', []],
    ['failureNotificationStore', ['previewStore']],
    ['unknownOutcomeStore', ['previewStore', 'failureNotificationStore']],
    [
      'replayStore',
      ['previewStore', 'failureNotificationStore', 'unknownOutcomeStore'],
    ],
    [
      'previewHandler',
      [
        'previewStore',
        'failureNotificationStore',
        'unknownOutcomeStore',
        'replayStore',
        'errorWorkflowStore',
      ],
    ],
    [
      'consumer',
      [
        'previewStore',
        'failureNotificationStore',
        'unknownOutcomeStore',
        'replayStore',
        'errorWorkflowStore',
      ],
    ],
  ] as const)(
    'rolls back optional owners acquired before %s construction fails',
    async (failedStage, expectedClosed) => {
      const failure = new Error(`${failedStage} failed`);
      const closed: string[] = [];
      const close = (name: string) =>
        vi.fn(() => {
          closed.push(name);
          return Promise.resolve();
        });
      const previewStore = {
        close: close('previewStore'),
        reconcile: vi.fn(),
      };
      const failureNotificationStore = {
        claimDelivery: vi.fn(),
        close: close('failureNotificationStore'),
        completeDelivery: vi.fn(),
        fenceDispatch: vi.fn(),
        loadDestination: vi.fn(),
        recoverDue: vi.fn(),
      };
      const unknownOutcomeStore = {
        close: close('unknownOutcomeStore'),
        reconcile: vi.fn(),
      };
      const replayStore = {
        close: close('replayStore'),
        fail: vi.fn(),
        replay: vi.fn(),
      };
      const acquire = <T>(stage: string, value: T): T => {
        if (stage === failedStage) throw failure;
        return value;
      };
      const factories = {
        consumer: vi.fn(() =>
          acquire('consumer', {
            close: vi.fn(),
            isReady: vi.fn(),
            waitUntilReady: vi.fn(),
          }),
        ),
        notifications: {
          handler: vi.fn(() => ({
            handle: vi.fn(),
            pendingOperations: vi.fn(() => []),
          })),
          store: vi.fn(() =>
            acquire('failureNotificationStore', failureNotificationStore),
          ),
        },
        preview: {
          handler: vi.fn(() => acquire('previewHandler', { handle: vi.fn() })),
          store: vi.fn(() => acquire('previewStore', previewStore)),
        },
        replay: {
          handler: vi.fn(() => ({ handle: vi.fn() })),
          store: vi.fn(() => acquire('replayStore', replayStore)),
        },
        traceRunner: vi.fn(() => acquire('traceRunner', {})),
        unknownOutcome: {
          handler: vi.fn(() => ({ handle: vi.fn() })),
          store: vi.fn(() =>
            acquire('unknownOutcomeStore', unknownOutcomeStore),
          ),
        },
        connectionHealth: idleConnectionHealth,
        errorWorkflows: {
          store: vi.fn(() =>
            acquire('errorWorkflowStore', {
              dispatch: vi.fn(),
              close: close('errorWorkflowStore'),
            }),
          ),
          handler: vi.fn(() =>
            acquire('errorWorkflowHandler', { handle: vi.fn() }),
          ),
        },
      } as unknown as MaintenanceRuntimeFactories;

      await expect(
        testMaintenanceRuntime(
          {
            database: parseDatabaseConfig({
              connectionString:
                'postgresql://pertexo_app:secret@localhost:5432/pertexo',
            }),
            failureNotificationDelivery: { deliver: vi.fn() },
            redisUrl: 'redis://localhost:6379/0',
          },
          {},
          factories,
        ),
      ).rejects.toBe(failure);
      expect(new Set(closed)).toEqual(new Set(expectedClosed));
      expect(closed).toHaveLength(expectedClosed.length);
    },
  );
}
