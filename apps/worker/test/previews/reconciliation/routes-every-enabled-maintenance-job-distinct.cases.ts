import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { JOB_NAME, type QueueConsumerOptions } from '@pertexo/queue';
import { expect, it, vi } from 'vitest';
import {
  createPreviewReconciliationHandler,
  type PreviewReconciliationStore,
} from '../../../src/previews/reconciliation.js';
import type { MaintenanceRuntimeFactories } from '../../../src/maintenance/runtime.js';
import {
  delivery,
  routedDelivery,
  idleConnectionHealth,
  idleErrorWorkflows,
} from './fixture.js';
import { testMaintenanceRuntime } from '../../support/runtime-factories.js';

export function registerRoutesEveryEnabledMaintenanceJobDistinct(): void {
  it('routes every enabled maintenance job to its distinct handler', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const handles = {
      preview: vi.fn().mockResolvedValue(undefined),
      errorWorkflow: vi.fn().mockResolvedValue(undefined),
      notification: vi.fn().mockResolvedValue(undefined),
      unknown: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue(undefined),
    };
    const factories = {
      consumer: vi.fn((input: QueueConsumerOptions) => {
        consumerOptions = input;
        return {
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        };
      }),
      notifications: {
        handler: vi.fn(() => ({
          handle: handles.notification,
          pendingOperations: vi.fn(() => []),
        })),
        store: vi.fn(),
      },
      preview: {
        handler: vi.fn(() => ({ handle: handles.preview })),
        store: vi.fn(),
      },
      replay: {
        handler: vi.fn(() => ({ handle: handles.replay })),
        store: vi.fn(),
      },
      traceRunner: vi.fn(() => ({})),
      unknownOutcome: {
        handler: vi.fn(() => ({ handle: handles.unknown })),
        store: vi.fn(),
      },
      connectionHealth: idleConnectionHealth,
      errorWorkflows: {
        store: vi.fn(),
        handler: vi.fn(() => ({ handle: handles.errorWorkflow })),
      },
    } as unknown as MaintenanceRuntimeFactories;
    const runtime = await testMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        }),
        failureNotificationDelivery: { deliver: vi.fn() },
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        reconciliationStore: { close: vi.fn(), reconcile: vi.fn() },
        failureNotificationStore: {
          claimDelivery: vi.fn(),
          close: vi.fn(),
          completeDelivery: vi.fn(),
          fenceDispatch: vi.fn(),
          loadDestination: vi.fn(),
          recoverDue: vi.fn().mockResolvedValue(0),
        },
        unknownOutcomeStore: { close: vi.fn(), reconcile: vi.fn() },
        runReplayStore: {
          close: vi.fn(),
          fail: vi.fn(),
          replay: vi.fn(),
        },
      },
      factories,
    );
    const cases = [
      [JOB_NAME.startErrorWorkflow, handles.errorWorkflow],
      [JOB_NAME.reconcilePreviewAttempt, handles.preview],
      [JOB_NAME.deliverRunFailureNotification, handles.notification],
      [JOB_NAME.reconcileUnknownOutcome, handles.unknown],
      [JOB_NAME.replayWorkflowRun, handles.replay],
    ] as const;
    for (const [name, handle] of cases) {
      await expect(
        consumerOptions?.handler(routedDelivery(name) as never, {
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined();
      expect(handle).toHaveBeenCalledOnce();
    }
    await runtime.close();
  });

  it('rejects jobs it has no delivery for, without acquiring their stores', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const factories = {
      consumer: vi.fn((input: QueueConsumerOptions) => {
        consumerOptions = input;
        return {
          close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        };
      }),
      notifications: { handler: vi.fn(), store: vi.fn() },
      preview: { handler: vi.fn(), store: vi.fn() },
      replay: { handler: vi.fn(), store: vi.fn() },
      traceRunner: vi.fn(() => ({})),
      unknownOutcome: { handler: vi.fn(), store: vi.fn() },
      connectionHealth: idleConnectionHealth,
      errorWorkflows: idleErrorWorkflows,
    } as unknown as MaintenanceRuntimeFactories;
    const runtime = await testMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_app:secret@localhost:5432/pertexo',
        }),
        redisUrl: 'redis://localhost:6379/0',
      },
      {},
      factories,
    );

    for (const name of [
      JOB_NAME.deliverRunFailureNotification,
      JOB_NAME.deliverWorkspaceInvitation,
      JOB_NAME.advanceWorkflowRun,
    ])
      await expect(
        consumerOptions?.handler(routedDelivery(name) as never, {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ name: 'InvalidQueueDeliveryError' });
    expect(factories.notifications.store).not.toHaveBeenCalled();
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();
    await runtime.close();
  });

  it('forwards one identifier-only, checksum-bound reconciliation decision', async () => {
    const reconcile = vi.fn().mockResolvedValue({ kind: 'redelivered' });
    const recordReconciliation = vi.fn();
    const recordTerminal = vi.fn();
    const store: PreviewReconciliationStore = { reconcile };
    const selected = delivery();
    const signal = new AbortController().signal;

    await expect(
      createPreviewReconciliationHandler(store, {
        recordReconciliation,
        recordTerminal,
      }).handle(selected, { signal }),
    ).resolves.toEqual({ kind: 'redelivered' });
    expect(reconcile).toHaveBeenCalledWith({
      attemptFenceToken: selected.data.attemptFenceToken,
      delivery: {
        outboxEventId: selected.data.outboxEventId,
        payloadChecksum: canonicalOutboxPayloadChecksum(selected.data),
      },
      previewAttemptId: selected.data.previewAttemptId,
      previewRunId: selected.data.previewRunId,
      signal,
      workspaceId: selected.data.workspaceId,
    });
    expect(recordReconciliation).toHaveBeenCalledWith({
      decision: 'redelivered',
    });
    expect(recordTerminal).not.toHaveBeenCalled();
  });

  it('records a terminal reconciliation only after its durable completion', async () => {
    const recordReconciliation = vi.fn();
    const recordTerminal = vi.fn();
    const selected = delivery();
    await expect(
      createPreviewReconciliationHandler(
        {
          reconcile: vi.fn().mockResolvedValue({
            kind: 'completed',
            mayContactProvider: true,
            mayCauseExternalSideEffect: true,
            operationKey: 'request',
            possiblyDispatched: true,
            providerKey: 'http',
            sideEffectClass: 'unsafe',
            status: 'outcome_unknown',
            usesConnection: true,
          }),
        },
        { recordReconciliation, recordTerminal },
      ).handle(selected, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: 'completed', status: 'outcome_unknown' });
    expect(recordReconciliation).toHaveBeenCalledWith({
      decision: 'completed',
      outcome: 'outcome_unknown',
    });
    expect(recordTerminal).toHaveBeenCalledWith({
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      operationKey: 'request',
      outcome: 'outcome_unknown',
      possiblyDispatched: true,
      providerKey: 'http',
      sideEffectClass: 'unsafe',
      source: 'reconciliation',
      usesConnection: true,
    });
  });
}
