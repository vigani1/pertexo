import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from '@pertexo/workflow-model/graph';
import { isCoreMergeDefinition } from './core-definition-identities.js';

export type GraphValidationIndex = Readonly<{
  nodesById: ReadonlyMap<string, WorkflowNode>;
  incomingByNode: ReadonlyMap<string, readonly WorkflowEdge[]>;
  incomingByNodePort: ReadonlyMap<string, readonly WorkflowEdge[]>;
  outgoingByNodePort: ReadonlyMap<string, readonly WorkflowEdge[]>;
  mergesByParallelNode: ReadonlyMap<string, readonly WorkflowNode[]>;
  adjacency: ReadonlyMap<string, readonly string[]>;
}>;

export function nodePortKey(nodeId: string, port: string): string {
  return `${nodeId}\u0000${port}`;
}

function appendIndexValue<T>(
  map: Map<string, T[]>,
  key: string,
  value: T,
): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}

export function graphValidationIndex(
  graph: WorkflowGraph,
): GraphValidationIndex {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incomingByNode = new Map<string, WorkflowEdge[]>();
  const incomingByNodePort = new Map<string, WorkflowEdge[]>();
  const outgoingByNodePort = new Map<string, WorkflowEdge[]>();
  const mergesByParallelNode = new Map<string, WorkflowNode[]>();
  const adjacency = new Map<string, string[]>(
    graph.nodes.map(({ id }) => [id, []]),
  );
  for (const edge of graph.edges) {
    appendIndexValue(incomingByNode, edge.target.nodeId, edge);
    appendIndexValue(
      incomingByNodePort,
      nodePortKey(edge.target.nodeId, edge.target.port),
      edge,
    );
    appendIndexValue(
      outgoingByNodePort,
      nodePortKey(edge.source.nodeId, edge.source.port),
      edge,
    );
    adjacency.get(edge.source.nodeId)?.push(edge.target.nodeId);
  }
  for (const node of graph.nodes) {
    if (!isCoreMergeDefinition(node.definition)) continue;
    const parallelNodeId = Reflect.get(node.config, 'parallelNodeId');
    if (typeof parallelNodeId === 'string')
      appendIndexValue(mergesByParallelNode, parallelNodeId, node);
  }
  return {
    nodesById,
    incomingByNode,
    incomingByNodePort,
    outgoingByNodePort,
    mergesByParallelNode,
    adjacency,
  };
}
