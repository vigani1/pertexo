import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import type { RunEventNotificationPublisher } from '@pertexo/queue';

import { expect, it, vi } from 'vitest';
import type { PreviewAttemptRunStore } from '../../../src/testing.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export function registerClosesPreviewStoreConsumerConstructionFails(): void {
  it('closes the preview store when consumer construction fails', async () => {
    const startupError = new Error('consumer construction failed');
    const closePreview = vi.fn().mockResolvedValue(undefined);
    const previewStore = {
      claim: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['claim']
        >
      >(),
      close: closePreview,
      complete: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['complete']
        >
      >(),
      heartbeat: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['heartbeat']
        >
      >(),
      markDispatched: vi.fn<
        NonNullable<
          (PreviewAttemptRunStore & {
            close(): Promise<void>;
          })['markDispatched']
        >
      >(),
    } satisfies PreviewAttemptRunStore & {
      close(): Promise<void>;
    };
    const closeRunStore = vi.fn().mockResolvedValue(undefined);
    const runStore = {
      claimDelivery: vi.fn<NonNullable<NodeAttemptRunStore['claimDelivery']>>(),
      close: closeRunStore,
      complete: vi.fn<NonNullable<NodeAttemptRunStore['complete']>>(),
      heartbeat: vi.fn<NonNullable<NodeAttemptRunStore['heartbeat']>>(),
      loadInputs: vi.fn<NonNullable<NodeAttemptRunStore['loadInputs']>>(),
      markDispatched:
        vi.fn<NonNullable<NodeAttemptRunStore['markDispatched']>>(),
      readAttemptOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readAttemptOutputs']>>()
        .mockResolvedValue([]),
      listNodeOutcomes: vi
        .fn<NonNullable<NodeAttemptRunStore['listNodeOutcomes']>>()
        .mockResolvedValue([]),
      readNodeOutputs: vi
        .fn<NonNullable<NodeAttemptRunStore['readNodeOutputs']>>()
        .mockResolvedValue([]),
      readLoopDeclaration:
        vi.fn<NonNullable<NodeAttemptRunStore['readLoopDeclaration']>>(),
    } satisfies NodeAttemptRunStore;
    const closeReader = vi.fn().mockResolvedValue(undefined);
    const reader = {
      close: closeReader,
      readForExecution:
        vi.fn<NonNullable<PublishedWorkflowReader['readForExecution']>>(),
    } satisfies PublishedWorkflowReader;
    const closeNotifications = vi.fn().mockResolvedValue(undefined);
    const notifications = {
      close: closeNotifications,
      publish: vi.fn<NonNullable<RunEventNotificationPublisher['publish']>>(),
      resync: vi.fn<NonNullable<RunEventNotificationPublisher['resync']>>(),
    } satisfies RunEventNotificationPublisher;

    await expect(
      testNodeAttemptRuntime(
        {
          database: {
            connectionString:
              'postgresql://pertexo_app:secret@localhost:5432/pertexo',
            connectionTimeoutMillis: 5_000,
            idleTimeoutMillis: 30_000,
            max: 5,
            ownerRole: 'pertexo_owner',
          },
          heartbeatIntervalMillis: 10_000,
          leaseDurationSeconds: 30,
          preview: {
            invoker: { invoke: vi.fn() },
            runStore: previewStore,
          },
          redisUrl: 'redis://localhost:6379/0',
          workerId: 'worker-1',
        },
        {
          consumerFactory: () => {
            throw startupError;
          },
          engine: { prepare: vi.fn() },
          notifications,
          reader,
          registry: { execute: vi.fn() },
          runStore,
        },
      ),
    ).rejects.toBe(startupError);

    expect(closePreview).toHaveBeenCalledOnce();
    expect(closeRunStore).toHaveBeenCalledOnce();
    expect(closeReader).toHaveBeenCalledOnce();
    expect(closeNotifications).toHaveBeenCalledOnce();
  });
}
