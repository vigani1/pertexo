import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/core/testing';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type PreparedNodeAttempt,
} from '../../../src/testing.js';
import {
  ATTEMPT_ID,
  NODE_RUN_ID,
  RUN_ID,
  TRACEPARENT,
  WORKFLOW_ID,
  WORKSPACE_ID,
  delivery,
  executionHandler,
  executionStore,
  lease,
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT } from './fixture.js';

export function registerCommitsResumedWaitOutputOptionalTrace(): void {
  it.each([undefined, TRACEPARENT])(
    'commits a resumed Wait output with optional trace context %s',
    async (traceparent) => {
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
      const handler = createNodeAttemptHandler({
        engine: { prepare: vi.fn().mockReturnValue(registryPreparedAttempt()) },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue(projection()),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi.fn().mockResolvedValue({
            kind: 'claimed',
            lease: { ...lease(), admissionKind: 'wait_resume' },
          }),
          close: vi.fn(),
          complete,
          heartbeat: vi.fn(),
          loadInputs: vi.fn().mockResolvedValue({
            checkpoint: STORED_CHECKPOINT,
            control: { kind: 'none' },
            completedNodeOutputs: [],
            resumeOutput: { resumed: true },
            runInput: null,
          }),
          readAttemptOutputs: vi.fn().mockResolvedValue([]),
          listNodeOutcomes: vi.fn().mockResolvedValue([]),
          readNodeOutputs: vi.fn().mockResolvedValue([]),
          readLoopDeclaration: vi.fn(),
          markDispatched: vi.fn(),
        },
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(traceparent), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: { status: 'succeeded', output: { resumed: true } },
          ...(traceparent === undefined ? {} : { traceparent }),
        }),
      );
    },
  );

  it('rethrows a non-output persistence failure unchanged', async () => {
    const persistenceError = new Error('database unavailable');
    const runStore = executionStore({
      complete: vi.fn().mockRejectedValue(persistenceError),
    });

    await expect(
      executionHandler(runStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(persistenceError);
  });

  it('treats an exact completed delivery as a no-op before loading workflow state', async () => {
    const claimDelivery = vi.fn().mockResolvedValue({ kind: 'duplicate' });
    const store = {
      claimDelivery,
      close: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn(),
      readAttemptOutputs: vi.fn().mockResolvedValue([]),
      listNodeOutcomes: vi.fn().mockResolvedValue([]),
      readNodeOutputs: vi.fn().mockResolvedValue([]),
      readLoopDeclaration: vi.fn(),
      markDispatched: vi.fn(),
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn(),
    } satisfies PublishedWorkflowReader;
    const engine = {
      prepare: vi.fn(),
    } satisfies NodeAttemptExecutionEngine;
    const handler = createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader,
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'duplicate' });
    expect(reader.readForExecution).not.toHaveBeenCalled();
    expect(engine.prepare).not.toHaveBeenCalled();
  });

  it('loads exact inputs, marks dispatch at the registry seam, and commits success', async () => {
    const attemptLease = lease();
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockResolvedValue({ dispatchedAt: new Date() });
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
        runInput: { hello: 'world' },
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
          definition: { key: 'core.manual', version: 1 },
          executor: { key: 'core.manual', version: 1 },
          config: {},
          input: { hello: 'world' },
          signal,
        });
        return {
          runId: RUN_ID,
          nodeRunId: NODE_RUN_ID,
          attemptId: ATTEMPT_ID,
          invocationKey: attemptLease.invocationKey,
          nodeId: 'manual',
          kind: result.kind,
          output: result.output,
        } as const;
      },
    );
    const engine = {
      prepare: vi.fn().mockReturnValue({ upstreamNodeOutputs: [], execute }),
    } satisfies NodeAttemptExecutionEngine;
    const registryExecute = vi
      .fn<NodeExecutionRegistry['execute']>()
      .mockResolvedValue({
        kind: 'succeeded',
        output: { hello: 'world' },
      });
    const resync = vi.fn().mockResolvedValue({ receivers: 1 });
    const handler = createNodeAttemptHandler({
      engine,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      notifications: {
        close: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        resync,
      },
      reader,
      registry: { execute: registryExecute },
      runStore: store,
      workerId: 'worker-1',
    });
    const signal = new AbortController().signal;

    await expect(
      handler.handle(delivery(TRACEPARENT), { signal }),
    ).resolves.toEqual({
      kind: 'committed',
    });
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(markDispatched.mock.calls[0]?.[0].lease).toBe(attemptLease);
    expect(markDispatched.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(registryExecute).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      lease: attemptLease,
      outcome: { status: 'succeeded', output: { hello: 'world' } },
    });
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(resync).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
    });
  });
}
