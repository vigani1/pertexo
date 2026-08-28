import type {
  WorkflowExecutableGraphV2,
  WorkflowExecutableNodeV2,
} from './executable-workflow.js';

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
