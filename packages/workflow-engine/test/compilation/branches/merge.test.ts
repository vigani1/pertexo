import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  directPairedParallelGraph,
} from '../../support/executable-workflow.js';
describe('branching production operations', () => {
  it('settles direct Parallel-to-Merge branches as explicitly missing', async () => {
    const workflowVersionId = '00000000-0000-4000-8000-000000000008';
    const catalog = composeExecutableCatalog(
      nodeCatalog({ parallel: true, merge: true }),
    );
    const executable = buildWorkflowExecutable({
      graph: directPairedParallelGraph(),
      catalog,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const parallelKey = invocationKey({
      workflowVersionId,
      nodeId: 'parallel',
    });
    const attemptId = '00000000-0000-4000-8000-000000000109';
    const checkpoint = {
      ...createCheckpoint({
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey, parallelKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: parallelKey,
          nodeId: 'parallel',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-direct-parallel',
      executable,
      workflowVersionId,
      checkpoint,
      observations: [
        {
          sequence: 2,
          occurredAt: '2026-08-24T00:00:00.000Z',
          attemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: parallelKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: parallelKey,
          value: { branchIds: ['branch-02', 'branch-01'] },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint.joins[0]?.ledger).toEqual([
      { branchId: 'branch-01', disposition: 'missing' },
      { branchId: 'branch-02', disposition: 'missing' },
    ]);
    expect(plan.checkpoint.joins[0]?.selectedBranchIds).toEqual([]);
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['merge']);
  });
});
