import type {
  WorkflowExecutableGraphV2,
  WorkflowExecutableNodeV2,
} from './executable-workflow.js';

export function findExecutableNodeContext(
  graph: WorkflowExecutableGraphV2,
  nodeId: string,
  ancestors: readonly string[] = [],
):
  | Readonly<{
      node: WorkflowExecutableNodeV2;
      graph: WorkflowExecutableGraphV2;
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
  graph: WorkflowExecutableGraphV2,
): readonly WorkflowExecutableNodeV2[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.structured === undefined
      ? []
      : executableNodes(node.structured.body)),
  ]);
}

export function executableEdges(
  graph: WorkflowExecutableGraphV2,
): readonly WorkflowExecutableGraphV2['edges'][number][] {
  return [
    ...graph.edges,
    ...graph.nodes.flatMap((node) =>
      node.structured === undefined
        ? []
        : executableEdges(node.structured.body),
    ),
  ];
}
