import {
  parseWorkflowGraphDraft,
  validateWorkflowGraph,
} from '@pertexo/workflow-model';

import { WorkflowEngineError } from '../../src/errors.js';
import type { SchedulerState } from '../../src/transition/scheduling/readiness.js';

export type SchedulerGraph = SchedulerState;

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
      deriveReadiness: true,
      nodes: graph.nodes.map(({ id, definition, disabled }) =>
        disabled === undefined
          ? { id, definition, sideEffectClass: 'safe' }
          : { id, definition, disabled, sideEffectClass: 'safe' },
      ),
      edges: graph.edges.map(({ source, target }) => ({
        source: { nodeId: source.nodeId, port: source.port },
        target: { nodeId: target.nodeId, port: target.port },
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
