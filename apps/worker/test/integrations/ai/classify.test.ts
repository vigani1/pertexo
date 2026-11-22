import { randomUUID } from 'node:crypto';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  buildWorkflowTestExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  executeNodeAttempt,
  invocationKey,
} from '@pertexo/workflow-engine/server';
import { expect, it } from 'vitest';
import { capturePreviewDiagnostics } from '../../../src/previews/completion.js';
import { chat, fakeModel, json, modelConnectionId } from './model.fixture.js';

const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
const categories = [
  { id: 'category-01', label: 'Billing', description: 'A payment or invoice' },
  { id: 'category-02', label: 'Access', description: 'A login or permission' },
];
const ports = ['category-01', 'category-02', 'other'];
const classify = {
  id: 'classify',
  definition: { key: 'ai.classify', version: 1 },
  configVersion: 1,
  position: { x: 0, y: 0 },
  config: { model: 'fake', categories },
  inputMappings: {
    text: { kind: 'literal' as const, value: 'Help with this request' },
  },
  connectionRefs: { model_api_key: modelConnectionId },
};

function graph(routedPorts = ports, setup = categories) {
  return {
    settings: { maxRunDurationMs: 600_000 },
    nodes: [
      { ...classify, config: { ...classify.config, categories: setup } },
      ...routedPorts.map((port) => ({
        id: `route-${port}`,
        definition: { key: 'core.set', version: 1 },
        configVersion: 1,
        position: { x: 0, y: 0 },
        config: {},
        inputMappings: {},
        connectionRefs: {},
      })),
    ],
    edges: routedPorts.map((port) => ({
      id: `route-${port}`,
      source: { nodeId: classify.id, port },
      target: { nodeId: `route-${port}`, port: 'in' },
    })),
  };
}

function attemptContext(
  executable = buildWorkflowExecutable({ graph: graph(), catalog }),
) {
  const workflowVersionId = randomUUID();
  const runId = randomUUID();
  return {
    executable,
    workflowVersionId,
    runId,
    nodeRunId: randomUUID(),
    attemptId: randomUUID(),
    nodeId: classify.id,
    invocationKey: invocationKey({ workflowVersionId, nodeId: classify.id }),
    signal: new AbortController().signal,
    runInput: {},
    completedNodeOutputs: [],
  };
}

async function execute(
  fake: Awaited<ReturnType<typeof fakeModel>>,
  context: ReturnType<typeof attemptContext> &
    Pick<
      Parameters<typeof executeNodeAttempt>[0],
      'branchPath'
    > = attemptContext(),
) {
  const { observeModelUsage, read } = capturePreviewDiagnostics();
  const outcome = await executeNodeAttempt({
    ...context,
    registry: fake.registry,
    runtime: {
      workspaceId: randomUUID(),
      nodeId: context.nodeId,
      attemptId: context.attemptId,
      nodeRunId: context.nodeRunId,
      runId: context.runId,
      invocationKey: context.invocationKey,
      attemptNumber: 1,
      sideEffectClass: 'safe',
      beforeDispatch: () => Promise.resolve(),
      connections: fake.connections(),
      observeModelUsage,
    },
  });
  return { outcome, diagnostics: read() };
}

