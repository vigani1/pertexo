import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type {
  ForEachStructure,
  StructuredBody,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model/graph';

import { parseCheckpoint } from '../src/index.js';
import type { AdvanceWorkflowInput, WorkflowCheckpoint } from '../src/index.js';
import {
  advanceWorkflow,
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpointV2,
  forEachGraph,
  nodeRelease,
  pairedParallelGraph,
} from './executable-workflow.fixtures.js';

type MutableStructuredBody = Omit<StructuredBody, 'nodes' | 'edges'> & {
  nodes: MutableWorkflowNode[];
  edges: WorkflowEdge[];
};
type MutableForEachStructure = Omit<ForEachStructure, 'body'> & {
  body: MutableStructuredBody;
};
type MutableWorkflowNode = Omit<WorkflowNode, 'structured'> & {
  structured?: MutableForEachStructure;
};
type MutableWorkflowGraph = Omit<WorkflowGraph, 'nodes' | 'edges'> & {
  nodes: MutableWorkflowNode[];
  edges: WorkflowEdge[];
};

function executableWithNestedParallel(
  maxConcurrency: number,
  version: 1 | 2 | 3,
  branchCount = 2,
) {
  const outer = forEachGraph();
  const parallel = parallelGraphWithBranches(version, branchCount);
  const bodyNodes = parallel.nodes
    .filter(({ id }) => id !== 'manual' && id !== 'terminate')
    .map((node) => ({
      ...node,
      inputMappings: {},
      ...(node.id === 'parallel'
        ? {
            config: {
              branches: Array.from({ length: branchCount }, (_, index) => ({
                id: `branch-${String(index + 1).padStart(2, '0')}`,
              })),
              maxConcurrency,
            },
          }
        : {}),
    }));
  const bodyIds = new Set(bodyNodes.map(({ id }) => id));
  return buildWorkflowExecutableV2({
    graph: {
      ...outer,
      nodes: outer.nodes.map((node) =>
        'structured' in node
          ? {
              ...node,
              structured: {
                ...node.structured,
                maxConcurrency: 2,
                body: {
                  ...node.structured.body,
                  nodes: bodyNodes,
                  edges: parallel.edges.filter(
                    ({ source, target }) =>
                      bodyIds.has(source.nodeId) && bodyIds.has(target.nodeId),
                  ),
                },
              },
            }
          : node,
      ),
    },
    release: composeExecutableCompatibilityRelease(
      nodeRelease({
        forEach: true,
        parallel: true,
        merge: true,
        structuredVersion: version,
      }),
    ),
  });
}

function parallelGraphWithBranches(version: 1 | 2 | 3, branchCount: number) {
  const graph = structuredClone(
    pairedParallelGraph(version),
  ) as MutableWorkflowGraph;
  const parallel = graph.nodes.find(({ id }) => id === 'parallel');
  const branchTemplate = graph.nodes.find(({ id }) => id === 'left');
  const merge = graph.nodes.find(({ id }) => id === 'merge');
  if (
    parallel === undefined ||
    branchTemplate === undefined ||
    merge === undefined
  )
    throw new Error('Parallel fixture is incomplete');
  const branches = Array.from(
    { length: branchCount },
    (_, index) => `branch-${String(index + 1).padStart(2, '0')}`,
  );
  Object.assign(parallel, {
    config: { branches: branches.map((id) => ({ id })), maxConcurrency: 1 },
  });
  for (const branchId of branches.slice(2)) {
    graph.nodes.push({ ...branchTemplate, id: branchId });
    graph.edges.push(
      {
        id: `parallel-${branchId}`,
        source: { nodeId: 'parallel', port: branchId },
        target: { nodeId: branchId, port: 'in' },
      },
      {
        id: `${branchId}-merge`,
        source: { nodeId: branchId, port: 'out' },
        target: { nodeId: 'merge', port: branchId },
      },
    );
  }
  Object.assign(merge, {
    config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
  });
  return graph;
}

function rootParallelWithDescendantLoop(
  maxConcurrency: number,
  version: 1 | 2 | 3,
) {
  const graph = structuredClone(
    pairedParallelGraph(version),
  ) as MutableWorkflowGraph;
  const loopGraph = structuredClone(forEachGraph()) as MutableWorkflowGraph;
  const loop = loopGraph.nodes.find(({ id }) => id === 'loop');
  const parallel = graph.nodes.find(({ id }) => id === 'parallel');
  const right = graph.nodes.find(({ id }) => id === 'right');
  if (
    loop?.structured === undefined ||
    parallel === undefined ||
    right === undefined
  )
    throw new Error('For Each fixture is incomplete');
  Object.assign(loop.structured, { maxConcurrency: 2 });
  Object.assign(right, { disabled: true });
  Object.assign(parallel, {
    config: {
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency,
    },
  });
  const nodes = graph.nodes.map((node) =>
    node.id === 'left' ? { ...loop, id: 'loop' } : node,
  );
  const edges = graph.edges.map((edge) => {
    if (edge.target.nodeId === 'left')
      return { ...edge, target: { ...edge.target, nodeId: 'loop' } };
    if (edge.source.nodeId === 'left')
      return { ...edge, source: { ...edge.source, nodeId: 'loop' } };
    return edge;
  });
  return { ...graph, nodes, edges };
}

function parallelInsideNestedLoops(maxConcurrency: number, version: 1 | 2 | 3) {
  const graph = structuredClone(
    nestedForEachGraphForAdmission(),
  ) as MutableWorkflowGraph;
  const outer = graph.nodes.find(({ id }) => id === 'loop');
  if (outer?.structured === undefined)
    throw new Error('outer For Each fixture is incomplete');
  const inner = outer.structured.body.nodes.find(
    ({ id }) => id === 'body-first',
  );
  if (inner?.structured === undefined)
    throw new Error('inner For Each fixture is incomplete');
  const parallel = parallelGraphWithBranches(version, 2);
  const parallelNodes = parallel.nodes.filter(
    ({ id }) => id !== 'manual' && id !== 'terminate',
  );
  const parallelIds = new Set(parallelNodes.map(({ id }) => id));
  const parallelEdges = parallel.edges.filter(
    ({ source, target }) =>
      parallelIds.has(source.nodeId) && parallelIds.has(target.nodeId),
  );
  Object.assign(inner.structured.body, {
    nodes: parallelNodes,
    edges: parallelEdges,
  });
  const parallelNode = inner.structured.body.nodes.find(
    ({ id }) => id === 'parallel',
  );
  if (parallelNode === undefined) throw new Error('nested Parallel missing');
  Object.assign(parallelNode, {
    config: {
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency,
    },
  });
  Object.assign(outer.structured, { maxConcurrency: 2 });
  Object.assign(inner.structured, { maxConcurrency: 2 });
  return graph;
}

function nestedForEachGraphForAdmission() {
  const base = forEachGraph();
  const outer = structuredClone(base.nodes.find(({ id }) => id === 'loop')) as
    MutableWorkflowNode | undefined;
  if (outer?.structured === undefined)
    throw new Error('outer For Each fixture is incomplete');
  const inner = structuredClone(base.nodes.find(({ id }) => id === 'loop')) as
    MutableWorkflowNode | undefined;
  if (inner?.structured === undefined)
    throw new Error('inner For Each fixture is incomplete');
  Object.assign(inner, { id: 'body-first' });
  Object.assign(outer.structured.body, {
    nodes: [inner, outer.structured.body.nodes[1]],
    edges: [
      {
        id: 'body-first-sink',
        source: { nodeId: 'body-first', port: 'out' },
        target: { nodeId: 'body-sink', port: 'in' },
      },
    ],
  });
  return {
    ...base,
    nodes: base.nodes.map((node) => (node.id === 'loop' ? outer : node)),
  };
}

async function createDriver(
  maxConcurrency: number,
  version: 1 | 2 | 3,
  branchCount = 2,
) {
  const base = {
    runId: 'nested-parallel',
    workflowVersionId: '00000000-0000-4000-8000-000000000101',
    executable: executableWithNestedParallel(
      maxConcurrency,
      version,
      branchCount,
    ),
    maximumAdmissions: 16,
    occurredAt: '2026-08-24T00:00:00.000Z',
    signal: new AbortController().signal,
  };
  let checkpoint: WorkflowCheckpoint = createCheckpointV2({
    engineVersion: 'engine-v2',
    workflowVersionId: base.workflowVersionId,
    iterationBudget: 2,
  });
  const advance = async (
    facts: Pick<AdvanceWorkflowInput, 'observations' | 'completedOutputs'> = {
      observations: [],
    },
  ) => {
    const plan = await advanceWorkflow({ ...base, checkpoint, ...facts });
    checkpoint = plan.checkpoint;
    return plan;
  };
  const complete = async (
    nodeId: string,
    value: JsonValue,
    ordinal?: number,
  ) => {
    const running = checkpoint.invocations.filter(
      (invocation) =>
        invocation.nodeId === nodeId &&
        invocation.status === 'running' &&
        (ordinal === undefined ||
          invocation.iterationPath?.at(-1)?.ordinal === ordinal),
    );
    expect(running.length, `running ${nodeId}`).toBeGreaterThan(0);
    const completedOutputs = running.map((invocation, index) => ({
      sequence: checkpoint.nextEventSequence + index,
      attemptId: `00000000-0000-4000-8000-${String(checkpoint.nextEventSequence + index).padStart(12, '0')}`,
      invocationKey: invocation.invocationKey,
      value,
    }));
    return advance({
      observations: completedOutputs.map((output, index) => ({
        kind: 'outcome',
        sequence: output.sequence,
        occurredAt: base.occurredAt,
        invocationKey: output.invocationKey,
        attemptId: output.attemptId,
        attemptNumber: running[index]?.attemptNumber ?? 1,
        status: 'succeeded',
        output: { kind: 'inline', attemptId: output.attemptId },
      })),
      completedOutputs,
    });
  };
  await advance();
  await complete('manual', {});
  await complete('loop', { items: [1, 2], iterationCount: 2 });
  return {
    advance,
    complete,
    get checkpoint(): WorkflowCheckpoint {
      return checkpoint;
    },
  };
}

describe('nested Parallel admission through the public engine', () => {
  it.each([1, 2, 3] as const)(
    'enforces a limit of one independently in both loop iterations for version %s',
    async (version) => {
      const driver = await createDriver(1, version);
      const branches = await driver.complete('parallel', {
        branchIds: ['branch-01', 'branch-02'],
      });
      expect(
        branches.attempts.map(({ nodeId, iterationPath }) => [
          nodeId,
          iterationPath?.at(-1)?.ordinal,
        ]),
      ).toEqual([
        ['left', 0],
        ['left', 1],
      ]);
      expect((await driver.advance()).attempts).toEqual([]);
      const next = await driver.complete('left', {}, 0);
      expect(
        next.attempts.map(({ nodeId, iterationPath }) => [
          nodeId,
          iterationPath?.at(-1)?.ordinal,
        ]),
      ).toEqual([['right', 0]]);
      expect((await driver.advance()).attempts).toEqual([]);
    },
  );

  it.each([
    { branchCount: 3, maxConcurrency: 1 },
    { branchCount: 3, maxConcurrency: 2 },
    { branchCount: 3, maxConcurrency: 3 },
  ])(
    'enforces configured limit $maxConcurrency independently for every loop iteration',
    async ({ branchCount, maxConcurrency }) => {
      const driver = await createDriver(maxConcurrency, 1, branchCount);
      const branches = await driver.complete('parallel', {
        branchIds: Array.from(
          { length: branchCount },
          (_, index) => `branch-${String(index + 1).padStart(2, '0')}`,
        ),
      });
      expect(branches.attempts).toHaveLength(maxConcurrency * 2);
      for (const ordinal of [0, 1]) {
        const admitted = branches.attempts.filter(
          ({ iterationPath }) => iterationPath?.at(-1)?.ordinal === ordinal,
        );
        expect(admitted).toHaveLength(maxConcurrency);
        expect(new Set(admitted.map(({ nodeId }) => nodeId)).size).toBe(
          maxConcurrency,
        );
      }
    },
  );

  it.each([1, 2] as const)(
    'keeps a root Parallel cap global across descendant loop iterations ($maxConcurrency)',
    async (maxConcurrency) => {
      const graph = rootParallelWithDescendantLoop(maxConcurrency, 1);
      const executable = buildWorkflowExecutableV2({
        graph,
        release: composeExecutableCompatibilityRelease(
          nodeRelease({
            forEach: true,
            parallel: true,
            merge: true,
            structuredVersion: 1,
          }),
        ),
      });
      const base = {
        runId: `root-parallel-${String(maxConcurrency)}`,
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000102',
        occurredAt: '2026-08-24T00:00:00.000Z',
        maximumAdmissions: 16,
        signal: new AbortController().signal,
      } as const;
      let checkpoint: WorkflowCheckpoint = createCheckpointV2({
        engineVersion: 'engine-v2',
        workflowVersionId: base.workflowVersionId,
        iterationBudget: 2,
      });
      const advance = (
        observations: Parameters<typeof advanceWorkflow>[0]['observations'],
        completedOutputs?: Parameters<
          typeof advanceWorkflow
        >[0]['completedOutputs'],
      ) =>
        advanceWorkflow({
          ...base,
          checkpoint,
          observations,
          completedOutputs,
        });
      const initial = await advance([]);
      checkpoint = initial.checkpoint;
      const manual = initial.attempts[0];
      if (manual === undefined) throw new Error('manual attempt missing');
      const afterManual = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: manual.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000301',
            attemptNumber: manual.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000301',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000301',
            invocationKey: manual.invocationKey,
            value: {},
          },
        ],
      );
      checkpoint = afterManual.checkpoint;
      const parallel = afterManual.attempts[0];
      if (parallel === undefined) throw new Error('Parallel attempt missing');
      const afterParallel = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: parallel.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000302',
            attemptNumber: parallel.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000302',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000302',
            invocationKey: parallel.invocationKey,
            value: { branchIds: ['branch-01', 'branch-02'] },
          },
        ],
      );
      checkpoint = afterParallel.checkpoint;
      expect(afterParallel.attempts).toHaveLength(1);
      expect(afterParallel.attempts[0]?.nodeId).toBe('loop');
      const loop = afterParallel.attempts[0];
      if (loop === undefined) throw new Error('loop attempt missing');
      const declared = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: loop.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000303',
            attemptNumber: loop.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000303',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000303',
            invocationKey: loop.invocationKey,
            value: { items: [1, 2], iterationCount: 2 },
          },
        ],
      );
      expect(declared.attempts).toHaveLength(maxConcurrency);
      expect(
        new Set(
          declared.attempts.map(
            ({ iterationPath }) => iterationPath?.at(-1)?.ordinal,
          ),
        ).size,
      ).toBe(maxConcurrency);
    },
  );

  it('keys a nested Parallel cap by the complete enclosing loop path', async () => {
    const executable = buildWorkflowExecutableV2({
      graph: parallelInsideNestedLoops(1, 1),
      release: composeExecutableCompatibilityRelease(
        nodeRelease({ forEach: true, parallel: true, merge: true }),
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
    let checkpoint: WorkflowCheckpoint = createCheckpointV2({
      engineVersion: 'engine-v2',
      workflowVersionId: base.workflowVersionId,
      iterationBudget: 6,
    });
    let nextAttemptId = 400;
    let lastCompletion:
      | Readonly<{
          observations: NonNullable<
            Parameters<typeof advanceWorkflow>[0]['observations']
          >;
          completedOutputs: NonNullable<
            Parameters<typeof advanceWorkflow>[0]['completedOutputs']
          >;
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
    const driver = await createDriver(1, 1);
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
