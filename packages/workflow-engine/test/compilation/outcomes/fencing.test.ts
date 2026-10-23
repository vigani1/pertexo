import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '../../../src/index.js';

import { graph, nodeCatalog } from '../../support/executable-workflow.js';
describe('attempt outcome production operations', () => {
  it('settles possibly-dispatched idempotent cancellation as outcome_unknown', async () => {
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(
        nodeCatalog({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const started = await advanceWorkflow({
      runId: 'idempotent-canceled-attempt-run',
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
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(
        nodeCatalog({ manualRetryClass: 'idempotent-with-key' }),
      ),
    });
    const started = await advanceWorkflow({
      runId: 'unknown-attempt-run',
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
    const executable = buildWorkflowExecutable({
      graph: graph(),
      catalog: composeExecutableCatalog(nodeCatalog()),
    });
    await expect(
      advanceWorkflow({
        runId: 'invalid-retry-run',
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000001',
        checkpoint: createCheckpoint({
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
    const catalog = composeExecutableCatalog(nodeCatalog());
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const checkpoint = createCheckpoint({
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
    const catalog = composeExecutableCatalog(nodeCatalog());
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
});
