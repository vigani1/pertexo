import type {
  NodeDefinitionCatalogItem,
  WorkflowGraphContract,
} from '@pertexo/contracts';
import {
  inspectWorkflowFailureRoutes,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import { stepTitle } from '../graph/adapter';

type Selection = Readonly<{
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}>;
export function failureLink(graph: WorkflowGraphContract, nodeId: string) {
  return graph.edges.find(
    (edge) =>
      edge.source.nodeId === nodeId &&
      edge.source.port === WORKFLOW_FAILURE_PORT,
  );
}
export function failureTargetOptions(
  graph: WorkflowGraphContract,
  sourceId: string,
  definitions: readonly NodeDefinitionCatalogItem[],
) {
  if (failureLink(graph, sourceId) !== undefined) return [];
  return graph.nodes.flatMap((node) => {
    if (node.id === sourceId) return [];
    const definition = definitions.find(
      (d) =>
        d.definition.key === node.definition.key &&
        d.definition.version === node.definition.version,
    );
    const port = definition?.ports.inputs[0];
    if (port === undefined) return [];
    const edge = {
      id: crypto.randomUUID(),
      source: { nodeId: sourceId, port: WORKFLOW_FAILURE_PORT },
      target: { nodeId: node.id, port },
    };
    const inspected = inspectWorkflowFailureRoutes({
      ...graph,
      edges: [...graph.edges, edge],
    });
    return inspected.kind === 'routed'
      ? [{ nodeId: node.id, port, label: stepTitle(node) }]
      : [];
  });
}

/** Keep an owned handler from accidentally becoming an ordinary starting path. */
export function failureRemoval(
  graph: WorkflowGraphContract,
  selection: Selection,
):
  | Readonly<{ kind: 'ordinary'; selection: Selection }>
  | Readonly<{ kind: 'blocked'; reason: string }>
  | Readonly<{
      kind: 'handler';
      selection: Selection;
      labels: readonly string[];
    }> {
  const wantedNodes = new Set(selection.nodeIds),
    wantedEdges = new Set(selection.edgeIds);
  const inspected = inspectWorkflowFailureRoutes(graph);
  const sources = new Set(
    graph.edges
      .filter(
        (edge) =>
          edge.source.port === WORKFLOW_FAILURE_PORT &&
          (wantedEdges.has(edge.id) || wantedNodes.has(edge.source.nodeId)),
      )
      .map((edge) => edge.source.nodeId),
  );
  if (inspected.kind === 'routed') {
    for (const id of selection.nodeIds) {
      const owner = inspected.value.handlerOwners.get(id);
      if (
        owner !== undefined &&
        (inspected.value.routes.get(owner)?.entryNodeId === id ||
          graph.edges.some((edge) => edge.source.nodeId === id))
      )
        sources.add(owner);
    }
    for (const edge of graph.edges)
      if (wantedEdges.has(edge.id)) {
        const owner = inspected.value.handlerOwners.get(edge.source.nodeId);
        if (owner !== undefined) sources.add(owner);
      }
  }
  if (sources.size === 0) return { kind: 'ordinary', selection };
  if (inspected.kind !== 'routed')
    return {
      kind: 'blocked',
      reason:
        inspected.kind === 'invalid'
          ? inspected.message
          : 'This failure path has no valid handler. Fix its issues before removing it.',
    };
  const handlerIds = new Set<string>();
  for (const sourceId of sources)
    for (const id of inspected.value.routes.get(sourceId)?.handlerNodeIds ?? [])
      handlerIds.add(id);
  for (const id of handlerIds) wantedNodes.add(id);
  return {
    kind: 'handler',
    selection: { nodeIds: [...wantedNodes], edgeIds: selection.edgeIds },
    labels: graph.nodes
      .filter((node) => handlerIds.has(node.id))
      .map(stepTitle),
  };
}
