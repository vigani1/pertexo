import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('wait and control production operations', () => {
  it('reconciles running cancellation and preserves reported unsafe uncertainty', async () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(
        nodeCatalog({ manualRetryClass: 'unsafe' }),
      ),
    });
    const input = {
      runId: 'cancel-unsafe-run',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    } as const;
    const started = await advanceWorkflow({
      ...input,
      checkpoint: createCheckpoint({
        workflowVersionId: input.workflowVersionId,
        iterationBudget: 0,
      }),
      observations: [],
    });
    const attempt = started.attempts[0];
    if (attempt === undefined) throw new Error('attempt was not admitted');
    const canceled = await advanceWorkflow({
      ...input,
      checkpoint: started.checkpoint,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: started.checkpoint.nextEventSequence,
          occurredAt: input.occurredAt,
        },
      ],
    });
    expect(canceled.attempts).toEqual([]);
    expect(canceled.checkpoint.runStatus).toBe('running');
    expect(canceled.checkpoint.invocations[0]).toMatchObject({
      invocationKey: attempt.invocationKey,
      status: 'running',
    });
    const reconciled = await advanceWorkflow({
      ...input,
      checkpoint: canceled.checkpoint,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: input.occurredAt,
          invocationKey: attempt.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000096',
          attemptNumber: attempt.attemptNumber,
          failureKind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: true,
          safeErrorCode: 'execution.canceled',
        },
      ],
    });
    expect(reconciled.checkpoint.runStatus).toBe('outcome_unknown');
    expect(reconciled.checkpoint.invocations[0]).toMatchObject({
      status: 'outcome_unknown',
    });
    const retained = await advanceWorkflow({
      ...input,
      checkpoint: reconciled.checkpoint,
      observations: [],
    });
    expect(retained.checkpoint.runStatus).toBe('outcome_unknown');
    expect(retained.attempts).toEqual([]);
  });
  it('consumes persisted waits with attempt fencing and resumes due work as engine-owned readiness', async () => {
    const catalog = composeExecutableCatalog(
      nodeCatalog({ manualRetryClass: 'idempotent-with-key' }),
    );
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const started = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      checkpoint: createCheckpoint({
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
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
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

    await expect(
      advanceWorkflow({
        ...input,
        observations: [{ ...wait, resumeAt: 'not-a-timestamp' }],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });

    const waiting = await advanceWorkflow({ ...input, observations: [wait] });
    expect(waiting.attempts).toEqual([]);
    expect(waiting.checkpoint.invocations[0]).toMatchObject({
      status: 'waiting',
      resumeAt: wait.resumeAt,
    });
    expect(waiting.events).not.toContainEqual(
      expect.objectContaining({ name: 'node.waiting' }),
    );
    expect(waiting.immediateContinuation).toBeUndefined();
    const beforeDue = await advanceWorkflow({
      ...input,
      checkpoint: waiting.checkpoint,
      observations: [],
    });
    expect(beforeDue.attempts).toEqual([]);
    expect(beforeDue.immediateContinuation).toBeUndefined();

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
    const wholeSecondCheckpoint = {
      ...waiting.checkpoint,
      invocations: waiting.checkpoint.invocations.map((invocation) =>
        invocation.invocationKey === manual.invocationKey
          ? { ...invocation, resumeAt: '2026-08-20T10:05:00Z' }
          : invocation,
      ),
    };
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: wholeSecondCheckpoint,
        observations: [due],
      }),
    ).resolves.toMatchObject({
      attempts: [
        expect.objectContaining({ invocationKey: manual.invocationKey }),
      ],
    });
    await expect(
      advanceWorkflow({
        ...input,
        checkpoint: wholeSecondCheckpoint,
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
});
