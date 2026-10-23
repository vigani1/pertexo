import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
} from '../../../src/index.js';
import {
  nodeCatalog,
  pairedParallelGraph,
} from '../../support/executable-workflow.js';
describe('branching production operations', () => {
  it('fans out Parallel and supplies its paired Merge settled input', async () => {
    const workflowVersionId = '00000000-0000-4000-8000-000000000003';
    const catalog = composeExecutableCatalog(
      nodeCatalog({ parallel: true, merge: true }),
    );
    const executable = buildWorkflowExecutable({
      graph: pairedParallelGraph(),
      catalog,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const parallelKey = invocationKey({
      workflowVersionId,
      nodeId: 'parallel',
    });
    const attemptId = '00000000-0000-4000-8000-000000000106';
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
    const observations = [
      {
        sequence: 2,
        occurredAt: '2026-08-24T00:00:00.000Z',
        attemptId,
        attemptNumber: 1,
        kind: 'outcome' as const,
        invocationKey: parallelKey,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId },
      },
    ];
    const completedOutput = {
      sequence: 2,
      attemptId,
      invocationKey: parallelKey,
      value: { branchIds: ['branch-02', 'branch-01'] },
    };

    const plan = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs: [completedOutput],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(plan.attempts).toHaveLength(1);
    expect(plan.checkpoint.joins).toEqual([
      expect.objectContaining({
        joinId: 'merge',
        policy: { kind: 'all' },
        ledger: [
          { branchId: 'branch-01', disposition: 'pending' },
          { branchId: 'branch-02', disposition: 'pending' },
        ],
      }),
    ]);
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'left', status: 'running' }),
        expect.objectContaining({ nodeId: 'right', status: 'ready' }),
      ]),
    );
    const left = plan.checkpoint.invocations.find(
      ({ nodeId }) => nodeId === 'left',
    );
    if (left === undefined) throw new Error('left branch invocation missing');
    const leftAttemptId = '00000000-0000-4000-8000-000000000107';
    const afterLeft = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint: plan.checkpoint,
      observations: [
        {
          sequence: plan.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T00:00:02.000Z',
          attemptId: leftAttemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: left.invocationKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: leftAttemptId },
        },
      ],
      occurredAt: '2026-08-24T00:00:03.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(afterLeft.checkpoint.joins[0]?.ledger).toEqual([
      {
        branchId: 'branch-01',
        disposition: 'arrived',
        output: { kind: 'inline', attemptId: leftAttemptId },
      },
      { branchId: 'branch-02', disposition: 'pending' },
    ]);
    expect(afterLeft.attempts.map(({ nodeId }) => nodeId)).toEqual(['right']);
    const right = afterLeft.checkpoint.invocations.find(
      ({ nodeId }) => nodeId === 'right',
    );
    if (right === undefined) throw new Error('right branch invocation missing');
    const rightAttemptId = '00000000-0000-4000-8000-000000000108';
    const settled = await advanceWorkflow({
      runId: 'run-parallel',
      executable,
      workflowVersionId,
      checkpoint: afterLeft.checkpoint,
      observations: [
        {
          sequence: afterLeft.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T00:00:04.000Z',
          attemptId: rightAttemptId,
          attemptNumber: 1,
          kind: 'outcome',
          invocationKey: right.invocationKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId: rightAttemptId },
        },
      ],
      occurredAt: '2026-08-24T00:00:05.000Z',
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    expect(settled.checkpoint.joins[0]).toMatchObject({
      selectedBranchIds: ['branch-01', 'branch-02'],
    });
    expect(settled.attempts.map(({ nodeId }) => nodeId)).toEqual(['merge']);
    const mergeAttempt = settled.attempts[0];
    if (mergeAttempt === undefined) throw new Error('Merge attempt missing');
    const coordinatorInput = {
      ledger: {
        'branch-01': {
          disposition: 'arrived',
          output: { kind: 'inline', attemptId: leftAttemptId },
        },
        'branch-02': {
          disposition: 'arrived',
          output: { kind: 'inline', attemptId: rightAttemptId },
        },
      },
      selectedBranchIds: ['branch-01', 'branch-02'],
    } as const;
    let receivedMergeInput: unknown;
    await expect(
      executeNodeAttempt({
        runId: 'run-parallel',
        nodeRunId: 'node-run-merge',
        attemptId: 'attempt-merge',
        executable,
        workflowVersionId,
        invocationKey: mergeAttempt.invocationKey,
        nodeId: 'merge',
        runInput: {},
        completedNodeOutputs: [],
        coordinatorInput,
        registry: {
          execute: (request) => {
            receivedMergeInput = request.input;
            return Promise.resolve({
              kind: 'succeeded',
              output: coordinatorInput,
            });
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'succeeded', output: coordinatorInput });
    expect(receivedMergeInput).toEqual(coordinatorInput);
    await expect(
      advanceWorkflow({
        runId: 'run-parallel',
        executable,
        workflowVersionId,
        checkpoint,
        observations,
        completedOutputs: [
          { ...completedOutput, value: { branchIds: ['branch-01'] } },
        ],
        occurredAt: '2026-08-24T00:00:01.000Z',
        maximumAdmissions: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-parallel',
        executable,
        workflowVersionId,
        checkpoint,
        observations,
        completedOutputs: [{ ...completedOutput, sequence: 0 }],
        occurredAt: '2026-08-24T00:00:01.000Z',
        maximumAdmissions: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
});
