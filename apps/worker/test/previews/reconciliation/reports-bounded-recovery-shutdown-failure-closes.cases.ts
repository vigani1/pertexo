import { parseDatabaseConfig } from '@pertexo/database/testing';
import type { FailureNotificationStore } from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';

import type { MaintenanceRuntimeFactories } from '../../../src/maintenance/runtime.js';
import {
  maintenanceRuntime,
  idleConnectionHealth,
  idleErrorWorkflows,
} from './fixture.js';
import { testMaintenanceRuntime } from '../../support/runtime-factories.js';

export function registerReportsBoundedRecoveryShutdownFailureCloses(): void {
  it('reports a bounded recovery shutdown failure and closes stores after late settlement', async () => {
    const events: string[] = [];
    const recovery = Promise.withResolvers<number>();
    const recoverDue = vi.fn(() => {
      events.push('recovery-start');
      return recovery.promise;
    });
    const notificationStore = {
      claimDelivery:
        vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
      close: vi.fn<NonNullable<FailureNotificationStore['close']>>(() => {
        events.push('store-close');
        return Promise.resolve();
      }),
      completeDelivery:
        vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
      fenceDispatch:
        vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
      loadDestination:
        vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
      recoverDue,
    } satisfies FailureNotificationStore;
    const runtime = await maintenanceRuntime(notificationStore, 5);

    await vi.waitFor(() => {
      expect(recoverDue).toHaveBeenCalledOnce();
    });
    await expect(runtime.close()).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(events).toEqual(['recovery-start']);

    recovery.resolve(0);
    await vi.waitFor(() => {
      expect(events).toEqual(['recovery-start', 'store-close']);
    });
  });

  it('keeps detached notification work owned until late settlement', async () => {
    const detached = Promise.withResolvers<undefined>();
    const notificationClose = vi.fn().mockResolvedValue(undefined);
    const recoverDue = vi.fn(
      (_limit: number, _attempts: number, signal?: AbortSignal) =>
        new Promise<number>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('recovery aborted'));
            },
            { once: true },
          );
        }),
    );
    const notificationStore = {
      claimDelivery:
        vi.fn<NonNullable<FailureNotificationStore['claimDelivery']>>(),
      close: notificationClose,
      completeDelivery:
        vi.fn<NonNullable<FailureNotificationStore['completeDelivery']>>(),
      fenceDispatch:
        vi.fn<NonNullable<FailureNotificationStore['fenceDispatch']>>(),
      loadDestination:
        vi.fn<NonNullable<FailureNotificationStore['loadDestination']>>(),
      recoverDue,
    } satisfies FailureNotificationStore;
    const factories = {
      consumer: vi.fn(() => ({
        close: vi.fn().mockResolvedValue({ abortedJobs: 1, forced: true }),
        isReady: vi.fn().mockReturnValue(true),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
      })),
      notifications: {
        handler: vi.fn(() => ({
          handle: vi.fn(),
          pendingOperations: vi.fn(() => [detached.promise]),
        })),
        store: vi.fn(),
      },
      preview: { handler: vi.fn(), store: vi.fn() },
      replay: { handler: vi.fn(), store: vi.fn() },
      traceRunner: vi.fn(() => ({})),
      unknownOutcome: { handler: vi.fn(), store: vi.fn() },
      connectionHealth: idleConnectionHealth,
      errorWorkflows: idleErrorWorkflows,
    } as unknown as MaintenanceRuntimeFactories;
    const runtime = await testMaintenanceRuntime(
      {
        backgroundTaskShutdownTimeoutMillis: 5,
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        }),
        failureNotificationDelivery: { deliver: vi.fn() },
        redisUrl: 'redis://localhost:6379/0',
      },
      { failureNotificationStore: notificationStore },
      factories,
    );
    await vi.waitFor(() => {
      expect(recoverDue).toHaveBeenCalledOnce();
    });

    await expect(runtime.close()).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(notificationClose).not.toHaveBeenCalled();

    detached.resolve(undefined);
    await vi.waitFor(() => {
      expect(notificationClose).toHaveBeenCalledOnce();
    });
  });
}
