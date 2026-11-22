import type { ControlNodeConfig } from '@pertexo/workflow-model';
import type { WorkflowExecutableGraph } from '../../compilation/workflow-executable.js';
import type { SchedulerState } from './policy.js';

export function projectSchedulerState(
  graph: WorkflowExecutableGraph,
  controls: ReadonlyMap<string, ControlNodeConfig>,
  readOnlyNodeIds: ReadonlySet<string> = new Set(),
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraph): SchedulerState => {
    const nodes = graph.nodes.map(
      ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }) => {
        const control = controls.get(id);
        return {
          id,
          definition,
          config,
          ...(control === undefined ? {} : { control }),
          disabled,
          sideEffectClass: pinnedSideEffectClass,
          ...(readOnlyNodeIds.has(id) ? { readOnlyAttempts: true } : {}),
        };
      },
    );
    const edges = graph.edges.map(({ source, target }) => ({
      source: { nodeId: source.nodeId, port: source.port },
      target: { nodeId: target.nodeId, port: target.port },
    }));
    const structuredBodies = graph.nodes.flatMap((node) => {
      if (node.structured === undefined) return [];
      const body = projectGraph(node.structured.body);
      return [
        { loopNodeId: node.id, nodes: body.nodes, edges: body.edges },
        ...(body.structuredBodies ?? []),
      ];
    });
    return { deriveReadiness: true, nodes, edges, structuredBodies };
  };
  return projectGraph(graph);
}
