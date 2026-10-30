import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';

import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  TRACEPARENT,
  WORKFLOW_ID,
  delivery,
  executionStore,
  lease,
  projection,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT, heartbeatCancellationHandler } from './fixture.js';

export function registerRecordsDurableSBeforeDispatchingExecutor(): void {
  it.each([
    ['canceled', 'execution.canceled'],
    ['timed_out', 'execution.deadline_exceeded'],
  ] as const)(
    'records durable %s before dispatching an executor',
    async (abortReason, safeErrorCode) => {
      const attemptLease = lease();
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
          control: { kind: 'abort', reason: abortReason },
          completedNodeOutputs: [],
          runInput: null,
        }),
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue([]),
        readNodeOutputs: vi.fn().mockResolvedValue([]),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn(),
      } satisfies NodeAttemptRunStore;
      const reader = {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      } satisfies PublishedWorkflowReader;
      const execute = vi.fn();
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi
            .fn()
            .mockReturnValue({ upstreamNodeOutputs: [], execute }),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader,
        registry: { execute: vi.fn() },
        runStore: store,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(TRACEPARENT), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(execute).not.toHaveBeenCalled();
      expect(store.markDispatched).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        lease: attemptLease,
        outcome: { status: abortReason, safeErrorCode },
      });
      expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    },
  );

  it.each(['canceled', 'timed_out'] as const)(
    'preserves prior dispatch uncertainty when heartbeat reports %s before redispatch',
    async (abortReason) => {
      const attemptLease = {
        ...lease(),
        sideEffectClass: 'idempotent_with_key' as const,
        providerIdempotencyKey: 'stable-provider-key',
        providerDispatchUnresolved: true as const,
      };
      const complete = vi
        .fn<NodeAttemptRunStore['complete']>()
        .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
      const heartbeat = vi
        .fn<NodeAttemptRunStore['heartbeat']>()
        .mockResolvedValue({
          leaseExpiresAt: new Date('2026-08-21T00:02:00.000Z'),
          control: { kind: 'abort', reason: abortReason },
        });
      const markDispatched = vi.fn<NodeAttemptRunStore['markDispatched']>();
      const store = executionStore({
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: attemptLease }),
        complete,
        heartbeat,
        markDispatched,
      });
      const handler = heartbeatCancellationHandler(store, true);

      await expect(
        handler.handle(delivery(), { signal: new AbortController().signal }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(heartbeat).toHaveBeenCalledOnce();
      expect(markDispatched).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: attemptLease,
          outcome: {
            status: 'outcome_unknown',
            safeErrorCode: 'execution.outcome_unknown',
          },
        }),
      );
    },
  );

  it('normalizes a non-Error heartbeat rejection', async () => {
    const heartbeat = vi.fn<NodeAttemptRunStore['heartbeat']>();
    // Deliberately model a hostile persistence adapter rejection.
    heartbeat.mockRejectedValue(undefined);
    const handler = heartbeatCancellationHandler(executionStore({ heartbeat }));

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: 'Node attempt heartbeat failed',
    });
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it.each([undefined, TRACEPARENT])(
    "fails a typed invalid attempt as the step's own failure, without exposing details, for trace %s",
    async (traceparent) => {
      const attemptLease = lease();
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
          runInput: null,
        }),
        readAttemptOutputs: vi.fn().mockResolvedValue([]),
        listNodeOutcomes: vi.fn().mockResolvedValue([]),
        readNodeOutputs: vi.fn().mockResolvedValue([]),
        readLoopDeclaration: vi.fn(),
        markDispatched: vi.fn(),
      } satisfies NodeAttemptRunStore;
      const reader = {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      } satisfies PublishedWorkflowReader;
      const handler = createNodeAttemptHandler({
        engine: {
          prepare: vi.fn().mockReturnValue({
            upstreamNodeOutputs: [],
            execute: vi
              .fn()
              .mockRejectedValue(
                new WorkflowEngineError('attempt_invalid', 'secret detail'),
              ),
          }),
        },
        heartbeatIntervalMillis: 1_000,
        leaseDurationSeconds: 30,
        reader,
        registry: { execute: vi.fn() },
        runStore: store,
        workerId: 'worker-1',
      });

      await expect(
        handler.handle(delivery(traceparent), {
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'committed' });
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toMatchObject({
        lease: attemptLease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'failed',
          errorKind: 'configuration',
          possiblyDispatched: false,
          safeErrorCode: 'execution.attempt_invalid',
        },
      });
      expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain(
        'secret detail',
      );
      expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    },
  );
}
