import type {
  CoordinatorRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import { CoordinatorDeliveryMismatchError } from '@pertexo/database/testing';
import {
  JOB_NAME,
  QUEUE_NAME,
  type QueueConsumer,
  type QueueConsumerOptions,
} from '@pertexo/queue';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/unbound-method -- assertions target injected seam fakes */

import { createCoordinatorRuntime } from '../src/execution/coordinator-runtime.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const OUTBOX_EVENT_ID = '44444444-4444-4444-8444-444444444444';

describe('coordinator runtime', () => {
  it('polls due PostgreSQL wakeups without overlap and drains the scanner on close', async () => {
    let releaseScan: (() => void) | undefined;
    const scanStarted = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanner = {
      claimDueWakeups: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient database outage'))
        .mockImplementation(async () => scanStarted),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = { close: vi.fn().mockResolvedValue(undefined) };
    const notifications = {
      ...adapter,
      publish: vi.fn().mockResolvedValue(undefined),
      resync: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await createCoordinatorRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        },
        dueWakeupBatchSize: 10,
        dueWakeupPollIntervalMillis: 20,
        maximumAdmissions: 32,
        redisUrl: 'redis://unreachable.invalid:6379/0',
      },
      {
        consumerFactory: () => consumer,
        engine: { advance: vi.fn() },
        notifications,
        reader: { ...adapter, readForExecution: vi.fn() },
        runStore: {
          ...adapter,
          acknowledgeAdvanceDelivery: vi.fn(),
          loadAdvanceState: vi.fn(),
          commitAdvancePlan: vi.fn(),
        },
        dueWakeupScanner: scanner,
      },
    );

    await vi.waitFor(() => {
      expect(scanner.claimDueWakeups).toHaveBeenCalledTimes(2);
    });
    const closing = runtime.close();
    expect(scanner.close).not.toHaveBeenCalled();
    releaseScan?.();
    await closing;
    expect(scanner.claimDueWakeups).toHaveBeenCalledTimes(2);
    expect(scanner.close).toHaveBeenCalledOnce();
  });

  it('composes one traced coordinator consumer and closes every owned adapter', async () => {
    let consumerOptions: QueueConsumerOptions | undefined;
    const consumer: QueueConsumer = {
      close: vi.fn().mockResolvedValue({ abortedJobs: 0, forced: false }),
      isReady: vi.fn().mockReturnValue(true),
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
    };
    const runStore: CoordinatorRunStore = {
      acknowledgeAdvanceDelivery: vi.fn().mockResolvedValue({
        kind: 'acknowledged',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      loadAdvanceState: vi.fn().mockResolvedValue({
        kind: 'ready',
        state: {
          runId: RUN_ID,
          workflowVersionId: VERSION_ID,
          checkpoint: {},
          observations: [],
        },
      }),
      commitAdvancePlan: vi.fn().mockResolvedValue({
        kind: 'committed',
        revision: 1,
        admittedAttempts: [],
      }),
    };
    const reader: PublishedWorkflowReader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: '55555555-5555-4555-8555-555555555555',
          versionNumber: 1,
          schemaVersion: 1,
          checksum:
            'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
          executableSchemaVersion: 2,
          executableJson: {},
          compatibilityReleaseEpoch: 1,
        },
      }),
    };
    const runtime = await createCoordinatorRuntime(
      {
        database: {
          connectionString:
            'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          max: 5,
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        },
        maximumAdmissions: 32,
        redisUrl: 'redis://localhost:6379/0',
      },
      {
        clock: { now: () => '2026-08-21T00:00:00.000Z' },
        consumerFactory: (options): QueueConsumer => {
          consumerOptions = options;
          return consumer;
        },
        engine: {
          advance: vi.fn().mockResolvedValue({
            kind: 'no_change',
            revision: 0,
          }),
        },
        dueWakeupScanner: {
          claimDueWakeups: vi.fn().mockResolvedValue(0),
          close: vi.fn().mockResolvedValue(undefined),
        },
        reader,
        runStore,
      },
    );

    expect(consumerOptions).toMatchObject({
      queueName: QUEUE_NAME.workflowCoordinator,
      redisUrl: 'redis://localhost:6379/0',
    });
    expect(consumerOptions?.traceRunner).toBeDefined();
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    vi.mocked(runStore.acknowledgeAdvanceDelivery).mockRejectedValueOnce(
      new CoordinatorDeliveryMismatchError(),
    );
    await expect(
      consumerOptions?.handler(
        {
          name: JOB_NAME.advanceWorkflowRun,
          data: {
            schemaVersion: 1,
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            outboxEventId: OUTBOX_EVENT_ID,
          },
          transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });

    await runtime.close();
    await runtime.close();
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(reader.close).toHaveBeenCalledOnce();
    expect(runStore.close).toHaveBeenCalledOnce();
  });
});
