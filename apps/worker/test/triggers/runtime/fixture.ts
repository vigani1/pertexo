import type {
  ScheduleTriggerScanner,
  WorkflowTriggerReconciliationDatabase,
} from '@pertexo/core/testing';
import type { QueueConsumer, QueueConsumerOptions } from '@pertexo/queue';
import { vi } from 'vitest';
import type { StructuredLogger } from '@pertexo/observability';

export function dependencies() {
  const consumer = {
    close: vi
      .fn<NonNullable<QueueConsumer['close']>>()
      .mockResolvedValue({ abortedJobs: 0, forced: false }),
    isReady: vi
      .fn<NonNullable<QueueConsumer['isReady']>>()
      .mockReturnValue(true),
    waitUntilReady: vi
      .fn<NonNullable<QueueConsumer['waitUntilReady']>>()
      .mockResolvedValue(undefined),
  } satisfies QueueConsumer;
  const scanner = {
    close: vi
      .fn<NonNullable<ScheduleTriggerScanner['close']>>()
      .mockResolvedValue(undefined),
    scanDue: vi
      .fn<NonNullable<ScheduleTriggerScanner['scanDue']>>()
      .mockResolvedValue({
        claimed: 0,
        accepted: 0,
        skipped: 0,
        paused: 0,
        deferred: 0,
        maxLagSeconds: 0,
      }),
  } satisfies ScheduleTriggerScanner;
  const reconciliation = {
    close: vi
      .fn<NonNullable<WorkflowTriggerReconciliationDatabase['close']>>()
      .mockResolvedValue(undefined),
    reconcile:
      vi.fn<NonNullable<WorkflowTriggerReconciliationDatabase['reconcile']>>(),
    recordFailure:
      vi.fn<
        NonNullable<WorkflowTriggerReconciliationDatabase['recordFailure']>
      >(),
  } satisfies WorkflowTriggerReconciliationDatabase;
  const coordination = {
    close: vi.fn().mockResolvedValue(undefined),
    scanDue: vi.fn().mockResolvedValue({
      examined: 0,
      started: 0,
      pending: 0,
      refused: 0,
      idle: 0,
    }),
  };
  let options: QueueConsumerOptions | undefined;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    reconciliationCompleted: vi.fn(),
    scanCompleted: vi.fn(),
    scanFailed: vi.fn(),
  };
  return {
    consumer,
    coordination,
    scanner,
    reconciliation,
    logger,
    telemetry,
    consumerFactory: vi.fn((input: QueueConsumerOptions): QueueConsumer => {
      options = input;
      return consumer;
    }),
    consumerOptions: (): QueueConsumerOptions | undefined => options,
  };
}

export const options = {
  database: {
    connectionString: 'postgresql://worker:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
  },
  leaseOwner: 'schedule:worker-test',
  onTimeWindowSeconds: 300,
  pollIntervalMillis: 20,
  batchSize: 10,
  leaseDurationSeconds: 30,
  redisUrl: 'redis://localhost:6379/0',
};
