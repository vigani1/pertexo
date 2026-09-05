import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  providerIdempotencyKey,
  nodeRelease,
  graph,
} from './executable-workflow.fixtures.js';

describe('attempt outcome production operations', () => {
  it('rejects a non-array completed-output boundary before derivation', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 0,
        }),
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        completedOutputs: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('carries exact pinned side-effect classes into attempt admissions', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 0,
    });
    const manual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manualAttempt = manual.attempts[0];
    if (manualAttempt === undefined) throw new Error('manual was not admitted');
    expect(manualAttempt).toMatchObject({
      nodeId: 'manual',
      sideEffectClass: 'unsafe',
    });
    const completedManual = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: manual.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          sequence: manual.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000011',
          attemptNumber: manualAttempt.attemptNumber,
          kind: 'outcome',
          invocationKey: manualAttempt.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    const setAttempt = completedManual.attempts[0];
    if (setAttempt === undefined) throw new Error('set was not admitted');
    const expectedProviderKey = providerIdempotencyKey({
      invocationKey: setAttempt.invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: 'core.set@1',
      runId: 'run-1',
    });
    expect(setAttempt).toMatchObject({
      nodeId: 'set',
      providerIdempotencyKey: expectedProviderKey,
      sideEffectClass: 'idempotent_with_key',
    });
    expect(
      completedManual.nodeRunAdmissions.find(({ nodeId }) => nodeId === 'set'),
    ).toMatchObject({ providerIdempotencyKey: expectedProviderKey });
  });

  it('assigns the same provider key before capacity admission', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const input = {
      runId: 'capacity-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-20T10:00:00.000Z',
      observations: [],
      signal: new AbortController().signal,
    } as const;
    const materialized = await advanceWorkflow({
      ...input,
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      maximumAdmissions: 0,
    });
    const admitted = await advanceWorkflow({
      ...input,
      checkpoint: materialized.checkpoint,
      maximumAdmissions: 1,
    });
    expect(materialized.nodeRunAdmissions[0]?.providerIdempotencyKey).toBe(
      admitted.attempts[0]?.providerIdempotencyKey,
    );
  });

  it('resolves typed attempt failure into one coordinator retry transition', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    const started = await advanceWorkflow({
      runId: 'retry-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const retried = await advanceWorkflow({
      runId: 'retry-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000099',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'retry',
          errorKind: 'rate_limit',
          possiblyDispatched: false,
          safeErrorCode: 'execution.rate_limit',
        },
      ],
      signal: new AbortController().signal,
    });

    const scheduled = retried.events.find(
      ({ name }) => name === 'node.retry_scheduled',
    );
    expect(scheduled?.dueAt).toBe('2026-08-20T10:00:31.200Z');
    expect(retried.attempts).toEqual([]);
    expect(retried.checkpoint.invocations[0]).toMatchObject({
      status: 'waiting',
      resumeAt: scheduled?.dueAt,
      attemptNumber: 1,
    });
  });

  it('preserves a definite executor cancellation as canceled', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    const started = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const canceled = await advanceWorkflow({
      runId: 'canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000098',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
          safeErrorCode: 'execution.canceled',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(canceled.events.map(({ name }) => name)).toContain('node.canceled');
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
  });

  it('settles possibly-dispatched idempotent cancellation as outcome_unknown', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const started = await advanceWorkflow({
      runId: 'idempotent-canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const settled = await advanceWorkflow({
      runId: 'idempotent-canceled-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000097',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: true,
          safeErrorCode: 'execution.canceled',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(settled.events.map(({ name }) => name)).toContain(
      'node.outcome_unknown',
    );
    expect(settled.checkpoint.invocations[0]).toMatchObject({
      status: 'outcome_unknown',
    });
  });

  it('preserves an explicit executor outcome_unknown through coordination', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const started = await advanceWorkflow({
      runId: 'unknown-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');

    const settled = await advanceWorkflow({
      runId: 'unknown-attempt-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000096',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'outcome_unknown',
          errorKind: 'authentication',
          possiblyDispatched: true,
          safeErrorCode: 'execution.outcome_unknown',
        },
      ],
      signal: new AbortController().signal,
    });

    expect(settled.events.map(({ name }) => name)).toContain(
      'node.outcome_unknown',
    );
    expect(settled.checkpoint.invocations[0]).toMatchObject({
      status: 'outcome_unknown',
    });
  });

  it('rejects an untyped attempt failure observation', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: graph(),
      release: composeExecutableCompatibilityRelease(nodeRelease()),
    });
    await expect(
      advanceWorkflow({
        runId: 'invalid-retry-run',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
          engineVersion: 'engine-v1',
          workflowVersionId: '00000000-0000-4000-8000-000000000001',
          iterationBudget: 0,
        }),
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [{ kind: 'attempt_failure' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('consumes contiguous persisted facts without re-emitting their semantic events', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 0,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');

    const advanced = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      observations: [
        {
          sequence: started.checkpoint.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000012',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000012',
          },
        },
      ],
      signal: new AbortController().signal,
    });

    expect(advanced.expectedNextEventSequence).toBe(
      started.checkpoint.nextEventSequence,
    );
    expect(advanced.consumedThroughEventSequence).toBe(
      started.checkpoint.nextEventSequence,
    );
    expect(advanced.events).toEqual([
      expect.objectContaining({ name: 'node.ready', sequence: 5 }),
    ]);
    expect(advanced.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.succeeded' }),
    );
    expect(advanced.checkpoint.nextEventSequence).toBe(
      started.checkpoint.nextEventSequence + 2,
    );
  });

  it('rejects cursor gaps, reorder, conflicts, and stale attempt outcomes', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const expected = started.checkpoint.nextEventSequence;
    const outcome = {
      sequence: expected,
      occurredAt: '2026-08-20T10:01:00.000Z',
      attemptId: '00000000-0000-4000-8000-000000000021',
      attemptNumber: manual.attemptNumber,
      kind: 'outcome',
      invocationKey: manual.invocationKey,
      status: 'succeeded',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      signal: new AbortController().signal,
    } as const;

    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, sequence: expected + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [
          {
            kind: 'cancel_requested',
            sequence: expected + 1,
            occurredAt: outcome.occurredAt,
          },
          outcome,
        ],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [outcome, { ...outcome, status: 'failed' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, attemptNumber: manual.attemptNumber + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...outcome, status: 'skipped' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const consumed = await advanceWorkflow({
      ...input,
      observations: [outcome, outcome],
    });
    expect(consumed.consumedThroughEventSequence).toBe(expected);
    const staleDuplicate = await advanceWorkflow({
      ...input,
      checkpoint: consumed.checkpoint,
      observations: [outcome],
    });
    expect(staleDuplicate.consumedThroughEventSequence).toBe(
      consumed.checkpoint.nextEventSequence - 1,
    );
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: consumed.checkpoint,
        observations: [{ ...outcome, status: 'failed' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('starts derived events strictly after the consumed external high-water', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const sourceGraph = graph();
    const manualNode = sourceGraph.nodes[0];
    const singleNode = { ...sourceGraph, nodes: [manualNode], edges: [] };
    const executable = buildWorkflowExecutableV2({
      graph: singleNode,
      release,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const externalSequence = started.checkpoint.nextEventSequence;
    const completed = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 0,
      observations: [
        {
          kind: 'cursor_only',
          eventName: 'node.started',
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:00:30.000Z',
          invocationKey: manual.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000042',
          attemptNumber: manual.attemptNumber,
        },
        {
          sequence: externalSequence + 1,
          occurredAt: '2026-08-20T10:01:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000022',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(
      completed.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.succeeded', externalSequence + 2]]);
    expect(completed.consumedThroughEventSequence).toBe(externalSequence + 1);
    expect(completed.checkpoint.nextEventSequence).toBe(externalSequence + 3);
    expect(completed.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.started' }),
    );
  });
});