it.each(ports)(
  'routes a recovered coordinator through only %s',
  async (port) => {
    await using fake = await fakeModel([
      json({
        ...chat(JSON.stringify({ selectedPort: port })),
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    ]);
    const context = attemptContext();
    const { outcome, diagnostics } = await execute(fake, context);
    expect(outcome.output).toEqual({ selectedPort: port });
    expect(diagnostics.modelUsage).toMatchObject({
      model: 'fake',
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(fake.calls).toHaveLength(1);
    const { workflowVersionId, invocationKey: key, attemptId } = context;
    const occurredAt = '2026-11-22T10:00:00.000Z';
    const checkpoint = {
      ...createCheckpoint({ workflowVersionId, iterationBudget: 0 }),
      runStatus: 'running',
      admittedInvocationKeys: [key],
      invocations: [
        {
          invocationKey: key,
          nodeId: classify.id,
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;
    const plan = await advanceWorkflow({
      ...context,
      checkpoint: structuredClone(checkpoint),
      observations: [
        {
          sequence: checkpoint.nextEventSequence,
          occurredAt,
          attemptId,
          attemptNumber: 1,
          invocationKey: key,
          kind: 'outcome',
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [
        {
          sequence: checkpoint.nextEventSequence,
          attemptId,
          invocationKey: key,
          value: outcome.output,
        },
      ],
      occurredAt,
      maximumAdmissions: 3,
    });
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual([
      `route-${port}`,
    ]);
    expect(plan.checkpoint.branchSelections).toMatchObject([
      { selectedOutputPort: port },
    ]);
  },
);

it.each([
  { selectedPort: 'Billing' },
  [['category-01', 'category-02']],
  { selectedPort: 'category-01', extra: true },
])('repairs an invalid answer %j once', async (answer) => {
  await using fake = await fakeModel([
    json(chat(JSON.stringify(answer))),
    json(chat('{"selectedPort":"other"}')),
  ]);
  await expect(execute(fake)).resolves.toMatchObject({
    outcome: { output: { selectedPort: 'other' } },
  });
  expect(fake.calls).toHaveLength(2);
});

it('fails a repair that selects an unconfigured category', async () => {
  await using fake = await fakeModel([
    json(chat('{"selectedPort":"Billing"}')),
    json(chat('{"selectedPort":"category-03"}')),
  ]);
  await expect(execute(fake)).rejects.toMatchObject({
    kind: 'failed',
    safeErrorCode: 'model.output_schema_invalid',
  });
  expect(fake.calls).toHaveLength(2);
});

it('rejects an edge on a deleted category and marks an obsolete pin invalid', () => {
  expect(() =>
    buildWorkflowExecutable({
      graph: graph(ports, categories.slice(1)),
      catalog,
    }),
  ).toThrow(/source port is not configured/u);
  const pin = {
    sampleId: randomUUID(),
    output: { selectedPort: 'category-01' },
  };
  const compile = (workflow: ReturnType<typeof graph>) =>
    buildWorkflowTestExecutable({
      graph: workflow,
      catalog,
      pins: { [classify.id]: pin },
    });
  expect(compile(graph())).toMatchObject({
    invalidPinIds: [],
    dispositions: { classify: 'pinned' },
    usesConnections: false,
  });
  expect(
    compile(graph(['category-02', 'other'], categories.slice(1))).invalidPinIds,
  ).toEqual([classify.id]);
});

it('brings a selected category into its enclosing Parallel merge after recovery', async () => {
  const routed = graph(['category-01']);
  const link = (from: string, port: string, to: string, input: string) => ({
    id: `${from}-${port}-${to}`,
    source: { nodeId: from, port },
    target: { nodeId: to, port: input },
  });
  const executable = buildWorkflowExecutable({
    graph: {
      ...routed,
      nodes: [
        ...routed.nodes,
        {
          ...classify,
          id: 'parallel',
          definition: { key: 'core.parallel', version: 1 },
          config: {
            branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
            maxConcurrency: 2,
          },
          inputMappings: {},
          connectionRefs: {},
        },
        {
          ...classify,
          id: 'merge',
          definition: { key: 'core.merge', version: 1 },
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [
        ...routed.edges,
        link('parallel', 'branch-01', 'classify', 'in'),
        link('parallel', 'branch-02', 'merge', 'branch-02'),
        link('route-category-01', 'out', 'merge', 'branch-01'),
      ],
    },
    catalog,
  });
  const context = attemptContext(executable);
  const { workflowVersionId } = context;
  const occurredAt = '2026-11-22T10:00:00.000Z';
  const advance = {
    ...context,
    occurredAt,
    maximumAdmissions: 3,
  };
  const start = await advanceWorkflow({
    ...advance,
    checkpoint: createCheckpoint({ workflowVersionId, iterationBudget: 0 }),
    observations: [],
  });
  type Plan = typeof start;
  type Output = Awaited<ReturnType<typeof execute>>['outcome']['output'];
  function finish(plan: Plan, nodeId: string, value: Output) {
    const attempt = plan.attempts.find(
      (candidate) => candidate.nodeId === nodeId,
    );
    if (attempt === undefined) throw new Error(`Expected ${nodeId} to run`);
    const { invocationKey: key, attemptNumber } = attempt;
    const attemptId = randomUUID();
    const sequence = plan.checkpoint.nextEventSequence;
    return advanceWorkflow({
      ...advance,
      checkpoint: structuredClone(plan.checkpoint),
      observations: [
        {
          sequence,
          occurredAt,
          invocationKey: key,
          attemptId,
          attemptNumber,
          kind: 'outcome',
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
      completedOutputs: [{ sequence, attemptId, invocationKey: key, value }],
    });
  }
  const branched = await finish(start, 'parallel', {
    branchIds: ['branch-01', 'branch-02'],
  });
  const pending = branched.attempts.find(
    ({ nodeId }) => nodeId === classify.id,
  );
  if (pending === undefined) throw new Error('Expected Classify to run');
  await using fake = await fakeModel([
    json(chat('{"selectedPort":"category-01"}')),
  ]);
  const { outcome } = await execute(fake, {
    ...context,
    invocationKey: pending.invocationKey,
    ...(pending.branchPath === undefined
      ? {}
      : { branchPath: pending.branchPath }),
  });
  const classified = await finish(branched, 'classify', outcome.output);
  expect(classified.attempts).toMatchObject([
    {
      nodeId: 'route-category-01',
      branchPath: [
        { nodeId: 'parallel', outputPort: 'branch-01' },
        { nodeId: 'classify', outputPort: 'category-01' },
      ],
    },
  ]);
  const joined = await finish(classified, 'route-category-01', {
    routed: true,
  });
  expect(joined.attempts.map(({ nodeId }) => nodeId)).toEqual(['merge']);
  expect(joined.checkpoint.joins[0]?.selectedBranchIds).toEqual(['branch-01']);
  expect(fake.calls).toHaveLength(1);
});
