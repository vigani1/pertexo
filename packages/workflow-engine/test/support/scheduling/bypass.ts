import { expect } from 'vitest';
import type { WorkflowCheckpoint } from '../../../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
  parseCheckpoint,
  verifyWorkflowExecutable,
} from '../../../src/index.js';
import { nodeCatalog, pairedParallelGraph } from '../executable-workflow.js';

import { workflowVersionId, occurredAt } from './skipped-parallel.js';

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

export async function runBypass(kind: 'condition' | 'switch') {
  const catalog = composeExecutableCatalog(
    nodeCatalog({
      condition: kind === 'condition',
      switch: kind === 'switch',
      parallel: true,
      merge: true,
    }),
  );
  const built = buildWorkflowExecutable({
    graph: conditionParallelGraph(kind),
    catalog,
  });
  let executable = verifyWorkflowExecutable({
    envelope: JSON.parse(JSON.stringify(built.envelope)),
    checksum: built.checksum,
    catalog: catalog,
  });
  let checkpoint: WorkflowCheckpoint = createCheckpoint({
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
  executable = verifyWorkflowExecutable({
    envelope: JSON.parse(JSON.stringify(executable.envelope)),
    checksum: executable.checksum,
    catalog: catalog,
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
    completedNodeOutputs: [],
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

  const reconstructedExecutable = verifyWorkflowExecutable({
    envelope: JSON.parse(JSON.stringify(executable.envelope)),
    checksum: executable.checksum,
    catalog: catalog,
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
