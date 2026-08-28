import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  nodeRelease,
  graph,
} from './executable-workflow.fixtures.js';

describe('Phase 3 wait and control production operations', () => {
  it('consumes persisted waits with attempt fencing and resumes due work as engine-owned readiness', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ manualRetryClass: 'idempotent-with-key' }),
    );
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const wait = {
      kind: 'wait',
      eventName: 'node.retry_scheduled',
      sequence: started.checkpoint.nextEventSequence,
      occurredAt: '2026-08-20T10:01:00.000Z',
      invocationKey: manual.invocationKey,
      attemptId: '00000000-0000-4000-8000-000000000041',
      attemptNumber: manual.attemptNumber,
      resumeAt: '2026-08-20T10:05:00.000Z',
      waitKind: 'retry_backoff',
    } as const;
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    } as const;
    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...wait, attemptNumber: manual.attemptNumber + 1 }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const waiting = await advanceWorkflow({ ...input, observations: [wait] });
    expect(waiting.checkpoint.invocations[0]).toMatchObject({
      status: 'waiting',
      resumeAt: wait.resumeAt,
    });
    expect(waiting.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.waiting' }),
    );

    const due = {
      kind: 'due_at',
      occurredAt: wait.resumeAt,
      invocationKey: manual.invocationKey,
    } as const;
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: waiting.checkpoint,
        observations: [{ ...due, occurredAt: '2026-08-20T10:04:59.999Z' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const pending = {
      ...waiting.checkpoint,
      invocations: waiting.checkpoint.invocations.map((invocation) => {
        const {
          resumeAt: _resumeAt,
          waitKind: _waitKind,
          ...active
        } = invocation;
        void _resumeAt;
        void _waitKind;
        return invocation.invocationKey === manual.invocationKey
          ? { ...active, status: 'pending' as const }
          : invocation;
      }),
    };
    await expect(
      advanceWorkflow({ ...input, checkpoint: pending, observations: [due] }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const terminal = {
      ...waiting.checkpoint,
      invocations: waiting.checkpoint.invocations.map((invocation) => {
        const {
          resumeAt: _resumeAt,
          waitKind: _waitKind,
          ...active
        } = invocation;
        void _resumeAt;
        void _waitKind;
        return invocation.invocationKey === manual.invocationKey
          ? { ...active, status: 'succeeded' as const }
          : invocation;
      }),
    };
    await expect(
      advanceWorkflow({ ...input, checkpoint: terminal, observations: [due] }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    const resumed = await advanceWorkflow({
      ...input,
      checkpoint: waiting.checkpoint,
      observations: [due],
    });
    expect(resumed.consumedThroughEventSequence).toBe(
      waiting.checkpoint.nextEventSequence - 1,
    );
    expect(resumed.events).toContainEqual(
      expect.objectContaining({
        name: 'node.ready',
        occurredAt: due.occurredAt,
      }),
    );
    expect(resumed.nodeRunAdmissions).toEqual([]);
    expect(resumed.attempts).toEqual([
      expect.objectContaining({
        invocationKey: manual.invocationKey,
        attemptNumber: manual.attemptNumber + 1,
        providerIdempotencyKey: manual.providerIdempotencyKey,
      }),
    ]);
    const duplicate = await advanceWorkflow({
      ...input,
      checkpoint: resumed.checkpoint,
      observations: [due],
    });
    expect(duplicate.events).toEqual([]);
    expect(duplicate.attempts).toEqual([]);
  });

  it('orders simultaneous due resumptions independently of loader row order', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const sourceGraph = graph();
    const executable = buildWorkflowExecutableV2({
      graph: { ...sourceGraph, edges: [] },
      release,
    });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 2,
      observations: [],
      signal: new AbortController().signal,
    });
    const waiting = structuredClone(started.checkpoint);
    for (const invocation of waiting.invocations.filter(
      ({ status }) => status === 'running',
    ))
      Object.assign(invocation, {
        status: 'waiting',
        resumeAt: '2026-08-20T10:05:00.000Z',
        waitKind: 'retry_backoff',
      });
    const dues = waiting.invocations
      .filter(({ status }) => status === 'waiting')
      .map(({ invocationKey }) => ({
        kind: 'due_at' as const,
        occurredAt: '2026-08-20T10:05:00.000Z',
        invocationKey,
      }));
    expect(dues).toHaveLength(2);
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:05:00.000Z',
      maximumAdmissions: 2,
      signal: new AbortController().signal,
    } as const;
    const forward = await advanceWorkflow({ ...input, observations: dues });
    const reverse = await advanceWorkflow({
      ...input,
      observations: [...dues].reverse(),
    });
    expect(reverse).toEqual(forward);
    expect(
      forward.events.filter(({ name }) => name === 'node.ready'),
    ).toHaveLength(2);
    expect(forward.nodeRunAdmissions).toEqual([]);
    expect(forward.attempts).toHaveLength(2);
  });

  it('applies persisted cancel and deadline controls before materializing work', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const initial = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const canceled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: initial.nextEventSequence,
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.nodeRunAdmissions).toEqual([]);
    expect(canceled.attempts).toEqual([]);
    expect(
      canceled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.canceled', initial.nextEventSequence + 1]]);

    const timedOut = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: initial,
      occurredAt: '2026-08-20T10:01:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:00:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(timedOut.expectedNextEventSequence).toBe(initial.nextEventSequence);
    expect(timedOut.consumedThroughEventSequence).toBe(
      initial.nextEventSequence - 1,
    );
    expect(timedOut.checkpoint).toMatchObject({
      cancelRequested: false,
      deadlineExpired: true,
      runStatus: 'timed_out',
    });
    expect(timedOut.nodeRunAdmissions).toEqual([]);
    expect(timedOut.attempts).toEqual([]);
    expect(
      timedOut.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', initial.nextEventSequence]]);
  });

  it('persists deadline state while active work reconciles before run timeout', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('manual was not admitted');
    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: started.checkpoint,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint).toMatchObject({
      deadlineExpired: true,
      runStatus: 'running',
    });
    expect(expired.attempts).toEqual([]);
    expect(expired.nodeRunAdmissions).toEqual([]);

    const externalSequence = expired.checkpoint.nextEventSequence;
    const reconciled = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: expired.checkpoint,
      occurredAt: '2026-08-20T10:03:00.000Z',
      maximumAdmissions: 10,
      observations: [
        {
          sequence: externalSequence,
          occurredAt: '2026-08-20T10:03:00.000Z',
          attemptId: '00000000-0000-4000-8000-000000000023',
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'timed_out',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(reconciled.checkpoint.runStatus).toBe('timed_out');
    expect(
      reconciled.events.map(({ name, sequence }) => [name, sequence]),
    ).toEqual([['run.timed_out', externalSequence + 1]]);
  });

  it('settles durable waiting work on deadline or cancellation without reconciliation', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    const waiting = structuredClone(started.checkpoint);
    const invocation = waiting.invocations[0];
    if (invocation === undefined) throw new Error('manual was not persisted');
    Object.assign(invocation, {
      status: 'waiting',
      resumeAt: '2026-08-21T10:00:00.000Z',
      waitKind: 'node_wait',
    });

    const expired = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(expired.checkpoint.invocations[0]).toMatchObject({
      status: 'timed_out',
    });
    expect(expired.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(expired.checkpoint.runStatus).toBe('timed_out');
    expect(expired.events.map(({ name }) => name)).toEqual([
      'node.timed_out',
      'run.timed_out',
    ]);

    const canceled = await advanceWorkflow({
      runId: 'run-2',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: waiting,
      occurredAt: '2026-08-20T10:02:00.000Z',
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: waiting.nextEventSequence,
          occurredAt: '2026-08-20T10:01:00.000Z',
        },
      ],
      signal: new AbortController().signal,
    });
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      status: 'canceled',
    });
    expect(canceled.checkpoint.invocations[0]).not.toHaveProperty('resumeAt');
    expect(canceled.checkpoint.runStatus).toBe('canceled');
    expect(canceled.events.map(({ name }) => name)).toEqual([
      'node.canceled',
      'run.canceled',
    ]);
  });

  it('plans every materialized node run independently of the attempt cap', async () => {
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({
        manualRetryClass: 'unsafe',
        setRetryClass: 'idempotent-with-key',
      }),
    );
    const sourceGraph = graph();
    const parallel = { ...sourceGraph, edges: [] };
    const executable = buildWorkflowExecutableV2({ graph: parallel, release });
    const input = {
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint: createCheckpoint({
        engineVersion: 'engine-v1',
        workflowVersionId: 'version-1',
        iterationBudget: 0,
      }),
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    } as const;
    const first = await advanceWorkflow(input);
    expect(first.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
      expect.objectContaining({
        nodeId: 'set',
        sideEffectClass: 'idempotent_with_key',
      }),
      expect.objectContaining({ nodeId: 'terminate', sideEffectClass: 'safe' }),
    ]);
    expect(first.attempts).toHaveLength(1);
    expect(await advanceWorkflow(input)).toEqual(first);

    const disabledGraph = structuredClone(graph());
    Object.assign(disabledGraph.nodes[0], { disabled: true });
    const disabledExecutable = buildWorkflowExecutableV2({
      graph: disabledGraph,
      release,
    });
    const skipped = await advanceWorkflow({
      ...input,
      executable: disabledExecutable,
    });
    expect(skipped.nodeRunAdmissions).toEqual([
      expect.objectContaining({ nodeId: 'manual', sideEffectClass: 'unsafe' }),
    ]);
    expect(skipped.attempts).toEqual([]);
    expect(skipped.events).toContainEqual(
      expect.objectContaining({ name: 'node.skipped', nodeId: 'manual' }),
    );
  });
});
