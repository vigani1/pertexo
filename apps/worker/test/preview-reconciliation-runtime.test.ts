import { randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  parseDatabaseConfig,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  type FailureNotificationStore,
} from '@pertexo/database/testing';
import {
  jobIdForOutboxEvent,
  JOB_NAME,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewReconciliationHandler,
  mapPreviewReconciliationError,
  type PreviewReconciliationStore,
} from '../src/execution/preview-reconciliation-runtime.js';
import {
  createPreviewMaintenanceRuntime,
  type PreviewMaintenanceCompositionFactories,
} from '../src/execution/preview-maintenance-runtime.js';

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

function routedDelivery(name: string) {
  const outboxEventId = randomUUID();
  return {
    name,
    data: {
      schemaVersion: 1,
      workspaceId: randomUUID(),
      outboxEventId,
      previewRunId: randomUUID(),
      previewAttemptId: randomUUID(),
      attemptFenceToken: 1,
      attemptId: randomUUID(),
      evidenceCommandId: randomUUID(),
      commandId: randomUUID(),
      notificationIntentId: randomUUID(),
    },
    transport: { attemptsMade: 0, jobId: `outbox-${outboxEventId}` },
  };
}

describe('preview reconciliation handler', () => {
  it.each([
    ['traceRunner', []],
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
      ],
    ],
    [
      'consumer',
      [
        'previewStore',
        'failureNotificationStore',
        'unknownOutcomeStore',
        'replayStore',
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
      } as unknown as PreviewMaintenanceCompositionFactories;

      await expect(
        createPreviewMaintenanceRuntime(
          {
            database: parseDatabaseConfig({
              connectionString:
                'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
            }),
            failureNotificationDelivery: { deliver: vi.fn() },
            previewReconciliation: true,
            redisUrl: 'redis://localhost:6379/0',
            runReplay: true,
            unknownOutcomeReconciliation: true,
          },
          {},
          factories,
        ),
      ).rejects.toBe(failure);
      expect(new Set(closed)).toEqual(new Set(expectedClosed));
      expect(closed).toHaveLength(expectedClosed.length);
    },
  );

  it('routes every enabled maintenance job to its distinct handler', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const handles = {
      preview: vi.fn().mockResolvedValue(undefined),
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
    } as unknown as PreviewMaintenanceCompositionFactories;
    const runtime = await createPreviewMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        }),
        failureNotificationDelivery: { deliver: vi.fn() },
        failureNotificationDeliveryTimeoutMillis: 1_000,
        failureNotificationMaxAttempts: 5,
        failureNotificationRetryDelaySeconds: 45,
        previewReconciliation: true,
        redisUrl: 'redis://localhost:6379/0',
        runReplay: true,
        unknownOutcomeReconciliation: true,
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
    expect(factories.notifications.handler).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMillis: 1_000,
        maxAttempts: 5,
        retryDelaySeconds: 45,
      }),
    );
    const cases = [
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

  it('keeps disabled maintenance stores resource-free and rejects their jobs', async () => {
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
    } as unknown as PreviewMaintenanceCompositionFactories;
    const runtime = await createPreviewMaintenanceRuntime(
      {
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        }),
        previewReconciliation: false,
        redisUrl: 'redis://localhost:6379/0',
        runReplay: false,
        unknownOutcomeReconciliation: false,
      },
      {},
      factories,
    );

    for (const name of [
      JOB_NAME.reconcilePreviewAttempt,
      JOB_NAME.deliverRunFailureNotification,
      JOB_NAME.reconcileUnknownOutcome,
      JOB_NAME.replayWorkflowRun,
      JOB_NAME.advanceWorkflowRun,
    ])
      await expect(
        consumerOptions?.handler(routedDelivery(name) as never, {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ name: 'InvalidQueueDeliveryError' });
    expect(factories.preview.store).not.toHaveBeenCalled();
    expect(factories.notifications.store).not.toHaveBeenCalled();
    expect(factories.unknownOutcome.store).not.toHaveBeenCalled();
    expect(factories.replay.store).not.toHaveBeenCalled();
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

  it.each(['reconciliation', 'terminal'] as const)(
    'contains a throwing %s telemetry callback without changing a committed result',
    async (failingCallback) => {
      const result = {
        kind: 'completed' as const,
        mayContactProvider: false,
        mayCauseExternalSideEffect: false,
        possiblyDispatched: false,
        sideEffectClass: 'safe' as const,
        status: 'succeeded' as const,
        usesConnection: false,
      };
      const selected = delivery();
      const recordReconciliation = vi.fn(() => {
        if (failingCallback === 'reconciliation')
          throw new Error('reconciliation metric failed');
      });
      const recordTerminal = vi.fn(() => {
        if (failingCallback === 'terminal')
          throw new Error('terminal metric failed');
      });
      const handler = createPreviewReconciliationHandler(
        { reconcile: vi.fn().mockResolvedValue(result) },
        { recordReconciliation, recordTerminal },
      );

      await expect(
        handler.handle(selected, { signal: new AbortController().signal }),
      ).resolves.toBe(result);
      expect(recordReconciliation).toHaveBeenCalledOnce();
      if (failingCallback === 'terminal')
        expect(recordTerminal).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [new PreviewDeliveryMismatchError(), /durable state verification/u],
    [new PreviewAttemptStateError('already_terminal'), /already_terminal/u],
  ] as const)('maps permanent reconciliation error %#', (error, message) => {
    const mapped = mapPreviewReconciliationError(error);
    expect(mapped).toBeInstanceOf(Error);
    if (!(mapped instanceof Error))
      throw new TypeError('expected mapped error');
    expect(mapped.name).toBe('UnrecoverableError');
    expect(mapped.message).toMatch(message);
  });

  it('preserves ordinary and hostile reconciliation failures', () => {
    const transient = new Error('postgres unavailable');
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype');
        },
      },
    );
    expect(mapPreviewReconciliationError(transient)).toBe(transient);
    expect(mapPreviewReconciliationError(hostile)).toBe(hostile);
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

  it('waits for initial recovery health and never becomes ready after close', async () => {
    const recovery = Promise.withResolvers<number>();
    const notificationStore: FailureNotificationStore = {
      claimDelivery: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      completeDelivery: vi.fn(),
      fenceDispatch: vi.fn(),
      loadDestination: vi.fn(),
      recoverDue: vi.fn(() => recovery.promise),
    };
    const runtime = await maintenanceRuntime(notificationStore, 100);
    let readinessSettled = false;
    const readiness = runtime.checkReadiness().finally(() => {
      readinessSettled = true;
    });
    await Promise.resolve();
    expect(readinessSettled).toBe(false);

    recovery.resolve(0);
    await expect(readiness).resolves.toBeUndefined();
    await runtime.close();
    await expect(runtime.checkReadiness()).rejects.toThrow(/closed/u);
  });

  it('exposes a failed first recovery scan through readiness', async () => {
    const notificationStore: FailureNotificationStore = {
      claimDelivery: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      completeDelivery: vi.fn(),
      fenceDispatch: vi.fn(),
      loadDestination: vi.fn(),
      recoverDue: vi.fn().mockRejectedValue(new Error('postgres unavailable')),
    };
    const runtime = await maintenanceRuntime(notificationStore, 100);

    await expect(runtime.checkReadiness()).rejects.toThrow(/latest scan/u);
    await runtime.close();
  });

  it('does not start a recovery timer when notification delivery is disabled', async () => {
    vi.useFakeTimers();
    try {
      const runtime = await createPreviewMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          }),
          previewReconciliation: false,
          runReplay: true,
          redisUrl: 'redis://localhost:6379/0',
        },
        {
          consumerFactory: vi.fn().mockReturnValue({
            close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
            isReady: vi.fn().mockReturnValue(true),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          }),
          runReplayStore: {
            close: vi.fn().mockResolvedValue(undefined),
            fail: vi.fn(),
            replay: vi.fn(),
          },
        },
      );

      await expect(runtime.checkReadiness()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { failureNotificationDeliveryTimeoutMillis: 0 },
    { failureNotificationDeliveryTimeoutMillis: 120_001 },
    { failureNotificationMaxAttempts: 0 },
    { failureNotificationMaxAttempts: 101 },
    { failureNotificationRetryDelaySeconds: 0 },
    { failureNotificationRetryDelaySeconds: 86_401 },
  ])('rejects invalid notification composition bounds %#', async (override) => {
    const consumerFactory = vi.fn();
    await expect(
      createPreviewMaintenanceRuntime(
        {
          database: parseDatabaseConfig({
            connectionString:
              'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          }),
          failureNotificationDelivery: { deliver: vi.fn() },
          redisUrl: 'redis://localhost:6379/0',
          ...override,
        },
        { consumerFactory },
      ),
    ).rejects.toThrow(/delivery bounds/u);
    expect(consumerFactory).not.toHaveBeenCalled();
  });

  it('reports a bounded recovery shutdown failure and closes stores after late settlement', async () => {
    const events: string[] = [];
    const recovery = Promise.withResolvers<number>();
    const recoverDue = vi.fn(() => {
      events.push('recovery-start');
      return recovery.promise;
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
    const notificationStore: FailureNotificationStore = {
      claimDelivery: vi.fn(),
      close: notificationClose,
      completeDelivery: vi.fn(),
      fenceDispatch: vi.fn(),
      loadDestination: vi.fn(),
      recoverDue,
    };
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
    } as unknown as PreviewMaintenanceCompositionFactories;
    const runtime = await createPreviewMaintenanceRuntime(
      {
        backgroundTaskShutdownTimeoutMillis: 5,
        database: parseDatabaseConfig({
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        }),
        failureNotificationDelivery: { deliver: vi.fn() },
        previewReconciliation: false,
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
    await expect(runtime.whenIdle()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(notificationClose).toHaveBeenCalledOnce();
    });
  });
});
