import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  executeNodeAttempt,
  invocationKey,
  nodeRelease,
  conditionGraph,
  switchGraph,
  pairedParallelGraph,
  directPairedParallelGraph,
  graph,
} from './executable-workflow.fixtures.js';

describe('branching production operations', () => {
  it('advances only through the verified V2 graph and rejects malformed observations', async () => {
    const release = composeExecutableCompatibilityRelease(nodeRelease());
    const executable = buildWorkflowExecutableV2({ graph: graph(), release });
    const checkpoint = createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 0,
    });
    const first = await advanceWorkflow({
      runId: 'run-1',
      executable,
      workflowVersionId: 'version-1',
      checkpoint,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: 1,
      observations: [],
      signal: new AbortController().signal,
    });
    expect(first.attempts.map(({ nodeId }) => nodeId)).toEqual(['manual']);
    const foreignCheckpoint = structuredClone(first.checkpoint);
    Object.assign(foreignCheckpoint.invocations[0] ?? {}, { nodeId: 'set' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint: foreignCheckpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    expect(
      await advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).toEqual(first);
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [{ kind: 'loop_started' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable,
        workflowVersionId: 'version-2',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'workflow_identity_invalid' });
    await expect(
      advanceWorkflow({
        runId: 'run-1',
        executable: {
          envelope: executable.envelope,
          checksum: executable.checksum,
        },
        workflowVersionId: 'version-1',
        checkpoint,
        occurredAt: '2026-08-20T10:00:00.000Z',
        maximumAdmissions: 1,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'executable_invalid' });
  });

  it('accepts canonical branch-scoped checkpoint V2 identity', async () => {
    const workflowVersionId = 'version-condition';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );
    const executable = buildWorkflowExecutableV2({
      graph: conditionGraph('true'),
      release,
    });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const terminateKey = invocationKey({
      workflowVersionId,
      nodeId: 'terminate',
      branchPath: ['condition:true'],
    });
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      revision: 1,
      runStatus: 'running',
      readySet: [terminateKey],
      admittedInvocationKeys: [conditionKey],
      invocations: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'succeeded',
          attemptNumber: 1,
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000101',
          },
        },
        {
          invocationKey: terminateKey,
          nodeId: 'terminate',
          status: 'ready',
          attemptNumber: 0,
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
      ],
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    } as const;

    await expect(
      advanceWorkflow({
        runId: 'run-condition',
        executable,
        workflowVersionId,
        checkpoint,
        occurredAt: '2026-08-24T00:00:00.000Z',
        maximumAdmissions: 0,
        observations: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ checkpoint: { schemaVersion: 2 } });
  });

  it('derives a Condition selection only from its persisted inline output', async () => {
    const workflowVersionId = 'version-condition';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ condition: true }),
    );
    const condition = conditionGraph('true');
    const executable = buildWorkflowExecutableV2({
      graph: {
        ...condition,
        nodes: [
          ...condition.nodes,
          { ...condition.nodes[2], id: 'false-terminate' },
        ],
        edges: [
          ...condition.edges,
          {
            id: 'condition-false-terminate',
            source: { nodeId: 'condition', port: 'false' },
            target: { nodeId: 'false-terminate', port: 'in' },
          },
        ],
      },
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const conditionKey = invocationKey({
      workflowVersionId,
      nodeId: 'condition',
    });
    const attemptId = '00000000-0000-4000-8000-000000000102';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [conditionKey, manualKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-condition',
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
          invocationKey: conditionKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: conditionKey,
          value: { selectedPort: 'true' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: conditionKey,
          nodeId: 'condition',
          selectedOutputPort: 'true',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'false-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });

  it('derives a Switch selection only from its persisted inline output', async () => {
    const workflowVersionId = 'version-switch';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ switch: true }),
    );
    const selected = switchGraph('case-02');
    const executable = buildWorkflowExecutableV2({
      graph: {
        ...selected,
        nodes: [
          ...selected.nodes,
          { ...selected.nodes[2], id: 'case-01-terminate' },
          { ...selected.nodes[2], id: 'default-terminate' },
        ],
        edges: [
          ...selected.edges,
          {
            id: 'switch-case-01-terminate',
            source: { nodeId: 'switch', port: 'case-01' },
            target: { nodeId: 'case-01-terminate', port: 'in' },
          },
          {
            id: 'switch-default-terminate',
            source: { nodeId: 'switch', port: 'default' },
            target: { nodeId: 'default-terminate', port: 'in' },
          },
        ],
      },
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const switchKey = invocationKey({ workflowVersionId, nodeId: 'switch' });
    const attemptId = '00000000-0000-4000-8000-000000000103';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId,
        iterationBudget: 0,
      }),
      runStatus: 'running',
      admittedInvocationKeys: [manualKey, switchKey],
      invocations: [
        {
          invocationKey: manualKey,
          nodeId: 'manual',
          status: 'succeeded',
          attemptNumber: 1,
        },
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;

    const plan = await advanceWorkflow({
      runId: 'run-switch',
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
          invocationKey: switchKey,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: 2,
          attemptId,
          invocationKey: switchKey,
          value: { selectedPort: 'case-02' },
        },
      ],
      occurredAt: '2026-08-24T00:00:01.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(plan.checkpoint).toMatchObject({
      schemaVersion: 2,
      branchSelections: [
        {
          invocationKey: switchKey,
          nodeId: 'switch',
          selectedOutputPort: 'case-02',
        },
      ],
    });
    expect(plan.checkpoint.invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'terminate', status: 'running' }),
        expect.objectContaining({
          nodeId: 'case-01-terminate',
          status: 'skipped',
        }),
        expect.objectContaining({
          nodeId: 'default-terminate',
          status: 'skipped',
        }),
      ]),
    );
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
  });

  it('fans out Parallel only from its exact persisted declaration output', async () => {
    const workflowVersionId = 'version-parallel';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ parallel: true, merge: true }),
    );
    const executable = buildWorkflowExecutableV2({
      graph: pairedParallelGraph(),
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const parallelKey = invocationKey({
      workflowVersionId,
      nodeId: 'parallel',
    });
    const attemptId = '00000000-0000-4000-8000-000000000106';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
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
        completedNodeOutputs: {},
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
  });

  it('settles direct Parallel-to-Merge branches as explicitly missing', async () => {
    const workflowVersionId = 'version-direct-parallel';
    const release = composeExecutableCompatibilityRelease(
      nodeRelease({ parallel: true, merge: true }),
    );
    const executable = buildWorkflowExecutableV2({
      graph: directPairedParallelGraph(),
      release,
    });
    const manualKey = invocationKey({ workflowVersionId, nodeId: 'manual' });
    const parallelKey = invocationKey({
      workflowVersionId,
      nodeId: 'parallel',
    });
    const attemptId = '00000000-0000-4000-8000-000000000109';
    const checkpoint = {
      ...createCheckpointV2({
        engineVersion: 'engine-v2',
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
