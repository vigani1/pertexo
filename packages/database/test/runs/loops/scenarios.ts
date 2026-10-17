import { randomUUID } from 'node:crypto';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import {
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';

export const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
const id = (name: string) => name.padEnd(64, '-');
const node = (name: string, key = 'core.set'): WorkflowNode => ({
  id: id(name),
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});
const edge = (source: WorkflowNode, target: WorkflowNode) => ({
  id: `${source.id.slice(0, 16)}-${target.id.slice(0, 16)}`,
  source: { nodeId: source.id, port: 'out' },
  target: { nodeId: target.id, port: 'in' },
});
export function collectionItems(size: number): string[] {
  return Array.from({ length: size }, () =>
    'x'.repeat(Math.floor((256 * 1_024 - 128) / size) - 3),
  );
}
function loop(
  name: string,
  iterations: number,
  concurrency: number,
  body: WorkflowNode,
): WorkflowNode {
  return {
    ...node(name, 'core.foreach'),
    inputMappings: {
      items: { kind: 'literal', value: collectionItems(iterations) },
    },
    structured: {
      kind: 'for_each',
      maxIterations: iterations,
      maxConcurrency: concurrency,
      body: {
        settings: {},
        nodes: [body],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}
function graph(owner: WorkflowNode): WorkflowGraph {
  const trigger = node('manual', 'core.manual');
  return {
    settings: {},
    nodes: [trigger, owner],
    edges: [edge(trigger, owner)],
  };
}
export const childGraph: WorkflowGraph = {
  settings: {},
  nodes: [node('child', 'core.manual')],
  edges: [],
  callable: {
    input: { type: 'object', properties: [] },
    resultType: { type: 'object', properties: [] },
    result: { kind: 'run_input', path: '$' },
  },
};
export const childPin = {
  workflowId: randomUUID(),
  workflowVersionId: randomUUID(),
  executableChecksum: buildWorkflowExecutable({ graph: childGraph, catalog })
    .checksum,
};
export interface LoopScenario {
  readonly name: string;
  readonly graph: WorkflowGraph;
  readonly collections: Readonly<Record<string, number>>;
  readonly calls?: number;
  readonly parallelNodeId?: string;
  readonly mergeNodeId?: string;
  readonly holdFirst?: boolean;
}
function parallelBranchScenario(): LoopScenario {
  const parallel = {
    ...node('parallel', 'core.parallel'),
    id: 'parallel'.padEnd(63, '-'),
    config: {
      branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
      maxConcurrency: 2,
    },
  };
  const left = node('left');
  const right = node('right');
  const merge = {
    ...node('merge', 'core.merge'),
    config: { parallelNodeId: parallel.id, policy: { kind: 'all' } },
  };
  const size = Math.floor(
    (WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations - 4) / 4,
  );
  const owner = loop('loop', size, 49, parallel);
  if (owner.structured === undefined)
    throw new Error('Loop fixture missing body');
  const bodyEdges = [
    {
      ...edge(parallel, left),
      source: { nodeId: parallel.id, port: 'branch-01' },
    },
    {
      ...edge(parallel, right),
      source: { nodeId: parallel.id, port: 'branch-02' },
    },
    { ...edge(left, merge), target: { nodeId: merge.id, port: 'branch-01' } },
    { ...edge(right, merge), target: { nodeId: merge.id, port: 'branch-02' } },
  ];
  const manual = node('manual', 'core.manual');
  const first = node('first');
  const second = node('second');
  return {
    name: 'parallel-branches',
    parallelNodeId: parallel.id,
    mergeNodeId: merge.id,
    graph: {
      settings: {},
      nodes: [
        manual,
        first,
        second,
        {
          ...owner,
          structured: {
            ...owner.structured,
            body: {
              ...owner.structured.body,
              nodes: [parallel, left, right, merge],
              edges: bodyEdges,
            },
          },
        },
      ],
      edges: [edge(manual, first), edge(first, second), edge(second, owner)],
    },
    collections: { [id('loop')]: size },
  };
}
export function loopScenarios(): readonly LoopScenario[] {
  const items = WORKFLOW_GRAPH_LIMITS.maxLoopIterations;
  const calls = Math.floor(
    (WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations - 2) / 2,
  );
  const inner = Math.floor(
    (WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations - 4) / 2,
  );
  return [
    parallelBranchScenario(),
    {
      name: 'serial',
      graph: graph(loop('loop', items, 1, node('body'))),
      collections: { [id('loop')]: items },
    },
    {
      name: 'parallel',
      graph: graph(loop('loop', items, 198, node('body'))),
      collections: { [id('loop')]: items },
    },
    {
      name: 'out-of-order',
      graph: graph(loop('loop', items, 2, node('body'))),
      collections: { [id('loop')]: items },
      holdFirst: true,
    },
    {
      name: 'nested-serial',
      graph: graph(loop('outer', 2, 1, loop('inner', inner, 1, node('body')))),
      collections: { [id('outer')]: 2, [id('inner')]: inner },
    },
    {
      name: 'nested-parallel',
      graph: graph(loop('outer', 2, 2, loop('inner', inner, 98, node('body')))),
      collections: { [id('outer')]: 2, [id('inner')]: inner },
    },
    ...[
      { name: 'call-serial', concurrency: 1 },
      { name: 'call', concurrency: 198 },
    ].map(({ name, concurrency }): LoopScenario => ({
      name,
      graph: graph(
        loop('loop', calls, concurrency, {
          ...node('call', 'core.call'),
          config: { target: childPin },
          inputMappings: { input: { kind: 'literal', value: {} } },
        }),
      ),
      collections: { [id('loop')]: calls },
      calls,
    })),
  ];
}
export function unsafeNestedGraph(): WorkflowGraph {
  return graph(loop('outer', 2, 2, loop('inner', 2_498, 200, node('body'))));
}
