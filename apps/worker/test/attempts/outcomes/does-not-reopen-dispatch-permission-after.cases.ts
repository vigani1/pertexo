import type { NodeAttemptRunStore } from '@pertexo/core/testing';
import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
} from '@pertexo/core/testing';

import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  TRACEPARENT,
  WORKFLOW_ID,
  delivery,
  executionHandler,
  executionStore,
  lease,
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT } from './fixture.js';

export function registerDoesNotReopenDispatchPermissionAfter(): void {
  it.each([
    [new NodeAttemptConnectionFenceError(), 'provider_connection_fence_failed'],
    [
      new NodeAttemptDispatchBindingMismatchError(),
      'provider_dispatch_binding_mismatch',
    ],
    [new Error('queue marker aborted'), undefined],
  ] as const)(
    'does not reopen dispatch permission after a pending marker rejects',
    async (markerError, mappedCode) => {
      const marker = Promise.withResolvers<{ dispatchedAt: Date }>();
      const markDispatched = vi
        .fn<NodeAttemptRunStore['markDispatched']>()
        .mockReturnValue(marker.promise);
      const complete = vi.fn<NodeAttemptRunStore['complete']>();
      const registry = {
        dispatchMode: () => 'executor_controlled',
        execute: vi.fn<NonNullable<NodeExecutionRegistry['execute']>>(
          async (request: Parameters<NodeExecutionRegistry['execute']>[0]) => {
            const first = request.runtime?.beforeDispatch();
            await Promise.resolve();
            await expect(
              request.runtime?.beforeDispatch({
                providerDispatchBinding: 'email:sha256:' + 'c'.repeat(64),
              }),
            ).rejects.toMatchObject({ code: 'duplicate_dispatch' });
            marker.reject(markerError);
            await first;
            return { kind: 'succeeded', output: null } as const;
          },
        ),
      } satisfies NodeExecutionRegistry;
      const runStore = executionStore({ complete, markDispatched });
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

      const handled = expect(
        handler.handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects;
      if (mappedCode === undefined) await handled.toBe(markerError);
      else await handled.toMatchObject({ code: mappedCode });
      expect(markDispatched).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new NodeAttemptConnectionFenceError(), 'provider_connection_fence_failed'],
    [
      new NodeAttemptDispatchBindingMismatchError(),
      'provider_dispatch_binding_mismatch',
    ],
  ] as const)(
    'maps durable dispatch evidence failures to %s',
    async (error, code) => {
      const runStore = executionStore({
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue([]),
        readNodeOutputs: vi.fn().mockResolvedValue([]),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn().mockRejectedValue(error),
      });

      await expect(
        executionHandler(runStore).handle(delivery(), {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([undefined, TRACEPARENT])(
    'converts invalid persisted output to a safe failure with optional trace %s',
    async (traceparent) => {
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockRejectedValueOnce(new NodeAttemptOutputInvalidError())
        .mockResolvedValueOnce({
          kind: 'committed',
          outboxEventId: WORKFLOW_ID,
        });
      const runStore = executionStore({ complete });

      await expect(
        executionHandler(runStore).handle(delivery(traceparent), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: {
            status: 'failed',
            safeErrorCode: 'execution.output_invalid',
          },
          ...(traceparent === undefined ? {} : { traceparent }),
        }),
      );
    },
  );

  it('preserves prior dispatch uncertainty when cancellation arrives before redispatch', async () => {
    const attemptLease = {
      ...lease(),
      sideEffectClass: 'idempotent_with_key' as const,
      providerIdempotencyKey: 'stable-provider-key',
      providerDispatchUnresolved: true as const,
    };
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const markDispatched = vi.fn<NodeAttemptRunStore['markDispatched']>();
    const runStore = executionStore({
      claimDelivery: vi
        .fn()
        .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
      complete,
      loadInputs: vi.fn().mockResolvedValue({
        checkpoint: STORED_CHECKPOINT,
        control: { kind: 'abort', reason: 'canceled' },
        completedNodeOutputs: [],
        runInput: null,
      }),
      markDispatched,
    });

    await expect(
      executionHandler(runStore).handle(delivery(), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'outcome_unknown',
          safeErrorCode: 'execution.outcome_unknown',
        },
      }),
    );
    expect(markDispatched).not.toHaveBeenCalled();
  });
}
