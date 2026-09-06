import { describe, expect, it } from 'vitest';

import type {
  BranchScopePart,
  InvocationState,
  IterationScopePart,
  WorkflowCheckpoint,
} from '../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  executeNodeAttempt,
  invocationKey,
  nodeRelease,
  pairedParallelGraph,
  verifyWorkflowExecutableV2,
} from './executable-workflow.fixtures.js';
import { deriveReadyNodes } from '../src/testing.js';
import { parseCheckpoint } from '../src/index.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000601';
const occurredAt = '2026-09-06T00:00:00.000Z';

function pairedSchedulerGraph(extraPredecessor = false) {
  return {
    deriveReadiness: true as const,
    nodes: [
      {
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        config: {
          branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
          maxConcurrency: 1,
        },
        sideEffectClass: 'safe' as const,
      },
      { id: 'left', sideEffectClass: 'safe' as const },
      { id: 'right', sideEffectClass: 'safe' as const },
      ...(extraPredecessor
        ? [{ id: 'guard', sideEffectClass: 'safe' as const }]
        : []),
      {
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        config: {
          parallelNodeId: 'parallel',
          policy: { kind: 'all' as const },
        },
        sideEffectClass: 'safe' as const,
      },
      { id: 'after', sideEffectClass: 'safe' as const },
    ],
    edges: [
      {
        source: { nodeId: 'parallel', port: 'branch-01' },
        target: { nodeId: 'left', port: 'in' },
      },
      {
        source: { nodeId: 'parallel', port: 'branch-02' },
        target: { nodeId: 'right', port: 'in' },
      },
      {
        source: { nodeId: 'left', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-01' },
      },
      {
        source: { nodeId: 'right', port: 'out' },
        target: { nodeId: 'merge', port: 'branch-02' },
      },
      ...(extraPredecessor
        ? [
            {
              source: { nodeId: 'guard', port: 'out' },
              target: { nodeId: 'merge', port: 'in' },
            },
          ]
        : []),
      {
        source: { nodeId: 'merge', port: 'out' },
        target: { nodeId: 'after', port: 'in' },
      },
    ],
  } as const;
}

function scopedInvocation(
  workflowId: string,
  nodeId: string,
  status: InvocationState['status'],
  input: Readonly<{
    readonly branchPath?: readonly BranchScopePart[];
    readonly iterationPath?: readonly IterationScopePart[];
  }> = {},
): InvocationState {
  return {
    invocationKey: invocationKey({
      workflowVersionId: workflowId,
      nodeId,
      ...(input.branchPath === undefined
        ? {}
        : {
            branchPath: input.branchPath.map(
              ({ nodeId: branchNodeId, outputPort }) =>
                `${branchNodeId}:${outputPort}`,
            ),
          }),
      ...(input.iterationPath === undefined
        ? {}
        : { iterationPath: input.iterationPath }),
    }),
    nodeId,
    status,
    attemptNumber: status === 'succeeded' ? 1 : 0,
    ...(input.branchPath === undefined ? {} : { branchPath: input.branchPath }),
    ...(input.iterationPath === undefined
      ? {}
      : { iterationPath: input.iterationPath }),
    ...(status === 'succeeded'
      ? {
          output: {
            kind: 'inline' as const,
            attemptId: '00000000-0000-4000-8000-000000000601',
          },
        }
      : {}),
  };
}

describe('skipped Parallel/Merge scheduling', () => {
  it('emits one scoped skipped paired Merge after a skipped Parallel', () => {
    const branchPath = [{ nodeId: 'condition', outputPort: 'false' }] as const;
    const graph = pairedSchedulerGraph(true);
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'skipped', {
        branchPath,
      }),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-01' },
        ],
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-02' },
        ],
      }),
      scopedInvocation(workflowVersionId, 'guard', 'succeeded', {
        branchPath,
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
        branchPath,
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'after',
          branchPath: ['condition:false'],
        }),
        nodeId: 'after',
        disposition: 'skipped',
        branchPath,
      },
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'merge',
          branchPath: ['condition:false'],
        }),
        nodeId: 'merge',
        disposition: 'skipped',
        branchPath,
      },
    ]);
  });

  it('keeps a successful paired Parallel as a Merge barrier without a join', () => {
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'succeeded'),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-01' }],
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [{ nodeId: 'parallel', outputPort: 'branch-02' }],
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
      }).some((decision) => decision.nodeId === 'merge'),
    ).toBe(false);
  });

  it('keeps skipped Merge scope isolated across nested iteration paths', () => {
    const branchPath = [{ nodeId: 'switch', outputPort: 'default' }] as const;
    const iterationPath = [{ loopNodeId: 'loop', ordinal: 2 }] as const;
    const parallelPath = [
      ...branchPath,
      { nodeId: 'parallel', outputPort: 'branch-01' },
    ] as const;
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'parallel', 'skipped', {
        branchPath,
        iterationPath,
      }),
      scopedInvocation(workflowVersionId, 'left', 'skipped', {
        branchPath: parallelPath,
        iterationPath,
      }),
      scopedInvocation(workflowVersionId, 'right', 'skipped', {
        branchPath: [
          ...branchPath,
          { nodeId: 'parallel', outputPort: 'branch-02' },
        ],
        iterationPath,
      }),
    ];

    expect(
      deriveReadyNodes({
        graph,
        workflowVersionId,
        invocations,
        branchPath,
        iterationPath,
      }),
    ).toEqual([
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'after',
          branchPath: ['switch:default'],
          iterationPath,
        }),
        nodeId: 'after',
        disposition: 'skipped',
        branchPath,
        iterationPath,
      },
      {
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'merge',
          branchPath: ['switch:default'],
          iterationPath,
        }),
        nodeId: 'merge',
        disposition: 'skipped',
        branchPath,
        iterationPath,
      },
    ]);
  });

  it('does not infer a skipped or ready Merge from generic all-skipped predecessors', () => {
    const graph = pairedSchedulerGraph();
    const invocations = [
      scopedInvocation(workflowVersionId, 'left', 'skipped'),
      scopedInvocation(workflowVersionId, 'right', 'skipped'),
    ];

    expect(
      deriveReadyNodes({ graph, workflowVersionId, invocations }),
    ).not.toContainEqual(expect.objectContaining({ nodeId: 'merge' }));
  });
});

