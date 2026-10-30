import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../../../src/testing.js';
import {
  ATTEMPT_ID,
  NODE_RUN_ID,
  RUN_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  delivery,
  executionStore,
  lease,
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT } from './fixture.js';

export function registerCommitsPreparedSuspensionExactDuration(): void {
  it('commits a prepared suspension with its exact duration', async () => {
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const runStore = executionStore({ complete });
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          ...registryPreparedAttempt(),
          suspensionDurationSeconds: 45,
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: {
        execute: vi.fn().mockResolvedValue({
          kind: 'succeeded',
          output: { waiting: true },
        }),
      },
      runStore,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'suspended',
          output: { waiting: true },
          durationSeconds: 45,
        },
      }),
    );
  });

  it('lets a dispatch-aware executor mark immediately before provider I/O', async () => {
    const attemptLease = {
      ...lease(),
      sideEffectClass: 'idempotent_with_key' as const,
      providerIdempotencyKey: 'provider-attempt-key',
      providerDispatchBinding: 'email:sha256:' + 'b'.repeat(64),
      providerDispatchUnresolved: true as const,
    };
    const order: string[] = [];
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockImplementation(() => {
        order.push('dispatch-marker');
        return Promise.resolve({ dispatchedAt: new Date() });
      });
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const store = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      close: vi.fn().mockResolvedValue(undefined),
      complete,
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        checkpoint: STORED_CHECKPOINT,
        control: { kind: 'none' },
        completedNodeOutputs: [],
        runInput: {},
      }),
      readAttemptOutputs: vi.fn().mockResolvedValue([]),
      listNodeOutcomes: vi.fn().mockResolvedValue([]),
      readNodeOutputs: vi.fn().mockResolvedValue([]),
      readLoopDeclaration: vi.fn(),
      markDispatched,
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue(projection()),
    } satisfies PublishedWorkflowReader;
    const execute = vi.fn(
      async ({
        registry,
        signal,
      }: Parameters<PreparedNodeAttempt['execute']>[0]) => {
        const result = await registry.execute({
          definition: { key: 'http.request', version: 1 },
          executor: { key: 'http.request', version: 1 },
          config: {},
          input: {},
          signal,
        });
        return {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          attemptId: ATTEMPT_ID,
          invocationKey: attemptLease.invocationKey,
          nodeId: attemptLease.nodeId,
          kind: result.kind,
          output: result.output,
        } as const;
      },
    );
    const connections = { assertCurrent: vi.fn(), resolve: vi.fn() };
    const artifacts = { write: vi.fn() };
    const registryExecute = vi.fn<NodeExecutionRegistry['execute']>(
      async (request) => {
        order.push('executor-start');
        expect(request.runtime).toMatchObject({
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          attemptId: ATTEMPT_ID,
          attemptNumber: 1,
          sideEffectClass: 'idempotent_with_key',
          providerIdempotencyKey: 'provider-attempt-key',
          providerDispatchBinding: 'email:sha256:' + 'b'.repeat(64),
          providerDispatchUnresolved: true,
          connections,
          artifacts,
        });
        await request.runtime?.beforeDispatch({
          connectionFence: {
            connectionId: '11111111-1111-4111-8111-111111111111',
            expectedProviderKey: 'email',
            expectedAuthType: 'resend_api_key',
            secretVersionId: '22222222-2222-4222-8222-222222222222',
          },
          providerDispatchBinding: 'email:sha256:' + 'a'.repeat(64),
        });
        await expect(request.runtime?.beforeDispatch()).rejects.toMatchObject({
          code: 'duplicate_dispatch',
        });
        order.push('provider-io');
        return { kind: 'succeeded', output: { status: 204 } };
      },
    );
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({ upstreamNodeOutputs: [], execute }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader,
      registry: {
        dispatchMode: () => 'executor_controlled',
        execute: registryExecute,
      },
      runStore: store,
      runtimeCapabilities: {
        connections: () => connections,
        artifacts: () => artifacts,
      },
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(order).toEqual(['executor-start', 'dispatch-marker', 'provider-io']);
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(markDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
        providerDispatchBinding: 'email:sha256:' + 'a'.repeat(64),
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'succeeded', output: { status: 204 } },
      }),
    );
  });
}
