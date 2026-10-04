import type {
  DualRegionArtifactStore,
  DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { CoordinatorRunStore } from '@pertexo/database/execution';
import { createQueueTraceRunner } from '@pertexo/observability';
import { describe, expect, it, vi } from 'vitest';
import { createCoordinatorTelemetry } from '../src/execution/coordinator-telemetry.js';
import {
  createCoordinatorRuntime,
  type CoordinatorCompositionFactories,
} from '../src/execution/coordinator-runtime.js';

const region = {
  accessKeyId: 'test',
  secretAccessKey: 'test',
  bucket: 'test',
  endpoint: 'https://invalid.invalid',
  forcePathStyle: true,
  maxObjectBytes: 1_048_576,
  region: 'test-1',
  requestTimeoutMs: 100,
};
const config: DualRegionArtifactStoreConfig = {
  primary: region,
  recovery: { ...region, bucket: 'recovery' },
};

/** Only database, queue, and storage boundaries are simulated; actual runtime/lifecycle compose. */
function fixture(native: boolean) {
  const storage = {
    close: vi.fn(),
    getStream: vi.fn(),
    checkReadiness: vi
      .fn()
      .mockResolvedValue({ bucket: 'test', region: 'test-1' }),
  };
  const consumer = {
    close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
    isReady: () => true,
    waitUntilReady: () => Promise.resolve(),
  };
  const scanner = {
    close: vi.fn().mockResolvedValue(undefined),
    claimDueWakeups: vi.fn().mockResolvedValue(0),
  };
  const closeRunStore = vi.fn().mockResolvedValue(undefined);
  const runStore: CoordinatorRunStore = {
    loadAdvanceState: vi.fn(),
    commitAdvancePlan: vi.fn(),
    acknowledgeAdvanceDelivery: vi.fn(),
    close: closeRunStore,
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    ...(native ? { readCoordinatorCallDeclaration: vi.fn() } : {}),
  };
  const factory = vi.fn(() => storage as unknown as DualRegionArtifactStore);
  const factories: CoordinatorCompositionFactories = {
    consumer: vi.fn(() => consumer),
    reader: vi.fn(),
    runStore: vi.fn(),
    notifications: vi.fn(),
    dueScanner: vi.fn(),
    deadlineScanner: vi.fn(),
    telemetry: createCoordinatorTelemetry,
    traceRunner: createQueueTraceRunner,
    artifactStore: factory,
  };
  const dependencies = {
    runStore,
    reader: {
      readForExecution: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    },
    notifications: {
      publish: vi.fn(),
      resync: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    },
    dueWakeupScanner: scanner,
    deadlineWakeupScanner: scanner,
  };
  const options = {
    database: {
      connectionString: 'postgresql://invalid.invalid/test',
      connectionTimeoutMillis: 100,
      idleTimeoutMillis: 1_000,
      max: 1,
      ownerRole: 'pertexo_owner',
      workerRuntimeRole: 'pertexo_worker',
    },
    artifactStore: config,
    redisUrl: 'redis://invalid.invalid',
    maximumAdmissions: 1,
  };
  return {
    storage,
    consumer,
    runStore,
    closeRunStore,
    factory,
    factories,
    dependencies,
    options,
  };
}

describe('coordinator framework artifact storage compatibility and ownership', () => {
  it.each(['configured', 'borrowed'] as const)(
    'retained/native-OFF startup, readiness, and drain ignore %s storage',
    async (kind) => {
      const selected = fixture(false);
      selected.factory.mockImplementation(() => {
        throw new Error('Disabled storage must not be constructed');
      });
      selected.storage.checkReadiness.mockRejectedValue(
        new Error('Disabled storage must not be read'),
      );
      const runtime = await createCoordinatorRuntime(
        selected.options,
        {
          ...selected.dependencies,
          ...(kind === 'borrowed' ? { artifactStore: selected.storage } : {}),
        },
        selected.factories,
      );
      await runtime.checkReadiness();
      await runtime.close();
      expect(selected.factory).not.toHaveBeenCalled();
      expect(selected.storage.checkReadiness).not.toHaveBeenCalled();
      expect(selected.storage.close).not.toHaveBeenCalled();
    },
  );

  it('constructs one owned client and closes it once only after consumer activity drains', async () => {
    const selected = fixture(true);
    const drained = Promise.withResolvers<{
      abortedJobs: number;
      forced: boolean;
    }>();
    selected.consumer.close.mockReturnValue(drained.promise);
    const runtime = await createCoordinatorRuntime(
      selected.options,
      selected.dependencies,
      selected.factories,
    );
    await runtime.checkReadiness();
    expect(selected.factory).toHaveBeenCalledExactlyOnceWith(
      config.primary,
      config.recovery,
    );
    const close = runtime.close();
    await vi.waitFor(() => {
      expect(selected.consumer.close).toHaveBeenCalledOnce();
    });
    expect(selected.storage.close).not.toHaveBeenCalled();
    drained.resolve({ abortedJobs: 0, forced: false });
    await close;
    await runtime.close();
    expect(selected.storage.close).toHaveBeenCalledOnce();
    expect(selected.storage.checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('closes owned storage after readiness failure without starting queue consumers', async () => {
    const selected = fixture(true);
    const failure = new Error('Storage readiness failed');
    selected.storage.checkReadiness.mockRejectedValue(failure);
    await expect(
      createCoordinatorRuntime(
        selected.options,
        selected.dependencies,
        selected.factories,
      ),
    ).rejects.toBe(failure);
    expect(selected.factories.consumer).not.toHaveBeenCalled();
    expect(selected.storage.close).toHaveBeenCalledOnce();
    expect(selected.closeRunStore).toHaveBeenCalledOnce();
  });

  it('checks but never closes or reconstructs a borrowed native framework client', async () => {
    const selected = fixture(true);
    const runtime = await createCoordinatorRuntime(
      selected.options,
      { ...selected.dependencies, artifactStore: selected.storage },
      selected.factories,
    );
    await runtime.checkReadiness();
    await runtime.close();
    expect(selected.factory).not.toHaveBeenCalled();
    expect(selected.storage.checkReadiness).toHaveBeenCalledTimes(2);
    expect(selected.storage.close).not.toHaveBeenCalled();
  });
});
