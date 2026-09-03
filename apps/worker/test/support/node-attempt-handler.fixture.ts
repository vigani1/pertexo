import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
  PublishedWorkflowV2Projection,
} from '@pertexo/database/testing';
import { JOB_NAME, type QueueDelivery } from '@pertexo/queue';
import { vi } from 'vitest';

import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../../src/testing.js';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
export const RUN_ID = '22222222-2222-4222-8222-222222222222';
export const NODE_RUN_ID = '33333333-3333-4333-8333-333333333333';
export const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
export const OUTBOX_EVENT_ID = '55555555-5555-4555-8555-555555555555';
export const VERSION_ID = '66666666-6666-4666-8666-666666666666';
export const WORKFLOW_ID = '77777777-7777-4777-8777-777777777777';
export const TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

export function delivery(
  traceparent?: string,
): Extract<QueueDelivery, { name: 'execute-node-attempt' }> {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      attemptId: ATTEMPT_ID,
      outboxEventId: OUTBOX_EVENT_ID,
      ...(traceparent === undefined ? {} : { traceparent }),
    },
    transport: { attemptsMade: 0, jobId: `outbox-${OUTBOX_EVENT_ID}` },
  };
}

export function projection(): PublishedWorkflowV2Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    versionNumber: 1,
    schemaVersion: 1,
    checksum:
      'wf:v2:sha256:1111111111111111111111111111111111111111111111111111111111111111',
    executableSchemaVersion: 2,
    executableJson: { schemaVersion: 2 },
    compatibilityReleaseEpoch: 1,
  };
}

export function lease(): NodeAttemptLease {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowVersionId: VERSION_ID,
    nodeRunId: NODE_RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    admissionKind: 'execute',
    invocationKey: `${VERSION_ID}|manual|b:|i:`,
    nodeId: 'manual',
    sideEffectClass: 'safe',
    workerId: 'worker-1',
    fenceToken: 1,
    leaseExpiresAt: new Date('2026-08-21T00:01:00.000Z'),
    delivery: {
      outboxEventId: OUTBOX_EVENT_ID,
      payloadChecksum: 'a'.repeat(64),
    },
  };
}

export function registryPreparedAttempt(): PreparedNodeAttempt {
  return {
    upstreamNodeOutputs: [],
    execute: async ({ registry, signal }) => {
      const result = await registry.execute({
        config: {},
        definition: { key: 'core.manual', version: 1 },
        executor: { key: 'core.manual', version: 1 },
        input: null,
        signal,
      });
      return {
        runId: RUN_ID,
        nodeRunId: NODE_RUN_ID,
        attemptId: ATTEMPT_ID,
        invocationKey: lease().invocationKey,
        nodeId: 'manual',
        kind: result.kind,
        output: result.output,
      };
    },
  };
}

export function executionStore(
  overrides: Partial<NodeAttemptRunStore> = {},
): NodeAttemptRunStore {
  return {
    claimDelivery: vi
      .fn()
      .mockResolvedValue({ kind: 'claimed', lease: lease() }),
    close: vi.fn(),
    complete: vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID }),
    heartbeat: vi.fn(),
    loadInputs: vi.fn().mockResolvedValue({
      abortRequested: false,
      completedNodeOutputs: {},
      runInput: null,
    }),
    markDispatched: vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() }),
    ...overrides,
  };
}

export function executionHandler(runStore: NodeAttemptRunStore) {
  return createNodeAttemptHandler({
    engine: { prepare: vi.fn().mockReturnValue(registryPreparedAttempt()) },
    heartbeatIntervalMillis: 1_000,
    leaseDurationSeconds: 30,
    reader: {
      close: vi.fn(),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
    },
    registry: {
      execute: vi.fn().mockResolvedValue({ kind: 'succeeded', output: null }),
    },
    runStore,
    workerId: 'worker-1',
  });
}
