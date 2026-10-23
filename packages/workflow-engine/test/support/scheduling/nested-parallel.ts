import { expect } from 'vitest';
import type {
  ForEachStructure,
  JsonValue,
  StructuredBody,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type AdvanceWorkflowInput,
  type WorkflowCheckpoint,
} from '../../../src/index.js';
import {
  forEachGraph,
  nodeCatalog,
  pairedParallelGraph,
} from '../executable-workflow.js';
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
function executableWithNestedParallel(maxConcurrency: number, branchCount = 2) {
  const outer = forEachGraph();
  const parallel = parallelGraphWithBranches(branchCount);
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
  return buildWorkflowExecutable({
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
    catalog: composeExecutableCatalog(
      nodeCatalog({
        forEach: true,
        parallel: true,
        merge: true,
      }),
    ),
  });
}
function parallelGraphWithBranches(branchCount: number) {
  const graph = structuredClone(pairedParallelGraph()) as MutableWorkflowGraph;
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
export function rootParallelWithDescendantLoop(maxConcurrency: number) {
  const graph = structuredClone(pairedParallelGraph()) as MutableWorkflowGraph;
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
export function parallelInsideNestedLoops(maxConcurrency: number) {
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
  const parallel = parallelGraphWithBranches(2);
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
export async function createDriver(maxConcurrency: number, branchCount = 2) {
  const base = {
    runId: 'nested-parallel',
    workflowVersionId: '00000000-0000-4000-8000-000000000101',
    executable: executableWithNestedParallel(maxConcurrency, branchCount),
    maximumAdmissions: 16,
    occurredAt: '2026-08-24T00:00:00.000Z',
    signal: new AbortController().signal,
  };
  let checkpoint: WorkflowCheckpoint = createCheckpoint({
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
