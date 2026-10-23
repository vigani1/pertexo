import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type WorkflowCheckpoint,
} from '../../../src/index.js';
import { nodeCatalog } from '../executable-workflow.js';
export async function drive(
  graph: WorkflowGraph,
  values: Readonly<Record<string, unknown>>,
  stopAtNodeId?: string,
  stopKind: 'cancel' | 'deadline' | 'failure' = 'cancel',
) {
  const workflowVersionId = randomUUID();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(
      nodeCatalog({
        forEach: true,
        condition: true,
        switch: true,
        parallel: true,
        merge: true,
      }),
    ),
  });
  let checkpoint: WorkflowCheckpoint = createCheckpoint({
    workflowVersionId,
    iterationBudget: 100,
  });
  let observations: unknown[] = [];
  let completedOutputs: unknown[] = [];
  const plans: Awaited<ReturnType<typeof advanceWorkflow>>[] = [];
  for (let pass = 0; pass < 40; pass += 1) {
    const plan = await advanceWorkflow({
      runId: 'structured-continuation',
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs,
      occurredAt: '2026-09-27T12:00:00.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    plans.push(plan);
    checkpoint = plan.checkpoint;
    if (plan.attempts.length > 0) expect(checkpoint.runStatus).toBe('running');
    if (
      ['succeeded', 'failed', 'canceled', 'timed_out'].includes(
        checkpoint.runStatus,
      )
    )
      return plans;
    observations = [];
    completedOutputs = [];
    const canceledAttempt = plan.attempts.find(
      (attempt) => attempt.nodeId === stopAtNodeId,
    );
    if (canceledAttempt !== undefined) {
      const attemptId = randomUUID();
      if (stopKind !== 'failure')
        observations.push({
          kind: stopKind === 'cancel' ? 'cancel_requested' : 'deadline_expired',
          ...(stopKind === 'cancel'
            ? { sequence: checkpoint.nextEventSequence }
            : {}),
          occurredAt: '2026-09-27T12:00:00.000Z',
        });
      observations.push({
        kind: 'outcome',
        sequence:
          checkpoint.nextEventSequence + (stopKind === 'cancel' ? 1 : 0),
        occurredAt: '2026-09-27T12:00:00.000Z',
        invocationKey: canceledAttempt.invocationKey,
        attemptId,
        attemptNumber: canceledAttempt.attemptNumber,
        status: stopStatuses[stopKind],
      });
      continue;
    }
    for (const [index, attempt] of plan.attempts.entries()) {
      const attemptId = randomUUID();
      const sequence = checkpoint.nextEventSequence + index;
      observations.push({
        kind: 'outcome',
        sequence,
        occurredAt: '2026-09-27T12:00:00.000Z',
        invocationKey: attempt.invocationKey,
        attemptId,
        attemptNumber: attempt.attemptNumber,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      });
      completedOutputs.push({
        sequence,
        attemptId,
        invocationKey: attempt.invocationKey,
        value: values[attempt.nodeId] ?? {},
      });
    }
    if (plan.attempts.length === 0)
      expect(plan.immediateContinuation).toBe(true);
  }
  throw new Error('workflow did not settle within its bounded passes');
}

const stopStatuses = {
  cancel: 'canceled',
  deadline: 'timed_out',
  failure: 'failed',
} as const;
