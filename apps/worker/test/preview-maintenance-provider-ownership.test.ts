import type { FailureNotificationStore } from '@pertexo/database/execution';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import { JOB_NAME, type QueueConsumerObserver } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';
import type { PreviewMaintenanceRuntime } from '../src/execution/preview-maintenance-runtime.js';
import {
  createOwnedPreviewMaintenanceRuntime,
  type PreviewMaintenanceCompositionFactories,
} from '../src/transport/preview-maintenance-runtime-provider.js';

const observer = {} as QueueConsumerObserver;

function config(jobNames: string = JOB_NAME.deliverRunFailureNotification) {
  return parseWorkerConfig({
    CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
    CONNECTION_KMS_REGION: 'eu-central-1',
    DATABASE_DISPATCHER_URL:
      'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
    DATABASE_WORKER_URL:
      'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
    OUTBOX_DISPATCH_JOB_NAMES: jobNames,
    OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS: '100',
    REDIS_URL: 'redis://localhost:6379/0',
  });
}

function runtime(
  close: () => Promise<void> | void = vi.fn(),
  whenIdle: () => Promise<void> = () => Promise.resolve(),
) {
  return {
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    whenIdle: vi.fn(whenIdle),
    close,
    consumer: {
      close: vi.fn(),
      isReady: () => true,
      waitUntilReady: () => Promise.resolve(),
    },
  } as unknown as PreviewMaintenanceRuntime;
}

function ownedFactories(options: {
  storeClose?: () => Promise<void> | void;
  encryptionClose?: () => Promise<void> | void;
  runtime?: PreviewMaintenanceRuntime;
}) {
  const storeClose = vi.fn(options.storeClose ?? (() => undefined));
  const encryptionClose = vi.fn(options.encryptionClose ?? (() => undefined));
  const store = {
    close: storeClose,
  } as unknown as FailureNotificationStore;
  const encryption = {
    close: encryptionClose,
    encryption: {},
  } as unknown as AwsConnectionEnvelopeEncryptionRuntime;
  const selectedRuntime = options.runtime ?? runtime();
  const factoryStages = {
    notificationStore: vi.fn(() => store),
    encryption: vi.fn(() => encryption),
    httpClient: vi.fn(() => ({})),
    slack: vi.fn(() => ({})),
    email: vi.fn(() => ({})),
    delivery: vi.fn(() => ({ deliver: vi.fn() })),
    runtime: vi.fn(() => Promise.resolve(selectedRuntime)),
  };
  const factories = {
    notificationDelivery: {
      store: factoryStages.notificationStore,
      encryption: factoryStages.encryption,
      httpClient: factoryStages.httpClient,
      slack: factoryStages.slack,
      email: factoryStages.email,
      create: factoryStages.delivery,
    },
    ...factoryStages,
  } as unknown as PreviewMaintenanceCompositionFactories & typeof factoryStages;
  return {
    encryption,
    encryptionClose,
    factories,
    runtime: selectedRuntime,
    store,
    storeClose,
  };
}

function requireRuntime(
  selected: PreviewMaintenanceRuntime | undefined,
): PreviewMaintenanceRuntime {
  if (selected === undefined) throw new Error('Expected maintenance runtime');
  return selected;
}

