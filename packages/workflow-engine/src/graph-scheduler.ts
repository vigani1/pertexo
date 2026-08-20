import { invocationKey } from './scheduling.js';
import { compareOrdinal } from './ordering.js';
import type { InvocationState } from './types.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly nodes: readonly {
    readonly id: string;
    readonly disabled?: boolean;
  }[];
  readonly edges: readonly {
    readonly source: { readonly nodeId: string };
    readonly target: { readonly nodeId: string };
  }[];
}

export interface ReadyNodeDecision {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly disposition: 'ready' | 'skipped';
}

export function deriveReadyNodes(input: {
  readonly graph: SchedulerState;
  readonly workflowVersionId: string;
  readonly invocations: readonly InvocationState[];
}): readonly ReadyNodeDecision[] {
  const invocationByNode = new Map<string, InvocationState>();
  for (const invocation of input.invocations) {
    const existing = invocationByNode.get(invocation.nodeId);
    const isRoot =
      invocation.invocationKey ===
      invocationKey({
        workflowVersionId: input.workflowVersionId,
        nodeId: invocation.nodeId,
      });
    if (existing === undefined || isRoot)
      invocationByNode.set(invocation.nodeId, invocation);
  }
  const predecessors = new Map<string, string[]>();
  for (const node of input.graph.nodes) predecessors.set(node.id, []);
  for (const edge of input.graph.edges) {
    predecessors.get(edge.target.nodeId)?.push(edge.source.nodeId);
  }
  return [...input.graph.nodes]
    .sort((left, right) => compareOrdinal(left.id, right.id))
    .filter((node) => {
      if (invocationByNode.has(node.id)) return false;
      return (predecessors.get(node.id) ?? []).every((predecessor) => {
        const state = invocationByNode.get(predecessor)?.status;
        return state === 'succeeded' || state === 'skipped';
      });
    })
    .map((node) => ({
      invocationKey: invocationKey({
        workflowVersionId: input.workflowVersionId,
        nodeId: node.id,
      }),
      nodeId: node.id,
      disposition: node.disabled === true ? 'skipped' : 'ready',
    }));
}