function conditionParallelGraph(kind: 'condition' | 'switch') {
  const base = pairedParallelGraph();
  const manual = base.nodes.find(({ id }) => id === 'manual');
  const parallel = base.nodes.find(({ id }) => id === 'parallel');
  const bypassTemplate = base.nodes.find(({ id }) => id === 'terminate');
  if (
    manual === undefined ||
    parallel === undefined ||
    bypassTemplate === undefined
  )
    throw new Error('paired graph fixture is incomplete');
  const control = {
    ...parallel,
    id: kind,
    definition: { key: `core.${kind}`, version: 1 } as const,
    config:
      kind === 'switch'
        ? { cases: [{ id: 'case-01', equals: 'selected' }] }
        : {},
    inputMappings: {},
  };
  const bypass = { ...bypassTemplate, id: 'bypass', inputMappings: {} };
  return {
    ...base,
    nodes: [
      manual,
      control,
      ...base.nodes.filter(({ id }) => id !== 'manual'),
      bypass,
    ],
    edges: [
      {
        id: `manual-${kind}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: kind, port: 'in' },
      },
      {
        id: `${kind}-parallel`,
        source: {
          nodeId: kind,
          port: kind === 'switch' ? 'case-01' : 'true',
        },
        target: { nodeId: 'parallel', port: 'in' },
      },
      {
        id: `${kind}-bypass`,
        source: {
          nodeId: kind,
          port: kind === 'switch' ? 'default' : 'false',
        },
        target: { nodeId: 'bypass', port: 'in' },
      },
      ...base.edges.filter(({ id }) => id !== 'manual-parallel'),
    ],
  } as const;
}

async function runBypass(kind: 'condition' | 'switch') {
  const release = composeExecutableCompatibilityRelease(
    nodeRelease({
      condition: kind === 'condition',
      switch: kind === 'switch',
      parallel: true,
      merge: true,
    }),
  );
  const built = buildWorkflowExecutableV2({
    graph: conditionParallelGraph(kind),
    release,
  });
  let executable = verifyWorkflowExecutableV2({
    envelope: JSON.parse(JSON.stringify(built.envelope)),
    checksum: built.checksum,
    admissionRelease: release,
  });
  let checkpoint: WorkflowCheckpoint = createCheckpointV2({
    engineVersion: 'engine-v2',
    workflowVersionId,
    iterationBudget: 0,
  });
  let nextAttempt = 700;
  const advance = async (
    observations: Parameters<typeof advanceWorkflow>[0]['observations'] = [],
    completedOutputs: Parameters<
      typeof advanceWorkflow
    >[0]['completedOutputs'] = [],
  ) => {
    const plan = await advanceWorkflow({
      runId: `skip-${kind}`,
      executable,
      workflowVersionId,
      checkpoint,
      observations,
      completedOutputs,
      occurredAt,
      maximumAdmissions: 10,
      signal: new AbortController().signal,
    });
    checkpoint = plan.checkpoint;
    return plan;
  };
  const complete = async (
    nodeId: string,
    value: unknown,
    attemptIdOverride?: string,
  ) => {
    const running = checkpoint.invocations.find(
      (invocation) =>
        invocation.nodeId === nodeId && invocation.status === 'running',
    );
    if (running === undefined) throw new Error(`${nodeId} is not running`);
    const attemptId =
      attemptIdOverride ??
      `00000000-0000-4000-8000-${String(nextAttempt++).padStart(12, '0')}`;
    const sequence = checkpoint.nextEventSequence;
    const output = {
      sequence,
      attemptId,
      invocationKey: running.invocationKey,
      value,
    };
    const observations = [
      {
        kind: 'outcome' as const,
        sequence,
        occurredAt,
        invocationKey: running.invocationKey,
        attemptId,
        attemptNumber: running.attemptNumber,
        status: 'succeeded' as const,
        output: { kind: 'inline' as const, attemptId },
      },
    ];
    return {
      plan: await advance(observations, [output]),
      observations,
      completedOutputs: [output],
    };
  };

  const initial = await advance();
  expect(initial.attempts.map(({ nodeId }) => nodeId)).toEqual(['manual']);
  await complete('manual', {});
  const controlCompletion = await complete(
    kind,
    kind === 'condition'
      ? { selectedPort: 'false' }
      : { selectedPort: 'default' },
  );
  const control = controlCompletion.plan;
  const duplicate = await advance(
    controlCompletion.observations,
    controlCompletion.completedOutputs,
  );
  expect(duplicate.attempts).toEqual([]);
  expect(
    duplicate.events.map(({ name, nodeId }) => ({ name, nodeId })),
  ).toEqual([
    { name: 'node.skipped', nodeId: 'merge' },
    { name: 'node.skipped', nodeId: 'terminate' },
  ]);
  const skippedRegionPath = [
    {
      nodeId: kind,
      outputPort: kind === 'condition' ? 'true' : 'case-01',
    },
  ];
  expect(
    duplicate.nodeRunAdmissions.map(({ nodeId, branchPath }) => ({
      branchPath,
      nodeId,
    })),
  ).toEqual([
    { branchPath: skippedRegionPath, nodeId: 'merge' },
    { branchPath: skippedRegionPath, nodeId: 'terminate' },
  ]);
  const controlInvocationKeys = new Set(
    control.checkpoint.invocations.map(({ invocationKey }) => invocationKey),
  );
  const unchangedInvocations = duplicate.checkpoint.invocations.filter(
    ({ invocationKey }) => controlInvocationKeys.has(invocationKey),
  );
  expect(unchangedInvocations).toEqual(control.checkpoint.invocations);
  const newlySkippedInvocations = duplicate.checkpoint.invocations.filter(
    ({ invocationKey }) => !controlInvocationKeys.has(invocationKey),
  );
  expect(newlySkippedInvocations).toHaveLength(2);
  expect(newlySkippedInvocations).toEqual(
    expect.arrayContaining([
      {
        attemptNumber: 0,
        branchPath: skippedRegionPath,
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'merge',
          branchPath: skippedRegionPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
        }),
        iterationPath: [],
        nodeId: 'merge',
        status: 'skipped',
      },
      {
        attemptNumber: 0,
        branchPath: skippedRegionPath,
        invocationKey: invocationKey({
          workflowVersionId,
          nodeId: 'terminate',
          branchPath: skippedRegionPath.map(
            ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
          ),
        }),
        iterationPath: [],
        nodeId: 'terminate',
        status: 'skipped',
      },
    ]),
  );
  expect(duplicate.checkpoint.joins).toEqual(control.checkpoint.joins);
  expect(control.checkpoint.joins).toEqual([]);
  expect(control.checkpoint.invocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: 'parallel', status: 'skipped' }),
    ]),
  );
  // Rebuild while work is still running, not just after terminal completion.
  executable = verifyWorkflowExecutableV2({
    envelope: JSON.parse(JSON.stringify(executable.envelope)),
    checksum: executable.checksum,
    admissionRelease: release,
  });
  checkpoint = parseCheckpoint(
    JSON.parse(JSON.stringify(duplicate.checkpoint)),
  );
  const recovered = await advance();
  expect(recovered.events).toEqual([]);
  expect(recovered.attempts).toEqual([]);
  expect(recovered.nodeRunAdmissions).toEqual([]);
  expect(recovered.checkpoint.invocations).toEqual(
    duplicate.checkpoint.invocations,
  );
  expect(recovered.checkpoint.joins).toEqual([]);
  const bypassInvocation = duplicate.checkpoint.invocations.find(
    (invocation) =>
      invocation.nodeId === 'bypass' && invocation.status === 'running',
  );
  if (bypassInvocation === undefined)
    throw new Error('bypass invocation was not admitted');
  const bypassAttemptId = '00000000-0000-4000-8000-000000000701';
  const executedBypass = await executeNodeAttempt({
    runId: `skip-${kind}`,
    nodeRunId: '00000000-0000-4000-8000-000000000702',
    attemptId: bypassAttemptId,
    executable,
    workflowVersionId,
    invocationKey: bypassInvocation.invocationKey,
    nodeId: 'bypass',
    ...(bypassInvocation.branchPath === undefined
      ? {}
      : { branchPath: bypassInvocation.branchPath }),
    ...(bypassInvocation.iterationPath === undefined ||
    bypassInvocation.iterationPath.length === 0
      ? {}
      : { iterationPath: bypassInvocation.iterationPath }),
    runInput: {},
    completedNodeOutputs: {},
    registry: {
      execute: () =>
        Promise.resolve({ kind: 'succeeded' as const, output: {} }),
    },
    signal: new AbortController().signal,
  });
  expect(executedBypass).toMatchObject({
    attemptId: bypassAttemptId,
    kind: 'succeeded',
    nodeId: 'bypass',
  });
  const bypass = (
    await complete('bypass', executedBypass.output, executedBypass.attemptId)
  ).plan;
  expect(bypass.attempts).toEqual([]);
  expect(bypass.checkpoint.joins).toEqual([]);
  expect(bypass.checkpoint.invocations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ nodeId: 'left', status: 'skipped' }),
      expect.objectContaining({ nodeId: 'right', status: 'skipped' }),
      expect.objectContaining({ nodeId: 'merge', status: 'skipped' }),
    ]),
  );
  expect(bypass.checkpoint.runStatus).toBe('succeeded');
  expect(bypass.checkpoint.invocations).toContainEqual(
    expect.objectContaining({ nodeId: 'bypass', status: 'succeeded' }),
  );
  expect(bypass.checkpoint.invocations).toContainEqual(
    expect.objectContaining({ nodeId: 'terminate', status: 'skipped' }),
  );

  const reconstructedExecutable = verifyWorkflowExecutableV2({
    envelope: JSON.parse(JSON.stringify(executable.envelope)),
    checksum: executable.checksum,
    admissionRelease: release,
  });
  const reconstructedCheckpoint = parseCheckpoint(
    JSON.parse(JSON.stringify(bypass.checkpoint)),
  );
  const resumed = await advanceWorkflow({
    runId: `skip-${kind}`,
    executable: reconstructedExecutable,
    workflowVersionId,
    checkpoint: reconstructedCheckpoint,
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
  });
  expect(resumed.attempts).toEqual([]);
  expect(resumed.events).toEqual([]);
  expect(resumed.nodeRunAdmissions).toEqual([]);
  expect(resumed.checkpoint.runStatus).toBe('succeeded');
  expect(resumed.checkpoint.invocations).toContainEqual(
    expect.objectContaining({ nodeId: 'terminate', status: 'skipped' }),
  );
  return { executable, resumed };
}

describe('skipped Parallel/Merge public execution', () => {
  it.each(['condition', 'switch'] as const)(
    'bypasses a skipped %s Parallel/Merge region without creating a join',
    async (kind) => {
      const { resumed } = await runBypass(kind);
      expect(resumed.checkpoint.joins).toEqual([]);
      expect(resumed.checkpoint.invocations).not.toContainEqual(
        expect.objectContaining({ nodeId: 'merge', status: 'running' }),
      );
    },
  );
});
