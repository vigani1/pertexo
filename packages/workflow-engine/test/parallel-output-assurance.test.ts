import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  invocationKey,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000760';
const attemptId = '00000000-0000-4000-8000-000000000761';
const parallelKey = invocationKey({ workflowVersionId, nodeId: 'parallel' });
const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
const occurredAt = '2026-09-06T00:00:00.000Z';
const completed = {
  sequence: 2,
  attemptId,
  invocationKey: parallelKey,
  value: { branchIds: ['branch-02', 'branch-01'] },
};

function setup() {
  const release = composeExecutableCompatibilityRelease(
    nodeRelease({ parallel: true, merge: true }),
  );
  const executable = buildWorkflowExecutableV2({
    graph: pairedParallelGraph(),
    release,
  });
  return {
    runId: 'parallel-output-proof',
    workflowVersionId,
    executable,
    checkpoint: {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running' as const,
      admittedInvocationKeys: [manualKey, parallelKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded' as const,
          attemptNumber: 1,
        },
        {
          invocationKey: parallelKey,
          nodeId: 'parallel',
          status: 'running' as const,
          attemptNumber: 1,
        },
      ],
    },
    observations: [
      {
        sequence: 2,
        occurredAt,
        attemptId,
        attemptNumber: 1,
        kind: 'outcome' as const,
        invocationKey: parallelKey,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId },
      },
    ],
    completedOutputs: [completed],
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
  };
}

describe('required persisted Parallel output verification', () => {
  it.each([
    ['omitted', undefined],
    ['empty', []],
    [
      'wrong attempt',
      [{ ...completed, attemptId: '00000000-0000-4000-8000-000000000762' }],
    ],
    ['wrong sequence', [{ ...completed, sequence: 3 }]],
    ['wrong invocation', [{ ...completed, invocationKey: manualKey }]],
    [
      'wrong order',
      [{ ...completed, value: { branchIds: ['branch-01', 'branch-02'] } }],
    ],
    [
      'duplicates',
      [{ ...completed, value: { branchIds: ['branch-02', 'branch-02'] } }],
    ],
    ['missing member', [{ ...completed, value: { branchIds: ['branch-02'] } }]],
    [
      'extra field',
      [{ ...completed, value: { ...completed.value, extra: true } }],
    ],
    ['invalid shape', [{ ...completed, value: null }]],
  ])(
    'rejects %s material before admitting any branch',
    async (_label, completedOutputs) => {
      const input = setup();
      await expect(
        advanceWorkflow({ ...input, completedOutputs }),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
      expect(input.checkpoint.invocations).toHaveLength(2);
    },
  );

  it('requires an inline persisted outcome rather than a miswired artifact reference', async () => {
    const input = setup();
    await expect(
      advanceWorkflow({
        ...input,
        observations: input.observations.map((outcome) => ({
          ...outcome,
          output: { kind: 'artifact', artifactId: attemptId },
        })),
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });

  it('accepts matching duplicates and recovers from a verified checkpoint without old output', async () => {
    const input = setup();
    const plan = await advanceWorkflow({
      ...input,
      completedOutputs: [completed, completed],
    });
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['left']);
    const recovered = await advanceWorkflow({
      ...input,
      checkpoint: structuredClone(plan.checkpoint),
      observations: [],
      completedOutputs: [],
    });
    expect(recovered.attempts).toEqual([]);
    expect(recovered.checkpoint.joins).toEqual(plan.checkpoint.joins);
  });
});
