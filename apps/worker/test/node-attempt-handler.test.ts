import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import { describe, expect, it, vi } from 'vitest';

import {
  createNodeAttemptHandler,
  type NodeAttemptExecutionEngine,
  type PreparedNodeAttempt,
} from '../src/testing.js';
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
} from './support/node-attempt-handler.fixture.js';

describe('NodeAttemptHandler', () => {
  it.each([9, 1_000.5, 30_000])(
    'rejects invalid heartbeat interval %s',
    (heartbeatIntervalMillis) => {
      expect(() =>
        createNodeAttemptHandler({
          engine: { prepare: vi.fn() },
          heartbeatIntervalMillis,
          leaseDurationSeconds: 30,
          reader: { close: vi.fn(), readForExecution: vi.fn() },
          registry: { execute: vi.fn() },
          runStore: {
            claimDelivery: vi.fn(),
            close: vi.fn(),
            complete: vi.fn(),
            heartbeat: vi.fn(),
            loadInputs: vi.fn(),
            markDispatched: vi.fn(),
          },
          workerId: 'worker-1',
        }),
      ).toThrow(TypeError);
    },
  );

  it.each([
    [{ kind: 'not_found' as const }, 'workflow_not_found'],
    [
      { kind: 'v1_projection' as const, workflowVersion: {} as never },
      'workflow_non_executable',
    ],
  ])(
    'rejects an unavailable published workflow as %s',
    async (published, code) => {
      const handler = createNodeAttemptHandler({
        engine: { prepare: vi.fn() },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue(published),
        },
        registry: { execute: vi.fn() },
        runStore: {
          claimDelivery: vi
            .fn()
            .mockResolvedValue({ kind: 'claimed', lease: lease() }),
          close: vi.fn(),
          complete: vi.fn(),
          heartbeat: vi.fn(),
          loadInputs: vi.fn(),
          markDispatched: vi.fn(),
        },
        workerId: 'worker-1',
      });
      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code });
    },
  );

  it('rejects published identity drift and missing durable control reasons', async () => {
    const runStore = {
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: lease() }),
      close: vi.fn(),
      complete: vi.fn(),
      heartbeat: vi.fn(),
      loadInputs: vi.fn().mockResolvedValue({
        abortRequested: true,
        completedNodeOutputs: {},
        runInput: null,
      }),
      markDispatched: vi.fn(),
    };
    const dependencies = {
      engine: {
        prepare: vi
          .fn()
          .mockReturnValue({ upstreamNodeOutputs: [], execute: vi.fn() }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: { execute: vi.fn() },
      runStore,
      workerId: 'worker-1',
    } satisfies Parameters<typeof createNodeAttemptHandler>[0];

    const drifted = {
      ...dependencies,
      reader: {
        ...dependencies.reader,
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: { ...projection(), workspaceId: ATTEMPT_ID },
        }),
      },
    };
    await expect(
      createNodeAttemptHandler(drifted).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(
      createNodeAttemptHandler(dependencies).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'control_reason_missing' });
  });

  it('requires output for a resumed Wait admission', async () => {
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi
          .fn()
          .mockReturnValue({ upstreamNodeOutputs: [], execute: vi.fn() }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue({
          kind: 'v2_projection',
          workflowVersion: projection(),
        }),
      },
      registry: { execute: vi.fn() },
      runStore: {
        claimDelivery: vi.fn().mockResolvedValue({
          kind: 'claimed',
          lease: { ...lease(), admissionKind: 'wait_resume' },
        }),
        close: vi.fn(),
        complete: vi.fn(),
        heartbeat: vi.fn(),
        loadInputs: vi.fn().mockResolvedValue({
          abortRequested: false,
          completedNodeOutputs: {},
          runInput: null,
        }),
        markDispatched: vi.fn(),
      },
      workerId: 'worker-1',
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'wait_resume_output_missing' });
  });

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
          readForExecution: vi.fn().mockResolvedValue({
            kind: 'v2_projection',
            workflowVersion: projection(),
          }),
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
            abortRequested: false,
            completedNodeOutputs: {},
            resumeOutput: { resumed: true },
            runInput: null,
          }),
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
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: { hello: 'world' },
      }),
      markDispatched,
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
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

  it('lets a dispatch-aware executor mark immediately before provider I/O', async () => {
    const attemptLease = {
      ...lease(),
      sideEffectClass: 'idempotent_with_key' as const,
      providerIdempotencyKey: 'provider-attempt-key',
      providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
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
        abortRequested: false,
        completedNodeOutputs: {},
        runInput: {},
      }),
      markDispatched,
    } satisfies NodeAttemptRunStore;
    const reader = {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue({
        kind: 'v2_projection',
        workflowVersion: projection(),
      }),
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
          providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
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
          providerDispatchBinding: 'email:v1:sha256:' + 'a'.repeat(64),
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
        providerDispatchBinding: 'email:v1:sha256:' + 'a'.repeat(64),
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: 'succeeded', output: { status: 204 } },
      }),
    );
  });
});
