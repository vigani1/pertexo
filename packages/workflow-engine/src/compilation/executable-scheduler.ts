import type { WorkflowExecutableGraphV2 } from '../executable-workflow.js';
import type { SchedulerState } from '../transition/graph-scheduler.js';

export function projectSchedulerState(
  graph: WorkflowExecutableGraphV2,
): SchedulerState {
  const projectGraph = (graph: WorkflowExecutableGraphV2): SchedulerState => {
    const nodes = graph.nodes.map(
      ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }) => ({
        id,
        definition,
        config,
        disabled,
        sideEffectClass: pinnedSideEffectClass,
      }),
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