describe('preview maintenance provider ownership', () => {
  it.each([
    {
      jobName: JOB_NAME.reconcilePreviewAttempt,
      options: {
        runReplay: false,
        unknownOutcomeReconciliation: false,
      },
    },
    {
      jobName: JOB_NAME.reconcileUnknownOutcome,
      options: { runReplay: false, unknownOutcomeReconciliation: true },
    },
    {
      jobName: JOB_NAME.replayWorkflowRun,
      options: { runReplay: true, unknownOutcomeReconciliation: false },
    },
    {
      jobName: JOB_NAME.deliverRunFailureNotification,
      options: { runReplay: false, unknownOutcomeReconciliation: false },
    },
  ] as const)(
    'activates the shared maintenance runtime for $jobName',
    async ({ jobName, options }) => {
      const selected = ownedFactories({});

      const result = await createOwnedPreviewMaintenanceRuntime(
        config(jobName),
        {},
        observer,
        selected.factories,
      );
      expect(result).toBeDefined();
      expect(selected.factories.runtime).toHaveBeenCalledWith(
        expect.objectContaining(options),
      );
      await requireRuntime(result).close();
    },
  );

  it('returns early without acquiring hidden dependencies when disabled or externally composed', async () => {
    const disabled = ownedFactories({});
    await expect(
      createOwnedPreviewMaintenanceRuntime(
        config(''),
        {},
        observer,
        disabled.factories,
      ),
    ).resolves.toBeUndefined();
    expect(disabled.factories.notificationStore).not.toHaveBeenCalled();
    expect(disabled.factories.runtime).not.toHaveBeenCalled();

    const customRegistry = ownedFactories({});
    await expect(
      createOwnedPreviewMaintenanceRuntime(
        config(),
        { dispatchConsumerCapabilities: {} as never },
        observer,
        customRegistry.factories,
      ),
    ).resolves.toBeUndefined();
    expect(customRegistry.factories.notificationStore).not.toHaveBeenCalled();
    expect(customRegistry.factories.runtime).not.toHaveBeenCalled();

    const selectedRuntime = runtime();
    const customRuntime = ownedFactories({});
    await expect(
      createOwnedPreviewMaintenanceRuntime(
        config(),
        { previewMaintenanceRuntime: selectedRuntime },
        observer,
        customRuntime.factories,
      ),
    ).resolves.toBe(selectedRuntime);
    expect(customRuntime.factories.notificationStore).not.toHaveBeenCalled();
    expect(customRuntime.factories.runtime).not.toHaveBeenCalled();
  });

  it('rejects incomplete notification composition before acquiring resources', async () => {
    const selected = ownedFactories({});
    const withoutEncryption = parseWorkerConfig({
      DATABASE_DISPATCHER_URL:
        'postgresql://pertexo_dispatcher:secret@localhost:5432/pertexo',
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      OUTBOX_DISPATCH_JOB_NAMES: JOB_NAME.deliverRunFailureNotification,
      REDIS_URL: 'redis://localhost:6379/0',
    });

    await expect(
      createOwnedPreviewMaintenanceRuntime(
        withoutEncryption,
        {},
        observer,
        selected.factories,
      ),
    ).rejects.toThrow('requires connection encryption');
    expect(selected.factories.notificationStore).not.toHaveBeenCalled();
  });

  it('uses an injected delivery without acquiring store, encryption, or HTTP clients', async () => {
    const selected = ownedFactories({});
    const delivery = { deliver: vi.fn() };

    const result = await createOwnedPreviewMaintenanceRuntime(
      config(),
      { failureNotificationDelivery: delivery },
      observer,
      selected.factories,
    );

    expect(result).toBe(selected.runtime);
    expect(selected.factories.notificationStore).not.toHaveBeenCalled();
    expect(selected.factories.encryption).not.toHaveBeenCalled();
    expect(selected.factories.httpClient).not.toHaveBeenCalled();
    expect(selected.factories.delivery).not.toHaveBeenCalled();
    expect(selected.factories.runtime).toHaveBeenCalledWith(
      expect.objectContaining({ failureNotificationDelivery: delivery }),
    );
  });

  it.each([
    { expected: [], stage: 'notificationStore' },
    { expected: ['store'], stage: 'encryption' },
    { expected: ['encryption', 'store'], stage: 'httpClient' },
    { expected: ['encryption', 'store'], stage: 'slack' },
    { expected: ['encryption', 'store'], stage: 'email' },
    { expected: ['encryption', 'store'], stage: 'delivery' },
    { expected: ['encryption', 'store'], stage: 'runtime' },
  ] as const)(
    'closes every acquired owner when $stage construction fails',
    async ({ expected, stage }) => {
      const order: string[] = [];
      const selected = ownedFactories({
        encryptionClose: () => {
          order.push('encryption');
        },
        storeClose: () => {
          order.push('store');
        },
      });
      const constructionFailure = new Error(`${stage} failed`);
      vi.mocked(selected.factories[stage]).mockImplementationOnce(() => {
        throw constructionFailure;
      });

      await expect(
        createOwnedPreviewMaintenanceRuntime(
          config(),
          {},
          observer,
          selected.factories,
        ),
      ).rejects.toBe(constructionFailure);
      expect(order.sort()).toEqual([...expected].sort());
    },
  );

  it('preserves construction plus synchronous and asynchronous cleanup failures', async () => {
    const constructionFailure = new Error('runtime construction failed');
    const storeFailure = new Error('store cleanup failed');
    const encryptionFailure = new Error('encryption cleanup failed');
    const selected = ownedFactories({
      encryptionClose: () => Promise.reject(encryptionFailure),
      storeClose: () => {
        throw storeFailure;
      },
    });
    vi.mocked(selected.factories.runtime).mockRejectedValueOnce(
      constructionFailure,
    );

    const failure = await createOwnedPreviewMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      storeFailure,
      encryptionFailure,
    ]);
  });

  it('closes the runtime before owned delivery dependencies and caches shutdown', async () => {
    const order: string[] = [];
    const runtimeClose = vi.fn(() => {
      order.push('runtime');
    });
    const selected = ownedFactories({
      encryptionClose: () => {
        order.push('encryption');
      },
      runtime: runtime(runtimeClose),
      storeClose: () => {
        order.push('store');
      },
    });
    const owned = await createOwnedPreviewMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    );
    expect(owned).toBeDefined();

    const selectedRuntime = requireRuntime(owned);
    const first = selectedRuntime.close();
    const second = selectedRuntime.close();
    expect(second).toBe(first);
    await first;

    expect(order[0]).toBe('runtime');
    expect(order.slice(1).sort()).toEqual(['encryption', 'store'].sort());
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it('waits for runtime settlement before cleanup and aggregates every close failure', async () => {
    let settleRuntime: (() => void) | undefined;
    const runtimeFailure = new Error('runtime close failed');
    const storeFailure = new Error('store close failed');
    const encryptionFailure = new Error('encryption close failed');
    const selected = ownedFactories({
      encryptionClose: () => Promise.reject(encryptionFailure),
      runtime: runtime(() =>
        new Promise<void>((resolve) => {
          settleRuntime = () => {
            resolve();
          };
        }).then(() => Promise.reject(runtimeFailure)),
      ),
      storeClose: () => {
        throw storeFailure;
      },
    });
    const owned = await createOwnedPreviewMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    );

    const closing = requireRuntime(owned).close();
    await Promise.resolve();
    expect(selected.storeClose).not.toHaveBeenCalled();
    expect(selected.encryptionClose).not.toHaveBeenCalled();
    if (settleRuntime === undefined)
      throw new Error('Runtime close did not begin');
    settleRuntime();
    const failure = await closing.catch((error: unknown) => error);

    expect((failure as AggregateError).errors).toEqual([
      runtimeFailure,
      storeFailure,
      encryptionFailure,
    ]);
  });

  it('bounds a failed runtime close while deferring delivery dependencies until idle', async () => {
    const runtimeFailure = new Error('runtime close failed');
    const idle = Promise.withResolvers<undefined>();
    const selected = ownedFactories({
      runtime: runtime(
        () => Promise.reject(runtimeFailure),
        () => idle.promise,
      ),
    });
    const owned = await createOwnedPreviewMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    );

    const failure = await requireRuntime(owned)
      .close()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(runtimeFailure);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      name: 'BackgroundTaskShutdownTimeoutError',
    });
    expect(selected.storeClose).not.toHaveBeenCalled();
    expect(selected.encryptionClose).not.toHaveBeenCalled();

    idle.resolve(undefined);
    await vi.waitFor(() => {
      expect(selected.storeClose).toHaveBeenCalledOnce();
      expect(selected.encryptionClose).toHaveBeenCalledOnce();
    });
  });
});
