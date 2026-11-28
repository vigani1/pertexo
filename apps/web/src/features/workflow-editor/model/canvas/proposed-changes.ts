import type { WorkflowFlowProjection } from '../graph/adapter';

/** Mark proposal additions while keeping them out of the canvas commands. */
export function showProposedChanges(
  draft: WorkflowFlowProjection,
  proposal: WorkflowFlowProjection,
): WorkflowFlowProjection {
  const existingNodes = new Set(draft.nodes.map(({ id }) => id));
  const existingLinks = new Set(draft.edges.map(linkEndpoints));
  return {
    nodes: proposal.nodes.map((node) =>
      existingNodes.has(node.id)
        ? node
        : {
            ...node,
            draggable: false,
            selectable: false,
            connectable: false,
            focusable: false,
            data: { ...node.data, proposed: true },
          },
    ),
    edges: proposal.edges.map((edge) =>
      existingLinks.has(linkEndpoints(edge))
        ? edge
        : {
            ...edge,
            selectable: false,
            focusable: false,
            ...(edge.data === undefined
              ? {}
              : { data: { ...edge.data, proposed: true } }),
          },
    ),
  };
}

function linkEndpoints(edge: WorkflowFlowProjection['edges'][number]): string {
  return JSON.stringify([
    edge.source,
    edge.sourceHandle,
    edge.target,
    edge.targetHandle,
  ]);
}
