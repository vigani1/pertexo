import type { NodeAttemptRunStore } from '@pertexo/core/testing';

import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import {
  createNodeAttemptHandler,
  type PreparedNodeAttempt,
} from '../../../src/testing.js';
import {
  WORKFLOW_ID,
  delivery,
  executionStore,
  lease,
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';

export function registerGrantsOneDispatchPermissionDurableS(): void {
  it.each([
    ['matching evidence', false],
    ['different evidence', true],
  ] as const)(
    'grants one dispatch permission while durable %s is pending',
    async (_label, useDifferentEvidence) => {
      const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
      const markDispatched = vi
        .fn<NodeAttemptRunStore['markDispatched']>()
        .mockReturnValue(marker.promise);
      const providerIo = vi.fn();
      const firstEvidence = {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
        providerDispatchBinding: 'email:sha256:' + 'a'.repeat(64),
      } as const;
      const secondEvidence = useDifferentEvidence
        ? {
            connectionFence: {
              ...firstEvidence.connectionFence,
              secretVersionId: '33333333-3333-4333-8333-333333333333',
            },
            providerDispatchBinding: 'email:sha256:' + 'b'.repeat(64),
          }
        : firstEvidence;
      const registry = {
        dispatchMode: () => 'executor_controlled',
        execute: vi.fn<NonNullable<NodeExecutionRegistry['execute']>>(
          async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
            const first = request.runtime?.beforeDispatch(firstEvidence);
            await Promise.resolve();
            await expect(
              request.runtime?.beforeDispatch(secondEvidence),
            ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
            expect(markDispatched).toHaveBeenCalledOnce();
            marker.resolve({ dispatchedAt: new Date() });
            await first;
            providerIo();
            return { kind: 'succeeded', output: null } as const;
          },
        ),
      } satisfies NodeExecutionRegistry;
      const runStore = executionStore({ markDispatched });
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader: {
          close: vi.fn(),
          readForExecution: vi.fn().mockResolvedValue(projection()),
        },
        registry,
        runStore,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(providerIo).toHaveBeenCalledOnce();
    },
  );

  it('keeps a queue abort from reopening a pending dispatch marker', async () => {
    const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
    const markDispatched = vi
      .fn<NodeAttemptRunStore['markDispatched']>()
      .mockReturnValue(marker.promise);
    const complete = vi.fn<NodeAttemptRunStore['complete']>();
    const contextAbort = new AbortController();
    const registry = {
      dispatchMode: () => 'executor_controlled',
      execute: vi.fn<NonNullable<NodeExecutionRegistry['execute']>>(
        async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
          const first = request.runtime?.beforeDispatch();
          await Promise.resolve();
          await expect(request.runtime?.beforeDispatch()).rejects.toMatchObject(
            {
              code: 'duplicate_dispatch',
            },
          );
          contextAbort.abort();
          marker.reject(contextAbort.signal.reason);
          await first;
          return { kind: 'succeeded', output: null } as const;
        },
      ),
    } satisfies NodeExecutionRegistry;
    const runStore = executionStore({ complete, markDispatched });
    const handler = createNodeAttemptHandler({
      engine: { prepare: vi.fn().mockReturnValue(registryPreparedAttempt()) },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry,
      runStore,
      workerId: 'worker-1',
    });

    const failure = await handler
      .handle(delivery(), { signal: contextAbort.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBe(contextAbort.signal.reason);
    expect(markDispatched).toHaveBeenCalledOnce();
    expect(markDispatched.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the combined execution signal but the exact queue signal for completion', async () => {
    const contextAbort = new AbortController();
    let executionSignal: AbortSignal | undefined;
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const runStore = executionStore({ complete });
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: vi.fn(
            (input: Parameters<PreparedNodeAttempt['execute']>[0]) => {
              executionSignal = input.signal;
              return Promise.resolve({
                runId: lease().runId,
                nodeRunId: lease().nodeRunId,
                attemptId: lease().attemptId,
                invocationKey: lease().invocationKey,
                nodeId: lease().nodeId,
                kind: 'succeeded',
                output: null,
              } as const);
            },
          ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: { execute: vi.fn() },
      runStore,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: contextAbort.signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(executionSignal).toBeInstanceOf(AbortSignal);
    expect(executionSignal).not.toBe(contextAbort.signal);
    expect(complete.mock.calls[0]?.[0].signal).toBe(contextAbort.signal);
  });
}
