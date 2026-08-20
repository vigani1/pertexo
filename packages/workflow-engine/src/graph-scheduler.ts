import {
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '@pertexo/workflow-model/graph';

import { invocationKey } from './scheduling.js';
import { WorkflowEngineError } from './errors.js';
import type { InvocationState } from './types.js';

export interface SchedulerGraph {
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

export function parseSchedulerGraph(value: unknown): SchedulerGraph {
  try {
    const graph = parseWorkflowGraphDraft(value);
    const validation = validateWorkflowGraph(graph);
    if (!validation.ok)
      throw new WorkflowEngineError(
        'graph_invalid',
        validation.issues.map(({ code }) => code).join(','),
      );
    return {
      nodes: graph.nodes.map(({ id, disabled }) =>
        disabled === undefined ? { id } : { id, disabled },
      ),
      edges: graph.edges.map(({ source, target }) => ({
        source: { nodeId: source.nodeId },
        target: { nodeId: target.nodeId },
      })),
    };
  } catch (error) {
    if (error instanceof WorkflowEngineError) throw error;
    throw new WorkflowEngineError(
      'graph_invalid',
      error instanceof Error ? error.message : 'graph parsing failed',
    );
  }
}

export function deriveReadyNodes(input: {
  readonly graph: SchedulerGraph;
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
    .sort((left, right) => left.id.localeCompare(right.id))
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
