import { randomUUID } from 'node:crypto';
import {
  parseDatabaseConfig,
  type FailureNotificationStore,
} from '@pertexo/database/testing';
import { jobIdForOutboxEvent, JOB_NAME } from '@pertexo/queue';
import { vi } from 'vitest';
import { testMaintenanceRuntime } from '../../support/runtime-factories.js';

export function delivery() {
  const data = {
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

export function maintenanceRuntime(
  failureNotificationStore: FailureNotificationStore,
  backgroundTaskShutdownTimeoutMillis: number,
) {
  return testMaintenanceRuntime(
    {
      backgroundTaskShutdownTimeoutMillis,
      database: parseDatabaseConfig({
        connectionString:
          'postgresql://pertexo_app:secret@localhost:5432/pertexo',
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
      ...idleStores(),
      failureNotificationStore,
    },
  );
}

export function routedDelivery(name: string) {
  const outboxEventId = randomUUID();
  return {
    name,
    data: {
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

/** Stores every maintenance runtime composes; these tests do not exercise them. */
export function idleStores() {
  return {
    connectionHealthStore: { apply: vi.fn() },
    errorWorkflowStore: {
      dispatch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    reconciliationStore: { close: vi.fn(), reconcile: vi.fn() },
    unknownOutcomeStore: { close: vi.fn(), reconcile: vi.fn() },
    runReplayStore: {
      close: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
      replay: vi.fn(),
    },
  };
}

/** Connection health is always composed; these tests do not exercise it. */
export const idleConnectionHealth = {
  handler: vi.fn(() => ({ handle: vi.fn() })),
  store: vi.fn(() => ({ apply: vi.fn() })),
};

export const idleErrorWorkflows = {
  store: vi.fn(() => ({ dispatch: vi.fn(), close: vi.fn() })),
  handler: vi.fn(() => ({ handle: vi.fn() })),
};
