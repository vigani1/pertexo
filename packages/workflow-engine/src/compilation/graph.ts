import type {
  WorkflowExecutableGraph,
  WorkflowExecutableNode,
} from './foundation.js';

export function findExecutableNodeContext(
  graph: WorkflowExecutableGraph,
  nodeId: string,
  ancestors: readonly string[] = [],
):
  | Readonly<{
      node: WorkflowExecutableNode;
      graph: WorkflowExecutableGraph;
      ancestors: readonly string[];
    }>
  | undefined {
  for (const node of graph.nodes) {
    if (node.id === nodeId) return { node, graph, ancestors };
    if (node.structured === undefined) continue;
    const found = findExecutableNodeContext(node.structured.body, nodeId, [
      ...ancestors,
      node.id,
    ]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function executableNodes(
  graph: WorkflowExecutableGraph,
): readonly WorkflowExecutableNode[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined
      ? []
      : executableNodes(node.structured.body)),
  ]);
}

export function executableEdges(
  graph: WorkflowExecutableGraph,
): readonly WorkflowExecutableGraph['edges'][number][] {
  return [
    ...graph.edges,
    ...graph.nodes.flatMap((node) =>
      node.structured === undefined
        ? []
        : executableEdges(node.structured.body),
    ),
  ];
}
