import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
  type FailureNotificationStore,
} from '@pertexo/database/testing';
import { jobIdForOutboxEvent, JOB_NAME } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewReconciliationHandler,
  type PreviewReconciliationStore,
} from '../src/execution/preview-reconciliation-runtime.js';
import { createPreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';

function delivery() {
  const data = {
    schemaVersion: 1 as const,
    workspaceId: randomUUID(),
    outboxEventId: randomUUID(),
    previewRunId: randomUUID(),
    previewAttemptId: randomUUID(),
    attemptFenceToken: 7,
  };
  return {
    name: JOB_NAME.reconcilePreviewAttempt,
    data,
    transport: {
      attemptsMade: 0,
      jobId: jobIdForOutboxEvent(data.outboxEventId),
    },
  } as const;
}

function maintenanceRuntime(
  failureNotificationStore: FailureNotificationStore,
  backgroundTaskShutdownTimeoutMillis: number,
) {
  return createPreviewMaintenanceRuntime(
    {
      backgroundTaskShutdownTimeoutMillis,
      database: parseDatabaseConfig({
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      }),
      failureNotificationDelivery: { deliver: vi.fn() },
      redisUrl: 'redis://localhost:6379/0',
    },
    {
      consumerFactory: vi.fn().mockReturnValue({
        close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
        isReady: vi.fn().mockReturnValue(true),
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
      }),
      failureNotificationStore,
      reconciliationStore: { close: vi.fn(), reconcile: vi.fn() },
    },
  );
}

describe('preview reconciliation handler', () => {
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

  it('closes the durable store when consumer construction fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const store = { close, reconcile: vi.fn() };

    await expect(
      createPreviewMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          }),
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          consumerFactory: () => {
            throw new Error('consumer construction failed');
          },
          reconciliationStore: store,
        },
      ),
    ).rejects.toThrow('consumer construction failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the maintenance consumer and store exactly once', async () => {
    const consumerClose = vi
      .fn()
      .mockResolvedValue({ abortedJobs: 0, forced: false });
    const storeClose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createPreviewMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        }),
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        consumerFactory: vi.fn().mockReturnValue({
          close: consumerClose,
          isReady: vi.fn().mockReturnValue(true),
          waitUntilReady: vi.fn().mockResolvedValue(undefined),
        }),
        reconciliationStore: { close: storeClose, reconcile: vi.fn() },
      },
    );

    await Promise.all([runtime.close(), runtime.close()]);
    expect(consumerClose).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
  });

  it('aborts in-flight notification recovery and prevents another recovery pass', async () => {
    let observedSignal: AbortSignal | undefined;
    const recovery = vi.fn(
      (_limit: number, _maxAttempts: number, signal?: AbortSignal) => {
        observedSignal = signal;
        return new Promise<number>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('recovery aborted'));
            },
            { once: true },
          );
        });
      },
    );
    const notificationClose = vi.fn().mockResolvedValue(undefined);
    const notificationStore: FailureNotificationStore = {
      claimDelivery: vi.fn(),
      close: notificationClose,
      completeDelivery: vi.fn(),
      fenceDispatch: vi.fn(),
      loadDestination: vi.fn(),
      recoverDue: recovery,
    };
    const runtime = await maintenanceRuntime(notificationStore, 100);

    await vi.waitFor(() => {
      expect(recovery).toHaveBeenCalledOnce();
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(recovery).toHaveBeenCalledOnce();
    expect(notificationClose).toHaveBeenCalledOnce();
  });

  it('reports a bounded recovery shutdown failure before closing its store', async () => {
    const events: string[] = [];
    const recoverDue = vi.fn(() => {
      events.push('recovery-start');
      return new Promise<number>(() => undefined);
    });
    const notificationStore: FailureNotificationStore = {
      claimDelivery: vi.fn(),
      close: vi.fn(() => {
        events.push('store-close');
        return Promise.resolve();
      }),
      completeDelivery: vi.fn(),
      fenceDispatch: vi.fn(),
      loadDestination: vi.fn(),
      recoverDue,
    };
    const runtime = await maintenanceRuntime(notificationStore, 5);

    await vi.waitFor(() => {
      expect(recoverDue).toHaveBeenCalledOnce();
    });
    await expect(runtime.close()).rejects.toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(events).toEqual(['recovery-start', 'store-close']);
  });
});
