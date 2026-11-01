import { transportMetrics } from '../../support/transport/metrics.js';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
  ReleaseOutboxResult,
} from '@pertexo/core/testing';
import { JOB_NAME, type QueueProducer } from '@pertexo/queue';
import { vi } from 'vitest';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';

export const EVENT_ID = '11111111-1111-4111-8111-111111111111';

export const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';

export const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';

export const RUN_ID = '44444444-4444-4444-8444-444444444444';

function indexedId(prefix: string, index: number): string {
  return `${prefix}-${index.toString(16).padStart(12, '0')}`;
}

export function indexedEvent(index: number): LeasedOutboxEvent {
  return event({
    id: indexedId('11111111-1111-4111-8111', index),
    workspaceId: indexedId('33333333-3333-4333-8333', index),
  });
}

export function checksum(value: unknown): string {
  return canonicalOutboxPayloadChecksum(value);
}

export function event(
  overrides: Partial<LeasedOutboxEvent> = {},
): LeasedOutboxEvent {
  const payload = Object.hasOwn(overrides, 'payload')
    ? overrides.payload
    : { runId: RUN_ID };
  const defaults: LeasedOutboxEvent = {
    aggregateId: RUN_ID,
    aggregateType: 'workflow-run',
    availableAt: new Date(0),
    id: EVENT_ID,
    jobName: JOB_NAME.advanceWorkflowRun,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    leaseOwner: 'worker-a',
    leaseToken: LEASE_TOKEN,
    payload,
    payloadChecksum: checksum(payload),
    publishAttempts: 1,
    redeliveries: 0,
    workspaceId: WORKSPACE_ID,
  };
  return Object.freeze({
    ...defaults,
    ...overrides,
    payload,
    payloadChecksum: overrides.payloadChecksum ?? checksum(payload),
  });
}

export function boundaries(events: readonly LeasedOutboxEvent[] = [event()]) {
  interface BoundariesMockPorts {
    database: OutboxDispatcherDatabase;
    producer: QueueProducer;
  }

  return {
    database: {
      checkReadiness: vi
        .fn<NonNullable<BoundariesMockPorts['database']['checkReadiness']>>()
        .mockResolvedValue(undefined),
      claimBatch: vi
        .fn<NonNullable<BoundariesMockPorts['database']['claimBatch']>>()
        .mockResolvedValue({ events }),
      close: vi
        .fn<NonNullable<BoundariesMockPorts['database']['close']>>()
        .mockResolvedValue(undefined),
      markPublished: vi
        .fn<NonNullable<BoundariesMockPorts['database']['markPublished']>>()
        .mockResolvedValue(true),
      observeBacklog: vi
        .fn()
        .mockResolvedValue({ backlog: 7, oldestAgeSeconds: 12 }),
      releaseOrFail: vi
        .fn<(_input: unknown) => Promise<ReleaseOutboxResult>>()
        .mockResolvedValue('retry_scheduled'),
    },
    producer: {
      close: vi
        .fn<NonNullable<BoundariesMockPorts['producer']['close']>>()
        .mockResolvedValue(undefined),
      isReady: vi
        .fn<NonNullable<BoundariesMockPorts['producer']['isReady']>>()
        .mockReturnValue(true),
      observe: vi
        .fn<NonNullable<BoundariesMockPorts['producer']['observe']>>()
        .mockResolvedValue([
          {
            depth: 3,
            oldestJobAgeSeconds: 2,
            queueName: 'workflow-coordinator',
          },
        ]),
      publish: vi
        .fn<NonNullable<BoundariesMockPorts['producer']['publish']>>()
        .mockResolvedValue({
          jobId: `outbox-${EVENT_ID}`,
          jobName: JOB_NAME.advanceWorkflowRun,
          outcome: 'published',
          queueName: 'workflow-coordinator',
        }),
      waitUntilReady: vi
        .fn<NonNullable<BoundariesMockPorts['producer']['waitUntilReady']>>()
        .mockResolvedValue(undefined),
    },
  } satisfies {
    database: OutboxDispatcherDatabase;
    producer: QueueProducer;
  };
}

export function createDispatcher({
  boundaries: selected = boundaries(),
  drainState = new WorkerDrainState(),
  metrics = transportMetrics(),
  operationTimeoutMillis = 5_000,
  pollIntervalMillis = 10,
}: Readonly<{
  boundaries?: ReturnType<typeof boundaries> | undefined;
  drainState?: WorkerDrainState | undefined;
  metrics?: ReturnType<typeof transportMetrics> | undefined;
  operationTimeoutMillis?: number | undefined;
  pollIntervalMillis?: number | undefined;
}> = {}): OutboxDispatcher {
  return new OutboxDispatcher(selected.database, selected.producer, {
    drainState: drainState,
    options: {
      batchSize: 10,
      jobNames: [
        JOB_NAME.advanceWorkflowRun,
        JOB_NAME.reconcileWorkflowTriggers,
      ],
      leaseDurationMillis: 30_000,
      leaseOwner: 'worker-a',
      operationTimeoutMillis,
      pollIntervalMillis,
      retryDelayMillis: 1_000,
    },
    metrics: metrics,
  });
}

export function cleanAppsWorkerTestTransportOutboxDispatcherOutboxDispatcherFixture() {
  vi.useRealTimers();
}
