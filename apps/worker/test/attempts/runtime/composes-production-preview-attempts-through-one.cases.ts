import type { FactoryProvider } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { type NodeAttemptRuntimeOptions } from '../../../src/testing.js';
import { nodeAttemptRuntimeProvider } from '../../../src/transport/providers/node-attempts.js';
import type { WorkerConfig } from '../../../src/config/worker.js';
import { database, providerConfig, providerFactory } from './fixture.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export function registerComposesProductionPreviewAttemptsThroughOne(): void {
  it('composes production and preview attempts through one shared runtime and transfers preview ownership', async () => {
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const createRuntime = vi.fn().mockResolvedValue({
      consumer: {},
      close: vi.fn(),
    });
    const provider = nodeAttemptRuntimeProvider(
      providerConfig(),
      {},
      {
        createPreviewInvoker: vi.fn().mockReturnValue({
          close: vi.fn(),
          invoke: vi.fn(),
        }),
        createPreviewRunStore: vi.fn().mockReturnValue({
          claim: vi.fn(),
          close: closePreview,
          complete: vi.fn(),
          heartbeat: vi.fn(),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        }),
        createRuntime,
      },
    ) as FactoryProvider;

    await expect(providerFactory(provider)(undefined)).resolves.toBeDefined();
    expect(createRuntime).toHaveBeenCalledOnce();
    const [runtimeOptions] = createRuntime.mock.lastCall as unknown as [
      NodeAttemptRuntimeOptions,
    ];
    expect(runtimeOptions.preview).toBeDefined();
    expect(closePreview).not.toHaveBeenCalled();
  });

  it('forwards configured artifact, encryption, and shared database resources', async () => {
    const artifactStore = { put: vi.fn() };
    const connectionEncryption = { open: vi.fn() };
    const databaseRuntime = { close: vi.fn() };
    const createRuntime = vi.fn().mockResolvedValue({
      consumer: {},
      close: vi.fn(),
    });
    const provider = nodeAttemptRuntimeProvider(
      {
        ...providerConfig(),
        artifactStore,
        connectionEncryption,
      } as unknown as WorkerConfig,
      { databaseRuntime },
      {
        createPreviewInvoker: vi.fn().mockReturnValue({ invoke: vi.fn() }),
        createPreviewRunStore: vi.fn().mockReturnValue({ close: vi.fn() }),
        createRuntime,
      },
    ) as FactoryProvider;

    await expect(providerFactory(provider)(undefined)).resolves.toBeDefined();
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactStore,
        connectionEncryption,
        databaseRuntime,
      }),
    );
  });

  it('closes a preview store created before invoker failure and preserves cleanup failure', async () => {
    const primary = new Error('preview invoker failed');
    const cleanup = new Error('preview store close failed');
    const provider = nodeAttemptRuntimeProvider(
      providerConfig(),
      {},
      {
        createPreviewInvoker: () => {
          throw primary;
        },
        createPreviewRunStore: () =>
          ({ close: vi.fn().mockRejectedValue(cleanup) }) as never,
        createRuntime: vi.fn(),
      },
    ) as FactoryProvider;

    const result = await providerFactory(provider)(undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([primary, cleanup]);
  });

  it.each(['fallback', 'override'] as const)(
    'keeps the explicit preview capability %s contract',
    async (selection) => {
      const fallback = { artifacts: vi.fn() };
      const override = { artifacts: vi.fn() };
      let selectedCapabilities: unknown;
      const runtime = await testNodeAttemptRuntime(
        {
          database,
          heartbeatIntervalMillis: 10,
          leaseDurationSeconds: 30,
          preview: {
            invoker: { invoke: vi.fn() },
            runStore: {
              claim: vi.fn(),
              complete: vi.fn(),
              heartbeat: vi.fn(),
              markDispatched: vi.fn(),
            },
            ...(selection === 'override'
              ? { runtimeCapabilities: override }
              : {}),
          },
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        {
          engine: { prepare: vi.fn() },
          notifications: {
            close: vi.fn().mockResolvedValue(undefined),
            publish: vi.fn(),
            resync: vi.fn(),
          },
          reader: {
            close: vi.fn().mockResolvedValue(undefined),
            readForExecution: vi.fn(),
          },
          registry: { execute: vi.fn() },
          runStore: {
            claimDelivery: vi.fn(),
            close: vi.fn().mockResolvedValue(undefined),
            complete: vi.fn(),
            heartbeat: vi.fn(),
            loadInputs: vi.fn(),
            readAttemptOutputs: vi.fn().mockResolvedValue([]),
            listNodeOutcomes: vi.fn().mockResolvedValue([]),
            readNodeOutputs: vi.fn().mockResolvedValue([]),
            readLoopDeclaration: vi.fn(),
            markDispatched: vi.fn(),
          },
          consumerFactory: () => ({
            close: vi.fn().mockResolvedValue({
              abortedJobs: 0,
              forced: false,
            }),
            isReady: vi.fn().mockReturnValue(true),
            waitUntilReady: vi.fn().mockResolvedValue(undefined),
          }),
          previewHandlerFactory: (input) => {
            selectedCapabilities = input.runtimeCapabilities;
            return { handle: vi.fn().mockResolvedValue({ kind: 'duplicate' }) };
          },
          runtimeCapabilities: fallback,
        },
      );
      try {
        expect(selectedCapabilities).toBe(
          selection === 'override' ? override : fallback,
        );
      } finally {
        await runtime.close();
      }
    },
  );
}
