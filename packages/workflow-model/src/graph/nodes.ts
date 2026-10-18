import type { WorkflowGraph } from './contract.js';

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
