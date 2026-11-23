import type { WorkflowGraph } from './workflow-graph.schemas.js';

/**
 * Enumerate every node with the same stack order previously used by the two
 * identity projections. The graph remains authoritative; callers retain their
 * own deduplication, validation and ordering policies.
 */
export function* workflowNodes(graph: WorkflowGraph) {
  const pending: WorkflowGraph[] = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      yield node;
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
}

export function mapWorkflowNodes(
  graph: WorkflowGraph,
  transform: (
    node: WorkflowGraph['nodes'][number],
  ) => WorkflowGraph['nodes'][number],
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((original) => {
      const node = transform(original);
      return node.structured === undefined
        ? node
        : {
            ...node,
            structured: {
              ...node.structured,
              body: {
                ...node.structured.body,
                ...mapWorkflowNodes(node.structured.body, transform),
              },
            },
          };
    }),
  };
}
