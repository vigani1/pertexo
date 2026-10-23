import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  parseCheckpoint,
  type WorkflowCheckpoint,
} from '../../../../src/index.js';
import { nodeCatalog } from '../../../support/executable-workflow.js';
import {
  parallelInsideNestedLoops,
  createDriver,
} from '../../../support/scheduling/nested-parallel.js';

describe('nested Parallel admission through the public engine', () => {
  it('keys a nested Parallel cap by the complete enclosing loop path', async () => {
    const executable = buildWorkflowExecutable({
      graph: parallelInsideNestedLoops(1),
      catalog: composeExecutableCatalog(
        nodeCatalog({ forEach: true, parallel: true, merge: true }),
      ),
    });
    const base = {
      runId: 'nested-parallel-loops',
      executable,
      workflowVersionId: '00000000-0000-4000-8000-000000000103',
      occurredAt: '2026-08-24T00:00:00.000Z',
      maximumAdmissions: 16,
      signal: new AbortController().signal,
    } as const;
    let checkpoint: WorkflowCheckpoint = createCheckpoint({
      workflowVersionId: base.workflowVersionId,
      iterationBudget: 6,
    });
    let nextAttemptId = 400;
    let lastCompletion:
      | Readonly<{
          observations: unknown;
          completedOutputs: unknown;
        }>
      | undefined;
    const advance = async (
      observations: Parameters<typeof advanceWorkflow>[0]['observations'] = [],
      completedOutputs: Parameters<
        typeof advanceWorkflow
      >[0]['completedOutputs'] = [],
    ) => {
      const plan = await advanceWorkflow({
        ...base,
        checkpoint,
        observations,
        completedOutputs,
      });
      checkpoint = plan.checkpoint;
      return plan;
    };
    const completeRunning = async (nodeId: string, value: JsonValue) => {
      const running = checkpoint.invocations.filter(
        (invocation) =>
          invocation.nodeId === nodeId && invocation.status === 'running',
      );
      if (running.length === 0) throw new Error(`${nodeId} attempt missing`);
      const sequence = checkpoint.nextEventSequence;
      const outputs = running.map((invocation, index) => {
        const attemptId = `00000000-0000-4000-8000-${String(nextAttemptId++).padStart(12, '0')}`;
        return {
          sequence: sequence + index,
          attemptId,
          invocationKey: invocation.invocationKey,
          value,
        };
      });
      const observations = outputs.map((output, index) => ({
        kind: 'outcome' as const,
        sequence: output.sequence,
        occurredAt: base.occurredAt,
        invocationKey: output.invocationKey,
        attemptId: output.attemptId,
        attemptNumber: running[index]?.attemptNumber ?? 1,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId: output.attemptId },
      }));
      lastCompletion = { observations, completedOutputs: outputs };
      return advance(observations, outputs);
    };

    const initial = await advance();
    expect(initial.attempts).toHaveLength(1);
    await completeRunning('manual', {});
    const outer = await completeRunning('loop', {
      items: [1, 2],
      iterationCount: 2,
    });
    expect(outer.attempts).toHaveLength(2);
    const inner = await completeRunning('body-first', {
      items: [10, 20],
      iterationCount: 2,
    });
    expect(inner.attempts).toHaveLength(4);
    const parallel = await completeRunning('parallel', {
      branchIds: ['branch-01', 'branch-02'],
    });
    expect(parallel.attempts).toHaveLength(4);
    const scopes = new Map<string, number>();
    for (const attempt of parallel.attempts) {
      const scope = JSON.stringify(attempt.iterationPath);
      scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
    }
    expect([...scopes.values()]).toEqual([1, 1, 1, 1]);
    expect(
      parallel.attempts.every(
        ({ iterationPath }) => iterationPath?.length === 2,
      ),
    ).toBe(true);

    if (lastCompletion === undefined) throw new Error('completion is missing');
    const serializedCheckpoint = parseCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
    );
    const duplicate = await advanceWorkflow({
      ...base,
      checkpoint: serializedCheckpoint,
      observations: lastCompletion.observations,
      completedOutputs: lastCompletion.completedOutputs,
    });
    expect(duplicate.attempts).toEqual([]);
    expect(
      duplicate.checkpoint.invocations.filter(
        ({ status }) => status === 'running',
      ),
    ).toHaveLength(4);
  });
  it('releases nested Parallel capacity for retry and reuses the same scope on due', async () => {
    const driver = await createDriver(1);
    const branches = await driver.complete('parallel', {
      branchIds: ['branch-01', 'branch-02'],
    });
    const running = driver.checkpoint.invocations.find(
      ({ nodeId, status }) => nodeId === 'left' && status === 'running',
    );
    if (running === undefined) throw new Error('nested branch is not running');
    const failure = {
      kind: 'attempt_failure' as const,
      occurredAt: '2026-08-24T00:00:01.000Z',
      invocationKey: running.invocationKey,
      attemptId: '00000000-0000-4000-8000-000000000501',
      attemptNumber: running.attemptNumber,
      failureKind: 'retry' as const,
      errorKind: 'network' as const,
      possiblyDispatched: false,
      safeErrorCode: 'nested.retry',
    };
    const retryScheduled = await driver.advance({
      observations: [failure],
      completedOutputs: [],
    });
    expect(
      retryScheduled.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === running.invocationKey,
      ),
    ).toMatchObject({ status: 'waiting', waitKind: 'retry_backoff' });
    expect(retryScheduled.attempts).toHaveLength(1);
    const replacement = retryScheduled.attempts[0];
    if (replacement === undefined) throw new Error('replacement is missing');
    expect(replacement.iterationPath).toEqual(running.iterationPath);
    expect(replacement.invocationKey).not.toBe(running.invocationKey);

    const resumeAt = retryScheduled.checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === running.invocationKey,
    )?.resumeAt;
    if (resumeAt === undefined) throw new Error('retry due time is missing');
    await driver.complete(
      replacement.nodeId,
      {},
      running.iterationPath?.at(-1)?.ordinal,
    );
    const resumed = await driver.advance({
      observations: [
        {
          kind: 'due_at',
          occurredAt: resumeAt,
          invocationKey: running.invocationKey,
        },
      ],
      completedOutputs: [],
    });
    expect(resumed.attempts).toEqual([
      expect.objectContaining({
        invocationKey: running.invocationKey,
        attemptNumber: running.attemptNumber + 1,
        iterationPath: running.iterationPath,
      }),
    ]);
    expect(branches.attempts).toHaveLength(2);
  });
});
