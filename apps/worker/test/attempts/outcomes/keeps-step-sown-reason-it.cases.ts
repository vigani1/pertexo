import type {
  NodeAttemptRunStore,
  PublishedWorkflowReader,
} from '@pertexo/database/testing';

import { HttpRequestExecutorError } from '@pertexo/integrations/server';
import {
  NodeExecutorFailure,
  NodeInputValidationError,
} from '@pertexo/node-sdk/server';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { expect, it, vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  TRACEPARENT,
  WORKFLOW_ID,
  delivery,
  lease,
  projection,
} from '../../support/attempts/handler.js';
import { STORED_CHECKPOINT } from './fixture.js';

export function registerKeepsStepSOwnReasonIt(): void {
  it("keeps a step's own reason when it refuses its input", async () => {
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: vi.fn().mockRejectedValue(
            new WorkflowEngineError('attempt_invalid', 'secret detail', {
              cause: new NodeInputValidationError(
                'Use a date like 2026-10-19.',
              ),
            }),
          ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: { execute: vi.fn() },
      runStore: {
        claimDelivery: vi
          .fn()
          .mockResolvedValue({ kind: 'claimed', lease: lease() }),
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
      },
      workerId: 'worker-1',
    });

    await handler.handle(delivery(), { signal: new AbortController().signal });
    expect(complete.mock.calls[0]?.[0].outcome).toEqual({
      status: 'executor_failure',
      failureKind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: 'execution.attempt_invalid',
      errorSummary: 'Use a date like 2026-10-19.',
    });
  });

  it('persists a typed unsafe provider ambiguity as outcome_unknown', async () => {
    const attemptLease = { ...lease(), sideEffectClass: 'unsafe' as const };
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
          execute: vi.fn().mockRejectedValue(
            new NodeExecutorFailure({
              kind: 'outcome_unknown',
              errorKind: 'provider',
              possiblyDispatched: true,
            }),
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
      handler.handle(delivery(TRACEPARENT), {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          status: 'executor_failure',
          failureKind: 'outcome_unknown',
          errorKind: 'provider',
          possiblyDispatched: true,
          safeErrorCode: 'execution.provider',
        },
      }),
    );
  });

  it('persists a pre-dispatch HTTP retry for the coordinator without scheduling', async () => {
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
    const handler = createNodeAttemptHandler({
      engine: {
        prepare: vi.fn().mockReturnValue({
          upstreamNodeOutputs: [],
          execute: vi.fn().mockRejectedValue(
            new HttpRequestExecutorError(
              {
                kind: 'retry',
                errorKind: 'rate_limit',
                reuseProviderKey: false,
              },
              { possiblyDispatched: false },
            ),
          ),
        }),
      },
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn().mockResolvedValue(undefined),
        readForExecution: vi.fn().mockResolvedValue(projection()),
      },
      registry: { execute: vi.fn() },
      runStore: store,
      workerId: 'worker-1',
    });

    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: attemptLease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'retry',
          errorKind: 'rate_limit',
          possiblyDispatched: false,
          safeErrorCode: 'execution.rate_limit',
        },
      }),
    );
  });
}
