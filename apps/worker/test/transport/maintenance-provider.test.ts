import type { FailureNotificationStore } from '@pertexo/database/notifications';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import type { QueueConsumerObserver } from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../../src/config/worker.js';
import type { MaintenanceRuntime } from '../../src/maintenance/runtime.js';
import {
  createOwnedMaintenanceRuntime,
  type MaintenanceProviderFactories,
} from '../../src/transport/providers/maintenance.js';
import { workerEnvironment } from '../support/worker-environment.js';

const observer = {} as QueueConsumerObserver;

function config() {
  return parseWorkerConfig({
    ...workerEnvironment,
    CONNECTION_KMS_KEY_REFERENCE: 'alias/pertexo-connections',
    CONNECTION_KMS_REGION: 'eu-central-1',
    OUTBOX_DISPATCH_OPERATION_TIMEOUT_MILLIS: '100',
  });
}

function runtime(close: () => Promise<void> | void = vi.fn()) {
  return {
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close,
    consumer: {
      close: vi.fn(),
      isReady: () => true,
      waitUntilReady: () => Promise.resolve(),
    },
  } as unknown as MaintenanceRuntime;
}

function ownedFactories(options: {
  storeClose?: () => Promise<void> | void;
  encryptionClose?: () => Promise<void> | void;
  runtime?: MaintenanceRuntime;
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
  } as unknown as MaintenanceProviderFactories & typeof factoryStages;
  return {
    encryption,
    encryptionClose,
    factories,
    runtime: selectedRuntime,
    store,
    storeClose,
  };
}

describe('preview maintenance provider ownership', () => {
  it('composes failure notification delivery when connection encryption is configured', async () => {
    const selected = ownedFactories({});
    const result = await createOwnedMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    );
    expect(selected.factories.notificationStore).toHaveBeenCalledOnce();
    expect(selected.factories.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        failureNotificationDelivery: expect.anything() as unknown,
      }),
    );
    await result.close();
  });

  it('returns an injected runtime without acquiring hidden dependencies', async () => {
    const selectedRuntime = runtime();
    const customRuntime = ownedFactories({});
    await expect(
      createOwnedMaintenanceRuntime(
        config(),
        { maintenanceRuntime: selectedRuntime },
        observer,
        customRuntime.factories,
      ),
    ).resolves.toBe(selectedRuntime);
    expect(customRuntime.factories.notificationStore).not.toHaveBeenCalled();
    expect(customRuntime.factories.runtime).not.toHaveBeenCalled();
  });

  it('composes no failure notification delivery without connection encryption', async () => {
    const selected = ownedFactories({});
    const withoutEncryption = parseWorkerConfig(workerEnvironment);

    const result = await createOwnedMaintenanceRuntime(
      withoutEncryption,
      {},
      observer,
      selected.factories,
    );
    expect(selected.factories.notificationStore).not.toHaveBeenCalled();
    expect(selected.factories.runtime).toHaveBeenCalledWith(
      expect.not.objectContaining({
        failureNotificationDelivery: expect.anything() as unknown,
      }),
    );
    await result.close();
  });

  it('uses an injected delivery without acquiring store, encryption, or HTTP clients', async () => {
    const selected = ownedFactories({});
    const delivery = { deliver: vi.fn() };

    const result = await createOwnedMaintenanceRuntime(
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
        createOwnedMaintenanceRuntime(
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

    const failure = await createOwnedMaintenanceRuntime(
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

  it('hands the delivery resources to the runtime it builds', async () => {
    const selected = ownedFactories({});

    await createOwnedMaintenanceRuntime(
      config(),
      {},
      observer,
      selected.factories,
    );

    expect(selected.factories.runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryOwners: [selected.store, selected.encryption, undefined],
      }),
    );
    expect(selected.storeClose).not.toHaveBeenCalled();
    expect(selected.encryptionClose).not.toHaveBeenCalled();
  });
});
