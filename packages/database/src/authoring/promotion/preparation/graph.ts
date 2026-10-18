import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import { PROMOTION_LIMITS } from '@pertexo/contracts';
import { WorkflowPromotionError } from '../contract.js';

export function promotionDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function* promotionNodes(graph: WorkflowGraph): Generator<WorkflowNode> {
  for (const node of graph.nodes) {
    yield node;
    if (node.structured !== undefined)
      yield* promotionNodes(node.structured.body);
  }
}
export function mapPromotionNodes(
  graph: WorkflowGraph,
  transform: (node: WorkflowNode) => WorkflowNode,
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
                ...mapPromotionNodes(node.structured.body, transform),
              },
            },
          };
    }),
  };
}
/** The same review budget covers selected graphs and retained target dependencies. */
export class PromotionGraphBudget {
  private bytes = 0;
  add(graph: WorkflowGraph): void {
    this.bytes += Buffer.byteLength(JSON.stringify(graph));
    if (this.bytes > PROMOTION_LIMITS.graphBytes)
      throw new WorkflowPromotionError(
        'limit',
        'These workflows and their dependencies exceed the 2 MB promotion review budget. Select fewer workflows.',
      );
  }
}
